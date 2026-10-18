# Isolated Summary Evaluation Infrastructure

No external-provider bindings, credentials, database defaults, collection,
migrations or arbitrary URL fetching are installed by this infrastructure.
Native HTTPS is enabled only for explicitly selected local loopback tests.
Existing npm commands and the offline evaluation runner are unchanged.

## Preflight

`node scripts/evaluate-live-summaries.js --preflight-stdin` accepts JSON with
`config` and `approval` objects through stdin. It only validates; it cannot
execute a live evaluation. No configuration file or dotenv is loaded by the CLI.
Reports omit targets, connection strings, provider output, prompts and secrets.

Config fields are exactly `mode`, `target`, `eventIds`, `articles`, `attempts`,
`limits`, `summary`. Mode must be `isolated-live`. Target is exactly
`{host, port, database}`, with a dedicated `evinews_ai_eval_*` database name.
Articles are an approved UUID manifest of `{id, event_id}`, not URLs or raw
download instructions. Attempts are an explicit sequence of approved event IDs;
repeated IDs allow bounded idempotency trials.

Limits must explicitly include positive integers for `maxEvents`, `maxArticles`,
`maxSummaryAttempts`, `maxProviderCalls`; hard ceilings are 12, 100, 24, 24.
Summary settings must explicitly include `model`, `promptVersion`,
`contractVersion`, `timeoutMs`. Current supported versions are phase7-v2 and
phase7-summary-v2; no model or environment fallback exists.

Approval fields are exactly `approved`, `targetAllowlist`, `developmentTarget`,
`productionTargets`, `productionNotConfigured`, `eventIds`, `articleIds`,
`limits`, `summary`. All targets use the same three-field shape. Production
absence must be explicitly acknowledged, not guessed. Protected database names
are rejected regardless of hostname/port, and loopback aliases are normalized.
Approval limits/settings are authoritative. Approvals must come from a separately
reviewed manifest, not be synthesized automatically from the requested config.

## Offline Dispatch Execution

For isolated test doubles only, a trusted caller can invoke exported
`runLiveEvaluation(config, approval, dependencies, AUTHORIZATION)`. The exact
authorization token is `APPROVED_ISOLATED_LIVE_EVALUATION`. Validation and
authorization happen before `dependencies.initialize(plan)` is reachable.
The plan is deeply frozen. There is intentionally no CLI adapter-module option.

Dependencies must supply `initialize(plan)` and exactly one binding: the existing
fake `transport` with `sendOne(request, {signal})` in `offline-test` mode, or
`httpsTransport` settings consumed by the runner's HTTPS dispatcher factory.
HTTPS settings are `{httpsFixture, maxResponseBytes?}` in `offline-test` mode,
or `{loopback: {port, ca}, maxResponseBytes?}` in `loopback-test` mode.
Model, timeout and budget always come from validated approval/configuration, not
the injected HTTPS settings. The runner selects exactly one dispatcher; it does
not wrap an existing dispatcher or create a second counter. Both bindings at
once, missing bindings, unsupported modes and legacy opaque providers fail
before initialization. Injected repositories and fake request functions remain
trusted code, not proof of real database/network isolation.
Initialize must return `contextService`, `summaryRepository`, `close`, without
the obsolete `provider` field. A returned legacy provider is rejected before use;
the runner cannot inspect an initializer's return value before calling it.
The context service supplies `buildContextForEvent`; the repository implements
the interface used by `createSummaryQueryService`. The runner owns the
dispatcher; higher-level services receive `generateText`, never the raw transport.
The transport receives an immutable `{model, contents, config}` descriptor with
only `responseMimeType` in config, plus an abort signal. There is no caller-supplied
URL, header, credential, SDK client, redirect option or endpoint fallback.
`sendOne` returns exactly `{text}`. Attempt counts are created by the dispatcher,
not accepted as proof of how many requests an adapter made.
The runner composes the existing generation, query and
workflow factories, rejects out-of-manifest contexts before provider/persistence,
and passes maxAttempts=1. Every transport invocation reserves one shared budget
unit synchronously immediately before calling `sendOne`, without an intervening
await. Exhaustion prevents the next transport invocation. Concurrent admissions
share the same counter. Failures and timeouts consume budget without refunds.
There is no automatic retry. An explicit repeated generation must cross the gate
again. The gate closes before resource cleanup, aborts pending sends and rejects
late calls before transport. Timeout cancellation bounds dispatcher waiting;
the transport must honor the abort signal to stop its underlying work.
Execution is sequential and stops on errors,
review/insufficient results or budget violations. Close is called on completion
and failures after successful initialization; initialization must clean up its
own resources if it fails partway through.

