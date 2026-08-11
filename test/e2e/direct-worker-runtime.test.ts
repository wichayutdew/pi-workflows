import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { RpcClient, type SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  E2E_BOOTSTRAP_HANDOFF,
  E2E_BOOTSTRAP_MARKER,
  E2E_FINAL_SUMMARY,
  E2E_IMPLEMENT_HANDOFF,
  E2E_IMPLEMENT_MARKER,
  E2E_INPUT_MARKER,
  E2E_MODEL_ID,
  E2E_PLAN_HANDOFF,
  E2E_PLAN_MARKER,
  E2E_PROVIDER_ID,
  E2E_RETRY_HANDOFF,
  E2E_VERIFY_MARKER,
} from '../fixtures/e2e-values.ts';

const STATE_ENTRY_TYPE = 'pi-workflows-state-v1';
const TEST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 45_000;

type WorkflowCheckpoint = {
  readonly status: string;
  readonly currentStepId: string;
  readonly history: ReadonlyArray<{
    readonly stepId: string;
    readonly outcome: string;
    readonly summary: string;
    readonly workspaceCwd?: string;
  }>;
  readonly lastSummary: string;
  readonly pauseReason?: string;
};

function latestCheckpoint(
  entries: SessionEntry[],
): WorkflowCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === 'custom' &&
      entry.customType === STATE_ENTRY_TYPE &&
      entry.data !== null &&
      typeof entry.data === 'object'
    ) {
      const value = entry.data as Partial<WorkflowCheckpoint>;
      if (
        typeof value.status === 'string' &&
        typeof value.currentStepId === 'string' &&
        Array.isArray(value.history) &&
        typeof value.lastSummary === 'string'
      ) {
        return value as WorkflowCheckpoint;
      }
    }
  }
  return undefined;
}

