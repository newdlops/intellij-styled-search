import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import type { SearchForTestsResult } from '../../search';
import { ensureRipgrepInstalled, findRipgrepPath } from '../../rgSearch';
import { decodeTextBytes, hasBinaryFileExtension, looksBinaryContent } from '../../textFiles';

const EXTENSION_ID = 'newdlops.intellij-styled-search';
const CAPTAIN_WORKSPACE_SUFFIX = path.join('captain2', 'captain');
const ZOEKT_SCHEMA_VERSION = 17;
const SEARCH_INDEX_BUDGET_MS = 8_000;
const SEARCH_INDEX_SEED_TIMEOUT_MS = 120_000;
const GRAPH_INDEX_BUDGET_MS = 8_000;
const TIMEOUT_GRACE_MS = 5_000;
const MAX_FILE_SIZE_BYTES = 1_048_576;
const RANDOM_QUERY_COUNT = 1_000;
const RANDOM_CANDIDATE_COUNT = 4_000;
const RANDOM_ACCURACY_TIMEOUT_MS = 600_000;
const SEARCH_SPEED_QUERY_COUNT = 100;
const SEARCH_SPEED_P95_BUDGET_MS = 150;
const SEARCH_SPEED_QUERY_TIMEOUT_MS = 5_000;
const SEARCH_SPEED_TEST_TIMEOUT_MS = 600_000;
const INCREMENTAL_UPDATE_BUDGET_MS = 1_000;
const INCREMENTAL_UPDATE_PROCESS_TIMEOUT_MS = 30_000;
const INCREMENTAL_ASSERT_SEARCH_TIMEOUT_MS = 20_000;
const UI_RESPONSE_BUDGET_MS = 10;
const UI_RESPONSE_TEST_TIMEOUT_MS = 20_000;
const MAX_RANDOM_EXPECTED_MATCHES = 1;
const RANDOM_SEARCH_BATCH_SIZE = 50;
const LONG_QUERY_LENGTH = 10_000;
const RG_TIMEOUT_MS = 120_000;
const CAPTAIN_QUERY_TERMS_FALLBACK_LITERAL = 'rn GetResultValue(self.basic_auth.get().SerializeToStr';

type AccuracyFixture = {
  queries: string[];
  expectedByQuery: Map<string, Set<string>>;
  longQuery: string;
  longSourceRelPath: string;
};

