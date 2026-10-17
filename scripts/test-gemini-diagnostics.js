const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { channel } = require('node:diagnostics_channel');

const sdkPath = require.resolve('@google/genai');
const originalSdk = require.cache[sdkPath];
let nextError;
let sdkCalls = 0;
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { GoogleGenAI: class {
    constructor() {
      this.models = { generateContent: async () => {
        sdkCalls += 1;
        throw nextError;
      } };
    }
  } }
};
const client = require('../services/geminiClientService');
if (originalSdk) require.cache[sdkPath] = originalSdk;
else delete require.cache[sdkPath];

const previousKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = 'test-placeholder';
after(() => {
  if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousKey;
});

async function capture(error, subscriber) {
  nextError = error;
  const diagnostics = [];
  const diagnosticChannel = channel('evinews.gemini.generate.error');
  const listener = subscriber || (snapshot => diagnostics.push(snapshot));
  diagnosticChannel.subscribe(listener);
  const before = sdkCalls;
  let thrown;
  try {
    await client.generateText('fixture', { model: 'fixture-model', maxAttempts: 1, timeoutMs: 100 });
  } catch (caught) {
    thrown = caught;
  } finally {
    diagnosticChannel.unsubscribe(listener);
  }
  assert.equal(sdkCalls - before, 1);
  return { diagnostics, thrown };
}

test('publishes only allowed scalar fields for error and one cause', async () => {
  const cause = Object.assign(new TypeError('secret-bearing message'), {
    code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', status: 503,
    response: { status: 429 }, cause: Object.assign(new Error('nested secret'), { code: 'ECONNRESET' })
  });
  const error = Object.assign(new Error('fetch failed'), {
    status: 502, response: { status: 503 }, cause
  });
  const { diagnostics, thrown } = await capture(error);
  assert.deepEqual(diagnostics, [{
    name: 'Error', status: 502, responseStatus: 503, hasCause: true,
    cause: { name: 'TypeError', code: 'ENOTFOUND', syscall: 'getaddrinfo', errno: -3008, status: 503, responseStatus: 429 }
  }]);
  assert.equal(thrown.code, 'GEMINI_SERVER');
  assert.equal(diagnostics[0].cause.cause, undefined);
  assert.notEqual(diagnostics[0], error);
  assert.notEqual(diagnostics[0].cause, cause);
});

test('omits unbounded, invalid and secret-bearing fields', async () => {
  const secret = 'secret-request-token';
  const error = Object.assign(new Error(secret), {
    name: secret, code: secret, errno: secret, syscall: secret,
    status: '503', response: { status: 700, headers: { Authorization: secret } },
    headers: { Authorization: secret }, url: `https://example.invalid/?key=${secret}`,
    prompt: secret, cause: { name: secret, code: 'UND_ERR_' + 'A'.repeat(100), errno: {}, syscall: secret, status: -1, response: { status: '500' }, message: secret }
  });
  const { diagnostics, thrown } = await capture(error);
  assert.deepEqual(diagnostics, [{ hasCause: true, cause: {} }]);
  assert.equal(thrown.code, secret);
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
});

test('generic fetch failure retains existing classification without publishing its message', async () => {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error('private network detail'), { code: 'ECONNRESET', syscall: 'read' });
  const { diagnostics, thrown } = await capture(error);
  assert.deepEqual(diagnostics, [{ name: 'TypeError', hasCause: true, cause: { name: 'Error', code: 'ECONNRESET', syscall: 'read' } }]);
  assert.equal(thrown.code, 'GEMINI_ERROR');
  assert.equal(thrown.message, 'fetch failed');
  assert.deepEqual(client.classifyError(error).code, thrown.code);
});

test('existing timeout and rate-limit classifications remain unchanged', async () => {
  const timeout = Object.assign(new Error('timed out'), { code: 'GEMINI_TIMEOUT' });
  const timeoutResult = await capture(timeout);
  assert.equal(timeoutResult.thrown, timeout);
  assert.deepEqual(timeoutResult.diagnostics, [{ name: 'Error', code: 'GEMINI_TIMEOUT', hasCause: false }]);
  const rateLimit = Object.assign(new Error('rate limited'), { response: { status: 429 } });
  const rateResult = await capture(rateLimit);
  assert.equal(rateResult.thrown.code, 'GEMINI_RATE_LIMIT');
  assert.equal(rateResult.diagnostics[0].responseStatus, 429);
});

test('classification is unchanged when there is no diagnostic subscriber', async () => {
  nextError = new TypeError('fetch failed');
  const before = sdkCalls;
  let thrown;
  try {
    await client.generateText('fixture', { model: 'fixture-model', maxAttempts: 1, timeoutMs: 100 });
  } catch (error) {
    thrown = error;
  }
  assert.equal(sdkCalls - before, 1);
  assert.equal(thrown.code, 'GEMINI_ERROR');
});

test('does not load persistence modules or make a real provider call', () => {
  assert.equal(require.cache[require.resolve('../services/summaryQueryService')], undefined);
  assert.ok(sdkCalls > 0);
});
