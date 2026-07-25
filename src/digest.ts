import { createHash } from 'node:crypto';

/**
 * Computes a deterministic digest for an unknown value.
 */
export type DigestFunction = (value: unknown) => string;

/**
 * Effect boundary used to hash a canonical serialized value.
 */
export type DigestDependencies = {
  readonly hash: (serializedValue: string) => string;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }

  return value;
};

const sha256 = (serializedValue: string): string =>
  createHash('sha256').update(serializedValue).digest('hex');

/**
 * Creates a deterministic value-digest function around an injected hash
 * implementation.
 *
 * @param dependencies - Hash effect used after canonical serialization.
 * @returns A deterministic digest function.
 */
export function createDigest({ hash }: DigestDependencies): DigestFunction {
  return (value: unknown): string => hash(JSON.stringify(canonicalize(value)));
}

const defaultDigest = createDigest({ hash: sha256 });

/**
 * Produces a stable SHA-256 digest independent of object key insertion order.
 *
 * @param value - JSON-compatible value to digest.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function digest(value: unknown): string {
  return defaultDigest(value);
}
