/** Which paths are analysed or skipped (spec: file-discovery). Pure, so paths use forward slashes. */
import {
  BINARY_EXTENSIONS,
  CONFIG_EXTENSIONS,
  CONFIG_NAMES,
  DEPENDENCY_FOLDERS,
  DOCUMENT_EXTENSIONS,
  LOCKFILES,
  REASONS,
  SECRET_EXTENSIONS,
  SECRET_FOLDERS,
  SECRET_NAMES,
  TOOL_FOLDERS,
} from "./constants/discovery.js";
import { BINARY_SNIFF_BYTES, BUNDLE_AVERAGE_LINE_LENGTH, GENERATED_MARKER_LINES } from "./constants/limits.js";
import type { FileKind } from "./ports.js";

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.startsWith("secrets.") ||
    SECRET_NAMES.has(lower) ||
    SECRET_EXTENSIONS.has(extensionOf(lower))
  );
}

export interface RuleContext {
  readonly outFolder?: string;
  readonly nupkgFolders?: ReadonlySet<string>;
  isExcluded(path: string, isDirectory: boolean): boolean;
  isIncluded(path: string, isDirectory: boolean): boolean;
  isIgnored(path: string, isDirectory: boolean): boolean;
}

export type Decision =
  | { readonly keep: true; readonly forced: boolean }
  | { readonly keep: false; readonly reason: string; readonly overridable: boolean };

function isUnderTool(segments: readonly string[], path: string, outFolder: string | undefined): boolean {
  if (segments.some((segment) => TOOL_FOLDERS.has(segment))) return true;
  return outFolder !== undefined && (path === outFolder || path.startsWith(`${outFolder}/`));
}

function isUnderDependency(
  segments: readonly string[],
  path: string,
  isDirectory: boolean,
  nupkgFolders: ReadonlySet<string> | undefined,
): boolean {
  const folders = isDirectory ? segments : segments.slice(0, -1);
  if (folders.some((segment) => DEPENDENCY_FOLDERS.has(segment))) return true;
  if (nupkgFolders === undefined) return false;
  for (const folder of nupkgFolders) {
    if (path === folder || path.startsWith(`${folder}/`)) return true;
  }
  return false;
}

/** Applies the rules in order, and the first match decides (FR-DISC-001). */
export function evaluatePath(path: string, isDirectory: boolean, context: RuleContext): Decision {
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;

  if (segments.some((segment) => SECRET_FOLDERS.has(segment)) || (!isDirectory && isSecretName(name))) {
    return { keep: false, reason: REASONS.secret, overridable: false };
  }
  if (isUnderTool(segments, path, context.outFolder)) {
    return { keep: false, reason: REASONS.tool, overridable: false };
  }
  if (context.isExcluded(path, isDirectory)) {
    return { keep: false, reason: REASONS.excluded, overridable: false };
  }
  if (context.isIncluded(path, isDirectory)) return { keep: true, forced: true };
  if (context.isIgnored(path, isDirectory)) {
    return { keep: false, reason: REASONS.ignored, overridable: true };
  }
  if (isUnderDependency(segments, path, isDirectory, context.nupkgFolders)) {
    return { keep: false, reason: REASONS.dependency, overridable: true };
  }
  if (isDirectory) return { keep: true, forced: false };
  if (BINARY_EXTENSIONS.has(extensionOf(name))) {
    return { keep: false, reason: REASONS.binary, overridable: true };
  }
  const lower = name.toLowerCase();
  if (LOCKFILES.has(lower)) return { keep: false, reason: REASONS.lockfile, overridable: true };
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".map")) {
    return { keep: false, reason: REASONS.minified, overridable: true };
  }
  return { keep: true, forced: false };
}

export function classifyFile(path: string): FileKind {
  const extension = extensionOf(path);
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  const name = baseName(path).toLowerCase();
  if (CONFIG_EXTENSIONS.has(extension) || CONFIG_NAMES.has(name)) return "config";
  return "code";
}

/** A NUL byte in the first 8 KB means binary (FR-DISC-006). */
export function hasBinaryContent(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function hasGeneratedMarker(text: string): boolean {
  const firstLines = text.split("\n", GENERATED_MARKER_LINES).join("\n");
  return firstLines.includes("@generated") || firstLines.includes("DO NOT EDIT");
}

export function looksBundled(text: string): boolean {
  if (text.length === 0) return false;
  const lineCount = text.split("\n").length;
  return text.length / lineCount > BUNDLE_AVERAGE_LINE_LENGTH;
}

export function isBroadTarget(absolutePath: string, homeFolder: string): boolean {
  const normalized = absolutePath.replace(/[\\/]+$/, "");
  const isRoot = normalized === "" || /^[A-Za-z]:$/.test(normalized);
  return isRoot || normalized === homeFolder.replace(/[\\/]+$/, "");
}
