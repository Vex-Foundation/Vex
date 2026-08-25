# Vex Studio - implementation plan v2 (Codex GREEN LIGHT for stage P, 2026-08-23)

Status: stages P and A2 built and approved by Codex (thread `harness-vex-studio`); A3 next; later stages return to review before their own arcs.
Scope: D14 step 4 (the Studio MCP server) plus the Studio workspace that
hosts it. Execution order is backend first (stages P and A), UI second
(stage B), live phase last (stage C, unchanged from D14 step 5).

## Revision log

v1 to v2 (2026-08-23), every Codex turn-1 blocker accepted with repo
evidence verified by the coordinator:

1. MCP admission seam added: `dispatchTool` admits a protocol public name
   only when it is in the session's ToolSearch working set
   (`dispatcher/protocol-route.ts:147`), so direct MCP calls need their own
   admission that resolves publicName to manifest and enters
   `executeProtocolTool`, keeping the in-app guard intact.
2. Inventory is never filtered by `requiresEnv`: `tools/list` is always
   155, MCP ToolSearch always covers 134; execution answers a typed
   `configuration_unavailable` result (export-scope O8 default, O20).
3. `trench.launch_execute` and `pools.launch_execute` get an MCP
   approval-surface override: over MCP they go through the Vex card
   (owner: "export them as tools"), since the in-app consent form does not
   exist on that surface (`protocols/runtime/gates.ts:198`).
4. Approval runtime gains a first-class `studio_mcp` continuation: durable
   origin, project-scope hydrator, exactly-once settlement broker,
   commit-time scope check. The existing resume rebuilds an agent-session
   context and cannot be reused as is
   (`approval-runtime/post-tx/dispatch-approved/resumed-tool-context.ts:41`).
5. Pending Studio intents have a defined terminal refusal on lock, EOF,
   MCP cancellation, timeout, project deletion and scope change, applied
   atomically before dispatch (`main/secrets/session.ts:239` only scrubs).
6. MRTR is removed from the first arcs. Blocking approval is the only arm
   in v1; MRTR returns as its own arc with a state diagram, a canonical
   action digest bound into the sealed state, a one-shot CAS lifecycle and
   real-client proof.
7. No `sessions.session_kind`. The backing session uses the existing
   `mode = 'agent'` and `scope = 'vex_studio'` (`001_initial.sql:231,239`);
   `projects` owns Studio semantics; the engine stays unaware of project
   persistence in stage P.
8. Wallet scope per project keeps the session shape (one EVM and one
   Solana selection with id plus address snapshot), editable through a
   monotonic `scope_version`. The v1 "allowlist" over-reached the owner's
   words ("like the session today").
9. Terminal ports are owned by preload; the renderer receives opaque
   terminal methods and events only. Main owns ids, cwd, shell, env, kill,
   cleanup.
10. Pty host restarts match VS Code 1:1: restart while
    `_restartCount <= 5` (`ptyHostService.ts:164`), i.e. up to six attempts.
11. Approvals push: `useGlobalApprovalsLiveSync` is mounted once by
    `GlobalApprovals` (AppShell status strip); `useMissionUpdateLiveSync`
    is session-scoped in `SessionPanel`. Studio mounts one mode-independent
    approvals push hook; nothing is mounted twice.
12. Stage P reshaped to Codex's smallest safe arc (compensating filesystem
    workflow, create/get/list/scope-update only, deletion and installer
    deferred, `src/config/store.ts` as the config owner for the root
    override).
13. B1 becomes a dependency-and-packaging PR (pty-host Vite entry,
    `asarUnpack`, pnpm `onlyBuiltDependencies`, native artifact checks,
    packaged signing and load smoke).
14. A1 additionally measures cancellation and progress-token behaviour
    (progress does not extend Claude Code's wall-clock tool timeout; the
    generated `timeout` does).
15. Server `instructions`: 2000-byte budget plus a self-contained
    512-character safety prefix (Codex bounds namespace descriptions).
