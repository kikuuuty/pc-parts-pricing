# Production verification: read-only diagnosis / bounded smoke preparation

本書は手順と判定基準です。**本番試験の成功記録ではありません。**
実測・対象ref・ログは `.local/production-verification/`（Git除外）へ保存します。
過去のdeployment記録、ローカル実装、今回の本番観測を別々に記載してください。

以下の「今回は実行しない」は読み取り診断時の承認範囲です。後続の本番実行は、別途明示承認された
少数RPC・修正・migration・deployの範囲で行います。プラン/保存ログAPIの権限不足だけで停止せず、
Live tailと対象PKの前後比較を利用できます。再実行時も全試験の累積上限を維持してください。

## 1. 境界と実装経路

読み取り段階では Pricing のRPCを一切呼びません。`getPriceSummaries`も
`waitUntil`内でD1 touch/claim/Queue投入を行います。`requestRefresh`、管理RPC、
Cron手動実行、Queue pull/ack/purge/replay、Yahoo smokeも実行禁止です。
デプロイ・migration・設定変更・Secret値の取得も行いません。

|処理|実装 / 意味|
|---|---|
|default登録|`scheduler/defaults.ts` → Catalog categories、category+limitのみのsearch。カテゴリ一覧6h、due最大4カテゴリ/tick。所属をtransaction置換。価格取得/Queueとは別|
|Cron選定|`scheduler/cron.ts` / `storage/summaries.ts`。複合due index、8件/tick、輪番でhot/recent/month/coldの1枠、残りdefault優先、cold最大1|
|lane|user/manualはinteractive、default/scheduled/coldはbackground。独立consumer。未実行backgroundのinteractive昇格は新tokenで旧deliveryを無効化|
|claim/実行|PK条件付きclaim、25h Queue lease、300s run lease、queue+run tokenで保存をfence。exactly-onceではない|
|再試行|Provider/Catalog失敗は結果を残して15min〜6h backoff→ACK→Cron回収。D1障害はnative retry360s。設定上max_retries=3、共通DLQ|
|Catalog|consumerだけがdurable pairをresolve→一時numeric IDでdetail→同一ref再確認。最大2 HTTP呼出し、各5s。missing/inactiveだけmissing。エラーをmissingに変換しない|
|Yahoo候補|`providers/yahoo/identifiers.ts`。checksum有効JAN8/13、EAN13のみ、region jp/all、JAN→jp→local→字句順、値dedupe、最大3候補。最初の非emptyで終了。候補エラー時は打ち切り|
|Yahoo検索|完全一致jan_code、新品/在庫あり、最大50件を検証・店舗商品dedupe。最大3検索/製品/実行（retryを含む生涯上限ではない）|
|キャッシュ|D1は製品サマリーの正本。別に候補hash+strategy+TTL世代のCache API / isolate completed(128) / inflight(32)。候補hit/coalescedはYahoo admissionなし。両者を混同しない|
|fresh/stale|TTL既定6h。complete/emptyはexpiry後maxStale7日まで旧結果を返す。さらに古いものはRPC上pending。defaultの背景間隔24hはTTLと別なのでstale自体は故障ではない|
|negative|unsupportedは14日後Cronで再解決、interactive再検索なし。missingは1日。emptyは正常な検索済み0件で、失敗ではない。DB未登録はpendingであってmissingではない|
|ログ|`telemetry.ts`の固定event/reason/status/count。ref/tokenは記録しない。Cronはcatchしてerrorをlogするため、runtime successだけではアプリ成功を証明しない|

実値は本番Versionのbindings、script-settings、Queue設定と突合してください。
`config.ts`の上限はCloudflare/Yahooの契約上限ではありません。

既定の内部安全予算（`storage/budget.ts`、UTC日付、固定60秒窓）:

|対象|共有|background|interactive|
|---|---:|---:|---:|
|Queue claim/日|1000|600|800|
|Yahoo admission/日|1500|900|1200|
|Yahoo admission/分|30|6|24|

laneは共有上限とも同時に制限され、未使用枠を移譲しません。pacing既定1000ms、
429は共有cooldown。consumerのadmission待ちは240s deadline/候補最大6回。
claim後に予算を予約しsend失敗でも返却しません。admission数は成功検索数ではありません。

## 2. 本番の読み取り

最初に `git status --short --branch`、`git log -1`、必要なら`git ls-remote origin refs/heads/main`。
既存差分を保持。Node24、lockfileのWranglerを使い、`--version`と各`--help`を確認します。

確認したWrangler 4.141.0の読み取りコマンド例:

```powershell
npx --no-install wrangler whoami --json
npx --no-install wrangler deployments status --json
npx --no-install wrangler versions view <CURRENT_VERSION> --json
npx --no-install wrangler secret list
npx --no-install wrangler d1 info pc-parts-pricing --json
npx --no-install wrangler queues info pc-parts-pricing-refresh
npx --no-install wrangler queues info pc-parts-pricing-interactive
npx --no-install wrangler queues info pc-parts-pricing-dead-letter
```

whoami/version出力にはメール等が含まれ得るので、そのまま公開保存しません。
Secretは名前・typeだけ確認します。Versionにcommit annotation/tagがなければ、
mainとの対応は未確認です。過去の記録と同じVersion IDであることは補助証拠にとどまります。

公式RESTのGETでscript-settings、schedules、subdomain、routes、Queue detail/metricsを確認。
両producer/consumer、DLQ、batch/concurrency/retry/retention、preview、自己entrypoint、
CATALOG production、D1 UUID、observability/log persist/samplingを突合します。
認証は既存Wrangler認証か安全な環境変数を利用し、tokenを表示・ファイル保存しません。

### D1: 段階実行（自動連続実行しない）

1. `scripts/diagnostics/01-schema.sql`: schema/index/migration適用名、最大2001行の件数probe。
2. 実schemaがSQLと一致し、summary/所属が各2000以下の場合のみ`02-plan.sql`。
3. planの走査範囲を承認してから`03-state.sql`を1回。
   2001なら途中で打ち切った値です。全表集計を実行せずcategory/PK範囲へ縮小します。

**`wrangler d1 execute --file`はimport経路なので診断には使いません。**
EXPLAINだけでもimport結果の`changed_db=true`になり得ます。
SQLファイルを確認後、コメントを除き1行にして`--command`へ渡します（PowerShell）:

```powershell
$sql = (Get-Content scripts/diagnostics/01-schema.sql -Raw) -replace '--[^\r\n]*',' ' -replace '\s+',' '
node node_modules/wrangler/bin/wrangler.js d1 execute pc-parts-pricing --remote --json --command "$sql"
# 出力を確認してから02-plan、続いて03-state。ループ/一括実行しない。
```

`meta.rows_read/rows_written/changed_db`と取得時刻を記録。初回診断は全体1万read程度を
暫定停止目安とし、超えそうなら停止して範囲を再設計。LIMIT付き集計も全走査になり得ます。
継続ポーリングでは全表集計を使わず、試験refのPK lookupのみ最大開始/中間/終了の3回。

時刻列はUnix **ms**、`work_budget.day`はepochからのUTC日数、minuteはepoch分数です。
保存dayが本日と違う場合の当日消費は0（保存値は履歴として別表示）。履歴tableではないので
前日使用量の復元には使えません。`default_sync`行のday=0はYahoo消費ではありません。
no_fetched_atには正常なunsupported/missingも含まれます。due/backoff/leaseは重なるflagです。
追加の代表例は少数のstatus別またはPK検索。token列や全件の生データは保存しません。

### Catalog / Warmup照合

まず2カテゴリまで、最新production Catalogのhealthと`/v1/search?category=...&limit=20`を読み、
`default_warm_ref WHERE category=...`とsource+upstream_key集合で比較します。
sort/q/filter/cursorを付けず、meta.limit/offset/returnedも確認。
公開Catalog応答はService Binding経路そのものの疎通試験ではありません。
missing行があれば最新Catalogのread-only resolve/detailでmissing/inactiveを確認。
numeric IDを保存せず、resolve/detail競合やrelease中の不一致を考慮します。

登録、enqueue、Catalog解決、Yahoo実検索、D1保存、価格ありは別々の証拠です。
サマリーのfetched_atだけでは「今回実Yahooへ到達」を証明できません（候補cache hitがある）。

### Metrics / logs / 使用量

- GraphQL `workersInvocationsAdaptive`: script別requests/errors/outcome、CPU quantile。
  CPUフィールドの単位はschema descriptionで確認（microseconds→ms）。quantileから総CPUを計算しない。
- `d1AnalyticsAdaptiveGroups`: 全DBのrowsRead/rowsWritten。database一覧/sizeも確認。
  `d1 info`の24h=0が他の観測と矛盾すれば、0を稼働停止の根拠にしない。
- `queueMessageOperationsAdaptiveGroups`: queue/action/outcome別billableOperations、retryCount/lag。
  adaptive集計値を正確なmessage数やbilling請求値と同一視しない。
