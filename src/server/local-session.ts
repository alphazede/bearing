import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, readFileSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryBootstrap, ignoresBearingDirectory } from "../repository/bootstrap.js";
import { RepositoryChoiceService, type RepositoryChoiceResult } from "../repository/choice.js";
import { assessRepositorySafety } from "../repository/safety.js";
import { writeWorkspaceBusyLease } from "../repository/workspace-tools.js";
import { BUILTIN_ROUTES, type ProcessRunner } from "../adapters/adapters.js";
import { BearingStore } from "../store/bearing-store.js";
import { AdapterVerification, ReadinessService, REASONING_LEVELS, type RouteInspectionPort, type VerificationPort } from "../onboarding/readiness.js";
import { normalizeReasoningTier, type ResolvedRun, type RunOverrides, type Selection } from "../profile/profile.js";
import { CommandGateway } from "./command-gateway.js";
import { SseProjection } from "./sse.js";
import { MAX_SHOWCASE_JSON, MAX_SHOWCASE_REPORT, listWorkflowShowcases, projectWorkflowShowcase, renderWorkflowReport } from "../workflows/showcase.js";
import { JourneyService, currentPlanningVerdict, planningCheckpointFields, type JourneyActivity, type JourneyResult, type JourneyStage } from "../journey/planning-journey.js";
import {
  canonicalStringify,
  RECORD_JOURNEY_CHECKPOINT_STAGES,
  isRequirementRefs,
  isVerificationCheckpointPayload,
  type CommandEnvelopeV1,
  type RecordJourneyCheckpointPayload,
  type VerificationCheckpointPayload,
  type VerificationLayer,
  type VerificationVerdict,
} from "../contracts/run.js";
import {
  MAX_RUNTIME_STATE_ARRAY,
  parseRuntimeState,
  serializeRuntimeState,
  type ConcurrencyDecision as RuntimeConcurrencyDecision,
  type RuntimeStateRecord,
} from "../contracts/runtime-state.js";
import {
  deriveFocusEnvelope,
  parseApprovedExecutionContract,
  type ApprovedExecutionContract,
  type ExecutionContractParseResult,
} from "../contracts/execution-contract.js";
import {
  admitRetry,
  failureFingerprint,
  type EscalationScope,
  type EscalationTarget,
  type FocusCompletionErrorSignature,
  type RetryDecision,
  type RetryLedgerEntry,
  type RetryRefusal,
  type RetryWarrant,
} from "../execution/retry-control.js";
import { admissibleConcurrency } from "../execution/concurrency-control.js";
import { derivePlanningState, next, planningValidationSignal, type PlanningSignal, type PlanningValidationRecord } from "../journey/planning-state.js";
import { planDirectoryValid } from "../journey/plan-directory.js";
import { graderVerdict, parseGraderReport, type GraderReportFailure } from "../verification/grader.js";
import { parseParkRangerReport, synthesizeFindings, type ParkRangerReportFailure } from "../verification/park-ranger.js";
import { requiredGates, resolveReviewCadence } from "../verification/review-cadence.js";
import { assertIndependentVerification } from "../verification/verification-roles.js";
import {
  applyConsolidation,
  planConsolidation,
  resolvePlanDirectory,
  type ConsolidationPlan,
} from "../journey/plan-resolution.js";
import { isFitDiagnostic, type FitAssumption, type FitDecision, type FitDiagnostic } from "../journey/repository-fit.js";
import type {
  ImprovementReport,
  ImprovementServiceFailure,
  ImprovementServiceResult,
} from "../improvement/improvement-service.js";
import { ImprovementService, type ImprovementWindow } from "../improvement/improvement-service.js";
import { detectDegradation, type DegradationReason, type DegradationSignal } from "../improvement/degradation.js";
import { projectOutcomes, type OutcomeRecord } from "../improvement/outcome-projection.js";
import { computeMetrics, type MetricInputs, type MetricSet } from "../improvement/improvement-metrics.js";
import {
  DEFAULT_IMPROVEMENT_THRESHOLDS,
  recommend,
  type RecommendationResult,
  type Thresholds,
} from "../improvement/improvement-recommender.js";
import type { TrialVerdict } from "../improvement/improvement-proposal.js";

// ponytail: 32-byte (256-bit) tokens give 2^256 entropy; hex is URL-fragment-safe.
const CAPABILITY_BYTES = 32;
const SESSION_BYTES = 32;
const MAX_SESSION_BODY = 8 * 1024;
const MAX_REPOSITORY_BODY = 8 * 1024;
const MAX_READINESS_BODY = 4 * 1024;
const MAX_OWNER_BODY = 512;
const MAX_JOURNEY_BODY = 16 * 1024;
const MAX_CONTROL_BODY = 8 * 1024;
const MAX_VERIFICATION_BODY = 640 * 1024;
const MAX_JOURNEYS = 16;
const MAX_QA_JSON_BYTES = 640 * 1024;
const MAX_JOURNEY_ARTIFACT = 2 * 1024 * 1024;
const MAX_GIT_DIFF = 256 * 1024;
const PLAN_REVIEW_QUESTION = "Approve the complete planning package before implementation?";
const PLAN_REVIEW_APPROVAL = "Approved for execution-mode selection";
const CONSOLIDATION_APPROVAL = "Approve consolidation";
const FOCUS_AMENDMENT_PROMPT = "The approved Focus contract changed. Review the drift summary. Confirm the Focus amendment to adopt the updated plan and recapture the Git baseline.";
const FOCUS_AMENDMENT_APPROVAL = "Confirmed Focus amendment for execution retry";
const CONTINUITY_LOST_DISCLOSURE = "The prior provider conversation is unavailable; conversation continuity was lost and context may need to be supplied again.";
const SIGNATURE_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-office.png", import.meta.url)));
const EXPEDITION_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-expedition.png", import.meta.url)));
const EXPLORER_CARD_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-explorer-card.png", import.meta.url)));
const EXPEDITION_CARD_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-expedition-card.png", import.meta.url)));
const TITLE_MARK_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-title-mark.png", import.meta.url)));

/** Cookie name for the local browser session. The value is the secret; the name is not. */
export const SESSION_COOKIE_NAME = "bearing_session";

export const IMPROVEMENT_HANDOFF_NEXT_ACTIONS = Object.freeze([
  "open-fresh-session",
] as const);

export type ImprovementHandoffNextAction = (typeof IMPROVEMENT_HANDOFF_NEXT_ACTIONS)[number];

/** Typed, ledger-derived values accepted by the fixed handoff renderer. */
export interface ImprovementHandoffFacts {
  readonly runId: string;
  readonly planDirectory: string | null;
  readonly verifiedCompleteStages: readonly RecordJourneyCheckpointPayload["stage"][];
  readonly agentReportedCompleteStages: readonly RecordJourneyCheckpointPayload["stage"][];
  readonly itemInFlight: RecordJourneyCheckpointPayload["stage"] | null;
  readonly nextAction: ImprovementHandoffNextAction;
  readonly degradation: DegradationSignal;
}

export type ImprovementHandoffResult =
  | { readonly ok: true; readonly value: ImprovementHandoffFacts }
  | { readonly ok: false; readonly reason: "run_not_found" | "run_unavailable" };

export type RuntimeImprovementReport = ImprovementReport<Thresholds, MetricSet, RecommendationResult> & {
  readonly trialVerdicts: readonly TrialVerdict[];
};

export type RuntimeImprovementReportResult =
  | { readonly ok: true; readonly value: RuntimeImprovementReport }
  | { readonly ok: false; readonly reason: ImprovementServiceFailure };

function recordField(record: OutcomeRecord, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as unknown as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/** Adapt only fields the bounded outcome projection actually carries; missing families stay empty. */
export function measureImprovementWindow(window: ImprovementWindow): MetricSet {
  const sliceAttempts: MetricInputs["sliceAttempts"][number][] = [];
  const grading: NonNullable<MetricInputs["grading"]>[number][] = [];
  const confirmedFindingSlices = new Set<string>();

  for (const record of window.records) {
    if (record.signal !== "park_ranger_finding") continue;
    const sliceRef = recordField(record, "sliceRef");
    if (typeof sliceRef === "string" && sliceRef.length > 0) confirmedFindingSlices.add(sliceRef);
  }
  for (const record of window.records) {
    const sliceRef = recordField(record, "sliceRef");
    if (typeof sliceRef !== "string" || sliceRef.length === 0) continue;
    if (record.signal === "reasoning_effectiveness") {
      const attempt = recordField(record, "attempt");
      if (typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0) {
        sliceAttempts.push({ sliceRef, attempt, status: record.code });
      }
      continue;
    }
    if (record.signal === "grader_score") {
      grading.push({
        sliceRef,
        verdict: record.code === "weak" ? "fail" : "pass",
        ...(confirmedFindingSlices.has(sliceRef) ? { groundTruth: "fail" as const } : {}),
      });
    }
  }

  return computeMetrics({
    // One projected coordination value cannot represent both agents and work items.
    coordination: [],
    sliceAttempts,
    grading,
    // Requirement references and event sequence are intentionally absent from OutcomeRecord.
    completedSlices: [],
    confirmedFindings: [],
    // There is no token outcome signal in the bounded projection.
    tokenReports: [],
  });
}

/** Compose the real read-only improvement pipeline over one selected repository store. */
export async function buildImprovementReport(
  store: Pick<BearingStore, "list" | "load">,
): Promise<RuntimeImprovementReportResult> {
  const service = new ImprovementService<Thresholds, MetricSet, RecommendationResult>({
    store,
    clock: () => new Date().toISOString(),
    digest: (value) => createHash("sha256").update(value).digest("hex"),
    thresholds: DEFAULT_IMPROVEMENT_THRESHOLDS,
    stages: {
      project: projectOutcomes,
      measure: measureImprovementWindow,
      recommend: (input) => recommend({
        ...input,
        metrics: Object.freeze(Object.values(input.metrics)),
      }),
    },
  });
  const result = await service.report();
  if (!result.ok) return result;
  // A workspace with no runs is an empty evidence position, not a read failure: the store already
  // returns [] for a missing runs directory. Only runs that exist and cannot be read are a failure.
  if (result.value.listedRuns > 0 && result.value.readableRuns === 0) {
    return { ok: false, reason: "store_read_failed" };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...result.value,
      trialVerdicts: Object.freeze([]),
    }),
  };
}

function passingVerification(verification: VerificationCheckpointPayload | undefined): boolean {
  if (!verification) return false;
  switch (verification.layer) {
    case "validator": return verification.verdict === "PASS";
    case "grader": return verification.verdict === "strong" || verification.verdict === "acceptable";
    case "park-ranger": return verification.verdict === "accept" || verification.verdict === "accept-with-findings";
  }
}

function checkpointPayload(event: Awaited<ReturnType<BearingStore["load"]>>["events"][number]): RecordJourneyCheckpointPayload | undefined {
  return event.type === "journeyCheckpointRecorded"
    ? event.payload as unknown as RecordJourneyCheckpointPayload
    : undefined;
}

/** Read only: select the newest run and derive bounded handoff facts from its validated ledger. */
export async function buildImprovementHandoffFacts(
  store: Pick<BearingStore, "list" | "load">,
): Promise<ImprovementHandoffResult> {
  let listed: Awaited<ReturnType<BearingStore["list"]>>;
  try { listed = await store.list(1); }
  catch { return { ok: false, reason: "run_unavailable" }; }
  const latest = listed[0];
  if (!latest) return { ok: false, reason: "run_not_found" };

  let state: Awaited<ReturnType<BearingStore["load"]>>;
  try { state = await store.load(latest.runId); }
  catch { return { ok: false, reason: "run_unavailable" }; }

  const verified = new Set<RecordJourneyCheckpointPayload["stage"]>();
  const reported = new Set<RecordJourneyCheckpointPayload["stage"]>();
  let planDirectory: string | null = null;
  let itemInFlight: RecordJourneyCheckpointPayload["stage"] | null = null;
  let sessionContinuity: "intact" | "lost" | undefined;
  for (const event of state.events) {
    const checkpoint = checkpointPayload(event);
    if (!checkpoint) continue;
    if (checkpoint.resolvedPlanDirectory) planDirectory = checkpoint.resolvedPlanDirectory;
    else if (checkpoint.planDirectory) planDirectory = checkpoint.planDirectory;
    // Only the review stage ever persists `complete`; every other successful stage persists
    // `waiting` (see the status assignment in the journey POST handler). Treating `complete` as
    // the sole completion signal would therefore report a finished stage as still in flight, so a
    // passing verification counts as completion on its own. The producer is deliberately left
    // alone: making it write `complete` for non-review stages would reintroduce the Phase 1 F4
    // defect where a waiting stage persisted as complete.
    const verifiedComplete = passingVerification(checkpoint.verification);
    const reportedComplete = checkpoint.status === "complete";
    itemInFlight = verifiedComplete || reportedComplete ? null : checkpoint.stage;
    if (verifiedComplete || reportedComplete) {
      if (verifiedComplete) {
        verified.add(checkpoint.stage);
        reported.delete(checkpoint.stage);
      } else if (!verified.has(checkpoint.stage)) {
        reported.add(checkpoint.stage);
      }
    }
    if (typeof checkpoint.runtimeStateJson === "string") {
      const runtime = parseRuntimeState(checkpoint.runtimeStateJson);
      if (runtime.ok) sessionContinuity = runtime.value.sessionContinuity;
    }
  }

  const stageOrder = (stage: RecordJourneyCheckpointPayload["stage"]): number => RECORD_JOURNEY_CHECKPOINT_STAGES.indexOf(stage);
  const degradation = detectDegradation({
    outcomes: projectOutcomes({
      runId: state.runId,
      events: state.events,
      digest: (value) => createHash("sha256").update(value).digest("hex"),
    }),
    ...(sessionContinuity === undefined ? {} : { sessionContinuity }),
  });
  return {
    ok: true,
    value: Object.freeze({
      runId: state.runId,
      planDirectory,
      verifiedCompleteStages: Object.freeze([...verified].sort((left, right) => stageOrder(left) - stageOrder(right))),
      agentReportedCompleteStages: Object.freeze([...reported].sort((left, right) => stageOrder(left) - stageOrder(right))),
      itemInFlight,
      nextAction: "open-fresh-session",
      degradation,
    }),
  };
}

