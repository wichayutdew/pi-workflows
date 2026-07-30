import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { checkWorkflowAgainstCeiling } from '../src/config/ceiling.ts';
import {
  defaultUserWorkflowDirectory,
  loadCatalog,
} from '../src/config/load.ts';
import {
  cloneEmptyRequirements,
  validateSettings,
  validateWorkflow,
} from '../src/config/validate.ts';
import { baseWorkflow } from './helpers.ts';

describe('when testing config', () => {
  function projectSubagentCeiling() {
    return {
      agents: ['pi-workflows.step'],
      contexts: ['fresh'],
      models: [],
      maxTimeoutMs: 60_000,
      maxTurns: 10,
      maxGraceTurns: 1,
      maxToolCalls: 20,
      artifacts: false,
      retryToolFailures: false,
    };
  }

  function workspaceWorkflow(
    allowedRoots?: ReadonlyArray<string>,
  ): Record<string, unknown> {
    const raw = baseWorkflow();
    const steps = raw.steps as Record<string, Record<string, unknown>>;
    steps.inspect = {
      ...steps.inspect,
      subagent: { agent: 'workspace-preparer' },
      workspace: {
        bindOn: ['ready'],
        ...(allowedRoots ? { allowedRoots } : {}),
      },
    };
    steps.implement = {
      ...steps.implement,
      subagent: { agent: 'worker' },
    };
    return raw;
  }

  describe('should satisfy its behavioral contract', () => {
    test('validates a declarative workflow graph', () => {
      // given
      // when
      const result = validateWorkflow(baseWorkflow());
      // then
      expect(result.errors).toEqual([]);
      expect(result.value?.start).toBe('inspect');
      expect(result.value?.steps.inspect?.permissions.bash.mode).toBe(
        'allow-list',
      );
      expect(result.value?.steps.inspect?.subagent).toBe(undefined);
    });

    test('validates one-time workspace binding and permits delegated downstream cycles', () => {
      const withDefaultRoot = workspaceWorkflow();
      const defaultSteps = withDefaultRoot.steps as Record<
        string,
        Record<string, unknown>
      >;
      defaultSteps.implement = {
        ...defaultSteps.implement,
        transitions: { retry: 'inspect', done: '$done' },
      };

      const defaultResult = validateWorkflow(withDefaultRoot);
      expect(defaultResult.errors).toEqual([]);
      expect(defaultResult.value?.steps.inspect?.workspace).toEqual({
        bindOn: ['ready'],
        allowedRoots: ['.'],
      });

      const withSiblingRoot = validateWorkflow(
        workspaceWorkflow(['../worktrees', '.worktrees']),
      );
      expect(withSiblingRoot.errors).toEqual([]);
      expect(
        withSiblingRoot.value?.steps.inspect?.workspace?.allowedRoots,
      ).toEqual(['../worktrees', '.worktrees']);

      const withAbsoluteRoots = validateWorkflow(
        workspaceWorkflow(['/tmp/worktrees', '~/repositories/worktrees']),
      );
      expect(withAbsoluteRoots.errors).toEqual([]);
    });

    test('rejects malformed or unsafe workspace-binding graphs', () => {
      const malformed = workspaceWorkflow([]);
      const malformedSteps = malformed.steps as Record<
        string,
        Record<string, unknown>
      >;
      malformedSteps.inspect = {
        ...malformedSteps.inspect,
        workspace: {
          bindOn: ['missing', 'missing'],
          allowedRoots: [],
          unexpected: true,
        },
      };

      const malformedRootBounds = [
        workspaceWorkflow([' ../worktrees']),
        workspaceWorkflow(['C:..\\outside']),
        workspaceWorkflow(['x'.repeat(4_097)]),
        workspaceWorkflow(
          Array.from({ length: 33 }, (_, index) => `../worktrees-${index}`),
        ),
      ];
      const mainBinder = workspaceWorkflow();
      const mainBinderSteps = mainBinder.steps as Record<
        string,
        Record<string, unknown>
      >;
      delete mainBinderSteps.inspect?.subagent;

      const terminalBinder = workspaceWorkflow();
      const terminalSteps = terminalBinder.steps as Record<
        string,
        Record<string, unknown>
      >;
      terminalSteps.inspect = {
        ...terminalSteps.inspect,
        transitions: { ready: '$done' },
      };

      const gatedBinder = workspaceWorkflow();
      const gatedSteps = gatedBinder.steps as Record<
        string,
        Record<string, unknown>
      >;
      gatedSteps.inspect = {
        ...gatedSteps.inspect,
        gate: {
          submitOutcome: 'submit',
          approvedOutcome: 'ready',
          rejectedOutcome: 'blocked',
        },
        transitions: { ready: 'implement', blocked: '$pause' },
      };

      const downstreamMain = workspaceWorkflow();
      const downstreamSteps = downstreamMain.steps as Record<
        string,
        Record<string, unknown>
      >;
      delete downstreamSteps.implement?.subagent;

      const multipleBinders = workspaceWorkflow();
      const multipleSteps = multipleBinders.steps as Record<
        string,
        Record<string, unknown>
      >;
      multipleSteps.implement = {
        ...multipleSteps.implement,
        transitions: { done: 'finish' },
        workspace: { bindOn: ['done'] },
      };
      multipleSteps.finish = {
        prompt: 'Finish',
        subagent: { agent: 'finisher' },
        transitions: { done: '$done' },
      };

      const messages = [
        validateWorkflow(malformed),
        ...malformedRootBounds.map((raw) => validateWorkflow(raw)),
        validateWorkflow(mainBinder),
        validateWorkflow(terminalBinder),
        validateWorkflow(gatedBinder),
        validateWorkflow(downstreamMain),
        validateWorkflow(multipleBinders),
      ]
        .flatMap(({ errors }) => errors)
        .join('\n');

      expect(messages).toMatch(/unknown property "unexpected"/);
      expect(messages).toMatch(/duplicate value "missing"/);
      expect(messages).toMatch(/unknown transition outcome "missing"/);
      expect(messages).toMatch(/at least one workspace path is required/);
      expect(messages).toMatch(
        /expected a relative, absolute, or home-relative path/,
      );
      expect(messages).toMatch(/expected a non-empty workspace path/);
      expect(messages).toMatch(/path exceeds 4096 characters/);
      expect(messages).toMatch(/at most 32 workspace paths are allowed/);
      expect(messages).toMatch(/workspace binding requires a subagent/);
      expect(messages).toMatch(
        /workspace-binding outcome must target an ordinary step/,
      );
      expect(messages).toMatch(
        /workspace binding is not allowed on a gated step/,
      );
      expect(messages).toMatch(
        /reachable after workspace binding must use a subagent/,
      );
      expect(messages).toMatch(/only one workspace-binding step is allowed/);
    });

    test('validates per-step subagent model and execution budgets', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = {
        ...steps.inspect,
        subagent: {
          agent: 'worker',
          context: 'fresh',
          model: 'anthropic/claude-sonnet-4',
          timeoutMs: 120_000,
          turnBudget: { maxTurns: 12, graceTurns: 2 },
          toolBudget: { soft: 20, hard: 30, block: '*' },
          artifacts: true,
          retryToolFailures: true,
        },
      };
      // when
      const result = validateWorkflow(raw);
      // then
      expect(result.errors).toEqual([]);
      expect(result.value?.steps.inspect?.subagent).toEqual({
        agent: 'worker',
        context: 'fresh',
        model: 'anthropic/claude-sonnet-4',
        timeoutMs: 120_000,
        turnBudget: { maxTurns: 12, graceTurns: 2 },
        toolBudget: { soft: 20, hard: 30, block: '*' },
        artifacts: true,
        retryToolFailures: true,
      });

      const invalid = baseWorkflow();
      const invalidSteps = invalid.steps as Record<
        string,
        Record<string, unknown>
      >;
      invalidSteps.inspect = {
        ...invalidSteps.inspect,
        subagent: {
          agent: 'Reviewer!',
          context: 'shared',
          toolBudget: { soft: 10, hard: 5 },
          retryToolFailures: 'yes',
        },
      };
      const invalidResult = validateWorkflow(invalid);
      expect(invalidResult.errors.join('\n')).toMatch(
        /agent: invalid value "Reviewer!"/,
      );
      expect(invalidResult.errors.join('\n')).toMatch(/expected fresh/);
      expect(invalidResult.errors.join('\n')).toMatch(
        /soft: must not exceed hard/,
      );
      expect(invalidResult.errors.join('\n')).toMatch(
        /retryToolFailures: expected a boolean/,
      );

      const mutationCapableRecovery = baseWorkflow();
      const mutationCapableRecoverySteps =
        mutationCapableRecovery.steps as Record<
          string,
          Record<string, unknown>
        >;
      mutationCapableRecoverySteps.inspect = {
        ...mutationCapableRecoverySteps.inspect,
        subagent: { retryToolFailures: true },
        permissions: {
          tools: ['read', 'bash', 'edit'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['status'] }],
          },
        },
      };
      expect(validateWorkflow(mutationCapableRecovery).errors).toEqual([]);

      const defaults = baseWorkflow();
      const defaultSteps = defaults.steps as Record<
        string,
        Record<string, unknown>
      >;
      defaultSteps.inspect = { ...defaultSteps.inspect, subagent: {} };
      const defaultResult = validateWorkflow(defaults);
      expect(defaultResult.errors).toEqual([]);
      expect(defaultResult.value?.steps.inspect?.subagent).toEqual({
        agent: 'pi-workflows.step',
        context: 'fresh',
        timeoutMs: 900_000,
        artifacts: false,
        retryToolFailures: false,
      });

      const named = baseWorkflow();
      const namedSteps = named.steps as Record<string, Record<string, unknown>>;
      namedSteps.inspect = {
        ...namedSteps.inspect,
        subagent: 'reviewer',
      };
      const namedResult = validateWorkflow(named);
      expect(namedResult.errors).toEqual([]);
      expect(namedResult.value?.steps.inspect?.subagent).toEqual({
        agent: 'reviewer',
        context: 'fresh',
        timeoutMs: 900_000,
        artifacts: false,
        retryToolFailures: false,
      });

      const invalidName = baseWorkflow();
      const invalidNameSteps = invalidName.steps as Record<
        string,
        Record<string, unknown>
      >;
      invalidNameSteps.inspect = {
        ...invalidNameSteps.inspect,
        subagent: 'Reviewer!',
      };
      expect(validateWorkflow(invalidName).errors.join('\n')).toMatch(
        /subagent: invalid value "Reviewer!"/,
      );
    });

    test('keeps Bash authority entirely declarative in the workflow', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = {
        ...steps.inspect,
        permissions: {
          tools: ['read', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'npm', argsPrefix: ['test'] }],
            approvedSources: ['verification-worker'],
            handoffSources: ['verification-worker', 'verification-reviewer'],
          },
        },
      };
      // when
      const result = validateWorkflow(raw);
      // then
      expect(result.errors.join('\n')).toMatch(
        /unknown property "approvedSources"[\s\S]*unknown property "handoffSources"/,
      );

      const valid = structuredClone(raw);
      const validSteps = valid.steps as Record<string, Record<string, unknown>>;
      validSteps.inspect = {
        ...validSteps.inspect,
        permissions: {
          tools: ['read', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'npm', argsPrefix: ['test'] }],
          },
        },
      };
      expect(
        validateWorkflow(valid).value?.steps.inspect?.permissions.bash,
      ).toEqual({
        mode: 'allow-list',
        allow: [{ executable: 'npm', argsPrefix: ['test'] }],
      });
    });

    test('expands compact Bash argument-prefix alternatives', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = {
        ...steps.inspect,
        permissions: {
          tools: ['read', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [
              {
                executable: 'git',
                argsPrefixes: [['status'], ['diff'], ['show', '--stat']],
              },
            ],
          },
        },
      };

      // when
      const result = validateWorkflow(raw);
      // then
      expect(result.errors).toEqual([]);
      expect(result.value?.steps.inspect?.permissions.bash.allow).toEqual([
        { executable: 'git', argsPrefix: ['status'] },
        { executable: 'git', argsPrefix: ['diff'] },
        { executable: 'git', argsPrefix: ['show', '--stat'] },
      ]);

      const ambiguous = structuredClone(raw);
      const ambiguousSteps = ambiguous.steps as Record<
        string,
        Record<string, unknown>
      >;
      const permissions = ambiguousSteps.inspect?.permissions as Record<
        string,
        unknown
      >;
      const bash = permissions.bash as Record<string, unknown>;
      bash.allow = [
        {
          executable: 'git',
          argsPrefix: ['status'],
          argsPrefixes: [['diff']],
        },
      ];
      expect(validateWorkflow(ambiguous).errors.join('\n')).toMatch(
        /argsPrefix and argsPrefixes are mutually exclusive/,
      );

      const malformed = structuredClone(raw);
      const malformedSteps = malformed.steps as Record<
        string,
        Record<string, unknown>
      >;
      const malformedPermissions = malformedSteps.inspect
        ?.permissions as Record<string, unknown>;
      const malformedBash = malformedPermissions.bash as Record<
        string,
        unknown
      >;
      malformedBash.allow = [
        {
          executable: 'git',
          argsPrefixes: [[], ['status'], ['status']],
        },
      ];
      const malformedErrors = validateWorkflow(malformed).errors.join('\n');
      expect(malformedErrors).toMatch(/at least one argument is required/);
      expect(malformedErrors).toMatch(/duplicate argument prefix/);

      const settings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['bash'],
          bash: {
            mode: 'allow-list',
            allow: [
              {
                executable: 'git',
                argsPrefixes: [['status'], ['diff']],
              },
            ],
          },
          subagent: projectSubagentCeiling(),
        },
      });
      expect(settings.errors).toEqual([]);
      expect(settings.value?.permissionCeiling?.bash.allow).toEqual([
        { executable: 'git', argsPrefix: ['status'] },
        { executable: 'git', argsPrefix: ['diff'] },
      ]);
    });

    test('rejects unknown properties and transition targets', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = {
        ...steps.inspect,
        typo: true,
        transitions: { ready: 'missing' },
      };
      // when
      const result = validateWorkflow(raw);
      // then
      expect(result.value).toBe(undefined);
      expect(result.errors.join('\n')).toMatch(/unknown property "typo"/);
      expect(result.errors.join('\n')).toMatch(/unknown target "missing"/);
    });

    test('rejects a non-string schema hint', () => {
      // given
      // when
      const result = validateWorkflow({ ...baseWorkflow(), $schema: 42 });
      // then
      expect(result.errors.join('\n')).toMatch(
        /workflow\.\$schema: expected a string/,
      );
    });

    test('rejects malformed workflow fields at every validation boundary', () => {
      // given
      const withStep = (
        step: Record<string, unknown>,
        workflow: Record<string, unknown> = {},
      ) => {
        const raw = baseWorkflow();
        const inspect = (raw.steps as Record<string, Record<string, unknown>>)
          .inspect!;
        return {
          ...raw,
          ...workflow,
          steps: { inspect: { ...inspect, ...step } },
        };
      };
      const malformed: unknown[] = [
        null,
        {
          ...baseWorkflow(),
          $schema: 42,
          version: 2,
          id: 42,
          command: 'Invalid!',
          description: ' ',
          start: 'missing',
          maxStepVisits: 0,
          summaryMaxChars: 'many',
          steps: { 'Invalid!': {} },
          unexpected: true,
        },
        { ...baseWorkflow(), steps: null },
        { ...baseWorkflow(), steps: { inspect: null } },
        withStep({
          title: ' ',
          prompt: 42,
          subagent: 42,
          permissions: 42,
          requires: 42,
          transitions: 42,
          gate: 42,
          unexpected: true,
        }),
        withStep({ prompt: { file: '/absolute.md' } }),
        withStep({ transitions: { 'Invalid!': '$done' } }),
        withStep({
          gate: {
            provider: 'prompt',
            submitOutcome: 'submit',
            approvedOutcome: 'same',
            rejectedOutcome: 'same',
            timeoutMs: 1_000,
          },
          transitions: { same: '$done' },
        }),
        withStep({
          gate: {
            submitOutcome: 'submit',
            approvedOutcome: 'ready',
            rejectedOutcome: 'blocked',
          },
          transitions: { submit: '$done' },
        }),
        withStep({
          permissions: {
            tools: 'read',
            mcp: ['server', 'server'],
            extensions: 42,
            skills: [' '],
            bash: 42,
          },
        }),
        withStep({
          permissions: {
            tools: [],
            bash: {
              mode: 42,
              allow: 'commands',
              approvedSources: 'verification-worker',
            },
          },
        }),
        withStep({
          permissions: {
            tools: ['bash'],
            bash: {
              mode: 'read-only',
              allow: [{ executable: 'git', argsPrefix: ['status'] }],
              approvedSources: ['verification-worker'],
            },
          },
        }),
        withStep({
          permissions: {
            tools: ['bash'],
            bash: { mode: 'allow-list', allow: [] },
          },
        }),
        withStep({
          permissions: {
            tools: [],
            bash: { mode: 'read-only' },
          },
        }),
        withStep({
          permissions: {
            tools: ['bash'],
            bash: {
              mode: 'allow-list',
              approvedSources: ['invalid-source'],
              allow: [
                null,
                { executable: '', argsPrefixes: 'status' },
                { executable: '', argsPrefixes: [['status']] },
                { executable: 'git', argsPrefixes: [] },
                { executable: 'git', argsPrefix: 'status' },
              ],
            },
          },
        }),
        withStep({
          permissions: { tools: ['read'] },
          requires: {
            tools: ['write', 'mcp'],
            extensions: ['annotator'],
            skills: ['planning'],
          },
        }),
        withStep({
          subagent: {
            agent: '',
            context: 42,
            model: 'invalid model',
            timeoutMs: 0,
            turnBudget: 42,
            toolBudget: 42,
            artifacts: 'yes',
          },
        }),
        withStep({
          subagent: {
            turnBudget: { maxTurns: 0, graceTurns: 101 },
            toolBudget: { hard: 0, soft: 100_001, block: [] },
          },
        }),
      ];

      // when
      const errors = malformed.map((raw) => validateWorkflow(raw).errors);
      const validPrefix = validateWorkflow(
        withStep({
          permissions: {
            tools: ['read', 'bash'],
            bash: {
              mode: 'allow-list',
              allow: [{ executable: 'git', argsPrefix: ['status'] }],
            },
          },
          transitions: { done: '$done' },
        }),
      );

      // then
      expect(errors.every((items) => items.length > 0)).toBe(true);
      expect(errors.flat().join('\n')).toMatch(/expected an object/);
      expect(errors.flat().join('\n')).toMatch(/must not be empty/);
      expect(errors.flat().join('\n')).toMatch(/required tool "write"/);
      expect(errors.flat().join('\n')).toMatch(/missing gate outcome "ready"/);
      expect(validPrefix.errors).toEqual([]);
      expect(validPrefix.value?.steps.inspect?.permissions.bash.allow).toEqual([
        { executable: 'git', argsPrefix: ['status'] },
      ]);
    });

    test('validates and normalizes the workflow status shortcut', () => {
      // given
      const invalidShortcuts: unknown[] = [
        42,
        '',
        'w',
        'meta+w',
        'ctrl+ctrl+w',
        'ctrl+w+alt',
        'ctrl+unknown',
        'ctrl+escape',
        'ctrl+f12',
        'ctrl++',
      ];

      // when
      const omitted = validateSettings({ version: 1 });
      const custom = validateSettings({
        version: 1,
        statusShortcut: '  ALT+CTRL+Y  ',
      });
      const invalid = invalidShortcuts.map((statusShortcut) =>
        validateSettings({ version: 1, statusShortcut }),
      );

      // then
      expect(omitted.errors).toEqual([]);
      expect(omitted.value?.statusShortcut).toBe('ctrl+alt+w');
      expect(custom.errors).toEqual([]);
      expect(custom.value?.statusShortcut).toBe('alt+ctrl+y');
      expect(invalid.every(({ value }) => value === undefined)).toBe(true);
      expect(invalid.every(({ errors }) => errors.length > 0)).toBe(true);
      expect(invalid.flatMap(({ errors }) => errors).join('\n')).toMatch(
        /settings\.statusShortcut/,
      );
    });

    test('rejects malformed settings and returns independent defaults', () => {
      // given
      const malformed: unknown[] = [
        null,
        {
          $schema: 42,
          version: 2,
          allowProjectWorkflows: 'yes',
          permissionCeiling: 42,
          unexpected: true,
        },
        { version: 1, allowProjectWorkflows: true },
        {
          version: 1,
          permissionCeiling: {
            tools: ['bash'],
            bash: { mode: 'read-only' },
            subagent: 42,
          },
        },
        {
          version: 1,
          permissionCeiling: {
            subagent: {
              agents: [],
              contexts: ['fork'],
              models: 'models',
            },
          },
        },
        {
          version: 1,
          permissionCeiling: {
            subagent: {
              agents: ['pi-workflows.step'],
              contexts: ['fresh'],
              models: [],
              maxTimeoutMs: 0,
              maxTurns: 0,
              maxGraceTurns: 101,
              maxToolCalls: 0,
              artifacts: 'yes',
            },
          },
        },
      ];

      // when
      const errors = malformed.map((raw) => validateSettings(raw).errors);
      const forkCeiling = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: [],
          mcp: [],
          extensions: [],
          skills: [],
          bash: { mode: 'deny' },
          subagent: {
            ...projectSubagentCeiling(),
            contexts: ['fork'],
          },
        },
      });
      const first = cloneEmptyRequirements();
      const second = cloneEmptyRequirements();
      first.tools.push('read');

      // then
      expect(errors.every((items) => items.length > 0)).toBe(true);
      expect(errors.flat().join('\n')).toMatch(
        /required when project workflows are enabled/,
      );
      expect(errors.flat().join('\n')).toMatch(
        /at least one subagent is required/,
      );
      expect(forkCeiling.value).toBe(undefined);
      expect(forkCeiling.errors.join('\n')).toMatch(
        /contexts.*invalid value "fork"/,
      );
      expect(second).toEqual({ tools: [], extensions: [], skills: [] });
    });

    test('rejects workflow aliases reserved by Pi', () => {
      // given
      // when
      const result = validateWorkflow({ ...baseWorkflow(), command: 'model' });
      // then
      expect(result.value).toBe(undefined);
      expect(result.errors.join('\n')).toMatch(/reserved by Pi or the harness/);
    });

    test('defaults gates to prompt and supports Plannotator without duplication', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = {
        ...steps.inspect,
        gate: {
          submitOutcome: 'submit',
          approvedOutcome: 'ready',
          rejectedOutcome: 'blocked',
        },
      };
      // when
      const promptResult = validateWorkflow(raw);
      // then
      expect(promptResult.errors).toEqual([]);
      expect(promptResult.value?.steps.inspect?.gate?.provider).toBe('prompt');

      const plannotator = structuredClone(raw);
      const plannotatorSteps = plannotator.steps as Record<
        string,
        Record<string, unknown>
      >;
      plannotatorSteps.inspect = {
        ...plannotatorSteps.inspect,
        gate: {
          provider: 'plannotator',
          submitOutcome: 'submit',
          approvedOutcome: 'ready',
          rejectedOutcome: 'blocked',
        },
      };
      const plannotatorResult = validateWorkflow(plannotator);
      expect(plannotatorResult.errors).toEqual([]);
      expect(plannotatorResult.value?.steps.inspect?.gate?.provider).toBe(
        'plannotator',
      );
      expect(plannotatorResult.value?.steps.inspect?.gate).toMatchObject({
        timeoutMs: 30_000,
      });

      const invalid = structuredClone(raw);
      const invalidSteps = invalid.steps as Record<
        string,
        Record<string, unknown>
      >;
      invalidSteps.inspect = {
        ...invalidSteps.inspect,
        gate: {
          provider: 'unknown',
          submitOutcome: 'submit',
          approvedOutcome: 'ready',
          rejectedOutcome: 'blocked',
        },
      };
      expect(validateWorkflow(invalid).errors.join('\n')).toMatch(
        /expected prompt or plannotator/,
      );
    });

    test('project ceiling requires subagent policy only for delegated steps', () => {
      // given
      // when
      const mainWorkflow = validateWorkflow(baseWorkflow());
      // then
      expect(mainWorkflow.value).toBeTruthy();
      const mainSettings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['read', 'edit', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['status'] }],
          },
        },
      });
      expect(mainSettings.value?.permissionCeiling).toBeTruthy();
      expect(
        checkWorkflowAgainstCeiling(
          mainWorkflow.value!,
          mainSettings.value!.permissionCeiling!,
        ).join('\n'),
      ).not.toMatch(/subagent/);

      const delegated = baseWorkflow();
      const delegatedSteps = delegated.steps as Record<
        string,
        Record<string, unknown>
      >;
      delegatedSteps.inspect = { ...delegatedSteps.inspect, subagent: {} };
      const delegatedWorkflow = validateWorkflow(delegated);
      expect(delegatedWorkflow.value).toBeTruthy();
      expect(
        checkWorkflowAgainstCeiling(
          delegatedWorkflow.value!,
          mainSettings.value!.permissionCeiling!,
        ).join('\n'),
      ).toMatch(/subagent execution exceeds/);
    });

    test('project ceiling rejects workspace binding as its own exact error', () => {
      const raw = workspaceWorkflow(['..']);
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      for (const stepId of ['inspect', 'implement']) {
        const step = steps[stepId]!;
        step.subagent = {
          ...(step.subagent as Record<string, unknown>),
          turnBudget: { maxTurns: 10, graceTurns: 1 },
          toolBudget: { hard: 20, block: '*' },
        };
      }
      const workflow = validateWorkflow(raw);
      expect(workflow.errors).toEqual([]);

      const settings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['read', 'edit', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['status'] }],
          },
          subagent: {
            ...projectSubagentCeiling(),
            agents: ['workspace-preparer', 'worker'],
            maxTimeoutMs: 900_000,
          },
        },
      });
      expect(settings.errors).toEqual([]);

      expect(
        checkWorkflowAgainstCeiling(
          workflow.value!,
          settings.value!.permissionCeiling!,
        ),
      ).toEqual([
        'workflow.steps.inspect.workspace: workspace binding is unavailable to project workflows',
      ]);
    });

    test('project permission ceiling rejects wider tools and MCP servers', () => {
      // given
      // when
      const workflow = validateWorkflow({
        ...baseWorkflow(),
        steps: {
          inspect: {
            prompt: 'Inspect',
            subagent: {
              agent: 'pi-workflows.writer',
              context: 'fresh',
              model: 'anthropic/claude-sonnet-4',
              timeoutMs: 120_000,
              turnBudget: { maxTurns: 12, graceTurns: 2 },
              toolBudget: { hard: 30 },
              artifacts: true,
            },
            permissions: {
              tools: ['read', 'write'],
              mcp: ['gitlab/get_merge_request'],
            },
            transitions: { done: '$done' },
          },
        },
        start: 'inspect',
      });
      // then
      expect(workflow.value).toBeTruthy();
      const settings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['read'],
          mcp: ['github'],
          bash: { mode: 'deny' },
          subagent: projectSubagentCeiling(),
        },
      });
      expect(settings.value?.permissionCeiling).toBeTruthy();
      const errors = checkWorkflowAgainstCeiling(
        workflow.value!,
        settings.value!.permissionCeiling!,
      );
      expect(errors.join('\n')).toMatch(/"write" exceeds/);
      expect(errors.join('\n')).toMatch(/"gitlab\/get_merge_request" exceeds/);
      expect(errors.join('\n')).toMatch(/subagent\.agent/);
      expect(errors.join('\n')).toMatch(/subagent\.model/);
      expect(errors.join('\n')).toMatch(/subagent\.timeoutMs/);
      expect(errors.join('\n')).toMatch(/subagent\.turnBudget\.maxTurns/);
      expect(errors.join('\n')).toMatch(/subagent\.toolBudget\.hard/);
      expect(errors.join('\n')).toMatch(/subagent\.toolBudget\.block/);
      expect(errors.join('\n')).toMatch(/subagent\.artifacts/);

      const contextCeiling = structuredClone(
        settings.value!.permissionCeiling!,
      );
      if (!contextCeiling.subagent) {
        throw new Error('expected a subagent permission ceiling');
      }
      const contextCeilingWithoutContexts = {
        ...contextCeiling,
        subagent: { ...contextCeiling.subagent, contexts: [] },
      };
      expect(
        checkWorkflowAgainstCeiling(
          workflow.value!,
          contextCeilingWithoutContexts,
        ).join('\n'),
      ).toMatch(/subagent\.context/);

      const inspectedStep = workflow.value!.steps.inspect;
      if (!inspectedStep?.subagent) {
        throw new Error('expected the inspect step to use a subagent');
      }
      const retryRequested = {
        ...workflow.value!,
        steps: {
          ...workflow.value!.steps,
          inspect: {
            ...inspectedStep,
            subagent: {
              ...inspectedStep.subagent,
              retryToolFailures: true,
            },
          },
        },
      };
      expect(
        checkWorkflowAgainstCeiling(
          retryRequested,
          settings.value!.permissionCeiling!,
        ).join('\n'),
      ).toMatch(/subagent\.retryToolFailures/);
    });

    test('project permission ceiling constrains declarative Bash rules', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = {
        ...steps.inspect,
        permissions: {
          tools: ['read', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['status'] }],
          },
        },
      };
      // when
      const workflow = validateWorkflow(raw);
      // then
      expect(workflow.value).toBeTruthy();
      const deniedSettings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['read', 'edit', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['diff'] }],
          },
          subagent: projectSubagentCeiling(),
        },
      });
      expect(deniedSettings.value?.permissionCeiling).toBeTruthy();
      expect(
        checkWorkflowAgainstCeiling(
          workflow.value!,
          deniedSettings.value!.permissionCeiling!,
        ).join('\n'),
      ).toMatch(/permissions\.bash: exceeds/);

      const allowedSettings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['read', 'edit', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['status'] }],
          },
          subagent: projectSubagentCeiling(),
        },
      });
      expect(allowedSettings.value?.permissionCeiling).toBeTruthy();
      expect(
        checkWorkflowAgainstCeiling(
          workflow.value!,
          allowedSettings.value!.permissionCeiling!,
        ).join('\n'),
      ).not.toMatch(/permissions\.bash: exceeds/);
    });

    test('project ceiling reports extension, skill, and missing budget limits', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        run: {
          prompt: 'Run',
          subagent: {},
          permissions: {
            tools: ['bash'],
            extensions: ['annotator'],
            skills: ['planning'],
            bash: {
              mode: 'allow-list',
              allow: [{ executable: 'npm', argsPrefix: ['test'] }],
            },
          },
          transitions: { done: '$done' },
        },
      };
      raw.start = 'run';
      const workflow = validateWorkflow(raw).value!;
      const settings = validateSettings({
        version: 1,
        allowProjectWorkflows: true,
        permissionCeiling: {
          tools: ['bash'],
          extensions: [],
          skills: [],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'npm', argsPrefix: ['test'] }],
          },
          subagent: projectSubagentCeiling(),
        },
      }).value!;

      // when
      const errors = checkWorkflowAgainstCeiling(
        workflow,
        settings.permissionCeiling!,
      );

      // then
      expect(errors.join('\n')).toMatch(/extensions: "annotator" exceeds/);
      expect(errors.join('\n')).toMatch(/skills: "planning" exceeds/);
      expect(errors.join('\n')).toMatch(/turnBudget: required/);
      expect(errors.join('\n')).toMatch(/toolBudget: required/);
      expect(errors.join('\n')).not.toMatch(/permissions\.bash: exceeds/);
    });

    test('loader rejects prompt paths that escape the workflow directory', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-config-'));
      const userDirectory = join(root, 'workflows');
      await mkdir(userDirectory, { recursive: true });
      await writeFile(join(root, 'outside.md'), 'outside', 'utf8');
      const raw = {
        ...baseWorkflow(),
        steps: {
          inspect: {
            prompt: { file: '../outside.md' },
            transitions: { done: '$done' },
          },
        },
        start: 'inspect',
      };
      // when
      await writeFile(
        join(userDirectory, 'escape.workflow.yaml'),
        JSON.stringify(raw),
        'utf8',
      );

      // then
      try {
        const catalog = await loadCatalog({
          cwd: root,
          projectTrusted: false,
          userDirectory,
        });
        expect(catalog.workflows.size).toBe(0);
        expect(catalog.diagnostics[0]?.message ?? '').toMatch(
          /escapes workflow directory/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('loader accepts YAML workflow files and rejects duplicate YAML keys', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-yaml-'));
      const userDirectory = join(root, 'workflows');
      await mkdir(userDirectory, { recursive: true });
      await writeFile(
        join(userDirectory, 'compact.workflow.yaml'),
        [
          'version: 1',
          'id: compact',
          'command: compact-workflow',
          'description: Compact YAML workflow',
          'start: inspect',
          'steps:',
          '  inspect:',
          '    prompt: Inspect safely',
          '    subagent: reviewer',
          '    permissions:',
          '      tools: [bash]',
          '      bash:',
          '        mode: allow-list',
          '        allow:',
          '          - executable: git',
          '            argsPrefixes: [[status], [diff, --stat]]',
          '    transitions:',
          '      done: $done',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(userDirectory, 'short-extension.workflow.yml'),
        [
          'version: 1',
          'id: short-extension',
          'command: short-extension',
          'description: YAML yml extension',
          'start: inspect',
          'steps:',
          '  inspect:',
          '    prompt: Inspect',
          '    transitions: { done: $done }',
        ].join('\n'),
        'utf8',
      );
      // when
      await writeFile(
        join(userDirectory, 'duplicate.workflow.yaml'),
        [
          'version: 1',
          'id: first',
          'id: second',
          'command: duplicate',
          'description: Invalid duplicate key',
          'start: inspect',
          'steps:',
          '  inspect:',
          '    prompt: Inspect',
          '    transitions: { done: $done }',
        ].join('\n'),
        'utf8',
      );
      // then
      try {
        const catalog = await loadCatalog({
          cwd: root,
          projectTrusted: false,
          userDirectory,
        });
        expect([...catalog.workflows.keys()]).toEqual([
          'compact',
          'short-extension',
        ]);
        expect(
          catalog.workflows.get('compact')?.definition.steps.inspect
            ?.permissions.bash.allow,
        ).toEqual([
          { executable: 'git', argsPrefix: ['status'] },
          { executable: 'git', argsPrefix: ['diff', '--stat'] },
        ]);
        expect(
          catalog.workflows.get('compact')?.definition.steps.inspect?.subagent,
        ).toEqual({
          agent: 'reviewer',
          context: 'fresh',
          timeoutMs: 900_000,
          artifacts: false,
          retryToolFailures: false,
        });
        expect(catalog.diagnostics.length).toBe(1);
        expect(catalog.diagnostics[0]?.message ?? '').toMatch(/unique/i);
        expect(catalog.diagnostics[0]?.message ?? '').toMatch(
          /line 3, column 1/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('loader rejects multiple YAML documents and excessive aliases', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-yaml-limits-'));
      const userDirectory = join(root, 'workflows');
      await mkdir(userDirectory, { recursive: true });
      const workflow = [
        'version: 1',
        'id: guarded',
        'command: guarded',
        'description: &description Guarded YAML',
        'start: inspect',
        'steps:',
        '  inspect:',
        '    prompt: Inspect',
        '    transitions: { done: $done }',
      ];
      await writeFile(
        join(userDirectory, 'multiple.workflow.yaml'),
        [...workflow, '---', 'version: 1'].join('\n'),
        'utf8',
      );
      await writeFile(
        join(userDirectory, 'aliases.workflow.yaml'),
        [
          ...workflow,
          `aliases: [${Array.from({ length: 101 }, () => '*description').join(', ')}]`,
        ].join('\n'),
        'utf8',
      );
      // when
      await writeFile(
        join(userDirectory, 'version.workflow.yaml'),
        ['%YAML 1.1', '---', ...workflow].join('\n'),
        'utf8',
      );

      // then
      try {
        const catalog = await loadCatalog({
          cwd: root,
          projectTrusted: false,
          userDirectory,
        });
        expect(catalog.workflows.size).toBe(0);
        expect(catalog.diagnostics.length).toBe(3);
        expect(
          catalog.diagnostics.map((item) => item.message).join('\n'),
        ).toMatch(/multiple documents/);
        expect(
          catalog.diagnostics.map((item) => item.message).join('\n'),
        ).toMatch(/Excessive alias count/);
        expect(
          catalog.diagnostics.map((item) => item.message).join('\n'),
        ).toMatch(/must use version 1\.2/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('loader reads a custom status shortcut and falls back on invalid syntax', async () => {
      // given
      const root = await mkdtemp(
        join(tmpdir(), 'pi-workflows-settings-shortcut-'),
      );
      const userDirectory = join(root, 'workflows');
      const settingsPath = join(userDirectory, 'settings.yaml');
      await mkdir(userDirectory, { recursive: true });

      // when / then
      try {
        await writeFile(
          settingsPath,
          'version: 1\nstatusShortcut: ctrl+shift+y\n',
          'utf8',
        );
        const configured = await loadCatalog({
          cwd: root,
          projectTrusted: false,
          userDirectory,
        });
        expect(configured.diagnostics).toEqual([]);
        expect(configured.settings.statusShortcut).toBe('ctrl+shift+y');

        await writeFile(
          settingsPath,
          'version: 1\nstatusShortcut: bogus+w\n',
          'utf8',
        );
        const invalid = await loadCatalog({
          cwd: root,
          projectTrusted: false,
          userDirectory,
        });
        expect(invalid.settings.statusShortcut).toBe('ctrl+alt+w');
        expect(invalid.diagnostics).toHaveLength(1);
        expect(invalid.diagnostics[0]?.message).toMatch(
          /settings\.statusShortcut/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('loader rejects invalid settings YAML', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-settings-yaml-'));
      const userDirectory = join(root, 'workflows');
      await mkdir(userDirectory, { recursive: true });
      // when
      await writeFile(
        join(userDirectory, 'settings.yaml'),
        [
          'version: 1',
          'allowProjectWorkflows: false',
          'allowProjectWorkflows: true',
        ].join('\n'),
        'utf8',
      );

      // then
      try {
        const catalog = await loadCatalog({
          cwd: root,
          projectTrusted: false,
          userDirectory,
        });
        expect(catalog.settings).toEqual({
          version: 1,
          allowProjectWorkflows: false,
          statusShortcut: 'ctrl+alt+w',
        });
        expect(catalog.diagnostics.length).toBe(1);
        expect(catalog.diagnostics[0]?.path).toBe(
          join(userDirectory, 'settings.yaml'),
        );
        expect(catalog.diagnostics[0]?.message ?? '').toMatch(/unique/i);
        expect(catalog.diagnostics[0]?.message ?? '').toMatch(
          /line 3, column 1/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('trusted project workflows cannot override user workflow ids', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-catalog-'));
      const userDirectory = join(root, 'user');
      const projectDirectory = join(root, 'project', '.pi', 'workflows');
      await mkdir(userDirectory, { recursive: true });
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(
        join(userDirectory, 'settings.yaml'),
        [
          'version: 1',
          'allowProjectWorkflows: true',
          'permissionCeiling:',
          '  tools: [read, edit, bash]',
          '  mcp: []',
          '  extensions: []',
          '  skills: []',
          '  bash:',
          '    mode: allow-list',
          '    allow:',
          '      - executable: git',
          '        argsPrefix: [status]',
          '  subagent:',
          '    agents: [pi-workflows.step]',
          '    contexts: [fresh]',
          '    models: []',
          '    maxTimeoutMs: 900000',
          '    maxTurns: 40',
          '    maxGraceTurns: 3',
          '    maxToolCalls: 100',
          '    artifacts: false',
          '    retryToolFailures: false',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(userDirectory, 'example.workflow.yaml'),
        JSON.stringify(baseWorkflow()),
        'utf8',
      );
      const projectWorkflow = baseWorkflow();
      const projectSteps = projectWorkflow.steps as Record<
        string,
        Record<string, unknown>
      >;
      for (const [stepId, step] of Object.entries(projectSteps)) {
        projectSteps[stepId] = {
          ...step,
          subagent: {
            turnBudget: { maxTurns: 20, graceTurns: 2 },
            toolBudget: { hard: 50, block: '*' },
          },
        };
      }
      // when
      await writeFile(
        join(projectDirectory, 'override.workflow.yaml'),
        JSON.stringify(projectWorkflow),
        'utf8',
      );

      // then
      try {
        const catalog = await loadCatalog({
          cwd: join(root, 'project'),
          projectTrusted: true,
          userDirectory,
        });
        expect(catalog.workflows.size).toBe(1);
        expect(catalog.diagnostics.at(-1)?.message ?? '').toMatch(
          /overrides are not allowed/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('loader reports invalid files, symlink escapes, and command collisions', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-load-errors-'));
      const userDirectory = join(root, 'workflows');
      await mkdir(userDirectory, { recursive: true });
      const outsidePrompt = join(root, 'outside.md');
      await writeFile(outsidePrompt, 'Outside', 'utf8');
      await writeFile(join(userDirectory, 'local.md'), 'Local prompt', 'utf8');
      await symlink(outsidePrompt, join(userDirectory, 'linked.md'));
      const symlinkWorkflow = {
        ...baseWorkflow(),
        id: 'symlink',
        command: 'symlink',
        steps: {
          run: {
            prompt: { file: 'linked.md' },
            transitions: { done: '$done' },
          },
        },
        start: 'run',
      };
      const invalidPrompt = {
        ...baseWorkflow(),
        id: 'invalid-prompt',
        command: 'invalid-prompt',
        steps: {
          run: {
            prompt: 'Use {{unknown.variable}}',
            transitions: { done: '$done' },
          },
        },
        start: 'run',
      };
      const duplicateCommand = {
        ...baseWorkflow(),
        id: 'other',
        command: 'example',
      };
      const localPromptWorkflow = {
        ...baseWorkflow(),
        id: 'local-prompt',
        command: 'local-prompt',
        steps: {
          run: {
            prompt: { file: 'local.md' },
            transitions: { done: '$done' },
          },
        },
        start: 'run',
      };
      await Promise.all([
        writeFile(join(userDirectory, 'settings.yaml'), 'version: 2\n', 'utf8'),
        writeFile(
          join(userDirectory, 'invalid.workflow.yaml'),
          'version: 1\n',
          'utf8',
        ),
        writeFile(
          join(userDirectory, 'prompt.workflow.yaml'),
          JSON.stringify(invalidPrompt),
          'utf8',
        ),
        writeFile(
          join(userDirectory, 'symlink.workflow.yaml'),
          JSON.stringify(symlinkWorkflow),
          'utf8',
        ),
        writeFile(
          join(userDirectory, 'valid.workflow.yaml'),
          JSON.stringify(baseWorkflow()),
          'utf8',
        ),
        writeFile(
          join(userDirectory, 'local.workflow.yaml'),
          JSON.stringify(localPromptWorkflow),
          'utf8',
        ),
        writeFile(
          join(userDirectory, 'collision.workflow.yaml'),
          JSON.stringify(duplicateCommand),
          'utf8',
        ),
      ]);

      // when
      const catalog = await loadCatalog({
        cwd: root,
        projectTrusted: false,
        userDirectory,
      });

      // then
      const messages = catalog.diagnostics
        .map((item) => item.message)
        .join('\n');
      expect(messages).toMatch(/settings\.version/);
      expect(messages).toMatch(/workflow\.id/);
      expect(messages).toMatch(/unknown prompt variable/);
      expect(messages).toMatch(/symlink escapes workflow directory/);
      expect(messages).toMatch(/command "\/example" already belongs/);
      await rm(root, { recursive: true, force: true });
    });

    test('loader reports unreadable paths and resolves environment defaults', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-load-paths-'));
      const filePath = join(root, 'not-a-directory');
      await writeFile(filePath, 'file', 'utf8');
      const previousWorkflows = process.env.PI_WORKFLOWS_DIR;
      const previousAgent = process.env.PI_CODING_AGENT_DIR;

      // when
      const catalog = await loadCatalog({
        cwd: root,
        projectTrusted: false,
        userDirectory: filePath,
      });
      process.env.PI_WORKFLOWS_DIR = join(root, 'explicit');
      const explicit = defaultUserWorkflowDirectory();
      delete process.env.PI_WORKFLOWS_DIR;
      process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
      const agent = defaultUserWorkflowDirectory();

      // then
      expect(
        catalog.diagnostics.map((item) => item.message).join('\n'),
      ).toMatch(/cannot read settings[\s\S]*cannot read workflow directory/);
      expect(explicit).toBe(join(root, 'explicit'));
      expect(agent).toBe(join(root, 'agent', 'workflows'));
      if (previousWorkflows === undefined) delete process.env.PI_WORKFLOWS_DIR;
      else process.env.PI_WORKFLOWS_DIR = previousWorkflows;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      await rm(root, { recursive: true, force: true });
    });

    test('loader explains every project workflow skip and ceiling failure', async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-project-load-'));
      const project = join(root, 'project');
      const projectDirectory = join(project, '.pi', 'workflows');
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(
        join(projectDirectory, 'project.workflow.yaml'),
        JSON.stringify(baseWorkflow()),
        'utf8',
      );
      const untrustedUser = join(root, 'untrusted');
      const deniedUser = join(root, 'denied');
      await Promise.all(
        [untrustedUser, deniedUser].map((directory) =>
          mkdir(directory, { recursive: true }),
        ),
      );
      await writeFile(
        join(untrustedUser, 'settings.yaml'),
        'version: 1\nallowProjectWorkflows: true\npermissionCeiling:\n  tools: []\n  bash: { mode: deny }\n',
        'utf8',
      );
      await writeFile(
        join(deniedUser, 'settings.yaml'),
        'version: 1\nallowProjectWorkflows: true\npermissionCeiling:\n  tools: []\n  bash: { mode: deny }\n',
        'utf8',
      );

      // when
      const [untrusted, denied] = await Promise.all([
        loadCatalog({
          cwd: project,
          projectTrusted: false,
          userDirectory: untrustedUser,
        }),
        loadCatalog({
          cwd: project,
          projectTrusted: true,
          userDirectory: deniedUser,
        }),
      ]);

      // then
      expect(untrusted.diagnostics[0]?.message).toMatch(/not trusted/);
      expect(denied.diagnostics.map((item) => item.message).join('\n')).toMatch(
        /exceeds the user permission ceiling/,
      );
      await rm(root, { recursive: true, force: true });
    });
  });
});
