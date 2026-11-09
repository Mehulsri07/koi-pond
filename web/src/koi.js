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

// Adaptive drawing: for MEASURE_MS after create() or rebuild() the time each render takes
// (render() and the copy of its pixels) is averaged; above SLOW_RENDER_MS the koi is
// rendered SLOW_RATE times a second instead of every frame. Movement (step) still runs
// every frame, and between renders the last bitmap is drawn again where it was.
//
// ?slowKoi=<ms> adds that busy-wait to every render, to try the slow path. It is allowed
// on the live site: it only slows the tab of whoever put it in the address.
const MEASURE_MS = 2000;
const SLOW_RENDER_MS = 12;
const SLOW_RATE = 20;

let live = 0;

function slowKoiMs() {
  const value = Number(new URLSearchParams(location.search).get('slowKoi'));
  return Number.isFinite(value) && value > 0 ? value : 0;
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
  let measureStart = null; // time of the first render after a build
  let measuredTotal = 0;
  let measuredCount = 0;
  let lastRender = -Infinity;

  function build(nextView) {
    const { PondKoi, snapshotJson, body, seed } = source;
    const next = new PondKoi(snapshotJson, body, nextView.pondWidth, nextView.pondHeight, seed);
    live += 1;
    release();
    instance = next;
    mode = 'every-frame';
    measureStart = null;
    measuredTotal = 0;
    measuredCount = 0;
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
    get renderMode() {
      return mode;
    },
    food() {
      return instance.has_food() ? { x: instance.food_x(), y: instance.food_y() } : null;
    },
    drawInto(ctx) {
      const now = performance.now();
      if (mode === 'every-frame' || now - lastRender >= 1000 / SLOW_RATE) {
        lastRender = now;
        instance.render();
        if (slowMs) while (performance.now() - now < slowMs);
        copyFrame();
        if (mode === 'every-frame') {
          if (measureStart === null) measureStart = now;
          measuredTotal += performance.now() - now;
          measuredCount += 1;
          if (now - measureStart >= MEASURE_MS) {
            if (measuredTotal / measuredCount > SLOW_RENDER_MS) mode = '20-per-second';
            measureStart = Infinity; // decided: stop measuring until the next build
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
