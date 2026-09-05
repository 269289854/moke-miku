'use client';

import type { OfflineBookRecord } from '@/lib/offline-books';
import { getDebugPanelLaunchState } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchReadingProgress } from '@/lib/reading-progress';
import {
  buildEmbeddedReaderUrl,
  getMokeRuntimePlatform,
  isSingleWebviewRuntime,
  openEmbeddedReaderBook,
} from '@/lib/moke-reader';
import { useServerStore } from '@/lib/store/server';
import { buildMokeSourceIdentity, readerCacheLimitForPlatform } from '@/lib/moke-book-source';

export async function openOfflineBook(
  record: OfflineBookRecord,
  navigate: (href: string) => void,
): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri' || !record.filePath) {
    throw new Error('book.offline.desktop_only');
  }

  if (useSettingsStore.getState().readerPreference === 'system') {
    await openBookWithSystemDefault(record.id);
    return;
  }

  // Progress recovery and the immutable runtime probe are independent. Offline
  // library opens intentionally do not write Talebook read history: there may
  // be no active authenticated server session, and the saved record can belong
  // to a server other than the currently connected one.
  const [restoreProgress, platform] = await Promise.all([
    fetchReadingProgress(record.bookId),
    getMokeRuntimePlatform(),
  ]);
  const currentUser = useServerStore.getState().user;
  const identity = buildMokeSourceIdentity({
    serverUrl: record.serverUrl,
    account: record.accountKey
      || String(currentUser?.id || currentUser?.username || currentUser?.name || 'anonymous'),
    bookId: record.bookId,
    format: record.format,
  });
  const source = {
    kind: 'local' as const,
    bookId: record.bookId,
    format: record.format,
    title: record.title,
    author: record.author || '',
    filePath: record.filePath,
    fileVersion: record.sourceSignature || `${record.updatedAt}:${record.size}`,
    cacheLimitBytes: readerCacheLimitForPlatform(platform),
    ...identity,
  };
  const common = {
    filePath: record.filePath,
    mokeSource: source,
    eink: useSettingsStore.getState().eink,
    debugPanel: getDebugPanelLaunchState(),
    mokeBookId: record.bookId,
    restoreProgress,
  };

  if (isSingleWebviewRuntime(platform)) {
    await openEmbeddedReaderBook(
      buildEmbeddedReaderUrl({ ...common, source, serverUrl: record.serverUrl }),
      navigate,
      platform,
    );
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_reader', common);
}

export async function openBookWithSystemDefault(recordId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    throw new Error('book.offline.desktop_only');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('moke_open_downloaded_book', { id: recordId });
}
