import { EMPTY_REQUIREMENTS } from './types.ts';

export type { ValidationResult } from './validation/shared.ts';
export { validatePromptText } from './validation/prompt.ts';
export { validateSettings } from './validation/settings.ts';
export { validateWorkflow } from './validation/workflow.ts';

type MutableStepRequirements = {
  readonly tools: Array<string>;
  readonly extensions: Array<string>;
  readonly skills: Array<string>;
};

/** Create an independent empty requirements value for mutable consumers. */
export function cloneEmptyRequirements(): MutableStepRequirements {
  return {
    tools: [...EMPTY_REQUIREMENTS.tools],
    extensions: [...EMPTY_REQUIREMENTS.extensions],
    skills: [...EMPTY_REQUIREMENTS.skills],
  };
}
