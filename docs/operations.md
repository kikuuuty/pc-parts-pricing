# Operations / failure recovery

本番の読み取り専用診断と少数製品試験の準備は[production-verification.md](production-verification.md)を参照。
以下の過去の反映記録は、現在の本番正常性を保証するものではありません。

## Durable enqueue / execution

```text
summary read ── await registration of unknown refs ── pending/cache response
              └─ waitUntil ── conditional touch of existing rows
                            └─ conditional UPDATE ... RETURNING (claim)
                               └─ reserve daily queue budget ── sendBatch

Queue ── latest row/token check ── execution lease
      └─ Catalog ── candidate cache ── D1 provider admission ── Yahoo
                                                      └─ normalize ── fenced D1 write ── ACK
```

enqueueは`queued_until <= now`、backoff解除、期限切れが条件です。
user/manualはunsupportedを除外し、未実行background leaseだけは新tokenでinteractiveへ昇格できます。
default/scheduled/coldは`next_refresh_at <= now`を追加条件にします。
claimは次回Cron時刻をlease期限へ動かすため、active leaseを毎Cron全表filterする必要がありません。
consumerはqueue tokenとrun tokenの両方で保存をfenceします。古いdeliveryや実行leaseを失った処理の結果は保存されません。

### クラッシュ境界

|境界|復旧|
|---|---|
|未登録refの登録失敗|RPCはPRICING_UNAVAILABLE。pending受理成功と扱わない|
|登録後、waitUntilのenqueue前に中断|due indexからCronが回収。新規要求はinteractive laneを保持|
|pending行登録後に中断|due indexからCronが回収|
|claim後、send前に中断|25h leaseが切れるとCronが新tokenで再投入|
|sendの成否不明|leaseを条件付き解放して15分backoff。旧tokenのdeliveryは無効化、すでに実行中ならrun tokenにより解放を抑止|
|Provider成功、D1 write失敗|Queue retry。候補cacheが残っていればYahoo再検索なしで保存|
|Providerエラーのbackoff write失敗|Queue retry。成功扱いでACKしない|
|commit済みだがACK前に終了|再deliveryで最新token/summaryを見てskip|
|retry上限 / Queue保持期限|DLQまたは失効後、D1 leaseが切れるとCronでも再投入|

D1とQueueは分散transactionではありません。exactly-once送信は保証せず、**重複抑制・fencing・最終的な再試行**を実装しています。
claim後の障害では一時的にpendingのまま長く待つ場合があります。leaseは障害時の復旧上限で、通常時のrefresh間隔ではありません。

## Error policy

- Yahoo/Catalogのエラー本文・URL・例外は保存しません。
- `last_error`は`timeout`, `network`, `upstream_429`, `upstream_5xx`, `upstream_4xx`, `upstream_status`,
  `invalid_json`, `malformed_response`, `missing_app_id`, `catalog_unavailable`, `catalog_invalid`, `rate_limit`, `protection`等の固定reason。
- エラー時に`status/lowest_price/offer_count/fetched_at/expires_at`を変更しません。
- 失敗回数を最大16で保持。`max(Retry-After, min(6h, 15min × 2^failure_count))`で延期。
- 429はProvider共通の`next_allowed_at`にも反映。日次予算超過は次のUTC日まで延期。
- 実HTTPの連続5xxは共有D1 healthで数える。単発500を利用規制とは断定しない。
  2回目から共有cooldownを60秒→120秒→…→最大30分へ延長し、別製品/laneの検索も止める。
  429/cooldown後は10秒pacingで3実HTTP成功を確認して通常pacingへ戻す。
  古いinflight成功では新しい障害を解除しない。候補cache hitや個別応答不備はhealthを解除/加算しない。
  製品のbackoffとdue indexを維持するため、手動replayなしで再開する。
- Queue日次予算はclaimされた件数だけ予約。send障害時に返却しません（安全側の過大計上）。
  残予算がbatch件数より小さいとbatch全体を翌日に延期するため、上限直前で未使用枠が残ることがあります。
- Providerの日次予算は成功数ではなく実検索の開始許可数。0件/429/5xxも1回を消費します。
- 固定60秒窓はrolling windowではありません。pacing/429 cooldownと合わせた保守的な上限です。
- minute/pacingだけの待機はconsumer内で実行（製品全体deadline240秒、1候補最大6 gate試行）。
  10秒以下の共有待機もconsumer内で待つ。実行lease300秒、D1障害のnative retry360秒。
  日次枠不足・長いcooldownはbackoff＋Cron回収です。

