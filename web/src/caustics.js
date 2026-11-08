// The caustics layer: soft drifting patches of sunlight through the ripples above.
//
//   buildCaustics(seed) -> HTMLCanvasElement[16]   64×64 tiles, tileable at their edges
//   renderRegion(seed, frame, width, height)       the same light over any region, for tests
//   draw(ctx, state, now) / rebuild(state)          the layer contract (web/src/main.js)
//   currentFrame()                                  the frame drawn last
//   maskMean()                                      the mean strength of the light mask now
//
// The net is the edges of a Worley (cellular) pattern on a 64×64 torus: a pixel is lit
// where its nearest two feature points are almost equally near (F2 − F1 small). Each
// point circles once per 16 frames and the domain is warped by sines of whole periods,
// so the pattern repeats exactly every 64 px and every 16 frames. Strands are about 1 px
// wide, in three hard levels (no smoothing), all at most 0.09 alpha: a slow swell dims
// some strands to a trace, and the brightest marks knots where three cells meet.
//
// The net is only seen through a mask: two layers of large value noise drifting in
// different directions, thresholded so most of the pond is dark at any moment and the
// light falls in soft patches that wander; this also hides the 64 px repeat. Each tile
// is precomputed at LEVELS strengths. Each time the frame changes (8 fps) the mask is
// sampled once per MASK_CELL square, quantized to a level, and each row merged into runs
// of one level; every frame then fills only the lit runs with that level's pattern. A
// lit strand stays one hard pixel, and neighbouring cells differ by one level (about
// 4/255 alpha at most), too little to see. Only source-over fills are used: other composite
// modes cost several ms a frame in software rasterizers. Under reduced motion the frame
// and the mask both hold still.
//
// The outermost pond pixel ring is left unlit so the page edge (sampled from the
// bottom-right pixel) keeps one steady color.

import { createRandom, noise, seedOf } from './rand.js';

export const name = 'caustics';
export const TILE = 64;
export const FRAMES = 16;
export const FPS = 8;
const SALT = 0xca057;
const GRID = 3; // feature points on a jittered 3×3 grid: cells about 21 px across
const LIGHT = [220, 255, 236];
// Alphas out of 255; 0.09 × 255 = 22.95.
const KNOT = 22;
const LINE = 14;
const FAINT = 7;
const MASK_CELL = 24;
const LEVELS = 6;
// Mask drift in pond px a second, for its two noise layers.
const DRIFT = [[5, 2.5], [-3.5, 4]];
const WARP = 1.4;

function points(seed) {
  const random = createRandom(seed);
  const cell = TILE / GRID;
  const list = [];
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      list.push({
        x: (gx + 0.15 + 0.7 * random()) * cell,
        y: (gy + 0.15 + 0.7 * random()) * cell,
        radius: random.range(1.5, 3),
        phase: random() * Math.PI * 2,
        turn: random.chance(0.5) ? 1 : -1,
      });
    }
  }
  return list;
}

// Distances on the torus: the nearest copy of a point, whichever tile it is in.
function wrap(delta) {
  return delta - TILE * Math.round(delta / TILE);
}

function lightAt(list, frame, x, y) {
  const t = frame / FRAMES;
  const wx = x + WARP * Math.sin(2 * Math.PI * (2 * y / TILE + t));
  const wy = y + WARP * Math.sin(2 * Math.PI * (2 * x / TILE + t + 0.3));
  let f1 = Infinity;
  let f2 = Infinity;
  let f3 = Infinity;
  for (const point of list) {
    const angle = point.phase + point.turn * 2 * Math.PI * t;
    const dx = wrap(wx - point.x - point.radius * Math.cos(angle));
    const dy = wrap(wy - point.y - point.radius * Math.sin(angle));
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < f1) {
      f3 = f2;
      f2 = f1;
      f1 = d;
    } else if (d < f2) {
      f3 = f2;
      f2 = d;
    } else if (d < f3) {
      f3 = d;
    }
  }
  const edge = f2 - f1;
  if (edge >= 1) return 0;
  // Light gathers unevenly: a slow swell (whole periods, so it tiles) dims some strands
  // to a faint trace, so the net never reads as a regular grid.
  const swell = Math.sin(2 * Math.PI * (x / TILE + 2 * y / TILE - t)) + Math.sin(2 * Math.PI * (3 * x / TILE - y / TILE + 0.4));
  if (swell < -0.6) return FAINT;
  return f3 - f1 < 3.4 && swell > 0.3 ? KNOT : LINE;
}

function toCanvas(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d').putImageData(image, 0, 0);
  return canvas;
}

// The light as straight (not premultiplied) RGBA.
function renderImage(list, frame, width, height) {
  const image = new ImageData(width, height);
  const data = image.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = lightAt(list, frame, x + 0.5, y + 0.5);
      if (!alpha) continue;
      const index = (y * width + x) * 4;
      data[index] = LIGHT[0];
      data[index + 1] = LIGHT[1];
      data[index + 2] = LIGHT[2];
      data[index + 3] = alpha;
    }
  }
  return image;
}

