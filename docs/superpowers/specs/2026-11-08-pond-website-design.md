# Koi Pond website

Status: design approved in conversation, awaiting spec review.

## Goal

A full-screen, pixel-art pond on GitHub Pages that is a live portrait of
Mehulsri07's GitHub account. It replaces the koi GIF on the profile README,
which will link to the site instead.

- **The koi** is git-koi's own Rust renderer, running in the browser as
  WebAssembly. Its size comes from total contributions, its colors from
  languages, and its mood from yesterday's activity.
- **Visitors can** feed the koi and explore the lilypads. Each pad is one of
  Mehul's public repositories, sized by Mehul's commits, and opens that
  repository.

Success means:

- **It runs:** the site loads from Pages with no console errors. The koi swims
  at 60 fps on a mid-range laptop. On a slower device it degrades to drawing
  the koi 20 times a second rather than stuttering.
- **The pads are real:** every pad matches a real repository, and its hover
  card shows the right name, language and commit count.
- **The data stays fresh:** it refreshes nightly with no manual step after
  setup.
- **The art passes:** Mehul approves the art against his reference sheet: five
  pad sizes, pink, white and purple lotuses, buds, droplets and ripples.

## Decisions already made

| Topic        | Decision                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Purpose      | Live portrait of the account; pads double as a portfolio entry point                                            |
| Style        | Detailed pixel art                                                                                              |
| Koi          | git-koi renderer via WebAssembly (`crates/pond-wasm`), pinned to a git-koi fork commit                          |
| Data         | Nightly GitHub Action runs `git-koi collect`; the page reads a committed snapshot. No token in the browser      |
| Interactions | Pads link to repos (hover/long-press card, click opens); feed the koi; legend panel; day/night by visitor clock |
| Pads         | Hand-drawn pixel sprites from the reference sheet, laid out by git-koi's `pond` rules                           |
| Hosting      | GitHub Pages from `Mehulsri07/koi-pond`, deployed by GitHub Actions                                             |
| Profile      | Final step replaces the README koi with a link, merged only on Mehul's approval                                 |

## Page

- The pond canvas fills the viewport.
- **Header:** a slim strip over the top with "Mehul Srivastava · koi pond", a
  link to github.com/Mehulsri07, and a "What am I looking at?" button that
  opens the legend.
- **Legend:** an HTML panel with a light, partly see-through background that
  slides over the pond, closes with Escape or a close button, and is keyboard
  accessible.
- **No other content.** The page does not follow the visitor's light/dark
  theme. It is one pond world whose lighting follows the clock, and every color
  is explicit.

## Pond size

- The pond's native size comes from the viewport.
  - `scale = 2` when the viewport is at least 1600 CSS px wide and at least
    900 tall, else `1`.
  - `pond = floor(viewport / scale)`.
  - Drawn with `image-rendering: pixelated` at `devicePixelRatio`-correct
    backing size, so pixels stay square.
- After a resize settles (300 ms debounce), the pond is rebuilt at the new
  size. The koi restarts at the pond center; this is accepted.
- **Known cost:** in a phone held upright (about 400×800 native) the largest koi
  has about 2.4 body lengths of width and spends more time gliding along
  walls. git-koi's swim tests already cover a pond that cramped.

## Layers, drawn in this order every frame

1. **Floor:** sand, pebbles, a few rocks and water plants, generated once per
   pond size from a seed based on the account ID and cached as one bitmap.
   It is darker toward the edges, for depth.
2. **Caustics:** a tileable 64×64 light pattern, with 16 frames precomputed at
   load, played at 8 fps and blended lightly over the floor.
3. **Food:** a 2×2 pellet with a 1 px shadow.
4. **Koi:** the frame from WebAssembly, drawn at its `top_left`.
5. **Pads and flowers:** one pre-rendered bitmap, redrawn only when the layout
   changes. Pads sit above the koi.
6. **Ripples:**
   - Expanding 1 px rings, gone after about 1 s.
   - One where food lands, one where the koi gulps, and one when a visitor taps
     a pad.