let accuracyFixturePromise: Promise<AccuracyFixture> | undefined;

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not registered`);
  const api = await ext.activate();
  assert.ok(api, 'extension activate() returned no api');
  return api;
}

async function ensureRendererInjectionForUi(overlay: ExtensionTestApi['overlay']): Promise<string> {
  try {
    await overlay.awaitInjection();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'expected captain workspace folder');
  return folder.uri.fsPath;
}

function assertCaptainWorkspace(root: string): void {
  const normalized = path.resolve(root);
  assert.ok(
    normalized.endsWith(CAPTAIN_WORKSPACE_SUFFIX),
    `expected E2E workspace to be project/captain2/captain, got ${normalized}`,
  );
}

function formatEngineRoute(result: SearchForTestsResult): string {
  return [
    `requested=${result.requestedEngine}`,
    `effective=${result.effectiveEngine}`,
    `fallback=${result.fallbackReason ?? 'none'}`,
  ].join(' ');
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

async function getRipgrepForTests(): Promise<string> {
  let rgPath = findRipgrepPath();
  if (!rgPath) {
    rgPath = await ensureRipgrepInstalled();
  }
  assert.ok(rgPath, 'ripgrep binary not found for captain accuracy comparison');
  return rgPath;
}

function getZoekRsBinaryForTests(baseName = 'zoek-rs'): string {
  const exe = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  const candidates = [
    path.join(process.cwd(), 'target', 'release', exe),
    path.join(process.cwd(), 'target', 'debug', exe),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(binary, `${baseName} binary not found; tried ${candidates.join(', ')}`);
  return binary;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) { return; }
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(
        `${path.basename(command)} timed out after ${timeoutMs}ms; ` +
        `stderr=${stderr.split(/\r?\n/).slice(-8).join(' | ')}`,
      ));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function normalizeRelPath(root: string, value: string): string {
  const fsPath = path.isAbsolute(value) ? value : path.join(root, value);
  let rel = path.relative(root, fsPath).replace(/\\/g, '/');
  if (rel.startsWith('../')) {
    rel = value.replace(/\\/g, '/');
  }
  if (rel.startsWith('./')) {
    rel = rel.slice(2);
  }
  return rel;
}

function rgText(value: { text?: string; bytes?: string } | undefined): string | null {
  if (!value) { return null; }
  if (typeof value.text === 'string') { return value.text; }
  if (typeof value.bytes === 'string') {
    return Buffer.from(value.bytes, 'base64').toString('utf8');
  }
  return null;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listRipgrepFiles(root: string, rgPath: string): Promise<string[]> {
  const { stdout, stderr, code } = await runProcess(
    rgPath,
    [
      '--files',
      '--hidden',
      '--no-ignore',
      '--no-ignore-parent',
      '--glob', '!.zoek-rs/**',
      '--glob', '!.zoekt-rs/**',
      '.',
    ],
    root,
    RG_TIMEOUT_MS,
  );
  assert.ok(code === 0 || code === 1, `rg --files failed code=${code} stderr=${stderr.slice(0, 500)}`);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeRelPath(root, line));
}

async function readIndexedText(root: string, relPath: string): Promise<string | null> {
  if (relPath.split('/').some((part) => part === '.zoek-rs' || part === '.zoekt-rs')) {
    return null;
  }
  const fsPath = path.join(root, relPath);
  if (hasBinaryFileExtension(fsPath)) {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(fsPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_SIZE_BYTES) {
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(fsPath);
  } catch {
    return null;
  }
  if (looksBinaryContent(bytes)) {
    return null;
  }
  return decodeTextBytes(bytes);
}

function chooseNeedle(
  text: string,
  rng: () => number,
  seen: Set<string>,
  seenLineTexts: Set<string>,
): string | null {
  const lines = text.split('\n');
  for (let attempt = 0; attempt < 32; attempt++) {
    let line = lines[randomInt(rng, lines.length)] ?? '';
    if (line.endsWith('\r')) { line = line.slice(0, -1); }
    if (line.length < 72 || line.length > 2048) { continue; }
    const lineIdentity = line.trim();
    if (!lineIdentity || seenLineTexts.has(lineIdentity)) { continue; }
    const len = 48 + randomInt(rng, 17);
    if (line.length < len) { continue; }
    const start = randomInt(rng, line.length - len + 1);
    const query = line.slice(start, start + len);
    if (query !== query.trim()) { continue; }
    if (!/[A-Za-z0-9_]/.test(query)) { continue; }
    if (!/^[\x20-\x7e]+$/.test(query)) { continue; }
    if (seen.has(query)) { continue; }
    seen.add(query);
    seenLineTexts.add(lineIdentity);
    return query;
  }
  return null;
}

function chooseLongQuery(text: string, rng: () => number): string | null {
  if (text.length < LONG_QUERY_LENGTH) {
    return null;
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const start = randomInt(rng, text.length - LONG_QUERY_LENGTH + 1);
    const query = text.slice(start, start + LONG_QUERY_LENGTH);
    if (query.length !== LONG_QUERY_LENGTH || query.includes('\0')) { continue; }
    let searchable = 0;
    for (let i = 0; i < query.length; i++) {
      const c = query.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) {
        searchable++;
      }
    }
    if (searchable / query.length >= 0.98) {
      return query;
    }
  }
  return null;
}

async function collectAccuracyCandidates(
  root: string,
  files: string[],
): Promise<{ queries: string[]; longQuery: string; longSourceRelPath: string }> {
  const rng = makeRng(0x51a7c0de);
  const queries: string[] = [];
  const seen = new Set<string>();
  const seenLineTexts = new Set<string>();
  let longQuery = '';
  let longSourceRelPath = '';
  const maxAttempts = Math.min(files.length * 3, 60_000);
  for (let attempt = 0; attempt < maxAttempts && (queries.length < RANDOM_CANDIDATE_COUNT || !longQuery); attempt++) {
    const relPath = files[randomInt(rng, files.length)];
    const text = await readIndexedText(root, relPath);
    if (!text) { continue; }
    if (!longQuery) {
      const candidate = chooseLongQuery(text, rng);
      if (candidate) {
        longQuery = candidate;
        longSourceRelPath = relPath;
      }
    }
    for (let i = 0; i < 4 && queries.length < RANDOM_CANDIDATE_COUNT; i++) {
      const query = chooseNeedle(text, rng, seen, seenLineTexts);
      if (query) {
        queries.push(query);
      }
    }
  }
  assert.ok(
    queries.length >= RANDOM_CANDIDATE_COUNT,
    `only collected ${queries.length}/${RANDOM_CANDIDATE_COUNT} random query candidates`,
  );
  assert.strictEqual(longQuery.length, LONG_QUERY_LENGTH, 'failed to collect a 10000char query candidate');
  return { queries, longQuery, longSourceRelPath };
}

async function rgBaselineForPatterns(
  root: string,
  rgPath: string,
  queries: string[],
): Promise<Map<string, Set<string>>> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ijss-captain-rg-'));
  const patternFile = path.join(tmpDir, 'patterns.txt');
  const expected = new Map<string, Set<string>>();
  const queriesByPrefix = new Map<string, string[]>();
  for (const query of queries) {
    expected.set(query, new Set<string>());
    const prefix = query.slice(0, 12);
    const bucket = queriesByPrefix.get(prefix);
    if (bucket) {
      bucket.push(query);
    } else {
      queriesByPrefix.set(prefix, [query]);
    }
  }
  try {
    await fs.promises.writeFile(patternFile, `${queries.join('\n')}\n`, 'utf8');
    const { stdout, stderr, code } = await runProcess(
      rgPath,
      [
        '--json',
        '--hidden',
        '--no-messages',
        '--max-filesize', String(MAX_FILE_SIZE_BYTES),
        '--no-ignore-parent',
        '--fixed-strings',
        '--case-sensitive',
        '--no-ignore',
        '--glob', '!.zoek-rs/**',
        '--glob', '!.zoekt-rs/**',
        '-f', patternFile,
        '.',
      ],
      root,
      RG_TIMEOUT_MS,
    );
    assert.ok(code === 0 || code === 1, `rg baseline failed code=${code} stderr=${stderr.slice(0, 500)}`);
    let processedMatches = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) { continue; }
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'match') { continue; }
      const relPath = normalizeRelPath(root, rgText(event.data?.path) ?? '');
      const lineKey = `${relPath}:${Math.max(0, (event.data?.line_number ?? 1) - 1)}`;
      const lineText = rgText(event.data?.lines) ?? '';
      const seenPrefixes = new Set<string>();
      for (let idx = 0; idx <= lineText.length - 12; idx++) {
        const prefix = lineText.slice(idx, idx + 12);
        if (seenPrefixes.has(prefix)) { continue; }
        const prefixQueries = queriesByPrefix.get(prefix);
        if (!prefixQueries) { continue; }
        seenPrefixes.add(prefix);
        for (const query of prefixQueries) {
          if (lineText.includes(query)) {
            expected.get(query)!.add(lineKey);
          }
        }
      }
      processedMatches++;
      if (processedMatches % 100 === 0) {
        await yieldToEventLoop();
      }
    }
    return expected;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function rgBaselineForSingleQuery(
  root: string,
  rgPath: string,
  query: string,
): Promise<Set<string>> {
  const { stdout, stderr, code } = await runProcess(
    rgPath,
    [
      '--json',
      '--hidden',
      '--no-messages',
      '--max-filesize', String(MAX_FILE_SIZE_BYTES),
      '--no-ignore-parent',
      '-U',
      '--fixed-strings',
      '--case-sensitive',
      '--no-ignore',
      '--glob', '!.zoek-rs/**',
      '--glob', '!.zoekt-rs/**',
      '-e', query,
      '.',
    ],
    root,
    RG_TIMEOUT_MS,
  );
  assert.ok(code === 0 || code === 1, `rg 10000char baseline failed code=${code} stderr=${stderr.slice(0, 500)}`);
  const expected = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) { continue; }
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'match') { continue; }
    const relPath = normalizeRelPath(root, rgText(event.data?.path) ?? '');
    expected.add(`${relPath}:${Math.max(0, (event.data?.line_number ?? 1) - 1)}`);
  }
  return expected;
}

function resultLineSet(result: SearchForTestsResult): Set<string> {
  const out = new Set<string>();
  for (const file of result.matches) {
    for (const match of file.matches) {
      out.add(`${file.relPath.replace(/\\/g, '/')}:${match.line}`);
    }
  }
  return out;
}

async function resultLineSetsByQuery(
  root: string,
  result: SearchForTestsResult,
  queries: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const fileLines = new Map<string, string[]>();
  for (const file of result.matches) {
    const relPath = file.relPath.replace(/\\/g, '/');
    let lines = fileLines.get(relPath);
    if (!lines) {
      const text = await readIndexedText(root, relPath);
      lines = (text ?? '').split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
      fileLines.set(relPath, lines);
    }
    for (const match of file.matches) {
      const line = lines[match.line] ?? '';
      const key = `${relPath}:${match.line}`;
      for (const query of queries) {
        if (!line.includes(query)) { continue; }
        let set = out.get(query);
        if (!set) {
          set = new Set<string>();
          out.set(query, set);
        }
        set.add(key);
      }
    }
  }
  return out;
}

function assertSameLineSet(actual: Set<string>, expected: Set<string>, label: string): void {
  const missing = [...expected].filter((entry) => !actual.has(entry)).slice(0, 8);
  const extra = [...actual].filter((entry) => !expected.has(entry)).slice(0, 8);
  assert.deepStrictEqual(
    { size: actual.size, missing, extra },
    { size: expected.size, missing: [], extra: [] },
    label,
  );
}

function percentile(sortedValues: number[], percentileValue: number): number {
  assert.ok(sortedValues.length > 0, 'cannot compute percentile for empty sample');
  const index = Math.max(
    0,
    Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * percentileValue) - 1),
  );
  return sortedValues[index];
}

function assertTimingsWithin(label: string, timings: number[], budgetMs: number): void {
  assert.ok(timings.length > 0, `${label} should record timings`);
  const sorted = [...timings].sort((a, b) => a - b);
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const p95Ms = percentile(sorted, 0.95);
  const avgMs = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  assert.ok(
    maxMs <= budgetMs,
    `${label} max should stay <= ${budgetMs}ms; timings=${timings.join(',')}ms max=${maxMs}ms p95=${p95Ms}ms avg=${Math.round(avgMs)}ms`,
  );
  assert.ok(
    p95Ms <= budgetMs,
    `${label} p95 should stay <= ${budgetMs}ms; timings=${timings.join(',')}ms max=${maxMs}ms p95=${p95Ms}ms avg=${Math.round(avgMs)}ms`,
  );
}

async function runZoektSearchForSpeed(
  root: string,
  query: string,
): Promise<{ elapsedMs: number; totalFilesScanned: number; totalFilesMatched: number; totalMatches: number }> {
  const binary = getZoekRsBinaryForTests();
  const started = Date.now();
  const result = await runProcess(
    binary,
    [
      'search',
      root,
      query,
      '--case-sensitive',
      '--limit',
      '2000',
      '--offset',
      '0',
    ],
    process.cwd(),
    INCREMENTAL_ASSERT_SEARCH_TIMEOUT_MS,
  );
  const elapsedMs = Date.now() - started;
  assert.strictEqual(result.code, 0, `zoek-rs speed search failed code=${result.code} stderr=${result.stderr.slice(-1000)}`);
  const response = JSON.parse(result.stdout.trim()) as {
    ok?: boolean;
    type?: string;
    totalFilesScanned?: number;
    totalFilesMatched?: number;
    totalMatches?: number;
    files?: unknown[];
  };
  assert.strictEqual(response.type, 'search');
  assert.strictEqual(response.ok, true);
  assert.ok((response.totalMatches ?? 0) > 0, `speed search returned no matches for query=${JSON.stringify(query)}`);
  return {
    elapsedMs,
    totalFilesScanned: response.totalFilesScanned ?? -1,
    totalFilesMatched: response.totalFilesMatched ?? -1,
    totalMatches: response.totalMatches ?? -1,
  };
}

async function runZoektSearchJson(
  root: string,
  query: string,
  pathRegex?: string,
): Promise<{ totalFilesMatched: number; totalMatches: number; files: Array<{ relPath: string }> }> {
  const binary = getZoekRsBinaryForTests();
  const pathArgs = pathRegex ? ['--path-regex', pathRegex] : [];
  const result = await runProcess(
    binary,
    [
      'search',
      root,
      query,
      '--case-sensitive',
      '--limit',
      '20',
      '--offset',
      '0',
      ...pathArgs,
    ],
    process.cwd(),
    SEARCH_SPEED_QUERY_TIMEOUT_MS,
  );
  assert.strictEqual(result.code, 0, `zoek-rs search failed code=${result.code} stderr=${result.stderr.slice(-1000)}`);
  const response = JSON.parse(result.stdout.trim()) as {
    ok?: boolean;
    type?: string;
    totalFilesMatched?: number;
    totalMatches?: number;
    files?: Array<{ relPath: string }>;
  };
  assert.strictEqual(response.type, 'search');
  assert.strictEqual(response.ok, true);
  return {
    totalFilesMatched: response.totalFilesMatched ?? 0,
    totalMatches: response.totalMatches ?? 0,
    files: response.files ?? [],
  };
}

async function runZoektUpdateWithinBudget(
  root: string,
  args: string[],
  label: string,
): Promise<number> {
  const binary = getZoekRsBinaryForTests();
  const started = Date.now();
  const result = await runProcess(
    binary,
    ['update', root, ...args],
    process.cwd(),
    INCREMENTAL_UPDATE_PROCESS_TIMEOUT_MS,
  );
  const elapsedMs = Date.now() - started;
  assert.strictEqual(result.code, 0, `${label} update failed code=${result.code} stderr=${result.stderr.slice(-1000)}`);
  const response = JSON.parse(result.stdout.trim()) as { ok?: boolean; type?: string; elapsedMs?: number };
  assert.strictEqual(response.type, 'update');
  assert.strictEqual(response.ok, true);
  const engineElapsedMs = response.elapsedMs ?? elapsedMs;
  assert.ok(
    engineElapsedMs <= INCREMENTAL_UPDATE_BUDGET_MS,
    `${label} update took ${engineElapsedMs}ms inside zoek-rs; process wall=${elapsedMs}ms`,
  );
  return engineElapsedMs;
}

function exactRelPathRegex(relPath: string): string {
  return `^${relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function assertQueryRelPaths(
  root: string,
  query: string,
  expected: string[],
  label: string,
  pathRegex?: string,
): Promise<void> {
  const result = await runZoektSearchJson(root, query, pathRegex);
  assert.deepStrictEqual(
    result.files.map((file) => file.relPath).sort(),
    [...expected].sort(),
    label,
  );
}

function literalsMayOverlap(left: string, right: string): boolean {
  if (left.includes(right) || right.includes(left)) {
    return true;
  }
  const max = Math.min(left.length, right.length);
  for (let len = max; len >= 24; len--) {
    if (left.endsWith(right.slice(0, len)) || right.endsWith(left.slice(0, len))) {
      return true;
    }
  }
  return false;
}

async function loadAccuracyFixture(root: string, rgPath: string): Promise<AccuracyFixture> {
  if (!accuracyFixturePromise) {
    accuracyFixturePromise = (async () => {
      const files = await listRipgrepFiles(root, rgPath);
      assert.ok(files.length > 0, 'rg returned no captain files');
      const collected = await collectAccuracyCandidates(root, files);
      const roughExpectedByQuery = await rgBaselineForPatterns(root, rgPath, collected.queries);
      const queries: string[] = [];
      for (const query of collected.queries) {
        const count = roughExpectedByQuery.get(query)?.size ?? 0;
        if (count <= 0 || count > MAX_RANDOM_EXPECTED_MATCHES) { continue; }
        if (queries.some((selected) => literalsMayOverlap(selected, query))) { continue; }
        queries.push(query);
        if (queries.length >= RANDOM_QUERY_COUNT) { break; }
      }
      assert.strictEqual(
        queries.length,
        RANDOM_QUERY_COUNT,
        `only ${queries.length}/${RANDOM_QUERY_COUNT} random candidates had usable rg baselines`,
      );
      const expectedByQuery = await rgBaselineForPatterns(root, rgPath, queries);
      for (const query of queries) {
        const count = expectedByQuery.get(query)?.size ?? 0;
        assert.ok(
          count > 0 && count <= MAX_RANDOM_EXPECTED_MATCHES,
          `selected query lost usable rg baseline after final rg pass count=${count} query=${JSON.stringify(query)}`,
        );
      }
      return {
        queries,
        expectedByQuery,
        longQuery: collected.longQuery,
        longSourceRelPath: collected.longSourceRelPath,
      };
    })();
  }
  return accuracyFixturePromise;
}

let captainSearchRebuildElapsedMs: number | undefined;

async function hasCleanSearchIndex(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(root, '.zoek-rs', 'manifest.json'), 'utf8')) as {
      schemaVersion?: unknown;
    };
    if (manifest.schemaVersion !== ZOEKT_SCHEMA_VERSION) {
      return false;
    }
    const overlay = await fs.promises.readFile(path.join(root, '.zoek-rs', 'hot-overlay.json'), 'utf8');
    return overlay.includes('"entries":[]');
  } catch {
    return false;
  }
}

