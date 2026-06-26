/**
 * ConnectAuthModal — opened when the user clicks "Connect"/"Sign in" on an
 * installed MCP server. It renders the auth the *server itself declares*, so
 * each server asks for exactly what it needs instead of a one-size-fits-all box:
 *
 *   • OAuth — when a live probe (`detect_auth`) sees a browser sign-in
 *     challenge, we show a single "Sign in" button and no token field.
 *   • Declared fields — the registry's `connections[].config_schema` lists each
 *     required input by name (`Authorization`, `X-API-Key`, `GITHUB_TOKEN`, …)
 *     with a human description that often carries a "get your key at <url>"
 *     link. We render one labelled (secret) input per field and linkify the URL.
 *   • Custom headers — a free-form fallback for mislabelled remotes that declare
 *     no auth but still want a header (kept behind the declared fields).
 *
 * Only fields the server marks `required` or `isSecret` are shown; pure config
 * (log level, port…) is left to the server's defaults. On submit, non-empty
 * values persist via `update_env` (stored encrypted, then reconnect); for
 * HTTP-remote installs each entry becomes a request header (core
 * `build_http_auth`). With nothing supplied we just connect — open servers need
 * no auth.
 */
import debug from 'debug';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { useT } from '../../../lib/i18n/I18nContext';
import { mcpClientsApi } from '../../../services/api/mcpClientsApi';
import { openUrl } from '../../../utils/openUrl';
import Button from '../../ui/Button';
import ConfigHelpModal from './ConfigHelpModal';
import type { InstalledServer, McpTool, SmitheryServerDetail } from './types';

const log = debug('mcp-clients:connect-auth');

interface ConnectAuthModalProps {
  server: InstalledServer;
  onClose: () => void;
  /** Called with the connected server's tools once connect succeeds. */
  onConnected: (tools: McpTool[]) => void;
}

/** An auth input the server declares it needs. */
interface AuthField {
  /** Header or env-var name, e.g. `Authorization`, `X-API-Key`, `GITHUB_TOKEN`. */
  name: string;
  /** Human hint from the registry (may contain a "get your key" URL). */
  description?: string;
  /** Masked input + never echoed back. */
  secret: boolean;
  /** Must be supplied (unless already stored on the install). */
  required: boolean;
}

interface CustomHeader {
  id: number;
  name: string;
  value: string;
  /** `bearer` prepends `Bearer ` to the value (the common case); `raw` sends
   * the value verbatim (for API-key headers or other schemes). */
  scheme: 'bearer' | 'raw';
}

/** Apply a header scheme to a value: `bearer` prepends `Bearer ` unless the
 * value already carries a scheme; `raw` is verbatim. */
const applyScheme = (scheme: 'bearer' | 'raw', value: string): string => {
  const v = value.trim();
  if (!v) return v;
  if (scheme === 'bearer' && !/^bearer\s/i.test(v)) return `Bearer ${v}`;
  return v;
};

/** Whether a field name is an `Authorization` header (offers a Bearer scheme). */
const isAuthorizationField = (name: string): boolean => name.toLowerCase() === 'authorization';

/** Merge a field into a by-name map: keep the first description/secret seen,
 * OR the `required` flag (any source marking it required wins). */
const upsertField = (map: Map<string, AuthField>, f: AuthField): void => {
  const prev = map.get(f.name);
  if (!prev) {
    map.set(f.name, f);
    return;
  }
  map.set(f.name, {
    name: f.name,
    description: prev.description ?? f.description,
    secret: prev.secret || f.secret,
    required: prev.required || f.required,
  });
};

/** Extract declared auth fields from a registry detail's connection schemas
 * (and its flattened `required_env_keys`, for back-compat). */
const fieldsFromDetail = (detail: SmitheryServerDetail): AuthField[] => {
  const map = new Map<string, AuthField>();
  for (const conn of detail.connections ?? []) {
    const schema = conn.config_schema as
      | {
          properties?: Record<string, { description?: string; 'x-secret'?: boolean }>;
          required?: string[];
        }
      | undefined;
    const props = schema?.properties;
    const required = Array.isArray(schema?.required) ? schema!.required! : [];
    if (props && typeof props === 'object') {
      for (const [name, prop] of Object.entries(props)) {
        upsertField(map, {
          name,
          description: prop?.description,
          secret: prop?.['x-secret'] === true,
          required: required.includes(name),
        });
      }
    }
  }
  for (const name of detail.required_env_keys ?? []) {
    upsertField(map, { name, secret: true, required: true });
  }
  return Array.from(map.values());
};

const URL_RE = /(https?:\/\/[^\s)]+)/g;

