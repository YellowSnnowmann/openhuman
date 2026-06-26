/**
 * Shared TypeScript types for the MCP Servers tab.
 * Single source of truth — import from here, not from the API layer.
 */

export type SmitheryServer = {
  qualified_name: string;
  display_name: string;
  description?: string;
  icon_url?: string;
  use_count?: number;
  is_deployed?: boolean;
  /**
   * Upstream registry this row came from — `'mcp_official'` (the official
   * modelcontextprotocol.io registry) or `'smithery'`. Stamped by the Rust
   * dispatcher; used to attribute each row to its source registry.
   */
  source?: string;
  /**
   * `true` when this is the canonical first-party server for a well-known
   * service (exact `qualified_name` match server-side). The UI badges it
   * "Official"; every other server is shown without a badge — nothing is
   * hidden. Stamped by the Rust dispatcher; never trusted from the wire.
   */
  official?: boolean;
  /**
   * Vendor/site URL the server declares (`websiteUrl`). The strict "perfect
   * server" catalog only lists servers that declare one; the row links to it.
   */
  website_url?: string;
  /**
   * Declared auth method from registry metadata alone (no probe): `'api_key'`
   * when the server names a secret credential, else absent. Drives the row's
   * auth badge — only what the schema declares, never a guess.
   */
  auth_kind?: 'api_key';
};

/** One credential input a server declares (from its connection config_schema). */
export type AuthField = {
  name: string;
  description?: string;
  secret: boolean;
  required: boolean;
  get_key_url?: string;
  /** `'header'` (http remote) or `'env'` (stdio package). */
  location: 'header' | 'env';
};

/**
 * How a server authenticates — the single source of truth, produced by the Rust
 * `probe_auth` RPC (an unauthenticated probe of the live endpoint reconciled
 * with the registry's declared fields). Both the install screen and the connect
 * modal render from this so they can never tell two different auth stories.
 *
 * - `open` — no auth; just connect.
 * - `oauth` — browser sign-in (use `provider` for the button label).
 * - `api_key` — paste the declared `fields`.
 * - `unknown` — couldn't determine; offer manual/advanced config.
 */
export type AuthPlan = {
  method: 'open' | 'oauth' | 'api_key' | 'unknown';
  /** `'probed'` (live 401/200) or `'declared'` (registry hint only). */
  confidence: 'probed' | 'declared';
  fields: AuthField[];
  provider?: string;
  /** Set when the registry's claim disagreed with the probe; the probe wins. */
  mismatch?: { declared: string; observed: string };
};

export type SmitheryConnection = {
  type: 'stdio' | 'http';
  deployment_url?: string;
  config_schema?: unknown;
  example_config?: unknown;
  published?: boolean;
};

export type SmitheryServerDetail = SmitheryServer & {
  connections: SmitheryConnection[];
  required_env_keys?: string[];
};

export type CommandKind = 'node' | 'python' | 'binary';

export type InstalledServer = {
  server_id: string;
  qualified_name: string;
  display_name: string;
  description?: string;
  icon_url?: string;
  command_kind: CommandKind;
  command: string;
  args: string[];
  env_keys: string[];
  config?: unknown;
  installed_at: number;
  last_connected_at?: number;
  enabled: boolean;
};

export type McpTool = { name: string; description?: string; input_schema: unknown };

export type ServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  // Server reachable but rejected the connect with HTTP 401 — needs sign-in or
  // an access token. Distinct from `error` so the UI offers a re-auth path.
  | 'unauthorized'
  | 'error'
  | 'disabled';

export type ConnStatus = {
  server_id: string;
  qualified_name: string;
  display_name: string;
  status: ServerStatus;
  tool_count: number;
  last_error?: string;
};