function handoffValue(value: string, maxLength = 512): string {
  return value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[P^_X][\s\S]*?(?:\u001b\\|\u009c)/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function degradationReason(reason: DegradationReason): string {
  switch (reason) {
    case "token_budget_exhausted": return "token budget exhausted";
    case "equivalent_failures_repeated": return "equivalent failures repeated";
    case "recovery_repeated": return "recovery repeated";
    case "retry_refused": return "retry refused";
    case "continuity_lost": return "session continuity lost";
  }
}

function improvementHandoffNextAction(action: ImprovementHandoffNextAction): string {
  switch (action) {
    case "open-fresh-session": return "Open a fresh session and paste this handoff prompt.";
  }
}

/** The single fixed-template renderer shared by the CLI and browser control room. */
export function renderImprovementHandoff(facts: ImprovementHandoffFacts): string {
  if (!facts.degradation.ok) return "No degradation signal is recorded.\n";
  const stages = (values: readonly RecordJourneyCheckpointPayload["stage"][]): string => values.length
    ? values.map((value) => handoffValue(value)).join(", ")
    : "none";
  return [
    `Bearing detected degradation: ${facts.degradation.reasons.map(degradationReason).join(", ")}.`,
    "Copy-paste handoff prompt:",
    `Run: ${handoffValue(facts.runId) || "not recorded"}`,
    `Plan directory: ${facts.planDirectory === null ? "not recorded" : handoffValue(facts.planDirectory) || "not recorded"}`,
    `Verified complete stages: ${stages(facts.verifiedCompleteStages)}`,
    `Re-derive before trusting agent-reported complete stages: ${stages(facts.agentReportedCompleteStages)}`,
    `Item in flight: ${facts.itemInFlight === null ? "none" : handoffValue(facts.itemInFlight)}`,
    `Next action: ${improvementHandoffNextAction(facts.nextAction)}`,
    "",
  ].join("\n");
}

type GreetingBucket = "morning" | "afternoon" | "evening" | "late" | "weekend";

const GREETINGS: Readonly<Record<GreetingBucket, readonly string[]>> = {
  morning: [
    "Good morning, {name}. What are we working on today?",
    "Good morning, {name}. What would you like to build today?",
    "Morning, {name}. Ready to set today's bearings?",
    "A fresh morning, {name}. What should we bring to life?",
    "Good morning, {name}. Where should we make progress today?",
  ],
  afternoon: [
    "Good afternoon, {name}. What are we building today?",
    "Good afternoon, {name}. What should we tackle next?",
    "Afternoon, {name}. Ready to turn an idea into a route?",
    "Welcome back, {name}. What deserves our focus this afternoon?",
    "Good afternoon, {name}. Where should we make progress?",
  ],
  evening: [
    "Good evening, {name}. What are we working on tonight?",
    "Evening, {name}. What should we bring across the finish line?",
    "Good evening, {name}. What are we building next?",
    "Settling in for the evening, {name}? What's worth creating?",
    "Good evening, {name}. Where should we point the crew?",
  ],
  late: [
    "Burning the midnight oil, {name}? What's on your mind to build?",
    "Late-night build, {name}? Let's make the next move count.",
    "Still exploring, {name}? What should we create tonight?",
    "The trail is quiet, {name}. What are we building?",
    "Night-owl mode, {name}. Where should we set our bearings?",
  ],
  weekend: [
    "{salutation}, {name}. Weekend warrior—let's build something great.",
    "Weekend warrior mode, {name}. What are we creating today?",
    "The weekend trail is open, {name}. Where should we go?",
    "Weekend build session, {name}. What deserves our attention?",
    "Ready for a weekend expedition, {name}? Let's make something useful.",
  ],
};

function greetingBucket(now: Date): GreetingBucket {
  if (now.getDay() === 0 || now.getDay() === 6) return "weekend";
  const hour = now.getHours();
  return hour < 5 || hour >= 22 ? "late" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function greetingSeed(name: string, now: Date, bucket: GreetingBucket): number {
  const key = `${name.toLocaleLowerCase()}|${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}|${bucket}`;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function salutation(now: Date): string {
  const hour = now.getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

export function greetingFor(name: string, now = new Date()): string {
  const bucket = greetingBucket(now), choices = GREETINGS[bucket];
  return choices[greetingSeed(name, now, bucket) % choices.length]!
    .replaceAll("{name}", name)
    .replaceAll("{salutation}", salutation(now));
}

export function unnamedGreetingFor(now = new Date()): string {
  if (now.getDay() === 0 || now.getDay() === 6) return `${salutation(now)}. Weekend warrior—let's build something great.`;
  const hour = now.getHours();
  if (hour < 5 || hour >= 22) return "Burning the midnight oil? What's on your mind to build?";
  return hour < 12 ? "Good morning. What are we working on today?" : hour < 17 ? "Good afternoon. What are we building today?" : "Good evening. What are we working on tonight?";
}

function htmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function randomToken(byteLen: number): string {
  return randomBytes(byteLen).toString("hex");
}

/** Constant-time equality for equal-length strings. Caller must guard length. */
function equalConstTime(a: string, b: string): boolean {
  // ponytail: latin1 keeps ASCII hex single-byte; utf8 would be identical here.
  return timingSafeEqual(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"));
}

/**
 * Owns the per-launch one-time capability and the browser session identity only.
 * It never holds provider credentials or workflow state. All decisions are
 * synchronous so the single-threaded event loop makes one-time exchange
 * race-free without locks.
 */
export class LocalSessionService {
  /** Per-launch capability. Goes in the URL fragment; never logged or echoed. */
  readonly capability: string;
  private readonly boundHost: string;
  private cookieValue: string | null = null;
  private sessionId: string | null = null;
  private consumed = false;

  constructor(boundHost: string) {
    this.boundHost = boundHost;
    this.capability = randomToken(CAPABILITY_BYTES);
  }

  /**
   * One-time exchange of the capability for a session cookie value. A wrong
   * capability does NOT consume the real capability (replay-safe on failure).
   */
  exchange(
    presented: string,
  ): { ok: true; cookieValue: string } | { ok: false } {
    if (this.consumed) return { ok: false };
    if (typeof presented !== "string") return { ok: false };
    if (presented.length !== this.capability.length) return { ok: false };
    if (!equalConstTime(presented, this.capability)) return { ok: false };
    this.consumed = true;
    this.cookieValue = randomToken(SESSION_BYTES);
    this.sessionId = randomToken(16);
    return { ok: true, cookieValue: this.cookieValue };
  }

  /** Host must equal the bound loopback host:port (DNS-rebinding guard). */
  validHost(host: string | undefined | null): boolean {
    return host === this.boundHost;
  }

  /**
   * Origin must be the loopback origin matching the bound host:port. Rejects
   * absent, cross-site, https, and path-bearing origins at this boundary.
   */
  validOrigin(origin: string | undefined | null): boolean {
    if (typeof origin !== "string" || origin.length === 0) return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    return (
      parsed.protocol === "http:" &&
      parsed.host === this.boundHost &&
      parsed.origin === origin
    );
  }

  /** Session cookie check, constant-time. Fails before any exchange happens. */
  authenticate(cookieValue: string | undefined | null): boolean {
    if (this.cookieValue === null) return false;
    if (typeof cookieValue !== "string") return false;
    if (cookieValue.length !== this.cookieValue.length) return false;
    return equalConstTime(cookieValue, this.cookieValue);
  }

  authenticateRequest(req: IncomingMessage): boolean {
    return this.authenticate(readCookie(req.headers.cookie, SESSION_COOKIE_NAME));
  }

  /** Non-secret durable command identity; the cookie itself is never exposed. */
  ownerSessionId(): string | null {
    return this.sessionId;
  }
}

const NATIVE_HTML_TEMPLATE =
  "<!doctype html>\n" +
  '<html lang="en">\n' +
  "<head>\n" +
  '<meta charset="utf-8">\n' +
  '<link rel="icon" href="data:,">\n' +
  "<title>Bearing</title>\n" +
  "<style>:root{color-scheme:dark;--canvas:#010102;--s1:#0f1011;--s2:#141516;--s3:#18191a;--line:#23252a;--line2:#34343a;--ink:#f7f8f8;--muted:#d0d6e0;--subtle:#8a8f98;--accent:#5e6ad2;--hover:#828fff;--success:#27a644}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:-.01em}button,input,select,textarea{font:inherit}button,input,select,textarea,a{min-height:40px}button{border:1px solid var(--line2);border-radius:8px;background:var(--s2);color:var(--ink);padding:.6rem .9rem;cursor:pointer}button:hover{background:var(--s3);border-color:#4a4c54}.primary{background:var(--accent);border-color:var(--accent);color:#fff}.primary:hover{background:var(--hover)}button:disabled{cursor:not-allowed;color:#62666d;background:var(--s1)}input,select,textarea{width:100%;border:1px solid var(--line2);border-radius:8px;background:var(--s1);color:var(--ink);padding:.65rem .75rem}textarea{min-height:88px;resize:vertical}a{color:#aeb6ff;display:inline-flex;align-items:center}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:3px}header{height:56px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(24px,4vw,72px);position:sticky;top:0;background:rgba(1,1,2,.96);z-index:2}.brand{display:flex;gap:10px;align-items:center;font-weight:650}.brand-mark{width:12px;height:12px;border:2px solid var(--accent);transform:rotate(45deg)}.nav-state{display:flex;gap:8px}.badge{border:1px solid var(--line);border-radius:999px;background:var(--s1);color:var(--subtle);padding:3px 9px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}main{max-width:1180px;margin:0;padding:42px clamp(24px,4vw,72px) 72px}.intro{display:grid;grid-template-columns:1fr auto;align-items:end;gap:24px;margin-bottom:24px}.eyebrow{margin:0 0 8px;color:var(--subtle);font-size:12px;letter-spacing:.1em;text-transform:uppercase}.intro h1{font-size:clamp(32px,5vw,54px);line-height:1.05;letter-spacing:-.045em;margin:0;font-weight:600}.status-wrap{min-width:min(100%,360px);border-left:1px solid var(--line2);padding-left:18px}.status-label{color:var(--subtle);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.status{margin:4px 0 0;color:var(--muted)}.panel{background:var(--s1);border:1px solid var(--line);border-radius:12px;margin-top:16px;overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 20px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:16px;margin:0}.step{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--subtle)}.panel-body{padding:20px}.repo-grid{display:grid;grid-template-columns:minmax(0,1fr) 190px 260px;gap:12px}.repo-card{text-align:left;background:var(--s2);border-left:3px solid var(--accent);padding:18px;min-height:112px}.repo-card strong,.repo-card span{display:block}.repo-card strong{font-size:17px;margin:4px 0}.repo-card span{color:var(--subtle);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.repo-card .source{color:var(--muted);font-family:inherit}.browse{min-width:190px}.signature{margin:0;border:1px solid var(--line2);border-radius:9px;overflow:hidden;background:var(--s2);min-height:112px}.signature img{width:100%;height:84px;object-fit:cover;object-position:center 43%;display:block;filter:saturate(.72) contrast(1.04)}.signature figcaption{padding:6px 10px;background:var(--s2);font-size:11px;color:var(--muted)}.platform{display:flex;gap:8px;flex-wrap:wrap;color:var(--subtle);font-size:12px;margin:0 0 14px}.form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.form-grid .wide{grid-column:1/-1}label,dt{display:block;font-weight:600;margin:0 0 6px;color:var(--muted)}.actions{display:flex;gap:10px;align-items:center;margin-top:16px}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border-top:1px solid var(--line)}.metric-grid p{background:var(--s2);margin:0;padding:14px 18px}.panel h3,.panel h4{letter-spacing:-.02em}.workflow-grid{display:grid;grid-template-columns:minmax(220px,.7fr) minmax(0,1.3fr);gap:20px}.workflow-grid article{border-left:1px solid var(--line);padding-left:20px}dl{display:grid;grid-template-columns:130px 1fr;gap:8px;margin:16px 0}dd{margin:0;color:var(--muted)}li{margin:.4rem 0;color:var(--muted)}[hidden]{display:none!important}@media(max-width:960px){.repo-grid{grid-template-columns:minmax(0,1fr) 190px}.signature{grid-column:1/-1}.signature img{height:160px}}@media(max-width:760px){header{padding:0 16px}.nav-state .badge:first-child{display:none}main{padding:28px 16px 56px}.intro,.repo-grid,.workflow-grid{grid-template-columns:1fr}.status-wrap{border-left:0;border-top:1px solid var(--line);padding:14px 0 0}.form-grid,.metric-grid{grid-template-columns:1fr}.workflow-grid article{border-left:0;border-top:1px solid var(--line);padding:16px 0 0}.signature{grid-column:auto}.browse{min-width:0}.panel-body{padding:16px}button,input,select,textarea,a{min-height:44px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}</style>\n" +
  '<style>body{position:relative;isolation:isolate;background:transparent}body::before,body::after{content:"";position:fixed;inset:0;pointer-events:none}body::before{z-index:-2;background:var(--canvas) url("/assets/bearing-expedition.png") center/cover no-repeat}body::after{z-index:-1;background:rgba(1,1,2,.48)}.intro,.panel{max-width:900px}#repository-panel{max-width:780px;background:var(--s1)}#repository-panel .panel-head{padding:11px 16px}#repository-panel .panel-body{padding:14px 16px}#repository-panel .platform{margin-bottom:10px}#repository-panel .repo-grid{grid-template-columns:minmax(0,1fr) 150px 180px;gap:10px}#repository-panel .repo-card{min-height:84px;padding:12px}#repository-panel .browse{min-width:150px}#repository-panel .signature-link{display:block;min-height:84px;color:inherit;text-decoration:none;border-radius:9px}#repository-panel .signature{min-height:84px}#repository-panel .signature img{height:58px}#repository-panel .signature figcaption{padding:5px 8px}.route-fieldset{border:0;margin:0;padding:0}.route-fieldset legend{font-weight:600;margin-bottom:8px}.route-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.route-card{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;margin:0;padding:12px;border:1px solid var(--line2);border-radius:9px;background:var(--s2);cursor:pointer;min-height:76px}.route-card:hover{border-color:#4a4c54}.route-card input{width:18px;min-height:18px;margin:3px 0 0;padding:0;accent-color:var(--accent)}.route-card strong,.route-card span{display:block}.route-card .route-status,.route-card .route-model{font-size:12px;color:var(--subtle)}.route-card.unavailable{cursor:not-allowed;opacity:.55}.route-details{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr);gap:14px;margin-top:14px}@supports ((-webkit-backdrop-filter:blur(8px)) or (backdrop-filter:blur(8px))){#repository-panel{background:rgba(15,16,17,.78);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}}@media(max-width:760px){body::before{background-position:65% center}body::after{background:rgba(1,1,2,.78)}#repository-panel{max-width:100%}#repository-panel .repo-grid,.route-options,.route-details{grid-template-columns:1fr}#repository-panel .browse{min-width:0}#repository-panel .signature-link{display:none}}</style>\n' +
  '<style>.repo-switch{min-height:32px;padding:3px 9px;border-radius:999px;background:var(--s1);color:var(--muted);font-size:12px}.demo-link{min-height:28px;padding:0;border:0;background:transparent;color:#aeb6ff;font-size:12px;text-decoration:underline;text-underline-offset:3px}.demo-link:hover{background:transparent;color:#fff}.panel-head-actions{display:flex;align-items:center;gap:10px}.compact-back{min-height:32px;padding:3px 8px;background:transparent;color:var(--muted);font-size:12px}.actions-end{justify-content:flex-end}.panel:not([hidden]){animation:panel-in .3s cubic-bezier(.2,.8,.2,1) both}.status.busy::before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border:2px solid var(--accent);vertical-align:-1px;animation:compass-spin .8s linear infinite}.prompt-panel textarea{min-height:132px;font-size:16px}.prompt-panel .hint{margin:0;color:var(--subtle);font-size:12px}.prompt-panel .actions{justify-content:space-between}.demo-panel{max-width:1000px}.demo-progress{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:20px}.demo-progress span{border-top:2px solid var(--line2);padding-top:7px;color:var(--subtle);font-size:11px}.demo-progress span.active{border-color:var(--accent);color:var(--ink)}.demo-example{border-left:3px solid var(--accent);background:var(--s2);padding:14px 16px;color:var(--muted)}.demo-stage h3{font-size:22px;margin:0 0 8px}.demo-stage>p{color:var(--muted)}.demo-actions{display:flex;justify-content:space-between;gap:10px;margin-top:20px}.mode-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}.mode-card{display:block;padding:0;overflow:hidden;text-align:left;background:var(--s2);border:2px solid var(--line2);border-radius:12px;min-height:420px}.mode-card:hover{border-color:var(--hover)}.mode-card.selected{border-color:var(--accent);box-shadow:0 0 0 2px rgba(94,106,210,.28)}.mode-card img{display:block;width:100%;height:190px;object-fit:cover}.mode-copy{display:block;padding:16px}.mode-copy strong,.mode-copy span{display:block}.mode-copy strong{font-size:23px;margin-bottom:3px}.mode-kicker{color:#c2c8ff;font-weight:600;margin-bottom:10px}.mode-line{color:var(--muted);margin-top:7px}.mode-line b{color:var(--ink)}@keyframes panel-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes compass-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.nav-state .badge{display:none}.repo-switch{max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prompt-panel .actions{align-items:stretch;flex-direction:column}.prompt-panel .actions .primary{align-self:flex-end}.demo-progress{grid-template-columns:1fr}.demo-progress span:not(.active){display:none}.mode-grid{grid-template-columns:1fr}.mode-card{min-height:0}.mode-card img{height:160px}}</style>\n' +
  '<style>.hero-help{margin:14px 0 0;color:var(--muted)}.hero-help .demo-link{margin-left:4px;font-size:14px}.demo-progress{grid-template-columns:repeat(4,1fr);list-style:none;padding:0}.demo-progress li{margin:0;border-top:2px solid var(--line2);padding-top:7px;color:var(--subtle);font-size:11px}.demo-progress li[aria-current="step"]{border-color:var(--accent);color:var(--ink)}.benefit-list{padding-left:20px}.benefit-list strong{color:var(--ink)}@media(max-width:760px){.demo-progress{grid-template-columns:1fr}.demo-progress li:not([aria-current="step"]){display:none}}</style>\n' +
  '<style>html{zoom:1.2}.token-banner{margin:0;padding:10px clamp(24px,4vw,72px);border-bottom:1px solid rgba(227,177,79,.5);background:rgba(74,52,15,.72);color:#fff1c7;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.token-banner strong{color:#fff}.token-banner a{min-height:24px;color:#fff;text-decoration:underline;text-underline-offset:3px}.panel,#repository-panel{background:rgba(15,16,17,.35);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.question-form{margin-top:16px}.question-form textarea{min-height:96px;background:rgba(15,16,17,.72)}.wait-panel{position:relative;overflow:hidden;border:1px solid var(--line2);border-radius:10px;background:rgba(15,16,17,.35);padding:16px;margin:16px 0}.wait-trail{height:4px;background:var(--line);overflow:hidden;border-radius:999px}.wait-trail::after{content:"";display:block;width:32%;height:100%;background:var(--accent);animation:wait-trail 1.2s ease-in-out infinite}.wait-meta{display:flex;justify-content:space-between;gap:12px;color:var(--subtle);font-size:12px}.artifact-checklist{padding-left:20px}.artifact-checklist a{min-height:28px}.cadence{border:0;padding:0;margin:18px 0}.cadence-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.cadence-options label,.cleanup-option{border:1px solid var(--line2);border-radius:9px;padding:12px;background:rgba(15,16,17,.35)}.cadence-options span,.cleanup-option span{display:block;color:var(--subtle);font-weight:400;font-size:12px}.cleanup-option{display:block}.journey-actions{display:flex;justify-content:space-between;gap:10px;margin-top:18px}@keyframes wait-trail{from{transform:translateX(-110%)}to{transform:translateX(320%)}}@media(max-width:760px){.token-banner{padding:10px 16px}.cadence-options{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.wait-trail::after{animation:none;width:100%}}</style>\n' +
  '<style>.model-note{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);margin:0 0 12px}.model-note code{color:var(--ink)}.support-note{border-left:3px solid #e3b14f;padding:8px 11px;background:rgba(74,52,15,.35);color:#fff1c7}.route-config{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.wait-controls{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;margin-top:14px}.wait-controls input{min-width:0}.danger{border-color:#9b3c3c;color:#ffd7d7}.git-count{min-height:24px;padding:0;border:0;background:transparent;color:#aeb6ff;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}.git-count:hover{background:transparent;color:#fff}.git-count:disabled{border:0;background:transparent;color:var(--subtle);text-decoration:none}.git-change-panel{margin:12px 0;border:1px solid var(--line2);border-radius:8px;background:rgba(8,9,10,.82);padding:12px}.git-change-panel h4{margin:0 0 8px}.git-file-list{display:grid;gap:5px}.git-file{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;min-height:32px;padding:5px 8px;text-align:left}.git-file-name{overflow-wrap:anywhere}.diff-add{color:#62d585}.diff-del{color:#ff7878}.diff-hunk{color:#aeb6ff}.git-diff{max-height:320px;overflow:auto;margin:10px 0 0;padding:10px;border-top:1px solid var(--line2);background:#090a0b;color:var(--muted);font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.git-diff span{display:block}.history-list{display:grid;gap:10px}.history-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;border:1px solid var(--line2);border-radius:9px;background:rgba(15,16,17,.45);padding:14px}.history-card strong,.history-card span{display:block}.history-card span{color:var(--subtle);font-size:12px}.nav-action{min-height:32px;padding:3px 9px;border-radius:999px;background:var(--s1);color:var(--muted);font-size:12px}@media(max-width:760px){.route-config{grid-template-columns:1fr}.wait-controls{grid-template-columns:1fr 1fr}.wait-controls input{grid-column:1/-1}.history-card{grid-template-columns:1fr}}</style>\n' +
  '<style>.review-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}.review-overview div{border:1px solid var(--line2);border-radius:9px;background:rgba(15,16,17,.45);padding:12px}.review-overview strong,.review-overview span{display:block}.review-overview strong{font-size:20px}.review-overview span{color:var(--subtle);font-size:12px}.assignment-table{width:100%;border-collapse:collapse;margin:14px 0}.assignment-table th,.assignment-table td{border:1px solid var(--line2);padding:8px;text-align:left;vertical-align:top}.assignment-table th{color:var(--ink)}.blocker-note{border-left:3px solid #e3b14f;background:rgba(74,52,15,.45);padding:12px 14px;color:#fff1c7}.review-change{margin-top:16px}@media(max-width:760px){.review-overview{grid-template-columns:1fr}.assignment-table{display:block;overflow-x:auto}}</style>\n' +
  '<style>.wait-guidance{display:grid;gap:5px;margin:12px 0;padding:10px 12px;border-left:3px solid var(--accent);background:rgba(8,9,10,.48);color:var(--muted);font-size:12px}.wait-guidance strong{color:var(--ink)}.wait-guidance p{margin:0}.wait-slow{color:#fff1c7}.trail-log{margin:8px 0 0;padding-left:20px}.trail-log li{margin:3px 0}.question-help{margin:9px 0 0;color:#c2c8ff;font-size:12px}.glossary-dialog{width:min(680px,calc(100% - 32px));border:1px solid var(--line2);border-radius:12px;background:#101112;color:var(--ink);padding:0;box-shadow:0 20px 70px #000}.glossary-dialog::backdrop{background:rgba(0,0,0,.72);backdrop-filter:blur(3px)}.glossary-dialog .panel-head,.glossary-dialog .panel-body{padding:16px 20px}.glossary-list{grid-template-columns:145px 1fr}.glossary-list dt{color:#c2c8ff}@media(max-width:760px){.glossary-list{grid-template-columns:1fr}.glossary-list dd{margin-bottom:8px}}</style>\n' +
  '<style>.history-actions{display:flex;gap:8px;align-items:center}.history-clear{color:#ffd7d7}.question-end{margin-left:auto}@media(max-width:760px){.history-actions{justify-content:flex-end;flex-wrap:wrap}}</style>\n' +
  '<style>.verification-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.verification-card,.cadence-projection{border:1px solid var(--line2);border-radius:9px;background:rgba(15,16,17,.45);padding:12px}.verification-card h3,.cadence-projection h3{margin:0 0 8px}.verification-result ol{margin:0;padding-left:20px}.verification-result p,.cadence-projection p{margin:6px 0;color:var(--muted)}.verification-entry strong,.verification-entry span{display:block}.verification-entry span,.gate-row span{color:var(--subtle);font-size:12px}.projection-failure code{display:block;color:#fff1c7}.cadence-projection{margin-top:12px}.gate-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}.gate-row{border-left:2px solid var(--accent);padding-left:9px}.gate-row strong,.gate-row span{display:block}@media(max-width:760px){.verification-grid,.gate-grid{grid-template-columns:1fr}}</style>\n' +
  '<style>.app-shell{display:grid;grid-template-columns:228px minmax(0,1fr);min-height:100vh}.workspace{min-width:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.journey-rail{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:14px;padding:16px 12px;border-right:1px solid rgba(255,255,255,.1);background:rgba(8,9,10,.35);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);z-index:4}.rail-brand{display:flex;align-items:center;justify-content:space-between;gap:8px}.rail-brand .brand{min-height:40px}.rail-collapse{width:34px;min-height:34px;padding:0}.rail-new{width:100%;text-align:left;background:rgba(94,106,210,.88);border-color:rgba(174,182,255,.7)}.rail-search{margin:0}.rail-search span{display:block;margin-bottom:5px;color:var(--subtle);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.rail-search input{min-height:36px;background:rgba(8,9,10,.55)}.rail-section{display:flex;min-height:0;flex:1;flex-direction:column}.rail-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;color:var(--subtle);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.rail-manage{min-height:28px;padding:2px 6px;border:0;background:transparent;color:#c2c8ff;font-size:11px}.rail-history-list{display:grid;gap:6px;overflow:auto}.rail-empty{margin:4px;color:var(--subtle);font-size:12px}.rail-journey{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;width:100%;min-height:50px;padding:8px;text-align:left;background:rgba(15,16,17,.38);border-color:transparent}.rail-journey:hover,.rail-journey.current{background:rgba(32,34,38,.72);border-color:var(--line2)}.rail-journey strong,.rail-journey small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rail-journey small{color:var(--subtle)}.journey-dot{width:8px;height:8px;margin-top:6px;border-radius:50%;background:#777}.journey-dot.running{background:#62d585;box-shadow:0 0 0 3px rgba(98,213,133,.12)}.journey-dot.paused{background:#e3b14f}.journey-dot.complete{background:#7f8cff}.rail-footer{display:grid;gap:4px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1)}.rail-footer button{min-height:32px;padding:4px 7px;border:0;background:transparent;text-align:left;color:var(--muted)}.rail-footer button:hover{background:rgba(32,34,38,.65)}.rail-collapsed{grid-template-columns:62px minmax(0,1fr)}.rail-collapsed .journey-rail{padding-inline:10px}.rail-collapsed .rail-brand .brand strong,.rail-collapsed .rail-new span,.rail-collapsed .rail-search,.rail-collapsed .rail-section-head span,.rail-collapsed .rail-manage,.rail-collapsed .rail-journey div,.rail-collapsed .rail-footer{display:none}.rail-collapsed .rail-brand{display:grid;justify-items:center}.rail-collapsed .rail-new{padding:0;text-align:center}.rail-collapsed .rail-new::before{content:"+"}.rail-collapsed .rail-journey{display:grid;grid-template-columns:1fr;place-items:center;padding:7px}.workspace header .brand{display:none}.rail-toggle{display:none}#history-button{display:none}.chat-landing{max-width:820px;margin-top:4vh;border-radius:18px}.chat-heading{padding:22px 22px 4px}.chat-heading .eyebrow{margin-bottom:5px}.chat-heading h2{margin:0;font-size:clamp(28px,4vw,42px);line-height:1.08;letter-spacing:-.04em}.prompt-shell{border:1px solid rgba(255,255,255,.14);border-radius:16px;background:rgba(8,9,10,.42);box-shadow:0 18px 55px rgba(0,0,0,.25);overflow:hidden}.context-bar{display:flex;gap:7px;flex-wrap:wrap;padding:12px 12px 0}.context-chip{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px;min-height:34px;max-width:240px;padding:5px 9px;border-radius:999px;background:rgba(24,25,26,.72);text-align:left}.context-chip small{color:var(--subtle)}.context-chip strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prompt-shell textarea{min-height:150px;border:0;border-radius:0;background:transparent;padding:16px;font-size:17px;box-shadow:none}.prompt-shell textarea:focus{outline:0}.prompt-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px 12px}.starter-row{display:flex;gap:6px;flex-wrap:wrap}.starter{min-height:32px;padding:4px 8px;border-color:transparent;background:transparent;color:var(--muted);font-size:12px}.starter:hover{background:rgba(32,34,38,.72)}.workspace-ready .intro{display:none}.workspace-ready main{padding-top:28px}.workspace-ready .token-banner{font-size:12px}.panel{width:100%}@media(max-width:900px){.app-shell{grid-template-columns:196px minmax(0,1fr)}.context-chip{max-width:190px}}@media(max-width:760px){.app-shell{display:block}.journey-rail{position:fixed;left:0;width:min(280px,86vw);transform:translateX(-105%);transition:transform .2s ease}.app-shell.rail-open .journey-rail{transform:translateX(0);box-shadow:20px 0 60px rgba(0,0,0,.55)}.workspace header .brand,.rail-toggle{display:flex}.workspace header{padding-inline:12px}.workspace .nav-state .local-badge{display:none}.chat-landing{margin-top:0}.chat-heading{padding:18px 16px 4px}.context-bar{display:grid;grid-template-columns:1fr 1fr}.context-chip{max-width:none}.prompt-footer{align-items:stretch;flex-direction:column}.prompt-footer .primary{align-self:flex-end}.starter-row{display:grid;grid-template-columns:1fr 1fr}.rail-collapsed{display:block}}@media(prefers-reduced-motion:reduce){.journey-rail{transition:none}}</style>\n' +
  '<style>@media(min-width:761px){.app-shell{height:83.333vh;min-height:83.333vh;overflow:hidden}.journey-rail{position:relative;height:100%}.workspace{height:100%;overflow:auto}}</style>\n' +
  '<style>.journey-surface{max-width:820px;margin-top:4vh;border-radius:18px;background:rgba(15,16,17,.35);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:0 18px 55px rgba(0,0,0,.25)}.journey-surface>.panel-head{background:rgba(8,9,10,.28)}.setup-sheet{position:fixed;z-index:9;top:50%;left:calc(50% + 114px);transform:translate(-50%,-50%);width:min(780px,calc(100vw - 300px));max-height:calc(100vh - 120px);overflow:auto;background:rgba(15,16,17,.86)!important;-webkit-backdrop-filter:blur(10px)!important;backdrop-filter:blur(10px)!important;box-shadow:0 28px 90px rgba(0,0,0,.72)}.setup-sheet:not([hidden]){animation:none}.setup-sheet .panel-head{position:sticky;top:0;z-index:1;background:rgba(8,9,10,.88)}.setup-sheet .compact-back{margin-left:8px}@media(max-width:760px){.journey-surface{margin-top:0}.setup-sheet{left:50%;width:calc(100vw - 24px);max-height:calc(100vh - 24px)}}@media(prefers-reduced-motion:reduce){.setup-sheet{animation:none}}</style>\n' +
  '<style>.title-mark{width:28px;height:28px;object-fit:contain;flex:0 0 auto}</style>\n' +
  "</head>\n" +
  "<body>\n" +
  '<div class="app-shell" id="app-shell"><aside class="journey-rail" aria-label="Journey navigation"><div class="rail-brand"><div class="brand"><img class="title-mark" src="/assets/bearing-title-mark.png" alt=""><strong>Bearing</strong></div><button class="rail-collapse" id="collapse-rail" type="button" aria-label="Collapse journey history" aria-expanded="true">‹</button></div><button class="rail-new" id="rail-new-journey" type="button"><span>＋ New journey</span></button><label class="rail-search"><span>Search journeys</span><input id="history-search" type="search" placeholder="Search" autocomplete="off"></label><section class="rail-section" aria-labelledby="rail-history-heading"><div class="rail-section-head"><span id="rail-history-heading">Journeys</span><button class="rail-manage" id="rail-manage-history" type="button">Manage</button></div><div class="rail-history-list" id="rail-history-list"><p class="rail-empty">Choose a workspace to see its journeys.</p></div></section><div class="rail-footer"><button id="rail-view-demo" type="button">How it works</button><button id="rail-view-glossary" type="button">Glossary</button></div></aside><div class="workspace">\n' +
  '<header><div class="brand"><button class="rail-toggle" id="toggle-rail" type="button" aria-label="Open journey history">☰</button><img class="title-mark" src="/assets/bearing-title-mark.png" alt="">Bearing</div><nav class="nav-state" aria-label="Runtime status"><a class="repo-switch" href="https://github.com/alphazede/bearing" target="_blank" rel="noopener noreferrer">GitHub repo \u2197</a><button class="nav-action" id="history-button" type="button" hidden>History</button><button class="repo-switch" id="change-repository" type="button" hidden>Change repository</button><span class="badge local-badge">LOCAL</span><span class="badge">OWNER CONTROLLED</span></nav></header>\n' +
  '<aside class="token-banner" role="note"><strong>Plan for substantial token use.</strong> Accurate Bearing designs can require significant context. If you use a subscription plan, consider a higher tier and choose reasoning deliberately. An explicit <code>--budget</code> flag is available when you want a hard per-call token ceiling.</aside>\n' +
  "<main>\n" +
  '<div class="intro"><div><p class="eyebrow">Local agent control room</p><h1>Set bearings.</h1><p class="hero-help">New to Bearing?<button class="demo-link" id="view-demo" type="button">See how it works</button><button class="demo-link" id="view-glossary" type="button">Glossary</button></p></div><div class="status-wrap"><span class="status-label">Current status</span><p class="status" id="status" role="status" aria-live="polite">Establishing local session\u2026</p></div></div>\n' +
  '<section class="panel setup-sheet" id="repository-panel" hidden aria-labelledby="repository-heading"><div class="panel-head"><h2 id="repository-heading">Choose workspace</h2><div><span class="step">WORKSPACE</span><button class="compact-back" id="close-repository-config" type="button">Close</button></div></div><div class="panel-body"><p class="platform"><span id="platform-name" class="badge"></span><span id="distro-name" class="badge" hidden></span><span id="picker-state" class="badge"></span></p><div class="blocker-note" id="repository-consent" role="status" aria-live="polite" hidden><strong id="repository-consent-message"></strong><div class="journey-actions"><button id="repository-consent-dismiss" type="button">Not now</button><button class="primary" id="repository-consent-confirm" type="button">Confirm</button></div></div><div class="repo-grid"><button class="repo-card" id="current-repository" type="button" disabled><span class="source" id="repository-source">Detected current repository</span><strong id="repository-name">Loading\u2026</strong><span id="repository-path"></span></button><button class="browse" id="browse-repository" type="button" disabled>Browse for repository</button><a class="signature-link" href="https://github.com/alphazede/bearing" target="_blank" rel="noopener noreferrer" aria-label="Open Bearing GitHub repository"><figure class="signature"><img src="/assets/bearing-office.png" alt="A bear in sunglasses working at a tidy office desk."><figcaption>GitHub repo \u2197</figcaption></figure></a></div></div></section>\n' +
  '<form class="panel setup-sheet" id="route-form" hidden><div class="panel-head"><h2>Choose your agent</h2><div><span class="step">AGENT SETTINGS</span><button class="compact-back" id="close-route-config" type="button">Close</button></div></div><div class="panel-body"><fieldset class="route-fieldset"><legend>Installed agents</legend><p class="support-note">Bearing runs locally and requires no Bearing account. Selected agent CLIs may use external providers under their own accounts, credentials, and data policies.</p><p class="model-note"><span>Choose a discovered model and a reasoning level that agent supports.</span><button id="refresh-routes" type="button">Refresh</button></p><p id="detected-routes">Checking agent and model settings\u2026</p><div class="route-options" id="route-options"></div><div class="route-config" id="route-config" hidden><div><label for="model-choice">Model</label><select id="model-choice" required></select></div><div><label for="reasoning-choice">Reasoning</label><select id="reasoning-choice" required></select></div></div></fieldset><div class="route-details"><div><label for="owner-name">What should we call you?</label><input id="owner-name" type="text" required autocomplete="name" maxlength="80"></div></div><div class="actions actions-end"><button class="primary" id="launch-bearing" disabled>Apply settings</button></div></div></form>\n' +
  '<form class="panel prompt-panel chat-landing journey-surface" id="work-form"><div class="chat-heading"><p class="eyebrow">Ready for a new journey</p><h2 id="work-greeting">__BEARING_INITIAL_GREETING__</h2></div><div class="panel-body"><div class="prompt-shell"><div class="context-bar" aria-label="Current workspace and agent settings"><button class="context-chip" id="workspace-chip" type="button" aria-haspopup="dialog"><small>Workspace</small><strong id="workspace-chip-label">Choose repository</strong></button><button class="context-chip" id="work-back" type="button" aria-haspopup="dialog"><small>Agent</small><strong id="agent-chip-label">Choose agent</strong></button><button class="context-chip" id="model-chip" type="button" aria-haspopup="dialog"><small>Model</small><strong id="model-chip-label">Agent default</strong></button><button class="context-chip" id="reasoning-chip" type="button" aria-haspopup="dialog"><small>Reasoning</small><strong id="reasoning-chip-label">Default</strong></button></div><label class="sr-only" for="work-goal">Describe the work</label><textarea id="work-goal" required maxlength="4096" placeholder="What are we working on?"></textarea><div class="prompt-footer"><div class="starter-row" aria-label="Example requests"><button class="starter" type="button" data-starter="Add a feature to this codebase.">Add a feature</button><button class="starter" type="button" data-starter="Investigate a problem in this codebase and propose a fix.">Investigate a problem</button><button class="starter" type="button" data-starter="Assess this codebase for launch readiness and create an investor-ready summary and infographic.">Prepare for launch</button></div><button class="primary">Embark</button></div></div><p class="hint">Bearing plans first. You choose Explorer or Expedition after implementation.md is ready.</p></div></form>\n' +
  '<section class="panel journey-surface" id="history-panel" hidden><div class="panel-head"><h2>Journey history</h2><div class="panel-head-actions"><button class="compact-back history-clear" id="clear-history" type="button">Clear history</button><button class="compact-back" id="close-history" type="button">\u2190 Back</button></div></div><div class="panel-body"><p>Saved locally in this repository. Removing history does not delete generated files.</p><div class="history-list" id="history-list"></div></div></section>\n' +
  '<section class="panel journey-surface" id="planning-panel" hidden aria-live="polite"><div class="panel-head"><h2>Journey</h2><span class="step" id="journey-phase">SET BEARINGS</span></div><div class="panel-body" id="journey-body" aria-busy="false"><div class="wait-panel" id="journey-wait" hidden><strong id="wait-phase">Set Bearings</strong><p id="wait-help">Your selected agent is working. Bearing will show only validated results.</p><div class="wait-trail" role="progressbar" aria-label="Agent work in progress"></div><div class="wait-meta"><span id="wait-status" role="status" aria-live="polite">Waiting for the agent\u2026</span><span id="wait-elapsed">0s elapsed</span></div><div class="wait-guidance"><strong id="wait-range">Typical time: about 3 minutes</strong><span id="wait-activity">Last activity: phase started just now.</span><span class="wait-slow" id="wait-slow" hidden>Still active; this is taking longer than usual.</span><p>Large repositories, higher reasoning, and model speed can extend this phase.</p><p>Safe to leave\u2014resume this journey from History.</p><ol class="trail-log" id="trail-log" aria-label="Recent journey activity"></ol></div><ul class="artifact-checklist" id="artifact-checklist"><li>No validated artifacts yet.</li></ul></div><div id="journey-content"><h3 id="journey-heading">Set Bearings</h3><p id="journey-summary">Bearing is preparing the bounded journey before gathering owner decisions.</p><aside class="blocker-note" id="recovery-report" hidden><strong id="recovery-heading">Bearing repaired a recoverable agent error.</strong><p id="recovery-summary"></p><p>Share only the redacted diagnostic below. For suspected vulnerabilities, use a private vulnerability report.</p><div class="journey-actions"><button id="dismiss-recovery-report" type="button">Not now</button><a id="private-vulnerability-report" href="https://github.com/alphazede/bearing/security/advisories/new" target="_blank" rel="noopener noreferrer">Report vulnerability privately</a><button id="report-recovery-bug" type="button">Open redacted GitHub issue</button></div></aside><div class="demo-example" id="journey-question-box" hidden><strong>Agent question</strong><br><span id="planning-question"></span><p class="question-help" id="question-help" hidden></p></div><form class="question-form" id="planning-answer-form" hidden><label for="planning-answer">Your answer</label><textarea id="planning-answer" required maxlength="4096" placeholder="Type your answer here\u2026"></textarea><div class="journey-actions"><button id="journey-back" type="button">\u2190 Back</button><button class="primary" type="submit">Continue</button></div></form><div id="journey-action" hidden><div class="journey-actions"><button id="journey-action-back" type="button">\u2190 Back</button><button id="journey-next" class="primary" type="button">Map the Route</button></div></div><div id="mode-choice" hidden><h3>Choose the crew</h3><p>The plan is ready. Choose the execution shape and how often Surveyor reviews it.</p><div class="mode-grid"><button class="mode-card" id="journey-explorer" type="button" aria-pressed="false"><img src="/assets/bearing-explorer-card.png" alt="Two bears following one focused mountain route."><span class="mode-copy"><strong>Explorer</strong><span class="mode-kicker">Focused route \u00b7 fewer sessions</span><span class="mode-line"><b>Best for:</b> compact or mostly sequential plans.</span><span class="mode-line"><b>Tradeoff:</b> less parallelism.</span></span></button><button class="mode-card" id="journey-expedition" type="button" aria-pressed="false"><img src="/assets/bearing-expedition-card.png" alt="Five bears coordinating multiple mountain activities."><span class="mode-copy"><strong>Expedition</strong><span class="mode-kicker">Parallel ascent \u00b7 more sessions</span><span class="mode-line"><b>Best for:</b> independent lanes or multiple phases.</span><span class="mode-line"><b>Tradeoff:</b> higher token and coordination cost.</span></span></button></div><fieldset class="cadence"><legend>Review cadence</legend><div class="cadence-options"><label><input type="radio" name="review-cadence" value="slice">Each slice<span>Fast feedback; highest review cost.</span></label><label><input type="radio" name="review-cadence" value="phase" checked>Each phase <b>(recommended)</b><span>Balanced safety, cost, and recovery.</span></label><label><input type="radio" name="review-cadence" value="end">End only<span>Lowest review cost; issues surface later.</span></label></div></fieldset><label class="cleanup-option"><input id="cleanup-worktrees" type="checkbox" checked> Cleanup merged worktrees <b>(recommended)</b><span>Only clean, proven-merged temporary lanes are removed. Dirty, blocked, failed, or unmerged lanes stay available for recovery.</span></label><div class="journey-actions"><button id="mode-back" type="button">\u2190 Back</button><button id="execute-journey" class="primary" type="button" disabled>Continue</button></div></div><div id="journey-complete" hidden><h3>Evidence complete</h3><p id="completion-summary"></p><ul class="artifact-checklist" id="completion-artifacts"></ul><div class="journey-actions"><button id="completion-back" type="button">\u2190 Back</button><button id="journey-retry" type="button" hidden>Retry</button><button id="new-journey" class="primary" type="button">Start another journey</button></div></div></div></div></section>\n' +
  '<section class="panel journey-surface" id="plan-review-panel" hidden aria-labelledby="plan-review-heading"><div class="panel-head"><h2 id="plan-review-heading">Review your route</h2><span class="step">04 / APPROVE</span></div><div class="panel-body"><p id="plan-review-summary">Review the complete planning package before any implementation begins.</p><section class="blocker-note" id="review-findings-panel" hidden><strong id="review-verdict"></strong><ul id="review-findings"></ul></section><div class="review-overview"><div><strong id="review-phase-count">0</strong><span>phases</span></div><div><strong id="review-slice-count">0</strong><span>slices</span></div><div><strong id="review-route">\u2014</strong><span>shared model and reasoning</span></div></div><h3>Planning artifacts</h3><p>The review HTML contains the complete planning package. Each source artifact also opens separately.</p><ul class="artifact-checklist" id="review-artifacts"></ul><h3>Slice assignments</h3><table class="assignment-table"><thead><tr><th>Slice</th><th>Role</th><th>Model route</th><th>Reasoning</th></tr></thead><tbody id="review-assignments"></tbody></table><p class="blocker-note"><strong>Execution can pause.</strong> If an agent reaches a blocker or needs authorization, Bearing saves the journey and shows what stopped, why, the recommended next step, and the decision it needs from you.</p><div class="review-change"><label for="review-change">Want something changed?</label><textarea id="review-change" maxlength="4096" placeholder="Describe the planning changes you want before approval."></textarea></div><div class="journey-actions"><button id="review-back" type="button">\u2190 Back</button><button id="request-plan-changes" type="button">Request changes</button><button id="approve-plan" class="primary" type="button">Approve route</button></div></div></section>\n' +
  '<section class="panel demo-panel" id="demo-panel" hidden aria-labelledby="demo-heading"><div class="panel-head"><div><h2 id="demo-heading">How Bearing works</h2><span class="step" id="demo-step" aria-live="polite">Step 1 of 4</span></div><div class="panel-head-actions"><span class="step">NO TOKENS</span><button class="compact-back" id="close-demo" type="button">Close</button></div></div><div class="panel-body"><ol class="demo-progress" aria-label="Tutorial progress"><li aria-current="step">Why Bearing</li><li>Your request</li><li>Choose the crew</li><li>Your evidence</li></ol><div class="demo-stage" data-demo-stage="0"><h3>Stay in control while agents do the work</h3><p>Bearing is a local control room that turns a complex request into an approved plan, bounded agent work, and evidence you can review.</p><ul class="benefit-list"><li><strong>You stay in charge:</strong> choose the repository, model, plan, execution mode, and consequential actions.</li><li><strong>Bearing runs locally:</strong> No Bearing account is required. A selected agent CLI may use an external provider under its own account, credentials, and data policy.</li><li><strong>You can step away:</strong> agents keep moving inside the approved boundaries and stop when they need your decision.</li></ul></div><div class="demo-stage" data-demo-stage="1" hidden><h3>Describe the outcome in your own words</h3><p>Choose the repository and tell Bearing what you want to accomplish. Before planning, it checks whether the source files are here and asks whether there are reference documents it should use.</p><div class="demo-example"><strong>Example request</strong><br>Add bulk customer onboarding with validation, duplicate handling, a dry-run preview, tests, and independent review.</div><p>Bearing asks only the questions needed to remove important ambiguity. Safe defaults are recorded as assumptions, and you can end questions at any point.</p></div><div class="demo-stage" data-demo-stage="2" hidden><h3>Review the plan, then choose the crew</h3><p>Nothing executes until <code>implementation.md</code> is ready for your review. Then you choose the work style. More bears mean more parallel work, coordination, and token use.</p><div class="mode-grid"><button class="mode-card" id="demo-explorer" type="button" aria-pressed="false"><img src="/assets/bearing-explorer-card.png" alt="Two bears following one focused mountain route."><span class="mode-copy"><strong>Explorer</strong><span class="mode-kicker">Focused route \u00b7 fewer agent sessions</span><span class="mode-line"><b>Use when:</b> the plan is compact, mostly sequential, or has one clear workstream.</span><span class="mode-line"><b>Pros:</b> lower token use and simpler coordination.</span><span class="mode-line"><b>Tradeoff:</b> less parallelism on broad plans.</span></span></button><button class="mode-card" id="demo-expedition" type="button" aria-pressed="false"><img src="/assets/bearing-expedition-card.png" alt="Five bears coordinating multiple mountain activities."><span class="mode-copy"><strong>Expedition</strong><span class="mode-kicker">Parallel ascent \u00b7 more agent sessions</span><span class="mode-line"><b>Use when:</b> the plan has several independent lanes, specialties, or waves.</span><span class="mode-line"><b>Pros:</b> more parallel progress and dedicated coordination.</span><span class="mode-line"><b>Tradeoff:</b> higher token use and coordination overhead.</span></span></button></div><p id="demo-mode-status" role="status">Choose a card to continue the tutorial.</p></div><div class="demo-stage" data-demo-stage="3" hidden><h3>Come back to evidence, not just “done”</h3><p id="demo-selected-mode">Your selected execution mode appears here.</p><p>Agents execute only approved slices and stop at owner decisions. An independent Surveyor then checks the result against the plan, tests, and recorded evidence.</p><div class="demo-example"><strong>Your final view</strong><br>What changed \u00b7 what passed \u00b7 what deviated \u00b7 what is blocked \u00b7 what still needs your decision</div></div><div class="demo-actions"><button id="demo-prev" type="button" disabled>\u2190 Previous</button><button class="primary" id="demo-next" type="button">Next \u2192</button></div></div></section>\n' +
  '<dialog class="glossary-dialog" id="glossary-dialog" aria-labelledby="glossary-heading"><div class="panel-head"><h2 id="glossary-heading">Bearing glossary</h2><button class="compact-back" id="close-glossary" type="button">Close</button></div><div class="panel-body"><dl class="glossary-list"><dt>CDD</dt><dd>Contract-Driven Design defines interface behavior, compatibility, validation, and tests before implementation.</dd><dt>SecDD</dt><dd>Security-Driven Design examines threats, trust boundaries, authentication, secrets, sensitive data, and abuse cases.</dd><dt>OOPDSA</dt><dd>Implementation-design hardening that assigns ownership and examines patterns, data structures, algorithms, complexity, and edge cases.</dd><dt>SEIT</dt><dd>The verification and validation plan describing what must be tested, proven, and recorded as evidence.</dd><dt>Explorer</dt><dd>A focused execution route using fewer agent sessions for compact or mostly sequential work.</dd><dt>Expedition</dt><dd>A parallel execution route for plans with independent lanes, specialties, or phases.</dd><dt>Surveyor</dt><dd>An independent reviewer that checks the completed work against the approved route and evidence.</dd></dl></div></dialog>\n' +
  '<section class="panel journey-surface" id="verification-panel" hidden aria-labelledby="verification-heading"><div class="panel-head"><h2 id="verification-heading">Verification evidence</h2><span class="step">READ ONLY</span></div><div class="panel-body"><p>Recorded evidence for the selected run. This panel cannot approve, transition, or execute a run.</p><div class="verification-grid"><article class="verification-card"><h3>Validator</h3><div class="verification-result" id="verification-validator" role="status"><p>No recorded verdict.</p></div></article><article class="verification-card"><h3>Grader</h3><div class="verification-result" id="verification-grader" role="status"><p>No recorded verdict.</p></div></article><article class="verification-card"><h3>Park Ranger</h3><div class="verification-result" id="verification-park-ranger" role="status"><p>No recorded verdict.</p></div></article></div><section class="cadence-projection" aria-labelledby="review-cadence-heading"><h3 id="review-cadence-heading">Review cadence</h3><div id="review-cadence-result" role="status"><p>Review cadence is loading.</p></div></section></div></section>\n' +
  '<section class="panel journey-surface" id="improvement-handoff-panel" hidden aria-labelledby="improvement-handoff-heading"><div class="panel-head"><h2 id="improvement-handoff-heading">Degradation handoff</h2><span class="step">READ ONLY</span></div><div class="panel-body"><p>This panel reports ledger-derived degradation and starts, resumes, retries, and changes nothing.</p><pre id="improvement-handoff-text" role="status" aria-live="polite"></pre></div></section>\n' +
  "<noscript><p>Bearing requires JavaScript to establish a local session.</p></noscript>\n" +
  "</main></div></div>\n" +
  "<script>\n" +
  '(function () {\n' +
  '  "use strict";\n' +
  '  var status = document.getElementById("status");\n' +
  '  var repositoryPanel = document.getElementById("repository-panel");\n' +
  '  var currentRepository = document.getElementById("current-repository");\n' +
  '  var browseRepository = document.getElementById("browse-repository");\n' +
  '  var repositoryConsent = document.getElementById("repository-consent");\n' +
  '  var repositoryConsentMessage = document.getElementById("repository-consent-message");\n' +
  '  var repositoryConsentConfirm = document.getElementById("repository-consent-confirm");\n' +
  '  var repositoryConsentDismiss = document.getElementById("repository-consent-dismiss");\n' +
  '  var repositoryConsentChoice = null;\n' +
  '  var routeForm = document.getElementById("route-form");\n' +
  '  var detectedRoutes = document.getElementById("detected-routes");\n' +
  '  var routeOptions = document.getElementById("route-options");\n' +
  '  var workForm = document.getElementById("work-form");\n' +
  '  var planningPanel = document.getElementById("planning-panel");\n' +
  '  var planReviewPanel = document.getElementById("plan-review-panel");\n' +
  '  var verificationPanel = document.getElementById("verification-panel");\n' +
  '  var improvementHandoffPanel = document.getElementById("improvement-handoff-panel");\n' +
  '  var handoffText = document.getElementById("improvement-handoff-text");\n' +
  '  var historyPanel = document.getElementById("history-panel");\n' +
  '  var historyButton = document.getElementById("history-button");\n' +
  '  var historyList = document.getElementById("history-list");\n' +
  '  var appShell = document.getElementById("app-shell");\n' +
  '  var railHistoryList = document.getElementById("rail-history-list");\n' +
  '  var planningAnswerForm = document.getElementById("planning-answer-form");\n' +
  '  var planningAnswer = document.getElementById("planning-answer");\n' +
  '  var planningSubmit = planningAnswerForm.querySelector("button[type=submit]");\n' +
  '  var endQuestions = document.createElement("button"); endQuestions.id = "end-questions"; endQuestions.type = "button"; endQuestions.className = "question-end"; endQuestions.textContent = "End questions"; endQuestions.hidden = true; planningSubmit.before(endQuestions);\n' +
  '  var demoPanel = document.getElementById("demo-panel");\n' +
  '  var viewDemo = document.getElementById("view-demo");\n' +
  '  var glossaryDialog = document.getElementById("glossary-dialog");\n' +
  '  var changeRepository = document.getElementById("change-repository");\n' +
  '  var workBack = document.getElementById("work-back");\n' +
  '  var currentRunId = "";\n' +
  '  var demoStage = 0;\n' +
  '  var demoMode = "";\n' +
  '  var demoReturnPanel = null;\n' +
  '  var browseAvailable = false;\n' +
  '  var selectedRoute = null;\n' +
  '  var reasoningTiers = ["minimal", "low", "medium", "high", "very-high", "max"];\n' +
  '  var selectedRepositoryPath = "";\n' +
  '  var historyEntries = [];\n' +
  '  var rememberedName = "";\n' +
  '  var rememberedGreeting = "";\n' +
  '  var onboardingReady = false;\n' +
  '  var returnPanel = null;\n' +
  '  var currentGoal = ""; var currentStage = "repository-fit"; var journeyMode = ""; var pendingQuestionCount = 0; var elapsedTimer = null; var statusTimer = null; var reconcileTimer = null; var elapsedStarted = 0; var waitActivityAt = 0; var waitActivitySequence = 0; var waitSignature = ""; var historyReturnPanel = null; var currentGitChanges = []; var waitEstimates = {}; var retryStage = ""; var focusAmendmentPending = false;\n' +
  '  function syncEndQuestions() { endQuestions.hidden = planningAnswerForm.hidden || currentStage !== "gather-supplies"; if (!endQuestions.hidden) endQuestions.disabled = false; }\n' +
  '  new MutationObserver(syncEndQuestions).observe(planningAnswerForm, { attributes: true, attributeFilter: ["hidden"] }); new MutationObserver(syncEndQuestions).observe(document.getElementById("planning-question"), { childList: true });\n' +
  '  function setStatus(message, busy) { status.textContent = message; status.classList.toggle("busy", !!busy); }\n' +
  '  function routeName(id) { return ({ "codex": "Codex CLI", "claude": "Claude Code", "agy": "Agy", "grok-build": "Grok Build", "opencode": "OpenCode", "pi": "Pi" })[id] || id || "Choose agent"; }\n' +
  '  function syncShellSummary() { var workspace = document.getElementById("workspace-chip-label"); workspace.textContent = selectedRepositoryPath ? selectedRepositoryPath.split(/[\\\\/]/).filter(Boolean).pop() || selectedRepositoryPath : "Choose repository"; workspace.parentElement.title = selectedRepositoryPath; document.getElementById("agent-chip-label").textContent = selectedRoute ? routeName(selectedRoute.id) : "Choose agent"; document.getElementById("model-chip-label").textContent = selectedRoute ? (selectedRoute.model === "*" ? "Agent default" : selectedRoute.model) : "Agent default"; document.getElementById("reasoning-chip-label").textContent = selectedRoute ? selectedRoute.reasoning : "Default"; }\n' +
  '  function fail(msg) { setStatus("Session could not start: " + msg, false); }\n' +
  '  function requestError(label, r) { throw new Error(label + " (" + r.status + "). Refresh the run state and try again."); }\n' +
  '  function readRun(id) { return fetch("/api/v1/runs/" + encodeURIComponent(id), { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Run could not be read", r); return r.json(); }); }\n' +
  '  function postCommand(id, state, type, payload) { var commandId = crypto.randomUUID(); return fetch("/api/v1/runs/" + encodeURIComponent(id) + "/commands", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ schemaVersion: 1, commandId: commandId, runId: id, expectedRevision: state.revision, session: { sessionId: "browser", actor: "owner" }, correlationId: commandId, type: type, payload: payload }) }).then(function (r) { if (!r.ok) requestError("Command was rejected", r); return r.json(); }); }\n' +
  '  function persistAgentQuestion(question) { return readRun(currentRunId).then(function (state) { if (state.pendingDecision) { if (state.pendingDecision.question !== question) throw new Error("Another owner decision is already pending."); return state; } return postCommand(currentRunId, state, "requireDecision", { decisionId: "journey-" + currentStage + "-" + crypto.randomUUID(), question: question, consequential: true }).then(function () { return readRun(currentRunId); }); }); }\n' +
  '  var phaseNames = { "repository-fit": "Repository fit", "set-bearings": "Set Bearings", "gather-supplies": "Gather Supplies", "map-route": "Map the Route", "recon": "Recon", "draft-implementation": "Draft implementation", "execute-explorer": "Explorer", "execute-expedition": "Expedition", "review": "Surveyor review" };\n' +
  '  function cacheEstimate(body) { var estimate = body && body.nextStageEstimate; if (estimate && (phaseNames[estimate.stage] || estimate.stage === "execute") && Number.isSafeInteger(estimate.minMinutes) && Number.isSafeInteger(estimate.maxMinutes) && estimate.minMinutes >= 1 && estimate.maxMinutes >= estimate.minMinutes && typeof estimate.basis === "string") waitEstimates[estimate.stage] = estimate; }\n' +
  '  function waitEstimate(stage) { return waitEstimates[stage] || (stage === "execute-explorer" || stage === "execute-expedition" ? waitEstimates.execute : null); }\n' +
  '  var waitExplanations = { "repository-fit": "Bearing is inspecting bounded repository evidence before asking you to confirm the first write.", "set-bearings": "Bearing is creating or resuming the local plan stub and bounded repository map. Next: Gather Supplies discovers owner decisions.", "gather-supplies": "The selected agent is inspecting the repository to discover unresolved owner questions. Next: your answers become the validated plan specification.", "map-route": "The selected agent is producing design.md and SEIT evidence. Next: optional Recon tests one material assumption before implementation drafting.", "recon": "The selected agent is testing one material assumption before implementation drafting. If no material assumption needs Recon, this pass is skipped explicitly.", "draft-implementation": "The selected agent is completing the SEIT-backed implementation package. Next: you review and approve the route.", "execute-explorer": "Explorer is executing the approved slices with the recorded review cadence. Next: Surveyor reviews the integrated changes.", "execute-expedition": "Expedition is coordinating approved parallel lanes and their review cadence. Next: Surveyor reviews the integrated changes.", "review": "Surveyor is reviewing the integrated uncommitted diff without modifying it. Next: Bearing presents the validated evidence and findings." };\n' +
  '  function updateWaitClock() { var elapsed = Math.floor((Date.now() - elapsedStarted) / 1000); var activity = waitActivityAt ? Math.max(0, Math.floor((Date.now() - waitActivityAt) / 1000)) : null; var estimate = waitEstimate(currentStage); document.getElementById("wait-elapsed").textContent = elapsed + "s elapsed"; document.getElementById("wait-activity").textContent = "Last real activity: " + (activity === null ? "waiting for the first event." : activity < 2 ? "just now." : activity + "s ago."); document.getElementById("wait-slow").hidden = !estimate || elapsed <= estimate.maxMinutes * 60; }\n' +
  '  function recordTrail(message, recordedAt) { var parsed = recordedAt ? Date.parse(recordedAt) : NaN; waitActivityAt = Number.isNaN(parsed) ? Date.now() : parsed; var trail = document.getElementById("trail-log"); var item = document.createElement("li"); item.textContent = new Date(waitActivityAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " \u2014 " + message; trail.prepend(item); while (trail.children.length > 4) trail.lastElementChild.remove(); updateWaitClock(); }\n' +
  '  function activityLabel(activity) { return activity.kind + (activity.tool ? " \u00b7 " + activity.tool : "") + (activity.status ? " \u00b7 " + activity.status : ""); }\n' +
  '  function renderActivityTrail(entries) { if (!Array.isArray(entries)) return; entries.forEach(function (activity) { if (!activity || !Number.isSafeInteger(activity.sequence) || activity.sequence <= waitActivitySequence) return; waitActivitySequence = activity.sequence; var label = activityLabel(activity); recordTrail(label, activity.recordedAt); document.getElementById("wait-status").textContent = phaseNames[currentStage] + ": " + label; }); }\n' +
  '  function questionHelp(question) { var help = []; if (/\\blens(?:es)?\\b/i.test(question)) help.push("For more information about lenses, use Glossary in the bottom-left."); if (/\\bCDD\\b/i.test(question)) help.push("CDD means Contract-Driven Design: define interfaces, compatibility, validation, and tests before implementation."); if (/\\bSecDD\\b/i.test(question)) help.push("SecDD means Security-Driven Design: examine threats, trust boundaries, authentication, secrets, and abuse cases."); if (/\\bOOPDSA\\b/i.test(question)) help.push("OOPDSA hardens implementation ownership, patterns, data structures, algorithms, complexity, and edge cases."); if (/\\bSEIT\\b/i.test(question)) help.push("SEIT is the verification and validation plan describing what must be tested and recorded as evidence."); return help.join(" "); }\n' +
  '  function ensureWaitControls() { if (document.getElementById("wait-controls")) return; var wait = document.getElementById("journey-wait"); var meta = document.querySelector(".wait-meta"); var git = document.createElement("button"); git.id = "git-count"; git.className = "git-count"; git.type = "button"; git.disabled = true; git.setAttribute("aria-expanded", "false"); git.textContent = "Git: checking\u2026"; meta.insertBefore(git, document.getElementById("wait-elapsed")); var panel = document.createElement("section"); panel.id = "git-change-panel"; panel.className = "git-change-panel"; panel.hidden = true; var heading = document.createElement("h4"); heading.textContent = "Changed files"; var files = document.createElement("div"); files.id = "git-file-list"; files.className = "git-file-list"; var diff = document.createElement("pre"); diff.id = "git-diff"; diff.className = "git-diff"; diff.hidden = true; panel.append(heading, files, diff); var controls = document.createElement("div"); controls.id = "wait-controls"; controls.className = "wait-controls"; var input = document.createElement("input"); input.id = "steer-instruction"; input.maxLength = 4096; input.placeholder = "Steer this phase\u2026"; input.setAttribute("aria-label", "Steering instruction"); var steer = document.createElement("button"); steer.id = "steer-journey"; steer.type = "button"; steer.textContent = "Steer"; var stop = document.createElement("button"); stop.id = "stop-journey"; stop.type = "button"; stop.className = "danger"; stop.textContent = "Stop"; controls.append(input, steer, stop); wait.insertBefore(panel, document.getElementById("artifact-checklist")); wait.insertBefore(controls, document.getElementById("artifact-checklist")); git.addEventListener("click", function () { panel.hidden = !panel.hidden; git.setAttribute("aria-expanded", String(!panel.hidden)); if (!panel.hidden) renderGitFiles(currentGitChanges); }); steer.addEventListener("click", function () { sendJourneyControl("steer"); }); stop.addEventListener("click", function () { sendJourneyControl("stop"); }); }\n' +
  '  function renderGitFiles(changes) { var list = document.getElementById("git-file-list"); var diff = document.getElementById("git-diff"); list.replaceChildren(); diff.hidden = true; changes.forEach(function (change) { var button = document.createElement("button"); button.type = "button"; button.className = "git-file"; var name = document.createElement("span"); name.className = "git-file-name"; name.textContent = change.path; var added = document.createElement("span"); added.className = "diff-add"; added.textContent = change.additions === null ? (change.status === "??" ? "new" : "") : "+" + change.additions; var deleted = document.createElement("span"); deleted.className = "diff-del"; deleted.textContent = change.deletions === null ? "" : "-" + change.deletions; button.append(name, added, deleted); button.addEventListener("click", function () { showGitDiff(change.path); }); list.appendChild(button); }); }\n' +
  '  function showGitDiff(path) { var target = document.getElementById("git-diff"); target.hidden = false; target.textContent = "Loading " + path + "\u2026"; fetch("/api/v1/git-diff?path=" + encodeURIComponent(path), { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Diff could not be loaded", r); return r.json(); }).then(function (body) { target.replaceChildren(); (body.diff || "No textual diff available.").split(/\\r?\\n/).forEach(function (text) { var line = document.createElement("span"); line.className = text.startsWith("+") && !text.startsWith("+++") ? "diff-add" : text.startsWith("-") && !text.startsWith("---") ? "diff-del" : text.startsWith("@@") ? "diff-hunk" : ""; line.textContent = text || " "; target.appendChild(line); }); }, function (error) { target.textContent = error instanceof Error ? error.message : "Diff could not be loaded."; }); }\n' +
  '  function refreshJourneyStatus() { if (!currentRunId) return; fetch("/api/v1/journey/" + encodeURIComponent(currentRunId) + "/status", { credentials: "same-origin" }).then(function (r) { if (!r.ok) return null; return r.json(); }).then(function (body) { if (!body) return; if (!body.run || body.run.stage === currentStage) renderActivityTrail(body.activityTrail); var git = document.getElementById("git-count"); currentGitChanges = Array.isArray(body.gitChanges) ? body.gitChanges : []; git.textContent = body.changedFiles === null ? "Git unavailable" : "Git: " + body.changedFiles + " changed " + (body.changedFiles === 1 ? "file" : "files"); git.disabled = !currentGitChanges.length; if (!document.getElementById("git-change-panel").hidden) renderGitFiles(currentGitChanges); if (body.run) renderArtifacts(body.run); var artifacts = body.run && Array.isArray(body.run.artifacts) ? body.run.artifacts.length : 0; var signature = String(body.changedFiles) + ":" + artifacts; if (signature !== waitSignature) { waitSignature = signature; recordTrail("Repository snapshot: " + (body.changedFiles === null ? "Git unavailable" : body.changedFiles + " changed " + (body.changedFiles === 1 ? "file" : "files")) + "; " + artifacts + " validated " + (artifacts === 1 ? "artifact" : "artifacts") + "."); } }); }\n' +
  '  function sendJourneyControl(action) { var input = document.getElementById("steer-instruction"); var instruction = input.value.trim(); if (action === "steer" && !instruction) { input.focus(); return; } document.getElementById("steer-journey").disabled = true; document.getElementById("stop-journey").disabled = true; fetch("/api/v1/journey/control", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ runId: currentRunId, action: action, ...(action === "steer" ? { instruction: instruction } : {}) }) }).then(function (r) { if (!r.ok) requestError("Journey control was rejected", r); input.value = ""; recordTrail(action === "steer" ? "Steering instruction received." : "Stop requested."); document.getElementById("wait-status").textContent = action === "steer" ? "Steering received. Restarting this phase\u2026" : "Stopping the active agent\u2026"; }, function () { document.getElementById("steer-journey").disabled = false; document.getElementById("stop-journey").disabled = false; setStatus("Journey control failed. Try again.", false); }); }\n' +
  '  function showWait(stage) { ensureWaitControls(); setStatus(phaseNames[stage] + " is working\u2026", true); document.getElementById("journey-content").hidden = true; document.getElementById("journey-wait").hidden = false; document.getElementById("git-change-panel").hidden = true; document.getElementById("git-count").setAttribute("aria-expanded", "false"); document.getElementById("journey-body").setAttribute("aria-busy", "true"); document.getElementById("wait-phase").textContent = phaseNames[stage]; document.getElementById("wait-help").textContent = waitExplanations[stage]; document.getElementById("wait-status").textContent = "Waiting for real activity\u2026"; var estimate = waitEstimate(stage); document.getElementById("wait-range").textContent = estimate ? "Agent estimate: " + estimate.minMinutes + "\u2013" + estimate.maxMinutes + " minutes \u2014 " + estimate.basis : "Timing estimate will appear after agent inspection."; document.getElementById("wait-slow").hidden = true; document.getElementById("trail-log").replaceChildren(); document.getElementById("steer-journey").disabled = false; document.getElementById("stop-journey").disabled = false; elapsedStarted = Date.now(); waitActivityAt = 0; waitActivitySequence = 0; waitSignature = ""; clearInterval(elapsedTimer); clearInterval(statusTimer); updateWaitClock(); elapsedTimer = setInterval(updateWaitClock, 1000); refreshJourneyStatus(); statusTimer = setInterval(refreshJourneyStatus, 2000); }\n' +
  '  function hideWait() { clearInterval(elapsedTimer); clearInterval(statusTimer); clearTimeout(reconcileTimer); elapsedTimer = null; statusTimer = null; reconcileTimer = null; document.getElementById("journey-wait").hidden = true; document.getElementById("journey-content").hidden = false; document.getElementById("journey-body").setAttribute("aria-busy", "false"); loadRailHistory(); }\n' +
  '  var verificationLayers = ["validator", "grader", "park-ranger"];\n' +
  '  var verificationLoadGeneration = 0;\n' +
  '  function clearVerificationProjections() { verificationLoadGeneration += 1; verificationPanel.hidden = true; }\n' +
  '  function readProjection(path) { return fetch(path, { credentials: "same-origin" }).then(function (r) { return r.text().then(function (text) { var body = {}; var parsed = true; try { body = JSON.parse(text); } catch (_) { parsed = false; } if (!r.ok) return { ok: false, code: parsed && typeof body.code === "string" ? body.code : "projection_unavailable", remedy: parsed && typeof body.remedy === "string" ? body.remedy : "This verification projection is unavailable." }; if (!parsed || !projectionBodyValid(path, body)) return { ok: false, code: "projection_unavailable", remedy: "This verification projection is unavailable." }; return { ok: true, body: body }; }); }, function () { return { ok: false, code: "projection_unavailable", remedy: "This verification projection is unavailable." }; }); }\n' +
  '  function projectionBodyValid(path, body) { if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.runId !== "string") return false; var parts = path.split("/"); if (encodeURIComponent(body.runId) !== parts[4]) return false; if (path.endsWith("/review-cadence")) { var cadence = body.resolvedCadence; var gates = body.requiredGates; var cadences = ["per-slice", "per-phase", "completion-only"]; return cadences.includes(body.declaredCadence) && typeof cadence === "object" && cadence !== null && cadences.includes(cadence.cadence) && typeof cadence.tightened === "boolean" && Array.isArray(cadence.reasons) && cadence.reasons.every(function (reason) { return typeof reason === "string"; }) && typeof gates === "object" && gates !== null && ["slice", "phase", "completion"].every(function (gate) { return Array.isArray(gates[gate]) && gates[gate].every(function (value) { return typeof value === "string"; }); }); } var layer = parts[parts.length - 1]; return verificationLayers.includes(layer) && body.layer === layer && Array.isArray(body.entries) && body.entries.every(function (entry) { return typeof entry === "object" && entry !== null && typeof entry.eventId === "string" && Number.isSafeInteger(entry.sequence) && entry.sequence >= 0 && typeof entry.stage === "string" && ["running", "waiting", "stopped", "failed", "complete"].includes(entry.status) && typeof entry.verdict === "string" && (entry.rubricVersion === undefined || typeof entry.rubricVersion === "string") && (entry.findingCount === undefined || Number.isSafeInteger(entry.findingCount) && entry.findingCount >= 0); }); }\n' +
  '  function renderProjectionFailure(target, failure) { target.replaceChildren(); var message = document.createElement("p"); message.className = "projection-failure"; var code = document.createElement("code"); code.textContent = failure.code || "projection_unavailable"; var remedy = document.createElement("span"); remedy.textContent = failure.remedy || "This verification projection is unavailable."; message.append(code, remedy); target.appendChild(message); }\n' +
  '  function renderVerificationProjection(layer, body) { var target = document.getElementById("verification-" + layer); target.replaceChildren(); var entries = Array.isArray(body.entries) ? body.entries : []; if (!entries.length) { var empty = document.createElement("p"); empty.textContent = "No recorded verdict."; target.appendChild(empty); return; } var list = document.createElement("ol"); entries.forEach(function (entry) { var item = document.createElement("li"); item.className = "verification-entry"; var verdict = document.createElement("strong"); verdict.textContent = String(entry.verdict); var context = document.createElement("span"); context.textContent = String(entry.stage) + " \u00b7 " + String(entry.status); item.append(verdict, context); if (entry.rubricVersion !== undefined) { var rubric = document.createElement("span"); rubric.textContent = "Rubric " + String(entry.rubricVersion); item.appendChild(rubric); } if (entry.findingCount !== undefined) { var findings = document.createElement("span"); findings.textContent = String(entry.findingCount) + (entry.findingCount === 1 ? " finding" : " findings"); item.appendChild(findings); } list.appendChild(item); }); target.appendChild(list); }\n' +
  '  function renderReviewCadence(body) { var target = document.getElementById("review-cadence-result"); target.replaceChildren(); var cadence = body.resolvedCadence; var summary = document.createElement("p"); summary.textContent = "Declared: " + String(body.declaredCadence) + " \u00b7 Resolved: " + String(cadence.cadence) + " \u00b7 Tightened: " + (cadence.tightened ? "Yes" : "No"); target.appendChild(summary); var reasons = document.createElement("p"); reasons.textContent = Array.isArray(cadence.reasons) && cadence.reasons.length ? "Reasons returned: " + cadence.reasons.join(", ") : "Tightening reasons: none returned."; target.appendChild(reasons); var gateGrid = document.createElement("div"); gateGrid.className = "gate-grid"; ["slice", "phase", "completion"].forEach(function (gate) { var row = document.createElement("div"); row.className = "gate-row"; var label = document.createElement("strong"); label.textContent = gate.charAt(0).toUpperCase() + gate.slice(1); var values = document.createElement("span"); var required = body.requiredGates && Array.isArray(body.requiredGates[gate]) ? body.requiredGates[gate] : []; values.textContent = required.length ? required.join(", ") : "No required gates recorded."; row.append(label, values); gateGrid.appendChild(row); }); target.appendChild(gateGrid); }\n' +
  '  function loadVerificationProjections(runId) { if (!runId) { clearVerificationProjections(); return; } var generation = ++verificationLoadGeneration; verificationPanel.hidden = false; verificationLayers.forEach(function (layer) { var target = document.getElementById("verification-" + layer); target.textContent = "Loading recorded verdicts\u2026"; }); document.getElementById("review-cadence-result").textContent = "Loading resolved cadence\u2026"; var base = "/api/v1/runs/" + encodeURIComponent(runId); var requests = verificationLayers.map(function (layer) { return readProjection(base + "/verification/" + layer).then(function (result) { if (currentRunId !== runId || generation !== verificationLoadGeneration) return; if (result.ok) renderVerificationProjection(layer, result.body); else renderProjectionFailure(document.getElementById("verification-" + layer), result); }); }); requests.push(readProjection(base + "/review-cadence").then(function (result) { if (currentRunId !== runId || generation !== verificationLoadGeneration) return; if (result.ok) renderReviewCadence(result.body); else renderProjectionFailure(document.getElementById("review-cadence-result"), result); })); return Promise.all(requests); }\n' +
  '  function loadImprovementHandoff() { if (!selectedRepositoryPath) { improvementHandoffPanel.hidden = true; handoffText.textContent = ""; return; } improvementHandoffPanel.hidden = false; handoffText.textContent = "Loading degradation handoff\u2026"; fetch("/api/v1/improvement/handoff", { credentials: "same-origin" }).then(function (r) { return r.text().then(function (text) { var body = {}; try { body = JSON.parse(text); } catch (_) {} if (!r.ok) throw new Error(typeof body.remedy === "string" ? body.remedy : "The degradation handoff is unavailable."); if (typeof body.text !== "string" || body.text.length > 8192) throw new Error("The degradation handoff response is invalid."); handoffText.textContent = body.text; }); }).catch(function (error) { handoffText.textContent = error instanceof Error ? error.message : "The degradation handoff is unavailable."; }); }\n' +
  '  var showWaitWithoutVerification = showWait; showWait = function (stage) { showWaitWithoutVerification(stage); loadVerificationProjections(currentRunId); };\n' +
  '  var hideWaitWithoutVerification = hideWait; hideWait = function () { hideWaitWithoutVerification(); loadVerificationProjections(currentRunId); };\n' +
  '  var renderRailHistoryWithoutVerification = renderRailHistory; renderRailHistory = function (entries) { if (!currentRunId) clearVerificationProjections(); renderRailHistoryWithoutVerification(entries); };\n' +
  '  function renderArtifactList(list, body) { list.replaceChildren(); var paths = body.artifacts || []; if (!paths.length) { var empty = document.createElement("li"); empty.textContent = "No validated artifacts yet."; list.appendChild(empty); return; } paths.forEach(function (path) { var item = document.createElement("li"); item.textContent = path; var link = (body.artifactLinks || []).find(function (entry) { return entry.path === path; }); if (link) { item.textContent = ""; var anchor = document.createElement("a"); anchor.href = link.url; anchor.target = "_blank"; anchor.rel = "noopener"; anchor.textContent = path; item.appendChild(anchor); } list.appendChild(item); }); }\n' +
  '  function renderArtifacts(body) { renderArtifactList(document.getElementById("artifact-checklist"), body); }\n' +
  '  function renderRecoveryReport(recovery) { var panel = document.getElementById("recovery-report"); document.getElementById("journey-summary").after(panel); panel.hidden = !recovery || (recovery.status !== "repaired" && recovery.status !== "stopped"); if (panel.hidden) return; var fitDiagnosticFields = {scope_repository:["repository","authorizedWorkspaceRoot"],receipt_shape:["receipt"],receipt_reason:["reason"],receipt_ok:["ok"],question_text:["question"],assumption_shape:["assumption"],assumption_repository:["repository"],assumption_plan_directory:["planDirectory"],assumption_rationale:["rationale"],assumption_evidence:["evidence"],evidence_shape:["evidence"],evidence_kind:["kind"],evidence_path:["path"],evidence_detail:["detail"],evidence_containment:["path"],result_envelope:["assistantText","envelope"]}; var fitDiagnostic = recovery.fitDiagnostic; var fields = fitDiagnostic && typeof fitDiagnostic.check === "string" && typeof fitDiagnostic.field === "string" ? fitDiagnosticFields[fitDiagnostic.check] : undefined; var hasFitDiagnostic = Array.isArray(fields) && fields.indexOf(fitDiagnostic.field) !== -1; var diagnosticSummary = hasFitDiagnostic ? " Repository fit check: " + fitDiagnostic.check + "; field: " + fitDiagnostic.field + "." : ""; document.getElementById("recovery-heading").textContent = recovery.status === "repaired" ? "Bearing repaired a recoverable agent error." : "Bearing stopped a repeated recoverable agent error."; document.getElementById("recovery-summary").textContent = "Stage " + recovery.stage + (recovery.status === "repaired" ? " recovered from " : " stopped after ") + recovery.code + " using " + recovery.retryLevel + "." + diagnosticSummary; document.getElementById("report-recovery-bug").onclick = function () { var title = "Bearing " + recovery.version + ": " + recovery.code + " during " + recovery.stage; var body = ["Bearing version: " + recovery.version, "Stage: " + recovery.stage, "Failure class: " + recovery.failureClass, "Failure code: " + recovery.code, "Retry level: " + recovery.retryLevel].concat(hasFitDiagnostic ? ["Repository fit check: " + fitDiagnostic.check, "Repository fit field: " + fitDiagnostic.field] : []).join("\\n"); window.open("https://github.com/alphazede/bearing/issues/new?title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body), "_blank", "noopener,noreferrer"); }; }\n' +
  '  function recordPlanReview(answer) { var question = "Approve the complete planning package before implementation?"; return readRun(currentRunId).then(function (state) { if (state.pendingDecision && state.pendingDecision.question !== question) throw new Error("Resolve the current owner decision before reviewing the route."); var save = state.pendingDecision ? Promise.resolve(state) : postCommand(currentRunId, state, "requireDecision", { decisionId: "plan-review-" + crypto.randomUUID(), question: question, consequential: true }).then(function () { return readRun(currentRunId); }); return save; }).then(function (state) { if (!state.pendingDecision || state.pendingDecision.question !== question) throw new Error("Planning approval could not be recorded."); return postCommand(currentRunId, state, "recordOwnerAnswer", { decisionId: state.pendingDecision.decisionId, answer: answer }); }); }\n' +
  '  function confirmFocusAmendment(stage) { var question = "The approved Focus contract changed. Review the drift summary. Confirm the Focus amendment to adopt the updated plan and recapture the Git baseline."; var answer = "Confirmed Focus amendment for execution retry"; var decisionId = "focus-amendment-" + crypto.randomUUID(); return readRun(currentRunId).then(function (state) { if (state.pendingDecision) throw new Error("Resolve the current owner decision before confirming the Focus amendment."); return postCommand(currentRunId, state, "requireDecision", { decisionId: decisionId, question: question, consequential: true }); }).then(function () { return readRun(currentRunId); }).then(function (state) { if (!state.pendingDecision || state.pendingDecision.decisionId !== decisionId || state.pendingDecision.question !== question) throw new Error("Focus amendment confirmation could not be recorded."); return postCommand(currentRunId, state, "recordOwnerAnswer", { decisionId: decisionId, answer: answer }); }).then(function () { return readRun(currentRunId); }).then(function (state) { if (state.pendingDecision) throw new Error("Another owner decision is pending."); focusAmendmentPending = false; invokeJourney(stage, { focusAmendmentConfirmed: true, focusAmendmentDecisionId: decisionId, focusAmendmentExpectedRevision: state.revision }); }, showError); }\n' +
  '  function renderPlanReview(body) { var review = body.planningReview; if (!review) { renderFailure({ code: "artifact_invalid" }); return; } planningPanel.hidden = true; planReviewPanel.hidden = false; var recovery = document.getElementById("recovery-report"); if (!recovery.hidden) planReviewPanel.querySelector(".panel-body").prepend(recovery); document.getElementById("plan-review-summary").textContent = body.summary; document.getElementById("review-phase-count").textContent = String(review.phases); document.getElementById("review-slice-count").textContent = String(review.slices); document.getElementById("review-route").textContent = review.assignments.length + " assigned routes"; renderArtifactList(document.getElementById("review-artifacts"), body); var target = document.getElementById("review-assignments"); target.replaceChildren(); review.assignments.forEach(function (assignment) { var row = document.createElement("tr"); [assignment.slice, assignment.role, assignment.model, assignment.reasoning].forEach(function (value) { var cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell); }); target.appendChild(row); }); var validation = body.planningValidation || {}; var verdict = validation.verdict || "NEEDS_AMENDMENT"; var findings = Array.isArray(validation.findings) ? validation.findings : []; var findingPanel = document.getElementById("review-findings-panel"); var findingList = document.getElementById("review-findings"); findingList.replaceChildren(); findings.forEach(function (finding) { var item = document.createElement("li"); item.textContent = [finding.code, finding.artifact, finding.sliceId].filter(Boolean).join(" · ") + ": " + finding.observed + " Required: " + finding.required + " Remedy: " + finding.remedy; findingList.appendChild(item); }); findingPanel.hidden = findings.length === 0; document.getElementById("review-verdict").textContent = verdict === "PASS" ? "Planning validation passed with advisory findings." : verdict === "OWNER_DECISION_REQUIRED" ? "Owner decision required before approval." : "Planning amendments required before approval."; var approve = document.getElementById("approve-plan"); approve.disabled = verdict !== "PASS"; document.getElementById("review-change").value = ""; setStatus(verdict === "PASS" ? "Review every artifact, request changes, or approve the route." : verdict === "OWNER_DECISION_REQUIRED" ? "Review the findings and record the required owner decision before approval." : "Review the findings and request the required planning amendments.", false); }\n' +
  '  function renderFailure(body) { hideWait(); planningSubmit.disabled = false; planningAnswerForm.hidden = true; document.getElementById("journey-action").hidden = true; document.getElementById("mode-choice").hidden = true; var complete = document.getElementById("journey-complete"); complete.hidden = false; complete.firstElementChild.textContent = "Journey paused"; focusAmendmentPending = body.code === "focus_amendment_required"; document.getElementById("journey-summary").textContent = body.code === "artifact_invalid" && currentStage === "draft-implementation" ? "Your questions are complete; the generated files need another validation pass." : "Bearing saved your progress and stopped before moving to the next phase."; var drift = body.focusDrift && Array.isArray(body.focusDrift.changedPlanSources) ? " Changed plan sources: " + body.focusDrift.changedPlanSources.join(", ") + "." : ""; document.getElementById("completion-summary").textContent = focusAmendmentPending ? (body.amendmentPrompt || "Review and confirm the Focus amendment.") + drift : body.continuityLost ? body.continuityDisclosure : body.escalationTarget ? "Automatic retry stopped. Escalation target: " + body.escalationTarget + "." : body.retryRefusal ? "Retry refused: " + body.retryRefusal + "." : body.code === "cancelled" ? "You stopped " + phaseNames[currentStage] + ". Any Git changes remain visible and the phase can be retried." : body.code === "interrupted" ? "Bearing stopped while " + phaseNames[currentStage] + " was running. Inspect the Git changes before deciding whether to retry the saved phase." : body.code === "token_budget" ? "This run reached its token budget before the phase completed. Retry after lowering reasoning with /model or raise the CLI budget." : body.recovery && body.recovery.status === "stopped" ? "Bearing tried one focused repair and one simpler contract-preserving repair. The same deterministic failure remains, so automatic repair stopped: " + body.code + "." : body.code === "artifact_invalid" && currentStage === "draft-implementation" ? "Your answers and planning files are saved. Bearing could not verify the generated implementation package. Retry this step; you will not repeat the questions." : "The agent could not complete " + phaseNames[currentStage] + ": " + (body.code || "request_failed") + ". No success was recorded."; document.getElementById("completion-artifacts").replaceChildren(); var retry = document.getElementById("journey-retry"); retry.textContent = focusAmendmentPending ? "Confirm amendment" : "Retry"; retry.hidden = !focusAmendmentPending && (!!body.continuityLost || !!body.escalationTarget || !!body.retryRefusal || !!(body.recovery && body.recovery.status === "stopped")); document.getElementById("new-journey").hidden = true; setStatus(focusAmendmentPending ? "Owner confirmation is required for the Focus amendment." : body.continuityLost ? "Conversation continuity was lost; review the disclosure." : body.escalationTarget ? "Automatic retry escalated to " + body.escalationTarget + "." : body.retryRefusal ? "Retry refused: " + body.retryRefusal + "." : body.code === "cancelled" ? "Journey stopped by owner." : body.code === "interrupted" ? "Journey interrupted. Inspect changes before retrying." : body.recovery && body.recovery.status === "stopped" ? "Automatic repair stopped after repeated equivalent failures." : "Journey blocked. Retry is available.", false); }\n' +
  '  function renderJourney(body) { hideWait(); planningSubmit.disabled = false; renderArtifacts(body); renderRecoveryReport(body.recovery); pendingQuestionCount = body.status === "question" && Array.isArray(body.questions) ? Math.max(0, body.questions.length - 1) : 0; document.getElementById("journey-phase").textContent = phaseNames[currentStage].toUpperCase(); document.getElementById("journey-heading").textContent = phaseNames[currentStage]; document.getElementById("journey-summary").textContent = body.status === "action" ? body.summary : currentStage === "gather-supplies" ? "Answer the planning questions before the route map is written." : "The selected agent needs an owner answer before it can continue."; document.getElementById("journey-complete").hidden = true; document.getElementById("mode-choice").hidden = true; document.getElementById("journey-action").hidden = true; if (body.status === "failure") { renderFailure(body); return; } if (body.status === "question") { document.getElementById("journey-question-box").hidden = false; document.getElementById("planning-question").textContent = body.question || ""; var help = questionHelp(body.question || ""); document.getElementById("question-help").textContent = help; document.getElementById("question-help").hidden = !help; planningAnswerForm.hidden = false; planningAnswer.value = ""; planningAnswer.focus(); setStatus(currentStage === "gather-supplies" && pendingQuestionCount ? "Question saved locally. " + pendingQuestionCount + " remaining." : phaseNames[currentStage] + " needs your answer.", false); return; } document.getElementById("journey-question-box").hidden = true; document.getElementById("question-help").hidden = true; planningAnswerForm.hidden = true; if (currentStage === "draft-implementation") { renderPlanReview(body); return; } if (currentStage === "execute-explorer" || currentStage === "execute-expedition") { invokeJourney("review"); return; } if (currentStage === "review") { document.getElementById("journey-complete").hidden = false; document.getElementById("completion-summary").textContent = body.summary; renderArtifactList(document.getElementById("completion-artifacts"), body); document.getElementById("journey-retry").hidden = true; document.getElementById("new-journey").hidden = false; setStatus("Journey complete. Review the validated evidence.", false); return; } var next = document.getElementById("journey-next"); next.textContent = currentStage === "set-bearings" ? "Gather Supplies" : "Map the Route"; document.getElementById("journey-action").hidden = false; setStatus(phaseNames[currentStage] + " complete. Owner handoff required.", false); }\n' +
  '  var renderJourneyResponse = renderJourney; renderJourney = function (body) { cacheEstimate(body); if (body.status === "action" && currentStage === "recon" && body.recon && (body.recon.state === "OWNER_DECISION_REQUIRED" || body.recon.state === "RECON_FAILED")) { renderFailure({ code: body.recon.state === "RECON_FAILED" ? "recon_failed" : "owner_decision_required" }); return; } renderJourneyResponse(body); if (body.status === "action" && currentStage === "repository-fit") invokeJourney("set-bearings"); else if (body.status === "action" && currentStage === "gather-supplies") invokeJourney("map-route"); else if (body.status === "action" && currentStage === "map-route") invokeJourney("recon"); else if (body.status === "action" && currentStage === "recon" && body.recon && (body.recon.state === "SKIPPED" || body.recon.state === "RECON_READY")) invokeJourney("draft-implementation"); };\n' +
  '  function renderSavedExecution(body) { hideWait(); retryStage = "review"; planningSubmit.disabled = false; planningAnswerForm.hidden = true; document.getElementById("journey-action").hidden = true; document.getElementById("mode-choice").hidden = true; var complete = document.getElementById("journey-complete"); complete.hidden = false; complete.firstElementChild.textContent = "Implementation saved"; document.getElementById("journey-summary").textContent = "Implementation completed successfully and is durably saved."; document.getElementById("completion-summary").textContent = "The follow-on review request disconnected. Your implementation success is saved; choose Retry to start Surveyor review."; renderArtifactList(document.getElementById("completion-artifacts"), body); document.getElementById("journey-retry").hidden = false; document.getElementById("new-journey").hidden = true; setStatus("Implementation complete and saved. Review is ready when you are.", false); }\n' +
  '  function reconcileJourney() { var runId = currentRunId, stage = currentStage; clearTimeout(reconcileTimer); reconcileTimer = null; fetch("/api/v1/journey/" + encodeURIComponent(runId) + "/status", { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("status"); return r.json(); }).then(function (body) { if (currentRunId !== runId || currentStage !== stage) return; var run = body.run; if (!run) throw new Error("unsaved"); currentStage = run.stage; if (run.status === "running") { if (document.getElementById("journey-wait").hidden || run.stage !== stage) showWait(currentStage); setStatus("Reconnected to the saved " + phaseNames[currentStage] + " action.", true); reconcileTimer = setTimeout(function () { if (currentRunId === runId && currentStage === run.stage && !document.getElementById("journey-wait").hidden) reconcileJourney(); }, 2000); return; } if (!run.lastResult) throw new Error("unsaved"); var result = Object.assign({}, run.lastResult, { artifacts: run.artifacts || [], artifactLinks: run.artifactLinks || [] }); cacheEstimate(result); if ((run.stage === "execute-explorer" || run.stage === "execute-expedition") && result.status === "action") { renderSavedExecution(result); return; } renderJourney(result); }, function () { if (currentRunId === runId && currentStage === stage) renderFailure({ code: "network_error" }); }); }\n' +
  '  function invokeJourney(stage, extra, quiet) { currentStage = stage; if (!quiet) showWait(stage); var payload = Object.assign({ runId: currentRunId, stage: stage, workGoal: currentGoal }, extra || {}); fetch("/api/v1/journey", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) }).then(function (r) { return r.json().catch(function () { return { status: "failure", code: "request_failed" }; }).then(function (body) { if (!r.ok && body.status !== "failure") return { status: "failure", code: "request_failed" }; return body; }); }).then(function (body) { return body.status === "question" && body.question ? persistAgentQuestion(body.question).then(function () { return body; }) : body; }).then(renderJourney, reconcileJourney); }\n' +
  '  function showError(error) { setStatus(error instanceof Error ? error.message : "Request failed.", false); }\n' +
  '  function showDemoStage(next) { var stages = document.querySelectorAll("[data-demo-stage]"); var progress = document.querySelectorAll(".demo-progress li"); demoStage = Math.max(0, Math.min(stages.length - 1, next)); stages.forEach(function (stage, index) { stage.hidden = index !== demoStage; }); progress.forEach(function (step, index) { if (index === demoStage) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current"); }); document.getElementById("demo-step").textContent = "Step " + (demoStage + 1) + " of " + stages.length; document.getElementById("demo-prev").disabled = demoStage === 0; document.getElementById("demo-next").textContent = demoStage === stages.length - 1 ? (currentRunId ? "Back to journey" : "Start journey") : "Next \\u2192"; }\n' +
  '  function chooseDemoMode(mode) { demoMode = mode; ["explorer", "expedition"].forEach(function (name) { var card = document.getElementById("demo-" + name); var selected = name === mode; card.classList.toggle("selected", selected); card.setAttribute("aria-pressed", String(selected)); }); if (!mode) { document.getElementById("demo-mode-status").textContent = "Choose a card to continue the tutorial."; document.getElementById("demo-selected-mode").textContent = "Your selected execution mode appears here."; return; } document.getElementById("demo-mode-status").textContent = (mode === "explorer" ? "Explorer selected: focused execution with fewer agent sessions." : "Expedition selected: parallel execution with more coordination.") + " Tutorial only; nothing was launched."; document.getElementById("demo-selected-mode").textContent = "Tutorial selection: " + (mode === "explorer" ? "Explorer" : "Expedition") + ". In a real run, Bearing records owner approval before execution."; }\n' +
  '  function openDemo() { demoReturnPanel = !planReviewPanel.hidden ? planReviewPanel : !planningPanel.hidden ? planningPanel : !workForm.hidden ? workForm : !routeForm.hidden ? routeForm : repositoryPanel; [repositoryPanel, routeForm, workForm, planningPanel, planReviewPanel].forEach(function (panel) { panel.hidden = true; }); demoPanel.hidden = false; viewDemo.textContent = "Exit tutorial"; chooseDemoMode(""); showDemoStage(0); setStatus("How it works. No model calls or tokens.", false); }\n' +
  '  function closeDemoPanel() { demoPanel.hidden = true; viewDemo.textContent = "See how it works"; if (demoReturnPanel) demoReturnPanel.hidden = false; setStatus(rememberedGreeting || (demoReturnPanel === repositoryPanel ? "Choose a repository." : "Tutorial closed."), false); }\n' +
  '  function configureRoute(route) { var modelChoice = document.getElementById("model-choice"); var reasoningChoice = document.getElementById("reasoning-choice"); var config = document.getElementById("route-config"); selectedRoute = null; config.hidden = true; document.getElementById("launch-bearing").disabled = true; detectedRoutes.textContent = "Loading model choices for " + route.id + "…"; fetch("/api/v1/routes/" + encodeURIComponent(route.id) + "/models", { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("models"); return r.json(); }).then(function (body) { var models = body.models || []; modelChoice.replaceChildren(); models.forEach(function (option) { var item = document.createElement("option"); item.value = option.model; item.textContent = option.label; if (option.model === route.model) item.selected = true; modelChoice.appendChild(item); }); function configureReasoning() { var option = models.find(function (candidate) { return candidate.model === modelChoice.value; }) || models[0]; reasoningChoice.replaceChildren(); if (!option) return; reasoningTiers.forEach(function (level) { var item = document.createElement("option"); item.value = level; item.textContent = level; reasoningChoice.appendChild(item); }); var preferred = reasoningTiers.indexOf(route.reasoning) >= 0 ? route.reasoning : reasoningTiers.indexOf(option.defaultReasoning) >= 0 ? option.defaultReasoning : "medium"; reasoningChoice.value = preferred; selectedRoute = { id: route.id, provider: route.provider, model: option.model, reasoning: reasoningChoice.value }; document.getElementById("launch-bearing").disabled = false; } modelChoice.onchange = configureReasoning; reasoningChoice.onchange = function () { selectedRoute = { id: route.id, provider: route.provider, model: modelChoice.value, reasoning: reasoningChoice.value }; }; config.hidden = false; configureReasoning(); detectedRoutes.textContent = "Model choices loaded. Choose a model and reasoning level."; }, function () { detectedRoutes.textContent = "Model choices unavailable. Choose another detected agent or refresh detection."; }); }\n' +
  '  function renderRoutes(routes) { var names = { "codex": "Codex CLI", "claude": "Claude Code", "agy": "Agy", "grok-build": "Grok Build", "opencode": "OpenCode", "pi": "Pi" }; var firstAvailable = null; selectedRoute = null; document.getElementById("route-config").hidden = true; document.getElementById("launch-bearing").disabled = true; routeOptions.replaceChildren(); routes.forEach(function (route, index) { var label = document.createElement("label"); label.className = "route-card" + (route.detected ? "" : " unavailable"); var input = document.createElement("input"); input.type = "radio"; input.name = "route"; input.id = "route-option-" + index; input.required = true; input.disabled = !route.detected; input.addEventListener("change", function () { configureRoute(route); }); var copy = document.createElement("span"); var title = document.createElement("strong"); title.textContent = names[route.id] || route.id; var statusText = document.createElement("span"); statusText.className = "route-status"; statusText.id = input.id + "-status"; statusText.textContent = route.detected ? "Agent detected" : "Agent unavailable"; input.setAttribute("aria-describedby", statusText.id); var modelText = document.createElement("span"); modelText.className = "route-model"; modelText.textContent = (route.model === "*" ? "Current model: agent default" : "Current model: " + route.model) + " · reasoning: " + route.reasoning; copy.append(title, statusText, modelText); label.append(input, copy); routeOptions.appendChild(label); if (!firstAvailable && route.detected) firstAvailable = input; }); var detected = routes.filter(function (route) { return route.detected; }).length; detectedRoutes.textContent = detected + " of " + routes.length + " supported agents detected. Choose one to see its models and reasoning levels."; if (firstAvailable) firstAvailable.focus(); }\n' +
  '  function loadRoutes() { detectedRoutes.textContent = "Checking supported agents\u2026"; fetch("/api/v1/routes", { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("routes"); return r.json(); }).then(function (body) { renderRoutes(body.routes); }, function () { detectedRoutes.textContent = "Agent detection unavailable; no route has been selected or verified."; }); }\n' +
  '  function resumeRailEntry(entry) { [repositoryPanel, routeForm, workForm, planningPanel, planReviewPanel, historyPanel, demoPanel].forEach(function (panel) { panel.hidden = true; }); var hasSavedResult = !!(entry.stage && entry.lastResult); if (entry.busy && entry.stage) { currentRunId = entry.runId; currentGoal = entry.goal; currentStage = entry.stage; planningPanel.hidden = false; showWait(currentStage); setStatus("Returned to the active journey.", true); } else if (hasSavedResult) { currentRunId = entry.runId; currentGoal = entry.goal; currentStage = entry.stage; planningPanel.hidden = false; renderJourney(Object.assign({}, entry.lastResult, { artifacts: entry.artifacts || [], artifactLinks: entry.artifactLinks || [] })); setStatus(entry.status === "complete" ? "Opened completed journey evidence." : "Resumed the saved journey.", false); } else { currentRunId = ""; currentGoal = ""; workForm.hidden = false; document.getElementById("work-goal").value = entry.goal; document.getElementById("work-goal").focus(); setStatus("Saved request loaded. Embark when you are ready to start a new journey.", false); } renderRailHistory(historyEntries); appShell.classList.remove("rail-open"); }\n' +
  '  function renderRailHistory(entries) { historyEntries = entries; railHistoryList.replaceChildren(); var query = document.getElementById("history-search").value.trim().toLowerCase(); var shown = entries.filter(function (entry) { return !query || (entry.title + " " + entry.goal).toLowerCase().includes(query); }); if (!shown.length) { var empty = document.createElement("p"); empty.className = "rail-empty"; empty.textContent = entries.length ? "No matching journeys." : selectedRepositoryPath ? "No journeys yet." : "Choose a workspace to see its journeys."; railHistoryList.appendChild(empty); return; } shown.forEach(function (entry) { var action = document.createElement("button"); action.type = "button"; action.className = "rail-journey" + (entry.runId === currentRunId ? " current" : ""); action.setAttribute("aria-label", (entry.busy ? "Return to running journey: " : "Open journey: ") + entry.title); var dot = document.createElement("span"); dot.className = "journey-dot " + (entry.busy ? "running" : entry.status === "complete" ? "complete" : "paused"); dot.setAttribute("aria-hidden", "true"); var copy = document.createElement("div"); var title = document.createElement("strong"); title.textContent = entry.title; var detail = document.createElement("small"); detail.textContent = entry.busy ? "Running · " + (phaseNames[entry.stage] || entry.stage || "Working") : entry.status === "complete" ? "Complete" : "Saved · " + new Date(entry.updatedAt).toLocaleDateString(); copy.append(title, detail); action.append(dot, copy); action.addEventListener("click", function () { resumeRailEntry(entry); }); railHistoryList.appendChild(action); }); }\n' +
  '  function loadRailHistory() { if (!selectedRepositoryPath) return; fetch("/api/v1/history", { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("history"); return r.json(); }).then(function (body) { renderRailHistory(body.history || []); }, function () { railHistoryList.replaceChildren(); var empty = document.createElement("p"); empty.className = "rail-empty"; empty.textContent = "History is temporarily unavailable."; railHistoryList.appendChild(empty); }); }\n' +
  '  function renderHistory(entries) { historyList.replaceChildren(); document.getElementById("clear-history").disabled = !entries.length; if (!entries.length) { var empty = document.createElement("p"); empty.textContent = "No saved journeys in this repository yet."; historyList.appendChild(empty); return; } entries.forEach(function (entry) { var card = document.createElement("article"); card.className = "history-card"; var copy = document.createElement("div"); var title = document.createElement("strong"); title.textContent = entry.title; var detail = document.createElement("span"); detail.textContent = entry.status + " · " + new Date(entry.updatedAt).toLocaleString(); copy.append(title, detail); var actions = document.createElement("div"); actions.className = "history-actions"; var action = document.createElement("button"); action.type = "button"; var hasSavedResult = !!(entry.stage && entry.lastResult); action.textContent = entry.busy ? "Return to running journey" : entry.status === "complete" && hasSavedResult ? "View completed evidence" : hasSavedResult ? "Resume journey" : "Reuse request"; action.addEventListener("click", function () { historyPanel.hidden = true; if (entry.busy && entry.stage) { currentRunId = entry.runId; currentGoal = entry.goal; currentStage = entry.stage; planningPanel.hidden = false; showWait(currentStage); setStatus("Returned to the active journey.", true); } else if (hasSavedResult) { currentRunId = entry.runId; currentGoal = entry.goal; currentStage = entry.stage; planningPanel.hidden = false; renderJourney(Object.assign({}, entry.lastResult, { artifacts: entry.artifacts || [], artifactLinks: entry.artifactLinks || [] })); setStatus(entry.status === "complete" ? "Opened completed journey evidence." : "Resumed the saved journey.", false); } else { workForm.hidden = false; document.getElementById("work-goal").value = entry.goal; document.getElementById("work-goal").focus(); setStatus("Saved request loaded. Embark when you are ready to start a new journey.", false); } }); var remove = document.createElement("button"); remove.type = "button"; remove.className = "danger"; remove.textContent = "Delete"; remove.disabled = !!entry.busy; remove.addEventListener("click", function () { if (!confirm("Delete this journey from history? Generated files will stay in the repository.")) return; deleteHistory(entry.runId); }); actions.append(action, remove); card.append(copy, actions); historyList.appendChild(card); }); }\n' +
  '  function loadHistory() { setStatus("Loading local journey history\u2026", true); fetch("/api/v1/history", { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("History could not be loaded", r); return r.json(); }).then(function (body) { renderRailHistory(body.history || []); renderHistory(body.history || []); setStatus("Journey history for this repository.", false); }, showError); }\n' +
  '  function deleteHistory(runId) { setStatus(runId ? "Removing journey from history\u2026" : "Clearing journey history\u2026", true); fetch(runId ? "/api/v1/history/" + encodeURIComponent(runId) : "/api/v1/history", { method: "DELETE", credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("History could not be deleted", r); if (!runId || currentRunId === runId) { currentRunId = ""; currentGoal = ""; historyReturnPanel = workForm; } return loadHistory(); }, showError); }\n' +
  '  function openHistory() { historyReturnPanel = !planReviewPanel.hidden ? planReviewPanel : !planningPanel.hidden ? planningPanel : !workForm.hidden ? workForm : routeForm; [repositoryPanel, routeForm, workForm, planningPanel, planReviewPanel, demoPanel].forEach(function (panel) { panel.hidden = true; }); historyPanel.hidden = false; loadHistory(); }\n' +
  '  function closeHistory() { historyPanel.hidden = true; if (historyReturnPanel) historyReturnPanel.hidden = false; setStatus(historyReturnPanel === planningPanel ? "Returned to the journey." : rememberedGreeting || "History closed.", false); }\n' +
  '  function startNewJourney() { if (!document.getElementById("journey-wait").hidden) { setStatus("The current phase is still running. Stop it or return through Journeys before starting another.", false); return; } [repositoryPanel, routeForm, planningPanel, planReviewPanel, historyPanel, demoPanel].forEach(function (panel) { panel.hidden = true; }); workForm.hidden = false; currentRunId = ""; currentGoal = ""; journeyMode = ""; document.getElementById("work-goal").value = ""; renderRailHistory(historyEntries); appShell.classList.remove("rail-open"); setStatus("Ready for another journey.", false); document.getElementById("work-goal").focus(); }\n' +
  '  function revealWork(greeting) { onboardingReady = true; document.body.classList.add("workspace-ready"); closeSetupSheets(); planningPanel.hidden = true; planReviewPanel.hidden = true; historyPanel.hidden = true; workForm.hidden = false; historyButton.hidden = false; changeRepository.hidden = false; changeRepository.textContent = "Change repository"; if (greeting) document.getElementById("work-greeting").textContent = greeting; syncShellSummary(); loadRailHistory(); setStatus("Ready for a new journey.", false); document.getElementById("work-goal").focus(); }\n' +
  '  function finishReady(name, forcePersist) { if (!forcePersist && rememberedName === name && rememberedGreeting) { revealWork(rememberedGreeting); return; } setStatus("Saving your bearings...", true); fetch("/api/v1/owner", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ name: name }) }).then(function (r) { if (!r.ok) throw new Error("owner"); return r.json(); }).then(function (body) { rememberedName = body.name; rememberedGreeting = body.greeting; revealWork(body.greeting); }, function () { setStatus("Your name could not be remembered. Try again.", false); }); }\n' +
  '  function closeSetupSheets() { repositoryPanel.hidden = true; routeForm.hidden = true; document.getElementById("workspace-chip").setAttribute("aria-expanded", "false"); [workBack, document.getElementById("model-chip"), document.getElementById("reasoning-chip")].forEach(function (button) { button.setAttribute("aria-expanded", "false"); }); }\n' +
  '  function openWorkspacePicker() { closeSetupSheets(); chooseRepository("browse"); }\n' +
  '  function openRouteChooser() { if (!selectedRepositoryPath) { openWorkspacePicker(); return; } repositoryPanel.hidden = true; routeForm.hidden = false; [workBack, document.getElementById("model-chip"), document.getElementById("reasoning-chip")].forEach(function (button) { button.setAttribute("aria-expanded", "true"); }); document.getElementById("workspace-chip").setAttribute("aria-expanded", "false"); setStatus("Choose your agent, model, and reasoning.", false); if (!routeOptions.childElementCount) loadRoutes(); }\n' +
  '  function toggleRepositoryChooser() { if (!demoPanel.hidden) closeDemoPanel(); if (!repositoryPanel.hidden) { hideRepositoryConsent(); repositoryPanel.hidden = true; document.getElementById("workspace-chip").setAttribute("aria-expanded", "false"); changeRepository.textContent = "Change repository"; setStatus(rememberedGreeting || "Workspace unchanged.", false); return; } routeForm.hidden = true; repositoryPanel.hidden = false; document.getElementById("workspace-chip").setAttribute("aria-expanded", "true"); [workBack, document.getElementById("model-chip"), document.getElementById("reasoning-chip")].forEach(function (button) { button.setAttribute("aria-expanded", "false"); }); changeRepository.textContent = selectedRepositoryPath ? "Keep current" : "Choose repository"; setStatus("Choose a workspace. Your current screen will stay open.", false); loadRepositoryOptions(); }\n' +
  '  function restoreRepositoryControls() { currentRepository.disabled = false; browseRepository.disabled = !browseAvailable; currentRepository.focus(); }\n' +
  '  function hideRepositoryConsent() { repositoryConsentChoice = null; repositoryConsent.hidden = true; repositoryConsentMessage.textContent = ""; }\n' +
  '  // Inline, non-blocking consent: no modal dialog can stall an automated or headless driver.\n' +
  '  function askRepositoryConsent(message, confirmLabel, dismissLabel, onConfirm, onDismiss) { repositoryConsentChoice = { confirm: onConfirm, dismiss: onDismiss }; repositoryConsentMessage.textContent = message; repositoryConsentConfirm.textContent = confirmLabel; repositoryConsentDismiss.textContent = dismissLabel; repositoryConsent.hidden = false; repositoryPanel.hidden = false; document.getElementById("workspace-chip").setAttribute("aria-expanded", "true"); repositoryConsentConfirm.focus(); }\n' +
  '  function answerRepositoryConsent(accepted) { var pending = repositoryConsentChoice; hideRepositoryConsent(); if (!pending) return; var act = accepted ? pending.confirm : pending.dismiss; if (act) act(); }\n' +
  '  function addBearingGitignore() { fetch("/api/v1/repository/gitignore", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}" }).then(function (r) { return r.json().then(function (body) { if (!r.ok) setStatus(body.remedy || "The .gitignore update was blocked.", false); }); }, function () { setStatus("The .gitignore update failed. Try again.", false); }); repositoryPanel.hidden = true; openRouteChooser(); }\n' +
  '  function loadRepositoryOptions() { fetch("/api/v1/repository-options", { credentials: "same-origin" }).then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); }).then(function (result) { if (!result.ok) { browseAvailable = false; setStatus(result.body.remedy || "Repository options unavailable. Current repository remains available.", false); restoreRepositoryControls(); return; } var body = result.body; browseAvailable = body.browse.available; document.getElementById("platform-name").textContent = body.platform; var distro = document.getElementById("distro-name"); if (body.linuxDistro) { distro.textContent = body.linuxDistro; distro.hidden = false; } document.getElementById("picker-state").textContent = browseAvailable ? "BROWSE READY" : "BROWSE UNAVAILABLE"; document.getElementById("repository-source").textContent = body.current.source === "git-root" ? "Detected launch Git root" : "Detected launch directory"; document.getElementById("repository-name").textContent = body.current.source === "git-root" ? "Use current repository" : "Use current directory"; document.getElementById("repository-path").textContent = body.current.path; restoreRepositoryControls(); }, function () { browseAvailable = false; setStatus("Repository options unavailable. Current repository remains available.", false); restoreRepositoryControls(); }); }\n' +
  '  function chooseRepository(choice, confirmNonGit) { var payload = { choice: choice }; if (confirmNonGit === true) payload.confirmNonGit = true; submitRepository(payload, choice === "browse" ? "Opening system repository picker..." : "Validating current repository..."); }\n' +
  '  function confirmNonGitRepository(candidate, choice) { if (candidate) { submitRepository({ path: candidate, confirmNonGit: true }, "Confirming planning-only directory..."); return true; } if (choice) { chooseRepository(choice, true); return true; } return false; }\n' +
  '  function submitRepository(payload, pending) { hideRepositoryConsent(); currentRepository.disabled = true; browseRepository.disabled = true; setStatus(pending, true); fetch("/api/v1/repository", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) }).then(function (r) { return r.text().then(function (text) { var body = {}; try { body = JSON.parse(text); } catch (_) {} return { ok: r.ok, status: r.status, body: body }; }); }).then(function (result) { if (!result.ok) { var code = result.body.code || "repository_selection_failed"; var remedy = result.body.remedy || ""; if (code === "repository_not_git") { var candidate = result.body.candidate; var rejected = payload.choice; setStatus(remedy, false); restoreRepositoryControls(); askRepositoryConsent(remedy, "Use for planning-only", "Choose another", function () { confirmNonGitRepository(candidate, rejected); }, function () { setStatus("Repository unchanged. Choose a Git repository.", false); restoreRepositoryControls(); }); return; } if (code === "repository_picker_unavailable") { browseAvailable = false; repositoryPanel.hidden = false; document.getElementById("workspace-chip").setAttribute("aria-expanded", "true"); loadRepositoryOptions(); } if (code === "journey_in_progress") changeRepository.textContent = "Return to journey"; setStatus(remedy || (code === "journey_in_progress" ? "The active journey is still running. Return to it before changing repositories." : code === "repository_picker_cancelled" ? "Browse cancelled. Current repository is still available." : code === "repository_picker_unavailable" ? "System picker unavailable. Use the current repository." : code === "repository_picker_timeout" ? "System picker timed out. Try again or use current." : code === "repository_picker_invalid" ? "Picker returned an invalid repository. Nothing changed." : "Repository could not be chosen (" + result.status + ")."), false); restoreRepositoryControls(); return; } var repositoryHasOwner = !!result.body.ownerName; if (repositoryHasOwner) rememberedName = result.body.ownerName; rememberedGreeting = result.body.greeting || ""; selectedRepositoryPath = result.body.repositoryPath || ""; syncShellSummary(); loadRailHistory(); document.getElementById("owner-name").value = rememberedName; changeRepository.hidden = false; changeRepository.textContent = "Change repository"; viewDemo.textContent = "See how it works"; planningPanel.hidden = true; planReviewPanel.hidden = true; historyPanel.hidden = true; demoPanel.hidden = true; workForm.hidden = false; setStatus(rememberedGreeting || (result.body.status === "resumed" ? "Repository resumed. Choose your agent settings." : result.body.disclosure || "Workspace ready. Choose your agent settings."), false); if (result.body.status === "initialized" && result.body.gitignoreMissing) { askRepositoryConsent("`.bearing/` is not gitignored. Add it so planning state is never committed?", "Add .bearing/ to .gitignore", "Not now", addBearingGitignore, function () { repositoryPanel.hidden = true; openRouteChooser(); setStatus(".gitignore left unchanged. Choose your agent, model, and reasoning.", false); }); return; } repositoryPanel.hidden = true; openRouteChooser(); }, function () { setStatus("Repository request failed. Try again.", false); restoreRepositoryControls(); }); }\n' +
  "  // The capability lives only in the fragment; it is never sent on the GET.\n" +
  '  var m = /^#cap=([0-9a-f]{1,256})$/.exec(location.hash);\n' +
  '  if (!m) { fail("no capability present."); return; }\n' +
  "  var capability = m[1];\n" +
  '  fetch("/api/v1/session", {\n' +
  '    method: "POST",\n' +
  '    headers: { "Content-Type": "application/json" },\n' +
  '    credentials: "same-origin",\n' +
  "    body: JSON.stringify({ capability: capability })\n" +
  "  }).then(function (r) {\n" +
  "    capability = null; // drop the secret reference as soon as the exchange resolves\n" +
  "    if (r.ok) {\n" +
  "      // Clear the fragment so the capability is not retained in history or Referer.\n" +
  '      history.replaceState(null, "", location.pathname + location.search);\n' +
  '      setStatus("Choose a workspace, then your agent settings.", false);\n' +
  '      workForm.hidden = false; syncShellSummary(); loadRepositoryOptions();\n' +
  "    } else {\n" +
  '      fail("server rejected (" + r.status + ").");\n' +
  "    }\n" +
  '  }, function () { capability = null; fail("network error."); });\n' +
  '  repositoryConsentConfirm.addEventListener("click", function () { answerRepositoryConsent(true); });\n' +
  '  repositoryConsentDismiss.addEventListener("click", function () { answerRepositoryConsent(false); });\n' +
  '  currentRepository.addEventListener("click", function () { chooseRepository("current"); });\n' +
  '  browseRepository.addEventListener("click", function () { chooseRepository("browse"); });\n' +
  '  changeRepository.addEventListener("click", openWorkspacePicker);\n' +
  '  document.getElementById("workspace-chip").addEventListener("click", openWorkspacePicker);\n' +
  '  document.getElementById("close-repository-config").addEventListener("click", toggleRepositoryChooser);\n' +
  '  document.getElementById("close-route-config").addEventListener("click", function () { routeForm.hidden = true; [workBack, document.getElementById("model-chip"), document.getElementById("reasoning-chip")].forEach(function (button) { button.setAttribute("aria-expanded", "false"); }); setStatus(selectedRoute ? "Agent settings unchanged." : "Choose agent settings before embarking.", false); });\n' +
  '  historyButton.addEventListener("click", openHistory);\n' +
  '  document.getElementById("rail-manage-history").addEventListener("click", openHistory);\n' +
  '  document.getElementById("rail-new-journey").addEventListener("click", startNewJourney);\n' +
  '  document.getElementById("history-search").addEventListener("input", function () { renderRailHistory(historyEntries); });\n' +
  '  document.getElementById("collapse-rail").addEventListener("click", function () { var collapsed = appShell.classList.toggle("rail-collapsed"); this.setAttribute("aria-expanded", String(!collapsed)); this.textContent = collapsed ? "›" : "‹"; });\n' +
  '  document.getElementById("toggle-rail").addEventListener("click", function () { appShell.classList.toggle("rail-open"); });\n' +
  '  document.getElementById("rail-view-demo").addEventListener("click", openDemo);\n' +
  '  document.getElementById("rail-view-glossary").addEventListener("click", function () { glossaryDialog.showModal(); });\n' +
  '  document.getElementById("model-chip").addEventListener("click", openRouteChooser);\n' +
  '  document.getElementById("reasoning-chip").addEventListener("click", openRouteChooser);\n' +
  '  document.querySelectorAll("[data-starter]").forEach(function (button) { button.addEventListener("click", function () { document.getElementById("work-goal").value = button.dataset.starter || ""; document.getElementById("work-goal").focus(); }); });\n' +
  '  document.getElementById("clear-history").addEventListener("click", function () { if (confirm("Clear all journey history for this repository? Generated files will stay in the repository.")) deleteHistory(); });\n' +
  '  document.getElementById("close-history").addEventListener("click", closeHistory);\n' +
  '  document.getElementById("refresh-routes").addEventListener("click", loadRoutes);\n' +
  '  viewDemo.addEventListener("click", function () { if (demoPanel.hidden) openDemo(); else closeDemoPanel(); });\n' +
  '  document.getElementById("view-glossary").addEventListener("click", function () { glossaryDialog.showModal(); });\n' +
  '  document.getElementById("close-glossary").addEventListener("click", function () { glossaryDialog.close(); });\n' +
  '  glossaryDialog.addEventListener("click", function (event) { if (event.target === glossaryDialog) glossaryDialog.close(); });\n' +
  '  document.getElementById("close-demo").addEventListener("click", closeDemoPanel);\n' +
  '  document.getElementById("demo-explorer").addEventListener("click", function () { chooseDemoMode("explorer"); });\n' +
  '  document.getElementById("demo-expedition").addEventListener("click", function () { chooseDemoMode("expedition"); });\n' +
  '  document.getElementById("demo-prev").addEventListener("click", function () { showDemoStage(demoStage - 1); });\n' +
  '  document.getElementById("demo-next").addEventListener("click", function () { if (demoStage === 2 && !demoMode) { chooseDemoMode("explorer"); document.getElementById("demo-mode-status").textContent = "Explorer highlighted as the lower-token example. In a real run, you choose Explorer or Expedition."; document.getElementById("demo-next").textContent = "Continue \\u2192"; return; } if (demoStage === 3) { closeDemoPanel(); return; } showDemoStage(demoStage + 1); });\n' +
  '  document.getElementById("journey-next").addEventListener("click", function () { invokeJourney(currentStage === "set-bearings" ? "gather-supplies" : "map-route"); });\n' +
  '  document.getElementById("journey-action-back").addEventListener("click", function () { planningPanel.hidden = true; workForm.hidden = false; document.getElementById("work-goal").focus(); setStatus("Journey paused at the owner handoff.", false); });\n' +
  '  document.getElementById("review-back").addEventListener("click", function () { planReviewPanel.hidden = true; workForm.hidden = false; document.getElementById("work-goal").value = currentGoal; document.getElementById("work-goal").focus(); setStatus("Planning package saved. Update the request or return through History.", false); });\n' +
  '  document.getElementById("request-plan-changes").addEventListener("click", function () { var instruction = document.getElementById("review-change").value.trim(); if (!instruction) { document.getElementById("review-change").focus(); return; } recordPlanReview("Changes requested: " + instruction).then(function () { planReviewPanel.hidden = true; planningPanel.hidden = false; invokeJourney("gather-supplies", { reviewChange: instruction }); }, showError); });\n' +
  '  document.getElementById("approve-plan").addEventListener("click", function () { document.getElementById("approve-plan").disabled = true; recordPlanReview("Approved for execution-mode selection").then(function () { planReviewPanel.hidden = true; planningPanel.hidden = false; document.getElementById("mode-choice").hidden = false; document.getElementById("approve-plan").disabled = false; setStatus("Route approved. Choose Explorer or Expedition and the review cadence.", false); }, function (error) { document.getElementById("approve-plan").disabled = false; showError(error); }); });\n' +
  '  ["explorer", "expedition"].forEach(function (mode) { document.getElementById("journey-" + mode).addEventListener("click", function () { journeyMode = mode; ["explorer", "expedition"].forEach(function (name) { var card = document.getElementById("journey-" + name); var chosen = name === mode; card.classList.toggle("selected", chosen); card.setAttribute("aria-pressed", String(chosen)); }); document.getElementById("execute-journey").disabled = false; }); });\n' +
  '  document.getElementById("execute-journey").addEventListener("click", function () { if (!journeyMode) return; var cadence = document.querySelector("input[name=review-cadence]:checked").value; invokeJourney(journeyMode === "explorer" ? "execute-explorer" : "execute-expedition", { executionMode: journeyMode, reviewCadence: cadence, cleanupMergedWorktrees: document.getElementById("cleanup-worktrees").checked }); });\n' +
  '  document.getElementById("journey-back").addEventListener("click", function () { planningPanel.hidden = true; workForm.hidden = false; document.getElementById("work-goal").focus(); setStatus("Review or update your work request.", false); });\n' +
  '  document.getElementById("mode-back").addEventListener("click", function () { document.getElementById("mode-choice").hidden = true; planningPanel.hidden = true; planReviewPanel.hidden = false; setStatus("Review the approved planning package.", false); });\n' +
  '  document.getElementById("completion-back").addEventListener("click", function () { document.getElementById("journey-complete").hidden = true; document.getElementById("mode-choice").hidden = false; setStatus("Review the selected execution settings.", false); });\n' +
  '  document.getElementById("dismiss-recovery-report").addEventListener("click", function () { document.getElementById("recovery-report").hidden = true; });\n' +
  '  document.getElementById("journey-retry").addEventListener("click", function () { document.getElementById("journey-complete").firstElementChild.textContent = "Evidence complete"; var stage = retryStage || currentStage; retryStage = ""; focusAmendmentPending ? confirmFocusAmendment(stage) : invokeJourney(stage); });\n' +
  '  document.getElementById("new-journey").addEventListener("click", startNewJourney);\n' +
  '  workBack.addEventListener("click", openRouteChooser);\n' +
  '  document.getElementById("owner-name").addEventListener("input", function () { this.setCustomValidity(""); });\n' +
  '  routeForm.addEventListener("submit", function (ev) {\n' +
  "    ev.preventDefault();\n" +
  '    var ownerName = document.getElementById("owner-name"); var name = ownerName.value.trim(); if (!name) { ownerName.setCustomValidity("Tell us what to call you."); ownerName.reportValidity(); return; } ownerName.setCustomValidity(""); if (!routeForm.reportValidity() || !selectedRoute) return; setStatus("Launching Bearing with " + (selectedRoute.model === "*" ? "the agent default" : selectedRoute.model) + "...", true); fetch("/api/v1/readiness", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ provider: selectedRoute.provider, model: selectedRoute.model, reasoning: selectedRoute.reasoning }) }).then(function (r) { return r.json(); }).then(function (body) { setStatus(body.status === "detected" ? "Agent detected; provider verification required." : body.status === "blocked" ? "Agent route unavailable." : status.textContent, body.status === "detected"); if (body.status === "ready") finishReady(name, false); }, function () { setStatus("Launch check failed.", false); });\n' +
  "  });\n" +
  '  workForm.addEventListener("submit", function (ev) {\n' +
  '    ev.preventDefault(); if (!selectedRepositoryPath) { openWorkspacePicker(); return; } if (!onboardingReady || !selectedRoute) { openRouteChooser(); setStatus("Apply agent, model, and reasoning settings before embarking.", false); return; } if (!workForm.reportValidity()) return; currentGoal = document.getElementById("work-goal").value.trim(); if (!currentGoal) return; currentRunId = "browser-" + crypto.randomUUID(); setStatus("Saving the work request...", true); readRun(currentRunId).then(function (state) { return state.workRequestCreated ? state : postCommand(currentRunId, state, "createWorkRequest", { title: currentGoal.split(/\\r?\\n/, 1)[0].slice(0, 160), goal: currentGoal }).then(function () { return readRun(currentRunId); }); }).then(function () { closeSetupSheets(); workForm.hidden = true; planningPanel.hidden = false; invokeJourney("repository-fit"); }, showError);\n' +
  "  });\n" +
  '  planningAnswerForm.addEventListener("submit", function (ev) {\n' +
  '    ev.preventDefault(); if (!planningAnswerForm.reportValidity()) return; var answer = planningAnswer.value.trim(); if (!answer) return; var localNext = currentStage === "gather-supplies" && pendingQuestionCount > 0; planningSubmit.disabled = true; setStatus(localNext ? "Saving your answer..." : "Preparing the route map...", true); readRun(currentRunId).then(function (state) { if (!state.pendingDecision) throw new Error("No owner decision is pending."); return postCommand(currentRunId, state, "recordOwnerAnswer", { decisionId: state.pendingDecision.decisionId, answer: answer }); }).then(function () { invokeJourney(currentStage, { answer: answer }, localNext); }, function (error) { planningSubmit.disabled = false; showError(error); });\n' +
  "  });\n" +
  '  endQuestions.addEventListener("click", function () { var answer = "Skipped; owner ended questioning early. Use the answers collected so far and record reasonable assumptions."; planningSubmit.disabled = true; endQuestions.disabled = true; setStatus("Ending questions and preparing the route map...", true); readRun(currentRunId).then(function (state) { if (!state.pendingDecision) throw new Error("No owner decision is pending."); return postCommand(currentRunId, state, "recordOwnerAnswer", { decisionId: state.pendingDecision.decisionId, answer: answer }); }).then(function () { invokeJourney("gather-supplies", { answer: answer, endQuestions: true }); }, function (error) { planningSubmit.disabled = false; endQuestions.disabled = false; showError(error); }); });\n' +
  "})();\n" +
  "</script>\n" +
  "</body>\n" +
  "</html>\n";
const NATIVE_HTML = NATIVE_HTML_TEMPLATE
  .replace("Your selected agent is working. Bearing will show only validated results.", "Bearing is inspecting bounded repository evidence before asking you to confirm the first write.")
  .replace("shared model and reasoning", "per-slice model and reasoning assignments")
  .replace("Waiting for the agent\u2026", "Waiting for real activity\u2026")
  .replace("Last activity: phase started just now.", "Last real activity: waiting for the first event.")
  .replace('selectedRepositoryPath = result.body.repositoryPath || ""; syncShellSummary();', 'selectedRepositoryPath = result.body.repositoryPath || ""; currentRunId = ""; clearVerificationProjections(); syncShellSummary(); loadImprovementHandoff();');

export function writeRejection(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Rejected");
}

function writeJourneyFailure(res: ServerResponse, status: number, code: "input_invalid" | "fit_undecidable"): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify({ status: "failure", code, tokens: 0 }));
}

function isCapabilityBody(v: unknown): v is { capability: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1 || !("capability" in v)) return false;
  const cap = (v as { capability?: unknown }).capability;
  return typeof cap === "string" && cap.length > 0;
}

function isRepositoryPathBody(v: unknown): v is { path: string; confirmNonGit?: true } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as { path?: unknown; confirmNonGit?: unknown };
  const keys = Object.keys(body);
  return keys.length <= 2 && keys.every((key) => key === "path" || key === "confirmNonGit") &&
    typeof body.path === "string" && body.path.length > 0 && body.path.length <= 4096 &&
    (!("confirmNonGit" in body) || body.confirmNonGit === true);
}

function isRepositoryChoiceBody(v: unknown): v is { choice: "current" | "browse"; confirmNonGit?: true } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as { choice?: unknown; confirmNonGit?: unknown };
  const keys = Object.keys(body);
  return keys.length <= 2 && keys.every((key) => key === "choice" || key === "confirmNonGit") &&
    (body.choice === "current" || body.choice === "browse") &&
    (!("confirmNonGit" in body) || body.confirmNonGit === true);
}

