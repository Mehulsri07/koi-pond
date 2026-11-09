// End-to-end checks for the pond site in headless Chromium.
//
//   node scripts/e2e.mjs [--only <text>] [--screenshots <dir>]
//
// Run scripts/build.sh first so web/pkg exists (the script stops at once if it does not).
// It serves web/ itself on a free port, loads the page with ?fixture
// (web/fixtures/snapshot.json), runs every check at each size it names, saves desktop and
// phone screenshots (plus one with a pad's card open and a 4× floor detail crop), and exits non-zero on any failure. --only runs just the checks whose
// name contains the text. Screenshots go to --screenshots <dir>, else $E2E_SCREENSHOTS,
// else <os tmpdir>/koi-pond-e2e; the script prints where.
//
// Adding a check: call check(name, sizes, async ({ page, errors, size, open }) => { ... })
// below. `open(query, options)` loads the pond into `page` and waits until window.__pond
// says it is ready (or failed); a check throws (assert) to fail. The page's test hooks
// are on window.__pond; web/src/main.js documents them.
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
const SCREENSHOT_DIR = resolve(argument('--screenshots') ?? process.env.E2E_SCREENSHOTS ?? join(tmpdir(), 'koi-pond-e2e'));
const SCREENSHOTS = {
  desktop: join(SCREENSHOT_DIR, 'site-pads-desktop.png'),
  phone: join(SCREENSHOT_DIR, 'site-pads-phone.png'),
  // The desktop pond with a pad's hover card open.
  card: join(SCREENSHOT_DIR, 'site-pads-card.png'),
  // A 160×100 pond-pixel crop around a rock and a plant clump, at 4× so pixels can be judged.
  detail: join(SCREENSHOT_DIR, 'site-floor-detail.png'),
};

// Pre-flight: without the wasm build every page check would only time out.
for (const file of ['pond_wasm.js', 'pond_wasm_bg.wasm']) {
  if (!existsSync(join(WEB_ROOT, 'pkg', file))) {
    console.error(`web/pkg/${file} is missing: run scripts/build.sh first`);
    process.exit(1);
  }
}

// Every check runs at both sizes unless it names its own. Screenshots a person looks at
// use deviceScaleFactor 2.
const SIZES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
  phone: { viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  fractional: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 },
};
const BOTH = ['desktop', 'phone'];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

function serve() {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
    const file = join(WEB_ROOT, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(WEB_ROOT)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

const checks = [];
function check(name, sizes, run) {
  checks.push({ name, sizes, run });
}

// Wait until boot finished, either way. Returns window.__pond.error (null when fine).
// An uncaught page error during boot fails at once rather than after the timeout.
async function waitForBoot(page) {
  let onError;
  const pageError = new Promise((_, reject) => {
    onError = (error) => reject(new Error(`page error during boot: ${error.message}`));
    page.on('pageerror', onError);
  });
  try {
    await Promise.race([
      page.waitForFunction(() => window.__pond && (window.__pond.ready || window.__pond.error), null, {
        timeout: 30000,
      }),
      pageError,
    ]);
  } finally {
    page.off('pageerror', onError);
  }
  return page.evaluate(() => window.__pond.error);
}

async function resizeAndSettle(page, viewport) {
  const before = await page.evaluate(() => window.__pond.settles);
  await page.setViewportSize(viewport);
  await page.waitForFunction((count) => window.__pond.settles > count, before, { timeout: 5000 });
}

// ---------------------------------------------------------------------------------------
// Pure functions, checked in Node with no browser.

check('the view is computed from the viewport', [], async () => {
  const { computeView } = await import(pathToFileURL(join(WEB_ROOT, 'src', 'view.js')).href);
  assert.deepEqual(computeView(1280, 800, 1), {
    scale: 1, pondWidth: 1280, pondHeight: 800, cssWidth: 1280, cssHeight: 800, backingWidth: 1280, backingHeight: 800,
  });
  assert.deepEqual(computeView(1921, 1081, 2), {
    scale: 2, pondWidth: 960, pondHeight: 540, cssWidth: 1920, cssHeight: 1080, backingWidth: 3840, backingHeight: 2160,
  });
  assert.equal(computeView(1600, 900, 1).scale, 2);
  assert.equal(computeView(1599, 900, 1).scale, 1);
  assert.equal(computeView(1600, 899, 1).scale, 1);
  assert.equal(computeView(2560, 800, 1).scale, 1);
  const fractional = computeView(1366, 768, 1.25);
  assert.equal(fractional.backingWidth, Math.round(1366 * 1.25));
  assert.equal(fractional.backingHeight, Math.round(768 * 1.25));
});

// ---------------------------------------------------------------------------------------
// The page.

check('the koi swims', BOTH, async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const before = await page.evaluate(() => window.__pond.koiPixels());
  const canvasBefore = await page.evaluate(() => window.__pond.canvasSample());
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => window.__pond.koiPixels());
  const canvasAfter = await page.evaluate(() => window.__pond.canvasSample());
  assert.ok(before.count > 50, `koi has opaque pixels (${before.count})`);
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  assert.ok(moved > 0.5, `opaque koi pixels moved ${moved.toFixed(2)} px in 1 s`);
  const changed = canvasBefore.filter((value, index) => value !== canvasAfter[index]).length;
  assert.ok(changed > 0, 'the visible canvas changed over 1 s');
  assert.deepEqual(errors, []);
});

