// The floor layer: sand, pebbles, rocks and water plants under clear, shallow water.
//
//   buildFloor(pondWidth, pondHeight, seed) -> HTMLCanvasElement   deterministic per inputs
//   draw(ctx, state) / rebuild(state)    the layer contract (web/src/main.js)
//   current()                            {canvas, hash, accountId, detail} for the last build
//
// The floor is painted once per rebuild into one bitmap, and each frame only blits it.
// Painted bottom up, all hard-edged pixels:
//   1. Sand: three close tones, chosen by two octaves of value noise plus faint ripple
//      marks, so they fall in small organic clusters rather than per-pixel speckle.
//   2. Pebbles: 1–3 px, five colors, each with a 1 px darker underside; denser in
//      gravel patches.
//   3. Rocks: 3–6 rounded clusters, 10–30 px: a rock of 2–3 lobes and up to two small
//      stones, shaded from a top-left light
//      in five tones (lit top-left rim, dark bottom-right rim), with a few pits and a
//      soft 2 px shadow to the bottom right. The first rock sits beside a plant clump.
//   4. Water plants: clumps of 1 px leaves rooted at the walls only, in three greens,
//      each leaf casting a 1 px shadow.
//   5. Water: every color is mixed toward the water's teal, then a 24 px band at the
//      walls darkens toward EDGE in dithered steps, with rounded corners. The outermost
//      pixel ring is EDGE exactly, so the page edge color blends all the way round.
// The palette is kept mid-to-dark and low in contrast so the black, orange and white koi
// reads clearly over it.

import { createRandom, hash2, seedOf } from './rand.js';

export const name = 'floor';
const SALT = 0xf1003;
export const VIGNETTE = 24;
export const DETAIL = { width: 160, height: 100 };

// Colors before the water: the water mixes TINT of WATER into each.
const SAND = [[126, 116, 90], [136, 126, 98], [147, 136, 106]];
const PEBBLES = [[176, 168, 142], [128, 122, 108], [170, 140, 108], [150, 150, 136], [194, 186, 162]];
const ROCK = [[60, 60, 56], [86, 86, 80], [112, 111, 100], [140, 137, 120], [170, 165, 144]];
const LEAVES = [[44, 92, 54], [66, 128, 66], [100, 158, 78]];
const WATER = [22, 70, 68];
const TINT = 0.42;
export const EDGE = [14, 36, 37];
// Darkening of whatever a shadow falls on, nearest first.
const SHADOW = [0.64, 0.8];
const LEAF_SHADOW = 0.8;

// 4×4 ordered dither thresholds in [0, 1).
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);

function smooth(t) {
  return t * t * (3 - 2 * t);
}

// Value noise in [0, 1) on a lattice of the given cell size.
function noise(x, y, cell, seed) {
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = smooth(fx - ix);
  const ty = smooth(fy - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

function createPainter(width, height) {
  const rgb = new Float32Array(width * height * 3);
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  return {
    rgb,
    set(x, y, color) {
      if (!inside(x, y)) return;
      const index = (y * width + x) * 3;
      rgb[index] = color[0];
      rgb[index + 1] = color[1];
      rgb[index + 2] = color[2];
    },
    darken(x, y, factor) {
      if (!inside(x, y)) return;
      const index = (y * width + x) * 3;
      rgb[index] *= factor;
      rgb[index + 1] *= factor;
      rgb[index + 2] *= factor;
    },
  };
}

function scaleColor(color, factor) {
  return color.map((value) => value * factor);
}

function paintSand(paint, width, height, seed) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const broad = noise(x, y, 40, seed);
      const fine = noise(x, y, 3.2, seed + 1);
      const ripple = Math.sin((x * 0.55 + y) / 6.5 + broad * 5);
      const value = 0.3 * broad + 0.58 * fine + 0.06 * ripple;
      const tone = value < 0.38 ? 0 : value < 0.6 ? 1 : 2;
      paint.set(x, y, SAND[tone]);
    }
  }
}

const PEBBLE_SHAPES = [
  [[0, 0]],
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1]],
  [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
];
const PEBBLE_WEIGHTS = [0.36, 0.2, 0.12, 0.08, 0.12, 0.07, 0.05];

