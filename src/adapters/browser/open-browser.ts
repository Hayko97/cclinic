/** Opens a link in the default browser, with the platform's own command and an argument array (FR-GUI-004). */
import { spawn } from "node:child_process";
import { BROWSER_OPEN_TIMEOUT_MS } from "../../core/constants/gui.js";

function opener(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // The empty argument is start's window title, so the link isn't taken for one.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Resolves once the browser was asked to open the link; rejects when the opener is missing or fails. */
export function openInBrowser(
  url: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { command, args } = opener(platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: "ignore", shell: false });
    const timer = setTimeout(() => {
      reject(new Error(`${command} didn't finish.`));
    }, BROWSER_OPEN_TIMEOUT_MS);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${String(code)}.`));
    });
  });
}
