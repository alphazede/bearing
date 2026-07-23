import { BUILTIN_ROUTES } from "../adapters/adapters.js";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATION_ROUTES = Object.freeze(BUILTIN_ROUTES.map(({ id }) => id));
export const SKILLSBENCH_V1_1_TASK_IDS = [
  "fix-build-agentops", "react-performance-debugging", "spring-boot-jakarta-migration", "data-to-d3",
  "sec-financial-report", "enterprise-information-search", "software-dependency-audit", "citation-check",
] as const;
const TRIALS = [1, 2, 3] as const;
const MAX_CASES = 128;
const MAX_RESULTS = MAX_CASES * 2 * EVALUATION_ROUTES.length * TRIALS.length;

export type EvaluationVerdict = "passed" | "failed" | "incomplete";
export type EvaluationKind = "native" | "skillsbench";
export type EvaluationSource = "verified-provider" | "synthetic";

export interface EvaluationSuiteDefinition {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly kind: EvaluationKind;
  readonly version: string;
  readonly caseIds: readonly string[];
  readonly arms: { readonly control: string; readonly treatment: string };
}

export interface EvaluationFailure {
  readonly code: string;
  readonly message: string;
}

export interface EvaluationCell {
  readonly suiteId: string;
  readonly caseId: string;
  readonly arm: string;
  readonly route: string;
  readonly trial: 1 | 2 | 3;
  readonly workspaceId: string;
  readonly identity: { readonly requested: string; readonly effective: string };
  readonly metadata: {
    readonly source: EvaluationSource;
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
    readonly harness: string;
    readonly isolation: string;
  };
  readonly outcome: "passed" | "failed";
  readonly criticalInvariantPassed: boolean;
  readonly score: number;
  readonly failure?: EvaluationFailure;
}

export interface RouteEvaluationVerdict {
  readonly route: string;
  readonly verdict: EvaluationVerdict;
  readonly controlAverage: number | null;
  readonly treatmentAverage: number | null;
  readonly uplift: number | null;
  readonly criticalInvariantsPassed: boolean;
  readonly noCaseRegression: boolean;
  readonly issues: readonly string[];
}

export interface RetainedEvaluationFailure extends EvaluationFailure {
  readonly key: string;
}

export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly suite: Readonly<EvaluationSuiteDefinition>;
  readonly verdict: EvaluationVerdict;
  readonly compositeKeys: readonly string[];
  readonly results: readonly EvaluationCell[];
  readonly routes: readonly RouteEvaluationVerdict[];
  readonly failures: readonly RetainedEvaluationFailure[];
  readonly issues: readonly string[];
  readonly macro: {
    readonly controlAverage: number | null;
    readonly treatmentAverage: number | null;
    readonly uplift: number | null;
    readonly passed: boolean;
  };
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function text(value: unknown, maximum = 128): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function average(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function compositeKey(suiteId: string, caseId: string, arm: string, route: string, trial: number): string { return JSON.stringify([suiteId, caseId, arm, route, trial]); }
function keyOf(cell: Pick<EvaluationCell, "suiteId" | "caseId" | "arm" | "route" | "trial">): string { return compositeKey(cell.suiteId, cell.caseId, cell.arm, cell.route, cell.trial); }
function expectedKey(suite: EvaluationSuiteDefinition, caseId: string, arm: string, route: string, trial: number): string { return compositeKey(suite.suiteId, caseId, arm, route, trial); }

function validSuite(value: unknown): value is EvaluationSuiteDefinition {
  if (!exact(value, ["schemaVersion", "suiteId", "kind", "version", "caseIds", "arms"])) return false;
  if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION || !text(value.suiteId) || !["native", "skillsbench"].includes(value.kind as string) || !text(value.version) || !Array.isArray(value.caseIds) || value.caseIds.length === 0 || value.caseIds.length > MAX_CASES || !value.caseIds.every((id) => text(id)) || !unique(value.caseIds)) return false;
  if (!exact(value.arms, ["control", "treatment"]) || !text(value.arms.control) || !text(value.arms.treatment) || value.arms.control === value.arms.treatment) return false;
  if (value.kind === "native") return value.arms.control === "without-skill" && value.arms.treatment === "with-skill";
  return value.version === "1.1" && value.caseIds.length === SKILLSBENCH_V1_1_TASK_IDS.length && value.caseIds.every((id, index) => id === SKILLSBENCH_V1_1_TASK_IDS[index]) && value.arms.control === "curated" && value.arms.treatment === "bearing";
}

