//! Branch-list helpers — pure string logic, no git calls. Naming KeepDeck's
//! own branches is the lifecycle's (`keepdeck_lifecycle::domain::places`).

/// `branches` with `pin` moved to the front, the rest keeping their order —
/// the base-branch picker leads with the most likely base (the repo's default
/// branch, else the checked-out one) over a plain alphabetical list. A `None`
/// pin, or one naming no listed branch, leaves the order untouched.
pub fn pin_first(mut branches: Vec<String>, pin: Option<&str>) -> Vec<String> {
    if let Some(name) = pin {
        if let Some(position) = branches.iter().position(|b| b == name) {
            let pinned = branches.remove(position);
            branches.insert(0, pinned);
        }
    }
    branches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_first_moves_the_pin_keeping_the_rest_in_order() {
        let list = || vec!["alpha".to_string(), "main".to_string(), "zeta".to_string()];
        assert_eq!(pin_first(list(), Some("main")), ["main", "alpha", "zeta"]);
        // Already first / absent pin / no pin: the order is untouched.
        assert_eq!(pin_first(list(), Some("alpha")), ["alpha", "main", "zeta"]);
        assert_eq!(pin_first(list(), Some("ghost")), ["alpha", "main", "zeta"]);
        assert_eq!(pin_first(list(), None), ["alpha", "main", "zeta"]);
    }
}
