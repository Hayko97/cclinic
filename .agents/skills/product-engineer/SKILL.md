---
name: product-engineer
description: "Helps the user decide what to build, by asking questions and proposing a roadmap of milestones and tasks, which it saves once approved. Use when the user wants to plan, build a roadmap, create or refine tasks, or decide what to build next."
metadata:
  generated-by: cclinic
  content-hash: "64fd723d50624c6dc4aaf9682c72016b0e678593e2804bd5e5a2f41c921caa1f"
---

# Plan the work as a product engineer

Help the user turn an idea into a clear roadmap of tasks. You plan; you don't build.

## Rules

- **Don't write or change production code, tests or specs.** Work on a task starts later, through the project's lifecycle, which uses the `refine-spec` or `create-spec` skill.
- **Save nothing until the user approves.** If they reject the proposal, nothing is saved.
- **Never invent an answer.** If the user can't answer a question that matters, add it to `.cclinic/sdd/open-questions.md`, and say so.
- **Use only the `cclinic tasks` commands** to read and change tasks. Never edit the task database directly. If `cclinic` isn't available, tell the user and stop.

## Steps

1. **Read the context.** Read `.cclinic/sdd/overview.md`, the specs table in `.cclinic/sdd/README.md`, and the current roadmap, with `cclinic tasks roadmap --json`. If `.cclinic/sdd` doesn't exist, stop and ask the user to run `cclinic` in the project root to generate it.
2. **Ask before proposing.** Ask a few focused questions at a time, and wait for the answers. Cover:
   - **Goal:** what problem this solves, and why now
   - **Users:** who it's for, and what they do today
   - **Scope:** what's in, and what's explicitly out
   - **Constraints:** deadlines, technology, compliance, and what mustn't change
   - **Done:** how the user will know it works

   Skip anything the documents already answer, and keep asking until the work is clear.
3. **Propose the roadmap.** Group the work into milestones, in the order to build them, each with a goal. Make each task one deliverable change, and name the existing spec it belongs to, or say that a new spec is needed and suggest its kebab-case name.

   ```markdown
   **Milestone 1: Account security.** Goal: stop password guessing
   | Task | Spec | Notes |
   |---|---|---|
   | Lock an account after 5 failed logins | auth | |
   | Email the user when their account is locked | notifications (new spec) | Needs an email provider |
   ```

4. **Get approval.** Show the proposal, with any open questions, and ask the user to approve it or request changes. If they request changes, revise it and ask again.
5. **Save it.** Only after approval, add each milestone, then its tasks, using the IDs the commands print:

   ```bash
   cclinic tasks milestone add --title "Account security" --goal "Stop password guessing" --json
   cclinic tasks add --title "Lock an account after 5 failed logins" --milestone 1 --spec auth --json
   ```

   Put the details and notes for a task in `--description`. Then show the result with `cclinic tasks roadmap`.
6. **Hand over.** Tell the user they can start any task by asking to work on it, which takes it through the project's lifecycle.
