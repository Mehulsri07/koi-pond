// The floor layer: a shallow-banked pond deepening toward the middle, with plant beds
// and rock groups along the walls.
//
//   buildFloor(pondWidth, pondHeight, seed, {top}) -> HTMLCanvasElement
//   layFloor(pondWidth, pondHeight, seed, {top}) -> {canvas, detail, bedShare, rockGroups, stones}
//   draw(ctx, state) / rebuild(state)    the layer contract (web/src/main.js)
//   current()   {canvas, hash, accountId, detail, bedShare, ...} for the last build
//   buildCount()  floors laid since load
//
// The same inputs give the same floor in a given browser. Floating-point functions such
// as Math.sin may differ in the last bit between engines, so the pixels (and floorHash)
// are not promised to match across browsers.
//
// The floor is laid only once state.accountId is known (web/src/main.js); until then it
// draws a plain EDGE fill, so no stand-in floor flashes before the account's own.
// `top` is the band at the top of the pond (pond px) where rock groups are not rooted,
// because the header covers it: the larger of 15% of the pond's height and the header
// plus 24 px. On short or narrow ponds the beds get thin and the rock groups degrade: a
// second pass relaxes their spacing and depth, and a pond too small for any still lays
// sand, beds and light with no rocks at all.
//
// The floor is painted once per rebuild into one bitmap; each frame only blits it.
// Painted bottom up, all hard-edged pixels:
//   1. Sand: three close tones from two octaves of value noise and faint ripple marks,
//      in small clusters.
//   2. Pebbles (1–3 px, each with a 1 px darker underside) and a few fallen leaves
//      (3–6 px, ochre and brown, with a darker midrib), both mostly in the shallows.
//   3. Plant beds: ragged bands along the walls, thickest in the corners, sized to
//      cover BED_SHARE of the pond. Each is a dark undergrowth under dense 1 px reeds in
//      five greens (darker first, lighter on top, each with a 1 px shadow) and a scatter
//      of small round leaves.
//   4. Rock groups: 2–4 groups of 3–6 stones, 12–40 px, nestled into the inner edge of
//      the beds (no reeds root on them; reeds around them stand behind). Each stone is
//      shaded from a top-left light in five tones (lit top-left rim, dark bottom-right
//      rim) and casts a soft 2 px shadow over the reeds and sand.
//   5. Water: every color is mixed toward the water's teal, then toward DEEP by the
//      depth, which rises from the banks to the middle in dithered steps, so deep water
//      reads darker and the middle, where the koi swims, stays calm and dark. Faint
//      sediment specks keep the deep from looking flat. A 24 px band at the walls darkens
//      toward EDGE; the outermost pixel ring is EDGE exactly, so the page edge color
//      blends all the way round.

import { createRandom, noise, seedOf } from './rand.js';

export const name = 'floor';
const SALT = 0xf1003;
export const VIGNETTE = 24;
export const DETAIL = { width: 160, height: 100 };
export const BED_SHARE = 0.09;

// Colors before the water: the water mixes TINT of WATER into each.
const SAND = [[128, 120, 92], [138, 129, 99], [149, 139, 107]];
const PEBBLES = [[176, 168, 142], [128, 122, 108], [170, 140, 108], [150, 150, 136], [194, 186, 162]];
const FALLEN = [[184, 132, 60], [156, 100, 50], [196, 156, 82], [132, 84, 44]];
const ROCK = [[52, 54, 52], [78, 80, 75], [102, 103, 94], [128, 127, 113], [154, 150, 132]];
const UNDERGROWTH = [[22, 50, 34], [30, 64, 40], [40, 78, 46]];
const REEDS = [[34, 76, 44], [46, 98, 52], [62, 120, 58], [86, 142, 64], [122, 164, 76]];
const REED_WEIGHTS = [0.1, 0.2, 0.3, 0.26, 0.14];
const ROUND_LEAF = [[52, 112, 56], [78, 140, 66], [110, 166, 82]];
const WATER = [30, 92, 88];
const TINT = 0.4;
const DEEP = [16, 46, 50];
const SHALLOWEST = 0.22; // how far the banks mix toward DEEP
const DEEPEST = 0.88; // and the middle
export const EDGE = [10, 30, 32];
// Darkening of whatever a shadow falls on, nearest first.
const SHADOW = [0.62, 0.8];
const LEAF_SHADOW = 0.78;

