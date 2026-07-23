import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../src/evidence/evidence-ledger.js";
import { OUTCOME_CLASSES } from "../src/evidence/contracts.js";
import { ReportRenderer, renderLaunchReadinessSvg } from "../src/report/report-renderer.js";

function seeded(): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.recordEvidence({ id: "e1", kind: "artifact", summary: "Proof <safe>", href: "artifact.html", hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", textEquivalent: "Proof text", outcome: "passed" });
  return ledger;
}

describe("EvidenceLedger", () => {
  it("does not collapse outcome classes in the public projection", () => {
    const ledger = new EvidenceLedger();
    for (const [index, outcome] of OUTCOME_CLASSES.entries()) ledger.recordEvidence({ id: `e${index}`, kind: "receipt", summary: outcome, outcome });
    expect(ledger.projectPublic().evidence.map((entry) => entry.outcome)).toEqual(OUTCOME_CLASSES);
  });

  it("blocks duplicate, missing, unsupported, and self-certified records", () => {
    const ledger = seeded();
    expect(() => ledger.recordEvidence({ id: "e1", kind: "receipt", summary: "again", outcome: "passed" })).toThrow("duplicate_id");
    expect(() => ledger.recordClaim({ id: "c0", text: "missing", evidenceIds: ["no"], outcome: "blocked" })).toThrow("missing_evidence_reference");
    ledger.recordEvidence({ id: "missing", kind: "receipt", summary: "gone", outcome: "missing" });
    expect(() => ledger.recordClaim({ id: "c1", text: "unsupported", evidenceIds: ["missing"], outcome: "passed" })).toThrow("unsupported_claim");
    ledger.recordClaim({ id: "c2", text: "safe", evidenceIds: ["e1"], outcome: "passed" });
    expect(() => ledger.recordSurvey({ id: "s1", claimId: "c2", surveyorSessionId: "survey", certifiesSessionId: "survey", executionAncestry: [], outcome: "passed", summary: "no" })).toThrow("self_certification");
  });

  it("rejects loose, oversized, and unsafe boundary values", () => {
    const ledger = new EvidenceLedger();
    for (const unsafe of ["javascript:alert(1)", "data:text/plain,x", "file:x", "https://x", "//x", "/x", "a\\b", "a/../b", "a#x"]) expect(() => ledger.recordEvidence({ id: "e", kind: "receipt", summary: "safe", href: unsafe, outcome: "passed" })).toThrow("invalid_evidence");
    expect(() => ledger.recordEvidence({ id: "e", kind: "receipt", summary: "safe", outcome: "passed", extra: true } as never)).toThrow("invalid_evidence");
    expect(() => ledger.recordEvidence({ id: "e", kind: "receipt", summary: "x".repeat(4_097), outcome: "passed" })).toThrow("invalid_evidence");
    ledger.recordEvidence({ id: "e", kind: "receipt", summary: "safe", outcome: "passed" });
    expect(() => ledger.recordClaim({ id: "c", text: "claim", evidenceIds: Array.from({ length: 65 }, (_, index) => `e${index}`), outcome: "blocked" })).toThrow("invalid_claim");
    expect(() => ledger.recordEvidence({ id: "h", kind: "receipt", summary: "hash", hash: "sha256:1", outcome: "passed" })).toThrow("invalid_evidence");
    expect(() => ledger.recordEvidence({ id: "t", kind: "receipt", summary: "text", textEquivalent: "x".repeat(4_097), outcome: "passed" })).toThrow("invalid_evidence");
  });

  it.each(OUTCOME_CLASSES.filter((entry) => entry !== "passed"))("rejects %s evidence as success support", (outcome) => {
    const ledger = new EvidenceLedger(); ledger.recordEvidence({ id: "e", kind: "receipt", summary: outcome, outcome });
    expect(() => ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e"], outcome: "passed" })).toThrow("unsupported_claim");
    ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e"], outcome: "failed" });
    expect(() => ledger.recordSurvey({ id: "s", claimId: "c", surveyorSessionId: "surveyor", certifiesSessionId: "run", executionAncestry: [], outcome: "passed", summary: "pass" })).toThrow("unsupported_claim");
    ledger.recordSurvey({ id: "s", claimId: "c", surveyorSessionId: "surveyor", certifiesSessionId: "run", executionAncestry: [], outcome: "failed", summary: "fail" }); ledger.recordFinding({ id: "f", claimId: "c", surveyId: "s", summary: "fix", outcome: "failed" }); ledger.recordOwnerDecision({ id: "d", findingId: "f", decision: "approved", summary: "approved" });
    expect(() => ledger.recordRemediation({ id: "r", findingId: "f", decisionId: "d", summary: "fix", evidenceIds: ["e"] })).toThrow("invalid_remediation");
  });

  it("rejects mixed success support", () => {
    const ledger = seeded(); ledger.recordEvidence({ id: "failed", kind: "receipt", summary: "failed", outcome: "failed" });
    expect(() => ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1", "failed"], outcome: "passed" })).toThrow("unsupported_claim");
    ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1", "failed"], outcome: "failed" });
    expect(() => ledger.recordSurvey({ id: "s", claimId: "c", surveyorSessionId: "surveyor", certifiesSessionId: "run", executionAncestry: [], outcome: "passed", summary: "pass" })).toThrow("unsupported_claim");
  });

  it("rejects every non-empty survey ancestry", () => {
    const ledger = seeded(); ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1"], outcome: "passed" });
    expect(() => ledger.recordSurvey({ id: "s", claimId: "c", surveyorSessionId: "surveyor", certifiesSessionId: "run", executionAncestry: ["unrelated-session"], outcome: "passed", summary: "no" })).toThrow("invalid_survey");
  });

  it("accepts initial Surveys for separate claims and rejects an initial remediation", () => {
    const ledger = seeded(); ledger.recordEvidence({ id: "e2", kind: "receipt", summary: "second", outcome: "passed" }); ledger.recordClaim({ id: "c1", text: "first", evidenceIds: ["e1"], outcome: "passed" }); ledger.recordClaim({ id: "c2", text: "second", evidenceIds: ["e2"], outcome: "passed" });
    ledger.recordSurvey({ id: "s1", claimId: "c1", surveyorSessionId: "one", certifiesSessionId: "run", executionAncestry: [], outcome: "passed", summary: "first" }); ledger.recordSurvey({ id: "s2", claimId: "c2", surveyorSessionId: "two", certifiesSessionId: "run", executionAncestry: [], outcome: "passed", summary: "second" });
    expect(ledger.projectPublic().surveys.map((survey) => survey.id)).toEqual(["s1", "s2"]);
    const initial = seeded(); initial.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1"], outcome: "passed" });
    expect(() => initial.recordSurvey({ id: "s", claimId: "c", surveyorSessionId: "surveyor", certifiesSessionId: "run", executionAncestry: [], remediationId: "r", outcome: "failed", summary: "invalid" })).toThrow("resurvey_requires_remediation");
  });

  it("retains remediation and resurvey history", () => {
    const ledger = seeded(); ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1"], outcome: "passed" });
    ledger.recordSurvey({ id: "s1", claimId: "c", surveyorSessionId: "survey-1", certifiesSessionId: "run", executionAncestry: [], outcome: "failed", summary: "finding" });
    ledger.recordFinding({ id: "f", claimId: "c", surveyId: "s1", summary: "fix", outcome: "failed" });
    ledger.recordOwnerDecision({ id: "d", findingId: "f", decision: "approved", summary: "approved" });
    ledger.recordRemediation({ id: "r", findingId: "f", decisionId: "d", summary: "fixed", evidenceIds: ["e1"] });
    ledger.recordSurvey({ id: "s2", claimId: "c", surveyorSessionId: "survey-2", certifiesSessionId: "run", executionAncestry: [], remediationId: "r", outcome: "passed", summary: "passed" });
    expect(ledger.projectPublic().surveys.map((survey) => survey.id)).toEqual(["s1", "s2"]);
  });

  it("requires a failed survey, supported remediation, and an independent resurvey", () => {
    const ledger = seeded(); ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1"], outcome: "passed" });
    ledger.recordSurvey({ id: "s1", claimId: "c", surveyorSessionId: "one", certifiesSessionId: "run", executionAncestry: [], outcome: "passed", summary: "passed" });
    expect(() => ledger.recordFinding({ id: "f", claimId: "c", surveyId: "s1", summary: "no", outcome: "failed" })).toThrow("invalid_finding");
    const failed = new EvidenceLedger(); failed.recordEvidence({ id: "missing", kind: "receipt", summary: "gone", outcome: "missing" }); failed.recordEvidence({ id: "e", kind: "receipt", summary: "proof", outcome: "passed" }); failed.recordClaim({ id: "c", text: "claim", evidenceIds: ["e"], outcome: "passed" }); failed.recordSurvey({ id: "s1", claimId: "c", surveyorSessionId: "one", certifiesSessionId: "run", executionAncestry: [], outcome: "failed", summary: "failed" }); failed.recordFinding({ id: "f", claimId: "c", surveyId: "s1", summary: "fix", outcome: "failed" }); failed.recordOwnerDecision({ id: "d", findingId: "f", decision: "approved", summary: "yes" });
    expect(() => failed.recordRemediation({ id: "r", findingId: "f", decisionId: "d", summary: "bad", evidenceIds: ["missing"] })).toThrow("invalid_remediation");
    failed.recordRemediation({ id: "r", findingId: "f", decisionId: "d", summary: "fixed", evidenceIds: ["e"] });
    expect(() => failed.recordSurvey({ id: "s2", claimId: "c", surveyorSessionId: "one", certifiesSessionId: "run", executionAncestry: [], remediationId: "r", outcome: "passed", summary: "again" })).toThrow("resurvey_requires_remediation");
  });

  it("replaces artifacts backed by redacted evidence", () => {
    const ledger = new EvidenceLedger(); ledger.recordEvidence({ id: "e", kind: "artifact", summary: "secret name", href: "proof.txt", textEquivalent: "secret text", outcome: "redacted" }); ledger.recordArtifact({ id: "a", evidenceId: "e", name: "secret.bin", mediaType: "application/octet-stream", textEquivalent: "secret payload" });
    const artifact = ledger.projectPublic().artifacts[0]; expect(artifact).toMatchObject({ name: "Redacted artifact", mediaType: "text/plain", textEquivalent: "Redacted artifact" }); expect(JSON.stringify(artifact)).not.toContain("secret");
  });
});

describe("ReportRenderer", () => {
  it("escapes content and remains deterministic and offline", () => {
    const ledger = seeded(); ledger.recordEvidence({ id: "secret", kind: "receipt", summary: "<script>bad</script>", href: "secret.txt", hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outcome: "redacted" });
    ledger.recordClaim({ id: "c1", text: "claim <img>", evidenceIds: ["e1"], outcome: "passed" });
    const projection = ledger.projectPublic(); const html = new ReportRenderer().render(projection);
    expect(html).toContain("&lt;img&gt;"); expect(html).not.toContain("<script>bad</script>"); expect(html).not.toContain("https://example.test/secret");
    expect(html).not.toMatch(/<script|(?:src|href)="https?:\/\/|cdn/i); expect(renderLaunchReadinessSvg(projection.claims)).toContain("c1");
    expect(new ReportRenderer().render(projection)).toBe(html);
  });

  it("bounds SVG output and rejects unvalidated report data", () => {
    const ledger = seeded(); for (let index = 0; index < 20; index++) ledger.recordClaim({ id: `c${index}`, text: "claim", evidenceIds: ["e1"], outcome: "passed" });
    expect(renderLaunchReadinessSvg(ledger.projectPublic().claims)).toContain('viewBox="0 0 720 360"');
    expect(() => new ReportRenderer().render({ evidence: [], artifacts: [], claims: [], findings: [], decisions: [], remediations: [], surveys: [], extra: true } as never)).toThrow("invalid_public_ledger");
  });

  it("rejects forged public-ledger relationships", () => {
    const ledger = seeded(); ledger.recordEvidence({ id: "failed", kind: "receipt", summary: "failed", outcome: "failed" }); ledger.recordClaim({ id: "c", text: "claim", evidenceIds: ["e1"], outcome: "passed" }); ledger.recordSurvey({ id: "s", claimId: "c", surveyorSessionId: "surveyor", certifiesSessionId: "run", executionAncestry: [], outcome: "failed", summary: "failed" }); ledger.recordFinding({ id: "f", claimId: "c", surveyId: "s", summary: "fix", outcome: "failed" }); ledger.recordOwnerDecision({ id: "d", findingId: "f", decision: "approved", summary: "approved" }); ledger.recordRemediation({ id: "r", findingId: "f", decisionId: "d", summary: "fixed", evidenceIds: ["e1"] }); ledger.recordSurvey({ id: "s2", claimId: "c", surveyorSessionId: "resurveyor", certifiesSessionId: "run", executionAncestry: [], remediationId: "r", outcome: "passed", summary: "passed" });
    const projection = ledger.projectPublic(), render = (change: (value: any) => void) => { const forged: any = structuredClone(projection); change(forged); expect(() => new ReportRenderer().render(forged)).toThrow("invalid_public_ledger"); };
    render((value) => { value.claims[0].evidenceIds = ["e1", "failed"]; });
    render((value) => { value.claims[0].evidenceIds = ["missing"]; });
    render((value) => { value.findings[0].surveyId = "s2"; });
    render((value) => { value.remediations[0].decisionId = "missing"; });
    render((value) => { value.remediations[0].evidenceIds = ["failed"]; });
    render((value) => { value.surveys[1].executionAncestry = ["run"]; });
    render((value) => { value.surveys[1].certifiesSessionId = "resurveyor"; });
    render((value) => { value.surveys[1].surveyorSessionId = "surveyor"; });
    render((value) => { value.surveys[0].remediationId = "r"; });
    render((value) => { value.artifacts.push({ id: "a", evidenceId: "missing", name: "artifact", mediaType: "text/plain", textEquivalent: "artifact" }); });
    render((value) => { value.evidence[0] = { ...value.evidence[0], summary: "Redacted evidence", href: undefined, hash: undefined, textEquivalent: "Redacted evidence", outcome: "redacted" }; value.artifacts.push({ id: "a", evidenceId: "e1", name: "secret", mediaType: "text/plain", textEquivalent: "secret" }); });
    render((value) => { value.evidence.push({ ...value.evidence[0] }); });
  });

  it("validates direct SVG claims before bounding rows", () => {
    const claim = { id: "c", text: "claim", evidenceIds: ["e"], outcome: "passed" } as const;
    expect(() => renderLaunchReadinessSvg([{ id: "c" }] as never)).toThrow("invalid_public_claims");
    expect(() => renderLaunchReadinessSvg([{ ...claim, extra: true }] as never)).toThrow("invalid_public_claims");
    expect(() => renderLaunchReadinessSvg([{ ...claim, text: "x".repeat(4_097) }])).toThrow("invalid_public_claims");
    expect(() => renderLaunchReadinessSvg(Array.from({ length: 1_001 }, (_, index) => ({ ...claim, id: `c${index}` })))).toThrow("invalid_public_claims");
  });
});
