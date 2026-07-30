import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  encodeChildPolicy,
  extractChildPolicy,
  isSafeStepCapabilityPath,
  isSafeStepResultPath,
  isSubagentRuntimeName,
  parseDelegatedStepResult,
  type ChildStepPolicy,
} from '../src/integrations/subagents/protocol.ts';

describe('when testing subagent protocol', () => {
  async function withPolicy(
    run: (policy: ChildStepPolicy) => Promise<void> | void,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
    const policy: ChildStepPolicy = {
      version: 1,
      requestId: 'request-1',
      agent: 'worker',
      workflowId: 'example',
      runId: 'run-1',
      stepId: 'inspect',
      stepTitle: 'Inspect',
      cwd: '/repository',
      policyDigest: 'a'.repeat(64),
      capabilityPath: join(directory, 'capability'),
      capabilityToken: 'c'.repeat(64),
      resultPath: join(directory, 'result.json'),
      permissions: {
        tools: ['read', 'bash'],
        mcp: ['gitlab/get_merge_request'],
        extensions: [],
        skills: ['planning'],
        bash: {
          mode: 'allow-list',
          allow: [{ executable: 'git', argsPrefix: ['status'] }],
        },
      },
      outcomes: ['ready', 'blocked', 'submit', 'bound'],
      pauseOutcomes: ['blocked'],
      summaryMaxChars: 500,
      gateSubmitOutcome: 'submit',
      workspace: {
        bindOn: ['bound'],
        allowedRoots: ['../worktrees'],
      },
    };
    try {
      await run(policy);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  describe('should satisfy its behavioral contract', () => {
    test('child policy envelope is removed before the subagent sees the task', async () => {
      // given
      // when
      // then
      await withPolicy((policy) => {
        const envelope = encodeChildPolicy(policy);
        const extracted = extractChildPolicy(
          `${envelope}\n\nInspect the merge request.`,
        );
        expect(extracted?.policy).toEqual(policy);
        expect(extracted?.task).toBe('Inspect the merge request.');
        const absoluteRootsPolicy = {
          ...policy,
          workspace: {
            bindOn: ['bound'],
            allowedRoots: ['/tmp/worktrees', '~/repositories/worktrees'],
          },
        };
        expect(
          extractChildPolicy(
            `${encodeChildPolicy(absoluteRootsPolicy)}\n\nInspect the workspace.`,
          )?.policy,
        ).toEqual(absoluteRootsPolicy);
        const upstreamWrapped = extractChildPolicy(
          `Task: ${envelope}\n\nInspect the merge request.`,
        );
        expect(upstreamWrapped?.policy).toEqual(policy);
        expect(upstreamWrapped?.task).toBe('Inspect the merge request.');
        const taskFilePath = join(tmpdir(), 'pi-subagent-long-task', 'task.md');
        const fileWrapped = extractChildPolicy(
          `<file name="${taskFilePath}">\nTask: ${envelope}\n\nInspect the merge request.\n</file>\n`,
        );
        expect(fileWrapped?.policy).toEqual(policy);
        expect(fileWrapped?.task).toBe('Inspect the merge request.');
        expect(
          extractChildPolicy(
            `<file name="${taskFilePath}">\nNot a delegated task.\n</file>\n`,
          ),
        ).toBe(undefined);
        expect(extractChildPolicy(`Explain this literal: ${envelope}`)).toBe(
          undefined,
        );
        expect(
          extractChildPolicy(
            `Fork context\n\nTask:\n${envelope}\n\nInspect the merge request.`,
          ),
        ).toBe(undefined);
        expect(
          extractChildPolicy(
            `<file name="${join(tmpdir(), 'task.md')}">\nTask: ${envelope}\n\nInspect the merge request.\n</file>\n`,
          ),
        ).toBe(undefined);
        expect(isSafeStepCapabilityPath(policy.capabilityPath)).toBe(true);
        expect(isSafeStepResultPath(policy.resultPath)).toBe(true);
        expect(isSafeStepResultPath(join(tmpdir(), 'result.json'))).toBe(false);

        const injectedDirectory = '/virtual-pi-temp/pi-workflows-step-injected';
        const injectedPolicy = {
          ...policy,
          capabilityPath: join(injectedDirectory, 'capability'),
          resultPath: join(injectedDirectory, 'result.json'),
        };
        const environment = {
          temporaryDirectory: () => '/virtual-pi-temp',
        };
        expect(
          isSafeStepCapabilityPath(injectedPolicy.capabilityPath, environment),
        ).toBe(true);
        expect(isSafeStepCapabilityPath(injectedPolicy.capabilityPath)).toBe(
          false,
        );
        expect(
          extractChildPolicy(
            `${encodeChildPolicy(injectedPolicy)}\n\nUse injected paths.`,
            environment,
          ),
        ).toEqual({
          policy: injectedPolicy,
          task: 'Use injected paths.',
        });
      });
    });

    test('delegated results are correlated and gate artifacts are required', async () => {
      // given
      // when
      // then
      await withPolicy((policy) => {
        expect(
          parseDelegatedStepResult(
            {
              version: 1,
              policyDigest: policy.policyDigest,
              outcome: 'ready',
              summary: '  inspected  ',
            },
            policy,
          ),
        ).toEqual({
          version: 1,
          policyDigest: policy.policyDigest,
          outcome: 'ready',
          summary: 'inspected',
        });
        expect(() =>
          parseDelegatedStepResult(
            {
              version: 1,
              policyDigest: policy.policyDigest,
              outcome: 'submit',
              summary: 'plan',
            },
            policy,
          ),
        ).toThrow(/requires a non-empty artifact/);
        expect(() =>
          parseDelegatedStepResult(
            {
              version: 1,
              policyDigest: 'b'.repeat(64),
              outcome: 'ready',
              summary: 'forged',
            },
            policy,
          ),
        ).toThrow(/does not match the active policy/);
        expect(() =>
          parseDelegatedStepResult(
            {
              version: 1,
              policyDigest: policy.policyDigest,
              outcome: 'ready',
              summary: '   ',
            },
            policy,
          ),
        ).toThrow(/must not be empty/);
        expect(
          parseDelegatedStepResult(
            {
              version: 1,
              policyDigest: policy.policyDigest,
              outcome: 'bound',
              summary: 'prepared',
              workspace: { cwd: '/tmp/worktree' },
            },
            policy,
          ),
        ).toEqual({
          version: 1,
          policyDigest: policy.policyDigest,
          outcome: 'bound',
          summary: 'prepared',
          workspace: { cwd: '/tmp/worktree' },
        });
        expect(() =>
          parseDelegatedStepResult(
            {
              version: 1,
              policyDigest: policy.policyDigest,
              outcome: 'bound',
              summary: 'prepared',
            },
            policy,
          ),
        ).toThrow(/requires workspace\.cwd/);
      });
    });

    test('rejects every malformed child policy boundary', async () => {
      // given
      await withPolicy(async (policy) => {
        const otherDirectory = await mkdtemp(
          join(tmpdir(), 'pi-workflows-step-'),
        );
        const extract = (value: unknown, task = 'Task') =>
          extractChildPolicy(
            `${encodeChildPolicy(value as ChildStepPolicy)}\n\n${task}`,
          );
        const invalid: Array<[unknown, RegExp]> = [
          [null, /must be an object/],
          [{ ...policy, extra: true }, /unknown property/],
          [{ ...policy, requestId: '' }, /requestId must be/],
          [{ ...policy, cwd: '' }, /cwd must be/],
          [{ ...policy, cwd: 'relative/path' }, /cwd must be an absolute path/],
          [{ ...policy, version: 2 }, /unsupported child policy version/],
          [{ ...policy, policyDigest: 'bad' }, /digest is invalid/],
          [{ ...policy, agent: 'Bad Agent' }, /runtime name/],
          [{ ...policy, capabilityToken: 'bad' }, /capability token/],
          [
            { ...policy, capabilityPath: join(tmpdir(), 'capability') },
            /capability path/,
          ],
          [
            { ...policy, resultPath: join(tmpdir(), 'result.json') },
            /result path/,
          ],
          [
            { ...policy, resultPath: join(otherDirectory, 'result.json') },
            /must share one temporary directory/,
          ],
          [{ ...policy, permissions: {} }, /permissions are invalid/],
          [{ ...policy, outcomes: [] }, /outcomes are invalid/],
          [
            { ...policy, pauseOutcomes: ['missing'] },
            /pause outcomes are invalid/,
          ],
          [{ ...policy, summaryMaxChars: 1 }, /summaryMaxChars/],
          [{ ...policy, gateSubmitOutcome: 'missing' }, /gate outcome/],
          [
            {
              ...policy,
              workspace: {
                bindOn: ['missing'],
                allowedRoots: ['../worktrees'],
              },
            },
            /workspace bindOn outcomes are invalid/,
          ],
          [
            {
              ...policy,
              workspace: {
                bindOn: ['bound'],
                allowedRoots: ['C:..\\outside'],
              },
            },
            /workspace allowed roots are invalid/,
          ],
          [
            {
              ...policy,
              workspace: {
                bindOn: ['bound'],
                allowedRoots: Array.from(
                  { length: 33 },
                  (_, index) => `../worktrees-${index}`,
                ),
              },
            },
            /workspace allowed roots are invalid/,
          ],
          [
            {
              ...policy,
              workspace: {
                bindOn: ['bound'],
                allowedRoots: ['../worktrees'],
                extra: true,
              },
            },
            /workspace is invalid/,
          ],
        ];

        // when
        const assertions = invalid.map(([value, message]) => () => {
          expect(() => extract(value)).toThrow(message);
        });

        // then
        for (const assertion of assertions) assertion();
        expect(() =>
          extractChildPolicy(
            '<pi-workflows-policy-v1>bad<pi-workflows-policy-v1></pi-workflows-policy-v1>Task',
          ),
        ).toThrow(/invalid child policy envelope/);
        expect(() =>
          extractChildPolicy(
            '<pi-workflows-policy-v1>%%%</pi-workflows-policy-v1>Task',
          ),
        ).toThrow(/cannot be decoded/);
        expect(() =>
          extractChildPolicy(`${encodeChildPolicy(policy)}   `),
        ).toThrow(/task is empty/);
        expect(isSubagentRuntimeName(undefined)).toBe(false);

        const allowListPolicy: ChildStepPolicy = {
          ...policy,
          permissions: {
            ...policy.permissions,
            bash: {
              mode: 'allow-list',
              allow: [{ executable: 'npm', argsPrefix: ['test'] }],
            },
          },
        };
        expect(extract(allowListPolicy)?.policy).toEqual(allowListPolicy);
        expect(() =>
          extract({
            ...allowListPolicy,
            permissions: {
              ...allowListPolicy.permissions,
              bash: {
                ...allowListPolicy.permissions.bash,
                approvedSources: ['verification-worker'],
              },
            },
          } as unknown as ChildStepPolicy),
        ).toThrow(/permissions are invalid/);
        expect(() =>
          extract({
            ...policy,
            repositoryCwd: join(tmpdir(), 'reviewed-repository'),
          } as unknown as ChildStepPolicy),
        ).toThrow(/unknown property "repositoryCwd"/);
        await rm(otherDirectory, { recursive: true, force: true });
      });
    });
  });
});
