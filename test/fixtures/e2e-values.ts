export const E2E_PROVIDER_ID = 'pi-workflows-e2e';
export const E2E_MODEL_ID = 'workflow-e2e';
export const E2E_INPUT_MARKER = 'E2E_MULTILINE_WORKFLOW_INPUT';
export const E2E_BOOTSTRAP_MARKER = 'E2E_WORKSPACE_BOOTSTRAP_MARKER';
export const E2E_PLAN_MARKER = 'E2E_PLAN_RAW_CONTEXT_MARKER';
export const E2E_IMPLEMENT_MARKER = 'E2E_IMPLEMENT_MARKER';
export const E2E_VERIFY_MARKER = 'E2E_VERIFY_MARKER';
export const E2E_BOOTSTRAP_HANDOFF =
  '# Ready: Workspace selected.\n**Completed:**\n- Selected the workspace in `test/e2e/direct-worker-runtime.test.ts`: E2E_WORKSPACE_HANDOFF_SENTINEL.\n**Remaining:**\n- Create the approved plan.';
export const E2E_PLAN_HANDOFF =
  '# Planned: Plan complete.\n**Completed:**\n- Created the approved plan in `test/fixtures/e2e-faux-provider.ts`: E2E_PLAN_HANDOFF_SENTINEL.\n**Remaining:**\n- Implement the approved plan.';
export const E2E_RETRY_HANDOFF = [
  '# Retry: Transient fixture provider interruption.',
  '**Completed:**',
  '- Recorded the interrupted operation in `test/fixtures/e2e-faux-provider.ts`: E2E_RETRY_HANDOFF_SENTINEL.',
  '**Remaining:**',
  '- Retry the fixture provider operation.',
  '1. **Fixture transport** — E2E_RETRY_HANDOFF_SENTINEL: continue in the same step.',
  '   **Action:** Retry only after the transient fixture provider is available.',
  '**Next:** Safe retry when the transient fixture provider is available.',
].join('\n');
export const E2E_IMPLEMENT_HANDOFF =
  '# Implemented: Implementation complete.\n**Completed:**\n- Implemented the change in `src/index.ts`: E2E_IMPLEMENT_HANDOFF_SENTINEL.\n**Remaining:**\n- Verify the implementation.';
export const E2E_FINAL_SUMMARY =
  '# Done: Workflow complete.\n**Completed:**\n- Verified the workflow with `bun test`: E2E_FINAL_SENTINEL.\n**Remaining:**\n- None; workflow is complete.';
