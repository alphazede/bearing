import { posix, win32 } from "node:path";
import { canonicalStringify, hashEvent } from "./run.js";
import { BUILTIN_ROUTES } from "../adapters/adapters.js";
import { provenIndependent, type SliceFacts } from "../execution/concurrency-control.js";
import type { FocusEnvelope, FocusRole } from "../journey/focus-mode.js";
import { REASONING_TIERS, type ReasoningTier } from "../profile/reasoning-policy.js";
import { boundedText, deepFreeze, hasExactKeys, isObject } from "./guards.js";

export const EXECUTION_CONTRACT_SCHEMA_VERSION = 1 as const;

const MAX_ITEMS = 128;
const MAX_TEXT = 4096;
const MAX_SLICE_ID = 128;
const COMMAND_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const SLICE_ID = /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/;

export type ExecutionMode = "explorer" | "expedition";
export type ReviewCadence = "per-slice" | "per-phase" | "completion-only";

export interface ExecutionContractPhase {
  readonly phaseId: string;
  readonly title: string;
  readonly entryCriteria: string;
  readonly exitCriteria: string;
  readonly dependsOnPhases?: readonly string[];
  readonly integrationCheckpointCount?: number;
}

export interface ExecutionContractSlice {
  readonly sliceId: string;
  readonly phaseId: string;
  readonly requirementIds: readonly string[];
  readonly writeSet: readonly string[];
  readonly acceptance: string;
  readonly evidenceCommandIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly parallelSafe: boolean;
  readonly role: string;
  readonly reasoningTier: ReasoningTier;
  readonly sharedInterfaces?: readonly string[];
  readonly integrationBoundary?: string;
}

export interface ExecutionContractDependencyEdge {
  readonly from: string;
  readonly to: string;
}

/** Required delegation roles a guided run must route before wave artifacts exist. */
export const ROLE_KINDS = ["execution-author", "review-general", "review-security"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** The built-in read-only reviewer, authorized only as a review-role fallback, never a primary or author route. */
export const SURVEYOR_FALLBACK_ROUTE = "surveyor" as const;

export interface RoleRoute {
  readonly role: RoleKind;
  readonly primary: string;
  readonly fallbacks: readonly string[];
}

export interface ExecutionContractBody {
  readonly schemaVersion: typeof EXECUTION_CONTRACT_SCHEMA_VERSION;
  readonly contractId: string;
  readonly runId: string;
  readonly planDirectory: string;
  readonly objective: string;
  readonly mode: ExecutionMode;
  readonly reviewCadence: ReviewCadence;
  readonly phases: readonly ExecutionContractPhase[];
  readonly slices: readonly ExecutionContractSlice[];
  readonly dependencyEdges: readonly ExecutionContractDependencyEdge[];
  /** Owner-selected primary/fallback agent per delegation role. Absent on pre-Phase-3 contracts. */
  readonly roleRoutes?: readonly RoleRoute[];
}

/**
 * Durable owner evidence binds approval to one immutable contract hash.
 * This follows the durable evidence shape used by the workflow aggregate.
 */
export interface ExecutionContractOwnerApproval {
  readonly kind: "owner-approval";
  readonly recordedBy: "owner";
  readonly durable: true;
  readonly recordId: string;
  readonly contentHash: string;
}

export interface ApprovedExecutionContract extends ExecutionContractBody {
  readonly contentHash: string;
  readonly ownerApproval: ExecutionContractOwnerApproval;
}

export interface ParallelSafetyAdvisory {
  readonly code: "overlapping_parallel_write_set" | "parallel_safety_conflict";
  readonly sliceIds: readonly [string, string];
  readonly paths: readonly string[];
  readonly integrationBoundaries?: readonly string[];
}

export type ExecutionContractFailure =
  | "malformed"
  | "future_schema"
  | "invalid_mode"
  | "invalid_review_cadence"
  | "duplicate_phase_id"
  | "duplicate_slice_id"
  | "unknown_phase"
  | "dangling_dependency"
  | "cyclic_dependency"
  | "phase_dependency_mismatch"
  | "missing_requirement_trace"
  | "missing_evidence_command"
  | "empty_write_set"
  | "invalid_write_set_path"
  | "content_hash_mismatch"
  | "owner_approval_mismatch";

export type ExecutionContractParseResult =
  | {
      readonly ok: true;
      readonly value: ApprovedExecutionContract;
      readonly advisories: readonly ParallelSafetyAdvisory[];
    }
  | { readonly ok: false; readonly reason: ExecutionContractFailure };

function hasAllowedKeys(value: unknown, required: readonly string[], optional: readonly string[]): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function denseArray<T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
): value is readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !predicate(value[index])) return false;
  }
  return true;
}

