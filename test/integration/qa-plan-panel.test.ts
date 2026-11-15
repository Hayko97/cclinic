/// <reference lib="dom" />
/**
 * QA for the redesigned Plan panel (roadmap-planning FR-PLAN-034 to FR-PLAN-040, gui FR-GUI-064): behaviour the
 * browser tests in gui-plan.test.ts don't check. Tests named with a requirement ID and "QA" reproduce a defect:
 * they assert what the spec says.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { ANSWER_LAST_MESSAGE, newPlanSession, type PlanSession } from "../../src/core/planning.js";
import { sendTo } from "../support/gui.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 90_000;

let browser: Browser;
const running: TestGui[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  for (const title of ["Launch", "Payments"])
    store.savePlan({
      roadmap: { title, goal: "Ship" },
      milestones: [
        { title: "One", goal: "", tasks: [{ key: "x", title: "X", description: "", spec: null, dependsOn: [] }] },
      ],
    });
  store.close();
  return root;
}

/** Checks for changes made elsewhere, as the real GUI does, but often. */
function every(ms: number, run: () => Promise<void>): () => void {
  const timer = setInterval(() => void run(), Math.min(ms, 200));
  return () => {
    clearInterval(timer);
  };
}

async function startGui(root: string, rules: FakeClaudeRule[] = [], isPolling = false) {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(root, {}, { every: isPolling ? every : () => () => undefined }, harness.environment);
  running.push(gui);
  return { gui, harness };
}

async function openPage(
  gui: TestGui,
  options: {
    viewport?: { width: number; height: number };
    colorScheme?: "light" | "dark";
    reducedMotion?: "reduce";
  } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    colorScheme: options.colorScheme ?? "light",
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return page;
}

const line = (type: "user" | "assistant", content: unknown) =>
  `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content } })}\n`;

