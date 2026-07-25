import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/config/load.ts';

describe('when testing example', () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  describe('should satisfy its behavioral contract', () => {
    test('bundled example and schemas are readable', async () => {
      // given
      // when
      const catalog = await loadCatalog({
        cwd: repositoryRoot,
        projectTrusted: false,
        userDirectory: join(repositoryRoot, 'examples'),
      });
      // then
      expect(catalog.diagnostics).toEqual([]);
      expect(catalog.workflows.get('mr-comments')?.definition.command).toBe(
        'mr-comments',
      );

      for (const schema of ['workflow.schema.json', 'settings.schema.json']) {
        const raw = await readFile(
          join(repositoryRoot, 'schemas', schema),
          'utf8',
        );
        expect(() => JSON.parse(raw)).not.toThrow();
      }

      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
      ) as { pi?: { subagents?: { agents?: string[] } } };
      expect(packageJson.pi?.subagents?.agents).toEqual(['./agents']);
      expect(
        await readFile(join(repositoryRoot, 'agents', 'step.md'), 'utf8'),
      ).toMatch(/package: pi-workflows/);
    });
  });
});
