import {
  AUTHORITY_POLICY_SCHEMA_VERSION,
  AuthorityPolicy,
  type AuthorityDenialCode,
} from "../authority/authority-policy.js";
import { EXECUTION_MODES, type ExecutionMode, type ModeRecommendationInput, type ModeRecommendation } from "./execution-mode.js";
import type { DurableOwnerEvidence } from "../workflow/aggregate.js";
export { EXECUTION_MODES, recommendExecutionMode, type ExecutionMode, type ModeRecommendationInput, type ModeRecommendation } from "./execution-mode.js";

export const WORK_GRAPH_SCHEMA_VERSION = 1 as const;
export type ExecutorRole = "navigator" | "explorer" | "crewmate";

export interface WorkNode {
  readonly id: string;
  readonly role: ExecutorRole;
  readonly parentId: string | null;
  readonly dependencies: readonly string[];
  readonly sessionId: string;
  readonly tool: string;
  readonly allowedTools: readonly string[];
  readonly profileId: string;
  readonly profileConcurrency: number;
}

export interface WorkGraph {
  readonly schemaVersion: typeof WORK_GRAPH_SCHEMA_VERSION;
  readonly executionMode: ExecutionMode;
  readonly limits: { readonly maxNodes: number; readonly maxCrewmatesPerExplorer: number };
  readonly nodes: readonly WorkNode[];
}

export type GraphErrorCode =
  | "graph_invalid"
  | "graph_too_large"
  | "duplicate_node_id"
  | "missing_parent"
  | "missing_dependency"
  | "self_dependency"
  | "illegal_role_topology"
  | "dependency_cycle"
  | "surveyor_not_executor";

export type GraphValidation =
  | { readonly ok: true; readonly graph: WorkGraph }
  | { readonly ok: false; readonly code: GraphErrorCode; readonly nodeId?: string };

export interface ConcurrencyCaps {
  readonly global: number;
  readonly role: number;
  readonly profile: number;
  readonly remainingTokenBudget: number;
  readonly perAgentTokenEstimate: number;
}

export interface ScheduleLimits {
  readonly globalConcurrency: number;
  readonly roleConcurrency: Readonly<Record<ExecutorRole, number>>;
  readonly remainingTokenBudget: number;
  readonly perAgentTokenEstimate: number;
  readonly timeoutMs: number;
}

export interface StartScheduleInput {
  readonly graph: unknown;
  readonly evidence?: DurableOwnerEvidence;
  readonly limits: ScheduleLimits;
  readonly nowMs: number;
}

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "timed_out" | "blocked";

export interface ScheduledNode {
  readonly id: string;
  readonly role: ExecutorRole;
  readonly status: NodeStatus;
  readonly executionAncestry: readonly string[];
  readonly launchedAtMs?: number;
  readonly reason?: "failed_prerequisite";
}

export interface LaunchBatch {
  readonly nodeIds: readonly string[];
  readonly atMs: number;
  readonly remainingTokenBudget: number;
}

export interface ScheduleProjection {
  readonly state: "active" | "finished" | "blocked";
  readonly code?: GraphErrorCode | AuthorityDenialCode | "zero_cap" | "budget_exhausted" | "node_facts_invalid";
  readonly graph?: WorkGraph;
  readonly limits?: ScheduleLimits;
  readonly nodes: readonly ScheduledNode[];
  readonly batches: readonly LaunchBatch[];
  readonly transitions: readonly { readonly nodeId: string; readonly from: NodeStatus; readonly to: NodeStatus; readonly reason?: "failed_prerequisite" }[];
}

export interface NodeFact {
  readonly nodeId: string;
  readonly outcome: "completed" | "failed" | "timed_out";
}

