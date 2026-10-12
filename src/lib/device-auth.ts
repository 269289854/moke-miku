import {
  safeGetLocalStorageItem,
  safeSetLocalStorageItem,
} from './browser-storage.ts';

const DEVICE_ID_STORAGE_KEY = 'moke-device-id-v1';
const SECURE_ITEM_PREFIX = 'moke.device-api-key.v1';
const API_KEY_PATTERN = /^moke_tk1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;

export const MOKE_AUTH_REQUIRED_EVENT = 'moke:authentication-required';

export interface DeviceApiKeyInfo {
  id: number;
  device_id: string;
  device_name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface StoredDeviceCredential {
  serverOrigin: string;
  apiKey: string;
  accountUsername: string;
  keyInfo: DeviceApiKeyInfo | null;
}

export interface MokeDeviceIdentity {
  id: string;
  name: string;
  persistentStorage: boolean;
}

interface SecureItemResponse {
  success: boolean;
  error?: string;
}

interface GetSecureItemResponse {
  value?: string;
  error?: string;
}

const sessionCredentials = new Map<string, StoredDeviceCredential>();

export function normalizeServerOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin.toLowerCase();
  } catch {
    return serverUrl.replace(/\/+$/, '').toLowerCase();
  }
}

function stableOriginHash(origin: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < origin.length; index += 1) {
    hash ^= origin.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function secureItemKey(serverUrl: string): string {
  return `${SECURE_ITEM_PREFIX}.${stableOriginHash(normalizeServerOrigin(serverUrl))}`;
}

async function clearNativeSecureItem(serverOrigin: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<SecureItemResponse>('plugin:native-bridge|clear_secure_item', {
      payload: { key: secureItemKey(serverOrigin) },
    });
  } catch {
    // The in-memory credential remains usable for this run.
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

export function getOrCreateMokeDeviceId(): string {
  const existing = safeGetLocalStorageItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const created = randomId();
  safeSetLocalStorageItem(DEVICE_ID_STORAGE_KEY, created);
  return created;
}

export function createManualDeviceId(): string {
  return `manual-${randomId()}`;
}

async function runtimePlatform(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return 'web';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('moke_runtime_platform');
  } catch {
    return 'unknown';
  }
}

export async function supportsPersistentDeviceCredential(): Promise<boolean> {
  const platform = await runtimePlatform();
  return process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' && platform !== 'ohos' && platform !== 'unknown';
}

export async function getMokeDeviceIdentity(): Promise<MokeDeviceIdentity> {
  const platform = await runtimePlatform();
  const names: Record<string, string> = {
    android: 'Moke Android',
    ios: 'Moke iPhone / iPad',
    windows: 'Moke Windows',
    macos: 'Moke macOS',
    linux: 'Moke Linux',
    ohos: 'Moke 鸿蒙',
    web: 'Moke Web',
  };
  return {
    id: getOrCreateMokeDeviceId(),
    name: names[platform] || 'Moke 设备',
    persistentStorage: process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri'
      && platform !== 'ohos'
      && platform !== 'unknown',
  };
}

function validCredential(value: unknown, expectedOrigin: string): value is StoredDeviceCredential {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredDeviceCredential>;
  return candidate.serverOrigin === expectedOrigin
    && typeof candidate.apiKey === 'string'
    && API_KEY_PATTERN.test(candidate.apiKey)
    && typeof candidate.accountUsername === 'string';
}

export async function storeDeviceCredential(
  serverUrl: string,
  credential: Omit<StoredDeviceCredential, 'serverOrigin'>,
  persist = true,
): Promise<'persistent' | 'session'> {
  const serverOrigin = normalizeServerOrigin(serverUrl);
  const stored: StoredDeviceCredential = { ...credential, serverOrigin };
  sessionCredentials.set(serverOrigin, stored);

  if (!persist || !(await supportsPersistentDeviceCredential())) return 'session';

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<SecureItemResponse>('plugin:native-bridge|set_secure_item', {
      payload: { key: secureItemKey(serverOrigin), value: JSON.stringify(stored) },
    });
    if (result.success) return 'persistent';
    await clearNativeSecureItem(serverOrigin);
    return 'session';
  } catch {
    await clearNativeSecureItem(serverOrigin);
    return 'session';
  }
}

export async function loadDeviceCredential(serverUrl: string): Promise<StoredDeviceCredential | null> {
  const serverOrigin = normalizeServerOrigin(serverUrl);
  const inMemory = sessionCredentials.get(serverOrigin);
  if (inMemory) return inMemory;
  if (!(await supportsPersistentDeviceCredential())) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<GetSecureItemResponse>('plugin:native-bridge|get_secure_item', {
      payload: { key: secureItemKey(serverOrigin) },
    });
    if (!result.value) return null;
    const parsed = JSON.parse(result.value) as unknown;
    if (!validCredential(parsed, serverOrigin)) {
      await clearDeviceCredential(serverOrigin);
      return null;
    }
    sessionCredentials.set(serverOrigin, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function clearDeviceCredential(serverUrl: string): Promise<void> {
  const serverOrigin = normalizeServerOrigin(serverUrl);
  sessionCredentials.delete(serverOrigin);
  await clearNativeSecureItem(serverOrigin);
}

export function authenticationFallbackDestination(hadAccount: boolean): '/login' | '/access' {
  return hadAccount ? '/login' : '/access';
}

export function emitAuthenticationRequired(destination: '/login' | '/access'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MOKE_AUTH_REQUIRED_EVENT, { detail: { destination } }));
}
