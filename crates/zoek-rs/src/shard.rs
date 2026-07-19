use crate::config::{
    ALL_FILES_INDEX_SCOPE, ENGINE_NAME, SCHEMA_VERSION, WORKSPACE_INDEX_SCOPE,
    WORKSPACE_METADATA_HASH_VERSION,
};
use crate::gram::{hash_gram_value, GramHashMap};
use crate::mmap_store::{MappedFile, StoreLayout};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SHARD_MAGIC: &[u8; 8] = b"ZKSHRD01";
const HEADER_BYTES: usize = 88;
const DOC_RECORD_BYTES: usize = 48;
const POSTING_RECORD_BYTES: usize = 16;

#[derive(Clone, Debug)]
pub struct IndexedDocument {
    pub rel_path: String,
    pub byte_len: u64,
    pub modified_unix_secs: u64,
    pub content_hash: u64,
    pub grams: Vec<u64>,
    /// Per-file "gram budget exhausted" flag. When true, the stored
    /// `grams` set is a prefix of the document's true gram set because the
    /// indexer hit `max_grams_per_file` before visiting every token.
    /// Searchers must include these docs as candidates regardless of
    /// required_grams AND-intersection, because any dropped gram would
    /// otherwise hide legit matches.
    pub gram_incomplete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShardHeader {
    pub schema_version: u32,
    pub shard_id: u32,
    pub created_unix_secs: u64,
    pub build_id: u64,
    pub doc_count: usize,
    pub gram_count: usize,
    pub doc_ids_count: usize,
    pub docs_offset: u64,
    pub postings_offset: u64,
    pub doc_ids_offset: u64,
    pub strings_offset: u64,
    pub file_len: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShardDocument {
    pub doc_id: u32,
    pub rel_path: String,
    pub byte_len: u64,
    pub modified_unix_secs: u64,
    pub gram_count: usize,
    pub content_hash: u64,
    pub gram_incomplete: bool,
}

// Bit flags stored in the reserved u32 after `doc_id` in each DOC record.
// The slot was previously padding (always 0), so reading old shards yields
// `flags=0` → `gram_incomplete=false`, matching their prior behavior.
const DOC_FLAG_GRAM_INCOMPLETE: u32 = 1 << 0;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostingList {
    pub gram: String,
    pub doc_ids: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct ShardBuildResult {
    pub header: ShardHeader,
    pub bytes: Vec<u8>,
    pub source_bytes: u64,
}

pub struct ShardReader {
    bytes: MappedFile,
    header: ShardHeader,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BaseIndexIdentity {
    pub created_unix_secs: u64,
    pub build_id: u64,
    pub shard_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BaseShardSet {
    pub identity: BaseIndexIdentity,
    pub index_scope: String,
    pub paths: Vec<PathBuf>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaseIndexManifest {
    pub(crate) engine: String,
    pub(crate) schema_version: u32,
    pub(crate) workspace_metadata_hash_version: u32,
    pub(crate) index_scope: String,
    pub(crate) workspace_root: String,
    pub(crate) index_root: String,
    pub(crate) created_unix_secs: u64,
    pub(crate) build_id: String,
    pub(crate) fingerprint: u64,
    pub(crate) workspace_metadata_fingerprint: u64,
    pub(crate) config_fingerprint: u64,
    pub(crate) shard_metadata_fingerprint: u64,
    pub(crate) stats: BaseIndexManifestStats,
    pub(crate) base_shards: Vec<BaseIndexManifestShard>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaseIndexManifestStats {
    pub(crate) visited_files: usize,
    pub(crate) indexed_files: usize,
    pub(crate) skipped_binary: usize,
    pub(crate) skipped_binary_extension: usize,
    pub(crate) skipped_too_large: usize,
    pub(crate) decoded_utf16_files: usize,
    pub(crate) shard_count: usize,
    pub(crate) total_grams: usize,
    pub(crate) total_source_bytes: u64,
    pub(crate) total_shard_bytes: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaseIndexManifestShard {
    pub(crate) shard_id: u32,
    pub(crate) file_name: String,
    pub(crate) doc_count: usize,
    pub(crate) gram_count: usize,
    pub(crate) source_bytes: u64,
    pub(crate) file_bytes: u64,
}

pub(crate) fn read_base_index_manifest(layout: &StoreLayout) -> io::Result<BaseIndexManifest> {
    let text = fs::read_to_string(&layout.manifest_path)?;
    let manifest: BaseIndexManifest = serde_json::from_str(&text).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid search index manifest: {err}"),
        )
    })?;
    if manifest.engine != ENGINE_NAME
        || manifest.schema_version != SCHEMA_VERSION
        || manifest.workspace_metadata_hash_version != WORKSPACE_METADATA_HASH_VERSION
        || !matches!(
            manifest.index_scope.as_str(),
            WORKSPACE_INDEX_SCOPE | ALL_FILES_INDEX_SCOPE
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest has an incompatible engine or schema",
        ));
    }
    if !manifest_path_matches(&manifest.workspace_root, &layout.workspace_root)
        || !manifest_path_matches(&manifest.index_root, &layout.root)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest belongs to a different workspace or index root",
        ));
    }
    if parse_positive_decimal_u64(&manifest.build_id).is_none()
        || manifest.created_unix_secs == 0
        || manifest.workspace_metadata_fingerprint == 0
        || manifest.config_fingerprint == 0
        || manifest.shard_metadata_fingerprint == 0
        || manifest.stats.shard_count == 0
        || manifest.base_shards.len() != manifest.stats.shard_count
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest has invalid generation or shard metadata",
        ));
    }

    let mut total_docs = 0usize;
    let mut total_grams = 0usize;
    let mut total_source_bytes = 0u64;
    let mut total_shard_bytes = 0u64;
    for (shard_id, shard) in manifest.base_shards.iter().enumerate() {
        let expected_name = layout.shard_file_name(shard_id as u32);
        if shard.shard_id as usize != shard_id
            || shard.file_name != expected_name
            || shard.file_bytes < HEADER_BYTES as u64
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "search index manifest has an invalid base shard entry",
            ));
        }
        total_docs = total_docs.checked_add(shard.doc_count).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "base document count overflow")
        })?;
        total_grams = total_grams.checked_add(shard.gram_count).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "base gram count overflow")
        })?;
        total_source_bytes = total_source_bytes
            .checked_add(shard.source_bytes)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "base source byte count overflow",
                )
            })?;
        total_shard_bytes = total_shard_bytes
            .checked_add(shard.file_bytes)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "base shard byte count overflow")
            })?;
    }
    if total_docs != manifest.stats.indexed_files
        || total_grams != manifest.stats.total_grams
        || total_source_bytes != manifest.stats.total_source_bytes
        || total_shard_bytes != manifest.stats.total_shard_bytes
        || manifest.stats.decoded_utf16_files > manifest.stats.indexed_files
        || manifest.stats.indexed_files > manifest.stats.visited_files
        || manifest.stats.skipped_binary > manifest.stats.visited_files
        || manifest.stats.skipped_binary_extension > manifest.stats.visited_files
        || manifest.stats.skipped_too_large > manifest.stats.visited_files
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest aggregate statistics do not match its shards",
        ));
    }
    Ok(manifest)
}

