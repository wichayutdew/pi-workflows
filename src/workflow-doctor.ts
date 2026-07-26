import type { WorkflowDefinition, WorkflowStep } from './config/types.ts';

export type WorkflowDoctorLevel = 'error' | 'warning';

export type WorkflowDoctorIssue = {
  readonly level: WorkflowDoctorLevel;
  readonly code:
    | 'no-completion-path'
    | 'reachable-step-cannot-reach-done'
    | 'unreachable-steps'
    | 'cycle';
  readonly steps: ReadonlyArray<string>;
  readonly message: string;
  readonly reachable?: boolean;
  readonly canReachDone?: boolean;
};

export type WorkflowDoctorReport = {
  readonly workflowId: string;
  readonly maxStepVisits: number;
  readonly reachableSteps: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<WorkflowDoctorIssue>;
};

const lexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const internalTargets = (step: WorkflowStep): ReadonlyArray<string> =>
  [
    ...new Set(
      Object.values(step.transitions).filter(
        (target) => target !== '$done' && target !== '$pause',
      ),
    ),
  ].sort(lexical);

const adjacencyFor = (
  definition: WorkflowDefinition,
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    Object.entries(definition.steps)
      .sort(([left], [right]) => lexical(left, right))
      .map(([stepId, step]) => [stepId, internalTargets(step)]),
  );

const reachableSteps = (
  definition: WorkflowDefinition,
  adjacency: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlySet<string> => {
  const reachable = new Set<string>();
  const pending = [definition.start];
  while (pending.length > 0) {
    const stepId = pending.pop();
    if (!stepId || reachable.has(stepId)) continue;
    if (!definition.steps[stepId]) continue;
    reachable.add(stepId);
    pending.push(...(adjacency[stepId] ?? []));
  }
  return reachable;
};

const stepsThatCanComplete = (
  definition: WorkflowDefinition,
  adjacency: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlySet<string> => {
  const canComplete = new Set<string>(
    Object.entries(definition.steps)
      .filter(([, step]) => Object.values(step.transitions).includes('$done'))
      .map(([stepId]) => stepId),
  );

  const reverse = new Map<string, Array<string>>();
  for (const [source, targets] of Object.entries(adjacency)) {
    for (const target of targets) {
      reverse.set(target, [...(reverse.get(target) ?? []), source]);
    }
  }
  const pending = [...canComplete].sort(lexical);
  while (pending.length > 0) {
    const stepId = pending.pop();
    if (!stepId) continue;
    for (const predecessor of (reverse.get(stepId) ?? []).sort(lexical)) {
      if (canComplete.has(predecessor)) continue;
      canComplete.add(predecessor);
      pending.push(predecessor);
    }
  }
  return canComplete;
};

const stronglyConnectedComponents = (
  definition: WorkflowDefinition,
  adjacency: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: Array<string> = [];
  const onStack = new Set<string>();
  const components: Array<Array<string>> = [];

  const visit = (stepId: string): void => {
    indexes.set(stepId, nextIndex);
    lowLinks.set(stepId, nextIndex);
    nextIndex += 1;
    stack.push(stepId);
    onStack.add(stepId);

    for (const target of adjacency[stepId] ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(
          stepId,
          Math.min(lowLinks.get(stepId) ?? 0, lowLinks.get(target) ?? 0),
        );
      } else if (onStack.has(target)) {
        lowLinks.set(
          stepId,
          Math.min(lowLinks.get(stepId) ?? 0, indexes.get(target) ?? 0),
        );
      }
    }

    if (lowLinks.get(stepId) !== indexes.get(stepId)) return;
    const component: Array<string> = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== stepId);
    components.push(component.sort(lexical));
  };

  for (const stepId of Object.keys(definition.steps).sort(lexical)) {
    if (!indexes.has(stepId)) visit(stepId);
  }
  return components.sort((left, right) =>
    lexical(left.join('\0'), right.join('\0')),
  );
};

