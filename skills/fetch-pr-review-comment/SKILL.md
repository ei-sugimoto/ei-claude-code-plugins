---
name: fetch-pr-review-comment
description: GitHubのPRレビューコメントURL（discussion_r / pullrequestreview- / issuecomment- のフラグメントを含むURL）から、GitHub MCPサーバー（plugin:github:github）のツールを使ってコメント本文を取得する。Use this skill whenever the user pastes a GitHub PR discussion/review comment URL and asks to fetch, check, or summarize its content — phrases like "このコメント見て", "このレビューの内容取ってきて", "このURLの中身教えて", "このdiscussionは何て言ってる?", "fetch this PR comment", "check this review comment". URLのフラグメントが discussion_r / pullrequestreview- / issuecomment- のいずれかを含むGitHub PR URLが貼られたとき全般に使う。
---

# fetch-pr-review-comment (PRレビューコメントURLから本文取得)

GitHubのPRページで特定のレビューコメントを指す共有URLは `https://github.com/{owner}/{repo}/pull/{number}#{fragment}` の形式を取る。`{fragment}` の種類によって、`gh pr view`/`gh pr diff` では取得できないコメント本文を GitHub MCPサーバー（`mcp__plugin_github_github__*`）経由で取得する。`gh api` は使わない。

## 前提

`plugin:github:github` のMCPサーバーが接続済みであること（`/mcp` で確認）。未接続の場合はこのスキルを使わずユーザーに接続を促す。

## URLの解析パターン

| fragmentの形式 | 意味 | 取得方法 |
|---|---|---|
| `discussion_r{comment_id}` | インラインレビューコメント（コード行への指摘） | `pull_request_read`（method: `get_review_comments`）でスレッド一覧を取得し、コメントIDが `{comment_id}` と一致するものを探す |
| `pullrequestreview-{review_id}` | レビュー本体（Approve/Request changes等のサマリ） | `pull_request_read`（method: `get_reviews`）でレビュー一覧を取得し、IDが `{review_id}` と一致するものを探す |
| `issuecomment-{comment_id}` | PR会話欄の通常コメント | `issue_read`（method: `get_comments`, `issue_number` にPR番号を指定）でコメント一覧を取得し、IDが `{comment_id}` と一致するものを探す |

## 手順

1. URLから `owner`, `repo`, `number`, `fragment` を抽出する
2. 上表に従って対応するMCPツールを呼び出す（`owner`/`repo`/`pullNumber` or `issue_number` を渡す）
3. ページングされている場合は対象IDが見つかるまで `page`/`after` を進める
4. 見つかったコメント/レビューの本文（`body`）と `html_url`、`path`/`line`（インラインコメントの場合）を要約して提示する
5. 必要に応じて `diff_hunk` から該当箇所の文脈も示す

## 注意

- 単一IDでの直接取得エンドポイントはMCPツールに存在しないため、一覧取得＋IDフィルタで対応する
- 書き込み系ツール（`add_reply_to_pull_request_comment`, `add_issue_comment`, `pull_request_review_write` 等）はこのスキルの対象外。読み取り専用のツールのみ使うこと
