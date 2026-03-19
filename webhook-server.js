#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');

// --- Bootstrap ---
const config = require('./config');
const { createLogger } = require('./logger');
const logger = createLogger(config);

const notifier = require('./notifier');
notifier.init(config, logger);

const github = require('./github');
github.init(config, logger);

const reviewer = require('./reviewer');
reviewer.init(config, logger, github, notifier);

// --- In-memory dedup ---
const activeReviews = new Map(); // key: "owner/repo:prNumber" => { startedAt, commentId }

// --- Webhook signature verification ---
function verifySignature(payload, signature) {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- Collect request body ---
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Webhook handler ---
async function handleWebhook(req, res) {
  let rawBody;
  try {
    rawBody = await collectBody(req);
  } catch (e) {
    logger.warn('Failed to read request body', { error: e.message });
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  // Verify signature
  const signature = req.headers['x-hub-signature-256'];
  if (!verifySignature(rawBody, signature)) {
    logger.warn('Invalid webhook signature', {
      ip: req.socket.remoteAddress,
    });
    res.writeHead(401);
    res.end('Invalid signature');
    return;
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    logger.warn('Invalid JSON payload', { error: e.message });
    res.writeHead(400);
    res.end('Invalid JSON');
    return;
  }

  // Check event type
  const event = req.headers['x-github-event'];
  if (event !== 'issue_comment') {
    res.writeHead(200);
    res.end('Ignored event');
    return;
  }

  // Only process new comments (not edits/deletes)
  if (payload.action !== 'created') {
    res.writeHead(200);
    res.end('Ignored action');
    return;
  }

  const commentBody = payload.comment?.body || '';
  const repo = payload.repository?.full_name;
  const issueNumber = payload.issue?.number;
  const commentId = payload.comment?.id;
  const commentAuthor = payload.comment?.user?.login;

  // Check trigger keyword
  if (!commentBody.includes(config.TRIGGER_KEYWORD)) {
    res.writeHead(200);
    res.end('No trigger keyword');
    return;
  }

  // Must be a PR (not a plain issue)
  if (!payload.issue?.pull_request) {
    logger.info('Trigger keyword found but not a PR', { repo, issue: issueNumber });
    res.writeHead(200);
    res.end('Not a PR');
    return;
  }

  const prNumber = issueNumber;
  const dedupKey = `${repo}:${prNumber}`;

  logger.info('Review triggered', { repo, pr: prNumber, commentId, author: commentAuthor });

  // Dedup check
  if (activeReviews.has(dedupKey)) {
    const existing = activeReviews.get(dedupKey);
    logger.info('Review already in progress', { repo, pr: prNumber, startedAt: existing.startedAt });
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'already_in_progress', pr: prNumber }));
    return;
  }

  // Mark as active and respond immediately
  activeReviews.set(dedupKey, { startedAt: new Date().toISOString(), commentId });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'accepted', pr: prNumber }));

  // Run review asynchronously
  reviewer.runReview(repo, prNumber, commentId)
    .finally(() => {
      activeReviews.delete(dedupKey);
    });
}

// --- Health endpoint ---
function handleHealth(req, res) {
  const reviews = {};
  for (const [key, val] of activeReviews) {
    reviews[key] = val;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    activeReviews: activeReviews.size,
    reviews,
  }));
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return handleHealth(req, res);
  }
  if (req.method === 'POST' && req.url === '/webhook') {
    return handleWebhook(req, res);
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(config.PORT, '127.0.0.1', () => {
  logger.info('Server listening', { port: config.PORT });
});

// --- Smee Client ---
let smeeEvents = null;
try {
  const SmeeClient = require('smee-client');
  const smee = new SmeeClient({
    source: config.SMEE_URL,
    target: `http://127.0.0.1:${config.PORT}/webhook`,
    logger: {
      info: () => {},  // Suppress noisy smee pings
      error: (msg) => logger.error('smee-client error', { detail: msg }),
    },
  });
  smeeEvents = smee.start();
  logger.info('smee-client connected', { source: config.SMEE_URL });
} catch (e) {
  logger.error('Failed to start smee-client', { error: e.message });
  logger.error('Install smee-client: npm install smee-client');
  process.exit(1);
}

// --- Graceful shutdown ---
function shutdown(signal) {
  logger.info('Shutdown requested', { signal, activeReviews: activeReviews.size });

  server.close();
  if (smeeEvents && typeof smeeEvents.close === 'function') {
    smeeEvents.close();
  }

  if (activeReviews.size > 0) {
    logger.info('Waiting for in-progress reviews to complete...');
    const deadline = Date.now() + 120_000;
    const interval = setInterval(() => {
      if (activeReviews.size === 0 || Date.now() > deadline) {
        if (activeReviews.size > 0) {
          logger.warn('Force exit with active reviews', { count: activeReviews.size });
        }
        clearInterval(interval);
        process.exit(0);
      }
    }, 2000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Uncaught error handlers ---
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  notifier.sendSignal(`💀 PR Reviewer uncaught exception: ${err.message.slice(0, 200)}`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error('Unhandled rejection', { error: msg, stack: reason?.stack });
  notifier.sendSignal(`💀 PR Reviewer unhandled rejection: ${msg.slice(0, 200)}`);
});
