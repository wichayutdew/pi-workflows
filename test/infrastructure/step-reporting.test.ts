import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { advanceRun, failRun } from '../../src/function/engine/index.ts';
import { createRun, type WorkflowRun } from '../../src/domain/index.ts';
import {
  conciseStepFailureSummary,
  MAX_POSTED_STEP_FAILURE_CHARS,
  reportFailedStep,
  reportPausedStep,
  reportSettledStep,
  WORKFLOW_STEP_SUMMARY_MESSAGE_TYPE,
} from '../../src/infrastructure/harness/step-reporting.ts';
import { loadedWorkflow } from '../helpers.ts';

type SentMessage = {
  readonly message: {
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
    readonly details?: unknown;
  };
  readonly options?: {
    readonly triggerTurn?: boolean;
  };
};

function reportingApi(
  messages: Array<SentMessage>,
  shouldThrow = false,
): ExtensionAPI {
  return {
    sendMessage: (
      message: SentMessage['message'],
      options?: SentMessage['options'],
    ) => {
      if (shouldThrow) throw new Error('message channel unavailable');
      messages.push({
        message,
        ...(options ? { options } : {}),
      });
    },
  } as unknown as ExtensionAPI;
}

describe('when reporting workflow step summaries', () => {
  test('posts only the accepted summary and marks the final workflow complete', () => {
    const workflow = loadedWorkflow();
    let run = advanceRun(
      workflow,
      createRun(workflow, 'request', ['read'], 'run-1', 1),
      'ready',
      'Inspection complete',
      2,
    );
    run = advanceRun(workflow, run, 'done', 'Implementation complete', 3);
    const messages: Array<SentMessage> = [];

    reportSettledStep(reportingApi(messages), workflow, run, {
      stepId: 'implement',
      outcome: 'done',
      summary: 'Implementation complete',
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message: {
        customType: WORKFLOW_STEP_SUMMARY_MESSAGE_TYPE,
        display: true,
        details: {
          workflowId: 'example',
          runId: 'run-1',
          stepId: 'implement',
          status: 'completed',
          outcome: 'done',
          workflowCompleted: true,
        },
      },
      options: { triggerTurn: false },
    });
    expect(messages[0]?.message.content).toContain('Implementation complete');
    expect(messages[0]?.message.content).toContain(
      'Workflow `example` completed.',
    );
    expect(messages[0]?.message.content).not.toContain('Inspection complete');
  });

  test('shows submitted pause summaries and explicit pause reasons', () => {
    const workflow = loadedWorkflow();
    const paused = advanceRun(
      workflow,
      createRun(workflow, 'request', ['read'], 'run-1', 1),
      'blocked',
      'Waiting for a user decision',
      2,
    );
    const messages: Array<SentMessage> = [];
    const pi = reportingApi(messages);

    reportSettledStep(pi, workflow, paused, {
      stepId: 'inspect',
      outcome: 'blocked',
      summary: 'Waiting for a user decision',
    });
    reportPausedStep(pi, workflow, paused, 'Workflow paused by the user');

    expect(messages.map(({ message }) => message.details)).toMatchObject([
      { status: 'paused', outcome: 'blocked' },
      { status: 'paused' },
    ]);
    expect(messages[0]?.message.content).toContain(
      'Waiting for a user decision',
    );
    expect(messages[1]?.message.content).toContain(
      'Workflow paused by the user',
    );
  });

  test('posts a bounded redacted failure reason without execution history', () => {
    const workflow = loadedWorkflow();
    const detailedRun = {
      ...failRun(
        createRun(workflow, 'request', ['read'], 'run-1', 1),
        'full checkpoint diagnostic',
        2,
      ),
      currentStepAttempts: [
        {
          kind: 'main' as const,
          requestId: 'request-1',
          task: 'UNWANTED TASK BODY',
          log: ['UNWANTED ACTION HISTORY'],
          startedAt: 1,
        },
      ],
    } satisfies WorkflowRun;
    const messages: Array<SentMessage> = [];
    const failure =
      'Validation failed. authorization: Bearer top-secret ' +
      'x'.repeat(MAX_POSTED_STEP_FAILURE_CHARS * 2) +
      ' UNWANTED FAILURE TAIL';

    reportFailedStep(reportingApi(messages), workflow, detailedRun, failure);

    const content = messages[0]?.message.content ?? '';
    expect(content).toContain('Validation failed.');
    expect(content).toContain('authorization=[redacted]');
    expect(content).toContain('…');
    expect(content).not.toContain('top-secret');
    expect(content).not.toContain('UNWANTED FAILURE TAIL');
    expect(content).not.toContain('UNWANTED TASK BODY');
    expect(content).not.toContain('UNWANTED ACTION HISTORY');
    expect(messages[0]?.message.details).toMatchObject({
      status: 'failed',
      workflowCompleted: false,
    });
    expect(conciseStepFailureSummary(failure)).toBe(
      content.split('\n\n').slice(1, -1).join('\n\n'),
    );
  });

  test('does not let a reporting failure block workflow settlement', () => {
    const workflow = loadedWorkflow();
    const run = advanceRun(
      workflow,
      createRun(workflow, 'request', ['read'], 'run-1', 1),
      'blocked',
      'Pause safely',
      2,
    );

    expect(() =>
      reportPausedStep(reportingApi([], true), workflow, run, 'Pause safely'),
    ).not.toThrow();
  });
});
