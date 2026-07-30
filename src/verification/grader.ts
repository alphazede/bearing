import type { RouteDescriptor } from "../adapters/adapters.js";
import {
  GRADER_RUBRIC,
  GRADER_RUBRIC_VERSION,
  type GraderDimensionId,
  type GraderLevel,
} from "./grader-rubric.js";

const MAX_ITEMS = 128;
const MAX_TEXT = 4096;
const REPORT_KEYS = [
  "schemaVersion",
  "rubricVersion",
  "contractHash",
  "scope",
  "graderSessionId",
  "scores",
  "deficiencies",
  "verdict",
] as const;
const SCOPE_KEYS = ["kind", "id"] as const;
const SCORE_KEYS = ["dimensionId", "level", "evidence", "confidence"] as const;
const DEFICIENCY_KEYS = ["dimensionId", "summary", "severity"] as const;
const DIMENSION_IDS = new Set<string>(GRADER_RUBRIC.map(({ id }) => id));

export interface GraderReport {
  readonly schemaVersion: 1;
  readonly rubricVersion: typeof GRADER_RUBRIC_VERSION;
  readonly contractHash: string;
  readonly scope: { readonly kind: "slice" | "phase"; readonly id: string };
  readonly graderSessionId: string;
  readonly scores: readonly {
    readonly dimensionId: string;
    readonly level: GraderLevel;
    readonly evidence: string;
    readonly confidence: "low" | "medium" | "high";
  }[];
  readonly deficiencies: readonly {
    readonly dimensionId: string;
    readonly summary: string;
    readonly severity: "major" | "minor";
  }[];
  readonly verdict: "strong" | "acceptable" | "weak";
}

export interface GraderScopeMembership {
  readonly sliceIds: readonly string[];
  readonly phaseIds: readonly string[];
}

export type GraderReportFailure =
  | "malformed"
  | "rubric_version_mismatch"
  | "contract_mismatch"
  | "verdict_mismatch"
  | "unexpected_key"
  | "prototype_pollution";

