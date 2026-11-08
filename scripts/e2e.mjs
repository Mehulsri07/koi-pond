// End-to-end checks for the pond site in headless Chromium.
//
//   node scripts/e2e.mjs [--only <text>] [--screenshots <dir>]
//
// Run scripts/build.sh first so web/pkg exists (the script stops at once if it does not).
// It serves web/ itself on a free port, loads the page with ?fixture
// (web/fixtures/snapshot.json), runs every check at each size it names, saves desktop and
// phone screenshots, and exits non-zero on any failure. --only runs just the checks whose
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
  desktop: join(SCREENSHOT_DIR, 'site-shell-desktop.png'),
  phone: join(SCREENSHOT_DIR, 'site-shell-phone.png'),
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
      await session.page.waitForTimeout(1500);
      await session.page.screenshot({ path: SCREENSHOTS[size] });
      console.log(`screenshot: ${SCREENSHOTS[size]}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  screenshot [${size}]\n      ${error.message ?? error}`);
    } finally {
      await session.context.close();
    }
  }
}

await browser.close();
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exitCode = failed ? 1 : 0;
