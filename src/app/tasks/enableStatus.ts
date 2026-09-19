/**
 * The task board backend's last transition — the shared enable-status
 * cell as this feature's one instance, so the dialog can say WHY the
 * board is shut when the toggle reads On (another KeepDeck process owns
 * the claim, an unwritable home) instead of the store's one sentence.
 */
import { createEnableStatus } from "../enableStatus";

export { refusalOf } from "../enableStatus";

/** The app's one status. */
export const tasksEnableStatus = createEnableStatus();
