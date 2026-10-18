//! Kimi account-limit fetcher — the one polled usage source.
//!
//! Kimi's rate-limit windows exist NOWHERE on disk (its own `/usage` TUI
//! command queries the network too), so unlike claude (statusLine push) and
//! codex (rollout tail) this provider needs a poll: a read-only GET against
//! the coding usages endpoint, authorized by the Bearer token kimi itself
//! maintains under `~/.kimi-code/credentials/`.
//!
//! WHICH endpoint and WHICH token file are kimi's login, not a constant: a
//! mainland-China login talks to `api.kimi.com` with `kimi-code.json`, a
//! global one to `api.kimi.ai` with a `kimi-code-env-<hash>.json` of its own.
//! Kimi records both in its `config.toml` under the managed provider, and
//! this reads them from there rather than re-deriving kimi's region rules.
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

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The API base of a mainland-China login — what kimi itself falls back to
/// when nothing names another.
const DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";

/// The credentials file of that login, `oauth/kimi-code` in kimi's terms.
const DEFAULT_TOKEN_NAME: &str = "kimi-code";

/// Where one poll goes, and with which token.
#[derive(Debug, PartialEq)]
struct UsageSource {
    url: String,
    credentials: PathBuf,
}

/// The managed login kimi recorded in `config.toml` → the usages URL and
/// the token file. `KIMI_CODE_BASE_URL` still overrides the URL, as it does
/// for kimi (its own convention, mirrored by every third-party poller). A
/// config that is missing, unreadable, or names no managed login reads as
/// the mainland default — what kimi does too. `None` only for a token key
/// that would name a file outside the credentials directory.
fn usage_source(
    home: &Path,
    config_toml: Option<&str>,
    env_base_url: Option<String>,
) -> Option<UsageSource> {
    let provider = config_toml
        .and_then(|text| text.parse::<toml::Table>().ok())
        .and_then(|config| {
            config
                .get("providers")?
                .get("managed:kimi-code")?
                .as_table()
                .cloned()
        });
    let base = env_base_url
        .or_else(|| {
            provider
                .as_ref()?
                .get("base_url")?
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| DEFAULT_BASE_URL.into());
    let token_key = provider
        .as_ref()
        .and_then(|p| p.get("oauth")?.get("key")?.as_str().map(str::to_owned));
    let token_name = match token_key {
        Some(key) => token_storage_name(&key)?,
        None => DEFAULT_TOKEN_NAME.into(),
    };
    Some(UsageSource {
        url: usages_url(&base),
        credentials: home.join("credentials").join(format!("{token_name}.json")),
    })
}

/// kimi's credential key → its file name, as kimi maps it
/// (`resolveKimiTokenStorageName`): `oauth/<name>` stores as `<name>`, a bare
/// name as itself. Anything that could leave the directory — a nested path,
/// a dot name — is refused, as kimi refuses it.
fn token_storage_name(key: &str) -> Option<String> {
    let name = key.strip_prefix("oauth/").unwrap_or(key);
    (!name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.starts_with('.'))
        .then(|| name.to_owned())
}

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

/// Kimi's home: `KIMI_CODE_HOME` when set, else `~/.kimi-code` — kimi's own
/// rule.
fn kimi_home() -> Option<PathBuf> {
    std::env::var_os("KIMI_CODE_HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".kimi-code")))
}

/// One read-only GET of the kimi usages document. Errors are strings for
/// the log; the webview treats any failure the same way — keep the last
/// snapshot and let it age. The blocking ureq call parks on the blocking
/// pool — a hung endpoint must not pin a Tokio worker for its 10s timeout.
#[tauri::command(async)]
pub async fn kimi_usages_fetch() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(fetch_usages_blocking)
        .await
        .map_err(|e| format!("kimi usages task failed: {e}"))?
}

fn fetch_usages_blocking() -> Result<String, String> {
    let home = kimi_home().ok_or("no home directory")?;
    let config = std::fs::read_to_string(home.join("config.toml")).ok();
    let source = usage_source(
        &home,
        config.as_deref(),
        std::env::var("KIMI_CODE_BASE_URL").ok(),
    )
    .ok_or("kimi config names a credentials key outside its credentials directory")?;
    let creds = std::fs::read_to_string(&source.credentials)
        .map_err(|e| format!("kimi credentials unreadable: {e}"))?;
    let token = bearer_from(&creds).ok_or("kimi credentials carry no access token")?;

    let response = ureq::get(&source.url)
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

    const MAINLAND: &str = r#"
[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"
type = "kimi"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
"#;

    const GLOBAL: &str = r#"
[providers."managed:kimi-code"]
base_url = "https://api.kimi.ai/coding/v1"
type = "kimi"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0123456789abcdef"
oauth_host = "https://auth.kimi.ai"
"#;

    fn source(config: Option<&str>, env: Option<&str>) -> Option<UsageSource> {
        usage_source(Path::new("/h/.kimi-code"), config, env.map(str::to_owned))
    }

    #[test]
    fn a_mainland_login_polls_the_com_api_with_the_default_token() {
        assert_eq!(
            source(Some(MAINLAND), None),
            Some(UsageSource {
                url: "https://api.kimi.com/coding/v1/usages".into(),
                credentials: "/h/.kimi-code/credentials/kimi-code.json".into(),
            })
        );
    }

    #[test]
    fn a_global_login_polls_its_own_api_with_its_own_token() {
        // The bug this exists for: a global login has no kimi-code.json, and
        // its token is not valid on the mainland deployment either.
        assert_eq!(
            source(Some(GLOBAL), None),
            Some(UsageSource {
                url: "https://api.kimi.ai/coding/v1/usages".into(),
                credentials: "/h/.kimi-code/credentials/kimi-code-env-0123456789abcdef.json".into(),
            })
        );
    }

    #[test]
    fn the_env_override_still_names_the_api() {
        let source = source(Some(GLOBAL), Some("https://proxy.example/kimi/")).unwrap();
        assert_eq!(source.url, "https://proxy.example/kimi/usages");
        assert!(source
            .credentials
            .ends_with("kimi-code-env-0123456789abcdef.json"));
    }

    #[test]
    fn no_usable_config_reads_as_the_mainland_default() {
        let default = source(Some(MAINLAND), None);
        assert_eq!(source(None, None), default);
        assert_eq!(source(Some("not [toml"), None), default);
        assert_eq!(
            source(Some("[providers.other]\nbase_url = \"x\""), None),
            default
        );
    }

    #[test]
    fn a_bare_key_is_its_own_file_name() {
        let config = MAINLAND.replace("oauth/kimi-code", "kimi-code-custom");
        assert!(source(Some(&config), None)
            .unwrap()
            .credentials
            .ends_with("credentials/kimi-code-custom.json"));
    }

    #[test]
    fn a_key_that_would_leave_the_credentials_directory_is_refused() {
        for key in [
            "oauth/../secret",
            "oauth/a/b",
            "oauth/.hidden",
            "oauth/",
            "..",
        ] {
            let config = MAINLAND.replace("oauth/kimi-code", key);
            assert_eq!(source(Some(&config), None), None, "{key}");
        }
        // A Windows separator too — TOML would read "a\b" in a basic string
        // as a backspace, so this one is asked of the mapping directly.
        assert_eq!(token_storage_name("oauth/a\\b"), None);
    }
}
