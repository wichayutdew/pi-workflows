import { appendFileSync, readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai';
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
} from './e2e-values.ts';

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

function tracePath(): string {
  const path = process.env.PI_WORKFLOWS_E2E_TRACE_PATH?.trim();
  if (!path) {
    throw new Error('PI_WORKFLOWS_E2E_TRACE_PATH is required');
  }
  return path;
}

function workspaceCwd(): string {
  const path = process.env.PI_WORKFLOWS_E2E_WORKSPACE_CWD?.trim();
  if (!path) {
    throw new Error('PI_WORKFLOWS_E2E_WORKSPACE_CWD is required');
  }
  return path;
}

function nextVisit(step: Observation['step']): number {
  const observations = readFileSync(tracePath(), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
  return (
    observations.filter((observation) => observation.step === step).length + 1
  );
}

function userMessageText(context: Context): {
  count: number;
  text: string;
} {
  const messages = context.messages.filter(
    (message) => message.role === 'user',
  );
  return {
    count: messages.length,
    text: messages
      .flatMap((message) =>
        typeof message.content === 'string'
          ? [message.content]
          : message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text),
      )
      .join('\n'),
  };
}

function observe(context: Context): Observation {
  const user = userMessageText(context);
  const matchedSteps = (
    [
      ['bootstrap', 'Step: bootstrap ('],
      ['plan', 'Step: plan ('],
      ['implement', 'Step: implement ('],
      ['verify', 'Step: verify ('],
    ] as const
  )
    .filter(([, marker]) => user.text.includes(marker))
    .map(([step]) => step);
  const step =
    matchedSteps.length === 1 ? (matchedSteps[0] ?? 'unknown') : 'unknown';
  const expectedAgent =
    step === 'bootstrap'
      ? 'worker'
      : step === 'plan'
        ? 'scout'
        : step === 'implement'
          ? 'worker'
          : step === 'verify'
            ? 'reviewer'
            : '';
  const observation: Observation = {
    step,
    visit: nextVisit(step),
    runtimeAgent: process.env.PI_SUBAGENT_CHILD_AGENT?.trim() ?? '',
    runtimeCwd: process.cwd(),
    promptLength: user.text.length,
    userMessageCount: user.count,
    hasBootstrapMarker: user.text.includes(E2E_BOOTSTRAP_MARKER),
    hasPlanMarker: user.text.includes(E2E_PLAN_MARKER),
    hasImplementMarker: user.text.includes(E2E_IMPLEMENT_MARKER),
    hasVerifyMarker: user.text.includes(E2E_VERIFY_MARKER),
    hasBootstrapHandoff: user.text.includes(E2E_BOOTSTRAP_HANDOFF),
    hasPlanHandoff: user.text.includes(E2E_PLAN_HANDOFF),
    hasRetryHandoff: user.text.includes(E2E_RETRY_HANDOFF),
    hasImplementHandoff: user.text.includes(E2E_IMPLEMENT_HANDOFF),
    hasWorkflowInput: user.text.includes(E2E_INPUT_MARKER),
    hasExpectedProfile:
      expectedAgent.length > 0 &&
      user.text.includes(`Agent profile: ${expectedAgent}`),
    hasReplanOutcome: /Valid outcomes:.*\breplan\b/i.test(user.text),
    violations: [],
  };

  if (user.count !== 1) {
    observation.violations.push(
      `expected one fresh user message, received ${user.count}`,
    );
  }
  if (step !== 'unknown') {
    if (observation.runtimeAgent !== expectedAgent) {
      observation.violations.push(
        `expected ${expectedAgent} runtime, received ${observation.runtimeAgent || '(empty)'}`,
      );
    }
    if (!observation.hasExpectedProfile) {
      observation.violations.push(`${expectedAgent} profile is missing`);
    }
    if (observation.hasReplanOutcome) {
      observation.violations.push('unexpected replan outcome is present');
    }
  }
  if (step === 'bootstrap') {
    if (!observation.hasBootstrapMarker)
      observation.violations.push('bootstrap marker is missing');
    if (
      observation.hasPlanMarker ||
      observation.hasImplementMarker ||
      observation.hasVerifyMarker ||
      observation.hasBootstrapHandoff ||
      observation.hasPlanHandoff ||
      observation.hasRetryHandoff ||
      observation.hasImplementHandoff
    ) {
      observation.violations.push(
        'future context leaked into bootstrap context',
      );
    }
  } else if (step === 'plan') {
    if (user.text.length <= 8_000)
      observation.violations.push('plan task did not cross 8K transport limit');
    if (!observation.hasPlanMarker)
      observation.violations.push('plan marker is missing');
    if (!observation.hasBootstrapHandoff)
      observation.violations.push('workspace handoff is missing');
    if (!observation.hasWorkflowInput)
      observation.violations.push('multiline workflow input is missing');
    if (
      observation.hasBootstrapMarker ||
      observation.hasImplementMarker ||
      observation.hasVerifyMarker
    )
      observation.violations.push('future prompt leaked into plan context');
    if (
      observation.hasPlanHandoff ||
      observation.hasRetryHandoff ||
      observation.hasImplementHandoff
    )
      observation.violations.push('future handoff leaked into plan context');
  } else if (step === 'implement') {
    if (!observation.hasImplementMarker)
      observation.violations.push('implement marker is missing');
    if (observation.visit === 1 && !observation.hasPlanHandoff)
      observation.violations.push('compact plan handoff is missing');
    if (observation.visit === 2 && !observation.hasRetryHandoff)
      observation.violations.push('compact retry handoff is missing');
    if (observation.visit > 2)
      observation.violations.push('implement revisited more than once');
    if (
      observation.hasBootstrapMarker ||
      observation.hasPlanMarker ||
      observation.hasVerifyMarker ||
      observation.hasBootstrapHandoff ||
      observation.hasImplementHandoff ||
      (observation.visit === 1 && observation.hasRetryHandoff) ||
      (observation.visit === 2 && observation.hasPlanHandoff)
    ) {
      observation.violations.push(
        'unrelated context leaked into implement context',
      );
    }
    if (observation.hasWorkflowInput)
      observation.violations.push(
        'workflow input leaked into implement context',
      );
  } else if (step === 'verify') {
    if (!observation.hasVerifyMarker)
      observation.violations.push('verify marker is missing');
    if (!observation.hasImplementHandoff)
      observation.violations.push('compact implementation handoff is missing');
    if (
      observation.hasBootstrapMarker ||
      observation.hasPlanMarker ||
      observation.hasImplementMarker ||
      observation.hasBootstrapHandoff ||
      observation.hasPlanHandoff ||
      observation.hasRetryHandoff
    ) {
      observation.violations.push(
        'prior raw context leaked into verify context',
      );
    }
    if (observation.hasWorkflowInput)
      observation.violations.push('workflow input leaked into verify context');
  } else {
    observation.violations.push('could not identify delegated workflow step');
  }

  return observation;
}

