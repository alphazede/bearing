import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  isFitDiagnostic,
  validateFitReceipt,
  type FitAssumption,
  type FitDiagnostic,
  type FitScope,
} from "../src/journey/repository-fit.js";
import { planDirectoryValid } from "../src/journey/plan-directory.js";

const scope: FitScope = { repository: "/workspace/repository" };
const assumption: FitAssumption = {
  repository: "/workspace/repository",
  planDirectory: "docs/plans/bearing-improvements/phase-2a",
  rationale: "The manifest and plan convention identify this repository.",
  evidence: [
    { kind: "manifest", path: "package.json", detail: "The package identifies Bearing." },
    { kind: "plan-convention", path: "docs/plans", detail: "Existing plans use this root." },
  ],
};

const receipt = (candidate: unknown) => validateFitReceipt(candidate, scope);
const malformed = (check: FitDiagnostic["check"], field: FitDiagnostic["field"]) => ({
  ok: false as const,
  reason: "fit_malformed" as const,
  diagnostic: { check, field },
});
const diagnostics = [
  ["scope_repository", "repository"],
  ["scope_repository", "authorizedWorkspaceRoot"],
  ["receipt_shape", "receipt"],
  ["receipt_reason", "reason"],
  ["receipt_ok", "ok"],
  ["question_text", "question"],
  ["assumption_shape", "assumption"],
  ["assumption_repository", "repository"],
  ["assumption_plan_directory", "planDirectory"],
  ["assumption_rationale", "rationale"],
  ["assumption_evidence", "evidence"],
  ["evidence_shape", "evidence"],
  ["evidence_kind", "kind"],
  ["evidence_path", "path"],
  ["evidence_detail", "detail"],
  ["evidence_containment", "path"],
  ["result_envelope", "assistantText"],
  ["result_envelope", "envelope"],
] as const satisfies readonly [FitDiagnostic["check"], FitDiagnostic["field"]][];

