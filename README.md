# ei-claude-code-plugins

開発ワークフロー支援のためのClaude Codeプラグイン

## 概要

このプラグインは、日常的な開発ワークフローを効率化するための機能を提供します。

## 機能

### スキル

#### wtp (Git Worktree操作支援)
- wtpコマンドの使い方ガイド
- worktreeを使った並行開発のベストプラクティス
- よくある問題のトラブルシューティング

**トリガー例**: 「wtp」「worktree」「別のブランチで作業」「並行開発」

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

## インストール

### 方法1: プラグインディレクトリへのインストール

```bash
# グローバルプラグインとして
cp -r ei-claude-code-plugins ~/.claude/plugins/

# または claude --plugin-dir オプションで指定
claude --plugin-dir /path/to/ei-claude-code-plugins
```

### 方法2: プロジェクトローカル

プロジェクトの`.claude-plugin/`ディレクトリにコピー

## 前提条件

- Claude Code CLI
- wtp (worktree機能を使用する場合): https://github.com/satococoa/wtp
- Git

## ライセンス

MIT
