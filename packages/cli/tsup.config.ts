import { defineConfig } from "tsup";

// @corridor/manifest (and its own dependency @corridor/types) aren't published
// to npm — only this CLI is — so they must be inlined into the bundle rather
// than left as external `require`/`import` targets. Real third-party deps
// (zod, yaml, pulled in transitively via @corridor/manifest) stay external:
// they're on the public registry, so npm installs them normally for consumers.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  clean: true,
  noExternal: [/^@corridor\//],
});
