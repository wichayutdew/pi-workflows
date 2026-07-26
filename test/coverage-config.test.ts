import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

describe('when testing coverage configuration', () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  describe('should isolate release coverage from ordinary tests', () => {
    test('uses a dedicated full-suite config and report path', async () => {
      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      const defaultConfig = await readFile(
        join(repositoryRoot, 'bunfig.toml'),
        'utf8',
      );
      const coverageConfig = await readFile(
        join(repositoryRoot, 'bunfig.coverage.toml'),
        'utf8',
      );
      const pullRequestWorkflow = await readFile(
        join(repositoryRoot, '.github', 'workflows', 'pull-request.yml'),
        'utf8',
      );

      expect(packageJson.scripts?.test).toBe(
        'bun test --no-orphans --reporter=dots',
      );
      expect(packageJson.scripts?.['test:coverage']).toBe(
        'bun --config=bunfig.coverage.toml test --no-orphans --reporter=dots && bun run coverage:check',
      );
      expect(packageJson.scripts?.['coverage:check']).toBe(
        'bun .github/scripts/check-coverage.mjs coverage/full/lcov.info',
      );
      expect(defaultConfig).toMatch(/\[test\]\s+coverage = false/);
      expect(defaultConfig).not.toContain('coverageThreshold');
      expect(coverageConfig).toMatch(/\[test\]\s+coverage = true/);
      expect(coverageConfig).toContain('coverageDir = "coverage/full"');
      expect(coverageConfig).toContain(
        'coverageThreshold = { line = 0.9, function = 0.9, statement = 0.9 }',
      );
      expect(coverageConfig).not.toMatch(/\b(lines|functions|statements)\s*=/);
      expect(pullRequestWorkflow).toContain('files: coverage/full/lcov.info');
    });

    test('accepts exactly 90 percent and rejects values below it', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-coverage-check-'),
      );
      const checker = join(
        repositoryRoot,
        '.github',
        'scripts',
        'check-coverage.mjs',
      );

      try {
        const exactPath = join(directory, 'exact.lcov');
        await writeFile(
          exactPath,
          'SF:src/example.ts\nFNF:10\nFNH:9\nLF:10\nLH:9\nend_of_record\n',
          'utf8',
        );
        const exact = Bun.spawn([process.execPath, checker, exactPath], {
          cwd: repositoryRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const exactOutput = await new Response(exact.stdout).text();
        const exactError = await new Response(exact.stderr).text();

        expect(await exact.exited).toBe(0);
        expect(exactError).toBe('');
        expect(exactOutput).toContain('at least 90%');

        const belowPath = join(directory, 'below.lcov');
        await writeFile(
          belowPath,
          'SF:src/example.ts\nFNF:100\nFNH:90\nLF:100\nLH:89\nend_of_record\n',
          'utf8',
        );
        const below = Bun.spawn([process.execPath, checker, belowPath], {
          cwd: repositoryRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const belowError = await new Response(below.stderr).text();

        expect(await below.exited).toBe(1);
        expect(belowError).toContain(
          'lines coverage 89.00% must be at least 90%',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
