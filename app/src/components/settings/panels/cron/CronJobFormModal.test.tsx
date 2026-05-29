import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreCronJob } from '../../../../utils/tauriCommands';
import CronJobFormModal, { type CronJobFormModalProps } from './CronJobFormModal';

// ── Mock i18n ──────────────────────────────────────────────────────────
vi.mock('../../../../lib/i18n/I18nContext', () => ({
  useT: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'settings.cron.jobs.createJob': 'New Scheduled Job',
        'settings.cron.jobs.editJob': 'Edit Scheduled Job',
        'settings.cron.jobs.formName': 'Job name',
        'settings.cron.jobs.formNamePlaceholder': 'e.g. daily-report, cleanup-task',
        'settings.cron.jobs.formJobType': 'Job type',
        'settings.cron.jobs.formJobTypeAgent': 'Agent (AI prompt)',
        'settings.cron.jobs.formJobTypeShell': 'Shell command',
        'settings.cron.jobs.formScheduleType': 'Schedule type',
        'settings.cron.jobs.formScheduleCron': 'Recurring (cron)',
        'settings.cron.jobs.formScheduleAt': 'One-time (run at)',
        'settings.cron.jobs.formScheduleEvery': 'Interval (every N ms)',
        'settings.cron.jobs.formCronPreset': 'Preset',
        'settings.cron.jobs.formCronCustom': 'Custom expression',
        'settings.cron.jobs.formCronCustomPlaceholder': 'e.g. */30 * * * *',
        'settings.cron.jobs.formCronPreview': 'Runs: {{preview}}',
        'settings.cron.jobs.formAtLabel': 'Run at',
        'settings.cron.jobs.formEveryLabel': 'Interval (milliseconds)',
        'settings.cron.jobs.formPrompt': 'Agent prompt',
        'settings.cron.jobs.formPromptPlaceholder': 'What should the agent do each run?',
        'settings.cron.jobs.formCommand': 'Shell command',
        'settings.cron.jobs.formCommandPlaceholder': 'e.g. curl https://example.com/health',
        'settings.cron.jobs.formSessionTarget': 'Session target',
        'settings.cron.jobs.formSessionIsolated': 'Isolated (recommended)',
        'settings.cron.jobs.formSessionMain': 'Main session',
        'settings.cron.jobs.formDelivery': 'Delivery mode',
        'settings.cron.jobs.formDeliveryNone': 'None (output only)',
        'settings.cron.jobs.formDeliveryProactive': 'Proactive (push notification)',
        'settings.cron.jobs.formDeleteAfterRun': 'Delete after first run',
        'settings.cron.jobs.formCancel': 'Cancel',
        'settings.cron.jobs.formSave': 'Save',
        'settings.cron.jobs.formCreate': 'Create',
        'settings.cron.jobs.formSaving': 'Saving…',
        'settings.cron.jobs.formError': 'Failed to save job',
        'settings.cron.jobs.custom': 'Custom',
        'settings.cron.schedule.every30min': 'Every 30 minutes',
        'settings.cron.schedule.everyHour': 'Every hour',
        'settings.cron.schedule.every2hours': 'Every 2 hours',
        'settings.cron.schedule.every6hours': 'Every 6 hours',
        'settings.cron.schedule.onceDaily': 'Once daily (9 AM)',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

// ── Mock cronToHuman ────────────────────────────────────────────────────
vi.mock('../../../../lib/cron/cronToHuman', () => ({
  cronToHuman: (expr: string) => `Parsed: ${expr}`,
}));

// ── Sample data ─────────────────────────────────────────────────────────
const sampleJob: CoreCronJob = {
  id: 'job-abc',
  expression: '*/30 * * * *',
  schedule: { kind: 'cron', expr: '*/30 * * * *' },
  command: '',
  name: 'Test Job',
  job_type: 'agent',
  session_target: 'isolated',
  enabled: true,
  delivery: { mode: 'proactive', best_effort: true },
  delete_after_run: false,
  created_at: '2026-05-01T00:00:00.000Z',
  next_run: '2026-05-01T01:00:00.000Z',
  prompt: 'Do something daily',
};

// ── Helpers ─────────────────────────────────────────────────────────────
function makeProps(overrides: Partial<CronJobFormModalProps> = {}): CronJobFormModalProps {
  return {
    mode: 'create',
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('<CronJobFormModal />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Closed state ────────────────────────────────────────────────────

  it('renders nothing when open is false', () => {
    const props = makeProps({ open: false });
    const { container } = render(<CronJobFormModal {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  // ── Create mode defaults ─────────────────────────────────────────────

  it('opens in create mode with agent type and cron schedule by default', () => {
    render(<CronJobFormModal {...makeProps()} />);

    expect(screen.getByTestId('cron-form-modal')).toBeInTheDocument();
    expect(screen.getByText('New Scheduled Job')).toBeInTheDocument();
    expect(screen.getByTestId('cron-form-job-type-agent')).toBeChecked();
    expect(screen.getByTestId('cron-form-schedule-cron')).toBeChecked();
  });

  it('submit button is disabled when prompt is empty in create mode', () => {
    render(<CronJobFormModal {...makeProps()} />);
    // Prompt textarea should be visible for agent type
    expect(screen.getByTestId('cron-form-prompt')).toBeInTheDocument();
    // Submit disabled without prompt
    expect(screen.getByTestId('cron-form-submit')).toBeDisabled();
  });

  it('enables submit after filling prompt + selecting preset, then calls onCreate with correct shape', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CronJobFormModal {...makeProps({ onCreate })} />);

    // Fill in the prompt
    fireEvent.change(screen.getByTestId('cron-form-prompt'), {
      target: { value: 'Send daily report' },
    });

    // The first preset is already selected so submit should be enabled now
    const submit = screen.getByTestId('cron-form-submit');
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledOnce();
    });

    const [params] = onCreate.mock.calls[0];
    expect(params.job_type).toBe('agent');
    expect(params.prompt).toBe('Send daily report');
    expect(params.schedule).toMatchObject({ kind: 'cron' });
    expect(params.session_target).toBe('isolated');
    expect(params.delivery).toMatchObject({ mode: 'proactive', best_effort: true });
  });

  // ── Switching to shell job type ───────────────────────────────────────

  it('switching to shell hides prompt, shows command, and requires command for submit', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CronJobFormModal {...makeProps({ onCreate })} />);

    fireEvent.click(screen.getByTestId('cron-form-job-type-shell'));

    // Prompt should not be rendered
    expect(screen.queryByTestId('cron-form-prompt')).not.toBeInTheDocument();
    // Command should appear
    expect(screen.getByTestId('cron-form-command')).toBeInTheDocument();
    // Submit disabled (command empty)
    expect(screen.getByTestId('cron-form-submit')).toBeDisabled();

    // Fill command
    fireEvent.change(screen.getByTestId('cron-form-command'), {
      target: { value: 'curl https://example.com/health' },
    });

    expect(screen.getByTestId('cron-form-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('cron-form-submit'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const [params] = onCreate.mock.calls[0];
    expect(params.job_type).toBe('shell');
    expect(params.command).toBe('curl https://example.com/health');
    expect(params).not.toHaveProperty('prompt');
  });

  // ── Schedule type: at ─────────────────────────────────────────────────

  it('switching to "at" schedule shows datetime input and sets deleteAfterRun to true', () => {
    render(<CronJobFormModal {...makeProps()} />);

    fireEvent.click(screen.getByTestId('cron-form-schedule-at'));

    expect(screen.getByTestId('cron-form-at')).toBeInTheDocument();
    expect(screen.queryByTestId('cron-form-cron-preset')).not.toBeInTheDocument();
    // deleteAfterRun checkbox should be checked
    expect(screen.getByTestId('cron-form-delete-after-run')).toBeChecked();
  });

  // ── Schedule type: every ──────────────────────────────────────────────

  it('switching to "every" schedule shows ms input', () => {
    render(<CronJobFormModal {...makeProps()} />);

    fireEvent.click(screen.getByTestId('cron-form-schedule-every'));

    expect(screen.getByTestId('cron-form-every')).toBeInTheDocument();
    expect(screen.queryByTestId('cron-form-cron-preset')).not.toBeInTheDocument();
  });

  // ── Edit mode prefill ──────────────────────────────────────────────────

  it('prefills fields from job prop in edit mode', () => {
    render(<CronJobFormModal {...makeProps({ mode: 'edit', job: sampleJob })} />);

    expect(screen.getByText('Edit Scheduled Job')).toBeInTheDocument();
    expect(screen.getByTestId('cron-form-name')).toHaveValue('Test Job');
    expect(screen.getByTestId('cron-form-prompt')).toHaveValue('Do something daily');
  });

  it('disables job type radio in edit mode', () => {
    render(<CronJobFormModal {...makeProps({ mode: 'edit', job: sampleJob })} />);

    expect(screen.getByTestId('cron-form-job-type-agent')).toBeDisabled();
    expect(screen.getByTestId('cron-form-job-type-shell')).toBeDisabled();
  });

  // ── Edit submit ────────────────────────────────────────────────────────

  it('calls onUpdate with job.id and patch on edit submit', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<CronJobFormModal {...makeProps({ mode: 'edit', job: sampleJob, onUpdate })} />);

    // Change the name
    fireEvent.change(screen.getByTestId('cron-form-name'), { target: { value: 'Updated Name' } });

    fireEvent.click(screen.getByTestId('cron-form-submit'));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    const [jobId, patch] = onUpdate.mock.calls[0];
    expect(jobId).toBe('job-abc');
    expect(patch).toMatchObject({ schedule: { kind: 'cron' } });
  });

  // ── Cancel ────────────────────────────────────────────────────────────

  it('calls onClose when Cancel button is clicked', () => {
    const onClose = vi.fn();
    render(<CronJobFormModal {...makeProps({ onClose })} />);

    // There are two cancel buttons (header x and footer Cancel)
    const cancelButtons = screen.getAllByTestId('cron-form-cancel');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── Error surfacing ────────────────────────────────────────────────────

  it('surfaces error in cron-form-error when onCreate rejects', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('network error'));
    render(<CronJobFormModal {...makeProps({ onCreate })} />);

    // Fill prompt so submit is enabled
    fireEvent.change(screen.getByTestId('cron-form-prompt'), { target: { value: 'Some prompt' } });

    fireEvent.click(screen.getByTestId('cron-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('cron-form-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('cron-form-error')).toHaveTextContent('Failed to save job');
  });
});
