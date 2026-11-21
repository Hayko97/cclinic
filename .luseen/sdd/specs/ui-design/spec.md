# ui-design

## Goal

Give every project with a user interface a researched, accessible design system, and make coding agents build UI with it. A `ui-design` skill acts as the project's UI/UX designer and UI developer: it researches best practices, talks the look through with the user, and writes the design system (principles, color, typography, spacing, components and page templates) to `.luseen/design/`, with a visual style guide to review. It's used when a project is set up, when the PM plans a roadmap, on the first UI task, and whenever the user asks for design work. Every later UI change follows the design system, and the code review checks it. The Claude Code plugin and `luseen skills` also ship a `designer` agent with the skill's instructions.

```
.luseen/design/
├── design-system.md        principles, foundations, components, templates, decisions, open questions
├── design.tokens.json      tokens in the Design Tokens Format Module 2025.10 (DTCG)
└── style-guide.html        one self-contained page showing the tokens and components, light and dark
```

## Requirements

### The skill

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-DSGN-001 | luseen must provide a `ui-design` skill, installed in `.agents/skills` and `.claude/skills` like the others, protected from overwriting like the others, listed in the `AGENTS.md` skills table, and shipped in the Claude Code plugin's `skills/`. | confirmed | `src/core/agent-skills.ts` `AGENT_SKILLS`, `user request 2026-11-17` |
| FR-DSGN-002 | The skill must work with any coding agent, name no agent's tools, and prohibit committing and pushing. | confirmed | `user request 2026-11-17` |
| FR-DSGN-003 | When the project has no user interface (no web, mobile or desktop screens), the skill must say that no design system is needed and stop, without creating files. | confirmed | `user request 2026-11-17` |
| FR-DSGN-004 | Before proposing a design, the skill must read `.luseen/sdd/overview.md`, `stack.md` and the specs relevant to the request, plus the project's existing UI: style sheets, theme files, design-token files, component folders, and logo or brand assets. If `.luseen/sdd` doesn't exist, it must ask the user to run `luseen`. | confirmed | `user request 2026-11-17` |
| FR-DSGN-005 | The skill must research current best practices on the web for the product's platforms, users and domain (such as design systems of similar products, platform guidelines and accessibility guidance), name the pages it used in `design-system.md`, and never put secrets, file contents or private project details in a search query or URL. When it has no web access, it must say so and use the practices this skill states. | confirmed | `user request 2026-11-17`, `.luseen/sdd/specs/roadmap-planning/spec.md` |
| FR-DSGN-006 | When someone can answer, the skill must ask about brand, audience, tone, platforms, light and dark themes, and any existing brand colors or fonts, at most 3 questions per message, skipping what the project already answers. It must then present 2 or 3 visual directions, each with a palette, type pairing and one-line mood, and recommend one. | confirmed | `user request 2026-11-17` |
| FR-DSGN-007 | When nobody can answer (such as the `luseen` setup step), the skill must derive the design from the existing UI and the documents, ask nothing, record each assumption in the open questions of `design-system.md`, and set its status to `draft`. | confirmed | `user request 2026-11-17` |
| FR-DSGN-008 | The skill must write `.luseen/design/design-system.md` with these sections in order: Status (`draft` or `approved`), Principles, Color, Typography, Spacing and layout, Shape and elevation, Motion, Accessibility, Components, Templates, Decisions, Sources, Open questions. | confirmed | `user request 2026-11-17` |
| FR-DSGN-009 | The skill must write every token to `.luseen/design/design.tokens.json` in the Design Tokens Format Module 2025.10: each token has `$value` and `$type` (set on it or on a parent group), and references use the `{group.token}` form. | confirmed | https://www.designtokens.org/tr/2025.10/, `user request 2026-11-17` |
| FR-DSGN-010 | Tokens must have three tiers: primitive tokens (raw values, such as `color.blue.600`), semantic tokens named by role (such as `color.text.default`, `color.surface.raised`, `color.action.primary.background`), and component tokens. Semantic tokens must reference primitives, and component tokens must reference semantic tokens, never raw values. | confirmed | `user request 2026-11-17`, https://uiux-atlas.pages.dev/lessons/design-systems/token-naming-conventions-and-tier-architecture |
| FR-DSGN-011 | The color foundation must have a neutral scale, a primary brand scale, and success, warning, danger and info scales, each with at least 9 steps, and semantic tokens for text, surfaces, borders, actions, focus and each status. It must define a light theme and a dark theme by mapping the same semantic tokens to different primitives, unless the user chooses one theme. | confirmed | `user request 2026-11-17` |
| FR-DSGN-012 | Each semantic text or icon color must be paired with the backgrounds it's used on, and each pair's contrast ratio, computed with the WCAG 2.2 formula, must be listed in `design-system.md` for every theme. Normal text must reach 4.5:1, and large text (24 px, or 18.66 px bold), icons, input borders and focus indicators must reach 3:1. The skill must change any token whose pair falls short. | confirmed | https://www.w3.org/TR/WCAG22/#contrast-minimum, https://www.w3.org/TR/WCAG22/#non-text-contrast, `user request 2026-11-17` |
| FR-DSGN-013 | The foundations must define: font families with system fallbacks; a type scale from a stated ratio with size, line height and weight for each role (display, headings, body, small, label, code); spacing on a 4 px base; breakpoints; corner radii; elevation; and motion durations and easings, with motion reduced to opacity changes or none when the user prefers reduced motion. | confirmed | `user request 2026-11-17` |
| FR-DSGN-014 | For each component the product needs, at least button, text field, select, checkbox, radio, switch, link, card, dialog, toast, navigation, tabs, table or list, badge, empty state and loading indicator, `design-system.md` must give its anatomy, variants, sizes, the component tokens it uses, its states (default, hover, focus-visible, active, disabled, and where they apply loading, error, selected), and its keyboard behaviour and accessible role. Interactive targets must be at least 24 by 24 CSS pixels, and 44 by 44 on touch screens. | confirmed | https://www.w3.org/TR/WCAG22/#target-size-minimum, `user request 2026-11-17` |
| FR-DSGN-015 | `design-system.md` must hold page templates for the screens the product needs, from: app shell, list, detail, form, dashboard, settings, sign-in, and empty and error pages. Each must show its layout as a Markdown or ASCII mockup at mobile and desktop widths, the components it uses, and its behaviour from 320 px wide upward. | confirmed | `user request 2026-11-17` |
| FR-DSGN-016 | The skill must write `.luseen/design/style-guide.html`, one self-contained page that loads nothing from the network and shows every color with its token name, the contrast pairs with their ratios, the type scale, spacing, radii, elevation, and each component in each state, with a switch between the light and dark themes. Its styles must be generated from `design.tokens.json`. | confirmed | `user request 2026-11-17` |
| FR-DSGN-017 | When the project already has a design system, theme or component library, the skill must document it and extend it rather than replace it. Any change to the existing look must be listed in `design-system.md` and approved by the user before it's built. | confirmed | `user request 2026-11-17` |
| FR-DSGN-018 | After writing the design system, the skill must give the user the paths to `design-system.md` and `style-guide.html`, summarise the direction and any contrast fixes, and offer `approve` or `refine`, stopping until the user chooses. On `approve`, it must set the status to `approved`. On `refine`, it must change what the user asks and offer the options again. | confirmed | `user request 2026-11-17` |
| FR-DSGN-019 | The skill must change `.luseen/design/` only. Putting the tokens into the project's code (such as CSS custom properties, a Tailwind theme, or a React Native, Flutter or SwiftUI theme file, generated from `design.tokens.json` and using the styling the project already has) must go through the project's lifecycle as a code change, with the `write-code` skill. A new styling framework or component library must not be added without the user's agreement. | confirmed | `user request 2026-11-17` |
| FR-DSGN-020 | When building or changing UI, the skill must tell the agent to read `design-system.md` and `design.tokens.json` first; use only tokens, never raw colors, sizes or durations, in UI code; reuse existing components before making new ones; add a new token or component to the design system first and tell the user; build every state the component spec lists; and check the screen at 320 px and desktop widths, by keyboard, and in each theme. | confirmed | `user request 2026-11-17` |
| FR-DSGN-021 | When a UI change is requested and `.luseen/design/design-system.md` doesn't exist, the skill must create the design system first, and the user must approve it before UI code for that change is written. | confirmed | `user request 2026-11-17` |
| FR-DSGN-022 | The skill must stay under 500 lines and follow the Agent Skills format (agent-skills FR-SKILL-002). | confirmed | `.luseen/sdd/specs/agent-skills/spec.md` FR-SKILL-002 |

