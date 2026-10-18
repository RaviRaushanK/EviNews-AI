'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeArtifactPath, evaluateArtifact } = require('../evaluation/realWorldQuality');
const ROOT = path.resolve(__dirname, '..');
function loadArtifact(relative) {
  safeArtifactPath(relative);
  if (!/^(?:fixtures|evaluation\/corpora)\/.+\.json$/.test(relative)) throw new Error('Rejected artifact');
  const full = path.resolve(ROOT, relative);
  // Reject symlinked parents as well as symlinked files; metadata paths are never opened.
  let current = ROOT;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Rejected artifact');
  }
  if (fs.realpathSync(full) !== full || !fs.statSync(full).isFile() || fs.statSync(full).size > 1000000) throw new Error('Rejected artifact');
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}
function reportArtifact(artifact) {
  try {
    const report = evaluateArtifact(artifact);
    return { ...report, exitCode: report.evaluation_success ? 0 : 1 };
  } catch (_) {
    return { mode: 'OFFLINE_ARTIFACT_QUALITY_EVALUATION', complete: false, code: 'QUALITY_ARTIFACT_REJECTED', factual_truth_verified: false, exitCode: 1 };
  }
}
function main(args, output = value => console.log(JSON.stringify(value))) {
  try {
    if (args.length !== 1) throw new Error('Rejected arguments');
    const report = reportArtifact(loadArtifact(args[0]));
    output(report); return report.exitCode;
  } catch (_) {
    output({ mode: 'OFFLINE_ARTIFACT_QUALITY_EVALUATION', complete: false, code: 'QUALITY_ARTIFACT_REJECTED', factual_truth_verified: false, exitCode: 1 });
    return 1;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { loadArtifact, reportArtifact, main };