- Queue REST `/queues/{id}/metrics`: backlog_count、oldest_message_timestamp_ms（0ならageはN/A）、DLQ。
- 既存保存ログのprovider 2xx/429、candidate miss/hit、saved/deferred/retry、scheduler errorを確認。
  取得権限がなければ未確認。サンプリング欠落は「エラーなし」ではなく、10倍して正確な消費ともみなさない。

UTCの完了日 `[00:00,next 00:00)` と当日途中 `[00:00,取得時刻)` を分離。
UTC 00:00はJST09:00。Catalog最新release時刻を別の境界として前後を分離しますが、
release以前全体を障害期間とは呼びません。復旧時刻の別証拠が必要です。
直近数時間を24時間に外挿しません。Pricing、Catalog、他Worker/旧DB、同期日の書込も含めます。

契約はBilling画面またはsubscriptions GETで確認。usage_model=standardだけでPaidを断定しません。
確認不可ならFree/Paidの料金表は比較例のみ。FreeはWorkers100k requests/日、D1 5M reads/
100k writes/日、Queues10k ops/日。Paidは月次枠であり、日次無料枠として扱いません。
D1のindex更新にもwriteが加算されます。Queueは通常小message当たりwrite/read/deleteの3ops、
retryは追加read、DLQも追加ops。Pricingのclaim予算1000はQueue ops1000ではありません。
Yahoo実キーの利用制限・他callerとの共有は別確認。FAQの短時間規制条件は非公開です。
内部UTC予算をYahoo側のリセット時刻とみなしません。
「アカウント全体70%以内」は暫定安全目安であり、公式上限/保証ではありません。

default件数Dに対し最悪daily一巡のQueue余裕は600-D（再試行/他tierを含まない）。
現status別のsteady-state見積りはcomplete/empty約1回/日、unsupported約1回/14日。
Yahooは対応製品1実行最大3miss、candidate cache hitなら0。新Catalog集合の入替や
全ref seed、再送/再解決、index更新を加えた別のrelease-day予算が必要です。

## 3. 次段階の少数製品試験（今回は実行しない）

### 前提とcaller

既存の本番内部callerはリポジトリ内にありません。`test/runtime.test.ts`はoffline専用、
`smoke-yahoo.ts`はQueue/Catalog/D1を迂回するため本番経路試験の代わりにはなりません。

`smoke-pricing.ts`は**既定dry-run**です。認証/remote proxy/Providerの起動も行いません。
live分岐はWrangler公式`getPlatformProxy`+remote Service Bindingを利用し、
本番Pricingのdefault entrypointを呼びます。Pricingソースをローカル実行するのではありません。
ローカルcaller用configをGit除外領域へ一時生成し、終了時dispose/削除します。
公開HTTP adapter、admin/self-binding、Yahoo Secretの転送はありません。
本番Workerへの追加deploy/永続設定変更は不要な方式ですが、Wranglerの一時remote-proxy
セッションを作るのでlive開始には別途承認が必要です。本番接続は準備段階では未検証です。
接続非対応/認証/RPCエラーなら停止し、`dev --remote`や公開Gatewayへ自動fallbackしません。

対象を5〜10件、実CatalogとPK lookupから選び、選定時刻/状態/理由/期待結果をローカルreportへ。
入力JSONはProductRef[]だけ。ID/name/category/provider等をRPC入力へ追加しません。
未登録で対応識別子あり、fresh価格、表示可能stale価格、unsupported、emptyを含めます。
無い状態は欠測扱いとし、DB書換えで作りません。実行直前にも状態・fresh期限を再確認。

```powershell
# 安全: dry-runのみ。targets.jsonはローカル実データから作成する。
npm run smoke:pricing -- --targets .local/production-verification/targets.json

# 以下は次段階の明示承認後のみ。今回実行しない。
npm run smoke:pricing -- --targets .local/production-verification/targets.json --production --confirm pc-parts-pricing@ac7e9239a1eb4f0c95b2558dc6298eb5 --duplicate-pending
```

固定上限: **10製品**、poll最大8回、間隔10〜30秒、総時間最大180秒（既定120秒）、
RPC/接続1回最大10秒。初回1+任意pending重複1+poll8=最大10 RPC、最大100 summary対象。
超過入力の自動分割なし、エラー再試行なし。requestRefreshは呼ばず、summary pollingだけです。
初回に対象アカウント/環境/件数/副作用/上限を表示。終了結果は成功認定でなく観測の補助です。