pub fn read_base_index_identity(layout: &StoreLayout) -> io::Result<BaseIndexIdentity> {
    let manifest = read_base_index_manifest(layout)?;
    let build_id = parse_positive_decimal_u64(&manifest.build_id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest is missing a valid build identity",
        )
    })?;
    Ok(BaseIndexIdentity {
        created_unix_secs: manifest.created_unix_secs,
        build_id,
        shard_count: manifest.stats.shard_count,
    })
}

pub fn validate_base_shard_header(
    identity: BaseIndexIdentity,
    expected_shard_id: usize,
    header: &ShardHeader,
) -> io::Result<()> {
    if header.shard_id as usize != expected_shard_id
        || header.created_unix_secs != identity.created_unix_secs
        || header.build_id != identity.build_id
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "base shard {expected_shard_id} does not belong to manifest build {}",
                identity.build_id
            ),
        ));
    }
    Ok(())
}

pub fn read_base_shard_set(layout: &StoreLayout) -> io::Result<BaseShardSet> {
    let manifest = read_base_index_manifest(layout)?;
    let build_id = parse_positive_decimal_u64(&manifest.build_id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest is missing a valid build identity",
        )
    })?;
    let identity = BaseIndexIdentity {
        created_unix_secs: manifest.created_unix_secs,
        build_id,
        shard_count: manifest.stats.shard_count,
    };
    let shard_paths = layout.list_shard_paths()?;
    if shard_paths.len() != identity.shard_count {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "search index manifest expects {} base shards but found {}",
                identity.shard_count,
                shard_paths.len()
            ),
        ));
    }

    for (shard_id, shard_path) in shard_paths.iter().enumerate() {
        let expected_name = layout.shard_file_name(shard_id as u32);
        if shard_path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected base shard file name: {}", shard_path.display()),
            ));
        }
    }
    Ok(BaseShardSet {
        identity,
        index_scope: manifest.index_scope,
        paths: shard_paths,
    })
}

