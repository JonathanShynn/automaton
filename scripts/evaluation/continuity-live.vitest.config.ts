// No imports: copied to /tmp so Vite never writes a bundled config into /app.
export default {
  cacheDir: "/tmp/continuity-live-vite",
  test: {
    setupFiles: ["./src/__tests__/offline-setup.ts"],
    include: ["src/__tests__/gemini-continuity.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30000,
  },
};
