/**
 * Rich install screen for an MCP server.
 *
 * Two-step flow:
 *  1. **Detail** — server overview (icon, title, author, description, stats,
 *     transport type). If no env vars are required, a single "Install" button
 *     kicks off the install directly.
 *  2. **Configure** — env var inputs + optional raw JSON config, then install.
 *
 * Uses `mcpClientsApi.registryGet` for detail, `mcpClientsApi.install` for
 * the install itself, and best-effort `mcpClientsApi.connect` post-install.
 */
import debug from 'debug';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../lib/i18n/I18nContext';
import { mcpClientsApi } from '../../../services/api/mcpClientsApi';
import Button from '../../ui/Button';
import { deriveAuthor } from './McpServerCard';
import type { AuthPlan, InstalledServer, SmitheryConnection, SmitheryServerDetail } from './types';

const log = debug('mcp-clients:install');

type Step = 'detail' | 'configure';

interface InstallDialogProps {
  qualifiedName: string;
  prefillEnv?: Record<string, string>;
  onSuccess: (server: InstalledServer) => void;
  onCancel: () => void;
}

function pickTransportLabel(connections: SmitheryConnection[]): string | null {
  const types = new Set(connections.map(c => c.type));
  if (types.has('stdio')) return 'stdio';
  if (types.has('http')) return 'http';
  return connections[0]?.type ?? null;
}

function formatUseCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * Probe-driven auth notice shown on the install screen. One message per method
 * so the user knows up front whether they'll sign in, paste a key, or just
 * connect — and a separate warning when the registry's claim disagreed with the
 * server's actual 401 (the probe is authoritative). Renders nothing until the
 * probe resolves, or when an open server is verified (no notice needed).
 */
const AuthPlanNotice = ({ plan, serverName }: { plan: AuthPlan | null; serverName: string }) => {
  const { t } = useT();
  if (!plan) return null;

  // Only warn about a listing-vs-reality mismatch when the user still has to do
  // something different (sign in / paste a key). For a probed-OPEN server the
  // green "no sign-in required" box below already resolves it — a separate
  // warning next to it just reads as a contradiction.
  const mismatch =
    plan.mismatch && plan.confidence === 'probed' && plan.method !== 'open' ? (
      <div className="rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
        ⚠ {t('mcp.install.auth.mismatch').replace('{observed}', plan.mismatch.observed)}
      </div>
    ) : null;

  let body: ReactNode = null;
  if (plan.method === 'oauth') {
    body = (
      <div className="rounded-lg border border-primary-200 dark:border-primary-500/20 bg-primary-50 dark:bg-primary-500/10 px-4 py-3 text-sm text-primary-800 dark:text-primary-200">
        🔐 {t('mcp.install.auth.oauth').replace('{name}', serverName)}
      </div>
    );
  } else if (plan.method === 'api_key') {
    body = (
      <div className="rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
        🔑 {t('mcp.install.auth.apiKey')}
      </div>
    );
  } else if (plan.method === 'unknown') {
    body = (
      <div className="rounded-lg border border-stone-200 dark:border-neutral-700 bg-stone-50 dark:bg-neutral-800/40 px-4 py-3 text-sm text-stone-600 dark:text-neutral-300">
        {t('mcp.install.auth.unknown')}
      </div>
    );
  } else if (plan.method === 'open') {
    // A confidently-probed open server: reassure with a light note.
    body =
      plan.confidence === 'probed' ? (
        <div className="rounded-lg border border-sage-200 dark:border-sage-500/20 bg-sage-50 dark:bg-sage-500/10 px-4 py-3 text-sm text-sage-700 dark:text-sage-300">
          ✓ {t('mcp.install.auth.open')}
        </div>
      ) : null;
  }

  if (!body && !mismatch) return null;
  return (
    <div className="space-y-2">
      {mismatch}
      {body}
    </div>
  );
};

