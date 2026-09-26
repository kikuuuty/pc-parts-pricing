# Operations / failure recovery

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
user/manualはunsupportedを除外。scheduled/coldは`next_refresh_at <= now`を追加条件にします。
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
- cold laneはhotを優先するため、混雑時の完全warmup完了時刻は保証しません。

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

## 検証記録

ローカル検証（2026-09-26、実Yahoo/remote Cloudflare未使用）:

- `npm run check`: TypeScript成功、offline tests **75件成功 / skip 0**。
- `npm run db:migrate`: WranglerローカルD1へ0001適用。
- `npm run build`: 非公開設定・D1/Queue/Service Bindingを含むbundle生成dry-run。
- `test/runtime.test.ts`: memory caller → Pricing RPC → real D1/Queue/Cron、mock Catalog/Yahoo。
- D1 20件、2 summary存在時: **1 SELECT、rows_read=22、rows_written=0**。
- D1 20件、20 summary存在時: **1 SELECT、rows_read=40、rows_written=0**（最大20 PK probes）。
- test内でProviderをblockし、summary RPCが先にpendingを返すことを確認。
- real RPCのinvalid input / D1障害は固定code、HTTPは404。
- unit/SQLite tests: fresh/empty/unsupported/pending/stale/missing、入力順・重複、enqueue suppression、期限、backoff、
  stale保持、旧token fencing、D1 write失敗、candidateのJAN優先/EAN fallback/順序/完全一致、timeout/429/5xx/JSON破損、
  coalescing、Cache API障害、D1共有pacing・minute/day予算、Catalog rebuild競合を検証。

本番CPU時間・account usageの負荷試験、Cloudflareの実配信における長時間backlog/障害注入、実Yahoo smokeは未実施です。
