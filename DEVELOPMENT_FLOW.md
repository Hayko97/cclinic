# How development works with `cclinic`

What a coding agent does after `cclinic` setup, from your prompt to a commit.

Source of truth: the workflow in [`AGENTS.md`](AGENTS.md) and the skills in [`.agents/skills/`](.agents/skills/). For the setup itself, see [SETUP_FLOW.md](SETUP_FLOW.md).

---

## 1. The big picture

Every change goes through 4 stages. You approve at each gate. The agent never moves on alone.

```mermaid
flowchart LR
    P([Prompt]) --> S1[1. Understand]
    S1 --> S2[2. Spec]
    S2 --> G1{You approve<br/>the spec}
    G1 --> S3[3. Implement + QA<br/>+ preview]
    S3 --> G2{You approve<br/>the code}
    G2 --> S4[4. Commit]
    S4 --> G3{You say yes<br/>to commit}
    G3 --> Done([Committed])
```

---

## 2. The whole flow, step by step

```mermaid
flowchart TD
    P([Your prompt]) --> Q{What kind<br/>of prompt?}
    Q -- question / review --> A([Just answer])
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
    SA{You approve<br/>the spec?}
    SA -- changes --> RS
    SA -- yes --> IMP[implement-spec<br/>+ write-code]

    IMP --> QA[test-spec<br/>QA in a separate agent]
    QA --> QR{All pass?}
    QR -- no, fewer than 3 runs --> FIX[Fix code or test<br/>never weaken a test] --> QA
    QR -- spec is wrong --> RS
    QR -- no, 3rd run --> STOP([Stop and report.<br/>No approval asked])
    QR -- yes --> PV[Preview<br/>environment.json start]
    PV --> CA{You approve<br/>the code?}
    CA -- changes --> IMP
    CA -- yes --> CM{Commit?}
    CM -- yes --> C([Commit spec + code + tests<br/>with requirement IDs])
    CM -- no --> L([Leave uncommitted])
```

---

## 3. Stage 1: Understand the prompt

```mermaid
flowchart LR
    P([Prompt]) --> T{Type}
    T -- question --> A[Answer]
    T -- change --> S[Find the spec<br/>in .cclinic/sdd/README.md]
    S --> Tell[Tell you<br/>which spec]
```

If more than one spec fits, or none does, the agent asks you.

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

Then the agent shows what changed and any open questions, and **stops** until you approve.

---

## 5. Stage 3: Implement, test, preview

```mermaid
flowchart TD
    I[Build one requirement<br/>at a time] --> T[Write tests<br/>from TC- cases]
    T --> C[Run project checks]
    C --> QA[QA agent runs test-spec]
    QA --> R{Result}
    R -- defect --> D{What is wrong?}
    D -- code --> I
    D -- test --> T
    D -- spec --> Back([Back to stage 2])
    R -- pass --> U[Mark requirements<br/>confirmed]
    U --> PV[Start preview]
    PV --> Rep[Report + manual test steps]
    Rep --> Ask{You approve?}
```

- **QA** runs in a separate agent, so the code isn't checked by the agent that wrote it.
- **At most 3 QA runs** per change. After a failed 3rd run, the agent stops and reports.
- **Preview** runs each `start` command in `.cclinic/environment/environment.json`. If it's missing, the `devops` skill sets it up.
- **Report** lists each requirement, the tests and their real results, and steps for any `manual` test case.

---

## 6. Stage 4: Commit

```mermaid
flowchart LR
    A[You approve<br/>the code] --> Q{Commit?}
    Q -- yes --> St[Stage only<br/>this change's files]
    St --> C[Commit spec + code + tests<br/>message cites FR- IDs]
    Q -- no --> N[Leave uncommitted]
```

The agent never pushes unless you ask.

---

## 7. Who does what

| Skill            | Used in | Job                                         |
| ---------------- | ------- | ------------------------------------------- |
| `create-spec`    | Stage 2 | Writes a new spec                           |
| `refine-spec`    | Stage 2 | Updates an existing spec                    |
| `implement-spec` | Stage 3 | Builds the spec, requirement by requirement |
| `write-code`     | Stage 3 | Writes all code the project's way           |
| `test-spec`      | Stage 3 | QA: automates and runs test cases           |
| `devops`         | Stage 3 | Sets up and starts the preview              |

## 8. Rules to remember

- No production code before you approve the spec.
- Never weaken a test to make it pass.
- Silence isn't approval. In an unattended run, the agent stops at stage 2.
- You can tell the agent to skip a stage. It says which one it skipped.