Adapters must be separately reviewed to use only the approved evaluation target
and bound queries to the event/article manifest, never import application's
default models/config, never fetch article URLs, and never retry provider calls.
Adapters retain credential access privately, outside config/approval/report.
Use a dedicated database user without development/production privileges.
Budget enforcement covers calls through the dispatcher to its controlled transport.
The single-request transport remains trusted: it must send exactly one request,
honor cancellation, never retry, never follow redirects, never use fallback
endpoints and never issue additional authentication requests. Arbitrary injected
JavaScript can bypass this contract by opening its own sockets. This is not an OS
sandbox, and counters cannot observe concealed operations inside malicious code.
HTTPS transport logic now has a native loopback-only binding, but no external
binding or credential source is enabled and no SDK is instantiated here. A later
separately approved external binding would need independent review. SDK-private patches,
global fetch replacement and production client changes are not part of this design.
Offline tests verify fake-send counts, repeated/concurrent admission, exhaustion,
failure/timeout accounting, closure, no retries, sanitization, and numeric boundaries
around approved ceilings 12/100/24/24. In-memory tests do not verify wire requests.
The separate loopback suite verifies local TLS/socket behavior only, not external
connectivity, credentials or SDK behavior.
Database existence, grants, actual isolation, schema and network behavior remain
NOT VERIFIED until separate approval and live checks. Do not use db:migrate,
which targets development. No migrations are performed by this runner.

## Offline HTTPS Transport

`evaluation/singleRequestHttpsTransport.js` exports
`createSingleRequestHttpsDispatcher({executionMode, httpsFixture?, loopback?, model,
maxProviderCalls, timeoutMs, maxResponseBytes?})`. In `offline-test` mode, it
requires an explicitly injected in-memory HTTPS request fixture; native
`node:https` injection and live mode are rejected. In `loopback-test` mode only,
it uses native Node HTTPS pinned to numeric `127.0.0.1`, an explicit port and one
explicit PEM certificate with a matching IP SAN. Host/path/TLS overrides and CA
bundles are rejected. The certificate is passed through per-request `ca`, with
`rejectUnauthorized: true`; no global trust store or TLS setting is changed.
There is no DNS lookup, external binding, implicit fallback or API-key loading.
A dishonest fixture wrapper cannot be identified by identity: fixtures remain trusted.

The factory returns only the existing budgeted dispatcher, not its private
transport. Every private `sendOne` invocation therefore crosses dispatcher
admission. The request uses Node's `https.request` interface with fixed HTTPS
hostname `generativelanguage.googleapis.com`, port 443 in in-memory mode only,
or numeric `127.0.0.1` and the explicit port in loopback mode, POST operation and path
`/v1beta/models/<approved-model>:generateContent`. Model identifiers are bounded
and cannot contain path separators. No URL/host/path overrides or authentication
headers are accepted. TLS verification is not weakened. Only JSON Content-Type
and Content-Length headers are constructed; authentication is deliberately absent.

One admitted send creates one request and calls `end` once. There is no redirect
following, retry loop, fallback endpoint or additional authentication request.
Non-2xx responses, including redirects, are rejected without exposing their
headers, body, location or raw exception. Errors contain fixed categories and,
where available, a bounded numeric HTTP status. Successful bounded JSON responses
are decoded to text; summary schema and grounding validation remain separate.
The parser currently accepts text-only candidate parts; other response shapes
fail closed and need explicit review before any future contract expansion.

