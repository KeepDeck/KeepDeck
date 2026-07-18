//! Kimi account-limit fetcher — the one polled usage source.
//!
//! Kimi's rate-limit windows exist NOWHERE on disk (its own `/usage` TUI
//! command queries the network too), so unlike claude (statusLine push) and
//! codex (rollout tail) this provider needs a poll: a read-only GET against
//! the coding usages endpoint, authorized by the Bearer token kimi itself
//! maintains in `~/.kimi-code/credentials/kimi-code.json`.
//!
//! Deliberate limits of this module:
//! - READ-ONLY on credentials: the token has a ~15-minute TTL and kimi
//!   refreshes it while active. A 401 here means "no live kimi activity" —
//!   the webview lets the last data age into staleness, it never refreshes
//!   the token itself.
//! - The response body rides to the webview as an OPAQUE string — the TS
//!   normalizer owns the schema (the deck.json division of labor).
//! - Polling cadence and gating (only while a kimi pane is live) are the
//!   webview's business; this is a single-shot command.

use std::path::PathBuf;
use std::time::Duration;

/// Default API base; `KIMI_CODE_BASE_URL` overrides (kimi's own convention,
/// mirrored by every third-party poller).
const DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";

/// The Bearer token from a credentials JSON body. Tolerates the
/// `accessToken` alias some kimi builds wrote.
fn bearer_from(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    ["access_token", "accessToken"]
        .iter()
        .find_map(|key| value.get(key)?.as_str().map(str::to_string))
        .filter(|token| !token.is_empty())
}

/// `{base}/usages` with a single joining slash regardless of the override's
/// trailing shape.
fn usages_url(base: &str) -> String {
    format!("{}/usages", base.trim_end_matches('/'))
}

fn credentials_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".kimi-code/credentials/kimi-code.json"))
}

/// One read-only GET of the kimi usages document. Errors are strings for
/// the log; the webview treats any failure the same way — keep the last
/// snapshot and let it age.
#[tauri::command(async)]
pub fn kimi_usages_fetch() -> Result<String, String> {
    let path = credentials_path().ok_or("no home directory")?;
    let creds = std::fs::read_to_string(&path)
        .map_err(|e| format!("kimi credentials unreadable: {e}"))?;
    let token = bearer_from(&creds).ok_or("kimi credentials carry no access token")?;
    let base = std::env::var("KIMI_CODE_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.into());

    let response = ureq::get(&usages_url(&base))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| match e {
            // The status matters to the caller's log line (401 = token idle).
            ureq::Error::Status(code, _) => format!("kimi usages HTTP {code}"),
            other => format!("kimi usages request failed: {other}"),
        })?;
    response
        .into_string()
        .map_err(|e| format!("kimi usages body unreadable: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_reads_both_field_spellings_and_rejects_empties() {
        assert_eq!(
            bearer_from(r#"{"access_token":"tok-a","token_type":"Bearer"}"#),
            Some("tok-a".into())
        );
        assert_eq!(
            bearer_from(r#"{"accessToken":"tok-b"}"#),
            Some("tok-b".into())
        );
        assert_eq!(bearer_from(r#"{"access_token":""}"#), None);
        assert_eq!(bearer_from(r#"{"refresh_token":"r"}"#), None);
        assert_eq!(bearer_from("not json"), None);
    }

    #[test]
    fn the_url_joins_cleanly_with_and_without_trailing_slashes() {
        assert_eq!(
            usages_url("https://api.kimi.com/coding/v1"),
            "https://api.kimi.com/coding/v1/usages"
        );
        assert_eq!(
            usages_url("https://proxy.example/kimi/"),
            "https://proxy.example/kimi/usages"
        );
    }
}
