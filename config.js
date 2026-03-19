'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;

// --- Load .env ---
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

function resolveProjectPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

// --- Config ---
const config = {
  PROJECT_ROOT,
  PORT: parseInt(process.env.PORT, 10) || 3456,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  SMEE_URL: process.env.SMEE_URL,
  TRIGGER_KEYWORD: process.env.TRIGGER_KEYWORD || '@ClaudeReview',

  GH_TOKEN: process.env.GH_TOKEN,
  GH_BIN: process.env.GH_BIN || '/opt/homebrew/bin/gh',
  CLAUDE_PATH: process.env.CLAUDE_PATH,
  GITHUB_LOGIN: process.env.GITHUB_LOGIN || 'amrael',

  OPENCLAW_BIN: process.env.OPENCLAW_BIN,
  SIGNAL_RECIPIENT: process.env.SIGNAL_RECIPIENT,

  PR_REVIEW_SH: resolveProjectPath(process.env.PR_REVIEW_SH || './review-pr.sh'),
  SETTINGS_TEMPLATE: resolveProjectPath(process.env.SETTINGS_TEMPLATE || './.claude-settings-template.json'),

  LOG_DIR: resolveProjectPath(process.env.LOG_DIR || './logs'),
  LOG_MAX_SIZE_MB: parseInt(process.env.LOG_MAX_SIZE_MB, 10) || 50,
};

// --- Validate required ---
const REQUIRED = ['WEBHOOK_SECRET', 'SMEE_URL', 'GH_TOKEN', 'CLAUDE_PATH'];
const missing = REQUIRED.filter(k => !config[k]);
if (missing.length > 0) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}. Check your .env file.`);
}

module.exports = config;
