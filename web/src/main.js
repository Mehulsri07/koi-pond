// The pond site: boot, sizing, the frame loop, and the error message.
//
// Data: the page reads data/snapshot.json (written by the nightly collect). It reads
// fixtures/snapshot.json instead when the URL has ?fixture, or when data/snapshot.json
// is missing (HTTP 404), which is the case in a fresh checkout. Any other failure to
// fetch or read the snapshot shows "The pond's data could not be read" with the reason,
// over a pond that still draws.
//
// Layers: each layer module exports draw(ctx, state, now) and may export
// rebuild(state), called after every pond (re)build (first boot and each settled resize
// that changes the pond's size) so a layer can cache bitmaps per size. LAYERS lists
// them bottom to top. ctx draws in pond pixels on a pondWidth × pondHeight canvas that
// is scaled up to the screen once per frame without smoothing. `state` holds:
//   view        computeView() for the current viewport (web/src/view.js)
//   koi         the koi (web/src/koi.js), or null before boot or after a failure
//   pads        pads_json(), parsed ([] until the koi exists)
//   legend      legend_json(), parsed (null until the koi exists)
//   snapshot    the parsed snapshot (null until read)
//   accountId   the account the pond's art is seeded from: null until boot knows it, then
//               the snapshot's account_id, or 0 when the data could not be read. Seeded
//               layers (floor, caustics) build nothing while it is null, so the pond is
//               laid once, for the right account, with no stand-in floor first.
//   headerHeight  the header strip's height in CSS px, kept current
//   reducedMotion  prefers-reduced-motion, kept current
//   now, dt     this frame's rAF time (ms) and step (s, capped at 0.1)
//   gulped      true on the frame the koi gulps food
//   food        {x, y}: the food pellet's pond pixel, or null (cleared on the gulp frame)
//   renderMode  the koi's drawing mode, "every-frame" or "20-per-second" (for the legend)
//
// Failures stay local. A layer whose draw or rebuild throws is switched off, logged, and
// noted on screen ("Part of the pond could not be drawn"); the rest keeps drawing. A koi
// that throws is freed and noted ("The koi stopped swimming"); a pond rebuild that
// throws is noted ("The pond could not be redrawn at this size"). Either way the koi is
// built again on the next settled resize. The frame loop schedules its next frame first,
// so nothing stops it.
//
// Input: taps and clicks on the pond go through web/src/pads.js. A pad shows its card
// (web/src/card.js) or opens its repo; a tap or click on open water (the notch, a ripple
// and a bud are water) calls onWaterTap(x, y) in pond pixels, which drops food for the
// koi. Feeding proper (the pellet, the gulp ripple) is Task 8's, behind the same hook.
//
// The page background takes the color of the pond's bottom-right pixel after each
// rebuild, so the up-to-1 px strip a scale-2 pond leaves at odd viewport sizes blends in.
//
// Test hooks on window.__pond (for scripts/e2e.mjs; harmless on the live site):
//   ready              true once the koi is swimming
//   error              the visible message (every current problem), or null
//   view               the current view
//   state              the state object above
//   layers             the LAYERS array (tests may push a layer)
//   frames             frames drawn since load
//   settles            settled resizes handled (after the 300 ms debounce)
//   rebuilds           pond rebuilds after resizes
//   liveKoi            PondKoi instances alive right now (1 when nothing leaks)
//   padCount           pads in the current pond
//   wasmMemoryBytes()  the WebAssembly memory's size in bytes
//   koiPixels()        {count, x, y}: the koi frame's opaque pixels and their centroid,
//                      in pond pixels
//   canvasSample()     one hash per row of the visible canvas, to detect change
//   floorHash          a hash of the floor bitmap's pixels (web/src/floor.js); stable for
//                      one browser, not promised across browsers
//   floorBuilds        floors laid since load
//   causticBuilds      caustic tile sets built since load
//   floorSeed          the account_id the floor was laid for (null before the snapshot)
//   floorDetail        {x, y}: a 160×100 pond-pixel region around a rock group and its bed
//   floorShape         {bedShare, rockGroups, stones}: how much the plant beds cover, and
//                      the rock groups and stones laid
//   causticFrame       the caustic frame drawn last (web/src/caustics.js)
//   causticMask        the mean strength of the light's patch mask right now (0–1)
//   causticFrames()    the 16 caustic tiles
//   causticRegion(frame, width, height)  that frame's light over a larger region
//   causticLive()      {frame, key, mean}: the live caustic state, to check it is not disturbed
//   padBuilds          pad layers built since load (web/src/pads.js); one per new layout
//   padMask()          {width, height, mask, canvas, pads}: the pad layer's hit mask (pad
//                      index + 1 per pond pixel, 0 for water), its bitmap, and the pads it
//                      was built for; null before the first build
//   renderMode         the koi's drawing mode: "every-frame" or "20-per-second"; the page
//                      takes ?slowKoi=<ms> to add that busy-wait to each koi render
//   koiRenders         koi renders since the last build (frames drawn minus the ones that reused the bitmap)
//   foodDrawn()        whether the last frame drew the food pellet
//   ripples()          [{x, y, kind, age}] the rings alive now (ms of age)
//   rippleCounts()     {drop, gulp, pad}: rings added since load
//   foodDrops          taps on water since load (onWaterTap calls)
//   lastFood           {x, y}: where the last one landed, in pond pixels, or null
//   layerMs            per named layer, a running average of its draw time in the frame
//                      loop (ms; draw calls only, as the canvas may raster later)
//   layerCost(names, {runs, count})  {layers, calibration}: ms a frame for the named
//                      layers drawn `count` times into a pond-size canvas, reading a pixel
//                      back each time so it rasters, and for one plain pond-size blit
//                      measured the same way; each the median of `runs` runs after a
//                      warm-up. Layer state (the live caustics) is saved and restored.

