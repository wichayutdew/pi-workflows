import { describe, expect, test } from 'bun:test';
import { parseWorkflowStepResult } from '../../src/domain/index.ts';

describe('when testing step result', () => {
  const policy = {
    policyDigest: 'policy-1',
    outcomes: ['done', 'submit', 'bind'],
    summaryMaxChars: 1_000,
    gateSubmitOutcome: 'submit',
    workspace: {
      bindOn: ['bind'],
      allowedRoots: ['../worktrees'],
    },
  };
  const standardSummary =
    '# Done: Implementation is complete.\n**Completed:**\n- Implemented and verified `src/example.ts` with `bun test`.\n**Remaining:**\n- None; workflow is complete.';

  describe('should satisfy its behavioral contract', () => {
    test('normalizes valid workflow results and preserves an optional artifact', () => {
      const summary = standardSummary;

      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: ` ${summary} `,
            artifact: 'artifact',
          },
          policy,
        ),
      ).toEqual({
        version: 1,
        policyDigest: 'policy-1',
        outcome: 'done',
        summary,
        artifact: 'artifact',
      });
    });

    test('rejects non-actionable blocked and retry summaries', () => {
      const nonSuccessPolicy = {
        policyDigest: 'policy-1',
        outcomes: ['done', 'blocked', 'retry'],
        summaryMaxChars: 1_000,
      };

      const invalid: Array<[string, string, RegExp]> = [
        [
          'blocked',
          'error',
          /step summary must list specific completed and remaining work/,
        ],
        [
          'blocked',
          '# Blocked: Need input\n**Completed:**\n- Reviewed `docs/authorization.md`.\n**Remaining:**\n- Continue after the prerequisite is available.\n**Question:** Which authorization matrix applies?\n**Next:** resume.',
          /blocked summary must identify the missing user prerequisite and next action/,
        ],
        [
          'retry',
          '# Retry: Need requirements\n**Completed:**\n- Read `README.md`.\n**Remaining:**\n- Retry the transient operation.\n**Next:** provide details.',
          /retry summary must identify a transient failure and safe retry condition/,
        ],
      ];

      for (const [outcome, summary, message] of invalid) {
        expect(() =>
          parseWorkflowStepResult(
            { version: 1, policyDigest: 'policy-1', outcome, summary },
            nonSuccessPolicy,
          ),
        ).toThrow(message);
      }

      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'blocked',
            summary:
              '# Blocked: Missing authorization matrix.\n**Completed:**\n- Reviewed `docs/authorization.md`.\n**Remaining:**\n- Implement the endpoint policy after the matrix is supplied.\n**Question:** Which roles may access each endpoint?\n1. **Authorization policy** — no role matrix was supplied.\n   **Action:** Product owner must provide the endpoint authorization matrix.\n**Next:** Provide the authorization matrix and run `/workflow-resume`.',
          },
          nonSuccessPolicy,
        ),
      ).toMatchObject({ outcome: 'blocked' });
    });

    test('requires completed and remaining work on every outcome and a question when blocked', () => {
      const stopPolicy = {
        policyDigest: 'policy-1',
        outcomes: ['ready', 'done', 'blocked'],
        summaryMaxChars: 1_000,
      };
      const invalid: Array<[string, string, RegExp]> = [
        [
          'ready',
          'x',
          /step summary must list specific completed and remaining work/,
        ],
        [
          'ready',
          '# Ready: Research is complete\n**Completed:** Reviewed the approved scope.',
          /step summary must list specific completed and remaining work/,
        ],
        [
          'done',
          '# Done: Complete\n**Completed:** DUMMY\n**Remaining:** None; workflow is complete.',
          /step summary must list specific completed and remaining work/,
        ],
        [
          'blocked',
          '# Blocked: Need input\n**Completed:**\n- Reviewed `src/runtime/step-result.ts`.\n**Remaining:**\n- Continue after the decision.\n**Action:** Product owner must decide.\n**Next:** Resume after the decision.',
          /blocked summary must ask a clarifying question/,
        ],
      ];

      for (const [outcome, summary, message] of invalid) {
        expect(() =>
          parseWorkflowStepResult(
            { version: 1, policyDigest: 'policy-1', outcome, summary },
            stopPolicy,
          ),
        ).toThrow(message);
      }

      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'ready',
            summary:
              '# Ready: Research is complete.\n**Completed:**\n- Reviewed `src/runtime/step-result.ts` and collected source evidence.\n**Remaining:**\n- Reconcile the sources and write the final report.',
          },
          stopPolicy,
        ),
      ).toMatchObject({ outcome: 'ready' });
    });

    test('requires specific list items in stop reports', () => {
      const stopPolicy = {
        policyDigest: 'policy-1',
        outcomes: ['ready'],
        summaryMaxChars: 1_000,
      };

      for (const summary of [
        '# Ready: Research is complete.\n**Completed:**\n- Work done\n**Remaining:**\n- More work',
        '# Ready: Research is complete.\n**Completed:**\n- Reviewed `src/runtime/step-result.ts`.\n**Remaining:**\n- Continue work',
      ]) {
        expect(() =>
          parseWorkflowStepResult(
            {
              version: 1,
              policyDigest: 'policy-1',
              outcome: 'ready',
              summary,
            },
            stopPolicy,
          ),
        ).toThrow(
          /step summary must list specific completed and remaining work/,
        );
      }

      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'ready',
            summary:
              '# Ready: Research is complete.\n**Completed:**\n- Reviewed `src/runtime/step-result.ts` and identified missing ready validation.\n**Remaining:**\n- Add the ready-summary regression test and run `bun test`.',
          },
          stopPolicy,
        ),
      ).toMatchObject({ outcome: 'ready' });
    });

    test('rejects placeholder and incomplete handoff summaries', () => {
      const handoffPolicy = {
        policyDigest: 'policy-1',
        outcomes: ['handoff'],
        summaryMaxChars: 1_000,
      };
      const invalid = [
        'placeholder',
        'pplaceholder',
        'DUMMY',
        '# Handoff: Research paused\n**Completed:** Reviewed the approved scope.',
        '# Handoff: Research paused\n**Remaining:** Identify source evidence.',
        '# Handoff: Research paused\n**Completed:** dummy\n**Remaining:** Identify source evidence.',
        '# Handoff: Research paused\n**Completed:** Reviewed the approved scope.\n**Remaining:** placeholder',
      ];

      for (const summary of invalid) {
        expect(() =>
          parseWorkflowStepResult(
            {
              version: 1,
              policyDigest: 'policy-1',
              outcome: 'handoff',
              summary,
            },
            handoffPolicy,
          ),
        ).toThrow(
          /step summary must list specific completed and remaining work/,
        );
      }

      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'handoff',
            summary:
              '# Handoff: Research paused at the evidence review.\n**Completed:**\n- Reviewed `src/runtime/step-result.ts` and collected source evidence.\n**Remaining:**\n- Reconcile the sources and write the final report.',
          },
          handoffPolicy,
        ),
      ).toMatchObject({ outcome: 'handoff' });
    });

    test('requires semantic progress for checkpoint outcomes', () => {
      const checkpointPolicy = {
        policyDigest: 'policy-1',
        outcomes: ['checkpoint'],
        summaryMaxChars: 1_000,
      };
      const result = parseWorkflowStepResult(
        {
          version: 1,
          policyDigest: 'policy-1',
          outcome: 'checkpoint',
          summary: standardSummary,
          progress: {
            feature: 'auth feature',
            commit: 'abcdef1 implement auth feature',
            changedFiles: ['src/auth.ts'],
            verification: ['npm test auth: passed'],
            remaining: ['implement profile feature'],
          },
        },
        checkpointPolicy,
      );
      expect(result.progress?.feature).toBe('auth feature');
      expect(() =>
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'checkpoint',
            summary: standardSummary,
          },
          checkpointPolicy,
        ),
      ).toThrow(/checkpoint outcome requires progress/);
    });

    test('requires workspace cwd exactly on configured binding outcomes', () => {
      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: standardSummary,
            workspace: { cwd: '/tmp/worktree ' },
          },
          policy,
        ),
      ).toEqual({
        version: 1,
        policyDigest: 'policy-1',
        outcome: 'bind',
        summary: standardSummary,
        workspace: { cwd: '/tmp/worktree ' },
      });

      const invalid: Array<[unknown, RegExp]> = [
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: standardSummary,
          },
          /requires workspace\.cwd/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: standardSummary,
            workspace: { cwd: '/tmp/worktree' },
          },
          /workspace is forbidden/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: standardSummary,
            workspace: { cwd: 'relative/worktree' },
          },
          /must be an absolute path/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: standardSummary,
            workspace: { cwd: `/${'x'.repeat(4_096)}` },
          },
          /exceeds 4096 characters/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: standardSummary,
            workspace: { cwd: '/tmp/worktree', extra: true },
          },
          /workspace has unknown property/,
        ],
      ];
      for (const [value, message] of invalid) {
        expect(() => parseWorkflowStepResult(value, policy)).toThrow(message);
      }
    });

    test('rejects malformed workflow results', () => {
      // given
      // when
      const invalid: Array<[unknown, string]> = [
        [null, 'must be an object'],
        [{ extra: true }, 'unknown property'],
        [{ version: 2 }, 'unsupported'],
        [{ version: 1, policyDigest: 'wrong' }, 'does not match'],
        [
          { version: 1, policyDigest: 'policy-1', outcome: 'nope' },
          'invalid outcome',
        ],
        [
          { version: 1, policyDigest: 'policy-1', outcome: 'done', summary: 1 },
          'must be a string',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: '   ',
          },
          'must not be empty',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: 'too long',
          },
          'step summary must list specific completed and remaining work',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: standardSummary,
            artifact: 1,
          },
          'artifact must be a string',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'submit',
            summary: standardSummary,
          },
          'requires a non-empty artifact',
        ],
      ];

      // then
      for (const [value, message] of invalid) {
        expect(() => parseWorkflowStepResult(value, policy)).toThrow(
          new RegExp(message),
        );
      }
      expect(() =>
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: standardSummary,
            artifact: 'x'.repeat(200_001),
          },
          policy,
        ),
      ).toThrow(/exceeds 200000/);
    });
  });
});
