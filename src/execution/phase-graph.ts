import type {
  ApprovedExecutionContract,
  ParallelSafetyAdvisory,
} from "../contracts/execution-contract.js";
import { parallelSafetyAdvisories } from "../contracts/execution-contract.js";
import { provenIndependent, type SliceFacts } from "./concurrency-control.js";
import { deepFreeze } from "../contracts/guards.js";
import { MAX_ORCHESTRATION_DEPTH } from "./execution-scheduler.js";

interface PhaseGraphPhase {
  readonly phaseId: string;
  readonly sliceIds: readonly string[];
  readonly dependsOnPhases: readonly string[];
  readonly integrationBoundaries: readonly string[];
  readonly integrationCheckpointCount: number;
}

interface PhaseGraphSlice {
  readonly sliceId: string;
  readonly phaseId: string;
  readonly writeSet: readonly string[];
  readonly sharedInterfaces: readonly string[];
  readonly integrationBoundary?: string;
}

interface SliceParallelSafety {
  readonly sliceId: string;
  readonly parallelSafe: boolean;
  readonly conflictsWith: readonly string[];
  readonly sharedPaths: readonly string[];
}

interface PhaseGraphSignals {
  readonly phaseCount: number;
  readonly sliceCount: number;
  readonly dependencyEdgeCount: number;
  readonly sharedFileOverlapCount: number;
  readonly integrationCheckpointCount: number;
}

export interface PhaseGraph {
  readonly phases: readonly PhaseGraphPhase[];
  readonly slices: readonly PhaseGraphSlice[];
  readonly dependencyEdges: readonly { readonly from: string; readonly to: string }[];
  readonly sliceParallelSafety: readonly SliceParallelSafety[];
  readonly advisories: readonly ParallelSafetyAdvisory[];
  readonly signals: PhaseGraphSignals;
}

type SubExplorerRefusalReason =
  | "single_component"
  | "below_span_threshold"
  | "coupling_not_reduced"
  | "depth_cap";

interface PhaseSubExplorerAdvice {
  readonly phaseId: string;
  readonly advised: boolean;
  readonly count: number;
  readonly componentSliceIds: readonly (readonly string[])[];
  readonly reason?: SubExplorerRefusalReason;
  readonly conflictingPaths?: readonly string[];
}

export interface SubExplorerAdvice {
  readonly advised: boolean;
  readonly count: number;
  readonly launchAuthorized: false;
  readonly phases: readonly PhaseSubExplorerAdvice[];
  readonly reason?: SubExplorerRefusalReason;
}

export interface SubExplorerThresholds {
  readonly minComponentSlices?: number;
  readonly maxSlicesPerExplorer?: number;
  readonly currentDepth?: number;
}

function pairKey(left: number, right: number): string {
  return `${left}:${right}`;
}

function ownerIndex(values: readonly (readonly string[])[]): ReadonlyMap<string, readonly number[]> {
  const index = new Map<string, number[]>();
  values.forEach((items, owner) => {
    for (const item of new Set(items)) {
      const owners = index.get(item) ?? [];
      owners.push(owner);
      index.set(item, owners);
    }
  });
  return index;
}

