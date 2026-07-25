import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  WORKFLOW_COMPLETION_PARAMETERS,
  WORKFLOW_COMPLETION_TOOL,
} from './completion-tool.ts';
import type {
  MainStepRuntimeDependencies,
  MainStepRuntimeState,
} from './main-step-runtime-types.ts';

type RegisterMainStepCompletionOptions = {
  readonly pi: ExtensionAPI;
  readonly state: MainStepRuntimeState;
  readonly dependencies: MainStepRuntimeDependencies;
};

/**
 * Registers the structured tool that captures an active main-step result.
 *
 * @param options - Pi API, runtime state, and injected result parser.
 */
export function registerMainStepCompletion({
  pi,
  state,
  dependencies,
}: RegisterMainStepCompletionOptions): void {
  pi.registerTool({
    name: WORKFLOW_COMPLETION_TOOL,
    label: 'Complete Workflow Step',
    description: 'Return one validated result from an active workflow step',
    promptSnippet: 'Complete the active workflow step',
    promptGuidelines: [
      'Call workflow_complete_step alone after all active workflow-step work is complete.',
    ],
    parameters: WORKFLOW_COMPLETION_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const activeExecution = state.active;
      if (!activeExecution) {
        throw new Error('No main-agent workflow step is active');
      }
      if (state.pendingResult) {
        throw new Error('Main-agent workflow step already produced a result');
      }

      const result = dependencies.parseWorkflowStepResult(
        {
          version: 1,
          policyDigest: activeExecution.policyDigest,
          outcome: params.outcome,
          summary: params.summary,
          ...(params.artifact !== undefined
            ? { artifact: params.artifact }
            : {}),
        },
        activeExecution,
      );
      state.pendingResult = result;
      pi.setActiveTools([]);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Captured workflow step outcome "${result.outcome}".`,
          },
        ],
        details: {
          workflowId: activeExecution.workflowId,
          runId: activeExecution.runId,
          stepId: activeExecution.stepId,
          outcome: result.outcome,
        },
        terminate: true,
      };
    },
  });
}
