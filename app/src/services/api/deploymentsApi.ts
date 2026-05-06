import { callCoreCommand } from '../coreCommandClient';

/**
 * Response shape from GET /auth/me when coreToken is included.
 * The backend adds `coreToken` (select: false on User model) only in this
 * endpoint so the desktop can authenticate against the user's core instance.
 */
export interface AuthMeWithCoreToken {
  coreToken: string;
}

export type DeploymentStatus =
  | 'pending'
  | 'provisioning'
  | 'deploying'
  | 'starting'
  | 'active'
  | 'unhealthy'
  | 'terminating'
  | 'terminated'
  | 'failed';

export interface DeploymentInstance {
  deploymentId: string;
  status: DeploymentStatus;
  url: string | null; // the RPC URL (https://.../rpc)
  healthUrl: string | null;
  region: string;
  imageTag: string;
  createdAt: string;
  activatedAt: string | null;
  failureReason: string | null;
}

export interface ProvisionParams {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  imageTag?: string;
  domain?: string;
}

export interface ProvisionResponse {
  deploymentId: string;
  status: 'pending';
  estimatedReadySeconds: number;
}

export interface HealthCheckResponse {
  instanceReachable: boolean;
  instanceStatus: 'ok' | 'error' | 'unreachable';
  latencyMs: number;
  checkedAt: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

function wrapCoreResult<T>(data: T): ApiEnvelope<T> {
  return { success: true, data };
}

export const deploymentsApi = {
  /**
   * Fetch the user's coreToken from the backend.
   * Returns null if the backend does not yet include coreToken (graceful degradation).
   */
  getCoreToken: async (): Promise<string | null> => {
    try {
      const res = await callCoreCommand<AuthMeWithCoreToken>('openhuman.deployment_get_core_token');
      return res.coreToken ?? null;
    } catch {
      return null;
    }
  },

  provision: async (params: ProvisionParams) =>
    wrapCoreResult(
      await callCoreCommand<ProvisionResponse>('openhuman.deployment_provision', params)
    ),

  getStatus: async () =>
    wrapCoreResult(
      await callCoreCommand<DeploymentInstance | null>('openhuman.deployment_get_status')
    ),

  getHealth: async () =>
    wrapCoreResult(await callCoreCommand<HealthCheckResponse>('openhuman.deployment_get_health')),

  terminate: async (creds?: { awsAccessKeyId: string; awsSecretAccessKey: string }) =>
    wrapCoreResult(
      await callCoreCommand<{ deploymentId: string; status: string }>(
        'openhuman.deployment_terminate',
        creds ?? {}
      )
    ),
};
