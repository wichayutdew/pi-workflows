import { digest } from '../digest.ts';
import type { WorkflowStep } from '../../domain/index.ts';

/**
 * Digests a normalized workflow step together with its resolved prompt text.
 */
export function digestWorkflowStep(step: WorkflowStep, prompt: string): string {
  return digest({ step, prompt });
}

/**
 * Digests every normalized workflow-step field except the prompt specification.
 */
export function digestWorkflowStepStructure(step: WorkflowStep): string {
  const structure = Object.fromEntries(
    Object.entries(step).filter(([key]) => key !== 'prompt'),
  );
  return digest(structure);
}
