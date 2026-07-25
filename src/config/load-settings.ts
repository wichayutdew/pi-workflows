import { join } from 'node:path';
import { createDiagnostic, errorCode, errorMessage } from './diagnostics.ts';
import type { ConfigFileSystem, LoadedSettings } from './load-types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { validateSettings } from './validate.ts';
import { parseYaml } from './yaml.ts';

/** Load user settings through the injected filesystem boundary. */
export async function loadSettings(
  fileSystem: ConfigFileSystem,
  userDirectory: string,
): Promise<LoadedSettings> {
  const path = join(userDirectory, 'settings.yaml');
  try {
    const text = await fileSystem.readTextFile(path);
    const validation = validateSettings(parseYaml(text, 'settings'));
    if (!validation.value) {
      return {
        settings: { ...DEFAULT_SETTINGS },
        diagnostics: validation.errors.map((message) =>
          createDiagnostic(path, message),
        ),
      };
    }
    return { settings: validation.value, diagnostics: [] };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { settings: { ...DEFAULT_SETTINGS }, diagnostics: [] };
    }
    return {
      settings: { ...DEFAULT_SETTINGS },
      diagnostics: [
        createDiagnostic(path, `cannot read settings: ${errorMessage(error)}`),
      ],
    };
  }
}
