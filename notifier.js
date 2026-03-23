'use strict';

const { spawnSync } = require('child_process');

let _config = null;
let _logger = null;

function init(config, logger) {
  _config = config;
  _logger = logger;
}

function sendSignal(message) {
  if (!_config.OPENCLAW_BIN || !_config.SIGNAL_RECIPIENT) {
    _logger.warn('Signal notification skipped — OPENCLAW_BIN or SIGNAL_RECIPIENT not set');
    return false;
  }

  try {
    const result = spawnSync(_config.OPENCLAW_BIN, [
      'message', 'send',
      '--channel', 'telegram',
      '--target', _config.SIGNAL_RECIPIENT,
      '--message', message,
    ], { encoding: 'utf8', timeout: 30000 });

    if (result.status !== 0) {
      _logger.warn('Signal send failed', { stderr: (result.stderr || '').slice(0, 500) });
      return false;
    }
    return true;
  } catch (e) {
    _logger.warn('Signal send error', { error: e.message });
    return false;
  }
}

function notifySuccess(repo, prNumber, durationMs) {
  const mins = Math.round(durationMs / 60000);
  const message = [
    '🤖 PR Review 完了',
    '',
    `📦 ${repo}`,
    `🔢 PR #${prNumber}`,
    `⏱ ${mins}分`,
    '',
    `🔗 https://github.com/${repo}/pull/${prNumber}`,
  ].join('\n');
  sendSignal(message);
}

function notifyFailure(repo, prNumber, errorMsg) {
  const message = [
    '❌ PR Review 失敗',
    '',
    `📦 ${repo}`,
    `🔢 PR #${prNumber}`,
    `💥 ${errorMsg.slice(0, 300)}`,
    '',
    `🔗 https://github.com/${repo}/pull/${prNumber}`,
  ].join('\n');
  sendSignal(message);
}

function notifyStartup(port) {
  sendSignal(`🟢 PR Reviewer started on port ${port}`);
}

module.exports = { init, sendSignal, notifySuccess, notifyFailure, notifyStartup };