export function renderRegion(seed, frame, width, height) {
  return toCanvas(renderImage(points(seed), frame, width, height));
}

function tileImages(seed) {
  const list = points(seed);
  return Array.from({ length: FRAMES }, (_, frame) => renderImage(list, frame, TILE, TILE));
}

export function buildCaustics(seed) {
  return tileImages(seed).map(toCanvas);
}

const EMPTY_LIGHT = { key: null, width: 0, height: 0, runs: [], mean: 0 };
let built = { seed: null, tiles: [], levels: [], patterns: new WeakMap() };
let frameShown = 0;
let light = EMPTY_LIGHT;
let builds = 0;

// Seeded from state.accountId; null (the account not known yet) means no seed.
export function seedFor(state) {
  return state.accountId === null || state.accountId === undefined ? null : seedOf(state.accountId, SALT);
}

// Each frame at each strength: the tile's alpha scaled by level / LEVELS, made from the
// rendered arrays (not read back from a canvas, which would round through premultiplied
// alpha).
function levelTiles(images) {
  return images.map((source) =>
    Array.from({ length: LEVELS }, (_, index) => {
      const image = new ImageData(new Uint8ClampedArray(source.data), TILE, TILE);
      for (let p = 3; p < image.data.length; p += 4) image.data[p] = Math.round((source.data[p] * (index + 1)) / LEVELS);
      return toCanvas(image);
    }),
  );
}

export function rebuild(state) {
  const seed = seedFor(state);
  if (seed === null || built.seed === seed) return;
  const images = tileImages(seed);
  built = { seed, tiles: images.map(toCanvas), levels: levelTiles(images), patterns: new WeakMap() };
  light = EMPTY_LIGHT;
  builds += 1;
}

export function buildCount() {
  return builds;
}

// For measuring without disturbing the live pond (main.js layerCost).
export function saveState() {
  return { light, frameShown };
}

export function restoreState(saved) {
  ({ light, frameShown } = saved);
}

export function liveState() {
  return { frame: frameShown, key: light.key, mean: light.mean };
}

export function frames() {
  return built.tiles;
}

export function currentFrame() {
  return frameShown;
}

export function maskMean() {
  return light.mean;
}

// Light strength in [0, 1] at pond pixel (x, y) and time t (s): soft patches covering
// a minority of the pond, fading out toward the walls.
function maskAt(x, y, t, width, height, seed) {
  const a = noise(x - DRIFT[0][0] * t, y - DRIFT[0][1] * t, 230, seed + 11);
  const b = noise(x - DRIFT[1][0] * t, y - DRIFT[1][1] * t, 140, seed + 12);
  const value = 0.6 * a + 0.4 * b;
  const patch = Math.max(0, Math.min(1, (value - 0.52) / 0.2));
  const wall = Math.min(x, y, width - x, height - y);
  return patch * patch * Math.max(0, Math.min(1, (wall - 8) / 40));
}

// The lit runs: [x, y, width, height, level] in pond pixels, inside the 1 px rim, and the
// mask's mean strength (0 for a pond too small to hold a cell).
export function measureLight(width, height, t, seed = built.seed ?? 0) {
  const runs = [];
  let sum = 0;
  let cells = 0;
  for (let top = 1; top < height - 1; top += MASK_CELL) {
    const rowHeight = Math.min(MASK_CELL, height - 1 - top);
    let start = 1;
    let current = 0;
    for (let left = 1; left < width - 1; left += MASK_CELL) {
      const value = maskAt(left + MASK_CELL / 2, top + MASK_CELL / 2, t, width, height, seed);
      sum += value;
      cells += 1;
      const level = Math.round(value * LEVELS);
      if (level !== current) {
        if (current) runs.push([start, top, left - start, rowHeight, current]);
        start = left;
        current = level;
      }
    }
    if (current) runs.push([start, top, width - 1 - start, rowHeight, current]);
  }
  return { runs, mean: cells ? sum / cells : 0 };
}

export function draw(ctx, state, now) {
  if (!built.tiles.length) rebuild(state);
  if (!built.tiles.length) return; // the account is not known yet
  const { pondWidth, pondHeight } = state.view;
  // Time steps with the frames, so the patches drift in 8 fps steps along with the net.
  const step = state.reducedMotion ? 0 : Math.floor((now * FPS) / 1000);
  frameShown = step % FRAMES;
  if (light.key !== step || light.width !== pondWidth || light.height !== pondHeight) {
    light = { key: step, width: pondWidth, height: pondHeight, ...measureLight(pondWidth, pondHeight, step / FPS) };
  }
  let patterns = built.patterns.get(ctx);
  if (!patterns) {
    patterns = built.levels.map((levels) => levels.map((tile) => ctx.createPattern(tile, 'repeat')));
    built.patterns.set(ctx, patterns);
  }
  const levels = patterns[frameShown];
  for (const [x, y, width, height, level] of light.runs) {
    ctx.fillStyle = levels[level - 1];
    ctx.fillRect(x, y, width, height);
  }
}
