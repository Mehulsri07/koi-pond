// The koi: a wrapper around the WebAssembly PondKoi, and the koi layer.
//
//   const koi = create(view, { PondKoi, memory, snapshotJson, body, seed });
//   koi.rebuild(view)   // a new PondKoi at the new pond size; the old one is freed
//   koi.step(dt)        // advance dt seconds; true on a gulp
//   koi.drawInto(ctx)   // render the koi and draw it at its top left, in pond pixels
//   koi.pads()          // pads_json(), parsed
//   koi.legend()        // legend_json(), parsed
//   koi.free()
//
// create() and rebuild() throw what PondKoi::new throws (an invalid snapshot, say).

let live = 0;

/** How many PondKoi instances exist right now (a leak check for tests). */
export function liveCount() {
  return live;
}

export function create(view, { PondKoi, memory, snapshotJson, body, seed }) {
  // The koi frame goes through a small canvas so drawImage composites its alpha over the
  // layers below (putImageData would overwrite them).
  const frameCanvas = document.createElement('canvas');
  const frameContext = frameCanvas.getContext('2d');
  let frameX = 0;
  let frameY = 0;
  let instance = null;

  function build(nextView) {
    const next = new PondKoi(snapshotJson, body, nextView.pondWidth, nextView.pondHeight, seed);
    live += 1;
    if (instance) {
      instance.free();
      live -= 1;
    }
    instance = next;
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
    get instance() {
      return instance;
    },
    rebuild(nextView) {
      build(nextView);
    },
    step(dt) {
      return instance.step(dt);
    },
    drawInto(ctx) {
      instance.render();
      copyFrame();
      if (frameCanvas.width && frameCanvas.height) ctx.drawImage(frameCanvas, frameX, frameY);
    },
    pads() {
      return JSON.parse(instance.pads_json());
    },
    legend() {
      return JSON.parse(instance.legend_json());
    },
    free() {
      if (!instance) return;
      instance.free();
      instance = null;
      live -= 1;
    },
  };
}

/** The koi layer. */
export function draw(ctx, state) {
  state.koi?.drawInto(ctx);
}
