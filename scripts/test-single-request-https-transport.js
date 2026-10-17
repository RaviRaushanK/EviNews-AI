'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createSingleRequestHttpsDispatcher } = require('../evaluation/singleRequestHttpsTransport');

const MODEL = 'gemini-3.5-flash-lite';
const RESPONSE = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OFFLINE_FIXTURE_OK' }] } }] });

function nativeSetup(behavior = {}) {
  const https = require('node:https'), original = https.request;
  const { fixture, state } = fakeHttps({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"statements":[]}' }] } }] }), ...behavior });
  const channel = new EventEmitter(); let deliveries = 0;
  channel.send = () => { deliveries++; queueMicrotask(() => channel.emit('message', {
    protocol: 'evinews-evaluation-secret-v1', secret: 'DUMMY_NATIVE_ONLY' })); };
  let dispatcher;
  // Bind a reviewed in-memory request double; never call the native socket API.
  https.request = fixture.request;
  try {
    dispatcher = createSingleRequestHttpsDispatcher({ executionMode: 'authenticated-native-evaluation', model: MODEL,
      maxProviderCalls: 1, timeoutMs: 20000, credentialChannel: channel,
      nativeApproval: { approved: true, action: 'gemini-generateContent-once', model: MODEL, fingerprint: 'a'.repeat(64),
        promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2' } });
  } finally { https.request = original; }
  const options = { model: MODEL, timeoutMs: 20000, maxAttempts: 1, responseMimeType: 'application/json' };
  return { dispatcher, state, channel, options, deliveries: () => deliveries,
    send: (text = 'Synthetic native prompt') => dispatcher.generateText(text, options) };
}

test('native binding fixes endpoint/TLS and shares exactly one concurrent reservation', async () => {
  const value = nativeSetup();
  try {
    const results = await Promise.allSettled([value.send(), value.send()]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(value.dispatcher.dispatches, 1); assert.equal(value.state.requests.length, 1); assert.equal(value.deliveries(), 1);
    const settings = value.state.requests[0].settings;
    assert.equal(settings.hostname, 'generativelanguage.googleapis.com'); assert.equal(settings.port, 443);
    assert.equal(settings.path, `/v1beta/models/${MODEL}:generateContent`); assert.equal(settings.rejectUnauthorized, true);
    assert.equal(settings.headers['x-goog-api-key'], 'DUMMY_NATIVE_ONLY'); assert.equal(settings.ca, undefined);
    assert.equal(JSON.stringify(results).includes('DUMMY_NATIVE_ONLY'), false);
  } finally { value.dispatcher.close(); }
});
test('closed native binding has no credential delivery, request or reservation', async () => {
  const value = nativeSetup(); value.dispatcher.close(); await assert.rejects(value.send());
  assert.equal(value.dispatcher.dispatches, 0); assert.equal(value.deliveries(), 0); assert.equal(value.state.requests.length, 0);
});
for (const [name, text, reservations] of [['prompt byte limit', 'x'.repeat(80001), 0], ['encoded body limit', '\u0000'.repeat(20000), 1]]) {
  test(`native ${name} rejects before credential delivery or request`, async () => {
    const value = nativeSetup();
    try { await assert.rejects(value.send(text)); assert.equal(value.dispatcher.dispatches, reservations);
      assert.equal(value.deliveries(), 0); assert.equal(value.state.requests.length, 0); }
    finally { value.dispatcher.close(); }
  });
}
test('native total dispatch deadline consumes one reservation and destroys pending request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const value = nativeSetup({ pending: true });
  try {
    const pending = value.send(); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(value.state.requests.length, 1); t.mock.timers.tick(20000);
    await assert.rejects(pending); assert.equal(value.dispatcher.dispatches, 1); assert.equal(value.state.requests[0].req.destroyed, true);
    assert.equal(value.state.requests.length, 1);
  } finally { value.dispatcher.close(); }
});
test('native credential timeout is five seconds within the shared dispatch deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const value = nativeSetup(); value.channel.send = () => {};
  try {
    const pending = value.send(); t.mock.timers.tick(5000); await assert.rejects(pending, { code: 'EEVAL_CREDENTIAL_TIMEOUT' });
    assert.equal(value.dispatcher.dispatches, 1); assert.equal(value.state.requests.length, 0); assert.equal(value.channel.listenerCount('message'), 0);
  } finally { value.dispatcher.close(); }
});
test('native profile rejects fixture overrides, hosts, headers and missing authorization', () => {
  const base = { executionMode: 'authenticated-native-evaluation', model: MODEL, maxProviderCalls: 1, timeoutMs: 20000,
    credentialChannel: { on() {}, removeListener() {}, send() {} },
    nativeApproval: { approved: true, action: 'gemini-generateContent-once', model: MODEL, fingerprint: 'a'.repeat(64),
      promptVersion: 'phase7-v2', contractVersion: 'phase7-summary-v2' } };
  for (const config of [{ ...base, httpsFixture: fakeHttps().fixture }, { ...base, hostname: 'unapproved.invalid' },
    { ...base, headers: {} }, { ...base, nativeApproval: { ...base.nativeApproval, approved: false } }]) {
    assert.throws(() => createSingleRequestHttpsDispatcher(config));
  }
});

// In-memory Node ClientRequest/IncomingMessage fixture: no sockets or credentials.
function fakeHttps(behavior = {}) {
  const state = { requests: [], serverRequests: 0, responses: [], logCalls: 0 };
  const fixture = { request(settings, callback) {
    if (behavior.throwOnRequest) throw new Error('SYNTHETIC_SECRET request exception');
    const req = new EventEmitter(); req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = body => {
      state.serverRequests++; req.body = body;
      if (behavior.pending) return;
      queueMicrotask(() => {
        if (req.destroyed) return;
        if (behavior.requestError) { req.emit('error', Object.assign(new Error('SYNTHETIC_SECRET socket exception'), { code: behavior.networkCode })); return; }
        const res = new EventEmitter(); res.statusCode = behavior.status ?? 200; res.destroyed = false;
        res.headers = { location: 'https://unapproved.invalid/SYNTHETIC_SECRET' };
        res.destroy = () => { res.destroyed = true; };
        state.responses.push(res); callback(res);
        if (res.destroyed) return;
        if (behavior.responseError) { res.emit('error', new Error('SYNTHETIC_SECRET response exception')); return; }
        if (behavior.hangBody) return;
        for (const chunk of behavior.chunks || [Buffer.from(behavior.body ?? RESPONSE)]) {
          res.emit('data', chunk); if (res.destroyed) return;
        }
        if (behavior.truncated) res.emit('close'); else { res.emit('end'); res.emit('close'); }
      });
    };
    state.requests.push({ settings, req });
    return req;
  } };
  return { fixture, state };
}

function setup(behavior = {}, overrides = {}) {
  const { fixture, state } = fakeHttps(behavior);
  const config = { executionMode: 'offline-test', httpsFixture: fixture, model: MODEL,
    maxProviderCalls: 2, timeoutMs: 1000, ...overrides };
  const dispatcher = createSingleRequestHttpsDispatcher(config);
  const options = { model: MODEL, timeoutMs: config.timeoutMs, maxAttempts: 1, responseMimeType: 'application/json' };
  return { dispatcher, state, send: () => dispatcher.generateText('Synthetic fixture prompt', options), options };
}

function authenticatedSetup(behavior = {}, secret = 'DUMMY_EVALUATION_ONLY') {
  const { fixture, state } = fakeHttps({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"statements":[]}' }] } }] }), ...behavior });
  const channel = new EventEmitter(); let deliveries = 0;
  channel.send = () => { deliveries++; queueMicrotask(() => channel.emit('message', {
    protocol: 'evinews-evaluation-secret-v1', secret })); };
  const dispatcher = createSingleRequestHttpsDispatcher({ executionMode: 'authenticated-fixture-test', httpsFixture: fixture,
    credentialChannel: channel, model: MODEL, maxProviderCalls: 1, timeoutMs: 20000, maxResponseBytes: 262144 });
  const options = { model: MODEL, timeoutMs: 20000, maxAttempts: 1, responseMimeType: 'application/json' };
  return { dispatcher, state, channel, deliveries: () => deliveries, send: () => dispatcher.generateText('Synthetic fixture prompt', options) };
}

const unicode = text => Array.from(text, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
function summaryEnvelope(text, split = false) {
  return JSON.stringify({ candidates: [{ content: { parts: (split ? [text.slice(0, 20), text.slice(20)] : [text]).map(part => ({ text: part })) } }] });
}
for (const [label, secret, text, split] of [
  ['literal', 'DUMMY_EVALUATION_ONLY', '{"text":"DUMMY_EVALUATION_ONLY"}'],
  ['JSON escapes', 'DUMMY_"\\_ONLY', JSON.stringify({ text: 'DUMMY_"\\_ONLY' })],
  ['Unicode escapes', 'DUMMY_EVALUATION_ONLY', '{"text":"' + unicode('DUMMY_EVALUATION_ONLY') + '"}'],
  ['mixed escapes', 'DUMMY_EVALUATION_ONLY', '{"text":"DUMMY_' + unicode('EVALUATION') + '_ONLY"}'],
  ['escaped object key', 'DUMMY_EVALUATION_ONLY', '{"' + unicode('DUMMY_EVALUATION_ONLY') + '":true}'],
  ['split content', 'DUMMY_EVALUATION_ONLY', '{"text":"' + unicode('DUMMY_EVALUATION_ONLY') + '"}', true]
]) test(`decoded credential reflection ${label} rejects before returning text`, async () => {
  const value = authenticatedSetup({ body: summaryEnvelope(text, split) }, secret);
  try {
    await assert.rejects(value.send(), error => {
      assert.equal(error.code, 'ELIVE_HTTPS_INVALID_RESPONSE'); assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false); return true;
    });
    assert.deepEqual(value.dispatcher.diagnostic, { category: 'RESPONSE_PARSE' });
    assert.equal(value.state.requests.length, 1); assert.equal(value.dispatcher.dispatches, 1); assert.equal(value.deliveries(), 1);
  } finally { value.dispatcher.close(); }
});

for (const [label, body] of [
  ['envelope duplicate key', '{"candidates":[],"candidates":[]}'],
  ['envelope escaped reflection', '{"metadata":{"' + unicode('DUMMY_EVALUATION_ONLY') + '":true},"candidates":[]}'],
  ['summary duplicate key', summaryEnvelope('{"statements":[],"statements":[]}')],
  ['equivalent escaped keys', summaryEnvelope('{"a":1,"\\u0061":2}')],
  ['malformed summary', summaryEnvelope('{"statements":[')],
  ['non-object summary', summaryEnvelope('[]')],
  ['deep summary', summaryEnvelope('{"a":'.repeat(42) + '0' + '}'.repeat(42))],
  ['excess values', summaryEnvelope('{"a":[' + Array(10001).fill('0').join(',') + ']}')],
  ['deep envelope', '{"a":'.repeat(42) + '0' + '}'.repeat(42)],
  ['excess envelope values', '{"a":[' + Array(10001).fill('0').join(',') + ']}'],
  ['trailing comma', summaryEnvelope('{"statements":[],}')],
  ['trailing content', summaryEnvelope('{"statements":[]} {}')]
]) test(`authenticated ambiguous or bounded JSON: ${label}`, async () => {
  const value = authenticatedSetup({ body });
  try {
    await assert.rejects(value.send(), { code: 'ELIVE_HTTPS_INVALID_RESPONSE' });
    assert.deepEqual(value.dispatcher.diagnostic, { category: 'RESPONSE_PARSE' }); assert.equal(value.dispatcher.dispatches, 1);
  } finally { value.dispatcher.close(); }
});

test('authenticated valid escaped non-secret strings retain normal text behavior', async () => {
  const text = JSON.stringify({ statements: [], note: 'Quoted "text", slash \\ and Unicode \u2603' });
  const value = authenticatedSetup({ body: summaryEnvelope(text, true) });
  try { assert.equal((await value.send()).text, text); assert.equal(value.dispatcher.diagnostic, null); }
  finally { value.dispatcher.close(); }
});

for (const [label, text] of [
  ['depth 40', '{"a":' + '['.repeat(39) + '0' + ']'.repeat(39) + '}'],
  ['10000 values and keys', '{"a":[' + Array(9997).fill('0').join(',') + ']}']
]) test(`authenticated JSON boundary ${label} remains valid`, async () => {
  const value = authenticatedSetup({ body: summaryEnvelope(text) });
  try { assert.equal((await value.send()).text, text); assert.equal(value.dispatcher.dispatches, 1); }
  finally { value.dispatcher.close(); }
});

test('authenticated fixture reserves one request and delivers credentials once, privately', async () => {
  const value = authenticatedSetup();
  try {
    const results = await Promise.allSettled([value.send(), value.send()]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(value.deliveries(), 1); assert.equal(value.dispatcher.dispatches, 1); assert.equal(value.state.requests.length, 1);
    const { settings, req } = value.state.requests[0];
    assert.equal(settings.headers['x-goog-api-key'], 'DUMMY_EVALUATION_ONLY');
    assert.equal(settings.hostname, 'generativelanguage.googleapis.com'); assert.equal(settings.port, 443);
    assert.equal(settings.rejectUnauthorized, true); assert.equal(req.body.includes('DUMMY_EVALUATION_ONLY'), false);
    assert.equal(JSON.stringify(results).includes('DUMMY_EVALUATION_ONLY'), false);
    assert.equal(value.dispatcher.diagnostic, null); assert.equal(value.channel.listenerCount('message'), 0);
  } finally { value.dispatcher.close(); }
});

for (const [name, behavior, expected] of [
  ['HTTP', { status: 403, body: 'DUMMY_EVALUATION_ONLY' }, { category: 'HTTP', status: 403 }],
  ['redirect', { status: 307 }, { category: 'HTTP', status: 307 }],
  ['server', { status: 503 }, { category: 'HTTP', status: 503 }],
  ['network', { requestError: true, networkCode: 'EACCES' }, { category: 'NETWORK', code: 'EACCES' }],
  ['unknown network code', { requestError: true, networkCode: 'DUMMY_EVALUATION_ONLY' }, { category: 'NETWORK' }],
  ['parse', { body: '{}' }, { category: 'RESPONSE_PARSE' }],
  ['reflected secret', { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'DUMMY_EVALUATION_ONLY' }] } }] }) }, { category: 'RESPONSE_PARSE' }],
  ['size', { body: 'x'.repeat(262145) }, { category: 'RESPONSE_LIMIT' }],
  ['unexpected part metadata', { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok', thought: true }] } }] }) }, { category: 'RESPONSE_PARSE' }]
]) test(`authenticated ${name} is bounded and sanitized without retry`, async () => {
  const value = authenticatedSetup(behavior);
  try {
    await assert.rejects(value.send(), error => !JSON.stringify(error).includes('DUMMY_EVALUATION_ONLY'));
    assert.deepEqual(value.dispatcher.diagnostic, expected); assert.ok(Object.isFrozen(value.dispatcher.diagnostic));
    assert.notEqual(value.dispatcher.diagnostic, value.dispatcher.diagnostic);
    assert.equal(value.state.requests.length, 1); assert.equal(value.dispatcher.dispatches, 1);
    assert.equal(value.deliveries(), 1);
  } finally { value.dispatcher.close(); }
});

