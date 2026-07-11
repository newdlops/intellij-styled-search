// Entry point for the monaco bundle. esbuild packages this into an IIFE that
// exposes the API under a PRIVATE global name (not \`monaco\`) so we do not
// collide with anything VSCode might eventually put on \`globalThis.monaco\`.
// Our renderer patch looks up \`__ijFindMonacoApi\` first.
// Keep the complete editor contribution set (hover, suggestions, navigation,
// folding, and so on) plus Monarch tokenizers, but leave Monaco's separate
// TS/JSON/CSS/HTML worker services out. Workspace-aware analysis is relayed
// from VS Code's own providers by the preview language-feature bridge.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js';
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution.js';
import { INITIAL, Registry, parseRawGrammar } from 'vscode-textmate';
import {
  createOnigScanner,
  createOnigString,
  loadWASM,
} from 'vscode-oniguruma';
import onigWasm from 'vscode-oniguruma/release/onig.wasm';

const TEXTMATE_MAX_ASSET_BYTES = 8 * 1024 * 1024;
const TEXTMATE_MAX_CLOSURE_BYTES = 32 * 1024 * 1024;
const TEXTMATE_MAX_LINE_LENGTH = 50_000;
const TEXTMATE_LINE_TIME_LIMIT_MS = 20;
const TEXTMATE_HOVER_TOTAL_BUDGET_MS = 32;
const TEXTMATE_MAX_HOVER_ADVANCE_LINES = 2_000;
const TEXTMATE_MAX_RESOLVE_CONCURRENCY = 4;

let textMateOnigLibPromise;
const textMateLanguages = new Map();
const textMateInstalls = new Map();
const textMateDesiredInstalls = new Map();
let textMateInstallSerial = 0;

function ensureTextMateOnigLib() {
  if (!textMateOnigLibPromise) {
    textMateOnigLibPromise = Promise.resolve(loadWASM(onigWasm)).then(() => ({
      createOnigScanner,
      createOnigString,
    }));
  }
  return textMateOnigLibPromise;
}

function cleanTextMateString(value, maxLength = 512) {
  return String(value == null ? '' : value).replace(/[\0\r\n]/g, '').slice(0, maxLength);
}

function cleanStringArray(value, maxItems = 256) {
  if (!Array.isArray(value)) { return []; }
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    const clean = cleanTextMateString(entry);
    if (!clean || seen.has(clean)) { continue; }
    seen.add(clean);
    result.push(clean);
    if (result.length >= maxItems) { break; }
  }
  return result;
}

function ensureMonacoLanguage(languageId, metadata) {
  const id = cleanTextMateString(languageId, 256) || 'plaintext';
  if (monaco.languages.getLanguages().some((language) => language.id === id)) { return id; }
  const descriptor = { id };
  if (metadata && typeof metadata === 'object') {
    const aliases = cleanStringArray(metadata.aliases, 64);
    const extensions = cleanStringArray(metadata.extensions, 256);
    const filenames = cleanStringArray(metadata.filenames, 256);
    if (aliases.length) { descriptor.aliases = aliases; }
    if (extensions.length) { descriptor.extensions = extensions; }
    if (filenames.length) { descriptor.filenames = filenames; }
    const firstLine = cleanTextMateString(metadata.firstLine, 2_000);
    if (firstLine) { descriptor.firstLine = firstLine; }
  }
  monaco.languages.register(descriptor);
  return id;
}

function textMateInjectionScopes(catalog, scopeName) {
  const injections = catalog && catalog.injections;
  if (!injections || typeof injections !== 'object') { return []; }
  const parts = cleanTextMateString(scopeName, 1_000).split('.');
  const result = [];
  for (let length = 1; length <= parts.length; length++) {
    const prefix = parts.slice(0, length).join('.');
    if (!Object.prototype.hasOwnProperty.call(injections, prefix)) { continue; }
    const values = injections[prefix];
    if (!Array.isArray(values)) { continue; }
    for (const value of values) {
      const scope = cleanTextMateString(value, 1_000);
      if (!scope) { continue; }
      result.push(scope);
    }
  }
  return result;
}

