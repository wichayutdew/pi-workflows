import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type TuiLaunchResult =
  | { readonly kind: 'opened'; readonly artifactPath: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

type TuiCandidate =
  | { readonly kind: 'standalone'; readonly executable: string }
  | {
      readonly kind: 'plugin';
      readonly executable: string;
      readonly pluginId: string;
      readonly pluginRoot: string;
    };

export type PlannotatorTuiDependencies = {
  readonly herdrEnv: string | undefined;
  readonly herdrSocketPath: string | undefined;
  readonly herdrPaneId: string | undefined;
  readonly resolveExecutable: (name: string) => string | undefined;
  readonly isExecutableFile: (path: string) => boolean;
  readonly readHerdrPluginRegistry: () => unknown;
  readonly makeTempArtifact: (
    content: string,
  ) => Promise<{ readonly path: string; readonly remove: () => Promise<void> }>;
  readonly spawn: (
    executable: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string | undefined;
      readonly pluginId?: string;
      readonly timeoutMs: number;
    },
  ) => Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>;
};

const HERDR_PLUGIN_REGISTRY_PATH = join(
  homedir(),
  '.config/herdr/plugins.json',
);

const STANDALONE_EXECUTABLE_NAME = 'plannotator-tui';
const PLUGIN_ID = 'annotate';
const PLUGIN_OPEN_ACTION_ID = 'open';
const PLUGIN_DOC_PANE_ID = 'doc';
const PLUGIN_EXECUTABLE = './bin/plannotator-tui.exe';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasHerdrContext = (dependencies: PlannotatorTuiDependencies): boolean =>
  dependencies.herdrEnv === '1' &&
  typeof dependencies.herdrSocketPath === 'string' &&
  dependencies.herdrSocketPath.length > 0 &&
  typeof dependencies.herdrPaneId === 'string' &&
  dependencies.herdrPaneId.length > 0;

function defaultIsExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.F_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePluginExecutable(
  pluginRoot: string,
  command: ReadonlyArray<unknown>,
): string | undefined {
  const first = command[0];
  if (typeof first !== 'string') return undefined;
  const relative = first.startsWith('./') ? first.slice(2) : first;
  const candidate = isAbsolute(relative)
    ? relative
    : join(pluginRoot, relative);
  if (candidate === join(pluginRoot, PLUGIN_EXECUTABLE.slice(2))) {
    return candidate;
  }
  return undefined;
}

function findPluginCandidate(registry: unknown): TuiCandidate | undefined {
  if (!Array.isArray(registry)) return undefined;
  for (const entry of registry) {
    if (!isRecord(entry)) continue;
    if (entry.plugin_id !== PLUGIN_ID || entry.enabled !== true) continue;
    const pluginRoot =
      typeof entry.plugin_root === 'string' ? entry.plugin_root : undefined;
    if (!pluginRoot) continue;

    const actions = Array.isArray(entry.actions) ? entry.actions : undefined;
    const panes = Array.isArray(entry.panes) ? entry.panes : undefined;
    if (!actions || !panes) continue;

    const openAction: unknown = actions.find(
      (action) =>
        isRecord(action) &&
        action.id === PLUGIN_OPEN_ACTION_ID &&
        Array.isArray(action.command),
    );
    const docPane: unknown = panes.find(
      (pane) =>
        isRecord(pane) &&
        pane.id === PLUGIN_DOC_PANE_ID &&
        Array.isArray(pane.command),
    );
    if (!openAction || !docPane) continue;

    const executable = resolvePluginExecutable(
      pluginRoot,
      (openAction as { command: ReadonlyArray<unknown> }).command,
    );
    if (!executable) continue;

    return { kind: 'plugin', executable, pluginId: PLUGIN_ID, pluginRoot };
  }
  return undefined;
}

function findCandidate(
  dependencies: PlannotatorTuiDependencies,
): TuiCandidate | undefined {
  if (!hasHerdrContext(dependencies)) return undefined;

  const standalone = dependencies.resolveExecutable(STANDALONE_EXECUTABLE_NAME);
  if (standalone && dependencies.isExecutableFile(standalone)) {
    return { kind: 'standalone', executable: standalone };
  }

  const registry = dependencies.readHerdrPluginRegistry();
  const candidate = findPluginCandidate(registry);
  if (candidate && dependencies.isExecutableFile(candidate.executable))
    return candidate;
  return undefined;
}

