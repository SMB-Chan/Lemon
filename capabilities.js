(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LemonCapabilities = api;
    if (root.document && root.Peer) api.install();
  }
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  const CAP_VERSION = 1;
  const FEATURE_FLOW = 'flow-control-v1';
  const FEATURE_DIRECT = 'direct-save-v1';
  const FLOW_HIGH = 16 * 1024 * 1024;
  const FLOW_LOW = 4 * 1024 * 1024;
  const FLOW_BLOCK_AMOUNT = 16 * 1024 * 1024;
  const decoratedConnections = new WeakMap();
  const dcViews = new WeakMap();
  let installed = false;
  let directTransfers = 0;
  let directWakeLock = null;

  function normalizeFeatures(input) {
    if (!Array.isArray(input) || input.length > 32) return [];
    const out = [];
    const seen = new Set();
    for (const item of input) {
      if (typeof item !== 'string' || item.length < 1 || item.length > 64) continue;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(item) || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out.sort();
  }

  function supportsDirectSave(env) {
    const target = env || root;
    if (!target || typeof target.showSaveFilePicker !== 'function') return false;
    if ('isSecureContext' in target && target.isSecureContext === false) return false;
    return true;
  }

  function localFeatures(env) {
    const out = [FEATURE_FLOW];
    if (supportsDirectSave(env)) out.push(FEATURE_DIRECT);
    return out;
  }

  function isCapabilityMessage(data) {
    return !!data && typeof data === 'object' && data.t === 'lemon-capabilities';
  }

  function isFlowMessage(data) {
    return !!data && typeof data === 'object' && data.t === 'lemon-flow';
  }

  function isBinary(data) {
    return data instanceof ArrayBuffer || ArrayBuffer.isView(data) ||
      (typeof Blob !== 'undefined' && data instanceof Blob);
  }

  function safeDownloadName(path) {
    return String(path || 'file').replace(/[\/\\\0]/g, '_').slice(0, 240) || 'file';
  }

  function createDirectSink(writable, options) {
    if (!writable || typeof writable.write !== 'function') throw new Error('書き込み先が不正です');
    const opts = options || {};
    const high = Number.isSafeInteger(opts.highWaterMark) && opts.highWaterMark > 0 ? opts.highWaterMark : FLOW_HIGH;
    const low = Number.isSafeInteger(opts.lowWaterMark) && opts.lowWaterMark >= 0 && opts.lowWaterMark < high
      ? opts.lowWaterMark : Math.min(FLOW_LOW, high - 1);
    let queuedBytes = 0;
    let paused = false;
    let closed = false;
    let failure = null;
    let tail = Promise.resolve();

    function maybePause() {
      if (!paused && queuedBytes >= high) {
        paused = true;
        if (typeof opts.onPause === 'function') opts.onPause(queuedBytes);
      }
    }

    function maybeResume() {
      if (paused && queuedBytes <= low) {
        paused = false;
        if (typeof opts.onResume === 'function') opts.onResume(queuedBytes);
      }
    }

    function write(buffer) {
      if (closed) throw new Error('書き込み先は既に閉じています');
      if (failure) throw failure;
      const bytes = buffer instanceof ArrayBuffer ? buffer.byteLength
        : ArrayBuffer.isView(buffer) ? buffer.byteLength : 0;
      if (!bytes) return tail;
      queuedBytes += bytes;
      maybePause();
      tail = tail.then(async () => {
        if (failure || closed) return;
        try {
          await writable.write(buffer);
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
          if (typeof opts.onError === 'function') opts.onError(failure);
        } finally {
          queuedBytes = Math.max(0, queuedBytes - bytes);
          maybeResume();
        }
      });
      return tail;
    }

    async function drain() {
      await tail;
      if (failure) throw failure;
    }

    async function commit() {
      if (closed) return;
      await drain();
      closed = true;
      if (paused) {
        paused = false;
        if (typeof opts.onResume === 'function') opts.onResume(0);
      }
      if (typeof writable.close === 'function') await writable.close();
    }

    async function abort() {
      if (closed) return;
      closed = true;
      if (paused) {
        paused = false;
        if (typeof opts.onResume === 'function') opts.onResume(0);
      }
      try {
        if (typeof writable.abort === 'function') await writable.abort();
      } catch (_) {}
    }

    return {
      write,
      drain,
      commit,
      abort,
      get queuedBytes() { return queuedBytes; },
      get paused() { return paused; },
      get failed() { return failure; },
    };
  }

  function emit(name, detail) {
    if (!root || typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent(name, { detail }));
  }

  async function acquireDirectWakeLock() {
    directTransfers++;
    if (directWakeLock || !root || !root.navigator || !root.navigator.wakeLock) return;
    try {
      directWakeLock = await root.navigator.wakeLock.request('screen');
      directWakeLock.addEventListener('release', () => { directWakeLock = null; }, { once: true });
    } catch (_) {}
  }

  function releaseDirectWakeLock() {
    directTransfers = Math.max(0, directTransfers - 1);
    if (directTransfers !== 0 || !directWakeLock) return;
    directWakeLock.release().catch(() => {});
    directWakeLock = null;
  }

  function uiForEntry(entry) {
    if (!entry) return null;
    return {
      entry,
      status: entry.querySelector('.t-status'),
      fill: entry.querySelector('.t-fill'),
      pct: entry.querySelector('.t-pct'),
      actions: entry.querySelector('.t-actions'),
    };
  }

  function setUiStatus(ui, text) {
    if (ui && ui.status) ui.status.textContent = text;
  }

  function updateUiProgress(ui, received, total) {
    const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 100;
    if (ui && ui.fill) ui.fill.style.width = pct + '%';
    if (ui && ui.pct) ui.pct.textContent = pct + '%';
  }

  function markUi(ui, cls) {
    if (ui && ui.entry) ui.entry.classList.add(cls);
  }

  function dataChannelView(rawChannel, state) {
    if (!rawChannel || typeof rawChannel !== 'object') return rawChannel;
    let byState = dcViews.get(rawChannel);
    if (!byState) {
      byState = new WeakMap();
      dcViews.set(rawChannel, byState);
    }
    if (byState.has(state)) return byState.get(state);
    const proxy = new Proxy(rawChannel, {
      get(target, prop) {
        if (prop === 'bufferedAmount' && state.remotePaused) {
          return Math.max(Number(target.bufferedAmount) || 0, FLOW_BLOCK_AMOUNT);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value, target);
      },
    });
    byState.set(state, proxy);
    return proxy;
  }

  function decorateConnection(raw) {
    if (decoratedConnections.has(raw)) return decoratedConnections.get(raw).proxy;

    const rawOn = raw.on.bind(raw);
    const rawSend = raw.send.bind(raw);
    const openListeners = [];
    const dataListeners = [];
    const state = {
      remoteFeatures: new Set(),
      remotePaused: false,
      openFired: false,
      direct: null,
    };
    let proxy = null;

    function sendControl(data) {
      if (!raw.open) return false;
      try {
        rawSend(data);
        return true;
      } catch (_) {
        return false;
      }
    }

    function failDirect(reason, closeConnection) {
      const direct = state.direct;
      if (!direct) return;
      state.direct = null;
      direct.sink.abort().catch(() => {});
      setUiStatus(direct.ui, '直接保存に失敗: ' + String(reason || '不明なエラー'));
      markUi(direct.ui, 'failed');
      releaseDirectWakeLock();
      emit('lemon-direct-save-error', { peer: String(raw.peer || ''), id: direct.meta.id, reason: String(reason || '') });
      if (closeConnection) {
        try { raw.close(); } catch (_) {}
      }
    }

    function consumeDirectBuffer(buffer) {
      const direct = state.direct;
      if (!direct || direct.finishing) return;
      const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
        : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : null;
      if (!view) return failDirect('受信データ形式が不正です', true);
      const next = direct.received + view.byteLength;
      if (!Number.isSafeInteger(next) || next > direct.meta.size) {
        return failDirect('申告サイズを超えるデータを受信しました', true);
      }
      direct.received = next;
      direct.crc = root.LemonCore.crc32(view, direct.crc);
      try {
        direct.sink.write(buffer instanceof ArrayBuffer
          ? buffer
          : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      } catch (err) {
        return failDirect(err && err.message ? err.message : 'ディスクへ書き込めません', true);
      }
      updateUiProgress(direct.ui, direct.received, direct.meta.size);
      const secs = Math.max(0.2, (Date.now() - direct.startedAt) / 1000);
      setUiStatus(direct.ui, '直接保存中…（' + formatBytes(direct.received / secs) + '/s）');
    }

    async function finishDirect(data) {
      const direct = state.direct;
      if (!direct || direct.finishing) return;
      direct.finishing = true;
      try {
        await direct.receiveTail;
        await direct.sink.drain();
        if (direct.sink.failed) throw direct.sink.failed;
        const verified = root.LemonCore.verifyEnd(direct.meta, direct.received, direct.crc, data);
        if (!verified.ok) throw new Error(verified.reason);
        await direct.sink.commit();
        updateUiProgress(direct.ui, direct.meta.size, direct.meta.size);
        setUiStatus(direct.ui, '完了・直接保存済み・整合性確認済み');
        markUi(direct.ui, 'done');
        if (direct.meta.splitId != null) {
          sendControl({ t: 'part-ack', splitId: direct.meta.splitId, partIndex: direct.meta.partIndex });
        }
        emit('lemon-direct-save-complete', {
          peer: String(raw.peer || ''), id: direct.meta.id, size: direct.meta.size,
        });
        state.direct = null;
        releaseDirectWakeLock();
      } catch (err) {
        failDirect(err && err.message ? err.message : '直接保存を完了できません', true);
      }
    }

    async function startDirect(meta, ui, button) {
      if (!root.LemonCore || !supportsDirectSave(root)) return;
      if (!state.remoteFeatures.has(FEATURE_FLOW) || !state.remoteFeatures.has(FEATURE_DIRECT)) return;
      button.disabled = true;
      let writable = null;
      try {
        const handle = await root.showSaveFilePicker({ suggestedName: safeDownloadName(meta.name) });
        writable = await handle.createWritable();
        if (!raw.open) {
          try { await writable.abort(); } catch (_) {}
          throw new Error('接続が切れています');
        }
        const sink = createDirectSink(writable, {
          onPause: () => sendControl({ t: 'lemon-flow', c: CAP_VERSION, id: meta.id, paused: true }),
          onResume: () => sendControl({ t: 'lemon-flow', c: CAP_VERSION, id: meta.id, paused: false }),
          onError: (err) => failDirect(err && err.message ? err.message : 'ディスク書き込みエラー', true),
        });
        state.direct = {
          meta,
          sink,
          ui,
          received: 0,
          crc: 0,
          startedAt: Date.now(),
          receiveTail: Promise.resolve(),
          finishing: false,
        };
        if (ui.actions) ui.actions.remove();
        setUiStatus(ui, '直接保存中…');
        acquireDirectWakeLock();
        sendControl({ t: 'accept', id: meta.id });
        emit('lemon-direct-save-start', { peer: String(raw.peer || ''), id: meta.id, size: meta.size });
      } catch (err) {
        if (writable) {
          try { await writable.abort(); } catch (_) {}
        }
        button.disabled = false;
        if (err && err.name === 'AbortError') return;
        setUiStatus(ui, '保存先を選択できません: ' + (err && err.message ? err.message : String(err)));
      }
    }

    function attachDirectButton(meta, entry) {
      if (!entry || !supportsDirectSave(root)) return;
      if (!state.remoteFeatures.has(FEATURE_FLOW) || !state.remoteFeatures.has(FEATURE_DIRECT)) return;
      if (meta.folderId || meta.bundleId || typeof meta.id !== 'string') return;
      const ui = uiForEntry(entry);
      if (!ui || !ui.actions || ui.actions.querySelector('.direct-save-btn')) return;
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'sub direct-save-btn';
      button.textContent = '直接保存';
      button.title = '受信データをBlobに蓄積せず、選択したファイルへ順次書き込みます';
      button.addEventListener('click', () => startDirect(meta, ui, button));
      ui.actions.insertBefore(button, ui.actions.lastElementChild || null);
    }

    function forwardData(data) {
      let before = null;
      const eligibleMeta = !!data && typeof data === 'object' && data.t === 'meta' && !data.folderId && !data.bundleId;
      if (eligibleMeta && root && root.document) {
        before = new Set(root.document.querySelectorAll('#transfer-list .transfer'));
      }
      for (const listener of dataListeners.slice()) listener.call(proxy, data);
      if (before) {
        const entries = root.document.querySelectorAll('#transfer-list .transfer');
        for (const entry of entries) {
          if (!before.has(entry)) {
            attachDirectButton(data, entry);
            break;
          }
        }
      }
    }

    rawOn('open', () => {
      sendControl({ t: 'lemon-capabilities', c: CAP_VERSION, features: localFeatures(root) });
      state.openFired = true;
      emit('lemon-capabilities-local', { peer: String(raw.peer || ''), features: localFeatures(root) });
      for (const listener of openListeners.slice()) listener.call(proxy);
    });

    rawOn('data', (data) => {
      if (isCapabilityMessage(data)) {
        if (data.c !== CAP_VERSION) return;
        state.remoteFeatures = new Set(normalizeFeatures(data.features));
        emit('lemon-capabilities-remote', {
          peer: String(raw.peer || ''), version: data.c, features: [...state.remoteFeatures],
        });
        return;
      }
      if (isFlowMessage(data)) {
        if (data.c !== CAP_VERSION || typeof data.id !== 'string' || typeof data.paused !== 'boolean') return;
        state.remotePaused = data.paused;
        return;
      }

      const direct = state.direct;
      if (direct) {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          consumeDirectBuffer(data);
          return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          direct.receiveTail = direct.receiveTail.then(() => data.arrayBuffer()).then((buf) => consumeDirectBuffer(buf));
          return;
        }
        if (data && typeof data === 'object' && data.t === 'end' && data.id === direct.meta.id) {
          finishDirect(data);
          return;
        }
      }
      forwardData(data);
    });

    rawOn('close', () => {
      state.remotePaused = false;
      if (state.direct) failDirect('接続が切断されました', false);
    });

    proxy = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'on') {
          return function (event, listener) {
            if (event === 'open') {
              openListeners.push(listener);
              if (state.openFired && target.open) queueMicrotask(() => listener.call(proxy));
              return proxy;
            }
            if (event === 'data') {
              dataListeners.push(listener);
              return proxy;
            }
            rawOn(event, listener);
            return proxy;
          };
        }
        if (prop === 'send') return function (data, chunked) { return rawSend(data, chunked); };
        if (prop === 'dataChannel') return dataChannelView(target.dataChannel, state);
        if (prop === '__lemonRemoteFeatures') return [...state.remoteFeatures];
        if (prop === '__lemonCapabilityVersion') return CAP_VERSION;
        if (prop === '__lemonDirectSaving') return !!state.direct;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value, target);
      },
      defineProperty(target, prop, descriptor) {
        return Reflect.defineProperty(target, prop, descriptor);
      },
    });

    decoratedConnections.set(raw, { proxy, state });
    return proxy;
  }

  function decoratePeer(peer) {
    if (!peer || peer.__lemonCapabilityPeer) return peer;
    Object.defineProperty(peer, '__lemonCapabilityPeer', { value: true });
    const rawOn = peer.on.bind(peer);
    const rawConnect = peer.connect.bind(peer);
    const connectionListeners = [];

    rawOn('connection', (conn) => {
      const decorated = decorateConnection(conn);
      for (const listener of connectionListeners.slice()) listener.call(peer, decorated);
    });

    peer.on = function (event, listener) {
      if (event === 'connection') {
        connectionListeners.push(listener);
        return peer;
      }
      rawOn(event, listener);
      return peer;
    };

    peer.connect = function (target, options) {
      return decorateConnection(rawConnect(target, options));
    };
    return peer;
  }

  function install() {
    if (installed || !root || typeof root.Peer !== 'function') return false;
    installed = true;
    const OriginalPeer = root.Peer;
    if (OriginalPeer.__lemonCapabilitiesWrapped) return true;
    const WrappedPeer = new Proxy(OriginalPeer, {
      construct(Target, args, newTarget) {
        const actualNewTarget = newTarget === WrappedPeer ? Target : newTarget;
        return decoratePeer(Reflect.construct(Target, args, actualNewTarget));
      },
      apply(Target, thisArg, args) {
        return decoratePeer(Reflect.apply(Target, thisArg, args));
      },
    });
    Object.defineProperty(WrappedPeer, '__lemonCapabilitiesWrapped', { value: true });
    root.Peer = WrappedPeer;
    return true;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return Math.max(0, Math.round(n)) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
  }

  return {
    CAP_VERSION,
    FEATURE_FLOW,
    FEATURE_DIRECT,
    FLOW_HIGH,
    FLOW_LOW,
    normalizeFeatures,
    supportsDirectSave,
    localFeatures,
    createDirectSink,
    install,
  };
});