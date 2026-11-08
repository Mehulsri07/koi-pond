// The pond's size for a viewport. The pond is drawn in native pixels and shown at a
// whole-number scale: 2 on viewports at least 1600×900 CSS px, else 1. The canvas's
// backing store is its CSS size × devicePixelRatio, so pond pixels stay square.
export const SCALE_2_MIN_WIDTH = 1600;
export const SCALE_2_MIN_HEIGHT = 900;

export function computeView(innerWidth, innerHeight, devicePixelRatio) {
  const scale = innerWidth >= SCALE_2_MIN_WIDTH && innerHeight >= SCALE_2_MIN_HEIGHT ? 2 : 1;
  const pondWidth = Math.max(1, Math.floor(innerWidth / scale));
  const pondHeight = Math.max(1, Math.floor(innerHeight / scale));
  const cssWidth = pondWidth * scale;
  const cssHeight = pondHeight * scale;
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    scale,
    pondWidth,
    pondHeight,
    cssWidth,
    cssHeight,
    backingWidth: Math.round(cssWidth * ratio),
    backingHeight: Math.round(cssHeight * ratio),
  };
}
