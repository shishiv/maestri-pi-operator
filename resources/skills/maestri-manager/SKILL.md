---
name: maestri-manager
description: Create and connect agent terminals on the Maestri canvas, manage agent roles, send push notifications. Use when the user asks to assemble a team, delegate parallel work, or spin up additional agents or terminals to help, or to invoke Maestro Mode.
compatibility: Requires MAESTRI_WORKSPACE_ID and MAESTRI_SOCKET in a Maestri terminal.
user-invocable: true
---

# Maestri Team Orchestration

Before acting, verify that `MAESTRI_WORKSPACE_ID` and `MAESTRI_SOCKET` are both present without printing their values. If either is absent, stop because this skill is unavailable outside Maestri.

You're running inside Maestri, a spatial development workspace that connects AI agents, terminals, notes, and browser portals on a visual canvas.
The `maestri` CLI is a command-line executable pre-installed and available on PATH. If `maestri` is not found, use `"$MAESTRI_CLI"` instead; this environment variable always points to the full binary path.

The verbs below spawn new agent terminals on the canvas, assign them roles, and wire them together. Recruits are auto-connected to your terminal, so once a recruit exists you can `maestri ask "Name" "..."` (from the base `maestri` skill) to delegate work and `maestri check "Name"` to read their output.

## Reuse before recruiting

**Before you call `maestri recruit`, always run `maestri list` first.** If a connected teammate already has a fitting role, delegate to them with `maestri ask "Name" "..."` (from the base `maestri` skill) — do NOT spin up a new recruit for the same role. Recruits cost the user a real terminal slot and a real model session; recreating one you already have is the most common mistake in this flow.

Only recruit when:
- `maestri list` shows nobody whose role covers the task, AND
- the work genuinely needs a new persona (e.g. a reviewer-only voice when your existing teammate is the implementer).

If an existing recruit's role is *close but wrong*, prefer `maestri role edit` over recruiting a duplicate.

## When to use

- The user explicitly asked you to assemble a team or delegate to multiple agents.
- The work splits cleanly into parallel roles (implementer + reviewer, frontend + backend, scout + builder) AND `maestri list` confirms those roles aren't already on the team.
- You need a teammate with a focused role and no existing teammate has it.

Don't use this for one-off questions — `maestri ask` to an existing teammate is cheaper than spinning up a new one.

## Commands

### `maestri notify "Message for the user"`

Sends the user a system notification with a short message. Only use this command when the user explicitly asks to be notified; otherwise, assume they're already following along in Maestri.

To notify the user, you must run for example:
```
maestri notify "The release is ready for your review."
```

### `maestri recruit "Name" [--preset "Claude Code"] [--role "Reviewer"] [--floor "Experiment"] [--command "claude --resume"] [--dir "/path/to/project"]`

Spawns a new terminal on the canvas, names it, and auto-connects it to you. Returns when the terminal is created (the agent inside may still be booting — give it a few seconds before the first `ask`).

**Precondition:** run `maestri list` first. If a connected teammate already covers this role, use `maestri ask` instead — don't recruit a duplicate.