check('the view scales', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  const at1280 = await page.evaluate(() => {
    const canvas = document.getElementById('pond');
    const rect = canvas.getBoundingClientRect();
    return { ...window.__pond.view, rectWidth: rect.width, rectHeight: rect.height, width: canvas.width, height: canvas.height };
  });
  assert.equal(at1280.scale, 1);
  assert.equal(at1280.rectWidth, at1280.pondWidth);
  assert.equal(at1280.rectHeight, at1280.pondHeight);
  assert.equal(at1280.pondWidth, 1280);
  assert.equal(at1280.width, 1280 * 2, 'backing store is css size x devicePixelRatio');

  const rebuilds = await page.evaluate(() => window.__pond.rebuilds);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForFunction((before) => window.__pond.rebuilds > before, rebuilds, { timeout: 5000 });
  const at1920 = await page.evaluate(() => {
    const canvas = document.getElementById('pond');
    const rect = canvas.getBoundingClientRect();
    return { ...window.__pond.view, rectWidth: rect.width, rectHeight: rect.height, width: canvas.width };
  });
  assert.equal(at1920.scale, 2);
  assert.equal(at1920.pondWidth, 960);
  assert.equal(at1920.pondHeight, 540);
  assert.equal(at1920.rectWidth, 2 * at1920.pondWidth);
  assert.equal(at1920.rectHeight, 2 * at1920.pondHeight);
  assert.equal(at1920.width, 1920 * 2);
  const css = await page.evaluate(() => ({
    rendering: getComputedStyle(document.getElementById('pond')).imageRendering,
  }));
  assert.equal(css.rendering, 'pixelated');
});

check('resizing rebuilds without leaking', BOTH, async ({ page, errors, size, open }) => {
  assert.equal(await open(), null);
  const { width, height } = SIZES[size].viewport;
  const other = { width: width - 40, height: height - 100 };
  const resizeTo = async (viewport) => {
    const before = await page.evaluate(() => window.__pond.rebuilds);
    await page.setViewportSize(viewport);
    await page.waitForFunction((count) => window.__pond.rebuilds > count, before, { timeout: 5000 });
  };
  // One round trip first, so memory the smaller pond's first build needs is counted.
  await resizeTo(other);
  await resizeTo({ width, height });
  const startBytes = await page.evaluate(() => window.__pond.wasmMemoryBytes());
  for (let index = 0; index < 20; index += 1) {
    await resizeTo(index % 2 === 0 ? other : { width, height });
  }
  const endBytes = await page.evaluate(() => window.__pond.wasmMemoryBytes());
  const state = await page.evaluate(() => ({ liveKoi: window.__pond.liveKoi, view: window.__pond.view }));
  assert.ok(endBytes - startBytes < 1 << 20, `wasm memory grew ${endBytes - startBytes} bytes over 20 resizes`);
  assert.equal(state.liveKoi, 1, 'exactly one PondKoi is alive');
  assert.equal(state.view.pondWidth, width);
  assert.deepEqual(errors, []);
});

check('bad data shows a message', BOTH, async ({ page, open }) => {
  await page.route('**/fixtures/snapshot.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"schema_version": 4, "account_id": ' }),
  );
  const error = await open();
  assert.ok(error, 'window.__pond.error is set');
  const message = page.locator('#message');
  await message.waitFor({ state: 'visible', timeout: 5000 });
  const text = await message.innerText();
  assert.match(text, /The pond's data could not be read/);
  assert.ok(text.length > "The pond's data could not be read".length + 5, `the message gives a reason: ${text}`);
  // The pond still draws under the message.
  const frames = await page.evaluate(() => window.__pond.frames);
  await page.waitForTimeout(200);
  assert.ok((await page.evaluate(() => window.__pond.frames)) > frames, 'the frame loop keeps running');
});

check('a valid snapshot the koi cannot use shows a message', ['desktop'], async ({ page, open }) => {
  await page.route('**/fixtures/snapshot.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"account_id": 7}' }),
  );
  assert.ok(await open());
  await page.locator('#message').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await page.locator('#message').innerText(), /The pond's data could not be read/);
});

check('the snapshot falls back to the fixture only when missing', ['desktop'], async ({ page, errors, open }) => {
  const requested = [];
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  // Without ?fixture: data/snapshot.json is missing in this repo, so the fixture loads.
  assert.equal(await open(''), null);
  assert.ok(requested.includes('/data/snapshot.json'));
  assert.ok(requested.includes('/fixtures/snapshot.json'));
  // A data/snapshot.json that exists is used, and the fixture is not fetched.
  const fixture = await readFile(join(WEB_ROOT, 'fixtures', 'snapshot.json'), 'utf8');
  await page.route('**/data/snapshot.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: fixture }),
  );
  requested.length = 0;
  assert.equal(await open(''), null);
  assert.ok(requested.includes('/data/snapshot.json'));
  assert.ok(!requested.includes('/fixtures/snapshot.json'));
  // ?fixture never asks for data/snapshot.json.
  requested.length = 0;
  assert.equal(await open(), null);
  assert.ok(!requested.includes('/data/snapshot.json'));
  // Errors from the 404 itself are expected console noise; nothing else is.
  assert.deepEqual(errors.filter((text) => !(/404/.test(text) && /\/data\/snapshot\.json/.test(text))), []);
});