Duration is bounded across request and response body, not merely socket inactivity.
Cancellation, timeout and oversized responses destroy pending ClientRequest and
IncomingMessage objects. Default response bound is 262144 bytes; the hard maximum
is 1048576. Encoded request body is capped at 100000 bytes. No credentials, raw
errors, headers, prompts or responses are logged by the transport.

`scripts/test-single-request-https-transport.js` uses in-memory EventEmitter
ClientRequest/IncomingMessage doubles, not a server or sockets. Its independent
fixture request counter verifies one-send, redirect/error/no-retry behavior,
destruction, size limits, sanitization and dispatcher admission. These tests do
not establish external connectivity, real TLS/HTTP behavior, actual socket
termination, authentication, model access or database isolation.

The runner is wired to this factory through `dependencies.httpsTransport` while
the CLI remains preflight-only with no execution option, adapter paths or dotenv.
`scripts/test-loopback-https-evaluation.js` starts HTTPS servers on `127.0.0.1`
with OS-assigned ports and counts actual incoming HTTP requests and TCP sockets.
It checks shared runner budget across attempts, concurrent admission, zero sockets
for rejected calls, redirect/server-error handling without retries, body bounds,
timeout and cancellation socket closure, and rejection of an untrusted server.
Every test closes dispatchers and shuts down servers and tracked sockets, even
on failure. No Gemini/news data or authentication is used; repositories are in memory.

`fixtures/tls/loopback-cert.pem` and `loopback-key.pem` are public test-only TLS
material, not application credentials. The key must never be reused outside
loopback tests. `untrusted-cert.pem` is a distinct test-only trust anchor used
to prove TLS certificate validation remains active. Certificates have ten-year
validity from creation and must be replaced before expiry. Tests read no API key.

Local socket tests do not establish external connectivity, Gemini compatibility,
real-world quality or database isolation. Future external integration still
requires separately approved credential handling, transport review and a verified
dedicated DB target. Do not label this implementation as live-ready.

Runtime reports are operational, not empirical quality scores. The existing
human-label protocol, labels and acceptance criteria are not modified. Capture
approved human-review artifacts separately without secrets. No real run should
begin until corpus, schema readiness, credential isolation, adapters, model,
limits and provider budget have all received explicit approval.

## Non-Persisting Snapshot Workflow (Step 8F)

`evaluation/offlineSummaryWorkflow.js` exports
`createOfflineSummaryWorkflow({config, approval, snapshots, snapshotApproval, transport, httpsTransport, executionMode})`.
This is separate from `runLiveEvaluation`, whose repository-backed test workflow
still exercises persistence against injected test doubles. The new API never
imports summaryWorkflowService, summaryQueryService, summaryContextService,
models, Sequelize, database configuration, migrations or the Gemini client.
There is no repository, initializer, SDK default, credential loader, external
network binding or CLI execution option in this API. Existing trusted in-memory
sendOne fixtures remain compatible; the explicit Step 8I loopback binding below
is the only native HTTPS option. Dependency injection is not an OS/network sandbox.

Config/approval use the existing preflight contract and unchanged ceilings.
Its database target is declaration-only, not connected or used by this workflow;
allowlist validation does not establish database grants or isolation. The
snapshot approval is separately reviewed `{approved: true, fingerprints: [...]}`
with one to 24 distinct SHA-256 fingerprints. No new corpus or labels are created.
Snapshots and all nested objects/arrays must already be frozen, ordinary JSON
data: accessors, sparse arrays, unsupported prototypes, cycles and non-finite
values are rejected. Scope, limits, exact fingerprint, model and v2 versions
are checked before dispatch. Approval must match the supplied snapshots.

