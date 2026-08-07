import { createHash } from "node:crypto";
import {
  artifactComplete,
  parsePlanDocuments,
  requiredSystemSpecFields,
  sectionPresent,
  structuralFindings,
  writeSetPathIssue,
  type PlanArtifact,
  type PlanDocuments,
  type PlanModel,
  type StructuralFindingCode,
} from "./plan-structure.js";

// Callers that validate a plan need the document shape they must pass in, so it
// is re-exported here rather than forcing a second import of plan-structure.
export type { PlanDocuments };

export type PlanningVerdictValue = "PASS" | "NEEDS_AMENDMENT" | "OWNER_DECISION_REQUIRED";
type SemanticFindingCode =
  | "traceability_broken"
  | "dependency_cycle"
  | "validation_missing"
  | "parallelism_unsafe"
  | "integration_unowned"
  | "contract_ambiguous"
  | "phase_control_missing"
  | "recon_recommended"
  | "procedure_mismatch"
  | "shared_contract_unproduced"
  | "system_spec_missing"
  | "system_trace_broken"
  | "risk_coverage_missing"
  | "command_unbound"
  | "dependency_unowned"
  | "system_owner_conflict"
  | "system_scope_conflict"
  | "system_path_conflict"
  | "slice_scope_advisory";
export type FindingCode = StructuralFindingCode | SemanticFindingCode;
export type ValidatorPolicy = Readonly<Record<never, never>>;

export interface Finding {
  readonly code: FindingCode;
  readonly severity: "advisory" | "amendment" | "owner_decision";
  readonly artifact: PlanArtifact;
  readonly sliceId?: string;
  readonly observed: string;
  readonly required: string;
  readonly remedy: string;
}

export interface PlanningVerdict {
  readonly verdict: PlanningVerdictValue;
  readonly findings: readonly Finding[];
  readonly checkedContentHash: string;
}

export function foldVerdict(findings: readonly Pick<Finding, "severity">[]): PlanningVerdictValue {
  if (findings.some((finding) => finding.severity === "amendment")) return "NEEDS_AMENDMENT";
  if (findings.some((finding) => finding.severity === "owner_decision")) return "OWNER_DECISION_REQUIRED";
  return "PASS";
}

function finding(
  code: FindingCode,
  severity: Finding["severity"],
  artifact: PlanArtifact,
  observed: string,
  required: string,
  remedy: string,
  sliceId?: string,
): Finding {
  return { code, severity, artifact, ...(sliceId ? { sliceId } : {}), observed: observed.slice(0, 512), required, remedy };
}

function section(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##[ \\t]+${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(content)?.[1]?.trim() ?? "";
}

interface MarkdownHeading {
  readonly level: number;
  readonly title: string;
  readonly start: number;
  readonly contentStart: number;
}

function markdownHeadings(content: string): readonly MarkdownHeading[] {
  return [...content.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*\r?$/gm)].map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
    start: match.index,
    contentStart: match.index + match[0].length,
  }));
}

function headingSection(content: string, headings: readonly MarkdownHeading[], index: number, limit: number): string {
  const heading = headings[index];
  const next = headings.slice(index + 1).find((candidate) => candidate.start < limit && candidate.level <= heading.level);
  return content.slice(heading.contentStart, next?.start ?? limit).trim();
}

function assertsPresence(clause: string, evidence?: RegExp): boolean {
  const value = clause.trim();
  if (!value || /^(?:-|tbd|todo|n\/a|none)\.?$/i.test(value)) return false;
  const absentClause = /^(?:unavailable|unassigned|unowned|unbound|absent|missing|pending|future|planned)\b|^no\b.{0,120}\b(?:assigned|available|owned|bound|present|scheduled|performed|ready)\b|\b(?:is|are|was|were|remains?)\s+(?:(?:currently|still|presently)\s+)?(?:unavailable|unassigned|unowned|unbound|absent|missing|pending|not\s+(?:assigned|available|owned|bound|present|scheduled|performed|ready))\b/i;
  if (!evidence) return !absentClause.test(value);
  const matches = value.matchAll(new RegExp(evidence.source, evidence.flags.includes("g") ? evidence.flags : `${evidence.flags}g`));
  for (const match of matches) {
    const before = value.slice(0, match.index);
    const after = value.slice(match.index + match[0].length);
    if (/\b(?:no|none|not)(?:\s+\w+)?\s*$/i.test(before)
      || /\b(?:never|without)(?:\s+(?:an?|the))?(?:\s+\w+)?\s*$/i.test(before)
      || /\b(?:do|does|did|is|are|was|were|can|could|will|would|shall|should|may|might|must)\s+not\s*$/i.test(before)
      || /^(?:unavailable|unassigned|unowned|unbound|absent|missing|pending)\b/i.test(match[0])
      || /^\s*(?:unavailable|unassigned|unowned|unbound|absent|missing|pending)\b/i.test(after)
      || /^\s*(?:cannot|can't|can\s+not|could\s+not|does?\s+not|did\s+not)\b/i.test(after)
      || /^\s*(?:is|are|was|were|remains?)\s+(?:(?:currently|still|presently)\s+)?(?:not|never|unavailable|unassigned|unowned|unbound|absent|missing|pending)\b/i.test(after)
      || /^\s*never\s+(?:occurs?|happens?|materiali[sz]es?)\b/i.test(after)
      || /^\s*without\s+(?:independence|independent\s+review|ownership|authority|binding)\b/i.test(after)) continue;
    return true;
  }
  return false;
}

function traceabilityFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  const tracedPlanIds = new Set([...model.traceRows.values()].flatMap((row) => [...row.requirements]));
  for (const id of model.planIds) {
    if (!tracedPlanIds.has(id)) findings.push(finding("traceability_broken", "amendment", "plan-spec.md", id, "every AC and RISK id must reach a traceability row", "add a proof row for the identifier"));
  }
  for (const [id, row] of model.traceRows) {
    if (!row.commands.size) findings.push(finding("traceability_broken", "amendment", "seit.md", id, "every traceability row must reach an evidence command", "add a declared command to the row"));
    for (const requirement of row.requirements) {
      if (!model.planIds.has(requirement)) findings.push(finding("traceability_broken", "amendment", "seit.md", requirement, "every trace-row requirement must be declared in the plan", "declare or remove the dangling requirement", id));
    }
    for (const design of row.designs) {
      if (!model.designIds.has(design)) findings.push(finding("traceability_broken", "amendment", "seit.md", design, "every trace-row design id must be declared in the design", "declare or remove the dangling design id", id));
    }
    for (const command of row.commands) {
      if (!model.requiredCommands.has(command)) findings.push(finding("traceability_broken", "amendment", "seit.md", command, "every trace-row command must be declared under Required Commands", "declare or remove the dangling command", id));
    }
  }
  for (const [id, slice] of model.slices) {
    const rows = [...slice.proofRowIds].flatMap((rowId) => {
      const row = model.traceRows.get(rowId);
      return row ? [row] : [];
    });
    const requirements = new Set(rows.flatMap((row) => [...row.requirements]));
    const designs = new Set(rows.flatMap((row) => [...row.designs]));
    for (const requirement of slice.requirementIds) {
      if (!requirements.has(requirement)) findings.push(finding("traceability_broken", "amendment", "implementation.md", requirement, "each slice requirement must be reachable through its own SEIT proof rows", "add a matching proof row or remove the requirement", id));
    }
    for (const design of slice.designIds) {
      if (!designs.has(design)) findings.push(finding("traceability_broken", "amendment", "implementation.md", design, "each slice design id must be reachable through its own SEIT proof rows", "add a matching proof row or remove the design id", id));
    }
  }
  return findings;
}

