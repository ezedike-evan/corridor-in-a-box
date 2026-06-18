// Flat ESLint config. Type-aware linting across the monorepo's TS sources,
// with Prettier owning formatting (eslint-config-prettier turns off any rule
// that would fight the formatter).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // web/ is a standalone Next.js app with its own toolchain and lint config.
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "web/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Money/PII discipline: prefer explicit handling, but allow intentional
      // `void x` discards used to mark deliberately-unused port arguments.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