function textMateTokenCategory(scopes) {
  const values = Array.isArray(scopes) ? scopes : [];
  for (let index = values.length - 1; index >= 0; index--) {
    const scope = String(values[index] || '').toLowerCase();
    if (!scope) { continue; }
    if (/(?:^|\.)invalid(?:\.|$)/.test(scope)) { return 'invalid'; }
    if (/(?:^|\.)comment(?:\.|$)/.test(scope)) { return 'comment'; }
    if (/(?:^|\.)(?:string|punctuation\.definition\.string)(?:\.|$)/.test(scope)) { return 'string'; }
    if (/(?:^|\.)(?:regexp|regex)(?:\.|$)/.test(scope)) { return 'regexp'; }
    if (/(?:^|\.)constant\.numeric(?:\.|$)/.test(scope)) { return 'number'; }
    if (/(?:^|\.)(?:constant\.character\.escape)(?:\.|$)/.test(scope)) { return 'string.escape'; }
    if (/(?:^|\.)(?:keyword|storage\.modifier)(?:\.|$)/.test(scope)) { return 'keyword'; }
    if (/(?:^|\.)(?:storage\.type|entity\.name\.(?:type|class|struct|interface|enum)|support\.(?:type|class))(?:\.|$)/.test(scope)) {
      return 'type.identifier';
    }
    if (/(?:^|\.)(?:entity\.name\.function|support\.function)(?:\.|$)/.test(scope)) { return 'function'; }
    if (/(?:^|\.)variable\.parameter(?:\.|$)/.test(scope)) { return 'variable.parameter'; }
    if (/(?:^|\.)variable(?:\.|$)/.test(scope)) { return 'variable'; }
    if (/(?:^|\.)entity\.name\.tag(?:\.|$)/.test(scope)) { return 'tag'; }
    if (/(?:^|\.)entity\.other\.attribute-name(?:\.|$)/.test(scope)) { return 'attribute.name'; }
    if (/(?:^|\.)(?:constant|support\.constant)(?:\.|$)/.test(scope)) { return 'constant'; }
  }
  return 'identifier';
}