test('authenticated timeout destroys pending request and consumes budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const value = authenticatedSetup({ pending: true }), pending = value.send();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(value.state.requests.length, 1);
  t.mock.timers.tick(20000); await assert.rejects(pending);
  assert.deepEqual(value.dispatcher.diagnostic, { category: 'TIMEOUT' });
  assert.equal(value.state.requests[0].req.destroyed, true); assert.equal(value.dispatcher.dispatches, 1); value.dispatcher.close();
});

test('authenticated closure cancels delivery before any request', async () => {
  const value = authenticatedSetup(), pending = value.send(); value.dispatcher.close();
  await assert.rejects(pending); assert.equal(value.state.requests.length, 0); assert.equal(value.dispatcher.dispatches, 1);
  assert.equal(value.channel.listenerCount('message'), 0);
});

test('authenticated closure destroys an admitted pending request without a retry', async () => {
  const value = authenticatedSetup({ pending: true }), pending = value.send();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(value.state.requests.length, 1); value.dispatcher.close(); await assert.rejects(pending);
  assert.equal(value.state.requests[0].req.destroyed, true);
  assert.deepEqual(value.dispatcher.diagnostic, { category: 'CANCELLED' });
  assert.equal(value.dispatcher.dispatches, 1); assert.equal(value.deliveries(), 1);
});

