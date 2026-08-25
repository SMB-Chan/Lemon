(function (root) {
  'use strict';

  const result = { ok: false, reason: null };

  function publish() {
    try {
      root.__LEMON_AUTH_GUARD__ = Object.freeze({ ok: result.ok, reason: result.reason });
    } catch (_) {}
  }

  function showBlockedState() {
    try {
      const status = root.document && root.document.getElementById('status');
      if (status) {
        status.textContent = '安全な接続認証を初期化できないため停止しました';
        status.className = 'status err';
      }
      for (const id of ['connect-btn', 'file-btn', 'folder-btn']) {
        const el = root.document && root.document.getElementById(id);
        if (el) el.disabled = true;
      }
    } catch (_) {}
  }

  function block(reason) {
    result.ok = false;
    result.reason = String(reason || 'authentication guard failed');

    // app.js treats an absent Peer constructor as a hard stop. Deliberately remove
    // access to the raw PeerJS constructor so authentication can never fail open.
    try {
      root.Peer = undefined;
    } catch (_) {
      try {
        Object.defineProperty(root, 'Peer', {
          value: undefined,
          writable: false,
          configurable: true,
        });
      } catch (_) {}
    }

    publish();
    showBlockedState();
    setTimeout(showBlockedState, 0);
    return false;
  }

  try {
    const A = root.LemonAuth;
    if (!A || typeof A.install !== 'function') return block('LemonAuth is unavailable');
    if (!root.crypto || typeof root.crypto.getRandomValues !== 'function' || !root.crypto.subtle) {
      return block('Web Crypto API is unavailable');
    }
    if (typeof root.Peer !== 'function') return block('PeerJS is unavailable');

    // auth.js normally installs itself as soon as PeerJS is present. Retry once in
    // case script timing changes, but never accept an unwrapped constructor.
    if (!root.Peer.__lemonAuthWrapped) {
      try { A.install(); } catch (_) {}
    }
    if (typeof root.Peer !== 'function' || !root.Peer.__lemonAuthWrapped) {
      return block('authenticated Peer wrapper is not installed');
    }

    result.ok = true;
    publish();
    return true;
  } catch (err) {
    return block(err && err.message ? err.message : 'authentication guard failed');
  }
})(window);
