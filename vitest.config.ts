import { defineConfig } from "vitest/config";

/**
 * Node environment, no jsdom.
 *
 * Everything under test here is a pure function over plain data — the menu
 * model, path arithmetic, the persistence guards. A DOM would only make the
 * suite slower and invite tests that drive React instead of the logic.
 * `persist.ts` needs a `localStorage`, which its own test provides as a stub.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