const ConnectAuthModal = ({ server, onClose, onConnected }: ConnectAuthModalProps) => {
  const { t } = useT();
  // Declared auth fields. Seeded from the install's stored keys (names only),
  // then enriched by a best-effort registry_get that carries each field's
  // description / secret / required metadata. `__`-prefixed keys are internal
  // bookkeeping (OAuth refresh bundle) — never render them.
  const [fields, setFields] = useState<AuthField[]>(() =>
    server.env_keys
      .filter(k => !k.startsWith('__'))
      .map(name => ({ name, secret: true, required: false }))
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  // Per-Authorization-field scheme (the registry gives a free-text description,
  // not Bearer-vs-raw — so the user picks). Defaults to Bearer.
  const [authSchemes, setAuthSchemes] = useState<Record<string, 'bearer' | 'raw'>>({});
  const schemeFor = useCallback(
    (name: string): 'bearer' | 'raw' =>
      authSchemes[name] ?? (isAuthorizationField(name) ? 'bearer' : 'raw'),
    [authSchemes]
  );
  const [customHeaders, setCustomHeaders] = useState<CustomHeader[]>([]);
  const [nextId, setNextId] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Detected auth style: drives whether we show "Sign in" (browser OAuth) vs.
  // the token/header fields. `detecting` until the probe returns.
  const [authKind, setAuthKind] = useState<'detecting' | 'none' | 'token' | 'oauth'>('detecting');
  const [oauthWaiting, setOauthWaiting] = useState(false);
  const [showConfigHelp, setShowConfigHelp] = useState(false);

  // Only surface fields the server actually wants from the user: required
  // inputs and secrets. Pure config (log level, port, …) keeps server defaults.
  const visibleFields = useMemo(() => fields.filter(f => f.required || f.secret), [fields]);

  // Probe how this server authenticates so we render the right control. The
  // registry can't always tell us, so we ask the server.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await mcpClientsApi.detectAuth(server.server_id);
        if (!cancelled) setAuthKind(d.kind);
      } catch (err) {
        log('detect_auth failed (non-fatal): %s', err instanceof Error ? err.message : err);
        if (!cancelled) setAuthKind('token');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server.server_id]);

  // Browser-OAuth: begin (discover + DCR + PKCE), open the authorize URL, then
  // poll until the /oauth/mcp/callback route has stored the token + reconnected.
  const handleOAuth = useCallback(() => {
    setBusy(true);
    setError(null);
    setOauthWaiting(true);
    void (async () => {
      try {
        const url = await mcpClientsApi.oauthBegin(server.server_id);
        await openUrl(url);
        const started = Date.now();
        const poll = async (): Promise<void> => {
          const statuses = await mcpClientsApi.status();
          const mine = statuses.find(s => s.server_id === server.server_id);
          if (mine?.status === 'connected') {
            const result = await mcpClientsApi.connect(server.server_id);
            onConnected(result.tools ?? []);
            onClose();
            return;
          }
          if (Date.now() - started > 180000) {
            throw new Error(t('mcp.connectAuth.oauthTimeout'));
          }
          window.setTimeout(() => {
            void poll().catch(handlePollError);
          }, 2500);
        };
        const handlePollError = (err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          setOauthWaiting(false);
          setBusy(false);
        };
        await poll().catch(handlePollError);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('oauth failed: %s', msg);
        setError(msg);
        setOauthWaiting(false);
        setBusy(false);
      }
    })();
  }, [server.server_id, onConnected, onClose, t]);

  // Best-effort: pull the registry's declared fields (names + descriptions +
  // secret/required), so a server that labels its auth shows tailored inputs.
  // Network failures are non-fatal — we keep the install's own keys.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await mcpClientsApi.registryGet(server.qualified_name);
        if (cancelled) return;
        const declared = fieldsFromDetail(detail);
        setFields(prev => {
          const map = new Map<string, AuthField>();
          for (const f of prev) upsertField(map, f);
          for (const f of declared) upsertField(map, f);
          return Array.from(map.values());
        });
      } catch (err) {
        log('registry_get failed (non-fatal): %s', err instanceof Error ? err.message : err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server.qualified_name]);

  // Seed a blank custom-header row only when the server declares nothing AND
  // isn't an OAuth sign-in — i.e. the mislabelled-remote case where the user
  // nonetheless has a token to paste. OAuth servers get the sign-in button, not
  // a token box (this is what stops "paste a token and hope" failures).
  useEffect(() => {
    if (
      visibleFields.length === 0 &&
      customHeaders.length === 0 &&
      authKind !== 'oauth' &&
      authKind !== 'detecting'
    ) {
      setCustomHeaders([{ id: 0, name: 'Authorization', value: '', scheme: 'bearer' }]);
    }
  }, [visibleFields.length, customHeaders.length, authKind]);

  const addCustomHeader = useCallback(() => {
    setCustomHeaders(prev => [...prev, { id: nextId, name: '', value: '', scheme: 'bearer' }]);
    setNextId(n => n + 1);
  }, [nextId]);

  const removeCustomHeader = useCallback((id: number) => {
    setCustomHeaders(prev => prev.filter(h => h.id !== id));
  }, []);

  const handleConnect = useCallback(() => {
    // A required field is only "missing" when it's blank now AND wasn't already
    // stored on the install (re-opening Connect shouldn't force re-entry).
    const stored = new Set(server.env_keys);
    const missing = visibleFields.find(
      f => f.required && !stored.has(f.name) && !values[f.name]?.trim()
    );
    if (missing) {
      setError(t('mcp.install.missingRequired').replace('{key}', missing.name));
      return;
    }

    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // Build the env/header map: declared values + named custom headers,
        // skipping blanks so we never store empty keys.
        const env: Record<string, string> = {};
        for (const f of visibleFields) {
          const v = values[f.name]?.trim();
          if (v) env[f.name] = applyScheme(schemeFor(f.name), v);
        }
        for (const h of customHeaders) {
          const name = h.name.trim();
          const value = applyScheme(h.scheme, h.value);
          if (name && value) env[name] = value;
        }

        let tools: McpTool[] = [];
        if (Object.keys(env).length > 0) {
          log('connect-with-auth server_id=%s keys=%o', server.server_id, Object.keys(env));
          const result = await mcpClientsApi.updateEnv({ server_id: server.server_id, env });
          if (result.status !== 'connected') {
            throw new Error(result.error ?? t('mcp.connectAuth.reconnectFailed'));
          }
          tools = result.tools ?? [];
        } else {
          log('connect (no auth supplied) server_id=%s', server.server_id);
          const result = await mcpClientsApi.connect(server.server_id);
          tools = result.tools ?? [];
        }
        onConnected(tools);
        onClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('connect failed: %s', msg);
        setError(msg);
      } finally {
        setBusy(false);
      }
    })();
  }, [
    visibleFields,
    values,
    customHeaders,
    schemeFor,
    server.server_id,
    server.env_keys,
    onConnected,
    onClose,
    t,
  ]);

  // Render a field description, linkifying any http(s) URL so the user can jump
  // straight to the "get your key" page.
  const renderDescription = useCallback(
    (text: string): ReactNode =>
      text.split(URL_RE).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <button
            key={i}
            type="button"
            onClick={() => void openUrl(part)}
            className="text-primary-600 dark:text-primary-400 hover:underline break-all">
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        )
      ),
    []
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('mcp.connectAuth.title').replace('{name}', server.display_name)}
      onMouseDown={e => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-xl bg-surface border border-line shadow-xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-content">
            {t('mcp.connectAuth.title').replace('{name}', server.display_name)}
          </h3>
          <p className="text-xs text-content-muted mt-1">{t('mcp.connectAuth.hint')}</p>
          <button
            type="button"
            onClick={() => setShowConfigHelp(true)}
            className="mt-1 text-[11px] font-medium text-primary-600 dark:text-primary-400 hover:underline">
            {t('mcp.connectAuth.howToGetToken')}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-coral-200 dark:border-coral-500/30 bg-coral-50 dark:bg-coral-500/10 px-3 py-2 text-xs text-coral-700 dark:text-coral-300 break-words">
            {error}
          </div>
        )}

        {/* Browser OAuth — shown when detection says this server needs a sign-in. */}
        {authKind === 'oauth' && (
          <div className="space-y-2 rounded-lg border border-primary-200 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10 p-3">
            <p className="text-xs text-content-secondary">{t('mcp.connectAuth.oauthHint')}</p>
            <Button variant="primary" size="sm" onClick={handleOAuth} disabled={busy}>
              {oauthWaiting ? t('mcp.connectAuth.oauthWaiting') : t('mcp.connectAuth.signIn')}
            </Button>
            <p className="text-[11px] text-content-faint">{t('mcp.connectAuth.oauthOrToken')}</p>
          </div>
        )}

        {/* Declared fields — one labelled input per key the server asks for. */}
        {visibleFields.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-content-faint">
              {t('mcp.connectAuth.requiredLabel')}
            </p>
            {visibleFields.map(field => (
              <div key={field.name} className="space-y-1">
                <div className="flex items-center gap-0.5">
                  <label
                    htmlFor={`auth-${field.name}`}
                    className="block text-[11px] font-medium text-content-secondary font-mono">
                    {field.name}
                  </label>
                  {field.required && (
                    <span
                      aria-hidden="true"
                      title={t('mcp.connectAuth.requiredLabel')}
                      className="text-[11px] text-coral-500">
                      *
                    </span>
                  )}
                </div>
                {field.description && (
                  <p className="text-[11px] text-content-faint leading-snug">
                    {renderDescription(field.description)}
                  </p>
                )}
                <div className="flex gap-2">
                  {isAuthorizationField(field.name) && (
                    <select
                      value={schemeFor(field.name)}
                      onChange={e =>
                        setAuthSchemes(prev => ({
                          ...prev,
                          [field.name]: e.target.value as 'bearer' | 'raw',
                        }))
                      }
                      disabled={busy}
                      title={t('mcp.connectAuth.schemeLabel')}
                      className="shrink-0 rounded-lg border border-line bg-surface px-1.5 py-1.5 text-[11px] text-content-secondary focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50">
                      <option value="bearer">{t('mcp.connectAuth.schemeBearer')}</option>
                      <option value="raw">{t('mcp.connectAuth.schemeRaw')}</option>
                    </select>
                  )}
                  <input
                    id={`auth-${field.name}`}
                    type={field.secret && !reveal[field.name] ? 'password' : 'text'}
                    value={values[field.name] ?? ''}
                    onChange={e => setValues(prev => ({ ...prev, [field.name]: e.target.value }))}
                    placeholder={t('mcp.install.enterValue').replace('{key}', field.name)}
                    disabled={busy}
                    // Suppress Chromium password-manager autofill so a token saved
                    // for one MCP doesn't pre-fill another's field.
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-content placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50"
                  />
                  {field.secret && (
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() =>
                        setReveal(prev => ({ ...prev, [field.name]: !prev[field.name] }))
                      }
                      disabled={busy}
                      className="shrink-0">
                      {reveal[field.name] ? t('mcp.install.hide') : t('mcp.install.show')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Custom headers — free-form fallback for servers that declare no auth. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wide text-content-faint">
              {t('mcp.connectAuth.customHeadersLabel')}
            </p>
            <button
              type="button"
              onClick={addCustomHeader}
              disabled={busy}
              className="text-[11px] font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50">
              {t('mcp.connectAuth.addHeader')}
            </button>
          </div>
          {customHeaders.length === 0 && (
            <p className="text-[11px] text-content-faint">
              {t('mcp.connectAuth.customHeadersEmpty')}
            </p>
          )}
          {customHeaders.map(h => (
            <div key={h.id} className="space-y-1.5 rounded-lg border border-line p-2">
              {/* Row 1: header name + scheme + remove */}
              <div className="flex gap-2">
                <input
                  value={h.name}
                  onChange={e =>
                    setCustomHeaders(prev =>
                      prev.map(x => (x.id === h.id ? { ...x, name: e.target.value } : x))
                    )
                  }
                  placeholder={t('mcp.connectAuth.headerName')}
                  disabled={busy}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  className="flex-1 min-w-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-mono text-content placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50"
                />
                <select
                  value={h.scheme}
                  onChange={e =>
                    setCustomHeaders(prev =>
                      prev.map(x =>
                        x.id === h.id ? { ...x, scheme: e.target.value as 'bearer' | 'raw' } : x
                      )
                    )
                  }
                  disabled={busy}
                  title={t('mcp.connectAuth.schemeLabel')}
                  className="shrink-0 rounded-lg border border-line bg-surface px-1.5 py-1.5 text-[11px] text-content-secondary focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50">
                  <option value="bearer">{t('mcp.connectAuth.schemeBearer')}</option>
                  <option value="raw">{t('mcp.connectAuth.schemeRaw')}</option>
                </select>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => removeCustomHeader(h.id)}
                  disabled={busy}
                  aria-label={t('mcp.connectAuth.removeHeader')}
                  className="shrink-0">
                  ✕
                </Button>
              </div>
              {/* Row 2: full-width value (tokens are long) */}
              <input
                type="password"
                value={h.value}
                onChange={e =>
                  setCustomHeaders(prev =>
                    prev.map(x => (x.id === h.id ? { ...x, value: e.target.value } : x))
                  )
                }
                placeholder={t('mcp.connectAuth.headerValue')}
                disabled={busy}
                // Suppress Chromium password-manager autofill (token leakage
                // across MCP servers on the shared app origin).
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-content placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50"
              />
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleConnect} disabled={busy}>
            {busy ? t('mcp.detail.connecting') : t('mcp.detail.connect')}
          </Button>
        </div>
      </div>

      {/* Stacked configuration-help chat modal (above this one). */}
      {showConfigHelp && (
        <ConfigHelpModal
          qualifiedName={server.qualified_name}
          displayName={server.display_name}
          description={server.description}
          onClose={() => setShowConfigHelp(false)}
        />
      )}
    </div>
  );
};

export default ConnectAuthModal;
