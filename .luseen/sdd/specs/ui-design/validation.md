# ui-design: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-DSGN-001 | FR-DSGN-001, FR-DSGN-002, FR-DSGN-022 | Any coding agent can do design work in my project | After setup, the `ui-design` skill is available to my agent and in the plugin, and it never commits or pushes |
| VAL-DSGN-002 | FR-DSGN-003, FR-DSGN-024 | I'm not bothered about design on a project without screens | A command-line tool or library gets no design questions and no design files |
| VAL-DSGN-003 | FR-DSGN-004, FR-DSGN-005, FR-DSGN-017 | The design fits my product and current practice | The design system builds on my existing look, and names the sources it researched, with nothing private in its searches |
| VAL-DSGN-004 | FR-DSGN-006 | I choose the direction | I'm asked a few clear questions, shown 2 or 3 directions with a recommendation, and my choice is used |
| VAL-DSGN-005 | FR-DSGN-007 | An unattended run doesn't decide for me | A design made without me is marked as a draft, with its assumptions listed for me to check |
| VAL-DSGN-006 | FR-DSGN-008, FR-DSGN-009, FR-DSGN-010 | The design system is complete and usable by tools | One document explains every part, and the tokens file opens in standard design-token tools |
| VAL-DSGN-007 | FR-DSGN-011, FR-DSGN-013 | My product has a full, consistent visual language | Colors, type, spacing, shape and motion are all defined, in light and dark, and motion calms down when I ask my device to reduce it |
| VAL-DSGN-008 | FR-DSGN-012, FR-DSGN-014 | Everyone can read and use my product | Every text and control color meets WCAG 2.2 AA, with the ratios listed, and controls are big enough to tap |
| VAL-DSGN-009 | FR-DSGN-014, FR-DSGN-015 | Developers build screens without guessing | Each component's states and keyboard use, and each page's layout on phone and desktop, are written down |
| VAL-DSGN-010 | FR-DSGN-016, FR-DSGN-018 | I can see the design before approving it | I open one page in my browser, see every color, font and component in light and dark, and approve or ask for changes |
| VAL-DSGN-011 | FR-DSGN-019, FR-DSGN-021 | My code changes only with my agreement | The design system is approved before UI is built on it, tokens reach my code through the normal reviewed lifecycle, and no new framework is added without asking |
| VAL-DSGN-012 | FR-DSGN-020, FR-DSGN-037 | My UI stays consistent | New screens use the tokens and components, and the code review flags hard-coded styles, missing states and low contrast |
| VAL-DSGN-013 | FR-DSGN-023, FR-DSGN-025 | Nothing runs on my project without my agreement | Setup tells me what will happen and asks first. Scripts and CI don't start it unless they ask for it, and I can turn it off |
| VAL-DSGN-014 | FR-DSGN-026, FR-DSGN-027 | I can create the design system later, with or without the Claude CLI | One command creates it on any project, and without the Claude CLI I get a sentence to give my own agent |
| VAL-DSGN-015 | FR-DSGN-028, FR-DSGN-029, FR-DSGN-031 | This step can't get out of hand | It can only write design files, can't run commands or read my secrets, stops at a clear time and cost limit, and tells me about any other file that changed |
| VAL-DSGN-016 | FR-DSGN-030, FR-DSGN-032 | I know what happened, and don't lose my design | I see the design files' paths or a clear failure, a failure doesn't lose my documents, and recreating it keeps the old design until the new one is valid |
| VAL-DSGN-017 | FR-DSGN-033, FR-DSGN-034 | Design work stays cheap and under my control | Changing the design doesn't reprocess anything, and nothing is committed without me |
| VAL-DSGN-018 | FR-DSGN-035 | Design comes first in my roadmap | A new roadmap for a product with screens starts with the design system, and UI tasks wait for it |
| VAL-DSGN-019 | FR-DSGN-036 | My agent knows when to design | Design requests and UI changes use the design skill, and I approve the design system as part of the spec |
| VAL-DSGN-021 | FR-DSGN-040, FR-DSGN-042 | A failed or interrupted first try doesn't get in my way | After a failed first run, or with only system files such as `.DS_Store` in the design folder, the next run creates the design system without needing `--force` |
| VAL-DSGN-022 | FR-DSGN-041 | I'm not shown an error when there's simply no UI | When Claude finds no screens to design for, I'm told the project has no user interface, and the command succeeds |
| VAL-DSGN-020 | FR-DSGN-038, FR-DSGN-039 | I can hand design work to a specialist agent | Claude Code offers a `designer` agent, from the plugin or from my project, and my own edits to it are kept |
| VAL-DSGN-023 | FR-DSGN-043, FR-DSGN-044 | A new project with screens gets a design system during setup | After I approve the brief, a design system is made and approved during setup without another question or click |
