# 公開 Pricing Gateway HTTP v1

実装: `src/gateway/`。初期設定: `wrangler.gateway.jsonc`。本番運用設定: `wrangler.gateway.production.jsonc`。
**実装・ローカル検証用の契約であり、デプロイ済み・本番動作確認済みという意味ではありません。**
本番Gateway URL、Sheet本番Origin、Pricing稼働Version/commit、migration適用状態は未確認です。

## 境界

```text
browser / HTTP client → pc-parts-pricing-gateway
                         └ PRICING (default entrypoint RPC) → pc-parts-pricing
                                                            ├ D1 summary
                                                            └ waitUntil → existing Queue → Catalog / Provider
```

Gatewayは公開HTTP、入力/CORS/受付保護、RPC結果のHTTP変換だけを担当します。
Pricing本体のfetchは404のみ、`workers_dev:false` / `preview_urls:false` / routeなしを維持します。
Gatewayには通常の`PRICING`と4つのRate Limiting bindingだけを渡します。
`PricingAdmin`、`PricingBatch`、D1、Queue、Cron、Catalog binding、Yahoo Secretはありません。
任意RPC proxy、`requestRefresh`、管理操作、店舗別Offerは公開しません。

## Request

`POST /v1/prices/summary`。query parameterは一切許可しません。
`Content-Type: application/json`（任意で`charset=utf-8`）を要求します。

```json
{"products":[{"source":"buildcores","upstream_key":"CPU/test-fixture"}]}
```

このrefと以下の価格/日時は**テスト用架空データ**です。本番へ送信しないでください。

- products: **1〜100件**。重複排除前に件数を検証。入力順・重複をそのままRPCへ渡し、返却でも保持します。
- refは`source`, `upstream_key`の2 fieldだけ。top-levelは`products`だけ。未知fieldを拒否します。
- source: 1〜64 ASCII文字、`^[a-z][a-z0-9_-]{0,63}$`。
- upstream_key: 最大200 ASCII文字、`^[-A-Za-z0-9_]+/[-A-Za-z0-9_.]+$`、key単独の`.` / `..`は禁止。
  実装はPricingの`validateProducts()`を再利用し、正規表現を複製しません。
- numeric product ID、製品名、JAN/EAN、任意URLは不可。trim・型変換による修復はしません。
- bodyは**65,536 bytes以下**。Content-Lengthの早期確認と実stream読取バイト数の両方で制限。
  headerなし・過小申告でも保護。不正JSON、不正UTF-8、空配列は400。
  最大長合法100件は約30KBで受付可能（テストでも確認）。
- 100件は公開HTTP専用上限。Pricingの内部chunkや大件数RPC・管理操作に制限を持ち込みません。

## Response / 状態

正常にsummaryを返せればpendingを含めて**HTTP 200**です。

```json
{
  "ok": true,
  "data": [{
    "source": "buildcores", "upstream_key": "CPU/test-fixture",
    "providers": { "yahoo": {
      "provider": "yahoo", "status": "complete", "lowest_price": 57800, "offer_count": 12,
      "fetched_at": "2026-09-26T00:00:00.000Z", "expires_at": "2026-09-26T06:00:00.000Z", "stale": false
    } }
  }]
}
```

|status|lowest_price|offer_count|fetched_at|意味|
|---|---|---|---|---|
|complete|正整数JPY|正整数|Provider取得時刻|正常な価格summary|
|empty|null|0|Provider取得時刻|正常検索で一致Offerが0件|
|unsupported|null|0|null|安全なidentifierなし。閲覧時は再検索しない|
|pending|null|**null**|null|未取得、または表示可能な期間を超えた結果|
|missing|null|0|null|Catalogで不存在/inactiveを確認済み|

日時はISO 8601。`expires_at`はpendingだけnullまたは過去の日時を含む文字列、他状態は文字列です。
件数はPricingが採用したOffer数（最大50）で、全店舗・全出品の総件数ではありません。
`stale`は古い確定結果があることを示します。pendingでもtrue/過去のexpiryがあり、unsupportedでもtrueになり得ます。
staleは「更新実行中」の保証ではありません。Gatewayは鮮度を再計算せず、取得日時を応答時刻へ上書きせず、価格cacheを追加しません。

