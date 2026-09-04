import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type ConfigFileSystem,
  type LoadedSettings,
} from '../../domain/index.ts';
import {
  createDiagnostic,
  errorCode,
  errorMessage,
  validateSettings,
} from '../../function/index.ts';
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
