// @sparticuz/chromium ships ESM-only types behind an `exports` map, which this
// project's classic (node10) module resolution can't read. Only the surface we
// actually use is declared.
declare module '@sparticuz/chromium' {
  const chromium: {
    args: string[];
    executablePath(input?: string): Promise<string>;
  };
  export default chromium;
}
