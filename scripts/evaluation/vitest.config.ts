import os from "node:os";
import path from "node:path";

// No package imports: the container copies this file to /tmp so Vite's
// temporary bundled configuration never needs to write to the application.
export default {
  cacheDir: path.join(os.tmpdir(), "automaton-evaluation-vite"),
  test: {
    include: ["scripts/evaluation/offline.test.ts"],
    testTimeout: 20_000,
    teardownTimeout: 5_000,
    minWorkers: 1,
    maxWorkers: 1,
  },
};