// 4×4 ordered dither thresholds in [0, 1).
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);
const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function smoothstep(a, b, x) {
  return smooth(Math.max(0, Math.min(1, (x - a) / (b - a))));
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

// The pond's shape: distances to the walls, depth, and the plant beds.
function createGround(width, height, seed) {
  const half = Math.min(width, height) / 2;
  const wallDistance = (x, y) => Math.min(x, y, width - 1 - x, height - 1 - y);
  // Rounder than the walls: half the distance to the walls, half an ellipse.
  const depth = (x, y) => {
    const u = (2 * x) / width - 1;
    const v = (2 * y) / height - 1;
    const round = 1 - Math.sqrt(u * u + v * v) / Math.SQRT2;
    const mixed = 0.5 * (wallDistance(x, y) / half) + 0.6 * round;
    return smoothstep(0.08, 0.72, mixed + 0.22 * (noise(x, y, 120, seed + 7) - 0.5));
  };
  // Inward from the nearest wall; in a corner, toward the middle.
  const inward = (x, y) => {
    const dx = Math.min(x, width - 1 - x);
    const dy = Math.min(y, height - 1 - y);
    if (dx < 60 && dy < 60) return Math.atan2(height / 2 - y, width / 2 - x);
    if (dx < dy) return x < width / 2 ? 0 : Math.PI;
    return y < height / 2 ? Math.PI / 2 : -Math.PI / 2;
  };
  // Bed thickness at a point: patchy along the walls, swelling into the corners.
  const reach = (x, y) => {
    const dx = Math.min(x, width - 1 - x);
    const dy = Math.min(y, height - 1 - y);
    const corner = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / (half * 0.6));
    const patch = Math.max(0, noise(x, y, 150, seed + 5) - 0.32) * 2.2;
    return (patch * patch + 0.9 * corner * corner) * half;
  };
  const ragged = (x, y) => 14 * (noise(x, y, 11, seed + 6) - 0.5) + 6 * (noise(x, y, 4, seed + 9) - 0.5);
  // Scale the beds so they cover BED_SHARE of the pond (measured on a 4 px grid).
  const share = (k) => {
    let inBed = 0;
    let total = 0;
    for (let y = 2; y < height; y += 4) {
      for (let x = 2; x < width; x += 4) {
        total += 1;
        if (wallDistance(x, y) < k * reach(x, y) + ragged(x, y)) inBed += 1;
      }
    }
    return inBed / total;
  };
  let low = 0;
  let high = 1;
  for (let step = 0; step < 14; step += 1) {
    const k = (low + high) / 2;
    if (share(k) < BED_SHARE) low = k;
    else high = k;
  }
  const k = (low + high) / 2;
  // margin: how far inside the bed a pixel is (0 outside), for thinning at its edge.
  const bed = new Uint8Array(width * height);
  const margin = new Float32Array(width * height);
  let bedCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = k * reach(x, y) + ragged(x, y) - wallDistance(x, y);
      if (inside > 0) {
        bed[y * width + x] = 1;
        margin[y * width + x] = inside;
        bedCount += 1;
      }
    }
  }
  const inBed = (x, y) => x >= 0 && y >= 0 && x < width && y < height && bed[y * width + x] === 1;
  return { width, height, half, wallDistance, depth, inward, bed, margin, inBed, bedShare: bedCount / (width * height) };
}

function paintSand(paint, width, height, seed) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const broad = noise(x, y, 40, seed);
      const fine = noise(x, y, 3.2, seed + 1);
      const ripple = Math.sin((x * 0.55 + y) / 6.5 + broad * 5);
      const value = 0.3 * broad + 0.58 * fine + 0.06 * ripple;
      paint.set(x, y, SAND[value < 0.38 ? 0 : value < 0.6 ? 1 : 2]);
    }
  }
}

const PEBBLE_SHAPES = [
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1]],
  [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
];
const PEBBLE_WEIGHTS = [0.5, 0.13, 0.09, 0.14, 0.08, 0.06];

function pickWeighted(random, list, weights) {
  let roll = random();
  for (let index = 0; index < list.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return list[index];
  }
  return list[0];
}

