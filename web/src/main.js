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
//   reducedMotion  prefers-reduced-motion, kept current
//   now, dt     this frame's rAF time (ms) and step (s, capped at 0.1)
//   gulped      true on the frame the koi gulps food
//
// Test hooks on window.__pond (for scripts/e2e.mjs; harmless on the live site):
//   ready              true once the koi is swimming
//   error              the visible error message, or null
//   view               the current view
//   state              the state object above
//   frames             frames drawn since load
//   rebuilds           pond rebuilds after resizes
//   liveKoi            PondKoi instances alive right now (1 when nothing leaks)
//   padCount           pads in the current pond
//   wasmMemoryBytes()  the WebAssembly memory's size in bytes
//   koiPixels()        {count, x, y}: the koi frame's opaque pixels and their centroid,
//                      in pond pixels
//   canvasSample()     one hash per row of the visible canvas, to detect change

import init, { PondKoi } from '../pkg/pond_wasm.js';
import { computeView } from './view.js';
import * as koiModule from './koi.js';
import * as water from './water.js';
import { setupLegend } from './legend.js';

const LAYERS = [water, koiModule];

const BODY = 'black';
const RESIZE_DEBOUNCE_MS = 300;
const MAX_STEP_SECONDS = 0.1;
const DATA_ERROR = "The pond's data could not be read";
const WASM_ERROR = 'The koi could not be drawn here: WebAssembly failed to load';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('pond');
const display = canvas.getContext('2d', { alpha: false });
const scene = document.createElement('canvas');
const sceneContext = scene.getContext('2d');
const message = document.getElementById('message');

const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  view: computeView(innerWidth, innerHeight, devicePixelRatio),
  koi: null,
  pads: [],
  legend: null,
  snapshot: null,
  reducedMotion: reducedMotionQuery.matches,
  now: 0,
  dt: 0,
  gulped: false,
};
reducedMotionQuery.addEventListener('change', (event) => {
  state.reducedMotion = event.matches;
});

let wasm = null;
const hooks = {
  ready: false,
  error: null,
  frames: 0,
  rebuilds: 0,
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
};
window.__pond = hooks;

function showError(text, error) {
  const reason = error?.message ?? (error === undefined ? '' : String(error));
  hooks.error = reason ? `${text}: ${reason}` : text;
  message.textContent = hooks.error;
  message.hidden = false;
  if (error !== undefined) console.error(error);
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

function rebuildLayers() {
  state.pads = state.koi ? state.koi.pads() : [];
  state.legend = state.koi ? state.koi.legend() : null;
  for (const layer of LAYERS) layer.rebuild?.(state);
}

function applyView() {
  const next = computeView(innerWidth, innerHeight, devicePixelRatio);
  const pondChanged = next.pondWidth !== state.view.pondWidth || next.pondHeight !== state.view.pondHeight;
  state.view = next;
  sizeCanvases(next);
  if (!pondChanged) return;
  if (state.koi) {
    try {
      state.koi.rebuild(next);
    } catch (error) {
      state.koi.free();
      state.koi = null;
      showError(DATA_ERROR, error);
    }
  }
  rebuildLayers();
  hooks.rebuilds += 1;
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyView, RESIZE_DEBOUNCE_MS);
});

let lastTime = null;
function tick(now) {
  const dt = lastTime === null ? 0 : Math.min(MAX_STEP_SECONDS, (now - lastTime) / 1000);
  lastTime = now;
  state.now = now;
  state.dt = dt;
  try {
    state.gulped = state.koi ? state.koi.step(dt) : false;
    for (const layer of LAYERS) layer.draw(sceneContext, state, now);
  } catch (error) {
    // A trap inside the koi leaves it unusable; keep drawing the pond without it.
    state.koi = null;
    showError('The koi stopped swimming', error);
  }
  display.drawImage(scene, 0, 0, canvas.width, canvas.height);
  hooks.frames += 1;
  requestAnimationFrame(tick);
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

// The koi's seed comes from the account, so a visitor sees the same swim each load.
function seedFrom(snapshot) {
  const id = snapshot?.account_id;
  return Number.isSafeInteger(id) && id >= 0 ? BigInt(id) : 0n;
}

async function boot() {
  const wasmLoad = init().then(
    (exports) => exports,
    (error) => {
      showError(WASM_ERROR, error);
      return null;
    },
  );
  let snapshotJson;
  try {
    snapshotJson = await loadSnapshotText();
    state.snapshot = JSON.parse(snapshotJson);
  } catch (error) {
    showError(DATA_ERROR, error);
    return;
  }
  wasm = await wasmLoad;
  if (!wasm) return;
  try {
    state.koi = koiModule.create(state.view, {
      PondKoi,
      memory: wasm.memory,
      snapshotJson,
      body: BODY,
      seed: seedFrom(state.snapshot),
    });
  } catch (error) {
    showError(DATA_ERROR, error);
    return;
  }
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
rebuildLayers();
requestAnimationFrame(tick);
boot();