Ordinary imports of summaryGenerationService/summaryValidation load
config/summaries.js and dotenv before injection. Instead,
`evaluation/offlineSummaryDependencies.js` compiles private CommonJS module
instances from the existing audited generation, validation, grounding and
contradiction-query sources. It uses a per-instance deny-by-default require:
crypto is the only allowed built-in dependency; summary config is supplied from
explicit validated evaluation settings. Contradiction configuration is an empty
unused binding because only validateId is consumed, never query factories.
No original config module or dotenv is evaluated. Default generation wrappers
are not exposed. Unexpected imports fail closed. No production file, global
require hook or global module cache is changed by this loader.

This is scoped dependency loading for trusted audited source, not a JavaScript
sandbox: future source changes using direct global side effects require review.
Tests install throwing import/file/environment sentinels and simulate a newly
introduced forbidden dependency. No real API key is needed or read.

Generation receives the prepared snapshot and one existing budgeted dispatcher.
The original JSON/schema, attribution, provenance, grounding, conflict omission
and warning behavior remains in use. `persistenceReady` is discarded, never
returned or executed. Accepted means those deterministic generation gates passed;
verification remains needs_review and factual_truth_verified remains false.
Parsed output/findings are evaluation-owned inspection artifacts, not API logs;
failed JSON/provider errors expose only fixed allowlisted error codes, never raw
provider text or exception messages. Grounding failures are not accepted results.

Results (including failures), fingerprints and concurrent in-flight work are
cached only in memory by approved fingerprint. Repeated calls return detached
copies of the same outcome without another send; a new workflow starts a new
isolated cache/budget. Summary attempts are bounded independently of provider
dispatches. Closing rejects future work, cancels outstanding dispatches and
prevents late output from being accepted. No retry/refund behavior is added.

Verification: `node --test scripts/test-offline-summary-workflow.js`, plus the
existing dispatch/transport, multi-event, summary validation and grounding tests.
These offline results establish neither external connectivity nor real provider
compatibility, database isolation or live readiness. The new path has not been
wired into any external or production workflow; such integration needs separate
approval and must not reuse the older persistence-capable runner implicitly.

## Non-Persisting Loopback Integration (Step 8I)

Supply exactly one binding: existing `transport` (mode omitted or `offline-test`),
or `httpsTransport: {loopback: {port, ca}, maxResponseBytes?}` with the explicit
`executionMode: 'loopback-test'`. Missing/ambiguous bindings, other modes, unknown
fields and model/timeout/budget overrides are rejected. HTTPS configuration is
restricted to the existing transport's numeric 127.0.0.1 endpoint and single
IP-valid test certificate; TLS verification is enabled with that per-request CA.
No authentication, arbitrary host, redirect, fallback or external execution is added.

Snapshot immutability, approved fingerprints, configuration and budget preflight
complete before dispatcher construction. The HTTPS module loads only in the
explicit loopback branch, after snapshot preflight. Its factory validates the
certificate/port/response bound before creating the sole dispatcher. Generation
uses that dispatcher directly, not another wrapper or budget. Model, timeout and
budget derive solely from the validated plan. Synchronous reservation precedes
each private transport invocation, including failures/timeouts; there are no
retries or refunds. Closure aborts the same dispatcher and active requests.

`node --test scripts/test-offline-summary-loopback.js` exercises the actual
non-persisting workflow over local HTTPS sockets with synthetic frozen snapshots
and the checked-in public test-only certificate/key. It checks grounding/warnings,
duplicate/concurrent evaluation, budget exhaustion, closed/invalid admission,
timeouts, cancellation, socket cleanup, response limits, malformed/unsupported
output, missing provenance, redirects, server errors and wrong-certificate failure.
Throwing dependency/file/environment sentinels cover the loopback path as well.
Server listeners and sockets are cleaned up after success and failure.

The legacy runner and preflight-only CLI are unchanged and unused by this path.
Loopback success proves neither external connectivity, Gemini compatibility,
database isolation nor live readiness. The certificate/key are test material,
not project API credentials. No external provider execution is enabled.

## Authenticated In-Memory Preparation (Step 8K)

