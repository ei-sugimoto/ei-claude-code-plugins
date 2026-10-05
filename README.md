# ei-claude-code-plugins

開発ワークフロー支援のためのClaude Codeプラグイン

## 概要

このプラグインは、日常的な開発ワークフローを効率化するための機能を提供します。

## 機能

### スキル

#### run-cmux (cmux操作支援)
- cmux (macOSターミナルマルチプレクサ) の操作・調査ガイド
- ウィンドウ/ワークスペース/ペイン/サーフェスのトポロジ、フォーカス・移動
- ターミナルへのキー送信、ブラウザサーフェスのスクリーンショット、フック連携、`cmux.json` 編集

**トリガー例**: 「cmux起動して」「cmuxのワークスペース一覧」「cmuxにキー送って」「cmuxのブラウザをスクショ」

#### difit-review (difit差分レビュー連携)
- difit (ローカルGit差分レビューツール) を cmux のサーフェスで起動
- ブラウザサーフェスを閉じるだけでコメントを自動回収し、各指摘に沿ってコードを修正
- 手動の「Copy All Prompt」コピペが不要

**トリガー例**: 「difitでレビュー」「difit立ち上げて」「difitのコメント反映して」

### エージェント

#### worktree-manager (Worktree管理)
Git worktreeを使った並行開発を支援します。

**トリガー例**:
- 「feature/xxxブランチで開発したい」
- 「緊急のバグ修正をしたい」
- 「別のブランチのコードを確認しながら作業したい」

#### test-runner (テスト実行)
プロジェクトのテストフレームワークを自動検出し、テストを実行します。

**対応フレームワーク**:
- JavaScript/TypeScript: Jest, Vitest, Mocha
- Python: pytest, unittest
- Ruby: RSpec, Minitest
- Go: go test
- Rust: cargo test

**トリガー例**:
- 「実装が完了しました」
- 「テストを実行して」
- 「バグを修正したので確認したい」

#### code-reviewer (コードレビュー)
コード変更のセルフレビューを支援します。

**レビュー観点**:
- コード品質（可読性、DRY、SOLID）
- セキュリティ
- パフォーマンス
- エラーハンドリング
- テスタビリティ

**トリガー例**:
- 「この変更をレビューして」
- 「PRを作成する前に確認したい」

### mod

本体とは別のプラグインとして `mods/` に置いている。Claude Code の mod (function hooks) は early access で、API はリリースごとに変わる。

#### diff-review (ペインで見る差分レビュー)
- `/diff-review` で git の差分をペインに表示。GitHub の Changes に近い操作感
- 左のサイドバーに変更ファイルをディレクトリ構造で表示。ディレクトリはクリックで折りたたみ
- 表示は split (左右) と unified (1列) を切り替え。選んだ表示は次のセッションにも残る
- 比較の基準は `branch` (origin の既定ブランチとの merge-base) と `uncommitted` (HEAD)。untracked ファイルも含む
- 行番号を2回押すとコメント欄が開く。同じ行を2回で1行、起点のあと同じ側の別の行を押すと範囲。1回目は起点のハイライトだけ
- 「Claude に渡す」で、コメントを `path:行: 本文` の箇条書きにしてプロンプトへ入れる (送信は Enter)
- 開いている間はターンが終わるたびに差分を取り直す
- ペイン幅が 80 列未満のときはサイドバーの代わりにプルダウンでファイルを選ぶ
- lock ファイルやコード生成物などの自動生成ファイルは既定で隠す。パス (`go.sum`、`*.pb.go`、`*.min.js`、`vendor/` 等)、先頭20行の `@generated` / `DO NOT EDIT`、`.gitattributes` の `linguist-generated` で判定し、`g` で表示を切り替える

| 操作 | キー / 入力 |
| --- | --- |
| branch / uncommitted | `b` / `u` |
| split / unified | `p` / `n` |
| 自動生成ファイルの表示 / 非表示 | `g` |
| 更新 | `r` |
| Claude に渡す | `s` |
| 行指定でコメント | 下の入力欄に `R12 本文`、`L3-5 本文` (L=変更前、R=変更後) |
| 引数 | `/diff-review branch`、`uncommitted`、`split`、`unified`、`generated`、`close` |

```bash
/plugin install diff-review@ei-plugins
# 開発中はフォルダを直接読み込む (保存するとホットリロードされる)
claude --plugin-dir ./mods/diff-review
```

開発時の確認:

```bash
claude plugin validate mods/diff-review
claude plugin test mods/diff-review
```

## インストール

### 方法1: GitHubマーケットプレイスとして登録（推奨）

このリポジトリは `.claude-plugin/marketplace.json` を持つため、GitHubリポジトリを直接マーケットプレイスとして追加できる。

```bash
# GitHubリポジトリをマーケットプレイスとして追加
/plugin marketplace add ei-sugimoto/ei-claude-code-plugins

# プラグインをインストール
/plugin install ei-claude-code-plugins@ei-plugins

# インストール確認
/plugin list
```

または、`.claude/settings.json`（グローバル）か `.claude/settings.local.json`（プロジェクト）に直接記述：

```json
{
  "extraKnownMarketplaces": {
    "ei-plugins": {
      "source": {
        "source": "github",
        "repo": "ei-sugimoto/ei-claude-code-plugins"
      }
    }
  },
  "enabledPlugins": {
    "ei-claude-code-plugins@ei-plugins": true
  }
}
```

### 方法2: ローカルディレクトリをマーケットプレイスに追加（開発向け）

```bash
/plugin marketplace add /Users/ei.sugimoto/works/github.com/ei-sugimoto/ei-claude-code-plugins
/plugin install ei-claude-code-plugins@ei-plugins
```

### 方法3: --plugin-dir オプション（その場限りの読み込み）

```bash
claude --plugin-dir /Users/ei.sugimoto/works/github.com/ei-sugimoto/ei-claude-code-plugins
```

## 前提条件

- Claude Code CLI
- cmux (run-cmux / difit-review を使用する場合): macOS専用のターミナルマルチプレクサ。`brew install --cask cmux`
- difit (difit-review を使用する場合): https://github.com/yoshiko-pg/difit
- Git

## ライセンス

MIT
