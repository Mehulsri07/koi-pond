//! A thin wasm-bindgen wrapper over the git-koi fork: one koi swimming freely in a pond,
//! stepped and rendered from JavaScript.
//!
//! The page owns time and input: it calls [`PondKoi::step`] with the elapsed seconds,
//! [`PondKoi::drop_food`] when the visitor clicks, and [`PondKoi::render`] when it wants a
//! fresh bitmap. The bitmap stays inside the WebAssembly memory; the page reads it through
//! [`PondKoi::pixels_ptr`] and [`PondKoi::pixels_len`] without copying.

use git_koi::behavior::{Behavior, BehaviorReason, explain_behavior};
use git_koi::coat::KoiBody;
use git_koi::history::AccountSnapshot;
use git_koi::koi::{KoiDevelopment, derive_koi_development};
use git_koi::pond::layout_pond;
use git_koi::render::{FreeFrame, KoiRenderer};
use git_koi::swim::{Pond, SwimEvent, SwimState};
use wasm_bindgen::prelude::*;

mod legend;
mod pads;

use legend::{behavior_name, legend_from};
use pads::{PadView, moved_down, pads_from, rest_point, scaled};

/// The body names the git-koi command accepts (src/main.rs BODY_NAMES).
const BODY_NAMES: [(&str, KoiBody); 6] = [
    ("white", KoiBody::White),
    ("black", KoiBody::Black),
    ("asagi", KoiBody::Asagi),
    ("tea", KoiBody::Tea),
    ("gold", KoiBody::Gold),
    ("platinum", KoiBody::Platinum),
];

/// One koi in one pond: its development, renderer, swim state, the day's behavior, the pads,
/// the food in the water, and the frame last rendered.
#[wasm_bindgen]
pub struct PondKoi {
    koi_development: KoiDevelopment,
    koi_body: KoiBody,
    seed: u64,
    pond: Pond,
    koi_renderer: KoiRenderer,
    swim_state: SwimState,
    behavior: Behavior,
    behavior_reason: BehaviorReason,
    pads: Vec<PadView>,
    food: Option<[f64; 2]>,
    free_frame: FreeFrame,
}

