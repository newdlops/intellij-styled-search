const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = path.join(os.tmpdir(), 'ijss-e2e');
const destination = path.join(process.cwd(), 'artifacts', 'desktop-test-logs');
const names = new Set(['main.log', 'renderer.log', 'exthost.log', '1-IntelliJ Styled Search.log']);
function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && names.has(entry.name)) {
      const output = path.join(destination, path.relative(source, file));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const content = fs.readFileSync(file, 'utf8')
        .replace(/([?&](?:sig|token|access_token|auth|key)=)[^\s&"<>]+/gi, '$1[redacted]')
        .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"<>]+/gi, '$1[redacted]');
      fs.writeFileSync(output, content);
    }
  }
}
collect(source);
console.info('Desktop test logs collected:', destination);
