# GitHub PR Auto-Reviewer — 仕様書 (v2.0)

## 概要

GitHub PR に `@ClaudeReview` とコメントすると、ローカルの Claude Code CLI を使って自動でコードレビューを実施し、PR にコメントとして投稿するシステム。
GitHub webhook → smee.io → ローカル HTTP サーバーの構成でリアルタイムに動作する。

---

## ファイル構成

```
github-pr-reviewer/
├── SPEC.md                          # この仕様書
├── package.json                     # 依存管理 (smee-client)
├── .env                             # 認証情報・設定（git管理外）
├── .env.example                     # .env のテンプレート
├── .gitignore
├── webhook-server.js                # メインエントリ（HTTP サーバー + smee-client）
├── reviewer.js                      # レビューパイプライン（clone → Claude → post）
├── config.js                        # .env 読み込み + バリデーション
├── logger.js                        # NDJSON 構造化ログ
├── notifier.js                      # Signal 通知（成功/失敗）
├── github.js                        # GitHub リアクション操作
├── review-pr.sh                     # Bash ヘルパー（clone / post / cleanup）
├── .claude-settings-template.json   # Claude Code 用パーミッション設定
├── com.github-pr-reviewer.plist     # macOS launchd サービス定義
└── logs/                            # ログ出力（git管理外）
```

---

## システムアーキテクチャ

```
GitHub PR comment "@ClaudeReview"
    │ (webhook: issue_comment)
    ▼
smee.io (公開 Webhook プロキシ)
    │ (Server-Sent Events)
    ▼
smee-client (npm) → http://127.0.0.1:3456/webhook
    │
webhook-server.js
    ├─ HMAC-SHA256 署名検証
    ├─ @ClaudeReview キーワード判定
    ├─ PR かどうか確認 (issue.pull_request)
    ├─ 重複チェック (in-memory Map: repo:prNumber)
    ├─ 即座に 200 応答
    │
    ▼ (非同期)
reviewer.js
    ├─ 👀 リアクション追加
    ├─ review-pr.sh --prepare (clone + branch checkout)
    ├─ .claude/settings.local.json をコピー
    ├─ claude -p "{prompt}" --permission-mode bypassPermissions
    │  (execSync, ローカル CLI, 10分タイムアウト)
    ├─ review-pr.sh --post --auto-cleanup (コメント投稿)
    │
    ├─ 成功: 👀→✅ リアクション + Signal 通知
    └─ 失敗: 👀→❌ リアクション + Signal 通知 + エラーログ
```

---

## 各モジュールの責務

### `webhook-server.js` (メインエントリ)

- HTTP サーバー (127.0.0.1:3456)
- smee-client による webhook 受信
- `POST /webhook` — GitHub webhook ハンドラー
- `GET /health` — ヘルスチェック（uptime, activeReviews）
- 重複排除: in-memory Map (`repo:prNumber` → active review info)
- Graceful shutdown: SIGTERM/SIGINT でレビュー完了を待機（最大120秒）
- uncaughtException / unhandledRejection → ログ + Signal 通知

### `reviewer.js` (レビューパイプライン)

- `runReview(repo, prNumber, commentId)` — メイン関数
- Claude Code CLI を `execSync` で実行（非TTY環境対応）
- プロンプトは一時ファイル経由で渡す（シェルクォート問題回避）
- 全ステップで try/catch → 失敗時は Signal 通知 + ❌ リアクション

### `config.js` (設定管理)

- `.env` をパース（dotenv 不要、手動パーサー）
- `resolveProjectPath()` で相対パスを絶対パスに解決
- 必須項目 (`WEBHOOK_SECRET`, `SMEE_URL`, `GH_TOKEN`, `CLAUDE_PATH`) が未設定なら即 throw

### `logger.js` (構造化ログ)