function validCell(value: unknown): value is EvaluationCell {
  const required = ["suiteId", "caseId", "arm", "route", "trial", "workspaceId", "identity", "metadata", "outcome", "criticalInvariantPassed", "score"];
  if (!object(value) || !exact(value, value.outcome === "failed" ? [...required, "failure"] : required)) return false;
  if (![value.suiteId, value.caseId, value.arm, value.route, value.workspaceId].every((entry) => text(entry)) || !TRIALS.includes(value.trial as 1 | 2 | 3)) return false;
  if (!exact(value.identity, ["requested", "effective"]) || !text(value.identity.requested) || !text(value.identity.effective)) return false;
  if (!exact(value.metadata, ["source", "provider", "model", "reasoning", "harness", "isolation"]) || !["verified-provider", "synthetic"].includes(value.metadata.source as string) || ![value.metadata.provider, value.metadata.model, value.metadata.harness].every((entry) => text(entry)) || !["low", "medium", "high", "xhigh"].includes(value.metadata.reasoning as string) || !["attested", "local"].includes(value.metadata.isolation as string) || !((value.metadata.source === "verified-provider" && value.metadata.isolation === "attested") || (value.metadata.source === "synthetic" && value.metadata.isolation === "local"))) return false;
  if (!exact(value.failure, ["code", "message"]) && value.outcome === "failed") return false;
  if (value.outcome === "failed" && (!text((value.failure as Record<string, unknown>).code) || !text((value.failure as Record<string, unknown>).message, 4096))) return false;
  return ["passed", "failed"].includes(value.outcome as string) && typeof value.criticalInvariantPassed === "boolean" && typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0 && value.score <= 1;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Validates a supplied result set; provider execution remains behind AdapterRegistry. */
export class EvaluationRunner {
  runSuite(definition: unknown, results: unknown): EvaluationReport {
    if (!validSuite(definition)) throw new TypeError("invalid evaluation suite definition");
    const suite = definition;
    const cells = new Map<string, EvaluationCell>();
    const issues: string[] = [];
    const routeIssues = new Map(EVALUATION_ROUTES.map((route) => [route, [] as string[]]));
    const failures: RetainedEvaluationFailure[] = [];
    const workspaces = new Set<string>();
    const routeMetadata = new Map<string, string>();
    const values = Array.isArray(results) && results.length <= MAX_RESULTS ? results : [];
    if (!Array.isArray(results) || results.length > MAX_RESULTS) issues.push("results:malformed");

    values.forEach((value, index) => {
      if (!validCell(value)) {
        const issue = `cell:${index}:malformed`;
        issues.push(issue);
        if (object(value) && typeof value.route === "string" && routeIssues.has(value.route)) routeIssues.get(value.route)!.push(issue);
        return;
      }
      const key = keyOf(value);
      if (value.outcome === "failed") failures.push({ key, ...value.failure! });
      if (cells.has(key)) {
        const issue = `${key}:duplicate`;
        issues.push(issue);
        routeIssues.get(value.route)?.push(issue);
        return;
      }
      cells.set(key, value);
      if (workspaces.has(value.workspaceId)) {
        const issue = `${key}:workspace-reused`;
        issues.push(issue);
        routeIssues.get(value.route)?.push(issue);
      }
      workspaces.add(value.workspaceId);
    });

    const arms = [suite.arms.control, suite.arms.treatment];
    for (const cell of cells.values()) {
      const descriptor = BUILTIN_ROUTES.find(({ id }) => id === cell.route);
      const inventoryValid = cell.suiteId === suite.suiteId && suite.caseIds.includes(cell.caseId) && arms.includes(cell.arm) && descriptor !== undefined;
      if (!inventoryValid) {
        const issue = `${keyOf(cell)}:extra`;
        issues.push(issue);
        routeIssues.get(cell.route)?.push(issue);
        continue;
      }
      if (cell.identity.requested !== cell.route || cell.identity.effective !== cell.route || cell.metadata.provider !== descriptor.provider || (descriptor.model !== "*" && cell.metadata.model !== descriptor.model)) {
        const issue = `${keyOf(cell)}:identity-drift`;
        issues.push(issue);
        routeIssues.get(cell.route)!.push(issue);
      }
      const harness = suite.kind === "native" ? "native" : "skillsbench-v1.1";
      if (cell.metadata.harness !== harness) {
        const issue = `${keyOf(cell)}:harness-drift`;
        issues.push(issue);
        routeIssues.get(cell.route)!.push(issue);
      }
      const metadata = JSON.stringify([cell.metadata.source, cell.metadata.provider, cell.metadata.model, cell.metadata.reasoning, cell.metadata.harness, cell.metadata.isolation]);
      const expectedMetadata = routeMetadata.get(cell.route);
      if (expectedMetadata === undefined) routeMetadata.set(cell.route, metadata);
      else if (metadata !== expectedMetadata) {
        const issue = `${keyOf(cell)}:metadata-drift`;
        issues.push(issue);
        routeIssues.get(cell.route)!.push(issue);
      }
    }

    const routes = EVALUATION_ROUTES.map((route): RouteEvaluationVerdict => {
      const localIssues = routeIssues.get(route)!;
      const routeCells: EvaluationCell[] = [];
      for (const caseId of suite.caseIds) for (const arm of arms) for (const trial of TRIALS) {
        const key = expectedKey(suite, caseId, arm, route, trial);
        const cell = cells.get(key);
        if (!cell) localIssues.push(`${key}:missing`);
        else routeCells.push(cell);
      }
      const complete = localIssues.length === 0 && routeCells.length === suite.caseIds.length * arms.length * TRIALS.length;
      const control = routeCells.filter(({ arm }) => arm === suite.arms.control);
      const treatment = routeCells.filter(({ arm }) => arm === suite.arms.treatment);
      const controlAverage = control.length === suite.caseIds.length * 3 ? average(control.map(({ score }) => score)) : null;
      const treatmentAverage = treatment.length === suite.caseIds.length * 3 ? average(treatment.map(({ score }) => score)) : null;
      const uplift = controlAverage === null || treatmentAverage === null ? null : treatmentAverage - controlAverage;
      const criticalInvariantsPassed = complete && routeCells.every(({ criticalInvariantPassed }) => criticalInvariantPassed);
      const noCaseRegression = complete && suite.caseIds.every((caseId) => average(treatment.filter((cell) => cell.caseId === caseId).map(({ score }) => score)) >= average(control.filter((cell) => cell.caseId === caseId).map(({ score }) => score)));
      const outcomesPassed = complete && routeCells.every(({ outcome }) => outcome === "passed");
      const verdict: EvaluationVerdict = !complete ? "incomplete" : uplift! > 0 && criticalInvariantsPassed && noCaseRegression && outcomesPassed ? "passed" : "failed";
      return { route, verdict, controlAverage, treatmentAverage, uplift, criticalInvariantsPassed, noCaseRegression, issues: [...localIssues] };
    });
    const completeRoutes = routes.every(({ controlAverage, treatmentAverage }) => controlAverage !== null && treatmentAverage !== null);
    const controlAverage = completeRoutes ? average(routes.map((route) => route.controlAverage!)) : null;
    const treatmentAverage = completeRoutes ? average(routes.map((route) => route.treatmentAverage!)) : null;
    const allRoutesPassed = routes.every(({ verdict }) => verdict === "passed");
    const verdict: EvaluationVerdict = issues.length > 0 || routes.some(({ verdict }) => verdict === "incomplete") ? "incomplete" : allRoutesPassed ? "passed" : "failed";
    return deepFreeze({
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      suite: { ...suite, caseIds: [...suite.caseIds], arms: { ...suite.arms } },
      verdict,
      compositeKeys: [...cells.keys()].sort(),
      results: [...cells.values()].map((cell) => ({ ...cell, identity: { ...cell.identity }, metadata: { ...cell.metadata }, ...(cell.failure ? { failure: { ...cell.failure } } : {}) })),
      routes,
      failures,
      issues,
      macro: { controlAverage, treatmentAverage, uplift: controlAverage === null || treatmentAverage === null ? null : treatmentAverage - controlAverage, passed: allRoutesPassed && issues.length === 0 },
    });
  }

  verdict(definition: unknown, results: unknown): EvaluationReport { return this.runSuite(definition, results); }
}