function pickShape(random) {
  let roll = random();
  for (let index = 0; index < PEBBLE_SHAPES.length; index += 1) {
    roll -= PEBBLE_WEIGHTS[index];
    if (roll < 0) return PEBBLE_SHAPES[index];
  }
  return PEBBLE_SHAPES[0];
}

function paintPebbles(paint, width, height, random, seed) {
  const tries = Math.round((width * height) / 150);
  for (let count = 0; count < tries; count += 1) {
    const x = random.int(3, width - 6);
    const y = random.int(3, height - 6);
    // Gravel gathers in patches; between them the sand is nearly bare.
    const patch = noise(x, y, 70, seed + 2);
    if (random() > Math.max(0.05, (patch - 0.42) * 2.6)) continue;
    const shape = pickShape(random);
    const color = random.pick(PEBBLES);
    const under = scaleColor(color, 0.7);
    const bottoms = new Map();
    for (const [dx, dy] of shape) bottoms.set(dx, Math.max(bottoms.get(dx) ?? -1, dy));
    for (const [dx, dy] of shape) {
      // Larger pebbles catch the light on their top-left pixel.
      const lit = shape.length > 2 && dx === shape[0][0] && dy === shape[0][1];
      paint.set(x + dx, y + dy, lit ? scaleColor(color, 1.1) : color);
    }
    for (const [dx, dy] of bottoms) paint.set(x + dx, y + dy + 1, under);
  }
}

// A rock as a height field: the highest of 2–3 domes, roughened at the outline.
function makeRock(random, cx, cy, radius, seed) {
  const lobes = [{ x: 0, y: 0, rx: radius, ry: radius * random.range(0.68, 0.88), height: 1 }];
  const extra = random.int(1, 2);
  for (let index = 0; index < extra; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = radius * random.range(0.45, 0.75);
    const size = radius * random.range(0.45, 0.7);
    lobes.push({
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance * 0.8,
      rx: size,
      ry: size * random.range(0.7, 0.95),
      height: random.range(0.7, 0.9),
    });
  }
  const height = (x, y) => {
    let best = -1;
    for (const lobe of lobes) {
      const u = (x - lobe.x) / lobe.rx;
      const v = (y - lobe.y) / lobe.ry;
      best = Math.max(best, lobe.height * (1 - u * u - v * v));
    }
    return best + 0.16 * (noise(cx + x, cy + y, 2.6, seed + 3) - 0.5);
  };
  const reach = Math.ceil(radius * 1.9) + 2;
  return { cx, cy, radius, reach, height };
}

function rockMask(rock) {
  const size = rock.reach * 2 + 1;
  const mask = new Float32Array(size * size).fill(-1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) mask[y * size + x] = rock.height(x - rock.reach, y - rock.reach);
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? -1 : mask[y * size + x]);
  return { size, at };
}

function paintRockShadow(paint, rock, mask) {
  const { size, at } = mask;
  const left = Math.round(rock.cx) - rock.reach;
  const top = Math.round(rock.cy) - rock.reach;
  for (let y = 0; y < size + 2; y += 1) {
    for (let x = 0; x < size + 2; x += 1) {
      if (at(x, y) > 0) continue;
      if (at(x - 1, y - 1) > 0 || at(x - 1, y) > 0 || at(x, y - 1) > 0) paint.darken(left + x, top + y, SHADOW[0]);
      else if (at(x - 2, y - 2) > 0 || at(x - 2, y - 1) > 0 || at(x - 1, y - 2) > 0) paint.darken(left + x, top + y, SHADOW[1]);
    }
  }
}

function paintRock(paint, rock, mask, seed) {
  const { size, at } = mask;
  const left = Math.round(rock.cx) - rock.reach;
  const top = Math.round(rock.cy) - rock.reach;
  const light = [-0.55, -0.62, 0.56];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const h = at(x, y);
      if (h <= 0) continue;
      // Shade from the slope of the height field, lit from the top left.
      const gx = ((at(x + 1, y) - at(x - 1, y)) / 2) * rock.radius;
      const gy = ((at(x, y + 1) - at(x, y - 1)) / 2) * rock.radius;
      const length = Math.hypot(gx, gy, 1);
      const lambert = (-gx * light[0] - gy * light[1] + light[2]) / length;
      const dither = BAYER[((y & 3) << 2) | (x & 3)] - 0.5;
      let tone = Math.round(1.2 + lambert * 3.2 + dither * 0.5);
      if (noise(left + x, top + y, 2.2, seed + 4) > 0.84) tone -= 1; // pits
      // A hard rim: dark where the rock meets the sand at the bottom right, lit at the top left.
      if (at(x + 1, y + 1) <= 0 || at(x, y + 1) <= 0) tone = Math.min(tone, 0);
      else if (at(x - 1, y - 1) <= 0 || at(x - 1, y) <= 0 || at(x, y - 1) <= 0) tone = Math.max(tone, 3);
      paint.set(left + x, top + y, ROCK[Math.max(0, Math.min(ROCK.length - 1, tone))]);
    }
  }
}

