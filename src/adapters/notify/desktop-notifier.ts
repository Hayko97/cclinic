/** Tells the user a run has ended, with the best notification the system offers (FR-AUTO-029). */
import { execFile } from "node:child_process";
import { NOTIFY_TIMEOUT_MS, TERMINAL_BELL } from "../../core/constants/agents.js";

export type NotificationChannel = "osascript" | "notify-send" | "terminal";

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, [...args], { env: environment, timeout: NOTIFY_TIMEOUT_MS }, (error) => {
      resolve(error === null);
    });
  });
}

const appleScriptString = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** A failed notification falls back to the terminal, and never fails the run. */
export async function notifyUser(input: {
  title: string;
  message: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  writeTerminal: (text: string) => void;
}): Promise<NotificationChannel> {
  if (input.platform === "darwin") {
    const script = `display notification ${appleScriptString(input.message)} with title ${appleScriptString(input.title)}`;
    if (await run("osascript", ["-e", script], input.environment)) return "osascript";
  } else if (input.platform === "linux") {
    if (await run("notify-send", [input.title, input.message], input.environment)) return "notify-send";
  }
  input.writeTerminal(`${TERMINAL_BELL}${input.title}: ${input.message}\n`);
  return "terminal";
}
