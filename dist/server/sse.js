import { writeRejection } from "./local-session.js";
/** Persisted-event projection with per-client bounded backpressure. */
export class SseProjection {
    store;
    session;
    queueCap;
    clients = new Set();
    constructor(store, session, queueCap = 64) {
        this.store = store;
        this.session = session;
        this.queueCap = queueCap;
    }
    handle(req, res, runId) {
        if (!this.session.validOrigin(req.headers.origin))
            return writeRejection(res, 403);
        if (!this.session.authenticateRequest(req))
            return writeRejection(res, 401);
        const raw = req.headers["last-event-id"];
        if (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw))
            return writeRejection(res, 400);
        const after = typeof raw === "string" ? Number(raw) : 0;
        if (!Number.isSafeInteger(after))
            return writeRejection(res, 400);
        this.store.load(runId).then((state) => {
            const client = { res, runId, after, queue: [...state.events.filter((e) => e.runId === runId && e.sequence > after)], ready: false, paused: false, closed: false };
            this.clients.add(client);
            const remove = () => { client.closed = true; this.clients.delete(client); };
            req.on("close", remove);
            res.on("error", remove);
            res.on("drain", () => { client.paused = false; this.drain(client); });
            // A second durable read closes the load/subscribe window; queued live events are sorted below.
            this.store.load(runId).then((latest) => {
                this.enqueue(client, latest.events.filter((e) => e.sequence > after));
                client.ready = true;
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                this.drain(client);
            }, () => { remove(); writeRejection(res, 503); });
        }, () => writeRejection(res, 503));
    }
    publish(events) { for (const client of this.clients)
        this.enqueue(client, events); for (const client of this.clients)
        this.drain(client); }
    enqueue(client, events) {
        if (client.closed)
            return;
        for (const event of events)
            if (event.runId === client.runId && event.sequence > client.after && !client.queue.some((queued) => queued.sequence === event.sequence))
                client.queue.push(event);
        client.queue.sort((a, b) => a.sequence - b.sequence);
        if (client.queue.length > this.queueCap) {
            client.closed = true;
            this.clients.delete(client);
            client.res.end();
        }
    }
    drain(client) {
        if (!client.ready || client.paused || client.closed)
            return;
        while (client.queue.length) {
            const event = client.queue.shift();
            client.after = event.sequence;
            if (!client.res.write(`id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`)) {
                client.paused = true;
                return;
            }
        }
    }
}
