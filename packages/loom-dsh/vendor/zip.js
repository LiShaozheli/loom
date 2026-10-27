/**
 * 最小 ZIP 读写（零依赖）。
 *
 * 为什么不引第三方：这个工程的一条约定是「Node 22 内置模块 + 自己写」，
 * 而 ZIP 的 store 模式只需要 CRC32 + 文件头，一百多行就够；
 * 读的时候用 zlib.inflateRawSync 兜住 deflate，能读别人生成的包。
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/**
 * 打一个 ZIP（全部 store，不压缩；这里的数据都是 JSON，压缩率不值得复杂化）
 * @param {{name:string, data:Buffer|string}[]} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(dataBuf);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // utf8 flag
      u16(0), // method: store
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(dataBuf.length),
      u32(dataBuf.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      dataBuf,
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(dataBuf.length),
      u32(dataBuf.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    centrals.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * 解压上限。导入包是从外部（可能是网页、可能是别人发来的 zip）进来的，
 * 不设限的话一个 42KB 的 deflate 炸弹能解出几个 GB，直接把宿主撑爆。
 * 记忆库的正常体量远小于这些数字：单条记录几 KB，整包几十 MB 已经很大了。
 */
/** @type {Readonly<{maxEntries:number, maxEntryBytes:number, maxTotalBytes:number}>} */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 512,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

/**
 * 读 ZIP：支持 store 与 deflate。
 * @param {Buffer} buf
 * @param {Partial<typeof ZIP_LIMITS>} [limits]
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf, limits = {}) {
  const cap = { ...ZIP_LIMITS, ...limits };
  const out = new Map();
  let total = 0;

  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到目录结尾');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  // 条目数先卡住：一个 512 条的包已经远超正常记忆备份
  if (count > cap.maxEntries) {
    throw new Error(`ZIP 条目太多（${count} > ${cap.maxEntries}），拒绝读取`);
  }

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) throw new Error('目录项越界');
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('目录项损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (localOffset + 30 > buf.length) throw new Error('本地头越界：' + name);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地头损坏：' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error('数据段越界：' + name);
    const raw = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 8) {
      // maxOutputLength 是关键：没有它，炸弹包在 inflate 阶段就把内存吃干
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: cap.maxEntryBytes });
      } catch (e) {
        if (
          e?.code === 'ERR_BUFFER_TOO_LARGE' ||
          /maxOutputLength|buffer/i.test(String(e?.message))
        ) {
          throw new Error(`ZIP 条目解压后超过 ${cap.maxEntryBytes} 字节，拒绝读取：${name}`);
        }
        throw new Error(`ZIP 条目解压失败：${name}（${e?.message ?? e}）`);
      }
    } else if (method === 0) {
      if (raw.length > cap.maxEntryBytes) {
        throw new Error(`ZIP 条目超过 ${cap.maxEntryBytes} 字节，拒绝读取：${name}`);
      }
      data = Buffer.from(raw);
    } else {
      throw new Error(`不支持的压缩方式 ${method}：${name}`);
    }

    total += data.length;
    if (total > cap.maxTotalBytes) {
      throw new Error(`ZIP 解压总量超过 ${cap.maxTotalBytes} 字节，拒绝读取`);
    }

    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}