import { computeView } from './view.js';
import * as koiModule from './koi.js';
import * as floor from './floor.js';
import * as caustics from './caustics.js';
import * as pads from './pads.js';
import * as food from './food.js';
import * as ripples from './ripples.js';
import { pageCardInstance } from './card.js';
import { setupLegend } from './legend.js';

const LAYERS = [floor, caustics, food, koiModule, pads, ripples];

const BODY = 'black';
const RESIZE_DEBOUNCE_MS = 300;
const MAX_STEP_SECONDS = 0.1;
const DATA_ERROR = "The pond's data could not be read";
const WASM_ERROR = 'The koi could not be drawn here: WebAssembly failed to load';
const KOI_ERROR = 'The koi stopped swimming';
const REBUILD_ERROR = 'The pond could not be redrawn at this size';
const LAYER_ERROR = 'Part of the pond could not be drawn';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('pond');
const display = canvas.getContext('2d', { alpha: false });
const scene = document.createElement('canvas');
const sceneContext = scene.getContext('2d');
const message = document.getElementById('message');
const header = document.querySelector('.site-header');

const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  view: computeView(innerWidth, innerHeight, devicePixelRatio),
  koi: null,
  pads: [],
  food: null,
  renderMode: 'every-frame',
  legend: null,
  snapshot: null,
  accountId: null,
  headerHeight: 0,
  reducedMotion: reducedMotionQuery.matches,
  now: 0,
  dt: 0,
  gulped: false,
};
reducedMotionQuery.addEventListener('change', (event) => {
  state.reducedMotion = event.matches;
});

let wasm = null;
let koiHandle = null; // kept after a failure so the koi can be built again
const disabledLayers = new Set();
let sampleEdge = true;

