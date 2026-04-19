// Worker thread that reads the trigram index file off the main event loop.
//
// Two on-disk layouts are supported:
//
//   v2 (legacy): header + interleaved [trigram, postLen, posting…] section.
//     Entire file must be read; we transfer the whole ArrayBuffer back so
//     the main thread can make Uint32Array views.
//
//   v3: header + fileMeta section + TOC section + postings section, sized
//     with explicit section-end offsets. The worker reads ONLY [0..tocEnd)
//     — typically ~20 MB for a 370 MB index — and returns the parsed TOC.
//     Postings stay on disk; the main thread opens its own fd and reads
//     individual posting byte-ranges on demand.
//
// Transfer protocol back to main:
//   { ok: true, kind: 'v2' | 'v3', readMs, parseMs, ... version-specific payload }
//   | { ok: false, err }

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { MAGIC, HEADER_SIZE_V3, VERSION_V3 } from './codesearch/binaryIndex';

if (!parentPort) {
  throw new Error('indexWorker must be spawned as a worker_thread');
}

parentPort.on('message', (msg: { path: string }) => {
  try {
    handleLoad(msg.path);
  } catch (err) {
    parentPort!.postMessage({ ok: false, err: (err as Error).message });
  }
});

function handleLoad(filePath: string): void {
  // Probe the header first so we know how many bytes we actually need.
  let fd: number;
  try { fd = fs.openSync(filePath, 'r'); }
  catch (err) {
    parentPort!.postMessage({ ok: false, err: (err as Error).message });
    return;
  }
  const t0 = Date.now();
  const header = Buffer.alloc(HEADER_SIZE_V3);
  const headerRead = fs.readSync(fd, header, 0, HEADER_SIZE_V3, 0);
  if (headerRead < HEADER_SIZE_V3) {
    fs.closeSync(fd);
    parentPort!.postMessage({ ok: false, err: 'file too short' });
    return;
  }
  // Magic check.
  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) {
      fs.closeSync(fd);
      parentPort!.postMessage({ ok: false, err: 'bad magic' });
      return;
    }
  }
  const version = header.readUInt32LE(4);

  if (version === VERSION_V3) {
    handleV3(fd, header, t0);
  } else if (version === 1) {
    // Legacy v2 layout — fall back to full read.
    handleV2(fd, filePath, t0);
  } else {
    fs.closeSync(fd);
    parentPort!.postMessage({ ok: false, err: 'unsupported version ' + version });
  }
}

function handleV3(fd: number, header: Buffer, t0: number): void {
  const nextId = header.readUInt32LE(8);
  const fileCount = header.readUInt32LE(12);
  const triCount = header.readUInt32LE(16);
  const fileMetaEnd = header.readUInt32LE(20);
  const tocEnd = header.readUInt32LE(24);

  // Read [0 .. tocEnd) into memory; postings ([tocEnd..EOF]) stay on disk.
  const metaBytes = Buffer.alloc(tocEnd);
  header.copy(metaBytes, 0, 0, HEADER_SIZE_V3);
  let read = HEADER_SIZE_V3;
  while (read < tocEnd) {
    const n = fs.readSync(fd, metaBytes, read, tocEnd - read, read);
    if (n <= 0) { break; }
    read += n;
  }
  fs.closeSync(fd);
  const t1 = Date.now();
  if (read < tocEnd) {
    parentPort!.postMessage({ ok: false, err: 'short meta read' });
    return;
  }

  // Parse fileMeta + TOC
  const fileMeta: Array<[number, string, number, number]> = new Array(fileCount);
  let off = HEADER_SIZE_V3;
  for (let i = 0; i < fileCount; i++) {
    const id = metaBytes.readUInt32LE(off); off += 4;
    const mtime = metaBytes.readDoubleLE(off); off += 8;
    const size = metaBytes.readUInt32LE(off); off += 4;
    const uriLen = metaBytes.readUInt16LE(off); off += 2;
    const uri = metaBytes.toString('utf-8', off, off + uriLen); off += uriLen;
    fileMeta[i] = [id, uri, mtime, size];
  }

  const triArr: Array<[string, number, number]> = new Array(triCount);
  for (let i = 0; i < triCount; i++) {
    const triLen = metaBytes.readUInt8(off); off += 1;
    const tri = metaBytes.toString('utf-8', off, off + triLen); off += triLen;
    const postOffset = metaBytes.readUInt32LE(off); off += 4;
    const postLen = metaBytes.readUInt32LE(off); off += 4;
    triArr[i] = [tri, postOffset, postLen];
  }
  const t2 = Date.now();

  parentPort!.postMessage({
    ok: true,
    kind: 'v3',
    readMs: t1 - t0,
    parseMs: t2 - t1,
    totalBytes: tocEnd,
    nextId,
    fileMeta,
    triArr,
    postingsStart: tocEnd,
  });
}

function handleV2(fd: number, filePath: string, t0: number): void {
  // v2 kept the entire posting section inline with the TOC, so we have to
  // read the whole file. Migration path: load here, main thread will
  // re-save as v3 at next save tick.
  fs.closeSync(fd);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(filePath); }
  catch (err) {
    parentPort!.postMessage({ ok: false, err: (err as Error).message });
    return;
  }
  const t1 = Date.now();
  const parsed = parseV2(bytes);
  const t2 = Date.now();
  if (!parsed) {
    parentPort!.postMessage({ ok: false, err: 'v2 parse failed' });
    return;
  }
  const ab = bytes.buffer as ArrayBuffer;
  parentPort!.postMessage(
    {
      ok: true,
      kind: 'v2',
      readMs: t1 - t0,
      parseMs: t2 - t1,
      buffer: ab,
      byteOffsetBase: bytes.byteOffset,
      byteLength: bytes.length,
      nextId: parsed.nextId,
      fileMeta: parsed.fileMeta,
      triArr: parsed.triArr,
    },
    [ab],
  );
}

function parseV2(bytes: Buffer): {
  nextId: number;
  fileMeta: Array<[number, string, number, number]>;
  triArr: Array<[string, number, number]>;
} | null {
  const MAGIC_LEN = 4;
  if (bytes.length < MAGIC_LEN + 16) { return null; }
  if (bytes[0] !== 0x54 || bytes[1] !== 0x52 || bytes[2] !== 0x49 || bytes[3] !== 0x47) { return null; }
  let off = MAGIC_LEN;
  const version = bytes.readUInt32LE(off); off += 4;
  if (version !== 1) { return null; }
  const nextId = bytes.readUInt32LE(off); off += 4;
  const fileCount = bytes.readUInt32LE(off); off += 4;
  const triCount = bytes.readUInt32LE(off); off += 4;

  const fileMeta: Array<[number, string, number, number]> = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) {
    const id = bytes.readUInt32LE(off); off += 4;
    const mtime = bytes.readDoubleLE(off); off += 8;
    const size = bytes.readUInt32LE(off); off += 4;
    const uriLen = bytes.readUInt16LE(off); off += 2;
    const uri = bytes.toString('utf-8', off, off + uriLen); off += uriLen;
    fileMeta[i] = [id, uri, mtime, size];
  }

  const triArr: Array<[string, number, number]> = new Array(triCount);
  for (let i = 0; i < triCount; i++) {
    const triLen = bytes.readUInt8(off); off += 1;
    const tri = bytes.toString('utf-8', off, off + triLen); off += triLen;
    const postLen = bytes.readUInt32LE(off); off += 4;
    triArr[i] = [tri, off, postLen];
    off += postLen * 4;
  }
  return { nextId, fileMeta, triArr };
}
