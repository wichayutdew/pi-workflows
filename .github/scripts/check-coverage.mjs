import { readFile } from 'node:fs/promises';

const coveragePath = process.argv[2] ?? 'coverage/lcov.info';
const minimumPercent = 90;
const totals = {
  lines: { found: 0, hit: 0 },
  functions: { found: 0, hit: 0 },
};

const fieldTargets = {
  LF: totals.lines,
  LH: { metric: totals.lines, field: 'hit' },
  FNF: totals.functions,
  FNH: { metric: totals.functions, field: 'hit' },
};

try {
  const report = await readFile(coveragePath, 'utf8');
  for (const line of report.split(/\r?\n/)) {
    const match = /^(LF|LH|FNF|FNH):(\d+)$/.exec(line);
    if (!match) continue;
    const [, field, rawValue] = match;
    const target = fieldTargets[field];
    const value = Number(rawValue);
    if ('metric' in target) {
      target.metric[target.field] += value;
    } else {
      target.found += value;
    }
  }

  for (const [name, { found, hit }] of Object.entries(totals)) {
    if (found === 0) {
      throw new Error(`${coveragePath} contains no ${name} coverage`);
    }
    const percent = (hit / found) * 100;
    if (percent <= minimumPercent) {
      throw new Error(
        `${name} coverage ${percent.toFixed(2)}% must be above ${minimumPercent}%`,
      );
    }
    console.log(
      `${name} coverage: ${percent.toFixed(2)}% (${hit}/${found}), above ${minimumPercent}%`,
    );
  }
} catch (error) {
  console.error(
    `Coverage check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
