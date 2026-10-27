//! Scope containment for plugin services that touch the user's project tree.
//!
//! A capability's scope (`workspace` vs `everywhere`) is resolved by the HOST
//! into a concrete list of allowed roots and passed in with every call; the
//! command's job is to prove the requested path really sits inside one of them.
//! [`resolve_within`] is that proof, shared by every project-facing service
//! backend (`project_fs`, `project_git`) so the escape analysis exists once.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

/// The user's home as the environment names it — the ONE place this module
/// reads the process's environment. The rules below take the home as a
/// value, so a test hands one in and depends on nothing the machine has.
fn home_dir() -> Option<OsString> {
    std::env::var_os("HOME")
}

/// Expand a leading `~/` to the user's home directory — THE home expansion
/// for every containment-adjacent path (three separate copies drifted once;
/// this is the single one). Lossy on a non-UTF-8 home, documented: every
/// caller ultimately round-trips through UTF-8 command payloads anyway.
pub fn expand_home(path: &str) -> Result<String, String> {
    expand_home_from(path, home_dir().as_deref())
}

/// [`expand_home`] against a given home — the rule itself.
pub fn expand_home_from(path: &str, home: Option<&OsStr>) -> Result<String, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = home.ok_or("no home directory")?;
        return Ok(format!("{}/{rest}", home.to_string_lossy()));
    }
    Ok(path.to_string())
}

/// A root that bounds nothing: the filesystem root, or the user's whole
/// home. The manifest guard rejects the literal spellings ("/", "~/"), but a
/// spelling like "~/../.." canonicalizes to the same place, and no denylist
/// of spellings can enumerate those — so the PROOF refuses such a root as
/// authority, on the canonical form it already computes. This is the
/// semantic half of the same rule; the parse guard remains the loud,
/// author-facing half.
pub fn is_unbounded_root(root: &Path) -> bool {
    if root == Path::new("/") {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let home = fs::canonicalize(&home).unwrap_or(home);
        if root == home {
            return true;
        }
    }
    false
}

/// Canonicalize `path` and require the result to sit inside one of `roots`
/// (each canonicalized too), unless `everywhere` waives the check. Returns the
/// canonical path on success, or a human reason on rejection.
///
/// A leading `~/` is expanded first ([`expand_home`]), HERE rather than by
/// each caller: the fs backend expanded it and the git backend did not, so
/// the "identical scope contract" the two promise held for one spelling of
/// a path and not the other. Every backend that resolves through this gets
/// the same reading of the same string.
///
/// Doing the containment test on the CANONICAL form is what catches every
/// escape at once — `..` walks, absolute-path smuggling, and a symlink whose
/// real target is outside — because all three resolve to a real location
/// before the `starts_with`. A root that can't be canonicalized (gone, or
/// never existed) simply doesn't authorize anything; if none matches, the path
/// is refused.
pub fn resolve_within(path: &str, roots: &[String], everywhere: bool) -> Result<PathBuf, String> {
    resolve_within_from(path, roots, everywhere, home_dir().as_deref())
}

/// [`resolve_within`] against a given home — the proof itself.
pub fn resolve_within_from(
    path: &str,
    roots: &[String],
    everywhere: bool,
    home: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let expanded = expand_home_from(path, home)?;
    let canonical = fs::canonicalize(&expanded).map_err(|_| format!("no such path: {path}"))?;
    if everywhere {
        return Ok(canonical);
    }
    let contained = roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| canonical.starts_with(&root));
    if contained {
        Ok(canonical)
    } else {
        Err(format!("path is outside the allowed workspace roots: {path}"))
    }
}

/// A token read on a plugin's behalf. Neither printable nor serializable:
/// it leaves this process only as the `Authorization` header it was read for.
pub struct SecretToken(String);

impl SecretToken {
    pub fn bearer(&self) -> String {
        format!("Bearer {}", self.0)
    }
}

/// A token file larger than this is not a token file.
const MAX_TOKEN_FILE_BYTES: u64 = 64 * 1024;