export type GraderReportParseResult =
  | { readonly ok: true; readonly value: GraderReport }
  | { readonly ok: false; readonly reason: GraderReportFailure };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, required: readonly string[]): value is Record<string, unknown> {
  return isObject(value)
    && Object.keys(value).length === required.length
    && required.every((key) => Object.hasOwn(value, key));
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function hasUnsafeRecordPrototype(value: unknown): boolean {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return Object.hasOwn(value, "__proto__")
    || (prototype !== Object.prototype && prototype !== null);
}

function hasUnsafeArrayPrototype(value: unknown): boolean {
  return Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype;
}

function hasPrototypePollution(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (hasUnsafeRecordPrototype(value)) return true;

  if (Object.hasOwn(value, "scope") && hasUnsafeRecordPrototype(value.scope)) return true;
  for (const key of ["scores", "deficiencies"] as const) {
    const entries = value[key];
    if (hasUnsafeArrayPrototype(entries)) return true;
    if (Array.isArray(entries) && entries.some((entry) => hasUnsafeRecordPrototype(entry))) return true;
  }
  return false;
}

function hasDenseOwnItems(value: readonly unknown[]): boolean {
  if (value.length > MAX_ITEMS || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isLevel(value: unknown): value is GraderLevel {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function isDimensionId(value: unknown): value is GraderDimensionId {
  return typeof value === "string" && DIMENSION_IDS.has(value);
}

function boundedText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function scoreShape(value: unknown): value is GraderReport["scores"][number] {
  return hasExactKeys(value, SCORE_KEYS)
    && isDimensionId(value.dimensionId)
    && isLevel(value.level)
    && boundedText(value.evidence)
    && (value.confidence === "low" || value.confidence === "medium" || value.confidence === "high");
}

function deficiencyShape(value: unknown): value is GraderReport["deficiencies"][number] {
  return hasExactKeys(value, DEFICIENCY_KEYS)
    && isDimensionId(value.dimensionId)
    && boundedText(value.summary)
    && (value.severity === "major" || value.severity === "minor");
}

function scopeShape(value: unknown, approved: GraderScopeMembership): value is GraderReport["scope"] {
  return hasExactKeys(value, SCOPE_KEYS)
    && (value.kind === "slice" || value.kind === "phase")
    && boundedText(value.id)
    && (value.kind === "slice" ? approved.sliceIds : approved.phaseIds).includes(value.id);
}

function nestedUnexpectedKey(value: Record<string, unknown>): boolean {
  if (isObject(value.scope) && hasUnexpectedKeys(value.scope, SCOPE_KEYS)) return true;
  if (Array.isArray(value.scores)) {
    if (Object.keys(value.scores).length !== value.scores.length) return true;
    if (value.scores.some((score) => isObject(score) && hasUnexpectedKeys(score, SCORE_KEYS))) return true;
  }
  if (Array.isArray(value.deficiencies)) {
    if (Object.keys(value.deficiencies).length !== value.deficiencies.length) return true;
    if (value.deficiencies.some((item) => isObject(item) && hasUnexpectedKeys(item, DEFICIENCY_KEYS))) return true;
  }
  return false;
}

export function graderVerdict(report: GraderReport): GraderReport["verdict"] {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const dimension of GRADER_RUBRIC) {
    const score = report.scores.find(({ dimensionId }) => dimensionId === dimension.id);
    weightedScore += (score?.level ?? 0) * dimension.weight;
    totalWeight += dimension.weight;
  }
  const average = weightedScore / totalWeight;
  if (average >= 3.5) return "strong";
  if (average >= 2.5) return "acceptable";
  return "weak";
}

export function parseGraderReport(
  value: unknown,
  approvedContractHash: string,
  approvedScope: GraderScopeMembership,
): GraderReportParseResult {
  if (hasPrototypePollution(value)) return { ok: false, reason: "prototype_pollution" };
  if (!isObject(value)) return { ok: false, reason: "malformed" };
  if (hasUnexpectedKeys(value, REPORT_KEYS) || nestedUnexpectedKey(value)) {
    return { ok: false, reason: "unexpected_key" };
  }
  if (!hasExactKeys(value, REPORT_KEYS)) return { ok: false, reason: "malformed" };
  if (value.rubricVersion !== GRADER_RUBRIC_VERSION) {
    return { ok: false, reason: "rubric_version_mismatch" };
  }
  if (typeof value.contractHash !== "string" || value.contractHash !== approvedContractHash) {
    return { ok: false, reason: "contract_mismatch" };
  }
  if (value.schemaVersion !== 1
    || !scopeShape(value.scope, approvedScope)
    || typeof value.graderSessionId !== "string"
    || !Array.isArray(value.scores)
    || !hasDenseOwnItems(value.scores)
    || value.scores.length !== GRADER_RUBRIC.length
    || !value.scores.every(scoreShape)
    || new Set(value.scores.map(({ dimensionId }) => dimensionId)).size !== GRADER_RUBRIC.length
    || !Array.isArray(value.deficiencies)
    || !hasDenseOwnItems(value.deficiencies)
    || !value.deficiencies.every(deficiencyShape)
    || (value.verdict !== "strong" && value.verdict !== "acceptable" && value.verdict !== "weak")
  ) {
    return { ok: false, reason: "malformed" };
  }

  const report = value as unknown as GraderReport;
  if (graderVerdict(report) !== report.verdict) {
    return { ok: false, reason: "verdict_mismatch" };
  }
  return { ok: true, value: report };
}

export type GraderRouteSelection =
  | { readonly ok: true; readonly route: RouteDescriptor; readonly differentFamily: boolean }
  | { readonly ok: false; readonly code: "grader_family_unavailable" | "grader_route_unavailable" };

export function selectGraderRoute(input: {
  readonly risk: "low" | "standard" | "high";
  readonly implementerProvider: string;
  readonly availableRoutes: readonly RouteDescriptor[];
}): GraderRouteSelection {
  const differentFamilyRoute = input.availableRoutes.find(
    ({ provider }) => provider !== input.implementerProvider,
  );
  if (differentFamilyRoute) {
    return { ok: true, route: differentFamilyRoute, differentFamily: true };
  }
  if (input.availableRoutes.length === 0) {
    return { ok: false, code: "grader_route_unavailable" };
  }
  if (input.risk === "high") {
    return { ok: false, code: "grader_family_unavailable" };
  }
  return { ok: true, route: input.availableRoutes[0], differentFamily: false };
}