check('the header names the pond', BOTH, async ({ page, open }) => {
  assert.equal(await open(), null);
  const header = page.locator('header');
  assert.match(await header.innerText(), /Mehul Srivastava · koi pond/);
  assert.equal(await header.locator('a[href="https://github.com/Mehulsri07"]').count(), 1);
  const button = header.getByRole('button', { name: 'What am I looking at?' });
  assert.ok(await button.isVisible());
  // The header fits on one strip and stays inside the viewport.
  const box = await header.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.width <= viewport.width && box.height <= 64, `header box ${JSON.stringify(box)}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.equal(overflow, 0, 'no horizontal scroll');
});

check('the legend opens and closes', BOTH, async ({ page, open }) => {
  assert.equal(await open(), null);
  const button = page.getByRole('button', { name: 'What am I looking at?' });
  const legend = page.locator('#legend');
  assert.equal(await legend.isVisible(), false);
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  await button.click();
  await page.waitForFunction(() => document.getElementById('legend').getBoundingClientRect().right <= innerWidth + 0.5
    && document.getElementById('legend').getBoundingClientRect().bottom <= innerHeight + 0.5);
  assert.ok(await legend.isVisible());
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.ok(await page.evaluate(() => document.getElementById('legend').contains(document.activeElement)), 'focus moved in');
  await page.keyboard.press('Escape');
  await legend.waitFor({ state: 'hidden', timeout: 2000 });
  assert.ok(await page.evaluate(() => document.activeElement?.id === 'legend-button'), 'focus returned');
  await button.click();
  await page.getByRole('button', { name: 'Close' }).click();
  await legend.waitFor({ state: 'hidden', timeout: 2000 });
  assert.ok(await page.evaluate(() => document.activeElement?.id === 'legend-button'), 'focus returned');
  // From the keyboard: Enter and Space on the focused button both open it.
  for (const key of ['Enter', 'Space']) {
    await button.focus();
    await page.keyboard.press(key);
    await legend.waitFor({ state: 'visible', timeout: 2000 });
    assert.ok(await page.evaluate(() => document.getElementById('legend').contains(document.activeElement)), `${key}: focus moved in`);
    await page.keyboard.press('Escape');
    await legend.waitFor({ state: 'hidden', timeout: 2000 });
  }
  // The open panel never covers the header button, so it can close the panel too.
  await button.click();
  await page.waitForTimeout(300);
  const boxes = await page.evaluate(() => {
    const a = document.getElementById('legend-button').getBoundingClientRect();
    const b = document.getElementById('legend').getBoundingClientRect();
    return { overlap: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom };
  });
  assert.equal(boxes.overlap, false, 'the legend covers the header button');
  await button.click();
  await legend.waitFor({ state: 'hidden', timeout: 2000 });
});

check('a failing layer is switched off and the koi swims on', BOTH, async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  await page.evaluate(() => {
    window.__calls = 0;
    // On top of everything, so a throw there would previously have killed the koi.
    window.__pond.layers.push({ draw() { window.__calls += 1; throw new Error('test layer broke'); } });
  });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ frames: window.__pond.frames, koi: window.__pond.koiPixels() }));
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => ({
    frames: window.__pond.frames, koi: window.__pond.koiPixels(), calls: window.__calls,
    alive: window.__pond.state.koi !== null, liveKoi: window.__pond.liveKoi, error: window.__pond.error,
  }));
  assert.equal(after.calls, 1, 'the failing layer is drawn once, then switched off');
  assert.ok(after.alive && after.liveKoi === 1, 'the koi survives');
  assert.ok(after.frames > before.frames + 10, 'the frame loop keeps running');
  assert.ok(Math.hypot(after.koi.x - before.koi.x, after.koi.y - before.koi.y) > 0.5, 'the koi still moves');
  assert.match(after.error ?? '', /Part of the pond could not be drawn/);
  assert.doesNotMatch(after.error, /koi stopped/);
  assert.ok(errors.some((text) => /test layer broke/.test(text)), 'the layer error is logged');
});

check('a koi that fails is rebuilt on the next resize', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  await page.evaluate(() => {
    window.__pond.state.koi.instance.step = () => { throw new Error('test koi broke'); };
  });
  await page.waitForFunction(() => window.__pond.state.koi === null, null, { timeout: 2000 });
  const frames = await page.evaluate(() => window.__pond.frames);
  await page.waitForTimeout(300);
  assert.ok((await page.evaluate(() => window.__pond.frames)) > frames, 'the frame loop keeps running');
  assert.match(await page.locator('#message').innerText(), /The koi stopped swimming/);
  await resizeAndSettle(page, { width: 1200, height: 760 });
  const state = await page.evaluate(() => ({ alive: window.__pond.state.koi !== null, liveKoi: window.__pond.liveKoi, error: window.__pond.error }));
  assert.ok(state.alive, 'the koi is back');
  assert.equal(state.liveKoi, 1);
  assert.equal(state.error, null, 'the message clears');
});

check('a failed rebuild says so and retries', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  await page.evaluate(() => {
    const source = window.__pond.state.koi.source;
    window.__source = source;
    window.__realPondKoi = source.PondKoi;
    source.PondKoi = function PondKoi() { throw new Error('no room for a koi'); };
  });
  await resizeAndSettle(page, { width: 1200, height: 760 });
  const failed = await page.evaluate(() => ({ alive: window.__pond.state.koi !== null, liveKoi: window.__pond.liveKoi }));
  const text = await page.locator('#message').innerText();
  assert.match(text, /The pond could not be redrawn at this size: no room for a koi/);
  assert.doesNotMatch(text, /data could not be read/);
  assert.equal(failed.alive, false);
  assert.equal(failed.liveKoi, 0, 'the old koi is freed');
  await page.evaluate(() => { window.__source.PondKoi = window.__realPondKoi; });
  await resizeAndSettle(page, { width: 1280, height: 800 });
  const healed = await page.evaluate(() => ({ alive: window.__pond.state.koi !== null, liveKoi: window.__pond.liveKoi, error: window.__pond.error }));
  assert.ok(healed.alive, 'the retry rebuilt the koi');
  assert.equal(healed.liveKoi, 1);
  assert.equal(healed.error, null);
});

check('a hostile reason is shown as text', ['desktop'], async ({ page, open }) => {
  await page.route('**/fixtures/snapshot.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"account_id": "<img src=x onerror=window.__xss=1>"}' }),
  );
  assert.ok(await open());
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => ({
    xss: window.__xss, images: document.querySelectorAll('#message img').length, text: document.getElementById('message').textContent,
  }));
  assert.equal(result.xss, undefined);
  assert.equal(result.images, 0);
  assert.match(result.text, /<img/);
});

check('missing wasm and missing data both show', ['desktop'], async ({ page, open }) => {
  await page.route('**/pkg/pond_wasm_bg.wasm', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/fixtures/snapshot.json', (route) => route.fulfill({ status: 404, body: '' }));
  assert.ok(await open());
  await page.waitForFunction(() => /WebAssembly/.test(window.__pond.error) && /data could not be read/.test(window.__pond.error), null, { timeout: 5000 });
  const text = await page.locator('#message').innerText();
  assert.match(text, /WebAssembly failed to load/);
  assert.match(text, /The pond's data could not be read/);
});

check('missing wasm glue shows a message', ['desktop'], async ({ page, open }) => {
  await page.route('**/pkg/pond_wasm.js', (route) => route.fulfill({ status: 404, body: '' }));
  const error = await open();
  assert.match(error ?? '', /WebAssembly failed to load/);
});

check('a fractional pixel ratio sizes the backing store', ['fractional'], async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const size = await page.evaluate(() => ({ width: document.getElementById('pond').width, height: document.getElementById('pond').height }));
  assert.deepEqual(size, { width: 1920, height: 1200 });
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
});

check('the page edge matches the pond edge', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  // A layer that colors the pond's edge pixel, so the page color must follow the pond.
  await page.evaluate(() => window.__pond.layers.push({
    draw(ctx, state) { ctx.fillStyle = '#7a4fa3'; ctx.fillRect(state.view.pondWidth - 1, state.view.pondHeight - 1, 1, 1); },
  }));
  // An odd viewport at scale 2 leaves a 1 px strip right and below the canvas.
  await resizeAndSettle(page, { width: 1601, height: 901 });
  await page.waitForTimeout(200);
  const colors = await page.evaluate(() => {
    const canvas = document.getElementById('pond');
    const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data;
    return { pond: `rgb(${r}, ${g}, ${b})`, page: getComputedStyle(document.documentElement).backgroundColor, cssWidth: canvas.getBoundingClientRect().width };
  });
  assert.equal(colors.cssWidth, 1600);
  assert.equal(colors.pond, 'rgb(122, 79, 163)');
  assert.equal(colors.page, colors.pond);
});

// The floor and caustics (web/src/floor.js, web/src/caustics.js).

// The floor hash once boot has rebuilt the layers with the snapshot's seed.
async function floorHashAfterBoot(page) {
  await page.waitForFunction(() => window.__pond.floorSeed === window.__pond.state.snapshot?.account_id, null, { timeout: 5000 });
  return page.evaluate(() => window.__pond.floorHash);
}

check('the floor is the same every load', BOTH, async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const first = await floorHashAfterBoot(page);
  assert.equal(typeof first, 'number');
  assert.equal(await open(), null);
  assert.equal(await floorHashAfterBoot(page), first, 'a second load lays the same floor');
  // Another account lays another floor.
  const fixture = JSON.parse(await readFile(join(WEB_ROOT, 'fixtures', 'snapshot.json'), 'utf8'));
  await page.route('**/fixtures/snapshot.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...fixture, account_id: fixture.account_id + 1 }) }),
  );
  assert.equal(await open(), null);
  assert.notEqual(await floorHashAfterBoot(page), first, 'another seed lays another floor');
  assert.deepEqual(errors, []);
});

check('caustics tile seamlessly', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  const result = await page.evaluate(() => {
    const frames = window.__pond.causticFrames();
    const problems = [];
    let lit = 0;
    let maxAlpha = 0;
    frames.forEach((frame, index) => {
      if (frame.width !== 64 || frame.height !== 64) problems.push(`frame ${index} is ${frame.width}×${frame.height}`);
      const tile = frame.getContext('2d').getImageData(0, 0, 64, 64).data;
      // The same light rendered one pixel past the tile: row 64 and column 64 continue
      // rows and columns 63, so they must equal row and column 0.
      const wide = window.__pond.causticRegion(index, 65, 65).getContext('2d').getImageData(0, 0, 65, 65).data;
      for (let i = 0; i < 64; i += 1) {
        for (let c = 0; c < 4; c += 1) {
          const rowSeam = Math.abs(wide[(64 * 65 + i) * 4 + c] - tile[i * 4 + c]);
          const columnSeam = Math.abs(wide[(i * 65 + 64) * 4 + c] - tile[i * 64 * 4 + c]);
          const inside = Math.abs(wide[(i * 65 + i) * 4 + c] - tile[(i * 64 + i) * 4 + c]);
          if (rowSeam > 1 || columnSeam > 1 || inside > 1) problems.push(`frame ${index} seam at ${i}, channel ${c}`);
        }
      }
      for (let p = 3; p < tile.length; p += 4) {
        if (tile[p]) lit += 1;
        maxAlpha = Math.max(maxAlpha, tile[p]);
      }
    });
    return { count: frames.length, problems: problems.slice(0, 5), lit, maxAlpha };
  });
  assert.equal(result.count, 16);
  assert.deepEqual(result.problems, []);
  assert.ok(result.maxAlpha <= Math.floor(0.1 * 255), `caustic alpha ${result.maxAlpha} is at most 0.10`);
  const share = result.lit / (16 * 64 * 64);
  assert.ok(share > 0.05 && share < 0.4, `caustics light ${(share * 100).toFixed(1)}% of the tile`);
});

check('the light falls in drifting patches', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  const means = [];
  for (let index = 0; index < 6; index += 1) {
    await page.waitForTimeout(300);
    means.push(await page.evaluate(() => window.__pond.causticMask));
  }
  for (const mean of means) assert.ok(mean > 0.02 && mean < 0.3, `mask mean ${mean.toFixed(3)}: some light, most of the pond dark`);
  assert.ok(new Set(means).size > 1, 'the patches drift');
});

check('the banks hold the plants and rocks', BOTH, async ({ page, open }) => {
  assert.equal(await open(), null);
  await floorHashAfterBoot(page);
  const shape = await page.evaluate(() => window.__pond.floorShape);
  assert.ok(shape.bedShare >= 0.06 && shape.bedShare <= 0.12, `plant beds cover ${(shape.bedShare * 100).toFixed(1)}% of the pond`);
  assert.ok(shape.rockGroups >= 2 && shape.rockGroups <= 4, `${shape.rockGroups} rock groups`);
  assert.ok(shape.stones >= 3 * shape.rockGroups && shape.stones <= 6 * shape.rockGroups, `${shape.stones} stones`);
});

check('reduced motion holds the caustics', ['desktop'], async ({ page, open }) => {
  const watch = async () => {
    const seen = new Set();
    for (let index = 0; index < 12; index += 1) {
      seen.add(await page.evaluate(() => window.__pond.causticFrame));
      await page.waitForTimeout(60);
    }
    return [...seen];
  };
  assert.equal(await open(), null);
  assert.ok((await watch()).length > 3, 'caustics play at 8 fps');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  assert.deepEqual(await watch(), [0], 'reduced motion holds frame 0');
  const masks = new Set();
  for (let index = 0; index < 4; index += 1) {
    masks.add(await page.evaluate(() => window.__pond.causticMask));
    await page.waitForTimeout(200);
  }
  assert.equal(masks.size, 1, 'reduced motion holds the light patches still');
  assert.equal(await open(), null);
  assert.deepEqual(await watch(), [0], 'reduced motion from the start holds frame 0');
});

check('the floor and caustics cost under 1.5 ms a frame', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  await page.waitForTimeout(1000);
  // The median of 5 runs, against a plain pond-size blit measured the same way, so a slow
  // machine slows both sides: the budget is what these layers add beyond that blit.
  // Measuring must not disturb the live light: its state is read just before and after,
  // in the same task, before any frame could redraw it.
  const { cost, before, after } = await page.evaluate(() => {
    const live = () => window.__pond.causticLive();
    const start = live();
    const measured = window.__pond.layerCost(['floor', 'caustics'], { runs: 5, count: 60 });
    return { cost: measured, before: start, after: live() };
  });
  const added = cost.layers - cost.calibration;
  console.log(`      floor + caustics: ${cost.layers.toFixed(3)} ms a frame, one plain blit ${cost.calibration.toFixed(3)} ms, added ${added.toFixed(3)} ms`);
  assert.ok(added < 1.5, `floor + caustics add ${added.toFixed(3)} ms a frame beyond one blit`);
  // The draw calls in the live frame loop (JavaScript time only) fit the budget too.
  const inLoop = await page.evaluate(() => window.__pond.layerMs);
  assert.ok(inLoop.floor + inLoop.caustics < 1.5, `in-loop draw calls ${JSON.stringify(inLoop)}`);
  assert.deepEqual(after, before, 'measuring leaves the live caustics as they were');
});

check('the floor is built once, for the account', ['desktop'], async ({ page, errors, open }) => {
  // Hold the snapshot back: until it arrives no floor is laid, so no stand-in floor flashes.
  let release;
  const held = new Promise((done) => { release = done; });
  await page.route('**/fixtures/snapshot.json', async (route) => { await held; await route.continue(); });
  await page.goto(`${baseUrl}?fixture`);
  await page.waitForFunction(() => window.__pond && window.__pond.frames > 5);
  const waiting = await page.evaluate(() => ({ builds: window.__pond.floorBuilds, hash: window.__pond.floorHash }));
  assert.deepEqual(waiting, { builds: 0, hash: null }, 'no floor before the snapshot');
  release();
  await page.waitForFunction(() => window.__pond.ready);
  await page.waitForTimeout(300);
  const booted = await page.evaluate(() => ({ builds: window.__pond.floorBuilds, seed: window.__pond.floorSeed, caustics: window.__pond.causticBuilds }));
  assert.deepEqual(booted, { builds: 1, seed: 1001, caustics: 1 }, 'one floor and one set of caustics, for the account');
  assert.deepEqual(errors, []);
});

check('error paths still lay a floor', ['desktop'], async ({ page, open }) => {
  const floorAfter = async () => {
    await page.waitForFunction(() => window.__pond.floorBuilds > 0, null, { timeout: 5000 });
    await page.waitForTimeout(200);
    return page.evaluate(() => ({ builds: window.__pond.floorBuilds, seed: window.__pond.floorSeed, hasHash: window.__pond.floorHash !== null }));
  };
  // Unreadable data: the floor falls back to seed 0.
  await page.route('**/fixtures/snapshot.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"account_id": ' }));
  assert.ok(await open());
  assert.deepEqual(await floorAfter(), { builds: 1, seed: 0, hasHash: true }, 'bad data');
  await page.unroute('**/fixtures/snapshot.json');
  // A snapshot the koi cannot use still names the account.
  await page.route('**/fixtures/snapshot.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"account_id": 7}' }));
  assert.ok(await open());
  assert.deepEqual(await floorAfter(), { builds: 1, seed: 7, hasHash: true }, 'unusable snapshot');
  await page.unroute('**/fixtures/snapshot.json');
  // No WebAssembly: the koi is missing but the floor is the account's.
  await page.route('**/pkg/pond_wasm_bg.wasm', (route) => route.fulfill({ status: 404, body: '' }));
  assert.ok(await open());
  assert.deepEqual(await floorAfter(), { builds: 1, seed: 1001, hasHash: true }, 'missing wasm');
});

check('tiny ponds still build', ['desktop'], async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const results = await page.evaluate(async () => {
    const floor = await import('/src/floor.js');
    const caustics = await import('/src/caustics.js');
    const out = [];
    for (const [width, height] of [[200, 120], [50, 400], [30, 300], [8, 8]]) {
      try {
        const laid = floor.layFloor(width, height, 1234);
        const light = caustics.measureLight(width, height, 1.5);
        out.push({
          width, height, canvas: laid.canvas.width === width && laid.canvas.height === height,
          finite: [laid.bedShare, laid.rockGroups, laid.stones, laid.detail.x, laid.detail.y, light.mean].every(Number.isFinite),
          runs: light.runs.every((run) => run.every(Number.isFinite)),
        });
      } catch (error) {
        out.push({ width, height, error: String(error) });
      }
    }
    return out;
  });
  for (const result of results) {
    assert.deepEqual(result, { width: result.width, height: result.height, canvas: true, finite: true, runs: true }, JSON.stringify(result));
  }
  assert.deepEqual(errors, []);
});

check('the page edge takes the floor edge color', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  await resizeAndSettle(page, { width: 1601, height: 901 });
  await page.waitForTimeout(300);
  const colors = await page.evaluate(() => {
    const canvas = document.getElementById('pond');
    const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data;
    return { pond: `rgb(${r}, ${g}, ${b})`, page: getComputedStyle(document.documentElement).backgroundColor };
  });
  assert.equal(colors.page, colors.pond);
  assert.notEqual(colors.pond, 'rgb(111, 179, 184)', 'the floor, not the placeholder water');
});


// The lilypads (web/src/pads.js, web/src/card.js).

// Once the pad layer is built for the koi's pads: the pads, the pond view and, per pad, a
// point to aim at. `inside` is the pad pixel nearest its center (in pond pixels) that is
// below the header; `notchPoint` is a water pixel inside the pad's disc along the notch's
// compass direction (null if none); `opposite` counts water pixels along the far side's
// ray, which must be all pad.
async function padTargets(page) {
  await page.waitForFunction(() => window.__pond.padBuilds > 0 && window.__pond.padMask()?.pads === window.__pond.state.pads, null, { timeout: 5000 });
  return page.evaluate(() => {
    const { width, height, mask } = window.__pond.padMask();
    const { view, pads, headerHeight } = window.__pond.state;
    const top = Math.ceil(headerHeight / view.scale) + 2;
    const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : -1);
    // Open water near the bottom-left corner, for taps that miss every pad.
    let water = null;
    for (let y = height - 4; y > height / 2 && !water; y -= 1) {
      for (let x = 4; x < width / 2 && !water; x += 1) if (at(x, y) === 0) water = { x, y };
    }
    return {
      view,
      water,
      pads: pads.map((pad, index) => {
        const radius = pad.diameter / 2;
        let inside = null;
        for (let ring = 0; ring <= radius && !inside; ring += 1) {
          for (let dy = -ring; dy <= ring && !inside; dy += 1) {
            for (let dx = -ring; dx <= ring && !inside; dx += 1) {
              const x = Math.round(pad.x) + dx;
              const y = Math.round(pad.y) + dy;
              if (y >= top && at(x, y) === index + 1) inside = { x, y };
            }
          }
        }
        // Screen angles, y down: 0 is east, π/2 is south. The sprite serves the nearest
        // of the eight compass directions.
        const step = Math.round(pad.notch / (Math.PI / 4));
        const angle = step * (Math.PI / 4);
        let notchPoint = null;
        let opposite = 0;
        for (let t = radius * 0.3; t <= radius - 1.5; t += 0.5) {
          const x = Math.round(pad.x + t * Math.cos(angle));
          const y = Math.round(pad.y + t * Math.sin(angle));
          if (!notchPoint && at(x, y) === 0) notchPoint = { x, y };
          if (at(Math.round(pad.x - t * Math.cos(angle)), Math.round(pad.y - t * Math.sin(angle))) === 0) opposite += 1;
        }
        return { ...pad, index, inside, notchPoint, opposite };
      }),
    };
  });
}

// The client point at the middle of a pond pixel.
// Touch points may land on whole CSS pixels, so aim a little left and up of the middle.
const clientPoint = (view, { x, y }) => ({ x: (x + 0.4) * view.scale, y: (y + 0.4) * view.scale });

// Pads with a pad pixel below the header to aim at.
const reachable = (targets) => targets.pads.filter((pad) => pad.inside);

check('pads match the data', BOTH, async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const targets = await padTargets(page);
  const result = await page.evaluate(() => {
    const { width, height, mask, canvas } = window.__pond.padMask();
    // 4-connected components of opaque pad pixels (ripples, buds and water excluded).
    const seen = new Uint8Array(width * height);
    const components = [];
    const stack = [];
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || seen[start]) continue;
      const id = mask[start];
      let size = 0;
      let mixed = false;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const pixel = stack.pop();
        size += 1;
        if (mask[pixel] !== id) mixed = true;
        const x = pixel % width;
        for (const next of [pixel - width, pixel + width, x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1]) {
          if (next >= 0 && next < mask.length && mask[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      if (size > 4) components.push({ id, size, mixed });
    }
    // Every mask pixel is opaque in the layer.
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let clear = 0;
    for (let index = 0; index < mask.length; index += 1) if (mask[index] && data[index * 4 + 3] !== 255) clear += 1;
    return {
      components, clear, padCount: window.__pond.padCount, builds: window.__pond.padBuilds,
      size: [width, height], view: [window.__pond.view.pondWidth, window.__pond.view.pondHeight],
    };
  });
  assert.equal(result.padCount, 7, 'the fixture has 7 owned repos');
  assert.equal(result.components.length, result.padCount, `components ${JSON.stringify(result.components)}`);
  assert.deepEqual(result.components.map(({ id }) => id).sort((a, b) => a - b), targets.pads.map((pad) => pad.index + 1));
  assert.ok(result.components.every(({ mixed }) => !mixed), 'each pad is one id');
  assert.equal(result.clear, 0, 'every hit pixel is drawn');
  assert.deepEqual(result.size, result.view, 'the mask is pond-sized');
  assert.equal(result.builds, 1, 'the pad layer is built once');
  // The bigger the pad, the more of it there is.
  for (const pad of targets.pads) {
    const component = result.components.find(({ id }) => id === pad.index + 1);
    const disc = Math.PI * (pad.diameter / 2) ** 2;
    assert.ok(component.size > 0.6 * disc && component.size < 1.1 * disc, `${pad.repo}: ${component.size} px for a ${pad.diameter} px pad`);
  }
  // The layer is drawn above the koi: a pad pixel on screen is the layer's pixel.
  await page.waitForTimeout(200);
  const onScreen = await page.evaluate((point) => {
    const { canvas } = window.__pond.padMask();
    const layer = canvas.getContext('2d').getImageData(point.x, point.y, 1, 1).data;
    const pond = document.getElementById('pond');
    const ratio = pond.width / window.__pond.view.pondWidth;
    const shown = pond.getContext('2d').getImageData(Math.floor((point.x + 0.5) * ratio), Math.floor((point.y + 0.5) * ratio), 1, 1).data;
    return { layer: [...layer], shown: [...shown] };
  }, reachable(targets)[0].inside);
  assert.deepEqual(onScreen.shown, onScreen.layer);
  assert.deepEqual(errors, []);
});

check('the notch is water', BOTH, async ({ page, errors, size, open }) => {
  assert.equal(await open(), null);
  const targets = await padTargets(page);
  for (const pad of targets.pads) {
    assert.ok(pad.notchPoint, `${pad.repo} (${pad.diameter} px, notch ${pad.notch.toFixed(2)}): water along the notch`);
    assert.equal(pad.opposite, 0, `${pad.repo}: the side opposite the notch is all pad`);
  }
  // A tap in the biggest pad's notch drops food there.
  const top = Math.ceil((await page.evaluate(() => window.__pond.state.headerHeight)) / targets.view.scale) + 2;
  const pad = targets.pads.filter((each) => each.notchPoint.y >= top).sort((a, b) => b.diameter - a.diameter)[0];
  const point = clientPoint(targets.view, pad.notchPoint);
  const before = await page.evaluate(() => window.__pond.foodDrops);
  if (size === 'phone') await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await page.waitForFunction((count) => window.__pond.foodDrops > count, before, { timeout: 2000 });
  assert.deepEqual(await page.evaluate(() => window.__pond.lastFood), pad.notchPoint);
  assert.deepEqual(errors, []);
});

check('hovering a pad names its repo', ['desktop'], async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const targets = await padTargets(page);
  const card = page.locator('#pad-card');
  for (const pad of reachable(targets)) {
    const point = clientPoint(targets.view, pad.inside);
    await page.mouse.move(point.x, point.y);
    await card.waitFor({ state: 'visible', timeout: 2000 });
    const text = await card.innerText();
    assert.ok(text.includes(pad.repo.split('/')[1]), `card names ${pad.repo}: ${text}`);
    assert.match(text, new RegExp(`${pad.commits} commits? by Mehul`));
    if (pad.language) assert.ok(text.includes(pad.language), `card names ${pad.language}`);
    const link = card.getByRole('link', { name: 'Open repo' });
    assert.equal(await link.getAttribute('href'), pad.url);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
    // Inside the viewport.
    const box = await card.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `card box ${JSON.stringify(box)}`);
    // A hover card lets the pointer through, so a neighboring pad under it still hovers.
    assert.equal(await card.evaluate((element) => getComputedStyle(element).pointerEvents), 'none');
    const dot = await card.locator('.pad-card-dot').evaluate((element) => getComputedStyle(element).backgroundColor);
    if (pad.languageColor) {
      const hex = pad.languageColor.slice(1).match(/../g).map((part) => parseInt(part, 16));
      assert.equal(dot, `rgb(${hex.join(', ')})`);
    }
  }
  // Water hides it, and a hover never drops food.
  const point = clientPoint(targets.view, targets.water);
  await page.mouse.move(point.x, point.y);
  await card.waitFor({ state: 'hidden', timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__pond.foodDrops), 0);
  assert.deepEqual(errors, []);
});

check('clicking a pad opens the repo', ['desktop'], async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'repo' }));
  const targets = await padTargets(page);
  const pad = reachable(targets)[0];
  const point = clientPoint(targets.view, pad.inside);
  const popup = page.context().waitForEvent('page', { timeout: 5000 });
  await page.mouse.click(point.x, point.y);
  const opened = await popup;
  await opened.waitForLoadState();
  assert.equal(opened.url(), pad.url);
  assert.equal(await page.evaluate(() => window.__pond.foodDrops), 0, 'a click on a pad drops no food');
  // A click on water feeds instead, and opens nothing.
  let extra = 0;
  page.context().on('page', () => { extra += 1; });
  const water = clientPoint(targets.view, targets.water);
  await page.mouse.click(water.x, water.y);
  await page.waitForFunction(() => window.__pond.foodDrops === 1, null, { timeout: 2000 });
  await page.waitForTimeout(200);
  assert.equal(extra, 0);
  assert.deepEqual(errors, []);
});

check('tapping a pad drops no food', ['phone'], async ({ page, errors, open }) => {
  assert.equal(await open(), null);
  const targets = await padTargets(page);
  const card = page.locator('#pad-card');
  let popups = 0;
  page.context().on('page', () => { popups += 1; });
  const pad = reachable(targets)[0];
  const point = clientPoint(targets.view, pad.inside);
  await page.touchscreen.tap(point.x, point.y);
  await card.waitFor({ state: 'visible', timeout: 2000 });
  assert.ok((await card.innerText()).includes(pad.repo.split('/')[1]));
  // A touch card stays tappable, so its "Open repo" link works.
  assert.equal(await card.evaluate((element) => getComputedStyle(element).pointerEvents), 'auto');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pond.foodDrops), 0, 'a tap on a pad drops no food');
  assert.equal(popups, 0, 'the first tap only shows the card');
  // A tap elsewhere hides the card (and, on water, feeds).
  const water = clientPoint(targets.view, targets.water);
  await page.touchscreen.tap(water.x, water.y);
  await card.waitFor({ state: 'hidden', timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__pond.foodDrops), 1);
  assert.deepEqual(errors, []);
});

check('a pad without a link shows its name as text', ['desktop'], async ({ page, errors, open }) => {
  const fixture = JSON.parse(await readFile(join(WEB_ROOT, 'fixtures', 'snapshot.json'), 'utf8'));
  // Not a plain owner/name, so pads_json gives it no url.
  fixture.owned_repositories[0].name_with_owner = 'Mehulsri07/<img src=x onerror=window.__xss=1>';
  await page.route('**/fixtures/snapshot.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }),
  );
  assert.equal(await open(), null);
  const targets = await padTargets(page);
  const pad = targets.pads.find((each) => each.url === null);
  assert.ok(pad && pad.inside, 'the unlinked pad is on screen');
  const point = clientPoint(targets.view, pad.inside);
  let popups = 0;
  page.context().on('page', () => { popups += 1; });
  await page.mouse.move(point.x, point.y);
  const card = page.locator('#pad-card');
  await card.waitFor({ state: 'visible', timeout: 2000 });
  assert.match(await card.innerText(), /<img src=x/);
  assert.equal(await card.locator('a').count(), 0, 'no link');
  assert.equal(await card.locator('img').count(), 0);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(300);
  assert.equal(popups, 0, 'not clickable');
  assert.equal(await page.evaluate(() => window.__pond.foodDrops), 0, 'and no food');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.deepEqual(errors, []);
});

check('the pads cost one blit a frame', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  await padTargets(page);
  const cost = await page.evaluate(() => window.__pond.layerCost(['pads'], { runs: 5, count: 60 }));
  const added = cost.layers - cost.calibration;
  console.log(`      pads: ${cost.layers.toFixed(3)} ms a frame, one plain blit ${cost.calibration.toFixed(3)} ms, added ${added.toFixed(3)} ms`);
  assert.ok(added < 0.5, `the pad layer adds ${added.toFixed(3)} ms a frame beyond one blit`);
  const builds = await page.evaluate(() => window.__pond.padBuilds);
  // A resize that changes the pond's size rebuilds the layer once.
  await resizeAndSettle(page, { width: 1200, height: 760 });
  await page.waitForFunction((count) => window.__pond.padBuilds === count + 1, builds, { timeout: 5000 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pond.padBuilds), builds + 1, 'one rebuild for one new pond size');
});


// Rebuild the pad layer the way main.js does, without a resize.
const rebuildPads = (page) => page.evaluate(() => window.__pond.layers.find((layer) => layer.name === 'pads').rebuild(window.__pond.state));

check('a rebuild hides the card and the mask follows the pond', ['desktop'], async ({ page, open }) => {
  assert.equal(await open(), null);
  const targets = await padTargets(page);
  const pad = reachable(targets).sort((a, b) => a.y - b.y)[0];
  const point = clientPoint(targets.view, pad.inside);
  const card = page.locator('#pad-card');
  await page.mouse.move(point.x, point.y);
  await card.waitFor({ state: 'visible', timeout: 2000 });
  await rebuildPads(page);
  await card.waitFor({ state: 'hidden', timeout: 1000 });
  // A koi rebuild that fails leaves no pads: the old pond's mask must not answer taps.
  await page.evaluate(() => {
    const source = window.__pond.state.koi.source;
    source.PondKoi = function PondKoi() { throw new Error('no room for a koi'); };
  });
  await resizeAndSettle(page, { width: targets.view.pondWidth, height: targets.view.pondHeight - 100 });
  const after = await page.evaluate(() => {
    const mask = window.__pond.padMask();
    return { mask: mask && { width: mask.width, height: mask.height }, view: window.__pond.view, koi: window.__pond.state.koi !== null };
  });
  assert.equal(after.koi, false);
  assert.ok(after.mask === null || (after.mask.width === after.view.pondWidth && after.mask.height === after.view.pondHeight), `mask ${JSON.stringify(after.mask)}`);
  const before = await page.evaluate(() => window.__pond.foodDrops);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(200);
  assert.equal(await card.isVisible(), false, 'no card for a pad that is not drawn');
  assert.equal(await page.evaluate(() => window.__pond.foodDrops), before + 1, 'the old pad spot is water now');
});

check('a sprite that fails once loads on the next rebuild', ['desktop'], async ({ page, open }) => {
  let failures = 0;
  await page.route('**/art/droplet.png', (route) => {
    if (failures < 1) {
      failures += 1;
      return route.abort();
    }
    return route.continue();
  });
  assert.equal(await open(), null);
  await page.waitForFunction(() => window.__pond.frames > 10);
  await page.waitForTimeout(300);
  assert.equal(failures, 1);
  assert.deepEqual(await page.evaluate(() => ({ builds: window.__pond.padBuilds, error: window.__pond.error })), { builds: 0, error: null }, 'one failure is not shown');
  await rebuildPads(page);
  await page.waitForFunction(() => window.__pond.padBuilds > 0, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__pond.error), null);
  await padTargets(page);

  // Failing again on the retry says so.
  await page.unroute('**/art/droplet.png');
  await page.route('**/art/droplet.png', (route) => route.abort());
  assert.equal(await open(), null);
  await page.waitForTimeout(300);
  await rebuildPads(page);
  await page.waitForFunction(() => /Part of the pond could not be drawn/.test(window.__pond.error ?? ''), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__pond.state.koi !== null), true, 'the koi swims on');
});

// ---------------------------------------------------------------------------------------

const only = argument('--only');
const server = await serve();
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
let failed = 0;

async function newPage(size) {
  const context = await browser.newContext(SIZES[size]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  const open = async (query = '?fixture', { waitUntil = 'load' } = {}) => {
    await page.goto(`${baseUrl}${query}`, { waitUntil });
    return waitForBoot(page);
  };
  return { context, page, errors, open };
}

for (const { name, sizes, run } of checks) {
  if (only && !name.includes(only)) continue;
  for (const size of sizes.length ? sizes : ['node']) {
    const label = sizes.length ? `${name} [${size}]` : name;
    const started = Date.now();
    let session = null;
    try {
      if (size !== 'node') session = await newPage(size);
      await run({ ...session, size });
      console.log(`PASS  ${label}  (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${label}\n      ${String(error.message ?? error).split('\n').join('\n      ')}`);
    } finally {
      await session?.context.close();
    }
  }
}

if (!only) {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  for (const size of BOTH) {
    const session = await newPage(size);
    try {
      assert.equal(await session.open(), null);
      await padTargets(session.page);
      await session.page.waitForTimeout(1500);
      await session.page.screenshot({ path: SCREENSHOTS[size] });
      console.log(`screenshot: ${SCREENSHOTS[size]}`);
      if (size === 'desktop') {
        // The biggest pad's card, opened by hovering it.
        const targets = await padTargets(session.page);
        const pad = reachable(targets).sort((a, b) => b.diameter - a.diameter)[0];
        const point = clientPoint(targets.view, pad.inside);
        await session.page.mouse.move(point.x, point.y);
        await session.page.locator('#pad-card').waitFor({ state: 'visible', timeout: 2000 });
        await session.page.screenshot({ path: SCREENSHOTS.card });
        console.log(`screenshot: ${SCREENSHOTS.card}`);
      }
    } catch (error) {
      failed += 1;
      console.log(`FAIL  screenshot [${size}]\n      ${error.message ?? error}`);
    } finally {
      await session.context.close();
    }
  }
  // The detail crop: a 4× context, clipped to the region floor.js names (a rock beside a
  // plant clump, away from the header).
  const detailContext = await browser.newContext({ ...SIZES.desktop, deviceScaleFactor: 4 });
  try {
    const page = await detailContext.newPage();
    await page.goto(`${baseUrl}?fixture`);
    assert.equal(await waitForBoot(page), null);
    await floorHashAfterBoot(page);
    await page.waitForTimeout(500);
    const region = await page.evaluate(() => window.__pond.floorDetail);
    await page.screenshot({ path: SCREENSHOTS.detail, clip: { ...region, width: 160, height: 100 } });
    console.log(`screenshot: ${SCREENSHOTS.detail}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  screenshot [detail]\n      ${error.message ?? error}`);
  } finally {
    await detailContext.close();
  }
}

await browser.close();
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exitCode = failed ? 1 : 0;
