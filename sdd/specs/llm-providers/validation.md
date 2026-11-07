# LLM providers: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-LLM-001 | FR-LLM-001, FR-LLM-005, FR-LLM-006, FR-LLM-007, FR-LLM-008 | It works with my existing Claude login | With only a Claude CLI login and no API key, a full run completes without extra setup |
| VAL-LLM-002 | FR-LLM-001, FR-LLM-010, FR-LLM-011, FR-LLM-012, FR-LLM-013, FR-LLM-014, FR-LLM-015 | I can use an API key instead | With only `ANTHROPIC_API_KEY` set, a full run completes, and the documents are comparable in quality to the CLI's |
| VAL-LLM-003 | FR-LLM-001, FR-LLM-002 | If nothing's set up, I know what to do | With no login and no key, the message explains both ways to set up |
| VAL-LLM-004 | FR-LLM-002, FR-LLM-003, FR-LLM-009 | I'm never billed on an account I didn't expect | The summary shows which login is in use, and a failure never moves the run to another account |
| VAL-LLM-005 | FR-LLM-016, FR-LLM-017, FR-LLM-018 | Temporary problems don't waste my run | Brief rate limits or network failures recover on their own, and lasting failures stop with a clear message rather than hanging |
| VAL-LLM-006 | FR-LLM-019, FR-LLM-020, FR-LLM-021, FR-LLM-022 | I stay in control of cost | I see an estimate before starting, and a run with a budget stops at about that limit, with its finished work kept for next time |
| VAL-LLM-007 | FR-LLM-023, FR-LLM-024, FR-LLM-025 | A malicious file can't take over the tool | Text in a project file telling Claude to do something results in no actions, and my keys never appear in any output |
| VAL-LLM-008 | FR-LLM-004 | Providers behave the same | Switching provider changes nothing else about how the tool works |
| VAL-LLM-009 | FR-LLM-026 | Reaching my usage limit doesn't waste my work | If I hit a limit partway through, I'm told what happened and when I can continue, and re-running picks up where it stopped |
| VAL-LLM-010 | FR-LLM-027 | I'm warned about an old Claude CLI | If my Claude CLI is older than the tested version, I'm told before a run might fail in a confusing way |
| VAL-LLM-011 | FR-LLM-028 | The Claude CLI uses my login, not a stray key | With a login and a key in my shell, a run uses my login and doesn't bill the key |
| VAL-LLM-012 | FR-LLM-029 | Retries don't look like a hang | When Claude is retrying, I can see that and why |
| VAL-LLM-013 | FR-LLM-030, FR-LLM-031 | Login and model problems tell me what to do | A login failure or unavailable model gives me a clear next step |
| VAL-LLM-014 | FR-LLM-032, FR-LLM-033, FR-LLM-035, FR-LLM-036 | Updating models is simple and safe | A developer can add or change a model by editing one constants file, and it then appears correctly everywhere, with no keys stored in it |
| VAL-LLM-015 | FR-LLM-034 | I only see models I can use | Menus and valid values list only Claude models until Codex is really supported |
