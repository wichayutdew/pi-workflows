import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlannotatorTuiLauncher,
  type PlannotatorTuiDependencies,
} from '../../src/infrastructure/integrations/plannotator-tui.ts';

type SpawnCall = {
  executable: string;
  args: ReadonlyArray<string>;
  options: {
    cwd: string | undefined;
    pluginId?: string;
    timeoutMs: number;
  };
};

type MutableDependencies = PlannotatorTuiDependencies & {
  calls: {
    resolved: Array<string>;
    executableChecks: Array<string>;
    spawnCalls: Array<SpawnCall>;
    removed: Array<string>;
  };
};

function createDependencies(
  overrides: Partial<MutableDependencies> = {},
): MutableDependencies {
  const calls = {
    resolved: [] as Array<string>,
    executableChecks: [] as Array<string>,
    spawnCalls: [] as Array<SpawnCall>,
    removed: [] as Array<string>,
  };
  const baseResolve = () => undefined;
  const baseIsExecutable = () => true;
  const baseReadRegistry = () => undefined;
  const baseMakeTemp = async () => ({
    path: '/tmp/private/artifact.md',
    remove: async () => {
      calls.removed.push('/tmp/private/artifact.md');
    },
  });
  const baseSpawn = async (
    executable: string,
    args: ReadonlyArray<string>,
    options: { cwd: string | undefined; timeoutMs: number },
  ) => {
    calls.spawnCalls.push({ executable, args, options });
    return { exitCode: 0, signal: null };
  };

  return {
    herdrEnv: '1',
    herdrSocketPath: '/tmp/herdr.sock',
    herdrPaneId: 'pane-1',
    ...overrides,
    resolveExecutable: (name) => {
      calls.resolved.push(name);
      return (overrides.resolveExecutable ?? baseResolve)(name);
    },
    isExecutableFile: (path) => {
      calls.executableChecks.push(path);
      return (overrides.isExecutableFile ?? baseIsExecutable)(path);
    },
    readHerdrPluginRegistry: () =>
      (overrides.readHerdrPluginRegistry ?? baseReadRegistry)(),
    makeTempArtifact: (content) =>
      (overrides.makeTempArtifact ?? baseMakeTemp)(content),
    spawn: (executable, args, options) =>
      (overrides.spawn ?? baseSpawn)(executable, args, options),
    calls,
  };
}

function createLauncher(overrides: Partial<MutableDependencies> = {}) {
  const deps = createDependencies(overrides);
  return { launcher: createPlannotatorTuiLauncher(deps), deps };
}

function pluginRegistryEntry(enabled = true) {
  return [
    {
      plugin_id: 'annotate',
      enabled,
      plugin_root:
        '/Users/dev/.config/herdr/plugins/github/annotate-9c299759567c',
      actions: [
        {
          id: 'open',
          command: ['./bin/plannotator-tui.exe', 'herdr', 'open'],
        },
      ],
      panes: [
        {
          id: 'doc',
          command: ['./bin/plannotator-tui.exe', 'herdr', 'open'],
        },
      ],
    },
  ];
}