async function ensureCleanSearchIndexSeed(root: string, binary: string): Promise<void> {
  if (await hasCleanSearchIndex(root)) {
    return;
  }
  const result = await runProcess(binary, [root, '--force'], process.cwd(), SEARCH_INDEX_SEED_TIMEOUT_MS);
  assert.strictEqual(
    result.code,
    0,
    `failed to seed captain search index before 4s reuse gate code=${result.code} stderr=${result.stderr.slice(-1000)}`,
  );
}

async function runCaptainSearchRebuildGate(): Promise<number> {
  const root = workspaceRoot();
  assertCaptainWorkspace(root);
  const binary = getZoekRsBinaryForTests('ijss-rebuild');
  await ensureCleanSearchIndexSeed(root, binary);
  const started = Date.now();
  const result = await runProcess(
    binary,
    [root, '--force'],
    process.cwd(),
    SEARCH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS,
  );
  const elapsedMs = Date.now() - started;
  assert.strictEqual(result.code, 0, `ijss-rebuild failed code=${result.code} stderr=${result.stderr.slice(-1000)}`);
  assert.ok(elapsedMs <= SEARCH_INDEX_BUDGET_MS, `captain search index clean reuse took ${elapsedMs}ms`);
  const response = JSON.parse(result.stdout.trim()) as { ok?: boolean; type?: string; stats?: { indexedFiles?: number; shardCount?: number } };
  assert.strictEqual(response.type, 'index');
  assert.strictEqual(response.ok, true);
  assert.ok((response.stats?.indexedFiles ?? 0) > 0, 'captain search index rebuild indexed no files');
  assert.ok((response.stats?.shardCount ?? 0) > 0, 'captain search index rebuild wrote no shards');

  const api = await getApi();
  const runtime = (api.overlay as any).zoektRuntime as {
    getSearchReadiness: () => Promise<{ ready: boolean; reason?: string }>;
  };
  const readiness = await runtime.getSearchReadiness();
  assert.deepStrictEqual(readiness, { ready: true });

  const smoke = await api.overlay.searchForTestsDetailed({
    query: 'DJANGO_SETTINGS_MODULE',
    caseSensitive: true,
    wholeWord: false,
    useRegex: false,
    ignoreConfiguredExcludes: true,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  });
  assert.strictEqual(smoke.effectiveEngine, 'zoekt', `expected zoekt smoke search; ${formatEngineRoute(smoke)}`);
  assert.ok(
    smoke.matches.some((match) => match.relPath === 'manage.py'),
    `expected manage.py in captain smoke results; got ${smoke.matches.slice(0, 10).map((m) => m.relPath).join(', ')}`,
  );
  console.log(`[captain-e2e] search index clean reuse ${elapsedMs}ms`);
  return elapsedMs;
}

