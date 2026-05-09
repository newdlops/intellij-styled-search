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
const SEARCH_INDEX_BUDGET_MS = 15_000;
const GRAPH_INDEX_BUDGET_MS = 15_000;
const TIMEOUT_GRACE_MS = 5_000;
const MAX_FILE_SIZE_BYTES = 1_048_576;
const RANDOM_QUERY_COUNT = 1_000;
const RANDOM_CANDIDATE_COUNT = 4_000;
const RANDOM_ACCURACY_TIMEOUT_MS = 600_000;
const SEARCH_SPEED_QUERY_COUNT = 100;
const SEARCH_SPEED_P95_BUDGET_MS = 150;
const SEARCH_SPEED_QUERY_TIMEOUT_MS = 5_000;
const SEARCH_SPEED_TEST_TIMEOUT_MS = 600_000;
const MAX_RANDOM_EXPECTED_MATCHES = 1;
const RANDOM_SEARCH_BATCH_SIZE = 50;
const LONG_QUERY_LENGTH = 10_000;
const RG_TIMEOUT_MS = 120_000;

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

async function runWithBudget<T>(
  label: string,
  budgetMs: number,
  operation: () => Promise<T>,
  onTimeout?: () => void,
): Promise<{ value: T; elapsedMs: number }> {
  const started = Date.now();
  const work = operation();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { onTimeout?.(); } catch {}
      reject(new Error(`${label} exceeded ${budgetMs}ms`));
    }, budgetMs);
  });

  try {
    const value = await Promise.race([work, timeout]);
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs <= budgetMs, `${label} took ${elapsedMs}ms, budget ${budgetMs}ms`);
    return { value, elapsedMs };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      void work.catch(() => undefined);
    }
  }
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

function getZoekRsBinaryForTests(): string {
  const exe = process.platform === 'win32' ? 'zoek-rs.exe' : 'zoek-rs';
  const candidates = [
    path.join(process.cwd(), 'target', 'release', exe),
    path.join(process.cwd(), 'target', 'debug', exe),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(binary, `zoek-rs binary not found; tried ${candidates.join(', ')}`);
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
    SEARCH_SPEED_QUERY_TIMEOUT_MS,
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

suite('Captain E2E index gates', () => {
  test('opens the captain workspace before running expensive gates', function () {
    this.timeout(5_000);
    assertCaptainWorkspace(workspaceRoot());
  });

  test('rust-native call graph rebuilds the full captain workspace within 15 seconds', async function () {
    this.timeout(GRAPH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS);
    const root = workspaceRoot();
    assertCaptainWorkspace(root);

    const binary = getZoekRsBinaryForTests();
    await delay(2_500);
    const started = Date.now();
    const result = await runProcess(
      binary,
      [
        'graph-rebuild',
        root,
        '--max-file-size',
        String(MAX_FILE_SIZE_BYTES),
        '--workers',
        '16',
      ],
      process.cwd(),
      GRAPH_INDEX_BUDGET_MS,
    );
    const elapsedMs = Date.now() - started;
    assert.strictEqual(result.code, 0, `zoek-rs graph-rebuild failed code=${result.code} stderr=${result.stderr.slice(-1000)}`);
    assert.ok(elapsedMs <= GRAPH_INDEX_BUDGET_MS, `captain rust-native graph-rebuild took ${elapsedMs}ms`);
    const response = JSON.parse(result.stdout.trim()) as {
      ok?: boolean;
      type?: string;
      fileCount?: number;
      symbolCount?: number;
      referenceCount?: number;
      warnings?: string[];
    };

    assert.strictEqual(response.type, 'graph-index');
    assert.strictEqual(response.ok, true);
    assert.ok((response.fileCount ?? 0) > 0, 'captain call graph indexed no files');
    assert.ok((response.symbolCount ?? 0) > 0, 'captain call graph indexed no symbols');
    assert.ok(
      (response.warnings ?? []).some((warning) => warning.includes('rust-native graph-rebuild')),
      `expected rust-native graph index response; warnings=${(response.warnings ?? []).join(' | ')}`,
    );
    console.log(
      `[captain-e2e] graph rebuild ${elapsedMs}ms files=${response.fileCount} ` +
      `symbols=${response.symbolCount} refs=${response.referenceCount}`,
    );
  });

  test('search index rebuilds the full captain workspace within 15 seconds', async function () {
    this.timeout(SEARCH_INDEX_BUDGET_MS + TIMEOUT_GRACE_MS);
    const api = await getApi();
    const root = workspaceRoot();
    assertCaptainWorkspace(root);

    const runtime = (api.overlay as any).zoektRuntime as {
      rebuildIndex: (report?: (message: string, percent?: number) => void) => Promise<boolean>;
      cancelRunningProcesses: (reason?: string, options?: { kinds?: string[] }) => void;
      getSearchReadiness: () => Promise<{ ready: boolean; reason?: string }>;
    };
    const progress: string[] = [];
    const { value: usedZoekt, elapsedMs } = await (async () => {
      try {
        return await runWithBudget(
          'captain search index rebuild',
          SEARCH_INDEX_BUDGET_MS,
          () => runtime.rebuildIndex((message, percent) => {
            const suffix = typeof percent === 'number' ? ` ${Math.round(percent)}%` : '';
            progress.push(`${message}${suffix}`);
          }),
          () => runtime.cancelRunningProcesses('captain search index gate timed out', {
            kinds: ['index', 'rebuild', 'update'],
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${msg}; progress=${progress.slice(-12).join(' | ') || 'none'}`);
      }
    })();
    assert.strictEqual(
      usedZoekt,
      true,
      `zoek-rs did not run for captain search index rebuild; progress=${progress.slice(-8).join(' | ')}`,
    );

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
    console.log(`[captain-e2e] search index rebuild ${elapsedMs}ms`);
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
      const stats = await runZoektSearchForSpeed(root, queries[idx]);
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
