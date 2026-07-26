import { Type } from 'typebox';
import { MAX_WORKSPACE_PATH_CHARS } from '../config/types.ts';

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
    workspace: Type.Optional(
      Type.Object(
        {
          cwd: Type.String({
            description:
              'Absolute working directory established for subsequent workflow steps',
            minLength: 1,
            maxLength: MAX_WORKSPACE_PATH_CHARS,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
