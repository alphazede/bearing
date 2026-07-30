export const CADENCE_TRIGGERS = [
    "high-risk",
    "unclear-requirements",
    "new-architecture",
    "security-sensitive",
    "substantial-work",
    "low-risk-mature-system",
];
const STRENGTH = {
    "per-slice": 3,
    "per-phase": 2,
    "completion-only": 1,
};
const FORCE_PER_SLICE = new Set([
    "high-risk",
    "unclear-requirements",
    "new-architecture",
    "security-sensitive",
]);
const FORCE_PER_PHASE = new Set(["substantial-work"]);
export function resolveReviewCadence(input) {
    const { declared, triggers } = input;
    let forced = "completion-only";
    const reasons = [];
    for (const t of triggers) {
        if (FORCE_PER_SLICE.has(t)) {
            forced = "per-slice";
            if (!reasons.includes(t))
                reasons.push(t);
        }
        else if (FORCE_PER_PHASE.has(t) && forced !== "per-slice") {
            forced = "per-phase";
            if (!reasons.includes(t))
                reasons.push(t);
        }
    }
    // completion-only only survives when sole trigger is exactly low-risk-mature-system
    const onlyLowRisk = triggers.length === 1 && triggers[0] === "low-risk-mature-system";
    if (!onlyLowRisk && triggers.length > 0 && forced === "completion-only") {
        forced = "per-phase";
        for (const t of triggers)
            if (!reasons.includes(t))
                reasons.push(t);
    }
    const declaredStrength = STRENGTH[declared];
    const forcedStrength = STRENGTH[forced];
    const cadence = forcedStrength > declaredStrength ? forced : declared;
    const tightened = cadence !== declared;
    const finalReasons = tightened ? reasons : [];
    return { cadence, tightened, reasons: finalReasons };
}
export function requiredGates(cadence, boundary) {
    if (boundary === "slice") {
        return cadence === "per-slice" ? ["validator", "park-ranger"] : ["validator"];
    }
    if (boundary === "phase") {
        if (cadence === "completion-only")
            return ["validator", "park-ranger"];
        return ["validator", "park-ranger", "grader"];
    }
    // completion
    return ["validator", "park-ranger", "grader", "surveyor"];
}
