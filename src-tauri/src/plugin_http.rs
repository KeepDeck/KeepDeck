//! One bounded GET on a plugin's behalf (`services.http`).
//!
//! The plugin gate hands over the reach the plugin's declaration resolved to
//! (`plugin_permissions`) and, for a signed request, the credential source's
//! frozen directory and fields; the plugin names only the URL and a file. A
//! caller cannot exceed that shape: the URL is admitted against the reach
//! before anything is read or dialled, the token is read confined to its
//! directory and goes nowhere but the `Authorization` header of this one
//! request — over https, or plain http to a numeric loopback address — and
//! no redirect is followed and no proxy is used, so it cannot be carried
//! further than the origin that was admitted.

use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use url::Url;

use crate::containment::read_confined_token;
use crate::plugin_permissions::{ensure_allowed_url, is_numeric_loopback};

const TIMEOUT: Duration = Duration::from_secs(10);
/// The most of a body handed back; past it the answer says `truncated`.
const MAX_BODY_BYTES: u64 = 1024 * 1024;

/// A credential source as resolved: where its tokens live, and which JSON
/// fields hold one, in order.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSpec {
    dir: String,
    file: String,
    token_fields: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpAnswer {
    /// Any status is an answer — a 401 is data, not a failure.
    status: u16,
    body: String,
    truncated: bool,
    /// Unix ms just before the request went out.
    sent_at: u64,
}

#[tauri::command(async)]
pub async fn plugin_http_get(
    allowed: Vec<String>,
    url: String,
    credential: Option<CredentialSpec>,
    accept: Option<String>,
) -> Result<HttpAnswer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get(&allowed, &url, credential.as_ref(), accept.as_deref(), TIMEOUT)
    })
    .await
    .map_err(|error| format!("http task failed: {error}"))?
}

/// What an error may say about a URL: never its query, which can carry a
/// secret of its own.
fn shown(url: &Url) -> String {
    format!("{}{}", url.origin().ascii_serialization(), url.path())
}