/// Read the first non-empty string among `fields` of the JSON file `file`
/// directly inside `dir` — and nowhere else.
///
/// `dir` is an absolute path the host resolved and froze; `file` is one
/// plain name. The walk opens every directory of `dir` from the root with
/// no-follow and reads the file through the last directory's descriptor
/// with no-follow too, checking what it opened, not a path it looked at
/// first: a symlink anywhere on the way — the file itself included, even
/// one pointing inside — is refused, and nothing can be swapped between a
/// check and the open, because there is no separate check.
#[cfg(unix)]
pub fn read_confined_token(dir: &Path, file: &str, fields: &[String]) -> Result<SecretToken, String> {
    use std::fs::File;
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    if file.is_empty()
        || file.starts_with('.')
        || file.contains('/')
        || file.contains('\\')
        || file.contains('\0')
    {
        return Err("CREDENTIAL_FILE_REFUSED: not a plain file name".into());
    }
    if !dir.is_absolute() {
        return Err("CREDENTIAL_DIR_INVALID".into());
    }
    let open_at = |parent: Option<&OwnedFd>, name: &OsStr, flags: libc::c_int| -> Result<OwnedFd, String> {
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| "CREDENTIAL_DIR_INVALID")?;
        let at = parent.map_or(libc::AT_FDCWD, AsRawFd::as_raw_fd);
        // SAFETY: `name` is a valid C string and `at` a live descriptor (or
        // AT_FDCWD); the returned descriptor is owned right below.
        let fd = unsafe { libc::openat(at, name.as_ptr(), flags | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err("CREDENTIAL_UNREADABLE".into());
        }
        // SAFETY: openat returned a fresh descriptor nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    };
    let mut current = open_at(None, OsStr::new("/"), libc::O_RDONLY | libc::O_DIRECTORY)?;
    for component in dir.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                current = open_at(
                    Some(&current),
                    name,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                )?;
            }
            _ => return Err("CREDENTIAL_DIR_INVALID".into()),
        }
    }
    let fd = open_at(
        Some(&current),
        OsStr::new(file),
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK,
    )?;
    let mut opened = File::from(fd);
    let meta = opened.metadata().map_err(|_| "CREDENTIAL_UNREADABLE")?;
    if !meta.file_type().is_file() {
        return Err("CREDENTIAL_FILE_REFUSED: not a regular file".into());
    }
    let mut bytes = Vec::new();
    (&mut opened)
        .take(MAX_TOKEN_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "CREDENTIAL_UNREADABLE")?;
    if bytes.len() as u64 > MAX_TOKEN_FILE_BYTES {
        return Err("CREDENTIAL_FILE_REFUSED: larger than 64 KiB".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "CREDENTIAL_FILE_REFUSED: not JSON")?;
    fields
        .iter()
        .find_map(|field| value.get(field).and_then(|v| v.as_str()).filter(|v| !v.is_empty()))
        .map(|token| SecretToken(token.to_string()))
        .ok_or_else(|| "CREDENTIAL_TOKEN_ABSENT".to_string())
}

