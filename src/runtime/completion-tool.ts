import { Type } from 'typebox';

export const WORKFLOW_COMPLETION_TOOL = 'workflow_complete_step';

/**
 * Schema accepted by the main-agent workflow completion tool.
 */
export const WORKFLOW_COMPLETION_PARAMETERS = Type.Object(
  {
    outcome: Type.String({
      description: 'One exact outcome allowed by the active workflow step',
    }),
    summary: Type.String({
      description: 'Concise checkpoint and handoff for the next workflow step',
      maxLength: 50_000,
    }),
    artifact: Type.Optional(
      Type.String({
        description: 'Full artifact required when submitting to a review gate',
        maxLength: 200_000,
      }),
    ),
  },
  { additionalProperties: false },
);
