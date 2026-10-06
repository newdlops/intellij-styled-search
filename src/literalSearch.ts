/** Editor line breaks match LF and CRLF files without interpreting literal punctuation. */
export function literalSearchRegexSource(query: string): string {
  return query.replace(/\r\n/g, '\n').split('\n')
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n');
}
