// ──────────────────────────────────────────────────────────────────────────
// Binary on-disk format for the trigram index.
//
// Previous format was JSON+gzip: gunzip alone cost ~6s on a 194 MB image
// and rebuilding 615K `new Set(ids)` cost another ~2.3s. This format skips
// both: raw little-endian binary with posting lists stored as u32 arrays.
// Load is a single Buffer walk; no JSON.parse, no Set.
//
// Layout (little-endian throughout):
//   magic    [4]  "TRIG"
//   version  [4]  u32 = 1
//   nextId   [4]  u32
//   fileCount[4]  u32
//   triCount [4]  u32
//
//   FileMeta section — fileCount entries:
//     id        [4]  u32
//     mtime     [8]  f64
//     size      [4]  u32
//     uriLen    [2]  u16
//     uri       [uriLen]  utf-8 bytes
//
//   Trigram section — triCount entries:
//     triLen    [1]  u8
//     tri       [triLen]  utf-8 bytes (usually 3; up to 9 for 3 multi-byte chars)
//     postLen   [4]  u32
//     posting   [postLen * 4]  u32 LE × postLen (sorted ascending)
// ──────────────────────────────────────────────────────────────────────────

export const MAGIC = Buffer.from('TRIG', 'utf-8');
export const VERSION = 1;       // legacy layout (everything interleaved)
export const VERSION_V3 = 3;    // TOC / postings split — enables lazy loading
export const HEADER_SIZE_V3 = 32;

export interface FileMeta { uri: string; mtime: number; size: number }

export interface IndexImage {
  nextId: number;
  fileMeta: Map<number, FileMeta>;
  tris: Map<string, Uint32Array>;
}

// v3 parse result — postings stay on disk; caller holds an fd and reads
// them by offset as needed. `toc` maps each trigram to its byte position
// WITHIN the postings section (relative to `postingsStart`, not absolute).
export interface ParsedMetaV3 {
  version: 3;
  nextId: number;
  fileMeta: Map<number, FileMeta>;
  toc: Map<string, { offset: number; length: number }>;
  postingsStart: number;
  postingsEnd: number;
}

export function serialize(image: IndexImage): Buffer {
  const { nextId, fileMeta, tris } = image;
  const fileCount = fileMeta.size;
  const triCount = tris.size;

  // Two-pass: size first, then write. Avoids Buffer concat churn on large
  // indexes (200 MB+) and keeps memory footprint close to the final size.
  const uriBuffers: Array<Buffer> = [];
  let fileSectionSize = 0;
  for (const meta of fileMeta.values()) {
    const b = Buffer.from(meta.uri, 'utf-8');
    if (b.length > 0xffff) {
      // URI way over u16 max (shouldn't happen for real file paths); truncate
      // rather than throw so the rest of the index survives.
      uriBuffers.push(b.slice(0, 0xffff));
    } else {
      uriBuffers.push(b);
    }
    fileSectionSize += 4 /*id*/ + 8 /*mtime*/ + 4 /*size*/ + 2 /*uriLen*/ + uriBuffers[uriBuffers.length - 1].length;
  }

  const triBuffers: Array<Buffer> = [];
  let triSectionSize = 0;
  for (const tri of tris.keys()) {
    const b = Buffer.from(tri, 'utf-8');
    if (b.length > 0xff) { triBuffers.push(b.slice(0, 0xff)); }
    else { triBuffers.push(b); }
    const postLen = tris.get(tri)!.length;
    triSectionSize += 1 /*triLen*/ + triBuffers[triBuffers.length - 1].length + 4 /*postLen*/ + postLen * 4;
  }

  const headerSize = MAGIC.length + 4 + 4 + 4 + 4;
  const total = headerSize + fileSectionSize + triSectionSize;
  const buf = Buffer.allocUnsafe(total);
  let off = 0;

  MAGIC.copy(buf, off); off += MAGIC.length;
  buf.writeUInt32LE(VERSION, off); off += 4;
  buf.writeUInt32LE(nextId >>> 0, off); off += 4;
  buf.writeUInt32LE(fileCount >>> 0, off); off += 4;
  buf.writeUInt32LE(triCount >>> 0, off); off += 4;

  let fi = 0;
  for (const [id, meta] of fileMeta) {
    buf.writeUInt32LE(id >>> 0, off); off += 4;
    buf.writeDoubleLE(meta.mtime, off); off += 8;
    buf.writeUInt32LE(meta.size >>> 0, off); off += 4;
    const ub = uriBuffers[fi++];
    buf.writeUInt16LE(ub.length, off); off += 2;
    ub.copy(buf, off); off += ub.length;
  }

  let ti = 0;
  for (const [, posting] of tris) {
    const tb = triBuffers[ti++];
    buf.writeUInt8(tb.length, off); off += 1;
    tb.copy(buf, off); off += tb.length;
    buf.writeUInt32LE(posting.length >>> 0, off); off += 4;
    // Copy u32s directly. Uint32Array → Buffer view via .buffer + offset.
    const postView = Buffer.from(posting.buffer, posting.byteOffset, posting.byteLength);
    postView.copy(buf, off); off += postView.length;
  }

  return buf;
}