function limitedAssetResolver(resolveAsset, state) {
  const cache = new Map();
  const queue = [];
  let active = 0;

  function pump() {
    while (active < TEXTMATE_MAX_RESOLVE_CONCURRENCY && queue.length) {
      const task = queue.shift();
      active++;
      Promise.resolve()
        .then(() => resolveAsset(task.assetId))
        .then((asset) => {
          if (!asset || typeof asset.content !== 'string') {
            throw new Error(`TextMate asset ${task.assetId} has no text content`);
          }
          const byteLength = Number.isFinite(asset.byteLength)
            ? Number(asset.byteLength)
            : new TextEncoder().encode(asset.content).byteLength;
          if (byteLength < 0 || byteLength > TEXTMATE_MAX_ASSET_BYTES) {
            throw new Error(`TextMate asset ${task.assetId} exceeds the size limit`);
          }
          if (state.loadedBytes + byteLength > TEXTMATE_MAX_CLOSURE_BYTES) {
            throw new Error('TextMate grammar closure exceeds the size limit');
          }
          state.loadedBytes += byteLength;
          state.loadedAssetCount++;
          task.resolve({
            content: asset.content,
            pathHint: cleanTextMateString(asset.pathHint, 256) || 'grammar.tmLanguage.json',
          });
        }, task.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  return function resolveLimited(assetId) {
    const id = cleanTextMateString(assetId, 1_000);
    if (!id) { return Promise.reject(new Error('Missing TextMate asset id')); }
    let pending = cache.get(id);
    if (!pending) {
      state.assetRequestCount++;
      pending = new Promise((resolve, reject) => {
        queue.push({ assetId: id, resolve, reject });
        pump();
      });
      cache.set(id, pending);
    }
    return pending;
  };
}

function textMateGrammarConfiguration(catalog) {
  const raw = catalog && catalog.configuration && typeof catalog.configuration === 'object'
    ? catalog.configuration
    : {};
  const embeddedLanguages = Object.create(null);
  const rawEmbedded = raw.embeddedLanguages && typeof raw.embeddedLanguages === 'object'
    ? raw.embeddedLanguages
    : {};
  for (const scope of Object.keys(rawEmbedded).slice(0, 2_000)) {
    const embeddedId = ensureMonacoLanguage(rawEmbedded[scope]);
    const encoded = monaco.languages.getEncodedLanguageId(embeddedId);
    if (encoded > 0) { embeddedLanguages[scope] = encoded; }
  }
  const tokenTypes = Object.create(null);
  const tokenTypeValues = { other: 0, comment: 1, string: 2, regex: 3 };
  const rawTokenTypes = raw.tokenTypes && typeof raw.tokenTypes === 'object' ? raw.tokenTypes : {};
  for (const selector of Object.keys(rawTokenTypes).slice(0, 2_000)) {
    const value = tokenTypeValues[String(rawTokenTypes[selector] || '').toLowerCase()];
    if (value !== undefined) { tokenTypes[selector] = value; }
  }
  return {
    embeddedLanguages,
    tokenTypes,
    balancedBracketSelectors: cleanStringArray(raw.balancedBracketScopes, 2_000),
    unbalancedBracketSelectors: cleanStringArray(raw.unbalancedBracketScopes, 2_000),
  };
}

function createTextMateTokensProvider(grammar, state) {
  return {
    getInitialState() { return INITIAL; },
    tokenize(line, previousState) {
      const text = String(line == null ? '' : line);
      if (text.length > TEXTMATE_MAX_LINE_LENGTH) {
        state.skippedLongLines++;
        return { tokens: [{ startIndex: 0, scopes: '' }], endState: previousState || INITIAL };
      }
      const result = grammar.tokenizeLine(text, previousState || INITIAL, TEXTMATE_LINE_TIME_LIMIT_MS);
      state.tokenizeCount++;
      if (result.stoppedEarly) {
        state.stoppedEarlyCount++;
        return { tokens: [{ startIndex: 0, scopes: '' }], endState: previousState || INITIAL };
      }
      return {
        tokens: result.tokens.map((token) => ({
          startIndex: token.startIndex,
          scopes: textMateTokenCategory(token.scopes),
        })),
        endState: result.ruleStack,
      };
    },
  };
}

function disposeTextMateLanguageState(state) {
  if (!state) { return; }
  try { state.providerDisposable && state.providerDisposable.dispose(); } catch (error) {}
  try { state.registry && state.registry.dispose(); } catch (error) {}
  state.status = 'disposed';
}

async function installTextMateGrammarCatalog(catalog, resolveAsset) {
  if (!catalog || typeof catalog !== 'object') { throw new Error('Missing TextMate grammar catalog'); }
  if (typeof resolveAsset !== 'function') { throw new Error('Missing TextMate asset resolver'); }
  if (Number(catalog.protocolVersion) !== 1) { throw new Error('Unsupported TextMate grammar protocol version'); }
  const languageId = cleanTextMateString(catalog.languageId, 256);
  const rootScopeName = cleanTextMateString(catalog.rootScopeName, 1_000);
  const generation = Number(catalog.generation);
  const fingerprint = cleanTextMateString(catalog.fingerprint, 2_000);
  if (!languageId || !rootScopeName || !Number.isFinite(generation) || !fingerprint) {
    throw new Error('Invalid TextMate grammar catalog identity');
  }
  if (!catalog.scopeAssets || !Object.prototype.hasOwnProperty.call(catalog.scopeAssets, rootScopeName) ||
      catalog.scopeAssets[rootScopeName] !== catalog.rootAssetId) {
    throw new Error('TextMate grammar catalog root asset mismatch');
  }
  const current = textMateLanguages.get(languageId);
  if (current && current.status === 'ready' && current.generation === generation && current.fingerprint === fingerprint) {
    return textMateStatus(languageId);
  }
  let desired = textMateDesiredInstalls.get(languageId);
  if (!desired || desired.generation !== generation || desired.fingerprint !== fingerprint) {
    desired = { generation, fingerprint, serial: ++textMateInstallSerial };
    textMateDesiredInstalls.set(languageId, desired);
  }
  const installKey = `${languageId}:${generation}:${fingerprint}:${desired.serial}`;
  const existingInstall = textMateInstalls.get(installKey);
  if (existingInstall) { return existingInstall; }

  const install = (async () => {
    await ensureTextMateOnigLib();
    ensureMonacoLanguage(languageId, catalog.language);
    const state = {
      languageId,
      rootScopeName,
      generation,
      fingerprint,
      installSerial: desired.serial,
      status: 'loading',
      error: '',
      registry: null,
      grammar: null,
      providerDisposable: null,
      modelCaches: new WeakMap(),
      loadedBytes: 0,
      loadedAssetCount: 0,
      assetRequestCount: 0,
      tokenizeCount: 0,
      stoppedEarlyCount: 0,
      skippedLongLines: 0,
    };
    const resolveLimited = limitedAssetResolver(resolveAsset, state);
    const scopeAssets = catalog.scopeAssets && typeof catalog.scopeAssets === 'object'
      ? catalog.scopeAssets
      : {};
    const registry = new Registry({
      onigLib: ensureTextMateOnigLib(),
      loadGrammar: async (scopeName) => {
        const assetId = Object.prototype.hasOwnProperty.call(scopeAssets, scopeName)
          ? cleanTextMateString(scopeAssets[scopeName], 1_000)
          : '';
        if (!assetId) { return null; }
        const asset = await resolveLimited(assetId);
        return parseRawGrammar(asset.content, asset.pathHint);
      },
      getInjections: (scopeName) => textMateInjectionScopes(catalog, scopeName),
    });
    state.registry = registry;
    try {
      const encodedLanguageId = monaco.languages.getEncodedLanguageId(languageId);
      const grammar = await registry.loadGrammarWithConfiguration(
        rootScopeName,
        encodedLanguageId,
        textMateGrammarConfiguration(catalog),
      );
      if (!grammar) { throw new Error(`TextMate grammar ${rootScopeName} could not be loaded`); }
      const wanted = textMateDesiredInstalls.get(languageId);
      if (!wanted || wanted.serial !== state.installSerial || wanted.generation !== generation ||
          wanted.fingerprint !== fingerprint) {
        try { registry.dispose(); } catch (disposeError) {}
        state.status = 'superseded';
        return {
          status: 'superseded',
          languageId,
          rootScopeName,
          generation,
          fingerprint,
        };
      }
      state.grammar = grammar;
      state.providerDisposable = monaco.languages.setTokensProvider(
        languageId,
        createTextMateTokensProvider(grammar, state),
      );
      state.status = 'ready';
      const replaced = textMateLanguages.get(languageId);
      textMateLanguages.set(languageId, state);
      if (replaced && replaced !== state) { disposeTextMateLanguageState(replaced); }
      return textMateStatus(languageId);
    } catch (error) {
      state.status = 'error';
      state.error = cleanTextMateString(error && error.message || error, 2_000);
      try { registry.dispose(); } catch (disposeError) {}
      throw error;
    }
  })().finally(() => {
    if (textMateInstalls.get(installKey) === install) { textMateInstalls.delete(installKey); }
  });
  textMateInstalls.set(installKey, install);
  return install;
}

function textMateStatus(languageId) {
  const state = textMateLanguages.get(String(languageId || ''));
  if (!state) { return { status: 'unavailable', languageId: String(languageId || '') }; }
  const desired = textMateDesiredInstalls.get(state.languageId);
  const stale = desired && (desired.generation !== state.generation || desired.fingerprint !== state.fingerprint);
  return {
    status: stale ? 'stale' : state.status,
    languageId: state.languageId,
    rootScopeName: state.rootScopeName,
    generation: state.generation,
    fingerprint: state.fingerprint,
    error: state.error || '',
    loadedAssetCount: state.loadedAssetCount,
    assetRequestCount: state.assetRequestCount,
    tokenizeCount: state.tokenizeCount,
    stoppedEarlyCount: state.stoppedEarlyCount,
    skippedLongLines: state.skippedLongLines,
  };
}

function removeTextMateGrammar(languageId) {
  const id = cleanTextMateString(languageId, 256);
  if (!id) { return { status: 'unavailable', languageId: '' }; }
  textMateDesiredInstalls.set(id, {
    generation: -1,
    fingerprint: `removed:${++textMateInstallSerial}`,
    serial: textMateInstallSerial,
  });
  const current = textMateLanguages.get(id);
  textMateLanguages.delete(id);
  if (current) { disposeTextMateLanguageState(current); }
  return { status: 'unavailable', languageId: id };
}

function textMateModelCache(state, model) {
  const version = model && typeof model.getVersionId === 'function' ? model.getVersionId() : 0;
  let cache = state.modelCaches.get(model);
  if (!cache || cache.version !== version) {
    cache = { version, states: [INITIAL], tokenLines: new Map() };
    state.modelCaches.set(model, cache);
  }
  return cache;
}

function textMateTokenAtPosition(languageId, model, position) {
  const state = textMateLanguages.get(String(languageId || ''));
  if (!state || state.status !== 'ready' || !state.grammar || !model || !position) { return null; }
  const lineNumber = Math.max(1, Math.floor(Number(position.lineNumber) || 1));
  const column = Math.max(1, Math.floor(Number(position.column) || 1));
  const cache = textMateModelCache(state, model);
  let tokens = cache.tokenLines.get(lineNumber);
  if (!tokens && cache.states[lineNumber - 1]) {
    let line;
    try { line = String(model.getLineContent(lineNumber)); } catch (error) { return null; }
    if (line.length > TEXTMATE_MAX_LINE_LENGTH) { return null; }
    const result = state.grammar.tokenizeLine(
      line,
      cache.states[lineNumber - 1],
      TEXTMATE_LINE_TIME_LIMIT_MS,
    );
    state.tokenizeCount++;
    if (result.stoppedEarly) {
      state.stoppedEarlyCount++;
      return null;
    }
    tokens = result.tokens;
    cache.states[lineNumber] = result.ruleStack;
    cache.tokenLines.set(lineNumber, tokens);
  }
  if (!tokens) {
    let nextLine = cache.states.length;
    if (lineNumber - nextLine + 1 > TEXTMATE_MAX_HOVER_ADVANCE_LINES) { return null; }
    const startedAt = performance.now();
    while (nextLine <= lineNumber) {
      if (performance.now() - startedAt > TEXTMATE_HOVER_TOTAL_BUDGET_MS) { return null; }
      let line;
      try { line = String(model.getLineContent(nextLine)); } catch (error) { return null; }
      if (line.length > TEXTMATE_MAX_LINE_LENGTH) { return null; }
      const previousState = cache.states[nextLine - 1] || INITIAL;
      const result = state.grammar.tokenizeLine(line, previousState, TEXTMATE_LINE_TIME_LIMIT_MS);
      state.tokenizeCount++;
      if (result.stoppedEarly) {
        state.stoppedEarlyCount++;
        return null;
      }
      cache.states[nextLine] = result.ruleStack;
      if (nextLine === lineNumber) {
        tokens = result.tokens;
        cache.tokenLines.set(lineNumber, tokens);
      }
      nextLine++;
    }
  }
  while (cache.tokenLines.size > 64) {
    cache.tokenLines.delete(cache.tokenLines.keys().next().value);
  }
  if (!Array.isArray(tokens)) { return null; }
  let lineLength = 0;
  try { lineLength = model.getLineContent(lineNumber).length; } catch (error) {}
  const offset = Math.max(0, Math.min(lineLength, column - 1));
  for (const token of tokens) {
    if (offset < token.startIndex || offset >= token.endIndex) { continue; }
    return {
      scopes: token.scopes.slice(),
      type: textMateTokenCategory(token.scopes),
      startColumn: token.startIndex + 1,
      endColumn: Math.max(token.startIndex + 1, token.endIndex + 1),
    };
  }
  return null;
}

const textMateApi = {
  installGrammarCatalog: installTextMateGrammarCatalog,
  removeGrammar: removeTextMateGrammar,
  getStatus: textMateStatus,
  getTokenAtPosition: textMateTokenAtPosition,
};

function registerJsonLexicalLanguage(id, extensions, allowComments) {
  if (!monaco.languages.getLanguages().some((language) => language.id === id)) {
    monaco.languages.register({ id, extensions, aliases: [id.toUpperCase(), id] });
  }
  monaco.languages.setLanguageConfiguration(id, {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    comments: allowComments ? { lineComment: '//', blockComment: ['/*', '*/'] } : undefined,
  });
  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: 'invalid',
    tokenPostfix: `.${id}`,
    brackets: [
      { open: '{', close: '}', token: 'delimiter.bracket' },
      { open: '[', close: ']', token: 'delimiter.array' },
    ],
    tokenizer: {
      root: [
        [/[{}\[\]]/, '@brackets'],
        [/[:,]/, 'delimiter'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value'],
        [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
        [/\/\*/, { token: allowComments ? 'comment' : 'invalid', next: '@comment' }],
        [/\/\/.*$/, allowComments ? 'comment' : 'invalid'],
        [/\s+/, 'white'],
      ],
      comment: [
        [/[^/*]+/, allowComments ? 'comment' : 'invalid'],
        [/\*\//, { token: allowComments ? 'comment' : 'invalid', next: '@pop' }],
        [/[/*]/, allowComments ? 'comment' : 'invalid'],
      ],
    },
  });
}

registerJsonLexicalLanguage('json', ['.json'], false);
registerJsonLexicalLanguage('jsonc', ['.jsonc'], true);

if (typeof globalThis !== 'undefined') {
  globalThis.__ijFindMonacoApi = monaco;
  globalThis.__ijFindTextMateApi = textMateApi;
  globalThis.__ijFindMonacoBundleVersion = 6;
}
