'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let _config = null;
let _logger = null;
let _github = null;
let _notifier = null;

function init(config, logger, github, notifier) {
  _config = config;
  _logger = logger;
  _github = github;
  _notifier = notifier;
}

function runClaude(prompt, cloneDir, prNumber) {
  const promptFile = `/tmp/pr-review-prompt-${prNumber}.txt`;
  fs.writeFileSync(promptFile, prompt, 'utf8');

  try {
    const stdout = execSync(
      `"${_config.CLAUDE_PATH}" -p "$(cat '${promptFile}')" --permission-mode bypassPermissions`,
      {
        cwd: cloneDir,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${path.dirname(_config.CLAUDE_PATH)}`,
        },
        timeout: 600000, // 10 minutes
      }
    );
    return stdout;
  } finally {
    try { fs.unlinkSync(promptFile); } catch (_) {}
  }
}

async function runReview(repo, prNumber, commentId) {
  const log = _logger.child({ repo, pr: prNumber, commentId });
  const startTime = Date.now();
  let eyesReactionId = null;

  try {
    // 1. Add eyes reaction
    log.info('Review started');
    eyesReactionId = _github.addReaction(repo, commentId, 'eyes');

    // 2. Prepare (clone)
    log.info('Preparing PR (clone)');
    const repoName = repo.split('/')[1];
    const staleDir = `/tmp/pr-review/${repoName}-pr-${prNumber}`;
    if (fs.existsSync(staleDir)) {
      log.info('Cleaning stale clone directory');
      fs.rmSync(staleDir, { recursive: true, force: true });
    }

    const prepareOutput = execSync(
      `GH_TOKEN=${_config.GH_TOKEN} PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" bash "${_config.PR_REVIEW_SH}" --prepare --pr ${prNumber} --repo ${repo}`,
      { encoding: 'utf8', timeout: 120000 }
    );
    const cloneDir = prepareOutput.trim().split('\n').pop();

    if (!fs.existsSync(cloneDir)) {
      throw new Error(`Clone directory not found: ${cloneDir}`);
    }
    log.info('Clone ready', { cloneDir });

    // 3. Setup Claude settings
    const claudeDir = path.join(cloneDir, '.claude');
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir);
    fs.copyFileSync(_config.SETTINGS_TEMPLATE, path.join(claudeDir, 'settings.local.json'));

    // 4. Build review prompt
    const reviewPrompt = `Review the changes introduced by commits in this PR branch compared to the merge base with master.

## CRITICAL: How to Obtain the Correct Diff
You MUST use the **merge-base** approach to get only the changes introduced by this branch. Do NOT use a simple two-dot diff against master.

1. Fetch latest: \`git fetch origin master\`
2. Get changeset: \`git diff $(git merge-base origin/master HEAD)..HEAD\`
3. List commits: \`git log $(git merge-base origin/master HEAD)..HEAD --oneline\`

## Instructions
1. Run the merge-base diff command to understand the scope.
2. Review ONLY the files and changes shown in that diff.
3. Follow coding rules defined in CLAUDE.md and .cursor/skills/coding-rules/SKILL.md.
4. Identify issues by severity: CRITICAL, HIGH, MEDIUM, LOW.
5. Provide a structured review starting with "# Code Review: PR #${prNumber}" and ending with a summary table.`;

    // 5. Run Claude Code CLI
    log.info('Running Claude Code CLI');
    let reviewBody = runClaude(reviewPrompt, cloneDir, prNumber);

    // Strip ANSI escape codes
    reviewBody = reviewBody.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');

    if (!reviewBody.trim()) {
      throw new Error('Claude returned empty output');
    }
    log.info('Claude review complete', { outputLength: reviewBody.length });

    // 6. Save and post
    const reviewFile = `/tmp/pr-review-result-${prNumber}.txt`;
    fs.writeFileSync(reviewFile, reviewBody);

    log.info('Posting review comment');
    execSync(
      `GH_TOKEN=${_config.GH_TOKEN} PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" bash "${_config.PR_REVIEW_SH}" --post --pr ${prNumber} --repo ${repo} --review-file "${reviewFile}" --auto-cleanup`,
      { encoding: 'utf8', timeout: 60000 }
    );

    // 7. Success
    const durationMs = Date.now() - startTime;
    _github.removeReaction(repo, commentId, eyesReactionId);
    _github.addReaction(repo, commentId, '+1');
    _notifier.notifySuccess(repo, prNumber, durationMs);
    log.info('Review completed', { durationMs });

    // Cleanup review file
    try { fs.unlinkSync(reviewFile); } catch (_) {}

    return true;
  } catch (e) {
    // Failure
    const durationMs = Date.now() - startTime;
    const errorMsg = e.message || String(e);

    _github.removeReaction(repo, commentId, eyesReactionId);
    _github.addReaction(repo, commentId, '-1');
    _notifier.notifyFailure(repo, prNumber, errorMsg);
    log.error('Review failed', {
      durationMs,
      error: errorMsg,
      stack: e.stack,
    });

    return false;
  }
}

module.exports = { init, runReview };
