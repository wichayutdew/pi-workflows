import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { RpcClient, type SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  E2E_FINAL_SUMMARY,
  E2E_IMPLEMENT_HANDOFF,
  E2E_IMPLEMENT_MARKER,
  E2E_INPUT_MARKER,
  E2E_MODEL_ID,
  E2E_PLAN_HANDOFF,
  E2E_PLAN_MARKER,
  E2E_PROVIDER_ID,
  E2E_VERIFY_MARKER,
} from '../fixtures/e2e-values.ts';

const STATE_ENTRY_TYPE = 'pi-workflows-state-v1';
const TEST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 45_000;

interface WorkflowHistoryEntry {
  stepId: string;
  stepDigest: string;
  outcome: string;
  summary: string;
  completedAt: number;
}

interface WorkflowCheckpoint {
  status: string;
  currentStepId: string;
  history: WorkflowHistoryEntry[];
  lastSummary: string;
  pauseReason?: string;
}

interface Observation {
  step: 'plan' | 'implement' | 'verify' | 'unknown';
  runtimeAgent: string;
  promptLength: number;
  userMessageCount: number;
  hasPlanMarker: boolean;
  hasImplementMarker: boolean;
  hasVerifyMarker: boolean;
  hasPlanHandoff: boolean;
  hasImplementHandoff: boolean;
  hasWorkflowInput: boolean;
  hasExpectedProfile: boolean;
  violations: string[];
}

function isCheckpoint(value: unknown): value is WorkflowCheckpoint {
  if (value === null || typeof value !== 'object') return false;
  const checkpoint = value as Partial<WorkflowCheckpoint>;
  return (
    typeof checkpoint.status === 'string' &&
    typeof checkpoint.currentStepId === 'string' &&
    Array.isArray(checkpoint.history) &&
    typeof checkpoint.lastSummary === 'string'
  );
}

function latestCheckpoint(
  entries: SessionEntry[],
): WorkflowCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === 'custom' &&
      entry.customType === STATE_ENTRY_TYPE &&
      isCheckpoint(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

async function waitForCommand(
  client: RpcClient,
  commandName: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    if (
      (await client.getCommands()).some(
        (command) => command.name === commandName,
      )
    )
      return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  } while (Date.now() < deadline);
  throw new Error(`Pi did not register /${commandName}`);
}

