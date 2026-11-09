// The pond's size for a viewport. The pond is drawn in native pixels and shown at a
// whole-number scale: 2 on viewports at least 1600×900 CSS px, else 1. The canvas's
// backing store is its CSS size × devicePixelRatio (rounded). At a whole-number
// devicePixelRatio every pond pixel is an exact square of device pixels; at a fractional
// one (1.25, 1.5) neighboring pond pixels differ by one device pixel in size, but nearest-
// neighbor scaling keeps them sharp, never blurred.
//
// spriteScale is the whole number the pond's sprites (pads and their flowers, buds and
// droplets, food, fireflies, the moon) are drawn at, nearest-neighbor, inside the pond: 2
// on laptop-size ponds (view scale 1 and at least SPRITE_2_MIN_POND_WIDTH pond px wide),
// else 1. Phones keep native sprites, and on a scale-2 view the whole pond is doubled
// already. The floor and the koi are never scaled by it.
export const SCALE_2_MIN_WIDTH = 1600;
export const SCALE_2_MIN_HEIGHT = 900;
export const SPRITE_2_MIN_POND_WIDTH = 960;

export function computeView(innerWidth, innerHeight, devicePixelRatio) {
  const scale = innerWidth >= SCALE_2_MIN_WIDTH && innerHeight >= SCALE_2_MIN_HEIGHT ? 2 : 1;
  const pondWidth = Math.max(1, Math.floor(innerWidth / scale));
  const pondHeight = Math.max(1, Math.floor(innerHeight / scale));
  const cssWidth = pondWidth * scale;
  const cssHeight = pondHeight * scale;
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    scale,
    spriteScale: scale === 1 && pondWidth >= SPRITE_2_MIN_POND_WIDTH ? 2 : 1,
    pondWidth,
    pondHeight,
    cssWidth,
    cssHeight,
    backingWidth: Math.round(cssWidth * ratio),
    backingHeight: Math.round(cssHeight * ratio),
  };
}
