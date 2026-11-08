//! What the legend says: the koi's growth, behavior and reason, languages, and pad count.

use git_koi::behavior::{Behavior, BehaviorReason};
use git_koi::history::LanguageColor;
use git_koi::koi::KoiDevelopment;
use serde::Serialize;

/// The rule that chose the behavior and the evidence it read, if any.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Reason {
    /// The snake_case rule name.
    pub rule: &'static str,
    /// Quiet days, the milestone, or the week's contributions; none for the others.
    pub value: Option<u64>,
}

/// One language's slice of the pond.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageShare {
    /// The language's name.
    pub name: String,
    /// `#rrggbb`, if GitHub gives the language a color.
    pub color: Option<String>,
    /// The fraction of eligible repositories, from zero to one.
    pub share: f64,
}

/// Everything the legend shows. The page adds the render mode itself.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Legend {
    /// The observation date, `YYYY-MM-DD`.
    pub observed_on: String,
    /// The total contributions the koi grows from.
    pub total_contributions: u64,
    /// The growth stage's name.
    pub growth_stage: &'static str,
    /// The behavior in the git-koi command's words.
    pub behavior: &'static str,
    /// Why the koi behaves so.
    pub reason: Reason,
    /// Languages, biggest share first.
    pub languages: Vec<LanguageShare>,
    /// How many pads the pond holds.
    pub pad_count: usize,
}

/// The growth stage for a total: hatchling, young, juvenile, adult, or fully grown.
pub fn growth_stage(total_contributions: u64) -> &'static str {
    match total_contributions {
        0..500 => "hatchling",
        500..1500 => "young",
        1500..12750 => "juvenile",
        12750..100000 => "adult",
        _ => "fully grown",
    }
}

/// The behavior in the words the git-koi command prints.
pub fn behavior_name(behavior: Behavior) -> &'static str {
    match behavior {
        Behavior::DeepRest => "deep rest",
        Behavior::Rest => "rest",
        Behavior::SurfaceFeeding => "surface feeding",
        Behavior::Dart => "dart",
        Behavior::Cruise => "cruise",
    }
}

fn reason_from(reason: BehaviorReason) -> Reason {
    let (rule, value) = match reason {
        BehaviorReason::DeepRest { quiet_days } => ("deep_rest", Some(u64::from(quiet_days))),
        BehaviorReason::Rest { quiet_days } => ("rest", Some(u64::from(quiet_days))),
        BehaviorReason::FirstContributionOfWeek => ("first_contribution_of_week", None),
        BehaviorReason::CrossedMilestone { milestone } => ("crossed_milestone", Some(milestone)),
        BehaviorReason::BusyWeek { week_contributions } => ("busy_week", Some(week_contributions)),
        BehaviorReason::Steady => ("steady", None),
    };
    Reason { rule, value }
}

/// Build the legend from a developed koi, its day's behavior and reason, and the pad count.
pub fn legend_from(
    koi_development: &KoiDevelopment,
    behavior: Behavior,
    reason: BehaviorReason,
    pad_count: usize,
) -> Legend {
    let mut languages: Vec<LanguageShare> = koi_development
        .language_shares
        .iter()
        .map(|(name, share)| LanguageShare {
            name: name.clone(),
            color: koi_development
                .language_colors
                .get(name)
                .copied()
                .flatten()
                .map(|LanguageColor([red, green, blue])| {
                    format!("#{red:02x}{green:02x}{blue:02x}")
                }),
            share: *share,
        })
        .collect();
    languages.sort_by(|first, second| second.share.total_cmp(&first.share));
    Legend {
        observed_on: koi_development.observed_on.to_string(),
        total_contributions: koi_development.total_contributions,
        growth_stage: growth_stage(koi_development.total_contributions),
        behavior: behavior_name(behavior),
        reason: reason_from(reason),
        languages,
        pad_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git_koi::behavior::explain_behavior;
    use git_koi::history::AccountSnapshot;
    use git_koi::koi::derive_koi_development;

    const FIXTURE: &str = include_str!("../../../web/fixtures/snapshot.json");

    #[test]
    fn legend_reports_the_fixtures_numbers() {
        let snapshot: AccountSnapshot = serde_json::from_str(FIXTURE).unwrap();
        let development = derive_koi_development(&snapshot).unwrap();
        let (behavior, reason) = explain_behavior(&development);
        let legend = legend_from(&development, behavior, reason, 7);
        assert_eq!(legend.observed_on, "2026-01-06");
        assert_eq!(legend.total_contributions, 14);
        assert_eq!(legend.growth_stage, "hatchling");
        assert_eq!(legend.pad_count, 7);
        assert_eq!(legend.behavior, behavior_name(behavior));
        assert_eq!(legend.languages.len(), 5);
        assert_eq!(legend.languages[0].name, "Python");
        assert!((legend.languages[0].share - 2.0 / 6.0).abs() < 1e-9);
        assert_eq!(legend.languages[0].color.as_deref(), Some("#3572a5"));
        let json = serde_json::to_value(&legend).unwrap();
        assert!(json.get("renderMode").is_none());
        assert!(json["reason"]["rule"].is_string());
        assert_eq!(json["padCount"], 7);
    }

    #[test]
    fn reasons_use_snake_case_rules_and_values() {
        let snapshot: AccountSnapshot = serde_json::from_str(FIXTURE).unwrap();
        let development = derive_koi_development(&snapshot).unwrap();
        let rest = legend_from(
            &development,
            Behavior::Rest,
            BehaviorReason::Rest { quiet_days: 20 },
            0,
        );
        assert_eq!(
            rest.reason,
            Reason {
                rule: "rest",
                value: Some(20)
            }
        );
        let steady = legend_from(&development, Behavior::Cruise, BehaviorReason::Steady, 0);
        assert_eq!(
            steady.reason,
            Reason {
                rule: "steady",
                value: None
            }
        );
        let first = legend_from(
            &development,
            Behavior::SurfaceFeeding,
            BehaviorReason::FirstContributionOfWeek,
            0,
        );
        assert_eq!(first.reason.rule, "first_contribution_of_week");
    }

    #[test]
    fn growth_stages_step_at_the_thresholds() {
        for (total, stage) in [
            (0, "hatchling"),
            (499, "hatchling"),
            (500, "young"),
            (1499, "young"),
            (1500, "juvenile"),
            (12749, "juvenile"),
            (12750, "adult"),
            (99999, "adult"),
            (100000, "fully grown"),
        ] {
            assert_eq!(growth_stage(total), stage, "total {total}");
        }
    }
}
