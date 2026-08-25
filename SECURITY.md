# Security model

Lemon is a browser-based peer-to-peer file transfer tool. This document describes what the current implementation protects, what it trusts, and what it does **not** claim to protect.

## Protected today

- WebRTC DataChannel traffic is protected by WebRTC's DTLS transport encryption.
- Each page load generates an independent 128-bit pairing secret with `crypto.getRandomValues()`.
- The pairing secret is proved mutually with HMAC-SHA-256; the raw secret is not sent through the DataChannel.
- HMAC transcripts are bound to the DTLS fingerprints from both endpoint SDP descriptions, so a signaling intermediary cannot simply relay a valid proof across two different DTLS sessions.
- Application `open`, `send` and `data` are gated until pairing authentication completes. Transfer metadata or binary payload received before authentication is not exposed to the transfer layer.
- `auth-guard.js` re-checks Web Crypto and the authenticated Peer wrapper immediately before app startup; if authentication cannot initialize, raw PeerJS is removed and transfer controls are disabled.
- Authenticated peers exchange a bounded capability list before optional transport extensions are used.
- Lemon validates file metadata, declared sizes, group counts and end-of-transfer state before marking a transfer complete.
- Each transferred file is checked with CRC32 to detect transfer corruption or protocol state drift.
- ZIP entry paths reject parent traversal, absolute paths, drive-absolute paths, NULs and control characters.
- Sender ZIP creation is single-pass and the generated archive structure is checked in the test suite.
- On supporting browsers, direct-to-disk receiving uses a user-selected `FileSystemWritableFileStream` instead of retaining the whole file in a Blob.
- Direct-to-disk writes use application-level pause/resume flow control with bounded Lemon-side write backlog.
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
5. Only then does Lemon expose the connection to the capability and transfer layers.

Both proofs include the responder Peer ID, initiator Peer ID, nonce, role and a deterministic channel binding derived from the DTLS fingerprints present in the local and remote SDP. Authentication fails closed when the required DTLS fingerprints cannot be obtained.

The secret is retained only in page memory for authenticated reconnects. Reloading a page creates a new local pairing secret and therefore a new connection code.

### Fail-closed startup guard

`auth.js` normally installs the authenticated Peer wrapper as soon as PeerJS is available. `auth-guard.js` independently verifies the resulting state before `app.js` starts.

The guard requires:

- `crypto.getRandomValues()`;
- `crypto.subtle`;
- `LemonAuth.install()`;
- a callable `Peer` constructor that still exposes the `__lemonAuthWrapped` marker through any later wrapper layers.

If any requirement fails, the guard deliberately removes access to `window.Peer`, disables connect/file/folder controls, and leaves the app in a blocked error state. Lemon must not fall back from authenticated pairing to raw unauthenticated PeerJS.

This is intentionally different from direct-save fallback: **storage capability may fall back to Blob receiving; authentication capability may not fall back to unauthenticated transport.**

### Pairing URL privacy

For HTTP/HTTPS pages, Lemon puts the authenticated connection code in the URL **fragment** (`#peer=...`), not in the query string. Fragments are not sent as part of the HTTP request, which keeps the secret out of ordinary origin/CDN access logs. `pairing-ui.js` captures the fragment and immediately removes pairing material from the visible URL with `history.replaceState()`.

This does not protect the secret from the browser itself, browser extensions, screenshots, clipboard history, QR scanners, or anyone to whom the code is intentionally forwarded.

## Capability negotiation and direct-to-disk receiving

After authentication, `capabilities.js` sends a small `lemon-capabilities` control message. Feature names are length-limited, syntax-checked, deduplicated and capped in count before being accepted. Unknown features are ignored.

The current optional features are:

- `flow-control-v1` — the endpoint understands direct-save pause/resume control.
- `direct-save-v1` — the endpoint can expose the File System Access direct-save UI when its local browser supports it.

The normal Blob-based receive path remains the compatibility fallback. Direct save is shown only when the local browser exposes `showSaveFilePicker()` in a secure context and the authenticated remote advertises `flow-control-v1`.

Direct save is deliberately user initiated. The save picker is opened only from the explicit **直接保存** button; Lemon does not attempt to silently acquire a filesystem handle.

When direct save is selected:

1. the user chooses the destination file;
2. Lemon opens a writable stream before accepting the transfer;
3. incoming chunks are CRC32-checked and queued to that stream in order;
4. when queued-but-not-yet-written data reaches the high watermark, Lemon sends `lemon-flow paused=true`;
5. the sender's existing DataChannel backpressure path is held until the backlog falls below the low watermark;
6. the receiver waits for all queued writes, validates final byte count and CRC32, and only then closes the writable stream;
7. on mismatch, write failure, or disconnect, Lemon aborts the writable stream and closes the affected connection.

The current Lemon-side watermarks are 16 MiB high / 4 MiB low. This bounds Lemon's own pending-write queue; it does not establish a strict process-wide memory ceiling because the browser, WebRTC stack, filesystem implementation, operating system and storage device may buffer additional data internally.

Supporting File System Access implementations normally stage changes and expose them to the selected file when the writable stream is closed. Lemon relies on `abort()` for best-effort discard on verification failure, but exact crash/recovery behavior remains browser and operating-system dependent.

Direct save currently applies to standalone transfer objects, including sender-created ZIP files. When ZIP bundling is disabled, a folder is still handled by the existing per-file Blob receive path. Split ZIP parts can each be direct-saved; because each part is a separate destination file, the user selects a destination for each part.

## Runtime trust boundary

The browser executes these code sources:

1. Lemon's own `index.html`, `auth.js`, `core.js`, `capabilities.js`, `diagnostics.js`, `pairing-ui.js`, `auth-guard.js`, `app.js` and `styles.css`.
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

### Direct save does not make all browsers equivalent

`showSaveFilePicker()` is not universally available. Browsers without that API, insecure contexts, and unsupported deployment modes continue to use the Blob-based path. A single large Blob-based transfer can still require memory proportional to the file size.

### Availability attacks by authenticated peers

An authenticated peer can reject transfers, stop sending, disconnect, or hold a flow-control pause. Lemon treats these as availability failures rather than identity failures. Pairing authentication does not force a peer to complete a transfer.

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
3. corresponding update to `THIRD_PARTY_NOTICES.md` and `third-party-lock.json`;
4. successful `npm test` run;
5. review of upstream release notes for security or compatibility changes.

CI intentionally fails when an unexpected remote script is added or a pinned SRI digest changes without updating the canonical dependency lock and tests.

## Reporting a vulnerability

Please report security-sensitive issues privately to the repository owner rather than publishing exploit details before a fix is available. Include the browser/OS, reproduction steps, affected transfer mode, whether the complete pairing code was known, whether direct save was used, and whether the issue requires control of signaling or an endpoint.