function isOwnerNameBody(v: unknown): v is { name: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1 || !("name" in v)) return false;
  const name = (v as { name?: unknown }).name;
  return typeof name === "string" && name === name.trim() && name.length > 0 && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name);
}

function isSelectionBody(v: unknown): v is Selection {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as Record<string, unknown>;
  return Object.keys(body).length === 3 && ["provider", "model", "reasoning"].every((key) => key in body) &&
    typeof body.provider === "string" && body.provider.length > 0 && body.provider.length <= 256 &&
    typeof body.model === "string" && body.model.length > 0 && body.model.length <= 256 &&
    typeof body.reasoning === "string" && (REASONING_LEVELS as readonly string[]).includes(body.reasoning);
}

interface JourneyBody {
  readonly runId: string;
  readonly stage: JourneyStage;
  readonly workGoal?: string;
  readonly answer?: string;
  readonly endQuestions?: true;
  readonly reviewChange?: string;
  readonly executionMode?: "explorer" | "expedition";
  readonly reviewCadence?: "slice" | "phase" | "end";
  readonly cleanupMergedWorktrees?: boolean;
  readonly focusAmendmentConfirmed?: true;
  readonly focusAmendmentDecisionId?: string;
  readonly focusAmendmentExpectedRevision?: number;
}

