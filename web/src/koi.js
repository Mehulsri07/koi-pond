// The koi: a wrapper around the WebAssembly PondKoi, and the koi layer.
//
//   const koi = create(view, { PondKoi, memory, snapshotJson, body, seed });
//   koi.rebuild(view)   // a new PondKoi at the new pond size; the old one is freed
//   koi.step(dt)        // advance dt seconds; true on a gulp
//   koi.dropFood(x, y)  // put food at a pond point, replacing any already there
//   koi.drawInto(ctx)   // render the koi and draw it at its top left, in pond pixels
//   koi.food()          {x, y} of the food in pond pixels, or null
//   koi.renderMode      "every-frame" | "20-per-second" (see Adaptive drawing)
//   koi.pads()          // pads_json(), parsed
//   koi.legend()        // legend_json(), parsed
//   koi.free()          // free the PondKoi; a later rebuild(view) makes a new one
//   koi.source          // what create() was given; PondKoi is read from it at each build
//
// create() and rebuild() throw what PondKoi::new throws (an invalid snapshot, say). A
// failed rebuild leaves the old PondKoi in place; the caller decides whether to free it.

// Adaptive drawing: after create() or rebuild() the time each render takes (render() and
// the copy of its pixels) is averaged over a window of at least MEASURE_MS and
// MIN_SAMPLES frames; above SLOW_RENDER_MS the koi is rendered SLOW_RATE times a second
// instead of every frame. Movement (step) still runs every frame, and between renders the
// last bitmap is drawn again where it was. A gap of more than MAX_GAP_MS between frames
// (a hidden tab, a long task) restarts the window (idle time only: the previous render is not part of the gap), so the
// jank after a pause cannot decide it; after MAX_RESTARTS restarts it decides on what it has,
// and two renders in a row over CRAWL_RENDER_MS (after the warm-up frame) decide "slow" at once.
//
// ?slowKoi=<ms> adds that busy-wait (at most MAX_SLOW_KOI_MS) to every render, to try the
// slow path. It is allowed on the live site: it only slows the tab of whoever put it in
// the address.
const MEASURE_MS = 2000;
const MIN_SAMPLES = 30;
const MAX_GAP_MS = 250;
const CRAWL_RENDER_MS = 100; // two renders in a row this slow decide at once
const MIN_STALLED_SAMPLES = 10; // samples a stalling device needs before it is judged
const MAX_RESTARTS = 3; // gaps after which the window decides on what it has
const SLOW_RENDER_MS = 12;
const SLOW_RATE = 20;
const MAX_SLOW_KOI_MS = 50;

/**
 * The decision, apart from the clock: record(now, cost) once per frame (ms); it returns
 * "every-frame" or "20-per-second" once it can tell, else null.
 */
export function createMeter({
  windowMs = MEASURE_MS,
  minSamples = MIN_SAMPLES,
  maxGapMs = MAX_GAP_MS,
  slowMs = SLOW_RENDER_MS,
  crawlMs = CRAWL_RENDER_MS,
  maxRestarts = MAX_RESTARTS,
} = {}) {
  let start = null;
  let last = null;
  let lastCost = 0;
  let total = 0;
  let count = 0;
  let restarts = 0;
  let crawls = 0; // consecutive renders over crawlMs
  const verdict = () => (total / count > slowMs ? '20-per-second' : 'every-frame');
  return {
    record(now, cost) {
      // The gap is idle time between frames: the previous render is not part of it.
      if (last !== null && now - last - lastCost > maxGapMs) {
        restarts += 1;
        // A device that keeps stalling decides on what it has, if that is enough.
        if (restarts >= maxRestarts && count >= MIN_STALLED_SAMPLES) return verdict();
        start = null;
        total = 0;
        count = 0;
        crawls = 0;
      }
      last = now;
      lastCost = cost;
      if (start === null) {
        start = now;
        return null; // the first frame after a start (or a gap) is JIT warm-up
      }
      // Two renders in a row this slow settle it, whatever else the window holds; one
      // is a hiccup (a GC pause, a tab coming back).
      crawls = cost > crawlMs ? crawls + 1 : 0;
      if (crawls >= 2) return '20-per-second';
      total += cost;
      count += 1;
      if (now - start < windowMs || count < minSamples) return null;
      return verdict();
    },
  };
}

