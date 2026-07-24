import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkWorkflowAgainstCeiling } from '../src/config/ceiling.ts';
import { loadCatalog } from '../src/config/load.ts';
import { validateSettings, validateWorkflow } from '../src/config/validate.ts';
import { baseWorkflow } from './helpers.ts';

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
  };
}

test('validates a declarative workflow graph', () => {
  const result = validateWorkflow(baseWorkflow());
  assert.deepEqual(result.errors, []);
  assert.equal(result.value?.start, 'inspect');
  assert.equal(result.value?.steps.inspect?.permissions.bash.mode, 'read-only');
  assert.equal(result.value?.steps.inspect?.subagent, undefined);
});

test('validates per-step subagent model and execution budgets', () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    subagent: {
      agent: 'pi-workflows.inspector',
      context: 'fork',
      model: 'anthropic/claude-sonnet-4',
      timeoutMs: 120_000,
      turnBudget: { maxTurns: 12, graceTurns: 2 },
      toolBudget: { soft: 20, hard: 30, block: '*' },
      artifacts: true,
    },
  };
  const result = validateWorkflow(raw);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value?.steps.inspect?.subagent, {
    agent: 'pi-workflows.inspector',
    context: 'fork',
    model: 'anthropic/claude-sonnet-4',
    timeoutMs: 120_000,
    turnBudget: { maxTurns: 12, graceTurns: 2 },
    toolBudget: { soft: 20, hard: 30, block: '*' },
    artifacts: true,
  });

  const invalid = baseWorkflow();
  const invalidSteps = invalid.steps as Record<string, Record<string, unknown>>;
  invalidSteps.inspect = {
    ...invalidSteps.inspect,
    subagent: {
      agent: 'reviewer',
      context: 'shared',
      toolBudget: { soft: 10, hard: 5 },
    },
  };
  const invalidResult = validateWorkflow(invalid);
  assert.match(
    invalidResult.errors.join('\n'),
    /agent: invalid value "reviewer"/,
  );
  assert.match(invalidResult.errors.join('\n'), /expected fresh or fork/);
  assert.match(invalidResult.errors.join('\n'), /soft: must not exceed hard/);

  const defaults = baseWorkflow();
  const defaultSteps = defaults.steps as Record<
    string,
    Record<string, unknown>
  >;
  defaultSteps.inspect = { ...defaultSteps.inspect, subagent: {} };
  const defaultResult = validateWorkflow(defaults);
  assert.deepEqual(defaultResult.errors, []);
  assert.deepEqual(defaultResult.value?.steps.inspect?.subagent, {
    agent: 'pi-workflows.step',
    context: 'fresh',
    timeoutMs: 900_000,
    artifacts: false,
  });

  const named = baseWorkflow();
  const namedSteps = named.steps as Record<string, Record<string, unknown>>;
  namedSteps.inspect = {
    ...namedSteps.inspect,
    subagent: 'pi-workflows.inspector',
  };
  const namedResult = validateWorkflow(named);
  assert.deepEqual(namedResult.errors, []);
  assert.deepEqual(namedResult.value?.steps.inspect?.subagent, {
    agent: 'pi-workflows.inspector',
    context: 'fresh',
    timeoutMs: 900_000,
    artifacts: false,
  });

  const invalidName = baseWorkflow();
  const invalidNameSteps = invalidName.steps as Record<
    string,
    Record<string, unknown>
  >;
  invalidNameSteps.inspect = {
    ...invalidNameSteps.inspect,
    subagent: 'reviewer',
  };
  assert.match(
    validateWorkflow(invalidName).errors.join('\n'),
    /subagent: invalid value "reviewer"/,
  );
});

