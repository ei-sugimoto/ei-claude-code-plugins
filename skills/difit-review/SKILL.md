---
name: difit-review
description: difit (ローカルGit差分レビューツール) を cmux のサーフェス(タブ)で起動し、UI も cmux のブラウザサーフェス(タブ)で開く。ユーザーがそのサーフェスでレビューして閉じると、そのサーフェスに流れるコメントを background 監視で自動回収して各指摘に沿ってコードを修正するまでを一気通貫で行う。手動の「Copy All Prompt」貼り付けを不要にする。レビュー中でもサーフェスを閉じずに `curl` でその時点までのコメントを随時取得できる。Use this skill whenever the user wants to review their own changes with difit and have the comments applied — phrases like "difitでレビュー", "difit立ち上げて", "difitのコメント反映して", "difitで指摘したやつ直して", "review with difit", "difit起動してコメント取り込んで", "途中のコメント見せて", "サーフェス閉じずにコメント取得して". difit と cmux の連携が意図されているとき。
---

# difit-review (起動 → ブラウザサーフェスを閉じる → コメント自動回収 → 修正)

difit ([yoshiko-pg/difit](https://github.com/yoshiko-pg/difit)) はローカルで Express サーバーを立ち上げ、Git 差分を GitHub 風 UI でブラウザレビューできる CLI。**`--keep-alive` を付けずに起動すると、レビュー用のブラウザを閉じた時点でサーバーが終了し、その際に付けたコメントが「Copy All Prompt」と同一の整形テキストで標準出力に列挙される**（検証済みの挙動）。

このskillは **difit を cmux の新規ターミナルサーフェス(タブ)で起動（OS デフォルトブラウザは開かせない） → UI を cmux の新規ブラウザサーフェス(タブ)で開く → difit サーフェスを background で監視 → ユーザーがそのブラウザサーフェスでレビューして閉じる → 流れてきたコメントを回収 → 各指摘に沿って即修正** までを担う。ユーザーは「終わった」と伝え直す必要すらなく、**ブラウザサーフェスを閉じるだけ**でよい。手動の「Copy All Prompt」コピペを不要にするのが目的。

**ペイン分割はしない**。ターミナルもブラウザも `cmux new-surface` で新しいサーフェス（タブ）として追加する。

cmux の操作詳細は [[run-cmux]] スキル (`${CLAUDE_PLUGIN_ROOT}/skills/run-cmux/SKILL.md`) の語彙・コマンドに従う。

## 責務と原則

- difit のコメントは **ユーザー自身が書いた自分のコードへのレビュー指摘**。信頼して各指摘に沿って **即修正してから報告** する（codex-review のような妥当性検証フェーズは挟まない。ただし指摘が技術的に成立しない/壊れる場合は直さずその旨を伝える）
- `git commit` / `git push` は **しない**（ユーザーが明示的に指示したときのみ）
- **UI は OS デフォルトブラウザではなく cmux のブラウザサーフェス(タブ)で開く**（difit は `--no-open` で起動し、取得した URL を `cmux new-surface --type browser` で cmux 内の新規タブとして表示する）
- **ペイン分割はしない**。ターミナル・ブラウザとも `cmux new-surface` で新しいサーフェス（タブ）として開く
- **既定はブラウザ切断トリガー方式**（`--keep-alive` なし）。cmux のブラウザサーフェスを閉じた時点でサーバーは自走終了するので、回収後のサーバー停止操作は不要。残った空サーフェスのクローズだけ後始末する
- **途中経過の取得にサーフェスを閉じる必要はない**。`/api/comments-output` はレビュー中いつでも `curl` で読める読み取り専用エンドポイントなので（詳細は Step 4）、ユーザーが「今のコメント見せて」等と言ったらそれで即応じる
- 調査・修正プロセスは逐次ユーザーに見せる

## 前提

- difit はローカルに導入済み（確認: `command -v difit` → 5.0.2 を確認済み。無ければ `npx difit` でフォールバック）
- cmux が起動しデーモン到達可能（`cmux ping` → `PONG`）。到達しなければ「cmuxが起動していません。`/Applications/cmux.app` を開いてください」と伝えて中断
- カレントが Git リポジトリであること

---

## Step 1: 環境チェックと対象の決定

```bash
cmux ping >/dev/null 2>&1 || { echo "cmux unreachable"; exit 1; }
REPO=$(git rev-parse --show-toplevel) || { echo "not a git repo"; exit 1; }
command -v difit >/dev/null 2>&1 && DIFIT=difit || DIFIT="npx difit"
```

レビュー対象は引数で受ける。**デフォルトは未コミット変更 `.`**:

| 引数 | difit 対象 |
|---|---|
| なし（デフォルト） | `.` — working tree の全変更 |
| `staged` | ステージ済みのみ |
| コミットhash | そのコミット |
| ブランチ名 / `<base>` | そのブランチ/base との差分 |
| `--pr <url>` | GitHub PR |

差分が空なら（`git status --porcelain` 等で確認）、対象を変えるかユーザーに確認する。

## Step 2: cmux の新規サーフェス(タブ)で difit サーバーを起動

**ペイン分割はしない**。`cmux new-surface` で新しいターミナルサーフェス（タブ）を作り、surface ref を控える:

```bash
# 出力例: "OK surface:20 pane:16 workspace:11"
OUT=$(cmux new-surface --type terminal --focus false)
SURF=$(echo "$OUT" | grep -o 'surface:[0-9]*' | head -1)
```

新規サーフェスの cwd は不定なので、リポジトリへ `cd` してから difit を起動する。`send` は Enter を押さないので必ず `send-key Enter` を続ける。**起動オプションは必ず `--clean --no-open` を付ける**。

- `--clean`: 前回セッションのコメント・既読状態が localStorage に残っているため、付けないと過去の指摘が混ざる。毎回まっさらな状態でレビューを始める
- `--no-open`: OS のデフォルトブラウザを自動で開かせない。UI は Step 3.5 で cmux のブラウザサーフェスとして開く
- **`--keep-alive` は付けない**（付けないことで Step 3.5 で開いたブラウザサーフェスを閉じた瞬間にサーバーが終了し、コメントが stdout に列挙される）

```bash
cmux send     --surface "$SURF" "cd $REPO && $DIFIT <TARGET> --clean --no-open"
cmux send-key --surface "$SURF" Enter
```

`<TARGET>` は Step 1 で決めたもの（デフォルトは `.`）。`--clean` / `--no-open` 等のオプションは `<TARGET>` の後ろに並べる。

## Step 3: ポート/URL を取得

difit は起動時に待受 URL を stdout に出す（デフォルト 4966、使用中なら 4967…）。サーフェスの画面を読んで URL を拾う:

```bash
sleep 2
SCREEN=$(cmux read-screen --surface "$SURF" --lines 40)
URL=$(echo "$SCREEN" | grep -oE 'https?://(127\.0\.0\.1|localhost):[0-9]+' | head -1)
```

URL がまだ出ていなければ `sleep` を足して `read-screen` を再試行する。

## Step 3.5: URL を cmux の新規ブラウザサーフェス(タブ)で開く

`--no-open` で起動しているので OS ブラウザは開いていない。**ペイン分割はしない**。取得した URL を `cmux new-surface --type browser` で新しいブラウザサーフェス（タブ）として開く。ユーザーがすぐレビューできるよう `--focus true` でフォーカスする。返ってくる surface ref（`BSURF`）を控える:

```bash
# 出力例: "OK surface:5 pane:5 workspace:11"
BOUT=$(cmux new-surface --type browser --url "$URL" --focus true)
BSURF=$(echo "$BOUT" | grep -o 'surface:[0-9]*' | head -1)
```

ユーザーに**「開いた cmux のブラウザサーフェスでレビューしてコメントを付け終わったら、そのサーフェスを閉じてください。閉じたら自動で回収して修正します」と伝える**。

## Step 4: サーフェスを background で監視（コメントが流れるのを待つ）

difit サーフェスを **`Bash` の `run_in_background: true`** でポーリングし、ブラウザ切断時の出力ブロックが現れたら本文を出力して終了させる。終了時にハーネスが通知してくれるので、ユーザーのレビュー中もこちらは待てる。`SURF` は Step 2 で取得した値に置き換えて起動すること:

```bash
# run_in_background: true で起動する
SURF=surface:NN
BSURF=surface:MM
# ユーザーがブラウザサーフェスを閉じるまで無期限に待つ（タイムアウトなし）
while true; do
  S=$(cmux read-screen --surface "$SURF" --scrollback --lines 300 2>/dev/null)
  # コメントが1件以上 → ブロックをそのまま出力して終了
  if printf '%s' "$S" | grep -q "Comments from review session:"; then
    printf '%s\n' "$S" | sed -n '/Comments from review session:/,/Total comments:/p'
    exit 0
  fi
  # コメント0件のままサーバーが終了した場合
  if printf '%s' "$S" | grep -q "shutting down server"; then
    sleep 2
    S=$(cmux read-screen --surface "$SURF" --scrollback --lines 300 2>/dev/null)
    if printf '%s' "$S" | grep -q "Comments from review session:"; then
      printf '%s\n' "$S" | sed -n '/Comments from review session:/,/Total comments:/p'
    else
      echo "DIFIT_NO_COMMENTS"
    fi
    exit 0
  fi
  sleep 3
done
```

`SURF` / `BSURF` は Step 2 / Step 3.5 で取得した値に置き換える。監視を起動したら、ユーザーに「ブラウザサーフェスを閉じたら自動で続けます」と伝えて **このターンを終える**。背景プロセスの終了通知が来たら Step 5 へ。ループにタイムアウトは設けていないため、レビューがどれだけ長引いてもブラウザサーフェスを閉じるまで監視し続ける（ユーザーが Bash の background タスクを明示的に止めない限り監視は続く）。

- 通知の本文に `Comments from review session:` ブロックがあれば、それが回収したコメント
- `DIFIT_NO_COMMENTS` ならコメント無し → 修正不要。Step 6 へ

**サーフェスを閉じずに、レビュー中いつでも今までのコメントを取得できる**: `/api/comments-output`（整形テキスト）と `/api/comments-json`（構造化JSON）は **`--keep-alive` の有無に関係なく常時有効な読み取り専用エンドポイント**（difit 5.0.2 ソース `src/server/server.ts` で確認済み。`--keep-alive` はブラウザ**切断後**にサーバーを生かし続けるかどうかにしか関わらない別設定で、閉じずに覗き見るだけなら不要）。サーバー稼働中なら Step 3 で取得した `$URL` に対して既定の起動フロー（`--keep-alive` なし）のまま:

```bash
curl -fsS "$URL/api/comments-output"
```

でその時点までの投稿済みコメントをいつでも取得できる。ユーザーから「今ついてるコメント見せて」「途中まで直しておいて」と言われたら、ブラウザサーフェスを閉じるよう頼まずにこれで応じてよい。コメント0件なら空文字が返る。difit は既定で `localhost` にバインドして `http://localhost:<port>` を出力するので、ホストは決め打ちせず `$URL` を使う。これはレビューを終わらせる操作ではないので、Step 4 の background 監視（ブラウザを閉じた時点の最終回収）と併用してよい。途中取得後もユーザーはレビューを続けられ、追加・変更されたコメントは次の取得や最終回収で反映される。

**ブラウザ切断後もサーバーを生かし続けたい場合の代替**: 複数回に分けてレビューする等、切断トリガー方式そのものを使いたくない場合は `--clean --no-open --keep-alive` 付きで起動し、上記の `curl` で好きなタイミングで回収したうえで、Step 6 で明示的にサーバーを停止する。

取得テキストの形式（実測）:
```
📝 Comments from review session:
==================================================
src/app.ts:L10-L15
<コメント本文>
（suggestion があれば ORIGINAL: / SUGGESTED: のコードブロック）
（返信は "Reply N (author)" プレフィックス）
=====
<次のスレッド>
==================================================
Total comments: <件数>
```

`path:L42` または範囲 `path:L42-L48` が指摘箇所。

## Step 5: 各指摘に沿って即修正

回収したブロックの各スレッドについて:

1. `path:Lxx` の該当箇所を `Read` で開く
2. コメント本文（+ suggestion があればそのコード）に沿って `Edit` / `Write` で **修正する**
3. 1スレッドに複数返信がある場合は文脈を踏まえる。同じ箇所に複数指摘が絡む場合は整合を取ってまとめて適用
4. 指摘が技術的に成立しない / 適用すると壊れる場合だけは直さず、理由を添えて報告（それ以外は基本従う）

全件処理したら `git diff` の抜粋を見せ、関連するテスト/lint の実行を提案する。

```
## difit レビュー反映結果
- 対象: <. / staged / <hash> / branch ...>
- コメント: N 件回収

1. <file:line> — <指摘の要約>
   → <どう直したか / 修正差分の要点>
2. ...

（見送った指摘があれば）
- <file:line>: <指摘> → <直さなかった理由>
```

## Step 6: 後始末

既定（`--keep-alive` なし）では **ブラウザサーフェスを閉じた時点でサーバーは既に終了している** ので、停止操作は不要。残った difit サーフェスを閉じる。ブラウザサーフェス（`BSURF`）はユーザーが閉じて切断トリガーになっている想定だが、まだ残っていれば併せて閉じる:

```bash
cmux close-surface --surface "$SURF"    # difit サーバーの端末サーフェス
cmux close-surface --surface "$BSURF"   # ブラウザサーフェス（既に閉じていればエラーは無視）
```

`--keep-alive` 付きの代替フローを使った場合のみ、サーバーがまだ生きているので先に停止する:

```bash
cmux send-key --surface "$SURF" ctrl+c   # キー名は ctrl+c。C-c は不可
cmux close-surface --surface "$SURF"
```

サーフェスのクローズは、ユーザーがそのサーフェスで他の作業をしていないことを確認してから行う。

---

## エッジケース

- **difit 未導入**: `npx difit` でフォールバック（初回は取得で数秒かかる）。それも失敗するなら導入を促す
- **ポートがずれる**: 4966 が使用中だと difit は 4967… にずれる（実測確認済み）。必ず Step 3 の `read-screen` から URL を取得し、ポート決め打ちしない。代替の curl 回収を使うときも URL から port を取る
- **ctrl+c ではコメントは出ない**: SIGINT（ctrl+c）だと `👋 Shutting down difit server...` だけで **コメントはダンプされない**（実測）。stdout ダンプは **ブラウザ切断**（`Client disconnected, shutting down server...`）固有の挙動。cmux のブラウザサーフェスを閉じても webview が破棄されて接続が切れるので同じトリガーが発火する。だから既定フローは「ユーザーがブラウザサーフェスを閉じる」で回す。初回利用時は実際にサーフェスを閉じてコメントがダンプされるか一度確認しておくと安全
- **監視のトリガー語**: ブラウザ切断時は `Client disconnected, shutting down server...` に続けて `📝 Comments from review session:` ブロックが出る。Step 4 の監視は前者の `shutting down server`（0件ケース込み）と後者のブロックの両方を見る
- **背景監視の sleep**: ポーリングの `sleep` は `run_in_background: true`（バックグラウンド実行）の中でのみ使う。フォアグラウンドでは sleep は不可
- **API エンドポイントがバージョンで変わる**: 代替の `/api/comments-output` / `/api/comments-json` は README 未記載の実装ベースの仕様（difit 5.0.2 で疎通確認済み）。将来 404 になったらブラウザ切断の stdout 方式に寄せる
- **cmux のハンドルは不安定**: `surface:20` 等のインデックスは reorder/close でずれる。このskillは起動直後に取得した ref を一連の流れで使い切るので通常は問題ないが、途中でユーザーがサーフェスを操作した場合は `cmux tree` で取り直す
- **差分が空**: difit を起動しても見るものが無い。対象を変えるかユーザーに確認
- **ブラウザサーフェスの起動に失敗**: `cmux new-surface --type browser` が失敗・ref を取れなかった場合は、Step 3 で取得した URL をユーザーに渡して手動で開いてもらう（OS ブラウザでも cmux の `cmux browser open` でも可）。`--no-open` で起動しているため、何かで開かない限り UI は表示されない
- **画面が白フラッシュ→茶色っぽく変色する**: cmux WKWebView の合成バグで、difit の選択行ハイライト（`after:absolute` 疑似要素の背景色）が画面全体ににじむことがある（cmux 0.64.17 / macOS 26.5 で実測確認）。ページ側の DOM/CSS は正常なので difit や差分内容を疑わない。フォームを Cancel して開き直すと収まる

## なぜ cmux のサーフェス(タブ)で動かすのか

difit はサーバーが起動し続ける常駐プロセス。cmux の新規サーフェス（タブ）に分離して常駐させ、そのサーフェスを background で監視することで、Claude 側のシェルをブロックせず、ユーザーがブラウザサーフェスを閉じた瞬間に流れるコメントを取りこぼさず拾える。UI も OS のデフォルトブラウザではなく cmux のブラウザサーフェス（タブ）で開くことで、レビュー画面・difit サーバー・修正作業がすべて cmux 内に収まる。ペイン分割ではなくタブで開くため既存のレイアウトを崩さない。ユーザーは「終わった」と入力し直す必要がなく、ブラウザサーフェスを閉じるだけで修正まで進む。