Yahoo公式の[itemSearch v3](https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html)は
1クエリー/秒と429、[Shopping FAQ](https://developer.yahoo.co.jp/webapi/shopping/faq.html)は
短時間規制で500を返しアクセスを控えると解除する旨を案内しています（規制条件は非公開）。
Pricingの30/分・1500/日・lane枠・5xx閾値は独自の安全設定で、Yahoo公式quotaではありません。
他Workerが同じアプリIDを使う場合、このD1 gateでは合算制御できません。

## Priority / starvation

- 新規`pc-parts-pricing-interactive`と既存`pc-parts-pricing-refresh`（background）にproducer/consumerを分離。
  それぞれconcurrency=1/batch=1。同じ既存DLQを利用します。Queueの順序保証に依存しません。
- background100件が残っていてもinteractive20件は別consumerが処理します。
  同じrefのbackground messageを昇格した場合は、古いdeliveryをtokenでskipします。
- Yahoo外部MISSは必ず同じ`work_budget.yahoo`でadmission。cache hit/coalesced候補には追加admissionなし。
  既定minuteはinteractive24/background6、共有total30。dayはinteractive1200/background900、共有total1500。
- enqueueも同じ`work_budget.queue`。interactive800/background600、共有total1000/日。
  各laneの上限と共有上限の両方を満たす必要があります。余ったlane枠を他laneへ移譲しません。
- この予約により、一方が先に日次枠を使い尽くしてももう一方に容量が残ります。
  backgroundの失敗や外部quota不足まで含めて完了時刻を保証する仕組みではありません。
- Cronは既定8件/回。各回1枠をhot/recent/month/coldに輪番で予約、残りdefault→recent→cold。
  coldは既定1件/回以下、default backlogが続いてもcoldに1時間ごとの機会があります。
- `CRON_BATCH_SIZE=1`でも輪番予約で各tierは進みますが、defaultの進行余力が小さくなるため既定8を推奨。

## Default registry sync

カテゴリ一覧を6時間ごとにService Bindingで読み、カテゴリごとのdue時刻から4件ずつclaimします。
4カテゴリの同期はnamed `PricingBatch`の別invocation、価格のschedulerはCron側です。
これによりCatalog fan-outとD1 statement数を抑えます。初回30カテゴリは8 tick（約1時間45分）。

- 登録と価格取得は分離。同期はProviderもrefresh Queueも呼びません。
- 価格行の`is_default`は所属表`default_warm_ref`から計算。category replacementはD1 transaction。
  defaultから外れても価格行は保持。共有refは他categoryに残る限りdefaultです。
- 集合が同じ場合はsummary/所属のwriteなし。同期状態のみ更新。
- category-list error: 全旧集合を保持し、15分後に一覧を再試行。
- partial search failure: 成功カテゴリのみcommitし、失敗カテゴリは15分後に再試行。
- Catalogから削除されたカテゴリは一覧取得時に最大4つずつ解除。大量削除は複数同期周期で回収。
- default価格は24時間背景間隔（TTL6時間とは別）。negative TTL、既存lease/backoffを延長・解除しません。
  ユーザーがstaleを読む場合はbackground due時刻より先にinteractiveを開始できます。

## Telemetry / budgets

Cloudflare dashboard:

- D1: `rows_read`, `rows_written`, database size。index更新にもwrite料金がかかります。
- Queue: backlog、oldest message age、delivery/retry、DLQ件数。
- Workers: CPU、error outcome、subrequest usage。
- JSON logs: `queue_result`, `refresh_reason`, `rate_limit_status`, `provider_status_class`, `provider_duration_ms`。

健康状態の目安:

- 同じ製品の連続閲覧で`sent`が増え続けない。
- warm summaryの取得でProvider eventが発生しない。
- pending比率とqueue oldest ageが増え続ける場合は予算不足/Secret/Catalogエラーを確認。
- `upstream_429`が続く場合はYahoo minute/day予算を下げる。D1 gateを迂回しない。
- stale表示が続く場合はlast_errorとexpires_at/next_refresh_atを比較。
- coldは最下位です。48,000件全体のwarmup完了や常時freshを運用目標にしません。

アカウント全体のFree残枠にはCatalog、gateway、他Workerも含みます。
既定1000enqueue/日で通常3000Queue ops、1500Yahoo admission/日で最大1500 budget更新。
summary claim/run/finish/index更新やアクセスtouchもwriteするので、全48,000製品の頻繁なアクセスにはこの初期設定は向きません。
`QUEUE_DAILY_LIMIT`の1000上限を上げる際はコード変更とaccount側予算の再設計を行ってください。

## DLQ

`pc-parts-pricing-dead-letter`に通常consumerを接続しません。
必要時にCloudflare dashboard/Queues APIで件数とmessageを確認します。messageにはdurable ref/provider/reason/tokenのみです。

1. Secret、Catalog、D1 migration/日次枠、設定値の原因を修正。
2. D1の現在summaryとleaseを確認。
3. 原則は25時間のlease失効後のCron回収を待つ。
4. 個別に再投入する場合も`requestRefresh(refs)`を使い、raw message大量replayで予算を迂回しない。
   有効lease中は0件になり、解除後に新しいtokenを取得する。
5. 古いDLQ messageを通常queueへ戻しても、tokenが違えば安全にskipされる。

DLQ自動replay・強制lease解除用の公開/管理RPCは初版にはありません。

## Schema / policy upgrades

- `0003_provider_recovery.sql`は固定件数のwork_budgetに共有health列だけを追加します。
  summary・lease・予算消費を保持し、先にmigration、その後Worker deployの順で適用します。
- 現在値tableには世代ごとの行を増やしません。主キーはdurable pair + provider。
- identifier選択/正規化の破壊的変更では`src/providers/yahoo/service.ts`のcache path generationを更新。
- 既存product summaryを即座に無効化する自動機能はありません。必要なら別migration/限定管理ジョブで
  期限とnext_refresh_atを段階的に変更し、日次予算を超える一斉更新を避けます。
- Catalogのrelease epochを価格DBへコピーしません。numeric ID再割当をdurable照合で防ぎ、identifier変更は定期refreshで反映します。
- 欠損/unsupportedは定期的にCatalogを再確認するため、後日のcanonical JAN追加も最終的に利用されます。

## Production更新

既存Worker、D1 ID、refresh Queue、DLQ、Cron、CATALOG、Yahoo Secretを維持します。
2026-09-26にinteractive Queue追加・0002 remote migration・Worker deployを完了しました。
通常の更新ではQueueの再作成やSecretの再登録は不要です。

1. `git diff -- wrangler.jsonc migrations`で差分確認。
2. `npx wrangler queues list`、`npx wrangler d1 migrations list pc-parts-pricing --remote`で既存resourceと未適用migrationを確認。
3. 未作成なら **`npx wrangler queues create pc-parts-pricing-interactive`だけ**追加。
4. 未適用migrationがあれば`npm run db:migrate:remote`で適用。既存migrationは書換えません。
5. `npm run check`、`npm run build`。private URL設定、同じD1 ID、2 consumer、自己bindingを確認。
6. `npm run deploy`。両Queueは既存DLQへ接続、旧refresh messageの形式もそのまま受理。
7. private callerで数件のsummaryを確認。pending→fresh、同一ref polling、background backlog、lane budgetを監視。
   Yahooへ大量の負荷試験はせず、まずdefault登録数と徐々に増えるsummaryを観測。

0002は列/小さいregistry表を追加し、due indexを新しい複合indexへ置換します。価格行を削除/再初期化しません。
旧Workerも新schemaを読めますが、旧コードはinteractive Queueをdrainできずlane予約を理解しません。
rollbackはまずproducer/consumer状況を確認し、追加Queueの処理を停止/隔離してから旧versionへ戻す運用が必要です。
単純な旧version rollbackで追加QueueやD1を削除しないでください。通常は新versionのforward fixを優先します。

### 本番反映記録（2026-09-26）

- Source commit: [`0b2e9fc`](https://github.com/kikuuuty/pc-parts-pricing/commit/0b2e9fc)（mainへpush済み）。
- [GitHub Actions](https://github.com/kikuuuty/pc-parts-pricing/actions/runs/36242607618)で`npm run check`・`npm run build`成功。
- 追加Queue: `pc-parts-pricing-interactive`。既存refresh Queue/DLQは同じIDで保持。
- remote D1: 0001適用済みを確認後、0002のみ追加適用。反映後に未適用migrationなしを確認。
- Worker Version: `94f98dde-2f97-4433-8c5e-c554b540a224`、2026-09-26 12:41 UTCに100%切替。
- 両Queueのproducer/consumer、`PRICING_BATCH`自己binding、CATALOG、Yahoo Secret、15分Cronを確認。
- 反映前後のsummaryは1行、queue budget使用数3・Yahoo budget使用数1を保持。
  `default_sync`行を追加。反映直後のdefault登録カテゴリ数は0で、以後のCronで段階的に同期する状態。

この記録はdeployment・設定・migration・既存データ保持の確認結果です。
新versionでの本番Warmup完了・Yahoo取得までの動作確認は未実施です。

## 検証記録

ローカル検証（2026-09-26、実Yahoo/remote Cloudflare未使用）:

- `npm run check`: TypeScript成功、offline unit/SQLite/workerd integration **105件成功 / failure 0 / skip 0**。
- `npm run db:migrate`: WranglerローカルD1へ0001/0002適用。
- `npm run build`: 非公開設定・D1/Queue/Service Bindingを含むbundle生成dry-run。
- `test/runtime.test.ts`: memory caller → Pricing RPC → real D1/Queue/Cron、mock Catalog/Yahoo。
- D1 20件、2 summary存在時: **1 SELECT、rows_read=22、rows_written=0**。
- D1 20件、20 summary存在時: **1 SELECT、rows_read=40、rows_written=0**（最大20 PK probes）。
- D1 50件、50 summary存在時: **1 SELECT、rows_read=100、rows_written=0**。
- 601refを自己Service Bindingで分割するsummary/seed RPC、実2 Queue、default同期→background更新をoffline workerdで検証。
- test内でProviderをblockし、summary RPCが先にpendingを返すことを確認。
- real RPCのinvalid input / D1障害は固定code、HTTPは404。
- unit/SQLite tests: fresh/empty/unsupported/pending/stale/missing、入力順・重複、enqueue suppression、期限、backoff、
  stale保持、旧token fencing、D1 write失敗、candidateのJAN優先/EAN fallback/順序/完全一致、timeout/429/5xx/JSON破損、
  coalescing、Cache API障害、D1共有pacing・minute/day予算、Catalog rebuild競合を検証。

本番CPU時間・account usageの負荷試験、Cloudflareの実配信における長時間backlog/障害注入、実Yahoo smokeは未実施です。

## Gateway反映・停止・監視

公開HTTP契約・ローカル起動は[gateway-http.md](gateway-http.md)を参照。
以下は**手順のみ**で、Gateway本番deploy、remote migration、本番API試験の実行記録ではありません。
いずれも明示承認後に実行します。過去のVersion/migration記録を現在値と推測しないでください。

### 反映手順（承認後）

1. Pricingの稼働Versionと対象commitを照合。
   `npx wrangler deployments status --json`、`npx wrangler versions view <CURRENT_VERSION> --json`などで
   Version annotation/commitとbindingを確認します。対応が不明なら不明と記録し、過去の稼働記録だけで判断しません。
   現行コードの未登録ref永続登録・Provider復旧制御を含むcommitに揃える必要があります。
2. `npx wrangler d1 migrations list pc-parts-pricing --remote`で既存0001/0002/**0003_provider_recovery.sql**の適用状態を確認。
   0003は現行Provider health/recoveryに必要です。未適用なら別途承認された範囲で
   `npm run db:migrate:remote`、必要なPricing本体更新（`npm run deploy`）の順で反映。
   既存DB UUID・Queue・DLQ・Cron・Secretは維持し、作り直しません。Gateway専用migrationはありません。
3. `npm run check`、`npm run build`、`npm run build:gateway`、`npm run build:gateway:initial`を確認。
   `wrangler.jsonc`は本体、`wrangler.gateway.jsonc`はGatewayの安全な初期設定、
   **`wrangler.gateway.production.jsonc`は本番運用設定の正**です。
   両Gateway設定は同じWorker名・PRICING参照先・namespaceを使い、別環境やsuffix付きWorkerは増やしません。
   GatewayにD1/Queue/Cron/Catalog/Yahoo Secret、PricingAdmin/PricingBatchがないことを確認。
4. Gatewayの`PRICING`が同一accountの`pc-parts-pricing` default entrypointを指すことを確認。
   本番用ファイルの`vars.ALLOWED_ORIGINS`を、確定したSheetのHTTPS OriginのJSON配列文字列に設定。
   HTTP、localhost/loopback、`*`、`null`、credentialsやpath/query付きURLは本番検証で拒否します。
   初期ファイルのvarsは`"[]"` / `"false"`のまま維持し、本番値をコピーしません。
   4つのnamespaceがaccount内の他Workerと衝突しないことを確認。
   初期limitは12/60/2/6 requests per 60秒。本番`ratelimits[].simple.limit`は各初期値以下の正の安全な整数へ縮小可能です。
   local Catalog設定の29599001〜29599007 / 29599101〜29599107とは非衝突を確認済みですが、account全体の確認は別途必要です。
   本番用ファイルの`SUMMARY_ENABLED="false"`のまま検証/CIを通し、`npm run deploy:gateway`で先に安全に配置。
   設定確認後、本番用ファイルを`"true"`へ変更し、再度検証/CIを通して、承認後に同じコマンドで反映します。
   有効なのにOrigin空配列は設定忘れとして拒否します。停止中は空配列も既存許可Originも有効な設定です。
   `build:gateway` / `deploy:gateway`は共通検証を通してから**本番用ファイルを明示指定**します。
   `build:gateway:initial`だけが初期ファイルのdry-runです。通常の本番deployで初期停止設定を誤って上書きしません。
   不正設定はCLIの非0終了でWrangler実行前に停止。`--var` / `--config` / `--env`で上書きせず、ファイルを正として運用します。
   workers.devによる公開を想定し、`preview_urls:false`を維持。実際のURLはdeploy出力/設定で確認し、推測しません。
   Dashboard変更は次のdeployで本番用ファイルの値に上書きされるため、repoにも実運用値を反映します。Secretは複製しません。
5. **本番試験も承認後のみ**、Catalogで存在を確認した少数の実在refで限定疎通。
   テストfixture/説明用keyは本番へ送信しません。未登録ならD1書込・非同期Queueを起こすことを前提に、試験件数とpoll回数を事前制限。
   CORS、200/pending→後続結果、no-store/request ID、D1/Queue/Provider予算を観測。100件/全Catalog warmupや負荷試験は行いません。
6. 実Gateway URL、許可Origin、稼働commit/Version、HTTP契約とfixtureのpath、有限polling指針をSheet実装者へ引き渡します。
   Sheet/Catalogのコード・環境変数の変更は別タスクです。

### 緊急停止・縮小・rollback

- 本番用`wrangler.gateway.production.jsonc`の**`vars.SUMMARY_ENABLED`だけを文字列`"false"`へ変更**して反映するとPOSTは503、RPCを呼びません。
  許可Origin、limiter上限・namespace等は保持し、初期ファイルの内容へ置き換えません。
  `npm run check` / `npm run build:gateway`とCIを確認後、承認の範囲で`npm run deploy:gateway`を実行します。
  初期ファイルからのdeployやCLIの`--var`上書きを緊急停止手順には使いません。
  true以外の値/必須設定不備でもfail closedです。既に受理したRPC・Queueは取り消されません。
- 停止はGatewayだけです。Pricing本体のCron、両Queue、予算、lease/fencingを変更・停止しません。
- 縮小は**本番用ファイル**のnative `simple.limit`を下げ、共通検証・dry-run・CIを通してから再反映。通常/大batchの両方を確認。
  60秒periodとRetry-After:60を合わせたまま運用します。Provider/Queue予算やbackoffを緩めないでください。
- `ALLOWED_ORIGINS=[]`だけではOriginなしclientを停止できません。全受付停止には必ずSUMMARY_ENABLEDを使います。
- 緊急時に承認されたDashboard上の一時停止を使う場合も、本番用ファイルのflagをfalseへ同期します。
  そうしないと次のdeployでtrueへ戻る危険があります。再開は元の許可Origin・制限値を保持したままflagだけ戻し、再度CI/承認を経ます。
- GatewayだけのrollbackはCloudflare deploymentsで既知の安全なGateway Versionへ戻します。
  rollback先の許可Origin・受付フラグ・limiter・PRICINGも復元されるので再確認し、本番用ファイルも同期。必要なら停止版をforward deployする方が安全です。
  初回導入なら停止設定で置くか公開route/workers.devをGatewayだけ無効化。本体/D1/Queue/Secretは削除しません。
  本体のrollbackは既存schema/Queue互換性の運用手順に従う別操作です。

### ログと監視

Gateway JSON logは`request_id`, 固定`route`（またはunmatched）, `status`, `batch_count`, `duration_ms`,
`limiter`（not_checked/allowed/denied/unavailable）, 固定`error_code`だけ。
batch_countは未解析・受付前拒否では0（有効batch件数を知ってから記録）。
raw IP/hash、全ref一覧、body、製品名、価格、Secret、例外本文/stackをapplication logへ出しません。
Cloudflare自動request logのURL等は別機能なので、保存範囲・アクセス権・retentionも確認してください。
Gateway設定のinvocation samplingは10%。小規模試験ではlog欠落があり得るため、HTTP status/request IDとmetricsも併用します。

- Workers Logs/Tracesで429・503比率、limiter unavailable、latencyを確認。native limiter単独のDashboard表示に依存しません。
- request IDはGatewayのHTTP応答/ログを照合するIDです。既存Pricing内部へ伝播する分散trace IDではありません。
- D1 Dashboardでread/write、DB size、index込みwrite増加を監視。warm readでも時間bucket touch、新規refなら同期登録がある点に注意。
- Queue Dashboardでbacklog、oldest age、retry、DLQを確認。Pricing logsのsummary status/pending率と組み合わせ、pending滞留の原因を調査。
  必要なD1の限定読取は[production-verification.md](production-verification.md)に従います。全表scanやAPIを使った観測の連打は避けます。
- 503はbinding/flag/Origin設定、Pricing稼働Version、0003適用、D1予算/障害、limiter障害を確認。
  原因をpendingやemptyへ置換したり、Gatewayで無条件retryして隠したりしません。
- 任意ref登録によるD1 writeをQueue/Yahoo日次予算では止められません。
  Gateway native limiterも**拠点別・eventually consistentの近似値**で、分散濫用やFree枠超過を完全には防げません。
  共有keyの1680 ref/分/拠点は**初期設定における名目値**であり、全世界予算・日次安全枠ではありません。
  縮小後は通常枠N・大batch追加枠Lについて`20×N + 80×min(N,L)`を再計算します（例: N=30/L=3なら840）。
  使用量増加時は早期に受付縮小/停止し、必要なら別途認証や厳密な予算方式を検討します（今回新DB/DOは追加しません）。
- **暫定構成の制約:** 旧Catalog Offer APIのYahooアクセスはPricing側D1予算と別です。
  同じアプリIDを使う場合も合算保護はできません。CatalogのYahoo機能/Secretは今回削除・変更していません。

### Gateway初回実装のローカル検証記録（2026-10-25）

- `npm run check`: 型検査とoffline全168テスト成功、failure/skip 0。
- `npm run build` / `npm run build:gateway`: 両Workerのdeploy dry-run成功。実deployではありません。
- mock HTTP契約、実loopback HTTP client、native limiterの429、実Service Binding RPC/D1/Queue、
  Provider待機中の先行pending、永続登録、後続complete、重複enqueue抑制、D1障害503、既存601件RPCを検証。
- CI設定へGateway buildを追加。GitHub Actionsの実行結果はこのローカル検証記録に含みません。
- 本番deploy、remote migration、本番API/実Yahoo試験は未実施（未承認）。
  Pricing本体のコード/設定/migration、およびSheet/Catalogのコードは変更していません。

### Gateway設定管理修正のローカル検証記録（2026-10-25）

- 原因: 初期停止値と本番運用値を同じWrangler設定で管理し、テストがOrigin/flag/limitの初期値へ完全一致を要求していました。
- 本番用ファイルを分離し、共通検証で固定安全条件と変更可能値を区別。初期ファイルは従来の停止設定のままです。
- `npm run check`: 型検査・offline全206テスト成功、failure/skip 0。架空Originでの本番有効化・Origin変更、共有60→30・大batch枠縮小を検証。
- 不正JSON/Origin/flag/limit/period、binding/resource混入、namespace重複を拒否。
  実CLIとnpmのguardを通すテストでも、不正時に**ローカルmock deploy**が呼ばれないことを確認（Wrangler実deployは呼びません）。
- `npm run build`、`npm run build:gateway`（本番ファイル）、`npm run build:gateway:initial`（初期ファイル）のdry-run成功。
- GitHub Actionsは未実行。本番deploy・remote migration・本番APIアクセス・Cloudflare設定変更は一切実行していません。
  Gateway HTTP処理、Pricing本体の処理/設定/migration、Sheet/Catalogのコード、依存バージョンは変更していません。
