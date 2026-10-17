'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createOfflineSummaryWorkflow } = require('./offlineSummaryWorkflow');
const { requireSafe, failure } = require('./liveSummarySafety');
const PROTOCOL = 'evinews-native-summary-v1';
const SECRET_PROTOCOL = 'evinews-evaluation-secret-v1';

function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(fields).length === keys.length && keys.every(key => fields[key] &&
    Object.hasOwn(fields[key], 'value') && fields[key].enumerable);
}

// IPC JSON is mutable. Copy only its unambiguous data representation, then freeze.
function freezeData(value, depth = 0, state = { values: 0, bytes: 0, seen: new Set() }) {
  requireSafe(depth <= 40 && ++state.values <= 10000, 'ENATIVE_MANIFEST_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value);
    requireSafe(value.length <= 80000 && state.bytes <= 100000, 'ENATIVE_MANIFEST_INVALID'); return value;
  }
  if (typeof value === 'number') { requireSafe(Number.isFinite(value), 'ENATIVE_MANIFEST_INVALID'); return value; }
  requireSafe(value && typeof value === 'object' && !state.seen.has(value) &&
    Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype), 'ENATIVE_MANIFEST_INVALID');
  state.seen.add(value);
  const fields = Object.getOwnPropertyDescriptors(value), result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(fields)) {
    if (Array.isArray(value) && key === 'length') continue;
    requireSafe(typeof key === 'string' && fields[key].enumerable && Object.hasOwn(fields[key], 'value') &&
      (!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length), 'ENATIVE_MANIFEST_INVALID');
    Object.defineProperty(result, key, { value: freezeData(fields[key].value, depth + 1, state), enumerable: true });
  }
  if (Array.isArray(value)) requireSafe(result.length === value.length &&
    Array.from({ length: value.length }, (_, i) => Object.hasOwn(result, i)).every(Boolean), 'ENATIVE_MANIFEST_INVALID');
  state.seen.delete(value);
  return Object.freeze(result);
}

function prepareNativeManifest(input, channel) {
  const manifest = freezeData(input);
  requireSafe(exact(manifest, ['config', 'approval', 'snapshots', 'snapshotApproval', 'nativeApproval']) &&
    Buffer.byteLength(JSON.stringify(manifest)) <= 100000, 'ENATIVE_MANIFEST_INVALID');
  const workflow = createOfflineSummaryWorkflow({ ...manifest, executionMode: 'authenticated-native-evaluation',
    httpsTransport: { credentialChannel: channel, nativeApproval: manifest.nativeApproval } });
  return { manifest, workflow, model: manifest.config.summary.model, fingerprint: manifest.snapshotApproval.fingerprints[0] };
}

