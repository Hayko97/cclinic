---
name: test-spec
description: "Acts as QA for a spec or feature: automates its test cases, runs them, explores edge cases, and reports results and defects. Use when the user asks to test, QA, verify or write automation tests for a spec or feature, or to check whether it's ready to release."
metadata:
  generated-by: luseen
  content-hash: "ba4022d5d0240471be7ee2b497f1cbd57e635909f82917e0a78922af217ca3c2"
---

# Test a spec

Work as an independent QA engineer. Your job is to find out whether the feature really works, and to report that honestly, not to get a passing result.

## Steps

1. **Read the spec.** Read `verification.md`, then `spec.md` and `validation.md`, in `.luseen/sdd/specs/<name>/`. Testing a feature with no spec? If you're running QA for the agent that implemented a change, run the project's full checks and report that no spec covers it. Otherwise, ask whether to use the `create-spec` skill first. If `.luseen/sdd` doesn't exist, stop and ask the user to run `luseen` in the project root to generate it.
2. **Learn the test setup.** Read the setup in `verification.md`, `.luseen/sdd/stack.md`, the testing section of `developer-guidelines.md`, and the existing tests. Use the project's test tools and patterns. If it has none, propose one to the user, and don't install anything without agreement.
3. **Map every test case.** Find existing tests for each `TC`, by ID and by behaviour, and list what's missing.
4. **Automate what's missing:**
   - Name each test with its ID: `TC-AUTH-001: locks the account after 5 failed logins`.
   - Use the level the test case gives: `unit`, `integration` or `e2e`.
   - Follow Given, When and Then exactly. Assert the whole of Then, including anything that must not happen.
   - Keep tests independent and repeatable: no real clocks, random values, sleeps, shared state, or calls to production services. Each test creates its own data.
   - Replace only external boundaries, such as the network, payment providers and email.
5. **Handle `manual` test cases.** Write clear steps and expected results, and run them if you can. Otherwise, mark them as not run.
6. **Run everything.** Run the new tests and the wider suite. Run new tests more than once, to catch flakiness.
7. **Explore beyond the list.** Try empty and very large values, invalid input, repeated actions, permission boundaries and failures of dependencies. If you find a behaviour the spec doesn't cover, report it, and suggest a new test case.
8. **Investigate each failure.** Decide whether the code, the test or the spec is wrong, with evidence, and say which in the defect.
9. **Report,** using the format below.

## Rules

- **Never weaken a test to make it pass:** don't loosen an assertion, skip it, retry until it passes, or change the expected result to match what the code does.
- **Don't change production code.** Report defects. If you're running QA for the agent that implemented the change, return the defects to it as bugs to fix, and don't ask the user whether to fix them. Otherwise, if the user asks you to fix one, use the `write-code` skill, as a separate step.
- **If the spec and code disagree,** report it, and don't choose. Add it to `.luseen/sdd/open-questions.md`.
- **Never claim a result you didn't see.**

## Report format

```markdown
## Summary
Ready for acceptance: yes or no. X passed, Y failed, Z not run.

## Test cases
| Test case | Result | Test | Notes |
|---|---|---|---|
| TC-AUTH-001 | Passed | `test/auth/lockout.test.ts` | |
| TC-AUTH-002 | Failed | `test/auth/lockout.test.ts` | See DEF-1 |
| TC-AUTH-003 | Not run | Manual | Needs a real email account |

## Defects
**DEF-1: Short title** (severity: high)
- Requirement: FR-AUTH-002
- Steps to reproduce: ...
- Expected: ...
- Actual: ...

## Acceptance criteria
For each VAL: met, not met, or not verified.

## Manual testing
Steps for each `manual` test case you didn't run, so the user can try it by hand.

## Gaps
Behaviour with no test case, and anything you couldn't test.
```
