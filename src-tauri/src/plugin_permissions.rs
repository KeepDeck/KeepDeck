//! What a plugin's declared environment and network reach resolve to.
//!
//! A manifest may name environment variables it reads (`env`), and a `net`
//! entry may take a domain or a credentials directory from one of them, with
//! a literal default (`{ env, default }`). The host resolves that ONCE, here,
//! against one snapshot of its own startup environment: concrete origins,
//! concrete directories, and the raw values of the declared names only.
//! Consent, the fingerprint, the HTTP service, downloads and the realm's CSP
//! all read that one result — no second reading of the environment and no
//! second rule for what a reference means.
//!
//! Like the other plugin services, nothing here keeps a manifest store: the
//! trusted host passes the declaration in, and the result goes back to it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use url::Url;

use crate::containment::expand_home_from;

/// A declared variable's value is at most this long; a longer one is an
/// error, never cut.
const MAX_ENV_VALUE_BYTES: usize = 64 * 1024;
const MAX_ENV_NAME_BYTES: usize = 128;

/// The native process's environment as it started — the only environment a
/// plugin's declaration is resolved against. Not a pane's, not a login
/// shell's; and it does not change while the app runs.
pub struct HostEnvironment {
    vars: HashMap<String, OsString>,
    home: Option<OsString>,
    cwd: Option<PathBuf>,
}

impl HostEnvironment {
    fn capture() -> Self {
        Self {
            vars: std::env::vars_os()
                .filter_map(|(name, value)| name.into_string().ok().map(|name| (name, value)))
                .collect(),
            home: std::env::var_os("HOME"),
            cwd: std::env::current_dir().ok(),
        }
    }

    fn var(&self, name: &str) -> Option<&OsStr> {
        self.vars.get(name).map(OsString::as_os_str)
    }
}

static SNAPSHOT: OnceLock<HostEnvironment> = OnceLock::new();

/// The snapshot, taken the first time anything asks — `lib.rs` asks at
/// startup, so it is the environment the app was launched with.
pub fn host_environment() -> &'static HostEnvironment {
    SNAPSHOT.get_or_init(HostEnvironment::capture)
}

