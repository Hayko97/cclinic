import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanFolder, type ScanOptions } from "../../src/adapters/discovery/file-walker.js";
import { createExtractor, extractText } from "../../src/adapters/extraction/extract.js";
import { REASONS } from "../../src/core/constants/discovery.js";
import type { ScannedFile } from "../../src/core/ports.js";
import { chunkModule } from "../../src/core/chunking.js";
import { makeDocx, makePdf, makeTempFolder, writeProject } from "../support/helpers.js";

function options(target: string, overrides: Partial<ScanOptions> = {}): ScanOptions {
  return {
    target,
    outFolder: path.join(target, ".luseen", "sdd"),
    include: [],
    exclude: [],
    maxFileSizeMib: 1,
    ...overrides,
  };
}

async function includedPaths(target: string, overrides: Partial<ScanOptions> = {}): Promise<string[]> {
  return (await scanFolder(options(target, overrides))).included.map((file) => file.path);
}

function reasonFor(result: Awaited<ReturnType<typeof scanFolder>>, entry: string): string | undefined {
  return result.skipped.find((item) => item.path === entry)?.reason;
}

const DEPENDENCY_FOLDERS = [
  "node_modules",
  "vendor",
  "bower_components",
  ".pnpm",
  ".yarn",
  "site-packages",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "dist",
  "build",
  "out",
  "obj",
  "Pods",
  "Carthage",
  "DerivedData",
  ".gradle",
  ".dart_tool",
  "_build",
  "deps",
  ".terraform",
  ".next",
  ".nuxt",
];
const SECRET_FILES = [
  ".env",
  ".env.local",
  "server.pem",
  "server.key",
  "cert.p12",
  "cert.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.yaml",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".ssh/config",
  ".aws/config",
];

