// Independent compiler-reference audit of module functions in a real snapshot.
// Unresolved/dynamic locations remain unclassified. This is a sampled audit,
// not a whole-project precision/recall score.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const arguments_ = process.argv.slice(2);
const failOnProvenErrors = arguments_.includes('--fail-on-proven-errors');
const [workspaceArg, binaryArg, outputArg, sampleArg = '20'] = arguments_.filter(arg => arg !== '--fail-on-proven-errors');
if (!workspaceArg || !binaryArg || !outputArg) {
  throw new Error('Usage: node auditTypeScriptUsageSemantics.js WORKSPACE BINARY OUTPUT [SAMPLES] [--fail-on-proven-errors]');
}
const workspace = path.resolve(workspaceArg);
const binary = path.resolve(binaryArg);
const sampleCount = Number(sampleArg);
if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
  throw new Error('SAMPLES must be a positive integer.');
}
const sources = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) sources.push(file);
  }
}
walk(workspace);
const options = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
  allowJs: true, skipLibCheck: true, noEmit: true };
const host = {
  getScriptFileNames: () => sources, getScriptVersion: () => '1',
  getScriptSnapshot: file => ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(file)) : undefined,
  getCurrentDirectory: () => workspace, getCompilationSettings: () => options,
  getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host);
const program = service.getProgram();
function invoke(...args) {
  const response = JSON.parse(execFileSync(binary, args.map(String), {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000,
  }));
  if (!response.ok) throw new Error(JSON.stringify(response));
  return response;
}
const declarations = [];
for (const file of sources) {
  const source = program.getSourceFile(file);
  if (!source) continue;
  for (const statement of source.statements) {
    const nodes = ts.isFunctionDeclaration(statement) ? [statement]
      : ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter(node =>
        node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) : [];
    for (const node of nodes) {
      if (node.name && ts.isIdentifier(node.name)) declarations.push({ file, source, node, position: node.name.getStart(source) });
    }
  }
}
const location = (file, offset) => {
  const source = program.getSourceFile(file);
  if (!source) return undefined;
  const point = source.getLineAndCharacterOfPosition(offset);
  return [path.relative(workspace, file).split(path.sep).join('/'), point.line, point.character];
};
const key = point => JSON.stringify(point);
function isValueDeclarationName(source, offset) {
  let declaration = false;
  function visit(node) {
    if (offset < node.getFullStart() || offset >= node.end) return;
    if (ts.isIdentifier(node) && node.getStart(source) === offset) {
      const parent = node.parent;
      declaration = parent.name === node && (ts.isVariableDeclaration(parent)
        || ts.isParameter(parent) || ts.isBindingElement(parent)
        || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
        || ts.isClassDeclaration(parent) || ts.isClassExpression(parent));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return declaration;
}
const results = [];
let candidatesChecked = 0;
for (const candidate of declarations) {
  if (results.length >= sampleCount) break;
  const { file, source, node, position } = candidate;
  candidatesChecked++;
  const groups = service.findReferences(file, position) || [];
  const targetDefinitions = new Set(groups.map(group =>
    key([path.resolve(group.definition.fileName), group.definition.textSpan.start])));
  targetDefinitions.add(key([path.resolve(file), position]));
  // A named function expression has an internal function name and an outer
  // variable binding. Compiler definitions at a call can use either identity.
  if (ts.isVariableDeclaration(node) && node.initializer?.name) {
    targetDefinitions.add(key([path.resolve(file), node.initializer.name.getStart(source)]));
  }
  const expected = new Set(groups.flatMap(group => group.references)
    .filter(reference => !reference.isDefinition)
    .map(reference => location(reference.fileName, reference.textSpan.start))
    .filter(Boolean).map(key));
  if (!expected.size) continue;
  const point = source.getLineAndCharacterOfPosition(position);
  const relPath = path.relative(workspace, file).split(path.sep).join('/');
  const matches = invoke('graph-symbol-query', workspace, '--query', node.name.text, '--limit', 10000).symbols
    .filter(symbol => symbol.relPath === relPath && symbol.name === node.name.text && symbol.range.startLine === point.line);
  if (matches.length !== 1) {
    results.push({ path: relPath, name: node.name.text, required: expected.size, requiredFound: 0,
      provenOtherBinding: 0, unclassified: 0, error: 'declaration not uniquely indexed', declarationsFound: matches.length });
    continue;
  }
  const symbol = matches[0];
  const page = invoke('graph-query', workspace, '--symbol-id', symbol.id, '--limit', 20000);
  const actual = new Set(page.references.map(reference => key([reference.relPath, reference.range.startLine, reference.range.startColumn])));
  const missing = [...expected].filter(point => !actual.has(point)).map(JSON.parse);
  const extra = page.references.filter(reference => !expected.has(key([reference.relPath, reference.range.startLine, reference.range.startColumn])));
  const otherBinding = [];
  const nonReferences = [];
  for (const reference of extra) {
    const refFile = path.join(workspace, reference.relPath);
    const refSource = program.getSourceFile(refFile);
    if (!refSource) continue;
    const offset = refSource.getPositionOfLineAndCharacter(reference.range.startLine, reference.range.startColumn);
    if (isValueDeclarationName(refSource, offset)) {
      nonReferences.push([reference.relPath, reference.range.startLine, reference.range.startColumn]);
      continue;
    }
    const definitions = service.getDefinitionAtPosition(refFile, offset) || [];
    if (definitions.length === 1 && [ts.ScriptElementKind.functionElement, ts.ScriptElementKind.localFunctionElement].includes(definitions[0].kind) &&
        !targetDefinitions.has(key([path.resolve(definitions[0].fileName), definitions[0].textSpan.start]))) {
      otherBinding.push([reference.relPath, reference.range.startLine, reference.range.startColumn]);
    }
  }
  results.push({ path: symbol.relPath, name: symbol.name, symbolId: symbol.id,
    required: expected.size, requiredFound: [...expected].filter(point => actual.has(point)).length,
    fullyEnumerated: page.totalReferences === page.references.length,
    missing: page.totalReferences === page.references.length ? missing : null,
    provenOtherBinding: otherBinding.length, otherBindingLocations: otherBinding,
    provenNonReference: nonReferences.length, nonReferenceLocations: nonReferences,
    unclassified: extra.length - otherBinding.length - nonReferences.length, totalReferences: page.totalReferences });
}
const report = { oracle: `TypeScript ${ts.version} language service references and definitions`,
  sourceFiles: sources.length, candidatesChecked, compilerOptions: options,
  limitations: 'Sampled top-level callables; no project path aliases or external dependencies copied. Compiler definition entries are filtered; reported import/export specifier references are included. Value declaration names are checked independently as non-references. Other function bindings are proven separately; dynamic/unresolved values, parameters and properties remain unclassified.',
  targets: results };
fs.mkdirSync(path.dirname(path.resolve(outputArg)), { recursive: true });
fs.writeFileSync(outputArg, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ targets: results.length, required: results.reduce((n, r) => n + r.required, 0),
  found: results.reduce((n, r) => n + r.requiredFound, 0),
  provenOtherBinding: results.reduce((n, r) => n + r.provenOtherBinding, 0),
  provenNonReference: results.reduce((n, r) => n + (r.provenNonReference || 0), 0),
  unclassified: results.reduce((n, r) => n + r.unclassified, 0) }));
service.dispose();
const failures = results.filter(result => result.error
  || !result.fullyEnumerated || result.missing?.length || result.provenOtherBinding || result.provenNonReference);
if (failOnProvenErrors && (!results.length || failures.length)) {
  console.error(JSON.stringify({ check: 'compiler-reference-locations', failures }));
  process.exitCode = 1;
}
