import { isAbsolute, posix } from "node:path";
import { provenIndependent } from "../execution/concurrency-control.js";
const MAX_TEXT = 4096;
const MAX_ITEMS = 128;
const SLICE_HEADING = /^###\s+Slice\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\b.*$/gm;
const MANIFEST_HEADING = /^###\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\s+execution manifest\s*$/gmi;
const PLAN_ID = /^(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*$/i;
const DESIGN_ID = /^(?:DES|CONTRACT)-[A-Z0-9][A-Z0-9.-]*$/i;
const SEIT_ID = /^SEIT-[A-Z0-9][A-Z0-9.-]*$/i;
const COMMAND_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/i;
const TRACE_HEADERS = [
    "seit row id",
    "acceptance/risk id",
    "design/contract id",
    "boundary/test layer",
    "positive case",
    "negative/failure case",
    "command/procedure id",
    "evidence",
];
export const requiredSliceFields = [
    "Goal",
    "Requirement IDs",
    "Design IDs",
    "SEIT proof rows",
    "Type",
    "Design lenses",
    "Implementation role",
    "Agent model route",
    "Agent reasoning level",
    "Review path",
];
export const requiredManifestFields = ["Write set", "Command IDs", "Stop condition", "Human decision"];
const optionalManifestFields = ["Shared interfaces", "Integration boundary", "Parallel safe"];
function escaped(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function field(section, name) {
    return new RegExp(`^\\*\\*${escaped(name)}\\.\\*\\*\\s*(.+)$`, "mi").exec(section)?.[1]?.trim();
}
function fields(section, names) {
    return new Map(names.flatMap((name) => {
        const value = field(section, name);
        return value === undefined ? [] : [[name, value]];
    }));
}
function ids(value, pattern) {
    if (!value)
        return new Set();
    const candidates = value.match(/\b(?:AC|RISK|DES|CONTRACT|SEIT|CMD|PROC)-[A-Za-z0-9][A-Za-z0-9.-]*\b/gi) ?? [];
    return new Set(candidates.filter((candidate) => pattern.test(candidate)).map((candidate) => candidate.toUpperCase()));
}
function declaredIds(content, pattern) {
    const declarations = [
        ...[...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]),
        ...[...content.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]),
        ...[...content.matchAll(/^\s*[-*]\s+((?:AC|RISK|DES|CONTRACT|SEIT|CMD|PROC)-[A-Za-z0-9][A-Za-z0-9.-]*)\b/gmi)].map((match) => match[1]),
    ];
    return new Set(declarations.flatMap((value) => [...ids(value, pattern)]));
}
function records(content, pattern) {
    const allHeadings = [
        ...content.matchAll(new RegExp(SLICE_HEADING.source, SLICE_HEADING.flags)),
        ...content.matchAll(new RegExp(MANIFEST_HEADING.source, MANIFEST_HEADING.flags)),
    ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    const wanted = [...content.matchAll(new RegExp(pattern.source, pattern.flags))];
    const values = new Map();
    const duplicates = new Set();
    for (const match of wanted) {
        const id = match.groups?.id;
        if (!id)
            continue;
        const start = match.index ?? 0;
        const end = allHeadings.find((heading) => (heading.index ?? 0) > start)?.index ?? content.length;
        if (values.has(id))
            duplicates.add(id);
        else
            values.set(id, content.slice(start, end));
    }
    return { values, duplicates };
}
export function sectionPresent(content, heading) {
    const match = new RegExp(`^##[ \\t]+${escaped(heading)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(content);
    return Boolean(match?.[1]?.trim());
}
function section(content, heading) {
    const match = new RegExp(`^##[ \\t]+${escaped(heading)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(content);
    return match?.[1]?.trim() || undefined;
}
export function artifactComplete(content, type, headings) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    if (!frontmatter || !new RegExp(`^type:\\s*${escaped(type)}\\s*$`, "mi").test(frontmatter) || !/^status:\s*(?:complete|amended)\s*$/mi.test(frontmatter))
        return false;
    return headings.every((heading) => sectionPresent(content, heading));
}
export function writeSetPathIssue(value) {
    if (/[*<>\\]|\.\.\./.test(value))
        return { code: "writeset_glob", reason: "write-set paths must not contain wildcard or placeholder syntax" };
    if (!value
        || value.length > MAX_TEXT
        || value !== value.trim()
        || /[\u0000-\u001f\u007f]/.test(value)
        || isAbsolute(value)
        || /^[A-Za-z]:/.test(value)
        || posix.normalize(value) !== value
        || value.split("/").some((part) => !part || part === "." || part === ".."))
        return { code: "writeset_unsafe_path", reason: "write-set paths must be bounded, normalized repository-relative literals" };
    return undefined;
}
export function classifyWriteSetClause(writeSet) {
    let inCode = false;
    let masked = "";
    for (const character of writeSet) {
        if (character === "`")
            inCode = !inCode;
        masked += inCode || character === "`" ? " " : character;
    }
    const clauses = [];
    let start = 0;
    for (const match of masked.matchAll(/[.;\r\n]+/g)) {
        clauses.push(writeSet.slice(start, match.index));
        start = match.index + match[0].length;
    }
    clauses.push(writeSet.slice(start));
    const marker = /\b(?:not|no|never|cannot|except(?:ed|ing)?|exclud(?:e|ed|es|ing)|without|unchanged|untouched|read[- ]?only|leave|preserve|avoid|skip|forbid(?:den)?|prohibit(?:ed)?|as[- ]is)\b|\b(?:other|rather|apart)\s+(?:than|from)\b|\b(?:don['’]t|doesn['’]t|didn['’]t|can['’]t|won['’]t|shouldn['’]t|wouldn['’]t|couldn['’]t|mustn['’]t)\b/i;
    for (const clause of clauses) {
        const paths = [...clause.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        if (!paths.length)
            continue;
        const prose = clause.replace(/`[^`]*`/g, " ").replace(/[*_~]/g, "");
        if (marker.test(prose)) {
            return {
                clause: clause.trim(),
                paths,
                reason: "ambiguous write authority fails closed rather than silently granting write access; restate the prohibition in prose without backticks per planning contract rule 5",
            };
        }
    }
    return undefined;
}
function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, "").split("|").map((value) => value.trim());
}
function traceability(seitDocument) {
    const matrix = section(seitDocument, "Traceability Matrix") ?? "";
    const lines = matrix.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
    const headers = lines.length ? tableCells(lines[0]).map((value) => value.toLowerCase()) : [];
    const rows = new Map();
    const issues = [];
    const identifierValues = [];
    for (const line of lines.slice(2)) {
        const values = tableCells(line);
        if (values.length !== headers.length) {
            issues.push({ observed: line, reason: "trace row width must match the header width" });
            continue;
        }
        const cells = new Map(headers.map((header, index) => [header, values[index] ?? ""]));
        for (const header of ["seit row id", "acceptance/risk id", "design/contract id", "command/procedure id"]) {
            identifierValues.push(cells.get(header) ?? "");
        }
        const rowIds = ids(cells.get("seit row id"), SEIT_ID);
        if (rowIds.size !== 1) {
            issues.push({ observed: line, reason: "trace rows must contain exactly one typed SEIT row id" });
            continue;
        }
        const id = [...rowIds][0];
        if (rows.has(id)) {
            issues.push({ observed: id, reason: "trace row ids must be unique" });
            continue;
        }
        const requirements = ids(cells.get("acceptance/risk id"), PLAN_ID);
        const designs = ids(cells.get("design/contract id"), DESIGN_ID);
        const commands = ids(cells.get("command/procedure id"), COMMAND_ID);
        if (!requirements.size || !designs.size || !commands.size) {
            issues.push({ observed: line, reason: "trace rows must contain typed requirement, design, and command ids" });
            continue;
        }
        rows.set(id, {
            id,
            requirements,
            designs,
            commands,
            negativeCase: cells.get("negative/failure case") ?? "",
            cells,
        });
    }
    const required = section(seitDocument, "Required Commands") ?? "";
    const commands = new Set([...required.matchAll(/^\s*-\s+\*\*((?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*)\*\*/gmi)].map((match) => match[1].toUpperCase()));
    identifierValues.push(...[...required.matchAll(/^\s*-\s+\*\*([^*]+)\*\*/gmi)].map((match) => match[1]));
    return { headers, rows, commands, issues, identifierValues };
}
function waveMap(implementationDocument) {
    const waves = new Map();
    for (const line of implementationDocument.split(/\r?\n/)) {
        const declarations = [...line.matchAll(/\bWave\s+(\d+)\b/gi)];
        for (let index = 0; index < declarations.length; index += 1) {
            const declaration = declarations[index];
            const segment = line.slice((declaration.index ?? 0) + declaration[0].length, declarations[index + 1]?.index ?? line.length);
            const delimiter = /:|\bcovers?\b/i.exec(segment);
            const declared = segment.slice(delimiter ? delimiter.index + delimiter[0].length : 0).split("(", 1)[0];
            const sliceIds = declared.match(/\b(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)\b/g) ?? [];
            const members = waves.get(Number(declaration[1])) ?? new Set();
            sliceIds.forEach((id) => members.add(id));
            waves.set(Number(declaration[1]), members);
        }
    }
    return waves;
}
function dependencyMap(implementationDocument) {
    const result = new Map();
    const identifier = /\b(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)\b/g;
    let branchSource;
    for (const line of implementationDocument.split(/\r?\n/).filter((value) => /(?:-->|──>|→)/.test(value))) {
        const groups = line.split(/(?:-->|──>|→)/).map((part) => part.match(identifier) ?? []);
        if (groups[0].length && /┬/.test(line)) {
            const branchCandidates = groups.slice(0, -1).flat();
            branchSource = branchCandidates[branchCandidates.length - 1];
        }
        if (!groups[0].length && branchSource)
            groups[0] = [branchSource];
        for (let index = 0; index + 1 < groups.length; index += 1) {
            for (const source of groups[index]) {
                const targets = result.get(source) ?? new Set();
                groups[index + 1].forEach((target) => targets.add(target));
                result.set(source, targets);
            }
        }
    }
    return result;
}
function sharedInterfaces(value) {
    if (/^none[.!]?$/i.test(value))
        return [];
    const identifiers = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const residue = value.replace(/`[^`]*`/g, "").replace(/\band\b/gi, "").replace(/[\s,.;]+/g, "");
    return identifiers.length && !residue && new Set(identifiers).size === identifiers.length
        && identifiers.every((identifier) => writeSetPathIssue(identifier) === undefined)
        ? identifiers
        : undefined;
}
function validIntegrationBoundary(value) {
    if (/^none[.!]?$/i.test(value))
        return true;
    const paths = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    return value.length <= MAX_TEXT
        && value === value.trim()
        && !/[\u0000-\u001f\u007f*<>\\]|\.\.\./.test(value)
        && paths.every((path) => writeSetPathIssue(path) === undefined);
}
function parallelSafe(value) {
    const match = /^(yes|no)\s*(?:[—–:;-])\s*(\S[\s\S]*)$/i.exec(value);
    return match ? match[1].toLowerCase() === "yes" : undefined;
}
function plainCell(value) {
    return value.replace(/[`*]/g, "").trim();
}
function parsePhaseGraph(implementationDocument) {
    if (!/^##[ \t]+Phase graph[ \t]*$/mi.test(implementationDocument))
        return { entries: [], issues: [] };
    const content = section(implementationDocument, "Phase graph");
    if (!content)
        return { entries: [], issues: ["Phase graph section is empty"] };
    const lines = content.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
    if (lines.length < 3)
        return { entries: [], issues: ["Phase graph must be a Markdown table"] };
    const headers = tableCells(lines[0]).map((value) => plainCell(value).toLowerCase());
    const phaseColumn = headers.findIndex((header) => header === "phase" || header === "phase id");
    const slicesColumn = headers.indexOf("slices");
    const dependenciesColumn = headers.findIndex((header) => header === "depends on phases" || header === "phase dependencies");
    const checkpointsColumn = headers.indexOf("integration checkpoints");
    if ([phaseColumn, slicesColumn, dependenciesColumn, checkpointsColumn].some((index) => index < 0)) {
        return { entries: [], issues: ["Phase graph is missing a required column"] };
    }
    const entries = [];
    const issues = [];
    for (const line of lines.slice(2)) {
        const cells = tableCells(line);
        if (cells.length !== headers.length) {
            issues.push(`Phase graph row width does not match: ${line}`);
            continue;
        }
        const phaseId = plainCell(cells[phaseColumn] ?? "");
        const sliceIds = plainCell(cells[slicesColumn] ?? "").match(/\b(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)\b/g) ?? [];
        const dependencyCell = plainCell(cells[dependenciesColumn] ?? "");
        const dependsOnPhases = /^(?:—|-|none)$/i.test(dependencyCell)
            ? []
            : dependencyCell.split(",").map((value) => plainCell(value)).filter(Boolean);
        const checkpoint = /^(\d+)(?:\s+\([^()\r\n]+\))?$/.exec(plainCell(cells[checkpointsColumn] ?? ""))?.[1];
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(phaseId)
            || !sliceIds.length
            || new Set(sliceIds).size !== sliceIds.length
            || dependsOnPhases.some((dependency) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dependency))
            || new Set(dependsOnPhases).size !== dependsOnPhases.length
            || checkpoint === undefined
            || !Number.isSafeInteger(Number(checkpoint))
            || Number(checkpoint) > MAX_ITEMS) {
            issues.push(`Malformed Phase graph row: ${line}`);
            continue;
        }
        entries.push({
            phaseId,
            sliceIds,
            dependsOnPhases,
            integrationCheckpointCount: Number(checkpoint),
        });
    }
    return { entries, issues };
}
export function parsePlanDocuments(documents) {
    const sliceRecords = records(documents.implementation, SLICE_HEADING);
    const manifestRecords = records(documents.implementation, MANIFEST_HEADING);
    const slices = new Map();
    for (const [id, raw] of sliceRecords.values) {
        const parsedFields = fields(raw, requiredSliceFields);
        slices.set(id, {
            id,
            raw,
            fields: parsedFields,
            requirementIds: ids(parsedFields.get("Requirement IDs"), PLAN_ID),
            designIds: ids(parsedFields.get("Design IDs"), DESIGN_ID),
            proofRowIds: ids(parsedFields.get("SEIT proof rows"), SEIT_ID),
        });
    }
    const manifests = new Map();
    for (const [id, raw] of manifestRecords.values) {
        const parsedFields = fields(raw, [...requiredManifestFields, ...optionalManifestFields]);
        const writeSet = parsedFields.get("Write set") ?? "";
        const paths = [...writeSet.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        const writeSetClauseRejection = classifyWriteSetClause(writeSet);
        const parsedInterfaces = parsedFields.has("Shared interfaces")
            ? sharedInterfaces(parsedFields.get("Shared interfaces"))
            : undefined;
        const parsedBoundary = parsedFields.get("Integration boundary");
        const parsedParallelSafe = parsedFields.has("Parallel safe")
            ? parallelSafe(parsedFields.get("Parallel safe"))
            : undefined;
        manifests.set(id, {
            id,
            raw,
            fields: parsedFields,
            writeSetPaths: writeSetClauseRejection ? [] : paths,
            prohibitedWriteSetPaths: writeSetClauseRejection ? paths : [],
            ...(writeSetClauseRejection ? { writeSetClauseRejection } : {}),
            commandIds: ids(parsedFields.get("Command IDs"), COMMAND_ID),
            ...(parsedInterfaces !== undefined ? { sharedInterfaces: parsedInterfaces } : {}),
            ...(parsedBoundary !== undefined && !/^none[.!]?$/i.test(parsedBoundary)
                ? { integrationBoundary: parsedBoundary }
                : {}),
            ...(parsedParallelSafe !== undefined ? { parallelSafe: parsedParallelSafe } : {}),
        });
    }
    const trace = traceability(documents.seit);
    const parsedPhaseGraph = parsePhaseGraph(documents.implementation);
    const planIdSource = `${section(documents.plan, "Acceptance criteria") ?? ""}\n${section(documents.plan, "Risks and open questions") ?? ""}`;
    const identifierValues = [
        ...[...slices.values()].flatMap((slice) => ["Requirement IDs", "Design IDs", "SEIT proof rows"].map((name) => slice.fields.get(name) ?? "")),
        ...[...manifests.values()].map((manifest) => manifest.fields.get("Command IDs") ?? ""),
        ...trace.identifierValues,
        ...[...planIdSource.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]),
        ...[...documents.design.matchAll(/(?:^#{1,6}\s+|\*\*)([^*\r\n]+)(?:\*\*)?$/gm)].map((match) => match[1]),
    ];
    return {
        documents,
        slices,
        manifests,
        duplicateSliceIds: sliceRecords.duplicates,
        duplicateManifestIds: manifestRecords.duplicates,
        traceHeaders: trace.headers,
        traceRows: trace.rows,
        traceIssues: trace.issues,
        identifierValues,
        requiredCommands: trace.commands,
        planIds: declaredIds(planIdSource, PLAN_ID),
        designIds: declaredIds(documents.design, DESIGN_ID),
        waves: waveMap(documents.implementation),
        dependencies: dependencyMap(documents.implementation),
        phaseGraph: parsedPhaseGraph.entries,
        phaseGraphIssues: parsedPhaseGraph.issues,
    };
}
function finding(code, artifact, observed, required, remedy, sliceId, severity = "amendment") {
    return { code, severity, artifact, ...(sliceId ? { sliceId } : {}), observed: observed.slice(0, 512), required, remedy };
}
function multilineField(sectionText, name) {
    const start = new RegExp(`^\\*\\*${escaped(name)}\\.\\*\\*.*$`, "mi").exec(sectionText);
    if (!start || start.index === undefined)
        return false;
    const tail = sectionText.slice(start.index + start[0].length).split(/\r?\n/);
    for (const line of tail) {
        if (/^\s*(?:\*\*[^*]+\.\*\*|#{1,6}\s)/.test(line))
            return false;
        if (line.trim())
            return true;
    }
    return false;
}
function invalidIdentifiers(model) {
    const candidates = model.identifierValues
        .flatMap((value) => value.match(/\b(?:AC|RISK|DES|CONTRACT|SEIT|CMD|PROC)(?:-|_)[A-Za-z0-9._-]+\b/gi) ?? []);
    return [...new Set(candidates.filter((candidate) => {
            if (/^(?:AC|RISK)-/i.test(candidate))
                return !PLAN_ID.test(candidate);
            if (/^(?:DES|CONTRACT)-/i.test(candidate))
                return !DESIGN_ID.test(candidate);
            if (/^SEIT-/i.test(candidate))
                return !SEIT_ID.test(candidate);
            if (/^(?:CMD|PROC)-/i.test(candidate))
                return !COMMAND_ID.test(candidate);
            return true;
        }))];
}
const RECORDED_LEDGER_KEYS = new Set([
    "actor",
    "algorithmVersion",
    "answer",
    "artifacts",
    "causationId",
    "commandContentHash",
    "complexity",
    "complexityScore",
    "consequential",
    "coordination",
    "correlationId",
    "dataMigration",
    "decidedAt",
    "decisionId",
    "dependencyEdgeCount",
    "estimatedAgents",
    "estimatedTokens",
    "eventId",
    "evidenceRefs",
    "expectedConcurrency",
    "firedHardTriggers",
    "findingCount",
    "gatherQuestionsDiscovered",
    "goal",
    "hash",
    "hardTriggers",
    "improvementProposalRef",
    "integrationCheckpointCount",
    "irreversibleOperations",
    "launchAuthorized",
    "lastResultJson",
    "layer",
    "maxCrewmatesPerExplorer",
    "multiRepository",
    "ownerApprovedContentHash",
    "overridden",
    "perAgentTokenEstimate",
    "phaseCount",
    "phaseExplorerCount",
    "planDirectory",
    "planningFailure",
    "planningState",
    "previousHash",
    "providerSessionId",
    "qaJson",
    "question",
    "questionDecisionId",
    "recordedAt",
    "recommendationEventId",
    "recommendedMode",
    "recommendedOrchestration",
    "repository",
    "repositoryFitDecision",
    "requirementRefs",
    "resolvedPlanDirectory",
    "reviewBaselineRevision",
    "riskRating",
    "rubricVersion",
    "runId",
    "runtimeStateJson",
    "schemaVersion",
    "securityCriticalIntegration",
    "selection",
    "selectionModel",
    "selectionProvider",
    "selectionReasoning",
    "selectedMode",
    "sequence",
    "serviceCount",
    "sessionId",
    "sharedFileOverlapCount",
    "sliceCount",
    "stage",
    "status",
    "subExplorerCount",
    "threshold",
    "title",
    "tokens",
    "tradeoffs",
    "type",
    "verification",
    "verdict",
    "workItems",
]);
function explicitInputReferences(sectionText, fieldName) {
    const value = field(sectionText, fieldName);
    if (!value)
        return [];
    const references = [];
    const seen = new Set();
    for (const match of value.matchAll(/\b(metric denominator|ledger key|contract field)\s+`([^`]+)`/gi)) {
        const kind = match[1].toLowerCase();
        const name = match[2];
        if (name.length > 128 || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(name))
            continue;
        const key = `${kind}\u0000${name}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        references.push({ kind, name });
    }
    return references;
}
function isRecordedLedgerKey(name) {
    if (RECORDED_LEDGER_KEYS.has(name))
        return true;
    const payloadKey = /^payload\.([A-Za-z][A-Za-z0-9]*)$/.exec(name)?.[1];
    return payloadKey !== undefined && RECORDED_LEDGER_KEYS.has(payloadKey);
}
export function structuralFindings(model) {
    const findings = [];
    const push = (...value) => { findings.push(finding(...value)); };
    for (const [artifact, content, type] of [
        ["plan-spec.md", model.documents.plan, "plan-spec"],
        ["design.md", model.documents.design, "design"],
        ["seit.md", model.documents.seit, "seit"],
        ["implementation.md", model.documents.implementation, "implementation"],
    ]) {
        if (!artifactComplete(content, type, []))
            push("artifact_frontmatter_invalid", artifact, "invalid or incomplete frontmatter", `type: ${type} and status: complete or amended`, "repair the artifact frontmatter");
    }
    for (const heading of ["Required Commands", "Traceability Matrix", "Cross-cutting Checks"]) {
        if (!sectionPresent(model.documents.seit, heading))
            push("seit_section_missing", "seit.md", heading, `non-empty ${heading} section`, `add the ${heading} section`);
    }
    for (const heading of ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) {
        if (!sectionPresent(model.documents.design, heading))
            push("design_section_missing", "design.md", heading, `non-empty ${heading} section`, `add the ${heading} section`);
    }
    for (const [id, slice] of model.slices) {
        for (const name of requiredSliceFields) {
            if (!slice.fields.get(name))
                push("slice_field_missing", "implementation.md", name, `non-empty ${name} field`, `add ${name} to Slice ${id}`, id);
        }
        const goal = slice.fields.get("Goal");
        if (goal && (goal.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(goal))) {
            push("goal_unbounded", "implementation.md", `${goal.length} characters`, "Goal must be bounded Focus text with at most 512 characters and no control characters", "repair or shorten the Goal", id);
        }
        if (!slice.requirementIds.size)
            push("id_unknown", "implementation.md", slice.fields.get("Requirement IDs") ?? "", "Requirement IDs must contain at least one defined AC or RISK id", "add a defined requirement id", id);
        if (!slice.designIds.size)
            push("id_unknown", "implementation.md", slice.fields.get("Design IDs") ?? "", "Design IDs must contain at least one defined DES or CONTRACT id", "add a defined design id", id);
        if (!slice.proofRowIds.size)
            push("id_unknown", "implementation.md", slice.fields.get("SEIT proof rows") ?? "", "SEIT proof rows must contain at least one defined SEIT id", "add a defined proof row id", id);
    }
    // Keyed by kind AND name: a metric denominator, a ledger key, and a contract field are distinct
    // input domains, so a producer of one must not satisfy a declared input of another merely because
    // the names match.
    const producedKey = (kind, name) => `${kind} ${name}`;
    const producedInputs = new Set([...model.slices.values()].flatMap((slice) => explicitInputReferences(slice.raw, "Produces").map((reference) => producedKey(reference.kind, reference.name))));
    for (const [id, slice] of model.slices) {
        for (const input of explicitInputReferences(slice.raw, "Inputs")) {
            if (producedInputs.has(producedKey(input.kind, input.name)) || isRecordedLedgerKey(input.name))
                continue;
            push("input_unproduced", "implementation.md", `${input.kind}: ${input.name}`, "every explicitly declared input must name a producer in the plan or an existing recorded ledger key", `declare a producer for ${input.name} or remove the unsupported input`, id);
        }
    }
    const allPaths = new Set([...model.manifests.values()].flatMap((manifest) => manifest.writeSetPaths));
    const allCommands = new Set([...model.manifests.values()].flatMap((manifest) => [...manifest.commandIds]));
    const recognizedNoWritePlan = [...model.manifests.values()].some((manifest) => /\b(?:none|no writes?(?: required)?|no (?:new|required|source|product) files?)\b/i.test(manifest.fields.get("Write set") ?? ""));
    if (model.manifests.size && !allPaths.size && !recognizedNoWritePlan)
        push("writeset_empty", "implementation.md", "plan declares no writable path", "the execution boundary requires at least one literal writable path", "assign at least one bounded write target");
    if (allPaths.size > MAX_ITEMS)
        push("writeset_unsafe_path", "implementation.md", `${allPaths.size} unique paths`, `write sets may aggregate at most ${MAX_ITEMS} paths`, "split the execution contract");
    if (allCommands.size > MAX_ITEMS)
        push("command_undeclared", "implementation.md", `${allCommands.size} unique commands`, `manifests may aggregate at most ${MAX_ITEMS} commands`, "reduce the evidence command set");
    for (const [id, manifest] of model.manifests) {
        for (const name of requiredManifestFields) {
            if (!manifest.fields.get(name))
                push("manifest_field_missing", "implementation.md", name, `non-empty ${name} field`, `add ${name} to the ${id} execution manifest`, id);
        }
        const writeSet = manifest.fields.get("Write set") ?? "";
        const noWrites = /\b(?:none|no writes?(?: required)?)\b/i.test(writeSet);
        if (multilineField(manifest.raw, "Write set"))
            push("writeset_multiline", "implementation.md", writeSet, "Write set must fit on the field line", "move every write target onto the Write set line", id);
        if (!noWrites && manifest.writeSetPaths.length && !/\bonly\b/i.test(writeSet))
            push("writeset_missing_only", "implementation.md", writeSet, "Write set must contain the literal word only", "state the bounded paths as write-only targets", id);
        if (noWrites || !manifest.writeSetPaths.length)
            push("writeset_empty", "implementation.md", writeSet, "each executable slice must declare one or more literal paths", "assign a bounded write target", id);
        const seen = new Set();
        for (const path of [...writeSet.matchAll(/`([^`]+)`/g)].map((match) => match[1])) {
            const issue = writeSetPathIssue(path);
            if (issue)
                push(issue.code, "implementation.md", path, issue.reason, "replace it with a bounded normalized repository-relative literal", id);
            if (seen.has(path))
                push("writeset_duplicate", "implementation.md", path, "each path may appear once per write set", "remove the duplicate path", id);
            seen.add(path);
        }
        if (manifest.writeSetClauseRejection) {
            push("writeset_readonly_harvest", "implementation.md", manifest.writeSetClauseRejection.clause, manifest.writeSetClauseRejection.reason, "Restate the prohibition in prose without backticks, per planning contract rule 5.", id);
        }
        for (const command of manifest.commandIds) {
            if (command === "CMD-BUILD")
                push("build_command_in_manifest", "implementation.md", command, "CMD-BUILD must run only after Focus validation", "remove CMD-BUILD from the slice manifest", id);
        }
        const interfaces = manifest.fields.get("Shared interfaces");
        if (interfaces !== undefined && sharedInterfaces(interfaces) === undefined) {
            push("optional_manifest_malformed", "implementation.md", interfaces, "Shared interfaces must be `literal` identifiers or none", "replace wildcard or malformed interface identifiers", id);
        }
        const boundary = manifest.fields.get("Integration boundary");
        if (boundary !== undefined && !validIntegrationBoundary(boundary)) {
            push("optional_manifest_malformed", "implementation.md", boundary, "Integration boundary must be a bounded literal name or none", "replace wildcard or malformed boundary text", id);
        }
        const parallel = manifest.fields.get("Parallel safe");
        if (parallel !== undefined && parallelSafe(parallel) === undefined) {
            push("optional_manifest_malformed", "implementation.md", parallel, "Parallel safe must be yes or no followed by a reason", "add a bounded reason after yes or no", id);
        }
    }
    const manifestEntries = [...model.manifests.entries()];
    for (let left = 0; left < manifestEntries.length; left += 1) {
        for (let right = left + 1; right < manifestEntries.length; right += 1) {
            const [leftId, leftManifest] = manifestEntries[left];
            const [rightId, rightManifest] = manifestEntries[right];
            if (!leftManifest.parallelSafe && !rightManifest.parallelSafe)
                continue;
            const rightPaths = new Set(rightManifest.writeSetPaths);
            const overlap = [...new Set(leftManifest.writeSetPaths.filter((path) => rightPaths.has(path)))];
            const declaredIndependenceConflict = leftManifest.parallelSafe === true
                && rightManifest.parallelSafe === true
                && !provenIndependent({
                    writeSet: leftManifest.writeSetPaths,
                    interfaceTags: leftManifest.sharedInterfaces ?? [],
                    environmentTags: [],
                    integrationBoundaryTags: leftManifest.integrationBoundary === undefined
                        ? []
                        : [leftManifest.integrationBoundary],
                    parallelSafe: leftManifest.parallelSafe,
                }, {
                    writeSet: rightManifest.writeSetPaths,
                    interfaceTags: rightManifest.sharedInterfaces ?? [],
                    environmentTags: [],
                    integrationBoundaryTags: rightManifest.integrationBoundary === undefined
                        ? []
                        : [rightManifest.integrationBoundary],
                    parallelSafe: rightManifest.parallelSafe,
                });
            if (!overlap.length && !declaredIndependenceConflict)
                continue;
            findings.push(finding("parallel_safety_conflict", "implementation.md", overlap.length
                ? `${leftId}, ${rightId}: ${overlap.join(", ")}`
                : `${leftId}, ${rightId}: write sets are not provably disjoint`, "slices declaring Parallel safe yes must have provably disjoint write sets", "declare Parallel safe no or separate the write sets"));
        }
    }
    for (const issue of model.phaseGraphIssues) {
        push("phase_graph_malformed", "implementation.md", issue, "Phase graph must contain bounded phase, slice, dependency, and checkpoint values", "repair or remove the optional Phase graph");
    }
    if (model.phaseGraph.length) {
        const phaseIds = new Set(model.phaseGraph.map((phase) => phase.phaseId));
        const memberships = model.phaseGraph.flatMap((phase) => phase.sliceIds);
        if (phaseIds.size !== model.phaseGraph.length
            || memberships.length !== new Set(memberships).size
            || new Set(memberships).size !== model.slices.size
            || memberships.some((sliceId) => !model.slices.has(sliceId))
            || model.phaseGraph.some((phase) => phase.dependsOnPhases.some((dependency) => dependency === phase.phaseId || !phaseIds.has(dependency)))) {
            push("phase_graph_malformed", "implementation.md", "Phase graph membership or dependencies do not match the declared plan", "phase ids and slice membership must be unique and dependencies must name another declared phase", "repair or remove the optional Phase graph");
        }
    }
    const sliceIds = new Set(model.slices.keys());
    const manifestIds = new Set(model.manifests.keys());
    if (!sliceIds.size
        || !manifestIds.size
        || sliceIds.size > MAX_ITEMS
        || manifestIds.size > MAX_ITEMS
        || model.duplicateSliceIds.size
        || model.duplicateManifestIds.size
        || sliceIds.size !== manifestIds.size
        || [...sliceIds].some((id) => !manifestIds.has(id)))
        push("slice_manifest_mismatch", "implementation.md", `slices=${[...sliceIds].join(",")} manifests=${[...manifestIds].join(",")}`, "slice and manifest ids must be unique and equal", "make the slice and manifest id sets match");
    for (const invalid of invalidIdentifiers(model))
        push("id_format_invalid", "implementation.md", invalid, "identifiers must match their closed prefix grammar", "replace the malformed identifier");
    for (const [id, slice] of model.slices) {
        for (const value of slice.requirementIds)
            if (!model.planIds.has(value))
                push("id_unknown", "implementation.md", value, "slice requirement ids must be defined in plan-spec.md", "define or remove the identifier", id);
        for (const value of slice.designIds)
            if (!model.designIds.has(value))
                push("id_unknown", "implementation.md", value, "slice design ids must be defined in design.md", "define or remove the identifier", id);
        for (const value of slice.proofRowIds)
            if (!model.traceRows.has(value))
                push("id_unknown", "implementation.md", value, "slice SEIT ids must name a traceability row", "define or remove the identifier", id);
    }
    if (model.traceHeaders.length !== TRACE_HEADERS.length
        || new Set(model.traceHeaders).size !== TRACE_HEADERS.length
        || TRACE_HEADERS.some((header) => !model.traceHeaders.includes(header))) {
        push("trace_header_invalid", "seit.md", model.traceHeaders.join(", "), `the matrix must contain exactly the ${TRACE_HEADERS.length} required columns`, "restore the required traceability header");
    }
    for (const issue of model.traceIssues) {
        push("trace_header_invalid", "seit.md", issue.observed, issue.reason, "repair the malformed traceability row");
    }
    const matrix = section(model.documents.seit, "Traceability Matrix") ?? "";
    const table = matrix.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
    for (const line of table.slice(2)) {
        const values = tableCells(line);
        const placeholder = TRACE_HEADERS.find((header) => {
            const index = model.traceHeaders.indexOf(header);
            return index >= 0 && (!values[index] || /^(?:-|tbd|todo|n\/a)$/i.test(values[index]));
        });
        if (placeholder)
            push("trace_cell_placeholder", "seit.md", `${placeholder}: ${values[model.traceHeaders.indexOf(placeholder)] ?? ""}`, "every required traceability cell must contain evidence", "replace the placeholder");
    }
    for (const match of model.documents.implementation.matchAll(/\bSlice\s+([A-Za-z]+\d+|\d+(?:\.\d+)+)\b/g)) {
        if (!sliceIds.has(match[1]))
            push("slice_reference_dangling", "implementation.md", match[1], "every Slice reference must name a declared slice", "declare or remove the dangling reference");
    }
    const dependencyIds = new Set([
        ...model.dependencies.keys(),
        ...[...model.dependencies.values()].flatMap((targets) => [...targets]),
    ]);
    for (const id of dependencyIds) {
        if (!sliceIds.has(id))
            push("slice_reference_dangling", "implementation.md", id, "every dependency endpoint must name a declared slice", "declare or remove the dangling dependency");
    }
    const waveNumbers = [...model.waves.keys()];
    const maxWave = waveNumbers.length ? Math.max(...waveNumbers) : 0;
    const membership = new Map();
    for (const members of model.waves.values()) {
        for (const id of members)
            membership.set(id, (membership.get(id) ?? 0) + 1);
    }
    const invalidMembership = (sliceIds.size > 1 || waveNumbers.length > 0)
        && ([...sliceIds].some((id) => membership.get(id) !== 1) || [...membership].some(([id, count]) => !sliceIds.has(id) || count !== 1));
    if (sliceIds.size > 1 && !waveNumbers.length || waveNumbers.length && (maxWave < 1 || waveNumbers.length !== maxWave || [...Array(maxWave).keys()].some((index) => !model.waves.has(index + 1))) || invalidMembership) {
        push("wave_noncontiguous", "implementation.md", waveNumbers.join(", "), "waves must be exactly 1 through N, and multi-slice plans must declare waves", "repair the wave sequence");
    }
    for (const [id, manifest] of model.manifests) {
        const slice = model.slices.get(id);
        const mappedCommands = new Set([...(slice?.proofRowIds ?? [])].flatMap((row) => [...(model.traceRows.get(row)?.commands ?? [])]));
        if (!manifest.commandIds.size)
            push("command_undeclared", "implementation.md", "no command ids", "each manifest needs a declared and traceable command", "add an evidence command", id);
        for (const command of manifest.commandIds) {
            if (!model.requiredCommands.has(command) || !mappedCommands.has(command))
                push("command_undeclared", "implementation.md", command, "manifest commands must be declared and reachable through the slice proof rows", "declare and trace the command", id);
        }
    }
    return findings;
}