- **Name** (positional, **strongly recommended**) — pick a short codename for each teammate. The role already says what the recruit does; the name is its identity. **Invent the name yourself** — don't pull from a fixed list, and don't reuse names across teams. The codename can hint at the recruit's vibe (e.g. for a security reviewer, something watchful; for a UI designer, something visual; for a build-system specialist, something industrial) but should NOT restate the role. Vary your picks each session so two teams the user assembles don't look identical. Avoid reusing the role name (e.g. don't recruit "Frontend Developer" as `"Frontend Developer"`). The canvas appends `(2)`, `(3)`, ... if you happen to collide with an existing terminal.
- **--preset** — one of the user's quick-start presets. Run `maestri preset list` to see what's available before passing this flag. **If omitted, defaults to a copy of yourself** — same agent type the user picked for you.
- **--role** — name of an existing role preset. The recruit is launched in `.maestri/roles/<id>/` so the role's prompt becomes its starting context. Run `maestri role list` to see available roles, or `maestri role create` to add a new one before recruiting. Optional: omit when you just need a vanilla teammate and plan to set context via `maestri ask`.
- **--floor**: place the recruit on a different floor of this workspace (run `maestri floor list` from the maestri-workspace skill to see floors; `--floor "Ground"` targets the ground level). When `--dir` is omitted, a git-isolated floor uses its own clone so the recruit's work can't touch the ground checkout. Omit `--floor` to recruit onto your own floor. The rope still connects it to you across floors; `ask`, `check`, and `dismiss` work the same.
- **--command** — override the shell command. Almost never needed; use the preset.
- **--dir**: start the recruit in this working directory instead of inheriting yours. When combined with `--floor`, the explicit directory takes precedence over the floor's default checkout path. Omit it to keep the inherited behavior.

Examples:

```
maestri recruit "<your-codename>" --role "Code Reviewer"
maestri recruit "<your-codename>" --preset "Codex" --role "Test Writer"
maestri recruit "<your-codename>"                  # vanilla teammate, copy of yourself
maestri recruit "<your-codename>" --floor "Experiment" --role "Prototyper"
maestri recruit "<your-codename>" --dir "/path/to/another/project"
```

**Isolated-experiment flow:** when the user wants risky or experimental work kept out of the main checkout, create a git-isolated floor first (`maestri floor create "Experiment" --branch feat/idea`, from the maestri-workspace skill), then recruit onto it with `--floor "Experiment"`. The recruit works in the floor's isolated clone on its own branch while you and the user stay on the ground floor.

### `maestri recruit "New Name" --preset "Codex" --replace "Old Name"`

Swaps which agent runs on an existing teammate, **in place**. The terminal node survives, so its connections (notes, portals, peer ropes), canvas position, and any routines targeting it are all preserved; only the process restarts with the new agent. When the user asks to replace a teammate's agent (say, swap Claude for Codex), always use this instead of `dismiss` + `recruit`: dismissing deletes the node, and a note or portal wired only to that recruit becomes unreachable from the CLI.

- `--preset` or `--command` is required: a replace exists to boot a different agent. Prefer `--preset`; with a bare `--command`, the terminal's type and icon follow the program when it matches one of the user's presets, otherwise the terminal is labeled Custom. Maestro powers only change with an explicit `--preset`.
- The positional name renames the teammate; omit it to keep the current name.
- `--role` reassigns the role in the same swap; omit it to keep the current role.
- `--dir` changes the working directory; `--floor` is not supported because the node stays where it is.
- Chat history does not survive the restart (same as `role assign`), so brief the new agent with `maestri ask` afterwards.

```
maestri recruit "Codex" --preset "Codex" --replace "Claude"
maestri recruit --preset "opencode" --replace "Scout"     # keeps the name "Scout"
```

### `maestri dismiss "Name"`

Stops the recruit's process and removes its terminal from the canvas. You can only dismiss agents you're currently connected to.

**Careful:** dismissing deletes the node, and any note or portal wired only to that recruit is orphaned. Nothing in the CLI can reconnect it afterwards; only the user can, by dragging a rope in the app. To swap a teammate's agent, use `maestri recruit --replace` instead.

```
maestri dismiss "Reviewer"
```

### `maestri connect "From" "To"`

Wires two things together. Each side can be a recruit (agent name), a sticky note, or a portal. Without this, recruits can only talk back to you. Both endpoints must be inside your team tree: yourself, a direct recruit, or any note/portal that you or a direct recruit is wired to (exactly what `maestri list` shows you). Note and portal ropes live on a single floor, so those pairs must share a floor; only agent-to-agent connections span floors. A portal can only be wired to an agent (so the agent can drive it via `maestri portal ...`); notes don't connect to portals, and two portals share a session only by linking them on the canvas.

```
maestri connect "Reviewer" "Tester"          # agent ↔ agent — they can `maestri ask` each other
maestri connect "design-spec" "Reviewer"     # note ↔ agent — share a context note with a recruit
maestri connect "design-spec" "scratch-pad"  # note ↔ note — chain notes so each one can read the other
maestri connect "Tester" "Staging Portal"    # agent ↔ portal — let the agent drive that portal
```

Connecting two recruits alone isn't enough — recruits won't know to use the new connection unless their role says so. Bake the collaboration into each peer's role prompt: name the other recruit and instruct it to use `maestri ask "Peer Name" "..."` at the relevant points (e.g. "When you finish a draft, run `maestri ask \"Reviewer\" \"please review\"` and incorporate their feedback"). For shared notes, mention the note name in the recruit's role so it knows to read it. For a connected portal, name it and tell the recruit to drive it with `maestri portal ...` (e.g. "Use the `Staging Portal` to verify the page renders — `maestri portal snapshot \"Staging Portal\"`").

### `maestri preset list`

Lists the agent presets the user has configured (e.g. `Claude Code`, `Codex`, `Shell`, plus any custom presets). Run this before `maestri recruit ... --preset "..."` so you pass a name that actually exists.

### `maestri role list`

Lists the role presets visible from your workspace, grouped into "Current workspace" roles (scoped to the workspace you're in) and "Global" roles (visible everywhere).

### `maestri role create "Name" "Prompt" [--scope current|global]`

Adds a new role preset the user (and you) can assign to recruits. The prompt is the system instruction the recruit sees as `<your_assigned_role>`. Be specific — name + prompt should leave no doubt about the recruit's scope.

New roles are **scoped to your current workspace by default**, since most roles reference one project's context. Make the judgment call: if the role is genuinely reusable across projects (e.g. a generic "Code Reviewer"), pass `--scope global`; if it names files, branches, or conventions of this project, keep the default.

Bake collaboration discoverability into the prompt:

- **Tell the recruit to run `maestri list` before asking anyone anything.** Recruits don't see the team graph automatically — without this nudge they'll either work in isolation or invent peers that don't exist. A single line like "Run `maestri list` to see your connected teammates and any shared notes before delegating or asking questions." is enough.
- If the recruit has a *specific* peer to talk to, also name that peer explicitly: e.g. "When you finish a draft, run `maestri ask \"Reviewer\" \"please review\"` and incorporate their feedback." Specific instructions beat the generic `list` hint when the collaboration pattern is fixed.
- If a shared note is part of the workflow, name it: e.g. "Read `design-spec` before starting and write progress to `scratch-pad`."
- If the recruit owns a portal (you wired one to it, or it created its own), name it and point at the `maestri portal` commands: e.g. "You have the `Staging Portal` — drive it with `maestri portal snapshot/click/fill` to verify the UI."

```
maestri role create "API Specialist" "You own the payments API in this repo. Keep endpoints consistent with docs/api-conventions.md. Run `maestri list` to see your teammates and shared notes."
maestri role create "Code Reviewer" "Review code for correctness, style, and safety. Never edit files — only respond with findings. Run `maestri list` to see who else is on the team and any shared notes you should read." --scope global
```

### `maestri role show "Name"`

Prints a role's full prompt. `maestri role list` only shows a truncated preview.

### `maestri role edit "Name" "old text" "new text" [--scope current|global]`

Replaces a substring inside a role's prompt. `--scope` rescopes the role — `current` limits it to the workspace you're in, `global` makes it visible everywhere — and also works on its own when you only want to change the scope:

```
maestri role edit "Code Reviewer" --scope global
```

You can only scope roles to your own workspace, never to a different one.

### `maestri role write "Name" "full new prompt"`

Replaces a role's prompt entirely.

### `maestri role assign "Recruit Name" "Role Name"`  (or `--none` to clear)

Retargets an existing recruit to a different role *without* dismissing it. The recruit's name, canvas position, and every connection (notes, peer ropes) are preserved; only the agent process restarts so it picks up the new role files. Use this instead of `dismiss` + `recruit` when you just need to swap the role on an existing teammate. To swap the agent program itself (say, Claude to Codex), use `maestri recruit --replace` the same way.

```
maestri role assign "Anvil" "Product Manager"     # swap roles
maestri role assign "Anvil" --none                # clear role, recruit goes back to vanilla
```

Chat history is lost in the restart (same as `role edit`), but the topology survives.

## Workflow

1. **Take stock first** — `maestri list`. If a connected teammate already has a fitting role, skip straight to step 5 and delegate to them. Do not recruit a second copy of someone you already have.
2. **Plan the gaps** — only after step 1, decide which roles are genuinely missing.
3. **Define roles** — `maestri role list` to see what already exists, `maestri role create` to fill gaps.
4. **Recruit** each missing teammate with a distinctive codename and `--role` so each boots into the right mindset and reads as its own character on the canvas. Don't reuse the role name as the recruit name.
5. **Optional** — `maestri connect` recruits to each other when they need to collaborate without you in the middle.
6. **Delegate** with `maestri ask "Name" "task..."` (from the base `maestri` skill). To kick off several teammates at once, use `maestri ask --batch '{"Name A": "task...", "Name B": "task..."}'` — it fires the prompts in parallel and returns once every teammate finishes, so independent work runs concurrently instead of one after another.

Use `maestri list` at any point to see your current team and their roles. As a Maestro you also see each teammate's own connections (agents, portals, notes) nested beneath it, so you know exactly what a recruit is wired to before a `--replace` or a rewire. That tree is also your reach: a teammate's notes and portals resolve by name for you, so you can `note read` a recruit's note or drive its portal directly instead of relaying through `ask`.
