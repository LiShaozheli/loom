import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, readZip, crc32 } from '../src/zip.js';

test('CRC32 对已知输入正确', () => {
  // "123456789" 的标准 CRC32 是 0xCBF43926
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
});

test('往返：写入再读出，内容一致', () => {
  const zip = makeZip([
    { name: 'a.json', data: '{"x":1}' },
    { name: 'nested/b.txt', data: '中文内容' },
  ]);
  const files = readZip(zip);
  assert.equal(files.size, 2);
  assert.equal(files.get('a.json').toString('utf8'), '{"x":1}');
  assert.equal(files.get('nested/b.txt').toString('utf8'), '中文内容');
});

test('二进制内容不损坏', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255, 128]);
  const files = readZip(makeZip([{ name: 'bin', data: bytes }]));
  assert.deepEqual([...files.get('bin')], [...bytes]);
});

test('空包也能读', () => {
  assert.equal(readZip(makeZip([])).size, 0);
});

test('坏包报错而不是静默', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /不是合法的 ZIP/);
});
