/**
 * Best-effort secret removal before content leaves the machine (FR-DISC-009).
 * Patterns use bounded repetition, so crafted input can't make them hang.
 */

interface SecretPattern {
  readonly type: string;
  readonly pattern: RegExp;
  /** Keeps a matched prefix, such as a connection string's scheme and user. */
  readonly replace?: (match: string, ...groups: string[]) => string;
}

const placeholder = (type: string): string => `[REDACTED:${type}]`;

const PATTERNS: readonly SecretPattern[] = [
  {
    type: "private-key",
    pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
    // Keeps line numbers stable, so citations stay correct.
    replace: (match) => `${placeholder("private-key")}${"\n".repeat(match.split("\n").length - 1)}`,
  },
  { type: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,256}/g },
  { type: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,256}/g },
  { type: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})/g },
  { type: "slack-token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,255}/g },
  { type: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,2048}/g },
  {
    type: "connection-string",
    pattern: /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{0,256}:)[^\s@/]{1,256}(@)/gi,
    replace: (_match, prefix = "", suffix = "") => `${prefix}${placeholder("connection-string")}${suffix}`,
  },
];

export interface RedactionResult {
  readonly text: string;
  readonly counts: Readonly<Record<string, number>>;
}

export function redact(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let result = text;
  for (const { type, pattern, replace } of PATTERNS) {
    result = result.replace(pattern, (match: string, ...rest: unknown[]) => {
      counts[type] = (counts[type] ?? 0) + 1;
      if (replace === undefined) return placeholder(type);
      const groups = rest.filter((item): item is string => typeof item === "string");
      return replace(match, ...groups);
    });
  }
  return { text: result, counts };
}

export function countRedactions(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}
