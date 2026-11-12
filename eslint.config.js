import tseslint from "typescript-eslint";

const config = tseslint.config(
  { ignores: ["dist/", "coverage/", "reports/", ".stryker-tmp/", "bin/", "test/fixtures/", "*.cjs", "*.config.js"] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true, named: true, defaultFrom: true } }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    // The GUI's browser script isn't part of the TypeScript project, so it's linted without type information.
    files: ["src/gui/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: "module",
      globals: {
        document: "readonly",
        location: "readonly",
        history: "readonly",
        fetch: "readonly",
        EventSource: "readonly",
        Event: "readonly",
        CSS: "readonly",
        navigator: "readonly",
        FormData: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    // Values belong in src/core/constants (see "Hardcoded values" in the developer guidelines).
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/core/constants/**"],
    rules: {
      "@typescript-eslint/no-magic-numbers": [
        "error",
        { ignore: [0, 1, -1], ignoreEnums: true, ignoreArrayIndexes: true, enforceConst: true },
      ],
    },
  },
);

// ESLint loads its flat configuration through the default export.
export default config;
