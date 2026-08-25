# Third-party dependencies

Lemon currently executes two third-party browser libraries. Both are loaded from cdnjs with exact versions and SHA-512 Subresource Integrity (SRI) checks.

## PeerJS 1.5.5

- Project: PeerJS
- Upstream: https://github.com/peers/peerjs
- Runtime URL: `https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js`
- SRI: `sha512-XEKeWX+mI3Ov+tg2evDlVQFzVOIp4T8J3cNcCEPaEUGpxJV3eZaN8rHuvnFPvQpGJBHPmrozJDMpm2xcDvtmyQ==`
- License: MIT

PeerJS provides the WebRTC peer connection and DataChannel abstraction. Version 1.5.5 is pinned rather than using an unversioned or moving URL.

## qrcode-generator 1.4.4

- Project: qrcode-generator by Kazuhiko Arase
- Upstream: https://github.com/kazuhikoarase/qrcode-generator
- Runtime URL: `https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js`
- SRI: `sha512-ZDSPMa/JM1D+7kdg2x3BsruQ6T/JpJo3jWDWkCZsP+5yVyp1KfESqLI+7RqB5k24F7p2cV7i2YHh/890y6P6Sw==`
- License: MIT
- Copyright: Copyright (c) 2009 Kazuhiko Arase

qrcode-generator is used only to render the pairing QR code.

## Update policy

Do not update a URL or version without also updating and reviewing its SRI digest. `npm test` checks the exact runtime URLs and digests and fails when an unexpected remote script is introduced.

The longer-term goal remains vendoring these browser dependencies so that the executable distribution can be fully self-contained. SRI+CSP is the current intermediate hardening step.
