// CreateProcessW limits the complete command line, including its terminator,
// to 32,767 UTF-16 code units. Count libuv's argument quoting as well as paths.
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

function quotedArgumentLength(value: string): number {
  if (value.length > 0 && !/[\s"]/.test(value)) { return value.length; }
  let length = 2;
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') { backslashes++; continue; }
    length += backslashes * (ch === '"' ? 2 : 1) + (ch === '"' ? 2 : ch.length);
    backslashes = 0;
  }
  return length + backslashes * 2;
}

export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  return 1 + [command, ...args].reduce((length, arg, index) =>
    length + quotedArgumentLength(arg) + (index > 0 ? 1 : 0), 0);
}

export function fitsWindowsCommandLine(command: string, args: readonly string[]): boolean {
  return windowsCommandLineLength(command, args) <= WINDOWS_COMMAND_LINE_LIMIT;
}
