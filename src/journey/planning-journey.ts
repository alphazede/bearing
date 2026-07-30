import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { BUILTIN_ROUTES, createAgentAdapter, type ProcessActivity, type ProcessRunner, type RouteDescriptor } from "../adapters/adapters.js";
import type { ResolvedRun, Selection } from "../profile/profile.js";
import { createFocusContext, snapshotGitState, validateFocusCompletion, type CommandEvidence, type FocusContext, type FocusContextResult } from "./focus-mode.js";
import { planDirectoryValid } from "./plan-directory.js";
import { resolvePlanDirectory } from "./plan-resolution.js";
import { artifactComplete, parsePlanDocuments, structuralFindings, type PlanDocuments, type StructuralFindingCode } from "./plan-structure.js";
import { advancePlanning, next, planningValidationSignal, type PlanningSignal, type PlanningState, type PlanningValidationRecord } from "./planning-state.js";
import { validatePlan, type Finding } from "./planning-validator.js";
import { routeRecon, type ReconBrief, type ReconReport } from "./recon.js";
import { FIT_EVIDENCE_KINDS, fitMalformed, validateFitReceipt, type FitAssumption, type FitDiagnostic, type FitReceipt } from "./repository-fit.js";
import { setBearingsWorkspace } from "./repository-map.js";
import { RECORD_JOURNEY_CHECKPOINT_STAGES } from "../contracts/run.js";
import { validateScope, type ValidatorReport, type ValidatorScope } from "../verification/validator.js";

// ponytail: derived from the ledger tuple rather than restated. A hand-written
// copy has to be kept in step with the ledger by hand, and a stage the ledger
// rejects cannot be checkpointed at all.
export type JourneyStage = (typeof RECORD_JOURNEY_CHECKPOINT_STAGES)[number];
export type PlanningPass = "set-bearings" | "gather-supplies" | "recon" | "map-the-route" | "draft-implementation" | "planning-validator";

export type PlanningOrchestrationResult =
  | {
    readonly planningState: PlanningState;
    readonly findings: readonly unknown[];
    readonly artifacts: readonly string[];
    readonly planningValidation?: PlanningValidationRecord;
  }
  | {
    readonly refused: "illegal_transition";
    readonly findings: readonly unknown[];
    readonly artifacts: readonly string[];
  };

function validationRecord(verdict: ReturnType<typeof validatePlan>, currentContentHash = verdict.checkedContentHash): PlanningValidationRecord {
  return { ...verdict, currentContentHash };
}

export function orchestratePlanning(input: {
  readonly currentState: PlanningState;
  readonly pass: PlanningPass;
  readonly artifacts?: readonly string[];
  readonly documents?: PlanDocuments;
  readonly planDirectory?: string;
  readonly planningValidation?: PlanningValidationRecord;
  readonly recon?: { readonly brief?: unknown; readonly report?: unknown };
  readonly failureSignal?: PlanningSignal;
}): PlanningOrchestrationResult {
  const artifacts = input.artifacts ?? [];
  const record = (state: PlanningState, signal: PlanningSignal, validation?: PlanningValidationRecord): PlanningState | "illegal_transition" =>
    advancePlanning(state, signal, validation);
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
    if (!routed.ok) return { refused: "illegal_transition", findings: routed.issues, artifacts };
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
    if (input.currentState === "ARCHITECTURE_READY") return { planningState: input.currentState, findings: [], artifacts };
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
    if (!signal) return { refused: "illegal_transition", findings: [], artifacts };
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

  let findings: readonly Finding[] | readonly unknown[] = input.planningValidation?.findings ?? [];
  let planningValidation = input.planningValidation;
  if (input.documents && input.planDirectory) {
    const current = validatePlan({ documents: input.documents, planDirectory: input.planDirectory });
    findings = current.findings;
    planningValidation = input.planningValidation
      ? { ...input.planningValidation, currentContentHash: current.checkedContentHash }
      : validationRecord(current);
  }
  const signal = planningValidationSignal(planningValidation);
  if (!signal || !planningValidation) return { refused: "illegal_transition", findings, artifacts };
  const planningState = record(input.currentState, signal, planningValidation);
  return planningState === "illegal_transition"
    ? { refused: planningState, findings, artifacts }
    : { planningState, findings, artifacts, planningValidation };
}

export function planningCheckpointFields(input: {
  readonly stage: JourneyStage;
  readonly status: string;
  readonly previousState?: PlanningState;
  readonly planningValidation?: PlanningValidationRecord;
  readonly recon?: { readonly brief?: unknown; readonly report?: unknown };
  readonly failureReason?: string;
  readonly failureStage?: "map-route" | "recon" | "draft-implementation";
}): { readonly planningState?: PlanningState; readonly planningFailure?: string } | { readonly refused: "illegal_transition" } {
  if (input.previousState === undefined) return {};

  if (input.status === "complete") {
    if (input.stage === "recon") {
      const recon = orchestratePlanning({ currentState: input.previousState, pass: "recon", recon: input.recon });
      if ("refused" in recon) return { refused: recon.refused };
      return recon.planningState === "RECON_FAILED" || recon.planningState === "OWNER_DECISION_REQUIRED"
        ? { planningFailure: recon.planningState }
        : { planningState: recon.planningState };
    }
    if (input.stage === "map-route") {
      const recoveringFailedPlan = input.previousState === "MISSING_VALIDATION"
        || input.previousState === "UNSAFE_PARALLELISM"
        || input.previousState === "OWNER_DECISION_REQUIRED";
      const mapped = orchestratePlanning({ currentState: input.previousState, pass: "map-the-route" });
      if ("refused" in mapped) return { refused: mapped.refused };
      if (recoveringFailedPlan && !input.planningValidation) {
        const planningState = next(mapped.planningState, "planningValidated");
        return planningState === "illegal_transition"
          ? { refused: planningState }
          : { planningState };
      }
      if (!input.planningValidation) return { planningState: mapped.planningState };
      const validated = orchestratePlanning({ currentState: mapped.planningState, pass: "planning-validator", planningValidation: input.planningValidation });
      if ("refused" in validated) return { refused: validated.refused };
      return planningValidationSignal(input.planningValidation) === "planningValidated"
        ? { planningState: validated.planningState }
        : { planningFailure: validated.planningState };
    }
    if (input.stage === "gather-supplies") {
      const gathered = orchestratePlanning({ currentState: input.previousState, pass: "gather-supplies" });
      return "refused" in gathered ? { refused: gathered.refused } : { planningState: gathered.planningState };
    }
    if (input.stage !== "draft-implementation") return {};
    const mapped = orchestratePlanning({ currentState: input.previousState, pass: "draft-implementation" });
    if ("refused" in mapped) return { refused: mapped.refused };
    if (!input.planningValidation) return { planningState: mapped.planningState };
    const validated = orchestratePlanning({ currentState: mapped.planningState, pass: "planning-validator", planningValidation: input.planningValidation });
    if ("refused" in validated) return { refused: validated.refused };
    return planningValidationSignal(input.planningValidation) === "planningValidated"
      ? { planningState: validated.planningState }
      : { planningFailure: validated.planningState };
  }

  if (input.status !== "failed" || input.failureReason === undefined) return {};
  let previousState = input.previousState;
  if (input.stage === "map-route" && input.failureStage === "draft-implementation") {
    const mapped = orchestratePlanning({ currentState: previousState, pass: "map-the-route" });
    if ("refused" in mapped) return { refused: mapped.refused };
    previousState = mapped.planningState;
  }
  const failureStage = input.failureStage ?? input.stage;
  const signals: readonly PlanningSignal[] = failureStage === "gather-supplies"
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
    if (!("refused" in projected) && projected.planningState === input.failureReason) return { planningFailure: projected.planningState };
  }
  return { refused: "illegal_transition" };
}
export interface OwnerAnswer { readonly question: string; readonly answer: string; }
export interface JourneyRequest {
  readonly selection: Selection;
  readonly run: ResolvedRun;
  readonly repositoryPath: string;
  readonly runId: string;
  readonly workGoal: string;
  readonly stage: JourneyStage;
  readonly priorOwnerQa: readonly OwnerAnswer[];
  readonly gatherMode?: "questions" | "apply";
  readonly planDirectory?: string;
  readonly requestedPlanDirectory?: string;
  readonly reviewPrompt?: string;
  readonly gateFailureFingerprint?: string;
  readonly focusAmendmentConfirmed?: boolean;
  readonly providerSessionId?: string;
}
export type JourneyFailureCode = "input_invalid" | "plan_directory_invalid" | "plan_directory_absent" | "plan_directory_ambiguous" | "selection_mismatch" | "crewmate_unavailable" | "adapter_failed" | "session_unavailable" | "cancelled" | "interrupted" | "token_budget" | "result_missing" | "result_malformed" | "artifact_invalid" | "focus_invalid" | "focus_amendment_required" | "completion_invalid" | "fit_unavailable" | "fit_malformed" | "fit_undecidable";
const FOCUS_PLAN_SOURCES = ["plan-spec.md", "design.md", "seit.md", "implementation.md"] as const;
export type FocusPlanSourceName = (typeof FOCUS_PLAN_SOURCES)[number];
export type FocusPlanHashes = Readonly<Record<FocusPlanSourceName, string>>;
export interface FocusContractSnapshot {
  readonly context: FocusContext;
  readonly planHashes: FocusPlanHashes;
}
export interface FocusDrift {
  readonly addedAllowedPaths: readonly string[];
  readonly removedAllowedPaths: readonly string[];
  readonly addedSeitCommandIds: readonly string[];
  readonly removedSeitCommandIds: readonly string[];
  readonly changedAcceptanceCriterion?: { readonly previous: string; readonly candidate: string };
  readonly changedRemainingSlices?: { readonly previous: readonly string[]; readonly candidate: readonly string[] };
  readonly changedObjective?: { readonly previous: string; readonly candidate: string };
  readonly changedRole?: { readonly previous: string; readonly candidate: string };
  readonly changedPlanSources: readonly string[];
}
export interface PlanningAssignment {
  readonly slice: string;
  readonly role: string;
  readonly model: string;
  readonly reasoning: string;
}
export interface PlanningReview {
  readonly phases: number;
  readonly slices: number;
  readonly assignments: readonly PlanningAssignment[];
}
export interface JourneyActivity {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly kind: string;
  readonly status?: string;
  readonly tool?: string;
}
export interface NextStageEstimate {
  readonly stage: JourneyStage | "execute";
  readonly minMinutes: number;
  readonly maxMinutes: number;
  readonly basis: string;
}
export type JourneyResult = (
  | { readonly status: "question"; readonly question?: string; readonly questions?: readonly string[]; readonly fitAssumption?: FitAssumption; readonly tokens: number; readonly nextStageEstimate?: NextStageEstimate }
  | { readonly status: "action"; readonly summary: string; readonly artifacts: readonly string[]; readonly tokens: number; readonly recon?: JourneyReconResult; readonly planningReview?: PlanningReview; readonly planningValidation?: PlanningValidationRecord; readonly verification?: ValidatorReport; readonly nextStageEstimate?: NextStageEstimate }
  | { readonly status: "failure"; readonly code: "focus_amendment_required"; readonly focusDrift: FocusDrift; readonly tokens: number; readonly failureStage?: never }
  | { readonly status: "failure"; readonly code: "fit_malformed"; readonly fitDiagnostic: FitDiagnostic; readonly tokens: number; readonly failureStage?: "map-route" | "recon" | "draft-implementation" }
  | { readonly status: "failure"; readonly code: Exclude<JourneyFailureCode, "focus_amendment_required" | "fit_malformed">; readonly tokens: number; readonly failureStage?: "map-route" | "recon" | "draft-implementation" }
) & { readonly sessionContinuity?: "lost" };

