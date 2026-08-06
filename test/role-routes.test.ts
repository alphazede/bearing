import { describe, expect, it } from "vitest";
import { parseRoleRoutesSection, renderRoleRoutesSection } from "../src/journey/planning-journey.js";
import { roleRoutesShape, type RoleRoute } from "../src/contracts/execution-contract.js";

const routes: readonly RoleRoute[] = [
  { role: "execution-author", primary: "codex", fallbacks: ["claude", "agy"] },
  { role: "review-general", primary: "claude", fallbacks: [] },
  { role: "review-security", primary: "claude", fallbacks: ["surveyor"] },
];

const planSpec = (section: string): string =>
  `---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Bounded data.\n\n${section}`;

describe("plan-spec.md Role routes round-trip", () => {
  it("round-trips render -> parse back to the exact same routes and order", () => {
    expect(parseRoleRoutesSection(planSpec(renderRoleRoutesSection(routes)))).toEqual(routes);
  });

  it("renders a role with no fallbacks as 'fallbacks: none'", () => {
    expect(renderRoleRoutesSection(routes)).toContain("- **review-general** — primary: `claude`; fallbacks: none");
  });

  it("returns undefined when the section is absent", () => {
    expect(parseRoleRoutesSection(planSpec(""))).toBeUndefined();
  });

  it("returns undefined when the section is incomplete (missing a required role)", () => {
    expect(parseRoleRoutesSection(planSpec(renderRoleRoutesSection(routes.slice(0, 2))))).toBeUndefined();
  });

  it.each([
    ["duplicate fallback", "- **execution-author** — primary: `codex`; fallbacks: `claude`, `claude`\n- **review-general** — primary: `claude`; fallbacks: none\n- **review-security** — primary: `claude`; fallbacks: `surveyor`\n"],
    ["primary repeated as fallback", "- **execution-author** — primary: `codex`; fallbacks: `codex`\n- **review-general** — primary: `claude`; fallbacks: none\n- **review-security** — primary: `claude`; fallbacks: `surveyor`\n"],
    ["unrecognized route id", "- **execution-author** — primary: `totally-unknown-route`; fallbacks: none\n- **review-general** — primary: `claude`; fallbacks: none\n- **review-security** — primary: `claude`; fallbacks: `surveyor`\n"],
    ["surveyor as the execution-author fallback", "- **execution-author** — primary: `codex`; fallbacks: `surveyor`\n- **review-general** — primary: `claude`; fallbacks: none\n- **review-security** — primary: `claude`; fallbacks: `surveyor`\n"],
    ["duplicate role", "- **execution-author** — primary: `codex`; fallbacks: none\n- **execution-author** — primary: `claude`; fallbacks: none\n- **review-security** — primary: `claude`; fallbacks: `surveyor`\n"],
  ])("fails closed on %s", (_name, lines) => {
    expect(parseRoleRoutesSection(planSpec(`## Role routes\n\n${lines}`))).toBeUndefined();
  });

  it("agrees with the execution-contract roleRoutes schema", () => {
    const parsed = parseRoleRoutesSection(planSpec(renderRoleRoutesSection(routes)));
    expect(parsed).toBeDefined();
    expect(roleRoutesShape(parsed)).toBe(true);
  });

  it("stops at the next heading and ignores content after the section", () => {
    const withTrailer = `${planSpec(renderRoleRoutesSection(routes))}\n## Another section\n\nunrelated prose mentioning fallbacks: \`codex\`\n`;
    expect(parseRoleRoutesSection(withTrailer)).toEqual(routes);
  });
});
