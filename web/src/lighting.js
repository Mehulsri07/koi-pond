// The lighting layer: the pond graded by the visitor's clock, and at night a moon on the
// water and fireflies over it. It is the top layer.
//
//   phaseAt(date) -> {name, grade, lift, night}   pure; the light at the Date's local time
//   draw(ctx, state, now) / rebuild(state)  the layer contract (web/src/main.js)
//   fireflyCount()   fireflies drawn by the last draw (0 by day)
//   spots()          [{x, y, frame}]: where the last draw put each firefly (its anchor
//                    pixel) and which sprite it showed (0 glowing, 1 dim)
//
// Phases (local time): night 19–05, dawn 05–07, day 07–17, dusk 17–19. Each boundary
// blends linearly over the 20 minutes centered on it, so 17:00 sits halfway between day
// and dusk and the light never steps between frames.
//   grade  {r, g, b, a, mode}: one full-pond fill with `mode` ("multiply") each frame.
//          Day is the identity (alpha 0, nothing drawn): the approved floor is the day.
//          Night is rgba(30,45,90,0.55).
//   lift   {r, g, b, a}: a soft `screen` fill after the grade, at dawn and dusk only.
//   night  0 by day, dawn and dusk; 1 at night; between on the 05:00 and 19:00 blends.
//   name   "dawn" | "day" | "dusk" | "night": the phase the time falls in, switching at
//          the boundary time itself even though the color blends over the 20 minutes
//          around it: 04:59:59 is "night", 05:00 is "dawn", 17:00 is "dusk".
//
// While night > 0 the moon reflection (sprite moon-reflection) and 10 fireflies
// (firefly-0 glowing, firefly-1 dim) are drawn over the grade, since they give light, at
// opacity `night`. The moon sits near the top right below the header and wobbles 1 px
// sideways. Each firefly drifts on a smooth path (two sines per axis with seeded
// amplitudes, frequencies and phases, seeded from the account) inside the pond clear of
// the header and the edges, and blinks with a seeded period of 0.5–1.5 s. Under reduced
// motion the fireflies hold still and only blink, and the moon does not wobble. Every
// sprite lands on whole pond pixels.
//
// At state.spriteScale s (2 on laptop ponds) the moon and the fireflies are drawn s times
// bigger, nearest-neighbor, and every distance above scales with them: the edge and header
// margins, the moon's place and wobble, and the fireflies' drift. Firefly homes stay
// fractions of the free area.
import { createRandom, seedOf } from './rand.js';

export const name = 'lighting';

const BLEND_HOURS = 20 / 60;
const NIGHT = { name: 'night', grade: { r: 30, g: 45, b: 90, a: 0.55 }, lift: { r: 255, g: 255, b: 255, a: 0 }, night: 1 };
const DAWN = { name: 'dawn', grade: { r: 225, g: 200, b: 235, a: 0.24 }, lift: { r: 255, g: 200, b: 170, a: 0.07 }, night: 0 };
const DAY = { name: 'day', grade: { r: 255, g: 255, b: 255, a: 0 }, lift: { r: 255, g: 255, b: 255, a: 0 }, night: 0 };
const DUSK = { name: 'dusk', grade: { r: 255, g: 176, b: 160, a: 0.32 }, lift: { r: 255, g: 120, b: 60, a: 0.06 }, night: 0 };
// [hour, phase before, phase after], in order through the day.
const BOUNDARIES = [
  [5, NIGHT, DAWN],
  [7, DAWN, DAY],
  [17, DAY, DUSK],
  [19, DUSK, NIGHT],
];

const FIREFLIES = 10;
const FIREFLY_SALT = 0x66697265;
const EDGE_MARGIN = 6; // pond px kept clear at the pond's edges and below the header
const MOON_FROM_RIGHT = 44; // the moon's anchor, pond px from the right edge
const MOON_BELOW_HEADER = 22; // and below the header
const MOON_WOBBLE_SECONDS = 6;