#[wasm_bindgen]
impl PondKoi {
    /// Develop a koi from an account snapshot (git-koi's version 4 JSON format), lay out
    /// its pads in a pond of the given size in pond pixels, and put the koi at rest just
    /// below the biggest pad (at the pond's center when there are no pads). `body` is one of
    /// white, black, asagi, tea, gold, platinum. The first frame is rendered here, so the
    /// pixel accessors are valid from the start.
    ///
    /// `sprite_scale` is the whole number the page draws its sprites at (web/src/view.js:
    /// 2 on laptop-size ponds, else 1; 0 is taken as 1). The pads are laid out by git-koi
    /// on a pond `floor(width / s)` by `floor(height / s)`, and each pad's x, y and diameter
    /// are then multiplied by `s`, so the bigger pads stay inside the pond, keep git-koi's
    /// gap (times `s`) between them, and rest the koi beside the biggest. At 1 the layout
    /// is git-koi's own. The koi itself is never scaled.
    ///
    /// `top_inset` is how many pond pixels at the top the page covers (its header, plus a
    /// little room). The layout is made for a pond `ceil(top_inset / s)` sprite pixels
    /// shorter and moved down by that many before scaling, so every pad's top edge is at
    /// least `top_inset` down and the shift is a whole number of sprite pixels. git-koi's
    /// placement does not depend on where the pond starts, so gaps and fit hold. 0 gives
    /// the layout above. An inset as tall as the pond leaves no room for pads.
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot_json: &str,
        body: &str,
        pond_width: u32,
        pond_height: u32,
        seed: u64,
        sprite_scale: u32,
        top_inset: u32,
    ) -> Result<PondKoi, JsError> {
        let account_snapshot: AccountSnapshot = serde_json::from_str(snapshot_json)
            .map_err(|error| JsError::new(&format!("invalid snapshot: {error}")))?;
        let koi_development = derive_koi_development(&account_snapshot)
            .map_err(|error| JsError::new(&format!("cannot develop a koi: {error:?}")))?;
        let koi_body = BODY_NAMES
            .iter()
            .find(|(name, _)| *name == body)
            .map(|(_, koi_body)| *koi_body)
            .ok_or_else(|| {
                JsError::new(&format!(
                    "unknown body {body:?}; expected white, black, asagi, tea, gold, or platinum"
                ))
            })?;
        let sprite_scale = sprite_scale.max(1);
        let inset = top_inset.div_ceil(sprite_scale);
        let layout = layout_pond(
            &account_snapshot,
            pond_width / sprite_scale,
            (pond_height / sprite_scale).saturating_sub(inset),
        )
        .map_err(|error| JsError::new(&error.to_string()))?;
        let pads = scaled(
            moved_down(pads_from(&account_snapshot, &layout), inset),
            sprite_scale,
        );
        let (behavior, behavior_reason) = explain_behavior(&koi_development);
        let pond = Pond {
            width_pixels: f64::from(pond_width),
            height_pixels: f64::from(pond_height),
            rest_point: rest_point(&pads, pond_width, pond_height),
        };
        let koi_renderer = KoiRenderer::new(&koi_development, koi_body);
        let swim_state = SwimState::new(seed, pond, koi_renderer.body_length_pixels());
        let free_frame = koi_renderer.render_free_frame(&swim_state, behavior);
        Ok(PondKoi {
            koi_development,
            koi_body,
            seed,
            pond,
            koi_renderer,
            swim_state,
            behavior,
            behavior_reason,
            pads,
            food: None,
            free_frame,
        })
    }

    /// For testing: replace the snapshot's total contributions so every growth stage can be
    /// seen. The koi regrows to that size and starts its swim again from the rest point;
    /// the legend's total, growth stage, behavior, and reason follow, because a milestone
    /// crossing depends on the total. Negative and non-finite totals are
    /// ignored; others are truncated to a whole count.
    pub fn set_growth_override(&mut self, total: f64) {
        if !total.is_finite() || total < 0.0 {
            return;
        }
        self.koi_development.total_contributions = total as u64;
        (self.behavior, self.behavior_reason) = explain_behavior(&self.koi_development);
        self.koi_renderer = KoiRenderer::new(&self.koi_development, self.koi_body);
        self.swim_state =
            SwimState::new(self.seed, self.pond, self.koi_renderer.body_length_pixels());
        self.render();
    }

    /// The pads as a JSON array of `{repo, url, language, languageColor, commits, size,
    /// diameter, bloom, x, y, notch}`.
    pub fn pads_json(&self) -> String {
        serde_json::to_string(&self.pads).expect("pads serialize")
    }

    /// The legend as JSON: `{observedOn, totalContributions, growthStage, behavior,
    /// reason: {rule, value}, languages: [{name, color, share}], padCount}`. The page adds
    /// the render mode itself.
    pub fn legend_json(&self) -> String {
        let legend = legend_from(
            &self.koi_development,
            self.behavior,
            self.behavior_reason,
            self.pads.len(),
        );
        serde_json::to_string(&legend).expect("legend serializes")
    }

    /// Put food at a pond point, replacing any food already there.
    pub fn drop_food(&mut self, x: f64, y: f64) {
        self.food = Some([x, y]);
    }

    /// Advance the swim by `dt_seconds` (git-koi clamps one step to 0.1 s). Returns true
    /// when the koi gulped the food during this step; the food is then gone.
    pub fn step(&mut self, dt_seconds: f64) -> bool {
        let gulped =
            self.swim_state.step(dt_seconds, self.behavior, self.food) == SwimEvent::Gulped;
        if gulped {
            self.food = None;
        }
        gulped
    }

    /// Render the koi as it is now into the internal buffer, replacing the last frame.
    /// Pointers from [`Self::pixels_ptr`] taken before this call may be stale.
    pub fn render(&mut self) {
        self.free_frame = self
            .koi_renderer
            .render_free_frame(&self.swim_state, self.behavior);
    }

    /// Start of the last frame's RGBA bytes in WebAssembly memory, row by row from the
    /// top left.
    pub fn pixels_ptr(&self) -> *const u8 {
        self.free_frame.frame.as_rgba_bytes().as_ptr()
    }

    /// Length of the last frame's RGBA bytes: width times height times four.
    pub fn pixels_len(&self) -> usize {
        self.free_frame.frame.as_rgba_bytes().len()
    }

    /// The last frame's width in pond pixels.
    pub fn frame_width(&self) -> u32 {
        self.free_frame.frame.width_pixels()
    }

    /// The last frame's height in pond pixels.
    pub fn frame_height(&self) -> u32 {
        self.free_frame.frame.height_pixels()
    }

    /// The pond x of the last frame's top left pixel.
    pub fn frame_x(&self) -> i32 {
        self.free_frame.top_left[0]
    }

    /// The pond y of the last frame's top left pixel.
    pub fn frame_y(&self) -> i32 {
        self.free_frame.top_left[1]
    }

    /// The day's behavior, in the words the git-koi command prints.
    pub fn behavior(&self) -> String {
        behavior_name(self.behavior).to_string()
    }

    /// The koi's body length from snout to tail stalk in pond pixels, tail fin excluded.
    pub fn body_length(&self) -> f64 {
        self.koi_renderer.body_length_pixels()
    }

    /// The food's pond x, or NaN when there is none.
    pub fn food_x(&self) -> f64 {
        self.food.map_or(f64::NAN, |food| food[0])
    }

    /// The food's pond y, or NaN when there is none.
    pub fn food_y(&self) -> f64 {
        self.food.map_or(f64::NAN, |food| food[1])
    }

    /// Whether food is in the water.
    pub fn has_food(&self) -> bool {
        self.food.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../web/fixtures/snapshot.json");

    const PINNED_1280X744: &str = include_str!("../testdata/pads-1280x744-scale1.json");
    const PINNED_400X800: &str = include_str!("../testdata/pads-400x800-scale1.json");

    fn pads_of(koi: &PondKoi) -> Vec<serde_json::Value> {
        serde_json::from_str(&koi.pads_json()).unwrap()
    }

    #[test]
    fn sprite_scale_one_keeps_todays_pads() {
        let koi = PondKoi::new(FIXTURE, "gold", 1280, 744, 7, 1, 0)
            .ok()
            .unwrap();
        assert_eq!(koi.pads_json(), PINNED_1280X744.trim_end());
        let koi = PondKoi::new(FIXTURE, "gold", 400, 800, 7, 1, 0)
            .ok()
            .unwrap();
        assert_eq!(koi.pads_json(), PINNED_400X800.trim_end());
    }

    #[test]
    fn sprite_scale_zero_is_taken_as_one() {
        let koi = PondKoi::new(FIXTURE, "gold", 1280, 744, 7, 0, 0)
            .ok()
            .unwrap();
        assert_eq!(koi.pads_json(), PINNED_1280X744.trim_end());
    }

    #[test]
    fn sprite_scale_two_lays_out_bigger_pads_that_still_fit() {
        let (width, height) = (1280.0, 744.0);
        let koi = PondKoi::new(FIXTURE, "gold", 1280, 744, 7, 2, 0)
            .ok()
            .unwrap();
        let pads = pads_of(&koi);
        assert_eq!(pads.len(), 7);
        let disc = |pad: &serde_json::Value| {
            (
                pad["x"].as_f64().unwrap(),
                pad["y"].as_f64().unwrap(),
                pad["diameter"].as_f64().unwrap() / 2.0,
            )
        };
        for pad in &pads {
            let (x, y, radius) = disc(pad);
            let diameter = pad["diameter"].as_u64().unwrap();
            assert!((32..=96).contains(&diameter), "diameter {diameter}");
            assert_eq!(
                diameter % 16,
                0,
                "twice a native 8 + 8n diameter: {diameter}"
            );
            assert!(x - radius >= 0.0 && x + radius <= width, "{pad}");
            assert!(y - radius >= 0.0 && y + radius <= height, "{pad}");
        }
        for (index, first) in pads.iter().enumerate() {
            for second in &pads[index + 1..] {
                let (x1, y1, r1) = disc(first);
                let (x2, y2, r2) = disc(second);
                let gap = (x1 - x2).hypot(y1 - y2) - r1 - r2;
                assert!(gap >= 4.0 - 1e-9, "gap {gap} between {first} and {second}");
            }
        }
        // The biggest pad is twice today's biggest, and the koi rests beside it.
        let biggest = pads
            .iter()
            .max_by_key(|pad| pad["diameter"].as_u64().unwrap())
            .unwrap();
        assert_eq!(biggest["diameter"], 96);
        let (x, y, radius) = disc(biggest);
        let [rest_x, rest_y] = koi.pond.rest_point;
        assert_eq!(rest_x, x.clamp(0.0, width));
        assert!((rest_y - (y + 1.2 * radius).clamp(0.0, height)).abs() < 1e-9);
    }

    #[test]
    fn sprite_scale_two_doubles_a_half_size_layout() {
        let small = PondKoi::new(FIXTURE, "gold", 640, 372, 7, 1, 0)
            .ok()
            .unwrap();
        let big = PondKoi::new(FIXTURE, "gold", 1281, 745, 7, 2, 0)
            .ok()
            .unwrap();
        let (small, big) = (pads_of(&small), pads_of(&big));
        assert_eq!(small.len(), big.len());
        for (one, two) in small.iter().zip(&big) {
            assert_eq!(one["repo"], two["repo"]);
            assert_eq!(one["notch"], two["notch"]);
            assert_eq!(one["size"], two["size"]);
            for field in ["x", "y", "diameter"] {
                assert_eq!(
                    2.0 * one[field].as_f64().unwrap(),
                    two[field].as_f64().unwrap(),
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn a_top_inset_keeps_every_pad_below_it() {
        for sprite_scale in [1, 2] {
            for (width, height, inset) in [
                (1280, 800, 49),
                (1280, 800, 50),
                (400, 800, 61),
                (640, 360, 30),
            ] {
                let koi = PondKoi::new(FIXTURE, "gold", width, height, 7, sprite_scale, inset)
                    .ok()
                    .unwrap();
                let pads = pads_of(&koi);
                assert_eq!(pads.len(), 7, "{width}x{height} at {sprite_scale}");
                for pad in &pads {
                    let (y, diameter) = (
                        pad["y"].as_f64().unwrap(),
                        pad["diameter"].as_f64().unwrap(),
                    );
                    assert!(
                        y - diameter / 2.0 >= f64::from(inset),
                        "{pad} below {inset} at {sprite_scale}"
                    );
                    assert!(
                        y + diameter / 2.0 <= f64::from(height),
                        "{pad} inside at {sprite_scale}"
                    );
                }
                let biggest = pads
                    .iter()
                    .max_by_key(|pad| pad["diameter"].as_u64().unwrap())
                    .unwrap();
                let [rest_x, _] = koi.pond.rest_point;
                assert_eq!(rest_x, biggest["x"].as_f64().unwrap());
            }
        }
    }

    #[test]
    fn a_top_inset_shifts_the_shorter_layout_down_by_whole_sprite_pixels() {
        // 2x pond 1280x800 with a 49 px inset: the layout is made for 640x(400 - 25) and
        // moved down 25 sprite pixels (50 pond px).
        let plain = PondKoi::new(FIXTURE, "gold", 1280, 750, 7, 2, 0)
            .ok()
            .unwrap();
        let inset = PondKoi::new(FIXTURE, "gold", 1280, 800, 7, 2, 49)
            .ok()
            .unwrap();
        for (one, two) in pads_of(&plain).iter().zip(&pads_of(&inset)) {
            assert_eq!(one["x"], two["x"]);
            assert_eq!(
                one["y"].as_f64().unwrap() + 50.0,
                two["y"].as_f64().unwrap()
            );
        }
    }

    #[test]
    fn tiny_ponds_build_a_koi_without_panicking() {
        for (width, height) in [(10, 10), (0, 0), (30, 300)] {
            let koi = PondKoi::new(FIXTURE, "gold", width, height, 7, 2, 0)
                .ok()
                .unwrap();
            assert!(koi.pads_json().starts_with('['));
            // An inset taller than the pond leaves no room, and no pads.
            let koi = PondKoi::new(FIXTURE, "gold", width, height, 7, 2, 1000)
                .ok()
                .unwrap();
            assert_eq!(koi.pads_json(), "[]");
        }
    }

    #[test]
    fn a_growth_override_that_crosses_a_milestone_makes_the_koi_dart() {
        let mut koi = PondKoi::new(FIXTURE, "gold", 640, 360, 7, 1, 0)
            .ok()
            .unwrap();
        assert_eq!(koi.behavior(), "cruise");
        koi.set_growth_override(1003.0);
        assert_eq!(koi.behavior(), "dart");
        let legend: serde_json::Value = serde_json::from_str(&koi.legend_json()).unwrap();
        assert_eq!(legend["behavior"], "dart");
        assert_eq!(legend["reason"]["rule"], "crossed_milestone");
        assert_eq!(legend["reason"]["value"], 1000);
    }

    #[test]
    fn the_growth_override_moves_the_legend() {
        let mut koi = PondKoi::new(FIXTURE, "gold", 640, 360, 7, 1, 0)
            .ok()
            .unwrap();
        koi.set_growth_override(2000.0);
        let legend: serde_json::Value = serde_json::from_str(&koi.legend_json()).unwrap();
        assert_eq!(legend["growthStage"], "juvenile");
        assert_eq!(legend["totalContributions"], 2000);
    }
}
