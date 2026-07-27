import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PLANNOTATOR_RESULT_CHANNEL,
} from '../../src/integrations/plannotator.ts';
import { E2E_GATE_FEEDBACK } from './e2e-gate-values.ts';

function tracePath(): string {
  const path = process.env.PI_WORKFLOWS_GATE_E2E_REVIEW_TRACE?.trim();
  if (!path) {
    throw new Error('PI_WORKFLOWS_GATE_E2E_REVIEW_TRACE is required');
  }
  return path;
}

export default function e2eFauxPlannotator(pi: ExtensionAPI): void {
  let iteration = 0;
  pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, (value) => {
    const request = value as {
      readonly action?: string;
      readonly payload?: { readonly planContent?: string };
      readonly respond?: (response: unknown) => void;
    };
    if (request.action !== 'plan-review' || !request.respond) return;

    iteration += 1;
    const currentIteration = iteration;
    const reviewId = `gate-e2e-review-${currentIteration}`;
    appendFileSync(
      tracePath(),
      `${JSON.stringify({
        iteration: currentIteration,
        reviewId,
        planContent: request.payload?.planContent ?? '',
      })}\n`,
      'utf8',
    );
    request.respond({
      status: 'handled',
      result: { status: 'pending', reviewId },
    });

    setTimeout(() => {
      pi.events.emit(PLANNOTATOR_RESULT_CHANNEL, {
        reviewId,
        approved: currentIteration === 2,
        feedback:
          currentIteration === 1 ? E2E_GATE_FEEDBACK : 'Approved in E2E',
      });
    }, 50);
  });
}