function dependencyFindings(model: PlanModel): Finding[] {
  const nodes = new Set([
    ...model.slices.keys(),
    ...model.dependencies.keys(),
    ...[...model.dependencies.values()].flatMap((targets) => [...targets]),
  ]);
  const indegree = new Map([...nodes].map((node) => [node, 0]));
  for (const [source, targets] of model.dependencies) {
    if (!nodes.has(source)) continue;
    for (const target of targets) if (nodes.has(target)) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const source = ready.shift()!;
    visited += 1;
    for (const target of model.dependencies.get(source) ?? []) {
      if (!indegree.has(target)) continue;
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return visited === nodes.size ? [] : [
    finding("dependency_cycle", "amendment", "implementation.md", [...indegree].filter(([, count]) => count > 0).map(([id]) => id).join(", "), "slice dependencies must form an acyclic graph", "remove or reverse an edge in the cycle"),
  ];
}

function validationFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  for (const [id, manifest] of model.manifests) {
    if (!manifest.commandIds.size) findings.push(finding("validation_missing", "amendment", "implementation.md", "no evidence command", "every slice must declare an evidence command", "add a focused command", id));
  }
  for (const [id, row] of model.traceRows) {
    const failureEvidence = /\b(?:does\s+not(?!\s+(?:fail|reject|error|den[iy]|block|refus|stop|escalat|prevent)\w*)|never(?!\s+(?:fail|reject|error|den[iy]|block|refus|stop|escalat|prevent)\w*)|(?:creat|grant|produc|issu|writ|record|leav)\w*\s+(?:no|zero)(?!\s+(?:fail|error|denial|rejection)\w*)|fail|reject|error|missing|den[iy]|block|refus|stop|cannot|unchanged|finding|non-?zero|escalat|prevent|omit|mismatch|conflict|cycle|unsafe)\w*\b/i;
    if (!assertsPresence(row.negativeCase, failureEvidence)) {
      findings.push(finding("validation_missing", "amendment", "seit.md", row.negativeCase, "the negative/failure case must describe an observable failure", "state how the seeded defect fails", id));
    }
  }
  return findings;
}

const COMMAND_BINDING_REQUIRED =
  "every declared command ID must resolve to an exact repository command or an explicitly typed external procedure";

const COMMAND_PLACEHOLDER = /^(?:-|tbd|todo|t\.?b\.?d\.?|n\/a|na|none|pending|future|planned|fixme|placeholder|\.\.\.)$/i;
const COMMAND_TEMPLATE = /[<>]|\.\.\./;

/**
 * A Required Commands entry binds a declared command ID to its repository
 * command: `- **CMD-UNIT** — \`pnpm test\``. The binding is the exact
 * repository command only when it is a backticked literal that is neither a
 * placeholder (tbd, todo, none, ...) nor template syntax (<pkg>, ...). A
 * backticked command satisfies the entry no matter which prefix the id uses.
 */
function exactRepositoryCommand(binding: string): boolean {
  const literals = [...binding.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  return literals.some((literal) =>
    literal.trim().length > 0
    && literal.length <= MAX_RATIONALE
    && !COMMAND_PLACEHOLDER.test(literal.trim())
    && !COMMAND_TEMPLATE.test(literal)
    && !/[\u0000-\u001f\u007f]/.test(literal));
}

/**
 * A PROC- id may bind to an explicitly typed external procedure instead of a
 * repository command: a non-placeholder prose description of the procedure
 * (for example `Run the migration import procedure.`). Bare CMD- ids never
 * qualify as external procedures; they must name an exact repository command.
 */
function explicitExternalProcedure(id: string, binding: string): boolean {
  if (!id.startsWith("PROC-")) return false;
  const prose = binding.replace(/`[^`]*`/g, " ").replace(/[*_~]/g, "").trim();
  if (!prose || prose.length > MAX_RATIONALE || COMMAND_PLACEHOLDER.test(prose)) return false;
  return prose.split(/\s+/).length >= 4;
}

function requiredCommandEntries(seitDocument: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const required = section(seitDocument, "Required Commands") ?? "";
  for (const match of required.matchAll(/^\s*-\s+\*\*((?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*)\*\*\s*(?:[—–:-]\s*)?(.*)$/gmi)) {
    entries.set(match[1].toUpperCase(), (match[2] ?? "").trim());
  }
  return entries;
}

/**
 * A declared command ID is bound when its Required Commands entry carries an
 * exact repository command, or — for PROC- ids only — an explicitly typed
 * external procedure description. Unbound entries fail closed: a manifest
 * command that resolves to none or a placeholder is not evidence.
 */
function commandIsBound(id: string, binding: string): boolean {
  return exactRepositoryCommand(binding) || explicitExternalProcedure(id, binding);
}

function commandBindingFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  const entries = requiredCommandEntries(model.documents.seit);
  for (const [id, binding] of entries) {
    if (commandIsBound(id, binding)) continue;
    findings.push(finding(
      "command_unbound",
      "amendment",
      "seit.md",
      `${id}: ${binding || "(no binding)"}`,
      COMMAND_BINDING_REQUIRED,
      "bind the command to an exact repository command in backticks or an explicitly typed external procedure description",
    ));
  }
  for (const [id, manifest] of model.manifests) {
    for (const command of manifest.commandIds) {
      const normalized = command.toUpperCase();
      // The undeclared case already fails as command_undeclared; this check
      // only tightens the declared-but-unbound case to the exact binding.
      if (!model.requiredCommands.has(normalized)) continue;
      if (commandIsBound(normalized, entries.get(normalized) ?? "")) continue;
      findings.push(finding(
        "command_unbound",
        "amendment",
        "implementation.md",
        command,
        COMMAND_BINDING_REQUIRED,
        "bind the command to an exact repository command in the Required Commands section",
        id,
      ));
    }
  }
  return findings;
}

const DEPENDENCY_ADD = /\b(?:add(?:ing)?|install(?:ing)?|introduc(?:e|ing)|upgrad(?:e|ing)|downgrad(?:e|ing)|bump(?:ing)?|pinn?(?:ing)?|migrat(?:e|ing)|requir(?:e|ing)|new)\b/i;
const DEPENDENCY_CHANGE = /\b(?:updat(?:e|ing)|chang(?:e|ing)|modify(?:ing)?|remov(?:e|ing)|dropp?(?:ing)?|replac(?:e|ing)|switc(?:h|hing)|swap(?:ping)?)\b/i;
const DEPENDENCY_NOUN = /\b(?:dependenc\w*|lockfile|package\.json)\b/i;
const PACKAGE_NOUN = /\bpackage\b/i;
const DEPENDENCY_NEGATION =
  /\b(?:no|not|never|without|no\s+longer|unchanged|untouched|avoid(?:ing)?|skip(?:ping)?|forbid(?:den)?|prohibit(?:ed)?)\b|\b(?:don['’]t|won['’]t|mustn['’]t|shouldn['’]t|can['’]t|cannot)\b/i;
const DEPENDENCY_PROXIMITY = 60;

/**
 * Declares a dependency change when a slice clause pairs a dependency-adding
 * verb with a package/dependency/lockfile noun (or a generic change verb with
 * a specific manifest noun) within a bounded window. Negated clauses ("no new
 * dependencies", "without adding packages") declare the opposite and never
 * trigger; backticked literals are masked so write-set path mentions cannot
 * fabricate intent.
 */
function declaresDependencyChange(text: string): string | undefined {
  let inCode = false;
  let masked = "";
  for (const character of text) {
    if (character === "`") inCode = !inCode;
    masked += inCode || character === "`" ? " " : character;
  }
  const clauses: Array<{ clause: string; maskedClause: string }> = [];
  let start = 0;
  // A period is a clause boundary only when it does not continue an
  // identifier: package.json, pnpm-lock.yaml, and 1.2 keep their dots.
  for (const match of masked.matchAll(/(?:\.(?![A-Za-z0-9])|[;\r\n])+/g)) {
    clauses.push({ clause: text.slice(start, match.index), maskedClause: masked.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  clauses.push({ clause: text.slice(start), maskedClause: masked.slice(start) });
  for (const { clause, maskedClause } of clauses) {
    if (DEPENDENCY_NEGATION.test(maskedClause)) continue;
    const specific = DEPENDENCY_NOUN.exec(maskedClause);
    const barePackage = PACKAGE_NOUN.exec(maskedClause);
    let nounIndex: number;
    let genericVerbAllowed: boolean;
    if (specific) {
      nounIndex = specific.index;
      genericVerbAllowed = true;
    } else if (barePackage) {
      nounIndex = barePackage.index;
      genericVerbAllowed = false;
    } else {
      continue;
    }
    const adding = DEPENDENCY_ADD.exec(maskedClause);
    const changing = genericVerbAllowed ? DEPENDENCY_CHANGE.exec(maskedClause) : null;
    const verbMatch = adding ?? changing;
    if (!verbMatch || verbMatch.index === undefined || Math.abs(verbMatch.index - nounIndex) > DEPENDENCY_PROXIMITY) continue;
    return clause.replace(/[*_~`]/g, "").trim().slice(0, 160);
  }
  return undefined;
}

const PACKAGE_MANIFEST_PATH = /(?:^|\/)package\.json$/;
const DEPENDENCY_LOCKFILE_PATH =
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|bun\.lock|bun\.lockb|cargo\.lock|poetry\.lock|pipfile\.lock|gemfile\.lock|composer\.lock|deno\.lock|go\.sum)$/i;

const DEPENDENCY_OWNERSHIP_REQUIRED =
  "slices that introduce package dependency changes must own a package manifest or lockfile in their write set";

/**
 * A slice that declares dependency changes must authorize the package
 * manifest and lockfile in its write set; otherwise the dependency addition
 * has no owner that may produce it inside the route.
 */
function dependencyOwnershipFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  for (const [id, manifest] of model.manifests) {
    const slice = model.slices.get(id);
    const declared = declaresDependencyChange(`${slice?.raw ?? ""}\n${manifest.raw}`);
    if (!declared) continue;
    const ownsManifest = manifest.writeSetPaths.some((path) => PACKAGE_MANIFEST_PATH.test(path));
    const ownsLockfile = manifest.writeSetPaths.some((path) => DEPENDENCY_LOCKFILE_PATH.test(path));
    if (ownsManifest || ownsLockfile) continue;
    findings.push(finding(
      "dependency_unowned",
      "amendment",
      "implementation.md",
      declared,
      DEPENDENCY_OWNERSHIP_REQUIRED,
      "add the package manifest and lockfile to the slice write set or move the dependency change to an owning slice",
      id,
    ));
  }
  return findings;
}

function normalizedProse(value: string): string {
  return value.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!]+$/g, "");
}

const PROCEDURE_MISMATCH_REQUIRED =
  "every executable-procedure traceability row must resolve to exactly one procedure narrative whose command, positive case, negative case, and evidence target match the row";

function procedureFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  // Keyed procedure narratives are an opt-in convention: a plan adopts it by
  // titling at least one procedure `### SEIT-<id>`. Plans whose procedures are
  // unkeyed prose have nothing for a row to resolve against, so demanding a
  // narrative there would reject the plan without proving anything about it.
  if (!model.procedureNarratives.size) return findings;
  for (const [rowId, narratives] of model.procedureNarratives) {
    if (model.traceRows.has(rowId)) continue;
    findings.push(finding("procedure_mismatch", "amendment", "seit.md", `${rowId}: ${narratives.map((narrative) => narrative.heading).join(", ")} names no declared traceability row`, PROCEDURE_MISMATCH_REQUIRED, `declare ${rowId} in the Traceability Matrix or retitle the procedure narrative`));
  }
  for (const [id, row] of model.traceRows) {
    const executable = [...row.commands].filter((command) => command.startsWith("PROC-"));
    if (!executable.length) continue;
    const narratives = model.procedureNarratives.get(id) ?? [];
    if (!narratives.length) {
      findings.push(finding("procedure_mismatch", "amendment", "seit.md", `${id} has no procedure narrative`, PROCEDURE_MISMATCH_REQUIRED, `add a procedure narrative for ${id} that states the row's command, positive case, negative case, and evidence target`));
      continue;
    }
    if (narratives.length > 1) {
      findings.push(finding("procedure_mismatch", "amendment", "seit.md", `${id} resolves to ${narratives.length} procedure narratives: ${narratives.map((narrative) => narrative.heading).join(", ")}`, PROCEDURE_MISMATCH_REQUIRED, `keep exactly one procedure narrative for ${id}`));
      continue;
    }
    const narrative = narratives[0];
    const declared = narrative.commandIds;
    const foreign = [...declared].filter((command) => !row.commands.has(command));
    const omitted = executable.filter((command) => !declared.has(command));
    if (foreign.length || omitted.length) {
      findings.push(finding("procedure_mismatch", "amendment", "seit.md", `${id}: ${narrative.heading} declares command ${declared.size ? [...declared].join(", ") : "none"}, the row requires ${[...row.commands].join(", ")}`, PROCEDURE_MISMATCH_REQUIRED, "align the procedure narrative's command with the traceability row"));
    }
    const comparisons = [
      ["Positive case", "positive case", "positive case"],
      ["Negative case", "negative/failure case", "negative case"],
      ["Evidence", "evidence", "evidence target"],
    ] as const;
    for (const [field, cell, label] of comparisons) {
      const required = normalizedProse(row.cells.get(cell) ?? "");
      const value = field === "Evidence"
        ? narrative.fields.get("Evidence") ?? narrative.fields.get("Evidence target")
        : narrative.fields.get(field);
      if (required && !normalizedProse(value ?? "").includes(required)) {
        findings.push(finding("procedure_mismatch", "amendment", "seit.md", `${id}: ${narrative.heading} ${label} does not match the row`, PROCEDURE_MISMATCH_REQUIRED, `align the procedure narrative's ${label} with the traceability row's ${label}`));
      }
    }
  }
  return findings;
}

const SYSTEM_SPEC_REQUIRED =
  "every System Catalog entry must resolve to exactly one per-system specification with non-empty Ownership, Inputs, Outputs, APIs, Data ownership, Invariants, Trust boundary, Failure modes, and Observability fields";
const SYSTEM_TRACE_REQUIRED =
  "every declared requirement must reach a Requirement Trace row, and every requirement, system, contract, SEIT row, slice, and path in the trace must resolve to declared plan content";

function systemFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  // The system map is an opt-in convention: a plan adopts it by titling a
  // `## System Catalog` section in design.md. Plans that never declare the
  // section rely on ambient design prose, and nothing here demands a system
  // map from them.
  if (!model.systemCatalogAdopted) return findings;
  for (const id of model.systemCatalog.keys()) {
    if (!model.systemSpecs.has(id)) {
      findings.push(finding("system_spec_missing", "amendment", "design.md", `${id} has no per-system specification`, SYSTEM_SPEC_REQUIRED, `add a ### ${id} specification with every required field`));
    }
  }
  for (const [id, spec] of model.systemSpecs) {
    if (!model.systemCatalog.has(id)) {
      findings.push(finding("system_spec_missing", "amendment", "design.md", `${id}: ${spec.heading} names no catalog entry`, SYSTEM_SPEC_REQUIRED, `declare ${id} in the System Catalog or retitle the specification`));
      continue;
    }
    for (const name of requiredSystemSpecFields) {
      if (!spec.fields.get(name)) {
        findings.push(finding("system_spec_missing", "amendment", "design.md", `${id}: ${name.toLowerCase()}`, SYSTEM_SPEC_REQUIRED, `add a non-empty **${name}.** field to the ${id} specification`));
      }
    }
  }
  for (const id of model.sysReferences) {
    if (!model.systemCatalog.has(id)) {
      findings.push(finding("system_trace_broken", "amendment", "design.md", id, "every SYS- reference in design.md must name a catalog entry", `declare ${id} in the System Catalog or remove the reference`));
    }
  }
  const producedPaths = new Set([...model.manifests.values()].flatMap((manifest) => manifest.writeSetPaths));
  for (const row of model.systemTraceRows) {
    for (const requirement of row.requirements) {
      if (!model.planIds.has(requirement)) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", requirement, "every trace-row requirement must be declared in the plan", "declare or remove the dangling requirement"));
      }
    }
    for (const contract of row.contracts) {
      if (!model.designIds.has(contract)) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", contract, "every trace-row contract must be declared in the design", "declare or remove the dangling contract"));
      }
    }
    for (const seit of row.seits) {
      if (!model.traceRows.has(seit)) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", seit, "every trace-row SEIT id must name a traceability row", "declare or remove the dangling SEIT id"));
      }
    }
    for (const sliceId of row.slices) {
      if (!model.slices.has(sliceId)) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", sliceId, "every trace-row slice id must name a declared slice", "declare or remove the dangling slice id"));
      }
    }
    for (const path of row.paths) {
      const issue = writeSetPathIssue(path);
      if (issue) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", path, issue.reason, "replace it with a bounded normalized repository-relative literal"));
        continue;
      }
      if (!producedPaths.has(path)) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", path, "every traced path must be covered by a slice write set", `add \`${path}\` to a slice write set or remove the traced path`));
      }
    }
  }
  // The requirement-to-system closure binds only when a Requirement Trace
  // table is present: the trace is optional, so a plan that adopts the catalog
  // without one declares no requirement-to-system reachability contract.
  if (model.systemTraceRows.length > 0) {
    const tracedRequirements = new Set(model.systemTraceRows.flatMap((row) => [...row.requirements]));
    for (const id of model.planIds) {
      if (!tracedRequirements.has(id)) {
        findings.push(finding("system_trace_broken", "amendment", "design.md", id, "every declared requirement must reach a Requirement Trace row", `add ${id} to a Requirement Trace row`));
      }
    }
  }
  return findings;
}

