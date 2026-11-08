/** Pure logic for Git status and history (spec: git-setup). The Git commands themselves are in adapters/git. */
import { HISTORY_WINDOW_DAYS, MAX_HISTORY_CHARS, MAX_HISTORY_COMMITS, REMOTE_PROVIDER_LINKS } from "./constants/git.js";
import { redact } from "./redaction.js";

export interface GitRemote {
  readonly name: string;
  readonly host: string;
}

export type GitStatus =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "no-repository" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "repository";
      readonly root: string;
      readonly hasCommits: boolean;
      readonly isShallow: boolean;
      readonly remote: GitRemote | undefined;
    };

export interface GitCommit {
  readonly hash: string;
  readonly date: string;
  readonly message: string;
  readonly paths: readonly string[];
}

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

/** The `git log` format that parseGitLog reads. */
export const GIT_LOG_FORMAT = "--format=%x1e%h%x1f%ad%x1f%B%x1f";

export function parseGitLog(output: string): GitCommit[] {
  return output
    .split(RECORD_SEPARATOR)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [hash = "", date = "", message = "", pathText = ""] = record.split(FIELD_SEPARATOR);
      const paths = pathText.split("\n").filter((line) => line.trim() !== "");
      return { hash, date, message: message.trim(), paths };
    });
}

export interface HistoryContext {
  readonly text: string;
  readonly commitCount: number;
  readonly omittedCount: number;
}

function renderCommit(commit: GitCommit, paths: readonly string[]): string {
  return `${commit.hash} ${commit.date}\n${redact(commit.message).text}\nFiles: ${paths.join(", ")}`;
}

/**
 * Applies the scan rules to paths, redacts messages and enforces limits, keeping the newest commits
 * (FR-GIT-015, FR-GIT-016). `commits` must be newest first, and `totalInWindow` counts all in the window.
 */
export function buildHistoryContext(
  commits: readonly GitCommit[],
  totalInWindow: number,
  isPathAllowed: (path: string) => boolean,
): HistoryContext {
  const parts: string[] = [];
  let chars = 0;
  let isFull = false;
  let droppedForSize = 0;
  for (const commit of commits.slice(0, MAX_HISTORY_COMMITS)) {
    const paths = commit.paths.filter(isPathAllowed);
    if (paths.length === 0) continue;
    const rendered = renderCommit(commit, paths);
    if (isFull || chars + rendered.length > MAX_HISTORY_CHARS) {
      isFull = true;
      droppedForSize += 1;
      continue;
    }
    parts.push(rendered);
    chars += rendered.length;
  }
  return {
    text: parts.join("\n\n"),
    commitCount: parts.length,
    omittedCount: Math.max(0, totalInWindow - MAX_HISTORY_COMMITS) + droppedForSize,
  };
}

/** The host only, so credentials in a remote URL can never be shown (FR-GIT-011). */
export function remoteHost(url: string): string {
  const trimmed = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  if (withScheme !== null) {
    try {
      return new URL(trimmed).hostname || "local";
    } catch {
      return "unknown host";
    }
  }
  const scpStyle = /^(?:[^@/\s]+@)?([^:/\s]+):[^/]/.exec(trimmed);
  return scpStyle?.[1] ?? "local";
}

export function describeGitStatus(status: GitStatus, commitCount: number): string {
  switch (status.kind) {
    case "disabled":
      return "turned off with --no-git";
    case "not-installed":
      return "not installed, so continuing without history";
    case "no-repository":
      return "no repository, so a local one will be created";
    case "unavailable":
      return `unavailable, so continuing without history (${status.reason})`;
    case "repository": {
      const remote = status.remote === undefined ? "no remote" : `remote ${status.remote.name} (${status.remote.host})`;
      return `repository, ${remote}, ${commitCount} ${commitCount === 1 ? "commit" : "commits"} from the last ${HISTORY_WINDOW_DAYS} days as context`;
    }
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export interface RemoteAlertInput {
  readonly hasCommits: boolean;
  readonly hasGitignore: boolean;
  readonly wasCreated: boolean;
}

/** Steps for any provider. cclinic never creates a remote itself (FR-GIT-009, FR-GIT-010). */
export function formatRemoteAlert({ hasCommits, hasGitignore, wasCreated }: RemoteAlertInput): string {
  const lines = [
    wasCreated ? "Git: created a local repository. It has no remote yet." : "Git: this repository has no remote yet.",
    "",
    "To back up and share this project:",
  ];
  let step = 1;
  if (!hasCommits) {
    lines.push(
      hasGitignore
        ? `  ${step}. Make your first commit:`
        : `  ${step}. Add a .gitignore, so dependencies and secrets aren't committed, then make your first commit:`,
      `       git add -A && git commit -m "Initial commit"`,
    );
    step += 1;
  }
  lines.push(
    `  ${step}. Create an empty repository on GitHub, GitLab or Bitbucket:`,
    ...REMOTE_PROVIDER_LINKS.map((link) => `       ${link}`),
    `  ${step + 1}. Connect it and push:`,
    "       git remote add origin <repository-url>",
    "       git push -u origin HEAD",
  );
  return lines.join("\n");
}