通常、対象Nの最大初回claimはN、再配送がない1実行のYahooは最大3N、通常Queueは約3N ops。
これは総消費のハード上限ではありません。既存background昇格、native retry/Cron/backoff、
touch、複数候補、期限越えで増加します。D1はclaim/run/finish/budget/touchとindex分が加算され、
正確なwrite数は実meta/Metricsが必要。全体カウンター差を全て試験へ帰属させません。

### 試験表と観測

|試験|操作と成功条件|
|---|---|
|A 未取得|まず未取得1件を単独入力、summary pending→Queue→Catalog→Yahoo→D1→RPC。provider miss+allowed+2xxとsavedを同一invocation/対象時間帯で相関。最低1件で実HTTP成功の証拠が必要。completeと正常emptyは別結果|
|B fresh|fresh期限内に再読。保存値/fetched_atが維持され不要claim/Yahooが増えない。hourly touchまでは禁止しない|
|C pending重複|Aが自然にpendingなら`--duplicate-pending`で1回だけ重ねる。対象PKのleaseと新規送信を観測、再投入が増え続けない。すぐ完了した場合は未検証とする|
|D stale|旧価格を返しつつinteractive更新。自然に失敗があれば旧正常値が消えないことを確認。障害注入/DB操作はしない|
|E negative|unsupportedはYahooなし、fresh emptyは保存結果を再利用。期限切れemptyの正常再検索は許容。empty/unsupported/missing/エラーを混同しない|
|F lane|自然なbackground処理が存在する時間だけinteractiveの進行を観測。大量backlogは作らない。背景処理が無ければ未検証|

A単独試験と他のsubset試験を合わせて、unique対象最大10件・**全試験合計10 RPC/180秒**を
手動台帳で管理します。スクリプトの上限は1実行単位です。再起動で無制限に繰り返さないこと。
各subsetではpoll数を減らし、合計上限に余裕がなければ未実施にします。

開始/中間/終了のPK snapshot、Queue metrics、work_budgetの日付付きsnapshot、既存ログを使用。
DB summary再利用とcandidate cache hitは別々に判定。hitを出すための大量試行は禁止。
現telemetryはref/tokenなし、samplingもあるため、時刻と全体counterだけでは厳密な相関が
できない場合があります。その場合は「実Yahoo確認不足」と記録し、成功扱いにしません。

停止条件: 最初のtransport429/接続/設定/RPC障害で即停止（無制限再試行なし）、
監視でProvider429/保護エラー/保存失敗/DLQ増加/予算枯渇を見つけたらCtrl+C。
Provider429はsummary RPCへ直接公開されないため、**別のDB/ログ監視が必要**です。
期限終了pendingはbudget、backlog/oldest、retry_after、queued_until/run_untilを確認してから評価。
停止しても既に投入されたQueue/実行中Yahooは取り消しません。purge/lease解除はしません。
通常終了はdispose、強制終了時はlocal caller configとproxyセッションの終了を確認。
本番リソースの撤去は不要です。

## 4. ローカル検証 / 記録

`npm run check`はmock境界の単体/SQLite/workerdテスト、`npm run build`は
`wrangler deploy --dry-run --outdir dist`のみ。`deploy`、remote migration、実Yahoo smokeは実行しません。
追加テストはdry-run無接続、入力/件数/時間/poll上限、即時エラー停止、ログ秘匿、
query_only SQL、offline Node Service Binding RPCを検証します。

ローカルreportの章: (1)commit/本番Version/観測時刻期間、(2)各項目の確認済み/問題あり/未確認と根拠、
(3)事実/推測/影響/試験前対応/最小案、(4)変更/テスト、(5)製品・手順・副作用・予算・停止・成功基準、
(6)進行可否/不足観測。API403や欠測を0で補完しません。認証情報のチャット貼付は求めません。

## 公式資料（2026-10-25参照）

- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Wrangler API / getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy)
- [Remote bindings](https://developers.cloudflare.com/workers/local-development/#remote-bindings)
- [Bindings support](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)
- [Workers settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/)
- [Existing logs query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
  （`dry:true`、権限名はWorkers Observability Writeだがここでの操作は既存ログqueryのみ）
- [Billing subscriptions GET](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/)
  （Billing Read、または担当者のBilling画面確認）
- [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [Queues metrics / realtime REST](https://developers.cloudflare.com/queues/observability/metrics/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Yahoo usage rules](https://developer.yahoo.co.jp/appendix/rate.html) /
  [Shopping FAQ](https://developer.yahoo.co.jp/webapi/shopping/faq.html#requestlimit)
