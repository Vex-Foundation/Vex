# github-mcp-server architecture map (reference for D18)

Measured 2026-08-22, read-only, by an Explore agent against
`agents-colab/github-mcp-server` at 8ec6249 (2026-08-18) and the Vex tree at
feat/tool-surface-4. Every claim is static reading; nothing was executed.
Pattern reference, never code to copy; repository rules win on conflict.

## 1. Layout and dependency direction

| Layer | Owns | Depends on |
| --- | --- | --- |
| `cmd/github-mcp-server/` | CLI (cobra+viper), flags, docs generator, scope lister | `internal/ghmcp`, `pkg/github` |
| `internal/ghmcp/` | composition root: client construction, deps, inventory build, stdio loop, OAuth | everything below |
| `pkg/inventory/` | GENERIC, GitHub-agnostic tool/resource/prompt container: `ServerTool`, filters, builder, registration, instructions, availability gating | the mcp SDK, `pkg/octicons`, `pkg/context` |
| `pkg/github/` | tool definitions, handlers, the toolset table, param helpers, minimal types | `pkg/inventory`, `pkg/errors`, `pkg/translations`, `pkg/utils`, `pkg/scopes` |
| `pkg/errors`, `translations`, `utils`, `scopes`, `sanitize`, `tooldiscovery`, `toolvalidation`, `observability` | horizontal services | nothing feature-specific |
| `internal/requeststate`, `internal/toolsnaps`, `internal/githubv4mock` | sealed state, snapshot harness, test doubles | leaf |

The inversion to keep: `pkg/inventory` does not know GitHub exists.
`HandlerFunc func(deps any) mcp.ToolHandler` is typed `any` on purpose to
break the cycle (`pkg/inventory/server_tool.go:14-19`); `ToolsetID` is a
distinct type (`server_tool.go:25-27`). Composition
(`internal/ghmcp/server.go:177-195`): `github.NewInventory(translator,
WithHost(host)).WithDeprecatedAliases(...).WithReadOnly(...).WithToolsets(...)
.WithTools(...).WithExcludeTools(...).WithServerInstructions().WithFeatureChecker(...)`.
`WithHost` carries a deployment capability into tool CONSTRUCTION so "a
tool's description and its behaviour are decided from the same value and
cannot drift apart" (`pkg/github/tools.go:184-187`).

## 2. Toolsets

- 24 toolsets in one table (`pkg/github/tools.go:22-182`): `{ID,
  Description, Default, Icon, InstructionsFunc}`. Default set: context,
  repos, issues, pull_requests, users, copilot.
- Pseudo-IDs `all` and `default` (`tools.go:23-32`, expanded in
  `pkg/inventory/builder.go:337-346`); unknown IDs are collected as
  warnings, not rejected (`registry.go:59-69`).
- Inputs: `--toolsets`, `--tools` (additive), `--exclude-tools`,
  `--read-only`, `--features` (`cmd/github-mcp-server/main.go:235-239`);
  remote headers `X-MCP-Toolsets`, `X-MCP-Tools`, `X-MCP-Exclude-Tools`,
  `X-MCP-Readonly`, `X-MCP-Lockdown`, `X-MCP-Insiders`, `X-MCP-Features`
  (`pkg/http/headers/headers.go:37-50`).
- THE DYNAMIC-TOOLSETS MODE DOES NOT EXIST in this checkout: no
  `--dynamic-toolsets` flag, no `enable_toolset` / `list_available_toolsets`
  meta tools anywhere. The surface is fixed per connection by flags or
  headers, plus a `tools/list`-time filtering middleware that removes
  tools the CLIENT cannot support (`pkg/inventory/tool_availability.go:59-85`).
  That is the spec-legal way to vary the list (per connection capability,
  never per session state) and matches Vex's D2 constraint better than a
  meta-tool design.
- Deterministic ordering by toolset id then tool name
  (`pkg/inventory/filters.go:147-160`, `registry.go:306-318`).

## 3. Tool definition pattern

Canonical example `GetFileContents` (`pkg/github/repositories.go:917-961`):
schema as a literal `*jsonschema.Schema`, augmented by shared helpers
(`fieldsSchemaProperty` for enum-array field selection,
`minimal_types.go:137`; `WithUnifiedPagination` / `WithCursorPagination`,
`params.go:366-403`); `mcp.Tool{Name, Description: t("TOOL_..._DESCRIPTION",
default), Annotations: {Title: t("TOOL_..._USER_TITLE"), ReadOnlyHint},
InputSchema}`. Title is an ANNOTATION (`repositories.go:956`), snapshotted.
Registration `NewTool[In, Out](toolset, tool, requiredScopes, handler)`
(`pkg/github/dependencies.go:236-249`) auto-derives `AcceptedScopes` from a
scope hierarchy. Read-only filter reads `Annotations.ReadOnlyHint`
(`server_tool.go:107-108`, `filters.go:98`).

