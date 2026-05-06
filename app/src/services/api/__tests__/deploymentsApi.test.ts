import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallCoreCommand = vi.fn();

vi.mock('../../coreCommandClient', () => ({
  callCoreCommand: (...args: unknown[]) => mockCallCoreCommand(...args),
}));

const { deploymentsApi } = await import('../deploymentsApi');

describe('deploymentsApi', () => {
  beforeEach(() => {
    mockCallCoreCommand.mockReset();
  });

  it('loads deployment status through core RPC', async () => {
    const instance = {
      deploymentId: 'dep_123',
      status: 'active',
      url: 'https://core.example/rpc',
      healthUrl: 'https://core.example/health',
      region: 'us-east-1',
      imageTag: 'latest',
      createdAt: '2026-05-06T00:00:00.000Z',
      activatedAt: null,
      failureReason: null,
    };
    mockCallCoreCommand.mockResolvedValue(instance);

    const result = await deploymentsApi.getStatus();

    expect(mockCallCoreCommand).toHaveBeenCalledWith('openhuman.deployment_get_status');
    expect(result).toEqual({ success: true, data: instance });
  });

  it('provisions through core RPC with AWS params', async () => {
    const response = { deploymentId: 'dep_456', status: 'pending', estimatedReadySeconds: 90 };
    const params = {
      awsAccessKeyId: 'AKIA_TEST',
      awsSecretAccessKey: 'secret',
      awsRegion: 'us-west-2',
      domain: 'core.example.com',
    };
    mockCallCoreCommand.mockResolvedValue(response);

    const result = await deploymentsApi.provision(params);

    expect(mockCallCoreCommand).toHaveBeenCalledWith('openhuman.deployment_provision', params);
    expect(result).toEqual({ success: true, data: response });
  });

  it('returns null when core token endpoint is unavailable', async () => {
    mockCallCoreCommand.mockRejectedValue(new Error('not deployed'));

    await expect(deploymentsApi.getCoreToken()).resolves.toBeNull();
  });

  it('terminates through core RPC with an empty payload by default', async () => {
    const response = { deploymentId: 'dep_789', status: 'terminating' };
    mockCallCoreCommand.mockResolvedValue(response);

    const result = await deploymentsApi.terminate();

    expect(mockCallCoreCommand).toHaveBeenCalledWith('openhuman.deployment_terminate', {});
    expect(result).toEqual({ success: true, data: response });
  });
});