const hooks = {
  ready: false,
  error: null,
  frames: 0,
  settles: 0,
  rebuilds: 0,
  layers: LAYERS,
  state,
  get view() {
    return state.view;
  },
  get liveKoi() {
    return koiModule.liveCount();
  },
  get padCount() {
    return state.pads.length;
  },
  wasmMemoryBytes: () => (wasm ? wasm.memory.buffer.byteLength : 0),
  koiPixels: () => koiPixels(),
  canvasSample: () => canvasSample(),
  get floorBuilds() {
    return floor.buildCount();
  },
  get causticBuilds() {
    return caustics.buildCount();
  },
  causticLive: () => caustics.liveState(),
  get floorHash() {
    return floor.current()?.hash ?? null;
  },
  get floorSeed() {
    return floor.current()?.accountId ?? null;
  },
  get floorDetail() {
    return floor.current()?.detail ?? null;
  },
  get floorShape() {
    const built = floor.current();
    return built ? { bedShare: built.bedShare, rockGroups: built.rockGroups, stones: built.stones } : null;
  },
  get causticMask() {
    return caustics.maskMean();
  },
  get causticFrame() {
    return caustics.currentFrame();
  },
  causticFrames: () => caustics.frames(),
  causticRegion: (frame, width, height) => caustics.renderRegion(caustics.seedFor(state) ?? 0, frame, width, height),
  get padBuilds() {
    return pads.buildCount();
  },
  padMask: () => {
    const built = pads.current();
    return built ? { width: built.width, height: built.height, mask: built.hitMask, canvas: built.canvas, pads: built.pads } : null;
  },
  get koiRenders() {
    return koiHandle?.renders ?? 0;
  },
  get renderMode() {
    return koiHandle?.renderMode ?? 'every-frame';
  },
  foodDrawn: () => food.drawn(),
  ripples: () => ripples.active(),
  rippleCounts: () => ripples.counts(),
  foodDrops: 0,
  lastFood: null,
  layerMs: {},
  layerCost: (names, count) => layerCost(names, count),
};
window.__pond = hooks;

// The message lists every current problem, one per line. The element stays in the page
// (role="alert"), so changing its text is announced.
const problems = new Map();
function renderMessage() {
  hooks.error = problems.size ? [...problems.values()].join('\n') : null;
  message.textContent = hooks.error ?? '';
}
function report(key, text, error) {
  const reason = error?.message ?? (error === undefined ? '' : String(error));
  problems.set(key, reason ? `${text}: ${reason}` : text);
  renderMessage();
  if (error !== undefined) console.error(error);
}
function clear(key) {
  if (problems.delete(key)) renderMessage();
}

// The pond canvas and the visible canvas follow the view. Resizing a canvas resets its
// context, so smoothing is turned off again each time.
function sizeCanvases(view) {
  if (scene.width !== view.pondWidth || scene.height !== view.pondHeight) {
    scene.width = view.pondWidth;
    scene.height = view.pondHeight;
  }
  if (canvas.width !== view.backingWidth || canvas.height !== view.backingHeight) {
    canvas.width = view.backingWidth;
    canvas.height = view.backingHeight;
  }
  canvas.style.width = `${view.cssWidth}px`;
  canvas.style.height = `${view.cssHeight}px`;
  sceneContext.imageSmoothingEnabled = false;
  display.imageSmoothingEnabled = false;
}

function disableLayer(layer, error) {
  disabledLayers.add(layer);
  report('layer', LAYER_ERROR, error);
}

function koiFailed(error) {
  koiHandle?.free();
  state.koi = null;
  state.food = null;
  report('koi', KOI_ERROR, error);
}

function rebuildLayers() {
  state.pads = state.koi ? state.koi.pads() : [];
  state.food = state.koi ? state.koi.food() : null;
  state.legend = state.koi ? state.koi.legend() : null;
  for (const layer of LAYERS) {
    if (disabledLayers.has(layer)) continue;
    try {
      layer.rebuild?.(state);
    } catch (error) {
      disableLayer(layer, error);
    }
  }
  sampleEdge = true;
}

function applyView() {
  const next = computeView(innerWidth, innerHeight, devicePixelRatio);
  const pondChanged = next.pondWidth !== state.view.pondWidth || next.pondHeight !== state.view.pondHeight;
  state.view = next;
  sizeCanvases(next);
  hooks.settles += 1;
  const koiMissing = koiHandle !== null && state.koi === null;
  if (!pondChanged && !koiMissing) return;
  if (koiHandle) {
    try {
      koiHandle.rebuild(next);
      state.koi = koiHandle;
      clear('koi');
      clear('rebuild');
    } catch (error) {
      koiHandle.free();
      state.koi = null;
      report('rebuild', REBUILD_ERROR, error);
    }
  }
  rebuildLayers();
  hooks.rebuilds += 1;
}

