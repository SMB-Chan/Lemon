# Lemon pairing protocol v2

This document describes the application-layer pairing gate used before Lemon exposes a PeerJS `DataConnection` to the file-transfer protocol.

## Goal

A PeerJS ID is a rendezvous identifier, not an authentication credential. Lemon therefore combines the peer ID with an independent 128-bit random bearer secret and requires proof of that secret before the application sees a connection as open.

The pairing layer also binds that proof to the DTLS certificate fingerprints of the concrete WebRTC connection. This prevents a proof captured on one DTLS connection from being replayed or transparently relayed onto another connection with a different certificate pair.

## Share code

A share code has the form:

```text
<peer-id>~<22-character-base64url-secret>
```

The secret is 16 random bytes (128 bits), generated with `crypto.getRandomValues()` for the lifetime of the page.

For HTTP/HTTPS QR links Lemon uses:

```text
https://example/lemon/#peer=<url-encoded-share-code>
```

The secret is deliberately stored in the URL fragment, not the query string. URL fragments are not part of the HTTP request sent to the web server. Lemon removes the pairing fragment from the visible URL before starting the connection.

A copied share code is a bearer credential for the current page session. Anyone who obtains it can attempt to authenticate until the page is reloaded and a new secret is generated.

## Channel binding

After PeerJS reports the raw `DataConnection` open, Lemon reads the `RTCPeerConnection` local and remote SDP descriptions and extracts every `a=fingerprint:` line.

The local and remote fingerprint sets are normalized, sorted, and combined in direction-independent order:

```text
sort(local-fingerprint-set, remote-fingerprint-set).join("||")
```

Both endpoints therefore derive the same binding for a direct WebRTC connection even though their local/remote perspectives are reversed.

If either endpoint cannot obtain DTLS fingerprints, pairing fails closed.

## Handshake

The responder is the endpoint whose share code was given to the initiator. Both proofs use the responder's pairing secret.

1. The initiator generates a 128-bit `nonceA` and sends `hello(nonceA)`.
2. The responder generates a 128-bit `nonceB`.
3. The responder computes an HMAC-SHA-256 proof over the transcript with role `responder` and sends `challenge(nonceA, nonceB, proof)`.
4. The initiator recomputes and constant-time-compares the responder proof.
5. If it matches, the initiator computes the same transcript with role `initiator` and sends `response(nonceA, nonceB, proof)`.
6. The responder verifies that proof and sends `ok(nonceA, nonceB)`.
7. Only then does the wrapper expose a synthetic `open` event to Lemon's existing transfer application.

The HMAC transcript is the JSON serialization of:

```text
[
  "lemon-pair-v2",
  initiatorPeerId,
  responderPeerId,
  nonceA,
  nonceB,
  role,
  channelBinding
]
```

The role field domain-separates the two directions. Peer IDs, both nonces, and the DTLS channel binding are included to prevent cross-session and cross-peer reuse.

## What is never transmitted

The 128-bit pairing secret itself is not placed in PeerJS connection metadata and is not sent in any pairing message. Only HMAC outputs are transmitted over the already-established DTLS-protected DataChannel.

On the initiating side, a successfully parsed remote secret is cached only in JavaScript memory so Lemon's existing automatic reconnect path can authenticate a replacement WebRTC connection without asking the user to rescan the QR code. Refreshing the page clears that cache.

## Application gate

Before authentication succeeds:

- the wrapped connection reports `open === false`;
- application `send()` calls are rejected;
- ordinary application data received from the network causes the connection to be closed;
- pairing-control messages are consumed by the wrapper and are never forwarded to the transfer protocol.

After authentication succeeds, pairing-control messages remain reserved and are not forwarded to the transfer layer.

## Compatibility

This is intentionally not backward compatible with plain PeerJS IDs for new user-initiated connections. Both endpoints should run a pairing-capable Lemon version.

The internal reconnect path may use the bare peer ID only when the corresponding pairing secret is already present in the current page's in-memory cache.

## Security scope and limitations

The mechanism authenticates possession of the responder's bearer secret and binds that proof to the DTLS certificate pair visible on the WebRTC connection. It does not provide a persistent account identity, public-key identity, revocation service, or user identity beyond possession of the current share credential.

Security still depends on the endpoint browser/OS, Web Crypto implementation, correct extraction of the WebRTC SDP fingerprints, and secrecy of the share code. Browser extensions or local malware able to read the page can also read the pairing credential.

The public PeerJS signaling service remains an availability and metadata dependency. Channel binding is intended to make signaling-layer connection substitution detectable, but Lemon does not claim anonymity from signaling infrastructure or network observers.

## Tests

`tests/pairing.cjs` verifies:

- share-code parsing and format validation;
- HMAC determinism and role separation;
- proof changes when the secret changes;
- proof changes when the DTLS fingerprint binding changes;
- direction-independent fingerprint canonicalization;
- an end-to-end in-memory fake PeerJS/DataChannel pairing success path;
- rejection of a wrong-secret connection before synthetic `open` is exposed to the application.