function stringArray(
  value: unknown,
  predicate: (item: unknown) => item is string = boundedText,
): value is readonly string[] {
  return denseArray(value, predicate);
}

function focusSliceId(value: unknown): value is string {
  return boundedText(value, MAX_SLICE_ID) && SLICE_ID.test(value);
}

function writeSetArray(value: unknown): value is readonly string[] {
  return denseArray(value, (item): item is string =>
    typeof item === "string" && item.length <= MAX_TEXT);
}

function repoRelativePath(value: unknown): value is string {
  return boundedText(value)
    && !posix.isAbsolute(value)
    && !win32.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value)
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

// `:` is rejected alongside the glob characters because a write set is enforced
// on every platform the contract can run on. On NTFS `src/a.ts:secret` names an
// alternate data stream of `src/a.ts`, so a path the write set never approved
// becomes writable through one it did. POSIX allows `:` in a filename, so this
// refuses a legal-on-Linux shape to keep one meaning of a write set everywhere.
function safePath(value: string): boolean {
  return repoRelativePath(value) && posix.normalize(value) === value && !/[:*<>]/.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function phaseShape(value: unknown): value is ExecutionContractPhase {
  return hasAllowedKeys(
    value,
    ["phaseId", "title", "entryCriteria", "exitCriteria"],
    ["dependsOnPhases", "integrationCheckpointCount"],
  )
    && boundedText(value.phaseId)
    && boundedText(value.title)
    && boundedText(value.entryCriteria)
    && boundedText(value.exitCriteria)
    && (value.dependsOnPhases === undefined
      || stringArray(value.dependsOnPhases) && !duplicate(value.dependsOnPhases))
    && (value.integrationCheckpointCount === undefined
      || Number.isSafeInteger(value.integrationCheckpointCount)
        && (value.integrationCheckpointCount as number) >= 0
        && (value.integrationCheckpointCount as number) <= MAX_ITEMS);
}

function sliceShape(value: unknown): value is ExecutionContractSlice {
  return hasAllowedKeys(
    value,
    [
      "sliceId", "phaseId", "requirementIds", "writeSet", "acceptance",
      "evidenceCommandIds", "dependsOn", "parallelSafe", "role", "reasoningTier",
    ],
    ["sharedInterfaces", "integrationBoundary"],
  )
    && focusSliceId(value.sliceId)
    && boundedText(value.phaseId)
    && stringArray(value.requirementIds)
    && writeSetArray(value.writeSet)
    && boundedText(value.acceptance, 512)
    && stringArray(value.evidenceCommandIds)
    && stringArray(value.dependsOn, focusSliceId)
    && typeof value.parallelSafe === "boolean"
    && boundedText(value.role)
    && typeof value.reasoningTier === "string"
    && (REASONING_TIERS as readonly string[]).includes(value.reasoningTier)
    && (value.sharedInterfaces === undefined
      || stringArray(value.sharedInterfaces) && !duplicate(value.sharedInterfaces))
    && (value.integrationBoundary === undefined || boundedText(value.integrationBoundary));
}

function edgeShape(value: unknown): value is ExecutionContractDependencyEdge {
  return hasExactKeys(value, ["from", "to"]) && focusSliceId(value.from) && focusSliceId(value.to);
}

const AGENT_ROUTE_IDS = new Set(BUILTIN_ROUTES.map((route) => route.id));

function agentRouteId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ROUTE_IDS.has(value);
}

// Surveyor is a built-in read-only reviewer, never an author: it may fill a review
// fallback slot but is refused as a primary route or as the execution-author's fallback.
function fallbackRouteId(role: RoleKind, value: unknown): value is string {
  return agentRouteId(value) || (role !== "execution-author" && value === SURVEYOR_FALLBACK_ROUTE);
}

