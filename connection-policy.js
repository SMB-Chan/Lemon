(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LemonConnectionPolicy = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function cleanPeerId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 128) throw new Error('Peer IDが不正です');
    return id;
  }

  function preferredDirection(localId, remoteId) {
    const local = cleanPeerId(localId);
    const remote = cleanPeerId(remoteId);
    if (local === remote) throw new Error('同一Peer間の接続方向は決定できません');
    return local < remote ? 'outgoing' : 'incoming';
  }

  function shouldReplaceExisting(localId, remoteId, existingOutgoing, newOutgoing, existingBusy) {
    if (existingBusy) return false;
    if (!!existingOutgoing === !!newOutgoing) return false;
    const preferred = preferredDirection(localId, remoteId);
    return (preferred === 'outgoing') === !!newOutgoing;
  }

  return {
    preferredDirection,
    shouldReplaceExisting,
  };
});
