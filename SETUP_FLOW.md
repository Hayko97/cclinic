# How `cclinic` setup works

A simple picture of what happens when you run `cclinic` on a project.

Source of truth: the specs in [`.cclinic/sdd/specs/`](.cclinic/sdd/specs/) and the code in [`src/cli/generate-command.ts`](src/cli/generate-command.ts).

---

## 1. The big picture

You point `cclinic` at a project. It reads the code and documents, asks Claude to describe the project, and writes specs and agent instructions back into the project.

```mermaid
flowchart LR
    A[Your project] --> B[cclinic]
    B -->|reads code + docs| C[Claude]
    C -->|summaries + specs| B
    B --> D[.cclinic/sdd/<br/>specs and docs]
    B --> E[.agents/skills/<br/>.claude/skills/]
    B --> F[AGENTS.md<br/>CLAUDE.md]
    B --> G[.cclinic/environment/<br/>local preview]
```

---

## 2. The setup flow, step by step

```mermaid
flowchart TD
    Start([cclinic path]) --> T{Is the path a<br/>project folder?}
    T -- no --> X2[Exit 2]
    T -- yes --> M[Pick model + effort]
    M --> P{Find Claude}
    P -- none --> X3[Exit 3]
    P -- found --> G[Check Git<br/>read-only]
    G --> S[Scan files<br/>skip deps, build output,<br/>binaries, secrets]
    S --> L{Any files?<br/>Within limits?}
    L -- no --> X2b[Exit 2]
    L -- yes --> R[Read files,<br/>redact secrets,<br/>split into chunks]
    R --> E[Estimate tokens + cost]
    E --> D{--dry-run?}
    D -- yes --> DR([Print summary.<br/>Nothing sent or written])
    D -- no --> C{You confirm?<br/>or --yes}
    C -- no --> X0([Exit 0.<br/>Nothing sent])
    C -- yes --> LK[Take lock<br/>.cclinic/.lock]
    LK --> GI[git init<br/>only if no repo]
    GI --> AI[Ask Claude:<br/>summarise, combine,<br/>generate specs]
    AI --> V{Specs valid?}
    V -- no --> X5[Save draft to .cclinic/failed<br/>Exit 5]
    V -- yes --> W[Write .cclinic/sdd]
    W --> SK[Install skills +<br/>AGENTS.md / CLAUDE.md]
    SK --> ENV[Optional:<br/>set up local environment]
    ENV --> Done([Done. Exit 0])
```

| Step        | What happens                                                                     | Spec                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Check path  | Must be a folder. Home folder or `/` is refused unless `--allow-broad-target`.   | [cli-commands](.cclinic/sdd/specs/cli-commands/spec.md)                                                                      |
| Pick model  | Option → env var → saved default → built-in (Sonnet, medium).                    | [model-selection](.cclinic/sdd/specs/model-selection/spec.md)                                                                |
| Find Claude | Claude CLI if logged in, else `ANTHROPIC_API_KEY`, else exit 3.                  | [llm-providers](.cclinic/sdd/specs/llm-providers/spec.md)                                                                    |
| Check Git   | Only looks. Never commits, stages or pushes.                                     | [git-setup](.cclinic/sdd/specs/git-setup/spec.md)                                                                            |
| Scan        | Finds the project's own files. Every skipped file gets a reason.                 | [file-discovery](.cclinic/sdd/specs/file-discovery/spec.md)                                                                  |
| Read        | Text from code, PDF, DOCX with line/page positions.                              | [content-extraction](.cclinic/sdd/specs/content-extraction/spec.md)                                                          |
| Confirm     | Shows a summary, then asks. No terminal and no `--yes` → exit 2.                 | [cli-commands](.cclinic/sdd/specs/cli-commands/spec.md)                                                                      |
| Ask Claude  | The 3 LLM stages, below.                                                         | [spec-analysis](.cclinic/sdd/specs/spec-analysis/spec.md)                                                                    |
| Write       | Validate first, then write all at once.                                          | [spec-output](.cclinic/sdd/specs/spec-output/spec.md)                                                                        |
| Skills      | Six skills + workflow sections. No LLM.                                          | [agent-skills](.cclinic/sdd/specs/agent-skills/spec.md), [agent-instructions](.cclinic/sdd/specs/agent-instructions/spec.md) |
| Environment | Claude sets up `environment.json` with the `local-env` skill, only if you agree. | [local-environment](.cclinic/sdd/specs/local-environment/spec.md)                                                            |