The additional explicit workflow mode `authenticated-fixture-test` accepts only
`httpsTransport: {httpsFixture, credentialChannel}`. This does not enable external
execution: the fixture must not be native `node:https` or its request function.
Injected fixtures/channels are trusted code, not an OS sandbox. They must never
delegate to live transports. No native authenticated branch or launcher exists;
the existing CLI remains preflight-only and unchanged.

This profile requires exactly one approved event, snapshot, fingerprint and
planned attempt, with maxEvents/maxSummaryAttempts/maxProviderCalls all one.
Config/approval/snapshot model identifiers must match explicitly. Timeout is
20000 ms; response bound is 262144 bytes, prompt bound 80000 bytes and encoded
request bound 100000 bytes. Versions remain phase7-v2/phase7-summary-v2. No
profile overrides, endpoint/header overrides, redirects, retries or SDK are added.

Only after snapshot preflight and dispatcher admission does the transport call
`receiveEvaluationSecret(channel, signal)`. The injected parent channel receives
`{protocol: 'evinews-evaluation-secret-v1', type: 'PREFLIGHT_PASSED'}` and replies
once with exactly `{protocol: 'evinews-evaluation-secret-v1', secret}`. The reply
must be an ordinary own-data object with enumerable fields and a 1..512 character
non-whitespace printable-ASCII secret. Accessors, extra fields, invalid messages,
closed channels and five-second delivery timeout fail closed. All listeners detach
on completion or cancellation; the same channel cannot be consumed twice.
The total dispatch timeout includes credential delivery. No process IPC/default
channel, environment secret reader, dotenv or production configuration is loaded.

The secret is private request-construction data, used only for x-goog-api-key,
never a URL, fingerprint, approval field or report value. Reflected secrets in
response text are rejected. JavaScript strings and request headers cannot be
guaranteed erased from memory; parent, fixture, runtime and debugger must be trusted.

The factory still returns one controlled dispatcher, now with a detached frozen
`diagnostic` getter. The non-persisting workflow copies it into failed evaluation
results where available. Categories are NETWORK, TIMEOUT, CANCELLED, HTTP,
RESPONSE_LIMIT and RESPONSE_PARSE, with optional 100..599 numeric status and an
explicitly allowlisted network code. No arbitrary code/message/body/header/stack,
cause, URL or credentials are exposed. Credential protocol failures have fixed
codes at the receiver boundary, and are sanitized generically by the workflow.
The existing strict text-part parser remains fail-closed for unknown part fields.

Offline verification adds `node --test scripts/test-evaluation-credential-channel.js`
and extends the workflow/HTTPS fixture suites. Dummy secrets only are delivered;
fake timers cover five-second delivery and twenty-second request expiry. Existing
loopback tests cover actual local sockets without authentication. Import/file/env
sentinels cover both workflow bindings. No database, persistence or SDK is needed.

Before a future external test, separately approve and independently review native
binding activation, a real parent IPC launcher, the exact model and transmitted
snapshot, and credential-free authorized egress verification. External cancellation,
model access and actual Gemini response compatibility remain unverified. Loopback
and in-memory results do not establish live readiness or database isolation.

## Guarded Regression Launcher (Step 8M)

Use `node scripts/run-guarded-regressions.js --all` instead of directly running the
legacy suite. `--self-test` runs only guard tests; `--suite <name>` accepts exactly
legacy, credentials, transport, workflow, multi-event, validation, grounding or
loopback. No package script, original assertion, label or production code changes.

The launcher starts each reviewed entry directly in a fresh Node process with
an absolute --require preload, repository cwd and no shell. Children receive only
NODE_ENV=test, TZ=UTC, NO_COLOR=1, the non-secret policy selector and, on Windows,
SystemRoot. No environment spreading, PATH, NODE_OPTIONS, credentials or proxies
are inherited. The launcher's already-started Node runtime and the OS/parent are
trusted; it cannot undo arbitrary preloads that ran before the launcher started.

