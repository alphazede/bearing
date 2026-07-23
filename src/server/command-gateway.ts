import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCommandEnvelope, type CommandEnvelopeV1 } from "../contracts/run.js";
import { BearingStore, BearingStoreError } from "../store/bearing-store.js";
import { LocalSessionService, hasJsonContentType, readJsonBody, writeRejection } from "./local-session.js";
import type { SseProjection } from "./sse.js";

const MAX_COMMAND_BODY = 8 * 1024;

/** Authenticated HTTP-to-store adapter. It owns no state beyond its collaborators. */
export class CommandGateway {
  constructor(
    private readonly store: BearingStore,
    private readonly session: LocalSessionService,
    private readonly sse: SseProjection,
  ) {}

  read(req: IncomingMessage, res: ServerResponse, runId: string): void {
    if (!this.session.authenticateRequest(req)) return writeRejection(res, 401);
    this.store.load(runId).then((state) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        runId: state.runId,
        revision: state.revision,
        workRequestCreated: state.workRequestCreated,
        pendingDecision: state.pendingDecision,
        answersRecorded: state.events.filter((event) => event.type === "ownerAnswered").length,
        recommendation: state.executionRecommendation,
        approval: state.executionApproval,
      }));
    }, () => writeRejection(res, 503));
  }

  handle(req: IncomingMessage, res: ServerResponse, runId: string): void {
    if (!this.session.validOrigin(req.headers.origin)) return writeRejection(res, 403);
    if (!this.session.authenticateRequest(req)) return writeRejection(res, 401);
    if (!hasJsonContentType(req.headers["content-type"])) return writeRejection(res, 415);
    readJsonBody(req, MAX_COMMAND_BODY).then((body) => {
      const parsed = parseCommandEnvelope(body);
      const sessionId = this.session.ownerSessionId();
      if (!parsed.ok || parsed.value.runId !== runId || parsed.value.session.actor !== "owner" || sessionId === null) {
        writeRejection(res, 400);
        return;
      }
      const command = { ...parsed.value, session: { actor: "owner", sessionId } } as CommandEnvelopeV1;
      return this.store.apply(command).then((result) => {
        if (!result.ok) return writeRejection(res, result.reason === "stale_revision" || result.reason === "conflicting_duplicate" || result.reason === "pending_decision_blocks" || result.reason === "illegal_transition" || result.reason === "wrong_decision_id" ? 409 : 400);
        this.sse.publish(result.events);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ revision: result.state.revision }));
      });
    }).catch((error: unknown) => writeRejection(
      res,
      error instanceof BearingStoreError ? 503 : error instanceof RangeError ? 413 : 400,
    ));
  }
}