test('authenticated native binding and profile overrides reject before credential delivery', () => {
  const { fixture } = fakeHttps(); let deliveries = 0;
  const channel = new EventEmitter(); channel.send = () => deliveries++;
  const config = { executionMode: 'authenticated-fixture-test', httpsFixture: fixture, credentialChannel: channel,
    model: MODEL, maxProviderCalls: 1, timeoutMs: 20000 };
  for (const override of [{ httpsFixture: require('node:https') }, { executionMode: 'live' },
    { maxProviderCalls: 2 }, { timeoutMs: 19999 }, { maxResponseBytes: 262145 }, { headers: {} }, { hostname: 'other.invalid' }]) {
    assert.throws(() => createSingleRequestHttpsDispatcher({ ...config, ...override }));
  }
  assert.equal(deliveries, 0);
});

test('one admitted call uses one fixed HTTPS request and returns extracted text', async () => {
  const { dispatcher, state, send } = setup();
  try {
    assert.deepEqual(await send(), { text: 'OFFLINE_FIXTURE_OK', attempts: 1 });
    assert.equal(state.serverRequests, 1); assert.equal(state.requests.length, 1); assert.equal(dispatcher.dispatches, 1);
    const { settings, req } = state.requests[0];
    assert.equal(settings.protocol, 'https:'); assert.equal(settings.hostname, 'generativelanguage.googleapis.com');
    assert.equal(settings.path, `/v1beta/models/${MODEL}:generateContent`); assert.equal(settings.port, 443);
    assert.equal(settings.method, 'POST'); assert.equal(settings.rejectUnauthorized, true); assert.equal(settings.agent, false);
    assert.deepEqual(Object.keys(settings.headers).sort(), ['Content-Length', 'Content-Type']);
    assert.equal(settings.headers['Content-Length'], Buffer.byteLength(req.body));
    assert.equal(JSON.parse(req.body).generationConfig.responseMimeType, 'application/json');
    assert.equal(dispatcher.sendOne, undefined); assert.equal(dispatcher.transport, undefined);
  } finally { dispatcher.close(); }
});

