# Lemon — P2P ファイル転送

ブラウザだけで動く、マルチプラットフォームな P2P ファイル送受アプリです。
[PeerJS](https://peerjs.com/) / WebRTC DataChannel を使い、接続後の転送は端末間で行います。

## 現在の設計方針

Lemon は機能追加だけでなく、転送プロトコルと実行コードの信頼境界を段階的に固めています。

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

### v1.2 — supply-chain hardening

- PeerJS を 1.5.5 に固定
- qrcode-generator を 1.4.4 に固定
- 両方のリモートスクリプトに SHA-512 Subresource Integrity (SRI) を設定
- CDN を cdnjs の1系統に集約し、`crossorigin="anonymous"` / `referrerpolicy="no-referrer"` を設定
- Content Security Policy (CSP) で実行元・接続先・オブジェクト・フォーム等を制限
- インライン CSS を `styles.css` に分離し、`style-src 'self'` として `unsafe-inline` を不要化
- CI が予期しない外部スクリプト、SRI変更、`unsafe-inline` / `unsafe-eval` を検出
- `SECURITY.md` に現在の脅威モデルと非保証事項を明記
- `THIRD_PARTY_NOTICES.md` に依存バージョン・URL・SRI・ライセンスを固定記録

SRI+CSP は、第三者 CDN スクリプトを無制限に信用していた状態からの大きな改善です。最終的には PeerJS / QR ライブラリそのものを vendoring し、実行コードを完全自己完結にすることを目標としています。

## ファイル構成

```text
index.html                 UI / エントリポイント / CSP
styles.css                 UI スタイル
app.js                     PeerJS、送受信状態、UI、転送キュー
core.js                    CRC32、ZIP、パス・メタデータ検証
SECURITY.md                脅威モデル・信頼境界・非保証事項
THIRD_PARTY_NOTICES.md     外部依存の固定情報
package.json               ゼロ依存のテストコマンド
tests/smoke.cjs            コア・構文・CSP/SRIスモークテスト
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
2. 片方の「自分のコード」をもう片方に入力して「接続」
3. ファイルまたはフォルダをドラッグ＆ドロップ、またはボタンで選択
4. 相手側で「受け取る」を押す
5. サイズと CRC32 の確認が通ると「完了・整合性確認済み」になり、保存できます

### ZIP と大量転送

- 2つ以上のファイル・フォルダは、既定で1つの無圧縮 ZIP（STORE）として送ります
- ZIP は送信しながら CRC32 を計算し、data descriptor を書くため、各ソースファイルの読み出しは1回です
- フォルダ階層と UTF-8 ファイル名を保持します
- 合計が 1 GiB を超える複数ファイル転送は、概ね 1 GiB 以下の独立した ZIP パートに分割します
- 各パートは単体で正当な ZIP です
- 最初のパートを承認すると、同じ `splitId` の後続パートは自動受信します
- 次パートは受信側が現在パートの「ファイルを保存」を押したことを確認してから送ります
- 1ファイルそのものが 1 GiB を超える場合、そのファイルを途中分割する機能はまだありません

ZIP を無効にした場合、単独ファイルはそのまま送信され、フォルダはファイル単位で受信・保存します。

## 転送と整合性

WebRTC DataChannel 自体は DTLS で暗号化されます。それに加え、アプリ層で各ファイルについて次を検証します。

- `meta.size` を超えてデータが到着していないこと
- `end` 到着時の受信バイト数が申告サイズと一致すること
- 現行版同士では送信側と受信側の CRC32 が一致すること
- フォルダ転送ではファイル数と合計サイズも一致すること

CRC32 は **転送破損や状態ずれを検出するための整合性チェック** であり、暗号学的な署名や相手認証ではありません。

## 接続コードと QR

「自分のコード」の下に QR コードが表示されます。

- HTTP/HTTPS で開いている場合、QR は `?peer=コード` を含む接続 URL になります
- `file://` で直接開いている場合、QR はコード共有用で、相手側では手入力が必要です
- `?peer=コード` を URL に付けると、自動入力して接続を開始します

Peer ID は10文字のランダム部を持ち、初版より大幅に推測しにくくなっています。しかし、**Peer ID 自体を独立した強い相手認証とはみなしません**。現在の次のセキュリティ作業は、QR/共有コードへ独立した128-bit pairing secretを追加し、DataChannel確立後に照合することです。

## 実行コードの信頼境界

現在ブラウザで実行される第三者コードは2つだけです。

- PeerJS 1.5.5
- qrcode-generator 1.4.4

どちらも cdnjs の完全なバージョン URLを使い、SHA-512 SRI が一致しない場合はブラウザが実行を拒否します。さらにCSPがスクリプト元を同一オリジンとcdnjsへ制限します。

`THIRD_PARTY_NOTICES.md` に正確な URL / SRI / ライセンスを記録しています。詳細な脅威モデルは `SECURITY.md` を参照してください。

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
- 通常の単独ファイル転送を途中バイト位置から再開する機能はまだありません

画面消灯・長時間バックグラウンド化は OS / ブラウザによって強制停止される場合があります。大量転送では画面を表示したままにするのが最も確実です。

## メモリ使用量

現在の受信側は、受け取ったチャンクを `Blob` にまとめ、ユーザーが保存操作を行うまでメモリ上に保持します。

- 分割 ZIP は一度に保持する量を抑えるための仕組みです
- 保存リンクを押すと送信側へ保存 ACK を返します
- Blob URL は保存操作から約2分後に revoke します
- したがって保存直後は前後パートのメモリ保持が短時間重なる可能性があります

将来的な大容量対応では File System Access API / WritableStream 等を利用した direct-to-disk を検討対象としています。

## 診断

`?debug=1` で開くと `window.__p2p` を公開します。

```js
__p2p.state()       // 接続、remote protocol version、受信状態、pending accept など
await __p2p.stats() // PeerJS が RTCPeerConnection を公開している場合の候補/transport統計
__p2p.sendEntries(...)
```

転送速度表示は WebRTC 上の実送信/受信量を経過時間で割った値です。LAN 内 P2P の速度問題を調べる際、**インターネット回線の上り速度だけを基準にしないでください**。Wi-Fi 帯域、電波状況、端末ストレージ、ブラウザのバックグラウンド制限、ICE 経路などを切り分ける必要があります。

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
- `app.js` の JavaScript 構文
- `index.html` のリソース読込順
- PeerJS / QR の完全なバージョンURLとSHA-512 SRI
- 予期しないリモートスクリプトが存在しないこと
- CSPに必要なディレクティブがあること
- CSPが `unsafe-inline` / `unsafe-eval` を許可していないこと
- inline `<style>` が再導入されていないこと

## 外部依存と注意

- Peer ID の発行と相手発見には PeerJS の公開シグナリングサービスを利用します
- NAT やファイアウォール条件によっては WebRTC の接続自体が成立しない場合があります
- ファイル受信は常に明示承認制です（分割転送の後続パートのみ、最初の承認後に同じ `splitId` として自動受信します）
- SRI+CSPはCDN改ざんリスクを大幅に狭めますが、CDN依存そのものやPeerJS公開シグナリングへの可用性依存を消すものではありません
- エンドポイントのOS・ブラウザ・拡張機能が侵害されている場合は保護できません

## 今後の候補

1. 独立した128-bit pairing secretをQR/共有コードへ追加し、DataChannel上で認証
2. PeerJS / QR ライブラリを vendoring して実行コードを完全自己完結化
3. File System Access API による direct-to-disk 受信
4. capability handshake によるチャンクサイズ・保存方式の交渉
5. ブラウザ横断の実機テスト拡充