Before application imports, the preload supplies deeply frozen synthetic summary,
claim, contradiction and embedding config with unchanged default thresholds.
Original config files are not executed. The application-visible environment is
synthetic; credential-name access and mutations fail. Explicit source/asset
allowlists check canonical paths. dotenv, provider SDKs, models, database drivers,
database configuration, unreviewed modules and production jobs cannot initialize
through the guarded loader. Actual environment-file reads and filesystem writes
are denied, including promise/stream variants; stdout/stderr remain writable.
The legacy workflow/query factories still operate against their original test
repositories, which write only in-memory arrays. They are not replaced by stubs.

Ordinary suites cannot perform network operations. The separate loopback policy
permits only ephemeral listeners on numeric 127.0.0.1 and connections to those
registered ports; ports are removed on closure. The HTTPS wrapper requires TLS
verification and one of the explicit test CA certificates, and rejects provider
authentication headers. Node's numeric-address dns.lookup path is answered locally
without invoking any resolver; other DNS requests remain blocked. Existing socket
tests still verify rejection of the wrong CA, abort cleanup and request budgets.

Nested spawnSync is limited to the reviewed evaluation CLIs and exact argument
sets. Each child gets the same preload and a freshly constructed environment.
Other process APIs and caller-supplied environments/stdio/cwd/shell are rejected.
An additional pair of self-test-only nested commands proves propagation of a
caught child violation and a missing child report; it is unavailable to suites.

Each process writes a bounded, non-secret guard ledger to its dedicated fd 3,
separate from TAP/CLI JSON/stderr. The launcher rejects missing/malformed ledgers,
timeouts, signals, test failures and any positive violation count. A caught guard
exception still forces failure, independently of process.exitCode or an expected
CLI rejection. Self-tests intentionally launch failing probes and assert that
they are rejected; these are not exemptions in ordinary suites. Child counts
refer to commands admitted through the wrapper, not OS-wide activity telemetry.

The independent --self-test probes cover environment/config, forbidden imports,
environment files, DNS/network, writes, process escapes, nested violation/report
propagation, malformed reports and loopback restrictions. Run node --check for
the three new JavaScript files and git diff --check as well.

These controls cover trusted reviewed CommonJS test paths, not adversarial
JavaScript or an OS sandbox. Tests legitimately replace some module/file/env
hooks; their reviewed wrappers preserve the outer guards but malicious replacement,
native bindings, custom loaders or new runtime APIs require renewed review.
Blocked attempts are recorded, not performed. No historical inference follows:
a clean guarded run cannot prove whether an earlier unguarded run read .env,
held credentials or changed a database. No live readiness or external connectivity
is established, and no real credential loader or authenticated network is enabled.

## Targeted Boundary Corrections (Step 8O)

All child launches now use a single private policy/admission/native-spawn path,
including calls to the exported runGuarded helper. The helper no longer confers
supervisor privileges: roles are captured at bootstrap, before test imports.
Only the dedicated supervisor can select suites and loopback policy. Ordinary
suites can launch only their reviewed offline CLI children; child APIs cannot
override environment, preload, cwd, shell or policy. The scoped self-test role
may launch registered negative probes, but ordinary suites cannot use that role
or obtain an ignore-failure/expected-exit exemption. Probe roles have only their
explicit nested probe commands, not the self-test's privileges.

The v2 guard report includes role, attempts, admitted children and bounded launch
records (at most 64). Attempts are recorded before validation, including denied
calls. Beyond 64, attempts still increment and GUARD_CHILD_LIMIT permanently
fails verification without spawning. Records contain only reviewed command/probe
identifiers, admission, exit status, outcome, report validity and child violation
count, never arguments or stdin. Parent failure is sticky before any result is
returned; ignoring an exported helper's failed result cannot hide child failure.
Reports reject inconsistent accounting and pending launch records.

