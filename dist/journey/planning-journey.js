import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { BUILTIN_ROUTES, createAgentAdapter, MAX_BACKGROUND_BRIEF_CHARS } from "../adapters/adapters.js";
import { validateExecutionRoleBoundary, validateReviewerAuthorship } from "../execution/execution-mode.js";
import { createFocusContext, snapshotGitState, validateFocusCompletion } from "./focus-mode.js";
import { resolvePlanDirectory } from "./plan-resolution.js";
import { artifactComplete, parsePlanDocuments, sectionPresent, structuralFindings } from "./plan-structure.js";
import { advancePlanning, next, planningValidationSignal } from "./planning-state.js";
import { validatePlan } from "./planning-validator.js";
import { routeRecon } from "./recon.js";
import { FIT_EVIDENCE_KINDS, fitMalformed, validateFitReceipt } from "./repository-fit.js";
import { setBearingsWorkspace } from "./repository-map.js";
import { ROLE_KINDS, roleRoutesShape, SURVEYOR_FALLBACK_ROUTE } from "../contracts/execution-contract.js";
import { validateScope } from "../verification/validator.js";
function validationRecord(verdict, currentContentHash = verdict.checkedContentHash) {
    return { ...verdict, currentContentHash };
}
export function orchestratePlanning(input) {
    const artifacts = input.artifacts ?? [];
    const record = (state, signal, validation) => advancePlanning(state, signal, validation);
    if (input.failureSignal) {
        const planningState = record(input.currentState, input.failureSignal);
        return planningState === "illegal_transition"
            ? { refused: planningState, findings: [], artifacts }
            : { planningState, findings: [], artifacts };
    }
    if (input.pass === "set-bearings") {
        return input.currentState === "DRAFT"
            ? { planningState: input.currentState, findings: [], artifacts }
            : { refused: "illegal_transition", findings: [], artifacts };
    }
    if (input.pass === "gather-supplies") {
        const planningState = record(input.currentState, "requirementsReady");
        return planningState === "illegal_transition"
            ? { refused: planningState, findings: [], artifacts }
            : { planningState, findings: [], artifacts };
    }
    if (input.pass === "recon") {
        const routed = routeRecon(input.recon);
        if (!routed.ok)
            return { refused: "illegal_transition", findings: routed.issues, artifacts };
        if (routed.state === "SKIPPED" || routed.state === "RECON_PENDING" || routed.state === "ARCHITECTURE_READY") {
            return { planningState: input.currentState, findings: [], artifacts };
        }
        const signal = routed.state === "RECON_READY"
            ? "reconReady"
            : routed.state === "RECON_FAILED"
                ? "reconFailed"
                : "ownerDecisionRequired";
        const planningState = record(input.currentState, signal);
        return planningState === "illegal_transition"
            ? { refused: planningState, findings: [], artifacts }
            : { planningState, findings: [], artifacts };
    }
    if (input.pass === "map-the-route") {
        if (input.currentState === "ARCHITECTURE_READY")
            return { planningState: input.currentState, findings: [], artifacts };
        // A plan that failed validation re-enters through map-the-route without
        // repeating architecture. architectureReady is illegal from those three
        // states; executionPlanReady is the recovery edge the transition table
        // defines for them, and planningCheckpointFields completes the recovery with
        // planningValidated. Splitting this pass in two must not drop that path.
        const signal = input.currentState === "REQUIREMENTS_READY" || input.currentState === "DESIGN_CONFLICT"
            ? "architectureReady"
            : input.currentState === "MISSING_VALIDATION"
                || input.currentState === "UNSAFE_PARALLELISM"
                || input.currentState === "OWNER_DECISION_REQUIRED"
                ? "executionPlanReady"
                : undefined;
        if (!signal)
            return { refused: "illegal_transition", findings: [], artifacts };
        const planningState = record(input.currentState, signal);
        return planningState === "illegal_transition"
            ? { refused: planningState, findings: [], artifacts }
            : { planningState, findings: [], artifacts };
    }
    if (input.pass === "draft-implementation") {
        const planningState = record(input.currentState, "executionPlanReady");
        return planningState === "illegal_transition"
            ? { refused: planningState, findings: [], artifacts }
            : { planningState, findings: [], artifacts };
    }
    let findings = input.planningValidation?.findings ?? [];
    let planningValidation = input.planningValidation;
    if (input.documents && input.planDirectory) {
        const current = validatePlan({ documents: input.documents, planDirectory: input.planDirectory });
        findings = current.findings;
        planningValidation = input.planningValidation
            ? { ...input.planningValidation, currentContentHash: current.checkedContentHash }
            : validationRecord(current);
    }
    const signal = planningValidationSignal(planningValidation);
    if (!signal || !planningValidation)
        return { refused: "illegal_transition", findings, artifacts };
    const planningState = record(input.currentState, signal, planningValidation);
    return planningState === "illegal_transition"
        ? { refused: planningState, findings, artifacts }
        : { planningState, findings, artifacts, planningValidation };
}
export function planningCheckpointFields(input) {
    if (input.previousState === undefined)
        return {};
    if (input.status === "complete") {
        if (input.stage === "recon") {
            const recon = orchestratePlanning({ currentState: input.previousState, pass: "recon", recon: input.recon });
            if ("refused" in recon)
                return { refused: recon.refused };
            return recon.planningState === "RECON_FAILED" || recon.planningState === "OWNER_DECISION_REQUIRED"
                ? { planningFailure: recon.planningState }
                : { planningState: recon.planningState };
        }
        if (input.stage === "map-route") {
            const recoveringFailedPlan = input.previousState === "MISSING_VALIDATION"
                || input.previousState === "UNSAFE_PARALLELISM"
                || input.previousState === "OWNER_DECISION_REQUIRED";
            const mapped = orchestratePlanning({ currentState: input.previousState, pass: "map-the-route" });
            if ("refused" in mapped)
                return { refused: mapped.refused };
            if (recoveringFailedPlan && !input.planningValidation) {
                const planningState = next(mapped.planningState, "planningValidated");
                return planningState === "illegal_transition"
                    ? { refused: planningState }
                    : { planningState };
            }
            if (!input.planningValidation)
                return { planningState: mapped.planningState };
            const validated = orchestratePlanning({ currentState: mapped.planningState, pass: "planning-validator", planningValidation: input.planningValidation });
            if ("refused" in validated)
                return { refused: validated.refused };
            return planningValidationSignal(input.planningValidation) === "planningValidated"
                ? { planningState: validated.planningState }
                : { planningFailure: validated.planningState };
        }
        if (input.stage === "gather-supplies") {
            const gathered = orchestratePlanning({ currentState: input.previousState, pass: "gather-supplies" });
            return "refused" in gathered ? { refused: gathered.refused } : { planningState: gathered.planningState };
        }
        if (input.stage !== "draft-implementation")
            return {};
        const mapped = orchestratePlanning({ currentState: input.previousState, pass: "draft-implementation" });
        if ("refused" in mapped)
            return { refused: mapped.refused };
        if (!input.planningValidation)
            return { planningState: mapped.planningState };
        const validated = orchestratePlanning({ currentState: mapped.planningState, pass: "planning-validator", planningValidation: input.planningValidation });
        if ("refused" in validated)
            return { refused: validated.refused };
        return planningValidationSignal(input.planningValidation) === "planningValidated"
            ? { planningState: validated.planningState }
            : { planningFailure: validated.planningState };
    }
    if (input.status !== "failed" || input.failureReason === undefined)
        return {};
    let previousState = input.previousState;
    if (input.stage === "map-route" && input.failureStage === "draft-implementation") {
        const mapped = orchestratePlanning({ currentState: previousState, pass: "map-the-route" });
        if ("refused" in mapped)
            return { refused: mapped.refused };
        previousState = mapped.planningState;
    }
    const failureStage = input.failureStage ?? input.stage;
    const signals = failureStage === "gather-supplies"
        ? ["requirementsGap"]
        : failureStage === "map-route"
            ? ["designConflict"]
            : failureStage === "recon"
                ? ["reconFailed"]
                : failureStage === "draft-implementation"
                    ? ["missingValidation", "unsafeParallelism", "ownerDecisionRequired"]
                    : [];
    for (const signal of signals) {
        const pass = input.stage === "gather-supplies" ? "gather-supplies" : input.stage === "recon" ? "recon" : "map-the-route";
        const projected = orchestratePlanning({ currentState: previousState, pass, failureSignal: signal });
        if (!("refused" in projected) && projected.planningState === input.failureReason)
            return { planningFailure: projected.planningState };
    }
    return { refused: "illegal_transition" };
}
const FOCUS_PLAN_SOURCES = ["plan-spec.md", "design.md", "seit.md", "implementation.md"];
function malformedFitResult(tokens, check, field) {
    return { status: "failure", code: "fit_malformed", fitDiagnostic: fitMalformed(check, field).diagnostic, tokens };
}
/** Smallest shared derivation for the durable free-text decision question shown for recon OWNER_DECISION_REQUIRED. */
export function reconOwnerDecisionQuestion(recon) {
    const report = recon.report;
    const keys = ["cost", "architecture", "scope", "risk"];
    const mat = keys.filter((k) => report.materialChange[k]).join(", ");
    const rec = report.recommendation ?? "decide";
    const base = mat ? `Recon material change (${mat}).` : "Recon requires owner decision.";
    return `${base} Agent recommendation: ${rec}. Enter your free-text decision and rationale to resume the same planning stage.`;
}
const STAGE_SKILLS = {
    "repository-fit": ["repository-fit"],
    "set-bearings": ["navigator", "set-bearings"],
    "gather-supplies": ["navigator", "gather-supplies"],
    "map-route": ["navigator", "map-the-route"],
    recon: ["navigator"],
    "draft-implementation": ["navigator", "map-the-route"],
    "execute-explorer": ["explorer", "crewmate", "surveyor"],
    "execute-expedition": ["navigator", "explorer", "crewmate", "surveyor"],
    review: ["surveyor"],
};
const STAGE_BOUNDARY = {
    "repository-fit": "Inspect only the bounded selected-repository evidence and propose one repository and plan-directory assumption for owner confirmation. Do not write, create a directory, or continue into Set Bearings.",
    "set-bearings": "Create or resume only the plan directory and plan-spec.md stub. Bearing may retain a bounded repository inventory as internal runtime evidence, but plan-local prompt persistence is not required. Do not grill, design, draft implementation.md, or implement the work.",
    "gather-supplies": "Use the complete owner Q&A and update only the validated plan specification. Do not run design, draft implementation.md, or implement the work. Return an action receipt whose artifacts include the validated plan-spec.md path.",
    "map-route": "Use the design substep of Map the Route. Before writing any design artifact, stop at its normal owner lens-approval question when lens approval is not already recorded in the prior owner Q&A. After approval, produce valid complete or amended design.md and seit.md, including stable DES/CONTRACT IDs, Use Cases and Communication Flows, Interface Option Check, OOPDSA Implementation Design, and the prospective SEIT Traceability Matrix. Bearing generates review.html deterministically from the current Markdown sources; do not write or summarize review.html. Stop at the design-and-SEIT validation checkpoint. Do not write implementation.md or execute implementation in this substep. A successful action receipt must include design.md and seit.md in the validated plan directory.",
    recon: "After architecture and before implementation drafting, run at most one smallest bounded experiment for one material assumption. If no material assumption needs Recon, return the explicit skipped Recon receipt with no brief, report, or artifacts. Otherwise return one complete brief and matching report in the Recon receipt; a brief without its report is incomplete. Prototype paths remain non-production and must be returned as the complete artifact list. Do not draft implementation.md or execute implementation.",
    "draft-implementation": "Continue the implementation-drafting substep of Map the Route after the validated design and SEIT checkpoint. Draft implementation.md without executing any slice. Keep each slice reference-only with Goal, Requirement IDs, Design IDs, SEIT proof rows, Type, Design lenses, Implementation role, Agent model route, Agent reasoning level, and Review path. Ponytail mode is optional; when present, use the lowercase value `full` or `off`; trailing sentence punctuation such as `full.` is normalized. Requirement, design, and SEIT IDs must exist in their owning documents and each slice's referenced SEIT rows must map its requirement and design IDs. Follow every slice with a matching `### <slice-id> execution manifest` containing Write set, Command IDs, Stop condition, and Human decision. Close each write set with `only` and exact backticked paths, or explicitly declare no writes. Command IDs must be defined in seit.md and mapped by the slice's SEIT proof rows. Declare contiguous Wave 1 through Wave N dependencies when there is more than one slice. Do not restate acceptance, design contracts, test cases, commands, evidence, or execution packet prose. Preserve per-slice assignments for execution; do not replace them with onboarding settings. The Review path must use the harness-native reviewer when available or the Surveyor fallback when unavailable. Bearing generates review.html deterministically from plan-spec.md, design.md, seit.md, and implementation.md; do not write or summarize it. Read the plan's recorded \"## Role routes\" decision and honor those exact primary and ordered fallback routes for delegation; never substitute the onboarding provider or model selection when a role route is missing. A successful action receipt must include implementation.md.",
    "execute-explorer": "Execute the approved implementation plan with Explorer and honor each recorded slice model route, reasoning level, Ponytail mode, and review cadence. Do not overwrite slice assignments with onboarding settings. After implementation and validation, replace the one Bearing-owned `<section id=\"bearing-final-qa\" data-status=\"pending\">` baseline with exactly one `<section id=\"bearing-final-qa\" data-status=\"complete\">` containing non-empty `Planned versus actual: <evidence>` and `Validation evidence: <evidence>` text. Put each labeled value in its own attribute-free `<p>` and use plain text only: no nested HTML, markup, `<`, or `>` in either evidence value. Preserve every current embedded planning source and canonical source link. The action receipt must include review.html and every actual changed artifact. Return only paths that actually exist.",
    "execute-expedition": "Execute the approved implementation plan with Expedition and honor each recorded slice model route, reasoning level, Ponytail mode, and review cadence. Do not overwrite slice assignments with onboarding settings. After implementation and validation, replace the one Bearing-owned `<section id=\"bearing-final-qa\" data-status=\"pending\">` baseline with exactly one `<section id=\"bearing-final-qa\" data-status=\"complete\">` containing non-empty `Planned versus actual: <evidence>` and `Validation evidence: <evidence>` text. Put each labeled value in its own attribute-free `<p>` and use plain text only: no nested HTML, markup, `<`, or `>` in either evidence value. Preserve every current embedded planning source and canonical source link. The action receipt must include review.html and every actual changed artifact. Return only paths that actually exist.",
    review: "Perform a read-only review of the integrated uncommitted work. Do not modify files. Return existing evidence paths relevant to the review.",
};
function nextStage(stage) { return stage === "repository-fit" ? "set-bearings" : stage === "set-bearings" ? "gather-supplies" : stage === "gather-supplies" ? "map-route" : stage === "map-route" ? "recon" : stage === "recon" ? "draft-implementation" : stage === "draft-implementation" ? "execute" : "review"; }
const MAX_TEXT = 4096;
const MAX_QA = 64;
const MAX_GATHER_QUESTIONS = 3;
const MAX_ARTIFACTS = 32;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_ESTIMATE_BASIS = 280;
const MAX_ACTIVITY_TRAIL = 20;
const BACKGROUND_BRIEF_STAGES = ["gather-supplies", "map-route", "recon", "draft-implementation"];
const SAFE_ACTIVITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET_ACTIVITY = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/i;
function text(value, max = MAX_TEXT) {
    return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function pathText(value) { return text(value) && !/[\\\r\n\t]/.test(value); }
function focusRejectionStatus(failure) {
    const segment = (value, fallback) => (value ?? fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || fallback;
    return [
        segment(failure.reason, "invalid"),
        segment(failure.sliceId, "unknown"),
        segment(failure.field, "unknown"),
    ].join(":").slice(0, 128);
}
function sameRoute(left, right) {
    return left.provider === right.provider && left.model === right.model;
}
async function containedPath(root, value, directoryOnly = false) {
    if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value)
        return undefined;
    const candidate = resolve(root, value);
    const lexical = relative(root, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical))
        return undefined;
    try {
        const canonical = await realpath(candidate);
        const relation = relative(root, canonical);
        if (!relation || relation.startsWith("..") || isAbsolute(relation))
            return undefined;
        if (directoryOnly && !(await lstat(canonical)).isDirectory())
            return undefined;
        return value;
    }
    catch {
        return undefined;
    }
}
function validRequest(request) {
    if (!isAbsolute(request.repositoryPath) || !/^[A-Za-z0-9_-]{1,128}$/.test(request.runId) || !text(request.workGoal))
        return false;
    if (!(request.stage in STAGE_SKILLS) || !Array.isArray(request.priorOwnerQa) || request.priorOwnerQa.length > MAX_QA)
        return false;
    return (request.gatherMode === undefined || request.stage === "gather-supplies") &&
        (request.requestedPlanDirectory === undefined || request.stage === "set-bearings" && pathText(request.requestedPlanDirectory)) &&
        (request.providerSessionId === undefined || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.providerSessionId)) &&
        (request.reviewPrompt === undefined || text(request.reviewPrompt)) &&
        (request.gateFailureFingerprint === undefined || text(request.gateFailureFingerprint, 512)) &&
        (request.currentSlice === undefined || (request.stage === "execute-explorer" || request.stage === "execute-expedition") && /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/.test(request.currentSlice)) &&
        (request.focusAmendmentConfirmed === undefined || typeof request.focusAmendmentConfirmed === "boolean") &&
        request.priorOwnerQa.every((entry) => typeof entry === "object" && entry !== null && text(entry.question) && text(entry.answer));
}
const MAX_PACKAGED_SKILL_BYTES = 64 * 1024;
async function packagedSkills(stage) {
    const sources = await Promise.all(STAGE_SKILLS[stage].map(async (name) => {
        const source = await readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
        if (Buffer.byteLength(source) > MAX_PACKAGED_SKILL_BYTES || /\u0000/.test(source) || !new RegExp(`^---\\r?\\nname: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\ndescription: [^\\r\\n]+\\r?\\nuser-invocable: false\\r?\\ndisable-model-invocation: true\\r?\\n---(?:\\r?\\n|$)`).test(source))
            throw new Error("packaged skill invalid");
        return `### ${name}\n${source}`;
    }));
    return ["Packaged Bearing skills (authoritative workflow instructions for this stage):", ...sources].join("\n\n");
}
/** The durable owner Q&A question marking a recorded role-route decision; an exact repeat suppresses re-asking. */
export const ROLE_ROUTES_QUESTION = `Which agent should be primary and which ordered fallbacks are authorized for each required role (${ROLE_KINDS.join(", ")})?`;
const ROLE_ROUTES_HEADING = "Role routes";
const ROLE_ROUTE_LINE = /^-\s+\*\*([a-z][a-z-]*)\*\*\s+[—-]\s+primary:\s+`([^`\r\n]+)`;\s+fallbacks:\s+(none|`[^`\r\n]+`(?:,\s*`[^`\r\n]+`)*)\s*$/gmi;
/** Renders the owner's exact primary/fallback decision as the plan-spec.md "Role routes" section. */
export function renderRoleRoutesSection(routes) {
    const lines = routes.map((route) => `- **${route.role}** — primary: \`${route.primary}\`; fallbacks: ${route.fallbacks.length ? route.fallbacks.map((fallback) => `\`${fallback}\``).join(", ") : "none"}`);
    return `## ${ROLE_ROUTES_HEADING}\n\n${lines.join("\n")}\n`;
}
/** Parses the durable "Role routes" decision back out of plan-spec.md; undefined when absent or incomplete. */
export function parseRoleRoutesSection(planSpec) {
    const section = new RegExp(`^##[ \\t]+${ROLE_ROUTES_HEADING}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(planSpec)?.[1];
    if (!section)
        return undefined;
    const candidates = [];
    for (const match of section.matchAll(ROLE_ROUTE_LINE)) {
        const fallbacks = match[3].toLowerCase() === "none" ? [] : [...match[3].matchAll(/`([^`]+)`/g)].map((fallback) => fallback[1]);
        candidates.push({ role: match[1], primary: match[2], fallbacks });
    }
    return roleRoutesShape(candidates) ? candidates : undefined;
}
// ==== Issue 83: durable owner decisions ====
/** The one artifact a Gather Supplies owner decision affects; the stage writes only plan-spec.md. */
export const OWNER_DECISION_ARTIFACT = "plan-spec.md";
/**
 * Volatile labeled parts of a Gather Supplies question. The gather-supplies
 * skill mandates the explicit ask FIRST, then the labeled details
 * Recommendation, Evidence, Options, Affected section, and Safe default.
 * Options and safe defaults may change between runs without the decision
 * changing, so the canonical question identity is the ask BEFORE the first
 * label; a question without any label is its own identity verbatim.
 */
