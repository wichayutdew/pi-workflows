import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai';
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
} from './e2e-values.ts';

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
    step === 'plan'
      ? 'scout'
      : step === 'implement'
        ? 'worker'
        : step === 'verify'
          ? 'reviewer'
          : '';
  const observation: Observation = {
    step,
    runtimeAgent: process.env.PI_SUBAGENT_CHILD_AGENT?.trim() ?? '',
    promptLength: user.text.length,
    userMessageCount: user.count,
    hasPlanMarker: user.text.includes(E2E_PLAN_MARKER),
    hasImplementMarker: user.text.includes(E2E_IMPLEMENT_MARKER),
    hasVerifyMarker: user.text.includes(E2E_VERIFY_MARKER),
    hasPlanHandoff: user.text.includes(E2E_PLAN_HANDOFF),
    hasImplementHandoff: user.text.includes(E2E_IMPLEMENT_HANDOFF),
    hasWorkflowInput: user.text.includes(E2E_INPUT_MARKER),
    hasExpectedProfile:
      expectedAgent.length > 0 &&
      user.text.includes(`Agent profile: ${expectedAgent}`),
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
  }
  if (step === 'plan') {
    if (user.text.length <= 8_000)
      observation.violations.push('plan task did not cross 8K transport limit');
    if (!observation.hasPlanMarker)
      observation.violations.push('plan marker is missing');
    if (!observation.hasWorkflowInput)
      observation.violations.push('multiline workflow input is missing');
    if (observation.hasImplementMarker || observation.hasVerifyMarker)
      observation.violations.push('future prompt leaked into plan context');
    if (observation.hasPlanHandoff || observation.hasImplementHandoff)
      observation.violations.push('future handoff leaked into plan context');
  } else if (step === 'implement') {
    if (!observation.hasImplementMarker)
      observation.violations.push('implement marker is missing');
    if (!observation.hasPlanHandoff)
      observation.violations.push('compact plan handoff is missing');
    if (
      observation.hasPlanMarker ||
      observation.hasVerifyMarker ||
      observation.hasImplementHandoff
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
      observation.hasPlanMarker ||
      observation.hasImplementMarker ||
      observation.hasPlanHandoff
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
  const tracePath = process.env.PI_WORKFLOWS_E2E_TRACE_PATH?.trim();
  if (!tracePath) {
    throw new Error('PI_WORKFLOWS_E2E_TRACE_PATH is required');
  }
  appendFileSync(tracePath, `${JSON.stringify(observation)}\n`, {
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
        observation.step === 'plan'
          ? { outcome: 'planned', summary: E2E_PLAN_HANDOFF }
          : observation.step === 'implement'
            ? { outcome: 'implemented', summary: E2E_IMPLEMENT_HANDOFF }
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
