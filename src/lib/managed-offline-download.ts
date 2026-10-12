'use client';

import { makeOfflineBookKey, shouldResumeOfflineDownload } from '@/lib/offline-book-core';
import { downloadAndSaveOfflineBook } from '@/lib/offline-download';
import { removeOfflinePartial } from '@/lib/offline-books';
import { getOfflineDownloadSnapshot, startOfflineDownload } from '@/lib/offline-download-manager';
import { useSettingsStore } from '@/lib/store/settings';
import { runWithDownloadRetry } from '@/lib/download-retry';
import { getNetworkQuality, waitForNetworkRecovery } from '@/lib/network-health';
import { debugLog } from '@/lib/debug-log';

export async function startManagedOfflineBookDownload(input: {
  serverUrl: string;
  bookId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  inShelf?: boolean;
  format: string;
}): Promise<void> {
  const format = input.format.toLowerCase();
  const key = makeOfflineBookKey(input.serverUrl, input.bookId, format);
  const canResume = shouldResumeOfflineDownload(process.env.NEXT_PUBLIC_APP_PLATFORM);
  await startOfflineDownload({
    key,
    metadata: {
      ...input,
      format,
      downloadedBytes: canResume ? undefined : 0,
    },
    run: (onProgress, signal, onTransfer) =>
      runWithDownloadRetry(
        () => {
          const expectedTotalBytes = getOfflineDownloadSnapshot(key)?.totalBytes ?? null;
          return downloadAndSaveOfflineBook({
            ...input,
            format,
            onProgress,
            onTransfer,
            signal,
            resume: canResume,
            preservePartialOnFailure: true,
            expectedTotalBytes,
          });
        },
        {
          signal,
          maxAttempts: canResume ? 5 : 2,
          waitForNetwork: async (retrySignal) => {
            if (getNetworkQuality() === 'offline') {
              await waitForNetworkRecovery(retrySignal, 5 * 60 * 1000);
            }
          },
          onRetry: (attemptIndex, error) => {
            debugLog(
              'warn',
              'download',
              `[${input.title}] 下载中断，准备第 ${attemptIndex + 1} 次重试`,
              error instanceof Error ? error.message : String(error),
            );
          },
        },
      ),
    onCancel: () => removeOfflinePartial({
      ...input,
      format,
      downloadDirectory: useSettingsStore.getState().downloadDirectory,
    }),
  });
  const status = getOfflineDownloadSnapshot(key)?.status;
  if (status !== 'completed') throw new Error(`book.download.${status || 'interrupted'}`);
}