interface JourneyControlBody { readonly runId: string; readonly action: "stop" | "steer"; readonly instruction?: string; }

function hasUnsafeTextControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isJourneyControlBody(v: unknown): v is JourneyControlBody {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as Record<string, unknown>, allowed = new Set(["runId", "action", "instruction"]);
  return Object.keys(body).every((key) => allowed.has(key)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(body.runId ?? "")) &&
    (body.action === "stop" || body.action === "steer") &&
    (body.action === "stop" ? body.instruction === undefined : typeof body.instruction === "string" && body.instruction === body.instruction.trim() && body.instruction.length > 0 && body.instruction.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(body.instruction));
}

function isJourneyBody(v: unknown): v is JourneyBody {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as Record<string, unknown>;
  const allowed = new Set(["runId", "stage", "workGoal", "answer", "endQuestions", "reviewChange", "executionMode", "reviewCadence", "cleanupMergedWorktrees", "focusAmendmentConfirmed", "focusAmendmentDecisionId", "focusAmendmentExpectedRevision"]);
  // ponytail: built from the ledger tuple. A hand-written literal types its
  // members but not its completeness, so a missing stage would be rejected here
  // and nowhere else.
  const stages = new Set<JourneyStage>(RECORD_JOURNEY_CHECKPOINT_STAGES);
  return Object.keys(body).every((key) => allowed.has(key)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(body.runId ?? "")) &&
    stages.has(body.stage as JourneyStage) &&
    (body.workGoal === undefined || (typeof body.workGoal === "string" && body.workGoal === body.workGoal.trim() && body.workGoal.length > 0 && body.workGoal.length <= 4096 && !hasUnsafeTextControl(body.workGoal))) &&
    (body.answer === undefined || (typeof body.answer === "string" && body.answer === body.answer.trim() && body.answer.length > 0 && body.answer.length <= 4096 && !hasUnsafeTextControl(body.answer))) &&
    (body.endQuestions === undefined || (body.endQuestions === true && body.stage === "gather-supplies" && typeof body.answer === "string")) &&
    (body.reviewChange === undefined || (body.stage === "gather-supplies" && typeof body.reviewChange === "string" && body.reviewChange === body.reviewChange.trim() && body.reviewChange.length > 0 && body.reviewChange.length <= 4096 && !hasUnsafeTextControl(body.reviewChange))) &&
    (body.executionMode === undefined || body.executionMode === "explorer" || body.executionMode === "expedition") &&
    (body.reviewCadence === undefined || body.reviewCadence === "slice" || body.reviewCadence === "phase" || body.reviewCadence === "end") &&
    (body.cleanupMergedWorktrees === undefined || ((body.stage === "execute-explorer" || body.stage === "execute-expedition") && typeof body.cleanupMergedWorktrees === "boolean")) &&
    ((body.focusAmendmentConfirmed === undefined && body.focusAmendmentDecisionId === undefined && body.focusAmendmentExpectedRevision === undefined) ||
      (body.focusAmendmentConfirmed === true && (body.stage === "execute-explorer" || body.stage === "execute-expedition") &&
        typeof body.focusAmendmentDecisionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.focusAmendmentDecisionId) &&
        Number.isSafeInteger(body.focusAmendmentExpectedRevision) && Number(body.focusAmendmentExpectedRevision) >= 0));
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUOTED_HEADER_VALUE = /^"(?:[\t !#-\[\]-~]|\\[\t !-~])*"$/;