describe("repository fit", () => {
  it("accepts only emitted bounded check-and-field diagnostics", () => {
    for (const [check, field] of diagnostics) expect(isFitDiagnostic({ check, field })).toBe(true);
    expect(isFitDiagnostic({ check: "receipt_ok", field: "detail" })).toBe(false);
  });

  it("does not treat a case-variant sibling as contained on a POSIX root", () => {
    // win32.isAbsolute("/workspace/repository") is true, so selecting the path
    // dialect with it applied Windows rules — including case-insensitive
    // comparison — to POSIX roots. win32.relative("/workspace/Repository",
    // "/workspace/repository/x") is "x", so a sibling that differs only by case
    // read as contained. On a case-sensitive filesystem those are two
    // directories.
    const value = {
      ok: true,
      assumption: {
        ...assumption,
        evidence: [{ kind: "manifest", path: "/workspace/Repository/package.json", detail: "Case-variant sibling." }],
      },
      question: "Use this repository and plan directory?",
    };
    expect(receipt(value)).toEqual(malformed("evidence_containment", "path"));
  });

  it("does not mix path dialects between a root and its evidence", () => {
    const value = {
      ok: true,
      assumption: {
        ...assumption,
        evidence: [{ kind: "manifest", path: "C:\\workspace\\repository\\package.json", detail: "Windows path under a POSIX root." }],
      },
      question: "Use this repository and plan directory?",
    };
    expect(receipt(value)).toEqual(malformed("evidence_path", "path"));
  });

  it("accepts exactly one bounded evidence-backed assumption", () => {
    const value = {
      ok: true,
      assumption,
      question: "Use this repository and plan directory?",
    };
    expect(receipt(value)).toEqual(value);
  });

  it("accepts a selected repository with a trailing separator", () => {
    const value = {
      ok: true,
      assumption: { ...assumption, repository: "/workspace/repository/" },
      question: "Use this repository and plan directory?",
    };
    expect(receipt(value)).toEqual({
      ...value,
      assumption: { ...value.assumption, repository: scope.repository },
    });

    const windowsRepository = String.raw`C:\Users\will\repo`;
    const windowsValue = {
      ok: true,
      assumption: {
        ...assumption,
        repository: `${windowsRepository}\\`,
        evidence: [{ kind: "manifest", path: String.raw`C:\Users\will\repo\package.json`, detail: "The package identifies Bearing." }],
      },
      question: "Use this repository and plan directory?",
    };
    expect(validateFitReceipt(windowsValue, { repository: windowsRepository })).toEqual({
      ...windowsValue,
      assumption: { ...windowsValue.assumption, repository: windowsRepository },
    });
  });

  it("accepts relative Windows evidence only under a Windows repository", () => {
    const repository = String.raw`C:\Users\will\repo`;
    const value = {
      ok: true,
      assumption: {
        ...assumption,
        repository,
        evidence: [{ kind: "manifest", path: String.raw`src\package.json`, detail: "The package identifies Bearing." }],
      },
      question: "Use this repository and plan directory?",
    };
    expect(validateFitReceipt(value, { repository })).toEqual(value);
    const forwardSlashValue = {
      ...value,
      assumption: {
        ...value.assumption,
        evidence: [{ kind: "manifest", path: "src/package.json", detail: "The package identifies Bearing." }],
      },
    };
    expect(validateFitReceipt(forwardSlashValue, { repository })).toEqual(forwardSlashValue);
    expect(receipt({
      ...value,
      assumption: { ...value.assumption, repository: scope.repository },
    })).toEqual(malformed("evidence_path", "path"));

    for (const { path, diagnostic } of [
      { path: "/workspace/repository/package.json", diagnostic: ["evidence_path", "path"] as const },
      { path: String.raw`src\nested/package.json`, diagnostic: ["evidence_path", "path"] as const },
      { path: "../package.json", diagnostic: ["evidence_containment", "path"] as const },
      { path: "src//package.json", diagnostic: ["evidence_path", "path"] as const },
    ]) {
      expect(validateFitReceipt({
        ...value,
        assumption: { ...value.assumption, evidence: [{ kind: "manifest", path, detail: "Invalid evidence path." }] },
      }, { repository })).toEqual(malformed(diagnostic[0], diagnostic[1]));
    }
  });

  it("rejects doubled POSIX repository separators", () => {
    expect(receipt({
      ok: true,
      assumption: { ...assumption, repository: "/workspace/repository//" },
      question: "Use this repository and plan directory?",
    })).toEqual(malformed("assumption_repository", "repository"));
  });

  it("rejects a plan-directory segment over the documented bound", () => {
    expect(receipt({
      ok: true,
      assumption: { ...assumption, planDirectory: `docs/plans/${"x".repeat(65)}` },
      question: "Use this repository and plan directory?",
    })).toEqual(malformed("assumption_plan_directory", "planDirectory"));
  });

  it("rejects an extra envelope key outside the exact fit contract", () => {
    expect(receipt({
      ok: true,
      assumption,
      question: "Use this repository and plan directory?",
      nextStageEstimate: { stage: "gather-supplies", minMinutes: 1, maxMinutes: 2, basis: "Not part of a fit receipt." },
    })).toEqual(malformed("receipt_shape", "receipt"));
  });

  it("rejects workspace evidence when the caller did not authorize its root", () => {
    expect(receipt({
      ok: true,
      assumption: {
        ...assumption,
        evidence: [{ kind: "workspace-config", path: "/workspace/shared/pnpm-workspace.yaml", detail: "The workspace includes this repository." }],
      },
      question: "Use this repository and plan directory?",
    })).toEqual(malformed("evidence_containment", "path"));
  });

  it("rejects control-bearing and noncanonical evidence paths", () => {
    for (const path of ["package\\name.json", "./package.json", "package\nname.json"]) {
      expect(receipt({
        ok: true,
        assumption: { ...assumption, evidence: [{ kind: "manifest", path, detail: "Invalid evidence path." }] },
        question: "Use this repository and plan directory?",
      })).toEqual(malformed("evidence_path", "path"));
    }
  });

  it("accepts evidence in the one additional authorized workspace root", () => {
    const value = {
      ok: true,
      assumption: {
        ...assumption,
        evidence: [{ kind: "workspace-config", path: "/workspace/shared/pnpm-workspace.yaml", detail: "The workspace includes this repository." }],
      },
      question: "Use this repository and plan directory?",
    };
    expect(validateFitReceipt(value, { ...scope, authorizedWorkspaceRoot: "/workspace/shared" })).toEqual(value);
  });

  it("rejects a nested repository assumption before asking the owner", () => {
    expect(receipt({
      ok: true,
      assumption: { ...assumption, repository: "/workspace/repository/packages/app" },
      question: "Use this repository and plan directory?",
    })).toEqual(malformed("assumption_repository", "repository"));
  });

  it("accepts native Windows absolute repository and evidence paths", () => {
    const repository = String.raw`C:\Users\will\repo`;
    const value = {
      ok: true,
      assumption: {
        ...assumption,
        repository,
        evidence: [{ kind: "manifest", path: String.raw`C:\Users\will\repo\package.json`, detail: "The package identifies Bearing." }],
      },
      question: "Use this repository and plan directory?",
    };
    expect(validateFitReceipt(value, { repository })).toEqual(value);
    expect(planDirectoryValid(String.raw`docs\plans\bearing-improvements`)).toBe(false);
  });

  it.each([
    { value: { ok: true, question: "No assumption?" }, diagnostic: ["receipt_shape", "receipt"] as const },
    { value: { ok: true, assumption: [assumption, assumption], question: "Two assumptions?" }, diagnostic: ["assumption_shape", "assumption"] as const },
    { value: { ok: true, assumptions: [assumption, assumption], question: "Rank these?" }, diagnostic: ["receipt_shape", "receipt"] as const },
  ])("rejects a receipt without exactly one assumption", ({ value, diagnostic }) => {
    expect(receipt(value)).toEqual(malformed(diagnostic[0], diagnostic[1]));
  });

  it("rejects missing, out-of-scope, oversized, and control-bearing evidence", () => {
    for (const { evidence, diagnostic } of [
      { evidence: [], diagnostic: ["assumption_evidence", "evidence"] as const },
      { evidence: [{ kind: "manifest", path: "/outside/package.json", detail: "Outside scope." }], diagnostic: ["evidence_containment", "path"] as const },
      { evidence: [{ kind: "manifest", path: "package.json", detail: "x".repeat(4097) }], diagnostic: ["evidence_detail", "detail"] as const },
      { evidence: [{ kind: "manifest", path: "package.json", detail: "line one\nline two" }], diagnostic: ["evidence_detail", "detail"] as const },
    ]) {
      expect(receipt({
        ok: true,
        assumption: { ...assumption, evidence },
        question: "Use this repository and plan directory?",
      })).toEqual(malformed(diagnostic[0], diagnostic[1]));
    }
  });

  it("rejects invalid plan directories and malformed bounded text", () => {
    for (const { value, diagnostic } of [
      { value: { ...assumption, planDirectory: "docs/plans/bearing improvements" }, diagnostic: ["assumption_plan_directory", "planDirectory"] as const },
      { value: { ...assumption, planDirectory: undefined }, diagnostic: ["assumption_plan_directory", "planDirectory"] as const },
      { value: { ...assumption, rationale: "x".repeat(4097) }, diagnostic: ["assumption_rationale", "rationale"] as const },
      { value: { ...assumption, repository: "/workspace/repository\noutside" }, diagnostic: ["assumption_repository", "repository"] as const },
    ]) {
      expect(receipt({
        ok: true,
        assumption: value,
        question: "Use this repository and plan directory?",
      })).toEqual(malformed(diagnostic[0], diagnostic[1]));
    }
  });

  it("preserves the three distinct typed stop outcomes", () => {
    for (const [reason, expected] of [
      ["fit_unavailable", { ok: false, reason: "fit_unavailable" }],
      ["fit_malformed", malformed("receipt_reason", "reason")],
      ["fit_undecidable", { ok: false, reason: "fit_undecidable" }],
    ] as const) {
      expect(receipt({ ok: false, reason })).toEqual(expected);
    }
  });

  it("performs no filesystem I/O", async () => {
    const source = await readFile(new URL("../src/journey/repository-fit.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:fs|readFile|readdir|realpath|writeFile|mkdir/);
  });
});