Gatewayは`getPriceSummaries(products)`を**1回呼び、RPC結果をawait**します。
未登録refは本体がD1へ永続登録してからpendingを返します。**単純な読取専用APIではありません。**
既存行のtouch/必要な更新要求は本体の非同期処理に任せます。Provider検索やQueue完了は待ちません。
200は「Queue投入完了」「現在処理中」「所定時刻までに更新完了」を保証しません。
D1読取・未登録refの登録失敗は503であり、pending/empty/0円に偽装しません。
RPC envelope、件数、入力refとの位置対応、公開field型・既存nullabilityが不正なら503。
余分な下流fieldは公開せず、既存状態のstale/expiryの組合せで独自に拒否しません。
RPC自動retryや独自timeoutはありません。切断しても下流処理が取り消されるとは限らず、即時再送は避けてください。

### 後続Sheetの利用指針

- 一覧20件は1 bulk。必要なrefreshは通常のsummary取得だけで要求されるので、毎回`requestRefresh`を追加する必要はありません。
- pendingやstaleの再確認は**有限polling**（例: 10〜30秒間隔、最大6回、その後手動再確認）。画面離脱時は停止。
  大きいbatchは別枠で制限されるため、100件を10秒間隔でpollingしないでください。
- unsupported/missingはstaleだけを理由に無限pollingしない。予算・backoff・leaseにより価格更新の完了時刻は保証されません。
- 429では少なくともRetry-After待機し、503でも即時連打せず回数を制限。再送で前回の処理が取り消されるわけではありません。
- 店舗別Offerは返りません。既存店舗比較APIは別途移行が必要です。
- 市場summaryの非同期更新で、構成に保存済み・手入力済みの価格を自動上書きしないでください。
- 共有fixture: [`test/fixtures/gateway-http.json`](../test/fixtures/gateway-http.json)。各named caseがHTTP JSON bodyです。
  fresh/stale complete、empty/stale empty、pending/stale pending、unsupported/stale unsupported、missing、429、503を収録。
  架空データであり本番データ・実測結果ではありません。429/503時は以下のheader契約も参照してください。

## Error / 共通header

```json
{"ok":false,"error":{"code":"PRICING_UNAVAILABLE"}}
```

|HTTP|固定code|条件|
|---:|---|---|
|400|INVALID_REQUEST|JSON/UTF-8/ref/件数/query/preflight不正、RPC INVALID_REQUEST|
|403|ORIGIN_NOT_ALLOWED|不許可Origin、Origin:null|
|404|NOT_FOUND|未知path|
|405|METHOD_NOT_ALLOWED|POST/OPTIONS以外。`Allow: POST, OPTIONS`|
|413|BODY_TOO_LARGE|body上限超過|
|415|UNSUPPORTED_MEDIA_TYPE|Content-Typeなし/不許可|
|429|RATE_LIMITED|いずれかのlimiterが拒否。`Retry-After: 60`|
|503|PRICING_UNAVAILABLE|停止/設定不備/binding不備、limiter障害、RPC障害/不正応答|

成功・失敗とも`Cache-Control: no-store`, `X-Request-ID: <Gateway生成UUID>`, `Vary: Origin`。
例外本文・stack・SQL・内部URL・Secretは返しません。複数の不正がある要求では、Origin/route/config/limiter等の先行検証エラーになり得ます。
Retry-Afterは60秒の保守的な待機指示で、厳密なcounter reset時刻ではありません。

## CORS / 接続設定

`ALLOWED_ORIGINS`はJSON文字列配列を格納した環境変数。scheme/host/portの**完全一致**、path/trailing slash/`null`/wildcardは不可。
許可Originへのエラーも`Access-Control-Allow-Origin`を付け、`Retry-After, X-Request-ID`をexposeします。
Cookie、credentials、ブラウザ埋込共有Secretは不要です。OriginなしのHTTP clientも同じ受付制限・入力検証に従います。
不許可OriginはRPC前に403。CORSは認証でも濫用防止でもなく、非ブラウザ要求はOriginを付けないこともできます。