export function hasJsonContentType(header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const parts = header.split(";");
  if (parts[0].trim().toLowerCase() !== "application/json") return false;
  for (const rawParam of parts.slice(1)) {
    const param = rawParam.trim();
    const eq = param.indexOf("=");
    if (param.length === 0 || eq <= 0) return false;
    const value = param.slice(eq + 1).trim();
    if (!HEADER_TOKEN.test(param.slice(0, eq).trim())) return false;
    if (!HEADER_TOKEN.test(value) && !QUOTED_HEADER_VALUE.test(value)) return false;
  }
  return true;
}

/** Read a deliberately small JSON request body after the caller checks headers. */
export function readJsonBody(req: IncomingMessage, limit = MAX_SESSION_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new RangeError("body too large"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new SyntaxError("invalid json")); }
    });
    req.on("error", () => { if (!done) { done = true; reject(new Error("request error")); } });
  });
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string") return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    const rawName = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
    if (rawName !== name) continue;
    if (found !== undefined) return undefined;
    found = eq === -1 ? "" : trimmed.slice(eq + 1);
  }
  return found;
}

function handleSessionPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
): void {
  // State-changing/session requests require a matching loopback Origin.
  if (!service.validOrigin(req.headers.origin)) {
    writeRejection(res, 403);
    return;
  }
  if (!hasJsonContentType(req.headers["content-type"])) {
    writeRejection(res, 415);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  req.on("data", (c: Buffer) => {
    if (settled) return;
    size += c.length;
    if (size > MAX_SESSION_BODY) {
      // ponytail: ceiling — we keep draining the remainder of an Origin-checked
      // loopback POST rather than req.destroy() (which races the 413 response).
      // Revisit with a hard socket close if this surface ever leaves loopback.
      settled = true;
      writeRejection(res, 413);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (settled) return;
    settled = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      writeRejection(res, 400);
      return;
    }
    if (!isCapabilityBody(parsed)) {
      writeRejection(res, 400);
      return;
    }
    if (service.authenticateRequest(req)) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
      return;
    }
    const result = service.exchange(parsed.capability);
    if (!result.ok) {
      // Wrong/missing/replayed capability: no capability is ever echoed back.
      writeRejection(res, 403);
      return;
    }
    // HttpOnly + SameSite=Strict + Path=/. No Secure: this is plain loopback HTTP.
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${result.cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
    );
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end("{}");
  });
  req.on("error", () => {
    if (!settled) {
      settled = true;
      writeRejection(res, 400);
    }
  });
}

/**
 * Repository-choice port used by the HTTP layer. `agentExecutableRealpaths` is
 * optional so narrower test doubles remain valid; when it is absent
 * `RepositoryBootstrap` falls back to its own built-in-route resolution.
 */
type RepositoryChoicePort =
  Pick<RepositoryChoiceService, "options" | "resolve">
  & Partial<Pick<RepositoryChoiceService, "agentExecutableRealpaths">>;

function handleRepositoryPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  repositoryBootstrap: RepositoryBootstrap,
  repositoryChoice: RepositoryChoicePort,
  selected: SelectedBrowserState,
): void {
  if (!service.validOrigin(req.headers.origin)) {
    writeRejection(res, 403);
    return;
  }
  if (!hasJsonContentType(req.headers["content-type"])) {
    writeRejection(res, 415);
    return;
  }
  if (!service.authenticateRequest(req)) {
    writeRejection(res, 401);
    return;
  }
  if ([...selected.journeys.values()].some((journey) => journey.busy)) {
    res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: "blocked",
      code: "journey_in_progress",
      remedy: "The active journey is still running. Return to it before changing repositories.",
    }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  req.on("data", (c: Buffer) => {
    if (settled) return;
    size += c.length;
    if (size > MAX_REPOSITORY_BODY) {
      settled = true;
      writeRejection(res, 413);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (settled) return;
    settled = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      writeRejection(res, 400);
      return;
    }
    const directPath = isRepositoryPathBody(parsed) ? parsed : undefined;
    const choice = isRepositoryChoiceBody(parsed) ? parsed : undefined;
    const body = directPath ?? choice;
    if (!directPath && !choice) {
      writeRejection(res, typeof parsed === "object" && parsed !== null && "choice" in parsed ? 422 : 400);
      return;
    }
    if (selected.repositorySelecting) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        status: "blocked",
        code: "repository_selection_in_progress",
        remedy: "Wait for the current repository selection to finish.",
      }));
      return;
    }
    selected.repositorySelecting = true;
    const candidate = directPath
      ? Promise.resolve<RepositoryChoiceResult>({ result: "selected", candidate: directPath.path, source: "picker" })
      : repositoryChoice.resolve(choice!.choice);
    candidate.then((resolved) => {
      if ("unavailable" in resolved) {
        selected.repositorySelecting = false;
        writeRepositoryFailure(res, repositoryFailureCode(resolved.unavailable));
        return;
      }
      if (resolved.result !== "selected") {
        selected.repositorySelecting = false;
        writeRepositoryFailure(res, repositoryFailureCode(`repository_picker_${resolved.result}`));
        return;
      }
      const agentExecutableRealpaths = repositoryChoice.agentExecutableRealpaths?.();
      return repositoryBootstrap.choose(resolved.candidate, {
        ownerConfirmedNonGit: body!.confirmNonGit === true,
        ...(agentExecutableRealpaths ? { agentExecutableRealpaths } : {}),
      }).then((result) => {
        selected.repositorySelecting = false;
        if (!result.ok) {
          // Returning the resolved candidate lets the browser confirm by path,
          // so a browse confirmation never reopens the system folder picker.
          writeRepositoryFailure(res, {
            ...repositoryFailureCode(result.reason),
            ...(result.reason === "repository_not_git" ? { candidate: resolved.candidate } : {}),
          });
          return;
        }
        selected.store = new BearingStore(result.repositoryPath);
        selected.repositoryPath = result.repositoryPath;
        selected.selection = null;
        selected.run = null;
        selected.journeys.clear();
        selected.sse = new SseProjection(selected.store, service);
        selected.gateway = new CommandGateway(selected.store, service, selected.sse);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          status: result.status,
          repositoryPath: result.repositoryPath,
          ...(result.status === "initialized" ? {
            disclosure: `Bearing writes durable planning state to ${result.repositoryPath}/.bearing/ (gitignored).`,
            gitignoreMissing: result.gitignoreMissing,
          } : {}),
          ...(result.ownerName ? { ownerName: result.ownerName, greeting: greetingFor(result.ownerName) } : {}),
        }));
      });
    }).catch(() => {
      selected.repositorySelecting = false;
      writeRepositoryFailure(res, {
        status: 500,
        code: "internal_error",
        remedy: "Unexpected error. Try again.",
      }, "error");
    });
  });
  req.on("error", () => {
    if (!settled) {
      settled = true;
      writeRejection(res, 400);
    }
  });
}

function handleOwnerPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  repositoryBootstrap: RepositoryBootstrap,
  repositoryPath: string | null,
  repositorySelecting: boolean,
): void {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!hasJsonContentType(req.headers["content-type"])) { writeRejection(res, 415); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!repositoryPath || repositorySelecting) { writeRejection(res, 409); return; }
  readJsonBody(req, MAX_OWNER_BODY).then(async (body) => {
    if (!isOwnerNameBody(body)) { writeRejection(res, 400); return; }
    const name = await repositoryBootstrap.rememberOwnerName(repositoryPath, body.name);
    if (!name) { writeRejection(res, 500); return; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify({ name, greeting: greetingFor(name) }));
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

function repositoryFailureStatus(reason: string): number {
  if (reason === "initialize_failed") return 500;
  if (reason === "repository_not_git" || reason === "repository_contains_agent") return 422;
  if (reason === "launch_cwd_unavailable") return 409;
  if (
    reason === "path_not_absolute" ||
    reason === "repository_unavailable" ||
    reason === "repository_not_directory" ||
    reason === "repository_not_writable"
  ) {
    return 400;
  }
  return 409;
}

function repositoryFailureCode(reason: string): { status: number; code: string; remedy: string } {
  const remedies: Readonly<Record<string, string>> = {
    path_not_absolute: "Choose a repository using an absolute path.",
    repository_unavailable: "The repository is unavailable. Choose an accessible directory.",
    repository_not_directory: "Choose a directory, not a file.",
    repository_not_writable: "Choose a repository that Bearing can write to.",
    repository_not_git: "Not a Git repo — confirm to use for planning, or pick a repo.",
    repository_contains_agent: "Pick a project repo, not a dir containing your agent tools (e.g. home).",
    launch_cwd_unavailable: "Launch directory is unavailable. Browse for a repository.",
    bearing_symlink: "Remove the .bearing symlink or choose another repository.",
    bearing_not_directory: "Remove the non-directory .bearing path or choose another repository.",
    manifest_missing: "Repair or remove the incomplete .bearing workspace, then try again.",
    manifest_malformed: "Repair or remove the invalid .bearing workspace, then try again.",
    manifest_future_schema: "Upgrade Bearing before opening this newer workspace.",
    manifest_repository_mismatch: "Choose the repository recorded by this .bearing workspace.",
    interrupted_initialization: "Remove the interrupted .bearing temporary directory, then try again.",
    initialize_failed: "Bearing could not initialize planning state. Check repository permissions and try again.",
    repository_picker_cancelled: "Browse cancelled. Current repository is still available.",
    repository_picker_unavailable: "System picker unavailable. Use the current repository.",
    repository_picker_timeout: "System picker timed out. Try again or use current.",
    repository_picker_invalid: "Picker returned an invalid repository. Nothing changed.",
  };
  return {
    status: repositoryFailureStatus(reason),
    code: reason,
    remedy: remedies[reason] ?? "Repository selection is blocked. Resolve the repository state and try again.",
  };
}

function writeRepositoryFailure(
  res: ServerResponse,
  failure: { status: number; code: string; remedy: string; candidate?: string },
  responseStatus: "blocked" | "error" = "blocked",
): void {
  res.writeHead(failure.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify({
    status: responseStatus,
    code: failure.code,
    remedy: failure.remedy,
    ...(failure.candidate === undefined ? {} : { candidate: failure.candidate }),
  }));
}

export interface RequestHandlerOptions {
  readonly startupOverrides?: RunOverrides;
  readonly routeInspection?: RouteInspectionPort;
  readonly verification?: VerificationPort;
  readonly processRunner?: ProcessRunner;
  readonly repositoryChoice?: RepositoryChoicePort;
  readonly improvementReport?: (input: {
    readonly repositoryPath: string;
    readonly store: BearingStore;
  }) => Promise<ImprovementServiceResult<unknown, unknown, unknown>>;
  readonly beforeJourneyExecutionCheckpoint?: (input: {
    readonly runId: string;
    readonly expectedRevision: number;
  }) => Promise<void>;
}

function handleRepositoryOptions(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  repositoryChoice: RepositoryChoicePort,
): void {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  repositoryChoice.options().then((options) => {
    if ("unavailable" in options) {
      writeRepositoryFailure(res, repositoryFailureCode(options.unavailable));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(options));
  }, () => writeRepositoryFailure(res, {
    status: 500,
    code: "internal_error",
    remedy: "Unexpected error. Try again.",
  }, "error"));
}

async function handleRepositoryGitignorePost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  selected: SelectedBrowserState,
): Promise<void> {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!hasJsonContentType(req.headers["content-type"])) { writeRejection(res, 415); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  let consent: unknown;
  try {
    consent = await readJsonBody(req, MAX_OWNER_BODY);
  } catch (error) {
    writeRejection(res, error instanceof RangeError ? 413 : 400);
    return;
  }
  if (typeof consent !== "object" || consent === null || Array.isArray(consent) || Object.keys(consent).length !== 0) {
    writeRejection(res, 400);
    return;
  }
  const repositoryPath = selected.repositoryPath;
  if (!repositoryPath || selected.repositorySelecting) {
    writeRepositoryFailure(res, {
      status: 409,
      code: "repository_not_selected",
      remedy: "Choose a repository before updating its .gitignore.",
    });
    return;
  }
  if (await realpath(repositoryPath).catch(() => undefined) !== repositoryPath) {
    writeRepositoryFailure(res, repositoryFailureCode("repository_unavailable"));
    return;
  }
  const gitMarker = await lstat(resolve(repositoryPath, ".git")).catch(() => undefined);
  if (!gitMarker || (!gitMarker.isDirectory() && !gitMarker.isFile())) {
    writeRepositoryFailure(res, repositoryFailureCode("repository_not_git"));
    return;
  }

  const gitignorePath = resolve(repositoryPath, ".gitignore");
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(gitignorePath, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    const [opened, linked] = await Promise.all([file.stat(), lstat(gitignorePath)]);
    if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      writeRepositoryFailure(res, {
        status: 409,
        code: "gitignore_unavailable",
        remedy: "Use an existing regular .gitignore file in the selected repository.",
      });
      return;
    }
    const body = await file.readFile("utf8");
    if (!ignoresBearingDirectory(body)) {
      await file.write(`${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}.bearing/\n`);
      await file.sync();
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({ status: "ok", gitignored: true }));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    writeRepositoryFailure(res, {
      status: missing ? 409 : 500,
      code: missing ? "gitignore_missing" : "internal_error",
      remedy: missing
        ? "Create a .gitignore in the selected Git repository, then try again."
        : "Unexpected error. Try again.",
    }, missing ? "blocked" : "error");
  } finally {
    await file?.close();
  }
}

function handleRouteModelsGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, readiness: ReadinessService, repositoryPath: string | null, repositorySelecting: boolean, routeId: string): void {
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!repositoryPath || repositorySelecting) { writeRejection(res, 409); return; }
  const models = readiness.discover(routeId, repositoryPath);
  if (!models) { writeRejection(res, 404); return; }
  const provider = BUILTIN_ROUTES.find((route) => route.id === routeId)!.provider;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify({ models: models.map((model) => ({ ...model, defaultReasoning: normalizeReasoningTier(model.defaultReasoning, provider) ?? "medium" })) }));
}

function handleReadinessPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  readiness: ReadinessService,
  repositoryPath: string | null,
  repositorySelecting: boolean,
  remember: (selection: Selection, run: ResolvedRun) => void,
): void {
  if (!service.validOrigin(req.headers.origin)) {
    writeRejection(res, 403);
    return;
  }
  if (!hasJsonContentType(req.headers["content-type"])) {
    writeRejection(res, 415);
    return;
  }
  if (!service.authenticateRequest(req)) {
    writeRejection(res, 401);
    return;
  }
  if (!repositoryPath || repositorySelecting) {
    writeRejection(res, 409);
    return;
  }
  readJsonBody(req, MAX_READINESS_BODY).then(async (body) => {
    if (!isSelectionBody(body)) {
      if (typeof body === "object" && body !== null && !Array.isArray(body) &&
          ["provider", "model", "reasoning"].some((key) => !(key in body))) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" }));
        return;
      }
      writeRejection(res, 400);
      return;
    }
    const result = await readiness.check(body, repositoryPath);
    if (result.status === "ready") remember(result.run.roles[0].selection, result.run);
    res.writeHead(result.status === "blocked" ? 409 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

interface BrowserJourney {
  goal: string;
  updatedAt: string;
  stage: JourneyStage;
  status: "running" | "waiting" | "stopped" | "failed" | "complete";
  question?: string;
  questionDecisionId?: string;
  questionStage?: JourneyStage;
  planDirectory?: string;
  repositoryFitDecision?: FitDecision;
  resolvedPlanDirectory?: string;
  reviewBaselineRevision?: number;
  lastResult?: CheckpointJourneyResult;
  control?: { action: "stop" | "steer"; instruction?: string };
  busy: boolean;
  readonly qa: { question: string; answer: string }[];
  readonly artifacts: string[];
  pendingQuestions: string[];
  gatherQuestionsDiscovered: boolean;
  retryLedger: RetryLedgerEntry[];
  activityTrail: JourneyActivity[];
  concurrency?: RuntimeConcurrencyDecision;
  sessionContinuity: "intact" | "lost";
  retryRefusal?: RetryRefusal;
  escalationTarget?: EscalationTarget;
  pendingRetryWarrant?: RetryWarrant;
  providerSessionId?: string;
  readonly selection?: Selection;
}

type CheckpointDiagnostic = {
  readonly code: "checkpoint_planning_transition_refused";
  readonly reason: "illegal_transition";
  readonly remedy: "The checkpoint was saved without changing durable planning state; continue from the authoritative journey result.";
};
type CheckpointJourneyResult = JourneyResult & { readonly checkpointDiagnostic?: CheckpointDiagnostic };

type ConfirmedFitDecision = Exclude<FitDecision, { readonly outcome: "declined" }>;
type ConfirmedFit = {
  readonly decision: ConfirmedFitDecision;
  readonly resolvedPlanDirectory: string;
};
type BoundConsolidationPlan = ConsolidationPlan & { readonly sourceContentHash: string };

function validatedFit(
  decision: FitDecision | undefined,
  resolvedPlanDirectory: string | undefined,
): ConfirmedFit | undefined {
  if (
    !decision
    || decision.outcome === "declined"
    || resolvedPlanDirectory === undefined
    || decision.planDirectory !== resolvedPlanDirectory
    || !planDirectoryValid(resolvedPlanDirectory)
  ) return undefined;
  return { decision, resolvedPlanDirectory };
}

function confirmedFit(state: BrowserJourney, repositoryPath: string): ConfirmedFit | undefined {
  const fit = validatedFit(state.repositoryFitDecision, state.resolvedPlanDirectory);
  return fit?.decision.repository === repositoryPath ? fit : undefined;
}

type FitAnswer =
  | ConfirmedFit
  | { readonly declined: true }
  | { readonly question: string }
  | { readonly consolidation: BoundConsolidationPlan }
  | { readonly failure: "input_invalid" | "fit_undecidable" };

async function bindConsolidationSources(repository: string, plan: ConsolidationPlan): Promise<BoundConsolidationPlan> {
  const hash = createHash("sha256");
  for (const path of [...new Set(plan.entries.map((entry) => entry.source))].sort()) {
    const candidate = resolve(repository, path);
    const lexical = relative(repository, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) throw new Error("plan_directory_invalid");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      const linked = await lstat(candidate);
      const canonical = await realpath(candidate);
      const relation = relative(repository, canonical);
      if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || !relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("plan_directory_invalid");
      const content = await handle.readFile();
      hash.update(`${path}\0${content.length}\0`).update(content);
    } finally {
      await handle?.close();
    }
  }
  return { ...plan, sourceContentHash: hash.digest("hex") };
}

async function duplicateConsolidation(repository: string, canonical: string): Promise<BoundConsolidationPlan | undefined> {
  const duplicate = await resolvePlanDirectory(repository, basename(canonical));
  if (duplicate.ok || duplicate.reason !== "plan_directory_ambiguous" || !duplicate.matches.includes(canonical)) return undefined;
  const sources = duplicate.matches.filter((path) => path !== canonical);
  return sources.length ? bindConsolidationSources(repository, await planConsolidation(repository, canonical, sources)) : undefined;
}

function consolidationQuestion(plan: ConsolidationPlan): string {
  const copies = plan.entries.filter(({ action }) => action === "copy").length;
  const conflicts = plan.entries.filter(({ action }) => action === "conflict").length;
  return plan.ok
    ? `Review the consolidation plan for ${plan.canonical}: ${copies} file(s) copied, sources retained. Answer "${CONSOLIDATION_APPROVAL}" to apply it.`
    : `Consolidation conflict for ${plan.canonical}: ${conflicts} file(s) differ. Resolve the typed conflicts before approving; nothing was copied.`;
}

function resultConsolidation(result: JourneyResult | undefined): BoundConsolidationPlan | undefined {
  if (result?.status !== "question") return undefined;
  const value = (result as JourneyResult & { readonly consolidation?: unknown }).consolidation;
  if (typeof value !== "object" || value === null || !("ok" in value) || !("canonical" in value) || !("sources" in value) || !("entries" in value)) return undefined;
  const plan = value as Partial<BoundConsolidationPlan>;
  return typeof plan.ok === "boolean"
    && typeof plan.canonical === "string"
    && planDirectoryValid(plan.canonical)
    && Array.isArray(plan.sources)
    && plan.sources.every((path) => typeof path === "string" && planDirectoryValid(path))
    && Array.isArray(plan.entries)
    && typeof plan.sourceContentHash === "string"
    && /^[a-f0-9]{64}$/.test(plan.sourceContentHash)
    ? value as BoundConsolidationPlan
    : undefined;
}

async function fitAnswer(
  repositoryPath: string,
  assumption: FitAssumption,
  answer: string,
): Promise<FitAnswer> {
  if (assumption.repository !== repositoryPath) return { failure: "fit_undecidable" };
  const normalized = answer.toLowerCase().replace(/[.!]+$/g, "");
  if (["no", "decline", "declined", "stop", "cancel"].includes(normalized)) return { declined: true };
  const confirmed = answer === assumption.planDirectory
    || ["y", "yes", "confirm", "confirmed", "approve", "approved", "proceed", "use it", "looks good"].includes(normalized);
  let resolved;
  try { resolved = await resolvePlanDirectory(repositoryPath, confirmed ? assumption.planDirectory : answer); }
  catch { return { failure: "input_invalid" }; }
  if (resolved.ok) {
    const consolidation = await duplicateConsolidation(repositoryPath, resolved.path);
    if (consolidation) return { consolidation };
    const decision: ConfirmedFitDecision = {
      outcome: confirmed && resolved.path === assumption.planDirectory ? "confirmed" : "redirected",
      planDirectory: resolved.path,
      repository: repositoryPath,
      decidedAt: new Date().toISOString(),
    };
    return { decision, resolvedPlanDirectory: resolved.path };
  }
  if (resolved.reason === "plan_directory_ambiguous") {
    return { question: `More than one plan directory matches. Enter one exact path: ${resolved.matches.join(", ")}` };
  }
  if (resolved.reason === "plan_directory_absent") {
    return { question: `No exact plan directory matches "${resolved.requested}". Enter a full path under docs/plans/.` };
  }
  return { failure: "input_invalid" };
}

type FailureResult = Extract<JourneyResult, { readonly status: "failure" }>;
type RecoveryReport = {
  readonly status: "repaired" | "stopped";
  readonly stage: JourneyStage;
  readonly failureClass: "agent_receipt_or_artifact_validation";
  readonly code: FailureResult["code"];
  readonly retryLevel: "repair" | "simplify";
  readonly version: "0.1.6";
  readonly fitDiagnostic?: FitDiagnostic;
};

function recoverableFailure(result: JourneyResult): result is FailureResult {
  return result.status === "failure" && ["result_missing", "result_malformed", "artifact_invalid", "focus_invalid", "completion_invalid", "fit_malformed"].includes(result.code);
}

function recoveryFitDiagnostic(result: FailureResult): { readonly fitDiagnostic?: FitDiagnostic } {
  return result.code === "fit_malformed" && isFitDiagnostic(result.fitDiagnostic)
    ? { fitDiagnostic: result.fitDiagnostic }
    : {};
}

function retryRequiresWarrant(result: FailureResult): boolean {
  return result.code !== "cancelled" && result.code !== "interrupted";
}

function retryErrorSignature(code: FailureResult["code"]): FocusCompletionErrorSignature {
  if (code === "result_missing" || code === "artifact_invalid") return "artifact_missing";
  if (code === "focus_invalid" || code === "focus_amendment_required") return "git_state";
  return "evidence_invalid";
}

async function browserFailureFingerprint(
  repositoryPath: string,
  stage: JourneyStage,
  result: FailureResult,
  state: BrowserJourney,
): Promise<string> {
  const changes = await gitChanges(repositoryPath);
  return failureFingerprint({
    stage,
    failureCode: result.code,
    errorSignature: retryErrorSignature(result.code),
    relevantState: {
      planDirectory: state.planDirectory ?? null,
      artifacts: [...state.artifacts].sort(),
      ownerAnswerCount: state.qa.length,
      gatherQuestionsDiscovered: state.gatherQuestionsDiscovered,
      ...(result.code === "focus_amendment_required" ? { focusDrift: result.focusDrift } : {}),
    },
    changedPaths: changes?.map(({ path }) => path) ?? [],
  });
}

function retryScope(stage: JourneyStage, code: FailureResult["code"]): EscalationScope {
  if (code === "focus_amendment_required") return "contract-change";
  if (stage === "review") return "cross-phase";
  if (stage === "map-route" || stage === "recon" || stage === "draft-implementation") return "cross-slice";
  return "within-slice";
}

function escalationTargetFor(stage: JourneyStage, result: JourneyResult | undefined): EscalationTarget {
  if (result?.status === "failure" && result.code === "focus_amendment_required") return "owner";
  if (stage === "review") return "navigator";
  if (stage === "map-route" || stage === "recon" || stage === "draft-implementation") return "trail-boss";
  return "explorer";
}

function retryReasoningTier(state: BrowserJourney): RetryLedgerEntry["reasoningTier"] {
  return state.selection
    ? normalizeReasoningTier(state.selection.reasoning, state.selection.provider) ?? "medium"
    : "medium";
}

function recordRetryDecision(
  state: BrowserJourney,
  fingerprint: string,
  scope: EscalationScope,
  warrant?: RetryWarrant,
): RetryDecision {
  const decision = admitRetry(state.retryLedger, {
    fingerprint,
    reasoningTier: retryReasoningTier(state),
    scope,
    ...(warrant ? { warrant } : {}),
  });
  state.retryLedger = [...decision.ledger.slice(-MAX_RUNTIME_STATE_ARRAY)];
  state.retryRefusal = decision.ok ? undefined : decision.reason;
  state.escalationTarget = decision.ok ? decision.escalation : undefined;
  return decision;
}

function clearRetryDecision(state: BrowserJourney): void {
  state.retryRefusal = undefined;
  state.escalationTarget = undefined;
}

function recordedResultForStage(
  durable: Awaited<ReturnType<BearingStore["load"]>>,
  stage: JourneyStage,
): JourneyResult | undefined {
  const checkpoint = [...durable.events].reverse().find(
    (event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === stage,
  );
  return parseCheckpointJson<JourneyResult | undefined>(checkpoint?.payload.lastResultJson, undefined);
}

function failedResultForStage(
  durable: Awaited<ReturnType<BearingStore["load"]>>,
  stage: JourneyStage,
  current: BrowserJourney,
): FailureResult | undefined {
  const durableResult = recordedResultForStage(durable, stage);
  if (durableResult?.status === "failure") return durableResult;
  return current.stage === stage && current.lastResult?.status === "failure"
    ? current.lastResult
    : undefined;
}

function recoveryGuidance(level: RecoveryReport["retryLevel"], code: FailureResult["code"]): string {
  return level === "repair"
    ? `Bearing detected the recoverable ${code} validation failure. Inspect the current stage output, repair only the receipt or required artifacts, and do not repeat completed changes.`
    : `The focused repair still produced ${code}. Use the simplest contract-preserving correction: reuse current files and existing primitives, remove unnecessary complexity, and return only the required validated result.`;
}

function journeyConcurrency(
  run: ResolvedRun,
  stage: JourneyStage,
  previousStage: JourneyStage,
  previous: RuntimeConcurrencyDecision | undefined,
  lastResult: JourneyResult | undefined,
): RuntimeConcurrencyDecision {
  const executor = run.roles.find((role) => role.role === "crewmate" && role.executor);
  const ceiling = executor?.limits.maxConcurrency ?? 1;
  const expedition = stage === "execute-expedition";
  const decision = admissibleConcurrency({
    ceiling,
    ownerCap: expedition ? ceiling : 1,
    independenceCap: expedition ? ceiling : 1,
    signals: lastResult?.status === "failure" && lastResult.code === "completion_invalid"
      ? ["repeated_integration_failure"]
      : [],
    phaseId: stage,
    scope: expedition ? "cross-phase" : "within-phase",
    ...(previous && previousStage === stage
      ? { prior: { phaseId: stage, cap: previous.cap, ...(previous.reducedBy ? { reducedBy: previous.reducedBy } : {}) } }
      : {}),
  });
  return { admittedLanes: [stage], ...decision };
}

function journeyDisclosures(state: BrowserJourney, result: JourneyResult | undefined = state.lastResult) {
  return {
    retryHistoryLength: state.retryLedger.length,
    ...(state.retryRefusal ? { retryRefusal: state.retryRefusal } : {}),
    ...(state.escalationTarget ? { escalationTarget: state.escalationTarget } : {}),
    ...(state.sessionContinuity === "lost"
      ? { continuityLost: true as const, continuityDisclosure: CONTINUITY_LOST_DISCLOSURE }
      : {}),
    ...(result?.status === "failure" && result.code === "focus_amendment_required"
      ? { amendmentPrompt: FOCUS_AMENDMENT_PROMPT }
      : {}),
  };
}

function sameSelection(left: Selection | undefined, right: Selection): boolean {
  return left !== undefined && left.provider === right.provider && left.model === right.model && left.reasoning === right.reasoning;
}

function appendJourneyQa(state: BrowserJourney, question: string, answer: string): void {
  state.qa.push({ question, answer });
  while (state.qa.length > 1 && Buffer.byteLength(JSON.stringify(state.qa)) > MAX_QA_JSON_BYTES) state.qa.shift();
}

function ensureJourneyCapacity(journeys: Map<string, BrowserJourney>): boolean {
  if (journeys.size < MAX_JOURNEYS) return true;
  for (const [runId, state] of journeys) {
    if (!state.busy) journeys.delete(runId);
    if (journeys.size < MAX_JOURNEYS) return true;
  }
  return false;
}

function planningApprovalRecorded(state: Awaited<ReturnType<BearingStore["load"]>>, afterRevision: number): boolean {
  const reviewDecisions = new Set<string>();
  for (const event of state.events) {
    if (event.sequence <= afterRevision) continue;
    if (event.type === "decisionRequired" && event.payload.question === PLAN_REVIEW_QUESTION && typeof event.payload.decisionId === "string") reviewDecisions.add(event.payload.decisionId);
    if (event.type === "ownerAnswered" && typeof event.payload.decisionId === "string" && reviewDecisions.has(event.payload.decisionId) && event.payload.answer === PLAN_REVIEW_APPROVAL) return true;
  }
  return false;
}

function focusAmendmentApprovalRecorded(
  state: Awaited<ReturnType<BearingStore["load"]>>,
  decisionId: string,
): boolean {
  let required = false;
  for (const event of state.events) {
    if (event.type === "decisionRequired"
      && event.actor === "owner"
      && event.payload.decisionId === decisionId
      && event.payload.question === FOCUS_AMENDMENT_PROMPT
      && event.payload.consequential === true) required = true;
    if (required
      && event.type === "ownerAnswered"
      && event.actor === "owner"
      && event.payload.decisionId === decisionId
      && event.payload.answer === FOCUS_AMENDMENT_APPROVAL) return true;
  }
  return false;
}

function reviewedPlanningValidation(
  state: Awaited<ReturnType<BearingStore["load"]>>,
  afterRevision: number,
): PlanningValidationRecord | undefined {
  for (const event of [...state.events].reverse()) {
    if (event.sequence <= afterRevision || event.type !== "journeyCheckpointRecorded" || (event.payload.stage !== "map-route" && event.payload.stage !== "draft-implementation") || typeof event.payload.lastResultJson !== "string") continue;
    try {
      const result = JSON.parse(event.payload.lastResultJson) as { planningValidation?: unknown };
      if (planningValidationSignal(result.planningValidation)) return result.planningValidation as PlanningValidationRecord;
    } catch { /* malformed checkpoint evidence is not approval evidence */ }
  }
  return undefined;
}

async function reviewedPlanningPackageCurrent(
  state: BrowserJourney,
  durable: Awaited<ReturnType<BearingStore["load"]>>,
  repositoryPath: string,
  focusAmendmentConfirmed = false,
  presentedContentHash?: string,
): Promise<boolean> {
  if (state.reviewBaselineRevision === undefined || !state.planDirectory) return false;
  const reviewed = reviewedPlanningValidation(durable, state.reviewBaselineRevision);
  if (
    !reviewed
    || planningValidationSignal(reviewed) !== "planningValidated"
    || (presentedContentHash !== undefined && reviewed.checkedContentHash !== presentedContentHash)
  ) return false;
  const current = await currentPlanningVerdict(repositoryPath, state.planDirectory);
  return current?.verdict === "PASS"
    && (current.checkedContentHash === reviewed.checkedContentHash || focusAmendmentConfirmed);
}

async function planningReviewBoundaryReached(
  state: BrowserJourney,
  durable: Awaited<ReturnType<BearingStore["load"]>>,
  repositoryPath: string,
): Promise<boolean> {
  if (
    state.stage !== "draft-implementation"
    || state.lastResult?.status !== "action"
    || !state.lastResult.planningReview
    || planningValidationSignal(state.lastResult.planningValidation) !== "planningValidated"
  ) return false;
  return reviewedPlanningPackageCurrent(
    state,
    durable,
    repositoryPath,
    false,
    state.lastResult.planningValidation?.checkedContentHash,
  );
}

async function planReviewAvailable(
  state: BrowserJourney,
  durable: Awaited<ReturnType<BearingStore["load"]>>,
  repositoryPath: string,
): Promise<boolean> {
  return state.reviewBaselineRevision !== undefined
    && !planningApprovalRecorded(durable, state.reviewBaselineRevision)
    && await planningReviewBoundaryReached(state, durable, repositoryPath);
}

async function executionTransitionAllowed(
  state: BrowserJourney,
  durable: Awaited<ReturnType<BearingStore["load"]>>,
  repositoryPath: string,
  stage: "execute-explorer" | "execute-expedition",
  executionMode?: "explorer" | "expedition",
  reviewCadence?: "slice" | "phase" | "end",
  focusAmendmentConfirmed?: boolean,
): Promise<boolean> {
  const expectedMode = stage === "execute-explorer" ? "explorer" : "expedition";
  const recordedMode = lastQaAnswer(state.qa, "Execution mode");
  const recordedCadence = lastQaAnswer(state.qa, "Review cadence");
  const mode = executionMode ?? recordedMode, cadence = reviewCadence ?? recordedCadence;
  if ((state.stage !== "map-route" && state.stage !== "draft-implementation" && state.stage !== stage) || state.reviewBaselineRevision === undefined || mode !== expectedMode || !["slice", "phase", "end"].includes(cadence ?? "")) return false;
  if (!planningApprovalRecorded(durable, state.reviewBaselineRevision)) return false;
  return reviewedPlanningPackageCurrent(state, durable, repositoryPath, focusAmendmentConfirmed === true);
}

function reviewTransitionAllowed(durable: Awaited<ReturnType<BearingStore["load"]>>): boolean {
  const checkpoint = durable.journeyCheckpoint;
  if (!checkpoint) return false;
  if (checkpoint.stage === "review") return true;
  if (checkpoint.stage !== "execute-explorer" && checkpoint.stage !== "execute-expedition") return false;
  return parseCheckpointJson<JourneyResult | undefined>(checkpoint.lastResultJson, undefined)?.status === "action";
}

function ownerAnswerRecorded(
  state: Awaited<ReturnType<BearingStore["load"]>>,
  decisionId: string | undefined,
  answer: string,
): boolean {
  return decisionId !== undefined && state.events.some(
    (event) => event.type === "ownerAnswered"
      && event.payload.decisionId === decisionId
      && event.payload.answer === answer,
  );
}

function lastQaAnswer(entries: readonly { question: string; answer: string }[], question: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].question === question) return entries[index].answer;
  return undefined;
}

function planningFailureReason(stage: JourneyStage, code: FailureResult["code"]): string | undefined {
  if (code !== "artifact_invalid") return undefined;
  return stage === "gather-supplies"
    ? "REQUIREMENTS_GAP"
    : stage === "map-route"
      ? "DESIGN_CONFLICT"
      : stage === "recon"
        ? "RECON_FAILED"
      : stage === "draft-implementation"
        ? "MISSING_VALIDATION"
        : undefined;
}

const PLANNING_SIGNAL_BY_STAGE = {
  "repository-fit": undefined,
  "set-bearings": undefined,
  "gather-supplies": "requirementsReady",
  "map-route": "architectureReady",
  recon: "reconReady",
  "draft-implementation": "executionPlanReady",
  "execute-explorer": undefined,
  "execute-expedition": undefined,
  review: undefined,
} as const satisfies Readonly<Record<JourneyStage, PlanningSignal | undefined>>;

function planningSignalForStage(stage: JourneyStage): PlanningSignal | undefined {
  return PLANNING_SIGNAL_BY_STAGE[stage];
}

function journeyStageRank(stage: JourneyStage): number {
  const index = RECORD_JOURNEY_CHECKPOINT_STAGES.indexOf(stage);
  const expedition = RECORD_JOURNEY_CHECKPOINT_STAGES.indexOf("execute-expedition");
  return index >= expedition ? index - 1 : index;
}

function isForwardJourneyStage(previous: JourneyStage, nextStage: JourneyStage): boolean {
  return journeyStageRank(nextStage) > journeyStageRank(previous);
}

function journeyStageTransitionAllowed(previous: JourneyStage, nextStage: JourneyStage): boolean {
  return journeyStageRank(nextStage) <= journeyStageRank(previous) + 1;
}

function reconPlanningFailure(
  result: JourneyResult | undefined,
): "RECON_FAILED" | "OWNER_DECISION_REQUIRED" | undefined {
  return result?.status === "action"
    && (result.recon?.state === "OWNER_DECISION_REQUIRED" || result.recon?.state === "RECON_FAILED")
    ? result.recon.state
    : undefined;
}

function reconSuccessfullyCompleted(result: JourneyResult | undefined): boolean {
  return result?.status === "action" && result.recon?.state === "RECON_READY";
}

function planningStateForJourneyGate(
  durable: Awaited<ReturnType<BearingStore["load"]>>,
): {
  readonly planningState: ReturnType<typeof derivePlanningState>;
  readonly activeReconFailure: "RECON_FAILED" | "OWNER_DECISION_REQUIRED" | undefined;
} {
  let activeReconFailure: "RECON_FAILED" | "OWNER_DECISION_REQUIRED" | undefined;
  for (const event of durable.events) {
    if (event.type !== "journeyCheckpointRecorded" || event.payload.stage !== "recon") continue;
    const result = parseCheckpointJson<JourneyResult | undefined>(event.payload.lastResultJson, undefined);
    const failure = reconPlanningFailure(result);
    if (failure) activeReconFailure = failure;
    else if (reconSuccessfullyCompleted(result)) activeReconFailure = undefined;
  }
  return {
    planningState: activeReconFailure ?? derivePlanningState(durable.events),
    activeReconFailure,
  };
}

function retainedPlanningFailure(state: ReturnType<typeof derivePlanningState>) {
  switch (state) {
    case "REQUIREMENTS_GAP":
    case "DESIGN_CONFLICT":
    case "RECON_FAILED":
    case "MISSING_VALIDATION":
    case "UNSAFE_PARALLELISM":
    case "OWNER_DECISION_REQUIRED":
      return { planningFailure: state };
    default:
      return {};
  }
}

async function completedRequirementRefs(
  repositoryPath: string | undefined,
  runId: string,
  state: BrowserJourney,
  durable: Awaited<ReturnType<BearingStore["load"]>>,
): Promise<readonly string[] | undefined> {
  if (
    repositoryPath === undefined
    || (state.stage !== "execute-explorer" && state.stage !== "execute-expedition")
    || state.lastResult?.status !== "action"
    || state.lastResult.verification?.verdict !== "PASS"
    || state.planDirectory === undefined
  ) return undefined;
  const source = await executionContractSource(repositoryPath, state.planDirectory);
  if (!source.available) return undefined;
  const parsed = parseApprovedExecutionContract(source.value);
  if (!parsed.ok || parsed.value.runId !== runId || parsed.value.planDirectory !== state.planDirectory) return undefined;
  // Owner approval is an owner-authored ownerAnswered event. A bearing-authored
  // checkpoint carrying the hash is the agent vouching for its own approval.
  if (!executionContractApprovalRecorded(durable.events, parsed.value.ownerApproval.recordId, parsed.value.contentHash)) return undefined;
  const refs = [...new Set(parsed.value.slices.flatMap((slice) => slice.requirementIds))];
  return isRequirementRefs(refs) ? refs : undefined;
}

class JourneyCheckpointRevisionConflict extends Error {}

async function persistJourneyCheckpoint(
  store: BearingStore,
  runId: string,
  state: BrowserJourney,
  journey?: JourneyService,
  repositoryPath?: string,
  expectedRevision?: number,
): Promise<CheckpointDiagnostic | undefined> {
  const durable = await store.load(runId);
  if (expectedRevision !== undefined && durable.revision !== expectedRevision) throw new JourneyCheckpointRevisionConflict();
  const id = `checkpoint-${randomToken(12)}`;
  const trace = journey?.activityTrail(runId) ?? state.activityTrail;
  const runtimeStateJson = serializeRuntimeState({
    version: 1,
    trace,
    retry: state.retryLedger,
    ...(state.concurrency ? { concurrency: state.concurrency } : {}),
    sessionContinuity: state.sessionContinuity,
  } satisfies RuntimeStateRecord);
  const runtimeState = parseRuntimeState(runtimeStateJson);
  if (!runtimeState.ok) throw new Error(`runtime state rejected: ${runtimeState.reason}`);
  state.activityTrail = [...runtimeState.value.trace];
  const transitionStatus = state.status !== "running" && state.lastResult?.status === "action" ? "complete" : state.status;
  const failureReason = state.status === "failed" && state.lastResult?.status === "failure"
    ? planningFailureReason(state.lastResult.failureStage ?? state.stage, state.lastResult.code)
    : undefined;
  const previousPlanningState = derivePlanningState(durable.events);
  const projected = planningCheckpointFields({
    stage: state.stage,
    status: transitionStatus,
    previousState: previousPlanningState,
    ...(state.lastResult?.status === "action" && state.lastResult.planningValidation
      ? { planningValidation: state.lastResult.planningValidation }
      : {}),
    ...(state.lastResult?.status === "action" && state.lastResult.recon
      ? { recon: { ...("brief" in state.lastResult.recon ? { brief: state.lastResult.recon.brief } : {}), ...("report" in state.lastResult.recon ? { report: state.lastResult.recon.report } : {}) } }
      : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(state.lastResult?.status === "failure" && state.lastResult.failureStage ? { failureStage: state.lastResult.failureStage } : {}),
  });
  const checkpointDiagnostic: CheckpointDiagnostic | undefined = "refused" in projected
    ? {
        code: "checkpoint_planning_transition_refused",
        reason: projected.refused,
        remedy: "The checkpoint was saved without changing durable planning state; continue from the authoritative journey result.",
      }
    : undefined;
  const planningFields = "refused" in projected
    ? retainedPlanningFailure(previousPlanningState)
    : projected.planningFailure
      ? { planningFailure: projected.planningFailure }
      : projected.planningState
        ? { planningState: projected.planningState }
        : {};
  const checkpointResult = state.lastResult && checkpointDiagnostic
    ? { ...state.lastResult, checkpointDiagnostic }
    : state.lastResult;
  const requirementRefs = await completedRequirementRefs(repositoryPath, runId, state, durable);
  const payload = {
    stage: state.stage,
    status: state.status,
    artifacts: [...state.artifacts],
    ...(state.planDirectory ? { planDirectory: state.planDirectory } : {}),
    ...(state.repositoryFitDecision ? { repositoryFitDecision: state.repositoryFitDecision } : {}),
    ...(state.resolvedPlanDirectory ? { resolvedPlanDirectory: state.resolvedPlanDirectory } : {}),
    ...(state.question ? { question: state.question } : {}),
    ...(state.questionDecisionId ? { questionDecisionId: state.questionDecisionId } : {}),
    ...(state.reviewBaselineRevision === undefined ? {} : { reviewBaselineRevision: state.reviewBaselineRevision }),
    ...(checkpointResult ? { lastResultJson: JSON.stringify(checkpointResult) } : {}),
    qaJson: JSON.stringify(state.qa),
    gatherQuestionsDiscovered: state.gatherQuestionsDiscovered,
    ...(state.selection ? { selectionProvider: state.selection.provider, selectionModel: state.selection.model, selectionReasoning: state.selection.reasoning } : {}),
    ...(state.providerSessionId ? { providerSessionId: state.providerSessionId } : {}),
    runtimeStateJson,
    ...(state.lastResult?.status === "action" && state.lastResult.verification !== undefined
      ? { verification: { layer: "validator", verdict: state.lastResult.verification.verdict, findingCount: state.lastResult.verification.reasons.length } satisfies VerificationCheckpointPayload }
      : {}),
    ...(requirementRefs === undefined ? {} : { requirementRefs }),
    ...planningFields,
  };
  const command = { schemaVersion: 1, commandId: id, runId, expectedRevision: expectedRevision ?? durable.revision, session: { sessionId: "local-runtime", actor: "bearing" }, correlationId: id, type: "recordJourneyCheckpoint", payload } as CommandEnvelopeV1;
  const recorded = await store.apply(command);
  if (!recorded.ok) {
    if (expectedRevision !== undefined && recorded.reason === "stale_revision") throw new JourneyCheckpointRevisionConflict();
    throw new Error(`checkpoint rejected: ${recorded.reason}`);
  }
  return checkpointDiagnostic;
}

function parseCheckpointJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}

function restoreJourney(entry: { goal: string; updatedAt: string; pendingQuestion?: string; checkpointAnswer?: string; checkpoint?: Awaited<ReturnType<BearingStore["load"]>>["journeyCheckpoint"] }): BrowserJourney | undefined {
  const checkpoint = entry.checkpoint;
  if (!checkpoint) return undefined;
  const interrupted = checkpoint.status === "running";
  const questionPending = checkpoint.question !== undefined && entry.pendingQuestion === checkpoint.question;
  const answeredQuestion = !questionPending && checkpoint.question !== undefined && entry.checkpointAnswer !== undefined;
  const staleQuestion = checkpoint.question !== undefined && !questionPending;
  const qa = parseCheckpointJson<{ question: string; answer: string }[]>(checkpoint.qaJson, []);
  if (answeredQuestion && !qa.some((item) => item.question === checkpoint.question && item.answer === entry.checkpointAnswer)) qa.push({ question: checkpoint.question!, answer: entry.checkpointAnswer! });
  while (qa.length > 1 && Buffer.byteLength(JSON.stringify(qa)) > MAX_QA_JSON_BYTES) qa.shift();
  const savedLastResult = parseCheckpointJson<JourneyResult | undefined>(checkpoint.lastResultJson, undefined);
  const lastResult = interrupted || staleQuestion ? { status: "failure", code: "interrupted", tokens: 0 } as const : savedLastResult;
  const pendingQuestions = questionPending && lastResult?.status === "question" && Array.isArray(lastResult.questions) && lastResult.questions[0] === checkpoint.question ? [...lastResult.questions.slice(1)] : [];
  const selectionReasoning = checkpoint.selectionReasoning && checkpoint.selectionProvider
    ? normalizeReasoningTier(checkpoint.selectionReasoning, checkpoint.selectionProvider)
    : undefined;
  const fit = validatedFit(checkpoint.repositoryFitDecision, checkpoint.resolvedPlanDirectory);
  const parsedRuntime = typeof checkpoint.runtimeStateJson === "string"
    ? parseRuntimeState(checkpoint.runtimeStateJson)
    : undefined;
  const runtimeState = parsedRuntime?.ok ? parsedRuntime.value : undefined;
  const retryOutcome = runtimeState?.retry.at(-1)?.outcome;
  const retryRefusal = retryOutcome === "retry_requires_warrant"
    || retryOutcome === "same_attempt_higher_reasoning"
    || retryOutcome === "retry_limit_reached"
    ? retryOutcome
    : undefined;
  const restored: BrowserJourney = {
    goal: entry.goal,
    updatedAt: entry.updatedAt,
    stage: checkpoint.stage,
    status: interrupted || staleQuestion ? "failed" : checkpoint.status,
    ...(questionPending ? { question: checkpoint.question, questionStage: checkpoint.stage } : {}),
    ...(questionPending && checkpoint.questionDecisionId ? { questionDecisionId: checkpoint.questionDecisionId } : {}),
    ...(checkpoint.planDirectory ? { planDirectory: checkpoint.planDirectory } : {}),
    ...(fit ? { repositoryFitDecision: fit.decision, resolvedPlanDirectory: fit.resolvedPlanDirectory } : {}),
    ...(checkpoint.reviewBaselineRevision === undefined ? {} : { reviewBaselineRevision: checkpoint.reviewBaselineRevision }),
    lastResult,
    busy: false,
    qa,
    artifacts: [...checkpoint.artifacts],
    pendingQuestions,
    gatherQuestionsDiscovered: checkpoint.gatherQuestionsDiscovered === true && !(checkpoint.stage === "gather-supplies" && staleQuestion),
    retryLedger: runtimeState ? [...runtimeState.retry] : [],
    activityTrail: runtimeState ? [...runtimeState.trace] : [],
    ...(runtimeState?.concurrency ? { concurrency: runtimeState.concurrency } : {}),
    sessionContinuity: runtimeState?.sessionContinuity
      ?? (savedLastResult?.sessionContinuity === "lost" ? "lost" : "intact"),
    ...(retryRefusal ? { retryRefusal } : {}),
    ...(retryOutcome === "escalation_required" ? { escalationTarget: escalationTargetFor(checkpoint.stage, lastResult) } : {}),
    ...(answeredQuestion
      ? { pendingRetryWarrant: "new_evidence" as const }
      : lastResult?.status === "failure"
        && lastResult.code === "interrupted"
        && qa.at(-1)?.question.startsWith("Owner steering during ")
        ? { pendingRetryWarrant: "changed_strategy" as const }
        : {}),
    ...(checkpoint.selectionProvider && checkpoint.selectionModel && selectionReasoning ? { selection: { provider: checkpoint.selectionProvider, model: checkpoint.selectionModel, reasoning: selectionReasoning } } : {}),
    ...(checkpoint.providerSessionId ? { providerSessionId: checkpoint.providerSessionId } : {}),
  };
  return restored;
}

type SelectedBrowserState = {
  store: BearingStore | null;
  gateway: CommandGateway | null;
  sse: SseProjection | null;
  repositoryPath: string | null;
  repositorySelecting: boolean;
  selection: Selection | null;
  run: ResolvedRun | null;
  readonly journeys: Map<string, BrowserJourney>;
  busyLeaseQueue: Promise<void>;
  busyLeaseHeartbeat?: ReturnType<typeof setInterval>;
};

const BUSY_LEASE_REFRESH_MS = 10_000;

function syncBusyLease(selected: SelectedBrowserState): Promise<void> {
  const update = selected.busyLeaseQueue.then(async () => {
    if (!selected.repositoryPath) return;
    const runIds = [...selected.journeys]
      .filter(([, journey]) => journey.busy)
      .map(([runId]) => runId);
    await writeWorkspaceBusyLease(selected.repositoryPath, runIds);
    if (runIds.length > 0 && selected.busyLeaseHeartbeat === undefined) {
      selected.busyLeaseHeartbeat = setInterval(() => {
        void syncBusyLease(selected).catch(() => {
          // The current lease remains fail-closed until its bounded expiry;
          // the next 10-second refresh retries the atomic publication.
        });
      }, BUSY_LEASE_REFRESH_MS);
      selected.busyLeaseHeartbeat.unref();
    } else if (runIds.length === 0 && selected.busyLeaseHeartbeat !== undefined) {
      clearInterval(selected.busyLeaseHeartbeat);
      selected.busyLeaseHeartbeat = undefined;
    }
  });
  selected.busyLeaseQueue = update.catch(() => {});
  return update;
}

function handleJourneyPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  selected: SelectedBrowserState,
  journey: JourneyService | undefined,
  beforeExecutionCheckpoint?: RequestHandlerOptions["beforeJourneyExecutionCheckpoint"],
): void {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!hasJsonContentType(req.headers["content-type"])) { writeRejection(res, 415); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!journey || !selected.repositoryPath || !selected.selection || !selected.run || selected.repositorySelecting) { writeRejection(res, 409); return; }
  const repositoryPath = selected.repositoryPath, selection = selected.selection, run = selected.run;
  readJsonBody(req, MAX_JOURNEY_BODY).then(async (value) => {
    if (!isJourneyBody(value)) { writeRejection(res, 400); return; }
    let state = selected.journeys.get(value.runId);
    const stateWasCreated = state === undefined;
    if (!state) {
      if (!value.workGoal || !ensureJourneyCapacity(selected.journeys)) { writeRejection(res, 409); return; }
      state = {
        goal: value.workGoal,
        updatedAt: new Date().toISOString(),
        stage: value.stage,
        status: "waiting",
        qa: [],
        artifacts: [],
        pendingQuestions: [],
        gatherQuestionsDiscovered: false,
        retryLedger: [],
        activityTrail: [],
        sessionContinuity: "intact",
        busy: false,
        selection,
      };
      selected.journeys.set(value.runId, state);
    } else if (value.workGoal && value.workGoal !== state.goal) { writeRejection(res, 409); return; }
    if (!sameSelection(state.selection, selection)) { writeRejection(res, 409); return; }
    if (state.busy) { writeRejection(res, 409); return; }
    if (!selected.store) { writeRejection(res, 409); return; }
    let durable;
    try { durable = await selected.store.load(value.runId); }
    catch { writeRejection(res, 503); return; }
    if (!durable.workRequestCreated) { writeRejection(res, 409); return; }
    // A creating POST seeds `stage` from the request before any gate has run. If that request is then
    // rejected the entry survives, so an identical repeat sees stageChanged === false, reads as a
    // same-stage retry rather than forward progress, and skips the failed-planning-state gate entirely.
    // Anchor a newly created entry to durable truth so a rejection cannot poison the next attempt.
    if (stateWasCreated) state.stage = durable.journeyCheckpoint?.stage ?? state.stage;
    const fitCheckpoint = [...durable.events].reverse().find(
      (event) => event.type === "journeyCheckpointRecorded" && event.payload.repositoryFitDecision !== undefined,
    );
    const fitResolvedPlanDirectory = fitCheckpoint?.payload.resolvedPlanDirectory;
    const durableFit = validatedFit(
      fitCheckpoint?.payload.repositoryFitDecision as FitDecision | undefined,
      typeof fitResolvedPlanDirectory === "string" ? fitResolvedPlanDirectory : undefined,
    );
    if (durableFit) {
      state.repositoryFitDecision = durableFit.decision;
      state.resolvedPlanDirectory = durableFit.resolvedPlanDirectory;
      state.planDirectory = durableFit.resolvedPlanDirectory;
    }
    const legacyCheckpoint = fitCheckpoint === undefined
      ? [...durable.events].reverse().find(
        (event) => event.type === "journeyCheckpointRecorded"
          && typeof event.payload.planDirectory === "string"
          && planDirectoryValid(event.payload.planDirectory),
      )
      : undefined;
    const legacyValue = legacyCheckpoint?.payload.planDirectory;
    const legacyPlanDirectory = typeof legacyValue === "string" ? legacyValue : undefined;
    const fit = confirmedFit(state, repositoryPath);
    if (value.stage !== "repository-fit" && value.stage !== "review") {
      if (!fit && !legacyPlanDirectory) { writeJourneyFailure(res, 409, "input_invalid"); return; }
      state.resolvedPlanDirectory = fit?.resolvedPlanDirectory ?? legacyPlanDirectory;
      state.planDirectory = state.resolvedPlanDirectory;
    }
    if ((value.stage === "execute-explorer" || value.stage === "execute-expedition")
      && !await executionTransitionAllowed(state, durable, repositoryPath, value.stage, value.executionMode, value.reviewCadence, value.focusAmendmentConfirmed)) { writeRejection(res, 409); return; }
    if (value.stage === "review" && !reviewTransitionAllowed(durable)) { writeRejection(res, 409); return; }
    const previousStage = stateWasCreated
      ? durable.journeyCheckpoint?.stage ?? state.stage
      : state.stage;
    if (!journeyStageTransitionAllowed(previousStage, value.stage)) { writeRejection(res, 409); return; }
    const previousResult = state.lastResult;
    const stageChanged = previousStage !== value.stage;
    const planningGateState = planningStateForJourneyGate(durable);
    const durablePlanningState = planningGateState.planningState;
    const durablePlanningFailure = retainedPlanningFailure(durablePlanningState);
    const planningSignal = planningSignalForStage(value.stage);
    const movingForward = isForwardJourneyStage(previousStage, value.stage);
    // A live Recon stop blocks every forward move, not only the stages that sit after `recon`:
    // the run is stopped, and `movingForward` already exempts a repeat `recon` and any backward
    // remediation. The two arms compose rather than shadow each other — gating the derived-failure
    // arm on there being no active Recon failure made it inert exactly when a stop was live, which
    // let gather-supplies -> map-route through.
    const reconStopBlocks = planningGateState.activeReconFailure !== undefined;
    if (
      movingForward
      && (
        reconStopBlocks
        || (
          "planningFailure" in durablePlanningFailure
          && (
            planningSignal === undefined
            || next(durablePlanningState, planningSignal) === "illegal_transition"
          )
        )
      )
    ) {
      writeRejection(res, 409);
      return;
    }
    if (value.focusAmendmentConfirmed && (
      stageChanged
      || previousResult?.status !== "failure"
      || previousResult.code !== "focus_amendment_required"
      || durable.revision !== value.focusAmendmentExpectedRevision
      || durable.pendingDecision !== null
      || !focusAmendmentApprovalRecorded(durable, value.focusAmendmentDecisionId!)
    )) {
      writeRejection(res, 409);
      return;
    }
    const amendmentRollback = value.focusAmendmentConfirmed ? {
      stage: state.stage,
      status: state.status,
      lastResult: state.lastResult,
      qa: [...state.qa],
      retryLedger: [...state.retryLedger],
      concurrency: state.concurrency,
      pendingRetryWarrant: state.pendingRetryWarrant,
      retryRefusal: state.retryRefusal,
      escalationTarget: state.escalationTarget,
    } : undefined;
    if (stageChanged) clearRetryDecision(state);
    const retryFailure = failedResultForStage(durable, value.stage, state);
    if (
      retryFailure
      && (retryRequiresWarrant(retryFailure) || !stageChanged && state.pendingRetryWarrant !== undefined)
    ) {
      const fingerprint = await browserFailureFingerprint(repositoryPath, value.stage, retryFailure, state);
      const decision = recordRetryDecision(
        state,
        fingerprint,
        retryScope(value.stage, retryFailure.code),
        value.focusAmendmentConfirmed ? "approved_amendment" : state.pendingRetryWarrant,
      );
      if (decision.ok && !decision.escalation) state.pendingRetryWarrant = undefined;
      if (!decision.ok || decision.escalation) {
        state.stage = value.stage;
        state.lastResult = retryFailure;
        state.status = "failed";
        state.updatedAt = new Date().toISOString();
        try { await persistJourneyCheckpoint(selected.store, value.runId, state, journey); }
        catch { writeRejection(res, 503); return; }
        const links = state.artifacts.flatMap((path, index) => /\.(?:html|md)$/i.test(path) ? [{ path, url: `/api/v1/journey/${encodeURIComponent(value.runId)}/artifacts/${index}` }] : []);
        const recovery = {
          status: "stopped",
          stage: value.stage,
          failureClass: "agent_receipt_or_artifact_validation",
          code: retryFailure.code,
          retryLevel: "simplify",
          version: "0.1.6",
          ...recoveryFitDiagnostic(retryFailure),
        } satisfies RecoveryReport;
        writeShowcaseJson(res, {
          ...retryFailure,
          artifacts: state.artifacts,
          artifactLinks: links,
          recovery,
          ...journeyDisclosures(state, retryFailure),
        });
        return;
      }
    }
    if (value.answer) {
      if (!state.question || state.questionStage !== value.stage) { writeRejection(res, 409); return; }
      const pendingResult = state.lastResult;
      const pendingConsolidation = resultConsolidation(pendingResult);
      const fitAssumption = pendingResult?.status === "question" ? pendingResult.fitAssumption : undefined;
      if (pendingConsolidation && value.answer === CONSOLIDATION_APPROVAL) {
        if (!fitAssumption || !ownerAnswerRecorded(durable, state.questionDecisionId, value.answer)) { writeRejection(res, 409); return; }
        let current: BoundConsolidationPlan;
        try { current = await bindConsolidationSources(repositoryPath, await planConsolidation(repositoryPath, pendingConsolidation.canonical, pendingConsolidation.sources)); }
        catch { writeJourneyFailure(res, 422, "input_invalid"); return; }
        if (!current.ok || JSON.stringify(current) !== JSON.stringify(pendingConsolidation)) {
          const result: JourneyResult & { readonly consolidation: BoundConsolidationPlan } = {
            status: "question",
            question: consolidationQuestion(current),
            fitAssumption,
            consolidation: current,
            tokens: 0,
          };
          appendJourneyQa(state, state.question, value.answer);
          state.question = result.question;
          state.questionStage = "repository-fit";
          state.questionDecisionId = `journey-${randomToken(12)}`;
          state.lastResult = result;
          state.status = "waiting";
          try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
          catch { writeRejection(res, 503); return; }
          writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: [] });
          return;
        }
        let consolidation;
        try { consolidation = await applyConsolidation(repositoryPath, current); }
        catch { writeJourneyFailure(res, 422, "input_invalid"); return; }
        if (!consolidation.ok) {
          writeShowcaseJson(res, { status: "question", question: consolidationQuestion(current), consolidation: current, artifacts: state.artifacts, artifactLinks: [], tokens: 0 });
          return;
        }
        appendJourneyQa(state, state.question, value.answer);
        state.question = undefined;
        state.questionStage = undefined;
        state.questionDecisionId = undefined;
        const decision: ConfirmedFitDecision = {
          outcome: current.canonical === fitAssumption.planDirectory ? "confirmed" : "redirected",
          planDirectory: current.canonical,
          repository: repositoryPath,
          decidedAt: new Date().toISOString(),
        };
        state.repositoryFitDecision = decision;
        state.resolvedPlanDirectory = current.canonical;
        state.planDirectory = current.canonical;
        const result: JourneyResult & { readonly consolidation: typeof consolidation } = {
          status: "action",
          summary: `Repository fit confirmed for ${current.canonical}; consolidation copied ${consolidation.copied.length} file(s) and retained every source.`,
          artifacts: [],
          consolidation,
          tokens: 0,
        };
        state.lastResult = result;
        state.status = "waiting";
        try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
        catch { writeRejection(res, 503); return; }
        writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: [] });
        return;
      }
      appendJourneyQa(state, state.question, value.answer);
      state.question = undefined;
      state.questionStage = undefined;
      state.questionDecisionId = undefined;
      if (value.stage === "repository-fit") {
        const assumption = state.lastResult?.status === "question"
          ? state.lastResult.fitAssumption
          : undefined;
        if (!assumption) { writeJourneyFailure(res, 409, "input_invalid"); return; }
        const resolution = await fitAnswer(repositoryPath, assumption, value.answer);
        state.stage = "repository-fit";
        state.updatedAt = new Date().toISOString();
        state.busy = false;
        if ("question" in resolution) {
          const result: JourneyResult = {
            status: "question",
            question: resolution.question,
            fitAssumption: assumption,
            tokens: 0,
          };
          state.question = resolution.question;
          state.questionStage = "repository-fit";
          state.questionDecisionId = `journey-${randomToken(12)}`;
          state.lastResult = result;
          state.status = "waiting";
          try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
          catch { writeRejection(res, 503); return; }
          writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: [] });
          return;
        }
        if ("consolidation" in resolution) {
          const result: JourneyResult & { readonly consolidation: BoundConsolidationPlan } = {
            status: "question",
            question: consolidationQuestion(resolution.consolidation),
            fitAssumption: assumption,
            consolidation: resolution.consolidation,
            tokens: 0,
          };
          state.question = result.question;
          state.questionStage = "repository-fit";
          state.questionDecisionId = `journey-${randomToken(12)}`;
          state.lastResult = result;
          state.status = "waiting";
          try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
          catch { writeRejection(res, 503); return; }
          writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: [] });
          return;
        }
        if ("failure" in resolution) {
          state.lastResult = { status: "failure", code: resolution.failure, tokens: 0 };
          state.status = "failed";
          try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
          catch { writeRejection(res, 503); return; }
          writeJourneyFailure(res, 422, resolution.failure);
          return;
        }
        if ("declined" in resolution) {
          state.repositoryFitDecision = { outcome: "declined" };
          state.resolvedPlanDirectory = undefined;
          state.planDirectory = undefined;
          state.lastResult = { status: "failure", code: "fit_undecidable", tokens: 0 };
          state.status = "stopped";
          try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
          catch { writeRejection(res, 503); return; }
          writeJourneyFailure(res, 409, "fit_undecidable");
          return;
        }
        state.repositoryFitDecision = resolution.decision;
        state.resolvedPlanDirectory = resolution.resolvedPlanDirectory;
        state.planDirectory = resolution.resolvedPlanDirectory;
        const result: JourneyResult = {
          status: "action",
          summary: `Repository fit confirmed for ${resolution.resolvedPlanDirectory}.`,
          artifacts: [],
          tokens: 0,
        };
        state.lastResult = result;
        state.status = "waiting";
        try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
        catch { writeRejection(res, 503); return; }
        writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: [] });
        return;
      }
      if (value.endQuestions) state.pendingQuestions = [];
      if (value.stage === "gather-supplies" && state.pendingQuestions.length) {
        const question = state.pendingQuestions.shift()!;
        const tokens = state.lastResult?.status === "question" ? state.lastResult.tokens : 0;
        const nextStageEstimate = state.lastResult?.status === "question" ? state.lastResult.nextStageEstimate : undefined;
        const result: JourneyResult = { status: "question", question, questions: [question, ...state.pendingQuestions], tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
        state.question = question;
        state.questionStage = value.stage;
        state.questionDecisionId = `journey-${randomToken(12)}`;
        state.lastResult = result;
        state.updatedAt = new Date().toISOString();
        state.status = "waiting";
        try { await persistJourneyCheckpoint(selected.store, value.runId, state); }
        catch { writeRejection(res, 503); return; }
        writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: state.artifacts.flatMap((path, index) => /\.(?:html|md)$/i.test(path) ? [{ path, url: `/api/v1/journey/${encodeURIComponent(value.runId)}/artifacts/${index}` }] : []) });
        return;
      }
    }
    if (value.reviewChange) {
      if (!state.planDirectory || state.question || (state.stage !== "map-route" && state.stage !== "draft-implementation")) { writeRejection(res, 409); return; }
      appendJourneyQa(state, "Requested changes during planning-package review", value.reviewChange);
    }
    if (value.executionMode) appendJourneyQa(state, "Execution mode", value.executionMode);
    if (value.reviewCadence) appendJourneyQa(state, "Review cadence", value.reviewCadence);
    if (value.cleanupMergedWorktrees !== undefined) appendJourneyQa(state, "Cleanup merged worktrees", value.cleanupMergedWorktrees ? "on" : "off");
    state.concurrency = journeyConcurrency(run, value.stage, previousStage, state.concurrency, previousResult);
    state.lastResult = undefined;
    state.stage = value.stage;
    state.status = "running";
    state.busy = true;
    try {
      await syncBusyLease(selected);
      if (value.focusAmendmentConfirmed) await beforeExecutionCheckpoint?.({ runId: value.runId, expectedRevision: value.focusAmendmentExpectedRevision! });
      await persistJourneyCheckpoint(selected.store, value.runId, state, undefined, undefined, value.focusAmendmentExpectedRevision);
    } catch (error) {
      state.busy = false;
      if (error instanceof JourneyCheckpointRevisionConflict && amendmentRollback) {
        state.stage = amendmentRollback.stage;
        state.status = amendmentRollback.status;
        state.lastResult = amendmentRollback.lastResult;
        state.qa.splice(0, state.qa.length, ...amendmentRollback.qa);
        state.retryLedger = amendmentRollback.retryLedger;
        if (amendmentRollback.concurrency) state.concurrency = amendmentRollback.concurrency;
        else delete state.concurrency;
        if (amendmentRollback.pendingRetryWarrant) state.pendingRetryWarrant = amendmentRollback.pendingRetryWarrant;
        else delete state.pendingRetryWarrant;
        if (amendmentRollback.retryRefusal) state.retryRefusal = amendmentRollback.retryRefusal;
        else delete state.retryRefusal;
        if (amendmentRollback.escalationTarget) state.escalationTarget = amendmentRollback.escalationTarget;
        else delete state.escalationTarget;
      } else state.status = "failed";
      await syncBusyLease(selected).catch(() => {});
      writeRejection(res, error instanceof JourneyCheckpointRevisionConflict ? 409 : 503);
      return;
    }
    let result: JourneyResult;
    let gatherMode = value.stage === "gather-supplies" ? value.answer || value.reviewChange || state.gatherQuestionsDiscovered ? "apply" as const : "questions" as const : undefined;
    const execute = (reviewPrompt?: string, gateFailureFingerprint?: string) => journey.execute({
      selection,
      run,
      repositoryPath,
      runId: value.runId,
      workGoal: state!.goal,
      stage: value.stage,
      priorOwnerQa: state!.qa,
      ...(value.stage === "set-bearings"
        ? { requestedPlanDirectory: state!.resolvedPlanDirectory }
        : state!.planDirectory
          ? { planDirectory: state!.planDirectory }
          : {}),
      ...(gatherMode ? { gatherMode } : {}),
      ...(reviewPrompt ? { reviewPrompt } : {}),
      ...(gateFailureFingerprint ? { gateFailureFingerprint } : {}),
      ...(value.focusAmendmentConfirmed ? { focusAmendmentConfirmed: true } : {}),
      ...(state!.providerSessionId ? { providerSessionId: state!.providerSessionId } : {}),
    });
    let recoveryReport: RecoveryReport | undefined;
    try {
      result = await execute();
      const control = state.control;
      state.control = undefined;
      if (control?.action === "steer" && control.instruction) {
        appendJourneyQa(state, `Owner steering during ${value.stage}`, control.instruction);
        state.pendingRetryWarrant = "changed_strategy";
        if (result.status === "failure" && result.code === "cancelled") {
          const fingerprint = await browserFailureFingerprint(repositoryPath, value.stage, result, state);
          const decision = recordRetryDecision(state, fingerprint, retryScope(value.stage, result.code), "changed_strategy");
          if (decision.ok && !decision.escalation) {
            state.pendingRetryWarrant = undefined;
            result = await execute(undefined, fingerprint);
          }
        }
      }
      if (value.stage === "gather-supplies" && gatherMode === "questions" && result.status === "question" && Array.isArray(result.questions) && result.questions.length === 0) {
        state.gatherQuestionsDiscovered = true;
        gatherMode = "apply";
        result = await execute();
      }
      const automaticWarrants: readonly { warrant: RetryWarrant; level: RecoveryReport["retryLevel"] }[] = [
        { warrant: "new_hypothesis", level: "repair" },
        { warrant: "changed_strategy", level: "simplify" },
      ];
      let automaticRetries = 0;
      let firstFailure: FailureResult | undefined;
      let lastRetryLevel: RecoveryReport["retryLevel"] = "repair";
      while (recoverableFailure(result) && automaticRetries < automaticWarrants.length) {
        firstFailure ??= result;
        const retry = automaticWarrants[automaticRetries]!;
        const fingerprint = await browserFailureFingerprint(repositoryPath, value.stage, result, state);
        const decision = recordRetryDecision(state, fingerprint, retryScope(value.stage, result.code), retry.warrant);
        lastRetryLevel = retry.level;
        automaticRetries += 1;
        if (!decision.ok || decision.escalation) break;
        result = await execute(recoveryGuidance(lastRetryLevel, result.code), fingerprint);
      }
      if (result.status !== "failure" && firstFailure) {
        recoveryReport = { status: "repaired", stage: value.stage, failureClass: "agent_receipt_or_artifact_validation", code: firstFailure.code, retryLevel: lastRetryLevel, version: "0.1.6", ...recoveryFitDiagnostic(firstFailure) };
        clearRetryDecision(state);
      } else if (recoverableFailure(result) && firstFailure) {
        recoveryReport = { status: "stopped", stage: value.stage, failureClass: "agent_receipt_or_artifact_validation", code: result.code, retryLevel: "simplify", version: "0.1.6", ...recoveryFitDiagnostic(result) };
      } else if (result.status !== "failure") clearRetryDecision(state);
    } catch {
      result = { status: "failure" as const, code: "adapter_failed" as const, tokens: 0 };
    } finally {
      state.busy = false;
      await syncBusyLease(selected).catch(() => {});
    }
    if (result.sessionContinuity === "lost") {
      state.sessionContinuity = "lost";
      if (result.status === "failure" && result.code === "session_unavailable") {
        delete state.providerSessionId;
      } else {
        state.providerSessionId = journey.providerSessionId(repositoryPath, value.runId, selection);
        const continuityFailure = { status: "failure", code: "session_unavailable", tokens: 0, sessionContinuity: "lost" } as const;
        const fingerprint = await browserFailureFingerprint(repositoryPath, value.stage, continuityFailure, state);
        recordRetryDecision(state, fingerprint, retryScope(value.stage, continuityFailure.code), "changed_environment");
      }
    } else {
      state.providerSessionId = journey.providerSessionId(repositoryPath, value.runId, selection) ?? state.providerSessionId;
    }
    if (result.status === "question" && result.question) { state.question = result.question; state.questionStage = value.stage; state.questionDecisionId = `journey-${randomToken(12)}`; state.pendingQuestions = result.questions ? [...result.questions.slice(1)] : []; if (value.stage === "gather-supplies" && gatherMode === "questions") state.gatherQuestionsDiscovered = true; }
    if (result.status === "action") {
      for (const artifact of result.artifacts) if (!state.artifacts.includes(artifact)) state.artifacts.push(artifact);
      if (value.stage === "draft-implementation") {
        const reviews = state.artifacts.filter((artifact) => posix.extname(artifact).toLowerCase() === ".html");
        const artifacts = state.artifacts.filter((artifact) => posix.extname(artifact).toLowerCase() !== ".html");
        state.artifacts.splice(0, state.artifacts.length, ...artifacts, ...reviews);
      }
      if ((value.stage === "map-route" || value.stage === "draft-implementation") && selected.store) {
        try { state.reviewBaselineRevision = (await selected.store.load(value.runId)).revision; }
        catch { result = { status: "failure", code: "adapter_failed", tokens: result.tokens }; }
      }
    }
    state.lastResult = result;
    state.updatedAt = new Date().toISOString();
    state.status = result.status === "question" ? "waiting" : result.status === "failure" ? (result.code === "cancelled" ? "stopped" : "failed") : value.stage === "review" ? "complete" : "waiting";
    let checkpointDiagnostic: CheckpointDiagnostic | undefined;
    try { checkpointDiagnostic = await persistJourneyCheckpoint(selected.store, value.runId, state, journey, repositoryPath); }
    catch { writeRejection(res, 503); return; }
    if (checkpointDiagnostic) state.lastResult = { ...result, checkpointDiagnostic };
    const links = state.artifacts.flatMap((path, index) => /\.(?:html|md)$/i.test(path) ? [{ path, url: `/api/v1/journey/${encodeURIComponent(value.runId)}/artifacts/${index}` }] : []);
    writeShowcaseJson(res, {
      ...state.lastResult,
      artifacts: state.artifacts,
      artifactLinks: links,
      ...(recoveryReport ? { recovery: recoveryReport } : {}),
      ...journeyDisclosures(state, result),
    });
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

