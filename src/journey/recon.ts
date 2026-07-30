import { writeSetPathIssue } from "./plan-structure.js";

const MATERIALITY = ["cost", "architecture", "scope", "risk"] as const;
const RECOMMENDATIONS = ["proceed", "revise", "stop"] as const;

export type ReconMateriality = (typeof MATERIALITY)[number];
export type ReconRecommendation = (typeof RECOMMENDATIONS)[number];

export interface ReconBrief {
  readonly assumptionId: string;
  readonly assumption: string;
  readonly materiality: readonly ReconMateriality[];
  readonly falsificationCriterion: string;
  readonly smallestExperiment: string;
  readonly writeSet: readonly string[];
  readonly evidenceCommandIds: readonly string[];
  readonly timeboxMinutes: number;
}

export interface ReconMeasurement {
  readonly name: string;
  readonly value: string;
  readonly method: string;
}

export interface ReconReport {
  readonly assumptionId: string;
  readonly measurements: readonly ReconMeasurement[];
  readonly feasibilityEvidence: readonly string[];
  readonly constraints: readonly string[];
  readonly rejectedOptions: readonly { readonly option: string; readonly reason: string }[];
  readonly recommendation: ReconRecommendation;
  readonly materialChange: {
    readonly cost: boolean;
    readonly architecture: boolean;
    readonly scope: boolean;
    readonly risk: boolean;
  };
  readonly prototypePaths: readonly string[];
  readonly productionEligible: false;
}

export type ReconValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "recon_brief_invalid" | "recon_report_invalid"; readonly issues: readonly string[] };

export type ReconRoute =
  | { readonly ok: false; readonly code: "recon_brief_invalid" | "recon_report_invalid"; readonly issues: readonly string[] }
  | { readonly ok: true; readonly state: "SKIPPED" }
  | { readonly ok: true; readonly state: "RECON_PENDING"; readonly brief: ReconBrief }
  | {
    readonly ok: true;
    readonly state: "RECON_READY" | "ARCHITECTURE_READY" | "RECON_FAILED" | "OWNER_DECISION_REQUIRED";
    readonly brief: ReconBrief;
    readonly report: ReconReport;
  };

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && value === value.trim()
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function dense(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function strings(value: unknown, allowEmpty = false): value is readonly string[] {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.length <= 128
    && dense(value)
    && value.every(text)
    && new Set(value).size === value.length;
}

function paths(value: unknown, allowEmpty = false): value is readonly string[] {
  return strings(value, allowEmpty) && value.every((path) => writeSetPathIssue(path) === undefined);
}

export function validateReconBrief(value: unknown): ReconValidation<ReconBrief> {
  const issues: string[] = [];
  if (!object(value) || !exact(value, [
    "assumptionId",
    "assumption",
    "materiality",
    "falsificationCriterion",
    "smallestExperiment",
    "writeSet",
    "evidenceCommandIds",
    "timeboxMinutes",
  ])) return { ok: false, code: "recon_brief_invalid", issues: ["brief must contain exactly the required fields"] };
  if (!text(value.assumptionId)) issues.push("assumptionId must be bounded text");
  if (!text(value.assumption)) issues.push("assumption must name one material assumption");
  if (
    !Array.isArray(value.materiality)
    || !value.materiality.length
    || value.materiality.length > MATERIALITY.length
    || !dense(value.materiality)
    || value.materiality.some((item) => !MATERIALITY.includes(item as ReconMateriality))
    || new Set(value.materiality).size !== value.materiality.length
  ) issues.push("materiality must contain unique known categories");
  if (!text(value.falsificationCriterion) || !criterionTerms(String(value.falsificationCriterion)).size) {
    issues.push("falsificationCriterion must contain a bounded measurable term");
  }
  if (!text(value.smallestExperiment)) issues.push("smallestExperiment must be bounded text");
  if (!paths(value.writeSet)) issues.push("writeSet must contain unique bounded literal paths");
  if (!strings(value.evidenceCommandIds) || value.evidenceCommandIds.some((id) => !/^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/.test(id))) issues.push("evidenceCommandIds must contain unique command ids");
  if (!Number.isInteger(value.timeboxMinutes) || (value.timeboxMinutes as number) < 1 || (value.timeboxMinutes as number) > 1440) issues.push("timeboxMinutes must be an integer from 1 to 1440");
  return issues.length
    ? { ok: false, code: "recon_brief_invalid", issues }
    : { ok: true, value: value as unknown as ReconBrief };
}

function measurements(value: unknown): value is readonly ReconMeasurement[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 128
    && dense(value)
    && value.every((item) => object(item) && exact(item, ["name", "value", "method"]) && text(item.name) && text(item.value) && text(item.method));
}

const CRITERION_STOP_WORDS = new Set(["about", "after", "any", "before", "could", "parser", "should", "their", "there", "these", "those", "valid", "would"]);

function criterionTerms(value: string): ReadonlySet<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((term) => term.length >= 3 && !CRITERION_STOP_WORDS.has(term))
    .map((term) => term.endsWith("s") && term.length > 4 ? term.slice(0, -1) : term));
}

