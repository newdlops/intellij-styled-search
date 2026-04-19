function normalizeSlashPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function normalizePattern(pattern: string): string {
  let value = pattern.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  value = value.replace(/\/+/g, '/');
  return value;
}

function hasGlobMeta(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
}

function isCharClass(pattern: string, start: number): number {
  if (pattern[start] !== '[') { return -1; }
  let i = start + 1;
  if (i < pattern.length && pattern[i] === '!') { i++; }
  if (i < pattern.length && pattern[i] === ']') { i++; }
  while (i < pattern.length && pattern[i] !== ']') { i++; }
  return i < pattern.length ? i : -1;
}

function escapeRegexChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? '\\' + ch : ch;
}

function antPatternToRegExpSource(pattern: string): string {
  let out = '^';
  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const atSegmentStart = i === 0 || pattern[i - 1] === '/';
        const atSegmentEnd = i + 2 === pattern.length || pattern[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          if (i + 2 < pattern.length && pattern[i + 2] === '/') {
            out += '(?:[^/]+/)*';
            i += 3;
          } else {
            out += '.*';
            i += 2;
          }
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const classEnd = isCharClass(pattern, i);
      if (classEnd >= 0) {
        const body = pattern.slice(i + 1, classEnd);
        if (body.startsWith('!')) {
          out += '[^' + body.slice(1) + ']';
        } else {
          out += '[' + body + ']';
        }
        i = classEnd + 1;
        continue;
      }
    }
    out += ch === '/' ? '/' : escapeRegexChar(ch);
    i += 1;
  }
  return out + '$';
}

function expandPattern(rawPattern: string): string[] {
  const pattern = normalizePattern(rawPattern);
  if (!pattern) { return []; }

  const out = new Set<string>();
  const dirPattern = pattern.endsWith('/');
  const base = dirPattern ? pattern.slice(0, -1) : pattern;
  const withAnyDepth = base.includes('/') ? base : '**/' + base;
  const glob = hasGlobMeta(base);

  if (dirPattern) {
    out.add(withAnyDepth + '/**');
    return Array.from(out);
  }

  if (!glob) {
    out.add(withAnyDepth);
    out.add(withAnyDepth + '/**');
    return Array.from(out);
  }

  out.add(base.includes('/') ? base : '**/' + base);
  return Array.from(out);
}

export function parseIncludePatternInput(input: string | readonly string[] | undefined | null): string[] {
  if (!input) { return []; }
  const raw: readonly string[] = typeof input === 'string' ? input.split(/[\n,;]+/) : input;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) { continue; }
    if (seen.has(trimmed)) { continue; }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function toRipgrepGlobs(input: string | readonly string[] | undefined | null): string[] {
  const patterns = parseIncludePatternInput(input);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const expanded of expandPattern(pattern)) {
      if (seen.has(expanded)) { continue; }
      seen.add(expanded);
      out.push(expanded);
    }
  }
  return out;
}

export function compileIncludeMatcher(input: string | readonly string[] | undefined | null): ((relPath: string) => boolean) | null {
  const globs = toRipgrepGlobs(input);
  if (globs.length === 0) { return null; }
  const regexes = globs.map((glob) => new RegExp(antPatternToRegExpSource(glob)));
  return (relPath: string) => {
    const normalized = normalizeSlashPath(relPath);
    for (const re of regexes) {
      if (re.test(normalized)) { return true; }
    }
    return false;
  };
}
