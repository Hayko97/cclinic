# How development works with `cclinic`

What a coding agent does after `cclinic` setup, from your prompt to a commit.

Source of truth: the workflow in [`AGENTS.md`](AGENTS.md), the skills in [`.agents/skills/`](.agents/skills/), and the [mcp-server](.cclinic/sdd/specs/mcp-server/spec.md) spec. For the setup itself, see [SETUP_FLOW.md](SETUP_FLOW.md). For planning tasks, see [PLANNING_FLOW.md](PLANNING_FLOW.md). For runs with no human, see [AUTO_FLOW.md](AUTO_FLOW.md). For the web page, see [GUI_FLOW.md](GUI_FLOW.md).

---

## 1. The big picture

Every change goes through the same stages. You approve at each gate. The agent never moves on alone.

```mermaid
flowchart LR
    P([Prompt]) --> S0[0. Open tasks]
    S0 --> S1[1. Understand]
    S1 --> S2[2. Spec]
    S2 --> G1{You approve<br/>the spec}
    G1 --> S3[3. Implement, QA,<br/>code review, preview]
    S3 --> G2{You approve<br/>the change}
    G2 --> S4[4. Commit]
    S4 --> G3{You say yes<br/>to commit}
    G3 --> Done([Committed])
```

---

## 2. The whole flow, step by step

```mermaid
flowchart TD
    P([Your prompt]) --> T0[cclinic tasks list]
    T0 --> TQ{Open tasks, and the<br/>prompt isn't about one?}
    TQ -- yes --> TA[List them. You choose:<br/>work on one, remove it,<br/>or keep it and go on] --> Q
    TQ -- no --> Q{What kind<br/>of prompt?}
    Q -- question / review --> A([Just answer])
    Q -- planning --> PL([Talk it through.<br/>cclinic plan saves it])
    Q -- code change --> W{Which spec?}
    W -- unclear --> Ask[Ask you] --> W
    W -- found --> K{Kind of change?}

    K -- new feature,<br/>fits a spec --> RS[refine-spec]
    K -- new feature,<br/>no spec fits --> CS[create-spec]
    K -- bug --> RSB[refine-spec<br/>+ test that reproduces it]
    K -- refactor, typo,<br/>dependency --> IMP

    RS --> SA
    CS --> SA
    RSB --> SA
    SA{approve, refine<br/>or review-doc?}
    SA -- refine --> RS
    SA -- review-doc --> RD[review-doc:<br/>visual doc of the change] --> SA
    SA -- approve --> IMP[implement-spec<br/>+ write-code]

    IMP --> QA[test-spec<br/>QA in a separate agent]
    QA --> QR{All pass?}
    QR -- no, fewer than 3 runs --> FIX[Fix code or test<br/>never weaken a test] --> QA
    QR -- spec is wrong --> RS
    QR -- no, 3rd run --> STOP([Stop and report.<br/>No approval asked])
    QR -- yes --> CR[review-code<br/>in a separate agent]
    CR --> CRR{blocking or<br/>should-fix?}
    CRR -- yes, fewer than 3 reviews --> FIX2[Fix, then QA again] --> QA
    CRR -- yes, 3rd review --> STOP
    CRR -- no --> PV[Preview<br/>environment.json start]
    PV --> CA{You approve<br/>the change?}
    CA -- changes --> IMP
    CA -- yes --> CM{Commit?}
    CM -- yes --> C([Commit spec + code + tests<br/>with requirement IDs])
    CM -- no --> L([Leave uncommitted])
```

---

## 3. Stage 0 and 1: Open tasks, then understand the prompt

On every prompt, the agent first runs `cclinic tasks list --json`. If there are open tasks and your prompt isn't about one of them, it lists them and waits: work on one, remove it, or keep it and go on. It doesn't ask about the same tasks again in that conversation.

```mermaid
flowchart LR
    P([Prompt]) --> T{Type}
    T -- question --> A[Answer]
    T -- planning --> PE[product-engineer<br/>then cclinic plan]
    T -- change --> S[Find the spec<br/>in .cclinic/sdd/README.md]
    S --> Tell[Tell you<br/>which spec]
    T -- a task --> St[cclinic tasks start id<br/>use the task's spec]
```

If more than one spec fits, or none does, the agent asks you. The agent never creates roadmaps itself. `cclinic plan` does, with the PM agent.

---

## 4. Stage 2: Spec first

The agent changes the spec before any code. Each spec has 3 files.

```mermaid
flowchart LR
    SP[spec.md<br/>FR- requirements] --- VA[validation.md<br/>VAL- acceptance]
    SP --- VE[verification.md<br/>TC- test cases]
```

| Change                     | Skill         | What it does                                               |
| -------------------------- | ------------- | ---------------------------------------------------------- |
| New feature, existing area | `refine-spec` | Adds requirements to the spec                              |
| New feature, new area      | `create-spec` | Writes a new spec and adds it to the README                |
| Bug                        | `refine-spec` | Adds a test case that reproduces it, fixes the requirement |
| Refactor, typo, dependency | none          | Skip to stage 3                                            |

Then the agent shows what changed and any open questions, and **stops** until you choose:

- **`approve`**: go to stage 3.
- **`refine`**: change the spec as you ask, and offer the options again.
- **`review-doc`**: write `.cclinic/reviews/<spec>/review.md`, with diagrams and mockups of how the project will work and look after the change. Then offer `approve` or `refine`. A review doc isn't approval.

---

## 5. Stage 3: Implement, test, review, preview

```mermaid
flowchart TD
    I[Build one requirement<br/>at a time] --> T[Write tests<br/>from TC- cases]
    T --> C[Run project checks]
    C --> QA[QA agent runs test-spec<br/>max 3 runs]
    QA --> R{Result}
    R -- defect --> D{What is wrong?}
    D -- code --> I
    D -- test --> T
    D -- spec --> Back([Back to stage 2])
    R -- pass --> CR[Reviewer runs review-code<br/>max 3 reviews]
    CR --> F{Findings}
    F -- blocking / should-fix --> I
    F -- only nits, or none --> U[Mark requirements<br/>confirmed]
    U --> Rep[Report: requirements, tests,<br/>QA rounds, review findings]
    Rep --> PV[Start the preview]
    PV --> Ask{You test by hand<br/>and approve?}
```

- **QA** runs in a separate agent, so the code isn't checked by the agent that wrote it. At most 3 QA runs per change.
- **Code review** runs after QA passes, in a separate agent, with `review-code` against your coding rules and `developer-guidelines.md`. Findings are `blocking`, `should-fix` or `nit`. Blocking and should-fix ones are fixed, then QA and the review run again. Nits are only reported. At most 3 reviews.
- The counts start again only after you reply. If a 3rd QA run or review still fails, the agent stops, reports, and doesn't ask for approval.
- **Preview** runs each `start` command in `.cclinic/environment/environment.json`. If it's missing, the `local-env` skill sets it up.
- **Report** lists each requirement, the tests and their real results, the review's findings, and steps for any `manual` test case.

---

## 6. Stage 4: Commit

```mermaid
flowchart LR
    A[You approve<br/>the change] --> TD[cclinic tasks done id<br/>if it was a task]
    TD --> Q{Commit?}
    Q -- yes --> St[Stage only<br/>this change's files]
    St --> C[Commit spec + code + tests<br/>message cites FR- IDs]
    Q -- no --> N[Leave uncommitted]
```

Review docs in `.cclinic/reviews/` are left out unless you ask. The agent never pushes unless you ask.

---

## 7. The same stages, enforced: `cclinic mcp`

`AGENTS.md` is guidance, so an agent can still skip a step. Connect your coding agent to `cclinic mcp` (Claude Code reads it from `.mcp.json`), and each step becomes a tool call the server checks. A step whose gate hasn't passed is refused.

```
begin → spec ─[G1]→ implement → qa ─[G2]→ review ─[G3]→ preview ─[G4]→ approval ─[G5]→ commit ─[G6]→ done
```

| Gate               | Passes when                                    | Who answers                              |
| ------------------ | ---------------------------------------------- | ---------------------------------------- |
| G1 spec approved   | The spec's 3 files exist and you approve them  | You: `approve`, `refine` or `review-doc` |
| G2 QA passed       | The latest QA run passed, within 3 runs        | The QA agent, with `qa_report`           |
| G3 review approved | The latest review approves, after a passing QA | The reviewer, with `review_report`       |
| G4 preview tried   | `preview_start` ran for this change            | The server                               |
| G5 change approved | You approve the finished change                | You: `approve` or `request changes`      |
| G6 commit agreed   | You agree to commit                            | You: `yes` or `no`                       |

You answer a waiting gate in your agent's own prompt, with `cclinic approve` in a terminal, or with the buttons in the GUI's task panel. The state of each change is kept in `.cclinic/workflow/`.

---

## 8. Watching it in the GUI

`cclinic gui` shows the same work on its canvas ([GUI_FLOW.md](GUI_FLOW.md)):

- A task you work on in your own Claude Code session shows as **Manual**, with its workflow step and your session.
- Each time your session calls a cclinic MCP tool, a Claude Code hook (`cclinic session-link`) records the session on the change, so the GUI can show its transcript, live and read-only.
- A waiting gate shows in **Needs you** and in the task panel, where you can answer it.

---

## 9. Who does what

| Skill              | Used in | Job                                                  |
| ------------------ | ------- | ---------------------------------------------------- |
| `product-engineer` | Stage 1 | Talks through what to build. `cclinic plan` saves it |
| `create-spec`      | Stage 2 | Writes a new spec                                    |
| `refine-spec`      | Stage 2 | Updates an existing spec                             |
| `review-doc`       | Stage 2 | Writes a visual doc of the change, for you to review |
| `implement-spec`   | Stage 3 | Builds the spec, requirement by requirement          |
| `write-code`       | Stage 3 | Writes all code the project's way                    |
| `test-spec`        | Stage 3 | QA: automates and runs test cases                    |
| `review-code`      | Stage 3 | Reviews the change against your coding rules         |
| `local-env`        | Stage 3 | Sets up and starts the preview                       |

## 10. Rules to remember

- No production code before you approve the spec.
- Never weaken a test to make it pass.
- QA and the code review each run at most 3 times. Then the agent stops and reports.
- Silence isn't approval. In an unattended run, the agent stops at stage 2.
- You can tell the agent to skip a stage. It says which one it skipped.
