import { isAbsolute, posix } from "node:path";
import { provenIndependent } from "../execution/concurrency-control.js";
const MAX_TEXT = 4096;
const MAX_ITEMS = 128;
// Headings capture the complete first non-whitespace id token; the token must
// then pass the closed slice id grammar, so a separator like "/" or ":" (or a
// hyphen) can never be read as a truncated valid id.
const SLICE_HEADING = /^###\s+Slice\s+(?<id>[A-Za-z0-9]\S*).*$/gm;
const MANIFEST_HEADING = /^###\s+(?<id>[A-Za-z0-9]\S*)\s+execution manifest\s*$/gmi;
const SLICE_ID_FORMAT = /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/;
// Wave, dependency, phase-graph, and prose references match the same strict
// token so a hyphenated id is never read as a truncated valid one. A period
// closes a sentence but opens a dotted id only when a digit follows it.
const SLICE_ID_MATCH = /\b(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)(?![A-Za-z0-9_-]|\.\d)/g;
const PLAN_ID = /^(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*$/i;
const DESIGN_ID = /^(?:DES|CONTRACT)-[A-Z0-9][A-Z0-9.-]*$/i;
const SEIT_ID = /^SEIT-[A-Z0-9][A-Z0-9.-]*$/i;
const COMMAND_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/i;
// System ids follow the closed SEIT- prefix grammar: uppercase letters, digits,
// dots, or hyphens after the SYS- prefix, never underscores.
const SYS_REFERENCE = /\bSYS-[A-Za-z0-9][A-Za-z0-9.-]*\b/gi;
// The risk profile is a closed enumeration of surface flags a plan can
// declare in plan-spec.md. Flag ids are lowercase words joined by
// underscores, mirroring the typed id grammar of the other plan artifacts.
const KNOWN_RISK_FLAGS = [
    "moves_money",
    "live_financial_action",
    "agentic_tools",
    "untrusted_external_content",
    "personal_or_behavioral_data",
    "multi_user",
    "multi_tenant",
    "company_customers",
    "public_api_or_sdk",
    "external_webhooks_and_providers",
    "regulated_or_sanctions_exposure",
    "production_service",
    "availability_required",
    "automatic_external_issue_creation",
];
const RISK_PROFILE_HEADING = /^##[ \t]+Risk Profile[ \t]*$/mi;
const RISK_PROFILE_COLUMNS = ["flag", "applies", "coverage or rationale"];
const RISK_COVERAGE_KIND = /^(design|system|seit|slice)\s*:\s*(.+)$/i;
const RISK_SYSTEM_TOKEN = /^SYS-[A-Za-z0-9][A-Za-z0-9.-]*$/i;
const SYSTEM_CATALOG_HEADING = /^##[ \t]+System Catalog[ \t]*$/mi;
const SYSTEM_TRACE_HEADING = /^##[ \t]+Requirement Trace[ \t]*$/mi;
const SYSTEM_SPEC_HEADING = /^SYS-[A-Za-z0-9][A-Za-z0-9.-]*\b/i;
const SYSTEM_CATALOG_COLUMNS = ["system id", "system", "responsibility"];
const SYSTEM_TRACE_COLUMNS = ["requirement id", "system id", "contract id", "seit row id", "slice id", "path"];
export const requiredSystemSpecFields = [
    "Ownership",
    "Inputs",
    "Outputs",
    "APIs",
    "Data ownership",
    "Invariants",
    "Trust boundary",
    "Failure modes",
    "Observability",
];
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
    const invalid = [];
    for (const match of wanted) {
        const id = match.groups?.id;
        if (!id)
            continue;
        const start = match.index ?? 0;
        const end = allHeadings.find((heading) => (heading.index ?? 0) > start)?.index ?? content.length;
        if (!SLICE_ID_FORMAT.test(id)) {
            invalid.push(id);
            continue;
        }
        if (values.has(id))
            duplicates.add(id);
        else
            values.set(id, content.slice(start, end));
    }
    return { values, duplicates, invalid };
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
const NARRATIVE_FIELDS = ["Command", "Positive case", "Negative case", "Evidence", "Evidence target"];
const NARRATIVE_ROW_ID = /^SEIT-[A-Za-z0-9][A-Za-z0-9.-]*\b/i;
/**
 * Procedure narratives are `### SEIT-<id> <title>` subsections of the seit
 * `## ... Procedures` section. Each narrative restates the traceability row's
 * command, positive case, negative case, and evidence target so the validator
 * can detect meaning drift between the matrix and the executable procedure.
 */
function procedureNarratives(seitDocument) {
    const headings = [...seitDocument.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*\r?$/gm)].map((match) => ({
        level: match[1].length,
        title: match[2].trim(),
        start: match.index ?? 0,
        contentStart: match.index + match[0].length,
    }));
    const narratives = new Map();
    for (let index = 0; index < headings.length; index += 1) {
        const section = headings[index];
        if (section.level !== 2 || !/procedur/i.test(section.title))
            continue;
        const sectionEnd = headings.slice(index + 1).find((candidate) => candidate.level <= 2)?.start ?? seitDocument.length;
        for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
            const heading = headings[cursor];
            if (heading.start >= sectionEnd)
                break;
            if (heading.level !== 3)
                continue;
            const rowId = NARRATIVE_ROW_ID.exec(heading.title)?.[0]?.toUpperCase();
            if (!rowId)
                continue;
            const bodyEnd = headings.slice(cursor + 1).find((candidate) => candidate.start < sectionEnd && candidate.level <= 3)?.start ?? sectionEnd;
            const body = seitDocument.slice(heading.contentStart, bodyEnd).trim();
            const parsedFields = fields(body, NARRATIVE_FIELDS);
            const entries = narratives.get(rowId) ?? [];
            entries.push({
                rowId,
                heading: heading.title,
                commandIds: ids(parsedFields.get("Command"), COMMAND_ID),
                fields: parsedFields,
            });
            narratives.set(rowId, entries);
        }
    }
    return narratives;
}
function sysIds(value) {
    if (!value)
        return new Set();
    return new Set([...value.matchAll(SYS_REFERENCE)].map((match) => match[0].toUpperCase()));
}
/**
 * The system map is an opt-in maturity convention: a design adopts it by
 * titling a section `## System Catalog`. The catalog is a table of stable
 * SYS- ids; each entry resolves to a `### SYS-<id>` per-system specification
 * inside the same section; an optional `## Requirement Trace` table carries
 * the requirement-to-system chain, and the closure that every declared
 * requirement reaches a trace row is enforced only when the table is
 * present. Designs that never declare the section have no system map, so
 * nothing here demands one from them.
 */
