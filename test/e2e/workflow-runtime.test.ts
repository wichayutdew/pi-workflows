import {
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
  E2E_GATE_ARTIFACT_V1,
  E2E_GATE_ARTIFACT_V2,
  E2E_GATE_FEEDBACK,
  E2E_GATE_FINAL_SUMMARY,
  E2E_GATE_INPUT,
  E2E_GATE_MARKER,
  E2E_GATE_MODEL_ID,
  E2E_GATE_PROVIDER_ID,
} from '../fixtures/e2e-gate-values.ts';
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
const START_TIMEOUT_MS = 5_000;

interface WorkflowHistoryEntry {
  stepId: string;
  stepDigest: string;
  outcome: string;
  summary: string;
  workspaceCwd?: string;
  attempts?: unknown[];
  completedAt: number;
}

interface WorkflowCheckpoint {
  status: string;
  currentStepId: string;
  history: WorkflowHistoryEntry[];
  visits?: Record<string, number>;
  lastSummary: string;
  reviewedArtifact?: string;
  reviewedFeedback?: string;
  gateArtifact?: string;
  gateFeedback?: string;
  startCwd?: string;
  cwd?: string;
  pauseReason?: string;
}

interface Observation {
  step: 'bootstrap' | 'plan' | 'implement' | 'verify' | 'unknown';
  visit: number;
  runtimeAgent: string;
  runtimeCwd: string;
  promptLength: number;
  userMessageCount: number;
  hasBootstrapMarker: boolean;
  hasPlanMarker: boolean;
  hasImplementMarker: boolean;
  hasVerifyMarker: boolean;
  hasBootstrapHandoff: boolean;
  hasPlanHandoff: boolean;
  hasRetryHandoff: boolean;
  hasImplementHandoff: boolean;
  hasWorkflowInput: boolean;
  hasExpectedProfile: boolean;
  hasReplanOutcome: boolean;
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

async function startWorkflow(client: RpcClient, prompt: string): Promise<void> {
  const waitForCheckpoint = async (): Promise<boolean> => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    do {
      if (latestCheckpoint((await client.getEntries()).entries)) return true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    } while (Date.now() < deadline);
    return false;
  };

  await client.prompt(prompt);
  if (await waitForCheckpoint()) return;

  // Pi registers extension commands before its async session_start hooks
  // finish. A slow runner can therefore accept the first prompt while this
  // extension is still initializing. Retrying is safe: the workflow mutation
  // queue rejects the duplicate once the first request has started a run.
  await client.prompt(prompt);
  if (await waitForCheckpoint()) return;

