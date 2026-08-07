/**
 * Selection signals, band table and hard triggers for execution-mode selection
 * algorithm version 2 (design §3.3-§3.4).
 *
 * FREEZE RULE (append-only, durable). `SELECTION_WEIGHTS_V2`, `HARD_TRIGGERS_V2`,
 * `firedHardTriggers` and `complexityScore` are never edited once merged. Replay
 * re-derives every recorded version-2 recommendation from this table, so moving a
 * band boundary, a weight or a trigger would retroactively rewrite the meaning of
 * historical events and make recorded runs unopenable. A change ships as
 * algorithm version 3: a new table and a new function beside these, never an edit
 * to these.
 *
 * Pure integer arithmetic: no clock, filesystem, locale or configuration read,
 * and no floating-point value anywhere, so a score is bit-identical across
 * platforms and Node versions.
 */
import { hasExactKeys } from "../contracts/guards.js";
export const RISK_RATINGS = ["low", "medium", "high", "critical"];
/** Trigger flags, in the order `HARD_TRIGGERS_V2` evaluates them. */
const HARD_TRIGGER_FLAGS = ["multiRepository", "securityCriticalIntegration", "dataMigration", "irreversibleOperations"];
export const SELECTION_WEIGHTS_V2 = {
    bands: {
        phaseCount: [[0, 0], [2, 1], [3, 2], [5, 3]],
        sliceCount: [[0, 0], [9, 1], [21, 2], [51, 3]],
        dependencyEdgeCount: [[0, 0], [5, 1], [16, 2], [41, 3]],
        // First band is worth double: one overlapping write set is exactly what makes
        // two slices non-parallel-safe, so it converts directly into serialized work.
        sharedFileOverlapCount: [[0, 0], [1, 2], [4, 3]],
        serviceCount: [[0, 0], [2, 1], [3, 2], [5, 3]],
        expectedConcurrency: [[0, 0], [3, 1], [5, 2], [9, 3]],
        integrationCheckpointCount: [[0, 0], [1, 1], [3, 2], [6, 3]],
    },
    // Scored, not a hard trigger (OD-3.1, resolved 2026-07-25).
    risk: { low: 0, medium: 1, high: 3, critical: 4 },
};
const BANDS = SELECTION_WEIGHTS_V2.bands;
const RISK_POINTS = SELECTION_WEIGHTS_V2.risk;
const BANDED_SIGNALS = Object.keys(BANDS);
const SELECTION_ALGORITHM_VERSION_2 = 2;
/** Guide §5.3 example value; recorded per event so a later default cannot move a recorded run. */
export const DEFAULT_SELECTION_THRESHOLD = 8;
export const MIN_PHASE_EXPLORERS = 3;
const HARD_TRIGGERS_V2 = [
    { id: "multi_repository", fires: (signals) => signals.multiRepository },
    { id: "security_critical_integration", fires: (signals) => signals.securityCriticalIntegration },
    { id: "data_migration", fires: (signals) => signals.dataMigration },
    { id: "irreversible_operations", fires: (signals) => signals.irreversibleOperations },
    { id: "three_or_more_phase_explorers", fires: (signals) => signals.phaseExplorerCount >= MIN_PHASE_EXPLORERS },
];
/** Declaration order, which is also the emission order: replay compares the array positionally. */
export const HARD_TRIGGER_IDS = HARD_TRIGGERS_V2.map((trigger) => trigger.id);
/** Highest score the shipped table can produce; derived from the table, not restated. */
export const MAX_COMPLEXITY_SCORE = BANDED_SIGNALS.reduce((total, signal) => total + BANDS[signal][BANDS[signal].length - 1][1], Math.max(...Object.values(RISK_POINTS)));
function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** Structural guard shared with the ledger contract, which adds its own upper bounds. */
export function isSelectionSignals(value) {
    if (!hasExactKeys(value, ["algorithmVersion", "threshold", "hardTriggers", "complexity", "subExplorerCount"]))
        return false;
    if (value.algorithmVersion !== SELECTION_ALGORITHM_VERSION_2 || !isCount(value.threshold) || value.threshold < 1 || !isCount(value.subExplorerCount))
        return false;
    const triggers = value.hardTriggers;
    if (!hasExactKeys(triggers, [...HARD_TRIGGER_FLAGS, "phaseExplorerCount"]))
        return false;
    if (!HARD_TRIGGER_FLAGS.every((flag) => typeof triggers[flag] === "boolean") || !isCount(triggers.phaseExplorerCount))
        return false;
    const complexity = value.complexity;
    if (!hasExactKeys(complexity, [...BANDED_SIGNALS, "riskRating"]))
        return false;
    return BANDED_SIGNALS.every((signal) => isCount(complexity[signal]))
        && RISK_RATINGS.some((rating) => rating === complexity.riskRating);
}
function band(value, bands) {
    let points = 0;
    for (const [lowerBound, bandPoints] of bands)
        if (value >= lowerBound)
            points = bandPoints;
    return points;
}
/** Sum of the eight banded signals; integer in `0..MAX_COMPLEXITY_SCORE`. */
export function complexityScore(signals) {
    if (!isSelectionSignals(signals))
        throw new TypeError("invalid selection signals");
    const complexity = signals.complexity;
    return BANDED_SIGNALS.reduce((total, signal) => total + band(complexity[signal], BANDS[signal]), RISK_POINTS[complexity.riskRating]);
}
/** Fired triggers in declaration order; never sorted, so replay array equality is stable. */
export function firedHardTriggers(signals) {
    if (!isSelectionSignals(signals))
        throw new TypeError("invalid selection signals");
    return HARD_TRIGGERS_V2.filter((trigger) => trigger.fires(signals.hardTriggers)).map((trigger) => trigger.id);
}
