/**
 * Settings > Tools (MCP): the user's own MCP servers (F12).
 *
 * Add a server by URL (and a token if it needs one); Vex lists its tools,
 * every one off. Turn tools on one at a time ("Use in chats"); a tool its
 * server declares read-only may also "Run without asking". A tool the server
 * changed is off until "Review again". State is a fill plus a word.
 *
 * Every write is pessimistic: the section shows the list main answered with,
 * and a refusal shows its sentence under the control that caused it.
 */

import { useState, type JSX } from "react";
import type { UserMcpServerDto, UserMcpToolDto } from "@shared/schemas/user-mcp.js";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { Swatch, type SwatchState } from "../../../../components/ui/swatch.js";
import {
  useAddUserMcpServer,
  useRecheckUserMcpServer,
  useRemoveUserMcpServer,
  useSetUserMcpToken,
  useSetUserMcpToolAutoRun,
  useSetUserMcpToolEnabled,
  userMcpErrorText,
  useUserMcpList,
} from "../../../../lib/api/user-mcp.js";

export const USER_MCP_INTRO =
  "Their tools can look things up for your chats. They can never trade, move funds or sign. The arguments you approve are sent to that server.";

const SERVER_STATE: Record<UserMcpServerDto["status"], { readonly swatch: SwatchState; readonly word: string }> = {
  active: { swatch: "done", word: "Connected" },
  error: { swatch: "warning", word: "Not answering" },
  disabled: { swatch: "idle", word: "Off" },
};

const inputClass = "h-[42px] text-[15px]";
const labelClass = "vex-ov-label flex flex-col gap-1";
const noteClass = "text-[13px] leading-[19px] text-ink-secondary";