AST lint for annotation completeness: `pkg/toolvalidation/readonlyhint.go:45-65`
parses every non-test Go file and fails any `mcp.Tool` literal that does not
set `ReadOnlyHint` explicitly, because an unset hint read as false made
clients prompt for approval on safe reads.

## 4. Handler pattern

Shape: `func(ctx, deps ToolDependencies, req *mcp.CallToolRequest, args
map[string]any) (*mcp.CallToolResult, any, error)`.

Error audience split: user-actionable failures return
`utils.NewToolResultError(msg), nil, nil` (a successful call with
`IsError: true`, e.g. every param failure `repositories.go:963-992`);
developer and infrastructure failures return a Go error
(`repositories.go:775, 788, 850`).

Param helpers (`pkg/github/params.go`): `RequiredParam[T]` (:128),
`OptionalParam[T]` (:200), `OptionalParamOK` (:15),
`OptionalNullableStringParam` (omitted / null / value tri-state, :38),
`OptionalIntParamWithDefault` (:236), `OptionalStringArrayParam` (:265),
`RequiredBigInt` (:178). `toInt` / `toInt64` (:66, :95) accept numeric
STRINGS because some MCP clients send numbers as strings, and reject NaN,
infinities, fractions and precision loss.

Response: about 90 `Minimal*` structs (`minimal_types.go:149-508`) plus a
runtime `fields` projection (`filterFields`, :98-135); pagination reported
as `pageInfo{hasNextPage, hasPreviousPage, nextCursor, prevCursor}` built
from the provider response (`params.go:458-472`).

`structuredContent` / `outputSchema`: two hits in the whole tree.
`pkg/utils/result.go:79` is the MCP Apps `awaiting_user_submission`
sentinel (an `IsError: true` result meaning a form is open and the
operation has NOT happened); `csv_output.go:104` nils it. Output is text
content. The Vex audit's criterion 5 citation of `result.go:79` as
"github-mcp emits StructuredContent" is therefore not evidence of a
structured output channel (correction recorded in
`batch3/mcp-readiness-audit.md`, addendum).

## 5. Instructions

`generateInstructions(inv)` (`pkg/inventory/instructions.go:9-43`): about
1.1 KB of base text (list versus search selection, pagination in batches of
5-10, `minimal_output`, search sort and order), then each enabled toolset's
`InstructionsFunc(inv)` appended (the function receives the whole inventory
so guidance can depend on what else is enabled). `DISABLE_INSTRUCTIONS=true`
returns an empty string for A/B baselines. Preserved across every MCP
method including `initialize` (`registry.go:118, 129-133`).

## 6. Transports and hosting

- stdio: `RunStdioServer` (`internal/ghmcp/server.go:274+`); PAT via env or
  flag; OAuth 2.1 device flow (`internal/oauth/`); GitHub App with the
  private key by PATH so it stays out of env and argv (`main.go:260`).
- HTTP: `pkg/http/`, `--port`, `--listen-host` (default binds ALL
  interfaces, `main.go:264`), `--base-url`, `--scope-challenge`,
  `--trust-proxy-headers` (opt-in, precondition stated in the flag help,
  `main.go:268`). The all-interfaces default CONFLICTS with the Vex rule
  that local services bind to loopback; the Vex rule wins.
- Enterprise host: `--gh-host` resolved to REST, GraphQL, upload and raw
  URLs separately (`server.go:44-64`).
- Multi-round-trip state: `--mrtr-state-key` for stateless HTTP
  (`pkg/http/server.go:267`); stdio uses a process-local random key
  (`requeststate.NewRandom()`, `server.go:173`).

## 7. The approval round trip that exists as code

`delete_repository` (`pkg/github/repositories.go:715-884`) with
`internal/requeststate/sealer.go` (81 lines) is a working implementation
of the round trip `mcp-export-scope.md:46-49` only designs:

1. First call without `InputResponses[confirmationID]`: fetch the RESOURCE
   IDENTITY (`repositoryIDForDeletion`, :886), seal `{owner, repo,
   repository_id, expires_at}` with AES-256-GCM into an opaque base64url
   token (`sealer.go:54-61`), return `CallToolResult{InputRequests:
   {ElicitParams{Mode: "form", RequestedSchema}}, RequestState: token}`
   (:794-813).
