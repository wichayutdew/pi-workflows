import { parseDocument } from 'yaml';

export type YamlDocumentKind = 'settings' | 'workflow';

/** Parse one strict, single-document YAML 1.2 configuration value. */
export function parseYaml(text: string, kind: YamlDocumentKind): unknown {
  const document = parseDocument(text, {
    customTags: [],
    merge: false,
    prettyErrors: true,
    resolveKnownTags: false,
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join('\n'));
  }
  if (
    document.directives.yaml.explicit &&
    document.directives.yaml.version !== '1.2'
  ) {
    throw new Error(`${kind} YAML must use version 1.2`);
  }
  return document.toJS({ maxAliasCount: 100 }) as unknown;
}