Negative CLI exits remain valid only for reviewed commands returning their fixed
structured rejection/failed-fixture contract with a clean guard ledger. Crashes,
timeouts, signals, missing/invalid reports, guard violations and unexplained
nonzero exits fail the parent. Intentional negative probes are explicitly recorded
as EXPECTED_PROBE only in the self-test role and must match the internal registry;
they are not ordinary child failures silently ignored by the harness.

Authenticated response checking now validates two actual JSON layers: the Gemini
envelope and combined content text representing summary JSON. A private bounded
syntax-aware scanner rejects duplicate decoded keys, malformed JSON, more than
40 nesting levels or more than 10000 values/keys per layer before JSON.parse.
Decoded strings and object keys are inspected for the private dummy credential,
in addition to the existing literal check. Escaped quotes/backslashes, Unicode
escapes, mixed escapes and split content cannot bypass the check. No arbitrary
third decoding layer is invented. Reflections are rejected as RESPONSE_PARSE
before text leaves the transport, even if the statement would later fail grounding.
Non-authenticated transports do not acquire an inner-summary JSON requirement.

Permanent tests cover helper/spawn policy parity, denied role escalation, ignored
child failures (including clean-ledger nonzero exits), missing reports, termination,
timeout, ledger exhaustion and consistency. Dummy-only reflection tests cover both
JSON layers, decoded keys, split text, malformed/duplicate JSON and traversal
bounds, including valid boundary values and non-secret escaped text. Workflow
tests require failed reflected output to contain no structured output or credential.

Verification uses the guarded --self-test, --suite transport, --suite workflow
and --all commands plus syntax/diff checks. External connectivity, actual Gemini
compatibility and external cancellation remain unverified. No native external
binding, production change, database access or OS-level sandbox guarantee is added.

## Native Execution Boundary (Step 8R, offline verification only)

This section supersedes the earlier absence of a native binding. The native
binding is implemented but has not been executed against Google. The existing
evaluate-live-summaries.js CLI remains preflight-only and unchanged. No default
mode, package script, environment fallback or background job starts native work.

The separate evaluate-native-summary.js entry point requires the explicit
--authorize-one-gemini-request flag, --manifest with a separately reviewed
non-secret JSON manifest, and an interactive local raw-mode-capable TTY. Do not
run it until Step 8S review and separate authorization. A manifest contains only
config, approval, snapshots, snapshotApproval and nativeApproval. Existing
evaluation target declarations are still required and validated, but are inert:
no database is used, tested or initialized by this path. Existence, privileges
and isolation of a dedicated evaluation database remain unverified.

nativeApproval has exactly approved=true, action=gemini-generateContent-once,
model, fingerprint, promptVersion=phase7-v2 and contractVersion=phase7-summary-v2.
Its model and fingerprint must match the independently validated snapshot and
existing configuration/approval. Exactly one event, snapshot, planned attempt,
summary-attempt limit and provider-budget unit are required. No manifest may
carry a credential. A reviewed manifest is input data, not proof of operator or
OS-level authority. Actual approval remains a human/process responsibility.

Parent preflight uses the non-persisting workflow without evaluating it. It
launches one absolute-path nativeSummaryWorker.js, with execArgv=[], hidden
window, ignored stdout/stderr/stdin, JSON IPC, and a fresh environment containing
only NODE_ENV=test, TZ=UTC, NO_COLOR=1 and Windows SystemRoot where needed. No
NODE_OPTIONS, proxy, credential or inherited application configuration is copied.
The worker independently copies ordinary JSON data, rejects accessors, hidden
fields, custom/sparse arrays, cycles and unsupported types, deeply freezes the
copy, and repeats the fingerprint/model/version/profile checks.

