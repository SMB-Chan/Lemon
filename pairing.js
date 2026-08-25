(function () {
  'use strict';

  const Pair = window.LemonPairingCore;
  const OriginalPeer = window.Peer;
  if (!Pair || !OriginalPeer) throw new Error('Pairing dependencies could not be loaded');

  const AUTH_MARK = '__lemonPair';
  const AUTH_VERSION = 1;
  const AUTH_TIMEOUT_MS = 10000;

  function emitTo(listeners, event, value) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(value); } catch (err) { setTimeout(() => { throw err; }, 0); }
    }
  }

  function wrapConnection(raw, context) {
    const listeners = new Map();
    let authenticated = false;
    let failed = false;
    let authTimer = null;
    let state = context.outgoing ? 'await-open' : 'await-hello';
    let nonceA = null;
    let nonceB = null;
    let dataTail = Promise.resolve();
    let proxy = null;

    function on(event, listener) {
      if (typeof listener !== 'function') return proxy;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      if (event === 'open' && authenticated && raw.open) queueMicrotask(() => listener());
      return proxy;
    }

    function startTimer() {
      clearTimeout(authTimer);
      authTimer = setTimeout(() => fail('ペアリング認証がタイムアウトしました'), AUTH_TIMEOUT_MS);
    }

    function finishAuth() {
      if (failed || authenticated) return;
      authenticated = true;
      state = 'authenticated';
      clearTimeout(authTimer);
      emitTo(listeners, 'open');
    }

    function fail(message) {
      if (failed) return;
      failed = true;
      clearTimeout(authTimer);
      const err = new Error(message);
      err.name = 'LemonPairingError';
      emitTo(listeners, 'error', err);
      try { raw.close(); } catch (_) {}
    }

    function sendPair(payload) {
      raw.send(Object.assign({ [AUTH_MARK]: AUTH_VERSION }, payload));
    }

    function isPairMessage(data) {
      return !!data && typeof data === 'object' && data[AUTH_MARK] === AUTH_VERSION && typeof data.t === 'string';
    }

    async function handleUnauthenticated(data) {
      if (!isPairMessage(data)) {
        fail('認証前のデータを受信したため接続を拒否しました');
        return;
      }

      if (context.outgoing) {
        if (state === 'await-challenge' && data.t === 'challenge') {
          if (data.nonceA !== nonceA || typeof data.nonceB !== 'string' || typeof data.proof !== 'string') {
            fail('ペアリング応答が不正です');
            return;
          }
          nonceB = data.nonceB;
          const expected = await Pair.makeProof(
            context.remoteSecret,
            context.localPeerId,
            raw.peer,
            nonceA,
            nonceB,
            'responder'
          );
          if (!Pair.secureEqual(expected, data.proof)) {
            fail('相手のペアリング証明が一致しません');
            return;
          }
          const proof = await Pair.makeProof(
            context.remoteSecret,
            context.localPeerId,
            raw.peer,
            nonceA,
            nonceB,
            'initiator'
          );
          state = 'await-ok';
          sendPair({ t: 'response', nonceA, nonceB, proof });
          return;
        }

        if (state === 'await-ok' && data.t === 'ok') {
          if (data.nonceA !== nonceA || data.nonceB !== nonceB) {
            fail('ペアリング完了応答が一致しません');
            return;
          }
          finishAuth();
          return;
        }

        fail('予期しないペアリングメッセージを受信しました');
        return;
      }

      if (state === 'await-hello' && data.t === 'hello') {
        if (typeof data.nonceA !== 'string') {
          fail('ペアリング開始メッセージが不正です');
          return;
        }
        nonceA = data.nonceA;
        nonceB = Pair.createNonce();
        const proof = await Pair.makeProof(
          context.localSecret,
          raw.peer,
          context.localPeerId,
          nonceA,
          nonceB,
          'responder'
        );
        state = 'await-response';
        sendPair({ t: 'challenge', nonceA, nonceB, proof });
        return;
      }

      if (state === 'await-response' && data.t === 'response') {
        if (data.nonceA !== nonceA || data.nonceB !== nonceB || typeof data.proof !== 'string') {
          fail('ペアリング証明メッセージが不正です');
          return;
        }
        const expected = await Pair.makeProof(
          context.localSecret,
          raw.peer,
          context.localPeerId,
          nonceA,
          nonceB,
          'initiator'
        );
        if (!Pair.secureEqual(expected, data.proof)) {
          fail('接続元のペアリング証明が一致しません');
          return;
        }
        sendPair({ t: 'ok', nonceA, nonceB });
        finishAuth();
        return;
      }

      fail('予期しないペアリングメッセージを受信しました');
    }

    raw.on('open', () => {
      startTimer();
      if (!context.outgoing) return;
      if (!context.remoteSecret) {
        fail('秘密付きペアリングコードが必要です');
        return;
      }
      nonceA = Pair.createNonce();
      state = 'await-challenge';
      try { sendPair({ t: 'hello', nonceA }); } catch (err) { fail(err.message || 'ペアリング開始に失敗しました'); }
    });

    raw.on('data', (data) => {
      dataTail = dataTail.then(async () => {
        if (failed) return;
        if (authenticated) {
          if (!isPairMessage(data)) emitTo(listeners, 'data', data);
          return;
        }
        await handleUnauthenticated(data);
      }).catch((err) => fail(err.message || 'ペアリング認証に失敗しました'));
    });

    raw.on('close', () => {
      clearTimeout(authTimer);
      emitTo(listeners, 'close');
    });

    raw.on('error', (err) => {
      emitTo(listeners, 'error', err);
    });

    proxy = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'open') return authenticated && !!target.open;
        if (prop === 'on') return on;
        if (prop === 'send') {
          return (data) => {
            if (!authenticated || !target.open) throw new Error('ペアリング認証前にはデータを送信できません');
            return target.send(data);
          };
        }
        if (prop === 'close') return () => target.close();
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value, target);
      },
    });

    return proxy;
  }

  function cleanPairingUrl(token) {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return token;
    const qs = new URLSearchParams(location.search);
    qs.delete('peer');
    const query = qs.toString();
    return location.origin + location.pathname + (query ? '?' + query : '') + '#peer=' + encodeURIComponent(token);
  }

  function drawPairingQr(token) {
    const canvas = document.querySelector('#my-qr');
    const hint = document.querySelector('#qr-hint');
    if (!canvas || typeof qrcode !== 'function') return;
    const qr = qrcode(0, 'M');
    qr.addData(cleanPairingUrl(token));
    qr.make();
    const modules = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(2, Math.floor(240 / (modules + quiet * 2)));
    const size = (modules + quiet * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) ctx.fillRect((quiet + col) * scale, (quiet + row) * scale, scale, scale);
      }
    }
    canvas.hidden = false;
    if (hint) {
      hint.textContent = location.protocol === 'http:' || location.protocol === 'https:'
        ? '秘密付きQRです。URLフラグメントを使うためpairing secretはWebサーバーへ送信されません'
        : '秘密付きペアリングコードをQR化しています。相手側でコードとして入力してください';
    }
  }

  function renderShareCode(peerId, secret) {
    const token = Pair.formatShareCode(peerId, secret);
    const idEl = document.querySelector('#my-id');
    const input = document.querySelector('#peer-input');
    if (idEl) idEl.textContent = token;
    if (input) input.placeholder = '相手の秘密付きペアリングコードを入力';
    drawPairingQr(token);
  }

  function LemonPeer() {
    const args = Array.from(arguments);
    const rawPeer = Reflect.construct(OriginalPeer, args);
    const localSecret = Pair.createSecret();
    const remoteSecrets = new Map();
    const connectionListeners = new Set();
    let proxy = null;

    rawPeer.on('connection', (rawConn) => {
      const conn = wrapConnection(rawConn, {
        outgoing: false,
        localPeerId: rawPeer.id,
        localSecret,
        remoteSecret: null,
      });
      for (const listener of [...connectionListeners]) listener(conn);
    });

    rawPeer.on('open', (peerId) => {
      queueMicrotask(() => {
        try { renderShareCode(peerId, localSecret); } catch (err) { console.error(err); }
      });
    });

    proxy = new Proxy(rawPeer, {
      get(target, prop) {
        if (prop === 'on') {
          return (event, listener) => {
            if (event === 'connection') {
              connectionListeners.add(listener);
              return proxy;
            }
            target.on(event, listener);
            return proxy;
          };
        }
        if (prop === 'connect') {
          return (rawTarget, options) => {
            const parsed = Pair.parseShareCode(rawTarget);
            const peerId = parsed.peerId;
            if (parsed.secret) remoteSecrets.set(peerId, parsed.secret);
            const remoteSecret = parsed.secret || remoteSecrets.get(peerId) || null;
            const rawConn = target.connect(peerId, options);
            return wrapConnection(rawConn, {
              outgoing: true,
              localPeerId: target.id,
              localSecret,
              remoteSecret,
            });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value, target);
      },
    });

    return proxy;
  }

  Object.setPrototypeOf(LemonPeer, OriginalPeer);
  LemonPeer.prototype = OriginalPeer.prototype;
  window.Peer = LemonPeer;

  document.addEventListener('DOMContentLoaded', () => {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = hash.get('peer');
    if (!token) return;
    const input = document.querySelector('#peer-input');
    const button = document.querySelector('#connect-btn');
    if (!input || !button) return;
    input.value = token;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {}
    button.click();
  }, { once: true });
})();