function record(observation: Observation): void {
  appendFileSync(tracePath(), `${JSON.stringify(observation)}\n`, {
    encoding: 'utf8',
  });
}

export default function e2eFauxProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: E2E_PROVIDER_ID,
    models: [{ id: E2E_MODEL_ID, reasoning: false }],
  });
  faux.setResponses([
    (context) => {
      const observation = observe(context);
      record(observation);
      if (observation.violations.length > 0) {
        throw new Error(observation.violations.join('; '));
      }

      const result =
        observation.step === 'bootstrap'
          ? {
              outcome: 'ready',
              summary: E2E_BOOTSTRAP_HANDOFF,
              workspace: { cwd: workspaceCwd() },
            }
          : observation.step === 'plan'
            ? { outcome: 'planned', summary: E2E_PLAN_HANDOFF }
            : observation.step === 'implement'
              ? observation.visit === 1
                ? { outcome: 'retry', summary: E2E_RETRY_HANDOFF }
                : { outcome: 'implemented', summary: E2E_IMPLEMENT_HANDOFF }
              : { outcome: 'done', summary: E2E_FINAL_SUMMARY };
      return fauxAssistantMessage(
        fauxToolCall(
          'structured_output',
          { value: result },
          {
            id: `e2e-complete-${observation.step}`,
          },
        ),
        { stopReason: 'toolUse' },
      );
    },
  ]);
  pi.registerProvider(faux.provider);
}