function handleJourneyControlPost(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, journey: JourneyService | undefined): void {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!hasJsonContentType(req.headers["content-type"])) { writeRejection(res, 415); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!journey || !selected.repositoryPath) { writeRejection(res, 409); return; }
  readJsonBody(req, MAX_CONTROL_BODY).then((value) => {
    if (!isJourneyControlBody(value)) { writeRejection(res, 400); return; }
    const state = selected.journeys.get(value.runId);
    if (!state?.busy || state.control) { writeRejection(res, 409); return; }
    state.control = { action: value.action, ...(value.instruction ? { instruction: value.instruction } : {}) };
    journey.cancel(value.runId);
    writeShowcaseJson(res, { status: "accepted", action: value.action });
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

interface GitChange { readonly path: string; readonly status: string; readonly additions: number | null; readonly deletions: number | null; }

function gitOutput(repositoryPath: string, args: readonly string[], maxBuffer = 1024 * 1024, allowDifference = false): Promise<string | null> {
  return new Promise((resolveOutput) => execFile("git", [...args], { cwd: repositoryPath, encoding: "utf8", timeout: 3_000, maxBuffer }, (error, stdout) => {
    const code = error && "code" in error ? error.code : undefined;
    resolveOutput(!error || (allowDifference && code === 1) ? stdout : null);
  }));
}

async function gitChanges(repositoryPath: string): Promise<readonly GitChange[] | null> {
  const [statusOutput, statOutput] = await Promise.all([
    gitOutput(repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitOutput(repositoryPath, ["diff", "--numstat", "--no-renames", "-z", "HEAD", "--"]),
  ]);
  if (statusOutput === null) return null;
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of (statOutput ?? "").split("\0").filter(Boolean)) {
    const firstTab = line.indexOf("\t"), secondTab = line.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = line.slice(0, firstTab), deleted = line.slice(firstTab + 1, secondTab), path = line.slice(secondTab + 1);
    if (path) stats.set(path, { additions: /^\d+$/.test(added) ? Number(added) : null, deletions: /^\d+$/.test(deleted) ? Number(deleted) : null });
  }
  const records = statusOutput.split("\0").filter(Boolean), changes: GitChange[] = [];
  for (let index = 0; index < records.length && changes.length < 200; index += 1) {
    const status = records[index].slice(0, 2), path = records[index].slice(3), stat = stats.get(path);
    if (path) changes.push({ path, status, additions: stat?.additions ?? null, deletions: stat?.deletions ?? null });
    if (/[RC]/.test(status)) index += 1;
  }
  return changes;
}

async function handleGitDiffGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, requestedPath: string): Promise<void> {
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !requestedPath) { writeRejection(res, 409); return; }
  const changes = await gitChanges(selected.repositoryPath), change = changes?.find((entry) => entry.path === requestedPath);
  if (!change) { writeRejection(res, 404); return; }
  const args = change.status === "??"
    ? ["diff", "--no-index", "--no-color", "--unified=3", "--", process.platform === "win32" ? "NUL" : "/dev/null", change.path]
    : ["diff", "--no-color", "--unified=3", "HEAD", "--", change.path];
  const diff = await gitOutput(selected.repositoryPath, args, MAX_GIT_DIFF, change.status === "??");
  if (diff === null) { writeRejection(res, 413); return; }
  writeShowcaseJson(res, { path: change.path, diff });
}

async function handleJourneyStatusGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, runId?: string, journey?: JourneyService): Promise<void> {
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store) { writeRejection(res, 409); return; }
  const changes = await gitChanges(selected.repositoryPath);
  const changedFiles = changes?.length ?? null;
  const history = await selected.store.list(8);
  if (runId && !selected.journeys.has(runId) && !history.some((entry) => entry.runId === runId)) {
    const durable = await selected.store.load(runId);
    const created = durable.events.find((event) => event.type === "workRequestCreated");
    if (created && typeof created.payload.title === "string" && typeof created.payload.goal === "string") {
      const answered = durable.journeyCheckpoint?.questionDecisionId === undefined ? undefined : [...durable.events].reverse().find((event) => event.type === "ownerAnswered" && event.payload.decisionId === durable.journeyCheckpoint?.questionDecisionId && typeof event.payload.answer === "string");
      const restored = restoreJourney({ goal: created.payload.goal, updatedAt: durable.events.at(-1)?.recordedAt ?? created.recordedAt, ...(durable.pendingDecision ? { pendingQuestion: durable.pendingDecision.question } : {}), ...(answered ? { checkpointAnswer: answered.payload.answer as string } : {}), ...(durable.journeyCheckpoint ? { checkpoint: durable.journeyCheckpoint } : {}) });
      if (restored) selected.journeys.set(runId, restored);
    }
  }
  const summaries = history.map((entry) => {
    let active = selected.journeys.get(entry.runId);
    if (!active) { active = restoreJourney(entry); if (active) selected.journeys.set(entry.runId, active); }
    const { checkpoint: _checkpoint, checkpointAnswer: _checkpointAnswer, ...publicEntry } = entry;
    const artifactLinks = active?.artifacts.flatMap((path, index) => /\.(?:html|md)$/i.test(path) ? [{ path, url: `/api/v1/journey/${encodeURIComponent(entry.runId)}/artifacts/${index}` }] : []) ?? [];
    return {
      ...publicEntry,
      ...(active
        ? {
          stage: active.stage,
          status: active.status,
          busy: active.busy,
          artifacts: active.artifacts,
          lastResult: active.lastResult,
          artifactLinks,
          ...journeyDisclosures(active),
        }
        : { status: "saved", busy: false, artifacts: [], artifactLinks: [] }),
    };
  });
  const storedIds = new Set(history.map((entry) => entry.runId));
  for (const [activeRunId, active] of selected.journeys) if (!storedIds.has(activeRunId)) summaries.push({
    runId: activeRunId,
    title: active.goal.split(/\r?\n/, 1)[0].slice(0, 160),
    goal: active.goal,
    updatedAt: active.updatedAt,
    stage: active.stage,
    status: active.status,
    busy: active.busy,
    artifacts: active.artifacts,
    lastResult: active.lastResult,
    artifactLinks: active.artifacts.flatMap((path, index) => /\.(?:html|md)$/i.test(path) ? [{ path, url: `/api/v1/journey/${encodeURIComponent(activeRunId)}/artifacts/${index}` }] : []),
    ...journeyDisclosures(active),
  });
  const boundedHistory = summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const state = runId ? selected.journeys.get(runId) : undefined;
  const liveActivity = runId ? journey?.activityTrail(runId) : undefined;
  const durable = runId && state ? await selected.store.load(runId) : undefined;
  const routeApprovalAvailable = state && durable
    ? await planReviewAvailable(state, durable, selected.repositoryPath)
    : false;
  const explorerAvailable = state && durable
    ? await executionTransitionAllowed(state, durable, selected.repositoryPath, "execute-explorer", "explorer", "slice")
    : false;
  writeShowcaseJson(res, {
    changedFiles,
    gitChanges: changes ?? [],
    history: boundedHistory,
    ...(runId ? { activityTrail: liveActivity?.length ? liveActivity : state?.activityTrail ?? [] } : {}),
    ...(state ? {
      run: {
        runId,
        goal: state.goal,
        stage: state.stage,
        status: state.status,
        busy: state.busy,
        artifacts: state.artifacts,
        question: state.question,
        lastResult: state.lastResult,
        planReviewAvailable: routeApprovalAvailable,
        explorerAvailable,
        ...journeyDisclosures(state),
      },
    } : {}),
  });
}

async function handleHistoryDelete(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, runId?: string): Promise<void> {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.store) { writeRejection(res, 409); return; }
  if (runId ? selected.journeys.get(runId)?.busy : [...selected.journeys.values()].some((journey) => journey.busy)) { writeRejection(res, 409); return; }
  if (runId) {
    await selected.store.delete(runId);
    selected.journeys.delete(runId);
  } else {
    await selected.store.clear();
    selected.journeys.clear();
  }
  writeShowcaseJson(res, { status: "deleted", scope: runId ?? "all" });
}

const MAX_ARTIFACT_LINK_TAG = 4_096;
function htmlSpace(value: string | undefined): boolean { return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f"; }

function anchorTagEnd(html: string, start: number): number | undefined {
  let quote = "";
  const limit = Math.min(html.length, start + MAX_ARTIFACT_LINK_TAG);
  for (let index = start + 2; index < limit; index += 1) {
    const character = html[index]!;
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return undefined;
}

function rewriteAnchorTag(tag: string, route: string, links: ReadonlyMap<string, number>): string {
  const replacements: { start: number; end: number; value: string }[] = [];
  let cursor = 2;
  while (cursor < tag.length - 1) {
    while (htmlSpace(tag[cursor])) cursor += 1;
    if (cursor >= tag.length - 1 || tag[cursor] === "/") break;
    const nameStart = cursor;
    while (cursor < tag.length - 1 && !htmlSpace(tag[cursor]) && tag[cursor] !== "=" && tag[cursor] !== ">") cursor += 1;
    const name = tag.slice(nameStart, cursor).toLowerCase();
    while (htmlSpace(tag[cursor])) cursor += 1;
    if (tag[cursor] !== "=") continue;
    cursor += 1;
    while (htmlSpace(tag[cursor])) cursor += 1;
    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") {
      while (cursor < tag.length - 1 && !htmlSpace(tag[cursor]) && tag[cursor] !== ">") cursor += 1;
      continue;
    }
    const valueStart = cursor + 1, valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0) break;
    if (name === "href") {
      const value = tag.slice(valueStart, valueEnd), candidate = value.startsWith("./") ? value.slice(2) : value;
      const segments = candidate.split("/");
      const artifactIndex = candidate && !candidate.includes("\\") && !candidate.includes("?") && !candidate.includes("#") && !posix.isAbsolute(candidate) && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") && posix.normalize(candidate) === candidate ? links.get(candidate) : undefined;
      if (artifactIndex !== undefined) replacements.push({ start: valueStart, end: valueEnd, value: `${route}/${artifactIndex}` });
    }
    cursor = valueEnd + 1;
  }
  if (!replacements.length) return tag;
  let rewritten = "", copied = 0;
  for (const replacement of replacements) {
    rewritten += tag.slice(copied, replacement.start) + replacement.value;
    copied = replacement.end;
  }
  return rewritten + tag.slice(copied);
}

function rewriteArtifactLinks(html: string, route: string, links: ReadonlyMap<string, number>): string {
  const lower = html.toLowerCase();
  let rewritten = "", copied = 0, search = 0;
  while (search < html.length) {
    const start = html.indexOf("<", search);
    if (start < 0) break;
    if (lower.startsWith("<!--", start)) {
      const commentEnd = lower.indexOf("-->", start + 4);
      search = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    if (lower[start + 1] !== "a") { search = start + 1; continue; }
    const boundary = html[start + 2];
    if (!htmlSpace(boundary) && boundary !== ">" && boundary !== "/") { search = start + 2; continue; }
    const end = anchorTagEnd(html, start);
    if (end === undefined) { search = start + 2; continue; }
    rewritten += html.slice(copied, start) + rewriteAnchorTag(html.slice(start, end + 1), route, links);
    copied = end + 1;
    search = copied;
  }
  return rewritten + html.slice(copied);
}

async function handleJourneyArtifactGet(res: ServerResponse, service: LocalSessionService, req: IncomingMessage, selected: SelectedBrowserState, runId: string, indexText: string): Promise<void> {
  if (!service.authenticateRequest(req) || !selected.repositoryPath) { writeRejection(res, 401); return; }
  const state = selected.journeys.get(runId);
  const index = Number(indexText);
  const path = Number.isSafeInteger(index) ? state?.artifacts[index] : undefined;
  if (!path || !/\.(?:html|md)$/i.test(path)) { writeRejection(res, 404); return; }
  try {
    const candidate = resolve(selected.repositoryPath, path), lexical = relative(selected.repositoryPath, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) throw new Error("invalid artifact");
    const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let artifact: Buffer;
    try {
      const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
      const relation = relative(selected.repositoryPath, canonical);
      if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size > MAX_JOURNEY_ARTIFACT || !relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("invalid artifact");
      const buffer = Buffer.allocUnsafe(MAX_JOURNEY_ARTIFACT + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_JOURNEY_ARTIFACT) throw new Error("invalid artifact");
      artifact = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
    const html = path.toLowerCase().endsWith(".html");
    if (html) {
      const directory = posix.dirname(path), links = new Map<string, number>();
      state?.artifacts.forEach((artifactPath, artifactIndex) => {
        const relativeArtifact = posix.relative(directory, artifactPath);
        if (/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|html)$/i.test(relativeArtifact) && !relativeArtifact.split("/").includes("..") && !links.has(relativeArtifact)) links.set(relativeArtifact, artifactIndex);
      });
      const rewritten = rewriteArtifactLinks(artifact.toString("utf8"), `/api/v1/journey/${encodeURIComponent(runId)}/artifacts`, links);
      artifact = Buffer.from(rewritten, "utf8");
      if (artifact.length > MAX_JOURNEY_ARTIFACT) throw new Error("invalid artifact");
    }
    res.writeHead(200, { "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Content-Length": artifact.length, "Content-Security-Policy": html ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" : "default-src 'none'; frame-ancestors 'none'", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    res.end(artifact);
  } catch { writeRejection(res, 404); }
}

function writeShowcaseJson(res: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_SHOWCASE_JSON) {
    writeRejection(res, 500);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

type VerificationIngestFailure = GraderReportFailure | ParkRangerReportFailure
  | "verification_content_type_unsupported"
  | "verification_report_too_large"
  | "verification_checkpoint_rejected";

type RunReadFailureCode = "repository_not_selected" | "run_not_found" | "run_unavailable" | "execution_contract_unavailable" | "execution_contract_malformed" | "owner_approval_unverified" | "execution_contract_response_too_large" | "unknown_slice" | "slice_not_projectable" | "verification_projection_invalid" | VerificationIngestFailure;

type RunReadFailure = {
  readonly status: number;
  readonly code: RunReadFailureCode;
  readonly remedy: string;
};

function runReadFailure(code: RunReadFailure["code"]): RunReadFailure {
  const failures: Readonly<Record<RunReadFailure["code"], Omit<RunReadFailure, "code">>> = {
    repository_not_selected: { status: 409, remedy: "Choose a repository before reading run planning data." },
    run_not_found: { status: 404, remedy: "Choose a run recorded in the selected repository." },
    run_unavailable: { status: 503, remedy: "The run ledger is unavailable. Repair it or choose another run." },
    execution_contract_unavailable: { status: 404, remedy: "Record the approved execution contract for this run, then try again." },
    execution_contract_malformed: { status: 422, remedy: "Repair and re-approve the execution contract for this run." },
    owner_approval_unverified: { status: 422, remedy: "Record durable owner approval for this exact execution contract before reading or recording verification data." },
    execution_contract_response_too_large: { status: 413, remedy: "Reduce the approved execution contract so its bounded response can be returned safely." },
    unknown_slice: { status: 404, remedy: "Choose a slice declared by the approved execution contract." },
    slice_not_projectable: { status: 422, remedy: "Repair the approved slice so it satisfies the Focus execution boundary." },
    verification_projection_invalid: { status: 422, remedy: "Repair the recorded verification checkpoint for this layer before reading it." },
    malformed: { status: 422, remedy: "Submit a complete report that satisfies the selected verification layer contract." },
    rubric_version_mismatch: { status: 422, remedy: "Submit a grader report using the current rubric version." },
    contract_mismatch: { status: 422, remedy: "Bind the grader report to the exact approved execution contract hash." },
    verdict_mismatch: { status: 422, remedy: "Recompute the grader verdict from the submitted weighted scores." },
    unexpected_key: { status: 422, remedy: "Remove fields outside the selected verification report contract, including authority-bearing fields." },
    prototype_pollution: { status: 422, remedy: "Submit a plain JSON report without unsafe object keys or prototypes." },
    finding_unreproduced: { status: 422, remedy: "Include bounded reproduction inputs and an observed failure for every finding." },
    finding_unreachable: { status: 422, remedy: "Include a non-empty reachable path for every finding." },
    claim_unadjudicated: { status: 422, remedy: "Adjudicate every inbound readiness claim before submitting the report." },
    self_certification: { status: 422, remedy: "Use an independent verification session for the report." },
    shared_ancestry: { status: 422, remedy: "Use a verification session outside the implementation execution ancestry." },
    verification_content_type_unsupported: { status: 415, remedy: "Submit the verification report as application/json." },
    verification_report_too_large: { status: 413, remedy: "Reduce the verification report to the bounded ingestion size." },
    verification_checkpoint_rejected: { status: 409, remedy: "Reload the run and retry the validated evidence append without changing its authority." },
  };
  return { code, ...failures[code] };
}

function writeRunReadFailure(res: ServerResponse, code: RunReadFailure["code"]): void {
  writeRepositoryFailure(res, runReadFailure(code));
}

function writeRunReadJson(res: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_SHOWCASE_JSON) {
    writeRunReadFailure(res, "execution_contract_response_too_large");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function writeImprovementFailure(res: ServerResponse, code: ImprovementServiceFailure): void {
  const remedies: Readonly<Record<ImprovementServiceFailure, string>> = {
    configuration_invalid: "Repair the local improvement report configuration, then try again.",
    clock_invalid: "Repair the local clock used for the improvement report, then try again.",
    store_read_failed: "Repair the selected repository run ledger, then try again.",
    stage_failed: "Repair the failed improvement report stage, then try again.",
  };
  writeRepositoryFailure(res, { status: 503, code, remedy: remedies[code] });
}

async function handleImprovementReportGet(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  selected: SelectedBrowserState,
  report: RequestHandlerOptions["improvementReport"],
): Promise<void> {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) {
    writeRunReadFailure(res, "repository_not_selected");
    return;
  }
  const selectedReport = report ?? ((input: { readonly store: BearingStore }) => (
    buildImprovementReport(input.store)
  ));
  let result: Awaited<ReturnType<NonNullable<typeof report>>>;
  try {
    result = await selectedReport({ repositoryPath: selected.repositoryPath, store: selected.store });
  } catch {
    writeImprovementFailure(res, "stage_failed");
    return;
  }
  if (!result.ok) {
    writeImprovementFailure(res, result.reason);
    return;
  }
  writeRunReadJson(res, result.value);
}

function writeImprovementHandoffFailure(
  res: ServerResponse,
  code: "authentication_required" | "origin_rejected" | "run_not_found" | "run_unavailable",
): void {
  const failures = {
    authentication_required: { status: 401, remedy: "Establish an authenticated local Bearing session before reading the degradation handoff." },
    origin_rejected: { status: 403, remedy: "Read the degradation handoff only from the authenticated local Bearing control room." },
    run_not_found: { status: 404, remedy: "Record a run in the selected repository before requesting a degradation handoff." },
    run_unavailable: { status: 503, remedy: "Repair the selected repository run ledger, then request the degradation handoff again." },
  } as const;
  writeRepositoryFailure(res, { code, ...failures[code] });
}

async function handleImprovementHandoffGet(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  selected: SelectedBrowserState,
): Promise<void> {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) {
    writeImprovementHandoffFailure(res, "origin_rejected");
    return;
  }
  if (!service.authenticateRequest(req)) {
    writeImprovementHandoffFailure(res, "authentication_required");
    return;
  }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) {
    writeRunReadFailure(res, "repository_not_selected");
    return;
  }
  const result = await buildImprovementHandoffFacts(selected.store);
  if (!result.ok) {
    writeImprovementHandoffFailure(res, result.reason);
    return;
  }
  writeRunReadJson(res, { text: renderImprovementHandoff(result.value) });
}

function repositoryRelativePlanDirectory(value: string): boolean {
  return !isAbsolute(value)
    && !/^[A-Za-z]:/.test(value)
    && !value.includes("\\")
    && posix.normalize(value) === value
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

async function executionContractSource(repositoryPath: string, planDirectory: string): Promise<{ readonly available: true; readonly value: unknown } | { readonly available: false }> {
  if (!repositoryRelativePlanDirectory(planDirectory)) return { available: false };
  const candidate = resolve(repositoryPath, planDirectory, "execution-contract.json");
  const lexical = relative(repositoryPath, candidate);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return { available: false };
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const [opened, linked, canonical] = await Promise.all([file.stat(), lstat(candidate), realpath(candidate)]);
    const relation = relative(repositoryPath, canonical);
    if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size > MAX_JOURNEY_ARTIFACT || !relation || relation.startsWith("..") || isAbsolute(relation)) return { available: false };
    const buffer = Buffer.allocUnsafe(MAX_JOURNEY_ARTIFACT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_JOURNEY_ARTIFACT) return { available: false };
    const content = buffer.subarray(0, length).toString("utf8");
    try { return { available: true, value: JSON.parse(content) as unknown }; }
    catch { return { available: true, value: undefined }; }
  } catch {
    return { available: false };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export function executionContractApprovalRecorded(
  events: readonly { readonly type: string; readonly eventId: string; readonly actor: string; readonly payload: Readonly<Record<string, unknown>> }[],
  recordId: string,
  contentHash: string,
): boolean {
  return events.some((event) => event.type === "ownerAnswered"
    && event.eventId === recordId
    && event.actor === "owner"
    && event.payload.answer === PLAN_REVIEW_APPROVAL
    && event.payload.ownerApprovedContentHash === contentHash);
}

async function approvedExecutionContractForRun(
  res: ServerResponse,
  repositoryPath: string,
  runId: string,
  durable: Awaited<ReturnType<BearingStore["load"]>>,
): Promise<Extract<ExecutionContractParseResult, { readonly ok: true }> | undefined> {
  const planDirectory = [...durable.events].reverse().find((event) => event.type === "journeyCheckpointRecorded"
    && typeof event.payload.planDirectory === "string")?.payload.planDirectory;
  if (typeof planDirectory !== "string") { writeRunReadFailure(res, "execution_contract_unavailable"); return undefined; }
  if (!repositoryRelativePlanDirectory(planDirectory)) { writeRunReadFailure(res, "execution_contract_malformed"); return undefined; }
  const source = await executionContractSource(repositoryPath, planDirectory);
  if (!source.available) { writeRunReadFailure(res, "execution_contract_unavailable"); return undefined; }
  const parsed = parseApprovedExecutionContract(source.value);
  if (!parsed.ok || parsed.value.runId !== runId || parsed.value.planDirectory !== planDirectory) { writeRunReadFailure(res, "execution_contract_malformed"); return undefined; }
  if (!executionContractApprovalRecorded(durable.events, parsed.value.ownerApproval.recordId, parsed.value.contentHash)) {
    writeRunReadFailure(res, "owner_approval_unverified");
    return undefined;
  }
  return parsed;
}

async function handleExecutionContractGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, runId: string, sliceId: string): Promise<void> {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) { writeRunReadFailure(res, "repository_not_selected"); return; }
  let durable: Awaited<ReturnType<BearingStore["load"]>>;
  try { durable = await selected.store.load(runId); }
  catch { writeRunReadFailure(res, "run_unavailable"); return; }
  if (!durable.workRequestCreated) { writeRunReadFailure(res, "run_not_found"); return; }
  const parsed = await approvedExecutionContractForRun(res, selected.repositoryPath, runId, durable);
  if (!parsed) return;
  const slice = parsed.value.slices.find((candidate) => candidate.sliceId === sliceId);
  const role = slice?.role;
  if (slice && role !== "explorer" && role !== "navigator" && role !== "crewmate") { writeRunReadFailure(res, "slice_not_projectable"); return; }
  const runtimeRole = role === "explorer" || role === "navigator" || role === "crewmate" ? role : "crewmate";
  const focusEnvelope = deriveFocusEnvelope(parsed.value, sliceId, { role: runtimeRole });
  if ("ok" in focusEnvelope && !focusEnvelope.ok) { writeRunReadFailure(res, focusEnvelope.reason); return; }
  writeRunReadJson(res, { contract: parsed.value, focusEnvelope, advisories: parsed.advisories });
}

async function handlePlanningStateGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, runId: string): Promise<void> {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) { writeRunReadFailure(res, "repository_not_selected"); return; }
  let durable: Awaited<ReturnType<BearingStore["load"]>>;
  try { durable = await selected.store.load(runId); }
  catch { writeRunReadFailure(res, "run_unavailable"); return; }
  if (!durable.workRequestCreated) { writeRunReadFailure(res, "run_not_found"); return; }
  // Report the same reality the journey gate enforces. Reading the raw projection here answered
  // RECON_READY while drafting was being refused for a recorded Recon stop, because the transition
  // table cannot record reconFailed from RECON_READY so nothing canonical is ever projected.
  writeShowcaseJson(res, { runId, planningState: planningStateForJourneyGate(durable).planningState });
}

type VerificationCheckpointParseResult =
  | { readonly ok: true; readonly value: VerificationCheckpointPayload }
  | { readonly ok: false; readonly reason: "verification_projection_invalid" };

function parseVerificationCheckpoint(value: unknown): VerificationCheckpointParseResult {
  // Re-validate on read: ledger bytes come off disk, so the write-time guard is not sufficient on
  // its own. Deliberately the SAME predicate the ledger boundary applies (src/contracts/run.ts) so
  // the two layers cannot drift apart.
  if (!isVerificationCheckpointPayload(value)) {
    return { ok: false, reason: "verification_projection_invalid" };
  }
  return {
    ok: true,
    value: {
      layer: value.layer,
      verdict: value.verdict,
      ...(value.rubricVersion === undefined ? {} : { rubricVersion: value.rubricVersion }),
      ...(value.findingCount === undefined ? {} : { findingCount: value.findingCount }),
    },
  };
}

async function handleVerificationReportGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, runId: string, layer: VerificationLayer): Promise<void> {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) { writeRunReadFailure(res, "repository_not_selected"); return; }
  let durable: Awaited<ReturnType<BearingStore["load"]>>;
  try { durable = await selected.store.load(runId); }
  catch { writeRunReadFailure(res, "run_unavailable"); return; }
  if (!durable.workRequestCreated) { writeRunReadFailure(res, "run_not_found"); return; }
  const entries: {
    readonly eventId: string;
    readonly sequence: number;
    readonly stage: (typeof RECORD_JOURNEY_CHECKPOINT_STAGES)[number];
    readonly status: "running" | "waiting" | "stopped" | "failed" | "complete";
    readonly verdict: VerificationVerdict;
    readonly rubricVersion?: string;
    readonly findingCount?: number;
  }[] = [];
  for (const event of durable.events) {
    if (event.type !== "journeyCheckpointRecorded" || event.payload.verification === undefined) continue;
    const parsed = parseVerificationCheckpoint(event.payload.verification);
    if (!parsed.ok) { writeRunReadFailure(res, parsed.reason); return; }
    if (parsed.value.layer !== layer) continue;
    const stage = event.payload.stage;
    const status = event.payload.status;
    if (typeof stage !== "string"
      || !RECORD_JOURNEY_CHECKPOINT_STAGES.includes(stage as (typeof RECORD_JOURNEY_CHECKPOINT_STAGES)[number])
      || (status !== "running" && status !== "waiting" && status !== "stopped" && status !== "failed" && status !== "complete")) {
      writeRunReadFailure(res, "verification_projection_invalid");
      return;
    }
    entries.push({
      eventId: event.eventId,
      sequence: event.sequence,
      stage: stage as (typeof RECORD_JOURNEY_CHECKPOINT_STAGES)[number],
      status,
      verdict: parsed.value.verdict,
      ...(parsed.value.rubricVersion === undefined ? {} : { rubricVersion: parsed.value.rubricVersion }),
      ...(parsed.value.findingCount === undefined ? {} : { findingCount: parsed.value.findingCount }),
    });
  }
  writeRunReadJson(res, { runId, layer, entries });
}