// ──────────────────────────────────────────────────────────────────────────
// v3 on-disk layout
//
// Separates metadata (header + fileMeta + TOC) from posting payload so the
// extension can read just the first ~20 MB at startup and leave the 300 MB+
// of u32 posting arrays on disk until a query actually needs them.
//
// Header [32 bytes]:
//   magic       [4]   "TRIG"
//   version     [4]   u32 = 3
//   nextId      [4]   u32
//   fileCount   [4]   u32
//   triCount    [4]   u32
//   fileMetaEnd [4]   u32  (absolute byte offset where FileMeta ends / TOC starts)
//   tocEnd      [4]   u32  (absolute byte offset where TOC ends / postings start)
//   reserved    [4]   u32
//
// FileMeta section — fileCount entries, identical to v2:
//   id     [4]  u32
//   mtime  [8]  f64
//   size   [4]  u32
//   uriLen [2]  u16
//   uri    [uriLen]
//
// TOC section — triCount entries:
//   triLen     [1]  u8
//   tri        [triLen]
//   postOffset [4]  u32  (offset within postings section)
//   postLen    [4]  u32  (number of u32 entries)
//
// Postings section — concatenated u32 arrays, indexed by TOC.
// ──────────────────────────────────────────────────────────────────────────

export function serializeV3(image: IndexImage): Buffer {
  const fileCount = image.fileMeta.size;
  const triCount = image.tris.size;

  const uriBuffers: Buffer[] = [];
  let fileMetaBytes = 0;
  for (const meta of image.fileMeta.values()) {
    const b = Buffer.from(meta.uri, 'utf-8');
    const uriB = b.length > 0xffff ? b.slice(0, 0xffff) : b;
    uriBuffers.push(uriB);
    fileMetaBytes += 4 + 8 + 4 + 2 + uriB.length;
  }

  const triBuffers: Buffer[] = [];
  let tocBytes = 0;
  let postingsBytes = 0;
  for (const [tri, posting] of image.tris) {
    const b = Buffer.from(tri, 'utf-8');
    const triB = b.length > 0xff ? b.slice(0, 0xff) : b;
    triBuffers.push(triB);
    tocBytes += 1 + triB.length + 4 + 4;
    postingsBytes += posting.length * 4;
  }

  const fileMetaEnd = HEADER_SIZE_V3 + fileMetaBytes;
  const tocEnd = fileMetaEnd + tocBytes;
  const total = tocEnd + postingsBytes;
  const buf = Buffer.allocUnsafe(total);

  // Header
  let off = 0;
  MAGIC.copy(buf, off); off += MAGIC.length;
  buf.writeUInt32LE(VERSION_V3, off); off += 4;
  buf.writeUInt32LE(image.nextId >>> 0, off); off += 4;
  buf.writeUInt32LE(fileCount >>> 0, off); off += 4;
  buf.writeUInt32LE(triCount >>> 0, off); off += 4;
  buf.writeUInt32LE(fileMetaEnd >>> 0, off); off += 4;
  buf.writeUInt32LE(tocEnd >>> 0, off); off += 4;
  buf.writeUInt32LE(0, off); off += 4;

  // FileMeta
  let fi = 0;
  for (const [id, meta] of image.fileMeta) {
    buf.writeUInt32LE(id >>> 0, off); off += 4;
    buf.writeDoubleLE(meta.mtime, off); off += 8;
    buf.writeUInt32LE(meta.size >>> 0, off); off += 4;
    const ub = uriBuffers[fi++];
    buf.writeUInt16LE(ub.length, off); off += 2;
    ub.copy(buf, off); off += ub.length;
  }

  // TOC + postings — interleave writes using two cursors (tocOff, postOff).
  let ti = 0;
  let tocOff = fileMetaEnd;
  let postOff = tocEnd;
  for (const [, posting] of image.tris) {
    const tb = triBuffers[ti++];
    buf.writeUInt8(tb.length, tocOff); tocOff += 1;
    tb.copy(buf, tocOff); tocOff += tb.length;
    buf.writeUInt32LE((postOff - tocEnd) >>> 0, tocOff); tocOff += 4;
    buf.writeUInt32LE(posting.length >>> 0, tocOff); tocOff += 4;
    const postView = Buffer.from(posting.buffer, posting.byteOffset, posting.byteLength);
    postView.copy(buf, postOff); postOff += postView.length;
  }

  return buf;
}