const SYSTEM_OWNER_BINDING_REQUIRED =
  "every Requirement Trace row must bind each requirement to a slice that declares it in Requirement IDs";
const SYSTEM_SCOPE_BINDING_REQUIRED =
  "every Requirement Trace row must bind each contract and SEIT row to a slice that declares it in Design IDs and SEIT proof rows";
const SYSTEM_PATH_BINDING_REQUIRED =
  "every Requirement Trace row must bind each path to a slice whose write set covers it";

/**
 * The Requirement Trace row is design.md's cross-artifact binding: it names
 * the slice(s) that must execute each requirement, contract, SEIT row, and
 * path in the row. The union checks already demand a producer for every
 * traced path, but they never test that the NAMED slice agrees with the row
 * -- a plan can pass while design.md binds AC-1 to S1 while S1 declares
 * AC-2, or binds `src/notifier.ts` to S1 while S1 writes a path another
 * slice covers. These checks close that gap: every value a trace row binds
 * must be declared by at least one slice the row names. Rows that name no
 * declared slice are already reported as dangling by system_trace_broken
 * and are skipped here; traced paths that no slice anywhere covers are
 * already reported by the union coverage check and are skipped here too.
 */
function systemBindingFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  const producedPaths = new Set([...model.manifests.values()].flatMap((manifest) => manifest.writeSetPaths));
  for (const row of model.systemTraceRows) {
    const named = [...row.slices].filter((id) => model.slices.has(id));
    if (!named.length) continue;
    const label = named.join(", ");
    for (const requirement of row.requirements) {
      if (named.some((id) => model.slices.get(id)?.requirementIds.has(requirement))) continue;
      findings.push(finding(
        "system_owner_conflict",
        "amendment",
        "design.md",
        `${requirement}: Requirement Trace row names slice(s) ${label}, none declaring the requirement`,
        SYSTEM_OWNER_BINDING_REQUIRED,
        `declare ${requirement} in the named slice's Requirement IDs or fix the trace row`,
      ));
    }
    for (const contract of row.contracts) {
      if (named.some((id) => model.slices.get(id)?.designIds.has(contract))) continue;
      findings.push(finding(
        "system_scope_conflict",
        "amendment",
        "design.md",
        `${contract}: Requirement Trace row names slice(s) ${label}, none declaring the contract`,
        SYSTEM_SCOPE_BINDING_REQUIRED,
        `declare ${contract} in the named slice's Design IDs or fix the trace row`,
      ));
    }
    for (const seit of row.seits) {
      if (named.some((id) => model.slices.get(id)?.proofRowIds.has(seit))) continue;
      findings.push(finding(
        "system_scope_conflict",
        "amendment",
        "design.md",
        `${seit}: Requirement Trace row names slice(s) ${label}, none listing the row in SEIT proof rows`,
        SYSTEM_SCOPE_BINDING_REQUIRED,
        `add ${seit} to the named slice's SEIT proof rows or fix the trace row`,
      ));
    }
    for (const path of new Set(row.paths)) {
      if (!producedPaths.has(path)) continue;
      if (named.some((id) => model.manifests.get(id)?.writeSetPaths.includes(path))) continue;
      findings.push(finding(
        "system_path_conflict",
        "amendment",
        "design.md",
        `${path}: Requirement Trace row names slice(s) ${label}, none covering the path in a write set`,
        SYSTEM_PATH_BINDING_REQUIRED,
        `add \`${path}\` to the named slice's write set or fix the trace row`,
      ));
    }
  }
  return findings;
}

