# git-setup: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-GIT-001 | FR-GIT-001, FR-GIT-002, FR-GIT-003 | Know my Git situation before anything changes. | The summary, dry run and doctor tell me whether Git, a repository and a remote exist and what cclinic will do, and nothing is created; a missing repo or remote does not make doctor say cclinic is not ready. |
| VAL-GIT-002 | FR-GIT-004, FR-GIT-005, FR-GIT-006, FR-GIT-007, FR-GIT-024 | Get a local repository safely without surprises. | A project without a repository gets one only after I agree, with nothing staged or committed, no nested repository inside an existing one, and a declined run leaves the project untouched; I am advised about a .gitignore but none is created. |
| VAL-GIT-003 | FR-GIT-011 | Opt out of Git handling. | With --no-git, cclinic does not create a repository, read history or show a remote alert. |
| VAL-GIT-004 | FR-GIT-008, FR-GIT-009, FR-GIT-010 | Be reminded to back up my work remotely. | With no remote I see steps for GitHub, GitLab or Bitbucket, the run still succeeds, nothing is created or pushed, and no tokens from remote URLs are shown. |
| VAL-GIT-005 | FR-GIT-012, FR-GIT-013, FR-GIT-014, FR-GIT-015 | Have recent work reflected in the specs without leaking private data. | In a project with recent commits the specs reflect recent work, while diffs, author names and emails, secret paths and cclinic's own output never reach Claude, and very large histories are trimmed with a warning. |
| VAL-GIT-006 | FR-GIT-016, FR-GIT-017 | Trust that requirements reflect the actual project. | A commit describing something the code does not do does not become a confirmed requirement and is raised as an open question; no requirement cites a commit. |
| VAL-GIT-007 | FR-GIT-018, FR-GIT-019 | Stable, cheap re-runs. | Re-running on an unchanged project makes no Claude calls and leaves documents identical; committing cclinic's own output changes nothing; a new relevant commit refreshes the combined results; no commit counts or dates appear in documents. |
| VAL-GIT-008 | FR-GIT-020, FR-GIT-021, FR-GIT-022, FR-GIT-023 | Git problems never block or endanger me. | Broken, unsafe, shallow or missing Git only produces warnings and the run succeeds; a malicious repository setting cannot run programs; Git ownership safety is not bypassed. |
