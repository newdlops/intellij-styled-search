function lowercaseCodeUnit(text: string, index: number): string {
  const code = text.charCodeAt(index);
  if (code >= 0x41 && code <= 0x5a) { return String.fromCharCode(code + 32); }
  return code < 0x80 ? text[index] : text[index].toLowerCase();
}

export function extractTrigramsLower(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length < 3) { return out; }
  // Keep only the rolling window. Lowercase each UTF-16 code unit separately
  // to preserve the index format's Unicode expansion and surrogate behavior.
  let first = lowercaseCodeUnit(text, 0);
  let second = lowercaseCodeUnit(text, 1);
  for (let i = 2; i < text.length; i++) {
    const third = lowercaseCodeUnit(text, i);
    out.add(first + second + third);
    first = second;
    second = third;
  }
  return out;
}
