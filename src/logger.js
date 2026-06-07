#!/usr/bin/env node
/**
 * Structured logger — info + debug levels.
 * All logs to stderr (stdout reserved for HTTP responses in Docker).
 */

import { config } from './config.js';

const IS_DEBUG = config.logLevel === 'debug';

/** Format a log entry as JSON and write to stderr. */
function emit(level, message) {
  console.error(JSON.stringify({ level, ts: new Date().toISOString(), msg: message }));
}

/** Log at info level — always emitted. */
export function logInfo(message) {
  emit('info', message);
}

/** Log at debug level — only when LOG_LEVEL=debug. */
export function logDebug(message) {
  if (!IS_DEBUG) return;
  emit('debug', message);
}
