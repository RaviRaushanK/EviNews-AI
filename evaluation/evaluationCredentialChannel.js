'use strict';

const { failure, requireSafe } = require('./liveSummarySafety');
const used = new WeakSet();
const PROTOCOL = 'evinews-evaluation-secret-v1';

function receiveEvaluationSecret(channel, signal) {
  requireSafe(channel && typeof channel.on === 'function' && typeof channel.removeListener === 'function' &&
    typeof channel.send === 'function' && !used.has(channel) && signal instanceof AbortSignal,
  'EEVAL_CREDENTIAL_CHANNEL_INVALID');
  used.add(channel);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      for (const name of ['message', 'disconnect', 'close', 'error']) channel.removeListener(name, handlers[name]);
      signal.removeEventListener('abort', abort);
    };
    const finish = (code, value) => {
      if (settled) return;
      settled = true; cleanup();
      if (code) reject(failure(code)); else resolve(value);
    };
    const abort = () => finish('EEVAL_CREDENTIAL_CANCELLED');
    const handlers = {
      message(message) {
        try {
          const fields = message && Object.getPrototypeOf(message) === Object.prototype && Object.getOwnPropertyDescriptors(message);
          requireSafe(fields && Reflect.ownKeys(fields).length === 2 && ['protocol', 'secret'].every(name =>
            Object.hasOwn(fields, name) && Object.hasOwn(fields[name], 'value') && fields[name].enumerable) &&
            fields.protocol.value === PROTOCOL && typeof fields.secret.value === 'string' &&
            /^[\x21-\x7e]{1,512}$/.test(fields.secret.value), 'EEVAL_CREDENTIAL_INVALID');
          finish(null, fields.secret.value);
        } catch (_) { finish('EEVAL_CREDENTIAL_INVALID'); }
      },
      disconnect() { finish('EEVAL_CREDENTIAL_CLOSED'); },
      close() { finish('EEVAL_CREDENTIAL_CLOSED'); },
      error() { finish('EEVAL_CREDENTIAL_CLOSED'); }
    };
    const timer = setTimeout(() => finish('EEVAL_CREDENTIAL_TIMEOUT'), 5000);
    try {
      for (const name of Object.keys(handlers)) channel.on(name, handlers[name]);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      channel.send(Object.freeze({ protocol: PROTOCOL, type: 'PREFLIGHT_PASSED' }));
    } catch (_) { finish('EEVAL_CREDENTIAL_CLOSED'); }
  });
}

module.exports = { receiveEvaluationSecret };
