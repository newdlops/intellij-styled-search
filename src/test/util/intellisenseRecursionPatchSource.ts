import * as fs from 'fs';
import * as path from 'path';

const IR_EXTENSION_SOURCE_CANDIDATES = [
  '/Users/lky/project/intellisense-recursion/src/extension.ts',
];

let cachedScript: string | null | undefined;

/**
 * Extract intellisense-recursion's renderer-side hover patch script from its
 * source file. Returns the raw `(function(){...})()` body — exactly what IR
 * itself injects into the renderer at runtime.
 *
 * Returns null if the source file is not present (e.g., on a machine that
 * doesn't have the IR repo checked out). Tests should skip in that case
 * rather than fail.
 */
export function loadIntellisenseRecursionRendererPatchScript(): string | null {
  if (cachedScript !== undefined) { return cachedScript; }
  for (const candidate of IR_EXTENSION_SOURCE_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) { continue; }
      const src = fs.readFileSync(candidate, 'utf8');
      const startMarker = `function getHoverPatchScript(): string {`;
      const startIdx = src.indexOf(startMarker);
      if (startIdx < 0) { continue; }
      const returnIdx = src.indexOf('return `', startIdx);
      if (returnIdx < 0) { continue; }
      const bodyStart = returnIdx + 'return `'.length;
      const endIdx = src.indexOf('`;', bodyStart);
      if (endIdx < 0) { continue; }
      cachedScript = src.slice(bodyStart, endIdx);
      return cachedScript;
    } catch {
      // try next candidate
    }
  }
  cachedScript = null;
  return cachedScript;
}

// Compiled at out/test/util/intellisenseRecursionPatchSource.js — we don't
// actually need the path resolution machinery for the candidate list above;
// the absolute path is enough on the dev machine, and other machines fall
// through to null (test skips). The unused import keeps tsc honest about
// the module living in the codebase even if the resolution path changes.
void path;