---

## 3. What Claude does (the 3 LLM stages)

```mermaid
flowchart LR
    subgraph Stage1[1. Summarise]
        C1[chunk] --> S1[module summary]
        C2[chunk] --> S2[module summary]
        C3[chunk] --> S3[module summary]
    end
    subgraph Stage2[2. Combine]
        S1 & S2 & S3 --> P[project-wide data:<br/>overview, stack,<br/>architecture, spec list]
    end
    subgraph Stage3[3. Generate]
        P --> SP1[spec A]
        P --> SP2[spec B]
    end
    H[(Git history<br/>last 14 days)] -.-> P
    H -.-> SP1
    Cache[(.cclinic/cache)] -.->|skip work<br/>already done| Stage1
```

- **Summarise** runs in parallel (`--concurrency`, default 4). Each chunk is at most 150,000 tokens.
- **Combine** merges in stages if the summaries are too big for one request.
- **Generate** writes requirements (`FR-`), acceptance checks (`VAL-`) and test cases (`TC-`) for each spec.
- Results are cached, so re-running the same command continues where it stopped.

---

## 4. What ends up in your project

```mermaid
flowchart TD
    Root[your-project/]
    Root --> A[AGENTS.md<br/>workflow + skills table]
    Root --> B[CLAUDE.md<br/>imports @AGENTS.md]
    Root --> Ag[.agents/skills/*/SKILL.md]
    Root --> Cl[.claude/skills/*/SKILL.md]
    Root --> CC[.cclinic/]
    CC --> SDD[sdd/]
    SDD --> R[README.md, overview.md,<br/>stack.md, architecture.md,<br/>developer-guidelines.md,<br/>open-questions.md, scan-report.md,<br/>manifest.json]
    SDD --> SPECS[specs/name/<br/>spec.md · validation.md · verification.md]
    CC --> Env[environment/environment.json]
    CC --> Cache[cache/ · failed/ · .lock<br/>temporary]
```

`cclinic clean` deletes only `cache/` and `failed/`. It never touches `sdd/`.

---

## 5. After setup: how an agent works

`AGENTS.md` tells coding agents to follow this loop for every change.

```mermaid
flowchart LR
    U[Prompt] --> S[Refine spec]
    S --> A1{You approve<br/>the spec?}
    A1 -- no --> S
    A1 -- yes --> I[Implement]
    I --> Q[QA<br/>max 3 runs]
    Q --> PV[Preview<br/>environment.json]
    PV --> A2{You approve<br/>the code?}
    A2 -- no --> I
    A2 -- yes --> CM[Commit<br/>if you agree]
```

---

## 6. Other commands

| Command               | Does                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `cclinic --dry-run`   | Shows what would be scanned and the cost. Sends and writes nothing. |
| `cclinic skills`      | Installs only the skills and `AGENTS.md`/`CLAUDE.md`. No LLM.       |
| `cclinic environment` | Sets up only the local environment.                                 |
| `cclinic model`       | Lists, chooses or resets the saved default model.                   |
| `cclinic doctor`      | Checks that everything is ready. Never calls a model.               |
| `cclinic clean`       | Deletes the cache and failed drafts.                                |
| `cclinic guide`       | Offline walkthrough.                                                |

## 7. Exit codes

| Code      | Meaning                                     |
| --------- | ------------------------------------------- |
| 0         | Success, or you declined                    |
| 1         | Internal error                              |
| 2         | Usage error (bad path, limits, no terminal) |
| 3         | No Claude provider                          |
| 4         | LLM failure or budget hit                   |
| 5         | Generated specs failed validation           |
| 130 / 143 | Stopped with Ctrl+C / SIGTERM               |
