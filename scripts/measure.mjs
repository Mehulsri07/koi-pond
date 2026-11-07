// Measure the koi in headless Chromium: serve web/, open the page at 1280x720 for each
// growth total in both modes (render every frame, and ?koiFps=20), warm up 2 s, sample
// 5 s of render() times and frames, then drop food with a real click and wait up to
// 15 s for a gulp. Prints a table and saves a screenshot of the largest koi.
//
//   node scripts/measure.mjs [screenshot.png]
//
// Run scripts/build.sh first so web/pkg exists.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TOTALS = [14, 1500, 12750, 100000];
const MODES = [
  { name: 'every frame', query: '' },
  { name: 'koiFps=20', query: '&koiFps=20' },
];
const WARMUP_MS = 2000;
const SAMPLE_MS = 5000;
const GULP_TIMEOUT_MS = 15000;
const SCREENSHOT_PATH =
  process.argv[2] ??
  '/tmp/claude-0/-home-user/8910a47e-ef78-5193-97ca-2821b316df9d/scratchpad/proof.png';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
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

function summarize(values) {
  if (!values.length) return { avg: NaN, p95: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

const server = await serve();
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const results = [];

for (const total of TOTALS) {
  for (const mode of MODES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.goto(`${baseUrl}?total=${total}${mode.query}`);
    await page.waitForFunction(() => window.__koiRecord !== undefined, null, { timeout: 30000 });
    await page.waitForTimeout(WARMUP_MS);
    await page.evaluate(() => window.__koiResetRecord());
    const sampleStart = Date.now();
    await page.waitForTimeout(SAMPLE_MS);
    const sample = await page.evaluate(() => ({
      renderMs: window.__koiRecord.renderMs,
      stepMs: window.__koiRecord.stepMs,
      frames: window.__koiRecord.frames,
      stats: window.__koiStats,
    }));
    const sampleSeconds = (Date.now() - sampleStart) / 1000;
    const render = summarize(sample.renderMs);
    const step = summarize(sample.stepMs);

    // Drop food with a real click a third of the way across the pond, away from the
    // koi's rest point at the center, and wait for the gulp counter to move.
    const gulpsBefore = await page.evaluate(() => window.__koiStats.gulps);
    const box = await page.locator('#pond').boundingBox();
    const food = [160, 90];
    await page.mouse.click(box.x + (food[0] / 640) * box.width, box.y + (food[1] / 360) * box.height);
    const clickedAt = Date.now();
    let gulpSeconds = null;
    try {
      await page.waitForFunction((before) => window.__koiStats.gulps > before, gulpsBefore, {
        timeout: GULP_TIMEOUT_MS,
        polling: 50,
      });
      gulpSeconds = (Date.now() - clickedAt) / 1000;
    } catch {
      gulpSeconds = null;
    }

    if (total === 100000 && mode.query === '') {
      // A second piece of food so the screenshot shows the koi turning toward it.
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.7);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: SCREENSHOT_PATH });
    }

    results.push({
      total,
      mode: mode.name,
      behavior: sample.stats.behavior,
      bodyLength: sample.stats.bodyLength,
      frameSize: `${sample.stats.frameWidth}x${sample.stats.frameHeight}`,
      renders: sample.renderMs.length,
      renderAvg: render.avg,
      renderP95: render.p95,
      stepAvg: step.avg,
      fps: sample.frames / sampleSeconds,
      gulpSeconds,
      errors,
    });
    await page.close();
  }
}

await browser.close();
server.close();

const header = ['total', 'mode', 'behavior', 'length px', 'frame', 'renders', 'render avg ms', 'render p95 ms', 'step avg ms', 'fps', 'gulp'];
const rows = results.map((result) => [
  String(result.total),
  result.mode,
  result.behavior,
  result.bodyLength.toFixed(1),
  result.frameSize,
  String(result.renders),
  result.renderAvg.toFixed(2),
  result.renderP95.toFixed(2),
  result.stepAvg.toFixed(3),
  result.fps.toFixed(1),
  result.gulpSeconds === null ? 'NONE in 15 s' : `${result.gulpSeconds.toFixed(1)} s`,
]);
const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
console.log(line(header));
console.log(`|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`);
rows.forEach((row) => console.log(line(row)));
console.log(`screenshot: ${SCREENSHOT_PATH}`);
const failures = results.filter((result) => result.errors.length || result.gulpSeconds === null);
for (const result of failures) {
  console.log(`total=${result.total} ${result.mode}: ${result.gulpSeconds === null ? 'no gulp; ' : ''}${result.errors.join('; ')}`);
}
process.exitCode = failures.length ? 1 : 0;