/// A domain or a directory chosen by a declared variable, with a literal
/// fallback when the variable is unset or exactly empty.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvDefault {
    env: String,
    default: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum NetDomain {
    Literal(String),
    Env(EnvDefault),
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvDirectory {
    env: String,
    default: String,
    append: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum CredentialDirectory {
    Literal(String),
    Env(EnvDirectory),
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialDeclaration {
    id: String,
    dir: CredentialDirectory,
    token_fields: Vec<String>,
}

/// One capability of a manifest, as far as this module cares: an `env`, a
/// `net`, or anything else (ignored).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind")]
enum Declared {
    #[serde(rename = "env")]
    Env { names: Vec<String> },
    #[serde(rename = "net")]
    Net {
        domains: Vec<NetDomain>,
        #[serde(default)]
        credentials: Vec<CredentialDeclaration>,
    },
    #[serde(other)]
    Other,
}

/// What a manifest's declaration came to on this machine.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPermissions {
    /// Every declared name, with its raw value or null when unset. Nothing
    /// undeclared is ever read.
    env: BTreeMap<String, Option<String>>,
    /// One per `net` capability, in manifest order.
    net: Vec<ResolvedNet>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedNet {
    /// Where this entry reaches: a literal `host[:port]` (both schemes, as
    /// a literal domain always meant) or an exact `scheme://host:port`
    /// origin chosen by a variable.
    allow: Vec<String>,
    credentials: Vec<ResolvedCredential>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCredential {
    id: String,
    /// Absolute, its existing prefix canonical. A directory that does not
    /// exist yet is a valid grant that authorizes no read until it does.
    dir: String,
    token_fields: Vec<String>,
}

/// Resolve a plugin's declaration (its manifest `capabilities`) against the
/// startup environment.
#[tauri::command]
pub fn plugin_permissions_resolve(
    capabilities: Vec<serde_json::Value>,
) -> Result<ResolvedPermissions, String> {
    resolve(&capabilities, host_environment())
}

fn declarations(capabilities: &[serde_json::Value]) -> Result<Vec<Declared>, String> {
    capabilities
        .iter()
        .enumerate()
        .map(|(index, capability)| {
            serde_json::from_value(capability.clone())
                .map_err(|error| format!("CAPABILITY_MALFORMED at capabilities[{index}]: {error}"))
        })
        .collect()
}

fn declared_names(declared: &[Declared]) -> BTreeSet<String> {
    declared
        .iter()
        .flat_map(|capability| match capability {
            Declared::Env { names } => names.clone(),
            _ => Vec::new(),
        })
        .collect()
}

pub(crate) fn resolve(
    capabilities: &[serde_json::Value],
    host: &HostEnvironment,
) -> Result<ResolvedPermissions, String> {
    let declared = declarations(capabilities)?;
    let names = declared_names(&declared);
    let mut env = BTreeMap::new();
    for name in &names {
        env.insert(name.clone(), env_value(name, host)?);
    }
    let mut credential_ids = BTreeSet::new();
    let mut net = Vec::new();
    for capability in &declared {
        let Declared::Net {
            domains,
            credentials,
        } = capability
        else {
            continue;
        };
        let allow = domains
            .iter()
            .map(|domain| allowance(domain, &names, host))
            .collect::<Result<Vec<_>, _>>()?;
        let mut resolved = Vec::new();
        for credential in credentials {
            if !credential_ids.insert(credential.id.clone()) {
                return Err(format!("CREDENTIAL_ID_DUPLICATE at {}", credential.id));
            }
            if credential.token_fields.is_empty() {
                return Err(format!("CREDENTIAL_FIELDS_EMPTY at {}", credential.id));
            }
            resolved.push(ResolvedCredential {
                id: credential.id.clone(),
                dir: credential_dir(&credential.dir, &names, host)
                    .map_err(|error| format!("{error} at {}", credential.id))?
                    .to_string_lossy()
                    .into_owned(),
                token_fields: credential.token_fields.clone(),
            });
        }
        net.push(ResolvedNet {
            allow,
            credentials: resolved,
        });
    }
    Ok(ResolvedPermissions { env, net })
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= MAX_ENV_NAME_BYTES
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// A declared variable's raw value: null when unset, an error — never a
/// truncation or a quiet fallback — when it cannot be carried as text.
fn env_value(name: &str, host: &HostEnvironment) -> Result<Option<String>, String> {
    if !valid_env_name(name) {
        return Err(format!("ENV_NAME_INVALID at {name}"));
    }
    let Some(raw) = host.var(name) else {
        return Ok(None);
    };
    let value = raw
        .to_str()
        .ok_or_else(|| format!("ENV_VALUE_INVALID at {name}: not UTF-8"))?;
    if value.len() > MAX_ENV_VALUE_BYTES {
        return Err(format!("ENV_VALUE_INVALID at {name}: longer than 64 KiB"));
    }
    Ok(Some(value.to_string()))
}

/// The variable's value when it is set and not empty, else the default —
/// and whether the value came from the variable.
fn selected<'a>(
    env: &str,
    default: &'a str,
    names: &BTreeSet<String>,
    host: &'a HostEnvironment,
) -> Result<(String, bool), String> {
    if !names.contains(env) {
        return Err(format!("ENV_REFERENCE_UNDECLARED at {env}"));
    }
    match env_value(env, host)? {
        Some(value) if !value.is_empty() => Ok((value, true)),
        _ => Ok((default.to_string(), false)),
    }
}

fn allowance(
    domain: &NetDomain,
    names: &BTreeSet<String>,
    host: &HostEnvironment,
) -> Result<String, String> {
    match domain {
        NetDomain::Literal(literal) if is_bare_hostname(literal) => Ok(literal.to_ascii_lowercase()),
        NetDomain::Literal(literal) => Err(format!("NET_DOMAIN_INVALID at {literal:?}")),
        NetDomain::Env(reference) => {
            let (value, from_env) = selected(&reference.env, &reference.default, names, host)?;
            exact_origin(&value).map_err(|why| {
                // A variable's text is the user's and may be a secret: the
                // error names the variable, never the value.
                if from_env {
                    format!("ENV_VALUE_INVALID at {}: {why}", reference.env)
                } else {
                    format!("NET_DEFAULT_INVALID at {}: {why}", reference.env)
                }
            })
        }
    }
}

/// An absolute http(s) URL's exact origin, `scheme://host:port` with the
/// port always written. Its path, query and fragment grant nothing.
fn exact_origin(text: &str) -> Result<String, &'static str> {
    if text.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("control characters or whitespace");
    }
    let url = Url::parse(text).map_err(|_| "not an absolute URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("not http or https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("carries credentials");
    }
    let host = url.host_str().ok_or("has no host")?;
    let port = url.port_or_known_default().ok_or("has no port")?;
    Ok(format!("{}://{host}:{port}", url.scheme()))
}

/// Whether `s` is a bare hostname (dotted labels / `localhost` / IPv4) with
/// an optional `:port` — the shape the TS validator's `HOSTNAME` grammar
/// enforces, re-stated here for what reaches native unvalidated (a dev
/// folder's manifest) before it is spliced into a header or compared.
pub(crate) fn is_bare_hostname(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (s, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    !host.is_empty()
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains('\0')
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// A credentials directory as an absolute path whose existing prefix is
/// canonical. A relative path is accepted only from the VARIABLE — the
/// launch's own working directory resolves it, as the CLI that reads the
/// same variable would; a literal or a default must be absolute or `~/`.
fn credential_dir(
    dir: &CredentialDirectory,
    names: &BTreeSet<String>,
    host: &HostEnvironment,
) -> Result<PathBuf, String> {
    let (chosen, from_env, append) = match dir {
        CredentialDirectory::Literal(literal) => (literal.clone(), false, None),
        CredentialDirectory::Env(reference) => {
            let (value, from_env) = selected(&reference.env, &reference.default, names, host)?;
            (value, from_env, reference.append.as_deref())
        }
    };
    if chosen.contains('\0') {
        return Err("CREDENTIAL_DIR_INVALID".into());
    }
    let base = if chosen.starts_with("~/") {
        PathBuf::from(expand_home_from(&chosen, host.home.as_deref()).map_err(|_| "CREDENTIAL_DIR_NO_HOME")?)
    } else if chosen.starts_with('/') {
        PathBuf::from(&chosen)
    } else if from_env && !chosen.starts_with('~') {
        host.cwd.as_ref().ok_or("CREDENTIAL_DIR_NO_CWD")?.join(&chosen)
    } else {
        return Err("CREDENTIAL_DIR_RELATIVE".into());
    };
    let mut path = base;
    if let Some(append) = append {
        if !safe_relative(append) {
            return Err("CREDENTIAL_APPEND_INVALID".into());
        }
        path.push(append);
    }
    let real = real_prefix(&path)?;
    if is_unbounded(&real, host) {
        return Err("CREDENTIAL_ROOT_UNBOUNDED".into());
    }
    Ok(real)
}

/// `path` with its longest existing prefix canonicalized and the missing
/// rest appended as written — `..` in the missing rest is refused, since
/// nothing could say where it leads.
fn real_prefix(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(real) => {
                let mut out = real;
                for part in missing.iter().rev() {
                    out.push(part);
                }
                return Ok(out);
            }
            Err(_) => {
                let Some(name) = existing.file_name().map(OsStr::to_os_string) else {
                    return Err("CREDENTIAL_DIR_INVALID".into());
                };
                if existing.components().next_back() != Some(Component::Normal(&name)) {
                    return Err("CREDENTIAL_DIR_INVALID".into());
                }
                missing.push(name);
                if !existing.pop() {
                    return Err("CREDENTIAL_DIR_INVALID".into());
                }
            }
        }
    }
}

/// The filesystem root or the whole home: a root that bounds nothing.
fn is_unbounded(path: &Path, host: &HostEnvironment) -> bool {
    if path == Path::new("/") {
        return true;
    }
    host.home.as_ref().is_some_and(|home| {
        let home = PathBuf::from(home);
        std::fs::canonicalize(&home).unwrap_or(home) == path
    })
}

/// Whether `url` may be reached under `allowed` — the one admission rule
/// for plugin HTTP and for downloads (every redirect hop of one). A literal
/// `host[:port]` matches the URL's authority as written, either scheme; an
/// origin matches scheme, host and effective port exactly. `None` admits
/// any http(s) URL — the host's own transfers, not a plugin's.
pub(crate) fn ensure_allowed_url(url: &Url, allowed: Option<&[String]>) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("unsupported URL scheme: {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a URL carrying credentials is not allowed".into());
    }
    let Some(allowed) = allowed else {
        return Ok(());
    };
    let host = url.host_str().ok_or("URL has no host")?;
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let origin = url
        .port_or_known_default()
        .map(|port| format!("{}://{host}:{port}", url.scheme()));
    let admitted = allowed.iter().any(|entry| {
        if entry.contains("://") {
            origin.as_deref().is_some_and(|origin| entry.eq_ignore_ascii_case(origin))
        } else {
            entry.eq_ignore_ascii_case(&authority)
        }
    });
    if admitted {
        Ok(())
    } else {
        Err(format!("host is not allowed: {authority}"))
    }
}