describe('when testing plannotator TUI launcher', () => {
  describe('discovery', () => {
    test('prefers a standalone executable on PATH', () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
      });

      expect(launcher.isAvailable()).toBe(true);
      expect(deps.calls.resolved).toEqual(['plannotator-tui']);
      expect(deps.calls.executableChecks).toEqual(['/opt/bin/plannotator-tui']);
    });

    test('falls back to a Herdr annotate plugin registry entry', () => {
      const pluginRoot =
        '/Users/dev/.config/herdr/plugins/github/annotate-9c299759567c';
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => pluginRegistryEntry(),
      });

      expect(launcher.isAvailable()).toBe(true);
      expect(deps.calls.resolved).toEqual(['plannotator-tui']);
      expect(deps.calls.executableChecks).toEqual([
        `${pluginRoot}/bin/plannotator-tui.exe`,
      ]);
    });

    test('reports unavailable when Herdr context is missing', () => {
      const { launcher, deps } = createLauncher({
        herdrEnv: undefined,
        herdrSocketPath: undefined,
        herdrPaneId: undefined,
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
      });

      expect(launcher.isAvailable()).toBe(false);
      expect(deps.calls.resolved).toEqual([]);
      expect(deps.calls.executableChecks).toEqual([]);
    });

    test('ignores a disabled or malformed plugin entry', () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => [
          {
            plugin_id: 'annotate',
            enabled: false,
            plugin_root: '/disabled',
            actions: [{ id: 'open', command: ['./bin/plannotator-tui.exe'] }],
            panes: [{ id: 'doc', command: ['./bin/plannotator-tui.exe'] }],
          },
          {
            plugin_id: 'annotate',
            enabled: true,
            plugin_root: '/malformed',
            actions: [{ id: 'preview', command: ['./bin/preview.exe'] }],
            panes: [{ id: 'doc', command: ['./bin/plannotator-tui.exe'] }],
          },
        ],
      });

      expect(launcher.isAvailable()).toBe(false);
      expect(deps.calls.executableChecks).toEqual([]);
    });

    test('ignores registry entries without the exact TUI open action and document pane', () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => [
          {
            plugin_id: 'annotate',
            enabled: true,
            plugin_root: '/missing-action',
            actions: [{ id: 'open', command: ['./bin/other.exe'] }],
            panes: [{ id: 'doc', command: ['./bin/plannotator-tui.exe'] }],
          },
          {
            plugin_id: 'annotate',
            enabled: true,
            plugin_root: '/missing-pane',
            actions: [{ id: 'open', command: ['./bin/plannotator-tui.exe'] }],
            panes: [{ id: 'preview', command: ['./bin/plannotator-tui.exe'] }],
          },
        ],
      });

      expect(launcher.isAvailable()).toBe(false);
      expect(deps.calls.executableChecks).toEqual([]);
    });

    test('ignores registry entries without an executable open command', () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => [
          {
            plugin_id: 'annotate',
            enabled: true,
            plugin_root: '/invalid-command',
            actions: [{ id: 'open', command: [42] }],
            panes: [{ id: 'doc', command: ['./bin/plannotator-tui.exe'] }],
          },
        ],
      });

      expect(launcher.isAvailable()).toBe(false);
      expect(deps.calls.executableChecks).toEqual([]);
    });

    test('ignores a plugin whose executable is not present', () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => pluginRegistryEntry(),
        isExecutableFile: () => false,
      });

      expect(launcher.isAvailable()).toBe(false);
      expect(deps.calls.executableChecks.length).toBeGreaterThan(0);
    });
  });

  describe('launch', () => {
    test('opens a standalone TUI with the documented argv', async () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
      });

      const result = await launcher.launch('# Plan\n');

      expect(result).toEqual({
        kind: 'opened',
        artifactPath: '/tmp/private/artifact.md',
      });
      expect(deps.calls.spawnCalls).toEqual([
        {
          executable: '/opt/bin/plannotator-tui',
          args: [
            'herdr',
            'open',
            '/tmp/private/artifact.md',
            '--deliver-to',
            'pane-1',
          ],
          options: { cwd: undefined, timeoutMs: 5_000 },
        },
      ]);
      expect(deps.calls.removed).toEqual([]);
    });

    test('opens a plugin TUI from its declared root', async () => {
      const pluginRoot =
        '/Users/dev/.config/herdr/plugins/github/annotate-9c299759567c';
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => pluginRegistryEntry(),
      });

      const result = await launcher.launch('# Plan\n');

      expect(result).toEqual({
        kind: 'opened',
        artifactPath: '/tmp/private/artifact.md',
      });
      expect(deps.calls.spawnCalls).toEqual([
        {
          executable: `${pluginRoot}/bin/plannotator-tui.exe`,
          args: [
            'herdr',
            'open',
            '/tmp/private/artifact.md',
            '--deliver-to',
            'pane-1',
          ],
          options: {
            cwd: pluginRoot,
            pluginId: 'annotate',
            timeoutMs: 5_000,
          },
        },
      ]);
    });

    test('uses the discovered Herdr plugin id when launching its binary', async () => {
      const pluginRoot =
        '/Users/dev/.config/herdr/plugins/github/annotate-9c299759567c';
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
        readHerdrPluginRegistry: () => pluginRegistryEntry(),
      });

      await launcher.launch('# Plan\n');

      expect(deps.calls.spawnCalls).toEqual([
        {
          executable: `${pluginRoot}/bin/plannotator-tui.exe`,
          args: [
            'herdr',
            'open',
            '/tmp/private/artifact.md',
            '--deliver-to',
            'pane-1',
          ],
          options: {
            cwd: pluginRoot,
            pluginId: 'annotate',
            timeoutMs: 5_000,
          },
        },
      ]);
    });

    test('forwards the artifact content to a private temp file', async () => {
      let writtenContent: string | undefined;
      const artifact = '# Secret plan\n';
      const { launcher } = createLauncher({
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
        makeTempArtifact: async (content) => {
          writtenContent = content;
          return {
            path: '/tmp/private/artifact.md',
            remove: async () => {},
          };
        },
      });

      await launcher.launch(artifact);

      expect(writtenContent).toBe(artifact);
    });

    test('classifies a non-zero exit as failed and cleans up', async () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
        spawn: async () => ({ exitCode: 1, signal: null }),
      });

      const result = await launcher.launch('# Plan\n');

      expect(result.kind).toBe('failed');
      expect(result).toMatchObject({
        reason: expect.stringContaining('exit code 1'),
      });
      expect(deps.calls.removed).toEqual(['/tmp/private/artifact.md']);
    });

    test('classifies a timeout as failed and cleans up', async () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
        spawn: async () => ({ exitCode: null, signal: 'SIGTERM' }),
      });

      const result = await launcher.launch('# Plan\n');

      expect(result.kind).toBe('failed');
      expect(result).toMatchObject({
        reason: expect.stringContaining('terminated'),
      });
      expect(deps.calls.removed).toEqual(['/tmp/private/artifact.md']);
    });

    test('is unavailable when no candidate is discovered', async () => {
      const { launcher, deps } = createLauncher({
        resolveExecutable: () => undefined,
      });

      const result = await launcher.launch('# Plan\n');

      expect(result.kind).toBe('unavailable');
      expect(result).toMatchObject({
        reason: expect.stringContaining('not installed'),
      });
      expect(deps.calls.spawnCalls).toEqual([]);
      expect(deps.calls.removed).toEqual([]);
    });

    test('is unavailable when Herdr pane context disappears', async () => {
      const { launcher } = createLauncher({
        herdrPaneId: undefined,
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
      });

      const result = await launcher.launch('# Plan\n');

      expect(result.kind).toBe('unavailable');
      expect(result).toMatchObject({
        reason: expect.stringContaining('Herdr context is missing'),
      });
    });
  });

  describe('cleanup', () => {
    test('removes the retained artifact path and its directory', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-plannotator-tui-cleanup-'),
      );
      const artifactPath = join(directory, 'artifact.md');
      await writeFile(artifactPath, '# Plan\n', { mode: 0o600 });

      const { launcher } = createLauncher({
        resolveExecutable: (name) =>
          name === 'plannotator-tui' ? '/opt/bin/plannotator-tui' : undefined,
        makeTempArtifact: async () => ({
          path: artifactPath,
          remove: async () => {},
        }),
      });

      await launcher.launch('# Plan\n');
      await launcher.cleanupArtifact(artifactPath);

      await expect(access(artifactPath)).rejects.toBeDefined();
      await expect(access(directory)).rejects.toBeDefined();
    });
  });
});
