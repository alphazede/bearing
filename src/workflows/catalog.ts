import type { WorkGraph } from "../execution/execution-scheduler.js";

export const FICTIONAL_B2B_ROOT = "fixtures/fictional-b2b";

export interface WorkflowTask {
  readonly id: string;
  readonly role: "navigator" | "explorer" | "crewmate";
  readonly dependencies: readonly string[];
  readonly expectedArtifactIds: readonly string[];
}

export interface DecisionStop {
  readonly id: string;
  readonly beforeTaskId: string;
  readonly authorityRole: string;
  readonly decision: string;
  readonly requires: readonly string[];
}

export interface IndependentReview {
  readonly id: string;
  readonly kind: "survey" | "resurvey";
  readonly role: "surveyor";
  readonly independent: true;
  readonly executionAncestry: readonly [];
  readonly afterTaskIds: readonly string[];
  readonly expectedFindingIds: readonly string[];
  readonly expectedOutcome: "finding" | "pass";
}

export interface WorkflowDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly fixtureRoot: typeof FICTIONAL_B2B_ROOT;
  readonly executionPolicy: {
    readonly deterministic: true;
    readonly providers: "disabled";
    readonly writeScope: "fixture-copy-only";
  };
  readonly authorityRoles: readonly string[];
  readonly tasks: readonly WorkflowTask[];
  readonly decisionStops: readonly DecisionStop[];
  readonly expectedArtifacts: readonly { readonly id: string; readonly path: string }[];
  readonly criticalInvariants: readonly string[];
  readonly outcomeExpectations: readonly {
    readonly id: string;
    readonly status: "completed" | "duplicate" | "blocked" | "corrected" | "passed";
    readonly evidence?: readonly string[];
    readonly unresolvedOwner?: string;
  }[];
  readonly workGraph: WorkGraph;
  readonly reviews: readonly IndependentReview[];
}

const safety = {
  deterministic: true,
  providers: "disabled",
  writeScope: "fixture-copy-only",
} as const;

const node = (
  id: string,
  role: "navigator" | "explorer" | "crewmate",
  parentId: string | null,
  dependencies: readonly string[],
) => ({
  id,
  role,
  parentId,
  dependencies,
  sessionId: `fixture-${id}`,
  tool: "fixture-read-write",
  allowedTools: ["fixture-read-write"],
  profileId: "fictional-b2b",
  profileConcurrency: 3,
}) as const;

export const engineeringImportWorkflow = {
  schemaVersion: 1,
  id: "workflow.engineering-import.v1",
  name: "Engineering Import",
  purpose: "Safely import customer records through role approval, validation, dry run, duplicate handling, and an atomic result.",
  fixtureRoot: FICTIONAL_B2B_ROOT,
  executionPolicy: safety,
  authorityRoles: ["engineering-owner", "import-operator", "surveyor"],
  tasks: [
    { id: "eng.inspect", role: "explorer", dependencies: [], expectedArtifactIds: ["eng.change-plan"] },
    { id: "eng.validate", role: "crewmate", dependencies: ["eng.inspect"], expectedArtifactIds: ["eng.validation"] },
    { id: "eng.dry-run", role: "crewmate", dependencies: ["eng.validate"], expectedArtifactIds: ["eng.preview"] },
    { id: "eng.atomic-commit", role: "crewmate", dependencies: ["eng.dry-run"], expectedArtifactIds: ["eng.audit"] },
    { id: "eng.ui-result", role: "crewmate", dependencies: ["eng.atomic-commit"], expectedArtifactIds: ["eng.ui"] },
  ],
  decisionStops: [
    { id: "eng.stop.role-gate", beforeTaskId: "eng.inspect", authorityRole: "engineering-owner", decision: "authorize import-operator role", requires: ["work request"] },
    { id: "eng.stop.commit", beforeTaskId: "eng.atomic-commit", authorityRole: "engineering-owner", decision: "approve atomic fixture commit", requires: ["eng.validation", "eng.preview"] },
  ],
  expectedArtifacts: [
    { id: "eng.change-plan", path: "artifacts/engineering/change-plan.json" },
    { id: "eng.validation", path: "artifacts/engineering/validation.json" },
    { id: "eng.preview", path: "artifacts/engineering/dry-run.json" },
    { id: "eng.audit", path: "artifacts/engineering/audit.json" },
    { id: "eng.ui", path: "artifacts/engineering/ui-result.json" },
  ],
  criticalInvariants: [
    "malformed CSV blocks before mutation",
    "dry run never mutates customer state",
    "duplicate IDs are skipped and reported",
    "commit publishes customer state and audit together",
    "Surveyor has no execution ancestry",
  ],
  outcomeExpectations: [
    { id: "eng.imported", status: "completed", evidence: ["src/import-customers.mjs", "data/import.csv"] },
    { id: "eng.duplicate.acct-102", status: "duplicate", evidence: ["data/import.csv"] },
    { id: "eng.review", status: "passed", evidence: ["artifacts/engineering/ui-result.json", "artifacts/engineering/audit.json"] },
  ],
  workGraph: {
    schemaVersion: 1,
    executionMode: "explorer",
    limits: { maxNodes: 5, maxCrewmatesPerExplorer: 4 },
    nodes: [
      node("eng.inspect", "explorer", null, []),
      node("eng.validate", "crewmate", "eng.inspect", ["eng.inspect"]),
      node("eng.dry-run", "crewmate", "eng.inspect", ["eng.validate"]),
      node("eng.atomic-commit", "crewmate", "eng.inspect", ["eng.dry-run"]),
      node("eng.ui-result", "crewmate", "eng.inspect", ["eng.atomic-commit"]),
    ],
  },
  reviews: [{
    id: "review.engineering-import.survey.v1",
    kind: "survey",
    role: "surveyor",
    independent: true,
    executionAncestry: [],
    afterTaskIds: ["eng.ui-result"],
    expectedFindingIds: [],
    expectedOutcome: "pass",
  }],
} as const satisfies WorkflowDefinition;