describe("file discovery", () => {
  it("TC-DISC-003: --include can't expose secrets or tool folders", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".env": "x", ".git/config": "x", ".luseen/x": "x", "a.ts": "a" });
    expect(await includedPaths(root, { include: ["**"] })).toEqual(["a.ts"]);
  });

  it("TC-DISC-004: a forced DLL is reported as unreadable", async () => {
    const root = makeTempFolder();
    writeProject(root, { "a.dll": new Uint8Array([77, 90, 0, 0]), "b.ts": "b" });
    const result = await scanFolder(options(root, { include: ["**/*.dll"] }));
    expect(reasonFor(result, "a.dll")).toBe(REASONS.unreadableBinary);
  });

  it("TC-DISC-005: nested .gitignore files work outside git, with negation", async () => {
    const root = makeTempFolder();
    writeProject(root, {
      ".gitignore": "*.log\nsecret/\n",
      "a.log": "x",
      "b.ts": "b",
      "secret/c.ts": "c",
      "sub/.gitignore": "*.tmp\n!keep.log\n",
      "sub/d.tmp": "d",
      "sub/keep.log": "k",
      "sub/e.ts": "e",
    });
    expect(await includedPaths(root)).toEqual([".gitignore", "b.ts", "sub/.gitignore", "sub/e.ts", "sub/keep.log"]);
  });

  it("TC-DISC-006: .luseenignore is honoured", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".luseenignore": "drafts/\n", "drafts/a.ts": "a", "b.ts": "b" });
    expect(await includedPaths(root)).toEqual([".luseenignore", "b.ts"]);
  });

  it("TC-DISC-007: every dependency folder is skipped at any depth", async () => {
    const root = makeTempFolder();
    for (const folder of DEPENDENCY_FOLDERS)
      writeProject(root, { [`${folder}/a.ts`]: "a", [`x/y/${folder}/a.ts`]: "a" });
    writeProject(root, { "keep.ts": "k" });
    expect(await includedPaths(root)).toEqual(["keep.ts"]);
  });

  it("TC-DISC-009: lib, bin and src are analysed", async () => {
    const root = makeTempFolder();
    writeProject(root, { "lib/a.ts": "a", "bin/b.sh": "b", "src/c.ts": "c" });
    expect(await includedPaths(root)).toEqual(["bin/b.sh", "lib/a.ts", "src/c.ts"]);
  });

  it("TC-DISC-010: packages is skipped only with NuGet artifacts", async () => {
    const root = makeTempFolder();
    writeProject(root, { "packages/a/index.ts": "a" });
    expect(await includedPaths(root)).toEqual(["packages/a/index.ts"]);
    const direct = makeTempFolder();
    writeProject(direct, { "packages/x.nupkg": "n", "packages/a.ts": "a", "k.ts": "k" });
    expect(await includedPaths(direct)).toEqual(["k.ts"]);
    const nested = makeTempFolder();
    writeProject(nested, { "packages/lib/x.nupkg": "n", "packages/lib/a.ts": "a", "k.ts": "k" });
    expect(await includedPaths(nested)).toEqual(["k.ts"]);
  });

  it("TC-DISC-012: a NUL byte means binary", async () => {
    const root = makeTempFolder();
    writeProject(root, { "a.txt": new Uint8Array([65, 0, 66]) });
    expect(reasonFor(await scanFolder(options(root)), "a.txt")).toBe(REASONS.binary);
  });

  it("TC-DISC-013: PDF and DOCX are included", async () => {
    const root = makeTempFolder();
    writeProject(root, { "a.pdf": makePdf(["hello"]), "b.docx": makeDocx([{ text: "hello" }]) });
    const { included } = await scanFolder(options(root));
    expect(included.map((file) => [file.path, file.kind])).toEqual([
      ["a.pdf", "document"],
      ["b.docx", "document"],
    ]);
  });

  it("TC-DISC-015: long-line bundles are skipped", async () => {
    const root = makeTempFolder();
    writeProject(root, { "bundle.js": `${"x".repeat(600)}\n${"y".repeat(600)}`, "normal.js": "const a = 1;\n" });
    expect(await includedPaths(root)).toEqual(["normal.js"]);
  });

  it("TC-DISC-016: generated markers count within the first 20 lines", async () => {
    const root = makeTempFolder();
    const lines = (count: number, marker: string): string => [...Array<string>(count - 1).fill("x"), marker].join("\n");
    writeProject(root, {
      "a.ts": "// @generated\n",
      "b.ts": lines(20, "// DO NOT EDIT"),
      "c.ts": lines(21, "// DO NOT EDIT"),
    });
    expect(await includedPaths(root)).toEqual(["c.ts"]);
  });

  it("TC-DISC-017: files above the limits are skipped, and those at the limit are kept", async () => {
    const root = makeTempFolder();
    const mib = 1024 * 1024;
    const textAt = "a\n".repeat(mib / 2);
    writeProject(root, {
      "at.txt": textAt,
      "over.txt": `${textAt}a`,
      "at.pdf": new Uint8Array(50 * mib),
      "over.pdf": new Uint8Array(50 * mib + 1),
    });
    expect(await includedPaths(root)).toEqual(["at.pdf", "at.txt"]);
  });

  it("TC-DISC-018: secret files are skipped, even with --include", async () => {
    const root = makeTempFolder();
    for (const file of SECRET_FILES) writeProject(root, { [file]: "MARKER-SECRET" });
    writeProject(root, { "a.ts": "a" });
    const result = await scanFolder(options(root, { include: ["**"] }));
    expect(result.included.map((file) => file.path)).toEqual(["a.ts"]);
    expect(JSON.stringify(result)).not.toContain("MARKER-SECRET");
  });

  it("TC-DISC-023: symbolic links aren't followed", async () => {
    const root = makeTempFolder();
    const outside = makeTempFolder();
    writeProject(outside, { "secret.ts": "outside" });
    writeProject(root, { "a.ts": "a" });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
    symlinkSync(root, path.join(root, "loop"));
    const result = await scanFolder(options(root));
    expect(result.included.map((file) => file.path)).toEqual(["a.ts"]);
    expect(reasonFor(result, "loop")).toBe(REASONS.symlink);
  });

  it("TC-DISC-024: results are sorted and repeatable", async () => {
    const root = makeTempFolder();
    writeProject(root, { "z.ts": "z", "a.ts": "a", "m/b.ts": "b" });
    expect(await includedPaths(root)).toEqual(["a.ts", "m/b.ts", "z.ts"]);
    expect(await includedPaths(root)).toEqual(await includedPaths(root));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "TC-DISC-026: an unreadable file is recorded, and the scan continues",
    async () => {
      const root = makeTempFolder();
      writeProject(root, { "locked.ts": "x", "ok.ts": "y" });
      chmodSync(path.join(root, "locked.ts"), 0o000);
      const result = await scanFolder(options(root));
      expect(result.included.map((file) => file.path)).toEqual(["ok.ts"]);
      expect(reasonFor(result, "locked.ts")).toBe(REASONS.unreadable);
    },
  );

  it("TC-DISC-030: --max-file-size-mib changes the limit", async () => {
    const root = makeTempFolder();
    writeProject(root, { "big.txt": "a\n".repeat(1.5 * 1024 * 1024) });
    expect(await includedPaths(root, { maxFileSizeMib: 5 })).toEqual(["big.txt"]);
    expect(await includedPaths(root)).toEqual([]);
  });
});

function scanned(root: string, relative: string, kind: ScannedFile["kind"] = "document"): ScannedFile {
  return { path: relative, absolutePath: path.join(root, relative), kind, sizeBytes: 0 };
}