/** A session started in the terminal and no longer held, with this transcript. */
async function unheldSession(root: string, home: string, lines: readonly string[]): Promise<PlanSession> {
  const claudeSessionId = randomUUID();
  const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${claudeSessionId}.jsonl`);
  writeFileSync(file, lines.join(""));
  return openPlanStore(root).create((id) => ({
    ...newPlanSession({
      id,
      target: { kind: "new-roadmap" },
      summary: "A patient portal",
      holder: { place: "terminal", pid: process.pid },
      claudeSessionId,
      transcriptPath: file,
      now: new Date().toISOString(),
    }),
    holder: null,
  }));
}

/** A solid 40×40 PNG, so a thumbnail has a visible size. */
function png(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = ~0;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return ~value >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(40, 0);
  header.writeUInt32BE(40, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(
    Array.from({ length: 40 }, () => Buffer.from([0, ...Array.from({ length: 40 }, () => [200, 60, 60]).flat()])),
  );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Text in the panel whose contrast with what's behind it is under 4.5:1 (FR-GUI-064). */
function lowContrast(page: Page) {
  return page.evaluate(() => {
    const parse = (colour: string) => {
      const parts = (colour.match(/[\d.]+/g) ?? []).map(Number);
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    const over = (top: ReturnType<typeof parse>, bottom: ReturnType<typeof parse>) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const luminance = (c: ReturnType<typeof parse>) => {
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };
    const backdrop = (node: Element) => {
      const layers: ReturnType<typeof parse>[] = [];
      for (let at: Element | null = node; at !== null; at = at.parentElement) {
        const layer = parse(getComputedStyle(at).backgroundColor);
        if (layer.a > 0) layers.push(layer);
        if (layer.a === 1) break;
      }
      return layers.reverse().reduce((under, layer) => over(layer, under), { r: 255, g: 255, b: 255, a: 1 });
    };
    const ratio = (a: ReturnType<typeof parse>, b: ReturnType<typeof parse>) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
    };
    const panel = document.getElementById("plan-panel") as HTMLElement;
    const found: string[] = [];
    for (const node of panel.querySelectorAll("*")) {
      const element = node as HTMLElement;
      if (element.closest("[hidden]") !== null || element.closest(":disabled") !== null) continue;
      const ownText = [...element.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "",
      );
      if (!ownText || element.getClientRects().length === 0) continue;
      const style = getComputedStyle(element);
      const bg = backdrop(element);
      const fg = over(parse(style.color), bg);
      const value = ratio(fg, bg);
      if (value < 4.5)
        found.push(
          `${element.tagName}.${element.className} "${element.textContent.trim().slice(0, 30)}" ${value.toFixed(2)}`,
        );
    }
    const text = document.getElementById("plan-text") as HTMLTextAreaElement;
    if (!text.disabled) {
      const bg = backdrop(text);
      const placeholder = ratio(over(parse(getComputedStyle(text, "::placeholder").color), bg), bg);
      if (placeholder < 4.5) found.push(`placeholder ${placeholder.toFixed(2)}`);
    }
    return found;
  });
}

describe("QA: the Plan panel in the browser", () => {
  it(
    "FR-PLAN-038 QA: activity rows stay one whole readable line when the conversation overflows",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const lines: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        lines.push(line("user", `Question ${index} about the patient portal`));
        lines.push(
          line("assistant", [
            { type: "tool_use", id: `r${index}`, name: "Read", input: { file_path: `/x/brief-${index}.pdf` } },
          ]),
        );
        lines.push(
          line("assistant", [
            { type: "tool_use", id: `w${index}`, name: "WebSearch", input: { query: `portal ${index}` } },
          ]),
        );
        lines.push(
          line("assistant", [{ type: "text", text: `Answer ${index}.\n\nWith a second paragraph to fill the view.` }]),
        );
      }
      const session = await unheldSession(root, harness.environment.HOME ?? "", lines);
      const page = await openPage(gui, { viewport: { width: 1280, height: 700 } });
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-activity").count(), WAIT).toBe(16);
      const overflow = await page.locator("#plan-log").evaluate((log) => log.scrollHeight > log.clientHeight);
      expect(overflow).toBe(true);
      const rows = await page.locator("#plan-panel .plan-activity").evaluateAll((nodes) =>
        nodes.map((node) => {
          const row = (node.querySelector("summary") ?? node) as HTMLElement;
          return { height: row.getBoundingClientRect().height, needed: row.scrollHeight };
        }),
      );
      const fontSize = await page
        .locator("#plan-panel .plan-activity")
        .first()
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      for (const row of rows) {
        expect(row.height).toBeGreaterThanOrEqual(fontSize);
        expect(row.height).toBeGreaterThanOrEqual(row.needed - 1);
      }
    },
    SLOW,
  );

  it(
    "FR-PLAN-040 QA: the target, sessions and ⋯ menus work by keyboard, and Escape returns focus to their button",
    async () => {
      const root = project();
      const { gui } = await startGui(root);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      // Target pill: Enter opens it with focus on its first item; ArrowDown moves; Enter chooses.
      await page.locator("#plan-target").focus();
      await page.keyboard.press("Enter");
      expect(await page.locator("#plan-target-menu").isVisible()).toBe(true);
      expect(await page.locator("#plan-target").getAttribute("aria-expanded")).toBe("true");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("New roadmap");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Extend roadmap #2");
      await page.keyboard.press("Enter");
      expect(await page.locator("#plan-target-menu").isHidden()).toBe(true);
      expect(await page.locator("#plan-target").textContent()).toContain("#2");
      // Sessions menu: Space opens; Escape closes it, keeps the panel open and returns focus.
      await page.locator("#plan-sessions-button").focus();
      await page.keyboard.press(" ");
      expect(await page.locator("#plan-sessions-menu").isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
      await page.keyboard.press("Escape");
      expect(await page.locator("#plan-sessions-menu").isHidden()).toBe(true);
      expect(await page.locator("#plan-panel").isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("plan-sessions-button");
      expect(await page.locator("#plan-sessions-button").getAttribute("aria-expanded")).toBe("false");
      // Model pill: its selects are reachable with Tab, and Escape returns to the pill.
      await page.locator("#plan-model").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("SELECT");
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("plan-model");
      // Every icon button in the header and toolbar has a name for screen readers.
      const unnamed = await page
        .locator("#plan-panel .plan-icon, #plan-panel .plan-send")
        .evaluateAll((nodes) =>
          nodes.filter((node) => (node.getAttribute("aria-label") ?? "").trim() === "").map((node) => node.id),
        );
      expect(unnamed).toEqual([]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-057 QA: while the turn runs, the working row shows the newest activity from the transcript as one line",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Late", delayMs: 6_000 }], true);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add exports");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      const args = harness.calls()[0]?.args ?? [];
      const sessionId = args[args.indexOf("--session-id") + 1] ?? "";
      // Claude writes its transcript as it goes: the message, then a tool call.
      const folder = path.join(
        harness.environment.HOME ?? "",
        ".claude",
        "projects",
        realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"),
      );
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, `${sessionId}.jsonl`),
        line("user", "Add exports") +
          line("assistant", [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/x/brief.pdf" } }]),
      );
      const working = page.locator("#plan-panel .plan-working");
      await expect.poll(() => working.textContent(), WAIT).toContain("Read brief.pdf");
      expect(await working.textContent()).toMatch(/Working · \d+s/);
      expect((await working.boundingBox())?.height).toBeLessThan(28);
    },
    SLOW,
  );

  it(
    "FR-PLAN-038, FR-GUI-064 QA: with reduced motion the working row's spinner doesn't spin",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [{ message: "Late", delayMs: 4_000 }]);
      const page = await openPage(gui, { reducedMotion: "reduce" });
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add exports");
      await page.locator("#plan-text").press("Enter");
      const spinner = page.locator("#plan-panel .plan-working .plan-spinner");
      await spinner.waitFor(WAIT);
      expect(await spinner.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    },
    SLOW,
  );

  it(
    "FR-PLAN-036 QA: dragging shows the drop area, a dropped image is a chip with a thumbnail, and the area goes after the drop",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [{ message: "Nice mockup." }]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      const bytes = [...png()];
      const transfer = await page.evaluateHandle((data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], "mock.png", { type: "image/png" }));
        return transfer;
      }, bytes);
      await page.locator("#plan-log").dispatchEvent("dragenter", { dataTransfer: transfer });
      await page.locator("#plan-log").dispatchEvent("dragover", { dataTransfer: transfer });
      expect(await page.locator("#plan-drop").isVisible()).toBe(true);
      await page.locator("#plan-log").dispatchEvent("drop", { dataTransfer: transfer });
      await expect.poll(() => page.locator("#plan-chips .plan-chip").count(), WAIT).toBe(1);
      expect(await page.locator("#plan-drop").isHidden()).toBe(true);
      const thumb = page.locator('#plan-chips .plan-chip .plan-thumb[role="img"]');
      await expect.poll(() => thumb.count(), WAIT).toBe(1);
      expect(await thumb.getAttribute("aria-label")).toBe("mock.png");
      expect((await thumb.boundingBox())?.height).toBeGreaterThanOrEqual(16);
      expect(await page.locator("#plan-send").isDisabled()).toBe(false);
      // Sent, the user's message shows the image as a thumbnail from the server (FR-PLAN-037).
      await page.locator("#plan-text").fill("Here is the mockup");
      await page.locator("#plan-text").press("Enter");
      const sent = page.locator("#plan-panel .plan-user img.plan-thumb");
      await expect.poll(() => sent.getAttribute("alt"), WAIT).toBe("mock.png");
      await expect.poll(() => sent.evaluate((node) => (node as HTMLImageElement).naturalWidth), WAIT).toBe(40);
    },
    SLOW,
  );

  it(
    "FR-PLAN-034, FR-PLAN-040 QA (TC-PLAN-059): after Escape, or a reload, reopening Plan shows the same session",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [{ message: "Who pays?" }]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await expect.poll(() => page.locator("#plan-subtitle").textContent(), WAIT).toContain("plan-1");
      await page.keyboard.press("Escape");
      expect(await page.locator("#plan-panel").isHidden()).toBe(true);
      await page.locator("#plan-open").click();
      // Give the page time to redraw from the server, so the check doesn't read the conversation from before.
      await page.waitForTimeout(1_000);
      expect(await page.locator("#plan-subtitle").textContent()).toContain("plan-1");
      expect(await page.locator("#plan-panel .plan-pm:visible").count()).toBe(1);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator("#plan-open").click();
      await page.waitForTimeout(1_000);
      expect(await page.locator("#plan-subtitle").textContent()).toContain("plan-1");
      expect(await page.locator("#plan-panel .plan-pm .plan-md").textContent()).toBe("Who pays?");
    },
    SLOW,
  );

  for (const colorScheme of ["light", "dark"] as const)
    it(
      `FR-PLAN-033, FR-GUI-064 QA: every text in the panel meets 4.5:1 in the ${colorScheme} theme`,
      async () => {
        const root = project();
        const { gui } = await startGui(root, [
          {
            message: "Who pays? See [docs](https://example.com/d) and `code`.",
            toolUses: [{ name: "Read", input: { file_path: "/x/brief.pdf" } }],
            tools: [
              {
                name: "plan_suggest",
                input: { suggestions: ["Shoppers"], sources: [{ title: "Docs", url: "https://example.com/d" }] },
              },
            ],
          },
        ]);
        const page = await openPage(gui, { colorScheme });
        await page.locator("#plan-open").click();
        expect(await lowContrast(page)).toEqual([]);
        await page.locator("#plan-text").fill("Add checkout");
        await page.locator("#plan-text").press("Enter");
        await expect.poll(() => page.locator("#plan-suggestions button").count(), WAIT).toBe(1);
        expect(await lowContrast(page)).toEqual([]);
        await page.locator("#plan-more").click();
        expect(await lowContrast(page)).toEqual([]);
      },
      SLOW,
    );

  it(
    "TC-PLAN-057 QA (browser): Stop in the panel ends the working row, and Retry and Send come back",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(
        root,
        [{ message: "Who pays?" }, { message: "Late", delayMs: 20_000 }, { message: "Back." }],
        true,
      );
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await expect.poll(() => page.locator("#plan-send").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-text").fill("Shoppers");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-stop").click();
      // The server has ended the turn: the panel must show that too.
      await expect
        .poll(
          async () =>
            (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: { turn: unknown } }).plan.turn,
          WAIT,
        )
        .toBeNull();
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), { timeout: 5_000 }).toBe(0);
      expect(await page.locator("#plan-stop").isVisible()).toBe(false);
      expect(await page.locator("#plan-send").isVisible()).toBe(true);
      const retry = page.locator("#plan-panel").getByRole("button", { name: "Retry" });
      expect(await retry.isVisible()).toBe(true);
      await retry.click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      expect(harness.calls()[2]?.args).toContain("--resume");
    },
    SLOW,
  );

  it(
    "TC-PLAN-059 QA: scrolled up, Jump to latest is shown in the visible part of the conversation, and the view stays put",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [], true);
      const lines: string[] = [];
      for (let index = 0; index < 15; index += 1) {
        lines.push(line("user", `Question ${index}`));
        lines.push(line("assistant", [{ type: "text", text: `Answer ${index}.\n\nA second paragraph.` }]));
      }
      const session = await unheldSession(root, harness.environment.HOME ?? "", lines);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(15);
      await page.locator("#plan-log").evaluate((log) => {
        log.scrollTop = 0;
        log.dispatchEvent(new Event("scroll"));
      });
      const jump = page.locator("#plan-log").getByRole("button", { name: "Jump to latest" });
      await expect.poll(() => jump.count(), WAIT).toBe(1);
      const log = await page.locator("#plan-log").boundingBox();
      const box = await jump.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((log?.y ?? 0) + (log?.height ?? 0) + 1);
      expect(box?.y ?? 0).toBeGreaterThanOrEqual(log?.y ?? 0);
      // A new message while scrolled up doesn't move the view.
      const session1 = await openPlanStore(root).read(session.id);
      appendFileSync(session1?.transcriptPath ?? "", line("assistant", [{ type: "text", text: "Newest answer" }]));
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(16);
      expect(await page.locator("#plan-log").evaluate((node) => node.scrollTop)).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-022, FR-PLAN-036 QA: files left in a reloaded page don't count toward the next message's 10 files",
    async () => {
      const root = project();
      const { gui } = await startGui(root);
      const paste = (page: Page, names: string[]) =>
        page.evaluate((list) => {
          const data = new DataTransfer();
          for (const name of list) data.items.add(new File([`# ${name}`], name, { type: "text/markdown" }));
          document.getElementById("plan-text")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
        }, names);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await paste(
        page,
        Array.from({ length: 10 }, (_, index) => `notes-${index}.md`),
      );
      await expect.poll(() => page.locator("#plan-chips .plan-chip").count(), WAIT).toBe(10);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator("#plan-open").click();
      expect(await page.locator("#plan-chips .plan-chip").count()).toBe(0);
      await paste(page, ["brief.md"]);
      await expect.poll(() => page.locator("#plan-chips .plan-chip").count(), WAIT).toBe(1);
      expect(await page.locator("#plan-panel .plan-error").count()).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA (V2): a PM message written before its turn's plan_suggest call keeps that turn's sources",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const turn = (index: number) => [
        line("user", `Question ${index}`),
        line("assistant", [
          { type: "text", text: `Answer ${index}` },
          {
            type: "tool_use",
            id: `s${index}`,
            name: "mcp__cclinic__plan_suggest",
            input: {
              suggestions: ["Yes"],
              sources: [{ title: `Source ${index}`, url: `https://site${index}.example.org/` }],
            },
          },
        ]),
        line("user", [{ type: "tool_result", tool_use_id: `s${index}`, content: "Shown" }]),
      ];
      const session = await unheldSession(root, harness.environment.HOME ?? "", [...turn(1), ...turn(2)]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      const sources = await page
        .locator("#plan-panel .plan-pm")
        .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
      expect(sources[0]).toContain("site1.example.org");
      expect(sources[1]).toContain("site2.example.org");
    },
    SLOW,
  );

  it(
    "FR-PLAN-034 QA (DEF-2): a cancelled session shown is replaced by the start state when Plan is reopened, and the next message starts a new session",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who pays?" }, { message: "Noted." }]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await page.locator("#plan-more").click();
      await page.locator("#plan-cancel-session").click();
      await expect.poll(() => page.locator("#plan-panel .plan-outcome").count(), WAIT).toBe(1);
      expect(await page.locator("#plan-text").isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      await page.locator("#plan-open").click();
      await expect.poll(() => page.locator("#plan-panel .plan-empty").count(), WAIT).toBe(1);
      expect(await page.locator("#plan-subtitle").textContent()).toBe("New roadmap");
      expect(await page.locator("#plan-text").isDisabled()).toBe(false);
      await page.locator("#plan-text").fill("Add exports");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-subtitle").textContent(), WAIT).toContain("plan-2");
      // The fake claude records its call when its process starts, which can be after the reply.
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      expect(harness.calls()[1]?.args).toContain("--session-id");
    },
    SLOW,
  );

  it(
    "FR-PLAN-034, FR-GUI-078 QA (DEF-2): with a session open, a frame's Plan a task shows it, and New session then starts the task",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [{ message: "Who pays?" }]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await page.locator("#plan-close").click();
      await page.locator('[data-frame="roadmap-1"] button[data-action="plan-task"]').click();
      expect(await page.locator("#plan-subtitle").textContent()).toContain("plan-1");
      expect(await page.locator("#plan-panel .plan-pm").count()).toBe(1);
      await page.locator("#plan-sessions-button").click();
      await page.locator("#plan-sessions-menu [role=menuitem]").first().click();
      await expect.poll(() => page.locator("#plan-subtitle").textContent(), WAIT).toBe("One task in roadmap #1");
      expect(await page.locator("#plan-start-heading").textContent()).toBe("What's the change?");
    },
    SLOW,
  );
});

