# Operations / failure recovery

本番の読み取り専用診断と少数製品試験の準備は[production-verification.md](production-verification.md)を参照。
以下の過去の反映記録は、現在の本番正常性を保証するものではありません。

## Durable enqueue / execution

```text
summary read ── waitUntil ── conditional touch
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
|未登録refへの最初のwaitUntilがtouch前に中断|次回閲覧で再登録|
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
- Queue日次予算はclaimされた件数だけ予約。send障害時に返却しません（安全側の過大計上）。
  残予算がbatch件数より小さいとbatch全体を翌日に延期するため、上限直前で未使用枠が残ることがあります。
- Providerの日次予算は成功数ではなく実検索の開始許可数。0件/429/5xxも1回を消費します。
- 固定60秒窓はrolling windowではありません。pacing/429 cooldownと合わせた保守的な上限です。
- minute/pacingだけの待機はconsumer内で実行（製品全体deadline240秒、1候補最大6 gate試行）。
  実行lease300秒、D1障害のnative retry360秒。日次枠不足・長いcooldownは従来のbackoff＋Cron回収です。

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
