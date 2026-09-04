// Split out of app/_layout.tsx so this can be unit tested: importing
// _layout.tsx directly under Jest fails (it eagerly requires the real native
// AsyncStorage module at module scope), so the pure "throw if missing" logic
// lives here instead, in a file with no side effects of its own. _layout.tsx
// still does the actual process.env.EXPO_PUBLIC_API_URL read at its own call
// site, since that's the literal expression Metro's build-time inliner needs
// to see.
export function requireEnvValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}
