import createDebug from 'debug';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '../../../lib/i18n/I18nContext';
import {
  type CoreCronJob,
  type CoreCronRun,
  type CronAddParams,
  openhumanCronAdd,
  openhumanCronList,
  openhumanCronRemove,
  openhumanCronRun,
  openhumanCronRuns,
  openhumanCronUpdate,
} from '../../../utils/tauriCommands';
import SettingsHeader from '../components/SettingsHeader';
import { useSettingsNavigation } from '../hooks/useSettingsNavigation';
import CoreJobList from './cron/CoreJobList';
import CronJobFormModal from './cron/CronJobFormModal';

const loadCronJobsLog = createDebug('app:settings:CronJobsPanel:loadCronSkills');

const CronJobsPanel = () => {
  const { t } = useT();
  const { navigateBack, breadcrumbs } = useSettingsNavigation();

  const [loading, setLoading] = useState(true);
  const [coreError, setCoreError] = useState<string | null>(null);

  const [coreJobs, setCoreJobs] = useState<CoreCronJob[]>([]);
  const [coreRunsByJob, setCoreRunsByJob] = useState<Record<string, CoreCronRun[]>>({});
  const [coreBusyKey, setCoreBusyKey] = useState<string | null>(null);

  // Create / edit modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<CoreCronJob | null>(null);

  const loadCoreCronJobs = useCallback(async () => {
    const response = await openhumanCronList();
    const sorted = [...response.result].sort((a, b) => {
      const aTs = new Date(a.next_run).getTime();
      const bTs = new Date(b.next_run).getTime();
      return aTs - bTs;
    });
    setCoreJobs(sorted);
  }, []);

  const loadCoreCronJobsOnly = useCallback(async () => {
    loadCronJobsLog('start');
    setLoading(true);
    setCoreError(null);

    try {
      await loadCoreCronJobs();
      loadCronJobsLog('success');
    } catch (err) {
      loadCronJobsLog('failure', err);
      const message = err instanceof Error ? err.message : String(err);
      setCoreError(`Failed to load core cron jobs: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [loadCoreCronJobs]);

  useEffect(() => {
    void loadCoreCronJobsOnly();
  }, [loadCoreCronJobsOnly]);

  const toggleCoreJob = async (job: CoreCronJob) => {
    const key = `core-toggle:${job.id}`;
    setCoreBusyKey(key);
    setCoreError(null);
    try {
      const response = await openhumanCronUpdate(job.id, { enabled: !job.enabled });
      const updated = response.result;
      setCoreJobs(prev => prev.map(item => (item.id === updated.id ? updated : item)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCoreError(`Failed to update core cron job: ${message}`);
    } finally {
      setCoreBusyKey(null);
    }
  };

  const runCoreJob = async (jobId: string) => {
    const key = `core-run:${jobId}`;
    setCoreBusyKey(key);
    setCoreError(null);

    try {
      await openhumanCronRun(jobId);
      const runs = await openhumanCronRuns(jobId, 10);
      setCoreRunsByJob(prev => ({ ...prev, [jobId]: runs.result }));
      await loadCoreCronJobs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCoreError(`Failed to run core cron job: ${message}`);
    } finally {
      setCoreBusyKey(null);
    }
  };

  const loadCoreRuns = async (jobId: string) => {
    const key = `core-runs:${jobId}`;
    setCoreBusyKey(key);
    setCoreError(null);

    try {
      const runs = await openhumanCronRuns(jobId, 10);
      setCoreRunsByJob(prev => ({ ...prev, [jobId]: runs.result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCoreError(`Failed to load run history: ${message}`);
    } finally {
      setCoreBusyKey(null);
    }
  };

  const handleCreate = async (params: CronAddParams) => {
    loadCronJobsLog('handleCreate params=%o', params);
    try {
      await openhumanCronAdd(params);
      await loadCoreCronJobs();
      setFormOpen(false);
      loadCronJobsLog('handleCreate success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      loadCronJobsLog('handleCreate error: %s', message);
      setCoreError(`Failed to create cron job: ${message}`);
      throw err; // Re-throw so modal can surface inline error
    }
  };

  const handleUpdate = async (jobId: string, patch: Record<string, unknown>) => {
    loadCronJobsLog('handleUpdate jobId=%s patch=%o', jobId, patch);
    try {
      await openhumanCronUpdate(jobId, patch);
      await loadCoreCronJobs();
      setEditingJob(null);
      loadCronJobsLog('handleUpdate success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      loadCronJobsLog('handleUpdate error: %s', message);
      setCoreError(`Failed to update cron job: ${message}`);
      throw err; // Re-throw so modal can surface inline error
    }
  };

  const removeCoreJob = async (jobId: string) => {
    const key = `core-remove:${jobId}`;
    setCoreBusyKey(key);
    setCoreError(null);

    try {
      await openhumanCronRemove(jobId);
      setCoreJobs(prev => prev.filter(job => job.id !== jobId));
      setCoreRunsByJob(prev => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCoreError(`Failed to remove core cron job: ${message}`);
    } finally {
      setCoreBusyKey(null);
    }
  };

  return (
    <div data-testid="cron-jobs-panel">
      <SettingsHeader
        title={t('cron.title')}
        showBackButton={true}
        onBack={navigateBack}
        breadcrumbs={breadcrumbs}
      />

      <div className="p-4 space-y-4">
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-stone-900 dark:text-neutral-100">
            {t('cron.scheduledJobs')}
          </h3>
          <p className="text-xs text-stone-400 dark:text-neutral-500">{t('cron.manageCronJobs')}</p>
        </section>

        {/* "+ New Scheduled Job" button */}
        <div>
          <button
            type="button"
            data-testid="cron-new-job"
            className="inline-flex items-center rounded-xl border border-primary-700/30 bg-primary-600 px-3.5 py-2 text-sm font-semibold text-white shadow-soft transition-colors hover:bg-primary-700 active:bg-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            onClick={() => {
              setEditingJob(null);
              setFormOpen(true);
            }}>
            {t('settings.cron.jobs.createJob')}
          </button>
        </div>

        {coreError && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            {coreError}
          </div>
        )}

        <CoreJobList
          loading={loading}
          coreJobs={coreJobs}
          coreRunsByJob={coreRunsByJob}
          coreBusyKey={coreBusyKey}
          onToggleCoreJob={job => void toggleCoreJob(job)}
          onRunCoreJob={jobId => void runCoreJob(jobId)}
          onLoadCoreRuns={jobId => void loadCoreRuns(jobId)}
          onRemoveCoreJob={jobId => void removeCoreJob(jobId)}
          onEditCoreJob={job => setEditingJob(job)}
        />
        <div>
          <button
            type="button"
            data-testid="cron-refresh"
            className="inline-flex items-center rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2 text-sm font-medium text-stone-700 dark:text-stone-200 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-primary-500/30"
            onClick={() => void loadCoreCronJobsOnly()}>
            {t('cron.refreshCronJobs')}
          </button>
        </div>
      </div>

      {/* Create modal */}
      <CronJobFormModal
        mode="create"
        open={formOpen && editingJob === null}
        onClose={() => setFormOpen(false)}
        onCreate={params => handleCreate(params)}
        onUpdate={handleUpdate}
      />

      {/* Edit modal */}
      <CronJobFormModal
        mode="edit"
        job={editingJob ?? undefined}
        open={editingJob !== null}
        onClose={() => setEditingJob(null)}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />
    </div>
  );
};

export default CronJobsPanel;
