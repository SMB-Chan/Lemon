(function () {
  'use strict';

  const A = window.LemonAuth;
  if (!A) throw new Error('LemonAuth を読み込めませんでした');

  const peerInput = document.getElementById('peer-input');
  const myIdEl = document.getElementById('my-id');
  const qrCanvas = document.getElementById('my-qr');
  const qrHint = document.getElementById('qr-hint');
  const toastEl = document.getElementById('toast');
  let preset = null;
  let presetUsed = false;
  let toastTimer = null;

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
  }

  function combinedInvite(peerValue, keyValue) {
    if (!peerValue) return null;
    if (String(peerValue).includes('~')) return String(peerValue);
    if (keyValue) return String(peerValue) + '~' + String(keyValue);
    return String(peerValue);
  }

  function capturePresetAndScrubUrl() {
    try {
      const url = new URL(location.href);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      const peerValue = hash.get('peer') || url.searchParams.get('peer');
      const keyValue = hash.get('key') || url.searchParams.get('key');
      const raw = combinedInvite(peerValue, keyValue);
      const parsed = raw ? A.parseInvite(raw) : null;
      if (parsed) preset = parsed;

      url.searchParams.delete('peer');
      url.searchParams.delete('key');
      hash.delete('peer');
      hash.delete('key');
      url.hash = hash.toString();
      history.replaceState(null, '', url.href);
    } catch (_) {}
  }

  function normalizeInput() {
    if (!peerInput) return null;
    const parsed = A.parseInvite(peerInput.value);
    if (!parsed) return null;
    if (parsed.secret) A.rememberInvite(parsed.invite);
    if (parsed.secret || /^[a-z][a-z0-9+.-]*:/i.test(peerInput.value.trim())) {
      peerInput.value = parsed.peerId;
    }
    return parsed;
  }

  function drawQR(canvas, text) {
    if (!canvas || typeof qrcode !== 'function') return false;
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
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect((quiet + col) * scale, (quiet + row) * scale, scale, scale);
        }
      }
    }
    return true;
  }

  function renderAuthenticatedInvite(detail) {
    if (!detail || !detail.peerId || !detail.invite) return;
    if (myIdEl) myIdEl.textContent = detail.invite;

    try {
      const qrValue = (location.protocol === 'http:' || location.protocol === 'https:')
        ? A.makePairingUrl(location.href, detail.invite)
        : detail.invite;
      if (drawQR(qrCanvas, qrValue)) {
        qrCanvas.hidden = false;
        qrHint.textContent = (location.protocol === 'http:' || location.protocol === 'https:')
          ? 'QRの認証秘密はURLフラグメントに入り、HTTPリクエストには送信されません'
          : 'このQRには接続用の認証秘密を含みます。接続したい相手だけに共有してください';
      }
    } catch (_) {
      if (qrHint) qrHint.textContent = '認証付きQRを生成できませんでした';
    }

    if (preset && !presetUsed) {
      presetUsed = true;
      if (preset.secret) A.rememberInvite(preset.invite);
      setTimeout(() => {
        if (!peerInput) return;
        peerInput.value = preset.peerId;
        const button = document.getElementById('connect-btn');
        if (button) button.click();
      }, 0);
    }
  }

  capturePresetAndScrubUrl();

  if (peerInput) {
    peerInput.addEventListener('input', normalizeInput);
    peerInput.addEventListener('paste', () => setTimeout(normalizeInput, 0));
    peerInput.addEventListener('blur', normalizeInput);
  }

  window.addEventListener('lemon-auth-ready', (event) => {
    // app.js also reacts to PeerJS open. Defer so the authenticated invite wins the final UI update.
    setTimeout(() => renderAuthenticatedInvite(event.detail), 0);
  });

  window.addEventListener('lemon-auth-success', (event) => {
    const peer = event.detail && event.detail.peer;
    toast((peer || '相手') + ' の認証を確認しました');
  });

  window.addEventListener('lemon-auth-error', () => {
    toast('接続コードの認証に失敗しました');
  });
})();
