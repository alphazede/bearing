import { posix, win32 } from "node:path";
import { absolutePlanDirectoryPath, planDirectoryValid } from "./plan-directory.js";

const MAX_TEXT = 4096;
const MAX_EVIDENCE = 32;
export const FIT_EVIDENCE_KINDS = Object.freeze([
  "git-root",
  "git-remote",
  "manifest",
  "workspace-config",
  "top-level-doc",
  "plan-convention",
] as const);
const EVIDENCE_KINDS = new Set<string>(FIT_EVIDENCE_KINDS);
const FAILURE_REASONS = new Set(["fit_unavailable", "fit_malformed", "fit_undecidable"]);

export interface FitEvidence {
  readonly kind: (typeof FIT_EVIDENCE_KINDS)[number];
  readonly path: string;
  readonly detail: string;
}

export interface FitAssumption {
  readonly repository: string;
  readonly planDirectory: string;
  readonly rationale: string;
  readonly evidence: readonly FitEvidence[];
}

export type FitDiagnosticCheck =
  | "scope_repository"
  | "receipt_shape"
  | "receipt_reason"
  | "receipt_ok"
  | "question_text"
  | "assumption_shape"
  | "assumption_repository"
  | "assumption_plan_directory"
  | "assumption_rationale"
  | "assumption_evidence"
  | "evidence_shape"
  | "evidence_kind"
  | "evidence_path"
  | "evidence_detail"
  | "evidence_containment"
  | "result_envelope";

export type FitDiagnosticField = "repository" | "authorizedWorkspaceRoot" | "receipt" | "reason" | "ok" | "question" | "assumption" | "planDirectory" | "rationale" | "evidence" | "kind" | "path" | "detail" | "assistantText" | "envelope";

export interface FitDiagnostic {
  readonly check: FitDiagnosticCheck;
  readonly field: FitDiagnosticField;
}

const DIAGNOSTIC_FIELDS_BY_CHECK: Readonly<Record<FitDiagnosticCheck, readonly FitDiagnosticField[]>> = {
  scope_repository: ["repository", "authorizedWorkspaceRoot"],
  receipt_shape: ["receipt"],
  receipt_reason: ["reason"],
  receipt_ok: ["ok"],
  question_text: ["question"],
  assumption_shape: ["assumption"],
  assumption_repository: ["repository"],
  assumption_plan_directory: ["planDirectory"],
  assumption_rationale: ["rationale"],
  assumption_evidence: ["evidence"],
  evidence_shape: ["evidence"],
  evidence_kind: ["kind"],
  evidence_path: ["path"],
  evidence_detail: ["detail"],
  evidence_containment: ["path"],
  result_envelope: ["assistantText", "envelope"],
};

export type FitReceipt =
  | { readonly ok: true; readonly assumption: FitAssumption; readonly question: string }
  | { readonly ok: false; readonly reason: "fit_unavailable" | "fit_undecidable" }
  | { readonly ok: false; readonly reason: "fit_malformed"; readonly diagnostic: FitDiagnostic };

export type FitDecision =
  | { readonly outcome: "confirmed"; readonly planDirectory: string; readonly repository: string; readonly decidedAt: string }
  | { readonly outcome: "redirected"; readonly planDirectory: string; readonly repository: string; readonly decidedAt: string }
  | { readonly outcome: "declined" };

export interface FitScope {
  readonly repository: string;
  readonly authorizedWorkspaceRoot?: string;
}

export const FIT_OWNER_ANSWER_REMEDY = 'Answer "Confirm", enter an exact docs/plans/... path, or answer "Decline".';

export type CanonicalFitOwnerAnswer =
  | { readonly ok: true; readonly answer: "Confirm" | "Decline" | string }
  | {
      readonly ok: false;
      readonly error: "repository_fit_answer_invalid";
      readonly remedy: typeof FIT_OWNER_ANSWER_REMEDY;
      readonly correctionAction: "decide";
    };