  throw new Error(
    `Workflow did not create an initial checkpoint after retry. Pi stderr:\n${client.getStderr()}`,
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
    'binds one workspace and reuses it across a bounded revisit',
    async () => {
      const repositoryRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../..',
      );
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-e2e-'));
      const agentDirectory = join(root, 'agent');
      const workflowDirectory = join(agentDirectory, 'workflows');
      const sessionDirectory = join(root, 'sessions');
      const launcherDirectory = join(root, 'launcher');
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
        start: 'bootstrap',
        maxStepVisits: 3,
        summaryMaxChars: 4_000,
        steps: {
          bootstrap: {
            title: 'Bootstrap',
            prompt: E2E_BOOTSTRAP_MARKER,
            subagent: 'worker',
            workspace: {
              bindOn: ['ready'],
              allowedRoots: ['..'],
            },
            transitions: {
              ready: 'plan',
              retry: 'bootstrap',
              blocked: '$pause',
            },
          },
          plan: {
            title: 'Plan',
            prompt: planPrompt,
            subagent: 'planner',
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
              retry: 'implement',
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
        await mkdir(launcherDirectory, { recursive: true });
        await mkdir(workspaceDirectory, { recursive: true });
        const expectedLauncherDirectory = await realpath(launcherDirectory);
        const expectedWorkspaceDirectory = await realpath(workspaceDirectory);
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
          cwd: launcherDirectory,
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
            PI_WORKFLOWS_E2E_WORKSPACE_CWD: expectedWorkspaceDirectory,
          },
          provider: E2E_PROVIDER_ID,
          model: E2E_MODEL_ID,
          args: ['--offline', '--no-approve'],
        });
        await client.start();
        await waitForCommand(client, 'workflow-doctor');
        await waitForCommand(client, 'work');
        await startWorkflow(
          client,
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
            stepId: 'bootstrap',
            outcome: 'ready',
            summary: E2E_BOOTSTRAP_HANDOFF,
            workspaceCwd: expectedWorkspaceDirectory,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
            attempts: expect.any(Array),
          },
          {
            stepId: 'plan',
            outcome: 'planned',
            summary: E2E_PLAN_HANDOFF,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
            attempts: expect.any(Array),
          },
          {
            stepId: 'implement',
            outcome: 'retry',
            summary: E2E_RETRY_HANDOFF,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
            attempts: expect.any(Array),
          },
          {
            stepId: 'implement',
            outcome: 'implemented',
            summary: E2E_IMPLEMENT_HANDOFF,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
            attempts: expect.any(Array),
          },
          {
            stepId: 'verify',
            outcome: 'done',
            summary: E2E_FINAL_SUMMARY,
            stepDigest: expect.any(String),
            completedAt: expect.any(Number),
            attempts: expect.any(Array),
          },
        ]);
        expect(checkpoint.lastSummary).toBe(E2E_FINAL_SUMMARY);
        expect(checkpoint.startCwd).toBe(expectedLauncherDirectory);
        expect(checkpoint.cwd).toBe(expectedWorkspaceDirectory);

        const observations = parseObservations(
          await readFile(tracePath, 'utf8'),
        );
        expect(observations).toEqual([
          {
            step: 'bootstrap',
            visit: 1,
            runtimeAgent: 'worker',
            runtimeCwd: expectedLauncherDirectory,
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasBootstrapMarker: true,
            hasPlanMarker: false,
            hasImplementMarker: false,
            hasVerifyMarker: false,
            hasBootstrapHandoff: false,
            hasPlanHandoff: false,
            hasRetryHandoff: false,
            hasImplementHandoff: false,
            hasWorkflowInput: false,
            hasExpectedProfile: true,
            hasReplanOutcome: false,
            violations: [],
          },
          {
            step: 'plan',
            visit: 1,
            runtimeAgent: 'planner',
            runtimeCwd: expectedWorkspaceDirectory,
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasBootstrapMarker: false,
            hasPlanMarker: true,
            hasImplementMarker: false,
            hasVerifyMarker: false,
            hasBootstrapHandoff: true,
            hasPlanHandoff: false,
            hasRetryHandoff: false,
            hasImplementHandoff: false,
            hasWorkflowInput: true,
            hasExpectedProfile: true,
            hasReplanOutcome: false,
            violations: [],
          },
          {
            step: 'implement',
            visit: 1,
            runtimeAgent: 'worker',
            runtimeCwd: expectedWorkspaceDirectory,
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasBootstrapMarker: false,
            hasPlanMarker: false,
            hasImplementMarker: true,
            hasVerifyMarker: false,
            hasBootstrapHandoff: false,
            hasPlanHandoff: true,
            hasRetryHandoff: false,
            hasImplementHandoff: false,
            hasWorkflowInput: false,
            hasExpectedProfile: true,
            hasReplanOutcome: false,
            violations: [],
          },
          {
            step: 'implement',
            visit: 2,
            runtimeAgent: 'worker',
            runtimeCwd: expectedWorkspaceDirectory,
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasBootstrapMarker: false,
            hasPlanMarker: false,
            hasImplementMarker: true,
            hasVerifyMarker: false,
            hasBootstrapHandoff: false,
            hasPlanHandoff: false,
            hasRetryHandoff: true,
            hasImplementHandoff: false,
            hasWorkflowInput: false,
            hasExpectedProfile: true,
            hasReplanOutcome: false,
            violations: [],
          },
          {
            step: 'verify',
            visit: 1,
            runtimeAgent: 'reviewer',
            runtimeCwd: expectedWorkspaceDirectory,
            promptLength: expect.any(Number),
            userMessageCount: 1,
            hasBootstrapMarker: false,
            hasPlanMarker: false,
            hasImplementMarker: false,
            hasVerifyMarker: true,
            hasBootstrapHandoff: false,
            hasPlanHandoff: false,
            hasRetryHandoff: false,
            hasImplementHandoff: true,
            hasWorkflowInput: false,
            hasExpectedProfile: true,
            hasReplanOutcome: false,
            violations: [],
          },
        ]);
        expect(observations[1]?.promptLength).toBeGreaterThan(8_000);
        expect(observations[0]?.promptLength).toBeLessThan(8_000);
        expect(observations[2]?.promptLength).toBeLessThan(8_000);
        expect(observations[3]?.promptLength).toBeLessThan(8_000);
        expect(observations[4]?.promptLength).toBeLessThan(8_000);
      } finally {
        await client?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  test(
    'revises a Plannotator artifact until approval beyond the visit limit',
    async () => {
      const repositoryRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../..',
      );
      const root = await mkdtemp(join(tmpdir(), 'pi-workflows-gate-e2e-'));
      const agentDirectory = join(root, 'agent');
      const workflowDirectory = join(agentDirectory, 'workflows');
      const sessionDirectory = join(root, 'sessions');
      const launcherDirectory = join(root, 'launcher');
      const providerTracePath = join(root, 'provider-observations.jsonl');
      const reviewTracePath = join(root, 'review-observations.jsonl');
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
        'e2e-gate-provider.ts',
      );
      const plannotatorExtensionPath = join(
        repositoryRoot,
        'test',
        'fixtures',
        'e2e-faux-plannotator.ts',
      );
      const workflow = {
        version: 1,
        id: 'gate-e2e',
        command: 'gate-e2e',
        description: 'Hermetic real-Pi Plannotator revision test',
        start: 'plan',
        maxStepVisits: 1,
        summaryMaxChars: 4_000,
        steps: {
          plan: {
            title: 'Plan',
            prompt: [
              E2E_GATE_MARKER,
              `Workflow input: {{workflow.input}}`,
              'Rejected artifact:',
              '{{gate.artifact}}',
              'Feedback:',
              '{{gate.feedback}}',
            ].join('\n'),
            subagent: 'planner',
            gate: {
              provider: 'plannotator',
              submitOutcome: 'submit',
              approvedOutcome: 'approved',
              rejectedOutcome: 'changes-requested',
              timeoutMs: 5_000,
            },
            transitions: {
              approved: '$done',
              'changes-requested': 'plan',
              blocked: '$pause',
            },
          },
        },
      };
      const settings = {
        defaultProvider: E2E_GATE_PROVIDER_ID,
        defaultModel: E2E_GATE_MODEL_ID,
        defaultThinkingLevel: 'off',
        defaultProjectTrust: 'never',
        quietStartup: true,
        enableInstallTelemetry: false,
        retry: { enabled: false },
        extensions: [
          workflowExtensionPath,
          subagentExtensionPath,
          providerExtensionPath,
          plannotatorExtensionPath,
        ],
      };

      let client: RpcClient | undefined;
      try {
        await mkdir(workflowDirectory, { recursive: true });
        await mkdir(sessionDirectory, { recursive: true });
        await mkdir(launcherDirectory, { recursive: true });
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
        await writeFile(
          join(workflowDirectory, 'gate-e2e.workflow.yaml'),
          JSON.stringify(workflow),
          'utf8',
        );
        await writeFile(providerTracePath, '', 'utf8');
        await writeFile(reviewTracePath, '', 'utf8');

        client = new RpcClient({
          cliPath,
          cwd: launcherDirectory,
          env: {
            PI_CODING_AGENT_DIR: agentDirectory,
            PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            PI_SUBAGENT_CHILD: '',
            PI_SUBAGENT_CHILD_AGENT: '',
            PI_SUBAGENT_EXTRA_AGENT_DIRS: join(repositoryRoot, 'agents'),
            PI_WORKFLOWS_DIR: workflowDirectory,
            PI_WORKFLOWS_GATE_E2E_PROVIDER_TRACE: providerTracePath,
            PI_WORKFLOWS_GATE_E2E_REVIEW_TRACE: reviewTracePath,
          },
          provider: E2E_GATE_PROVIDER_ID,
          model: E2E_GATE_MODEL_ID,
          args: ['--offline', '--no-approve'],
        });
        await client.start();
        await waitForCommand(client, 'gate-e2e');
        await startWorkflow(client, `/gate-e2e ${E2E_GATE_INPUT}`);

        const checkpoint = await waitForTerminalCheckpoint(client);
        if (checkpoint.status !== 'completed') {
          throw new Error(
            `Gate workflow ended ${checkpoint.status}: ${
              checkpoint.pauseReason ?? 'no reason'
            }\nProvider trace:\n${await readFile(providerTracePath, 'utf8')}\nReview trace:\n${await readFile(reviewTracePath, 'utf8')}\nPi stderr:\n${client.getStderr()}`,
          );
        }

        expect(checkpoint.visits?.plan).toBe(2);
        expect(checkpoint.history.map((entry) => entry.outcome)).toEqual([
          'changes-requested',
          'approved',
        ]);
        expect(checkpoint.lastSummary).toBe(E2E_GATE_FINAL_SUMMARY);
        expect(checkpoint.reviewedArtifact).toBe(E2E_GATE_ARTIFACT_V2);
        expect(checkpoint.reviewedFeedback).toBe('Approved in E2E');
        expect(checkpoint.gateArtifact).toBe('');
        expect(checkpoint.gateFeedback).toBe('');

        const providerObservations = (await readFile(providerTracePath, 'utf8'))
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                visit: number;
                runtimeAgent: string;
                hasMarker: boolean;
                hasInput: boolean;
                hasRejectedArtifact: boolean;
                hasFeedback: boolean;
              },
          );
        expect(providerObservations).toEqual([
          {
            visit: 1,
            runtimeAgent: 'planner',
            hasMarker: true,
            hasInput: true,
            hasRejectedArtifact: false,
            hasFeedback: false,
          },
          {
            visit: 2,
            runtimeAgent: 'planner',
            hasMarker: true,
            hasInput: true,
            hasRejectedArtifact: true,
            hasFeedback: true,
          },
        ]);

        const reviews = (await readFile(reviewTracePath, 'utf8'))
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                iteration: number;
                reviewId: string;
                planContent: string;
              },
          );
        expect(reviews).toEqual([
          {
            iteration: 1,
            reviewId: 'gate-e2e-review-1',
            planContent: E2E_GATE_ARTIFACT_V1,
          },
          {
            iteration: 2,
            reviewId: 'gate-e2e-review-2',
            planContent: E2E_GATE_ARTIFACT_V2,
          },
        ]);
        expect(providerObservations[1]?.hasFeedback).toBe(
          E2E_GATE_FEEDBACK.length > 0,
        );
      } finally {
        await client?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );
});
