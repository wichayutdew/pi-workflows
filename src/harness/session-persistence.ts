import { existsSync, writeFileSync } from 'node:fs';
import type {
  ExtensionContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

type SessionSnapshot = Pick<
  ExtensionContext['sessionManager'],
  'getEntries' | 'getHeader' | 'getSessionFile'
>;

type AdoptableSessionSnapshot = SessionSnapshot &
  Pick<SessionManager, 'setSessionFile'>;

const isAlreadyPersisted = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST';

function getAdoptableSession(
  session: SessionSnapshot,
): AdoptableSessionSnapshot {
  const adoptable = session as Partial<AdoptableSessionSnapshot>;
  if (typeof adoptable.setSessionFile !== 'function') {
    throw new Error(
      'This Pi runtime cannot adopt a materialized workflow session file',
    );
  }
  return adoptable as AdoptableSessionSnapshot;
}

/**
 * Materializes a Pi session before its first regular assistant message.
 *
 * Pi defers creating a new session file until it records a regular assistant
 * message. A workflow made entirely of delegated steps can therefore have
 * checkpoint entries in memory but no file to reopen. After creating a public
 * session snapshot, this re-adopts the same file through Pi's public
 * `SessionManager#setSessionFile` method. That marks the running manager as
 * flushed, allowing Pi to append future custom and assistant entries normally.
 *
 * @param session - Public snapshot view supplied by Pi's extension context.
 * @returns `true` when this call created the session file.
 */
export function flushUnwrittenSession(session: SessionSnapshot): boolean {
  const sessionFile = session.getSessionFile();
  const header = session.getHeader();
  if (!sessionFile || !header) return false;
  if (existsSync(sessionFile)) return false;
  const adoptable = getAdoptableSession(session);

  const serialized = [header, ...session.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join('\n');

  try {
    writeFileSync(sessionFile, `${serialized}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    adoptable.setSessionFile(sessionFile);
    return true;
  } catch (error) {
    if (isAlreadyPersisted(error)) return false;
    throw error;
  }
}