/** Normalize only the repository-fit owner's bounded decision vocabulary. */
export function canonicalizeFitOwnerAnswer(answer: string, repositoryRoot?: string): CanonicalFitOwnerAnswer {
  const normalized = answer.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (["y", "yes", "confirm", "confirmed", "approve", "approved", "proceed", "use it", "looks good", "i confirm all of these"].includes(normalized)) {
    return { ok: true, answer: "Confirm" };
  }
  if (["no", "decline", "declined", "stop", "cancel"].includes(normalized)) {
    return { ok: true, answer: "Decline" };
  }
  const absolutePlanDirectory = repositoryRoot === undefined
    ? undefined
    : absolutePlanDirectoryPath(answer, repositoryRoot);
  if (absolutePlanDirectory !== undefined) return { ok: true, answer: absolutePlanDirectory };
  if (absolutePath(answer) || /^[A-Za-z]:/.test(answer)) return {
    ok: false,
    error: "repository_fit_answer_invalid",
    remedy: FIT_OWNER_ANSWER_REMEDY,
    correctionAction: "decide",
  };
  // Preserve the existing bounded basename lookup used to disambiguate known
  // plan directories; prose is never reinterpreted as a filesystem request.
  if (planDirectoryValid(answer) || /^[A-Za-z0-9._/-]+$/.test(answer)) return { ok: true, answer };
  return {
    ok: false,
    error: "repository_fit_answer_invalid",
    remedy: FIT_OWNER_ANSWER_REMEDY,
    correctionAction: "decide",
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function text(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function pathText(value: unknown, nativeWindows?: boolean): value is string {
  if (!text(value)) return false;
  return (nativeWindows ?? windowsNative(value))
    ? win32.normalize(value) === value
    : !value.includes("\\") && posix.normalize(value) === value;
}

function absolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function evidencePath(value: unknown, repositoryWindows: boolean): value is string {
  if (!text(value)) return false;
  if (!repositoryWindows) return !value.includes("\\") && posix.normalize(value) === value;
  if (absolutePath(value)) return windowsNative(value) && win32.normalize(value) === value;
  return win32.normalize(value) === value || (!value.includes("\\") && posix.normalize(value) === value);
}

// ponytail: a drive letter or UNC prefix, not win32.isAbsolute. That predicate
// answers true for "/home/repo", so selecting on it would apply Windows rules —
// including case-insensitive comparison — to every POSIX root, and
// win32.relative("/home/A", "/home/a/x") is "x". On a case-sensitive filesystem
// those are different directories, so containment would accept a sibling.
function windowsNative(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith("\\\\");
}

function repositoryPath(value: unknown): value is string {
  if (!text(value) || !absolutePath(value)) return false;
  const paths = windowsNative(value) ? win32 : posix;
  const normalized = paths.normalize(value);
  return value === normalized || (!windowsNative(value)
    && normalized !== paths.parse(normalized).root
    && !normalized.endsWith(paths.sep)
    && value === `${normalized}${paths.sep}`);
}

function sameRepository(left: string, right: string): boolean {
  if (windowsNative(left) !== windowsNative(right)) return false;
  const paths = windowsNative(left) ? win32 : posix;
  const normalize = (value: string): string => {
    const normalized = paths.normalize(value);
    const root = paths.parse(normalized).root;
    let result = normalized;
    while (result !== root && result.endsWith(paths.sep)) result = result.slice(0, -paths.sep.length);
    return result;
  };
  return normalize(left) === normalize(right);
}

function contained(root: string, candidate: string): boolean {
  if (windowsNative(root) !== windowsNative(candidate)) return false;
  const paths = windowsNative(root) ? win32 : posix;
  const relation = paths.relative(root, candidate);
  return paths.isAbsolute(candidate) && (relation === "" || !relation.startsWith("..") && !paths.isAbsolute(relation));
}

export function fitMalformed(check: FitDiagnosticCheck, field: FitDiagnosticField): Extract<FitReceipt, { readonly reason: "fit_malformed" }> {
  return { ok: false, reason: "fit_malformed", diagnostic: { check, field } };
}

export function isFitDiagnostic(value: unknown): value is FitDiagnostic {
  return record(value)
    && exact(value, ["check", "field"])
    && typeof value.check === "string"
    && typeof value.field === "string"
    && Object.hasOwn(DIAGNOSTIC_FIELDS_BY_CHECK, value.check)
    && DIAGNOSTIC_FIELDS_BY_CHECK[value.check as FitDiagnosticCheck].includes(value.field as FitDiagnosticField);
}

export function validateFitReceipt(value: unknown, scope: FitScope): FitReceipt {
  const roots = [scope.repository, scope.authorizedWorkspaceRoot].filter((root): root is string => root !== undefined);
  if (!pathText(scope.repository, windowsNative(scope.repository)) || !absolutePath(scope.repository)) return fitMalformed("scope_repository", "repository");
  if (scope.authorizedWorkspaceRoot !== undefined && (!pathText(scope.authorizedWorkspaceRoot, windowsNative(scope.authorizedWorkspaceRoot)) || !absolutePath(scope.authorizedWorkspaceRoot))) {
    return fitMalformed("scope_repository", "authorizedWorkspaceRoot");
  }

  if (!record(value)) return fitMalformed("receipt_shape", "receipt");
  if (value.ok === false) {
    if (!exact(value, ["ok", "reason"]) || !FAILURE_REASONS.has(value.reason as string)) return fitMalformed("receipt_reason", "reason");
    return value.reason === "fit_malformed"
      ? fitMalformed("receipt_reason", "reason")
      : value as FitReceipt;
  }
  if (value.ok !== true) return fitMalformed("receipt_ok", "ok");
  if (!exact(value, ["ok", "assumption", "question"])) return fitMalformed("receipt_shape", "receipt");
  if (!text(value.question)) return fitMalformed("question_text", "question");
  if (!record(value.assumption)) return fitMalformed("assumption_shape", "assumption");

  const assumption = value.assumption;
  if (!exact(assumption, ["repository", "planDirectory", "rationale", "evidence"])) return fitMalformed("assumption_shape", "assumption");
  if (!repositoryPath(assumption.repository) || !sameRepository(assumption.repository, scope.repository)) return fitMalformed("assumption_repository", "repository");
  if (typeof assumption.planDirectory !== "string" || !planDirectoryValid(assumption.planDirectory)) return fitMalformed("assumption_plan_directory", "planDirectory");
  if (!text(assumption.rationale)) return fitMalformed("assumption_rationale", "rationale");
  if (!Array.isArray(assumption.evidence) || assumption.evidence.length < 1 || assumption.evidence.length > MAX_EVIDENCE) return fitMalformed("assumption_evidence", "evidence");

  const repositoryWindows = windowsNative(assumption.repository);
  for (const entry of assumption.evidence) {
    if (!record(entry) || !exact(entry, ["kind", "path", "detail"])) return fitMalformed("evidence_shape", "evidence");
    if (!EVIDENCE_KINDS.has(entry.kind as string)) return fitMalformed("evidence_kind", "kind");
    if (!evidencePath(entry.path, repositoryWindows)) return fitMalformed("evidence_path", "path");
    if (!text(entry.detail)) return fitMalformed("evidence_detail", "detail");
    const candidate = absolutePath(entry.path)
      ? entry.path
      : (repositoryWindows ? win32 : posix).resolve(assumption.repository, entry.path);
    if (!roots.some((root) => contained(root, candidate))) return fitMalformed("evidence_containment", "path");
  }
  return { ...value, assumption: { ...assumption, repository: scope.repository } } as FitReceipt;
}