async function waitForTerminalCheckpoint(
  client: RpcClient,
): Promise<WorkflowCheckpoint> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let observed: WorkflowCheckpoint | undefined;
  do {
    const response = await client.getEntries();
    observed = latestCheckpoint(response.entries) ?? observed;
    if (
      observed?.status === 'completed' ||
      observed?.status === 'paused' ||
      observed?.status === 'aborted'
    ) {
      return observed;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (Date.now() < deadline);

  throw new Error(
    `Timed out waiting for workflow completion. Last checkpoint: ${JSON.stringify(
      observed,
    )}\nPi stderr:\n${client.getStderr()}`,
  );
}

function parseObservations(text: string): Observation[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
}

describe('when running a workflow through real Pi subprocesses', () => {
  test(
    'preserves correlated completion and passes only compact context between specialized children',
    async () => {
      const repositoryRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../..',
      );
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-e2e-'));
      const agentDirectory = join(root, 'agent');
      const workflowDirectory = join(agentDirectory, 'workflows');
      const sessionDirectory = join(root, 'sessions');
      const workspaceDirectory = join(root, 'workspace');
      const tracePath = join(root, 'child-observations.jsonl');
      const workflowPath = join(workflowDirectory, 'runtime-e2e.workflow.yaml');
      const cliPath = join(
        repositoryRoot,
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'cli.js',
      );
      const workflowExtensionPath = join(repositoryRoot, 'src', 'index.ts');
      const subagentExtensionPath = join(
        repositoryRoot,
        'node_modules',
        'pi-subagents',
        'index.ts',
      );
      const providerExtensionPath = join(
        repositoryRoot,
        'test',
        'fixtures',
        'e2e-faux-provider.ts',
      );
      const planPrompt = [
        E2E_PLAN_MARKER,
        'Workflow input: {{workflow.input}}',
        'Create a compact implementation handoff.',
        'PRIVATE_PLAN_PADDING '.repeat(500),
      ].join('\n');
      const workflow = {
        version: 1,
        id: 'runtime-e2e',
        command: 'work',
        description: 'Hermetic real-Pi workflow runtime test',
        start: 'plan',
        summaryMaxChars: 4_000,
        steps: {
          plan: {
            title: 'Plan',
            prompt: planPrompt,
            subagent: 'scout',
            transitions: {
              planned: 'implement',
              blocked: '$pause',
            },
          },
          implement: {
            title: 'Implement',
            prompt: `${E2E_IMPLEMENT_MARKER}\nConsume only the compact handoff: {{last.summary}}`,
            subagent: 'worker',
            transitions: {
              implemented: 'verify',
              blocked: '$pause',
            },
          },
          verify: {
            title: 'Verify',
            prompt: `${E2E_VERIFY_MARKER}\nConsume only the compact handoff: {{last.summary}}`,
            subagent: 'reviewer',
            transitions: {
              done: '$done',
              blocked: '$pause',
            },
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
        extensions: [
          workflowExtensionPath,
          subagentExtensionPath,
          providerExtensionPath,
        ],
      };

      let client: RpcClient | undefined;
      try {
        await mkdir(workflowDirectory, { recursive: true });
        await mkdir(sessionDirectory, { recursive: true });
        await mkdir(workspaceDirectory, { recursive: true });
        await writeFile(
          join(agentDirectory, 'settings.json'),
          JSON.stringify(settings),
          'utf8',
        );
        await writeFile(
          join(workflowDirectory, 'settings.yaml'),
          JSON.stringify({ version: 1 }),
          'utf8',
        );
        await writeFile(workflowPath, JSON.stringify(workflow), 'utf8');
        await writeFile(tracePath, '', 'utf8');

        client = new RpcClient({
          cliPath,
          cwd: workspaceDirectory,
          env: {
            PI_CODING_AGENT_DIR: agentDirectory,
            PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            // RpcClient inherits its caller's environment. This test starts the
            // parent Pi process, while pi-subagents sets these values itself
            // only for delegated child processes.
            PI_SUBAGENT_CHILD: '',
            PI_SUBAGENT_CHILD_AGENT: '',
            PI_SUBAGENT_EXTRA_AGENT_DIRS: join(repositoryRoot, 'agents'),
            PI_WORKFLOWS_DIR: workflowDirectory,
            PI_WORKFLOWS_E2E_TRACE_PATH: tracePath,
          },
          provider: E2E_PROVIDER_ID,
          model: E2E_MODEL_ID,
          args: ['--offline', '--no-approve'],
        });
        await client.start();
        await waitForCommand(client, 'work');
        await client.prompt(
          `/work\n${E2E_INPUT_MARKER}: implement the deterministic subprocess smoke request.`,
        );

        const checkpoint = await waitForTerminalCheckpoint(client);
        if (checkpoint.status !== 'completed') {
          const trace = await readFile(tracePath, 'utf8').catch(
            (error: unknown) => `Could not read child trace: ${String(error)}`,
          );
          throw new Error(
            `Workflow ended ${checkpoint.status} at ${checkpoint.currentStepId}: ${
              checkpoint.pauseReason ?? 'no reason'
            }\nChild trace:\n${trace || '(empty)'}\nPi stderr:\n${client.getStderr()}`,
          );
        }
        expect(checkpoint.history).toEqual([
          {
            stepId: 'plan',
            outcome: 'planned',
            summary: E2E_PLAN_HANDOFF,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
          },
          {
            stepId: 'implement',
            outcome: 'implemented',
            summary: E2E_IMPLEMENT_HANDOFF,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
          },
          {
            stepId: 'verify',
            outcome: 'done',
            summary: E2E_FINAL_SUMMARY,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
          },
        ]);
        expect(checkpoint.lastSummary).toBe(E2E_FINAL_SUMMARY);

        const observations = parseObservations(
          await readFile(tracePath, 'utf8'),
        );
        expect(observations).toEqual([
          {
            step: 'plan',
            runtimeAgent: 'scout',
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasPlanMarker: true,
            hasImplementMarker: false,
            hasVerifyMarker: false,
            hasPlanHandoff: false,
            hasImplementHandoff: false,
            hasWorkflowInput: true,
            hasExpectedProfile: true,
            violations: [],
          },
          {
            step: 'implement',
            runtimeAgent: 'worker',
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasPlanMarker: false,
            hasImplementMarker: true,
            hasVerifyMarker: false,
            hasPlanHandoff: true,
            hasImplementHandoff: false,
            hasWorkflowInput: false,
            hasExpectedProfile: true,
            violations: [],
          },
          {
            step: 'verify',
            runtimeAgent: 'reviewer',
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasPlanMarker: false,
            hasImplementMarker: false,
            hasVerifyMarker: true,
            hasPlanHandoff: false,
            hasImplementHandoff: true,
            hasWorkflowInput: false,
            hasExpectedProfile: true,
            violations: [],
          },
        ]);
        expect(observations[0]?.promptLength).toBeGreaterThan(8_000);
        expect(observations[1]?.promptLength).toBeLessThan(8_000);
        expect(observations[2]?.promptLength).toBeLessThan(8_000);
      } finally {
        await client?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );
});
