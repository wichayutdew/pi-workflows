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
      expect(planPrompt).toMatch(
        /first seven sections must be understandable/i,
      );
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

    test('portable four-workflow starter kit loads with bounded graphs', async () => {
      const starterDirectory = join(repositoryRoot, 'examples', 'starter-kit');
      const catalog = await loadCatalog({
        cwd: repositoryRoot,
        projectTrusted: false,
        userDirectory: starterDirectory,
      });

      expect(catalog.diagnostics).toEqual([]);
      expect([...catalog.workflows.keys()].sort()).toEqual([
        'investigate',
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
        expect(loaded.definition.maxStepVisits).toBeLessThanOrEqual(20);
        for (const step of Object.values(loaded.definition.steps)) {
          expect(step.agent?.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
          expect(Object.values(step.transitions)).not.toContain('replan');
        }
        for (const prompt of Object.values(loaded.prompts)) {
          expect(prompt).not.toMatch(/\/Users\//);
          expect(prompt).toContain('structured_output');
          expect(prompt).not.toMatch(/subagent|delegated child/i);
          expect(prompt).not.toContain('workflow_complete_step');
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
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /dirty existing run-owned\s+worktree is valid resumable/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /reuse it\s+even when dirty[\s\S]*different primary\s+or\s+linked worktree/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /never reuse the current checkout merely because it is a linked worktree/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /regardless of whether the source\s+checkout is\s+primary or linked/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /source HEAD is already an ancestor[\s\S]*rebasing would be a no-op/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /selected worktree is dirty[\s\S]*without stashing or rebasing/i,
        );
        expect(workflow.prompts['prepare-workspace']).toMatch(
          /rebase only the exact run-owned dedicated branch/i,
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
          /source HEAD and prepared\s+selected HEAD as historical provenance/i,
        );
        expect(workflow.prompts.plan).toContain(
          'Use the observed current selected HEAD as',
        );
        expect(workflow.prompts.plan).toContain(
          'cleanliness and equality with the original prepared HEAD are not',
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

      const ticket = catalog.workflows.get('ticket')!;
      expect(ticket.prompts.plan).toContain('## Publication contract');
      expect(ticket.prompts.verify).toContain('non-force `git push`');
      expect(ticket.prompts.verify).toContain('GitLab merge request');
      expect(ticket.prompts.verify).toContain('name both `server` and `tool`');
      expect(ticket.prompts.verify).toContain('SSH-authentication preflight');
      expect(ticket.prompts.verify).toContain('1Password approval');

      const review = catalog.workflows.get('mr-review')!;
      expect(review.definition.start).toBe('fetch');
      expect(review.prompts.fetch).toMatch(
        /matching read-only MCP[\s\S]*`glab` or `gh`[\s\S]*read-only web tools/i,
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
        blocked: 'verify',
      });
      expect(review.prompts.review).toContain('{{gate.artifact}}');
      expect(review.prompts.review).toContain('{{gate.feedback}}');
      expect(review.prompts.publish).toContain('{{last.summary}}');
      expect(review.prompts.publish).toMatch(
        /actionable\s+verification\s+finding[\s\S]*corrective\s+publication\s+handoff/i,
      );
      expect(review.prompts.publish).toMatch(
        /GitLab inline-discussion[\s\S]*Fish `begin[\s\S]*`glab api`/i,
      );
      expect(review.prompts.publish).toMatch(
        /Never\s+synthesize, normalize, repair, re-quote, or add an action/i,
      );
      expect(review.prompts.verify).toMatch(
        /`failed`[\s\S]*next\s+publication\s+worker/i,
      );
      for (const step of Object.values(review.definition.steps)) {
        expect(step.requires.tools).not.toContain('mcp');
      }

      const comment = catalog.workflows.get('mr-comment')!;
      expect(comment.definition.start).toBe('fetch');
      expect(comment.definition.steps['checkout-source']?.workspace).toEqual({
        bindOn: ['ready'],
        allowedRoots: ['~/repositories/worktrees', '.'],
      });
      for (const prompt of Object.values(comment.prompts)) {
        expect(prompt).toMatch(/current|checkout/i);
        expect(prompt).toMatch(/never\s+create/i);
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
        comment.definition.steps.deliver?.permissions.bash.allow ?? [];
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
        /subcommand first and omit `git -C`[\s\S]*not a dynamic `-C` prefix/i,
      );
      expect(comment.prompts.plan).toContain('prefer `glab api`');
      expect(comment.prompts.plan).toContain('version-specific `glab mr view');
      expect(comment.prompts.verify).toContain(
        'failing required check is non-passing',
      );
      expect(comment.prompts.verify).toContain(
        'delivery step automatically receives',
      );
      expect(comment.prompts.deliver).toContain(
        'automatically\nperforms every approved required push and reply',
      );
    });
  });
});
