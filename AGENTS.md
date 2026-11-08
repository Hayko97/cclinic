<!-- cclinic:start -->
## How to work in this project

This project uses spec-driven development. Specs are in `.cclinic/sdd/specs/`, and `.cclinic/sdd/README.md` lists them.

Analyse every prompt, and follow this lifecycle:

**1. Understand the prompt.** If it's a question, an explanation or a review with no change requested, just answer. If it's a code change, work out which spec it belongs to, and tell the user. If it could be more than one, or none clearly fits, ask.

**2. Refine the spec, and get it approved.**
- **New feature:** use the `refine-spec` skill if it belongs in an existing spec, or the `create-spec` skill if not.
- **Bug or issue:** use `refine-spec`. Add a test case that reproduces it, and correct any requirement that's wrong or missing.
- **No behaviour change**, such as a refactor, formatting, a typo or a dependency update: no spec update is needed. Go to stage 3.

Show what changed in `spec.md`, `validation.md` and `verification.md`, and any open questions. Ask the user to approve or reject it, and stop. Don't change production code until they clearly approve. If they reject it or ask for changes, refine the spec and ask again.

**3. Implement, and get it approved.** Use the `implement-spec` skill, with the `write-code` skill for all code. If the spec turns out to be wrong, go back to stage 2. Then, in this order:
1. Report each requirement, the tests you ran and their real results.
2. **Show a preview. Don't ask for approval until you've done this.** Run each `start` command in `.cclinic/environment/environment.json`, so the local environment includes this change, leave it running, and check it. A server you start yourself doesn't count. If the file doesn't exist, set it up with the `devops` skill. Give the user the link, simulator build or command to try. If there's nothing to run, or it can't start, say why.
3. Ask the user to approve the implementation or request changes. If they request changes, make them and ask again.

**4. Ask to commit.** Once the user approves the implementation, ask whether to commit it. Only if they agree, commit the spec, code and tests for this change together, following the project's commit conventions and referencing the requirement IDs. Stage only files that belong to this change. Don't push unless asked. If they decline, leave the changes uncommitted.

If the user tells you to skip a stage, do as they ask, and say which stage was skipped. If `.cclinic/sdd` doesn't exist, ask the user to run `cclinic` first. If nobody can answer, as in an unattended run, stop at stage 2 and report the spec, because silence isn't approval.

### Documents and skills

Follow `.cclinic/sdd/developer-guidelines.md` for all code.

Skills are in `.agents/skills/<name>/SKILL.md`. If your tool doesn't load skills automatically, read the matching file and follow it:

| Skill | Purpose |
|---|---|
| `create-spec` | Writes a new spec for a feature or capability, with requirements, acceptance criteria and test cases |
| `refine-spec` | Improves an existing spec: fixes vague or untestable requirements, fills coverage gaps, updates it to match the code, and resolves open questions |
| `write-code` | Writes or changes code the way a careful maintainer of this project would: following its stack, architecture and conventions, in small changes without unnecessary comments or abstractions |
| `implement-spec` | Builds a spec requirement by requirement, with tests from its test cases, and reports proof that each one works |
| `test-spec` | Acts as QA for a spec or feature: automates its test cases, runs them, explores edge cases, and reports results and defects |
| `devops` | Sets up a local environment suited to the project, and shows how to review each change, such as a link or a simulator build |

This section is managed by cclinic, so keep your own notes outside the markers.
<!-- cclinic:end -->
