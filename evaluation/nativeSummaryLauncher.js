'use strict';

const path = require('node:path');
const { requireSafe, failure } = require('./liveSummarySafety');
const { PROTOCOL, exact, prepareNativeManifest, validResult } = require('./nativeSummaryWorker');

function readHiddenSecret(input, signal) {
  requireSafe(input?.isTTY === true && typeof input.setRawMode === 'function' && signal instanceof AbortSignal, 'ENATIVE_TTY_REQUIRED');
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(512), wasRaw = input.isRaw === true, wasPaused = input.isPaused?.() !== false;
    let length = 0, settled = false;
    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); input.removeListener('data', data); input.removeListener('error', error);
      input.removeListener('end', error); input.removeListener('close', error); signal.removeEventListener('abort', abort);
      let result;
      if (!code) result = Buffer.from(bytes.subarray(0, length));
      bytes.fill(0);
      try { input.setRawMode(wasRaw); if (wasPaused) input.pause(); } catch (_) { code = 'ENATIVE_TTY_FAILED'; }
      if (code) { result?.fill(0); reject(failure(code)); } else resolve(result);
    };
    const error = () => finish('ENATIVE_TTY_FAILED'), abort = () => finish('ENATIVE_CANCELLED');
    function data(chunk) {
      if (!Buffer.isBuffer(chunk)) { finish('ENATIVE_CREDENTIAL_INVALID'); return; }
      try { for (const byte of chunk) {
        if (byte === 3 || byte === 4 || byte === 27) { finish('ENATIVE_CANCELLED'); return; }
        if (byte === 13 || byte === 10) { finish(length ? null : 'ENATIVE_CREDENTIAL_INVALID'); return; }
        if (byte === 127 || byte === 8) { if (length) bytes[--length] = 0; continue; }
        if (byte < 33 || byte > 126 || length >= 512) { finish('ENATIVE_CREDENTIAL_INVALID'); return; }
        bytes[length++] = byte;
      } } finally { chunk.fill(0); }
    }
    const timer = setTimeout(() => finish('ENATIVE_INPUT_TIMEOUT'), 120000);
    try {
      input.on('data', data); input.on('error', error); input.on('end', error); input.on('close', error);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      input.setRawMode(true); input.resume();
    } catch (_) { error(); }
  });
}

