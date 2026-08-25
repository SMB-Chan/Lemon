(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LemonCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ZIP_UTF8 = 0x0800;
  const ZIP_DATA_DESCRIPTOR = 0x0008;
  const ZIP_STREAM_FLAGS = ZIP_UTF8 | ZIP_DATA_DESCRIPTOR;
  const MAX_ID_CHARS = 128;
  const MAX_NAME_CHARS = 1024;
  const MAX_PATH_CHARS = 4096;
  const MAX_MIME_CHARS = 256;
  const MAX_GROUP_COUNT = 100000;
  const MAX_ZIP_NAME_BYTES = 0xffff;
  const MAX_SAFE_SIZE = Number.MAX_SAFE_INTEGER;

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, prev) {
    let c = (((prev == null ? 0 : prev) >>> 0) ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' が不正です');
    return value;
  }

  function finiteSize(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_SIZE) {
      throw new Error(label + ' が不正です');
    }
    return value;
  }

  function boundedString(value, label, max, allowEmpty) {
    if (typeof value !== 'string') throw new Error(label + ' が不正です');
    if ((!allowEmpty && value.length === 0) || value.length > max) throw new Error(label + ' が不正です');
    if (/\0/.test(value)) throw new Error(label + ' にNUL文字を含めることはできません');
    return value;
  }

  function safeZipPath(path, fallback) {
    let raw = String(path || fallback || 'file');
    if (raw.length > MAX_PATH_CHARS) throw new Error('ZIP内パスが長すぎます');
    if (/\0|[\u0001-\u001f\u007f]/.test(raw)) throw new Error('ZIP内パスに制御文字を含めることはできません');
    raw = raw.replace(/\\/g, '/');
    if (/^\//.test(raw) || /^[A-Za-z]:($|\/)/.test(raw)) throw new Error('絶対パスはZIPに格納できません');

    const out = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') throw new Error('親ディレクトリ参照を含むZIP内パスは拒否されました');
      out.push(part);
    }

    let normalized = out.join('/');
    if (!normalized && fallback && String(fallback) !== raw) normalized = safeZipPath(String(fallback), 'file');
    if (!normalized) normalized = 'file';

    const bytes = new TextEncoder().encode(normalized);
    if (bytes.length > MAX_ZIP_NAME_BYTES) throw new Error('ZIP内パスが長すぎます');
    return normalized;
  }

  function validateTransferMeta(meta) {
    assertPlainObject(meta, '転送メタデータ');
    const out = Object.assign({}, meta);
    out.id = boundedString(meta.id, '転送ID', MAX_ID_CHARS, false);
    out.name = boundedString(meta.name, 'ファイル名', MAX_NAME_CHARS, false);
    out.size = finiteSize(meta.size, 'ファイルサイズ');
    out.mime = meta.mime == null ? 'application/octet-stream' : boundedString(meta.mime, 'MIMEタイプ', MAX_MIME_CHARS, true);
    if (meta.path != null) out.path = safeZipPath(boundedString(meta.path, 'パス', MAX_PATH_CHARS, false), out.name);
    if (meta.folderId != null) out.folderId = boundedString(meta.folderId, 'フォルダID', MAX_ID_CHARS, false);
    if (meta.bundleId != null) out.bundleId = boundedString(meta.bundleId, 'バンドルID', MAX_ID_CHARS, false);
    if (meta.splitId != null) out.splitId = boundedString(meta.splitId, '分割ID', MAX_ID_CHARS, false);
    if (meta.partIndex != null && (!Number.isInteger(meta.partIndex) || meta.partIndex < 0)) throw new Error('パート番号が不正です');
    if (meta.partCount != null && (!Number.isInteger(meta.partCount) || meta.partCount < 1 || meta.partCount > MAX_GROUP_COUNT)) throw new Error('パート数が不正です');
    if (meta.mtime != null && (!Number.isFinite(meta.mtime) || meta.mtime < 0)) throw new Error('更新日時が不正です');
    return out;
  }

  function validateGroupMeta(meta) {
    assertPlainObject(meta, 'グループメタデータ');
    const out = Object.assign({}, meta);
    out.id = boundedString(meta.id, 'グループID', MAX_ID_CHARS, false);
    out.name = boundedString(meta.name, 'グループ名', MAX_NAME_CHARS, false);
    out.size = finiteSize(meta.size, '合計サイズ');
    if (!Number.isInteger(meta.count) || meta.count < 0 || meta.count > MAX_GROUP_COUNT) throw new Error('ファイル数が不正です');
    out.count = meta.count;
    if (meta.splitId != null) out.splitId = boundedString(meta.splitId, '分割ID', MAX_ID_CHARS, false);
    if (meta.partIndex != null && (!Number.isInteger(meta.partIndex) || meta.partIndex < 0)) throw new Error('パート番号が不正です');
    if (meta.partCount != null && (!Number.isInteger(meta.partCount) || meta.partCount < 1 || meta.partCount > MAX_GROUP_COUNT)) throw new Error('パート数が不正です');
    return out;
  }

  function verifyEnd(meta, received, crc, end) {
    if (!meta || !Number.isSafeInteger(received) || received < 0) return { ok: false, reason: '受信状態が不正です' };
    if (received !== meta.size) return { ok: false, reason: '受信サイズが一致しません' };
    if (end && end.size != null && end.size !== meta.size) return { ok: false, reason: '終了メッセージのサイズが一致しません' };
    if (end && end.crc != null && ((end.crc >>> 0) !== (crc >>> 0))) return { ok: false, reason: 'CRC32が一致しません' };
    return { ok: true, reason: '' };
  }

  function dosDateTime(d) {
    const dateObj = d instanceof Date ? d : new Date(d);
    const year = Math.max(1980, Math.min(2107, dateObj.getFullYear()));
    const time = (dateObj.getHours() << 11) | (dateObj.getMinutes() << 5) | Math.floor(dateObj.getSeconds() / 2);
    const date = (((year - 1980) & 0x7F) << 9) | ((dateObj.getMonth() + 1) << 5) | dateObj.getDate();
    return { time: time, date: date };
  }

  function needsZip64(value) {
    return value > 0xFFFFFFFE;
  }

  function buildLocalHeaderStream(nameBytes, size, mtime) {
    const zip64 = needsZip64(size);
    const extraLen = zip64 ? 20 : 0;
    const buf = new ArrayBuffer(30 + nameBytes.length + extraLen);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let o = 0;
    dv.setUint32(o, 0x04034b50, true); o += 4;
    dv.setUint16(o, zip64 ? 45 : 20, true); o += 2;
    dv.setUint16(o, ZIP_STREAM_FLAGS, true); o += 2;
    dv.setUint16(o, 0, true); o += 2;
    const dt = dosDateTime(mtime);
    dv.setUint16(o, dt.time, true); o += 2;
    dv.setUint16(o, dt.date, true); o += 2;
    dv.setUint32(o, 0, true); o += 4;
    dv.setUint32(o, zip64 ? 0xFFFFFFFF : 0, true); o += 4;
    dv.setUint32(o, zip64 ? 0xFFFFFFFF : 0, true); o += 4;
    dv.setUint16(o, nameBytes.length, true); o += 2;
    dv.setUint16(o, extraLen, true); o += 2;
    u8.set(nameBytes, o); o += nameBytes.length;
    if (zip64) {
      dv.setUint16(o, 0x0001, true); o += 2;
      dv.setUint16(o, 16, true); o += 2;
      dv.setBigUint64(o, BigInt(size), true); o += 8;
      dv.setBigUint64(o, BigInt(size), true); o += 8;
    }
    return buf;
  }

  function buildDataDescriptor(crc, size) {
    const zip64 = needsZip64(size);
    const buf = new ArrayBuffer(zip64 ? 24 : 16);
    const dv = new DataView(buf);
    let o = 0;
    dv.setUint32(o, 0x08074b50, true); o += 4;
    dv.setUint32(o, crc >>> 0, true); o += 4;
    if (zip64) {
      dv.setBigUint64(o, BigInt(size), true); o += 8;
      dv.setBigUint64(o, BigInt(size), true); o += 8;
    } else {
      dv.setUint32(o, size, true); o += 4;
      dv.setUint32(o, size, true); o += 4;
    }
    return buf;
  }

  function buildCentralRecord(rec) {
    const zip64Size = needsZip64(rec.size);
    const zip64Offset = needsZip64(rec.offset);
    const vals = [];
    if (zip64Size) vals.push(rec.size, rec.size);
    if (zip64Offset) vals.push(rec.offset);
    const extra = new Uint8Array(vals.length ? 4 + 8 * vals.length : 0);
    if (vals.length) {
      const edv = new DataView(extra.buffer);
      edv.setUint16(0, 0x0001, true);
      edv.setUint16(2, 8 * vals.length, true);
      vals.forEach(function (v, i) { edv.setBigUint64(4 + i * 8, BigInt(v), true); });
    }
    const zip64 = vals.length > 0;
    const buf = new ArrayBuffer(46 + rec.nameBytes.length + extra.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let o = 0;
    dv.setUint32(o, 0x02014b50, true); o += 4;
    dv.setUint16(o, zip64 ? 45 : 20, true); o += 2;
    dv.setUint16(o, zip64 ? 45 : 20, true); o += 2;
    dv.setUint16(o, rec.flags == null ? ZIP_UTF8 : rec.flags, true); o += 2;
    dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, rec.time, true); o += 2;
    dv.setUint16(o, rec.date, true); o += 2;
    dv.setUint32(o, rec.crc >>> 0, true); o += 4;
    dv.setUint32(o, zip64Size ? 0xFFFFFFFF : rec.size, true); o += 4;
    dv.setUint32(o, zip64Size ? 0xFFFFFFFF : rec.size, true); o += 4;
    dv.setUint16(o, rec.nameBytes.length, true); o += 2;
    dv.setUint16(o, extra.length, true); o += 2;
    dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, 0, true); o += 2;
    dv.setUint16(o, 0, true); o += 2;
    dv.setUint32(o, 0, true); o += 4;
    dv.setUint32(o, zip64Offset ? 0xFFFFFFFF : rec.offset, true); o += 4;
    u8.set(rec.nameBytes, o); o += rec.nameBytes.length;
    u8.set(extra, o);
    return buf;
  }

  function buildArchiveTail(records, cdOffset) {
    const cdParts = records.map(buildCentralRecord);
    const cdSize = cdParts.reduce(function (sum, b) { return sum + b.byteLength; }, 0);
    const count = records.length;
    const zip64 = count > 0xFFFF || needsZip64(cdSize) || needsZip64(cdOffset);
    const parts = cdParts.slice();

    if (zip64) {
      const z = new ArrayBuffer(56);
      const zdv = new DataView(z);
      zdv.setUint32(0, 0x06064b50, true);
      zdv.setBigUint64(4, 44n, true);
      zdv.setUint16(12, 45, true);
      zdv.setUint16(14, 45, true);
      zdv.setBigUint64(24, BigInt(count), true);
      zdv.setBigUint64(32, BigInt(count), true);
      zdv.setBigUint64(40, BigInt(cdSize), true);
      zdv.setBigUint64(48, BigInt(cdOffset), true);
      parts.push(z);

      const loc = new ArrayBuffer(20);
      const ldv = new DataView(loc);
      ldv.setUint32(0, 0x07064b50, true);
      ldv.setBigUint64(8, BigInt(cdOffset + cdSize), true);
      ldv.setUint32(16, 1, true);
      parts.push(loc);
    }

    const e = new ArrayBuffer(22);
    const edv = new DataView(e);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, zip64 && count > 0xFFFF ? 0xFFFF : count, true);
    edv.setUint16(10, zip64 && count > 0xFFFF ? 0xFFFF : count, true);
    edv.setUint32(12, needsZip64(cdSize) ? 0xFFFFFFFF : cdSize, true);
    edv.setUint32(16, needsZip64(cdOffset) ? 0xFFFFFFFF : cdOffset, true);
    parts.push(e);
    return parts;
  }

  function planZip(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('ZIPに格納するファイルがありません');
    const enc = new TextEncoder();
    const planned = [];
    let pos = 0;

    for (const entry of entries) {
      const size = finiteSize(entry.size, 'ファイルサイズ');
      const path = safeZipPath(entry.path, entry.name || 'file');
      const nameBytes = enc.encode(path);
      const mtime = new Date(entry.mtime || Date.now());
      const header = buildLocalHeaderStream(nameBytes, size, mtime);
      const descriptorSize = buildDataDescriptor(0, size).byteLength;
      const recOffset = pos;
      const dt = dosDateTime(mtime);
      planned.push({
        path: path,
        nameBytes: nameBytes,
        mtime: mtime,
        size: size,
        header: header,
        descriptorSize: descriptorSize,
        offset: recOffset,
        time: dt.time,
        date: dt.date,
        flags: ZIP_STREAM_FLAGS,
      });
      pos += header.byteLength + size + descriptorSize;
      if (!Number.isSafeInteger(pos)) throw new Error('ZIPサイズがJavaScriptの安全な整数範囲を超えます');
    }

    const provisional = planned.map(function (item) {
      return {
        nameBytes: item.nameBytes,
        crc: 0,
        size: item.size,
        offset: item.offset,
        time: item.time,
        date: item.date,
        flags: item.flags,
      };
    });
    const tail = buildArchiveTail(provisional, pos);
    const tailSize = tail.reduce(function (sum, part) { return sum + part.byteLength; }, 0);
    const totalSize = pos + tailSize;
    if (!Number.isSafeInteger(totalSize)) throw new Error('ZIPサイズがJavaScriptの安全な整数範囲を超えます');
    return { entries: planned, dataEndOffset: pos, tailSize: tailSize, totalSize: totalSize };
  }

  function partitionEntries(entries, limit) {
    if (!Array.isArray(entries)) return [];
    const max = finiteSize(limit, '分割サイズ');
    const parts = [];
    let cur = [];
    let curSize = 0;
    for (const entry of entries) {
      const size = finiteSize(entry && entry.file ? entry.file.size : entry.size, 'ファイルサイズ');
      if (cur.length && curSize + size > max) {
        parts.push(cur);
        cur = [];
        curSize = 0;
      }
      cur.push(entry);
      curSize += size;
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  return {
    ZIP_UTF8: ZIP_UTF8,
    ZIP_DATA_DESCRIPTOR: ZIP_DATA_DESCRIPTOR,
    ZIP_STREAM_FLAGS: ZIP_STREAM_FLAGS,
    MAX_GROUP_COUNT: MAX_GROUP_COUNT,
    crc32: crc32,
    safeZipPath: safeZipPath,
    validateTransferMeta: validateTransferMeta,
    validateGroupMeta: validateGroupMeta,
    verifyEnd: verifyEnd,
    dosDateTime: dosDateTime,
    buildLocalHeaderStream: buildLocalHeaderStream,
    buildDataDescriptor: buildDataDescriptor,
    buildCentralRecord: buildCentralRecord,
    buildArchiveTail: buildArchiveTail,
    planZip: planZip,
    partitionEntries: partitionEntries,
  };
});