#[cfg(not(unix))]
pub fn read_confined_token(_dir: &Path, _file: &str, _fields: &[String]) -> Result<SecretToken, String> {
    Err("CREDENTIAL_UNREADABLE: unsupported platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand of its own: a fabricated home and a second directory beside
    /// it, both made here and now. Nothing is read from the machine — not
    /// its HOME, not its git, not where its temp directory happens to sit —
    /// and nothing is set in the process's environment (a home pin in
    /// `lib.rs` forbids that in-tree, and the rules take the home as a
    /// value for exactly this reason).
    struct Stand {
        root: PathBuf,
        home: PathBuf,
        elsewhere: PathBuf,
    }

    impl Stand {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "kd-containment-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let home = root.join("home");
            let elsewhere = root.join("elsewhere");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&elsewhere).unwrap();
            Self { root, home, elsewhere }
        }

        fn home(&self) -> Option<&OsStr> {
            Some(self.home.as_os_str())
        }

        fn root_of(&self, dir: &Path) -> Vec<String> {
            vec![dir.to_string_lossy().into_owned()]
        }
    }

    impl Drop for Stand {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).ok();
        }
    }

    #[test]
    fn a_home_relative_path_is_expanded_before_the_containment_check() {
        let stand = Stand::new();
        // Inside its own root: the same directory, spelled two ways.
        let resolved = resolve_within_from("~/", &stand.root_of(&stand.home), false, stand.home())
            .expect("home is inside home");
        assert_eq!(resolved, fs::canonicalize(&stand.home).unwrap());

        // Outside a root that is not home: refused as OUTSIDE — the spelling
        // was read as the home directory, not as a folder literally named `~`.
        let err = resolve_within_from("~/", &stand.root_of(&stand.elsewhere), false, stand.home())
            .expect_err("home is not the other directory");
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn a_missing_path_is_named_as_the_caller_spelled_it() {
        let stand = Stand::new();
        let err = resolve_within_from(
            "~/no-such-folder",
            &stand.root_of(&stand.home),
            false,
            stand.home(),
        )
        .expect_err("nothing there");
        assert!(err.contains("no such path: ~/no-such-folder"), "{err}");
    }

    #[test]
    fn without_a_home_a_home_relative_path_is_refused_by_name() {
        let stand = Stand::new();
        let err = resolve_within_from("~/x", &stand.root_of(&stand.home), false, None)
            .expect_err("no home to expand against");
        assert!(err.contains("no home directory"), "{err}");
    }

    #[cfg(unix)]
    mod confined_token {
        use super::*;
        use std::os::unix::fs::symlink;

        fn fields() -> Vec<String> {
            vec!["access_token".into(), "accessToken".into()]
        }

        /// The credentials dir as the resolver would hand it over: canonical.
        fn credentials(stand: &Stand) -> PathBuf {
            let dir = stand.home.join(".tool/credentials");
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(dir).unwrap()
        }

        fn read(dir: &Path, file: &str) -> Result<String, String> {
            read_confined_token(dir, file, &fields()).map(|token| token.bearer())
        }

        #[test]
        fn reads_the_first_present_field_of_a_file_inside() {
            let stand = Stand::new();
            let dir = credentials(&stand);
            fs::write(dir.join("t.json"), r#"{"access_token":"","accessToken":"sentinel"}"#).unwrap();
            assert_eq!(read(&dir, "t.json").unwrap(), "Bearer sentinel");
        }

        #[test]
        fn refuses_any_name_that_is_not_one_plain_file() {
            let stand = Stand::new();
            let dir = credentials(&stand);
            fs::write(stand.home.join(".tool/t.json"), r#"{"access_token":"x"}"#).unwrap();
            for name in ["../t.json", "a/t.json", ".hidden", "", "a\\b", "/etc/passwd"] {
                let error = read(&dir, name).unwrap_err();
                assert!(error.contains("plain file name"), "{name}: {error}");
            }
        }

        #[test]
        fn refuses_a_symlinked_token_whether_it_points_out_or_in() {
            let stand = Stand::new();
            let dir = credentials(&stand);
            let outside = stand.elsewhere.join("t.json");
            fs::write(&outside, r#"{"access_token":"outside"}"#).unwrap();
            symlink(&outside, dir.join("out.json")).unwrap();
            fs::write(dir.join("real.json"), r#"{"access_token":"inside"}"#).unwrap();
            symlink(dir.join("real.json"), dir.join("in.json")).unwrap();
            assert_eq!(read(&dir, "out.json").unwrap_err(), "CREDENTIAL_UNREADABLE");
            assert_eq!(read(&dir, "in.json").unwrap_err(), "CREDENTIAL_UNREADABLE");
        }

        #[test]
        fn refuses_a_directory_on_the_way_swapped_for_a_symlink_after_resolution() {
            let stand = Stand::new();
            let dir = credentials(&stand);
            fs::write(dir.join("t.json"), r#"{"access_token":"inside"}"#).unwrap();
            // The frozen path stays; what sits at it is replaced by a link to
            // a lookalike holding another token.
            let lookalike = stand.elsewhere.join("credentials");
            fs::create_dir_all(&lookalike).unwrap();
            fs::write(lookalike.join("t.json"), r#"{"access_token":"swapped"}"#).unwrap();
            fs::rename(&dir, stand.home.join(".tool/moved")).unwrap();
            symlink(&lookalike, &dir).unwrap();
            assert_eq!(read(&dir, "t.json").unwrap_err(), "CREDENTIAL_UNREADABLE");
        }

        #[test]
        fn refuses_a_special_file_an_oversized_file_and_non_json() {
            let stand = Stand::new();
            let dir = credentials(&stand);
            fs::create_dir(dir.join("adir")).unwrap();
            assert!(read(&dir, "adir").unwrap_err().contains("not a regular file"));
            let fifo = std::ffi::CString::new(dir.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
            // SAFETY: a valid C path; mkfifo makes a node, nothing else.
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            assert!(read(&dir, "fifo").unwrap_err().contains("not a regular file"));
            let big = format!(r#"{{"access_token":"{}"}}"#, "x".repeat(70 * 1024));
            fs::write(dir.join("big.json"), big).unwrap();
            assert!(read(&dir, "big.json").unwrap_err().contains("64 KiB"));
            fs::write(dir.join("text.json"), "token=abc").unwrap();
            assert!(read(&dir, "text.json").unwrap_err().contains("not JSON"));
            fs::write(dir.join("none.json"), r#"{"other":"x"}"#).unwrap();
            assert_eq!(read(&dir, "none.json").unwrap_err(), "CREDENTIAL_TOKEN_ABSENT");
        }

        #[test]
        fn a_missing_directory_authorizes_no_read() {
            let stand = Stand::new();
            let missing = fs::canonicalize(&stand.home).unwrap().join("not-yet/credentials");
            assert_eq!(read(&missing, "t.json").unwrap_err(), "CREDENTIAL_UNREADABLE");
        }
    }
}