const OWNER_QUESTION_LABELS = /\*\*(?:Recommendation|Evidence|Options|Affected section|Safe default):?\*\*/g;
/** Marker Bearing places at the end of a composed amendment; stripped before fingerprinting so the amendment's identity is the changed question's ask. */
const AMENDMENT_CONTEXT_MARKER = "[Amendment context";
function stripAmendmentContext(question) {
    const index = question.indexOf(AMENDMENT_CONTEXT_MARKER);
    return index < 0 ? question : question.slice(0, index).trimEnd();
}
function normalizedStem(value) {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
/**
 * The canonical question ask: the text before the first known label, with any
 * Bearing amendment context removed. Everything after the ask is volatile
 * detail (recommendation, evidence, options, section, safe default) and is
 * excluded, so a re-ask with changed forced options keeps the same identity.
 * Falls back to the full question when nothing precedes the labels, so a
 * legacy free-form question is its own stable identity.
 */
export function ownerDecisionStem(question) {
    const stripped = stripAmendmentContext(question);
    const ask = beforeFirstLabel(stripped).trim();
    return normalizedStem(ask || stripped);
}
function beforeFirstLabel(question) {
    OWNER_QUESTION_LABELS.lastIndex = 0;
    const match = OWNER_QUESTION_LABELS.exec(question);
    return match === null ? question : question.slice(0, match.index);
}
function sectionValue(value) {
    const trimmed = value?.trim().replace(/\.+$/, "");
    return trimmed || undefined;
}
/** The plan-spec section a decision affects, when the question names one; the Role routes question is server-authored and affects the "Role routes" section. */
export function ownerDecisionSection(question) {
    if (question === ROLE_ROUTES_QUESTION)
        return ROLE_ROUTES_HEADING;
    const match = /\*\*Affected section:?\*\*[ \t]*([^\r\n*]+)/i.exec(stripAmendmentContext(question));
    return sectionValue(match?.[1]);
}
/**
 * Canonical decision identity: the ask, the affected section when named, and
 * the recommendation and evidence that carry the decision's substance. Options
 * and safe defaults are volatile — they may change between runs without the
 * decision changing — but a changed recommendation or evidence means a
 * different decision was asked, so exact reuse must not conflate the two.
 */
export function ownerDecisionFingerprint(question) {
    const section = ownerDecisionSection(question);
    const recommendation = labeledValue(question, "Recommendation");
    const evidence = labeledValue(question, "Evidence");
    const ask = section === undefined ? ownerDecisionStem(question) : `${ownerDecisionStem(question)}|${normalizedStem(section)}`;
    return `${ask}|${recommendation === undefined ? "" : normalizedStem(recommendation)}|${evidence === undefined ? "" : normalizedStem(evidence)}`;
}
export function deriveOwnerDecisions(priorOwnerQa) {
    return priorOwnerQa.map((entry, revision) => {
        const affectedSection = ownerDecisionSection(entry.question);
        const fingerprint = ownerDecisionFingerprint(entry.question);
        return {
            decisionId: `decision-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`,
            fingerprint,
            stem: ownerDecisionStem(entry.question),
            question: entry.question,
            answer: entry.answer,
            artifact: OWNER_DECISION_ARTIFACT,
            affectedSection,
            revision,
        };
    });
}
function labeledValue(question, label) {
    const match = new RegExp(`\\*\\*${label}:?\\*\\*[ \\t]*([^\\r\\n*]+)`, "i").exec(question);
    const value = match?.[1]?.trim().replace(/\.+$/, "");
    return value || undefined;
}
function boundedDecisionText(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
/**
 * Composes the explicit amendment for a question that changed substance in a
 * decision area with a recorded decision: the changed question in full, then a
 * context block naming the prior decision, its accepted answer, and the
 * changed options. The whole text must stay within the 4096-character owner
 * Q&A bound so a later run's request still validates; when the changed
 * question alone leaves no room for context, the question degrades to a plain
 * ask — the recorded decision is never overwritten either way.
 */
function composeAmendment(prior, candidate) {
    const sectionPhrase = prior.affectedSection === undefined
        ? ""
        : ` for the plan-spec "${boundedDecisionText(prior.affectedSection, 60)}" section`;
    const sectionSentence = sectionPhrase ? `The question${sectionPhrase} changed.` : "The question for this decision changed.";
    const priorOptions = labeledValue(prior.question, "Options");
    const candidateOptions = labeledValue(candidate, "Options");
    const changedOptions = priorOptions !== undefined && candidateOptions !== undefined && priorOptions !== candidateOptions
        ? ` Options changed to: ${boundedDecisionText(candidateOptions, 160)} (was: ${boundedDecisionText(priorOptions, 160)}).`
        : "";
    const template = (questionSlot, answerSlot) => `[Amendment context — prior decision ${prior.decisionId}: "${questionSlot}" — accepted answer: "${answerSlot}". ${sectionSentence}${changedOptions} The prior answer stands until you amend it explicitly; a safe default is never applied over it.]`;
    const overhead = candidate.length + 2 + template("", "").length;
    if (overhead + 32 > MAX_TEXT)
        return candidate;
    const slot = Math.min(512, Math.floor((MAX_TEXT - overhead) / 2));
    return `${candidate}\n\n${template(boundedDecisionText(prior.question, slot), boundedDecisionText(prior.answer, slot))}`;
}
/**
 * Resolves the model-returned Gather Supplies question set against the durable
 * owner decisions (issue 83). A question whose canonical identity — ask,
 * affected section, recommendation, and evidence — was already accepted is
 * dropped, so the recorded answer is reused on every later run: a re-ask whose
 * forced options exclude the accepted free-text answer can never make it
 * unrepresentable, and a safe default is never applied over it. A question
 * that shares only its ask or section with a recorded decision but changed
 * substance (or asks something different in the same decision area) becomes
 * an explicit amendment presenting the prior decision — it is never silently
 * dropped. Anything else passes through unchanged.
 */
export function resolveGatherQuestions(candidates, priorOwnerQa) {
    const decisions = deriveOwnerDecisions(priorOwnerQa);
    const byFingerprint = new Map();
    const byStem = new Map();
    const bySection = new Map();
    for (const decision of decisions) {
        byFingerprint.set(decision.fingerprint, decision);
        byStem.set(decision.stem, decision);
        if (decision.affectedSection !== undefined)
            bySection.set(normalizedStem(decision.affectedSection), decision);
    }
    const resolved = [];
    for (const candidate of candidates) {
        if (byFingerprint.has(ownerDecisionFingerprint(candidate)))
            continue;
        const stem = ownerDecisionStem(candidate);
        const section = ownerDecisionSection(candidate);
        const prior = byStem.get(stem) ?? (section === undefined ? undefined : bySection.get(normalizedStem(section)));
        resolved.push(prior === undefined ? candidate : composeAmendment(prior, candidate));
    }
    return resolved;
}
function answeredDecisionsLine(decisions) {
    return decisions.length
        ? `\nAnswered decisions (never re-ask; reuse the recorded answer):\n${decisions.map((decision) => `- ${decision.decisionId}: ${boundedDecisionText(decision.stem, 160)}${decision.affectedSection === undefined ? "" : ` (${decision.affectedSection})`}`).join("\n")}`
        : "";
}
function prompt(request, planDirectory, skillInstructions, focus) {
    const gatheringQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions";
    const availableQuestions = Math.min(MAX_GATHER_QUESTIONS, Math.max(0, MAX_QA - request.priorOwnerQa.length));
    const roleRoutesAnswered = request.priorOwnerQa.some((entry) => entry.question === ROLE_ROUTES_QUESTION);
    const answeredDecisions = answeredDecisionsLine(deriveOwnerDecisions(request.priorOwnerQa));
    const grilling = gatheringQuestions
        ? ` Inspect the repository once and return at most ${availableQuestions} unresolved owner questions. Ask only when the answer materially changes scope, architecture, security, authority, or acceptance. Lead each question with **Recommendation:**, then give concise evidence, 2-3 viable options with material tradeoffs, the affected plan-spec section, and the safe default if unanswered; ask the owner to select explicitly. A recommendation is advice, never approval. State safe defaults as assumptions instead of questions when no owner choice is required. Return an empty array when no material owner decision remains.${answeredDecisions} Never re-ask a decision already recorded in the Prior owner Q&A; reuse its recorded answer unchanged on every later run, including when its options or safe default changed. Bearing drops any re-asked decision and reuses the recorded answer, and presents a question changed in substance as an explicit amendment of the prior decision.${roleRoutesAnswered ? "" : ` Ask exactly this question verbatim among them: ${JSON.stringify(ROLE_ROUTES_QUESTION)} Offer only ${JSON.stringify(BUILTIN_ROUTES.map((route) => route.id))} as primary or fallback choices, plus ${JSON.stringify(SURVEYOR_FALLBACK_ROUTE)} as an additional allowed fallback for review-general and review-security only; a role may have zero fallbacks. Never ask for credentials.`}`
        : request.stage === "gather-supplies"
            ? ` All grilling questions are answered. Apply the complete owner Q&A without asking another question; record reasonable assumptions or blockers in the plan specification. A recorded owner answer always wins over any safe default from the same question; never overwrite a recorded answer with a default or an assumption. Record the owner's exact answer to ${JSON.stringify(ROLE_ROUTES_QUESTION)} as a "## Role routes" section in plan-spec.md, one line per role in this exact format: "- **execution-author** — primary: \`codex\`; fallbacks: \`claude\`" or "- **review-general** — primary: \`claude\`; fallbacks: none". Never substitute the onboarding provider or model selection for a role route the owner did not answer.`
            : " Ask one owner question only when a decision blocks honest progress.";
    const boundary = gatheringQuestions ? "Read and inspect only. Do not create or modify files during question discovery." : STAGE_BOUNDARY[request.stage];
    const reviewCadence = request.stage === "execute-explorer" || request.stage === "execute-expedition" ? ["Read the prior owner Q&A for the recorded Review cadence (each slice, each phase, or end) and enforce that cadence during execution. Use the harness-native reviewer when available and the read-only Surveyor fallback only when no native reviewer is available."] : [];
    const cleanupSetting = [...request.priorOwnerQa].reverse().find((entry) => entry.question === "Cleanup merged worktrees")?.answer ?? "on";
    const cleanupPolicy = request.stage === "execute-explorer" || request.stage === "execute-expedition"
        ? [cleanupSetting === "off"
                ? "Preserve every temporary worktree and branch; the owner disabled automatic cleanup."
                : `Cleanup merged worktrees is on. Merge only through the approved integration or phase gate. Before removing a temporary worktree, prove that it is clean, its branch commit is merged into the integration branch, and no active review, retry, or recovery reference needs it. ${request.stage === "execute-explorer" ? "Clean eligible worktrees after each completed phase." : "Keep parallel lanes until the entire phase is integrated, then clean eligible worktrees."} Delete only the corresponding proven-merged temporary branch. Never force-remove a worktree or branch. Preserve every dirty, unmerged, failed, or blocked lane and report its path and branch with a Resume or Resolve next action.`]
        : [];
    const commandPolicy = request.stage === "execute-explorer" || request.stage === "execute-expedition"
        ? "Run only the selected slice commands during Focus; defer build and dist-guard to integrated closeout after Focus validates."
        : "Planning-only validation must not run build, dist-guard, formatters, or any command known to mutate tracked output.";
    const nextActionStage = nextStage(request.stage);
    const selectedRoute = BUILTIN_ROUTES.find((route) => route.provider === request.selection.provider && (route.model === "*" || route.model === request.selection.model));
    const routeCatalog = BUILTIN_ROUTES.map((route) => {
        const model = route === selectedRoute && request.selection.model !== "*" ? `${route.provider} ${request.selection.model}` : route.model === "*" ? `${route.provider} agent default` : route.id;
        return `${model} [${route.reasoningLevels.join(", ")}]`;
    }).join("; ");
    const estimateGuidance = request.stage === "gather-supplies" && request.gatherMode === "apply"
        ? "Estimate the entire upcoming Map the Route phase, including design.md, seit.md, baseline review.html, implementation.md, final review generation, validation, and all required agent round trips. Do not estimate from repository inspection size alone."
        : request.stage === "map-route"
            ? "When asking a blocking design question, estimate all remaining Map the Route work after the answer, including design, SEIT, review generation, implementation drafting, validation, and required agent round trips."
            : "Estimate the complete next phase, including required artifacts, validation, and agent round trips—not only repository inspection.";
    return [
        "You are a bounded Bearing journey agent. Work only inside the supplied repository and existing authority.",
        `Stage: ${request.stage}. Apply the embedded Bearing skill instructions for this stage.${grilling}`,
        skillInstructions,
        `Stage boundary: ${boundary}`,
        `Work goal: ${JSON.stringify(request.workGoal)}`,
        `The onboarding selection ${JSON.stringify(request.selection)} governs this top-level planning agent and the Explorer/Navigator session. Keep it for planning, design, and review. Implementation.md may record task-appropriate supported model routes and reasoning levels per coding slice; execution must honor those recorded assignments instead of overwriting them.`,
        `Accepted implementation route labels and supported reasoning levels: ${routeCatalog}. Use only one of these exact labels and one of its bracketed reasoning levels. Prefer the selected route ${JSON.stringify(selectedRoute ? (request.selection.model === "*" ? `${selectedRoute.provider} agent default` : `${selectedRoute.provider} ${request.selection.model}`) : `${request.selection.provider} ${request.selection.model}`)} when another route is not demonstrably available.`,
        `Estimate guidance: ${estimateGuidance} Keep the estimate basis at most ${MAX_ESTIMATE_BASIS} characters.`,
        `Prior owner Q&A: ${JSON.stringify(request.priorOwnerQa)}`,
        ...reviewCadence,
        ...cleanupPolicy,
        commandPolicy,
        `Validated plan directory: ${planDirectory ? JSON.stringify(planDirectory) : "none"}`,
        ...(planDirectory && request.stage !== "repository-fit" && request.stage !== "set-bearings" ? ["Reuse current session context and perform only bounded live verification when necessary. Do not require or create plan-local prompt artifacts."] : []),
        ...(request.reviewPrompt ? [`Review guidance: ${JSON.stringify(request.reviewPrompt)}`] : []),
        ...(focus ? [
            `BEARING_FOCUS ${JSON.stringify(focus.envelope)}`,
            "Bearing Focus mode is active. Act only on acceptance, required evidence, or the current blocker. Preserve this envelope when delegating a bounded subset to Crewmates. Runtime validation will reject out-of-scope paths, incomplete receipts, missing command evidence, and false completion even if provider hooks are unavailable.",
        ] : []),
        ...(request.stage === "repository-fit" ? [`Repository-fit evidence kind is a closed vocabulary: ${JSON.stringify(FIT_EVIDENCE_KINDS)}. Use no other value.`] : []),
        "Do not claim completion without actual work and evidence in this agent receipt. Do not invent artifacts, routes, sessions, or authority.",
        request.stage === "repository-fit"
            ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"fit","ok":true,"assumption":{"repository":"absolute selected repository","planDirectory":"docs/plans/valid-relative-path","rationale":"evidence-backed reason","evidence":[{"kind":"manifest","path":"package.json","detail":"bounded evidence"}]},"question":"one owner confirmation question"} or BEARING_RESULT {"kind":"fit","ok":false,"reason":"fit_unavailable|fit_malformed|fit_undecidable"}.'
            : gatheringQuestions
                ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"questions","questions":["first question","second question"],"nextStageEstimate":{"stage":"gather-supplies","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific workload basis"}}. Replace the uppercase placeholders with your honest integer estimate; do not copy a canned duration. Use an empty array when no owner decisions are needed. The optional estimate covers the remaining Gather Supplies apply/write step; omit it when you cannot honestly estimate it.'
                : request.stage === "gather-supplies" && request.gatherMode === "apply"
                    ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"],"nextStageEstimate":{"stage":"map-route","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific full-phase workload basis"}}. Replace the uppercase placeholders with your honest integer estimate; do not copy a canned duration. The optional estimate covers the complete Map the Route phase; omit it when you cannot honestly estimate it.'
                    : request.stage === "recon"
                        ? 'End the final assistant message with exactly one single-line envelope. To skip optional Recon: BEARING_RESULT {"kind":"recon","summary":"why no material assumption needs Recon","artifacts":[]}. To complete Recon: BEARING_RESULT {"kind":"recon","summary":"what the experiment established","artifacts":["every relative existing prototype path"],"brief":{"assumptionId":"bounded id","assumption":"one material assumption","materiality":["architecture"],"falsificationCriterion":"measurable criterion","smallestExperiment":"bounded experiment","writeSet":["literal/relative/path"],"evidenceCommandIds":["CMD-ID"],"timeboxMinutes":MINUTES},"report":{"assumptionId":"same bounded id","measurements":[{"name":"measurement","value":"observed value","method":"method"}],"feasibilityEvidence":["evidence"],"constraints":["constraint"],"rejectedOptions":[{"option":"option","reason":"reason"}],"recommendation":"proceed","materialChange":{"cost":false,"architecture":false,"scope":false,"risk":false},"prototypePaths":["literal/relative/path"],"productionEligible":false},"nextStageEstimate":{"stage":"draft-implementation","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific drafting workload basis"}}. Replace placeholders with actual values; valid materiality values are cost, architecture, scope, and risk, and the valid recommendations are proceed, revise, and stop. Return both brief and report together; a brief-only result is incomplete. Omit nextStageEstimate when you cannot honestly estimate it.'
                        : focus
                            ? `End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"question","question":"one blocking question"} or BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["every relative path changed during this invocation"],"evidence":[{"commandId":"CMD-ID","status":"passed","summary":"bounded observed result"}]}. On success include every command ID from BEARING_FOCUS exactly once. Never mark failed, skipped, missing, unknown, or duplicate evidence as passed.`
                            : `End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"question","question":"one blocking question","nextStageEstimate":{"stage":"${request.stage}","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific remaining-work basis"}} or BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"],"nextStageEstimate":{"stage":"${nextActionStage}","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific full-phase workload basis"}}. Replace the uppercase placeholders with honest integer estimates; do not copy a canned duration. A question estimate covers all work remaining in the same stage after the answer. Omit nextStageEstimate when you cannot honestly estimate it.`,
    ].join("\n");
}
function backgroundBriefPrompt(request, planDirectory) {
    return [
        "You are producing a bounded read-only background planning brief.",
        `Stage: ${request.stage}. Work goal: ${JSON.stringify(request.workGoal)}.`,
        `Validated plan directory: ${planDirectory ? JSON.stringify(planDirectory) : "none"}.`,
        `Prior owner decisions: ${JSON.stringify(request.priorOwnerQa).slice(0, MAX_BACKGROUND_BRIEF_CHARS)}.`,
        "Inspect existing repository context only and return one concise evidence-backed brief for the foreground planner.",
        "Do not write, execute, ask questions, request approval, claim a receipt, name artifacts as completed, or report validation. The foreground planner alone owns questions, approvals, receipts, artifacts, writes, execution, and validation.",
        `Keep the brief at most ${MAX_BACKGROUND_BRIEF_CHARS} characters.`,
    ].join("\n");
}
function estimate(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const item = value;
    return Object.keys(item).length === 4 && typeof item.stage === "string" && (item.stage === "execute" || item.stage in STAGE_SKILLS) &&
        typeof item.minMinutes === "number" && Number.isSafeInteger(item.minMinutes) && item.minMinutes >= 1 && item.minMinutes <= 1_440 &&
        typeof item.maxMinutes === "number" && Number.isSafeInteger(item.maxMinutes) && item.maxMinutes >= item.minMinutes && item.maxMinutes <= 1_440 && text(item.basis, MAX_ESTIMATE_BASIS);
}
function optionalEstimate(value) {
    if (value === undefined)
        return {};
    if (estimate(value))
        return { value };
    const basis = typeof value === "object" && value !== null && !Array.isArray(value) ? value.basis : undefined;
    return { dropped: typeof basis === "string" && basis.length > MAX_ESTIMATE_BASIS ? "basis_too_long" : "invalid" };
}
function commandEvidence(value) {
    return Array.isArray(value) && value.length <= 128 && value.every((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
            return false;
        const item = entry;
        return Object.keys(item).length === 3 && Object.keys(item).every((key) => ["commandId", "status", "summary"].includes(key)) &&
            typeof item.commandId === "string" && /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/.test(item.commandId) &&
            (item.status === "passed" || item.status === "failed") && text(item.summary, 512);
    });
}
function envelope(value, maxQuestions = MAX_QA - 1, fitRepository) {
    const line = value.trim().split(/\r?\n/).at(-1) ?? "";
    const prefix = "BEARING_RESULT ";
    if (!line.startsWith(prefix))
        return "missing";
    const body = line.slice(prefix.length);
    if (!body || Buffer.byteLength(body) > MAX_ENVELOPE_BYTES)
        return "malformed";
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return "malformed";
        const record = parsed;
        if (fitRepository !== undefined) {
            if (record.kind !== "fit")
                return "malformed";
            const { kind: _kind, ...candidate } = record;
            return { receipt: { kind: "fit", fit: validateFitReceipt(candidate, { repository: fitRepository }) } };
        }
        if (record.kind === "fit")
            return "malformed";
        const next = optionalEstimate(record.nextStageEstimate);
        if (record.kind === "question" && Object.keys(record).every((key) => ["kind", "question", "nextStageEstimate"].includes(key)) && [2, 3].includes(Object.keys(record).length) && text(record.question))
            return { receipt: { kind: "question", question: record.question, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        if (record.kind === "questions" && Object.keys(record).every((key) => ["kind", "questions", "nextStageEstimate"].includes(key)) && [2, 3].includes(Object.keys(record).length) && Array.isArray(record.questions) && record.questions.length <= maxQuestions && record.questions.every((question) => text(question)) && new Set(record.questions).size === record.questions.length)
            return { receipt: { kind: "questions", questions: record.questions, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        if (record.kind === "recon" && Object.keys(record).every((key) => ["kind", "summary", "artifacts", "brief", "report", "nextStageEstimate"].includes(key)) && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length) {
            const routed = routeRecon({
                ...(Object.hasOwn(record, "brief") ? { brief: record.brief } : {}),
                ...(Object.hasOwn(record, "report") ? { report: record.report } : {}),
            });
            if (!routed.ok || routed.state === "RECON_PENDING")
                return "malformed";
            const { ok: _ok, ...recon } = routed;
            return { receipt: { kind: "recon", summary: record.summary, artifacts: record.artifacts, recon, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        }
        if (record.kind === "action" && Object.keys(record).every((key) => ["kind", "summary", "artifacts", "evidence", "nextStageEstimate"].includes(key)) && [3, 4, 5].includes(Object.keys(record).length) && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length > 0 && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length && (record.evidence === undefined || commandEvidence(record.evidence)))
            return { receipt: { kind: "action", summary: record.summary, artifacts: record.artifacts, ...(record.evidence ? { evidence: record.evidence } : {}), ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        return "malformed";
    }
    catch {
        return "malformed";
    }
}
function isPlanSpecArtifactName(name) {
    return name === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(name);
}
function stageArtifactsValid(stage, artifacts, planDirectory, recon) {
    const inPlan = (path) => planDirectory !== undefined && posix.dirname(path) === planDirectory;
    const planSpec = (path) => isPlanSpecArtifactName(posix.basename(path));
    const routeReview = (path) => posix.basename(path) === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(posix.basename(path));
    if (stage === "repository-fit")
        return artifacts.length === 0;
    if (stage === "set-bearings")
        return artifacts.some(planSpec) && artifacts.some((path) => posix.basename(path) === "repository-map.md" && posix.dirname(posix.dirname(path)) === posix.dirname(artifacts.find(planSpec) ?? ""));
    if (stage === "gather-supplies")
        return artifacts.some((path) => inPlan(path) && planSpec(path));
    if (stage === "map-route")
        return ["design.md", "seit.md"].every((name) => artifacts.some((path) => inPlan(path) && posix.basename(path) === name));
    if (stage === "recon") {
        if (!recon)
            return false;
        if (recon.state === "SKIPPED")
            return artifacts.length === 0;
        return artifacts.length === recon.report.prototypePaths.length
            && recon.report.prototypePaths.every((path) => artifacts.includes(path) && recon.brief.writeSet.includes(path));
    }
    if (stage === "draft-implementation")
        return artifacts.some((path) => inPlan(path) && posix.basename(path) === "implementation.md");
    if (stage === "execute-explorer" || stage === "execute-expedition")
        return artifacts.some((path) => inPlan(path) && routeReview(path)) && planDirectory !== undefined && artifacts.some((path) => !path.startsWith(`${planDirectory}/`));
    return true;
}
async function gitRepositoryAvailable(root) {
    const { GIT_COMMON_DIR: _gitCommonDir, GIT_DIR: _gitDir, GIT_WORK_TREE: _gitWorkTree, ...environment } = process.env;
    return new Promise((resolveAvailability) => {
        execFile("git", ["-C", root, "rev-parse", "--git-dir"], {
            encoding: "utf8",
            env: {
                ...environment,
                GIT_CEILING_DIRECTORIES: "",
                GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
                LANG: "C",
                LC_ALL: "C",
            },
            maxBuffer: 4 * 1024,
            timeout: 5_000,
            windowsHide: true,
        }, (error, _stdout, stderr) => {
            if (!error) {
                resolveAvailability(true);
                return;
            }
            resolveAvailability(error.code === 128
                && stderr.trim() === "fatal: not a git repository (or any of the parent directories): .git"
                ? false
                : undefined);
        });
    });
}
async function reconCompletionValid(root, before, artifacts, recon) {
    const after = await snapshotGitState(root, before.head);
    if (!after || (after.head !== before.head && after.committedPaths.size === 0))
        return false;
    const changed = [...new Set([...before.paths.keys(), ...after.paths.keys(), ...after.committedPaths])]
        .filter((path) => after.committedPaths.has(path) || before.paths.get(path) !== after.paths.get(path));
    if (recon.state === "SKIPPED")
        return changed.length === 0;
    const allowed = new Set(recon.brief.writeSet);
    return changed.every((path) => allowed.has(path) && artifacts.includes(path));
}
async function planningCompletionValid(root, before, planDirectory) {
    const after = await snapshotGitState(root, before.head);
    if (!after || after.head !== before.head)
        return false;
    const changed = [...new Set([...before.paths.keys(), ...after.paths.keys(), ...after.committedPaths])]
        .filter((path) => after.committedPaths.has(path) || before.paths.get(path) !== after.paths.get(path));
    return planDirectory === undefined
        ? changed.length === 0
        : changed.every((path) => path.startsWith(`${planDirectory}/`));
}
/**
 * Issue 93's write probe. Diffs the live Git state against the exact base a
 * Focus envelope was built from (`focus.beforeHead`/`focus.before`) — the
 * same base `validateFocusCompletion` diffs against at the end of the call.
 * Run between the coordinator's dispatch and the productAuthor's dispatch, it
 * proves the coordinator/planner session mutated nothing before the
 * authorized worker ever started. `undefined` means Git state could not be
 * read (fail closed, same as a real mutation); an array is the exact set of
 * paths that changed, empty only when the base is provably untouched.
 */
async function focusPreDispatchMutation(root, focus) {
    const after = await snapshotGitState(root, focus.beforeHead);
    if (!after || (after.head !== focus.beforeHead && after.committedPaths.size === 0))
        return undefined;
    return [...new Set([...focus.before.keys(), ...after.paths.keys(), ...after.committedPaths])]
        .filter((path) => after.committedPaths.has(path) || focus.before.get(path) !== after.paths.get(path));
}
const MAX_PLANNING_ARTIFACT = 2 * 1024 * 1024;
async function readPlanningArtifact(root, value, allowEmpty = false) {
    if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value)
        return undefined;
    const candidate = resolve(root, value), lexical = relative(root, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical))
        return undefined;
    let handle = null;
    try {
        handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
        const relation = relative(root, canonical);
        if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size > MAX_PLANNING_ARTIFACT || !relation || relation.startsWith("..") || isAbsolute(relation))
            return undefined;
        const buffer = Buffer.allocUnsafe(MAX_PLANNING_ARTIFACT + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead)
                break;
            length += bytesRead;
        }
        if (length > MAX_PLANNING_ARTIFACT)
            return undefined;
        const content = buffer.subarray(0, length).toString("utf8");
        return allowEmpty || content.trim() ? content : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        await handle?.close();
    }
}
async function focusPlanHashes(root, planDirectory) {
    const contents = await Promise.all(FOCUS_PLAN_SOURCES.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return undefined;
    const hash = (content) => createHash("sha256").update(content).digest("hex");
    return {
        "plan-spec.md": hash(contents[0]),
        "design.md": hash(contents[1]),
        "seit.md": hash(contents[2]),
        "implementation.md": hash(contents[3]),
    };
}
async function solePlanSlice(root, planDirectory) {
    const contents = await Promise.all(FOCUS_PLAN_SOURCES.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return undefined;
    const [plan, design, seit, implementation] = contents;
    const slices = [...parsePlanDocuments({ plan, design, seit, implementation }).slices.keys()];
    return slices.length === 1 ? slices[0] : undefined;
}
/**
 * Resolve the declared prerequisite slices of a slice from the plan documents:
 * every member of an earlier wave, plus every slice that transitively feeds it
 * through an explicit dependency edge. Wave membership is itself a declared
 * sequencing requirement of the plan, so an unvalidated earlier-wave slice
 * blocks execution exactly like an explicit edge does.
 */
export function expeditionSlicePrerequisites(model, currentSlice) {
    const prerequisites = new Set();
    const sliceIds = new Set(model.slices.keys());
    let currentWave;
    for (const [wave, members] of model.waves) {
        if (members.has(currentSlice)) {
            currentWave = wave;
            break;
        }
    }
    if (currentWave !== undefined) {
        for (const [wave, members] of model.waves) {
            if (wave >= currentWave)
                continue;
            for (const member of members)
                if (member !== currentSlice)
                    prerequisites.add(member);
        }
    }
    const pending = [currentSlice];
    while (pending.length > 0) {
        const dependent = pending.pop();
        for (const [source, targets] of model.dependencies) {
            if (!targets.has(dependent) || !sliceIds.has(source) || source === currentSlice)
                continue;
            if (!prerequisites.has(source)) {
                prerequisites.add(source);
                pending.push(source);
            }
        }
    }
    return [...prerequisites].sort();
}
/**
 * Admission guard for executing a selected Expedition slice: refuse when any
 * declared prerequisite slice has not yet been validated. The caller responds
 * with a non-mutating refusal; `undefined` means execution may proceed (no
 * plan directory, unreadable plan, or all prerequisites already validated).
 */
export async function expeditionSliceDependencyRefusal(root, planDirectory, currentSlice, completedSliceIds) {
    if (planDirectory === undefined)
        return undefined;
    const names = await readdir(resolve(root, planDirectory)).catch(() => []);
    const planName = names.find(isPlanSpecArtifactName);
    if (!planName)
        return undefined;
    const contents = await Promise.all([planName, "design.md", "seit.md", "implementation.md"].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return undefined;
    const [plan, design, seit, implementation] = contents;
    const model = parsePlanDocuments({ plan, design, seit, implementation });
    if (!model.slices.has(currentSlice))
        return undefined;
    const prerequisites = expeditionSlicePrerequisites(model, currentSlice);
    const incomplete = prerequisites.filter((sliceId) => !completedSliceIds.has(sliceId));
    return incomplete.length === 0 ? undefined : { sliceId: currentSlice, prerequisiteSlices: incomplete };
}
export async function currentPlanningVerdict(root, planDirectory) {
    try {
        if (!await containedPath(root, planDirectory, true))
            return undefined;
        const names = await readdir(resolve(root, planDirectory));
        const planName = names.find(isPlanSpecArtifactName);
        if (!planName || !names.includes("design.md") || !names.includes("seit.md") || !names.includes("implementation.md"))
            return undefined;
        const [plan, design, seit, implementation] = await Promise.all([planName, "design.md", "seit.md", "implementation.md"].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
        return plan && design && seit && implementation
            ? validatePlan({ documents: { plan, design, seit, implementation }, planDirectory })
            : undefined;
    }
    catch {
        return undefined;
    }
}
async function writePlanningReview(root, value, content) {
    if (Buffer.byteLength(content) > MAX_PLANNING_ARTIFACT || !pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value)
        return false;
    const candidate = resolve(root, value), lexical = relative(root, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical))
        return false;
    let handle = null;
    try {
        try {
            handle = await open(candidate, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        }
        catch {
            handle = await open(candidate, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        }
        const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
        const relation = relative(root, canonical);
        if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || !relation || relation.startsWith("..") || isAbsolute(relation))
            return false;
        await handle.truncate(0);
        await handle.writeFile(content, "utf8");
        return true;
    }
    catch {
        return false;
    }
    finally {
        await handle?.close();
    }
}
function escaped(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
const MAX_FOCUS_DRIFT_TEXT = 512;
function boundedEscaped(value) {
    const safe = escaped(value);
    return safe.length <= MAX_FOCUS_DRIFT_TEXT ? safe : `${safe.slice(0, MAX_FOCUS_DRIFT_TEXT - 1)}…`;
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function addedValues(previous, candidate) {
    const prior = new Set(previous);
    return candidate.filter((value) => !prior.has(value)).map(boundedEscaped);
}
export function focusContractDrift(previous, candidate) {
    const left = previous.context.envelope;
    const right = candidate.context.envelope;
    const addedAllowedPaths = addedValues(left.allowedPaths, right.allowedPaths);
    const removedAllowedPaths = addedValues(right.allowedPaths, left.allowedPaths);
    const addedSeitCommandIds = addedValues(left.seitCommandIds, right.seitCommandIds);
    const removedSeitCommandIds = addedValues(right.seitCommandIds, left.seitCommandIds);
    const changedAcceptanceCriterion = left.currentAcceptanceCriterion === right.currentAcceptanceCriterion
        ? undefined
        : { previous: boundedEscaped(left.currentAcceptanceCriterion), candidate: boundedEscaped(right.currentAcceptanceCriterion) };
    const changedRemainingSlices = sameStrings(left.remainingSlices, right.remainingSlices)
        ? undefined
        : { previous: left.remainingSlices.map(boundedEscaped), candidate: right.remainingSlices.map(boundedEscaped) };
    const changedObjective = left.immutableObjective === right.immutableObjective
        ? undefined
        : { previous: boundedEscaped(left.immutableObjective), candidate: boundedEscaped(right.immutableObjective) };
    const changedRole = left.role === right.role
        ? undefined
        : { previous: boundedEscaped(left.role), candidate: boundedEscaped(right.role) };
    const changedTargetRepository = previous.targetRepository === candidate.targetRepository
        ? undefined
        : { previous: boundedEscaped(previous.targetRepository), candidate: boundedEscaped(candidate.targetRepository) };
    const changedPlanDirectory = previous.planDirectory === candidate.planDirectory
        ? undefined
        : { previous: boundedEscaped(previous.planDirectory), candidate: boundedEscaped(candidate.planDirectory) };
    const changedPlanSources = FOCUS_PLAN_SOURCES
        .filter((name) => previous.planHashes[name] !== candidate.planHashes[name])
        .map(boundedEscaped);
    if (!addedAllowedPaths.length &&
        !removedAllowedPaths.length &&
        !addedSeitCommandIds.length &&
        !removedSeitCommandIds.length &&
        !changedAcceptanceCriterion &&
        !changedRemainingSlices &&
        !changedObjective &&
        !changedRole &&
        !changedTargetRepository &&
        !changedPlanDirectory &&
        !changedPlanSources.length)
        return null;
    return {
        addedAllowedPaths,
        removedAllowedPaths,
        addedSeitCommandIds,
        removedSeitCommandIds,
        ...(changedAcceptanceCriterion ? { changedAcceptanceCriterion } : {}),
        ...(changedRemainingSlices ? { changedRemainingSlices } : {}),
        ...(changedObjective ? { changedObjective } : {}),
        ...(changedRole ? { changedRole } : {}),
        ...(changedTargetRepository ? { changedTargetRepository } : {}),
        ...(changedPlanDirectory ? { changedPlanDirectory } : {}),
        changedPlanSources,
    };
}
function field(section, name) {
    const label = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\*\\*${label}${name.endsWith("?") ? "" : "\\."}\\*\\*\\s*(.+)$`, "mi").exec(section);
    return match?.[1]?.trim();
}
export function structurallyValidImplementation(plan, design, seit, content) {
    const model = parsePlanDocuments({ plan, design, seit, implementation: content });
    const legacySection = (source, heading) => {
        const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^##[ \\t]+${escapedHeading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(source)?.[1] ?? "";
    };
    const legacyPlanIds = new Set(`${legacySection(plan, "Acceptance criteria")}\n${legacySection(plan, "Risks and open questions")}`
        .match(/\b(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*\b/gi)?.map((value) => value.toUpperCase()) ?? []);
    const legacyDesignIds = new Set(design.match(/\b(?:DES|CONTRACT)-[A-Z0-9][A-Z0-9.-]*\b/gi)?.map((value) => value.toUpperCase()) ?? []);
    const additions = new Set([
        "artifact_frontmatter_invalid",
        "build_command_in_manifest",
        "goal_unbounded",
        "id_format_invalid",
        "writeset_duplicate",
        "writeset_multiline",
        "writeset_readonly_harvest",
    ]);
    return structuralFindings(model).every((finding) => {
        if (additions.has(finding.code) || finding.code === "design_section_missing")
            return true;
        if (finding.code === "seit_section_missing" && finding.observed === "Cross-cutting Checks")
            return true;
        if (finding.code === "id_unknown") {
            return (/^(?:AC|RISK)-/i.test(finding.observed) ? legacyPlanIds : legacyDesignIds).has(finding.observed);
        }
        if (finding.code === "trace_header_invalid" && finding.observed === model.traceHeaders.join(", ")) {
            return [
                "seit row id",
                "acceptance/risk id",
                "design/contract id",
                "boundary/test layer",
                "positive case",
                "negative/failure case",
                "command/procedure id",
                "evidence",
            ].every((header) => model.traceHeaders.includes(header));
        }
        if (finding.code === "writeset_empty" && finding.sliceId) {
            const writeSet = model.manifests.get(finding.sliceId)?.fields.get("Write set") ?? "";
            return /\b(?:none|no writes?(?: required)?|no (?:new|required|source|product) files?)\b/i.test(writeSet);
        }
        if (finding.code === "writeset_glob" || finding.code === "writeset_unsafe_path") {
            return !(/\*|\.\.\.|<|>|\\/.test(finding.observed)
                || posix.isAbsolute(finding.observed)
                || /^[A-Za-z]:/.test(finding.observed)
                || posix.normalize(finding.observed) !== finding.observed
                || finding.observed.split("/").some((segment) => !segment || segment === "." || segment === ".."));
        }
        if (finding.code === "slice_reference_dangling") {
            return ![...content.matchAll(/\bSlice\s+([A-Za-z]+\d+|\d+(?:\.\d+)+)\b/g)].some((match) => match[1] === finding.observed);
        }
        if (finding.code === "wave_noncontiguous") {
            const waves = new Set([...content.matchAll(/\bWave\s+(\d+)\b/g)].map((match) => Number(match[1])));
            if (model.slices.size > 1 && !waves.size)
                return false;
            const lastWave = waves.size ? Math.max(...waves) : 0;
            return !waves.size || lastWave >= 1 && waves.size === lastWave && [...Array(lastWave).keys()].every((index) => waves.has(index + 1));
        }
        return false;
    });
}
function sourceSection(sources) {
    return `<section id="bearing-source-artifacts"><h2>Complete planning artifacts</h2><p>These are the complete source documents used for this review.</p>${sources.map(([name, content]) => `<details><summary>${escaped(name)}</summary><pre>${escaped(content)}</pre></details>`).join("")}</section>`;
}
function sourceNavigation(sources) {
    return `<nav id="bearing-source-links" aria-label="Planning artifact sources">${sources.map(([name]) => `<a href="./${encodeURIComponent(name)}">${escaped(name)}</a>`).join(" ")}</nav>`;
}
const FINAL_QA_PENDING = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const FINAL_QA_COMPLETE_PREFIX = '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: ';
const FINAL_QA_COMPLETE_MIDDLE = "</p><p>Validation evidence: ";
const FINAL_QA_COMPLETE_SUFFIX = "</p></section>";
export function renderPlanningReview(sources) {
    const planningFlow = '<figure><div class="flow" role="img" aria-label="Planning flow from plan specification through final QA"><span>Plan specification</span><b>→</b><span>Design</span><b>→</b><span>SEIT test map</span><b>→</b><span>Implementation</span><b>→</b><span>Final QA</span></div><figcaption>Planning flow</figcaption><p class="text-equivalent">Text equivalent: acceptance and risks drive design contracts; SEIT maps those contracts to proof; implementation slices reference the map; final QA records actual evidence.</p></figure>';
    const traceFlow = '<figure><div class="flow" role="img" aria-label="Traceability from requirements to execution evidence"><span>AC / RISK</span><b>↔</b><span>DES / CONTRACT</span><b>↔</b><span>SEIT / CMD</span><b>↔</b><span>Slice manifest</span></div><figcaption>Traceability map</figcaption><p class="text-equivalent">Text equivalent: stable IDs connect each requirement or risk to its design boundary, positive and negative test cases, command, evidence, and bounded execution slice.</p></figure>';
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bearing planning review</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:auto;padding:2rem;color:#17202a;background:#f7f8fa}main{background:#ffffff;padding:2rem;border:1px solid #67788a;border-radius:12px}nav{display:flex;gap:1rem;flex-wrap:wrap}figure{margin:2rem 0;padding:1rem;border:1px solid #a8b2bd;border-radius:8px}.flow{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap}.flow span{padding:.55rem .8rem;background:#eef1f4;border-radius:6px}figcaption,summary{font-weight:700}.text-equivalent{margin-bottom:0}details{margin:1rem 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef1f4;padding:1rem;border-radius:8px}</style></head><body><main><h1>Bearing planning review</h1><p>This deterministic view is generated from the four current planning sources.</p>${sourceNavigation(sources)}<section aria-labelledby="bearing-diagrams"><h2 id="bearing-diagrams">Plan maps</h2>${planningFlow}${traceFlow}</section>${sourceSection(sources)}${FINAL_QA_PENDING}</main></body></html>\n`;
}
function validFinalQaSection(section) {
    if (!section.startsWith(FINAL_QA_COMPLETE_PREFIX) || !section.endsWith(FINAL_QA_COMPLETE_SUFFIX))
        return false;
    const body = section.slice(FINAL_QA_COMPLETE_PREFIX.length, section.length - FINAL_QA_COMPLETE_SUFFIX.length);
    const middle = body.indexOf(FINAL_QA_COMPLETE_MIDDLE);
    if (middle < 0 || body.indexOf(FINAL_QA_COMPLETE_MIDDLE, middle + FINAL_QA_COMPLETE_MIDDLE.length) >= 0)
        return false;
    const planned = body.slice(0, middle), validation = body.slice(middle + FINAL_QA_COMPLETE_MIDDLE.length);
    return planned.trim().length > 0 && validation.trim().length > 0 && !planned.includes("<") && !planned.includes(">") && !validation.includes("<") && !validation.includes(">");
}
export async function executionReviewValid(root, planDirectory) {
    if (!planDirectory)
        return false;
    const directory = resolve(root, planDirectory), names = await readdir(directory);
    const planName = names.find(isPlanSpecArtifactName);
    const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name));
    if (!planName || !reviewName || !["design.md", "seit.md", "implementation.md"].every((name) => names.includes(name)))
        return false;
    const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
    const contents = await Promise.all([...sourceNames, reviewName].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return false;
    const sources = sourceNames.map((name, index) => [name, contents[index]]);
    const expected = renderPlanningReview(sources), marker = expected.indexOf(FINAL_QA_PENDING);
    if (marker < 0)
        return false;
    const prefix = expected.slice(0, marker), suffix = expected.slice(marker + FINAL_QA_PENDING.length), review = contents.at(-1);
    if (!review.startsWith(prefix) || !review.endsWith(suffix) || review.length < prefix.length + suffix.length)
        return false;
    return validFinalQaSection(review.slice(prefix.length, review.length - suffix.length));
}
async function designReviewArtifacts(root, planDirectory, _repair = false, cancelled = () => false) {
    if (!planDirectory)
        return undefined;
    const directory = resolve(root, planDirectory), names = await readdir(directory);
    const planName = names.find(isPlanSpecArtifactName);
    if (!planName || !names.includes("design.md") || !names.includes("seit.md"))
        return undefined;
    // Issue 86: the Map Route checkpoint validates and returns only design.md and seit.md. The
    // deterministic review.html is generated exactly once, after implementation.md validates, by
    // {@link planningReview} from all four Markdown sources — never here from three.
    const sourceNames = [planName, "design.md", "seit.md"];
    const sourceContents = await Promise.all(sourceNames.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!sourceContents.every((content) => content !== undefined))
        return undefined;
    const design = sourceContents[1], seit = sourceContents[2];
    if (!artifactComplete(design.trim(), "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !artifactComplete(seit.trim(), "seit", ["Traceability Matrix", "Cross-cutting Checks"]))
        return undefined;
    if (cancelled())
        return undefined;
    return ["design.md", "seit.md"].map((name) => posix.join(planDirectory, name));
}
const DESIGN_CHECKPOINT_HEADINGS = ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"];
const SEIT_CHECKPOINT_HEADINGS = ["Traceability Matrix", "Cross-cutting Checks"];
const FINDING_OBSERVED_MAX = 512;
function boundedFindingValue(value) {
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, FINDING_OBSERVED_MAX);
    return cleaned || "missing value";
}
/**
 * Deterministic structural findings for the design-and-SEIT checkpoint (issue 78). Mirrors
 * exactly the `artifactComplete` gate used by {@link designReviewArtifacts}: each artifact's
 * frontmatter (`type`, then `status`) and each required exact heading, in a fixed per-artifact
 * order. Findings expose only bounded structural facts — artifact name, field or heading,
 * observed value (truncated), required value, remedy — never document body text.
 */
function designCheckpointStructuralFindings(design, seit) {
    const findings = [];
    const frontmatterFinding = (artifact, kind, content) => {
        const required = `type: ${kind} and status: complete or amended`;
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
        if (frontmatter === undefined) {
            findings.push({ code: "artifact_frontmatter_invalid", severity: "amendment", artifact, observed: "frontmatter block missing", required, remedy: "repair the artifact frontmatter" });
            return;
        }
        // Mirror `artifactComplete` exactly: a field is satisfied when ANY frontmatter line
        // matches it, so the finding can never contradict the gate. Every separator and capture
        // is horizontal-only whitespace, keeping the observed value on its own line — `\s*`
        // crosses newlines, which would let a blank `type:` echo the following line verbatim
        // into the receipt. Both fields are reported, so the actually-failing one is never
        // suppressed by an earlier one.
        if (!new RegExp(`^type:[^\\S\\r\\n]*${kind}[^\\S\\r\\n]*$`, "mi").test(frontmatter)) {
            const typeValue = /^type:[^\S\r\n]*([^\r\n]*)$/mi.exec(frontmatter)?.[1]?.trim();
            findings.push({ code: "artifact_frontmatter_invalid", severity: "amendment", artifact, observed: `type: ${boundedFindingValue(typeValue ?? "")}`, required, remedy: "repair the artifact frontmatter" });
        }
        if (!/^status:[^\S\r\n]*(?:complete|amended)[^\S\r\n]*$/mi.test(frontmatter)) {
            const statusValue = /^status:[^\S\r\n]*([^\r\n]*)$/mi.exec(frontmatter)?.[1]?.trim();
            findings.push({ code: "artifact_frontmatter_invalid", severity: "amendment", artifact, observed: `status: ${boundedFindingValue(statusValue ?? "")}`, required, remedy: "repair the artifact frontmatter" });
        }
    };
    frontmatterFinding("design.md", "design", design);
    for (const heading of DESIGN_CHECKPOINT_HEADINGS) {
        if (!sectionPresent(design, heading))
            findings.push({ code: "design_section_missing", severity: "amendment", artifact: "design.md", observed: heading, required: `non-empty ${heading} section`, remedy: `add the ${heading} section` });
    }
    frontmatterFinding("seit.md", "seit", seit);
    for (const heading of SEIT_CHECKPOINT_HEADINGS) {
        if (!sectionPresent(seit, heading))
            findings.push({ code: "seit_section_missing", severity: "amendment", artifact: "seit.md", observed: heading, required: `non-empty ${heading} section`, remedy: `add the ${heading} section` });
    }
    return findings;
}
/**
 * Reads the three design-checkpoint artifacts and returns the bounded structural findings for
 * the current Map Route documents. Mirrors {@link designReviewArtifacts}' preconditions: when the
 * checkpoint is absent or its documents are unreadable there are no structural findings, so the
 * failure stays a bare `artifact_invalid` exactly as before.
 */
async function designCheckpointFindings(root, planDirectory) {
    if (!planDirectory)
        return [];
    try {
        const directory = resolve(root, planDirectory), names = await readdir(directory);
        const planName = names.find(isPlanSpecArtifactName);
        if (!planName || !names.includes("design.md") || !names.includes("seit.md"))
            return [];
        const sourceContents = await Promise.all([planName, "design.md", "seit.md"].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
        if (!sourceContents.every((content) => content !== undefined))
            return [];
        return designCheckpointStructuralFindings(sourceContents[1], sourceContents[2]);
    }
    catch {
        return [];
    }
}
function routeLabel(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function planningRoute(value, selection) {
    const label = routeLabel(value);
    const selected = BUILTIN_ROUTES.find((route) => route.provider === selection.provider && (route.model === "*" || route.model === selection.model));
    const matches = BUILTIN_ROUTES.filter((route) => {
        const labels = [route.id, route.provider, `${route.executable} ${route.id}`, ...(route.model === "*" ? [`${route.id} agent default`, `${route.provider} agent default`] : [route.model, `${route.executable} ${route.model}`])].map(routeLabel);
        const selectedLabels = route === selected && selection.model !== "*" ? [selection.model, `${route.id} ${selection.model}`, `${route.provider} ${selection.model}`, `${route.executable} ${selection.model}`].map(routeLabel) : [];
        return labels.includes(label) || selectedLabels.includes(label);
    });
    return matches.length === 1 ? matches[0] : undefined;
}
async function planningReview(root, planDirectory, selection) {
    if (!planDirectory)
        return undefined;
    const directory = resolve(root, planDirectory), names = await readdir(directory);
    const planName = names.find(isPlanSpecArtifactName);
    const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name)) ?? "review.html";
    if (!planName || !names.includes("design.md") || !names.includes("seit.md") || !names.includes("implementation.md"))
        return undefined;
    const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
    const contents = await Promise.all(sourceNames.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return undefined;
    const [plan, design, seit, implementation] = contents;
    if (!artifactComplete(design.trim(), "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !artifactComplete(seit.trim(), "seit", ["Traceability Matrix", "Cross-cutting Checks"]))
        return { status: "implementation_invalid" };
    if (!structurallyValidImplementation(plan, design, seit, implementation))
        return { status: "implementation_invalid" };
    const headings = [...implementation.matchAll(/^###\s+(Slice\b[^\r\n]*)/gmi)];
    const assignments = [];
    for (let index = 0; index < headings.length; index += 1) {
        const start = headings[index].index ?? 0, end = headings[index + 1]?.index ?? implementation.length;
        const section = implementation.slice(start, end);
        const role = field(section, "Implementation role"), model = field(section, "Agent model route"), reasoning = field(section, "Agent reasoning level");
        const ponytail = field(section, "Ponytail mode"), reviewPath = field(section, "Review path");
        if (!role || !model || !reasoning || !reviewPath)
            return { status: "implementation_invalid" };
        const route = planningRoute(model, selection), normalizedReasoning = reasoning.replace(/[.!?]+$/, "").trim();
        const normalizedPonytail = ponytail?.replace(/[.!?]+$/, "").trim();
        if (!route || !route.reasoningLevels.includes(normalizedReasoning.toLowerCase()) || (normalizedPonytail !== undefined && !["full", "off"].includes(normalizedPonytail)))
            return { status: "implementation_invalid" };
        assignments.push({ slice: headings[index][1].trim(), role, model, reasoning: normalizedReasoning });
    }
    const completed = renderPlanningReview(sourceNames.map((name, index) => [name, [plan, design, seit, implementation][index]]));
    if (Buffer.byteLength(completed) > MAX_PLANNING_ARTIFACT)
        return { status: "review_generation_failed" };
    const review = names.includes(reviewName) ? await readPlanningArtifact(root, posix.join(planDirectory, reviewName), true) : "";
    if (review === undefined)
        return { status: "review_generation_failed" };
    if (completed !== review && !await writePlanningReview(root, posix.join(planDirectory, reviewName), completed))
        return { status: "review_generation_failed" };
    const validation = orchestratePlanning({
        currentState: "EXECUTION_PLAN_READY",
        pass: "planning-validator",
        documents: { plan, design, seit, implementation },
        planDirectory,
        artifacts: sourceNames.map((name) => posix.join(planDirectory, name)),
    });
    if ("refused" in validation || !validation.planningValidation)
        return { status: "implementation_invalid" };
    return {
        status: "ok",
        review: {
            phases: [...implementation.matchAll(/^##\s+Phase\s+(?=[A-Za-z0-9.-]*\d)[^\r\n]*$/gmi)].length,
            slices: assignments.length,
            assignments,
        },
        planningValidation: validation.planningValidation,
    };
}
async function completedValidatorScope(root, planDirectory, focus, completion, evidence, summary) {
    const sliceIds = [...focus.envelope.remainingSlices];
    const readinessClaims = [{ text: summary, sliceIds }];
    const planName = (await readdir(resolve(root, planDirectory)).catch(() => [])).find(isPlanSpecArtifactName);
    if (!planName)
        return { slices: [], readinessClaims };
    const names = [planName, "design.md", "seit.md", "implementation.md"];
    const contents = await Promise.all(names.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return { slices: [], readinessClaims };
    const [plan, design, seit, implementation] = contents;
    const model = parsePlanDocuments({ plan, design, seit, implementation });
    const slices = sliceIds.flatMap((sliceId) => {
        const slice = model.slices.get(sliceId);
        const manifest = model.manifests.get(sliceId);
        if (!slice || !manifest)
            return [];
        return [{
                sliceId,
                requirementIds: [...slice.requirementIds],
                evidenceCommandIds: [...manifest.commandIds],
                ...(completion.changedPaths.some((path) => manifest.writeSetPaths.includes(path)) ? { completion } : {}),
                evidence: evidence.filter((item) => manifest.commandIds.has(item.commandId)),
            }];
    });
    return slices.length === sliceIds.length ? { slices, readinessClaims } : { slices: [], readinessClaims };
}
/** Minimal provider-neutral bridge from a selected onboarding route to one staged journey action. */
export class JourneyService {
    runner;
    planDirectoryResolver;
    active = new Map();
    cancelled = new Set();
    activity = new Map();
    providerSessions = new Map();
    focusContexts = new Map();
    reconBaselines = new Map();
    constructor(runner, planDirectoryResolver = resolvePlanDirectory) {
        this.runner = runner;
        this.planDirectoryResolver = planDirectoryResolver;
    }
    cancel(runId) { this.cancelled.add(runId); const processRunId = this.active.get(runId); if (processRunId)
        void this.runner.cancel?.(processRunId); }
    activityTrail(runId) {
        return (this.activity.get(runId)?.trail ?? []).map((entry) => ({ ...entry }));
    }
    providerSessionId(repositoryPath, runId, selection) { return this.providerSessions.get(this.providerSessionKey(repositoryPath, runId, selection)); }
    providerSessionKey(repositoryPath, runId, selection) {
        return JSON.stringify([repositoryPath, runId, selection.provider, selection.model, selection.reasoning]);
    }
    focusKey(_repositoryPath, runId) { return runId; }
    reconKey(repositoryPath, runId) { return JSON.stringify([repositoryPath, runId]); }
    beginStage(runId, stage) {
        const current = this.activity.get(runId);
        if (current?.stage === stage)
            return;
        this.activity.set(runId, { stage, nextSequence: 1, trail: [] });
    }
    recordActivity(runId, stage, source) {
        const current = this.activity.get(runId);
        if (!current || current.stage !== stage)
            return;
        const safe = (value) => value && SAFE_ACTIVITY_VALUE.test(value) && !SECRET_ACTIVITY.test(value) ? value : undefined;
        const kind = safe(source.kind);
        if (!kind)
            return;
        const status = safe(source.status), tool = safe(source.tool);
        current.trail.push({ sequence: current.nextSequence, recordedAt: new Date().toISOString(), kind, ...(status ? { status } : {}), ...(tool ? { tool } : {}) });
        current.nextSequence += 1;
        if (current.trail.length > MAX_ACTIVITY_TRAIL)
            current.trail.shift();
    }
    async executeOnce(request, activityStage = request.stage, recordStageStart = true, freshSessionFallback = { used: false, backgroundBriefUsed: false }) {
        if (!validRequest(request))
            return { status: "failure", code: "input_invalid", tokens: 0 };
        const fitStage = request.stage === "repository-fit";
        let repositoryPath;
        try {
            repositoryPath = await realpath(request.repositoryPath);
            if (repositoryPath !== request.repositoryPath || !(await lstat(repositoryPath)).isDirectory())
                throw new Error("invalid repository");
        }
        catch {
            return { status: "failure", code: "input_invalid", tokens: 0 };
        }
        const planDirectory = request.planDirectory === undefined ? undefined : await containedPath(repositoryPath, request.planDirectory, true);
        if (request.planDirectory !== undefined && planDirectory === undefined)
            return { status: "failure", code: "input_invalid", tokens: 0 };
        const coordinatorRole = request.stage === "execute-expedition" ? "navigator" : undefined;
        const projected = request.run.roles.find((role) => request.stage === "review"
            ? role.role === "surveyor" && !role.authority.write
            : coordinatorRole
                ? role.role === coordinatorRole && role.executor
                : role.role === "crewmate" && role.executor && role.authority.write);
        if (!projected)
            return { status: "failure", code: fitStage ? "fit_unavailable" : "crewmate_unavailable", tokens: 0 };
        if (request.stage === "review") {
            // Issue 93: a Surveyor sharing identity with the role that authored the candidate cannot
            // independently verify it, even outside the coordinated-Expedition dispatch this same
            // repository's execute-expedition path already checks.
            const author = request.run.roles.find((role) => role.role === "crewmate" && role.executor && role.authority.write);
            if (author && !validateReviewerAuthorship({
                reviewer: { role: projected.role, identity: projected.identity },
                author: { role: author.role, identity: author.identity },
            }).ok)
                return { status: "failure", code: "role_boundary_violation", tokens: 0 };
        }
        if (!sameRoute(request.selection, projected.selection) || request.run.roles.some((role) => !sameRoute(role.selection, request.selection)))
            return { status: "failure", code: "selection_mismatch", tokens: 0 };
        let resolvedPlanDirectory;
        if (request.stage === "set-bearings") {
            if (!request.requestedPlanDirectory)
                return { status: "failure", code: "input_invalid", tokens: 0 };
            const resolution = await this.planDirectoryResolver(repositoryPath, request.requestedPlanDirectory)
                .catch(() => ({ ok: false, reason: "plan_directory_invalid" }));
            if (!resolution.ok)
                return { status: "failure", code: resolution.reason, tokens: 0 };
            resolvedPlanDirectory = resolution.path;
        }
        this.beginStage(request.runId, activityStage);
        if (recordStageStart)
            this.recordActivity(request.runId, activityStage, { kind: "stage.started", status: "running" });
        if (request.stage === "set-bearings") {
            if (!resolvedPlanDirectory)
                return { status: "failure", code: "input_invalid", tokens: 0 };
            if (this.cancelled.has(request.runId))
                return { status: "failure", code: "cancelled", tokens: 0 };
            try {
                this.recordActivity(request.runId, activityStage, { kind: "repository-map.started", status: "running" });
                const workspace = await setBearingsWorkspace(repositoryPath, request.workGoal, resolvedPlanDirectory);
                if (!workspace || !(await Promise.all(workspace.artifacts.map((artifact) => containedPath(repositoryPath, artifact)))).every(Boolean) || !stageArtifactsValid(request.stage, workspace.artifacts, workspace.directory) || this.cancelled.has(request.runId))
                    return { status: "failure", code: this.cancelled.has(request.runId) ? "cancelled" : "artifact_invalid", tokens: 0 };
                this.recordActivity(request.runId, activityStage, { kind: "workspace.ready", status: workspace.resumed ? "resumed" : "created" });
                return { status: "action", summary: workspace.resumed ? "Bearings resumed locally." : "Bearings set locally.", artifacts: workspace.artifacts, tokens: 0 };
            }
            catch {
                return { status: "failure", code: "artifact_invalid", tokens: 0 };
            }
        }
        const executionStage = request.stage === "execute-explorer" || request.stage === "execute-expedition";
        const coordinatedExpedition = request.stage === "execute-expedition";
        const productAuthor = coordinatedExpedition ? request.run.roles.find((role) => role.role === "crewmate" && role.executor && role.authority.write) : undefined;
        const reviewer = coordinatedExpedition ? request.run.roles.find((role) => role.role === "surveyor" && !role.authority.write && !role.executor) : undefined;
        if (coordinatedExpedition && (!productAuthor || !reviewer || !validateExecutionRoleBoundary({
            coordinator: { role: projected.role, identity: projected.identity },
            productAuthor: { role: productAuthor.role, identity: productAuthor.identity },
            reviewer: { role: reviewer.role, identity: reviewer.identity },
        }).ok))
            return { status: "failure", code: "authority_invalid", tokens: 0 };
        let focus;
        let focusKey;
        if (executionStage) {
            if (!planDirectory)
                return { status: "failure", code: "focus_invalid", tokens: 0 };
            const currentSlice = request.currentSlice ?? (coordinatedExpedition ? await solePlanSlice(repositoryPath, planDirectory).catch(() => undefined) : undefined);
            const [parsed, planHashes] = await Promise.all([
                createFocusContext({
                    root: repositoryPath,
                    planDirectory,
                    role: request.stage === "execute-expedition" ? "navigator" : "explorer",
                    objective: request.workGoal,
                    ...(currentSlice ? { currentSlice } : {}),
                    ...(request.reviewPrompt ? { currentBlocker: request.reviewPrompt } : {}),
                    ...(request.gateFailureFingerprint ? { gateFailureFingerprint: request.gateFailureFingerprint } : {}),
                }).catch(() => undefined),
                focusPlanHashes(repositoryPath, planDirectory).catch(() => undefined),
            ]);
            focusKey = this.focusKey(repositoryPath, request.runId);
            const original = this.focusContexts.get(focusKey);
            if (!parsed?.ok || !planHashes) {
                this.recordActivity(request.runId, activityStage, {
                    kind: "focus.rejected",
                    status: parsed && !parsed.ok ? focusRejectionStatus(parsed) : "invalid",
                });
                return { status: "failure", code: "focus_invalid", tokens: 0 };
            }
            const candidate = { context: parsed.value, planHashes, targetRepository: repositoryPath, planDirectory };
            const drift = original ? focusContractDrift(original, candidate) : null;
            if (drift && !request.focusAmendmentConfirmed) {
                this.recordActivity(request.runId, activityStage, { kind: "focus.amendment_required", status: "unconfirmed" });
                return { status: "failure", code: "focus_amendment_required", focusDrift: drift, tokens: 0 };
            }
            const selected = original
                ? drift
                    ? candidate
                    : {
                        ...original,
                        context: {
                            ...original.context,
                            envelope: {
                                ...original.context.envelope,
                                currentBlocker: candidate.context.envelope.currentBlocker,
                                gateFailureFingerprint: candidate.context.envelope.gateFailureFingerprint,
                            },
                        },
                    }
                : candidate;
            focus = selected.context;
            this.focusContexts.set(focusKey, selected);
            if (drift)
                this.recordActivity(request.runId, activityStage, { kind: "focus.amended", status: "confirmed" });
            this.recordActivity(request.runId, activityStage, { kind: "focus.ready", status: "validated" });
        }
        const reconKey = this.reconKey(repositoryPath, request.runId);
        const reconBaseline = request.stage === "recon"
            ? this.reconBaselines.get(reconKey) ?? await snapshotGitState(repositoryPath)
            : undefined;
        if (reconBaseline)
            this.reconBaselines.set(reconKey, reconBaseline);
        if (request.stage === "recon" && !reconBaseline) {
            const gitAvailable = await gitRepositoryAvailable(repositoryPath);
            if (gitAvailable === false) {
                this.recordActivity(request.runId, activityStage, { kind: "recon.skipped", status: "git_repository_unavailable" });
                return {
                    status: "action",
                    summary: "Bearing skipped Recon because the selected path is not in a Git repository.",
                    artifacts: [],
                    recon: { state: "SKIPPED" },
                    tokens: 0,
                };
            }
            this.recordActivity(request.runId, activityStage, { kind: "recon.rejected", status: "git_state" });
            return { status: "failure", code: "completion_invalid", tokens: 0 };
        }
        const planningOnly = fitStage
            || request.stage === "gather-supplies"
            || request.stage === "map-route"
            || request.stage === "draft-implementation";
        const planningWriteDirectory = request.stage === "gather-supplies" && request.gatherMode === "questions" || fitStage
            ? undefined
            : planDirectory;
        const planningBaseline = planningOnly ? await snapshotGitState(repositoryPath) : undefined;
        if (planningOnly && !planningBaseline && await gitRepositoryAvailable(repositoryPath) !== false) {
            this.recordActivity(request.runId, activityStage, { kind: "planning.rejected", status: "git_state" });
            return { status: "failure", code: "completion_invalid", tokens: 0 };
        }
        let taskPrompt;
        try {
            taskPrompt = prompt(request, planDirectory, await packagedSkills(request.stage), focus);
        }
        catch {
            return { status: "failure", code: fitStage ? "fit_unavailable" : "adapter_failed", tokens: 0 };
        }
        let tokens = 0;
        let events;
        let mutationStart;
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens: 0 };
        const processRunId = `${request.runId.slice(0, 70)}-${randomUUID()}`;
        this.active.set(request.runId, processRunId);
        if (request.stage === "review" && projected.selection.provider === "codex") {
            const modelArgs = projected.selection.model === "*" ? [] : ["-m", projected.selection.model];
            let result;
            try {
                result = await this.runner.run({ routeId: "codex", executable: "codex", args: ["exec", "review", "--uncommitted", "--json", ...modelArgs, "-c", `model_reasoning_effort="${projected.reasoning.providerLevel}"`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--ephemeral"], stdin: "", cwd: repositoryPath, timeoutMs: projected.limits.timeoutMs, runId: processRunId, onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity) });
            }
            catch {
                return { status: "failure", code: "adapter_failed", tokens: 0 };
            }
            const reportedTokens = result.usage && Number.isSafeInteger(result.usage.tokens) && result.usage.tokens >= 0 ? result.usage.tokens : 0;
            if (this.cancelled.has(request.runId) && result.unknownSideEffect)
                return { status: "failure", code: "interrupted", tokens: reportedTokens };
            if (result.cancelled)
                return { status: "failure", code: "cancelled", tokens: reportedTokens };
            if (!result.usage || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0)
                return { status: "failure", code: "adapter_failed", tokens: 0 };
            if (result.usage.tokens > projected.limits.tokenBudget)
                return { status: "failure", code: "token_budget", tokens: result.usage.tokens };
            if (result.exitCode !== 0 || result.timedOut || result.unknownSideEffect || !Array.isArray(result.events))
                return { status: "failure", code: "adapter_failed", tokens: result.usage.tokens };
            tokens = result.usage.tokens;
            events = result.events;
        }
        else {
            let lastAttemptSideEffectFree = false;
            const observedRunner = {
                executableAvailable: (executable) => this.runner.executableAvailable(executable),
                run: async (invocation) => {
                    const result = await this.runner.run(invocation);
                    lastAttemptSideEffectFree = result.sideEffectFree === true;
                    return result;
                },
                attestIsolation: () => this.runner.attestIsolation?.(),
            };
            const adapter = createAgentAdapter(projected.selection, observedRunner);
            if (!adapter)
                return { status: "failure", code: fitStage ? "fit_unavailable" : "crewmate_unavailable", tokens: 0 };
            if (!freshSessionFallback.backgroundBriefUsed && BACKGROUND_BRIEF_STAGES.some((stage) => stage === request.stage)) {
                freshSessionFallback.backgroundBriefUsed = true;
                const brief = await adapter.readOnlyBackgroundBrief({ runId: processRunId, repositoryPath, role: projected, task: { prompt: backgroundBriefPrompt(request, planDirectory) } }).catch(() => undefined);
                if (brief)
                    taskPrompt = `${taskPrompt}\n\nBackground planning brief (advisory context only):\n${brief}`;
            }
            let receipt;
            const questionDiscovery = fitStage || request.stage === "gather-supplies" && request.gatherMode === "questions";
            const journeySession = request.stage !== "review";
            const providerSessionKey = this.providerSessionKey(repositoryPath, request.runId, projected.selection);
            const continuation = journeySession ? request.providerSessionId ?? this.providerSessions.get(providerSessionKey) : undefined;
            const productAuthorSessionKey = coordinatedExpedition && productAuthor ? `${providerSessionKey}::product-author` : undefined;
            const productAuthorContinuation = productAuthorSessionKey && journeySession ? this.providerSessions.get(productAuthorSessionKey) : undefined;
            const executionIdentity = coordinatedExpedition && productAuthor && reviewer
                ? `\n\nCoordinator identity: ${projected.identity}. Product authorship is reserved for ${productAuthor.identity}.\nReviewer identity: ${reviewer.identity}; the reviewer never implements or coordinates.`
                : "";
            const readOnlyDispatch = coordinatedExpedition || questionDiscovery;
            let coordinationTokens = 0;
            let productAuthorDispatched = false;
            try {
                receipt = await adapter.execute({ runId: processRunId, sessionScope: request.runId, repositoryPath, role: { ...projected, sessionId: journeySession ? projected.sessionId : null, authority: { ...projected.authority, write: readOnlyDispatch ? false : projected.authority.write, network: request.selection.provider === "agy", externalAction: false }, toolAllow: readOnlyDispatch ? projected.toolAllow.filter((tool) => !/write|edit|shell|bash/i.test(tool)) : projected.toolAllow }, task: { prompt: `${taskPrompt}${executionIdentity}` }, onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity), ...(continuation ? { providerSessionId: continuation } : {}), ...(executionStage ? { focusMode: true } : {}), ...(request.stage === "execute-expedition" ? { allowSubagents: true } : {}) });
            }
            catch {
                return { status: "failure", code: fitStage ? "fit_unavailable" : "adapter_failed", tokens: 0 };
            }
            if (receipt.status === "completed" && coordinatedExpedition && productAuthor) {
                if (journeySession && receipt.providerSessionId)
                    this.providerSessions.set(providerSessionKey, receipt.providerSessionId);
                coordinationTokens = receipt.usage.tokens;
                const handoff = receipt.events.flatMap((event) => typeof event.data?.content === "string" ? [event.data.content] : []).at(-1);
                if (!handoff)
                    return { status: "failure", code: "result_missing", tokens: coordinationTokens };
                // Issue 93's write probe: prove the exact base the Focus envelope was built from is still
                // untouched before the distinct authorized worker is ever dispatched. `readOnlyDispatch` and
                // the filtered `toolAllow` above are advisory to a cooperative provider; this Git-based check
                // is the structural backstop when a coordinator session (or a subagent it spawned) ignores
                // them and mutates the product/slice write set anyway. Fail closed with a typed role-boundary
                // violation rather than falling through to the end-of-run Focus completion check, which would
                // otherwise surface this as ordinary, recoverable Focus drift instead of an authority breach.
                const preDispatchMutated = focus ? await focusPreDispatchMutation(repositoryPath, focus) : undefined;
                if (!focus || preDispatchMutated === undefined || preDispatchMutated.length > 0) {
                    this.recordActivity(request.runId, activityStage, { kind: "expedition.rejected", status: "role_boundary_violation" });
                    return { status: "failure", code: "role_boundary_violation", ...(preDispatchMutated ? { mutatedPaths: preDispatchMutated } : {}), tokens: coordinationTokens };
                }
                mutationStart = new Date().toISOString();
                const productAdapter = createAgentAdapter(productAuthor.selection, observedRunner);
                if (!productAdapter)
                    return { status: "failure", code: "crewmate_unavailable", tokens: coordinationTokens };
                if (this.cancelled.has(request.runId))
                    return { status: "failure", code: "cancelled", tokens: coordinationTokens };
                // Bound the Crewmate to what remains of the coordinator's own per-call ceiling so the two
                // dispatches together cannot exceed it. MAX_SAFE_INTEGER is the unlimited-route sentinel
                // (e.g. AGY, which rejects any other value); leave it untouched rather than subtracting.
                const remainingTokenBudget = projected.limits.tokenBudget === Number.MAX_SAFE_INTEGER
                    ? Number.MAX_SAFE_INTEGER
                    : Math.max(0, projected.limits.tokenBudget - coordinationTokens);
                productAuthorDispatched = true;
                try {
                    receipt = await productAdapter.execute({
                        runId: processRunId,
                        sessionScope: request.runId,
                        repositoryPath,
                        role: {
                            ...productAuthor,
                            sessionId: journeySession ? productAuthor.sessionId : null,
                            authority: { ...productAuthor.authority, network: request.selection.provider === "agy", externalAction: false },
                            limits: { ...productAuthor.limits, tokenBudget: remainingTokenBudget },
                        },
                        task: { prompt: `${taskPrompt}${executionIdentity}\n\nNavigator coordination handoff (read-only; advisory to the product author):\n${handoff}` },
                        onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity),
                        focusMode: true,
                        ...(productAuthorContinuation ? { providerSessionId: productAuthorContinuation } : {}),
                    });
                }
                catch {
                    return { status: "failure", code: "adapter_failed", tokens: coordinationTokens };
                }
            }
            if (receipt.status !== "completed") {
                if (receipt.failure === "session_unavailable") {
                    this.providerSessions.delete(productAuthorDispatched && productAuthorSessionKey ? productAuthorSessionKey : providerSessionKey);
                    if (!freshSessionFallback.used && lastAttemptSideEffectFree) {
                        freshSessionFallback.used = true;
                        const { providerSessionId: _deadProviderSessionId, ...freshRequest } = request;
                        const fallback = await this.executeOnce(freshRequest, activityStage, false, freshSessionFallback);
                        return { ...fallback, tokens: coordinationTokens + receipt.usage.tokens + fallback.tokens, sessionContinuity: "lost" };
                    }
                    return { status: "failure", code: "session_unavailable", tokens: coordinationTokens + receipt.usage.tokens, sessionContinuity: "lost" };
                }
                return { status: "failure", code: this.cancelled.has(request.runId) && (receipt.status === "blocked_reconcile" || receipt.failure === "unknown_side_effect") ? "interrupted" : receipt.failure === "token_budget" ? "token_budget" : receipt.failure === "cancelled" ? "cancelled" : fitStage ? "fit_unavailable" : "adapter_failed", tokens: coordinationTokens + receipt.usage.tokens };
            }
            if (!coordinatedExpedition && journeySession && receipt.providerSessionId)
                this.providerSessions.set(providerSessionKey, receipt.providerSessionId);
            if (coordinatedExpedition && productAuthorSessionKey && journeySession && receipt.providerSessionId)
                this.providerSessions.set(productAuthorSessionKey, receipt.providerSessionId);
            tokens = coordinationTokens + receipt.usage.tokens;
            events = receipt.events;
        }
        if (planningBaseline && !await planningCompletionValid(repositoryPath, planningBaseline, planningWriteDirectory)) {
            this.recordActivity(request.runId, activityStage, { kind: "planning.rejected", status: "tracked_output_mutation" });
            return { status: "failure", code: "completion_invalid", tokens };
        }
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens };
        const assistantText = events.flatMap((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof event.data?.content === "string" ? [event.data.content] : []).at(-1);
        if (!assistantText)
            return fitStage ? malformedFitResult(tokens, "result_envelope", "assistantText") : { status: "failure", code: "result_missing", tokens };
        if (request.stage === "review" && request.selection.provider === "codex") {
            const summary = assistantText.trim().slice(0, MAX_TEXT).trim();
            return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : text(summary) ? { status: "action", summary, artifacts: [], tokens } : { status: "failure", code: "result_malformed", tokens };
        }
        const availableQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions" ? Math.min(MAX_GATHER_QUESTIONS, Math.max(0, MAX_QA - request.priorOwnerQa.length)) : MAX_QA - 1;
        const resultEnvelope = envelope(assistantText, availableQuestions, fitStage ? repositoryPath : undefined);
        if (resultEnvelope === "missing")
            return fitStage ? malformedFitResult(tokens, "result_envelope", "envelope") : { status: "failure", code: "result_missing", tokens };
        if (resultEnvelope === "malformed")
            return fitStage ? malformedFitResult(tokens, "result_envelope", "envelope") : { status: "failure", code: "result_malformed", tokens };
        const parsed = resultEnvelope.receipt;
        if (resultEnvelope.droppedEstimate)
            this.recordActivity(request.runId, activityStage, { kind: "estimate.dropped", status: resultEnvelope.droppedEstimate });
        if (parsed.kind === "fit") {
            return parsed.fit.ok
                ? { status: "question", question: parsed.fit.question, fitAssumption: parsed.fit.assumption, tokens }
                : parsed.fit.reason === "fit_malformed"
                    ? { status: "failure", code: "fit_malformed", fitDiagnostic: parsed.fit.diagnostic, tokens }
                    : { status: "failure", code: parsed.fit.reason, tokens };
        }
        const expectedEstimate = (stage) => {
            if (!parsed.nextStageEstimate || parsed.nextStageEstimate.stage === stage)
                return parsed.nextStageEstimate;
            this.recordActivity(request.runId, activityStage, { kind: "estimate.dropped", status: "stage_invalid" });
            return undefined;
        };
        if (parsed.kind === "questions") {
            if (request.stage !== "gather-supplies" || request.gatherMode !== "questions")
                return { status: "failure", code: "result_malformed", tokens };
            const nextStageEstimate = expectedEstimate("gather-supplies");
            // Issue 83: drop re-asked decisions (the recorded answer is reused) and
            // turn changed decisions into explicit amendments before the owner sees
            // anything; forced options can never replace an accepted free-text answer.
            const questions = resolveGatherQuestions(parsed.questions.filter((question) => question.toLowerCase() !== "anything else?"), request.priorOwnerQa);
            return { status: "question", ...(questions[0] ? { question: questions[0] } : {}), questions, tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
        }
        if (parsed.kind === "question") {
            if (request.stage === "gather-supplies" && request.gatherMode !== undefined)
                return { status: "failure", code: "result_malformed", tokens };
            const nextStageEstimate = expectedEstimate(request.stage);
            return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : { status: "question", question: parsed.question, tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
        }
        if (request.stage === "gather-supplies" && request.gatherMode === "questions")
            return { status: "failure", code: "result_malformed", tokens };
        if (parsed.kind === "recon" && request.stage !== "recon")
            return { status: "failure", code: "result_malformed", tokens };
        const nextStageEstimate = expectedEstimate(nextStage(request.stage));
        for (const artifact of parsed.artifacts) {
            if (!await containedPath(repositoryPath, artifact))
                return { status: "failure", code: "artifact_invalid", tokens };
            if (this.cancelled.has(request.runId))
                return { status: "failure", code: "cancelled", tokens };
        }
        if (!stageArtifactsValid(request.stage, parsed.artifacts, planDirectory, parsed.kind === "recon" ? parsed.recon : undefined))
            return { status: "failure", code: "artifact_invalid", tokens };
        if (parsed.kind === "recon" && !reconBaseline) {
            this.recordActivity(request.runId, activityStage, { kind: "recon.rejected", status: "git_state" });
            return { status: "failure", code: "completion_invalid", tokens };
        }
        if (parsed.kind === "recon" && reconBaseline && !await reconCompletionValid(repositoryPath, reconBaseline, parsed.artifacts, parsed.recon))
            return { status: "failure", code: "artifact_invalid", tokens };
        const planned = request.stage === "draft-implementation" ? await planningReview(repositoryPath, planDirectory, request.selection).catch(() => undefined) : undefined;
        const finalReviewValid = executionStage ? await executionReviewValid(repositoryPath, planDirectory).catch(() => false) : true;
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens };
        if (request.stage === "draft-implementation" && (planned === undefined || planned.status !== "ok")) {
            // Issue 86: an invalid implementation stays an artifact failure, while a failure to
            // generate or write the final review.html is reported distinctly so the owner can tell
            // an agent-document defect from a Bearing-side review failure.
            return { status: "failure", code: planned === undefined || planned.status === "implementation_invalid" ? "artifact_invalid" : "review_generation_failed", tokens };
        }
        if (!finalReviewValid)
            return { status: "failure", code: "artifact_invalid", tokens };
        let verification;
        if (executionStage && focus) {
            const evidence = parsed.kind === "action" ? parsed.evidence ?? [] : [];
            const completion = await validateFocusCompletion(focus, repositoryPath, parsed.artifacts, evidence).catch(() => ({ ok: false, reason: "git_state" }));
            if (!completion.ok) {
                this.recordActivity(request.runId, activityStage, { kind: "focus.rejected", status: completion.reason });
                return { status: "failure", code: "completion_invalid", tokens };
            }
            verification = validateScope(await completedValidatorScope(repositoryPath, planDirectory, focus, completion, evidence, parsed.summary));
            this.recordActivity(request.runId, activityStage, { kind: "focus.completed", status: "validated" });
        }
        else if (parsed.kind === "action" && parsed.evidence)
            return { status: "failure", code: "result_malformed", tokens };
        const artifacts = request.stage === "draft-implementation" && planDirectory ? [...new Set([...parsed.artifacts, posix.join(planDirectory, "review.html")])] : parsed.artifacts;
        if (parsed.kind === "recon")
            this.reconBaselines.delete(reconKey);
        return {
            status: "action",
            summary: parsed.summary,
            artifacts,
            tokens,
            ...(parsed.kind === "recon" ? { recon: parsed.recon } : {}),
            ...(planned && planned.status === "ok" ? { planningReview: planned.review, planningValidation: planned.planningValidation } : {}),
            ...(verification === undefined ? {} : { verification }),
            ...(nextStageEstimate ? { nextStageEstimate } : {}),
            ...(coordinatedExpedition && productAuthor && focus && mutationStart
                ? { implementationProvenance: { workerIdentity: productAuthor.identity, base: focus.beforeHead ?? "unborn", focus: focus.envelope.currentAcceptanceCriterion, mutationStart } }
                : {}),
        };
    }
    async executeMapRoute(request) {
        const freshSessionFallback = { used: false, backgroundBriefUsed: false };
        const design = await this.executeOnce(request, "map-route", true, freshSessionFallback);
        if (design.status !== "action")
            return design;
        let designArtifacts;
        try {
            designArtifacts = await designReviewArtifacts(request.repositoryPath, request.planDirectory, true, () => this.cancelled.has(request.runId));
        }
        catch {
            designArtifacts = undefined;
        }
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens: design.tokens, ...(design.sessionContinuity ? { sessionContinuity: design.sessionContinuity } : {}) };
        if (!designArtifacts) {
            const findings = await designCheckpointFindings(request.repositoryPath, request.planDirectory);
            return { status: "failure", code: "artifact_invalid", ...(findings.length ? { findings } : {}), tokens: design.tokens, ...(design.sessionContinuity ? { sessionContinuity: design.sessionContinuity } : {}) };
        }
        this.recordActivity(request.runId, "map-route", { kind: "design.ready", status: "completed" });
        return { ...design, artifacts: [...new Set([...design.artifacts, ...designArtifacts])] };
    }
    async execute(request) {
        if (request.stage !== "recon")
            this.reconBaselines.delete(this.reconKey(request.repositoryPath, request.runId));
        try {
            const result = request.stage === "map-route" ? await this.executeMapRoute(request) : await this.executeOnce(request);
            const focusKey = this.focusKey(request.repositoryPath, request.runId);
            const focus = request.stage === "execute-expedition" ? this.focusContexts.get(focusKey)?.context : undefined;
            const selectedScope = focus && focus.envelope.remainingSlices.length === 1
                ? {
                    currentSlice: focus.envelope.remainingSlices[0],
                    remainingSlices: [...focus.envelope.remainingSlices],
                    allowedPaths: [...focus.envelope.allowedPaths],
                    seitCommandIds: [...focus.envelope.seitCommandIds],
                }
                : undefined;
            if ((request.stage === "execute-explorer" || request.stage === "execute-expedition") && result.status === "action" && result.verification)
                this.focusContexts.delete(focusKey);
            return selectedScope ? { ...result, selectedScope } : result;
        }
        finally {
            this.active.delete(request.runId);
            this.cancelled.delete(request.runId);
        }
    }
}
