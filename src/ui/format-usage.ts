import { emptyUsageAggregate, mergeUsage } from '../function/index.ts';
import type {
  UsageAggregate,
  UsageTotals,
  WorkflowRun,
} from '../domain/index.ts';

export function workflowUsage(run: WorkflowRun): UsageAggregate {
  return [
    ...run.history.map((entry) => entry.usage),
    run.currentStepUsage,
  ].reduce<UsageAggregate>(
    (total, usage) => (usage ? mergeUsage(total, usage.models) : total),
    emptyUsageAggregate(),
  );
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function formatTokens(usage: UsageTotals): string {
  const parts = [`${usage.inputTokens} in`, `${usage.outputTokens} out`];
  const cache = usage.cacheReadTokens + usage.cacheWriteTokens;
  if (cache > 0) parts.push(`${cache} cache`);
  return parts.join(' · ');
}

export function formatUsage(usage: UsageAggregate): string {
  return `${formatUsd(usage.usage.totalCostUsd)} · ${formatTokens(usage.usage)}`;
}
