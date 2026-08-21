import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/config/load.ts';
import { analyzeWorkflow } from '../src/workflow-doctor.ts';

describe('when testing example', () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  describe('should satisfy its behavioral contract', () => {
    test('bundled example and schemas are readable', async () => {
      // given
      // when
      const catalog = await loadCatalog({
        cwd: repositoryRoot,
        projectTrusted: false,
        userDirectory: join(repositoryRoot, 'examples', 'starter-kit'),
      });
      // then
      expect(catalog.diagnostics).toEqual([]);
      expect(catalog.workflows.get('mr-comment')?.definition.command).toBe(
        'mr-comment',
      );
      const example = catalog.workflows.get('mr-comment')?.definition;
      expect(example?.steps.plan?.gate).toMatchObject({
        provider: 'plannotator',
        timeoutMs: 30_000,
      });
      expect(example?.steps.plan?.permissions.extensions).not.toContain(
        'plannotator',
      );
      expect(example?.steps.plan?.requires.extensions).not.toContain(
        'plannotator',
      );
      expect(example?.steps.plan?.transitions).toMatchObject({
        approved: 'implement',
        'changes-requested': 'plan',
        blocked: '$pause',
      });
      expect(example?.steps.implement?.transitions).toMatchObject({
        retry: 'implement',
        blocked: '$pause',
      });
      expect(example?.steps.implement?.transitions).not.toHaveProperty(
        'replan',
      );
      const doctor = analyzeWorkflow(example!);
      expect(doctor.issues.filter((issue) => issue.level === 'error')).toEqual(
        [],
      );
      expect(doctor.issues.some((issue) => issue.code === 'cycle')).toBe(true);
      const planPrompt = catalog.workflows.get('mr-comment')?.prompts.plan;
      expect(planPrompt).toContain('## Review summary');
      expect(planPrompt).toContain('## Comment decisions');
      expect(planPrompt).toContain('## Implementation plan');
      expect(planPrompt).toContain('## Validation');
      expect(planPrompt).toContain('## Risks');
      expect(planPrompt).toContain('## Execution appendix (machine-readable)');
      expect(planPrompt).toContain('## Artifact limit');
      expect(planPrompt).toContain('{{gate.artifact}}');
      expect(catalog.workflows.get('mr-comment')?.prompts.implement).toContain(
        '{{reviewed.artifact}}',
      );
      expect(catalog.workflows.get('mr-comment')?.prompts.verify).toContain(
        '{{reviewed.artifact}}',
      );

      for (const schema of ['workflow.schema.json', 'settings.schema.json']) {
        const raw = await readFile(
          join(repositoryRoot, 'schemas', schema),
          'utf8',
        );
        expect(() => JSON.parse(raw)).not.toThrow();
      }
      const workflowSchema = JSON.parse(
        await readFile(
          join(repositoryRoot, 'schemas', 'workflow.schema.json'),
          'utf8',
        ),
      ) as {
        $defs?: {
          artifactContract?: {
            required?: string[];
            properties?: Record<string, unknown>;
          };
          step?: {
            allOf?: unknown;
          };
          prompt?: {
            oneOf?: Array<unknown>;
          };
        };
      };
      expect(workflowSchema.$defs?.artifactContract).toMatchObject({
        required: [
          'maxChars',
          'requiredSubstrings',
          'forbiddenSubstrings',
          'equalOccurrenceGroups',
        ],
        properties: {
          onValidationFailure: { const: 'retry' },
        },
      });
      expect(workflowSchema.$defs?.step?.allOf).toBeUndefined();
      expect(workflowSchema.$defs?.prompt?.oneOf?.[1]).toMatchObject({
        properties: {
          file: {
            $ref: '#/$defs/relativePath',
          },
        },
      });

      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
      ) as { pi?: { extensions?: string[] } };
      expect(packageJson.pi?.extensions).toEqual(['./src/index.ts']);
      expect(
        await readFile(
          join(
            repositoryRoot,
            'examples',
            'starter-kit',
            'agents',
            'worker.md',
          ),
          'utf8',
        ),
      ).toMatch(/implementation role/i);
    });

    test('portable six-workflow starter kit loads with bounded graphs', async () => {
      const starterDirectory = join(repositoryRoot, 'examples', 'starter-kit');
      const catalog = await loadCatalog({
        cwd: repositoryRoot,
        projectTrusted: false,
        userDirectory: starterDirectory,
      });

      expect(catalog.diagnostics).toEqual([]);
      expect([...catalog.workflows.keys()].sort()).toEqual([
        'investigate',
        'jira',
        'mr-comment',
        'mr-review',
        'ticket',
        'work',
      ]);
      expect(
        Object.fromEntries(
          [...catalog.workflows.entries()].map(([workflowId, workflow]) => [
            workflowId,
            Object.fromEntries(
              Object.entries(workflow.definition.steps).map(
                ([stepId, step]) => [stepId, step.agent?.name],
              ),
            ),
          ]),
        ),
      ).toEqual({
        investigate: {
          retrieve: 'scout',
          investigate: 'worker',
          validate: 'reviewer',
        },
        jira: {
          draft: 'scout',
          plan: 'planner',
          create: 'worker',
        },
        'mr-comment': {
          fetch: 'scout',
          'checkout-source': 'worker',
          plan: 'planner',
          implement: 'worker',
          verify: 'reviewer',
          deliver: 'worker',
        },
        'mr-review': {
          fetch: 'scout',
          review: 'reviewer',
          publish: 'worker',
          verify: 'reviewer',
        },
        ticket: {
          'prepare-workspace': 'workspace-preparer',
          plan: 'planner',
          implement: 'worker',
          verify: 'reviewer',
        },
        work: {
          'prepare-workspace': 'workspace-preparer',
          plan: 'planner',
          implement: 'worker',
          verify: 'reviewer',
        },
      });

      for (const loaded of catalog.workflows.values()) {
        expect(JSON.stringify(loaded.definition)).not.toMatch(/\/Users\//);
        expect(
          analyzeWorkflow(loaded.definition).issues.filter(
            (issue) => issue.level === 'error',
          ),
        ).toEqual([]);
        expect(loaded.definition.maxStepVisits).toBeLessThanOrEqual(20);
        for (const step of Object.values(loaded.definition.steps)) {
          expect(step.agent?.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
          expect(Object.values(step.transitions)).not.toContain('replan');
        }
        for (const prompt of Object.values(loaded.prompts)) {
          expect(prompt).not.toMatch(/\/Users\//);
          expect(prompt.trim().length).toBeGreaterThan(0);
        }
      }

      for (const workflowId of ['work', 'ticket']) {
        const workflow = catalog.workflows.get(workflowId)!;
        expect(workflow.definition.start).toBe('prepare-workspace');
        expect(
          workflow.definition.steps['prepare-workspace']?.workspace,
        ).toEqual({
          bindOn: ['ready'],
          allowedRoots: ['~/repositories/worktrees'],
        });
        expect(
          workflow.definition.steps.plan?.gate?.artifactContract,
        ).toBeDefined();
        expect(workflow.definition.steps.plan?.transitions.retry).toBe('plan');
      }

      const jira = catalog.workflows.get('jira')!;
      expect(jira.definition.start).toBe('draft');
      expect(jira.definition.steps.plan?.gate?.artifactContract?.maxChars).toBe(
        16000,
      );

      for (const workflowId of ['mr-review', 'mr-comment']) {
        const workflow = catalog.workflows.get(workflowId)!;
        expect(
          workflow.definition.steps.plan?.gate?.artifactContract ??
            workflow.definition.steps.review?.gate?.artifactContract,
        ).toBeDefined();
      }
    });
  });
});
