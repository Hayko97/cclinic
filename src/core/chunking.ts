/** Groups files into modules and splits them into request-sized chunks (FR-ANA-001 to FR-ANA-004). */
import { baseName } from "./exclusion-rules.js";
import { CHARS_PER_TOKEN } from "./constants/llm.js";
import { FILE_OVERHEAD_CHARS, MAX_CHUNK_TOKENS } from "./constants/limits.js";
import type { ExtractedFile, TextUnit } from "./ports.js";

const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;
/** Between a line, page or heading reference and its text. */
const UNIT_SEPARATOR = ": ";
const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "gemfile",
  "mix.exs",
  "pubspec.yaml",
]);
const MANIFEST_SUFFIXES = [".csproj", ".fsproj", ".vbproj", ".gemspec"] as const;

export interface Module {
  readonly id: string;
  readonly files: readonly ExtractedFile[];
}

export interface Chunk {
  readonly moduleId: string;
  readonly index: number;
  readonly files: readonly ExtractedFile[];
}

function isManifest(path: string): boolean {
  const name = baseName(path).toLowerCase();
  return MANIFEST_NAMES.has(name) || MANIFEST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function moduleIdFor(path: string, manifestFolders: ReadonlySet<string>): string {
  let folder = folderOf(path);
  while (folder !== "") {
    if (manifestFolders.has(folder)) return folder;
    folder = folderOf(folder);
  }
  return path.split("/")[0] === path ? "root" : (path.split("/")[0] ?? "root");
}

export function groupIntoModules(files: readonly ExtractedFile[]): readonly Module[] {
  const manifestFolders = new Set(
    files
      .filter((file) => isManifest(file.path))
      .map((file) => folderOf(file.path))
      .filter((folder) => folder !== ""),
  );
  const modules = new Map<string, ExtractedFile[]>();
  for (const file of files) {
    const id = file.kind === "document" ? `document:${file.path}` : moduleIdFor(file.path, manifestFolders);
    const existing = modules.get(id);
    if (existing === undefined) modules.set(id, [file]);
    else existing.push(file);
  }
  return [...modules.entries()]
    .map(([id, moduleFiles]) => ({ id, files: moduleFiles }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Rendered size of a unit: its reference, a separator, its text and a line break. */
function unitChars(unit: TextUnit): number {
  return unit.ref.length + UNIT_SEPARATOR.length + unit.text.length + 1;
}

function withUnits(file: ExtractedFile, units: readonly TextUnit[]): ExtractedFile {
  return { ...file, units };
}

function splitLongUnit(unit: TextUnit): readonly TextUnit[] {
  if (unitChars(unit) <= MAX_CHUNK_CHARS - FILE_OVERHEAD_CHARS) return [unit];
  const size = MAX_CHUNK_CHARS - FILE_OVERHEAD_CHARS - unit.ref.length - UNIT_SEPARATOR.length - 1;
  const pieces: TextUnit[] = [];
  for (let start = 0; start < unit.text.length; start += size) {
    pieces.push({ ref: unit.ref, text: unit.text.slice(start, start + size) });
  }
  return pieces;
}

/** Splits a file on line, page or heading boundaries. Nothing is dropped (FR-EXT-005). */
function splitFile(file: ExtractedFile): readonly ExtractedFile[] {
  const parts: ExtractedFile[] = [];
  let current: TextUnit[] = [];
  let chars = FILE_OVERHEAD_CHARS;
  for (const unit of file.units.flatMap(splitLongUnit)) {
    const size = unitChars(unit);
    if (chars + size > MAX_CHUNK_CHARS && current.length > 0) {
      parts.push(withUnits(file, current));
      current = [];
      chars = FILE_OVERHEAD_CHARS;
    }
    current.push(unit);
    chars += size;
  }
  if (current.length > 0) parts.push(withUnits(file, current));
  return parts;
}

function fileChars(file: ExtractedFile): number {
  return file.units.reduce((total, unit) => total + unitChars(unit), FILE_OVERHEAD_CHARS);
}

export function chunkModule(module: Module): readonly Chunk[] {
  const chunks: Chunk[] = [];
  let current: ExtractedFile[] = [];
  let chars = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({ moduleId: module.id, index: chunks.length, files: current });
    current = [];
    chars = 0;
  };
  for (const file of module.files) {
    if (file.units.length === 0) continue;
    for (const part of splitFile(file)) {
      const size = fileChars(part);
      if (chars + size > MAX_CHUNK_CHARS) flush();
      current.push(part);
      chars += size;
    }
  }
  flush();
  return chunks;
}
