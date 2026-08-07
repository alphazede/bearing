import { describe, expect, it } from "vitest";
import { validatePlan, type Finding } from "../src/journey/planning-validator.js";
import type { PlanDocuments } from "../src/journey/plan-structure.js";

const plan = `---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Import bounded data.

## Risks and open questions

- **RISK-1** — Invalid input must fail closed.

## Entry criteria

Requirements are approved.

## Exit criteria

All evidence commands pass.

## Rollback or repair

Repair the plan and rerun validation.

## Accountable controller

Navigator controls the phase.
`;

const design = `---
type: design
status: complete
---

## Use Cases and Communication Flows

The owner dispatches one bounded slice.

## Interface Option Check

No new interface is needed.

## OOPDSA Implementation Design

- **DES-1** — Reuse the bounded import boundary.
- **CONTRACT-1** — Invalid input fails closed.
`;

const seit = `---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — \`pnpm test\`

## Traceability Matrix

| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |

## Cross-cutting Checks

The execution boundary remains unchanged.
`;

const implementationHead = `---
type: implementation
status: complete
---

## Dependency graph

`;

function waveLine(wave: number, id: string): string {
  return `Wave ${wave}: **${id}**`;
}

function sliceBlock(id: string, paths: readonly string[]): string {
  return `

### Slice ${id} — Work

**Goal.** Import bounded data.
**Requirement IDs.** AC-1, RISK-1
**Design IDs.** DES-1, CONTRACT-1
**SEIT proof rows.** SEIT-1
**Type.** New pure module and test
**Design lenses.** CDD
**Implementation role.** Backend Engineer
**Agent model route.** Codex agent default
**Agent reasoning level.** high
**Ponytail mode.** full
**Review path.** native review

### ${id} execution manifest

**Write set.** Write only ${paths.map((path) => `\`${path}\``).join(", ")}.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.`;
}

function slicePaths(sliceId: string, count: number): string[] {
  return [...Array(count)].map((_, index) => `src/${sliceId}-${index}.ts`);
}

const documents = (implementation: string): PlanDocuments => ({ plan, design, seit, implementation });

function validate(implementation: string) {
  return validatePlan({ documents: documents(implementation), planDirectory: "docs/plans/import" });
}

function aggregateCapFinding(findings: readonly Finding[]): Finding | undefined {
  return findings.find((item) => item.code === "writeset_unsafe_path" && item.sliceId === undefined && /^\d+ unique paths/.test(item.observed));
}

describe("slice path cap", () => {
  it("passes whole-plan validation when every slice Focus envelope is bounded despite a 129+ path aggregate", () => {
    // Seven waves, one slice each; every slice writes 19 unique paths, so the route
    // aggregate is 133 unique paths (> 128) while each individual envelope stays
    // bounded. S2 additionally depends on S1, making its envelope 38 paths — still
    // within the Focus execution boundary. The aggregate must not invalidate the plan.
    const ids = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];
    const implementation = [
      implementationHead,
      ids.map((id, index) => waveLine(index + 1, id)).join("\n"),
      "S2 --> S1",
      ...ids.map((id) => sliceBlock(id, slicePaths(id, 19))),
    ].join("\n");

    const result = validate(implementation);

    expect(result.verdict).toBe("PASS");
    const cap = result.findings.filter((item) => item.code === "writeset_unsafe_path");
    expect(cap).toHaveLength(1);
    expect(cap[0]?.severity).toBe("advisory");
    expect(cap[0]?.observed).toBe("133 unique paths across the whole route");
  });

  it("still rejects a slice whose Focus envelope (slice plus prerequisite closure) exceeds 128 paths", () => {
    // S1 writes 64 paths and S2 writes 65; S2 depends on S1, so the S2 envelope
    // aggregates 129 unique paths — over the Focus execution boundary — even though
    // every slice on its own is bounded.
    const implementation = [
      implementationHead,
      waveLine(1, "S1"),
      waveLine(2, "S2"),
      "S2 --> S1",
      sliceBlock("S1", slicePaths("S1", 64)),
      sliceBlock("S2", slicePaths("S2", 65)),
    ].join("\n");

    const result = validate(implementation);

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    const amendment = result.findings.find((item) => item.code === "writeset_unsafe_path" && item.severity === "amendment");
    expect(amendment).toBeDefined();
    expect(amendment?.sliceId).toBe("S2");
    expect(amendment?.observed).toBe("129 unique paths");
    expect(aggregateCapFinding(result.findings)?.severity).toBe("advisory");
  });
});
