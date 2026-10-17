/* Self-contained dry-run scanner.
 * Uses node's child_process.execFile (shell:false) to capture the REAL
 * captured stdout of scripts/extract-claims.js --dry-run, because direct
 * console redirection through cmd mangled quoting. This captures, prints and
 * audits with zero shell-side quoting (no %, $, &, or nested quotes on the
 * node command line). */
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = 'C:\\Users\\Ravi\\Desktop\\EviNews-AI';
const CLAIM = path.join(ROOT, 'scripts', 'extract-claims.js');
const NODE = process.execPath;

const RUN = (label) => new Promise((resolve) => {
  execFile(NODE, [CLAIM, '--dry-run'], { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ label, err, stdout, stderr }));
});

const runWithLimit = (label, limit) => new Promise((resolve) => {
  execFile(NODE, [CLAIM, '--dry-run', '--limit=' + limit], { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ label, err, stdout, stderr }));
});

function snapshot(marker) {
  const out = {};
  const entries = [
    ['summary ', path.join(os.tmpdir(), 'evinews-summary.txt')],
    ['dryrun24 ', path.join(ROOT, 'dryrun-live.txt')],
    ['LIVE    ', path.join(ROOT, 'dryrun-live.txt')],
  ];
  for (const [lab, p] of entries) {
    try {
      const st = fs.statSync(p);
      out[lab] = { exists: true, mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) { out[lab] = { exists: false }; }
  }
  return out;
}

(async () => {
  const pre = snapshot('pre');
  const noLimit = await RUN('plain');
  const limited = await runWithLimit('limit3', 3);
  const post = snapshot('post');

  const lines = [];
  const push = (s) => lines.push(String(s));
  const hdr = (s) => { push(''); push('='.repeat(70)); push(' ' + s); push('='.repeat(70)); };

  hdr('EXITCODE ' + noLimit.label + ' exit=' + (noLimit.err ? 'ERR:' + noLimit.err.code : '0'));
  push('[stderr-line1] ' + (noLimit.stderr ? noLimit.stderr.split(/\r?\n/)[0] : ''));
  push('[stdout-first] ' + (noLimit.stdout ? noLimit.stdout.split(/\r?\n/)[0] : ''));
  push('--- FULL CAPTURED STDOUT (dry-run plain) ---');
  push(noLimit.stdout === undefined ? '(none)' : (noLimit.stdout || '(empty)'));
  if (noLimit.stderr) { push('--- stderr (plain) ---'); push(noLimit.stderr); }

  hdr('SECOND RUN with --limit=3');
  push('exit=' + (limited.err ? 'ERR:' + limited.err.code : '0'));
  push('[stdout-first] ' + (limited.stdout ? limited.stdout.split(/\r?\n/)[0] : ''));
  push('--- stderr (limit3) ---');
  push(limited.stderr || '(none)');

  hdr('MTIME SNAPSHOT (dry-run must not write claims/summary)');
  push('=== PRE (before dry-run) ===');
  for (const k of Object.keys(pre)) push(' ' + k + Object.keys(pre[k]).map((kk)=>pre[k][kk]).join(' '));
  push('=== POST (after dry-run) ===');
  for (const k of Object.keys(post)) push(' ' + k + Object.keys(post[k]).map((kk)=>post[k][kk]).join(' '));
  const anyWritten = Object.keys(post).some((k) => post[k].exists && (!pre[k] || !pre[k].exists));
  push('CHANGED_FILES_DURING_DRYRUN=' + (anyWritten ? 'SOMETHING_CHANGED' : 'NONE_WRITTEN'));

  const report = lines.join('\r\n');
  fs.writeFileSync(path.join(ROOT, 'dscan-report.txt'), report, 'utf8');

  hdr('REPORT WRITTEN — printed below cleanly (no CM1 mangling)');
  push(report);
  fs.writeFileSync(path.join(ROOT, 'dscan-print.txt'), report, 'utf8');
  process.stdout.write('\n' + report + '\n');
})().catch((e) => { process.stderr.write('DSCAN_FATAL ' + (e && e.stack || e)); process.exit(2); });
