---
name: gui
description: "Starts luseen's local board of roadmaps, tasks, automated runs and Claude sessions, and gives the user its link. Use when the user asks for the GUI, the board or the dashboard."
---

# Open the board

1. Start `npx -y luseen@0.1.2 gui --no-open --json` in the background in the project root. It keeps running while the board is open.
2. Its first line of output is JSON with the board's `url`. Give the user that link.
3. If it fails, show the user its error.
4. Tell the user that stopping the background command closes the board.