const MAX_NODES = 64;
const MAX_CREWMATES = 16;
const MAX_TEXT = 128;
const roles = new Set<string>(["navigator", "explorer", "crewmate"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function textList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_NODES && value.every(text) && new Set(value).size === value.length;
}

export function validateWorkGraph(input: unknown): GraphValidation {
  if (!object(input) || !exact(input, ["schemaVersion", "executionMode", "limits", "nodes"])) return error("graph_invalid");
  if (input.schemaVersion !== WORK_GRAPH_SCHEMA_VERSION || !EXECUTION_MODES.includes(input.executionMode as ExecutionMode)) return error("graph_invalid");
  if (!object(input.limits) || !exact(input.limits, ["maxNodes", "maxCrewmatesPerExplorer"]) || !integer(input.limits.maxNodes, 1) || !integer(input.limits.maxCrewmatesPerExplorer, 1)) return error("graph_invalid");
  if (input.limits.maxNodes > MAX_NODES || input.limits.maxCrewmatesPerExplorer > MAX_CREWMATES) return error("graph_too_large");
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > input.limits.maxNodes) return error(input.nodes instanceof Array && input.nodes.length > input.limits.maxNodes ? "graph_too_large" : "graph_invalid");

  const nodes: WorkNode[] = [];
  for (const raw of input.nodes) {
    if (!object(raw) || !exact(raw, ["id", "role", "parentId", "dependencies", "sessionId", "tool", "allowedTools", "profileId", "profileConcurrency"])) return error("graph_invalid");
    if (raw.role === "surveyor") return error("surveyor_not_executor", text(raw.id) ? raw.id : undefined);
    if (!text(raw.id) || !roles.has(String(raw.role)) || (raw.parentId !== null && !text(raw.parentId)) || !textList(raw.dependencies) || !text(raw.sessionId) || !text(raw.tool) || !textList(raw.allowedTools) || !text(raw.profileId) || !integer(raw.profileConcurrency)) return error("graph_invalid", text(raw.id) ? raw.id : undefined);
    nodes.push({
      id: raw.id,
      role: raw.role as ExecutorRole,
      parentId: raw.parentId,
      dependencies: [...raw.dependencies],
      sessionId: raw.sessionId,
      tool: raw.tool,
      allowedTools: [...raw.allowedTools],
      profileId: raw.profileId,
      profileConcurrency: raw.profileConcurrency,
    });
  }

  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return error("duplicate_node_id", node.id);
    ids.add(node.id);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) return error("missing_parent", node.id);
    if (node.dependencies.includes(node.id)) return error("self_dependency", node.id);
    if (node.dependencies.some((dependency) => !byId.has(dependency))) return error("missing_dependency", node.id);
  }
  if (!legalTopology(input.executionMode as ExecutionMode, nodes, byId, input.limits.maxCrewmatesPerExplorer as number)) return error("illegal_role_topology");
  if (hasCycle(nodes)) return error("dependency_cycle");
  return { ok: true, graph: { schemaVersion: 1, executionMode: input.executionMode as ExecutionMode, limits: { maxNodes: input.limits.maxNodes as number, maxCrewmatesPerExplorer: input.limits.maxCrewmatesPerExplorer as number }, nodes } };
}

function legalTopology(mode: ExecutionMode, nodes: readonly WorkNode[], byId: ReadonlyMap<string, WorkNode>, crewLimit: number): boolean {
  const navigators = nodes.filter((node) => node.role === "navigator");
  const explorers = nodes.filter((node) => node.role === "explorer");
  const crewmates = nodes.filter((node) => node.role === "crewmate");
  if (mode === "explorer") {
    if (navigators.length !== 0 || explorers.length !== 1 || explorers[0]?.parentId !== null) return false;
  } else {
    if (navigators.length !== 1 || navigators[0]?.parentId !== null || explorers.length === 0 || explorers.some((node) => byId.get(node.parentId ?? "")?.role !== "navigator")) return false;
  }
  if (crewmates.some((node) => byId.get(node.parentId ?? "")?.role !== "explorer")) return false;
  return explorers.every((explorer) => {
    const count = crewmates.filter((node) => node.parentId === explorer.id).length;
    return count > 0 && count <= crewLimit;
  });
}

function hasCycle(nodes: readonly WorkNode[]): boolean {
  const indegree = new Map(nodes.map((node) => [node.id, node.dependencies.length]));
  const adjacent = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) for (const dependency of node.dependencies) adjacent.get(dependency)?.push(node.id);
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor]!;
    visited += 1;
    for (const dependent of adjacent.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  return visited !== nodes.length;
}

