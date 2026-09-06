# VENT

Feedback log. Repeated/systemic workflow friction that should become future automation, docs, or workflow fixes.

## 26-09-06 03:25 — isolated-worktree test prerequisites

`npm test` and a focused Node test both failed because this isolated worktree has no `node_modules` (the build cannot find `typescript/bin/tsc`; direct tests cannot resolve `@earendil-works/pi-coding-agent`). The repeated workaround was attempting progressively narrower test commands, but neither can execute without the same dependencies. A documented/bootstrap dependency step or a pre-provisioned read-only dependency link for no-session review worktrees would make verification available without modifying the worktree.
