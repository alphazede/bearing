import { createHash } from "node:crypto";
import type { PublicLedger } from "../evidence/contracts.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import { ReportRenderer } from "../report/report-renderer.js";
import { fictionalB2bWorkflows, type WorkflowDefinition } from "./catalog.js";

export const MAX_WORKFLOW_ID = 64;
export const MAX_SHOWCASE_JSON = 640 * 1024;
export const MAX_SHOWCASE_REPORT = 128 * 1024;
export const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;

export interface WorkflowShowcase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly executionMode: "explorer" | "expedition";
  readonly executionPolicy: WorkflowDefinition["executionPolicy"];
  readonly authorityRoles: WorkflowDefinition["authorityRoles"];
  readonly decisionStops: WorkflowDefinition["decisionStops"];
  readonly expectedArtifacts: WorkflowDefinition["expectedArtifacts"];
  readonly outcomeExpectations: WorkflowDefinition["outcomeExpectations"];
  readonly reviews: WorkflowDefinition["reviews"];
  readonly evidence: PublicLedger;
}

const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const frozenCopy = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) frozenCopy(child);
    Object.freeze(value);
  }
  return value;
};

function engineeringLedger(): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.recordEvidence({ id: "eng.role-gate", kind: "receipt", summary: "Engineering owner authorized the import-operator role.", outcome: "passed" });
  ledger.recordEvidence({ id: "eng.dry-run", kind: "observation", summary: "Dry run validated two new records and skipped duplicate acct-102 without mutation.", outcome: "passed" });
  ledger.recordEvidence({ id: "eng.atomic-result", kind: "artifact", summary: "Customer state and audit result were published atomically.", href: "expected/engineering-import.json", hash: hash("2 imported; acct-102 duplicate; atomic commit"), textEquivalent: "2 records imported; duplicate acct-102 skipped; customer state and audit published together.", outcome: "passed" });
  ledger.recordArtifact({ id: "eng.import-preview", evidenceId: "eng.atomic-result", name: "Engineering import result", mediaType: "application/json", textEquivalent: "Role gate passed. Dry run completed. Two records imported. Duplicate acct-102 skipped. Atomic result recorded." });
  ledger.recordClaim({ id: "eng.import-claim", text: "The import honored its role gate, dry run, duplicate policy, and atomic result.", evidenceIds: ["eng.role-gate", "eng.dry-run", "eng.atomic-result"], outcome: "passed" });
  ledger.recordSurvey({ id: "eng.survey", claimId: "eng.import-claim", surveyorSessionId: "eng-surveyor", certifiesSessionId: "eng-run", executionAncestry: [], outcome: "passed", summary: "Independent Survey verified the import evidence and atomic result." });
  return ledger;
}

function launchLedger(): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.recordEvidence({ id: "launch.unsupported-draft", kind: "artifact", summary: "Draft claimed a 40 percent setup-time reduction without repository support.", href: "docs/launch-draft.json", textEquivalent: "Unsupported draft promise: setup time reduced by 40 percent.", outcome: "model-asserted" });
  ledger.recordEvidence({ id: "launch.corrected-brief", kind: "artifact", summary: "Approved remediation removed the unsupported percentage and retained supported product facts.", href: "expected/launch-brief.md", hash: hash("corrected launch brief without unsupported percentage"), textEquivalent: "Corrected launch brief contains no unsupported percentage promise.", outcome: "passed" });
  ledger.recordEvidence({ id: "launch.infographic", kind: "artifact", summary: "Infographic inputs contain only repository-backed product facts.", href: "expected/infographic-inputs.json", hash: hash("repository-backed infographic inputs"), textEquivalent: "Launch infographic inputs: CSV import, duplicate detection, and dry-run preview.", outcome: "passed" });
  ledger.recordArtifact({ id: "launch.brief-preview", evidenceId: "launch.corrected-brief", name: "Corrected launch brief", mediaType: "text/markdown", textEquivalent: "A launch brief corrected after owner-approved remediation; the unsupported 40 percent promise is absent." });
  ledger.recordClaim({ id: "launch.promise", text: "The launch brief is suitable for evidence-backed publication.", evidenceIds: ["launch.corrected-brief"], outcome: "deviated" });
  ledger.recordSurvey({ id: "launch.survey", claimId: "launch.promise", surveyorSessionId: "launch-surveyor-1", certifiesSessionId: "launch-run", executionAncestry: [], outcome: "failed", summary: "Survey blocked the unsupported 40 percent marketing promise." });
  ledger.recordFinding({ id: "survey.finding.unsupported-40-percent", claimId: "launch.promise", surveyId: "launch.survey", summary: "The 40 percent setup-time promise has no repository evidence.", outcome: "blocked" });
  ledger.recordOwnerDecision({ id: "launch.owner-correction", findingId: "survey.finding.unsupported-40-percent", decision: "approved", summary: "Launch Owner approved removal of the unsupported promise." });
  ledger.recordRemediation({ id: "launch.promise-remediation", findingId: "survey.finding.unsupported-40-percent", decisionId: "launch.owner-correction", summary: "Removed the percentage claim and retained supported facts.", evidenceIds: ["launch.corrected-brief"] });
  ledger.recordSurvey({ id: "launch.resurvey", claimId: "launch.promise", surveyorSessionId: "launch-surveyor-2", certifiesSessionId: "launch-run", executionAncestry: [], remediationId: "launch.promise-remediation", outcome: "passed", summary: "Independent Resurvey passed the corrected brief." });
  return ledger;
}

