'use strict';

const { SUITES, runGuarded, launchReport } = require('../evaluation/regressionGuard');
function run(script, profile) {
  const { result, guard, safe } = runGuarded(script, [], profile);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const passed = safe && result.status === 0;
  console.log(JSON.stringify({ script, status: passed ? 'PASS' : 'FAIL', exitCode: result.status,
    guard: guard || 'MISSING_OR_INVALID', signal: result.signal || null }));
  return passed;
}
function main(args) {
  if (args.length === 1 && args[0] === '--self-test') return run('test-regression-guard.js', 'offline');
  if (args.length === 2 && args[0] === '--suite' && Object.hasOwn(SUITES, args[1])) {
    return run(SUITES[args[1]], args[1] === 'loopback' ? 'loopback' : 'offline');
  }
  if (args.length === 1 && args[0] === '--all') {
    if (!run('test-regression-guard.js', 'offline')) return false;
    for (const [name, script] of Object.entries(SUITES)) if (!run(script, name === 'loopback' ? 'loopback' : 'offline')) return false;
    return true;
  }
  console.error('Expected --self-test, --suite <reviewed-name>, or --all'); return false;
}
if (require.main === module) {
  const passed = main(process.argv.slice(2));
  const ledger = launchReport();
  console.log(JSON.stringify({ supervisor: ledger }));
  process.exitCode = passed && ledger.violations === 0 ? 0 : 1;
}
