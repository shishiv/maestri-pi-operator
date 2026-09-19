# Maestri for Pi

[![npm](https://img.shields.io/npm/v/maestri-pi-operator?logo=npm)](https://www.npmjs.com/package/maestri-pi-operator)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
![Linux](https://img.shields.io/badge/platform-Linux-444444?logo=linux&logoColor=white)

**Your Maestri canvas, available through native Pi tools.**

Talk to connected agents, keep shared notes, inspect browser pages and control
Android portals without leaving Pi. The package provides **14 typed tools**, one
`/maestri-operator` command, durable async replies and screenshots returned as
images. The extension exposes none of those tools or the command unless both
`MAESTRI_WORKSPACE_ID` and `MAESTRI_SOCKET` are present.

Maestri owns the canvas, connections, permissions and terminal lifecycle.
This extension supplies transport. It does not ship planning skills, playbooks,
role bootstraps or automatic team setup.

[Install](#install) · [Try it](#try-it) · [Tools](#tools) · [Known limits](#known-limits) · [Development](#development)

## Install

Requires **Linux**, **Node.js 24+**, and **Pi running in a Maestri terminal**.
For OMP, use the unreleased compatibility instructions below.

Before upgrading from the JSON-file lock protocol, drain or stop every old
Pi/runner that can write to the store. Mixed-version writers are unsupported;
an absent lock file does not prove quiescence. Existing legacy lock markers
cause a refusal and are never removed automatically. Preserve receipts and
captures when resolving legacy artifacts after the coordinated stop. See
[the lock upgrade decision](docs/adr/0003-atualizacao-dos-locks-com-quiescencia.md).

```sh
pi install npm:maestri-pi-operator
```

After that prerequisite, run `/reload` in an existing Pi session. To pin this release:

```sh
pi install npm:maestri-pi-operator@0.4.0
```

The package may stay installed globally. Outside a Maestri terminal it registers
no tools, hooks or command, so it adds nothing to the agent prompt.

`/maestri-operator` requires Maestri context. It injects concise operating
guidance for an optional task; it does not replace the 14 native transport tools.
Legacy global copies of the six skills belong to their installer and remain
outside this package's control. Migrating or deleting those copies is an
app/installer change, not an install or removal performed by this package.

Android control additionally requires an Android SDK and an available emulator
or a phone authorized for USB debugging. The extension does not install or
configure them.

### OMP compatibility (unreleased)

This checkout includes fixes for **OMP 18.2.6** that are **not present in the
published npm 0.4.0**. Do not use that published version for OMP async requests.
OMP accepts the same `pi.extensions` manifest, but loading the package alone
does not verify its internal validators or notification lifecycle.

To evaluate this checkout without changing OMP's installed plugins:

```sh
npm ci
npm run build
omp --no-extensions -e /absolute/path/to/maestri-pi-operator/dist/index.js
```

Run OMP inside a Maestri terminal, with Node.js available on `PATH` for the
separate async runner. TypeBox is a required peer (`^1.3.7`); the locked
development install provides it for this command.

OMP can host the tools, but an async **destination must still be an idle,
supported Pi**. OMP as a destination is not certified by these host checks.
A live round trip passed with the corrected local tarball: an OMP 18.2.6 RPC
caller sent one async request through Maestri to Pi 0.85.1, received the native
follow-up and read the result once, leaving its receipt acknowledged. Both
agents used Azure GPT-6 Astra. Revalidate when changing host versions or your
Maestri setup; this does not certify OMP as a destination or portal journeys.

> **Historical validation evidence:** a review for Maestri 0.16.0 recorded
> transport tests and model-backed smoke passing, and real web DOM, forms, click,
> PNG capture and navigation verified. Screenshot fidelity and a real Android
> device journey remained unverified. This history does not certify later
> contract changes; final verification evidence is maintained separately.

## Try it

Use the command when you want Pi to take a Maestri task with the package's
operating guidance:

```text
/maestri-operator Ask Reviewer to inspect the diff without interrupting work.
```

With no task, `/maestri-operator` queues guidance for the next user turn and
does not start an operation.

Start with discovery:

```text
List the Maestri agents, notes and portals connected to this terminal.
```

Then use the exact names Pi finds. These are example requests, not resources
created by the package:

| What you want | Ask Pi |
| --- | --- |
| Check on an agent | "Show what Reviewer is doing without sending a message." |
| Delegate without waiting | "Ask Reviewer to inspect the diff. Let me keep working while it replies." |
| Keep a shared note | "Create a connected note named Decisions with the text: Keep the API small." |
| Inspect a web page | "Inspect Preview at 390 × 844, then take a screenshot. Leave the portal open." |
| Discover Android devices | "List available Android devices. Don't open one yet." |

## Tools

| Capability | Native Pi tools |
| --- | --- |
| Discover and inspect | `maestri_list`, `maestri_check` |
| Send a prompt and wait | `maestri_ask` |
| Send once and collect later | `maestri_ask_async`, `maestri_ask_request` |
| Read and create roles | `maestri_role_list`, `maestri_role_show`, `maestri_role_create` |
| Read and manage notes | `maestri_note_read`, `maestri_note_create`, `maestri_note_edit`, `maestri_note_stack` |
| Control a browser portal | `maestri_portal` |
| Control an Android portal | `maestri_portal_device` |

Role tools require **Maestro Mode** and create roles in the current workspace.
They do not assign roles, edit existing prompts or restart agents.

Notes support line-range reads, stable names, substring edits and filing into
a fichário. Maestri enforces connection reach and content locks. Text remains
literal, including backslashes and Markdown.

### Async replies

```text
Send once → keep the request ID → continue working → receive a notice → read the result
```

Use a stable `client_request_id`. The same key, agent and prompt return the
original request; a changed payload is rejected. Pending results never expose
partial replies.

When a request finishes, the Pi or OMP caller receives an `mpo.ask-terminal` follow-up with the
next action. Reading `result` is the Pi acknowledgement. A restart may
reannounce an unacknowledged result once. Firstmate acknowledgement is a
separate external concern.

Notices wait until the caller is idle, even when `agent_end` arrives while it
is still busy. A synchronous notice-send failure stays pending until another
`agent_end` or a new session; file changes and idle checks never authorize a
retry by themselves. This does not resend the underlying request.

- The destination must be an idle, supported Pi, with no other active async ask.
- Requests are private to the Maestri workspace and calling terminal.
- Idempotency lasts only while the receipt is retained. Retention eligibility
  considers seven days and the newest 200 terminal requests, with the smaller
  resulting set prevailing. Cleanup occurs opportunistically during activity:
  there is no hard deletion deadline or minimum retention guarantee, and this
  does not authorize a resend when a result is pending or delivery is unknown.
- Structured receipts store only the prompt digest and byte count. The private
  terminal capture can contain rendered prompt and reply text until retention
  removes it; do not use async asks for secrets.
- New prompts are limited to 65,536 UTF-8 bytes after CLI encoding; async prompts
  also include the reply envelope. Existing receipts remain recoverable by their
  original key even if the new wire limit would reject a new send.
- Timeout, cancellation or unknown delivery **never authorizes an automatic resend**.

Readiness detection currently recognizes GPT-5.6 Luna, Terra and Sol footers,
plus GPT-6 Astra, `gpt-6-astra`, and the specifically captured `claude-opus-5`
footer layout. This is a fixed allowlist: adding another model requires a
captured footer and an explicit code/test update. One trailing status line is supported only
with a recognized, empty composer and directory/footer layout. Drafts and
ambiguous layouts are refused; terminal text is not an authenticated readiness API.
See the
[architecture](docs/architecture.md) for process custody and restart behavior.

### Browser and Android portals

**Browser:** navigate, inspect accessibility and HTML, fill forms, send keys,
scroll, drag, run JavaScript, read console logs and test viewport sizes.

**Android:** discover devices, open portals, inspect the screen, tap, type,
swipe, press hardware buttons, launch or stop apps and open deep links.

Use `snapshot` to get element refs. Browser selectors accept refs, CSS or
coordinates. Android accepts refs or coordinates, **not CSS**. Refresh the
snapshot after the page or screen changes.

Screenshots arrive as PNG images with their native dimensions preserved.
They are **not redacted or resized**. Only local native screenshot files are
loaded, without following symlinks, up to 10 MiB and 25 megapixels.

> `close` deletes the portal's canvas node. Use it only on an explicit user
> request. The extension never closes a portal as automatic cleanup.

## Safety and recovery

Each direct call executes a fixed CLI command with argument arrays, not a shell.
Text output is redacted, marked untrusted and capped at **2,000 lines or 50 KiB**.
Raw command capture is capped at 1 MiB; image bytes have separate limits.

| Operation | Timeout |
| --- | --- |
| Ordinary CLI calls and web portals | 15 seconds |
| Android portal operations | 90 seconds |
| Agent asks | 10 minutes |

Cancellation terminates the local Linux process group and discards partial
output. It does **not** prove that an action already delivered to Maestri was
cancelled. Inspect the current resource before deciding on another interaction.

Terminal async results include `reason`, `termination` and `exit_code`.
Recognized runner startup errors are reported as bounded codes, not raw stderr.
These diagnostics do not turn unknown delivery into permission to resend.

The extension uses an executable `MAESTRI_CLI`, falling back to `maestri` on
`PATH`. Maestri context requires `MAESTRI_WORKSPACE_ID` and `MAESTRI_SOCKET`;
async asks also need `MAESTRI_TERMINAL_ID`. The waiter and Firstmate adapter
require both `MAESTRI_WORKSPACE_ID` and `MAESTRI_TERMINAL_ID`; missing either
scope value is an error. Credential values are never needed in chat.

## Known limits

The following limits and evidence requirements were recorded for **Maestri 0.16.0**;
later contract changes require separate final verification:

| Limit | What it means |
| --- | --- |
| Successful capture is not visual approval | Live runs have both returned PNGs and timed out in the renderer; one returned capture was reported black. Click state changed successfully, but hover, drag and pixel fidelity remain uncertified. |
| Android needs a working SDK and device | The missing-SDK error was verified, not a real device journey. |
| Creation finishes before readiness | A created portal may still be loading or booting. Inspect it before interacting. |
| `check` is ambiguous in the CLI | `portal check NAME SELECTOR` captures instead of checking a checkbox. The tool omits it. `uncheck` works; inspect checkbox state before using `click`. |
| Navigation acknowledgements are not page-load events | `navigate` starts navigation. `edit` updates the saved source and need not navigate the loaded page. |
| Some reads have effects | `logs` consumes the console buffer. Setting a user-agent preset reloads the page. |
| Native text can be ambiguous | Known interaction failures become Pi errors. Free-form text, HTML, logs and evaluate results preserve the native response, which may not distinguish data from an execution error. |
| Capture delivery is local | Screenshot paths on remote hosts are not loaded by this Linux implementation. |

## Development

From a reviewed source checkout:

```sh
npm install
npm run check
npm run smoke
```

`check` runs lint (all generic anti-slop rules and a maximum complexity of 10),
type checking, a clean JavaScript build and behavioral tests, including a
tarball installed into isolated `node_modules`.
`npm pack` builds the distributable automatically. `smoke` uses **GPT-6 Astra**
against a controlled CLI and requires model access; it is not a live Maestri
journey.

The internal-validation regression also runs against an installed OMP loader
when Bun is available and its package root is supplied:

```sh
MPO_OMP_PACKAGE_ROOT=/absolute/path/to/node_modules/@oh-my-pi/pi-coding-agent npm run check
```

It checks the same receipt, lock and invocation cases in source and built
artifacts under Node and OMP. Without this variable, the OMP-specific case is
explicitly skipped; the Node cases still run. These checks do not call a model.

Smoke events, per-call argv and the first failure are retained under
`.artifacts/smoke-v01/` (override with `MPO_SMOKE_ARTIFACTS_DIR`). The deterministic
smoke-harness tests exercise this recording without a model or network.

Try the checkout after `npm run build`, without changing Pi settings:

```sh
pi -e /absolute/path/to/maestri-pi-operator
```

For live agent communication, leave a disposable connected Pi terminal idle
and unselected, then run:

```sh
MPO_LIVE_TARGET='Exact terminal name' npm run smoke:live
```

See [architecture](docs/architecture.md) for implementation boundaries.
Local investigation artifacts live in the ignored `.artifacts/` directory.

<details>
<summary><strong>External waiter and Firstmate integration</strong></summary>

`mpo-extension wait --request <uuid> [--timeout <1-55>]` is a read-only wait
within the explicit workspace and calling-terminal scope. The scope environment
is mandatory, including for Firstmate: provide `MAESTRI_WORKSPACE_ID` and
`MAESTRI_TERMINAL_ID`. A UUID alone is not a cross-scope capability. It waits
for terminal metadata without consuming the reply or
changing request state. Ordinary timeout is silent and successful. The envelope
contains no prompt or reply text.

The executable also implements Firstmate's `process-event-adapter/1` as
`maestri-ask`, declared in [firstmate-extension.json](firstmate-extension.json).
Firstmate owns capture, wake publication, acknowledgement and re-arming within
that same scope. Pending and result are read-only observations; neither implies
retry. Claims and acknowledgements can cause a notice to be repeated, while
failures can produce no notice; there is no universal delivery guarantee.
Consumers must therefore make notice handling idempotent without assuming
at-least-once delivery.

</details>

<details>
<summary><strong>Migrating from earlier versions</strong></summary>

`maestri_apply` and the `./apply-executor`, `./apply-store`, `./apply-tool`,
`./observation`, `./projection` and `./role-manager` exports were removed.
Use the direct role and note tools instead, and update tool allowlists that
named `maestri_apply`. The readiness classifier remains exported from the
package root and `./readiness`.

Planning skills, playbooks, principles, role bootstraps and the experimental
Fundamentos setup command are no longer packaged. A separate extension may
provide them later.

Existing notes, roles and old apply records are left untouched. There is no
automatic manifest migration, replay or deletion of canvas resources.

</details>

## Lint anti-slop

`npm run lint` exige as quinze regras anti-slop como `error`, complexidade máxima
10 e zero warnings. A configuração é única; o gate não mantém dívida em `warn`.
