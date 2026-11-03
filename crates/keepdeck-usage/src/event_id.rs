//! A recorded event's id: deterministic in what produced it, so a report
//! that is recorded twice — a retried write, a replayed catch-up — is
//! recognised as the same event and booked once.

use crate::model::Observation;

pub fn event_id(
    session_key: &str,
    previous: Option<&Observation>,
    observation: &Observation,
    source_sequence: f64,
) -> String {
    let material = serde_json::to_string(&(session_key, previous, observation, source_sequence))
        .expect("an observation always serialises");
    let mut first: u32 = 0x811c_9dc5;
    let mut second: u32 = 0x9e37_79b9;
    for unit in material.encode_utf16() {
        let code = u32::from(unit);
        first ^= code;
        first = first.wrapping_mul(0x0100_0193);
        second = (second ^ code).wrapping_mul(0x85eb_ca6b);
    }
    format!("usage-{first:08x}{second:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TokenCounts;

    fn seen(input: f64) -> Observation {
        Observation {
            tokens: TokenCounts {
                input: Some(input),
                ..TokenCounts::default()
            },
            cost_usd: None,
        }
    }

    #[test]
    fn the_same_report_on_the_same_base_has_the_same_id() {
        assert_eq!(
            event_id("claude\0s", Some(&seen(1.0)), &seen(2.0), 7.0),
            event_id("claude\0s", Some(&seen(1.0)), &seen(2.0), 7.0)
        );
    }

    #[test]
    fn any_difference_in_what_produced_it_changes_the_id() {
        let id = event_id("claude\0s", Some(&seen(1.0)), &seen(2.0), 7.0);
        assert_ne!(id, event_id("codex\0s", Some(&seen(1.0)), &seen(2.0), 7.0));
        assert_ne!(id, event_id("claude\0s", None, &seen(2.0), 7.0));
        assert_ne!(id, event_id("claude\0s", Some(&seen(1.0)), &seen(3.0), 7.0));
        assert_ne!(id, event_id("claude\0s", Some(&seen(1.0)), &seen(2.0), 8.0));
        assert!(id.starts_with("usage-") && id.len() == "usage-".len() + 16);
    }
}
