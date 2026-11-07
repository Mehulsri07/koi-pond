// Bundle the proof page into ONE self-contained file, dist/proof.html: the wasm-bindgen
// glue and main.js become a single inline module, the .wasm is inlined as base64 and
// instantiated from bytes, and the snapshot JSON is inlined. The page makes no requests.
//
//   node scripts/bundle.mjs      (after scripts/build.sh)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

const html = await read('web/index.html');
const mainJs = await read('web/main.js');
const glueJs = await read('web/pkg/pond_wasm.js');
const wasmBase64 = (await readFile(resolve(root, 'web/pkg/pond_wasm_bg.wasm'))).toString('base64');
const snapshotJson = JSON.stringify(JSON.parse(await read('web/fixtures/snapshot.json')));

function replaceExactlyOnce(text, search, replacement, what) {
  const count = text.split(search).length - 1;
  if (count !== 1) throw new Error(`expected exactly one ${what}, found ${count}`);
  return text.replace(search, () => replacement);
}

// The glue runs in its own function scope (its top-level names, such as `wasm`, would
// clash with main.js) and hands back the names main.js imports.
let glue = replaceExactlyOnce(glueJs, 'export class PondKoi', 'class PondKoi', 'PondKoi export');
glue = replaceExactlyOnce(
  glue,
  'export { initSync, __wbg_init as default };',
  'return { init: __wbg_init, PondKoi };',
  'glue export list',
);
if (/^\s*(export|import)\b/m.test(glue)) throw new Error('unexpected import/export left in the glue');
glue = `const { init, PondKoi } = (() => {\n${glue}\n})();`;

const main = replaceExactlyOnce(
  mainJs,
  "import init, { PondKoi } from './pkg/pond_wasm.js';",
  '',
  'glue import in main.js',
);

// Inline text must not close its <script> early.
const scriptSafe = (text) => text.replace(/<\/script/gi, '<\\/script');

const inlineScript = `<script>
globalThis.__KOI_INLINE = {
  wasmBytes: Uint8Array.from(atob(${JSON.stringify(wasmBase64)}), (c) => c.charCodeAt(0)),
  snapshotJson: ${JSON.stringify(snapshotJson)},
};
</script>
<script type="module">
// ---- wasm-bindgen glue (web/pkg/pond_wasm.js) ----
${scriptSafe(glue)}
// ---- web/main.js ----
${scriptSafe(main)}
</script>`;

const bundled = replaceExactlyOnce(
  html,
  '<script type="module" src="main.js"></script>',
  inlineScript,
  'main.js script tag',
);

await mkdir(resolve(root, 'dist'), { recursive: true });
const outPath = resolve(root, 'dist/proof.html');
await writeFile(outPath, bundled);
console.log(`${outPath}: ${Buffer.byteLength(bundled)} bytes`);