describe("QA run 3: late replies, uploads per page, and sources", () => {
  /** Holds back the reply to `pattern` until `release` is called, so it reaches the page after the stream's news. */
  async function holdReply(page: Page, pattern: string) {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let isDelivered = false;
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
      isDelivered = true;
    });
    return { release, delivered: () => isDelivered };
  }

  const serverTurn = async (gui: TestGui) =>
    (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: { turn: unknown } }).plan.turn;

  it(
    "FR-PLAN-038 QA (DEF-3): a Stop reply that arrives after the stream's update leaves the panel idle",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Late", delayMs: 20_000 }], true);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
      const held = await holdReply(page, "**/api/plan/stop");
      await page.locator("#plan-stop").click();
      await expect.poll(() => serverTurn(gui), WAIT).toBeNull();
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      held.release();
      await expect.poll(() => held.delivered(), WAIT).toBe(true);
      await page.waitForTimeout(500);
      expect(await page.locator("#plan-panel .plan-working").count()).toBe(0);
      expect(await page.locator("#plan-stop").isVisible()).toBe(false);
      expect(await page.locator("#plan-panel").getByRole("button", { name: "Retry" }).isVisible()).toBe(true);
    },
    SLOW,
  );

  it(
    "FR-PLAN-038 QA (DEF-3): a send reply that arrives after the PM has answered doesn't bring Working back",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who pays?" }, { message: "Shoppers, noted." }], true);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await expect.poll(() => serverTurn(gui), WAIT).toBeNull();
      const held = await holdReply(page, "**/api/plan/message");
      await page.locator("#plan-text").fill("Shoppers");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      await expect.poll(() => serverTurn(gui), WAIT).toBeNull();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      held.release();
      await expect.poll(() => held.delivered(), WAIT).toBe(true);
      await page.waitForTimeout(500);
      expect(await page.locator("#plan-panel .plan-working").count()).toBe(0);
      expect(await page.locator("#plan-send").isVisible()).toBe(true);
      expect(await page.locator("#plan-stop").isVisible()).toBe(false);
      // The message box is cleared once its reply came, and ready for the next message.
      expect(await page.locator("#plan-text").inputValue()).toBe("");
      expect(await page.locator("#plan-text").isDisabled()).toBe(false);
    },
    SLOW,
  );

  it(
    "FR-PLAN-038 QA (DEF-3): a Retry reply that arrives after the retried turn ended doesn't bring Working back",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(
        root,
        [{ message: "Who pays?" }, { message: "Late", delayMs: 20_000 }, { message: "Back." }],
        true,
      );
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await expect.poll(() => page.locator("#plan-send").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-text").fill("Shoppers");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-stop").click();
      const retry = page.locator("#plan-panel").getByRole("button", { name: "Retry" });
      await expect.poll(() => retry.isVisible(), WAIT).toBe(true);
      const held = await holdReply(page, "**/api/plan/retry");
      await retry.click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      await expect.poll(() => serverTurn(gui), WAIT).toBeNull();
      held.release();
      await expect.poll(() => held.delivered(), WAIT).toBe(true);
      await page.waitForTimeout(500);
      expect(await page.locator("#plan-panel .plan-working").count()).toBe(0);
      expect(await page.locator("#plan-send").isVisible()).toBe(true);
    },
    SLOW,
  );

  it(
    "FR-PLAN-034 QA (DEF-3): a late reply to opening a session doesn't undo New session chosen after it",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [], true);
      const session = await unheldSession(root, harness.environment.HOME ?? "", [
        line("user", "Question"),
        line("assistant", [{ type: "text", text: "Answer" }]),
      ]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      const held = await holdReply(page, "**/api/plan/open");
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-subtitle").textContent(), WAIT).toContain(session.id);
      await page.locator("#plan-sessions-button").click();
      await page.locator("#plan-sessions-menu [role=menuitem]").first().click();
      await expect.poll(() => page.locator("#plan-panel .plan-empty").count(), WAIT).toBe(1);
      held.release();
      await expect.poll(() => held.delivered(), WAIT).toBe(true);
      await page.waitForTimeout(500);
      expect(await page.locator("#plan-panel .plan-empty").count()).toBe(1);
      expect(await page.locator("#plan-subtitle").textContent()).toBe("New roadmap");
    },
    SLOW,
  );

  const paste = (page: Page, names: string[]) =>
    page.evaluate((list) => {
      const data = new DataTransfer();
      for (const name of list) data.items.add(new File([`# ${name}`], name, { type: "text/markdown" }));
      document.getElementById("plan-text")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
    }, names);

  it(
    "FR-PLAN-022 QA (DEF-5): two pages count their own files, and the 11th on one page is refused naming it and why",
    async () => {
      const root = project();
      const { gui } = await startGui(root);
      const first = await openPage(gui);
      await first.locator("#plan-open").click();
      await paste(
        first,
        Array.from({ length: 10 }, (_, index) => `a-${index}.md`),
      );
      await expect.poll(() => first.locator("#plan-chips .plan-chip").count(), WAIT).toBe(10);
      // Another page, open at the same time, has its own 10.
      const second = await openPage(gui);
      await second.locator("#plan-open").click();
      await paste(second, ["b-0.md"]);
      await expect.poll(() => second.locator("#plan-chips .plan-chip").count(), WAIT).toBe(1);
      expect(await second.locator("#plan-panel .plan-error").count()).toBe(0);
      // The first page's 11th is refused, by name, with the reason, and its 10 stay.
      await paste(first, ["eleventh.md"]);
      const error = first.locator("#plan-panel .plan-error");
      await expect.poll(() => error.count(), WAIT).toBeGreaterThan(0);
      const text = (await error.allTextContents()).join(" ");
      expect(text).toContain("eleventh.md");
      expect(text).toMatch(/10/);
      expect(await first.locator("#plan-chips .plan-chip").count()).toBe(10);
    },
    SLOW,
  );

  for (const [name, bytes, reason] of [
    ["song.mp3", 1, /only images .* and documents/],
    ["brief.md", 20 * 1024 * 1024 + 1, /20 MB/],
    ["huge.md", 25 * 1024 * 1024, /20 MB/],
  ] as const)
    it(
      `FR-PLAN-022, FR-PLAN-041 QA (DEF-7): ${name} (${bytes} bytes) is refused in the conversation naming it and why, with Remove file`,
      async () => {
        const root = project();
        const { gui } = await startGui(root);
        const page = await openPage(gui);
        await page.locator("#plan-open").click();
        await page.evaluate(
          ([fileName, size]) => {
            const data = new DataTransfer();
            data.items.add(new File([new Uint8Array(size)], fileName));
            document.getElementById("plan-text")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
          },
          [name, bytes] as const,
        );
        const error = page.locator("#plan-panel .plan-error");
        await expect.poll(() => error.count(), WAIT).toBe(1);
        expect(await error.textContent()).toContain(name);
        expect(await error.textContent()).toMatch(reason);
        expect(await page.locator("#plan-chips .plan-chip").count()).toBe(0);
        expect(await page.locator("#plan-panel").getByRole("button", { name: "Remove file" }).count()).toBe(1);
      },
      SLOW,
    );

  it(
    "FR-PLAN-022, FR-PLAN-041 QA (DEF-8): two refused files dropped together are both named in the conversation",
    async () => {
      const root = project();
      const { gui } = await startGui(root);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["x"], "song.mp3"));
        data.items.add(new File(["x"], "tool.exe"));
        document.getElementById("plan-text")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
      });
      const errors = page.locator("#plan-panel .plan-error");
      await expect.poll(async () => (await errors.allTextContents()).join(" "), WAIT).toContain("tool.exe");
      expect((await errors.allTextContents()).join(" ")).toContain("song.mp3");
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA (DEF-6): sources from a plan_suggest call made before the turn's text, and a turn without one shows none",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const lines = [
        line("user", "Question 1"),
        line("assistant", [
          {
            type: "tool_use",
            id: "s1",
            name: "mcp__cclinic__plan_suggest",
            input: { suggestions: ["Yes"], sources: [{ title: "One", url: "https://first.example.org/a" }] },
          },
        ]),
        line("user", [{ type: "tool_result", tool_use_id: "s1", content: "Shown" }]),
        line("assistant", [{ type: "text", text: "First part" }]),
        line("assistant", [{ type: "text", text: "Second part" }]),
        line("user", "Question 2"),
        line("assistant", [{ type: "text", text: "No sources here" }]),
      ];
      const session = await unheldSession(root, harness.environment.HOME ?? "", lines);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      const sources = await page
        .locator("#plan-panel .plan-pm")
        .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
      expect(`${sources[0] ?? ""} ${sources[1] ?? ""}`).toContain("first.example.org");
      expect(sources[2]).toBe("");
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA (DEF-9): a turn started by Retry or Propose now doesn't show the previous turn's sources",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const lines = [
        line("user", "Question 1"),
        line("assistant", [
          { type: "text", text: "First answer" },
          {
            type: "tool_use",
            id: "s1",
            name: "mcp__cclinic__plan_suggest",
            input: { suggestions: ["Yes"], sources: [{ title: "One", url: "https://first.example.org/a" }] },
          },
        ]),
        line("user", [{ type: "tool_result", tool_use_id: "s1", content: "Shown" }]),
        line("user", ANSWER_LAST_MESSAGE),
        line("assistant", [{ type: "text", text: "Here is a plan." }]),
      ];
      const session = await unheldSession(root, harness.environment.HOME ?? "", lines);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      const sources = await page
        .locator("#plan-panel .plan-pm")
        .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
      expect(sources[0]).toContain("first.example.org");
      expect(sources[1]).toBe("");
    },
    SLOW,
  );

  it(
    "FR-PLAN-038 QA (nit): every activity row is muted, and only rows with a result have a caret",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const lines = [
        line("user", "Question"),
        line("assistant", [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/x/brief.pdf" } }]),
        line("user", [{ type: "tool_result", tool_use_id: "r", content: "line\n".repeat(40) }]),
        line("assistant", [{ type: "tool_use", id: "w", name: "WebSearch", input: { query: "portal" } }]),
        line("assistant", [{ type: "text", text: "Answer" }]),
      ];
      const session = await unheldSession(root, harness.environment.HOME ?? "", lines);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-activity").count(), WAIT).toBe(2);
      const rows = await page.locator("#plan-panel .plan-activity").evaluateAll((nodes) =>
        nodes.map((node) => ({
          colour: getComputedStyle(node).color,
          opens: node.tagName === "DETAILS",
          text: node.textContent,
        })),
      );
      const muted = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--muted)";
        document.getElementById("plan-panel")?.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      });
      expect(rows[0]?.colour).toBe(rows[1]?.colour);
      expect(rows[0]?.opens).toBe(true);
      expect(rows[1]?.opens).toBe(false);
      expect(rows[0]?.colour).toBe(muted);
    },
    SLOW,
  );
});
