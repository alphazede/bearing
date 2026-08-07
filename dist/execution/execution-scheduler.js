import { AUTHORITY_POLICY_SCHEMA_VERSION, AuthorityPolicy, } from "../authority/authority-policy.js";
import { EXECUTION_MODES } from "./execution-mode.js";
export { recommendExecutionMode } from "./execution-mode.js";
export const WORK_GRAPH_SCHEMA_VERSION = 1;
export const MAX_ORCHESTRATION_DEPTH = 5;
const MAX_NODES = 64;
const MAX_CREWMATES = 16;
const MAX_PREQUISITES = 16;
const MAX_TEXT = 128;
const roles = new Set(["navigator", "explorer", "trail-boss", "sub-explorer", "crewmate"]);
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value, keys) {
    return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
/** Required keys all present; every key is required or optional; unknown keys fail closed. */
function within(value, required, optional = []) {
    return required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function text(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}
function integer(value, minimum = 0) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function textList(value) {
    return Array.isArray(value) && value.length <= MAX_NODES && value.every(text) && new Set(value).size === value.length;
}
export function validateWorkGraph(input) {
    if (!object(input) || !within(input, ["schemaVersion", "executionMode", "limits", "nodes"], ["globalRuntimePrerequisites"]))
        return error("graph_invalid");
    if (input.schemaVersion !== WORK_GRAPH_SCHEMA_VERSION || !EXECUTION_MODES.includes(input.executionMode))
        return error("graph_invalid");
    if (!object(input.limits) || !exact(input.limits, ["maxNodes", "maxCrewmatesPerExplorer"]) || !integer(input.limits.maxNodes, 1) || !integer(input.limits.maxCrewmatesPerExplorer, 1))
        return error("graph_invalid");
    if (input.limits.maxNodes > MAX_NODES || input.limits.maxCrewmatesPerExplorer > MAX_CREWMATES)
        return error("graph_too_large");
    if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > input.limits.maxNodes)
        return error(input.nodes instanceof Array && input.nodes.length > input.limits.maxNodes ? "graph_too_large" : "graph_invalid");
    let globalRuntimePrerequisites;
    if (input.globalRuntimePrerequisites !== undefined) {
        if (!Array.isArray(input.globalRuntimePrerequisites) || input.globalRuntimePrerequisites.length === 0 || input.globalRuntimePrerequisites.length > MAX_PREQUISITES)
            return error("graph_invalid");
        const seen = new Set();
        for (const raw of input.globalRuntimePrerequisites) {
            if (!object(raw) || !exact(raw, ["id", "resumeAction"]) || !text(raw.id) || !text(raw.resumeAction) || seen.has(raw.id))
                return error("graph_invalid");
            seen.add(raw.id);
        }
        globalRuntimePrerequisites = input.globalRuntimePrerequisites.map((prerequisite) => ({ id: prerequisite.id, resumeAction: prerequisite.resumeAction }));
    }
    const nodes = [];
    for (const raw of input.nodes) {
        if (!object(raw) || !within(raw, ["id", "role", "parentId", "dependencies", "sessionId", "tool", "allowedTools", "profileId", "profileConcurrency"], ["focusGated"]))
            return error("graph_invalid");
        if (raw.role === "surveyor")
            return error("surveyor_not_executor", text(raw.id) ? raw.id : undefined);
        if (!text(raw.id) || !roles.has(String(raw.role)) || (raw.parentId !== null && !text(raw.parentId)) || !textList(raw.dependencies) || !text(raw.sessionId) || !text(raw.tool) || !textList(raw.allowedTools) || !text(raw.profileId) || !integer(raw.profileConcurrency) || (raw.focusGated !== undefined && typeof raw.focusGated !== "boolean"))
            return error("graph_invalid", text(raw.id) ? raw.id : undefined);
        nodes.push({
            id: raw.id,
            role: raw.role,
            parentId: raw.parentId,
            dependencies: [...raw.dependencies],
            sessionId: raw.sessionId,
            tool: raw.tool,
            allowedTools: [...raw.allowedTools],
            profileId: raw.profileId,
            profileConcurrency: raw.profileConcurrency,
            ...(raw.focusGated === true ? { focusGated: true } : {}),
        });
    }
    const ids = new Set();
    for (const node of nodes) {
        if (ids.has(node.id))
            return error("duplicate_node_id", node.id);
        ids.add(node.id);
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
        if (node.parentId !== null && !byId.has(node.parentId))
            return error("missing_parent", node.id);
        if (node.dependencies.includes(node.id))
            return error("self_dependency", node.id);
        if (node.dependencies.some((dependency) => !byId.has(dependency)))
            return error("missing_dependency", node.id);
    }
    const graph = {
        schemaVersion: 1,
        executionMode: input.executionMode,
        limits: {
            maxNodes: input.limits.maxNodes,
            maxCrewmatesPerExplorer: input.limits.maxCrewmatesPerExplorer,
        },
        nodes,
        ...(globalRuntimePrerequisites ? { globalRuntimePrerequisites } : {}),
    };
    const ancestry = ancestryFor(graph);
    const tooDeep = nodes.find((node) => (ancestry.get(node.id)?.length ?? 0) + 1 > MAX_ORCHESTRATION_DEPTH);
    if (tooDeep)
        return error("orchestration_depth_exceeded", tooDeep.id);
    if (input.executionMode !== "expedition" && nodes.some((node) => node.role === "trail-boss")) {
        return error("trail_boss_requires_expedition");
    }
    // Issue 120: Trail Boss is orchestration-only; a work node for it must never declare
    // implementation tools, either as the executed tool or anywhere in its allowlist (the same
    // /write|edit|shell|bash/i pattern that defines the read-only verification projections).
    const implementationTool = /write|edit|shell|bash/i;
    const draftingBoss = nodes.find((node) => node.role === "trail-boss"
        && (implementationTool.test(node.tool) || node.allowedTools.some((tool) => implementationTool.test(tool))));
    if (draftingBoss)
        return error("trail_boss_orchestration_only", draftingBoss.id);
    const invalidSubExplorer = nodes.find((node) => node.role === "sub-explorer" && byId.get(node.parentId ?? "")?.role !== "explorer");
    if (invalidSubExplorer)
        return error("sub_explorer_requires_explorer_parent", invalidSubExplorer.id);
    if (!legalTopology(input.executionMode, nodes, byId, input.limits.maxCrewmatesPerExplorer))
        return error("illegal_role_topology");
    if (hasCycle(nodes))
        return error("dependency_cycle");
    return { ok: true, graph };
}
export function legalTopology(mode, nodes, byId, crewLimit) {
    const navigators = nodes.filter((node) => node.role === "navigator");
    const trailBosses = nodes.filter((node) => node.role === "trail-boss");
    const explorers = nodes.filter((node) => node.role === "explorer");
    const subExplorers = nodes.filter((node) => node.role === "sub-explorer");
    const crewmates = nodes.filter((node) => node.role === "crewmate");
    if (mode === "explorer") {
        if (navigators.length !== 0 || trailBosses.length !== 0 || subExplorers.length !== 0
            || explorers.length !== 1 || explorers[0]?.parentId !== null)
            return false;
    }
    else {
        if (navigators.length !== 1 || navigators[0]?.parentId !== null || trailBosses.length > 1
            || trailBosses.some((node) => node.parentId !== navigators[0]?.id) || explorers.length === 0)
            return false;
        const explorerParentId = trailBosses[0]?.id ?? navigators[0]?.id;
        if (explorers.some((node) => node.parentId !== explorerParentId))
            return false;
    }
    if (subExplorers.some((node) => byId.get(node.parentId ?? "")?.role !== "explorer"))
        return false;
    if (crewmates.some((node) => !["explorer", "sub-explorer"].includes(byId.get(node.parentId ?? "")?.role ?? "")))
        return false;
    // Explorers may delegate every slice to Sub-Explorers (0 direct crewmates); subs must have direct crew.
    return explorers.every((exp) => {
        const count = crewmates.filter((c) => c.parentId === exp.id).length;
        const hasSub = subExplorers.some((s) => s.parentId === exp.id);
        return (count > 0 || hasSub) && count <= crewLimit;
    }) && subExplorers.every((sub) => {
        const count = crewmates.filter((c) => c.parentId === sub.id).length;
        return count > 0 && count <= crewLimit;
    });
}
function hasCycle(nodes) {
    const indegree = new Map(nodes.map((node) => [node.id, node.dependencies.length]));
    const adjacent = new Map(nodes.map((node) => [node.id, []]));
    for (const node of nodes)
        for (const dependency of node.dependencies)
            adjacent.get(dependency)?.push(node.id);
    const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    let visited = 0;
    for (let cursor = 0; cursor < ready.length; cursor += 1) {
        const id = ready[cursor];
        visited += 1;
        for (const dependent of adjacent.get(id) ?? []) {
            const next = (indegree.get(dependent) ?? 0) - 1;
            indegree.set(dependent, next);
            if (next === 0)
                ready.push(dependent);
        }
    }
    return visited !== nodes.length;
}
export function effectiveConcurrency(caps) {
    if (![caps.global, caps.role, caps.profile, caps.remainingTokenBudget].every((value) => integer(value)) || !integer(caps.perAgentTokenEstimate, 1))
        throw new TypeError("invalid concurrency caps");
    return Math.min(caps.global, caps.role, caps.profile, Math.floor(caps.remainingTokenBudget / caps.perAgentTokenEstimate));
}
export function startSchedule(input) {
    const validated = validateWorkGraph(input.graph);
    if (!validated.ok)
        return blocked(validated.code);
    const graph = validated.graph;
    if (!validLimits(input.limits, graph) || !integer(input.nowMs))
        return blocked("graph_invalid");
    if (input.limits.globalConcurrency === 0 || graph.nodes.some((node) => input.limits.roleConcurrency[node.role] === 0 || node.profileConcurrency === 0))
        return blocked("zero_cap", graph, input.limits);
    if (input.limits.remainingTokenBudget < input.limits.perAgentTokenEstimate)
        return blocked("budget_exhausted", graph, input.limits);
    const policy = new AuthorityPolicy();
    const ancestry = ancestryFor(graph);
    for (const node of graph.nodes) {
        const decision = policy.evaluate({ schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION, role: node.role, action: "execute", tool: node.tool, allowedTools: node.allowedTools, sessionId: node.sessionId, executionAncestry: ancestry.get(node.id) ?? [], evidence: input.evidence, executionMode: graph.executionMode });
        if (!decision.allowed)
            return blocked(decision.code, graph, input.limits);
    }
    const nodes = graph.nodes.map((node) => ({ id: node.id, role: node.role, status: "pending", executionAncestry: ancestry.get(node.id) ?? [] }));
    const projection = {
        state: "active",
        graph,
        limits: input.limits,
        nodes,
        batches: [],
        transitions: [],
        ...(input.runtimeCheck ? { runtimeCheck: input.runtimeCheck } : {}),
    };
    const settled = settleBlockers(projection);
    return launchReady({ ...projection, nodes: settled.nodes, transitions: settled.transitions }, input.nowMs);
}
export function advanceSchedule(projection, facts, nowMs) {
    if (projection.state !== "active" || !projection.graph || !projection.limits || !integer(nowMs))
        return projection;
    const checkedFacts = validNodeFacts(facts, projection.graph.nodes);
    if (!checkedFacts)
        return { ...projection, state: "blocked", code: "node_facts_invalid" };
    const factsById = new Map(checkedFacts.map((fact) => [fact.nodeId, fact.outcome]));
    const transitions = [...projection.transitions];
    let nodes = projection.nodes.map((node) => {
        if (node.status !== "running")
            return node;
        const outcome = factsById.get(node.id);
        const next = outcome ?? (node.launchedAtMs !== undefined && nowMs - node.launchedAtMs >= projection.limits.timeoutMs ? "timed_out" : undefined);
        if (!next)
            return node;
        transitions.push({ nodeId: node.id, from: "running", to: next });
        return { ...node, status: next };
    });
    const settled = settleBlockers({ ...projection, nodes, transitions });
    return launchReady({ ...projection, nodes: settled.nodes, transitions: settled.transitions }, nowMs);
}
/**
 * Fixed-point over blocking states. Dependents of failed or blocked
 * prerequisites are blocked, and are released again if the dependency set
 * clears (a gated lane unblocking after its runtime prerequisite becomes
 * active). Focus-backed lanes declared under a global runtime prerequisite
 * stay blocked with a typed blocker naming the unmet prerequisite and its one
 * concrete resume action until the injected check reports it merged AND
 * runtime-active; a declared prerequisite with no check fails closed.
 */
function settleBlockers(projection) {
    const graph = projection.graph;
    const graphById = new Map(graph.nodes.map((node) => [node.id, node]));
    const prerequisites = graph.globalRuntimePrerequisites ?? [];
    const isMet = (id) => projection.runtimeCheck?.isMet(id) === true;
    let nodes = projection.nodes;
    const transitions = [...projection.transitions];
    let changed = true;
    while (changed) {
        changed = false;
        // Release dependents that were blocked only because a dependency was blocked.
        const statusA = new Map(nodes.map((node) => [node.id, node.status]));
        nodes = nodes.map((node) => {
            if (node.status !== "blocked" || node.reason !== "failed_prerequisite")
                return node;
            if (graphById.get(node.id)?.dependencies.some((id) => ["failed", "timed_out", "blocked"].includes(statusA.get(id) ?? "")))
                return node;
            changed = true;
            transitions.push({ nodeId: node.id, from: "blocked", to: "pending", reason: "failed_prerequisite" });
            return { ...node, status: "pending", reason: undefined };
        });
        // Block pending dependents of failed or blocked prerequisites.
        const statusB = new Map(nodes.map((node) => [node.id, node.status]));
        nodes = nodes.map((node) => {
            if (node.status !== "pending" || !graphById.get(node.id)?.dependencies.some((id) => ["failed", "timed_out", "blocked"].includes(statusB.get(id) ?? "")))
                return node;
            changed = true;
            transitions.push({ nodeId: node.id, from: "pending", to: "blocked", reason: "failed_prerequisite" });
            return { ...node, status: "blocked", reason: "failed_prerequisite" };
        });
        if (prerequisites.length === 0)
            continue;
        // Gate Focus-backed lanes on every declared global runtime prerequisite.
        const statusC = new Map(nodes.map((node) => [node.id, node.status]));
        nodes = nodes.map((node) => {
            if (graphById.get(node.id)?.focusGated !== true)
                return node;
            if (node.status === "pending") {
                const unmet = prerequisites.find((prerequisite) => !isMet(prerequisite.id));
                if (!unmet)
                    return node;
                changed = true;
                transitions.push({ nodeId: node.id, from: "pending", to: "blocked", reason: "runtime_prerequisite" });
                return { ...node, status: "blocked", reason: "runtime_prerequisite", blocker: { prerequisiteId: unmet.id, resumeAction: unmet.resumeAction } };
            }
            if (node.status === "blocked" && node.reason === "runtime_prerequisite") {
                if (prerequisites.some((prerequisite) => !isMet(prerequisite.id)))
                    return node;
                changed = true;
                transitions.push({ nodeId: node.id, from: "blocked", to: "pending", reason: "runtime_prerequisite" });
                return { ...node, status: "pending", reason: undefined, blocker: undefined };
            }
            return node;
        });
    }
    return { nodes, transitions };
}
function validNodeFacts(value, graphNodes) {
    if (!Array.isArray(value) || value.length > graphNodes.length)
        return null;
    const known = new Set(graphNodes.map((node) => node.id));
    const seen = new Set();
    for (const fact of value) {
        if (!object(fact) || !exact(fact, ["nodeId", "outcome"]) || !text(fact.nodeId) || !known.has(fact.nodeId) || seen.has(fact.nodeId) || !["completed", "failed", "timed_out"].includes(String(fact.outcome)))
            return null;
        seen.add(fact.nodeId);
    }
    return value;
}
function launchReady(projection, nowMs) {
    const graph = projection.graph;
    const limits = projection.limits;
    const status = new Map(projection.nodes.map((node) => [node.id, node.status]));
    const running = projection.nodes.filter((node) => node.status === "running");
    const roleRunning = new Map([
        ["navigator", 0],
        ["explorer", 0],
        ["trail-boss", 0],
        ["sub-explorer", 0],
        ["crewmate", 0],
    ]);
    const profileRunning = new Map();
    const graphById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of running) {
        roleRunning.set(node.role, (roleRunning.get(node.role) ?? 0) + 1);
        const profile = graphById.get(node.id).profileId;
        profileRunning.set(profile, (profileRunning.get(profile) ?? 0) + 1);
    }
    let remaining = limits.remainingTokenBudget - projection.batches.reduce((sum, batch) => sum + batch.nodeIds.length * limits.perAgentTokenEstimate, 0);
    let globalSlots = limits.globalConcurrency - running.length;
    const launched = new Set();
    for (const node of graph.nodes) {
        if (status.get(node.id) !== "pending" || !node.dependencies.every((id) => status.get(id) === "completed"))
            continue;
        const cap = effectiveConcurrency({ global: Math.max(0, globalSlots), role: Math.max(0, limits.roleConcurrency[node.role] - (roleRunning.get(node.role) ?? 0)), profile: Math.max(0, node.profileConcurrency - (profileRunning.get(node.profileId) ?? 0)), remainingTokenBudget: Math.max(0, remaining), perAgentTokenEstimate: limits.perAgentTokenEstimate });
        if (cap === 0)
            continue;
        launched.add(node.id);
        globalSlots -= 1;
        remaining -= limits.perAgentTokenEstimate;
        roleRunning.set(node.role, (roleRunning.get(node.role) ?? 0) + 1);
        profileRunning.set(node.profileId, (profileRunning.get(node.profileId) ?? 0) + 1);
    }
    const transitions = [...projection.transitions];
    const nodes = projection.nodes.map((node) => {
        if (!launched.has(node.id))
            return node;
        transitions.push({ nodeId: node.id, from: "pending", to: "running" });
        return { ...node, status: "running", launchedAtMs: nowMs };
    });
    const batches = launched.size === 0 ? projection.batches : [...projection.batches, { nodeIds: [...launched], atMs: nowMs, remainingTokenBudget: remaining }];
    // runtime_prerequisite blocks are transient: they clear when the injected
    // check flips, so a projection whose only remaining nodes are such lanes must
    // stay releasable by a later advanceSchedule — never "finished". A node
    // blocked on a failed/timed_out prerequisite is terminal; a
    // failed_prerequisite-blocked dependent of a runtime-blocked lane always has
    // that runtime-blocked ancestor in the graph, so it keeps the projection
    // active too.
    const terminal = (node) => ["completed", "failed", "timed_out"].includes(node.status) || (node.status === "blocked" && node.reason !== "runtime_prerequisite");
    if (nodes.every(terminal))
        return { ...projection, state: "finished", nodes, batches, transitions };
    if (nodes.some((node) => node.status === "pending") && !nodes.some((node) => node.status === "running") && remaining < limits.perAgentTokenEstimate)
        return { ...projection, state: "blocked", code: "budget_exhausted", nodes, batches, transitions };
    return { ...projection, state: "active", nodes, batches, transitions };
}
function ancestryFor(graph) {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return new Map(graph.nodes.map((node) => {
        const ancestry = [];
        const seen = new Set();
        let parent = node.parentId === null ? undefined : byId.get(node.parentId);
        while (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            ancestry.push(parent.sessionId);
            parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
        }
        return [node.id, ancestry];
    }));
}
function validLimits(limits, graph) {
    const required = ["navigator", "explorer", "crewmate"];
    const allowed = new Set([...required, "trail-boss", "sub-explorer"]);
    return integer(limits.globalConcurrency) && integer(limits.remainingTokenBudget) && integer(limits.perAgentTokenEstimate, 1) && integer(limits.timeoutMs, 1)
        && object(limits.roleConcurrency)
        && required.every((role) => Object.hasOwn(limits.roleConcurrency, role))
        && Object.keys(limits.roleConcurrency).every((role) => allowed.has(role))
        && Object.values(limits.roleConcurrency).every((value) => integer(value))
        && graph.nodes.every((node) => Object.hasOwn(limits.roleConcurrency, node.role));
}
function blocked(code, graph, limits) {
    return { state: "blocked", code, ...(graph ? { graph } : {}), ...(limits ? { limits } : {}), nodes: [], batches: [], transitions: [] };
}
function error(code, nodeId) {
    return { ok: false, code, ...(nodeId ? { nodeId } : {}) };
}