function paintPebbles(paint, ground, random, seed) {
  const { width, height } = ground;
  const tries = width < 9 || height < 9 ? 0 : Math.round((width * height) / 180);
  for (let count = 0; count < tries; count += 1) {
    const x = random.int(3, width - 6);
    const y = random.int(3, height - 6);
    // Gravel gathers in patches in the shallows.
    const patch = noise(x, y, 70, seed + 2);
    const shallow = 1 - ground.depth(x, y);
    if (random() > Math.max(0.03, (patch - 0.4) * 2.6) * shallow * shallow) continue;
    const shape = pickWeighted(random, PEBBLE_SHAPES, PEBBLE_WEIGHTS);
    const color = random.pick(PEBBLES);
    const under = scaleColor(color, 0.7);
    const bottoms = new Map();
    for (const [dx, dy] of shape) bottoms.set(dx, Math.max(bottoms.get(dx) ?? -1, dy));
    for (const [dx, dy] of shape) {
      const lit = shape.length > 2 && dx === shape[0][0] && dy === shape[0][1];
      paint.set(x + dx, y + dy, lit ? scaleColor(color, 1.1) : color);
    }
    for (const [dx, dy] of bottoms) paint.set(x + dx, y + dy + 1, under);
  }
}

// A few fallen leaves: a run of 3–6 px along one of eight directions, widened by a pixel
// to one side through the middle, with a darker midrib and a 1 px shadow.
function paintFallenLeaves(paint, ground, random) {
  const { width, height } = ground;
  // Leaves keep 30 px from the walls; a pond too small for that gets none.
  const count = width < 62 || height < 62 ? 0 : Math.round(5 + (width * height) / 70000);
  const directions = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  let placed = 0;
  for (let attempt = 0; attempt < count * 30 && placed < count; attempt += 1) {
    const x = random.int(30, width - 31);
    const y = random.int(30, height - 31);
    const depth = ground.depth(x, y);
    if (ground.inBed(x, y) || depth < 0.05 || depth > 0.7) continue;
    placed += 1;
    const [dx, dy] = random.pick(directions);
    const length = random.int(3, 6);
    const color = random.pick(FALLEN);
    const rib = scaleColor(color, 0.78);
    const side = random.chance(0.5) ? [-dy, dx] : [dy, -dx];
    const body = [];
    for (let step = 0; step < length; step += 1) {
      const px = x + dx * step;
      const py = y + dy * step;
      body.push([px, py, length > 3 && step > 0 && step < length - 1 ? rib : color]);
      if (step > 0 && step < length - 1 && length > 3) body.push([px + side[0], py + side[1], color]);
    }
    for (const [px, py] of body) paint.darken(px + 1, py + 1, LEAF_SHADOW);
    for (const [px, py, tone] of body) paint.set(px, py, tone);
  }
}

// A stone as a height field: the highest of 2–3 domes, roughened at the outline.
function makeRock(random, cx, cy, radius, seed) {
  const lobes = [{ x: 0, y: 0, rx: radius, ry: radius * random.range(0.7, 0.9), height: 1 }];
  const extra = random.int(1, 2);
  for (let index = 0; index < extra; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = radius * random.range(0.35, 0.6);
    const size = radius * random.range(0.5, 0.75);
    lobes.push({
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance * 0.8,
      rx: size,
      ry: size * random.range(0.7, 0.95),
      height: random.range(0.75, 0.92),
    });
  }
  const height = (x, y) => {
    let best = -1;
    for (const lobe of lobes) {
      const u = (x - lobe.x) / lobe.rx;
      const v = (y - lobe.y) / lobe.ry;
      best = Math.max(best, lobe.height * (1 - u * u - v * v));
    }
    return best + 0.14 * (noise(cx + x, cy + y, 2.6, seed + 3) - 0.5);
  };
  const reach = Math.ceil(radius * 1.7) + 2;
  return { cx, cy, radius, reach, height };
}

function rockMask(rock) {
  const size = rock.reach * 2 + 1;
  const mask = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) mask[y * size + x] = rock.height(x - rock.reach, y - rock.reach);
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? -1 : mask[y * size + x]);
  const left = Math.round(rock.cx) - rock.reach;
  const top = Math.round(rock.cy) - rock.reach;
  return { size, at, left, top, covers: (px, py) => at(px - left, py - top) > 0 };
}

function paintRockShadow(paint, mask) {
  const { size, at, left, top } = mask;
  for (let y = 0; y < size + 2; y += 1) {
    for (let x = 0; x < size + 2; x += 1) {
      if (at(x, y) > 0) continue;
      if (at(x - 1, y - 1) > 0 || at(x - 1, y) > 0 || at(x, y - 1) > 0) paint.darken(left + x, top + y, SHADOW[0]);
      else if (at(x - 2, y - 2) > 0 || at(x - 2, y - 1) > 0 || at(x - 1, y - 2) > 0) paint.darken(left + x, top + y, SHADOW[1]);
    }
  }
}