7. **Lighting:**
   - A full-pond color grade by phase: dawn 05–07, day 07–17, dusk 17–19,
     night 19–05 (visitor's local time). Each change blends over 20 minutes.
   - At night only: a moon reflection sprite near the top right, and 10
     fireflies drifting on smooth random paths and blinking.

`prefers-reduced-motion`:

- Caustics stay on one frame.
- Fireflies don't move.
- Ripples are shown as a single ring.
- The koi still swims, because the koi is the content.

## Lilypads

- **Layout:** git-koi's `pond::layout_pond` decides which repos get pads and
  where.
  - It takes the pond size as a parameter (git-koi change below), so pads fill
    the current pond.
  - The size steps from commits, the 12-pad cap, flowers by language rank, and
    seeded placement are all unchanged.
  - Diameters stay 16/24/32/40/48 native px. On a 2× pond they show at twice
    that.
- **Art:**
  - Hand-authored pixel sprites, kept as text grids under `art/`. A script
    converts them to PNGs in `web/art/`, so the diffs stay reviewable.
  - One sprite per pad size, plus mirrored and quarter-turned variants chosen by
    `notch_radians`.
  - Lotus pink, white and purple at two sizes, and a bud.
  - Droplets on sizes 4–5, and a still ripple ring.
  - Palette: the reference sheet's swatches (pad base, shade and highlight;
    the three flower ramps; pollen; water). Hard edges only.
- **Interaction:**
  - Pointer hover over a pad, or the first tap on touch, shows a card: repo
    name, language with its color dot, "N commits by Mehul", and an "Open
    repo" link.
  - Clicking a pad on desktop, or tapping "Open repo" on touch, opens the repo
    in a new tab.
  - A tap on a pad never drops food. A tap on open water does.
- **Rest point:** the koi rests beside the center of the biggest pad, or at the
  pond center when there are no pads.

## Koi and feeding

- **Behavior:** `select_behavior` on the snapshot gives today's behavior: wander
  (cruise or dart), rest, deep rest, or surface feeding.
- **Feeding:** one food pellet at a time. A new tap moves it.
  - The koi steers to it and gulps.
  - The koi's gulp mouth comes from git-koi; the page adds a ripple at the
    gulp point.
- **Adaptive drawing:**
  - If the average koi render time over the first 2 s after load (or after a
    rebuild) is above 12 ms, the page switches to drawing the koi 20 times a
    second. Movement still updates every frame.
  - The legend shows which mode is active.

## Legend

It explains what drives what, with Mehul's real values from the snapshot:

- **Size:** total contributions (with the observation date); growth stage.
- **Colors:** each language with its GitHub color and share.
- **Mood:** today's behavior and the rule that picked it, phrased from git-koi's
  table. Examples: "rests: 16 quiet days", "darts: crossed 1,000 contributions
  this week", "feeds at the surface: first contribution this week".
- **Lilypads:** "N lilypads, one per public repo, sized by commits"; the 5 size
  steps; and the flower rule (most-used language blooms pink, second white,
  third purple, the rest bud).
- **Lighting:** the current phase and the visitor's local time.
- **Freshness:** "Data from <date>, refreshed nightly."

## git-koi changes (in the fork, on its feature branch, then re-pinned)

- **Repo names:** `OwnedRepository` gains `name_with_owner: String`, collected
  as `nameWithOwner` on the owned query.
  - Snapshot v4 is unreleased, so v4 changes in place: the field is required.
  - Tests are updated.
  - The repo URL is `https://github.com/<name_with_owner>`.
- **Pond size:** `layout_pond(snapshot, pond_width_pixels: u32,
pond_height_pixels: u32)`.
  - The 416×192 constants go.
  - Placement uses the given size.
  - Tests cover several sizes, including 400×800 and 960×540.
- **Legend inputs:** check that the legend's inputs are public. If any is not,
  the smallest change makes it public. The inputs are:
  - `KoiDevelopment.recent_activity`
  - the language shares and colors
  - total contributions
  - `observed_on`
  - the dart milestone list
