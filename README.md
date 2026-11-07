# koi-pond

A proof that the [git-koi](https://github.com/Mehulsri07/git-koi) koi can swim in a browser
through WebAssembly: it follows clicks, gulps food, and renders fast enough. The page is
deliberately plain; visual polish belongs to the site.

- `crates/pond-wasm` — a thin wasm-bindgen wrapper (`PondKoi`) over git-koi, pinned to rev
  `f41b6ca3b7dd8d7948a29e10708c298bda7ff6e0`.
- `web/` — `index.html` + `main.js`: a 640×360 pond, scaled to the window with pixelated
  rendering. Click to drop food.
- `scripts/` — build, bundle, and measure.

## Build

Needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at exactly the
`wasm-bindgen` version in `Cargo.lock`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version "$(scripts/build.sh --wasm-bindgen-version)" --locked
scripts/build.sh            # → web/pkg (pond_wasm.js + pond_wasm_bg.wasm)
```

The release profile uses `opt-level = 3`, `lto = true`, `codegen-units = 1`, and
`panic = "abort"`: fastest code, whole-program inlining across git-koi, and no unwinding
machinery in the `.wasm`.

## Run

Serve `web/` with any static server (modules and `fetch` need http, not `file://`), e.g.
`python3 -m http.server -d web`, and open it. Query parameters:

| parameter | meaning |
| --- | --- |
| `total=<n>` | replace the snapshot's total contributions (growth stage) |
| `body=<name>` | white, black (default), asagi, tea, gold, platinum |
| `koiFps=<n>` | hybrid mode: step every frame, render the koi at most n times a second, re-blit the last bitmap in between |

Or bundle everything into one file that works opened straight from disk:

```sh
node scripts/bundle.mjs     # → dist/proof.html (wasm as base64, snapshot inline, no requests)
```

## Measure

```sh
node scripts/measure.mjs [screenshot.png]
```

Serves `web/`, opens headless Chromium at 1280×720 for totals 14, 1500, 12750, and 100000
in both modes, warms up 2 s, samples 5 s of `render()` times and frames, then clicks to
drop food and waits up to 15 s for a gulp. Prints a table and screenshots the largest koi.
The page publishes `window.__koiStats` (`renderMsAvg`, `renderMsP95`, `frames` — frames in
the last second — plus `gulps`, `stepMsAvg`, `renders`, `behavior`, …) once a second, and
`window.__koiRecord` (every render time since `window.__koiResetRecord()`) for exact
sampling windows. Browser timers are coarsened to 0.1 ms, so p95 values are quantized.

The snapshot in `web/fixtures/snapshot.json` is git-koi's
`tests/fixtures/account-with-history.json`.
