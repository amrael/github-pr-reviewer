'use strict';

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(config, context = {}) {
    this._logDir = config.LOG_DIR;
    this._logFile = path.join(this._logDir, 'webhook-server.log');
    this._maxBytes = (config.LOG_MAX_SIZE_MB || 50) * 1024 * 1024;
    this._context = context;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  _rotate() {
    try {
      const stat = fs.statSync(this._logFile);
      if (stat.size >= this._maxBytes) {
        const backup = this._logFile + '.1';
        fs.renameSync(this._logFile, backup);
      }
    } catch (e) {
      // File doesn't exist yet — nothing to rotate
    }
  }

  _write(level, msg, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      pid: process.pid,
      ...this._context,
      ...meta,
    };
    const line = JSON.stringify(entry) + '\n';

    // Console
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    // File
    try {
      this._rotate();
      fs.appendFileSync(this._logFile, line);
    } catch (e) {
      process.stderr.write(`Logger file write error: ${e.message}\n`);
    }
  }

  info(msg, meta) { this._write('info', msg, meta); }
  warn(msg, meta) { this._write('warn', msg, meta); }
  error(msg, meta) { this._write('error', msg, meta); }

  child(context) {
    const merged = { ...this._context, ...context };
    const child = new Logger({ LOG_DIR: this._logDir, LOG_MAX_SIZE_MB: this._maxBytes / (1024 * 1024) }, merged);
    child._logFile = this._logFile;
    return child;
  }
}

function createLogger(config) {
  return new Logger(config);
}

module.exports = { createLogger };