async function makeTempArtifact(
  content: string,
): Promise<{ readonly path: string; readonly remove: () => Promise<void> }> {
  const directory = await mkdtemp(
    join(tmpdir(), 'pi-workflows-plannotator-tui-'),
  );
  const path = join(directory, 'artifact.md');
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  return {
    path,
    remove: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function spawnWithTimeout(
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string | undefined;
    readonly pluginId?: string;
    readonly timeoutMs: number;
  },
): Promise<{
  readonly exitCode: number | null;
  readonly signal: string | null;
}> {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    ...(options.pluginId
      ? { env: { ...process.env, HERDR_PLUGIN_ID: options.pluginId } }
      : {}),
    stdio: 'ignore',
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal });
    };
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      resolve({ exitCode: null, signal: 'SIGTERM' });
    }, options.timeoutMs);
    child.on('error', () => {
      finish(null, 'SIGTERM');
    });
    child.on('exit', (code, signal) => {
      finish(code, signal ?? null);
    });
  });
}

function readPluginRegistry(): unknown {
  try {
    const text = readFileSync(HERDR_PLUGIN_REGISTRY_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resolveExecutableOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const separators = process.platform === 'win32' ? ';' : ':';
  for (const directory of pathEnv.split(separators)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.F_OK | constants.X_OK);
      return candidate;
    } catch {
      // continue searching
    }
  }
  return undefined;
}

const DEFAULT_DEPENDENCIES: PlannotatorTuiDependencies = {
  herdrEnv: process.env.HERDR_ENV,
  herdrSocketPath: process.env.HERDR_SOCKET_PATH,
  herdrPaneId: process.env.HERDR_PANE_ID,
  resolveExecutable: resolveExecutableOnPath,
  isExecutableFile: defaultIsExecutableFile,
  readHerdrPluginRegistry: readPluginRegistry,
  makeTempArtifact,
  spawn: spawnWithTimeout,
};

export type PlannotatorTuiLauncher = {
  readonly isAvailable: () => boolean;
  readonly launch: (artifact: string) => Promise<TuiLaunchResult>;
  readonly cleanupArtifact: (path: string) => Promise<void>;
};

/**
 * Creates a launcher that prefers a standalone `plannotator-tui` executable on
 * PATH and falls back to Herdr's registered `annotate` plugin. All discovery
 * effects are synchronous so capability checks are cheap; only launch performs
 * async filesystem and process effects. All effects are injected through
 * `dependencies` so tests can control discovery, invocation, and cleanup.
 *
 * A successful launch returns the path to a private temporary Markdown artifact
 * that the caller owns. The launcher removes the artifact for every non-open
 * result; after an open result the caller must arrange cleanup through
 * `cleanupArtifact` when the review surface is no longer needed.
 */
export function createPlannotatorTuiLauncher(
  overrides: Partial<PlannotatorTuiDependencies> = {},
): PlannotatorTuiLauncher {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let cachedCandidate: TuiCandidate | undefined | null = null;

  function getCandidate(): TuiCandidate | undefined {
    if (cachedCandidate === null) {
      cachedCandidate = findCandidate(dependencies);
    }
    return cachedCandidate;
  }

  return {
    isAvailable: () => {
      cachedCandidate = findCandidate(dependencies);
      return cachedCandidate !== undefined;
    },
    launch: async (artifact: string): Promise<TuiLaunchResult> => {
      if (!hasHerdrContext(dependencies)) {
        return {
          kind: 'unavailable',
          reason: 'Herdr context is missing',
        };
      }

      const candidate = getCandidate();
      if (!candidate) {
        return {
          kind: 'unavailable',
          reason:
            'Plannotator TUI is not installed and no Herdr annotate plugin is available',
        };
      }

      const paneId = dependencies.herdrPaneId;
      if (!paneId) {
        return {
          kind: 'unavailable',
          reason: 'Herdr pane context is missing',
        };
      }

      const { path, remove } = await dependencies.makeTempArtifact(artifact);
      const args = ['herdr', 'open', path, '--deliver-to', paneId];
      const cwd =
        candidate.kind === 'plugin' ? candidate.pluginRoot : undefined;
      const spawnResult = await dependencies.spawn(candidate.executable, args, {
        cwd,
        ...(candidate.kind === 'plugin'
          ? { pluginId: candidate.pluginId }
          : {}),
        timeoutMs: 5_000,
      });

      if (spawnResult.exitCode === 0) {
        return { kind: 'opened', artifactPath: path };
      }

      await remove();
      if (spawnResult.signal !== null || spawnResult.exitCode === null) {
        return {
          kind: 'failed',
          reason: `Plannotator TUI launch was terminated (${spawnResult.signal ?? 'timeout'})`,
        };
      }
      return {
        kind: 'failed',
        reason: `Plannotator TUI launch failed with exit code ${spawnResult.exitCode}`,
      };
    },
    cleanupArtifact: async (path: string): Promise<void> => {
      await rm(path, { force: true });
      const directory = path.replace(/\/artifact\.md$/, '');
      if (directory !== path) {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
