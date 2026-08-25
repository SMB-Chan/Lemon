(function () {
  'use strict';

  const C = window.LemonCore;
  if (!C) throw new Error('LemonCore を読み込めませんでした');

  const $ = (s) => document.querySelector(s);
  const myIdEl = $('#my-id');
  const statusEl = $('#status');
  const copyBtn = $('#copy-btn');
  const peerInput = $('#peer-input');
  const connectBtn = $('#connect-btn');
  const connListEl = $('#conn-list');
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const folderInput = $('#folder-input');
  const sendTargetEl = $('#send-target');
  const transferListEl = $('#transfer-list');
  const toastEl = $('#toast');
  const zipOpt = $('#zip-opt');
  const qrCanvas = $('#my-qr');
  const qrHint = $('#qr-hint');

  const CHUNK = 1024 * 1024;
  const BUFFER_HIGH = 4 * 1024 * 1024;
  const BUFFER_LOW = 1 * 1024 * 1024;
  const RECV_STALL_MS = 15000;
  const PART_LIMIT = 1024 * 1024 * 1024;
  const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const ID_LENGTH = 10;
  const PROTOCOL_VERSION = 2;

  let peer = null;
  let reconnecting = false;
  const connections = new Map();
  let selectedConn = null;
  let quietPeerErrors = false;

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : randomToken(24);
  }

  function randomToken(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let out = '';
    for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
  }

  function randomId() {
    return 'drop-' + randomToken(ID_LENGTH);
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return Math.max(0, Math.round(n)) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
  }

  function safeDownloadName(path) {
    return String(path || 'file').replace(/[\/\\\0]/g, '_').slice(0, 240) || 'file';
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  // ---------- power management ----------

  let wakeLockHandle = null;
  let keepAliveAudio = null;
  let activeTransfers = 0;

  async function acquireWakeLock() {
    if (wakeLockHandle || !('wakeLock' in navigator)) return;
    try {
      wakeLockHandle = await navigator.wakeLock.request('screen');
      wakeLockHandle.addEventListener('release', () => { wakeLockHandle = null; }, { once: true });
    } catch (_) {}
  }

  function releaseWakeLock() {
    if (!wakeLockHandle) return;
    wakeLockHandle.release().catch(() => {});
    wakeLockHandle = null;
  }

  function startKeepAliveAudio() {
    if (keepAliveAudio) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      ctx.resume().catch(() => {});
      keepAliveAudio = { ctx, osc };
    } catch (_) {}
  }

  function stopKeepAliveAudio() {
    if (!keepAliveAudio) return;
    try { keepAliveAudio.osc.stop(); } catch (_) {}
    try { keepAliveAudio.ctx.close(); } catch (_) {}
    keepAliveAudio = null;
  }

  function beginTransfer() {
    activeTransfers++;
    acquireWakeLock();
    startKeepAliveAudio();
  }

  function endTransfer() {
    activeTransfers = Math.max(0, activeTransfers - 1);
    if (activeTransfers === 0) {
      releaseWakeLock();
      stopKeepAliveAudio();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeTransfers > 0) acquireWakeLock();
  });

  // ---------- QR pairing ----------

  function pairingUrl(id) {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return location.origin + location.pathname + '?peer=' + encodeURIComponent(id);
    }
    return id;
  }

  function drawQR(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(2, Math.floor(240 / (n + quiet * 2)));
    const size = (n + quiet * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((quiet + c) * scale, (quiet + r) * scale, scale, scale);
      }
    }
  }

  function refreshQR(id) {
    if (!id) return;
    if (typeof qrcode !== 'function') {
      qrHint.textContent = 'QRライブラリを読み込めませんでした（要ネット接続）';
      return;
    }
    try {
      drawQR(qrCanvas, pairingUrl(id));
      qrCanvas.hidden = false;
      qrHint.textContent = (location.protocol === 'http:' || location.protocol === 'https:')
        ? '相手の端末でスキャンするとコード入力なしで接続できます'
        : 'ローカルファイル起動ではQRはコード共有用です。相手側で手入力してください';
    } catch (err) {
      console.error(err);
      qrHint.textContent = 'QRを生成できませんでした';
    }
  }

  // ---------- PeerJS ----------

  function initPeer(id) {
    peer = new Peer(id, { debug: 1 });

    peer.on('open', (pid) => {
      myIdEl.textContent = pid;
      setStatus('準備完了', 'ok');
      refreshQR(pid);
      if (preset && !presetUsed) {
        presetUsed = true;
        connectTo(preset);
      }
    });

    peer.on('connection', (conn) => setupConnection(conn, false));

    peer.on('disconnected', () => {
      if (peer.destroyed) return;
      setStatus('再接続中…', 'warn');
      if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          try { peer.reconnect(); } catch (_) {}
          reconnecting = false;
        }, 1000);
      }
    });

    peer.on('error', (err) => {
      switch (err.type) {
        case 'unavailable-id':
          peer.destroy();
          initPeer(randomId());
          break;
        case 'peer-unavailable': {
          const quiet = quietPeerErrors;
          quietPeerErrors = false;
          if (!quiet) toast('そのコードの相手が見つかりませんでした');
          connectBtn.disabled = false;
          break;
        }
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          setStatus('シグナリングサーバーに接続できません', 'err');
          break;
        default:
          console.error(err);
      }
    });
  }

  function setupConnection(conn, outgoing) {
    const remoteId = conn.peer;
    const existing = connections.get(remoteId);
    if (existing) {
      if (outgoing) {
        toast('既に接続済みです');
        conn.close();
      }
      return;
    }

    conn._pendingAccept = new Map();
    conn._sendTail = Promise.resolve();
    conn._incoming = null;
    conn._folder = null;
    conn._autoSplit = null;
    conn._partAck = null;
    conn._stallTimer = null;
    conn._remoteVersion = 1;
    connections.set(remoteId, conn);

    conn.on('open', () => {
      try { conn.send({ t: 'hello', app: 'lemon', v: PROTOCOL_VERSION }); } catch (_) {}
      renderConnections();
      if (!selectedConn || !selectedConn.open) selectConnection(conn);
      toast(remoteId + ' と接続しました');
    });

    conn.on('data', (data) => handleData(conn, data));

    conn.on('close', () => {
      for (const pending of conn._pendingAccept.values()) pending.res(false);
      conn._pendingAccept.clear();
      if (conn._stallTimer) {
        clearInterval(conn._stallTimer);
        conn._stallTimer = null;
      }
      if (conn._folder) {
        failEntry(conn._folder.entry, '中断（切断されました）');
        endTransfer();
        conn._folder = null;
      }
      if (conn._incoming) {
        if (!conn._incoming.isFolderFile) {
          failEntry(conn._incoming.entry, '中断（切断されました）');
          endTransfer();
        }
        conn._incoming = null;
      }
      connections.delete(remoteId);
      if (selectedConn === conn) selectConnection(null);
      renderConnections();
    });

    conn.on('error', (err) => {
      console.error(err);
      toast('接続エラー: ' + remoteId);
    });
  }

  function selectConnection(conn) {
    selectedConn = conn && conn.open ? conn : null;
    sendTargetEl.innerHTML = selectedConn ? '送信先: <b></b>' : '送信先: まだ接続なし';
    if (selectedConn) sendTargetEl.querySelector('b').textContent = selectedConn.peer;
    renderConnections();
  }

  function renderConnections() {
    connListEl.innerHTML = '';
    for (const [pid, conn] of connections) {
      const li = document.createElement('li');
      li.className = 'conn-row' + (conn === selectedConn ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = pid;
      const useBtn = document.createElement('button');
      useBtn.className = 'sub';
      useBtn.textContent = conn === selectedConn ? '送信先に指定中' : 'これに送信';
      useBtn.onclick = () => selectConnection(conn);
      const cutBtn = document.createElement('button');
      cutBtn.className = 'danger';
      cutBtn.textContent = '切断';
      cutBtn.onclick = () => conn.close();
      li.append(dot, name, useBtn, cutBtn);
      connListEl.appendChild(li);
    }
  }

  function connectTo(rawId, quiet) {
    const id = String(rawId || '').trim();
    if (!id) return;
    if (id.length > 128) {
      if (!quiet) toast('相手コードが長すぎます');
      return;
    }
    if (peer && id === peer.id) {
      if (!quiet) toast('自分自身には接続できません');
      return;
    }
    if (connections.has(id)) {
      if (!quiet) {
        toast('既に接続済みです');
        selectConnection(connections.get(id));
      }
      return;
    }
    connectBtn.disabled = true;
    quietPeerErrors = !!quiet;
    const conn = peer.connect(id, { reliable: true, serialization: 'binary' });
    setupConnection(conn, true);
    conn.on('open', () => {
      connectBtn.disabled = false;
      quietPeerErrors = false;
    });
    setTimeout(() => { connectBtn.disabled = false; }, 10000);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureConnection(remoteId, tries, intervalMs) {
    for (let i = 0; i < tries; i++) {
      const c = connections.get(remoteId);
      if (c && c.open) return c;
      if (peer && !peer.destroyed) {
        try { connectTo(remoteId, true); } catch (_) {}
      }
      await sleep(intervalMs);
    }
    const c = connections.get(remoteId);
    return c && c.open ? c : null;
  }

  // ---------- input ----------

  async function entriesFromDataTransfer(dt) {
    const items = dt.items ? Array.from(dt.items) : [];
    const roots = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    const out = [];
    if (roots.length) {
      for (const root of roots) await walkEntry(root, '', out);
      return out;
    }
    return Array.from(dt.files || []).map((file) => ({ file, path: file.name }));
  }

  function walkEntry(entry, basePath, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (file) => { out.push({ file, path: basePath + entry.name }); resolve(); },
          () => resolve()
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const prefix = basePath + entry.name + '/';
        const readBatch = () => reader.readEntries(
          async (batch) => {
            if (!batch.length) return resolve();
            for (const child of batch) await walkEntry(child, prefix, out);
            readBatch();
          },
          () => resolve()
        );
        readBatch();
      } else {
        resolve();
      }
    });
  }

  function enqueueSend(conn, job) {
    const run = conn._sendTail.catch(() => {}).then(job);
    conn._sendTail = run.catch(() => {});
    return run;
  }

  async function sendSelected(entries) {
    if (!entries || !entries.length) {
      toast('送信できるファイルがありませんでした');
      return;
    }
    if (!selectedConn || !selectedConn.open) {
      toast('送信する前に相手と接続してください');
      return;
    }
    const conn = selectedConn;
    const useZip = zipOpt.checked;
    return enqueueSend(conn, () => sendSelectedNow(conn, entries, useZip));
  }

  async function sendSelectedNow(conn, entries, useZip) {
    if (!conn.open) throw new Error('送信先との接続が切れています');

    if (useZip && entries.length > 1) {
      const zipName = pickZipName(entries);
      const parts = C.partitionEntries(entries, PART_LIMIT);
      if (parts.length === 1) await sendAsZip(conn, entries, zipName);
      else await sendSplit(conn, parts, zipName);
      return;
    }

    const singles = [];
    const groups = new Map();
    for (const entry of entries) {
      if (entry.path && entry.path.includes('/')) {
        const top = entry.path.split('/')[0];
        if (!groups.has(top)) groups.set(top, []);
        groups.get(top).push(entry);
      } else {
        singles.push(entry);
      }
    }

    for (const [top, list] of groups) await sendFolder(conn, top, list);
    for (const entry of singles) await sendFile(conn, entry.file);
  }

  function pickZipName(entries) {
    const tops = new Set();
    let onlyFolder = true;
    for (const entry of entries) {
      if (entry.path && entry.path.includes('/')) tops.add(entry.path.split('/')[0]);
      else onlyFolder = false;
    }
    if (onlyFolder && tops.size === 1) return safeDownloadName([...tops][0]) + '.zip';
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return 'transfer-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
      + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.zip';
  }

  async function sendSplit(conn, parts, baseName) {
    const remoteId = conn.peer;
    const splitId = uid();
    const stem = baseName.replace(/\.zip$/i, '');
    toast(parts.length + ' 個のZIPに分割して送信します');

    for (let i = 0; i < parts.length; i++) {
      const partName = stem + '-' + (i + 1) + 'of' + parts.length + '.zip';
      const opts = { splitId, partIndex: i, partCount: parts.length };
      let result = 'error';
      let attempts = 0;

      while (result === 'error' && attempts < 5) {
        const c = attempts === 0 && conn.open ? conn : await ensureConnection(remoteId, 40, 5000);
        if (!c) {
          toast('再接続できないため、分割送信を中止します');
          return;
        }
        attempts++;
        result = await sendAsZip(c, parts[i], partName, opts);
        if (result === 'error') toast('切断されました。パート単位で再試行します…');
      }

      if (result !== 'done') return;
      if (i < parts.length - 1) {
        const c = connections.get(remoteId);
        const saved = c && c.open ? await waitForPartAck(c, splitId, i, 10 * 60 * 1000) : false;
        if (!saved) {
          toast('受信側の保存確認が取れないため、次のパート送信を中止しました');
          return;
        }
      }
    }
    toast('分割送信が完了しました（' + parts.length + ' パート）');
  }

  function waitForPartAck(conn, splitId, partIndex, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const ack = conn._partAck;
        if (ack && ack.splitId === splitId && ack.partIndex === partIndex) {
          conn._partAck = null;
          clearInterval(timer);
          resolve(true);
        } else if (!conn.open || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 500);
    });
  }

  // ---------- sending ----------

  function waitForAccept(conn, metaId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = conn._pendingAccept.get(metaId);
        if (pending) {
          conn._pendingAccept.delete(metaId);
          resolve(false);
        }
      }, 60000);
      conn._pendingAccept.set(metaId, {
        res: (value) => {
          clearTimeout(timer);
          conn._pendingAccept.delete(metaId);
          resolve(value);
        },
      });
    });
  }

  function waitBufferDrain(conn) {
    return new Promise((resolve) => {
      const dc = conn.dataChannel;
      if (!dc || dc.bufferedAmount < BUFFER_HIGH) return resolve();
      const timer = setInterval(() => {
        if (!conn.open || dc.bufferedAmount < BUFFER_LOW) {
          clearInterval(timer);
          resolve();
        }
      }, 30);
    });
  }

  async function sendBuffer(conn, buffer) {
    if (!conn.open) throw new Error('切断されました');
    if (conn.dataChannel && conn.dataChannel.bufferedAmount > BUFFER_HIGH) await waitBufferDrain(conn);
    if (!conn.open) throw new Error('切断されました');
    conn.send(buffer);
  }

  async function streamFile(conn, file, onChunk) {
    const PIPE = 4;
    let nextStart = 0;
    const takeRead = () => {
      if (nextStart >= file.size) return null;
      const start = nextStart;
      nextStart = Math.min(start + CHUNK, file.size);
      return file.slice(start, nextStart).arrayBuffer().catch((err) => err);
    };
    const pending = [];
    while (pending.length < PIPE) {
      const p = takeRead();
      if (!p) break;
      pending.push(p);
    }

    let offset = 0;
    try {
      while (pending.length) {
        if (!conn.open) throw new Error('切断されました');
        const buf = await pending.shift();
        if (buf instanceof Error) throw buf;
        await sendBuffer(conn, buf);
        offset += buf.byteLength;
        const np = takeRead();
        if (np) pending.push(np);
        if (onChunk) onChunk(offset, buf.byteLength, buf);
      }
    } finally {
      pending.forEach((p) => p && p.catch(() => {}));
    }
  }

  async function sendFile(conn, file) {
    const metaId = uid();
    const entry = addTransfer('send', file.name, file.size);
    setEntryStatus(entry, '承認待ち…');
    beginTransfer();

    try {
      conn.send({
        t: 'meta', id: metaId, name: file.name, size: file.size,
        mime: file.type || 'application/octet-stream',
      });
      const accepted = await waitForAccept(conn, metaId);
      if (!conn.open) return failEntry(entry, '切断されました');
      if (!accepted) return failEntry(entry, '拒否されました');

      setEntryStatus(entry, '送信中…');
      const startedAt = Date.now();
      let crc = 0;
      await streamFile(conn, file, (offset, chunkLen, buf) => {
        crc = C.crc32(new Uint8Array(buf), crc);
        updateEntryProgress(entry, offset);
        rateStatus(entry, '送信中…', offset, startedAt);
      });
      conn.send({ t: 'end', id: metaId, size: file.size, crc: crc >>> 0 });
      updateEntryProgress(entry, file.size);
      setEntryStatus(entry, '完了');
      markEntry(entry, 'done');
    } catch (err) {
      console.error(err);
      failEntry(entry, err.message || '送信エラー');
    } finally {
      endTransfer();
    }
  }

  async function sendFolder(conn, name, entries) {
    const totalSize = entries.reduce((sum, entry) => sum + entry.file.size, 0);
    const folderId = uid();
    const entry = addTransfer('send', '📁 ' + name, totalSize);
    setEntryStatus(entry, '承認待ち…（' + entries.length + ' 個のファイル）');
    beginTransfer();

    try {
      conn.send({ t: 'folder-start', id: folderId, name, count: entries.length, size: totalSize });
      const accepted = await waitForAccept(conn, folderId);
      if (!conn.open) return failEntry(entry, '切断されました');
      if (!accepted) return failEntry(entry, '拒否されました');

      const startedAt = Date.now();
      let sent = 0;
      let done = 0;
      for (const { file, path } of entries) {
        if (!conn.open) throw new Error('切断されました');
        const metaId = uid();
        const safePath = C.safeZipPath(path, file.name);
        conn.send({
          t: 'meta', id: metaId, folderId, path: safePath, name: file.name,
          size: file.size, mime: file.type || 'application/octet-stream',
        });
        let crc = 0;
        await streamFile(conn, file, (offset, chunkLen, buf) => {
          crc = C.crc32(new Uint8Array(buf), crc);
          sent += chunkLen;
          updateEntryProgress(entry, sent);
          rateStatus(entry, '送信中…（' + (done + 1) + '/' + entries.length + '）', sent, startedAt);
        });
        conn.send({ t: 'end', id: metaId, size: file.size, crc: crc >>> 0 });
        done++;
        setEntryStatus(entry, '送信中…（' + done + '/' + entries.length + '）');
      }
      conn.send({ t: 'folder-end', id: folderId, count: entries.length, size: totalSize });
      updateEntryProgress(entry, totalSize);
      setEntryStatus(entry, '完了（' + done + ' 個のファイル）');
      markEntry(entry, 'done');
    } catch (err) {
      console.error(err);
      failEntry(entry, err.message || '送信エラー');
    } finally {
      endTransfer();
    }
  }

  async function sendAsZip(conn, entries, zipName, opts) {
    const plan = C.planZip(entries.map(({ file, path }) => ({
      name: file.name,
      path,
      size: file.size,
      mtime: file.lastModified || Date.now(),
    })));
    const entry = addTransfer('send', '📦 ' + zipName, plan.totalSize);
    setEntryStatus(entry, opts && opts.partCount > 1
      ? '承認待ち…（パート ' + (opts.partIndex + 1) + '/' + opts.partCount + '）'
      : '承認待ち…（' + entries.length + ' 個のファイルをZIPで送信）');
    const metaId = uid();
    beginTransfer();

    try {
      conn.send({
        t: 'meta', id: metaId, name: zipName, size: plan.totalSize, mime: 'application/zip',
        splitId: opts && opts.splitId, partIndex: opts && opts.partIndex, partCount: opts && opts.partCount,
      });
      const accepted = await waitForAccept(conn, metaId);
      if (!conn.open) { failEntry(entry, '切断されました'); return 'error'; }
      if (!accepted) { failEntry(entry, '拒否されました'); return 'rejected'; }

      const records = [];
      const startedAt = Date.now();
      let wireSent = 0;
      let archiveCrc = 0;

      const sendZipPart = async (buf, status) => {
        await sendBuffer(conn, buf);
        archiveCrc = C.crc32(new Uint8Array(buf), archiveCrc);
        wireSent += buf.byteLength;
        updateEntryProgress(entry, wireSent);
        rateStatus(entry, status, wireSent, startedAt);
      };

      for (let i = 0; i < entries.length; i++) {
        const source = entries[i].file;
        const p = plan.entries[i];
        const status = '送信中…（' + (i + 1) + '/' + entries.length + '）';
        await sendZipPart(p.header, status);

        let itemCrc = 0;
        await streamFile(conn, source, (offset, chunkLen, buf) => {
          itemCrc = C.crc32(new Uint8Array(buf), itemCrc);
          archiveCrc = C.crc32(new Uint8Array(buf), archiveCrc);
          wireSent += chunkLen;
          updateEntryProgress(entry, wireSent);
          rateStatus(entry, status, wireSent, startedAt);
        });

        const descriptor = C.buildDataDescriptor(itemCrc, source.size);
        await sendZipPart(descriptor, status);
        records.push({
          nameBytes: p.nameBytes,
          crc: itemCrc >>> 0,
          size: p.size,
          offset: p.offset,
          time: p.time,
          date: p.date,
          flags: p.flags,
        });
      }

      setEntryStatus(entry, 'ZIP目次を書き込み中…');
      const tail = C.buildArchiveTail(records, plan.dataEndOffset);
      for (const part of tail) await sendZipPart(part, 'ZIP目次を書き込み中…');

      if (wireSent !== plan.totalSize) throw new Error('ZIPサイズ計画と実送信サイズが一致しません');
      conn.send({ t: 'end', id: metaId, size: plan.totalSize, crc: archiveCrc >>> 0 });
      updateEntryProgress(entry, plan.totalSize);
      setEntryStatus(entry, '完了（' + entries.length + ' 個のファイルをZIPで送信）');
      markEntry(entry, 'done');
      return 'done';
    } catch (err) {
      console.error(err);
      failEntry(entry, err.message || '送信エラー');
      return 'error';
    } finally {
      endTransfer();
    }
  }

  // ---------- receiving ----------

  function protocolFail(conn, message, entry) {
    if (entry) failEntry(entry, 'プロトコルエラー: ' + message);
    toast('受信を中止しました: ' + message);
    try { conn.close(); } catch (_) {}
  }

  function handleData(conn, data) {
    const now = Date.now();
    if (conn._incoming) conn._incoming.lastChunkAt = now;
    if (conn._folder) conn._folder.lastChunkAt = now;

    if (data instanceof ArrayBuffer) {
      pushChunk(conn, data);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then((buf) => pushChunk(conn, buf)).catch(() => protocolFail(conn, 'Blobを読み取れません'));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      pushChunk(conn, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      return;
    }
    if (!data || typeof data !== 'object') return;

    try {
      switch (data.t) {
        case 'hello':
          if (data.app === 'lemon' && Number.isInteger(data.v)) conn._remoteVersion = data.v;
          break;
        case 'folder-start':
          if (conn._incoming || conn._folder) throw new Error('別の受信処理が進行中です');
          requestFolder(conn, C.validateGroupMeta(data));
          break;
        case 'bundle-start':
          if (data.id) conn.send({ t: 'reject', id: data.id });
          toast('旧「受信側でZIP梱包」方式はv2では使用しません。両端末を最新版にしてください');
          break;
        case 'meta': {
          if (conn._incoming) throw new Error('ファイル受信中に別のmetaを受信しました');
          const meta = C.validateTransferMeta(data);
          if (meta.bundleId) throw new Error('旧バンドル転送はサポートされません');
          if (meta.folderId) startFolderFile(conn, meta);
          else {
            if (conn._folder) throw new Error('フォルダ受信中に単独ファイルを受信しました');
            requestIncoming(conn, meta);
          }
          break;
        }
        case 'accept':
        case 'reject': {
          const pending = conn._pendingAccept.get(data.id);
          if (pending) pending.res(data.t === 'accept');
          break;
        }
        case 'end':
          endCurrentFile(conn, data);
          break;
        case 'folder-end':
          endFolder(conn, data);
          break;
        case 'part-ack':
          if (typeof data.splitId === 'string' && Number.isInteger(data.partIndex) && data.partIndex >= 0) {
            conn._partAck = { splitId: data.splitId, partIndex: data.partIndex };
          }
          break;
        case 'ping':
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(err);
      protocolFail(conn, err.message || '不正なメッセージです');
    }
  }

  function pushChunk(conn, buf) {
    const inc = conn._incoming;
    if (!inc || !buf) {
      protocolFail(conn, '受信準備のないバイナリデータを受信しました');
      return;
    }

    const next = inc.received + buf.byteLength;
    if (!Number.isSafeInteger(next) || next > inc.meta.size) {
      protocolFail(conn, '申告サイズを超えるデータを受信しました', inc.entry);
      return;
    }

    inc.lastChunkAt = Date.now();
    inc.received = next;
    inc.crc = C.crc32(new Uint8Array(buf), inc.crc);
    inc.chunks.push(buf);

    if (inc.isFolderFile && conn._folder) {
      const folder = conn._folder;
      folder.received += buf.byteLength;
      folder.lastChunkAt = Date.now();
      if (folder.received > folder.size) {
        protocolFail(conn, 'フォルダの申告合計サイズを超えました', folder.entry);
        return;
      }
      updateEntryProgress(folder.entry, folder.received);
      rateStatus(folder.entry, '受信中…', folder.received, folder.startedAt);
    } else {
      updateEntryProgress(inc.entry, inc.received);
      rateStatus(inc.entry, '受信中…', inc.received, inc.startedAt);
    }
  }

  function startStallWatch(conn) {
    if (conn._stallTimer) clearInterval(conn._stallTimer);
    conn._stallTimer = setInterval(() => {
      const inc = conn._incoming;
      const folder = conn._folder;
      if (!inc && !folder) {
        clearInterval(conn._stallTimer);
        conn._stallTimer = null;
        return;
      }
      const last = inc ? inc.lastChunkAt : folder.lastChunkAt;
      if (last && Date.now() - last > RECV_STALL_MS) {
        const entry = inc ? inc.entry : folder.entry;
        setEntryStatus(entry, 'データが届いていません（通信が遮断された可能性）');
      }
    }, 5000);
  }

  function requestIncoming(conn, meta) {
    const entry = addTransfer('recv', meta.name, meta.size);
    setEntryStatus(entry, '受信リクエスト');

    const approve = () => {
      if (!conn.open) {
        toast('切断されています');
        return;
      }
      if (meta.splitId) conn._autoSplit = meta.splitId;
      conn._incoming = {
        meta,
        chunks: [],
        received: 0,
        crc: 0,
        entry,
        lastChunkAt: Date.now(),
        startedAt: Date.now(),
      };
      conn.send({ t: 'accept', id: meta.id });
      setEntryStatus(entry, '受信中…');
      startStallWatch(conn);
      beginTransfer();
    };

    if (meta.splitId && conn._autoSplit === meta.splitId) {
      setEntryStatus(entry, '自動受信中…（パート ' + ((meta.partIndex || 0) + 1) + '/' + (meta.partCount || '?') + '）');
      approve();
      return;
    }

    const actions = makeActions(entry, '受け取る', approve);
    actions.onReject = () => {
      conn.send({ t: 'reject', id: meta.id });
      setEntryStatus(entry, '拒否しました');
      markEntry(entry, 'failed');
    };
  }

  function requestFolder(conn, meta) {
    const entry = addTransfer('recv', '📁 ' + meta.name, meta.size);
    setEntryStatus(entry, '受信リクエスト（' + meta.count + ' 個のファイル）');

    const actions = makeActions(entry, '受け取る', () => {
      if (!conn.open) {
        toast('切断されています');
        return;
      }
      const filesBox = document.createElement('div');
      filesBox.className = 't-files';
      entry.el.appendChild(filesBox);
      conn._folder = {
        id: meta.id,
        name: meta.name,
        count: meta.count,
        size: meta.size,
        received: 0,
        filesDone: 0,
        entry,
        filesBox,
        lastChunkAt: Date.now(),
        startedAt: Date.now(),
      };
      conn.send({ t: 'accept', id: meta.id });
      setEntryStatus(entry, '受信中…（0/' + meta.count + '）');
      startStallWatch(conn);
      beginTransfer();
    });

    actions.onReject = () => {
      conn.send({ t: 'reject', id: meta.id });
      setEntryStatus(entry, '拒否しました');
      markEntry(entry, 'failed');
    };
  }

  function startFolderFile(conn, meta) {
    const folder = conn._folder;
    if (!folder || folder.id !== meta.folderId) throw new Error('フォルダIDが一致しません');
    conn._incoming = {
      meta,
      chunks: [],
      received: 0,
      crc: 0,
      isFolderFile: true,
      entry: folder.entry,
      lastChunkAt: Date.now(),
      startedAt: folder.startedAt,
    };
  }

  function endCurrentFile(conn, data) {
    const inc = conn._incoming;
    if (!inc || inc.meta.id !== data.id) throw new Error('終了対象のファイルIDが一致しません');

    const verified = C.verifyEnd(inc.meta, inc.received, inc.crc, data);
    if (!verified.ok) {
      protocolFail(conn, verified.reason, inc.entry);
      return;
    }
    conn._incoming = null;

    const blob = new Blob(inc.chunks, { type: inc.meta.mime });
    inc.chunks.length = 0;
    const url = URL.createObjectURL(blob);

    if (inc.isFolderFile) {
      const folder = conn._folder;
      if (!folder) throw new Error('フォルダ受信状態がありません');
      folder.filesDone++;
      folder.lastChunkAt = Date.now();
      setEntryStatus(folder.entry, '受信中…（' + folder.filesDone + '/' + folder.count + '）');
      const label = inc.meta.path || inc.meta.name;
      addSaveLink(folder.filesBox, url, label, label, false);
    } else {
      updateEntryProgress(inc.entry, inc.meta.size);
      setEntryStatus(inc.entry, '完了・整合性確認済み');
      markEntry(inc.entry, 'done');
      addSaveLink(inc.entry.foot, url, inc.meta.name, inc.meta.name, true, () => {
        if (inc.meta.splitId != null && conn.open) {
          try { conn.send({ t: 'part-ack', splitId: inc.meta.splitId, partIndex: inc.meta.partIndex }); } catch (_) {}
        }
      });
      endTransfer();
    }
  }

  function endFolder(conn, data) {
    const folder = conn._folder;
    if (!folder || folder.id !== data.id) throw new Error('終了対象のフォルダIDが一致しません');
    if (folder.filesDone !== folder.count) {
      protocolFail(conn, '受信ファイル数が一致しません', folder.entry);
      return;
    }
    if (folder.received !== folder.size) {
      protocolFail(conn, 'フォルダの受信サイズが一致しません', folder.entry);
      return;
    }
    if (data.count != null && data.count !== folder.count) {
      protocolFail(conn, '終了メッセージのファイル数が一致しません', folder.entry);
      return;
    }
    if (data.size != null && data.size !== folder.size) {
      protocolFail(conn, '終了メッセージの合計サイズが一致しません', folder.entry);
      return;
    }
    conn._folder = null;
    updateEntryProgress(folder.entry, folder.size);
    setEntryStatus(folder.entry, '完了（' + folder.filesDone + ' 個・整合性確認済み）');
    markEntry(folder.entry, 'done');
    endTransfer();
  }

  function addSaveLink(container, url, label, downloadName, big, onSaved) {
    const a = document.createElement('a');
    a.className = 'save-btn' + (big ? '' : ' small');
    a.href = url;
    a.download = safeDownloadName(downloadName);
    a.textContent = big ? 'ファイルを保存' : label;
    a.title = label;
    a.addEventListener('click', () => {
      if (onSaved) {
        try { onSaved(); } catch (_) {}
      }
      setTimeout(() => URL.revokeObjectURL(url), 120 * 1000);
    });
    if (big && container.classList.contains('t-foot')) {
      container.insertBefore(a, container.querySelector('.t-pct'));
    } else {
      container.appendChild(a);
    }
  }

  // ---------- transfer UI ----------

  function addTransfer(dir, name, size) {
    const empty = transferListEl.querySelector('.empty');
    if (empty) empty.remove();

    const li = document.createElement('li');
    li.className = 'transfer';
    const head = document.createElement('div');
    head.className = 't-head';
    const dirEl = document.createElement('span');
    dirEl.className = 'dir ' + dir;
    dirEl.textContent = dir === 'send' ? '送信' : '受信';
    const nameEl = document.createElement('span');
    nameEl.className = 't-name';
    nameEl.textContent = name;
    const sizeEl = document.createElement('span');
    sizeEl.className = 't-size';
    sizeEl.textContent = fmtBytes(size);
    head.append(dirEl, nameEl, sizeEl);

    const bar = document.createElement('div');
    bar.className = 't-bar';
    const fill = document.createElement('div');
    fill.className = 't-fill';
    bar.appendChild(fill);

    const foot = document.createElement('div');
    foot.className = 't-foot';
    const status = document.createElement('span');
    status.className = 't-status';
    const pct = document.createElement('span');
    pct.className = 't-pct';
    pct.textContent = '0%';
    foot.append(status, pct);
    li.append(head, bar, foot);
    transferListEl.prepend(li);
    return { el: li, fill, statusEl: status, pctEl: pct, foot, size, lastPct: -1, lastRateAt: 0 };
  }

  function updateEntryProgress(entry, bytes) {
    const pct = entry.size > 0 ? Math.min(100, Math.floor((bytes / entry.size) * 100)) : 100;
    if (pct === entry.lastPct) return;
    entry.lastPct = pct;
    entry.fill.style.width = pct + '%';
    entry.pctEl.textContent = pct + '%';
  }

  function setEntryStatus(entry, text) {
    entry.statusEl.textContent = text;
  }

  function markEntry(entry, cls) {
    entry.el.classList.add(cls);
  }

  function failEntry(entry, msg) {
    setEntryStatus(entry, msg);
    markEntry(entry, 'failed');
  }

  function rateStatus(entry, base, sent, startedAt) {
    const now = Date.now();
    if (entry.lastRateAt && now - entry.lastRateAt < 500) return;
    entry.lastRateAt = now;
    const secs = Math.max(0.2, (now - startedAt) / 1000);
    setEntryStatus(entry, base + '（' + fmtBytes(sent / secs) + '/s）');
  }

  function makeActions(entry, okText, onOk) {
    const actions = document.createElement('div');
    actions.className = 't-actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'ok';
    okBtn.textContent = okText;
    const noBtn = document.createElement('button');
    noBtn.className = 'danger';
    noBtn.textContent = '拒否';
    actions.append(okBtn, noBtn);
    entry.foot.insertBefore(actions, entry.pctEl);
    okBtn.onclick = () => {
      actions.remove();
      onOk();
    };
    return {
      set onReject(fn) {
        noBtn.onclick = () => {
          actions.remove();
          fn();
        };
      },
    };
  }

  // ---------- events ----------

  copyBtn.onclick = async () => {
    const id = myIdEl.textContent;
    if (!id || id === '----------') return;
    try {
      await navigator.clipboard.writeText(id);
      toast('コピーしました');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = id;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('コピーしました');
    }
  };

  connectBtn.onclick = () => connectTo(peerInput.value);
  peerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectTo(peerInput.value);
  });

  dropzone.addEventListener('click', () => fileInput.click());
  $('#file-btn').onclick = () => fileInput.click();
  $('#folder-btn').onclick = () => folderInput.click();

  fileInput.addEventListener('change', () => {
    const entries = Array.from(fileInput.files).map((file) => ({ file, path: file.name }));
    fileInput.value = '';
    sendSelected(entries).catch((err) => {
      console.error(err);
      toast(err.message || '送信できませんでした');
    });
  });

  folderInput.addEventListener('change', () => {
    const entries = Array.from(folderInput.files).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
    folderInput.value = '';
    sendSelected(entries).catch((err) => {
      console.error(err);
      toast(err.message || '送信できませんでした');
    });
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('over');
    });
  });
  dropzone.addEventListener('drop', async (e) => {
    try {
      const entries = await entriesFromDataTransfer(e.dataTransfer);
      await sendSelected(entries);
    } catch (err) {
      console.error(err);
      toast(err.message || '送信できませんでした');
    }
  });

  try { zipOpt.checked = localStorage.getItem('p2p-zip-bundle') !== '0'; } catch (_) {}
  zipOpt.addEventListener('change', () => {
    try { localStorage.setItem('p2p-zip-bundle', zipOpt.checked ? '1' : '0'); } catch (_) {}
  });

  window.addEventListener('beforeunload', () => {
    if (peer) peer.destroy();
  });

  // ---------- init / debug ----------

  const params = new URLSearchParams(location.search);
  const preset = params.get('peer');
  let presetUsed = false;
  if (preset) peerInput.value = preset;

  if (params.get('debug') === '1') {
    window.__p2p = {
      sendEntries: (entries) => sendSelected(entries),
      state: () => ({
        protocol: PROTOCOL_VERSION,
        connections: [...connections.values()].map((conn) => ({
          peer: conn.peer,
          open: conn.open,
          remoteVersion: conn._remoteVersion,
          receiving: !!conn._incoming,
          folder: !!conn._folder,
          pendingAccepts: conn._pendingAccept.size,
        })),
        selected: selectedConn && selectedConn.peer,
        activeTransfers,
      }),
      stats: async () => {
        const conn = selectedConn;
        const pc = conn && (conn.peerConnection || conn._pc);
        if (!pc || typeof pc.getStats !== 'function') return null;
        const report = await pc.getStats();
        const out = [];
        report.forEach((value) => {
          if (value.type === 'candidate-pair' || value.type === 'local-candidate' || value.type === 'remote-candidate' || value.type === 'transport') out.push(value);
        });
        return out;
      },
    };
  }

  if (typeof Peer === 'undefined') {
    setStatus('PeerJS を読み込めません（要ネット接続）', 'err');
  } else {
    initPeer(randomId());
  }
})();