function roleRouteShape(value: unknown): value is RoleRoute {
  if (!hasExactKeys(value, ["role", "primary", "fallbacks"])) return false;
  if (typeof value.role !== "string" || !(ROLE_KINDS as readonly string[]).includes(value.role)) return false;
  const role = value.role as RoleKind;
  if (!agentRouteId(value.primary)) return false;
  if (!denseArray(value.fallbacks, (item): item is string => fallbackRouteId(role, item))) return false;
  const fallbacks = value.fallbacks as readonly string[];
  return !duplicate(fallbacks) && !fallbacks.includes(value.primary as string);
}

/** Exactly one route per required role: no duplicate, missing, or extra role. */
export function roleRoutesShape(value: unknown): value is readonly RoleRoute[] {
  if (!denseArray(value, roleRouteShape) || value.length !== ROLE_KINDS.length) return false;
  const roles = new Set(value.map((route) => route.role));
  return roles.size === ROLE_KINDS.length && ROLE_KINDS.every((kind) => roles.has(kind));
}

function approvalShape(value: unknown): value is ExecutionContractOwnerApproval {
  return hasExactKeys(value, ["kind", "recordedBy", "durable", "recordId", "contentHash"])
    && value.kind === "owner-approval"
    && value.recordedBy === "owner"
    && value.durable === true
    && boundedText(value.recordId)
    && typeof value.contentHash === "string"
    && HASH.test(value.contentHash);
}

/**
 * Hash a contract body through run.ts's exported canonical SHA-256 path.
 * `hashEvent` is the public wrapper around run.ts's internal sha256 helper.
 */
export function hashExecutionContractBody(body: ExecutionContractBody): string {
  const canonicalBody = JSON.parse(canonicalStringify(body)) as Parameters<typeof hashEvent>[0];
  return hashEvent(canonicalBody);
}

/**
 * Canonical content hash for an owner-approved legacy role-route binding.
 *
 * This is an unkeyed integrity binding, not a signature and not an authorization token: it
 * proves the routes recorded durably are byte-for-byte the routes the owner approved for this
 * run id, so nothing can be substituted between approval and the ledger. It grants no
 * authority on its own — anyone able to reach the binding path can compute it — and the
 * caller's owner actor plus the run's contract state are what decide admission.
 */
export function hashLegacyRoleRoutes(runId: string, roleRoutes: readonly RoleRoute[]): string {
  const canonical = JSON.parse(canonicalStringify({ runId, roleRoutes })) as Parameters<typeof hashEvent>[0];
  return hashEvent(canonical);
}

function bodyOf(contract: ApprovedExecutionContract): ExecutionContractBody {
  const { contentHash: _hash, ownerApproval: _approval, ...body } = contract;
  return body;
}

function immutableContractSnapshot(contract: ApprovedExecutionContract): ApprovedExecutionContract {
  return deepFreeze(
    JSON.parse(canonicalStringify(contract)) as ApprovedExecutionContract,
  );
}

function approvalBindingMatches(contract: ApprovedExecutionContract): boolean {
  try {
    return typeof contract.contentHash === "string"
      && HASH.test(contract.contentHash)
      && approvalShape(contract.ownerApproval)
      && contract.ownerApproval.contentHash === contract.contentHash
      && hashExecutionContractBody(bodyOf(contract)) === contract.contentHash;
  } catch {
    return false;
  }
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function dependencyCycle(contract: ApprovedExecutionContract): boolean {
  const outgoing = new Map(contract.slices.map((slice) => [slice.sliceId, [] as string[]]));
  for (const slice of contract.slices) {
    for (const dependency of slice.dependsOn) outgoing.get(dependency)!.push(slice.sliceId);
  }
  for (const edge of contract.dependencyEdges) outgoing.get(edge.from)!.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sliceId: string): boolean => {
    if (visiting.has(sliceId)) return true;
    if (visited.has(sliceId)) return false;
    visiting.add(sliceId);
    if (outgoing.get(sliceId)!.some(visit)) return true;
    visiting.delete(sliceId);
    visited.add(sliceId);
    return false;
  };
  return contract.slices.some((slice) => visit(slice.sliceId));
}

