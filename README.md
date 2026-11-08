# koi-pond

A full-screen pixel-art koi pond that is a live portrait of
[Mehulsri07](https://github.com/Mehulsri07)'s GitHub account. The koi is
[git-koi](https://github.com/Mehulsri07/git-koi)'s own renderer running in the browser through
WebAssembly. Design: `docs/superpowers/specs/2026-11-08-pond-website-design.md`.

- `crates/pond-wasm` — a thin wasm-bindgen wrapper (`PondKoi`) over git-koi: the koi, its
  pads and its legend.
- `web/` — the site: `index.html`, `style.css`, and plain ES modules in `web/src/` (no
  bundler). `main.js` boots, sizes the pond to the window and runs the frame loop over
  layer modules; `view.js` computes the pond size; `koi.js` wraps `PondKoi`.
- `scripts/` — `build.sh` (wasm) and `e2e.mjs` (end-to-end checks).

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
`python3 -m http.server -d web`, and open it.

The page reads `web/data/snapshot.json`, which the nightly collect writes. It reads
`web/fixtures/snapshot.json` (git-koi's `tests/fixtures/account-with-history.json`) instead
when the URL has `?fixture`, or when `data/snapshot.json` is missing (404), as in a fresh
checkout. A snapshot that exists but cannot be read shows "The pond's data could not be
read" with the reason.

The pond's native size comes from the window: scale 2 on windows at least 1600×900 CSS px,
else 1, and `pond = floor(window / scale)`. After a resize settles (300 ms) the pond is
rebuilt at the new size and the koi starts again.

## Test

```sh
cargo fmt --check
cargo clippy --target wasm32-unknown-unknown -- -D warnings
cargo test -p pond-wasm
scripts/build.sh
node scripts/e2e.mjs [--only <name>]
```

`e2e.mjs` serves `web/` on a free port and runs each check in headless Chromium (Playwright)
at 1280×800 and at 400×800 as a phone, then saves desktop and phone screenshots. The page's
test hooks are on `window.__pond`; `web/src/main.js` lists them.