pub fn open_validated_base_shard(
    identity: BaseIndexIdentity,
    shard_id: usize,
    path: &Path,
) -> io::Result<ShardReader> {
    let reader = ShardReader::open(path)?;
    validate_base_shard_header(identity, shard_id, reader.header())?;
    Ok(reader)
}

pub fn build_shard_bytes(
    shard_id: u32,
    created_unix_secs: u64,
    build_id: u64,
    documents: &[IndexedDocument],
) -> io::Result<ShardBuildResult> {
    let mut doc_records = Vec::with_capacity(documents.len());
    let mut string_blob = Vec::new();
    let estimated_postings = documents
        .iter()
        .map(|doc| doc.grams.len())
        .sum::<usize>()
        .min(262_144);
    let mut postings_map =
        GramHashMap::<Vec<u32>>::with_capacity_and_hasher(estimated_postings, Default::default());
    let source_bytes = documents.iter().map(|doc| doc.byte_len).sum::<u64>();

    for (doc_id, doc) in documents.iter().enumerate() {
        let path_offset = string_blob.len() as u64;
        string_blob.extend_from_slice(doc.rel_path.as_bytes());
        let mut flags: u32 = 0;
        if doc.gram_incomplete {
            flags |= DOC_FLAG_GRAM_INCOMPLETE;
        }
        doc_records.push((
            doc_id as u32,
            path_offset,
            doc.rel_path.len() as u32,
            doc.byte_len,
            doc.modified_unix_secs,
            doc.grams.len() as u32,
            doc.content_hash,
            flags,
        ));
        for gram in &doc.grams {
            postings_map.entry(*gram).or_default().push(doc_id as u32);
        }
    }

    let mut doc_ids_blob = Vec::new();
    let mut posting_records = Vec::with_capacity(postings_map.len());
    let mut postings = postings_map.into_iter().collect::<Vec<_>>();
    postings.sort_unstable_by_key(|(gram_hash, _)| *gram_hash);
    for (gram_hash, doc_ids) in postings {
        let doc_ids_offset = doc_ids_blob.len() as u64;
        let mut previous_doc_id = 0u32;
        for (idx, doc_id) in doc_ids.iter().enumerate() {
            let delta = if idx == 0 {
                *doc_id
            } else {
                doc_id.saturating_sub(previous_doc_id)
            };
            push_var_u32(&mut doc_ids_blob, delta);
            previous_doc_id = *doc_id;
        }
        posting_records.push((
            gram_hash,
            doc_ids.len() as u32,
            checked_u32(doc_ids_offset, "doc ids offset")?,
        ));
    }

    let docs_offset = HEADER_BYTES as u64;
    let postings_offset = docs_offset + (doc_records.len() * DOC_RECORD_BYTES) as u64;
    let doc_ids_offset = postings_offset + (posting_records.len() * POSTING_RECORD_BYTES) as u64;
    let strings_offset = doc_ids_offset + doc_ids_blob.len() as u64;
    let file_len = strings_offset + string_blob.len() as u64;
    let header = ShardHeader {
        schema_version: SCHEMA_VERSION,
        shard_id,
        created_unix_secs,
        build_id,
        doc_count: doc_records.len(),
        gram_count: posting_records.len(),
        doc_ids_count: doc_ids_blob.len(),
        docs_offset,
        postings_offset,
        doc_ids_offset,
        strings_offset,
        file_len,
    };

    let mut bytes = Vec::with_capacity(file_len as usize);
    bytes.extend_from_slice(SHARD_MAGIC);
    push_u32(&mut bytes, header.schema_version);
    push_u32(&mut bytes, header.shard_id);
    push_u64(&mut bytes, header.created_unix_secs);
    push_u32(&mut bytes, header.doc_count as u32);
    push_u32(&mut bytes, header.gram_count as u32);
    push_u32(&mut bytes, header.doc_ids_count as u32);
    push_u32(&mut bytes, 0);
    push_u64(&mut bytes, header.docs_offset);
    push_u64(&mut bytes, header.postings_offset);
    push_u64(&mut bytes, header.doc_ids_offset);
    push_u64(&mut bytes, header.strings_offset);
    push_u64(&mut bytes, header.file_len);
    push_u64(&mut bytes, header.build_id);

    for record in &doc_records {
        push_u32(&mut bytes, record.0);
        // Previously unused padding slot — now stores doc-level flags.
        // Old shards had 0 here which maps to `gram_incomplete=false`, so
        // reading old shards on a new binary yields prior behavior.
        push_u32(&mut bytes, record.7);
        push_u64(&mut bytes, record.1);
        push_u32(&mut bytes, record.2);
        push_u32(&mut bytes, record.5);
        push_u64(&mut bytes, record.3);
        push_u64(&mut bytes, record.4);
        push_u64(&mut bytes, record.6);
    }
    for record in &posting_records {
        push_u64(&mut bytes, record.0);
        push_u32(&mut bytes, record.1);
        push_u32(&mut bytes, record.2);
    }
    bytes.extend_from_slice(&doc_ids_blob);
    bytes.extend_from_slice(&string_blob);
    if bytes.len() as u64 != header.file_len {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard writer produced an unexpected file length",
        ));
    }

    Ok(ShardBuildResult {
        header,
        bytes,
        source_bytes,
    })
}

