#!/usr/bin/env node
// Keep this file free of modern syntax, so that it can report an old Node.js clearly (FR-CLI-015).
// The minimum also lives in src/core/node-version.ts.
var parts = process.versions.node.split(".").map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 18)) {
  process.stderr.write(
    "cclinic needs Node.js 22.18 or newer. You have " +
      process.versions.node +
      ". Install a newer Node.js and try again.\n",
  );
  process.exit(2);
}
// Node 22 marks node:sqlite as experimental. Its warning would break --json output (FR-TASK-013).
var emitWarning = process.emitWarning;
process.emitWarning = function (warning, options) {
  var type = typeof options === "string" ? options : options && options.type;
  if (type === "ExperimentalWarning" && String(warning).indexOf("SQLite") !== -1) return;
  return emitWarning.apply(process, arguments);
};
import("../dist/main.js");