let resizeTimer = 0;
function scheduleApply() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyView, RESIZE_DEBOUNCE_MS);
}
window.addEventListener('resize', scheduleApply);

// devicePixelRatio can change without a resize (moving the window to another screen).
function watchPixelRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      scheduleApply();
      watchPixelRatio();
    },
    { once: true },
  );
}

// The legend sits below the header on desktop, so it never covers the header button.
// The floor keeps rock groups out from under it, so state carries its height too.
state.headerHeight = header.offsetHeight;
new ResizeObserver(() => {
  state.headerHeight = header.offsetHeight;
  document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
}).observe(header);

function timeLayer(name, ms) {
  const average = hooks.layerMs[name];
  hooks.layerMs[name] = average === undefined ? ms : average * 0.95 + ms * 0.05;
}

// Per-frame cost of the named layers against one plain pond-size blit, both drawn into a
// pond-size canvas with a 1 px read-back each time so the canvas rasters every pass. Each
// figure is the median of `runs` runs after a warm-up; layer state is saved and restored
// so the live pond is not disturbed.
function layerCost(names, { runs = 5, count = 60 } = {}) {
  const layers = LAYERS.filter((layer) => names.includes(layer.name));
  const saved = layers.map((layer) => layer.saveState?.());
  const bench = document.createElement('canvas');
  bench.width = state.view.pondWidth;
  bench.height = state.view.pondHeight;
  const context = bench.getContext('2d');
  context.imageSmoothingEnabled = false;
  const plain = document.createElement('canvas');
  plain.width = bench.width;
  plain.height = bench.height;
  plain.getContext('2d').fillRect(0, 0, plain.width, plain.height);
  const time = (draw) => {
    const started = performance.now();
    for (let index = 0; index < count; index += 1) {
      draw(index);
      context.getImageData(index % bench.width, 0, 1, 1);
    }
    return (performance.now() - started) / count;
  };
  const drawLayers = (index) => {
    for (const layer of layers) layer.draw(context, state, index * 125);
  };
  const drawPlain = () => context.drawImage(plain, 0, 0);
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  try {
    time(drawLayers); // warm up
    time(drawPlain);
    const layerRuns = [];
    const plainRuns = [];
    for (let run = 0; run < runs; run += 1) {
      layerRuns.push(time(drawLayers));
      plainRuns.push(time(drawPlain));
    }
    return { layers: median(layerRuns), calibration: median(plainRuns) };
  } finally {
    layers.forEach((layer, index) => layer.restoreState?.(saved[index]));
  }
}

// A tap or click on open water, in pond pixels: drop food (a new one moves the old) and
// ring the water where it lands.
function onWaterTap(x, y) {
  hooks.foodDrops += 1;
  hooks.lastFood = { x, y };
  ripples.add(x, y, 'drop'); // feedback even before the koi exists, and outside the koi's try
  if (!state.koi) return;
  try {
    state.koi.dropFood(x + 0.5, y + 0.5);
    state.food = state.koi.food();
  } catch (error) {
    koiFailed(error);
  }
}

let lastTime = null;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastTime === null ? 0 : Math.min(MAX_STEP_SECONDS, (now - lastTime) / 1000);
  lastTime = now;
  state.now = now;
  state.dt = dt;
  state.gulped = false;
  if (state.koi) {
    try {
      const before = state.koi.food();
      state.gulped = state.koi.step(dt);
      state.food = state.gulped ? null : state.koi.food();
      if (state.gulped && before) ripples.add(before.x, before.y, 'gulp');
      state.renderMode = state.koi.renderMode;
    } catch (error) {
      koiFailed(error);
    }
  }
  for (const layer of LAYERS) {
    if (disabledLayers.has(layer)) continue;
    try {
      const started = performance.now();
      layer.draw(sceneContext, state, now);
      if (layer.name) timeLayer(layer.name, performance.now() - started);
    } catch (error) {
      // The koi layer's draw renders the koi: a throw there is the koi failing.
      if (layer === koiModule) koiFailed(error);
      else disableLayer(layer, error);
    }
  }
  display.drawImage(scene, 0, 0, canvas.width, canvas.height);
  if (sampleEdge) {
    sampleEdge = false;
    const [r, g, b] = sceneContext.getImageData(scene.width - 1, scene.height - 1, 1, 1).data;
    document.documentElement.style.setProperty('--pond-edge', `rgb(${r}, ${g}, ${b})`);
  }
  hooks.frames += 1;
}

