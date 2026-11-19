---
name: review-doc
description: "Writes a simple, visual review doc for a spec change, with diagrams, screenshots and mockups of how the project will work and look after it. Use when the user chooses review-doc while reviewing a spec, or asks to see what a spec change will look like before approving it."
---

# Write a review doc for a spec change

Help the user decide whether to approve a spec change, by showing in one simple doc how the project will work and look after it. You explain the change; you don't build it.

## Rules

- **Don't change production code, tests or the spec's files.** Write only in `.luseen/reviews/<spec-name>/`.
- **Never present a mockup as real.** Caption every image of the behaviour after the change with "Mockup, not built yet".
- **Never invent behaviour.** Show only what the spec says. If the spec doesn't say, list it under open questions.
- **Keep it simple.** Short sentences, small diagrams, and one idea per image.

## Steps

1. **Read the change.** Read the spec's `spec.md`, `validation.md` and `verification.md` in `.luseen/sdd/specs/<spec-name>/`, and the spec's uncommitted changes, such as its diff against the last commit. Then read the code that the changed requirements touch. If `.luseen/sdd` doesn't exist, stop and ask the user to run `luseen` in the project root to generate it.
2. **Start fresh.** If `.luseen/reviews/<spec-name>/` already exists, delete it, so the doc and its images are replaced, not added to.
3. **Capture today.** If `.luseen/environment/environment.json` exists, run its `start` commands, and take screenshots of the screens or output the change affects, if you can capture them. Save them as `images/before-<n>.png`. If the environment can't start, or you can't take screenshots, say why in the doc, and carry on.
4. **Draw the change.** Make mockups of how it will look after the change, as SVG files in `images/after-<n>.svg`: a simple screen for a user interface, or terminal output for a command-line tool. If nothing is visible, show example input and output instead, or say that there's nothing to see.
5. **Write `.luseen/reviews/<spec-name>/review.md`,** with these sections, in this order:
   1. **Summary:** what changes and why, in a few plain sentences
   2. **What changes in the spec:** each added, changed or removed requirement, with its ID, in a table
   3. **How it works now and after:** at least one Mermaid diagram of the behaviour after the change, such as a flowchart or a sequence diagram, and one of today's behaviour where it helps to compare
   4. **How it looks:** the screenshots of today and the mockups of after, side by side where you can, each with a caption
   5. **How it will be tested:** each changed requirement, with the test cases that will prove it
   6. **Open questions and risks:** anything unclear, and what could break

   Link images with relative paths, such as `![Mockup, not built yet: the new menu](images/after-1.svg)`.
6. **Check it.** Every changed requirement appears, every Mermaid block is valid, every image link works, and every after image says it's a mockup.
7. **Ask for review, and stop.** Give the user the doc's path, and ask them to review it and choose:
   - **`approve`:** the spec is ready to implement.
   - **`refine`:** refine the spec with the changes they ask for, and review it again.

   A review doc isn't approval, so don't implement anything until the user chooses `approve`.