function dependencyEdges(contract: ApprovedExecutionContract): readonly { readonly from: string; readonly to: string }[] {
  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string): void => {
    const key = `${from}\u0000${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ from, to });
    }
  };
  for (const slice of contract.slices) {
    for (const dependency of slice.dependsOn) add(dependency, slice.sliceId);
  }
  for (const edge of contract.dependencyEdges) add(edge.from, edge.to);
  return edges;
}

export function buildPhaseGraph(contract: ApprovedExecutionContract): PhaseGraph {
  const slices: PhaseGraphSlice[] = contract.slices.map((slice) => ({
    sliceId: slice.sliceId,
    phaseId: slice.phaseId,
    writeSet: [...slice.writeSet],
    sharedInterfaces: [...(slice.sharedInterfaces ?? [])],
    ...(slice.integrationBoundary ? { integrationBoundary: slice.integrationBoundary } : {}),
  }));
  const sliceIndex = new Map(slices.map((slice, index) => [slice.sliceId, index]));
  const edges = dependencyEdges(contract);
  const pathsByOwner = ownerIndex(slices.map((slice) => slice.writeSet));
  const interfacesByOwner = ownerIndex(slices.map((slice) => slice.sharedInterfaces));
  const conflicts = slices.map(() => new Set<number>());
  const pairPaths = new Map<string, Set<string>>();

  for (const [path, owners] of pathsByOwner) {
    for (let left = 0; left < owners.length; left += 1) {
      for (let right = left + 1; right < owners.length; right += 1) {
        const first = owners[left];
        const second = owners[right];
        conflicts[first].add(second);
        conflicts[second].add(first);
        const paths = pairPaths.get(pairKey(first, second)) ?? new Set<string>();
        paths.add(path);
        pairPaths.set(pairKey(first, second), paths);
      }
    }
  }
  for (const owners of interfacesByOwner.values()) {
    for (let left = 0; left < owners.length; left += 1) {
      for (let right = left + 1; right < owners.length; right += 1) {
        conflicts[owners[left]].add(owners[right]);
        conflicts[owners[right]].add(owners[left]);
      }
    }
  }

  const advisories = parallelSafetyAdvisories(contract);
  for (const advisory of advisories) {
    const left = sliceIndex.get(advisory.sliceIds[0]);
    const right = sliceIndex.get(advisory.sliceIds[1]);
    if (left !== undefined && right !== undefined) {
      conflicts[left].add(right);
      conflicts[right].add(left);
    }
  }

  const phaseDependencies = new Map(contract.phases.map((phase) => [phase.phaseId, new Set<string>()]));
  for (const edge of edges) {
    const dependency = slices[sliceIndex.get(edge.from)!];
    const dependent = slices[sliceIndex.get(edge.to)!];
    if (dependency.phaseId !== dependent.phaseId) {
      phaseDependencies.get(dependent.phaseId)?.add(dependency.phaseId);
    }
  }
  const phases: PhaseGraphPhase[] = contract.phases.map((phase) => {
    const phaseSlices = slices.filter((slice) => slice.phaseId === phase.phaseId);
    return {
      phaseId: phase.phaseId,
      sliceIds: phaseSlices.map((slice) => slice.sliceId),
      dependsOnPhases: [...(phaseDependencies.get(phase.phaseId) ?? [])],
      integrationBoundaries: [...new Set(
        phaseSlices.flatMap((slice) => slice.integrationBoundary ? [slice.integrationBoundary] : []),
      )],
      integrationCheckpointCount: phase.integrationCheckpointCount ?? 0,
    };
  });

  return deepFreeze({
    phases,
    slices,
    dependencyEdges: edges,
    sliceParallelSafety: slices.map((slice, index) => ({
      sliceId: slice.sliceId,
      parallelSafe: contract.slices[index].parallelSafe && conflicts[index].size === 0,
      conflictsWith: [...conflicts[index]].sort((left, right) => left - right).map((owner) => slices[owner].sliceId),
      sharedPaths: [...new Set([...conflicts[index]].flatMap((owner) =>
        [...(pairPaths.get(pairKey(Math.min(index, owner), Math.max(index, owner))) ?? [])],
      ))].sort(),
    })),
    advisories,
    signals: {
      phaseCount: phases.length,
      sliceCount: slices.length,
      dependencyEdgeCount: edges.length,
      sharedFileOverlapCount: [...pathsByOwner.values()].filter((owners) => owners.length > 1).length,
      integrationCheckpointCount: phases.reduce((sum, phase) => sum + phase.integrationCheckpointCount, 0),
    },
  });
}

class Components {
  private readonly parent = new Map<string, string>();
  private readonly size = new Map<string, number>();

  constructor(ids: readonly string[]) {
    for (const id of ids) {
      this.parent.set(id, id);
      this.size.set(id, 1);
    }
  }

  private find(id: string): string {
    const parent = this.parent.get(id)!;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.size.get(leftRoot)! < this.size.get(rightRoot)!) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.parent.set(rightRoot, leftRoot);
    this.size.set(leftRoot, this.size.get(leftRoot)! + this.size.get(rightRoot)!);
  }

  groups(ids: readonly string[]): readonly (readonly string[])[] {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const root = this.find(id);
      const members = groups.get(root) ?? [];
      members.push(id);
      groups.set(root, members);
    }
    return [...groups.values()];
  }
}

function coupling(
  graph: PhaseGraph,
  componentSliceIds: readonly (readonly string[])[],
): { readonly cross: number; readonly intra: number; readonly conflictingPaths: readonly string[] } {
  const component = new Map<string, number>();
  componentSliceIds.forEach((sliceIds, index) => sliceIds.forEach((sliceId) => component.set(sliceId, index)));
  const slices = graph.slices.filter((slice) => component.has(slice.sliceId));
  const facts = (slice: PhaseGraphSlice): SliceFacts => ({
    writeSet: slice.writeSet,
    interfaceTags: slice.sharedInterfaces,
    environmentTags: [],
    integrationBoundaryTags: slice.integrationBoundary === undefined ? [] : [slice.integrationBoundary],
    // Coupling measures overlap in declared facts, independently of the original safety claim.
    parallelSafe: true,
  });
  let cross = 0;
  let intra = 0;
  const conflictingPaths = new Set<string>();

  for (let left = 0; left < slices.length; left += 1) {
    for (let right = left + 1; right < slices.length; right += 1) {
      const first = slices[left];
      const second = slices[right];
      if (provenIndependent(facts(first), facts(second))) continue;
      const leftComponent = component.get(first.sliceId)!;
      const rightComponent = component.get(second.sliceId)!;
      if (leftComponent === rightComponent) {
        intra += 1;
        continue;
      }
      cross += 1;
      const leftPaths = new Set(first.writeSet);
      for (const path of second.writeSet) {
        if (leftPaths.has(path)) conflictingPaths.add(path);
      }
    }
  }

  return { cross, intra, conflictingPaths: [...conflictingPaths].sort() };
}

function phaseAdvice(
  graph: PhaseGraph,
  phase: PhaseGraphPhase,
  minComponentSlices: number,
  maxSlicesPerExplorer: number,
  currentDepth: number,
): PhaseSubExplorerAdvice {
  const ids = new Set(phase.sliceIds);
  const components = new Components(phase.sliceIds);
  for (const edge of graph.dependencyEdges) {
    if (ids.has(edge.from) && ids.has(edge.to)) components.union(edge.from, edge.to);
  }
  const groups = components.groups(phase.sliceIds);
  const qualifying = groups.filter((group) => group.length >= minComponentSlices);
  if (qualifying.length < 2) {
    return { phaseId: phase.phaseId, advised: false, count: 0, componentSliceIds: qualifying, reason: "single_component" };
  }
  if (phase.sliceIds.length <= maxSlicesPerExplorer && phase.integrationBoundaries.length < 2) {
    return { phaseId: phase.phaseId, advised: false, count: 0, componentSliceIds: qualifying, reason: "below_span_threshold" };
  }
  const retained = groups.filter((group) => group.length < minComponentSlices).flat();
  const measured = coupling(graph, retained.length ? [...qualifying, retained] : qualifying);
  if (measured.cross > 0 && measured.cross >= measured.intra) {
    return {
      phaseId: phase.phaseId,
      advised: false,
      count: 0,
      componentSliceIds: qualifying,
      reason: "coupling_not_reduced",
      conflictingPaths: measured.conflictingPaths,
    };
  }
  if (currentDepth + 2 > MAX_ORCHESTRATION_DEPTH) {
    return { phaseId: phase.phaseId, advised: false, count: 0, componentSliceIds: qualifying, reason: "depth_cap" };
  }
  return { phaseId: phase.phaseId, advised: true, count: qualifying.length, componentSliceIds: qualifying };
}

// Provisional OPEN-3.5 defaults; owner confirmation may replace these values in a later authorized slice.
const DEFAULT_MIN_COMPONENT_SLICES = 5;
const DEFAULT_MAX_SLICES_PER_EXPLORER = 20;

export function adviseSubExplorers(
  graph: PhaseGraph,
  thresholds: SubExplorerThresholds = {},
): SubExplorerAdvice {
  const phases = graph.phases.map((phase) => phaseAdvice(
    graph,
    phase,
    thresholds.minComponentSlices ?? DEFAULT_MIN_COMPONENT_SLICES,
    thresholds.maxSlicesPerExplorer ?? DEFAULT_MAX_SLICES_PER_EXPLORER,
    thresholds.currentDepth ?? MAX_ORCHESTRATION_DEPTH - 3,
  ));
  const count = phases.reduce((sum, phase) => sum + phase.count, 0);
  const firstReason = phases.find((phase) => phase.reason)?.reason;
  return deepFreeze({
    advised: count > 0,
    count,
    launchAuthorized: false,
    phases,
    ...(count === 0 && firstReason ? { reason: firstReason } : {}),
  });
}
