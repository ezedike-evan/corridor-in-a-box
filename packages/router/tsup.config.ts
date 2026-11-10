import { defineConfig } from "tsup";

// ESM with type declarations. In-repo code and tests resolve @corridor/* from source
// through tsconfig paths and the vitest aliases; this output is what gets published.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
});
