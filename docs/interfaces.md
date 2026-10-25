# RPC / Catalog interfaces

## Caller binding

```jsonc
"services": [{ "binding": "PRICING", "service": "pc-parts-pricing" }]
```

default export `PricingWorker extends WorkerEntrypoint<Env>`を使用します。
TypeScriptではこのrepoの`src/worker.ts`のdefault class型をtype-only importし、`Service<PricingWorker>`として型付けできます。
別repoへ型を配るパッケージは未公開です。初版のJSON契約は本書と`src/pricing/model.ts`、`src/pricing/contracts.ts`が定義します。
Cloudflare runtime importを避けたいcallerにはplain-data interface `PricingRpc` / `PricingAdminRpc`も提供します。
RPC引数・返却値はplain dataのみで、RPC target/streamは返しません。

### `getPriceSummaries(products)`

入力: `ProductRef[]`、1件以上。UI固有の20件上限・公開Gatewayの100件上限はPricingに設けません。

```ts
type ProductRef = { source: string; upstream_key: string };
type Summary = {
  provider: 'yahoo';
  status: 'complete' | 'empty' | 'unsupported' | 'pending' | 'missing';
  lowest_price: number | null;
  offer_count: number | null;
  fetched_at: string | null; // ISO UTC; unsupported/missing/pending は null
  expires_at: string | null;
  stale: boolean;
};
type ProductSummary = ProductRef & { providers: { yahoo: Summary } };
type Result<T> = { ok: true; data: T }
  | { ok: false; error: { code: 'INVALID_REQUEST' | 'PRICING_UNAVAILABLE' } };
```

返却: `Result<ProductSummary[]>`。入力順・重複保持。DB参照/書込/enqueueは重複排除します。

入力全体を検証してから処理します。全体dedupe → 内部RPC 250件 → SQL/Queue 50件chunk → 結果復元。
`PRICING_BATCH`は同Workerのnamed `PricingBatch`への自己bindingで、gatewayへは公開しません。
summary childのD1 statementは最大25。SQL本文は固定、全処理を含めても1 statementのbindは最大16です。
600件超でも巨大なSQLは作りません。
Workerのメモリ/serialization/subrequest上限は有効です。Service Bindingは1requestの呼出し連鎖が最大32回のため、
何万件ものimportを単一RPCへ集めず、呼出元のジョブで分割・進捗保存してください。
大量writeの途中で基盤エラーが起きた場合は部分登録/部分enqueueがあり得ます。再実行はdedupe/leaseで保護されます。

- source: lowercase ASCII slug、`^[a-z][a-z0-9_-]{0,63}$`。
- upstream_key: 200文字以内、`Category/key`、`^[-A-Za-z0-9_]+/[-A-Za-z0-9_.]+$`。
  `.` / `..`単独keyは禁止。Catalogのdurable refと同じ形式です。
- 追加field、numeric ID、数値変換、trimによる修復は受け付けません。
- DBに行がないことは「Catalogに製品がない」ことではありません。まずpendingを返します。
  missingはconsumerがCatalogの不存在/inactiveを実際に確認した後だけ返します。
- completeは正の価格/件数、emptyは価格null/件数0、unsupported/missingは価格null/件数0、pendingは価格/件数null。
- expires_atはpendingでも古いexpiryを返すことがあります。期限を超えて表示から隠した結果の診断用で、freshness判定をUIへ委譲しません。
- D1読取障害をpendingへ偽装しません。RPC全体が`PRICING_UNAVAILABLE`です。
- 未登録refはpending応答前にD1へ永続登録します。登録失敗は`PRICING_UNAVAILABLE`です。
  登録済みならcallerがpollingを止めても、enqueue失敗・予算待ちはdue indexからCronが回収します。
- 既存行のbackground touch/enqueue障害はRPC成功結果を変えません。telemetryへ記録し、Cronで再試行します。

### `requestRefresh(products)`

入力は同じ。返却`Result<{ enqueued: number }>`。
reasonは`manual`、interactive Queueを使用。D1 touch、claim、Queue送信まで待ち、Catalog/Providerの完了は待ちません。
fresh/unsupported/interactive lease/実行lease/backoff/予算超過ではenqueued=0。受理件数は入力の件数とは異なります。
未実行のbackground leaseは新tokenでinteractiveへ昇格。古いbackground messageはfencingで無効化します。
同時閲覧と競合してもD1の条件付きclaimが勝者だけを返します。
これは「すぐ最新価格になる」保証やforced invalidation APIではありません。

## 管理RPCとcold warmup

管理用Workerだけにbindingします。gatewayの通常bindingとは別entrypointです。

```jsonc
"services": [{
  "binding": "PRICING_ADMIN",
  "service": "pc-parts-pricing",
  "entrypoint": "PricingAdmin"
}]
```

```ts
// Catalog API/exportから得たref配列を低優先度coldとして登録。
// 検索結果を丸ごと渡さず、durable refの2 fieldだけ取り出す。
const refs = catalogProducts.map(({ source, upstream_key }) => ({ source, upstream_key }));
const result = await env.PRICING_ADMIN.seedWarmup(refs);
// Result<{ registered: number }>。既存行は変更せず、即時enqueueもしない。
```

空DBにはdefault-page同期、seedまたはユーザー閲覧で行が作られます。
Cronの主たる事前Warmupはdefault-pageで、全Catalogの48,000件を毎回列挙しません。
全件importを行う場合はD1のindex writeも含めた日次予算に収まる別のバッチ制御が必要です。

### `PricingAdmin.syncDefaultWarmup()`