for (const status of [301, 302, 303, 307, 308]) test(`HTTP ${status} rejected without redirect follow or retry`, async () => {
  const { dispatcher, state, send } = setup({ status });
  try {
    await assert.rejects(send(), { code: 'ELIVE_HTTPS_REDIRECT', status });
    assert.equal(state.serverRequests, 1); assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].req.destroyed, true); assert.equal(state.responses[0].destroyed, true);
  } finally { dispatcher.close(); }
});
for (const [status, code] of [[400, 'GEMINI_BAD_REQUEST'], [401, 'GEMINI_AUTH'], [403, 'GEMINI_AUTH'],
  [429, 'GEMINI_RATE_LIMIT'], [500, 'GEMINI_SERVER'], [503, 'GEMINI_SERVER']]) {
  test(`HTTP ${status} failure has safe status and makes no second request`, async () => {
    const { dispatcher, state, send } = setup({ status, body: 'SYNTHETIC_SECRET provider error body' });
    try {
      await assert.rejects(send(), error => { assert.equal(error.code, code); assert.equal(error.status, status);
        assert.ok(!String(error).includes('SYNTHETIC_SECRET')); assert.equal(error.cause, undefined); return true; });
      assert.equal(state.serverRequests, 1); assert.equal(dispatcher.dispatches, 1);
    } finally { dispatcher.close(); }
  });
}

