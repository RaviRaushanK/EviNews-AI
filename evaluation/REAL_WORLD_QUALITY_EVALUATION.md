# Step 8W: Real-world quality evaluation protocol

This protocol measures accuracy to supplied sources, not independent factual
truth. It is an evaluation protocol, not evidence that the system is accurate.
Technical execution, format validity, source provenance, semantic support,
coverage and factual truth are different questions. Every artifact and report
must retain `factual_truth_verified: false`.

## Scope and levels

1. Claim/evidence: extraction precision, coverage, attribution, excerpt occurrence
   and separately human-labelled semantic support.
2. Event: contradiction candidates/classifications, report chronology and changes.
3. Summary: support, attribution, required-fact coverage, redundancy and conflict
   disclosure. Readability/usefulness need separate human review.
4. Overall run: execution, schema validity, abstention and repeat-run observations.

The artifact scorer does not run any of those production workflows. It scores
explicit captured observations against adjudicated human reference annotations.
It does not independently verify the honesty or correctness of annotations.
Gold-input component results must not be presented as end-to-end extraction
performance. Missing upstream outputs remain unavailable, not invented.

## Corpus and scenario families

Target ten events and approximately 32 reports, with two development events and
eight assessment events. Freeze the split, protocol, labels and acceptance
criteria before examining assessment results. Choose different news domains.
These are proposed selection quotas, not claims that real data was collected:

| Family | Events / reports | Reference expectation |
| --- | --- | --- |
| A Agreement | 2 / 6 | Independent origins agree; no invented conflict |
| B Numbers | 2 / 6 | Comparable scope/time/units; preserve disputed values |
| C Developing event | 2 / 8 | Distinguish updates, corrections and conflicts |
| D Attribution | 1 / 3 | Preserve the speaker and publisher, allegation/denial |
| E Weak evidence | 1 / 2 | No eligible grounded evidence allows abstention |
| F Syndication | 1 / 4 | Multiple publishers do not imply independent origins |
| G Mixed support | 1 / 3 | Supported facts do not license unsupported additions |

Small purposive samples support a college-project demonstration, not population
accuracy estimates or production threshold selection. A single source is not
automatically ineligible: abstention depends on the actual grounding contract.

## Artifact contract (8w-quality-v1)

`fixtures/real-world-quality-template.json` is invented local text. It is not a
real-news dataset and does not fulfil the final corpus quotas. Input `complete`
means the declared artifact's review is structurally complete, not that its stages,
the final ten-event project or live evaluation have succeeded. A missing run for
a declared event is rejected.

For preparation, `validateReferenceArtifact` accepts exactly version, kind,
complete, corpus, events and factual_truth_verified, without scope or runs. It
returns the validated input, not a scoring report or success classification.
Reference validation means only internally consistent, adjudicated annotations;
it does not establish system quality, provider operation or factual truth. The
shared reference validator is also used by full `validateArtifact`, which still
requires scope and runs. Reference-only input is rejected by the scoring API and
CLI. A dedicated preparation CLI remains future work; no placeholder executions
are necessary or permitted to simulate scoring completion.

An explicit `scope` contains `type` (component or end_to_end) and a nonempty,
duplicate-free `required_stages` list. Supported stages are technical, schema,
claims, evidence, summary, contradictions, timeline, changes, grounding, abstention
and idempotency. End-to-end scope must require all eleven. Component scope may
require a subset, such as claims/evidence only; omitted stages are NOT EVALUATED
with OUT_OF_SCOPE reasons even if supplemental observations were supplied.

Output `artifact_complete` records structural validity separately from `complete`,
which requires observations for every declared required stage in every run.
`evaluation_status` is COMPLETE, PARTIAL or NOT EVALUATED; stage statuses are
EVALUATED or NOT EVALUATED, never a fabricated PASS. Missing required observations
produce OBSERVATIONS_UNAVAILABLE. Empty prediction arrays are measured outputs;
grounding requires at least one decision trial and idempotency at least one
same-input trial. Schema requires an observed decision; abstention requires
observed summary results (an empty statements array can record an abstention).
For a legitimate pre-generation abstention with no schema observation, declare
the applicable component scope instead of claiming full end-to-end evaluation.