The protocol is INIT -> PREFLIGHT_READY -> hidden TTY input -> EXECUTE ->
PREFLIGHT_PASSED -> one existing evinews-evaluation-secret-v1 credential message
-> RESULT -> clean worker exit. EXECUTE is non-secret. Duplicate, unexpected or
out-of-order messages fail closed. The credential receiver and dispatcher are
unchanged; no second dispatcher, alternate provider route or second worker is
created. Credential entry has a separate 120-second deadline; the receiver's
five-second delivery timer starts only after EXECUTE. Worker startup is bounded
to ten seconds. Human input has no echo or masking; backspace is supported.
Raw mode and the prior paused state are restored on completion and cooperative
cancellation/failure. Mutable input/chunk buffers are zeroed where practical.
SIGKILL, process crashes or power loss cannot guarantee terminal restoration.

The parent uses a 25-second watchdog after EXECUTE; cancellation closes the
workflow, aborts the receiver and destroys admitted request/response resources.
The parent sends cooperative CANCEL, allows at most one additional second, then
terminates a remaining worker. Parent/child disconnect, SIGINT/SIGTERM, input
cancellation, protocol failure and premature exit never retry. A result must be
followed by a clean worker exit. An unexpected worker loss after EXECUTE reports
dispatches=null (unknown), never an invented zero or a retry recommendation.

authenticated-native-evaluation binds Node HTTPS directly to the fixed
generativelanguage.googleapis.com:443 endpoint and POST
/v1beta/models/{approvedModel}:generateContent. No caller transport override,
headers, CA override, URL, port, proxy, redirect, retry, SDK or fallback is
accepted in that mode. TLS certificate and hostname validation remain enabled.
The private x-goog-api-key comes only from the existing one-shot receiver after
preflight. The sole existing dispatcher reserves synchronously before receiver
or transport invocation. Failures consume the reservation; pre-network failures
can legitimately produce zero HTTP requests. Maximum HTTP requests per run: one.

Limits are unchanged: total dispatch deadline 20000ms including delivery;
response 262144 bytes; prompt 80000 bytes; encoded body 100000 bytes. Existing
strict JSON/part validation, both decoded credential-reflection checks,
duplicate-key rejection and depth-40/value-10000 bounds remain active, followed
by unchanged validation, attribution, provenance, grounding and warning gates.
Generated text stays worker-local and in memory. Only status, approved model and
fingerprint, dispatch count, bounded diagnostic categories/codes/status and
validation/grounding indicators cross back. No prompt, generated statements,
raw response, secret, stack, headers or child output is forwarded. Accepted
means provenance/grounding acceptance, not factual truth: factual_truth_verified
is always false. No persistence payload is exposed or invoked.

probe-gemini-egress.js is independently gated by
--authorize-credential-free-probe. It has no credential handling or HTTP path.
When separately authorized it resolves only the fixed hostname, selects the
numerically first IPv4 answer, opens one TCP connection, and upgrades that same
socket with the original hostname as SNI and normal certificate verification.
One ten-second overall deadline, no next-address retry, bounded DNS/TCP/TLS
booleans and allowlisted codes only. It destroys both socket handles. It is not
called by the native launcher. Step 8R exercises only injected fake sockets.

Guarded --suite native registers only offline tests and source reads. It does
not permit spawning the native CLI, worker or probe, or native network access.
Tests replace HTTPS with in-memory doubles and use fake TTY/child/IPC channels;
existing loopback tests alone retain their separately restricted local sockets.
These trusted-code guards are not an OS sandbox. Untrusted injected code,
debuggers and process-memory readers are out of scope. JavaScript strings,
IPC serialization and HTTP internals prevent guaranteed secret erasure.

Next: Step 8S independent review, then separately authorized dummy real-process
IPC/TTY lifecycle verification, credential-free egress probe and (only after
explicit model/snapshot approval) one authenticated test. Current external
connectivity, actual Gemini response/model compatibility, real IPC/TTY behavior,
external cancellation and live readiness are NOT VERIFIED. The Step 8R task
authorizes none of those live operations.

# Offline quality protocol (Step 8W-A)

See [REAL_WORLD_QUALITY_EVALUATION.md](REAL_WORLD_QUALITY_EVALUATION.md) for
artifact-only reference scoring. This does not clear the real-process or live
execution gate, and evidence grounding never establishes factual truth.
