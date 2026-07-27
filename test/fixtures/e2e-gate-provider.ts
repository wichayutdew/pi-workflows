import { appendFileSync, readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai';
import {
  E2E_GATE_ARTIFACT_V1,
  E2E_GATE_ARTIFACT_V2,
  E2E_GATE_FEEDBACK,
  E2E_GATE_INPUT,
  E2E_GATE_MARKER,
  E2E_GATE_MODEL_ID,
  E2E_GATE_PROVIDER_ID,
} from './e2e-gate-values.ts';

type GateObservation = {
  readonly visit: number;
  readonly runtimeAgent: string;
  readonly hasMarker: boolean;
  readonly hasInput: boolean;
  readonly hasRejectedArtifact: boolean;
  readonly hasFeedback: boolean;
};

function tracePath(): string {
  const path = process.env.PI_WORKFLOWS_GATE_E2E_PROVIDER_TRACE?.trim();
  if (!path) {
    throw new Error('PI_WORKFLOWS_GATE_E2E_PROVIDER_TRACE is required');
  }
  return path;
}

function promptText(context: Context): string {
  return context.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text),
    )
    .join('\n');
}

function nextVisit(): number {
  return (
    readFileSync(tracePath(), 'utf8').trim().split('\n').filter(Boolean)
      .length + 1
  );
}

export default function e2eGateProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: E2E_GATE_PROVIDER_ID,
    models: [{ id: E2E_GATE_MODEL_ID, reasoning: false }],
  });
  faux.setResponses([
    (context) => {
      const text = promptText(context);
      const visit = nextVisit();
      const observation: GateObservation = {
        visit,
        runtimeAgent: process.env.PI_SUBAGENT_CHILD_AGENT?.trim() ?? '',
        hasMarker: text.includes(E2E_GATE_MARKER),
        hasInput: text.includes(E2E_GATE_INPUT),
        hasRejectedArtifact: text.includes(E2E_GATE_ARTIFACT_V1),
        hasFeedback: text.includes(E2E_GATE_FEEDBACK),
      };
      appendFileSync(tracePath(), `${JSON.stringify(observation)}\n`, 'utf8');

      const expectedRevisionContext = visit === 2;
      if (
        visit > 2 ||
        observation.runtimeAgent !== 'planner' ||
        !observation.hasMarker ||
        !observation.hasInput ||
        observation.hasRejectedArtifact !== expectedRevisionContext ||
        observation.hasFeedback !== expectedRevisionContext
      ) {
        throw new Error(
          `invalid gate revision context: ${JSON.stringify(observation)}`,
        );
      }

      return fauxAssistantMessage(
        fauxToolCall(
          'structured_output',
          {
            value: {
              outcome: 'submit',
              summary: `Gate plan v${visit} ready`,
              artifact:
                visit === 1 ? E2E_GATE_ARTIFACT_V1 : E2E_GATE_ARTIFACT_V2,
            },
          },
          { id: `gate-e2e-complete-${visit}` },
        ),
        { stopReason: 'toolUse' },
      );
    },
  ]);
  pi.registerProvider(faux.provider);
}
