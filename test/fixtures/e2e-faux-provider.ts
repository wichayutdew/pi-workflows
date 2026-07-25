import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai';
import {
  E2E_EXECUTE_MARKER,
  E2E_FINAL_SUMMARY,
  E2E_HANDOFF,
  E2E_INPUT_MARKER,
  E2E_MODEL_ID,
  E2E_PLAN_MARKER,
  E2E_PROVIDER_ID,
} from './e2e-values.ts';

interface Observation {
  step: 'plan' | 'execute' | 'unknown';
  promptLength: number;
  userMessageCount: number;
  hasPlanMarker: boolean;
  hasExecuteMarker: boolean;
  hasHandoff: boolean;
  hasWorkflowInput: boolean;
  hasScoutSpecialty: boolean;
  hasReviewerSpecialty: boolean;
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
  const isPlan = user.text.includes('Step: plan (');
  const isExecute = user.text.includes('Step: execute (');
  const step = isPlan === isExecute ? 'unknown' : isPlan ? 'plan' : 'execute';
  const observation: Observation = {
    step,
    promptLength: user.text.length,
    userMessageCount: user.count,
    hasPlanMarker: user.text.includes(E2E_PLAN_MARKER),
    hasExecuteMarker: user.text.includes(E2E_EXECUTE_MARKER),
    hasHandoff: user.text.includes(E2E_HANDOFF),
    hasWorkflowInput: user.text.includes(E2E_INPUT_MARKER),
    hasScoutSpecialty: user.text.includes('Step specialty: scout'),
    hasReviewerSpecialty: user.text.includes('Step specialty: reviewer'),
    violations: [],
  };

  if (user.count !== 1) {
    observation.violations.push(
      `expected one fresh user message, received ${user.count}`,
    );
  }
  if (step === 'plan') {
    if (user.text.length <= 8_000)
      observation.violations.push('plan task did not cross 8K transport limit');
    if (!observation.hasPlanMarker)
      observation.violations.push('plan marker is missing');
    if (!observation.hasScoutSpecialty)
      observation.violations.push('scout specialty is missing');
    if (!observation.hasWorkflowInput)
      observation.violations.push('multiline workflow input is missing');
    if (observation.hasExecuteMarker)
      observation.violations.push('execute prompt leaked into plan context');
    if (observation.hasHandoff)
      observation.violations.push('future handoff leaked into plan context');
  } else if (step === 'execute') {
    if (!observation.hasExecuteMarker)
      observation.violations.push('execute marker is missing');
    if (!observation.hasReviewerSpecialty)
      observation.violations.push('reviewer specialty is missing');
    if (!observation.hasHandoff)
      observation.violations.push('compact plan handoff is missing');
    if (observation.hasPlanMarker)
      observation.violations.push(
        'raw plan context leaked into execute context',
      );
    if (observation.hasWorkflowInput)
      observation.violations.push('workflow input leaked into execute context');
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
          ? { outcome: 'planned', summary: E2E_HANDOFF }
          : { outcome: 'done', summary: E2E_FINAL_SUMMARY };
      return fauxAssistantMessage(
        fauxToolCall('workflow_complete_step', result, {
          id: `e2e-complete-${observation.step}`,
        }),
        { stopReason: 'toolUse' },
      );
    },
  ]);
  pi.registerProvider(faux.provider);
}
