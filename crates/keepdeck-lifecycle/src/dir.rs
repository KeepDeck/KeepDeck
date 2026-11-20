//! A directory as the lifecycle compares it.

use serde::{Deserialize, Serialize};

/// A directory's key: surrounding whitespace and trailing slashes do not make
/// another directory ("/repo/" and "/repo" are one folder). Not a
/// canonicalizer — no file system is read. The deck spells the same key in
/// TS (`normalizePath`) for the rules that stay there; here it is the key of
/// every claim, place and deletion target the arbiter holds.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(into = "String", from = "String")]
pub struct Dir(String);

impl Dir {
    pub fn new(path: &str) -> Dir {
        let trimmed = path.trim();
        let stripped = trimmed.trim_end_matches('/');
        Dir(if stripped.is_empty() { trimmed } else { stripped }.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for Dir {
    fn from(path: String) -> Dir {
        Dir::new(&path)
    }
}

impl From<Dir> for String {
    fn from(dir: Dir) -> String {
        dir.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_slashes_and_surrounding_space_are_the_same_directory() {
        assert_eq!(Dir::new(" /repo/wt// "), Dir::new("/repo/wt"));
        assert_eq!(Dir::new("/repo/wt").as_str(), "/repo/wt");
    }

    #[test]
    fn the_root_stays_the_root_and_other_paths_stay_apart() {
        assert_eq!(Dir::new("/").as_str(), "/");
        assert_eq!(Dir::new("///").as_str(), "///", "all slashes: kept as written, like the deck's rule");
        assert_ne!(Dir::new("/repo/a"), Dir::new("/repo/ab"));
        assert_ne!(Dir::new("/Repo"), Dir::new("/repo"), "no case folding: not a canonicalizer");
    }

    #[test]
    fn a_dir_read_from_json_is_keyed_like_one_built_here() {
        let read: Dir = serde_json::from_str("\"/repo/wt/\"").unwrap();
        assert_eq!(read, Dir::new("/repo/wt"));
    }
}
