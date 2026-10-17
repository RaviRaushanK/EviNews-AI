'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runGuarded, readReport, launchReport } = require('../evaluation/regressionGuard');
const probe = process.argv[2] === '--probe' && process.argv[3];
if (probe) {
  const fs = require('node:fs');
  const path = require('node:path');
  const actions = {
    environment() { void process.env.GEMINI_API_KEY; },
    dotenv() { require('dotenv'); },
    'env-file'() { fs.readFileSync(path.join(__dirname, '../.env')); },
    sdk() { require('@google/genai'); },
    database() { require('../config/database'); },
    network() { require('node:net').connect({ host: '127.0.0.1', port: 1 }); },
    dns() { require('node:dns').lookup('not-contacted.invalid', () => {}); },
    write() { fs.writeFileSync(path.join(__dirname, '../guard-must-not-exist.txt'), 'never written'); },
    'promise-write'() { return fs.promises.writeFile(path.join(__dirname, '../guard-must-not-exist.txt'), 'never written'); },
    child() { require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 1000 }); },
    'child-options'() { require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'evaluate-live-summaries.js')],
      { encoding: 'utf8', timeout: 1000, env: { NODE_OPTIONS: '--not-permitted' } }); },
    'missing-report'() { process.removeAllListeners('exit'); },
    timeout() { setTimeout(() => {}, 30000); },
    signal() { process.kill(process.pid, 'SIGTERM'); },
    'unexpected-exit'() { process.exitCode = 2; },
    'nested-caught'() { require('node:child_process').spawnSync(process.execPath, [__filename, '--probe', 'caught'], { encoding: 'utf8', timeout: 10000 }); },
    'nested-missing'() { require('node:child_process').spawnSync(process.execPath, [__filename, '--probe', 'missing-report'], { encoding: 'utf8', timeout: 10000 }); },
    'nested-helper-failure'() { runGuarded('test-regression-guard.js', ['--probe', 'caught'], 'probe'); },
    'nested-helper-missing'() { runGuarded('test-regression-guard.js', ['--probe', 'missing-report'], 'probe'); },
    'nested-helper-exit'() { runGuarded('test-regression-guard.js', ['--probe', 'unexpected-exit'], 'probe'); },
    'nested-helper-timeout'() { runGuarded('test-regression-guard.js', ['--probe', 'timeout'], 'probe', { timeout: 500 }); },
    'nested-helper-signal'() { runGuarded('test-regression-guard.js', ['--probe', 'signal'], 'probe'); },
    'direct-unreviewed'() { runGuarded('app.js'); },
    'ordinary-helper-loopback'() { runGuarded('test-offline-summary-loopback.js', [], 'loopback'); },
    'ordinary-helper-suite'() { runGuarded('test-single-request-https-transport.js'); },
    'ordinary-helper-probe'() { runGuarded('test-regression-guard.js', ['--probe', 'caught'], 'probe'); },
    'ordinary-helper-cli'() {
      const child = runGuarded('evaluate-live-summaries.js', ['--execute']);
      assert.equal(child.result.status, 1); assert.equal(child.safe, true);
      const report = launchReport(); assert.equal(report.attempts, 1); assert.equal(report.children, 1);
      assert.equal(report.launches[0].outcome, 'CLI_REJECTED');
    },
    'ordinary-spawn-cli'() {
      const child = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'evaluate-live-summaries.js'), '--execute'],
        { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 1); assert.equal(launchReport().launches[0].outcome, 'CLI_REJECTED');
    },
    'ledger-overflow'() {
      for (let i = 0; i < 65; i++) { try { runGuarded('app.js'); } catch (_) { /* Each rejection must remain recorded. */ } }
      assert.equal(launchReport().attempts, 65); assert.equal(launchReport().launches.length, 64); assert.equal(launchReport().children, 0);
    },
    'loopback-host'() { require('node:https').request({ hostname: 'external.invalid', port: 443, rejectUnauthorized: true }); },
    'loopback-port'() { require('node:net').connect({ host: '127.0.0.1', port: 1 }); },
    'loopback-tls'() { require('node:tls').connect({ host: '127.0.0.1', port: 1, rejectUnauthorized: false }); },
    'loopback-binding'() { require('node:net').createServer().listen(0, '0.0.0.0'); },
    'loopback-dns'() { require('node:dns').lookup('external.invalid', () => {}); },
    caught() { try { require('node:https').request('https://not-contacted.invalid'); } catch (_) { /* Guard must still fail. */ } },
    config() {
      const config = require('../config/summaries');
      assert.equal(config.model, ''); assert.equal(config.promptVersion, 'phase7-v2'); assert.ok(Object.isFrozen(config));
      assert.equal(require('../config/embeddings').gemini.apiKey, '');
      assert.deepEqual(Object.keys(process.env).sort(), ['EVINEWS_REGRESSION_PROFILE', 'NODE_ENV', 'NO_COLOR',
        ...(process.platform === 'win32' ? ['SystemRoot'] : []), 'TZ'].sort());
      assert.equal(process.env.NODE_ENV, 'test');
    },
    listeners() { assert.equal(typeof require('node:net').connect, 'function'); }
  };
  Promise.resolve().then(() => actions[probe]()).catch(error => {
    // Intentionally swallow probe errors: the independent guard report must fail.
    assert.match(error.code, /^GUARD_/); process.exitCode = 0;
  });
} else {
  for (const name of ['environment', 'dotenv', 'env-file', 'sdk', 'database', 'network', 'dns', 'write',
    'promise-write', 'child', 'child-options', 'caught', 'nested-caught', 'nested-missing',
    'nested-helper-failure', 'nested-helper-missing', 'nested-helper-exit', 'nested-helper-timeout', 'nested-helper-signal',
    'direct-unreviewed', 'ledger-overflow']) test(`caught ${name} violation fails independently of assertions`, () => {
    const child = runGuarded('test-regression-guard.js', ['--probe', name], 'probe');
    assert.equal(child.safe, false); assert.ok(child.guard); assert.ok(child.guard.violations > 0); assert.equal(child.result.status, 1);
    if (name.startsWith('nested-')) {
      assert.equal(child.guard.attempts, 1); assert.equal(child.guard.children, 1);
      assert.notEqual(child.guard.launches[0].outcome, 'EXPECTED_PROBE');
      if (name === 'nested-helper-exit') {
        assert.equal(child.guard.launches[0].childViolations, 0); assert.equal(child.guard.launches[0].status, 2);
        assert.equal(child.guard.launches[0].outcome, 'UNEXPECTED_EXIT');
      }
    }
  });
  for (const name of ['ordinary-helper-loopback', 'ordinary-helper-suite', 'ordinary-helper-probe']) {
    test(`${name} cannot bypass role policy or parent accounting`, () => {
      const child = runGuarded('test-regression-guard.js', ['--probe', name], 'offline');
      assert.equal(child.result.status, 1); assert.equal(child.guard.role, 'suite');
      assert.equal(child.guard.attempts, 1); assert.equal(child.guard.children, 0);
      assert.equal(child.guard.launches[0].outcome, 'DENIED'); assert.ok(child.guard.violations > 0);
    });
  }
  for (const name of ['ordinary-helper-cli', 'ordinary-spawn-cli']) {
    test(`${name} preserves reviewed negative CLI behavior with full accounting`, () => {
      const child = runGuarded('test-regression-guard.js', ['--probe', name], 'offline');
      assert.equal(child.result.status, 0); assert.equal(child.safe, true); assert.equal(child.guard.attempts, 1);
      assert.equal(child.guard.launches[0].outcome, 'CLI_REJECTED');
    });
  }
  for (const name of ['loopback-host', 'loopback-port', 'loopback-tls', 'loopback-binding', 'loopback-dns']) {
    test(`${name} is rejected before any external/unauthorized socket`, () => {
      const child = runGuarded('test-regression-guard.js', ['--probe', name], 'loopback');
      assert.equal(child.safe, false); assert.equal(child.result.status, 1); assert.ok(child.guard.codes.includes('GUARD_NETWORK'));
    });
  }
  for (const name of ['config', 'listeners']) test(`reviewed ${name} operation succeeds with zero violations`, () => {
    const child = runGuarded('test-regression-guard.js', ['--probe', name], 'probe');
    assert.equal(child.safe, true); assert.equal(child.result.status, 0); assert.equal(child.guard.violations, 0);
  });
  test('missing report fails closed even with successful process exit', () => {
    const child = runGuarded('test-regression-guard.js', ['--probe', 'missing-report'], 'probe');
    assert.equal(child.result.status, 0); assert.equal(child.guard, null); assert.equal(child.safe, false);
  });
  test('malformed or oversized guard reports cannot count as clean', () => {
    for (const value of ['', '{}', '{', 'x'.repeat(16385), JSON.stringify({ protocol: 'other', violations: 0 }),
      JSON.stringify({ protocol: 'evinews-regression-guard-v1', violations: -1, children: 0, codes: [] })]) {
      assert.equal(readReport({ output: [null, null, null, value] }), null);
    }
  });
  test('inconsistent ledgers and non-self-test probe exemptions cannot report clean', () => {
    const row = { command: 'evaluate-live-summaries.js', admitted: true, status: 0, outcome: 'SUCCESS', report: 'VALID', childViolations: 0 };
    const report = { protocol: 'evinews-regression-guard-v2', role: 'suite', violations: 0, children: 1, attempts: 1, codes: [], launches: [row] };
    assert.ok(readReport({ output: [null, null, null, JSON.stringify(report)] }));
    for (const change of [{ children: 0 }, { launches: [{ ...row, outcome: 'RUNNING' }] },
      { launches: [{ ...row, outcome: 'DENIED', admitted: false }], children: 0 },
      { launches: [{ ...row, outcome: 'EXPECTED_PROBE' }] }]) {
      assert.equal(readReport({ output: [null, null, null, JSON.stringify({ ...report, ...change })] }), null);
    }
  });
  test('timed out child cannot count as clean even without an assertion failure', () => {
    const child = runGuarded('test-regression-guard.js', ['--probe', 'timeout'], 'probe', { timeout: 500 });
    assert.equal(child.safe, false); assert.equal(child.result.error?.code, 'ETIMEDOUT');
  });
  test('terminated child cannot count as clean', () => {
    const child = runGuarded('test-regression-guard.js', ['--probe', 'signal'], 'probe');
    assert.equal(child.safe, false); assert.ok(child.result.signal || child.result.status !== 0); assert.equal(child.guard, null);
  });
}