function dueDiligenceLedger(): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.recordEvidence({ id: "dd.product-proof", kind: "artifact", summary: "Repository sources support the documented import capabilities.", href: "docs/product-facts.json", hash: hash("documented import capabilities"), textEquivalent: "Product capability is supported by repository implementation and product facts.", outcome: "passed" });
  ledger.recordEvidence({ id: "dd.security-gap", kind: "receipt", summary: "No security certification evidence exists in the fixture.", textEquivalent: "Security certification answer is blocked; unresolved owner is Security Lead.", outcome: "unresolved-owner" });
  ledger.recordEvidence({ id: "dd.retention-gap", kind: "receipt", summary: "No retention schedule evidence exists in the fixture.", textEquivalent: "Retention answer is blocked; unresolved owner is Finance Lead.", outcome: "unresolved-owner" });
  ledger.recordEvidence({ id: "dd.answers", kind: "artifact", summary: "Diligence output separates supported and blocked answers.", href: "expected/due-diligence.json", hash: hash("supported product answer; blocked security and retention answers"), textEquivalent: "Product capability answered with evidence. Security certification and retention remain blocked with named owners.", outcome: "passed" });
  ledger.recordArtifact({ id: "dd.answers-preview", evidenceId: "dd.answers", name: "Due diligence answers", mediaType: "application/json", textEquivalent: "Supported: product capability. Blocked: security certification, owner Security Lead; retention, owner Finance Lead." });
  ledger.recordClaim({ id: "dd.product-capability", text: "The product capability answer is supported by repository evidence.", evidenceIds: ["dd.product-proof"], outcome: "passed" });
  ledger.recordClaim({ id: "dd.security-certification", text: "A security certification can be asserted.", evidenceIds: ["dd.security-gap"], outcome: "blocked", owner: "Security Lead" });
  ledger.recordClaim({ id: "dd.retention", text: "A retention schedule can be asserted.", evidenceIds: ["dd.retention-gap"], outcome: "blocked", owner: "Finance Lead" });
  ledger.recordSurvey({ id: "dd.survey", claimId: "dd.product-capability", surveyorSessionId: "dd-surveyor", certifiesSessionId: "dd-run", executionAncestry: [], outcome: "passed", summary: "Independent Survey verified supported answers and preserved unsupported answers as blocked." });
  return ledger;
}

const ledgerFor = (id: string): EvidenceLedger => {
  if (id === "workflow.engineering-import.v1") return engineeringLedger();
  if (id === "workflow.launch-readiness.v1") return launchLedger();
  if (id === "workflow.due-diligence.v1") return dueDiligenceLedger();
  throw new Error("unknown_workflow");
};

const publicDefinition = (workflow: WorkflowDefinition) => frozenCopy(structuredClone({
  id: workflow.id,
  name: workflow.name,
  purpose: workflow.purpose,
  executionMode: workflow.workGraph.executionMode,
  executionPolicy: workflow.executionPolicy,
  authorityRoles: workflow.authorityRoles,
  decisionStops: workflow.decisionStops,
  expectedArtifacts: workflow.expectedArtifacts,
  outcomeExpectations: workflow.outcomeExpectations,
  reviews: workflow.reviews,
}));

export const listWorkflowShowcases = () => Object.freeze(fictionalB2bWorkflows.map(publicDefinition));

export function projectWorkflowShowcase(id: string): WorkflowShowcase | null {
  if (!WORKFLOW_ID.test(id) || id.length > MAX_WORKFLOW_ID) return null;
  const workflow = fictionalB2bWorkflows.find((entry) => entry.id === id);
  if (!workflow) return null;
  return frozenCopy({
    schemaVersion: 1,
    ...publicDefinition(workflow),
    evidence: ledgerFor(workflow.id).projectPublic(),
  });
}

export function renderWorkflowReport(id: string): string | null {
  const projection = projectWorkflowShowcase(id);
  return projection ? new ReportRenderer().render(projection.evidence, projection.name) : null;
}
