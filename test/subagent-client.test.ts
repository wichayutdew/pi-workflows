import assert from "node:assert/strict";
import test from "node:test";
import {
  SubagentDelegationClient,
  type SubagentEventBus,
} from "../src/integrations/subagents/client.ts";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  type SubagentDelegationRequest,
} from "../src/integrations/subagents/protocol.ts";

class FakeEventBus implements SubagentEventBus {
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }
}

function request(requestId: string): SubagentDelegationRequest {
  return {
    version: 1,
    requestId,
    agent: "pi-workflows.step",
    task: "Run one workflow step",
    context: "fresh",
    cwd: "/tmp/project",
    timeoutMs: 5_000,
    skill: false,
    artifacts: false,
  };
}

test("delegation client correlates the released v1 foreground response", async () => {
  const events = new FakeEventBus();
  events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
    const requestId = (data as { requestId: string }).requestId;
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: "another-request",
      status: "failed",
    });
    events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
      version: 1,
      requestId,
    });
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId,
      status: "completed",
      agent: "pi-workflows.step",
    });
  });

  const client = new SubagentDelegationClient(events);
  const response = await client.delegate(request("request-1"));
  assert.equal(response.status, "completed");
  assert.equal(response.requestId, "request-1");
  assert.equal(client.activeRequestId, undefined);
});

test("cancelling an active delegation emits the versioned cancel event", async () => {
  const events = new FakeEventBus();
  events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
    const requestId = (data as { requestId: string }).requestId;
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId,
      status: "cancelled",
    });
  });
  const client = new SubagentDelegationClient(events);
  const pending = client.delegate(request("request-2"));
  const confirmed = await client.cancelActiveAndWait();

  assert.equal((await pending).status, "cancelled");
  assert.equal(confirmed, true);
  assert.equal(client.activeRequestId, undefined);
  assert.equal(
    events.emitted.some(
      (entry) =>
        entry.event === SUBAGENT_DELEGATION_CANCEL_EVENT &&
        (entry.data as { requestId?: string }).requestId === "request-2",
    ),
    true,
  );
});

test("cancellation stays active until a terminal response arrives", async () => {
  const events = new FakeEventBus();
  const client = new SubagentDelegationClient(events);
  const pending = client.delegate(request("request-3"));

  assert.equal(await client.cancelActiveAndWait(5), false);
  assert.equal(client.activeRequestId, "request-3");

  events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    version: 1,
    requestId: "request-3",
    status: "cancelled",
  });
  assert.equal((await pending).status, "cancelled");
  assert.equal(client.activeRequestId, undefined);
});

test("a local client timeout is not mistaken for child termination", async () => {
  const events = new FakeEventBus();
  const client = new SubagentDelegationClient(events);
  let lateTerminalStatus: string | undefined;
  const pending = client.delegate(request("request-4"), {
    startTimeoutMs: 5,
    onLateTerminal: (response) => {
      lateTerminalStatus = response.status;
    },
  });

  await assert.rejects(pending, /did not accept/);
  assert.equal(await client.cancelActiveAndWait(15), false);
  assert.equal(client.activeRequestId, "request-4");

  events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    version: 1,
    requestId: "request-4",
    status: "cancelled",
  });
  assert.equal(lateTerminalStatus, "cancelled");
  assert.equal(client.activeRequestId, undefined);
});
