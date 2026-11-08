//! Reading rows a schema-2 store booked, for the one migration that carries
//! them into schema 3.
//!
//! Schema 2 booked what each agent's pane REPORTED, in that agent's own
//! terms: model names as the CLI showed them ("Opus 5.5 (1M context)",
//! "gpt-6.1-sol xhigh"), and token counts by the CLI's conventions. Schema 3
//! books canonical classes under `<provider>/<model>` keys, priced from the
//! journal. These rules describe that frozen old format and nothing live:
//! the live conventions belong to each agent's plugin, which maps its calls
//! before they are booked.

use crate::model::TokenCounts;

/// The `<provider>/<model>` key an old row's model is booked under.
///
/// - claude showed display names; they are read back into ids
///   ("Opus 5.5 (1M context)" → `anthropic/claude-opus-5-5`), and an id it
///   already reported is kept.
/// - codex appended the reasoning effort ("gpt-6.1-sol xhigh"); the model is
///   the first word.
/// - kimi showed its models as `<provider>/<model>` already
///   ("kimi-code/k3") — the very key its plugin books a call under — so the
///   name is the key.
/// - every other agent's model is kept as it was, under the agent's own name
///   as the provider: the journal resolves it to a maker by its id.
///
/// An empty model stays empty, and so stays unpriced.
pub fn booked_model(agent: &str, model: &str) -> String {
    let model = model.trim();
    match agent {
        "claude" => format!("anthropic/{}", claude_id(model)),
        "codex" => format!("openai/{}", model.split_whitespace().next().unwrap_or("")),
        "kimi" => model.to_string(),
        _ => format!("{agent}/{model}"),
    }
}

/// The key a schema-3 store carried an old row under, re-keyed by
/// [`booked_model`] as it reads now — None when the key stands.
///
/// Schema 3 put every model but claude's and codex's under the agent's own
/// name, so such a key still holds the name the agent showed
/// ("kimi/kimi-code/k3" holds "kimi-code/k3") and the current rule can be
/// applied to it again. Claude's and codex's keys were rewritten into ids
/// and are not touched; neither is any call booked since, which never
/// carries its agent's name as its provider.
pub fn rekeyed(agent: &str, key: &str) -> Option<String> {
    let shown = key.strip_prefix(agent)?.strip_prefix('/')?;
    let booked = booked_model(agent, shown);
    (booked != key).then_some(booked)
}

/// A claude display name ("Fable 5.1", "Opus 5 (1M context)") as its API id
/// ("claude-fable-5-1", "claude-opus-5"); an id is kept without its context
/// suffix; anything else is kept as it is.
fn claude_id(model: &str) -> String {
    let bare = model.split('[').next().unwrap_or(model).trim();
    if bare.starts_with("claude-") {
        return bare.to_string();
    }
    let name = bare.split(" (").next().unwrap_or(bare);
    let mut words = name.split_whitespace();
    match (words.next(), words.next(), words.next()) {
        (Some(family), Some(version), None)
            if version.chars().all(|c| c.is_ascii_digit() || c == '.') =>
        {
            format!("claude-{}-{}", family.to_lowercase(), version.replace('.', "-"))
        }
        _ => bare.to_string(),
    }
}