export function effectiveConcurrency(caps: ConcurrencyCaps): number {
  if (![caps.global, caps.role, caps.profile, caps.remainingTokenBudget].every((value) => integer(value)) || !integer(caps.perAgentTokenEstimate, 1)) throw new TypeError("invalid concurrency caps");
  return Math.min(caps.global, caps.role, caps.profile, Math.floor(caps.remainingTokenBudget / caps.perAgentTokenEstimate));
}

export function startSchedule(input: StartScheduleInput): ScheduleProjection {
  const validated = validateWorkGraph(input.graph);
  if (!validated.ok) return blocked(validated.code);
  if (!validLimits(input.limits) || !integer(input.nowMs)) return blocked("graph_invalid");
  const graph = validated.graph;
  if (input.limits.globalConcurrency === 0 || graph.nodes.some((node) => input.limits.roleConcurrency[node.role] === 0 || node.profileConcurrency === 0)) return blocked("zero_cap", graph, input.limits);
  if (input.limits.remainingTokenBudget < input.limits.perAgentTokenEstimate) return blocked("budget_exhausted", graph, input.limits);

  const policy = new AuthorityPolicy();
  const ancestry = ancestryFor(graph);
  for (const node of graph.nodes) {
    const decision = policy.evaluate({ schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION, role: node.role, action: "execute", tool: node.tool, allowedTools: node.allowedTools, sessionId: node.sessionId, executionAncestry: ancestry.get(node.id) ?? [], evidence: input.evidence, executionMode: graph.executionMode });
    if (!decision.allowed) return blocked(decision.code, graph, input.limits);
  }
  const nodes = graph.nodes.map((node) => ({ id: node.id, role: node.role, status: "pending" as const, executionAncestry: ancestry.get(node.id) ?? [] }));
  return launchReady({ state: "active", graph, limits: input.limits, nodes, batches: [], transitions: [] }, input.nowMs);
}

export function advanceSchedule(projection: ScheduleProjection, facts: unknown, nowMs: number): ScheduleProjection {
  if (projection.state !== "active" || !projection.graph || !projection.limits || !integer(nowMs)) return projection;
  const checkedFacts = validNodeFacts(facts, projection.graph.nodes);
  if (!checkedFacts) return { ...projection, state: "blocked", code: "node_facts_invalid" };
  const factsById = new Map(checkedFacts.map((fact) => [fact.nodeId, fact.outcome]));
  const transitions = [...projection.transitions];
  let nodes = projection.nodes.map((node) => {
    if (node.status !== "running") return node;
    const outcome = factsById.get(node.id);
    const next: NodeStatus | undefined = outcome ?? (node.launchedAtMs !== undefined && nowMs - node.launchedAtMs >= projection.limits!.timeoutMs ? "timed_out" : undefined);
    if (!next) return node;
    transitions.push({ nodeId: node.id, from: "running", to: next });
    return { ...node, status: next };
  });
  const graphById = new Map(projection.graph.nodes.map((node) => [node.id, node]));
  let changed = true;
  while (changed) {
    changed = false;
    const status = new Map(nodes.map((node) => [node.id, node.status]));
    nodes = nodes.map((node) => {
      if (node.status !== "pending" || !graphById.get(node.id)?.dependencies.some((id) => ["failed", "timed_out", "blocked"].includes(status.get(id) ?? ""))) return node;
      changed = true;
      transitions.push({ nodeId: node.id, from: "pending", to: "blocked", reason: "failed_prerequisite" });
      return { ...node, status: "blocked", reason: "failed_prerequisite" as const };
    });
  }
  return launchReady({ ...projection, nodes, transitions }, nowMs);
}

function validNodeFacts(value: unknown, graphNodes: readonly WorkNode[]): readonly NodeFact[] | null {
  if (!Array.isArray(value) || value.length > graphNodes.length) return null;
  const known = new Set(graphNodes.map((node) => node.id));
  const seen = new Set<string>();
  for (const fact of value) {
    if (!object(fact) || !exact(fact, ["nodeId", "outcome"]) || !text(fact.nodeId) || !known.has(fact.nodeId) || seen.has(fact.nodeId) || !["completed", "failed", "timed_out"].includes(String(fact.outcome))) return null;
    seen.add(fact.nodeId);
  }
  return value as readonly NodeFact[];
}

