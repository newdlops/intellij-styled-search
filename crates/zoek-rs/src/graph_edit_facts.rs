//! Import impact lookups and file-local binding evidence for live edits.
//! The immutable import index narrows dependency discovery; the overlay
//! replaces every superseded file before a lookup is used.
use super::*;
use crate::graph_overlay::{BindingFacts, GraphOverlay};

pub(super) const PREFIX: &str = "callgraph-import-impact-v1";
pub(super) const GENERATION_FILE: &str = "callgraph-import-impact-v1-generation.bin";

fn shard_index_for_key_hash(key: u64) -> usize {
    key as usize % GRAPH_SHARD_COUNT
}

fn import_key(name: &str, module: &str) -> u64 {
    stable_hash(&format!("n:{name}\0{module}"))
}

fn dependent_key(module: &str) -> u64 {
    stable_hash(&format!("m:{module}"))
}

fn global_key(name: &str) -> u64 {
    stable_hash(&format!("g:{name}"))
}

fn keys_for_fact(fact: &ImportFact) -> HashSet<u64> {
    let mut keys = HashSet::new();
    if fact.module_candidates.is_empty() {
        keys.insert(import_key(&fact.imported_name, ""));
    }
    for module in &fact.module_candidates {
        keys.insert(import_key(&fact.imported_name, module));
        keys.insert(dependent_key(module));
    }
    if let Some(name) = fact.local_name.strip_prefix(JS_GLOBAL_BINDING_PREFIX) {
        keys.insert(global_key(name));
    }
    keys
}

pub(super) fn write(
    workspace: &Path,
    config: &EngineConfig,
    imports: &[ImportFact],
    table: &FileTable,
) -> io::Result<u64> {
    match fs::remove_file(config.index_root(workspace).join(GENERATION_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    use rayon::prelude::*;
    let chunk_size = imports.len().div_ceil(4).max(1);
    let chunks: Vec<Vec<Vec<u8>>> = imports
        .par_chunks(chunk_size)
        .map(|facts| -> io::Result<_> {
            let mut buffers: Vec<Vec<u8>> = (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
            let mut record = Vec::new();
            for fact in facts {
                record.clear();
                let id = table
                    .get_id(&fact.rel_path)
                    .ok_or_else(|| invalid_data("import index file missing"))?;
                serialize_import_fact_binary(fact, id, &mut record);
                for key in keys_for_fact(fact) {
                    let buffer = &mut buffers[shard_index_for_key_hash(key)];
                    buffer.extend_from_slice(&key.to_le_bytes());
                    buffer.extend_from_slice(&(record.len() as u32).to_le_bytes());
                    buffer.extend_from_slice(&record);
                }
            }
            Ok(buffers)
        })
        .collect::<io::Result<_>>()?;
    let mut shards = open_graph_shard_writers(workspace, config, PREFIX)?;
    shards
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard, writer)| -> io::Result<()> {
            for chunk in &chunks {
                writer.writer.write_all(&chunk[shard])?;
            }
            Ok(())
        })?;
    finish_graph_shard_writers(shards)
}

pub(super) fn available(workspace: &Path, config: &EngineConfig) -> bool {
    let generation = fs::read(config.index_root(workspace).join(GENERATION_FILE));
    let current = read_built_at_unix_ms(&graph_manifest_path(workspace, config))
        .and_then(|built_at| usage_counts::base_generation(workspace, config, built_at));
    if !matches!((generation, current), (Ok(bytes), Ok(current))
        if bytes.as_slice() == current.to_le_bytes())
    {
        return false;
    }
    (0..GRAPH_SHARD_COUNT).all(|shard| graph_shard_path(workspace, config, PREFIX, shard).exists())
}

pub(super) struct Reader<'a> {
    workspace: &'a Path,
    config: &'a EngineConfig,
    table: &'a FileTable,
    overlay: &'a GraphOverlay,
    changed: &'a HashSet<String>,
    fresh_imports: &'a [ImportFact],
    import_shards: CountShardCache,
    file_shards: CountShardCache,
}

impl<'a> Reader<'a> {
    pub(super) fn new(
        workspace: &'a Path,
        config: &'a EngineConfig,
        table: &'a FileTable,
        overlay: &'a GraphOverlay,
        changed: &'a HashSet<String>,
        fresh_imports: &'a [ImportFact],
    ) -> Self {
        Self {
            workspace,
            config,
            table,
            overlay,
            changed,
            fresh_imports,
            import_shards: CountShardCache::new(16 * 1024 * 1024),
            file_shards: CountShardCache::new(16 * 1024 * 1024),
        }
    }