async function fetchText(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) {
    const error = new Error(`${path}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function loadSnapshotText() {
  if (!params.has('fixture')) {
    try {
      return await fetchText('data/snapshot.json');
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return fetchText('fixtures/snapshot.json');
}

// The glue is imported here, not at the top, so a missing or blocked pkg still shows a
// message instead of a blank page.
async function loadWasm() {
  const glue = await import('../pkg/pond_wasm.js');
  const exports = await glue.default();
  return { exports, PondKoi: glue.PondKoi };
}

// The koi's seed comes from the account, so a visitor sees the same swim each load.
// The account the art is seeded from: the snapshot's account_id when it is a usable
// integer, else 0.
function accountIdFrom(snapshot) {
  const id = snapshot?.account_id;
  return Number.isSafeInteger(id) && id >= 0 ? id : 0;
}

// Once boot knows the account (or knows it never will), lay the seeded layers.
function settleAccount(id) {
  state.accountId = id;
  rebuildLayers();
}

function seedFrom(snapshot) {
  const id = snapshot?.account_id;
  return Number.isSafeInteger(id) && id >= 0 ? BigInt(id) : 0n;
}

async function boot() {
  const wasmLoad = loadWasm().catch((error) => {
    report('wasm', WASM_ERROR, error);
    return null;
  });
  let snapshotJson;
  try {
    snapshotJson = await loadSnapshotText();
    state.snapshot = JSON.parse(snapshotJson);
  } catch (error) {
    report('data', DATA_ERROR, error);
    settleAccount(0);
    await wasmLoad;
    return;
  }
  settleAccount(accountIdFrom(state.snapshot));
  const loaded = await wasmLoad;
  if (!loaded) return;
  wasm = loaded.exports;
  try {
    koiHandle = koiModule.create(state.view, {
      PondKoi: loaded.PondKoi,
      memory: wasm.memory,
      snapshotJson,
      body: BODY,
      seed: seedFrom(state.snapshot),
    });
  } catch (error) {
    report('data', DATA_ERROR, error);
    return;
  }
  state.koi = koiHandle;
  rebuildLayers();
  hooks.ready = true;
}

function koiPixels() {
  const instance = state.koi?.instance;
  if (!instance) return { count: 0, x: NaN, y: NaN };
  const width = instance.frame_width();
  const pixels = new Uint8Array(wasm.memory.buffer, instance.pixels_ptr(), instance.pixels_len());
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] === 255) {
      const pixel = (index - 3) / 4;
      count += 1;
      sumX += pixel % width;
      sumY += Math.floor(pixel / width);
    }
  }
  return {
    count,
    x: count ? instance.frame_x() + sumX / count : NaN,
    y: count ? instance.frame_y() + sumY / count : NaN,
  };
}

function canvasSample() {
  const { data, width, height } = display.getImageData(0, 0, canvas.width, canvas.height);
  const rows = new Array(height);
  for (let y = 0; y < height; y += 1) {
    let hash = 2166136261;
    for (let index = y * width * 4, end = index + width * 4; index < end; index += 1) {
      hash = Math.imul(hash ^ data[index], 16777619);
    }
    rows[y] = hash >>> 0;
  }
  return rows;
}

sizeCanvases(state.view);
setupLegend();
pads.attachInput(canvas, { getState: () => state, onWaterTap, onPadTap: (x, y) => ripples.add(x, y, 'pad'), card: pageCardInstance() });
watchPixelRatio();
rebuildLayers();
requestAnimationFrame(tick);
boot();
