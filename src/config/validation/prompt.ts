const PROMPT_VARIABLES = new Set([
  'workflow.input',
  'workflow.id',
  'run.id',
  'step.id',
  'step.title',
  'last.summary',
  'reviewed.artifact',
  'reviewed.feedback',
  'gate.feedback',
  'resume.input',
]);

/** Validate template variables embedded in resolved prompt text. */
export function validatePromptText(text: string, path: string): Array<string> {
  return [...text.matchAll(/\{\{([^{}]+)\}\}/g)].flatMap((match) => {
    const variable = match[1]?.trim() ?? '';
    return PROMPT_VARIABLES.has(variable)
      ? []
      : [`${path}: unknown prompt variable "{{${variable}}}"`];
  });
}
