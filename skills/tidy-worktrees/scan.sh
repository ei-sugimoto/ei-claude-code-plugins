#!/usr/bin/env bash
# .claude/worktrees 配下の各 worktree の状態を TSV で出力する。
# 出力列(タブ区切り): path<TAB>branch<TAB>dirty<TAB>unpushed<TAB>merged_base<TAB>pr_state<TAB>recommend
#   dirty:       yes(未コミット変更あり) / no
#   unpushed:    yes(リモートに無いローカルコミットあり) / no / unknown
#   merged_base: yes(HEAD がベースブランチから到達可能=ff/merge済み) / no
#   pr_state:    MERGED / OPEN / CLOSED / NONE / UNKNOWN(gh不可)
#   recommend:   safe(削除候補) / review(要判断) / keep(消すと喪失リスク)
set -uo pipefail

# 起動位置から「メイン worktree」を特定する。worktree 内から呼ばれても
# git worktree list の先頭(=メイン)を基準にする。
main_root="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
if [ -z "${main_root:-}" ]; then
  echo "ERROR: git リポジトリ内で実行してください" >&2
  exit 1
fi

wt_dir="$main_root/.claude/worktrees"
# メイン worktree が現在チェックアウトしているブランチをベースとする(develop/master/main 等)。
base_branch="$(git -C "$main_root" symbolic-ref --short -q HEAD || echo "")"

have_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  have_gh=1
fi

# git worktree list から .claude/worktrees 配下のものだけを拾う。
# (ディレクトリ走査ではなく git の登録情報を正にする。手動削除済みの幽霊も検知できる)
git -C "$main_root" worktree list --porcelain | awk '
  /^worktree /{wt=$2}
  /^branch /{br=$2; print wt"\t"br}
' | while IFS=$'\t' read -r wt brref; do
  case "$wt" in
    "$wt_dir"/*) ;;
    *) continue ;;
  esac
  branch="${brref#refs/heads/}"

  if [ ! -d "$wt" ]; then
    # git には登録があるが実体が無い(手動 rm された幽霊)。prune 対象。
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$wt" "$branch" "missing" "unknown" "no" "UNKNOWN" "review"
    continue
  fi

  # dirty
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then dirty="yes"; else dirty="no"; fi

  # unpushed: upstream があれば ahead 数、無ければリモートに HEAD が含まれるかで判定。
  if git -C "$wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    ahead="$(git -C "$wt" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)"
    [ "${ahead:-0}" -gt 0 ] && unpushed="yes" || unpushed="no"
  else
    if [ -n "$(git -C "$wt" branch -r --contains HEAD 2>/dev/null)" ]; then unpushed="no"; else unpushed="yes"; fi
  fi

  # merged_base: HEAD がベースブランチから到達可能か(=ff/merge でベースに取り込み済み)。
  # squash merge はここでは no になる。その場合は pr_state(MERGED) で補完する。
  merged_base="no"
  if [ -n "$base_branch" ] && git -C "$main_root" merge-base --is-ancestor "$branch" "$base_branch" 2>/dev/null; then
    merged_base="yes"
  fi

  # pr_state
  pr_state="UNKNOWN"
  if [ "$have_gh" -eq 1 ]; then
    s="$(gh pr list --head "$branch" --state all --json state -q '.[0].state' 2>/dev/null)"
    case "$s" in
      MERGED|OPEN|CLOSED) pr_state="$s" ;;
      *) pr_state="NONE" ;;
    esac
  fi

  # recommend
  if [ "$dirty" = "yes" ] || [ "$unpushed" = "yes" ]; then
    recommend="keep"
  elif [ "$merged_base" = "yes" ] || [ "$pr_state" = "MERGED" ]; then
    recommend="safe"
  else
    recommend="review"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$wt" "$branch" "$dirty" "$unpushed" "$merged_base" "$pr_state" "$recommend"
done
