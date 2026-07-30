export const GRADER_RUBRIC_VERSION = 1;
const correctnessLevels = Object.freeze([
    Object.freeze({ level: 0, anchor: "The result contradicts requirements or leaves acceptance criteria unimplemented." }),
    Object.freeze({ level: 1, anchor: "The result addresses a minority of requirements and has material correctness gaps." }),
    Object.freeze({ level: 2, anchor: "The result partially satisfies requirements but leaves observable acceptance gaps." }),
    Object.freeze({ level: 3, anchor: "The result satisfies the traced requirements with only minor limitations." }),
    Object.freeze({ level: 4, anchor: "The result fully satisfies every traced requirement and acceptance criterion." }),
]);
const testStrengthLevels = Object.freeze([
    Object.freeze({ level: 0, anchor: "Tests do not exercise the changed behavior or its failure paths." }),
    Object.freeze({ level: 1, anchor: "Tests cover only a happy path and cannot catch material regressions." }),
    Object.freeze({ level: 2, anchor: "Tests cover core behavior but omit important negative or adversarial cases." }),
    Object.freeze({ level: 3, anchor: "Tests cover core, negative, and relevant adversarial behavior with minor gaps." }),
    Object.freeze({ level: 4, anchor: "Tests strongly exercise every material invariant and demonstrated failure mode." }),
]);
const scopeDisciplineLevels = Object.freeze([
    Object.freeze({ level: 0, anchor: "The change escapes the approved write set or substantially exceeds the slice." }),
    Object.freeze({ level: 1, anchor: "The change includes material unrelated work or avoidable scope expansion." }),
    Object.freeze({ level: 2, anchor: "The change is mostly bounded but contains notable nonessential work." }),
    Object.freeze({ level: 3, anchor: "The change stays within scope with only minor avoidable complexity." }),
    Object.freeze({ level: 4, anchor: "The change is the smallest complete implementation within the exact write set." }),
]);
const maintainabilityLevels = Object.freeze([
    Object.freeze({ level: 0, anchor: "The result violates the referenced design or creates an unsafe architectural conflict." }),
    Object.freeze({ level: 1, anchor: "The result materially diverges from established architecture or is difficult to maintain." }),
    Object.freeze({ level: 2, anchor: "The result is serviceable but has clear consistency or maintenance weaknesses." }),
    Object.freeze({ level: 3, anchor: "The result follows the referenced design and local conventions with minor friction." }),
    Object.freeze({ level: 4, anchor: "The result is clear, cohesive, and fully consistent with the referenced design." }),
]);
const evidenceLevels = Object.freeze([
    Object.freeze({ level: 0, anchor: "No reproducible command evidence supports the result." }),
    Object.freeze({ level: 1, anchor: "Evidence is incomplete, ambiguous, or cannot be independently reproduced." }),
    Object.freeze({ level: 2, anchor: "Evidence proves part of the result but leaves material claims unsupported." }),
    Object.freeze({ level: 3, anchor: "Evidence is reproducible and supports all material claims with minor omissions." }),
    Object.freeze({ level: 4, anchor: "Evidence is complete, deterministic, reproducible, and directly tied to every claim." }),
]);
const residualRiskLevels = Object.freeze([
    Object.freeze({ level: 0, anchor: "Critical residual risk or unresolved major findings make the result unsafe." }),
    Object.freeze({ level: 1, anchor: "High residual risk or major open findings materially undermine confidence." }),
    Object.freeze({ level: 2, anchor: "Meaningful residual risks remain but are bounded and explicitly understood." }),
    Object.freeze({ level: 3, anchor: "Residual risk is low and open findings are minor or well mitigated." }),
    Object.freeze({ level: 4, anchor: "No material residual risk remains and confidence is supported by independent findings." }),
]);
export const GRADER_RUBRIC = Object.freeze([
    Object.freeze({
        id: "correctness-and-requirement-fit",
        weight: 25,
        levels: correctnessLevels,
        contractFields: Object.freeze(["slices[].requirementIds", "slices[].acceptance"]),
    }),
    Object.freeze({
        id: "test-strength-and-adversarial-coverage",
        weight: 20,
        levels: testStrengthLevels,
        contractFields: Object.freeze(["slices[].evidenceCommandIds", "parkRanger.testStrengthFindings"]),
    }),
    Object.freeze({
        id: "scope-discipline-and-minimal-change",
        weight: 15,
        levels: scopeDisciplineLevels,
        contractFields: Object.freeze(["slices[].writeSet", "validator.changedPaths"]),
    }),
    Object.freeze({
        id: "maintainability-and-architectural-consistency",
        weight: 15,
        levels: maintainabilityLevels,
        contractFields: Object.freeze(["slices[].designIds"]),
    }),
    Object.freeze({
        id: "evidence-quality-and-reproducibility",
        weight: 15,
        levels: evidenceLevels,
        contractFields: Object.freeze(["validator.commandEvidence"]),
    }),
    Object.freeze({
        id: "residual-risk-and-confidence",
        weight: 10,
        levels: residualRiskLevels,
        contractFields: Object.freeze(["task.risk", "parkRanger.openFindings"]),
    }),
]);