- NDJSON 形式: `{"ts":"...","level":"info","msg":"...","pr":123,"repo":"..."}`
- ファイル出力 (`logs/webhook-server.log`) + console
- ローテーション: 50MB 超で `.log.1` にリネーム
- `child(context)` でコンテキスト付きロガーを生成

### `notifier.js` (Signal 通知)

- `notifySuccess(repo, prNumber, durationMs)` — 完了通知
- `notifyFailure(repo, prNumber, errorMsg)` — 失敗通知
- `openclaw message send` via spawnSync

### `github.js` (GitHub リアクション)

- `addReaction(repo, commentId, reaction)` — リアクション追加
- `removeReaction(repo, commentId, reactionId)` — リアクション削除
- `gh api` via execSync

### `review-pr.sh` (Bash ヘルパー)

| オプション | 動作 |
|---|---|
| `--prepare --pr N --repo org/repo` | clone して branch checkout。`/tmp/pr-review/{repo}-pr-N` を返す |
| `--post --pr N --repo org/repo --review-file FILE [--auto-cleanup]` | GitHub PR にコメント投稿。`<details>` タグで折りたたみ |
| `--cleanup` | `/tmp/pr-review/` を全削除 |

---

## 環境・依存

| 項目 | 値 |
|---|---|
| npm 依存 | `smee-client` のみ |
| Node.js 組み込み | `http`, `crypto`, `child_process`, `fs`, `path` |
| 外部バイナリ | `claude` (Claude Code CLI), `gh` (GitHub CLI), `openclaw` (Signal) |
| GitHub アカウント | `.env` の `GITHUB_LOGIN` |
| 設定 | 全て `.env` で管理 |
| プロセス管理 | macOS launchd (`com.github-pr-reviewer.plist`) |

---

## ログ・デバッグ

```bash
# ライブログ
tail -f logs/webhook-server.log | jq .

# エラーのみ表示
cat logs/webhook-server.log | jq 'select(.level == "error")'

# 特定PRのログ
cat logs/webhook-server.log | jq 'select(.pr == 1234)'

# ヘルスチェック
curl -s http://localhost:3456/health | jq .

# launchd 状態確認
launchctl list | grep github-pr-reviewer
```

---

## セットアップ手順

### 1. smee.io チャネル作成

https://smee.io/new で URL を取得し `.env` の `SMEE_URL` に設定。

### 2. GitHub Webhook 設定

対象リポジトリの Settings → Webhooks:
- **Payload URL**: smee.io の URL
- **Content type**: `application/json`
- **Secret**: `openssl rand -hex 32` で生成、`.env` の `WEBHOOK_SECRET` に設定
- **Events**: "Issue comments" のみ選択

### 3. インストール・起動

```bash
cd /Users/yasu/Projects/github-pr-reviewer
cp .env.example .env  # 値を編集
npm install
node webhook-server.js  # テスト起動
```

### 4. launchd サービス登録

```bash
cp com.github-pr-reviewer.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.github-pr-reviewer.plist
launchctl start com.github-pr-reviewer
```

### 5. 使い方

PR に以下のコメントを投稿:
```
@ClaudeReview
```

---

## レビュープロンプト

```
- merge-base アプローチで diff を取得
- git diff $(git merge-base origin/master HEAD)..HEAD
- CLAUDE.md と .cursor/skills/coding-rules/SKILL.md のルールに従う
- CRITICAL / HIGH / MEDIUM / LOW の4段階で指摘
- "# Code Review: PR #N" で始まり、summary table で終わる
```

---

## Claude Code CLI 実行方式

- `execSync` (shell=true) でシェル経由起動 — 非TTY環境でも動作
- プロンプトは一時ファイルに書いて `$(cat file)` で渡す（シェルクォート対策）
- `--permission-mode bypassPermissions` + `.claude/settings.local.json`
- タイムアウト: 10分、maxBuffer: 50MB
- 参考: [issue #771](https://github.com/anthropics/claude-code/issues/771), [#9026](https://github.com/anthropics/claude-code/issues/9026)
