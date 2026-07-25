import { describe, expect, test } from 'bun:test';
import {
  SubagentDelegationClient,
  type SubagentEventBus,
} from '../src/integrations/subagents/client.ts';
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
} from '../src/integrations/subagents/protocol.ts';

describe('when testing subagent client', () => {
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
      for (const handler of [...(this.handlers.get(event) ?? [])])
        handler(data);
    }
  }

  function request(requestId: string): SubagentDelegationRequest {
    return {
      version: 1,
      requestId,
      agent: 'pi-workflows.step',
      task: 'Run one workflow step',
      context: 'fresh',
      cwd: '/tmp/project',
      timeoutMs: 5_000,
      skill: false,
      artifacts: false,
    };
  }

  describe('should satisfy its behavioral contract', () => {
    test('delegation client correlates the released v1 foreground response', async () => {
      // given
      const events = new FakeEventBus();
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
        const requestId = (data as { requestId: string }).requestId;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId: 'another-request',
          status: 'failed',
        });
        events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
          version: 1,
          requestId,
        });
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId,
          status: 'completed',
          agent: 'pi-workflows.step',
        });
      });

      const client = new SubagentDelegationClient(events);
      // when
      const response = await client.delegate(request('request-1'));
      // then
      expect(response.status).toBe('completed');
      expect(response.requestId).toBe('request-1');
      expect(client.activeRequestId).toBe(undefined);
    });

    test('cancelling an active delegation emits the versioned cancel event', async () => {
      // given
      const events = new FakeEventBus();
      events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
        const requestId = (data as { requestId: string }).requestId;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId,
          status: 'cancelled',
        });
      });
      const client = new SubagentDelegationClient(events);
      const pending = client.delegate(request('request-2'));
      // when
      const confirmed = await client.cancelActiveAndWait();

      // then
      expect((await pending).status).toBe('cancelled');
      expect(confirmed).toBe(true);
      expect(client.activeRequestId).toBe(undefined);
      expect(
        events.emitted.some(
          (entry) =>
            entry.event === SUBAGENT_DELEGATION_CANCEL_EVENT &&
            (entry.data as { requestId?: string }).requestId === 'request-2',
        ),
      ).toBe(true);
    });

    test('cancellation stays active until a terminal response arrives', async () => {
      // given
      const events = new FakeEventBus();
      const client = new SubagentDelegationClient(events);
      // when
      const pending = client.delegate(request('request-3'));

      // then
      expect(await client.cancelActiveAndWait(5)).toBe(false);
      expect(client.activeRequestId).toBe('request-3');

      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: 'request-3',
        status: 'cancelled',
      });
      expect((await pending).status).toBe('cancelled');
      expect(client.activeRequestId).toBe(undefined);
    });

    test('a local client timeout is not mistaken for child termination', async () => {
      // given
      const events = new FakeEventBus();
      const client = new SubagentDelegationClient(events);
      let lateTerminalStatus: string | undefined;
      const pending = client.delegate(request('request-4'), {
        startTimeoutMs: 5,
        onLateTerminal: (response) => {
          lateTerminalStatus = response.status;
        },
      });

      // The client's timeout is intentionally unref'd so it cannot keep Pi alive.
      // Keep this test process alive until that timeout has rejected the promise.
      // when
      const keepAlive = setInterval(() => undefined, 1_000);
      // then
      try {
        await expect(pending).rejects.toThrow(/did not accept/);
      } finally {
        clearInterval(keepAlive);
      }
      expect(await client.cancelActiveAndWait(15)).toBe(false);
      expect(client.activeRequestId).toBe('request-4');

      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: 'request-4',
        status: 'cancelled',
      });
      expect(lateTerminalStatus).toBe('cancelled');
      expect(client.activeRequestId).toBe(undefined);
    });

    test('rejects overlapping and pre-cancelled delegations', async () => {
      // given
      const events = new FakeEventBus();
      const client = new SubagentDelegationClient(events);
      const active = client.delegate(request('active'));
      const controller = new AbortController();
      controller.abort();

      // when
      const overlap = client.delegate(request('overlap'));
      const cancelled = new SubagentDelegationClient(
        new FakeEventBus(),
      ).delegate(request('cancelled'), { signal: controller.signal });

      // then
      await expect(overlap).rejects.toThrow(/still active/);
      await expect(cancelled).rejects.toThrow(/was cancelled/);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: 'active',
        status: 'completed',
      });
      await active;
      expect(await client.cancelActiveAndWait()).toBe(true);
    });

    test('forwards only valid correlated progress updates', async () => {
      // given
      const events = new FakeEventBus();
      const updates: unknown[] = [];
      const client = new SubagentDelegationClient(events);
      const pending = client.delegate(request('updates'), {
        onUpdate: (update) => updates.push(update),
      });

      // when
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, null);
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 2,
        requestId: 'updates',
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 1,
        requestId: 'other',
      });
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 1,
        requestId: 'updates',
        message: 'working',
      });
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: 'updates',
        status: 'completed',
      });

      // then
      expect(updates).toEqual([
        { version: 1, requestId: 'updates', message: 'working' },
      ]);
      await pending;
    });

    test('handles signal cancellation and the overall child deadline', async () => {
      // given
      const events = new FakeEventBus();
      const controller = new AbortController();
      const signalledClient = new SubagentDelegationClient(events);
      const signalled = signalledClient.delegate(request('signalled'), {
        signal: controller.signal,
      });

      // when
      controller.abort();

      // then
      await expect(signalled).rejects.toThrow(/was cancelled/);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: 'signalled',
        status: 'cancelled',
      });

      const deadlineEvents = new FakeEventBus();
      deadlineEvents.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
        deadlineEvents.emit(SUBAGENT_DELEGATION_STARTED_EVENT, data);
      });
      const deadlineClient = new SubagentDelegationClient(deadlineEvents);
      const deadlineRequest = {
        ...request('deadline'),
        timeoutMs: -4_999,
      };
      const keepAlive = setInterval(() => undefined, 100);
      try {
        await expect(deadlineClient.delegate(deadlineRequest)).rejects.toThrow(
          /before its deadline/,
        );
      } finally {
        clearInterval(keepAlive);
      }
      deadlineEvents.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: 'deadline',
        status: 'timed_out',
      });
      expect(deadlineClient.activeRequestId).toBe(undefined);
    });
  });
});