impl ShardReader {
    pub fn open(path: &Path) -> io::Result<Self> {
        let bytes = MappedFile::open(path)?;
        let header = parse_header(&bytes)?;
        Ok(Self { bytes, header })
    }

    pub fn header(&self) -> &ShardHeader {
        &self.header
    }

    pub fn documents(&self) -> io::Result<Vec<ShardDocument>> {
        let mut docs = Vec::with_capacity(self.header.doc_count);
        for idx in 0..self.header.doc_count {
            let base = self.header.docs_offset as usize + idx * DOC_RECORD_BYTES;
            let doc_id = read_u32_at(&self.bytes, base)?;
            let flags = read_u32_at(&self.bytes, base + 4)?;
            let path_offset = read_u64_at(&self.bytes, base + 8)?;
            let path_len = read_u32_at(&self.bytes, base + 16)? as usize;
            let gram_count = read_u32_at(&self.bytes, base + 20)? as usize;
            let byte_len = read_u64_at(&self.bytes, base + 24)?;
            let modified_unix_secs = read_u64_at(&self.bytes, base + 32)?;
            let content_hash = read_u64_at(&self.bytes, base + 40)?;
            docs.push(ShardDocument {
                doc_id,
                rel_path: self.read_string(path_offset, path_len)?,
                byte_len,
                modified_unix_secs,
                gram_count,
                content_hash,
                gram_incomplete: (flags & DOC_FLAG_GRAM_INCOMPLETE) != 0,
            });
        }
        Ok(docs)
    }

    pub fn postings(&self) -> io::Result<Vec<PostingList>> {
        let mut postings = Vec::with_capacity(self.header.gram_count);
        for idx in 0..self.header.gram_count {
            let base = self.header.postings_offset as usize + idx * POSTING_RECORD_BYTES;
            let gram_hash = read_u64_at(&self.bytes, base)?;
            let doc_freq = read_u32_at(&self.bytes, base + 8)? as usize;
            let doc_ids_offset = read_u32_at(&self.bytes, base + 12)? as u64;
            let mut doc_ids = Vec::with_capacity(doc_freq);
            let ids_base = self.header.doc_ids_offset as usize + doc_ids_offset as usize;
            read_var_doc_ids(&self.bytes, ids_base, doc_freq, &mut doc_ids)?;
            postings.push(PostingList {
                gram: format!("{gram_hash:016x}"),
                doc_ids,
            });
        }
        Ok(postings)
    }

