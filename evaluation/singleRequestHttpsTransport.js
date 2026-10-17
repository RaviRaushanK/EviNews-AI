'use strict';

const https = require('node:https');
const { createProviderDispatcher } = require('./providerDispatch');
const { failure, requireSafe } = require('./liveSummarySafety');

function exactData(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value'));
}

// Inspect both real JSON layers before text can leave the private transport.
function parseBoundedJson(text, secret) {
  let cursor = 0, values = 0;
  const check = condition => requireSafe(condition, 'ELIVE_HTTPS_INVALID_RESPONSE');
  const clean = value => { check(!secret || !value.includes(secret)); return value; };
  const space = () => { while (/[\x20\t\r\n]/.test(text[cursor] || '\0')) cursor++; };
  function string() {
    check(text[cursor] === '"'); const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor++] === '"') return clean(JSON.parse(text.slice(start, cursor)));
    }
    check(false);
  }
  function value(depth) {
    check(depth <= 40 && ++values <= 10000); space();
    const token = text[cursor];
    if (token === '"') { string(); return; }
    if (token === '{' || token === '[') {
      const object = token === '{', end = object ? '}' : ']';
      const keys = new Set(); cursor++; space();
      if (text[cursor] === end) { cursor++; return; }
      for (;;) {
        if (object) {
          check(++values <= 10000); space(); const key = string();
          check(!keys.has(key)); keys.add(key); space(); check(text[cursor++] === ':');
        }
        value(depth + 1); space();
        if (text[cursor] === end) { cursor++; return; }
        check(text[cursor++] === ',');
      }
    }
    const start = cursor;
    while (cursor < text.length && !/[\x20\t\r\n,}\]]/.test(text[cursor])) cursor++;
    check(cursor > start);
    const primitive = JSON.parse(text.slice(start, cursor));
    check(primitive === null || typeof primitive === 'boolean' || typeof primitive === 'number' && Number.isFinite(primitive));
  }
  check(typeof text === 'string' && (!secret || !text.includes(secret)));
  value(0); space(); check(cursor === text.length);
  return JSON.parse(text);
}

