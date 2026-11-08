# Koi Pond Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the koi-pond proof into the full-screen pixel-art pond website
the spec describes, deployed nightly to GitHub Pages.

**Architecture:** git-koi (Rust, fork `Mehulsri07/git-koi`, branch
`claude/focused-brahmagupta-8e2i9o`) gains repo names, a sized pond layout and
an explained behavior. `crates/pond-wasm` exposes the koi, pads and legend data
to the browser. `web/` is plain ES modules with no bundler: a scene drawn in
layers on one canvas, plus HTML for the header, pad card and legend. One
workflow collects data nightly, builds and deploys.

**Tech Stack:** Rust (git-koi pinned by rev), wasm-bindgen 0.2.130, plain
JavaScript ES modules, Canvas 2D, Node 22 scripts with no npm dependencies
except Playwright (pre-installed), GitHub Actions, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-11-08-pond-website-design.md`

## Global Constraints

- **Scale:** `scale = 2` when the viewport is at least 1600 wide and 900 tall,
  else 1. `pond = floor(viewport / scale)`. The resize rebuild is debounced
  300 ms.
- **Pad diameters:** 16, 24, 32, 40, 48 native px. Cap 12. Sizes by commits:
  ≤10, 11–20, 21–40, 41–80, 81+. Flowers by language rank: pink, white,
  purple, then bud. All of this is unchanged git-koi behavior.
- **Lighting phases, by local hour:**
  - dawn 05–07, day 07–17, dusk 17–19, night 19–05
  - 20-minute blends
  - 10 fireflies at night
- **Caustics:** a 64×64 tile, 16 frames, played at 8 fps.
- **Adaptive koi drawing:** if the average render over the first 2 s exceeds
  12 ms, draw the koi 20 times a second.
- **Pond colors:** only the reference palette for pads and flowers.
  - pad base `#3a5f4b #5a8a4a #6f9a45 #a8c24a`
  - pad shade `#24483c #3f6a46 #56853f`
  - pad highlight `#f2c94c #f5d565 #f8e7a0`
  - pink `#e86f9a #f08fb0 #f7b8cc #fbeee0`
  - white `#a993c6 #c4b2d9 #e3d9ec #fbeee0`
  - purple `#7a4fa3 #a275c9 #c9a8e3 #f1e6f2`
  - pollen `#f0a032 #f5b93c #f8de6a`
  - water `#6fb3b8 #a8e3e6`
  - Hard edges only.
- **Rendering:** pixel art stays crisp. Use `image-rendering: pixelated`,
  integer `drawImage` positions, `imageSmoothingEnabled = false`, and a backing
  store sized `cssSize * devicePixelRatio`.
- **No secrets in the browser:** the page reads only `data/snapshot.json`.
- **Exactness:** git-koi's existing outputs stay byte-identical, with
  `tests/render_pinning.rs` untouched and passing.
- **git-koi gates:**
  - `cargo fmt --all --check`
  - `cargo clippy --locked --all-targets -- -D warnings`
  - `RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps`
  - `cargo test --locked`
- **koi-pond gates:**
  - `cargo fmt --check`
  - `cargo clippy --target wasm32-unknown-unknown -- -D warnings`
  - `cargo test -p pond-wasm` (native)
  - `node scripts/e2e.mjs`