`evaluation_success` requires complete declared-stage evaluation plus minimum
checks. It does not certify accuracy or clear any live gate. CLI exit is nonzero
when required stages are unavailable. A successful component report always keeps
`end_to_end_complete` false. A complete measurement can also fail minimum checks.

Corpus metadata records identity, version, synthetic/development/assessment split,
storage approval and notes. Events record a scenario A-G, UTC assessment cutoff,
reports, atomic reference claims, evidence, relations, expected changes, required
and optional summary facts, prohibited settled assertions and expected abstention.
Two distinct reviewer IDs plus an adjudicator and resolved review are required.
Reviewers label independently before inspecting system output and adjudicate
differences. Unresolved required labels block scoring. Ambiguous relations may
be explicitly excluded with notes; their count remains in the report.

Reports record source, publisher, reporting-origin group and independence
confidence (confirmed/uncertain/unknown), canonical credential-free URL,
publication/collection/occurrence times, uncertainty/fallback flags, source text
and its SHA-256 hash. Dates use strict UTC ISO seconds or milliseconds; unknown
publication/occurrence dates are null. Collection and cutoff dates are required.
Publication/collection cannot be after the assessment cutoff. The artifact's
`complete` flag describes source availability; truncated sources must be labelled
and their recall interpreted only for the supplied text.

Source URLs are metadata, never fetch targets. A standard URL parser requires
HTTPS, a hostname and no embedded username/password; ordinary .html paths, dots,
query parameters and well-formed percent encodings are supported. Relative URLs,
other schemes, control/whitespace/backslash repairs and malformed encodings are
rejected. Original URL values are preserved, not rewritten. Synthetic examples
remain confined to the fixture.invalid HTTPS origin. No DNS, sockets, provider
or filesystem access occurs during URL/reference validation. URL validation does
not establish that a source exists or grants access/storage permission. Query
parameters must still be reviewed for sensitive values before artifact approval.

Claims record report ID, proposition, type, attribution, modality, quantity/unit,
location/reference period and an adjudicated equivalence group. Equivalent claims
share a recall target. An exact claim identity includes every claim field except
ID and equivalence group, with text whitespace normalized. Identical identities
must share the same equivalence group; inconsistent groups are rejected. Different
wording remains a human equivalence judgement, not inferred paraphrase detection.
Evidence records its claim/report, exact excerpt, UTF-16
start/end offsets and human relationship: support, contradict or insufficient.
Bounds require integer 0 <= start < end <= source length before slicing.
Occurrence in a source and support for a proposition are NOT the same label.

Relations contain two different claim IDs, kind (equivalent, conflict,
normal_update, correction, ambiguous), classification (direct/partial/temporal/
none, or null only for excluded ambiguity), required disclosure and review notes.
Normal updates/corrections/equivalence are labelled none, not direct conflicts.
Changed units, scopes or reference times need human comparison, not numeric-only
matching. Changes name previous/current claims and one existing Phase 6 category.
No labels or thresholds in the previous phases are changed by this protocol.

Conflict, equivalent and ambiguous relations are symmetric: their unordered pair
of canonical claim identities is the metric identity. Normal_update and correction
are directional, keyed by kind plus ordered claim identities (earlier/current);
their reverse is not automatically merged. Repeated agreeing annotations count
once. Conflicting kind/classification/disclosure/resolution for a duplicate key
fails validation. Reference IDs remain valid aliases, but cannot multiply candidate,
classification or disclosure counts. Conflicting predictions against aliases fail.

