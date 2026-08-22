#[cfg(test)]
use std::collections::HashSet;
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

/// A feature gate a bundled skill may depend on. The enum lives with the
/// skills feature; the registry's closures are wired by the composition root.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum GateKey {
    Artifacts,
    #[cfg(test)]
    NeverRegistered,
}

/// Resolve feature gates at lookup time. The one field per production variant
/// is intentional: adding a gate requires adding its storage and registration
/// together at the root, rather than silently omitting a map entry.
pub(crate) struct GateRegistry {
    artifacts: Box<dyn Fn() -> bool + Send + Sync>,
}

impl GateRegistry {
    pub(crate) fn new(
        artifacts: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            artifacts: Box::new(artifacts),
        }
    }

    pub(crate) fn resolve(&self, key: GateKey) -> bool {
        match key {
            GateKey::Artifacts => (self.artifacts)(),
            #[cfg(test)]
            GateKey::NeverRegistered => {
                warn_unregistered_once("NeverRegistered");
                false
            }
        }
    }
}

#[cfg(test)]
fn warn_unregistered_once(name: &str) {
    static WARNED: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let warned = WARNED.get_or_init(|| Mutex::new(HashSet::new()));
    let mut warned = warned.lock().expect("gate warning registry poisoned");
    if warned.insert("NeverRegistered") {
        log::warn!("skills: bundled gate {name} was never registered — treating it as off");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_gate_resolves_fresh_values() {
        let state = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let source = std::sync::Arc::clone(&state);
        let registry = GateRegistry::new(move || {
            source.load(std::sync::atomic::Ordering::SeqCst)
        });

        assert!(!registry.resolve(GateKey::Artifacts));
        state.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(registry.resolve(GateKey::Artifacts));
    }

    #[test]
    fn every_production_gate_is_registered() {
        let registry = GateRegistry::new(|| true);

        assert!(registry.resolve(GateKey::Artifacts));
    }

    #[test]
    fn never_registered_gate_is_false() {
        let registry = GateRegistry::new(|| true);
        assert!(!registry.resolve(GateKey::NeverRegistered));
        assert!(!registry.resolve(GateKey::NeverRegistered));
    }
}
