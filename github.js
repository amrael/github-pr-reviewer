'use strict';

const { execSync } = require('child_process');

let _config = null;
let _logger = null;

function init(config, logger) {
  _config = config;
  _logger = logger;
}

function ghExec(args) {
  const cmd = `"${_config.GH_BIN}" ${args}`;
  return execSync(cmd, {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      GH_TOKEN: _config.GH_TOKEN,
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    },
  });
}

function addReaction(repo, commentId, reaction) {
  try {
    const output = ghExec(
      `api repos/${repo}/issues/comments/${commentId}/reactions -f content=${reaction}`
    );
    const data = JSON.parse(output);
    _logger.info('Reaction added', { repo, commentId, reaction, reactionId: data.id });
    return data.id;
  } catch (e) {
    _logger.warn('Failed to add reaction', { repo, commentId, reaction, error: e.message });
    return null;
  }
}

function removeReaction(repo, commentId, reactionId) {
  if (!reactionId) return;
  try {
    ghExec(
      `api repos/${repo}/issues/comments/${commentId}/reactions/${reactionId} -X DELETE`
    );
    _logger.info('Reaction removed', { repo, commentId, reactionId });
  } catch (e) {
    _logger.warn('Failed to remove reaction', { repo, commentId, reactionId, error: e.message });
  }
}

module.exports = { init, addReaction, removeReaction };
