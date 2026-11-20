//! Blocking work under watch, for every machine's handler: a framework
//! machine hears of work only through the event the work sends, so work that
//! panicked or was cancelled must still come back as an outcome — or the
//! machine would wait on it for ever.

/// Blocking work with no cancel: its outcome comes only once it has really
/// ended, and a panic is an outcome too.
pub(crate) async fn supervised<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => Err("the work panicked".into()),
        Err(_) => Err("the work was cancelled".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::supervised;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_work_says_how_it_ended_a_panic_included() {
        assert_eq!(supervised(|| Ok(7)).await, Ok(7));
        assert_eq!(supervised(|| Err::<u8, _>("refused".to_string())).await, Err("refused".to_string()));
        assert_eq!(supervised(|| -> Result<u8, String> { panic!("inside the work") }).await, Err("the work panicked".to_string()));
    }
}