function paintRock(paint, rock, mask, seed) {
  const { size, at, left, top } = mask;
  const light = [-0.55, -0.62, 0.56];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (at(x, y) <= 0) continue;
      // Shade from the slope of the height field, lit from the top left.
      const gx = ((at(x + 1, y) - at(x - 1, y)) / 2) * rock.radius;
      const gy = ((at(x, y + 1) - at(x, y - 1)) / 2) * rock.radius;
      const lambert = (-gx * light[0] - gy * light[1] + light[2]) / Math.sqrt(gx * gx + gy * gy + 1);
      let tone = Math.round(1.2 + lambert * 3.2 + (bayer(x, y) - 0.5) * 0.5);
      if (noise(left + x, top + y, 2.2, seed + 4) > 0.84) tone -= 1; // pits
      // A hard rim: dark where the stone meets the ground at the bottom right, lit at the top left.
      if (at(x + 1, y + 1) <= 0 || at(x, y + 1) <= 0) tone = Math.min(tone, 0);
      else if (at(x - 1, y - 1) <= 0 || at(x - 1, y) <= 0 || at(x, y - 1) <= 0) tone = Math.max(tone, 3);
      paint.set(left + x, top + y, ROCK[Math.max(0, Math.min(ROCK.length - 1, tone))]);
    }
  }
}

// How far a bed reaches inward from the wall at the wall point nearest (x, y).
function bedDepthAt(ground, x, y, angle) {
  let distance = 0;
  while (distance < ground.half && ground.inBed(Math.round(x + Math.cos(angle) * distance), Math.round(y + Math.sin(angle) * distance))) {
    distance += 1;
  }
  return distance;
}

// 2–4 rock groups at the inner edge of the deeper beds, kept off the top wall (the
// header covers it: see `top` above).
function placeRockGroups(ground, random, seed, top) {
  const { width, height } = ground;
  const count = random.int(2, 4);
  const groups = [];
  const perimeter = 2 * (width + height);
  // Strict first (deep bed, well apart), then relaxed so small ponds still get two.
  for (let attempt = 0; attempt < 1200 && groups.length < count; attempt += 1) {
    const relaxed = attempt >= 600;
    const spacing = Math.min(160, ground.half * 0.7) * (relaxed ? 0.6 : 1);
    const along = random() * perimeter;
    let x;
    let y;
    if (along < width) [x, y] = [along, 0];
    else if (along < width + height) [x, y] = [width - 1, along - width];
    else if (along < 2 * width + height) [x, y] = [along - width - height, height - 1];
    else [x, y] = [0, along - 2 * width - height];
    // Off the top wall and the top of the side walls, which the header covers.
    if (y < top) continue;
    const angle = ground.inward(Math.round(x), Math.round(y));
    const bedDepth = bedDepthAt(ground, x, y, angle);
    if (bedDepth < (relaxed ? 10 : 22)) continue;
    const into = Math.min(bedDepth * random.range(0.65, 0.95), ground.half * 0.5);
    const cx = x + Math.cos(angle) * into;
    const cy = y + Math.sin(angle) * into;
    if (cx < VIGNETTE || cy < VIGNETTE || cx > width - VIGNETTE || cy > height - VIGNETTE) continue;
    if (groups.some((group) => Math.sqrt((group.x - cx) ** 2 + (group.y - cy) ** 2) < spacing)) continue;
    groups.push({ x: cx, y: cy });
  }
  const stones = [];
  for (const group of groups) {
    const members = random.int(3, 6);
    const first = random.range(7, 11);
    stones.push(makeRock(random, group.x, group.y, first, seed));
    for (let index = 1; index < members; index += 1) {
      const radius = random.range(2.5, 6.5);
      const angle = random() * Math.PI * 2;
      const distance = first * random.range(0.8, 1.15) + radius * 0.7;
      stones.push(makeRock(random, group.x + Math.cos(angle) * distance, group.y + Math.sin(angle) * distance * 0.85, radius, seed));
    }
  }
  return { groups, stones };
}

function reedPixels(x0, y0, angle0, length, bend) {
  let x = x0 + 0.5;
  let y = y0 + 0.5;
  let angle = angle0;
  const pixels = [];
  let lastX = NaN;
  let lastY = NaN;
  for (let step = 0; step < length; step += 0.5) {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px !== lastX || py !== lastY) pixels.push([px, py, step / length]);
    lastX = px;
    lastY = py;
    angle += bend * (0.6 + step / length);
    x += Math.cos(angle) * 0.5;
    y += Math.sin(angle) * 0.5;
  }
  return pixels;
}

