import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildLibraryRequestParams,
  hasMoreLibraryBooks,
  isLibraryScrollNearEnd,
  isScrollableLibraryElement,
  LIBRARY_BATCH_SIZE,
  mergeUniqueLibraryBooks,
  sortLibraryBooksById,
} from '../src/lib/library-browse.ts';

test('书库请求固定每批 30 本并携带全局排序和筛选参数', () => {
  const params = buildLibraryRequestParams({ offset: 30, order: 'asc', format: 'EPUB', tag: '小说' });
  assert.equal(LIBRARY_BATCH_SIZE, 30);
  assert.equal(params.get('start'), '30');
  assert.equal(params.get('size'), '30');
  assert.equal(params.get('order'), 'asc');
  assert.equal(params.get('format'), 'epub');
  assert.equal(params.get('tag'), '小说');
});

test('连续批次按书号去重且请求偏移不依赖去重后的数量', () => {
  const merged = mergeUniqueLibraryBooks([{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }]);
  assert.deepEqual(merged.map((book) => book.id), [3, 2, 1]);
  assert.equal(hasMoreLibraryBooks(30, 30, 91), true);
  assert.equal(hasMoreLibraryBooks(60, 0, 91), false);
  assert.equal(hasMoreLibraryBooks(60, 30, 90), false);
});

test('离线书库按 TaleBook 数值书号正序或倒序', () => {
  const books = [{ id: '10' }, { id: '2' }, { id: '1' }];
  assert.deepEqual(sortLibraryBooksById(books, 'asc').map((book) => book.id), ['1', '2', '10']);
  assert.deepEqual(sortLibraryBooksById(books, 'desc').map((book) => book.id), ['10', '2', '1']);
});

test('连续滚动只在剩余距离不超过阈值时允许追加', () => {
  assert.equal(isLibraryScrollNearEnd({ scrollHeight: 2000, scrollTop: 1179, clientHeight: 500 }), false);
  assert.equal(isLibraryScrollNearEnd({ scrollHeight: 2000, scrollTop: 1180, clientHeight: 500 }), true);
  assert.equal(isLibraryScrollNearEnd({ scrollHeight: 800, scrollTop: 0, clientHeight: 800 }), true);
  assert.equal(isLibraryScrollNearEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }, -1), false);
});

test('连续滚动根据实际可滚动高度选择内部容器或页面视口', () => {
  assert.equal(isScrollableLibraryElement({ scrollHeight: 1002, clientHeight: 1000 }), true);
  assert.equal(isScrollableLibraryElement({ scrollHeight: 1001, clientHeight: 1000 }), false);
  assert.equal(isScrollableLibraryElement({ scrollHeight: 800, clientHeight: 1000 }), false);
});

test('旧偏好缺少新字段时由 store 默认连续滚动和倒序', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/lib/store/view-prefs.ts', import.meta.url)),
    'utf8',
  );
  assert.match(source, /libraryBrowseMode: 'continuous'/);
  assert.match(source, /librarySortOrder: 'desc'/);
  assert.match(source, /name: 'moke-view-prefs'/);
});

test('连续滚动观察本地书库容器并保留追加错误重试', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/library/page.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(source, /rootMargin: '0px 0px 320px 0px'/);
  assert.match(source, /root = localScrollRef\.current/);
  assert.match(source, /nextScrollTop > previousScrollTop/);
  assert.match(source, /isLibraryScrollNearEnd\(getScrollMetrics\(\), 320\)/);
  assert.match(source, /document\.scrollingElement/);
  assert.match(source, /useElementScroll \? root : window/);
  assert.doesNotMatch(source, /sentinelVisible/);
  assert.match(source, /localRequestInFlightRef\.current/);
  assert.match(source, /重试加载/);
  assert.match(source, /libraryBrowseMode === 'paged' && totalPages > 1/);
});
