# File discovery

## Goal

Find the project's own code and documents on any technology stack, while keeping out dependencies, build output, binaries and secrets.

## Requirements

### Rule order

- **FR-DISC-001** Each path MUST be checked in this order, and the first matching rule decides the result:
  1. Secrets: skip (FR-DISC-008)
  2. Tool folders (`.git`, `.cclinic`, `.agents`, `.claude`, the `--out` folder): skip
  3. `--exclude`: skip
  4. `--include`: keep
  5. Ignore files: skip
  6. Dependency and build folders: skip
  7. Binary files: skip
  8. Lockfiles, minified and generated files, oversized files: skip
  9. Everything else: keep
- **FR-DISC-002** `--include` MUST NOT override secret or tool-folder rules. A binary file forced in with `--include` that can't be read as text MUST be reported as skipped.

### Rules

- **FR-DISC-003** cclinic MUST honour `.gitignore` files at every level of the target folder, and an optional `.cclinicignore` in the target root using the same syntax. This MUST work whether or not the folder is a git repository.
- **FR-DISC-004** The following folder names MUST be skipped at any depth: `node_modules`, `vendor`, `bower_components`, `.pnpm`, `.yarn`, `site-packages`, `__pycache__`, `.venv`, `venv`, `target`, `dist`, `build`, `out`, `obj`, `Pods`, `Carthage`, `DerivedData`, `.gradle`, `.dart_tool`, `_build`, `deps`, `.terraform`, `.next`, `.nuxt`.
- **FR-DISC-005** Folders named `lib`, `bin` and `src` MUST NOT be skipped because of their name. A folder named `packages` MUST be skipped only if it directly or through its immediate subfolders contains `.nupkg` files.
- **FR-DISC-006** Binary files MUST be skipped by extension: `.dll`, `.exe`, `.so`, `.dylib`, `.a`, `.lib`, `.jar`, `.war`, `.class`, `.pyc`, `.pyo`, `.o`, `.obj`, `.wasm`, `.nupkg`, `.bin`, common image, audio and video formats, archives and fonts. Any other file containing a NUL byte in its first 8 KB MUST also be treated as binary. `.pdf` and `.docx` are documents and MUST NOT be skipped by this rule.
- **FR-DISC-007** These MUST be skipped:
  - Lockfiles, including `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Pipfile.lock`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, `go.sum` and `packages.lock.json`
  - Minified files (`*.min.js`, `*.min.css`, `*.map`) and bundled files whose average line length is over 500 characters
  - Generated files, identified by a `@generated` or `DO NOT EDIT` marker in the first 20 lines
  - Text files over `--max-file-size-mib` (default 1 MiB) and documents over 50 MiB

### Secrets

- **FR-DISC-008** These MUST never be read, and no option can override this: `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`, `credentials.json`, `secrets.*`, `.npmrc`, `.pypirc`, `.netrc`, and anything inside `.ssh` or `.aws`.
- **FR-DISC-009** Before any content is sent, secret-shaped text in included files MUST be replaced with `[REDACTED:<type>]`. Detection MUST cover at least AWS access keys, Anthropic and OpenAI keys, GitHub tokens, Slack tokens, JWTs, private key blocks, and credentials in connection strings. Reports MUST give only the file and count, never the secret.

### Walking and reporting

- **FR-DISC-010** Symbolic links MUST NOT be followed, so a scan can't leave the target folder or loop.
- **FR-DISC-011** Files MUST be processed in sorted path order, so the same input gives the same scan result.
- **FR-DISC-012** Included files MUST be classified as `code`, `config` or `document`. Files that can't be read because of permissions MUST be recorded as skipped, and the scan MUST continue.
- **FR-DISC-013** Every skipped file MUST be recorded with its reason. A skipped folder MAY be recorded as one entry rather than listing its contents. These records feed `scan-report.md`.
- **FR-DISC-014** If no files remain after the rules are applied, cclinic MUST say so and exit with the usage error code without calling an LLM.

## Edge cases

- `.env.example` is skipped too. It's rarely worth the risk of including a real value by mistake.
- A project's own folder named `vendor` or `build` can be brought back with `--include "vendor/**"`.
- A git submodule is scanned as ordinary files unless it's ignored, because cclinic can't tell whether it's first-party.

## Non-goals

- Reading dependency manifests to identify every third-party file.
- Detecting vendored code that has been copied into first-party folders.
- Guaranteeing that all secrets are caught. Redaction is best-effort, and the summary and confirmation give users a chance to stop.
