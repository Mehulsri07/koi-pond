// The lilypad layer: one pad per repository, drawn above the koi, and the input that
// lets a visitor hover, tap and click them.
//
//   loadSprites() -> Promise<sprites>   web/art/sprites.json and the PNGs this layer uses,
//                                       as {name: {width, height, anchor, data}}
//   buildPadLayer(pads, sprites, pondWidth, pondHeight) -> {canvas, hitMask}
//   draw(ctx, state) / rebuild(state)   the layer contract (web/src/main.js)
//   current()      {canvas, hitMask, pads, width, height} for the last build, or null
//   buildCount()   pad layers built since load
//   padAt(x, y)    the pad under a pond pixel, or null
//   attachInput(canvas, {getState, onWaterTap, card})   the pointer rules below
//
// The pads come from pads_json() (Task 3): x, y, diameter and notch are in pond pixels
// and radians. Angles are screen angles with y down, as in git-koi's pond.rs (a point at
// angle a is center + (cos a, sin a)): 0 points east, π/2 south. The sprites' compass
// has n up, so the notch rounds to the nearest of e, se, s, sw, w, nw, n, ne.
//
// Drawing, all hard-edged pixels into one pond-size bitmap built only when the pond's
// size or its pads change (each frame only blits it):
//   1. Still ripples: each pad sprite's water-colored pixels (the ring round its shaded
//      side), for every pad first, so no ripple is drawn over a neighbor's leaf.
//   2. Pads: the rest of each sprite. The sprite is pad-<diameter>-<dir> whose `notch`
//      is the pad's direction, or the one whose `transposedNotch` is, drawn with x and y
//      swapped about its anchor (pad sprites are square with anchor x === y, which
//      scripts/art.mjs --check asserts). The anchor goes on the pad's center. Sprites for
//      32–48 px pads carry a 6 px ripple margin, so sizes come from `diameter`, never
//      from the sprite.
//   3. Flowers: lotus-<bloom>-s on pads up to 32 px, -l on 40–48, with its base at the
//      center pushed toward the pad's widest side (away from the notch), by up to 12% of
//      the diameter, less where that leaves fewer petals hanging off the leaf.
//   4. Droplets on 40 and 48 px pads: one or two, at positions seeded by the repo name,
//      wholly on the leaf and clear of the flower and the notch.
//   5. Buds (bloom "bud"): bud-ring, then bud on the same anchor, with the foot in open
//      water at the center plus (radius + 4) toward whichever of 180°, −135°, −45°, 0° is
//      farthest from the notch (art/bud.txt).
// hitMask holds, per pond pixel, the pad index + 1 under it, from the leaf, flower and
// droplet pixels only: a tap in the notch, on a ripple or on a bud is a tap on water.
//
// Input (attachInput):
//   - A mouse (or pen) moving over a pad shows its card; over water it hides it.
//   - A mouse click on a pad with a url opens it in a new tab. A pad with no url is not
//     clickable.
//   - Touch: the first tap on a pad shows its card; a tap anywhere else hides it.
//   - A click or tap on water calls onWaterTap(x, y) in pond pixels; one on a pad never
//     does.
import { createRandom, seedOf } from './rand.js';

export const name = 'pads';

// The compass directions in screen-angle order (y down): index k is k × 45°.
const COMPASS = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];
// Where a bud may rise, in screen angles (art/bud.txt): left, up-left, up-right, right.
const BUD_ANGLES = [Math.PI, (-3 * Math.PI) / 4, -Math.PI / 4, 0];
const BUD_GAP = 4;
// The sprites' water colors (art/palette.json W and X): a pad sprite's still ripple.
const RIPPLE = new Set(['41,83,83', '86,136,137']);
const DROPLET_SALT = 0x64726f70;

const SPRITE_NAMES = [
  ...[16, 24, 32, 40, 48].flatMap((size) => ['e', 'w', 'ne', 'se', 'nw'].map((dir) => `pad-${size}-${dir}`)),
  'lotus-pink-s', 'lotus-pink-l', 'lotus-white-s', 'lotus-white-l', 'lotus-purple-s', 'lotus-purple-l',
  'bud', 'bud-ring', 'droplet',
];

