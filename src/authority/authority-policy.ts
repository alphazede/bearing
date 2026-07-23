/** Pure, fail-closed authority checks; durable evidence is supplied by a caller. */
import { ROLES, type Role } from "../profile/profile.js";
import { isDurableOwnerEvidence, type DurableOwnerEvidence } from "../workflow/aggregate.js";

export const AUTHORITY_POLICY_SCHEMA_VERSION = 1 as const;

export type AuthorityAction = "recommend" | "execute" | "certify";
export type AuthorityDenialCode =
  | "authority_facts_invalid"
  | "authority_role_denied"
  | "authority_tool_denied"
  | "authority_approval_missing"
  | "authority_approval_invalid"
  | "authority_execution_mode_denied"
  | "authority_surveyor_ancestry_denied"
  | "authority_surveyor_not_executor"
  | "authority_self_certification";

export type AuthorityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: AuthorityDenialCode };

export interface AuthorityFacts {
  readonly schemaVersion: typeof AUTHORITY_POLICY_SCHEMA_VERSION;
  readonly role: Role;
  readonly action: AuthorityAction;
  readonly tool: string;
  readonly allowedTools: readonly string[];
  readonly sessionId: string;
  /** Direct-to-root session ids; an empty list means independent work. */
  readonly executionAncestry: readonly string[];
  readonly evidence?: DurableOwnerEvidence;
  /** Required only when executing a selected work graph. */
  readonly executionMode?: DurableOwnerEvidence["selectedMode"];
  /** Required only when certifying a completed execution. */
  readonly certifiedExecutionSessionId?: string;
}

const MAX_TEXT = 128;
const MAX_TOOLS = 64;
const roles = new Set<string>(ROLES);
const actions = new Set<string>(["recommend", "execute", "certify"]);

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.filter((key) => !optional.includes(key)).every((key) => key in value);
}

function facts(value: unknown): value is AuthorityFacts {
  if (!object(value) || !exactKeys(value, ["schemaVersion", "role", "action", "tool", "allowedTools", "sessionId", "executionAncestry", "evidence", "executionMode", "certifiedExecutionSessionId"], ["evidence", "executionMode", "certifiedExecutionSessionId"])) return false;
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
  evaluate(input: unknown): AuthorityDecision {
    if (!facts(input)) return deny("authority_facts_invalid");
    if (!input.allowedTools.includes(input.tool)) return deny("authority_tool_denied");
    if (input.role === "surveyor" && input.executionAncestry.length > 0) return deny("authority_surveyor_ancestry_denied");
    if (input.action === "execute" && input.role === "surveyor") return deny("authority_surveyor_not_executor");
    if (input.action === "certify") {
      if (input.role !== "surveyor") return deny("authority_role_denied");
      if (!input.certifiedExecutionSessionId) return deny("authority_facts_invalid");
      if (input.sessionId === input.certifiedExecutionSessionId || input.executionAncestry.includes(input.certifiedExecutionSessionId)) return deny("authority_self_certification");
      return { allowed: true };
    }
    if (input.action === "execute") {
      if (!input.evidence) return deny("authority_approval_missing");
      if (!input.executionMode || input.evidence.selectedMode !== input.executionMode) return deny("authority_execution_mode_denied");
      return { allowed: true };
    }
    return { allowed: true };
  }
}

export function evaluateAuthority(input: unknown): AuthorityDecision {
  return new AuthorityPolicy().evaluate(input);
}

function deny(code: AuthorityDenialCode): AuthorityDecision {
  return { allowed: false, code };
}
