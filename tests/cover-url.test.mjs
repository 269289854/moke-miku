import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCoverThumbUrl,
  normalizeCoverCacheKey,
  COVER_THUMB_WIDTH,
  COVER_THUMB_HEIGHT,
} from '../src/lib/cover-url.ts';

test('buildCoverThumbUrl 转换标准封面 URL 为默认缩略图尺寸', () => {
  const input = 'https://host/get/cover/123.jpg';
  const expected = `https://host/get/thumb_${COVER_THUMB_WIDTH}_${COVER_THUMB_HEIGHT}/123.jpg`;
  assert.equal(buildCoverThumbUrl(input), expected);
});

test('buildCoverThumbUrl 保留查询参数（如 ?t=）与哈希', () => {
  const input = 'https://host/get/cover/123.jpg?t=20260101120000&foo=bar#section';
  const expected = `https://host/get/thumb_${COVER_THUMB_WIDTH}_${COVER_THUMB_HEIGHT}/123.jpg?t=20260101120000&foo=bar#section`;
  assert.equal(buildCoverThumbUrl(input), expected);
});

test('buildCoverThumbUrl 支持带路径前缀和端口的服务器地址', () => {
  const input = 'https://host:8443/talebook/get/cover/1.jpg';
  const expected = `https://host:8443/talebook/get/thumb_${COVER_THUMB_WIDTH}_${COVER_THUMB_HEIGHT}/1.jpg`;
  assert.equal(buildCoverThumbUrl(input), expected);
});

test('buildCoverThumbUrl 支持自定义宽高参数', () => {
  const input = 'https://host/get/cover/42.jpg';
  const expected = 'https://host/get/thumb_180_240/42.jpg';
  assert.equal(buildCoverThumbUrl(input, 180, 240), expected);
});

test('buildCoverThumbUrl 对非封面 URL、已是缩略图、非 jpg 或非数字原样返回', () => {
  // 已是缩略图
  assert.equal(
    buildCoverThumbUrl('https://host/get/thumb_360_480/123.jpg'),
    'https://host/get/thumb_360_480/123.jpg',
  );
  // 非封面 URL
  assert.equal(buildCoverThumbUrl('https://host/api/book/123'), 'https://host/api/book/123');
  assert.equal(buildCoverThumbUrl('https://host/get/avatar/123.jpg'), 'https://host/get/avatar/123.jpg');
  // 非数字 ID
  assert.equal(buildCoverThumbUrl('https://host/get/cover/abc.jpg'), 'https://host/get/cover/abc.jpg');
  // 非 jpg
  assert.equal(buildCoverThumbUrl('https://host/get/cover/123.png'), 'https://host/get/cover/123.png');
});

test('buildCoverThumbUrl 对 data:、blob:、空串与非法字符串原样返回', () => {
  assert.equal(buildCoverThumbUrl('data:image/jpeg;base64,123'), 'data:image/jpeg;base64,123');
  assert.equal(buildCoverThumbUrl('blob:http://host/uuid'), 'blob:http://host/uuid');
  assert.equal(buildCoverThumbUrl(''), '');
  assert.equal(buildCoverThumbUrl('invalid-url-%%%'), 'invalid-url-%%%');
});

test('normalizeCoverCacheKey 去掉封面与缩略图 URL 中的 t 参数，保留其他参数', () => {
  // 原图封面去掉单个 t
  assert.equal(
    normalizeCoverCacheKey('https://host/get/cover/123.jpg?t=20260101120000'),
    'https://host/get/cover/123.jpg',
  );

  // 缩略图封面去掉单个 t
  assert.equal(
    normalizeCoverCacheKey('https://host/get/thumb_360_480/123.jpg?t=20260101120000'),
    'https://host/get/thumb_360_480/123.jpg',
  );

  // 带前缀的地址
  assert.equal(
    normalizeCoverCacheKey('https://host:8080/talebook/get/cover/1.jpg?t=123'),
    'https://host:8080/talebook/get/cover/1.jpg',
  );

  // 保留其他参数，顺序与内容正确
  assert.equal(
    normalizeCoverCacheKey('https://host/get/cover/123.jpg?foo=bar&t=20260101&baz=qux'),
    'https://host/get/cover/123.jpg?foo=bar&baz=qux',
  );
});

test('normalizeCoverCacheKey 对无 t 参数的封面或非封面 URL 原样返回', () => {
  // 无 t 参数的封面
  assert.equal(
    normalizeCoverCacheKey('https://host/get/cover/123.jpg'),
    'https://host/get/cover/123.jpg',
  );
  assert.equal(
    normalizeCoverCacheKey('https://host/get/cover/123.jpg?foo=bar'),
    'https://host/get/cover/123.jpg?foo=bar',
  );

  // 非封面 URL 即使有 t 参数也不变
  assert.equal(
    normalizeCoverCacheKey('https://host/api/books?t=123'),
    'https://host/api/books?t=123',
  );
  assert.equal(
    normalizeCoverCacheKey('https://host/get/something/1.jpg?t=123'),
    'https://host/get/something/1.jpg?t=123',
  );

  // data: 和 blob:
  assert.equal(normalizeCoverCacheKey('data:image/jpeg;base64,123'), 'data:image/jpeg;base64,123');
  assert.equal(normalizeCoverCacheKey('blob:http://host/123'), 'blob:http://host/123');
});