function malformedFitResult(tokens: number, check: FitDiagnostic["check"], field: FitDiagnostic["field"]): Extract<JourneyResult, { readonly code: "fit_malformed" }> {
  return { status: "failure", code: "fit_malformed", fitDiagnostic: fitMalformed(check, field).diagnostic, tokens };
}

export type JourneyReconResult =
  | { readonly state: "SKIPPED" }
  | {
    readonly state: "RECON_READY" | "ARCHITECTURE_READY" | "RECON_FAILED" | "OWNER_DECISION_REQUIRED";
    readonly brief: ReconBrief;
    readonly report: ReconReport;
  };

const STAGE_SKILLS: Readonly<Record<JourneyStage, readonly string[]>> = {
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
const STAGE_BOUNDARY: Readonly<Record<JourneyStage, string>> = {
  "repository-fit": "Inspect only the bounded selected-repository evidence and propose one repository and plan-directory assumption for owner confirmation. Do not write, create a directory, or continue into Set Bearings.",
  "set-bearings": "Create or resume only the plan directory and plan-spec.md stub. Bearing may retain a bounded repository inventory as internal runtime evidence, but plan-local prompt persistence is not required. Do not grill, design, draft implementation.md, or implement the work.",
  "gather-supplies": "Use the complete owner Q&A and update only the validated plan specification. Do not run design, draft implementation.md, or implement the work. Return an action receipt whose artifacts include the validated plan-spec.md path.",
  "map-route": "Use the design substep of Map the Route. Before writing any design artifact, stop at its normal owner lens-approval question when lens approval is not already recorded in the prior owner Q&A. After approval, produce valid complete or amended design.md and seit.md, including stable DES/CONTRACT IDs, Use Cases and Communication Flows, Interface Option Check, OOPDSA Implementation Design, and the prospective SEIT Traceability Matrix. Bearing generates review.html deterministically from the current Markdown sources; do not write or summarize review.html. Stop at the design-and-SEIT validation checkpoint. Do not write implementation.md or execute implementation in this substep. A successful action receipt must include design.md and seit.md in the validated plan directory.",
  recon: "After architecture and before implementation drafting, run at most one smallest bounded experiment for one material assumption. If no material assumption needs Recon, return the explicit skipped Recon receipt with no brief, report, or artifacts. Otherwise return one complete brief and matching report in the Recon receipt; a brief without its report is incomplete. Prototype paths remain non-production and must be returned as the complete artifact list. Do not draft implementation.md or execute implementation.",
  "draft-implementation": "Continue the implementation-drafting substep of Map the Route after the validated design and SEIT checkpoint. Draft implementation.md without executing any slice. Keep each slice reference-only with Goal, Requirement IDs, Design IDs, SEIT proof rows, Type, Design lenses, Implementation role, Agent model route, Agent reasoning level, and Review path. Ponytail mode is optional; when present, use the lowercase value `full` or `off`; trailing sentence punctuation such as `full.` is normalized. Requirement, design, and SEIT IDs must exist in their owning documents and each slice's referenced SEIT rows must map its requirement and design IDs. Follow every slice with a matching `### <slice-id> execution manifest` containing Write set, Command IDs, Stop condition, and Human decision. Close each write set with `only` and exact backticked paths, or explicitly declare no writes. Command IDs must be defined in seit.md and mapped by the slice's SEIT proof rows. Declare contiguous Wave 1 through Wave N dependencies when there is more than one slice. Do not restate acceptance, design contracts, test cases, commands, evidence, or execution packet prose. Preserve per-slice assignments for execution; do not replace them with onboarding settings. The Review path must use the harness-native reviewer when available or the Surveyor fallback when unavailable. Bearing generates review.html deterministically from plan-spec.md, design.md, seit.md, and implementation.md; do not write or summarize it. A successful action receipt must include implementation.md.",
  "execute-explorer": "Execute the approved implementation plan with Explorer and honor each recorded slice model route, reasoning level, Ponytail mode, and review cadence. Do not overwrite slice assignments with onboarding settings. After implementation and validation, replace the one Bearing-owned `<section id=\"bearing-final-qa\" data-status=\"pending\">` baseline with exactly one `<section id=\"bearing-final-qa\" data-status=\"complete\">` containing non-empty `Planned versus actual: <evidence>` and `Validation evidence: <evidence>` text. Put each labeled value in its own attribute-free `<p>` and use plain text only: no nested HTML, markup, `<`, or `>` in either evidence value. Preserve every current embedded planning source and canonical source link. The action receipt must include review.html and every actual changed artifact. Return only paths that actually exist.",
  "execute-expedition": "Execute the approved implementation plan with Expedition and honor each recorded slice model route, reasoning level, Ponytail mode, and review cadence. Do not overwrite slice assignments with onboarding settings. After implementation and validation, replace the one Bearing-owned `<section id=\"bearing-final-qa\" data-status=\"pending\">` baseline with exactly one `<section id=\"bearing-final-qa\" data-status=\"complete\">` containing non-empty `Planned versus actual: <evidence>` and `Validation evidence: <evidence>` text. Put each labeled value in its own attribute-free `<p>` and use plain text only: no nested HTML, markup, `<`, or `>` in either evidence value. Preserve every current embedded planning source and canonical source link. The action receipt must include review.html and every actual changed artifact. Return only paths that actually exist.",
  review: "Perform a read-only review of the integrated uncommitted work. Do not modify files. Return existing evidence paths relevant to the review.",
};
function nextStage(stage: JourneyStage): NextStageEstimate["stage"] { return stage === "repository-fit" ? "set-bearings" : stage === "set-bearings" ? "gather-supplies" : stage === "gather-supplies" ? "map-route" : stage === "map-route" ? "recon" : stage === "recon" ? "draft-implementation" : stage === "draft-implementation" ? "execute" : "review"; }
const MAX_TEXT = 4096;
const MAX_QA = 64;
const MAX_GATHER_QUESTIONS = 3;
const MAX_ARTIFACTS = 32;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_ESTIMATE_BASIS = 280;
const MAX_ACTIVITY_TRAIL = 20;
const SAFE_ACTIVITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET_ACTIVITY = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/i;

function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function pathText(value: unknown): value is string { return text(value) && !/[\\\r\n\t]/.test(value); }

function focusRejectionStatus(failure: Extract<FocusContextResult, { readonly ok: false }>): string {
  const segment = (value: string | undefined, fallback: string): string =>
    (value ?? fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || fallback;
  return [
    segment(failure.reason, "invalid"),
    segment(failure.sliceId, "unknown"),
    segment(failure.field, "unknown"),
  ].join(":").slice(0, 128);
}

function sameRoute(left: Selection, right: Selection): boolean {
  return left.provider === right.provider && left.model === right.model;
}

async function containedPath(root: string, value: string, directoryOnly = false): Promise<string | undefined> {
  if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value) return undefined;
  const candidate = resolve(root, value);
  const lexical = relative(root, candidate);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return undefined;
  try {
    const canonical = await realpath(candidate);
    const relation = relative(root, canonical);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
    if (directoryOnly && !(await lstat(canonical)).isDirectory()) return undefined;
    return value;
  } catch { return undefined; }
}

function validRequest(request: JourneyRequest): boolean {
  if (!isAbsolute(request.repositoryPath) || !/^[A-Za-z0-9_-]{1,128}$/.test(request.runId) || !text(request.workGoal)) return false;
  if (!(request.stage in STAGE_SKILLS) || !Array.isArray(request.priorOwnerQa) || request.priorOwnerQa.length > MAX_QA) return false;
  return (request.gatherMode === undefined || request.stage === "gather-supplies") &&
    (request.requestedPlanDirectory === undefined || request.stage === "set-bearings" && pathText(request.requestedPlanDirectory)) &&
    (request.providerSessionId === undefined || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.providerSessionId)) &&
    (request.reviewPrompt === undefined || text(request.reviewPrompt)) &&
    (request.gateFailureFingerprint === undefined || text(request.gateFailureFingerprint, 512)) &&
    (request.focusAmendmentConfirmed === undefined || typeof request.focusAmendmentConfirmed === "boolean") &&
    request.priorOwnerQa.every((entry) => typeof entry === "object" && entry !== null && text(entry.question) && text(entry.answer));
}

