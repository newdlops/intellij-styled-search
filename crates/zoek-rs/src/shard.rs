use crate::config::SCHEMA_VERSION;
use crate::mmap_store::MappedFile;
use std::io;
use std::path::Path;

const SHARD_MAGIC: &[u8; 8] = b"ZKSHRD01";
const HEADER_BYTES: usize = 88;
const DOC_RECORD_BYTES: usize = 48;
const POSTING_RECORD_BYTES: usize = 32;

#[derive(Clone, Debug)]
pub struct IndexedDocument {
    pub rel_path: String,
    pub byte_len: u64,
    pub modified_unix_secs: u64,
    pub content_hash: u64,
    pub grams: Vec<String>,
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

pub fn build_shard_bytes(
    shard_id: u32,
    created_unix_secs: u64,
    documents: &[IndexedDocument],
) -> io::Result<ShardBuildResult> {
    let mut doc_records = Vec::with_capacity(documents.len());
    let mut string_blob = Vec::new();
    let mut postings_map = std::collections::BTreeMap::<String, Vec<u32>>::new();
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
            postings_map.entry(gram.clone()).or_default().push(doc_id as u32);
        }
    }

    let mut doc_ids_blob = Vec::new();
    let mut posting_records = Vec::with_capacity(postings_map.len());
    for (gram, mut doc_ids) in postings_map {
        doc_ids.sort_unstable();
        doc_ids.dedup();
        let gram_offset = string_blob.len() as u64;
        string_blob.extend_from_slice(gram.as_bytes());
        let doc_ids_offset = doc_ids_blob.len() as u64;
        for doc_id in &doc_ids {
            push_u32(&mut doc_ids_blob, *doc_id);
        }
        posting_records.push((
            gram_offset,
            gram.len() as u32,
            doc_ids.len() as u32,
            doc_ids_offset,
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
        doc_count: doc_records.len(),
        gram_count: posting_records.len(),
        doc_ids_count: doc_ids_blob.len() / 4,
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
    push_u64(&mut bytes, 0);

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
        push_u64(&mut bytes, record.3);
        push_u64(&mut bytes, 0);
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
            let gram_offset = read_u64_at(&self.bytes, base)?;
            let gram_len = read_u32_at(&self.bytes, base + 8)? as usize;
            let doc_freq = read_u32_at(&self.bytes, base + 12)? as usize;
            let doc_ids_offset = read_u64_at(&self.bytes, base + 16)?;
            let mut doc_ids = Vec::with_capacity(doc_freq);
            let ids_base = self.header.doc_ids_offset as usize + doc_ids_offset as usize;
            for doc_idx in 0..doc_freq {
                doc_ids.push(read_u32_at(&self.bytes, ids_base + doc_idx * 4)?);
            }
            postings.push(PostingList {
                gram: self.read_string(gram_offset, gram_len)?,
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
        let needle_bytes = needle.as_bytes();
        let mut lo = 0usize;
        let mut hi = total;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let base = self.header.postings_offset as usize + mid * POSTING_RECORD_BYTES;
            let gram_offset = read_u64_at(&self.bytes, base)?;
            let gram_len = read_u32_at(&self.bytes, base + 8)? as usize;
            let gram_start = self.header.strings_offset as usize + gram_offset as usize;
            let gram_end = gram_start + gram_len;
            let gram_bytes = self.bytes.get(gram_start..gram_end).ok_or_else(|| {
                io::Error::new(io::ErrorKind::UnexpectedEof, "gram range outside shard file")
            })?;
            match gram_bytes.cmp(needle_bytes) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    let doc_freq = read_u32_at(&self.bytes, base + 12)? as usize;
                    let doc_ids_offset = read_u64_at(&self.bytes, base + 16)?;
                    let ids_base = self.header.doc_ids_offset as usize + doc_ids_offset as usize;
                    let mut doc_ids = Vec::with_capacity(doc_freq);
                    for doc_idx in 0..doc_freq {
                        doc_ids.push(read_u32_at(&self.bytes, ids_base + doc_idx * 4)?);
                    }
                    return Ok(Some(PostingList {
                        gram: self.read_string(gram_offset, gram_len)?,
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
        let slice = self
            .bytes
            .get(start..end)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "string range outside shard file"))?;
        let value = std::str::from_utf8(slice)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        Ok(value.to_string())
    }
}

fn parse_header(bytes: &[u8]) -> io::Result<ShardHeader> {
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
    if header.file_len as usize != bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard file length does not match header",
        ));
    }
    if header.docs_offset as usize > bytes.len()
        || header.postings_offset as usize > bytes.len()
        || header.doc_ids_offset as usize > bytes.len()
        || header.strings_offset as usize > bytes.len()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shard header contains an out-of-range section offset",
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

fn read_u32_at(bytes: &[u8], offset: usize) -> io::Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "u32 read outside shard file"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64_at(bytes: &[u8], offset: usize) -> io::Result<u64> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "u64 read outside shard file"))?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

#[cfg(test)]
mod tests {
    use super::{build_shard_bytes, IndexedDocument, ShardReader};
    use crate::mmap_store::write_atomically;
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
            &[
                IndexedDocument {
                    rel_path: "src/a.rs".to_string(),
                    byte_len: 10,
                    modified_unix_secs: 1,
                    content_hash: 11,
                    grams: vec!["src".to_string(), "alph".to_string()],
                    gram_incomplete: false,
                },
                IndexedDocument {
                    rel_path: "src/b.rs".to_string(),
                    byte_len: 20,
                    modified_unix_secs: 2,
                    content_hash: 22,
                    grams: vec!["src".to_string(), "beta".to_string()],
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
                grams: vec![format!("g{:03}", idx), "shared".to_string()],
                gram_incomplete: false,
            });
        }
        let build = build_shard_bytes(0, 1, &docs)?;
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

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
