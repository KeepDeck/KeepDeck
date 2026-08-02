//! Shared fixtures for the session_tail test suites — one copy of the wire
//! lines and the scratch-dir/mtime helpers, so each module's tests live in
//! the module they exercise without re-authoring the same payloads.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) const SOURCE_ISO: &str = "2026-07-16T22:13:08.000Z";
pub(super) const TOKEN_COUNT_LINE: &str = r#"{"timestamp":"2026-07-16T22:13:08.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"total_tokens":40},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":75.0,"window_minutes":10080,"resets_at":1784834810},"secondary":null,"plan_type":"plus"}}}"#;
pub(super) const TURN_CONTEXT_LINE: &str = r#"{"timestamp":"2026-07-16T22:13:08.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"xhigh","cwd":"/x"}}"#;
pub(super) const USAGE_RECORD_LINE: &str = r#"{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1200,"output":300,"inputCacheRead":40000,"inputCacheCreation":900},"usageScope":"turn","time":1784800000000}"#;
pub(super) const LLM_REQUEST_LINE: &str = r#"{"type":"llm.request","model":"kimi-code/k3","maxTokens":1048576,"messages":[{"role":"user","content":"SECRET PROMPT"}]}"#;
pub(super) const CLAUDE_ASSISTANT_LINE: &str = r#"{"type":"assistant","message":{"id":"msg-1","model":"claude-opus-4-8","content":[{"type":"text","text":"SECRET ANSWER"}],"usage":{"input_tokens":12,"output_tokens":30,"cache_read_input_tokens":40000,"cache_creation_input_tokens":900}},"timestamp":"2026-07-16T22:13:08.000Z"}"#;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) fn temp_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("keepdeck-rollout-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn set_mtime(path: &std::path::Path, secs_after_epoch: u64) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs_after_epoch),
        )
        .unwrap();
}
