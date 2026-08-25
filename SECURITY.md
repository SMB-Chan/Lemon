# Security model

Lemon is a browser-based peer-to-peer file transfer tool. This document describes what the current implementation protects, what it trusts, and what it does **not** claim to protect.

## Protected today

- WebRTC DataChannel traffic is protected by WebRTC's DTLS transport encryption.
- Each page load generates an independent 128-bit pairing secret with `crypto.getRandomValues()`.
- The pairing secret is proved mutually with HMAC-SHA-256; the raw secret is not sent through the DataChannel.
- HMAC transcripts are bound to the DTLS fingerprints from both endpoint SDP descriptions, so a signaling intermediary cannot simply relay a valid proof across two different DTLS sessions.
- Application `open`, `send` and `data` are gated until pairing authentication completes. Transfer metadata or binary payload received before authentication is not exposed to the transfer layer.
- Lemon validates file metadata, declared sizes, group counts and end-of-transfer state before marking a transfer complete.
- Each transferred file is checked with CRC32 to detect transfer corruption or protocol state drift.
- ZIP entry paths reject parent traversal, absolute paths, drive-absolute paths, NULs and control characters.
- Sender ZIP creation is single-pass and the generated archive structure is checked in the test suite.
- Remote JavaScript dependencies are version-pinned and protected by Subresource Integrity (SRI).
- A Content Security Policy restricts script, style, object, frame and network sources.
- External scripts are loaded without a referrer and with anonymous CORS.
- Connection diagnostics use the browser's local `RTCPeerConnection.getStats()` API; no diagnostics endpoint is added.

## Authenticated pairing

A displayed connection code is a capability consisting of the Peer ID plus a 128-bit secret. Treat the complete code and QR as sensitive: anyone who obtains a current code can authenticate as a peer for that page session.

The authentication exchange is deliberately separated from the file-transfer framing:

1. PeerJS/WebRTC establishes a raw DTLS-protected DataChannel.
2. The responder generates a fresh 128-bit nonce and sends an HMAC-SHA-256 challenge proof.
3. The initiator verifies the responder proof and returns a role-separated HMAC proof.
4. The responder verifies it and returns an authentication-complete message.
5. Only then does Lemon expose the connection to `app.js` and the transfer protocol.

Both proofs include the responder Peer ID, initiator Peer ID, nonce, role and a deterministic channel binding derived from the DTLS fingerprints present in the local and remote SDP. Authentication fails closed when the required DTLS fingerprints cannot be obtained.

The secret is retained only in page memory for authenticated reconnects. Reloading a page creates a new local pairing secret and therefore a new connection code.

### Pairing URL privacy

For HTTP/HTTPS pages, Lemon puts the authenticated connection code in the URL **fragment** (`#peer=...`), not in the query string. Fragments are not sent as part of the HTTP request, which keeps the secret out of ordinary origin/CDN access logs. `pairing-ui.js` captures the fragment and immediately removes pairing material from the visible URL with `history.replaceState()`.

This does not protect the secret from the browser itself, browser extensions, screenshots, clipboard history, QR scanners, or anyone to whom the code is intentionally forwarded.

## Runtime trust boundary

The browser executes these code sources:

1. Lemon's own `index.html`, `auth.js`, `pairing-ui.js`, `app.js`, `core.js`, `diagnostics.js` and `styles.css`.
2. PeerJS 1.5.5 from cdnjs, accepted only when its SHA-512 SRI digest matches.
3. qrcode-generator 1.4.4 from cdnjs, accepted only when its SHA-512 SRI digest matches.

The page is permitted to connect to the PeerJS public signaling service at `0.peerjs.com`. The signaling service is required to broker peer discovery and WebRTC setup. File payloads and the raw pairing secret are not uploaded to that signaling endpoint by Lemon.

## Connection diagnostics and privacy

The diagnostics panel inspects the selected ICE candidate pair locally. It may determine candidate type (`host`, `srflx`, `prflx`, or `relay`), transport protocol, RTT, browser-reported available outgoing bitrate, SCTP message-size limits, and DataChannel buffered bytes.

The visible UI intentionally does **not** print candidate IP addresses. `window.LemonDiagnostics.snapshot()` is a developer-facing local API and may include candidate address/port values when the browser exposes them through `getStats()`. Lemon does not transmit these diagnostic results to an application server.

A `TURN relay` result means the WebRTC data path is using a relay candidate; `P2P direct` means the selected pair is not reported as relay. This is an operational diagnostic, not an authentication result.

## Important non-guarantees

### Pairing is a capability, not permanent identity

Authenticated pairing proves possession of the current shared capability and binds that proof to the current DTLS session. It does not establish a durable human identity, account identity, public-key identity, device attestation, or certificate chain. If a connection code is leaked, copied or deliberately forwarded, its holder can authenticate while that capability remains usable.

### CRC32 is not a signature

CRC32 is used only to detect accidental corruption and protocol state mismatch. It is not collision resistant and must not be treated as proof of sender identity or protection against a malicious authenticated sender.

### Endpoint compromise is out of scope

Lemon cannot protect files or pairing material from a compromised browser, malicious extension, compromised operating system, screen capture, clipboard monitor, or another process with access to the selected/saved file.

### Signaling availability and metadata

The public PeerJS signaling service remains an availability and rendezvous-metadata dependency. Lemon does not claim anonymity from the signaling infrastructure or network observers. DTLS-fingerprint-bound HMAC prevents simple proof relaying across different DTLS sessions, but it does not turn the public signaling service into an anonymous transport.

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

## Reporting a vulnerability

Please report security-sensitive issues privately to the repository owner rather than publishing exploit details before a fix is available. Include the browser/OS, reproduction steps, affected transfer mode, whether the complete pairing code was known, and whether the issue requires control of signaling or an endpoint.
