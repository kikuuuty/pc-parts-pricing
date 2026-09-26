# PC Parts Pricing

PCパーツの**現在の価格summaryをD1へキャッシュし、Queueで非同期更新する非公開Cloudflare Worker**です。
需要駆動で、**ユーザー要求 > default-page warmup > 最近参照された製品 > cold**を優先します。
summaryはD1から返し、Yahoo!ショッピングの検索完了を待ちません。UIページサイズに依存しません。

```text
pc-build-sheet (UI)
    │ HTTPS                 ※ gateway/UI接続は次フェーズ
pricing-gateway
    │ Service Binding / RPC
pc-parts-pricing
    ├─ D1: current summary / lease / budgets
    ├─ interactive Queue ──┐
    ├─ background Queue ───┴─ Catalog Service Binding → shared Yahoo budget → Provider → D1
    └─ Cron ── default refs同期 / 期限到来製品のbackground enqueue
```

## 責務と既存リポジトリ

|リポジトリ|責務|
|---|---|
|[pc-parts-catalog](https://github.com/kikuuuty/pc-parts-catalog)|製品検索、category/spec/facet、canonical JAN/EAN/MPN、detail、durable identity|
|pc-parts-pricing|価格summary、stale判定、refresh scheduling、Queue/Cron、Provider正規化・保護|
|[pc-build-sheet](https://github.com/kikuuuty/pc-build-sheet)|検索一覧・構成・価格表示UI。ブラウザからYahoo/Rakutenを直接呼ばない|

2026-09-26に各repoのorigin/mainをfetchし、Pricing `aeb67d6`、Catalog `fb202e1`、Build Sheet `61eea72`を確認しました。
Catalogのcategories/search/resolve/detail実装・テストと既存境界ドキュメントを確認しています。
Build Sheet `61eea72`と作業ツリーの最新bulk接続も確認しています。
Catalogの現在のbulkはnumeric ID入力・読取専用、単一Offer取得は同期式です。本WorkerのRPCはそれらとは別の契約です。
Catalog/Build Sheetのファイルはこの実装で変更していません。既存店舗比較APIの移行も別途必要です。

## 非公開Worker / RPC

`wrangler.jsonc`で **`workers_dev: false`、`preview_urls: false`、`routes: []`**。
Custom Domainも設定しません。HTTPの`fetch()`は404のみ。公開REST APIやブラウザ用CORSはありません。
Cloudflareの現在の `WorkerEntrypoint` RPCを使い、同一accountの別Workerから呼び出します。
`preview_urls`は現在「Version URLs」と呼ばれるURLを無効化する設定です。

呼出元のWrangler設定:

```jsonc
{
  "services": [{ "binding": "PRICING", "service": "pc-parts-pricing" }]
}
```

```ts
const products = [
  { source: 'buildcores', upstream_key: 'CPU/<upstream-key>' },
];
const result = await env.PRICING.getPriceSummaries(products);
if (result.ok) {
  // result.data は入力順・重複を保持した ProductSummary[]
}
// 必要時のみ。Provider完了は待たず、enqueue結果までを返す。
const refresh = await env.PRICING.requestRefresh(products);
```

成功は`{ ok: true, data: ... }`、失敗は`{ ok: false, error: { code } }`。
codeは`INVALID_REQUEST`または`PRICING_UNAVAILABLE`。例外本文・stack・Secretは返しません。
入力は**1件以上**、各要素は`source`と`upstream_key`だけです。numeric product IDは受け付けません。
**20 = 現在のUI、100 = 将来Gatewayの上限候補、Pricing内部 = UI上限非依存**です。
全入力検証→全体dedupe→250件の内部RPC→50件のSQL/Queue chunk→入力順・重複の復元。
250はD1 invocation予算、50はSQL/送信の作業単位で、受付上限ではありません。601件の実workerd RPCも検証します。
単一RPCのメモリ/serialization/Service Binding連鎖上限は残るため、巨大な全件importは呼出元で分割・再開してください。
詳細・型・gateway連携は[RPC / Catalog境界](docs/interfaces.md)を参照してください。

```json
{
  "ok": true,
  "data": [{
    "source": "buildcores",
    "upstream_key": "CPU/example",
    "providers": {
      "yahoo": {
        "provider": "yahoo",
        "status": "complete",
        "lowest_price": 57800,
        "offer_count": 12,
        "fetched_at": "2026-09-26T00:00:00.000Z",
        "expires_at": "2026-09-26T06:00:00.000Z",
        "stale": false
      }
    }
  }]
}
```

### 一覧取得とstale-while-revalidate

|状態|レスポンス|非同期処理|
|---|---|---|
|fresh complete / empty|キャッシュを返す|refreshなし|
|stale complete / empty|許容期間内は旧価格・件数＋`stale: true`|重複抑制してenqueue|
|許容期間を超えたstale|`pending`、価格/件数/取得時刻null、`stale: true`|enqueue|
|未取得 / DBに行なし|`pending`、価格/件数/取得時刻null|pending行登録＋enqueue|
|unsupported|安全なidentifierがない。価格null、件数0|閲覧時はenqueueしない。Cronで14日後にCatalog再確認|
|missing|Catalogで不存在/inactive確認済み。価格null、件数0|24時間のnegative cache。期限後はpendingとして再確認|

`empty`は**正常検索で一致Offerが0件**、`pending`は未取得/更新待ちです。エラーをemptyにはしません。
`fetched_at`はProvider実取得時刻。unsupported/missingには取得時刻を作りません。
キャッシュHITでは取得時刻やTTLを延長しません。`stale`は古い確定結果が存在することを示し、pendingでもtrueになり得ます。

一覧の同期処理は**unique 50refごとに1 indexed batch SELECT**です。Catalog/Providerのアクセスは同期経路にありません。
自己Service Binding `PRICING_BATCH` / named entrypoint `PricingBatch`が250refずつD1処理を担当します。
1 child invocationは失敗時のbulk lease解放込みで最大25 D1 statements（通常20以下）。
アクセス記録とenqueueは`ctx.waitUntil()`で行います。freshの価格データ自体は再upsertせず、アクセス時刻は製品ごと最大1時間に1回だけ更新します。
`waitUntil()`は耐久ジョブではないため、最初のpending行作成前に中断した場合は次の閲覧で再試行します。登録済みの行はCronでも回収します。

## D1 schema

Migration: [`0001_pricing.sql`](migrations/0001_pricing.sql) + [`0002_demand_warmup.sql`](migrations/0002_demand_warmup.sql)。0001は変更しません。

- `product_price_summary`: **PRIMARY KEY `(source, upstream_key, provider)` WITHOUT ROWID**。
  status、lowest_price、offer_count、fetched_at、expires_at、last_requested_at、next_refresh_at、created_at、updated_at。
  追加でアクセス時間窓/count、priority、enqueue/execution lease token、retry_after、failure_count、bounded last_error。
- `is_default`と`queue_lane`でdefault所属・interactive/background leaseを明示。
- `price_refresh_due(provider, is_default, priority, next_refresh_at)`、`price_default_due(provider,is_default,next_refresh_at)`でbounded range seek。
- `default_warm_category`: カテゴリごとの次回同期時刻・claim token。
- `default_warm_ref`: category + durable refの所属集合。複数カテゴリに現れるrefもsummaryは1行。
- `work_budget`: `queue` / `yahoo` / `default_sync`の固定3行。共有日次/minute予算、background使用数、次回許可時刻。

日時はD1内ではepoch milliseconds、RPCではISO 8601です。価格はJPY正整数、件数は採用した最大50 listingの件数で、Yahoo全体の総出品数ではありません。
numeric product ID・identifier・製品名・seller・URL・App IDは永続保存しません。CatalogのD1への直接binding/FKもありません。
価格履歴はありません。将来の`price_observation`はこの現在値tableと分離できます。

## Queue / Cron / refresh policy

```json
{
  "source": "buildcores",
  "upstream_key": "CPU/example",
  "provider": "yahoo",
  "reason": "user_request",
  "token": "<enqueue-lease-uuid>"
}
```

reasonは`user_request` / `manual`（interactive）、`default_warmup` / `scheduled_refresh` / `cold_warmup`（background）。
tokenはSecretではなく、古いmessageが新しい処理を上書きしないためのfencing情報です。

- 既存`pc-parts-pricing-refresh`をbackgroundとして維持。新規`pc-parts-pricing-interactive`を追加。
- D1条件付きUPDATEでclaim後に50件以下の`sendBatch()`。各consumerは**batch size 1 / concurrency 1**。
  interactiveはbackground backlogの完了を待ちません。配信順/FIFO保証には依存しません。
  未実行background leaseはinteractive要求で新tokenへ昇格し、旧messageはskip。実行中なら同じ結果を待ちます。
  最新summary/tokenを再確認し、freshならskip。
  Catalogでidentifier取得→Provider→正規化→D1条件付き保存→ACK。
- Queueのat-least-once配信に対して、製品単位のenqueue lease（25時間）と実行lease（300秒）で重複を抑制。
  25時間はFree Queue保持期間24時間の直後に失われたmessageを回収するための猶予です。
- Provider/Catalogエラーは旧summaryを維持し、15分を基準に指数backoff（最大6時間、Retry-Afterがより長ければ優先）。D1へ記録できたらACK、Cronで再投入。
- D1保存失敗はACKせずQueue retry（360秒、最大3回）、その後既存DLQ。
  commitできなかったProvider成功結果は候補cacheから再利用可能。実行lease期限後に再試行します。
- Cronは`*/15 * * * *`を維持、既定最大8行。Yahooを直接呼ばずQueueへ投入。
  各回最大1枠をhot/recent/month/coldへ順番に予約し、残りはdefault → hot/recent/month → cold。
  defaultが常に多くても各tierに1時間ごとの処理機会を残します。coldは1回最大1件。
  index range seekのみで全catalog scan/sortをしません。active leaseはdue時刻を将来へ移します。

成功後のbackground間隔（`src/config.ts`の`POLICY`）:

|参照状況|間隔|
|---|---|
|default-page所属|24時間（価格TTLとは別）|
|直近24時間に3回以上のアクセス時間bucket|6時間|
|直近7日以内|24時間|
|直近30日以内|3日|
|それ以外 / 未参照|14日|

アクセス頻度は**時間単位の近似値**です。同じ時間のページ再表示でwrite/countを増やしません。
背景間隔と価格TTLは別です。TTLを過ぎてユーザーが閲覧した場合は、長い背景間隔よりオンデマンド更新を優先します。
backoff・共有日次予算・実行中leaseはユーザー要求でも回避しません。未実行background leaseだけ昇格できます。
`requestRefresh`も強制refreshではありません。

### default-page warmup（主たる事前Warmup）

既存Catalog Service Bindingの`GET /v1/categories`と`GET /v1/search?category=…&limit=N`を使います。
keyword/orderBy/filter/cursorは付けず、UIと同じdefault順の`source + upstream_key`を取得します。
Catalog mainは30カテゴリ。既定N=20で最大600 unique refs（重複があれば減少）です。

- `DEFAULT_PAGE_WARMUP_SIZE=20`、現Catalog HTTP limitに合わせ1〜50で設定可能。Pricing入力上限とは無関係。
- `DEFAULT_PAGE_SYNC_SECONDS=21600`（6時間）。カテゴリ一覧も6時間ごと、カテゴリごとに再取得時刻を保持。
- 1 Cron / Admin呼出しにつき最大4カテゴリを同期。初回30カテゴリは8回、最初のtickから約1時間45分。
  一度同期したカテゴリは6時間後に再取得し、自然に負荷を分散します。
- category単位のtransactionで所属集合を置換。既存summary/アクセス情報は保持し、新規だけpending登録。
  同じ集合ならsummary/所属の再writeなし。失敗カテゴリは以前の集合を残し、15分後から再試行。
  削除カテゴリは最大4つずつ所属だけ解除し、価格行は削除しません。
- **refsの同期はenqueueもYahoo検索もしません**。その後Cronが未取得/期限到来行を少数ずつ取り出します。
- default価格の背景更新は24時間＋TTL/negative TTL/backoff/予算に従います。600件を6時間ごとに価格更新しません。
  TTLは6時間なので常時全件freshは保証せず、stale価格の即表示＋閲覧時interactive更新を併用します。

管理RPC `PricingAdmin.syncDefaultWarmup()`でも同じdue判定付きの1 sliceを実行できます。強制全件同期ではありません。

### cold warmup

空DBから全48,000製品を自動列挙しません。管理Workerをnamed entrypoint **`PricingAdmin`**へbindingし、
Catalog API/exportから得たdurable refsを`seedWarmup(refs)`へ渡せます。600件以上も内部chunk処理します。
このRPCはpending行を重複なしで登録するだけで、Yahoo検索・即時enqueue・アクセス頻度の水増しはしません。
Cronが低優先度で取得します。初版はこの登録境界を提供し、全catalog巡回/import自動化は未実装です。
管理bindingを将来の公開gatewayには渡さないでください。[登録例](docs/interfaces.md#管理rpcとcold-warmup)

## Yahoo Provider

Catalogの実装から以下のlookup/error契約を移植し、Offer配列・seller/image等を保存する責務は取り除いています。

- canonical JAN優先。JANはtrimのみ・8/13桁・check digit検証。
- EANは**修復しない13桁文字列**・check digit検証、regionはJAN/EANとも`jp` / `all`。
- type（JAN→EAN）→region（jp→all）→local origin→lexicalの安定順。grouped `origins`も評価。
- 同じlookup値は重複排除し、最大3候補。`jan_code` exact lookup。
- `in_stock=true`、`condition=new`、`sort=+price`、`results=50`。
- 返却`janCode`の完全一致、返却在庫/新品、正のsafe整数価格を検証。
  listing重複はseller ID + item code + exact URLで除去し、低い価格を採用。
- 正常200の正規化結果0件だけ次候補へ進む。最初のhitで終了。MPN/name fallbackや候補間unionなし。
- fetchから本文読取まで5秒timeout、redirect非追従、自動transport retryなし、本文512 KiB上限。
- 429のRetry-Afterは1〜3600秒だけ採用（その他60秒）。D1で全consumer共通cooldown。
  timeout/network/5xx/invalid JSON/schema破損はemptyに変換しません。
- 候補単位の正常summary（0件を含む）をCache API + bounded isolate hintsへ保存。
  strategy + codeのhash + TTL + schema generationでkeyを作り、Secretを含めません。
  fallbackの最終summaryの有効期限は**評価した全候補の最短expiry**です。
- 同一候補のisolate内inflightは最大32、成功hintは最大128。coalescingでtoken/fetchを共有。
  Cache APIはcolo-local、isolate間coalescingは保証しません。
- 外部MISSごとにD1のglobal atomic gateを通し、**開始許可間隔1秒以上・30回/固定60秒窓・日次1500回**。
  同じ`work_budget.yahoo`の原子的UPDATEで両Queueを保護します。保護DB障害はfail closed。
- 保守的なlane配分: **interactive 24外部request/分、background 6/分**（共有30/分の80% / 20%）。
  日次はinteractive最大1200、background最大900、**合計1500**。
  backgroundが先に消費してもinteractiveに600回、interactiveが先でもbackgroundに300回残ります。
  未使用の予約枠を他laneへ貸し出さない簡潔な方式です。低い設定値では切捨て・最低1、共有総量制限を優先します。
- pacing/minute待ちはconsumer内で処理し、通常のminute超過で15分Cron待ちにしません。
  候補ごと最大6 gate試行、製品全体の待機deadline 240秒（実行lease300秒内）。day/長い429 cooldownはbackoff。
  20製品で1〜3候補なら最大20〜60外部request。正常時は数分で順次埋まる目安ですが、予算不足/Provider障害時は延期します。

TTL初期値6時間、stale許容は**expires_atから7日間**。`wrangler.jsonc`のvarsで変更できます。
TTL変更は新規取得から適用されます。既存product summaryのexpiryは書き換えません。
Catalogのidentifier変更は次のrefreshで反映され、unsupportedの変更検知には最大14日かかります。

### 設定値

|var|既定|許容範囲|
|---|---:|---:|
|`YAHOO_SUMMARY_TTL_SECONDS`|21600|60〜1209600|
|`MAX_STALE_SECONDS`|604800|0〜2592000|
|`CRON_BATCH_SIZE`|8|1〜20|
|`WARMUP_BATCH_SIZE`|1|0〜5（低優先度lane全体の上限）|
|`DEFAULT_PAGE_WARMUP_SIZE`|20|1〜50（Catalog HTTP limit）|
|`DEFAULT_PAGE_SYNC_SECONDS`|21600|3600〜604800|
|`QUEUE_DAILY_LIMIT`|1000|1〜1000|
|`YAHOO_DAILY_LIMIT`|1500|1〜3000|
|`YAHOO_MINUTE_LIMIT`|30|1〜30|
|`YAHOO_PACING_MS`|1000|1000〜10000|

設定が不正なら処理を進めません。欠損は既定値を使います。間隔・negative TTL・lease・backoffは`POLICY`へ集約しています。

### 将来Rakutenを追加する場合

`src/providers/rakuten/`へ独立transport/identifier policy/mapperを追加し、`PriceProvider.lookup()`から共通`Resolution`を返します。
共通summaryへ楽天/Yahoo固有fieldを追加せず、Provider enum、storageのprovider選択、RPCのproviders map、Queue検証/dispatchを拡張してください。
Provider別のbudget行・TTL・Secret・回帰テストを追加します。既存summaryの主キーは複数Providerを許容しており、価格履歴は不要です。

## Secret / bindings

|binding / Secret|用途|
|---|---|
|`DB`|Pricing専用D1|
|`REFRESH_QUEUE`|既存refresh Queue、background producer|
|`INTERACTIVE_QUEUE`|新規interactive Queue producer|
|`PRICING_BATCH`|同Workerの`PricingBatch`への自己Service Binding。内部D1作業の分割|
|`CATALOG`|既存Catalog WorkerへのService Binding（HTTP fetch境界）|
|`YAHOO_SHOPPING_APP_ID`|Pricing WorkerのSecretのみ|

CatalogへのService Bindingは既存HTTP handlerを内部呼出しできるため、Catalog側に新RPCを追加する必要はありません。
`POST /v1/products/resolve`で現在IDを得て`GET /v1/products/:id`を取得し、**detailでもsource/keyを再照合**します。
取得するのは製品情報だけです。Catalogの`/offers`は呼びません。将来は専用identifier RPCで2段階lookupをまとめられます。

```sh
npx wrangler secret put YAHOO_SHOPPING_APP_ID
```

値は対話入力し、vars・Queue・ソース・CLI引数・ログに入れません。
ローカルはGit ignore済みの`.dev.vars`に設定できます。将来のRakuten credentialもPricing側Secretです。
既存CatalogのOffer機能はまだ別途Secretを利用します。その削除・移行は店舗比較機能を移す段階で行います。

## Local development / migration / test

Node.js 24以上。Wrangler / TypeScript / Miniflareはlockfileで固定しています。

```sh
npm ci
npm run db:migrate
npm run check
npm run build
npm run dev
```

- `db:migrate`は`.wrangler/state`のローカルD1だけに適用。
- `check`は型検査＋unit/SQLite/workerd統合テスト。実Yahoo・実Catalog・Cloudflareアカウント・Secret不要。
- workerd統合テストは実RPC、D1 migration、Queue、Cron、Cacheを起動し、Catalog/Yahoo境界だけmockします。
  summaryの応答時点でProvider処理を意図的にblockして非同期性も検証します。
- `build`はWrangler **deploy dry-run**。remote resourceを作りません。
- `dev`のHTTPアクセスは404です。RPC呼出元WorkerとCatalogのlocal Workerを別terminalで起動してください。
  通常開発の完全offline確認には`npm test`を使えます。local multi-Worker例は[interfaces.md](docs/interfaces.md#ローカルrpc開発)。
- `.dev.vars*`、`.env*`、`.wrangler/`、`dist/`はGit対象外。

任意の実Yahoo smoke（通常CIには含めません）:

```sh
# 環境変数 YAHOO_SHOPPING_APP_ID を設定してから実行
npm run smoke:yahoo -- --live --code <verified-JAN-or-EAN13>
```

`--live`なしではネットワークへ接続しません。smokeは単一transport確認でD1保護を通さないため、連続実行用ではありません。
出力はstatus class・duration・summary status・件数だけです。

## Deploy

Worker / D1 / refresh Queue / DLQ / Cron / CATALOG binding / Yahoo Secretは**既存production resource**です。
`database_id=a5d4eae0-1e31-49c0-a052-78e30b486273`を保持します。再作成しません。
今回必要な新resourceはinteractive Queueのみ。以下はオペレーター実行手順です。

```sh
npx wrangler queues list
npx wrangler d1 migrations list pc-parts-pricing --remote
# 同名Queueがまだないことを確認して新規作成（既存refresh/DLQは保持）
npx wrangler queues create pc-parts-pricing-interactive
npm run db:migrate:remote
npm run check
npm run build
npm run deploy
```

`CATALOG`のservice名は同一accountの既存Worker名と一致させます。
Service Bindingを使うcaller WorkerはPricingのdeploy後に設定します。CronとQueue consumerは公開Routeなしで動作します。
0002適用後、両consumerと`PricingBatch`自己bindingを同じWorker deploymentで反映します。
既存messageの形式は互換。昇格で古くなったtokenはskipします。Secretの再登録は不要です。
今回の作業ではremote作成・migration・deployを実行しません。[更新・rollback手順](docs/operations.md#production更新)
DLQの確認・復旧方法は[運用ドキュメント](docs/operations.md)。

## Cloudflare Free枠の運用上限

2026-09-26確認の公式仕様:

|サービス|Free上限|
|---|---|
|D1|5,000,000 rows read/日、100,000 rows written/日、account計5 GB、1 DB 500 MB|
|D1 query|100 bind parameters/statement、50 queries/Worker invocation|
|Queues|10,000 operations/日、保持24時間。通常1message=write/read/deleteの3ops、retryは追加read|
|Workers|100,000 requests/日、HTTP/Cron CPU 10ms、account Cron 5個|

一覧は各chunk最大50refのJSONを1 bindし、`json_each → 複合PK LEFT JOIN`。catalog件数に比例しません。
実ローカルD1の20件参照は、2行存在時**rows_read=22**、20行存在時**rows_read=40**。いずれも**rows_written=0 / 1 statement**です。[検証記録](docs/operations.md#検証記録)
SQLiteのquery planテストでもPK lookupとCronのrange indexを検証します。SQLite adapterの行数をD1課金実測値として使いません。

- 30カテゴリ×20件のdefault registryは最大600 summary + 600所属 + 30カテゴリ状態。
  安定時のCatalog default呼出しは約124/日（categories 4 + search 120）。価格refreshのresolve/detailは別です。
- Cronは96 invocation/日、最大768 enqueue候補/日。background日次上限600、interactive最大800、**合計1000**（UTC）。
  先にbackgroundが600使ってもinteractiveに400、interactiveが800使ってもbackgroundに200を残します。
  昇格で増えるmessageもこの予算に含めます。48,000件一巡は目標にしません。
- 通常約3000Queue ops/日（2 Queue合算、1000×write/read/delete）。
  全件3 retry + DLQ writeでもこの日の投入分は概算7000ops。前日のretryや他Queue、DLQ読取もaccount予算を使います。
- Yahooの1500外部request/日予算は候補単位。3候補がすべてMISSなら1製品で3回消費。
- Provider単位最大1500 Yahoo request/日。default600件を全て1候補で初回取得すれば600回、
  全て3候補なら1800回なので複数日に分散します。定常backgroundは最大900回/日です。
- WorkerはCron96 + Queue最大1000 delivery（retry別）+ 外部caller要求。
  Service Bindingは別の課金requestを追加しませんが、内部RPC/同一accountのCatalog処理はCPU・subrequest制限を使います。
  Cron数は1個のまま。Yahoo minute待機はQueue retryを増やしません。
- D1 lookupは20件freshで40 rows read、50件freshで100 rows read、601件freshで概ね1202 rows read。
  20件×1000ページなら同期約4万read/日。registry安定時は所属約2400read/日＋小さい状態index読取。
- D1 write概算: 安定registryの同期状態は数百/日（600所属の再writeなし）。1000refreshのclaim/acquire/finish、
  共有budget/index等はおおむね1万〜2万write/日。初回600登録はindex/所属を含め数千writeを追加。
  セットが毎回全面入替なら1日2400新規ref＋旧所属解除で追加数万writeになり得ます。
  アクセスtouchは製品・時間bucketごと。20,000 distinct touch/日ならindex込み数万writeを別途消費するため、
  **100,000 rows written/日**へ近づく主要要因です。これらは設計概算で本番課金値ではありません。
- fresh価格の再保存なし。アクセス記録は時間単位。Cronは最大6 bounded index queryで候補を選びます。
- **Free運用を無条件に保証するものではありません。** D1のindex更新もrows writtenに数えられ、Catalog等とaccount枠を共有します。
  任意refの大量閲覧/登録はアクセス行writeを増やします。将来gateway側にも認証/入力検証・request rate limitが必要です。
  目安として20件×1000ページ/日でも同期readは最大約4万行/日ですが、書込・index・Queue関連は別途計測してください。
- D1上限到達時はRPC `PRICING_UNAVAILABLE`、Queueはretry、Cronは次回へ。実稼働のCPU p95/p99、rows written、Queue backlogを監視し、
  上限へ近づく前にCron/Provider予算を下げるかPaidへ移行します。Freeの10ms CPUはローカルテストだけでは保証できません。

公式資料:
[Service Binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) /
[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) /
[Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/) /
[D1料金](https://developers.cloudflare.com/d1/platform/pricing/) /
[D1制限](https://developers.cloudflare.com/d1/platform/limits/) /
[Queues料金](https://developers.cloudflare.com/queues/platform/pricing/) /
[Queue retries](https://developers.cloudflare.com/queues/configuration/batching-retries/) /
[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)

## Observability

`src/telemetry.ts`の固定enumとbounded numberのみをJSON出力します。
provider、reason、cache status、refresh reason、queue result、provider status class/duration、summary status/offer_count、rate limit status、candidate cacheを確認できます。
設定はinvocation単位10% samplingです。JAN/EAN、製品identity/name、価格、Yahoo/seller URL、App ID、upstream本文、例外stackをログdimensionにしません。
DB側の`last_error`にも固定reasonだけ保存します。D1使用量・Queue metricsはCloudflare dashboardと併せて確認してください。

## 構成 / 未実装

```text
src/worker.ts              private RPC / Queue / Cron entrypoints
src/pricing/              common model / freshness / batch service
src/storage/              D1 summaries / durable budgets
src/catalog/              resolve + detail Service Binding adapter
src/providers/yahoo/      candidate selection / transport / cache/coalescing
src/queue/                enqueue lease / consumer
src/scheduler/            indexed bounded Cron / resumable default-page sync
migrations/               pricing-only schema
test/                     offline regression + real workerd integration
docs/                     interface / operations
```

未実装: 価格履歴、Rakuten、公開pricing-gateway、Build Sheet接続、個別店舗Offer配信、全catalogの自動列挙・完全warmup、
Catalog更新イベントによる即時無効化、isolate間の候補coalescing、DLQ自動replay。
remote resource作成・Secret登録・production deploy・実API smokeも今回のローカル検証では行っていません。

次フェーズではgatewayで公開HTTPとRPCを仲介し、Build Sheetのnumeric ID summary入力をdurable refsへ変更します。
検索1ページにつき1bulk request、stale表示、遅延価格による手入力価格の非上書き、既存店舗比較経路の扱いを合わせて実装してください。