// Native external binding requires the separate, explicitly approved profile.
function createSingleRequestHttpsDispatcher(config) {
  const loopbackMode = config?.executionMode === 'loopback-test';
  const nativeMode = config?.executionMode === 'authenticated-native-evaluation';
  const authenticated = nativeMode || config?.executionMode === 'authenticated-fixture-test';
  const keys = ['executionMode', 'model', 'maxProviderCalls', 'timeoutMs'];
  if (!nativeMode) keys.push(loopbackMode ? 'loopback' : 'httpsFixture');
  if (nativeMode) keys.push('nativeApproval');
  if (authenticated) keys.push('credentialChannel');
  if (config && Object.hasOwn(config, 'maxResponseBytes')) keys.push('maxResponseBytes');
  requireSafe(exactData(config, keys), 'ELIVE_HTTPS_CONFIG_INVALID');
  const { executionMode, httpsFixture, model, maxProviderCalls, timeoutMs, maxResponseBytes = 262144 } = config;
  let requestHttps, loopback;
  if (nativeMode) {
    requireSafe(exactData(config.nativeApproval, ['approved', 'action', 'model', 'fingerprint', 'promptVersion', 'contractVersion']) &&
      config.nativeApproval.approved === true && config.nativeApproval.action === 'gemini-generateContent-once' &&
      config.nativeApproval.model === model && /^[a-f0-9]{64}$/.test(config.nativeApproval.fingerprint) &&
      config.nativeApproval.promptVersion === 'phase7-v2' && config.nativeApproval.contractVersion === 'phase7-summary-v2',
    'ELIVE_NATIVE_APPROVAL_REQUIRED');
    requestHttps = https.request.bind(https);
  } else if (loopbackMode) {
    requireSafe(exactData(config.loopback, ['port', 'ca']) && Number.isInteger(config.loopback.port) &&
      config.loopback.port > 0 && config.loopback.port <= 65535 && typeof config.loopback.ca === 'string' &&
      config.loopback.ca.length <= 16384, 'ELIVE_LOOPBACK_INVALID');
    try {
      const cert = new (require('node:crypto').X509Certificate)(config.loopback.ca);
      requireSafe(cert.checkIP('127.0.0.1') === '127.0.0.1' &&
        cert.toString().replace(/\r\n/g, '\n').trim() === config.loopback.ca.replace(/\r\n/g, '\n').trim(), 'ELIVE_LOOPBACK_INVALID');
    } catch (_) { throw failure('ELIVE_LOOPBACK_INVALID'); }
    loopback = Object.freeze({ ...config.loopback });
    requestHttps = https.request.bind(https);
  } else {
    requireSafe((executionMode === 'offline-test' || authenticated) && httpsFixture && httpsFixture !== https &&
      typeof httpsFixture.request === 'function' && httpsFixture.request !== https.request, 'ELIVE_REAL_TRANSPORT_UNAVAILABLE');
    requestHttps = httpsFixture.request.bind(httpsFixture);
  }
  requireSafe(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 1048576, 'ELIVE_RESPONSE_LIMIT_INVALID');
  if (authenticated) requireSafe(maxProviderCalls === 1 && timeoutMs === 20000 && maxResponseBytes === 262144 &&
    config.credentialChannel && typeof config.credentialChannel.send === 'function' &&
    typeof config.credentialChannel.on === 'function' && typeof config.credentialChannel.removeListener === 'function', 'ELIVE_AUTH_PROFILE_INVALID');
  let diagnostic = null, gateClosed = false;
  const networkCodes = new Set(['EACCES', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ENETUNREACH', 'EHOSTUNREACH', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  function record(category, status, original) {
    const fields = { category };
    if (Number.isInteger(status) && status >= 100 && status <= 599) fields.status = status;
    try {
      const code = original && Object.getOwnPropertyDescriptor(original, 'code');
      if (code && Object.hasOwn(code, 'value') && networkCodes.has(code.value)) fields.code = code.value;
    } catch (_) { /* Unknown error representations remain unclassified. */ }
    diagnostic = Object.freeze(fields);
  }

  // The transport stays private: every invocation must pass dispatcher admission.
  const transport = { async sendOne(request, options) {
    requireSafe(exactData(request, ['model', 'contents', 'config']) && request.model === model &&
      typeof request.contents === 'string' && request.contents.length > 0 && Buffer.byteLength(request.contents) <= 80000 &&
      exactData(request.config, ['responseMimeType']) && request.config.responseMimeType === 'application/json' &&
      options?.signal instanceof AbortSignal, 'ELIVE_PROVIDER_CONTRACT');
    const signal = options.signal;
    if (signal.aborted) return Promise.reject(failure('ELIVE_TRANSPORT_ABORTED'));
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: request.contents }] }],
      generationConfig: { responseMimeType: 'application/json' } });
    requireSafe(Buffer.byteLength(body) <= 100000, 'ELIVE_PROVIDER_CONTRACT');
    let secret;
    if (authenticated) {
      const { receiveEvaluationSecret } = require('./evaluationCredentialChannel');
      secret = await receiveEvaluationSecret(config.credentialChannel, signal);
      if (signal.aborted) { secret = undefined; throw failure('ELIVE_TRANSPORT_ABORTED'); }
    }
    const settings = Object.freeze({ protocol: 'https:', hostname: loopback ? '127.0.0.1' : 'generativelanguage.googleapis.com', port: loopback ? loopback.port : 443,
      path: `/v1beta/models/${model}:generateContent`, method: 'POST', agent: false, rejectUnauthorized: true,
      ...(loopback ? { ca: loopback.ca } : {}),
      headers: Object.freeze({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        ...(authenticated ? { 'x-goog-api-key': secret } : {}) }) });
    secret = undefined;
    return new Promise((resolve, reject) => {
      let req, response, settled = false, received = 0;
      const chunks = [];
      const stop = (code, status, original) => {
        if (settled) return;
        const category = code === 'GEMINI_TIMEOUT' ? 'TIMEOUT' : code === 'ELIVE_TRANSPORT_ABORTED' ?
          (gateClosed ? 'CANCELLED' : 'TIMEOUT') :
          code === 'ELIVE_HTTPS_RESPONSE_TOO_LARGE' ? 'RESPONSE_LIMIT' : code === 'ELIVE_HTTPS_INVALID_RESPONSE' ? 'RESPONSE_PARSE' :
          Number.isInteger(status) ? 'HTTP' : 'NETWORK';
        record(category, status, original);
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        const error = failure(code);
        if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
        reject(error);
        // No raw error is passed into destroy or included as an error cause.
        response?.destroy(); req?.destroy();
      };
      const abort = () => stop('ELIVE_TRANSPORT_ABORTED');
      const timer = setTimeout(() => stop('GEMINI_TIMEOUT'), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      try {
        req = requestHttps(settings, incoming => {
          response = incoming;
          incoming.on('error', error => stop('ELIVE_HTTPS_RESPONSE_ERROR', undefined, error));
          incoming.on('aborted', () => stop('ELIVE_HTTPS_RESPONSE_ERROR'));
          incoming.on('close', () => { if (!settled) stop('ELIVE_HTTPS_RESPONSE_ERROR'); });
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode;
          if (!Number.isInteger(status) || status < 200 || status >= 300) {
            const code = status >= 300 && status < 400 ? 'ELIVE_HTTPS_REDIRECT' :
              status === 401 || status === 403 ? 'GEMINI_AUTH' : status === 429 ? 'GEMINI_RATE_LIMIT' :
                status >= 500 && status <= 599 ? 'GEMINI_SERVER' : 'GEMINI_BAD_REQUEST';
            stop(code, status); return;
          }
          incoming.on('data', chunk => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) { stop('ELIVE_HTTPS_RESPONSE_ERROR'); return; }
            received += chunk.length;
            if (received > maxResponseBytes) { stop('ELIVE_HTTPS_RESPONSE_TOO_LARGE'); return; }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            if (settled) return;
            try {
              const credential = authenticated ? settings.headers['x-goog-api-key'] : undefined;
              const parsed = parseBoundedJson(Buffer.concat(chunks).toString('utf8'), credential);
              const parts = parsed?.candidates?.[0]?.content?.parts;
              requireSafe(Array.isArray(parts) && parts.length > 0 && parts.every(part =>
                exactData(part, ['text']) && typeof part.text === 'string'), 'ELIVE_HTTPS_INVALID_RESPONSE');
              const text = parts.map(part => part.text).join('');
              requireSafe(text.trim().length > 0 && (!authenticated || !text.includes(settings.headers['x-goog-api-key'])), 'ELIVE_HTTPS_INVALID_RESPONSE');
              if (authenticated) {
                const summary = parseBoundedJson(text, credential);
                requireSafe(summary && typeof summary === 'object' && !Array.isArray(summary), 'ELIVE_HTTPS_INVALID_RESPONSE');
              }
              settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
              resolve({ text });
            } catch (_) { stop('ELIVE_HTTPS_INVALID_RESPONSE'); }
          });
        });
        req.on('error', error => stop('ELIVE_HTTPS_REQUEST_ERROR', undefined, error));
        req.on('close', () => { if (!settled && !response) stop('ELIVE_HTTPS_REQUEST_ERROR'); });
        if (settled || signal.aborted) { abort(); req.destroy(); return; }
        req.end(body);
      } catch (error) { stop('ELIVE_HTTPS_REQUEST_ERROR', undefined, error); }
    });
  } };
  const dispatcher = createProviderDispatcher({ executionMode: 'offline-test', transport, model, maxProviderCalls, timeoutMs });
  return Object.freeze({
    generateText: dispatcher.generateText, close() { gateClosed = true; dispatcher.close(); },
    get dispatches() { return dispatcher.dispatches; }, get violation() { return dispatcher.violation; },
    get diagnostic() { return diagnostic && Object.freeze({ ...diagnostic }); }
  });
}

module.exports = { createSingleRequestHttpsDispatcher };