function paintBeds(paint, ground, masks, random, seed) {
  const { width, height, bed, margin } = ground;
  const onRock = (x, y) => masks.some((mask) => mask.covers(x, y));
  // Undergrowth: two dark greens in small clusters, thinning out toward the bed's edge
  // so the reeds there stand over sand.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!bed[index] || onRock(x, y)) continue;
      const cover = noise(x, y, 5, seed + 10);
      // A ragged inner mass: the cut-off wanders with small-scale noise, so there is no
      // single contour.
      if (margin[index] < 8 + 22 * cover + 6 * noise(x, y, 2.5, seed + 13)) continue;
      const tone = noise(x, y, 3, seed + 8);
      paint.set(x, y, UNDERGROWTH[tone < 0.4 ? 0 : tone < 0.7 ? 1 : 2]);
    }
  }
  const bedArea = ground.bedShare * width * height;
  const scale = Math.max(0.6, Math.min(1, ground.half / 350));
  const reeds = [];
  const reedCount = Math.round(bedArea / 20);
  for (let attempt = 0; attempt < reedCount * 4 && reeds.length < reedCount; attempt += 1) {
    const x = random.int(0, width - 1);
    const y = random.int(0, height - 1);
    if (!bed[y * width + x] || onRock(x, y)) continue;
    // Reeds at the bed's edge lean out over the sand and run longer.
    const fringe = ground.margin[y * width + x] < 10;
    const angle = ground.inward(x, y) + random.range(fringe ? -0.8 : -1.3, fringe ? 0.8 : 1.3);
    const length = random.range(fringe ? 12 : 6, fringe ? 30 : 22) * scale;
    reeds.push({ pixels: reedPixels(x, y, angle, length, random.range(-0.06, 0.06)), color: pickWeighted(random, [0, 1, 2, 3, 4], REED_WEIGHTS) });
  }
  reeds.sort((a, b) => a.color - b.color);
  for (const reed of reeds) {
    for (const [x, y] of reed.pixels) if (!ground.inBed(x + 1, y + 2)) paint.darken(x + 1, y + 2, LEAF_SHADOW);
  }
  for (const reed of reeds) {
    for (const [x, y, t] of reed.pixels) paint.set(x, y, REEDS[t < 0.25 ? Math.max(0, reed.color - 1) : reed.color]);
  }
  // Round leaves, 4×3, lit at the top left and dark at the bottom right.
  const roundCount = Math.round(bedArea / 320);
  let rounds = 0;
  for (let attempt = 0; width >= 5 && height >= 4 && attempt < roundCount * 4 && rounds < roundCount; attempt += 1) {
    const x = random.int(0, width - 5);
    const y = random.int(0, height - 4);
    if (!bed[y * width + x] || onRock(x, y)) continue;
    rounds += 1;
    const color = random.pick(ROUND_LEAF);
    const dark = scaleColor(color, 0.7);
    const shape = [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1], [1, 2], [2, 2]];
    for (const [dx, dy] of shape) paint.darken(x + dx + 1, y + dy + 1, LEAF_SHADOW);
    for (const [dx, dy] of shape) {
      const tone = dx === 1 && dy === 0 ? scaleColor(color, 1.15) : dy === 2 || dx === 3 ? dark : color;
      paint.set(x + dx, y + dy, tone);
    }
  }
}

