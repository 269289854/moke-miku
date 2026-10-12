export type SessionRecoveryResult = 'recovered' | 'no_key' | 'invalid' | 'unavailable';

interface RecoveryContext {
  serverUrl: string;
  user: unknown;
}

export function isRecoveryContextCurrent(expected: RecoveryContext, current: RecoveryContext): boolean {
  // Object identity also invalidates recovery after signing in as the same account again.
  return expected.serverUrl === current.serverUrl && expected.user === current.user;
}

const EXCLUDED_PATHS = new Set([
  '/api/welcome',
  '/api/user/sign_in',
  '/api/user/sign_out',
  '/api/user/api_key/sign_in',
]);

export async function responseNeedsSessionRecovery(response: Response, url: string): Promise<boolean> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (EXCLUDED_PATHS.has(pathname)) return false;
  if (response.status === 401) return true;
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('json')) return false;
  try {
    const payload = await response.clone().json() as { err?: unknown };
    return payload.err === 'not_invited' || payload.err === 'user.need_login';
  } catch {
    return false;
  }
}

export class SessionRecoveryCoordinator {
  private readonly inFlight = new Map<string, Promise<SessionRecoveryResult>>();

  run(serverOrigin: string, recover: () => Promise<SessionRecoveryResult>): Promise<SessionRecoveryResult> {
    const existing = this.inFlight.get(serverOrigin);
    if (existing) return existing;
    const recovery = recover().finally(() => {
      this.inFlight.delete(serverOrigin);
    });
    this.inFlight.set(serverOrigin, recovery);
    return recovery;
  }
}