for (const behavior of [{ pending: true }, { hangBody: true }]) test(`timeout destroys ${behavior.pending ? 'pending request' : 'pending response'} without retry`, async () => {
  const { dispatcher, state, send } = setup(behavior, { timeoutMs: 10 });
  try {
    await assert.rejects(send(), error => ['GEMINI_TIMEOUT', 'ELIVE_TRANSPORT_ABORTED'].includes(error.code));
    assert.equal(state.requests[0].req.destroyed, true); assert.equal(state.serverRequests, 1);
    if (state.responses.length) assert.equal(state.responses[0].destroyed, true);
    assert.equal(dispatcher.dispatches, 1);
  } finally { dispatcher.close(); }
});

test('gate close propagates cancellation and destroys the pending request', async () => {
  const { dispatcher, state, send } = setup({ pending: true });
  const pending = send(); dispatcher.close();
  await assert.rejects(pending, error => ['ELIVE_PROVIDER_CLOSED', 'ELIVE_TRANSPORT_ABORTED'].includes(error.code));
  assert.equal(state.requests[0].req.destroyed, true);
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CLOSED' }); assert.equal(state.serverRequests, 1);
});

test('already closed gate prevents any transport invocation', async () => {
  const { dispatcher, state, send } = setup(); dispatcher.close();
  await assert.rejects(send(), { code: 'ELIVE_PROVIDER_CLOSED' });
  assert.equal(state.requests.length, 0); assert.equal(dispatcher.dispatches, 0);
});

