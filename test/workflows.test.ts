import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWorkGraph } from "../src/execution/execution-scheduler.js";
import {
  dueDiligenceWorkflow,
  engineeringImportWorkflow,
  fictionalB2bWorkflows,
  launchReadinessWorkflow,
} from "../src/workflows/index.js";
import { projectWorkflowShowcase } from "../src/workflows/showcase.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/fictional-b2b");

async function json(path: string) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

describe("fictional B2B showcase workflows", () => {
  it("proves engineering gates, validation, dry run, duplicate handling, atomic result, audit, UI, and independent review", async () => {
    const { importCustomers } = await import(pathToFileURL(join(root, "src/import-customers.mjs")).href);
    const current = await json("data/customers.json");
    const csv = await readFile(join(root, "data/import.csv"), "utf8");
    const before = structuredClone(current);
    const dryRun = importCustomers(current, csv, { dryRun: true });
    const committed = importCustomers(current, csv, { dryRun: false });

    expect(engineeringImportWorkflow.decisionStops.map(({ id }) => id)).toEqual(["eng.stop.role-gate", "eng.stop.commit"]);
    expect(() => importCustomers(current, "name\nMissing identifier", { dryRun: false })).toThrow("expected id,name,plan CSV header");
    expect(current).toEqual(before);
    expect(dryRun).toMatchObject({ committed: false, customers: before, duplicates: ["acct-102"], ui: { headline: "2 customers ready", imported: 2, duplicates: 1 } });
    expect(committed).toMatchObject({ committed: true, duplicates: ["acct-102"], ui: { headline: "2 customers imported", imported: 2, duplicates: 1 } });
    expect(committed.customers).toHaveLength(3);
    expect(committed.audit).toEqual([{ id: "acct-101", action: "imported" }, { id: "acct-102", action: "imported" }]);
    expect(engineeringImportWorkflow.reviews[0]).toMatchObject({ role: "surveyor", independent: true, executionAncestry: [], expectedOutcome: "pass" });
  });

  it("proves the seeded unsupported promise, explicit correction approval, remediation, independent Resurvey, and legal graphs", async () => {
    const draft = await json("docs/launch-draft.json");
    const facts = await json("docs/product-facts.json");
    const corrected = await readFile(join(root, "expected/launch-brief.md"), "utf8");
    const infographic = await json("expected/infographic-inputs.json");
    const finding = "survey.finding.unsupported-40-percent";

    expect(draft.marketPromise).toEqual({ claim: "Guaranteed to cut onboarding time by 40 percent", evidence: null, status: "unsupported" });
    for (const fact of [...facts.capabilities, facts.commercialModel, draft.capability]) {
      expect((await stat(join(root, fact.evidence))).isFile()).toBe(true);
    }
    expect(launchReadinessWorkflow.reviews[0]).toMatchObject({ role: "surveyor", executionAncestry: [], expectedFindingIds: [finding], expectedOutcome: "finding" });
    expect(launchReadinessWorkflow.decisionStops).toContainEqual(expect.objectContaining({ authorityRole: "launch-owner", decision: `approve correction of ${finding}`, requires: [finding] }));
    expect(corrected).not.toContain(draft.marketPromise.claim);
    expect(corrected).toContain("No measured time-saving or market-performance claim is made.");
    expect(infographic.unsupportedClaims).toEqual([]);
    expect(launchReadinessWorkflow.reviews[1]).toMatchObject({ kind: "resurvey", role: "surveyor", executionAncestry: [], afterTaskIds: ["launch.correct-promise"], expectedOutcome: "pass" });
    expect(new Set(fictionalB2bWorkflows.map(({ id }) => id)).size).toBe(3);
    for (const workflow of fictionalB2bWorkflows) {
      expect(validateWorkGraph(workflow.workGraph)).toMatchObject({ ok: true });
      expect(workflow.workGraph.nodes.every(({ role }) => role !== ("surveyor" as never))).toBe(true);
      expect(workflow.executionPolicy).toEqual({ deterministic: true, providers: "disabled", writeScope: "fixture-copy-only" });
      expect(workflow.tasks.every(({ id, dependencies }) => id.length > 0 && dependencies.every((dependency) => workflow.tasks.some((task) => task.id === dependency)))).toBe(true);
      expect(workflow.decisionStops.every(({ id, beforeTaskId, authorityRole, decision, requires }) => id && workflow.tasks.some((task) => task.id === beforeTaskId) && authorityRole && decision && requires.length > 0)).toBe(true);
      expect(workflow.expectedArtifacts.length).toBeGreaterThan(0);
      expect(workflow.criticalInvariants.length).toBeGreaterThan(0);
      expect(workflow.outcomeExpectations.length).toBeGreaterThan(0);
    }
  });

  it("answers due-diligence questions only with existing evidence, blocks unsupported answers with owners, and keeps the fixture public-safe", async () => {
    const questions = await json("docs/due-diligence-questions.json");
    const answers = await json("expected/due-diligence.json");
    for (const answer of answers) {
      const question = questions.find(({ id }: { id: string }) => id === answer.questionId);
      expect(question).toBeDefined();
      if (answer.status === "answered") {
        expect(answer.evidence.length).toBeGreaterThan(0);
        for (const evidence of answer.evidence) expect((await stat(join(root, evidence))).isFile()).toBe(true);
      } else {
        expect(answer.status).toBe("blocked");
        expect(answer.unresolvedOwner).toMatch(/ Lead$/);
        expect(answer.answer).toBeUndefined();
      }
    }
    expect(dueDiligenceWorkflow.outcomeExpectations.filter(({ status }) => status === "blocked")).toEqual([
      expect.objectContaining({ id: "dd.security-certification", unresolvedOwner: "Security Lead" }),
      expect.objectContaining({ id: "dd.retention", unresolvedOwner: "Finance Lead" }),
    ]);

    const files: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(path);
      }
    }
    await walk(root);
    const corpus = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
    expect(files.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(corpus)).toBeLessThan(16_000);
    expect(corpus).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    expect(corpus).not.toMatch(/\b(?:sk|ghp|glpat)_[A-Za-z0-9_-]{16,}\b/);
    expect(corpus).not.toMatch(/\b(?:AlphaZede|OpenAI|Anthropic|Codex|Grok|bm1command)\b/i);
    expect((await json("package.json")).license).toBe("CC0-1.0");
  });

  it("closes every catalog and public showcase evidence path within the fixture", async () => {
    const paths = fictionalB2bWorkflows.flatMap((workflow) => [
      ...workflow.expectedArtifacts.map(({ path }) => path),
      ...workflow.outcomeExpectations.flatMap(({ evidence = [] }) => evidence),
      ...projectWorkflowShowcase(workflow.id)!.evidence.evidence.flatMap(({ href }) => href ? [href] : []),
    ]);
    for (const path of paths) {
      expect(isAbsolute(path)).toBe(false);
      expect(path).not.toMatch(/(?:^|[\\/])\.\.(?:[\\/]|$)/);
      const resolved = resolve(root, path);
      const relation = relative(root, resolved);
      expect(relation && !relation.startsWith("..") && !isAbsolute(relation)).toBe(true);
      expect((await stat(resolved)).isFile()).toBe(true);
    }
  });
});
