import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock i18n ───────────────────────────────────────────────────────────
vi.mock('../../../lib/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k }),
}));

// ── Mock navigation ─────────────────────────────────────────────────────
vi.mock('../hooks/useSettingsNavigation', () => ({
  useSettingsNavigation: () => ({ navigateBack: vi.fn(), breadcrumbs: [] }),
}));

// ── Mock SettingsHeader ─────────────────────────────────────────────────
vi.mock('../components/SettingsHeader', () => ({
  default: ({ title }: { title: string }) => (
    <div data-testid="settings-header">{title}</div>
  ),
}));

// ── Mock CronJobFormModal ───────────────────────────────────────────────
// The modal is independently tested; here we just verify it opens/closes
// and the callbacks fire.
const mockModalOnCreate = vi.fn();
const mockModalOnUpdate = vi.fn();

vi.mock('./cron/CronJobFormModal', () => ({
  default: ({
    open,
    mode,
    job,
    onClose,
    onCreate,
    onUpdate,
  }: {
    open: boolean;
    mode: string;
    job?: { id: string };
    onClose: () => void;
    onCreate: (p: unknown) => Promise<void>;
    onUpdate: (id: string, p: unknown) => Promise<void>;
  }) => {
    if (!open) return null;
    // Capture the callbacks on each render so tests can invoke them
    mockModalOnCreate.mockImplementation(onCreate);
    mockModalOnUpdate.mockImplementation(onUpdate);
    return (
      <div data-testid={`cron-form-modal-${mode}`}>
        <span data-testid="modal-job-id">{job?.id ?? ''}</span>
        <button data-testid="modal-close" onClick={onClose}>
          close
        </button>
      </div>
    );
  },
}));

// ── Mock tauriCommands ──────────────────────────────────────────────────
const cronAddMock = vi.fn();
const cronListMock = vi.fn();
const cronUpdateMock = vi.fn();
const cronRemoveMock = vi.fn();
const cronRunMock = vi.fn();
const cronRunsMock = vi.fn();

vi.mock('../../../utils/tauriCommands', () => ({
  openhumanCronAdd: (...args: unknown[]) => cronAddMock(...args),
  openhumanCronList: () => cronListMock(),
  openhumanCronUpdate: (...args: unknown[]) => cronUpdateMock(...args),
  openhumanCronRemove: (...args: unknown[]) => cronRemoveMock(...args),
  openhumanCronRun: (...args: unknown[]) => cronRunMock(...args),
  openhumanCronRuns: (...args: unknown[]) => cronRunsMock(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────────
const sampleJob = {
  id: 'job-1',
  expression: '*/30 * * * *',
  schedule: { kind: 'cron', expr: '*/30 * * * *' },
  command: '',
  name: 'Daily Briefing',
  job_type: 'agent',
  session_target: 'isolated',
  enabled: true,
  delivery: { mode: 'proactive', best_effort: true },
  delete_after_run: false,
  created_at: '2026-05-01T00:00:00.000Z',
  next_run: '2026-06-01T09:00:00.000Z',
  prompt: 'Summarise the news',
};

async function importPanel() {
  vi.resetModules();
  const mod = await import('./CronJobsPanel');
  return mod.default;
}

describe('<CronJobsPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cronListMock.mockResolvedValue({ result: [sampleJob] });
    cronAddMock.mockResolvedValue({ result: { ...sampleJob, id: 'job-new' } });
    cronUpdateMock.mockResolvedValue({ result: sampleJob });
    cronRemoveMock.mockResolvedValue({ result: { job_id: 'job-1', removed: true } });
    cronRunMock.mockResolvedValue({ result: {} });
    cronRunsMock.mockResolvedValue({ result: [] });
  });

  it('renders the "+ New Scheduled Job" button', async () => {
    const Panel = await importPanel();
    render(<Panel />);
    await waitFor(() => expect(cronListMock).toHaveBeenCalled());
    expect(screen.getByTestId('cron-new-job')).toBeInTheDocument();
  });

  it('clicking "+ New Scheduled Job" opens create modal', async () => {
    const Panel = await importPanel();
    render(<Panel />);
    await waitFor(() => expect(cronListMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('cron-new-job'));
    expect(screen.getByTestId('cron-form-modal-create')).toBeInTheDocument();
  });

  it('onCreate triggers openhumanCronAdd and refresh', async () => {
    const Panel = await importPanel();
    render(<Panel />);
    await waitFor(() => expect(cronListMock).toHaveBeenCalled());

    // Open create modal
    fireEvent.click(screen.getByTestId('cron-new-job'));
    await waitFor(() => expect(screen.getByTestId('cron-form-modal-create')).toBeInTheDocument());

    // Invoke create via captured mock callback
    const params = { schedule: { kind: 'cron', expr: '0 9 * * *' }, job_type: 'agent', prompt: 'hi' };
    await mockModalOnCreate(params);

    await waitFor(() => expect(cronAddMock).toHaveBeenCalledWith(params));
    // List should be refreshed (at least 2 calls total: initial + refresh)
    expect(cronListMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('edit button click opens edit modal with the correct job', async () => {
    const Panel = await importPanel();
    render(<Panel />);
    await waitFor(() => expect(cronListMock).toHaveBeenCalled());

    // The mock CoreJobList renders are replaced here — we need to simulate the
    // onEditCoreJob callback by clicking the edit button rendered by the real CoreJobList.
    // Since CoreJobList is NOT mocked, it renders actual buttons.
    const editBtn = await screen.findByTestId('cron-job-edit-job-1');
    fireEvent.click(editBtn);

    await waitFor(() =>
      expect(screen.getByTestId('cron-form-modal-edit')).toBeInTheDocument()
    );
    expect(screen.getByTestId('modal-job-id')).toHaveTextContent('job-1');
  });

  it('onUpdate triggers openhumanCronUpdate and refresh', async () => {
    const Panel = await importPanel();
    render(<Panel />);
    await waitFor(() => expect(cronListMock).toHaveBeenCalled());

    // Open edit modal via edit button
    const editBtn = await screen.findByTestId('cron-job-edit-job-1');
    fireEvent.click(editBtn);

    await waitFor(() => expect(screen.getByTestId('cron-form-modal-edit')).toBeInTheDocument());

    const patch = { name: 'Updated', schedule: { kind: 'cron', expr: '0 9 * * *' } };
    await mockModalOnUpdate('job-1', patch);

    await waitFor(() => expect(cronUpdateMock).toHaveBeenCalledWith('job-1', patch));
    expect(cronListMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
