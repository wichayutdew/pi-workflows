import { describe, expect, test } from 'bun:test';
import { readLatestCheckpoint } from '../src/engine/checkpoint.ts';
import { createRun } from '../src/engine/state.ts';
import { loadedWorkflow } from './helpers.ts';

describe('when testing checkpoint', () => {
  const entryType = 'pi-workflows-state-v1';

  describe('should satisfy its behavioral contract', () => {
    test('checkpoint restore stops at the newest malformed workflow entry', () => {
      // given
      const older = createRun(
        loadedWorkflow(),
        'request',
        ['read'],
        'run-1',
        1,
      );
      // when
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
      // then
      expect(result).toEqual({ status: 'invalid' });
    });

    test('checkpoint restore ignores unrelated newer entries', () => {
      // given
      const run = createRun(loadedWorkflow(), 'request', ['read'], 'run-1', 1);
      // when
      const result = readLatestCheckpoint(
        [
          { type: 'custom', customType: entryType, data: run },
          { type: 'custom', customType: 'other', data: null },
        ],
        entryType,
      );
      // then
      expect(result.status).toBe('valid');
      expect(result.status === 'valid' ? result.run.runId : undefined).toBe(
        'run-1',
      );
    });

    test('checkpoint restore accepts legacy v1 runs without stepHandoff', () => {
      // given
      const run = createRun(
        loadedWorkflow(),
        'request',
        ['read'],
        'legacy-run',
        1,
      );
      const legacyRun = { ...run, lastSummary: 'legacy handoff' };
      delete legacyRun.stepHandoff;
      delete legacyRun.reviewedArtifact;

      // when
      const result = readLatestCheckpoint(
        [{ type: 'custom', customType: entryType, data: legacyRun }],
        entryType,
      );
      // then
      expect(result.status).toBe('valid');
      if (result.status !== 'valid') return;
      expect(result.run.lastSummary).toBe('legacy handoff');
      expect(result.run.stepHandoff).toBe(undefined);
      expect(result.run.reviewedArtifact).toBe(undefined);
    });
  });
});
