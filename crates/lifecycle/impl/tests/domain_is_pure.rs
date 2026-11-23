//! The domain is pure: nothing under `src/domain` names what does IO, keeps
//! time, draws randomness or starts a thread, and nothing of
//! `infrastructure`. The crate's layers are modules of one crate, so its
//! `Cargo.toml` cannot say that; this test reads the domain's source and does.
//!
//! Every path in the domain's code is read by its root — a `use` line and a
//! path written inline alike, `::std` too:
//! - `crate::` goes on into `domain`;
//! - `super::super` is refused: from a domain file it climbs out of the
//!   domain, and none needs it; nor does `domain/mod.rs` use `super`;
//! - `std`, `core` and `alloc` only for collections, formatting, iterators,
//!   `mem`, slices and `time::Duration`;
//! - of the crate's own dependencies — any table of them, one target's
//!   included — only the ones in [`DEPENDENCIES`]; one the crate adds later
//!   is refused here with no edit to this test.
//!
//! Refused wherever they stand: the hashed collections, whose order is drawn
//! at random for each run, so a machine that walks one would list its
//! effects and write its journal in an order that changes from run to run;
//! and the macros that print or keep state per thread.
//!
//! Test code is not read — a `tests.rs` file and a module under
//! `#[cfg(test)]`. What a test writes — the wire examples for TS, ts-rs's
//! bindings — is the test's IO, not the domain's. `#[cfg(test)]` on anything
//! but a module is read as code: what it stands on cannot be told apart from
//! what follows it.
//!
//! Beyond a reading of the source, and left to review: what a macro expands
//! to, what an allowed dependency does inside, and a crate renamed on the way
//! in (`use std as s`).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// What the domain may take from the standard library.
const STD: &[&str] = &["collections", "fmt", "iter", "mem", "slice"];

/// The crate's dependencies the domain may name: the framework it writes
/// machines against, and the derives that describe its types on the wire.
const DEPENDENCIES: &[&str] = &["keepdeck_fsm", "serde", "serde_json", "ts_rs"];

/// The macros that print, or keep state per thread.
const MACROS: &[&str] = &["print", "println", "eprint", "eprintln", "dbg", "thread_local"];

/// The collections whose order is drawn at random for each run.
const HASHED: &[&str] = &["HashMap", "HashSet", "RandomState"];

/// The words of Rust that can stand right before a path's leading `::`; a
/// path segment never is one of them.
const KEYWORDS: &[&str] = &[
    "as", "async", "box", "break", "const", "dyn", "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
    "mod", "move", "mut", "pub", "ref", "return", "static", "struct", "trait", "type", "unsafe", "use", "where", "while", "yield",
];

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The names the crate's own dependencies give, as Rust spells them: every
/// table of them — `[dependencies]`, one target's, and a dependency written
/// as a table of its own.
fn dependencies() -> BTreeSet<String> {
    let manifest = fs::read_to_string(crate_dir().join("Cargo.toml")).expect("Cargo.toml");
    let mut inside = false;
    let mut names = BTreeSet::new();
    for line in manifest.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[').and_then(|line| line.strip_suffix(']')) {
            inside = header == "dependencies" || header.ends_with(".dependencies");
            if let Some(name) = header.strip_prefix("dependencies.") {
                names.insert(name.trim().replace('-', "_"));
            }
        } else if inside && !line.starts_with('#') {
            if let Some((name, _)) = line.split_once('=') {
                names.insert(name.trim().replace('-', "_"));
            }
        }
    }
    names
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir).expect("read the domain").map(|entry| entry.expect("entry").path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") && path.file_name().is_some_and(|name| name != "tests.rs") {
            out.push(path);
        }
    }
}

