/**
 * CronJobFormModal — Create / Edit cron job form modal.
 *
 * Reachable from CronJobsPanel via the "+ New Scheduled Job" button (create)
 * or the "Edit" button per job row (edit).
 */
import createDebug from 'debug';
import { useEffect, useState } from 'react';

import { useT } from '../../../../lib/i18n/I18nContext';
import { cronToHuman } from '../../../../lib/cron/cronToHuman';
import { SCHEDULE_PRESETS, SCHEDULE_PRESET_VALUES } from '../../../../lib/cron/schedulePresets';
import type {
  CoreCronJob,
  CoreCronSchedule,
  CronAddParams,
} from '../../../../utils/tauriCommands/cron';

const log = createDebug('app:settings:CronJobFormModal');

// ── Types ──────────────────────────────────────────────────────────────

type JobType = 'agent' | 'shell';
type ScheduleKind = 'cron' | 'at' | 'every';
type DeliveryMode = 'none' | 'proactive';
type SessionTarget = 'isolated' | 'main';

export interface CronJobFormModalProps {
  mode: 'create' | 'edit';
  job?: CoreCronJob;
  open: boolean;
  onClose: () => void;
  onCreate: (params: CronAddParams) => Promise<void>;
  onUpdate: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildSchedule(
  kind: ScheduleKind,
  cronExpr: string,
  atValue: string,
  everyMs: string
): CoreCronSchedule | null {
  if (kind === 'cron') {
    const expr = cronExpr.trim();
    if (!expr) return null;
    return { kind: 'cron', expr, tz: null };
  }
  if (kind === 'at') {
    if (!atValue) return null;
    return { kind: 'at', at: new Date(atValue).toISOString() };
  }
  if (kind === 'every') {
    const ms = parseInt(everyMs, 10);
    if (!ms || ms <= 0) return null;
    return { kind: 'every', every_ms: ms };
  }
  return null;
}

function getInitialScheduleKind(job: CoreCronJob): ScheduleKind {
  return job.schedule.kind;
}

function getInitialCronExpr(job: CoreCronJob): string {
  return job.schedule.kind === 'cron' ? job.schedule.expr : '';
}

function getInitialAtValue(job: CoreCronJob): string {
  if (job.schedule.kind === 'at') {
    // Convert ISO to datetime-local format (YYYY-MM-DDTHH:MM)
    try {
      const d = new Date(job.schedule.at);
      const offset = d.getTimezoneOffset();
      const local = new Date(d.getTime() - offset * 60000);
      return local.toISOString().slice(0, 16);
    } catch {
      return '';
    }
  }
  return '';
}

function getInitialEveryMs(job: CoreCronJob): string {
  return job.schedule.kind === 'every' ? String(job.schedule.every_ms) : '';
}

function getInitialDelivery(job: CoreCronJob): DeliveryMode {
  return job.delivery.mode === 'proactive' ? 'proactive' : 'none';
}

// ── Component ──────────────────────────────────────────────────────────

const CronJobFormModal = ({
  mode,
  job,
  open,
  onClose,
  onCreate,
  onUpdate,
}: CronJobFormModalProps) => {
  const { t } = useT();

  // ── Form state ─────────────────────────────────────────────────────

  const [name, setName] = useState('');
  const [jobType, setJobType] = useState<JobType>('agent');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('cron');
  const [cronPreset, setCronPreset] = useState<string>(SCHEDULE_PRESETS[0].value);
  const [cronCustom, setCronCustom] = useState('');
  const [atValue, setAtValue] = useState('');
  const [everyMs, setEveryMs] = useState('');
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [sessionTarget, setSessionTarget] = useState<SessionTarget>('isolated');
  const [delivery, setDelivery] = useState<DeliveryMode>('proactive');
  const [deleteAfterRun, setDeleteAfterRun] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Effective cron expression: if preset is selected use its value, else custom
  const cronExpr = SCHEDULE_PRESET_VALUES.has(cronPreset) ? cronPreset : cronCustom.trim();

  // ── Prefill in edit mode ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    if (mode === 'edit' && job) {
      log('[CronJobFormModal] prefilling from job %s', job.id);
      setName(job.name ?? '');
      setJobType(job.job_type === 'shell' ? 'shell' : 'agent');
      const sk = getInitialScheduleKind(job);
      setScheduleKind(sk);
      if (sk === 'cron') {
        const expr = getInitialCronExpr(job);
        if (SCHEDULE_PRESET_VALUES.has(expr)) {
          setCronPreset(expr);
          setCronCustom('');
        } else {
          setCronPreset('');
          setCronCustom(expr);
        }
      } else if (sk === 'at') {
        setAtValue(getInitialAtValue(job));
      } else if (sk === 'every') {
        setEveryMs(getInitialEveryMs(job));
      }
      setPrompt(job.prompt ?? '');
      setCommand(job.command ?? '');
      setSessionTarget(job.session_target === 'main' ? 'main' : 'isolated');
      setDelivery(getInitialDelivery(job));
      setDeleteAfterRun(job.delete_after_run);
    } else {
      log('[CronJobFormModal] resetting form for create mode');
      setName('');
      setJobType('agent');
      setScheduleKind('cron');
      setCronPreset(SCHEDULE_PRESETS[0].value);
      setCronCustom('');
      setAtValue('');
      setEveryMs('');
      setPrompt('');
      setCommand('');
      setSessionTarget('isolated');
      setDelivery('proactive');
      setDeleteAfterRun(false);
    }
    setError(null);
    setSaving(false);
  }, [open, mode, job]);

  // Auto-set deleteAfterRun default when schedule kind switches to 'at'
  useEffect(() => {
    if (scheduleKind === 'at') {
      setDeleteAfterRun(true);
    } else if (mode === 'create') {
      setDeleteAfterRun(false);
    }
  }, [scheduleKind, mode]);

  // ── Validation ──────────────────────────────────────────────────────
  const schedule = buildSchedule(scheduleKind, cronExpr, atValue, everyMs);
  const isScheduleValid = schedule !== null;
  const isPromptValid = jobType !== 'agent' || prompt.trim().length > 0;
  const isCommandValid = jobType !== 'shell' || command.trim().length > 0;
  const canSubmit = isScheduleValid && isPromptValid && isCommandValid && !saving;

  // ── Submit ──────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!canSubmit || !schedule) return;
    setError(null);
    setSaving(true);

    log('[CronJobFormModal] submit mode=%s, jobType=%s, scheduleKind=%s', mode, jobType, scheduleKind);

    try {
      if (mode === 'create') {
        const params: CronAddParams = {
          name: name.trim() || undefined,
          schedule,
          job_type: jobType,
          ...(jobType === 'agent' ? { prompt: prompt.trim() } : {}),
          ...(jobType === 'shell' ? { command: command.trim() } : {}),
          ...(jobType === 'agent' ? { session_target: sessionTarget } : {}),
          ...(jobType === 'agent'
            ? { delivery: { mode: delivery, best_effort: true } }
            : { delivery: { mode: 'none', best_effort: false } }),
          delete_after_run: deleteAfterRun,
        };
        log('[CronJobFormModal] calling onCreate with params: %o', params);
        await onCreate(params);
      } else {
        if (!job) return;
        const patch: Record<string, unknown> = {
          name: name.trim() || null,
          schedule,
          ...(jobType === 'agent' ? { prompt: prompt.trim() } : {}),
          ...(jobType === 'shell' ? { command: command.trim() } : {}),
          ...(jobType === 'agent' ? { session_target: sessionTarget } : {}),
          ...(jobType === 'agent'
            ? { delivery: { mode: delivery, best_effort: true } }
            : { delivery: { mode: 'none', best_effort: false } }),
          delete_after_run: deleteAfterRun,
        };
        log('[CronJobFormModal] calling onUpdate for job %s with patch: %o', job.id, patch);
        await onUpdate(job.id, patch);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('[CronJobFormModal] save error: %s', msg);
      setError(t('settings.cron.jobs.formError'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  // ── Render ──────────────────────────────────────────────────────────
  const title = mode === 'create'
    ? t('settings.cron.jobs.createJob')
    : t('settings.cron.jobs.editJob');

  const submitLabel = saving
    ? t('settings.cron.jobs.formSaving')
    : mode === 'create'
      ? t('settings.cron.jobs.formCreate')
      : t('settings.cron.jobs.formSave');

  return (
    <div
      data-testid="cron-form-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Card */}
      <div className="relative z-10 w-full max-w-lg bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-stone-200 dark:border-neutral-800 flex flex-col max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 dark:border-neutral-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-900 dark:text-neutral-100">
            {title}
          </h2>
          <button
            type="button"
            data-testid="cron-form-cancel"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors text-xl leading-none">
            &times;
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-6 py-4 flex flex-col gap-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
              {t('settings.cron.jobs.formName')}
            </label>
            <input
              data-testid="cron-form-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('settings.cron.jobs.formNamePlaceholder')}
              disabled={saving}
              className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
            />
          </div>

          {/* Job type */}
          <div>
            <div className="text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1.5">
              {t('settings.cron.jobs.formJobType')}
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-neutral-300 cursor-pointer">
                <input
                  data-testid="cron-form-job-type-agent"
                  type="radio"
                  name="cron-job-type"
                  value="agent"
                  checked={jobType === 'agent'}
                  onChange={() => setJobType('agent')}
                  disabled={mode === 'edit' || saving}
                  className="accent-primary-600"
                />
                {t('settings.cron.jobs.formJobTypeAgent')}
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-neutral-300 cursor-pointer">
                <input
                  data-testid="cron-form-job-type-shell"
                  type="radio"
                  name="cron-job-type"
                  value="shell"
                  checked={jobType === 'shell'}
                  onChange={() => setJobType('shell')}
                  disabled={mode === 'edit' || saving}
                  className="accent-primary-600"
                />
                {t('settings.cron.jobs.formJobTypeShell')}
              </label>
            </div>
          </div>

          {/* Schedule type */}
          <div>
            <div className="text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1.5">
              {t('settings.cron.jobs.formScheduleType')}
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-neutral-300 cursor-pointer">
                <input
                  data-testid="cron-form-schedule-cron"
                  type="radio"
                  name="cron-schedule-kind"
                  value="cron"
                  checked={scheduleKind === 'cron'}
                  onChange={() => setScheduleKind('cron')}
                  disabled={saving}
                  className="accent-primary-600"
                />
                {t('settings.cron.jobs.formScheduleCron')}
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-neutral-300 cursor-pointer">
                <input
                  data-testid="cron-form-schedule-at"
                  type="radio"
                  name="cron-schedule-kind"
                  value="at"
                  checked={scheduleKind === 'at'}
                  onChange={() => setScheduleKind('at')}
                  disabled={saving}
                  className="accent-primary-600"
                />
                {t('settings.cron.jobs.formScheduleAt')}
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-neutral-300 cursor-pointer">
                <input
                  data-testid="cron-form-schedule-every"
                  type="radio"
                  name="cron-schedule-kind"
                  value="every"
                  checked={scheduleKind === 'every'}
                  onChange={() => setScheduleKind('every')}
                  disabled={saving}
                  className="accent-primary-600"
                />
                {t('settings.cron.jobs.formScheduleEvery')}
              </label>
            </div>
          </div>

          {/* Cron schedule fields */}
          {scheduleKind === 'cron' && (
            <div className="flex flex-col gap-2">
              {/* Preset dropdown */}
              <div>
                <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                  {t('settings.cron.jobs.formCronPreset')}
                </label>
                <select
                  data-testid="cron-form-cron-preset"
                  value={SCHEDULE_PRESET_VALUES.has(cronPreset) ? cronPreset : ''}
                  onChange={e => {
                    const val = e.target.value;
                    if (val) {
                      setCronPreset(val);
                      setCronCustom('');
                    } else {
                      setCronPreset('');
                    }
                  }}
                  disabled={saving}
                  className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50">
                  <option value="">{t('settings.cron.jobs.custom')}</option>
                  {SCHEDULE_PRESETS.map(p => (
                    <option key={p.value} value={p.value}>
                      {t(p.labelKey)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Custom expression — shown when no preset selected or user typed */}
              {(!SCHEDULE_PRESET_VALUES.has(cronPreset) || cronCustom) && (
                <div>
                  <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                    {t('settings.cron.jobs.formCronCustom')}
                  </label>
                  <input
                    data-testid="cron-form-cron-custom"
                    type="text"
                    value={cronCustom}
                    onChange={e => {
                      const val = e.target.value;
                      setCronCustom(val);
                      // Reset preset to custom sentinel
                      if (!SCHEDULE_PRESET_VALUES.has(val.trim())) {
                        setCronPreset('');
                      } else {
                        setCronPreset(val.trim());
                      }
                    }}
                    placeholder={t('settings.cron.jobs.formCronCustomPlaceholder')}
                    disabled={saving}
                    className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm font-mono text-stone-900 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
                  />
                </div>
              )}

              {/* Live preview */}
              {cronExpr && (
                <p
                  data-testid="cron-form-cron-preview"
                  className="text-xs text-stone-500 dark:text-neutral-400">
                  {t('settings.cron.jobs.formCronPreview').replace('{{preview}}', cronToHuman(cronExpr))}
                </p>
              )}
            </div>
          )}

          {/* At */}
          {scheduleKind === 'at' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                {t('settings.cron.jobs.formAtLabel')}
              </label>
              <input
                data-testid="cron-form-at"
                type="datetime-local"
                value={atValue}
                onChange={e => setAtValue(e.target.value)}
                disabled={saving}
                className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
              />
            </div>
          )}

          {/* Every */}
          {scheduleKind === 'every' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                {t('settings.cron.jobs.formEveryLabel')}
              </label>
              <input
                data-testid="cron-form-every"
                type="number"
                min="1"
                value={everyMs}
                onChange={e => setEveryMs(e.target.value)}
                disabled={saving}
                placeholder="e.g. 3600000"
                className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
              />
            </div>
          )}

          {/* Prompt (agent only) */}
          {jobType === 'agent' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                {t('settings.cron.jobs.formPrompt')}
                <span className="text-coral-500 ml-0.5">*</span>
              </label>
              <textarea
                data-testid="cron-form-prompt"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={t('settings.cron.jobs.formPromptPlaceholder')}
                rows={4}
                disabled={saving}
                className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 resize-y"
              />
            </div>
          )}

          {/* Command (shell only) */}
          {jobType === 'shell' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                {t('settings.cron.jobs.formCommand')}
                <span className="text-coral-500 ml-0.5">*</span>
              </label>
              <input
                data-testid="cron-form-command"
                type="text"
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder={t('settings.cron.jobs.formCommandPlaceholder')}
                disabled={saving}
                className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm font-mono text-stone-900 dark:text-neutral-100 placeholder:text-stone-400 dark:placeholder:text-neutral-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
              />
            </div>
          )}

          {/* Session target (agent only) */}
          {jobType === 'agent' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                {t('settings.cron.jobs.formSessionTarget')}
              </label>
              <select
                data-testid="cron-form-session-target"
                value={sessionTarget}
                onChange={e => setSessionTarget(e.target.value as SessionTarget)}
                disabled={saving}
                className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50">
                <option value="isolated">{t('settings.cron.jobs.formSessionIsolated')}</option>
                <option value="main">{t('settings.cron.jobs.formSessionMain')}</option>
              </select>
            </div>
          )}

          {/* Delivery mode (agent only) */}
          {jobType === 'agent' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 dark:text-neutral-300 mb-1">
                {t('settings.cron.jobs.formDelivery')}
              </label>
              <select
                data-testid="cron-form-delivery"
                value={delivery}
                onChange={e => setDelivery(e.target.value as DeliveryMode)}
                disabled={saving}
                className="w-full rounded-md border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-stone-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50">
                <option value="proactive">{t('settings.cron.jobs.formDeliveryProactive')}</option>
                <option value="none">{t('settings.cron.jobs.formDeliveryNone')}</option>
              </select>
            </div>
          )}

          {/* Delete after run */}
          <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-neutral-300 cursor-pointer select-none">
            <input
              data-testid="cron-form-delete-after-run"
              type="checkbox"
              checked={deleteAfterRun}
              onChange={e => setDeleteAfterRun(e.target.checked)}
              disabled={saving}
              className="accent-primary-600"
            />
            {t('settings.cron.jobs.formDeleteAfterRun')}
          </label>

          {/* Error */}
          {error && (
            <div
              data-testid="cron-form-error"
              className="px-3 py-2 rounded-md bg-coral-50 dark:bg-coral-500/10 border border-coral-200 dark:border-coral-500/30 text-xs text-coral-700 dark:text-coral-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-stone-200 dark:border-neutral-800 flex items-center justify-end gap-3">
          <button
            type="button"
            data-testid="cron-form-cancel"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-md border border-stone-300 dark:border-neutral-700 text-sm text-stone-700 dark:text-neutral-300 hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50">
            {t('settings.cron.jobs.formCancel')}
          </button>
          <button
            type="button"
            data-testid="cron-form-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-md bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CronJobFormModal;
