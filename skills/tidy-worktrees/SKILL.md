---
name: tidy-worktrees
description: カレントプロジェクトの .claude/worktrees 配下に溜まった git worktree を、状態(マージ済み/作業ツリーがクリーン/未pushコミットの有無)を調べたうえで安全に整理(削除)する。Claude Code の worktree 機能で作られて使い終わったまま放置された worktree を片付ける用途。Use this skill whenever the user wants to clean up, organize, or remove leftover git worktrees under .claude/worktrees — phrases like "worktree整理して", "worktree片付けて", "使ってないworktree消して", "古いworktree掃除", "clean up worktrees", "tidy worktrees", "worktree溜まってるから整理". ユーザーが worktree の整理・掃除・削除を意図しているとき、明示的にディレクトリ名を言わなくても使う。
---

# tidy-worktrees (.claude/worktrees の整理)

Claude Code の worktree 機能は作業ブランチごとに `<repo>/.claude/worktrees/<name>` を作る。マージ済みになっても自動では消えず溜まっていくので、このスキルで **状態を調べて → 一覧で見せて → ユーザーの承認を得て → まとめて削除** する。

worktree とブランチの削除は取り消しにくい。だから **勝手に消さない**。必ず状態の一覧を提示し、ユーザーが消す対象を確認・承認してから実行する。これが本スキルの最重要原則。

## 整理の基準(削除候補=safe の条件)

worktree を「消してよい(safe)」とみなすのは次を **すべて** 満たすとき:

- **マージ済み** — ベースブランチ(メイン worktree が今いる develop/master/main 等)から到達可能、または対応 PR が MERGED
- **作業ツリーがクリーン** — 未コミットの変更(staged/unstaged/untracked)が無い
- **未pushコミットが無い** — リモートに存在しないローカル限定コミットが残っていない

どれか欠けるものは安易に消さない。未コミット変更や未pushコミットがあるものは `keep`(消すと作業が失われる)、PR が OPEN 等まだ判断が要るものは `review` として扱い、削除候補から外して理由とともに見せる。

worktree を削除するときは、対応するローカルブランチも一緒に削除する(ユーザーの基準)。

## ワークフロー

### 1. スキャン

カレントディレクトリが対象プロジェクト。スキャンスクリプトを実行して各 worktree の状態を取得する:

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/tidy-worktrees/scan.sh"
```

TSV で1行1 worktree、列は `path / branch / dirty / unpushed / merged_base / pr_state / recommend`。
- `dirty`: `yes`(未コミット変更) / `no` / `missing`(git登録はあるが実体が無い幽霊)
- `unpushed`: `yes` / `no` / `unknown`
- `merged_base`: `yes`(ff/merge でベースに取り込み済み) / `no`。squash merge はここが `no` になるので `pr_state` で補完される
- `pr_state`: `MERGED` / `OPEN` / `CLOSED` / `NONE` / `UNKNOWN`(gh 不可)
- `recommend`: `safe` / `review` / `keep`

出力が空なら整理対象の worktree は無い。その旨を伝えて終了する。

`gh` が未インストール/未認証だと `pr_state` は `UNKNOWN` になる。その場合 squash merge は検知できないので、`merged_base=no` でも実は merged のことがある。判断が曖昧なものは `safe` と言い切らず `review` 扱いで見せる。

### 2. 一覧提示

スキャン結果を読みやすい表でまとめ、推奨を添えて提示する。`recommend` 順(safe → review → keep)に並べると分かりやすい。各行に「なぜその推奨か」が一目で分かるようにする。例:

```
.claude/worktrees の worktree 一覧 (5件):

✅ 削除候補 (safe) — マージ済み・クリーン・未push無し
  1. feature+add-kms-giftee-production   (feature/add-kms-giftee-production)   PR: MERGED
  2. fix+update-giftee-gift-issue-url     (fix/remove-giftee-gift-issue-api-url-dev)  PR: MERGED

🔶 要判断 (review)
  3. feat+giftee-reward-env-production    (worktree-feat+...)   PR: OPEN — まだ開いている

🔒 保持 (keep)
  (なし)

削除候補の 1, 2 を worktree ごと削除し、対応ブランチも消します。よろしいですか?
(review のものも消す場合は番号を指定してください)
```

`missing`(幽霊)があれば「git登録だけ残っているので prune で掃除します」と添える。

### 3. 承認を待つ

削除対象・影響(worktree ディレクトリとローカルブランチが消えること)を明示してユーザーの承認を得る。ユーザーが対象を絞ったり追加したりしたら、それに従う。承認が無いまま削除しない。

### 4. 削除実行

承認された各 worktree について、メイン worktree のディレクトリから次を実行する:

```bash
# worktree を削除(未コミット変更が残っていると --force 無しでは失敗する=安全弁)
git worktree remove "<path>"

# 対応するローカルブランチを削除(マージ済みなら -d で消せる)
git branch -d "<branch>"
```

- `git worktree remove` は dirty だと失敗する。これは安全弁なので **勝手に `--force` を付けない**。失敗したら理由を伝え、ユーザーが明示的に強制削除を求めたときだけ `--force` を使う。
- `git branch -d` は未マージだと失敗する。`-D`(強制)はユーザーが明示的に求めたときだけ。
- `missing`(幽霊)は `git worktree prune` で掃除する。
- 削除後に `git worktree list` で結果を確認し、何を消したか(と消さなかったもの)を報告する。

## やらないこと

- メイン worktree や、`.claude/worktrees` 配下でない worktree には触れない
- `git push` や PR のクローズなどリモートに影響する操作はしない(ローカルブランチ削除に留める)
- ユーザー承認なしの削除、`--force` / `-D` の独断使用はしない