### Setup step

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-DSGN-023 | After the local environment step of a generation run (local-environment FR-ENV-003), in an interactive terminal, when skills were installed and `.luseen/design/design-system.md` doesn't exist, luseen must say that Claude will research the web and write the design system to `.luseen/design/`, then ask whether to continue, defaulting to yes. | confirmed | `src/cli/environment-step.ts` `setUpAfterGenerate`, `user request 2026-11-17` |
| FR-DSGN-024 | luseen must not ask, and must report that the project has no UI, when a valid environment file lists only `cli` or `library` parts. | confirmed | `src/core/constants/environment.ts` `ENVIRONMENT_PART_TYPES`, `user request 2026-11-17` |
| FR-DSGN-025 | With `--yes`, `--json`, `--quiet` or no interactive terminal, a run must not start Claude for the design system unless `--design` is set. `--no-design`, `--no-skills` and `--dry-run` must skip the step without asking, and combining `--design` with `--no-design` or `--no-skills` must exit with code 2. | confirmed | `src/cli/main.ts`, `user request 2026-11-17` |
| FR-DSGN-026 | `luseen design [path]` must install the skills and run this step, whether or not documents exist, and must accept `--yes`, `--force`, `--json`, `--model`, `--effort`, `--max-budget-usd`, `--out` and `--allow-broad-target`. | confirmed | `src/cli/main.ts`, `user request 2026-11-17` |
| FR-DSGN-027 | If the Claude CLI isn't installed and logged in, or the provider is the API, luseen must start nothing, print one sentence the user can give any coding agent to create the design system with the `ui-design` skill, and exit with code 0. | confirmed | `src/core/environment.ts`, `user request 2026-11-17` |
| FR-DSGN-028 | Claude must run in the target folder with the selected model and reasoning level, with `ANTHROPIC_API_KEY` removed, in `--safe-mode`, using the built-in skill text and told that nobody can answer (FR-DSGN-007), with allowed tools from a constant list: `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, and `Write` and `Edit` limited to `.luseen/design/`. It must have no shell, and reading `.env` and other secret files must be denied as in local-environment FR-ENV-008. | confirmed | `src/core/constants/environment.ts` `ENVIRONMENT_AGENT_ALLOWED_TOOLS`, `user request 2026-11-17` |
| FR-DSGN-029 | The step must stop at 15 minutes, and at `--max-budget-usd` or else 2 USD, both defaults being constants, and Ctrl+C must stop Claude. | confirmed | `src/core/constants/environment.ts`, `user request 2026-11-17` |
| FR-DSGN-030 | After the step, luseen must check that `design-system.md` has the sections of FR-DSGN-008, that `design.tokens.json` is valid JSON in which every token has a `$value` and a `$type` and every reference points to an existing token, and that `style-guide.html` exists, then show the paths. `luseen design` must exit 4 if Claude fails or a limit is reached, and 5 if a file is missing or invalid. In a generation run both must be warnings that don't change the exit code. | confirmed | `src/cli/environment-step.ts`, `user request 2026-11-17` |
| FR-DSGN-031 | luseen must warn about every file changed outside `.luseen/design/` during the step, skipping Git and dependency folders. | confirmed | `src/core/environment.ts`, `user request 2026-11-17` |
| FR-DSGN-032 | If a valid design system exists, luseen must not ask or start Claude and must show its paths and status, and `luseen design --force` must create it again, keeping the old files as `.luseen/design/previous/` until the new ones pass the checks of FR-DSGN-030, and restoring them if they don't. | confirmed | `user request 2026-11-17` |
| FR-DSGN-033 | Creating or changing `.luseen/design/` must not invalidate the analysis cache, change the generated documents, or count as a hand edit. | confirmed | `src/core/constants/discovery.ts` `TOOL_FOLDERS`, `user request 2026-11-17` |
| FR-DSGN-034 | luseen must not commit design files, and an agent must commit them only when the user agrees. | confirmed | `user request 2026-11-17` |
| FR-DSGN-040 | When the step starts with no design system and fails (Claude fails, a limit is reached, or the result doesn't pass FR-DSGN-030), luseen must remove what the step wrote in `.luseen/design/`, so the next run starts as if none existed. The exit codes of FR-DSGN-030 still apply. | confirmed | code review 2026-11-18, `src/cli/design-step.ts` |
| FR-DSGN-041 | When Claude finishes the step without writing anything in `.luseen/design/`, luseen must report that the project has no user interface, as the skill decides in FR-DSGN-003, show Claude's final message, and exit 0, in `luseen design` and in a generation run. | confirmed | code review 2026-11-18, `src/core/design.ts` `hasUserInterface` |
| FR-DSGN-042 | Files whose names start with `.`, such as `.DS_Store`, and empty folders in `.luseen/design/` must not count as design files: a folder holding only those counts as having no design system. | confirmed | QA DEF-12, `src/adapters/storage/design-store.ts` `readDesignSystem` |
| FR-DSGN-043 | In a new-project session's `design` phase (roadmap-planning FR-PLAN-054), luseen must run this step without asking for consent, since the user started the setup and the approved brief says the project has screens. It must otherwise work as FR-DSGN-027 to FR-DSGN-031, FR-DSGN-040 and FR-DSGN-041, and leave the design system as a `draft`, which the session then approves through FR-DSGN-044 without asking the user (roadmap-planning FR-PLAN-054). | confirmed | `user request 2026-11-20` |
| FR-DSGN-044 | luseen must offer a way to approve a draft design system without an agent, used by the GUI (gui FR-GUI-089) and the terminal new-project session. It must change only the Status section of `design-system.md` from `draft` to `approved`, and must refuse, changing nothing, when the files don't pass the checks of FR-DSGN-030. | confirmed | `user request 2026-11-20` |

### Planning, workflow, review and agent

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-DSGN-035 | When the product-engineer skill plans a new roadmap for a product with a user interface and `.luseen/design/design-system.md` doesn't exist or is a `draft`, it must propose a task to create or approve the design system with the `ui-design` skill in the first milestone, and make each task that builds UI depend on it. | confirmed | `src/core/agent-skills.ts` product-engineer, `user request 2026-11-17` |
| FR-DSGN-036 | The `AGENTS.md` workflow must tell agents, at stage 1, to use the `ui-design` skill for design requests (a design system, a new screen, a redesign or a visual polish), and to use it with `write-code` for every change that touches UI. When no approved design system exists, creating it must be part of stage 2, and its approval must be given before stage 3. | confirmed | `src/core/agent-skills.ts` `AGENT_WORKFLOW`, `user request 2026-11-17` |
| FR-DSGN-037 | When a change touches UI and `.luseen/design/design.tokens.json` exists, the `review-code` skill must report as `should-fix` each raw color, font size, spacing, radius, shadow or duration in UI code that a token covers, each component state the design system lists but the change leaves out, and each text or control color pair below FR-DSGN-012's ratios. | confirmed | `src/core/agent-skills.ts` review-code, `.luseen/sdd/specs/code-review/spec.md`, `user request 2026-11-17` |
| FR-DSGN-038 | The Claude Code plugin must ship `plugins/luseen/agents/designer.md`, defining the agent `designer` with the `ui-design` skill's instructions and a description saying to use it for design systems, UI/UX design and building UI, with `tools` set to `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`, `WebSearch` and `WebFetch`. It must follow the project's `AGENTS.md` lifecycle for code changes. | confirmed | `src/core/claude-plugin.ts` `renderPmAgent`, `plugins/luseen/agents/pm.md`, `user request 2026-11-17` |
| FR-DSGN-039 | Without `--plugin`, `luseen` and `luseen skills` must install the same agent file at `.claude/agents/designer.md`, marked and protected like the skills: a foreign or edited file is left alone and reported. With `--plugin`, it must not be installed. | confirmed | `src/adapters/storage/skill-installer.ts`, `user request 2026-11-17` |

## Decisions

| Decision | Reason |
|---|---|
| One skill for UI/UX design and UI development | The user asked for one UI/UX/dev role, and the design system only helps if the code follows it |
| Files in `.luseen/design/` | The scan already skips `.luseen/`, so design work doesn't cause re-analysis, and the setup step can be limited to one folder |
| Tokens in the DTCG 2025.10 format | It's the first stable, tool-neutral token format (released 2025-10-28), so Style Dictionary, Figma plugins and others can read it |
| Three token tiers | Themes change only the semantic-to-primitive map, and components never hold raw values, so the look can change in one place |
| WCAG 2.2 AA ratios, listed per pair | Contrast is checked when tokens are chosen, not after screens are built, and the list makes it reviewable |
| Setup writes only design files; code tokens go through the lifecycle | Setup runs without anyone to approve code, and putting tokens into code is a code change like any other |
| The setup step runs after the environment step | The environment file says whether the project has screens (FR-DSGN-024), so command-line projects aren't asked |
| A self-contained style guide | The user reviews the look in a browser without starting the project, and it works offline |

## Changes to other specs

These specs are refined with this one:

- [agent-skills](../agent-skills/spec.md): ten skills, adding `ui-design` (FR-SKILL-001).
- [claude-plugin](../claude-plugin/spec.md): the plugin holds the ten skills (FR-PLUG-008) and the `designer` agent (FR-DSGN-038).
- [agent-instructions](../agent-instructions/spec.md): the workflow names the `ui-design` skill (FR-DSGN-036).
- [code-review](../code-review/spec.md): UI changes are checked against the design system (FR-DSGN-037).
- [roadmap-planning](../roadmap-planning/spec.md): the PM proposes a design-system task first (FR-DSGN-035).
- [cli-commands](../cli-commands/spec.md): the `design` command and the `--design` and `--no-design` options (FR-DSGN-025, FR-DSGN-026).

## Limits

- Taste can't be tested automatically. The tests check structure, tokens, contrast and the rules the skill states; whether the design looks good is judged by the user from the style guide.
- Workflow and skill rules are guidance, so an agent can still fail to follow them. The code review (FR-DSGN-037) catches raw values it can see.
- Web research during setup reads pages the user hasn't seen. Their content is treated as information, not instructions.

## Edge cases

- The project is a command-line tool or library: setup doesn't ask, and the skill says no design system is needed.
- No environment file exists when setup reaches this step: luseen asks, and the skill decides whether there's a UI. If it finds none, it writes nothing, and luseen reports no UI with exit 0 (FR-DSGN-041).
- The first run fails halfway: its partial files are removed, so the next run doesn't mistake them for hand edits (FR-DSGN-040).
- The project already uses a component library such as MUI or shadcn/ui: the skill documents its theme as the design system and extends it.
- The user has brand colors that fail contrast: the skill keeps the brand color for large or decorative use, adds an accessible shade for text and controls, and says why.
- The user wants only a dark theme, or only a light one: the skill defines that theme alone, and says so in Decisions.
- Several apps share one repository: one design system covers them, and the skill asks whether any app needs its own theme.
- `design.tokens.json` is edited by hand into invalid JSON: `luseen design` reports it and exits 5; `--force` creates it again.
- A UI task starts while the design system is a `draft`: the agent asks the user to approve it first.
- No web access: the skill says so and uses the practices it states.

## Non-goals

- Drawing in Figma or other design tools, or syncing with them.
- Generating logos, illustrations or icon sets.
- Choosing or licensing paid fonts; the skill uses fonts the project already has, system fonts or open-licensed fonts.
- Changing the project's UI code during the setup step.
- Visual regression testing of the project's screens.
- Starting agents other than the Claude CLI during setup.
