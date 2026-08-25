(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LemonAuth = api;
    if (root.document && root.Peer) api.install();
  }
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  const AUTH_VERSION = 1;
  const SECRET_BYTES = 16;
  const NONCE_BYTES = 16;
  const AUTH_TIMEOUT_MS = 12000;
  const knownSecrets = new Map();
  const decoratedConnections = new WeakMap();
  let installed = false;
  let localSecret = null;

  function encodeBase64Url(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') {
      return Buffer.from(u8).toString('base64url');
    }
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < u8.length; i += step) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeBase64Url(text) {
    const value = String(text || '');
    if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('base64url形式が不正です');
    if (typeof Buffer !== 'undefined' && typeof window === 'undefined') {
      return new Uint8Array(Buffer.from(value, 'base64url'));
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function validateSecret(secret) {
    const value = String(secret || '');
    if (!/^[A-Za-z0-9_-]{22}$/.test(value)) throw new Error('認証秘密の形式が不正です');
    const bytes = decodeBase64Url(value);
    if (bytes.byteLength !== SECRET_BYTES || encodeBase64Url(bytes) !== value) {
      throw new Error('認証秘密の長さが不正です');
    }
    return value;
  }

  function validatePeerId(peerId) {
    const value = String(peerId || '').trim();
    if (!value || value.length > 128 || /[~\s]/.test(value)) throw new Error('Peer IDの形式が不正です');
    return value;
  }

  function makeInvite(peerId, secret) {
    return validatePeerId(peerId) + '~' + validateSecret(secret);
  }

  function parseInvite(input) {
    let value = String(input || '').trim();
    if (!value || value.length > 4096) return null;

    let separateSecret = null;
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        const url = new URL(value);
        const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
        const query = url.searchParams;
        const fromHash = hash.get('peer');
        const fromQuery = query.get('peer');
        value = fromHash || fromQuery || '';
        separateSecret = hash.get('key') || query.get('key');
      }
    } catch (_) {
      return null;
    }

    if (!value) return null;
    const split = value.lastIndexOf('~');
    let peerId = value;
    let secret = separateSecret;
    if (split > 0) {
      peerId = value.slice(0, split);
      secret = value.slice(split + 1);
    }

    try {
      peerId = validatePeerId(peerId);
      if (secret != null && secret !== '') secret = validateSecret(secret);
      else secret = null;
      return { peerId, secret, invite: secret ? makeInvite(peerId, secret) : peerId };
    } catch (_) {
      return null;
    }
  }

  function makePairingUrl(baseHref, invite) {
    const parsed = parseInvite(invite);
    if (!parsed || !parsed.secret) throw new Error('認証付き接続コードが必要です');
    const url = new URL(baseHref);
    url.searchParams.delete('peer');
    url.searchParams.delete('key');
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    hash.delete('peer');
    hash.delete('key');
    hash.set('peer', parsed.invite);
    url.hash = hash.toString();
    return url.href;
  }

  function extractFingerprints(sdp) {
    const found = [];
    const text = String(sdp || '');
    const re = /^a=fingerprint:([A-Za-z0-9-]+)\s+([0-9A-Fa-f:]+)\s*$/gm;
    let match;
    while ((match = re.exec(text))) {
      const algorithm = match[1].toLowerCase();
      const digest = match[2].toUpperCase();
      found.push(algorithm + ':' + digest);
    }
    return [...new Set(found)].sort();
  }

  function channelBindingFromSdps(localSdp, remoteSdp) {
    const all = [...new Set([
      ...extractFingerprints(localSdp),
      ...extractFingerprints(remoteSdp),
    ])].sort();
    if (all.length < 2) throw new Error('DTLSフィンガープリントを取得できません');
    return 'dtls-fp/v1|' + all.join('|');
  }

  function authTranscript(role, responderId, initiatorId, nonce, binding) {
    if (role !== 'responder' && role !== 'initiator') throw new Error('認証ロールが不正です');
    return [
      'lemon-auth/v1',
      role,
      validatePeerId(responderId),
      validatePeerId(initiatorId),
      String(nonce || ''),
      String(binding || ''),
    ].join('\n');
  }

  function randomBytes(length) {
    const cryptoObj = root && root.crypto ? root.crypto : (typeof crypto !== 'undefined' ? crypto : null);
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') throw new Error('安全な乱数生成器を利用できません');
    return cryptoObj.getRandomValues(new Uint8Array(length));
  }

  function randomSecret() {
    return encodeBase64Url(randomBytes(SECRET_BYTES));
  }

  function validSizedBase64Url(value, bytes) {
    try {
      const text = String(value || '');
      return /^[A-Za-z0-9_-]+$/.test(text) && decodeBase64Url(text).byteLength === bytes;
    } catch (_) {
      return false;
    }
  }

  function textBytes(text) {
    return new TextEncoder().encode(String(text));
  }

  function cryptoSubtle() {
    const cryptoObj = root && root.crypto ? root.crypto : (typeof crypto !== 'undefined' ? crypto : null);
    if (!cryptoObj || !cryptoObj.subtle) throw new Error('Web Crypto APIを利用できません');
    return cryptoObj.subtle;
  }

  async function hmacProof(secret, transcript) {
    const subtle = cryptoSubtle();
    const key = await subtle.importKey(
      'raw', decodeBase64Url(validateSecret(secret)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await subtle.sign('HMAC', key, textBytes(transcript));
    return encodeBase64Url(new Uint8Array(signature));
  }

  async function verifyProof(secret, transcript, proof) {
    if (!validSizedBase64Url(proof, 32)) return false;
    const expected = decodeBase64Url(await hmacProof(secret, transcript));
    const actual = decodeBase64Url(proof);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    return diff === 0;
  }

  function peerConnectionOf(conn) {
    return conn && (
      conn.peerConnection || conn._peerConnection || conn._pc ||
      (conn.negotiator && conn.negotiator.peerConnection) ||
      (conn._negotiator && conn._negotiator.peerConnection)
    );
  }

  function bindingForConnection(conn) {
    const pc = peerConnectionOf(conn);
    if (!pc || !pc.localDescription || !pc.remoteDescription) {
      throw new Error('WebRTC接続情報を取得できません');
    }
    return channelBindingFromSdps(pc.localDescription.sdp, pc.remoteDescription.sdp);
  }

  function emit(name, detail) {
    if (!root || typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent(name, { detail }));
  }

  function rememberInvite(input) {
    const parsed = parseInvite(input);
    if (!parsed || !parsed.secret) return null;
    knownSecrets.set(parsed.peerId, parsed.secret);
    return parsed;
  }

  function isAuthMessage(data) {
    return !!data && typeof data === 'object' && typeof data.t === 'string' && data.t.indexOf('lemon-auth-') === 0;
  }

  function decorateConnection(raw, direction, secret, ownerPeer, onAuthenticated) {
    if (decoratedConnections.has(raw)) return decoratedConnections.get(raw).proxy;

    const rawOn = raw.on.bind(raw);
    const rawSend = raw.send.bind(raw);
    const openListeners = [];
    const dataListeners = [];
    const state = {
      direction,
      secret,
      ownerPeer,
      authenticated: false,
      failed: false,
      started: false,
      nonce: null,
      binding: null,
      timer: null,
      processing: Promise.resolve(),
      openFired: false,
    };

    let proxy = null;

    function fail(reason) {
      if (state.failed || state.authenticated) return;
      state.failed = true;
      if (state.timer) clearTimeout(state.timer);
      emit('lemon-auth-error', { peer: String(raw.peer || ''), reason: String(reason || '認証に失敗しました') });
      try { raw.close(); } catch (_) {}
    }

    function succeed() {
      if (state.failed || state.authenticated) return;
      state.authenticated = true;
      if (state.timer) clearTimeout(state.timer);
      if (state.secret) knownSecrets.set(String(raw.peer || ''), state.secret);
      emit('lemon-auth-success', { peer: String(raw.peer || ''), version: AUTH_VERSION });
      if (typeof onAuthenticated === 'function') onAuthenticated(proxy);
      if (!state.openFired) {
        state.openFired = true;
        for (const listener of openListeners.slice()) queueMicrotask(() => listener.call(proxy));
      }
    }

    async function startAuth() {
      if (state.started || state.failed || state.authenticated) return;
      state.started = true;
      if (!state.secret) return fail('接続コードに認証秘密がありません');
      try {
        state.binding = bindingForConnection(raw);
      } catch (err) {
        return fail(err && err.message ? err.message : 'DTLSフィンガープリントを取得できません');
      }
      state.timer = setTimeout(() => fail('接続認証がタイムアウトしました'), AUTH_TIMEOUT_MS);

      if (direction === 'incoming') {
        try {
          state.nonce = encodeBase64Url(randomBytes(NONCE_BYTES));
          const responderId = ownerPeer.id;
          const initiatorId = raw.peer;
          const proof = await hmacProof(
            state.secret,
            authTranscript('responder', responderId, initiatorId, state.nonce, state.binding)
          );
          rawSend({ t: 'lemon-auth-challenge', a: AUTH_VERSION, n: state.nonce, p: proof });
        } catch (err) {
          fail(err && err.message ? err.message : '認証チャレンジを作成できません');
        }
      }
    }

    async function handleAuth(data) {
      if (state.failed || state.authenticated) return;
      if (!isAuthMessage(data)) throw new Error('認証前にアプリケーションデータを受信しました');
      if (data.a !== AUTH_VERSION) throw new Error('認証プロトコルのバージョンが一致しません');

      if (direction === 'outgoing' && data.t === 'lemon-auth-challenge') {
        if (!validSizedBase64Url(data.n, NONCE_BYTES) || !validSizedBase64Url(data.p, 32)) {
          throw new Error('認証チャレンジの形式が不正です');
        }
        state.nonce = data.n;
        const responderId = raw.peer;
        const initiatorId = ownerPeer.id;
        const responderOk = await verifyProof(
          state.secret,
          authTranscript('responder', responderId, initiatorId, state.nonce, state.binding),
          data.p
        );
        if (!responderOk) throw new Error('接続先を認証できませんでした');
        const proof = await hmacProof(
          state.secret,
          authTranscript('initiator', responderId, initiatorId, state.nonce, state.binding)
        );
        rawSend({ t: 'lemon-auth-response', a: AUTH_VERSION, n: state.nonce, p: proof });
        return;
      }

      if (direction === 'incoming' && data.t === 'lemon-auth-response') {
        if (data.n !== state.nonce || !validSizedBase64Url(data.p, 32)) throw new Error('認証応答の形式が不正です');
        const responderId = ownerPeer.id;
        const initiatorId = raw.peer;
        const initiatorOk = await verifyProof(
          state.secret,
          authTranscript('initiator', responderId, initiatorId, state.nonce, state.binding),
          data.p
        );
        if (!initiatorOk) throw new Error('接続元を認証できませんでした');
        rawSend({ t: 'lemon-auth-ok', a: AUTH_VERSION, n: state.nonce });
        succeed();
        return;
      }

      if (direction === 'outgoing' && data.t === 'lemon-auth-ok') {
        if (data.n !== state.nonce) throw new Error('認証完了メッセージが一致しません');
        succeed();
        return;
      }

      throw new Error('予期しない認証メッセージです');
    }

    rawOn('open', () => { startAuth(); });
    rawOn('data', (data) => {
      if (!state.authenticated) {
        state.processing = state.processing.then(() => handleAuth(data)).catch((err) => {
          fail(err && err.message ? err.message : '接続認証に失敗しました');
        });
        return;
      }
      if (isAuthMessage(data)) return;
      for (const listener of dataListeners.slice()) listener.call(proxy, data);
    });
    rawOn('close', () => {
      if (state.timer) clearTimeout(state.timer);
    });

    proxy = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'open') return !!(state.authenticated && target.open);
        if (prop === 'send') {
          return function (data, chunked) {
            if (!state.authenticated || !target.open) throw new Error('接続認証が完了していません');
            return rawSend(data, chunked);
          };
        }
        if (prop === 'on') {
          return function (event, listener) {
            if (event === 'open') {
              openListeners.push(listener);
              if (state.authenticated && target.open) queueMicrotask(() => listener.call(proxy));
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
        if (prop === '__lemonAuthenticated') return state.authenticated;
        if (prop === '__lemonAuthVersion') return AUTH_VERSION;
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
    if (raw.open) startAuth();
    return proxy;
  }

  function decoratePeer(peer) {
    if (!peer || peer.__lemonAuthPeer) return peer;
    Object.defineProperty(peer, '__lemonAuthPeer', { value: true });

    const rawOn = peer.on.bind(peer);
    const rawConnect = peer.connect.bind(peer);
    const connectionListeners = [];

    rawOn('open', (peerId) => {
      try {
        emit('lemon-auth-ready', { peerId, invite: makeInvite(peerId, localSecret), version: AUTH_VERSION });
      } catch (_) {}
    });

    rawOn('connection', (rawConn) => {
      const secret = knownSecrets.get(String(rawConn.peer || '')) || localSecret;
      decorateConnection(rawConn, 'incoming', secret, peer, (authenticatedConn) => {
        for (const listener of connectionListeners.slice()) listener.call(peer, authenticatedConn);
      });
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
      const parsed = parseInvite(target);
      const peerId = parsed ? parsed.peerId : String(target || '').trim();
      const secret = (parsed && parsed.secret) || knownSecrets.get(peerId) || null;
      if (parsed && parsed.secret) knownSecrets.set(peerId, parsed.secret);
      const rawConn = rawConnect(peerId, options);
      return decorateConnection(rawConn, 'outgoing', secret, peer, null);
    };

    return peer;
  }

  function install() {
    if (installed || !root || typeof root.Peer !== 'function') return false;
    installed = true;
    localSecret = randomSecret();
    const OriginalPeer = root.Peer;
    if (OriginalPeer.__lemonAuthWrapped) return true;

    const WrappedPeer = new Proxy(OriginalPeer, {
      construct(Target, args, newTarget) {
        const actualNewTarget = newTarget === WrappedPeer ? Target : newTarget;
        return decoratePeer(Reflect.construct(Target, args, actualNewTarget));
      },
      apply(Target, thisArg, args) {
        return decoratePeer(Reflect.apply(Target, thisArg, args));
      },
    });
    Object.defineProperty(WrappedPeer, '__lemonAuthWrapped', { value: true });
    root.Peer = WrappedPeer;
    return true;
  }

  return {
    AUTH_VERSION,
    SECRET_BYTES,
    encodeBase64Url,
    decodeBase64Url,
    validateSecret,
    makeInvite,
    parseInvite,
    makePairingUrl,
    extractFingerprints,
    channelBindingFromSdps,
    authTranscript,
    hmacProof,
    verifyProof,
    rememberInvite,
    install,
  };
});
