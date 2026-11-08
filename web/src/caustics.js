// The caustics layer: a wobbly net of light, as sunlight through the ripples above.
//
//   buildCaustics(seed) -> HTMLCanvasElement[16]   64×64 tiles, tileable at their edges
//   renderRegion(seed, frame, width, height)       the same light over any region, for tests
//   draw(ctx, state, now) / rebuild(state)          the layer contract (web/src/main.js)
//   currentFrame()                                  the frame drawn last
//
// The net is the edges of a Worley (cellular) pattern on a 64×64 torus: a pixel is lit
// where its nearest two feature points are almost equally near (F2 − F1 small). Each
// point circles once per 16 frames and the domain is warped by sines of whole periods,
// so the pattern repeats exactly every 64 px and every 16 frames. Strands are about 1 px
// wide, in three hard levels (no smoothing), all at most 0.18 alpha: a slow swell dims
// some strands to a trace, and the brightest marks knots where three cells meet. Frames advance at 8 fps and hold frame 0 under reduced motion.
//
// The outermost pond pixel ring is left unlit so the page edge (sampled from the
// bottom-right pixel) keeps one steady color.

import { createRandom, seedOf } from './rand.js';

export const name = 'caustics';
export const TILE = 64;
export const FRAMES = 16;
export const FPS = 8;
const SALT = 0xca057;
const GRID = 3; // feature points on a jittered 3×3 grid: cells about 21 px across
const LIGHT = [220, 255, 236];
// Alphas out of 255; 0.18 × 255 = 45.9.
const KNOT = 40;
const LINE = 24;
const FAINT = 11;
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

function render(list, frame, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
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
  canvas.getContext('2d').putImageData(image, 0, 0);
  return canvas;
}

export function renderRegion(seed, frame, width, height) {
  return render(points(seed), frame, width, height);
}

export function buildCaustics(seed) {
  const list = points(seed);
  return Array.from({ length: FRAMES }, (_, frame) => render(list, frame, TILE, TILE));
}

let built = { seed: null, tiles: [], patterns: new WeakMap() };
let frameShown = 0;

export function seedFor(state) {
  return seedOf(state.snapshot?.account_id ?? 0, SALT);
}

export function rebuild(state) {
  const seed = seedFor(state);
  if (built.seed === seed) return;
  built = { seed, tiles: buildCaustics(seed), patterns: new WeakMap() };
}

export function frames() {
  return built.tiles;
}

export function currentFrame() {
  return frameShown;
}

export function draw(ctx, state, now) {
  if (!built.tiles.length) rebuild(state);
  let patterns = built.patterns.get(ctx);
  if (!patterns) {
    patterns = built.tiles.map((tile) => ctx.createPattern(tile, 'repeat'));
    built.patterns.set(ctx, patterns);
  }
  frameShown = state.reducedMotion ? 0 : Math.floor((now * FPS) / 1000) % FRAMES;
  const { pondWidth, pondHeight } = state.view;
  ctx.fillStyle = patterns[frameShown];
  ctx.fillRect(1, 1, pondWidth - 2, pondHeight - 2);
}
