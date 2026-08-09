/**
 * The exec rule, re-exported from where it lives.
 *
 * It belongs to the manifest contract — `@keepdeck/plugin-api` owns what a
 * capability declaration means, and its own `declaredAgentBins` has to apply
 * the same rule before any host code runs. The host kept a second copy until
 * a detection pass started EXECUTING declared bins, at which point two
 * answers to "may this program be run" was one too many.
 *
 * This file stays as the host's name for it: the spawn gate, the activation
 * gate and the consent preview all reach for it here.
 */
export { execCovers } from "@keepdeck/plugin-api";
