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
- `scripts/` — `build.sh` (wasm, art PNGs, and the `dist/` site), `art.mjs` and `e2e.mjs`
  (end-to-end checks).
- `.github/workflows/pond.yml` — the nightly collect, build and deploy.

## Build

Needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at exactly the
`wasm-bindgen` version in `Cargo.lock`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version "$(scripts/build.sh --wasm-bindgen-version)" --locked
scripts/build.sh            # → web/pkg, web/art PNGs, and dist/ (the site as deployed)
```

`dist/` holds `index.html`, `style.css`, `src/`, `pkg/`, `art/` and, when it exists,
`data/snapshot.json`. It never contains `fixtures/`: on Pages a missing
`data/snapshot.json` must show the data error, not sample data. `build.sh` fails if
`dist/fixtures` exists, and `node scripts/e2e.mjs --root dist` checks it.

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
rebuilt at the new size and the koi starts again. The canvas's backing store is its CSS size
× `devicePixelRatio`: pond pixels are exact squares at a whole-number ratio, and sharp but
one device pixel uneven at a fractional one.

## Test

```sh
cargo fmt --check
cargo clippy --target wasm32-unknown-unknown -- -D warnings
cargo test -p pond-wasm
scripts/build.sh
node scripts/e2e.mjs [--only <name>] [--screenshots <dir>]
node scripts/e2e.mjs --root dist     # the same checks against the built dist/
```

While `web/data/snapshot.json` exists locally, the web/ run's missing-data check fails; remove
it (it is only written by the nightly collect) or use `--root dist`, where the harness
supplies `/fixtures/` itself.

`e2e.mjs` serves `web/` on a free port and runs each check in headless Chromium (Playwright)
at 1280×800 and at 400×800 as a phone, then saves desktop and phone screenshots to
`--screenshots <dir>`, `$E2E_SCREENSHOTS`, or `<os tmpdir>/koi-pond-e2e`. It stops at once
if `web/pkg` is missing (run `scripts/build.sh`). The page's
test hooks are on `window.__pond`; `web/src/main.js` lists them.

## Deploy

The site is [mehulsri07.github.io/koi-pond](https://mehulsri07.github.io/koi-pond/).
`.github/workflows/pond.yml` runs at 00:20 UTC daily, on manual dispatch, and on every push
to the default branch:

1. **collect** (schedule and dispatch only; `contents: read`, no push credentials, because it
   compiles third-party code) resolves the default branch through the API (a schedule event
   carries none), installs git-koi at the rev pinned in `crates/pond-wasm/Cargo.toml` (read
   from that file, not repeated), runs `git-koi collect Mehulsri07`, and uploads the snapshot
   as an artifact. A manual run started from a non-default branch fails early.
2. **commit** (`contents: write`; `scripts/commit-snapshot.sh`) commits the snapshot as
   `github-actions[bot]` only if it changed, rebasing and retrying once if the branch moved,
   and outputs the exact commit the branch ends on.
3. **build** checks out that exact commit (or the pushed commit on a push run, where collect
   and commit are skipped), runs `scripts/build.sh`, and uploads `dist/`.
4. **deploy** publishes it with `actions/deploy-pages`, in concurrency group `pond` (never
   cancelling a deploy in flight).

A failed collect fails the run (GitHub emails the owner) and nothing deploys, so the
previous snapshot stays live. A push runs build and deploy only.

**One manual step:** Settings → Pages → Source: GitHub Actions. Until then deploy fails (the
job logs say so).

Actions are pinned to full SHAs at their current major versions; GitHub's Node 20
deprecation annotations on them are expected for now.

The workflow never names the default branch: the push trigger runs on every branch and the
jobs proceed only for the repository's default branch (`github.event.repository.default_branch`),
so renaming it later (for example to `main`) needs no workflow change.
