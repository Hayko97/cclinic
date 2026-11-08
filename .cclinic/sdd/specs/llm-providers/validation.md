# llm-providers: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-LLM-001 | FR-LLM-001 | I can run the tool with only a Claude login, only an API key, or neither, and get the right result. | With only a Claude login a full run completes; with only an API key it completes; with neither it stops with a message explaining both ways to set up. |
| VAL-LLM-002 | FR-LLM-002, FR-LLM-025 | I know which account is used and a failure never silently moves my run to another account. | The summary shows the login in use; choosing a provider that is unavailable stops with a clear message and never uses the other provider. |
| VAL-LLM-003 | FR-LLM-003, FR-LLM-004, FR-LLM-005 | Using my Claude login does not touch my files or bill my API key. | A run with both a login and an API key uses the login only, the target project is not modified by Claude, and no API charges appear. |
| VAL-LLM-004 | FR-LLM-006, FR-LLM-007, FR-LLM-010 | When Claude fails, I get a clear reason and next step, never half-finished output. | Login failures explain how to log in or use the API key; an unavailable model is named with a suggestion to run `cclinic model`; refused or cut-off answers stop the run with an error and no partial document. |
| VAL-LLM-005 | FR-LLM-008, FR-LLM-009 | The API key route gives documents as good as the Claude login route. | A full run with only an API key produces a document set comparable in quality to the CLI route for every model family. |
| VAL-LLM-006 | FR-LLM-011, FR-LLM-012, FR-LLM-015 | Short outages recover on their own and lasting problems stop clearly. | Brief rate limits or network failures recover without my action with visible retry reasons; permanent errors stop at once; badly formed answers are retried once before a clear error. |
| VAL-LLM-007 | FR-LLM-013, FR-LLM-014 | The tool never hangs and I can always cancel it. | A stalled call ends with a timeout message after the configured minutes with no leftover Claude process, and pressing Ctrl+C stops the run promptly with no leftover process. |
| VAL-LLM-008 | FR-LLM-016, FR-LLM-017, FR-LLM-018 | I can see and control cost before and during a run. | An estimate labelled as such is shown before starting; subscription users see tokens rather than dollars; a budgeted run stops near the limit and keeps finished work for the next run. |
| VAL-LLM-009 | FR-LLM-019, FR-LLM-020 | Instructions hidden in my project files do nothing and my keys are never exposed. | A project containing text telling Claude to act causes no action, and no API key or prompt text appears in output, logs, errors, cache or generated files. |
| VAL-LLM-010 | FR-LLM-021 | When I hit a usage limit I know what happened and how to continue. | The run stops with a message naming the limit and reset time if known, says re-running resumes, and a re-run processes only the unfinished work. |
| VAL-LLM-011 | FR-LLM-022 | I am told if my Claude CLI is older than the tested version. | An older or unreadable version shows a warning and the run still proceeds. |
| VAL-LLM-012 | FR-LLM-023, FR-LLM-024 | Models can be added or changed in one place and only supported models are offered. | Editing the single model constants file updates menus, errors and estimates everywhere; only Claude models are listed and accepted, and no keys are stored in that file. |
