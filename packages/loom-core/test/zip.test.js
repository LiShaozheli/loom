import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { makeZip, readZip, crc32, ZIP_LIMITS } from '../src/zip.js';

/**
 * 手工造一个 deflate 包（makeZip 只会 store）。
 * 导入包是外部输入，读 side 必须能对付别人生成的压缩包 —— 也就能对付炸弹。
 */
function makeDeflateZip(name, data, { method = 8 } = {}) {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const comp = zlib.deflateRawSync(raw);
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };

  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(crc32(raw)),
    u32(comp.length),
    u32(raw.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    comp,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(crc32(raw)),
    u32(comp.length),
    u32(raw.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBuf,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  const zip = Buffer.concat([local, central, end]);
  return { zip, centralOffset: local.length, localOffset: 0 };
}

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

// ── 下面几条防的是「导入包是攻击面」：解压炸弹、超量、越界 ──────────

test('压缩炸弹会被解压上限挡住', () => {
  // 20MB 的 'a' deflate 后只有 ~20KB：典型炸弹形状
  const { zip } = makeDeflateZip('bomb.bin', Buffer.alloc(20 * 1024 * 1024, 0x61));
  assert.ok(zip.length < 200 * 1024, '炸弹包本身应当很小：' + zip.length);
  assert.throws(() => readZip(zip), /超过|解压失败/, '没有上限就会把内存吃干');
});

test('上限可以按调用方收紧（也证明限额真的被读进去了）', () => {
  const { zip } = makeDeflateZip('small.txt', 'a'.repeat(4096));
  assert.equal(readZip(zip, { maxEntryBytes: 1024 * 1024 }).get('small.txt').length, 4096);
  assert.throws(() => readZip(zip, { maxEntryBytes: 1024 }), /超过/);
});

test('条目数超过上限直接拒绝', () => {
  const zip = makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  assert.equal(readZip(zip, { maxEntries: 5 }).size, 5);
  assert.throws(() => readZip(zip, { maxEntries: 3 }), /条目太多/);
});

test('解压总量超过上限直接拒绝', () => {
  const one = makeZip([
    { name: 'a.txt', data: 'a'.repeat(1000) },
    { name: 'b.txt', data: 'b'.repeat(1000) },
  ]);
  assert.equal(readZip(one, { maxTotalBytes: 2000 }).size, 2);
  assert.throws(() => readZip(one, { maxTotalBytes: 1500 }), /总量/);
});

test('数据段越界报自己的错，而不是 Buffer 越界异常', () => {
  const { zip } = makeDeflateZip('x.txt', 'hello world');
  const truncated = zip.subarray(0, zip.length - 40);
  assert.throws(
    () => readZip(truncated),
    (e) => e instanceof Error && /越界|损坏|合法/.test(e.message)
  );
});

test('不支持的压缩方式明确报错', () => {
  const { zip, centralOffset } = makeDeflateZip('x.txt', 'hello');
  const patched = Buffer.from(zip);
  patched.writeUInt16LE(9, centralOffset + 10); // 把 method 改成 9
  assert.throws(() => readZip(patched), /不支持的压缩方式/);
});

test('默认上限的数值本身是合理的', () => {
  assert.equal(ZIP_LIMITS.maxEntries, 512);
  assert.equal(ZIP_LIMITS.maxEntryBytes, 8 * 1024 * 1024);
  assert.ok(ZIP_LIMITS.maxTotalBytes >= ZIP_LIMITS.maxEntryBytes);
});