    pub fn find_posting(&self, needle: &str) -> io::Result<Option<PostingList>> {
        // Posting records are written in BTreeMap (ascending gram) order by
        // `build_shard_bytes`, so the index is already sorted for binary
        // search. Compare as raw bytes on mmap without allocating a String
        // per probe — this is called once per query gram per shard and
        // dominates search latency on large indexes.
        let total = self.header.gram_count;
        if total == 0 {
            return Ok(None);
        }
        let needle_hash = hash_gram_value(needle);
        let mut lo = 0usize;
        let mut hi = total;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let base = self.header.postings_offset as usize + mid * POSTING_RECORD_BYTES;
            let gram_hash = read_u64_at(&self.bytes, base)?;
            match gram_hash.cmp(&needle_hash) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    let doc_freq = read_u32_at(&self.bytes, base + 8)? as usize;
                    let doc_ids_offset = read_u32_at(&self.bytes, base + 12)? as u64;
                    let ids_base = self.header.doc_ids_offset as usize + doc_ids_offset as usize;
                    let mut doc_ids = Vec::with_capacity(doc_freq);
                    read_var_doc_ids(&self.bytes, ids_base, doc_freq, &mut doc_ids)?;
                    return Ok(Some(PostingList {
                        gram: format!("{gram_hash:016x}"),
                        doc_ids,
                    }));
                }
            }
        }
        Ok(None)
    }

    fn read_string(&self, offset: u64, len: usize) -> io::Result<String> {
        let start = self.header.strings_offset as usize + offset as usize;
        let end = start + len;
        let slice = self.bytes.get(start..end).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "string range outside shard file",
            )
        })?;
        let value = std::str::from_utf8(slice)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        Ok(value.to_string())
    }
}

pub fn read_shard_header(path: &Path) -> io::Result<ShardHeader> {
    let mut file = fs::File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut bytes = [0u8; HEADER_BYTES];
    file.read_exact(&mut bytes)?;
    parse_header_with_file_len(&bytes, file_len)
}

fn parse_header(bytes: &[u8]) -> io::Result<ShardHeader> {
    parse_header_with_file_len(bytes, bytes.len() as u64)
}

fn parse_header_with_file_len(bytes: &[u8], actual_file_len: u64) -> io::Result<ShardHeader> {
    if bytes.len() < HEADER_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "shard file is shorter than the fixed header",
        ));
    }
    if &bytes[0..8] != SHARD_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard magic does not match",
        ));
    }
    let header = ShardHeader {
        schema_version: read_u32_at(bytes, 8)?,
        shard_id: read_u32_at(bytes, 12)?,
        created_unix_secs: read_u64_at(bytes, 16)?,
        build_id: read_u64_at(bytes, 80)?,
        doc_count: read_u32_at(bytes, 24)? as usize,
        gram_count: read_u32_at(bytes, 28)? as usize,
        doc_ids_count: read_u32_at(bytes, 32)? as usize,
        docs_offset: read_u64_at(bytes, 40)?,
        postings_offset: read_u64_at(bytes, 48)?,
        doc_ids_offset: read_u64_at(bytes, 56)?,
        strings_offset: read_u64_at(bytes, 64)?,
        file_len: read_u64_at(bytes, 72)?,
    };
    if header.schema_version != SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported shard schema version {} (expected {})",
                header.schema_version, SCHEMA_VERSION
            ),
        ));
    }
    if header.file_len != actual_file_len {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard file length does not match header",
        ));
    }
    if header.docs_offset > actual_file_len
        || header.postings_offset > actual_file_len
        || header.doc_ids_offset > actual_file_len
        || header.strings_offset > actual_file_len
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard header contains an out-of-range section offset",
        ));
    }
    let expected_postings_offset = (HEADER_BYTES as u64)
        .checked_add((header.doc_count as u64).saturating_mul(DOC_RECORD_BYTES as u64));
    let expected_doc_ids_offset = expected_postings_offset.and_then(|offset| {
        offset.checked_add((header.gram_count as u64).saturating_mul(POSTING_RECORD_BYTES as u64))
    });
    let expected_strings_offset =
        expected_doc_ids_offset.and_then(|offset| offset.checked_add(header.doc_ids_count as u64));
    if header.docs_offset != HEADER_BYTES as u64
        || Some(header.postings_offset) != expected_postings_offset
        || Some(header.doc_ids_offset) != expected_doc_ids_offset
        || Some(header.strings_offset) != expected_strings_offset
        || header.strings_offset > header.file_len
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard header section layout is inconsistent with its counts",
        ));
    }
    Ok(header)
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn checked_u32(value: u64, label: &str) -> io::Result<u32> {
    u32::try_from(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} exceeds u32 range"),
        )
    })
}

