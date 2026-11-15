/** What the scan skips and how it classifies files (spec: file-discovery). */
import { LEGACY_TOOL_FOLDER_NAME, TOOL_FOLDER_NAME } from "./paths.js";

export const REASONS = {
  secret: "secret file",
  tool: "tool folder",
  excluded: "matched --exclude",
  ignored: "matched an ignore file",
  dependency: "dependency or build folder",
  binary: "binary file",
  unreadableBinary: "binary file that can't be read as text",
  lockfile: "lockfile",
  minified: "minified or bundled file",
  generated: "generated file",
  tooLarge: "file above the size limit",
  symlink: "symbolic link",
  unreadable: "no read permission",
} as const;

export const DEPENDENCY_FOLDERS: ReadonlySet<string> = new Set([
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
]);

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "dll exe so dylib a lib jar war class pyc pyo o obj wasm nupkg bin " +
    "png jpg jpeg gif bmp ico webp tiff svgz heic psd " +
    "mp3 wav ogg flac aac m4a mp4 mov avi mkv webm wmv " +
    "zip tar gz tgz bz2 xz 7z rar zst iso dmg " +
    "woff woff2 ttf otf eot " +
    "xls xlsx ppt pptx odt ods odp sqlite db"
  ).split(" "),
);

export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pipfile.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
]);

export const SECRET_NAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
]);
export const SECRET_EXTENSIONS: ReadonlySet<string> = new Set(["pem", "key", "p12", "pfx"]);
export const SECRET_FOLDERS: ReadonlySet<string> = new Set([".ssh", ".aws"]);
/** cclinic's folder too, which is left in place when `.luseen/` already exists (FR-CLI-039). */
export const TOOL_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  TOOL_FOLDER_NAME,
  LEGACY_TOOL_FOLDER_NAME,
  ".agents",
  ".claude",
]);

export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "pdf",
  "docx",
  "doc",
]);
export const BINARY_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(["pdf", "docx", "doc"]);
export const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "xml",
  "gradle",
  "csproj",
  "sln",
  "editorconfig",
]);
export const CONFIG_NAMES: ReadonlySet<string> = new Set([
  "dockerfile",
  "makefile",
  "jenkinsfile",
  "procfile",
  "gemfile",
  "rakefile",
]);
