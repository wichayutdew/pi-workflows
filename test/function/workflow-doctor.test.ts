import { describe, expect, test } from 'bun:test';
import {
  analyzeWorkflow,
  formatWorkflowDoctor,
} from '../../src/function/doctor/workflow-doctor.ts';
import { baseWorkflow, loadedWorkflow } from '../helpers.ts';

describe('when diagnosing workflow liveness', () => {
  test('passes an acyclic workflow with a completion path', () => {
    const report = analyzeWorkflow(loadedWorkflow().definition);

    expect(report.issues).toEqual([]);
    expect(formatWorkflowDoctor([report])).toContain('Result: PASS');
  });

  test('reports completion traps, unreachable steps, and reachable cycles', () => {
    const raw = baseWorkflow();
    raw.start = 'loop';
    raw.steps = {
      loop: {
        prompt: 'Loop',
        transitions: { again: 'loop', escape: 'stranded' },
      },
      stranded: {
        prompt: 'Stranded',
        transitions: { stop: '$pause' },
      },
      unused: {
        prompt: 'Unused',
        transitions: { done: '$done' },
      },
    };

    const report = analyzeWorkflow(loadedWorkflow(raw).definition);

    expect(report.issues).toMatchObject([
      {
        level: 'error',
        code: 'no-completion-path',
        steps: ['loop'],
      },
      {
        level: 'error',
        code: 'reachable-step-cannot-reach-done',
        steps: ['loop', 'stranded'],
      },
      {
        level: 'warning',
        code: 'unreachable-steps',
        steps: ['unused'],
      },
      {
        level: 'warning',
        code: 'cycle',
        steps: ['loop'],
        reachable: true,
        canReachDone: false,
      },
    ]);
    expect(formatWorkflowDoctor([report])).toMatch(
      /maxStepVisits=3 bounds uninterrupted graph cycling/i,
    );
    expect(formatWorkflowDoctor([report])).toMatch(
      /human rejection back to the same gated step bypasses that check/i,
    );
  });

  test('warns about a bounded cycle that still has a completion path', () => {
    const raw = baseWorkflow();
    const steps = raw.steps as Record<string, Record<string, unknown>>;
    steps.inspect = {
      ...steps.inspect,
      transitions: {
        retry: 'inspect',
        ready: 'implement',
        blocked: '$pause',
      },
    };

    const report = analyzeWorkflow(loadedWorkflow(raw).definition);

    expect(report.issues).toMatchObject([
      {
        level: 'warning',
        code: 'cycle',
        steps: ['inspect'],
        reachable: true,
        canReachDone: true,
      },
    ]);
    expect(report.issues.some((issue) => issue.level === 'error')).toBe(false);
  });

  test('rejects a reachable trap even when another branch can complete', () => {
    const raw = baseWorkflow();
    raw.steps = {
      choose: {
        prompt: 'Choose',
        transitions: { good: 'finish', bad: 'trap' },
      },
      finish: {
        prompt: 'Finish',
        transitions: { done: '$done' },
      },
      trap: {
        prompt: 'Trap',
        transitions: { wait: '$pause' },
      },
    };
    raw.start = 'choose';

    const report = analyzeWorkflow(loadedWorkflow(raw).definition);

    expect(
      report.issues.some((issue) => issue.code === 'no-completion-path'),
    ).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        level: 'error',
        code: 'reachable-step-cannot-reach-done',
        steps: ['trap'],
      }),
    );
  });

  test('reports unreachable cycles deterministically without inventing a path', () => {
    const raw = baseWorkflow();
    raw.steps = {
      finish: {
        prompt: 'Finish',
        transitions: { done: '$done' },
      },
      zeta: {
        prompt: 'Zeta',
        transitions: { back: 'alpha' },
      },
      alpha: {
        prompt: 'Alpha',
        transitions: { forward: 'zeta' },
      },
    };
    raw.start = 'finish';

    const report = analyzeWorkflow(loadedWorkflow(raw).definition);
    const cycle = report.issues.find((issue) => issue.code === 'cycle');

    expect(cycle).toMatchObject({
      steps: ['alpha', 'zeta'],
      reachable: false,
      canReachDone: false,
    });
    expect(cycle?.message).toContain('cyclic component: alpha, zeta');
    expect(cycle?.message).not.toContain('alpha -> zeta');
  });

  test('is independent of step and transition declaration order', () => {
    const first = baseWorkflow();
    first.start = 'start';
    first.steps = {
      start: {
        prompt: 'Start',
        transitions: { retry: 'start', finish: 'finish' },
      },
      finish: {
        prompt: 'Finish',
        transitions: { done: '$done' },
      },
      unused: {
        prompt: 'Unused',
        transitions: { back: 'unused' },
      },
    };
    const reordered = baseWorkflow();
    reordered.start = 'start';
    reordered.steps = {
      unused: {
        prompt: 'Unused',
        transitions: { back: 'unused' },
      },
      finish: {
        prompt: 'Finish',
        transitions: { done: '$done' },
      },
      start: {
        prompt: 'Start',
        transitions: { finish: 'finish', retry: 'start' },
      },
    };

    expect(analyzeWorkflow(loadedWorkflow(first).definition)).toEqual(
      analyzeWorkflow(loadedWorkflow(reordered).definition),
    );
  });
});