export const launchReadinessWorkflow = {
  schemaVersion: 1,
  id: "workflow.launch-readiness.v1",
  name: "Launch Readiness",
  purpose: "Turn repository-backed product facts into a launch brief while stopping unsupported public claims for owner correction.",
  fixtureRoot: FICTIONAL_B2B_ROOT,
  executionPolicy: safety,
  authorityRoles: ["launch-owner", "navigator", "surveyor"],
  tasks: [
    { id: "launch.coordinate", role: "navigator", dependencies: [], expectedArtifactIds: ["launch.source-map"] },
    { id: "launch.brief-track", role: "explorer", dependencies: ["launch.coordinate"], expectedArtifactIds: ["launch.brief-draft"] },
    { id: "launch.brief", role: "crewmate", dependencies: ["launch.brief-track"], expectedArtifactIds: ["launch.brief-draft"] },
    { id: "launch.visual-track", role: "explorer", dependencies: ["launch.coordinate"], expectedArtifactIds: ["launch.infographic"] },
    { id: "launch.infographic", role: "crewmate", dependencies: ["launch.visual-track"], expectedArtifactIds: ["launch.infographic"] },
    { id: "launch.correct-promise", role: "crewmate", dependencies: ["launch.brief"], expectedArtifactIds: ["launch.corrected-brief"] },
  ],
  decisionStops: [
    { id: "launch.stop.publish-draft", beforeTaskId: "launch.brief", authorityRole: "launch-owner", decision: "approve draft generation", requires: ["launch.source-map"] },
    { id: "launch.stop.correct-promise", beforeTaskId: "launch.correct-promise", authorityRole: "launch-owner", decision: "approve correction of survey.finding.unsupported-40-percent", requires: ["survey.finding.unsupported-40-percent"] },
  ],
  expectedArtifacts: [
    { id: "launch.source-map", path: "artifacts/launch/source-map.json" },
    { id: "launch.brief-draft", path: "docs/launch-draft.json" },
    { id: "launch.infographic", path: "expected/infographic-inputs.json" },
    { id: "launch.corrected-brief", path: "expected/launch-brief.md" },
  ],
  criticalInvariants: [
    "every public claim has repository evidence or is labeled unsupported",
    "unsupported promise cannot survive approved remediation",
    "owner approval is explicit before correction",
    "Resurvey is independent and follows remediation",
  ],
  outcomeExpectations: [
    { id: "survey.finding.unsupported-40-percent", status: "blocked", evidence: ["docs/launch-draft.json"] },
    { id: "launch.promise-remediation", status: "corrected", evidence: ["expected/launch-brief.md"] },
    { id: "launch.resurvey", status: "passed", evidence: ["expected/launch-brief.md", "expected/infographic-inputs.json"] },
  ],
  workGraph: {
    schemaVersion: 1,
    executionMode: "expedition",
    limits: { maxNodes: 6, maxCrewmatesPerExplorer: 2 },
    nodes: [
      node("launch.coordinate", "navigator", null, []),
      node("launch.brief-track", "explorer", "launch.coordinate", ["launch.coordinate"]),
      node("launch.brief", "crewmate", "launch.brief-track", ["launch.brief-track"]),
      node("launch.visual-track", "explorer", "launch.coordinate", ["launch.coordinate"]),
      node("launch.infographic", "crewmate", "launch.visual-track", ["launch.visual-track"]),
      node("launch.correct-promise", "crewmate", "launch.brief-track", ["launch.brief"]),
    ],
  },
  reviews: [
    {
      id: "review.launch-readiness.survey.v1",
      kind: "survey",
      role: "surveyor",
      independent: true,
      executionAncestry: [],
      afterTaskIds: ["launch.brief", "launch.infographic"],
      expectedFindingIds: ["survey.finding.unsupported-40-percent"],
      expectedOutcome: "finding",
    },
    {
      id: "review.launch-readiness.resurvey.v1",
      kind: "resurvey",
      role: "surveyor",
      independent: true,
      executionAncestry: [],
      afterTaskIds: ["launch.correct-promise"],
      expectedFindingIds: [],
      expectedOutcome: "pass",
    },
  ],
} as const satisfies WorkflowDefinition;

