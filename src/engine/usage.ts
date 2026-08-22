export type UsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputCostUsd: number;
  readonly outputCostUsd: number;
  readonly cacheReadCostUsd: number;
  readonly cacheWriteCostUsd: number;
  /** Provider-reported cost without a token-category breakdown. */
  readonly otherCostUsd: number;
  readonly totalCostUsd: number;
};

export type ModelUsage = {
  readonly provider: string;
  readonly model: string;
  readonly usage: UsageTotals;
};

export type UsageAggregate = {
  readonly usage: UsageTotals;
  readonly models: ReadonlyArray<ModelUsage>;
};

type UnknownRecord = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputCostUsd: 0,
  outputCostUsd: 0,
  cacheReadCostUsd: 0,
  cacheWriteCostUsd: 0,
  otherCostUsd: 0,
  totalCostUsd: 0,
});

export const emptyUsageAggregate = (): UsageAggregate => ({
  usage: emptyUsage(),
  models: [],
});

const fields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'inputCostUsd',
  'outputCostUsd',
  'cacheReadCostUsd',
  'cacheWriteCostUsd',
  'otherCostUsd',
  'totalCostUsd',
] as const satisfies ReadonlyArray<keyof UsageTotals>;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function numberAt(
  value: UnknownRecord,
  ...keys: ReadonlyArray<string>
): number {
  for (const key of keys) {
    const candidate = finiteNonNegative(value[key]);
    if (candidate !== undefined) return candidate;
  }
  return 0;
}

/** Normalizes Pi usage shapes while rejecting malformed or inconsistent totals. */
export function normalizeUsage(value: unknown): UsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  let usage: UsageTotals = {
    inputTokens: numberAt(value, 'inputTokens', 'input'),
    outputTokens: numberAt(value, 'outputTokens', 'output'),
    cacheReadTokens: numberAt(value, 'cacheReadTokens', 'cacheRead'),
    cacheWriteTokens: numberAt(value, 'cacheWriteTokens', 'cacheWrite'),
    inputCostUsd: numberAt(value, 'inputCostUsd', 'inputCost'),
    outputCostUsd: numberAt(value, 'outputCostUsd', 'outputCost'),
    cacheReadCostUsd: numberAt(value, 'cacheReadCostUsd', 'cacheReadCost'),
    cacheWriteCostUsd: numberAt(value, 'cacheWriteCostUsd', 'cacheWriteCost'),
    otherCostUsd: 0,
    totalCostUsd: numberAt(value, 'totalCostUsd', 'cost', 'costUsd'),
  };
  const recognized = [
    'inputTokens',
    'input',
    'outputTokens',
    'output',
    'cacheReadTokens',
    'cacheRead',
    'cacheWriteTokens',
    'cacheWrite',
    'inputCostUsd',
    'inputCost',
    'outputCostUsd',
    'outputCost',
    'cacheReadCostUsd',
    'cacheReadCost',
    'cacheWriteCostUsd',
    'cacheWriteCost',
    'totalCostUsd',
    'cost',
    'costUsd',
  ].some((key) => key in value);
  if (!recognized) return undefined;
  if (
    Object.values(value).some(
      (candidate) =>
        typeof candidate === 'number' && !Number.isFinite(candidate),
    )
  )
    return undefined;
  const componentCost =
    usage.inputCostUsd +
    usage.outputCostUsd +
    usage.cacheReadCostUsd +
    usage.cacheWriteCostUsd;
  if ('totalCostUsd' in value || 'cost' in value || 'costUsd' in value) {
    if (componentCost > usage.totalCostUsd + 1e-9) return undefined;
    usage = { ...usage, otherCostUsd: usage.totalCostUsd - componentCost };
  } else {
    return { ...usage, totalCostUsd: componentCost };
  }
  return usage;
}

export function isUsageTotals(value: unknown): value is UsageTotals {
  if (
    !isRecord(value) ||
    !fields.every((field) => finiteNonNegative(value[field]) !== undefined)
  )
    return false;
  return (
    Math.abs(
      (value.inputCostUsd as number) +
        (value.outputCostUsd as number) +
        (value.cacheReadCostUsd as number) +
        (value.cacheWriteCostUsd as number) +
        (value.otherCostUsd as number) -
        (value.totalCostUsd as number),
    ) <= 1e-9
  );
}

export function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return Object.fromEntries(
    fields.map((field) => [field, left[field] + right[field]]),
  ) as UsageTotals;
}

export function mergeUsage(
  aggregate: UsageAggregate,
  entries: ReadonlyArray<ModelUsage>,
): UsageAggregate {
  const byModel = new Map(
    aggregate.models.map((entry) => [
      `${entry.provider}\0${entry.model}`,
      entry.usage,
    ]),
  );
  for (const entry of entries) {
    if (!entry.provider || !entry.model || !isUsageTotals(entry.usage))
      continue;
    const key = `${entry.provider}\0${entry.model}`;
    byModel.set(key, addUsage(byModel.get(key) ?? emptyUsage(), entry.usage));
  }
  const models = [...byModel.entries()]
    .map(([key, usage]) => {
      const [provider, model] = key.split('\0');
      return { provider: provider ?? '', model: model ?? '', usage };
    })
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(
        `${right.provider}/${right.model}`,
      ),
    );
  return {
    usage: models.reduce(
      (total, entry) => addUsage(total, entry.usage),
      emptyUsage(),
    ),
    models,
  };
}

export function isUsageAggregate(value: unknown): value is UsageAggregate {
  const usage =
    value && typeof value === 'object'
      ? (value as UnknownRecord).usage
      : undefined;
  const models =
    value && typeof value === 'object'
      ? (value as UnknownRecord).models
      : undefined;
  if (!isRecord(value) || !isUsageTotals(usage) || !Array.isArray(models))
    return false;
  if (
    !models.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.provider === 'string' &&
        entry.provider.length > 0 &&
        typeof entry.model === 'string' &&
        entry.model.length > 0 &&
        isUsageTotals(entry.usage),
    )
  )
    return false;
  if (
    new Set(
      models.map(
        (entry) =>
          `${(entry as ModelUsage).provider}\0${(entry as ModelUsage).model}`,
      ),
    ).size !== models.length
  )
    return false;
  const typedModels = models as ReadonlyArray<ModelUsage>;
  const total = typedModels.reduce(
    (sum, entry) => addUsage(sum, entry.usage),
    emptyUsage(),
  );
  return fields.every((field) => Math.abs(total[field] - usage[field]) <= 1e-9);
}

/** Extracts one model-keyed usage record from a Pi message-like payload. */
export function modelUsageFromMessage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage = normalizeUsage(value.usage);
  const provider =
    typeof value.provider === 'string' ? value.provider : undefined;
  const model = typeof value.model === 'string' ? value.model : undefined;
  return usage && provider && model ? { provider, model, usage } : undefined;
}