const MAX_RATIONALE = 4096;
const RISK_COVERAGE_REQUIRED =
  "every yes flag must map a design section or SYS- system, at least one SEIT row, and a slice; every no flag must carry an evidence-backed not-applicable rationale";

const VACUOUS_NEGATION = /\b(?:not\s+applicable|does\s+not\s+apply|doesn'?t\s+apply)\b/i;
const DEFERRAL = /\b(?:pending|deferred|tbd|to[- ]?be[- ]?determined|future|planned)\b/i;

/**
 * A not-applicable rationale is evidence only when it states why the flag
 * does not apply. Placeholder cells (`none`, `tbd`, `n/a`, `no`), bare
 * negations (`not applicable`, `does not apply`), and deferral language
 * (`pending`, `deferred`, `to be determined`, `future`, `planned`) dispose
 * of a triggered flag without evidence and must never satisfy the
 * requirement. The gate justifies an absence, so rationales that assert one
 * (`No customer data is present in this plan`) are evidence.
 */
function evidenceBackedRationale(value: string): boolean {
  const rationale = value.trim();
  if (!rationale || rationale.length > MAX_RATIONALE) return false;
  if (/^(?:-|tbd|todo|n\/a|na|none|no|not\s+applicable)\.?$/i.test(rationale)) return false;
  if (rationale.split(/\s+/).length < 4) return false;
  if (VACUOUS_NEGATION.test(rationale)) return false;
  if (DEFERRAL.test(rationale)) return false;
  return true;
}

/**
 * The per-slice workload aim. A slice whose declaration runs long is a slice
 * an author is handing one agent a lot of work in, so the aim exists to keep
 * dispatched work bounded and reviewable.
 *
 * It is an ergonomic aim, never a rule. Declared plan metadata was measured
 * against real run effort and explains none of it, so this number cannot
 * predict what a slice will cost — it only describes how much a plan is
 * asking for in one go. Nothing here gates a plan: the finding is advisory,
 * the verdict stays PASS, and an author who wants a larger slice keeps it.
 */
export const SLICE_WORKLOAD_AIM_TOKENS = 500;

/**
 * Workspace token-estimate convention: one token per four bytes, rounded up.
 * An estimate over declared text, not a measurement of anything a run spends.
 */
function estimateDeclaredTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

const SLICE_SCOPE_AIM =
  `a slice's declared text — its heading section plus its execution manifest — aims to stay within ${SLICE_WORKLOAD_AIM_TOKENS} estimated tokens so one agent is handed bounded work. The aim is ergonomic policy, not a prediction of the effort the slice will consume, and it never changes the verdict`;

function sliceScopeFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  for (const [id, slice] of model.slices) {
    const declared = `${slice.raw}\n${model.manifests.get(id)?.raw ?? ""}`;
    const tokens = estimateDeclaredTokens(declared);
    if (tokens <= SLICE_WORKLOAD_AIM_TOKENS) continue;
    findings.push(finding(
      "slice_scope_advisory",
      "advisory",
      "implementation.md",
      `${id} declares about ${tokens} estimated tokens across its slice section and execution manifest, above the ${SLICE_WORKLOAD_AIM_TOKENS}-token aim`,
      SLICE_SCOPE_AIM,
      "split the slice into smaller slices, or keep it deliberately — the aim does not block the plan",
      id,
    ));
  }
  return findings;
}

function riskFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  // The risk profile is an opt-in convention: a plan adopts it by titling a
  // `## Risk Profile` section in plan-spec.md. Plans that never declare the
  // section rely on ambient risk treatment, and nothing here demands a
  // profile from them. A declared profile binds every known flag: each yes
  // flag must resolve declared design, SEIT, and slice coverage, and each no
  // flag must carry an evidence-backed not-applicable rationale. Malformed
  // coverage cells already produce risk_profile_malformed, so flags with
  // coverage issues are skipped here instead of doubling the findings.
  if (!model.riskProfileAdopted) return findings;
  for (const [flag, entry] of model.riskProfile) {
    if (entry.coverageIssues.length) continue;
    if (entry.applies === "no") {
      if (!evidenceBackedRationale(entry.rationale)) {
        findings.push(finding(
          "risk_coverage_missing",
          "amendment",
          "plan-spec.md",
          `${flag}: not-applicable rationale is not evidence-backed`,
          "every no flag must carry an evidence-backed not-applicable rationale",
          "state why the flag does not apply or declare coverage",
        ));
      }
      continue;
    }
    const designClauses = entry.clauses.filter((clause) => clause.kind === "design");
    const systemClauses = entry.clauses.filter((clause) => clause.kind === "system");
    const seitClauses = entry.clauses.filter((clause) => clause.kind === "seit");
    const sliceClauses = entry.clauses.filter((clause) => clause.kind === "slice");
    if (!designClauses.length && !systemClauses.length) {
      findings.push(finding(
        "risk_coverage_missing",
        "amendment",
        "plan-spec.md",
        `${flag}: design coverage missing`,
        RISK_COVERAGE_REQUIRED,
        "map the flag to a design section or SYS- system, a SEIT row, and a slice",
      ));
    }
    for (const clause of designClauses) {
      if (!sectionPresent(model.documents.design, clause.value)) {
        findings.push(finding(
          "risk_coverage_missing",
          "amendment",
          "plan-spec.md",
          `${flag}: design section ${clause.value} is not a non-empty design section`,
          RISK_COVERAGE_REQUIRED,
          `map the flag to a non-empty ## section in design.md`,
        ));
      }
    }
    for (const clause of systemClauses) {
      if (!model.systemCatalog.has(clause.value)) {
        findings.push(finding(
          "risk_coverage_missing",
          "amendment",
          "plan-spec.md",
          `${flag}: system ${clause.value} is not a System Catalog entry`,
          RISK_COVERAGE_REQUIRED,
          `add ${clause.value} to the System Catalog or name a design section`,
        ));
      }
    }
    if (!seitClauses.length) {
      findings.push(finding(
        "risk_coverage_missing",
        "amendment",
        "plan-spec.md",
        `${flag}: SEIT coverage missing`,
        RISK_COVERAGE_REQUIRED,
        "map the flag to at least one declared SEIT row",
      ));
    }
    for (const clause of seitClauses) {
      if (!model.traceRows.has(clause.value)) {
        findings.push(finding(
          "risk_coverage_missing",
          "amendment",
          "plan-spec.md",
          `${flag}: SEIT row ${clause.value} is not a declared traceability row`,
          RISK_COVERAGE_REQUIRED,
          `map the flag to a declared SEIT- traceability row`,
        ));
      }
    }
    if (!sliceClauses.length) {
      findings.push(finding(
        "risk_coverage_missing",
        "amendment",
        "plan-spec.md",
        `${flag}: slice coverage missing`,
        RISK_COVERAGE_REQUIRED,
        "map the flag to at least one declared slice",
      ));
    }
    for (const clause of sliceClauses) {
      if (!model.slices.has(clause.value)) {
        findings.push(finding(
          "risk_coverage_missing",
          "amendment",
          "plan-spec.md",
          `${flag}: slice ${clause.value} is not a declared slice`,
          RISK_COVERAGE_REQUIRED,
          `map the flag to a declared slice id`,
        ));
      }
    }
  }
  return findings;
}

