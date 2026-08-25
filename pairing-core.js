(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LemonPairingCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SECRET_BYTES = 16;
  const NONCE_BYTES = 16;
  const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;
  const PEER_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;

  function cryptoApi() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    if (typeof require === 'function') {
      try { return require('node:crypto').webcrypto; } catch (_) {}
    }
    throw new Error('Web Crypto API が利用できません');
  }

  function toBase64Url(bytes) {
    let base64;
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      base64 = Buffer.from(bytes).toString('base64');
    } else {
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      base64 = btoa(binary);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64Url(text) {
    const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    if (typeof Buffer !== 'undefined' && Buffer.from) return new Uint8Array(Buffer.from(padded, 'base64'));
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function randomToken(bytes) {
    const out = new Uint8Array(bytes);
    cryptoApi().getRandomValues(out);
    return toBase64Url(out);
  }

  function createSecret() {
    return randomToken(SECRET_BYTES);
  }

  function createNonce() {
    return randomToken(NONCE_BYTES);
  }

  function validPeerId(id) {
    return typeof id === 'string' && id.length >= 1 && id.length <= 128 && PEER_ID_RE.test(id);
  }

  function formatShareCode(peerId, secret) {
    if (!validPeerId(peerId)) throw new Error('Peer ID が不正です');
    if (!SECRET_RE.test(String(secret))) throw new Error('pairing secret が不正です');
    return peerId + '~' + secret;
  }

  function parseShareCode(raw) {
    const text = String(raw || '').trim();
    const cut = text.lastIndexOf('~');
    if (cut < 0) return { peerId: text, secret: null, paired: false, malformed: false };
    const peerId = text.slice(0, cut);
    const secret = text.slice(cut + 1);
    const malformed = !validPeerId(peerId) || !SECRET_RE.test(secret);
    return { peerId, secret: malformed ? null : secret, paired: !malformed, malformed };
  }

  function proofMessage(initiatorId, responderId, nonceA, nonceB, role) {
    return ['lemon-pair-v1', initiatorId, responderId, nonceA, nonceB, role].join('|');
  }

  async function makeProof(secret, initiatorId, responderId, nonceA, nonceB, role) {
    if (!SECRET_RE.test(String(secret))) throw new Error('pairing secret が不正です');
    if (!validPeerId(initiatorId) || !validPeerId(responderId)) throw new Error('Peer ID が不正です');
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(nonceA)) || !/^[A-Za-z0-9_-]{22}$/.test(String(nonceB))) {
      throw new Error('nonce が不正です');
    }
    if (role !== 'initiator' && role !== 'responder') throw new Error('role が不正です');
    const c = cryptoApi();
    const key = await c.subtle.importKey(
      'raw',
      fromBase64Url(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const bytes = new TextEncoder().encode(proofMessage(initiatorId, responderId, nonceA, nonceB, role));
    const sig = await c.subtle.sign('HMAC', key, bytes);
    return toBase64Url(new Uint8Array(sig));
  }

  function secureEqual(a, b) {
    const aa = String(a || '');
    const bb = String(b || '');
    if (aa.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < aa.length; i++) diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
    return diff === 0;
  }

  return {
    SECRET_BYTES,
    NONCE_BYTES,
    createSecret,
    createNonce,
    formatShareCode,
    parseShareCode,
    makeProof,
    secureEqual,
    validPeerId,
    toBase64Url,
    fromBase64Url,
  };
});
