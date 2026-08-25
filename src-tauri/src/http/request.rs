//! Reading one request head, bounded.
//!
//! The bounds are the point. A local surface still faces whatever the
//! machine's other processes send it, and every limit here answers a way a
//! peer can cost us something without asking politely: a head that never
//! ends, a line that never breaks, a peer that connects and then stalls.
//!
//! The QUERY is handed back raw. Its meaning belongs to whoever registered
//! the route — the version pin the artifacts surface reads is its own
//! vocabulary, and parsing it here would put a consumer's dialect in the
//! shared parser.

use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::time::Duration;

/// The whole head, not one line: a peer can spread bytes across many
/// headers as easily as one long line.
pub(crate) const HEAD_CAP: usize = 8 * 1024;
pub(crate) const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Write bound for every socket op (set once at accept; inherited by
/// clones) — a stalled peer errors instead of pinning a thread forever.
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct Request {
    pub(crate) path: String,
    /// Everything after `?`, undecoded and uninterpreted. Absent when the
    /// target carried none; present-but-empty when it ended in a bare `?`.
    pub(crate) query: Option<String>,
}

/// Read one request head. `Err(status)` is the status to answer with — the
/// caller writes it, because only the caller knows whether it also wants to
/// say anything else first.
pub(crate) fn read_request(stream: &mut TcpStream) -> Result<Request, u16> {
    let Ok(()) = stream.set_read_timeout(Some(HEAD_TIMEOUT)) else {
        return Err(400);
    };
    // SO_SNDTIMEO here, on the ACCEPTED socket: socket options are
    // inherited by every try_clone (the mechanism the SSE path already
    // relies on) — one set covers the head read, every body write, and
    // any stored subscriber clone.
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let cloned = match stream.try_clone() {
        Ok(c) => c,
        Err(_) => return Err(400),
    };
    // Bounded from the FIRST byte: read_line buffers an entire line
    // before any cap check, so a peer streaming bytes with no newline
    // would grow memory unbounded — Take enforces the cap DURING the
    // read, not after it.
    let mut reader = BufReader::new(cloned.take(HEAD_CAP as u64 + 1));
    let mut request_line = String::new();
    match reader.read_line(&mut request_line) {
        Ok(0) => return Err(400),
        Ok(_) => {}
        Err(_) => return Err(400),
    }
    if request_line.len() > HEAD_CAP {
        return Err(431);
    }
    // Drain the rest of the head (bounded): we never read a body.
    let mut total = request_line.len();
    let mut header = String::new();
    loop {
        header.clear();
        match reader.read_line(&mut header) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if total > HEAD_CAP {
                    return Err(431);
                }
                if header == "\r\n" || header == "\n" {
                    break;
                }
            }
            Err(_) => return Err(400),
        }
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        return Err(405);
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q.to_string())),
        None => (target, None),
    };
    Ok(Request {
        path: percent_decode(path),
        query,
    })
}

/// Decode BEFORE the caller splits on `/`: a `%2f` becomes a separator, so
/// encoding cannot smuggle extra structure INTO a segment — routes only
/// match literal shapes.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn percent_decoding_turns_an_encoded_slash_into_a_separator() {
        // The whole reason decoding happens before the split: a segment
        // cannot hide structure behind an escape.
        assert_eq!(percent_decode("/a/tok%2fslug"), "/a/tok/slug");
    }

    #[test]
    fn a_truncated_or_invalid_escape_survives_verbatim() {
        assert_eq!(percent_decode("/a/100%"), "/a/100%");
        assert_eq!(percent_decode("/a/%zz"), "/a/%zz");
    }
}
