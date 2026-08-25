# Lemon — P2P ファイル転送

ブラウザだけで動く、マルチプラットフォームな P2P ファイル送受アプリです。
[PeerJS](https://peerjs.com/) / WebRTC DataChannel を使い、接続後の転送は端末間で行います。

## 現在の設計方針

Lemon は機能追加だけでなく、**転送プロトコル・相手認証・実行コードの信頼境界**を段階的に固めています。

### v1.1 — protocol hardening

- 同じ相手への送信を接続単位のキューで直列化し、転送状態の上書きを防止
- 受信メタデータ、ファイル数、サイズ、ID、パスを境界で検証
- 申告サイズを超えるバイナリ受信を即座に中止
- 転送終了時に実受信サイズと CRC32 を照合
- ZIP 内の `..`、絶対パス、ドライブ絶対パス、制御文字を拒否
- ZIP の local header / central directory で general purpose flag を一致
- 送信側 ZIP を data descriptor 方式の **single-pass ZIP** に変更し、CRC 計算のための事前読み直しを廃止
- 分割転送で受信側の保存確認が取れなかった場合、次のパートへ進まない
- Peer ID を従来より長くし、短いコードへの総当たり耐性を改善
- DOM/UI と ZIP・検証ロジックを `app.js` / `core.js` に分離し、コアを Node.js からテスト可能化

旧「受信側で ZIP を組み立てる」モードは、single-pass ZIP によって主な性能上の利点が薄れたため削除しました。旧版が `bundle-start` を送ってきた場合は明示的に拒否します。**両端末を同じ最新版に揃えることを推奨します。**

### v1.2 — trust-boundary hardening

供給網と接続相手の2つの境界を強化しました。

**Supply chain**

- PeerJS を 1.5.5、qrcode-generator を 1.4.4 に固定
- 両リモートスクリプトに SHA-512 Subresource Integrity (SRI) を設定
- CDN を cdnjs の1系統に集約し、`crossorigin="anonymous"` / `referrerpolicy="no-referrer"` を設定
- Content Security Policy (CSP) で実行元・接続先・オブジェクト・フォーム等を制限
- インライン CSS を `styles.css` に分離し、`unsafe-inline` / `unsafe-eval` を不要化
- CI が予期しない外部スクリプト、SRI変更、CSPの弱体化を検出

**Authenticated pairing**

- ページ読み込みごとに128-bit pairing secretを `crypto.getRandomValues()` で生成
- 接続コードを `Peer ID~pairing secret` の capability として扱う
- DataChannel確立後、HMAC-SHA-256で相互に秘密の所持を証明
- responder / initiator のproofを別トランスクリプトにして反射を防止
- proofを双方のSDPに含まれるDTLS fingerprintへchannel-bind
- 認証が終わるまで `open` / `send` / `data` を転送層へ公開しない
- 認証済み相手の秘密だけをページメモリへ保持し、分割ZIPの再接続に再利用
- HTTP/HTTPSのQRでは秘密をクエリではなく `#peer=...` フラグメントへ載せる
- ペアリング情報を取り込んだ直後、`history.replaceState()` でURLから除去

ファイル転送のフレーム形式自体は v2 のままです。認証はその下のセッション確立層として独立させ、ZIP・CRC・転送キューへ不要な変更を持ち込まない構成にしています。

## ファイル構成

```text
index.html                 UI / エントリポイント / CSP
auth.js                    pairing secret / HMAC / DTLS channel binding
pairing-ui.js              接続コード・QR・URL fragmentの処理
styles.css                 UI スタイル
diagnostics.js             WebRTC route / ICE / SCTP ローカル診断
app.js                     PeerJS、送受信状態、UI、転送キュー
core.js                    CRC32、ZIP、パス・メタデータ検証
SECURITY.md                脅威モデル・信頼境界・非保証事項
THIRD_PARTY_NOTICES.md     外部依存の固定情報
package.json               ゼロ依存のテストコマンド
tests/smoke.cjs            コア・認証・CSP/SRIスモークテスト
```

## 動かし方

最小構成では `index.html` をブラウザで開くだけです。Chrome / Edge / Firefox / Safari の PC・スマートフォンを想定しています。

同じ LAN の別端末から開く場合は、たとえば次のように静的 HTTP サーバーを起動します。

```bash
python3 -m http.server 8000
# → http://<このPCのIP>:8000/
```

PeerJS の公開シグナリングサービスと pinned CDN dependency の取得にはインターネット接続が必要です。依存ファイルを将来 vendoring した後も、公開 PeerServer を使う限りシグナリング用のネット接続は残ります。

## 使い方

1. 両方の端末で Lemon を開く
2. 片方の「自分の接続コード」をもう片方へ共有する（QRまたはコピー）
3. 相手側で接続コードを入力して「接続」。QR URLなら自動入力・接続される
4. 相互HMAC認証が通ると接続一覧・送信先として利用可能になる
5. ファイルまたはフォルダをドラッグ＆ドロップ、またはボタンで選択
6. 相手側で「受け取る」を押す
7. サイズと CRC32 の確認が通ると「完了・整合性確認済み」になり、保存できる

## 認証付き接続コードと QR

完全な接続コードは **秘密情報です**。接続したい相手だけに共有してください。

- Peer ID は相手発見のための rendezvous identifier です
- 独立した128-bit pairing secretが実際の接続認証に使われます
- 秘密そのものはDataChannel上へ送らず、HMAC-SHA-256 proofだけを交換します
- proofには双方のDTLS fingerprintを含むchannel bindingを入れます
- 必要なfingerprintをブラウザから取得できなければ認証はfail closedします
- ページを再読み込みするとローカルpairing secretと接続コードは新しくなります
- 接続コードを知る人はそのセッションのcapabilityを持つため、公開場所へ貼らないでください

HTTP/HTTPSでQRを生成すると、接続コードは `#peer=...` に格納されます。URL fragmentは通常のHTTPリクエストに含まれないため、origin/CDNの通常アクセスログへ秘密を送る `?peer=...` より安全です。読み取り後はURLからpairing情報を除去します。

これは恒久的な人物・端末IDではありません。アカウント、公開鍵証明書、端末attestation等を提供するものでもありません。詳しくは `SECURITY.md` を参照してください。

## ZIP と大量転送

- 2つ以上のファイル・フォルダは、既定で1つの無圧縮 ZIP（STORE）として送ります
- ZIP は送信しながら CRC32 を計算し、data descriptor を書くため、各ソースファイルの読み出しは1回です
- フォルダ階層と UTF-8 ファイル名を保持します
- 合計が 1 GiB を超える複数ファイル転送は、概ね 1 GiB 以下の独立した ZIP パートに分割します
- 各パートは単体で正当な ZIP です
- 最初のパートを承認すると、同じ `splitId` の後続パートは自動受信します
- 次パートは受信側が現在パートの「ファイルを保存」を押したことを確認してから送ります
- 認証済み相手のpairing secretはページメモリに保持されるため、同一ページセッション内のパート再接続でも再認証されます
- 1ファイルそのものが 1 GiB を超える場合、そのファイルを途中分割する機能はまだありません

ZIP を無効にした場合、単独ファイルはそのまま送信され、フォルダはファイル単位で受信・保存します。

## 転送と整合性

WebRTC DataChannel 自体は DTLS で暗号化されます。認証完了後、アプリ層では各ファイルについて次を検証します。

- `meta.size` を超えてデータが到着していないこと
- `end` 到着時の受信バイト数が申告サイズと一致すること
- 現行版同士では送信側と受信側の CRC32 が一致すること
- フォルダ転送ではファイル数と合計サイズも一致すること

CRC32 は **転送破損や状態ずれを検出するための整合性チェック** であり、暗号学的な署名や認証ではありません。相手認証はpairing secret/HMAC層が担当します。

## 実行コードの信頼境界

現在ブラウザで実行される第三者コードは2つだけです。

- PeerJS 1.5.5
- qrcode-generator 1.4.4

どちらも cdnjs の完全なバージョン URLを使い、SHA-512 SRI が一致しない場合はブラウザが実行を拒否します。さらにCSPがスクリプト元を同一オリジンとcdnjsへ制限します。

`THIRD_PARTY_NOTICES.md` に正確な URL / SRI / ライセンスを記録しています。SRI+CSPはCDN改ざんリスクを大幅に狭めますが、CDN依存そのものを消すものではありません。

### CSP の主な制約

- `default-src 'self'`
- `script-src 'self' https://cdnjs.cloudflare.com`
- `style-src 'self'`
- `connect-src 'self' https://0.peerjs.com wss://0.peerjs.com`
- `object-src 'none'`
- `base-uri 'none'`
- `form-action 'none'`
- `unsafe-inline` / `unsafe-eval` は許可しない

静的ホスティング先でHTTPレスポンスヘッダーを設定できる場合は、meta CSPと同等以上のポリシーをレスポンスヘッダーとして出す方が望ましいです。

## 再接続・省電力対策

- 対応ブラウザでは転送中に Screen Wake Lock を要求します
- モバイル OS のバックグラウンド抑制に対して、無音 AudioContext をベストエフォートで使用します
- 分割 ZIP 転送は、切断時に同じ相手へ再接続し、失敗したパートを最大5回まで再試行します
- 再接続でもDataChannelごとにHMAC/DTLS-binding認証をやり直します
- 通常の単独ファイル転送を途中バイト位置から再開する機能はまだありません

画面消灯・長時間バックグラウンド化は OS / ブラウザによって強制停止される場合があります。大量転送では画面を表示したままにするのが最も確実です。

## メモリ使用量

現在の受信側は、受け取ったチャンクを `Blob` にまとめ、ユーザーが保存操作を行うまでメモリ上に保持します。

- 分割 ZIP は一度に保持する量を抑えるための仕組みです
- 保存リンクを押すと送信側へ保存 ACK を返します
- Blob URL は保存操作から約2分後に revoke します
- 保存直後は前後パートのメモリ保持が短時間重なる可能性があります

将来的な大容量対応では File System Access API / WritableStream 等を利用した direct-to-disk を検討対象としています。

## 接続診断

画面の「接続診断」は、ブラウザの `RTCPeerConnection.getStats()` から選択済みICE経路をローカルに読み取ります。

- `P2P direct`: 選択中のcandidate pairがrelayではない
- `TURN relay`: 少なくとも片側がrelay candidate
- RTT、ブラウザ推定送信帯域、candidate type、SCTP `maxMessageSize`、DataChannel `bufferedAmount` を可能な範囲で表示
- UIにはcandidate IP addressを表示しない

診断値はLemonのアプリケーションサーバーへ送信しません。`window.LemonDiagnostics.snapshot()` は開発者向けのローカルAPIで、ブラウザが公開する場合はaddress/portを含み得ます。

`?debug=1` で開くと従来の `window.__p2p` も利用できます。

```js
__p2p.state()
await __p2p.stats()
__p2p.sendEntries(...)
```

LAN 内 P2P の速度問題を調べる際、**インターネット回線の上り速度だけを基準にしないでください**。Wi-Fi 帯域、電波状況、端末ストレージ、ブラウザのバックグラウンド制限、ICE 経路などを切り分ける必要があります。

## テスト

Node.js 18 以上で、外部パッケージなしに実行できます。

```bash
npm test
```

現在のスモークテストは次を確認します。

- CRC32 の既知ベクトル
- ZIP traversal / absolute path の拒否
- メタデータ境界検査
- サイズ・CRC 終了検証
- ZIP local / central header の flag 一致
- 分割ロジック
- 128-bit pairing secretのcanonical base64url表現
- 接続コード・fragment URL・legacy queryの解析
- DTLS fingerprint channel bindingの順序不変性
- responder / initiator transcriptのrole separation
- `auth.js` / `pairing-ui.js` / `diagnostics.js` / `app.js` の構文
- `index.html` のセキュリティ層を含むリソース読込順
- PeerJS / QR の完全なバージョンURLとSHA-512 SRI
- 予期しないリモートスクリプトが存在しないこと
- CSPに必要なディレクティブがあり、`unsafe-inline` / `unsafe-eval` を許可していないこと
- pairing URLを読み取り後にscrubする実装が残っていること
- 診断コードが主要なWebRTC統計を扱うこと

## 外部依存と注意

- Peer ID の発行と相手発見には PeerJS の公開シグナリングサービスを利用します
- NAT やファイアウォール条件によっては WebRTC の接続自体が成立しない場合があります
- ファイル受信は常に明示承認制です（分割転送の後続パートのみ、最初の承認後に同じ `splitId` として自動受信します）
- SRI+CSPはCDN改ざんリスクを狭めますが、CDN依存やPeerJS公開シグナリングへの可用性依存は残ります
- 接続コードが漏れた場合、そのcapabilityを持つ相手を区別できません
- エンドポイントのOS・ブラウザ・拡張機能が侵害されている場合は保護できません

## 今後の候補

1. File System Access API / WritableStream による direct-to-disk 受信
2. capability handshake によるSCTP上限に応じたチャンクサイズ・保存方式の交渉
3. PeerJS / QR ライブラリを vendoring して実行コードを完全自己完結化
4. ブラウザ横断・端末横断の接続/転送 integration test 拡充
5. 必要に応じて self-hosted PeerServer や長期公開鍵identityを別モードとして検討