OPTIONSは同じpath/query検証、許可Origin、`Access-Control-Request-Method: POST`、要求headerは`Content-Type`だけ（指定なしも可）。
正常204、Pricing RPC/D1/Queue/limiterは呼びません。停止中も正常preflightは204、POSTは503です。
preflight応答は`Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`。

### 設定の役割と変更方法

|ファイル|役割|
|---|---|
|`wrangler.gateway.jsonc`|安全な初期設定。`ALLOWED_ORIGINS="[]"`, `SUMMARY_ENABLED="false"`を常に維持。初期dry-run・ローカルdriverの基礎設定|
|`wrangler.gateway.production.jsonc`|本番運用値の正。build/deployが明示指定。許可Origin・受付フラグ・縮小したlimiter上限はここで管理|

両方ともWorker名は`pc-parts-pricing-gateway`、`PRICING → pc-parts-pricing` default entrypointです。
`--env`やWorker名suffixを使いません。namespaceも既存の4値を維持し、新Worker/環境/クラウドリソースは追加しません。
**今回、本番用設定もOrigin未設定・受付停止のまま**です。本番OriginやURLを推測して埋めません。

本番有効化は`wrangler.gateway.production.jsonc`の`vars`を編集します。
`ALLOWED_ORIGINS`は確定したSheetのHTTPS Originを格納した**JSON配列の文字列**、`SUMMARY_ENABLED`は文字列の`"true"`にします。
架空のOriginは`test/gateway-config.test.ts`内だけで使い、本番ファイルへ転記しません。
有効化中の空配列は設定忘れとして拒否します。停止中は空配列・既存の正常な許可Origin配列のどちらでも構いません。
wildcard、`null`、credentials/path/query/fragment付きURL、HTTP、localhost（サブドメイン含む）、IPv4/IPv6 loopback等は本番検証で拒否します。
Originなしclientの実行時契約は変更しません。この非空検査はブラウザ向け本番設定の要件です。

`scripts/gateway-config.ts`の共通検証をテストと`validate:gateway` CLIが使います。
両設定でWorker/entrypoint、通常PRICINGのみ、Version URL無効、D1/Queue/Cron/Catalog/Secret/管理bindingなし、
limiter名と固定namespaceの対応・重複なし、flag/Originの形式、limit/periodを検証します。
停止値の完全一致は**初期設定だけ**。本番の正常な有効化・Origin変更・レート縮小は検証に通ります。
設定を編集したら`npm run check`と両Gateway dry-runを実行し、CI成功後、別途承認を得て反映してください。
CLIの`--var` / `--config` / `--env`による設定上書きはこの手順では使いません。検証対象ファイルを正として管理します。
Dashboardで変えた値も次回deployで本番用設定の値に上書きされます。一時停止を含め、repo側へ同期してください。

localhostのHTTP許可は後述のローカルdriverだけに設定します。本番設定へ自動追加されません。

## 公開負荷保護

Cloudflare現行[Rate Limiting binding公式仕様](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)を2026-10-25確認。
Wrangler >=4.36.0が必要で、本repoの4.141.0の`ratelimits` schema / dry-runとMiniflareの実bindingで対応を確認しています。

|binding|初期limit / 60秒（安全ガード上限）|適用|専用namespace_id|
|---|---:|---|---|
|CLIENT_LIMITER|12|全POST、clientごと|2026102501|
|GLOBAL_LIMITER|60|全POST、共有key|2026102502|
|LARGE_CLIENT_LIMITER|2|21〜100件、clientごと、通常枠も消費|2026102503|
|LARGE_GLOBAL_LIMITER|6|21〜100件、共有key、通常枠も消費|2026102504|

1要求あたり2〜4回のbinding呼出し（拒否時は短絡）、製品ごとには呼びません。
通常枠はbodyを読む前に適用し、不正bodyも枠を使います。全必須bindingは小batchでも存在検査。
欠落・例外・`success`がbooleanでない不正結果はfail closedの503、拒否は429、どちらもRPCを呼びません。
設定不備で無保護起動しません。`SUMMARY_ENABLED`は厳密な`"true"`だけ受付し、false/欠落/不正値は503。