function lerpColor(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

function phaseResult(phase) {
  return { name: phase.name, grade: { ...phase.grade, mode: 'multiply' }, lift: { ...phase.lift }, night: phase.night };
}

export function phaseAt(date) {
  const hour = date.getHours() + date.getMinutes() / 60 + (date.getSeconds() + date.getMilliseconds() / 1000) / 3600;
  for (const [at, before, after] of BOUNDARIES) {
    const t = (hour - (at - BLEND_HOURS / 2)) / BLEND_HOURS;
    if (t > 0 && t < 1) {
      return {
        name: t < 0.5 ? before.name : after.name,
        grade: { ...lerpColor(before.grade, after.grade, t), mode: 'multiply' },
        lift: lerpColor(before.lift, after.lift, t),
        night: before.night + (after.night - before.night) * t,
      };
    }
  }
  if (hour < 5 || hour >= 19) return phaseResult(NIGHT);
  if (hour < 7) return phaseResult(DAWN);
  if (hour < 17) return phaseResult(DAY);
  return phaseResult(DUSK);
}

// Sprites, loaded on the first rebuild (not at import, so Node can import phaseAt). A
// first failure is retried once, on the next rebuild or after RETRY_MS; a second is kept
// for draw() to throw, so main.js switches the layer off and says so.
const SPRITES = ['moon-reflection', 'firefly-0', 'firefly-1'];
const RETRY_MS = 3000;
let sprites = null; // {name: {image, anchor}}
let failure = null;
let failures = 0;
let loading = null;
let retryTimer = 0;

async function load(base = 'art/') {
  const response = await fetch(`${base}sprites.json`);
  if (!response.ok) throw new Error(`${base}sprites.json: HTTP ${response.status}`);
  const manifest = await response.json();
  const loaded = {};
  await Promise.all(
    SPRITES.map(async (sprite) => {
      const entry = manifest[sprite];
      if (!entry) throw new Error(`sprites.json has no ${sprite}`);
      const image = new Image();
      image.src = `${base}${sprite}.png`;
      await image.decode();
      loaded[sprite] = { image, anchor: entry.anchor };
    }),
  );
  sprites = loaded;
}

function loadOnce() {
  if (loading || sprites || failure) return;
  clearTimeout(retryTimer);
  loading = load()
    .catch((error) => {
      failures += 1;
      if (failures > 1) failure = error;
      else {
        console.warn('Lighting sprites failed to load; retrying once:', error);
        retryTimer = setTimeout(loadOnce, RETRY_MS);
      }
    })
    .finally(() => {
      loading = null;
    });
}

// Each firefly's path, in units independent of the pond's size: its home as a fraction
// of the free area, and its drift in pond px and radians a second.
let paths = null;
let pathsFor = null;
function pathsForAccount(accountId) {
  if (paths && pathsFor === accountId) return paths;
  const random = createRandom(seedOf(accountId, FIREFLY_SALT));
  paths = Array.from({ length: FIREFLIES }, () => ({
    u: random(),
    v: random(),
    ax: random.range(8, 22),
    ay: random.range(6, 16),
    fx: [random.range(0.12, 0.3), random.range(0.3, 0.55)],
    fy: [random.range(0.1, 0.28), random.range(0.28, 0.5)],
    px: [random.range(0, 2 * Math.PI), random.range(0, 2 * Math.PI)],
    py: [random.range(0, 2 * Math.PI), random.range(0, 2 * Math.PI)],
    period: random.range(0.5, 1.5),
    blink: random(),
  }));
  pathsFor = accountId;
  return paths;
}

let drawnSpots = [];

export function fireflyCount() {
  return drawnSpots.length;
}

export function spots() {
  return drawnSpots.map((spot) => ({ ...spot }));
}

export function rebuild() {
  loadOnce();
}

function rgba({ r, g, b, a }) {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(4)})`;
}

function drawSprite(ctx, sprite, x, y, s) {
  const { image, anchor } = sprite;
  ctx.drawImage(image, Math.round(x) - anchor[0] * s, Math.round(y) - anchor[1] * s, image.width * s, image.height * s);
}

export function draw(ctx, state, now) {
  drawnSpots = [];
  if (failure) throw failure;
  const phase = state.phase ?? phaseAt(new Date());
  const width = state.view.pondWidth;
  const height = state.view.pondHeight;
  ctx.save();
  if (phase.grade.a > 0.002) {
    ctx.globalCompositeOperation = phase.grade.mode;
    ctx.fillStyle = rgba(phase.grade);
    ctx.fillRect(0, 0, width, height);
  }
  if (phase.lift.a > 0.002) {
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = rgba(phase.lift);
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = 'source-over';
  if (phase.night > 0 && sprites && state.accountId !== null) {
    ctx.globalAlpha = Math.min(1, phase.night);
    ctx.imageSmoothingEnabled = false;
    const s = state.spriteScale ?? 1;
    const margin = EDGE_MARGIN * s;
    const seconds = now / 1000;
    const still = state.reducedMotion;
    const top = Math.ceil(state.headerHeight / state.view.scale) + margin;
    const wobble = still ? 0 : s * Math.round(0.5 + 0.5 * Math.sin((seconds * 2 * Math.PI) / MOON_WOBBLE_SECONDS));
    drawSprite(ctx, sprites['moon-reflection'], width - MOON_FROM_RIGHT * s + wobble, Math.min(top + MOON_BELOW_HEADER * s, height - margin), s);
    const left = margin;
    const right = width - margin;
    const bottom = Math.max(top, height - margin);
    const time = still ? 0 : seconds;
    for (const path of pathsForAccount(state.accountId)) {
      // Keep the whole drift inside the free area; a small pond squeezes the drift.
      const ax = Math.min(path.ax * s, (right - left) / 2);
      const ay = Math.min(path.ay * s, (bottom - top) / 2);
      const homeX = left + ax + path.u * Math.max(0, right - left - 2 * ax);
      const homeY = top + ay + path.v * Math.max(0, bottom - top - 2 * ay);
      const x = Math.round(homeX + ax * (0.65 * Math.sin(path.fx[0] * time + path.px[0]) + 0.35 * Math.sin(path.fx[1] * time + path.px[1])));
      const y = Math.round(homeY + ay * (0.65 * Math.sin(path.fy[0] * time + path.py[0]) + 0.35 * Math.sin(path.fy[1] * time + path.py[1])));
      const frame = (seconds / path.period + path.blink) % 1 < 0.5 ? 0 : 1;
      drawSprite(ctx, sprites[`firefly-${frame}`], x, y, s);
      drawnSpots.push({ x, y, frame });
    }
  }
  ctx.restore();
}
