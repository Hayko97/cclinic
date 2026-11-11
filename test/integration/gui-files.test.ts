/** The GUI's own files and where HTTP code may live (spec: gui). */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(folder, name));
}

describe("GUI files", () => {
  it("TC-GUI-018: the GUI's pages reference no outside URL", () => {
    for (const name of readdirSync(path.join(SRC, "gui"))) {
      const text = readFileSync(path.join(SRC, "gui", name), "utf8");
      expect(text, name).not.toMatch(/https?:\/\//);
    }
  });

  it("TC-GUI-062: node:http is imported only in src/adapters/http/", () => {
    const importers = sourceFiles(SRC).filter((file) => /from "node:https?"/.test(readFileSync(file, "utf8")));
    expect(importers.map((file) => path.relative(SRC, file))).toEqual(["adapters/http/gui-server.ts"]);
  });
});
