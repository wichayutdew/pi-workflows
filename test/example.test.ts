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
        userDirectory: join(repositoryRoot, 'examples'),
      });
      // then
      expect(catalog.diagnostics).toEqual([]);
      expect(catalog.workflows.get('mr-comments')?.definition.command).toBe(
        'mr-comments',
      );
      const example = catalog.workflows.get('mr-comments')?.definition;
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
      const planPrompt = catalog.workflows.get('mr-comments')?.prompts.plan;
      expect(planPrompt).toContain('## Review summary');
      expect(planPrompt).toContain('## Review focus');
      expect(planPrompt).toContain('## Proposed changes');
      expect(planPrompt).toContain('## Validation');
      expect(planPrompt).toContain('## Risks');
      expect(planPrompt).toMatch(/checkboxes only for acceptance criteria/i);
      expect(planPrompt).toMatch(
        /format is defined by this\s+workflow prompt/i,
      );
      expect(planPrompt).toMatch(/treats the artifact as opaque/i);
      expect(planPrompt).toContain('{{gate.artifact}}');
      expect(catalog.workflows.get('mr-comments')?.prompts.implement).toContain(
        '{{reviewed.artifact}}',
      );
      expect(catalog.workflows.get('mr-comments')?.prompts.verify).toContain(
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
          step?: {
            allOf?: unknown;
          };
          prompt?: {
            oneOf?: Array<unknown>;
          };
        };
      };
      expect(workflowSchema.$defs?.step?.allOf).toEqual([
        {
          if: { required: ['workspace'] },
          then: {
            required: ['subagent'],
            not: { required: ['gate'] },
          },
        },
      ]);
      expect(workflowSchema.$defs?.prompt?.oneOf?.[1]).toMatchObject({
        properties: {
          file: {
            $ref: '#/$defs/relativePath',
          },
        },
      });

      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
      ) as { pi?: { subagents?: { agents?: string[] } } };
      expect(packageJson.pi?.subagents?.agents).toEqual(['./agents']);
      expect(
        await readFile(join(repositoryRoot, 'agents', 'step.md'), 'utf8'),
      ).toMatch(/package: pi-workflows/);
    });

    test('portable four-workflow starter kit loads with bounded graphs', async () => {
      const starterDirectory = join(repositoryRoot, 'examples', 'starter-kit');
      const catalog = await loadCatalog({
        cwd: repositoryRoot,
        projectTrusted: false,
        userDirectory: starterDirectory,
      });

      expect(catalog.diagnostics).toEqual([]);
      expect([...catalog.workflows.keys()].sort()).toEqual([
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
                ([stepId, step]) => [stepId, step.subagent?.agent],
              ),
            ),
          ]),
        ),
      ).toEqual({
        'mr-comment': {
          fetch: 'scout',
          plan: 'planner',
          implement: 'worker',
          verify: 'reviewer',
          publish: 'worker',
        },
        'mr-review': {
          fetch: 'scout',
          review: 'reviewer',
          publish: 'worker',
          verify: 'reviewer',
        },
        ticket: {
          'prepare-workspace': 'worker',
          plan: 'planner',
          implement: 'worker',
          verify: 'reviewer',
        },
        work: {
          'prepare-workspace': 'worker',
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
        expect(loaded.definition.maxStepVisits).toBeLessThanOrEqual(4);
        for (const step of Object.values(loaded.definition.steps)) {
          expect(step.permissions.skills).toEqual([]);
          expect(step.permissions.extensions).toEqual([]);
          expect(Object.values(step.transitions)).not.toContain('replan');
        }
        for (const prompt of Object.values(loaded.prompts)) {
          expect(prompt).not.toMatch(/\/Users\//);
          expect(prompt).not.toMatch(
            /caveman|superpowers|using-git-worktrees|pi-web-tools/i,
          );
        }
      }

      for (const workflowId of ['work', 'ticket']) {
        const workflow = catalog.workflows.get(workflowId)!;
        expect(workflow.definition.start).toBe('prepare-workspace');
        expect(
          workflow.definition.steps['prepare-workspace']?.workspace,
        ).toEqual({
          bindOn: ['ready'],
          allowedRoots: ['..'],
        });
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /dirty exact run-owned\s+worktree is resumable/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /reuse it even when it is dirty[\s\S]*launched\s+from a different primary or linked worktree/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /never reuse the current checkout merely because it is a linked worktree/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /regardless of whether the source\s+checkout is primary or linked/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /source HEAD is already an ancestor[\s\S]*rebasing would be a no-op/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /selected worktree is dirty[\s\S]*without stashing or rebasing/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /selected worktree is clean[\s\S]*rebase only the exact run-owned branch/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /Abort only the rebase started by this attempt[\s\S]*pre-attempt selected HEAD and status were restored/i,
        );
        expect(workflow.definition.steps.plan?.transitions).toMatchObject({
          approved: 'implement',
          'changes-requested': 'plan',
          'workspace-refresh': 'prepare-workspace',
          blocked: '$pause',
        });
        expect(workflow.prompts.plan).toContain('{{gate.artifact}}');
        expect(workflow.prompts.plan).toContain('{{gate.feedback}}');
        expect(workflow.prompts.plan).toMatch(
          /captured source HEAD and initially selected HEAD\s+as\s+historical provenance/i,
        );
        expect(workflow.prompts.plan).toMatch(
          /Plan from the observed selected HEAD[\s\S]*cleanliness is not required/i,
        );
        expect(workflow.prompts.plan).toMatch(
          /Use outcome `workspace-refresh` only when[\s\S]*selected checkout is clean/i,
        );
        const planGitRules =
          workflow.definition.steps.plan?.permissions.bash.allow?.filter(
            (rule) => rule.executable === 'git',
          ) ?? [];
        expect(planGitRules).toEqual(
          expect.arrayContaining([
            { executable: 'git', argsPrefix: ['merge-base'] },
            { executable: 'git', argsPrefix: ['rev-list'] },
            { executable: 'git', argsPrefix: ['worktree', 'list'] },
          ]),
        );
      }

      const review = catalog.workflows.get('mr-review')!;
      expect(review.definition.start).toBe('fetch');
      expect(review.prompts.fetch).toMatch(
        /MCP server first[\s\S]*host CLI[\s\S]*cURL/i,
      );
      expect(review.definition.steps.review?.gate?.provider).toBe(
        'plannotator',
      );
      expect(review.definition.steps.review?.transitions).toMatchObject({
        approved: 'publish',
        'changes-requested': 'review',
      });
      expect(review.definition.steps.verify?.transitions).toMatchObject({
        verified: '$done',
        failed: 'publish',
        retry: 'verify',
        blocked: '$pause',
      });
      expect(review.prompts.review).toContain('{{gate.artifact}}');
      expect(review.prompts.review).toContain('{{gate.feedback}}');
      expect(review.prompts.publish).toContain('{{last.summary}}');
      expect(review.prompts.publish).toMatch(
        /actionable\s+verification\s+finding[\s\S]*corrective\s+publication\s+handoff/i,
      );
      expect(review.prompts.verify).toMatch(
        /`failed`[\s\S]*next\s+publication\s+worker/i,
      );
      for (const step of Object.values(review.definition.steps)) {
        expect(step.requires.tools).not.toContain('mcp');
      }

      const comment = catalog.workflows.get('mr-comment')!;
      expect(comment.definition.start).toBe('fetch');
      expect(
        Object.values(comment.definition.steps).every(
          (step) => step.workspace === undefined,
        ),
      ).toBe(true);
      for (const prompt of Object.values(comment.prompts)) {
        expect(prompt).toMatch(/current|checkout/i);
        expect(prompt).toMatch(/Never create|never create/i);
      }
      expect(comment.definition.steps.plan?.transitions).toMatchObject({
        approved: 'implement',
        'changes-requested': 'plan',
      });
      expect(comment.prompts.plan).toContain('{{gate.artifact}}');
      expect(comment.prompts.plan).toContain('{{gate.feedback}}');
      expect(comment.definition.steps.verify?.transitions.failed).toBe(
        'implement',
      );
      for (const step of Object.values(comment.definition.steps)) {
        expect(step.requires.tools).not.toContain('mcp');
      }
      const publicationRules =
        comment.definition.steps.publish?.permissions.bash.allow ?? [];
      expect(
        publicationRules
          .filter((rule) => rule.executable === 'git')
          .map((rule) => rule.argsPrefix),
      ).toContainEqual(['push']);
      expect(
        publicationRules
          .filter((rule) => rule.executable === 'git')
          .some((rule) => rule.argsPrefix[0] === '-C'),
      ).toBe(false);
      expect(
        publicationRules
          .filter((rule) => rule.executable === 'glab')
          .map((rule) => rule.argsPrefix),
      ).toContainEqual(['api']);
      expect(comment.prompts.plan).toMatch(
        /subcommand first[\s\S]*never add a dynamic `git -C`/i,
      );
      expect(comment.prompts.plan).toMatch(
        /prefer `glab api`[\s\S]*do not assume[\s\S]*`glab mr view` supports `--json`/i,
      );
    });
  });
});