fn push_var_u32(bytes: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        bytes.push((value as u8) | 0x80);
        value >>= 7;
    }
    bytes.push(value as u8);
}

fn read_var_doc_ids(
    bytes: &[u8],
    mut offset: usize,
    count: usize,
    out: &mut Vec<u32>,
) -> io::Result<()> {
    let mut previous = 0u32;
    for idx in 0..count {
        let (delta, next_offset) = read_var_u32_at(bytes, offset)?;
        offset = next_offset;
        let doc_id = if idx == 0 {
            delta
        } else {
            previous.checked_add(delta).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "doc id delta overflow")
            })?
        };
        out.push(doc_id);
        previous = doc_id;
    }
    Ok(())
}

fn read_var_u32_at(bytes: &[u8], mut offset: usize) -> io::Result<(u32, usize)> {
    let mut value = 0u32;
    let mut shift = 0u32;
    loop {
        let byte = *bytes.get(offset).ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "varint outside shard file")
        })?;
        offset += 1;
        value |= u32::from(byte & 0x7f) << shift;
        if (byte & 0x80) == 0 {
            return Ok((value, offset));
        }
        shift += 7;
        if shift >= 35 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "varint is too long for u32",
            ));
        }
    }
}

fn read_u32_at(bytes: &[u8], offset: usize) -> io::Result<u32> {
    let slice = bytes.get(offset..offset + 4).ok_or_else(|| {
        io::Error::new(io::ErrorKind::UnexpectedEof, "u32 read outside shard file")
    })?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64_at(bytes: &[u8], offset: usize) -> io::Result<u64> {
    let slice = bytes.get(offset..offset + 8).ok_or_else(|| {
        io::Error::new(io::ErrorKind::UnexpectedEof, "u64 read outside shard file")
    })?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

fn parse_positive_decimal_u64(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn manifest_path_matches(value: &str, expected: &Path) -> bool {
    let manifest_path = Path::new(value);
    if manifest_path == expected {
        return true;
    }
    match (fs::canonicalize(manifest_path), fs::canonicalize(expected)) {
        (Ok(manifest_path), Ok(expected)) => manifest_path == expected,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_shard_bytes, open_validated_base_shard, parse_header, read_base_shard_set,
        IndexedDocument, ShardReader,
    };
    use crate::config::EngineConfig;
    use crate::gram::hash_gram_value;
    use crate::mmap_store::{write_atomically, StoreLayout};
    use crate::protocol::json_string;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn shard_round_trip_preserves_documents_and_postings() -> io::Result<()> {
        let root = temp_dir("shard");
        fs::create_dir_all(&root)?;
        let shard_path = root.join("base-shard-0000.zrs");
        let build = build_shard_bytes(
            0,
            123,
            456,
            &[
                IndexedDocument {
                    rel_path: "src/a.rs".to_string(),
                    byte_len: 10,
                    modified_unix_secs: 1,
                    content_hash: 11,
                    grams: vec![hash_gram_value("src"), hash_gram_value("alph")],
                    gram_incomplete: false,
                },
                IndexedDocument {
                    rel_path: "src/b.rs".to_string(),
                    byte_len: 20,
                    modified_unix_secs: 2,
                    content_hash: 22,
                    grams: vec![hash_gram_value("src"), hash_gram_value("beta")],
                    gram_incomplete: false,
                },
            ],
        )?;
        write_atomically(&shard_path, &build.bytes)?;

        let reader = ShardReader::open(&shard_path)?;
        assert_eq!(reader.header().doc_count, 2);
        assert_eq!(reader.header().gram_count, 3);
        let docs = reader.documents()?;
        assert_eq!(docs[0].rel_path, "src/a.rs");
        let posting = reader.find_posting("src")?.expect("src posting must exist");
        assert_eq!(posting.doc_ids, vec![0, 1]);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn find_posting_locates_grams_via_binary_search() -> io::Result<()> {
        let root = temp_dir("shard-bsearch");
        fs::create_dir_all(&root)?;
        let shard_path = root.join("base-shard-0000.zrs");

        let mut docs = Vec::new();
        for idx in 0..64u32 {
            docs.push(IndexedDocument {
                rel_path: format!("src/f{idx}.rs"),
                byte_len: 1,
                modified_unix_secs: idx as u64,
                content_hash: idx as u64,
                grams: vec![
                    hash_gram_value(&format!("g{:03}", idx)),
                    hash_gram_value("shared"),
                ],
                gram_incomplete: false,
            });
        }
        let build = build_shard_bytes(0, 1, 2, &docs)?;
        write_atomically(&shard_path, &build.bytes)?;
        let reader = ShardReader::open(&shard_path)?;

        // Hit: gram stored only on one doc, at the boundary.
        let first = reader.find_posting("g000")?.expect("g000 must exist");
        assert_eq!(first.doc_ids, vec![0]);
        let last = reader.find_posting("g063")?.expect("g063 must exist");
        assert_eq!(last.doc_ids, vec![63]);

        // Hit: gram shared across every doc.
        let shared = reader.find_posting("shared")?.expect("shared must exist");
        assert_eq!(shared.doc_ids.len(), 64);

        // Miss: values that sort before, between, and after stored grams.
        assert!(reader.find_posting("aaaa")?.is_none());
        assert!(reader.find_posting("g999")?.is_none());
        assert!(reader.find_posting("zzzz")?.is_none());

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn shard_header_rejects_section_offsets_inconsistent_with_counts() -> io::Result<()> {
        let mut bytes = build_shard_bytes(0, 1, 2, &[])?.bytes;
        bytes[48..56].copy_from_slice(&89u64.to_le_bytes());
        let error = parse_header(&bytes).expect_err("invalid section layout must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        Ok(())
    }

    #[test]
    fn base_shard_set_rejects_mixed_build_identities() -> io::Result<()> {
        let root = temp_dir("base-build-identity");
        fs::create_dir_all(&root)?;
        let layout = StoreLayout::for_workspace(&root, &EngineConfig::default());
        layout.ensure_dirs()?;
        let manifest = format!(
            "{{\"engine\":\"zoek-rs\",\"schemaVersion\":22,\"workspaceMetadataHashVersion\":3,\"indexScope\":\"workspace\",\"workspaceRoot\":{},\"indexRoot\":{},\"createdUnixSecs\":1,\"buildId\":\"2\",\"fingerprint\":1,\"workspaceMetadataFingerprint\":1,\"configFingerprint\":1,\"shardMetadataFingerprint\":1,\"stats\":{{\"visitedFiles\":0,\"indexedFiles\":0,\"skippedBinary\":0,\"skippedBinaryExtension\":0,\"skippedTooLarge\":0,\"decodedUtf16Files\":0,\"shardCount\":1,\"totalGrams\":0,\"totalSourceBytes\":0,\"totalShardBytes\":88}},\"baseShards\":[{{\"shardId\":0,\"fileName\":\"base-shard-0000.zrs\",\"docCount\":0,\"gramCount\":0,\"sourceBytes\":0,\"fileBytes\":88}}]}}",
            json_string(&root.to_string_lossy()),
            json_string(&layout.root.to_string_lossy()),
        );
        write_atomically(&layout.manifest_path, manifest.as_bytes())?;

        let matching = build_shard_bytes(0, 1, 2, &[])?.bytes;
        write_atomically(&layout.shard_path(0), &matching)?;
        let base_shards = read_base_shard_set(&layout)?;
        open_validated_base_shard(base_shards.identity, 0, &base_shards.paths[0])?;

        let mixed = build_shard_bytes(0, 1, 3, &[])?.bytes;
        write_atomically(&layout.shard_path(0), &mixed)?;
        let error = open_validated_base_shard(base_shards.identity, 0, &base_shards.paths[0])
            .err()
            .expect("a shard from another build must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