本番ファイルの各`ratelimits[].simple.limit`は**1〜各初期値**の安全な整数へ変更可能です。
12/60/2/6への完全一致は要求せず、初期値は別の安全ガード上限として`LIMITER_POLICY`で管理します。
初期値を超える拡大には別途予算・保護ポリシーのレビューが必要です。今回の値の引上げはありません。
periodは両設定とも60秒固定で、実行時の`Retry-After:60`と共通検証で照合します。
縮小後は通常一覧のpollingも429になりやすくなるため、想定利用量を確認してください。

初期設定は通常20件一覧の10〜30秒間隔polling（2〜6要求/分）に余裕を持たせ、最大batchを追加制限しています。
**初期設定における名目値**はclientあたり`10×20 + 2×100 = 400 ref/分`、共有枠`54×20 + 6×100 = 1680 ref/分/拠点`。
変更後は、通常枠をN、大batch追加枠をLとして、`20×N + 80×min(N,L)`でclient/共有それぞれの名目最大ref流量を再計算します。
例: 共有通常枠30・大batch枠3なら`20×30 + 80×3 = 840 ref/分/拠点`。1680が縮小後も固定されるわけではありません。
これは重複込みの受付件数による概算で、D1 write件数・Provider検索数ではありません。
すべて100件なら初期設定の共有枠は6要求=600 ref/分です。Provider/Queue側の予算・backoffは変更しません。

client keyはCloudflareの`CF-Connecting-IP`をSHA-256 hash化し、`X-Forwarded-For`や任意client IDは信用しません。
edge identityがないローカル等では匿名共有bucketに集約し、無制限にしません。hashもログへ出しません。
認証基盤がないためIP単位の近似client制限です。公式が推奨する安定user IDと違いNAT等で利用者が枠を共有する制約があります。
公開Cloudflare edgeの付与headerを前提とし、同一zoneの他Workerからのsubrequest等で信頼境界を変える際はidentityを再設計してください。

namespaceはCatalog等と分離するためこのGateway専用の4値を選択しました。反映前にaccountの他Workerと非衝突を確認してください。
同一accountで同じnamespace/keyを使うとcounterを共有します。ローカルcounterは本番から独立です。

**適用範囲・残存リスク:** ネイティブlimiterはCloudflare拠点ごと、非同期同期による近似値で、設定値を超えることがあります。
共有keyでも全世界共通の厳密な日次/分次予算にはなりません。分散濫用、IP変更、無料枠超過を完全には防止できません。
任意の形式適合refは未登録ならD1 writeを起こし、Provider/Queue予算だけでは大量登録を防げません。
1拠点の名目共有枠でも連続悪用時は日次Free D1枠を超え得るため、利用量監視・早期縮小/停止が必要です。
この対策専用の新DB/DOは追加していません。

## ローカル開発（完全offline）

Node24以上、`npm ci`後、次の**いずれか一方**を起動します。

```sh
npm run dev:gateway
# 別の状態を固定して確認（テストfixture名）
npm run dev:gateway -- --fixture stale-complete
# または、本体との実Service Binding RPC + ローカルD1/Queue
npm run dev:gateway:rpc
```

|構成|Worker名|binding / port|
|---|---|---|
|公開側（どちらのmodeも実Gateway）|pc-parts-pricing-gateway|HTTP `127.0.0.1:8788`、`PRICING → pc-parts-pricing`|
|mock mode|pc-parts-pricing（test-only RPC stub）|Miniflare内だけ、HTTP公開portなし|
|実RPC mode|pc-parts-pricing（実本体）|Miniflare内だけ、HTTP公開portなし、`PRICING_BATCH → 同名PricingBatch`|

