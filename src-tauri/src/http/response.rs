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

/// The reason phrase for a status. Kept in ONE place because the two
//  writers used to disagree: the empty one spelled four statuses out and
/// the body one answered "Error" to everything but 200.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    }
}

/// A status and nothing else. No `Content-Type`: there is no content, and
/// naming a type for an empty body invites a consumer to sniff one.
pub(crate) fn respond_empty(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    stream.write_all(
        format!(
            "HTTP/1.1 {status} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            reason(status)
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
    status: u16,
    mime: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n",
        reason(status),
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
    use super::reason;

    #[test]
    fn the_reason_table_covers_every_status_both_writers_used() {
        // The drift this table exists to end: 200 read "OK" from one
        // writer and "Error" from the other's default arm.
        assert_eq!(reason(200), "OK");
        assert_eq!(reason(400), "Bad Request");
        assert_eq!(reason(404), "Not Found");
        assert_eq!(reason(405), "Method Not Allowed");
        assert_eq!(reason(431), "Request Header Fields Too Large");
    }

    #[test]
    fn an_unlisted_status_still_gets_a_phrase() {
        assert_eq!(reason(418), "Error");
    }
}
