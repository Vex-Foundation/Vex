# How Vex Studio Works

*The engineering source of truth for Vex Studio: how an external coding agent drives the self-custodial Vex desktop app over MCP, from the bridge binary to the approval card, with every technical claim cited to the shipping tree.*

Tree documented: `feat/lighter-integration` (Vex-Foundation/vex), assembled 2026-09-07 on top of `launchpads/arc`. Citations are worktree-relative `path:line` references into that tree. Numbers come from a measured probe of the same tree; see the Facts And Numbers Reference. Where a plan document and the code disagree, this document says what shipped.

## Contents

- [Part 0 - Orientation](#part-0-orientation)
  - [What This Document Is](#what-this-document-is)
  - [The One-Paragraph Mental Model](#the-one-paragraph-mental-model)
  - [The First Hour: Install, Unlock, Create A Project, First Tool Call](#the-first-hour-install-unlock-create-a-project-first-tool-call)
  - [Glossary](#glossary)
- [Part 1 - Architecture, Trust Boundaries, And The Security Model](#part-1-architecture-trust-boundaries-and-the-security-model)
  - [Process Map And The Five Trust Boundaries](#process-map-and-the-five-trust-boundaries)
  - [The State Machines At A Glance](#the-state-machines-at-a-glance)
  - [Fail-Closed, Named Everywhere](#fail-closed-named-everywhere)
  - [The Trust Boundary, Stated Plainly](#the-trust-boundary-stated-plainly)
- [Part 2 - Transport And The Bridge](#part-2-transport-and-the-bridge)
  - [Where The Host Listens: Endpoint Derivation](#where-the-host-listens-endpoint-derivation)
  - [Binding The Unix Socket](#binding-the-unix-socket)
  - [Windows: Why A Separate Process, And How It Proves Itself](#windows-why-a-separate-process-and-how-it-proves-itself)
  - [The Windows Data Plane: Multiplexing, Credit, And Half-Close](#the-windows-data-plane-multiplexing-credit-and-half-close)
  - [The Pipe-Front Wire Codec](#the-pipe-front-wire-codec)
  - [Connecting: Handshake And Admission](#connecting-handshake-and-admission)
  - [One Tool Call, Wire To Wire](#one-tool-call-wire-to-wire)
  - [Lock, Quit, And Reconnect](#lock-quit-and-reconnect)
  - [The vex-mcp Bridge Binary](#the-vex-mcp-bridge-binary)
  - [Windows Dial-Time Security: SQOS And Host Authentication](#windows-dial-time-security-sqos-and-host-authentication)
- [Part 3 - The Tool Surface](#part-3-the-tool-surface)
  - [The Exported Tool Surface](#the-exported-tool-surface)
  - [Protocol Namespaces And What They Cover](#protocol-namespaces-and-what-they-cover)
  - [vex_ToolSearch And vex_ToolDescribe](#vex-toolsearch-and-vex-tooldescribe)
  - [Admission And Dispatch Routing](#admission-and-dispatch-routing)
  - [What Never Leaves The App](#what-never-leaves-the-app)
  - [The Hot Set And Description Budget](#the-hot-set-and-description-budget)
  - [What A Fresh Connection Is Told](#what-a-fresh-connection-is-told)
- [Part 4 - Approvals: The Money Gate](#part-4-approvals-the-money-gate)
  - [Project Permission And Wallets](#project-permission-and-wallets)
  - [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)
  - [The Authority Digest And Manifest Fingerprint](#the-authority-digest-and-manifest-fingerprint)
  - [The Approval Data Contracts](#the-approval-data-contracts)
  - [The Approval Card And The Global Approvals Panel](#the-approval-card-and-the-global-approvals-panel)
  - [Approval Window, Expiry, And Outcomes](#approval-window-expiry-and-outcomes)
  - [When Approvals Fail: Locked, Deleted, Scope-Changed](#when-approvals-fail-locked-deleted-scope-changed)
- [Part 5 - Money Paths: Signing, Fees, Swaps, Bridges, And Launches](#part-5-money-paths-signing-fees-swaps-bridges-and-launches)
  - [Money Paths Reachable From Studio](#money-paths-reachable-from-studio)
  - [Where Keys Live And When They're Decrypted](#where-keys-live-and-when-they-re-decrypted)
  - [Generic Signing And Its Fee](#generic-signing-and-its-fee)
  - [Swap And Bridge Fee Mechanics](#swap-and-bridge-fee-mechanics)
  - [The pools.fun Launch: The Deepest Money Path](#the-pools-fun-launch-the-deepest-money-path)
  - [Virtuals And Lending Protocols](#virtuals-and-lending-protocols)
  - [Lighter: Perpetuals And Spot On Two Exchanges](#lighter-perpetuals-and-spot-on-two-exchanges)
  - [The Prequote Gate](#the-prequote-gate)
- [Part 6 - Projects, Files, And The Installer](#part-6-projects-files-and-the-installer)
  - [What A Project Is](#what-a-project-is)
  - [The Exact Delete Order](#the-exact-delete-order)
  - [What A Settings Edit Does - And Does Not Do](#what-a-settings-edit-does-and-does-not-do)
  - [The Projects Root And Its Anchor](#the-projects-root-and-its-anchor)
  - [How The Installer Reconciles Files](#how-the-installer-reconciles-files)
  - [The Files A Project Gets](#the-files-a-project-gets)
  - [What The Installer Never Writes](#what-the-installer-never-writes)
  - [The Files Domain: Tree, Read, Watch, Mutate](#the-files-domain-tree-read-watch-mutate)
  - [No-Follow Readers: How Untrusted Paths Are Read Safely](#no-follow-readers-how-untrusted-paths-are-read-safely)
- [Part 7 - The In-App Studio Workspace](#part-7-the-in-app-studio-workspace)
  - [The In-App Studio Workspace](#the-in-app-studio-workspace)
  - [Opening, Closing, And Keeping Projects Alive](#opening-closing-and-keeping-projects-alive)
  - [Search: Projects And Files](#search-projects-and-files)
  - [Terminal Tabs And Keyboard Behavior](#terminal-tabs-and-keyboard-behavior)
  - [The File Viewer And Syntax Highlighting](#the-file-viewer-and-syntax-highlighting)
  - [The Terminal: A Separate Privileged Process](#the-terminal-a-separate-privileged-process)
  - [What A Studio Terminal Can See: An Unresolved Question](#what-a-studio-terminal-can-see-an-unresolved-question)
  - [Every Screen And Dialog, At A Glance](#every-screen-and-dialog-at-a-glance)
- [Part 8 - Sessions, Dispatch, And Logging](#part-8-sessions-dispatch-and-logging)
  - [The Studio Backing Session](#the-studio-backing-session)
  - [The Full Gate Ladder One Call Passes Through](#the-full-gate-ladder-one-call-passes-through)
  - [Execution Capture And Audit](#execution-capture-and-audit)
  - [The Seven Outcomes An Agent Sees](#the-seven-outcomes-an-agent-sees)
  - [Leases And The Global Lock Order](#leases-and-the-global-lock-order)
- [Part 9 - Configuration, Limits, And Errors: The Reference](#part-9-configuration-limits-and-errors-the-reference)
  - [Configuration And Environment Reference](#configuration-and-environment-reference)
  - [Docker And Postgres Prerequisites, As They Touch Studio](#docker-and-postgres-prerequisites-as-they-touch-studio)
  - [Consolidated Limits And Bounds](#consolidated-limits-and-bounds)
  - [Consolidated Closed Error-Code Enumerations](#consolidated-closed-error-code-enumerations)
  - [Facts And Numbers Reference](#facts-and-numbers-reference)
- [Part 10 - Packaging, Signing, And Release](#part-10-packaging-signing-and-release)
  - [How The Bridge Binaries Are Staged And Packaged](#how-the-bridge-binaries-are-staged-and-packaged)
  - [Signing, Notarization, And The Draft-Release Gate](#signing-notarization-and-the-draft-release-gate)
- [Part 11 - End-To-End Journeys](#part-11-end-to-end-journeys)
  - [Journey: First-Time Setup Through The First Tool Call](#journey-first-time-setup-through-the-first-tool-call)
  - [Journey: A Read-Only Research Session](#journey-a-read-only-research-session)
  - [Journey: A Swap Decided On The Approval Card](#journey-a-swap-decided-on-the-approval-card)
  - [Journey: A Full-Autonomy Session](#journey-a-full-autonomy-session)
  - [Journey: A Token Launch With A Project Image](#journey-a-token-launch-with-a-project-image)
  - [Journey: Lock, Quit, And A Windows Front Restart](#journey-lock-quit-and-a-windows-front-restart)
  - [Journey: When Something Goes Wrong](#journey-when-something-goes-wrong)
- [Part 12 - Troubleshooting](#part-12-troubleshooting)
  - [Studio Host Status And What Each State Means](#studio-host-status-and-what-each-state-means)
  - [Bridge Exit Code Triage](#bridge-exit-code-triage)
  - [Common Problems And Their Real Causes](#common-problems-and-their-real-causes)
  - [Accessibility Notes For The Workspace UI](#accessibility-notes-for-the-workspace-ui)
- [Part 13 - Appendices](#part-13-appendices)
  - [Citation Corrections](#citation-corrections)
  - [Stale Landing Claims To Fix](#stale-landing-claims-to-fix)
  - [Open Questions Requiring A Product Or Security Decision](#open-questions-requiring-a-product-or-security-decision)
  - [Where The Regression Guards Live](#where-the-regression-guards-live)
  - [Keeping This Document Current](#keeping-this-document-current)


## Part 0 - Orientation

### What This Document Is

This document, "How Vex Studio Works," is one Markdown file kept in the Vex repository, and it is the single source of truth for how Vex Studio behaves. This document is written once and is the source the landing site's Studio pages and the in-app "How Vex Works" help screen are to be rewritten from, stripped of citations for their own audiences: a reader on the landing site or inside the app would see the claim in plain second-person language, never a file path or a line number. That rewrite has not happened yet; today the in-app help screen has no Studio section at all, and parts of the landing site still describe a Studio that predates the shipping tree. If landing or in-app copy ever says something this document does not, this document is the one to trust.

Every technical claim in the repository copy carries a compact citation of the form `path/to/file.ts:123` (or a line range) at the end of the sentence it supports. Citations are pinned against the shipping tree, branch `launchpads/arc`, verified on 2026-09-07. Sections written for a general user carry citations only where a specific number needs one to be trustworthy; sections written for a maintainer or a downstream writer cite every technical claim. No number in this document is invented, rounded, or estimated: each one traces back to a measured count taken directly from the running code, to a cited test, or to a file and line an author opened and read.

Where a plan, a design note, or an older decision record disagrees with what the code actually does, the code wins, and this document states what shipped rather than what was once intended. A `.md` design document under a spec folder is treated as history that can explain why the code looks the way it does, never as a current-state source on its own.

This document supersedes the older draft `src/vex-agent/tools/tool-surface-spec/studio-mcp/vex-studio-plan-v2.md`. That draft, dated 2026-08-23 with revisions through 2026-08-25, describes a Studio with 159 tools, no in-app workspace, and Windows support disabled; none of those three facts hold in the shipping tree measured for this document, and the older draft should not be treated as current (see [The Exported Tool Surface](#the-exported-tool-surface)) (see [The In-App Studio Workspace](#the-in-app-studio-workspace)) (see [The Windows Data Plane: Multiplexing, Credit, And Half-Close](#the-windows-data-plane-multiplexing-credit-and-half-close)).

### The One-Paragraph Mental Model

Vex Studio is how an external coding agent drives the same self-custodial Vex desktop app you use directly, over the Model Context Protocol (MCP). Vex ships a named roster of 15 agent ids; 13 of them get a working configuration writer today (12 write a project-local config file, one - Kimi - is wired through a launch flag instead), and the remaining 2 (Cline, Warp) are named but not yet wired (`src/lib/studio-agent-ids.ts:29-45`, `src/vex-agent/studio/agents.ts:739,762`).

Mechanically, a local MCP host runs inside the Vex app itself. On macOS and Linux it binds a Unix domain socket; on Windows, because a Node-owned pipe is not safe under that platform's per-process security model, the app spawns and supervises a small dedicated child process (`vex-pipe-front`) that binds the named pipe instead, and the host only publishes the endpoint once Windows has confirmed the pipe's protection flags on readback (`vex-app/src/main/studio/mcp-host.ts:286`, `vex-app/src/main/studio/mcp-host/listener.ts:438`, `vex-app/src/main/studio/mcp-host/front-handshake.ts:88-108`). The coding agent itself never talks to that socket or pipe directly - it spawns `vex-mcp`, a small standalone Go binary, as its own stdio MCP server. `vex-mcp` reads a project id, derives the same endpoint by platform convention, dials, and then relays bytes verbatim between the agent's stdio and the Vex host; it does no retries anywhere and exits with one of a fixed set of distinct codes when something goes wrong (`bridge/cmd/vex-mcp/main.go:1-18`, `main.go:10-17`).

Whichever surface a mutating action comes from - the in-app agent chat or an external Studio agent over MCP - it passes through the exact same approval, wallet, and fee machinery inside Vex; Studio MCP calls dispatch mutating tools through the identical `dispatchTool`/`executeProtocolTool` path the in-app agent uses, and the same ordinary approval card renders for non-launch mutating tools on both surfaces (`src/vex-agent/mcp/admission.ts:1-23,145-166`, `src/vex-agent/tools/protocols/runtime/gates.ts:328-370`). Neither the model nor the external agent ever holds a private key or signs anything; it can only propose. A human decides inside the app, looking at an approval card whose contents are cryptographically bound to the exact tool, arguments, and expiry it was built from and are revalidated immediately before dispatch, so a proposal that goes stale while queued cannot slip through under changed terms (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:284-312`, `src/vex-agent/engine/core/approval-runtime/tool-call-envelope.ts:23-38`). Only Vex's own privileged process ever signs.

The in-app Studio workspace itself - the project rail, file explorer, file viewer, and terminal - is fully shipped and tested today, not a reserved seat waiting on a future release: the `Agent | Studio` toggle is a live keyboard-accessible control, and its own code comment records that it used to be a disabled, locked button before that changed (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:13-17`).

### The First Hour: Install, Unlock, Create A Project, First Tool Call

#### Cold boot

When you open Vex for the first time, the app does not drop you straight into the shell. The view machine walks `splash -> systemCheck -> dockerBootstrap -> composeBootstrap -> migrations -> wizard -> unlock -> appShell`, and for a first run it walks the whole chain: Docker, the local Postgres compose stack, and database migrations all have to resolve before you reach the setup wizard and unlock screen, and only after unlock does the app route you into the main shell - a healthy returning user is the one who skips straight to unlock and the shell (`vex-app/src/renderer/App.tsx:8-11`). Concretely, a fresh install's first settled screen is `systemCheck` (`vex-app/e2e/studio.spec.ts:159-162`). If a route change is attempted before a handoff has actually landed, it is undone rather than left showing a half-mounted screen (`vex-app/e2e/studio.spec.ts:152-158`). In practice this means the first thing you see is a brief status line - "Waking the desk", then "Starting services", "Preparing the ledger", and "Reading your setup" as each probe resolves (`vex-app/src/renderer/features/setup/useSetupOrchestrator.ts:72-75`) - not a broken or partially-drawn window.

Once setup finishes, you create a wallet vault (or unlock an existing one). This step matters more than it looks: Vex Studio's connection point for outside coding agents starts locked. The admission gate that decides whether an external tool call is served boots with `locked = true` before anything else runs, fail-closed, so no external agent can reach a project's files or tools until you have explicitly unlocked (`vex-app/src/main/studio/mcp-host/admission.ts:80-81`). The listener itself can already be bound and accepting connections at this point, but a locked listener answers every connection attempt with a typed refusal and reads no project bytes at all - "Vex is locked, so it will not serve MCP calls. Nothing was executed and no funds moved. Unlock Vex and connect again." (`vex-app/src/main/studio/mcp-host/admission.ts:46-48`). Only a committed unlock opens admission: the secret session calls the opener only once its dispatch-generation advance has committed, its poison is clear and its pending durable refusal is written (`vex-app/src/main/studio/mcp-host.ts:290-301`, `vex-app/src/main/studio/mcp-host/admission.ts:125-137`).

#### Switching into Studio

Inside the shell, an "Agent | Studio" capsule chooses which runtime you are in. This used to be two different affordances: the Studio side was a disabled button carrying a lock icon and a "coming soon" label, and the Agent side was an inert element with no real interaction at all. That version is retired. Both sides are now real radio buttons inside one `role="radiogroup"`, the selected one carries `aria-checked`, and clicking or using the keyboard on either one dispatches the switch - the code's own header comment states this explicitly, because two older tests had pinned the disabled version and had to be rewritten (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:12-16`). You can reach it entirely from the keyboard: the group is one tab stop, arrow keys move the roving selection between Agent and Studio (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:50-56`), and `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS - the chord row uses `ctrlOrCmd` with no `mac` override, unlike the rows the file's own header calls out as macOS exceptions, `vex-app/src/renderer/features/appShell/studio/keybindings.ts:305-306`) switches modes directly and moves focus to the right place in whichever mode you land in (`vex-app/src/renderer/features/appShell/studio/__tests__/useStudioKeybindings.test.tsx:222-239`; the return into Studio lands its focus through the mounted surface's own armed landing rather than in the handler, `vex-app/src/renderer/features/appShell/studio/useStudioKeybindings.ts:140-159`). Choosing a mode is a UI decision only - it decides which panels mount, and it grants no privilege by itself; every actual Studio action is still checked in the main process, not by which tab happens to be open.

#### Creating a project

From the Studio sidebar, "New project" opens a dialog. The name field is focused automatically, and Create stays disabled until you type a non-empty name (`vex-app/e2e/studio.spec.ts:220-234`). Three choices in this dialog carry real consequences:

- **Permission.** Every new project defaults to `restricted` (`vex-app/src/renderer/features/appShell/studio/projects/ProjectCreator.tsx:130`). In a restricted project, any call an outside agent makes that would move funds or cause another irreversible effect blocks and waits for you to approve it in Vex before it runs (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)). You can choose full access instead, which removes that pause for calls the agent makes on its own - that choice is yours to make at creation time, and to change later, not something an agent can grant itself.
- **Wallets.** The wallet fieldset shows your real wallet inventory, read live from Vex's own wallet list. If you have not added a wallet yet, it says so honestly - "No wallets yet." and "Add one in Settings, under Wallets." - rather than showing an empty, unexplained picker (`vex-app/e2e/studio.spec.ts:240-278`).
- **Agents.** You pick which coding agents this project should be configured for. The picker only offers agents Vex actually knows how to write configuration for; Cline and Warp are not offered as choices here, because Vex has no working config writer for either of them (`vex-app/e2e/studio-project-journey.spec.ts:234-237`, agent list at `src/vex-agent/studio/agents.ts:736-777`).

#### What Create actually does

Clicking Create runs the installer. It resolves the bridge binary Vex needs on disk, builds a plan from the agents you picked plus the project's live tool inventory, and then writes files, reporting a per-artifact outcome rather than a single pass/fail line. The plan always includes more than your agent selection: four project-level files are appended unconditionally, regardless of which agents you chose, because they describe the project itself rather than any one client - `AGENTS.md`, `.vex/vex-guide.md`, `CLAUDE.md`, and `.vex/protocols.md` (`vex-app/src/main/studio/installer/plan.ts:150-190`). `AGENTS.md` is what most coding agents read by convention whether or not their own dedicated config file was written, `.vex/vex-guide.md` carries the half of the protocol reference `AGENTS.md` cannot fit under a smaller agent's context budget, and `CLAUDE.md` imports from the guide for Claude Code specifically. On top of those four, an agent you selected gets its own config file - for Claude Code that is `.mcp.json`, reported back as `{kind: "agent-config", path: ".mcp.json", state: "current"}` alongside `{kind: "agents-md", path: "AGENTS.md", state: "current"}` (`vex-app/e2e/studio-project-journey.spec.ts:271-287`).

If Vex cannot find the bridge binary on disk, Create refuses the whole run rather than writing a partial set of files that would point an agent at nothing. Nothing lands on disk, not even the four unconditional files, and the report tells you: "Vex could not find the bridge program its configs point at, so it wrote NO files for this project. A config naming a program that is not there is worse than no config. Reinstall or update Vex, then repair this project." (`vex-app/src/renderer/features/appShell/studio/projects/projects-copy.ts:471-472`) - a missing binary is treated as an honest outcome rather than something to paper over with configs that point at nothing (`vex-app/src/main/studio/installer/bridge-path.ts:30-32`). The install report itself renders in a fixed, always-visible slot in the dialog - a real layout check exists for this because an earlier version of the report could render below the fold where you would never see it (`vex-app/e2e/studio-project-journey.spec.ts:241-253`).

Files created by a running installer never touch a real project directory you did not choose; each run resolves its target from the project's own anchored root (`vex-app/src/main/studio/installer/paths.ts:4-20`).

#### Opening the project

Click the project's row in the sidebar and Vex mounts the Studio workspace for it and automatically opens a first terminal tab for you - you do not have to open one yourself before you can start working (`vex-app/e2e/studio-project-journey.spec.ts:321-340`).

#### The first real tool call

At this point the project has a working `.mcp.json` (or the equivalent file for whichever agent you chose), and nothing further needs to be edited by hand. A real external client - Claude Code, Codex, or another MCP-speaking agent pointed at this project - connects with the standard MCP handshake: `initialize`, then `notifications/initialized`, then `tools/list`. That listing already includes Vex's own discovery tools (`vex_ToolSearch`, `vex_ToolDescribe`) plus the protocol tools Vex installed, such as `dexscreener__pairs_search` and `dexscreener__candles_list` (`vex-app/e2e/studio-mcp-live.spec.ts:369-399`). No manual configuration edits are needed between "Create" finishing and the agent seeing this tool list; that end-to-end path, including a Codex agent run over `codex exec` reading the installer's own `command`, `args`, and `tool_timeout_sec` verbatim, has been driven for real against a live provider, not only against a fixture (`vex-app/e2e/studio-mcp-live.spec.ts:294-354,484-604`).

What happens next depends on the tool and on the project's permission setting:

| call type | restricted project | full-access project |
|---|---|---|
| read-only (quote, search, a local read) | returns immediately, no approval card | returns immediately, no approval card |
| mutating / destructive (execute, transfer, launch) | answered `pendingApproval`; the call blocks until you decide it in Vex | dispatches directly, no approval card |

A read-only call such as a DexScreener lookup is validated against the protocol's own schema and returns its result with no approval round-trip at all (`vex-app/e2e/studio-mcp-live.spec.ts:410-446`). A mutating call in a restricted project - a wallet transfer, for example - is different: Vex answers it with `pendingApproval`, enqueues the intent, and the call itself stays blocked on the agent's side until you approve or reject it from the approvals panel (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)). That is the mechanism this first hour sets up: by the time you make your first real tool call, unlocking has already opened the door, the installer has already written a config that needs no further editing, and the permission you chose at project creation is already the rule the very first mutating call will be measured against.

### Glossary

Terms used without re-explanation elsewhere in this document.

#### Project, scope, backing session

A **project** is a Studio workspace row (`projects` table) for one folder on disk, with its own **scope**: `permission` (`restricted` or `full`), `scopeVersion` (starts at 1, bumped on every permission or wallet edit - optimistic concurrency), and up to two selected wallets (evm, solana), each `null` meaning no selection with no fallback to a primary wallet (`src/vex-agent/mcp/project-scope.ts:34-56`). `restricted` routes every mutating call through the approval card; `full` executes directly under standing permission (`src/vex-agent/tools/protocols/conventions.ts:794-799`). Every call reloads scope fresh from the database rather than trusting a connection-time cache (`vex-app/src/main/studio/approval-service.ts:176-182`).

Every project has a **backing session**: an ordinary `sessions` row minted once, at project creation, in the same transaction as the project (`mode='agent'`, `scope='vex_studio'`, `vex-app/src/main/database/projects/create.ts:152,277`). `scope.backingSessionId` is that row's id.

#### Admission, listener, readiness barrier - three separate state machines

| Machine | States | Owner |
|---|---|---|
| Listener (transport) | `stopped -> starting -> listening -> shutting_down` | `vex-app/src/main/studio/mcp-host/listener.ts:96-107` |
| Admission (authority) | `ready` \| `locked` (boot default) \| `unready`, plus a separate `permanentlyClosed` boolean latch checked ahead of and independently from this union | `vex-app/src/main/studio/mcp-host/admission.ts:50-57` (union), `:146-148` (`permanentlyClosed`) |
| Readiness barrier | `starting -> ready \| fence_uninitialized -> shutting_down` (terminal, one-way per epoch) | `vex-app/src/main/studio/readiness.ts:68-80` |

A bound listener on a locked Vex is the designed boot state (`vex-app/src/main/studio/mcp-host.ts:19-21`). Admission reads the readiness barrier live, never a copy (`admission.ts:33-37`). Renderer-visible host status derives from all three with fixed precedence: listener phase, then the Windows front's cause, then `admission_permanently_closed`, then `locked`/`unready`, else `running` (`mcp-host.ts:144-185`).

#### Approval envelope, authority digest, manifest fingerprint, approval intent, dispatch generation

An **approval intent** is the durable row created when a restricted-project mutating call parks on a human decision (`enqueueApprovalIntentWithGate`, `src/vex-agent/engine/core/approval-runtime/enqueue.ts:220`), carrying an **envelope** (the call as it will be re-run, built by `buildApprovalToolCall`, `tool-call-envelope.ts`, called at `enqueue.ts:266`) and a **preview** (the card the human sees, built by `buildApprovalIntentPreview`, `enqueue.ts:80-99`, which calls `buildDurableApprovalCard` in `durable-approval-card.ts:64-76` for a prepared-follow-up binding) - both constructed inside the single `enqueueApprovalIntentWithGate` transaction so they cannot diverge. The **authority digest** (`studio-authority-v1`) is a sha256 over `{version, origin, sessionId, projectId, scopeVersion, permission, expiresAt, preview, envelope, manifestIdentity}` (`tool-call-envelope.ts:459-496`), stored at enqueue and re-verified at dispatch; a stored digest that is `null` or lacks the version prefix is refused, never treated as a legacy pass (`tool-call-envelope.ts:502-511`). The **manifest fingerprint** check refuses dispatch if the tool contract behind the approved toolId changed while queued (`post-tx/dispatch-approved/studio.ts:272-283`). **Dispatch generation** is stamped at enqueue; the dispatch slot claim requires the current durable generation still match it, so a lock/unlock in between makes the claim match zero rows (`studio.ts:18-23`).

#### Project lifecycle lease and its 9 classes

A **project lease** is an in-process handle acquired synchronously (before any await) that delete must account for before tombstoning a project. Nine classes (`ProjectLeaseClass`, `vex-app/src/main/studio/project-lifecycle-gate.ts:82-91`): `executingCall`, `dispatch`, `pendingApproval`, `render`, `watcher`, `terminal`, `terminalCreate`, `terminalPersist`, `fileOperation`. Delete drains five of the nine classes (`executingCall`, `dispatch`, `terminalCreate`, `terminalPersist`, `fileOperation` - `DRAINED_LEASE_CLASSES`, `project-lifecycle-gate.ts:136-142`); `render`, `watcher`, and `terminal` are closed through delete's own close hooks instead of being drained, and `pendingApproval` is deliberately parked, never drained: it releases only when delete's own transaction refuses it (`project-lifecycle-gate.ts:24-42`).

#### Generation vs epoch

Two counters, deliberately distinct. **Generation** is a `u32` in every frame header on the main-to-Windows-front wire, incremented per front process restart, so a stale front instance's frames are rejected by number (`bridge/internal/front/frames/types.go:357-363`; one `FrontRelay` per generation, constructed once per bound bootstrap cycle, `vex-app/src/main/studio/mcp-host/front-supervisor.ts:597-599`). **Epoch** is the admission fence, captured by every connection at accept and advanced on lock or quit so in-flight continuations and queued front `ADMIT`s naming the old value go stale (`mcp-host.ts:315,441`; `admission.ts:78`, ceiling `0xffffffff` latches `permanentlyClosed`, cleared only by app restart). Generation tracks the Windows child's restarts; epoch tracks who may admit a connection.

#### Hot set, protocol namespace, provenance, drift, tombstone

The **hot set** is the 29 always-loaded tools, which is exactly the internal-tool set: the wallet, swap, bridge and research tools, `vex_ToolSearch`, `vex_ToolDescribe`, and the two Lighter onboarding shortcuts `lighter_core_onboarding_status` and `lighter_rhc_onboarding_status`. It is served on every `tools/list` without a search step (`src/vex-agent/mcp/inventory/index.ts:146-207`), pinned under a 2048-character/byte description budget (`src/vex-agent/mcp/inventory/types.ts:15-39`). The remainder are exported protocol tools under a `<namespace>__` prefix (e.g. `khalani__`, `pools__`).

**Provenance** records, per managed artifact, whether Vex wrote the bytes (`origin: "written"`) or found them already present and adopted the fact without claiming authorship (`origin: "adopted"`, `vex-app/src/main/studio/installer/reconcile.ts:380-389`); only `"written"` rows can be taken over or torn down. **Drift** is a filesystem fact recomputed on every read, never cached: on-disk content no longer hashes to what provenance recorded (`installer.ts:406-409`) - reported, never silently overwritten outside an explicit Repair. A **tombstone** is a project's soft-delete: `tombstoneProject` sets `deleted_at` in one commit transaction with no filesystem work (`vex-app/src/main/database/projects/delete.ts:132`); a tombstoned project reads as absent to every later scope check.


## Part 1 - Architecture, Trust Boundaries, And The Security Model

### Process Map And The Five Trust Boundaries

Vex Studio lets an external coding agent (Claude Code, Codex CLI, Cursor, and others) call Vex tools against a specific project. Doing that safely means the request crosses several separate operating-system processes before anything privileged happens, and each process holds a different, narrower slice of authority than the one before it.

#### The processes

- **External agent process.** The coding agent the user already runs (Claude Code, Codex, etc.). It never talks to Vex's database, wallet, or main process directly.
- **`vex-mcp` (the bridge).** A standalone Go binary the external agent spawns as its stdio MCP server. It re-derives the local endpoint from platform convention, dials, handshakes, and relays bytes verbatim between the agent's stdio and that endpoint; it retries nothing (`bridge/cmd/vex-mcp/main.go:10-17`). The agent's own config always names an absolute path to this binary, never a bare name resolved through `PATH` (`vex-app/src/main/studio/installer/bridge-path.ts:25-28`, wired into every rendered config via `vex-app/src/main/studio/installer.ts:168,194`).
- **`vex-pipe-front` (Windows only).** A second Go binary, spawned and supervised by Vex's own main process (`FrontSupervisor`, `vex-app/src/main/studio/mcp-host/front-supervisor.ts:196`) to own the Windows named pipe, since a Node-owned pipe cannot get the same security descriptor. It is never listed in any agent's MCP configuration; the one function that assembles every agent's config entry writes only `facts.bridgeCommand` (the `vex-mcp` path) into the `command` field, for every dialect (`buildStudioEntryFields`, `src/vex-agent/studio/installer/render/entry.ts:49-84`) - a structural observation, not a specific negative-code citation: no agent-config path naming `vex-pipe-front` was found in this pass. On non-Windows platforms this process does not run at all.
- **Renderer.** The Electron window's web content. It renders state and collects user intent.
- **Preload.** The typed bridge between renderer and main.
- **Main process.** The privileged Electron process: database, wallet, Docker, the MCP host listener, and the admission/approval machinery all live here.

#### Renderer: display and intent, not authority

The renderer has no Node, Electron, database, wallet, signing, or provider authority. The clearest proof is the `Agent | Studio` runtime-mode toggle (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:66-106`): it is a real `role="radiogroup"` control that flips `uiStore.runtimeMode`, a value persisted only in the renderer's own `localStorage` (`vex-app/src/renderer/stores/uiStore/persistence.ts` `PERSISTED_UI_KEYS`, lines 72-87). Nothing about clicking it reaches main, the database, or a signing path - it changes which panel the renderer shows and nothing else. Persisted UI hints like `runtimeMode` and `activeProjectId` are read back as untrusted strings, coerced to a closed set, then re-validated against a settled project list before anything is done with them (`vex-app/src/renderer/stores/uiStore/persistence.ts:33-71`); a stale or hand-edited value opens nothing.

#### Preload: narrow typed methods, never raw IPC

Preload exposes named methods scoped to one domain, never `ipcRenderer` itself. The files domain is representative: `FilesBridge` exposes nine specific methods (`listChildren`, `readFile`, `watchFile`, `unwatchFile`, `revealInFileManager`, `createNode`, `renameNode`, `deleteNode`, `onFilesEvent`) over nine IPC channels (`vex-app/src/preload/shell/files.ts:120-187`, channel constants `vex-app/src/shared/ipc/channels/requests.ts:700-713`). Preload validates both directions: the outgoing request against its input schema (`invokeWithSchema`, `vex-app/src/preload/shell/files.ts:122,130`) and, for the push channel, the incoming event against `filesEventSchema` on receipt (`vex-app/src/preload/shell/files.ts:80`).

#### Main: validate before privileged work

Main revalidates everything preload already checked, plus what preload cannot know. `registerStudioFilesHandlers` re-validates both input and output schemas per channel before touching `FilesDomain` (`vex-app/src/main/ipc/studio-files.ts:71-172`), and every one of its handlers also rejects a call from an untrusted sender before doing anything else (`assertTrustedSender`, `vex-app/src/main/ipc/register-handler.ts:87`), so a request cannot claim to come from a window or frame it did not come from. A call is also refused if the project's lifecycle lease cannot be acquired (`files-domain.ts:378-391`). The same pattern holds for the MCP host: a bound listener never opens admission by itself - admission starts `locked` at boot regardless of listener state (`vex-app/src/main/studio/mcp-host/admission.ts:81`, `mcp-host.ts:19-21`), and every accepted connection is re-checked against the current admission epoch at every await in its handshake chain (`mcp-host.ts:328-329`, `connection.ts:632-645`).

#### Signing stays in one place regardless of surface

Provider hot-wallet keys never ship in the desktop app. The user's own key material lives only in the privileged main-process vault and never crosses into the renderer, the bridge, or the MCP wire; the MCP boundary carries only tool names, arguments, and results - a structural observation, not a specific code citation: no counter-evidence of key bytes crossing that wire was found in this pass. Signing itself always funnels through the same signing-client resolver (`openLaunchSigningClients`, `src/vex-agent/tools/protocols/shared/launch-signing-clients.ts:36`), which reaches the one wallet-resolution module (`resolveSigningWallet`, `src/vex-agent/tools/internal/wallet/resolve.ts`, imported at `launch-signing-clients.ts:21`) regardless of which surface originated the call. Both the in-app agent and an external Studio agent funnel through the one mapper `toProtocolExecutionContext` (`src/vex-agent/tools/protocols/execution-context.ts:29`), which stamps an `approvalSurface` discriminator - `"in_app_form"` for the desktop UI, `"studio_mcp"` for an external agent (set at `execution-context.ts:57`). That discriminator changes only which consent surface a mutating call must clear: the in-app launch form can substitute for the ordinary approval card, but only when `approvalSurface === "in_app_form"` (`src/vex-agent/tools/protocols/runtime/gates.ts:307-312`); over `studio_mcp` that carve-out is explicitly disabled, so an external agent's launch call always takes the ordinary approval card instead (same function, `gates.ts:296-306,311`). The wallet module, the key vault, and the signing call itself never branch on which surface asked.

The wire key vocabulary that keeps this honest is a small, closed set: `ApprovalSurface = "in_app_form" | "studio_mcp"` (`src/vex-agent/tools/protocols/types.ts:498`), and a caller that omits it is normalized to `"in_app_form"` by default - only the Studio mapper ever states `"studio_mcp"` explicitly (`gates.ts:283-293`, `resolveApprovalSurface`).

### The State Machines At A Glance

Vex Studio's MCP host is not one state machine. It is several independent axes, each with its own owner, and the renderer-visible status a person sees is derived from all of them at read time rather than stored as a single value. This section names each axis before the transport and gate flows detail them in (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)).

#### Listener phase (transport only)

The listener tracks nothing about who may call, only whether a socket or pipe is bound: `stopped -> starting -> listening -> shutting_down`, with `shutting_down` terminal for the process (`vex-app/src/main/studio/mcp-host/listener.ts:103-107`). A bind failure leaves the listener `stopped` and is user-repairable, independent of whether Vex is locked or unlocked.

#### Admission (authority only)

Admission answers a different question: may a peer that already has a bound connection actually call a tool. It boots `locked` regardless of listener state, so binding a socket never opens the door (`vex-app/src/main/studio/mcp-host/admission.ts:81`). It is opened only by `openStudioAdmission()`, called from the secret-session owner once Vex unlocks. When not locked, `unready` is derived live from the readiness barrier below rather than stored separately (`admission.ts:92-98`). A monotonic epoch increments on every close (`admission.ts:113-123`); once it reaches the u32 ceiling `STUDIO_ADMISSION_EPOCH_MAX = 0xffffffff`, admission latches `permanentlyClosed` for the life of the process, because a front restart would hand the new front the same exhausted epoch (`admission.ts:78`, `115-121`). This is the one locked state an unlock cannot clear; the only remedy is a full application restart (`admission.ts:65-71`).

#### Readiness barrier

Readiness gates whether the process can safely let a Studio call reach dispatch at all: `starting -> ready | fence_uninitialized -> shutting_down`, one-way per epoch (`vex-app/src/main/studio/readiness.ts:39-52`, closed-code list at `readiness.ts:68-72`). Two preconditions must both hold before `ready`: the dispatch preflight is registered, and the startup reconciler has finished settling rows left over from a prior process. `shutting_down` invalidates the current readiness epoch, so a bounded registration retry landing after teardown began cannot turn a shutting-down process back into one that admits dispatches (`readiness.ts:33-48`).

| Axis | States | Terminal state | Owner file |
|---|---|---|---|
| Listener | `stopped, starting, listening, shutting_down` | `shutting_down` | `mcp-host/listener.ts:96-107` |
| Admission | `locked, unready, ready`, plus latched `permanentlyClosed` | `permanentlyClosed` (epoch ceiling) | `mcp-host/admission.ts` |
| Readiness | `starting, ready, fence_uninitialized, shutting_down` | `shutting_down` | `studio/readiness.ts` |

#### Independent axes, not one combined state

These three do not collapse into a single lifecycle. A bound listener on a locked Vex is the designed boot state, not an anomaly: the listener reaches `listening` while admission stays `locked` until a person unlocks the vault. A locked host still accepts the connection, writes a typed refusal, and closes, without parsing project bytes or claiming a handshake-pending slot.

#### Renderer-visible status: derived, never stored

`StudioHostStatus.state`, the only lifecycle fact the renderer ever sees, is computed fresh on every transition rather than kept as its own variable, so no second value can drift from the facts it summarizes (`vex-app/src/main/studio/mcp-host.ts:150-185`). The precedence is fixed: listener phase first, because a bind failure is user-repairable and must not be hidden behind `locked`; then the Windows front's own failure cause; then `admission_permanently_closed`, never reported as ordinary `locked`; then admission's `locked` or `unready`; and only then `running` (`mcp-host.ts:161-184`). The schema carries only state and cause codes, never prose or the endpoint path (`vex-app/src/shared/schemas/studio.ts:12-23`).

### Fail-Closed, Named Everywhere

Vex Studio's local MCP host, its socket setup, its bridge binary, and its project-file installer all resolve doubt the same way: when a check cannot prove a thing is safe, it refuses rather than guesses. Later parts of this document invoke these rules by name instead of re-deriving them, so they are collected here once.

#### Admission starts locked, independent of the listener

The host separates two questions: is a socket bound and accepting connections (the listener), and may whatever arrives on that socket actually be served (admission). Binding a listener never answers the second question. Admission starts `locked` at boot regardless of listener state, and only the secret-session owner unlocks it, after its own setup has fully succeeded (`vex-app/src/main/studio/mcp-host/admission.ts:81`). A locked host still accepts the incoming connection, but it writes the one typed refusal sentence and closes; no project bytes are read, no handshake state is claimed (`vex-app/src/main/studio/mcp-host.ts:25-32`).

#### Socket paths, bridge binary, and directory checks

| Check | Rule | Citation |
|---|---|---|
| Unix socket path bound | Every candidate path, including an operator override, is checked against a 103-byte `sun_path` limit before bind | `vex-app/src/main/studio/mcp-host/endpoint.ts:218-220,386` |
| Invalid override | `VEX_STUDIO_SOCKET` failing validation refuses startup by name; it never falls back to the derived path | `vex-app/src/main/studio/mcp-host/endpoint.ts:32-40` |
| Bridge binary location | Exactly two fixed paths, chosen by packaging: `<resources>/bridge/vex-mcp[.exe]` packaged, `<repo>/bridge/dist/<goos>-<goarch>/vex-mcp` in development; no `PATH` search, no bare-name fallback | `vex-app/src/main/studio/installer/bridge-path.ts:14-33` |
| Directory ownership/mode | `lstat`, never `stat`, at every point a symlink could stand in for a real directory | `vex-app/src/main/studio/mcp-host/bind.ts:171-182` |

The override validation matters because the derived socket path already has verified ownership and mode; silently substituting it when an override fails would hide that someone pointed Vex's privileged listener somewhere unverified. Skipping that check would let a bare command name resolve to any binary of that name on the user's `PATH`, running with the project's authority instead of Vex's own installed binary.

The `lstat`-not-`stat` rule protects the socket's parent directory the same way it protects the installer's project-file writes: a symlinked parent must be seen as a symlink (which is not a directory) and refused, not followed and validated as if it were real. The runtime directory itself is created with an exclusive, non-recursive `mkdirSync` so a path an attacker raced into place first fails `EEXIST` instead of being silently reused and then `chmod`-ed, and only a directory `lstat` proves is a real directory owned by the current uid is ever tightened to mode `0700` (`vex-app/src/main/studio/mcp-host/bind.ts:280-332`).

#### Unprovable is never reported as same

Projects-root identity checks compare filesystem identity (`dev` and `ino` from `stat`), not string paths, because case-insensitive filesystems must not report a differently-spelled path as a changed root. The comparison returns one of three verdicts: `same`, `different`, or `unprovable` - a `stat` failure, or a `dev===0 && ino===0` reading some Windows network and FAT volumes report when they have no file index. `unprovable` never resolves to `same`; every caller turns it into a refusal (`vex-app/src/main/studio/projects-root.ts:123-145`). A proven-different root refuses with a message telling the user to restore the old root or remove the override; an unprovable one refuses as retryable, telling the user to reconnect or restore the volume (`vex-app/src/main/studio/project-errors.ts:48-56,72-79`).

#### Windows publishes a listener only after confirmation, never a request

On Windows, main requires the front process to prove, by reading the actual pipe handle back from the OS, that `rejectRemote`, `firstInstance`, and `messageMode` all landed - never by trusting what it asked the OS for (`vex-app/src/main/studio/mcp-host/front-handshake.ts:88-108`). `rejectRemote` matters because libuv creates named pipes without `PIPE_REJECT_REMOTE_CLIENTS` by default, so an unconfirmed flag means the pipe could still accept a remote connection. A readback mismatch fails closed and is not restarted automatically, since the next front would read back the same mismatched descriptor (`vex-app/src/main/studio/mcp-host/front-supervisor.ts:676-683`).

### The Trust Boundary, Stated Plainly

Vex Studio lets an external coding agent (Claude Code, Codex, or any other MCP client) reach into
your Vex project over a local Model Context Protocol connection. Before anything else in this
document, here is exactly what that connection trusts, what it refuses, and the one place where
the trust model still has an open edge.

#### Same machine, same account, nothing wider

The local MCP host binds a socket (a named pipe on Windows, a Unix domain socket elsewhere) and
starts every session `locked`: binding the listener never opens the door on its own
(`vex-app/src/main/studio/mcp-host/admission.ts:81`, `vex-app/src/main/studio/mcp-host.ts:23-31`).
The trust boundary this connection draws is the operating-system user account, not any single
process: any program running as that same account is trusted the same way a locally installed
editor extension would be, because an OS account is the smallest unit Vex can actually authenticate
against on a local machine. The network is excluded entirely - there is no remote listener - and
other OS users on a shared machine are excluded by construction, not merely by convention.

On Windows that account boundary is enforced, not assumed, and it runs before the connection is
even usable. The bridge process a coding agent's own CLI spawns to relay traffic on Windows inherits
an explicit allow-list environment rather than its caller's full one - only `SystemRoot` and
`windir`, the two variables the OS loader and the pipe's own security calls need, nothing else, no
provider credential and no database URL that might live in the parent's environment
(`vex-app/src/main/studio/mcp-host/front-spawn.ts:79,89-93`). Before a single byte of the project id
leaves that process, it dials the pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` flags
that cap a hostile pipe-squatting server at identification level - it can read the client's identity
but never impersonate it (`bridge/cmd/vex-mcp/dial_windows.go:62-63,242-249`) - then opens the serving
process's own token, reads its user SID, and compares it to the caller's SID; any failure along that
chain is a refusal, never a pass, and the refusal deliberately does not disclose the foreign
account's identity (`bridge/cmd/vex-mcp/hostauth_windows.go:105-129`, token-opening at
`bridge/cmd/vex-mcp/hostauth_windows.go:134-179`). `TestHostAuthRefusesAForeignUsersServer` is
recorded as having run green against a real second local Windows account in CI run 33646484002
(not independently re-confirmed against CI logs while writing this document). On Unix, the socket
directory chain is pinned by device/inode identity, verified again immediately after connect and
before the handshake writes a byte
(`bridge/internal/endpoint/identity.go:83-138`, `bridge/cmd/vex-mcp/main.go:104,142,148`).

#### What "project scope" actually gates

A Vex project has a permission setting: `restricted` (the default on creation,
`vex-app/src/renderer/features/appShell/studio/projects/ProjectCreator.tsx:130`) or `full`. Be
precise about what each one is, because the names can suggest more enforcement than exists. Project
scope - the folder an agent is meant to work in, the wallets attached to a project - is policy for
a well-behaved agent: nothing at the OS level stops a process running as you from reading outside a
project folder. What actually gates money movement is the approval card. A `restricted` project's
mutating call does not execute; it waits, `pendingApproval: true`, for a human decision in the Vex
app (`evaluateApprovalGate`, `src/vex-agent/tools/protocols/runtime/gates.ts:314-348`). A
`full` project executes directly under a standing grant the human made explicitly when they set
that permission, after seeing a consent strip that names the folder and wallets covered and states
the grant "can be undone... at any time"
(`vex-app/src/renderer/features/appShell/studio/projects/projects-copy.ts:69-114`). Full permission
is not a default posture; it is a deliberate standing grant the user makes project by project.

#### What model input can never redirect

No fee recipient, no destination override, no fee rate ever originates from a tool argument. On
the generic wallet-transaction lane and the pools.fun launch lane alike, the rate, the receiver, and
the gas ceiling are product-owner constants; a build fails if any tool exposes a fee-shaped
parameter at all (`src/vex-agent/tools/internal/wallet/transaction/vex-fee.ts:34-36` for the generic lane,
`src/tools/pools-fun/fee/venue.ts:21-22,40` and `src/vex-agent/tools/protocols/pools/manifests/launch-params.ts:9-18`
for the pools.fun lane, enforced by `fee-params-never-from-model.test.ts`). This is a refusal by name, not a filtered default: a
caller-supplied field that could redirect funds is rejected as invalid input, never silently
dropped or silently accepted.

#### Approval binds to an exact resource, and is checked again right before it fires

An approval is not a general permission slip. It binds to the exact tool, its critical arguments,
the actor, the project's scope version, and an expiry, compared byte for byte against a digest built
at the moment the human saw the card
(`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:284-312`). That
check runs a second time, deliberately, immediately before dispatch rather than only when the
request first arrived: if the project's permission or wallet selection changed, or the project
itself was deleted, while the approval sat waiting, the same short database transaction that claims
the dispatch slot re-reads the live project row and refuses the action as `scope_changed` or
`project_deleted` before anything runs
(`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:98-217`). That
re-check is fenced behind the same lock the project-delete and scope-edit code paths take first, so
an approved-but-undispatched action cannot slip through under authority that no longer holds by the
time it fires. The model or external agent never holds keys and never signs; it proposes, a human
decides in the app, and the app's own machine signs.

#### The one open question this document tracks

Stated plainly, without alarm: while your secret vault is unlocked, the vault-managed provider and
tool API keys you saved in Vex (things like an OpenRouter or a Jupiter API key) sit on the main
process's live environment for the life of that unlocked session, and a shell you or an agent opens
in a Vex Studio terminal inherits that environment nearly wholesale. The terminal host's own
scrub only strips four narrow patterns - Vex's own `VEX_*` variables, Electron's runtime markers,
and two Linux packaging leftovers - and none of the five vault secret names match any of them. A
command run in that terminal that reads its own environment will print a live vault key for as
long as the vault stays unlocked. This is not the same thing as wallet-key exposure: the wallet's
own signing key and the master vault password are each independently protected and never reach
that environment. It is a real, currently open gap in how far a Studio terminal's environment is
filtered, tracked here rather than resolved (see [What A Studio Terminal Can See: An Unresolved Question](#what-a-studio-terminal-can-see-an-unresolved-question)) and listed among this
document's open questions (see [Open Questions Requiring A Product Or Security Decision](#open-questions-requiring-a-product-or-security-decision)). It is not scrubbed, it is not closed, and it
should not be read as settled by anything in this section.


## Part 2 - Transport And The Bridge

### Where The Host Listens: Endpoint Derivation

Vex Studio's MCP host and the standalone `vex-mcp` bridge process are two
separate binaries that must agree, with no shared code and no configuration
file to read, on exactly where to rendezvous. Both derive the same endpoint
from the same facts: the platform, the process uid, and the realpath of the
Vex config directory. The config-directory input is derived by three
independent implementations against one shared golden-vector table: the TS
engine (`src/config/paths.ts`), the TS desktop app
(`vex-app/src/main/paths/config-dir.ts`), and the Go bridge
(`bridge/internal/configdir`) (`src/config/paths.ts:45-49`;
`bridge-endpoint-contract.md:103-106`). The endpoint hash and socket or pipe
name itself is computed by only two of those: the TS desktop app
(`vex-app/src/main/studio/mcp-host/endpoint.ts`) and the Go bridge
(`bridge/internal/endpoint`), against the same golden vectors
(`endpoint.ts:4-9`). The process uid enters later, only when the unix plan
selects a parent directory (`/run/user/<uid>` or the tmpdir fallback), and
never for the Windows pipe, which is hash-only (`endpoint.ts:277-279`,
`296`, `322`).

#### The discriminator

The socket file name and the Windows pipe name both derive from the same
12-character hex discriminator: the first 12 lowercase hex characters of a
SHA-256 hash over the exact UTF-8 bytes of the realpath of the config
directory, with no BOM stripping, newline handling, case folding, Unicode
normalization, or separator conversion applied (`endpoint.ts:167-169`;
`bridge-endpoint-contract.md:180-190`). If `realpath` fails, which happens on
a genuinely first run before the directory exists, the hash falls back to
the literal configured path instead (`listener.ts:203-209`). On unix, the
resulting name is `vex-studio-<hash>.sock`
(`endpoint.ts:172-174`); on Windows it is the named pipe
`\\.\pipe\vex-studio-<hash>` (`endpoint.ts:198-200`), built from the
identical discriminator so the two transports never diverge on discovery,
only on mechanism.

#### The unix `sun_path` bound

Every unix socket candidate, including an operator-supplied override, is
checked against a 103-byte limit on the full path (`STUDIO_SUN_PATH_MAX_BYTES`,
`endpoint.ts:51`) before it is ever returned as a plan. A candidate that
would not fit is refused with the code `path_too_long` and a message naming
the exact byte count over the limit, rather than silently truncated or bound
anyway (`endpoint.ts:324-326`, `340-343`, `386-388`, `430-437`). A pipe name
has no such bound: it is not a filesystem path (`endpoint.ts:274-279`).

#### Linux directory selection, and why the probe order is deliberate

On Linux, the host does not simply read `XDG_RUNTIME_DIR`. It first probes
`/run/user/<uid>` directly on the filesystem and only falls back to
`XDG_RUNTIME_DIR` when that probe fails (`endpoint.ts:291-317`). Both
candidates are held to the same privacy gate: the directory must exist, be
owned by the running uid, and carry no group or other permission bits
(`endpoint.ts:203-208`). This order was chosen to close a divergence measured
under WSLg: an MCP client can spawn the bridge with an environment that omits
`XDG_RUNTIME_DIR` entirely (Codex CLI does this), and on some WSLg
distributions a custom `XDG_RUNTIME_DIR` such as `/mnt/wslg/runtime-dir` is
visible to the desktop app but not to a scrubbed bridge process. Probing the
filesystem fact first, ahead of the environment variable, means both sides
land on `/run/user/<uid>` whenever it is private, which is the one fact both
processes can read identically regardless of what environment each was
launched with (`endpoint.ts:56-97`). A named residual remains open rather
than papered over: a machine with no private `/run/user/<uid>` and a custom
private `XDG_RUNTIME_DIR` that the launcher fails to pass through still
produces two different endpoints, because nothing both processes can read
describes that directory; the documented follow-up is a rendezvous file, not
another environment rung (`endpoint.ts:80-84`).

#### The tmpdir fallback

macOS always, and Linux when neither `/run/user/<uid>` nor `XDG_RUNTIME_DIR`
resolves to a private directory, fall back to a socket under
`<tmpdir>/vex-studio-<uid>/`, a directory the host creates itself at mode
0700 (`endpoint.ts:319-327` plans the path; `bind.ts:280-286` creates it at
mode 0700).

#### The override

`VEX_STUDIO_SOCKET` overrides the derived endpoint on every platform, but the
value is fully validated before bind and never used as a silent fallback path
(`endpoint.ts:32-40`, `267-271`). On a unix target, a value that looks like a
Windows pipe (`\\...`) is refused by name rather than handed to `listen` as a
literal filename (`endpoint.ts:355-364`). A unix override must be an absolute
path within the `sun_path` bound whose parent directory exists, is owned by
the running uid, and is exactly mode 0700 (`endpoint.ts:377-427`). On
Windows, the override must match named-pipe syntax (`endpoint.ts:365-374`,
`isWindowsPipePath` at `endpoint.ts:230-235`). Any validation failure refuses
host startup outright, by a named refusal code, with a message stating the
Vex Studio host did not start; it never quietly substitutes the derived path
(`endpoint.ts:32-40`).

| Refusal code | Trigger |
|---|---|
| `override_not_absolute` | unix override is a relative path |
| `override_pipe_on_unix` | override looks like `\\.\pipe\...` on a non-Windows target |
| `override_invalid_pipe` | Windows override does not match pipe syntax |
| `path_too_long` | candidate exceeds the 103-byte `sun_path` bound |
| `override_parent_missing` | override's parent directory does not exist |
| `override_parent_not_directory` | override's parent is not a directory |
| `override_parent_not_owned` | override's parent is owned by another user |
| `override_parent_mode` | override's parent is not exactly mode 0700 |
| `endpoint_ancestor_changed` | ancestor identity check at bind time fails |

(`endpoint.ts:121-130`)

### Binding The Unix Socket

Binding the Studio endpoint is the first place a local attacker or a plain
race could turn "clean up a leftover socket" into deleting or hijacking
something that is not Vex's. On Linux and macOS the sequence runs against the
filesystem; on Windows it does not run at all, because a named pipe is not a
filesystem entry (module doc, `vex-app/src/main/studio/mcp-host/bind.ts:18-27`).

The parent directory is proven safe before any decision is made about an
entry inside it: `prepareEndpointDirectory()` either creates the runtime
directory with an exclusive, non-recursive `mkdirSync(dir, {mode: 0o700})`, or
- on `EEXIST` - `lstat`s the existing entry (never `stat`, so a symlink is
never followed) and tightens the mode only after it has proven the entry is a
real directory owned by the current uid
(`vex-app/src/main/studio/mcp-host/bind.ts:221-260`, `bind.ts:280-332`).

`captureEndpointDirectoryChain(parentDir)` then pins every ancestor from the
filesystem root through the parent, recording `(dev, ino, kind)` for each
entry both lexically and by realpath, because a stable intermediate symlink
does not by itself prove its target chain was not replaced
(`bind.ts:91-135`). Any ancestor that cannot be `realpath`'d or `lstat`'d, or
that is neither a directory nor a symlink, refuses with
`endpoint_ancestor_changed`. That captured identity is re-verified four times
before the bind completes: at the entry of `clearStaleEndpoint()`, before any
unlink decision (`bind.ts:377`); again immediately before the `unlinkSync`
call (`bind.ts:397`); once more right before `server.listen`
(`listener.ts:344`); and a fourth time right after `server.listen` succeeds,
before the publication gate (`listener.ts:385`).

Stale-socket removal is never a blind unlink. `clearStaleEndpoint()`
(`bind.ts:373-408`) `lstat`s the endpoint path: absent means free to bind; an
entry that is not a socket refuses and is left in place. A present socket is
then probed for liveness by connecting to it with a 1 second ceiling
(`LIVENESS_PROBE_MS = 1_000`, `bind.ts:41`); both a successful connect and a
timeout count as LIVE, because a server that accepts and then goes silent is
still holding the path. A live endpoint refuses startup rather than being
removed, telling the user another running Vex already serves it. Only a
socket proven dead by that probe is `unlinkSync`'d, with the directory-chain
identity re-verified once more immediately beforehand (`bind.ts:397`).

After `server.listen` succeeds, the directory-chain identity is re-verified
once more (`listener.ts:385-389`). A generation re-check then gates
publication (`listener.ts:395`): on a stale generation the listener closes and
the socket is unlinked before anything is tightened or published. Only once
that gate passes does `chmodSync(0o600)` tighten the socket's own mode on top
of the `0o700` parent directory - belt and braces, since on Linux the socket's
own mode is enforced on connect (`listener.ts:414-420`). The phase then moves
to `listening` (`listener.ts:424`).

The module's own doc names a residual explicitly rather than claiming the
race is closed: Node exposes no descriptor-relative bind or unlink API
(no `openat2`/`renameat`), so a filesystem that removes and recreates an
entry with the same path, kind, device, and an immediately reused inode
between two checks is indistinguishable to this identity proof
(`bind.ts:85-89`). Holding open directory descriptors would close that gap;
Node does not expose the operations that would let it.

On Windows none of this runs. The front process (`vex-pipe-front`) creates
and supervises the pipe itself and reports back whether it created the pipe
or joined one that already existed (`firstInstance`), which answers the
stale-endpoint question from the operating system rather than a round trip
that can race (see [Windows: Why A Separate Process, And How It Proves Itself](#windows-why-a-separate-process-and-how-it-proves-itself)).

### Windows: Why A Separate Process, And How It Proves Itself

On Windows, the Studio MCP host does not bind the named pipe itself from the Electron main process. It spawns a dedicated Go child, `vex-pipe-front` (`bridge/cmd/vex-pipe-front/main_windows.go`), and hands ownership of the pipe to that child instead. The reason is not stylistic: libuv creates a pipe with a NULL security descriptor and without `PIPE_REJECT_REMOTE_CLIENTS`, whose default grants Everyone and the anonymous logon READ, so the packaged `vex-pipe-front` child owns the pipe instead and applies its own descriptor (`vex-app/src/main/studio/mcp-host/listener.ts:35-37`, `vex-app/src/main/studio/mcp-host/front-handshake.ts:97-108`). An earlier revision of the plan tried following VS Code's own named-pipe pattern (`createStaticIPCHandle`, plain `createServer().listen`, relying on the default Windows pipe security descriptor of Everyone-READ) directly (owner decision 2026-08-24; `src/vex-agent/tools/tool-surface-spec/studio-mcp/vex-studio-plan-v2.md:442-466`), but a review pass found that libuv creates a pipe with a NULL security descriptor and without `PIPE_REJECT_REMOTE_CLIENTS`, a gap VS Code's own pattern does not close, so the Windows transport was runtime-disabled behind `WINDOWS_TRANSPORT_PROVEN = false` until a CI proof matrix could show the alternative was safe, superseded 2026-09-03 once that matrix passed (`src/vex-agent/tools/tool-surface-spec/studio-mcp/vex-studio-plan-v2.md:514-540`). The Go child sidesteps the gap entirely: it owns the pipe under its own Windows security-descriptor and named-pipe handling instead of libuv's defaults.

Non-Windows builds of the same binary exit immediately with `ExitUnsupported` (2) rather than pretend to serve a platform they were not built for (`bridge/internal/front/lifecycle/exit.go:27-28`).

#### The pipe's security descriptor, and why the front checks its own work

`listener.Bind` creates the pipe with SDDL `D:P(A;;FA;;;<userSID>)(A;;FA;;;SY)`: a protected DACL with exactly two allow ACEs (the owning user, full access; `SYSTEM`, full access), and no deny ACE at all (`bridge/internal/front/listener/bind_windows.go:79-102`). The absence of a deny ACE is deliberate: an allow-list already excludes everyone not named, while a deny ACE sorted ahead of the allows can paradoxically deny the owner through an unpredicted group membership (`bridge/internal/front/listener/bind_windows.go:17-30`). Message mode is required, because byte mode would silently break the protocol's half-close semantics (`bridge/internal/front/listener/bind.go:60-67`).

The front does not trust that the SDDL string it requested is the SDDL the OS actually applied. After binding, it self-connects to the pipe it just created and reads back what the kernel produced (`readBackBinding`, `bridge/internal/front/listener/bind_windows.go:117-201`): it confirms the probe peer is itself (`verifyProbePeer`), that the descriptor is semantically exactly `[owner-FullAccess, SYSTEM-FullAccess]` with no inheritance flags (`verifyDescriptor`, `bridge/internal/front/listener/bind_windows.go:253-310`), that message mode is active (fatal if not, `readMessageMode`), and that reject-remote-clients is set: Windows documents no readback for `PIPE_REJECT_REMOTE_CLIENTS`, so a failed or absent `readRejectRemote` result is treated as unconfirmed rather than fatal, unlike message mode (`bind_windows.go:190-201`). The `Bound.FlagsApplied` bitfield the front reports back to the host carries only what runtime readback CONFIRMED, never what was merely requested (`bridge/internal/front/frames/types.go:280-284`). On the host side, a listener is published to the rest of Studio only when all three of `rejectRemote`, `firstInstance`, and `messageMode` come back confirmed (`vex-app/src/main/studio/mcp-host/listener.ts:450-467`, `vex-app/src/main/studio/mcp-host/front-handshake.ts:301-330`); a descriptor readback mismatch fails the bind closed and is not retried (`vex-app/src/main/studio/mcp-host/front-supervisor.ts:676-683`).

#### The HELLO handshake as a packaging fence, not a version negotiation

Before the pipe is even bound, the host sends `HELLO` down control plane 3 carrying six frozen equality fields, named by `bridge/internal/front/control/hello.go:36-41` and resolved to `protocolVersion=1` (`bridge/internal/front/frames/types.go:20`), `sddlKind=1` (`bridge/internal/front/frames/types.go:34`), `maxRaw=21` (`bridge/internal/front/listener/accept.go:22`), `creditBytes=65536` and `chunkBytes=32768` (`bridge/internal/front/credit/credit.go:30,33`), and `handshakeDeadlineMs=5000`, the one literal declared directly in `hello.go:41`. Any mismatch causes the front to refuse to serve and exit `ExitHelloRejected` (3) (`bridge/internal/front/control/hello.go:68-78`, `bridge/internal/front/control/supervisor.go:233-238`). These are not negotiated because main and front ship as one packaged unit; a mismatch here means the two binaries came from different builds, which is a packaging fault to be caught, not a protocol version to be reconciled (`bridge/internal/front/control/hello.go:20-31`). `PipeName` is checked for presence in the same message but is not one of the six frozen fields; it is dynamic per configuration directory, together with `InitialAdmissionEpoch` (`bridge/internal/front/frames/types.go:222-234`).

#### `WINDOWS_TRANSPORT_PROVEN`: one flag, backed by measurement

Both sides carry a constant named `WINDOWS_TRANSPORT_PROVEN`, set to `true` in the TypeScript host (`vex-app/src/main/studio/mcp-host/endpoint.ts:237-265`) and in the Go bridge (`bridge/internal/endpoint/endpoint.go:158-183`). The two flags are treated as one decision: a diff flipping one without the other is meant to be rejected on review (`bridge/internal/endpoint/endpoint.go:158-183`, comment). They are backed by a Windows CI job (`bridge-windows`, `windows-latest`) that creates a second, unprivileged local Windows account with a crypto-random, never-printed password and measures the pipe's actual behavior against it: cross-user duplex connection is denied, cross-user read-only connect is denied, reject-remote-clients is confirmed, and a foreign account attempting to squat the pipe name first is refused. Those runs are cited by run ID in both flag's own comments (`33646484002`, `33650332655`, `33663385959`; `.github/workflows/ci.yml:220-233`, and the crypto-random-password step at `.github/workflows/ci.yml:272-312`). Because the flag is now true, the earlier `windows_pending_platform_proof` refusal code is dead: no live code path can produce it, and the constant that once returned it no longer exists as a live constant in `endpoint.go` (`bridge/internal/endpoint/endpoint.go:129-134`).

#### Front restarts have a lifetime budget, not an unlimited one

If the front dies, the host's `FrontSupervisor` restarts it, but the budget is finite and does not reset on a successful restart: `FRONT_MAX_RESTARTS = 5`, checked with a `<=` comparison starting from a restart count of zero (`vex-app/src/main/studio/mcp-host/front-supervisor.ts:71-76`), which permits six restarts total across the original spawn, for seven forked child processes over the pipe front's lifetime. Once the budget is exhausted, the host status reports `front_restart_budget_exhausted`, one of the closed set of `StudioHostUnavailableCause` values (`vex-app/src/shared/schemas/studio.ts:51-119`), and the only remedy is a full restart of Vex itself, not another connection attempt.

### The Windows Data Plane: Multiplexing, Credit, And Half-Close

The Windows pipe front carries one named pipe but many logical MCP connections. Four planes share the front child's stdio: control-down (plane 3) and control-up (plane 4) carry admission, credit and close signaling; data-down (plane 5) and data-up (plane 6) carry the MCP JSON-RPC bytes in each direction. `FrontPlanes` owns the four streams and their decoders, built once per spawned front child (`vex-app/src/main/studio/mcp-host/front-planes.ts:107`). `FrontRelay` is the demultiplexer, constructed once per front generation, only after the `BOUND` control frame confirms Windows accepted the pipe's security descriptor - nothing is served on a generation whose security flags are unconfirmed (`vex-app/src/main/studio/mcp-host/front-relay-transport.ts:205`, `vex-app/src/main/studio/mcp-host/front-supervisor.ts:599-608`).

#### Admission

A connection begins with an `OPEN` frame on plane 4. A repeated connection id is a broken front, since ids are never reused within a generation, and fails the front (`front-relay-transport.ts:307-311`). Before any transport object is constructed, main's `refuseBeforeRead()` gets a chance to refuse outright: if it returns a string, main writes `REFUSE` with that exact line and the front never issues an OS-level read on the peer's pipe handle for that connection, so a locked host reads nothing from a refused peer (`front-relay-transport.ts:314-324`). Otherwise the connection is registered and an `ADMIT` frame is written carrying an admission epoch captured fresh at that exact tick, not cached, so a `LOCK` racing between capture and the front's read purges the admission on the front side rather than silently admitting under a stale epoch (`front-relay-transport.ts:355-358`). The connection is then granted its first full credit window (`front-relay-transport.ts:359`).

#### Credit and chunk size

Each connection gets a 65536-byte credit window per direction: the byte cap on outstanding, unacknowledged plane-5 writes, and the byte cap on spendable plane-6 read credit (`front-relay-transport.ts:649-656`, `:698-707`, `front-handshake.ts:71`). That figure is deliberately half the measured 131072-byte OS pipe buffer, so one connection filling its window cannot starve every other connection sharing the same pipe (`front-planes.ts:204`, `credit.go:23-27`). Data is chunked at 32768 bytes (`FRONT_CHUNK_BYTES`, equal to the wire-level `PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES`), and these two numbers - `creditBytes` and `chunkBytes` - are the ones actually sent to the front in the `HELLO` handshake, not merely asserted locally on the TS side (`front-handshake.ts:74`, `front-handshake.ts:212-213`).

#### The round-robin pump

Writes for all connections share plane 5, so `FrontRelay.pump()` enforces fairness: each pass snapshots the insertion-order rotation of connections and, starting from a rotation cursor, calls `writeOneChunk` once per live connection - at most one 32768-byte chunk per connection per pass. The cursor advances by one position per pass, not per chunk, so the next `pump()` call starts from a different connection (`front-relay-transport.ts:615-629`). `writeOneChunk` is also where credit is enforced: if writing the next chunk would push a connection's outstanding bytes past 65536, the write is skipped, a stall watch is armed, and the pass reports no progress for that connection (`front-relay-transport.ts:649-656`).

#### Acknowledgement, settlement, and drain

`WRITE_DONE` on plane 4 carries a cumulative `ackThroughSequence`. An ack that goes backwards, or names a sequence main never sent, fails the front as `ack_regression` (`front-relay-transport.ts:366-380`). A valid ack releases every unacked chunk at or below it and frees that many outstanding bytes, but a logical write - built from possibly several chunks - settles and its callback fires only once the ack covers its final sequence; an earlier ack releases window bytes without completing the write (`front-relay-transport.ts:401-407`). `drain` is a two-condition gate: it fires only when the write that had returned `false` has settled through this ack path **and** there is again room under the 65536-byte window; nothing else. The module's own comment states the reasoning directly: a `drain` raised early is worse than none (`front-relay-transport.ts:682-696`).

#### Half-close and delayed teardown

A local `end()` queues an `END` item behind any already-queued data chunks so it cannot overtake them, and costs no credit window itself (`front-relay-transport.ts:544-552`). A peer's own half-close arrives as `END` on plane 6: it marks the connection's readable side ended and emits `end` on the transport, but leaves the writable side untouched - a peer that stops sending is not asking to stop receiving (`front-relay-transport.ts:468-485`). `PEER_CLOSED`, the front's own signal that a connection is fully over, is different again: because control (plane 4) and data (plane 6) are two unordered pipes, its close edge is deliberately delayed until `planes.dataUpDelivered()` has caught up to the sequence `PEER_CLOSED` names, so the close cannot arrive ahead of in-flight response bytes still on plane 6 (`front-relay-transport.ts:413-427`, `:264-273`).

#### Credit-stall watch

If a write stays blocked on credit for 5000 ms, the relay logs one warning per connection, ever - the watch is diagnostic, never a teardown, and a connection that stalls and later recovers is still a working connection (`front-relay-transport.ts:749-773`, `FRONT_CREDIT_STALL_WARN_MS = 5000`).

#### An asymmetry worth naming

`duplicate_credit` and `write_window_exceeded` are named failures in the wire protocol, but neither string appears in `front-relay-transport.ts` or `front-planes.ts`. On the Go/front side they are enforced reactively, as a defense against a protocol-violating main (`bridge/internal/front/credit/credit.go:51,54`). On the TS/main side the same two invariants are enforced preventively by construction instead: `grantCredit` caps every grant at the 65536 window before writing it, and `writeOneChunk` never writes a chunk that would push outstanding bytes past that window - so main has no code path that could trigger either failure and correspondingly no code that detects them. This is a deliberate difference in trust posture, not a missing check.

### The Pipe-Front Wire Codec

The internal wire between the main process and the front (the pipe-front
transport that carries the Studio session) is a frozen v1 binary protocol,
not JSON. Every frame opens with a fixed 28-byte little-endian header:
`magic(u32)=0x46584556` (ASCII `VEXF`), `generation(u32)`, `connection(u32)`,
`sequence(u64)`, `type(u8)`, `flags(u8)`, `reserved(u16)`, `length(u32)`
(`bridge/internal/front/frames/decode.go:67-76`; mirrored in
`src/vex-agent/mcp/pipe-front-frames.ts:655-663`). The frame travels on one of
four planes, each a separate stdio stream: `controlDown=3` (main to front),
`controlUp=4` (front to main), `dataDown=5` (main to front),
`dataUp=6` (front to main) (`bridge/internal/front/frames/types.go:46-55`).

The frame body is a 21-member discriminated union on `type`
(`pipe-front-frames.ts:214-284`), split by direction and plane:

| group | members |
| --- | --- |
| control-down (main to front) | `HELLO, ADMIT, REFUSE, CREDIT, PAUSE, RESUME, CLOSE, LOCK, QUIT, PING` |
| control-up (front to main) | `HELLO_ACK, BOUND, OPEN, WRITE_DONE, PEER_CLOSED, LOCK_ACK, QUIT_ACK, PONG, ERROR` |
| data (either direction) | `DATA, END` |

Payload bounds differ by plane: 4096 bytes on a control plane, 32768 bytes on
a data plane (`PIPE_FRONT_CONTROL_PAYLOAD_MAX_BYTES`,
`PIPE_FRONT_DATA_PAYLOAD_MAX_BYTES`, `pipe-front-frames.ts:38-39`; same
values as `ControlPayloadMaxBytes`/`DataPayloadMaxBytes`,
`bridge/internal/front/frames/types.go:29-30`). The decoder's own retention
is bounded by construction: it stages only the 28 header bytes first,
validates the header including the plane's payload bound, and only then
allocates a payload buffer of exactly the declared length, so its buffers
never exceed 4124 bytes on a control plane or 32796 on a data plane during a
push (`pipe-front-frames.ts:710-713`).

This frame shape is implemented twice, independently, with no shared code:
`src/vex-agent/mcp/pipe-front-frames.ts` in TypeScript and
`bridge/internal/front/frames/` in Go. Both codecs are run against one
shared golden-vector fixture (`pipe-front-vectors.json`), so a divergence
between the two languages' encode/decode behavior fails the fixture rather
than surfacing only at runtime (`pipe-front-frames.ts:6-8`;
`bridge/internal/front/frames/types.go:3-5`).

Malformed framing is terminal at the decoder. Because a framing fault leaves
the position in the byte stream unknown, the decoder latches the failure,
drops its buffers, and returns nothing from every later push; there is no
resynchronization and no skipping ahead to look for the next valid frame.
The caller's only remedies are to kill the front (from main's side) or exit
(from the front's side) (`pipe-front-frames.ts:715-719`). The closed set of
malformed reasons includes `bad_magic`, `flags_set`, `reserved_set`,
`unknown_type`, `type_not_on_plane`, `bad_generation`, `sequence_exhausted`,
`sequence_gap`, `length_over_bound`, `connection_zero`, `connection_not_zero`,
`empty_data`, `payload_length_mismatch`, `string_over_payload`,
`invalid_utf8`, `generation_zero`, `sddl_kind`, `peer_closed_reason`,
`bound_flags_reserved`, and `error_code` (`pipe-front-frames.ts:288-308`).

### Connecting: Handshake And Admission

Vex first checks whether it can serve anyone at all (admission); only if that
passes does the connection cross a small typed handshake, which is itself
followed by one more narrow admission-adjacent check (project existence)
before the ack. The admission check decides whether Vex is in a state to
serve anyone at all; the handshake decides whether the two sides agree on
protocol and project.

#### The handshake line

Once the bridge (`vex-mcp`) dials Vex's local socket or named pipe, it sends
one line of JSON: `{"v":1,"projectId":"<uuid>"}\n`
(`bridge/internal/handshake/handshake.go:100-103`, `EncodeRequest`; the same
literal format also appears in the host's malformed-handshake message at
`vex-app/src/main/studio/mcp-host/handshake.ts:74-76`). Vex answers with one
line back: `{"ok":true}` on success, or `{"ok":false,"code":"...","message":"..."}`
on refusal (`handshake.ts:145-152`). A conforming bridge waits for that ack
before sending MCP traffic; Vex tolerates one that does not - any bytes
coalesced with the handshake line in the same TCP segment are preserved as a
remainder and only acted on once the connection reaches `serving`
(`handshake.ts:9-17`). The handshake line is capped at 4096 bytes and must
complete within 5 seconds; a connection that never finishes a line by then is
refused and dropped (`STUDIO_HANDSHAKE_MAX_BYTES`, `STUDIO_HANDSHAKE_DEADLINE_MS`,
`handshake.ts:29-33`). The parser itself never reads a clock; the 5-second
timer is armed by the connection object at construction
(`vex-app/src/main/studio/mcp-host/connection.ts:305-314`). The bridge
enforces the same 4096-byte bound on the ack it reads and the same 5-second
`AckDeadline` while waiting for it, so neither side can hang on the other's
silence (`bridge/internal/handshake/handshake.go:27-35`).

#### The five refusal codes

A refusal is a closed set of five codes, not a bare connection close:

| Code | Meaning |
|---|---|
| `unknown_project` | The project id in the handshake was not found. Explicitly non-authoritative: it only rejects handshakes for a project that plainly does not exist, and is not relied on for anything downstream (`handshake.ts:156-165`). |
| `incompatible_version` | The `v` field names a protocol major Vex does not speak; the refusal names the version Vex does support (`handshake.ts:120-129`). |
| `locked` | Vex is locked, starting, or otherwise not in the `ready` admission state (`mcp-host.ts:373-377`, `admission.ts:50-57`). |
| `at_capacity` | One of the connection or handshake-pending bounds is full (`mcp-host.ts:224`, `mcp-host.ts:390`). |
| `malformed` | The line was not valid JSON, failed the `v`/`projectId` schema, exceeded the byte bound, or timed out (`handshake.ts:117-119`, `handshake.ts:132-134`). |

(`StudioHandshakeRefusalCode`, `handshake.ts:35-41`). The same Go bridge that
opens the connection switches on this exact code set, so it is a wire
contract shared by both sides, not an internal detail.

#### Admission bounds

Four numeric bounds constrain Studio's capacity, but they are not one
sequential check: the raw listener cap is enforced by Node itself, at TCP
accept time, before any of Vex's own connection-handling code runs
(`server.maxConnections`, `listener.ts:357`); admission and the
handshake-pending bound are checked next, once a socket Node has already
accepted reaches `handleConnection` (`mcp-host.ts:373-392`); the
established-connection bound is reserved once the handshake line parses to a
syntactically valid project id, before that id's existence is checked
(`connection.ts:465-491`); and the global in-flight bound is unrelated to connection
admission - it is checked only per tool call, by `acquireCallSlot`, well
after a connection is already serving (`mcp-host.ts:396-401`).

| Bound | Limit | Where enforced |
|---|---|---|
| Handshake-pending connections | 4 | `mcp-host.ts:383-391`, `STUDIO_MAX_HANDSHAKE_PENDING`, `bounds.ts:17` |
| Established connections | 16 | reserved synchronously before any await, so a race cannot admit a 17th; `bounds.ts:14`, `mcp-host.ts:216-227`, `connection.ts:482-489` |
| Global in-flight tool calls | 32 | `STUDIO_MAX_INFLIGHT_GLOBAL`, `bounds.ts:20` |
| Raw listener sockets | 21 (16 + 4 + 1 overflow) | `STUDIO_MAX_LISTENER_SOCKETS`, `bounds.ts:23-33` |

The raw socket cap is one more than the two connection bounds combined. Node's
own `maxConnections` mechanism drops an over-limit socket with no bytes
written, which would look like an unexplained close rather than the typed
`at_capacity` ack the wire contract promises. The extra socket exists purely
so the 21st connection gets far enough to be refused properly and closed,
never so that a 22nd connection is admitted (`bounds.ts:21-31`).

#### A locked host reads nothing

If Vex is not in the `ready` admission state (locked, still starting, or
shutting down), the connection is accepted at the transport level but nothing
is read from it: a typed `locked` refusal is written immediately and the
connection is closed before a single byte of the handshake is parsed, no
project identifier ever travels in either direction, no established-connection
slot is claimed (`vex-app/src/main/studio/mcp-host.ts:23-33`), and it stops
counting as handshake-pending immediately (`mcp-host.ts:360-366`); the refusal
itself runs through `connection.ts:337-368`. Vex starts locked at boot
regardless of whether the listener is bound; binding the socket does not by
itself open the door (`mcp-host/admission.ts:81`, `admission.ts:12-15`). As
long as Studio's raw-socket ceiling (21) is not already exhausted, the bridge
always gets an honest, typed reason instead of a bare `ECONNREFUSED`; beyond
that ceiling a connection attempt is silently dropped exactly like
`ECONNREFUSED`, by design (see the bounds section above).

#### The project check is not remembered

The handshake's project-existence check happens once (`connection.ts:501-507`),
and is explicitly non-authoritative: its result is discarded the moment the
ack is sent, because `runStudioCall` loads the authoritative scope atomically
on every single call (`connection.ts:17-22`). No scope decision from the
handshake is cached or reused. Every subsequent tool call reloads the
caller's real project scope fresh from an atomic snapshot at call time, so a
project deleted, renamed, or changed after the handshake cannot leave a call
running against stale authority (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)).

Once past both checks, the connection is marked `serving` and MCP traffic
begins to flow (`connection.ts:521`).

### One Tool Call, Wire To Wire

An external agent's `tools/call` reaches one handler per tool, installed by `registerStudioTool` (`src/vex-agent/mcp/server.ts:240`). The handler mints `toolCallId = studio-<uuid>`, reads the requesting client's name from the MCP handshake (best-effort, swallowed on throw, `server.ts:231-237`), and builds `RunStudioCallOptions`: an abort signal, a `cancelCause` closure, the optional client name, and a guarded `onProgress` callback (`server.ts:259-289`). This object, plus `{name, args, toolCallId}`, is handed to `deps.runCall` inside a try/catch boundary (`server.ts:305-332`). `deps.runCall` is `runStudioCall` (`vex-app/src/main/studio/approval-service.ts:98`), the one owner of the atomic per-call scope snapshot: it re-reads project scope and wallet resolution fresh on every call, including a read-only `vex_ToolSearch`, so nothing about the call's authority is cached across the connection's lifetime.

Inside `runStudioCall`, `executeStudioTool` builds a least-privileged `InternalToolContext` and calls `admitStudioCall` (`src/vex-agent/mcp/admission.ts:161`), which resolves the requested name into exactly one of four lanes:

| Lane | Trigger | What runs |
|---|---|---|
| `ToolSearch` / `ToolDescribe` | name matches the exported search or describe adapter | `runExportedToolSearch` / `runExportedToolDescribe`, read-only, `admission.ts:174-182` |
| Exported internal tool | `getToolDef(name)` resolves and `isExportedInternalTool` passes | `dispatchTool`, the same in-app dispatcher gates, `admission.ts:188-198` |
| Exported protocol tool | `resolveInjectedProtocolTool(name)` resolves and `isExportedProtocolTool` passes | `executeProtocolTool` with a `studio_mcp` execution context, `admission.ts:201-223` |
| Typed refusal | internal name not exported, protocol manifest withheld, unknown name, or the internal approval-resume envelope name | `notExportedRefusal` / `protocolNotExportedRefusal` / `unknownToolRefusal`, `admission.ts:184-186, 189-191, 202, 210-215` |

The protocol-tool and internal-tool export checks read the same enumerator that `tools/list` and `vex_ToolSearch` use, so a manifest the export scope withholds can never be reached by name even if the caller already knows it (`admission.ts:189, 210-215`, `export-scope.ts:107-137`).

While a call is parked waiting on a human approval decision, progress notifications fire only if the caller sent a `_meta.progressToken` on the request; with no token, no frame is written at all, because the SDK does not suppress a token-less progress notification and would otherwise emit a spec-invalid frame (`server.ts:24-28, 270-289`). The interval is fixed at `DEFAULT_PROGRESS_INTERVAL_MS = 2_000` (`vex-app/src/main/studio/approval-broker.ts:420`), and every frame carries the same fixed sentence, "Waiting for a person to decide this action in Vex." (`server.ts:281`).

A throw out of `deps.runCall` is caught at this one boundary before it can reach the SDK's own `tools/call` wrapper, which would otherwise put `error.message` verbatim on the wire. The cause's text is never logged; only a closed three-member classification (`aborted | error | non_error`, `server.ts:184-191`) is recorded, and the call is answered `studioHandlerFailureResult` (`server-result.ts:118`), an UNRESOLVED / DO NOT RETRY result, since a throw proves nothing about whether the underlying action ran (`server.ts:296-304, 331`).

Cancellation distinguishes two owners. `ctx.mcpReq.signal` aborts either because the SDK raised its own `SdkError(SdkErrorCode.ConnectionClosed)` on transport teardown, or because the peer sent an MCP `notifications/cancelled`. `isConnectionClosedAbort` checks the SDK's brand plus its error code (`server.ts:152-155`); when it is not a connection-closed abort, the cause is always `"cancelled"`, and the client's own cancellation reason string is never read (`server.ts:170`). When it is a connection-closed abort, `typedCancelCause` asks the connection owner's `cancelCause()` closure, falling back to `"disconnect"` on any throw (`server.ts:166-176`). `StudioCancelCause` is a closed, owner-set union of four members: `cancelled | disconnect | lock | vex_quit` (`src/vex-agent/mcp/outcome.ts:88`), each set only by the teardown that decided it, never derived from anything a client sent.

At the wire layer, errors the transport itself produces (`JSON.parse` failures, an SDK schema-rejection payload) are reduced before they ever reach a log line or cross back to the peer. `StudioWireErrorCode` is a closed five-member set: `line_too_long | invalid_json | queue_overflow | socket_error | sdk_wire_error` (`src/vex-agent/mcp/wire-errors.ts:34-40`); the catch-all `sdk_wire_error` exists specifically because an SDK-raised error's message can quote the offending payload, so only the code is logged and the message text is discarded.

(see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)) covers the approval detour that a mutating call under `restricted` permission takes between admission and its final `CallToolResult`.

### Lock, Quit, And Reconnect

Vex Studio's transport (the local listener a coding agent connects to) and its
authority to serve calls (admission) are two separate lifecycles. Locking Vex
closes admission but leaves the transport bound; only quitting the app closes
the transport itself. This split is what lets a locked Vex answer "you are
locked" instead of dropping the connection outright.

#### Locking

Admission starts locked at process boot, fail closed, before anything opens it
(`vex-app/src/main/studio/mcp-host/admission.ts:80-81`). When you lock Vex,
`lockStudioMcpHost` advances an internal epoch counter synchronously, before
any teardown work runs (`vex-app/src/main/studio/mcp-host.ts:437-441`,
`vex-app/src/main/studio/mcp-host/admission.ts:106-123`). That ordering
matters: any connection already in the middle of being accepted under the old
epoch is stale from that line on and cannot slip through and reach "serving"
state, no matter how its pending awaits resolve later. Every open connection
is then destroyed synchronously (`mcp-host.ts:443-449`).

The listener itself is not touched by a lock. It stays bound, and the next
peer that connects gets a typed "locked" refusal rather than a connection
error (`mcp-host.ts:432-436`). That refusal is one fixed sentence, read here
verbatim: "Vex is locked, so it will not serve MCP calls. Nothing was executed
and no funds moved. Unlock Vex and connect again."
(`vex-app/src/main/studio/mcp-host/admission.ts:46-48`, used at `admission.ts:93`).
Unlocking reopens admission on the same socket or pipe; there is no rebind and
no new endpoint.

The epoch that backs this fencing is a 32-bit counter with a hard ceiling of
`0xffffffff`. If a process locks and unlocks enough times to reach it,
admission is permanently closed for the rest of that process's life
(`admission.ts:78`, `115-121`). Unlocking again does not clear this state; the
only remedy is closing Vex and starting it again.

#### Quitting

Quit runs one fixed teardown sequence, and the order is enforced by a test
that reads the source files rather than trusting convention: host shutdown,
then a durable sweep that records the refusal reason for every pending call,
then approval-broker disposal, then poison-retry disposal. The test checks
this order for all four steps, and additionally checks exact-once
registration for two of them, the host shutdown and the broker disposal
(`vex-app/src/main/studio/__tests__/quit-ownership.test.ts:15-71`,
`vex-app/src/main/index.ts:391-422`). The reason this order is load-bearing:
disposing the approval broker releases every call still waiting on a person's
decision, and if that ran before the durable refusal write finished, a waiter
could be told "refused" before anything durable actually recorded why.

#### Crash and reconnect

If the process crashes mid-lock or mid-quit, the pending refusal is not lost.
The database row `studio_runtime_gate` carries `pending_refusal_reason` (lock
or vex_quit) and `pending_refusal_since`, written in the same database update
that advances the dispatch generation, so a crash cannot separate the two
(`vex-app/resources/migrations/092_studio_pending_refusal_repair.sql:1-9`).
On the next startup, this row is repaired before Vex Studio is allowed to
accept any calls (`vex-app/src/main/studio/approval-refusals.ts:69-75`,
`vex-app/src/main/agent/studio-settlement-bridge.ts:320,338`).

Two other restart surfaces sit on top of this same general lifecycle, and both
share the same "restart budget never resets" shape:

| Surface | Cap | Resets on success? | Past the cap |
|---|---|---|---|
| Windows pipe-front (helper process) | 6 restarts | No | typed unavailable status, restart Vex |
| PTY (terminal) host | its own max-restarts bound | No | typed unavailable status (`host_unavailable`), restart Vex |

(`vex-app/src/main/studio/mcp-host/front-supervisor.ts:71-76`,
`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:171-174`,
`vex-app/src/main/studio/pty-host-starter.ts:16,25-27,266-271`). Every
in-flight request is answered `host_unavailable`, not left hanging, whenever
the PTY host process exits, restart attempted or not
(`pty-host-starter.ts:234-241`). A restarted
Windows front runs on a new generation but keeps the same epoch: restarting
the helper process is a transport event, not an authority event, so it cannot
reopen admission by itself (`front-supervisor.ts:32-39`).

### The vex-mcp Bridge Binary

`vex-mcp` is the small Go binary an external MCP client (Claude Code, Codex CLI, Cursor, or any
other stdio MCP client) spawns to reach Vex Studio. It bridges that client's stdin and stdout to
the Vex Studio host over an endpoint the client cannot reach on its own: a unix domain socket on
Linux and macOS, a named pipe on Windows (`bridge/cmd/vex-mcp/main.go:1-9`).

You never configure this binary directly. It reads only its own flags and environment, re-derives
the connection point itself from platform convention, dials it, performs a short handshake, then
relays bytes verbatim in both directions. There is no configuration file to parse and no retry
logic anywhere: every way it can fail is terminal for that attempt. A refusal the host sent, or a
local decision the bridge made about the endpoint, has already been decided; asking again only
repeats the answer, so the calling client decides whether to reconnect, not the bridge
(`bridge/cmd/vex-mcp/main.go:10-18`).

#### Startup: how it finds Vex

The bridge accepts `--project <uuid>`, or falls back to `VEX_PROJECT_ID`. The value is validated as
a UUID before anything else happens; an invalid or missing project id fails immediately with exit
code 1 and never attempts a connection (`bridge/cmd/vex-mcp/main.go:79-84,183-210`).

With a valid project id, the bridge works out where Vex Studio is listening using the same
platform-convention logic the Vex app uses to bind that endpoint, so both sides land on the same
path without either one telling the other. On Windows it always targets a named pipe. On Linux it
first checks whether `/run/user/<uid>` is a private, user-owned directory, and only falls back to
`XDG_RUNTIME_DIR` if that fails; on macOS, or Linux without a private runtime directory, it falls
back to a per-user temp directory (`bridge/internal/endpoint/endpoint.go:292-343`). An operator can
override this with `VEX_STUDIO_SOCKET`, validated strictly rather than reinterpreted: a `\\`-prefixed
value is refused on non-Windows targets, and on unix the override path must be absolute with a
parent directory owned by the current user and set to exactly mode 0700
(`bridge/internal/endpoint/endpoint.go:356-421`).

#### The dial and the handshake

On Windows, a foreign process could in principle pre-create a pipe under the predictable name the
bridge is about to dial. Before writing a byte to the pipe, the bridge authenticates the process
actually serving it by resolving that process's user SID and comparing it to its own. Any failure
to resolve either SID, or any mismatch, is a refusal, and the resulting message reports only the
foreign process's PID, never its identity, since the whole point is that this is someone else's
process (`bridge/cmd/vex-mcp/hostauth_windows.go:106-129`). This is a local decision, not a dial
failure, so it exits with its own distinct code.

Once connected, the bridge writes a one-line JSON handshake carrying its protocol version and the
project id (`bridge/internal/handshake/handshake.go:35,100-103`), then waits up to 5 seconds for a
one-line JSON acknowledgement. A successful ack hands the relay any bytes the host already sent past
the ack's newline, so nothing typed ahead of time is lost (`bridge/internal/handshake/handshake.go:193-229`).
A refusal ack carries one of a closed set of codes (unknown project, incompatible version, locked,
at capacity, malformed) (`bridge/internal/handshake/handshake.go:66-71`), each mapped to its own
exit code; an unrecognized code still exits non-zero rather than crashing, so a newer host can add a
refusal reason without breaking older bridges (`bridge/cmd/vex-mcp/main.go:346-364`).

#### Exit codes

Exit 0 covers a clean relay end and the bridge printing its own usage text. Every other outcome is
one of twelve distinct failure classes, so a supervising client can tell "Vex is locked" from "that
project is gone" without parsing English (`bridge/cmd/vex-mcp/main.go:42-56`):

| code | meaning |
| --- | --- |
| 0 | clean: relay ended cleanly, or `--help` was shown |
| 1 | bad flags, missing, or invalid project id |
| 2 | the bridge itself refused the endpoint (bad override, changed directory, Windows host-auth mismatch) |
| 3 | the OS-level dial failed (not running, refused, wrong permissions, timed out) |
| 4 | the handshake itself failed to complete or parse |
| 5 | host refused: unknown project |
| 6 | host refused: incompatible protocol version |
| 7 | host refused: locked |
| 8 | host refused: at capacity |
| 9 | host refused: malformed handshake |
| 10 | host refused with a code this bridge build does not recognize |
| 11 | the relay itself failed mid-session (stdout or socket error) |
| 12 | the process was stopped by a signal |

#### Every failure prints exactly one line

Whatever goes wrong, the bridge writes exactly one stderr line, prefixed `vex-mcp: `, and the whole
line, prefix, sanitized message, and trailing newline together, is bounded at 512 bytes total. That
bound covers the complete line actually written, not just the message body, after an earlier version
undercounted and emitted 522 bytes from a nominal 512-byte bound
(`bridge/internal/handshake/handshake.go:39-56`). Text the Vex Studio host supplies is
peer-controlled and is sanitized: control characters, including embedded newlines, become spaces so
a hostile or buggy host message cannot forge extra log lines, and invalid UTF-8 becomes the
replacement character. When the host's message would not fit the remaining budget, the bridge never
silently cuts it; it keeps as much as fits and names exactly how many bytes were left out, for
example `[N more bytes omitted from a M-byte host message]`
(`bridge/internal/handshake/handshake.go:275-334`).

#### Shutdown is asymmetric, on purpose

The relay copies bytes in both directions concurrently, and the two directions end differently
because they mean different things. If the client's stdin reaches end of file first, the client is
done talking, not the session: the bridge closes only the write side (a real half-close on a unix
socket; a Windows named pipe has no half-close, so the connection stays fully open instead) and
drains whatever the host still has to send, up to 5 seconds, because responses to requests already
sent are still in flight (`bridge/internal/relay/relay.go:1-27,77-85`). If that drain bound is reached
before the host closes its side, the bridge reports it rather than staying silent and still exits
cleanly; the wording depends on whether the transport supports a real half-close
(`bridge/internal/relay/relay.go:236-242`, `bridge/cmd/vex-mcp/main.go:368-386`). If instead the
socket reaches end of file first, the Vex Studio host is gone: the bridge closes stdout immediately
and returns without waiting for the stdin reader, which is otherwise parked reading input that may
never arrive again, exactly the hang this asymmetry exists to prevent
(`bridge/internal/relay/relay.go:204-212`).

This section does not describe the Windows pipe-busy-timeout retry loop in `bridge/cmd/vex-mcp/dial_windows.go`
(the `ERROR_PIPE_BUSY` wait behind exit code 3's "timed out" case) or the `windows_pipe_dial_interrupted`
refusal code declared in `bridge/cmd/vex-mcp/refusal.go:71`; both exist in the bridge but were not
opened and traced in this writing pass, so no claim about their exact behavior is made here.

### Windows Dial-Time Security: SQOS And Host Authentication

On Windows, `vex-mcp` dials the Studio named pipe with `CreateFile` and two
security flags set on the handle: `FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION`
(`bridge/cmd/vex-mcp/dial_windows.go:248`). A Windows named pipe is
first-come: the pipe name is derived deterministically from a hash of the
config directory, so any process on the machine could create
`\\.\pipe\vex-studio-<hash>` before Vex does and become the server this
client connects to (`bridge/cmd/vex-mcp/dial_windows.go:112-119`). Without an
explicit security quality of service, a client `CreateFile` handle to a pipe
grants the server impersonation rights over the caller. `SECURITY_SQOS_PRESENT`
makes the impersonation-level flag effective and `SECURITY_IDENTIFICATION`
caps that level: the server may read the client's SID and privileges for an
access check, but cannot impersonate the client (`dial_windows.go:120-140`).
SQOS is necessary but not sufficient on its own: it bounds what a hostile
squatting server can do with the client's token, but it does not identify who
the server is.

Host authentication is the control that answers that second question. The
production server-SID resolver, `resolveServerUserSID`, calls
`GetNamedPipeServerProcessId` to get the pipe server's process id, opens that
process's token, and reads its user SID (`bridge/cmd/vex-mcp/hostauth_windows.go:135-159,176-199`).
`authenticatePipeHost` (`hostauth_windows.go:105-132`) is the comparison that
consumes the result through this resolver seam: it compares that SID to the
current user's own SID as canonical strings; any failure along the way,
including an inability to resolve either SID, is treated as a refusal, never
a pass. This proves the server runs as the current user, not that it is Vex:
a different program running under the same account that squats the pipe name
first still passes this check, which is out of scope for a boundary whose
whole subject is the other user (`hostauth_windows.go:32-35`). This check
runs inside `dialPipeWithin`, on the raw `syscall.Handle`, strictly before
that handle is wrapped with `os.NewFile` into something the rest of the
process can write to (`bridge/cmd/vex-mcp/dial_windows.go:194,204-211`). On
refusal the raw handle is closed immediately and nothing the process holds,
including the project id that would otherwise open the handshake, ever
reaches the pipe (`dial_windows.go:207-209`).

A refusal from this check is a local decision, not a transport failure: it is
represented as a `localRefusal` and mapped to exit code 2 (`exitEndpointRefused`),
the same family as other refusals, never exit code 3 (`exitDialFailed`),
which this bridge also uses for a pipe that stayed busy for its whole dial
budget and for an interrupted wait, not only for the operating system
reporting the endpoint unreachable (`bridge/cmd/vex-mcp/refusal.go:8-16,39-46,73-83`,
`bridge/cmd/vex-mcp/main.go:136-139`). The resulting message names the
foreign server only by its pid, never its identity, under refusal code
`windows_host_not_current_user` (`hostauth_windows.go:120-129`, refusal code
constant at `:76`). This check is
exercised in CI against a real second local account
(`TestHostAuthRefusesAForeignUsersServer`, `bridge-windows` run `33646484002`,
`hostauth_windows.go:37-44`).


## Part 3 - The Tool Surface

### The Exported Tool Surface

Everything a coding agent can call through Vex Studio's MCP server comes from one array, rebuilt fresh for every Studio connection rather than memoized once at module load for the whole process: each call to `createStudioMcpServer` invokes `buildStudioInventory()` and registers every tool onto the SDK's `McpServer` through the local `registerStudioTool` wrapper, which calls `server.registerTool`, and the SDK then serves `tools/list` from that already-registered set for the life of the connection (`src/vex-agent/mcp/inventory/index.ts:139-150`; `src/vex-agent/mcp/server.ts:195-209,240-245`). The factory can run twice for a single connection - a modern `server/discover` probe followed by a legacy `initialize` fallback - but never once per `tools/list` call (`src/vex-agent/mcp/server.ts:1-14`). As measured on this tree, that array holds **213 tools**: 29 internal tools plus 184 protocol tools spread across 12 protocol namespaces (`src/__tests__/vex-agent/mcp/inventory.test.ts:144-149`). The internal 29 is the hot set, the always-loaded tools whose descriptions ship in full on every connection: the wallet, swap, bridge, token-lookup, chain-read, twitter, and units-conversion tools, the two Lighter onboarding shortcuts (`lighter_core_onboarding_status`, `lighter_rhc_onboarding_status`), plus the in-app `ToolSearch` registry tool re-exported as `vex_ToolSearch` under a narrower, search-only description and input schema through its own read-only adapter, and `vex_ToolDescribe`, the one tool that exists only for this exported surface, assembled directly in the inventory rather than registered as an in-app tool (`src/vex-agent/mcp/inventory/titles.ts:26-55`; `src/vex-agent/mcp/inventory/index.ts:104-116,146-160`). Memory and session-bound tools (session narrative recall, mission lifecycle, plan mode) are exactly the group excluded from this surface, not part of it (`src/vex-agent/mcp/export-scope.ts:41-56`).

The 184 protocol tools cover khalani, kyberswap, uniswap, relay, solana, dexscreener, lighter, virtuals, pendle, morpho, pools, and launchpads. The catalog itself registers 185 manifests across those namespaces; exactly one, `launchpads.images` (listing the desktop app's local, in-process image locker), is withheld because an external Studio agent has no locker for that tool to list (`src/vex-agent/mcp/export-scope.ts:79-96`). Its sibling, `launchpads.image_publish`, used to be withheld for the same reason but was un-excluded on 2026-09-06 once it was redesigned to take a project-local file path through the same contained, size-bounded reader a launch already uses (`src/vex-agent/mcp/export-scope.ts:89-96`).

#### Read-only versus destructive

Every tool carries two MCP hints, `readOnlyHint` and `destructiveHint`, and nothing else - `idempotentHint` and `openWorldHint` are deliberately left unset rather than defaulted (`src/vex-agent/mcp/inventory/types.ts:41-61`). Across the 213 exported tools, 129 are read-only and 63 carry the destructive hint (`src/vex-agent/mcp/inventory/annotations.ts:39-49`; `exported-tools.md` Totals). Both hints are derived strictly from a tool's `actionKind`: `readOnlyHint` is true only when `actionKind === "read"`, and `destructiveHint` is true only for the two irreversible kinds, `user_wallet_broadcast` and `destructive` (`src/vex-agent/mcp/inventory/annotations.ts:9-19,39-49`). Neither hint is ever derived from the coarser in-app `mutating` flag, because a tool can be `mutating` (it writes something) without being destructive - a wallet-transaction preparation step, or a local-write tool that stages a launch without signing anything - and deriving the hint from `mutating` would trip an MCP client's irreversible-action warning on a call that signs nothing.

These hints are advisory only. The approval decision for anything that can move funds stays inside Vex's own privileged executor regardless of what a client's tool picker shows.

#### One gate, checked from every direction

A single predicate decides what this surface exports: `isExportedInternalTool` for internal tools, `isExportedProtocolTool` for protocol tools (`src/vex-agent/mcp/export-scope.ts:1-20,106-137`). Three consumers all call the same predicate: `listExportedTools`, which builds `tools/list`; `searchExportedTools`, which backs `vex_ToolSearch`; and `admitStudioCall`, the runtime dispatch chokepoint that routes every incoming `tools/call` by name. This is checked in both directions by test: a tool that appears in `tools/list` can always be dispatched, and a tool `admitStudioCall` can dispatch always appears in `tools/list` and in search results. The protocol side of that check was not always this careful - a code comment records that the protocol re-check inside `admitStudioCall` used to be missing, which meant a withheld manifest such as `launchpads.images` would have been absent from every listing while still fully dispatchable by name if a caller guessed it: a fail-open that the current re-check closes (`src/vex-agent/mcp/admission.ts:204-215`).

#### What `tools/list` looks like across connections

The exported surface is stateless and connection-invariant by design: `tools/list` never varies by project, permission level, client capability, or which protocol provider API keys happen to be configured. A tool whose provider key is missing still appears in the list; it carries `requiresEnv` metadata naming the missing variable and answers `configuration_unavailable` only when actually called (`src/vex-agent/mcp/inventory/index.ts:41-45`). `requiresEnv` values are variable names only, never values. This statelessness matches the MCP 2026-07-28 requirement that `tools/list` must not vary by connection state, and it is proven by a test suite that flips every gated environment variable on and off and asserts the same tool list both ways.

#### How the count got here

The exported total has moved repeatedly as the tool surface changed, and each move is a name-checked test change rather than a silent renumber (`src/__tests__/vex-agent/mcp/inventory.test.ts:93-141`): 155, then 159 (four generic transaction-signing tools), 165 (the dexscreener namespace's public-API tools replaced by an 18-tool website-API surface), 167 (a native/wrapped-native pair), 168 (`vex_ToolDescribe` added), back to 167 (`WebResearch` removed - every client already has its own web search), up to 171 (two pools.fun read tools and two Virtuals market-history reads), 174 (a Virtuals bonding-curve trade pair, the first signing tool that namespace ever exported), 176 (two pools.fun holder-reward mutations), 180 (the Virtuals agent-launch family of four tools), then down to 170 when the entire Trench Express protocol was retired in migration 108, deleting ten tools, back up to 171 when `launchpads__image_publish` was un-excluded on 2026-09-06, and finally to **213 current** when the Lighter integration added 40 protocol tools and two always-loaded onboarding shortcuts on 2026-09-07. A landing-site figure of 167 tools (27 internal plus 140 protocol) reflects an earlier point in that history and is stale against the current code.

Source for the current figure: `src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md` Totals (`exported tools: 213`, `internal: 29`, `protocol: 184 across 12 namespaces`).

### Protocol Namespaces And What They Cover

Every protocol tool Vex Studio exposes belongs to one of 12 namespaces, each a fixed prefix on the tool's public name (`<namespace>__<resource_action>`, for example `khalani__bridge_quote_get`) (`src/vex-agent/tools/protocols/types.ts:207` grammar; `src/vex-agent/tools/protocols/khalani/manifest.ts:232` example). The list is an allowlist, not a convention: a namespace exists only if it has a row in `PROTOCOL_NAMESPACE_ALLOWLIST`, and the current 12 rows are `khalani`, `kyberswap`, `uniswap`, `relay`, `solana`, `dexscreener`, `lighter`, `virtuals`, `pendle`, `morpho`, `pools`, `launchpads` (`src/vex-agent/tools/protocols/catalog.ts:53-66`).

The 12 namespaces carry 185 tool manifests between them, of which 184 are exported to an external Studio agent; the withheld one is a locker listing (`launchpads.images`) that only makes sense for the in-app agent, which has a local image locker an external client never has (`src/vex-agent/mcp/export-scope.ts:79-96`). The measured breakdown, per namespace:

| Namespace | Manifests | What it covers |
| --- | --- | --- |
| khalani | 9 | Cross-chain bridging |
| solana | 34 | Solana-side swaps and lending (the largest namespace) |
| kyberswap | 4 | EVM swap aggregation |
| uniswap | 2 | Direct Uniswap swaps |
| relay | 2 | Cross-chain bridging, including the only route to/from Robinhood Chain, which khalani does not cover |
| dexscreener | 18 | Market data, pairs, and token discovery |
| lighter | 40 | Perpetuals and spot on Lighter Core and Robinhood Chain: market and account reads, order create including OCO protection, cancel, modify, cancel-all, position close, deposit, withdraw, claim, trading-key registration and fee authorization |
| virtuals | 13 | Bonding-curve agent-token trades and launches |
| pendle | 29 | Fixed-term yield markets (PT/YT) |
| morpho | 19 | Lending markets |
| pools | 13 | The pools.fun bonding-curve launchpad: launches, holder rewards, launch-asset reads |
| launchpads | 2 | Shared cross-launchpad plumbing: staged-image publishing to a public content-addressed URL, used by both pools.fun and Virtuals launches |

Counts are the measured manifest totals for this tree, not a hand count.

Sources: `src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md` (Totals block and the per-tool table, regenerated by `pnpm generate:studio-tools-doc`) for the exported figures; `src/__tests__/eval/live-catalog.ts:50` (`PINNED_LIVE_CATALOG_TOOL_COUNT = 185`) for the manifest total. `launchpads` holds only 2 manifests because it deliberately owns nothing venue-specific: a launch itself is each venue's own contract, fee model, and verifier, and stays with that venue's namespace; `launchpads` owns only what is true of a launch on any launchpad, which today is the shared image locker and its publish tool (`src/vex-agent/tools/protocols/launchpads/manifest.ts:1-13`). Of its 2 manifests, `launchpads__image_publish` is exported and `launchpads__images_list` (the locker listing) is withheld for the same external-agent reason as above.

An earlier `trench` namespace, described in older material as "launchpad and trading (RBC)" with 10 tools, no longer exists. Migration 108 retired the Trench Express protocol entirely and deleted all ten `trench__*` tools; `launchpads` is not a rename of that namespace but a structurally different one, built around shared publish plumbing rather than a venue's own trading surface (`src/__tests__/vex-agent/mcp/inventory.test.ts:129-132`). Any reference to a `trench` namespace or a "Trench Express" protocol pill describes a stale build; the current allowlist has no such row (`src/vex-agent/tools/protocols/catalog.ts:51-63`).

The 184 exported protocol manifests, together with 29 internal tools, make up the 213-tool exported surface (see [s2-tool-surface](#s2-tool-surface)) (`src/__tests__/vex-agent/mcp/inventory.test.ts:144-149`).

### vex_ToolSearch And vex_ToolDescribe

An MCP client that connects to Studio gets one `tools/list`, but two of its rows are not ordinary tools. `vex_ToolDescribe` is the one exported tool with no in-app `ToolDef` at all; it is assembled directly in the inventory module because a client cuts a description at 2048 characters and the whole-contract reader has to be a tool call (`src/vex-agent/mcp/inventory/index.ts:71-93`). `vex_ToolSearch` does have an in-app `ToolDef` (the registry tool named `ToolSearch`); the inventory looks it up like any other internal tool and then swaps in its own exported description and input schema, because the in-app tool documents a `select:` mode this surface refuses by name (`src/vex-agent/mcp/inventory/index.ts:146-163`, `src/vex-agent/mcp/export-scope.ts:74`). Both are read-only and both only ever read the same inventory the surface already publishes; neither can start a swap, a bridge, or any other call.

#### vex_ToolSearch

`vex_ToolSearch` finds a tool by intent. `admitStudioCall` recognizes it before any registry lookup and routes to `searchExportedTools`, which parses exactly `query`, `namespace`, or `limit` (`src/vex-agent/mcp/admission.ts:161,174,188`, `src/vex-agent/mcp/tool-search-export.ts:322-336,203-281`). Exactly one of `query`/`namespace` is required; sending both, sending neither, or sending an out-of-range `limit` is refused by name rather than guessed or clamped. The in-app `ToolSearch` tool also has a `select:` mode that writes discovered tools into a session's working set; on the exported surface that prefix is refused outright with `SELECT_REFUSAL`, because every exported tool is already in `tools/list` and there is no working set to write into (`src/vex-agent/mcp/tool-search-export.ts:203-281`). The call passes no `sessionId` to the underlying discovery engine, so nothing about it is ever recorded anywhere - this contrasts directly with the in-app lane's `recordDiscoveredTools`, which does mutate a session-scoped set (`src/vex-agent/mcp/tool-search-export.ts:322-336`, module header `1-29`).

Query mode ranks candidates over an embedding search (`denseScore`) with a lexical fallback if the embedding lookup or database fails, plus a guarantee that an exact tool-id match always surfaces (`src/vex-agent/tools/protocols/discovery.ts:431,437`, `src/vex-agent/tools/protocols/dense-score.ts:20,63-87`, `src/vex-agent/mcp/tool-search-export.ts:322-336`). Namespace mode instead lists a whole protocol namespace, unranked. Every row coming back is re-filtered through the same `isExportedProtocolTool` predicate `tools/list` itself uses; a row the ranking engine would return but the exported surface withholds (currently only `launchpads.images`, `src/vex-agent/mcp/export-scope.ts:102-104`) is pulled out and named in a `warnings` string, never silently dropped (`src/vex-agent/mcp/tool-search-export.ts:302-314,340-352`). `totalCount` can run slightly high in that case (a withheld row ranked below the current cutoff is not subtracted), documented as a known, bounded imprecision, never as an unbounded undercount (`src/vex-agent/mcp/tool-search-export.ts:360-369`). A surviving row whose provider environment variable is unset still appears, marked `available: false` with the variable's name, never its value (`src/vex-agent/mcp/tool-search-export.ts:288-295,338-352`).

#### vex_ToolDescribe

`vex_ToolDescribe` returns one tool's whole contract. It takes exactly one argument, `name` (the input schema requires it and forbids anything else, and any other argument key is refused by name), and strips a leading `mcp__vex__` prefix so a name copied straight out of a client's own tool list still resolves (`src/vex-agent/mcp/tool-describe-export.ts:106-107,582-585`, `:199-204,71`). An unknown name is refused with up to eight nearest-name suggestions rather than a guess (`src/vex-agent/mcp/tool-describe-export.ts:214-229,601-609`). On a hit, the answer carries the tool's whole, uncut description and character count, its whole input schema, its action kind and derived risk level, its quote-gate shape (gated, ungated, or venue-resolved-per-call), and its Vex fee fact (`src/vex-agent/mcp/tool-describe-export.ts:579-644`). The fee fact is always one of three states: known and charged (with the basis-points figure and when it is taken), known and not charged (with a reason), or unknown (with a reason) - a read-classified tool's "not charged" state is derived, never authored, and an unauthored fee on a tool that can spend is never read as free (`src/vex-agent/mcp/tool-describe-export.ts:503-530,563-571,110-125`).

The Studio overview page on the landing site currently documents only `vex_ToolSearch`; it never mentions `vex_ToolDescribe` exists at all, even though the tool has shipped as an MCP-only export since the surface grew from 167 to 168 entries (`src/__tests__/vex-agent/mcp/inventory.test.ts:99`) [see s13-stale-landing-claims for the full gap].

### Admission And Dispatch Routing

Every incoming `tools/call` on the `studio_mcp` transport passes through one function,
`admitStudioCall(call, context)` (`src/vex-agent/mcp/admission.ts:161-225`), the runtime dispatch
chokepoint: nothing reaches a tool handler by any other path.

#### Name resolution and the five branches

`admitStudioCall` first resolves a possibly-retired internal name through `resolveToolName`, the
same single-hop, idempotent resolver `dispatchTool` calls again downstream, so the export decision
made here and the dispatch decision made later see the identical name (`admission.ts:172`). A
retired PROTOCOL name is not rewritten at this step; its identity is the dotted toolId, resolved
later by the catalog lookup (`admission.ts:165-171`). From there the function decides among five
outcomes, in this order:

| Order | Match | Route |
|---|---|---|
| 1 | `vex_ToolSearch` (or bare `ToolSearch`) | `runExportedToolSearch`, read-only, never the in-app lane (`admission.ts:174-176`) |
| 2 | `vex_ToolDescribe` | `runExportedToolDescribe`, has no `ToolDef`, answered before any registry lookup (`admission.ts:178-182`) |
| 3 | `execute_tool` (`EXECUTE_TOOL_ENVELOPE_NAME`), the internal approval-resume envelope | refused by name with `notExportedRefusal`, never even a registry lookup (`admission.ts:184-186`) |
| 4 | an exported internal `ToolDef` (`getToolDef(name)` resolves) | `dispatchTool`, unchanged (`admission.ts:188-199`) |
| 5 | an exported protocol `publicName` (or a retired alias the catalog resolves) | `executeProtocolTool` with the `studio_mcp` execution context (`admission.ts:201-224`) |

Branch 3 refuses `execute_tool` unconditionally by name, before any registry lookup runs - this is
the internal approval-resume envelope that the Studio caller must never invoke directly, and it is
a distinct refusal from branch 4's leaked-session-tool refusal below: `execute_tool` has no
`ToolDef` export status to check, it is simply not a name Studio callers are ever allowed to name
(`admission.ts:184-186`).

Branch 4: a call resolving to an internal `ToolDef` is refused with `notExportedRefusal` when
`isExportedInternalTool(name)` is false (a session-bound tool that leaked into a call), otherwise
it passes a static-configuration check and is handed to `dispatchTool` exactly as the in-app agent
calls it (`admission.ts:188-198`) - so every in-app gate keyed off `context` fires identically for
a Studio call and an in-app agent call.

Branch 5: `resolveInjectedProtocolTool(name)` looks the manifest up in the catalog; an unresolved
name gets `unknownToolRefusal`, pointing the caller at `vex_ToolSearch` (`admission.ts:201-202`).
If the manifest resolves, the code re-checks `isExportedProtocolTool(manifest.toolId)` even though
the manifest already resolved (`admission.ts:210-215`) - the fail-closed check for a manifest
registered in the catalog but withheld from the export scope (currently `launchpads.images`). The
comment at this site records the check used to be missing, which let a withheld manifest be absent
from every listing yet still fully dispatchable by name: a fail-open the one-enumerator-predicate
invariant now prevents (`admission.ts:204-209`; the same predicate gates `tools/list` and
`vex_ToolSearch`, so no surface can advertise a tool this branch refuses). Only after that recheck
passes does a second static-configuration check run and the call dispatch through
`executeProtocolTool`, with `toProtocolExecutionContext(call, context, "studio_mcp")` tagging the
execution context with the `studio_mcp` discriminator - the same function the in-app agent calls
(`admission.ts:217-224`).

#### Mutating alias routers

Four names are registered in `MUTATING_PROTOCOL_ALIAS_ROUTERS`: `SwapExecute`,
`SwapExecuteUniswap`, `BridgeExecute`, `BridgeExecuteRelay`
(`src/vex-agent/tools/mutating-aliases.ts:508-513`). All four are internal `ToolDef`s, but the
dispatcher runs them through a dedicated branch rather than `routeInternalTool`, so a router's
target resolution happens before the target's own prequote gate rather than through the internal
mutating-approval gate first (`mutating-aliases.ts:1-14`).

`SwapExecute` and `BridgeExecute` are true venue routers: they classify the call
(`classifySwapFamily` for swaps, `mutating-aliases.ts:168`; a live-registry-based venue check for
bridges) and can resolve to a different target toolId per call. `SwapExecuteUniswap` and
`BridgeExecuteRelay` are fixed-target aliases: `FIXED_MUTATING_ALIAS_TARGETS` maps them
unconditionally to `uniswap.swap.execute` and `relay.bridge` (`mutating-aliases.ts:73-76`).
`fixedTargetOfMutatingAlias(name)` is the lookup `vex_ToolDescribe`'s quote-gate answer uses so
these two are described through their fixed target's own gate, never as `venue_resolved_per_call`
- a contract the code's own comment says used to ship incorrectly for these two names
(`mutating-aliases.ts:78-85`, `src/vex-agent/mcp/tool-describe-export.ts:289-317`).

Each router validates its args with a Zod `.strict()` schema that rejects any unknown key,
including legacy synonyms like `side` or `recipient`. On the bridge routers, `recipient` is refused
by name because the destination is always the project's selected wallet on the destination chain,
never a caller-supplied address (`mutating-aliases.ts:317-330,366-370`). `BridgeExecute` also
refuses `referrer` and `referrerFeeBps` by name through `findCallerSuppliedForbiddenParam`
(`mutating-aliases.ts:359-364`, `KHALANI_FORBIDDEN_FEE_PARAMS` in `src/tools/khalani/request.ts:103`),
since they would redirect a referral fee to an arbitrary address that Vex never derives from model
input. `routeId` and `depositMethod` are absent from the `BridgeArgs` schema entirely: they are
execute-only Khalani knobs with no quote counterpart, so the bridge auto-selects its own route and
`.strict()` rejects either key as unknown before parsing starts
(`mutating-aliases.ts:298-300,311-317`). `BridgeExecute` also refuses Khalani-bound `slippageBps`
by name, since Khalani exposes no slippage tolerance (`mutating-aliases.ts:372-376`).

Branch 4 and branch 5 both terminate in the exact dispatcher the in-app agent uses -
`dispatchTool` for internal tools, `executeProtocolTool` for protocol tools - so a Studio MCP
caller cannot reach weaker gating than the in-app agent gets for the same tool. The mutating-alias
routers add venue resolution ahead of that chokepoint, not a bypass of it: the router's chosen
toolId still enters `executeProtocolTool`'s prequote gate, approval gate, and capture in order
(`mutating-aliases.ts:340-346`).

### What Never Leaves The App

Vex's exported tool surface is deliberately smaller than its in-app one. One exclusion list per tool kind, internal and protocol, is checked consistently by the listing and the dispatcher, and, for protocol tools, by the search tool too, so nothing one surface advertises can be refused by another (`src/vex-agent/mcp/export-scope.ts:113-137`). Everything withheld is withheld for a named reason, not by omission.

#### Session and memory-bound tools

Missions, plan mode, session narrative recall, and the long-term memory surface are agent-session concerns: they are bound to the lifecycle of a live Vex agent session and have no meaning to an external client that has no such session (`src/vex-agent/mcp/export-scope.ts:45-58`). The Model Context Protocol also requires a `tools/list` that does not vary by connection state, which a session-bound tool cannot honestly satisfy (`src/vex-agent/mcp/export-scope.ts:6-11`). Only the export is withheld: the module imports only read-only lookups into the tool registry and protocol catalog (`src/vex-agent/mcp/export-scope.ts:30-31`), and everything it exports, the exclusion sets, the name constants other modules match against, and the predicate and listing functions, is a read-only lookup or a name constant, never a registration call, so nothing about how these tools run in-app changes (`src/vex-agent/mcp/export-scope.ts:39,45,74,102,113-161`).

#### WebResearch

`WebResearch` is withheld because every MCP client that connects (Claude Code, Codex CLI, Gemini CLI, and equivalents) already carries its own web search and fetch. Exporting a Tavily-keyed duplicate would cost a key the user does not need and add roughly 2 KB to every session's context for a capability the client already has. The tool itself is unchanged for the in-app Vex agent, which has no client-side search of its own (`src/vex-agent/mcp/export-scope.ts:65-70`).

#### The approval-resume envelope

`execute_tool` is Vex's internal approval-resume envelope, never a callable tool in its own right. Admission refuses it by name before any registry lookup even runs, so it never reaches the point where a real tool would be resolved (`src/vex-agent/mcp/admission.ts:184-186`). The refusal names the real cause and points the caller at `vex_ToolSearch` instead of returning a generic unknown-tool answer (`src/vex-agent/mcp/admission.ts:74-85`).

#### The local image locker

`launchpads.images`, which lists pictures staged inside the desktop app's local image locker, is withheld because an external Studio agent has no locker of its own and no way to stage one; exporting a listing that would always come back empty would advertise a capability guaranteed to refuse. Its sibling, `launchpads.image_publish`, was withheld for the same reason until it was redesigned on 2026-09-06 to take a project-local `imagePath` instead, read through the same contained, no-follow reader a Studio launch already uses (`src/vex-agent/mcp/export-scope.ts:77-104`), which refuses a file that is not a PNG, JPEG or WebP under 2 MiB (`src/vex-agent/tools/protocols/launchpads/manifests/image-publish.ts:45`), behind the same approval question. Once the tool could satisfy the capability it advertised, it was un-excluded.

Because one predicate gates the listing, the search tool, and the dispatcher together, a withheld protocol manifest cannot be resolved and dispatched even if a caller already knows its exact name: admission re-checks export status immediately before execution and refuses it there too (`src/vex-agent/mcp/admission.ts:204-215`).

### The Hot Set And Description Budget

The Vex Studio MCP server exports 213 tools, but a connecting client does not load all 213 descriptions into context at handshake. Only 29 load eagerly (`_meta["anthropic/alwaysLoad"]`); the remaining 184 are protocol tools across 12 namespaces (khalani, kyberswap, uniswap, relay, solana, dexscreener, lighter, virtuals, pendle, morpho, pools, launchpads) that a client discovers on demand (`src/vex-agent/mcp/inventory/index.ts:146-207`, `src/__tests__/vex-agent/mcp/inventory.test.ts:144-149`). The hot set is exactly the internal tool registry (which now carries the two Lighter onboarding shortcuts) plus `vex_ToolSearch` itself (an internal tool under its exported name) plus `vex_ToolDescribe`, the one MCP-only row that reads a tool's full contract; a test enumerates this membership and asserts the hot set stays under half the total surface, so a hot set that quietly grew past the internal registry fails a named test rather than degrading silently (`src/__tests__/vex-agent/mcp/inventory.test.ts:335-357`).

This split exists because tool-selection accuracy measurably degrades once a session holds more than roughly 30 to 50 tool descriptions at once, an empirical bound the owner cites from the Anthropic Tool Search research behind the O20 exposure-model decision, not a number Vex measured itself (`src/vex-agent/tools/tool-surface-spec/studio-mcp/mcp-landscape-2026.md:137`). Rather than build a custom search facade in front of a narrowed tool list, the shipped design exports every protocol manifest as a real MCP tool under a `<namespace>__` prefix and lets a client's own on-demand discovery (`vex_ToolSearch` to find a tool by intent, `vex_ToolDescribe` for its whole contract) pull in a description only when the agent actually needs it.

#### The description budget

Two different bounds apply depending on whether a tool is in the hot set.

| Scope | Bound | Enforcement |
| --- | --- | --- |
| Hot-set description (27 tools) | 2048 characters AND 2048 UTF-8 bytes, both checked separately, whole text | `ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS = 2048` (`src/vex-agent/mcp/inventory/types.ts:39`); asserted in `src/__tests__/vex-agent/mcp/inventory.test.ts:422-506` |
| Protocol description (184 tools) | Unbounded overall; risk class and preconditions must appear in the first 2000 bytes | `src/__tests__/vex-agent/mcp/inventory.test.ts:369-420` |

The 2048-character bound is measured, not chosen: Claude Code was observed cutting an MCP tool description at exactly 2048 characters of the original string and appending a truncation marker, confirmed across four independent counts on four different tools, each time losing the tail of the description (the `RETURNS` section, on six always-loaded tools) (`src/vex-agent/mcp/inventory/types.ts:16-38`). Because the client does the cutting, the hot set is authored to fit whole rather than shipped to be cut. The bound is checked in both units because the hot set is not pure ASCII: `SwapExecute` and `SwapQuote` carry a U+2192 arrow, landing at 2045 characters and 2047 UTF-8 bytes, one byte under the limit, so a character-only check would have missed a byte overflow on a non-ASCII edit (`src/vex-agent/mcp/inventory/types.ts:26-33`).

Protocol tools, discovered only after a client's own search step, are not re-truncated by any client once loaded, so their descriptions carry no whole-text cap. What they must still do is front-load risk: a destructive protocol tool's description states its irreversible consequence (a spend, a broadcast, an approval gate) inside its first 2000 bytes, and every tool states a precondition or usage rule in that same window, both lint-checked against concrete phrase markers rather than left to convention (`src/__tests__/vex-agent/mcp/inventory.test.ts:369-420`).

#### The handshake instructions string

Separately from tool descriptions, the MCP handshake sends one `instructions` string once, at connect. It is capped at 2000 bytes total (owner decision O23), with a safety prefix - the funds-are-real lead line plus the three numbered rules for approval, quote-first and per-field amount units - that is self-contained within the first 512 characters, because a client that only shows or forwards the head of `instructions` must still receive the whole approval rule (`src/vex-agent/mcp/instructions.ts:39-71`). Both bounds are lint-gated in `src/__tests__/vex-agent/mcp/instructions.test.ts`.

The safety prefix and the usage-notes tail are authored once as named constants in `src/vex-agent/studio/instructions/shared-usage.ts:1-90` and composed both into the handshake `instructions` string and into the `AGENTS.md` managed block the Studio installer writes into a user's project (see [The Files A Project Gets](#the-files-a-project-gets)). Neither consumer restates the other's wording; both import the same constants, so the repo file an agent reads later and the handshake text it received at connect cannot say two different things about approval, amounts, or what a truncated description means.

### What A Fresh Connection Is Told

The first thing an agent receives when it connects to the `vex` MCP server is not a tool result, it is the handshake's `instructions` string, `STUDIO_MCP_INSTRUCTIONS`. It has two parts joined by a blank line: a safety prefix, then usage notes (`src/vex-agent/mcp/instructions.ts:64-65`).

The safety prefix must stand on its own inside the first 512 characters, because a client that shows or forwards only the head of `instructions` still needs the whole rule set (`src/vex-agent/mcp/instructions.ts:6-10`, `STUDIO_SAFETY_PREFIX_MAX_CHARS = 512` at `src/vex-agent/mcp/instructions.ts:68`). It states plainly that Vex moves real funds, nothing here is a sandbox or testnet, then three numbered rules: approval blocks a destructive call in a restricted project and the result an agent gets back is the settled outcome, never call again while one is unanswered and never retry an unknown outcome; quote before any swap, bridge, trade or lend; and amounts are per field, human decimals or raw smallest units, read the field description rather than guessing (`src/vex-agent/studio/instructions/shared-usage.ts:42-58`).

The usage notes that follow tell the agent how to find and call a tool: every tool is already in `tools/list`, `vex_ToolSearch` finds one by intent and is read-only, `vex_ToolDescribe` returns a tool's whole contract, and a client that shows deferred tools (Claude Code shows protocol tools as `mcp__vex__<publicName>`) should be called by the name that client displays (`src/vex-agent/studio/instructions/shared-usage.ts:82-89`). Further notes cover truncation, per-field amount units, that project permission and wallet selection are read fresh on every call, what an unmet provider key answers, and how to bucket a result word into nothing-happened, happened, or unknown (`src/vex-agent/studio/instructions/shared-usage.ts:100-137`). The whole composed string is capped at 2000 bytes and is never truncated to fit; exceeding the cap fails a test rather than being cut at delivery (`STUDIO_INSTRUCTIONS_MAX_BYTES = 2000` at `src/vex-agent/mcp/instructions.ts:71`; measured on this tree at 1976 bytes).

The safety rules and most of the usage notes (finding tools, truncation, amounts, project scope, unavailable tools) are embedded verbatim in both the handshake and the `AGENTS.md` managed block from the same named constants, `STUDIO_SAFETY_RULES`, `STUDIO_USAGE_AMOUNTS`, `STUDIO_USAGE_FINDING_TOOLS`, `STUDIO_USAGE_PROJECT_SCOPE`, `STUDIO_USAGE_TRUNCATION` and `STUDIO_USAGE_UNAVAILABLE_TOOLS`, that the Studio installer imports individually (`src/vex-agent/studio/instructions/project-brief.ts:61-67`). Neither side holds its own copy of that wording, so the handshake and the file on disk cannot come to say different things about approval, amounts, finding tools, truncation or project scope; a future edit changes one source and both consumers pick it up. Outcomes are the exception: the handshake carries the short bucket sentence `STUDIO_USAGE_ERRORS` (nothing-happened, happened, or unknown), while `AGENTS.md` carries a longer, differently worded table with a per-word retry verdict, rendered from the same underlying vocabulary data by `renderStudioOutcomeVocabulary()` (`src/vex-agent/studio/instructions/shared-usage.ts:135-137,396-416`, called at `src/vex-agent/studio/instructions/project-brief.ts:469`) rather than sharing one literal string.

Separately from the handshake, Vex writes `.vex/protocols.md` into every Studio project and refreshes it on every Vex update. It is generated, not hand-authored, and is a full offline table of the whole exported surface, currently 213 tools (29 internal, 184 protocol tools across 12 protocols), each row naming its read-only and destructive hints and the environment variable it needs, without argument contracts or descriptions, which stay on each tool's own `tools/list` entry (`src/vex-agent/tools/tool-surface-spec/studio-mcp/protocols.md:1-59`). An agent can read this file directly, without spending a tool call, to see the whole catalog before it ever calls `vex_ToolSearch`.


## Part 4 - Approvals: The Money Gate

### Project Permission And Wallets

Every Vex Studio project carries a permission level and up to two wallet selections, and this pair is the authority every approval decision in the project is built on. Permission is one of two values, `restricted` or `full` (`sessionPermissionSchema`, `vex-app/src/shared/schemas/sessions.ts:47-48`). Wallets are held separately per chain family: at most one EVM wallet and at most one Solana wallet, each either a selected `{ id, address }` or `null` (`ProjectScopeWallet` and the `wallets` field of `projectScopeSchema`, `src/vex-agent/mcp/project-scope.ts:25-32,47-52`). A `null` family means no selection; the design rule is stated in this same file's header comment (`src/vex-agent/mcp/project-scope.ts:16-19`), and the actual fail-closed enforcement lives in `resolveSelectedEntry`, which throws `WALLET_NOT_SELECTED` on a null selection rather than falling back to some other "primary" wallet the user happens to have elsewhere (`src/tools/wallet/multi-auth.ts:106-131`). A newly created project starts `restricted` (`ProjectCreator.tsx:130,158`); nothing defaults to `full`.

#### What restricted and full actually change

In a `restricted` project, reads, quotes, and local writes run without stopping - nothing about permission touches them. The gate that matters is `evaluateApprovalGate`; its condition tests several things together - the manifest is mutating, its `actionKind` is not `local_write`, the call is not already approved, it is not a preview execution, the session permission is `restricted`, and the launch form has not already replaced the approval card - and a call blocks on the card only when all of them hold (`src/vex-agent/tools/protocols/runtime/gates.ts:314-332`). When such a fund-moving call is attempted, it does not execute: the MCP call blocks, an approval intent is written durably, and the desktop app's approval card is where a person decides. This is the same gate whether the call came from an in-app agent session or an external Studio MCP client: `evaluateApprovalGate` has one call site, inside the client-agnostic `executeProtocolTool` orchestrator (`src/vex-agent/tools/protocols/runtime.ts:311`).

In a `full` project, that same mutating call skips the card and dispatches directly, under what the code calls a standing permission: the user's standing permission is the authority, and a destructive call executes directly with no approval card (`src/vex-agent/studio/instructions/project-brief.ts:286,300`). That standing permission is granted knowingly - the consent strip the user checks before turning a project `full` states plainly that agents in this project will be able to act outside its folder and use its wallets (`vex-app/src/renderer/features/appShell/studio/projects/projects-copy.ts:71`). Everything else about the call is unchanged - the same fresh scope snapshot (see the scope section below, `approval-service.ts:176-182`), the same requirement that the secret vault be unlocked to sign (`src/vex-agent/studio/instructions/project-brief.ts:303`) - only the human-in-the-loop step is removed, and it is removed because the user removed it in advance, not because the agent inferred it was safe to skip.

Turning a project to `full` requires more than flipping a setting. The creator and the settings editor both show a full-access consent strip first (`FullAccessConsent.tsx:57-93`, `projects-copy.ts:69-115`): a statement that agents in this project will be able to act outside its folder and use its wallets, the folder path, the wallets currently selected (or a note that any wallet chosen later is covered too), and a note that the choice can be undone later. The primary action stays disabled until the user checks a required box reading "I understand that agents in this project can act outside its folder and can use its wallets." (`projects-copy.ts:114-115`; enforced as `consentMissing` folded into `submitDisabled` and the submit button's `disabled` prop, `ProjectCreator.tsx:183-184,395`). That checkbox is never saved as a standing "don't ask again" preference: it is dropped the instant the proposal changes - any edit to the permission or wallet selection clears it, so the user re-acknowledges before the change goes through (`ProjectCreator.tsx:198-200,323,334,338`; `ProjectSettingsDialog.tsx:216-220,316-325`).

#### Scope is read fresh, never cached

The project's permission and wallet selection - together its scope - is not read once per connection and reused. It is loaded fresh, from one atomic snapshot, on every call the MCP client makes, including `vex_ToolSearch` (`loadProjectScopeSnapshot`, `vex-app/src/main/studio/approval-service.ts:182`). The code states its own reasoning: a connection-time cached scope would be a stale authorization cache, rejected outright (`approval-service.ts:176-181`). If the user edits permission or wallet selection while a call is already on its way in, the enqueue step compares the scope version the call was admitted under against the project's current scope version and refuses the mismatch, rather than letting the call proceed under authority that no longer holds (`src/vex-agent/mcp/approvals.ts:197-205`). The same discipline extends past enqueue: an approval already granted, but not yet dispatched, is re-checked against the project's live scope version and existence at commit time, so an approved-but-undispatched action can never dispatch under a permission or wallet selection the user has since changed - it is refused instead. If the project itself was deleted in that window, the same commit-time check refuses the action as `project_deleted` (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:168-215`).

#### How this is framed to the agent

Full permission is described to the connected agent as something the user already granted knowingly, in the project's own settings - never as a state the agent may infer, escalate into, or treat as implied consent from a prior successful call. The brief text a full-permission agent receives reads, in part: "The user chose full access knowingly, in Vex's project settings. Do not ask the user for permission before a transaction and do not add a confirmation step of your own." A restricted-project agent is told the opposite: every destructive call - a user-wallet broadcast or another irreversible effect - waits until a person answers the approval card, and the card's answer is the confirmation; the agent does not ask again in chat. The brief names execute, confirm, deposit, withdraw, borrow, repay, claim, and launch tools as a rule of thumb for what counts as destructive, and points the agent to the `destructive` column of `.vex/protocols.md` as the exact list rather than treating the named tools as exhaustive; the same range also carries the instruction shared by both permission levels: run the quote first and restate its amounts, fees, price impact, and ETA before calling execute (`src/vex-agent/studio/instructions/project-brief.ts:293-333`).

### How A Mutating Call Becomes An Approval

This section traces one call end to end: an MCP client sends a mutating protocol call over Studio
into a restricted project, and Vex turns it into a durable, decidable approval row before anyone
has clicked anything.

#### Where the gate fires

`evaluateApprovalGate` (`src/vex-agent/tools/protocols/runtime/gates.ts:314`) is the function that
decides whether a call becomes an approval at all. It runs after admission, before dispatch, and
its condition is a single conjunction, not prose:

| Condition | Meaning |
|---|---|
| `manifest.mutating` | the tool changes state or moves value |
| `manifest.actionKind !== "local_write"` | `local_write` is the one action kind exempted from the gate |
| `!context.approved` | this is a first attempt, not a resumed dispatch after a human decision |
| `!isPreviewExecution(...)` | not a dry-run/simulation call |
| `context.sessionPermission === "restricted"` | the project's live permission, re-derived from the freshly loaded scope on every attempt |
| `!launchFormReplacesApprovalCard(...)` | the launch-form carve-out does not apply |

(`gates.ts:330-332`). `ActionKind` is a required field on every `ToolDef`
(`src/vex-agent/tools/taxonomy.ts:54-64`) with seven members: `read`, `local_write`, `schedule`,
`approval_prepare`, `user_wallet_broadcast`, `destructive`, and `external_post`; the last two are
gated like any other mutating action, with no carve-out of their own beyond the `local_write`
exemption (`gates.ts:330`).

The only carve-out in that condition is `launchFormReplacesApprovalCard`
(`gates.ts:307-311`), and it applies to exactly one tool: `pools.launch_execute`
(`gates.ts:276-283`). In the ordinary in-app turn loop, that tool's own launch form
(`pools.launch_request_form`) is the consent surface - it shows the token, the image, the
creation fee, the prebuy, the Vex fee and the total, and its Deploy click is what authorizes the
spend, so a generic approval card there would ask for the same money twice through two surfaces.
Over Studio the carve-out is explicitly disabled: `launchFormReplacesApprovalCard` checks not
just the tool id but also `resolveApprovalSurface(context) === "in_app_form"`
(`gates.ts:311`), and the Studio MCP mapper is the one caller in the tree that states
`approvalSurface: "studio_mcp"` explicitly (`gates.ts:290`, set at `src/vex-agent/mcp/admission.ts:222`). Since Studio has no launch form
at all, skipping the card there would let an external agent reach a fund-moving handler with no
human consent surface whatsoever, so `pools.launch_execute` over Studio takes the ordinary
approval card like any other mutating tool (`gates.ts:296-312`). The handler still refuses a
restricted session by name if it is ever reached another way, independent of which surface called
it.

When the gate fires, the tool result carries `pendingApproval: true` instead of running.

#### From gate to durable row

`runStudioCall` (`vex-app/src/main/studio/approval-service.ts:98`) is the entry point every
exported Studio tool goes through. On a `pendingApproval` result it reclassifies the project's
lifecycle lease from `executingCall` to `pendingApproval` before doing anything else, so a
concurrent project delete does not keep waiting on a call that is about to park
(`approval-service.ts:236`). It then calls `reserveStudioWaiterSlot()`
(`vex-app/src/main/studio/approval-broker.ts:219-231`), which claims a slot under
`STUDIO_WAITER_CAP = 32` (`approval-broker.ts:81`) BEFORE the approval intent is written
(`approval-service.ts:242`). If the process is already holding 32 Studio calls waiting on a
decision, `reserveStudioWaiterSlot` refuses immediately (`occupiedSlots() >= STUDIO_WAITER_CAP`,
`approval-broker.ts:220`) with a named capacity reason (`atCapacityReason`,
`approval-broker.ts:204-209`), and nothing is written: no queue row, no intent row, no card. A
capacity refusal and a written-but-later-rejected row are different failures, and this design
keeps them distinguishable - a refusal at this point leaves no trace for a human to later find and
decide on.

Only after the slot is reserved does `enqueueStudioApprovalIntent`
(`src/vex-agent/mcp/approvals.ts:109`) run, which calls the shared
`enqueueApprovalIntentWithGate` (`src/vex-agent/engine/core/approval-runtime/enqueue.ts:220`) -
the one enqueue transaction used by both the in-app agent turn loop and Studio. Before the
transaction opens, this function builds three things from the tool result and call arguments: the
approval preview card (`buildApprovalIntentPreview`, `enqueue.ts:81,231`), the tool-call envelope
(`buildApprovalToolCall`, `enqueue.ts:266-268`), and, for a Studio-origin call, the Studio
authority digest over that envelope, preview and expiry plus session, project, scope version and
permission (`computeStudioEnqueueAuthorityDigest`, called at `enqueue.ts:279`). These three
pieces, plus the row, are then written together inside one transaction (`enqueue.ts:281-324`), so
what gets digested and what gets stored are provably the same value - there is no window where the
row exists with a card or envelope that was rebuilt separately from what the digest covers.

Inside that transaction, `runStudioEnqueueGate` (`src/vex-agent/mcp/approvals.ts:173-236`) runs as
the injected pre-insert gate, in this order:

1. `acquireSessionControlLockOn(client, backingSessionId)` (`approvals.ts:177`) - edge 0 of the
   global lock order, taken first so nothing else in this flow can race a lock/unlock transition.
2. `SELECT scope_version, permission, deleted_at FROM projects WHERE id = $1 FOR SHARE`
   (`approvals.ts:180`). If the row is missing or `deleted_at` is non-null, the gate refuses with
   the same sentence either way - a tombstoned project and a never-existing one are answered
   identically, because the only question this check asks is whether an external agent may still
   obtain authority under this project id (`approvals.ts:187-195`).
3. The row's `scope_version` is compared against the scope version the call was admitted under
   (`approvals.ts:197`); a mismatch means the project's permission or wallet selection changed
   while the call was being prepared, and the gate refuses rather than asking for approval under
   settings that no longer apply (`approvals.ts:198-204`).
4. `readStudioRuntimeAvailability()` is called once here (`approvals.ts:206`), refusing if Vex is
   locked or not ready.
5. `readStudioDispatchGeneration(client)` is read and, if `null`, refused
   (`approvals.ts:213-221`).
6. `readStudioRuntimeAvailability()` is called a SECOND time (`approvals.ts:228`), immediately
   after the generation read. The generation read took the project row `FOR SHARE`, which can
   wait behind another transaction's `UPDATE`; the first availability answer describes the
   instant before that wait, not the instant this transaction is about to insert into, so it is
   re-checked rather than trusted stale.

Only if every one of these checks passes does the gate return `{ kind: "clear", dispatchGeneration
}` (`approvals.ts:235`), and the enqueue transaction stamps that generation onto the new row as
`dispatchGenerationAtEnqueue` before inserting the `approval_queue` and `approval_intents` rows
together (`enqueue.ts:322-323`). An `approval_enqueued` event is emitted only after the
transaction commits (`enqueue.ts:361`).

#### What the human then sees, and what dispatch re-checks

The row created here is what the desktop app's approval card renders - `Title`, actor line,
project, expiry, and the critical-args well drawn from the same preview built above [see
s4-approval-surface]. When a person approves it, dispatch does not treat the enqueue-time checks
as still valid: `dispatchApprovedStudioAction`
(`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:155`) re-checks
the operator-stop gate, claims the dispatch slot with a CAS fenced on the dispatch generation
recorded at enqueue, re-reads the project row and compares its scope version against the
ENQUEUE-time value (never a freshly re-read "current" value compared with itself), re-verifies the
manifest identity of the tool contract, re-checks the Studio authority digest, and rebuilds the
approval card from scratch to require an exact match against what was stored - refusing by name
(`card_mismatch`, `scope_changed`, `fence_unproven`, and others) rather than dispatching on stale
authority. That revalidation is a separate mechanism from the enqueue gate described here; this
section stops at the point the row becomes durable and decidable.

#### Sizing the safeguard

`STUDIO_WAITER_CAP = 32` is a process-wide, in-memory bound - not per-project - on how many Studio
calls may be parked waiting for a decision at once (`approval-broker.ts:81`). It exists precisely
because the enqueue path above always writes a durable row once the gate clears: without a cap
ahead of that write, an external agent issuing mutating calls faster than a human can decide them
could grow an unbounded queue of live, approvable actions. The cap is checked and claimed before
any row exists, so hitting it produces a clean refusal rather than a row nobody will ever see.

### The Authority Digest And Manifest Fingerprint

An approval in Vex Studio is not a checkbox next to a tool name. It is a hash-bound record of a
specific, reconstructable set of facts, and everything downstream of the human's decision
exists to prove those facts have not moved between the moment the card was shown and the
moment the action runs. This section documents that binding at the field level.

#### The Studio authority digest

`computeStudioAuthorityDigest` hashes one preimage object with SHA-256
(`src/vex-agent/engine/core/approval-runtime/tool-call-envelope.ts:478-492`):

| Field | Source |
|---|---|
| `version` | literal `"studio-authority-v1"`, `STUDIO_AUTHORITY_DIGEST_VERSION` (`tool-call-envelope.ts:459`) |
| `origin` | literal `"studio_mcp"`, hardcoded, not read from input (`tool-call-envelope.ts:483`) |
| `sessionId`, `projectId` | `StudioAuthorityDigestInput` (`tool-call-envelope.ts:484-485`) |
| `scopeVersion` | the value recorded at enqueue (`tool-call-envelope.ts:486`) |
| `permission` | `"restricted" \| "full"` recorded at enqueue (`tool-call-envelope.ts:487`) |
| `expiresAt` | (`tool-call-envelope.ts:488`) |
| `preview` | the whole rendered approval card (`tool-call-envelope.ts:489`) |
| `envelope` | the whole stored tool-call envelope (`tool-call-envelope.ts:490`) |
| `manifestIdentity` | `studioManifestIdentity(input.envelope)`, derived, see below (`tool-call-envelope.ts:491`) |

The object passes through `canonicalizeJsonValue` (sorts object keys recursively, keeps array
order, drops `undefined` keys) before `JSON.stringify` and SHA-256. The stored/compared string
carries the version as a prefix as well as inside the hash: `studio-authority-v1:<64-hex>`
(`tool-call-envelope.ts:493-496`), so a future field-set change cannot accidentally validate an
old digest by coincidence.

`studioManifestIdentity` (`tool-call-envelope.ts:565-580`, private) produces one of two shapes:
a protocol tool (envelope has `vex`) yields `{kind:"protocol", metadata: envelope.vex}` -
re-nesting the same `{v, originalToolName, manifestFingerprint}` block already present in
`envelope.vex`, so the manifest fingerprint is asserted twice in the preimage; an internal or
legacy tool (no `vex`) yields `{kind:"internal", command: envelope.command or envelope.name or
null}`. It does not unpack the manifest itself.

#### The manifest fingerprint: call shape only

`computeManifestFingerprint(manifest)` (`tool-call-envelope.ts:347-383`) hashes a narrower
object describing only the call shape a human approved, SHA-256'd and sliced to 32 hex
characters (`tool-call-envelope.ts:379-382`): `toolId`, `mutating`, `actionKind`, `params`
(projected and sorted by key), and `exclusiveParamGroups` / `atMostOne` / `atLeastOneOf`
(each canonicalized - members sorted, then groups sorted by joined string, since "only
membership changes the contract," `tool-call-envelope.ts:393-401`).

Each `params` entry projects `key`, `type`, `required` (coerced boolean), `unit` (or `null`),
`enum`, `acceptsStringArray` (coerced boolean), and `aliases` (only present when declared: alias
keys only, sorted; declaration order and `removeAfter` are not hashed) - not the raw manifest
param object (`tool-call-envelope.ts:349-364`).

Enum members are the one field where declaration order is hashed exactly as written, not
sorted, because it is behaviorally meaningful: chain-valued enum normalization matches a
supplied value case-insensitively against the FIRST listed match, so `["base","BASE"]` and
`["BASE","base"]` hand a handler different resolved strings for identical input
(`tool-call-envelope.ts:329-336`). Sorting the enum would make those two contracts
indistinguishable to the fingerprint while they behave differently at runtime.

Two things are deliberately excluded from the fingerprint entirely: `namespace` and
`requiresEnv` describe the tool's identity and availability, not call shape, and their failure
mode is already safe without hashing (a moved namespace or a newly missing env var fails
admission outright rather than executing under a silently different contract,
`tool-call-envelope.ts:338-345`); and description prose, because copy edits are routine in this
repository and must never strand a queued approval (`tool-call-envelope.ts:35-37`).

#### `checkApprovalManifestIdentity`: four fail-closed causes

Before dispatch, `checkApprovalManifestIdentity` (`tool-call-envelope.ts:268-317`) re-resolves
the manifest behind the stored `toolId` and compares its live fingerprint to the one recorded
at enqueue:

| `reason` | Trigger | Refusal cause text |
|---|---|---|
| `envelope_version_superseded` | `envelope.vex.v` below current `ENVELOPE_VERSION` (2) | "this approval was recorded under an older tool-contract format that cannot verify the tool's current validation rules" |
| `envelope_metadata_unreadable` | `envelope.vex` present but fails schema parsing otherwise | "this approval's stored tool contract could not be read" |
| `manifest_missing` | `toolId` no longer resolves | `the tool "<toolId or originalToolName>" is no longer available` |
| `manifest_fingerprint_mismatch` | live fingerprint differs from stored | `the tool contract for "<toolId>" changed after this approval was requested` |

An envelope with no `vex` block at all returns `{ok:true}` rather than a failure - no metadata
was ever recorded to check (`tool-call-envelope.ts:272-273`). Every cause routes through
`buildIdentityRefusal` into one exact template, both agent- and user-visible
(`tool-call-envelope.ts:415-420`): "Approved action refused: `<cause>`. Nothing was executed
and no funds moved. Call the tool again with the parameters you want and request a fresh
approval."

#### A real asymmetry: two digests, opposite null policies

`computeRequestDigest` (`tool-call-envelope.ts:586-590`) hashes the entire stored envelope as
written, the full 64-character hex digest, not sliced. Its matcher,
`approvalRequestDigestMatches` (`tool-call-envelope.ts:450-456`), treats a `null` stored digest
as `true`: rows written before this column existed are trusted, for back-compatibility.

`studioAuthorityDigestMatches` (`tool-call-envelope.ts:500-511`) makes the opposite choice: it
returns `false`, never authorizing, when the stored digest is `null` or lacks the exact prefix
`studio-authority-v1:`. There is no legacy-trust path for the Studio lane. The same shape of
"missing digest" means opposite things depending on which function reads it, because Studio is
the newer, stricter, external-agent lane and a missing authority record there is never treated
as historical goodwill.

#### Dispatch-time revalidation: the card is rebuilt, not reused

Inside `dispatchApprovedStudioAction`
(`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts`), the checks
above run as two of several sequential gates: manifest identity (`studio.ts:272-283`), then the
authority digest re-check over the envelope, preview, expiry, session id, project id, the
enqueue-time scope version, and the enqueue-time permission, against `row.request_digest`
(`studio.ts:284-312`). Passing both is necessary but not sufficient. `revalidateStudioApprovalCard`
(`studio.ts:433-485`) then re-runs the entire admission path from scratch, calling
`admitStudioCall` again with the tool name and arguments recovered from the durable envelope,
under a project tool context forced to `permission: "restricted"` regardless of the project's
actual current permission (`studio.ts:441-448`). This forced re-evaluation must still produce
`pendingApproval: true`, or dispatch refuses as `approval_no_longer_required`
(`studio.ts:460-467`). The fresh card is rebuilt with `buildApprovalIntentPreview` and compared
field-for-field against the `preview_json` the human actually saw, using
`approvalPreviewExactlyMatches` (exact recursive JSON equality after key-sorting, order-preserving
arrays, any added or removed field counts as drift). Drift refuses as `card_mismatch`:
"the current complete approval card no longer exactly matches the card the user approved"
(`studio.ts:468-483`). A preflight check runs once more on the last event-loop turn before
dispatch, closing the window this rebuild's own awaits open (`studio.ts:352-358`).

The human's approval never authorizes "run this tool now." It authorizes one reconstructable
set of facts, and dispatch re-derives that same set from the durable row, refusing unless the
fresh derivation matches exactly.

### The Approval Data Contracts

The renderer never receives the raw `approval_queue.tool_call` or `pending_context` JSONB. A main-side mapper reduces those blobs to allow-listed DTO fields (`vex-app/src/shared/schemas/approvals.ts:1-11`), and every DTO schema is `.strict()`, so an unlisted or smuggled key fails validation rather than riding along silently.

#### `ApprovalSummaryDto`

`approvalSummaryDtoSchema` (`vex-app/src/shared/schemas/approvals.ts:186-243`, `.strict()`) carries 19 fields, in declaration order:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | `approvals.ts:188` |
| `sessionId` | `uuid \| null` | null for engine-enqueued, session-less approvals; `approvals.ts:194` |
| `toolCallId` | `string \| null` | `approvals.ts:195` |
| `toolName` | `string \| null` | best-effort `namespace:command`, falling back to `command`, `name`, then `"unknown"`; `approvals.ts:202` |
| `status` | `"pending" \| "approved" \| "rejected"` | mirrors the `approval_queue.status` CHECK; `approvals.ts:203` |
| `permissionAtEnqueue` | `"restricted" \| "full"` | `approvals.ts:204` |
| `createdAt` | ISO datetime | `approvals.ts:205` |
| `resolvedAt` | ISO datetime `\| null` | `approvals.ts:206` |
| `reasoningPreview` | `string`, max 200 chars | first 200 characters of `approval_queue.reasoning`; `approvals.ts:208` |
| `actionKind` | 7-variant enum `\| null` | `read`, `local_write`, `schedule`, `approval_prepare`, `user_wallet_broadcast`, `external_post`, `destructive`; `approvals.ts:216` |
| `riskLevel` | `"info"\|"low"\|"medium"\|"high"\|"critical" \| null` | `approvals.ts:217` |
| `preview` | object `\| null` | `approvals.ts:218` |
| `expiresAt` | ISO datetime `\| null` | `approvals.ts:219` |
| `decision` | `"approved"\|"rejected"\|"rejected_stop" \| null` | `approvals.ts:220` |
| `decisionReason` | `string \| null` | `approvals.ts:221` |
| `executionStatus` | `"not_started"\|"dispatching"\|"succeeded"\|"failed"\|"indeterminate" \| null` | `approvals.ts:222` |
| `origin` | `"agent" \| "studio_mcp" \| null` | null means no companion `approval_intents` row, never "unknown"; `approvals.ts:224` |
| `projectId` | `uuid \| null` | `approvals.ts:226` |
| `requestedByClient` | `string \| null` | see below; `approvals.ts:241` |

`preview` (`approvalPreviewSchema`, `approvals.ts:174-183`, `.strict()`) is `{ toolName: string, namespace?: string, criticalArgs: Record<string, string|number|boolean|null> }`.

`requestedByClient` carries the MCP `clientInfo.name` an external client declared at handshake, display-only and untrusted (`approvals.ts:228-240`). It is bounded to `REQUESTING_CLIENT_NAME_DTO_MAX = 60` characters (`approvals.ts:36`) and validated against a regex that rejects Unicode control (`\p{Cc}`), format (`\p{Cf}`, covering bidi-override characters U+202A-U+202E and U+2066-U+2069, and zero-width characters U+200B-U+200D/U+FEFF), surrogate (`\p{Cs}`), and line/paragraph-separator (`\p{Zl}`, `\p{Zp}`) codepoints (`approvals.ts:42-45,61-68`).

#### `ApprovalPendingGlobalDto`

`approvalPendingGlobalDtoSchema` extends the full `ApprovalSummaryDto` (`approvals.ts:256-270`, `.strict()`) with two more fields:

| Field | Type | Notes |
|---|---|---|
| `sessionTitle` | `string \| null` | `COALESCE(title, initial_goal)`, null for session-less or deleted sessions; `approvals.ts:258` |
| `projectName` | `string \| null`, max 80 chars | display-only project name, joined at read time; `approvals.ts:268` |

The extension is deliberate, not incidental: dropping `riskLevel`, `actionKind`, or `preview` from the global inbox DTO would let a destructive action skip the two-step high-risk confirmation the renderer's `ApprovalCard` performs on those fields (`approvals.ts:247-254`). `projectName` deliberately survives a project tombstone: a pending approval that outlived its project still names which project asked, because "some deleted project wanted your wallet to do this" is not an answer a user can act on (`approvals.ts:259-267`). `projectId`, not `projectName`, remains the identity anything binds on.

#### Reject reason bound

`APPROVAL_REJECT_REASON_MAX = 500` (`approvals.ts:317`) bounds `approvalActionInputSchema.reason` (`z.string().trim().max(APPROVAL_REJECT_REASON_MAX).optional()`, `approvals.ts:334-335`). The reason is untrusted user text that becomes model-visible transcript content on rejection, so it is trimmed and hard-bounded at this schema and additionally stripped of control characters engine-side before render, so a reject reason cannot forge lines that look like engine control banners (`approvals.ts:319-330`). The doc comment notes the engine mirrors this bound (`approvals.ts:316`); the engine-side mirror file was not opened for this section and is not independently re-verified here.

### The Approval Card And The Global Approvals Panel

When a mutating Studio call is refused with `pendingApproval`, a human decides it in the desktop app on exactly one component: `ApprovalCard` (`vex-app/src/renderer/features/appShell/ApprovalCard.tsx:67`). It renders inline, between a session's transcript and its composer, and it renders again - the identical component, not a lookalike - inside the app-wide Global Approvals panel. Whichever surface you open it from, you are looking at the same card.

#### What the card shows

The header names the tool being asked for: `"Approval needed: {namespace}:{toolName}"`, or the bare tool name when the call carries no namespace (`vex-app/src/renderer/features/appShell/ApprovalCard/ApprovalDetails.tsx:82-90`). Beside the title sit two stamps, rendered only when the approval carries the fact: a risk chip (`info | low | medium | high | critical`) and an action-kind chip naming what class of effect the call has (`ApprovalDetails.tsx:93-110`; the five risk levels are defined in `vex-app/src/shared/schemas/approvals.ts:105-110`).

Below the header, a details block lists what is bound to this decision, each row appearing only when the approval actually carries that fact:

| Field | What it shows | Source |
|---|---|---|
| Requested by | The actor line: `"Vex's own agent"` for an agent-originated call; for a Studio call, `"{clientName} (an MCP client) in {project}"`, or `"an MCP client in {project}"` when the connecting client declared no name; nothing rendered when origin itself is unknown | `vex-app/src/renderer/features/appShell/approvals/approvals-copy.ts:117-131` |
| Project | The project's name when one was joined in, otherwise the bare project id | `approvals-copy.ts:21-27` |
| Proposal | The approval's own id, verbatim | `ApprovalDetails.tsx:161-166` |
| Expires | The expiry timestamp, verbatim, in UTC | `ApprovalDetails.tsx:172-181` |

The connecting MCP client's self-declared name is untrusted, client-reported text - it never decides anything and is shown only as provenance. The expiry is deliberately never turned into a countdown: a countdown computed in the renderer would be a second source of truth for a deadline the backend's own sweep and broker timer already own, so the card shows the raw instant instead and leaves the arithmetic to you (`ApprovalDetails.tsx:167-171`).

Below that sits the critical-args well: every key from the approval's bound preview, in a recessed box, because these are the facts being signed for. One known key gets a human label (`vexFee` renders as "Vex fee"); every other key keeps its raw name rather than inventing a label that could drift from what the key actually means, and a key that is absent renders no row at all (`ApprovalDetails.tsx:37,189-205`).

#### Deciding

The footer carries two buttons, Reject and Approve, plus an optional bounded rejection-note field that becomes part of what the agent sees if you use it (`vex-app/src/renderer/features/appShell/ApprovalCard/ApprovalDecisionActions.tsx:56-115`). In the inline session view, Reject is the button that receives focus the first time a new pending approval appears - the least destructive default (`ApprovalDecisionActions.tsx:80-101`). This is conditional and panel-specific: only the first newly-appearing card is focused this way, and a second card arriving in the same batch does not steal focus (`vex-app/src/renderer/features/appShell/ApprovalsRegion.tsx:17-18,111`); the Global Approvals panel never auto-focuses it at all, since its `ApprovalCard` instance always passes `focusOnMount={false}` (`vex-app/src/renderer/features/appShell/GlobalApprovals/GlobalApprovalItem.tsx:118`), so a keyboard user there must tab to it.

For a high-risk decision, one click is never enough. An approval counts as high-risk when its risk level is `high` or `critical`, or when its action kind is `destructive` or `user_wallet_broadcast` (`vex-app/src/renderer/features/appShell/ApprovalCard/risk.ts:22-32`). On a high-risk card, the first click on either button arms it - the label changes to "Click again to confirm reject" or "Click again to confirm approve" - and only a second click within four seconds commits the decision; clicking the other button arms that one instead (switching which action needs one more click to fire), not resetting anything - only letting four seconds pass with no confirming click resets the arming state back to nothing decided (`ApprovalCard.tsx:41,87-96,183-198`; the two label strings themselves are rendered in `ApprovalDecisionActions.tsx:100,111`). A successful approve triggers a one-shot visual glint on the card; a reject never does - the only light in the flow, and it only ever means yes (`ApprovalCard.tsx:111-115,149`).

Both actions post through the same non-retrying mutation (`vex-app/src/renderer/lib/api/approvals.ts:167,174`), and a failure surfaces as an inline error inside the card rather than silently disappearing (`ApprovalCard.tsx:141-181`).

#### The Global Approvals panel

Every project's pending approvals also collect in one app-wide inbox: the Global Approvals panel. Each row there (`vex-app/src/renderer/features/appShell/GlobalApprovals/GlobalApprovalItem.tsx:38-124`) carries a session header (falling back to "Untitled session" or, for a session-less row, "Background approval"), a project tag when the row has one, and an optional "Open session" button that switches you into the session that raised it. Under all of that, the row mounts `ApprovalCard` itself, with the same critical-args well and the same two-step high-risk confirm as the inline view - a destructive action can never be one-click approved from the inbox, because the inbox does not have its own, weaker decision surface. It has the same one.

#### The cross-mode toast

Vex Studio and the agent shell are two modes sharing one approvals queue. An approval raised on the side you are not currently looking at would otherwise be visible only as a number ticking up on the badge - easy to miss. The first time such an approval is newly observed, a toast fires once: `"Approval waiting in {where}: {tool}"`, naming where the approval originated (a Studio project's name, "Vex Studio" for a Studio call with no project, or "the agent shell" for an agent-originated call) and, when more than one arrived in the same observation, `", and {N} more awaiting"` (`vex-app/src/renderer/features/appShell/approvals/approvals-copy.ts:44-77`, `vex-app/src/renderer/features/appShell/approvals/useCrossModeApprovalToast.ts:90-122`). The toast informs only - it carries no button, no navigation, and grants nothing; the approval is still decided in its own card under its own confirm gate. Each approval id is announced at most once, tracked in a bounded in-memory set that never re-fires for a row you already saw, whichever mode you were looking at when you saw it.

---

**Reference read**: `agents-colab/gemini-cli/docs/tools/mcp-server.md` (trust and confirmation sections) and `agents-colab/github-mcp-server/docs/error-handling.md` (user-actionable vs developer errors). Adopted: naming precisely what a confirmation binds, and treating every outcome (refusal, expiry) as a distinct, addressed case rather than a bare failure. Rejected: Gemini CLI's per-server/per-tool "trust" bypass that skips confirmation entirely has no analog here - every mutating Studio call in a restricted project gets a card; GitHub MCP Server's Go-specific error-context plumbing is implementation detail with nothing to adapt.

### Approval Window, Expiry, And Outcomes

When a call from an MCP client needs a human decision, Vex parks it and gives you a fixed
window to decide. This section covers that window, what happens when it runs out, and the
closed set of outcomes an MCP client can be told about the call it made.

#### The window

The default approval window is one hour: `APPROVAL_TTL_MS = 60 * 60 * 1000`
(`src/vex-agent/engine/core/approval-runtime/enqueue.ts:118`). It is stamped when the call is
enqueued, not when you open the card or decide it, so the clock on a card you have not looked
at yet is already running from the moment the tool asked. If the action carries its own tighter
deadline, such as a wallet intent or a blockhash the network will expire on its own, that
deadline floors the window instead: the stored expiry is `min(now + 1 hour, the action's own
trusted expiry)` (`resolveExpiresAt`, `enqueue.ts:392-404`). A prepared swap or transfer can
therefore expire in far less than an hour when the network-level proof it depends on expires
first; the approval can never outlive the thing it would authorize.

#### Two layers that enforce expiry

Vex enforces the window with two independent mechanisms so a single failure cannot leave a
stale approval alive:

- **Fast path.** Each waiting call arms its own timer for the exact moment its `expires_at` is
  reached (`vex-app/src/main/studio/approval-broker.ts:395-401`) and, when it fires, settles the
  row as expired without writing a transcript message or a resumable continuation - the
  Studio-origin branch of the shared reject dispatcher writes no transcript message, no
  `result_message_id`, and no continuation claim
  (`src/vex-agent/engine/core/approval-runtime/post-tx/reject-dispatch.ts:20-38,60-78`, [see
  s4-gate-flow]).
- **Durable floor.** A scheduled sweep runs every five minutes
  (`SWEEP_INTERVAL_MS = 5 * 60 * 1000`, `vex-app/src/main/ipc/approvals.ts:44,56-64`) and
  auto-rejects any approval whose per-waiter timer never got the chance to fire, such as one
  left behind by a Vex process that exited while the call was parked. The first sweep cycle
  runs immediately when Vex starts, not five minutes later.

Together these mean an approval is never left expired-but-unresolved for more than the sweep
interval while Vex is running. If Vex itself was not running, the row stays pending until the
next start, where the very first sweep cycle resolves it immediately
(`vex-app/src/main/ipc/approvals.ts:18-22,56-64`).

#### The seven outcomes

Exactly one of seven named outcomes reaches the MCP client for a call that went through
approval or was refused before it could be queued (`src/vex-agent/mcp/outcome.ts:21-70`). Vex
never reports a generic failure here: each outcome carries its own honest sentence stating what
did and did not happen, and whether funds moved.

| kind | what happened | can you retry |
|---|---|---|
| `completed` | The call ran, with or without approval, and this is its result. | depends on the tool's own result |
| `declined` | A person clicked Reject in Vex. Nothing was executed. | yes, if still wanted |
| `expired` | Nobody decided within the window. Nothing was executed. | yes, call the tool again |
| `refused` | Vex cancelled the pending action itself: it locked, the project was deleted or its scope changed, the transport disconnected, or Vex quit. Nothing was executed. | yes, once the blocking condition is resolved - not when `confirmed` is `false` (the sentence itself says do not retry until the approval is checked in Vex) and not when the cause was the project's own deletion, which nothing resolves |
| `dispatch_failed` | The action was approved but Vex could not carry it out. Nothing was executed. | no, not automatically |
| `indeterminate` | The approved action was dispatched but Vex cannot prove whether it took effect. It may have moved funds. | **no - do not retry** |
| `not_queued` | The call never became a decidable approval at all (Vex is locked, at capacity, the project is gone, and similar). Nothing was executed. | depends on the named cause |

`refused` carries a `confirmed` flag: when `true`, Vex durably recorded the cancellation; when
`false`, Vex could not confirm it wrote that record and tells the client to treat the outcome as
unresolved rather than cleanly cancelled (`server-result.ts:62-75`). The `indeterminate` sentence
leads with **"DO NOT RETRY THIS CALL"** before anything else, because those are the only words
guaranteed to reach the model first on this transport; it also states the outcome is unknown,
that funds may have moved, and that Vex reconciles the approval itself rather than the caller
retrying it (`STUDIO_INDETERMINATE_SENTENCE`, `src/vex-agent/mcp/server-result.ts:84-89`). An
eighth case sits outside the seven: if the handler running the call throws instead of returning
any outcome, Vex has nothing to report and also leads with "DO NOT RETRY THIS CALL", carrying
only a correlation id so the underlying error text never crosses the wire (`server-result.ts:92-116`).

#### While you wait

If the MCP client sent a progress token when it called the tool, Vex sends a progress
notification roughly every two seconds while the call sits parked, reading
`"Waiting for a person to decide this action in Vex."`
(`DEFAULT_PROGRESS_INTERVAL_MS = 2_000`, `vex-app/src/main/studio/approval-broker.ts:420`;
sent from `src/vex-agent/mcp/server.ts:269-289`). A client that never sent a progress token gets
no notifications while it waits; sending one without a token would itself be an invalid MCP
frame, so Vex only wires the callback when the token is present (`server.ts:269-289`).

### When Approvals Fail: Locked, Deleted, Scope-Changed

An approval is a promise that spans time: a card is raised, and only later does a person decide it. In that gap the world can move - Vex can lock, the project the call belonged to can be deleted, or its permission and wallet selection can be edited. None of these leave a call stranded. Every one of them ends in a named, terminal outcome, and no path lets an action run under authority that no longer holds.

#### Locking mid-flight

Vex checks the lock at more than one point, because a call can be at more than one point when the lock lands.

- Right after the readiness barrier, and before any lifecycle lease or tool execution, `runStudioCall` checks `isSecretSessionUnlocked()` and refuses `not_queued` with the locked sentence (`vex-app/src/main/studio/approval-service.ts:118-120`).
- If the call is mutating and about to park on a human decision, the enqueue transaction calls `readStudioRuntimeAvailability()` a second time, specifically because the read can land behind a lock's own database write (`src/vex-agent/mcp/approvals.ts:206-234`).
- If a human has already approved the action and it is about to dispatch, the dispatch path checks the same preflight twice: once before it rebuilds the approval card, and once again on the very last event-loop turn before the tool actually runs, closing the window the card rebuild's own awaits could otherwise open (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:187,352-358`).

A lock encountered at any of these points never runs the tool and never leaves a dispatchable row behind. The user-facing sentence is direct: "Vex is locked, so it will not run this action. Nothing was executed and no funds moved. Unlock Vex and call the tool again." (`vex-app/src/main/studio/approval-service.ts:365-367`).

#### Project deletion while an approval is pending or already approved

Deleting a project does not simply refuse the pending approvals and then remove the project row. The real order has an extra step in the middle, because an approval that a person has already said yes to is a stronger authority than one still waiting for a decision, and only one of the two gets a dedicated settlement.

1. **Approved-but-not-dispatched rows go first, through their own settlement.** The delete transaction locks every Studio-origin row that is `decision = 'approved'` and still `not_started` or `dispatching`. If any of them is `dispatching` - a wallet action running right now - the whole delete aborts: its outcome belongs to the dispatcher, and the delete will not guess at a money result still in flight (`vex-app/src/main/database/projects/delete.ts:273-279`). Every `not_started` row is then settled individually through a dedicated write, `casRefuseStudioBeforeDispatchWith`, that preserves the human's original "approved" decision alongside the new refusal reason `project_deleted` (`vex-app/src/main/database/projects/delete.ts:281-300`). This settlement is a pure database write with no waiter to release, because an approved-not-started call has already left the class of calls a delete would otherwise wait on. If that write matches zero rows, the whole delete transaction rolls back rather than commit a tombstone behind a still-dispatchable action (`vex-app/src/main/database/projects/delete.ts:308-322`).
2. **Only then are the still-undecided rows refused, through the shared sweep.** Every intent still awaiting a human decision is settled by the same primitive the settings-dialog scope edit uses, `refusePendingStudioIntents`, with reason `project_deleted` (`vex-app/src/main/database/projects/delete.ts:328-337`). This is what actually releases anyone whose call is parked waiting on a card.
3. **The backing session is soft-deleted** (`vex-app/src/main/database/projects/delete.ts:339-346`).
4. **The project row is soft-deleted last**, per the database's own lock ordering (`vex-app/src/main/database/projects/delete.ts:352-363`).

An approval waiting on a human decision sees the sentence: "The Vex project this action belonged to was deleted, so the action was cancelled. Nothing was executed and no funds moved." (`src/vex-agent/engine/core/approval-runtime/studio/refuse.ts:82-84`). An approved action caught mid-flight is settled the same way, but its terminal state also records that a human had said yes before the project vanished.

The project's admission gate closes before any of this database work begins, and any new Studio tool call arriving mid-delete is refused through the `executingCall` lease with the sentence: "This Vex project is being deleted, so the action was not queued. Nothing was executed and no funds moved." (`vex-app/src/main/studio/approval-service.ts:133-135,361-363`). This is a different sentence from the one the AGENTS.md/vex-guide/CLAUDE.md render path uses when it hits a mid-delete project, `projectDeletingError` (`vex-app/src/main/studio/project-errors.ts:198-203`, consumed at `vex-app/src/main/studio/installer.ts:146-147`) - that path is not a Studio tool call and is out of scope here.

#### Scope edited while an approval is in flight

Editing a project's permission or wallet selection - from the project settings dialog - bumps the project's `scope_version` and refuses only the approvals still waiting for a human decision, in the same transaction as the bump. It does **not** close the project to new calls, does not wait for calls already running, and does not touch a row a person has already approved.

Concretely: if a call was admitted, is currently executing, or has already been approved and is sitting `not_started`, waiting to dispatch, a scope edit leaves it completely alone. Only rows with no decision yet get refused, by `refusePendingStudioIntents` with reason `scope_changed`, and the sentence written onto those rows is: "The project's permission or wallet selection changed while this action was waiting for approval, so it was cancelled rather than run under the old settings. Nothing was executed and no funds moved. Ask again to run under the new scope." (`src/vex-agent/engine/core/approval-runtime/studio/refuse.ts:85-89`, invoked from `vex-app/src/main/database/projects/scope.ts:172-178`). A related but distinct sentence exists for the moment a brand-new call is being enqueued and discovers the scope has already changed before a person ever saw a card - that refusal is worded differently because nothing was ever parked: "The project's permission or wallet selection changed while this call was being prepared, so Vex will not ask for approval under the old settings. Nothing was executed. Call the tool again to run under the new scope." (`src/vex-agent/mcp/approvals.ts:197-205`).

This means an action a person approved a moment before the edit is, at the instant the scope edit commits, still authorized to run under the pre-edit wallet and permission as far as that edit transaction is concerned. That gap is closed one hop later, not left open: the dispatch path re-checks both scope version and project existence inside the same short transaction that claims the dispatch slot, serialized against a concurrent scope edit or delete by the shared session-control lock taken first in both transactions (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:98-217`, tombstone check at `:168-189`, scope-version check at `:191-215`). A row whose scope drifted after approval is refused there, with reason `scope_changed`, before the tool ever runs - so an approved-but-undispatched action never actually dispatches under a wallet or permission selection the user has since changed.

#### Transport withdrawal

When an MCP client cancels, disconnects, or Vex itself is quitting or locking while a call is parked waiting on a person, the withdrawal always writes the durable refusal before it releases whatever was waiting on the call. The comment at the source names this explicitly as the safety property: a waiter released before its intent is written as terminal would leave an approvable row sitting behind an agent that has already been told nothing will happen (`vex-app/src/main/studio/approval-broker.ts:483-497,519-536`). If the refusal write itself fails, the caller is still released, but told the cancellation is not confirmed rather than told it succeeded - the row is left for a later sweep to reconcile.

The reason recorded for a transport withdrawal is always one Vex itself assigns - `cancelled`, `disconnect`, `lock`, or `vex_quit` - never text an MCP client supplied, which keeps a broken or hostile client from writing an arbitrary string into the durable audit trail (`src/vex-agent/mcp/outcome.ts:88`).

#### When the dispatch itself fails

Two distinct failures can happen once a human has approved an action and Vex has actually started running it, and Vex treats them differently by design.

- **The dispatch itself throws.** The dispatch call is never retried, and the row is marked `indeterminate` (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:402`). The user-facing sentence: "the action could not be completed and Vex cannot prove whether it took effect, so it will NOT be retried."
- **The dispatch succeeds (or fails cleanly), but the settlement write that records the result then fails.** The dispatch already ran, so it is likewise never retried; only the status write is (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:541`).

Both branches route through the identical bounded retry on the status write that marks the row `indeterminate`: three attempts with a 50-millisecond-times-attempt backoff, never a retry of the dispatch itself (`commitIndeterminate`, `src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:587-635,646-647`, called from both `:402` and `:541`). If every attempt still fails, the identical status write is handed off to an in-process repair mechanism that keeps retrying until the row reaches a terminal state. The real difference between the two branches is only what triggers the `indeterminate` marking and which output text is preserved with it, not the retry policy.

In both cases, the underlying discipline is the same one that runs through every failure mode in this section: a wallet action that has already run is never repeated on a guess, and every path out of the dispatch leaves the row in a terminal, reconcilable state rather than an ambiguous one.


## Part 5 - Money Paths: Signing, Fees, Swaps, Bridges, And Launches

### Money Paths Reachable From Studio

Vex Studio can reach the same set of money-moving actions as the in-app chat surface. Nothing about calling a tool from Studio unlocks a new venue or a new way to move funds; it is the same catalog of tools, dispatched through the same machinery, with a different label attached to how the call arrived.

The full set reachable from Studio spans:

- **Generic signing**: raw EVM transactions (`WalletEvmTransactionPrepare` / `WalletEvmTransactionConfirm`) and raw Solana transactions (`WalletSolanaTransactionPrepare` / `WalletSolanaTransactionConfirm`).
- **Plain sends**: `WalletSendPrepare` / `WalletSendConfirm`, a wallet-to-wallet transfer.
- **Swaps**: KyberSwap (`SwapExecute`) and Uniswap (`SwapExecuteUniswap`), plus Jupiter on Solana.
- **Bridging**: Khalani (`khalani__bridge_execute`) and Relay (`BridgeExecuteRelay`), plus the internal `BridgeExecute` lane.
- **Lending**: Morpho and Pendle on EVM, Jupiter Lend on Solana.
- **Launches**: pools.fun (`pools__launch_execute`) and Virtuals, both curve trades and new-token launches.
- **Exchange trading**: Lighter perpetuals and spot on Lighter Core and Robinhood Chain (`lighter__order_create`, `lighter__position_close`, `lighter__order_cancel`, `lighter__order_modify`, `lighter__order_cancel_all`), plus the account money legs `lighter__deposit`, `lighter__withdraw`, `lighter__withdraw_claim`, the trading-key registration `lighter__key_register` and the fee authorization `lighter__fees_approve`.

`admitStudioCall` is the one dispatcher every Studio tool call passes through (`src/vex-agent/mcp/admission.ts:161-225`). For an exported internal tool it calls the same `dispatchTool` the in-app chat path calls; for an exported protocol tool (a swap, bridge, launch, or lend call) it calls the same `executeProtocolTool` the in-app path calls, wrapped through the one mapper `toProtocolExecutionContext` that turns the call into a `ProtocolExecutionContext` (`src/vex-agent/tools/protocols/execution-context.ts:22-66`). The only thing Studio adds is a tag: `approvalSurface: "studio_mcp"`, stamped explicitly at the call site (`admission.ts:220-223`). The in-app dispatcher stamps the same field explicitly too, at its own mutating call sites (the `execute_tool` resume envelope, the injected discovered-tool lane, and the mutating-protocol-alias router `SwapExecute`/`BridgeExecute`/`BridgeExecuteRelay` route through), passing `"in_app_form"` through the same mapper (`src/vex-agent/tools/dispatcher/protocol-route.ts:86`, `:142`, `:174`). Only the non-mutating quote/list helpers build a `ProtocolExecutionContext` by hand without going through the mapper at all and rely on the gate's default of `"in_app_form"` for an omitted value (`src/vex-agent/tools/internal/action-aliases.ts:81-90`, default at `src/vex-agent/tools/protocols/runtime/gates.ts:292-294`). So the two surfaces run through identical prequote checks, identical approval-gate logic, and identical fee arithmetic; the tag only changes which consent surface a mutating call is routed to (an in-app form for a launch, an approval card everywhere else on Studio, since Studio has no in-app launch form of its own).

This is not a claim taken on faith. An architecture test scans every file under `src/vex-agent/mcp/**`, the package that owns Studio's admission path, and fails the build if it imports the in-app dispatcher's own tool-search lane (`dispatcher/tool-search*`) or any project-table repository directly; the shared row logic those imports would have needed was moved down into `protocols/discovery/rows.ts` instead, and the test asserts that move by name (`src/__tests__/architecture/mcp-boundary.test.ts:1-40`, `:76-125`). The Studio admission path is structurally unable to reach back into the in-app dispatcher's private state; it can only call the same exported, public tool surface the in-app path also calls.

Custody does not move either. Studio never carries a wallet key or a keystore across the MCP boundary; only tool names, arguments, and results cross that wire (`StudioToolCall` carries `name`, `args`, `toolCallId` and nothing else, `src/vex-agent/mcp/admission.ts:63-67`). A mutating call under a restricted session stops for a human decision, rendered as an approval card, before anything is signed: the approval gate short-circuits with nothing decrypted and nothing claimed (`src/vex-agent/tools/internal/wallet/transaction/confirm-shared.ts:317-320`, gate order documented at `:13-23`). Only after that decision is recorded does the privileged process decrypt the key and sign, inside the same main-process wallet module the in-app surface uses. The agent proposes; it never authorizes, and it never holds the key that would let it act without that human decision (see [s6-approval-card](#s6-approval-card)).

### Where Keys Live And When They're Decrypted

Studio never touches key material. Every Studio MCP call funnels through `admitStudioCall`, which either answers `vex_ToolSearch`/`vex_ToolDescribe` locally, dispatches an exported internal tool, or hands an exported protocol tool to `executeProtocolTool` with `toProtocolExecutionContext(call, context, "studio_mcp")` (`src/vex-agent/mcp/admission.ts:161-224`). That call carries a tool id and a params object, nothing else - the same dispatcher the in-app surface uses, so signing happens inside the main-process wallet module regardless of which surface originated the call, and the MCP boundary carries only names, args, and results.

The pools.fun launch path is the clearest trace of when the wallet key is actually decrypted, and it decrypts as late as the code can make it. The handler first validates every forbidden parameter by name (`execute.ts:137-141`), resolves the wallet address only, no key touched (`execute.ts:147-155`), resolves image bytes (`execute.ts:171-172`), and resolves the launch authorization variant from host evidence (`execute.ts:174-179`) - none of that needs a signer (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:134-179`). Only after those checks does it branch: under `simulateOnly` it takes `getLocalPublicClient`, a read-only client, and never opens a signer at all; a real execution calls `openLaunchSigningClients`, which is where the key is decrypted (`execute.ts:191-199`). At that point no authorization has been created yet - the verified plan, the 15-point verifier, and the simulate-only short-circuit all still run before anything is authorized (`execute.ts:201-241`). The `simulateOnly` refusal is enforced twice: once at the handler, immediately before the authorization step (`execute.ts:242-248`), and again inside `authorizeAndConsumePoolsLaunch` itself, which refuses a plan carrying `simulateOnly: true` before opening a transaction: the owner that creates the authorization enforces the "must never be signed" property itself, rather than relying only on the handler's early return (`src/vex-agent/tools/protocols/pools/handlers/launch/execute/authorize.ts:75-89`, commit 88b57b044).

#### Pinned viem facts

These are read from the installed `viem` package in this worktree, not from documentation, because the deferred-signing design depends on which call path touches the network.

| Path | Behavior | Citation |
| --- | --- | --- |
| `walletClient` action path (`signTransaction`) | Unconditionally awaits `getChainId({})`, a provider round trip, before the account signs. It can never satisfy a "zero provider calls between the authority fence and the signature" contract. | `node_modules/viem/_esm/actions/wallet/signTransaction.js:63` |
| `privateKeyToAccount` (local-account path) | Its `signTransaction` call chain has no client and no transport anywhere in it. This is the offline path the deferred-signing arm must use. | `node_modules/viem/_esm/accounts/privateKeyToAccount.js:31`, `node_modules/viem/_esm/accounts/utils/signTransaction.js:1-20` |
| chain-id assertion | Vex's own offline signer, not viem itself: `signPreparedTransactionOffline` takes the prepared request's chain id, asserts it against the prepared chain before signing, and calls `account.signTransaction({ ...transaction, chainId: preparedChain.id }, { serializer: preparedChain.serializers?.transaction })`, never re-deriving chain id after the fence. Covered by a dedicated regression test. | `src/tools/evm-chains/staged-broadcast.ts:658-680` (test: `src/__tests__/tools/evm-chains/staged-broadcast-two-arm.test.ts`) |

#### The pinned signing RPC endpoint

Once a chain's signing path resolves an endpoint through `resolvePinnedRpcEndpoint`, that endpoint is fixed for the whole execution and never advances or fails over: the nonce read, the gas estimate, the pre-sign simulation, and the broadcast are all pinned to the same node's opinion, per the module's own header comment (`src/tools/evm-chains/rpc-transport.ts:16-20`). The caching that actually makes this true lives in `buildPinnedEvmTransport`, which resolves the endpoint once and holds it in a closure variable for the transport's lifetime rather than re-resolving per call (`rpc-transport.ts:531-557`). The transport this builds also forces `retryCount: 0` (`rpc-transport.ts:551,564`), so viem's own retry policy - which retries on 429, `-32005`, and 5xx - can never auto-rebroadcast signed material after a send-time throw; a send failure is treated as ambiguous and reconciled, not retried.

Unverified in this pass: whether any code path outside the ones cited here could move key bytes across the MCP boundary was checked structurally (no such call site found in `admission.ts` or the protocol execution mapper) rather than by an exhaustive repository-wide trace.

### Generic Signing And Its Fee

Vex's generic signing lane is the tool pair that lets an agent, in-app or over Vex Studio, prepare and confirm an arbitrary EVM or Solana transaction rather than going through a purpose-built swap or bridge tool. Because the calldata is arbitrary, Vex does not sign what it cannot describe: `WalletEvmTransactionPrepare` decodes the calldata against a closed allowlist before anything is prepared, and `WalletEvmTransactionConfirm` re-derives everything at confirm time rather than trusting what prepare wrote (`src/vex-agent/tools/internal/wallet/transaction/prepare-evm.ts:97-102`, `confirm-evm.ts:1-26`).

#### What is allowed to sign

On EVM, the v1 decode set is: ERC-20 `transfer`, `approve`, `transferFrom`, `increaseAllowance`, and `permit` (EIP-2612); Permit2 `approve`, `permit`, and `transferFrom`, but only at the canonical Permit2 deployment address for the chain, never anywhere else; and a plain native transfer, which is accepted only when the calldata is empty and `eth_getCode` proves the destination has no code (`decode-evm.ts:9-16, 155-186`). Everything else, including every router and aggregator, is refused before an intent row is created, because a router ABI hides its own receivers and minimum outputs and is its own safety review (`decode-evm.ts:136-144`).

On Solana, the equivalent set is exact (program, instruction variant) pairs rather than trusted program IDs: System `transfer`; classic SPL Token `transfer`, `transferChecked`, `approve`, `revoke`; ComputeBudget `setComputeUnitLimit` and `setComputeUnitPrice`; and Memo (`decode-solana.ts:11-17`). Token-2022 is refused by name rather than silently decoded: it shares the classic token instruction encoding, but its mints can carry a transfer-fee extension or a transfer-hook extension that invokes an arbitrary program on every transfer, so a bare "send N tokens" line would misdescribe the real economics (`decode-solana.ts:18-27, 224-229`).

#### The fee

On this lane, Vex charges 25 basis points (0.25%) of the transaction's own native value (`WALLET_TX_FEE_BPS`, `src/vex-agent/tools/internal/wallet/transaction/vex-fee.ts:67`), the same rate charged on every other Vex venue. The fee is not embedded in the user's own transaction; it is a separate native transfer to the shared Vex treasury (`VEX_TREASURY_EVM`) that runs only after the user's transaction has confirmed on-chain (`vex-fee.ts:2-11, 70`). The disclosure the user sees states this ordering explicitly: the fee "runs AFTER this transaction confirms," is "IN ADDITION to the value this transaction sends and to its own network fee," and "a transaction that does not happen is never charged, and a fee transfer that fails leaves this transaction completely unaffected" (`vex-fee.ts:101-106`).

Three conditions skip the fee outright, each a distinct named reason rather than a single generic "no fee":

| skip reason | when it fires |
|---|---|
| `no_native_value` | the transaction sends no native value at all |
| `floors_to_zero` | 25 bps of the native value truncates to zero in the smallest unit |
| `at_or_below_collection_cost` | the candidate fee does not exceed the most its own collection transfer could cost at the user's approved gas cap |

(`vex-fee.ts:170-186, 226-256`)

The third reason is unique to this lane. Every other Vex venue with a separate fee leg (bridges, pools.fun launches) charges any positive fee, because those actions are meaningful by construction; this lane signs whatever a user or agent hands it, so its action sizes are arbitrary, and without a floor a few hundred wei of fee could trigger a collection transfer whose own network cost is far larger than the fee itself. The threshold compares the candidate fee against `VEX_FEE_TRANSFER_GAS_LIMIT * approvedPerGasCapWei`, the signed gas ceiling rather than the bare 21,000 intrinsic floor, and skips when the fee does not exceed that amount (`vex-fee.ts:206-254`). When skipped this way, the user sees a distinct disclosure: "No Vex fee was taken on this transaction: 25 bps of the native value it sends comes to nothing worth collecting at this size, so no fee transfer is made at all" (`vex-fee.ts:108-110`).

Because the fee's base is the transaction's own native value, a plain ERC-20 `transfer` or `approve` through this lane carries a `valueWei` of zero and pays no fee at all; only a call that also moves native coin can trigger one, and non-payable token and Permit2 calls that try to attach native value are refused outright, never charged (`decode-evm.ts:169-181`). Solana carries no fee on this lane whatsoever: no fee-leg runtime exists for it, and appending a fee instruction to a canonical message a user already approved is forbidden by construction, since the bytes the user read must be the bytes that get signed. This gap is enforced by the database, not only by convention: migration 088 binds a `CHECK (event_role <> 'tx_vex_fee' OR chain_family = 'eip155')` constraint, so a Solana fee row cannot exist (`src/vex-agent/db/migrations/088_wallet_tx_vex_fee.sql:121`).

Nothing about the fee is stored ahead of time. There is no fee column on the transaction intent; it is a pure function of digest-bound fields (the payload's native value and the approved gas bounds) plus fixed constants, computed fresh both at prepare and at confirm. Deterministic over the same bound inputs, the two computations agree by construction; a divergence would surface as a digest mismatch, never as a silently different fee (`vex-fee.ts:22-33`). The rate, the treasury address, and the gas ceiling are fixed product-owner constants: no tool on this lane exposes a fee-shaped parameter to a model or agent, and a dedicated test fails the build if one ever appears (`vex-fee.ts:34-36`).

### Swap And Bridge Fee Mechanics

On the bridge and swap venues below, and on generic EVM signing, Vex takes a consistent fee: 25 basis points, 0.25%. What differs across venues is not the rate but the mechanics of how that 25 bps is taken, and some venues (plain transfers, and a few destructive wallet-signing lanes) take nothing at all. Reading a fee number off `vex_ToolDescribe` or an approval card without knowing which mechanics apply to that tool can mislead you about when the charge happens and what it is charged against.

#### Bridges (Khalani and Relay, via the internal tools)

`BridgeExecute` and `BridgeExecuteRelay`, the internal tools that actually sign and broadcast a bridge, both charge 25 bps (`BRIDGE_FEE_BPS`, `src/tools/bridge-fee/constants.ts:36`). `BridgeExecute` is not a separately-authored tool with its own fee logic: it is a pass-through alias that resolves to the exact same `khalani.bridge` handler as the protocol tool `khalani__bridge_execute` (`src/vex-agent/tools/mutating-aliases.ts:293, 416`, the return `{ toolId: "khalani.bridge", params }`), so the two names describe one code path and one fee.

Two things are both true and distinct: the bridge venue is quoted the net, post-fee amount, and the fee itself still leaves as its own separately signed and broadcast transfer, just not at the same moment as the deposit. `totalRaw` (what you asked to move) splits into `feeRaw` (Vex's cut) and `bridgedRaw = totalRaw - feeRaw` before the venue is ever quoted, so the venue only ever sees and quotes `bridgedRaw` (`src/tools/bridge-fee/fee-amount.ts:15-33`; the split happens "BEFORE the quote so the venue prices the amount it will actually receive," `src/vex-agent/tools/protocols/khalani/handlers/bridge-execute/quote.ts:84-88`). The fee itself is not collected in that same deposit transaction: it is signed, staged and broadcast as Vex's own separate transfer, run only after the deposit is confirmed and registered with the provider (`src/vex-agent/tools/protocols/khalani/handlers/bridge-execute/fee-leg.ts:55-59`). The tool's own manifest description says both halves in plain language: the 25 bps is "quoted INSIDE the amounts below so the output shown is what actually arrives" for the quote tool (`src/vex-agent/tools/protocols/khalani/manifest.ts:242-243`), and for the execute tool, Vex takes the 25 bps "as a SEPARATE transfer that runs after the deposit, so a bridge that never happens is never charged" (`src/vex-agent/tools/protocols/khalani/manifest.ts:362-363`). On dust-sized amounts where the 25 bps floors to zero, the fee leg is then skipped entirely rather than charging nothing meaningfully positive (`src/tools/bridge-fee/fee-amount.ts:29-33`).

The bridge destination is never a parameter you or an agent can set. Only `recipient` is enforced through the manifest's structured `rejectedParams` field on both `khalani__bridge_quote_get` and `khalani__bridge_execute` (`src/vex-agent/tools/protocols/khalani/manifest.ts:266-284, 294, 385-400, 415-419`); `refundTo`, `referrer` and `referrerFeeBps` are documented in the same manifest comments but are actually refused by name at runtime in `findCallerSuppliedForbiddenParam` and its destination-key counterpart, which reject `KHALANI_FORBIDDEN_FEE_PARAMS = ["referrer", "referrerFeeBps"]` and the derived-destination param `refundTo` (`src/tools/khalani/request.ts:103, 106, 139, 170`). All four are refused by name rather than silently dropped: the bridge always delivers to the wallet already selected for the project on the destination chain.

The machine-generated `exported-tools.md` table shows a documentation-generation gap worth naming: the protocol-named row `khalani__bridge_execute` shows `-` for `vex fee` (`src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md:114`), a blank in the structured column, even though the same tool's free-text manifest description states the 25 bps fee explicitly (cited above) and even though `BridgeExecute`/`BridgeExecuteRelay`, which route to the identical handler, are authored at `25 bps` in the same table (`exported-tools.md:58-59`). The fee is not unauthored or unknown; it is authored in the manifest's own description text and simply not mirrored into the structured `vex fee` column for the protocol-named row.

#### KyberSwap and Uniswap swaps

`SwapExecute` (the KyberSwap aggregator) and `SwapExecuteUniswap` are both internal tools authored at 25 bps. Unlike a bridge, KyberSwap's fee is not deducted up front by Vex code: it rides inside the router's own swap, computed and kept by the router, taken from the source token. The arithmetic is `computeKyberVexFeeRaw(amountInRaw) = floor(amountInRaw * KYBERSWAP_FEE_BPS / 10000)` (`src/tools/kyberswap/swap-vex-fee.ts:58-63`), and it truncates rather than rounds: a live probe with `amountIn = 10000300` returned a route swapping `9975300`, a fee of `25000` where round-half-up would have produced `25001` (`src/tools/kyberswap/swap-vex-fee.ts:31-38`).

Because the router computes this fee itself from calldata Vex builds, Vex proves the fee actually charged rather than assuming it, immediately before signing. `evm/swap-calldata-guard.ts` decodes the router calldata and refuses to sign unless every one of the following holds: `desc.amount` matches the approved input exactly (`src/tools/kyberswap/evm/swap-calldata-guard.ts:368-369`), `desc.feeAmounts` is exactly `[KYBERSWAP_FEE_BPS]` (`swap-calldata-guard.ts:377-378`), the fee-in-bps flag is set so the fee is a rate rather than an absolute unit (`swap-calldata-guard.ts:380-382`), the fee-on-destination flag is clear so the fee is charged on the source token, not the output (`swap-calldata-guard.ts:383`), and partial fill is forbidden, so a fee is never charged on input that ends up never swapped (`swap-calldata-guard.ts:387`).

#### Plain Send is free; generic signing is not

`WalletSendPrepare` and `WalletSendConfirm`, the dedicated wallet-to-wallet transfer tools, carry no Vex fee at all: `none` in the tool-surface spec (`exported-tools.md:75-76`). This is a deliberate product distinction, not an omission. The generic raw-transaction lane (`WalletEvmTransactionPrepare` / `WalletEvmTransactionConfirm`, used for arbitrary signed calldata) charges 25 bps of native value sent, `WALLET_TX_FEE_BPS = 25` (`src/vex-agent/tools/internal/wallet/transaction/vex-fee.ts:67`), collected as a separate transfer after the underlying transaction confirms and waived below the cost of collecting it. A plain wallet-to-wallet transfer through the dedicated Send tools bypasses that lane entirely and is free. Every other measured venue here (bridges, KyberSwap, and pools.fun launches (see [s6-launch-mechanics](#s6-launch-mechanics))) charges the same 25 bps rate, differing only in whether the deduction happens before the venue is quoted, inside the venue's own router, or as a separate post-confirm transfer.

| Venue | Rate | Where the cut happens |
| --- | --- | --- |
| Khalani / Relay bridge (internal tools) | 25 bps | deducted from input before the venue is quoted |
| `khalani__bridge_execute` (protocol tool) | 25 bps | same `khalani.bridge` handler as `BridgeExecute`; the structured `vex fee` column shows `-` but the manifest description states the rate |
| KyberSwap (`SwapExecute`) | 25 bps | inside the router's own swap, truncated, proven at sign time from decoded calldata |
| Uniswap (`SwapExecuteUniswap`) | 25 bps | authored in the tool-surface spec |
| Plain Send (`WalletSendPrepare`/`Confirm`) | none | no fee lane at all |
| Generic signing (`WalletEvmTransactionConfirm`) | 25 bps | separate post-confirm transfer, waived below collection cost |

### The pools.fun Launch: The Deepest Money Path

Launching a token on pools.fun is the deepest money path reachable from Vex Studio. The order below is the security contract, not an implementation detail.

#### The order of operations

`pools.launch_execute` runs a fixed sequence; each step exists because of what came before it and what has not happened yet (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:1-38`, the doc comment stating the order and its rationale):

1. **Boundary-validate every forbidden parameter by name.** A fee, a value, a recipient, a deadline, gas, a salt, a minimum output are not launch inputs, and each is rejected by name rather than silently ignored (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:134-141`, `src/vex-agent/tools/protocols/pools/handlers/launch/inputs.ts:1-19,73-97`).
2. **Resolve the wallet address only.** No key is touched here; the call can still be refused for a dozen honest reasons, and none of them should have unlocked a wallet (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:147-155`).
3. **Resolve the image bytes** on the surface that owns containment for that surface's parameter, before any wallet, authorization, or provider call - a refusal here costs nothing (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:167-172`).
4. **Resolve the authorization variant from host evidence, never from parameters.** This decides whether the call may sign at all, shared machinery across every launchpad Vex supports (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:174-179`).
5. **Only now is the wallet key decrypted, and never under `simulateOnly`.** A real launch opens the actual signing clients; `simulateOnly` takes only a read-only public client, so no key is ever touched (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:181-199`).
6. **Build the verified plan.** The image is uploaded once, the launch is prepared, chain reads are anchored to a single block, both a preflight and a fill simulation run, a gas ceiling is computed, the Vex fee is quoted, mission ceilings (if any) are applied, and all 15 verifier points run against the resulting calldata - all while no authorization exists yet (`src/vex-agent/tools/protocols/pools/handlers/launch/execute/plan.ts:1-20,253-394`, `src/tools/pools-fun/launch/verify-calldata.ts:2`).
7. **Authorize and CAS-consume the exact fingerprint of the verified bytes.** The intent is created already authorized, over the fingerprint the verifier just proved (`src/vex-agent/tools/protocols/pools/handlers/launch/execute/authorize.ts:109-176`).
8. **Broadcast that same fingerprint**, and nothing else, to the staged broadcaster.

`pools.fun`'s own `prepare` step mints a new IPFS metadata object and salt on every call, so a second `prepare` describes a different launch - approval binds to a fixed fingerprint of already-verified bytes rather than to something a later step could re-derive (`src/tools/pools-fun/launch/fingerprint.ts:1-18`).

#### simulateOnly: the whole path, stopped at the edge of signing

`simulateOnly` is not `dryRun`. `pools.launch_preview` is the advisory, side-effect-free estimate; `simulateOnly` runs the real prepare, the real anchored reads, the real verifier, and a real gas estimate over real calldata, and stops only at the point where a wallet key would otherwise be opened. It still has a real provider side effect (the prepare step pins an IPFS object and mines a salt), stated in the result (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:105-128`).

The stop is enforced twice. The handler checks `simulateOnly` before building the response and returns without creating an authorization or opening a signer (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:238-244`). Even though that return already happened, the plan carries the flag, and `authorizeAndConsumePoolsLaunch` - the function that creates the authorization - refuses a `simulateOnly` plan on its own, before any database transaction opens (`src/vex-agent/tools/protocols/pools/handlers/launch/execute/authorize.ts:75-89`): the "must never be signed" property is enforced by the code that creates the authorization, not only by the handler that calls it first.

#### The launch ban: V3 only, V1 and V2 deleted

pools.fun redeployed its factory, locker, and gateway contracts twice within three days (V1 to V2 on 2026-09-02, V2 to V3 on 2026-09-03), and keeps every generation reachable: a token registered under V1 is still claimable from the V1 locker (`src/tools/pools-fun/constants.ts:27-49`). Reads and claims span all three suites; launches do not. `POOLS_LAUNCH_SUITE_VERSION` is fixed to 3, and the V1 and V2 launch code paths are deleted from the codebase rather than kept disabled, because a second launch path is a second money path nobody exercises (`src/tools/pools-fun/constants.ts:48-51,121`).

The ban is enforced live, at signing time, against a suite table whose every row was proven by reading the actual chain: the gateway's `VERSION()` matches its table key, and gateway, factory, and locker each name each other, closing the triangle. The verifier refuses a gateway reporting any other version by name, stating that a suite Vex does not know carries a launch tuple the build cannot decode (`src/tools/pools-fun/launch/verify-calldata.ts:192-200`), and separately checks that the gateway's factory and the factory's locker each match the suite table before proceeding (`src/tools/pools-fun/launch/verify-calldata.ts:209-225`). Capability differs by suite too: V1 has no holder rewards and no stock pricing at all; V2 supports holder rewards in token mode only; V3 alone has all three fee-stream sentinels and signed-stock pricing (`src/tools/pools-fun/constants.ts:53-58`).

The same discipline extends to settlement decoding: when a launch or claim settles, the decoder resolving which contracts emitted the confirming event no longer trusts a caller-supplied gateway/factory pair - every hint resolves through the same closed suite table, and an unrecognized gateway, mismatched factory, or out-of-table locker is refused by name (`src/vex-agent/sync/pools-settlement-decoder.ts:188-201,608-627,644-667`, locker check at `:534-548`).

#### holderRewards: irreversible once set

The launch tool has no recipient parameter at all (`src/vex-agent/tools/protocols/pools/handlers/launch/inputs.ts:73-77`). By default the creator fee stream goes to the session wallet that launched the token; the tools carry no address parameter for it, and the verifier holds the signed tuple to exact equality with that wallet (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:212-224`). Setting `holderRewards: true` instead routes that stream to the token's own holders, and the choice is locked at launch: the creator keeps none of it for the token's life (`src/vex-agent/tools/protocols/pools/handlers/launch/inputs.ts:296-312`). The destination is proven against the gateway's own on-chain sentinel for the chosen mode (token, paired, or both), never taken from any input or local constant, and the transaction's fee-recipient field must match that sentinel exactly before signing (`src/tools/pools-fun/launch/verify-calldata.ts:805-850`).

#### Two-surface image design

Studio never accepts an image URL for a launch, on either surface: a URL could point at different bytes tomorrow than the ones a user approved today, so Vex always re-publishes the actual bytes itself to a content-addressed host, and the on-chain URL is the hash of the approved bytes (`src/vex-agent/tools/protocols/shared/launch-image-input.ts:1-30`).

| Surface | Parameter | Source |
|---|---|---|
| `in_app_form` | `imageId` | the user's own image locker |
| `studio_mcp` | `imagePath` | a file inside the project root, read through a no-follow reader |

Passing the wrong surface's parameter is refused by name, with a remedy sentence naming the correct one, rather than silently dropped (`src/vex-agent/tools/protocols/shared/launch-image-input.ts:112-127`).

Publishing is its own explicit step. `launchpads.image_publish` reads a project file through the same no-follow reader, uploads it to a content-addressed host, and records a durable row keyed by content id, so republishing identical bytes returns `alreadyPublished: true` (`src/vex-agent/tools/protocols/launchpads/handlers/image-publish.ts:17-19,191-192`). It signs nothing and spends no gas, but still carries its own approval card, because it makes the user's bytes publicly fetchable with no authentication until withdrawn: "These bytes are now public: anyone with the link can fetch this picture without signing in, and it stays hosted until it is withdrawn. The link is the picture's own sha256 hash, so it can never serve a different picture later." (`src/vex-agent/tools/protocols/launchpads/handlers/image-publish.ts:106-110`).

The launch tool itself never accepts a published URL either - it resolves the same `imagePath` selection independently, through the same no-follow reader, before any wallet or authorization step exists, folding the image upload into the verified plan above.

`requireImage: true` is set only on this executing leg, not on the preview or form-request tools (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:134-141`). An imageless launch is not a cosmetic gap: it renders permanently blank on the launchpad, a consequence traced by the code's own comment to a real incident on 2026-08-19, when an agent omitted the image, the launchpad pinned metadata with no image key, and the token rendered blank forever (`src/vex-agent/tools/protocols/shared/launch-image-input.ts:158-168`). Without a picture the tool refuses outright, because nobody can give a live token an image afterward.

#### Stock-pair quote windows

Tokenized stock pairs are priced by a backend-signed quote the factory only honours for that pair's own configured window, which an owner may set anywhere from 30 to 120 seconds (`src/tools/pools-fun/launch/verify-calldata.ts:89-91`). A launch against such a pair must go through while that quote is fresh; a stale quote is refused outright rather than sent to the chain to revert, since a revert would still cost gas for no result (`src/tools/pools-fun/launch/verify-calldata.ts:745-780`). Whether the resulting pool ends up liquid is unknown at launch time, and the tool does not claim otherwise.

#### What confirms

A successful call returns the new token address, its pool address, the transaction hash, the paired asset, the resolved fee recipient, the pinned metadata link, the exact amounts sent for the deployment fee and any prebuy, the tokens the prebuy actually bought, the outcome of the separate Vex fee transfer, and a status of `confirmed`, `reverted`, `pending`, or `confirmed_pending_identity` (`src/vex-agent/tools/protocols/pools/manifests/launch.ts:80-86`). A `reverted` launch created no token and charged no Vex fee. The two unproven states, `pending` and `confirmed_pending_identity`, never guess at a token address, and the same launch must not be attempted again while either stands.

### Virtuals And Lending Protocols

The `virtuals` namespace exports 13 tools (all `protocol`-lane; 9 readOnlyHint, 3 destructiveHint,
per `src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md:268-284` and
resolved/numbers.md) covering Virtuals Protocol bonding-curve trades and agent-token launches. Its
launch path never publishes image bytes itself: `virtuals.launch.execute`'s description states
plainly that the picture must already be public and that "nothing here publishes one"
(`src/vex-agent/tools/protocols/virtuals/manifests/launch.ts:222-223`). Both the
Virtuals launch preview and the pools.fun launch reuse the same content-addressed
`launchpads.image_publish` tool to get there: pass `imageId` in the Vex app or `imagePath` to a
project file over Studio, call `launchpads__image_publish` with that picture first, and only then
launch (`src/vex-agent/tools/protocols/virtuals/manifests/launch.ts:210-224`). `image_publish` is
`mutating: true`, `actionKind: "external_post"`, idempotent by content hash, and its own approval
card discloses that the bytes become permanently fetchable without authentication until withdrawn
(`src/vex-agent/tools/protocols/launchpads/handlers/image-publish.ts:1-24,106-110`). This is the same
publish tool (see [The pools.fun Launch: The Deepest Money Path](#the-pools-fun-launch-the-deepest-money-path)) pools.fun launches route through - one publish path, not a
second one per launchpad. A Virtuals launch also re-reads the chain and rebuilds the exact
`preLaunch` calldata before signing, refusing on a fingerprint mismatch against the preview rather
than re-pricing, and takes its fee (`VIRTUALS_LAUNCH_FEE_BPS`) as a separate transfer only after
the platform's own keeper transaction lands - waived permanently, never collected later, if the
keeper has not acted within Vex's bounded wait
(`src/vex-agent/tools/protocols/virtuals/manifests/launch.ts:210-236`).

On the lending side, `solana.lend.borrowOperate` (Jupiter Lend on Solana) carries a pre-approval
LTV and health-risk disclosure computed only when a human will actually see it: a restricted
session with the call not yet approved. This gate is disclosure-only. The owner's explicit ruling,
recorded in the code, is "DISCLOSE, DO NOT BLOCK" - a low or dangerous health ratio is shown in the
approval preview, never used to refuse a leveraged operation for want of a health number
(`src/vex-agent/tools/protocols/runtime/gates.ts:39-65`). Any error evaluating the preview still
blocks fail-closed, the same "any error blocks" doctrine the swap prequote gate uses, and an
existing-position lookup failure is treated identically to an unverifiable outcome
(`src/vex-agent/tools/protocols/runtime/gates.ts:49-65`).

Morpho (19 tools, 10 readOnlyHint) and Pendle (29 tools, 12 readOnlyHint) lending exist as
namespaces under `src/vex-agent/tools/protocols/morpho/` and `.../pendle/` (per-namespace counts
per resolved/numbers.md), and their mutating
operations share the same generic prequote and approval-gate machinery documented for swaps and
bridges (see [The Prequote Gate](#the-prequote-gate)). Beyond that shared ladder, their fee policy was not independently
traced against the shared bps split, and their Studio-specific behavior was not independently
verified in this pass - this is stated as lower-depth coverage, not asserted as identical to the
25 bps pattern seen elsewhere by assumption.

### Lighter: Perpetuals And Spot On Two Exchanges

`lighter` is the newest and largest protocol namespace: 40 manifests, all 40 exported
(`exported-tools.md`, `lighter__` rows). It is the first venue Vex reaches that is an ORDER-BOOK
EXCHANGE rather than an on-chain pool, so its money path has three legs a swap does not have -
funding an exchange account, registering a trading key, and authorizing the venue to charge Vex's
fee on fills - and each of those is its own approval.

#### Two environments, two settlement assets

Lighter runs as two independent deployments, and Vex treats them as two separate accounts with
separate onboarding, never as one venue with a network switch
(`src/tools/lighter/wallet-funding/deployments.ts:43-84`):

| Environment | Settlement chain | Settlement asset | Lighter signer domain | REST base |
|---|---|---|---|---|
| `core` (Lighter Core) | Ethereum mainnet, chain id 1 | USDC, 6 decimals, asset index 3 | chain id 304 | `https://mainnet.zklighter.elliot.ai` |
| `rhc` (Robinhood Chain) | Robinhood Chain mainnet, chain id 4663 | USDG, 6 decimals, asset index 3 | chain id 466324 | `https://api.rh.lighter.xyz` |

The settlement chain id and the Lighter signer chain id are deliberately distinct fields, and the
deployment constructor refuses a row where they are equal
(`deployments.ts:13-17,98-102`): a signed L2 message bound to the wrong domain would be a valid
signature for the wrong exchange.

#### What the 40 tools cover

- **Public market reads**: `markets_list`, `market_get`, `orderbook_get`, `recent_trades_list`,
  `candles_list`, `system_get`.
- **Account reads**: `account_get`, `positions_list`, `open_orders_list`, `order_history_list`,
  `trades_list`, `api_keys_inspect`, `account_onboarding_status`.
- **Previews**: `order_preview` and `position_protect` build a live-data-backed preview of one
  order, or of a stop-loss plus take-profit pair, and (once managed trading is ready) the approval
  card for it. Neither signs nor submits anything.
- **Order lifecycle**: `order_create` (including the native OCO pair described below),
  `order_cancel`, `order_modify`, `order_cancel_all`, `position_close`.
- **Account money legs**: `deposit`, `withdraw`, `withdraw_claim`.
- **Credential and fee**: `key_register`, `fees_approve`.
- **Status tools**: `deposit_status`, `order_status`, `key_register_status`, `fees_status`,
  `withdraw_status` - evidence-only reads that never sign, retry or broadcast.

Every mutating tool ships as a PAIR: a `_prepare` tool that builds a durable intent and returns the
approval card's contents, and the bare tool that resumes exactly that intent. `lighter__deposit`
and `lighter__deposit_prepare` are one such pair, and there are ten of them: deposit, withdraw,
withdraw_claim, key_register, fees_approve, order_create, order_cancel, order_cancel_all,
order_modify and position_close.

Two further Lighter tools are INTERNAL rather than protocol tools, and therefore always loaded:
`lighter_core_onboarding_status` and `lighter_rhc_onboarding_status`
(`src/vex-agent/mcp/inventory/titles.ts`). They exist because an agent that does not know
Lighter is a two-account venue would otherwise have to discover the namespace before it could find
out that the account is not funded yet; these two answer "can I trade here, and what is missing"
without a search step. They are the only protocol-specific rows in the hot set, and they are the
reason the internal count moved from 27 to 29.

#### How a mutating Lighter call becomes an approval

A prepared Lighter action does not create an approval by itself. The `_prepare` call writes a
durable intent and returns its contents; the bare call then resumes that exact intent, and
`admitStudioCall` recognises a Lighter result that is still pending approval, resolves the stored
prepared action, and refuses outright when the saved action is missing, expired, or inconsistent
rather than rebuilding one from the caller's arguments
(the prepared-approval branch of `admitStudioCall`, `src/vex-agent/mcp/admission.ts`). Nothing about the Studio surface changes this: the same
`executeProtocolTool` path, the same approval broker, and the same approval card serve the in-app
agent (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)).
The private key that signs a Lighter order is a locally generated Lighter API key held in the
encrypted vault; it is loaded only inside the privileged main process, and it is never returned
through the tool surface, persisted in Postgres, or written to a log
(`src/tools/lighter/trading-secret.ts`).

#### The Vex fee is charged by the exchange, not by Vex

Lighter is the one venue where Vex's fee is NOT a separate transfer Vex sends. Lighter supports a
native integrator fee: an order signed with Vex's integrator attributes carries Vex's collector
account and the maker and taker rates, and the EXCHANGE deducts them on the fill. The rates are
release constants on a 1,000,000 tick (`LIGHTER_FEE_TICK`, `LIGHTER_PERPS_FEE`,
`LIGHTER_SPOT_FEE` in `src/tools/lighter/fee-policy.ts`):

| Market type | Maker | Taker | Tick value |
|---|---|---|---|
| Perpetuals | 0.1% (10 bps) | 0.1% (10 bps) | 1000 |
| Spot | 0.25% (25 bps) | 0.25% (25 bps) | 2500 |

10 bps is Lighter's own documented maximum for perpetuals, so the perps rate cannot be raised
later without the provider rejecting it. The collector is one wallet on both environments,
`0x10Ce97Cf3142BE2a1a28aC83A55b21fDCE493C03`, holding Lighter account 743799 on Core and 22869 on
Robinhood Chain (`COLLECTORS` in `fee-policy.ts`); a collector row is only enabled after that
ownership is verified, and a malformed row throws rather than silently disabling the fee.

Because the exchange charges it, the fee needs its own standing authorization, and that
authorization is its own approval card. The card names the perpetual and spot rates as percentages
of executed trade value, the collector wallet AND its Lighter account, the exact trading account
being authorized, the ISO instant the authorization stops being valid, and the scope sentence
"Covers future VEX fills until expiry or revocation. Each trade still requires your normal
approval. Spot fees reduce the asset received."
(`buildLighterFeeAuthorizationDisclosure`,
`src/vex-agent/tools/protocols/lighter/fee-authorization-disclosure.ts`). The authorization
is valid for ten years (`LIGHTER_FEE_AUTHORIZATION_DURATION_MS`, `fee-policy.ts`) and is
revocable at any time: `lighter__fees_approve_prepare` with `revoke: true` builds the mirror card,
whose scope sentence is "Stop authorizing new VEX fee-bearing orders. Existing submitted orders
retain their signed terms." Accepting that card is what resumes `lighter__fees_approve`, which takes
only the prepared `intentId` and never a `revoke` flag of its own. A revocation stops future
fee-bearing orders; it cannot reach into an order already submitted under the old terms, and the
card says so rather than implying it can.

#### The account-tier requirement, and why it is on the same card

From 2026-09-14 Lighter rejects integrator-attributed trades and new integrator approvals from
Standard accounts. A Vex user therefore cannot open a fee-bearing Lighter position from a Standard
account, and the fee authorization is the moment that becomes true, so the tier change rides on the
same approval: the card carries an `accountChange` row reading "Change to Plus" on Core or "Change
to Premium" on Robinhood Chain, states that it applies to this wallet's Lighter account and its
subaccounts, and shows the exchange's own maker and taker fees for the target tier next to the
current ones (the `accountChange` and `exchangeFees` rows of
`buildLighterFeeAuthorizationDisclosure`). Core and Robinhood Chain get different
targets because Robinhood Chain has no Plus tier at all. The change is a real account change on
Lighter's side, not a Vex-local flag: Vex does not switch the tier back, the user can change the
account type in the Lighter app, an upgrade applies immediately, and a downgrade is allowed once 24
hours have passed since the last tier change.

#### Deposit consent: what is bound, and what is honestly not

Funding a Lighter account is an ordinary settlement-chain ERC-20 transfer to the exchange gateway,
and its approval card binds the deposit amount, the selected wallet, the settlement chain, the
gateway contract, the settlement asset, and the deposit-only scope. It deliberately does NOT bind a
numerical network-fee ceiling. The card states this in one sentence, "Network fees are selected at
execution.", and that sentence is the whole promise: after approval Vex re-reads the live preflight
beside each signer leg and signs with the current EIP-1559 estimate, so ordinary fee movement
between the card and execution does not invalidate consent. A four-times live-quote sanity boundary
exists inside the signer path only to reject abnormal provider values; it is derived after
approval, is not shown on the card, and is not a promise to the user. This is an explicit,
owner-signed exception to the usual rule that a money card binds every bound (owner decision
2026-09-07); the honest disclosure is what stands in for the missing ceiling. The deposit itself is
never complete from an L1 receipt alone: a confirmed Ethereum or Robinhood Chain receipt is
`deposit_l1_confirmed`, and only Lighter-side evidence for that exact L1 hash moves it to credited.

#### What Vex deliberately does not support

Native OCO protection is supported for one existing perpetual position: exactly one reduce-only
stop-loss and one same-size reduce-only take-profit, bound to one approval and one grouped
submission, reported active only after both child order identities are visible in authenticated
provider evidence. Vex never emulates the sibling cancellation and never retries an uncertain
grouped submission.

TWAP orders, OTO, OTOCO, and entry-with-attached-protection are NOT exported and are not emulated;
the `lighter__order_preview` description says so in the tool contract itself, and
`src/tools/lighter/Lighter.md` is the module's own home for that fact. Each of them would require Vex to hold standing authority
between two legs, or to invent a cancellation the venue does not guarantee, and neither is a thing
this surface does. An agent asking for one gets a refusal naming the unsupported shape, not a
best-effort approximation.

#### What an external agent can meet when a Lighter call does not complete

Lighter calls resolve into the same seven closed `StudioCallOutcome` kinds as every other Studio
tool (see [The Seven Outcomes An Agent Sees](#the-seven-outcomes-an-agent-sees)); there is no
Lighter-specific wire outcome. What is Lighter-specific is the vocabulary inside a refusal:

| Situation | What the agent is told |
|---|---|
| The prepared action is gone, expired, or does not match | "The saved Lighter action is missing, expired, or inconsistent. No approval was created. Prepare a fresh action." (`admission.ts`) |
| Consent expired before anything was reserved or signed | a typed refusal naming the expiry; nothing was reserved, nothing signed |
| Consent expired after signing but before submission | the signing evidence is retained, submission is refused, and the order is NEVER re-signed |
| The submission outcome is unknown | the intent stays ambiguous and is reconciled from provider evidence; it is never reported cancelled, never retried, and a later cancellation never overwrites a known provider result |
| The tier change succeeded but the fee approval did not submit | the partial effect is reported explicitly ("tier changed, fee authorization not submitted") rather than reported as one failure |
| A trigger is already crossed, or a post-only order would cross the refreshed book | refused at revalidation rather than sent |

The rule under all of these is the one that governs every Vex money path: an unknown outcome is a
state of its own, not a failure, and signing and submission never retry themselves.

Sources for the counts in this section: `src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md`
(the 40 `lighter__` rows and the Totals block).

### The Prequote Gate

`evaluatePrequoteGateDecision(toolId, params, scopedContext)` runs before the approval gate on every call through `executeProtocolTool`, for both the Studio MCP surface and the in-app agent surface, since both funnel through the same function (`src/vex-agent/tools/protocols/runtime/gates.ts:157-244`, invoked at `src/vex-agent/tools/protocols/runtime.ts:292`). A block from this gate short-circuits a call that would otherwise be queued for human approval; preview and `dryRun` calls are read-only simulation and are never gated (`gates.ts:146-147`).

The gate applies to whatever toolId is a key in `EXECUTE_GATE_TOOLS` (`src/vex-agent/tools/protocols/prequote/registry.ts:183-239`). The doc comment at `gates.ts:144-145` and the sessions-logging trace both describe this as "the three swap EXECUTEs (kind `swap`) and the Khalani bridge EXECUTE (kind `bridge`)", but that undercounts the current registry: `EXECUTE_GATE_TOOLS` also gates `virtuals.trade.execute`, four Pendle PT/YT buy and sell tools under the same `swap` kind (`pendle.pt.buy`, `pendle.pt.sell`, `pendle.yt.buy`, `pendle.yt.sell` - making the swap-kind gated set 8 tools, not 4), `relay.bridge` under kind `bridge`, and thirteen further Pendle and Morpho execute tools under their own kinds (`redeem`, `mint`, `redeem_py`, `lp_add`, `lp_remove`, `lend_deposit`, `lend_withdraw`, `lend_supply_collateral`, `lend_withdraw_collateral`, `lend_borrow`, `lend_repay` - eleven distinct kind labels, but `lend_deposit` and `lend_withdraw` are each shared by a vault-lane tool and a market-lane tool, so this group is 13 tools, not 11) (`registry.ts:183-239`). `morpho.rewards.claim` and `pendle.claim` are deliberately absent - an income sweep has no price or size for a prequote to bind (`registry.ts:203-204, 227-230`).

| Failure | Result |
|---|---|
| Any evaluator error (thrown or `PrequoteGateDecision.kind === "block"`) | fail-closed block: a thrown error is caught and converted inside `prequote/gate.ts:179-195`; a `kind === "block"` decision is forwarded at `gates.ts:164-169` |
| Bridge token-identity preview cannot confirm direct EVM symbol/decimals from the contract | block, remedy: re-check chain/token and quote again (`gates.ts:171-187`) |
| Bridge token preview not signing-ready while `approved \|\| permission !== "restricted"` | block (`gates.ts:188-201`) |
| Matched prequote row fresh but ineligible (`eligibilityKind`) | block, states the recorded eligibility (`prequote/gate.ts:90-97`) |
| Matched row is fee-bearing but carries no Vex fee statement | block, `fee_disclosure_missing` (`prequote/gate.ts:121-123`) |
| Approval-card debit plan disagrees with the sealed route snapshot | block (`prequote/gate.ts:134-141`) |

On allow, `readRowDisclosure(latest)` reads the matched database row once through the one function both the fresh call and the resumed dispatch use, producing `fotTax`, `termLock`, `feePreview`, `vexFee`, `quoteBinding`, and `spendability` (`prequote/gate.ts:112-115`). These, together with the `SafetyVerdict` and `bridgeTokenPreview`, travel on the typed `PrequoteGateDecision.allow` channel to the approval preview (`gates.ts:109-139`); nothing here is recomputed from the caller's arguments. `approvedPrequoteAuthorityFrom(latest.prequoteId, {...})` names which row was matched (`prequote/gate.ts:141-150`), and that same authority is checked again by `approvedRowBindingFailure`, which blocks the resumed dispatch after human approval if the bound row moved or its disclosure changed (`prequote/gate.ts:156-164`) - so an approval card cannot be shown one plan and execute a different one.

Reference notes: `error-handling.md`'s split between a tool-facing response and a middleware-inspectable error is not adopted verbatim (Vex's block reasons are a closed structural class, not a wrapped provider error type), but its principle of never collapsing distinct failure causes into one generic message matches this gate's per-reason block table. `mcp-server.md`'s framing of confirmation as policy the server owns, not the model, matches this gate's fail-closed default; its specific trust-level mechanism was not adopted since Vex's gate has no per-server trust tier, only session permission and freshness.


## Part 6 - Projects, Files, And The Installer

### What A Project Is

A Vex Studio project is a real folder on disk, not a database-only record. It lives under a projects root that defaults to `~/Vex/projects` (`DEFAULT_PROJECTS_ROOT`, `src/config/paths.ts:132`) unless you override it with an absolute `projectsRoot` in `config.json`; the module that owns this contract creates the root directory if it is missing and resolves it to a realpath before anything is written under it (`vex-app/src/main/studio/projects-root.ts:59`). Creating a project claims that folder exclusively (a non-recursive `mkdir`, so a name collision fails as "already exists" rather than merging into an existing directory, `vex-app/src/main/database/projects/create.ts:258-266`) and, in the same database transaction, writes one row each into three places: the `projects` table, a pair of `project_wallets` rows (one for `evm`, one for `solana`, both nullable), and a backing `sessions` row (`vex-app/src/main/database/projects/create.ts:214`, transaction body from `:276`). If any step of that transaction fails, the claimed directory is removed again as long as it is still empty; if anything landed inside it in the meantime, the removal is skipped, the directory is left in place, and the failure is logged rather than either silently deleted or silently kept (`create.ts:350-369`).

A project's scope is four things, all held on that one row: a **permission** (`restricted` or `full`, driving whether mutating actions need your approval), a **wallet selection per chain family** (one address for EVM, one for Solana, or none), a **`scopeVersion`** integer that starts at 1 (`src/vex-agent/mcp/project-scope.ts:34-56`), and an **agent roster** (`vex-app/src/shared/schemas/projects.ts:140-157`). The wallet selection is never a raw address typed into a form and trusted as-is: whatever wallet id the create or settings dialog sends is resolved against the real wallet inventory on the server side, both at project creation and at every scope edit, before any row is written. An id that does not resolve fails the entire request closed, with nothing written and no directory claimed on the create path (`vex-app/src/main/ipc/projects/wallet-refs.ts:20`, called from `vex-app/src/main/ipc/projects/create.ts:51`, and mirrored on the scope-update path at `vex-app/src/main/ipc/projects/scope.ts:34-44`).

The **backing session** is minted exactly once, at project creation, not per tool call. It is an ordinary row in the same `sessions` table used elsewhere in Vex, marked `mode='agent'` and `scope='vex_studio'`, and it mirrors the project's permission and wallet selection (`vex-app/src/main/database/projects/create.ts:152-176`, `vex-app/src/main/database/projects/scope.ts:233-260`). Every MCP tool call an external agent makes against the project resolves and reuses this one session; it is never created or claimed per call (`src/vex-agent/mcp/project-context.ts:93-98`).

Editing scope through the settings dialog is an optimistic-concurrency update: `scope_version = scope_version + 1` fires only inside an `UPDATE ... WHERE id = $1 AND scope_version = $2 AND deleted_at IS NULL` (`vex-app/src/main/database/projects/scope.ts:183-197`). The version compared there is always the value the caller was told about when their edit was admitted (the version stamped into the settings dialog when it opened), never a value the server re-reads from the row and then compares against that same fresh read; comparing a value against itself would always match and would defeat the whole point of the check. A stale version matches zero rows and is reported back as a distinct, named conflict rather than a generic failure, together with the version the caller thought they had and the version the row is actually on (`projects.scope_conflict`, `scope.ts:199-217`).

The same `scopeVersion` also travels with any in-flight approval: a Studio action enqueued for your decision carries the version it was admitted under, and if you change the project's permission or wallet selection before you decide (or before an already-approved action dispatches), the version mismatch is caught and the action is refused rather than run under authority that no longer applies (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)). Deleting a project follows a related but separate teardown that closes admission, drains in-flight calls, and only then commits the removal (see [s7-project-teardown](#s7-project-teardown)).

**Reference note.** The per-client MCP installation guides in `github-mcp-server` (`install-claude.md`, `install-codex.md`, `install-cursor.md`) describe a different layer, how an external agent client is configured to reach a server, and their config-block-per-client structure does not transfer to describing what a project itself is. `gemini-cli`'s "Configuration structure" section informed the choice to name the scope fields as one flat enumerated set rather than nested prose.

### The Exact Delete Order

#### Creation, so the delete order makes sense against it

`createProject` (`vex-app/src/main/database/projects/create.ts:214`) is the single owner of project creation: a filesystem claim followed by one database transaction, with a compensating rollback if the transaction fails. The IPC handler resolves wallet ids server-side before calling in (`resolveProjectWallets`, `vex-app/src/main/ipc/projects/wallet-refs.ts:20`, called at `vex-app/src/main/ipc/projects/create.ts:51`); an unknown wallet id fails closed with nothing written and no directory claimed.

The order inside `createProject`:

1. Derive the slug (`create.ts:219`); a refusal (reserved device name, or no usable characters) returns before anything touches disk.
2. `resolveProjectsRoot` (`vex-app/src/main/studio/projects-root.ts:59`) creates the configured root recursively if missing and returns its realpath; `resolveProjectDirectory` (`projects-root.ts:286`) then applies a defence-in-depth containment check.
3. The tombstone check, before the directory is claimed: `slugHeldByUnfinishedCleanup(slug)` (`create.ts:253`) queries for a soft-deleted project with this slug whose `cleanup_state` is still `pending` or `trash_pending`. The database's partial unique index frees a slug the instant a tombstone commits, but the filesystem claim still has to wait, because a tombstone whose remover has not finished still owns that folder and is about to delete entries from it (`create.ts:243-250`). A held slug returns the retryable `projects.slug_cleanup_pending`.
4. Exclusive, non-recursive `mkdir(directory)` (`create.ts:261`). `EEXIST` maps to `projects.slug_taken`; other errnos map to permission, out-of-space, or path-invalid errors, with any unmapped errno (including `ENOENT`) falling back to `projects.root_unavailable`.
5. One transaction (`create.ts:297-323`): `BEGIN`, `anchorProjectsRoot` as the first statement (it both writes the durable root anchor on the first project ever created and returns the stored anchor under a row lock on every later call, so nothing else is written before this project's root is proven to be the recorded one), `insertBackingSession` (a `mode='agent'`, `scope='vex_studio'` session with the wallet columns mirrored onto it), `insertProjectRows` (the `projects` row plus exactly two `project_wallets` rows, one per family, `evm` and `solana`, `null` meaning no selection), then `COMMIT`.
6. Any transaction failure triggers `compensateDirectoryClaim` (`create.ts:359`), a non-recursive `rmdir`; if something landed in the directory meanwhile, `rmdir` raises `ENOTEMPTY`, that is logged, and the directory is left in place rather than force-removed.

A unique-constraint violation on `slug` inside the transaction (Postgres code `23505`, a race between the directory claim and the insert) also reports `projects.slug_taken` (`create.ts:343`).

#### Deletion: the seven steps

`deleteProject` (`vex-app/src/main/studio/project-delete.ts:157`) is the end-to-end orchestrator; the database transaction in `vex-app/src/main/database/projects/delete.ts` is only the authority commit inside it. The seven-step order is documented at `project-delete.ts:1-67` and is the design, not an incidental sequence.

**Step 1 - close admission.** `closeProjectAdmission(projectId)` (`vex-app/src/main/studio/project-lifecycle-gate.ts:412`) runs first, synchronously, before any `await` (`project-delete.ts:166`). From this instant `acquireProjectLease` refuses every new lease request with `{ ok: false, reason: "project_deleting" }` unless the caller holds this project's minted deletion token, an unforgeable `ProjectDeletionToken` (object-identity capability, never serialized, `project-lifecycle-gate.ts:192-204`, checked by reference equality at `project-lifecycle-gate.ts:264`) minted or reused here. A repeated delete request on an unfinished tombstone gets the same token back.

**Step 2** is a reserved slot: no reversible observer exists yet in this stage, named so a future one is closed here rather than discovered missing later (`project-delete.ts:168`).

**Step 3 - drain.** `drainProjectLeases(projectId, PROJECT_DELETE_DRAIN_DEADLINE_MS)` (`project-lifecycle-gate.ts:461`) waits, with a 10-second deadline (`PROJECT_DELETE_DRAIN_DEADLINE_MS = 10_000`, `project-delete.ts:145`), for five lease classes to reach zero: `executingCall`, `dispatch`, `terminalCreate`, `terminalPersist`, `fileOperation`. `pendingApproval` is deliberately excluded; it parks instead, because the event that releases a parked approval is the refusal step 4/5 commits, so draining it here would wait on an event the wait itself blocks. On a drain timeout, `reopenProjectAdmission(projectId)` runs and the caller gets `{ outcome: "blocked_active_calls", count: drain.remaining }` (`project-delete.ts:175-178`); nothing has been written.

A cancellation check follows: before `BEGIN`, an aborted signal reopens admission for free and returns `projects.not_found` (`project-delete.ts:181-184`). Once `BEGIN` runs, the transaction goes to a terminal commit or rollback regardless of the caller's cancellation.

**Steps 4/5 - the authority transaction** (`tombstoneProject` calling `runDeleteTransaction`, `vex-app/src/main/database/projects/delete.ts:182`):

- Read `backing_session_id` before `BEGIN` (`delete.ts:196-200`); written once at creation and never updated, so reading it early keeps the session-control lock ahead of the project-row lock without risk of staleness.
- `BEGIN` (`delete.ts:202`), then `acquireSessionControlLockOn`, edge 0 of the global lock order (`delete.ts:207-209`), skipped only when there is no backing session.
- `assertProjectsRootUnchanged` (`vex-app/src/main/studio/projects-root.ts:246`); a mismatch rolls back with `projects.root_changed` or `projects.root_unverifiable`.
- `SELECT ... FOR UPDATE` the project row without the active-only predicate (`delete.ts:224-228`). A missing row returns `{ kind: "not_found" }`; a row already carrying `deleted_at` returns `{ kind: "already_tombstoned", slug, cleanupState, attempts }`, so a repeated delete request resumes cleanup rather than re-running the authority write. A typed name confirmation against the stored name follows; a mismatch reports as `not_found`, never its own error code.
- **Approved-not-started intents are settled first**: `SELECT approval_id, execution_status FROM approval_intents WHERE project_id=$1 AND origin='studio_mcp' AND decision='approved' AND execution_status IN ('not_started','dispatching') FOR UPDATE` (`delete.ts:259-271`). `refusePendingStudioIntents`, used two steps below, cannot see these rows, because its predicate is `decision IS NULL` and an approved row never matches that again. If any row is `dispatching` right now, the whole transaction aborts with `{ kind: "blocked_pending_dispatch" }` (`delete.ts:273-279`): a live dispatch's outcome belongs to the dispatcher and is never overwritten by a delete. Each remaining `not_started` row is settled through a dedicated compare-and-swap, `casRefuseStudioBeforeDispatchWith` (`src/vex-agent/db/repos/approval-intents/studio-settlement.ts:107`), with `refusalReason: "project_deleted"`, preserving the human's `approved` decision alongside the refusal - a pure database write with no event emitted, since an approved-not-started row is not parked waiting on anything. A zero-row result is an invariant failure, not a lost race (the row was locked `FOR UPDATE` moments earlier under this same transaction): the entire transaction rolls back rather than commit a tombstone behind a dispatchable action whose authority was just destroyed (`delete.ts:308-325`).
- **Only then** does `refusePendingStudioIntents(client, { projectId }, "project_deleted")` (`src/vex-agent/engine/core/approval-runtime/studio/refuse.ts:100`) settle every intent still `decision IS NULL`, through the engine primitive that also settles matching `approval_queue` rows (`delete.ts:328-337`).
- **Then** the backing session is soft-deleted: `UPDATE sessions SET deleted_at=NOW() WHERE id=$1 AND scope='vex_studio' AND deleted_at IS NULL` (`delete.ts:342-346`); the scope filter stops this path from ever touching an agent-mode session.
- **The project row is soft-deleted last**, per the lock order: `UPDATE projects SET deleted_at=NOW(), cleanup_state=$2, cleanup_attempts=0, cleanup_last_error=NULL ... WHERE id=$1 AND deleted_at IS NULL` (`delete.ts:354-363`), `cleanup_state` set to `trash_pending` if the folder was also requested to be trashed, otherwise `pending`.
- `COMMIT` (`delete.ts:371`). Only after `tombstoneProject` sees the inner transaction succeed does it call `announceStudioRefusals`, which releases parked `pendingApproval` calls; it fires only for the undecided rows refused above, never for the approved-not-started rows.

A migration comment summarizes the intent more narrowly than the actual sequence: "Project deletion is a later stage and refuses the project's pending intents first, deletes second" (`src/vex-agent/db/migrations/086_studio_approvals.sql:25-27`). The actual order has more steps: approved-not-started intents are settled through a distinct primitive before the undecided sweep runs, the backing session is soft-deleted between the two refusal sweeps and the project-row tombstone, and the project row is the last write of all.

**Step 6 - close resources, only after the tombstone has committed.** `closeProjectResources(projectId)` (`project-lifecycle-gate.ts:536`, called at `project-delete.ts:247`) runs every hook registered through `registerProjectCloseHook` (`project-lifecycle-gate.ts:525`), stored in an ordinary JavaScript `Set` and iterated in registration order. Three consumers register a hook this way: `TerminalDomain` (`vex-app/src/main/studio/terminals.ts:375`), `FilesDomain` (`vex-app/src/main/studio/files/files-domain.ts:278`), and `ProjectNameIndexes` (`vex-app/src/main/studio/search/name-index.ts:107`). All three are lazily-instantiated singletons created at first use during the running app session, so which hook fires first on a given delete depends on which subsystem was touched first in that session, not on a fixed startup order. The module's own doc comment claims the files-domain hook "runs behind every other close hook," but that holds only as a side effect of construction order in a given run; it is not enforced by `registerProjectCloseHook` or `closeProjectResources`, which carry no priority mechanism. What the code does structurally guarantee, and what the tests pin, is the boundary relative to the tombstone: hooks run only after the tombstone transaction has committed, and a hook failure is caught, logged, and never fails the delete - not a fixed order among the three hooks themselves.

**Step 7 - cleanup.** `runCleanup` enqueues a `"repair"` job on the project's own per-project installer queue (`project-delete.ts:289-311`), serializing behind any render already in flight for that project rather than racing a mid-write render. It is enqueued as `"repair"` specifically because a repair job is never superseded by a later queued job. Inside the job, an administrative `render` lease is acquired with the deletion token (an ordinary acquisition would be refused, since admission is closed, and that refusal is the point). The job resolves the root and directory, reads artifact provenance, and builds a teardown plan that unconditionally tears down four files - `AGENTS.md`, `.vex/vex-guide.md`, `CLAUDE.md`, `.vex/protocols.md` - plus every other artifact previously recorded as written. Reconciliation runs with `repair: false`, deliberately: a teardown is not a repair, so it must not silently overwrite a user's hand-edit; drifted content is kept, reported per artifact, and its ownership obligation is discharged rather than blocked. The terminal-revive snapshot is removed (its absence counts as success), and if `cleanup_state` was `trash_pending` the folder is trashed via `trashProjectFolder` (`project-delete.ts:604`), guarded so the realpath of the target must resolve to a direct child of the projects-root realpath - stopping a symlinked slug directory, or a root that moved between tombstone and cleanup, from trashing the wrong thing.

A repeated delete request on an existing tombstone resumes cleanup using the tombstone's own recorded `cleanup_state`, not the retry request's checkbox: the durable decision was made at the first deletion, and a retry is not a second chance to change it.

Cleanup failures never reach a terminal "failed" state. `failCleanup` (`project-delete.ts:569`) increments `cleanup_attempts` and keeps `cleanup_state` unchanged, because the obligation still stands. At `PROJECT_CLEANUP_STICKY_ATTEMPTS = 5` (`project-delete.ts:148`) attempts an error-level log line flags it for operator attention, but the row stays `pending` or `trash_pending` until it succeeds. The startup recovery owner, `repairUnfinishedProjectCleanups` (`project-delete.ts:680`), lists up to 50 unfinished tombstones (`vex-app/src/main/database/projects/delete.ts:390`) but retries at most 3 of them per app start (`project-delete.ts:694-701`); the rest wait for the next start or a user-initiated retry.

### What A Settings Edit Does - And Does Not Do

When you edit a project's permission level or wallet selection in the settings dialog, Vex does two things in one database transaction: it bumps the project's `scope_version` and it refuses every Studio approval that is still undecided (`vex-app/src/main/database/projects/scope.ts:172-178` for the refusal call, `:183-197` for the version bump, both inside the transaction opened at `:150` and closed at `:303`). The version bump is optimistic concurrency: the update statement matches rows on `id` and the version you started with, so if someone (or something) else edited the same project first, your edit is refused as a conflict rather than silently overwriting theirs (`vex-app/src/main/database/projects/scope.ts:183-217`). The refusal of undecided approvals happens through the same primitive the project-delete path uses, and its scope is precise: it settles rows that are still awaiting your decision, and skips everything else, enforced by the `AND decision IS NULL` predicate in `lockTargets` (`src/vex-agent/engine/core/approval-runtime/studio/refuse.ts:163`, `:174`, function spanning `:153-181`). A test pins the ordering directly: the pending approvals are refused inside the same transaction as the version bump, not in a follow-up write (`vex-app/src/main/database/__tests__/projects-db-scope.test.ts:604`).

#### What a scope edit does not touch

A settings edit is narrower than it might sound. The scope-update code path's import blocks (`vex-app/src/main/database/projects/scope.ts:49-80`, `vex-app/src/main/ipc/projects/scope.ts:10-25`) reference nothing from the in-process admission gate that project deletion uses - no lease acquisition, no drain, no admission close.

| Already in flight when you save | What a scope edit does |
|---|---|
| A tool call not yet started, still awaiting your Approve/Deny | Refused in the same transaction as the version bump |
| A call already approved but not yet dispatched | Left alone at the scope-edit transaction itself |
| A call currently executing or already dispatching | Left alone; no lease is drained or inspected |
| New calls arriving after the edit commits | Admitted normally under the new scope; admission was never closed |

The reason an already-approved row survives the scope-edit transaction is structural, not an oversight in that one code path: the refusal sweep only ever sees undecided intents, enforced by the `AND decision IS NULL` predicate in `lockTargets` (`src/vex-agent/engine/core/approval-runtime/studio/refuse.ts:163`, `:174`, function spanning `:153-181`), and an approved row is, by definition, no longer undecided.

#### Where the gap actually closes

That leaves one real question: if an action was approved but had not yet started dispatching when you changed the scope, does it dispatch under the old wallet? It does not, but the reason is not in the scope-edit transaction itself - it is one hop downstream, on the dispatch path. Immediately before a Studio dispatch commits, `runStudioDispatchGate` re-reads the project's live `scope_version` and compares it against the version recorded when the approval was first shown to you, inside the same short transaction that claims the dispatch slot (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:98`, `:149`, `:191`). A mismatch settles the row as refused with reason `scope_changed`, in that same transaction, before anything runs (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:191-215`). The same gate also re-checks whether the project was deleted in the meantime, for the parallel case (`:168-189`). Both this gate and the scope-edit transaction take the same session-control lock before touching the project row (`studio-gate.ts:108`, `scope.ts:156`, both calling into `src/vex-agent/engine/runtime/lease-and-status/session-control-lock.ts:105-138`), so there is no interleaving where the dispatch gate reads a scope version older than an edit that already committed.

This re-check only fires for rows the dispatch gate has not yet claimed. The claim itself is made by the dispatch gate calling `casClaimStudioDispatchSlotWith` (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:134-138`), whose update statement only accepts rows still in `execution_status = 'not_started'` (`src/vex-agent/db/repos/approval-intents/studio-settlement.ts:55-65`); a call that had already moved to `dispatching` before the scope edit landed has already passed this gate and is never re-checked - it runs to completion under whatever wallet and permission it already claimed. The project-delete path confirms the same rule for the identical state: a `dispatching` row is deliberately left running because "its outcome is still arriving and belongs to the dispatcher" (`vex-app/src/main/database/projects/delete.ts:272-278`). That is row 3 of the table above, restated: nothing recalls an in-flight dispatch.

That closure was traced end to end for this document by reading `studio-gate.ts` directly rather than relying on the field reference alone, and it holds: an approved-but-undispatched action does not dispatch under a wallet or permission selection you have since changed. This branch is pinned by name: `src/__tests__/vex-agent/engine/core/approval-runtime/studio/dispatch.test.ts:475`, `:794` assert the `scope_changed` refusal reason from a call through the real, unmocked dispatch gate. A separate test, `src/__tests__/integration/engine/studio-dispatch-gate.int.test.ts:360`, `:396`, pins the lock ordering between a scope edit's refusal of an undecided approval and a concurrent approve attempt on the same session, using the engine's refusal primitive directly rather than the dispatch gate itself.

What you see: if you approve an action, then change permissions or wallets before it runs, the agent's next report on that action says it was refused because the project's authorization changed - not that it silently ran under the old setting, and not that it silently vanished.

### The Projects Root And Its Anchor

Every Vex Studio project lives inside one shared folder, the projects root. By default that is `~/Vex/projects`; you can point it somewhere else with the `projectsRoot` field in `config.json`, but only as an absolute path (`vex-app/src/main/studio/projects-root.ts:10-13`). A relative or otherwise malformed value is ignored with a warning at config load, and Vex falls back to the default rather than guessing what you meant (`src/config/store.ts:296-308`, cited by `config-reference.md`'s Configuration table).

The root is created on demand: the first time it is needed, Vex makes the directory (recursively, since the root is a container Vex may create on your behalf) and resolves its real filesystem path (`vex-app/src/main/studio/projects-root.ts:59-65`). Individual project folders inside it are never created recursively; an occupied name is refused rather than reused.

#### Anchoring the root

The first time you ever create a project, Vex writes that resolved root into the database as a permanent anchor, in the single `INSERT INTO studio_settings (id, projects_root) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET updated_at = studio_settings.updated_at RETURNING projects_root` statement, run as the first statement inside the create transaction (`vex-app/src/main/studio/projects-root.ts:206-211`, `vex-app/src/main/database/projects/create.ts:302`). The `DO UPDATE` branch changes nothing; it exists only so `RETURNING` can hand back the already-stored root under a row lock on every creation after the first. A plain `SELECT` followed by `INSERT ... ON CONFLICT DO NOTHING` would leave a gap: a second app instance could commit a different root between the two statements, and `DO NOTHING` would then silently accept it. The single locked upsert closes that window.

Every other operation on a project (reading, deleting, changing scope) re-proves the anchor still holds, under a `SELECT ... FOR SHARE` lock held for the rest of that transaction (`vex-app/src/main/studio/projects-root.ts:246-260`).

#### How "same" is decided

Both the write side and the read side hand their comparison to one function, and it never compares text. It compares filesystem identity, the pair (`dev`, `ino`) that `stat` returns for a directory (`vex-app/src/main/studio/projects-root.ts:123-150`). A byte-identical string short-circuits to "same" without touching the disk; only a spelling difference costs two `stat` calls. This matters because Windows and default macOS volumes are case-insensitive: `C:\Users\Ada\Vex\projects` and `c:\users\ada\Vex\projects` name the same folder, and a string comparison would wrongly report that your root had moved.

There are three possible verdicts, not two:

| Verdict | Meaning | What happens |
|---|---|---|
| `same` | filesystem identity matches | operation proceeds |
| `different` | identity proven to differ | `projects.root_changed`, not retryable |
| `unprovable` | identity could not be established (a `stat` failure, or a volume reporting no file index, seen on some Windows network/FAT mounts) | `projects.root_unverifiable`, retryable |

`unprovable` is deliberately never folded into `same`: a comparison that could not be proven is a refusal, not an optimistic pass (`vex-app/src/main/studio/projects-root.ts:116-121`).

#### What you see, and what does not happen automatically

If the root is proven to have changed, Vex tells you directly: restore the previous projects root, or remove the `projectsRoot` override to return to the default. Moving the projects root is stated explicitly as a separate migration, not something Vex does for you as a side effect of editing a config field (`vex-app/src/main/studio/projects-root.ts:27-29`, message text at `vex-app/src/main/studio/project-errors.ts:48-57`). No automatic re-homing of existing project rows exists in the current code; a workflow for moving a populated projects root deliberately does not exist yet.

### How The Installer Reconciles Files

Every write into a project's coding-agent config files, `AGENTS.md`, `CLAUDE.md`, and `.vex/protocols.md` goes through one privileged entry point, `renderProjectFiles(projectId, trigger, correlationId)` (`vex-app/src/main/studio/installer.ts:112`). There is no second writer: create, a scope update (agents added or removed), and repair are all the same function with a different `trigger` value. A separate read-only function, `enrichProjectFiles` (`installer.ts:410`), recomputes each artifact's on-disk drift status on every project read; it is not memoized (`installer.ts:406-409`) because drift is a filesystem fact, not a cached one.

#### Queueing: single-flight per project, repair never superseded

`renderProjectFiles` does not run inline. It enqueues onto a per-project promise chain (`installer.ts:117`, `vex-app/src/main/studio/installer/queue.ts:62` `enqueueStudioRender`). One project renders at a time: two concurrent renders would both read the same config file and both replace it, which the source check below would turn into a spurious `source_changed` refusal for a perfectly valid edit (`queue.ts:1-14`).

An `update` job whose sequence number has gone stale by the time it reaches the front of the chain reports `superseded` and touches no file at all (`queue.ts:70-79`); its result is `{ scopeVersion: 1, completed: false, trigger: "superseded", artifacts: [], warnings: [], runFailure: null }` (`installer.ts:126-133`). This is not an error: a newer update reloads the latest committed scope and reconciles a superset of what the stale job would have done, so a burst of edits produces one render, not five. A **repair job is never superseded** (`queue.ts:24-26`) - it is the only trigger that can overwrite a drifted artifact, so letting a routine edit cancel it would silently drop the one thing the user asked for. The queue is process-local only; cross-instance races are caught by the source-hash check in the confined filesystem layer, not here (`queue.ts:28-30`).

#### Two reconcile passes, in a fixed order

Inside one admitted run, the reconciler makes two passes over the plan (`installer.ts:228-283`, walked at `installer.ts:243-334`):

1. **Pass 1**: every artifact except `vex-guide`, using a brief built from the current change notes (no pending note yet).
2. Between passes, the installer decides whether the guide needs rewriting even with nothing new to say (`vexGuideNeedsRewrite`, `installer.ts:473-499`) or because pass 1 already changed something. If either is true, it composes a `pendingNote` and prepends it to the guide's brief.
3. **Pass 2**: `vex-guide` alone, with `pendingNote` prepended to the notes (or the note-free brief if none was needed).

The split exists because the guide's "This file" / "What's new" section promises that every regeneration which changed something adds a change-note line describing *that run*, not the next one; rendering the guide in the same pass as everything else would make it describe a note it cannot yet see. Once both passes settle, outcomes merge back into plan order and a `changed` flag is computed from any `written`/`removed` outcome (`installer.ts:339-346`). If `changed`, one change note is appended from the actual outcomes, not from `pendingNote`, in case the guide itself refused to write (`installer.ts:376-390`).

#### Format-specific rewriting: edits, not round trips

The per-format renderers in `src/vex-agent/studio/installer/render/` never parse-and-reserialize a whole file:

- **JSON/JSONC** (`json-file.ts`) uses `jsonc-parser`'s `modify()`/`applyEdits()` to apply minimal text edits against the original bytes, so comments, formatting, and unrelated keys survive byte for byte. A parse failure refuses `malformed_json`; a whitespace-only file is treated as absent and installs like a fresh one.
- **TOML** (`toml-file.ts`) does section-level text replacement: it replaces exactly the Vex-owned section's text and leaves every other byte, including a foreign `[permission]` section, untouched. It refuses `toml_multiline_string` outright if the file contains `"""` or `'''` anywhere (`toml-file.ts:214`), because a `[header]`-looking line inside a multi-line string is indistinguishable from a real section header to a line scanner. `smol-toml`'s `parse()` runs first as a validator only, before any text scan, to catch a broken file the scanner would otherwise sail through and corrupt for the client (`toml-file.ts:174-192`, enforced at the call sites `toml-file.ts:85-89` and `toml-file.ts:128-131`).

#### Ownership must be proved before any touch

No Vex-owned region is ever overwritten because a hash "looks right" from the plan. `readStudioOwnedRegion` reads the existing bytes, and the decision tree in `reconcile.ts:545-664` runs before any write, in two stages.

First, and regardless of trigger or recorded state: if the region's on-disk bytes already equal a fresh render of the desired content, the artifact is adopted as `unchanged` (`reconcile.ts:591-593`). This is the code's own "finalize what the disk already proves" branch - it exists so a crash between a file write and its provenance commit does not refuse the entry as a collision forever, since a byte-identical entry is a no-op to write anyway.

Only when disk bytes differ from the desired render does the code compare against the recorded hash:

| Disk state (bytes differ from desired render) | No recorded hash | Recorded hash matches disk | Recorded hash differs from disk (drift) |
|---|---|---|---|
| Region absent | fresh install | - | - |
| Region present, ordinary update | `refused: provenance_collision` (foreign entry, not proven ours) | ordinary update: writes the fresh render (`reconcile.ts:658-663`) | `refused: provenance_collision` |
| Region present, `trigger: repair` | still refused (never fires without a recorded hash) | **takeover**: writes the fresh render (`reconcile.ts:618-625`) | **takeover**: merge/remove regardless of drift |

Under `repair`, the takeover branch is gated only on the recorded hash being non-null, not on whether drift is present (`reconcile.ts:618`) - so repair always rewrites a stale-but-undrifted entry to the fresh render, the same as an ordinary update would, just without needing to prove no-drift first.

Repair can only take over an entry whose recorded hash is not null, one Vex itself proved it wrote at some point; it never seizes a stranger's entry. Outside `repair`, drift is never silently overwritten (`reconcile.ts:27-30`). A distinct `unknown_keys_in_vex_entry` refusal fires when a proven Vex entry has grown fields Vex never writes; the offending keys are named, never deleted. A parallel adoption gate blocks every `remove` decision against a provenance row whose origin is `"adopted"` rather than `"written"` (`reconcile.ts:492-522`) - bytes already on disk before Vex ever touched them are never deleted, even during a project teardown.

#### Confined writes to disk

The actual write happens in `replaceConfinedFile` (`vex-app/src/main/studio/installer/confined-fs.ts:345-448`):

1. Containment is revalidated against the resolved path.
2. The target directory is created if missing, and the identity (device and inode) of every ancestor directory is captured immediately after.
3. The existing bytes are re-read and re-hashed and compared against the expected hash; a mismatch refuses `source_changed` ("changed on disk while Vex was preparing its update... run the repair again") rather than overwriting.
4. Text is written to an exclusive `wx | O_NOFOLLOW` temp file in the same directory, `fsync`'d before rename so a crash cannot leave an empty file, then the original file mode is reapplied.
5. `renameIntoPlace` re-verifies the captured directory-chain identity immediately before every rename attempt, retrying only `EPERM`/`EACCES`/`EBUSY` at 20/45/90 ms jittered delays before exhausting to `file_locked`.

Symlink defense runs at every path segment: `lstat`, never `stat`, so the check cannot be fooled by following the very symlink it is inspecting. The one gap named rather than claimed closed, on the write/rename path this section walks: the microseconds between the final directory-chain recheck and the actual `rename` syscall are not covered, because `rename(2)` re-resolves its path from the root and Node exposes no `renameat`/`openat2` (`confined-fs.ts:41-47`). The delete path (`deleteConfinedFile`) carries the same residual for `unlink`: Node exposes no `unlinkat` either, so the microseconds before that syscall are likewise not covered (`confined-fs.ts:260-262`). What is fully closed, on both paths, is any symlink swap during the whole read-parse-render (or decide-read-verify) window, and any swap up to the last recheck before the syscall.

#### What a refusal means to the reader

Every refusal is a named, reportable outcome with a detail string, never a silent skip and never a clobber. The closed set of reasons (`vex-app/src/shared/schemas/studio-installer.ts:64-100`) includes `provenance_collision`, `unknown_keys_in_vex_entry`, `source_changed`, `symlinked_path`, `not_a_regular_file`, `too_large`, `invalid_utf8`, `ambiguous_twin`, `path_escape`, `io_error`, and `file_locked`, plus the three malformed-file reasons (`malformed_json`, `malformed_toml`, `malformed_managed_block` - the last for `AGENTS.md` having a begin marker with no end, or the reverse) and `toml_multiline_string` above. `drift_blocked` is a status, not a reason: the artifact was reconciled to the decision "leave it alone" because of an edit, and always tells the reader to run Repair or remove the entry by hand.

(see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)) covers when a repair run is triggered from the project UI, and how `completed` differs from "every artifact reconciled" when the scope moved mid-run.

### The Files A Project Gets

When you install Vex Studio into a project, more lands on disk than the config file for whichever coding agent you picked. Four project-level files are written every time, regardless of which agents you selected, because they describe the project itself rather than any one client (`vex-app/src/main/studio/installer/plan.ts:153-188`):

| File | Purpose |
|---|---|
| `AGENTS.md` | The authority core - the managed instruction block every coding agent reads whether or not its own config was written. |
| `.vex/vex-guide.md` | The rest of the protocol: what changed in this Vex version, which protocol namespaces are available in this project, what an app built on them inherits, how to report a bug. Split out because it does not fit inside the review's roughly 32 KiB `AGENTS.md` budget (`vex-app/src/main/studio/installer/plan.ts:164-166`). |
| `CLAUDE.md` | Two import lines so Claude Code picks up the two files above. |
| `.vex/protocols.md` | A generated reference for the protocol tools this project has access to. |

On top of those four, Vex writes one additional config file per agent you selected in the picker, in that agent's own format and location.

#### `CLAUDE.md`'s fresh content

`CLAUDE.md` is not managed the way `AGENTS.md` and the guide are: it has no fenced block with a hash comment, just two import lines Vex checks for the presence of. A fresh file gets a short explanatory paragraph followed by exactly those two lines (`src/vex-agent/studio/installer/render/__goldens__/CLAUDE.fresh.md`):

```
@AGENTS.md
@.vex/vex-guide.md
```

If you delete one of these lines yourself, Vex treats it as a deliberate edit and leaves it gone until you run Repair; only Repair puts a deleted import line back (`vex-app/src/main/studio/installer/reconcile.ts:909-936`). If a project was set up before the guide file existed, its `CLAUDE.md` will have only the `@AGENTS.md` line, and Vex adds the guide import rather than treating the missing second line as something you deleted - it distinguishes "you deleted this" from "this project predates it" by hashing the import set Vex last wrote (`src/vex-agent/studio/installer/render/claude-md.ts:47-61,84-88`). `CLAUDE.md` itself is never deleted, even if every Vex-managed line is later removed from it (`vex-app/src/main/studio/installer/reconcile.ts:840-849`).

#### The agent roster

Vex recognizes 15 coding-agent ids. 13 of them have a real writer: 12 get a project-scoped config file written directly into the repository, and Kimi gets a config file plus a launch flag (`kimi --mcp-config-file {configPath}`) because Kimi has no project-scope config location of its own - the file alone does nothing until you launch Kimi pointing at it. The remaining 2, Cline and Warp, are honestly unsupported: both clients only read a single user-global config file, and writing that file from inside one project would silently reconfigure every other repository on your machine, so Vex refuses to do it (`src/vex-agent/studio/agents.ts:735-765`). Support for either returns only if the vendor ships a project-scoped or launch-flag MCP mechanism.

#### Timeouts written into each client's config

An approval you have not answered expires after one hour (`APPROVAL_TTL_MS = 60 * 60 * 1000` ms, `src/vex-agent/engine/core/approval-runtime/enqueue.ts:118`). Every client whose config format has a tool-call timeout field gets a value 5 minutes past that, so a slow approval does not get cut off by the client's own timeout before you can answer it:

| Client | Mechanism | Value written |
|---|---|---|
| Codex CLI | `tool_timeout_sec` (TOML integer) | `3900` (`src/vex-agent/studio/agents.ts:361-368`) |
| Gemini CLI, opencode, Qwen Code, GitHub Copilot CLI, Factory Droid | `timeout` (milliseconds) | `3900000` (`src/vex-agent/studio/agents.ts:398-406, 426-434, 528-539, 559-573, 714-725`) |
| Mistral Vibe | `tool_timeout_sec` (TOML float) | `3900.0` - written as a float literal because the field is typed as one (`src/vex-agent/studio/agents.ts:680-685`) |
| Grok Build | vendor default | nothing written - its 6000-second default already clears the 3900-second bound, so Vex leaves it alone (`src/vex-agent/studio/agents.ts:459-467`) |
| Claude Code | client-env (`MCP_TOOL_TIMEOUT`) | nothing written - this bound lives in your own shell environment, not a project file Vex can touch; Claude Code's documented default is roughly 28 hours (`src/vex-agent/studio/agents.ts:311-333`) |
| Kimi | user-global config (`~/.kimi/config.toml`) | nothing written - only that global file can raise Kimi's 60-second default, and no project file reaches it; Vex surfaces a warning telling you to set it yourself (`src/vex-agent/studio/agents.ts:481-503`) |
| Cursor, Amp, Kiro | unverified | nothing written - no documented tool-call timeout mechanism was found for any of these three after two source passes; this is recorded as an owed live probe, not asserted as "no timeout exists" (`src/vex-agent/studio/agents.ts:598-604, 625-630, 650-655`) |

Every one of the 3900-second writes is measured against the same one-hour approval window; the number is not a per-client tuning choice, it is the same 65-minute floor expressed in whatever unit and type that client's config format wants.

#### What Vex never writes

Every writable agent's record also carries a list of fields that would grant tool authority, pre-approve calls, or assert trust - Vex never emits any of them into a rendered file, and a foreign occurrence of one placed there by you (or another tool) beside Vex's own entry is left untouched and reported back as a warning rather than removed (`src/vex-agent/studio/agents.ts:176-182`).

### What The Installer Never Writes

The installer's server-entry writers are built against a closed, per-dialect key allowlist, not an open object the code happens to populate conservatively. `STUDIO_ENTRY_KEY_ALLOWLIST` enumerates, per dialect, every key a Vex-written entry can ever contain: `mcp-servers-json` gets `type`, `command`, `args`, `timeout`; `opencode-json` gets `type`, `command`, `timeout`; `mcp-servers-toml-table` gets `command`, `args`, `tool_timeout_sec`; `mcp-servers-toml-array` adds `name` to that same set (`src/vex-agent/studio/installer/render/entry.ts:33-38`). `buildStudioEntryFields` hardcodes exactly these fields per dialect in a switch on `agent.dialect` (`entry.ts:57-91`); it does not read `STUDIO_ENTRY_KEY_ALLOWLIST` at runtime. `entry-allowlist.test.ts` proves mechanically that every key any builder emits is a member of the allowlist, and that no member of the allowlist is also a field on the writing agent's own `neverWritten` list - so there is no code path that can produce `autoApprove`, `tools: ["*"]`, `trust`, a `[permission]` rule, or an `env` map. Gemini CLI's own `neverWritten` list for its dialect is `["trust", "folderTrust"]` (`agents.ts:407`); it never lists `env` because the allowlist for that dialect never contains it to begin with.

The `env` omission is not a rule the writers happen to follow; it is structural. `StudioProjectFacts`, the one input every renderer receives, is `{ projectId: string; bridgeCommand: string }` and carries no environment field at all (`src/vex-agent/studio/installer/render/facts.ts:25-33`). The bridge locates the Vex socket itself from the platform's config directory, so no per-client environment variable ever needs to travel through the written config. This is the same reason no client-side `MCP_TOOL_TIMEOUT`-style env var is ever set for a client whose timeout mechanism lives in its own process environment (`client-env` in `StudioTimeoutMechanism`, `agents.ts:83`; claude-code's `MCP_TOOL_TIMEOUT` instance at `agents.ts:321-334`) - there is no `env` key in the allowlist for a renderer to write it into even if a caller tried.

`neverWritten` is the closed set, per agent, of fields that would grant tool authority, pre-approve calls, or assert trust in that agent's own dialect (`src/vex-agent/studio/agents.ts:170-190`). The writers never emit any of them. When a foreign entry beside Vex's own already declares one of those fields (a TOML section header, a JSON key), `detectForeignAuthority` matches on the declaration line - not a mention inside a comment or a string - and reports it as a `foreign_authority_section` warning (`vex-app/src/main/studio/installer/warnings.ts:126-152`). The bytes themselves are never touched: this is the user's own statement about their own file, and Vex only surfaces that the Vex server is covered by it too.

A teardown carries the same discipline into deletion. Before removing anything, `decideDesiredText`'s adoption gate checks the provenance row for that artifact: an `origin` of `"adopted"` means the bytes matched a fresh Vex render the first time Vex looked, which is exactly what a `vex` entry or an `@AGENTS.md` import line the user wrote before ever installing Vex leaves behind. Only a row recorded as `"written"` - proof Vex put the bytes there - authorizes a remove; an adopted row is refused with `provenance_collision` and the content is left in place (`vex-app/src/main/studio/installer/reconcile.ts:492-522`).

### The Files Domain: Tree, Read, Watch, Mutate

The project tree in Studio - listing directories, reading files into the viewer, live file-change
notifications, and creating/renaming/deleting entries - is served by one main-process singleton,
`filesDomain()` (`vex-app/src/main/studio/files/files-composition.ts:74-96`), through nine IPC
channels under `CH.files.*` - `listChildren`, `readFile`, `watchFile`, `unwatchFile`, `ackEvent`,
`create`, `rename`, `delete`, `revealInFileManager` (`vex-app/src/shared/ipc/channels/requests.ts:700-713`,
registered `vex-app/src/main/ipc/studio-files.ts:71-172`). The `FilesBridge` preload gate
(`vex-app/src/preload/shell/files.ts:120-187`) exposes its own nine methods over those channels:
`listChildren`, `readFile`, `watchFile`, `unwatchFile`, `revealInFileManager`, `createNode`,
`renameNode`, `deleteNode`, and the `onFilesEvent` push subscription - `ackEvent` is flow control
sent by preload itself, not exposed to renderer code (`vex-app/src/preload/shell/files.ts:104-112`).

#### No path ever crosses the trust boundary

Every request addresses an opaque HMAC-signed node token, never a filesystem path (`node-id.ts`).
The token is a name, not an authority: on every call the handler re-derives the real answer from
the project database row and the project lifecycle gate before touching the filesystem
(`files-domain.ts:9-17`). The signing key is 32 random bytes minted once per
process and never persisted, so a token cannot outlive the run or replay into another instance
(`node-id.ts:67`).

The authority chain run on every list/read/watch/reveal call, `locate` (`files-domain.ts:294-355`),
does this in order: snapshot the project's node-token epoch before the first `await`; read the
active project row (fails closed to `project_closed` on a missing or tombstoned project); re-check
the epoch is unchanged (a delete that committed mid-await already bumped it); prove the project
directory sits, un-symlinked, directly under the anchored realpath root; and, if a node token was
given, verify its HMAC and walk the recovered relative path segment by segment with `lstat`,
refusing an intermediate symlink (`symlinked_path`) or missing parent (`not_found`), while allowing
the final segment to be a symlink (shown, never opened). **Publication fence:** authority is
re-checked a second time after the async filesystem work completes and before any bytes leave the
process (`listChildren`: `files-domain.ts:416-419`; `readFile`: `files-domain.ts:450-455`), so a
project deleted mid-read is refused after the fact rather than allowed to publish stale content.

#### Watching

`watchFile` is refused immediately if the domain is not admitting new subscriptions, or if the
requesting window is already at `FILES_SUBSCRIPTIONS_PER_WINDOW_MAX = 64` (`subscription_limit`,
counting settled subscriptions plus in-flight watches to close a burst race,
`files-domain.ts:586-621`) - a generous headroom number, not a load-tested one. A watch joins an
existing native `ProjectFileWatcher` or creates one, refusing new native watchers once
`FILES_WATCHERS_MAX = 8` projects are watched at once (`watcher_limit`, `files-domain.ts:756-762`).
After the possibly-async native subscribe, a second publication fence re-checks that the project is
still open and the window still waiting before the subscription is confirmed
(`files-domain.ts:644-664`).

Native change events flow through a bounded pipeline: a raw-event buffer capped at 20,000, folded
eagerly when hit, a 75 ms aggregation window, coalescing (bounded at 5,000 pending changes, drops
counted beyond that), a 200 ms emit throttle, and a cap of 500 changes per batch
(`watcher.ts:295-749`). `fanOut` then applies per-subscription backpressure: once a subscription
has `FILES_EVENTS_OUTSTANDING_MAX = 32` un-acked `changed` batches, further batches are withheld
and counted rather than delivered (`files-domain.ts:812-833`); `status` and `resync` events are
never withheld. Preload acknowledges one `changed` batch per callback return; once a subscription's un-acked count drops back under the cap, the ack that does it pays back exactly one `resync{reason:"consumer_backlog"}`, never one per withheld batch and never on an ordinary ack (`files-domain.ts:850-883`).

#### Excludes and ignore files

Listings and the native watcher apply the same default excludes - `.git, node_modules, dist,
target, .next, .turbo, .venv, __pycache__, .pytest_cache, .gradle, .idea, .DS_Store`
(`excludes.ts:93-106`) - as the shallowest level of an ignore chain a project's own `.gitignore`
and `.vexignore` files extend, shallowest-first, deepest-opinion-wins (`isPathIgnored`,
`excludes.ts:313-328`). Un-hiding a default exclude in `.vexignore` changes what the tree shows but
not what the watcher ignores, since the watcher's own ignore glob list is installed verbatim from
the same default names (`nativeWatcherIgnores`, `excludes.ts:129-135`). An ignore file larger than 256 KiB is skipped and named in `oversizeIgnoreFiles`, logged once per
file - keyed on project and relative path together, so a second oversize file in the same project
is still named (`excludes.ts:233-247`, `reportOversizeIgnoreFile`). A symlinked ignore file takes a different
path: `readIgnoreFile` has no branch for the "absent" outcome that a symlinked-open refusal folds
into, so it falls through to `{ text: null, oversize: false }` - the file is silently treated as if
it does not exist, not named and not logged, per the module's own stated design ("A SYMLINKED
ignore file is treated as absent", `excludes.ts:44-48`).

#### Mutations

`createNode`, `renameNode`, and `deleteNode` re-derive the target location under a per-project
write lock (`ProjectWriteLock`, `mutations.ts:220-284`), bounded by 10,000 ms
(`FILES_MUTATION_TIMEOUT_MS`); timing out returns `mutation_busy` with nothing written
(`mutations.ts:559-565`). All three refuse a target under a Vex-managed path, derived from the
installer's own agent registry rather than a hand-maintained list (`isVexManagedPath`,
`mutations.ts:147-191`), and refuse the project root itself (deleting or renaming the project is
the lifecycle's job, not the tree's). Create uses a kernel-exclusive `mkdir`/`open(..., "wx")` with
no pre-check window (`mutations.ts:391,395`); rename can only target `dirname(source) + name`,
never an arbitrary destination (`mutations.ts:447`). `mode: "trash"` uses the platform trash API,
and a trash failure leaves the entry untouched (`trash_unavailable`) - it never falls back to
permanent delete (`mutations.ts:479-533`).

#### Epoch fence on project delete

The node-token epoch is one integer per project, bumped only by the project lifecycle gate's close
hook, which bumps the epoch **before** disposing the project's watcher
(`files-domain.ts:956-1001`). The ordering is safety-critical: the header at that call site records
that it was changed from bump-last to bump-first specifically to close a window in which a read
parked mid-flight in filesystem work could pass a stale authority fence and publish bytes from an
already-deleted project. Every `locate()` call snapshots the epoch before its first `await` and
re-checks it afterward for exactly this reason.

#### Error contract

All twenty-four read/list/watch/mutation error codes (for example `project_closed`, `invalid_node`,
`symlinked_path`, `too_large`, `binary`, `invalid_utf8`, `mutation_busy`, `trash_unavailable`)
travel inside a successful `Result` as a discriminated outcome, never a transport error - the
domain distinguishes "this file is binary" from an actual infrastructure failure
(`filesOutcomeSchema`, `files.ts:547-559`). No filesystem error message, stack trace, or absolute
path crosses the IPC boundary; main logs only `name=<Error.name> code=<errno>`
(`node-path.ts:296-302`).

### No-Follow Readers: How Untrusted Paths Are Read Safely

Two features open a file path that lives inside a directory the user's own
tools can freely rewrite: the Studio file viewer opening a project file the
user clicked, and a coding agent on the Studio MCP surface naming an
`imagePath` for a launch. Both aim at the same guarantee - the bytes returned
are the bytes of the regular file the path named, not of whatever a symbolic
link was pointed at at the moment of the check - and Vex implements that
guarantee **twice, deliberately not shared**, because the two callers
sit on opposite sides of the trust boundary and are tuned for different
things: the vex-app reader serves the viewer and the `.gitignore` reader
inside the privileged main process, while the agent-side reader is the
containment boundary for a path a model supplied on an MCP tool call
(`vex-app/src/main/studio/files/no-follow-open.ts:1-27`,
`src/vex-agent/studio/files/no-follow-open.ts:1-42`).

| | `vex-app` reader | agent-side reader |
|---|---|---|
| Owner | `vex-app/src/main/studio/files/no-follow-open.ts` | `src/vex-agent/studio/files/no-follow-open.ts` |
| Callers | viewer `readFile` (`read.ts:81-171`), `.gitignore` reader (`excludes.ts:184-198`, via `bounded-read.ts:73-116`) | `resolveProjectFileLaunchImage`, launch-image path (`launch-image-input.ts:219-279`) |
| Mechanism | `lstat` before open, then open, then `fstat`(handle)/`lstat`(path) identity proof, `{bigint:true}` on both stats (`no-follow-open.ts:173-249`) | `O_NOFOLLOW` open (`no-follow-open.ts:284-313`), then `/proc/self/fd/<fd>` (Linux) or `realpath` + `(dev,ino)` fallback for containment after open (`no-follow-open.ts:370-396`) |
| Content bound | viewer: `FILE_READ_MAX_BYTES`, 2 MiB (`read.ts:62`, `shared/schemas/files.ts:80`); `.gitignore` reader: a separate, smaller `IGNORE_FILE_MAX_BYTES`, 256 KiB (`excludes.ts:119`) | `NO_FOLLOW_IMAGE_MAX_BYTES` = 2,097,152 bytes, refused `too_large` with the real size (`no-follow-open.ts:55,186-189`) |
| Format check | none (text decode only) | magic-byte sniff, PNG/JPEG/WebP/GIF only, extension never consulted (`no-follow-open.ts:431-437`) |

`FILE_READ_MAX_BYTES` and `NO_FOLLOW_IMAGE_MAX_BYTES` both equal 2 MiB but are
independent constants in independent files; a change to one will not
propagate to the other. The `.gitignore` reader's bound is a third,
unrelated constant at a different size: `IGNORE_FILE_MAX_BYTES` is 256 KiB,
because a `.gitignore` three orders of magnitude larger than a few KB is not
a rule list (`excludes.ts:114-119`).

Both readers close the "standing symlink" case, but the residual each names
is not the same window. The vex-app reader names two: ReFS's 128-bit file
IDs are called out explicitly as a case Node's `bigint` stat cannot
disambiguate, and the completion window after the post-`lstat` identity
proof is stated as not covered by a repeated stat, though the handle is
already bound to an inode so a later rename or link cannot change what it
reads (`vex-app/src/main/studio/files/no-follow-open.ts:55-71`). The
agent-side reader's residual is narrower and earlier: a path-based
`realpath` fallback (used only where `/proc` is unavailable) leaves a window
on an INTERMEDIATE directory symlink between the `realpath` call and the
`(dev,ino)` comparison, before the read - not the same shape as the
vex-app reader's post-verification window
(`src/vex-agent/studio/files/no-follow-open.ts:29-44`).

**Windows has no `O_NOFOLLOW`.** Node 22 does not define the flag on win32.
The vex-app module's header records a measured regression from the previous
version, which trusted `O_NOFOLLOW ?? 0` as harmless there: a symlinked
`.gitignore` was proven to be followed and applied on a Windows CI runner,
because Developer Mode makes unprivileged symlink creation ordinary
(`no-follow-open.ts:12-22`). The fix is `lstat` before the open plus a
post-open `fstat`/`lstat` identity proof, stated in the module header as
fail-closed **verification**, explicitly not claimed atomic
(`no-follow-open.ts:24-29`). `O_NONBLOCK` is present in both readers as a
liveness guard, not a performance one: without it, opening a FIFO with no
writer parks a libuv threadpool thread indefinitely
(`vex-app/src/main/studio/files/no-follow-open.ts:36-39`;
`src/vex-agent/studio/files/no-follow-open.ts:301-307`).

**The agent-side reader's Windows fallback is weaker than the vex-app
reader's fix, and the code says so.** Where `O_NOFOLLOW` is undefined, the
agent-side reader's `openWithoutFollowing` falls back to a plain
check-then-open: an `lstat` before the open, then the open, with no
post-open path-based `lstat` afterward to catch a link created in the gap.
The code's own comment states this directly: the guard "is strictly WEAKER:
it is a check-then-open, so a link created in between would be followed"
(`src/vex-agent/studio/files/no-follow-open.ts:287-291`). The post-open
containment check that follows, `resolveOpenFile`, does not close this gap
either: on Linux it reads `/proc/self/fd/<fd>`, a property of the open
handle, but its non-Linux fallback compares a fresh `realpath` of the
candidate path against the handle's stat, and a link created in the
check-then-open window is followed by both the open and the later
`realpath` alike, so the two resolve to the same target and compare equal
(`src/vex-agent/studio/files/no-follow-open.ts:370-396`). This is narrower
than the vex-app reader's fix, which adds a post-open path-based `lstat`
that does catch a link created after its own pre-open check; the agent-side
reader has no equivalent step on Windows.

The two surfaces also refuse each other's image parameter by name. A launch
running on the Studio MCP surface accepts `imagePath` and refuses a supplied
`imageId` by name; a launch running as an in-app form accepts `imageId` and
refuses a supplied `imagePath` by name - neither parameter is silently
dropped (`launch-image-input.ts:102-127`). The design note in the same file
gives the reasoning, not a named incident: silently ignoring the wrong-surface
parameter would launch a token with the wrong picture, or none, while the
agent believed it had chosen one (`launch-image-input.ts:31-33`). The file's
one named, dated incident is a different, related refusal: when no picture is
given at all, `missingImageReason` refuses rather than warns because of THE
PPV INCIDENT (2026-08-19), where an agent omitted the image, the launchpad
pinned metadata with no image key, and the token rendered blank forever
(`launch-image-input.ts:155-161`).


## Part 7 - The In-App Studio Workspace

### The In-App Studio Workspace

Vex Studio's in-app workspace has shipped in full: a working project shell with a terminal, a file explorer, a file viewer, and combined project-and-file search, not a reserved seat waiting on a future release. Some of Vex's own documentation, on the landing site and in an older internal doc, still describes the workspace as a locked, disabled control with a "coming soon" tooltip and the panes as a future stage. That description is stale; the code, its own inline history comment, and a real end-to-end test suite all say otherwise.

#### The Agent | Studio toggle

The switch between Vex's two shells is the `Agent | Studio` control at the top of the app. It is built as an accessible `role="radiogroup"` of two real `role="radio"` buttons, not a static label or a disabled button: the checked segment is the group's single tab stop, and the left/right (or up/down) arrow keys move focus between the two segments and select as they go, the standard roving-tabindex pattern for a radio group (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:66-104`). The component's own header comment records the change directly: "LIVE since stage B4a... the Studio segment used to be a disabled button wearing a lock and a 'coming soon' title... Both are now real radios in a `role="radiogroup"`" (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:1-17`). The same toggle mounts in both shells, in the agent session's welcome hero and in the Studio welcome screen and sidebar, so the way back is identical wherever the user currently is (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:6-11`; `vex-app/src/renderer/features/appShell/studio/sidebar/StudioSidebar.tsx:618`). Choosing a mode is a UI intent only: it decides which surfaces mount and grants no authority of its own, and every privileged Studio action is still checked in the main process before it runs (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:19-23`).

#### The four panes

Once a project is open, Studio presents four working panes:

| Pane | What it does |
|---|---|
| Projects rail | Lists open and recent projects and hosts the file explorer for the active one |
| Terminal | Runs real shells (ptys) inside the selected project, in tabs |
| File viewer | Opens and displays project files, with syntax highlighting |
| Search | One combined field returning both project matches and file matches across the project |

The projects rail and the file explorer share one column; opening search replaces that browsing region rather than covering it, so nothing underneath is obscured mid-search.

#### Keeping projects alive across a session

Studio does not tear a project's workspace down the moment you switch away from it. It holds up to four project workspaces mounted at once, kept in the order they were opened (insertion order, never re-sorted), with a live terminal and an expanded file tree preserved for each while only one is visible at a time (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:4-7,22-32,36`). Reselecting an already-mounted project only moves which one is visible; it does not reorder the set or restart anything (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:86-95`).

When a fifth project is requested while four are already held, Studio refuses the request rather than closing one of the four to make room: closing a kept-alive workspace could destroy a running terminal or unsaved state the user never asked to lose, so the workspace stays in place and the app surfaces an explicit "close one first" prompt for the user to choose from (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:96-113`). This four-project bound is a separate limit from the four-terminal-group cap inside a single project; the two happen to share a number but are not the same quantity.

#### Restoring across a relaunch

A closed and reopened Vex window comes back to where the user left it inside Studio, not just to the Studio mode itself. This is proven end to end by a Playwright test named `RESTORE-1`, which opens a project, opens a terminal (waiting for it to report running), opens a file from the explorer, switches to the agent shell by keyboard and back to Studio by clicking the toggle, then relaunches the whole built application. On the second boot the test asserts, against the real running app: Studio mode is restored with no click, the same project's workspace is mounted and visible rather than the welcome screen, the same file tab is back by name, the same number of terminal tabs is back, and keyboard focus lands back on the terminal input with no further gesture required (`vex-app/e2e/studio-states.spec.ts:1692`). The same test also covers a real edge case: a file deleted from disk between the two boots is correctly dropped from the restored tab strip rather than reappearing as a broken tab.

#### How this is verified

Mode switching, project selection, and the workspace as a whole are exercised by a real Playwright end-to-end suite running against a built copy of the app, a real Postgres database, and the real local bridge process, not mocks or a fixture server. `studio-states.spec.ts` alone walks project creation, terminal spawn, file open, explorer mutation, search, and the relaunch-restore path above as numbered scenarios in one test file (`vex-app/e2e/studio-states.spec.ts`). Component and unit tests separately pin the keep-alive rules, the terminal tab model, file-tab persistence, and the explorer's own state machine, each in its owning directory under `vex-app/src/renderer/features/appShell/studio/`.

### Opening, Closing, And Keeping Projects Alive

Vex Studio keeps up to four project workspaces mounted at once, even while you are only looking at one of them. The others sit hidden, not closed: their terminals keep running and their file explorers keep their state, so switching back to a project you had open a minute ago finds it exactly as you left it. This set is called the keep-alive set, and it is refused rather than emptied when it is full - opening a fifth project never quietly closes one of your first four to make room (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:36`).

#### Opening a project

Clicking a project in the sidebar, or the "Open" row on the Studio welcome screen, tries to select it. Three things can happen:

| Situation | Result |
|---|---|
| Project is already one of the kept-alive four | Only the pointer moves; nothing reopens, nothing reorders (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:88-97`). |
| Project is new and fewer than 4 are kept alive | It is appended to the set and becomes active (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:98-115`). |
| Project is new and 4 are already kept alive | The selection is refused. Vex Studio stays pointed at whatever was active before (`vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx:230-231`), and a dialog opens asking you to close one first. |

That dialog names the bound and, next to each of the four open projects, how many terminals closing it would stop: "No running terminals", "Closes 1 running terminal", or "Closes N running terminals". When Vex Studio cannot see the count for a project, that line is left off entirely rather than shown as zero, so an unknown count never gets misread as an empty one (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:499-500`, `vex-app/src/renderer/features/appShell/studio/StudioKeepAliveDialog.tsx:132-140`).

#### Closing a project

Closing (from the dialog above, or from a workspace's own close control) does the state-saving work before it does the stopping work: it commits a snapshot of the terminal layout while every terminal in that project is still running, and only after that snapshot is committed does it end the terminals (`vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx:342`, comment at lines 323-327 names this "The AWAIT is the contract"). Reversing that order would tear down the only thing that still knew the layout while it was being written.

If the close fails, nothing is lost: the project stays in the kept-alive set exactly as it was, and if it was not already the one you were looking at, Vex Studio makes it active so its own error is the thing you see, rather than an error sitting behind a hidden workspace nobody is looking at (`vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx:365-370`). Only once a close succeeds does the project leave the keep-alive set (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:126-136`).

#### Deleting a project

Deleting a project is a separate action from closing one, reachable through the project's own delete dialog, and it is stricter: the workspace's whole lifecycle is discarded synchronously, before any part of the screen unmounts. That ordering matters because an unmount runs its own teardown, and that teardown would otherwise try to write one last terminal-layout snapshot for a project that has just been deleted, recreating a file that should no longer exist. Latching the workspace first stops that write at the source (`vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx:392-401`). This latch is a courtesy, not the real guard: Vex's main process independently refuses to persist a workspace snapshot for a deleted project regardless of what the screen does, so the guarantee holds even if the screen is compromised or behaves unexpectedly (`vex-app/src/main/studio/terminals.ts:1087-1097`).

Deletion can also happen somewhere Vex Studio was not watching - another window, or the project simply no longer being in the list the next time it is fetched. A separate repair path handles that case: once the project list has actually loaded (not while it is loading or has failed to load, since reconciling against an incomplete list would close workspaces on every network hiccup), any kept-alive project no longer in that list leaves the set, and if the currently active project is one of them, the view falls back to the Studio welcome screen. The order of the projects that remain is left untouched (`vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:150-172`).

#### When one project's workspace breaks

Each of the up-to-four open workspaces renders inside its own error boundary, so a problem in one project's saved layout cannot take the other open projects down with it (`vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx:632-649`). If a workspace does throw, its fallback offers to return to the Studio welcome screen; choosing that only changes which project you are looking at. The broken project stays in the kept-alive set and its terminals, which live outside the part of the app that crashed, keep running underneath (`vex-app/src/renderer/features/appShell/studio/StudioCenter.tsx:654-674`).

### Search: Projects And Files

Studio's sidebar carries one search field over two kinds of thing: your projects and the open project's files. Opening it (the "Search projects and files" button, or focusing the combobox) shows two result groups, **Projects** and **Files**, and closing, clearing, and opening the search are three separate controls rather than one control doing double duty (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:307-310`).

The Files half used to answer only from folders you had already expanded in the explorer. It now answers from a name index that Vex's main process walks once, the first time you open search in a session, covering every file in the project rather than only the loaded ones (`vex-app/src/shared/schemas/studio-search.ts:1-43`). That index is not kept live: it is built when search opens and reused for every keystroke until you reopen it, the same lifetime VS Code's own quick-open cache uses and for a related reason - standing up a second recursive filesystem watch just for search would double the watch descriptors on a path already treated as a failure point elsewhere in Studio (`vex-app/src/shared/schemas/studio-search.ts:9-29`). The result merges that index with whatever the explorer tree has already loaded, and when both sides know about the same file, the already-visible row wins (`vex-app/src/renderer/features/appShell/studio/sidebar/rail-search-model.ts:8-22`).

Every bound on this search is reported on screen rather than applied silently:

| Bound | Value | Citation |
|---|---|---|
| Files one index will hold | 50,000 | `vex-app/src/shared/schemas/studio-search.ts:71` |
| Candidates that get a full fuzzy score | 2,048 | `vex-app/src/shared/schemas/studio-search.ts:86` |
| Result page: max / default | 100 / 20 | `vex-app/src/shared/schemas/studio-search.ts:89-92` |
| Index-age notice threshold | 30 s | `vex-app/src/shared/schemas/studio-search.ts:127` |

A project larger than the file cap shows "This project is larger than the search index. Only the first N files are searched." rather than a quietly incomplete list (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:366-368`). An index built more than 30 seconds ago is dated on screen ("Searched N files, indexed Ns/min ago. Reopen the search to pick up new files."), so a file you just created and cannot find has a stated reason and a stated remedy rather than reading as search being broken (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:339-357`).

Opening a search result replaces the browsing region rather than sitting on top of it: the explorer pane hides (it stays mounted, with its own expanded folders preserved) while the results list takes its place, and closing search brings the explorer back (`vex-app/e2e/studio-states.rail-parity.ts:516-535`).

### Terminal Tabs And Keyboard Behavior

This layer decides which tabs a project workspace can hold and which key press does what, separately from the pty processes those tabs run.

#### Tab and terminal group bounds

A project workspace refuses new work past two independent bounds rather than closing something to make room. Both are checked before the thing they bound is created, so a refusal never leaves an orphan behind.

| Bound | Value | On limit | Citation |
|---|---|---|---|
| Live terminal groups per project | 4 (`WORKSPACE_TERMINAL_GROUPS_MAX`) | refuses a new group | `vex-app/src/renderer/features/appShell/studio/workspace/types.ts:42` |
| Open file tabs per project | 16 (`STUDIO_FILE_TABS_MAX`) | refuses a new tab | `vex-app/src/renderer/features/appShell/studio/workspace/types.ts:66` |

`canAddTerminalGroup(state, pending)` answers "can one more open" before any pty exists, counting groups already in the tab strip plus opens already in flight. A controller that created the pty first and asked afterward would have nowhere to put a refused fifth terminal: a running shell attached to no pane and visible in no tab. Asking first means a refusal creates nothing at all (`vex-app/src/renderer/features/appShell/studio/workspace/workspace-model.ts:70`).

This bound is separate from the 4-project keep-alive limit on how many project workspaces stay mounted at once in the same window; the two happen to share a value but are enforced independently.

Tab selection follows one rule: creating a tab selects it, and closing a tab selects its left neighbour, falling back to the right, and `null` only when nothing remains. Selecting the right neighbour first would march the active tab toward the end of the strip as a run of tabs closes; a selection naming a tab that no longer exists is always repaired to the first tab rather than left dangling (`vex-app/src/renderer/features/appShell/studio/workspace/workspace-model.ts:9-19`).

#### Keyboard shortcuts

Studio's shortcuts are resolved from a closed table keyed on `KeyboardEvent.code`, the physical key, rather than `key`, the character a layout produces, so a shortcut works the same on a US and a French keyboard. Two behaviors matter for what a user experiences:

- **A modal dialog suspends every Studio shortcut.** `resolveStudioKeybinding` returns no intent while a dialog is open (`vex-app/src/renderer/features/appShell/studio/keybindings.ts:418`), so the key press is not swallowed; it reaches the dialog's own handlers untouched. This is why a `Ctrl+W` cannot close a tab underneath an open delete-confirmation dialog while a decision is pending.
- **Alt always disqualifies a match.** `modifiersMatch` rejects any event with `altKey` set (`vex-app/src/renderer/features/appShell/studio/keybindings.ts:389`). On many European keyboard layouts, AltGr sets both `ctrlKey` and `altKey`, and typing an AltGr character (Polish "e with an ogonek", German "@") produces such an event. A resolver that only checked `ctrlKey` would swallow those keystrokes into a Studio shortcut and the user could not type the character.

#### Dangerous-action dialogs default focus to Cancel

Every dialog whose confirm action can end running work, closing a kept-alive project workspace, deleting a project, repairing a project's managed config, opens with keyboard focus on its safe control, never on the destructive one. The keep-alive dialog states the reasoning at its own Cancel button: without the explicit initial-focus assignment, the dialog would open with focus on the first project's Close button, a control that ends every terminal running in that project (`vex-app/src/renderer/features/appShell/studio/StudioKeepAliveDialog.tsx:164-167`). None of these dialogs offer a "do not ask again" option.

### The File Viewer And Syntax Highlighting

Opening a file in the Studio workspace runs two separate systems: the file viewer, which reads the bytes and refuses the ones it should not show, and a background highlight worker, which colors text the viewer has already accepted. They fail independently, so a dead highlighter never takes a readable file down with it.

#### What the viewer will and will not open

The viewer loads a file only up to 2 MiB; a larger file is refused rather than partially loaded (`vex-app/src/renderer/features/appShell/studio/viewer/viewer-copy.ts:66-70`, `vex-app/src/shared/schemas/files.ts:80`). Before treating bytes as text, it checks the first bytes for a NUL and refuses the file as binary on a match, and it refuses a file that is not valid UTF-8 rather than guessing an encoding or inventing characters (`vex-app/src/renderer/features/appShell/studio/viewer/viewer-copy.ts:72-75`). Every one of these refusals - the size ceiling, the binary check, symlinked paths, non-regular files - is decided in the privileged main process against bytes main actually read, never guessed at by the renderer from metadata.

There is deliberately no "open anyway" button for any of these refusals, stated twice in the source, once on the component and once on the copy module: the renderer cannot grant itself a capability main declined, so a button that appeared to would be a lie about who decides (`vex-app/src/renderer/features/appShell/studio/viewer/FileViewer.tsx:15-18`, `vex-app/src/renderer/features/appShell/studio/viewer/viewer-copy.ts:17-24`). A refused file shows the refusal by name and nothing else.

A separate failure class covers a read that never got an answer at all - a transport failure between the renderer and the file service. That state shows a Retry button, since retrying can succeed where a refusal never will (`vex-app/src/renderer/features/appShell/studio/viewer/file-viewer-session.ts:10-20`).

#### The highlight worker

Once a file is readable, Vex separately decides whether to colorize it. Highlighting runs in one shared background worker for the whole window, one file at a time - not one worker per open tab (`vex-app/src/renderer/features/appShell/studio/viewer/file-viewer-registry.ts:95-115,299-301`). Two independent ceilings both fall back to plain text rather than refusing the file: a file over 512 KiB is shown in full, uncolored, with the chip naming why (`vex-app/src/renderer/features/appShell/studio/viewer/file-viewer-session.ts:113`); and a file that would tokenize past 250,000 tokens falls back the same way. That token bound was measured against the installed tokenizer, not guessed: ordinary TypeScript runs at about 122 tokens per KiB, so a file at the 512 KiB byte ceiling produces roughly 62,000 tokens, well under the 250,000-token bound; densely punctuated JSON runs at about 645 tokens per KiB, which at the same 512 KiB byte ceiling would itself produce roughly 330,000 tokens - past the token bound. The token bound exists precisely to catch that shape independently of the byte ceiling, since a file smaller than 512 KiB but token-dense could still exceed 250,000 tokens before ever reaching the byte limit (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlight-protocol.ts:50-59,75`). The bound is enforced primarily inside the worker while it builds the token list, so an oversized result is never finished or sent back across the process boundary; the viewer's own recount on receipt is a cheap defense against a future bug in that projection, not the real enforcement.

A hidden tab never holds a request in the shared worker. Going hidden defers the highlight and cancels any request already in flight for that tab; becoming visible again re-issues it. This is the deliberate mechanism, not an incidental effect, that keeps N open tabs from putting N tokenizations through one worker thread - at most one request is outstanding per tab (`vex-app/src/renderer/features/appShell/studio/viewer/file-viewer-session.ts:458-491`), and the worker runs only one job at a time because coloring code is CPU-bound single-threaded work (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlight-queue.ts:14-15`).

Because a running job cannot be interrupted mid-line, a newly-visible tab can wait behind whatever a hidden tab was already tokenizing. This was measured directly on 512 KiB inputs, the largest a file reaches before falling back to plain text:

| sample | worst observed | tokens produced |
|---|---|---|
| TypeScript source, 512 KiB | 1144.6 ms | 51,678 |
| dense JSON, 512 KiB | 477.4 ms | 230,510 |

The accepted ceiling for this wait is 1500 ms. Preempting the running job - killing and rebuilding the worker to jump the queue - was explicitly considered and rejected as a worse deal than the wait it would remove, since it turns one slow tokenization into a lost one plus a full worker restart. What would reopen that decision, named directly in the source: the 512 KiB bound growing, a materially slower grammar joining the supported set, or a tokenizing-engine upgrade (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlight-queue.ts:31-66`).

The worker also carries a restart budget of 3. If it crashes or fails to construct three times, the port gives up permanently for the rest of that renderer process's life - no periodic retry, no reset short of reloading the app. Every request after that answers immediately `worker_unavailable`, and the file stays fully readable as plain text; only its coloring is gone (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlighter-port.ts:57-64,495-504`).

#### What never becomes HTML

File bytes are always rendered as React text nodes, never as HTML, regardless of source, enforced by an automated build gate that fails the build if `dangerouslySetInnerHTML` appears anywhere in renderer source (`vex-app/src/renderer/features/appShell/studio/viewer/FileViewerLines.tsx:4-12`, `vex-app/scripts/check-build-artifacts.mjs:222-264`). The worker's own boundary is pinned the same way: it loads from a static, pre-built URL under a Content-Security-Policy restricting worker sources to the app's own origin, never a dynamically constructed `blob:` URL, named directly in the build gate as how injected code would otherwise run past a strict script policy (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlighter-port.ts:190-200`, `vex-app/vite.renderer.config.ts:45`, `vex-app/scripts/check-privileged-bundles.mjs:461-478`). Both gates run as part of the build-artifact check that ships with every release.

Worth naming precisely: the worker is Vex's own compiled code, shipped in the same bundle as the rest of the renderer, and the main-thread-to-worker boundary is explicitly documented as a process boundary, not a trust boundary (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlight-protocol.ts:1-11`). The strict checks run on every worker response - exact line-count match against the source, in-range strictly-ascending line numbers, bounded list lengths - defend against a future bug in Vex's own code, not an adversarial worker (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlighter-port.ts:425-454,525-548`). What genuinely is untrusted, and treated as such, is the file content itself: arbitrary bytes from a project file, possibly written by an agent or any other process. That text reaches the worker's regex-based tokenizer, and a class of bug called catastrophic backtracking can make crafted input pathologically slow; the defense is a per-line time budget inside the worker, so the worst case is a highlight that arrives late, never a renderer that stops responding (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/shiki-tokenizer.ts:297-307`).

#### Language choice and secret files

Which grammar to use is chosen from the file's path alone - its name and extension - never from sniffing content (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/language-of-path.ts:1-43`). Guessing from content was explicitly rejected: a wrong guess would paint a Python file as shell, reading as more confidently wrong than no color at all. One exception runs the other way: the exact name `.env` is hardcoded to plain text so a syntax grammar never visually emphasizes the value half of a `KEY=value` line as if it were an ordinary string; the table has no wildcard or pattern rule for other dotenv-style names such as `.env.local` (`vex-app/src/renderer/features/appShell/studio/viewer/highlight/language-of-path.ts:142-158`).

Whether a file can be read and whether it is colored are two independent facts, both always visible. A file can be perfectly readable while its highlighter is unavailable, and Vex shows both rather than folding them into one status.

### The Terminal: A Separate Privileged Process

A Studio terminal does not run inside Vex's main Electron process. Every pseudo-terminal lives in a
dedicated child process, a `utilityProcess.fork()` that Electron treats as a peer of, not code
running inside, main (`vex-app/src/main/studio/pty-host-starter.ts:551`, `defaultFork`). The stated
reason is process isolation: a wedged or crashing shell must never take down the process that holds
wallet and vault authority (`vex-app/src/pty-host/index.ts:1-7`, module doc). Nothing forks this
child at app startup - it is created lazily, on the first terminal request that calls
`ensureStarted()`; later requests reuse the same live process, or fork a fresh one if it died
(`vex-app/src/main/studio/pty-host-starter.ts:197-201`).

#### Control plane vs. data plane

Two channels cross the boundary, deliberately not the same one. The **control plane** carries
`create`, `write`, `resize`, `kill` (`vex-app/src/shared/schemas/terminal.ts:1-49`, module doc),
`persistWorkspace`, `readWorkspace`, and related requests from main to the host over `parentPort`
(`vex-app/src/shared/schemas/terminal.ts:768,804`), each parsed by a `.strict()` Zod schema at both
ends and answered within a request-specific deadline. An ordinary `create`, `write`, `resize`, or
`kill` gets `TERMINAL_CREATE_TIMEOUT_MS = 5000`ms (`vex-app/src/shared/schemas/terminal.ts:144`);
`revive`, `persistWorkspace`, and `shutdownAll` get a deadline derived from what the host actually
has to do for that request, not a flat number - a shorter-than-real deadline had previously caused
main to declare a healthy host unresponsive and kill it mid-commit
(`vex-app/src/main/studio/pty-host-starter.ts:507-548`, `deadlineFor`).

The **data plane** - the actual terminal output bytes - never touches this control channel. Each
renderer window gets its own `MessagePort`, minted with a one-shot nonce
(`TERMINAL_PORT_NONCE_TTL_MS = 10000`ms, `vex-app/src/shared/schemas/terminal.ts:141`) and handed to
that window's preload process, so main is never in the path for bytes it never reads. The port
carries no authority of its own: the host revalidates `(windowId, terminalId)` ownership on every
data-plane packet it receives, not once at mint time
(`vex-app/src/shared/schemas/terminal.ts:28-33`, module doc). A renderer guessing another window's
terminal id is refused by the host, not merely by a preload layer it also controls.

#### Capacity reservation closes a TOCTOU race

Before any terminal is created, `TerminalDomain` reserves capacity against two bounds -
`TERMINALS_GLOBAL_MAX = 24` across the app and `TERMINALS_PER_PROJECT_MAX = 12` per project
(`vex-app/src/shared/schemas/terminal.ts:111,114`) - and does this **synchronously, before the
function's first `await`**. If N concurrent `create` calls each read the same pre-award count
before any commits, all N could pass a bound meant for N-1; reserving inside one synchronous tick
closes that race (`vex-app/src/main/studio/terminals.ts:405-410`, `reserveCapacity`). Only after
that reservation, a project-lifecycle lease, and a filesystem re-check of the requested shell does
the domain send `create` to the host.

#### Backpressure and the write/replay caps

| Constant | Value | Meaning |
|---|---|---|
| `TERMINAL_FLOW_HIGH_WATERMARK_CHARS` | 100,000 | pty write side pauses once this many chars are unacknowledged |
| `TERMINAL_FLOW_LOW_WATERMARK_CHARS` | 5,000 | pty resumes once acknowledged chars fall back below this |
| `TERMINAL_PENDING_CEILING_BYTES` | 8 MiB | emergency ceiling per terminal: past this, the consumer is detached and the terminal marked resync-required |
| `TERMINAL_WRITE_MAX_BYTES` | 256 KiB | one write packet's cap; refused as `write_too_large`, never truncated |

(`vex-app/src/shared/schemas/terminal.ts:72,75,98,101`.) The pause/resume watermarks are VS Code's
own `FlowControlConstants`, adapted directly. When the 8 MiB ceiling is hit, the host does not drop
bytes to catch up - it detaches the stalled consumer and marks the terminal resync-required, since
silently dropping terminal output would corrupt a scrollback the user might be reading. A write over
the 256 KiB packet cap is refused by name, never cut down to fit.

#### Restart cap: six restarts, never reset

If the host process dies unexpectedly (not as part of an ordered quit), `PtyHostStarter` restarts
it, but only up to a cap: the guard is `if (this.restartCount <= TERMINAL_HOST_MAX_RESTARTS)` with
`TERMINAL_HOST_MAX_RESTARTS = 5` (`vex-app/src/shared/schemas/terminal.ts:267`), admitting counts 0
through 5 - **six restarts, seven total forked processes** counting the original start. This is VS
Code's exact `PtyHostService` arithmetic, carried over deliberately rather than rounded
(`vex-app/src/main/studio/pty-host-starter.ts:20-27`, module doc). The counter never resets on a
successful start: resetting it would let a host that crashes every thirty seconds restart forever,
the exact failure mode the cap exists to stop. Once the cap is spent, `state` becomes `unavailable`
durably; `ensureStarted()` returns `false` on every later call
(`vex-app/src/main/studio/pty-host-starter.ts:190-201`), and every new terminal request is
refused `host_unavailable` rather than hanging or retrying forever
(`vex-app/src/main/studio/pty-host-starter.ts:339`). There is no automatic way out of
`unavailable` - restarting the whole Vex process is the only remedy.

Every time the host is lost, restarted or not, `onHostTerminated()` fires first, before the restart
decision is made (`vex-app/src/main/studio/pty-host-starter.ts:249-255`): every terminal that host
owned is gone regardless of what happens next, since a restarted host comes up with no memory of the
old one's terminals. `TerminalDomain` responds by bumping an internal generation counter (so a stale
in-flight open cannot hand the renderer ids a new host never heard of), forgetting every recorded
terminal, and broadcasting a `terminalsLost` event so every window can mark its tabs dead and offer
to revive them (`vex-app/src/main/studio/terminals.ts:985-1009`;
`vex-app/src/main/studio/terminal-domain.ts:99-100`).

#### Ordered shutdown

`dispose()` follows a fixed order, and the order is load-bearing
(`vex-app/src/main/studio/pty-host-starter.ts:480-496`):

1. Mark a quit as requested and stop the heartbeat timers.
2. Send `shutdownAll` on the **still-live** channel and await it, so the host has a live channel to
   receive the one request that makes it commit its snapshots.
3. Only then drop the process reference.
4. Reject every request still pending with `host_unavailable`.
5. Kill the child process.
6. Mark state `stopped`.

Reversing steps 2 and 3 - dropping the reference before the shutdown message is sent - is named in
the code as the exact mistake this ordering prevents: it would ask an already-disposed channel to
deliver the one message that saves the user's terminal layout.

#### Snapshot and revive

Workspace terminal layouts persist to disk under the host's own snapshot store, in a directory the
host creates on demand with `0700` permissions. Three bounds apply: `TERMINAL_SNAPSHOT_MAX_BYTES =
2 MiB` per terminal, `WORKSPACE_SNAPSHOT_FILE_MAX_BYTES = 16 MiB` per project's snapshot file, and
`SNAPSHOT_DIR_MAX_BYTES = 64 MiB` for the whole directory, with the oldest inactive project evicted
when the directory bound is hit (`vex-app/src/shared/schemas/terminal.ts:126,129,132`). Reviving a
workspace spawns one shell per saved terminal, sequentially, which is why a revive's deadline scales
with the number of terminals being restored rather than staying flat
(`vex-app/src/pty-host/host-service.ts:857-864`). Revive is explicitly partial-tolerant: if a
snapshot holds more terminals than current capacity allows, or a project's directory moved and a
spawn fails, the domain revives as many terminals as it safely can and reports the shortfall by
omission from the returned layout plus a logged warning naming the count that stopped, rather than
failing the whole revive over one bad assignment (`vex-app/src/main/studio/terminals.ts:947-959`).

### What A Studio Terminal Can See: An Unresolved Question

A Studio terminal's shell does not inherit the main process's environment wholesale, and it is not
scrubbed to a minimal safe set either. It is a constructed environment built in two stages, and the
construction has a confirmed gap.

#### Stage A: the base, captured once at host boot

The pty host child process is forked with the MAIN process's `process.env` spread in full,
overlaid with four boot-only `VEX_PTY_*` keys
(`vex-app/src/shared/schemas/terminal.ts:1525-1529`, spread at fork in
`vex-app/src/main/studio/pty-host-starter.ts:209,550-555`). Before any shell spawns,
`scrubEnvironment(process.env)` runs once and captures a "base" environment
(`vex-app/src/pty-host/index.ts:101`, deny-list at `vex-app/src/pty-host/process-env.ts:96-110`)
against exactly four regex patterns:

| Pattern | Purpose |
|---|---|
| `/^ELECTRON_.+$/` | strips Electron runtime markers a shell should never see |
| `/^VEX_.+$/` | strips Vex's own configuration, including its pty boot keys as belt-and-suspenders |
| `/^SNAP(\|_.*)$/` | strips Linux Snap packaging leakage |
| `/^GDK_PIXBUF_.+$/` | strips a loader-path variable that breaks unrelated binaries under Snap confinement |

(`vex-app/src/pty-host/process-env.ts:53-58`). `TERMINAL_ENV_PRESERVE`, the override that would win
over the deny-list, is declared empty (`vex-app/src/pty-host/process-env.ts:74`) and asserted empty
by test (`vex-app/src/pty-host/__tests__/environment.test.ts:65-69`). **Nothing else is stripped**:
any variable not matching one of the four patterns survives into the base and every Studio terminal.

#### Stage B: the per-terminal overlay

Each terminal composes `base -> overlay -> asserted -> asserted-when-missing`
(`vex-app/src/pty-host/process-env.ts:120-137`). The only overlay key Vex's own integration sends is
`VEX_CONFIG_DIR`, produced by `studioTerminalEnvironmentOverlay(configDir)`
(`vex-app/src/main/studio/terminals.ts:250-253`) and sent identically on terminal create
(`vex-app/src/main/studio/terminals.ts:514`) and on workspace revive
(`vex-app/src/main/studio/terminals.ts:900`), so the terminal's `vex-mcp` bridge can re-derive the
Studio socket path. `TERM`, `COLORTERM`, and `TERM_PROGRAM` are asserted regardless of the overlay,
and `LANG` is set only when absent, preserving a user's own locale
(`vex-app/src/pty-host/process-env.ts:82-93`). The result reaches `node-pty.spawn()` verbatim
(`vex-app/src/pty-host/node-pty-spawner.ts:126`).

#### `VEX_KEYSTORE_PASSWORD`: two independent locks

The master password key, `MASTER_PASSWORD_ENV_KEY = "VEX_KEYSTORE_PASSWORD"` (`src/lib/secret-keys.ts:1`,
repo root), is protected twice over: it is never left resident on `process.env` outside a single
transient call - wallet operations set it, run one signing operation, and `delete` it in a
`finally` block (`vex-app/src/main/onboarding/wallet-password.ts:23-32`), and the unlock path
itself deletes it right after applying the vault (`vex-app/src/main/secrets/session.ts:184`, inside
`applyUnlockedRuntime`) - and even if left resident it starts with `VEX_` and would be caught by the
`/^VEX_.+$/` deny pattern above, "the second lock on the same door"
(`vex-app/src/pty-host/config.ts:14-17`).

#### The confirmed gap: five vault-managed API keys are not covered by either mechanism

`applySecretVaultToProcessEnv` (`src/lib/local-secret-vault/env.ts:7-18`, repo root) sets
`process.env[key] = value` for every key in `VAULT_SECRET_KEYS` (`src/lib/secret-keys.ts:3-16`,
repo root): `OPENROUTER_API_KEY`, `JUPITER_API_KEY`, `TAVILY_API_KEY`, `RETTIWT_API_KEY`,
`RELAY_API_KEY`. This runs on every unlock, from `initializeMasterPassword`
(`vex-app/src/main/secrets/session.ts:217`) and `unlockSecretSession`
(`vex-app/src/main/secrets/session.ts:246`). None is `VEX_`-prefixed, so none matches the
deny-list, and unlike the master password they have no inject-and-delete pattern: they stay on
`process.env` for the whole unlocked session, cleared only when `scrubUnlockedRuntime` sweeps
`MANAGED_SECRET_ENV_KEYS` on relock (`vex-app/src/main/secrets/session.ts:405-409`).

Because the pty host fork copies `process.env` wholesale
(`vex-app/src/main/studio/pty-host-starter.ts:555`) and `scrubEnvironment`'s pattern list does not
name any of these five keys, they land in the pty host child's captured base whenever the fork
happens during an unlocked session. That capture runs once (`vex-app/src/pty-host/index.ts:101`),
and every terminal the host spawns reuses the same cached base
(`vex-app/src/pty-host/terminal-process.ts:290`, via `vex-app/src/pty-host/host-service.ts:467`) -
the relock scrub touches only main's `process.env` and never re-scrubs a running pty host.
**Any command in a Studio terminal spawned by a host that forked while the vault was unlocked can
read these five keys, for as long as that host keeps running** - `echo $OPENROUTER_API_KEY` or
`env | grep API_KEY` prints the live value, and relocking does not end this for a terminal on that
host. This is reachable by construction, not a bypass: no scrub, overlay-delete, or capability
check touches these five names.

No test says otherwise: the deny-list's coverage file exercises only innocuous KEEPS names
(`PATH`, `HOME`, `SHELL`, near-miss prefixes), and its logging-sanitizer test uses `GITHUB_TOKEN`
only to prove log-redaction, not shell absence
(`vex-app/src/pty-host/__tests__/environment.test.ts:158-169`). `sanitizeEnvForLogging` replaces
every value with its character length before a log sees it
(`vex-app/src/pty-host/process-env.ts:151-159`, used at
`vex-app/src/pty-host/node-pty-spawner.ts:61-67`) - a logging control, not a process boundary; it
does nothing about a live shell reading its own environment.

#### Why the gap exists: a stated design principle that does not currently reach vault secrets

The deny-list's own code comment states its principle as removing "what THIS process set"
(`vex-app/src/pty-host/process-env.ts:49-50`) - the same reasoning that leaves `CLAUDE_CODE_*`
variables unstripped, since those belong to a third party, not Vex. The five vault-managed keys are
also something this process set - Vex's own unlock path puts them there - but they are not
`VEX_`-prefixed, so the pattern list omits them: principle and pattern list are in tension. This is
not a bug to patch unilaterally. Whether the reachability is an accepted tradeoff (the local-first
posture that the user's own machine and keys are the user's business), an unreviewed gap, or a case
for an inverted preserve-style scrub is a product and security decision the code has not made, and
this document does not make it either.

### Every Screen And Dialog, At A Glance

This document names dozens of individual screens and dialogs as it walks through setup, approvals,
projects, and the workspace. This table is a lookup, not new material: for each surface, find the
section that documents what it actually does under the hood.

| Screen or dialog | What it is | Documented in |
|---|---|---|
| Setup / system-check screen | Cold-boot gate: Docker, compose, and migrations must finish before the shell routes in | [s0-first-hour] |
| Agent \| Studio toggle | A live, keyboard-operable radiogroup switching between the in-app agent and the Studio workspace | [s0-first-hour], [s7-workspace-overview] |
| Studio welcome screen | Shown when no project is open, or as the fallback when an active kept-alive project is removed elsewhere | [s7-workspace-lifecycle] |
| New Project dialog | Name, permission default, per-family wallet selection, agent roster picker; submitting runs the installer | [s0-first-hour] |
| Project row / sidebar | The projects rail: the list of kept-alive and available projects, and the explorer tree for the open one | [s7-workspace-overview] |
| Approval card | The single component rendering a pending decision: risk, actor, project, expiry, critical args, two-step confirm for high risk | [s4-card-and-screens] |
| Global Approvals panel | Mounts the exact same card as the inline view, across every pending approval in every mode | [s4-card-and-screens] |
| Cross-mode toast | Fires once per fresh approval observed in the mode not currently on screen | [s4-card-and-screens] |
| Full-Access consent strip | The explicit checkbox acknowledgement required before a project moves to full permission | [s4-permission-model] |
| Keep-Alive dialog | Shown when a 5th project would exceed the 4-workspace bound; names which project to close and its running-terminal count | [s7-workspace-lifecycle] |
| Project Settings dialog | Edits permission and wallet selection; bumps scopeVersion and refuses undecided approvals, but does not touch an already-approved one | [s6-scope-edit-gap] |
| Project Delete dialog | Triggers the full delete order: admission closes, leases drain, approvals settle, session and project soft-delete, cleanup runs after | [s6-create-delete-order] |
| Project Repair dialog | Re-renders project files, allowed to take over only entries Vex itself proved it wrote | [s6-installer-mechanics] |
| Combined search field | One field, two result groups (Projects, Files), bounded and dated on screen | [s7-search] |
| File explorer tree | Part of the projects rail; its loaded nodes merge into combined search results and it drives what opens in the viewer | [s6-files-domain], [s7-workspace-overview] |
| File viewer (header, notices, chip, kind menu, reveal) | Reads up to 2 MiB, refuses larger or invalid files with no open-anyway escape hatch; highlights via a shared background worker | [s7-viewer-highlight] |
| Terminal tab strip | Per-project tab UX over the underlying pty host: capacity bounds, keyboard shortcuts, dangerous-action focus defaults | [s7-terminal-tabs-ux] |
| Studio host-status pill / card | Renders the derived, never-stored MCP host status with its fixed precedence order | [s12-host-status-table] |

The approval card's two-step confirm is a behavior of the Approval card row above, not a separate
dialog: the Global Approvals panel mounts the identical component rather than a variant of its
own. The file explorer tree's row points to the same sections that document the projects rail
because the tree is part of that rail, not a standalone screen. Where a row lists more than one
section, the first is the primary mechanism and the second is the surrounding workspace context it
lives inside.


## Part 8 - Sessions, Dispatch, And Logging

### The Studio Backing Session

Every Studio project has exactly one backing session, and it is minted exactly once: at project
creation, inside the same database transaction that writes the project row. `createProject`
(`vex-app/src/main/database/projects/create.ts:214`) claims the project directory first, then opens
one transaction (`runCreateTransaction`, `create.ts:286`) that anchors the projects root
(`create.ts:302`), calls `insertBackingSession` (`create.ts:311`), and then `insertProjectRows`
(`create.ts:312`), which writes the `projects` row carrying `backing_session_id` and, in the same
statement group, two `project_wallets` rows (`evm`, `solana`, null meaning no selection). If any
statement fails, the whole transaction rolls back; a unique-violation on the project slug is
reported by name (`projects.slug_taken`, `create.ts:343-344`) rather than as a generic database error,
and the directory claimed just before the transaction is compensated with a non-recursive `rmdir`
that only removes it if it is still empty, never touching user content (`create.ts:359`).

The backing session itself is an ordinary row in the `sessions` table, `mode = 'agent'`, with
`scope = 'vex_studio'` and `title` set to the project name so the global approvals inbox (which
joins across all sessions without a scope filter) shows a readable label (`create.ts:145-147`); the
wallet columns are mirrored from the resolved `project_wallets` selection, but `project_wallets`
remains the authority (`create.ts:148-174`). Because the scope is `vex_studio`, ordinary agent-mode reads, which filter on
`scope = 'vex_app'`, do not see it (`create.ts:143-144`).

A tool call never creates or claims a session. `runStudioCallAdmitted`
(`vex-app/src/main/studio/approval-service.ts:150`) loads one authoritative scope snapshot per
call - for every call, including the read-only `vex_ToolSearch` - through a single atomic statement
(`loadProjectScopeSnapshot`, `approval-service.ts:182`). Nothing observed when the MCP connection was
opened is trusted afterward: a scope value cached on the connection would be a stale authorization
the moment the user edits the project in Vex, so the snapshot is re-read fresh every time
(`approval-service.ts:176-186`). That snapshot supplies `backingSessionId` (`ProjectScope.backingSessionId`,
`src/vex-agent/mcp/project-scope.ts:34-56`), which `buildProjectToolContext` then sets as
`sessionId` on the tool context (`src/vex-agent/mcp/project-context.ts:93-98`, cited in
`sessions-logging.md` Flow 3 point 1) - the backing session id is read and reused, never generated,
on this path.

Whether Studio's `vex_studio`-scope sessions rows are read by anything other than the checked
`scope = 'vex_app'` filter was not independently verified against every reader of the `sessions`
table; this is stated as unverified rather than asserted [see sessions-logging.md's open questions].

### The Full Gate Ladder One Call Passes Through

`executeProtocolTool` (`src/vex-agent/tools/protocols/runtime.ts:83`) is the one gate-ordered orchestrator every protocol call runs through, whether it came from the in-app agent or from an external Studio MCP client, because both lanes funnel through this same function. A Studio call reaches it via `executeStudioTool(scope, call, signal)` (`src/vex-agent/mcp/executor.ts:38`), which first builds a least-privileged `InternalToolContext` through `buildProjectToolContext` (`src/vex-agent/mcp/project-context.ts:93`) and then hands the call to `admitStudioCall` (`src/vex-agent/mcp/admission.ts:161`), which resolves a protocol tool name, checks it against `isExportedProtocolTool` (`src/vex-agent/mcp/admission.ts:210-215`), and calls `executeProtocolTool` with a `ProtocolExecutionContext` built by the one shared mapper `toProtocolExecutionContext` (`src/vex-agent/tools/protocols/execution-context.ts:29`). This mapper takes `approvalSurface` as a parameter and passes it straight through (`src/vex-agent/tools/protocols/execution-context.ts:57`); it is the Studio call site, `admitStudioCall`, that supplies the literal `"studio_mcp"` (`src/vex-agent/mcp/admission.ts:222`), the field that decides the launch-form carve-out described below. Because the in-app agent and Studio MCP share this one function, every gate in this ladder applies identically to both.

The ladder runs in this fixed order.

| Step | Gate | What it does | Citation |
|---|---|---|---|
| 1 | Manifest lookup | Unknown `toolId` refuses with no `actionKind` stamped - a deliberately conservative "unknown action" signal to the policy layer, since a manifest that does not exist has nothing to classify. | `runtime.ts:87-97` |
| 2 | Retired-param-alias normalization | `normalizeParamAliases` runs first, before any other param reader, and mutates the caller's own `params` object in place so every later reader (the coercers, `isPreviewExecution`, `validateProtocolParams`, the capture row, the approval enqueue) sees the same rewritten spelling. A manifest with no declared alias is untouched. | `runtime.ts:98-113`, `runtime/param-aliases.ts:41-64` |
| 3 | `effectiveActionKind` resolved once | `isPreviewExecution(...)` overrides the kind to `"read"` regardless of the manifest's own kind, because preview/dryRun is read-only simulation end to end. This resolved kind is stamped on every return path via `withActionKind`. | `runtime.ts:161-163` |
| 4 | Wallet-scope defaulting | Fills `walletResolution`/`walletPolicy` when absent. This defends only test and legacy callers - in production both fields are required on the type, so this branch is unreachable and the real path is fail-closed by `tsc`, not by a runtime check. | `runtime.ts:169-172` |
| 5 | Per-namespace lifecycle gate | `isExecutableNamespace` refuses a `deprecated_hidden` namespace unless `VEX_ALLOW_DEPRECATED_PROTOCOLS=1` is set, and never executes a `reserved` namespace. | `runtime.ts:193-208` |
| 6 | `requiresEnv` gate | A missing manifest-declared required environment variable returns `{success:false, output:"<toolId> requires <ENV> to be set in .env", failure:{kind:"configuration_unavailable", env:[ENV]}}`. The structured `failure` field lets a caller like the Studio MCP executor branch on the cause without parsing prose. | `runtime.ts:215-221` |
| 7 | Pressure-barrier guard | A mutating, non-preview call is blocked when `contextUsageBand` is `barrier` or `critical` and `preparationBypassesBarrier` does not apply. Studio's `ProtocolExecutionContext.contextUsageBand` is always `"normal"`, so this gate is inert for every Studio call - it exists for the in-app agent's own compaction pressure, not for Studio. | `runtime.ts:228-249`, `mcp/project-context.ts:113` |
| 8 | Strict param-boundary validation | `validateProtocolParams` rejects unknown or extra keys, missing required params, and wrong-typed declared params against the manifest's Zod schema, before the handler runs. | `runtime.ts:256-262` |
| 9 | Handler lookup | A manifest with no registered handler is reported as a bug string in the `ToolResult`, never thrown. | `runtime.ts:265-270` |
| 10 | Prequote gate | `evaluatePrequoteGateDecision` runs before the approval gate specifically so a block short-circuits a call that would otherwise be enqueued for human approval. It gates every toolId registered in `EXECUTE_GATE_TOOLS` (`prequote/registry.ts:183-239`) - currently 23 entries: the swap-kind executes (kyberswap, uniswap, solana, virtuals, and the Pendle PT/YT buy and sell executes), both bridge executes (Khalani and Relay), and the remaining Pendle and Morpho mint/redeem/LP/lend execute tools; preview/dryRun is excluded. It fails closed - any evaluator error is a BLOCK - and on ALLOW it carries the matched prequote's safety verdict, FOT tax, term-lock, fee preview, the Vex fee statement, quote binding, spendability, and bridge-token-identity preview forward to the approval gate. | `runtime.ts:292-303`, `runtime/gates.ts:141-156`, `prequote/registry.ts:183-239`, `runtime/gates.ts:119-124,217` |
| 11 | Approval gate | Described in detail below. | `runtime.ts:311-315`, `runtime/gates.ts:314-332` |
| 12 | Handler dispatch + capture | The handler runs and its result is captured for audit/projections (see [Execution Capture And Audit](#execution-capture-and-audit)). | `runtime.ts:330-332,373-386` |
| 13 | Thrown-error path | Described in detail below. | `runtime.ts:389-421` |

#### The approval gate's exact firing condition

`evaluateApprovalGate` fires - meaning it refuses the call outright and returns `pendingApproval: true` with nothing having run - when every one of these is true at once: `manifest.mutating`, `manifest.actionKind !== "local_write"`, `!context.approved`, `!isPreviewExecution(request.toolId, params)`, `context.sessionPermission === "restricted"`, and `!launchFormReplacesApprovalCard(request.toolId, context)` (`src/vex-agent/tools/protocols/runtime/gates.ts:330-332`). When it fires, the returned `ToolResult` carries `success:false`, an output sentence stating the tool requires approval, `pendingApproval:true`, and the typed `prequote`/`riskPreview`/`prequoteAuthority` fields carried forward from the prequote gate - nothing from the handler runs (`runtime/gates.ts:345-381`).

The last clause is the launch-form carve-out, and it is explicitly disabled over Studio. `launchFormReplacesApprovalCard` returns true only when the tool is in `FORM_IS_THE_APPROVAL_TOOLS` and `resolveApprovalSurface(context) === "in_app_form"` (`runtime/gates.ts:307-311`). Because `toProtocolExecutionContext` stamps every Studio call's `approvalSurface` as `"studio_mcp"`, never `"in_app_form"`, this carve-out never applies to a Studio-originated call: `pools.launch_execute` reached from Studio MCP gets the ordinary approval card, not the in-app launch form's silent pass-through. The reasoning documented at the call site is that the launch form is itself the consent surface for the in-app agent, so an approval card there would ask for the same spend twice - but that form does not exist for an external MCP client at all, so skipping the card over `studio_mcp` would let an external agent reach a fund-moving handler with no human consent surface whatsoever (`runtime/gates.ts:295-305`).

#### An Operator-Stop abort is rethrown, never turned into a failed ToolResult

The handler dispatch at step 12 runs inside a `try` block; its `catch` (`runtime.ts:389`) checks, before anything else - before provider-failure logging, before failure capture - whether the caught error is an abort caused specifically by the user's own Operator Stop: `isAbortError(err) && context.abortSignal?.aborted === true` (`runtime.ts:402`). When both hold, the error is rethrown as-is, not converted into a `{success:false, ...}` result. The comment at the call site states the reason directly: a protocol handler interrupted mid-wait by Operator Stop did not fail, and dressing that abort as a failed `ToolResult` here would swallow it, make the dispatcher's `TOOL_ABORTED_BY_USER_STOP_OUTPUT` branch unreachable for every protocol tool, and write a failed-mutation audit row for a mutation that was never actually attempted (`runtime.ts:392-403`). The predicate matches the dispatcher's own exact check (`src/vex-agent/tools/dispatcher.ts:188`), so a provider SDK's own internal timeout or deadline - where the turn's own `abortSignal` was never itself aborted - stays an ordinary classified tool failure with its capture intact, rather than being misread as an operator abort. Only when both conditions hold does the exception propagate past this function uncaught; every other thrown error is reduced by `summarizeProtocolError` into a scrubbed, capped `SafeErrorSummary` and returned as a `failedResult`, with capture still running for the failure (audit-only, no projections) (see [Execution Capture And Audit](#execution-capture-and-audit)).

### Execution Capture And Audit

Every mutating, non-preview protocol call is durably captured after its handler returns. `executeProtocolTool` computes `shouldCapture = manifest.mutating && !isPreview` (`src/vex-agent/tools/protocols/runtime.ts:327`) and, when true, calls `captureExecution(toolId, namespace, sessionId, params, result, durationMs)` (`src/vex-agent/tools/protocols/runtime.ts:375`, with a matching failure-path call at `:436`). `captureExecution` (`src/vex-agent/tools/protocols/runtime/capture.ts:21`) first checks `result.data?.dryRun === true` as a defense-in-depth no-op, since a preview result must never be captured as a mutation (`capture.ts:31`). Both `params` and `result.data` are then run through `sanitizeRecord`, which delegates to `sanitizeJsonbValue` (`capture.ts:34-35`, `capture.ts:156-158`). That function only normalizes JSON serialization: it converts `undefined` to `null` or drops `undefined` keys, calls a value's own `toJSON()`, and guards against circular references (`src/vex-agent/db/params.ts:113-168`); it contains no secret-detection or redaction logic before either value is written to the `protocol_executions` audit table.

The one place a hard byte cap and secret-shape redaction apply is the intent-first params echo, not this general post-handler capture path. When a handler creates its own `protocol_executions` intent row before a signing call can submit - most signing-before-broadcast handlers across the money-moving namespaces do this: pools (`src/vex-agent/tools/protocols/pools/handlers/claim.ts:282`), solana-jupiter (`src/vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-execute-handler.ts:233`), virtuals (`src/vex-agent/tools/protocols/virtuals/handlers/trade-execute.ts:342`), uniswap (`src/vex-agent/tools/protocols/uniswap/handlers/swap/execute-handler.ts:457`), pendle (`src/vex-agent/tools/protocols/pendle/handlers/signed-broadcast.ts:273`), kyberswap (`src/vex-agent/tools/protocols/kyberswap/handlers/swap/execute-plan.ts:489`), morpho (`src/vex-agent/tools/protocols/morpho/handlers/signed-broadcast/intent.ts:187`), khalani (`src/vex-agent/tools/protocols/khalani/handlers/bridge-execute.ts:370`), and relay (`src/vex-agent/tools/protocols/relay/handlers/bridge.ts:436`), plus the wallet transaction/wrap confirm tools - `createExecutionIntent` runs the params through `sanitizeIntentParams`, which calls `redactBugPayload` and enforces `MAX_INTENT_PARAMS_BYTES = 8 * 1024` (`src/vex-agent/db/repos/executions.ts:19-29,62`). A payload over that cap is not silently truncated; the whole `params` value is replaced with `{_dropped: true, _reason: "intentParams exceeded the 8KiB cap after redaction", _originalSizeBytes}` (`executions.ts:22-29`), an explicit marker rather than a cut string. The general `recordExecution` path used by ordinary (non-intent-first) captures sanitizes via `sanitizeJsonbValue` only, with no byte ceiling and no secret redaction in the code read for this section (`executions.ts:154-172`); a handler on that path whose params or result happen to carry a secret-shaped value would persist it into `protocol_executions` unredacted. `redactBugPayload` has no other production call site in the repository - its only other uses are its own unit tests (`src/vex-agent/db/repos/executions.ts:9,21`).

A handler that already wrote its own intent row can hand that row's id back on `result.data._executionId`. `captureExecution` adopts it only after a provenance check: it loads the referenced row and adopts the id only when that row's `tool_id` and `namespace` match the tool currently executing; on any mismatch (or a missing row) it logs `protocol.execute.execution_id_provenance_mismatch` and falls through to creating a fresh row instead, so the capture pipeline can never adopt a foreign or forged intent (`capture.ts:56-68`).

Once an execution id exists, success and failure diverge. On success with `executionId > 0`, sync jobs are enqueued for the namespace best-effort (`capture.ts:111-124`), and the capture contract is validated against `MUTATION_MATRIX` before `populateCaptureItems` writes `proj_activity`, positions, and lots (`capture.ts:128-151`). On failure, the audit row is still written or completed (`execution_status` set to `'failed'`), but neither the sync enqueue nor the projection populate step runs, because both are gated on `result.success` (`capture.ts:111,128`). A failed mutation therefore reaches only the durable `protocol_executions` audit log; it never appears in the activity feed or in positions.

Reference notes: `deepseek-harness/docs/architecture.md`'s "Session log" section states its append-only log as the single source models and UI both derive from; Vex's `protocol_executions` table plays an analogous durable-audit role for mutations but is not the model-context log itself, so that framing was not reused. Its lookup-table convention for outcome mapping was adopted implicitly by keeping this section's own citations dense and table-free where prose reads clearer for a linear capture sequence.

### The Seven Outcomes An Agent Sees

An external agent calling a Vex Studio tool never receives a generic "unexpected error". Every `tools/call` resolves into exactly one of seven closed outcome kinds, each carrying its own full sentence stating what did or did not happen to the user's funds. The type is `StudioCallOutcome`, and `studioOutcomeToCallToolResult` projects each of the seven into the wire's `CallToolResult` (`src/vex-agent/mcp/outcome.ts:21-70`, `src/vex-agent/mcp/server-result.ts:122-165`).

| Outcome | What it tells the agent |
|---|---|
| `completed` | The whole tool output, unprojected; `isError` mirrors the tool's own success flag (`server-result.ts:126-128`). |
| `declined` | "A person DECLINED this action in Vex. Nothing was executed and no funds moved." plus the reason (`server-result.ts:130-135`). |
| `expired` | "This action EXPIRED before anyone decided it in Vex. Nothing was executed and no funds moved." with an instruction to ask the user and call the tool again (`server-result.ts:137-142`). |
| `refused` | Two variants: a confirmed refusal says nothing was executed and no funds moved; an unconfirmed one (Vex could not confirm it recorded the refusal) says to treat the outcome as unresolved and not retry (`server-result.ts:62-75`, `145-146`). |
| `dispatch_failed` | "This action was approved but Vex could not carry it out, so nothing was executed and no funds moved. It was NOT retried." plus the reason (`server-result.ts:148-153`). |
| `indeterminate` | Vex approved and dispatched the action but cannot prove whether it took effect (`server-result.ts:155-156`). |
| `not_queued` | The reason is already the complete, honest sentence; each cause (locked, starting, shutting down, unknown project, wallet drift, at capacity, project deleting) owns its own wording upstream, and this outcome never had an approval id to begin with (`server-result.ts:158-163`, `outcome.ts:21-70`). |

A settlement is decoded into one of these seven from the durable `approval_intents` row: `expired` when the refusal reason is `expired`; `refused` for a pre-dispatch commit-time refusal or any non-approved decision with a refusal reason; `declined` when a human said no with no refusal reason; `indeterminate` when the row's execution status is `indeterminate`; `dispatch_failed` when approved but with no decodable settlement body; `completed` when approved and decoded to a real tool result (`vex-app/src/main/studio/approval-service.ts:531-606`).

#### The indeterminate sentence

`indeterminate` is the outcome Vex uses when it dispatched an approved action and genuinely cannot prove what happened next. Its sentence is a fixed constant, `STUDIO_INDETERMINATE_SENTENCE`, and its clause order is part of the contract: MCP carries no machine-readable "do not retry" flag, so the instruction has to be the first words a client reads even if it only shows the head of a message (`server-result.ts:77-89`). It reads: "DO NOT RETRY THIS CALL. Vex approved and dispatched this action but cannot prove whether it took effect, so its outcome is UNKNOWN and it may have moved funds. Retrying could execute it a second time. Vex reconciles the approval itself - open Vex and read the approval before doing anything else with this account." (`server-result.ts:84-89`). The agent is never asked to reconcile it; Vex's own startup reconciler later resolves an abandoned `dispatching` row.

A sibling sentence covers the one path with no decoded outcome at all: a tool handler that threw. That is not `indeterminate` (which names an approval the throw may never have reached) and not `dispatch_failed` (which would claim nothing was executed, unproven by a throw). `studioHandlerFailureSentence` also leads with "DO NOT RETRY THIS CALL", states the outcome as UNRESOLVED and possibly already in effect, and appends only a correlation id; the thrown error's own message never reaches the wire, since it is peer- or provider-shaped text that can quote a path, a URL, a stack, or a payload (`server-result.ts:91-115`).

#### Protocol tool failures

A protocol tool call that fails (as opposed to a transport-level throw) renders as one fixed shape:

`<toolId> failed [<CODE>/<category>{, HTTP <status>}]: <cause> - <remediation>{ (retryable)}`

built by `renderProtocolFailureOutput` from a `SafeErrorSummary` (`src/utils/error-summary/render.ts:103-110`). The summary comes from `summarizeProtocolError`, which reduces any thrown value to `{code, category, httpStatus?, message, remediation?, retryable?}`: the message is scrubbed of secrets and URLs, a `VexError`'s own agent-actionable hint is scrubbed and concatenated before the length cap, and the joined text is then collapsed and capped at 320 characters (`MAX_SAFE_ERROR_MESSAGE`, `src/utils/error-summary/scrub.ts:19`) before any remediation is appended outside the cap (`render.ts:41-90`). The rendered code is a thrown `VexError`'s own stable code when one exists, otherwise the error category name (`render.ts:19-21`, implemented at `render.ts:83`).

#### The wire-transport code set

Below the protocol layer, the raw duplex connection an external agent's bridge speaks over can itself fail in ways fully controlled by whatever sits on the other end of the socket: a line that is not valid JSON, or an MCP SDK schema rejection whose own error text quotes the value it rejected. Neither message may reach a log line or the agent, because both used to make Vex's log file writable by anything that could open the endpoint. Every wire-transport failure is instead reduced to one of a five-member closed code set before it travels anywhere: `line_too_long`, `invalid_json`, `queue_overflow`, `socket_error`, `sdk_wire_error` (`src/vex-agent/mcp/wire-errors.ts:34-40`). `sdk_wire_error` is the catch-all for anything the SDK itself raised on the wire, including a schema-rejection message; only the code is kept and the SDK's own text is discarded (`wire-errors.ts:26-31`, `49-54`).

#### Unverified

The brief's illustrative failure-sentence example used a plain hyphen before "remediation"; the code's actual `renderProtocolFailureOutput` joins the remediation clause with a space, an em dash character, and a space, not a hyphen (`render.ts:106-109`). This document keeps the hyphen per the house style rule against em dashes in authored prose, but the literal separator Vex emits on the wire is an em dash - noted here so the discrepancy is not silently smoothed over.

### Leases And The Global Lock Order

Studio serializes two different kinds of concurrency with two different mechanisms: an in-process lease gate that tracks work in flight on one project, and a Postgres advisory lock that orders transactions across the whole session. They solve different problems and neither substitutes for the other.

#### The project lease gate

`ProjectLeaseClass` is a closed nine-member union: `executingCall`, `dispatch`, `pendingApproval`, `render`, `watcher`, `terminal`, `terminalCreate`, `terminalPersist`, `fileOperation` (`vex-app/src/main/studio/project-lifecycle-gate.ts:82-91`). Leases are acquired synchronously, before the caller's first `await`, because a lease taken after an await would describe a moment already past (`vex-app/src/main/studio/project-lifecycle-gate.ts:70-72`). A project delete closes admission first, then drains a specific subset of classes before it tombstones the project row.

| Behavior | Classes |
|---|---|
| Drained (delete waits for these to reach zero) | `executingCall`, `dispatch`, `terminalCreate`, `terminalPersist`, `fileOperation` |
| Parked, never drained | `pendingApproval` |
| Unbounded, closed via hooks, never drained | `terminal`, `watcher` |
| Administrative only (used by cleanup itself) | `render` |

The `pendingApproval` class exists because a call sitting at `executingCall` while it waits on a human decision cannot be drained: the event that would release it is the very refusal the delete's own transaction is about to commit, so waiting for it first is a deadlock. `runStudioCall` acquires `executingCall` at admission (`vex-app/src/main/studio/approval-service.ts:133`). The instant a tool result comes back with `pendingApproval: true`, `reclassifyProjectLease(lease, "pendingApproval")` moves the lease synchronously, before the enqueue's own awaits, so a delete racing this call sees it leave the drained set immediately rather than timing out on it (`vex-app/src/main/studio/approval-service.ts:236`). When the approval broker releases the call, the lease moves back to `executingCall` before every return path (`vex-app/src/main/studio/approval-service.ts:332`). A reclassification call on a handle this module never issued (checked against a `WeakSet<ProjectLease>` of issued leases) returns `unknown_handle` and changes nothing, rather than throwing (`vex-app/src/main/studio/project-lifecycle-gate.ts:318,375-383`).

#### The session control lock

Separately, the session control lock is a transaction-scoped Postgres advisory lock, `pg_advisory_xact_lock(hashtextextended(key, 0))` keyed on the session id (`src/vex-agent/engine/runtime/lease-and-status/session-control-lock.ts:111`). It is re-entrant because Postgres reference-counts advisory locks per transaction, and it needs no explicit unlock: Postgres releases it at commit or rollback (`src/vex-agent/engine/runtime/lease-and-status/session-control-lock.ts:41-46`). It is edge 0 of one documented global lock order: this lock, then any open `runtime_control_requests` rows for the session, then the `mission_runs` row, then pending `approval_queue` rows, then money-state rows (`src/vex-agent/engine/runtime/lease-and-status/session-control-lock.ts:23-30`). Because it is always taken first, a transaction can only ever be the first edge of a cycle against it, which is what keeps the order deadlock-free.

The lock's hold duration is stated as a safety property, not an implementation detail: every holder does DB-only work, and nothing may hold it across a provider, wallet, or signing call, because that would let a stuck HTTP request block the operator's own Stop (`src/vex-agent/engine/runtime/lease-and-status/session-control-lock.ts:48-55`). For Studio specifically, three call sites take this lock on the project's `backing_session_id`: `completeExecutionIntentWith` when a session id is present (`src/vex-agent/tools/protocols/runtime/capture.ts:100-107`), the approval-enqueue gate as the very first statement inside its transaction (`src/vex-agent/mcp/approvals.ts:177`), and the resumed-dispatch path after a human approves, which takes it as part of one transaction (`studio-gate.ts`) that commits before dispatch runs, for the same reason: holding it across the dispatch call would let a stuck provider or wallet call block Stop (`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:9-27`). This is also why `approval_intents.session_id` stays `NOT NULL` for a Studio row: it is the key that lets Studio and agent-session transactions share the same lock order instead of forming a separate one that could deadlock against it (`src/vex-agent/db/migrations/024_approval_intents.sql:34`).

Note that the lease gate and the session control lock are independent: the lease gate is process-local, in-memory, and unaware of Postgres; the session control lock is durable and transaction-scoped but says nothing about in-process concurrency. Both exist so a project-delete drain, an operator Stop, and a call parked on a human decision can never wait on each other in a cycle.


## Part 9 - Configuration, Limits, And Errors: The Reference

### Configuration And Environment Reference

#### CONFIG_DIR resolution

Vex resolves one directory, `CONFIG_DIR`, that holds `.env`, `secrets.vault.json`, `config.json`, the rendered Docker Compose tree and the Electron state subfolder (`vex-app/src/main/paths/config-dir.ts:110-124`). Three independent implementations resolve it against the same algorithm and are checked against shared golden vectors: the agent runtime (`src/config/paths.ts:53-80`), the Electron main process mirror (`vex-app/src/main/paths/config-dir.ts:68-95`), and a separate Go implementation in the bridge (`bridge/internal/configdir`, referenced by the shared vector file but not opened for this section). The order is:

1. `VEX_CONFIG_DIR` - honoured only if it is non-empty and absolute (`usableDirEnv`, `src/config/paths.ts:36-42`); a relative or empty value is treated as unset, never resolved against the current working directory.
2. Windows - `%APPDATA%/vex`, where `APPDATA` itself must be non-empty and absolute or a home-derived fallback (`homedir/AppData/Roaming`) is used instead (`src/config/paths.ts:62-67`).
3. macOS - `~/Library/Application Support/vex` (`src/config/paths.ts:70-72`).
4. Linux/Unix - `$XDG_CONFIG_HOME/vex` if `XDG_CONFIG_HOME` is non-empty and absolute, else `~/.config/vex` (`src/config/paths.ts:75-79`).

None of these steps can fail outright: an unusable env value silently falls through to the platform default rather than raising an error, and the directory is created on first `loadConfig()` if it does not already exist (`src/config/store.ts:230-235`, invoked at the top of `loadConfig()`, `:395`).

#### Environment variables Studio reads

| Variable | Where read | Effect |
| --- | --- | --- |
| `VEX_CONFIG_DIR` | `src/config/paths.ts:59`, `vex-app/src/main/paths/config-dir.ts:77` | Overrides the whole config directory; must be absolute or is ignored. |
| `VEX_STUDIO_SOCKET` | `vex-app/src/main/studio/mcp-host/endpoint.ts:54,268,346-425` | Overrides the derived Studio endpoint (a unix path, or on Windows a value that already parses as pipe syntax). Validated before bind by `planOverride`; an invalid value refuses host startup by name (`override_pipe_on_unix`, `override_invalid_pipe`, `override_not_absolute`, `path_too_long`, `override_parent_missing`, `override_parent_not_directory`, `override_parent_not_owned`, `override_parent_mode`) rather than falling back silently. |
| `VEX_PROJECT_ID` / `--project` | `bridge/cmd/vex-mcp/main.go:203` | Picks which Studio project a stdio MCP session belongs to. The value must pass a UUID check (`handshake.ValidProjectID`) or the bridge process exits as a usage error (exit code 1) with that message (`bridge/cmd/vex-mcp/main.go:208-211`). |
| `XDG_RUNTIME_DIR` | `vex-app/src/main/studio/mcp-host/endpoint.ts:308-316` (Linux only, checked after `/run/user/<uid>`) | Names the private runtime directory used for the Studio unix socket when the system default is absent; must be absolute and pass the same privacy gate as any Vex-owned directory. |
| `XDG_CONFIG_HOME` | `src/config/paths.ts:75-79`, `vex-app/src/main/paths/config-dir.ts:91-94` (Linux only) | Same absolute-or-ignored rule as `VEX_CONFIG_DIR`. |
| `APPDATA` | `src/config/paths.ts:62-67`, `vex-app/src/main/paths/config-dir.ts:80-85` (Windows only) | Same absolute-or-ignored rule. |

A caller that supplies `VEX_STUDIO_SOCKET` wins on every platform ahead of the derived path; on Linux without an override, Vex probes `/run/user/<uid>` before `XDG_RUNTIME_DIR` on purpose, because probing the filesystem fact first closes a divergence seen with WSLg's private custom `XDG_RUNTIME_DIR` where the app and the Go bridge could otherwise bind and dial two different directories (`vex-app/src/main/studio/mcp-host/endpoint.ts:56-97`). A machine with neither a private `/run/user/<uid>` nor a private custom `XDG_RUNTIME_DIR` still has no fact both processes can read identically; that residual gap is named in the code, not closed.

#### `VexConfig` keys relevant to Studio

`VexConfig` (`src/config/store.ts:57-153`) is the top-level shape of `config.json`, version `1`. The keys that matter for Studio:

| Key | Default | Scope |
| --- | --- | --- |
| `projectsRoot` | absent, falls back to `~/Vex/projects` (`DEFAULT_PROJECTS_ROOT`) | Studio-specific. Must be absolute; `resolveProjectsRootPath()` (`src/config/paths.ts:139-150`, mirrored in `vex-app/src/main/paths/config-dir.ts`) honours a configured root only if it is non-empty and absolute, else the default wins. `parseProjectsRoot()` at the load boundary (`src/config/store.ts:296-308`) logs a warning and drops a non-empty but relative value. Changing `projectsRoot` after projects already exist is refused at the projects boundary: `vex-app/src/main/studio/projects-root.ts` anchors the root once at first project creation (`anchorProjectsRoot`, the first statement of the create transaction, :201) and every read, delete, and scope edit re-checks it under a share lock (`assertProjectsRootUnchanged`, :246); a proven mismatch fails closed with `projects.root_changed` rather than silently re-homing existing rows. |
| `poolsFunAttestationEnabled` | `true` since 2026-08-24 (`src/config/store.ts:221-226`) | Gates the pools.fun attestation badge signing lane. This is the only config flag in `config.json` that gates a signing operation. `parsePoolsFunAttestationEnabled(raw)` (`src/config/store.ts:166-167`) returns `raw === true` and nothing else: a present but non-boolean value, such as a hand-edited or migrated `"true"` string or a `1`, reads as `false`. This is a deliberate fail-closed choice re-derived after the config spread, so the signing leg and any delivery sweep cannot drift to different answers about whether the lane is on (`src/config/store.ts:437-446`, `:170-177`). |

#### MCP SDK version pin

`package.json:56-57` pins both `@modelcontextprotocol/core` and `@modelcontextprotocol/server` at exactly `2.0.0`. This section confirmed the pin directly against the installed packages: `node_modules/@modelcontextprotocol/core/package.json` and `node_modules/@modelcontextprotocol/server/package.json` both report `"version": "2.0.0"` in this tree.

#### Managed secrets never reach `.env`

`src/providers/env-resolution.ts` splits provider credentials into two lanes. `readEnvValue()` routes a managed-secret key straight to `process.env` and never reads it from the `.env` file on disk (`src/providers/env-resolution.ts:25-29`). `writeAppEnvValue()` throws if asked to write a managed-secret key into `.env` (`src/providers/env-resolution.ts:44-46`), and on every non-secret write it first strips every managed secret key out of `.env` (`src/providers/env-resolution.ts:47-49`), so a secret that somehow landed in the file on disk in the past does not survive the next unrelated write. Managed secrets live only in `process.env` at runtime and in the encrypted secret vault (`secrets.vault.json`) between runs, never in the plaintext `.env` file.

#### Load and save failure behavior

`loadConfig()` (`src/config/store.ts:394-456`) never throws to its caller: a missing file returns defaults; a parse error is caught and logged, then defaults are returned; a `version` field other than `1` is treated as unrecognized and defaults are returned with a warning. `saveConfig()` (`src/config/store.ts:458-480`) writes atomically, to a temp file beside `config.json` and then `rename`s it into place, so a save either fully succeeds or leaves the previous file untouched.

### Docker And Postgres Prerequisites, As They Touch Studio

Studio's own listener does not depend on Docker. Planning and binding the Studio endpoint - the unix socket or, on Windows, the named pipe a coding agent connects to - is pure filesystem and IPC work with no database in the path (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)). What does depend on Docker is the engine underneath it: Studio's project and session state lives in the same Postgres instance the rest of Vex uses for memory, and that instance is a Docker Compose service, not something Studio starts on its own.

Readiness of that database is owned by one function, `whenEngineDbReady` (`vex-app/src/main/database/engine-db-readiness.ts:276`), and it tracks two separate facts rather than one. The first is the connection URL itself: the lazy pool inside the engine reads it from an environment variable that main only sets once Compose has written its connection state and password file, which the module's own documentation puts at "ten to twenty seconds after `whenReady`" on a cold start (`vex-app/src/main/database/engine-db-readiness.ts:23`). The second is whether this build's migrations have actually run. `whenEngineDbReady` polls both, and it does not time out on its own - the comment is explicit that a boot-time consumer which gave up after a fixed number of attempts would be deciding, on the user's behalf, that a database merely slow to start is a database that is never coming (`vex-app/src/main/database/engine-db-readiness.ts:27-33`). The only way to stop the wait is the caller's own `AbortSignal`, passed in as an option (`vex-app/src/main/database/engine-db-readiness.ts:276-277`).

The two services Studio's engine depends on are configured narrowly by the rendered Compose template (`vex-app/resources/compose/docker-compose.template.yml`). Both publish to loopback only, on fixed default ports:

| Service | Default port | Env override | Bind address |
| --- | --- | --- | --- |
| Postgres (`db`) | 27432 | `VEX_PG_PORT` | `127.0.0.1` (`vex-app/resources/compose/docker-compose.template.yml:50-53`; default matches `DEFAULT_PG_PORT`, `vex-app/src/shared/local-service-ports.ts:22`) |
| Embeddings runtime | 27134 | `VEX_EMBED_PORT` | `127.0.0.1` (`vex-app/resources/compose/docker-compose.template.yml:124-127`; default matches `DEFAULT_EMBED_PORT`, `vex-app/src/shared/embedding-defaults.ts:28`) |

Postgres authenticates with SCRAM-SHA-256, never with a plaintext env-var password: `POSTGRES_HOST_AUTH_METHOD` and `POSTGRES_INITDB_ARGS` both pin `scram-sha-256`, and the actual password reaches the container only through `POSTGRES_PASSWORD_FILE` pointing at a Compose `secrets:`-mounted file (`vex-app/resources/compose/docker-compose.template.yml:29-35`).

`VEX_PG_PORT`, `VEX_EMBED_PORT`, and the other compose substitution variables are filled in by Vex's own render step, not variables a user's shell overrides at runtime: `renderCompose` reads the template text and replaces each `${VAR:-default}` placeholder with a literal string value before the file is ever written to disk (`vex-app/src/main/compose/render.ts:130-141`).

### Consolidated Limits And Bounds

Every numeric bound in Vex Studio is a deliberate, enforced ceiling, gathered here by subsystem with the behavior each triggers when reached. None silently discards data: each bound refuses the request, evicts an existing entry to make room, or withholds part of a response while reporting the exact count withheld.

#### Studio socket transport (Unix and Windows named-pipe front)

| Bound | Value | Refusal behavior | Citation |
|---|---|---|---|
| Max connections | 16 | refuse | `bridge-endpoint-vectors.json` (`limits.maxConnections`) |
| Handshake-pending connections | 4 | refuse | `vex-app/src/main/studio/mcp-host/bounds.ts:17` |
| Global in-flight calls | 32 | refuse | `vex-app/src/main/studio/mcp-host/bounds.ts:20` |
| Per-connection in-flight calls | 8 | refuse | `vex-app/src/main/studio/mcp-host/connection.ts:114` |
| Raw listener socket cap | 21 (16 established + 4 handshake-pending + 1 overflow) | overflow slot gives connection 21 a typed `at_capacity` ack, not a bare drop | `vex-app/src/main/studio/mcp-host/bounds.ts:23-33`; bridge accept path `bridge/internal/front/listener/accept.go:19-22` |
| Handshake line | 4096 bytes | refuse | `vex-app/src/main/studio/mcp-host/handshake.ts:30` |
| Inbound MCP frame line | 4 MiB | refuse | `src/vex-agent/mcp/socket-transport.ts:92` |
| Decoded-message queue per connection | 16 | refuse further inbound messages | `src/vex-agent/mcp/socket-transport.ts:95` |
| Outbound pending frames per connection | 64 | refuse further outbound queueing | `vex-app/src/main/studio/mcp-host/outbound-queue.ts:51` |
| Windows front credit window | 65536 bytes per connection per direction | writer never exceeds it; an overrun on the wire is a fatal protocol violation | `pipe-front-vectors.json` (`limits.creditBytesPerConnection`); main-side cap `vex-app/src/main/studio/mcp-host/front-relay-transport.ts:698-707` |
| Windows front chunk size | 32768 bytes | `writeOneChunk` never pushes outstanding bytes past the credit window | `pipe-front-vectors.json` (`limits.chunkBytes`); `vex-app/src/main/studio/mcp-host/front-relay-transport.ts:649-656` |
| Windows raw handle cap | 21 (same 16+4+1 structure as the Unix listener) | overflow slot, typed refusal | `pipe-front-vectors.json` (`limits.maxRawConnections`) |
| Front restart budget | 6 restarts, never resets (`FRONT_MAX_RESTARTS = 5`, `<=` comparison from 0) | past the cap, `front_restart_budget_exhausted` is a durable host-unavailable state; only closing and reopening Vex clears it | `vex-app/src/main/studio/mcp-host/front-supervisor.ts:76` (`FRONT_MAX_RESTARTS`); state name at `vex-app/src/main/studio/mcp-host/front-handshake.ts:187`, closed enum at `vex-app/src/shared/schemas/studio.ts:108` |
| Host shutdown deadline | 5000 ms, one absolute deadline for the whole quit sequence | timing bound, not a refusal | `vex-app/src/main/studio/mcp-host/bounds.ts:36` |

A destroyed Windows-front connection not yet reaped (still waiting on `PEER_CLOSED`) keeps counting frames that arrive for it: they are dropped and counted rather than dispatched, matching how a real socket close behaves (`vex-app/src/main/studio/mcp-host/front-relay-transport.ts:775-790`, pinned by `vex-app/src/main/studio/__tests__/front-relay.test.ts:395-416,567-582`).

#### Approvals

The approval broker caps how many Studio actions can block waiting for a human decision at once: `STUDIO_WAITER_CAP = 32` (`vex-app/src/main/studio/approval-broker.ts:81`). The slot is reserved before the intent row is even written; reaching the cap refuses the call with an honest message ("Vex is already holding 32 actions waiting for approval") rather than queueing a 33rd waiter (`approval-broker.ts:220-231, 203-209`). Every approval carries a default TTL of `APPROVAL_TTL_MS = 60 * 60 * 1000` (1 hour), stamped at enqueue and floored against a trusted prepared action's own expiry when that is shorter (`src/vex-agent/engine/core/approval-runtime/enqueue.ts:118,392-402`); a scheduled sweep every 5 minutes (`SWEEP_INTERVAL_MS`) settles anything expired (`vex-app/src/main/ipc/approvals.ts:44,58-63`, driving `runScheduledSweep` in `vex-app/src/main/ipc/approvals/_sweep.ts`).

#### Desktop workspace (files, terminals, search, viewer)

| Bound | Value | Refusal behavior | Citation |
|---|---|---|---|
| Kept-alive project workspaces | 4 | refuses a 5th, never evicts an existing one | `vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:36` |
| Live terminal groups per project | 4 | refuse (`keep_alive_limit`) | `vex-app/src/renderer/features/appShell/studio/workspace/types.ts:42`; `vex-app/src/renderer/features/appShell/studio/workspace/workspace-model.ts:95` |
| Open file tabs per project (live strip) | 16 | refuse (`file_tab_limit`) | `vex-app/src/renderer/features/appShell/studio/workspace/types.ts:66`; `vex-app/src/renderer/features/appShell/studio/workspace/workspace-model.ts:245-246` |
| Live terminals per project | 12 | refuse | `vex-app/src/shared/schemas/terminal.ts:111` |
| Live terminals globally | 24 | refuse | `vex-app/src/shared/schemas/terminal.ts:114` |
| Terminal flow watermarks | 100,000 chars high / 5,000 chars low | pty paused above the high watermark, resumed below the low one | `vex-app/src/shared/schemas/terminal.ts:72,75` |
| Terminal write packet | 256 KiB | refused, never cut | `vex-app/src/shared/schemas/terminal.ts:101` |
| Terminal emergency ceiling | 8 MiB | forces a detach-and-resync of the terminal | `vex-app/src/shared/schemas/terminal.ts:98` |
| Terminal host restart budget | 6 restarts, never resets (`TERMINAL_HOST_MAX_RESTARTS = 5`, counts 0-5) | past the cap the host is durably `unavailable`; every terminal request refuses `host_unavailable` until Vex itself restarts | `vex-app/src/shared/schemas/terminal.ts:267`; `vex-app/src/main/studio/pty-host-starter.ts:255-272` |
| Highlight worker input | 512 KiB (`VIEWER_HIGHLIGHT_MAX_BYTES`) | refuse to highlight (`too_large_to_highlight`) | `vex-app/src/renderer/features/appShell/studio/viewer/file-viewer-session.ts:113` (constant), `:750` (refusal) |
| Highlight worker restart budget | 3 (`HIGHLIGHT_WORKER_MAX_RESTARTS`), no reset | port becomes durably `worker_unavailable` for the rest of the renderer's life | `vex-app/src/renderer/features/appShell/studio/viewer/highlight/highlighter-port.ts:64` |
| File-read cap | 2 MiB (2,097,152 bytes, `FILE_READ_MAX_BYTES`) | viewer read refused `too_large` with the real size named | `vex-app/src/shared/schemas/files.ts:80` |
| File watcher restart budget | 5 (`FILES_WATCHER_MAX_RESTARTS`) | then terminal `unavailable` | `vex-app/src/shared/schemas/files.ts:118` |

#### Installer

| Bound | Value | Refusal behavior | Citation |
|---|---|---|---|
| Managed-block body | 24,576 bytes (24 KiB), derived from the review's 32,768-byte limit minus an 8 KiB reserve | test-enforced hard bound; the remedy is moving a section to the guide, never truncating a sentence | `src/vex-agent/studio/installer/render/managed-block.ts:158` |
| Any file the installer reads/parses/rewrites | 1,048,576 bytes (1 MiB) | refuse, re-checked against the actual bytes read, not just the preflight stat | `vex-app/src/main/studio/installer/paths.ts:62`; `vex-app/src/main/studio/installer/confined-fs.ts:211-219` |
| `project_change_notes.summary` | 400 characters (DB CHECK constraint, migration 089) | database rejects the write | measured against the full artifact roster: 315 characters worst case (`vex-app/src/main/studio/installer.ts:701-709`) |

#### Docker services

Postgres and the embeddings runtime both publish only to `127.0.0.1` (`vex-app/resources/compose/docker-compose.template.yml:6,53,127`): Postgres at `${VEX_PG_PORT:-27432}` (`DEFAULT_PG_PORT = 27432`, `vex-app/src/shared/local-service-ports.ts:22`), embeddings at `${VEX_EMBED_PORT:-27134}` (`DEFAULT_EMBED_PORT = 27134`, `vex-app/src/shared/embedding-defaults.ts:28`). Neither port is exposed beyond loopback by default.

#### The refusal taxonomy

Three distinct behaviors cover every bound above, and the code never falls back to a fourth (silent truncation):

- **Refuse**: the request is rejected outright and nothing happens - the connection-count, in-flight-call, approval-waiter, terminal-count, and file-size bounds above all refuse this way.
- **Evict**: an older or least-recently-used entry is removed to admit a new one - for example the main-side file-name index keeps at most 4 concurrently held indexes on an LRU basis (`vex-app/src/shared/schemas/studio-search.ts:111-117`, `SEARCH_INDEX_PROJECT_MAX = 4`), and a full snapshot directory evicts the oldest inactive project rather than refusing the write outright (`vex-app/src/pty-host/snapshot-store.ts:28-33,209-253`, bounded by `SNAPSHOT_DIR_MAX_BYTES = 64 * 1024 * 1024` at `vex-app/src/shared/schemas/terminal.ts:132`).
- **Withhold-and-count**: part of a response is deliberately left out, and the omission is named with its exact size or count rather than hidden. The `vex_ToolSearch` tool re-filters every candidate row through the same predicate `tools/list` uses, pulls out any tool the current surface withholds, and reports it by name in a `warnings` string with `totalCount` adjusted down by the withheld count (`src/vex-agent/mcp/tool-search-export.ts:302-314,340-352`). The bridge's stderr diagnostic line applies the same discipline at the byte level: when a peer-supplied message does not fit the 512-byte total budget, the omitted portion is named with its exact byte count rather than cut silently (`bridge/internal/handshake/handshake.go:41-50` for the budget constant, `:294-334` for the `Diagnostic`/`omissionNotice` naming logic).

No bound in this table is enforced by convention alone; each one is backed by a test that exercises the boundary condition, consistent with the file-level citations above.

### Consolidated Closed Error-Code Enumerations

Vex Studio never returns a generic "unexpected error" for a named failure. Every subsystem that can refuse or fail defines its own closed TypeScript union or Go exit-code set, and every member carries a distinct remedy or an explicit statement that none exists. This section gathers every such enumeration into one reference table so a maintainer tracing a symptom back to a wire value does not have to re-derive the set from twenty separate files. The "next step" column follows the same distinction the reference GitHub MCP server's error-handling notes draw between a user-actionable failure and a developer/internal-only signal that never reaches a human sentence.

#### Protocol and host refusal codes

| Enumeration | Members | Source | Next step |
|---|---|---|---|
| `StudioHandshakeRefusalCode` | 5: `unknown_project, incompatible_version, locked, at_capacity, malformed` | `vex-app/src/main/studio/mcp-host/handshake.ts:36-41` | Yes, per member: the Go bridge maps each to one of its own exit codes below; this is a wire contract, not a suggestion. |
| `StudioHostUnavailableCause` | 9: `starting, fence_uninitialized, shutting_down, not_configured, endpoint_unavailable, front_unavailable, pipe_security_unconfirmed, front_restart_budget_exhausted, admission_permanently_closed` | `vex-app/src/shared/schemas/studio.ts:51-119` | Mixed. `starting`/`fence_uninitialized`/`shutting_down` self-resolve; `front_unavailable` means reinstall or rebuild the bridge; `front_restart_budget_exhausted` and `admission_permanently_closed` both mean restart Vex, the latter irreversibly for the process lifetime. |
| `StudioEndpointRefusalCode` | 9: `override_not_absolute, override_invalid_pipe, override_pipe_on_unix, endpoint_ancestor_changed, override_parent_missing, override_parent_not_directory, override_parent_not_owned, override_parent_mode, path_too_long` | `vex-app/src/main/studio/mcp-host/endpoint.ts:121-130` | Yes, each names the misconfigured `VEX_STUDIO_SOCKET` override or ancestor-directory condition to fix; the detail sentence stays in main's log, never on the wire. |
| `FrontFailureName` (Windows pipe-front) | 22 members, `binary_unavailable` through `restart_budget_exhausted` | `vex-app/src/main/studio/mcp-host/front-handshake.ts:118-166` | Collapsed to one of four `StudioHostUnavailableCause` values by `frontFailureCause` (`vex-app/src/main/studio/mcp-host/front-handshake.ts:175-195`): three frame-confirmation failures fail closed as `pipe_security_unconfirmed`, `restart_budget_exhausted` and `admission_epoch_exhausted` keep their own causes, everything else collapses to `front_unavailable` (reinstall/rebuild is the one remedy for the whole class). |
| `StudioCallOutcome` | 7: `completed, declined, expired, refused, dispatch_failed, indeterminate, not_queued` | `src/vex-agent/mcp/outcome.ts:21-70` | Per member, stated verbatim in the tool's own approval sentence: `indeterminate` must never be retried and is resolved by the scheduled reconciler, not by the agent polling it (`conventions.ts:794-800`, `outcome.ts:60-61`); the agent instead opens Vex and reads the approval (`shared-usage.ts:345-351`). Polling applies to a different word, `pending` - a sub-status of a completed call, not a member of this union - which the same sentence says to poll and never re-send while it is outstanding (`conventions.ts:797-798`). |
| `STUDIO_REFUSAL_CAUSES` (studio-gate) | 7: `stopped, slot_lost, fence_unproven, scope_changed, project_deleted, scope_unreadable, scope_version_missing` | `src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:67-85` | Yes, each is a distinct human sentence with its own remedy; these are the dispatch-time re-checks `runStudioDispatchGate` performs under the session control lock immediately before an approved call runs. |

#### Bridge process exit codes

The Go bridge binaries (`vex-mcp`, `vex-pipe-front`) do not return structured objects to their parent process; they exit with a numeric code, which is itself a closed enumeration.

| Set | Members | Source | Next step |
|---|---|---|---|
| `vex-mcp` exit codes | 13, `exitOK=0` through `exitSignal=12` | `bridge/cmd/vex-mcp/main.go:42-56` | Yes, per member: every non-`exitOK` return goes through `fail(code, message)` with its own one-sentence stderr text built at the call site (for example the usage sentence at `exitUsage`'s two call sites, `main.go:84,89`; the handshake-refusal sentences at `main.go:353-364`; the relay/signal sentences at `main.go:388-396`), so the supervising client's remedy is the code's stderr line, not a lookup table. |
| `vex-pipe-front` exit codes | 10, `Clean=0` through `ParentGone=9` | `bridge/internal/front/lifecycle/exit.go:20-49` | Unverified in this section: the per-code stderr/remedy text for `vex-pipe-front`'s exit set was not read as part of this review. |

Both are closed sets a launcher can switch on exhaustively; codes 5-9 of the `vex-mcp` set exist specifically to mirror `StudioHandshakeRefusalCode` one-to-one, plus `exitRefusedUnknownCode` for forward compatibility with a host that speaks a newer protocol.

#### Files, terminal, and no-follow refusals

| Enumeration | Members | Source | Next step |
|---|---|---|---|
| `FilesErrorCode` | 24 (18 read-side, 6 mutation-side) | `vex-app/src/shared/schemas/files.ts:373-452` | Delivered inside a successful `Result`, never as `Result.error`: `too_large`, `binary`, `invalid_utf8`, `symlinked_path` and `path_changed` are facts about the file the viewer renders directly; the rest (`watcher_limit`, `mutation_busy`, and similar) carry their own retry or wait instruction. |
| `NoFollowRefusal` (agent-side image reads) | 10: `not_absolute_root, escapes_root, symlink, not_found, not_a_regular_file, permission_denied, too_large, empty_file, unsupported_image, read_failed` | `src/vex-agent/studio/files/no-follow-open.ts:75-85` | Yes, each carries a human-readable detail string; `escapes_root` deliberately omits the resolved absolute path so a probing model cannot map the filesystem outside the project. |
| `TerminalErrorCode` | 17: `launch_cwd_missing` through `snapshot_unavailable` | `vex-app/src/shared/schemas/terminal.ts:387-434` | Partial: `REFUSAL_COPY` in `terminal-copy.ts:286-298` gives 7 of the 17 a direct sentence (`limit_project_terminals`, `limit_global_terminals`, `host_unavailable`, `project_deleting`, `create_timeout`, `launch_shell_unavailable`, `snapshot_unavailable`). A second, distinct `REFUSAL_COPY` map local to `XtermHost.tsx:150-159` covers 6 codes for the live open-pane alert (`role="alert"`, rendered at `XtermHost.tsx:461` from whatever code arrives on `onTerminalRefused`, `XtermHost.tsx:341-343`), including `foreign_terminal` ("This terminal belongs to another window.") and `write_too_large` ("That input was too large to send in one packet."); `foreign_terminal` is a real computed state, not a UI-prevented one - main returns it explicitly when a terminal's owning window no longer matches the caller's (`vex-app/src/main/studio/terminals.ts:432`). Only `unknown_terminal`, `invalid_packet` and `port_unavailable` lack bespoke copy in either map and fall through to the generic `` `The terminal service refused: ${refusal}.` `` line (`XtermHost.tsx:461`); the remaining launch-side codes surface through the generic create-failure path instead of a per-code sentence. |
| `WorkspaceCloseFailure` (terminal-close-specific) | 4: `persist_unreachable, persist_refused, kill_incomplete, kill_not_owned` | `vex-app/src/renderer/features/appShell/studio/workspace/close-lifecycle.ts:113-125` | Yes, each is a distinct sentence in `CLOSE_FAILURE_COPY`: the first two mean nothing closed and nothing was lost, the last two mean the layout saved but a shell may still be running. |

#### Installer and highlight-worker refusals

`StudioRefusalReason`, the installer's closed refusal set, has 15 members in the current tree, not 12: `malformed_json, malformed_toml, toml_multiline_string, malformed_managed_block, provenance_collision, unknown_keys_in_vex_entry, symlinked_path, not_a_regular_file, too_large, invalid_utf8, ambiguous_twin, source_changed, path_escape, io_error, file_locked` (`vex-app/src/shared/schemas/studio-installer.ts:64-100`). Every member has its own detail sentence; none is silently collapsed into another, because "someone else owns this entry" and "this file is 40 MB" are different problems with different fixes.

`PlainReason`, the closed union behind every "not highlighted" chip in the file viewer, has 8 members: `plain_language, too_large_to_highlight, grammar_unavailable, tokenize_failed, worker_failed, worker_unavailable, malformed_result, too_many_tokens` (`vex-app/src/renderer/features/appShell/studio/viewer/viewer-copy.ts:237-245`, exhausted by `plainReasonText` at `:267-286`). `worker_failed` is the only member whose sentence promises a retry, and that promise holds only because opening or re-highlighting the next file rebuilds the worker when its restart budget is not yet spent; a spent budget resolves as `worker_unavailable` instead, so a viewer never sees a `worker_failed` chip it cannot recover from. The `plain_language` chip is additionally suppressed at render time for files whose language has no grammar at all, on the reasoning that a grammar sentence on a file with no grammar is noise.

#### Project lifecycle errors

All `projects.*` failures are minted by one owner, each carrying `retryable`, `userActionable`, and `correlationId` fields alongside its redacted message (`vex-app/src/main/studio/project-errors.ts:1-18,22-40`). The set has 16 codes: `projects.root_changed`, `projects.root_unverifiable`, `projects.root_unavailable`, `projects.slug_taken`, `projects.root_permission_denied`, `projects.root_out_of_space`, `projects.root_path_invalid`, `projects.name_reserved`, `validation.invalid_input`, `projects.deleting`, `projects.slug_cleanup_pending`, `projects.not_found`, `projects.scope_conflict`, `projects.wallet_drift`, `projects.backing_session_integrity`, and `wallets.invalid_selection` (`project-errors.ts:48-306`). Three of these are marked `retryable: true` (`root_unverifiable`, `root_unavailable`, `slug_cleanup_pending`); the rest require a changed input, a different slug, or, for `backing_session_integrity`, an operator: the map that documents this table found no automated repair path for that specific mismatch in the current stage.

### Facts And Numbers Reference

This section collects every load-bearing number for Vex Studio in one flat table, each traced to
`measured-counts.md`, `src/vex-agent/studio/agents.ts` or a specific `file:line`. Where code and a
stale plan document disagree, the numbers below are what the code does today.

#### Top-level counts

| fact | value | evidence |
|---|---:|---|
| coding-client agent ids in the registry | 15 | `src/vex-agent/studio/agents.ts:311-762` (15 `id:` entries), `STUDIO_AGENT_LIST` walks the same order |
| agents Vex actually writes config for | 13 | `agents.ts:311-725`; `cline` and `warp` are `unsupported` writers, no file is written for either (`agents.ts:737-757,759-762`) |
| exported Studio MCP tools | 213 | `exported-tools.md` Totals; 29 internal + 184 protocol |
| internal tools (hot set, always loaded) | 29 | `exported-tools.md` Totals (`internal: 29`, `always loaded: 29`) |
| exported protocol tools | 184 | `src/vex-agent/mcp/export-scope.ts:79-104,129-137`; the catalog holds 185 protocol manifests, and exactly one, `launchpads.images`, is withheld from every Studio-facing surface (`tools/list`, `vex_ToolSearch`, and call admission alike) because it lists images staged in the desktop app's local locker, which an external Studio agent does not have |
| protocol namespaces | 12 | khalani, solana, kyberswap, uniswap, relay, dexscreener, lighter, virtuals, pendle, morpho, pools, launchpads |
| read-only exported tools | 129 | `exported-tools.md` Totals |
| destructive exported tools | 63 | `exported-tools.md` Totals |
| approval expiry window | 1 hour | `APPROVAL_TTL_MS = 60 * 60 * 1000` (3,600,000 ms), `src/vex-agent/engine/core/approval-runtime/enqueue.ts:118` |

#### Per-namespace manifest counts (185 total, 12 namespaces)

| namespace | manifests |
|---|---:|
| khalani | 9 |
| solana | 34 |
| kyberswap | 4 |
| uniswap | 2 |
| relay | 2 |
| dexscreener | 18 |
| lighter | 40 |
| virtuals | 13 |
| pendle | 29 |
| morpho | 19 |
| pools | 13 |
| launchpads | 2 |

These are manifest counts, not exported-tool counts: every namespace exports its full manifest
count except `launchpads`, which exports 1 of its 2 (`launchpads.image_publish` ships,
`launchpads.images` is withheld) [see resolved/numbers.md]. A per-namespace breakdown of the 184
*exported* tools (as opposed to the manifest counts above) is not reproduced in this flat table;
it is tracked separately, along with the readOnlyHint/destructiveHint split per namespace, and is
owed as a follow-up in `resolved/numbers.md`.

Sources: every figure in the two tables above is copied from
`src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md` (regenerated by
`pnpm generate:studio-tools-doc`, checked in CI with `--check`), except the 185 manifest total,
which is `PINNED_LIVE_CATALOG_TOOL_COUNT` in `src/__tests__/eval/live-catalog.ts:50`.

#### Fee rate and connection bounds

Every fee-bearing venue measured in this pass charges the same rate: `KYBERSWAP_FEE_BPS`
(`src/tools/kyberswap/constants.ts:50`), `BRIDGE_FEE_BPS`
(`src/tools/bridge-fee/constants.ts:36`), and `WALLET_TX_FEE_BPS`
(`src/vex-agent/tools/internal/wallet/transaction/vex-fee.ts:67`) are each `25` (25 basis points,
0.25%). This is not a rate charged before the underlying operation succeeds; a fee is only taken
after the operation it charges for succeeds [see s5 money-path sections].

| bound | value | evidence |
|---|---:|---|
| `STUDIO_MAX_CONNECTIONS` | 16 | `vex-app/src/main/studio/mcp-host/bounds.ts:14`, mirrored on the wire as `STUDIO_MAX_CONNECTIONS_WIRE` (`vex-app/src/shared/schemas/studio.ts:151`) |
| `STUDIO_MAX_HANDSHAKE_PENDING` | 4 | `vex-app/src/main/studio/mcp-host/bounds.ts:17` |
| `STUDIO_MAX_INFLIGHT_GLOBAL` | 32 | `vex-app/src/main/studio/mcp-host/bounds.ts:20` |
| `STUDIO_MAX_LISTENER_SOCKETS` (16 + 4 handshake-pending + 1 overflow) | 21 | `vex-app/src/main/studio/mcp-host/bounds.ts:14,17,32-33` (overflow-socket rationale at lines 22-31) |
| `STUDIO_WAITER_CAP` (approval-broker) | 32 | `vex-app/src/main/studio/approval-broker.ts:81` |

The `STUDIO_WAITER_CAP` citation above corrects a wrong line number (75) that appeared in one
evidence map; the constant is declared at line 81, matching the other maps that cite it there.


## Part 10 - Packaging, Signing, And Release

### How The Bridge Binaries Are Staged And Packaged

Vex Studio's coding-agent bridge (`vex-mcp`, plus `vex-pipe-front` on Windows) is a Go binary built outside the Electron packaging step and copied into the app afterward. That copy has to be fail-closed: electron-builder 26's own `extraResources` handling only warns on a missing source file and packages the app anyway (`vex-app/build/afterPack.mjs:72-74`). Vex layers three independent checks on top of that gap: a staging preflight, a post-pack re-inspection, and, on the release pipeline, dedicated CI steps.

#### The identity table

`vex-app/scripts/bridge-artifact.mjs` is the single owner of the arch/platform mapping and the artifact table; every other script imports from it rather than restating any of it. It defines `PACKAGED_BRIDGE_SUBPATH = "bridge"` (`vex-app/scripts/bridge-artifact.mjs:51`) and the artifact table (`vex-app/scripts/bridge-artifact.mjs:78-89`):

| artifact | Go package | targets |
|---|---|---|
| `vex-mcp` | `./cmd/vex-mcp` | all 6: `darwin-arm64`, `darwin-amd64`, `windows-amd64`, `windows-arm64`, `linux-amd64`, `linux-arm64` |
| `vex-pipe-front` | `./cmd/vex-pipe-front` | `windows-amd64`, `windows-arm64` only |

`artifactsFor(goos, goarch)` (`vex-app/scripts/bridge-artifact.mjs:115-124`) refuses an unmapped triple by throwing, rather than returning an empty list - an empty list would read downstream as "all zero artifacts verified", a gate that passes vacuously. `bridge/build.sh`'s own `ARTIFACTS=(...)` bash array mirrors this table by hand (bash cannot import ESM); a drift test asserts the two stay in sync byte-for-byte.

Each candidate file is identified by its own executable header, never by file name or extension: ELF (64-bit little-endian, `e_machine` at offset 18), Mach-O (`cputype` at offset 4, with a universal/fat Mach-O explicitly refused since the build wrapper emits one binary per architecture on purpose), or PE (`MZ` plus `e_lfanew` plus `PE\0\0`, machine field checked) (`vex-app/scripts/bridge-artifact.mjs:195-241`). A file under 64 bytes is rejected as too short to be an executable (`vex-app/scripts/bridge-artifact.mjs:190-191`).

#### Staging: per-architecture, verified twice

`vex-app/scripts/stage-bridge.mjs` runs before every `electron-builder` invocation, dev and release alike. For the target platform/arch it locates each artifact under `bridge/dist/<goos>-<goarch>/`, verifies it, then copies it into `resources/bridge-<electronArch>/` - one staging directory per Electron architecture, never one shared across architectures (`vex-app/scripts/stage-bridge.mjs:1-127`). That split exists because the macOS release job packages arm64 and x64 in one electron-builder invocation; a shared directory would let one architecture's binary leak into the other's bundle.

Every artifact for a target is verified before any file is written - a target whose second artifact is missing fails with the previous staging directory untouched, not half-populated (`vex-app/scripts/stage-bridge.mjs:79-93`). On success the destination directory is cleared with one recursive `rmSync` and recreated, so a leftover binary from a prior architecture cannot ride along. Each copied file is `chmod 0o755`'d, then re-verified at the staged destination, not the source - confirming the exact bytes that will actually be packaged (`vex-app/scripts/stage-bridge.mjs:108-119`).

#### Packaged path vs. staging path

The staging directory (`resources/bridge-${arch}`) exists only before packaging and is per-architecture by name. The packaged path, `resources/bridge/` (`Contents/Resources/bridge/` on macOS, `resources/bridge/` on Windows and Linux), is different: electron-builder's `extraResources` config maps each per-arch staging directory to one `to: bridge` destination inside the package (`vex-app/electron-builder.yml:77-90`), so the packaged path is arch-independent by construction. This is exactly the absolute path installer-written coding-agent configs name.

#### afterPack: re-inspecting before fuses and signing

`vex-app/build/afterPack.mjs` is electron-builder's `afterPack` hook. It runs `verifyPackagedBridge`, which re-inspects the bytes electron-builder actually placed in the package - not the staged source - using the same header inspector and the same target-aware `artifactsFor`, so a Windows package is checked for both binaries while a macOS or Linux package is not held to the Windows-only `vex-pipe-front` (`vex-app/build/afterPack.mjs:48-79`). This runs before Electron fuses are flipped, which itself runs before code-signing, so a broken package never reaches a signature (`vex-app/build/afterPack.mjs:128-144`).

#### Runtime resolution: no PATH search

`vex-app/src/main/studio/installer/bridge-path.ts` resolves the bridge path the installer writes into every coding-agent config. `locateStudioBridge()` names exactly one of two absolute paths, chosen by `app.isPackaged` (`vex-app/src/main/studio/installer/bridge-path.ts:93`): packaged, `path.join(process.resourcesPath, "bridge", name)` (`vex-app/src/main/studio/installer/bridge-path.ts:96-99`); development, the repo's `bridge/dist/<goos>-<goarch>/` layout (`vex-app/src/main/studio/installer/bridge-path.ts:110-117`). Neither branch performs a `PATH` search or falls back to a bare command name - a config naming just `vex-mcp` would let any binary of that name on the user's `PATH` be spawned with the project's authority. A missing or non-executable binary returns an `unavailable` outcome with a named remediation rather than a config pointing at nothing, matching exactly what CI verified before the binary shipped (`vex-app/src/main/studio/installer/bridge-path.ts:120-130`).

### Signing, Notarization, And The Draft-Release Gate

The Vex Studio bridge (`vex-mcp`, and on Windows `vex-pipe-front`) ships inside the packaged app, and the release pipeline treats it as a code-signing target in its own right, distinct from the app bundle it lives inside.

#### macOS: two signatures, two verification steps

The macOS release job runs one `electron-builder --mac --arm64 --x64 --publish always` invocation that both signs the `.app` bundle with a Developer ID identity from `CSC_LINK`/`CSC_KEY_PASSWORD` and, separately, re-signs the nested `Contents/Resources/bridge/vex-mcp` Mach-O through electron-builder's `mac.binaries` list (`vex-app/electron-builder.release.yml:139-141`). The release profile's own comment states why the nested binary needs its own signature: it "must carry its own signature or the hardened runtime refuses to launch it and notarization rejects the bundle" (`vex-app/electron-builder.release.yml:135-137`). The same `binaries` list also carries the two `node-pty` `spawn-helper` executables, which have no file extension and are missed by `@electron/osx-sign`'s default nested-binary walker.

CI then runs two separate post-package verification steps, and they check different things. `Verify notarization stapled to the .app bundles` runs `xcrun stapler validate` and `spctl -a -vvv -t exec` against each `.app` (`.github/workflows/release.yml:294-309`). A distinct step, `Verify the embedded Vex Studio bridge is signed`, asserts the file exists at `Contents/Resources/bridge/vex-mcp`, then runs `codesign --verify --strict --verbose=2` and `codesign --display --verbose=2` against that binary specifically (`.github/workflows/release.yml:315-331`). The step's own comment explains the split: "an unsigned nested Mach-O fails at launch under the hardened runtime, not at package time" (`.github/workflows/release.yml:312-314`) - a bundle-level stapler check would not catch a bridge binary that lost its signature.

#### Windows: Azure Trusted Signing over every extraResources exe

The Windows job preflights `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`, failing closed if any is missing, then runs `electron-builder --win --x64 --publish always`. Azure Trusted Signing signs inside that build step, because `latest.yml`'s sha512 hashes are computed after signing and a post-build signing pass would corrupt auto-update for every client (`vex-app/electron-builder.release.yml:187-189`). App-builder-lib's signer applies to every `.exe` copied through `extraResources`, which includes both bridge binaries, `vex-mcp.exe` and `vex-pipe-front.exe`, not only the main installer: `shouldSignFile`'s `.exe` backward-compatibility branch (`vex-app/node_modules/app-builder-lib/out/winPackager.js:197-198`) is applied by `createTransformerForExtraFiles`'s `CopyFileTransformer(this.signIf)` wrap (`vex-app/node_modules/app-builder-lib/out/winPackager.js:215-223`), which `platformPackager.js` invokes over the extraResources copy via `copyFiles(extraResourceMatchers, transformerForExtraFiles)` during packaging (`vex-app/node_modules/app-builder-lib/out/platformPackager.js:240-241`).

CI verification runs two Windows-specific steps. `Verify Authenticode signature` runs `Get-AuthenticodeSignature` against every `.exe` under `dist-electron` and asserts three independent conditions: `Status -eq 'Valid'`, the signer subject matches `VEX LABS PTE. LTD.` by regex, and an RFC3161 timestamp is present - an untimestamped signature is treated as a hard failure because the Trusted Signing leaf certificate lives roughly 72 hours (`.github/workflows/release.yml:518-537`). `Verify the packaged Vex Studio bridge binaries (Windows)` then asserts both `vex-mcp.exe` and `vex-pipe-front.exe` exist by name at `resources\bridge\<name>`, not merely that some `.exe` is present (`.github/workflows/release.yml:554-572`).

#### The release stays a GitHub draft through all of the above

A dedicated `create-release` job runs before any platform job and unconditionally pre-creates the tag's GitHub release as a draft, or reuses one that already exists as a draft (`.github/workflows/release.yml:102-136`). The three platform jobs all `needs: create-release` (`.github/workflows/release.yml:141,335,410`) and upload their signed artifacts to that draft.

Two comments in the repository disagree about what happens next, and only one matches the code that actually runs. `vex-app/electron-builder.release.yml:229-233` calls this "Zero-touch auto-publish on tag" and states the release "is PUBLISHED as soon as the pipeline uploads the artifacts... with no human artifact-review gate in between," citing `releaseType: release` (`vex-app/electron-builder.release.yml:234`). That is not what the pinned vendored publisher does. `electron-publish@26.8.1`'s `GitHubPublisher.getOrCreateRelease` finds the pre-existing release by tag and, when it is a draft, returns it unconditionally: `if (release.draft) { return release; }` (`vex-app/node_modules/electron-publish/out/gitHubPublisher.js:65-67`). `releaseType` is read only when a brand-new release must be created; nothing in `gitHubPublisher.js` sets `draft: false` on an existing release. Because `create-release` always pre-creates the draft, this branch is the one every release takes, so the release stays a GitHub draft after all three platform jobs finish uploading. The workflow's own top-of-file comment matches that behavior: "review the DRAFT release... and click 'Publish release'. Users' updaters only see PUBLISHED releases," with a parenthetical naming the same mechanism as the stale `electron-builder.release.yml` comment above - "to make publish fully zero-touch, set publish.releaseType: release in vex-app/electron-builder.release.yml" (`.github/workflows/release.yml:26-30`). But `releaseType: release` is already set in the release profile today (`vex-app/electron-builder.release.yml:234`), and it still does not achieve zero-touch, because `create-release` always pre-creates the draft before any platform job runs and `getOrCreateRelease`'s draft branch returns that pre-existing draft unconditionally, never reading `releaseType` at all. The workflow comment's own prescription for zero-touch publish is therefore already in place in the code and does not produce the effect it describes. Publishing today is not zero-touch on tag push: a human still reviews the draft and clicks Publish. The practical consequence for the signing checks above is favorable regardless of which comment is stale - because the release cannot be published from inside `getOrCreateRelease`'s draft branch, every codesign, Authenticode, and bridge-presence verification step in this pipeline runs while the release is still invisible to `electron-updater` and to `GET .../releases/latest`, strictly before the point a human's Publish click would let a user's auto-updater see the bytes.

#### The fail-closed guard behind the draft precreation

`create-release`'s own comment frames the guard as a fix for a specific prior incident: an earlier version of the step "accepted ANY existing release for the tag," after which `electron-builder`'s `releaseType: release` would find that release and overwrite its assets - including a case where the tag's release had already been published and users were already running its artifacts (`.github/workflows/release.yml:113-121`). That overwrite happened before the signature and notarization checks later in the same workflow could object, so "users on auto-update would have been served the new bytes" without those bytes having passed the checks described above. The current step reads the release's `isDraft` state via `gh release view` and fails the entire job with an explicit error if a release for the tag exists and is not a draft, rather than reusing it (`.github/workflows/release.yml:124-129`).


## Part 11 - End-To-End Journeys

### Journey: First-Time Setup Through The First Tool Call

You launch Vex for the first time and, once the setup orchestrator's parallel probes (system health, Docker detection, onboarding env state) resolve, land on the classic system-check screen rather than any silent background handoff - on a first run the orchestrator never auto-starts compose or migrations behind the scenes; that fast path is reserved for a returning user whose setup was already completed (`vex-app/src/renderer/features/setup/useSetupOrchestrator.ts:1-19`). From system check you click Continue through separate Docker bootstrap, database-compose, and migration screens in turn, each gating on its own completion rather than resolving invisibly underneath the check screen (`vex-app/src/renderer/App.tsx:4-11`, `vex-app/src/renderer/features/systemCheck/SystemCheck.tsx:121`). Nothing about the MCP surface is reachable yet. The admission gate the Studio agent bridge sits behind boots locked - `locked = true` is the literal initial state - and stays locked through the whole system check (`vex-app/src/main/studio/mcp-host/admission.ts:81`). It is your vault unlock, and only your vault unlock, that flips it open: `secrets/session.ts` is the sole production caller of the open, and it calls only once the vault is unlocked, the dispatch fence is unpoisoned, and any pending durable refusal has been written (`vex-app/src/main/studio/mcp-host.ts:288-299`, `vex-app/src/main/secrets/session.ts:355-363`).

Once you are in, the shell offers a "Runtime mode" control with a Studio option next to the ordinary agent chat mode; picking it flips the same DOM node's mode attribute from agent to studio rather than mounting a second screen, so you stay on one shell while its behavior changes underneath you (`vex-app/e2e/studio.spec.ts:167-214`). From there, "New project" opens a dialog where you name the project, pick a coding agent to wire it for, and choose which wallet it can see. The agent list only offers integrations Vex actually knows how to configure - agents Vex cannot wire a config for are not shown as a choice you could pick and have fail later (`vex-app/e2e/studio-project-journey.spec.ts:234-237`, agents marked unsupported at `src/vex-agent/studio/agents.ts:736-777`). The wallet field mirrors your real wallet inventory; if you have not added one yet, it says so plainly instead of presenting an empty dropdown (`vex-app/e2e/studio.spec.ts:240-278`).

Clicking Create runs the installer. It queues your project's render as its own single-flight lane - a second create or reconcile for the same project waits behind the first rather than racing it, and if a newer render supersedes an older one that is still queued, the older one reports itself as superseded and writes nothing (`vex-app/src/main/studio/installer.ts:117-134`). The run then reloads the committed project scope (not whatever the UI still remembers), resolves the project's real directory under the anchored projects root, and only then reaches for the compiled bridge binary the coding agent will actually talk to (`vex-app/src/main/studio/installer.ts:7-28`).

This is the point where a fresh source checkout without a built bridge fails, and it is worth being precise about how it fails. If the bridge binary is not where the installer expects it, nothing about that project's files is written, not even a partial config left half-done - the run reports a headline failure, `runFailure.kind = "bridge_unavailable"`, rather than a soft per-artifact warning sitting under an otherwise cheerful "reconciled" message (`vex-app/src/main/studio/installer.ts:168-183`). The failure names a concrete remediation - reinstall Vex, or build the bridge if you are running from source - rather than a generic error (`vex-app/src/main/studio/installer/bridge-path.ts:123-129`).

When the bridge is present, the installer proceeds to write the project's files - the agent config the coding tool will read, plus its markdown briefing file - and the report renders in a fixed dialog slot where it is genuinely visible, not merely present somewhere in the DOM below the fold (`vex-app/e2e/studio-project-journey.spec.ts:241-253`). Everything lands on disk under that project's own directory, never mixed into an unrelated location (`vex-app/e2e/studio-project-journey.spec.ts:289-311`). Opening the new project row mounts the Studio workspace and brings up its first terminal tab automatically, so the very next thing you see is a live shell inside the project you just created (`vex-app/e2e/studio-project-journey.spec.ts:321-340`).

From here the coding agent you configured can actually use Vex. A real MCP client - no model involved yet, just the protocol handshake - connects, initializes, and lists tools, seeing entries like `vex_ToolSearch`, `vex_ToolDescribe`, and DexScreener tools such as `dexscreener__pairs_search` and `dexscreener__candles_list` (`vex-app/e2e/studio-mcp-live.spec.ts:369-399`). Calling a read-only tool from that list - a DexScreener lookup, for instance - succeeds with the config the installer wrote, no manual overrides, no extra setup step, its result validated against the protocol's own schemas (`vex-app/e2e/studio-mcp-live.spec.ts:410-446`). That is the whole arc: from a locked vault at cold boot to a live, working tool call, without you having to hand-edit a single config file (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)).

### Journey: A Read-Only Research Session

You open a project in Studio, point your MCP-capable agent at it, and ask it to look something up: a pair's price, a token's recent candles, a search across pools. Nothing about this path asks you for a decision.

The mechanism is the same handshake and discovery walk as first setup (see [Journey: First-Time Setup Through The First Tool Call](#journey-first-time-setup-through-the-first-tool-call)): your agent connects to the Vex bridge, sends `initialize`, then `notifications/initialized`, then `tools/list`, and sees the tool catalog - the two discovery tools `vex_ToolSearch` and `vex_ToolDescribe` plus the protocol tools, including reads such as `dexscreener__pairs_search` and `dexscreener__candles_list` (`vex-app/e2e/studio-mcp-live.spec.ts:369-399`). It then calls one of those read-only tools with `tools/call`, and the result comes straight back (`vex-app/e2e/studio-mcp-live.spec.ts:410-446`).

Nothing in this exchange touches the approval broker. The project's own instructions to the agent say so directly: "Reads, quotes, Prepare tools and local writes raise no card." (`src/vex-agent/studio/instructions/project-brief.ts:313`). That line holds regardless of whether the project is set to restricted or full access, because the approval card exists for destructive calls, and a read, a quote, a Prepare-stage tool, or a local file write is not one.

There is no dedicated end-to-end test that walks this exact scenario start to finish under this journey's own name. The wire proof that a read-only tool call works end to end is the same layer-1 evidence produced by the first-setup journey's real MCP client session, not a separate spec written for this path (see [Journey: First-Time Setup Through The First Tool Call](#journey-first-time-setup-through-the-first-tool-call)).

### Journey: A Swap Decided On The Approval Card

You created this project with the default permission, `restricted`
(`vex-app/src/renderer/features/appShell/studio/projects/ProjectCreator.tsx:130`,
one of the two levels the shared schema allows,
`vex-app/src/shared/schemas/sessions.ts:47-48`), so the agent working inside it
was told plainly: every Execute, Confirm, deposit, withdraw, borrow, repay, claim
and launch call, and any other user-wallet broadcast or irreversible effect,
blocks until you answer an approval card (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)). That instruction is
not a suggestion baked into a prompt once and forgotten; it comes from the
project's own `.vex/protocols.md` destructive column, read on demand
(`src/vex-agent/studio/instructions/project-brief.ts:294-317`).

When the agent tries to call a mutating tool such as `wallet.transfer`, the call
does not go through. It is refused with `pendingApproval`, an intent is
enqueued, and the underlying MCP call blocks in place - the agent does not get an
answer back until you decide (`vex-app/src/main/studio/approval-broker.ts:1-9`).
Studio bounds how many of these can pile up at once: 32 waiters
(`vex-app/src/main/studio/approval-broker.ts:81`), reserved before the intent is
even enqueued, so a call that gets refused for being over the cap is never one
that a human could still approve behind the agent's back
(`vex-app/src/main/studio/approval-broker.ts:20-33`).

You do not have to be watching the terminal to see this. The global approvals
badge shows `AWAITING 1` with `aria-label="1 pending approval awaiting your
signature"` and `aria-expanded="false"`
(`vex-app/e2e/studio-approvals.spec.ts:186-193`). This badge is pinned to be
hit-testable at its own screen centre, not merely present in the DOM - a live
pass once found the same badge sitting on screen while a click through it
landed on nothing, so the walk that proves this section now checks the actual
pixel under the badge's centre before it is ever clicked
(`vex-app/e2e/studio-approvals.spec.ts:1-45`).

Clicking it opens the approvals panel, and the card names the project the call
came from (`vex-app/e2e/studio-approvals.spec.ts:212-221`); the panel moves
keyboard focus onto the safer action, Reject, when it opens
(`vex-app/e2e/studio-approvals.spec.ts:231`). Because a wallet broadcast at high
risk is high-risk by both the tool's own classification and the card's risk
rules, one click is never enough: the first click arms the button with the text
"Click again to confirm reject", and only the second click commits the decision
(`vex-app/e2e/studio-approvals.spec.ts:249-255`).

That second click is not the end of the story either. The decision has to land
durably before the badge count moves: the row settles to `decision: "rejected"`,
`queueStatus: "rejected"`, a non-null `resolvedAt`, and
`executionStatus: "not_started"`, because a rejected call never dispatched in
the first place (`vex-app/e2e/studio-approvals.spec.ts:268-274`). Only once
nothing is pending does the badge disappear from the strip
(`vex-app/e2e/studio-approvals.spec.ts:281-282`). Had you approved instead, the
settlement bridge reads the same committed row and hands it to the still-blocked
MCP call, which is what finally lets the agent see a result
(`vex-app/src/main/studio/approval-broker.ts:11-18`).

### Journey: A Full-Autonomy Session

You open a project whose permission is set to `"full"` in Vex's project settings, not the
default. Nothing in the agent's tool surface changed to get here; only the stored permission
did (`sessionPermissionSchema = z.enum(["restricted", "full"])`,
`vex-app/src/shared/schemas/sessions.ts:47-48`).

The brief the agent receives states the difference in the owner's own words: "Permission: FULL
ACCESS. The user chose full access knowingly, in Vex's project settings. Do not ask the user for
permission before a transaction and do not add a confirmation step of your own: the user's
standing permission is the authority, and a destructive call executes directly with no approval
card" (`src/vex-agent/studio/instructions/project-brief.ts:296-300`). The agent is told explicitly
not to treat this as its own judgment call or as something it escalated into: it is a choice you
already made, in the settings UI, before this session started.

The mechanical difference from a restricted session (see [Journey: A Swap Decided On The Approval Card](#journey-a-swap-decided-on-the-approval-card)) is confined
to the approval-gate step. In a restricted project, a destructive call (an Execute, Confirm,
deposit, withdraw, borrow, repay, claim, or launch tool) is refused with `pendingApproval`, an
intent is enqueued, and the MCP call blocks until you answer a card. In a full-access project the
same call dispatches directly, with no card and no wait.

Everything else is unchanged, by design: the same per-call scope snapshot and the same
vault-locked signing still apply (`src/vex-agent/studio/instructions/project-brief.ts:302-303`).
The scope snapshot is loaded fresh for every call, including `vex_ToolSearch`
(`vex-app/src/main/studio/approval-service.ts:176-182`), and the signing key is decrypted
immediately before the signature, with no provider call in between
(`src/vex-agent/tools/internal/wallet/transaction/confirm-evm.ts:365-366`). Full access removes
only the human-in-the-loop gate, not the scope or signing checks underneath it.

The one obligation that holds at both permission levels is unchanged too: the agent must run the
quote first and restate its amounts, fees, price impact, and ETA in the message it writes before
the execute call, then report the outcome; an unknown outcome is never retried
(`src/vex-agent/studio/instructions/project-brief.ts:328-331`). Only you can change the permission
level, and only from the project settings; no tool call can widen it
(`src/vex-agent/studio/instructions/project-brief.ts:331-333`).

### Journey: A Token Launch With A Project Image

You are working through your Studio-connected agent, and you want it to launch a token on pools.fun using an image already sitting in your project folder. Studio never accepts a URL for this picture, on any surface: a URL could point at different bytes tomorrow than the ones you approve today, so Vex always re-publishes the actual bytes itself to a content-addressed host, and the on-chain URL becomes the hash of the bytes you approved (`src/vex-agent/tools/protocols/shared/launch-image-input.ts:23-29`). On the Studio MCP surface the picture is named by `imagePath`, a path inside the project root; passing `imageId` here, the in-app form's parameter, is refused by name with a remedy sentence pointing at the correct one, never silently dropped (`launch-image-input.ts:44-47,111-127`).

**Publish first.** Your agent calls `launchpads__image_publish` with the `imagePath`. The tool reads the file through a no-follow reader that stays inside the project root, accepts PNG, JPEG, WebP or GIF up to the configured byte cap, and refuses a symlink, an escaped path, or an oversized file by name rather than guessing (`launch-image-input.ts:219-278,287-319`; accepted formats: `src/vex-agent/studio/files/no-follow-open.ts:73`). It uploads the bytes to a content-addressed host and records a durable row keyed by the content id (`src/vex-agent/tools/protocols/launchpads/handlers/image-publish.ts:305,336-339,367-383`); asking again with the same bytes returns `alreadyPublished: true` and uploads nothing (`image-publish.ts:316-330`). This tool signs nothing and spends no gas, but it still shows you an ordinary approval card, because it makes your bytes public with no authentication until you withdraw them (`image-publish.ts:5-11`): "These bytes are now public: anyone with the link can fetch this picture without signing in, and it stays hosted until it is withdrawn" (`image-publish.ts:106-108`).

**Then launch.** `pools__launch_execute` does not take the published URL you just approved. It re-resolves the same `imagePath` selection independently, through the same no-follow reader, before any wallet, authorization, or provider call exists, so a refusal here still costs nothing (`src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:160-172,300-301`). `requireImage: true` is set only on this executing leg, never on the preview or form-request tools (`execute.ts:135-138`). This traces to a real incident on 2026-08-19: a launch went out with no picture, and the token rendered permanently blank on its launchpad, with no way to add one afterward. The tool refuses an imageless launch outright rather than warn (`launch-image-input.ts:158-183`).

From here the launch proceeds into the verified plan, the fingerprint authorization, and the broadcast covered in the money-path detail (see [The pools.fun Launch: The Deepest Money Path](#the-pools-fun-launch-the-deepest-money-path)), gated the same way every restricted or mission session is gated (see [How A Mutating Call Becomes An Approval](#how-a-mutating-call-becomes-an-approval)).

### Journey: Lock, Quit, And A Windows Front Restart

You lock Vex mid-session while a coding agent still holds an open Vex Studio connection. The listener does not close: it keeps accepting sockets, but admission refuses every one of them before it reads a single byte of your project. The refusal is a typed `locked` handshake ack, not a dropped connection, and it always carries the same sentence: "Vex is locked, so it will not serve MCP calls. Nothing was executed and no funds moved. Unlock Vex and connect again." (`vex-app/src/main/studio/mcp-host/admission.ts:42-48`, refusal code `"locked"` at `vex-app/src/main/studio/mcp-host/handshake.ts:36`). In the app the host pill reads "Locked" and the card offers "Unlock Vex" as its one real way out: the locked state is the only branch the renderer gives a real button, with instruction left null (`vex-app/src/renderer/features/appShell/StudioHostStatusWord.tsx:173-186`; label text at `vex-app/src/renderer/features/appShell/studio/studio-copy.ts:41-43,197-213,227`).

Locking is not a flag flip. It advances an internal epoch synchronously, before any teardown starts, so a connection that was accepted a moment earlier under the old epoch cannot later be waved through by a stale continuation still finishing its await chain (`admission.ts:17-29,106-123`). That epoch is a `u32` and has a hard ceiling. Reaching it closes admission permanently for the rest of that process's life; restarting anything short of the whole app does not reopen it, and the app tells you so directly: "Close Vex and open it again. Unlocking will not reopen it." (`admission.ts:59-78,113-121,146-148`; `studio-copy.ts:83-85,175-178`).

When you quit, teardown runs in one fixed order: the Studio host stops first, then durable refusals are written, then the approval broker is disposed, then poison retry. A test reads the source files themselves to enforce that order, because a duplicate teardown path could let the approval broker tell a waiter "refused" before the durable write actually landed (`vex-app/src/main/studio/__tests__/quit-ownership.test.ts:4-70`).

On Windows, the pipe-front that carries the Studio protocol runs as a separate child process. If it crashes, main restarts it up to six times, and that counter never resets on a successful start, unlike an ordinary retry policy (`vex-app/src/main/studio/mcp-host/front-supervisor.ts:7-11`). Past six, you see "Close Vex and open it again." (`studio-copy.ts:80-82,171-174`). The front restart budget is Windows-specific, since the pipe-front child process only exists on that platform, but the epoch ceiling above is not: `closeStudioAdmission()` runs unconditionally on every lock and every quit regardless of platform, and `STUDIO_ADMISSION_EPOCH_MAX` is one global constant with no platform branch, checked by every connection on every transport (`vex-app/src/main/studio/mcp-host/admission.ts:78-89`; `vex-app/src/main/studio/mcp-host.ts:437-455,470-471`). Only the numeric type of the ceiling, a `u32`, is shaped by the Windows wire protocol; reaching it and getting `admission_permanently_closed` can happen on any platform. What is true on every platform is that a restarted front gets a new generation but keeps the same epoch, because a transport restart is never an authority event (`front-supervisor.ts:32-39`).

### Journey: When Something Goes Wrong

Three things can go wrong on the Vex Studio path: Studio itself is not
serving calls, an approval you were meant to see never arrives, or the
bridge process an agent CLI launched cannot get in. Each has an honest,
named answer rather than a generic failure.

#### The status pill does not update because you asked, it updates because Vex told it to

The small status indicator in the app - "running", "locked", "starting", or
"unavailable" with a cause - is not something the renderer polls for. Main
computes the host's status once, caches it, and broadcasts the change, so
what you see can never disagree with what main last decided
(`vex-app/src/main/studio/host-status.ts:11-18`). Bursty transitions, such as
sixteen bridge connections reconnecting after you unlock Vex, collapse: an
identical consecutive payload is dropped rather than re-broadcast
(`vex-app/src/main/studio/host-status.ts:19-24`).

When the state is `unavailable`, a `cause` always comes with it, and every
possible cause has exactly one sentence explaining what could not happen and
why, reconciled against the underlying schema by a test so a new cause
cannot ship without someone writing its sentence
(`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:53-179`,
`vex-app/src/shared/schemas/studio.ts:51-119`). Three causes - Vex still
starting up, Vex shutting down, and the approval fence not yet initialized -
carry no next step, because they self-resolve on their own. Every other
cause pairs its sentence with a concrete next step: a Check-again button, an
instruction to install an agent executor, or - for the Windows-specific
causes (the connection helper, its pipe security confirmation, its
restart budget, and its admission fence) - an instruction to close and
reopen Vex, or reinstall it.
The full table of causes, sentences, and next steps is in
(see [Studio Host Status And What Each State Means](#studio-host-status-and-what-each-state-means)). The card never names a path, endpoint, or
provider payload; that detail stays in main's log only
(`vex-app/src/shared/schemas/studio.ts:12-24`).

#### An approval that never arrives does not leave the call hanging forever

If an agent asks for something that needs your approval and you never
answer it, the wait ends on its own. Each waiter arms its own timer at the
approval's expiry and, when it fires, routes through the same rejection path
a real "no" would take, settling the request with no message and no
continuation - the fast path. Underneath that, a scheduled sweep runs every
five minutes and catches anything the fast path missed, such as the broker's
own process crashing mid-wait
(`vex-app/src/main/studio/approval-broker.ts:60-66`). The expiry itself is
one hour (`APPROVAL_TTL_MS = 60 * 60 * 1000`,
`src/vex-agent/engine/core/approval-runtime/enqueue.ts:118`), and the agent
is told this up front, in the same words it would use to reason about the
wait: "up to 60 minutes"
(`src/vex-agent/studio/instructions/project-brief.ts:91,318`).

#### When the bridge itself cannot get in

The small Go process an agent CLI spawns to talk to Vex Studio can be
refused for exactly five reasons, and only five: the project is unknown, the
protocol version does not match (the refusal names the version Vex Studio
actually speaks, not just "closed"), Vex is locked, the connection limit is
full, or the handshake itself was malformed
(`vex-app/src/main/studio/mcp-host/handshake.ts:21-41`). The full exit-code
triage for what an agent CLI sees on each of these, plus the Windows-only
local-refusal cases, is in (see [Bridge Exit Code Triage](#bridge-exit-code-triage)).

That bridge binary is never found by searching your system's `PATH`. Vex
Studio looks in exactly two fixed, packaging-decided locations and nowhere
else, because a config that just said "vex-mcp" would let any binary with
that name on your `PATH` be launched with your project's authority instead
(`vex-app/src/main/studio/installer/bridge-path.ts:14-33`). If the binary is
missing from both locations, that is reported as its own honest outcome,
not a config silently pointing at nothing
(`vex-app/src/main/studio/installer/bridge-path.ts:30-32`).


## Part 12 - Troubleshooting

### Studio Host Status And What Each State Means

Vex Studio's status pill and its expanded card both come from one wire object, `StudioHostStatus`: a state, a cause (present only when the state needs one), a connection count, the connection limit, and whether the host is at capacity (`vex-app/src/shared/schemas/studio.ts:153-182`). The object never carries the local endpoint (no unix socket path, no Windows pipe name) and never carries a sentence: the schema enforces the no-endpoint omission with `.strict()` rejecting an `endpoint` key, and the no-sentence omission by typing `cause` as a closed set of codes rather than free text, so the human-readable reason is composed on the renderer side from a code alone (`vex-app/src/shared/schemas/studio.ts:12-24`). If Studio is failing to start because it could not bind its socket at a particular path, that path stays in main's own log; you see only the cause code translated into plain language.

#### The four top-level states

The state field is one of four values (`vex-app/src/shared/schemas/studio.ts:138-144`):

- `running` - the listener is bound and would serve a connecting agent. The pill reads "Running N connected", or "Running at capacity" once every slot is taken (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:31-44`).
- `locked` - Vex itself is locked. The listener stays bound, but every connection attempt gets a typed refusal rather than being admitted; nothing is served.
- `starting` - a bind attempt is in flight and has not yet reached the point where Studio can publish a listener.
- `unavailable` - not serving, and the `cause` field says why. This is the state the table below is about.

#### Every unavailable cause, its sentence, and its next step

When `state` is `unavailable`, `cause` is always one of nine values, and each one has an exhaustive one-sentence explanation and a next step - a button when the renderer genuinely holds the authority to act, or an instruction when it does not. Both tables are reconciled against the cause schema by a table test, so a cause added to the schema cannot compile without someone also deciding what the user is told and asked to do (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:53-183`).

| cause | sentence you see | next step |
|---|---|---|
| `starting` | "Vex Studio is still starting up." | None. Self-resolves; the card updates on its own. |
| `fence_uninitialized` | "Vex Studio cannot accept approvals yet, so it is not serving calls." | None. Self-resolves. |
| `shutting_down` | "Vex is shutting down, so Studio has stopped serving calls." | None. Self-resolves. |
| `not_configured` | "No agent executor is installed, so Vex Studio has nothing to serve." | "Install an agent executor, then check again." Card shows a Check-again button. |
| `endpoint_unavailable` | "Vex Studio could not open its local endpoint on this machine." | Card shows a Check-again button; no written instruction. |
| `front_unavailable` (Windows) | "Vex Studio could not start the helper it needs for its Windows connection." | "Reinstall Vex, or rebuild it if you are running from source." No button. |
| `pipe_security_unconfirmed` (Windows) | "Windows did not confirm that Vex Studio's connection is protected, so Vex did not open it." | "Close Vex and open it again. Reinstall Vex if this keeps happening." No button. |
| `front_restart_budget_exhausted` (Windows) | "Vex Studio's Windows connection helper stopped too many times, so Vex stopped restarting it." | "Close Vex and open it again." No button. |
| `admission_permanently_closed` | "Vex Studio can no longer confirm that locking is safe, so it has stopped serving calls for this session." | "Close Vex and open it again. Unlocking will not reopen it." No button. |

The three self-resolving causes (`starting`, `fence_uninitialized`, `shutting_down`) deliberately carry no action at all: the state changes on its own within seconds and the card is updated as soon as it does, so telling you to do something about a condition that is already ending would be misleading (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:143-149`).

The remaining six causes split by what the renderer can honestly do. `not_configured` and `endpoint_unavailable` get a real Check-again button, because re-reading host status through the same query the pill uses is something the renderer genuinely does. Every other cause gets an instruction instead of a button, because Vex has no restart or repair channel from the renderer to main: there is no IPC method that reinstalls the app, rebuilds a bridge binary, or restarts the process, so a button that claimed to do that would be dishonest about what it can perform (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:124-135`). "Close Vex and open it again" is a plain instruction to restart the whole application, not a button Vex presses for you.

#### Reading the table correctly

Three of the nine causes are Windows-specific by construction: `front_unavailable`, `pipe_security_unconfirmed`, and `front_restart_budget_exhausted` all describe the Windows named-pipe helper process (`vex-pipe-front`), which does not exist on macOS or Linux builds. `pipe_security_unconfirmed` is the fail-closed half of the Windows transport: Vex requires Windows to confirm, not merely request, that the pipe rejects remote clients, accepts only its first instance, and runs in message mode, and refuses to publish the listener if that confirmation does not come back matching. This is reported as a security refusal rather than folded into the generic `endpoint_unavailable` cause, because the remedy and the meaning are different from an ordinary bind failure (`vex-app/src/shared/schemas/studio.ts:86-99`).

`admission_permanently_closed` is its own cause rather than being reported as `locked` for a specific reason: an unlock action cannot clear it. The safety fence that makes locking and unlocking meaningful has run out for the life of the running process, so Studio keeps the door shut regardless of what you do in the unlock screen; only a full restart of Vex resets it (`vex-app/src/shared/schemas/studio.ts:109-118`).

The connection numbers on the pill (how many peers are connected, and the fixed maximum of 16) count only fully handshaken connections; a socket that has connected but not yet completed its handshake holds no slot and is not counted, so the number you see does not flicker on every incoming attempt (`vex-app/src/shared/schemas/studio.ts:158-166`).

(see [The State Machines At A Glance](#the-state-machines-at-a-glance)) for how the readiness barrier and the approval fence that produce `starting` and `fence_uninitialized` are built, and (see [Windows: Why A Separate Process, And How It Proves Itself](#windows-why-a-separate-process-and-how-it-proves-itself)) for the Windows pipe-front process behind the three Windows-only causes above (the confirmation mechanics for `pipe_security_unconfirmed` are covered in that same section).

### Bridge Exit Code Triage

`vex-mcp` is the small Go binary an MCP client (Claude Code, Codex CLI, Cursor, or another
MCP-speaking tool) spawns as a stdio server; it derives the Studio endpoint, dials it, handshakes,
and relays bytes until the session ends or something goes wrong (`bridge/cmd/vex-mcp/main.go:1-18`).
If the client only shows "the MCP server exited", the exit code is the only signal available, so
the codes are a closed, numbered set rather than free-form text
(`bridge/cmd/vex-mcp/main.go:40-53`). `vex-mcp` never retries a failed attempt on its own
(`bridge/cmd/vex-mcp/main.go:10-17`); reconnecting means re-running the command the MCP client
already has configured.

#### The 13 exit codes

| code | name | what it means | what to do |
| --- | --- | --- | --- |
| 0 | `exitOK` | clean exit: help was printed, or the relay ended cleanly | nothing to fix |
| 1 | `exitUsage` | bad flags/arguments, or no project id was given (`--project`/`VEX_PROJECT_ID`) | pass a valid project id; Vex's own copy of the MCP command has it filled in |
| 2 | `exitEndpointRefused` | local refusal to dial: override path too long/malformed, a directory ancestor changed or vanished, or (Windows) the pipe belongs to another user | see the message; it names which reason fired |
| 3 | `exitDialFailed` | OS-level dial failure: nothing listening, connection refused, permission error, timeout, or (Windows) pipe stayed busy past its wait budget | start Vex, or check the client and Vex use the same config directory |
| 4 | `exitHandshakeFailed` | the handshake bytes could not be sent, or the reply could not be parsed | usually transient; retry |
| 5 | `exitUnknownProject` | the host does not recognize this project id | open Vex, select the right project, copy its MCP command again |
| 6 | `exitIncompatibleVersion` | the running Vex speaks a different handshake major version than this bridge | update the bridge binary or Vex, whichever is behind |
| 7 | `exitLocked` | the host has this project locked (another session owns it) | close the other session, or wait |
| 8 | `exitAtCapacity` | the host's connection cap or handshake-pending cap is full | close an idle MCP connection and retry |
| 9 | `exitMalformed` | the host rejected the handshake as malformed | treat like code 6, a version skew |
| 10 | `exitRefusedUnknownCode` | the host's ack carried a refusal code this bridge build does not recognize | update the bridge |
| 11 | `exitRelayFailed` | stdout or the socket/pipe failed mid-session | reconnect; the session is not recoverable |
| 12 | `exitSignal` | the process was stopped by SIGINT, SIGTERM, or SIGHUP | expected on ctrl-c or the client tearing the process down |

Codes 5 through 9 come from a closed set of five refusal codes the host sends back over the wire in
its handshake ack (`unknown_project`, `incompatible_version`, `locked`, `at_capacity`,
`malformed`); code 10 exists so a future host build can add a sixth refusal reason without an
older bridge crashing or misreporting it (`bridge/cmd/vex-mcp/main.go:346-365`). Codes 1 through 3
are decided entirely by the bridge before any bytes reach the host: a usage problem (1), a local
decision not to dial at all (2), or a dial that reached the OS and failed there (3). Code 2 means
the problem is on the machine running the bridge (a bad override, a moved directory, or, on
Windows, another process holding the pipe name); code 3 means the bridge tried to reach Vex and
the attempt itself failed.

The evidence base does not pin a numbered constant naming a plain permission-denied dial failure
as its own code; on Unix an `EACCES`/`EPERM` dial error is folded into `exitDialFailed` (3) with
its own sentence rather than a separate code (`bridge/cmd/vex-mcp/main.go:300-338`).

#### Windows-specific local refusals

Two refusal reasons only exist on Windows, because only Windows uses a named pipe with per-process
ownership instead of a Unix-domain socket:

- **Foreign-owned pipe** (`windows_host_not_current_user`, exit code 2): the process currently
  serving the pipe does not run as the signed-in user, so it cannot be this user's Vex. The
  message reports the foreign process's pid but deliberately never discloses its identity beyond
  that, and the bridge sends nothing to it before stopping
  (`bridge/cmd/vex-mcp/hostauth_windows.go:105-131`). Fix: close whatever else holds that pipe
  name, or sign in as the account actually running Vex.
- **Every pipe instance busy past the fixed wait budget** (`windows_pipe_busy_timeout`, exit code
  3): Windows named pipes serve multiple instances, and a client dial can hit `ERROR_PIPE_BUSY`
  when all are taken. `vex-mcp` retries the dial every 10ms until a fixed 4-second budget elapses
  (`bridge/cmd/vex-mcp/dial_windows.go:53,227-259`) - twice the 2-second Unix dial timeout, because
  the pipe's server is a child process re-posting instances rather than a kernel backlog queue.
  Past that budget the bridge gives up and reports how many attempts it made; fix: close another
  Vex Studio MCP connection, or restart Vex, then reconnect (`bridge/cmd/vex-mcp/dial_windows.go:272-287`).

Both are decided by the bridge itself before the handshake starts; on Windows a local refusal
(host-auth mismatch) exits with code 2, not code 3, even though it happens near the same point in
the flow as a dial failure (`bridge/cmd/vex-mcp/main.go:132-146`).

Every stderr line the bridge prints is a single line, prefixed `vex-mcp: `, bounded at 512 bytes
total; a message from the host that would not fit is never silently cut - it names the omitted
byte count instead (`bridge/internal/handshake/handshake.go:29-95,255-300`).

### Common Problems And Their Real Causes

This section covers the problems users hit most often, and what is actually happening on your machine when you hit them. In every case Vex names the real cause rather than showing a generic error, and none of these situations moves funds or executes an action on their own.

#### "My coding agent can't find Vex at all"

Your agent talks to Vex through a small bridge process, not directly. When it cannot reach Vex, one of three things happened:

- The project's MCP config points at a project id that no longer exists, because the project was deleted or the config came from a different Vex installation. Vex reports: "That Vex project does not exist. It was deleted, or the bridge was configured with a project id from another Vex installation. Open Vex and re-add the MCP server for a project that exists." (`vex-app/src/main/studio/mcp-host/handshake.ts:155-165`)
- The bridge binary itself is missing from this installation. Vex never looks up the bridge by name on your system `PATH` - it only ever spawns the exact binary from its own installation, because a name-based lookup would let any program with that name on your machine run with your project's authority (`vex-app/src/main/studio/installer/bridge-path.ts:25-32`). On a packaged install a missing binary means the install is damaged; on a source checkout it usually means the Go bridge has not been built yet. Vex tells you exactly this rather than writing a config that points at nothing: "The Vex Studio bridge binary is missing from this installation, so no coding-agent config was written. Reinstall Vex, or build the bridge if you are running from source." (`vex-app/src/main/studio/installer/bridge-path.ts:126-128`) The same message is what you see if a terminal or agent reports the bridge command as not found - it is not a separate problem.
- The bridge process itself ran and dialed, but found nothing listening at the endpoint it derived - either because Vex is not running, or because a Vex that is running was started for a different configuration directory than the one the bridge resolved. The bridge names this directly: "no Vex Studio host is listening at [endpoint]: the endpoint does not exist. Vex is not running, or it is running for a different configuration directory. Start Vex and connect again." (`bridge/cmd/vex-mcp/main.go:323-325`). A related but distinct case is a host that IS reachable and answers the dial, but whose resolved configuration-directory identity does not match what the bridge expects; the bridge refuses the connection rather than trust an endpoint under a different identity (`bridge/cmd/vex-mcp/main.go:141-145`).

If Vex itself is locked or still starting when your agent connects, the bridge reports that too instead of a bare connection failure.

#### "My approval never resolved"

Every approval request carries an expiry, one hour from when it was created (`APPROVAL_TTL_MS = 60 * 60 * 1000`, `src/vex-agent/engine/core/approval-runtime/enqueue.ts:118`). If nobody answers it in that window, it does not hang forever: a timer tied to that specific request expires it, and a background sweep that runs every five minutes is the backstop for the case where Vex closed or crashed before the timer could fire (`vex-app/src/main/studio/approval-broker.ts:60-66`). An expired approval is a normal outcome, not a bug: your agent sees no result and no continuation, because the action was never approved to begin with. If you needed that action to happen, ask your agent to propose it again.

#### "My project's config files won't reconcile / Repair keeps refusing"

Vex only ever rewrites the exact bytes it wrote itself. It proves this by checking a stored fingerprint of what it last wrote against what is on disk before touching anything (`vex-app/src/main/studio/installer/reconcile.ts:12-14`). If you hand-edited a file Vex manages - even just reformatting it - the fingerprint no longer matches, and Vex refuses to touch it rather than silently overwriting your edit or silently leaving stale content behind. This shows up as a `provenance_collision` refusal (`vex-app/src/main/studio/installer/reconcile.ts:626-639`).

Running Repair from the project view does not force an overwrite of anything. It can only replace an entry that Vex itself previously proved it wrote; if the collision is a section you hand-edited, or a foreign entry Vex never wrote, Repair leaves it alone and reports why, so you can decide what to do with it yourself. Nothing at a Vex-managed path is ever taken over without that proof, and nothing outside Vex's own managed sections is ever deleted.

#### "Windows says the connection isn't protected"

On Windows, Vex spawns a small helper process (the pipe front) to carry the connection to your coding agent, and it only opens that connection once Windows itself confirms - by reading the security settings back from the operating system, not by trusting what Vex asked for - that the connection rejects remote and duplicate-instance access. If that confirmation does not come back matching, Vex refuses to open the connection at all rather than opening one it cannot vouch for. You will see: "Windows did not confirm that Vex Studio's connection is protected, so Vex did not open it." (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:77-79`)

The remedy is the one Vex gives you: close Vex and open it again, and reinstall Vex if it keeps happening (`vex-app/src/renderer/features/appShell/studio/studio-copy.ts:166-169`). This is a fail-closed check working as intended, not a broken feature - Vex would rather refuse the connection than open one it cannot confirm is safe.

#### Quick reference

| Symptom | Real cause | What to do |
|---|---|---|
| Agent or terminal cannot find/reach Vex, or the bridge command is not found | Unknown project id, bridge binary missing (packaged install) or unbuilt (source checkout), or no Vex host listening at the derived endpoint (not running, or running for a different config directory) | Re-add the MCP server for a real project, reinstall Vex / build the Go bridge, or start Vex and connect again |
| Approval request disappears after a while | One-hour expiry reached with nobody answering | Ask your agent to propose the action again |
| Repair refuses a file | You hand-edited a Vex-managed file, or it is a foreign entry | Decide by hand, or let Repair replace only the part Vex proved it wrote |
| Windows connection refused as "not protected" | OS did not confirm the security settings on the pipe | Close and reopen Vex; reinstall if it recurs |

### Accessibility Notes For The Workspace UI

No dedicated accessibility audit of the Studio workspace exists in the evidence base for this document. What follows is a collection of the accessibility-relevant properties that individual subsystem maps happened to record while documenting other behavior (the runtime-mode toggle, the approval card, the keybinding dispatcher, the file viewer). It is not a completeness claim, and the absence of a note on any other control is not evidence that the control is accessible.

#### Properties recorded by subsystem

| Surface | Property | Citation |
|---|---|---|
| Runtime-mode toggle | Real `role="radiogroup"` of `role="radio"` buttons, roving `tabIndex` (`0` on the checked segment, `-1` on the rest), arrow-key navigation moves both DOM focus and the checked state | `vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:68,81,83` |
| Approval card | The card's Reject button carries the app's shared `DIALOG_INITIAL_FOCUS` marker, so a freshly mounted card places initial focus on the least destructive action rather than Approve | `vex-app/src/renderer/features/appShell/ApprovalCard/ApprovalDecisionActions.tsx:90,94` |
| Studio keybindings | A modal dialog suspends every Studio shortcut binding entirely; the keystroke is left alone rather than swallowed, so the dialog's own handlers still receive it | `vex-app/src/renderer/features/appShell/studio/keybindings.ts:66` |
| File viewer code area | `FileViewerLines` renders a `role="region"` labeled by `CODE_REGION_LABEL`, is keyboard-focusable (`tabIndex={0}`), and its sticky line-number gutter is `aria-hidden` so a screen reader does not announce line numbers as content | `vex-app/src/renderer/features/appShell/studio/viewer/FileViewerLines.tsx:102-104,146` |

#### What these four have in common

Each is a case where the workspace deliberately avoided a styled-div-pretending-to-be-a-control pattern: a segmented toggle built as real ARIA radios rather than clickable spans, a destructive confirmation defaulting away from the destructive action, a global shortcut layer that steps aside instead of double-handling a keypress meant for a dialog, and a virtualized code view exposing itself as one focusable region with decorative chrome marked as such. None of these four facts imply the same care was applied elsewhere in the workspace (the terminal panes, the explorer tree, the project dialogs, the search combobox); those surfaces were not the subject of an accessibility-specific pass and this note makes no claim about them either way.

For the dialog-focus default on the approval card specifically, (see [The Approval Card And The Global Approvals Panel](#the-approval-card-and-the-global-approvals-panel)). The same `DIALOG_INITIAL_FOCUS` marker is also used by other Studio dialogs, though this note has not audited whether each one places it on the least destructive action: `vex-app/src/renderer/features/appShell/studio/StudioKeepAliveDialog.tsx:167`, `vex-app/src/renderer/features/appShell/studio/projects/ProjectCreator.tsx:301`, `vex-app/src/renderer/features/appShell/studio/projects/ProjectDeleteDialog.tsx:600`, `vex-app/src/renderer/features/appShell/studio/explorer/ExplorerDeleteDialog.tsx:208`, `vex-app/src/renderer/features/appShell/studio/projects/ProjectRepairDialog.tsx:192`.


## Part 13 - Appendices

### Citation Corrections

This ledger lists every line-number correction the critic pass found against the 19 evidence maps. A downstream writer citing a fact below uses the corrected line, not the number an individual source map originally guessed [see the style sheet's citation-format rule].

#### Off-by-line citations

| Fact | Wrong citation | Correct citation | Notes |
|---|---|---|---|
| `STUDIO_WAITER_CAP = 32` | `vex-app/src/main/studio/approval-broker.ts:75` | `vex-app/src/main/studio/approval-broker.ts:81` | user-journeys.md cited the wrong line in two places (a Journey step and its Limits-and-bounds table); `approvals.md` and `sessions-logging.md` already cited line 81 correctly. |
| `WALLET_TX_FEE_BPS = 25` | `src/vex-agent/tools/internal/wallet/transaction/vex-fee.ts:66` | `src/vex-agent/tools/internal/wallet/transaction/vex-fee.ts:67` | money-from-studio.md cited vex-fee.ts:66 in its Flows-section walkthrough of the wallet.transaction lane (flow 1, step 2) while independently citing the correct vex-fee.ts:67 in its Configuration-and-environment section; config-reference.md does not cite this constant at all. |
| `STUDIO_WORKSPACE_KEEP_ALIVE_MAX = 4` | `vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:32` | `vex-app/src/renderer/features/appShell/studio/workspace/keep-alive.ts:36` | Cited by desktop-workspace.md. |
| `poolsLaunchExecuteHandler` entry point | `src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:88` | `src/vex-agent/tools/protocols/pools/handlers/launch/execute.ts:96` | poolsLaunchExecuteHandler's entry-point line drifted from execute.ts:88 to execute.ts:96 (critic.json); the current money-from-studio.md map no longer contains this citation, so its original location could not be independently re-confirmed in this pass. The correct line (96) is verified directly against the function signature in execute.ts. |

All four corrections were verified directly against the worktree in this pass, not carried forward from critic.json's own claim.

#### Superseded figure: the Windows pipe cap

`plans-decisions.md` states "Windows pipe cap: `maxConnections: 20`" as a bare fact, citing a design document (`vex-studio-plan-v2.md:352-354`) without flagging that this is a historical, superseded turn-2 figure. The current shipped bound is `STUDIO_MAX_CONNECTIONS = 16`, plus 4 handshake-pending slots plus 1 overflow slot, for 21 total listener sockets (`vex-app/src/main/studio/mcp-host/bounds.ts:14,17,32-33`). This 16+4+1=21 figure is confirmed identically, with exact line citations, by three independent maps: mcp-host.md, bridge.md, and user-journeys.md; landing-current.md separately confirms the three component bounds (16 established, 4 handshake-pending, 32 in-flight) but does not state the 21-total/overflow figure. A writer citing only plans-decisions.md's bounds table without its surrounding revision-log context would incorrectly report 20 as the current bound; a `.md` plan document under `tool-surface-spec/` is design history, not a current-state source, when it disagrees with shipped code.

### Stale Landing Claims To Fix

This section lists every landing-site claim (`agents-colab/vex-landing-final`) that the code in `launchpads/arc` (checked in `/home/kubas/Vex-worktrees/integrate-merge`) has moved past, as direct input for the landing rewrite. Ordered by how much a reader would be misled if the claim shipped unchanged.

#### Wrong, not merely stale

The `app/docs/studio/page.tsx` callout and `components/landing/StudioSection.tsx` lead copy both describe the in-app Studio workspace as a reserved seat: a disabled "Agent | Studio" toggle with a lock icon and a "coming soon" tooltip. The code contradicts this. A full renderer feature tree exists under `vex-app/src/renderer/features/appShell/studio/` (`terminal`, `sidebar`, `projects`, `workspace`, `explorer`, `welcome`, `viewer`), and the toggle component's own header states it has been "LIVE since stage B4a" as a real `role="radiogroup"` where choosing a segment dispatches the shell (`vex-app/src/renderer/features/appShell/RuntimeModeToggle.tsx:1-17`). This is not a numbers drift; the page's entire premise, that Studio-the-workspace is unshipped machinery, is out of date and needs a rewrite, not a patch.

The same page claims Windows is refused at runtime with a constant named `windows_pending_platform_proof` pending CI proof of the pipe's security descriptor. That identifier is not a live constant or refusal code the current build can emit; it survives only as a historical reference, in superseded planning markdown under `tool-surface-spec/studio-mcp/` and in a comment in `bridge/internal/endpoint/endpoint.go:129-133` explaining why the code retired when the gate opened. The Windows named-pipe transport is live: the front binds the pipe under its own protected descriptor, reads the applied flags back off the created handle, and the listener publishes an endpoint only when that readback confirms `rejectRemote`, `firstInstance`, and `messageMode` were all applied; anything short of that is refused as `pipe_security_unconfirmed`, a narrower per-bind runtime check rather than a blanket "Windows does not connect" (`vex-app/src/main/studio/mcp-host/listener.ts:286-298`).

#### Stale numbers

The exported-tool-count claim (167 = 27 internal + 140 protocol, repeated on `app/docs/studio/page.tsx`, `app/docs/studio/approvals/page.tsx`, `StudioSection.tsx`, and as the `lib/facts.ts` constants `protocolTools`/`studioExportedTools`) is stale, and so is every intermediate figure. The pinned inventory test currently asserts 213 exported tools total: 29 internal and 184 protocol (`src/__tests__/vex-agent/mcp/inventory.test.ts:144-149`). All three landing constants move: `studioInternalTools` 27 to 29, `protocolTools` 140 to 184, `studioExportedTools` 167 to 213.

Sources: `src/vex-agent/tools/tool-surface-spec/studio-mcp/exported-tools.md` Totals.

`lib/facts.ts`'s `perNamespace` table still lists a `trench` row (10 tools) and `protocolNames` still lists "Trench Express" as a protocol pill. The Trench Express protocol was fully retired in migration 108: the ten `trench__*` tools were deleted with the protocol and the namespace no longer appears in `PROTOCOL_NAMESPACE_ALLOWLIST`, which instead lists `launchpads` (`src/vex-agent/tools/protocols/catalog.ts:51-63`). `protocolIntegrations` stayed at 11 through that change (one member changed identity, the count did not), but the Lighter integration moves it to 12, and `protocolNames` gains "Lighter". The correct replacement numbers are measured: `pools` exports 13 tools, `lighter` exports all 40 of its manifests, and `launchpads` exports 1 of its 2 (`launchpads.image_publish`; the sibling `launchpads.images` / `launchpads__images_list` is the single withheld row across the whole 184-tool export). The counts come from loading `buildStudioInventory()` and grouping the protocol rows by `manifest.namespace`, cross-checked against the pinned 184-tool total across all 12 namespaces (dexscreener 18, khalani 9, kyberswap 4, launchpads 1, lighter 40, morpho 19, pendle 29, pools 13, relay 2, solana 34, uniswap 2, virtuals 13). The withholding predicate itself lives in `NON_EXPORTED_PROTOCOL_TOOLS`, a set containing only `"launchpads.images"` (`src/vex-agent/mcp/export-scope.ts:79-104`, the set at 102-104), and `isExportedProtocolTool` is documented as the one enumerator predicate that `tools/list`, `vex_ToolSearch`, and `admitStudioCall` all consult, so no surface can show or run what another withholds (`src/vex-agent/mcp/export-scope.ts:129-131`).

#### Missing content

`app/docs/studio/agents/page.tsx`'s installer table lists three instruction files Vex writes unconditionally: `AGENTS.md`, `CLAUDE.md`, `.vex/protocols.md`. A fourth file is also written unconditionally and is missing from the table: `.vex/vex-guide.md`. The install planner's own comment names all four together, because they describe the project rather than any one client (`vex-app/src/main/studio/installer/plan.ts:200-202`).

The Studio overview page (`app/docs/studio/page.tsx`) never mentions `vex_ToolDescribe`, the MCP-only whole-contract reader added because some clients truncate a tool's description; it only names `vex_ToolSearch`. This is not a wrong claim, it is an undeclared depth gap under rule 90: the page should name both exports (`src/vex-agent/mcp/admission.ts:45,180`).

#### Owed before publishing

Nothing remains owed on the per-namespace breakdown: the counted table above (measured, not guessed) is ready to drop into the rewritten landing table in place of the stale `trench` row.

### Open Questions Requiring A Product Or Security Decision

This section names questions this documentation pass found in the code but could not, and should
not, resolve on its own authority. Each changes user-facing safety, security posture, or the
accuracy of a written claim, so each is named here instead of being quietly decided by a
docs-mapping pass.

#### The terminal environment secret-exposure gap

A Studio terminal's shell environment is built in two stages: the pty host child forks with the
main process's `process.env` spread in full (`vex-app/src/main/studio/pty-host-starter.ts:548-557`),
then a `scrubEnvironment()` pass applies a four-pattern deny-list once, at host boot
(`vex-app/src/pty-host/process-env.ts:53-58`): `ELECTRON_.+`, `VEX_.+`, `SNAP(|_.*)`, `GDK_PIXBUF_.+`.
While the secret vault is unlocked, five provider and tool API keys sit resident on the main
process's own `process.env` for the whole unlocked session - `OPENROUTER_API_KEY`, `JUPITER_API_KEY`,
`TAVILY_API_KEY`, `RETTIWT_API_KEY`, `RELAY_API_KEY` (`VAULT_SECRET_KEYS`, `src/lib/secret-keys.ts:3-18`,
applied by `applySecretVaultToProcessEnv`, `src/lib/local-secret-vault/env.ts:7-18`). None start with
`VEX_`, so none match the deny-list, and no scrub or overlay-delete removes them before a shell
spawns. A command run inside any Studio terminal - by the user, or by an external agent's own shell
tool invoked through that terminal - that reads its own environment prints the live key for as long
as the vault stays unlocked. `VEX_KEYSTORE_PASSWORD` does not share this gap: it is deleted from
`process.env` immediately after use and is separately covered by the `VEX_.+` pattern.

The deny-list's own code comment states its principle as "removes what THIS process set" - in
tension with the current pattern list, since the five vault secrets are also things this process
set, just not `VEX_`-prefixed. Whether this is an accepted tradeoff under the local-first posture
(the user's own machine, keys already in their own vault) or an unreviewed gap that should join the
deny-list is an owner decision. **This must not be described as safe or fixed in any published copy
until that ruling happens.**

#### Whether an approved-but-undispatched action survives a scope edit: resolved, not open

Tracing this required opening the dispatch path itself: `runStudioDispatchGate`
(`src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.ts:98-217`) runs
one short transaction immediately before every Studio dispatch, under the same session-control lock
the scope-edit and delete transactions take first. It re-reads the project's live `scope_version`
under `FOR UPDATE` and compares it against `expectedScopeVersion`, bound to the version recorded
when the approval was enqueued, never a value re-read for comparison against itself
(`studio-gate.ts:191-215`; call site `src/vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio.ts:256-264`).
A mismatch settles the row `failed` with reason `scope_changed` through `commitStudioSettlementWith`
(`src/vex-agent/db/repos/approval-intents/studio-settlement.ts:317-347`) in the same transaction
that claimed the dispatch slot. The settings-dialog scope-edit transaction itself
(`vex-app/src/main/database/projects/scope.ts:172-178`) only refuses `decision IS NULL` rows and
genuinely does not touch an already-approved one - that gap is real at the edit transaction - but it
is closed one hop later, at dispatch. **There is no window in which an approved-but-undispatched
action dispatches under wallet or permission authority the user has since changed.** This corrects
the earlier framing of the question as unresolved; cite `studio-gate.ts:191-215`, not Flow 3 of the
project-lifecycle map alone.

#### Close-hook ordering across terminal, files, and name-index domains is not structurally guaranteed

A project delete's step 6 closes per-project resources through a registry: `closeHooks` is a plain
`Set<ProjectCloseHook>`, and `closeProjectResources` iterates it in insertion order, awaiting each
hook in turn (`vex-app/src/main/studio/project-lifecycle-gate.ts:522-544`). The module's own comment
asserts "the files close hook that bumps [the epoch fence] runs behind every other close hook"
(`project-lifecycle-gate.ts:126-129`), but nothing in `registerProjectCloseHook` enforces a priority -
order depends on which of the terminal domain, the files domain, and the project name-index
composition each register first, itself a function of which one a user action first lazily
instantiates. **Do not assert a fixed inter-hook order as a guarantee.** The comment's own
surrounding reasoning only needs the epoch fence to exist, not to fire before a specific sibling
hook, so this may not be a live bug - but the ordering claim as written is aspirational, not
enforced, and should be corrected or enforced before it is repeated as fact.

#### Owner-decisions.md is missing D20 through D25 on paper

`vex-studio-plan-v2.md` declares six decisions (O20-O25: the `tools/list` export model, the stdio
bridge, the pinned SDK version, the 2000-byte instructions lint, approval authority confined to the
privileged process, present-and-null `nextOffset`) as "closed by the owner (to be recorded as
D20+ in `owner-decisions.md`)" (`vex-studio-plan-v2.md:799`). Neither `owner-decisions.md` (D1-D19 only, no D20+;
`src/vex-agent/tools/tool-surface-spec/owner-decisions.md`) nor `OPEN-DECISIONS.md` (O20-O25 still
listed as live, unedited since 2026-08-22) reflects that closure, even though `OPEN-DECISIONS.md`'s
own "How to use this file" section says a ruled row moves to `owner-decisions.md` and is deleted
(`src/vex-agent/tools/OPEN-DECISIONS.md:47-49`). Every shipped behavior checked against these six decisions matches what the plan says was
decided - a paper-trail gap, not a code defect - but a reader who trusts the registers as written
will not learn these were ruled. Whether to back-fill `owner-decisions.md` with D20-D25 is a
maintenance decision for whoever owns that ledger, not one this document corrects on its own.

### Where The Regression Guards Live

This is a maintainer's index, not a walkthrough: for each subsystem this document covers, the file
that pins its contract, so a change that looks safe can be checked against the test that would
catch it breaking. Directories are relative to the worktree root. A file named without a directory
lives under `vex-app/src/main/studio/__tests__/` unless the sentence says otherwise.

#### MCP host and bridge

The unix/darwin control-plane suite runs in ordinary CI: `mcp-host-admission.test.ts`,
`mcp-host-bind.test.ts` (unix-only, and the ONLY runner that executes it for real is the darwin job
- it is `describe.skip` on win32, and the Linux job's kernel and uid behavior differ from half the
user base, `.github/workflows/ci.yml:613-616`), `mcp-host-endpoint.test.ts`,
`mcp-host-lifecycle.test.ts`, `mcp-host-serve-failure.test.ts`, `mcp-host-serve-peer-end.test.ts`,
`mcp-connection-lifecycle-log.test.ts`, `mcp-connection-refusal.test.ts`,
`mcp-bridge-conformance.test.ts`, `mcp-socket-contract.test.ts`, `mcp-wire-error-redaction.test.ts`,
`mcp-outbound-acceptance.test.ts`, `outbound-queue-blocked.test.ts`, `pipe-front-path.test.ts`,
`front-handshake.test.ts`, `front-relay.test.ts`, `front-supervisor.test.ts`, `front-wiring.test.ts`,
`front-real-binary.test.ts`, `bridge-readiness.test.ts`, `bridge-freshness.test.ts`,
`bridge-packaging-identity.test.ts`, `bridge-staging-and-packaging.test.ts`, `host-status.test.ts`,
`host-status-transitions.test.ts`, `readiness-epoch.test.ts`, and `quit-ownership.test.ts`.

The Go bridge binary carries its own suite, independent of the TypeScript side:
`bridge/internal/endpoint/endpoint_test.go`, `host_independence_test.go`, `identity_test.go`,
`bridge/internal/configdir/configdir_test.go`, `lexical_test.go`,
`bridge/internal/handshake/handshake_test.go`, `bridge/internal/relay/relay_test.go`, the
`vex-mcp` exit-code and env-scrub tests under `bridge/cmd/vex-mcp/`, and the Windows-only
`dial_windows_test.go`, `hostauth_windows_test.go`, `hostauth_foreign_windows_test.go`. CI job
`bridge-windows` (`.github/workflows/ci.yml:240` onward) is the required Windows transport gate: it
runs `go test -race`, then a scripted two-real-local-account measurement that is the empirical basis
for `WINDOWS_TRANSPORT_PROVEN`, and a mechanical check rejects any diff that flips that flag on one
side of the TS/Go boundary without the other (`vex-app/src/main/studio/mcp-host/endpoint.ts:258-264`).

The Windows data plane inside the pipe front has an independent codec pin on each language:
`bridge/internal/front/frames/frames_test.go` (978 lines) on the Go side and
`src/__tests__/vex-agent/mcp/pipe-front-frames.test.ts` (863 lines) on the TypeScript side, both
proving the same wire shape from opposite ends. `front-relay.test.ts` (594 lines) is the primary
suite for the TS-side multiplexer, driven end to end through a real `FrontSupervisor` and codec
against a `FakeFront` harness.

#### Tool surface

`inventory.test.ts` is the load-bearing suite: it asserts the exported tool inventory at exactly
213 entries (29 internal, 184 protocol), with a reviewed changelog comment tracking every count
change, most recently 171 to 213 for the Lighter integration
(`src/__tests__/vex-agent/mcp/inventory.test.ts:144-149`). It also pins ordering, the
ASCII-name gate, title uniqueness, annotation exhaustiveness, hot-set membership, and the
description-budget bounds. `export-scope.test.ts`, `tool-search-export.test.ts`,
`tool-describe-export.test.ts` and `fee-cap-two-call-workflow.test.ts` (all under
`src/__tests__/vex-agent/mcp/`) round out the suite: `export-scope.test.ts` checks the export
predicate against the live registry name by name, never by count, and both directions against the
exclusion list; `tool-search-export.test.ts` and `tool-describe-export.test.ts` contract-test
`vex_ToolSearch` and `vex_ToolDescribe`; `fee-cap-two-call-workflow.test.ts` covers the
quote-then-execute fee-cap workflow across the MCP surface.

#### Approvals and money

`approval-service.test.ts` and `approval-broker.test.ts` cover the approval lifecycle in main;
`studio/dispatch.test.ts` (under `src/__tests__/vex-agent/engine/core/approval-runtime/studio/`)
covers Studio's own dispatch path. `launch-verifier-v3-suite.test.ts` (692 lines,
`src/__tests__/pools-fun/`) is the pools.fun V3 launch-verification suite, alongside
`suite-detection.test.ts` (326 lines) and `on-chain-tri-state.test.ts`.
`pools-settlement-decoder.test.ts` (`src/__tests__/vex-agent/sync/`) grew across two recent fixes to the
settlement-emitter hint resolution. `fee-cap-two-call-workflow.test.ts` is listed under both tool
surface and money because it exercises the fee cap through the exported MCP contract.
`launch-authorize-simulate-guard.test.ts` (58 lines,
`src/__tests__/vex-agent/tools/protocols/pools/`) pins the refusal of a simulated plan at
authorization time.

#### Projects and installer

`project-delete-e2e.int.test.ts` (2,732 lines) is the authoritative pin on delete-teardown
ordering; it is a CI-gated integration suite requiring live Postgres (`studio-postgres` job,
`.github/workflows/ci.yml:65-89`). `installer-reconcile.test.ts` (707 lines) proves real renderers,
confinement, and ordering against a real temp directory, including a fault-injection case where a
write wrapper fails after the Nth write, showing per-artifact provenance survives a mid-run crash
and a second run completes the remainder without treating already-written files as collisions.
`projects-db-scope.test.ts` (`vex-app/src/main/database/__tests__/`) and the sibling
`installer-*.test.ts` files (confinement, rename-contention, queue, warnings, render-outcome,
change-log-agreement, all under `vex-app/src/main/studio/__tests__/`) round out the installer
suite; `installer-provenance-origin.int.test.ts` (`vex-app/src/main/database/__tests__/`) covers
the written-versus-adopted distinction at the database level.

#### Workspace

The Playwright suites under `vex-app/e2e/`: `studio-states.spec.ts` is the large Playwright
UX-audit walk, one named `test()` per numbered
section (consent grammar, terminal surface, welcome pill, keyboard table, preview tabs, explorer
mutations, highlight-budget reporting, and a full-restore-after-relaunch case).
`studio-project-journey.spec.ts` and `studio-approvals.spec.ts` are the other real-build Playwright
suites for project creation and the approvals badge. `studio-terminal-input.spec.ts` and
`studio-terminal-glass.spec.ts` cover terminal input reaching the shell and rendering throughput.
On the terminal host itself, `pty-host-starter.test.ts` (317 lines) pins the restart-cap
arithmetic (six restarts, no reset, no restart after quit) and the heartbeat ladder;
`terminal-domain.test.ts` (1,631 lines) covers admission, capacity, ownership, revive-partial, and
host-loss reconciliation. `highlighter-port.test.ts`
(`vex-app/src/renderer/features/appShell/studio/viewer/highlight/__tests__/`) is part of the
viewer's highlight-queue suite.

#### One confirmed gap

`front-planes.ts`'s own header comment claims parity with a named VS Code regression test
(`ptyHostService.test.ts`'s "listener counts should not grow across pty host restarts") for its
listener-leak-across-restart behavior (`vex-app/src/main/studio/mcp-host/front-planes.ts:16-26`),
and the same file separately documents a generation-adoption guard
(`vex-app/src/main/studio/mcp-host/front-planes.ts:27-36`) and `dispose()` idempotency
(`vex-app/src/main/studio/mcp-host/front-planes.ts:104,211`). No `front-planes.test.ts` exists
anywhere in the worktree; a repository-wide search for the name returns only the implementation
file itself. That behavior is exercised only indirectly, through `front-relay.test.ts`'s use of the
real `FrontSupervisor` and `FrontPlanes` plumbing. The claim of test parity with a named external
reference is real as a design intent; a dedicated regression test proving it is not.

### Keeping This Document Current

This document was built from 19 evidence maps, a completeness critic pass over those maps, and a
measured-counts probe that imported the real modules and counted them, all pinned against one
commit of the `launchpads/arc` worktree (verified 2026-09-07). It is a snapshot with citations, not
a live view: nothing in this repository re-reads the code automatically when Studio changes, and no
section should be trusted past the commit it was pinned against without that check being redone.

When Studio code changes materially, the owning part should be re-verified directly against current
code before the change is assumed reflected here, not carried forward by assumption. The citation
format is what makes that tractable: every technical claim carries a `path/to/file.ts:123` (or a
`start-end` range) at the end of the sentence it supports, so a maintainer checking one part after a
change reads the cited lines, confirms the claim still holds, and updates only that sentence and its
citation rather than re-deriving the whole document. A part with no citations covering the changed
code is itself a signal that the part needs a fresh reader, not that nothing needs updating.

#### Derived copies do not update themselves

Two other surfaces carry material derived from this document: the public landing site's Studio docs
pages and the in-app Studio help screen. Both are separate, hand-maintained copies, not renders of
this file. A future edit to a section here does not propagate to either surface automatically, and
the three can drift out of sync exactly the way the landing site's Studio docs pages already had
before this pass (stale tool counts, a removed error code still documented, a workspace status that
no longer matches shipped behavior). A writer updating one of the three copies should check whether
the other two now disagree with it, rather than assuming the update was self-contained.

#### Reference note

`agents-colab/deepseek-harness/docs/architecture.md`'s "Where new behavior goes" table (a goal-to-mechanism lookup for where new code should attach) was read as the pattern for this note; its two-column lookup-table shape is not reused here because this section's job is a maintenance contract, not a routing table, and forcing one onto it would add rows without adding information.
