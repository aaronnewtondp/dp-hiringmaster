// The frontend package has no @types/node (nothing in the app uses Node). The tests that read the backend's source as
// text (src/test/backendSource.ts) need just these two calls, so they are declared here instead of adding a dependency.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
  const fs: { readFileSync: typeof readFileSync; existsSync: typeof existsSync };
  export default fs;
}