// Plant clumps sit along the walls; returns each clump's base and inward direction.
function placeClumps(width, height, random) {
  const perimeter = 2 * (width + height);
  const count = Math.max(3, Math.min(10, Math.round(perimeter / 440)));
  const clumps = [];
  // The first clump sits on the left wall, below the header, for the detail crop.
  clumps.push({ x: random.int(3, 6), y: Math.round(height * random.range(0.45, 0.7)), angle: 0 });
  let attempts = 0;
  while (clumps.length < count && attempts < 400) {
    attempts += 1;
    const along = random() * perimeter;
    const inset = random.int(3, 8);
    let clump;
    if (along < width) clump = { x: along, y: inset, angle: Math.PI / 2 };
    else if (along < width + height) clump = { x: width - 1 - inset, y: along - width, angle: Math.PI };
    else if (along < 2 * width + height) clump = { x: along - width - height, y: height - 1 - inset, angle: -Math.PI / 2 };
    else clump = { x: inset, y: along - 2 * width - height, angle: 0 };
    // Toward the middle of the pond near a corner, so corner clumps lean out of it.
    const towardCenter = Math.atan2(height / 2 - clump.y, width / 2 - clump.x);
    const nearCorner = Math.min(clump.x, width - clump.x) < 40 && Math.min(clump.y, height - clump.y) < 40;
    if (nearCorner) clump.angle = towardCenter;
    clump.x = Math.round(clump.x);
    clump.y = Math.round(clump.y);
    if (clumps.some((other) => Math.hypot(other.x - clump.x, other.y - clump.y) < perimeter / count / 2)) continue;
    clumps.push(clump);
  }
  return clumps;
}

function leafPixels(clump, random, scale) {
  const angle0 = clump.angle + random.range(-0.6, 0.6);
  const length = random.range(18, 46) * scale;
  const bend = random.range(-0.045, 0.045);
  const along = random.range(-7, 7);
  let x = clump.x + 0.5 - Math.sin(clump.angle) * along;
  let y = clump.y + 0.5 + Math.cos(clump.angle) * along;
  let angle = angle0;
  const pixels = [];
  let last = '';
  for (let step = 0; step < length; step += 0.5) {
    const key = `${Math.floor(x)},${Math.floor(y)}`;
    if (key !== last) pixels.push([Math.floor(x), Math.floor(y), step / length]);
    last = key;
    // Leaves bend more toward the tip, as they sway in the water.
    angle += bend * (0.6 + step / length);
    x += Math.cos(angle) * 0.5;
    y += Math.sin(angle) * 0.5;
  }
  return pixels;
}

function paintPlants(paint, clumps, random, scale) {
  const leaves = [];
  for (const clump of clumps) {
    const count = random.int(8, 14);
    for (let index = 0; index < count; index += 1) {
      leaves.push({ pixels: leafPixels(clump, random, scale), color: random.chance(0.55) ? 1 : 2 });
    }
  }
  for (const leaf of leaves) {
    for (const [x, y] of leaf.pixels) paint.darken(x + 1, y + 2, LEAF_SHADOW);
  }
  for (const leaf of leaves) {
    for (const [x, y, t] of leaf.pixels) paint.set(x, y, LEAVES[t < 0.3 ? 0 : leaf.color]);
  }
}