Runs explicitly identify technical status, schema decision (null if unavailable),
summary outcome, output claim-to-reference matches, evidence observations, reviewed
summary statements, candidates/classifications, disclosed relations, timeline,
change predictions, grounding trials, idempotency trials and warnings.
Unavailable observation arrays are null; measured empty arrays are [].
Human statement labels include proposition group, support and attribution. This
allows unsupported captured output to be scored without treating it as valid.
Each statement also requires `claim_support`: exactly one entry per referenced
claim, containing claim_id, evidence_ids and support. Every child evidence ID must
be cited by the statement and linked to that particular claim. The union must
match the statement's evidence list. A supported claim entry requires evidence;
a whole statement labelled support cannot contain unsupported claim entries.
Coverage requires accepted whole-statement support, correct attribution and the
corresponding supported/evidenced claim entry. Evidence for A never credits B.
Missing/contradictory claim-level judgements reject the artifact rather than
silently adding coverage. Non-supporting statements may retain explicit empty
or insufficient child support for evaluation, without receiving coverage credit.

Evidence observations are keyed by canonical reference claim identity, source
report and reference start/end offsets, not observation or reference IDs. Agreeing
duplicates count once in both evidence metrics; different excerpt or semantic
support annotations for the same key fail closed. Raw, unique and duplicate
observation counts remain visible. Distinct source spans/claim links remain
independently countable. This is metric deduplication, not a database operation.
Warning objects remain original separate metadata, including structured warnings;
the scorer does not convert them into statement text or message-only records.

## Metrics and denominators

All ratios expose `value`, `numerator`, `denominator`, `reason`. Zero denominators
produce `N/A / ZERO_DENOMINATOR`; missing observations produce
`N/A / OBSERVATIONS_UNAVAILABLE` with null counts. Do not substitute 0 or 1.
Metrics are per run/event, never an average of incompatible stage denominators.
Multiple runs of one event are not extra independent events. Reference exclusions
and incomparable timeline pairs are explicit. Aggregate manually by summing
compatible counts; distinguish micro results from equal-weight event averages.

| Metric | Numerator / denominator | Interpretation / limitation |
| --- | --- | --- |
| Technical completion | completed / attempted runs | Not semantic success |
| Schema validity | valid / observed schema decisions | Not grounding |
| Claim precision | supported extracted claims / extracted claims reviewed | Human semantic decision, not string matching |
| Claim recall | matched reference equivalence groups / reference groups | Duplicate predictions cannot inflate recall |
| Evidence traceability | source-occurring captured excerpts / reviewed evidence links | Links are structurally validated first |
| Evidence support | human support labels / reviewed evidence links | Occurrence alone is insufficient |
| Unsupported statement rate | unsupported accepted statements / accepted statements | Failed whole-statement support OR incorrect attribution; one count per statement |
| Unsupported acceptance | accepted adversarial unsupported trials / unsupported adversarial trials | Synthetic attack rate, not natural hallucination prevalence |
| Attribution accuracy | correct statement attribution / reviewed statements | Human publisher/speaker assessment |
| Candidate recall | reached conflict relations / reference conflict relations | Not classifier accuracy |
| Classification precision | TP / (TP+FP), per class | Missing labels are not created |
| Classification recall | TP / reference class pairs | Missing predictions count as missed reference pairs |
| Classification F1 | 2TP / (2TP+FP+FN) | Reports direct/partial/temporal/none TP/FP/FN and confusion matrix |
| Conflict preservation | disclosed required conflicts / required conflicts | Disclosure is an adjudicated observation, not inferred from keywords |
| Timeline ordering | correctly ordered comparable pairs / comparable report pairs | Ties/unknown/uncertain dates excluded; missing output reports miss pairs |
| Change precision | distinct correct reference changes / emitted changes | Duplicates penalize precision |
| Change recall | distinct correct reference changes / reference changes | Category must also match |
| Summary coverage | supported, correctly attributed, claim-evidenced required groups / required groups | All required core facts; current extractive limits can lower coverage |
| Grounding decision accuracy | correct accept/reject trials / reviewed trials | Gate observations, not truth |
| Insufficient-grounding accuracy | correct abstain/proceed / event run | Failed runs cannot count as correct proceed decisions |
| Redundancy | repeated accepted proposition groups / accepted statements | Human grouping, not automatic paraphrase judgement |
| Idempotency | unchanged outputs with zero extra dispatch / same-input trials | Captured in-memory observations, not DB concurrency proof |

