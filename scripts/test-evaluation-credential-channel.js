'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { receiveEvaluationSecret } = require('../evaluation/evaluationCredentialChannel');
const protocol = 'evinews-evaluation-secret-v1';
function channel(message) {
  const value = new EventEmitter(); value.requests = 0;
  value.send = request => { value.requests++; assert.deepEqual(request, { protocol, type: 'PREFLIGHT_PASSED' });
    if (message !== undefined) queueMicrotask(() => value.emit('message', message)); };
  return value;
}
function detached(value) { for (const name of ['message', 'disconnect', 'close', 'error']) assert.equal(value.listenerCount(name), 0); }
test('one secret message is consumed once and all listeners detach', async () => {
  const value = channel({ protocol, secret: 'DUMMY_EVALUATION_ONLY' });
  assert.equal(await receiveEvaluationSecret(value, new AbortController().signal), 'DUMMY_EVALUATION_ONLY');
  detached(value); assert.equal(value.requests, 1);
  assert.throws(() => receiveEvaluationSecret(value, new AbortController().signal));
});

test('maximum credential length is accepted without publishing it', async () => {
  const value = channel({ protocol, secret: 'x'.repeat(512) });
  const secret = await receiveEvaluationSecret(value, new AbortController().signal);
  assert.equal(secret.length, 512); detached(value);
});
for (const [name, message] of [
  ['null', null], ['array', []], ['missing', { protocol }], ['extra', { protocol, secret: 'dummy', extra: true }],
  ['protocol', { protocol: 'other', secret: 'dummy' }], ['empty', { protocol, secret: '' }],
  ['control', { protocol, secret: 'dummy\r\nheader' }], ['space', { protocol, secret: 'dummy secret' }],
  ['unbounded', { protocol, secret: 'x'.repeat(513) }], ['object', { protocol, secret: {} }],
  ['getter', { protocol, get secret() { throw new Error('Accessor must not execute'); } }]
]) test(`invalid credential message ${name} fails closed`, async () => {
  const value = channel(message);
  await assert.rejects(receiveEvaluationSecret(value, new AbortController().signal), { code: 'EEVAL_CREDENTIAL_INVALID' }); detached(value);
});
for (const name of ['disconnect', 'close', 'error']) test(`channel ${name} is sanitized`, async () => {
  const value = channel(), pending = receiveEvaluationSecret(value, new AbortController().signal);
  value.emit(name, new Error('DUMMY_SECRET_DO_NOT_EXPOSE'));
  await assert.rejects(pending, error => { assert.equal(error.code, 'EEVAL_CREDENTIAL_CLOSED'); assert.ok(!error.message.includes('DUMMY')); return true; }); detached(value);
});
test('five-second delivery timeout cleans up without wall-clock waiting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const value = channel(), pending = receiveEvaluationSecret(value, new AbortController().signal);
  t.mock.timers.tick(5000);
  await assert.rejects(pending, { code: 'EEVAL_CREDENTIAL_TIMEOUT' }); detached(value);
});
test('cancellation detaches pending channel and prevents late delivery', async () => {
  const value = channel(), controller = new AbortController(), pending = receiveEvaluationSecret(value, controller.signal);
  controller.abort(); await assert.rejects(pending, { code: 'EEVAL_CREDENTIAL_CANCELLED' }); detached(value);
  value.emit('message', { protocol, secret: 'late-dummy' }); assert.equal(value.requests, 1);
});
test('already cancelled or malformed channel never sends a credential request', async () => {
  const value = channel(), controller = new AbortController(); controller.abort();
  await assert.rejects(receiveEvaluationSecret(value, controller.signal)); assert.equal(value.requests, 0); detached(value);
  assert.throws(() => receiveEvaluationSecret({}, new AbortController().signal));
});
