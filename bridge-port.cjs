'use strict';
/**
 * 读 DSHA 桥端口。
 *
 * 刻意不缓存、不回退固定端口：同机可能装着另一个 DSHA，猜一个端口再带上本安装的
 * token 发过去，等于把凭据交给别的应用。读不到就让调用方报"桥不可用"。
 *
 * 文件必须是 0600 的普通文件（不是符号链接、不是 FIFO），长度 1~5 字节全为数字。
 */
const fs = require('node:fs');

const PORT_FILE = '/root/.dsh/.bridge_port';

function parsePort(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 5) return undefined;
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}

function isPrivateFile(info) {
  return info.isFile() && !info.isSymbolicLink() && info.size >= 1 && info.size <= 5
    && (info.mode & 0o077) === 0;
}

function unchanged(left, right) {
  return isPrivateFile(right)
    && ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);
}

function bridgePort() {
  try {
    const before = fs.lstatSync(PORT_FILE);
    if (!isPrivateFile(before)) throw Error('BRIDGE_PORT_FILE');
    // O_NOFOLLOW + O_NONBLOCK：检查后被换成符号链接或 FIFO 也不能卡住或读错对象。
    const fd = fs.openSync(PORT_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (!unchanged(before, opened)) throw Error('BRIDGE_PORT_CHANGED');
      const bytes = Buffer.alloc(6);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count !== opened.size
          || !unchanged(opened, fs.fstatSync(fd))
          || !unchanged(opened, fs.lstatSync(PORT_FILE))) throw Error('BRIDGE_PORT_CHANGED');
      // latin1 保留高位字节；按 ascii 解码会把 0xb3 之类折成合法数字。
      const port = parsePort(bytes.subarray(0, count).toString('latin1'));
      if (port !== undefined) return port;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 端口只负责发现，不赋予任何权限；后续请求仍必须通过当前 token 鉴权。
  }
  const explicit = parsePort(process.env?.DSHA_BRIDGE_PORT);
  if (explicit !== undefined) return explicit;
  throw Object.assign(Error('bridge port unavailable'), { code: 'BRIDGE_PORT_UNAVAILABLE' });
}

module.exports = bridgePort;
