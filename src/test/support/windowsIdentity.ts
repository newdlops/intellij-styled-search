import { execFile } from 'child_process';
import * as path from 'path';

function quotedCsvRows(output: string): string[][] {
  const text = output.replace(/^\uFEFF/, '').trim();
  if (!text) { throw new Error('whoami returned no token information'); }
  return text.split(/\r?\n/).map(line => {
    const fields: string[] = [];
    let consumed = 0;
    for (const match of line.matchAll(/(?:^|,)"((?:[^"]|"")*)"/g)) {
      if (match.index !== consumed) { throw new Error('Malformed whoami CSV'); }
      fields.push(match[1].replace(/""/g, '"'));
      consumed += match[0].length;
    }
    if (consumed !== line.length || fields.length === 0) { throw new Error('Malformed whoami CSV'); }
    return fields;
  });
}

export function parseWindowsTestIdentity(userOutput: string, groupsOutput: string) {
  const users = quotedCsvRows(userOutput);
  const groups = quotedCsvRows(groupsOutput);
  const isSid = (value: string) => /^S-\d+(?:-\d+)+$/.test(value);
  if (users.length !== 1 || users[0].length !== 2 || !users[0][0] || !isSid(users[0][1])
    || groups.some(row => row.length !== 4 || !isSid(row[2]))) {
    throw new Error('whoami did not return complete user and group SIDs');
  }
  // Reject even a deny-only Administrators SID: acceptance requires an actual
  // standard account, rather than an administrator's filtered UAC token.
  return { user: users[0][0], sid: users[0][1],
    administrator: groups.some(row => row[2] === 'S-1-5-32-544'),
    groupSids: groups.map(row => row[2]) };
}

export async function readWindowsTestIdentity() {
  const binary = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const invoke = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = execFile(binary, args, { windowsHide: true, timeout: 30_000, encoding: 'utf8' },
      (error, stdout) => { if (error) { reject(error); } else { resolve(stdout); } });
    child.stdin?.end();
  });
  return parseWindowsTestIdentity(await invoke(['/user', '/fo', 'csv', '/nh']),
    await invoke(['/groups', '/fo', 'csv', '/nh']));
}
