import {
  EMPTY_PERMISSIONS,
  type BashMode,
  type BashPermission,
  type BashRule,
  type StepPermissions,
  type StepRequirements,
} from '../../../domain/index.ts';
import {
  EXECUTABLE_PATTERN,
  isJsonObject,
  MCP_SELECTOR_PATTERN,
  readString,
  readStringList,
  rejectUnknownKeys,
  RESOURCE_SELECTOR_PATTERN,
  TOOL_PATTERN,
  type ValidationErrors,
} from './shared.ts';

function emptyPermissions(): StepPermissions {
  return {
    tools: [],
    mcp: [],
    extensions: [],
    skills: [],
    bash: { mode: 'deny', allow: [] },
  };
}

function emptyRequirements(): StepRequirements {
  return {
    tools: [],
    extensions: [],
    skills: [],
  };
}

function parseBashRule(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): Array<BashRule> {
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return [];
  }
  rejectUnknownKeys(
    value,
    ['executable', 'argsPrefix', 'argsPrefixes'],
    path,
    errors,
  );

  const executable = readString(
    value.executable,
    `${path}.executable`,
    errors,
    { pattern: EXECUTABLE_PATTERN },
  );
  if (value.argsPrefix !== undefined && value.argsPrefixes !== undefined) {
    errors.push(`${path}: argsPrefix and argsPrefixes are mutually exclusive`);
  }

  if (value.argsPrefixes === undefined) {
    const argsPrefix = readStringList(
      value.argsPrefix,
      `${path}.argsPrefix`,
      errors,
      /^[^\s]+$/,
    );
    return executable ? [{ executable, argsPrefix }] : [];
  }
  if (!Array.isArray(value.argsPrefixes)) {
    errors.push(`${path}.argsPrefixes: expected an array of argument arrays`);
    return [];
  }
  if (value.argsPrefixes.length === 0) {
    errors.push(`${path}.argsPrefixes: at least one prefix is required`);
  }

  const prefixes = value.argsPrefixes.reduce<Array<Array<string>>>(
    (result, candidate, index) => {
      const prefixPath = `${path}.argsPrefixes[${index}]`;
      const prefix = readStringList(candidate, prefixPath, errors, /^[^\s]+$/);
      if (Array.isArray(candidate) && candidate.length === 0) {
        errors.push(`${prefixPath}: at least one argument is required`);
        return result;
      }
      if (prefix.length === 0) return result;
      if (
        result.some(
          (existing) => JSON.stringify(existing) === JSON.stringify(prefix),
        )
      ) {
        errors.push(`${prefixPath}: duplicate argument prefix`);
        return result;
      }
      return [...result, prefix];
    },
    [],
  );
  return executable
    ? prefixes.map((argsPrefix) => ({ executable, argsPrefix }))
    : [];
}

function parseBashPermission(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): BashPermission {
  if (value === undefined) {
    return { ...EMPTY_PERMISSIONS.bash, allow: [] };
  }
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return { ...EMPTY_PERMISSIONS.bash, allow: [] };
  }
  rejectUnknownKeys(value, ['mode', 'allow'], path, errors);

  const mode = readString(value.mode, `${path}.mode`, errors);
  const isValidMode =
    mode === 'deny' || mode === 'allow-list' || mode === 'unrestricted';
  if (!isValidMode) {
    errors.push(`${path}.mode: expected deny, allow-list, or unrestricted`);
  }

  const allow = Array.isArray(value.allow)
    ? value.allow.flatMap((rule, index) =>
        parseBashRule(rule, `${path}.allow[${index}]`, errors),
      )
    : [];
  if (value.allow !== undefined && !Array.isArray(value.allow)) {
    errors.push(`${path}.allow: expected an array`);
  }

  const normalizedMode: BashMode = isValidMode ? mode : 'deny';
  if (normalizedMode !== 'allow-list' && allow.length > 0) {
    errors.push(`${path}.allow: only valid when mode is "allow-list"`);
  }
  if (normalizedMode === 'allow-list' && allow.length === 0) {
    errors.push(`${path}: allow-list mode requires an allow rule`);
  }

  return {
    mode: normalizedMode,
    allow,
  };
}

/** Parse the permission block shared by workflow steps and user ceilings. */
export function parsePermissions(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): StepPermissions {
  if (value === undefined) {
    return emptyPermissions();
  }
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return emptyPermissions();
  }
  rejectUnknownKeys(
    value,
    ['tools', 'mcp', 'extensions', 'skills', 'bash'],
    path,
    errors,
  );

  const permissions: StepPermissions = {
    tools: readStringList(value.tools, `${path}.tools`, errors, TOOL_PATTERN),
    mcp: readStringList(value.mcp, `${path}.mcp`, errors, MCP_SELECTOR_PATTERN),
    extensions: readStringList(
      value.extensions,
      `${path}.extensions`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
    skills: readStringList(
      value.skills,
      `${path}.skills`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
    bash: parseBashPermission(value.bash, `${path}.bash`, errors),
  };
  if (permissions.bash.mode !== 'deny' && !permissions.tools.includes('bash')) {
    errors.push(`${path}.tools: must include "bash" when Bash is enabled`);
  }
  return permissions;
}

/** Parse requirements and ensure every requirement is permitted by the step. */
export function parseRequirements(
  value: unknown,
  permissions: StepPermissions,
  path: string,
  errors: ValidationErrors,
): StepRequirements {
  if (value === undefined) return emptyRequirements();
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return emptyRequirements();
  }
  rejectUnknownKeys(value, ['tools', 'extensions', 'skills'], path, errors);

  const requirements: StepRequirements = {
    tools: readStringList(value.tools, `${path}.tools`, errors, TOOL_PATTERN),
    extensions: readStringList(
      value.extensions,
      `${path}.extensions`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
    skills: readStringList(
      value.skills,
      `${path}.skills`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
  };

  requirements.tools
    .filter(
      (tool) =>
        !permissions.tools.includes(tool) &&
        !(tool === 'mcp' && permissions.mcp.length > 0),
    )
    .forEach((tool) =>
      errors.push(
        `${path}.tools: required tool "${tool}" is not allowed by this step`,
      ),
    );
  requirements.extensions
    .filter((extension) => !permissions.extensions.includes(extension))
    .forEach((extension) =>
      errors.push(
        `${path}.extensions: required extension "${extension}" is not allowed by this step`,
      ),
    );
  requirements.skills
    .filter((skill) => !permissions.skills.includes(skill))
    .forEach((skill) =>
      errors.push(
        `${path}.skills: required skill "${skill}" is not allowed by this step`,
      ),
    );
  return requirements;
}
