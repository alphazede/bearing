import { posix, win32 } from "node:path";
import { canonicalStringify, hashEvent } from "./run.js";
import { BUILTIN_ROUTES } from "../adapters/adapters.js";
import { provenIndependent } from "../execution/concurrency-control.js";
import { REASONING_TIERS } from "../profile/reasoning-policy.js";
export const EXECUTION_CONTRACT_SCHEMA_VERSION = 1;
const MAX_ITEMS = 128;
const MAX_TEXT = 4096;
const MAX_SLICE_ID = 128;
const COMMAND_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const SLICE_ID = /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/;
/** Required delegation roles a guided run must route before wave artifacts exist. */
export const ROLE_KINDS = ["execution-author", "review-general", "review-security"];
/** The built-in read-only reviewer, authorized only as a review-role fallback, never a primary or author route. */
export const SURVEYOR_FALLBACK_ROUTE = "surveyor";
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, required) {
    return isObject(value)
        && Object.keys(value).length === required.length
        && required.every((key) => Object.hasOwn(value, key));
}
function hasAllowedKeys(value, required, optional) {
    if (!isObject(value))
        return false;
    const allowed = new Set([...required, ...optional]);
    return Object.keys(value).every((key) => allowed.has(key))
        && required.every((key) => Object.hasOwn(value, key));
}
function boundedText(value, max = MAX_TEXT) {
    return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function denseArray(value, predicate) {
    if (!Array.isArray(value) || value.length > MAX_ITEMS)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !predicate(value[index]))
            return false;
    }
    return true;
}
function stringArray(value, predicate = boundedText) {
    return denseArray(value, predicate);
}
function focusSliceId(value) {
    return boundedText(value, MAX_SLICE_ID) && SLICE_ID.test(value);
}
function writeSetArray(value) {
    return denseArray(value, (item) => typeof item === "string" && item.length <= MAX_TEXT);
}
function repoRelativePath(value) {
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
function safePath(value) {
    return repoRelativePath(value) && posix.normalize(value) === value && !/[:*<>]/.test(value)
        && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function phaseShape(value) {
    return hasAllowedKeys(value, ["phaseId", "title", "entryCriteria", "exitCriteria"], ["dependsOnPhases", "integrationCheckpointCount"])
        && boundedText(value.phaseId)
        && boundedText(value.title)
        && boundedText(value.entryCriteria)
        && boundedText(value.exitCriteria)
        && (value.dependsOnPhases === undefined
            || stringArray(value.dependsOnPhases) && !duplicate(value.dependsOnPhases))
        && (value.integrationCheckpointCount === undefined
            || Number.isSafeInteger(value.integrationCheckpointCount)
                && value.integrationCheckpointCount >= 0
                && value.integrationCheckpointCount <= MAX_ITEMS);
}
function sliceShape(value) {
    return hasAllowedKeys(value, [
        "sliceId", "phaseId", "requirementIds", "writeSet", "acceptance",
        "evidenceCommandIds", "dependsOn", "parallelSafe", "role", "reasoningTier",
    ], ["sharedInterfaces", "integrationBoundary"])
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
        && REASONING_TIERS.includes(value.reasoningTier)
        && (value.sharedInterfaces === undefined
            || stringArray(value.sharedInterfaces) && !duplicate(value.sharedInterfaces))
        && (value.integrationBoundary === undefined || boundedText(value.integrationBoundary));
}
function edgeShape(value) {
    return hasExactKeys(value, ["from", "to"]) && focusSliceId(value.from) && focusSliceId(value.to);
}
const AGENT_ROUTE_IDS = new Set(BUILTIN_ROUTES.map((route) => route.id));
function agentRouteId(value) {
    return typeof value === "string" && AGENT_ROUTE_IDS.has(value);
}
// Surveyor is a built-in read-only reviewer, never an author: it may fill a review
// fallback slot but is refused as a primary route or as the execution-author's fallback.
function fallbackRouteId(role, value) {
    return agentRouteId(value) || (role !== "execution-author" && value === SURVEYOR_FALLBACK_ROUTE);
}
function roleRouteShape(value) {
    if (!hasExactKeys(value, ["role", "primary", "fallbacks"]))
        return false;
    if (typeof value.role !== "string" || !ROLE_KINDS.includes(value.role))
        return false;
    const role = value.role;
    if (!agentRouteId(value.primary))
        return false;
    if (!denseArray(value.fallbacks, (item) => fallbackRouteId(role, item)))
        return false;
    const fallbacks = value.fallbacks;
    return !duplicate(fallbacks) && !fallbacks.includes(value.primary);
}
/** Exactly one route per required role: no duplicate, missing, or extra role. */
export function roleRoutesShape(value) {
    if (!denseArray(value, roleRouteShape) || value.length !== ROLE_KINDS.length)
        return false;
    const roles = new Set(value.map((route) => route.role));
    return roles.size === ROLE_KINDS.length && ROLE_KINDS.every((kind) => roles.has(kind));
}
function approvalShape(value) {
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
export function hashExecutionContractBody(body) {
    const canonicalBody = JSON.parse(canonicalStringify(body));
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
export function hashLegacyRoleRoutes(runId, roleRoutes) {
    const canonical = JSON.parse(canonicalStringify({ runId, roleRoutes }));
    return hashEvent(canonical);
}
function bodyOf(contract) {
    const { contentHash: _hash, ownerApproval: _approval, ...body } = contract;
    return body;
}
function deepFreeze(value) {
    if (typeof value !== "object" || value === null)
        return value;
    for (const nested of Object.values(value))
        deepFreeze(nested);
    return Object.freeze(value);
}
function immutableContractSnapshot(contract) {
    return deepFreeze(JSON.parse(canonicalStringify(contract)));
}
function approvalBindingMatches(contract) {
    try {
        return typeof contract.contentHash === "string"
            && HASH.test(contract.contentHash)
            && approvalShape(contract.ownerApproval)
            && contract.ownerApproval.contentHash === contract.contentHash
            && hashExecutionContractBody(bodyOf(contract)) === contract.contentHash;
    }
    catch {
        return false;
    }
}
function duplicate(values) {
    return new Set(values).size !== values.length;
}
function dependencyCycle(contract) {
    const outgoing = new Map(contract.slices.map((slice) => [slice.sliceId, []]));
    for (const slice of contract.slices) {
        for (const dependency of slice.dependsOn)
            outgoing.get(dependency).push(slice.sliceId);
    }
    for (const edge of contract.dependencyEdges)
        outgoing.get(edge.from).push(edge.to);
    const visiting = new Set();
    const visited = new Set();
    const visit = (sliceId) => {
        if (visiting.has(sliceId))
            return true;
        if (visited.has(sliceId))
            return false;
        visiting.add(sliceId);
        if (outgoing.get(sliceId).some(visit))
            return true;
        visiting.delete(sliceId);
        visited.add(sliceId);
        return false;
    };
    return contract.slices.some((slice) => visit(slice.sliceId));
}
function derivedPhaseDependencies(contract) {
    const sliceById = new Map(contract.slices.map((slice) => [slice.sliceId, slice]));
    const derived = new Map(contract.phases.map((phase) => [phase.phaseId, new Set()]));
    const connect = (dependencyId, dependentId) => {
        const dependency = sliceById.get(dependencyId);
        const dependent = sliceById.get(dependentId);
        if (dependency && dependent && dependency.phaseId !== dependent.phaseId) {
            derived.get(dependent.phaseId)?.add(dependency.phaseId);
        }
    };
    for (const slice of contract.slices) {
        for (const dependency of slice.dependsOn)
            connect(dependency, slice.sliceId);
    }
    for (const edge of contract.dependencyEdges)
        connect(edge.from, edge.to);
    return derived;
}
function phaseDependenciesMatch(contract) {
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
function topologicalSliceIds(contract) {
    const outgoing = new Map(contract.slices.map((slice) => [slice.sliceId, new Set()]));
    const incoming = new Map(contract.slices.map((slice) => [slice.sliceId, 0]));
    const connect = (from, to) => {
        const dependents = outgoing.get(from);
        if (!dependents || !incoming.has(to) || dependents.has(to))
            return;
        dependents.add(to);
        incoming.set(to, incoming.get(to) + 1);
    };
    for (const slice of contract.slices)
        for (const dependency of slice.dependsOn)
            connect(dependency, slice.sliceId);
    for (const edge of contract.dependencyEdges)
        connect(edge.from, edge.to);
    const ready = contract.slices.filter((slice) => incoming.get(slice.sliceId) === 0).map((slice) => slice.sliceId);
    const ordered = [];
    for (let index = 0; index < ready.length; index += 1) {
        const sliceId = ready[index];
        ordered.push(sliceId);
        for (const dependent of outgoing.get(sliceId) ?? []) {
            const remaining = incoming.get(dependent) - 1;
            incoming.set(dependent, remaining);
            if (remaining === 0)
                ready.push(dependent);
        }
    }
    return ordered.length === contract.slices.length ? ordered : undefined;
}
function concurrencyFacts(slice) {
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
export function parallelSafetyAdvisories(contract) {
    const advisories = [];
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
            }
            else if (first.parallelSafe && second.parallelSafe
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
export function parseApprovedExecutionContract(value) {
    if (!isObject(value))
        return { ok: false, reason: "malformed" };
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
        || (value.roleRoutes !== undefined && !roleRoutesShape(value.roleRoutes))) {
        return { ok: false, reason: "malformed" };
    }
    const contract = value;
    const phaseIds = contract.phases.map((phase) => phase.phaseId);
    if (duplicate(phaseIds))
        return { ok: false, reason: "duplicate_phase_id" };
    const sliceIds = contract.slices.map((slice) => slice.sliceId);
    if (duplicate(sliceIds))
        return { ok: false, reason: "duplicate_slice_id" };
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
    if (!phaseDependenciesMatch(contract))
        return { ok: false, reason: "phase_dependency_mismatch" };
    if (dependencyCycle(contract))
        return { ok: false, reason: "cyclic_dependency" };
    if (hashExecutionContractBody(bodyOf(contract)) !== contract.contentHash) {
        return { ok: false, reason: "content_hash_mismatch" };
    }
    if (contract.ownerApproval.contentHash !== contract.contentHash) {
        return { ok: false, reason: "owner_approval_mismatch" };
    }
    const snapshot = immutableContractSnapshot(contract);
    return { ok: true, value: snapshot, advisories: parallelSafetyAdvisories(snapshot) };
}
function projectableRole(value) {
    return value === "explorer" || value === "navigator" || value === "crewmate";
}
/**
 * Project one active contract slice into the existing, stricter FocusEnvelope.
 * Contract-only scheduling, approval, and orchestration fields stay behind.
 */
export function deriveFocusEnvelope(contract, sliceId, runtime) {
    if (!approvalBindingMatches(contract)
        || !focusSliceId(sliceId)
        || !denseArray(contract.slices, sliceShape)) {
        return { ok: false, reason: "slice_not_projectable" };
    }
    const slice = contract.slices.find((candidate) => candidate.sliceId === sliceId);
    if (!slice)
        return { ok: false, reason: "unknown_slice" };
    const orderedSlices = topologicalSliceIds(contract);
    if (!orderedSlices)
        return { ok: false, reason: "slice_not_projectable" };
    const index = orderedSlices.indexOf(sliceId);
    if (index < 0)
        return { ok: false, reason: "slice_not_projectable" };
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
        || remainingSlices.some((id) => !focusSliceId(id))) {
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
