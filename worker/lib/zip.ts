/**
 * 极简 ZIP 读写：只使用 store（不压缩）方式，用于完整备份中的数据库 JSON 与附件二进制。
 * 不依赖第三方库，避免在 Workers 运行时引入额外依赖。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function createZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const { time, date } = dosDateTime();
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    return { ...entry, nameBytes, crc: crc32(entry.data), offset: 0 };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of prepared) {
    localSize += 30 + entry.nameBytes.length + entry.data.length;
    centralSize += 46 + entry.nameBytes.length;
  }

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const writeU16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const writeU32 = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true);

  let offset = 0;
  for (const entry of prepared) {
    entry.offset = offset;
    writeU32(offset, 0x04034b50);
    writeU16(offset + 4, 20);
    writeU16(offset + 6, 0x0800); // 文件名使用 UTF-8
    writeU16(offset + 8, 0); // store
    writeU16(offset + 10, time);
    writeU16(offset + 12, date);
    writeU32(offset + 14, entry.crc);
    writeU32(offset + 18, entry.data.length);
    writeU32(offset + 22, entry.data.length);
    writeU16(offset + 26, entry.nameBytes.length);
    writeU16(offset + 28, 0);
    out.set(entry.nameBytes, offset + 30);
    out.set(entry.data, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.data.length;
  }

  const centralOffset = offset;
  for (const entry of prepared) {
    writeU32(offset, 0x02014b50);
    writeU16(offset + 4, 20);
    writeU16(offset + 6, 20);
    writeU16(offset + 8, 0x0800);
    writeU16(offset + 10, 0);
    writeU16(offset + 12, time);
    writeU16(offset + 14, date);
    writeU32(offset + 16, entry.crc);
    writeU32(offset + 20, entry.data.length);
    writeU32(offset + 24, entry.data.length);
    writeU16(offset + 28, entry.nameBytes.length);
    writeU16(offset + 30, 0);
    writeU16(offset + 32, 0);
    writeU16(offset + 34, 0);
    writeU16(offset + 36, 0);
    writeU32(offset + 38, 0);
    writeU32(offset + 42, entry.offset);
    out.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  }

  writeU32(offset, 0x06054b50);
  writeU16(offset + 4, 0);
  writeU16(offset + 6, 0);
  writeU16(offset + 8, prepared.length);
  writeU16(offset + 10, prepared.length);
  writeU32(offset + 12, centralSize);
  writeU32(offset + 16, centralOffset);
  writeU16(offset + 20, 0);

  return out;
}

function readU16(view: DataView, offset: number): number {
  if (offset + 2 > view.byteLength) throw new Error("ZIP 文件不完整");
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  if (offset + 4 > view.byteLength) throw new Error("ZIP 文件不完整");
  return view.getUint32(offset, true);
}

export function readZip(data: Uint8Array): Map<string, Uint8Array> {
  if (data.length < 22) throw new Error("ZIP 文件不完整");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // 从尾部向前查找 EOCD 签名（注释长度最大 65535 字节）
  let eocd = -1;
  const start = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= start; i--) {
    if (readU32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("不是有效的 ZIP 备份文件");

  const count = readU16(view, eocd + 10);
  const centralOffset = readU32(view, eocd + 16);
  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;

  for (let i = 0; i < count; i++) {
    if (readU32(view, cursor) !== 0x02014b50) throw new Error("ZIP 目录结构损坏");
    const flags = readU16(view, cursor + 8);
    const method = readU16(view, cursor + 10);
    const compressedSize = readU32(view, cursor + 20);
    const uncompressedSize = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const localOffset = readU32(view, cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > data.length) throw new Error("ZIP 目录结构损坏");
    const name = decoder.decode(data.subarray(nameStart, nameEnd));

    if (flags & 0x0001) throw new Error("备份文件已加密，无法导入");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error("暂不支持 ZIP64 格式的备份文件");
    if (method !== 0) throw new Error("备份文件需要以“存储（不压缩）”方式打包，请使用系统导出的 zip 文件");

    if (!name.endsWith("/")) {
      if (readU32(view, localOffset) !== 0x04034b50) throw new Error("ZIP 文件内容损坏");
      const localNameLength = readU16(view, localOffset + 26);
      const localExtraLength = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > data.length) throw new Error("ZIP 文件内容不完整");
      entries.set(name, data.subarray(dataStart, dataEnd));
    }

    cursor = nameEnd + extraLength + commentLength;
  }

  return entries;
}