    fn lookup(&mut self, keys: &HashSet<u64>) -> io::Result<Vec<ImportFact>> {
        let mut facts = Vec::new();
        let shards: HashSet<_> = keys
            .iter()
            .map(|key| shard_index_for_key_hash(*key))
            .collect();
        let mut seen = HashSet::new();
        let mut append = |fact: ImportFact| {
            let signature = (
                fact.rel_path.clone(),
                fact.local_name.clone(),
                fact.imported_name.clone(),
                fact.module_candidates.clone(),
            );
            if seen.insert(signature) {
                facts.push(fact);
            }
        };
        for shard in shards {
            let bytes = self
                .import_shards
                .read(&graph_shard_path(
                    self.workspace,
                    self.config,
                    PREFIX,
                    shard,
                ))?
                .ok_or_else(|| invalid_data("missing import impact shard"))?;
            let mut cursor = 0;
            while cursor < bytes.len() {
                let key = read_u64_le(&bytes, &mut cursor)?;
                let len = read_u32_le(&bytes, &mut cursor)? as usize;
                let end = cursor
                    .checked_add(len)
                    .filter(|end| *end <= bytes.len())
                    .ok_or_else(|| invalid_data("truncated import impact row"))?;
                if keys.contains(&key) {
                    let fact = parse_import_fact_binary(&bytes[..end], &mut cursor, self.table)?;
                    if cursor != end {
                        return Err(invalid_data("invalid import impact row length"));
                    }
                    if !self.overlay.entries.contains_key(&fact.rel_path)
                        && !self.changed.contains(&fact.rel_path)
                    {
                        append(fact);
                    }
                }
                cursor = end;
            }
        }
        for fact in self
            .overlay
            .binding_facts
            .iter()
            .filter(|(path, _)| !self.changed.contains(*path))
            .flat_map(|(_, facts)| &facts.imports)
            .chain(self.fresh_imports)
        {
            if keys_for_fact(fact).iter().any(|key| keys.contains(key)) {
                append(fact.clone());
            }
        }
        Ok(facts)
    }

    pub(super) fn direct_importers(
        &mut self,
        names: &HashSet<String>,
    ) -> io::Result<HashSet<String>> {
        if names.is_empty() {
            return Ok(HashSet::new());
        }
        let mut keys = HashSet::new();
        for name in names.iter().map(String::as_str).chain(std::iter::once("*")) {
            keys.insert(import_key(name, ""));
            for module in self.changed {
                keys.insert(import_key(name, module));
            }
        }
        Ok(self
            .lookup(&keys)?
            .into_iter()
            .map(|fact| fact.rel_path)
            .collect())
    }

    pub(super) fn extend_dependents(
        &mut self,
        seeds: &HashSet<String>,
        affected: &mut HashSet<String>,
    ) -> io::Result<()> {
        let mut pending = seeds.clone();
        let mut visited = HashSet::new();
        while !pending.is_empty() {
            let keys = pending
                .drain()
                .filter(|path| visited.insert(path.clone()))
                .map(|path| dependent_key(&path))
                .collect();
            for fact in self.lookup(&keys)? {
                affected.insert(fact.rel_path.clone());
                if !visited.contains(&fact.rel_path) {
                    pending.insert(fact.rel_path);
                }
            }
        }
        Ok(())
    }

    pub(super) fn resolution_facts(
        &mut self,
        affected: &HashSet<String>,
        sites: &[RefSite],
        fresh: &BindingFacts,
    ) -> io::Result<BindingFacts> {
        let keys = sites.iter().map(|site| global_key(&site.name)).collect();
        let mut pending = affected.clone();
        pending.extend(self.lookup(&keys)?.into_iter().map(|fact| fact.rel_path));
        let mut visited = self.changed.clone();
        let mut facts = fresh.clone();
        for fact in &facts.imports {
            pending.extend(fact.module_candidates.iter().cloned());
        }
        while !pending.is_empty() {
            let batch: HashSet<_> = pending
                .drain()
                .filter(|path| visited.insert(path.clone()))
                .collect();
            let loaded = read_paths_cached(
                self.workspace,
                self.config,
                self.table,
                self.overlay,
                &batch,
                &mut self.file_shards,
            )?;
            for fact in &loaded.imports {
                for module in &fact.module_candidates {
                    if !visited.contains(module) {
                        pending.insert(module.clone());
                    }
                }
            }
            facts.imports.extend(loaded.imports);
            facts.types.extend(loaded.types);
            facts.returns.extend(loaded.returns);
        }
        Ok(facts)
    }
}