function derivedPhaseDependencies(contract: ApprovedExecutionContract): ReadonlyMap<string, ReadonlySet<string>> {
  const sliceById = new Map(contract.slices.map((slice) => [slice.sliceId, slice]));
  const derived = new Map(contract.phases.map((phase) => [phase.phaseId, new Set<string>()]));
  const connect = (dependencyId: string, dependentId: string): void => {
    const dependency = sliceById.get(dependencyId);
    const dependent = sliceById.get(dependentId);
    if (dependency && dependent && dependency.phaseId !== dependent.phaseId) {
      derived.get(dependent.phaseId)?.add(dependency.phaseId);
    }
  };
  for (const slice of contract.slices) {
    for (const dependency of slice.dependsOn) connect(dependency, slice.sliceId);
  }
  for (const edge of contract.dependencyEdges) connect(edge.from, edge.to);
  return derived;
}

function phaseDependenciesMatch(contract: ApprovedExecutionContract): boolean {
  const derived = derivedPhaseDependencies(contract);
  return contract.phases.every((phase) => phase.dependsOnPhases === undefined
    || phase.dependsOnPhases.length === derived.get(phase.phaseId)?.size
      && phase.dependsOnPhases.every((dependency) => derived.get(phase.phaseId)?.has(dependency)));
}

// A derived phase graph may legitimately contain a cycle: phases interleave
// whenever slices in each depend on slices in the other, and that stays
// well-defined because execution follows the slice DAG, which
// parseApprovedExecutionContract already proves acyclic. A phase-level cycle
// check would reject those valid contracts, so none exists here.

