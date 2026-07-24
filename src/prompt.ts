import type { LoadedWorkflow, WorkflowStep } from "./config/types.ts";
import type { WorkflowRun } from "./engine/state.ts";
import { allowedOutcomes } from "./engine/transitions.ts";

interface TemplateValues {
  [key: string]: string;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    return values[name] ?? "";
  });
}

function templateValues(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  step: WorkflowStep,
): TemplateValues {
  return {
    "workflow.input": run.input,
    "workflow.id": workflow.definition.id,
    "run.id": run.runId,
    "step.id": run.currentStepId,
    "step.title": step.title,
    "last.summary": run.lastSummary,
    "gate.feedback": run.gateFeedback,
  };
}

export function buildDelegatedStepTask(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  policyEnvelope: string,
): string {
  const step = workflow.definition.steps[run.currentStepId];
  if (!step) throw new Error(`unknown workflow step "${run.currentStepId}"`);
  const prompt = renderTemplate(
    workflow.prompts[run.currentStepId] ?? "",
    templateValues(workflow, run, step),
  );
  const outcomes = allowedOutcomes(workflow, run);
  const transitionLines = Object.entries(step.transitions)
    .map(([outcome, target]) => `- ${outcome}: ${target}`)
    .join("\n");
  const gateLine = step.gate
    ? `- ${step.gate.submitOutcome}: submit the artifact to ${step.gate.provider}; include the full artifact argument`
    : "";

  return [
    policyEnvelope,
    "",
    "# Delegated declarative workflow step",
    "",
    `Workflow: ${workflow.definition.id}`,
    `Run: ${run.runId}`,
    `Step: ${run.currentStepId} (${step.title})`,
    "",
    "## Step instructions",
    "",
    prompt,
    "",
    "## Enforced child resources",
    "",
    `Pi tools: ${formatList(step.permissions.tools)}`,
    `MCP selectors: ${formatList(step.permissions.mcp)}`,
    `Extension selectors: ${formatList(step.permissions.extensions)}`,
    `Skills: ${formatList(step.permissions.skills)}`,
    `Bash policy: ${step.permissions.bash.mode}`,
    "",
    "Use only the listed skills for this step. Tool calls are enforced inside this child process.",
    "",
    "## Completion contract",
    "",
    "Call `workflow_complete_step` exactly once, after all work for this delegated step is complete.",
    `Valid outcomes: ${outcomes.join(", ")}`,
    transitionLines,
    gateLine,
    "",
    "Put a concise handoff in `summary`. Do not call the completion tool alongside other tool calls. If the workflow definition or environment is wrong, use an outcome that transitions to `$pause`.",
  ].join("\n");
}

export function buildMainWorkflowNotice(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): string {
  const step = workflow.definition.steps[run.currentStepId];
  if (!step) throw new Error(`unknown workflow step "${run.currentStepId}"`);
  return [
    "# Active subagent workflow",
    "",
    `Workflow "${workflow.definition.id}" is running step "${run.currentStepId}" (${step.title}) in a separate pi-subagents child process.`,
    "Do not perform the workflow step in this main session.",
    "Use `/workflow-status` to inspect it or `/workflow-pause` to cancel the child and repair the workflow before resuming.",
  ].join("\n");
}
