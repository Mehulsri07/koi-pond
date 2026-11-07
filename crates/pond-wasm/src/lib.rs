//! A thin wasm-bindgen wrapper over the git-koi fork: one koi swimming freely in a pond,
//! stepped and rendered from JavaScript.
//!
//! The page owns time and input: it calls [`PondKoi::step`] with the elapsed seconds,
//! [`PondKoi::drop_food`] when the visitor clicks, and [`PondKoi::render`] when it wants a
//! fresh bitmap. The bitmap stays inside the WebAssembly memory; the page reads it through
//! [`PondKoi::pixels_ptr`] and [`PondKoi::pixels_len`] without copying.

use git_koi::behavior::{Behavior, select_behavior};
use git_koi::coat::KoiBody;
use git_koi::history::AccountSnapshot;
use git_koi::koi::derive_koi_development;
use git_koi::render::{FreeFrame, KoiRenderer};
use git_koi::swim::{Pond, SwimEvent, SwimState};
use wasm_bindgen::prelude::*;

/// The body names the git-koi command accepts (src/main.rs BODY_NAMES).
const BODY_NAMES: [(&str, KoiBody); 6] = [
    ("white", KoiBody::White),
    ("black", KoiBody::Black),
    ("asagi", KoiBody::Asagi),
    ("tea", KoiBody::Tea),
    ("gold", KoiBody::Gold),
    ("platinum", KoiBody::Platinum),
];

/// One koi in one pond: its renderer, its swim state, the day's behavior, the food in
/// the water, and the frame last rendered.
#[wasm_bindgen]
pub struct PondKoi {
    koi_renderer: KoiRenderer,
    swim_state: SwimState,
    behavior: Behavior,
    food: Option<[f64; 2]>,
    free_frame: FreeFrame,
}

#[wasm_bindgen]
impl PondKoi {
    /// Develop a koi from an account snapshot (git-koi's JSON format) and put it in a
    /// pond of the given size, resting at the pond's center. `body` is one of white,
    /// black, asagi, tea, gold, platinum. `total_override`, when given, replaces the
    /// snapshot's total contributions, so tests can see every growth stage; it must be a
    /// finite, non-negative number and is truncated to a whole count. The first frame is
    /// rendered here, so the pixel accessors are valid from the start.
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot_json: &str,
        body: &str,
        pond_width: f64,
        pond_height: f64,
        seed: u64,
        total_override: Option<f64>,
    ) -> Result<PondKoi, JsError> {
        let account_snapshot: AccountSnapshot = serde_json::from_str(snapshot_json)
            .map_err(|error| JsError::new(&format!("invalid snapshot: {error}")))?;
        let mut koi_development = derive_koi_development(&account_snapshot)
            .map_err(|error| JsError::new(&format!("cannot develop a koi: {error:?}")))?;
        if let Some(total) = total_override {
            if !total.is_finite() || total < 0.0 {
                return Err(JsError::new(
                    "total_override must be a finite, non-negative number",
                ));
            }
            koi_development.total_contributions = total as u64;
        }
        let koi_body = BODY_NAMES
            .iter()
            .find(|(name, _)| *name == body)
            .map(|(_, koi_body)| *koi_body)
            .ok_or_else(|| {
                JsError::new(&format!(
                    "unknown body {body:?}; expected white, black, asagi, tea, gold, or platinum"
                ))
            })?;
        let behavior = select_behavior(&koi_development);
        let koi_renderer = KoiRenderer::new(&koi_development, koi_body);
        let pond = Pond {
            width_pixels: pond_width,
            height_pixels: pond_height,
            rest_point: [pond_width / 2.0, pond_height / 2.0],
        };
        let swim_state = SwimState::new(seed, pond, koi_renderer.body_length_pixels());
        let free_frame = koi_renderer.render_free_frame(&swim_state, behavior);
        Ok(PondKoi {
            koi_renderer,
            swim_state,
            behavior,
            food: None,
            free_frame,
        })
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
        match self.behavior {
            Behavior::DeepRest => "deep rest",
            Behavior::Rest => "rest",
            Behavior::SurfaceFeeding => "surface feeding",
            Behavior::Dart => "dart",
            Behavior::Cruise => "cruise",
        }
        .to_string()
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
