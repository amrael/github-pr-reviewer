# GitHub PR Auto-Reviewer

GitHub PR に `@ClaudeReview` とコメントすると、ローカルの [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) を使ってコードレビューを実行し、結果を PR コメントとして投稿するシステム。

Anthropic API の従量課金を回避し、Claude Code CLI (Max プラン) でレビューを実行する。

## 仕組み

```
PR に "@ClaudeReview" コメント
    │ (GitHub webhook: issue_comment)
    ▼
smee.io → ローカル HTTP サーバー (webhook-server.js)
    │
    ├─ 署名検証 → キーワード判定 → 重複排除
    │
    ▼
reviewer.js
    ├─ 👀 リアクション追加
    ├─ PR を clone → Claude Code CLI 実行 (ローカル)
    ├─ レビュー結果を PR コメントとして投稿
    ├─ 成功: ✅ + Signal 通知
    └─ 失敗: ❌ + Signal 通知 + エラーログ
```

## セットアップ

### 1. インストール

```bash
git clone https://github.com/your-user/github-pr-reviewer.git
cd github-pr-reviewer
npm install
cp .env.example .env
```

`.env` を編集して各値を設定する。

### 2. smee.io チャネル作成

https://smee.io/new にアクセスし、表示された URL を `.env` の `SMEE_URL` に設定する。

### 3. GitHub Webhook 設定

対象リポジトリの Settings > Webhooks > Add webhook:

- **Payload URL**: smee.io の URL
- **Content type**: `application/json`
- **Secret**: `openssl rand -hex 32` で生成した値 (`.env` の `WEBHOOK_SECRET` と同じ値)
- **Events**: "Issue comments" のみ

### 4. 起動

```bash
# テスト起動
node webhook-server.js

# ヘルスチェック
curl http://localhost:3456/health
```

### 5. 常時実行 (macOS launchd)

```bash
# plist をテンプレートからコピーしてパスを編集
cp com.github-pr-reviewer.plist.example com.github-pr-reviewer.plist
# /path/to/github-pr-reviewer を実際のパスに置換

# サービス登録
cp com.github-pr-reviewer.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.github-pr-reviewer.plist
```

## 使い方

PR の General コメントに以下を投稿する:

```
@ClaudeReview
```

コメントに 👀 が付き、数分後にレビュー結果が PR コメントとして投稿される。

## 設定 (.env)

| 変数 | 説明 |
|------|------|
| `GH_TOKEN` | GitHub Personal Access Token |
| `WEBHOOK_SECRET` | GitHub Webhook の署名検証用シークレット |
| `SMEE_URL` | smee.io のチャネル URL |
| `CLAUDE_PATH` | Claude Code CLI のパス |
| `GH_BIN` | gh CLI のパス |
| `TRIGGER_KEYWORD` | トリガーキーワード (デフォルト: `@ClaudeReview`) |
| `PORT` | HTTP サーバーのポート (デフォルト: `3456`) |
| `SIGNAL_RECIPIENT` | Signal 通知先電話番号 (オプション) |
| `OPENCLAW_BIN` | Signal 送信用 CLI のパス (オプション) |

## ログ

```bash
# ライブログ
tail -f logs/webhook-server.log | jq .

# エラーのみ
cat logs/webhook-server.log | jq 'select(.level == "error")'

# 特定 PR のログ
cat logs/webhook-server.log | jq 'select(.pr == 1234)'
```

## 前提条件

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (Claude Max プラン)
- [GitHub CLI (gh)](https://cli.github.com/)
- macOS (launchd による常時実行を使う場合)
