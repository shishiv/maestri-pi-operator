---
name: maestri
description: Send messages to connected AI agents on the Maestri canvas and get their responses. Also read and write connected sticky notes. Use when the user's intent is to collaborate with another agent on the canvas. Look for actions like 'ask [name] to...', 'tell [name] to...', 'check on [name]', or 'create/update a note'.
compatibility: Requires MAESTRI_WORKSPACE_ID and MAESTRI_SOCKET in a Maestri terminal.
user-invocable: true
---

# Maestri Inter-Agent Communication

Before acting, verify that `MAESTRI_WORKSPACE_ID` and `MAESTRI_SOCKET` are both present without printing their values. If either is absent, stop because this skill is unavailable outside Maestri.

You're running inside Maestri, a spatial development workspace that connects AI agents, terminals, notes, and browser portals on a visual canvas.
The `maestri` CLI is a command-line executable pre-installed and available on PATH. If `maestri` is not found, use `"$MAESTRI_CLI"` instead; this environment variable always points to the full binary path.

Connected agents can exchange prompts and responses through the `maestri` CLI.
Connected notes can be read and written through the `maestri` CLI.

## Commands

- `maestri list` — list connected agents, notes, and portals
- `maestri ask "Agent Name" "your prompt"` — send a prompt to a connected agent and get the response
- `maestri ask --batch '{"Agent A": "prompt", "Agent B": "prompt"}'` — ask several connected agents at once, in parallel
- `maestri ask "Agent Name" --raw "2\n"` — send raw input; use it for interactive menus or to send raw shell commands directly. Escapes: `\n` Enter, `\t` Tab, `\e` ESC, `\xNN` byte (`\x03` Ctrl-C). Special keys are ESC sequences, e.g. `\e[A` up arrow, `\e[Z` Shift-Tab.
- `maestri check "Agent Name"` — read the agent's current terminal output on demand
- `maestri note create ["content"] [--name "Name"] [--stack ["Fichário"]]` — create a new note on the canvas and link it to this terminal; `--name` pins a stable name that never changes with content. The response prints the exact assigned name
- `maestri note read "Note Name"` — read the full note with line numbers
- `maestri note read "Note Name" 10 20` — read 20 lines starting from line 10
- `maestri note write "Note Name" "content"` — replace a note's content entirely
- `maestri note edit "Note Name" "old text" "new text"` — replace a substring within a note
- `maestri note stack "Note Name" ["Fichário"]` — file (or move) an existing note into a fichário; `maestri note unstack "Note Name"` frees it
- `maestri note delete "Note Name"` — remove a connected note from the canvas. **Destructive. Only run when the user explicitly asks you to delete the note.** Never delete a note on your own initiative, even to tidy up.

If any maestri command fails (connection or pipe errors), run `maestri debug` FIRST — it reports the exact cause (elevation mismatch, stale pipe, missing env) before you start guessing.
Always run `maestri list` first to get the exact agent and note names.
The response from `ask` returns as soon as the other agent finishes. Scale the Bash tool timeout to the estimated completion time, usually from 1min (easy) to 10min (most tasks). If you expect the response to exceed one terminal screen (e.g. code review, planning, debugging), use the ask back approach detailed below.
If the timeout expires before the agent responds, do NOT re-send the prompt. Run `maestri check "Agent Name"` to see their progress, then wait again with an appropriate timeout. Never interrupt an agent that is still working, and do not edit files that the other agent is actively modifying — wait for them to finish first.
The ask back approach: Tell the agent to report back with `maestri ask "Your Name" "<result>"` when done (your name is under `You:` in `maestri list`). This way their message resolves your waiting `ask` automatically and arrives in full as a new incoming prompt.
Use `check` to read what an agent is currently showing without sending a prompt — useful to check if a previous request completed or to see its current state. Be careful not to misread unsent text in their TUI input area as instructions to you.

## Asking several agents at once

`maestri ask --batch '{"Agent A": "prompt for A", "Agent B": "prompt for B"}'` sends a prompt to multiple connected agents **in parallel** and returns only once every one has finished. The input is a JSON map of agent name → prompt; targets must be distinct (a JSON object can't repeat a key). The result is a JSON array of `{name, output}` objects (plus `{name, error}` for any agent that couldn't be reached) — match each reply by its `name`. Set the Bash tool timeout to fit the **slowest** task in the batch, since the command waits for all of them.

Run `maestri help` to see all available commands, and `maestri <command> --help` (e.g. `maestri recruit --help`) for one command's flags and detail. Never guess a flag. If the user is having connection or setup issues, run `maestri debug` to diagnose the problem.

## Connected Notes

Use `maestri note create` to create a new note on the canvas — it appears to the left of your terminal and is automatically connected. Optional initial content can be provided. Pass `--name "My Note"` to give it a stable name; the response always prints the exact name that was assigned, so use that name in subsequent commands.
`--stack "Name"` and `note stack` file notes into a fichário (a stack of pages), creating it if needed — `maestri list` shows the grouping.
Use `maestri note read` to read, `maestri note write` to replace entirely, and `maestri note edit` to update a specific part.
When a note already has content, prefer `edit` over `write` to avoid losing existing text.
Notes marked `locked: true` by `maestri list` are read-only. You can still read them, but `write` and `edit` will fail until the user unlocks the note in Maestri.
Changes are reflected in the Maestri canvas in real-time. Notes support markdown formatting.
Notes can be chained together. When a note connected to your terminal is also connected to other notes, you can read and write all notes in the chain. Use `maestri list` to see the full note tree — chained notes appear indented under their parent.

**Important:** By default, a note's name is derived from its first line of text. When you write or edit a note and change its first line, the note may be renamed automatically — the command's response tells you the new name when that happens. Notes created with `--name`, or renamed by the user, keep their name regardless of content changes. Prefer `maestri note create --name "..."` when you plan to address the note again later.
