# Security model

Lemon is a browser-based peer-to-peer file transfer tool. This document describes what the current implementation protects, what it trusts, and what it does **not** claim to protect.

## Protected today

- WebRTC DataChannel traffic is protected by WebRTC's DTLS transport encryption.
- User-facing pairing codes contain an independent 128-bit random pairing secret in addition to the PeerJS rendezvous ID.
- Before the file-transfer protocol sees a connection as open, Lemon performs an HMAC-SHA-256 challenge-response proving possession of that pairing secret.
- The HMAC transcript includes the WebRTC connection's local/remote DTLS certificate fingerprint sets, binding the proof to the concrete DTLS channel.
- The pairing secret itself is not sent in PeerJS connection metadata or pairing messages.
- HTTP/HTTPS pairing QR links place the secret in the URL fragment (`#peer=...`), not the query string, so new Lemon-generated links do not send it in the HTTP request to the web server.
- Lemon validates file metadata, declared sizes, group counts and end-of-transfer state before marking a transfer complete.
- Each transferred file is checked with CRC32 to detect transfer corruption or protocol state drift.
- ZIP entry paths reject parent traversal, absolute paths, drive-absolute paths, NULs and control characters.
- Sender ZIP creation is single-pass and the generated archive structure is checked in the test suite.
- Remote JavaScript dependencies are version-pinned and protected by Subresource Integrity (SRI).
- A Content Security Policy restricts script, style, object, frame and network sources.
- External scripts are loaded without a referrer and with anonymous CORS.

The detailed pairing state machine and HMAC transcript are documented in `PAIRING_PROTOCOL.md`.

## Runtime trust boundary

The browser executes these code sources:

1. Lemon's own `index.html`, `pairing-core.js`, `pairing.js`, `app.js`, `core.js` and `styles.css`.
2. PeerJS 1.5.5 from cdnjs, accepted only when its SHA-512 SRI digest matches.
3. qrcode-generator 1.4.4 from cdnjs, accepted only when its SHA-512 SRI digest matches.

The page is permitted to connect to the PeerJS public signaling service at `0.peerjs.com`. The signaling service brokers peer discovery and WebRTC setup. File payloads are sent through the WebRTC DataChannel rather than uploaded to that signaling endpoint.

## Pairing credential model

The displayed share code is a **bearer credential for the current page session**. Possession of the code is what Lemon authenticates; it does not represent a persistent user account or real-world identity.

- The pairing secret is 16 random bytes generated with Web Crypto.
- Reloading the page creates a new secret.
- The initiator keeps the remote secret only in JavaScript memory so automatic reconnect can authenticate a replacement WebRTC connection.
- The input QR/link fragment is removed from the visible URL before automatic connection begins.
- Anyone who obtains a valid current share code can attempt to authenticate, so screenshots, clipboard history and unintended code sharing remain security-sensitive.

## DTLS channel binding

A challenge-response that proves only knowledge of a shared secret can be transparently relayed between two different encrypted channels by a sufficiently powerful intermediary. Lemon therefore includes the current `RTCPeerConnection` DTLS certificate fingerprints in the HMAC transcript.

Each side canonicalizes the local and remote SDP `a=fingerprint:` values in direction-independent order. A proof generated for one DTLS certificate pair will not verify on another pair. If the fingerprints cannot be obtained, authentication fails closed.

This is intended to make signaling-layer connection substitution or handshake relay onto a different DTLS connection detectable. It is not a claim of anonymity or of persistent public-key identity.

## Important non-guarantees

### The share code is not a persistent identity

Pairing proves possession of the current responder's bearer secret, bound to the current DTLS connection. It does not establish a durable account identity, certificate authority, social identity, or device identity. If the share code is copied by an unintended party, that party has the same bearer credential until the page is reloaded.

### Endpoint compromise is out of scope

Lemon cannot protect files or pairing secrets from a compromised browser, malicious extension, compromised operating system, screen capture, clipboard monitor, or another process with access to the selected/saved file or page DOM.

### CRC32 is not a signature

CRC32 is used only to detect accidental corruption and protocol state mismatch. It is not collision resistant and must not be treated as proof of sender identity or protection against a malicious authenticated sender.

### Signaling availability and metadata

The public PeerJS signaling service remains an availability and metadata dependency. Lemon does not claim anonymity from the signaling infrastructure or network observers. A future self-hosted PeerServer option may reduce this dependency.

### Browser/WebRTC implementation assumptions

Channel binding depends on the browser and PeerJS exposing the underlying `RTCPeerConnection` and its local/remote SDP fingerprints consistently. The current implementation fails closed when those fingerprints are unavailable. Browser-version interoperability therefore requires real-device testing in addition to the Node.js protocol simulation.

### Large-file memory use

The current receive path holds received chunks in memory until a Blob is made available for saving. Split ZIP transfers bound some workloads, but a single very large file may still require substantial memory. Direct-to-disk receiving is a separate planned milestone.

## Content Security Policy

The static page currently enforces a meta CSP that:

- allows Lemon scripts from the same origin;
- allows the two pinned cdnjs script URLs through the cdnjs host, with SRI enforcing their exact bytes;
- permits network connections only to the same origin and the PeerJS public signaling endpoint;
- rejects `unsafe-inline` and `unsafe-eval` for scripts;
- rejects inline style blocks by moving styling into `styles.css`;
- blocks objects, frames and form submission.

When Lemon is deployed behind a configurable web server, an equivalent HTTP response-header CSP is preferred over relying only on a meta policy.

## Dependency updates

A dependency update should include all of the following in one reviewed change:

1. exact version change;
2. updated SRI digest from a trusted distribution source;
3. corresponding update to `THIRD_PARTY_NOTICES.md`;
4. successful `npm test` run;
5. review of upstream release notes for security or compatibility changes.

CI intentionally fails when an unexpected remote script is added or a pinned SRI digest changes without updating the tests.

## Security regression tests

`npm test` includes both static/invariant checks and an in-memory fake PeerJS/DataChannel simulation. The pairing tests verify that:

- a correct share secret authenticates before application `open` is exposed;
- application data cannot be sent before pairing succeeds;
- an incorrect secret never produces an authenticated application connection;
- responder/initiator HMAC roles are domain-separated;
- a changed DTLS fingerprint binding changes the proof;
- the same real DTLS fingerprint pair canonicalizes identically from both endpoint directions.

These tests do not replace Chrome/Firefox/Safari/Edge device testing, especially for SDP fingerprint availability and mobile lifecycle behavior.

## Reporting a vulnerability

Please report security-sensitive issues privately to the repository owner rather than publishing exploit details before a fix is available. Include the browser/OS, reproduction steps, affected transfer mode, whether the share code was known to the attacker, and whether the issue appears to involve signaling, pairing, WebRTC transport, ZIP handling or file persistence.
