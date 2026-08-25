# Lemon — P2P ファイル転送

ブラウザだけで動く、マルチプラットフォームな P2P ファイル送受アプリです。
[PeerJS](https://peerjs.com/) / WebRTC DataChannel を使い、接続後の転送は端末間で行います。

## 現在の設計方針

Lemon は機能追加だけでなく、**転送プロトコル・相手認証・実行コード・大容量受信の境界**を段階的に固めています。

### v1.1 — protocol hardening

- 同じ相手への送信を接続単位のキューで直列化
- 受信メタデータ、ファイル数、サイズ、ID、パスを境界で検証
- 申告サイズを超えるバイナリ受信を中止
- 転送終了時に実受信サイズと CRC32 を照合
- ZIP 内の `..`、絶対パス、ドライブ絶対パス、制御文字を拒否
- ZIP local header / central directory の general purpose flag を一致
- sender-side single-pass ZIP + data descriptor 方式へ変更
- 分割転送で保存確認が取れない場合は次パートへ進まない
- Peer ID を長くし、短いコードへの総当たり耐性を改善
- `app.js` / `core.js` を分離し、コアを Node.js からテスト可能化

旧「受信側で ZIP を組み立てる」モードは削除しました。旧版が `bundle-start` を送ってきた場合は明示的に拒否します。**両端末を同じ最新版に揃えることを推奨します。**

### v1.2 — trust-boundary hardening

**Supply chain**

- PeerJS 1.5.5 / qrcode-generator 1.4.4 を完全なバージョンURLで固定
- SHA-512 Subresource Integrity (SRI)
- cdnjs 1系統へ集約
- Content Security Policy (CSP)
- `unsafe-inline` / `unsafe-eval` 不使用
- `third-party-lock.json` を依存情報の正本とし、CIがURL・版・SRI・許可origin・notice整合性を検証

**Authenticated pairing**

- ページ読み込みごとに128-bit pairing secretを生成
- 接続コードを `Peer ID~pairing secret` の capability として扱う
- HMAC-SHA-256による相互proof
- responder / initiator transcriptをrole-separated化
- proofを双方のSDPに含まれるDTLS fingerprintへchannel-bind
- 認証完了まで `open` / `send` / `data` を転送層へ公開しない
- 認証済み相手の秘密をページメモリだけに保持し、再接続で再認証
- HTTP/HTTPSのQRは秘密を `#peer=...` URL fragmentへ載せ、取得後にURLから除去
- `auth-guard.js` がWeb Cryptoと認証済みPeer wrapperを起動直前に再検証し、認証初期化に失敗した場合はraw PeerJSを削除してfail closed

転送フレーム自体は v2 のままです。認証をその下のセッション確立層として独立させています。

### v1.3 — capability handshake / direct-to-disk

- 認証後に `lemon-capabilities` を交換
- feature名は個数・長さ・文字種を検証し、未知featureは無視
- `flow-control-v1` でdirect-save受信側から送信側へ pause/resume を通知
- `direct-save-v1` でFile System Access APIによる直接保存能力を広告
- 対応受信側では、保存先へ受信チャンクを順次書き込み
- 書き込み待ちが16 MiBに達すると既存のDataChannel backpressureを停止させ、4 MiB以下で再開
- 最終サイズとCRC32が一致してから writable stream を close
- 不一致・書き込み失敗・切断時は writable stream を abort し、接続を失敗扱いにする
- 従来のBlob受信は互換フォールバックとして維持
- `app.js` / `core.js` は変更せず、`capabilities.js` を既存転送層の外側へ追加

`showSaveFilePicker()` はすべてのブラウザで使えるAPIではありません。直接保存は、安全なコンテキストでAPIが利用可能かつ認証済み相手が `flow-control-v1` を広告した場合だけ表示されます。

## ファイル構成

```text
index.html                 UI / エントリポイント / CSP
auth.js                    pairing secret / HMAC / DTLS channel binding
core.js                    CRC32、ZIP、パス・メタデータ検証
capabilities.js            capability handshake / flow control / direct-to-disk
diagnostics.js             WebRTC route / ICE / SCTP ローカル診断
pairing-ui.js              接続コード・QR・URL fragment処理
auth-guard.js              認証初期化のfail-closed最終検査
app.js                     既存の送受信状態・UI・転送キュー
styles.css                 UI スタイル
third-party-lock.json      runtime dependency の機械可読正本
SECURITY.md                脅威モデル・信頼境界・非保証事項
THIRD_PARTY_NOTICES.md     外部依存の固定情報
package.json               ゼロ依存のテストコマンド
tests/smoke.cjs            コア・認証・capability・CSP/SRIテスト
tests/auth-guard-smoke.cjs fail-closed認証ガードテスト
```

## 動かし方

最小構成では `index.html` をブラウザで開けます。ただし **direct-to-disk は安全なコンテキストと対応ブラウザが必要**です。通常受信は従来どおり利用できます。

同じ LAN の別端末から開く場合は、たとえば静的 HTTP サーバーを利用できます。

```bash
python3 -m http.server 8000
# → http://<このPCのIP>:8000/
```

File System Access API を確実に使う用途では HTTPS 配信を推奨します。PeerJS 公開シグナリングサービスと pinned CDN dependency の取得にはインターネット接続が必要です。

## 使い方

1. 両端末で Lemon を開く
2. 「自分の接続コード」を相手へ共有する（QRまたはコピー）
3. 相手側で接続コードを入力して「接続」
4. HMAC/DTLS-binding認証が通ると接続一覧へ現れる
5. ファイルまたはフォルダを選択して送信
6. 受信側では通常の「受け取る」、または対応時に「直接保存」を選択
7. サイズとCRC32の検証が通ると完了

## 認証付き接続コードと QR

完全な接続コードは **秘密情報です**。接続したい相手だけに共有してください。

- Peer ID は rendezvous identifier
- 128-bit pairing secret が接続認証に使われる
- secretそのものはDataChannelへ送らずHMAC proofだけを交換
- proofは双方のDTLS fingerprintへchannel-bind
- fingerprintを取得できない場合はfail closed
- ページ再読み込みで新しいlocal pairing secretになる
- 接続コードを知る人はそのセッションのcapabilityを持つ

HTTP/HTTPSのQRでは接続コードを `#peer=...` に格納します。URL fragmentは通常のHTTPリクエストに含まれません。読み取り後は `history.replaceState()` でpairing情報を除去します。

これは恒久的な人物・端末identityではありません。詳しくは `SECURITY.md` を参照してください。

## Direct-to-disk

通常の受信では、チャンクをメモリ上に保持して最後に `Blob` を作成します。v1.3の直接保存では、対応ブラウザでユーザーが保存先を選択した後、`FileSystemWritableFileStream` へ順次書き込みます。

直接保存を選べる条件:

- `showSaveFilePicker()` が利用可能
- secure context
- 認証済み相手が `flow-control-v1` を広告
- standalone transfer（通常ファイルまたはsender-side ZIP）

直接保存では、全ファイルを1つのBlobとして保持しません。Lemon自身の未書き込みqueueは16 MiBでpause、4 MiBでresumeします。ただし、WebRTC・ブラウザ・OS・ストレージ側の内部bufferまで含む厳密なプロセス全体メモリ上限を保証するものではありません。

受信終了時は、queueの書き込み完了 → サイズ/CRC32確認 → `close()` の順です。不一致・I/Oエラー・切断では `abort()` を試みます。

分割ZIPを直接保存する場合、各partは独立ファイルなのでpartごとに保存先を選択します。ZIPを無効にしたフォルダ転送は現時点では従来のファイル単位Blob受信です。

## ZIP と大量転送

- 複数ファイル・フォルダは既定で無圧縮 ZIP (STORE)
- sender-side single-pass ZIPなのでソースファイル読み出しは1回
- UTF-8ファイル名とフォルダ階層を保持
- 合計1 GiB超の複数ファイル転送は概ね1 GiB以下の独立ZIP partへ分割
- 各partは単体で正当なZIP
- Blob経路では保存ACK後に次partへ進む
- direct-save経路ではwrite/CRC/close完了後にpart ACKを返す
- 再接続でもDataChannelごとにHMAC/DTLS-binding認証をやり直す
- 1ファイルそのものを途中byte位置から分割・resumeする機能はまだない

ZIPを無効にすると、単独ファイルはそのまま、フォルダはファイル単位で転送します。

## 転送と整合性

認証完了後、各ファイルについて次を検証します。

- `meta.size` を超えてデータが到着していないこと
- `end` 時の受信byte数が申告サイズと一致すること
- 送信側/受信側 CRC32 が一致すること
- フォルダ転送ではファイル数と合計サイズも一致すること

CRC32 は転送破損・状態ずれ検出用であり、暗号学的署名ではありません。相手認証はpairing secret/HMAC層が担当します。

## 実行コードの信頼境界

ブラウザで実行される第三者コードは2つです。

- PeerJS 1.5.5
- qrcode-generator 1.4.4

`third-party-lock.json` がURL・exact version・SHA-512 SRI・origin・license情報の機械可読正本です。`THIRD_PARTY_NOTICES.md` と実際の `index.html` がこれと一致することをCIで確認します。

CSPの主な制約:

- `default-src 'self'`
- `script-src 'self' https://cdnjs.cloudflare.com`
- `style-src 'self'`
- `connect-src 'self' https://0.peerjs.com wss://0.peerjs.com`
- `object-src 'none'`
- `base-uri 'none'`
- `form-action 'none'`
- `unsafe-inline` / `unsafe-eval` 不使用

## 再接続・省電力

- 対応ブラウザでは転送中に Screen Wake Lock を要求
- 既存Blob経路では無音 AudioContext もベストエフォートで使用
- direct-save層も独自にWake Lockを要求
- 分割ZIPは切断時に同じ相手へ再接続し、失敗partを最大5回再試行
- 再接続でも認証をやり直す
- byte offsetからの途中resumeは未実装

## メモリ使用量

**Blob経路:** ファイルサイズに比例してメモリ使用量が増える可能性があります。

**Direct-save経路:** Lemonが保持する未書き込みqueueをwatermarkで制御します。大容量ファイルではこちらを推奨しますが、対応ブラウザ・secure contextが必要です。

## 接続診断

「接続診断」は `RTCPeerConnection.getStats()` から選択済みICE経路をローカルに読み取ります。

- `P2P direct`: candidate pairがrelayではない
- `TURN relay`: 少なくとも片側がrelay candidate
- RTT、推定送信帯域、candidate type、SCTP `maxMessageSize`、DataChannel `bufferedAmount`
- UIにはcandidate IP addressを表示しない

`window.LemonDiagnostics.snapshot()` は開発者向けローカルAPIで、ブラウザが公開する場合はaddress/portを含み得ます。診断結果をLemonのアプリケーションサーバーへ送信しません。

`?debug=1` では従来の `window.__p2p` も利用できます。

```js
__p2p.state()
await __p2p.stats()
__p2p.sendEntries(...)
```

LAN内P2Pの速度問題を調べる際、インターネット回線の上り速度だけを基準にしないでください。Wi-Fi、ストレージ、ブラウザ制限、ICE経路を切り分ける必要があります。

## テスト

Node.js 18以上、外部npm依存なしで実行できます。

```bash
npm test
```

主な検査:

- CRC32既知vector
- ZIP traversal / absolute path拒否
- metadata / size / CRC終了検証
- ZIP header整合性 / partitioning
- 128-bit pairing secret / invite / fragment URL
- DTLS fingerprint channel binding
- HMAC transcript role separation
- capability feature listの境界検証
- direct sinkのwrite順序・high/low watermark・close/abort
- auth guardの正常系 / Web Crypto欠如 / wrapper初期化失敗時のfail closed
- browser module構文
- script読込順
- machine-readable dependency lock / exact version / SRI / notices
- CSP弱体化・予期しないremote scriptの検出
- pairing URL scrub
- WebRTC診断実装

## 外部依存と注意

- Peer ID発行・相手発見にはPeerJS公開シグナリングを利用
- NAT / firewall条件によってWebRTC接続が成立しない場合がある
- SRI+CSPはCDN改ざんriskを狭めるがCDN依存は残る
- 接続コードが漏れた場合、そのcapabilityを持つ相手を区別できない
- OS・ブラウザ・拡張機能が侵害されている場合は保護できない
- `showSaveFilePicker()` は限定対応のため、直接保存が表示されない環境がある

## 今後の候補

1. SCTP `maxMessageSize` と実測buffer状況に応じた動的chunk size交渉
2. PeerJS / QRライブラリのvendoringによるruntime code完全自己完結化
3. Chromium / Firefox / Safari / Androidを含む実ブラウザintegration test
4. direct-saveのフォルダ/Directory Handle対応
5. 必要に応じてself-hosted PeerServerや長期公開鍵identityを別モードとして検討