fn get(
    allowed: &[String],
    url: &str,
    credential: Option<&CredentialSpec>,
    accept: Option<&str>,
    timeout: Duration,
) -> Result<HttpAnswer, String> {
    let url = Url::parse(url).map_err(|_| "HTTP_URL_INVALID".to_string())?;
    ensure_allowed_url(&url, Some(allowed)).map_err(|why| format!("HTTP_ORIGIN_NOT_ALLOWED: {why}"))?;
    let authorization = match credential {
        None => None,
        Some(credential) => {
            if url.scheme() != "https" && !is_numeric_loopback(&url) {
                return Err(format!("HTTP_CREDENTIAL_NEEDS_HTTPS: {}", shown(&url)));
            }
            let token = read_confined_token(
                &PathBuf::from(&credential.dir),
                &credential.file,
                &credential.token_fields,
            )?;
            Some(token.bearer())
        }
    };
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(timeout)
        .try_proxy_from_env(false)
        .build();
    let mut request = agent
        .request_url("GET", &url)
        .set("Accept", accept.unwrap_or("application/json"));
    if let Some(authorization) = &authorization {
        request = request.set("Authorization", authorization);
    }
    let sent_at = unix_time_ms();
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(error)) => {
            return Err(format!("HTTP_TRANSPORT {}: {}", shown(&url), error.kind()));
        }
    };
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_BODY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("HTTP_BODY_UNREADABLE {}: {}", shown(&url), error.kind()))?;
    let truncated = bytes.len() as u64 > MAX_BODY_BYTES;
    bytes.truncate(MAX_BODY_BYTES as usize);
    Ok(HttpAnswer {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        sent_at,
    })
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// A one-request HTTP server on 127.0.0.1: answers `response` and
    /// reports the request head it saw — or nothing, when no one connected.
    fn serve_once(response: Vec<u8>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, heads) = mpsc::channel();
        listener.set_nonblocking(false).unwrap();
        thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let _ = seen.send(head);
            let mut stream = stream;
            let _ = stream.write_all(&response);
        });
        (format!("127.0.0.1:{port}"), heads)
    }

    fn ok(body: &str) -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }

    /// A credentials directory holding one token, canonical as the resolver
    /// would hand it over.
    fn credential(token: &str) -> (tempfile::TempDir, CredentialSpec) {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(real.join("t.json"), format!(r#"{{"access_token":"{token}"}}"#)).unwrap();
        let spec = CredentialSpec {
            dir: real.to_string_lossy().into_owned(),
            file: "t.json".into(),
            token_fields: vec!["access_token".into()],
        };
        (dir, spec)
    }

    #[test]
    fn signs_an_allowed_request_and_hands_back_the_body_without_the_token() {
        let (authority, heads) = serve_once(ok(r#"{"usage":1}"#));
        let (_dir, spec) = credential("sentinel-token");

        let answer = get(
            std::slice::from_ref(&authority),
            &format!("http://{authority}/usages"),
            Some(&spec),
            None,
            TIMEOUT,
        )
        .unwrap();

        assert_eq!((answer.status, answer.body.as_str(), answer.truncated), (200, r#"{"usage":1}"#, false));
        assert!(answer.sent_at > 0);
        let head = heads.recv().unwrap();
        assert!(head.contains("Authorization: Bearer sentinel-token"), "{head}");
        assert!(head.contains("Accept: application/json"), "{head}");
        assert!(!format!("{answer:?}").contains("sentinel-token"));
    }

    #[test]
    fn a_host_outside_the_reach_is_refused_before_any_connection() {
        let (authority, heads) = serve_once(ok("{}"));
        let (_dir, spec) = credential("sentinel-token");
        for url in [
            format!("http://{authority}/"),
            format!("https://{authority}/"),
            format!("http://user@{authority}/"),
        ] {
            let error = get(&["127.0.0.1:1".into()], &url, Some(&spec), None, TIMEOUT).unwrap_err();
            assert!(error.starts_with("HTTP_ORIGIN_NOT_ALLOWED"), "{url}: {error}");
        }
        assert!(heads.recv_timeout(Duration::from_millis(200)).is_err(), "nothing connected");
    }

    #[test]
    fn a_redirect_is_returned_not_followed() {
        let (target, target_heads) = serve_once(ok("{}"));
        let redirect = format!(
            "HTTP/1.1 302 Found\r\nlocation: http://{target}/stolen\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let (authority, _heads) = serve_once(redirect.into_bytes());
        let (_dir, spec) = credential("sentinel-token");

        let answer = get(
            &[authority.clone(), target],
            &format!("http://{authority}/"),
            Some(&spec),
            None,
            TIMEOUT,
        )
        .unwrap();

        assert_eq!(answer.status, 302);
        assert!(target_heads.recv_timeout(Duration::from_millis(200)).is_err(), "the target saw nothing");
    }

    #[test]
    fn an_error_status_is_an_answer() {
        let (authority, _heads) = serve_once(
            b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope".to_vec(),
        );
        let answer = get(std::slice::from_ref(&authority), &format!("http://{authority}/"), None, None, TIMEOUT).unwrap();
        assert_eq!((answer.status, answer.body.as_str()), (401, "nope"));
    }

    #[test]
    fn a_body_past_the_cap_comes_back_truncated() {
        let body = "x".repeat(MAX_BODY_BYTES as usize + 10);
        let (authority, _heads) = serve_once(ok(&body));
        let answer = get(std::slice::from_ref(&authority), &format!("http://{authority}/"), None, None, TIMEOUT).unwrap();
        assert!(answer.truncated);
        assert_eq!(answer.body.len() as u64, MAX_BODY_BYTES);
    }

    #[test]
    fn a_credential_never_rides_plain_http_off_loopback() {
        let (_dir, spec) = credential("sentinel-token");
        for url in ["http://api.example/", "http://localhost:9/"] {
            let allowed = vec!["api.example".to_string(), "localhost:9".to_string()];
            let error = get(&allowed, url, Some(&spec), None, TIMEOUT).unwrap_err();
            assert!(error.starts_with("HTTP_CREDENTIAL_NEEDS_HTTPS"), "{url}: {error}");
        }
    }

    #[test]
    fn a_timeout_is_an_error_and_errors_never_show_a_query() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let _hold = thread::spawn(move || {
            let _connection = listener.accept();
            thread::sleep(Duration::from_secs(2));
        });
        let error = get(
            std::slice::from_ref(&authority),
            &format!("http://{authority}/x?secret=1"),
            None,
            None,
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(error.starts_with("HTTP_TRANSPORT"), "{error}");
        assert!(!error.contains("secret"), "{error}");
    }
}
