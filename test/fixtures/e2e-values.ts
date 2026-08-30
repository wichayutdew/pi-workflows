export const E2E_PROVIDER_ID = 'pi-workflows-e2e';
export const E2E_MODEL_ID = 'workflow-e2e';
export const E2E_INPUT_MARKER = 'E2E_MULTILINE_WORKFLOW_INPUT';
export const E2E_BOOTSTRAP_MARKER = 'E2E_WORKSPACE_BOOTSTRAP_MARKER';
export const E2E_PLAN_MARKER = 'E2E_PLAN_RAW_CONTEXT_MARKER';
export const E2E_IMPLEMENT_MARKER = 'E2E_IMPLEMENT_MARKER';
export const E2E_VERIFY_MARKER = 'E2E_VERIFY_MARKER';
export const E2E_BOOTSTRAP_HANDOFF =
  'E2E_WORKSPACE_HANDOFF_SENTINEL: workspace selected';
export const E2E_PLAN_HANDOFF = 'E2E_PLAN_HANDOFF_SENTINEL: plan complete';
export const E2E_RETRY_HANDOFF = [
  '# Retry: Transient fixture provider interruption.',
  '1. **Fixture transport** — E2E_RETRY_HANDOFF_SENTINEL: continue in the same step.',
  '   **Action:** Retry only after the transient fixture provider is available.',
  '**Next:** Safe retry when the transient fixture provider is available.',
].join('\n');
export const E2E_IMPLEMENT_HANDOFF =
  'E2E_IMPLEMENT_HANDOFF_SENTINEL: implementation complete';
export const E2E_FINAL_SUMMARY = 'E2E_FINAL_SENTINEL: workflow complete';
