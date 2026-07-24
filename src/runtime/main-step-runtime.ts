import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { WorkflowStep } from '../config/types.ts';
import { invalidCompletionCallIds } from '../policy/completion-batch.ts';
import { freezeToolInput } from '../policy/immutable-input.ts';
import { authorizeToolCall, resolveActiveTools } from '../policy/tools.ts';
import {
  WORKFLOW_COMPLETION_PARAMETERS,
  WORKFLOW_COMPLETION_TOOL,
} from './completion-tool.ts';
import {
  parseWorkflowStepResult,
  type StepResultPolicy,
  type WorkflowStepResult,
} from './step-result.ts';

export interface MainStepExecution extends StepResultPolicy {
  workflowId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  step: WorkflowStep;
  approvedBashCommands: string[];
  onSettled(
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ): Promise<void> | void;
}

export class MainStepRuntime {
  private active: MainStepExecution | undefined;
  private pendingResult: WorkflowStepResult | undefined;
  private invalidCompletionCalls = new Set<string>();
  private suspended = false;

  constructor(private readonly pi: ExtensionAPI) {
    this.registerLifecycle();
    this.registerPolicy();
    this.registerCompletionTool();
  }

  get activeStepId(): string | undefined {
    return this.active?.stepId;
  }

  activate(execution: MainStepExecution): void {
    if (this.active) {
      throw new Error(
        `main workflow step "${this.active.stepId}" is still active`,
      );
    }
    this.suspended = false;
    this.active = execution;
    this.pendingResult = undefined;
    this.invalidCompletionCalls.clear();
    this.pi.setActiveTools(
      resolveActiveTools(
        this.pi.getAllTools(),
        execution.step,
        WORKFLOW_COMPLETION_TOOL,
      ),
    );
  }

  deactivate(): boolean {
    const wasActive = this.active !== undefined;
    this.active = undefined;
    this.pendingResult = undefined;
    this.invalidCompletionCalls.clear();
    return wasActive;
  }

  suspend(): boolean {
    const wasActive = this.deactivate();
    if (wasActive) {
      this.suspended = true;
      this.pi.setActiveTools([]);
    }
    return wasActive;
  }

  release(): void {
    this.suspended = false;
  }

  private registerLifecycle(): void {
    const reset = (): void => {
      this.suspended = false;
      this.deactivate();
      this.pi.setActiveTools(
        this.pi
          .getActiveTools()
          .filter((tool) => tool !== WORKFLOW_COMPLETION_TOOL),
      );
    };
    this.pi.on('session_start', reset);
    this.pi.on('session_tree', reset);
    this.pi.on('session_shutdown', () => {
      this.suspended = false;
      this.deactivate();
    });
    this.pi.on('agent_settled', (_event, context) => {
      const active = this.active;
      if (!active) return;
      const result = this.pendingResult;
      this.active = undefined;
      this.pendingResult = undefined;
      this.invalidCompletionCalls.clear();
      return active.onSettled(result, context);
    });
  }

  private registerPolicy(): void {
    this.pi.on('turn_start', () => {
      this.invalidCompletionCalls.clear();
    });
    this.pi.on('message_end', (event) => {
      if (!this.active) return;
      const invalid = invalidCompletionCallIds(
        event.message,
        WORKFLOW_COMPLETION_TOOL,
      );
      if (
        invalid.size > 0 ||
        (event.message as { role?: unknown }).role === 'assistant'
      ) {
        this.invalidCompletionCalls = invalid;
      }
    });
    this.pi.on('tool_call', (event) => {
      if (this.suspended) {
        return {
          block: true,
          reason: 'Main-agent workflow step is suspended',
        };
      }
      if (!this.active) {
        if (event.toolName === WORKFLOW_COMPLETION_TOOL) {
          return {
            block: true,
            reason: 'No main-agent workflow step is active',
          };
        }
        return;
      }
      if (this.invalidCompletionCalls.has(event.toolCallId)) {
        return {
          block: true,
          reason: `${WORKFLOW_COMPLETION_TOOL} must be the only tool call in its message`,
        };
      }
      if (event.toolName === WORKFLOW_COMPLETION_TOOL) {
        freezeToolInput(event.input);
        return;
      }

      const authorization = authorizeToolCall(
        event.toolName,
        event.input as unknown as Record<string, unknown>,
        this.active.step,
        this.pi.getAllTools(),
        this.active.approvedBashCommands,
      );
      if (!authorization.allowed) {
        return {
          block: true,
          reason:
            authorization.reason ?? 'Tool blocked by main workflow policy',
        };
      }
      freezeToolInput(event.input);
    });
  }

  private registerCompletionTool(): void {
    this.pi.registerTool({
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
        if (!this.active) {
          throw new Error('No main-agent workflow step is active');
        }
        if (this.pendingResult) {
          throw new Error('Main-agent workflow step already produced a result');
        }
        const result = parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: this.active.policyDigest,
            outcome: params.outcome,
            summary: params.summary,
            ...(params.artifact !== undefined
              ? { artifact: params.artifact }
              : {}),
          },
          this.active,
        );
        this.pendingResult = result;
        this.pi.setActiveTools([]);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Captured workflow step outcome "${result.outcome}".`,
            },
          ],
          details: {
            workflowId: this.active.workflowId,
            runId: this.active.runId,
            stepId: this.active.stepId,
            outcome: result.outcome,
          },
          terminate: true,
        };
      },
    });
  }
}
