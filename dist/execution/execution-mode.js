/**
 * Execution-mode recommendation, versioned by the algorithm recorded in the
 * event that carries it (design §3.2).
 *
 * FREEZE RULE (append-only, durable). `recommendExecutionModeV1` and
 * `recommendExecutionModeV2` are never edited once merged, and neither is
 * `SELECTION_WEIGHTS_V2` in ./selection-score.ts. Replay re-derives a recorded
 * recommendation with the version the event names, so changing a trigger, a band
 * boundary or a weight in place would rewrite the meaning of every historical
 * event and make recorded runs unopenable. A change ships as `algorithmVersion:
 * 3` with a new function beside these. This is the durable reason the replay
 * guarantee survives later phases.
 */
import { complexityScore, firedHardTriggers } from "./selection-score.js";
export const EXECUTION_MODES = ["explorer", "expedition"];
/**
 * Orchestration is an executor role inside a mode, never a mode. `trail-boss`
 * is legal only alongside `recommendedMode: "expedition"`.
 */
export const EXECUTION_ORCHESTRATIONS = ["explorer", "trail-boss"];
/** Keep coordination, product authorship, and independent review distinct. */
export function validateExecutionRoleBoundary(input) {
    if (input.coordinator.role !== "navigator" && input.coordinator.role !== "explorer")
        return { ok: false, reason: "role_boundary", field: "coordinator" };
    if (input.productAuthor.role !== "crewmate" || input.productAuthor.identity === input.coordinator.identity)
        return { ok: false, reason: "role_boundary", field: "productAuthor" };
    if (input.reviewer.role !== "surveyor" || input.reviewer.identity === input.coordinator.identity || input.reviewer.identity === input.productAuthor.identity)
        return { ok: false, reason: "role_boundary", field: "reviewer" };
    return { ok: true };
}
/**
 * A reviewer sharing identity with the role that authored the candidate cannot
 * independently verify it (issue 93). This is checked again here, independent
 * of `validateExecutionRoleBoundary`'s coordinated-dispatch check, because a
 * standalone review-stage request has no coordinator/productAuthor triple of
 * its own to validate against.
 */
export function validateReviewerAuthorship(input) {
    return input.reviewer.identity === input.author.identity
        ? { ok: false, reason: "role_boundary", field: "reviewer" }
        : { ok: true };
}
/** Kept for every existing caller: the exported facade is version 1. */
export function recommendExecutionMode(input) {
    return recommendExecutionModeV1(input);
}
/** FROZEN. Behaviour of the pre-Phase-3 selection rule, verbatim. */
export function recommendExecutionModeV1(input) {
    if (![input.workItems, input.maxCrewmatesPerExplorer, input.perAgentTokenEstimate].every((value) => Number.isSafeInteger(value) && value > 0) || (input.overrideMode !== undefined && !EXECUTION_MODES.includes(input.overrideMode)))
        throw new TypeError("invalid recommendation input");
    const recommendedMode = input.workItems <= input.maxCrewmatesPerExplorer ? "explorer" : "expedition";
    const selectedMode = input.overrideMode ?? recommendedMode;
    const explorers = selectedMode === "explorer" ? 1 : Math.ceil(input.workItems / input.maxCrewmatesPerExplorer);
    const estimatedAgents = input.workItems + explorers + (selectedMode === "expedition" ? 1 : 0);
    return {
        recommendedMode, selectedMode, overridden: selectedMode !== recommendedMode, estimatedAgents,
        estimatedTokens: estimatedAgents * input.perAgentTokenEstimate,
        tradeoffs: selectedMode === "explorer"
            ? { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }
            : { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" },
        launchAuthorized: false,
    };
}
/**
 * FROZEN once merged. Hard triggers and the complexity score of design §3.3-§3.4,
 * with version 1's fan-out rule surviving as the mode fallback, so version 2 is a
 * strict superset of version 1's mode behaviour.
 *
 * The input guard is deliberately not shared with version 1: the freeze rule
 * requires each version to keep its own validation forever, even when a later
 * version tightens it.
 */
export function recommendExecutionModeV2(input, signals) {
    if (![input.workItems, input.maxCrewmatesPerExplorer, input.perAgentTokenEstimate].every((value) => Number.isSafeInteger(value) && value > 0) || (input.overrideMode !== undefined && !EXECUTION_MODES.includes(input.overrideMode)))
        throw new TypeError("invalid recommendation input");
    const fired = firedHardTriggers(signals);
    const score = complexityScore(signals);
    const trailBoss = fired.length > 0 || score >= signals.threshold;
    const recommendedOrchestration = trailBoss ? "trail-boss" : "explorer";
    const recommendedMode = trailBoss ? "expedition" : (input.workItems <= input.maxCrewmatesPerExplorer ? "explorer" : "expedition");
    const selectedMode = input.overrideMode ?? recommendedMode;
    const explorers = selectedMode === "explorer" ? 1 : Math.ceil(input.workItems / input.maxCrewmatesPerExplorer);
    // The coordination cost of the extra layer lands in the number the owner already sees.
    const estimatedAgents = input.workItems + explorers + signals.subExplorerCount
        + (selectedMode === "expedition" ? 1 : 0)
        + (recommendedOrchestration === "trail-boss" ? 1 : 0);
    return {
        algorithmVersion: 2, complexityScore: score, firedHardTriggers: fired, recommendedOrchestration,
        recommendedMode, selectedMode, overridden: selectedMode !== recommendedMode, estimatedAgents,
        estimatedTokens: estimatedAgents * input.perAgentTokenEstimate,
        tradeoffs: selectedMode === "explorer"
            ? { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }
            : { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" },
        launchAuthorized: false,
    };
}
