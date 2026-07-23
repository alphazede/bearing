/** Bounded, public-safe proof records. Values are copied by EvidenceLedger. */
export const OUTCOME_CLASSES = ["passed", "failed", "blocked", "unperformed", "missing", "deleted", "redacted", "model-asserted", "deviated", "unresolved-owner"] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

export interface Evidence { readonly id: string; readonly kind: "observation" | "receipt" | "artifact"; readonly summary: string; readonly href?: string; readonly hash?: string; readonly textEquivalent?: string; readonly outcome: OutcomeClass; }
export interface Artifact { readonly id: string; readonly evidenceId: string; readonly name: string; readonly mediaType: string; readonly textEquivalent: string; }
export interface Claim { readonly id: string; readonly text: string; readonly evidenceIds: readonly string[]; readonly outcome: OutcomeClass; readonly owner?: string; }
export interface Finding { readonly id: string; readonly claimId: string; readonly surveyId: string; readonly summary: string; readonly outcome: "failed" | "blocked" | "deviated"; }
export interface OwnerDecision { readonly id: string; readonly findingId: string; readonly decision: "approved" | "rejected" | "deferred"; readonly summary: string; }
export interface Remediation { readonly id: string; readonly findingId: string; readonly decisionId: string; readonly summary: string; readonly evidenceIds: readonly string[]; }
export interface Survey { readonly id: string; readonly claimId: string; readonly surveyorSessionId: string; readonly executionAncestry: readonly string[]; readonly certifiesSessionId: string; readonly outcome: OutcomeClass; readonly remediationId?: string; readonly summary: string; }

export interface PublicEvidence extends Omit<Evidence, "summary" | "href" | "hash" | "textEquivalent"> { readonly summary: string; readonly href?: string; readonly hash?: string; readonly textEquivalent: string; }
export interface PublicLedger { readonly evidence: readonly PublicEvidence[]; readonly artifacts: readonly Artifact[]; readonly claims: readonly Claim[]; readonly findings: readonly Finding[]; readonly decisions: readonly OwnerDecision[]; readonly remediations: readonly Remediation[]; readonly surveys: readonly Survey[]; }
