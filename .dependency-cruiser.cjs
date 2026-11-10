/** Enforces the import rules in .cclinic/sdd/architecture.md. */
module.exports = {
  forbidden: [
    {
      name: "core-is-pure",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "^(src/(adapters|application|cli)|node:|fs|path|os|child_process|net|http|https|process)" },
    },
    {
      name: "core-only-zod",
      severity: "error",
      from: { path: "^src/core", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer"], pathNot: "node_modules/zod" },
    },
    {
      name: "application-only-core",
      severity: "error",
      from: { path: "^src/application", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^src/(core|application)" },
    },
    {
      name: "adapters-not-outward",
      severity: "error",
      from: { path: "^src/adapters" },
      to: { path: "^src/(application|cli)" },
    },
    {
      name: "adapters-not-sideways",
      severity: "error",
      from: { path: "^src/adapters/([^/]+)/" },
      to: { path: "^src/adapters/", pathNot: "^src/adapters/$1/" },
    },
    {
      name: "sdk-only-in-api-adapter",
      severity: "error",
      from: { pathNot: "^src/adapters/llm/anthropic-api" },
      to: { path: "node_modules/@anthropic-ai/sdk" },
    },
    {
      name: "mcp-sdk-only-in-mcp-adapter",
      severity: "error",
      from: { pathNot: "^src/adapters/mcp/" },
      // The SDK's subpath imports go through its exports map, which depcruise leaves unresolved, so match the name too.
      to: { path: "(^|node_modules/)@modelcontextprotocol/sdk" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "\\.test\\.ts$" },
  },
};