2. Second call: five fail-closed checks, each stating the operation did
   not happen: state missing (:816), unsealable (:819-825), target changed
   (:826), expired (:829), zero id (:832).
3. Confirmation `Action != "accept"` refused (:840); the typed confirmation
   must equal `owner/repo` exactly (:843).
4. The repository id is RE-FETCHED and compared with the sealed one
   immediately before the destructive call (:852-858): revalidation at
   commit, not at proposal.
5. `MinimumProtocolVersion = "2026-07-28"` and `RequiredElicitationMode =
   form` (:880-881) remove the tool from `tools/list` for clients that
   cannot complete the round trip (`tool_availability.go:59-85`) and fail
   the call by name if called anyway (:129-149). Missing sealer: the tool
   refuses rather than degrading (:762-765).

Every clause of rule 90 ("revalidate immediately before signing or commit;
a stale proposal cannot be approved") has a line of code here.

## 8. Stateless catalog search

`pkg/tooldiscovery/search.go`: pure `SearchTools(tools, query, opts)` (:51)
over name, description and schema property names, weighted (:19-27),
`MatchedIn []string` per hit (:15, :100), `minScore 1.0` (:76),
`DefaultMaxSearchResults = 3` (:19). Stateless, lexical only, no session
working set, no mutation of the tool list: an existence proof that a
useful catalog search needs no session (the read-only projection D2
requires of the exported ToolSearch).

## 9. Snapshots, tests, docs

- toolsnaps (`internal/toolsnaps/toolsnaps.go`): `toolsnaps.Test(name,
  tool)` writes or compares `__toolsnaps__/<name>.snap` (:21-67), 117
  committed; `UPDATE_TOOLSNAPS=true` regenerates (:30-32); keys sorted
  recursively (:91-101); a MISSING snapshot fails only in CI
  (`GITHUB_ACTIONS=true`, :37-45), locally it self-creates; diff with
  `jd.SET` so array order is not contract (:58-60); called from ordinary
  per-tool unit tests (`pkg/github/actions_test.go:23`).
- Docs generated from the live inventory: `generate-docs` writes README,
  `docs/remote-server.md`, `docs/insiders-features.md`,
  `docs/feature-flags.md`, `docs/tool-renaming.md` between markers
  (`cmd/github-mcp-server/generate_docs.go:38-48, 364`); CI
  `.github/workflows/docs-check.yml` fails on README drift. Other
  workflows: lint, go, mcp-diff, license-check, code-scanning.
- One opt-in e2e file against a real token (`e2e/e2e_test.go`).

## 10. Errors, translations, observability, versioning

- `pkg/errors`: typed API, GraphQL and raw error wrappers (`error.go:16,
  35, 51`); a context-carried error accumulator so middleware can observe
  provider failures the tool result redacted (:77, :95); result
  constructors that do both (:160); `StructuredResolutionError` (:234-252),
  a machine-readable JSON error with a closed `Kind` union
  (`field_not_found`, `field_ambiguous`, `option_not_found`,
  `wrong_field_type`, ...) so agents self-correct without a re-prompt.
- `pkg/translations`: `func(key, default) string` from `GITHUB_MCP_<KEY>`
  env or JSON; an override seam, not a content store.
- `pkg/observability`: `Exporters{*slog.Logger, Metrics}`, both non-nil
  required with the discard implementations named in the error (:28-34).
  No request-id scheme in the tool layer.
- Version by link-time `var version`, exposed in cobra and the User-Agent
  (`main.go:25, 34`; `server.go:72`); goreleaser, docker-publish,
  registry-releaser, `server.json` manifest for the MCP registry.

## 11. Pattern to Vex seam map

| # | github-mcp pattern | Vex seam | Status |
| --- | --- | --- | --- |
| 1 | GitHub-agnostic `pkg/inventory`, `deps any` | `tools/registry.ts` + `protocols/catalog.ts` | Partial: the catalog aggregates namespace bundles (`catalog.ts:19-48`); visibility lives in `registry/visibility.ts` and the dispatcher; no inventory object separable from the agent runtime |
| 2 | `ToolsetID` + toolset table with Default, Icon, InstructionsFunc | `ProtocolNamespace`, `PROTOCOL_NAMESPACE_NAVIGATION` | Partial: no Default flag, no per-group instructions hook for a server |
| 3 | `all` / `default` pseudo-ids, unknown-id warning | none | Absent: export scope is a static table |
| 4 | read-only filter from `ReadOnlyHint` | `actionKind === "read"` | Equivalent in shape; classification compiler-enforced (`protocols/types.ts:209`) |
| 5 | AST lint: hint explicitly set | `_manifest-lint/source-rules.ts` | Partial: the harness exists, the rule does not |
| 6 | title as annotation, snapshotted | none | Absent (O6) |
| 7 | shared pagination schema helpers | `registry/khalani.ts paramsToJsonSchema` | Partial: schemas compile from manifests (one source), no shared pagination param group |
| 8 | `pageInfo` built by one helper | `handler-helpers.ts` | Absent: no pagination constructor; the contract lives in output-envelope.md only (Batch 4 adds fields per tool, not a helper) |
| 9 | param helpers, numeric-string tolerance | `internal/types.ts:162-219` + `runtime/params.ts` | Equivalent, Vex stronger (rejects undeclared keys at the boundary); Vex lacks numeric-string tolerance |
| 10 | error audience split | `ok` / `fail` + the four prose arms | Equivalent in intent; Vex's is a ratified money-path invariant and stricter |
| 11 | `StructuredResolutionError` closed kinds | `generic-error-literal` lint | Absent as a mechanism |
| 12 | `structuredContent` / `outputSchema` | none | Absent in Vex and near-absent in the reference |
| 13 | sealed requestState + elicitation + commit-time revalidation | approval runtime (`protocols/runtime.ts:251-261`, `runtime/gates.ts:236`, `tools/types.ts:350-360`) | Partial: in-app gate carries intentId, expiresAt, criticalArgs; no sealer, no MCP `input_required` arm, no re-read-before-commit on an MCP path |
| 14 | client-capability gating of `tools/list` | `registry/visibility.ts:153`, `dispatcher/pressure-gate.ts:31-51` | Absent in the MCP sense: Vex gates on session state (what D2 forbids varying on); the reference gates on protocol version and declared capability |
| 15 | capability gate returns a typed unavailable result | `requiresEnv` (hides 34 solana tools) | Partial: the audit's own recommendation (O8) is the reference's behavior |
| 16 | deterministic sort by group then name | toolsnaps `build-contracts.ts` | Partial: one variance source (`requiresEnv`) |
| 17 | `ForMCPRequest(method, item)` narrowing | none | Absent; relevant only for a per-request HTTP instance |
| 18 | stateless lexical `SearchTools` | `dispatcher/tool-search.ts`, `protocols/discovery.ts` | Equivalent, Vex stronger (dense + lexical), but query mode WRITES a session working set (`tool-search-select.ts:58-60, 157`) that the export must not reach |
| 19 | server instructions generated from enabled groups | none | Absent: no instructions assembler; the in-app prompt layers are the raw material |
| 20 | toolsnaps with CI-only missing failure | `toolsnaps/build-contracts.ts`, 167 snaps | Equivalent, Vex more sophisticated (snapshots the end of the projection pipeline with measured gate booleans) |
| 21 | docs generated from the inventory + CI diff gate | none | Absent (the 137 vs 134 drift is the symptom) |
| 22 | translations indirection | lint-governed descriptions | Deliberate divergence, not a gap |
| 23 | `AcceptedScopes` derived from a scope hierarchy | project scope (planned, `mcp-export-scope.md:50-53`) | Absent, undesigned |
| 24 | `Exporters` bundle with noop defaults | not investigated | unknown |

## 12. Consequences for the Studio MCP design

- Name the Vex owner that plays `pkg/inventory`: a container with no
  runtime authority, fed by the catalog and the internal registry, that
  the MCP server composes; handlers get privilege from deps. Today that
  knowledge is spread across `registry.ts`, `registry/visibility.ts`,
  `dispatcher/pressure-gate.ts`, `protocols/prequote/gate.ts` and
  `protocols/runtime.ts`, several session-coupled by design; an MCP server
  cannot reuse the dispatcher without inheriting the session model.
- Vary `tools/list` only by client capability and protocol version
  (reference `tool_availability.go`), never by session state (D2).
- The approval round trip for exported mutating tools follows
  `delete_repository`: seal the resource identity with an expiry, elicit
  the confirmation, refuse by name on every stale or changed state,
  re-read identity immediately before commit, gate the tool on the
  client's elicitation capability.
- Exported ToolSearch is the stateless lexical search plus the dense lane
  read-only; never the select-mode working-set write.
- Keep Vex's stricter boundary (undeclared keys rejected), the four prose
  failure arms and the loopback bind; do not copy the reference's leniency
  or its all-interfaces default.
- Add the reference's two mechanical gates Vex lacks: an annotation
  completeness lint, and docs generated from the inventory with a CI
  diff gate.
- Do not build a second output channel: the reference ships without
  `structuredContent`; O5 stays deferred.
