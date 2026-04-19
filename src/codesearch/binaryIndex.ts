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
export const VERSION = 1;

export interface FileMeta { uri: string; mtime: number; size: number }

export interface IndexImage {
  nextId: number;
  fileMeta: Map<number, FileMeta>;
  tris: Map<string, Uint32Array>;
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
