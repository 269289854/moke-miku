'use client';

import { downloadBookBlob, fetchImageBlob, streamBookDownload } from '@/lib/api';
import { createRequestDeadline } from '@/lib/api-core';
import { buildCoverThumbUrl } from '@/lib/cover-url';
import { beginOfflineDownload, endOfflineDownload } from '@/lib/offline-book-core';
import { saveOfflineBook, saveOfflineBookStream } from '@/lib/offline-books';
import { useSettingsStore } from '@/lib/store/settings';
import { useServerStore } from '@/lib/store/server';

export { beginOfflineDownload, endOfflineDownload };

export interface DownloadOfflineBookOptions {
  serverUrl: string;
  bookId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  inShelf?: boolean;
  format: string;
  onProgress?: (progress: number) => void;
  onTransfer?: (receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
  resume?: boolean;
  preservePartialOnFailure?: boolean;
  accountKey?: string;
  expectedTotalBytes?: number | null;
}

async function fetchCoverDataUrl(coverUrl?: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!coverUrl) return undefined;
  const deadline = createRequestDeadline(signal, 8_000);
  try {
    const thumbUrl = buildCoverThumbUrl(coverUrl);
    let blob: Blob | undefined;
    try {
      blob = await fetchImageBlob(thumbUrl, { signal: deadline.signal });
    } catch {
      if (thumbUrl !== coverUrl && !deadline.signal.aborted) {
        try {
          blob = await fetchImageBlob(coverUrl, { signal: deadline.signal });
        } catch {
          return undefined;
        }
      } else {
        return undefined;
      }
    }
    if (!blob) return undefined;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  } finally {
    deadline.clear();
  }
}

/** Unified entry: Tauri streams to a resumable file; web stores one Blob in IndexedDB. */
export async function downloadAndSaveOfflineBook(options: DownloadOfflineBookOptions): Promise<void> {
  const format = options.format.toLowerCase();
  const currentUser = useServerStore.getState().user;
  const accountKey = options.accountKey
    || String(currentUser?.id || currentUser?.username || currentUser?.name || 'anonymous');
  const coverDataUrl = await fetchCoverDataUrl(options.coverUrl, options.signal);
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    const downloadDirectory = useSettingsStore.getState().downloadDirectory;
    await saveOfflineBookStream({
      serverUrl: options.serverUrl,
      bookId: options.bookId,
      title: options.title,
      author: options.author,
      inShelf: options.inShelf,
      coverDataUrl,
      format,
      fileName: `${options.title}.${format}`,
      mimeType: 'application/octet-stream',
      downloadDirectory,
      resume: options.resume,
      preservePartialOnFailure: options.preservePartialOnFailure,
      accountKey,
      write: async (writer) => streamBookDownload(options.bookId, format, {
        write: (chunk) => writer.write(chunk),
        onProgress: options.onProgress,
        onTransfer: options.onTransfer,
        signal: options.signal,
        resumeFrom: writer.position,
        onRangeReset: () => writer.truncate(),
        validateEpub: false,
        expectedTotalBytes: options.expectedTotalBytes,
      }),
    });
    return;
  }

  const blob = await downloadBookBlob(options.bookId, format, {
    onProgress: options.onProgress,
    signal: options.signal,
  });
  options.onTransfer?.(blob.size, blob.size);
  await saveOfflineBook({
    serverUrl: options.serverUrl,
    bookId: options.bookId,
    title: options.title,
    author: options.author,
    inShelf: options.inShelf,
    coverDataUrl,
    format,
    fileName: `${options.title}.${format}`,
    mimeType: blob.type || 'application/octet-stream',
    blob,
    accountKey,
  });
}
