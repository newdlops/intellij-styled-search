// Entry point for the monaco bundle. esbuild packages this into an IIFE that
// exposes the API under a PRIVATE global name (not \`monaco\`) so we do not
// collide with anything VSCode might eventually put on \`globalThis.monaco\`.
// Our renderer patch looks up \`__ijFindMonacoApi\` first.
import * as monaco from 'monaco-editor';

if (typeof globalThis !== 'undefined') {
  globalThis.__ijFindMonacoApi = monaco;
}
