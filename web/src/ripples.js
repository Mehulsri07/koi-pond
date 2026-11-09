// The ripple layer: rings that spread over the water when you feed it, when a koi
// gulps, and when you touch a lilypad. It draws above the pads.
//
//   add(x, y, kind)   a ring at a pond pixel; kind is "drop" | "gulp" | "pad"
//   draw(ctx, state, now)
//   rebuild(state)    forget every ring (the pond changed size)
//   active()          [{x, y, kind, age}] rings alive now (age in ms)
//   counts()          {drop, gulp, pad}: rings added since load
//
// A ring is 1 px wide, #a8e3e6, drawn as hard pixels (a midpoint circle at an integer
// radius, no antialiasing). It expands at 24 px/s and fades to nothing over 1 s. With
// reduced motion a ring does not move: one static ring of RING_STATIC_RADIUS px for
// 0.4 s. At most MAX_RIPPLES rings live at once; the oldest goes first.
//
// At state.spriteScale s (2 on laptop ponds, where the pads are drawn twice as big) the
// rings stay 1 px wide but spread s times as fast and as far: 48 px/s to a 48 px radius
// at 1 s, and a 16 px static ring under reduced motion.

export const name = 'ripples';

export const RING_COLOR = '#a8e3e6';
export const SPEED = 24; // px per second
export const LIFETIME_MS = 1000;
export const STATIC_LIFETIME_MS = 400;
export const STATIC_RADIUS = 8;
export const MAX_RIPPLES = 12;
const KINDS = new Set(['drop', 'gulp', 'pad']);

let rings = [];
const added = { drop: 0, gulp: 0, pad: 0 };

export function add(x, y, kind) {
  if (!KINDS.has(kind)) throw new Error(`unknown ripple kind: ${kind}`);
  added[kind] += 1;
  rings.push({ x: Math.floor(x), y: Math.floor(y), kind, born: performance.now() });
  if (rings.length > MAX_RIPPLES) rings.splice(0, rings.length - MAX_RIPPLES);
}

export function rebuild() {
  rings = [];
}

export function active(now = performance.now()) {
  return rings.map(({ x, y, kind, born }) => ({ x, y, kind, age: now - born }));
}

export function counts() {
  return { ...added };
}

// Add the pixels of the circle of integer radius r about (cx, cy) to the path.
function ringPath(ctx, cx, cy, r) {
  if (r === 0) {
    ctx.rect(cx, cy, 1, 1);
    return;
  }
  let x = r;
  let y = 0;
  let error = 1 - r;
  while (x >= y) {
    ctx.rect(cx + x, cy + y, 1, 1);
    ctx.rect(cx - x, cy + y, 1, 1);
    ctx.rect(cx + x, cy - y, 1, 1);
    ctx.rect(cx - x, cy - y, 1, 1);
    if (x !== y) {
      ctx.rect(cx + y, cy + x, 1, 1);
      ctx.rect(cx - y, cy + x, 1, 1);
      ctx.rect(cx + y, cy - x, 1, 1);
      ctx.rect(cx - y, cy - x, 1, 1);
    }
    y += 1;
    if (error < 0) {
      error += 2 * y + 1;
    } else {
      x -= 1;
      error += 2 * (y - x) + 1;
    }
  }
}

export function draw(ctx, state, now) {
  if (!rings.length) return;
  const reduced = state.reducedMotion;
  const life = reduced ? STATIC_LIFETIME_MS : LIFETIME_MS;
  rings = rings.filter((ring) => now - ring.born < life);
  ctx.save();
  ctx.fillStyle = RING_COLOR;
  for (const ring of rings) {
    const age = Math.max(0, now - ring.born);
    ctx.globalAlpha = reduced ? 1 : Math.max(0, 1 - age / life);
    const s = state.spriteScale ?? 1;
    const radius = reduced ? STATIC_RADIUS * s : Math.round((age / 1000) * SPEED * s);
    ctx.beginPath();
    ringPath(ctx, ring.x, ring.y, radius);
    ctx.fill();
  }
  ctx.restore();
}