suite('Captain E2E index gates', () => {
  suiteSetup(function () {
    // Every test in this suite asserts that the workspace is captain2/captain.
    // When the suite ships with the rest of the runtime test files (e.g. on
    // the fixture workspace), skip the whole suite cleanly instead of
    // failing every assertion.
    const folder = vscode.workspace.workspaceFolders?.[0];
    const normalized = folder ? path.resolve(folder.uri.fsPath) : '';
    if (!normalized.endsWith(CAPTAIN_WORKSPACE_SUFFIX)) {
      this.skip();
    }
  });

  test('opens the captain workspace before running expensive gates', function () {
    this.timeout(5_000);
    assertCaptainWorkspace(workspaceRoot());
  });

  test('rust-native call graph rebuild warms the captain workspace before search gate', async function () {
    this.timeout(GRAPH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS);
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorBackend = cfg.inspect<string>('callGraphBackend');
    await cfg.update('callGraphBackend', 'rust-native', vscode.ConfigurationTarget.Workspace);
    try {
      const started = Date.now();
      const snapshot = await api.callGraph.rebuild(undefined, undefined, { force: true });
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs <= GRAPH_INDEX_BUDGET_MS, `captain rust-native graph warm rebuild took ${elapsedMs}ms`);
      assert.ok(snapshot.stats.fileCount > 0, 'captain graph warm rebuild indexed no files');
      assert.ok(snapshot.stats.symbolCount > 0, 'captain graph warm rebuild indexed no symbols');
      assert.ok(snapshot.stats.referenceCount > 0, 'captain graph warm rebuild indexed no references');
      console.log(`[captain-e2e] graph warm rebuild ${elapsedMs}ms`);
    } finally {
      await cfg.update('callGraphBackend', priorBackend?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('search index reuses the clean full captain workspace within 8 seconds before renderer probes', async function () {
    this.timeout(SEARCH_INDEX_SEED_TIMEOUT_MS + SEARCH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS);
    captainSearchRebuildElapsedMs = await runCaptainSearchRebuildGate();
  });

  test('captain search result clicks switch preview within 10ms after warmup', async function () {
    this.timeout(UI_RESPONSE_TEST_TIMEOUT_MS);
    const api = await getApi();
    const { overlay } = api;
    const injectionError = await ensureRendererInjectionForUi(overlay);
    if (injectionError) {
      console.log(`[captain-e2e] skipping UI latency probe; renderer injection unavailable: ${injectionError}`);
      this.skip();
      return;
    }
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const managePath = path.join(root, 'manage.py');
    const urlsPath = path.join(root, 'zuzu', 'app', 'urls.py');
    assert.ok(fs.existsSync(managePath), `expected captain fixture file ${managePath}`);
    assert.ok(fs.existsSync(urlsPath), `expected captain fixture file ${urlsPath}`);
    const manageUri = vscode.Uri.file(managePath).toString();
    const urlsUri = vscode.Uri.file(urlsPath).toString();

    await overlay.show('CaptainPreviewClickProbe', { forceLiteral: true, suppressSearch: true });
    try {
      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var first = ${JSON.stringify(manageUri)};
          var second = ${JSON.stringify(urlsUri)};
          var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
          window.__ijFindDisableMonacoProbes = true;
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'CaptainPreviewClickProbe';
          }) || document.querySelector('.ij-find-overlay.visible');
          var targetSrc = root ? root.getAttribute('data-ij-find-src') || '' : '';
          var q = root ? root.querySelector('.ij-find-query') : document.querySelector('.ij-find-query');
          if (q) { q.value = ''; }
          if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(targetSrc); }
          window.__ijFindOnMessage({ type: 'results:start', searchId: 1940, __targetSrc: targetSrc });
          var firstMatches = [];
          var secondMatches = [];
          for (var i = 0; i < 16; i++) {
            firstMatches.push({
              line: i,
              preview: 'captain manage preview row ' + i,
              ranges: [{ start: 8, end: 14 }]
            });
            secondMatches.push({
              line: i,
              preview: 'captain urls preview row ' + i,
              ranges: [{ start: 8, end: 12 }]
            });
          }
          window.__ijFindOnMessage({
            type: 'results:file',
            searchId: 1940,
            __targetSrc: targetSrc,
            match: { uri: first, relPath: 'manage.py', matches: firstMatches }
          });
          window.__ijFindOnMessage({
            type: 'results:file',
            searchId: 1940,
            __targetSrc: targetSrc,
            match: { uri: second, relPath: 'zuzu/app/urls.py', matches: secondMatches }
          });
          window.__ijFindOnMessage({ type: 'results:done', searchId: 1940, totalFiles: 2, totalMatches: 32, truncated: false, __targetSrc: targetSrc });
          var oldBridge = globalThis.irSearchEvent;
          var sent = [];
          globalThis.irSearchEvent = function (payload) {
            try {
              var msg = JSON.parse(String(payload));
              sent.push(msg);
            } catch (e) {}
          };
          var requestTimings = [];
          var renderTimings = [];
          var timings = [];
          for (var idx = 1; idx <= 16; idx++) {
            var row = root && root.querySelector('.ij-find-row[data-flat="' + idx + '"]');
            if (!row) {
              globalThis.irSearchEvent = oldBridge;
              window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
              return JSON.stringify({ err: 'missing result row ' + idx, state: window.__ijFindGetSearchState(targetSrc), timings: timings });
            }
            sent.length = 0;
            var started = performance.now();
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            var previewReq = sent.find(function (msg) { return msg.type === 'requestPreview' && (msg.uri === first || msg.uri === second); });
            var requestAtMs = previewReq ? performance.now() - started : null;
            if (!previewReq) {
              timings.push({ idx: idx, requestAtMs: null, previewAtMs: null, uri: null });
              continue;
            }
            var uniquePreviewText = 'captain preview switch row ' + idx + ' ' + previewReq.uri;
            window.__ijFindOnMessage({
              type: 'preview',
              uri: previewReq.uri,
              previewSeq: previewReq.previewSeq,
              __targetSrc: targetSrc,
              relPath: previewReq.uri === second ? 'zuzu/app/urls.py' : 'manage.py',
              languageId: previewReq.uri === second ? 'python' : 'python',
              focusLine: 3,
              fullFile: true,
              lines: [
                { lineNumber: 0, text: 'captain preview header ' + idx },
                { lineNumber: 1, text: 'captain preview filler ' + idx + ' a' },
                { lineNumber: 2, text: 'captain preview filler ' + idx + ' b' },
                { lineNumber: 3, text: uniquePreviewText },
                { lineNumber: 40, text: 'captain preview tail ' + idx }
              ],
              ranges: [{ start: 8, end: 15 }]
            });
            var previewAtMs = null;
            while (performance.now() - started <= ${UI_RESPONSE_BUDGET_MS}) {
              var previewBody = root ? root.querySelector('.ij-find-preview-body') : document.querySelector('.ij-find-overlay.visible:not(.ij-find-detached) .ij-find-preview-body');
              var previewText = previewBody ? previewBody.textContent || '' : '';
              if (previewText.indexOf(uniquePreviewText) >= 0) {
                previewAtMs = performance.now() - started;
                break;
              }
              await new Promise(function (resolve) { setTimeout(resolve, 1); });
            }
            timings.push({
              idx: idx,
              requestAtMs: requestAtMs === null ? null : Math.round(requestAtMs),
              previewAtMs: previewAtMs === null ? null : Math.round(previewAtMs),
              uri: previewReq.uri
            });
            if (requestAtMs !== null) { requestTimings.push(Math.round(requestAtMs)); }
            if (previewAtMs !== null) { renderTimings.push(Math.round(previewAtMs)); }
          }
          var state = window.__ijFindGetSearchState(targetSrc);
          globalThis.irSearchEvent = oldBridge;
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
          return JSON.stringify({
            activeIndex: state.activeIndex,
            previewUri: state.previewUri,
            requestTimings: requestTimings,
            renderTimings: renderTimings,
            timings: timings
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        err?: string;
        activeIndex: number;
        previewUri: string | null;
        requestTimings: number[];
        renderTimings: number[];
        timings: Array<{ idx: number; requestAtMs: number | null; previewAtMs: number | null; uri: string | null }>;
      };
      assert.strictEqual(parsed.err, undefined, `expected captain result rows: ${raw}`);
      assert.strictEqual(parsed.activeIndex, 16, `final click should select the final loaded row: ${raw}`);
      assert.ok(parsed.previewUri === manageUri || parsed.previewUri === urlsUri, `final click should switch preview to a captain URI: ${raw}`);
      assert.strictEqual(parsed.requestTimings.length, 16, `expected every loaded click to request preview: ${raw}`);
      assert.strictEqual(parsed.renderTimings.length, 16, `expected every loaded click to render preview: ${raw}`);
      assertTimingsWithin('captain result click preview request latency', parsed.requestTimings, UI_RESPONSE_BUDGET_MS);
      assertTimingsWithin('captain result click preview render latency', parsed.renderTimings, UI_RESPONSE_BUDGET_MS);
      console.log(
        `[captain-e2e] UI preview switch request=${parsed.requestTimings.join(',')}ms ` +
        `render=${parsed.renderTimings.join(',')}ms`,
      );
    } finally {
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            Array.from(document.querySelectorAll('.ij-find-overlay.visible .ij-find-close')).forEach(function (btn) {
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            return 'closed';
          })()`,
        );
      } catch {}
    }
  });

  test('captain first-load inlay hook is ready for the active workbench window', async function () {
    this.timeout(UI_RESPONSE_TEST_TIMEOUT_MS);
    const api = await getApi();
    const { overlay } = api;
    const injectionError = await ensureRendererInjectionForUi(overlay);
    if (injectionError) {
      console.log(`[captain-e2e] skipping first-load inlay probe; renderer injection unavailable: ${injectionError}`);
      this.skip();
      return;
    }
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorHook = cfg.inspect<boolean>('rendererInlayClickHook');
    const priorIdle = cfg.inspect<number>('rendererBridgeSingletonIdleMs');
    await cfg.update('rendererInlayClickHook', true, vscode.ConfigurationTarget.Workspace);
    await cfg.update('rendererBridgeSingletonIdleMs', 5000, vscode.ConfigurationTarget.Workspace);

    try {
      await overlay.show('CaptainFirstInlayHookProbe', { forceLiteral: true, suppressSearch: true });
      overlay.resetRendererInlayClickHookWarmupForTests();
      overlay.scheduleRendererInlayClickHookWarmup('captain-first-load-inlay', 0, true);
      let state = overlay.getRendererInlayClickHookStateForTests();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        state = overlay.getRendererInlayClickHookStateForTests();
        if (state.ready && state.readyForActiveWindow && state.cdpOpen && state.idleCloseTimerActive) { break; }
        await delay(50);
      }
      assert.strictEqual(state.ready, true, `captain inlay hook should be warmed before the first click: ${JSON.stringify(state)}`);
      assert.strictEqual(
        state.readyForActiveWindow,
        true,
        `captain first-load inlay click must not reuse a hook installed in another workbench window: ${JSON.stringify(state)}`,
      );
      assert.strictEqual(state.cdpOpen, true, `captain first inlay click should not reopen CDP on demand: ${JSON.stringify(state)}`);
      assert.strictEqual(state.idleCloseTimerActive, true, `captain warmup should keep the singleton bridge alive for the first click: ${JSON.stringify(state)}`);
      assert.strictEqual(state.warmupFailures, 0, `captain inlay warmup should not exhaust retries: ${JSON.stringify(state)}`);
      console.log('[captain-e2e] first-load inlay hook ready for active workbench window');
    } finally {
      await cfg.update('rendererInlayClickHook', priorHook?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await cfg.update('rendererBridgeSingletonIdleMs', priorIdle?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      overlay.resetRendererInlayClickHookWarmupForTests();
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            Array.from(document.querySelectorAll('.ij-find-overlay.visible .ij-find-close')).forEach(function (btn) {
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            return 'closed';
          })()`,
        );
      } catch {}
    }
  });

  test('rust-native call graph rebuilds the full captain workspace within 8 seconds', async function () {
    this.timeout(GRAPH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS);
    const root = workspaceRoot();
    assertCaptainWorkspace(root);

    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorBackend = cfg.inspect<string>('callGraphBackend');
    await cfg.update('callGraphBackend', 'rust-native', vscode.ConfigurationTarget.Workspace);
    const urlsPath = path.join(root, 'zuzu', 'app', 'urls.py');
    assert.ok(fs.existsSync(urlsPath), `expected captain urls fixture file ${urlsPath}`);
    try {
      const started = Date.now();
      const snapshot = await api.callGraph.rebuild(undefined, undefined, { force: true });
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs <= GRAPH_INDEX_BUDGET_MS, `captain rust-native graph-rebuild took ${elapsedMs}ms`);
      assert.ok(snapshot.stats.fileCount > 0, 'captain call graph indexed no files');
      assert.ok(snapshot.stats.symbolCount > 0, 'captain call graph indexed no symbols');
      assert.ok(
        snapshot.stats.referenceCount > 0,
        'captain call graph indexed no references; this would leave call graph inlays empty',
      );
      assert.ok(
        snapshot.warnings.some((warning) => warning.includes('rust-native graph-rebuild')),
        `expected rust-native graph index response; warnings=${snapshot.warnings.join(' | ')}`,
      );
      const urlsUri = vscode.Uri.file(urlsPath);
      assert.ok(
        await api.callGraph.ensureDocumentSummariesRestored(urlsUri),
        'captain extension call graph failed to restore urls.py document summary from rust-native index',
      );
      const document = await vscode.workspace.openTextDocument(urlsUri);
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end,
      );
      const cachedSummaries = api.callGraph.getCachedSymbolRelationSummariesForDocument(urlsUri, fullRange);
      assert.ok(
        cachedSummaries.some((summary) => summary.usageCount > 0 || summary.implementationCount > 0 || summary.calleeCount > 0),
        `captain extension cached summaries had no relation counts: ${JSON.stringify(cachedSummaries.slice(0, 5))}`,
      );
      const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        urlsUri,
        fullRange,
      );
      const relationHints = (hints ?? []).filter((hint) => {
        const label = Array.isArray(hint.label)
          ? hint.label.map((part) => part.value).join(' ')
          : String(hint.label ?? '');
        return /\b(usages|impl|callees)\s+\d+\b/.test(label);
      });
      assert.ok(relationHints.length > 0, 'captain inlay provider returned no relation inlay hints for urls.py');
      console.log(
        `[captain-e2e] graph rebuild ${elapsedMs}ms files=${snapshot.stats.fileCount} ` +
        `symbols=${snapshot.stats.symbolCount} refs=${snapshot.stats.referenceCount}`,
      );
    } finally {
      await cfg.update('callGraphBackend', priorBackend?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('search index reuses the clean full captain workspace within 8 seconds', async function () {
    this.timeout(SEARCH_INDEX_SEED_TIMEOUT_MS + SEARCH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS);
    const elapsedMs = captainSearchRebuildElapsedMs ?? await runCaptainSearchRebuildGate();
    assert.ok(elapsedMs <= SEARCH_INDEX_BUDGET_MS, `captain search index clean reuse took ${elapsedMs}ms`);
    console.log(`[captain-e2e] search index clean reuse already verified ${elapsedMs}ms`);
  });

  test('zoekt incremental create, modify, and delete updates stay within 1000ms', async function () {
    this.timeout(20_000);
    await delay(2_000);
    const api = await getApi();
    const runtime = (api.overlay as any).zoektRuntime as any;
    const pausedUpdates = runtime.pauseFileUpdates?.('captain incremental update E2E', { cancelIndexing: false });
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const relPath = `ijss-e2e-incremental-${process.pid}.txt`;
    const absPath = path.join(root, relPath);
    const created = `ijss_incremental_created_${process.pid}`;
    const modified = `ijss_incremental_modified_${process.pid}`;
    const timings: number[] = [];
    const pathRegex = exactRelPathRegex(relPath);
    try {
      await fs.promises.writeFile(absPath, `${created}\n`, 'utf8');
      timings.push(await runZoektUpdateWithinBudget(root, [relPath], 'create'));
      await assertQueryRelPaths(root, created, [relPath], 'created file should be searchable via overlay update', pathRegex);

      await fs.promises.writeFile(absPath, `${modified}\n`, 'utf8');
      timings.push(await runZoektUpdateWithinBudget(root, [relPath], 'modify'));
      await assertQueryRelPaths(root, modified, [relPath], 'modified file should be searchable via overlay update', pathRegex);
      await assertQueryRelPaths(root, created, [], 'stale created token should be shadowed after modify update', pathRegex);

      await fs.promises.unlink(absPath);
      timings.push(await runZoektUpdateWithinBudget(root, ['--delete', relPath], 'delete'));
      await assertQueryRelPaths(root, modified, [], 'deleted file should be tombstoned by overlay update', pathRegex);
      console.log(`[captain-e2e] incremental file updates ${timings.join(',')}ms`);
    } finally {
      try { await fs.promises.unlink(absPath); } catch {}
      await runZoektUpdateWithinBudget(root, ['--delete', relPath], 'cleanup').catch(() => undefined);
      runtime.clearPending?.();
      pausedUpdates?.dispose?.();
    }
  });

  test('zoekt git branch-change sync updates changed paths within 1000ms', async function () {
    this.timeout(20_000);
    await delay(2_000);
    const api = await getApi();
    const runtime = (api.overlay as any).zoektRuntime as any;
    const pausedUpdates = runtime.pauseFileUpdates?.('captain branch-change update E2E', { cancelIndexing: false });
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const binary = getZoekRsBinaryForTests();
    const suffix = String(process.pid);
    const modifiedRel = `ijss-e2e-branch-modified-${suffix}.txt`;
    const deletedRel = `ijss-e2e-branch-deleted-${suffix}.txt`;
    const createdRel = `ijss-e2e-branch-created-${suffix}.txt`;
    const modifiedAbs = path.join(root, modifiedRel);
    const deletedAbs = path.join(root, deletedRel);
    const createdAbs = path.join(root, createdRel);
    const before = `ijss_branch_before_${suffix}`;
    const after = `ijss_branch_after_${suffix}`;
    const removed = `ijss_branch_removed_${suffix}`;
    const added = `ijss_branch_added_${suffix}`;
    const modifiedPathRegex = exactRelPathRegex(modifiedRel);
    const deletedPathRegex = exactRelPathRegex(deletedRel);
    const createdPathRegex = exactRelPathRegex(createdRel);
    const originalReadGitState = runtime.readGitState?.bind(runtime);
    const originalCollectGitBranchChanges = runtime.collectGitBranchChanges?.bind(runtime);
    try {
      await fs.promises.writeFile(modifiedAbs, `${before}\n`, 'utf8');
      await fs.promises.writeFile(deletedAbs, `${removed}\n`, 'utf8');
      await runZoektUpdateWithinBudget(root, [modifiedRel, deletedRel], 'branch seed');
      await assertQueryRelPaths(root, before, [modifiedRel], 'branch seed modified file should be searchable', modifiedPathRegex);
      await assertQueryRelPaths(root, removed, [deletedRel], 'branch seed deleted file should be searchable before simulated checkout', deletedPathRegex);

      await fs.promises.writeFile(modifiedAbs, `${after}\n`, 'utf8');
      await fs.promises.writeFile(createdAbs, `${added}\n`, 'utf8');
      await fs.promises.unlink(deletedAbs);

      runtime.lastGitState.set(root, 'HEAD ref: refs/heads/main\nREF aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      runtime.readGitState = async () => 'HEAD ref: refs/heads/feature\nREF bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      runtime.collectGitBranchChanges = async () => ({
        changed: [modifiedRel, createdRel],
        deleted: [deletedRel],
        renamed: [],
      });
      const started = Date.now();
      await runtime.syncWorkspaceIndexIfNeeded(root, binary, 'captain-branch-change-e2e');
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs <= INCREMENTAL_UPDATE_BUDGET_MS, `branch-change sync took ${elapsedMs}ms`);

      await assertQueryRelPaths(root, after, [modifiedRel], 'branch-changed file should be searchable', modifiedPathRegex);
      await assertQueryRelPaths(root, added, [createdRel], 'branch-created file should be searchable', createdPathRegex);
      await assertQueryRelPaths(root, before, [], 'branch sync should shadow previous modified contents', modifiedPathRegex);
      await assertQueryRelPaths(root, removed, [], 'branch sync should tombstone branch-deleted file', deletedPathRegex);
      console.log(`[captain-e2e] branch-change incremental sync ${elapsedMs}ms`);
    } finally {
      if (originalReadGitState) { runtime.readGitState = originalReadGitState; }
      if (originalCollectGitBranchChanges) { runtime.collectGitBranchChanges = originalCollectGitBranchChanges; }
      runtime.lastGitState.delete(root);
      for (const file of [modifiedAbs, deletedAbs, createdAbs]) {
        try { await fs.promises.unlink(file); } catch {}
      }
      await runZoektUpdateWithinBudget(root, ['--delete', modifiedRel, '--delete', deletedRel, '--delete', createdRel], 'branch cleanup').catch(() => undefined);
      runtime.clearPending?.();
      pausedUpdates?.dispose?.();
    }
  });

  test('zoekt completes 100 captain searches with p95 under 150ms', async function () {
    this.timeout(SEARCH_SPEED_TEST_TIMEOUT_MS);
    const api = await getApi();
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const runtime = (api.overlay as any).zoektRuntime as {
      getSearchReadiness: () => Promise<{ ready: boolean; reason?: string }>;
    };
    assert.deepStrictEqual(await runtime.getSearchReadiness(), { ready: true });

    const rgPath = await getRipgrepForTests();
    const fixture = await loadAccuracyFixture(root, rgPath);
    const queries = fixture.queries.slice(0, SEARCH_SPEED_QUERY_COUNT);
    assert.strictEqual(queries.length, SEARCH_SPEED_QUERY_COUNT);

    const records: Array<{
      idx: number;
      query: string;
      elapsedMs: number;
      totalFilesScanned: number;
      totalFilesMatched: number;
      totalMatches: number;
    }> = [];
    for (let idx = 0; idx < queries.length; idx++) {
      let stats: { elapsedMs: number; totalFilesScanned: number; totalFilesMatched: number; totalMatches: number };
      try {
        stats = await runZoektSearchForSpeed(root, queries[idx]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`speed query #${idx} failed query=${JSON.stringify(queries[idx])}: ${message}`);
      }
      records.push({ idx, query: queries[idx], ...stats });
      if ((idx + 1) % 25 === 0) {
        const sortedSoFar = records.map((record) => record.elapsedMs).sort((a, b) => a - b);
        console.log(
          `[captain-e2e] search speed ${idx + 1}/${queries.length} ` +
          `p95=${percentile(sortedSoFar, 0.95)}ms max=${sortedSoFar[sortedSoFar.length - 1]}ms`,
        );
      }
    }
    const sorted = records.map((record) => record.elapsedMs).sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.50);
    const p95 = percentile(sorted, 0.95);
    const max = sorted[sorted.length - 1];
    const slowest = [...records]
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 8)
      .map((record) => (
        `#${record.idx}:${record.elapsedMs}ms scanned=${record.totalFilesScanned} ` +
        `matches=${record.totalMatches} query=${JSON.stringify(record.query.slice(0, 80))}`
      ));
    if (p95 > SEARCH_SPEED_P95_BUDGET_MS) {
      console.log(`[captain-e2e] slowest search samples ${slowest.join(' | ')}`);
    }
    assert.ok(
      p95 <= SEARCH_SPEED_P95_BUDGET_MS,
      `captain zoekt search p95 ${p95}ms exceeded ${SEARCH_SPEED_P95_BUDGET_MS}ms ` +
      `(p50=${p50}ms max=${max}ms slowest=${slowest.join(' | ')})`,
    );
    console.log(`[captain-e2e] search speed p50=${p50}ms p95=${p95}ms max=${max}ms n=${records.length}`);
  });

  test('zoekt OR fallback covers later captain query terms', async function () {
    this.timeout(RG_TIMEOUT_MS);
    const api = await getApi();
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const runtime = (api.overlay as any).zoektRuntime as {
      getSearchReadiness: () => Promise<{ ready: boolean; reason?: string }>;
    };
    assert.deepStrictEqual(await runtime.getSearchReadiness(), { ready: true });

    const rgPath = await getRipgrepForTests();
    const fixture = await loadAccuracyFixture(root, rgPath);
    const primary = fixture.queries.find((query) => (
      query !== CAPTAIN_QUERY_TERMS_FALLBACK_LITERAL &&
      !literalsMayOverlap(query, CAPTAIN_QUERY_TERMS_FALLBACK_LITERAL)
    ));
    assert.ok(primary, 'expected a non-overlapping captain query fixture');
    const queries = [primary, CAPTAIN_QUERY_TERMS_FALLBACK_LITERAL];
    const expectedByQuery = await rgBaselineForPatterns(root, rgPath, queries);
    assert.ok(
      (expectedByQuery.get(CAPTAIN_QUERY_TERMS_FALLBACK_LITERAL)?.size ?? 0) > 0,
      'captain fallback literal must have an rg baseline match',
    );

    const result = await api.overlay.searchForTestsDetailed({
      query: primary,
      queries,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
      ignoreConfiguredExcludes: true,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      resultLimit: 10_000,
    });
    assert.strictEqual(
      result.effectiveEngine,
      'zoekt',
      `OR fallback query did not use zoekt; ${formatEngineRoute(result)}`,
    );
    const actualByQuery = await resultLineSetsByQuery(root, result, queries);
    for (const query of queries) {
      assertSameLineSet(
        actualByQuery.get(query) ?? new Set<string>(),
        expectedByQuery.get(query) ?? new Set<string>(),
        `OR fallback mismatch query=${JSON.stringify(query)}`,
      );
    }
  });

  test('zoekt matches rg for 1000 deterministic random captain searches', async function () {
    this.timeout(RANDOM_ACCURACY_TIMEOUT_MS);
    const api = await getApi();
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const runtime = (api.overlay as any).zoektRuntime as {
      getSearchReadiness: () => Promise<{ ready: boolean; reason?: string }>;
    };
    assert.deepStrictEqual(await runtime.getSearchReadiness(), { ready: true });

    const rgPath = await getRipgrepForTests();
    const fixture = await loadAccuracyFixture(root, rgPath);
    console.log(`[captain-e2e] rg parity fixture ready queries=${fixture.queries.length}`);
    for (let batchStart = 0; batchStart < fixture.queries.length; batchStart += RANDOM_SEARCH_BATCH_SIZE) {
      const batch = fixture.queries.slice(batchStart, batchStart + RANDOM_SEARCH_BATCH_SIZE);
      const result = await api.overlay.searchForTestsDetailed({
        query: batch[0] ?? '',
        queries: batch,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
        ignoreConfiguredExcludes: true,
        maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        resultLimit: 10_000,
      });
      assert.strictEqual(
        result.effectiveEngine,
        'zoekt',
        `random batch ${batchStart}-${batchStart + batch.length} did not use zoekt; ${formatEngineRoute(result)}`,
      );
      const actualByQuery = await resultLineSetsByQuery(root, result, batch);
      for (let batchIdx = 0; batchIdx < batch.length; batchIdx++) {
        const query = batch[batchIdx];
        const idx = batchStart + batchIdx;
        const expected = fixture.expectedByQuery.get(query) ?? new Set<string>();
        const actual = actualByQuery.get(query) ?? new Set<string>();
        assertSameLineSet(
          actual,
          expected,
          `random[${idx}] rg mismatch query=${JSON.stringify(query)}`,
        );
      }
      console.log(`[captain-e2e] rg parity ${Math.min(batchStart + batch.length, fixture.queries.length)}/${fixture.queries.length}`);
    }
  });

  test('zoekt matches rg for a 10000char captain search', async function () {
    this.timeout(RG_TIMEOUT_MS);
    const api = await getApi();
    const root = workspaceRoot();
    assertCaptainWorkspace(root);
    const rgPath = await getRipgrepForTests();
    const fixture = await loadAccuracyFixture(root, rgPath);
    const expected = await rgBaselineForSingleQuery(root, rgPath, fixture.longQuery);
    assert.ok(
      expected.size > 0,
      `rg found no 10000char baseline matches from ${fixture.longSourceRelPath}`,
    );

    const result = await api.overlay.searchForTestsDetailed({
      query: fixture.longQuery,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
      ignoreConfiguredExcludes: true,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      resultLimit: 10_000,
    });
    assert.strictEqual(
      result.effectiveEngine,
      'zoekt',
      `10000char search did not use zoekt; ${formatEngineRoute(result)}`,
    );
    assertSameLineSet(
      resultLineSet(result),
      expected,
      `10000char rg mismatch source=${fixture.longSourceRelPath}`,
    );
  });
});