const MAX_PACKAGED_SKILL_BYTES = 64 * 1024;
async function packagedSkills(stage: JourneyStage): Promise<string> {
  const sources = await Promise.all(STAGE_SKILLS[stage].map(async (name) => {
    const source = await readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    if (Buffer.byteLength(source) > MAX_PACKAGED_SKILL_BYTES || /\u0000/.test(source) || !new RegExp(`^---\\r?\\nname: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\ndescription: [^\\r\\n]+\\r?\\nuser-invocable: false\\r?\\ndisable-model-invocation: true\\r?\\n---(?:\\r?\\n|$)`).test(source)) throw new Error("packaged skill invalid");
    return `### ${name}\n${source}`;
  }));
  return ["Packaged Bearing skills (authoritative workflow instructions for this stage):", ...sources].join("\n\n");
}

function prompt(request: JourneyRequest, planDirectory: string | undefined, skillInstructions: string, focus?: FocusContext): string {
  const gatheringQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions";
  const availableQuestions = Math.min(MAX_GATHER_QUESTIONS, Math.max(0, MAX_QA - request.priorOwnerQa.length));
  const grilling = gatheringQuestions
    ? ` Inspect the repository once and return at most ${availableQuestions} unresolved owner questions. Ask only when the answer materially changes scope, architecture, security, authority, or acceptance. Lead each question with **Recommendation:**, then give concise evidence, 2-3 viable options with material tradeoffs, the affected plan-spec section, and the safe default if unanswered; ask the owner to select explicitly. A recommendation is advice, never approval. State safe defaults as assumptions instead of questions when no owner choice is required. Return an empty array when no material owner decision remains.`
    : request.stage === "gather-supplies"
      ? " All grilling questions are answered. Apply the complete owner Q&A without asking another question; record reasonable assumptions or blockers in the plan specification."
      : " Ask one owner question only when a decision blocks honest progress.";
  const boundary = gatheringQuestions ? "Read and inspect only. Do not create or modify files during question discovery." : STAGE_BOUNDARY[request.stage];
  const reviewCadence = request.stage === "execute-explorer" || request.stage === "execute-expedition" ? ["Read the prior owner Q&A for the recorded Review cadence (each slice, each phase, or end) and enforce that cadence during execution. Use the harness-native reviewer when available and the read-only Surveyor fallback only when no native reviewer is available."] : [];
  const cleanupSetting = [...request.priorOwnerQa].reverse().find((entry) => entry.question === "Cleanup merged worktrees")?.answer ?? "on";
  const cleanupPolicy = request.stage === "execute-explorer" || request.stage === "execute-expedition"
    ? [cleanupSetting === "off"
      ? "Preserve every temporary worktree and branch; the owner disabled automatic cleanup."
      : `Cleanup merged worktrees is on. Merge only through the approved integration or phase gate. Before removing a temporary worktree, prove that it is clean, its branch commit is merged into the integration branch, and no active review, retry, or recovery reference needs it. ${request.stage === "execute-explorer" ? "Clean eligible worktrees after each completed phase." : "Keep parallel lanes until the entire phase is integrated, then clean eligible worktrees."} Delete only the corresponding proven-merged temporary branch. Never force-remove a worktree or branch. Preserve every dirty, unmerged, failed, or blocked lane and report its path and branch with a Resume or Resolve next action.`]
    : [];
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

type Envelope = { readonly kind: "fit"; readonly fit: FitReceipt } | { readonly kind: "question"; readonly question: string; readonly nextStageEstimate?: NextStageEstimate } | { readonly kind: "questions"; readonly questions: readonly string[]; readonly nextStageEstimate?: NextStageEstimate } | { readonly kind: "recon"; readonly summary: string; readonly artifacts: readonly string[]; readonly recon: JourneyReconResult; readonly nextStageEstimate?: NextStageEstimate } | { readonly kind: "action"; readonly summary: string; readonly artifacts: readonly string[]; readonly evidence?: readonly CommandEvidence[]; readonly nextStageEstimate?: NextStageEstimate };
function estimate(value: unknown): value is NextStageEstimate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 4 && typeof item.stage === "string" && (item.stage === "execute" || item.stage in STAGE_SKILLS) &&
    typeof item.minMinutes === "number" && Number.isSafeInteger(item.minMinutes) && item.minMinutes >= 1 && item.minMinutes <= 1_440 &&
    typeof item.maxMinutes === "number" && Number.isSafeInteger(item.maxMinutes) && item.maxMinutes >= item.minMinutes && item.maxMinutes <= 1_440 && text(item.basis, MAX_ESTIMATE_BASIS);
}
type EstimateDropReason = "basis_too_long" | "invalid" | "stage_invalid";
type ParsedEnvelope = { readonly receipt: Envelope; readonly droppedEstimate?: EstimateDropReason };
function optionalEstimate(value: unknown): { readonly value?: NextStageEstimate; readonly dropped?: EstimateDropReason } {
  if (value === undefined) return {};
  if (estimate(value)) return { value };
  const basis = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).basis : undefined;
  return { dropped: typeof basis === "string" && basis.length > MAX_ESTIMATE_BASIS ? "basis_too_long" : "invalid" };
}
function commandEvidence(value: unknown): value is readonly CommandEvidence[] {
  return Array.isArray(value) && value.length <= 128 && value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return Object.keys(item).length === 3 && Object.keys(item).every((key) => ["commandId", "status", "summary"].includes(key)) &&
      typeof item.commandId === "string" && /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/.test(item.commandId) &&
      (item.status === "passed" || item.status === "failed") && text(item.summary, 512);
  });
}
function envelope(value: string, maxQuestions = MAX_QA - 1, fitRepository?: string): ParsedEnvelope | "missing" | "malformed" {
  const line = value.trim().split(/\r?\n/).at(-1) ?? "";
  const prefix = "BEARING_RESULT ";
  if (!line.startsWith(prefix)) return "missing";
  const body = line.slice(prefix.length);
  if (!body || Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) return "malformed";
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
    const record = parsed as Record<string, unknown>;
    if (fitRepository !== undefined) {
      if (record.kind !== "fit") return "malformed";
      const { kind: _kind, ...candidate } = record;
      return { receipt: { kind: "fit", fit: validateFitReceipt(candidate, { repository: fitRepository }) } };
    }
    if (record.kind === "fit") return "malformed";
    const next = optionalEstimate(record.nextStageEstimate);
    if (record.kind === "question" && Object.keys(record).every((key) => ["kind", "question", "nextStageEstimate"].includes(key)) && [2, 3].includes(Object.keys(record).length) && text(record.question)) return { receipt: { kind: "question", question: record.question, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
    if (record.kind === "questions" && Object.keys(record).every((key) => ["kind", "questions", "nextStageEstimate"].includes(key)) && [2, 3].includes(Object.keys(record).length) && Array.isArray(record.questions) && record.questions.length <= maxQuestions && record.questions.every((question) => text(question)) && new Set(record.questions).size === record.questions.length) return { receipt: { kind: "questions", questions: record.questions as string[], ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
    if (record.kind === "recon" && Object.keys(record).every((key) => ["kind", "summary", "artifacts", "brief", "report", "nextStageEstimate"].includes(key)) && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length) {
      const routed = routeRecon({
        ...(Object.hasOwn(record, "brief") ? { brief: record.brief } : {}),
        ...(Object.hasOwn(record, "report") ? { report: record.report } : {}),
      });
      if (!routed.ok || routed.state === "RECON_PENDING") return "malformed";
      const { ok: _ok, ...recon } = routed;
      return { receipt: { kind: "recon", summary: record.summary, artifacts: record.artifacts as string[], recon, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
    }
    if (record.kind === "action" && Object.keys(record).every((key) => ["kind", "summary", "artifacts", "evidence", "nextStageEstimate"].includes(key)) && [3, 4, 5].includes(Object.keys(record).length) && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length > 0 && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length && (record.evidence === undefined || commandEvidence(record.evidence))) return { receipt: { kind: "action", summary: record.summary, artifacts: record.artifacts as string[], ...(record.evidence ? { evidence: record.evidence } : {}), ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
    return "malformed";
  } catch { return "malformed"; }
}

function isPlanSpecArtifactName(name: string): boolean {
  return name === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(name);
}

function stageArtifactsValid(stage: JourneyStage, artifacts: readonly string[], planDirectory: string | undefined, recon?: JourneyReconResult): boolean {
  const inPlan = (path: string): boolean => planDirectory !== undefined && posix.dirname(path) === planDirectory;
  const planSpec = (path: string): boolean => isPlanSpecArtifactName(posix.basename(path));
  const routeReview = (path: string): boolean => posix.basename(path) === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(posix.basename(path));
  if (stage === "repository-fit") return artifacts.length === 0;
  if (stage === "set-bearings") return artifacts.some(planSpec) && artifacts.some((path) => posix.basename(path) === "repository-map.md" && posix.dirname(posix.dirname(path)) === posix.dirname(artifacts.find(planSpec) ?? ""));
  if (stage === "gather-supplies") return artifacts.some((path) => inPlan(path) && planSpec(path));
  if (stage === "map-route") return ["design.md", "seit.md"].every((name) => artifacts.some((path) => inPlan(path) && posix.basename(path) === name));
  if (stage === "recon") {
    if (!recon) return false;
    if (recon.state === "SKIPPED") return artifacts.length === 0;
    return artifacts.length === recon.report.prototypePaths.length
      && recon.report.prototypePaths.every((path) => artifacts.includes(path) && recon.brief.writeSet.includes(path));
  }
  if (stage === "draft-implementation") return artifacts.some((path) => inPlan(path) && posix.basename(path) === "implementation.md");
  if (stage === "execute-explorer" || stage === "execute-expedition") return artifacts.some((path) => inPlan(path) && routeReview(path)) && planDirectory !== undefined && artifacts.some((path) => !path.startsWith(`${planDirectory}/`));
  return true;
}

type GitStateSnapshot = NonNullable<Awaited<ReturnType<typeof snapshotGitState>>>;

async function gitRepositoryAvailable(root: string): Promise<boolean | undefined> {
  const {
    GIT_COMMON_DIR: _gitCommonDir,
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    ...environment
  } = process.env;
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
      resolveAvailability(
        error.code === 128
          && stderr.trim() === "fatal: not a git repository (or any of the parent directories): .git"
          ? false
          : undefined,
      );
    });
  });
}

async function reconCompletionValid(
  root: string,
  before: GitStateSnapshot,
  artifacts: readonly string[],
  recon: JourneyReconResult,
): Promise<boolean> {
  const after = await snapshotGitState(root, before.head);
  if (!after || (after.head !== before.head && after.committedPaths.size === 0)) return false;
  const changed = [...new Set([...before.paths.keys(), ...after.paths.keys(), ...after.committedPaths])]
    .filter((path) => after.committedPaths.has(path) || before.paths.get(path) !== after.paths.get(path));
  if (recon.state === "SKIPPED") return changed.length === 0;
  const allowed = new Set(recon.brief.writeSet);
  return changed.every((path) => allowed.has(path) && artifacts.includes(path));
}

const MAX_PLANNING_ARTIFACT = 2 * 1024 * 1024;

async function readPlanningArtifact(root: string, value: string, allowEmpty = false): Promise<string | undefined> {
  if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value) return undefined;
  const candidate = resolve(root, value), lexical = relative(root, candidate);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
    const relation = relative(root, canonical);
    if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size > MAX_PLANNING_ARTIFACT || !relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
    const buffer = Buffer.allocUnsafe(MAX_PLANNING_ARTIFACT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_PLANNING_ARTIFACT) return undefined;
    const content = buffer.subarray(0, length).toString("utf8");
    return allowEmpty || content.trim() ? content : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function focusPlanHashes(root: string, planDirectory: string): Promise<FocusPlanHashes | undefined> {
  const contents = await Promise.all(
    FOCUS_PLAN_SOURCES.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))),
  );
  if (!contents.every((content): content is string => content !== undefined)) return undefined;
  const hash = (content: string): string => createHash("sha256").update(content).digest("hex");
  return {
    "plan-spec.md": hash(contents[0]),
    "design.md": hash(contents[1]),
    "seit.md": hash(contents[2]),
    "implementation.md": hash(contents[3]),
  };
}