const categories = new Set(['NETWORK', 'TIMEOUT', 'CANCELLED', 'HTTP', 'RESPONSE_LIMIT', 'RESPONSE_PARSE']);
const codes = new Set(['EACCES', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH',
  'EHOSTUNREACH', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
function diagnostic(value) {
  if (!value || !categories.has(value.category)) return null;
  const clean = { category: value.category };
  if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) clean.status = value.status;
  if (codes.has(value.code)) clean.code = value.code;
  return Object.freeze(clean);
}
function safeResult(result, run) {
  return Object.freeze({ status: ['accepted', 'failed', 'needs_review', 'insufficient_grounding'].includes(result?.status) ? result.status : 'failed',
    model: run.model, fingerprint: run.fingerprint, dispatches: run.workflow.dispatches,
    validation: result?.error?.code === 'SUMMARY_INVALID_OUTPUT' ? 'FAIL' : result?.structured_output ? 'PASS' : 'NOT_REACHED',
    grounding: result?.status === 'accepted' ? 'PASS' : result?.status === 'needs_review' ? 'FAIL' : 'NOT_REACHED',
    factual_truth_verified: false, diagnostic: diagnostic(result?.diagnostic) });
}

// This screen only avoids needless credential entry. Generation still performs
// its own eligibility, validation and grounding checks before accepting output.
function hasGenerationInput(context) {
  const claims = new Map(context.claims.map(claim => [claim.claim_id, claim]));
  return context.claims.length > 0 && context.evidence.some(row => {
    const claim = claims.get(row.claim_id);
    return claim && claim.article_id === row.article_id && claim.source?.name && row.source_grounded === true &&
      typeof row.evidence_text === 'string' && row.evidence_text.trim() && row.evidence_hash &&
      crypto.createHash('sha256').update(row.evidence_text.trim().replace(/\s+/g, ' '), 'utf8').digest('hex') === row.evidence_hash;
  });
}
function validResult(value, model, fingerprint) {
  return exact(value, ['status', 'model', 'fingerprint', 'dispatches', 'validation', 'grounding', 'factual_truth_verified', 'diagnostic']) &&
    value.model === model && value.fingerprint === fingerprint &&
    ['accepted', 'failed', 'needs_review', 'insufficient_grounding'].includes(value.status) &&
    [0, 1].includes(value.dispatches) && ['PASS', 'FAIL', 'NOT_REACHED'].includes(value.validation) &&
    ['PASS', 'FAIL', 'NOT_REACHED'].includes(value.grounding) && value.factual_truth_verified === false &&
    (value.diagnostic === null || JSON.stringify(value.diagnostic) === JSON.stringify(diagnostic(value.diagnostic))) &&
    (value.status !== 'accepted' || value.dispatches === 1 && value.validation === 'PASS' && value.grounding === 'PASS');
}

function startNativeWorker(channel, lifecycle = process) {
  requireSafe(channel && typeof channel.send === 'function', 'ENATIVE_IPC_REQUIRED');
  const credentialChannel = new EventEmitter();
  let phase = 'INIT', run, stopped = false;
  const send = message => { try { channel.send(message); } catch (_) { stop(); } };
  const cleanup = () => {
    channel.removeListener('message', message); channel.removeListener('disconnect', stop); channel.removeListener('error', stop);
    lifecycle.removeListener('SIGINT', stop); lifecycle.removeListener('SIGTERM', stop);
  };
  function stop() {
    if (stopped) return;
    stopped = true; phase = 'CLOSED'; run?.workflow.close(); credentialChannel.emit('disconnect'); cleanup();
    try { channel.disconnect?.(); } catch (_) { /* Already disconnected. */ }
  }
  function reject() {
    if (stopped) return;
    run?.workflow.close();
    send({ protocol: PROTOCOL, type: 'FAILED' }); stop();
  }
  credentialChannel.send = value => {
    if (phase !== 'EXECUTING' || !exact(value, ['protocol', 'type']) || value.protocol !== SECRET_PROTOCOL || value.type !== 'PREFLIGHT_PASSED') {
      reject(); throw failure('ENATIVE_PROTOCOL');
    }
    phase = 'CREDENTIAL'; send(value);
  };
  async function execute() {
    try {
      const result = await run.workflow.evaluate(run.fingerprint);
      if (stopped) return;
      if (phase === 'PRECHECK') requireSafe(result.status === 'insufficient_grounding' && run.workflow.dispatches === 0, 'ENATIVE_PROTOCOL');
      phase = 'RESULT'; send({ protocol: PROTOCOL, type: 'RESULT', result: safeResult(result, run) });
      stop();
    } catch (_) { reject(); }
  }
  function message(value) {
    try {
      if (exact(value, ['protocol', 'type']) && value.protocol === PROTOCOL && value.type === 'CANCEL') { stop(); return; }
      if (phase === 'INIT') {
        requireSafe(exact(value, ['protocol', 'type', 'manifest']) && value.protocol === PROTOCOL && value.type === 'INIT', 'ENATIVE_PROTOCOL');
        run = prepareNativeManifest(value.manifest, credentialChannel);
        if (!hasGenerationInput(run.manifest.snapshots[0])) {
          phase = 'PRECHECK'; void execute(); return;
        }
        phase = 'READY';
        send({ protocol: PROTOCOL, type: 'PREFLIGHT_READY', model: run.model, fingerprint: run.fingerprint }); return;
      }
      if (phase === 'READY') {
        requireSafe(exact(value, ['protocol', 'type']) && value.protocol === PROTOCOL && value.type === 'EXECUTE', 'ENATIVE_PROTOCOL');
        phase = 'EXECUTING'; void execute(); return;
      }
      requireSafe(phase === 'CREDENTIAL' && exact(value, ['protocol', 'secret']) && value.protocol === SECRET_PROTOCOL, 'ENATIVE_PROTOCOL');
      phase = 'RUNNING'; credentialChannel.emit('message', value);
    } catch (_) { reject(); }
  }
  channel.on('message', message); channel.on('disconnect', stop); channel.on('error', stop);
  lifecycle.on('SIGINT', stop); lifecycle.on('SIGTERM', stop);
  return Object.freeze({ close: stop });
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--authorized-worker' || !process.send) process.exitCode = 1;
  else startNativeWorker(process);
}
module.exports = { PROTOCOL, exact, freezeData, prepareNativeManifest, validResult, startNativeWorker };
