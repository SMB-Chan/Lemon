# Lemon — P2P ファイル転送

ブラウザだけで動く、マルチプラットフォームな P2P ファイル送受アプリです。PeerJS / WebRTC DataChannel を使い、接続後のファイル転送は端末間で行います。

## 現在の設計

Lemon は「機能を増やす」だけでなく、転送プロトコル・相手認証・実行コードの信頼境界を段階的に固めています。

### v1.1 — protocol hardening

- 同じ相手への送信を接続単位のキューで直列化
- 受信メタデータ、ID、ファイル数、サイズ、パスを境界で検証
- 申告サイズを超えるデータは即時拒否
- 終了時に実受信サイズと CRC32 を照合
- ZIP traversal / absolute path / 制御文字を拒否
- ZIP local header / central directory の flag を一致
- ZIP を data descriptor 方式の **single-pass** に変更し、CRC事前読みを廃止
- 分割転送は受信側の保存ACKが取れない限り次パートへ進まない
- DOM/UI と ZIP・検証ロジックを `app.js` / `core.js` に分離

### v1.2a — supply-chain hardening

- PeerJS 1.5.5 と qrcode-generator 1.4.4 を完全なバージョンURLへ固定
- 両リモートスクリプトへ SHA-512 Subresource Integrity (SRI) を設定
- CDNをcdnjsへ集約し、anonymous CORS / no-referrer を設定
- Content Security Policy (CSP) を導入
- インラインCSSを `styles.css` へ分離し、`unsafe-inline` を不要化
- CIが外部スクリプト増加・SRI変更・危険なCSP回帰を検出
- `SECURITY.md` / `THIRD_PARTY_NOTICES.md` で信頼境界を明示

### v1.2b — authenticated pairing

PeerJS IDだけを相手認証として扱わず、各ページセッションに独立した **128-bit pairing secret** を生成します。

表示されるペアリングコードは次の形です。

```text
<peer-id>~<128-bit secret (base64url)>
```

接続後、ファイル転送プロトコルを開始する前に以下を行います。

1. 128-bit nonce を使った challenge-response
2. pairing secret を鍵とする HMAC-SHA-256
3. initiator / responder の role separation
4. Peer ID と両nonceをHMAC transcriptへ包含
5. **実際の WebRTC DTLS certificate fingerprint pair を transcript へ包含**
6. 認証成功までアプリ層では `connection.open === false`
7. 認証前の通常データ受信・送信を拒否

これにより、単に同じsecretを知っていることだけでなく、その証明を現在のDTLS接続へ束縛します。詳細は [`PAIRING_PROTOCOL.md`](PAIRING_PROTOCOL.md) と [`SECURITY.md`](SECURITY.md) を参照してください。

> pairing code は現在ページの bearer credential です。相手に共有したコードを第三者が取得すれば、その第三者も認証を試行できます。ページ再読み込みでsecretは更新されます。

## QRとURL

HTTP/HTTPSで生成するQRは、secretをクエリ文字列ではなくURLフラグメントへ置きます。

```text
https://host/path/#peer=<encoded pairing code>
```

URLフラグメントはHTTPリクエストへ含まれないため、新しいLemonが生成するQRでは pairing secret をWebサーバーへ送信しません。読み取り後はフラグメントを表示URLから削除します。

旧 `?peer=` 形式に秘密付きコードが入っていた場合は読み取って移行できますが、新規QRでは使用しません。plain PeerJS IDだけの新規接続は認証されません。

## ファイル構成

```text
index.html                 UI / エントリポイント / CSP
styles.css                 UIスタイル
pairing-core.js            secret / nonce / HMAC / DTLS fingerprint canonicalization
pairing.js                 PeerJS DataConnection の認証ゲート
app.js                     PeerJS利用・送受信状態・UI・転送キュー
core.js                    CRC32・ZIP・パス/メタデータ検証
PAIRING_PROTOCOL.md        pairing protocol仕様
SECURITY.md                脅威モデル・保証範囲・非保証事項
THIRD_PARTY_NOTICES.md     外部依存の固定情報
package.json               テストコマンド
tests/smoke.cjs            転送・CSP/SRI・読み込み順テスト
tests/pairing.cjs          pairing core + fake PeerJS/DataChannel シミュレーション
```

## 動かし方

`index.html` をブラウザで開けます。同一LANの別端末から使う場合は静的HTTPサーバーが便利です。

```bash
python3 -m http.server 8000
# http://<このPCのIP>:8000/
```

Chrome / Edge / Firefox / Safari のPC・スマートフォンを想定しています。ただし authenticated pairing は `RTCPeerConnection` の local/remote SDP fingerprint取得へ依存するため、Node.jsシミュレーションだけでなく実ブラウザ横断テストも必要です。fingerprintを取得できない場合は安全側に倒して認証を拒否します。