// No inherited PATH, NODE_OPTIONS, credentials, proxy or application configuration.
function childEnvironment() {
  const env = { NODE_ENV: 'test', TZ: 'UTC', NO_COLOR: '1' };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function launchNativeSummary({ manifest, authorization, input, signal }, dependencies = {}) {
  requireSafe(authorization === 'AUTHORIZE_ONE_GEMINI_REQUEST', 'ENATIVE_AUTHORIZATION_REQUIRED');
  requireSafe(input?.isTTY === true && typeof input.setRawMode === 'function', 'ENATIVE_TTY_REQUIRED');
  requireSafe(signal === undefined || signal instanceof AbortSignal, 'ENATIVE_CANCELLED');
  // Parent preflight cannot request a credential or dispatch. Child repeats it.
  const dummy = { on() {}, removeListener() {}, send() { throw failure('ENATIVE_PROTOCOL'); } };
  const prepared = prepareNativeManifest(manifest, dummy); prepared.workflow.close();
  requireSafe(!signal?.aborted, 'ENATIVE_CANCELLED');
  const fork = dependencies.fork || require('node:child_process').fork;
  const lifecycle = dependencies.lifecycle || process;
  const clock = dependencies.clock || { setTimeout, clearTimeout };
  return new Promise(resolve => {
    let child, phase = 'STARTING', secret, result = null, failed = false, settled = false, exited = false, executed = false;
    let startup, watchdog, grace, exitDeadline;
    let termination = 'NOT_REQUESTED', cleanupCode = null;
    const inputAbort = new AbortController();
    const failureResult = () => Object.freeze({ status: 'failed', model: prepared.model, fingerprint: prepared.fingerprint,
      dispatches: result?.dispatches ?? (executed ? null : 0), validation: 'NOT_REACHED', grounding: 'NOT_REACHED', factual_truth_verified: false, diagnostic: null });
    function finish() {
      if (settled) return;
      settled = true; inputAbort.abort(); secret?.fill(0); secret = undefined;
      for (const timer of [startup, watchdog, grace, exitDeadline]) clock.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      lifecycle.removeListener('SIGINT', cancel); lifecycle.removeListener('SIGTERM', cancel);
      // Consume late exit/error events, but never report unconfirmed cleanup as
      // success or let a failed kill retain the parent's IPC/process references.
      child?.removeListener('message', message); child?.removeListener('disconnect', disconnect);
      if (child && !exited && cleanupCode) {
        try { if (child.connected) child.disconnect(); } catch (_) { /* Cleanup remains explicitly unconfirmed. */ }
        try { child.unref(); } catch (_) { /* No further evaluation or termination attempt is made. */ }
      }
      resolve(Object.freeze({ ...(!failed && result ? result : failureResult()),
        cleanup: Object.freeze({ termination, exit_confirmed: exited, code: cleanupCode }) }));
    }
    function send(value) {
      if (settled) return;
      try { child.send(value, error => { if (error) cancel(); }); } catch (_) { cancel(); }
    }
    function cancel() {
      if (settled || failed) return;
      failed = true; phase = 'CANCELLING'; inputAbort.abort(); secret?.fill(0); secret = undefined;
      clock.clearTimeout(startup); clock.clearTimeout(watchdog);
      try { child?.send({ protocol: PROTOCOL, type: 'CANCEL' }); } catch (_) { /* Kill deadline remains authoritative. */ }
      grace = clock.setTimeout(terminate, 1000);
    }
    function terminate() {
      if (settled) return;
      if (!child || exited) { finish(); return; }
      termination = 'REQUESTED';
      try {
        const requested = child.kill('SIGKILL');
        if (exited || settled) return;
        if (requested !== true) {
          termination = 'FAILED'; cleanupCode = 'ENATIVE_TERMINATION_FAILED'; finish(); return;
        }
        exitDeadline = clock.setTimeout(() => {
          cleanupCode = 'ENATIVE_EXIT_UNCONFIRMED'; finish();
        }, 1000);
      } catch (_) {
        termination = 'FAILED'; cleanupCode = 'ENATIVE_TERMINATION_FAILED'; finish();
      }
    }
    function childExit(code, exitSignal) {
      if (exited) return;
      exited = true;
      if (termination === 'REQUESTED') termination = 'CONFIRMED';
      if (code !== 0 || exitSignal || phase !== 'RESULT') failed = true;
      finish();
    }
    function disconnect() { if (phase !== 'RESULT' && !failed) cancel(); }
    function message(value) {
      if (settled || failed) return;
      try {
        if (phase === 'STARTING' && exact(value, ['protocol', 'type', 'model', 'fingerprint']) && value.protocol === PROTOCOL &&
            value.type === 'PREFLIGHT_READY' && value.model === prepared.model && value.fingerprint === prepared.fingerprint) {
          phase = 'INPUT'; clock.clearTimeout(startup);
          void readHiddenSecret(input, inputAbort.signal).then(buffer => {
            if (failed || settled) { buffer.fill(0); return; }
            secret = buffer; phase = 'EXECUTING'; executed = true;
            watchdog = clock.setTimeout(cancel, 25000);
            send({ protocol: PROTOCOL, type: 'EXECUTE' });
          }, cancel); return;
        }
        if (phase === 'EXECUTING' && exact(value, ['protocol', 'type']) &&
            value.protocol === 'evinews-evaluation-secret-v1' && value.type === 'PREFLIGHT_PASSED' && secret) {
          phase = 'RUNNING';
          const payload = { protocol: 'evinews-evaluation-secret-v1', secret: secret.toString('ascii') };
          secret.fill(0); secret = undefined;
          try { child.send(payload, error => { payload.secret = undefined; if (error) cancel(); }); }
          catch (_) { payload.secret = undefined; cancel(); }
          return;
        }
        if (['STARTING', 'EXECUTING', 'RUNNING'].includes(phase) && exact(value, ['protocol', 'type', 'result']) && value.protocol === PROTOCOL &&
            value.type === 'RESULT' && validResult(value.result, prepared.model, prepared.fingerprint) &&
            (phase === 'RUNNING' || value.result.dispatches === 0 &&
              ['failed', 'insufficient_grounding'].includes(value.result.status) && value.result.validation === 'NOT_REACHED' &&
              value.result.grounding === 'NOT_REACHED' && value.result.diagnostic === null)) {
          result = Object.freeze(structuredClone(value.result)); phase = 'RESULT';
          clock.clearTimeout(startup); clock.clearTimeout(watchdog);
          grace = clock.setTimeout(cancel, 1000); return;
        }
        cancel();
      } catch (_) { cancel(); }
    }
    try {
      lifecycle.on('SIGINT', cancel); lifecycle.on('SIGTERM', cancel); signal?.addEventListener('abort', cancel, { once: true });
      child = fork(path.resolve(__dirname, 'nativeSummaryWorker.js'), ['--authorized-worker'], {
        execArgv: [], env: childEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', windowsHide: true
      });
      child.once('exit', childExit); child.once('close', childExit);
      child.on('message', message); child.on('error', cancel); child.on('disconnect', disconnect);
      startup = clock.setTimeout(cancel, 10000);
      send({ protocol: PROTOCOL, type: 'INIT', manifest: prepared.manifest });
    } catch (_) { if (child) cancel(); else { failed = true; finish(); } }
  });
}

module.exports = { launchNativeSummary, readHiddenSecret };