async function loadImage(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

export async function loadSprites(base = 'art/') {
  const response = await fetch(`${base}sprites.json`);
  if (!response.ok) throw new Error(`${base}sprites.json: HTTP ${response.status}`);
  const manifest = await response.json();
  const sprites = {};
  await Promise.all(
    SPRITE_NAMES.map(async (spriteName) => {
      const entry = manifest[spriteName];
      if (!entry) throw new Error(`sprites.json has no ${spriteName}`);
      const image = await loadImage(`${base}${spriteName}.png`);
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      sprites[spriteName] = { ...entry, width: image.width, height: image.height, data };
    }),
  );
  return sprites;
}

/** The compass direction nearest a screen angle (y down). */
export function compassOf(radians) {
  const step = Math.round(radians / (Math.PI / 4));
  return COMPASS[((step % 8) + 8) % 8];
}

/** The pad sprite and whether to transpose it, for a pad. */
export function padSprite(sprites, diameter, notch) {
  const direction = compassOf(notch);
  for (const dir of ['e', 'w', 'ne', 'se', 'nw']) {
    const spriteName = `pad-${diameter}-${dir}`;
    const sprite = sprites[spriteName];
    if (sprite?.notch === direction) return { sprite, spriteName, transposed: false };
  }
  for (const dir of ['e', 'w', 'ne', 'se', 'nw']) {
    const spriteName = `pad-${diameter}-${dir}`;
    const sprite = sprites[spriteName];
    if (sprite?.transposedNotch === direction) return { sprite, spriteName, transposed: true };
  }
  throw new Error(`no sprite for a ${diameter} px pad with its notch ${direction}`);
}

// The smallest angle between two directions, in [0, π].
function angleBetween(a, b) {
  const difference = Math.abs((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  return difference;
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

export function buildPadLayer(pads, sprites, pondWidth, pondHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = pondWidth;
  canvas.height = pondHeight;
  const hitMask = new Uint16Array(pondWidth * pondHeight);
  const image = new ImageData(pondWidth, pondHeight);
  const out = image.data;

  // Copy a sprite's opaque pixels with its anchor at (x, y), optionally transposed;
  // `keep(r, g, b)` filters them and `each(px, py)` sees every pixel written.
  function blit(sprite, x, y, { transposed = false, keep = null, each = null } = {}) {
    const [anchorX, anchorY] = sprite.anchor;
    const { width, height, data } = sprite;
    for (let sy = 0; sy < height; sy += 1) {
      for (let sx = 0; sx < width; sx += 1) {
        const source = (sy * width + sx) * 4;
        if (data[source + 3] === 0) continue;
        if (keep && !keep(data[source], data[source + 1], data[source + 2])) continue;
        const px = x + (transposed ? sy - anchorY : sx - anchorX);
        const py = y + (transposed ? sx - anchorX : sy - anchorY);
        if (px < 0 || py < 0 || px >= pondWidth || py >= pondHeight) continue;
        const target = (py * pondWidth + px) * 4;
        out[target] = data[source];
        out[target + 1] = data[source + 1];
        out[target + 2] = data[source + 2];
        out[target + 3] = 255;
        each?.(px, py);
      }
    }
  }

  const isRipple = (r, g, b) => RIPPLE.has(`${r},${g},${b}`);
  const placed = pads.map((pad) => ({
    pad,
    x: Math.round(pad.x),
    y: Math.round(pad.y),
    radius: pad.diameter / 2,
    ...padSprite(sprites, pad.diameter, pad.notch),
  }));

  // 1. Still ripples under every pad.
  for (const { sprite, transposed, x, y } of placed) blit(sprite, x, y, { transposed, keep: isRipple });

  // 2. The pads, marking their pixels in the hit mask.
  placed.forEach(({ sprite, transposed, x, y }, index) => {
    blit(sprite, x, y, {
      transposed,
      keep: (r, g, b) => !isRipple(r, g, b),
      each: (px, py) => {
        hitMask[py * pondWidth + px] = index + 1;
      },
    });
  });

  // 3–5. Flowers, droplets, buds.
  const onPad = (index, px, py) =>
    px >= 0 && py >= 0 && px < pondWidth && py < pondHeight && hitMask[py * pondWidth + px] === index + 1;
  // How many of a sprite's opaque pixels, anchored at (x, y), fall off pad `index`.
  const offLeaf = (sprite, x, y, index) => {
    let off = 0;
    for (let sy = 0; sy < sprite.height; sy += 1) {
      for (let sx = 0; sx < sprite.width; sx += 1) {
        if (sprite.data[(sy * sprite.width + sx) * 4 + 3] && !onPad(index, x + sx - sprite.anchor[0], y + sy - sprite.anchor[1])) off += 1;
      }
    }
    return off;
  };
  placed.forEach(({ pad, x, y, radius }, index) => {
    const away = pad.notch + Math.PI;
    let flowerBox = null;
    if (pad.bloom && pad.bloom !== 'bud') {
      const flower = sprites[`lotus-${pad.bloom}-${pad.diameter <= 32 ? 's' : 'l'}`];
      if (flower) {
        // Toward the widest side, and down a little so the bloom's body sits over the
        // center; nearer the center when that would hang the bloom off the leaf (a small
        // lotus is 13 px wide, nearly all of a 16 px pad).
        const lift = Math.round(flower.height * 0.3);
        let best = null;
        for (let shift = Math.round(pad.diameter * 0.12); shift >= 0; shift -= 1) {
          const cx = Math.round(x + shift * Math.cos(away));
          const cy = Math.round(y + shift * Math.sin(away) + lift);
          const off = offLeaf(flower, cx, cy, index);
          if (!best || off < best.off) best = { cx, cy, off };
          if (off === 0) break;
        }
        const fx = best.cx;
        const fy = best.cy;
        blit(flower, fx, fy, {
          each: (px, py) => {
            if (onPad(index, px, py) || !hitMask[py * pondWidth + px]) hitMask[py * pondWidth + px] = index + 1;
          },
        });
        flowerBox = {
          left: fx - flower.anchor[0],
          top: fy - flower.anchor[1],
          right: fx - flower.anchor[0] + flower.width,
          bottom: fy - flower.anchor[1] + flower.height,
        };
      }
    }
    if (pad.diameter >= 40 && sprites.droplet) {
      const droplet = sprites.droplet;
      const random = createRandom(seedOf(hashString(pad.repo ?? ''), DROPLET_SALT));
      const want = random() < 0.5 ? 1 : 2;
      const boxes = flowerBox ? [flowerBox] : [];
      for (let attempt = 0, laid = 0; attempt < 60 && laid < want; attempt += 1) {
        const angle = random() * 2 * Math.PI;
        const distance = random() * (radius - 5);
        if (angleBetween(angle, pad.notch) < 0.9) continue;
        const dx = Math.round(x + distance * Math.cos(angle));
        const dy = Math.round(y + distance * Math.sin(angle));
        const box = {
          left: dx - droplet.anchor[0],
          top: dy - droplet.anchor[1],
          right: dx - droplet.anchor[0] + droplet.width,
          bottom: dy - droplet.anchor[1] + droplet.height,
        };
        const clear = boxes.every(
          (other) => box.right + 2 <= other.left || other.right + 2 <= box.left || box.bottom + 2 <= other.top || other.bottom + 2 <= box.top,
        );
        if (!clear) continue;
        let whollyOnPad = true;
        for (let py = box.top - 1; py <= box.bottom && whollyOnPad; py += 1) {
          for (let px = box.left - 1; px <= box.right && whollyOnPad; px += 1) whollyOnPad = onPad(index, px, py);
        }
        if (!whollyOnPad) continue;
        blit(droplet, dx, dy);
        boxes.push(box);
        laid += 1;
      }
    }
  });
  // Buds last: they stand in the water beside their pads, above any neighbor's ripple.
  for (const { pad, x, y, radius } of placed) {
    if (pad.bloom !== 'bud' || !sprites.bud || !sprites['bud-ring']) continue;
    const angle = BUD_ANGLES.reduce((best, candidate) =>
      angleBetween(candidate, pad.notch) > angleBetween(best, pad.notch) ? candidate : best,
    );
    const footX = Math.round(x + (radius + BUD_GAP) * Math.cos(angle));
    const footY = Math.round(y + (radius + BUD_GAP) * Math.sin(angle));
    blit(sprites['bud-ring'], footX, footY);
    blit(sprites.bud, footX, footY);
  }

  const context = canvas.getContext('2d');
  context.putImageData(image, 0, 0);
  return { canvas, hitMask };
}

// ---------------------------------------------------------------------------------------
// The layer.

let sprites = null;
let loading = null;
let loadError = null;
let wanted = null; // the state the next build is for, while the sprites load
let built = null;
let builds = 0;

export function current() {
  return built;
}

export function buildCount() {
  return builds;
}

function layoutKey(pads, width, height) {
  return `${width}x${height}:${JSON.stringify(pads)}`;
}

function build(state) {
  const { pondWidth, pondHeight } = state.view;
  const pads = state.pads ?? [];
  const key = layoutKey(pads, pondWidth, pondHeight);
  if (built && built.key === key) {
    built.pads = pads;
    return;
  }
  const layer = buildPadLayer(pads, sprites, pondWidth, pondHeight);
  builds += 1;
  built = { ...layer, pads, key, width: pondWidth, height: pondHeight };
}

export function rebuild(state) {
  if (!state.koi) return; // no pads to lay until the koi (and pads_json) exists
  if (sprites) {
    build(state);
    return;
  }
  wanted = state;
  // Errors here (a sprite that will not load, a build that throws) are kept for draw()
  // to throw, so main.js switches the layer off and says so like any other layer.
  loading ??= loadSprites()
    .then((loaded) => {
      sprites = loaded;
      if (wanted) build(wanted);
      wanted = null;
    })
    .catch((error) => {
      loadError = error;
    });
}

export function draw(ctx, state) {
  // A failed load surfaces here, so main.js switches the layer off and says so.
  if (loadError) throw loadError;
  const { pondWidth, pondHeight } = state.view;
  if (!built || built.width !== pondWidth || built.height !== pondHeight) return;
  ctx.drawImage(built.canvas, 0, 0);
}

export function padAt(x, y) {
  if (!built) return null;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= built.width || py >= built.height) return null;
  const id = built.hitMask[py * built.width + px];
  return id ? built.pads[id - 1] ?? null : null;
}

// ---------------------------------------------------------------------------------------
// Input.

export function attachInput(canvas, { getState, onWaterTap, card }) {
  let pointerType = 'mouse';
  let hovered = null;

  const pondPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    const { pondWidth, pondHeight } = getState().view;
    return {
      x: ((event.clientX - rect.left) / rect.width) * pondWidth,
      y: ((event.clientY - rect.top) / rect.height) * pondHeight,
    };
  };

  canvas.addEventListener('pointerdown', (event) => {
    pointerType = event.pointerType || 'mouse';
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const { x, y } = pondPoint(event);
    const pad = padAt(x, y);
    canvas.style.cursor = pad?.url ? 'pointer' : '';
    if (pad === hovered) return;
    hovered = pad;
    if (pad) card.show(pad, event.clientX, event.clientY);
    else card.hide();
  });

  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch') return;
    canvas.style.cursor = '';
    if (card.element.contains(event.relatedTarget)) return;
    hovered = null;
    card.hide();
  });

  card.element.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch' || event.relatedTarget === canvas) return;
    hovered = null;
    card.hide();
  });

  canvas.addEventListener('click', (event) => {
    const type = event.pointerType || pointerType;
    const { x, y } = pondPoint(event);
    const pad = padAt(x, y);
    if (type === 'touch') {
      if (pad) {
        if (card.shownFor() !== pad) card.show(pad, event.clientX, event.clientY);
        return;
      }
      card.hide();
    } else if (pad) {
      if (pad.url) window.open(pad.url, '_blank', 'noopener');
      return;
    }
    onWaterTap(Math.floor(x), Math.floor(y));
  });

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && card.shownFor()) card.hide();
  });
  addEventListener('resize', () => {
    hovered = null;
    card.hide();
  });
}
