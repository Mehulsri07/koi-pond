// The food layer: the pellet the koi swims to, drawn under the koi.
//
// state.food is {x, y} (the pellet's pond pixel) or null; main.js keeps it from the
// wasm food position and clears it the frame the koi gulps. One pellet at a time: a new
// tap moves it. The approved `food` sprite (web/art/food.png, 3×3) is drawn with its
// anchor on the pixel, over a 1 px shadow down and to the right in a dark water color.
//
// Test hook: drawn() says whether the last draw put a pellet on the pond.

export const name = 'food';

const SHADOW = '#10303a';
let sprite = null; // {image, shadow, anchor}
let failure = null;
let wasDrawn = false;

export function drawn() {
  return wasDrawn;
}

async function load(base = 'art/') {
  const manifest = await (await fetch(`${base}sprites.json`)).json();
  const entry = manifest.food;
  if (!entry) throw new Error('sprites.json has no food');
  const image = new Image();
  image.src = `${base}food.png`;
  await image.decode();
  const shadow = document.createElement('canvas');
  shadow.width = image.width;
  shadow.height = image.height;
  const context = shadow.getContext('2d');
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = SHADOW;
  context.fillRect(0, 0, shadow.width, shadow.height);
  sprite = { image, shadow, anchor: entry.anchor };
}
// A first failure is retried once, on the next rebuild or after RETRY_MS; a second is kept
// for draw() to throw, so main.js switches the layer off and says so.
const RETRY_MS = 3000;
let failures = 0;
let loading = null;
let retryTimer = 0;
function loadOnce() {
  if (loading || sprite || failure) return;
  clearTimeout(retryTimer);
  loading = load()
    .catch((error) => {
      failures += 1;
      if (failures > 1) failure = error;
      else {
        console.warn('Food sprite failed to load; retrying once:', error);
        retryTimer = setTimeout(loadOnce, RETRY_MS);
      }
    })
    .finally(() => {
      loading = null;
    });
}
loadOnce();

export function rebuild() {
  loadOnce();
}

export function draw(ctx, state) {
  wasDrawn = false;
  if (failure) throw failure;
  if (!state.food || !sprite) return;
  const x = Math.floor(state.food.x) - sprite.anchor[0];
  const y = Math.floor(state.food.y) - sprite.anchor[1];
  ctx.drawImage(sprite.shadow, x + 1, y + 1);
  ctx.drawImage(sprite.image, x, y);
  wasDrawn = true;
}