async function handleVerificationReportPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  selected: SelectedBrowserState,
  runId: string,
  layer: "grader" | "park-ranger",
): Promise<void> {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) { writeRunReadFailure(res, "repository_not_selected"); return; }
  let durable: Awaited<ReturnType<BearingStore["load"]>>;
  try { durable = await selected.store.load(runId); }
  catch { writeRunReadFailure(res, "run_unavailable"); return; }
  if (!durable.workRequestCreated) { writeRunReadFailure(res, "run_not_found"); return; }
  const approved = await approvedExecutionContractForRun(res, selected.repositoryPath, runId, durable);
  if (!approved) return;
  const contract = approved.value;
  if (!hasJsonContentType(req.headers["content-type"])) { writeRunReadFailure(res, "verification_content_type_unsupported"); return; }

  let body: unknown;
  try { body = await readJsonBody(req, MAX_VERIFICATION_BODY); }
  catch (error) {
    writeRunReadFailure(res, error instanceof RangeError ? "verification_report_too_large" : "malformed");
    return;
  }

  let verification: VerificationCheckpointPayload;
  let reportIdentity: unknown;
  // Implementer sessions are read from the ledger, so self_certification is enforced against
  // recorded fact rather than anything the caller asserts.
  //
  // executionAncestry is deliberately empty and shared_ancestry is therefore NOT enforced here:
  // no trusted provenance for a verifier's ancestry is persisted anywhere yet. Accepting a
  // caller-supplied ancestry would look like a control while being none, since the caller would
  // simply declare itself unrelated. Left unenforced and documented rather than faked; making it
  // real needs an owner-approved provenance record and is tracked as follow-up work.
  const independence = {
    implementerSessionIds: [...new Set(durable.events.flatMap((event) =>
      typeof event.payload.providerSessionId === "string" ? [event.payload.providerSessionId] : []))],
    executionAncestry: [],
  };
  if (layer === "grader") {
    const parsed = parseGraderReport(body, contract.contentHash, {
      sliceIds: contract.slices.map(({ sliceId }) => sliceId),
      phaseIds: contract.phases.map(({ phaseId }) => phaseId),
    });
    if (!parsed.ok) { writeRunReadFailure(res, parsed.reason); return; }
    const independent = assertIndependentVerification({
      verifierSessionId: parsed.value.graderSessionId,
      ...independence,
    });
    if (!independent.ok) { writeRunReadFailure(res, independent.code); return; }
    reportIdentity = parsed.value;
    verification = {
      layer,
      verdict: graderVerdict(parsed.value),
      rubricVersion: String(parsed.value.rubricVersion),
    };
  } else {
    const reports = Array.isArray(body) ? body : [body];
    if (reports.length === 0 || reports.length > 128) { writeRunReadFailure(res, "malformed"); return; }
    const claimSource = [...durable.events].reverse().find((event) =>
      event.type === "journeyCheckpointRecorded"
      && isVerificationCheckpointPayload(event.payload.verification)
      && event.payload.verification.layer === "validator"
      && typeof event.payload.lastResultJson === "string");
    let inboundClaims: { readonly text: string; readonly sliceIds: readonly string[] }[] = [];
    if (claimSource) {
      try {
        const result = JSON.parse(claimSource.payload.lastResultJson as string) as unknown;
        if (typeof result !== "object" || result === null || Array.isArray(result)
          || !("status" in result) || result.status !== "action"
          || !("summary" in result) || typeof result.summary !== "string") {
          writeRunReadFailure(res, "malformed");
          return;
        }
        inboundClaims = [{ text: result.summary, sliceIds: contract.slices.map(({ sliceId }) => sliceId) }];
      } catch {
        writeRunReadFailure(res, "malformed");
        return;
      }
    }
    const parsedReports = reports.map((report) => parseParkRangerReport(report, inboundClaims, independence));
    const refused = parsedReports.find((report) => !report.ok);
    if (refused && !refused.ok) { writeRunReadFailure(res, refused.reason); return; }
    const parsedValues = parsedReports.flatMap((report) => report.ok ? [report.value] : []);
    reportIdentity = parsedValues;
    const synthesized = synthesizeFindings(parsedValues, independence);
    if (!synthesized.ok) { writeRunReadFailure(res, synthesized.reason); return; }
    verification = {
      layer,
      verdict: synthesized.value.verdict,
      findingCount: synthesized.value.findings.length,
    };
  }
  if (!isVerificationCheckpointPayload(verification)) { writeRunReadFailure(res, "verification_projection_invalid"); return; }
  const commandId = `verification-${createHash("sha256")
    .update(canonicalStringify({ runId, layer, contractHash: contract.contentHash, report: reportIdentity }))
    .digest("hex")}`;
  const existing = durable.events.find((event) => event.causationId === commandId);
  if (existing) {
    writeRunReadJson(res, {
      status: "recorded",
      runId,
      eventId: existing.eventId,
      sequence: existing.sequence,
      verification,
    });
    return;
  }
  if (!durable.journeyCheckpoint) { writeRunReadFailure(res, "verification_checkpoint_rejected"); return; }
  const { eventId: _checkpointEventId, ...checkpointPayload } = durable.journeyCheckpoint;

  let recorded: Awaited<ReturnType<BearingStore["apply"]>>;
  try {
    recorded = await selected.store.apply({
      schemaVersion: 1,
      commandId,
      runId,
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: { ...checkpointPayload, verification },
      session: { sessionId: "local-runtime", actor: "bearing" },
      correlationId: commandId,
    });
  } catch {
    writeRunReadFailure(res, "run_unavailable");
    return;
  }
  let event = recorded.ok ? recorded.events[0] : undefined;
  if (recorded.ok && !event) {
    try { event = (await selected.store.load(runId)).events.find((candidate) => candidate.causationId === commandId); }
    catch { writeRunReadFailure(res, "run_unavailable"); return; }
  }
  if (!recorded.ok || !event) { writeRunReadFailure(res, "verification_checkpoint_rejected"); return; }
  writeRunReadJson(res, {
    status: "recorded",
    runId,
    eventId: event.eventId,
    sequence: event.sequence,
    verification,
  });
}

async function handleReviewCadenceGet(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, runId: string): Promise<void> {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!selected.repositoryPath || !selected.store || selected.repositorySelecting) { writeRunReadFailure(res, "repository_not_selected"); return; }
  let durable: Awaited<ReturnType<BearingStore["load"]>>;
  try { durable = await selected.store.load(runId); }
  catch { writeRunReadFailure(res, "run_unavailable"); return; }
  if (!durable.workRequestCreated) { writeRunReadFailure(res, "run_not_found"); return; }
  const approved = await approvedExecutionContractForRun(res, selected.repositoryPath, runId, durable);
  if (!approved) return;
  const contract = approved.value;
  const resolvedCadence = resolveReviewCadence({ declared: contract.reviewCadence, triggers: [] });
  writeRunReadJson(res, {
    runId,
    declaredCadence: contract.reviewCadence,
    resolvedCadence,
    requiredGates: {
      slice: requiredGates(resolvedCadence.cadence, "slice"),
      phase: requiredGates(resolvedCadence.cadence, "phase"),
      completion: requiredGates(resolvedCadence.cadence, "completion"),
    },
  });
}

/**
 * HTTP handler for the browser-control boundary. Host is checked on every
 * request; Origin is checked on POST. The capability is never in any response.
 */
export function createRequestHandler(
  service: LocalSessionService,
  repositoryBootstrap = new RepositoryBootstrap(),
  options: RequestHandlerOptions = {},
) {
  const selected: SelectedBrowserState = {
    store: null, gateway: null, sse: null, repositoryPath: null, repositorySelecting: false, selection: null, run: null, journeys: new Map(), busyLeaseQueue: Promise.resolve(),
  };
  const readiness = new ReadinessService(
    options.routeInspection ?? options.processRunner ?? { executableAvailable: () => false },
    options.verification ?? (options.processRunner ? new AdapterVerification(options.processRunner) : undefined),
    options.startupOverrides,
  );
  const repositoryChoice = options.repositoryChoice ?? new RepositoryChoiceService();
  const journey = options.processRunner ? new JourneyService(options.processRunner) : undefined;
  const improvementReport = Object.hasOwn(options, "improvementReport")
    && typeof options.improvementReport === "function"
    ? options.improvementReport
    : "improvementReport" in options
      ? async () => ({ ok: false as const, reason: "configuration_invalid" as const })
      : undefined;
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!service.validHost(req.headers.host)) {
      writeRejection(res, 421);
      return;
    }
    const method = req.method ?? "";
    const path = req.url ?? "/";
    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(NATIVE_HTML.replace("__BEARING_INITIAL_GREETING__", htmlText(unnamedGreetingFor())));
      return;
    }
    if (method === "GET" && path === "/assets/bearing-office.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": SIGNATURE_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(SIGNATURE_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-title-mark.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": TITLE_MARK_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(TITLE_MARK_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-expedition.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": EXPEDITION_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(EXPEDITION_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-explorer-card.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": EXPLORER_CARD_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(EXPLORER_CARD_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-expedition-card.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": EXPEDITION_CARD_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(EXPEDITION_CARD_IMAGE);
      return;
    }
    if (method === "POST" && path === "/api/v1/session") {
      handleSessionPost(req, res, service);
      return;
    }
    if (method === `GET` && path === "/api/v1/improvement/handoff") {
      void handleImprovementHandoffGet(req, res, service, selected)
        .catch(() => writeImprovementHandoffFailure(res, "run_unavailable"));
      return;
    }
    if (!service.authenticateRequest(req)) {
      writeRejection(res, 401);
      return;
    }
    if (method === "POST" && path === "/api/v1/repository") {
      handleRepositoryPost(req, res, service, repositoryBootstrap, repositoryChoice, selected);
      return;
    }
    if (method === "POST" && path === "/api/v1/repository/gitignore") {
      void handleRepositoryGitignorePost(req, res, service, selected);
      return;
    }
    if (method === "POST" && path === "/api/v1/owner") {
      handleOwnerPost(req, res, service, repositoryBootstrap, selected.repositoryPath, selected.repositorySelecting);
      return;
    }
    if (method === "GET" && path === "/api/v1/repository-options") {
      handleRepositoryOptions(req, res, service, repositoryChoice);
      return;
    }
    if (method === "GET" && path === "/api/v1/routes") {
      if (selected.store === null) writeRejection(res, 409);
      else {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ routes: readiness.inspect(selected.repositoryPath!).map((route) => ({ ...route, reasoning: normalizeReasoningTier(route.reasoning, route.provider) ?? "medium" })) }));
      }
      return;
    }
    const routeModels = /^\/api\/v1\/routes\/([a-z0-9-]{1,64})\/models$/.exec(path);
    if (method === "GET" && routeModels) {
      handleRouteModelsGet(req, res, service, readiness, selected.repositoryPath, selected.repositorySelecting, routeModels[1]!);
      return;
    }
    if (method === "POST" && path === "/api/v1/readiness") {
      handleReadinessPost(req, res, service, readiness, selected.repositoryPath, selected.repositorySelecting, (selection, run) => { selected.selection = selection; selected.run = run; });
      return;
    }
    if (method === "POST" && path === "/api/v1/journey") {
      handleJourneyPost(req, res, service, selected, journey, options.beforeJourneyExecutionCheckpoint);
      return;
    }
    if (method === "POST" && path === "/api/v1/journey/control") {
      handleJourneyControlPost(req, res, service, selected, journey);
      return;
    }
    if (method === "GET" && path.startsWith("/api/v1/git-diff?")) {
      const target = new URL(path, "http://bearing.local");
      const requestedPath = target.pathname === "/api/v1/git-diff" && target.searchParams.size === 1 ? target.searchParams.get("path") : null;
      if (!requestedPath) writeRejection(res, 400);
      else void handleGitDiffGet(req, res, service, selected, requestedPath).catch(() => writeRejection(res, 500));
      return;
    }
    if (method === "GET" && path === "/api/v1/history") {
      void handleJourneyStatusGet(req, res, service, selected).catch(() => writeRejection(res, 500));
      return;
    }
    if (method === "GET" && path === "/api/v1/improvement/report") {
      void handleImprovementReportGet(req, res, service, selected, improvementReport)
        .catch(() => writeImprovementFailure(res, "stage_failed"));
      return;
    }
    const historyEntry = /^\/api\/v1\/history\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (method === "DELETE" && (path === "/api/v1/history" || historyEntry)) {
      void handleHistoryDelete(req, res, service, selected, historyEntry?.[1]).catch(() => writeRejection(res, 500));
      return;
    }
    const journeyStatus = /^\/api\/v1\/journey\/([A-Za-z0-9_-]{1,128})\/status$/.exec(path);
    if (method === "GET" && journeyStatus) {
      void handleJourneyStatusGet(req, res, service, selected, journeyStatus[1], journey).catch(() => writeRejection(res, 500));
      return;
    }
    const executionContract = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/execution-contract\/([A-Za-z0-9.]{1,128})$/.exec(path);
    if (method === "GET" && executionContract) {
      void handleExecutionContractGet(req, res, service, selected, executionContract[1], executionContract[2]).catch(() => writeRejection(res, 500));
      return;
    }
    const planningState = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/planning-state$/.exec(path);
    if (method === "GET" && planningState) {
      void handlePlanningStateGet(req, res, service, selected, planningState[1]).catch(() => writeRejection(res, 500));
      return;
    }
    const verificationReport = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/verification\/(validator|grader|park-ranger)$/.exec(path);
    if (method === "POST" && verificationReport && verificationReport[2] !== "validator") {
      void handleVerificationReportPost(req, res, service, selected, verificationReport[1], verificationReport[2] as "grader" | "park-ranger")
        .catch(() => writeRunReadFailure(res, "run_unavailable"));
      return;
    }
    if (method === "GET" && verificationReport) {
      void handleVerificationReportGet(req, res, service, selected, verificationReport[1], verificationReport[2] as VerificationLayer).catch(() => writeRejection(res, 500));
      return;
    }
    const reviewCadence = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/review-cadence$/.exec(path);
    if (method === "GET" && reviewCadence) {
      void handleReviewCadenceGet(req, res, service, selected, reviewCadence[1]).catch(() => writeRejection(res, 500));
      return;
    }
    const journeyArtifact = /^\/api\/v1\/journey\/([A-Za-z0-9_-]{1,128})\/artifacts\/(\d{1,3})$/.exec(path);
    if (method === "GET" && journeyArtifact) {
      void handleJourneyArtifactGet(res, service, req, selected, journeyArtifact[1], journeyArtifact[2]).catch(() => writeRejection(res, 500));
      return;
    }
    if (method === "GET" && path === "/api/v1/workflows") {
      if (selected.store === null) writeRejection(res, 409);
      else writeShowcaseJson(res, { schemaVersion: 1, workflows: listWorkflowShowcases() });
      return;
    }
    const report = /^\/api\/v1\/workflows\/([A-Za-z0-9][A-Za-z0-9.-]{0,63})\/report$/.exec(path);
    if (method === "GET" && report) {
      if (selected.store === null) writeRejection(res, 409);
      else {
        const html = renderWorkflowReport(report[1]);
        if (html === null) writeRejection(res, 404);
        else if (Buffer.byteLength(html) > MAX_SHOWCASE_REPORT) writeRejection(res, 500);
        else {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": `inline; filename="${report[1]}-evidence.html"`,
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(html);
        }
      }
      return;
    }
    const workflow = /^\/api\/v1\/workflows\/([A-Za-z0-9][A-Za-z0-9.-]{0,63})$/.exec(path);
    if (method === "GET" && workflow) {
      if (selected.store === null) writeRejection(res, 409);
      else {
        const projection = projectWorkflowShowcase(workflow[1]);
        if (projection === null) writeRejection(res, 404);
        else writeShowcaseJson(res, projection);
      }
      return;
    }
    const command = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/commands$/.exec(path);
    if (method === "POST" && command) {
      if (selected.gateway === null) writeRejection(res, 409);
      else selected.gateway.handle(req, res, command[1]);
      return;
    }
    const run = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (method === "GET" && run) {
      if (selected.gateway === null) writeRejection(res, 409);
      else selected.gateway.read(req, res, run[1]);
      return;
    }
    const events = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/events$/.exec(path);
    if (method === "GET" && events) {
      if (selected.sse === null) writeRejection(res, 409);
      else selected.sse.handle(req, res, events[1]);
      return;
    }
    writeRejection(res, 404);
  };
}

/**
 * The headless adapter is deliberately an in-process client of the same
 * authenticated request handler the browser uses. It owns no journey state:
 * durable state, repository admission, owner commands, and stage gates remain
 * behind the existing local-session routes.
 */
export type HeadlessJourneyAction = "create" | "resume" | "status" | "decide" | "approve-route" | "confirm-amendment" | "select-execution" | "select-explorer" | "progress";

export interface HeadlessJourneyRequest {
  readonly action: HeadlessJourneyAction;
  readonly repository: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
  readonly runId: string;
  readonly goal?: string;
  readonly answer?: string;
  readonly stage?: JourneyStage;
  readonly executionMode?: "explorer" | "expedition";
  readonly reviewCadence?: "slice" | "phase" | "end";
}

export type HeadlessJourneyReceipt = {
  readonly ok: boolean;
  readonly code?: "input_invalid" | "illegal_transition" | "repository_rejected" | "route_unavailable" | "run_not_found" | "transition_unavailable";
  readonly runId: string;
  readonly revision: number;
  readonly stage?: JourneyStage;
  readonly status?: BrowserJourney["status"];
  readonly allowedActions?: readonly HeadlessJourneyAction[];
  readonly question?: string;
  readonly summary?: string;
  readonly artifacts?: readonly string[];
  readonly requiredOwnerAction?:
    | { readonly type: "answer"; readonly question: string }
    | { readonly type: "approve-route"; readonly prompt: typeof PLAN_REVIEW_QUESTION; readonly artifacts: readonly string[] }
    | { readonly type: "confirm-amendment"; readonly prompt: typeof FOCUS_AMENDMENT_PROMPT }
    | { readonly type: "select-execution"; readonly modes: readonly ["explorer", "expedition"]; readonly reviewCadences: readonly ["slice", "phase", "end"] };
  readonly outcome?:
    | { readonly type: "running" | "waiting" | "complete" }
    | { readonly type: "stopped" | "failed"; readonly code: HeadlessJourneyFailureCode };
  readonly disclosure?: string;
  readonly gitignoreMissing?: boolean;
  readonly readiness?: "ready" | "unavailable";
};

export interface HeadlessJourneyDeps {
  readonly processRunner: ProcessRunner;
  readonly routeInspection?: RouteInspectionPort;
}

type HeadlessResponse = { readonly status: number; readonly body: string; readonly headers: Readonly<Record<string, string | readonly string[]>> };
type LocalRequestHandler = ReturnType<typeof createRequestHandler>;
const HEADLESS_BOUND_HOST = "127.0.0.1:0";
const HEADLESS_WORKSPACE_DISCLOSURE = "Bearing writes durable planning state to the selected repository's .bearing/ directory.";
const MAX_HEADLESS_TEXT = 4_096;
const MAX_HEADLESS_ARTIFACTS = 32;
const HEADLESS_SECRET = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/i;
const HEADLESS_JOURNEY_FAILURE_CODES = new Set([
  "input_invalid",
  "plan_directory_invalid",
  "plan_directory_absent",
  "plan_directory_ambiguous",
  "selection_mismatch",
  "crewmate_unavailable",
  "adapter_failed",
  "session_unavailable",
  "cancelled",
  "interrupted",
  "token_budget",
  "result_missing",
  "result_malformed",
  "artifact_invalid",
  "focus_invalid",
  "focus_amendment_required",
  "completion_invalid",
  "fit_unavailable",
  "fit_malformed",
  "fit_undecidable",
] as const);
type HeadlessJourneyFailureCode = (typeof HEADLESS_JOURNEY_FAILURE_CODES extends ReadonlySet<infer Code> ? Code : never) | "failure_unavailable";

function headlessResponseCode(status: number): HeadlessJourneyReceipt["code"] {
  if (status === 400 || status === 413 || status === 422) return "input_invalid";
  if (status === 409) return "illegal_transition";
  if (status === 404) return "run_not_found";
  if (status === 503) return "transition_unavailable";
  return "repository_rejected";
}

function headlessJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function freshHeadlessRead(repository: string): Promise<boolean> {
  let repositoryPath: string;
  let isGitRoot: boolean;
  try {
    repositoryPath = await realpath(repository);
    if (!(await lstat(repositoryPath)).isDirectory()) return false;
    const git = await lstat(resolve(repositoryPath, ".git"));
    isGitRoot = git.isDirectory() || git.isFile();
    if (!isGitRoot || !(assessRepositorySafety({
      candidate: repositoryPath,
      isGitRoot,
      agentExecutableRealpaths: new RepositoryChoiceService().agentExecutableRealpaths(),
      ownerConfirmedNonGit: false,
    })).ok) return false;
    if ((await readdir(repositoryPath)).some((entry) => entry.startsWith(".bearing.tmp-"))) return false;
  } catch {
    return false;
  }
  try {
    await lstat(resolve(repositoryPath, ".bearing"));
    return false;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function invokeHeadlessHandler(
  handler: LocalRequestHandler,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<HeadlessResponse> {
  return new Promise((resolveResponse) => {
    const request = new EventEmitter() as IncomingMessage;
    Object.assign(request, { method, url: path, headers });
    let status = 200;
    const responseHeaders: Record<string, string | readonly string[]> = {};
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (chunk?: unknown) => {
      if (settled) return;
      settled = true;
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolveResponse({ status, body: Buffer.concat(chunks).toString("utf8"), headers: responseHeaders });
    };
    const response = {
      writeHead: (nextStatus: number, nextHeaders?: Record<string, string | number | readonly string[]>) => {
        status = nextStatus;
        for (const [name, value] of Object.entries(nextHeaders ?? {})) responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
        return response;
      },
      setHeader: (name: string, value: string | readonly string[]) => { responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value : value; },
      end: finish,
    };
    handler(request, response as unknown as ServerResponse);
    queueMicrotask(() => {
      if (body !== undefined) request.emit("data", Buffer.from(JSON.stringify(body)));
      request.emit("end");
    });
  });
}

function headlessFocusAmendmentRequired(run: Record<string, unknown> | undefined): boolean {
  if (!run || (run.status !== "failed" && run.status !== "stopped") || (run.stage !== "execute-explorer" && run.stage !== "execute-expedition")) return false;
  const lastResult = typeof run.lastResult === "object" && run.lastResult !== null && !Array.isArray(run.lastResult)
    ? run.lastResult as Record<string, unknown>
    : undefined;
  return lastResult?.status === "failure" && lastResult.code === "focus_amendment_required";
}

function headlessAllowedActions(
  run: Record<string, unknown> | undefined,
  pendingDecision: Record<string, unknown> | null | undefined,
  readinessReady: boolean,
): readonly HeadlessJourneyAction[] {
  if (!run) return ["create", "resume", "status"];
  if (run.status === "complete") return ["status"];
  if (!readinessReady) return ["status", "resume"];
  if (pendingDecision && typeof pendingDecision.decisionId === "string") {
    return pendingDecision.question === PLAN_REVIEW_QUESTION && run.planReviewAvailable === true
      ? ["status", "resume", "approve-route"]
      : pendingDecision.question === PLAN_REVIEW_QUESTION
        ? ["status", "resume"]
        : ["status", "resume", "decide"];
  }
  if (headlessFocusAmendmentRequired(run)) return ["status", "resume", "confirm-amendment"];
  if (run.status === "failed" || run.status === "stopped") return ["status", "resume", "progress"];
  return run.status === "waiting" && run.stage === "draft-implementation" && run.explorerAvailable === true
    ? ["status", "resume", "select-execution", "select-explorer"]
    : run.planReviewAvailable === true
      ? ["status", "resume", "approve-route"]
      : ["status", "resume", "progress"];
}

function headlessText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_HEADLESS_TEXT
    && value === value.trim()
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && !HEADLESS_SECRET.test(value);
}

function headlessArtifacts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const projected: string[] = [];
  const seen = new Set<string>();
  for (const artifact of value) {
    if (
      projected.length === MAX_HEADLESS_ARTIFACTS
      || !headlessText(artifact)
      || !repositoryRelativePlanDirectory(artifact)
      || seen.has(artifact)
    ) continue;
    seen.add(artifact);
    projected.push(artifact);
  }
  return projected;
}

function projectHeadlessReceipt(
  run: Record<string, unknown> | undefined,
  pendingDecision: Record<string, unknown> | null | undefined,
  readinessReady: boolean,
): Pick<HeadlessJourneyReceipt, "allowedActions" | "question" | "summary" | "artifacts" | "requiredOwnerAction" | "outcome"> {
  const allowedActions = headlessAllowedActions(run, pendingDecision, readinessReady);
  if (!run) return { allowedActions };
  const lastResult = typeof run.lastResult === "object" && run.lastResult !== null && !Array.isArray(run.lastResult)
    ? run.lastResult as Record<string, unknown>
    : undefined;
  const artifacts = headlessArtifacts(run.artifacts);
  const summary = lastResult?.status === "action" && headlessText(lastResult.summary) ? lastResult.summary : undefined;
  const question = typeof pendingDecision?.decisionId === "string"
    && headlessText(pendingDecision.question)
    && run.question === pendingDecision.question
    && pendingDecision.question !== PLAN_REVIEW_QUESTION
    ? pendingDecision.question
    : undefined;
  const routeApprovalRequired = readinessReady && run.planReviewAvailable === true
    && (pendingDecision === null || pendingDecision?.question === PLAN_REVIEW_QUESTION);
  const focusAmendmentRequired = readinessReady && pendingDecision === null && headlessFocusAmendmentRequired(run);
  const executionSelectionRequired = allowedActions.includes("select-execution");
  const status = run.status;
  const failureCode = lastResult?.status === "failure"
    && typeof lastResult.code === "string"
    && HEADLESS_JOURNEY_FAILURE_CODES.has(lastResult.code as never)
    ? lastResult.code as HeadlessJourneyFailureCode
    : "failure_unavailable";
  const outcome = status === "failed" || status === "stopped"
    ? { type: status, code: failureCode } as const
    : status === "running" || status === "waiting" || status === "complete"
      ? { type: status } as const
      : undefined;
  return {
    allowedActions,
    ...(question ? { question, requiredOwnerAction: { type: "answer" as const, question } } : {}),
    ...(summary ? { summary } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(routeApprovalRequired
      ? { requiredOwnerAction: { type: "approve-route" as const, prompt: PLAN_REVIEW_QUESTION, artifacts } }
      : {}),
    ...(executionSelectionRequired
      ? { requiredOwnerAction: { type: "select-execution" as const, modes: ["explorer", "expedition"] as const, reviewCadences: ["slice", "phase", "end"] as const } }
      : {}),
    ...(focusAmendmentRequired
      ? { requiredOwnerAction: { type: "confirm-amendment" as const, prompt: FOCUS_AMENDMENT_PROMPT } }
      : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** Execute one headless command through the authenticated browser transition layer. */
export async function executeHeadlessJourney(
  request: HeadlessJourneyRequest,
  deps: HeadlessJourneyDeps,
): Promise<HeadlessJourneyReceipt> {
  const readAction = request.action === "status" || request.action === "resume";
  if (readAction && await freshHeadlessRead(request.repository)) {
    return { ok: false, code: "run_not_found", runId: request.runId, revision: 0 };
  }
  const service = new LocalSessionService(HEADLESS_BOUND_HOST);
  const handler = createRequestHandler(service, undefined, {
    processRunner: deps.processRunner,
    ...(deps.routeInspection ? { routeInspection: deps.routeInspection } : {}),
  });
  const origin = `http://${HEADLESS_BOUND_HOST}`;
  const jsonHeaders = { host: HEADLESS_BOUND_HOST, origin, "content-type": "application/json" };
  const session = await invokeHeadlessHandler(handler, "POST", "/api/v1/session", jsonHeaders, { capability: service.capability });
  const setCookie = session.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (session.status !== 200 || typeof cookie !== "string") return { ok: false, code: "transition_unavailable", runId: request.runId, revision: 0 };
  const authenticated = { ...jsonHeaders, cookie: cookie.split(";", 1)[0]! };
  const repository = await invokeHeadlessHandler(handler, "POST", "/api/v1/repository", authenticated, { path: request.repository });
  if (repository.status !== 200) return { ok: false, code: headlessResponseCode(repository.status), runId: request.runId, revision: 0 };
  const repositoryState = headlessJson(repository.body);
  const firstLaunch = repositoryState?.status === "initialized"
    ? {
        disclosure: HEADLESS_WORKSPACE_DISCLOSURE,
        gitignoreMissing: repositoryState.gitignoreMissing === true,
      }
    : {};
  const readiness = await invokeHeadlessHandler(handler, "POST", "/api/v1/readiness", authenticated, {
    provider: request.provider,
    model: request.model,
    reasoning: request.reasoning,
  });
  const readinessReady = readiness.status === 200 && headlessJson(readiness.body)?.status === "ready";
  if (!readinessReady && !readAction) return { ok: false, code: "route_unavailable", runId: request.runId, revision: 0, ...firstLaunch };
  const readReadiness = readAction ? { readiness: readinessReady ? "ready" as const : "unavailable" as const } : {};

  const readRun = async () => {
    const response = await invokeHeadlessHandler(handler, "GET", `/api/v1/runs/${encodeURIComponent(request.runId)}`, { host: HEADLESS_BOUND_HOST, cookie: authenticated.cookie });
    const body = headlessJson(response.body);
    return { response, body, revision: typeof body?.revision === "number" ? body.revision : 0 };
  };
  const restore = () => invokeHeadlessHandler(handler, "GET", `/api/v1/journey/${encodeURIComponent(request.runId)}/status`, { host: HEADLESS_BOUND_HOST, cookie: authenticated.cookie });
  const command = async (type: "createWorkRequest" | "requireDecision" | "recordOwnerAnswer", payload: Record<string, unknown>) => {
    const current = await readRun();
    if (current.response.status !== 200) return current.response;
    const commandId = `headless-${randomToken(12)}`;
    return invokeHeadlessHandler(handler, "POST", `/api/v1/runs/${encodeURIComponent(request.runId)}/commands`, authenticated, {
      schemaVersion: 1,
      commandId,
      runId: request.runId,
      expectedRevision: current.revision,
      session: { sessionId: "headless", actor: "owner" },
      correlationId: commandId,
      type,
      payload,
    });
  };
  let operation: HeadlessResponse;
  if (request.action === "create") {
    if (!request.goal) return { ok: false, code: "input_invalid", runId: request.runId, revision: 0 };
    const created = await command("createWorkRequest", { title: request.goal.split(/\r?\n/, 1)[0]!.slice(0, 160), goal: request.goal });
    operation = created.status === 200
      ? await invokeHeadlessHandler(handler, "POST", "/api/v1/journey", authenticated, { runId: request.runId, stage: "repository-fit", workGoal: request.goal })
      : created;
  } else if (request.action === "resume" || request.action === "status") {
    const restored = await restore();
    operation = headlessJson(restored.body)?.run === undefined ? { status: 404, body: "", headers: {} } : restored;
  } else if (request.action === "decide") {
    const restored = await restore();
    const current = await readRun();
    const pending = typeof current.body?.pendingDecision === "object" && current.body.pendingDecision !== null && !Array.isArray(current.body.pendingDecision)
      ? current.body.pendingDecision as Record<string, unknown>
      : undefined;
    const restoredRunValue = headlessJson(restored.body)?.run;
    const restoredRun = typeof restoredRunValue === "object" && restoredRunValue !== null && !Array.isArray(restoredRunValue)
      ? restoredRunValue as Record<string, unknown>
      : undefined;
    const waitingStage = restoredRun?.status === "waiting"
      && typeof restoredRun.stage === "string"
      && RECORD_JOURNEY_CHECKPOINT_STAGES.includes(restoredRun.stage as JourneyStage)
      ? restoredRun.stage as JourneyStage
      : undefined;
    if (
      restored.status !== 200
      || !current.body
      || typeof pending?.decisionId !== "string"
      || typeof pending.question !== "string"
      || waitingStage === undefined
      || restoredRun?.question !== pending.question
    ) {
      operation = { status: 409, body: "", headers: {} };
    } else {
      const recorded = await command("recordOwnerAnswer", {
        decisionId: pending.decisionId,
        answer: request.answer,
      });
      operation = recorded.status === 200
        ? await invokeHeadlessHandler(handler, "POST", "/api/v1/journey", authenticated, {
          runId: request.runId,
          stage: waitingStage,
          answer: request.answer,
        })
        : recorded;
    }
  } else if (request.action === "approve-route") {
    const restored = headlessJson((await restore()).body)?.run;
    const reviewAvailable = typeof restored === "object"
      && restored !== null
      && !Array.isArray(restored)
      && (restored as Record<string, unknown>).planReviewAvailable === true;
    let current = await readRun();
    const pending = current.body?.pendingDecision;
    if (!reviewAvailable || !current.body || (pending !== null && (typeof pending !== "object" || (pending as Record<string, unknown>).question !== PLAN_REVIEW_QUESTION))) {
      operation = { status: 409, body: "", headers: {} };
    } else {
      if (pending === null) {
        const decisionId = `plan-review-${randomToken(12)}`;
        const required = await command("requireDecision", { decisionId, question: PLAN_REVIEW_QUESTION, consequential: true });
        if (required.status !== 200) {
          operation = required;
        } else {
          current = await readRun();
          const created = current.body?.pendingDecision;
          operation = !current.body || typeof created !== "object" || created === null || (created as Record<string, unknown>).question !== PLAN_REVIEW_QUESTION || typeof (created as Record<string, unknown>).decisionId !== "string"
            ? { status: 409, body: "", headers: {} }
            : await command("recordOwnerAnswer", { decisionId: (created as Record<string, unknown>).decisionId, answer: PLAN_REVIEW_APPROVAL });
        }
      } else {
        operation = await command("recordOwnerAnswer", { decisionId: (pending as Record<string, unknown>).decisionId, answer: PLAN_REVIEW_APPROVAL });
      }
    }
  } else if (request.action === "confirm-amendment") {
    const restored = headlessJson((await restore()).body)?.run;
    let current = await readRun();
    const restoredRun = typeof restored === "object" && restored !== null && !Array.isArray(restored)
      ? restored as Record<string, unknown>
      : undefined;
    const stage = restoredRun?.stage === "execute-explorer" || restoredRun?.stage === "execute-expedition"
      ? restoredRun.stage
      : undefined;
    if (stage === undefined || current.body?.pendingDecision !== null || !headlessFocusAmendmentRequired(restoredRun)) {
      operation = { status: 409, body: "", headers: {} };
    } else {
      const decisionId = `focus-amendment-${randomToken(12)}`;
      const required = await command("requireDecision", { decisionId, question: FOCUS_AMENDMENT_PROMPT, consequential: true });
      if (required.status !== 200) {
        operation = required;
      } else {
        current = await readRun();
        const pending = current.body?.pendingDecision;
        if (!current.body || typeof pending !== "object" || pending === null || (pending as Record<string, unknown>).decisionId !== decisionId || (pending as Record<string, unknown>).question !== FOCUS_AMENDMENT_PROMPT) {
          operation = { status: 409, body: "", headers: {} };
        } else {
          const answered = await command("recordOwnerAnswer", { decisionId, answer: FOCUS_AMENDMENT_APPROVAL });
          if (answered.status !== 200) {
            operation = answered;
          } else {
            current = await readRun();
            operation = !current.body || current.body.pendingDecision !== null
              ? { status: 409, body: "", headers: {} }
              : await invokeHeadlessHandler(handler, "POST", "/api/v1/journey", authenticated, {
                runId: request.runId,
                stage,
                executionMode: stage === "execute-explorer" ? "explorer" : "expedition",
                focusAmendmentConfirmed: true,
                focusAmendmentDecisionId: decisionId,
                focusAmendmentExpectedRevision: current.revision,
              });
          }
        }
      }
    }
  } else {
    const restored = headlessJson((await restore()).body)?.run;
    const restoredRun = typeof restored === "object" && restored !== null && !Array.isArray(restored)
      ? restored as Record<string, unknown>
      : undefined;
    const terminal = restoredRun?.status === "complete";
    const selection = request.action === "select-explorer" || request.action === "select-execution";
    const executionMode = request.action === "select-explorer" ? "explorer" : request.executionMode;
    const stage = selection && executionMode
      ? executionMode === "explorer" ? "execute-explorer" : "execute-expedition"
      : request.stage;
    operation = terminal || headlessFocusAmendmentRequired(restoredRun)
      ? { status: 409, body: "", headers: {} }
      : stage === undefined
        ? { status: 400, body: "", headers: {} }
      : await invokeHeadlessHandler(handler, "POST", "/api/v1/journey", authenticated, {
        runId: request.runId,
        stage,
        ...(selection ? { executionMode, reviewCadence: request.reviewCadence } : {}),
      });
  }
  const stateResponse = await restore();
  const state = headlessJson(stateResponse.body)?.run;
  const run = typeof state === "object" && state !== null && !Array.isArray(state) ? state as Record<string, unknown> : undefined;
  const durable = await readRun();
  const stage = typeof run?.stage === "string" && RECORD_JOURNEY_CHECKPOINT_STAGES.includes(run.stage as JourneyStage) ? run.stage as JourneyStage : undefined;
  const status = run?.status;
  return operation.status >= 200 && operation.status < 300
    ? {
        ok: true,
        runId: request.runId,
        revision: durable.revision,
        ...(stage ? { stage } : {}),
        ...(status === "running" || status === "waiting" || status === "stopped" || status === "failed" || status === "complete" ? { status } : {}),
        ...projectHeadlessReceipt(run, durable.body?.pendingDecision as Record<string, unknown> | null | undefined, readinessReady),
        ...firstLaunch,
        ...readReadiness,
      }
    : { ok: false, code: headlessResponseCode(operation.status), runId: request.runId, revision: durable.revision, ...firstLaunch, ...readReadiness };
}
