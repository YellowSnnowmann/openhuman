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
   * `true` for a hosted server whose service we've confirmed connects. The core
   * keeps only curated canonical rows and verified servers; the unverified long
   * tail is dropped server-side, so the catalog renders the vetted set directly
   * with nothing hidden behind a toggle.
   */
  verified?: boolean;
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