function systemMap(designDocument) {
    const adopted = SYSTEM_CATALOG_HEADING.test(designDocument);
    if (!adopted) {
        return { adopted, catalog: new Map(), catalogIssues: [], specs: new Map(), traceRows: [], traceIssues: [], references: new Set() };
    }
    const catalog = new Map();
    const catalogIssues = [];
    // The catalog table is the contiguous pipe block before the first
    // `### SYS-` specification; per-system specification bodies may carry their
    // own tables, which must never be read as catalog rows.
    const catalogSection = section(designDocument, "System Catalog") ?? "";
    const catalogTable = catalogSection.split(/^###[ \t]/m)[0].split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
    if (!catalogTable.length) {
        catalogIssues.push("System Catalog section is empty");
    }
    else {
        const headers = tableCells(catalogTable[0]).map((value) => value.toLowerCase());
        if (headers.length !== SYSTEM_CATALOG_COLUMNS.length || SYSTEM_CATALOG_COLUMNS.some((column) => !headers.includes(column))) {
            catalogIssues.push(`System Catalog table is missing a required column: ${catalogTable[0]}`);
        }
        else {
            const cell = (values, header) => values[headers.indexOf(header)] ?? "";
            for (const line of catalogTable.slice(2)) {
                const values = tableCells(line);
                if (values.length !== headers.length) {
                    catalogIssues.push(`System Catalog row width does not match: ${line}`);
                    continue;
                }
                const ids = sysIds(cell(values, "system id"));
                if (ids.size !== 1) {
                    catalogIssues.push(`System Catalog rows must contain exactly one typed SYS- id: ${line}`);
                    continue;
                }
                const id = [...ids][0];
                if (catalog.has(id)) {
                    catalogIssues.push(`System Catalog ids must be unique: ${id}`);
                    continue;
                }
                catalog.set(id, { id, raw: line });
            }
        }
    }
    const headings = [...designDocument.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*\r?$/gm)].map((match) => ({
        level: match[1].length,
        title: match[2].trim(),
        start: match.index ?? 0,
        contentStart: (match.index ?? 0) + match[0].length,
    }));
    const catalogIndex = headings.findIndex((heading) => heading.level === 2
        && heading.title.localeCompare("System Catalog", undefined, { sensitivity: "accent" }) === 0);
    const sectionEnd = catalogIndex < 0
        ? -1
        : headings.slice(catalogIndex + 1).find((candidate) => candidate.level <= 2)?.start ?? designDocument.length;
    const specs = new Map();
    for (let index = catalogIndex + 1; catalogIndex >= 0 && index < headings.length; index += 1) {
        const heading = headings[index];
        if (heading.start >= sectionEnd)
            break;
        if (heading.level !== 3)
            continue;
        const id = SYSTEM_SPEC_HEADING.exec(heading.title)?.[0]?.toUpperCase();
        if (!id)
            continue;
        if (specs.has(id)) {
            catalogIssues.push(`per-system specifications must be unique: ${id}`);
            continue;
        }
        const bodyEnd = headings.slice(index + 1).find((candidate) => candidate.start < sectionEnd && candidate.level <= 3)?.start ?? sectionEnd;
        const body = designDocument.slice(heading.contentStart, bodyEnd).trim();
        specs.set(id, { id, heading: heading.title, fields: fields(body, requiredSystemSpecFields) });
    }
    const traceRows = [];
    const traceIssues = [];
    if (SYSTEM_TRACE_HEADING.test(designDocument)) {
        const traceTable = (section(designDocument, "Requirement Trace") ?? "").split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
        if (!traceTable.length) {
            traceIssues.push("Requirement Trace section is empty");
        }
        else {
            const headers = tableCells(traceTable[0]).map((value) => value.toLowerCase());
            if (headers.length !== SYSTEM_TRACE_COLUMNS.length || SYSTEM_TRACE_COLUMNS.some((column) => !headers.includes(column))) {
                traceIssues.push(`Requirement Trace table is missing a required column: ${traceTable[0]}`);
            }
            else {
                const cell = (values, header) => values[headers.indexOf(header)] ?? "";
                for (const line of traceTable.slice(2)) {
                    const values = tableCells(line);
                    if (values.length !== headers.length) {
                        traceIssues.push(`Requirement Trace row width does not match: ${line}`);
                        continue;
                    }
                    const requirements = ids(cell(values, "requirement id"), PLAN_ID);
                    const systems = sysIds(cell(values, "system id"));
                    if (!requirements.size || !systems.size) {
                        traceIssues.push(`Requirement Trace rows must contain typed requirement and system ids: ${line}`);
                        continue;
                    }
                    traceRows.push({
                        requirements,
                        systems,
                        contracts: ids(cell(values, "contract id"), DESIGN_ID),
                        seits: ids(cell(values, "seit row id"), SEIT_ID),
                        slices: new Set(cell(values, "slice id").match(SLICE_ID_MATCH) ?? []),
                        paths: [...cell(values, "path").matchAll(/`([^`]+)`/g)].map((match) => match[1]),
                    });
                }
            }
        }
    }
    const references = new Set([...designDocument.matchAll(SYS_REFERENCE)].map((match) => match[0].toUpperCase()));
    return { adopted, catalog, catalogIssues, specs, traceRows, traceIssues, references };
}
/**
 * The risk profile is an opt-in risk declaration: a plan adopts it by
 * titling a `## Risk Profile` section in plan-spec.md. The section is a
 * Markdown table with the Flag, Applies, and Coverage or rationale columns
 * that must enumerate every known risk flag. A `yes` flag maps
 * cross-artifact coverage clauses (`design:` section or `system:` SYS- id,
 * `seit:` rows, `slice:` ids); a `no` flag carries the not-applicable
 * rationale instead. Plans that never declare the section have no risk
 * profile, so nothing here demands one from them.
 */
function riskProfile(planDocument) {
    const adopted = RISK_PROFILE_HEADING.test(planDocument);
    if (!adopted)
        return { adopted: false, flags: new Map(), issues: [] };
    const profileSection = section(planDocument, "Risk Profile") ?? "";
    const table = profileSection.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
    if (!table.length) {
        return { adopted, flags: new Map(), issues: ["Risk Profile section is empty"] };
    }
    const headers = tableCells(table[0]).map((value) => value.toLowerCase());
    if (headers.length !== RISK_PROFILE_COLUMNS.length || RISK_PROFILE_COLUMNS.some((column) => !headers.includes(column))) {
        return { adopted, flags: new Map(), issues: [`Risk Profile table is missing a required column: ${table[0]}`] };
    }
    const flags = new Map();
    const issues = [];
    const cell = (values, header) => values[headers.indexOf(header)] ?? "";
    for (const line of table.slice(2)) {
        const values = tableCells(line);
        if (values.length !== headers.length) {
            issues.push(`Risk Profile row width does not match: ${line}`);
            continue;
        }
        const flag = cell(values, "flag").trim();
        const applies = cell(values, "applies").trim().toLowerCase();
        const body = cell(values, "coverage or rationale").trim();
        if (!KNOWN_RISK_FLAGS.includes(flag)) {
            issues.push(`unknown risk flag: ${flag}`);
            continue;
        }
        if (applies !== "yes" && applies !== "no") {
            issues.push(`Risk Profile flag ${flag} must declare applies yes or no: ${applies}`);
            continue;
        }
        if (flags.has(flag)) {
            issues.push(`Risk Profile flags must be unique: ${flag}`);
            continue;
        }
        if (applies === "yes") {
            flags.set(flag, parseRiskCoverage(flag, body, issues));
        }
        else {
            flags.set(flag, { applies, clauses: [], rationale: body, coverageIssues: [] });
        }
    }
    // A declared profile is a complete risk declaration: every known flag must
    // be enumerated, because an absent row would otherwise silently re-open
    // the gap the profile exists to close.
    for (const flag of KNOWN_RISK_FLAGS) {
        if (!flags.has(flag))
            issues.push(`Risk Profile is missing the ${flag} flag`);
    }
    return { adopted, flags, issues };
}
function parseRiskCoverage(flag, body, issues) {
    const clauses = [];
    const coverageIssues = [];
    for (const clause of body.split(";")) {
        const match = RISK_COVERAGE_KIND.exec(clause.trim());
        if (!match) {
            coverageIssues.push(`${flag}: coverage clause must name design, system, seit, or slice: ${clause.trim()}`);
            continue;
        }
        const kind = match[1].toLowerCase();
        const value = match[2].trim();
        if (!value || value.length > MAX_TEXT) {
            coverageIssues.push(`${flag}: coverage clause must carry a bounded value: ${clause.trim()}`);
            continue;
        }
        if (kind === "system") {
            for (const token of value.split(",").map((part) => part.trim()).filter(Boolean)) {
                if (!RISK_SYSTEM_TOKEN.test(token))
                    coverageIssues.push(`${flag}: system coverage must name a typed SYS- id: ${token}`);
                else
                    clauses.push({ kind, value: token.toUpperCase() });
            }
        }
        else if (kind === "seit") {
            for (const token of value.split(",").map((part) => part.trim()).filter(Boolean)) {
                if (!SEIT_ID.test(token))
                    coverageIssues.push(`${flag}: SEIT coverage must name typed SEIT- row ids: ${token}`);
                else
                    clauses.push({ kind, value: token.toUpperCase() });
            }
        }
        else if (kind === "slice") {
            for (const token of value.split(",").map((part) => part.trim()).filter(Boolean)) {
                if (!SLICE_ID_FORMAT.test(token))
                    coverageIssues.push(`${flag}: slice coverage must name typed slice ids: ${token}`);
                else
                    clauses.push({ kind, value: token });
            }
        }
        else {
            clauses.push({ kind, value });
        }
    }
    return { applies: "yes", clauses, rationale: "", coverageIssues };
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
            const sliceIds = declared.match(SLICE_ID_MATCH) ?? [];
            const members = waves.get(Number(declaration[1])) ?? new Set();
            sliceIds.forEach((id) => members.add(id));
            waves.set(Number(declaration[1]), members);
        }
    }
    return waves;
}
function dependencyMap(implementationDocument) {
    const result = new Map();
    const identifier = SLICE_ID_MATCH;
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
        const sliceIds = plainCell(cells[slicesColumn] ?? "").match(SLICE_ID_MATCH) ?? [];
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
    const narratives = procedureNarratives(documents.seit);
    const parsedPhaseGraph = parsePhaseGraph(documents.implementation);
    const systemMapResult = systemMap(documents.design);
    const riskProfileResult = riskProfile(documents.plan);
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
        malformedRecordIds: [...new Set([...sliceRecords.invalid, ...manifestRecords.invalid])],
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
        procedureNarratives: narratives,
        systemCatalogAdopted: systemMapResult.adopted,
        systemCatalog: systemMapResult.catalog,
        systemCatalogIssues: systemMapResult.catalogIssues,
        systemSpecs: systemMapResult.specs,
        systemTraceRows: systemMapResult.traceRows,
        systemTraceIssues: systemMapResult.traceIssues,
        sysReferences: systemMapResult.references,
        riskProfileAdopted: riskProfileResult.adopted,
        riskProfile: riskProfileResult.flags,
        riskProfileIssues: riskProfileResult.issues,
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
const RISK_PROFILE_REQUIRED = "the Risk Profile must be a Markdown table with the Flag, Applies, and Coverage or rationale columns enumerating every known flag with applies yes or no, each yes flag mapping a design section or SYS- system, a SEIT row, and a slice, and each no flag carrying an evidence-backed rationale";
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
    if (model.systemCatalogAdopted) {
        for (const issue of model.systemCatalogIssues) {
            push("system_map_malformed", "design.md", issue, "the System Catalog must be a Markdown table with the System ID, System, and Responsibility columns and exactly one typed, unique SYS- id per row", "repair the catalog table");
        }
        for (const issue of model.systemTraceIssues) {
            push("system_map_malformed", "design.md", issue, "the Requirement Trace must be a Markdown table with typed Requirement ID, System ID, Contract ID, SEIT row ID, Slice ID, and Path columns", "repair the trace table");
        }
        if (model.systemCatalog.size > MAX_ITEMS) {
            push("system_map_malformed", "design.md", `${model.systemCatalog.size} catalog entries`, `system catalogs may declare at most ${MAX_ITEMS} entries`, "split the system map");
        }
    }
    if (model.riskProfileAdopted) {
        for (const issue of model.riskProfileIssues) {
            push("risk_profile_malformed", "plan-spec.md", issue, RISK_PROFILE_REQUIRED, "repair the Risk Profile table");
        }
        for (const entry of model.riskProfile.values()) {
            for (const issue of entry.coverageIssues) {
                push("risk_profile_malformed", "plan-spec.md", issue, RISK_PROFILE_REQUIRED, "repair the coverage clause");
            }
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
    for (const invalid of model.malformedRecordIds) {
        push("id_format_invalid", "implementation.md", invalid, "slice and manifest ids must be a letter-run followed by a number (S1) or a dotted number (1.2) and must never contain a hyphen", "rename the slice and manifest id");
    }
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
    for (const match of model.documents.implementation.matchAll(/\bSlice\s+((?:[A-Za-z]+\d+|\d+(?:\.\d+)+)(?![A-Za-z0-9_-]|\.\d))/g)) {
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
