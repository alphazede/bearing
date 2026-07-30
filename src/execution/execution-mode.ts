/**
 * Execution-mode recommendation, versioned by the algorithm recorded in the
 * event that carries it (design §3.2).
 *
 * FREEZE RULE (append-only, durable). `recommendExecutionModeV1` and
 * `recommendExecutionModeV2` are never edited once merged, and neither is
 * `SELECTION_WEIGHTS_V2` in ./selection-score.ts. Replay re-derives a recorded
 * recommendation with the version the event names, so changing a trigger, a band
 * boundary or a weight in place would rewrite the meaning of every historical
 * event and make recorded runs unopenable. A change ships as `algorithmVersion:
 * 3` with a new function beside these. This is the durable reason the replay
 * guarantee survives later phases.
 */
import { complexityScore, firedHardTriggers, type HardTriggerId, type SelectionSignals } from "./selection-score.js";

export const EXECUTION_MODES = ["explorer", "expedition"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Orchestration is an executor role inside a mode, never a mode. `trail-boss`
 * is legal only alongside `recommendedMode: "expedition"`.
 */
export const EXECUTION_ORCHESTRATIONS = ["explorer", "trail-boss"] as const;
export type ExecutionOrchestration = (typeof EXECUTION_ORCHESTRATIONS)[number];

export interface ModeRecommendationInput {
  readonly workItems: number;
  readonly maxCrewmatesPerExplorer: number;
  readonly perAgentTokenEstimate: number;
  readonly overrideMode?: ExecutionMode;
}

export interface ModeRecommendation {
  readonly recommendedMode: ExecutionMode;
  readonly selectedMode: ExecutionMode;
  readonly overridden: boolean;
  readonly estimatedAgents: number;
  readonly estimatedTokens: number;
  readonly tradeoffs: { readonly tokens: string; readonly coordination: string };
  readonly launchAuthorized: false;
}

export interface ModeRecommendationV2 extends ModeRecommendation {
  readonly algorithmVersion: 2;
  readonly complexityScore: number;
  readonly firedHardTriggers: readonly HardTriggerId[];
  readonly recommendedOrchestration: ExecutionOrchestration;
}

/** Kept for every existing caller: the exported facade is version 1. */
export function recommendExecutionMode(input: ModeRecommendationInput): ModeRecommendation {
  return recommendExecutionModeV1(input);
}

/** FROZEN. Behaviour of the pre-Phase-3 selection rule, verbatim. */
export function recommendExecutionModeV1(input: ModeRecommendationInput): ModeRecommendation {
  if (![input.workItems, input.maxCrewmatesPerExplorer, input.perAgentTokenEstimate].every((value) => Number.isSafeInteger(value) && value > 0) || (input.overrideMode !== undefined && !EXECUTION_MODES.includes(input.overrideMode))) throw new TypeError("invalid recommendation input");
  const recommendedMode: ExecutionMode = input.workItems <= input.maxCrewmatesPerExplorer ? "explorer" : "expedition";
  const selectedMode = input.overrideMode ?? recommendedMode;
  const explorers = selectedMode === "explorer" ? 1 : Math.ceil(input.workItems / input.maxCrewmatesPerExplorer);
  const estimatedAgents = input.workItems + explorers + (selectedMode === "expedition" ? 1 : 0);
  return {
    recommendedMode, selectedMode, overridden: selectedMode !== recommendedMode, estimatedAgents,
    estimatedTokens: estimatedAgents * input.perAgentTokenEstimate,
    tradeoffs: selectedMode === "explorer"
      ? { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }
      : { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" },
    launchAuthorized: false,
  };
}

/**
 * FROZEN once merged. Hard triggers and the complexity score of design §3.3-§3.4,
 * with version 1's fan-out rule surviving as the mode fallback, so version 2 is a
 * strict superset of version 1's mode behaviour.
 *
 * The input guard is deliberately not shared with version 1: the freeze rule
 * requires each version to keep its own validation forever, even when a later
 * version tightens it.
 */
export function recommendExecutionModeV2(input: ModeRecommendationInput, signals: SelectionSignals): ModeRecommendationV2 {
  if (![input.workItems, input.maxCrewmatesPerExplorer, input.perAgentTokenEstimate].every((value) => Number.isSafeInteger(value) && value > 0) || (input.overrideMode !== undefined && !EXECUTION_MODES.includes(input.overrideMode))) throw new TypeError("invalid recommendation input");
  const fired = firedHardTriggers(signals);
  const score = complexityScore(signals);
  const trailBoss = fired.length > 0 || score >= signals.threshold;
  const recommendedOrchestration: ExecutionOrchestration = trailBoss ? "trail-boss" : "explorer";
  const recommendedMode: ExecutionMode = trailBoss ? "expedition" : (input.workItems <= input.maxCrewmatesPerExplorer ? "explorer" : "expedition");
  const selectedMode = input.overrideMode ?? recommendedMode;
  const explorers = selectedMode === "explorer" ? 1 : Math.ceil(input.workItems / input.maxCrewmatesPerExplorer);
  // The coordination cost of the extra layer lands in the number the owner already sees.
  const estimatedAgents = input.workItems + explorers + signals.subExplorerCount
    + (selectedMode === "expedition" ? 1 : 0)
    + (recommendedOrchestration === "trail-boss" ? 1 : 0);
  return {
    algorithmVersion: 2, complexityScore: score, firedHardTriggers: fired, recommendedOrchestration,
    recommendedMode, selectedMode, overridden: selectedMode !== recommendedMode, estimatedAgents,
    estimatedTokens: estimatedAgents * input.perAgentTokenEstimate,
    tradeoffs: selectedMode === "explorer"
      ? { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }
      : { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" },
    launchAuthorized: false,
  };
}
