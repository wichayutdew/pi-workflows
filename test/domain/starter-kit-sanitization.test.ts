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

  test('configures ready-gated artifact contracts for every gated workflow', async () => {
    const glob = new Bun.Glob('*.workflow.yaml');
    for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
      const workflow = YAML.parse(await readFile(join(root, path), 'utf8')) as {
        steps: Record<
          string,
          {
            gate?: {
              artifactContract?: {
                maxChars?: unknown;
                requiredHeadings?: unknown;
              };
            };
            transitions: Record<string, string>;
          }
        >;
      };
      for (const step of Object.values(workflow.steps)) {
        if (!step.gate) continue;
        const contract = step.gate.artifactContract;
        expect(contract).toBeDefined();
        expect(contract?.maxChars).toEqual(expect.any(Number));
        const headings = Array.isArray(contract?.requiredHeadings)
          ? contract.requiredHeadings
          : [];
        expect(Array.isArray(contract?.requiredHeadings)).toBe(true);
        expect(headings.length).toBeGreaterThan(0);
        for (const heading of headings) {
          expect(heading).toEqual({
            level: expect.any(Number),
            title: expect.any(String),
            guidance: expect.any(String),
          });
          expect(Number.isInteger(heading.level)).toBe(true);
          expect(heading.level).toBeGreaterThanOrEqual(1);
          expect(heading.level).toBeLessThanOrEqual(3);
          expect(heading.title.trim()).not.toBe('');
          expect(heading.guidance.trim()).not.toBe('');
        }
        expect(step.transitions.ready).toBeDefined();
        expect(step.transitions.handoff).toBeDefined();
      }
    }
  });
});