/// Whether `url`'s host is a numeric loopback address — the one place a
/// credential may travel over plain http. `localhost` is a name anything
/// can answer for, so it does not count.
pub(crate) fn is_numeric_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        _ => false,
    }
}

/// The realm's `connect-src` sources for a manifest, from the same
/// resolution as everything else: a literal domain as both schemes, an
/// env-chosen one as its exact origin. Best effort for a header — an entry
/// that does not resolve is dropped, never widened.
pub(crate) fn csp_connect_sources(manifest_json: &str, host: &HostEnvironment) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(manifest_json) else {
        return Vec::new();
    };
    let Some(capabilities) = value.get("capabilities").and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let declared: Vec<Declared> = capabilities
        .iter()
        .filter_map(|capability| serde_json::from_value(capability.clone()).ok())
        .collect();
    let names = declared_names(&declared);
    let mut sources = Vec::new();
    for capability in &declared {
        let Declared::Net { domains, .. } = capability else {
            continue;
        };
        for domain in domains {
            match allowance(domain, &names, host) {
                Ok(origin) if origin.contains("://") => sources.push(origin),
                Ok(literal) => {
                    sources.push(format!("https://{literal}"));
                    sources.push(format!("http://{literal}"));
                }
                Err(error) => log::warn!("kdplugin: a net domain left out of the CSP: {error}"),
            }
        }
    }
    sources
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host(vars: &[(&str, &str)], home: &Path, cwd: &Path) -> HostEnvironment {
        HostEnvironment {
            vars: vars
                .iter()
                .map(|(name, value)| (name.to_string(), OsString::from(value)))
                .collect(),
            home: Some(home.as_os_str().to_os_string()),
            cwd: Some(cwd.to_path_buf()),
        }
    }

    /// A fabricated home and working directory, nothing read from the
    /// machine. Canonical, so the expected paths compare as resolved ones.
    fn stand() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        let cwd = root.join("cwd");
        std::fs::create_dir_all(home.join(".tool/credentials")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        (dir, home, cwd)
    }

    fn tool_capabilities() -> Vec<serde_json::Value> {
        vec![
            json!({ "kind": "env", "names": ["TOOL_HOME", "TOOL_BASE_URL"] }),
            json!({ "kind": "net", "domains": ["127.0.0.1"] }),
            json!({
                "kind": "net",
                "domains": [
                    "api.tool.example",
                    { "env": "TOOL_BASE_URL", "default": "https://api.tool.example/v1" }
                ],
                "credentials": [{
                    "id": "tool",
                    "dir": { "env": "TOOL_HOME", "default": "~/.tool", "append": "credentials" },
                    "tokenFields": ["access_token"]
                }]
            }),
            json!({ "kind": "fs", "scope": "everywhere" }),
        ]
    }

    #[test]
    fn unset_variables_take_the_defaults() {
        let (_dir, home, cwd) = stand();
        let resolved = resolve(&tool_capabilities(), &host(&[], &home, &cwd)).unwrap();

        assert_eq!(
            resolved.env,
            BTreeMap::from([("TOOL_BASE_URL".into(), None), ("TOOL_HOME".into(), None)])
        );
        assert_eq!(resolved.net[0].allow, vec!["127.0.0.1"]);
        assert!(resolved.net[0].credentials.is_empty());
        assert_eq!(
            resolved.net[1].allow,
            vec!["api.tool.example", "https://api.tool.example:443"]
        );
        assert_eq!(
            resolved.net[1].credentials,
            vec![ResolvedCredential {
                id: "tool".into(),
                dir: home.join(".tool/credentials").to_string_lossy().into_owned(),
                token_fields: vec!["access_token".into()],
            }]
        );
    }

    #[test]
    fn set_variables_choose_the_origin_and_the_directory() {
        let (_dir, home, cwd) = stand();
        let custom = home.join("custom");
        std::fs::create_dir_all(custom.join("credentials")).unwrap();
        let env = host(
            &[
                ("TOOL_BASE_URL", "https://custom.example:8443/base?q=1"),
                ("TOOL_HOME", custom.to_str().unwrap()),
                ("UNDECLARED", "secret"),
            ],
            &home,
            &cwd,
        );

        let resolved = resolve(&tool_capabilities(), &env).unwrap();

        assert_eq!(
            resolved.net[1].allow,
            vec!["api.tool.example", "https://custom.example:8443"]
        );
        assert_eq!(
            resolved.net[1].credentials[0].dir,
            custom.join("credentials").to_string_lossy()
        );
        assert_eq!(resolved.env.get("UNDECLARED"), None, "only declared names are read");
        assert_eq!(
            resolved.env.get("TOOL_BASE_URL"),
            Some(&Some("https://custom.example:8443/base?q=1".to_string()))
        );
    }

    #[test]
    fn an_empty_variable_means_the_default_but_reads_back_empty() {
        let (_dir, home, cwd) = stand();
        let resolved = resolve(
            &tool_capabilities(),
            &host(&[("TOOL_HOME", ""), ("TOOL_BASE_URL", "")], &home, &cwd),
        )
        .unwrap();
        assert_eq!(resolved.env.get("TOOL_HOME"), Some(&Some(String::new())));
        assert_eq!(resolved.net[1].allow[1], "https://api.tool.example:443");
        assert!(resolved.net[1].credentials[0].dir.ends_with(".tool/credentials"));
    }

    #[test]
    fn a_relative_variable_resolves_against_the_launch_directory_and_a_missing_dir_is_still_a_grant() {
        let (_dir, home, cwd) = stand();
        let resolved = resolve(&tool_capabilities(), &host(&[("TOOL_HOME", "rel/tool")], &home, &cwd)).unwrap();
        assert_eq!(
            resolved.net[1].credentials[0].dir,
            cwd.join("rel/tool/credentials").to_string_lossy()
        );
    }

    #[test]
    fn a_reference_to_an_undeclared_variable_is_refused() {
        let (_dir, home, cwd) = stand();
        let capabilities = vec![json!({
            "kind": "net",
            "domains": [{ "env": "OTHER", "default": "https://a.example" }]
        })];
        let error = resolve(&capabilities, &host(&[("OTHER", "https://evil.example")], &home, &cwd)).unwrap_err();
        assert_eq!(error, "ENV_REFERENCE_UNDECLARED at OTHER");
    }

    #[test]
    fn a_bad_variable_fails_closed_and_never_prints_its_value() {
        let (_dir, home, cwd) = stand();
        for bad in ["ftp://x.example", "https://user:pw@x.example", "not a url", "https://x.example\r\n"] {
            let error = resolve(&tool_capabilities(), &host(&[("TOOL_BASE_URL", bad)], &home, &cwd)).unwrap_err();
            assert!(error.starts_with("ENV_VALUE_INVALID at TOOL_BASE_URL"), "{error}");
            assert!(!error.contains("x.example") && !error.contains("pw"), "{error}");
        }
        let long = "a".repeat(MAX_ENV_VALUE_BYTES + 1);
        let error = resolve(&tool_capabilities(), &host(&[("TOOL_HOME", &long)], &home, &cwd)).unwrap_err();
        assert!(error.contains("longer than 64 KiB"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_value_that_is_not_utf8_is_an_error_not_a_fallback() {
        use std::os::unix::ffi::OsStringExt;
        let (_dir, home, cwd) = stand();
        let mut env = host(&[], &home, &cwd);
        env.vars.insert("TOOL_HOME".into(), OsString::from_vec(vec![0xff, 0xfe]));
        let error = resolve(&tool_capabilities(), &env).unwrap_err();
        assert_eq!(error, "ENV_VALUE_INVALID at TOOL_HOME: not UTF-8");
    }

    #[test]
    fn a_credentials_root_that_bounds_nothing_is_refused_however_it_is_spelled() {
        let (_dir, home, cwd) = stand();
        let capabilities = |dir: serde_json::Value| {
            vec![
                json!({ "kind": "env", "names": ["TOOL_HOME"] }),
                json!({ "kind": "net", "domains": ["a.example"], "credentials": [{ "id": "t", "dir": dir, "tokenFields": ["t"] }] }),
            ]
        };
        let home_text = home.to_str().unwrap();
        for (dir, vars) in [
            (json!("/"), vec![]),
            (json!("~/"), vec![]),
            (json!({ "env": "TOOL_HOME", "default": "~/.tool" }), vec![("TOOL_HOME", home_text)]),
            (json!({ "env": "TOOL_HOME", "default": "~/.tool" }), vec![("TOOL_HOME", "/")]),
        ] {
            let error = resolve(&capabilities(dir.clone()), &host(&vars, &home, &cwd)).unwrap_err();
            assert!(error.contains("CREDENTIAL_ROOT_UNBOUNDED"), "{dir}: {error}");
        }
        // A home reached through `..` is the same home.
        let dotted = format!("{home_text}/.tool/..");
        let error = resolve(
            &capabilities(json!({ "env": "TOOL_HOME", "default": "~/.tool" })),
            &host(&[("TOOL_HOME", &dotted)], &home, &cwd),
        )
        .unwrap_err();
        assert!(error.contains("CREDENTIAL_ROOT_UNBOUNDED"), "{error}");
    }

    #[test]
    fn a_literal_or_default_directory_must_be_absolute_and_an_append_must_stay_inside() {
        let (_dir, home, cwd) = stand();
        let with = |dir: serde_json::Value| {
            vec![
                json!({ "kind": "env", "names": ["TOOL_HOME"] }),
                json!({ "kind": "net", "domains": ["a.example"], "credentials": [{ "id": "t", "dir": dir, "tokenFields": ["t"] }] }),
            ]
        };
        let env = host(&[], &home, &cwd);
        assert!(resolve(&with(json!("relative/dir")), &env).unwrap_err().contains("RELATIVE"));
        assert!(resolve(&with(json!({ "env": "TOOL_HOME", "default": "rel" })), &env)
            .unwrap_err()
            .contains("RELATIVE"));
        for append in ["../x", "/abs", "a//b", "a\\b", ""] {
            let error = resolve(
                &with(json!({ "env": "TOOL_HOME", "default": "~/.tool", "append": append })),
                &env,
            )
            .unwrap_err();
            assert!(error.contains("APPEND_INVALID"), "{append}: {error}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_is_granted_as_its_real_target() {
        let (_dir, home, cwd) = stand();
        let real = home.join("real-tool");
        std::fs::create_dir_all(real.join("credentials")).unwrap();
        std::os::unix::fs::symlink(&real, home.join("link-tool")).unwrap();
        let resolved = resolve(
            &tool_capabilities(),
            &host(&[("TOOL_HOME", home.join("link-tool").to_str().unwrap())], &home, &cwd),
        )
        .unwrap();
        assert_eq!(resolved.net[1].credentials[0].dir, real.join("credentials").to_string_lossy());
    }

    #[test]
    fn a_credential_id_is_unique_across_the_plugin() {
        let (_dir, home, cwd) = stand();
        let entry = json!({ "kind": "net", "domains": ["a.example"], "credentials": [{ "id": "t", "dir": "~/.tool", "tokenFields": ["t"] }] });
        let error = resolve(&[entry.clone(), entry], &host(&[], &home, &cwd)).unwrap_err();
        assert_eq!(error, "CREDENTIAL_ID_DUPLICATE at t");
    }

    #[test]
    fn an_allowance_admits_its_exact_origin_or_literal_authority_only() {
        let allowed = vec!["api.tool.example".to_string(), "https://custom.example:8443".to_string()];
        let admit = |url: &str| ensure_allowed_url(&Url::parse(url).unwrap(), Some(&allowed));
        assert!(admit("https://api.tool.example/x").is_ok());
        assert!(admit("http://api.tool.example/x").is_ok(), "a literal keeps both schemes");
        assert!(admit("https://custom.example:8443/other/path?q").is_ok());
        for refused in [
            "https://custom.example:8444/",
            "http://custom.example:8443/",
            "https://custom.example/",
            "https://custom.example.evil:8443/",
            "https://api.tool.example:8443/",
            "https://user@api.tool.example/",
            "file:///etc/passwd",
        ] {
            assert!(admit(refused).is_err(), "{refused}");
        }
        assert!(ensure_allowed_url(&Url::parse("https://any.example").unwrap(), None).is_ok());
    }

    #[test]
    fn only_a_numeric_loopback_counts_as_loopback() {
        for (url, loopback) in [
            ("http://127.0.0.1:1/", true),
            ("http://127.9.9.9/", true),
            ("http://[::1]:8/", true),
            ("http://localhost/", false),
            ("http://10.0.0.1/", false),
        ] {
            assert_eq!(is_numeric_loopback(&Url::parse(url).unwrap()), loopback, "{url}");
        }
    }

    #[test]
    fn the_csp_takes_literals_as_both_schemes_and_env_choices_as_exact_origins() {
        let (_dir, home, cwd) = stand();
        let manifest = json!({ "capabilities": tool_capabilities() }).to_string();
        let sources = csp_connect_sources(
            &manifest,
            &host(&[("TOOL_BASE_URL", "https://[::1]:9443/x")], &home, &cwd),
        );
        assert_eq!(
            sources,
            vec![
                "https://127.0.0.1",
                "http://127.0.0.1",
                "https://api.tool.example",
                "http://api.tool.example",
                "https://[::1]:9443",
            ]
        );
    }

    #[test]
    fn the_csp_drops_what_does_not_resolve_and_never_widens() {
        let (_dir, home, cwd) = stand();
        let manifest = json!({ "capabilities": [
            { "kind": "net", "domains": [
                "a.example; frame-src *",
                "evil\r\nX: 1",
                { "env": "UNDECLARED", "default": "https://x.example" },
                "ok.example"
            ] }
        ] })
        .to_string();
        assert_eq!(
            csp_connect_sources(&manifest, &host(&[], &home, &cwd)),
            vec!["https://ok.example", "http://ok.example"]
        );
    }
}
