# GitHub PR Auto-Reviewer

## What This Is

GitHub PR のコメントで `@ClaudeReview` と書くと、Claude Code CLI がコードレビューを自動実行し、結果を PR コメントとして投稿するシステム。ローカル Mac 上で常駐動作する。

## Architecture

```
GitHub PR comment "@ClaudeReview"
  → GitHub webhook (issue_comment)
  → smee.io (proxy)
  → smee-client (npm)
  → localhost:3456/webhook
  → webhook-server.js  ... 署名検証・キーワード判定・重複排除
  → reviewer.js         ... clone → Claude CLI 実行 → 結果投稿
  → Signal 通知 (成功/失敗)
```

## File Map

| File | Role |
|---|---|
| `webhook-server.js` | HTTP サーバ + webhook ハンドラ + smee-client + graceful shutdown。エントリポイント。 |
| `reviewer.js` | レビュー実行パイプライン。clone → Claude CLI 呼び出し → 結果投稿。空出力時は1回リトライ。 |
| `review-pr.sh` | Bash ヘルパー。`--prepare`(clone/checkout), `--post`(PR コメント投稿), `--cleanup`。 |
| `config.js` | `.env` を読み込み、環境変数を検証して config オブジェクトをエクスポート。 |
| `github.js` | GitHub API 操作（リアクションの追加/削除のみ）。`gh` CLI 経由。 |
| `notifier.js` | Signal メッセージ通知（成功/失敗/起動）。`openclaw` CLI 経由。 |
| `logger.js` | NDJSON 構造化ログ。stdout/stderr + ファイル出力。50MB でローテーション。 |
| `.claude-settings-template.json` | レビュー対象リポジトリにコピーされる Claude の許可設定テンプレート。 |
| `.env` | 秘匿情報（WEBHOOK_SECRET, GH_TOKEN 等）。git 管理外。 |

## Key Flows

### Review Pipeline (reviewer.js)
1. 👀 リアクション追加
2. `review-pr.sh --prepare` で PR を `/tmp/pr-review/<repo>-pr-<N>` に shallow clone + PR ブランチ checkout
3. `.claude-settings-template.json` を clone 先の `.claude/settings.local.json` にコピー
4. merge-base diff を指示するプロンプトを構築
5. Claude Code CLI を `-p` + `--dangerously-skip-permissions` で同期実行（10分タイムアウト、50MB バッファ）
6. stdout から ANSI エスケープコードを除去
7. 空出力なら stderr ログ付きで1回リトライ、それでも空なら失敗
8. `review-pr.sh --post --auto-cleanup` で PR コメント投稿 + clone ディレクトリ削除
9. 👍 リアクション + Signal 成功通知

### Webhook Handler (webhook-server.js)
1. HMAC-SHA256 署名検証
2. `issue_comment` / `created` イベントのみ処理
3. コメント本文にトリガーキーワード (`@ClaudeReview`) を含むか判定
4. PR コメントのみ（Issue は無視）
5. `repo:prNumber` キーで in-memory 重複排除（Map）
6. 即座に 200 応答 → 非同期でレビュー実行 → 完了後に Map から削除

### Dedup & Concurrency
- `activeReviews` Map で同一 PR の並行レビューを防止
- レビュー完了（成功/失敗問わず）後に `.finally()` で解除

## Deployment

- **launchd** で常駐: `~/Library/LaunchAgents/com.github-pr-reviewer.plist`
- `KeepAlive: true` + `ThrottleInterval: 10s`
- ログ: `logs/launchd-stdout.log`, `logs/launchd-stderr.log`
- 再起動: `launchctl kickstart -k gui/$(id -u)/com.github-pr-reviewer`
- 停止: `launchctl bootout gui/$(id -u)/com.github-pr-reviewer`

## Required Environment Variables (.env)

| Variable | Required | Description |
|---|---|---|
| `WEBHOOK_SECRET` | Yes | GitHub webhook の HMAC-SHA256 秘密鍵 |
| `SMEE_URL` | Yes | smee.io チャンネル URL |
| `GH_TOKEN` | Yes | GitHub PAT（PR コメント投稿用） |
| `CLAUDE_PATH` | Yes | Claude Code CLI バイナリの絶対パス |
| `PORT` | No | HTTP サーバポート（default: 3456） |
| `TRIGGER_KEYWORD` | No | トリガーキーワード（default: `@ClaudeReview`） |
| `SIGNAL_RECIPIENT` | No | Signal 通知先 |
| `OPENCLAW_BIN` | No | openclaw CLI のパス |
| `GH_BIN` | No | gh CLI のパス（default: `/opt/homebrew/bin/gh`） |

## Endpoints

- `POST /webhook` — GitHub webhook 受信
- `GET /health` — ヘルスチェック（稼働時間、実行中レビュー数）

## Tech Stack

- Node.js (vanilla, no framework)
- `smee-client` (唯一の npm 依存)
- `gh` CLI (GitHub API 操作)
- `claude` CLI (コードレビュー実行)
- `openclaw` CLI (Signal 通知)

## Development Rules

- **言語**: コード・コメントは英語。ユーザー向けメッセージ（通知テキスト等）は日本語可。
- **外部依存を増やさない**: Node 標準ライブラリ + `smee-client` のみ。新しい npm パッケージの追加は避ける。
- **同期実行**: Claude CLI は `execSync` で同期呼び出し。非同期化は不要。
- **エラー処理**: レビュー失敗は Signal 通知 + ❌ リアクション。サーバ自体はクラッシュさせない。
- **ログ**: `logger.js` の構造化ログを使う。`console.log` は使わない。
- **機密情報**: `.env` に集約。コードにハードコードしない。`.env` は git 管理外。
