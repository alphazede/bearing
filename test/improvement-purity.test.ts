import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const improvementRoot = join(dirname(fileURLToPath(import.meta.url)), "../src/improvement");

const ALLOWED_EXPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "degradation.ts": Object.freeze([
    "DEGRADATION_REASONS",
    "DegradationInput",
    "DegradationReason",
    "DegradationSignal",
    "detectDegradation",
  ]),
  "improvement-export.ts": Object.freeze([
    "BenchmarkCaseDefinition",
    "ContributionBundle",
    "ContributionPolicyValue",
    "ContributionTestCase",
    "ExportContributionFailure",
    "ExportContributionInput",
    "ExportContributionResult",
    "OwnerWorkflowNote",
    "assertContributionBundle",
    "exportContributionBundle",
  ]),
  "improvement-metrics.ts": Object.freeze([
    "GradingConfusionCounts",
    "METRIC_IDS",
    "MetricId",
    "MetricInputs",
    "MetricSet",
    "MetricValue",
    "computeMetrics",
  ]),
  "improvement-proposal.ts": Object.freeze([
    "BoundedTrialOwnerEvidence",
    "BuildProposalResult",
    "CanonicalValue",
    "EvaluateBoundedTrialInput",
    "EvaluateBoundedTrialResult",
    "EvaluateTrialInput",
    "EvaluateTrialResult",
    "ImprovementMetricId",
    "MetricSnapshot",
    "OwnerAppliedRecommendation",
    "Proposal",
    "ProposalFailure",
    "ProposalRecommendation",
    "RevertDescriptor",
    "TrialEvaluationFailure",
    "TrialVerdict",
    "TrialVerdictReason",
    "TrialVerdictStatus",
    "TrialWindow",
    "buildProposal",
    "buildRecommendationProposal",
    "evaluateBoundedTrial",
    "evaluateTrial",
  ]),
  "improvement-recommender.ts": Object.freeze([
    "BuildRecommendationInput",
    "BuildRecommendationResult",
    "ConcurrencyTarget",
    "DEFAULT_IMPROVEMENT_THRESHOLDS",
    "DETECTOR_CATALOG",
    "EvidenceNeed",
    "EvidencePosition",
    "MetricCollection",
    "MetricId",
    "MetricValue",
    "OutcomeWindow",
    "PATTERN_IDS",
    "PatternDetector",
    "PatternId",
    "PlanningRequirementId",
    "PlanningTarget",
    "PolicyValue",
    "RECOMMENDABLE_PROFILE_TARGETS",
    "RECOMMENDABLE_SURFACES",
    "ReasoningTarget",
    "RecommendInput",
    "RecommendableSurface",
    "Recommendation",
    "RecommendationEvidence",
    "RecommendationRejectionCode",
    "RecommendationResult",
    "RevertDescriptor",
    "ReviewTarget",
    "SkillGuidancePointer",
    "SkillGuidanceTarget",
    "TargetRef",
    "TestDepth",
    "TestDepthTarget",
    "Thresholds",
    "TrialWindow",
    "buildRecommendation",
    "recommend",
  ]),
  "improvement-service.ts": Object.freeze([
    "ImprovementReport",
    "ImprovementService",
    "ImprovementServiceFailure",
    "ImprovementServiceOptions",
    "ImprovementServiceResult",
    "ImprovementStages",
    "ImprovementStore",
    "ImprovementWindow",
  ]),
  "outcome-projection.ts": Object.freeze([
    "MAX_OUTCOME_PATH_REFS",
    "MAX_OUTCOME_RECORDS_PER_RUN",
    "OUTCOME_CODES",
    "OUTCOME_SIGNALS",
    "OutcomeCode",
    "OutcomeRecord",
    "OutcomeSignal",
    "ProjectOutcomesInput",
    "projectOutcomes",
  ]),
  "workspace-keyed-digest.ts": Object.freeze([
    "workspaceKeyedDigest",
  ]),
} satisfies Readonly<Record<string, readonly string[]>>);

const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "degradation.ts": Object.freeze(["./outcome-projection.js"]),
  "improvement-export.ts": Object.freeze(["node:fs/promises", "node:path"]),
  "improvement-metrics.ts": Object.freeze([]),
  "improvement-proposal.ts": Object.freeze([
    "../contracts/run.js",
    "./improvement-recommender.js",
  ]),
  "improvement-recommender.ts": Object.freeze([
    "./outcome-projection.js",
    "../profile/profile.js",
    "../profile/reasoning-policy.js",
  ]),
  "improvement-service.ts": Object.freeze([
    "../store/bearing-store.js",
    "./outcome-projection.js",
  ]),
  "outcome-projection.ts": Object.freeze([
    "../contracts/run.js",
    "../contracts/runtime-state.js",
    "../execution/execution-mode.js",
    "../profile/profile.js",
    "../profile/reasoning-policy.js",
  ]),
  "workspace-keyed-digest.ts": Object.freeze([
    "node:crypto",
    "node:path",
  ]),
} satisfies Readonly<Record<string, readonly string[]>>);

function exported(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement)
    && (ts.getModifiers(statement) ?? []).some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);
}

function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  ));
}

function exportedNames(source: ts.SourceFile): readonly string[] {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const { name } of statement.exportClause.elements) names.add(name.text);
      } else {
        names.add("*");
      }
      continue;
    }
    if (!exported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const name of statement.declarationList.declarations.flatMap(({ name }) => bindingNames(name))) {
        names.add(name);
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return [...names].sort();
}

function importedSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.add(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) {
        specifiers.add(argument && ts.isStringLiteralLike(argument) ? argument.text : "<dynamic>");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers].sort();
}

describe("improvement structural boundary", () => {
  it("pins every improvement module to an exact exported-name allowlist", async () => {
    const modules = (await readdir(improvementRoot))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    expect(modules).toEqual(Object.keys(ALLOWED_EXPORTS).sort());

    for (const module of modules) {
      const content = await readFile(join(improvementRoot, module), "utf8");
      const source = ts.createSourceFile(module, content, ts.ScriptTarget.ESNext, true);
      expect(exportedNames(source), module).toEqual([...ALLOWED_EXPORTS[module]!].sort());
    }
  });

  it("pins imports so filesystem access exists only at the export edge and no network path can appear", async () => {
    const modules = (await readdir(improvementRoot)).filter((name) => name.endsWith(".ts"));
    for (const module of modules) {
      const content = await readFile(join(improvementRoot, module), "utf8");
      const source = ts.createSourceFile(module, content, ts.ScriptTarget.ESNext, true);
      expect(importedSpecifiers(source), module).toEqual([...ALLOWED_IMPORTS[module]!].sort());
    }
  });
});
