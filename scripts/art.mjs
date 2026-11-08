// Turn the pixel-art grids in art/ into PNGs for the site.
//
//   node scripts/art.mjs           write web/art/<name>.png and web/art/sprites.json
//   node scripts/art.mjs --check   validate the grids and the written files; exit 1 on
//                                  any problem, writing nothing
//
// A grid is art/<name>.txt: one character per pixel, '.' transparent, every other
// character a color from the legend in art/palette.json. Lines starting with '#' are
// comments, except `# anchor X Y`, the sprite's anchor in its own pixels (where the code
// places it: a pad's center, a flower's or bud's base); without one the anchor is the
// sprite's center, rounded down. Blank lines are ignored.
//
// sprites.json maps each name to {width, height, anchor: [x, y]}. The PNGs are 8-bit
// RGBA with alpha 0 or 255, written by the small encoder below on Node's zlib.
//
// --check fails if a grid uses a character missing from the legend, if its rows differ
// in width, if any sprite in SPRITES has no grid (or a grid is not in SPRITES), if any
// PNG pixel is not a palette color or has alpha other than 0 or 255, or if a PNG or
// sprites.json is missing or does not match its grid (run the script without --check).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'art');
const OUT = join(ROOT, 'web', 'art');

export const SPRITES = [
  'pad-16', 'pad-24', 'pad-32', 'pad-40', 'pad-48',
  'lotus-pink-s', 'lotus-pink-l', 'lotus-white-s', 'lotus-white-l', 'lotus-purple-s', 'lotus-purple-l',
  'bud',
  'droplet',
  'moon-reflection',
  'firefly-0', 'firefly-1',
  'food',
];

// ---------------------------------------------------------------------------------------
// PNG: 8-bit RGBA, non-interlaced. The writer uses filter 0 on every row; the reader
// accepts all five filters so a PNG touched by another tool still checks.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('not 8-bit non-interlaced RGBA');
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown filter ${filter}`);
      rgba[y * stride + i] = (line[i] + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------------------
// Grids.

function hexToRgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function readPalette(problems) {
  const palette = JSON.parse(readFileSync(join(ART, 'palette.json'), 'utf8'));
  const legend = new Map();
  for (const [char, entry] of Object.entries(palette.legend ?? {})) {
    const rgb = hexToRgb(entry.color ?? '');
    if (char.length !== 1 || char === '.' || char === '#' || !rgb) {
      problems.push(`palette.json: bad legend entry ${JSON.stringify(char)}`);
      continue;
    }
    legend.set(char, { ...entry, rgb });
  }
  return legend;
}

// Parse art/<name>.txt into {width, height, rows, anchor}, pushing problems.
export function readGrid(name, legend, problems) {
  const lines = readFileSync(join(ART, `${name}.txt`), 'utf8').split('\n');
  const rows = [];
  let anchor = null;
  for (const line of lines) {
    const text = line.replace(/\r$/, '');
    if (text.trim() === '') continue;
    if (text.startsWith('#')) {
      const match = /^#\s*anchor\s+(\d+)\s+(\d+)\s*$/.exec(text);
      if (match) anchor = [Number(match[1]), Number(match[2])];
      continue;
    }
    rows.push(text);
  }
  const width = rows.length ? rows[0].length : 0;
  const height = rows.length;
  if (!height || !width) problems.push(`${name}: empty grid`);
  rows.forEach((row, y) => {
    if (row.length !== width) problems.push(`${name}: row ${y + 1} is ${row.length} wide, not ${width}`);
    [...row].forEach((char, x) => {
      if (char !== '.' && !legend.has(char)) problems.push(`${name}: '${char}' at ${x},${y} is not in the palette`);
    });
  });
  anchor ??= [Math.floor(width / 2), Math.floor(height / 2)];
  if (anchor[0] >= width || anchor[1] >= height) problems.push(`${name}: anchor ${anchor} is outside the sprite`);
  return { width, height, rows, anchor };
}

export function rasterize({ width, height, rows }, legend) {
  const rgba = Buffer.alloc(width * height * 4);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const entry = legend.get(row[x]);
      if (!entry) continue;
      rgba.set([...entry.rgb, 255], (y * width + x) * 4);
    }
  });
  return rgba;
}

function checkPixels(name, { width, height, rgba }, legend, problems) {
  const colors = new Set([...legend.values()].map(({ rgb }) => rgb.join(',')));
  let bad = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha === 0) continue;
    if (alpha !== 255 || !colors.has(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`)) bad++;
  }
  if (bad) problems.push(`${name}.png: ${bad} pixels are not opaque palette colors or fully transparent`);
}

function main() {
  const checking = process.argv.includes('--check');
  const problems = [];
  if (!existsSync(join(ART, 'palette.json'))) {
    console.error('art/palette.json is missing');
    process.exit(1);
  }
  const legend = readPalette(problems);
  const present = existsSync(ART)
    ? readdirSync(ART).filter((file) => file.endsWith('.txt')).map((file) => file.slice(0, -4))
    : [];
  for (const name of present) if (!SPRITES.includes(name)) problems.push(`art/${name}.txt is not a known sprite`);

  const manifest = {};
  const images = {};
  for (const name of SPRITES) {
    if (!present.includes(name)) {
      problems.push(`${name}: art/${name}.txt is missing`);
      continue;
    }
    const grid = readGrid(name, legend, problems);
    images[name] = { ...grid, rgba: rasterize(grid, legend) };
    manifest[name] = { width: grid.width, height: grid.height, anchor: grid.anchor };
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  if (checking) {
    for (const name of SPRITES) {
      const file = join(OUT, `${name}.png`);
      if (!existsSync(file)) {
        problems.push(`web/art/${name}.png is missing`);
        continue;
      }
      let png;
      try {
        png = decodePng(readFileSync(file));
      } catch (error) {
        problems.push(`web/art/${name}.png: ${error.message}`);
        continue;
      }
      checkPixels(name, png, legend, problems);
      const image = images[name];
      if (image && (png.width !== image.width || png.height !== image.height || !png.rgba.equals(image.rgba))) {
        problems.push(`web/art/${name}.png does not match art/${name}.txt`);
      }
    }
    const manifestFile = join(OUT, 'sprites.json');
    if (!existsSync(manifestFile) || readFileSync(manifestFile, 'utf8') !== manifestText) {
      problems.push('web/art/sprites.json is missing or does not match the grids');
    }
  }

  if (problems.length) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    if (!checking) console.error('nothing written');
    process.exit(1);
  }
  if (checking) {
    console.log(`art ok: ${SPRITES.length} sprites, ${legend.size} palette colors`);
    return;
  }
  mkdirSync(OUT, { recursive: true });
  for (const name of SPRITES) {
    const { width, height, rgba } = images[name];
    writeFileSync(join(OUT, `${name}.png`), encodePng(width, height, rgba));
  }
  writeFileSync(join(OUT, 'sprites.json'), manifestText);
  console.log(`wrote ${SPRITES.length} sprites to web/art/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
