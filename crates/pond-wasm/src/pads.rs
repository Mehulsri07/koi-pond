//! The pads as the page sees them: one plain record per lilypad, ready for JSON.

use git_koi::history::{AccountSnapshot, LanguageColor};
use git_koi::pond::{Bloom, PondLayout};
use serde::Serialize;

/// One lilypad with its repository's name, language, and flower.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadView {
    /// The repository's `owner/name`.
    pub repo: String,
    /// The repository's page on GitHub.
    pub url: String,
    /// The repository's primary language, if it has one.
    pub language: Option<String>,
    /// The language's GitHub color as `#rrggbb`, if it has one.
    pub language_color: Option<String>,
    /// The owner's commit count in the repository.
    pub commits: u64,
    /// The pad size level, one through five.
    pub size: u8,
    /// The pad's width in pond pixels.
    pub diameter: u32,
    /// `pink`, `white`, `purple`, `bud`, or none.
    pub bloom: Option<&'static str>,
    /// The pad center's pond x.
    pub x: f64,
    /// The pad center's pond y.
    pub y: f64,
    /// The notch angle in radians.
    pub notch: f64,
}

/// Describe each laid-out pad using the snapshot's names, counts, and languages.
pub fn pads_from(account_snapshot: &AccountSnapshot, layout: &PondLayout) -> Vec<PadView> {
    let owned_repositories = account_snapshot
        .owned_repositories
        .as_deref()
        .unwrap_or(&[]);
    layout
        .pads
        .iter()
        .filter_map(|pad| {
            let owned = owned_repositories
                .iter()
                .find(|owned| owned.repository_id == pad.repository_id)?;
            let language = account_snapshot
                .repositories
                .iter()
                .find(|observation| observation.repository_id == pad.repository_id)
                .and_then(|observation| observation.primary_language.clone());
            let language_color = language
                .as_ref()
                .and_then(|name| {
                    account_snapshot
                        .language_colors
                        .as_ref()?
                        .get(name)?
                        .as_ref()
                })
                .map(|LanguageColor([red, green, blue])| {
                    format!("#{red:02x}{green:02x}{blue:02x}")
                });
            Some(PadView {
                repo: owned.name_with_owner.clone(),
                url: format!("https://github.com/{}", owned.name_with_owner),
                language,
                language_color,
                commits: owned.owner_commit_count,
                size: pad.size.level(),
                diameter: pad.size.diameter_pixels(),
                bloom: pad.bloom.map(|bloom| match bloom {
                    Bloom::Pink => "pink",
                    Bloom::White => "white",
                    Bloom::Purple => "purple",
                    Bloom::Bud => "bud",
                }),
                x: pad.center[0],
                y: pad.center[1],
                notch: pad.notch_radians,
            })
        })
        .collect()
}

/// Where the koi rests: just below the biggest pad's center, kept inside the pond; the
/// pond's center when there are no pads. The first of equally big pads wins.
pub fn rest_point(pads: &[PadView], width: u32, height: u32) -> [f64; 2] {
    let (width, height) = (f64::from(width), f64::from(height));
    let biggest = pads.iter().fold(None::<&PadView>, |best, pad| match best {
        Some(best) if best.diameter >= pad.diameter => Some(best),
        _ => Some(pad),
    });
    match biggest {
        Some(pad) => [
            pad.x.clamp(0.0, width),
            (pad.y + 0.6 * f64::from(pad.diameter)).clamp(0.0, height),
        ],
        None => [width / 2.0, height / 2.0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git_koi::pond::layout_pond;

    const FIXTURE: &str = include_str!("../../../web/fixtures/snapshot.json");

    fn fixture_pads() -> Vec<PadView> {
        let snapshot: AccountSnapshot = serde_json::from_str(FIXTURE).unwrap();
        let layout = layout_pond(&snapshot, 640, 360).unwrap();
        pads_from(&snapshot, &layout)
    }

    #[test]
    fn pads_carry_repo_names_and_urls() {
        let pads = fixture_pads();
        assert_eq!(pads.len(), 7);
        let strata = pads
            .iter()
            .find(|pad| pad.repo == "Mehulsri07/StrataField")
            .unwrap();
        assert_eq!(strata.url, "https://github.com/Mehulsri07/StrataField");
        assert_eq!(strata.commits, 120);
        assert_eq!(strata.size, 5);
        assert_eq!(strata.diameter, 48);
        assert_eq!(strata.language.as_deref(), Some("TypeScript"));
        assert_eq!(strata.language_color.as_deref(), Some("#3178c6"));
        assert!(pads.iter().all(|pad| pad.url.ends_with(&pad.repo)));
    }

    #[test]
    fn pads_without_languages_have_no_flowers() {
        let pads = fixture_pads();
        let notes = pads
            .iter()
            .find(|pad| pad.repo == "Mehulsri07/notes")
            .unwrap();
        assert_eq!(notes.language, None);
        assert_eq!(notes.language_color, None);
        assert_eq!(notes.bloom, None);
    }

    #[test]
    fn rest_point_sits_beside_the_biggest_pad() {
        let pads = fixture_pads();
        let biggest = pads.iter().find(|pad| pad.size == 5).unwrap();
        let [x, y] = rest_point(&pads, 640, 360);
        assert_eq!(x, biggest.x);
        assert!((y - (biggest.y + 0.6 * f64::from(biggest.diameter))).abs() < 1e-9 || y == 360.0);
        assert!((0.0..=640.0).contains(&x) && (0.0..=360.0).contains(&y));
    }

    #[test]
    fn rest_point_is_clamped_into_the_pond() {
        let mut pads = fixture_pads();
        pads.truncate(1);
        pads[0].y = 359.0;
        pads[0].x = 700.0;
        assert_eq!(rest_point(&pads, 640, 360), [640.0, 360.0]);
    }

    #[test]
    fn no_pads_rest_at_the_center() {
        assert_eq!(rest_point(&[], 640, 360), [320.0, 180.0]);
    }

    #[test]
    fn tiny_ponds_have_no_pads_and_do_not_panic() {
        let snapshot: AccountSnapshot = serde_json::from_str(FIXTURE).unwrap();
        for (width, height) in [(10, 10), (0, 0), (30, 300)] {
            let layout = layout_pond(&snapshot, width, height).unwrap();
            let pads = pads_from(&snapshot, &layout);
            for pad in &pads {
                let radius = f64::from(pad.diameter) / 2.0;
                assert!(pad.x - radius >= 0.0 && pad.x + radius <= f64::from(width));
                assert!(pad.y - radius >= 0.0 && pad.y + radius <= f64::from(height));
            }
            let [x, y] = rest_point(&pads, width, height);
            assert!(x.is_finite() && y.is_finite());
        }
    }
}