function finish(paint, ground, random) {
  const { width, height, bed } = ground;
  const image = new ImageData(width, height);
  const out = image.data;
  const { rgb } = paint;
  const steps = 6;
  const depthSteps = 12;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dither = bayer(x, y);
      // Deep water: stepped and dithered from the banks to the middle.
      const deep = SHALLOWEST + (Math.min(depthSteps, Math.floor(ground.depth(x, y) * depthSteps + dither)) / depthSteps) * (DEEPEST - SHALLOWEST);
      // The dark rim at the walls, with rounded corners.
      const dx = Math.min(x, width - 1 - x);
      const dy = Math.min(y, height - 1 - y);
      let wall = Math.min(dx, dy);
      if (dx < VIGNETTE && dy < VIGNETTE) wall = Math.max(0, VIGNETTE - Math.sqrt((VIGNETTE - dx) ** 2 + (VIGNETTE - dy) ** 2));
      const t = Math.max(0, 1 - wall / VIGNETTE);
      const rim = wall === 0 ? 1 : Math.min(1, Math.floor(t * t * steps + dither) / steps);
      const index = (y * width + x) * 3;
      const target = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const tinted = rgb[index + c] * (1 - TINT) + WATER[c] * TINT;
        const water = tinted + (DEEP[c] - tinted) * deep;
        out[target + c] = Math.round(water + (EDGE[c] - water) * rim);
      }
      out[target + 3] = 255;
    }
  }
  // Sediment: faint single specks, a little lighter or darker, mostly in deeper water.
  // Specks keep out of the rim band; a pond too small for that gets none.
  const specks = width <= 2 * VIGNETTE || height <= 2 * VIGNETTE ? 0 : Math.round((width * height) / 240);
  for (let count = 0; count < specks; count += 1) {
    const x = random.int(VIGNETTE, width - VIGNETTE - 1);
    const y = random.int(VIGNETTE, height - VIGNETTE - 1);
    if (bed[y * width + x]) continue;
    const factor = random.chance(0.6) ? 0.84 : 1.16;
    const target = (y * width + x) * 4;
    for (let c = 0; c < 3; c += 1) out[target + c] = Math.min(255, Math.round(out[target + c] * factor));
  }
  return image;
}

// The band at the top (pond px) kept free of rock groups: see `top` above.
export function topBand(pondHeight, headerPondPixels) {
  return Math.max(Math.round(0.15 * pondHeight), Math.ceil(headerPondPixels) + 24);
}

export function layFloor(width, height, seed, { top = topBand(height, 0) } = {}) {
  const random = createRandom(seed);
  const paint = createPainter(width, height);
  const ground = createGround(width, height, seed);
  paintSand(paint, width, height, seed);
  paintPebbles(paint, ground, random, seed);
  paintFallenLeaves(paint, ground, random);
  const { groups, stones } = placeRockGroups(ground, random, seed, top);
  const masks = stones.map(rockMask);
  paintBeds(paint, ground, masks, random, seed);
  masks.forEach((mask) => paintRockShadow(paint, mask));
  stones.forEach((stone, index) => paintRock(paint, stone, masks[index], seed));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(finish(paint, ground, random), 0, 0);
  const focus = groups[0] ?? { x: width / 2, y: height / 2 };
  const detail = {
    x: Math.max(0, Math.min(width - DETAIL.width, Math.round(focus.x - DETAIL.width / 2))),
    y: Math.max(0, Math.min(height - DETAIL.height, Math.round(focus.y - DETAIL.height / 2))),
  };
  return { canvas, detail, bedShare: ground.bedShare, rockGroups: groups.length, stones: stones.length };
}

export function buildFloor(pondWidth, pondHeight, seed, options) {
  return layFloor(pondWidth, pondHeight, seed, options).canvas;
}

function hashCanvas(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let hash = 2166136261;
  for (let index = 0; index < data.length; index += 1) hash = Math.imul(hash ^ data[index], 16777619);
  return hash >>> 0;
}

let built = null;
let builds = 0;

export function current() {
  return built;
}

export function buildCount() {
  return builds;
}

export function rebuild(state) {
  if (state.accountId === null || state.accountId === undefined) return;
  const { pondWidth, pondHeight, scale } = state.view;
  const { accountId } = state;
  const seed = seedOf(accountId, SALT);
  const top = topBand(pondHeight, (state.headerHeight ?? 0) / (scale || 1));
  if (built && built.width === pondWidth && built.height === pondHeight && built.seed === seed && built.top === top) return;
  const laid = layFloor(pondWidth, pondHeight, seed, { top });
  builds += 1;
  built = { ...laid, seed, top, accountId, width: pondWidth, height: pondHeight, hash: hashCanvas(laid.canvas) };
}

export function draw(ctx, state) {
  const { pondWidth, pondHeight } = state.view;
  if (built && (built.width !== pondWidth || built.height !== pondHeight)) rebuild(state);
  if (!built || built.width !== pondWidth || built.height !== pondHeight) {
    // Before the account is known (or between a resize and its rebuild): the rim color.
    ctx.fillStyle = `rgb(${EDGE.join(', ')})`;
    ctx.fillRect(0, 0, pondWidth, pondHeight);
    return;
  }
  ctx.drawImage(built.canvas, 0, 0);
}