export const dueDiligenceWorkflow = {
  schemaVersion: 1,
  id: "workflow.due-diligence.v1",
  name: "Due Diligence",
  purpose: "Answer material diligence questions only when repository evidence supports them and assign unresolved answers to an owner.",
  fixtureRoot: FICTIONAL_B2B_ROOT,
  executionPolicy: safety,
  authorityRoles: ["diligence-owner", "evidence-analyst", "surveyor"],
  tasks: [
    { id: "dd.inspect", role: "explorer", dependencies: [], expectedArtifactIds: ["dd.question-map"] },
    { id: "dd.trace", role: "crewmate", dependencies: ["dd.inspect"], expectedArtifactIds: ["dd.trace"] },
    { id: "dd.answer", role: "crewmate", dependencies: ["dd.trace"], expectedArtifactIds: ["dd.answers"] },
  ],
  decisionStops: [
    { id: "dd.stop.release", beforeTaskId: "dd.answer", authorityRole: "diligence-owner", decision: "release only evidence-backed answers", requires: ["dd.trace"] },
  ],
  expectedArtifacts: [
    { id: "dd.question-map", path: "docs/due-diligence-questions.json" },
    { id: "dd.trace", path: "artifacts/due-diligence/evidence-trace.json" },
    { id: "dd.answers", path: "expected/due-diligence.json" },
  ],
  criticalInvariants: [
    "answered material questions cite existing repository evidence",
    "unsupported answers remain blocked",
    "every blocked answer names an unresolved owner",
    "Surveyor has no execution ancestry",
  ],
  outcomeExpectations: [
    { id: "dd.product-capability", status: "completed", evidence: ["src/import-customers.mjs", "docs/product-facts.json"] },
    { id: "dd.security-certification", status: "blocked", unresolvedOwner: "Security Lead" },
    { id: "dd.retention", status: "blocked", unresolvedOwner: "Finance Lead" },
    { id: "dd.review", status: "passed", evidence: ["expected/due-diligence.json"] },
  ],
  workGraph: {
    schemaVersion: 1,
    executionMode: "explorer",
    limits: { maxNodes: 3, maxCrewmatesPerExplorer: 2 },
    nodes: [
      node("dd.inspect", "explorer", null, []),
      node("dd.trace", "crewmate", "dd.inspect", ["dd.inspect"]),
      node("dd.answer", "crewmate", "dd.inspect", ["dd.trace"]),
    ],
  },
  reviews: [{
    id: "review.due-diligence.survey.v1",
    kind: "survey",
    role: "surveyor",
    independent: true,
    executionAncestry: [],
    afterTaskIds: ["dd.answer"],
    expectedFindingIds: [],
    expectedOutcome: "pass",
  }],
} as const satisfies WorkflowDefinition;

export const fictionalB2bWorkflows = [
  engineeringImportWorkflow,
  launchReadinessWorkflow,
  dueDiligenceWorkflow,
] as const satisfies readonly WorkflowDefinition[];