/// An old row's counts in the canonical classes.
///
/// - codex counted its input WITH the cached prefix (OpenAI's convention);
///   the fresh input is what remains after the cache read.
/// - opencode counted reasoning BESIDE output; billed output includes it.
/// - claude and kimi already counted fresh input and billed output.
///
/// claude's old rows never split the cache write by duration: all of it is
/// the 5-minute write. The total is recomputed as the billed sum.
pub fn canonical_tokens(agent: &str, tokens: &TokenCounts) -> TokenCounts {
    let mut canonical = tokens.clone();
    match agent {
        "codex" => {
            if let Some(input) = tokens.input {
                canonical.input = Some((input - tokens.cache_read.unwrap_or(0.0)).max(0.0));
            }
        }
        "opencode" => {
            if let Some(reasoning) = tokens.reasoning {
                canonical.output = Some(tokens.output.unwrap_or(0.0) + reasoning);
            }
        }
        _ => {}
    }
    canonical.total = Some(canonical.billed());
    canonical
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_display_names_read_back_into_ids() {
        assert_eq!(booked_model("claude", "Opus 5.5 (1M context)"), "anthropic/claude-opus-5-5");
        assert_eq!(booked_model("claude", "Opus 5"), "anthropic/claude-opus-5");
        assert_eq!(booked_model("claude", "Fable 5.1"), "anthropic/claude-fable-5-1");
        assert_eq!(booked_model("claude", "Sonnet 5.5"), "anthropic/claude-sonnet-5-5");
        assert_eq!(booked_model("claude", "Opus 4.8 (1M context)"), "anthropic/claude-opus-4-8");
        assert_eq!(booked_model("claude", "claude-opus-5-5"), "anthropic/claude-opus-5-5");
        assert_eq!(booked_model("claude", "claude-opus-5-5[1m]"), "anthropic/claude-opus-5-5");
        assert_eq!(booked_model("claude", ""), "anthropic/");
    }

    #[test]
    fn codex_drops_the_effort_from_its_model() {
        assert_eq!(booked_model("codex", "gpt-6.1-sol xhigh"), "openai/gpt-6.1-sol");
        assert_eq!(booked_model("codex", "gpt-6-astra medium"), "openai/gpt-6-astra");
    }

    #[test]
    fn other_agents_keep_their_model_under_their_own_name() {
        assert_eq!(booked_model("opencode", "x-ai/grok-4.6"), "opencode/x-ai/grok-4.6");
        assert_eq!(booked_model("opencode", "glm-5.3"), "opencode/glm-5.3");
    }

    #[test]
    fn kimi_shown_names_are_the_keys_its_calls_are_booked_under() {
        assert_eq!(booked_model("kimi", "kimi-code/k3"), "kimi-code/k3");
        assert_eq!(booked_model("kimi", "kimi-code/kimi-for-coding"), "kimi-code/kimi-for-coding");
    }

    #[test]
    fn only_keys_schema_3_put_under_the_agent_are_rekeyed() {
        assert_eq!(rekeyed("kimi", "kimi/kimi-code/k3").as_deref(), Some("kimi-code/k3"));
        assert_eq!(rekeyed("kimi", "kimi-code/k3"), None, "a call booked since stands");
        assert_eq!(rekeyed("opencode", "opencode/glm-5.3"), None, "the rule gives the same key");
        assert_eq!(rekeyed("claude", "anthropic/claude-opus-5-5"), None);
        assert_eq!(rekeyed("codex", "openai/gpt-6.1-sol"), None);
    }

    fn tokens(input: f64, output: f64, read: f64, write: f64, reasoning: Option<f64>) -> TokenCounts {
        TokenCounts {
            input: Some(input),
            output: Some(output),
            cache_read: Some(read),
            cache_write: Some(write),
            reasoning,
            total: Some(-1.0),
            ..TokenCounts::default()
        }
    }

    #[test]
    fn codex_input_loses_the_cached_prefix_it_counted() {
        let t = canonical_tokens("codex", &tokens(1000.0, 10.0, 900.0, 0.0, Some(4.0)));
        assert_eq!(t.input, Some(100.0));
        assert_eq!(t.output, Some(10.0), "codex output already holds its reasoning");
        assert_eq!(t.total, Some(1010.0));
    }

    #[test]
    fn opencode_output_gains_the_reasoning_it_counted_beside_it() {
        let t = canonical_tokens("opencode", &tokens(100.0, 10.0, 50.0, 0.0, Some(5.0)));
        assert_eq!(t.output, Some(15.0));
        assert_eq!(t.input, Some(100.0));
        assert_eq!(t.total, Some(165.0));
    }

    #[test]
    fn claude_counts_stand_and_only_the_total_is_recomputed() {
        let t = canonical_tokens("claude", &tokens(10.0, 20.0, 300.0, 40.0, None));
        assert_eq!((t.input, t.output, t.cache_read, t.cache_write), (Some(10.0), Some(20.0), Some(300.0), Some(40.0)));
        assert_eq!(t.total, Some(370.0));
    }
}
