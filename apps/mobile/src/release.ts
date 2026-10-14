/**
 * Phase 49 (spec D1, D4). The three lines of the About screen and the text its
 * copy button puts on the clipboard. Each part reports itself: the bundle its
 * inlined tag and commit, the server its /health, the native layer its
 * fingerprint. Pure: _layout.tsx reads the values, the screen shows these.
 */

/** The installed binary, as expo-updates reports it (read in _layout.tsx, ADR 0002 R1). */
export type NativeLayer =
  | { kind: 'web' }
  | { kind: 'expo-go' }
  | { kind: 'build'; fingerprint: string; embedded: boolean };

/** What this bundle was built from: null where nothing was inlined. */
export type AppRelease = { version: string | null; commit: string | null; native: NativeLayer };

/** The server's own report, from /health. `commit` is absent before phase 49. */
export type ServerRelease =
  | { state: 'loading' }
  | { state: 'unreachable' }
  | { state: 'ok'; version: string; commit?: string };

const DIRTY = '-dirty';

function withCommit(version: string, commit: string | null | undefined): string {
  if (!commit) return version;
  const shown = commit.endsWith(DIRTY) ? `${commit.slice(0, -DIRTY.length)}, uncommitted changes` : commit;
  return `${version} (${shown})`;
}

export function mobileAppLine({ version, commit, native }: AppRelease): string {
  // Spec R1: the bundle inside a new binary is built on Expo's servers, where
  // the release's variables never reach. An update replaces it within minutes.
  if (version === null && native.kind === 'build' && native.embedded) return 'built-in';
  return withCommit(version ?? 'dev', commit);
}

export function serverLine(server: ServerRelease): string {
  if (server.state === 'loading') return '…';
  if (server.state === 'unreachable') return 'not reachable';
  return withCommit(server.version, server.commit);
}

export function nativeLine(native: NativeLayer): string {
  if (native.kind === 'web') return 'web';
  if (native.kind === 'expo-go') return 'Expo Go';
  return `fp ${native.fingerprint.slice(0, 7)}`;
}

export function releaseReport(app: AppRelease, server: ServerRelease): string {
  return [
    'WordsPal',
    `Mobile App: ${mobileAppLine(app)}`,
    `Server:     ${serverLine(server)}`,
    `Native:     ${nativeLine(app.native)}`,
  ].join('\n');
}

/** The Server line's state from a /health call: any failure, a 503 included, is unreachable. */
export async function readServerRelease(
  health: () => Promise<{ version: string; commit?: string }>,
): Promise<ServerRelease> {
  try {
    const { version, commit } = await health();
    return { state: 'ok', version, commit };
  } catch {
    return { state: 'unreachable' };
  }
}

/** Whether the clipboard took the text: the copy button confirms only then. */
export async function copyText(copy: (text: string) => Promise<boolean>, text: string): Promise<boolean> {
  try {
    return await copy(text);
  } catch {
    return false;
  }
}

/** Copying waits for /health, so a report never says `Server: …` (review M1). */
export function canCopy(server: ServerRelease): boolean {
  return server.state !== 'loading';
}
