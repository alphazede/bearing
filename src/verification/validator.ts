import type { CommandEvidence, FocusCompletion } from "../journey/focus-mode.js";

export type ValidatorVerdict = "PASS" | "NEEDS_MORE_EVIDENCE" | "FAIL";
export type ValidatorEscalation = "none" | "re_execute_slice" | "park_ranger_gate" | "owner_decision_required";

export type FocusCompletionReason = Extract<FocusCompletion, { readonly ok: false }>["reason"];
export type ValidatorSufficiencyReason =
  | "slice_unvalidated"
  | "requirement_unproven"
  | "evidence_command_uncovered"
  | "unsupported_readiness_claim";
export type ValidatorReason = FocusCompletionReason | ValidatorSufficiencyReason;

export interface ValidatorScopeSlice {
  readonly sliceId: string;
  readonly requirementIds: readonly string[];
  readonly evidenceCommandIds: readonly string[];
  readonly completion?: FocusCompletion;
  readonly evidence: readonly CommandEvidence[];
}

export interface ValidatorReadinessClaim {
  readonly text: string;
  readonly sliceIds: readonly string[];
}

export interface ValidatorScope {
  readonly slices: readonly ValidatorScopeSlice[];
  readonly readinessClaims: readonly ValidatorReadinessClaim[];
}

export interface ValidatorReport {
  readonly verdict: ValidatorVerdict;
  readonly reasons: readonly ValidatorReason[];
  readonly escalation: ValidatorEscalation;
}

export const INHERITED_REASON_VERDICTS: Readonly<Record<FocusCompletionReason, ValidatorVerdict>> = {
  path_outside_write_set: "FAIL",
  no_product_change: "FAIL",
  git_state: "FAIL",
  artifact_missing: "NEEDS_MORE_EVIDENCE",
  // A declared artifact that never changed is a false claim about the work, not a gap in the
  // evidence, so it fails outright rather than asking for more.
  artifact_unchanged: "FAIL",
  // A declared command that ran and failed is a broken build, not missing evidence.
  command_regressed: "FAIL",
  evidence_invalid: "NEEDS_MORE_EVIDENCE",
};

const REASON_VERDICTS: Readonly<Record<ValidatorReason, ValidatorVerdict>> = {
  ...INHERITED_REASON_VERDICTS,
  slice_unvalidated: "NEEDS_MORE_EVIDENCE",
  requirement_unproven: "NEEDS_MORE_EVIDENCE",
  evidence_command_uncovered: "NEEDS_MORE_EVIDENCE",
  unsupported_readiness_claim: "FAIL",
};

export function composeValidatorVerdict(reasons: readonly ValidatorReason[]): ValidatorVerdict {
  if (reasons.some((reason) => REASON_VERDICTS[reason] === "FAIL")) return "FAIL";
  if (reasons.some((reason) => REASON_VERDICTS[reason] === "NEEDS_MORE_EVIDENCE")) return "NEEDS_MORE_EVIDENCE";
  return "PASS";
}

export function deriveValidatorEscalation(
  verdict: ValidatorVerdict,
  reasons: readonly ValidatorReason[],
): ValidatorEscalation {
  if (verdict === "PASS") return "none";
  if (verdict === "NEEDS_MORE_EVIDENCE") return "re_execute_slice";
  if (reasons.some((reason) => reason === "git_state" || reason === "unsupported_readiness_claim")) {
    return "owner_decision_required";
  }
  return "park_ranger_gate";
}

export function validateScope(scope: ValidatorScope): ValidatorReport {
  const reasons: ValidatorReason[] = [];
  const addReason = (reason: ValidatorReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (scope.slices.length === 0) addReason("slice_unvalidated");
  for (const slice of scope.slices) {
    if (!slice.completion) addReason("slice_unvalidated");
    else if (!slice.completion.ok) addReason(slice.completion.reason);
  }

  const provenRequirements = new Set(
    scope.slices
      .filter((slice) => slice.completion?.ok === true)
      .flatMap((slice) => slice.requirementIds),
  );
  if (scope.slices.some((slice) => slice.requirementIds.some((id) => !provenRequirements.has(id)))) {
    addReason("requirement_unproven");
  }

  const passedCommands = new Set(
    scope.slices.flatMap((slice) => slice.evidence.filter((item) => item.status === "passed").map((item) => item.commandId)),
  );
  const scopeHasUncoveredCommand = scope.slices.some(
    (slice) => slice.evidenceCommandIds.some((id) => !passedCommands.has(id)),
  );
  const sliceHasUncoveredCommand = scope.slices.some((slice) => {
    const slicePassedCommands = new Set(
      slice.evidence.filter((item) => item.status === "passed").map((item) => item.commandId),
    );
    return slice.evidenceCommandIds.some((id) => !slicePassedCommands.has(id));
  });
  if (scopeHasUncoveredCommand || sliceHasUncoveredCommand) {
    addReason("evidence_command_uncovered");
  }

  const completedSliceIds = new Set(
    scope.slices.filter((slice) => slice.completion?.ok === true).map((slice) => slice.sliceId),
  );
  if (scope.readinessClaims.some((claim) =>
    claim.sliceIds.length === 0 || claim.sliceIds.some((id) => !completedSliceIds.has(id)))) {
    addReason("unsupported_readiness_claim");
  }

  const verdict = composeValidatorVerdict(reasons);
  return { verdict, reasons, escalation: deriveValidatorEscalation(verdict, reasons) };
}
