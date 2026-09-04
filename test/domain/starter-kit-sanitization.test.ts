import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

const root = join(import.meta.dir, '../..', 'examples', 'starter-kit');
const banned =
  /\b(?:agoda|agodadev|actb-|actso-|c04sm|opsbot|activities-support|activities_marketing_triage|calculon|bkgdb|mse|ceg|soybean|gttd|contentread)\b/i;

async function files(): Promise<string[]> {
  const glob = new Bun.Glob('**/*');
  const result: string[] = [];
  for await (const path of glob.scan({ cwd: root, onlyFiles: true }))
    result.push(path);
  return result;
}

describe('starter-kit sanitization', () => {
  test('contains no company-specific content or sprint-triage workflow', async () => {
    for (const path of await files()) {
      expect(path).not.toContain('sprint-triage');
      expect(await readFile(join(root, path), 'utf8')).not.toMatch(banned);
    }
  });

  test('configures bounded retrying artifact contracts for every gated workflow', async () => {
    const glob = new Bun.Glob('*.workflow.yaml');
    for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
      const workflow = YAML.parse(await readFile(join(root, path), 'utf8')) as {
        steps: Record<
          string,
          {
            gate?: { artifactContract?: Record<string, unknown> };
            transitions: Record<string, string>;
          }
        >;
      };
      for (const step of Object.values(workflow.steps)) {
        if (!step.gate) continue;
        const contract = step.gate.artifactContract;
        expect(contract).toBeDefined();
        expect(contract?.maxChars).toEqual(expect.any(Number));
        expect(contract?.onValidationFailure).toBe('retry');
        expect(step.transitions.retry).toBeDefined();
      }
    }
  });
});