let live = 0;

function slowKoiMs() {
  const value = Number(new URLSearchParams(location.search).get('slowKoi'));
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_SLOW_KOI_MS) : 0;
}

/** How many PondKoi instances exist right now (a leak check for tests). */
export function liveCount() {
  return live;
}

export function create(view, source) {
  const { memory } = source;
  // The koi frame goes through a small canvas so drawImage composites its alpha over the
  // layers below (putImageData would overwrite them).
  const frameCanvas = document.createElement('canvas');
  const frameContext = frameCanvas.getContext('2d');
  let frameX = 0;
  let frameY = 0;
  let instance = null;
  const slowMs = slowKoiMs();
  let mode = 'every-frame';
  let meter = createMeter(); // null once the mode is decided
  let lastRender = -Infinity; // the time the next render is measured from
  let renders = 0;

  function build(nextView) {
    const { PondKoi, snapshotJson, body, seed } = source;
    const next = new PondKoi(snapshotJson, body, nextView.pondWidth, nextView.pondHeight, seed);
    live += 1;
    release();
    instance = next;
    mode = 'every-frame';
    meter = createMeter();
    lastRender = -Infinity;
  }

  // Free the current PondKoi. After a trap inside wasm, free() itself can throw; the
  // instance is abandoned either way.
  function release() {
    if (!instance) return;
    const old = instance;
    instance = null;
    live -= 1;
    try {
      old.free();
    } catch (error) {
      console.error(error);
    }
  }

  function copyFrame() {
    const width = instance.frame_width();
    const height = instance.frame_height();
    if (frameCanvas.width !== width || frameCanvas.height !== height) {
      frameCanvas.width = width;
      frameCanvas.height = height;
    }
    if (width === 0 || height === 0) return;
    // A fresh view every time: memory.buffer is replaced when wasm memory grows.
    const pixels = new Uint8ClampedArray(memory.buffer, instance.pixels_ptr(), instance.pixels_len());
    frameContext.putImageData(new ImageData(pixels, width, height), 0, 0);
    frameX = instance.frame_x();
    frameY = instance.frame_y();
  }

  build(view);

  return {
    source,
    get instance() {
      return instance;
    },
    rebuild(nextView) {
      build(nextView);
    },
    step(dt) {
      return instance.step(dt);
    },
    dropFood(x, y) {
      instance.drop_food(x, y);
    },
    get renders() {
      return renders;
    },
    get renderMode() {
      return mode;
    },
    food() {
      return instance.has_food() ? { x: instance.food_x(), y: instance.food_y() } : null;
    },
    drawInto(ctx) {
      const now = performance.now();
      // Every 50 ms (an accumulator, so 60 Hz frames give 20 renders, not 15); after a
      // long gap it starts again from now.
      const due = mode === 'every-frame' || now - lastRender >= 1000 / SLOW_RATE;
      if (due) {
        lastRender = mode === 'every-frame' || now - lastRender > 2000 / SLOW_RATE ? now : lastRender + 1000 / SLOW_RATE;
        renders += 1;
        instance.render();
        if (slowMs) while (performance.now() - now < slowMs);
        copyFrame();
        if (meter) {
          const decision = meter.record(now, performance.now() - now);
          if (decision) {
            mode = decision;
            meter = null;
          }
        }
      }
      if (frameCanvas.width && frameCanvas.height) ctx.drawImage(frameCanvas, frameX, frameY);
    },
    pads() {
      return JSON.parse(instance.pads_json());
    },
    legend() {
      return JSON.parse(instance.legend_json());
    },
    free() {
      release();
    },
  };
}

/** The koi layer. */
export function draw(ctx, state) {
  state.koi?.drawInto(ctx);
}
