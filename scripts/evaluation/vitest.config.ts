import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  cacheDir: path.join(os.tmpdir(), "automaton-evaluation-vite"),
  test: {
    include: ["scripts/evaluation/offline.test.ts"],
    testTimeout: 20_000,
    teardownTimeout: 5_000,
    minWorkers: 1,
    maxWorkers: 1,
  },
});