- **Commits:** subjects `area: lowercase imperative`. Every commit message ends
  with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HCqEfzjfLorZKnPqVURFkf
  ```

- **Branches and pushing:** both repos work on
  `claude/focused-brahmagupta-8e2i9o`. Implementers don't push; the controller
  pushes after review.

## Review Focus

1. A snapshot whose owned repos all lack a language gives plain pads with no
   flowers, and the legend's flower line says none bloom. Test in Task 3.
2. Resizing mid-chase rebuilds without leaking WebAssembly memory: the old
   `PondKoi` is freed, and the heap does not grow over 20 resizes. Test in
   Task 4.
3. A tap that lands on a pad's transparent notch counts as water: hit-testing
   uses the sprite's opaque pixels, not its circle. Test in Task 7.
4. A visitor whose clock sits exactly on a phase boundary (17:00) gets a
   blended grade, with no flash between frames. Test in Task 9.
5. On the first deploy, before Pages is enabled, the deploy step fails with a
   message naming the manual setting. The collect step's commit still lands.
   Covered by the dry run in Task 11.

---

### Task 1: Repo names in the snapshot (git-koi)

**Files:** `src/history.rs` (`OwnedRepository`), `src/collect.rs` (owned
fields), `tests/history.rs`, `tests/collect.rs`, `tests/pond.rs` fixtures,
`tests/fixtures/*.json` only if one carries v4.

**Interfaces:**

- **Produces:** `OwnedRepository { repository_id: u64, owner_commit_count: u64, name_with_owner: String }`.
  The field is required in v4 (unreleased, so it changes in place).
  `nameWithOwner` is added to `OWNED_REPOSITORY_FIELDS`.

- [ ] **Step 1: Write the failing tests:**
  - `version_4_round_trips_owned_repositories`, extended with
    `name_with_owner: "Mehulsri07/StrataField"`.
  - `version_4_needs_names_for_owned_repositories`: an entry without the field
    is rejected.
  - In `tests/collect.rs`: the owned fake returns
    `nameWithOwner`, and `owned_repositories` carries it.
- [ ] **Step 2: Run** `cargo test --locked --test history --test collect`.
      Expected: FAIL (compile).
- [ ] **Step 3: Implement.** Update every `OwnedRepository` literal in the
      tests.
- [ ] **Step 4: Run the git-koi gates.** Expected: all pass, pinning untouched.
- [ ] **Step 5: Commit** `history: name each owned repository`.

### Task 2: Pond size and explained behavior (git-koi)

**Files:** `src/pond.rs`, `src/behavior.rs`, `tests/pond.rs`,
`tests/behavior.rs`.

**Interfaces:**

- **Produces:**
  - `pub fn layout_pond(account_snapshot: &AccountSnapshot, pond_width_pixels: u32, pond_height_pixels: u32) -> Result<PondLayout, PondError>`.
    `POND_WIDTH_PIXELS` and `POND_HEIGHT_PIXELS` are removed.
  - `pub enum BehaviorReason { DeepRest { quiet_days: u32 }, Rest { quiet_days: u32 }, FirstContributionOfWeek, CrossedMilestone { milestone: u64 }, BusyWeek { week_contributions: u64 }, Steady }`.
  - `pub fn explain_behavior(koi_development: &KoiDevelopment) -> (Behavior, BehaviorReason)`.
    `select_behavior` returns `explain_behavior(..).0`, so there is one rule
    path.

- [ ] **Step 1: Write the failing tests:**
  - `pads_fit_ponds_of_any_size`: for 416×192, 400×800, 960×540 and 1280×720,
    with 12 size-5 repos over 20 seeds, no overlap (gap ≥ 2) and every pad
    inside the given pond.
  - The existing pond tests, updated to pass 416×192. Their layouts must stay
    identical at that size; assert one exact center from the current code as
    a regression pin.
  - `each_rule_explains_itself`: one fixture per rule in the behavior table
    gives the matching reason and value. Steady gives `Steady`.
- [ ] **Step 2: Run** `cargo test --locked --test pond --test behavior`.
      Expected: FAIL.
- [ ] **Step 3: Implement.** Placement replaces the constants with the
      parameters. `notch_radians` and the seeds are unchanged.
- [ ] **Step 4: Run the git-koi gates.** Expected: pass, pinning untouched.
- [ ] **Step 5: Commit** `pond: lay out pads in a pond of any size`, then
      `behavior: explain why the koi moves as it does`.

### Task 3: Pads and legend for the browser (pond-wasm)

**Files:** `Cargo.toml` (re-pin git-koi to Task 2's head rev),
`crates/pond-wasm/src/lib.rs`, `crates/pond-wasm/src/legend.rs` (new),
`crates/pond-wasm/src/pads.rs` (new), `web/fixtures/snapshot.json` (a v4
fixture with names: build it from git-koi's fixture with 6 owned repos of
mixed languages and commit counts, named like Mehul's real repos).

**Interfaces:**

- **Consumes:** Tasks 1–2.
- **Produces (wasm-bindgen):**
  - `PondKoi::new(snapshot_json: &str, body: &str, pond_width: u32, pond_height: u32, seed: u64) -> Result<PondKoi, JsError>`.
    The rest point is the biggest pad's center plus `(0, +0.6 × its diameter)`,
    clamped into the pond; the pond center when there are no pads.
  - `PondKoi::set_growth_override(&mut self, total: f64)`, documented as for
    testing.
  - `pads_json(&self) -> String`: a JSON array of
    `{repo, url, language, languageColor, commits, size, diameter, bloom, x, y, notch}`.
    `bloom` is one of `"pink" | "white" | "purple" | "bud" | null`.
    `languageColor` is `"#rrggbb"` or null.
  - `legend_json(&self) -> String`:
    `{observedOn, totalContributions, growthStage, behavior, reason: {rule, value}, languages: [{name, color, share}], padCount, renderMode}`.
    - `growthStage` is `"hatchling"` <500, `"young"` <1500, `"juvenile"`
      <12750, `"adult"` <100000, else `"fully grown"`.
    - `rule` is the snake_case `BehaviorReason` variant.
  - All earlier methods are unchanged.
- Pure functions `pads_from(snapshot, layout) -> Vec<PadView>` and
  `legend_from(..) -> Legend` are serde-serializable and unit-tested natively.

- [ ] **Step 1: Write the failing native tests** (`cargo test -p pond-wasm`):
  - `pads_carry_repo_names_and_urls`
  - `pads_without_languages_have_no_flowers` (Review Focus 1)
  - `legend_reports_the_fixtures_numbers`
  - `growth_stages_step_at_the_thresholds`
  - `rest_point_sits_beside_the_biggest_pad`
  - `no_pads_rest_at_the_center`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild `web/pkg` with `scripts/build.sh`.
- [ ] **Step 4: Run the koi-pond gates,** without e2e yet. Expected: pass.
- [ ] **Step 5: Commit** `wasm: expose pads and the legend`.

### Task 4: Site shell (web)

**Files:**

- `web/index.html`: the full-screen canvas, header, legend `<aside>`, pad card
  `<div role="tooltip">`, and an error message element.
- `web/style.css`.
- `web/src/main.js`: boot, the resize debounce, the frame loop, error display.
- `web/src/view.js`: `computeView(innerWidth, innerHeight, devicePixelRatio) -> {scale, pondWidth, pondHeight, cssWidth, cssHeight, backingWidth, backingHeight}`
  as a pure function.
- `web/src/koi.js`: wraps `PondKoi`. `create(view)`, `rebuild(view)` frees the
  old instance, `step(dt)`, `drawInto(ctx)`.
- The proof's `web/main.js` is removed. The proof stays in git history and the
  published artifact.

**Interfaces:** `main.js` owns `requestAnimationFrame`. Each layer module
exports `draw(ctx, state, now)`; modules arrive in later tasks.

- [ ] **Step 1: Write the failing e2e checks** in a new `scripts/e2e.mjs`.
      Reuse `measure.mjs`'s static server; Playwright; viewports 1280×800 and
      400×800.
  - `the koi swims`: no console errors, and opaque koi pixels change position
    over 1 s.
  - `the view scales`: on 1920×1080 the canvas CSS size is 2× the pond size; on
    1280×800 it is 1×.
  - `resizing rebuilds without leaking` (Review Focus 2): after 20 resizes,
    `performance.memory` or the wasm `memory.buffer.byteLength` grows by under
    1 MB.
  - `bad data shows a message`: serve broken JSON, and a visible error text is
    present.
- [ ] **Step 2: Run** `node scripts/e2e.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Header text: "Mehul Srivastava · koi pond", a
      link to `https://github.com/Mehulsri07`, and a "What am I looking at?"
      button. The legend opens and closes; content comes in Task 10.
- [ ] **Step 4: Run** e2e. Expected: pass.
- [ ] **Step 5: Commit** `web: frame the pond to fill the screen`.

### Task 5: Floor and caustics

**Files:** `web/src/floor.js`, `web/src/caustics.js`, `web/src/rand.js`
(SplitMix-style seeded PRNG).

**Interfaces:**

- `buildFloor(pondWidth, pondHeight, seed) -> HTMLCanvasElement`: sand base
  with 2–3 tones, scattered 1–3 px pebbles, 3–6 rocks, water plants at the
  edges, and a darker 24 px vignette band. Deterministic per inputs.
- `buildCaustics(seed) -> HTMLCanvasElement[16]`: 64×64 tiles, tileable at
  their edges, each a light network with alpha ≤ 0.18.
- Both have a `draw(ctx, state, now)`. Caustics advance at 8 fps and hold
  frame 0 under `prefers-reduced-motion`.

- [ ] **Step 1: Write the failing e2e checks:**
  - `the floor is the same every load`: two loads at the same size give an
    identical floor-layer hash (exposed as `window.__pond.floorHash`).
  - `caustics tile seamlessly`: each frame's row 0 equals its row 63
    continuation within ±1 per channel, checked in page.
  - `reduced motion holds the caustics`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: pass. Save screenshots
      `scratchpad/site-floor-{desktop,phone}.png`.
- [ ] **Step 5: Commit** `web: lay the pond floor and its moving light`.

### Task 6: Pixel art pipeline and sprites

**Files:**

- `art/*.txt`: sprite grids. One character per pixel, `.` for transparent,
  each character mapped to a palette color in an `art/palette.json` legend.
- `scripts/art.mjs`: converts the grids to PNG with a minimal PNG encoder
  written against Node's `zlib`; writes `web/art/*.png` and
  `web/art/sprites.json` (name → width, height, anchor).
- `art/sheet.html`: every sprite at 4× on day and night water, beside the
  palette.

**Sprites:**

| Sprite                                                  | Count |
| ------------------------------------------------------- | ----- |
| `pad-16`, `pad-24`, `pad-32`, `pad-40`, `pad-48`        | 5     |
| `lotus-pink-s/l`, `lotus-white-s/l`, `lotus-purple-s/l` | 6     |
| `bud`                                                   | 1     |
| `droplet`                                               | 1     |
| `moon-reflection`                                       | 1     |
| `firefly-0/1` (blink)                                   | 2     |
| `food`                                                  | 1     |

Each pad has a notch, shade bands lit from the top left, veins, and a
highlight rim. Lotus `s` is used on pads up to 32 px and `l` on 40–48.

- [ ] **Step 1: Write the failing test** `node scripts/art.mjs --check`. It
      fails if any grid uses a character missing from the palette, if rows
      differ in width, if any sprite name above is missing, or if any PNG pixel
      is outside the palette or has alpha other than 0 or 255.
- [ ] **Step 2: Run it.** Expected: FAIL (no art).
- [ ] **Step 3: Draw the sprites.** Follow the reference sheet's shapes:
      layered petals with a pollen center, and buds as a closed pink teardrop
      on a short stem.
- [ ] **Step 4: Run the check.** Expected: pass. Screenshot `art/sheet.html` to
      `scratchpad/art-sheet.png`.
- [ ] **Step 5: Commit** `art: draw the lilypads, lotuses and night sprites`.
- **STOP after this task.** The controller shows the sheet to Mehul and applies
  his feedback before Task 7. This is a planned human gate.

### Task 7: Lilypads in the pond

**Files:** `web/src/pads.js`, `web/src/card.js`.

**Interfaces:**

- **Consumes:** `pads_json` (Task 3) and the sprites (Task 6).
- `buildPadLayer(pads, sprites, pondWidth, pondHeight) -> {canvas, hitMask}`:
  - Each pad sprite is chosen by diameter and rotated in quarter turns plus a
    mirror, picked from `notch`.
  - A flower is placed at the pad's center offset toward its widest side.
  - Droplets on sizes 4–5; a still ripple ring under each pad.
  - `hitMask` is a `Uint16Array` of the pad index + 1 per pond pixel, from
    opaque pad pixels only.
- `card.js`:
  - `show(pad, clientX, clientY)`: repo name, language dot, "N commits by
    Mehul", and an "Open repo" `<a target="_blank" rel="noopener">`. The card
    stays inside the viewport.
  - `hide()`.
- Input rules:
  - Pointer move with a mouse: hover shows the card.
  - Mouse click on a pad opens the URL.
  - Touch: the first tap on a pad shows the card; a tap elsewhere hides it.
  - A tap on water with no pad under it drops food; a tap on a pad never does.

- [ ] **Step 1: Write the failing e2e checks:**
  - `pads match the data`: the opaque pad-layer component count equals
    `padCount`.
  - `hovering a pad names its repo`.
  - `clicking a pad opens the repo`: popup URL equals the pad's `url`.
  - `tapping a pad drops no food` (phone viewport).
  - `the notch is water` (Review Focus 3): a tap at a notch pixel drops food.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: pass. Save screenshots
      `scratchpad/site-pads-{desktop,phone}.png`.
- [ ] **Step 5: Commit** `web: float a lilypad for each repo`.

### Task 8: Feeding, ripples, adaptive drawing

**Files:** `web/src/food.js`, `web/src/ripples.js`, `web/src/koi.js` (adaptive
mode).

**Interfaces:**

- Ripples: `ripples.add(x, y, kind)` with `kind` one of `"drop" | "gulp" | "pad"`.
  - A ring expands at 24 px/s for 1 s, with 1 px stroke in `#a8e3e6` fading to 0.
  - Reduced motion draws one static ring for 0.4 s.
- Adaptive drawing: the koi module measures render time for 2 s after create or
  rebuild. Above 12 ms it switches to drawing 20 times a second. The mode is
  exposed as `window.__pond.renderMode` (`"every-frame"` or `"20-per-second"`)
  and passed to the legend.

- [ ] **Step 1: Write the failing e2e checks:**
  - `the koi eats what you drop`: a gulp within 30 s, and a ring appears at the
    drop point.
  - `slow devices draw the koi less often`: the page has a test hook
    `?slowKoi=15` (dev only, ignored on Pages builds) that adds 15 ms of busy
    work per render; the mode becomes `"20-per-second"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: pass.
- [ ] **Step 5: Commit** `web: feed the koi and ripple the water`.

### Task 9: Day and night

**Files:** `web/src/lighting.js`.

**Interfaces:**

- `phaseAt(date) -> {grade: {r, g, b, a, mode}, night: number}`: a pure
  function. It blends linearly across the 20 minutes centered on each boundary
  (05, 07, 17, 19). `night` runs from 0 to 1.
- The grade is drawn as one full-pond fill per frame with a `multiply`
  composite plus a soft `screen` lift at dawn and dusk.
  - Day is near-identity.
  - Night is deep blue, `rgba(30,45,90,0.55)` multiply.
- When `night > 0`: the moon reflection near the top right gently wobbles 1 px,
  and 10 fireflies drift on smooth seeded paths and blink with the `firefly-0/1`
  sprites at 0.5–1.5 s random periods.
- Under `prefers-reduced-motion`, fireflies hold still and blink only, and the
  moon does not wobble.

- [ ] **Step 1: Write the failing checks:**
  - In page, a unit check of `phaseAt`: values at 12:00 and 02:00; continuity
    at 16:59:59, 17:00:00 and 17:00:01 with no channel jump over 0.02 (Review
    Focus 4).
  - e2e with Playwright `page.clock` set to 02:00: fireflies present
    (`window.__pond.fireflies === 10`) and the mean pond brightness below the
    12:00 mean by at least 25%.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: pass. Save screenshots
      `scratchpad/site-night-{desktop,phone}.png`.
- [ ] **Step 5: Commit** `web: light the pond by the visitor's clock`.

### Task 10: Legend

**Files:** `web/src/legend.js`, `web/index.html` (legend markup), `web/style.css`.

**Interfaces:** `renderLegend(legend, pads, phase, renderMode)` fills the
`<aside>`.

**Copy** (from the spec; plain sentences, real numbers):

- Size: "12,431 contributions through Nov 7, 2026 · a juvenile koi"
- Colors: languages with color dots and shares.
- Mood:
  - "Resting: 16 quiet days"
  - "Darting: crossed 1,000 contributions this week"
  - "Darting: busiest week in a year"
  - "Feeding at the surface: first contribution this week"
  - "Cruising"
  - "Deep rest: 60+ quiet days"
- Lilypads: "8 lilypads, one per public repo. Bigger pads have more commits
  (≤10, 11–20, 21–40, 41–80, 81+). Rust blooms pink, TypeScript white, Go
  purple; other languages bud." With no flowers: "No repos have a language
  yet, so nothing blooms."
- Light: "Night · 02:14 your time"
- Drawing: "Koi drawn every frame" or "Koi drawn 20 times a second on this
  device"
- Freshness: "Data from Nov 7, 2026, refreshed nightly."

**Behavior:**

- Opens from the header button and closes with Escape or the close button.
- Focus moves into the panel and returns to the button.
- `aria-modal="false"`, `role="dialog"` with a label.

- [ ] **Step 1: Write the failing e2e checks:**
  - `the legend tells the truth`: its text contains the fixture's total, stage,
    reason phrase and pad count.
  - `the legend works from the keyboard`: Tab to the button, Enter opens,
    Escape closes, and focus returns.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: pass.
- [ ] **Step 5: Commit** `web: explain the pond in a legend`.

### Task 11: Nightly data and deploy

**Files:** `.github/workflows/pond.yml`, `scripts/build.sh` (adds
`node scripts/art.mjs` and assembles `dist/`), `README.md`.

**Workflow:**

- **Triggers:** `schedule: "20 0 * * *"`, `workflow_dispatch`, and `push` to the
  default branch.
- **Permissions:** `contents: write`, `pages: write`, `id-token: write`.
- **Concurrency:** group `pond`.
- **Job `collect`** (if the event is `schedule` or `workflow_dispatch`):
  - `actions/checkout`, then `dtolnay/rust-toolchain@stable`.
  - `cargo install --git https://github.com/Mehulsri07/git-koi --rev <REV> --locked git-koi`.
    REV is the same rev as `Cargo.toml`; read it with a grep rather than
    duplicating it.
  - `git-koi collect Mehulsri07 --output web/data/snapshot.json` with
    `GH_TOKEN: ${{ github.token }}`.
  - Commit only if changed, as `github-actions[bot]`, then push.
- **Job `build`** (needs collect when it ran; `if: always() && needs.collect.result != 'failure'`):
  - Checkout at the latest default-branch head.
  - Rust plus wasm32, then `cargo install wasm-bindgen-cli --version <lockfile version> --locked`,
    with a cache step for `~/.cargo`.
  - `scripts/build.sh`, then `actions/upload-pages-artifact` with `dist/`.
- **Job `deploy`:** environment `github-pages`, `actions/deploy-pages`.
- Production does not use `web/fixtures/`: the page reads `data/snapshot.json`,
  which falls back to the fixture only when the URL carries `?fixture`.
- **README:** what the site is, the link, the one manual step (Settings → Pages
  → Source: GitHub Actions), and how to run locally and run e2e.

- [ ] **Step 1: Check the YAML** with `npx -y @action-validator/cli@0.6.0 .github/workflows/pond.yml`
      (or a Python `yaml.safe_load` plus a structure check if that package is
      unavailable).
- [ ] **Step 2: Dry-run the collect step locally** with the fixture standing in
      for the network (`git-koi collect` needs gh auth, which is unavailable
      here; state that this step is unverified until the first real run).
      Run `scripts/build.sh` and confirm `dist/` has `index.html`, `src/`,
      `pkg/`, `art/` and `data/snapshot.json`.
- [ ] **Step 3: Run the full e2e against `dist/`.** Expected: pass.
- [ ] **Step 4: Commit** `ci: collect nightly and deploy the pond to pages`.
- **STOP:** pushing this branch runs the workflow on GitHub. The controller
  asks Mehul to enable Pages and to confirm the default branch before
  triggering the first run.

### Task 12: Profile link (Mehulsri07/Mehulsri07)

- [ ] **Step 1:** Once the site is live and Mehul approves, replace the
      README's koi `<p align="center"><img src="koi/koi.gif" …></p>` with a
      centered link to the Pages URL. Remove `.github/workflows/koi.yml` and
      `koi/` so nothing nightly keeps committing GIFs. Branch, open a PR.
- [ ] **Step 2:** Merge only on Mehul's explicit approval.