test('validates reviewed Bash command sources', () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    permissions: {
      tools: ['read', 'bash'],
      bash: {
        mode: 'allow-list',
        approvedSources: ['verification-worker'],
      },
    },
  };
  const result = validateWorkflow(raw);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.value?.steps.inspect?.permissions.bash.approvedSources,
    ['verification-worker'],
  );

  const invalid = structuredClone(raw);
  const invalidSteps = invalid.steps as Record<string, Record<string, unknown>>;
  invalidSteps.inspect = {
    ...invalidSteps.inspect,
    permissions: {
      tools: ['read', 'bash'],
      bash: {
        mode: 'read-only',
        approvedSources: ['remote-actions'],
      },
    },
  };
  assert.match(
    validateWorkflow(invalid).errors.join('\n'),
    /approvedSources: only valid when mode is "allow-list"/,
  );
});

test('expands compact Bash argument-prefix alternatives', () => {
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

  const result = validateWorkflow(raw);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value?.steps.inspect?.permissions.bash.allow, [
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
  assert.match(
    validateWorkflow(ambiguous).errors.join('\n'),
    /argsPrefix and argsPrefixes are mutually exclusive/,
  );

  const malformed = structuredClone(raw);
  const malformedSteps = malformed.steps as Record<
    string,
    Record<string, unknown>
  >;
  const malformedPermissions = malformedSteps.inspect?.permissions as Record<
    string,
    unknown
  >;
  const malformedBash = malformedPermissions.bash as Record<string, unknown>;
  malformedBash.allow = [
    {
      executable: 'git',
      argsPrefixes: [[], ['status'], ['status']],
    },
  ];
  const malformedErrors = validateWorkflow(malformed).errors.join('\n');
  assert.match(malformedErrors, /at least one argument is required/);
  assert.match(malformedErrors, /duplicate argument prefix/);

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
  assert.deepEqual(settings.errors, []);
  assert.deepEqual(settings.value?.permissionCeiling?.bash.allow, [
    { executable: 'git', argsPrefix: ['status'] },
    { executable: 'git', argsPrefix: ['diff'] },
  ]);
});

test('rejects unknown properties and transition targets', () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    typo: true,
    transitions: { ready: 'missing' },
  };
  const result = validateWorkflow(raw);
  assert.equal(result.value, undefined);
  assert.match(result.errors.join('\n'), /unknown property "typo"/);
  assert.match(result.errors.join('\n'), /unknown target "missing"/);
});

test('rejects a non-string schema hint', () => {
  const result = validateWorkflow({ ...baseWorkflow(), $schema: 42 });
  assert.match(
    result.errors.join('\n'),
    /workflow\.\$schema: expected a string/,
  );
});

test('rejects workflow aliases reserved by Pi', () => {
  const result = validateWorkflow({ ...baseWorkflow(), command: 'model' });
  assert.equal(result.value, undefined);
  assert.match(result.errors.join('\n'), /reserved by Pi or the harness/);
});

test('defaults gates to prompt and supports Plannotator without duplication', () => {
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
  const promptResult = validateWorkflow(raw);
  assert.deepEqual(promptResult.errors, []);
  assert.equal(promptResult.value?.steps.inspect?.gate?.provider, 'prompt');

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
  assert.deepEqual(plannotatorResult.errors, []);
  assert.equal(
    plannotatorResult.value?.steps.inspect?.gate?.provider,
    'plannotator',
  );

  const invalid = structuredClone(raw);
  const invalidSteps = invalid.steps as Record<string, Record<string, unknown>>;
  invalidSteps.inspect = {
    ...invalidSteps.inspect,
    gate: {
      provider: 'unknown',
      submitOutcome: 'submit',
      approvedOutcome: 'ready',
      rejectedOutcome: 'blocked',
    },
  };
  assert.match(
    validateWorkflow(invalid).errors.join('\n'),
    /expected prompt or plannotator/,
  );
});

