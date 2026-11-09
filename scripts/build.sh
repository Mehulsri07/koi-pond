#!/usr/bin/env bash
# Build the koi for the browser: compile the wrapper to wasm32 and generate the
# JavaScript glue with wasm-bindgen into web/pkg, turn the pixel-art grids into PNGs, and
# assemble the site to deploy into dist/.
#
# wasm-bindgen-cli must be exactly the wasm-bindgen crate version in Cargo.lock:
#   cargo install wasm-bindgen-cli --version "$(scripts/build.sh --wasm-bindgen-version)" --locked
set -euo pipefail
cd "$(dirname "$0")/.."

locked_version=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)
if [[ "${1:-}" == "--wasm-bindgen-version" ]]; then
  echo "$locked_version"
  exit 0
fi
installed_version=$(wasm-bindgen --version | awk '{ print $2 }')
if [[ "$installed_version" != "$locked_version" ]]; then
  echo "wasm-bindgen-cli is $installed_version but Cargo.lock has $locked_version;" >&2
  echo "run: cargo install wasm-bindgen-cli --version $locked_version --locked" >&2
  exit 1
fi

cargo build --release --locked --target wasm32-unknown-unknown -p pond-wasm
rm -rf web/pkg
wasm-bindgen --target web --no-typescript --out-dir web/pkg \
  target/wasm32-unknown-unknown/release/pond_wasm.wasm
ls -l web/pkg

# Check the committed grids and PNGs first, so drift fails CI instead of being papered over.
node scripts/art.mjs --check
node scripts/art.mjs

# dist/ is exactly what GitHub Pages serves. It has no fixtures/: on Pages a missing
# data/snapshot.json must show the data error, never sample data. web/data/snapshot.json is
# written by the nightly collect and is absent in a fresh checkout.
rm -rf dist
mkdir -p dist
cp web/index.html web/style.css dist/
cp -R web/src web/pkg web/art dist/
if [[ -f web/data/snapshot.json ]]; then
  mkdir -p dist/data
  cp web/data/snapshot.json dist/data/snapshot.json
else
  echo "warning: web/data/snapshot.json is missing; dist/ has no data and the page will show its data error" >&2
fi
if [[ -e dist/fixtures ]]; then
  echo "error: dist/ must not contain fixtures/" >&2
  exit 1
fi
echo "dist/:"
ls dist