async function waitForCommand(client: RpcClient, name: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await client.getCommands()).some((command) => command.name === name))
      return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Pi did not register /${name}`);
}

async function waitForTerminalCheckpoint(
  client: RpcClient,
): Promise<WorkflowCheckpoint> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let checkpoint: WorkflowCheckpoint | undefined;
  while (Date.now() < deadline) {
    checkpoint =
      latestCheckpoint((await client.getEntries()).entries) ?? checkpoint;
    if (checkpoint?.status === 'completed' || checkpoint?.status === 'paused')
      return checkpoint;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(
    `Timed out waiting for workflow completion. Last checkpoint: ${JSON.stringify(checkpoint)}\nPi stderr:\n${client.getStderr()}`,
  );
}

async function startWorkflow(client: RpcClient, prompt: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await client.prompt(prompt);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (latestCheckpoint((await client.getEntries()).entries)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error(
    `Workflow did not create an initial checkpoint. Pi stderr:\n${client.getStderr()}`,
  );
}

describe('direct Pi workflow workers', () => {
  test(
    'complete workspace-bound steps in separate configured worker processes',
    async () => {
      const repositoryRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../..',
      );
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-direct-e2e-'));
      const agentDirectory = join(root, 'agent');
      const workflowDirectory = join(agentDirectory, 'workflows');
      const sessionDirectory = join(root, 'sessions');
      const launcherDirectory = join(root, 'launcher');
      const workspaceDirectory = join(root, 'workspace');
      const tracePath = join(root, 'child-observations.jsonl');
      const cliPath = join(
        repositoryRoot,
        'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      );
      const workflowExtensionPath = join(repositoryRoot, 'src/index.ts');
      const providerExtensionPath = join(
        repositoryRoot,
        'test/fixtures/e2e-faux-provider.ts',
      );
      const expectedWorkspaceDirectory = await (async () => {
        await Promise.all([
          mkdir(workflowDirectory, { recursive: true }),
          mkdir(sessionDirectory, { recursive: true }),
          mkdir(launcherDirectory, { recursive: true }),
          mkdir(workspaceDirectory, { recursive: true }),
        ]);
        return realpath(workspaceDirectory);
      })();
      const expectedLauncherDirectory = await realpath(launcherDirectory);
      const workflow = {
        version: 1,
        id: 'direct-worker-e2e',
        command: 'work',
        description: 'Hermetic direct Pi worker runtime test',
        start: 'bootstrap',
        maxStepVisits: 3,
        steps: {
          bootstrap: {
            title: 'Bootstrap',
            agent: 'worker',
            prompt: E2E_BOOTSTRAP_MARKER,
            workspace: { bindOn: ['ready'], allowedRoots: ['..'] },
            transitions: { ready: 'plan', blocked: '$pause' },
          },
          plan: {
            title: 'Plan',
            agent: 'planner',
            prompt: [
              E2E_PLAN_MARKER,
              'Workflow input: {{workflow.input}}',
              'PRIVATE_PLAN_PADDING '.repeat(500),
            ].join('\n'),
            transitions: { planned: 'implement', blocked: '$pause' },
          },
          implement: {
            title: 'Implement',
            agent: 'worker',
            prompt: `${E2E_IMPLEMENT_MARKER}\nConsume only the compact handoff: {{last.summary}}`,
            transitions: {
              retry: 'implement',
              implemented: 'verify',
              blocked: '$pause',
            },
          },
          verify: {
            title: 'Verify',
            agent: 'reviewer',
            prompt: `${E2E_VERIFY_MARKER}\nConsume only the compact handoff: {{last.summary}}`,
            transitions: { done: '$done', blocked: '$pause' },
          },
        },
      };
      const settings = {
        defaultProvider: E2E_PROVIDER_ID,
        defaultModel: E2E_MODEL_ID,
        defaultThinkingLevel: 'off',
        defaultProjectTrust: 'never',
        quietStartup: true,
        enableInstallTelemetry: false,
        retry: { enabled: false },
        extensions: [workflowExtensionPath, providerExtensionPath],
      };
      const launcherPath = join(launcherDirectory, 'pi');
      let client: RpcClient | undefined;
      try {
        await writeFile(
          join(agentDirectory, 'settings.json'),
          JSON.stringify(settings),
        );
        await writeFile(
          join(workflowDirectory, 'settings.yaml'),
          'version: 1\n',
        );
        await writeFile(
          join(workflowDirectory, 'direct-worker-e2e.workflow.yaml'),
          JSON.stringify(workflow),
        );
        await writeFile(tracePath, '');
        await writeFile(
          launcherPath,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`,
        );
        await chmod(launcherPath, 0o755);

        client = new RpcClient({
          cliPath,
          cwd: launcherDirectory,
          env: {
            PI_CODING_AGENT_DIR: agentDirectory,
            PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            PI_WORKFLOWS_DIR: workflowDirectory,
            PI_WORKFLOWS_E2E_TRACE_PATH: tracePath,
            PI_WORKFLOWS_E2E_WORKSPACE_CWD: expectedWorkspaceDirectory,
            PATH: `${launcherDirectory}:${process.env.PATH ?? ''}`,
          },
          provider: E2E_PROVIDER_ID,
          model: E2E_MODEL_ID,
          args: ['--offline', '--no-approve'],
        });
        await client.start();
        await waitForCommand(client, 'work');
        await startWorkflow(
          client,
          `/work\n${E2E_INPUT_MARKER}: deterministic direct-worker smoke request.`,
        );

        const checkpoint = await waitForTerminalCheckpoint(client);
        if (checkpoint.status !== 'completed') {
          throw new Error(
            `Workflow ended ${checkpoint.status} at ${checkpoint.currentStepId}: ${checkpoint.pauseReason ?? 'no reason'}\nChild trace:\n${await readFile(tracePath, 'utf8')}\nPi stderr:\n${client.getStderr()}`,
          );
        }
        expect(
          checkpoint.history.map(
            ({ stepId, outcome, summary, workspaceCwd }) => ({
              stepId,
              outcome,
              summary,
              workspaceCwd,
            }),
          ),
        ).toEqual([
          {
            stepId: 'bootstrap',
            outcome: 'ready',
            summary: E2E_BOOTSTRAP_HANDOFF,
            workspaceCwd: expectedWorkspaceDirectory,
          },
          {
            stepId: 'plan',
            outcome: 'planned',
            summary: E2E_PLAN_HANDOFF,
            workspaceCwd: undefined,
          },
          {
            stepId: 'implement',
            outcome: 'retry',
            summary: E2E_RETRY_HANDOFF,
            workspaceCwd: undefined,
          },
          {
            stepId: 'implement',
            outcome: 'implemented',
            summary: E2E_IMPLEMENT_HANDOFF,
            workspaceCwd: undefined,
          },
          {
            stepId: 'verify',
            outcome: 'done',
            summary: E2E_FINAL_SUMMARY,
            workspaceCwd: undefined,
          },
        ]);
        expect(checkpoint.lastSummary).toBe(E2E_FINAL_SUMMARY);
        expect(
          (await readFile(tracePath, 'utf8')).trim().split('\n'),
        ).toHaveLength(5);
        expect(expectedLauncherDirectory).toBe(
          await realpath(launcherDirectory),
        );
      } finally {
        await client?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );
});