/// The source with comments gone and every string and char literal emptied,
/// newlines kept so a line number still points at the source.
fn code_of(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && at(i + 1) == Some('/') {
            while at(i).is_some_and(|c| c != '\n') {
                i += 1;
            }
        } else if c == '/' && at(i + 1) == Some('*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && at(i + 1) == Some('/')) {
                if chars[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
        } else if c == 'r' && matches!(at(i + 1), Some('"' | '#')) && !i.checked_sub(1).and_then(at).is_some_and(|p| p.is_alphanumeric() || p == '_') {
            let mut j = i + 1;
            let mut hashes = 0;
            while at(j) == Some('#') {
                hashes += 1;
                j += 1;
            }
            if at(j) != Some('"') {
                out.push(c);
                i += 1;
                continue;
            }
            j += 1;
            while j < chars.len() && !(chars[j] == '"' && (1..=hashes).all(|k| at(j + k) == Some('#'))) {
                if chars[j] == '\n' {
                    out.push('\n');
                }
                j += 1;
            }
            out.push_str("\"\"");
            i = j + 1 + hashes;
        } else if c == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1;
                }
                if at(i) == Some('\n') {
                    out.push('\n');
                }
                i += 1;
            }
            out.push_str("\"\"");
            i += 1;
        } else if c == '\'' && at(i + 1) == Some('\\') {
            i += 3;
            while at(i).is_some_and(|c| c != '\'') {
                i += 1;
            }
            out.push_str("' '");
            i += 1;
        } else if c == '\'' && at(i + 2) == Some('\'') {
            out.push_str("' '");
            i += 3;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The code with every module under `#[cfg(test)]` blanked, lines kept. The
/// attribute on anything else is left, and what follows it read.
fn without_tests(code: &str) -> String {
    const TEST: &str = "#[cfg(test)]";
    let mut code = code.to_string();
    let mut from = 0;
    while let Some(found) = code[from..].find(TEST) {
        let start = from + found;
        let after = start + TEST.len();
        from = after;
        let rest = &code[after..];
        let item = rest.trim_start();
        let item = item.strip_prefix("pub ").unwrap_or(item).trim_start();
        if !item.starts_with("mod ") {
            continue;
        }
        let end = match (rest.find(';'), rest.find('{')) {
            (Some(semi), Some(brace)) if semi < brace => after + semi + 1,
            (Some(semi), None) => after + semi + 1,
            (_, Some(brace)) => {
                let mut depth = 0usize;
                let mut end = code.len();
                for (offset, c) in code[after + brace..].char_indices() {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                end = after + brace + offset + 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                end
            }
            (None, None) => code.len(),
        };
        let blank: String = code[start..end].chars().map(|c| if c == '\n' { '\n' } else { ' ' }).collect();
        code.replace_range(start..end, &blank);
        from = end;
    }
    code
}

#[derive(Debug, PartialEq)]
enum Token {
    Ident(String),
    Path,
    Bang,
    Other(char),
}

fn tokens(code: &str) -> Vec<(usize, Token)> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = Vec::new();
    let mut line = 1;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\n' {
            line += 1;
            i += 1;
        } else if c.is_whitespace() {
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push((line, Token::Ident(chars[start..i].iter().collect())));
        } else if c == ':' && chars.get(i + 1) == Some(&':') {
            out.push((line, Token::Path));
            i += 2;
        } else if c == '!' {
            out.push((line, Token::Bang));
            i += 1;
        } else {
            out.push((line, Token::Other(c)));
            i += 1;
        }
    }
    out
}

/// Why each path or macro in one domain file breaks the domain's purity.
fn breaches(file: &Path, code: &str, dependencies: &BTreeSet<String>) -> Vec<String> {
    let is_domain_root = file.ends_with("src/domain/mod.rs");
    let tokens = tokens(code);
    let ident = |i: usize| match tokens.get(i) {
        Some((_, Token::Ident(name))) => Some(name.as_str()),
        _ => None,
    };
    let is_path = |i: usize| matches!(tokens.get(i), Some((_, Token::Path)));
    let mut found = Vec::new();
    for (i, (line, token)) in tokens.iter().enumerate() {
        let Token::Ident(root) = token else { continue };
        let at = format!("{}:{line}", file.display());
        if matches!(tokens.get(i + 1), Some((_, Token::Bang))) && MACROS.contains(&root.as_str()) {
            found.push(format!("{at}: `{root}!` prints or keeps state per thread"));
            continue;
        }
        if HASHED.contains(&root.as_str()) {
            found.push(format!("{at}: `{root}` walks in an order drawn at random"));
            continue;
        }
        // A segment after `::` is no root — unless that `::` leads the path:
        // nothing named before it, or only a keyword (`use ::std`,
        // `return ::std::…`).
        let named_before = match tokens.get(i.wrapping_sub(2)) {
            Some((_, Token::Ident(before))) => !KEYWORDS.contains(&before.as_str()),
            Some((_, Token::Other('>'))) => true,
            _ => false,
        };
        let leads = i < 2 || !named_before;
        if !is_path(i + 1) || (i > 0 && is_path(i - 1) && !leads) {
            continue;
        }
        let next = ident(i + 2);
        let then = if is_path(i + 3) { ident(i + 4) } else { None };
        let path = format!("{root}::{}", next.unwrap_or("…"));
        match root.as_str() {
            "crate" if next != Some("domain") => found.push(format!("{at}: `{path}` leaves the domain")),
            "super" if next == Some("super") => found.push(format!("{at}: `super::super` climbs out of the domain")),
            "super" if is_domain_root => found.push(format!("{at}: `super` from the domain's root is the crate's root")),
            "std" | "core" | "alloc" => {
                let allowed = next.is_some_and(|module| STD.contains(&module)) || (next == Some("time") && then == Some("Duration"));
                if !allowed {
                    found.push(format!("{at}: `{path}` is not one of the standard library's pure parts"));
                }
            }
            name if dependencies.contains(name) && !DEPENDENCIES.contains(&name) => {
                found.push(format!("{at}: `{path}` is a dependency the domain may not name"));
            }
            _ => {}
        }
    }
    found
}

#[test]
fn the_domain_names_nothing_that_does_io_and_nothing_of_the_infrastructure() {
    let dependencies = dependencies();
    assert!(dependencies.contains("keepdeck_fsm"), "the manifest's dependencies were read: {dependencies:?}");
    let mut files = Vec::new();
    rust_files(&crate_dir().join("src/domain"), &mut files);
    assert!(files.len() > 10, "the domain's files were found: {files:?}");
    let mut found = Vec::new();
    for file in &files {
        let source = fs::read_to_string(file).expect("read a domain file");
        let code = without_tests(&code_of(&source));
        found.extend(breaches(file.strip_prefix(crate_dir()).unwrap_or(file), &code, &dependencies));
    }
    assert!(found.is_empty(), "the domain is not pure:\n{}", found.join("\n"));
}