function measurementsTieToCriterion(values: readonly ReconMeasurement[], criterion: string): boolean {
  const required = criterionTerms(criterion);
  return required.size > 0 && values.some((measurement) => {
    const observed = criterionTerms(`${measurement.name} ${measurement.value} ${measurement.method}`);
    return [...required].some((term) => observed.has(term));
  });
}

function rejectedOptions(value: unknown): value is ReconReport["rejectedOptions"] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 128
    && dense(value)
    && value.every((item) => object(item) && exact(item, ["option", "reason"]) && text(item.option) && text(item.reason));
}

function materialChange(value: unknown): value is ReconReport["materialChange"] {
  return object(value)
    && exact(value, MATERIALITY)
    && MATERIALITY.every((key) => typeof value[key] === "boolean");
}

export function validateReconReport(value: unknown, brief: ReconBrief): ReconValidation<ReconReport> {
  const issues: string[] = [];
  if (!object(value) || !exact(value, [
    "assumptionId",
    "measurements",
    "feasibilityEvidence",
    "constraints",
    "rejectedOptions",
    "recommendation",
    "materialChange",
    "prototypePaths",
    "productionEligible",
  ])) return { ok: false, code: "recon_report_invalid", issues: ["report must contain exactly the required fields"] };
  if (value.assumptionId !== brief.assumptionId) issues.push("assumptionId must match the brief");
  if (!measurements(value.measurements)) issues.push("measurements must contain at least one bounded measurement");
  else if (!measurementsTieToCriterion(value.measurements, brief.falsificationCriterion)) issues.push("at least one measurement must be tied to the falsification criterion");
  if (!strings(value.feasibilityEvidence)) issues.push("feasibilityEvidence must contain evidence");
  if (!strings(value.constraints)) issues.push("constraints must contain bounded constraints");
  if (!rejectedOptions(value.rejectedOptions)) issues.push("rejectedOptions must contain an option and reason");
  if (!RECOMMENDATIONS.includes(value.recommendation as ReconRecommendation)) issues.push("recommendation must be proceed, revise, or stop");
  if (!materialChange(value.materialChange)) issues.push("materialChange must contain four boolean flags");
  if (!paths(value.prototypePaths, true)) issues.push("prototypePaths must contain unique bounded literal paths");
  if (value.productionEligible !== false) issues.push("productionEligible must be false");
  return issues.length
    ? { ok: false, code: "recon_report_invalid", issues }
    : { ok: true, value: value as unknown as ReconReport };
}

export function routeRecon(input: { readonly brief?: unknown; readonly report?: unknown } = {}): ReconRoute {
  if (input.brief === undefined && input.report === undefined) return { ok: true, state: "SKIPPED" };
  if (input.brief === undefined) return { ok: false, code: "recon_brief_invalid", issues: ["brief is required when Recon is present"] };
  const brief = validateReconBrief(input.brief);
  if (!brief.ok) return brief;
  if (input.report === undefined) return { ok: true, state: "RECON_PENDING", brief: brief.value };
  const report = validateReconReport(input.report, brief.value);
  if (!report.ok) return report;
  if (MATERIALITY.some((key) => report.value.materialChange[key])) {
    return { ok: true, state: "OWNER_DECISION_REQUIRED", brief: brief.value, report: report.value };
  }
  const state = {
    proceed: "RECON_READY",
    revise: "ARCHITECTURE_READY",
    stop: "RECON_FAILED",
  } as const;
  return { ok: true, state: state[report.value.recommendation], brief: brief.value, report: report.value };
}
