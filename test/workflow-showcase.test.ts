import { describe, expect, it } from "vitest";
import { listWorkflowShowcases, projectWorkflowShowcase, renderWorkflowReport } from "../src/workflows/showcase.js";

describe("deterministic workflow showcase projections", () => {
  it("lists exactly the three catalog workflows", () => {
    expect(listWorkflowShowcases().map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "workflow.engineering-import.v1", name: "Engineering Import" },
      { id: "workflow.launch-readiness.v1", name: "Launch Readiness" },
      { id: "workflow.due-diligence.v1", name: "Due Diligence" },
    ]);
  });

  it("returns isolated, deeply frozen catalog and showcase DTOs", () => {
    const catalog = listWorkflowShowcases();
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0].expectedArtifacts)).toBe(true);
    expect(Object.isFrozen(catalog[0].expectedArtifacts[0])).toBe(true);
    expect(() => { (catalog[0].expectedArtifacts as { path: string }[])[0].path = "altered.json"; }).toThrow(TypeError);
    expect(listWorkflowShowcases()[0].expectedArtifacts[0].path).toBe("artifacts/engineering/change-plan.json");

    const projection = projectWorkflowShowcase("workflow.engineering-import.v1")!;
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.decisionStops[0])).toBe(true);
    expect(() => { (projection.decisionStops as { decision: string }[])[0].decision = "altered"; }).toThrow(TypeError);
    expect(projectWorkflowShowcase("workflow.engineering-import.v1")!.decisionStops[0].decision).toBe("authorize import-operator role");
    expect(renderWorkflowReport("workflow.engineering-import.v1")).toContain("Engineering Import evidence report");
  });

  it("projects the engineering role gate, dry run, duplicate, atomic result, and independent Survey", () => {
    const value = projectWorkflowShowcase("workflow.engineering-import.v1")!;
    expect(value.executionMode).toBe("explorer");
    expect(value.executionPolicy.providers).toBe("disabled");
    expect(value.decisionStops[0]).toMatchObject({ id: "eng.stop.role-gate", authorityRole: "engineering-owner" });
    expect(JSON.stringify(value)).toMatch(/dry run/i);
    expect(JSON.stringify(value)).toContain("acct-102");
    expect(JSON.stringify(value)).toMatch(/atomic/i);
    expect(value.evidence.surveys).toEqual([expect.objectContaining({ id: "eng.survey", outcome: "passed", executionAncestry: [] })]);
  });

  it("projects the launch finding, owner correction, remediation, and independent Resurvey pass", () => {
    const value = projectWorkflowShowcase("workflow.launch-readiness.v1")!;
    expect(value.executionMode).toBe("expedition");
    expect(value.evidence.findings).toEqual([expect.objectContaining({ id: "survey.finding.unsupported-40-percent", outcome: "blocked" })]);
    expect(value.evidence.decisions).toEqual([expect.objectContaining({ id: "launch.owner-correction", decision: "approved" })]);
    expect(value.evidence.remediations).toEqual([expect.objectContaining({ id: "launch.promise-remediation" })]);
    expect(value.evidence.surveys.map(({ id, outcome, remediationId }) => ({ id, outcome, remediationId }))).toEqual([
      { id: "launch.survey", outcome: "failed", remediationId: undefined },
      { id: "launch.resurvey", outcome: "passed", remediationId: "launch.promise-remediation" },
    ]);
    expect(value.evidence.surveys.every(({ executionAncestry }) => executionAncestry.length === 0)).toBe(true);
  });

  it("blocks unsupported diligence answers and names each unresolved owner", () => {
    const value = projectWorkflowShowcase("workflow.due-diligence.v1")!;
    expect(value.evidence.claims.filter(({ outcome }) => outcome === "blocked")).toEqual([
      expect.objectContaining({ id: "dd.security-certification", owner: "Security Lead" }),
      expect.objectContaining({ id: "dd.retention", owner: "Finance Lead" }),
    ]);
    expect(value.evidence.artifacts[0].textEquivalent).toMatch(/Blocked: security certification, owner Security Lead; retention, owner Finance Lead/);
  });

  it("fails closed for unknown or malformed IDs and renders deterministic offline reports", () => {
    for (const id of ["", "workflow/launch-readiness.v1", "x".repeat(65), "workflow.unknown.v1"]) expect(projectWorkflowShowcase(id)).toBeNull();
    const first = renderWorkflowReport("workflow.launch-readiness.v1")!;
    expect(renderWorkflowReport("workflow.launch-readiness.v1")).toBe(first);
    expect(first).toContain("Launch Readiness evidence report");
    expect(first).not.toMatch(/<script|(?:src|href)=["']https?:|file:\/\//i);
  });
});
