export const LIBRARY_BATCH_SIZE = 30;

export type LibraryBrowseMode = 'continuous' | 'paged';
export type LibrarySortOrder = 'desc' | 'asc';

export interface LibraryBookIdentity {
  id: string | number;
}

export function sortLibraryBooksById<T extends LibraryBookIdentity>(
  books: readonly T[],
  order: LibrarySortOrder,
): T[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...books].sort((left, right) => {
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return (leftNumber - rightNumber) * direction;
    }
    return String(left.id).localeCompare(String(right.id), undefined, { numeric: true }) * direction;
  });
}

export function mergeUniqueLibraryBooks<T extends LibraryBookIdentity>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(current.map((book) => String(book.id)));
  const merged = [...current];
  for (const book of incoming) {
    const id = String(book.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(book);
  }
  return merged;
}

export function buildLibraryRequestParams(input: {
  offset: number;
  order: LibrarySortOrder;
  format?: string;
  tag?: string;
}): URLSearchParams {
  const params = new URLSearchParams({
    start: String(Math.max(0, input.offset)),
    size: String(LIBRARY_BATCH_SIZE),
    order: input.order,
  });
  if (input.tag && input.tag !== '全部') params.set('tag', input.tag);
  if (input.format && input.format !== '全部') params.set('format', input.format.toLowerCase());
  return params;
}

export function hasMoreLibraryBooks(offset: number, received: number, total: number): boolean {
  return received > 0 && offset + received < total;
}

export function isLibraryScrollNearEnd(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 320,
): boolean {
  const remaining = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return remaining <= Math.max(0, threshold);
}

export function isScrollableLibraryElement(
  metrics: { scrollHeight: number; clientHeight: number },
): boolean {
  return metrics.scrollHeight > metrics.clientHeight + 1;
}