/** Parse header + fileMeta + TOC only. Accepts a Buffer that covers at
 *  least [0 .. tocEnd); the caller reads postings on demand. Returns null
 *  if the magic/version doesn't match v3. */
export function parseMetaV3(bytes: Buffer): ParsedMetaV3 | null {
  if (bytes.length < HEADER_SIZE_V3) { return null; }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) { return null; }
  }
  let off = MAGIC.length;
  const version = bytes.readUInt32LE(off); off += 4;
  if (version !== VERSION_V3) { return null; }
  const nextId = bytes.readUInt32LE(off); off += 4;
  const fileCount = bytes.readUInt32LE(off); off += 4;
  const triCount = bytes.readUInt32LE(off); off += 4;
  const fileMetaEnd = bytes.readUInt32LE(off); off += 4;
  const tocEnd = bytes.readUInt32LE(off); off += 4;
  off += 4; // reserved

  if (bytes.length < tocEnd) { return null; }

  const fileMeta = new Map<number, FileMeta>();
  for (let i = 0; i < fileCount; i++) {
    if (off >= fileMetaEnd) { return null; }
    const id = bytes.readUInt32LE(off); off += 4;
    const mtime = bytes.readDoubleLE(off); off += 8;
    const size = bytes.readUInt32LE(off); off += 4;
    const uriLen = bytes.readUInt16LE(off); off += 2;
    const uri = bytes.toString('utf-8', off, off + uriLen); off += uriLen;
    fileMeta.set(id, { uri, mtime, size });
  }
  if (off !== fileMetaEnd) { return null; }

  const toc = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < triCount; i++) {
    if (off >= tocEnd) { return null; }
    const triLen = bytes.readUInt8(off); off += 1;
    const tri = bytes.toString('utf-8', off, off + triLen); off += triLen;
    const postOffset = bytes.readUInt32LE(off); off += 4;
    const postLen = bytes.readUInt32LE(off); off += 4;
    toc.set(tri, { offset: postOffset, length: postLen });
  }
  if (off !== tocEnd) { return null; }

  return { version: 3, nextId, fileMeta, toc, postingsStart: tocEnd, postingsEnd: -1 };
}

export function deserialize(bytes: Buffer): IndexImage | null {
  if (bytes.length < MAGIC.length + 16) { return null; }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) { return null; }
  }
  let off = MAGIC.length;
  const version = bytes.readUInt32LE(off); off += 4;
  if (version !== VERSION) { return null; }
  const nextId = bytes.readUInt32LE(off); off += 4;
  const fileCount = bytes.readUInt32LE(off); off += 4;
  const triCount = bytes.readUInt32LE(off); off += 4;

  const fileMeta = new Map<number, FileMeta>();
  for (let i = 0; i < fileCount; i++) {
    const id = bytes.readUInt32LE(off); off += 4;
    const mtime = bytes.readDoubleLE(off); off += 8;
    const size = bytes.readUInt32LE(off); off += 4;
    const uriLen = bytes.readUInt16LE(off); off += 2;
    const uri = bytes.toString('utf-8', off, off + uriLen); off += uriLen;
    fileMeta.set(id, { uri, mtime, size });
  }

  const tris = new Map<string, Uint32Array>();
  for (let i = 0; i < triCount; i++) {
    const triLen = bytes.readUInt8(off); off += 1;
    const tri = bytes.toString('utf-8', off, off + triLen); off += triLen;
    const postLen = bytes.readUInt32LE(off); off += 4;
    // Create a Uint32Array view that shares the underlying buffer (zero-copy
    // when the buffer alignment cooperates; otherwise falls back to a copy).
    let posting: Uint32Array;
    const byteOffset = bytes.byteOffset + off;
    if (byteOffset % 4 === 0) {
      // Aligned: true zero-copy view over the underlying ArrayBuffer.
      posting = new Uint32Array(bytes.buffer, byteOffset, postLen);
    } else {
      // Unaligned: must copy into a new u32 array.
      posting = new Uint32Array(postLen);
      for (let j = 0; j < postLen; j++) {
        posting[j] = bytes.readUInt32LE(off + j * 4);
      }
    }
    off += postLen * 4;
    tris.set(tri, posting);
  }

  return { nextId, fileMeta, tris };
}