引数なし。`Result<{ synced: number; failed: number }>`を返します。
通常Cronと同じ「期限到来した最大4カテゴリのrefs同期」を実行し、Yahoo/Queueは呼びません。
同時実行はカテゴリのclaim tokenで保護。既定6時間の再取得間隔を強制的に回避しません。
partial failureは成功カテゴリを登録し、失敗カテゴリの旧集合を保持します。category-list取得失敗は`failed: 1`。
管理用の進捗確認/初回同期にも使えますが、1呼出しで30カテゴリ完了する契約ではありません。

## Catalog boundary

Pricingからは`CATALOG.fetch()`だけを使用します。

default warmup:

1. `GET /v1/categories` → `{ categories: string[] }`、一覧は既定6時間ごと。
2. dueカテゴリについて `GET /v1/search?category=<slug>&limit=<DEFAULT_PAGE_WARMUP_SIZE>`。
3. `data[].source/upstream_key`を検証・dedupe。categoryと`meta.limit/offset/returned`も検証。
4. category単位で所属を置換し、新規summaryだけpendingで作成。既登録refの価格・アクセス情報を保持。

keyword/orderBy/filter/cursorは指定しません。既存検索APIのdefault順に追従します。
Nの現設定範囲1〜50はCatalog HTTP limitによるもので、Pricing RPC limitとは無関係です。
public Internet fallbackはありません。取得失敗を空集合として扱いません。

価格refresh:

1. `POST https://catalog.internal/v1/products/resolve`、body `{ products: [ref] }`。
2. activeならその場だけのnumeric IDで`GET https://catalog.internal/v1/products/:id`。
3. detailのID/source/upstream_keyがresolve/入力と一致することを再確認。
4. canonical grouped identifiersをYahoo Providerへ渡す。

内部hostnameはService Bindingのルーティング先ではありません。固定originを使うことでCatalogのorigin別detail cacheを共有します。
1製品につき最大2回のresolve/detail呼出しは**Queue consumerのみ**です。summary要求時に同期fan-outしません。
各呼出しは本文読取を含め5秒、256 KiB上限、redirect非追従。
resolve/detail競合で別のdurable製品が返ればerror。類似SKUへの置換やnumeric IDの永続保存は行いません。
既存CatalogのAPI保護も有効で、429/5xx/timeout/JSON破損はbackoff対象です。

既存Catalogはdefault fetch handlerを持つので、Service Bindingによる内部呼出しにコード変更は不要です。
将来専用RPC `getIdentifiers(refs)`等を追加すればresolve/detailをまとめられます。
その最小変更はCatalogへnamed `WorkerEntrypoint`と既存resolver/detail関数のadapterを追加することです。
今回その変更や検索/D1のリファクタリングは行っていません。

## ローカルRPC開発

1. Pricingで`npm ci`、`npm run db:migrate`。
2. Catalog repoのREADMEに従ってローカルD1を用意し、Catalogの`npm run worker:dev`を起動。
3. Pricingで`npm run dev`を起動。使用portが重なる場合は`npm run dev -- --port 8789`。
4. caller Workerに上記`PRICING` Service Bindingを設定して別portで`wrangler dev`。
5. callerからRPCを呼ぶ。PricingのHTTPルートへPOSTする方式ではありません。

ローカルService Bindingのservice名は、相手のWrangler `name`に一致させてください。
実Yahooを利用する場合だけPricingの`.dev.vars`へSecretを設定します。
完全offlineでは`npm test`がmemory上のcaller、Pricing、mock Catalog/Yahoo、実D1/Queueを起動します。
テスト用HTTP driverは`test/runtime.test.ts`内のみで、本番bundleには含まれません。

## 公開Gateway / 次フェーズpc-build-sheet

### Gateway

同repoの別Worker `pc-parts-pricing-gateway`を追加しました。
通常の`PRICING → pc-parts-pricing`だけをbindingし、`POST /v1/prices/summary`で1〜100件/64KiBを受け付けます。
本体の`getPriceSummaries`を1回awaitし、Provider完了は待ちません。CORS、native client/共有/大batch制限、受付停止設定を備えます。
Secretや`PricingAdmin` / `PricingBatch`、D1/Queue/Cron/Catalog bindingはありません。
**[HTTP契約、エラー、接続設定、ローカル起動](gateway-http.md)**と
[`test/fixtures/gateway-http.json`](../test/fixtures/gateway-http.json)をSheet実装の契約として参照してください。
本番Origin/URLは未確定、既定では受付停止です。デプロイ済みを意味しません。

### Build Sheet

- `getOffersSummary`の`product_ids`をsource/upstream_keyへ移行。検索結果は既に両fieldを持つ。
- Query keyとレスポンス照合をnumeric IDからdurable pairへ変更。
- 1ページ20件を1bulkで取得し、Yahoo/Rakuten直接アクセスや20件の単一Offer fallbackを追加しない。
- provider map、expires_at、staleをschemaに追加。stale価格の取得日時をUIへ表示。
- pendingは「未取得/更新待ち」、emptyは「販売情報なし」、unsupported/missingを分ける。
- pending/staleがある場合、Gateway経由でsummaryのみを間隔・回数を制御してpolling。
  毎回`requestRefresh`を別途呼ぶ必要はありません。Pricingのlease/fresh/backoffが重複enqueueと再検索を抑制します。
- 表示: fresh→価格、stale→旧価格＋取得時刻（現在更新中・完了時刻の保証なし）、pending→未取得/更新待ち、empty→取扱情報なし、unsupported→価格取得非対応。
  pending/staleのpollingは有限にし、unsupported/missingはstaleだけで無限pollingしません。
- 市場summaryの非同期変化で、手入力済み構成価格を上書きしない。
- 既存の店舗比較popoverはOffer配列を必要とするため、このsummaryだけでは移行できない。
  個別Offer APIを別途設計してからCatalog側Yahoo機能/Secretの退役を検討する。
