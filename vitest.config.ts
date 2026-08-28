import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts", "packages/**/src/**/*.spec.ts", "apps/**/src/**/*.spec.ts"],
    environment: "node",
    // `node:sqlite` is a recent built-in that Vite's resolver doesn't yet recognize.
    server: { deps: { external: ["node:sqlite"] } },
  },
});
