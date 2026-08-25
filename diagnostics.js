(function () {
  'use strict';

  const tracked = new Map();
  let sequence = 0;

  function connectionKey(conn) {
    if (!conn) return 'unknown';
    if (!conn.__lemonDiagKey) {
      Object.defineProperty(conn, '__lemonDiagKey', {
        value: String(conn.peer || 'peer') + ':' + (++sequence),
        configurable: false,
        enumerable: false,
      });
    }
    return conn.__lemonDiagKey;
  }

  function trackConnection(conn) {
    if (!conn || typeof conn !== 'object') return conn;
    const key = connectionKey(conn);
    tracked.set(key, conn);
    if (typeof conn.on === 'function') {
      conn.on('close', () => {
        if (tracked.get(key) === conn) tracked.delete(key);
        render().catch(() => {});
      });
    }
    return conn;
  }

  function observePeer(peer) {
    if (!peer || peer.__lemonDiagnosticsObserved) return peer;
    Object.defineProperty(peer, '__lemonDiagnosticsObserved', { value: true });

    if (typeof peer.connect === 'function') {
      const originalConnect = peer.connect.bind(peer);
      peer.connect = function () {
        return trackConnection(originalConnect.apply(null, arguments));
      };
    }

    if (typeof peer.on === 'function') {
      peer.on('connection', trackConnection);
    }
    return peer;
  }

  function wrapPeerConstructor() {
    const OriginalPeer = window.Peer;
    if (typeof OriginalPeer !== 'function' || OriginalPeer.__lemonDiagnosticsWrapped) return;

    const WrappedPeer = new Proxy(OriginalPeer, {
      construct(Target, args, newTarget) {
        const actualNewTarget = newTarget === WrappedPeer ? Target : newTarget;
        return observePeer(Reflect.construct(Target, args, actualNewTarget));
      },
      apply(Target, thisArg, args) {
        return observePeer(Reflect.apply(Target, thisArg, args));
      },
    });
    Object.defineProperty(WrappedPeer, '__lemonDiagnosticsWrapped', { value: true });
    window.Peer = WrappedPeer;
  }

  function peerConnectionOf(conn) {
    return conn && (
      conn.peerConnection ||
      conn._peerConnection ||
      conn._pc ||
      (conn.negotiator && conn.negotiator.peerConnection) ||
      (conn._negotiator && conn._negotiator.peerConnection)
    );
  }

  function selectedCandidatePair(stats) {
    let transport = null;
    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) transport = report;
    });
    if (transport) {
      const pair = stats.get(transport.selectedCandidatePairId);
      if (pair) return pair;
    }

    let selected = null;
    stats.forEach((report) => {
      if (report.type !== 'candidate-pair' || report.state !== 'succeeded') return;
      if (report.selected) selected = report;
      else if (!selected && report.nominated) selected = report;
      else if (!selected && report.bytesSent + report.bytesReceived > 0) selected = report;
    });
    return selected;
  }

  function candidateSummary(candidate) {
    if (!candidate) return null;
    return {
      type: candidate.candidateType || null,
      protocol: candidate.protocol || null,
      relayProtocol: candidate.relayProtocol || null,
      networkType: candidate.networkType || null,
      address: candidate.address || candidate.ip || null,
      port: Number.isFinite(candidate.port) ? candidate.port : null,
    };
  }

  function formatBits(bits) {
    if (!Number.isFinite(bits) || bits <= 0) return null;
    const units = ['bit/s', 'Kbit/s', 'Mbit/s', 'Gbit/s'];
    let value = bits;
    let i = 0;
    while (value >= 1000 && i < units.length - 1) {
      value /= 1000;
      i++;
    }
    return (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)) + ' ' + units[i];
  }

  async function inspectConnection(conn) {
    const pc = peerConnectionOf(conn);
    const base = {
      peer: String((conn && conn.peer) || '?'),
      open: !!(conn && conn.open),
      bufferedAmount: conn && conn.dataChannel && Number.isFinite(conn.dataChannel.bufferedAmount)
        ? conn.dataChannel.bufferedAmount : null,
      maxMessageSize: pc && pc.sctp && Number.isFinite(pc.sctp.maxMessageSize) ? pc.sctp.maxMessageSize : null,
      path: 'unknown',
      rttMs: null,
      outgoingBitrate: null,
      local: null,
      remote: null,
      error: null,
    };

    if (!pc || typeof pc.getStats !== 'function') {
      base.error = 'RTCPeerConnection.getStats() を取得できません';
      return base;
    }

    try {
      const stats = await pc.getStats();
      const pair = selectedCandidatePair(stats);
      if (!pair) {
        base.error = '選択済みICE candidate pairをまだ取得できません';
        return base;
      }

      const local = candidateSummary(stats.get(pair.localCandidateId));
      const remote = candidateSummary(stats.get(pair.remoteCandidateId));
      base.local = local;
      base.remote = remote;
      base.path = (local && local.type === 'relay') || (remote && remote.type === 'relay') ? 'relay' : 'direct';
      if (Number.isFinite(pair.currentRoundTripTime)) base.rttMs = pair.currentRoundTripTime * 1000;
      if (Number.isFinite(pair.availableOutgoingBitrate)) base.outgoingBitrate = pair.availableOutgoingBitrate;
      return base;
    } catch (err) {
      base.error = err && err.message ? err.message : String(err);
      return base;
    }
  }

  function valueRow(label, value, cls) {
    const row = document.createElement('div');
    row.className = 'diag-row';
    const dt = document.createElement('span');
    dt.className = 'diag-label';
    dt.textContent = label;
    const dd = document.createElement('span');
    dd.className = 'diag-value' + (cls ? ' ' + cls : '');
    dd.textContent = value == null ? '—' : String(value);
    row.append(dt, dd);
    return row;
  }

  function candidateText(candidate) {
    if (!candidate) return '—';
    const bits = [candidate.type, candidate.protocol, candidate.networkType].filter(Boolean);
    if (candidate.relayProtocol) bits.push('relay:' + candidate.relayProtocol);
    return bits.join(' / ') || '—';
  }

  async function render() {
    const output = document.getElementById('diag-output');
    if (!output) return [];
    output.replaceChildren();

    const conns = [...tracked.values()].filter((conn) => conn && conn.open);
    if (!conns.length) {
      const p = document.createElement('p');
      p.className = 'diag-empty';
      p.textContent = '診断できる接続がありません。相手と接続後に更新してください。';
      output.appendChild(p);
      return [];
    }

    const results = await Promise.all(conns.map(inspectConnection));
    for (const result of results) {
      const block = document.createElement('div');
      block.className = 'diag-peer';
      const title = document.createElement('strong');
      title.textContent = result.peer;
      block.appendChild(title);
      block.appendChild(valueRow('経路', result.path === 'relay' ? 'TURN relay' : result.path === 'direct' ? 'P2P direct' : '判定待ち', result.path === 'relay' ? 'diag-warn' : result.path === 'direct' ? 'diag-ok' : ''));
      block.appendChild(valueRow('RTT', result.rttMs == null ? '—' : result.rttMs.toFixed(1) + ' ms'));
      block.appendChild(valueRow('推定送信帯域', formatBits(result.outgoingBitrate) || '—'));
      block.appendChild(valueRow('Local candidate', candidateText(result.local)));
      block.appendChild(valueRow('Remote candidate', candidateText(result.remote)));
      block.appendChild(valueRow('SCTP maxMessageSize', result.maxMessageSize == null ? '—' : result.maxMessageSize + ' bytes'));
      block.appendChild(valueRow('DataChannel bufferedAmount', result.bufferedAmount == null ? '—' : result.bufferedAmount + ' bytes'));
      if (result.error) block.appendChild(valueRow('注記', result.error, 'diag-warn'));
      output.appendChild(block);
    }
    return results;
  }

  wrapPeerConstructor();

  window.LemonDiagnostics = {
    inspectConnection,
    snapshot: async () => Promise.all([...tracked.values()].filter((conn) => conn && conn.open).map(inspectConnection)),
    render,
  };

  window.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('diag-refresh');
    if (button) button.addEventListener('click', () => render().catch((err) => console.error(err)));
  });
})();