test('response byte limit is enforced across chunks before parsing', async () => {
  const { dispatcher, state, send } = setup({ chunks: [Buffer.alloc(8), Buffer.alloc(9)] }, { maxResponseBytes: 16 });
  try {
    await assert.rejects(send(), { code: 'ELIVE_HTTPS_RESPONSE_TOO_LARGE' });
    assert.equal(state.serverRequests, 1); assert.equal(state.responses[0].destroyed, true); assert.equal(state.requests[0].req.destroyed, true);
  } finally { dispatcher.close(); }
});

test('response at exact byte limit is accepted', async () => {
  const { dispatcher, send } = setup({}, { maxResponseBytes: Buffer.byteLength(RESPONSE) });
  try { assert.equal((await send()).text, 'OFFLINE_FIXTURE_OK'); } finally { dispatcher.close(); }
});

for (const body of ['SYNTHETIC_SECRET not JSON', '{}', '{"candidates":[]}',
  '{"candidates":[{"content":{"parts":[{"functionCall":{}}]}}]}']) {
  test(`malformed response shape ${body.length} is safely rejected`, async () => {
    const { dispatcher, state, send } = setup({ body });
    try {
      await assert.rejects(send(), { code: 'ELIVE_HTTPS_INVALID_RESPONSE' }); assert.equal(state.serverRequests, 1);
    } finally { dispatcher.close(); }
  });
}

for (const behavior of [{ throwOnRequest: true }, { requestError: true }, { responseError: true }, { truncated: true }]) {
  test(`raw ${Object.keys(behavior)[0]} is sanitized and never retried or logged`, async () => {
    const { dispatcher, state, send } = setup(behavior);
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const name of Object.keys(original)) console[name] = () => { state.logCalls++; };
    try {
      await assert.rejects(send(), error => {
        assert.ok(!String(error).includes('SYNTHETIC_SECRET')); assert.equal(error.cause, undefined); return true;
      });
      assert.equal(state.logCalls, 0); assert.ok(state.serverRequests <= 1); assert.equal(dispatcher.dispatches, 1);
    } finally { Object.assign(console, original); dispatcher.close(); }
  });
}

test('invalid endpoint authentication and request fields reject before transport', async () => {
  const { dispatcher, state, options } = setup();
  try {
    for (const extra of [{ url: 'https://unapproved.invalid' }, { hostname: 'other' }, { path: '/other' },
      { headers: { Authorization: 'SYNTHETIC_SECRET' } }, { model: '../other' }, { responseMimeType: 'text/plain' }, { maxAttempts: 2 }]) {
      await assert.rejects(dispatcher.generateText('fixture', { ...options, ...extra }), { code: 'ELIVE_PROVIDER_CONTRACT' });
    }
    assert.equal(state.requests.length, 0); assert.equal(dispatcher.dispatches, 0);
  } finally { dispatcher.close(); }
});

test('factory rejects endpoint overrides, native binding, credentials and live mode', () => {
  const { fixture, state } = fakeHttps();
  const config = { executionMode: 'offline-test', httpsFixture: fixture, model: MODEL, maxProviderCalls: 2, timeoutMs: 1000 };
  for (const extra of [{ url: 'https://other.invalid' }, { host: 'other' }, { path: '/other' }, { apiKey: 'SYNTHETIC_SECRET' },
    { executionMode: 'live' }, { httpsFixture: require('node:https') }, { httpsFixture: undefined }, { model: '../other' }]) {
    assert.throws(() => createSingleRequestHttpsDispatcher({ ...config, ...extra }));
  }
  assert.equal(state.requests.length, 0);
});

test('concurrent sends obey shared budget before HTTP fixture receives requests', async () => {
  const { dispatcher, state, send } = setup({}, { maxProviderCalls: 2 });
  try {
    const results = await Promise.allSettled(Array.from({ length: 5 }, send));
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 2);
    assert.equal(results.filter(row => row.reason?.code === 'ELIVE_PROVIDER_BUDGET').length, 3);
    assert.equal(state.serverRequests, 2); assert.equal(state.requests.length, 2); assert.equal(dispatcher.dispatches, 2);
  } finally { dispatcher.close(); }
});

test('offline CLI still rejects live execution without loading this transport', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'evaluate-live-summaries.js'), '--execute'], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).execution, 'NOT RUN');
});