const isCycle = (
  adjacency: Readonly<Record<string, ReadonlyArray<string>>>,
  component: ReadonlyArray<string>,
): boolean => {
  if (component.length > 1) return true;
  const [stepId] = component;
  return Boolean(stepId && adjacency[stepId]?.includes(stepId));
};

/**
 * Analyzes only the declarative transition graph. Outcome names and prompt
 * content are intentionally opaque to the workflow engine.
 */
export function analyzeWorkflow(
  definition: WorkflowDefinition,
): WorkflowDoctorReport {
  const adjacency = adjacencyFor(definition);
  const reachable = reachableSteps(definition, adjacency);
  const canComplete = stepsThatCanComplete(definition, adjacency);
  const issues: Array<WorkflowDoctorIssue> = [];
  const stranded = [...reachable]
    .filter((stepId) => !canComplete.has(stepId))
    .sort(lexical);
  if (!canComplete.has(definition.start)) {
    issues.push({
      level: 'error',
      code: 'no-completion-path',
      steps: [definition.start],
      message: `start step ${definition.start} cannot reach $done`,
    });
  }
  if (stranded.length > 0) {
    issues.push({
      level: 'error',
      code: 'reachable-step-cannot-reach-done',
      steps: stranded,
      message: `reachable step${stranded.length === 1 ? '' : 's'} ${stranded.join(', ')} cannot reach $done`,
    });
  }

  const unreachable = Object.keys(definition.steps)
    .filter((stepId) => !reachable.has(stepId))
    .sort(lexical);
  if (unreachable.length > 0) {
    issues.push({
      level: 'warning',
      code: 'unreachable-steps',
      steps: unreachable,
      message: `unreachable step${unreachable.length === 1 ? '' : 's'}: ${unreachable.join(', ')}`,
    });
  }

  for (const component of stronglyConnectedComponents(definition, adjacency)) {
    if (!isCycle(adjacency, component)) continue;
    const componentIsReachable = component.some((stepId) =>
      reachable.has(stepId),
    );
    const componentCanReachDone = component.some((stepId) =>
      canComplete.has(stepId),
    );
    issues.push({
      level: 'warning',
      code: 'cycle',
      steps: component,
      reachable: componentIsReachable,
      canReachDone: componentCanReachDone,
      message: `${componentIsReachable ? 'reachable' : 'unreachable'} cyclic component: ${component.join(', ')}; ${componentCanReachDone ? 'an exit can reach $done' : 'no member can reach $done'}; maxStepVisits=${definition.maxStepVisits} bounds uninterrupted graph cycling`,
    });
  }

  return {
    workflowId: definition.id,
    maxStepVisits: definition.maxStepVisits,
    reachableSteps: [...reachable].sort(lexical),
    issues,
  };
}

const escapeMarkdown = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|');

/** Formats one or more graph reports for `/workflow-doctor`. */
export function formatWorkflowDoctor(
  reports: ReadonlyArray<WorkflowDoctorReport>,
): string {
  const lines = ['# Workflow doctor', ''];
  for (const report of reports) {
    const errors = report.issues.filter((issue) => issue.level === 'error');
    const warnings = report.issues.filter((issue) => issue.level === 'warning');
    lines.push(
      `## ${report.workflowId}`,
      '',
      `Result: ${errors.length > 0 ? 'ERROR' : warnings.length > 0 ? 'WARNING' : 'PASS'}`,
      '',
      `Runtime loop guard: each step executes at most ${report.maxStepVisits} time${report.maxStepVisits === 1 ? '' : 's'} before the next attempted entry pauses an uninterrupted run. This bounds graph cycling; it does not guarantee $done or bound time spent inside a step or gate.`,
      '',
    );
    if (report.issues.length === 0) {
      lines.push('- No liveness issues found.', '');
      continue;
    }
    lines.push(
      ...report.issues.map(
        (issue) =>
          `- ${issue.level.toUpperCase()} \`${issue.code}\`: ${escapeMarkdown(issue.message)}`,
      ),
      '',
    );
  }
  return lines.join('\n').trimEnd();
}