function topologicalSliceIds(contract: ApprovedExecutionContract): readonly string[] | undefined {
  const outgoing = new Map(contract.slices.map((slice) => [slice.sliceId, new Set<string>()]));
  const incoming = new Map(contract.slices.map((slice) => [slice.sliceId, 0]));
  const connect = (from: string, to: string): void => {
    const dependents = outgoing.get(from);
    if (!dependents || !incoming.has(to) || dependents.has(to)) return;
    dependents.add(to);
    incoming.set(to, incoming.get(to)! + 1);
  };
  for (const slice of contract.slices) for (const dependency of slice.dependsOn) connect(dependency, slice.sliceId);
  for (const edge of contract.dependencyEdges) connect(edge.from, edge.to);

  const ready = contract.slices.filter((slice) => incoming.get(slice.sliceId) === 0).map((slice) => slice.sliceId);
  const ordered: string[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const sliceId = ready[index]!;
    ordered.push(sliceId);
    for (const dependent of outgoing.get(sliceId) ?? []) {
      const remaining = incoming.get(dependent)! - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  return ordered.length === contract.slices.length ? ordered : undefined;
}

function concurrencyFacts(slice: ExecutionContractSlice): SliceFacts {
  return {
    writeSet: slice.writeSet,
    interfaceTags: slice.sharedInterfaces ?? [],
    environmentTags: [],
    integrationBoundaryTags: slice.integrationBoundary === undefined
      ? []
      : [slice.integrationBoundary],
    parallelSafe: slice.parallelSafe,
  };
}

export function parallelSafetyAdvisories(contract: ApprovedExecutionContract): ParallelSafetyAdvisory[] {
  const advisories: ParallelSafetyAdvisory[] = [];
  for (let left = 0; left < contract.slices.length; left += 1) {
    for (let right = left + 1; right < contract.slices.length; right += 1) {
      const first = contract.slices[left];
      const second = contract.slices[right];
      const secondPaths = new Set(second.writeSet);
      const paths = [...new Set(first.writeSet.filter((path) => secondPaths.has(path)))].sort();
      if (paths.length && (first.parallelSafe || second.parallelSafe)) {
        advisories.push({
          code: "overlapping_parallel_write_set",
          sliceIds: [first.sliceId, second.sliceId],
          paths,
        });
      } else if (first.parallelSafe && second.parallelSafe
        && !provenIndependent(concurrencyFacts(first), concurrencyFacts(second))) {
        const integrationBoundaries = first.integrationBoundary !== undefined
          && first.integrationBoundary === second.integrationBoundary
          ? [first.integrationBoundary]
          : [];
        advisories.push({
          code: "parallel_safety_conflict",
          sliceIds: [first.sliceId, second.sliceId],
          paths,
          ...(integrationBoundaries.length ? { integrationBoundaries } : {}),
        });
      }
    }
  }
  return advisories;
}

/**
 * Parse and validate an approved schema-v1 execution contract.
 *
 * Overlapping write sets are deliberately advisory in Phase 1. Phase 2 will
 * enforce that both overlapping slices declare `parallelSafe: false`.
 */
export function parseApprovedExecutionContract(value: unknown): ExecutionContractParseResult {
  if (!isObject(value)) return { ok: false, reason: "malformed" };
  if (value.schemaVersion !== EXECUTION_CONTRACT_SCHEMA_VERSION) {
    return typeof value.schemaVersion === "number" && value.schemaVersion > EXECUTION_CONTRACT_SCHEMA_VERSION
      ? { ok: false, reason: "future_schema" }
      : { ok: false, reason: "malformed" };
  }
  if (value.mode !== "explorer" && value.mode !== "expedition") {
    return { ok: false, reason: "invalid_mode" };
  }
  if (value.reviewCadence !== "per-slice" && value.reviewCadence !== "per-phase" && value.reviewCadence !== "completion-only") {
    return { ok: false, reason: "invalid_review_cadence" };
  }
  if (!hasAllowedKeys(value, [
    "schemaVersion", "contractId", "runId", "planDirectory", "objective", "mode",
    "reviewCadence", "phases", "slices", "dependencyEdges", "contentHash", "ownerApproval",
  ], ["roleRoutes"])
    || !boundedText(value.contractId)
    || !boundedText(value.runId)
    || !repoRelativePath(value.planDirectory)
    || !boundedText(value.objective)
    || !denseArray(value.phases, phaseShape)
    || value.phases.length === 0
    || !denseArray(value.slices, sliceShape)
    || value.slices.length === 0
    || !denseArray(value.dependencyEdges, edgeShape)
    || typeof value.contentHash !== "string"
    || !HASH.test(value.contentHash)
    || !approvalShape(value.ownerApproval)
    || (value.roleRoutes !== undefined && !roleRoutesShape(value.roleRoutes))
  ) {
    return { ok: false, reason: "malformed" };
  }

  const contract = value as unknown as ApprovedExecutionContract;
  const phaseIds = contract.phases.map((phase) => phase.phaseId);
  if (duplicate(phaseIds)) return { ok: false, reason: "duplicate_phase_id" };
  const sliceIds = contract.slices.map((slice) => slice.sliceId);
  if (duplicate(sliceIds)) return { ok: false, reason: "duplicate_slice_id" };
  const phases = new Set(phaseIds);
  if (contract.slices.some((slice) => !phases.has(slice.phaseId))) {
    return { ok: false, reason: "unknown_phase" };
  }
  if (contract.slices.some((slice) => slice.requirementIds.length === 0)) {
    return { ok: false, reason: "missing_requirement_trace" };
  }
  if (contract.slices.some((slice) => slice.evidenceCommandIds.length === 0)) {
    return { ok: false, reason: "missing_evidence_command" };
  }
  if (contract.slices.some((slice) => slice.writeSet.length === 0)) {
    return { ok: false, reason: "empty_write_set" };
  }
  if (contract.slices.some((slice) => duplicate(slice.writeSet) || slice.writeSet.some((path) => !safePath(path)))) {
    return { ok: false, reason: "invalid_write_set_path" };
  }
  if (contract.slices.some((slice) => duplicate(slice.evidenceCommandIds) || slice.evidenceCommandIds.some((id) => !COMMAND_ID.test(id) || !boundedText(`${id}: passing command evidence`)))) {
    return { ok: false, reason: "malformed" };
  }
  const knownSlices = new Set(sliceIds);
  if (contract.slices.some((slice) => slice.dependsOn.some((dependency) => !knownSlices.has(dependency)))
    || contract.dependencyEdges.some((edge) => !knownSlices.has(edge.from) || !knownSlices.has(edge.to))) {
    return { ok: false, reason: "dangling_dependency" };
  }
  if (!phaseDependenciesMatch(contract)) return { ok: false, reason: "phase_dependency_mismatch" };
  if (dependencyCycle(contract)) return { ok: false, reason: "cyclic_dependency" };
  if (hashExecutionContractBody(bodyOf(contract)) !== contract.contentHash) {
    return { ok: false, reason: "content_hash_mismatch" };
  }
  if (contract.ownerApproval.contentHash !== contract.contentHash) {
    return { ok: false, reason: "owner_approval_mismatch" };
  }
  const snapshot = immutableContractSnapshot(contract);
  return { ok: true, value: snapshot, advisories: parallelSafetyAdvisories(snapshot) };
}

function projectableRole(value: unknown): value is FocusRole {
  return value === "explorer" || value === "navigator" || value === "crewmate";
}

export type DeriveFocusEnvelopeResult =
  | FocusEnvelope
  | { readonly ok: false; readonly reason: "unknown_slice" | "slice_not_projectable" };

/**
 * Project one active contract slice into the existing, stricter FocusEnvelope.
 * Contract-only scheduling, approval, and orchestration fields stay behind.
 */
export function deriveFocusEnvelope(
  contract: ApprovedExecutionContract,
  sliceId: string,
  runtime: { readonly role: FocusRole; readonly currentBlocker?: string; readonly gateFailureFingerprint?: string },
): DeriveFocusEnvelopeResult {
  if (!approvalBindingMatches(contract)
    || !focusSliceId(sliceId)
    || !denseArray(contract.slices, sliceShape)) {
    return { ok: false, reason: "slice_not_projectable" };
  }
  const slice = contract.slices.find((candidate) => candidate.sliceId === sliceId);
  if (!slice) return { ok: false, reason: "unknown_slice" };
  const orderedSlices = topologicalSliceIds(contract);
  if (!orderedSlices) return { ok: false, reason: "slice_not_projectable" };
  const index = orderedSlices.indexOf(sliceId);
  if (index < 0) return { ok: false, reason: "slice_not_projectable" };
  const blocker = runtime.currentBlocker ?? "none";
  const gate = runtime.gateFailureFingerprint ?? "none";
  const remainingSlices = orderedSlices.slice(index);

  if (!projectableRole(runtime.role)
    || !Object.hasOwn(contract, "objective")
    || !boundedText(contract.objective)
    || !Object.hasOwn(contract, "planDirectory")
    || !repoRelativePath(contract.planDirectory)
    || !boundedText(slice.acceptance, 512)
    || !boundedText(blocker)
    || !boundedText(gate, 512)
    || slice.writeSet.length === 0
    || slice.writeSet.length > MAX_ITEMS
    || duplicate(slice.writeSet)
    || slice.writeSet.some((path) => !safePath(path))
    || slice.evidenceCommandIds.length === 0
    || slice.evidenceCommandIds.length > MAX_ITEMS
    || duplicate(slice.evidenceCommandIds)
    || slice.evidenceCommandIds.some((id) => !COMMAND_ID.test(id) || !boundedText(`${id}: passing command evidence`))
    || remainingSlices.length === 0
    || remainingSlices.length > MAX_ITEMS
    || remainingSlices.some((id) => !focusSliceId(id))
  ) {
    return { ok: false, reason: "slice_not_projectable" };
  }

  return {
    version: 1,
    role: runtime.role,
    immutableObjective: contract.objective,
    currentAcceptanceCriterion: slice.acceptance,
    allowedPaths: [...slice.writeSet],
    requiredEvidence: slice.evidenceCommandIds.map((id) => `${id}: passing command evidence`),
    seitCommandIds: [...slice.evidenceCommandIds],
    currentBlocker: blocker,
    remainingSlices,
    gateFailureFingerprint: gate,
    prohibition: "Do not perform unrelated work.",
  };
}

// ---------------------------------------------------------------------------
// Crewmate packet outcome contract
// ---------------------------------------------------------------------------

/**
 * Bounded attempts one Crewmate may spend on a single packet before it must
 * stop with a typed `incomplete` or `blocked` outcome. The budget keeps
 * red-to-green retrying finite inside one invocation.
 */
export const CREWMATE_MAX_ATTEMPTS = 3 as const;

/**
 * Typed verdict of one Crewmate packet, distinct from containment evidence.
 * Containment records what changed and what ran under which guard identity;
 * the outcome records whether the packet completed. Provider-neutral: no
 * provider, model, or route name appears anywhere in the shape.
 */
export const CREWMATE_TASK_OUTCOMES = ["complete", "incomplete", "blocked"] as const;
export type CrewmateTaskOutcome = (typeof CREWMATE_TASK_OUTCOMES)[number];

export interface CrewmateResumeAction {
  /** The one bounded next action for the same packet. */
  readonly action: string;
  /** The guarded run identity, copied verbatim from the receipt; a resume never opens a new packet. */
  readonly runtimeIdentity: string;
}

export interface CrewmatePacketOutcome {
  readonly status: CrewmateTaskOutcome;
  /** Exact paths this attempt changed; each stays inside the packet's write set. */
  readonly changedPaths: readonly string[];
  /** Attempts this packet consumed, between 1 and CREWMATE_MAX_ATTEMPTS. */
  readonly attemptsUsed: number;
  /** Exactly one resume action, present exactly when status is `incomplete` or `blocked`. */
  readonly resume?: CrewmateResumeAction;
}

export type CrewmatePacketOutcomeFailure =
  | "malformed"
  | "unknown_status"
  | "empty_changed_paths"
  | "invalid_changed_path"
  | "attempt_budget_exceeded"
  | "missing_resume"
  | "resume_on_complete";

export type CrewmatePacketOutcomeParseResult =
  | { readonly ok: true; readonly value: CrewmatePacketOutcome }
  | { readonly ok: false; readonly reason: CrewmatePacketOutcomeFailure };

function resumeActionShape(value: unknown): value is CrewmateResumeAction {
  return hasExactKeys(value, ["action", "runtimeIdentity"])
    && boundedText(value.action)
    && typeof value.runtimeIdentity === "string"
    && HASH.test(value.runtimeIdentity);
}

/**
 * Parse and validate one Crewmate packet outcome. The typed outcome is the
 * packet's verdict and stays separate from containment evidence, so a wrapper
 * receipt that only proves containment can never be read as completion.
 */
export function parseCrewmatePacketOutcome(value: unknown): CrewmatePacketOutcomeParseResult {
  if (!hasAllowedKeys(value, ["status", "changedPaths", "attemptsUsed"], ["resume"])) {
    return { ok: false, reason: "malformed" };
  }
  if (value.status !== "complete" && value.status !== "incomplete" && value.status !== "blocked") {
    return { ok: false, reason: "unknown_status" };
  }
  if (typeof value.attemptsUsed !== "number" || !Number.isSafeInteger(value.attemptsUsed)) {
    return { ok: false, reason: "malformed" };
  }
  const changedPaths = value.changedPaths;
  if (!Array.isArray(changedPaths)
    || changedPaths.length > MAX_ITEMS
    || changedPaths.some((path) => typeof path !== "string" || !safePath(path))
    || duplicate(changedPaths as readonly string[])) {
    return { ok: false, reason: "invalid_changed_path" };
  }
  // A write-nothing stop is representable for incomplete/blocked (the resume
  // action names what unblocks the packet); only "complete" must have changed
  // paths, or an empty success would certify nothing was done.
  if (value.status === "complete" && changedPaths.length === 0) {
    return { ok: false, reason: "empty_changed_paths" };
  }
  if (value.attemptsUsed < 1 || value.attemptsUsed > CREWMATE_MAX_ATTEMPTS) {
    return { ok: false, reason: "attempt_budget_exceeded" };
  }
  if (value.status === "complete") {
    if (value.resume !== undefined) return { ok: false, reason: "resume_on_complete" };
    return {
      ok: true,
      value: deepFreeze({
        status: value.status,
        changedPaths: [...changedPaths] as readonly string[],
        attemptsUsed: value.attemptsUsed,
      }),
    };
  }
  if (!resumeActionShape(value.resume)) return { ok: false, reason: "missing_resume" };
  return {
    ok: true,
    value: deepFreeze({
      status: value.status,
      changedPaths: [...changedPaths] as readonly string[],
      attemptsUsed: value.attemptsUsed,
      resume: value.resume,
    }),
  };
}
