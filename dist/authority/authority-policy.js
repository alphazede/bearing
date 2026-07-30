/** Pure, fail-closed authority checks; durable evidence is supplied by a caller. */
import { ROLES } from "../profile/profile.js";
import { isDurableOwnerEvidence } from "../workflow/aggregate.js";
export const AUTHORITY_POLICY_SCHEMA_VERSION = 1;
const MAX_TEXT = 128;
const MAX_TOOLS = 64;
const roles = new Set([...ROLES, "trail-boss", "sub-explorer"]);
const actions = new Set(["recommend", "execute", "certify"]);
function text(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, keys, optional = []) {
    return Object.keys(value).every((key) => keys.includes(key)) && keys.filter((key) => !optional.includes(key)).every((key) => key in value);
}
function facts(value) {
    if (!object(value) || !exactKeys(value, ["schemaVersion", "role", "action", "tool", "allowedTools", "sessionId", "executionAncestry", "evidence", "executionMode", "certifiedExecutionSessionId"], ["evidence", "executionMode", "certifiedExecutionSessionId"]))
        return false;
    return value.schemaVersion === AUTHORITY_POLICY_SCHEMA_VERSION
        && typeof value.role === "string" && roles.has(value.role)
        && typeof value.action === "string" && actions.has(value.action)
        && text(value.tool)
        && Array.isArray(value.allowedTools) && value.allowedTools.length <= MAX_TOOLS && value.allowedTools.every(text) && new Set(value.allowedTools).size === value.allowedTools.length
        && text(value.sessionId)
        && Array.isArray(value.executionAncestry) && value.executionAncestry.length <= MAX_TOOLS && value.executionAncestry.every(text) && new Set(value.executionAncestry).size === value.executionAncestry.length
        && (value.evidence === undefined || isDurableOwnerEvidence(value.evidence))
        && (value.executionMode === undefined || value.executionMode === "explorer" || value.executionMode === "expedition")
        && (value.certifiedExecutionSessionId === undefined || text(value.certifiedExecutionSessionId));
}
export class AuthorityPolicy {
    evaluate(input) {
        if (!facts(input))
            return deny("authority_facts_invalid");
        if (!input.allowedTools.includes(input.tool))
            return deny("authority_tool_denied");
        if (input.role === "surveyor" && input.executionAncestry.length > 0)
            return deny("authority_surveyor_ancestry_denied");
        if (input.action === "execute" && input.role === "surveyor")
            return deny("authority_surveyor_not_executor");
        if (input.action === "certify") {
            if (input.role !== "surveyor")
                return deny("authority_role_denied");
            if (!input.certifiedExecutionSessionId)
                return deny("authority_facts_invalid");
            if (input.sessionId === input.certifiedExecutionSessionId || input.executionAncestry.includes(input.certifiedExecutionSessionId))
                return deny("authority_self_certification");
            return { allowed: true };
        }
        if (input.action === "execute") {
            if (!input.evidence)
                return deny("authority_approval_missing");
            if (input.role === "trail-boss" && input.executionMode === "explorer")
                return deny("authority_execution_mode_denied");
            if (!input.executionMode || input.evidence.selectedMode !== input.executionMode)
                return deny("authority_execution_mode_denied");
            return { allowed: true };
        }
        return { allowed: true };
    }
}
export function evaluateAuthority(input) {
    return new AuthorityPolicy().evaluate(input);
}
function deny(code) {
    return { allowed: false, code };
}