function launchReady(projection: ScheduleProjection, nowMs: number): ScheduleProjection {
  const graph = projection.graph!;
  const limits = projection.limits!;
  const status = new Map(projection.nodes.map((node) => [node.id, node.status]));
  const running = projection.nodes.filter((node) => node.status === "running");
  const roleRunning = new Map<ExecutorRole, number>([["navigator", 0], ["explorer", 0], ["crewmate", 0]]);
  const profileRunning = new Map<string, number>();
  const graphById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of running) {
    roleRunning.set(node.role, (roleRunning.get(node.role) ?? 0) + 1);
    const profile = graphById.get(node.id)!.profileId;
    profileRunning.set(profile, (profileRunning.get(profile) ?? 0) + 1);
  }
  let remaining = limits.remainingTokenBudget - projection.batches.reduce((sum, batch) => sum + batch.nodeIds.length * limits.perAgentTokenEstimate, 0);
  let globalSlots = limits.globalConcurrency - running.length;
  const launched = new Set<string>();
  for (const node of graph.nodes) {
    if (status.get(node.id) !== "pending" || !node.dependencies.every((id) => status.get(id) === "completed")) continue;
    const cap = effectiveConcurrency({ global: Math.max(0, globalSlots), role: Math.max(0, limits.roleConcurrency[node.role] - (roleRunning.get(node.role) ?? 0)), profile: Math.max(0, node.profileConcurrency - (profileRunning.get(node.profileId) ?? 0)), remainingTokenBudget: Math.max(0, remaining), perAgentTokenEstimate: limits.perAgentTokenEstimate });
    if (cap === 0) continue;
    launched.add(node.id);
    globalSlots -= 1;
    remaining -= limits.perAgentTokenEstimate;
    roleRunning.set(node.role, (roleRunning.get(node.role) ?? 0) + 1);
    profileRunning.set(node.profileId, (profileRunning.get(node.profileId) ?? 0) + 1);
  }
  const transitions = [...projection.transitions];
  const nodes = projection.nodes.map((node) => {
    if (!launched.has(node.id)) return node;
    transitions.push({ nodeId: node.id, from: "pending", to: "running" });
    return { ...node, status: "running" as const, launchedAtMs: nowMs };
  });
  const batches = launched.size === 0 ? projection.batches : [...projection.batches, { nodeIds: [...launched], atMs: nowMs, remainingTokenBudget: remaining }];
  if (nodes.every((node) => ["completed", "failed", "timed_out", "blocked"].includes(node.status))) return { ...projection, state: "finished", nodes, batches, transitions };
  if (nodes.some((node) => node.status === "pending") && !nodes.some((node) => node.status === "running") && remaining < limits.perAgentTokenEstimate) return { ...projection, state: "blocked", code: "budget_exhausted", nodes, batches, transitions };
  return { ...projection, state: "active", nodes, batches, transitions };
}

function ancestryFor(graph: WorkGraph): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return new Map(graph.nodes.map((node) => {
    const ancestry: string[] = [];
    let parent = node.parentId === null ? undefined : byId.get(node.parentId);
    while (parent) {
      ancestry.push(parent.sessionId);
      parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
    }
    return [node.id, ancestry] as const;
  }));
}

function validLimits(limits: ScheduleLimits): boolean {
  return integer(limits.globalConcurrency) && integer(limits.remainingTokenBudget) && integer(limits.perAgentTokenEstimate, 1) && integer(limits.timeoutMs, 1)
    && object(limits.roleConcurrency) && exact(limits.roleConcurrency, ["navigator", "explorer", "crewmate"])
    && Object.values(limits.roleConcurrency).every((value) => integer(value));
}

function blocked(code: ScheduleProjection["code"], graph?: WorkGraph, limits?: ScheduleLimits): ScheduleProjection {
  return { state: "blocked", code, ...(graph ? { graph } : {}), ...(limits ? { limits } : {}), nodes: [], batches: [], transitions: [] };
}

function error(code: GraphErrorCode, nodeId?: string): GraphValidation {
  return { ok: false, code, ...(nodeId ? { nodeId } : {}) };
}