16. Program docs to update when this plan is accepted:
    `mcp-export-scope.md` (blocking arm supersedes "MRTR as the universal
    arm"; O8 static listing confirmed), `owner-decisions.md` (D20+ below).

v2 turn-2 clarifications (Codex DISCUSS, all accepted):

17. One database owner for project state: the main-owned repository
    `vex-app/src/main/database/projects/*`. No engine-side
    `src/vex-agent/db/repos/projects.ts` in stage P; stage A2 receives a
    validated `ProjectScope` value from main.
18. Projects-root contract: `root_path` is relative and immutable; a
    change of the configured root in `config.json` is rejected while any
    project row exists. Root migration is a separate explicit workflow.
19. `project_wallets` is authoritative; the backing session's wallet
    columns are a compatibility mirror. `updateScope` performs a
    Studio-specific direct update on both tables in one transaction,
    filtered by `sessions.scope = 'vex_studio'`, and never calls
    `initializeSessionWalletScope` (immutable CAS, hard-coded to `vex_app`,
    `main/database/sessions/wallet-scope.ts:68`).
20. Stage P filesystem flow is boring: realpath the configured root,
    atomically claim the final slug directory without replacing anything
    (`mkdir` with exclusive semantics; `rename` is never used because Node
    documents it can overwrite an existing file), insert the three rows in
    one DB transaction, and on failure remove only the empty directory
    this request proved it created.
21. The backing session's `title` is set to the project name at creation
    so global approvals (which join all sessions) show a useful label.
22. A3 names `vex-app/src/main/ipc/approvals/decision.ts` as the
    composition point that dispatches the `studio_mcp` continuation
    instead of the ordinary agent resume.
23. Settlement never cuts a tool result: the full result is stored whole
    (durable, with its byte size recorded); "bounded" applies to metadata
    only. This follows the forbidden-truncation decree.
24. Before A3: one owner for canonical argument normalization, so
    `request_digest` digests exactly the envelope that dispatches.
25. Before B4: an explicit `currentView` and `runtimeMode` transition
    table including lock/unlock return behaviour and stale project
    selection cleanup.

Stage A1 probe results (2026-08-23, measured on this machine with a
throwaway stdio server on `@modelcontextprotocol/sdk@1.30.0`; full log in
the coordinator's scratchpad `a1-probe/REPORT.md`):

26. Negotiated revisions: Claude Code 2.1.241 `2025-11-25` (with
    `MCP_PROTOCOL_NEGOTIATION=auto` it first probes `server/discover` with
    `2026-07-28` metadata, then falls back to the classic `initialize`),
    Codex CLI 0.148.0 `2025-06-18`, Copilot CLI 1.0.81 `2025-11-25`.
    Gemini CLI and OpenCode are not installed here (not probed). A server
    speaking only `2026-07-28` would break every installed client.
27. Blocking arm evidence: a 70 s tool call with `notifications/progress`
    every 2 s completed on all three clients (70.4 to 70.5 s), no client
    ever sent `notifications/cancelled`, every `tools/call` carried
    `_meta.progressToken`. Codex ran with an explicit
    `tool_timeout_sec=120`; its default was not measured, so generated
    configs set timeouts explicitly.
28. All three clients call `tools/list` eagerly at session start (Codex
    even for a prompt that cannot use the server); deferral, where it
    exists, happens at the model-context level, not on the wire. O20 is
    unaffected.
29. `instructions`: the full 1500 bytes reach the model in Claude Code
    (both sentinels quoted verbatim) and in Copilot behind
    `--allow-all-mcp-server-instructions`; in Codex exposure is not
    reproducible (one run quoted byte 0, another answered "no instructions
    visible"). Consequence: the approval rule, quote-before-execute and
    the decimals discipline live in the `AGENTS.md` managed block as the
    authoritative copy; `instructions` is a second copy, not the only one.
30. `.mcp.json` in the Claude shape (no `type`) is accepted by Copilot CLI
    (`copilot mcp list` reports it as `local`), so one file serves Claude
    Code, Copilot and Grok Build. Copilot's non-interactive `-p` mode
    loads workspace MCP only with persisted folder trust or the env
    opt-in `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP=true`; the trust
    prompt copy in the installer names this.
31. Client capabilities: Claude Code `roots` + `elicitation: {}`; Codex
    `elicitation: {form, url}`; Copilot `sampling` + `elicitation: {form,
    url}`. Codex attaches its session, thread, turn, sandbox mode, model
    and reasoning effort to `_meta` of every call; the server logs `_meta`
    structurally and never echoes it into results. Shutdown is SIGINT
    (Claude Code) or SIGTERM (Codex, Copilot): the bridge and the host
    treat both as disconnect.
32. Zod: `@modelcontextprotocol/server@2.0.0` depends directly on Zod 4
    (`^4.2.0`); `sdk@1.30.0` accepts Zod `^3.25 || ^4`. Both repo packages
    are on Zod 4.4. O22 is resolved by A1b (a v2 server tested against
    the same three clients): v1.30 if v2 rejects a legacy handshake,
    otherwise v2 pinned exactly.

33. O22 resolved by A1b (2026-08-23, scratchpad `a1b-probe/REPORT.md`):
    a server on `@modelcontextprotocol/server@2.0.0` served all three
    installed clients over their legacy `initialize` (Codex `2025-06-18`
    echoed verbatim, Claude Code and Copilot `2025-11-25`), ran the 70 s
    call with progress and delivered the full `instructions`; with
    `MCP_PROTOCOL_NEGOTIATION=auto` Claude Code completed a real
    `2026-07-28` negotiation (`server/discover`, `subscriptions/listen`,
    envelope `_meta`), which v1.30 could not answer. Evidence in the
    package: `SUPPORTED_PROTOCOL_VERSIONS` still lists `2025-11-25`,
    `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`; the stdio entry
    `serveStdio(factory, { transport, legacy })` defaults to
    `legacy: 'serve'` and only `legacy: 'reject'` would refuse a 2025-era
    client; `initialize` counter-offers the newest legacy version instead
    of erroring. Dependency weight: 3 packages and 14 MB on disk versus 94
    packages and 27 MB for `sdk@1.30` (no express, hono, ajv, jose in the
    tree); Zod 4 is a direct dependency and both repo packages already use
    Zod 4.4. Decision: pin `@modelcontextprotocol/server@2.0.0` exactly
    (with its `core@2.0.0`), keep `legacy: 'serve'`, never `'reject'`.
    A4 note: the Vex server runs in main over a socket, so A4 must feed
    its socket-backed `Transport` into the era-owning entry (the
    `serveStdio` factory shape accepts a custom transport) rather than
    `Server.connect(transport)` alone, so both eras keep working.

34. Stage A2 built and final-reviewed (GREEN LIGHT). Follow-ups recorded,
    not blocking: the alias residual test compares alias NAMES with the
    launch tool ids, not resolved alias targets; strengthen it when the
    alias router contract next changes. Pre-existing environment failure
    on this machine, reproduced on a clean HEAD worktree and unrelated to
    Studio: `slippage-ceiling-global.test.ts` "uniswap.swap.quote does NOT
    refuse a legal tolerance" performs a live `readContract` for WETH
    decimals on Base (`src/tools/uniswap/erc20.ts:37`).

35. Stage A3 final review turn 1: BLOCKED on five confirmed defects, all
    accepted, fix arc dispatched (builder). F1 commit-time scope
    revalidation must compare against `scope_version_at_enqueue`, not the
    freshly loaded version (self-comparison). F2 every pre-dispatch refusal
    becomes durably terminal: a one-statement `not_started -> failed` CAS
    (racing atomically with the slot claim) for stopped / generation-lost /
    scope-load-failure; `scope_changed` after the slot claim settles in the
    SAME gate transaction; a main startup reconciler flips abandoned
    `dispatching` studio rows to `indeterminate`. F3 broker reserves
    waiter capacity BEFORE enqueue and performs one durable read after
    waiter registration to close the lost-wakeup window. F4 the
    indeterminate fallback writes status and settlement in ONE statement
    (the old second CAS could never hit) and reports `indeterminate`, never
    `failed`, when that is what was committed. F5 a failed dispatch
    generation advance poisons Studio (enqueue predicate, retry owner,
    engine dispatch preflight seam registered by main) until an advance
    succeeds; the unlock advance is awaited, not fire-and-forget. F6 expiry
    is a typed discriminator: `refusal_reason = 'expired'` stamped by the
    expire path, prose matching deleted. `refusal_reason` CHECK and TS
    union gain `stopped`, `generation_superseded`, `scope_unavailable`,
    `expired` (086 edited in place; it never shipped). Confirmed sound by
    the same review: enqueue extraction, origin-aware rejection, the
    generation CAS with its live interleaving test, lifecycle filters, and
    the `NO ACTION` FK (a later deletion stage must tombstone or migrate,
    never assume refuse-then-delete releases it).

36. Stage A3 final review turn 2: BLOCKED. The SQL core of fix arc 1 was
    confirmed (scope revalidation, refusal-vs-claim race, capacity
    reservation, atomic indeterminate, typed expiry: closed), but three
    lifecycle defects remained, all accepted, fix arc 2 dispatched:
    G1 the broker's terminal predicate - `approved/not_started` and
    `approved/dispatching` are NOT terminal (approval commits before
    dispatch), release only on rejected or approved+settled, and a
    periodic durable read is the floor for approved rows (the expiry
    sweep scans only undecided ones). G2 a lost CAS must read and follow
    the durable winner: no outcome, announce, or waiter release may claim
    a state that did not commit; the indeterminate STATUS write gets a
    bounded retry (the dispatch never). G3 main gains an awaited Studio
    readiness barrier: fail-closed preflight registration, then batched
    reconciliation of pre-existing `dispatching` rows, and only then is
    `runStudioCall` enabled; teardown registers a deny preflight instead
    of restoring the engine default-ALLOW. Hardening folded in: the
    pre-dispatch refusal CAS also requires `decision = 'approved'`,
    Studio settlement CASes also require `origin = 'studio_mcp'`, the
    poison retry is single-flight.

37. Stage A3 final review turn 3: BLOCKED on three narrower failure
    paths; the convergence cap (3 turns) is reached, so the coordinator
    decides: all three defects are accepted and fixed in fix arc 3, a
    fourth review round is not dispatched, the arc closes on the
    coordinator's own verification against the reviewer's named evidence
    bar, and the whole surface goes to the owner-directed full backend
    review (new session) before stage B. Confirmed sound in the same
    turn: terminal predicate, durable-winner handling, terminal-gated
    announces, startup ordering, SQL hardening, single-flight poison
    retry. Fix arc 3 scope: H1 same-process repair owner retrying failed
    terminal WRITES (never the dispatch) plus startup-reconciler coverage
    of `approved/not_started` studio rows (the expiry sweep scans only
    undecided rows, so approved rows had no floor); H2 runtime readiness
    checked inside the enqueue transaction's injected predicate and a
    teardown-safe lifecycle (`shutting_down -> ready` impossible, epoch
    guard, retry timers cancelled); H3 the broker's periodic durable read
    made single-flight per waiter; H4 a pure engine preflight-registry
    module set to DENY synchronously by main at bridge module setup,
    keeping headless default-ALLOW.

38. Stage A4 plan review turn 1: BLOCKED on seven findings, all
    accepted, spec rewritten to v2. The decisive one: a
    connection-scoped `ProjectScope` is a stale authorization cache -
    the handshake binds only `projectId` and main loads the
    authoritative scope at the admission of every `tools/call` (the
    linearization point against scope edits); `runCall(projectId, ...)`
    replaces `runCall(scope, ...)`. Also folded in: Windows current-user
    DACL gap (Unix host ships in A4a; Windows endpoint gated on a
    Windows probe with an ACL inspection test and a second-user denial
    test; token-file candidate is an owner decision because it revises
    the no-token-in-files note), the frozen TS/Go endpoint+handshake
    contract with acknowledgement and golden vectors
    (`bridge-endpoint-contract.md`), lock order corrected to match
    shipped A3 (scrub first, host close second, fence third), exact
    bounds with reject-at-cap instead of eviction, the SDK v2 seams
    (side-effect-free factory, `onclose` on EOF, `ctx.mcpReq`,
    `fromJsonSchema`, canonical protocol projection reuse, O7 pinned
    literally, inventory-owned byte-wise ordering), and one real
    socket-level contract test. Kept after challenge: the unlock-bound
    listener (an always-up listener widens the locked attack surface
    for diagnostics only).

39. Stage A4 plan review turn 2: BLOCKED on five contract defects, all
    accepted, spec now v3: (1) the per-call scope read is ONE atomic
    snapshot (single joined statement or repeatable-read RO
    transaction) owned solely by `runStudioCall`, applied to every
    call including `vex_ToolSearch`; the handshake existence check is
    non-authoritative and discarded; the racing-edit test runs on two
    live PostgreSQL connections; the A3 protection wording narrowed to
    restricted-mode mutations (full mode bypasses A3, so the snapshot
    is the load-bearing check). (2) The `CallToolResult` projection is
    pinned: whole `result.output`, `isError: true` iff
    `result.success === false`, O5 deferral means no data/preview/
    policy serialization, exhaustive table tests. (3) A trusted typed
    cancellation-cause seam (`cancelled | disconnect | lock |
    vex_quit`) set by each teardown owner, never from the client
    string; durable `refusal_reason` asserted in tests. (4) Endpoint
    hash input switched to the Vex config-directory realpath (both
    processes derive it independently; the bridge cannot learn the
    projects root safely); `VEX_STUDIO_SOCKET` validated before bind
    (ownership, 0700, no symlink traversal, length, stale/live) and
    refuses startup on failure. (5) The outbound path is a real
    bounded queue: one serialized send owner, finite pending count, at
    most one coalesced progress per request, final responses never
    dropped or cut, all sends settle on close, stress test with a
    blocked writable side.

40. Stage A4 plan review turn 3: conditional GREEN LIGHT. The reviewer
    confirmed the v3 decisions sound and blocked only on the fact that
    three of the five turn-2 fixes had not actually landed in the
    detailed subsection (a failed edit script, caught exactly: stale
    header, stale scope paragraph, stale hash input and override line,
    stale outbound bound). Condition: the subsection must match
    revision item 39. The coordinator applied the three missing edits
    and verified the named stale lines are gone; the condition is met
    and the A4a arc proceeds to build without a fourth review turn
    (convergence cap). Build is split into two builder passes under
    the one approved spec: A4a-1 (dependency pin and `.d.ts` pinning
    note, `outcome.ts` seam move, `runStudioCall` atomic snapshot and
    `runCall(projectId, ...)`, inventory with titles and O7 and
    ordering, instructions, lints, snapshots, generated doc, bundled
    check) and A4a-2 (server and projection and cancellation-cause
    seam, endpoint contract doc with golden vectors, socket transport,
    the main host with lock order and bounds, the real socket-level
    contract test).

41. Stage A4a built (two builder passes) and final-reviewed turn 1:
    BLOCKED on eight findings, all accepted, fix arc dispatched.
    Confirmed sound: the atomic scope snapshot, handshake remainder
    handoff, O5 projection, explicit lock ordering, canonical inventory
    extraction, dual-era SDK entry. The fixes: X1 the instructions'
    global raw-units decimals rule is FALSE for a mixed-unit surface
    (WalletSendPrepare and swaps take human decimal strings; bridge and
    Morpho take raw units) - replaced with a per-field rule pinned by
    tests against real registry descriptions; X2 a monotonic host
    lifecycle epoch (lock racing an in-progress start could reopen the
    listener), the defensive relock routed through the complete lock
    flow, and a locked-session refusal in `runStudioCall`; X3
    cancellation classified by the SDK ConnectionClosed error, not by
    string-typing the abort reason (a reasonless cancel was
    misclassified as disconnect), plus a pre-dispatch abort re-check
    after the scope snapshot; X4 synchronous connection-slot
    reservation (two concurrent handshakes at 15 could yield 17); X5
    symlink-safe endpoint directory creation (exclusive mkdir, lstat on
    EEXIST, no chmod before ownership proof); X6 one ordered quit owner
    with a typed lock-vs-quit cause (before-quit's lock raced the
    vex_quit refusal; concurrent cleanup could release waiters before
    the durable refusal); X7 transport failure paths close through the
    connection owner with bounded deadlines; X8 `vex/requiresEnv`
    emitted in `_meta` and full wire records compared against the
    complete inventory projection. A4a-2 note: the builder found and
    fixed a real byte-loss defect in the handshake-to-transport window
    (flowing socket with no data listener), contract doc section 2.4.
    Coordinator fixed six test-type ratchet diagnostics directly
    (type-only, no assertion changes).

42. Stage A4a final review turn 2: BLOCKED on four narrower defects,
    all accepted, fix arc 2 dispatched; the eight turn-1 fixes were
    confirmed materially correct. Y1 the executor's dynamic import sat
    BETWEEN the final abort gate and the dispatch (hoisted above the
    scope snapshot; held-loader test). Y2 handshake refusal was not
    synchronously latched (terminal refusing phase, timer cleared,
    listener removed, socket paused before the first await) and
    `maxConnections: 20` let Node drop the 21st socket without the
    contractual typed refusal (one overflow socket allowed). Y3
    JSON.parse error text could carry untrusted wire bytes into logs
    (closed typed codes only; sentinel log test). Y4 a lock+unlock
    during a held start attempt lost the restart (fresh current-epoch
    start queued after the stale attempt settles). Non-blocking folded
    in: contract cancellation paragraph rewritten to the SdkError
    classification, progress-token type preserved in the coalescing
    key, memoized connection dispose. Coordinator independently
    verified the turn-1 evidence in code before accepting (registry
    unit descriptions, concurrent cleanup registry, SdkError shape in
    the pin note) per the owner's verify-not-trust directive.

43. Stage A4a final review turn 3: GREEN LIGHT, arc closed. All four
    turn-2 repairs confirmed complete with behavior-exercising tests
    (held loader, held refusal write, real-socket sentinel, real
    listener cap, post-race handshake). Non-blocking hardening applied
    immediately by the coordinator: `onWireFailure` typed as
    `StudioWireErrorCode` (compile-time closed vocabulary). Recorded
    follow-up for a future refactor: `shutdownStudioMcpHost` should use
    one shared absolute cleanup deadline instead of sequential listener
    and disposal deadlines (not a current safety issue; the quit path
    closes sockets synchronously first). Standing merge gates
    unchanged: live-Postgres scope-race test and the durable vex_quit
    row on a real quit sequence (Compose stack required), Windows probe
    and real-client verification gated to A4c. `session.ts` at 596
    lines awaits its own split (578 pre-arc; flagged, not smuggled into
    a fix arc).

44. Stage A4c plan review turn 2: GREEN LIGHT for the v2 spec. One
    implementation acceptance detail recorded: the go.mod `toolchain`
    directive is only a minimum, so exactness comes from the build
    wrapper running `GOTOOLCHAIN=local` and rejecting any `go version`
    other than the pinned patch (raw `go build`/`go test` never bypass
    the wrapper). Non-blocking pins: record `GOAMD64=v1` and
    `GOARM64=v8.0`; exact values for dial/ack/drain/diagnostic bounds
    in the contract; the macOS /var symlink case run natively when a
    mac is available; PR packaging unsigned with no release secrets.
    OWNER DECISIONS (2026-08-24): Go is a named build prerequisite
    (documented in `vex-app/DEV.md`; go1.27.0 installed user-level at
    `~/.local/go` on the dev machine); stage A4b ships FULL SCOPE AT
    ONCE - both EVM and Solana generic signing tools in one arc,
    nothing deferred ("ODRAZU CALOSC, NIGDY NIE ODKLADAMY").

45. Stage A4b plan review turn 1: BLOCKED on six money-path findings,
    all accepted, spec rewritten to v2 (section 2.5 amended to match).
    Decisive changes: a NEW `wallet_transaction_intents` table (the
    transfer-shaped `wallet_intents` reads and CAS carry no kind and
    `WalletSendConfirm` could consume a transaction intent); a typed
    `PreparedApprovalBinding` seam so the STUDIO enqueue carries the
    decoded preview and the intent's own expiry (today it would fall
    back to `{walletFamily, intentId}` and the one-hour TTL); decode
    is FAIL CLOSED (unknown selector / non-canonical Permit2 / unknown
    Solana instruction / unresolvable ALT refuse before intent
    creation; known routers unsupported-and-refused in v1); MANDATORY
    fee bounds per family enforced at confirm by re-simulation against
    the exact request; Solana takes a FRESH blockhash at prepare so
    the user approves the exact signable message (short displayed
    expiry, height recheck, unchanged-bytes assertion) instead of the
    draft's sign-stale-bytes flow; a truthful generic-transaction
    activity shape plus a named reconciler for the new
    `broadcast_unconfirmed` status (the equivalent pre-existing
    transfer-path gap - failed-with-hash, no reconciler - is recorded
    as a follow-up). Pair design switched to the reviewer's
    recommendation: two family pairs over shared layers
    (`ToolDef.JsonSchema` cannot express a top-level discriminated
    union).

46. Stage A4b plan review turns 2-3: turn 2 BLOCKED on five execution
    gaps (versioned proposal digest over every sign-relevant field with
    the confirm-side binding rebuild and A3 request-digest
    incorporation; money-state gate counting `consuming` and
    staged-hash states with an activity_id link and one claim+link
    transaction; Token-2022 excluded in v1 and `eth_getCode` required
    for `data = 0x`; a public-key-only Solana canonicalization seam
    with the 60 s displayed expiry cap; fee caps as REQUIRED caller
    inputs with estimates carried in the refusal, forbidden redirect
    fields refused by name) - all folded into spec v3. Turn 3 BLOCKED
    solely on the promised-but-absent lifecycle table plus two stale
    anchors; the convergence cap was reached with no disagreement
    ("everything else is sufficiently closed"), so the coordinator
    authored the missing artifact: the WTI/AA/PE transition table
    (T1-T8) now sits in the spec with CAS predicates, evidence CHECKs,
    PE completion on every normal return and in every repair path,
    crash-recovery split on staged-hash presence, and
    `superseded_unproven` as a new honest WTI terminal; both stale
    anchors corrected and verified by grep. The arc proceeds to build
    on the coordinator's authority, with the table and the five fixes
    as the reviewer's evidence bar for final review.

47. OWNER DECISION (2026-08-24): Windows follows the VS Code pattern
    1:1 instead of waiting for an ACL probe. Evidence, verified in the
    reference checkout: VS Code's `createStaticIPCHandle`
    (`ipc.net.ts` ~928) serves its MAIN IPC on win32 as a named pipe
    with a hash-derived predictable name via plain Node
    `createServer().listen`, and the entire `src/vs/base` +
    `src/vs/platform` tree contains ZERO security-descriptor handling;
    the security model is the documented Windows default pipe SD
    (Everyone gets READ only, so a second user's duplex connect is
    denied by default) plus protocol-level validation.
    github-mcp-server is stdio-only (client spawns the server; its
    only listener is the loopback OAuth callback), which our bridge
    already mirrors on the client side. Adoption: (a) the host's win32
    arm serves the named pipe exactly like VS Code (no custom ACL; the
    `windows_probe_pending` refusal is removed); P4 is satisfied the
    way VS Code satisfies it, with a SECOND-USER DUPLEX-DENIAL TEST on
    a Windows runner as the merge gate; the unlock-bound listener,
    handshake ack and approval gating remain our additional layers.
    (b) The Go bridge dials the pipe in pure stdlib via
    `os.OpenFile("\\.\pipe\...")` (CreateFile semantics); pipes
    have no CloseWrite, so the Windows relay arm closes fully after
    the drain deadline, documented in the contract. This amends the
    frozen contract's Windows section and A4a spec item 8; it goes
    through its own Codex review turn immediately after the in-flight
    A4c final review settles (one thread, one turn at a time).

48. Stage A4c final review turn 1: BLOCKED on five findings, all
    accepted, fix arc dispatched (folded together with the item-47
    Windows adoption so the contract amends once). Z1 config-dir
    normalization parity: Node `path.join` normalizes dot segments and
    repeated separators, the Go joins did not, so a valid
    `XDG_CONFIG_HOME` containing `..` derived DIFFERENT sockets on the
    two sides - the contract now defines lexical normalization
    explicitly, Go implements it flavour-aware, cross-owner vectors
    added; `endpoint.go` switches Stat to Lstat with a symlink
    refusal test. Z2 the 512-byte diagnostic budget includes the
    omission suffix and the `flag` package's own usage output is
    suppressed (578 bytes and five lines were observed). Z3 ParseAck
    requires EOF after the first JSON value. Z4 conformance becomes
    CI-required via `VEX_REQUIRE_BRIDGE_CONFORMANCE=1` (skip was
    silent) and the relay vector check compares production constants
    (it was tautological literals). Z5 the release guard requires an
    existing release to be a DRAFT: electron-publish with
    `releaseType: release` overwrites a <2 h published release's
    assets BEFORE the workflow's signature checks. Confirmed sound in
    the same turn: relay shutdown ownership and asymmetry, and every
    normal packaging path (build, stage, format/arch inspection,
    afterPack re-inspection, fail-before-signing). Closure gates
    restated: real clients on the packaged binary, native macOS
    codesign, Windows Authenticode and the second-user pipe test on a
    Windows runner. Non-blocking folded in: the `vex-app/*.tsbuildinfo`
    gitignore rule restored (an owner request from earlier), the
    go.mod `toolchain` directive, `bridge/` in the em-dash gate.

49. Live-PG merge gates closed (2026-08-24, owner-directed stack
    start): `docker compose up` on the rendered stack
    (`~/.config/vex/compose`, Postgres 127.0.0.1:27432, embeddings
    127.0.0.1:27134, loopback-only), then the three studio integration
    files: 3 files / 20 tests green, including the two-connection
    scope-snapshot race. The integration harness is
    TESTCONTAINERS-based and runs the FULL migration chain in a
    throwaway container, so this run also proved migrations 086 and
    087 apply cleanly on live PostgreSQL. Remaining live gates: the
    durable `vex_quit` row on a real Electron quit (app lifecycle,
    owner-present), the A4b T1-T8 matrix (pass-2 builder runs it, the
    stack is now up), mac/win runner items. Port posture recorded for
    the owner's question: every published Compose port binds
    127.0.0.1 only on deliberately uncommon high ports (27432, 27134),
    and the Studio MCP itself uses NO TCP PORT AT ALL (Unix socket /
    named pipe), so the new surface has zero port-collision exposure;
    the integration suite's testcontainers use random ephemeral ports.

50. Stage A4c final review turn 2: BLOCKED on four Windows-depth
    findings, all accepted, fix arc 2 dispatched; Z1/Z3/Z4/Z5
    confirmed correct. W1 pipe-syntax overrides were classified as
    pipes on EVERY platform, bypassing the unix 0700/lstat validation
    (now win32-target-only with named unix refusals and negative
    vectors). W2 the 512-byte diagnostic bound now covers the COMPLETE
    stderr bytes including the `vex-mcp: ` prefix and newline (522 was
    measured; the conformance test had sliced the prefix before
    measuring). W3 the reviewer's deeper evidence - libuv creates the
    pipe with a NULL security descriptor and WITHOUT
    PIPE_REJECT_REMOTE_CLIENTS, and the default SD grants Everyone and
    anonymous READ - means the VS Code 1:1 pattern carries a
    cross-user read-only slot-exhaustion vector and a possible
    remote-client exposure. Under rule 90 the Windows transport is
    RUNTIME-DISABLED behind a mechanical gate
    (`WINDOWS_TRANSPORT_PROVEN = false`, typed refusal
    `windows_pending_platform_proof`, a REQUIRED windows-latest CI job
    stub whose extension is the only path to flipping the flag; the
    full proof matrix is in the contract: duplex denial, read-only
    cross-user behavior, remote-client rejection, native round trip,
    overlapped duplex, deadline/close cancellation). The pattern code
    stays, exactly as the owner directed; enablement waits for the
    proof. P4's "current-user DACL" wording stands until the matrix
    passes or the owner explicitly accepts the named posture. W4 the
    win32 dial needs FILE_FLAG_OVERLAPPED (plain O_RDWR serializes
    reads and writes on a pipe handle); a build-tagged
    syscall.CreateFile dial is added with the go1.27
    overlapped-through-NewFile support verified against the installed
    source.

51. Stage A4c fix arc 2 landed and inspected (W1-W4 with measured
    evidence: 512-byte stderr exact, pipe-on-unix typed refusal,
    WINDOWS_TRANSPORT_PROVEN=false on both sides, the bridge-windows
    CI stub with the six-item flip matrix in contract 1.6, the
    overlapped dial with go1.27 NewFile support verified against the
    installed toolchain source). OWNER ACTION recorded: add
    `bridge-windows` to branch protection required checks. Stage A4b-2
    landed: confirm handlers with the full commit-time revalidation,
    the one-transaction T2 claim, the `transaction` activity
    vocabulary end to end, repair-lane settlement and crash recovery,
    the binding folded into the canonical request digest, and the
    T1-T8 MATRIX RUN GREEN ON LIVE POSTGRESQL (2 files / 23 tests,
    migration 087 applied live) - that merge gate closed itself.
    Named A4b-2 residuals: Solana submit maxRetries 0 (stricter than
    the transfer lane, deliberate); Solana crash recovery driven from
    the EVM lane's tick; `assertSolanaFeeBounds` refuses priced
    messages without an explicit CU limit. A5 decisions folded
    (owner, 2026-08-24): Warp = launch integration now; the
    `.mcp.json` residual discovery by unselected Copilot/Grok is
    accepted with copy; research artifact saved as
    `agent-dialect-research-2026-08-24.md` with the idle-timer
    finding (progress notifications are load-bearing) and the
    empirical-probe list owed to stage A-test.

52. Stage A4c final review turn 3: BLOCKED on two Windows-only
    findings; the convergence cap is reached with NO disagreement
    (the coordinator agrees with both, and Codex confirmed the
    Unix/mac path and W1/W2 sound across all three turns and confirmed
    the `false` flags prevent live exposure). Coordinator decision:
    fix both in one arc and CLOSE A4c on the Unix/mac path, with the
    Windows surface staying runtime-disabled behind the now-stronger
    mechanical gate; no fourth review round. B1 is a real bug -
    endpoint derivation used host-flavoured `filepath.Join`/`Dir` (Go)
    and ambient `node:path` (TS), so the `bridge-windows` job would go
    red on Linux-target vectors run on a Windows host; fixed with
    target-flavoured ops in both owners and a both-directions vector
    test provable on Linux (fully closed here). B2 hardens the
    future-enablement gate: predictable pipe names let a foreign user
    squat the name first and impersonate the host, so the dial gains
    `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` and the contract
    1.6 matrix grows items 7-8 (foreign-user squatting, server
    impersonation level) plus a REQUIRED host-authentication check
    (GetNamedPipeServerProcessId + server token SID) before either
    flag flips; the SID check is named-not-shipped (Windows-runtime,
    untestable here, transport disabled). Stale plan anchors (A4a item
    8, A4c item 4) corrected. RESIDUAL NAMED TO OWNER: the entire
    Windows enablement rests on that CI job plus the flag; the Unix
    and macOS transport is what ships and is what three review turns
    confirmed.

53. Stage A4b final review turn 1: BLOCKED on six money-path
    blockers, all accepted (three citations verified in code by the
    coordinator before accepting), fix arc dispatched. V1 wallet-
    authority TOCTOU - the signer is resolved before the claim and the
    RPC prep, with no fence recheck immediately before sign or send,
    so a scope edit or vault lock lets a stale wallet still sign; the
    fix rechecks the authoritative wallet + dispatch generation under
    the A3 fence before sign, after stage, before send, both families,
    with barrier tests. V2 the human-visible preview was not bound
    into the proposal digest (mutating preview_json changed what the
    user sees without invalidating execution) - derive it canonically
    from bound fields, bind it + expiry, compare at dispatch. V3
    terminal settlement wrote WTI/AA/PE in separate transactions with
    suppressed misses (two unrepaired partial-failure states) - make
    all three atomic in one session-locked transaction or repair every
    ordering, with fault injection. V4 Solana blockhash expiry was
    mis-mapped to `chain_reverted` instead of the dedicated
    `superseded_unproven` (T6). V5 Solana fee authorization used a
    hard-coded 5000 lamports instead of `getFeeForMessage`. V6 ERC-20
    semantics were asserted from calldata shape alone - require trusted
    token identity or label an unverified ABI-shaped contract call
    honestly. What passed: the proposal digest DOES prevent swapping
    the intent/resource/payload; EVM fee bounds ARE checked before
    signTransaction; the T2 claim IS genuinely coupled in one
    session-locked transaction; the live-PG lifecycle tests are
    meaningful for normal transitions; maxRetries 0 is right.

54. A4b fix arc, pass 1: the builder DELIVERED V4 (Solana expiry ->
    superseded_unproven, mined revert -> reverted, verified in code)
    and V5 (getFeeForMessage queried at prepare AND confirm, refuse
    over-cap/unqueryable, 5000 downgraded to a hint floor) plus
    non-blocking #1/#3/#4, all live-PG green - and CORRECTLY REFUSED to
    batch V1/V2/V3/V6 blind in one pass (each a rule-00 hard-stop:
    signing order, digest wire format, DB transaction boundary, token
    identity). It also caught a factual error in the coordinator's
    brief: the V6 parenthetical claimed the ERC-20 path already refuses
    a codeless target via eth_getCode; VERIFIED FALSE in code - getCode
    gates only the `data = 0x` native branch, `decodeAgainstErc20`
    takes no chain access, so ERC-20-shaped calldata to an EOA or a
    selector-impersonating contract is still labeled a token transfer.
    Remaining blockers sequenced: pass 2 = V3 + V1 together (both
    restructure the confirm/settle path - atomic three-row terminal
    settlement in one session-locked transaction, and the
    authority/generation fence rechecked before sign, after stage,
    before send, both families) with fence-race and fault-injection
    live-PG tests; pass 3 (parallel, disjoint decode path) = V6 (token
    identity probe or honest UNVERIFIED labeling at prepare AND
    confirm); pass 4 = V2 (bind canonical preview + expiry into the
    proposal digest, compare at dispatch - a deliberate pre-release
    digest wire-format change) + non-blocking #2 (move stranded
    recovery off the EVM-only tick). `wallet-transaction-intents.ts`
    is at 690 lines - a move-only parse-helper split is owed.

55. A4b pass-2 mini plan gate: the builder stopped at Seam B without
    editing a file (exemplary). Codex verdict: V3's one-transaction
    architecture correct but CAS misses are NOT all benign under the
    session lock (a miss = a durable winner from before lock
    acquisition; exact-compatible winner -> idempotent continue,
    anything else -> rollback; PE completion must report rowCount;
    miss reads on the shared client). Seam A restated as an ORDERING
    CONTRACT: lock winning before the pre-sign fence prevents key
    loading; once signing began a lock cannot cancel the local
    signature; the post-stage fence prevents broadcast; a submission
    already invoked is ambiguous/chain-observed - provider clearing is
    defense in depth for future loads, never revocation of a
    materialized key. Seam B: GREEN LIGHT for option (a) with a
    two-arm eager/deferred signer contract on `signStageBroadcast`
    (eager arm byte-identical for EVERY current caller - WalletSend,
    Morpho, Pools and native-fee paths included, not just the five
    venues; deferred arm = keyless prep -> onBeforeSign once ->
    deferred signer factory -> account/chain equality check -> no
    provider call between signer creation and sign; post-stage fence
    outside the stageEvm catch so it is never audit_failed), plus a
    central eager-path trace regression.
56. A4b pass 7 - the 25 bps Vex fee on the generic EVM signing lane.
    OWNER DECISION 2026-08-25: the generic signing tools charge the
    standard 25 bps, reusing the native-fee-leg infrastructure rather than
    a lane-specific mechanism, WITH a deterministic economic threshold.
    Base is the transaction's own `payload.valueWei`, so an ERC-20
    transfer or an approve through this lane pays NOTHING; only
    native-value-bearing transactions pay.

    THE THRESHOLD, and the research it came from. The fee is charged only
    when it EXCEEDS the most its own collection transfer could cost at the
    approved per-gas cap (`VEX_FEE_TRANSFER_GAS_LIMIT x maxFeePerGasWei`,
    legacy `x gasPriceWei`); an exactly-equal fee is skipped, and the skip
    reason is named `at_or_below_collection_cost` so the inclusive
    equality is stated rather than inferred. The reference wallets in
    `agents-colab/` were read before the rule was written: MetaMask
    (`BRIDGE_MM_FEE_RATE = 0.875` in bridge-controller) and Rabby
    (`feeRate`/`feeAddress` embedded in aggregator quotes, with
    same-type-pair waivers) both EMBED their fee in the same transaction,
    where dust costs nothing extra, and NEITHER charges anything at all on
    generic signing. Vex's own separate-leg venues charge any positive
    fee, which is right for them because their action sizes are meaningful
    by construction; this lane's are arbitrary, so without a floor a dust
    fee would trigger a transfer costing the user more than the fee is
    worth.

    DERIVED, NOT STORED. The fee is a pure function of digest-bound fields
    plus build constants, so there is no new intent column. The canonical
    preview renders the fee lines, digest v2 -> v3 binds that preview, and
    confirm recomputes both, so a drifted fee is a digest or whole-card
    mismatch rather than a silently different number. The fee row is
    pre-created as `event_index` 1 inside the T2 claim transaction from
    one FROZEN plan object, and that same object is what gets signed;
    collection performs no second planning step. The fee leg carries its
    own pre-sign AND post-stage pre-submit authority fences, its own
    approved gas ceiling (`gasLimitWithHeadroom(21000)` = 42000, derived
    through the production helper because the staged primitive applies the
    headroom BEFORE the bounds check), and it runs only after the
    transaction it charges for has confirmed.

    NAMED OMISSION - SOLANA CHARGES NOTHING. The Solana pair on this lane
    takes no fee, and this is a deliberate gap rather than a backlog item.
    No Solana fee-leg runtime exists here, and the only mechanism
    available would be appending an instruction to the canonical message -
    the exact bytes the user already read and approved. Rewriting an
    approved message is forbidden by construction on this lane, so the fee
    does not exist there. Migration 088 ENFORCES the gap with
    `agent_activity_tx_vex_fee_eip155`: a Solana `tx_vex_fee` row is
    rejected by the database, so a future writer cannot record one without
    stating the mechanism in a migration first.

## 0. Decisions in force

Closed by the owner (to be recorded as D20+ in `owner-decisions.md`):

- O20 exposure: `tools/list` is the full static export (155 tools, every
  project, every client, never filtered by env or client capability). The
  hot set visible without searching is the internal tools plus
  `vex_ToolSearch`; the 134 protocol tools are found through
  `vex_ToolSearch` and are directly callable by public name.
- O21 stdio bridge; O22 `@modelcontextprotocol/server@2.0.0` pinned exactly
  (A1b evidence, revision-log item 33); O23 2000-byte lint (critical facts
  first, never a cut at the source); O24 approval authority only in the
  privileged process; O25 present-and-null `nextOffset`; O5 structured
  output deferred.
- P1 Project = folder + one backing session row (`mode = 'agent'`,
  `scope = 'vex_studio'`). `projects` owns Studio semantics. No new session
  kind or mode.
- P2 Wallet scope per project: one EVM and one Solana selection (id plus
  address snapshot, fail closed on drift), editable in project settings
  with a monotonic `scope_version`.
- P3 Bridge runtime: a small static Go binary, cross-compiled and signed in
  CI. Fallback: Node SEA. The bridge is an unprivileged relay with a framed
  handshake (size and time limits), no policy decisions.
- P4 Trust boundary: same OS user (0700 Unix socket, current-user DACL
  named pipe). Owner accepted explicitly: all same-user processes are
  equally trusted; project scope is policy for a well-behaved agent;
  restricted mode (the Vex approval card) is the money gate; full mode is
  deliberate autonomy for that OS account. Chosen because it is the option
  that lets users build their own apps on the bridge. Stated in UI copy.
- P5 Approval arm v1: the mutating call blocks inside the tool call with
  progress notifications and a bounded expiry; typed outcomes. MRTR is a
  later arc.
- P6 Projects root `~/Vex/projects`, declared once in
  `vex-app/src/main/paths/config-dir.ts`, mirrored in
  `src/config/paths.ts`, override owned by `src/config/store.ts`
  (`config.json`). All explorer and terminal paths are confined under it.
- P7 Studio mounts as a new `View` in `App.tsx`; the status strip is
  extracted and mounted once per active shell.
- P8 Generic signing tools are their own hard-stop decision inside stage A.
- P9 `@thesvg/react` 3.3.1 is the logo source (bumped and verified).
- Launch tools (`trench.launch_execute`, `pools.launch_execute`) export
  over MCP and go through the Vex approval card in restricted projects.
- Every feature VS Code also has uses VS Code's operating logic 1:1,
  adapted to the Vex design system, never copied code. github-mcp-server
  is the MCP server reference; deepseek-harness the agent-runtime seam
  reference (lifecycle concepts, not Electron packaging evidence).
- Agents are selected per project at creation and editable later; only
  selected agents get config files. `agents-colab/` stays git-ignored.
  No AI attribution. No em dashes. No commit or push without the owner.

## 1. Target behaviour

1. Unlock Vex. Welcome screen: toggle Agent | Studio (the reserved seat
   exists in `SessionWelcomeHero.tsx`).
2. Studio, New project: name, permission (restricted | full), one EVM and
   one Solana wallet, agents (multi-select with brand marks). Editable
   later; a scope edit bumps `scope_version`.
3. Vex creates `<projects root>/<slug>/`, the backing session row, the
   config file of each selected agent, `AGENTS.md` with a Vex-managed
   block, `CLAUDE.md` containing `@AGENTS.md`, `.vex/protocols.md`.
4. The user opens a terminal tab and runs `claude`, `codex`, `gemini`,
   `opencode`, and so on. The agent prompts once for trust of the
   project-level server (no agent can be pre-approved from a file; the UI
   copy says so).
5. The agent sees `vex_*`: internal tools and `vex_ToolSearch` at once,
   protocol tools through search, all 155 callable by name. Reads run at
   once. A tool whose provider env is absent answers
   `configuration_unavailable` with the env name and the remedy.
6. A mutation in a restricted project raises the Vex approval card. The
   agent's call waits with progress; the user approves or rejects in Vex;
   the call returns the result, or a typed "declined, not executed",
   "expired, not executed", "cancelled, not executed". In a full project
   the mutation executes at once.
7. Editing permission, wallets or agents re-renders the managed files. A
   Vex update re-renders them on next open. Drift in the managed block is
   reported, never silently overwritten.
8. Any MCP client of the same OS user can use the same bridge and the
   same project scope.

## 2. Architecture

### 2.1 Process model

```
agent CLI  <-stdio->  vex-mcp bridge  <-socket->  Vex main process
                      (framed relay)             inventory, admission,
                                                 project scope, executor,
                                                 approvals, vault, DB,
                                                 embeddings (Docker)
```

- One bridge process per agent session, one socket connection per bridge,
  one `McpServer` instance per connection in Vex main. Connection registry
  with a hard cap; oldest-idle eviction with a logged reason.
- Handshake: the bridge sends one framed message `{projectId,
  bridgeVersion}` within a size and time limit; main validates project
  existence, Studio enabled, version compatibility, then relays JSON-RPC
  frames verbatim. Failure: one actionable stderr line, non-zero exit
  ("Vex is not running", "project not found", "bridge outdated").
- The listener lives only while the secret session is unlocked.
  `lockSecretSession` refuses every pending Studio intent (see 2.4), closes
  the listener and drops connections; quit tears down through the ordered
  quit cleanup before Compose stops.

### 2.2 Project = backing session

- Migration 085: table `projects` (`id`, `name`, `slug` unique,
  `root_path` relative to the projects root, immutable, `permission`,
  `backing_session_id` unique FK to `sessions`, `agents` closed enum array,
  `scope_version` integer, `generator_version`, timestamps) and table
  `project_wallets` (`project_id`, `family` in `evm | solana`, `wallet_id`,
  `address`, one row per family, same atomicity rule as migration 026).
- The backing session is created with `mode = 'agent'`,
  `scope = 'vex_studio'`, `permission` mirrored from the project, and the
  two wallet selections mirrored so every existing gate keyed by session
  sees the same scope. A scope edit updates both in one transaction and
  bumps `scope_version`; in-flight approvals carry the version they were
  enqueued under and are refused at commit when it changed.
- The MCP executor builds `InternalToolContext` from the backing session
  through a project-scope hydrator (`src/vex-agent/mcp/project-context.ts`):
  `sessionPermission` from the project, `walletResolution` and
  `walletPolicy` from `project_wallets`, `sourceSurface: "mcp_local"`,
  `modelOriginated: true`, `sessionKind: "agent"`, `planMode: false`,
  `contextUsageBand: "normal"`, no mission. Never through `runTool`; the
  boundary test is extended to forbid `runTool` imports from
  `src/vex-agent/mcp/**`.

### 2.3 Admission, inventory and exposure

- Admission (`src/vex-agent/mcp/admission.ts`): internal tools enter
  `dispatchTool` as today; a protocol public name is resolved to its
  manifest (`resolveInjectedProtocolTool`, then the catalog) and enters
  `executeProtocolTool` directly with the MCP context, skipping only the
  session working-set check; alias resolution, param validation, reveal
  gates, prequote and approval gates all still run inside
  `executeProtocolTool`. The in-app working-set guard in
  `dispatcher/protocol-route.ts` is untouched and tested to stay so.
- Inventory (`src/vex-agent/mcp/inventory/`): one `StudioTool` record per
  exported tool (the Vex counterpart of github-mcp's `ServerTool`):
  `publicName` read from the manifest at runtime (the `mappings/*.json`
  artifacts remain the parity gate in tests), `title` (O6, generated and
  reviewed once), `description`, `inputSchema`, `annotations` derived from
  `actionKind` and `mutating` (O7), `alwaysLoad` for the hot set
  (`_meta["anthropic/alwaysLoad"]`, snapshot-pinned to exactly the hot
  set), `requiresEnv` carried as metadata only.
- Export filter is `mcp-export-scope.md` verbatim (memory and engine tools
  excluded, `execute_tool` excluded, `vex_ToolSearch` read-only). The list
  is deterministic (group, then name), identical across projects and
  clients, never varied by env, permission or client capability.
- Execution-time availability: a tool whose `requiresEnv` is unmet returns
  a typed `configuration_unavailable` result naming the env variable and
  the remedy; this is a tool result (`isError: true`), not a protocol error.
- `vex_ToolSearch` export mode: `discoverProtocolCapabilities` with
  `sessionId` omitted, query and namespace modes only, no select mode, no
  working-set write, no env filtering (rows carry `available: false` with
  the env name when unmet), dense lane with lexical fallback. Compact row
  projection as today.
- `instructions`: a 512-character self-contained safety prefix (approval
  rule, quote-before-execute, decimals), then the rest within 2000 bytes
  (how to use `vex_ToolSearch`, project permission, availability note).
- Lints and gates under `src/__tests__/vex-agent/mcp/`: description budget
  (first 2000 bytes carry risk class and preconditions), annotation
  completeness (explicit `readOnlyHint` and `destructiveHint` on every
  exported tool), exported-surface snapshot (reuse `__toolsnaps__`), list
  equality across projects and env configurations, direct unsearched
  protocol execution, generated `studio-mcp/exported-tools.md` with a CI
  diff gate.
- Read-only and project scope are enforced in the executor, never by
  absence from the list.

### 2.4 Studio approval state machine (blocking arm)

Durable: `approval_intents` gains `origin` (`agent | studio_mcp`),
`project_id`, `scope_version_at_enqueue`, `request_digest` (canonical
digest of tool name, canonical args, manifest fingerprint), and a
`settlement` JSON (the full tool result stored whole with its byte size, or the typed refusal).

States: `pending` -> `approved` -> `dispatching` -> `settled` |
`dispatch_failed`; `pending` -> `declined` | `expired` | `refused`
(`reason` in `lock | disconnect | cancelled | project_deleted |
scope_changed | vex_quit`). Every transition is a CAS on the row; a
transition from a non-pending state is a no-op that reports the real
state.

Flow:
1. Executor returns `pendingApproval` with `prequote` and `riskPreview`
   (today's gate). For the two launch tools the MCP executor sets an
   approval-surface override so the gate fires instead of the in-app form
   carve-out.
2. `src/vex-agent/mcp/approvals.ts` enqueues the intent with origin
   `studio_mcp` through a seam extracted from the turn loop
   (`approval-runtime/enqueue.ts`), registers a waiter in an in-memory
   broker keyed by intent id, and the card renders as today (the DTO
   already accepts non-chat sources).
3. The call awaits the waiter with progress notifications every few
   seconds until `expiresAt`. MCP cancellation, transport EOF, lock,
   project deletion and scope change each perform the CAS to `refused`
   first and only then release the waiter, so no dispatch can start after
   a refusal. A decision arriving after a refusal is answered by the real
   state ("already cancelled, not executed").
4. On approve: the approval runtime's new `studio_mcp` continuation
   (`approval-runtime/studio/`) hydrates the context from the project
   (not from agent-session columns), checks at commit time that the
   project exists, `scope_version` is unchanged, the permission is
   unchanged, the manifest fingerprint matches and a fresh prequote is
   acceptable, then dispatches through admission with `approved: true`
   and `approvalId`. Settlement is exactly once: the CAS to `settled`
   stores the full result whole (bounded metadata only) and the broker releases the waiter; if the
   waiter is gone the settlement is still durable and the UI shows it.
5. The agent receives the tool result, or `isError: true` with the typed
   refusal text naming what did not happen and why.

Generated client configs raise the per-server tool timeout above the
intent expiry (Claude Code `timeout`, Codex `tool_timeout_sec`, OpenCode
`timeout`, Gemini `timeout`). A1 measures which clients honour progress
and which need the timeout alone.

MRTR (later arc, not in A3): sealed `requestState` (AES-256-GCM, random
per-run key, payload `{v, projectId, intentId, requestDigest,
scopeVersion, expiresAt}`), reissued arguments ignored in favour of the
persisted envelope, one-shot CAS, defined retry-while-pending (returns
`input_required` again with the same state) and duplicate-retry (answered
by the real state), and the same commit-time checks. Enabled only after
a state diagram and real-client proof.

### 2.5 Generic signing tools (stage A4b, own decision)

- Two family pairs (`WalletEvmTransactionPrepare/Confirm`,
  `WalletSolanaTransactionPrepare/Confirm`) on a NEW
  `wallet_transaction_intents` store; decode set v1 is CLOSED (ERC-20,
  canonical Permit2, native transfer; exact Solana instruction
  variants) and everything outside it REFUSES before intent creation -
  known routers are unsupported in v1 by name. Mandatory fee bounds,
  approval-binding seam on both surfaces, fresh-blockhash prepare flow
  for Solana. The authoritative contract is the stage A4b detailed
  spec (v2) in section 3.
- Message signing (EIP-712, personal_sign) is a separate later decision.
- Tests: fee-params sweep green, decode goldens, simulation failure
  returns the real cause, card shows the decoded intent, no broadcast
  without an approved intent.

### 2.6 Installer and instruction files

- Agent registry `src/vex-agent/studio/agents.ts`: closed list with
  display name, brand mark, config path and format, writer, timeout keys,
  trust-prompt copy, detection hints. Detection ranks copy only.
- Writers (merge, never clobber; unknown keys preserved; JSON and JSONC
  through `jsonc-parser` `modify`; TOML through section-level text
  replace): `.mcp.json` (Claude shape, no `type`; also read by Copilot CLI
  and Grok Build, dialect confirmed in A1), `.codex/config.toml`,
  `.gemini/settings.json` (plus `context.fileName: ["AGENTS.md"]`),
  `.qwen/settings.json`, `.cursor/mcp.json`, `.amp/settings.json`,
  `.factory/mcp.json`, `.kiro/settings/mcp.json`, `opencode.json`,
  `.vibe/config.toml`. Never written: `.crushrc`, Gemini `trust: true`,
  Kiro `autoApprove`, Grok `[permission]`, and no file at all for the
  unsupported ids (cline and the Warp CLI read user-global config only;
  writing a user-global file from a project is invasive and is not done).
- `AGENTS.md` managed block (`<!-- vex:studio:begin hash=... -->`) rendered
  from the prompt layers minus in-app-only layers, plus the project's
  permission and wallets; compact; rich declarations in
  `.vex/protocols.md`. `CLAUDE.md` created with `@AGENTS.md` or the import
  appended. Regeneration on project update, Vex version change, Repair.
  Drift reported with a badge, never overwritten silently.

### 2.7 Studio UI

- Mount: `App.tsx` view map gains `studio`, dispatched on `runtimeMode`.
  `features/studio/StudioShell.tsx` reuses `lib/shell-columns.ts`. The
  status strip is extracted from `AppShell.tsx` into
  `features/appShell/ShellStatusStrip.tsx` and mounted by whichever shell
  is active (never both). `GlobalApprovals` keeps its single
  `useGlobalApprovalsLiveSync`; a mode-independent approvals push hook
  (extracted from the enqueue-invalidation half of
  `useMissionUpdateLiveSync`) is mounted once at `AppShell` level so a
  Studio-originated enqueue invalidates `pendingAll` without
  `SessionPanel`.
- Left rail: `features/studio/ProjectsList.tsx` mirrors `SessionsList`
  (injected geometry), reuses `RailSearchField`, `SidebarIconButton`,
  collapse and scrollbar hooks; `projectListModel.ts` is a sibling.
- Center: tab strip (owned `tabs.tsx` plus the scoped id helper) with
  keep-alive content; terminal tabs host xterm instances owned by a
  registry outside React; file tabs host the read-only viewer.
- Right rail: `PortfolioCardScope` gains `{ kind: "project"; projectId }`;
  main resolves the project's wallet addresses server-side exactly as for
  `session` scope. Studio section list with its own persisted order key
  (persist version 13 to 14, migration and coercion). Approval card
  visible here.
- New project dialog: `features/studio/ProjectCreator.tsx` mirrors
  `SessionCreator` (reuses `PermissionFieldset` and `WalletFieldset`) plus
  an agent picker of checkbox cards with `@thesvg/react` marks
  (`variant="mono"` on theme-aware placements). Renderer sends wallet ids
  only.
- Toggle: `RuntimeModeToggle` becomes two live buttons;
  `SessionWelcomeHero.test.tsx` changes (stated contract change).
  `runtimeMode` not persisted in v1.
- Design guard widened to `features/studio/`.

Agent picker mark mapping (`@thesvg/react` 3.3.1): Claude Code
`ClaudeCode`, Codex `CodexOpenai`, Gemini CLI `GeminiCli`, OpenCode
`Opencode`, Grok Build `GrokXai`, Kimi `Kimi`, Qwen Code `Qwen`, Copilot
CLI `GithubCopilot`, Cursor `Cursor`, Amp `Sourcegraph` (the package's
`Amp` is Google AMP), Kiro `Kiro`, Mistral Vibe `MistralAi`, Cline
`Cline`, Warp `Warp`, Z.ai `Zhipu`, Jules `GoogleJules`; Factory Droid has
no mark (local asset or monogram fallback).

### 2.8 Terminal (VS Code model, adapted)

- `vex-app/src/pty-host/` is a new Vite entry started as a `utilityProcess`
  by `main/studio/pty-host-starter.ts`: lazy start on first terminal,
  `connect()` once for main and once per window; the window port is
  delivered to PRELOAD by nonce (VS Code's `acquirePort` shape) and
  retained there; preload exposes opaque `terminal.write(id, data)`,
  `terminal.resize(id, cols, rows)`, `terminal.onData(id, cb)`,
  `terminal.onExit(id, cb)` returning cleanups; no port object reaches the
  renderer. Main owns terminal ids, cwd, shell resolution, env, create,
  kill and cleanup through validated IPC.
- Heartbeat 5 s with the two-stage unresponsive ladder; restart while
  `_restartCount <= 5` (1:1); ordered teardown (timers, `shutdownAll`,
  proxy, listeners).
- Env: a scrubbed base captured at boot before unlock, plus
  `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=vex-studio`,
  `LANG` when missing; `null` deletes, `undefined` skips; paths escaped
  before reaching a shell.
- Shell resolution: macOS `$SHELL -l` (zsh, bash, fish), Linux `$SHELL`,
  Windows `pwsh` then `powershell.exe`; ConPTY requires build 18309.
- Flow control: 100000 / 5000 / 5000 watermarks, ack from xterm's write
  callback, 5 ms coalescing at the source, flush before resize, forced
  resume after replay. Quiet-period exit 250 ms with a 5 s backstop.
- Renderer: `@xterm/xterm` 6 with fit, webgl (DOM fallback on context
  loss, static downgrade flag), search, unicode11, serialize, clipboard,
  web-links; `kittyKeyboard` on; theme from the Vex semantic tokens,
  reassigned wholesale; wrapper element created once and re-parented on
  tab switch.
- Packaging (B1): `node-pty` 1.2.0-beta.15 pinned exactly, externalized in
  the main and pty-host Vite builds, shipped through `files` plus
  `asarUnpack`, pnpm `onlyBuiltDependencies`, fuses unchanged,
  `spawn-helper`, `conpty.dll`, `OpenConsole.exe` signed, separate mac
  x64 and arm64 artifacts; `check:build` asserts the unpacked module.

### 2.9 Explorer and viewer

- Main owns `main/studio/files/`: opaque `nodeId` per (project, relative
  path), paths re-derived and containment-checked under the projects root
  after `realpath`; lazy `readdir` per expanded directory with a cap and
  an explicit "N more" marker; `@parcel/watcher` 2.6 per projects root
  with watcher-level excludes, 75 ms aggregation, the coalescing rules
  (added+deleted drop, deleted+added to updated, case-only renames kept),
  a `maxBufferedWork` overflow flag that makes the renderer resync; ENOSPC
  logged once, no restart on ENOSPC or EMFILE.
- Explorer refresh policy 1:1 with `explorerService.ts`: internal
  operations update the model directly; watcher events are applied after
  the 500 ms react delay and only when they can change what is rendered
  (deleted; updated when sorting by mtime; added only when the parent is
  resolved and the child unknown); no mutation while an inline edit is
  open; refresh on window focus as the missed-event backstop.
- IPC: `CH.files.listChildren`, `CH.files.readFile` (byte cap, binary
  verdict), `EV.files.changed` batches with `batchSeq` and `overflow`, a
  per-open-file subscription.
- Renderer: `@headless-tree/core` + `@headless-tree/react` rendered with
  `@tanstack/react-virtual`; Shiki 4 (JavaScript regex engine) in a
  Worker, `codeToHast` to React elements, CSP untouched, size cap with
  plain-text fallback.

## 3. Stages, files, verification

### Stage P - Project entity (first arc for builders)

Scope: migration, main-owned repository, IPC, preload, renderer API. No
engine change, no dispatcher change, no approval change, no installer,
no deletion. The engine stays unaware of project persistence.

Files: `src/vex-agent/db/migrations/085_projects.sql` (+ packaged mirror
through `scripts/copy-migrations.mjs`), `vex-app/src/main/paths/
config-dir.ts` and `src/config/paths.ts` (`PROJECTS_ROOT`), `src/config/
store.ts` (root override in `config.json`, rejected while projects
exist), `shared/schemas/projects.ts`, `shared/ipc/channels/requests.ts`
(`CH.projects.{create,get,list,updateScope}`), `main/ipc/projects/*.ts`
registered in `register-all.ts`, `main/database/projects/{create,read,
scope}.ts` (the single owner of project state), `preload/agent/
projects.ts` + `preload/index.ts`, `renderer/lib/api/projects.ts`.

Behaviour: create = validate name and slug (unique, filesystem-safe, no
traversal), resolve wallet ids to addresses in main (fail closed),
realpath the configured root, atomically claim `<root>/<slug>` with
exclusive `mkdir` (never replacing an existing path; `rename` is not
used), insert the backing session (`mode='agent'`, `scope='vex_studio'`,
`title` = project name, permission and wallet columns mirrored), the
project row and the `project_wallets` rows in one DB transaction, return
the DTO; on DB failure remove only the empty directory this request
created. `updateScope` = permission and wallet edits on `projects`,
`project_wallets` and the backing session in one transaction, filtered by
`scope='vex_studio'`, `scope_version + 1`, never through
`initializeSessionWalletScope`. `get`, `list` (projects only; the backing
session never appears in the agent-mode session list, which filters
`scope='vex_app'`).

Verification: four contract tests per channel (positive, invalid input,
unauthorized sender, cancellation), the three surface reconciliation
tests, migration round trip, confinement (slug traversal, symlinked
root), duplicate slug, wallet-address drift, compensation never removes
a pre-existing file or directory, `vex:sessions:list`, `vex:sessions:get`,
`vex:chat:*` submit and `vex:wallets:setSessionWalletScope` omit or reject
the backing session, global approvals render the project title, a scope
update succeeds after `message_count > 0` while the ordinary session CAS
is unchanged, concurrent scope updates increment `scope_version`
serially, a root change with existing projects is rejected, `pnpm test`,
`pnpm --dir vex-app lint`, `pnpm --dir vex-app test`.

### Stage A1 - Probes (evidence only)

A throwaway stdio server logging inbound `_meta` and capabilities under
`claude`, `codex`, `copilot`, `gemini`, `opencode`: negotiated revision,
elicitation and MRTR support, `list_changed`, cancellation, progress
handling versus the per-server timeout, `.mcp.json` `type` dialect, tool
search behaviour. Zod-major check for `@modelcontextprotocol/server@2.0.0`.
Decides O22.

### Stage A2 - Admission and project executor

Files: `src/vex-agent/mcp/admission.ts`, `src/vex-agent/mcp/
project-context.ts`, `src/vex-agent/mcp/executor.ts` (`ToolResult` to
`CallToolResult`, `configuration_unavailable`), `src/vex-agent/mcp/
scope.ts` (read-only and project enforcement), boundary test extension.
Verification: every in-app gate fires for an MCP call (restricted vs
full, wallet drift, retired alias, unknown tool); direct unsearched
protocol execution; the in-app working-set refusal unchanged; env-absent
tool answers the typed result.

### Stage A2 - detailed spec (built; Codex final review GREEN LIGHT 2026-08-23)

Depends on stage P types only (the wallet ref shape and
`VEX_STUDIO_SESSION_SCOPE`), not on stage P being merged. Turn-1
blockers accepted: launch-tool approval override moves into A2, the
exported ToolSearch gets its own read-only adapter in A2, and the
`ProjectScope` schema lives in the engine package because the root
`tsconfig.json` has no `@shared` alias.

#### Goal

An external caller (the future MCP server) can execute any exported
tool with a project's scope, through the same gates the in-app agent
passes, without the session working set, without `runTool`, and without
the engine learning about project persistence.

#### Inputs from main (the only coupling)

`src/vex-agent/mcp/project-scope.ts`: a strict pure Zod schema
`projectScopeSchema` and type `ProjectScope`:

```
{ projectId, scopeVersion, permission: "restricted" | "full",
  backingSessionId, wallets: { evm: {id,address} | null,
                               solana: {id,address} | null } }
```

Main builds the value from `projects` + `project_wallets`
(authoritative) and parses it through this schema before calling the
executor. The engine never reads project tables.

#### New files (engine side, `src/vex-agent/mcp/`)

1. `export-scope.ts`: the ONE predicate and resolver for the exported
   surface (`isExportedInternalTool(name)`, `isExportedProtocolTool(
   toolId)`, `listExportedTools()`), encoding `mcp-export-scope.md`:
   memory and engine tools excluded, `execute_tool` excluded,
   `vex_ToolSearch` exported read-only, all protocol namespaces exported.
   A test asserts the predicate against every registry entry and every
   catalog manifest (not representative names) and against the Markdown
   table, so the doc is checked from the predicate, never the reverse.
   A4's inventory consumes this module.
2. `project-context.ts`: `buildProjectToolContext(scope, opts)` returns
   `InternalToolContext` with `sessionId = backingSessionId`,
   `sessionPermission = scope.permission`, `walletResolution =
   buildProjectWalletResolution(scope.wallets)` returning
   `{ source: "session", evm, solana }` (a null family fails closed with
   no fallback to the primary wallet; same contract as
   `engine/core/hydrate.ts:87` and `src/tools/wallet/multi-auth.ts:82`),
   `walletPolicy: { kind: "none" }` (no mission allowlist; not "no
   wallet"), `sourceSurface: "mcp_local"`, `sourceSession =
   backingSessionId`, `modelOriginated: true`, `sessionKind: "agent"`,
   `planMode: false`, `contextUsageBand: "normal"`, `missionId: null`,
   `missionRunId: null`, `loadedDocuments: new Map()`, `approved: false`
   (always in A2), `abortSignal` from the caller, and the new
   `approvalSurface: "studio_mcp"`.
3. `dispatcher/protocol-route.ts` refactor (move-only plus one field):
   extract the `InternalToolContext` to `ProtocolExecutionContext`
   derivation into a pure shared mapper
   (`tools/protocols/execution-context.ts`, `toProtocolExecutionContext`)
   used by the in-app route and by A2 admission. Add an OPTIONAL
   `approvalSurface?: "in_app_form" | "studio_mcp"` to
   `ProtocolExecutionContext`; the protocol runtime / approval gate
   normalizes it once (`context.approvalSurface ?? "in_app_form"`) so
   the many direct `executeProtocolTool` callers (internal action
   aliases, desktop launch paths, typed test contexts) keep today's
   behaviour untouched. The A2 mapper sets `studio_mcp` explicitly. In
   `protocols/runtime/gates.ts`, the `FORM_IS_THE_APPROVAL_TOOLS`
   carve-out applies only when the normalized surface is `in_app_form`;
   under `studio_mcp` the two launch tools return `pendingApproval` like
   every other mutating tool and never reach their handler. A regression
   test proves an omitted surface preserves the existing launch-form
   carve-out, plus a typecheck fixture with an omitted field.
4. `tool-search-export.ts`: the read-only `vex_ToolSearch` adapter,
   built on two small extractions in the discovery layer (not on the
   dispatcher): (a) the compact row projection used by the in-app query
   and namespace modes moves from `dispatcher/tool-search.ts` into a
   pure module `protocols/discovery/rows.ts` that both callers import;
   (b) `discoverProtocolCapabilities` gains an explicit availability
   mode, `availability: "filter-env-unmet" | "include-unavailable"`,
   defaulting to the current in-app filtering so nothing changes for the
   agent. The adapter requests `include-unavailable`, omits `sessionId`
   so nothing is recorded, supports query and namespace modes only
   (`select` rejected by name with the real reason), appends
   `available: false` plus the env names on env-unmet rows, and keeps the
   same limits and reject-by-name on a limit above the max. The
   architecture test forbids `src/vex-agent/mcp/**` from importing
   `dispatcher/tool-search*`; the shared projection lives under
   `protocols/discovery/` precisely so that stays true.
5. `admission.ts`: `admitStudioCall(name, args, context)`:
   - `vex_ToolSearch` -> the export adapter (never the in-app
     `ToolSearch` through `dispatchTool`);
   - other exported internal tool names -> `dispatchTool({name, args,
     toolCallId}, context)` unchanged;
   - protocol public name -> `resolveInjectedProtocolTool` (alias table,
     then the live map); unresolvable -> the existing unknown-tool
     answer with the search hint; resolved -> `executeProtocolTool({
     toolId, params: args, ...}, toProtocolExecutionContext(context))`
     directly, skipping only the session working-set admission; alias
     resolution, strict params, namespace lifecycle, prequote, approval
     gate, handler, capture and the `actionKind` fallback all still run
     inside `executeProtocolTool` (`protocols/runtime.ts:170`);
   - `execute_tool` and every non-exported name -> typed refusal `not
     exported`, never dispatched. A separate test proves that
     `dispatchTool({ name: "execute_tool" }, builtContext)` returns the
     model-originated refusal, so `modelOriginated: true` is proven to be
     built, not only pre-filtered.
6. Configuration availability, two layers with one typed outcome:
   (a) `availability.ts` pre-checks `requiresEnv` on the resolved
   manifest or internal ToolDef BEFORE dispatch and returns the typed
   `configuration_unavailable` result (env names, remedy); this is a
   hint layer and catches only what the name resolves to statically.
   (b) Dynamic internal aliases (`SwapQuote`, `SwapExecute` on Solana
   route to a Jupiter manifest that requires `JUPITER_API_KEY`; the alias
   itself declares no `requiresEnv`) are covered at the runtime: the
   protocol runtime's existing configuration refusal gains a structured
   field on `ToolResult`, `failure?: { kind: "configuration_unavailable";
   env: string[] }` (additive, optional), set wherever the runtime
   already refuses on a missing required env; the executor normalizes
   both layers into one typed outcome. Handler-level refusals stay the
   authority (namespace lifecycle, handler registration, provider
   errors); an optional key (Relay) never yields
   `configuration_unavailable`. Test: `SwapQuote` on Solana with no
   Jupiter key returns the typed outcome through A2.
7. `executor.ts`: `executeStudioTool(scope, call, signal)` composes
   1-6 and returns an internal `StudioExecution` that RETAINS the full
   `ToolResult` (including `prequote` and `riskPreview`, which A3's
   approval preview needs) plus `durationMs` measured by the executor
   for real dispatches and left undefined for synthetic refusals (the
   existing `ToolResult` semantics). A transport projection to `CallToolResult` is A4's job.
   In A2, `pendingApproval: true` means "refused: approval required, not
   executed", and the raw pending result is kept whole for A3.

#### Guard changes

- `vex-app/src/main/ipc/__tests__/run-tool-boundary.test.ts` extended
  to fail if any file under `src/vex-agent/mcp/**` imports `runTool` in
  any import shape.
- A new architecture test: `src/vex-agent/mcp/**` never imports
  `db/repos/sessions`, any `vex-app/**` path, or the in-app
  `dispatcher/tool-search*` modules; the engine stays unaware of
  project persistence and the export adapter cannot reach select mode.

#### Tests (required)

- Gate parity: restricted scope, a mutating protocol tool and a
  mutating internal tool both return the approval-required refusal with
  the full pending `ToolResult` retained; full scope dispatches (faked
  handler).
- Launch tools under `studio_mcp`: `trench.launch_execute` and
  `pools.launch_execute` return `pendingApproval` and the handler is
  never invoked; under `in_app_form` the existing carve-out is unchanged
  (pinned).
- Wallet drift and null family fail closed exactly as a session does.
- Direct unsearched protocol execution through admission with no
  working set recorded; the same call through `dispatchTool` with an
  empty working set is still refused (in-app guard preserved, pinned).
- `vex_ToolSearch` export: query and namespace answer; `select` is
  rejected by name; no working set is written (the discovered-tools
  store is asserted empty after the call); env-unmet rows are present
  with `available: false`.
- Retired alias resolves; unknown name answers with the search hint.
- `execute_tool`, a memory tool and an engine tool are refused as not
  exported; `dispatchTool` with the built context refuses `execute_tool`
  as model-originated.
- `requiresEnv` unmet -> `configuration_unavailable` naming the env;
  an optional provider key never triggers it; `SwapQuote` on Solana with
  no Jupiter key yields the same typed outcome through the runtime's
  structured failure field.
- Omitted `approvalSurface` preserves the in-app launch-form carve-out
  (regression test plus a typecheck fixture).
- Discovery `availability` mode defaults to today's filtering for the
  in-app path (pinned), and `include-unavailable` returns env-unmet rows
  with `available: false`.
- Export predicate matches every registry entry and manifest, and the
  Markdown table; a new undocumented internal alias fails the parity
  test by name, not only by count drift.
- `modelOriginated: true`, `sourceSurface: "mcp_local"`,
  `approvalSurface: "studio_mcp"` are set on the built context.

#### Out of scope

Approvals (A3), inventory and `tools/list` (A4), bridge, installer, UI.

### Stage A3 - Studio approval state machine

Files: migration 086 (`approval_intents` columns), `approval-runtime/
enqueue.ts` (seam), `approval-runtime/studio/{continuation,hydrate,
broker}.ts`, one canonical-argument normalization owner shared by the
digest and the dispatch envelope, `src/vex-agent/mcp/approvals.ts`,
`vex-app/src/main/ipc/approvals/decision.ts` (the composition point
that dispatches the `studio_mcp` continuation instead of the agent
resume), the lock hook in `main/secrets/session.ts` calling the refusal,
the MCP host's EOF and cancellation handlers; the launch-tool
approval-surface override already lands in A2 (`approvalSurface`), A3
only consumes it. Settlement stores the full tool result whole with its
byte size; no cut.
Verification: approve, decline, expire, lock mid-flight, disconnect
mid-flight, cancel mid-flight, project deleted, scope changed, decision
after refusal, duplicate decision, commit-time check failures; no
dispatch without an approved pending intent; exactly one settlement.

### Stage A3 - detailed spec (v3 after Codex turn 3; coordinator decision under the convergence cap)

Built on the approval-runtime map of 2026-08-23 (coordinator scratchpad)
and on A2's `buildProjectToolContext`. Four corrections to the v2
section 2.4 sketch, all from repo evidence:

- No third state axis. `approval_intents` already carries `decision`
  (`approved | rejected | rejected_stop`) and `execution_status`
  (`not_started | dispatching | succeeded | failed | indeterminate`);
  "expired" is already `rejected` + `TOOL_RESULT_EXPIRED_REASON`. A3 adds
  `refusal_reason` to that model instead of `refused`/`settled` states.
- A Studio settlement never writes a transcript `result_message_id`, and
  every lifecycle predicate that drives an agent resume becomes
  origin-aware; otherwise the reconciler would resume an agent turn on
  the backing session for a call the agent never made
  (`approval-intents/lifecycle.ts:372,404`).
- The Studio dispatch hydrates wallets from `projects` + `project_wallets`
  through A2's `buildProjectToolContext` with `approved: true`; it never
  uses `post-tx/dispatch-approved/resumed-tool-context.ts` (session
  columns, the mirror).
- The branch is in the engine, not in `decision.ts`: `prepareApprove`
  dispatches inside `applyApproveSideEffects` before main sees an
  outcome, so `claimResumeContinuation` (`continuation.ts:64-71`) gains a
  third arm keyed on the row's `origin`, and `decision.ts` keeps
  dispatching an opaque continuation exactly as today.

#### Global lock order (binding for every A3 transaction)

Read the immutable backing-session id OUTSIDE the transaction (it is
write-once), then inside one transaction: (1) `acquireSessionControlLock`
on the backing session, (2) approval rows (`FOR UPDATE OF i, q, s` as
today), (3) the `projects` row (`FOR UPDATE`), (4) commit. The approve
path already does (1) and (2); A3 adds (3) after them. `updateScope` in
`main/database/projects/scope.ts` is re-sequenced to the same order: it
reads `backing_session_id` first, takes the session-control lock, refuses
the project's pending Studio intents (approval rows), then locks and
updates `projects` and bumps `scope_version`. Documented next to
`session-control-lock.ts:21` and pinned by a lock-order test.

#### Durable state (migration 086, `approval_intents` only, additive)

- `origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent',
  'studio_mcp'))`.
- `project_id TEXT NULL REFERENCES projects(id)` with NO cascade (a
  deleted project must leave a refused audit row, never a vanished one;
  project deletion is a later stage and will refuse first, delete
  second).
- `scope_version_at_enqueue INTEGER NULL`, `request_digest TEXT NULL`,
  `dispatch_generation_at_enqueue BIGINT NULL` (Studio only; see the
  dispatch gate).
- `refusal_reason TEXT NULL CHECK (refusal_reason IN ('lock',
  'disconnect', 'cancelled', 'project_deleted', 'scope_changed',
  'vex_quit'))`, set together with `decision = 'rejected'` by the
  refusal CAS; `decision_reason` carries the human sentence.
- `settlement JSONB NULL` (the whole `ToolResult` of the dispatched
  call, output included, never cut) and `settlement_bytes INTEGER NULL
  CHECK (settlement_bytes >= 0)`; no size ceiling (whole-result rule).
  Serialization contract: one owner (`approval-runtime/studio/
  settlement-codec.ts`) produces a JSON-safe projection of `ToolResult`
  with every field preserved and a codec version tag; a non-JSON `data`
  value is encoded explicitly under a tagged wrapper (never silently
  dropped); if serialization or the write
  fails AFTER dispatch, the intent is marked `indeterminate` through the
  existing CAS, the textual `output` is preserved wherever it can be,
  and dispatch is never retried. `settlement_bytes` equality with the
  stored body is proven in the codec test, not by a constraint.
- Partial index `(project_id) WHERE origin = 'studio_mcp' AND decision IS
  NULL` for the refusal sweeps.
- `session_id` stays NOT NULL: a Studio intent carries the backing
  session id, which also keys the existing session control lock.
- `approval_queue.source` is set to `'studio_mcp'` on enqueue (column
  exists, default `'chat'`).

#### Request digest (one owner)

`tool-call-envelope.ts` gains `computeRequestDigest(envelope)`: sha256
over the canonical JSON of the envelope `buildApprovalToolCall` already
produces (command, args with sorted keys, `vex.manifestFingerprint`).
Stored at enqueue; recomputed from the stored `queue.tool_call` at
commit and compared. No second canonicalizer.

#### Enqueue seam

`approval-runtime/enqueue.ts`: `enqueueApprovalIntent` extracted
move-only from `turn-loop-tool-batch/approval-stop.ts:120-254`, taking a
narrow record `{sessionId, missionId, missionRunId, permission,
toolName, toolArgs, toolCallId, result, toolContext, trustedPreview?,
trustedExpiresAt?, origin, projectId?, scopeVersion?, requestDigest?}`
and an injected pre-insert gate callback. The turn loop passes
`acquireSessionControlLock` + `gateOnOperatorStopWithClient` (today's
behaviour, pinned); Studio passes `acquireSessionControlLock` on the
backing session + a project gate (project row `FOR SHARE`, exists,
`scope_version` equals the scope the call was admitted with, Vex
unlocked). One transaction as today; `missionRunsRepo.updateStatus`
stays behind `missionRunId !== null`; `expiresAt = min(now + 1 h,
trustedExpiresAt)` unchanged. Emit-after-commit reuses
`emitMissionUpdate({sessionId: backingSessionId, missionId: null, kind:
"approval_enqueued"})` so the global inbox refreshes through the
existing `useGlobalApprovalsLiveSync`; the naming stretch is recorded,
a second bus is not justified.

#### Decision and dispatch (engine)

- `snapshot/build.ts` loads `origin`, `project_id`,
  `scope_version_at_enqueue` in the locked snapshot. The existing
  `sessions.permission` drift check stays (mirror); for `studio_mcp` it
  additionally locks `projects` (`FOR UPDATE`) and rejects in-tx when
  the project is missing (`project_deleted`), `scope_version` moved
  (`scope_changed`) or `projects.permission` is more restrictive than
  `permission_at_enqueue` (policy drift, existing outcome).
- `continuation.ts`: `claimResumeContinuation` returns `{kind:
  "studio_mcp", approvalId, projectId, backingSessionId}` for
  `origin = 'studio_mcp'`; it takes NO session lease (there is no agent
  turn), so `deferred_busy` cannot happen for Studio; exclusivity is the
  existing per-intent `casMarkDispatchingWith`.
- `post-tx/dispatch-approved/studio.ts` (sibling of the agent path,
  same ordering as `dispatch-approved.ts:16-26`): claim the dispatch
  slot under the stop gate (same transaction adds the project re-check
  above and `checkApprovalManifestIdentity` plus `request_digest`
  equality), build the context with A2's `buildProjectToolContext(scope
  from projects + project_wallets, {approved: true, approvalId})`, dispatch
  through A2's `admitStudioCall` (same admission as the original call;
  `executeProtocolTool` re-runs the prequote gate), then
  `commitStudioSettlement`: CAS `dispatching -> succeeded | failed`
  (`commitExecutionResultWith`, fenced), write `settlement` and
  `settlement_bytes`, NO transcript message, NO `result_message_id`.
  Dispatch failure and `indeterminate` use the existing lifecycle CAS
  helpers; `markExecutionStatusWith` (unconditional) is never used.
- `runResumeAfterDecision` gains the `studio_mcp` case: it does not run
  a turn; after the settlement commit it emits on a new bounded bus
  `engine/runtime/studio-settlement-bus.ts` (`{approvalId, projectId,
  outcome: "settled" | "rejected" | "dispatch_failed" |
  "indeterminate"}`, ids and enum only, never content) and does not
  touch `resume_consumed_at`.
- One origin-aware rejection dispatcher
  (`approval-runtime/post-tx/reject-dispatch.ts`): every generic
  decision entrypoint that today calls `applyRejectSideEffects`
  (`prepareApprove`'s `expired_in_tx` and policy-drift outcomes,
  `prepareReject`, `expireApproval`, the sweep) routes through it; for
  `origin = 'agent'` it is the existing `applyRejectSideEffects`
  unchanged; for `origin = 'studio_mcp'` it writes the refusal or
  expiry settlement and emits the settlement event only, never a
  transcript message, never `result_message_id`, never a continuation
  claim. The broker timer and the explicit refusal primitive call the
  same Studio branch. Tests: late Approve after expiry, manual Reject,
  session-mirror permission drift and project-permission drift on a
  Studio row each produce settlement + event and no transcript row.
- Origin-aware predicates: `getIncompleteLifecycle`,
  `getPendingLifecycleForSession`, the resume-eligibility predicate and
  the reconciler scans filter `origin = 'agent'`; a test proves a Studio
  row never enters them.

#### Studio dispatch gate (engine-owned, durable, the lock bridge)

Codex turn 3 showed an in-memory generation is not a linearization
point: a continuation can read generation N, await the dispatch-slot
CAS, the user locks Vex (scrub + in-memory invalidate to N+1), and the
pending CAS still commits. The gate is therefore DURABLE:

- Migration 086 adds a single-row table `studio_runtime_gate`
  (`id INTEGER PRIMARY KEY CHECK (id = 1)`, `dispatch_generation BIGINT
  NOT NULL DEFAULT 1 CHECK (dispatch_generation >= 1)`, `updated_at`),
  seeded with one row.
- The Studio enqueue records `dispatch_generation_at_enqueue` (new
  column on `approval_intents`, nullable, Studio only) read in its own
  enqueue transaction.
- The Studio dispatch-slot claim is ONE statement in the slot
  transaction, conditioned on the generation:
  `UPDATE approval_intents SET execution_status = 'dispatching',
  dispatch_started_at = NOW() WHERE approval_id = $1 AND execution_status
  = 'not_started' AND dispatch_generation_at_enqueue = (SELECT
  dispatch_generation FROM studio_runtime_gate WHERE id = 1 FOR SHARE)`,
  so a committed slot claim is DEFINED as "dispatch began before lock"
  and a claim after the generation advance returns zero rows and is
  refused with reason `lock`.
- Lock: `lockSecretSession` keeps the synchronous scrub and signing
  revocation first (unchanged); it then calls the engine-owned
  `advanceStudioDispatchGeneration()` (`approval-runtime/studio/
  dispatch-gate.ts`), which is the persisted `UPDATE studio_runtime_gate
  SET dispatch_generation = dispatch_generation + 1`. In the window
  between the scrub and that commit a claim may still commit, but the
  signing capability is already revoked, so the dispatch fails closed at
  the signer and is recorded as `failed` or `indeterminate` through the
  existing CAS; nothing can broadcast. The in-memory mirror of the
  generation is kept only as a fast pre-check for refusing waiters, never
  as the authority.
- Unlock calls the same advance (monotonic increment; a pre-lock
  generation is never reused, so a pre-lock intent can never be
  dispatched after re-unlock without a fresh enqueue). Pinned: `reset`
  increments, never resets.
- Registered at app startup next to the other engine registrations.
- Tests: scripted-client tests for the statement shape and the
  zero-rows refusal; the interleaving test (advance after the
  continuation read the generation and after `assertCurrent`, before the
  slot statement commits) proven on a two-connection live-Postgres
  integration test that is a MERGE GATE for A3, not an optional check
  (the owner runs it with the migration on the dev database; the report
  names it until it has run).

#### Refusals (all CAS to terminal before any waiter is released)

One engine primitive `refusePendingStudioIntents(client, {projectId |
all}, reason)` modelled on `apply-user-stop.ts:164-181`
(`SELECT ... FOR UPDATE` then `rejectWith` + `markDecisionWith` with
`refusal_reason`), and one main-side owner `vex-app/src/main/studio/
approval-refusals.ts` that calls it from:
- `lockSecretSession`: the scrub and the signing-capability revocation
  stay SYNCHRONOUS and first, exactly as today (`session.ts:239`); it then
  advances the durable Studio dispatch generation through the
  engine-owned gate, after which no Studio dispatch-slot claim can
  commit (a claim that commits in the scrub-to-advance window fails
  closed at the revoked signer); only THEN the durable refusal (reason `lock`) runs and waiters
  are released. If the database is unavailable at that moment the
  dispatch stays fail-closed on the generation and the durable refusal
  is reconciled when database access returns (a test pins: lock with a
  failing refusal still scrubs synchronously and blocks dispatch);
- the MCP host on transport EOF (`disconnect`) and on
  `notifications/cancelled` (`cancelled`); A1 showed no installed client
  sends cancellation, so EOF is the load-bearing path;
- `updateScope` in `main/database/projects/scope.ts`, in the same
  transaction that bumps `scope_version` (`scope_changed`), in the
  global lock order above (session-control lock first, then the
  approval rows, then the project row);
- the ordered quit cleanup before Compose stops (`vex_quit`);
- project deletion (later stage) with `project_deleted`.
A decision arriving after a refusal is answered by the real state
through the existing cached-decision path (`build.ts:51-60`).

#### Broker (main)

`vex-app/src/main/studio/approval-broker.ts`: in-memory
`Map<approvalId, waiter>` with a hard cap (reject new waiters above it
with a typed error), idempotent `settle`, a per-waiter timer at
`expiresAt` that performs the expiry through `expireApproval`, which now routes through the
origin-aware rejection dispatcher (Studio branch: decision CAS + Studio
settlement event, NO transcript message, NO continuation claim) and
releases the waiter with `expired`; the 5-minute sweep takes the same
Studio branch for `origin = 'studio_mcp'` rows and stays the durable
floor, and an `AbortSignal` path for EOF/cancel that refuses first,
releases second. Settlement arrives through `main/agent/
studio-settlement-bridge.ts` (subscribes the engine bus, like
`mission-update-bridge.ts`, registered in `globalCleanup`); the broker
then reads the settlement row by id and hands the whole `ToolResult`
to the waiter. Durable first, waiter second: a lost waiter leaves a
correct row and the UI shows it.

`vex-app/src/main/studio/approval-service.ts`: `runStudioCall(scope,
call, {signal, onProgress})` composes A2's `executeStudioTool`, the
enqueue (when `pendingApproval`), the broker wait with progress ticks
every 2 s, and maps outcomes to typed results: settled (whole result),
declined (`decision_reason`), expired, refused (`refusal_reason`),
dispatch_failed, indeterminate (pending, reconciled by the existing
sweep; the agent is told the outcome is unknown and must not retry).
A4's tool handler calls only this service.

#### Tests (required)

- Enqueue seam: move-only for the turn loop (the existing
  single-transaction and emit-after-commit tests stay green
  unchanged); Studio enqueue writes origin, project id, scope version,
  digest, source, and emits `approval_enqueued` with the backing session.
- Snapshot: project missing, scope moved, project permission downgraded
  each reject in-tx with the named reason; the mirror check still runs.
- Continuation: `studio_mcp` arm takes no lease; agent arms unchanged.
- Dispatch: digest mismatch and fingerprint mismatch refuse before
  dispatch; wallets come from `project_wallets` (a drifted mirror is
  ignored); prequote gate re-runs; settlement stored whole with bytes;
  no transcript message; CAS fence on `dispatching`.
- Refusals: each of the six reasons performs the CAS before the waiter
  is released (ordering asserted), a decision after refusal returns the
  real state, a refusal after settlement is a no-op.
- Broker: exactly-once settle, lost waiter leaves the row correct,
  expiry timer CAS, cap, idempotent release, cleanup on quit.
- Lifecycle: a Studio row never appears in `getIncompleteLifecycle`,
  `getPendingLifecycleForSession` or the reconciler scan.
- Lock order: approve versus `updateScope` under the documented order
  cannot deadlock: a scripted-client test asserts the lock statement
  sequence in both paths, and a two-connection live-Postgres integration
  test (under the repository's integration suite, env-gated like the
  existing one; if no such convention exists for this table it is named
  as a deferred merge gate in the report) proves no blocking cycle.
- Dispatch gate: a generation advance before the slot statement makes
  the claim return zero rows (scripted); the interleaving advance after
  the generation read and before the slot statement commits is refused
  on live Postgres (merge gate); advance after commit is a no-op for
  that intent; unlock advances monotonically and never resurrects a
  refused intent; lock with the database unavailable leaves waiters
  blocked or reconciled and dispatch fails closed at the revoked signer.
- Every Studio terminal decision emits the settlement bus exactly once;
  every agent lifecycle and reconciler query filters `origin = 'agent'`.
- Lock: with a failing durable refusal, `lockSecretSession` still scrubs
  synchronously and a dispatch-slot claim after lock is refused by the
  generation.
- Expiry: the broker timer and the background sweep both take the Studio
  branch for a Studio row (no transcript message, no continuation).
- Settlement codec: round trip of every `ToolResult` field, explicit
  encoding of non-JSON `data`, serialization failure after dispatch
  becomes `indeterminate` without retry, `settlement_bytes` equals the
  stored body.
- Contract pins: `approvalSummaryDtoSchema` reads a Studio row (origin
  surfaced as a nullable field only if the UI needs it; otherwise
  untouched), `result-surface` codes, IPC reconciliation unchanged.

#### Out of scope

Transport and SDK (A4), MRTR, installer, UI.

### Stage A4 - Inventory, server, ToolSearch, bridge, host

Files: `src/vex-agent/mcp/inventory/*`, `src/vex-agent/mcp/server.ts`,
`src/vex-agent/mcp/tool-search-export.ts`, `src/vex-agent/mcp/
instructions.ts`, `vex-app/src/main/studio/mcp-host.ts`, `bridge/` (Go
module, CI cross-compile, `extraResources`, signing), lints, snapshots,
generated docs with CI diff gate.
Verification: MCP Inspector against the bridge (list, search, read,
mutation with card), `claude mcp add`, a Codex session, list equality
across projects and env, `alwaysLoad` snapshot, lints green.

### Stage A4 - detailed spec (v3 after Codex plan review turn 2)

Two builder arcs: A4a (server, inventory, host, contract) and A4c (Go
bridge, packaging, real clients). Each arc has its own plan-gate turn;
the endpoint/handshake contract and the Windows trust mechanism are
frozen in A4a because both sides of the wire depend on them.

#### A4a - server, inventory, instructions, socket host

1. Dependency: `@modelcontextprotocol/server@2.0.0` plus its
   `@modelcontextprotocol/core@2.0.0`, pinned EXACT in the root
   `package.json`. `legacy: 'serve'`, never `'reject'`. FIRST TASK of
   the arc: enumerate the installed `.d.ts` (provider-depth decree) and
   pin in writing: the era-owning entry's custom-transport shape; that
   `serveStdio` may construct a modern `server/discover` probe instance
   BEFORE the legacy fallback, so the server factory must be
   SIDE-EFFECT-FREE and probe disposal gets a regression test; clean
   EOF must invoke the custom transport's `onclose` (that is what
   aborts protocol request signals); progress and cancellation flow
   through `ctx.mcpReq`, never an ad hoc registry; JSON Schema inputs
   go through the package's `fromJsonSchema` adapter (Vex schemas are
   JSON Schema; `registerTool` expects Standard Schema) - no schema
   rebuilding.
2. Seam contract: `StudioCallOutcome` and `RunStudioCallOptions` move
   to engine `src/vex-agent/mcp/outcome.ts`; approval-service imports
   them. The injected executor is `runCall(projectId, call, options)` -
   PROJECT ID, NOT SCOPE. A connection-scoped scope would be a stale
   authorization cache: a connection opened under `permission: "full"`
   would keep executing mutations after the project turned restricted,
   and no approval row would exist for A3 to protect. The handshake
   binds ONLY `projectId`; the authoritative per-call load has ONE
   owner, `runStudioCall`, which loads the scope at the admission of
   EVERY call - `vex_ToolSearch` included - through ONE ATOMIC
   SNAPSHOT: a single SQL statement joining `projects` and
   `project_wallets` (or a read-only REPEATABLE READ transaction),
   then wallet-drift validation, then `projectScopeSchema`. Two
   separate queries are forbidden: they can pair version N with the
   wallets of N+1 during `updateScope`. The host's handshake existence
   check is explicitly NON-AUTHORITATIVE and its result is discarded.
   The snapshot is the linearization point for a call racing a scope
   edit: a call admitted under version N runs under N;
   RESTRICTED-MODE MUTATIONS remain protected by the A3 enqueue and
   dispatch gates, which re-prove the version (full-mode calls
   deliberately bypass A3, which is why the per-call snapshot is the
   load-bearing check). `instructions` stay generic (no permission
   parameterization) so they cannot go stale. Tests: full to
   restricted on an open connection; wallet edit on an open
   connection; deleted project; wallet drift; and a racing edit proven
   on TWO live PostgreSQL connections showing no mixed scope.
3. Inventory (`src/vex-agent/mcp/inventory/`): one `StudioTool` record
   per exported tool (source: the A2 export-scope predicate).
   `publicName` from the manifest at runtime; authored `title` in ONE
   reviewed artifact (`inventory/titles.ts`); descriptions and protocol
   input schemas REUSE the canonical projection in
   `registry/injected-protocol-tools.ts` (~line 171, including
   cross-field constraints) - extract, do not duplicate. Annotations
   pin O7 LITERALLY: `readOnlyHint = actionKind === "read"`;
   `destructiveHint = actionKind in {user_wallet_broadcast,
   destructive}`; `idempotentHint` and `openWorldHint` OMITTED; never
   derived from `mutating`. `alwaysLoad`
   (`_meta["anthropic/alwaysLoad"]`) pinned by snapshot to exactly the
   hot set. Canonical order OWNED BY THE INVENTORY: internal tools
   byte-wise by name, then protocol tools byte-wise by (namespace,
   name); comparator is codepoint comparison, locale-free, and a lint
   pins every exported name ASCII. A2's `listExportedTools` stays a set
   source; the inventory is the one ordered surface.
4. `src/vex-agent/mcp/instructions.ts`: 512-character self-contained
   safety prefix (approval rule, quote-before-execute, decimals), total
   within 2000 bytes, GENERIC (no per-project content, see item 2);
   both bounds lint-gated. Exact instruction bytes tested on BOTH eras
   (legacy initialize and the modern path).
5. `src/vex-agent/mcp/server.ts`: `createStudioMcpServer(deps)`, one
   per connection, factory side-effect-free (see item 1). ONE injected
   dep: `runCall(projectId, call, options)` - the scope loader lives
   inside `runStudioCall` (item 2), so the server holds no second
   loader and no scope. Handlers register the inventory plus the
   ToolSearch adapter. `server-result.ts` pins the EXACT projection of
   `StudioCallOutcome` to `CallToolResult`:
   - `completed`: content carries the COMPLETE `result.output`, never
     cut; `isError: true` exactly when `result.success === false`
     (configuration and handler failures included); a successful
     result omits `isError`. O5 stays deferred: internal `data`,
     approval previews and policy metadata are NEVER serialized as
     structured MCP output.
   - `declined | expired | refused | dispatch_failed | not_queued`:
     `isError: true` with the typed sentence.
   - `indeterminate`: `isError: true` with the DO-NOT-RETRY sentence
     FIRST (MCP has no machine no-retry annotation; real-client retry
     behavior is an A4c verification item).
   Exhaustive table tests over every outcome kind and both `success`
   values, `configuration_unavailable` included. Progress maps
   `onProgress` to `ctx.mcpReq` progress when the client sent a token.
   CANCELLATION CAUSE is a trusted typed seam, never the
   client-provided reason string: `RunStudioCallOptions` gains a typed
   cause channel (`cancelCause: () => "cancelled" | "disconnect" |
   "lock" | "vex_quit"` or equivalent) set by the OWNER of each
   teardown - MCP cancellation notification -> `cancelled`; peer FIN
   or socket loss -> `disconnect`; host lock teardown -> `lock`; app
   quit -> `vex_quit`. The broker's withdrawal path consumes the typed
   cause so the durable `refusal_reason` matches it, and
   host-initiated close uses the SAME reason as the global refusal
   pass so their CAS race cannot produce a misleading settlement.
   Tests assert the durable `refusal_reason`, not only a single waiter
   release.
6. Endpoint and handshake CONTRACT, frozen now, in a dedicated
   reviewed doc `studio-mcp/bridge-endpoint-contract.md` plus GOLDEN
   VECTORS (one JSON fixture consumed by the TS tests in this arc and
   the Go tests in A4c). It defines, exactly:
   - Endpoint derivation per OS: Linux `$XDG_RUNTIME_DIR/
     vex-studio-<hash>.sock`, falling back (unset, not a directory,
     not owned by the user, or mode wider than 0700) to
     `<tmpdir>/vex-studio-<uid>/vex-studio-<hash>.sock` inside a 0700
     directory this host creates and verifies; macOS the tmpdir form;
     `<hash>` = first 12 hex chars of SHA-256 over the realpath of
     the VEX CONFIG DIRECTORY (both processes derive that directory
     independently from the platform convention in
     `src/config/paths.ts`; the Go bridge re-implements the same
     derivation from the golden vectors and needs no config parsing -
     the projects root was rejected as hash input because the
     standalone bridge has no validated way to learn it). Env override
     `VEX_STUDIO_SOCKET` wins everywhere but is VALIDATED BEFORE
     BIND: absolute Unix path or valid Windows pipe syntax; on Unix
     the parent directory owned by the current user, mode 0700, no
     symlink traversal on the final component; path length asserted;
     the same stale/live endpoint checks as the derived path. An
     override that fails validation refuses startup of the host with
     the named cause - it must not silently bypass the P4 trust
     boundary.
     The `sun_path` ~104-byte limit is asserted at build time of the
     path. This is a VEX adaptation, not the VS Code scheme verbatim
     (VS Code's macOS static handle uses the caller-supplied userData
     dir): ownership, mode, symlink and stale-entry behavior get their
     own tests. Stale socket removal is NEVER a blind unlink: verify
     the parent's ownership and mode, `lstat`, unlink only
     `S_ISSOCK`, and refuse to start on a LIVE endpoint (connect
     probe succeeds -> another Vex owns it).
   - Handshake with ACKNOWLEDGEMENT: bridge sends one line
     `{"v":1,"projectId":"..."}` (max 4096 bytes, 5 s deadline), then
     WAITS; host answers `{"ok":true}` or
     `{"ok":false,"code":"...","message":"..."}` (typed codes:
     `unknown_project`, `incompatible_version`, `locked`,
     `at_capacity`, `malformed`) and on failure closes. Only after the
     ack does the bridge read and forward MCP stdin. The host parser
     is ALSO remainder-preserving: bytes after the handshake newline
     in the same chunk are fed to the MCP transport, so a coalesced
     handshake+initialize cannot lose bytes even from a
     non-conforming bridge. Version rule: `v` is a major; unknown
     major -> `incompatible_version` with the supported value named.
   - Framing: newline-delimited JSON both directions after the ack;
     max inbound MCP line 4 MiB (typed over-limit error, connection
     closed); close behavior: FIN propagates as transport `onclose`;
     shutdown deadline 5 s then destroy.
7. `vex-app/src/main/studio/mcp-host.ts`: the listener exists only
   while the secret session is unlocked (decision kept after review:
   an always-up listener widens the locked attack surface merely for
   diagnostics; the combined "not running or locked" bridge message is
   the accepted trade). LOCK ORDER, matching shipped A3
   (`session.ts`): (1) synchronous scrub and signing revocation
   FIRST, unchanged; (2) mark the host locked, close the listener,
   synchronously destroy registered sockets; (3) the existing provider
   reset, generation advance and durable refusal sequence. Never await
   per-connection EOF refusals before the generation advance; the test
   pins CALL ORDER, not eventual cleanup. Unlock starts the listener
   after the A3 readiness barrier logic reports ready.
   BOUNDS, exact and enforced on the consumed object: 16 established
   connections and connection 17 is REJECTED (typed handshake refusal;
   NO eviction - an approval-blocked connection has no traffic and is
   not idle); 4 concurrent handshake-pending sockets (oldest pending
   dropped at 5 s deadline anyway); per-connection in-flight calls 8,
   global 32 (matches the broker cap; excess gets a typed busy tool
   result, not a hang); queued decoded inbound messages per connection
   16 (overflow -> typed error + close); shutdown deadline 5 s.
   OUTBOUND: a high-water mark is only a backpressure threshold
   (`socket.write` buffers past it), so the host owns a real queue:
   ONE serialized send owner per connection; a FINITE pending-message
   count; AT MOST ONE pending progress notification per request,
   coalesced (a new progress replaces the queued one) and never
   overlapping a blocked send - approval progress fires every two
   seconds and a stalled `drain` must not accumulate an hour of them;
   final responses are never dropped and never cut (they wait, they
   do not coalesce); all pending sends settle on close. A stress test
   with a blocked writable side and repeated approval progress proves
   the queue size stays constant.
8. Windows (AMENDED by owner decision, revision-log item 47, built in
   the A4c fix arc): the host serves `\\.\pipe\vex-studio-<hash>`
   via plain `listen` with NO custom ACL, the VS Code pattern 1:1
   (evidence in item 47); no unlink lifecycle, connect-probe-only
   stale check; the bridge dials via `os.OpenFile` with the
   `halfCloseOrDeadline` seam replacing CloseWrite on pipes. The
   Windows transport is RUNTIME-DISABLED behind
   `WINDOWS_TRANSPORT_PROVEN = false` on both owners (revision-log
   items 50, 52); it refuses with `windows_pending_platform_proof`.
   Flipping the flag requires the FULL eight-item matrix in contract
   section 1.6 - including foreign-user pipe-squatting, server
   impersonation level, and a host-authentication check
   (GetNamedPipeServerProcessId + server token SID) - run on the
   required `bridge-windows` CI job. Linux proves derivation, syntax
   and plan shape only.
9. Lints and gates (`src/__tests__/vex-agent/mcp/`): description
   budget (first 2000 bytes carry risk class and preconditions),
   annotation completeness per the O7 pin, ASCII-name lint,
   exported-surface snapshot EXTENDING the existing toolsnaps helpers
   (`src/__tests__/vex-agent/tools/toolsnaps.test.ts`), `alwaysLoad`
   snapshot equal to exactly the hot set, list equality across
   projects and env, instructions-size lint, generated
   `studio-mcp/exported-tools.md` with a package-script diff gate in
   CI, and a bundled-main check that the packaged JavaScript contains
   no unresolved `@modelcontextprotocol/*` import. Titles file,
   annotation table, hot-set names and the raw wire snapshot are
   reviewed artifacts in the same change.
10. Tests: unit and in-memory as before, PLUS one REAL socket-level
    contract test: a raw reference client through the actual
    `net.Server`, handshake parser, `socket-transport` and the
    era-owning entry, covering legacy initialize and current-era
    discovery; modern probe then legacy fallback; exact instruction
    bytes in both eras; handshake+initialize coalescing; clean EOF
    aborting one blocked call exactly once; `notifications/cancelled`;
    invalid and oversized JSON; backpressure and drain; lock teardown
    order; raw `tools/list` equality (not only the inventory builder
    snapshot).

#### A4c - Go bridge, packaging, real clients (v2 after Codex plan review turn 1)

1. `bridge/` Go module at the repo root, PURE STDLIB, layout
   `bridge/cmd/vex-mcp/main.go` + `bridge/internal/{configdir,endpoint,
   handshake,relay}/`, table tests consuming the SAME
   `bridge-endpoint-vectors.json`. Toolchain: EXACT pinned Go version
   (in `bridge/go.mod` `toolchain` directive and the build script), not
   a minimum. `CGO_ENABLED=0`, pinned `GOAMD64`/`GOARM64` baselines,
   `-trimpath` and reproducible build flags. The machine currently has
   no `go` executable: an OWNER-APPROVED toolchain install precedes the
   build arc.
2. CONFIG-DIR RESOLVER PARITY, the highest-divergence seam, closed at
   the source: the golden vectors gain a `configDir` section covering
   `VEX_CONFIG_DIR` (unset, empty, relative, absolute, trailing
   separator), `XDG_CONFIG_HOME` and `APPDATA` (same cases), the
   home-directory fallback per OS, and error cases. DECISION: both Node
   owners (`vex-app/src/main/paths/config-dir.ts` and
   `src/config/paths.ts`) are HARDENED first - an empty or relative
   `XDG_CONFIG_HOME`/`APPDATA` is treated as unset (today `??` lets an
   empty string produce the RELATIVE path `"vex"`); this matches the
   XDG Base Directory rule that an empty value must be ignored, and the
   contract is regenerated BEFORE the first bridge ships. Hash rules
   frozen in the contract: SHA-256 over the exact UTF-8 bytes, no BOM,
   no newline, no case folding, no Unicode normalization, no separator
   conversion; on successful symlink evaluation hash the RESOLVED path
   (Go `EvalSymlinks` cleans successful results - a macOS
   `/var -> /private/var` vector pins parity); on failure hash the
   ORIGINAL literal with NO `filepath.Clean`; the temporary directory
   is never realpathed.
3. Bridge behavior: derive endpoint (same validation rules for the
   override), bounded dial timeout, send the handshake line, bounded
   ack read with a deadline, STRICT ack semantics tolerant of future
   optional fields, then a content-blind byte relay. Typed failures:
   every ack refusal code and every local failure maps to ONE
   actionable, length-bounded, SANITIZED stderr line (unknown refusal
   text never echoed raw) and a distinct non-zero exit code, tabled in
   the contract doc. NO RETRY (kept after review): a retry would blur
   the locked-listener lifecycle; the only future reconsideration is
   one bounded pre-handshake retry for ENOENT/ECONNREFUSED, never
   after an ack or for locked/malformed/capacity/version refusals.
   RELAY SHUTDOWN STATE MACHINE, explicit and asymmetric: stdin EOF ->
   `UnixConn.CloseWrite`, bounded drain of socket to stdout, exit 0;
   socket EOF -> close stdout and RETURN WITHOUT WAITING for a blocked
   stdin reader; stdout failure or signal -> destroy through one owner.
   Required tests: peer that never acks; socket EOF with stdin open;
   stdin EOF with a delaying peer; blocked stdout; malformed ack with
   embedded newlines; signal teardown.
4. Windows: compile and package the binary; parse and vector-test
   pipe syntax; at RUNTIME refuse locally with
   `windows_pending_platform_proof` BEFORE any dial, including a valid
   pipe override, while `WINDOWS_TRANSPORT_PROVEN = false`. The
   build-tagged `dial_windows.go` uses `syscall.CreateFile` with
   `FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT |
   SECURITY_IDENTIFICATION`; the host-authentication SID check and the
   squatting/impersonation tests are REQUIRED-before-flip items in
   contract 1.6, not shipped runtime code. (Superseded note, kept for
   history: the earlier plan text said a pipe transport must come from
   a future arc after the ACL decision, never
   accidentally from this stdlib arc).
5. Packaging identity FROZEN: Electron `x64` -> Go `amd64`,
   `arm64` -> `arm64`, `mac/win/linux` -> `darwin/windows/linux`;
   packaged path `resources/bridge/vex-mcp` (`.exe` on win). Targets =
   the union of both electron-builder profiles (production four + dev
   win/linux arm64; we build the arm64 variants). RELEASE WIRING IS IN
   SCOPE, not deferred: electron-builder 26.8.1 only WARNS on a missing
   `extraResources` source and packages on, so a tag could ship Vex
   without its bridge. Every packaging job (release workflow AND PR CI)
   builds the required bridge architecture BEFORE electron-builder;
   a fail-closed preflight before signing asserts the artifact exists
   with the right executable format and architecture; an `afterPack`
   hook re-inspects the copied binary. macOS: the bridge is listed
   under `mac.binaries` (electron-builder's supported mechanism for
   signing embedded CLIs) with `codesign --verify` evidence; Windows
   keeps the recursive Authenticode check plus a bridge-path-specific
   assertion.
6. Verification: Go unit tests against the shared vectors; a TS
   conformance test spawning the BUILT binary against the real host
   (handshake ack, coalesced write, large-frame relay integrity, EOF
   both directions, refusal codes on stderr + exit codes); at least one
   real-client smoke runs the binary EXTRACTED FROM A PACKAGED APP,
   not `bridge/dist`. Real clients per stage A-test: MCP Inspector,
   `claude mcp add` with a live session, one Codex session, list
   equality across two projects. The approved restricted-mutation test
   uses a NON-FINANCIAL local mutation (`WalletTrackToken`) with
   cleanup; the `indeterminate` retry probe uses a CONTROLLED result,
   never induced uncertainty around a real broadcast.

### Stage A4b - Generic signing tools (owner decision 2026-08-24: FULL scope, EVM + Solana in one arc)

#### Detailed spec (v3 after Codex plan review turn 2)

TWO family-specific pairs in ONE arc - `WalletEvmTransactionPrepare/
Confirm` and `WalletSolanaTransactionPrepare/Confirm` - sharing one
policy, persistence, preview and execution layer. Two pairs because
`ToolDef.JsonSchema` cannot express a top-level discriminated union and
the families share almost no parameters; the shared layers are modules,
not a merged manifest.

1. NEW TABLE, migration 087: `wallet_transaction_intents` - its own
   discriminated payload, lifecycle, digest and reconciliation state.
   NOT a `kind` column on `wallet_intents`: that table is
   transfer-shaped (mandatory `to_address`/`amount`), its reads and CAS
   predicates do not filter by kind, and `WalletSendConfirm` checks
   network but not kind, so a transaction intent could be consumed by
   the transfer confirm. Columns: id, session_id, wallet_address,
   family (`eip155 | solana`), chain_alias, payload_json (strict
   per-family schema), proposal_digest (VERSIONED SHA-256 over EVERY
   sign-relevant field: resource identity, family, wallet address,
   chain/chainId, canonical payload or message bytes, decoded effects,
   the mandatory fee bounds, blockhash evidence and expiry - a digest
   over payload bytes alone cannot detect drift in the authority
   fields), preview_json, fee_bounds_json (MANDATORY, see 4),
   status (`pending | consuming | executed | failed |
   broadcast_unconfirmed | superseded_unproven | audit_failed |
   cancelled | expired`),
   expires_at, consumed_at, tx_hash, failure fields, created_at.
   Session-ownership predicate on every mutation and lookup;
   client-bound writers (C7); a shared lifecycle helper extracted with
   `wallet_intents` where the state machine genuinely coincides. The
   compaction money-state gate gains this table's `pending`,
   `consuming` AND `broadcast_unconfirmed` rows plus any state
   carrying a staged hash with an unresolved outcome (the existing
   gate counts `consuming` for exactly this reason). The spec carries
   an EXACT transition/evidence table enforced by database CHECKs; an
   explicit `activity_id` column links each intent to its activity
   row; ONE transaction claims the intent (`pending -> consuming`) and
   creates/links the pending activity row, so a crash cannot strand an
   unlinked claim; recovery covers linked `consuming` rows, not only
   `broadcast_unconfirmed`; terminal writes to the two rows are
   coupled atomically or through a repairable CAS pair.

   THE LIFECYCLE TABLE (wallet_transaction_intents WTI, agent_activity
   AA, protocol_executions PE; every transition is a CAS on the named
   from-status; evidence rules are DB CHECKs; "gate" = blocks the
   money-state gate):

   | # | Trigger | WTI | AA | PE | Evidence | Gate |
   |---|---------|-----|----|----|----------|------|
   | T1 | prepare | insert `pending` | none | none | proposal_digest, payload, fee bounds, expiry; tx_hash NULL | pending BLOCKS |
   | T2 | confirm claim, ONE tx under the session lock | `pending -> consuming` (CAS: pending, owner session, not expired, digest match) | insert `pending`, kind `transaction` | insert `intent`, linked; `activity_id` stamped on WTI | no hash yet | consuming BLOCKS; PE `intent` BLOCKS |
   | T3a | confirmed return | `consuming -> executed` | `-> confirmed` | `-> completed` | tx_hash REQUIRED | all release |
   | T3b | chain_failed return | `consuming -> failed` | `-> reverted` | `-> completed` | tx_hash REQUIRED | release |
   | T3c | pre_broadcast_failed return | `consuming -> failed` | `-> failed` (pre-broadcast vocabulary) | `-> completed` | tx_hash NULL REQUIRED | release |
   | T3d | confirmation_unknown return (a NORMAL handler return) | `consuming -> broadcast_unconfirmed` | stays staged-with-hash | `-> completed` (the writer completes PE on EVERY normal return, ambiguous included) | tx_hash REQUIRED | WTI BLOCKS |
   | T4a | crash recovery, linked `consuming`, NO staged hash | `-> failed` ("crashed before broadcast"; staging precedes broadcast, so no hash proves no broadcast) | `-> failed` | `-> completed` | hash NULL | release |
   | T4b | crash recovery, linked `consuming`, staged hash present | `-> broadcast_unconfirmed` | unchanged | `-> completed` | hash REQUIRED | WTI BLOCKS |
   | T5 | repair lane reads definitive chain evidence | `broadcast_unconfirmed -> executed` or `failed` | `-> confirmed` or `reverted` | `-> completed` (idempotent; the lanes are EXTENDED to complete a PE still at `intent`) | receipt / signature status | release |
   | T6 | repair lane terminalizes AA `superseded_unproven` | `broadcast_unconfirmed -> superseded_unproven` (NEW WTI status; honest non-failure terminal - `failed` would lie, staying would block forever) | `superseded_unproven` | `-> completed` | hash retained | release |
   | T7 | TTL sweep | `pending -> expired` | none exists | none | none | release |
   | T8 | user/owner cancel | `pending -> cancelled` | none exists | none | none | release |

   `audit_failed` (staged-evidence write failed BEFORE broadcast, so
   nothing signed) releases the gate and flags for investigation.
   Tests pin, on live PostgreSQL for the coupled transitions: the
   ambiguous normal return (T3d), crash after claim+activity creation
   (T4a and T4b), repair to confirmed and to reverted (T5), and repair
   to `superseded_unproven` (T6), asserting all THREE rows after each. Cross-kind negative tests both ways:
   the transfer confirm cannot consume a transaction intent and vice
   versa; transfer IPC/history excludes transaction rows.
2. APPROVAL-BINDING SEAM, one typed contract:
   `PreparedApprovalBinding { preview (validated WalletIntentPreview),
   intentExpiresAt, proposalDigest, resource: { table, intentId } }`.
   The CONFIRM handler REBUILDS the binding from the strictly parsed
   DURABLE intent row (a manual agent or MCP confirm has no in-memory
   prepare result) and attaches it to its `pendingApproval` result;
   BOTH enqueue paths (agent trustedPreview/trustedExpiresAt and the
   Studio seam, which gains the binding parameter) INCORPORATE the
   binding into A3's canonical request digest, so the approval is
   bound to the proposal, not to `{walletFamily, intentId}`. The
   approved resume compares against the APPROVAL-BOUND digest, never
   merely the digest sitting beside the current payload row. The card
   shows the decoded preview and the intent's own expiry on both
   surfaces. Tests exercise the REAL path: confirm handler ->
   `runStudioCall` -> approval row and card content - never a binding
   injected directly into the enqueue seam.
3. DECODE POLICY, fail closed (rule 90; the Pendle decoder is the
   in-repo precedent and it refuses unknown layouts):
   - EVM: unknown selector, malformed layout, or a Permit2 call to a
     non-canonical address REFUSES BEFORE INTENT CREATION. v1 decode
     set: ERC-20 (`transfer/approve/transferFrom/increaseAllowance/
     permit`), Permit2 (`approve/permit/transferFrom`, canonical
     chain-specific addresses only), plain native transfer
     (`data = 0x`). Known routers are UNSUPPORTED IN v1 and refused by
     name (section 2.5 is amended to match); each router ABI is its
     own future safety review. Embedded owner/from, spender,
     deadlines, amounts and receivers are displayed and BOUND in
     criticalArgs.
   - Solana: exact allowed instruction variants, not program names -
     System.transfer, CLASSIC SPL Token `transfer/transferChecked/
     approve/revoke`, ComputeBudget set-limit/price, Memo.
     TOKEN-2022 IS EXCLUDED IN v1 and refused by name: its mint and
     account extensions can impose transfer fees or invoke an external
     transfer-hook program through CPI, and passing a bare transfer
     without loading and enumerating those extensions would sign
     unreviewed economics; supporting it is its own future review,
     exactly like routers. Any other instruction refuses before intent
     creation. Versioned transactions RESOLVE address lookup tables
     before account and program verification; unresolvable ALT
     refuses.
   - EVM `data = 0x` is a plain transfer ONLY when
     `eth_getCode(to) === 0x`, checked at prepare AND at confirm;
     code at `to` makes it a `receive`/`fallback` invocation and it
     refuses as an unsupported contract call. Negative tests prove
     neither open path creates an intent.
4. FEE AUTHORIZATION, MANDATORY effective bounds on every intent.
   POLICY DECIDED: all caps are REQUIRED CALLER INPUTS - no derivation
   invents money policy. A prepare called without them refuses BY NAME
   and the refusal carries the CURRENT network estimates as clearly
   labeled hints, so a coding agent can choose caps and call again;
   the approved bounds are ECHOED in the prepare result, the approval
   card and the confirm result. The bounds per family:
   - EIP-1559: gasLimit, maxFeePerGas, maxPriorityFeePerGas, and the
     resulting max total network fee (displayed in native units);
   - legacy EVM: gasLimit, gasPrice, max total fee;
   - Solana: base fee plus max priority fee in lamports, derived from
     the requested CU LIMIT and CU PRICE (priority cost depends on the
     requested limit, not actual usage).
   Confirm re-simulates, prepares the exact request, and REFUSES
   BEFORE SIGNING if any actual field exceeds the approved bounds
   (the staged-broadcast primitive gains a bounds parameter; it must
   not let `prepareTransactionRequest` fill fees uncapped).
   FORBIDDEN FIELDS, restored explicitly: a caller-supplied `from`,
   fee receiver, or any equivalent redirect field is REFUSED BY NAME
   in both tool families (strict unknown-key rejection alone does not
   satisfy rule 90); named-refusal tests for both.
5. SOLANA BLOCKHASH LIFECYCLE, honest proposal flow:
   - prepare REPLACES the blockhash with a fresh one BEFORE preview
     and approval, so the user approves the exact message that will
     be signed;
   - store the canonical unsigned message bytes, their digest, the
     blockhash and `lastValidBlockHeight`;
   - the Solana intent carries a SHORT displayed expiry derived from
     blockhash validity, not the 10-minute default;
   - confirm rechecks current block height against
     `lastValidBlockHeight`, re-simulates, asserts the message bytes
     are unchanged with only Vex's signature slot differing, then
     signs;
   - a NEW unsigned canonicalization seam owns prepare-time work: it
     accepts the selected PUBLIC KEY (never a decrypted signer),
     verifies the fee payer and the sole-signer shape, installs the
     fresh blockhash BEFORE simulation and approval, and returns the
     canonical message bytes plus height evidence WITHOUT signing.
     Confirm then uses the existing helper's verify-only path with
     known evidence (in the actual helper, known evidence selects
     `verifyKnownBlockhash`; only missing evidence rewrites - the v2
     description of a "rewrite-on-sign path used with evidence" was
     wrong and is corrected here), matching migration 049's
     vocabulary. The Solana intent's displayed expiry is FROZEN at 60
     seconds wall-clock as a cap; `lastValidBlockHeight` remains the
     authority (block height does not convert to an exact timestamp),
     so confirm always rechecks the height regardless of the clock.
6. ACTIVITY AND RECONCILIATION:
   - a NEW truthful activity shape for generic transactions (kind
     `transaction`, role reflecting the decoded effect: approve /
     contract_call / native_transfer / spl_instruction_set), never the
     transfer writer's single-asset-leg shape;
   - staged evidence written BEFORE broadcast (both families); no
     signing when activity creation or staging fails;
   - `confirmation_unknown` maps to the DISTINCT durable status
     `broadcast_unconfirmed` (never `failed`-with-hash). CHAIN
     OBSERVATION OWNERSHIP, decided: the EXISTING EVM and Solana
     activity repair lanes (`sync/agent-activity-repair.ts`,
     `sync/worker.ts`) - which already own receipt and signature
     observation - are EXTENDED to settle linked transaction intents
     when they terminalize the linked activity row. No second
     observer, no new scheduled job; v2's "alongside the approval
     reconciler" is dropped as a duplicate-observer risk. No automatic
     rebroadcast, ever. Migration 087 also updates the engine and app
     ACTIVITY VOCABULARIES and feed mappings so kind `transaction`
     renders truthfully instead of falling through to `spot`
     (`transactions-query-builder.ts`). The equivalent pre-existing
     gap in the transfer path (`failed` with a hash and no reconciler)
     is RECORDED as a named follow-up, not silently fixed in this arc.
7. COMMIT-TIME REVALIDATION, immediately before the consume/sign
   boundary, under the session-control lock (never relying on the A3
   gate, which commits before handler dispatch): authoritative current
   session/project wallet read; family, network, chain id, signer and
   fee payer equality; intent status, ownership, expiry, payload
   digest and approval identity; decoded destination, contract,
   spender, amounts and irreversible effects unchanged; actual fee
   fields against approved caps; Solana block height, ALT resolution
   and unchanged message digest; fresh simulation.
8. SURFACE: four registry entries (risk class first, per-field unit
   sentences: EVM `valueWei` RAW; fee bounds in native units named);
   export-scope doc, inventory (159), titles, snapshots and
   `exported-tools.md` regenerated. A4c coordination: its conformance
   tests compare `tools/list` to the LIVE inventory, never a pinned
   count.
9. TESTS: decode goldens including the refusal set (unknown selector,
   non-canonical Permit2, unknown Solana instruction, unresolvable
   ALT); mandatory-bounds enforcement (actual > approved refuses);
   approval-bound proposalDigest mismatch refusal; blockhash expiry and height recheck;
   message-bytes-unchanged assertion; cross-kind negatives both ways;
   Studio card carries the decoded preview and intent expiry,
   proven through the REAL confirm handler -> `runStudioCall` ->
   approval row and card content (item 2), never an injected binding; reconciler terminalizes broadcast_unconfirmed from
   fake chain evidence; fee sweep extended; ambiguous outcome never
   rebroadcasts; MCP surface snapshots in the same change.

### Stage A5 - Installer and instruction files

Files: `src/vex-agent/studio/agents.ts`, `src/vex-agent/studio/installer/
{writers,merge,managed-block,render}.ts`, `src/vex-agent/studio/
instructions/*`, `vex-app/src/main/studio/installer.ts`, `CH.projects.
{update,repairFiles}` (NO delete channel here: A5 never deletes files,
and deletion authority is deferred with the project-deletion stage).
Dependency: `jsonc-parser`.
Verification: golden files per agent, merge-not-clobber with pre-existing
content and comments, managed-block idempotency and drift, a real run of
each selected PROJECT- and LAUNCH-integrated agent in a generated project
(an unsupported selection produces no artifact to run and is verified
through its explicit outcome instead).

#### Detailed spec (v2 after Codex plan review turn 1; split A5a/A5b)

A5a: canonical ids, the dialect matrix, pure renderers, golden
artifacts. A5b: main-owned confined reconciliation, provenance,
serialization, drift, IPC.

##### A5a

1. CANONICAL IDS in a pure `src/lib/studio-agent-ids.ts` (root tsconfig
   includes only `src`, so the app schema cannot be the engine's
   source; the vex-app shared schema imports/derives from this module
   and a parity test pins both).
2. DIALECT MATRIX `studio-mcp/agent-dialect-matrix.md`, a REVIEWED
   artifact formalized from the completed research
   (`studio-mcp/agent-dialect-research-2026-08-24.md`, primary-source
   pass, corrections and UNVERIFIED cells named there). Each id gets a
   CONFIG MODE: `project` (a file the client reads from the repo),
   `launch` (a generated file plus a documented launch flag - Kimi,
   which has no project scope but takes `--mcp-config-file`), or
   `unsupported` (cline AND the Warp CLI: user-global config only;
   shown as such in the picker copy). The Warp launch decision of
   2026-08-24 is SUPERSEDED by the 2026-08-25 re-verification: its
   premise (an `oz`-style mcp flag) does not exist on the current
   `warp` binary, which reads global config only and manages MCP
   in-session. OWNER DECISION 2026-08-25: Warp ships UNSUPPORTED in
   A5 - the still-functioning deprecated `oz --mcp` launch was
   EXPLICITLY DECLINED (a bridge built on a binary the vendor is
   removing), and the Warp APP's project `.warp/.mcp.json` (readable
   behind explicit in-app manual approval) is NOT built. Support
   returns when the `warp` CLI gains a project or launch mechanism.
   SELECTION CONTRACT for unsupported ids (turn-3 decision): every
   canonical id remains SELECTABLE and is STORED - a selection is the
   user's durable intent, and support can arrive in a later version
   without a migration of stored scopes. Reconciliation returns a
   PER-AGENT DISCRIMINATED OUTCOME: a `project` or `launch` id
   produces its artifact (or its named failure), an `unsupported` id
   produces NO artifact and an explicit `unsupported` outcome that the
   UI and the DTO show as such - never silence, never a fake success.
   The registry models config mode as a DISCRIMINATED UNION
   (`project` | `launch` | `unsupported`) so writer presence, launch
   instructions, timeout emission and the unsupported outcome are
   exhaustive by type. Tests pin the stored-selection round trip AND
   the unsupported outcome shape. OWNER DECISION 2026-08-24 on the residual:
   Copilot and Grok also reading Claude's `.mcp.json` is ACCEPTED and
   described in the trust copy ("Who cares? Moze tak byc"). The
   IDLE-TIMER finding governs: the host's progress notifications are
   the load-bearing mechanism for the 65-minute approval wait
   (claude-code 30-min idle, qwen 60-min hard cap), and stage A-test
   verifies per client that a progress token is actually sent. Matrix
   columns for every id: config path
   (+ alternate paths the client also reads), owned JSON/TOML path to
   OUR entry, exact schema, TIMEOUT MECHANISM with unit and the value
   we set (every mechanism must exceed the one-hour approval expiry;
   server-entry field vs launch flag vs client-process env are
   DISTINCT columns and a client env var is NEVER written into the
   bridge's child env), forbidden policy fields, supported client
   major (pinned or detected, never silently guessed). Known
   corrections already in evidence (from the research pass AND its
   2026-08-25 internet re-verification addendum, which supersedes
   every earlier spelling): Kimi is LAUNCH-scoped - no project file
   (user `~/.kimi/mcp.json` or `--mcp-config-file <path>`; timeout is
   the GLOBAL `[mcp.client] tool_call_timeout_ms`, default 60000, in
   the USER's config.toml, which a project cannot set), so A5
   generates `.vex/mcp/kimi.json` and documents the flag; the Warp CLI
   is UNSUPPORTED - `oz` is vendor-deprecated, the current `warp`
   binary has NO mcp flag and reads global config only ("project-scoped
   MCP config files in repositories are not detected"), and the only
   project-scoped Warp surface is the APP's `.warp/.mcp.json` behind
   explicit in-app manual approval (owner decision 2026-08-25: NOT
   built - Warp ships unsupported, deprecated `oz` explicitly
   declined);
   OpenCode "V2" is REFUTED (npm latest 1.18.23, no v2 line) - config
   `opencode.json[c]` key `mcp`, `additionalProperties: false`,
   `type: "local"` REQUIRED, `command` as an ARRAY, `environment` (not
   `env`), per-server `timeout` ms default 5000, set 3900000; Mistral
   Vibe is VERIFIED at project `./.vibe/config.toml` (loaded ONLY when
   the directory is trusted - silently absent otherwise),
   `[[mcp_servers]]` array-of-tables with REQUIRED `name` and
   `tool_timeout_sec` float seconds default 60, set 3900; cline stays
   UNSUPPORTED (user-global only; an omitted `type` defaults to legacy
   SSE, the inverse of claude - writers never emit `type` in cline
   dialect); COPILOT gets `.github/mcp.json` with an EXPLICIT
   `timeout: 3900000` (the vendor default is VERSION-DEPENDENT - the
   current CLI reference states 30000 ms while vendor issue #1378
   measured 180000 ms at v0.0.406; either is far below the approval
   wait, so the explicit write governs and the default never does; a
   closed vendor bug also reverted per-server timeouts after
   `tools/list_changed` - re-verified at the installed version),
   loading only after folder trust and silently skipped in untrusted
   dirs; GROK gets `.grok/config.toml` (`tool_timeout_sec` default
   6000 s confirmed) whose project file can ALSO carry `[permission]` -
   the writers NEVER emit `[permission]` or any allow rule, a FOREIGN
   `[permission]` beside our entry is surfaced as a SECURITY WARNING
   distinct from Vex-owned drift, and Repair PRESERVES it (it is the
   user's or another tool's statement, never ours to remove); the
   RESIDUAL - Copilot and Grok also read Claude's
   `.mcp.json`, so a project with Claude selected is discoverable by
   unselected Copilot/Grok - is ACCEPTED by owner decision 2026-08-24
   and described in the trust copy; Claude's wall-clock timeout is the
   `MCP_TOOL_TIMEOUT` client env variable (default ~28 h,
   version-gated), recorded as mechanism `client-env`, set nothing -
   progress notifications do NOT extend that wall-clock, they reset
   only the 30-minute stdio IDLE timer, which is exactly the mechanism
   the host's progress frames exist to serve.
3. PURE RENDERERS `src/vex-agent/studio/installer/render/*`: per
   dialect, input = the registry record + project facts, output =
   bytes; golden artifacts per agent (fresh file, merged file with
   comments and unknown keys, remove). The managed-block renderer
   REUSES `STUDIO_SAFETY_PREFIX` from `mcp/instructions.ts` directly
   and extracts the shared usage text into one module (no copy).
   `.vex/protocols.md` renders through the same generator lane as
   `exported-tools.md` with `--check`.

##### A5b

4. OWNERSHIP AND PROVENANCE: unknown keys OUTSIDE Vex-owned paths are
   preserved; the Vex entry is built from a CLOSED per-dialect
   allowlist; an existing entry at the Vex path is rewritten ONLY when
   durable provenance (a privileged store in main recording file,
   owned path, and the hash of what Vex last wrote) proves it is ours -
   otherwise the write REFUSES with a collision report; unknown keys
   INSIDE a provenance-proven Vex entry are rejected by name;
   deselect removes only an UNCHANGED previously-written entry; A5
   NEVER DELETES FILES (deletion authority is deferred with the
   project-deletion stage; a user-editable manifest never authorizes
   deletion).
5. CONFINED FILESYSTEM CONTRACT in main
   (`vex-app/src/main/studio/installer.ts`): paths derived ONLY from
   projectId -> anchored projects root -> static registry-relative
   paths; reject traversal, symlinked components, non-regular targets,
   oversized files (bound named), malformed UTF-8/JSON/JSONC/TOML,
   and ambiguous `.json`+`.jsonc` twins; same-directory exclusive
   temp files, permission preservation, containment revalidation
   after resolution, optimistic source-hash verification before
   replacement. Tests: symlink, malformed input, collision, size,
   plus FAULT INJECTION on reconciliation: a run that fails after the
   Nth successful artifact replacement leaves per-file provenance
   already committed, and Repair completes the remainder from it -
   proven, not assumed;
   bound, concurrent external edit.
6. TRIGGERS, SERIALIZED PER PROJECT: render jobs queue per project and
   RELOAD THE LATEST COMMITTED SCOPE at execution (two updates
   committing in order can never render in reverse order); durable
   record of the generator fingerprint and the last rendered
   `scope_version`, updated only after a COMPLETE current-scope
   reconciliation. DRIFT covers EVERY artifact (each selected agent
   config, the CLAUDE.md import, protocols doc, bridge path, managed
   block), reported per artifact on the project DTO. REPAIR
   reconciles ALL artifacts; a DRIFTED managed block is overwritten
   ONLY by explicit Repair.
7. IPC: `CH.projects.updateScope` (the existing channel name) extended
   with the render outcome, plus `CH.projects.repairFiles`; NO delete
   channel (deletion is deferred). Strict schemas, sender validation,
   the full positive/invalid/unauthorized/cancellation set per the
   stage-P pattern.
8. TESTS: matrix-vs-registry exhaustive (every id has a row and a
   renderer or an explicit UNSUPPORTED mark); golden triple per agent;
   provenance (foreign entry refused, ours rewritten, changed-ours
   refused on deselect); confinement negatives; serialization
   (interleaved updates render latest-only); drift per artifact;
   repair semantics; timeout values vs the approval TTL asserted from
   the matrix.

### Stage A-test - Real clients

One project, several agents (Claude Code, Codex, one without MRTR, one
custom MCP client script). Cases: trust prompt copy, read, search,
mutation with approve, decline, expiry, cancel, Vex locked, Vex not
running, env-absent tool.

### Stage B1 - Dependency and packaging PR

`node-pty` pinned, pty-host Vite entry (empty host), `files` and
`asarUnpack`, `onlyBuiltDependencies`, native artifact check in
`check:build`, signing of unpacked binaries, packaged load smoke on
mac-arm64 and win-x64 (open a terminal, `yes | head -c 50000000`, one
agent TUI end to end, window reload with reattach).

### Stage B2 - Pty host and terminal tabs

Files: `vex-app/src/pty-host/*`, `main/studio/pty-host-starter.ts`,
`shared/schemas/terminal.ts`, `preload/studio/terminal.ts` (port owner),
`renderer/features/studio/terminal/{TerminalRegistry,XtermHost,
TerminalTabs}.tsx`.
Verification: flow-control test with a scripted pty, keep-alive across
tab switches, restart cap (six attempts), teardown ordering, env
scrubbing, path escaping, no port object on `window.vex`.

### Stage B3 - Explorer, watcher, viewer

Files: `main/studio/files/*`, `shared/schemas/files.ts`, `preload/studio/
files.ts`, `renderer/features/studio/explorer/*`, `renderer/features/
studio/viewer/*`. Dependencies: `@parcel/watcher`, `@headless-tree/core`,
`@headless-tree/react`, `shiki`, `ignore`.
Verification: containment and symlink escape, burst of hundreds of writes
ending consistent, overflow resync, zero CSP violations on a highlighted
file, 50k-row tree under StrictMode.

### Stage B4 - Studio shell

Files: `App.tsx`, `features/appShell/ShellStatusStrip.tsx`, the
mode-independent approvals push hook, `features/studio/{StudioShell,
ProjectsList,projectListModel,ProjectCreator}.tsx`, `portfolio-scope.ts`,
`stores/uiStore/persistence.ts` (version 14), `SessionWelcomeHero.tsx`
and its test, the design guard glob.
Verification: shell tests for both modes, approvals badge in Studio with
a pending Studio intent, persisted-order migration, design guard.

### Stage C - Live phase (D14 step 5, unchanged)

## Backend completion gate (owner directive 2026-08-23)

After the backend stages are done (A3, A4, A4b, A5 and the real-client
test), STOP before stage B (Studio UI). Then dispatch a comprehensive
backend review to Codex on a NEW thread (not `harness-vex-studio`), and
instruct Codex explicitly to spawn its own subagents for verification
(independent lenses: approval security, MCP spec compliance, Electron
boundaries, repo-nativeness, tests). Only after that review returns does
stage B start.

## 4. Cross-cutting invariants

- Renderer never holds fs, paths, ports, or shell authority; every new
  IPC domain satisfies the rule-04 checklist and the three surface
  reconciliation tests.
- Money path unchanged: approval binds actor, chain, asset, amount,
  destination, bounds, expiry, project scope version; commit-time checks;
  unknown outcome stays pending; no automatic retry of signing.
- Boundedness explicit and reported: terminal scrollback with dropped
  byte count, watcher overflow flag, explorer caps with markers, discovery
  payload sizes named in the lane doc; settlement results stored whole
  (size recorded, never cut).
- No AI attribution; no em dashes.
- Dependency changes land separately from feature work (`node-pty`,
  `@parcel/watcher`, `@xterm/*`, `@headless-tree/*`, `shiki`,
  `jsonc-parser`, `@modelcontextprotocol/server`).

## 5. Open items for the owner

1. O22 closed by A1b (v2 pinned); owner to ratify in `owner-decisions.md`.
2. A4b scope (EVM first, Solana next, message signing later).
3. Cleanup: three merged worktrees and three remote branches await a word;
   the `.gitignore` working-tree change drops `vex-app/*.tsbuildinfo`.

## 6. Verification commands

Root: `pnpm test`, `pnpm check:em-dash`, `pnpm test:eval:lexical`,
`pnpm prompt-budget:report`. App: `pnpm --dir vex-app lint`,
`pnpm --dir vex-app test`, `pnpm --dir vex-app test:e2e`,
`pnpm --dir vex-app check:build`. Nothing is claimed until run.