## 使い方

1. 両端末でLemonを開く
2. 片方の「自分のペアリングコード」またはQRを相手へ共有
3. 相手側でコード入力またはQRから開く
4. LemonがHMAC + DTLS channel binding認証を完了
5. ファイルまたはフォルダを選択
6. 受信側が「受け取る」を承認
7. 受信サイズとCRC32の確認後に保存

## ZIPと大量転送

- 2つ以上のファイル/フォルダは既定で1つの無圧縮ZIP (STORE)
- ZIPは送信しながらCRC32を計算するsingle-pass方式
- UTF-8ファイル名とフォルダ階層を保持
- 合計1 GiB超の複数ファイルは概ね1 GiB以下の独立ZIPパートへ分割
- 各パートは単体で正当なZIP
- 最初のパート承認後、同じ `splitId` の後続パートを自動受信
- 次パートは現在パートの保存ACK確認後に送信
- 単一ファイルそのものの途中分割は未実装

## 転送整合性

WebRTC DataChannelはDTLSで暗号化されます。さらにLemonはアプリ層で以下を確認します。

- 受信量が `meta.size` を超えていない
- `end` 到着時の実バイト数が申告値と一致
- 現行版同士でCRC32が一致
- フォルダではファイル数・合計サイズも一致

CRC32は転送破損/状態ずれ検出用です。暗号学的署名や送信者認証ではありません。送信相手の認証はpairing層が担当します。

## 再接続

分割転送中に接続が落ちた場合、相手のpairing secretを現在ページのJavaScriptメモリ内に保持しているため、同じpeer IDへの自動再接続時にも新しいWebRTC接続上で再度pairing認証を行えます。ページを再読み込みするとこのキャッシュは消えます。

- 分割ZIPは失敗パートを最大5回再試行
- 通常ファイルの途中byte offsetからのresumeは未実装
- Screen Wake Lock / 無音AudioContextをモバイルのバックグラウンド抑制に対するベストエフォートとして使用

## メモリ使用量

現在の受信側は受信チャンクをメモリ上に保持し、Blobとして保存リンクを作ります。このため非常に大きい単一ファイルではメモリ使用量が問題になります。

次の大きな性能/スケーラビリティ改善候補は **File System Access API / WritableStream を使った direct-to-disk** です。

## 実行コードの信頼境界

第三者実行コードは現時点で以下の2つです。

- PeerJS 1.5.5
- qrcode-generator 1.4.4

どちらもcdnjsの完全なバージョンURL + SHA-512 SRIで固定されています。CSPはスクリプト元を同一オリジンとcdnjsへ、接続先を同一オリジンとPeerJS signaling endpointへ制限します。

長期的には依存ライブラリをvendoringして、実行コード自体を完全自己完結にする方針です。

## テスト

Node.js 18以上で外部npm依存なしに実行できます。

```bash
npm test
```

テスト対象には以下が含まれます。

- CRC32既知ベクトル
- ZIP path hardening
- メタデータ/サイズ/CRC終了検証
- ZIP header flag / partitioning
- CSP / SRI / 外部script数 / 読み込み順
- pairing code format
- HMAC determinism / role separation
- secret変更時のproof変化
- DTLS fingerprint binding変更時のproof変化
- local/remote fingerprint順序反転時のcanonicalization一致
- fake PeerJS/DataChannelでの正しいsecretによる認証成功
- wrong secretがアプリ層 `open` に到達しないこと

## 診断

`?debug=1` で既存の `window.__p2p` 診断APIを有効化できます。

```js
__p2p.state()
await __p2p.stats()
__p2p.sendEntries(...)
```

`stats()` はPeerJSが `RTCPeerConnection` を公開している場合にcandidate/transport情報を返します。

## 注意

- PeerJS公開signaling serviceは依然として可用性・メタデータ上の依存先です
- pairing codeを知る相手は現在セッションのbearer credentialを持ちます。共有先を限定してください
- pairing secretは新規QRではURL fragmentへ置きますが、ブラウザ拡張・ローカルマルウェア・画面撮影・clipboard監視からは保護できません
- NAT / firewall条件によってWebRTC接続自体が成立しない場合があります
- authenticated pairingは持続的なユーザーアカウント/公開鍵IDを提供するものではありません
- ファイル受信は最初のパートについて明示承認制です。分割転送の後続パートのみ同じ `splitId` として自動受信します

## 次の候補

1. 実ブラウザ横断のauthenticated pairingテスト拡充
2. PeerJS / QRライブラリのvendoring
3. direct-to-disk受信
4. capability handshakeによるchunk size /保存方式の交渉
5. 必要に応じたself-hosted PeerServer対応