// Selected files share a hash shard with unrelated files. Skip those records
// by their binary lengths, without allocating paths, names, or type strings.
fn skip_string(bytes: &[u8], cursor: &mut usize) -> io::Result<()> {
    let data = bytes
        .get(*cursor..*cursor + 2)
        .ok_or_else(|| invalid_data("truncated fact string"))?;
    let len = u16::from_le_bytes(data.try_into().unwrap()) as usize;
    *cursor += 2;
    *cursor = cursor
        .checked_add(len)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| invalid_data("truncated fact string contents"))?;
    Ok(())
}

fn skip_fact(bytes: &[u8], cursor: &mut usize, tag: u8) -> io::Result<()> {
    read_u32_le(bytes, cursor)?;
    match tag {
        b'I' => {
            for _ in 0..3 {
                skip_string(bytes, cursor)?;
            }
            let count = bytes
                .get(*cursor..*cursor + 2)
                .ok_or_else(|| invalid_data("truncated fact list"))?;
            let count = u16::from_le_bytes(count.try_into().unwrap());
            *cursor += 2;
            for _ in 0..count {
                skip_string(bytes, cursor)?;
            }
        }
        b'T' => {
            skip_string(bytes, cursor)?;
            skip_string(bytes, cursor)?;
            if read_u8_at(bytes, cursor)? == 1 {
                skip_string(bytes, cursor)?;
            }
        }
        b'F' => {
            skip_string(bytes, cursor)?;
            skip_string(bytes, cursor)?;
        }
        _ => return Err(invalid_data("unknown binding fact tag")),
    }
    Ok(())
}

pub(super) fn read_paths(
    workspace: &Path,
    config: &EngineConfig,
    table: &FileTable,
    overlay: &GraphOverlay,
    paths: &HashSet<String>,
) -> io::Result<BindingFacts> {
    read_paths_cached(
        workspace,
        config,
        table,
        overlay,
        paths,
        &mut CountShardCache::new(0),
    )
}

fn read_paths_cached(
    workspace: &Path,
    config: &EngineConfig,
    table: &FileTable,
    overlay: &GraphOverlay,
    paths: &HashSet<String>,
    cache: &mut CountShardCache,
) -> io::Result<BindingFacts> {
    let base_paths: HashSet<_> = paths
        .iter()
        .filter(|path| !overlay.entries.contains_key(*path))
        .collect();
    let ids: HashSet<_> = base_paths
        .iter()
        .filter_map(|path| table.get_id(path))
        .collect();
    let shards: HashSet<_> = base_paths
        .iter()
        .filter(|path| table.get_id(path).is_some())
        .map(|path| shard_index_for_key(path))
        .collect();
    let mut out = BindingFacts::default();
    for shard in shards {
        let bytes = cache
            .read(&graph_shard_path(
                workspace,
                config,
                GRAPH_FACTS_BY_FILE_SHARD_PREFIX,
                shard,
            ))?
            .ok_or_else(|| invalid_data("missing binding facts shard"))?;
        let mut cursor = 0;
        while cursor < bytes.len() {
            let tag = read_u8_at(&bytes, &mut cursor)?;
            let start = cursor;
            let id = read_u32_le(&bytes, &mut cursor)?;
            cursor = start;
            if ids.contains(&id) {
                match tag {
                    b'I' => out
                        .imports
                        .push(parse_import_fact_binary(&bytes, &mut cursor, table)?),
                    b'T' => out
                        .types
                        .push(parse_type_fact_binary(&bytes, &mut cursor, table)?),
                    b'F' => out.returns.push(parse_function_return_fact_binary(
                        &bytes,
                        &mut cursor,
                        table,
                    )?),
                    _ => return Err(invalid_data("unknown binding fact tag")),
                }
            } else {
                skip_fact(&bytes, &mut cursor, tag)?;
            }
        }
    }
    for path in paths {
        if let Some(facts) = overlay.binding_facts.get(path) {
            out.imports.extend(facts.imports.iter().cloned());
            out.types.extend(facts.types.iter().cloned());
            out.returns.extend(facts.returns.iter().cloned());
        }
    }
    Ok(out)
}