test('project ceiling requires subagent policy only for delegated steps', () => {
  const mainWorkflow = validateWorkflow(baseWorkflow());
  assert.ok(mainWorkflow.value);
  const mainSettings = validateSettings({
    version: 1,
    allowProjectWorkflows: true,
    permissionCeiling: {
      tools: ['read', 'edit', 'bash'],
      bash: { mode: 'read-only' },
    },
  });
  assert.ok(mainSettings.value?.permissionCeiling);
  assert.doesNotMatch(
    checkWorkflowAgainstCeiling(
      mainWorkflow.value!,
      mainSettings.value!.permissionCeiling!,
    ).join('\n'),
    /subagent/,
  );

  const delegated = baseWorkflow();
  const delegatedSteps = delegated.steps as Record<
    string,
    Record<string, unknown>
  >;
  delegatedSteps.inspect = { ...delegatedSteps.inspect, subagent: {} };
  const delegatedWorkflow = validateWorkflow(delegated);
  assert.ok(delegatedWorkflow.value);
  assert.match(
    checkWorkflowAgainstCeiling(
      delegatedWorkflow.value!,
      mainSettings.value!.permissionCeiling!,
    ).join('\n'),
    /subagent execution exceeds/,
  );
});

test('project permission ceiling rejects wider tools and MCP servers', () => {
  const workflow = validateWorkflow({
    ...baseWorkflow(),
    steps: {
      inspect: {
        prompt: 'Inspect',
        subagent: {
          agent: 'pi-workflows.writer',
          context: 'fork',
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
  assert.ok(workflow.value);
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
  assert.ok(settings.value?.permissionCeiling);
  const errors = checkWorkflowAgainstCeiling(
    workflow.value!,
    settings.value!.permissionCeiling!,
  );
  assert.match(errors.join('\n'), /"write" exceeds/);
  assert.match(errors.join('\n'), /"gitlab\/get_merge_request" exceeds/);
  assert.match(errors.join('\n'), /subagent\.agent/);
  assert.match(errors.join('\n'), /subagent\.context/);
  assert.match(errors.join('\n'), /subagent\.model/);
  assert.match(errors.join('\n'), /subagent\.timeoutMs/);
  assert.match(errors.join('\n'), /subagent\.turnBudget\.maxTurns/);
  assert.match(errors.join('\n'), /subagent\.toolBudget\.hard/);
  assert.match(errors.join('\n'), /subagent\.toolBudget\.block/);
  assert.match(errors.join('\n'), /subagent\.artifacts/);
});

test('project permission ceiling constrains reviewed Bash sources', () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    permissions: {
      tools: ['read', 'bash'],
      bash: {
        mode: 'allow-list',
        approvedSources: ['verification-worker'],
      },
    },
  };
  const workflow = validateWorkflow(raw);
  assert.ok(workflow.value);
  const deniedSettings = validateSettings({
    version: 1,
    allowProjectWorkflows: true,
    permissionCeiling: {
      tools: ['read', 'edit', 'bash'],
      bash: {
        mode: 'allow-list',
        approvedSources: ['verification-reviewer'],
      },
      subagent: projectSubagentCeiling(),
    },
  });
  assert.ok(deniedSettings.value?.permissionCeiling);
  assert.match(
    checkWorkflowAgainstCeiling(
      workflow.value!,
      deniedSettings.value!.permissionCeiling!,
    ).join('\n'),
    /permissions\.bash: exceeds/,
  );

  const allowedSettings = validateSettings({
    version: 1,
    allowProjectWorkflows: true,
    permissionCeiling: {
      tools: ['read', 'edit', 'bash'],
      bash: {
        mode: 'allow-list',
        approvedSources: ['verification-worker'],
      },
      subagent: projectSubagentCeiling(),
    },
  });
  assert.ok(allowedSettings.value?.permissionCeiling);
  assert.doesNotMatch(
    checkWorkflowAgainstCeiling(
      workflow.value!,
      allowedSettings.value!.permissionCeiling!,
    ).join('\n'),
    /permissions\.bash: exceeds/,
  );
});

test('loader rejects prompt paths that escape the workflow directory', async () => {
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
  await writeFile(
    join(userDirectory, 'escape.workflow.yaml'),
    JSON.stringify(raw),
    'utf8',
  );

  try {
    const catalog = await loadCatalog({
      cwd: root,
      projectTrusted: false,
      userDirectory,
    });
    assert.equal(catalog.workflows.size, 0);
    assert.match(
      catalog.diagnostics[0]?.message ?? '',
      /escapes workflow directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader accepts YAML workflow files and rejects duplicate YAML keys', async () => {
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
      '    subagent: pi-workflows.inspector',
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
  try {
    const catalog = await loadCatalog({
      cwd: root,
      projectTrusted: false,
      userDirectory,
    });
    assert.deepEqual(
      [...catalog.workflows.keys()],
      ['compact', 'short-extension'],
    );
    assert.deepEqual(
      catalog.workflows.get('compact')?.definition.steps.inspect?.permissions
        .bash.allow,
      [
        { executable: 'git', argsPrefix: ['status'] },
        { executable: 'git', argsPrefix: ['diff', '--stat'] },
      ],
    );
    assert.deepEqual(
      catalog.workflows.get('compact')?.definition.steps.inspect?.subagent,
      {
        agent: 'pi-workflows.inspector',
        context: 'fresh',
        timeoutMs: 900_000,
        artifacts: false,
      },
    );
    assert.equal(catalog.diagnostics.length, 1);
    assert.match(catalog.diagnostics[0]?.message ?? '', /unique/i);
    assert.match(catalog.diagnostics[0]?.message ?? '', /line 3, column 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader rejects multiple YAML documents and excessive aliases', async () => {
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
  await writeFile(
    join(userDirectory, 'version.workflow.yaml'),
    ['%YAML 1.1', '---', ...workflow].join('\n'),
    'utf8',
  );

  try {
    const catalog = await loadCatalog({
      cwd: root,
      projectTrusted: false,
      userDirectory,
    });
    assert.equal(catalog.workflows.size, 0);
    assert.equal(catalog.diagnostics.length, 3);
    assert.match(
      catalog.diagnostics.map((item) => item.message).join('\n'),
      /multiple documents/,
    );
    assert.match(
      catalog.diagnostics.map((item) => item.message).join('\n'),
      /Excessive alias count/,
    );
    assert.match(
      catalog.diagnostics.map((item) => item.message).join('\n'),
      /must use version 1\.2/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader rejects invalid settings YAML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflows-settings-yaml-'));
  const userDirectory = join(root, 'workflows');
  await mkdir(userDirectory, { recursive: true });
  await writeFile(
    join(userDirectory, 'settings.yaml'),
    [
      'version: 1',
      'allowProjectWorkflows: false',
      'allowProjectWorkflows: true',
    ].join('\n'),
    'utf8',
  );

  try {
    const catalog = await loadCatalog({
      cwd: root,
      projectTrusted: false,
      userDirectory,
    });
    assert.deepEqual(catalog.settings, {
      version: 1,
      allowProjectWorkflows: false,
    });
    assert.equal(catalog.diagnostics.length, 1);
    assert.equal(
      catalog.diagnostics[0]?.path,
      join(userDirectory, 'settings.yaml'),
    );
    assert.match(catalog.diagnostics[0]?.message ?? '', /unique/i);
    assert.match(catalog.diagnostics[0]?.message ?? '', /line 3, column 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted project workflows cannot override user workflow ids', async () => {
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
      '  bash: { mode: read-only }',
      '  subagent:',
      '    agents: [pi-workflows.step]',
      '    contexts: [fresh]',
      '    models: []',
      '    maxTimeoutMs: 900000',
      '    maxTurns: 40',
      '    maxGraceTurns: 3',
      '    maxToolCalls: 100',
      '    artifacts: false',
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
  await writeFile(
    join(projectDirectory, 'override.workflow.yaml'),
    JSON.stringify(projectWorkflow),
    'utf8',
  );

  try {
    const catalog = await loadCatalog({
      cwd: join(root, 'project'),
      projectTrusted: true,
      userDirectory,
    });
    assert.equal(catalog.workflows.size, 1);
    assert.match(
      catalog.diagnostics.at(-1)?.message ?? '',
      /overrides are not allowed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
