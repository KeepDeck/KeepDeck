//! Writing one response.
//!
//! Two shapes, and they differ in a way that matters on the wire: an error
//! carries no `Content-Type` at all, while a body carries exactly the one
//! its route chose. They were two separate writers in two files before this
//! module existed — same head assembly, drifting reason strings — so what is
//! shared here is the reason table and the framing, not the shapes.
//!
//! `Connection: close` on both, unconditionally: one request per connection
//! is the contract the accept loop is written against.

use std::io::Write;
use std::net::TcpStream;

/// Every status this HTTP can answer with, as a closed set.
///
/// Closed for the same reason the method is: a bare number is a number
/// somebody eventually writes without a reason phrase to match, and the
/// catch-all arm that used to cover them answered "Error" to anything it did
/// not recognise. There is no catch-all now — a status that needs adding is
/// added here, and the compiler finds every place that has to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Ok,
    /// Accepted, with nothing to say back.
    NoContent,
    BadRequest,
    NotFound,
    MethodNotAllowed,
    /// Somebody is already asking this exact question and has not been
    /// answered yet.
    Conflict,
    /// A declared body larger than the surface takes.
    PayloadTooLarge,
    HeadersTooLarge,
    /// The deck did not answer a question in time. Distinct from an empty
    /// answer on purpose: empty loses nothing, this may have lost mail.
    GatewayTimeout,
}

impl Status {
    fn code(self) -> u16 {
        match self {
            Self::Ok => 200,
            Self::NoContent => 204,
            Self::BadRequest => 400,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::Conflict => 409,
            Self::PayloadTooLarge => 413,
            Self::HeadersTooLarge => 431,
            Self::GatewayTimeout => 504,
        }
    }

    /// One table, exhaustive. The two writers this module replaced disagreed
    /// about 200 — one said "OK", the other's default arm said "Error".
    fn reason(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::NoContent => "No Content",
            Self::BadRequest => "Bad Request",
            Self::NotFound => "Not Found",
            Self::MethodNotAllowed => "Method Not Allowed",
            Self::Conflict => "Conflict",
            Self::PayloadTooLarge => "Payload Too Large",
            Self::HeadersTooLarge => "Request Header Fields Too Large",
            Self::GatewayTimeout => "Gateway Timeout",
        }
    }
}

/// A status and nothing else. No `Content-Type`: there is no content, and
/// naming a type for an empty body invites a consumer to sniff one.
pub(crate) fn respond_empty(stream: &mut TcpStream, status: Status) -> std::io::Result<()> {
    stream.write_all(
        format!(
            "HTTP/1.1 {} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            status.code(),
            status.reason()
        )
        .as_bytes(),
    )?;
    stream.flush()
}

/// A body with its declared type, plus whatever headers the route adds.
/// The route owns the MIME and the extra headers — this writer never
/// invents either, because a MIME chosen here would be a MIME chosen for
/// every consumer at once.
pub(crate) fn respond_with_body(
    stream: &mut TcpStream,
    status: Status,
    mime: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n",
        status.code(),
        status.reason(),
        body.len()
    );
    for (name, value) in headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::Status;

    #[test]
    fn every_status_carries_a_phrase_and_a_code() {
        // The drift this table ended: 200 read "OK" from one writer and
        // "Error" from the other's default arm. There is no default arm now.
        for status in [
            Status::Ok,
            Status::NoContent,
            Status::BadRequest,
            Status::NotFound,
            Status::MethodNotAllowed,
            Status::Conflict,
            Status::PayloadTooLarge,
            Status::HeadersTooLarge,
            Status::GatewayTimeout,
        ] {
            assert!(!status.reason().is_empty(), "{status:?}");
            assert!((200..=599).contains(&status.code()), "{status:?}");
        }
        assert_eq!(Status::Ok.reason(), "OK");
        assert_eq!(Status::NoContent.code(), 204);
    }
}