describe("content extraction", () => {
  const extractor = createExtractor();

  it("TC-EXT-001: text and line numbers are correct", async () => {
    const root = makeTempFolder();
    writeProject(root, { "a.ts": "one\ntwo\r\nthree" });
    const result = await extractor.extract(scanned(root, "a.ts", "code"));
    expect(result.positioning).toBe("line");
    expect(result.units).toEqual([
      { ref: "1", text: "one" },
      { ref: "2", text: "two" },
      { ref: "3", text: "three" },
    ]);
  });

  it.each(["a.ts", "a.json", "a.md", "a.txt", "a.rst", "a.adoc"])(
    "TC-EXT-002: reads %s with line numbers",
    async (name) => {
      const root = makeTempFolder();
      writeProject(root, { [name]: "content" });
      expect((await extractor.extract(scanned(root, name))).units).toEqual([{ ref: "1", text: "content" }]);
    },
  );

  it("TC-EXT-003: invalid UTF-8 gets a warning and no error", () => {
    const result = extractText(
      { path: "a.txt", absolutePath: "", kind: "document", sizeBytes: 0 },
      Buffer.from([0x61, 0xff, 0x62]),
      "h",
    );
    expect(result.units[0]?.text).toBe("a�b");
    expect(result.warnings[0]).toContain("a.txt");
  });

  it("TC-EXT-004: each word is on the right page", async () => {
    const root = makeTempFolder();
    writeProject(root, {
      "a.pdf": makePdf(["alpha words on page one", "bravo words on page two", "charlie words on page three"]),
    });
    const result = await extractor.extract(scanned(root, "a.pdf"));
    expect(result.positioning).toBe("page");
    expect(result.units.map((unit) => unit.ref)).toEqual(["1", "2", "3"]);
    expect(result.units[1]?.text).toContain("bravo");
    expect(result.units[2]?.text).toContain("charlie");
    expect(result.warnings).toEqual([]);
  });

  it("TC-EXT-006: headings and table text are kept", async () => {
    const root = makeTempFolder();
    writeProject(root, {
      "a.docx": makeDocx(
        [
          { heading: true, text: "Scope" },
          { text: "Body text" },
          { heading: true, text: "Details" },
          { text: "More text" },
        ],
        ["CellOne", "CellTwo"],
      ),
    });
    const result = await extractor.extract(scanned(root, "a.docx"));
    expect(result.positioning).toBe("heading");
    expect(result.units.find((unit) => unit.text.includes("Body text"))?.ref).toBe("Scope");
    const details = result.units
      .filter((unit) => unit.ref === "Details")
      .map((unit) => unit.text)
      .join(" ");
    expect(details).toContain("CellOne");
    expect(details).toContain("CellTwo");
  });

  it("TC-EXT-007: a scanned PDF gets a warning and no text", async () => {
    const root = makeTempFolder();
    writeProject(root, { "a.pdf": makePdf(["", ""]) });
    const result = await extractor.extract(scanned(root, "a.pdf"));
    expect(result.units).toEqual([]);
    expect(result.warnings[0]).toContain("scanned");
  });

  it("TC-EXT-008: a partly scanned PDF lists its empty pages", async () => {
    const root = makeTempFolder();
    writeProject(root, { "a.pdf": makePdf(["plenty of readable words on this first page here", ""]) });
    const result = await extractor.extract(scanned(root, "a.pdf"));
    expect(result.units[0]?.text).toContain("plenty");
    expect(result.warnings[0]).toContain("pages 2");
  });

  it("TC-EXT-009: corrupt files and .doc files warn, and don't throw", async () => {
    const root = makeTempFolder();
    writeProject(root, { "bad.pdf": "not a pdf", "bad.docx": "not a docx", "old.doc": "legacy" });
    for (const [name, text] of [
      ["bad.pdf", "corrupt"],
      ["bad.docx", "corrupt"],
      ["old.doc", "legacy"],
    ] as const) {
      const result = await extractor.extract(scanned(root, name));
      expect(result.units).toEqual([]);
      expect(result.warnings[0]).toContain(name);
      expect(result.warnings[0]).toContain(text);
    }
  });

  it("TC-EXT-010: chunked content joins back to the original", async () => {
    const root = makeTempFolder();
    const original = Array.from({ length: 30_000 }, (_unused, index) => `${index} ${"z".repeat(40)}`).join("\n");
    writeProject(root, { "a.txt": original });
    const extracted = await extractor.extract(scanned(root, "a.txt"));
    const chunks = chunkModule({ id: "m", files: [extracted] });
    expect(chunks.length).toBeGreaterThan(1);
    const units = chunks.flatMap((chunk) => chunk.files.flatMap((file) => file.units));
    expect(units.map((unit) => unit.text).join("\n")).toBe(original);
    expect(units.at(-1)?.ref).toBe("30000");
  });

  it("TC-EXT-011: results have a correct hash of the original bytes", async () => {
    const root = makeTempFolder();
    writeFileSync(path.join(root, "a.txt"), "abc");
    const result = await extractor.extract(scanned(root, "a.txt"));
    expect(result.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(result).toMatchObject({ path: "a.txt", kind: "document" });
  });

  it("TC-EXT-013: a corrupt file doesn't stop good ones", async () => {
    const root = makeTempFolder();
    writeProject(root, { "bad.pdf": "nope", "good.txt": "fine" });
    const results = await Promise.all([
      extractor.extract(scanned(root, "bad.pdf")),
      extractor.extract(scanned(root, "good.txt")),
    ]);
    expect(results[0].warnings).toHaveLength(1);
    expect(results[1].units).toHaveLength(1);
  });
});