driverは**初期設定ファイルだけを読み、停止状態を共通検証したうえで**Miniflare/workerdを一括起動し、memory内で`SUMMARY_ENABLED=true`、許可Originを
`http://localhost:5173`, `http://127.0.0.1:5173`に限定します。実native limiterも有効です。
本番設定のOrigin/flag/limitを編集してもdriverへ取り込みません。remote接続先へ切り替わりません。
レート動作テストは初期設定から読み込んだclient limitを使用し、「13回目」などの回数へ固定しません。
mock modeはRPC返却値だけfixtureを使用。実RPC modeは本物のPricing/D1/Queue、Catalog/Provider境界だけmock。
初回はpending、後続はmock Providerのcompleteを確認できます（即時完了や完了時刻は保証しません）。
実Yahoo/App ID、Catalog起動、`.dev.vars`、remote bindingは不要で、外部通信は拒否/ローカルmockに閉じます。
D1はmemory内に既存0001〜0003を適用します。既存`.wrangler/state`や本番データを変更しません。
driver/fixtureは`src/gateway/worker.ts`からimportせず、本番bundleへ含めません。

HTTP client例（**このURLはlocal専用**、架空ref）:

```sh
curl -i http://127.0.0.1:8788/v1/prices/summary -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' --data '{"products":[{"source":"buildcores","upstream_key":"CPU/test-fixture"}]}'
```

Windows PowerShellでは`Invoke-WebRequest -Uri http://127.0.0.1:8788/v1/prices/summary -Method Post -ContentType application/json -Body (Get-Content test/fixtures/gateway-request.json -Raw)`も使用できます。
preflightは同URLへ`OPTIONS`とOrigin / Access-Control-Request-Method / Access-Control-Request-Headersを送って確認します。
**停止は起動terminalでCtrl+C**（SIGINT/SIGTERMでMiniflareをdispose）。再起動でmemory DB/counterは消えます。
port 8788競合時は他のdriverを止めてください。本体単独の`npm run dev`は従来どおりWrangler（通常8787、fetch404）です。

## コマンド / 検証

|コマンド|対象|
|---|---|
|npm run typecheck|本体・Gateway・テスト・local driverすべて|
|npm test / npm run check|offline全テスト / 型検査＋全テスト|
|npm run build|本体deploy dry-run（既存対象を維持）|
|npm run validate:gateway|初期・本番両ファイルのoffline共通検証|
|npm run build:gateway|両設定の検証後、`--config wrangler.gateway.production.jsonc`のdeploy dry-run、dist/gatewayへ出力|
|npm run build:gateway:initial|両設定の検証後、`--config wrangler.gateway.jsonc`のdeploy dry-run、dist/gateway-initialへ出力|
|npm run deploy|本体の実deploy（明示承認後のみ）|
|npm run deploy:gateway|両設定の検証後、`--config wrangler.gateway.production.jsonc`の実deploy（明示承認後のみ）|

Gateway build/deploy入口は`npm run validate:gateway && wrangler ...`で、検証失敗ならWranglerへ進みません。
CIは`check`, 本体`build`, 本番`build:gateway`, 初期`build:gateway:initial`を実行します。
`test/gateway-config.test.ts`は実際の共通検証へ変更した設定オブジェクト/JSONC一時ファイルを渡し、
架空HTTPS Originでの有効化・Origin変更・limit縮小、危険設定拒否、CLI失敗時に**mock deploy**へ進まないことを検証します。
`test/gateway.test.ts`は実初期設定のPOSTが503でRPCを呼ばないことを検証します。
HTTP mock testsは入力/UTF-8/stream size/CORS/limiter/RPC障害/fixture透過を検証。
`test/runtime.test.ts`は実Gateway HTTP→Service Binding→Pricing→D1/Queueと、Provider待機、永続登録、重複投入抑制、障害を検証し、既存601件RPCも維持。
`test/gateway-local.test.ts`は両driverの起動/終了と実native limiterの429を検証します。テストは必ずdisposeし、Provider待機も解除します。

## 本番反映 / 停止 / 監視

[Gateway運用手順](operations.md#gateway反映停止監視)を参照。公開先はworkers.devを有効にした別Workerで、Version URLは無効です。
実URLはdeploy出力/Cloudflare設定で確認して引き渡します。新migrationは不要で、既存DB/Queueの再作成やSecret複製はしません。
本書のコマンド追加はデプロイや本番試験の実行許可を意味しません。
