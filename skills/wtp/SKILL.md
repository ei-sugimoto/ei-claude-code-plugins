---
name: wtp
description: Git worktree操作を支援します。ブランチごとのworktree作成、worktree間の移動、worktreeの一覧表示・削除に使用します。「wtp」「worktree」「ブランチで作業」「別のブランチに切り替え」「並行開発」などの言及時にトリガーします。
allowed-tools: Bash, Read, Glob
version: 1.0.0
---

# wtp - Git Worktree操作支援

wtpはGit worktree操作を柔軟にサポートするCLIツールです。ブランチごとのworktree作成、worktree間の移動、worktreeの一覧表示・削除に使用します。

## wtpコマンドリファレンス

### 基本コマンド

#### `wtp add <branch>`
新しいworktreeを作成してブランチをチェックアウトします。

```bash
# 既存ブランチ用のworktreeを作成
wtp add feature/auth

# 新規ブランチでworktreeを作成
wtp add -b feature/new-feature

# 特定のコミットから新規ブランチでworktreeを作成
wtp add -b hotfix/urgent-fix origin/main

# リモートブランチからworktreeを作成
wtp add origin/feature/remote-branch
```

**動作:**
- worktreeディレクトリを自動作成
- 指定ブランチをチェックアウト
- `-b`オプションで新規ブランチを作成
- ローカルにないブランチはリモートブランチを自動追跡

#### `wtp cd <branch>`
指定したブランチのworktreeディレクトリに移動します。

```bash
# 特定のworktreeに移動
wtp cd feature/new-feature

# mainブランチのworktreeに移動
wtp cd main

# メインworktree（リポジトリのルート）に戻る
wtp cd @
```

**注意:** シェルの制約上、`wtp cd`は直接ディレクトリを変更できません。以下のように使用してください：
```bash
cd $(wtp cd feature/new-feature)
# または
eval $(wtp cd feature/new-feature)
```

#### `wtp list`
現在のworktree一覧を表示します。

```bash
wtp list
```

**出力例:**
```
/home/user/project           main      [main]
/home/user/project-feature   feature   [feature/new-feature]
```

#### `wtp remove <branch>`
指定したブランチのworktreeを削除します。

```bash
# worktreeのみ削除
wtp remove feature/old-feature

# worktreeとブランチを同時削除
wtp remove --with-branch feature/done
```

**注意:** 未コミットの変更がある場合は警告が表示されます。

### 便利なオプション

```bash
# 強制削除（未コミットの変更を無視）
wtp remove --force feature/old-feature

# worktreeとブランチを同時に削除（作業完了後のクリーンアップに便利）
wtp remove --with-branch feature/done

# 詳細表示
wtp list --verbose
```

## 設定ファイル（.wtp.yml）

プロジェクトルートに`.wtp.yml`を配置すると、worktree作成時に自動でセットアップを実行できます。

```yaml
defaults:
  base_dir: "../worktrees"  # worktree保存先

hooks:
  post_create:
    - type: copy
      from: ".env"
      to: ".env"
    - type: command
      command: "npm install"
```

**活用例:**
- `.env`ファイルの自動コピー
- 依存関係の自動インストール（npm install, bundle install等）
- 環境固有の設定ファイル生成

## Worktreeベストプラクティス

### いつworktreeを使うべきか

1. **並行開発時**
   - 複数の機能を同時に開発する場合
   - 緊急のバグ修正が入った場合
   - PRレビュー中に別の作業をしたい場合

2. **長時間のビルド・テスト中**
   - ビルド中に別のブランチで作業継続
   - CI結果待ちの間に次の機能開発

3. **比較・参照時**
   - 異なるブランチのコードを並べて比較
   - 本番環境と開発環境の差分確認

### 推奨ワークフロー

```bash
# 1. 新機能の開発開始
wtp add feature/user-auth

# 2. 作業ディレクトリに移動
cd $(wtp cd feature/user-auth)

# 3. 開発作業...

# 4. 緊急のバグ修正が必要になった
wtp add hotfix/critical-bug
cd $(wtp cd hotfix/critical-bug)

# 5. バグ修正後、元の作業に戻る
cd $(wtp cd feature/user-auth)

# 6. 不要になったworktreeを削除
wtp remove hotfix/critical-bug
```

### ディレクトリ構成の推奨

```
~/projects/
├── my-project/              # メインworktree (main/master)
├── my-project-feature-a/    # feature/a用worktree
├── my-project-feature-b/    # feature/b用worktree
└── my-project-hotfix/       # hotfix用worktree
```

## トラブルシューティング

### よくある問題と解決方法

#### 「branch is already checked out」エラー

```
fatal: 'feature/xxx' is already checked out at '/path/to/worktree'
```

**原因:** 同じブランチが別のworktreeでチェックアウトされている
**解決:**
```bash
# 既存のworktreeを確認
wtp list

# 該当worktreeを削除するか、別のブランチに切り替え
wtp remove feature/xxx
```

#### worktreeが見つからない

```bash
# worktree一覧を確認
git worktree list

# 壊れたworktree参照を修復
git worktree prune
```

#### 削除できないworktree

```bash
# 強制削除
wtp remove --force <branch>

# または手動で削除
rm -rf /path/to/worktree
git worktree prune
```

### wtpが動作しない場合

1. **wtpがインストールされているか確認**
   ```bash
   which wtp
   ```

2. **Gitリポジトリ内にいるか確認**
   ```bash
   git rev-parse --git-dir
   ```

3. **Git worktree機能が利用可能か確認**
   ```bash
   git worktree list
   ```

## 参考リンク

- wtp GitHub: https://github.com/satococoa/wtp
- Git worktree公式ドキュメント: https://git-scm.com/docs/git-worktree
