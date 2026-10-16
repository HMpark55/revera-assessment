'use strict';
/**
 * 외부 라이브러리 없이 ZIP 파일 만들기 (백업용).
 * 파일을 하나씩 읽어 압축해 바로 디스크에 쓰므로 전체를 메모리에 올리지 않습니다.
 * ZIP64는 지원하지 않으므로 전체 4GB 미만이어야 합니다.
 */
const fs = require('fs');
const zlib = require('zlib');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * entries: [{ name: 'zip 안 경로', path?: '디스크 파일', data?: Buffer }]
 */
function writeZip(destPath, entries) {
  const fd = fs.openSync(destPath, 'w');
  const central = [];
  let offset = 0;
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const e of entries) {
      const raw = e.data || fs.readFileSync(e.path);
      const deflated = zlib.deflateRawSync(raw);
      const useDeflate = deflated.length < raw.length;
      const body = useDeflate ? deflated : raw;
      const crc = crc32(raw);
      const nameBuf = Buffer.from(e.name, 'utf8');
      const { time, date } = dosTime(new Date());
      if (offset + 30 + nameBuf.length + body.length > 0xfffffff0) throw new Error('백업이 4GB를 넘어 ZIP으로 만들 수 없습니다.');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 파일 이름
      local.writeUInt16LE(useDeflate ? 8 : 0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      write(local); write(nameBuf); write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(useDeflate ? 8 : 0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(body.length, 20);
      c.writeUInt32LE(raw.length, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt32LE(headerOffset, 42);
      central.push(Buffer.concat([c, nameBuf]));
    }
    const cdStart = offset;
    central.forEach(write);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { writeZip, crc32 };
