'use strict';

// Separate from the preflight-only CLI. No I/O occurs on import.
async function main(args) {
  if (args.length !== 3 || args[0] !== '--authorize-one-gemini-request' || args[1] !== '--manifest' || !process.stdin.isTTY) {
    return { status: 'REJECTED', code: 'ENATIVE_EXPLICIT_AUTHORIZATION_AND_TTY_REQUIRED' };
  }
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.resolve(args[2]);
    // Only a separately reviewed non-secret manifest, never an environment file.
    if (/(?:^|[\\/])\.env(?:[.\\/]|$)/i.test(file) || !file.endsWith('.json')) throw new Error('Rejected');
    if (fs.lstatSync(file).isSymbolicLink() || path.resolve(fs.realpathSync(file)).toLowerCase() !== file.toLowerCase()) throw new Error('Rejected');
    const fd = fs.openSync(file, 'r'); let bytes;
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 100000) throw new Error('Rejected');
      bytes = Buffer.alloc(100001); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 100000) throw new Error('Rejected');
      const manifest = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      bytes.fill(0); bytes = undefined;
      const { launchNativeSummary } = require('../evaluation/nativeSummaryLauncher');
      return await launchNativeSummary({ manifest, authorization: 'AUTHORIZE_ONE_GEMINI_REQUEST', input: process.stdin });
    } finally { bytes?.fill(0); fs.closeSync(fd); }
  } catch (_) { return { status: 'REJECTED', code: 'ENATIVE_EXECUTION_FAILED' }; }
}
if (require.main === module) void main(process.argv.slice(2)).then(result => {
  console.log(JSON.stringify(result)); process.exitCode = result.status === 'accepted' ? 0 : 1;
});
module.exports = { main };
