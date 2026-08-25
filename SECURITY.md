# Security model

Lemon is a browser-based peer-to-peer file transfer tool. This document describes what the current implementation protects, what it trusts, and what it does **not** yet claim to protect.

## Protected today

- WebRTC DataChannel traffic is protected by WebRTC's DTLS transport encryption.
- Lemon validates file metadata, declared sizes, group counts and end-of-transfer state before marking a transfer complete.
- Each transferred file is checked with CRC32 to detect transfer corruption or protocol state drift.
- ZIP entry paths reject parent traversal, absolute paths, drive-absolute paths, NULs and control characters.
- Sender ZIP creation is single-pass and the generated archive structure is checked in the test suite.
- Remote JavaScript dependencies are version-pinned and protected by Subresource Integrity (SRI).
- A Content Security Policy restricts script, style, object, frame and network sources.
- External scripts are loaded without a referrer and with anonymous CORS.

## Runtime trust boundary

The browser executes these code sources:

1. Lemon's own `index.html`, `app.js`, `core.js` and `styles.css`.
2. PeerJS 1.5.5 from cdnjs, accepted only when its SHA-512 SRI digest matches.
3. qrcode-generator 1.4.4 from cdnjs, accepted only when its SHA-512 SRI digest matches.

The page is permitted to connect to the PeerJS public signaling service at `0.peerjs.com`. The signaling service is required to broker peer discovery and WebRTC setup. File payloads are sent through the WebRTC DataChannel rather than uploaded to that signaling endpoint.

## Important non-guarantees

### Peer ID is not yet independent authentication

The current random Peer ID is deliberately difficult to guess, but it is still a rendezvous identifier. Lemon does not yet provide a separate cryptographic pairing secret or an authenticated short-code comparison. Anyone who obtains a valid current Peer ID can attempt to connect. File reception still requires explicit approval, except for continuation parts of an already-approved split transfer.

The next security milestone is an independent pairing secret exchanged through the QR/share code and verified only after the DataChannel is established.

### CRC32 is not a signature

CRC32 is used only to detect accidental corruption and protocol state mismatch. It is not collision resistant and must not be treated as proof of sender identity or protection against a malicious sender.

### Endpoint compromise is out of scope

Lemon cannot protect files from a compromised browser, malicious extension, compromised operating system, screen capture, or another process with access to the selected/saved file.

### Signaling availability and metadata

The public PeerJS signaling service remains an availability dependency. Lemon does not claim anonymity from the signaling infrastructure or network observers. A future self-hosted PeerServer option may reduce this dependency.

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

Please report security-sensitive issues privately to the repository owner rather than publishing exploit details before a fix is available. Include the browser/OS, reproduction steps, affected transfer mode and whether the issue requires knowledge of a Peer ID.