The scorer reports publisher count, confirmed origin-group count and reports with
unknown/uncertain independence separately. It never treats publishers as an
independent corroboration score. The explicit minimum-check flag covers execution
failure, invalid observed schema and accepted unsupported/misattributed output or
adversarial false acceptance. It is NOT an overall accuracy/quality certification;
missing metrics remain visible and reference coverage can still be low. Rejected
or needs-review statements never enter the accepted-statement denominator.
Incorrect attribution makes an accepted whole statement unsupported even when its
content label is support; multiple support failures still count that statement
only once. Attribution accuracy remains a separate metric.

## Fingerprint and local input boundary

The evaluation fingerprint is SHA-256 of the entire validated artifact, with
object keys sorted, arrays order-preserved and JSON scalar encoding. It includes
corpus/version/split, references, local relative path metadata, article hashes and
text, times, source origin groups, reviewer labels, all run observations and all
warning fields. Changing evidence, source text, units, warnings or labels changes
this evaluation fingerprint. Scope and claim-level support annotations also
participate. It is NOT the production generation/cache key.
No credential or secret prompt belongs in an approved artifact. The scorer does
not discover secrets or prove the supplied artifact is safe for publication.

CLI input is a single relative .json path below fixtures/ or evaluation/corpora/.
Absolute, traversal, URL, environment/credential-like paths and symlinked paths
are rejected. Metadata paths below artifacts/ are validated but never opened.
Local path validation is separate from source URL parsing and is unchanged;
accepting HTTPS URL syntax never authorizes a URL as a local artifact path.
The input limit is 1 MB; nesting/value counts and array lengths are bounded.
Data accessors, hidden properties, symbols, sparse/custom arrays and unsupported
objects are rejected. CLI output excludes text, URLs, paths and reviewer notes;
errors are fixed codes. There are no writes, network, subprocess or DB operations.
Approved local files must be stable during reading; this trusted-code boundary is
not an OS sandbox or a defense against hostile concurrent filesystem mutation.

## Offline versus live

8W-A validates synthetic artifacts, deterministic scoring, failure modes and
dependency restrictions under the existing regression guard. Automatic work:
schema/references/hashes, source occurrence, dates, counts and formulas. Human
work: semantic support, salience, attribution, origin independence, conflict vs
update, readability and prohibited settled assertions. The latter assertions
are review prompts, not automatically interpreted natural-language rules.

Existing synthetic harness/fixtures remain unchanged. The artifact scorer does
not import the legacy persistence-capable runner, default services or SDK. Pure
scoring imports crypto only. Guarded tests cover the CLI and pure scorer, with
existing network/credential/database/write policy unchanged.

8W-B is a separate activity. The unresolved real-process isolation/lifecycle gate
must first be cleared. Native worker reports deliberately omit statements, so
human live-quality review additionally needs a separately approved safe structured
artifact capture design. Require independent boundary review, frozen approved
model/snapshot, separate credential-free egress authorization and separate single
authenticated request authorization. No automatic ten-event batch or retry is
authorized. No change to production truth-verification semantics is permitted.
Live connectivity, model/response compatibility, cancellation and DB isolation
remain unverified by this work. No evaluation database is needed for 8W-A.

## Storage, acceptance and limitations

Do not collect or commit real article bodies as part of this step. Real manifests,
references and outputs require explicit storage/redistribution approval; keep
copyrighted full text restricted as required. Public metadata/excerpts also need
review. Never store credentials or private diagnostic payloads in corpus assets.

Offline acceptance requires valid synthetic examples, all required negative tests,
known-count scoring cases, deterministic fingerprints, visible N/A denominators,
no forbidden dependencies and passing guarded regressions. Final real-world
acceptance requires A-G references, frozen human adjudication and complete stage
reporting with exclusions; recommended mandatory checks are zero accepted
unsupported statements and passing required conflict/attribution/abstention cases.
Approve further precision/coverage targets before assessment, not after tuning.
Offline infrastructure completion does not complete empirical quality validation.
Small samples, disputed labels, incomplete sources, conservative extractive rules
and report-time versus occurrence-time differences must accompany any results.
