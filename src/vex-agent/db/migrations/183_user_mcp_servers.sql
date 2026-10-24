-- USER MCP SERVERS: MCP servers the user added by URL, and the tools each one
-- listed (F12, "Connect your own MCP servers").
--
-- WHY THIS EXISTS. The user can give the agent read-only tools of their own:
-- an MCP server they trust, reached over Streamable HTTP. Vex connects once,
-- lists the server's tools and keeps them here, every tool OFF until the user
-- turns it on in Settings. A tool the user turns on joins their interactive
-- chat turns as a read-only external tool; by default every call stops on an
-- approval card that names the server, the tool and the exact arguments.
--
-- OWNER. The Electron main process writes these rows (Settings IPC and the
-- six-hourly recheck), through `src/vex-agent/db/repos/user-mcp.ts`. No agent
-- tool and no model output writes them: chat can call an enabled tool, never
-- add a server or widen trust.
--
-- user_mcp_servers (one row per server)
--   endpoint        the Streamable HTTP URL, unique. Validated in code: https,
--                   or loopback over http or https (`network_scope = 'local'`).
--   network_scope   `public`: a public https host, every resolved address
--                   checked public. `local`: on this computer (loopback only).
--   has_token       a bearer token for this server is in the encrypted vault
--                   under `user-mcp-token:<id>`. The token itself never lives
--                   in the database.
--   status          `active`, `error` (three failed listings in a row: its
--                   tools leave the chat until a check succeeds) or `disabled`.
--   failures        consecutive failed listings.
--   last_error      a bounded refusal code, never raw server text.
--
-- user_mcp_tools (one row per tool a server listed)
--   remote_name     the tool's name on the server. The name the model sees is
--                   derived from the row id (`mcp_t<16 hex>`), never from this,
--                   so a server cannot pick a name that collides with Vex's own.
--   input_schema    the schema PINNED when the tool was listed or last
--                   reviewed. Calls are validated against this, not against
--                   what the server lists now.
--   schema_hash     sha256 of the pinned schema; a recheck that sees another
--                   hash marks the tool drifted and turns it off.
--   read_only_hint  the server declared `annotations.readOnlyHint: true`.
--   enabled         the user turned it on ("Use in chats").
--   auto_run        the user allowed it to run without asking. Only for a tool
--                   the server declared read-only, held by a CHECK below.
--   status          `active`, `drifted` (the server changed it; off until the
--                   user reviews it) or `unsupported` (its schema uses a
--                   construct Vex does not accept; never callable).
--
-- The two CHECKs hold the trust rules in the database itself, so a code path
-- that gets them wrong is refused by Postgres.

CREATE TABLE IF NOT EXISTS user_mcp_servers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  endpoint         TEXT NOT NULL UNIQUE CHECK (char_length(endpoint) BETWEEN 1 AND 2000),
  network_scope    TEXT NOT NULL DEFAULT 'public' CHECK (network_scope IN ('public', 'local')),
  has_token        BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
  failures         INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_checked_at  TIMESTAMPTZ,
  last_error       TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 64),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_mcp_tools (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id           UUID NOT NULL REFERENCES user_mcp_servers(id) ON DELETE CASCADE,
  remote_name         TEXT NOT NULL CHECK (char_length(remote_name) BETWEEN 1 AND 200),
  description         TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  input_schema        JSONB NOT NULL,
  schema_hash         TEXT NOT NULL,
  read_only_hint      BOOLEAN NOT NULL DEFAULT false,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  auto_run            BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'drifted', 'unsupported')),
  unsupported_reason  TEXT CHECK (unsupported_reason IS NULL OR char_length(unsupported_reason) <= 200),
  enabled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, remote_name),
  CONSTRAINT user_mcp_tools_auto_run_check CHECK (NOT auto_run OR read_only_hint),
  CONSTRAINT user_mcp_tools_enabled_check CHECK (NOT enabled OR status = 'active')
);

CREATE INDEX IF NOT EXISTS user_mcp_tools_enabled_idx
  ON user_mcp_tools (enabled_at)
  WHERE enabled;