- **Exactness:** existing outputs stay byte-identical (`tests/render_pinning.rs`
  untouched).

## WebAssembly interface (`crates/pond-wasm`)

The proof's `PondKoi` interface grows into:

- `new(snapshot_json, body, pond_w, pond_h, seed)`. The growth override moves
  behind a debug-only option, off on the site.
- `pads_json()`: an array of
  `{ repo, url, language, languageColor, commits, size, diameter, bloom, x, y, notch }`.
- `legend_json()`:
  `{ observedOn, totalContributions, growthStage, behavior, behaviorReason: { rule, value }, languages: [{ name, color, share }], padCount }`.
- `drop_food`, `step`, `render`, the pixel accessors and `frame_x`/`frame_y`
  keep their behavior.

## Data and deploy (one workflow, `.github/workflows/pond.yml`)

- **Triggers:**
  - A schedule at 00:20 UTC daily.
  - `workflow_dispatch`.
  - A push to the default branch.
- **Collect job** (schedule and dispatch only):
  - Installs the pinned git-koi with
    `cargo install --git https://github.com/Mehulsri07/git-koi --rev <REV> --locked git-koi`.
  - Runs `git-koi collect Mehulsri07 --output web/data/snapshot.json` with
    `GH_TOKEN: ${{ github.token }}`.
  - Commits only when the file changed.
- **Build job:**
  - Installs Rust and wasm32 and builds pond-wasm.
  - Installs wasm-bindgen-cli at the lockfile's version.
  - Converts art grids to PNGs and assembles `web/` into the Pages artifact.
- **Deploy job:** `actions/deploy-pages`.
- **Why one workflow:** a commit pushed with the workflow token does not trigger
  other workflows, so collect, build and deploy run in one run.
- **Permissions:** `contents: write`, `pages: write`, `id-token: write`.
- **Mehul's one manual step:** Settings → Pages → Source: GitHub Actions. Until
  then the deploy job fails with a clear message.

## Error handling

- **Snapshot missing or invalid:** the page shows a plain message over the empty
  pond ("The pond's data could not be read") with the reason. The pond floor
  still draws.
- **WebAssembly blocked or failed:** the same visible-message approach as the
  proof page.
- **Fewer than one pad** (no owned public repos): no pads; the legend says so.
- **Collect fails in the nightly run:** the job fails, so GitHub emails Mehul,
  and the previous snapshot stays deployed.

## Testing

**Rust (git-koi)**

- The new field round-trips.
- The layout respects the given pond sizes.
- Pinning tests are unchanged.

**Rust (pond-wasm, native unit tests)**

- `pads_json` and `legend_json` against the fixture.
- Behavior-reason phrasing for each rule.

**End to end (Playwright, `scripts/e2e.mjs`)**

- **Sizes:** each check runs at 1280×800 and at 400×800 in a phone viewport.
- **Load:** no console errors; the koi is drawn; the pad count equals
  `pads_json().length`.
- **Hover card:** hovering a pad shows its card with the right repo name.
- **Pad click:** clicking a pad opens the repo URL (popup intercepted).
- **Feeding:**
  - Tapping water ends in a gulp within 30 s.
  - Tapping a pad drops no food.
- **Lighting:** with Playwright's clock set to 02:00, the night grade and
  fireflies are present; at 12:00, day.
- **Legend:** it opens and closes with the keyboard.
- **Adaptive mode:** when render time is forced above 12 ms, the mode switches
  to 20 times a second.
- **Screenshots:** desktop and phone, day and night, saved for review.

**Art review:** an `art/sheet.html` page lays out every sprite at 4× beside the
reference palette. Mehul judges it.

## Out of scope

- Multiple koi.
- Other visitors' accounts.
- Sound.
- Serverless or real-time data.
- Analytics.
- A custom domain.
- Repos Mehul contributed to but doesn't own.
- The old README pond GIF (abandoned).
- Hover swing and drift for a resting koi in free mode (open git-koi minor).
