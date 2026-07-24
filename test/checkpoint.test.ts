import assert from 'node:assert/strict';
import test from 'node:test';
import { readLatestCheckpoint } from '../src/engine/checkpoint.ts';
import { createRun } from '../src/engine/state.ts';
import { loadedWorkflow } from './helpers.ts';

const entryType = 'pi-workflows-state-v1';

test('checkpoint restore stops at the newest malformed workflow entry', () => {
  const older = createRun(loadedWorkflow(), 'request', ['read'], 'run-1', 1);
  const result = readLatestCheckpoint(
    [
      { type: 'custom', customType: entryType, data: older },
      {
        type: 'custom',
        customType: entryType,
        data: { ...older, stateVersion: 2 },
      },
    ],
    entryType,
  );
  assert.deepEqual(result, { status: 'invalid' });
});

test('checkpoint restore ignores unrelated newer entries', () => {
  const run = createRun(loadedWorkflow(), 'request', ['read'], 'run-1', 1);
  const result = readLatestCheckpoint(
    [
      { type: 'custom', customType: entryType, data: run },
      { type: 'custom', customType: 'other', data: null },
    ],
    entryType,
  );
  assert.equal(result.status, 'valid');
  assert.equal(
    result.status === 'valid' ? result.run.runId : undefined,
    'run-1',
  );
});

test('checkpoint restore accepts legacy v1 runs without stepHandoff', () => {
  const run = createRun(loadedWorkflow(), 'request', ['read'], 'legacy-run', 1);
  const legacyRun = { ...run, lastSummary: 'legacy handoff' };
  delete legacyRun.stepHandoff;
  delete legacyRun.reviewedArtifact;

  const result = readLatestCheckpoint(
    [{ type: 'custom', customType: entryType, data: legacyRun }],
    entryType,
  );
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') return;
  assert.equal(result.run.lastSummary, 'legacy handoff');
  assert.equal(result.run.stepHandoff, undefined);
  assert.equal(result.run.reviewedArtifact, undefined);
});