const SHARED_CONTRACT_PRODUCER_REQUIRED =
  "every declared shared interface path must be covered by a slice write set so the route can produce the shared contract";

function sharedContractFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  // Declared shared interfaces are the plan's only path-carrying contract
  // declaration: `path[#symbol]` names the module that must produce the shared
  // contract the slice changes or consumes. A slice that declares one while no
  // manifest write set in the whole plan covers its path cannot satisfy the
  // contract inside the route, so the route omits a required producer. Slices
  // that declare no shared interfaces opt out: the plan may rely on ambient
  // modules without naming them, and nothing here rejects that.
  const producedPaths = new Set([...model.manifests.values()].flatMap((manifest) => manifest.writeSetPaths));
  for (const [id, manifest] of model.manifests) {
    for (const identifier of manifest.sharedInterfaces ?? []) {
      const [path] = identifier.split("#");
      // Only identifiers that actually name a module can demand a producer:
      // anchor-only (`#Symbol`) and bare interface tags (`Symbol`, no path
      // separator) are parallelism tags, not paths — both documented forms.
      if (!path || (!identifier.includes("#") && !path.includes("/"))) continue;
      if (producedPaths.has(path)) continue;
      findings.push(finding(
        "shared_contract_unproduced",
        "amendment",
        "implementation.md",
        path,
        SHARED_CONTRACT_PRODUCER_REQUIRED,
        `add \`${path}\` to a slice write set or remove the shared-interface declaration`,
        id,
      ));
    }
  }
  return findings;
}

