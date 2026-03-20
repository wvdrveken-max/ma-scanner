'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = process.env.DEBUG ? 'debug' : 'info';

function log(level, msg, module = 'app', meta = {}) {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  });

  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

const logger = {
  debug: (msg, module, meta) => log('debug', msg, module, meta),
  info:  (msg, module, meta) => log('info',  msg, module, meta),
  warn:  (msg, module, meta) => log('warn',  msg, module, meta),
  error: (msg, module, meta) => log('error', msg, module, meta),
};

module.exports = logger;