function placeRocks(width, height, clumps, random) {
  const count = random.int(3, 6);
  const rocks = [];
  const first = clumps[0];
  rocks.push({ x: first.x + random.int(52, 70), y: first.y + random.int(-16, 16), radius: random.range(9, 13) });
  let attempts = 0;
  while (rocks.length < count && attempts < 400) {
    attempts += 1;
    const radius = random.range(6, 15);
    const margin = VIGNETTE + radius;
    if (width <= 2 * margin || height <= 2 * margin) break;
    const rock = { x: random.range(margin, width - margin), y: random.range(margin, height - margin), radius };
    if (rocks.some((other) => Math.hypot(other.x - rock.x, other.y - rock.y) < (other.radius + rock.radius) * 2.4)) continue;
    rocks.push(rock);
  }
  return rocks;
}

function finish(paint, width, height) {
  const image = new ImageData(width, height);
  const out = image.data;
  const { rgb } = paint;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Distance into the pond, with rounded corners.
      const dx = Math.min(x, width - 1 - x);
      const dy = Math.min(y, height - 1 - y);
      let depth = Math.min(dx, dy);
      if (dx < VIGNETTE && dy < VIGNETTE) depth = Math.max(0, VIGNETTE - Math.hypot(VIGNETTE - dx, VIGNETTE - dy));
      const t = Math.max(0, 1 - depth / VIGNETTE);
      const steps = 6;
      const shade = Math.min(1, Math.floor(t * t * steps + BAYER[((y & 3) << 2) | (x & 3)]) / steps);
      const index = (y * width + x) * 3;
      const target = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const under = rgb[index + c] * (1 - TINT) + WATER[c] * TINT;
        out[target + c] = Math.round(under + (EDGE[c] - under) * (depth === 0 ? 1 : shade));
      }
      out[target + 3] = 255;
    }
  }
  return image;
}

function lay(width, height, seed) {
  const random = createRandom(seed);
  const paint = createPainter(width, height);
  const scale = Math.max(0.6, Math.min(1, Math.min(width, height) / 700));
  paintSand(paint, width, height, seed);
  paintPebbles(paint, width, height, random, seed);
  const clumps = placeClumps(width, height, random);
  const rocks = [];
  for (const spot of placeRocks(width, height, clumps, random)) {
    rocks.push(makeRock(random, spot.x, spot.y, spot.radius, seed));
    // A cluster: up to two small stones beside the rock, inside its 10–30 px footprint.
    const stones = random.int(0, 2);
    for (let index = 0; index < stones; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = spot.radius + random.range(1.5, 3.5);
      const stone = random.range(2.2, 3.6);
      rocks.push(makeRock(random, spot.x + Math.cos(angle) * (distance + stone), spot.y + Math.sin(angle) * (distance + stone) * 0.8, stone, seed));
    }
  }
  const masks = rocks.map(rockMask);
  rocks.forEach((rock, index) => paintRockShadow(paint, rock, masks[index]));
  rocks.forEach((rock, index) => paintRock(paint, rock, masks[index], seed));
  paintPlants(paint, clumps, random, scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(finish(paint, width, height), 0, 0);
  const first = rocks[0];
  const detail = {
    x: Math.max(0, Math.min(width - DETAIL.width, clumps[0].x - 4)),
    y: Math.max(0, Math.min(height - DETAIL.height, Math.round(first.cy - DETAIL.height / 2))),
  };
  return { canvas, detail };
}

export function buildFloor(pondWidth, pondHeight, seed) {
  return lay(pondWidth, pondHeight, seed).canvas;
}

function hashCanvas(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let hash = 2166136261;
  for (let index = 0; index < data.length; index += 1) hash = Math.imul(hash ^ data[index], 16777619);
  return hash >>> 0;
}

let built = null;

export function current() {
  return built;
}

export function rebuild(state) {
  const { pondWidth, pondHeight } = state.view;
  const accountId = state.snapshot?.account_id ?? null;
  const seed = seedOf(accountId ?? 0, SALT);
  if (built && built.width === pondWidth && built.height === pondHeight && built.seed === seed) {
    built.accountId = accountId;
    return;
  }
  const { canvas, detail } = lay(pondWidth, pondHeight, seed);
  built = { canvas, detail, seed, accountId, width: pondWidth, height: pondHeight, hash: hashCanvas(canvas) };
}

export function draw(ctx, state) {
  const { pondWidth, pondHeight } = state.view;
  if (!built || built.width !== pondWidth || built.height !== pondHeight) rebuild(state);
  ctx.drawImage(built.canvas, 0, 0);
}
