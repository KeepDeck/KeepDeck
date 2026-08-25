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
//!
//! So is the METHOD — reported, never judged. GET-only is a rule the
//! artifacts surface keeps for its own reasons; the bridge takes envelopes
//! by POST. A parser that refused anything but GET would be one surface's
//! policy sitting in everyone's path.

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

/// The methods this HTTP speaks, as a closed set.
///
/// Closed with no escape hatch: anything else is refused by the parser
/// before a surface sees it. Carrying an unknown token through would leave
/// every surface to decide about a method nobody designed for, and the first
/// one to forget would have undefined behaviour rather than a refusal.
///
/// This is vocabulary, not policy. WHICH of these a surface accepts stays
/// its own rule — artifacts answers reads only, the bridge takes envelopes
/// — and both refuse in their own words, for their own reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Method {
    Get,
    Post,
}

impl Method {
    fn parse(token: &str) -> Option<Self> {
        match token {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            _ => None,
        }
    }
}

/// How much body a surface will take. Zero means it takes none — a request
/// that carries one is refused rather than silently truncated, because a
/// half-read envelope is worse than a rejected one.
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) max_body: usize,
}

impl Limits {
    /// For a surface that only ever answers reads.
    pub(crate) const NO_BODY: Self = Self { max_body: 0 };
}

pub(crate) struct Request {
    pub(crate) method: Method,
    pub(crate) path: String,
    /// Everything after `?`, undecoded and uninterpreted. Absent when the
    /// target carried none; present-but-empty when it ended in a bare `?`.
    pub(crate) query: Option<String>,
    /// Empty unless the surface allowed a body and the peer sent one.
    pub(crate) body: Vec<u8>,
}

/// Read one request head. `Err(status)` is the status to answer with — the
/// caller writes it, because only the caller knows whether it also wants to
/// say anything else first.
pub(crate) fn read_request(stream: &mut TcpStream, limits: Limits) -> Result<Request, u16> {
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
    // Drain the rest of the head (bounded), noting the one header a body
    // depends on. Nothing else is kept: a header this parser remembered
    // would be a header every surface then had to reason about.
    let mut total = request_line.len();
    let mut header = String::new();
    let mut declared_len: Option<usize> = None;
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
                if let Some((name, value)) = header.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("content-length") {
                        // Unparseable is refused, not treated as absent: a
                        // length nobody can read is a body nobody can frame.
                        let Ok(len) = value.trim().parse::<usize>() else {
                            return Err(400);
                        };
                        declared_len = Some(len);
                    }
                }
            }
            Err(_) => return Err(400),
        }
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method.is_empty() || target.is_empty() {
        return Err(400);
    }
    // Refused here, once: a method this layer does not speak never reaches a
    // route table, so no surface can be the one that forgot about it.
    let Some(method) = Method::parse(method) else {
        return Err(405);
    };
    let body = match declared_len {
        None | Some(0) => Vec::new(),
        Some(len) => {
            if len > limits.max_body {
                return Err(413);
            }
            // The head cap was a cap on the WHOLE stream — `Take` does not
            // know where a head ends. Without lifting it here the body read
            // would stop at the head's remaining allowance and report a
            // short read as a malformed request.
            reader.get_mut().set_limit(len as u64);
            let mut body = vec![0u8; len];
            if reader.read_exact(&mut body).is_err() {
                return Err(400);
            }
            body
        }
    };
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q.to_string())),
        None => (target, None),
    };
    Ok(Request {
        method,
        path: percent_decode(path),
        query,
        body,
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
    use super::{percent_decode, read_request, Limits, Method};
    use std::io::Write as _;
    use std::net::{TcpListener, TcpStream};

    /// Send one request and read it back the way the accept loop would.
    fn round_trip(head: &str, body: &[u8], limits: Limits) -> Result<super::Request, u16> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let sent = body.to_vec();
        let head = head.to_string();
        let writer = std::thread::spawn(move || {
            let mut peer = TcpStream::connect(("127.0.0.1", port)).unwrap();
            peer.write_all(head.as_bytes()).unwrap();
            peer.write_all(&sent).unwrap();
            peer.flush().unwrap();
            // Hold the connection open: a dropped peer would race the read.
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        let (mut accepted, _) = listener.accept().unwrap();
        let result = read_request(&mut accepted, limits);
        let _ = writer.join();
        result
    }

    #[test]
    fn a_body_larger_than_the_head_cap_still_arrives_whole() {
        // The regression this pins: the head cap was a cap on the WHOLE
        // stream, so a body past 8 KiB read short and looked malformed.
        let body = vec![b'x'; 32 * 1024];
        let head = format!(
            "POST /bridge/envelope HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let request = round_trip(&head, &body, Limits { max_body: 256 * 1024 })
            .expect("a body inside the limit must parse");
        assert_eq!(request.method, Method::Post);
        assert_eq!(request.path, "/bridge/envelope");
        assert_eq!(request.body.len(), body.len());
        assert!(request.body.iter().all(|b| *b == b'x'));
    }

    #[test]
    fn a_body_over_the_limit_is_refused_before_it_is_read() {
        let head = "POST /bridge/envelope HTTP/1.1\r\nHost: x\r\nContent-Length: 4096\r\n\r\n";
        assert_eq!(
            round_trip(head, &vec![b'x'; 4096], Limits { max_body: 1024 }).err(),
            Some(413)
        );
    }

    #[test]
    fn a_surface_that_takes_no_body_refuses_one() {
        let head = "POST /a/tok/slug HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\n";
        assert_eq!(round_trip(head, b"x", Limits::NO_BODY).err(), Some(413));
    }

    #[test]
    fn a_content_length_that_is_not_a_number_is_refused() {
        // Not treated as absent: a length nobody can read frames nothing.
        let head = "POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: many\r\n\r\n";
        assert_eq!(round_trip(head, b"", Limits { max_body: 16 }).err(), Some(400));
    }

    #[test]
    fn a_method_this_layer_does_not_speak_never_reaches_a_surface() {
        // Not carried through as an unknown: the first surface to forget
        // about it would have undefined behaviour instead of a refusal.
        let head = "DELETE /x HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(round_trip(head, b"", Limits::NO_BODY).err(), Some(405));
    }

    #[test]
    fn the_methods_it_does_speak_arrive_typed() {
        let get = round_trip("GET /x HTTP/1.1\r\nHost: x\r\n\r\n", b"", Limits::NO_BODY)
            .expect("GET is spoken here");
        assert_eq!(get.method, Method::Get);
    }


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
