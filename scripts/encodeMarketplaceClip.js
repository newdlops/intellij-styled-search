// Encode frames captured from the actual extension window; never opens a camera.
// Example: node scripts/encodeMarketplaceClip.js --frames /tmp/clip --name 01-search
//   --out resources/marketplace --crop 1010:650:214:60 --fps 4
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { parseArgs } = require('util');

const { values } = parseArgs({ options: {
  frames: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' },
  crop: { type: 'string' }, fps: { type: 'string', default: '4' },
} });
if (!values.frames || !values.name || !values.out || !values.crop) {
  throw new Error('Required: --frames <directory> --name <basename> --out <directory> --crop <w:h:x:y>');
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(values.name)) { throw new Error('Unsafe output basename'); }
if (!/^\d+:\d+:\d+:\d+$/.test(values.crop)) { throw new Error('Crop must be w:h:x:y'); }
const [width, height] = values.crop.split(':').map(Number);
if (!width || !height || width % 2 || height % 2) { throw new Error('Crop must have positive even dimensions'); }
const fps = Number(values.fps);
if (!Number.isInteger(fps) || fps < 2 || fps > 30) { throw new Error('FPS must be between 2 and 30'); }
const frames = path.resolve(values.frames);
const files = fs.readdirSync(frames).filter(name => /^frame-\d{4}\.jpg$/.test(name)).sort();
if (files.length < fps * 2 || files.length > fps * 15) {
  throw new Error(`Expected a 2–15 second clip, received ${files.length} frames at ${fps} FPS`);
}
files.forEach((name, index) => {
  if (name !== `frame-${String(index).padStart(4, '0')}.jpg`) { throw new Error('Frames must be contiguous from frame-0000.jpg'); }
});
const output = path.resolve(values.out);
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-clip-encode-'));
function encode(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2', '-framerate', String(fps), '-i', path.join(frames, 'frame-%04d.jpg'),
    ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { throw new Error(`FFmpeg failed: ${result.status}`); }
}
try {
  const mp4 = path.join(temporary, `${values.name}.mp4`);
  const gif = path.join(temporary, `${values.name}.gif`);
  encode(['-vf', `crop=${values.crop},scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', mp4]);
  encode(['-filter_complex', `crop=${values.crop},split[a][b];` +
    '[a]palettegen=max_colors=128:stats_mode=diff[p];' +
    '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', gif]);
  if (fs.statSync(gif).size > 2 * 1024 * 1024) {
    throw new Error('GIF exceeds the 2 MiB budget; shorten the flow or reduce the crop before publishing');
  }
  const report = { name: values.name, width, height, fps, frames: files.length,
    durationSeconds: files.length / fps, gifBytes: fs.statSync(gif).size, mp4Bytes: fs.statSync(mp4).size };
  for (const file of [mp4, gif]) { fs.copyFileSync(file, path.join(output, path.basename(file))); }
  fs.writeFileSync(path.join(output, `${values.name}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