function sharedPaths(model: PlanModel): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const [id, manifest] of model.manifests) {
    for (const path of new Set(manifest.writeSetPaths)) {
      const owners = index.get(path) ?? [];
      owners.push(id);
      index.set(path, owners);
    }
  }
  return index;
}

function parallelismFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  for (const [wave, sliceIds] of model.waves) {
    const paths = new Map<string, string>();
    for (const id of sliceIds) {
      for (const path of model.manifests.get(id)?.writeSetPaths ?? []) {
        const prior = paths.get(path);
        if (prior && prior !== id) findings.push(finding("parallelism_unsafe", "amendment", "implementation.md", `${path}: ${prior}, ${id}`, "same-wave slice write sets must be disjoint", `move one slice out of Wave ${wave} or separate the write sets`, id));
        else paths.set(path, id);
      }
    }
  }
  return findings;
}

function integrationFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  for (const [path, sliceIds] of sharedPaths(model)) {
    for (const waveSliceIds of model.waves.values()) {
      const concurrentSliceIds = sliceIds.filter((id) => waveSliceIds.has(id));
      if (concurrentSliceIds.length < 2) continue;
      const owners = concurrentSliceIds.filter((id) => {
        const declared = /^\*\*Integration owner\.\*\*\s*(.+)$/mi.exec(model.manifests.get(id)?.raw ?? "")?.[1]?.trim();
        if (!declared || !assertsPresence(declared)) return false;
        return declared === id || declared === path || declared?.includes(`\`${path}\``);
      });
      const reviewEvidence = /\b(?:(?:native|independent|peer)(?:\s+review)?|surveyor(?:\s+review)?)\b/i;
      const independentReview = concurrentSliceIds.some((id) => (model.slices.get(id)?.fields.get("Review path") ?? "")
        .split(/[.;]/)
        .some((clause) => assertsPresence(clause, reviewEvidence)));
      if (owners.length !== 1 || !independentReview) findings.push(finding(
        "integration_unowned",
        "owner_decision",
        "implementation.md",
        `${path}: ${concurrentSliceIds.join(", ")}`,
        "shared integration paths need one owning slice and an independent review path",
        owners.length !== 1 ? "designate exactly one touching slice as the integration owner" : "assign an independent review path",
      ));
    }
  }
  return findings;
}