function AddServerForm({ atLimit }: { readonly atLimit: boolean }): JSX.Element {
  const add = useAddUserMcpServer();
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const error = userMcpErrorText(add.data);
  const submit = (): void => {
    add.mutate(
      { name: name.trim(), endpoint: endpoint.trim(), token: token.length > 0 ? token : null },
      {
        onSuccess: (result) => {
          if (!result.ok) return;
          setName("");
          setEndpoint("");
          setToken("");
        },
      },
    );
  };
  const ready = name.trim().length > 0 && endpoint.trim().length > 0 && !add.isPending && !atLimit;
  return (
    <form
      aria-label="Add an MCP server"
      data-vex-user-mcp-add
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) submit();
      }}
    >
      <h3 className="vex-set__sh-title">Add a server</h3>
      <label className={labelClass}>
        Name
        <Input className={inputClass} value={name} maxLength={100} disabled={add.isPending} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={labelClass}>
        Server URL
        <Input
          className={inputClass}
          value={endpoint}
          placeholder="https://example.com/mcp"
          autoComplete="off"
          spellCheck={false}
          disabled={add.isPending}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <label className={labelClass}>
        Token (optional)
        <Input
          className={inputClass}
          type="password"
          value={token}
          autoComplete="off"
          disabled={add.isPending}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p className={noteClass}>
        Use https for a server on the internet. Plain http is accepted only for a server on this computer. The token is kept in your encrypted vault.
      </p>
      <div>
        <Button type="submit" variant="quiet" disabled={!ready}>
          {add.isPending ? "Connecting" : "Add server"}
        </Button>
      </div>
      {atLimit ? <p className={noteClass}>You have added as many servers as Vex allows. Remove one to add another.</p> : null}
      {error !== null ? (
        <p role="alert" className="text-[13px] leading-[19px] text-ink-primary">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ToolRow({
  tool,
  serverId,
  serverActive,
}: {
  readonly tool: UserMcpToolDto;
  readonly serverId: string;
  readonly serverActive: boolean;
}): JSX.Element {
  const setEnabled = useSetUserMcpToolEnabled();
  const setAutoRun = useSetUserMcpToolAutoRun();
  const review = useRecheckUserMcpServer();
  const error = userMcpErrorText(setEnabled.data) ?? userMcpErrorText(setAutoRun.data) ?? userMcpErrorText(review.data);
  const busy = setEnabled.isPending || setAutoRun.isPending || review.isPending;
  const usable = tool.status === "active" && serverActive;
  return (
    <li data-vex-user-mcp-tool={tool.remoteName} className="flex flex-col gap-2 border-t border-rule py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[13px] text-ink-primary">{tool.remoteName}</span>
        {tool.readOnlyHint ? <span className="text-[12px] text-ink-tertiary">Read-only, says the server</span> : null}
      </div>
      {tool.description.length > 0 ? <p className={noteClass}>{tool.description}</p> : null}
      {tool.status === "unsupported" ? (
        <p className={noteClass}>Not supported: {tool.unsupportedReason ?? "Vex does not accept what it takes."}</p>
      ) : null}
      {tool.status === "drifted" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-[13px] text-ink-primary">
            <Swatch state="warning" />
            Changed by the server, so it is off
          </span>
          <Button
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={() => review.mutate({ serverId, reviewToolId: tool.id })}
          >
            Review again
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="inline-flex items-center gap-2 text-[14px] text-ink-primary">
          <input
            type="checkbox"
            data-vex-user-mcp-enable={tool.remoteName}
            checked={tool.enabled}
            disabled={busy || (!tool.enabled && !usable)}
            onChange={(e) => setEnabled.mutate({ toolId: tool.id, enabled: e.target.checked })}
          />
          Use in chats
        </label>
        {tool.readOnlyHint ? (
          <label className="inline-flex items-center gap-2 text-[14px] text-ink-primary">
            <input
              type="checkbox"
              data-vex-user-mcp-autorun={tool.remoteName}
              checked={tool.autoRun}
              disabled={busy || !tool.enabled}
              onChange={(e) => setAutoRun.mutate({ toolId: tool.id, autoRun: e.target.checked })}
            />
            Run without asking
          </label>
        ) : null}
      </div>
      <details className="text-[13px] text-ink-secondary">
        <summary className="cursor-pointer">What it takes</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-ink-secondary">
          {tool.schemaJson}
        </pre>
      </details>
      {error !== null ? (
        <p role="alert" className="text-[13px] leading-[19px] text-ink-primary">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function TokenEditor({ server, onDone }: { readonly server: UserMcpServerDto; readonly onDone: () => void }): JSX.Element {
  const setToken = useSetUserMcpToken();
  const [value, setValue] = useState("");
  const error = userMcpErrorText(setToken.data);
  return (
    <div className="flex flex-col gap-2">
      <label className={labelClass}>
        New token
        <Input className={inputClass} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="quiet"
          size="sm"
          disabled={value.length === 0 || setToken.isPending}
          onClick={() => setToken.mutate({ serverId: server.id, token: value }, { onSuccess: (r) => r.ok && onDone() })}
        >
          Save token
        </Button>
        {server.hasToken ? (
          <Button
            variant="bare"
            size="sm"
            disabled={setToken.isPending}
            onClick={() => setToken.mutate({ serverId: server.id, token: null }, { onSuccess: (r) => r.ok && onDone() })}
          >
            Remove token
          </Button>
        ) : null}
        <Button variant="bare" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-[13px] leading-[19px] text-ink-primary">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ServerCard({ server }: { readonly server: UserMcpServerDto }): JSX.Element {
  const recheck = useRecheckUserMcpServer();
  const remove = useRemoveUserMcpServer();
  const [editingToken, setEditingToken] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const state = SERVER_STATE[server.status];
  const error = userMcpErrorText(recheck.data) ?? userMcpErrorText(remove.data);
  return (
    <article aria-label={`MCP server ${server.name}`} data-vex-user-mcp-server={server.name} className="flex flex-col gap-3 border-t border-rule pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-medium text-ink-primary">{server.name}</span>
          <span className="break-all font-mono text-[12px] text-ink-tertiary">{server.endpoint}</span>
        </div>
        <span className="inline-flex items-center gap-2 text-[13px] text-ink-primary" data-vex-user-mcp-state>
          <Swatch state={state.swatch} />
          {state.word}
        </span>
      </div>
      <p className={noteClass}>
        {server.networkScope === "local" ? "On this computer. " : ""}
        {server.hasToken ? "Token saved in your vault." : "No token."}
        {server.status === "error" && server.lastError !== null ? ` Last check: ${server.lastError.replaceAll("_", " ")}.` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" size="sm" disabled={recheck.isPending} onClick={() => recheck.mutate({ serverId: server.id })}>
          {recheck.isPending ? "Checking" : "Check now"}
        </Button>
        <Button variant="quiet" size="sm" onClick={() => setEditingToken((v) => !v)}>
          {server.hasToken ? "Change token" : "Add token"}
        </Button>
        {confirmRemove ? (
          <>
            <Button variant="ink" size="sm" disabled={remove.isPending} onClick={() => remove.mutate({ serverId: server.id })}>
              Remove {server.name}
            </Button>
            <Button variant="bare" size="sm" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="bare" size="sm" onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        )}
      </div>
      {editingToken ? <TokenEditor server={server} onDone={() => setEditingToken(false)} /> : null}
      {error !== null ? (
        <p role="alert" className="text-[13px] leading-[19px] text-ink-primary">
          {error}
        </p>
      ) : null}
      {server.tools.length === 0 ? (
        <p className={noteClass}>This server lists no tools.</p>
      ) : (
        <ul aria-label={`Tools on ${server.name}`} className="m-0 list-none p-0">
          {server.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} serverId={server.id} serverActive={server.status === "active"} />
          ))}
        </ul>
      )}
    </article>
  );
}

export function UserMcpSection(): JSX.Element {
  const list = useUserMcpList();
  const data = list.data?.ok === true ? list.data.data : null;
  return (
    <section aria-label="Tools (MCP)" data-vex-user-mcp className="vex-set__sec vex-set__stack flex flex-col gap-5">
      <p className="vex-set__note">{USER_MCP_INTRO}</p>
      {data !== null ? (
        <p className={noteClass} data-vex-user-mcp-count>
          {data.enabledCount} of {data.maxEnabled} tools in use. Each call asks you first unless you let a read-only tool run without asking.
        </p>
      ) : list.data !== undefined && !list.data.ok ? (
        <p role="alert" className={noteClass}>
          {userMcpErrorText(list.data)}
        </p>
      ) : (
        <p className={noteClass}>Loading</p>
      )}
      {data?.servers.map((server) => <ServerCard key={server.id} server={server} />)}
      <div className="border-t border-rule pt-4">
        <AddServerForm atLimit={data !== null && data.servers.length >= data.maxServers} />
      </div>
    </section>
  );
}