export async function currentPlanningVerdict(root: string, planDirectory: string): Promise<ReturnType<typeof validatePlan> | undefined> {
  try {
    if (!await containedPath(root, planDirectory, true)) return undefined;
    const names = await readdir(resolve(root, planDirectory));
    const planName = names.find(isPlanSpecArtifactName);
    if (!planName || !names.includes("design.md") || !names.includes("seit.md") || !names.includes("implementation.md")) return undefined;
    const [plan, design, seit, implementation] = await Promise.all(
      [planName, "design.md", "seit.md", "implementation.md"].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))),
    );
    return plan && design && seit && implementation
      ? validatePlan({ documents: { plan, design, seit, implementation }, planDirectory })
      : undefined;
  } catch {
    return undefined;
  }
}

async function writePlanningReview(root: string, value: string, content: string): Promise<boolean> {
  if (Buffer.byteLength(content) > MAX_PLANNING_ARTIFACT || !pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value) return false;
  const candidate = resolve(root, value), lexical = relative(root, candidate);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    try {
      handle = await open(candidate, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    } catch {
      handle = await open(candidate, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    }
    const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
    const relation = relative(root, canonical);
    if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || !relation || relation.startsWith("..") || isAbsolute(relation)) return false;
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function escaped(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
const MAX_FOCUS_DRIFT_TEXT = 512;
function boundedEscaped(value: string): string {
  const safe = escaped(value);
  return safe.length <= MAX_FOCUS_DRIFT_TEXT ? safe : `${safe.slice(0, MAX_FOCUS_DRIFT_TEXT - 1)}…`;
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function addedValues(previous: readonly string[], candidate: readonly string[]): readonly string[] {
  const prior = new Set(previous);
  return candidate.filter((value) => !prior.has(value)).map(boundedEscaped);
}

export function focusContractDrift(previous: FocusContractSnapshot, candidate: FocusContractSnapshot): FocusDrift | null {
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
  const changedPlanSources = FOCUS_PLAN_SOURCES
    .filter((name) => previous.planHashes[name] !== candidate.planHashes[name])
    .map(boundedEscaped);
  if (
    !addedAllowedPaths.length &&
    !removedAllowedPaths.length &&
    !addedSeitCommandIds.length &&
    !removedSeitCommandIds.length &&
    !changedAcceptanceCriterion &&
    !changedRemainingSlices &&
    !changedObjective &&
    !changedRole &&
    !changedPlanSources.length
  ) return null;
  return {
    addedAllowedPaths,
    removedAllowedPaths,
    addedSeitCommandIds,
    removedSeitCommandIds,
    ...(changedAcceptanceCriterion ? { changedAcceptanceCriterion } : {}),
    ...(changedRemainingSlices ? { changedRemainingSlices } : {}),
    ...(changedObjective ? { changedObjective } : {}),
    ...(changedRole ? { changedRole } : {}),
    changedPlanSources,
  };
}

function field(section: string, name: string): string | undefined {
  const label = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\*\\*${label}${name.endsWith("?") ? "" : "\\."}\\*\\*\\s*(.+)$`, "mi").exec(section);
  return match?.[1]?.trim();
}

export function structurallyValidImplementation(plan: string, design: string, seit: string, content: string): boolean {
  const model = parsePlanDocuments({ plan, design, seit, implementation: content });
  const legacySection = (source: string, heading: string): string => {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^##[ \\t]+${escapedHeading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(source)?.[1] ?? "";
  };
  const legacyPlanIds = new Set(
    `${legacySection(plan, "Acceptance criteria")}\n${legacySection(plan, "Risks and open questions")}`
      .match(/\b(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*\b/gi)?.map((value) => value.toUpperCase()) ?? [],
  );
  const legacyDesignIds = new Set(
    design.match(/\b(?:DES|CONTRACT)-[A-Z0-9][A-Z0-9.-]*\b/gi)?.map((value) => value.toUpperCase()) ?? [],
  );
  const additions = new Set<StructuralFindingCode>([
    "artifact_frontmatter_invalid",
    "build_command_in_manifest",
    "goal_unbounded",
    "id_format_invalid",
    "writeset_duplicate",
    "writeset_multiline",
    "writeset_readonly_harvest",
  ]);
  return structuralFindings(model).every((finding) => {
    if (additions.has(finding.code) || finding.code === "design_section_missing") return true;
    if (finding.code === "seit_section_missing" && finding.observed === "Cross-cutting Checks") return true;
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
      if (model.slices.size > 1 && !waves.size) return false;
      const lastWave = waves.size ? Math.max(...waves) : 0;
      return !waves.size || lastWave >= 1 && waves.size === lastWave && [...Array(lastWave).keys()].every((index) => waves.has(index + 1));
    }
    return false;
  });
}

function sourceSection(sources: readonly [string, string][]): string {
  return `<section id="bearing-source-artifacts"><h2>Complete planning artifacts</h2><p>These are the complete source documents used for this review.</p>${sources.map(([name, content]) => `<details><summary>${escaped(name)}</summary><pre>${escaped(content)}</pre></details>`).join("")}</section>`;
}

function sourceNavigation(sources: readonly [string, string][]): string {
  return `<nav id="bearing-source-links" aria-label="Planning artifact sources">${sources.map(([name]) => `<a href="./${encodeURIComponent(name)}">${escaped(name)}</a>`).join(" ")}</nav>`;
}

const FINAL_QA_PENDING = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const FINAL_QA_COMPLETE_PREFIX = '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: ';
const FINAL_QA_COMPLETE_MIDDLE = "</p><p>Validation evidence: ";
const FINAL_QA_COMPLETE_SUFFIX = "</p></section>";

export function renderPlanningReview(sources: readonly [string, string][]): string {
  const planningFlow = '<figure><div class="flow" role="img" aria-label="Planning flow from plan specification through final QA"><span>Plan specification</span><b>→</b><span>Design</span><b>→</b><span>SEIT test map</span><b>→</b><span>Implementation</span><b>→</b><span>Final QA</span></div><figcaption>Planning flow</figcaption><p class="text-equivalent">Text equivalent: acceptance and risks drive design contracts; SEIT maps those contracts to proof; implementation slices reference the map; final QA records actual evidence.</p></figure>';
  const traceFlow = '<figure><div class="flow" role="img" aria-label="Traceability from requirements to execution evidence"><span>AC / RISK</span><b>↔</b><span>DES / CONTRACT</span><b>↔</b><span>SEIT / CMD</span><b>↔</b><span>Slice manifest</span></div><figcaption>Traceability map</figcaption><p class="text-equivalent">Text equivalent: stable IDs connect each requirement or risk to its design boundary, positive and negative test cases, command, evidence, and bounded execution slice.</p></figure>';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bearing planning review</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:auto;padding:2rem;color:#17202a;background:#f7f8fa}main{background:#ffffff;padding:2rem;border:1px solid #67788a;border-radius:12px}nav{display:flex;gap:1rem;flex-wrap:wrap}figure{margin:2rem 0;padding:1rem;border:1px solid #a8b2bd;border-radius:8px}.flow{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap}.flow span{padding:.55rem .8rem;background:#eef1f4;border-radius:6px}figcaption,summary{font-weight:700}.text-equivalent{margin-bottom:0}details{margin:1rem 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef1f4;padding:1rem;border-radius:8px}</style></head><body><main><h1>Bearing planning review</h1><p>This deterministic view is generated from the four current planning sources.</p>${sourceNavigation(sources)}<section aria-labelledby="bearing-diagrams"><h2 id="bearing-diagrams">Plan maps</h2>${planningFlow}${traceFlow}</section>${sourceSection(sources)}${FINAL_QA_PENDING}</main></body></html>\n`;
}

function validFinalQaSection(section: string): boolean {
  if (!section.startsWith(FINAL_QA_COMPLETE_PREFIX) || !section.endsWith(FINAL_QA_COMPLETE_SUFFIX)) return false;
  const body = section.slice(FINAL_QA_COMPLETE_PREFIX.length, section.length - FINAL_QA_COMPLETE_SUFFIX.length);
  const middle = body.indexOf(FINAL_QA_COMPLETE_MIDDLE);
  if (middle < 0 || body.indexOf(FINAL_QA_COMPLETE_MIDDLE, middle + FINAL_QA_COMPLETE_MIDDLE.length) >= 0) return false;
  const planned = body.slice(0, middle), validation = body.slice(middle + FINAL_QA_COMPLETE_MIDDLE.length);
  return planned.trim().length > 0 && validation.trim().length > 0 && !planned.includes("<") && !planned.includes(">") && !validation.includes("<") && !validation.includes(">");
}

export async function executionReviewValid(root: string, planDirectory: string | undefined): Promise<boolean> {
  if (!planDirectory) return false;
  const directory = resolve(root, planDirectory), names = await readdir(directory);
  const planName = names.find(isPlanSpecArtifactName);
  const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name));
  if (!planName || !reviewName || !["design.md", "seit.md", "implementation.md"].every((name) => names.includes(name))) return false;
  const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
  const contents = await Promise.all([...sourceNames, reviewName].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
  if (!contents.every((content): content is string => content !== undefined)) return false;
  const sources = sourceNames.map((name, index) => [name, contents[index]] as [string, string]);
  const expected = renderPlanningReview(sources), marker = expected.indexOf(FINAL_QA_PENDING);
  if (marker < 0) return false;
  const prefix = expected.slice(0, marker), suffix = expected.slice(marker + FINAL_QA_PENDING.length), review = contents.at(-1)!;
  if (!review.startsWith(prefix) || !review.endsWith(suffix) || review.length < prefix.length + suffix.length) return false;
  return validFinalQaSection(review.slice(prefix.length, review.length - suffix.length));
}

async function designReviewArtifacts(root: string, planDirectory: string | undefined, _repair = false, cancelled: () => boolean = () => false): Promise<readonly string[] | undefined> {
  if (!planDirectory) return undefined;
  const directory = resolve(root, planDirectory), names = await readdir(directory);
  const planName = names.find(isPlanSpecArtifactName);
  const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name)) ?? "review.html";
  if (!planName || !names.includes("design.md") || !names.includes("seit.md")) return undefined;
  const sourceNames = [planName, "design.md", "seit.md"];
  const sourceContents = await Promise.all(sourceNames.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
  if (!sourceContents.every((content): content is string => content !== undefined)) return undefined;
  const [plan, design, seit] = sourceContents;
  if (!artifactComplete(design.trim(), "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !artifactComplete(seit.trim(), "seit", ["Traceability Matrix", "Cross-cutting Checks"])) return undefined;
  const reviewPath = posix.join(planDirectory, reviewName);
  const sources = sourceNames.map((name, index) => [name, [plan, design, seit][index]] as [string, string]);
  const completed = renderPlanningReview(sources);
  if (Buffer.byteLength(completed) > MAX_PLANNING_ARTIFACT) return undefined;
  const review = names.includes(reviewName) ? await readPlanningArtifact(root, reviewPath, true) : "";
  if (review === undefined) return undefined;
  if (completed !== review) {
    if (cancelled()) return undefined;
    if (!await writePlanningReview(root, reviewPath, completed)) return undefined;
  }
  return ["design.md", "seit.md", reviewName].map((name) => posix.join(planDirectory, name));
}

function routeLabel(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function planningRoute(value: string, selection: Selection): RouteDescriptor | undefined {
  const label = routeLabel(value);
  const selected = BUILTIN_ROUTES.find((route) => route.provider === selection.provider && (route.model === "*" || route.model === selection.model));
  const matches = BUILTIN_ROUTES.filter((route) => {
    const labels = [route.id, route.provider, `${route.executable} ${route.id}`, ...(route.model === "*" ? [`${route.id} agent default`, `${route.provider} agent default`] : [route.model, `${route.executable} ${route.model}`])].map(routeLabel);
    const selectedLabels = route === selected && selection.model !== "*" ? [selection.model, `${route.id} ${selection.model}`, `${route.provider} ${selection.model}`, `${route.executable} ${selection.model}`].map(routeLabel) : [];
    return labels.includes(label) || selectedLabels.includes(label);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function planningReview(root: string, planDirectory: string | undefined, selection: Selection): Promise<{ readonly review: PlanningReview; readonly planningValidation: PlanningValidationRecord } | undefined> {
  if (!planDirectory) return undefined;
  const directory = resolve(root, planDirectory), names = await readdir(directory);
  const planName = names.find(isPlanSpecArtifactName);
  const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name)) ?? "review.html";
  if (!planName || !names.includes("design.md") || !names.includes("seit.md") || !names.includes("implementation.md")) return undefined;
  const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
  const contents = await Promise.all(sourceNames.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
  if (!contents.every((content): content is string => content !== undefined)) return undefined;
  const [plan, design, seit, implementation] = contents;
  if (!artifactComplete(design.trim(), "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !artifactComplete(seit.trim(), "seit", ["Traceability Matrix", "Cross-cutting Checks"])) return undefined;

  if (!structurallyValidImplementation(plan, design, seit, implementation)) return undefined;
  const headings = [...implementation.matchAll(/^###\s+(Slice\b[^\r\n]*)/gmi)];
  const assignments: PlanningAssignment[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index ?? 0, end = headings[index + 1]?.index ?? implementation.length;
    const section = implementation.slice(start, end);
    const role = field(section, "Implementation role"), model = field(section, "Agent model route"), reasoning = field(section, "Agent reasoning level");
    const ponytail = field(section, "Ponytail mode"), reviewPath = field(section, "Review path");
    if (!role || !model || !reasoning || !reviewPath) return undefined;
    const route = planningRoute(model, selection), normalizedReasoning = reasoning.replace(/[.!?]+$/, "").trim();
    const normalizedPonytail = ponytail?.replace(/[.!?]+$/, "").trim();
    if (!route || !route.reasoningLevels.includes(normalizedReasoning.toLowerCase()) || (normalizedPonytail !== undefined && !["full", "off"].includes(normalizedPonytail))) return undefined;
    assignments.push({ slice: headings[index][1].trim(), role, model, reasoning: normalizedReasoning });
  }
  const completed = renderPlanningReview(sourceNames.map((name, index) => [name, [plan, design, seit, implementation][index]] as [string, string]));
  if (Buffer.byteLength(completed) > MAX_PLANNING_ARTIFACT) return undefined;
  const review = names.includes(reviewName) ? await readPlanningArtifact(root, posix.join(planDirectory, reviewName), true) : "";
  if (review === undefined || completed !== review && !await writePlanningReview(root, posix.join(planDirectory, reviewName), completed)) return undefined;
  const validation = orchestratePlanning({
    currentState: "EXECUTION_PLAN_READY",
    pass: "planning-validator",
    documents: { plan, design, seit, implementation },
    planDirectory,
    artifacts: sourceNames.map((name) => posix.join(planDirectory, name)),
  });
  if ("refused" in validation || !validation.planningValidation) return undefined;
  return {
    review: {
      phases: [...implementation.matchAll(/^##\s+Phase\s+(?=[A-Za-z0-9.-]*\d)[^\r\n]*$/gmi)].length,
      slices: assignments.length,
      assignments,
    },
    planningValidation: validation.planningValidation,
  };
}

async function completedValidatorScope(
  root: string,
  planDirectory: string,
  focus: FocusContext,
  completion: Extract<Awaited<ReturnType<typeof validateFocusCompletion>>, { readonly ok: true }>,
  evidence: readonly CommandEvidence[],
  summary: string,
): Promise<ValidatorScope> {
  const sliceIds = [...focus.envelope.remainingSlices];
  const readinessClaims = [{ text: summary, sliceIds }];
  const planName = (await readdir(resolve(root, planDirectory)).catch(() => [] as string[])).find(isPlanSpecArtifactName);
  if (!planName) return { slices: [], readinessClaims };
  const names = [planName, "design.md", "seit.md", "implementation.md"] as const;
  const contents = await Promise.all(names.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
  if (!contents.every((content): content is string => content !== undefined)) return { slices: [], readinessClaims };
  const [plan, design, seit, implementation] = contents;
  const model = parsePlanDocuments({ plan, design, seit, implementation });
  const slices = sliceIds.flatMap((sliceId) => {
    const slice = model.slices.get(sliceId);
    const manifest = model.manifests.get(sliceId);
    if (!slice || !manifest) return [];
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
  private readonly active = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private readonly activity = new Map<string, { stage: JourneyStage; nextSequence: number; trail: JourneyActivity[] }>();
  private readonly providerSessions = new Map<string, string>();
  private readonly focusContexts = new Map<string, FocusContractSnapshot>();
  private readonly reconBaselines = new Map<string, GitStateSnapshot>();
  constructor(
    private readonly runner: ProcessRunner,
    private readonly planDirectoryResolver: typeof resolvePlanDirectory = resolvePlanDirectory,
  ) {}

  cancel(runId: string): void { this.cancelled.add(runId); const processRunId = this.active.get(runId); if (processRunId) void this.runner.cancel?.(processRunId); }

  activityTrail(runId: string): readonly JourneyActivity[] {
    return (this.activity.get(runId)?.trail ?? []).map((entry) => ({ ...entry }));
  }

  providerSessionId(repositoryPath: string, runId: string, selection: Selection): string | undefined { return this.providerSessions.get(this.providerSessionKey(repositoryPath, runId, selection)); }

  private providerSessionKey(repositoryPath: string, runId: string, selection: Selection): string {
    return JSON.stringify([repositoryPath, runId, selection.provider, selection.model, selection.reasoning]);
  }

  private focusKey(repositoryPath: string, runId: string): string { return JSON.stringify([repositoryPath, runId]); }

  private reconKey(repositoryPath: string, runId: string): string { return JSON.stringify([repositoryPath, runId]); }

  private beginStage(runId: string, stage: JourneyStage): void {
    const current = this.activity.get(runId);
    if (current?.stage === stage) return;
    this.activity.set(runId, { stage, nextSequence: 1, trail: [] });
  }

  private recordActivity(runId: string, stage: JourneyStage, source: Pick<ProcessActivity, "kind" | "status" | "tool">): void {
    const current = this.activity.get(runId);
    if (!current || current.stage !== stage) return;
    const safe = (value: string | undefined): string | undefined => value && SAFE_ACTIVITY_VALUE.test(value) && !SECRET_ACTIVITY.test(value) ? value : undefined;
    const kind = safe(source.kind);
    if (!kind) return;
    const status = safe(source.status), tool = safe(source.tool);
    current.trail.push({ sequence: current.nextSequence, recordedAt: new Date().toISOString(), kind, ...(status ? { status } : {}), ...(tool ? { tool } : {}) });
    current.nextSequence += 1;
    if (current.trail.length > MAX_ACTIVITY_TRAIL) current.trail.shift();
  }

  private async executeOnce(request: JourneyRequest, activityStage = request.stage, recordStageStart = true, freshSessionFallback = { used: false }): Promise<JourneyResult> {
    if (!validRequest(request)) return { status: "failure", code: "input_invalid", tokens: 0 };
    const fitStage = request.stage === "repository-fit";
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(request.repositoryPath);
      if (repositoryPath !== request.repositoryPath || !(await lstat(repositoryPath)).isDirectory()) throw new Error("invalid repository");
    } catch { return { status: "failure", code: "input_invalid", tokens: 0 }; }
    const planDirectory = request.planDirectory === undefined ? undefined : await containedPath(repositoryPath, request.planDirectory, true);
    if (request.planDirectory !== undefined && planDirectory === undefined) return { status: "failure", code: "input_invalid", tokens: 0 };
    const projected = request.run.roles.find((role) => request.stage === "review" ? role.role === "surveyor" && !role.authority.write : role.role === "crewmate" && role.executor && role.authority.write);
    if (!projected) return { status: "failure", code: fitStage ? "fit_unavailable" : "crewmate_unavailable", tokens: 0 };
    if (!sameRoute(request.selection, projected.selection) || request.run.roles.some((role) => !sameRoute(role.selection, request.selection))) return { status: "failure", code: "selection_mismatch", tokens: 0 };
    let resolvedPlanDirectory: string | undefined;
    if (request.stage === "set-bearings") {
      if (!request.requestedPlanDirectory) return { status: "failure", code: "input_invalid", tokens: 0 };
      const resolution = await this.planDirectoryResolver(repositoryPath, request.requestedPlanDirectory)
        .catch(() => ({ ok: false, reason: "plan_directory_invalid" } as const));
      if (!resolution.ok) return { status: "failure", code: resolution.reason, tokens: 0 };
      resolvedPlanDirectory = resolution.path;
    }
    this.beginStage(request.runId, activityStage);
    if (recordStageStart) this.recordActivity(request.runId, activityStage, { kind: "stage.started", status: "running" });
    if (request.stage === "set-bearings") {
      if (!resolvedPlanDirectory) return { status: "failure", code: "input_invalid", tokens: 0 };
      if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens: 0 };
      try {
        this.recordActivity(request.runId, activityStage, { kind: "repository-map.started", status: "running" });
        const workspace = await setBearingsWorkspace(repositoryPath, request.workGoal, resolvedPlanDirectory);
        if (!workspace || !(await Promise.all(workspace.artifacts.map((artifact) => containedPath(repositoryPath, artifact)))).every(Boolean) || !stageArtifactsValid(request.stage, workspace.artifacts, workspace.directory) || this.cancelled.has(request.runId)) return { status: "failure", code: this.cancelled.has(request.runId) ? "cancelled" : "artifact_invalid", tokens: 0 };
        this.recordActivity(request.runId, activityStage, { kind: "workspace.ready", status: workspace.resumed ? "resumed" : "created" });
        return { status: "action", summary: workspace.resumed ? "Bearings resumed locally." : "Bearings set locally.", artifacts: workspace.artifacts, tokens: 0 };
      } catch { return { status: "failure", code: "artifact_invalid", tokens: 0 }; }
    }
    const executionStage = request.stage === "execute-explorer" || request.stage === "execute-expedition";
    let focus: FocusContext | undefined;
    let focusKey: string | undefined;
    if (executionStage) {
      if (!planDirectory) return { status: "failure", code: "focus_invalid", tokens: 0 };
      const [parsed, planHashes] = await Promise.all([
        createFocusContext({
          root: repositoryPath,
          planDirectory,
          role: request.stage === "execute-expedition" ? "navigator" : "explorer",
          objective: request.workGoal,
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
      const candidate: FocusContractSnapshot = { context: parsed.value, planHashes };
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
      if (drift) this.recordActivity(request.runId, activityStage, { kind: "focus.amended", status: "confirmed" });
      this.recordActivity(request.runId, activityStage, { kind: "focus.ready", status: "validated" });
    }
    const reconKey = this.reconKey(repositoryPath, request.runId);
    const reconBaseline = request.stage === "recon"
      ? this.reconBaselines.get(reconKey) ?? await snapshotGitState(repositoryPath)
      : undefined;
    if (reconBaseline) this.reconBaselines.set(reconKey, reconBaseline);
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
    let taskPrompt: string;
    try { taskPrompt = prompt(request, planDirectory, await packagedSkills(request.stage), focus); }
    catch { return { status: "failure", code: fitStage ? "fit_unavailable" : "adapter_failed", tokens: 0 }; }
    let tokens = 0;
    let events: unknown;
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens: 0 };
    const processRunId = `${request.runId.slice(0, 70)}-${randomUUID()}`;
    this.active.set(request.runId, processRunId);
    if (request.stage === "review" && projected.selection.provider === "codex") {
      const modelArgs = projected.selection.model === "*" ? [] : ["-m", projected.selection.model];
      let result;
      try { result = await this.runner.run({ routeId: "codex", executable: "codex", args: ["exec", "review", "--uncommitted", "--json", ...modelArgs, "-c", `model_reasoning_effort="${projected.reasoning.providerLevel}"`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--ephemeral"], stdin: "", cwd: repositoryPath, timeoutMs: projected.limits.timeoutMs, runId: processRunId, onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity) }); }
      catch { return { status: "failure", code: "adapter_failed", tokens: 0 }; }
      const reportedTokens = result.usage && Number.isSafeInteger(result.usage.tokens) && result.usage.tokens >= 0 ? result.usage.tokens : 0;
      if (this.cancelled.has(request.runId) && result.unknownSideEffect) return { status: "failure", code: "interrupted", tokens: reportedTokens };
      if (result.cancelled) return { status: "failure", code: "cancelled", tokens: reportedTokens };
      if (!result.usage || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0) return { status: "failure", code: "adapter_failed", tokens: 0 };
      if (result.usage.tokens > projected.limits.tokenBudget) return { status: "failure", code: "token_budget", tokens: result.usage.tokens };
      if (result.exitCode !== 0 || result.timedOut || result.unknownSideEffect || !Array.isArray(result.events)) return { status: "failure", code: "adapter_failed", tokens: result.usage.tokens };
      tokens = result.usage.tokens;
      events = result.events;
    } else {
      let lastAttemptSideEffectFree = false;
      const observedRunner: ProcessRunner = {
        executableAvailable: (executable) => this.runner.executableAvailable(executable),
        run: async (invocation) => {
          const result = await this.runner.run(invocation);
          lastAttemptSideEffectFree = result.sideEffectFree === true;
          return result;
        },
        attestIsolation: () => this.runner.attestIsolation?.(),
      };
      const adapter = createAgentAdapter(projected.selection, observedRunner);
      if (!adapter) return { status: "failure", code: fitStage ? "fit_unavailable" : "crewmate_unavailable", tokens: 0 };
      let receipt;
      const questionDiscovery = fitStage || request.stage === "gather-supplies" && request.gatherMode === "questions";
      const journeySession = request.stage !== "review";
      const providerSessionKey = this.providerSessionKey(repositoryPath, request.runId, projected.selection);
      const continuation = journeySession ? request.providerSessionId ?? this.providerSessions.get(providerSessionKey) : undefined;
      try { receipt = await adapter.execute({ runId: processRunId, sessionScope: request.runId, repositoryPath, role: { ...projected, sessionId: journeySession ? projected.sessionId : null, authority: { ...projected.authority, write: questionDiscovery ? false : projected.authority.write, network: request.selection.provider === "agy", externalAction: false }, toolAllow: questionDiscovery ? projected.toolAllow.filter((tool) => !/write|edit/i.test(tool)) : projected.toolAllow }, task: { prompt: taskPrompt }, onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity), ...(continuation ? { providerSessionId: continuation } : {}), ...(executionStage ? { focusMode: true } : {}), ...(request.stage === "execute-expedition" ? { allowSubagents: true } : {}) }); }
      catch { return { status: "failure", code: fitStage ? "fit_unavailable" : "adapter_failed", tokens: 0 }; }
      if (receipt.status !== "completed") {
        if (receipt.failure === "session_unavailable") {
          this.providerSessions.delete(providerSessionKey);
          if (!freshSessionFallback.used && lastAttemptSideEffectFree) {
            freshSessionFallback.used = true;
            const { providerSessionId: _deadProviderSessionId, ...freshRequest } = request;
            const fallback = await this.executeOnce(freshRequest, activityStage, false, freshSessionFallback);
            return { ...fallback, tokens: receipt.usage.tokens + fallback.tokens, sessionContinuity: "lost" };
          }
          return { status: "failure", code: "session_unavailable", tokens: receipt.usage.tokens, sessionContinuity: "lost" };
        }
        return { status: "failure", code: this.cancelled.has(request.runId) && (receipt.status === "blocked_reconcile" || receipt.failure === "unknown_side_effect") ? "interrupted" : receipt.failure === "token_budget" ? "token_budget" : receipt.failure === "cancelled" ? "cancelled" : fitStage ? "fit_unavailable" : "adapter_failed", tokens: receipt.usage.tokens };
      }
      if (journeySession && receipt.providerSessionId) this.providerSessions.set(providerSessionKey, receipt.providerSessionId);
      tokens = receipt.usage.tokens;
      events = receipt.events;
    }
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens };
    const assistantText = (events as unknown[]).flatMap((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof (event as { data?: { content?: unknown } }).data?.content === "string" ? [(event as { data: { content: string } }).data.content] : []).at(-1);
    if (!assistantText) return fitStage ? malformedFitResult(tokens, "result_envelope", "assistantText") : { status: "failure", code: "result_missing", tokens };
    if (request.stage === "review" && request.selection.provider === "codex") {
      const summary = assistantText.trim().slice(0, MAX_TEXT).trim();
      return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : text(summary) ? { status: "action", summary, artifacts: [], tokens } : { status: "failure", code: "result_malformed", tokens };
    }
    const availableQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions" ? Math.min(MAX_GATHER_QUESTIONS, Math.max(0, MAX_QA - request.priorOwnerQa.length)) : MAX_QA - 1;
    const resultEnvelope = envelope(assistantText, availableQuestions, fitStage ? repositoryPath : undefined);
    if (resultEnvelope === "missing") return fitStage ? malformedFitResult(tokens, "result_envelope", "envelope") : { status: "failure", code: "result_missing", tokens };
    if (resultEnvelope === "malformed") return fitStage ? malformedFitResult(tokens, "result_envelope", "envelope") : { status: "failure", code: "result_malformed", tokens };
    const parsed = resultEnvelope.receipt;
    if (resultEnvelope.droppedEstimate) this.recordActivity(request.runId, activityStage, { kind: "estimate.dropped", status: resultEnvelope.droppedEstimate });
    if (parsed.kind === "fit") {
      return parsed.fit.ok
        ? { status: "question", question: parsed.fit.question, fitAssumption: parsed.fit.assumption, tokens }
        : parsed.fit.reason === "fit_malformed"
          ? { status: "failure", code: "fit_malformed", fitDiagnostic: parsed.fit.diagnostic, tokens }
          : { status: "failure", code: parsed.fit.reason, tokens };
    }
    const expectedEstimate = (stage: NextStageEstimate["stage"]): NextStageEstimate | undefined => {
      if (!parsed.nextStageEstimate || parsed.nextStageEstimate.stage === stage) return parsed.nextStageEstimate;
      this.recordActivity(request.runId, activityStage, { kind: "estimate.dropped", status: "stage_invalid" });
      return undefined;
    };
    if (parsed.kind === "questions") {
      if (request.stage !== "gather-supplies" || request.gatherMode !== "questions") return { status: "failure", code: "result_malformed", tokens };
      const nextStageEstimate = expectedEstimate("gather-supplies");
      const questions = parsed.questions.filter((question) => question.toLowerCase() !== "anything else?");
      return { status: "question", ...(questions[0] ? { question: questions[0] } : {}), questions, tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
    }
    if (parsed.kind === "question") {
      if (request.stage === "gather-supplies" && request.gatherMode !== undefined) return { status: "failure", code: "result_malformed", tokens };
      const nextStageEstimate = expectedEstimate(request.stage);
      return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : { status: "question", question: parsed.question, tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
    }
    if (request.stage === "gather-supplies" && request.gatherMode === "questions") return { status: "failure", code: "result_malformed", tokens };
    if (parsed.kind === "recon" && request.stage !== "recon") return { status: "failure", code: "result_malformed", tokens };
    const nextStageEstimate = expectedEstimate(nextStage(request.stage));
    for (const artifact of parsed.artifacts) {
      if (!await containedPath(repositoryPath, artifact)) return { status: "failure", code: "artifact_invalid", tokens };
      if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens };
    }
    if (!stageArtifactsValid(request.stage, parsed.artifacts, planDirectory, parsed.kind === "recon" ? parsed.recon : undefined)) return { status: "failure", code: "artifact_invalid", tokens };
    if (parsed.kind === "recon" && !reconBaseline) {
      this.recordActivity(request.runId, activityStage, { kind: "recon.rejected", status: "git_state" });
      return { status: "failure", code: "completion_invalid", tokens };
    }
    if (parsed.kind === "recon" && reconBaseline && !await reconCompletionValid(repositoryPath, reconBaseline, parsed.artifacts, parsed.recon)) return { status: "failure", code: "artifact_invalid", tokens };
    const planned = request.stage === "draft-implementation" ? await planningReview(repositoryPath, planDirectory, request.selection).catch(() => undefined) : undefined;
    const finalReviewValid = executionStage ? await executionReviewValid(repositoryPath, planDirectory).catch(() => false) : true;
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens };
    if (request.stage === "draft-implementation" && !planned) return { status: "failure", code: "artifact_invalid", tokens };
    if (!finalReviewValid) return { status: "failure", code: "artifact_invalid", tokens };
    let verification: ValidatorReport | undefined;
    if (executionStage && focus) {
      const evidence = parsed.kind === "action" ? parsed.evidence ?? [] : [];
      const completion = await validateFocusCompletion(focus, repositoryPath, parsed.artifacts, evidence).catch(() => ({ ok: false as const, reason: "git_state" as const }));
      if (!completion.ok) {
        this.recordActivity(request.runId, activityStage, { kind: "focus.rejected", status: completion.reason });
        return { status: "failure", code: "completion_invalid", tokens };
      }
      verification = validateScope(await completedValidatorScope(
        repositoryPath,
        planDirectory!,
        focus,
        completion,
        evidence,
        parsed.summary,
      ));
      this.recordActivity(request.runId, activityStage, { kind: "focus.completed", status: "validated" });
      this.focusContexts.delete(focusKey!);
    } else if (parsed.kind === "action" && parsed.evidence) return { status: "failure", code: "result_malformed", tokens };
    const artifacts = request.stage === "draft-implementation" && planDirectory ? [...new Set([...parsed.artifacts, posix.join(planDirectory, "review.html")])] : parsed.artifacts;
    if (parsed.kind === "recon") this.reconBaselines.delete(reconKey);
    return {
      status: "action",
      summary: parsed.summary,
      artifacts,
      tokens,
      ...(parsed.kind === "recon" ? { recon: parsed.recon } : {}),
      ...(planned ? { planningReview: planned.review, planningValidation: planned.planningValidation } : {}),
      ...(verification === undefined ? {} : { verification }),
      ...(nextStageEstimate ? { nextStageEstimate } : {}),
    };
  }

  private async executeMapRoute(request: JourneyRequest): Promise<JourneyResult> {
    const freshSessionFallback = { used: false };
    const design = await this.executeOnce(request, "map-route", true, freshSessionFallback);
    if (design.status !== "action") return design;
    let designArtifacts: readonly string[] | undefined;
    try { designArtifacts = await designReviewArtifacts(request.repositoryPath, request.planDirectory, true, () => this.cancelled.has(request.runId)); }
    catch { designArtifacts = undefined; }
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens: design.tokens, ...(design.sessionContinuity ? { sessionContinuity: design.sessionContinuity } : {}) };
    if (!designArtifacts) return { status: "failure", code: "artifact_invalid", tokens: design.tokens, ...(design.sessionContinuity ? { sessionContinuity: design.sessionContinuity } : {}) };
    this.recordActivity(request.runId, "map-route", { kind: "design.ready", status: "completed" });
    return { ...design, artifacts: [...new Set([...design.artifacts, ...designArtifacts])] };
  }

  async execute(request: JourneyRequest): Promise<JourneyResult> {
    if (request.stage !== "recon") this.reconBaselines.delete(this.reconKey(request.repositoryPath, request.runId));
    try { return request.stage === "map-route" ? await this.executeMapRoute(request) : await this.executeOnce(request); }
    finally { this.active.delete(request.runId); this.cancelled.delete(request.runId); }
  }
}