function ambiguityFindings(model: PlanModel): Finding[] {
  const findings: Finding[] = [];
  const ambiguous = /\b(?:TBD|TODO|decide later|one of)\b|\beither\b.{0,120}\bor\b/i;
  const acceptance = section(model.documents.plan, "Acceptance criteria");
  if (ambiguous.test(acceptance)) findings.push(finding("contract_ambiguous", "owner_decision", "plan-spec.md", acceptance, "acceptance criteria must not contain unresolved alternatives", "ask the owner to choose the contract"));
  for (const line of model.documents.design.split(/\r?\n/)) {
    if (/^\s*(?:(?:[-*+]|#{1,6})\s+)?\*{0,2}(?:DES|CONTRACT)-[A-Za-z0-9._-]+\*{0,2}\s*(?:[—–:.]|$)/i.test(line) && ambiguous.test(line)) {
      findings.push(finding("contract_ambiguous", "owner_decision", "design.md", line.trim(), "a binding design contract must not contain an unresolved alternative", "ask the owner to settle the design contract"));
    }
  }
  for (const [id, slice] of model.slices) {
    const goal = slice.fields.get("Goal") ?? "";
    if (ambiguous.test(goal)) findings.push(finding("contract_ambiguous", "owner_decision", "implementation.md", goal, "a slice Goal must state one settled outcome", "ask the owner to settle the Goal", id));
  }
  for (const [id, manifest] of model.manifests) {
    for (const name of ["Stop condition", "Human decision"]) {
      const value = manifest.fields.get(name) ?? "";
      if (ambiguous.test(value)) findings.push(finding("contract_ambiguous", "owner_decision", "implementation.md", value, `${name} must not contain an unresolved alternative`, "ask the owner to settle the contract", id));
    }
    const stop = manifest.fields.get("Stop condition") ?? "";
    if (stop && !/\b(?:if|when|unless|fails?|failure|passes?|returns?|reproduces?|requires?|cannot)\b/i.test(stop)) {
      findings.push(finding("contract_ambiguous", "owner_decision", "implementation.md", stop, "the stop condition must contain a falsifiable predicate", "state the observable condition that stops the slice", id));
    }
  }
  return findings;
}

function phaseControlFindings(model: PlanModel): Finding[] {
  if (!artifactComplete(model.documents.plan, "plan-spec", [])) return [];
  const controls = ["Entry criteria", "Exit criteria", "Rollback or repair", "Accountable controller"] as const;
  const headings = markdownHeadings(model.documents.plan);
  const phases = headings
    .map((heading, index) => ({ heading, index }))
    .filter(({ heading }) => /^Phase\s+(?=[A-Za-z0-9.-]*\d)[A-Za-z0-9.-]+(?:\s|$)/i.test(heading.title));
  if (phases.length) {
    return phases.flatMap(({ heading: phase }, phaseIndex) => {
      const limit = phases[phaseIndex + 1]?.heading.start ?? model.documents.plan.length;
      return controls.flatMap((name) => {
        const controlIndex = headings.findIndex((candidate) =>
          candidate.start >= phase.contentStart
          && candidate.start < limit
          && candidate.title.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
        const value = controlIndex < 0 ? "" : headingSection(model.documents.plan, headings, controlIndex, limit);
        return assertsPresence(value)
          ? []
          : [finding("phase_control_missing", "advisory", "plan-spec.md", `${phase.title}: ${name}`, `${phase.title} must name ${name.toLowerCase()}`, `add the ${name} control to ${phase.title}`)];
      });
    });
  }
  return controls.flatMap((name) => {
    const value = section(model.documents.plan, name);
    return assertsPresence(value)
    ? []
    : [finding("phase_control_missing", "advisory", "plan-spec.md", name, `the phase must name ${name.toLowerCase()}`, `add the ${name} control`)];
  });
}

function reconFindings(model: PlanModel): Finding[] {
  const requiresRecon = /\b(?:requires?|requiring)\s+Recon\b/i.test(model.documents.design);
  const bindingEvidence = /\b(?:Recon report|reconReport)\s+(?:is\s+)?bound\b|\bbound\s+(?:Recon report|reconReport)\b/i;
  const reportBound = `${model.documents.plan}\n${model.documents.implementation}`
    .split(/[\r\n.;]+/)
    .some((clause) => assertsPresence(clause, bindingEvidence));
  return requiresRecon && !reportBound
    ? [finding("recon_recommended", "owner_decision", "design.md", "assumption requires Recon", "a material Recon assumption needs an owner decision or a bound report", "run Recon or record the owner's decision to skip it")]
    : [];
}

function semanticFindings(model: PlanModel): readonly Finding[] {
  return [
    ...traceabilityFindings(model),
    ...dependencyFindings(model),
    ...validationFindings(model),
    ...commandBindingFindings(model),
    ...dependencyOwnershipFindings(model),
    ...procedureFindings(model),
    ...sharedContractFindings(model),
    ...parallelismFindings(model),
    ...integrationFindings(model),
    ...ambiguityFindings(model),
    ...phaseControlFindings(model),
    ...reconFindings(model),
    ...systemFindings(model),
    ...systemBindingFindings(model),
    ...riskFindings(model),
    ...sliceScopeFindings(model),
  ];
}

// A Focus run executes one slice at a time, so the 128-path execution boundary applies to
// the slice's Focus envelope — its own write set plus the write sets of every slice it
// transitively depends on — not to the union of all slices in a long-horizon route.
const MAX_FOCUS_ENVELOPE_PATHS = 128;

function focusEnvelope(model: PlanModel, sliceId: string): readonly string[] {
  const closure: string[] = [];
  const seen = new Set<string>();
  const queue = [sliceId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    closure.push(id);
    queue.push(...(model.dependencies.get(id) ?? []));
  }
  return closure;
}

function focusEnvelopePaths(model: PlanModel, sliceId: string): Set<string> {
  const paths = new Set<string>();
  for (const id of focusEnvelope(model, sliceId)) {
    for (const path of model.manifests.get(id)?.writeSetPaths ?? []) paths.add(path);
  }
  return paths;
}

/**
 * The structural layer caps the union of ALL slice write sets at 128 paths. A multi-wave
 * route can trip that aggregate while every executed Focus envelope stays bounded, which
 * would reject a valid selected-slice Focus run for the sake of unrelated future slices.
 * The whole-route total is therefore a diagnostic (advisory), and the hard limit is
 * evaluated per Focus envelope: a slice plus its prerequisite closure. An envelope is
 * always a subset of the route aggregate, so the per-envelope check only needs to run
 * when the aggregate itself exceeds the limit.
 */
function focusEnvelopePathFindings(model: PlanModel, findings: readonly Finding[]): Finding[] {
  const aggregateIndex = findings.findIndex((item) =>
    item.code === "writeset_unsafe_path" && item.sliceId === undefined && /^\d+ unique paths$/.test(item.observed));
  if (aggregateIndex < 0) return [...findings];
  const result = [...findings];
  const aggregate = result[aggregateIndex];
  result[aggregateIndex] = {
    ...aggregate,
    severity: "advisory",
    observed: `${aggregate.observed} across the whole route`,
    required: `each Focus envelope (a slice plus its prerequisite closure) may aggregate at most ${MAX_FOCUS_ENVELOPE_PATHS} paths; the whole-route total is a diagnostic, not a gate`,
    remedy: "execute Focus on bounded slices; split any slice whose envelope exceeds the limit",
  };
  for (const [id, paths] of [...model.slices.keys()].map((id) => [id, focusEnvelopePaths(model, id)] as const)) {
    if (paths.size <= MAX_FOCUS_ENVELOPE_PATHS) continue;
    result.push(finding(
      "writeset_unsafe_path",
      "amendment",
      "implementation.md",
      `${paths.size} unique paths`,
      `the Focus envelope for Slice ${id} (its write set plus prerequisite closure) may aggregate at most ${MAX_FOCUS_ENVELOPE_PATHS} paths`,
      "split the slice's write set or restructure its dependencies",
      id,
    ));
  }
  return result;
}

function contentHash(documents: PlanDocuments): string {
  const hash = createHash("sha256");
  for (const [name, content] of [
    ["plan-spec.md", documents.plan],
    ["design.md", documents.design],
    ["seit.md", documents.seit],
    ["implementation.md", documents.implementation],
  ] as const) hash.update(`${name}\0${Buffer.byteLength(content)}\0${content}`);
  return hash.digest("hex");
}

export function validatePlan(input: {
  readonly documents: PlanDocuments;
  readonly planDirectory: string;
  readonly policy?: ValidatorPolicy;
}): PlanningVerdict {
  const model = parsePlanDocuments(input.documents);
  const findings: Finding[] = focusEnvelopePathFindings(model, [...structuralFindings(model), ...semanticFindings(model)]);
  findings.sort((left, right) =>
    left.artifact.localeCompare(right.artifact)
    || (left.sliceId ?? "").localeCompare(right.sliceId ?? "")
    || left.code.localeCompare(right.code)
    || left.observed.localeCompare(right.observed));
  return {
    verdict: foldVerdict(findings),
    findings,
    checkedContentHash: contentHash(input.documents),
  };
}
