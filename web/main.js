import init, { PondKoi } from './pkg/pond_wasm.js';

// Proof page: one git-koi koi swimming in a 640x360 pond through WebAssembly.
//
// Query parameters:
//   total=<n>   replace the snapshot's total contributions (growth stage)
//   body=<name> white, black (default), asagi, tea, gold, platinum
//   koiFps=<n>  hybrid mode: step every animation frame, but render the koi at most
//               n times a second and otherwise re-blit the last bitmap where it was
//
// window.__koiStats is refreshed once a second with the last second's numbers.
// window.__koiRecord keeps every render() time and frame count since it was last
// reset, so scripts/measure.mjs can sample an exact window.

const POND_WIDTH = 640;
const POND_HEIGHT = 360;
const SEED = 1n;
const FOOD_COLOR = '#ffe9a8';

const params = new URLSearchParams(location.search);
const totalParam = params.get('total');
const totalOverride = totalParam === null ? undefined : Number(totalParam);
const bodyName = params.get('body') ?? 'black';
const koiFps = params.has('koiFps') ? Number(params.get('koiFps')) : 0;
const renderInterval = koiFps > 0 ? 1000 / koiFps : 0;

const canvas = document.getElementById('pond');
const context = canvas.getContext('2d');
const overlay = document.getElementById('overlay');

// The bundled page (scripts/bundle.mjs) inlines the wasm bytes and the snapshot.
const inline = globalThis.__KOI_INLINE;
const snapshotJson = inline
  ? inline.snapshotJson
  : await (await fetch('./fixtures/snapshot.json')).text();
const wasm = await init(inline ? { module_or_path: inline.wasmBytes } : undefined);

let koi;
try {
  koi = new PondKoi(snapshotJson, bodyName, POND_WIDTH, POND_HEIGHT, SEED);
  if (totalOverride !== undefined) koi.set_growth_override(totalOverride);
} catch (error) {
  overlay.textContent = `error: ${error.message ?? error}`;
  throw error;
}

// The koi frame goes through a small canvas so drawImage can composite its alpha over
// the water (putImageData would overwrite the water around the koi).
const frameCanvas = document.createElement('canvas');
const frameContext = frameCanvas.getContext('2d');
let frameX = 0;
let frameY = 0;

function copyFrame() {
  const width = koi.frame_width();
  const height = koi.frame_height();
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  // A fresh view every time: memory.buffer is replaced when wasm memory grows.
  const pixels = new Uint8ClampedArray(wasm.memory.buffer, koi.pixels_ptr(), koi.pixels_len());
  frameContext.putImageData(new ImageData(pixels, width, height), 0, 0);
  frameX = koi.frame_x();
  frameY = koi.frame_y();
}

// Scale the pond to the window width: a whole-number scale when at least 1x fits,
// otherwise shrink to fit.
function fitCanvas() {
  const fit = window.innerWidth / POND_WIDTH;
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  canvas.style.width = `${POND_WIDTH * scale}px`;
  canvas.style.height = `${POND_HEIGHT * scale}px`;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

canvas.addEventListener('pointerdown', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * POND_WIDTH;
  const y = ((event.clientY - rect.top) / rect.height) * POND_HEIGHT;
  koi.drop_food(x, y);
  showOverlay();
});

const record = { renderMs: [], stepMs: [], frames: 0, gulps: 0 };
window.__koiRecord = record;
window.__koiResetRecord = () => {
  record.renderMs = [];
  record.stepMs = [];
  record.frames = 0;
};

const stats = {
  renderMsAvg: 0,
  renderMsP95: 0,
  frames: 0,
  stepMsAvg: 0,
  renders: 0,
  gulps: 0,
  behavior: koi.behavior(),
  bodyLength: koi.body_length(),
  frameWidth: koi.frame_width(),
  frameHeight: koi.frame_height(),
  koiFps,
};
window.__koiStats = stats;

let second = { renderMs: [], stepMs: [], frames: 0 };
let secondStart = performance.now();

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function publishSecond(now) {
  stats.renderMsAvg = average(second.renderMs);
  stats.renderMsP95 = percentile95(second.renderMs);
  stats.stepMsAvg = average(second.stepMs);
  stats.renders = second.renderMs.length;
  stats.frames = Math.round((second.frames * 1000) / (now - secondStart));
  stats.gulps = record.gulps;
  showOverlay();
  second = { renderMs: [], stepMs: [], frames: 0 };
  secondStart = now;
}

// Timing lines refresh once a second; the food line also refreshes on a drop or gulp.
function showOverlay() {
  overlay.textContent = [
    `behavior ${stats.behavior}  body ${bodyName}  length ${stats.bodyLength.toFixed(1)} px  frame ${stats.frameWidth}x${stats.frameHeight}`,
    `${koiFps > 0 ? `hybrid koiFps=${koiFps}` : 'render every frame'}  ${stats.frames} fps  ${stats.renders} renders/s`,
    `step ${stats.stepMsAvg.toFixed(2)} ms  render ${stats.renderMsAvg.toFixed(2)} ms (p95 ${stats.renderMsP95.toFixed(2)})  step+render ${(stats.stepMsAvg + (stats.renderMsAvg * stats.renders) / Math.max(1, stats.frames)).toFixed(2)} ms/frame`,
    `gulps ${record.gulps}  ${koi.has_food() ? `food at ${koi.food_x().toFixed(0)},${koi.food_y().toFixed(0)}` : 'click to drop food'}`,
  ].join('\n');
}

let lastTime = null;
let lastRenderTime = -Infinity;

function tick(now) {
  const dtSeconds = lastTime === null ? 0 : Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  const stepStart = performance.now();
  const gulped = koi.step(dtSeconds);
  const stepMs = performance.now() - stepStart;
  second.stepMs.push(stepMs);
  record.stepMs.push(stepMs);

  if (renderInterval === 0 || now - lastRenderTime >= renderInterval) {
    // Keep a steady cadence in hybrid mode without drifting late frame by frame.
    lastRenderTime =
      renderInterval === 0 || now - lastRenderTime > 2 * renderInterval
        ? now
        : lastRenderTime + renderInterval;
    const renderStart = performance.now();
    koi.render();
    const renderMs = performance.now() - renderStart;
    second.renderMs.push(renderMs);
    record.renderMs.push(renderMs);
    copyFrame();
  }

  context.fillStyle = '#123';
  context.fillRect(0, 0, POND_WIDTH, POND_HEIGHT);
  context.drawImage(frameCanvas, frameX, frameY);
  if (koi.has_food()) {
    context.fillStyle = FOOD_COLOR;
    context.fillRect(Math.floor(koi.food_x()) - 1, Math.floor(koi.food_y()) - 1, 2, 2);
  }

  if (gulped) {
    record.gulps += 1;
    stats.gulps = record.gulps;
    showOverlay();
  }
  second.frames += 1;
  record.frames += 1;
  if (now - secondStart >= 1000) publishSecond(now);
  requestAnimationFrame(tick);
}

copyFrame();
requestAnimationFrame(tick);
