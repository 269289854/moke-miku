'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  fetchCurrentUser,
  fetchServerInfo,
  checkWelcomeRequirement,
  discoverServerCapabilities,
  restoreSessionFromStoredApiKey,
} from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { getServerDiscoveryInputs } from '@/lib/server-capabilities';
import { navigateFullDocument } from '@/lib/moke-reader';
import { isServerCapabilitiesFresh, resolveUserAfterSync } from '@/lib/server-session';
import { getNetworkQuality, subscribeNetworkRecovery } from '@/lib/network-health';
import {
  authenticationFallbackDestination,
  MOKE_AUTH_REQUIRED_EVENT,
} from '@/lib/device-auth';
import { clearCurrentAccountMokeCache } from '@/lib/moke-cache';

const PUBLIC_PATHS = ['/welcome', '/login', '/register', '/access', '/privacy', '/settings/developer'];
const SYNC_FAILURE_BACKOFF_MS = 60_000;
const lastSyncFailureAtByServer = new Map<string, number>();

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverUrl, offlineMode, hasHydrated, capabilities, setServerTitle, setUser, setServerCapabilities } = useServerStore();
  const [discoveryServerUrl, capabilitiesCheckedAt] = getServerDiscoveryInputs(serverUrl, capabilities);
  const [recoveryTick, setRecoveryTick] = useState(0);

  // 拓展管理页面是本地功能，不需要连接服务器
  const isExtensionPath = pathname.startsWith('/extensions');
  const isEmbeddedReaderPath = pathname.startsWith('/readest');

  useEffect(() => {
    return subscribeNetworkRecovery(() => {
      if (discoveryServerUrl) {
        lastSyncFailureAtByServer.delete(discoveryServerUrl);
      }
      setRecoveryTick((t) => t + 1);
    });
  }, [discoveryServerUrl]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleAuthenticationRequired = (event: Event) => {
      if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
      const destination = (event as CustomEvent<{ destination?: '/login' | '/access' }>).detail?.destination;
      if (destination !== '/login' && destination !== '/access') return;
      void clearCurrentAccountMokeCache().catch((error) => {
        console.warn('[ServerProvider] failed to clear stale authentication cache:', error);
      }).finally(() => {
        if (destination === '/login') useServerStore.getState().logout();
        router.replace(destination);
      });
    };
    window.addEventListener(MOKE_AUTH_REQUIRED_EVENT, handleAuthenticationRequired);
    return () => window.removeEventListener(MOKE_AUTH_REQUIRED_EVENT, handleAuthenticationRequired);
  }, [isEmbeddedReaderPath, isExtensionPath, pathname, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl && !offlineMode) {
      // Use full-document navigation on single-WebView runtimes (OHOS) to avoid
      // getting stuck on the blank loading screen when RSC navigation fails.
      navigateFullDocument('/welcome', router.replace);
    }
  }, [hasHydrated, isEmbeddedReaderPath, isExtensionPath, offlineMode, pathname, serverUrl, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (offlineMode) return;
    if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!discoveryServerUrl) return;
    if (getNetworkQuality() === 'offline') return;

    const lastFailureAt = lastSyncFailureAtByServer.get(discoveryServerUrl);
    if (lastFailureAt && Date.now() - lastFailureAt < SYNC_FAILURE_BACKOFF_MS) return;

    // 能力探测整轮（checkWelcomeRequirement + fetchCurrentUser + fetchServerInfo
    // + discoverServerCapabilities）较重，结果带 checkedAt 缓存：5 分钟内路由
    // 切换不再整轮重跑。serverUrl 变化时 setServer 会重置 capabilities
    // （checkedAt=null），因此会自然失效重探；user/title 同步随之节流。
    if (isServerCapabilitiesFresh(capabilitiesCheckedAt)) return;

    let cancelled = false;

    const checkAccess = async () => {
      const userAtSyncStart = useServerStore.getState().user;

      try {
        const welcome = await checkWelcomeRequirement(discoveryServerUrl);
        if (welcome.err === 'network.error') {
          lastSyncFailureAtByServer.set(discoveryServerUrl, Date.now());
          return;
        }
        if (cancelled) return;
        const currentCapabilities = useServerStore.getState().capabilities;
        setServerCapabilities({
          ...currentCapabilities,
          passwordLoginApi: welcome.passwordLoginApi,
          deviceApiKeyApi: welcome.deviceApiKeyApi,
        });
        if (welcome.needsAccessCode) {
          const recovery = welcome.deviceApiKeyApi
            ? await restoreSessionFromStoredApiKey(discoveryServerUrl)
            : 'no_key';
          if (cancelled) return;
          if (recovery !== 'recovered') {
            const destination = authenticationFallbackDestination(Boolean(userAtSyncStart));
            console.log(`[ServerProvider] authentication required, redirecting to ${destination}`);
            router.replace(destination);
            return;
          }
        }

        const [userResult, serverResult, capabilitiesResult] = await Promise.allSettled([
          fetchCurrentUser(),
          fetchServerInfo(),
          discoverServerCapabilities(discoveryServerUrl),
        ]);
        if (cancelled) return;

        const anyFulfilled =
          userResult.status === 'fulfilled' ||
          serverResult.status === 'fulfilled' ||
          capabilitiesResult.status === 'fulfilled';

        if (anyFulfilled) {
          lastSyncFailureAtByServer.delete(discoveryServerUrl);
        } else {
          lastSyncFailureAtByServer.set(discoveryServerUrl, Date.now());
        }

        const currentState = useServerStore.getState();
        if (currentState.serverUrl !== discoveryServerUrl) return;
        const currentUser = currentState.user;
        const syncStillCurrent = currentUser === userAtSyncStart;
        const syncedUser = resolveUserAfterSync(userAtSyncStart, currentUser, userResult);

        if (serverResult.status === 'fulfilled') {
          setServerTitle(serverResult.value.title || '');
        } else {
          console.warn('[ServerProvider] server info sync failed:', serverResult.reason);
        }

        if (userResult.status === 'fulfilled' && syncStillCurrent) {
          // Only a confirmed guest response may clear the cached user. A
          // rejected request says nothing about whether the cookie is valid.
          setUser(syncedUser);
        } else if (userResult.status === 'fulfilled') {
          console.warn('[ServerProvider] stale user sync ignored after session change');
        } else {
          console.warn('[ServerProvider] user sync failed:', userResult.reason);
        }

        if (capabilitiesResult.status === 'fulfilled' && userResult.status === 'fulfilled' && syncStillCurrent) {
          // Global discovery intentionally does not download annotation data.
          // Commit the matching user first so a real session transition clears
          // the panel-owned result, then preserve that post-transition state.
          const latestCapabilities = useServerStore.getState().capabilities;
          setServerCapabilities({
            ...capabilitiesResult.value,
            passwordLoginApi: welcome.passwordLoginApi,
            deviceApiKeyApi: welcome.deviceApiKeyApi,
            annotationApiStatus: latestCapabilities.annotationApiStatus,
            annotationApiCheckedAt: latestCapabilities.annotationApiCheckedAt,
          });
        } else if (capabilitiesResult.status === 'rejected') {
          console.warn('[ServerProvider] capabilities sync failed:', capabilitiesResult.reason);
        }
      } catch (e) {
        lastSyncFailureAtByServer.set(discoveryServerUrl, Date.now());
        // Welcome/network failures are transient. Preserve the last confirmed
        // user, title, and capability snapshot for the next sync attempt.
        console.error('[ServerProvider] sync error:', e);
      }
    };

    checkAccess();

    return () => {
      cancelled = true;
    };
  }, [capabilitiesCheckedAt, discoveryServerUrl, hasHydrated, isEmbeddedReaderPath, isExtensionPath, offlineMode, pathname, recoveryTick, router, setServerCapabilities, setServerTitle, setUser]);

  return <>{children}</>;
}