const InstallDialog = ({ qualifiedName, prefillEnv, onSuccess, onCancel }: InstallDialogProps) => {
  const { t } = useT();

  const [detail, setDetail] = useState<SmitheryServerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Probe-based auth classification (open / oauth / api_key / unknown). Loaded
  // best-effort and independently of the detail so a slow/failed probe never
  // blocks install; the notice simply doesn't render until it resolves.
  const [authPlan, setAuthPlan] = useState<AuthPlan | null>(null);
  const latestQualifiedNameRef = useRef(qualifiedName);

  const [step, setStep] = useState<Step>('detail');

  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [showEnv, setShowEnv] = useState<Record<string, boolean>>({});
  const [configJson, setConfigJson] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    latestQualifiedNameRef.current = qualifiedName;
    setLoadingDetail(true);
    setDetailError(null);
    log('fetching detail for %s', qualifiedName);
    const requestedName = qualifiedName;
    mcpClientsApi
      .registryGet(qualifiedName)
      .then(d => {
        if (latestQualifiedNameRef.current !== requestedName) return;
        setDetail(d);
        const initial: Record<string, string> = {};
        for (const key of d.required_env_keys ?? []) {
          initial[key] = prefillEnv?.[key] ?? '';
        }
        setEnvValues(initial);
        log('detail loaded, required_env_keys=%o', d.required_env_keys);
      })
      .catch(err => {
        if (latestQualifiedNameRef.current !== requestedName) return;
        const msg = err instanceof Error ? err.message : t('mcp.install.failedDetail');
        log('detail error: %s', msg);
        setDetailError(msg);
      })
      .finally(() => {
        if (latestQualifiedNameRef.current === requestedName) {
          setLoadingDetail(false);
        }
      });
  }, [qualifiedName, prefillEnv, t]);

  // Probe how this server authenticates, in parallel with the detail fetch.
  // Best-effort: any failure just leaves the notice unrendered.
  useEffect(() => {
    let cancelled = false;
    setAuthPlan(null);
    mcpClientsApi
      .probeAuth(qualifiedName)
      .then(plan => {
        if (!cancelled) setAuthPlan(plan);
      })
      .catch(err => {
        log('probe_auth failed for %s: %o', qualifiedName, err);
      });
    return () => {
      cancelled = true;
    };
  }, [qualifiedName]);

  // The live probe is authoritative. A server the probe found to be OPEN (or
  // OAuth) does NOT need the env vars the registry *declared* — the listing
  // over-declared (e.g. Google Trends MCP lists `Authorization` but the endpoint
  // is open). Override the declared keys to empty so the form never demands a
  // credential the server won't use; otherwise the screen contradicts itself
  // ("no auth required" next to "Authorization required").
  const effectiveEnvKeys = useMemo(() => {
    const authoritativeNoEnv =
      authPlan?.confidence === 'probed' &&
      (authPlan.method === 'open' || authPlan.method === 'oauth');
    return authoritativeNoEnv ? [] : (detail?.required_env_keys ?? []);
  }, [authPlan, detail]);
  const hasEnvKeys = effectiveEnvKeys.length > 0;

  const toggleShowEnv = useCallback((key: string) => {
    setShowEnv(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleEnvChange = useCallback((key: string, value: string) => {
    setEnvValues(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleInstall = useCallback(async () => {
    if (!detail) return;

    for (const key of effectiveEnvKeys) {
      if (!envValues[key]?.trim()) {
        setInstallError(t('mcp.install.missingRequired').replace('{key}', key));
        return;
      }
    }

    let parsedConfig: unknown = undefined;
    if (configJson.trim()) {
      try {
        parsedConfig = JSON.parse(configJson.trim());
      } catch {
        setInstallError(t('mcp.install.invalidJson'));
        return;
      }
    }

    setInstalling(true);
    setInstallError(null);
    log('installing %s', qualifiedName);

    try {
      const server = await mcpClientsApi.install({
        qualified_name: qualifiedName,
        env: envValues,
        config: parsedConfig,
      });
      log('install success server_id=%s', server.server_id);
      // Await the first connect so the detail view opens with an accurate
      // status rather than a stale "disconnected" that races the background
      // attempt. A failed connect is expected for servers that need auth
      // (OAuth sign-in / token) — we keep the install and let the detail view
      // surface the error and prompt to connect, so we never treat a connect
      // failure as an install failure.
      try {
        await mcpClientsApi.connect(server.server_id);
        log('auto-connect success server_id=%s', server.server_id);
      } catch (connectErr: unknown) {
        log(
          'auto-connect failed server_id=%s: %s',
          server.server_id,
          connectErr instanceof Error ? connectErr.message : String(connectErr)
        );
      }
      onSuccess(server);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('mcp.install.failedInstall');
      log('install error: %s', msg);
      setInstallError(msg);
    } finally {
      setInstalling(false);
    }
  }, [detail, effectiveEnvKeys, envValues, configJson, qualifiedName, onSuccess, t]);

  const handleDirectInstall = useCallback(async () => {
    if (hasEnvKeys) {
      setStep('configure');
      setInstallError(null);
      return;
    }
    await handleInstall();
  }, [hasEnvKeys, handleInstall]);

  // ── Loading / error states ───────────────────────────────────────────────

  if (loadingDetail) {
    return (
      <div className="py-10 text-center text-sm text-stone-400 dark:text-neutral-500">
        {t('mcp.install.loadingDetail')}
      </div>
    );
  }

  if (detailError) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-coral-200 dark:border-coral-500/30 bg-coral-50 dark:bg-coral-500/10 px-4 py-3 text-sm text-coral-700 dark:text-coral-300">
          {detailError}
        </div>
        <Button
          variant="tertiary"
          size="sm"
          onClick={onCancel}
          className="text-stone-500 dark:text-neutral-400 hover:underline">
          {t('mcp.install.back')}
        </Button>
      </div>
    );
  }

  if (!detail) return null;

  const author = deriveAuthor(qualifiedName);
  const transport = pickTransportLabel(detail.connections);

  // ── Step 1: Detail overview ──────────────────────────────────────────────

  if (step === 'detail') {
    return (
      <div className="space-y-5">
        <Button
          variant="tertiary"
          size="xs"
          onClick={onCancel}
          className="text-stone-500 dark:text-neutral-400 hover:underline">
          ← {t('mcp.install.back')}
        </Button>

        {/* Header */}
        <div className="flex items-start gap-4">
          {detail.icon_url ? (
            <img
              src={detail.icon_url}
              alt=""
              className="w-14 h-14 rounded-lg shrink-0 object-contain bg-white dark:bg-neutral-900 border border-stone-100 dark:border-neutral-800"
            />
          ) : (
            <div className="w-14 h-14 rounded-lg shrink-0 bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center text-2xl">
              🔌
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-stone-900 dark:text-neutral-100">
              {detail.display_name}
            </h3>
            {author && (
              <p className="text-sm text-stone-500 dark:text-neutral-400 mt-0.5">
                {t('mcp.install.by')} {author}
              </p>
            )}
          </div>
        </div>

        {/* Stats badges */}
        <div className="flex flex-wrap gap-2">
          {transport && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-stone-100 dark:bg-neutral-800 text-stone-600 dark:text-neutral-300">
              {transport === 'stdio'
                ? t('mcp.install.transportLocal')
                : t('mcp.install.transportRemote')}
            </span>
          )}
          {detail.use_count != null && detail.use_count > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-stone-100 dark:bg-neutral-800 text-stone-600 dark:text-neutral-300">
              {t('mcp.install.useCount').replace('{count}', formatUseCount(detail.use_count))}
            </span>
          )}
          {detail.is_deployed && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-sage-100 dark:bg-sage-500/20 text-sage-700 dark:text-sage-300">
              {t('mcp.install.deployed')}
            </span>
          )}
          {hasEnvKeys && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
              {t('mcp.install.requiresConfig')}
            </span>
          )}
        </div>

        {/* Auth notice — driven by the live probe so the user knows exactly how
            they'll connect (sign in / paste a key / nothing) before installing,
            and is warned when the registry's claim disagreed with reality. */}
        <AuthPlanNotice plan={authPlan} serverName={detail.display_name} />

        {/* Description */}
        {detail.description && (
          <div className="text-sm text-stone-600 dark:text-neutral-300 leading-relaxed whitespace-pre-line">
            {detail.description}
          </div>
        )}

        {/* Connections info */}
        {detail.connections.length > 0 && (
          <div className="rounded-lg border border-stone-150 dark:border-neutral-700/60 bg-stone-50 dark:bg-neutral-800/40 p-3">
            <p className="text-xs font-medium text-stone-500 dark:text-neutral-400 mb-2">
              {t('mcp.install.connections')}
            </p>
            <div className="space-y-1.5">
              {detail.connections.map((conn, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs text-stone-600 dark:text-neutral-300">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${conn.published ? 'bg-sage-500' : 'bg-stone-300 dark:bg-neutral-600'}`}
                  />
                  <span className="font-mono">{conn.type}</span>
                  {conn.published && (
                    <span className="text-stone-400 dark:text-neutral-500">
                      ({t('mcp.install.published')})
                    </span>
                  )}
                  {conn.deployment_url && (
                    <span className="text-stone-400 dark:text-neutral-500 truncate">
                      {conn.deployment_url}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Required env keys preview */}
        {hasEnvKeys && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 p-3">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1.5">
              {t('mcp.install.requiredEnv')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {effectiveEnvKeys.map(key => (
                <code
                  key={key}
                  className="rounded bg-amber-100 dark:bg-amber-500/20 px-1.5 py-0.5 text-xs font-mono text-amber-800 dark:text-amber-200">
                  {key}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* Install error (shown when no-config install fails) */}
        {installError && (
          <div className="rounded-lg border border-coral-200 dark:border-coral-500/30 bg-coral-50 dark:bg-coral-500/10 px-4 py-3 text-sm text-coral-700 dark:text-coral-300">
            {installError}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button
            variant="primary"
            size="lg"
            disabled={installing}
            onClick={() => void handleDirectInstall()}>
            {installing
              ? t('mcp.install.installing')
              : hasEnvKeys
                ? t('mcp.install.configureAndInstall')
                : t('mcp.install.button')}
          </Button>
          <Button variant="secondary" size="lg" disabled={installing} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  // ── Step 2: Configure & install ──────────────────────────────────────────

  return (
    <div className="space-y-4">
      <Button
        variant="tertiary"
        size="xs"
        onClick={() => {
          setStep('detail');
          setInstallError(null);
        }}
        className="text-stone-500 dark:text-neutral-400 hover:underline">
        ← {detail.display_name}
      </Button>

      {/* Compact header */}
      <div className="flex items-center gap-3">
        {detail.icon_url ? (
          <img
            src={detail.icon_url}
            alt=""
            className="w-8 h-8 rounded shrink-0 object-contain bg-white dark:bg-neutral-900"
          />
        ) : (
          <div className="w-8 h-8 rounded shrink-0 bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center text-sm">
            🔌
          </div>
        )}
        <h3 className="text-base font-semibold text-stone-900 dark:text-neutral-100">
          {t('mcp.install.configureTitle').replace('{name}', detail.display_name)}
        </h3>
      </div>

      {/* Env var inputs */}
      {hasEnvKeys && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-stone-700 dark:text-neutral-300">
            {t('mcp.install.requiredEnv')}
          </p>
          {detail.required_env_keys!.map(key => (
            <div key={key} className="space-y-1">
              <label
                htmlFor={`env-${key}`}
                className="block text-xs font-medium text-stone-600 dark:text-neutral-400 font-mono">
                {key}
              </label>
              <div className="flex gap-2">
                <input
                  id={`env-${key}`}
                  type={showEnv[key] ? 'text' : 'password'}
                  value={envValues[key] ?? ''}
                  onChange={e => handleEnvChange(key, e.target.value)}
                  placeholder={t('mcp.install.enterValue').replace('{key}', key)}
                  disabled={installing}
                  className="flex-1 rounded-lg border border-stone-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-stone-800 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => toggleShowEnv(key)}
                  disabled={installing}
                  className="shrink-0">
                  {showEnv[key] ? t('mcp.install.hide') : t('mcp.install.show')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Advanced: optional JSON config */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-stone-500 dark:text-neutral-400 hover:text-stone-700 dark:hover:text-neutral-200 transition-colors">
          {showAdvanced ? '▾' : '▸'} {t('mcp.install.advancedConfig')}
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-1">
            <label
              htmlFor="mcp-config-json"
              className="block text-xs font-medium text-stone-600 dark:text-neutral-400">
              {t('mcp.install.configLabel')}
            </label>
            <textarea
              id="mcp-config-json"
              value={configJson}
              onChange={e => setConfigJson(e.target.value)}
              disabled={installing}
              rows={4}
              placeholder={t('mcp.install.configPlaceholder')}
              className="w-full rounded-lg border border-stone-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm font-mono text-stone-800 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50 resize-y"
            />
          </div>
        )}
      </div>

      {/* Errors */}
      {installError && (
        <div className="rounded-lg border border-coral-200 dark:border-coral-500/30 bg-coral-50 dark:bg-coral-500/10 px-4 py-3 text-sm text-coral-700 dark:text-coral-300">
          {installError}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          size="lg"
          disabled={installing}
          onClick={() => void handleInstall()}>
          {installing ? t('mcp.install.installing') : t('mcp.install.button')}
        </Button>
        <Button variant="secondary" size="lg" disabled={installing} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};

export default InstallDialog;
