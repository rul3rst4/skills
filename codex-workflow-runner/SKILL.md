---
name: codex-workflow-runner
description: 'Author and run portable Codex workflow scripts that fan out native subagents with agent() for broad audits, reviews, research sweeps, migrations, and independent verification. Use when the user explicitly asks for codex-workflow-runner, a workflow, fan-out, subagents, or broad partitioned work; skip routine one-context tasks.'
---

# Codex Workflow Runner

You are the parent orchestrator. Your job is to scout, author the workflow, inspect it, run it, distrust weak child output, and synthesize the final answer. Child agents provide bounded evidence, votes, or patches; the parent owns integration, verification, tests, and user-facing conclusions.

Run a real workflow only when the user explicitly asks for this skill, a workflow, fan-out/subagents, or broad partitioned work such as an audit, research sweep, migration, or independent verification pass. For routine one-context tasks, scout or answer inline; when parallelism would help but the user did not opt in, explain the rough scale and ask before spending agent work.

When a workflow is warranted, prefer the portable runner. It executes a deterministic plain-JavaScript workflow script; each `agent()` call becomes a native Codex subagent thread through one shared `codex app-server` when available. If the app-server cannot initialize, the runner logs the fallback and uses per-agent `codex exec`. Check `workflow.json.transport` after the run.

This skill documents the portable CLI runner, not an interactive `Workflow({ script })` tool. Author script files, run `node .../codex_workflow_runner.mjs inspect|run|summarize`, and inspect `workflow.json`; do not assume `/workflows`, `TaskStop`, `resumeFromRunId`, inline `script`, or a named built-in workflow registry exists.

If the parent session exposes its own real thread or multi-agent tools and the work is interactive, you may fan out manually with those tools. Do not invent native APIs. For scripted, repeatable, resumable, CI/headless, or broad work, use the portable runner.

## When To Use

Use a workflow for:

- broad reviews, audits, research sweeps, migrations, or many-file investigations;
- independent perspectives before a high-cost conclusion or edit;
- work that exceeds one context but can be partitioned into clear child tasks;
- repeated loops with a gate such as verified findings, tests, probes, or build results.

Skip a workflow for:

- a one-shot question, direct shell command, or narrow single-file edit;
- work without a credible partition, evidence source, or stop condition;
- mutation that cannot be serialized or made file-disjoint.

Scale the fan-out to the request, not to the maximum. Each `agent()` is a billable headless Codex thread, and a broad sweep can spawn dozens. "Find any bugs" → a few finders and single-vote verify; "thoroughly audit this" → a larger finder pool with a 3–5-vote adversarial pass. For an unusually large or mutating run, state the rough scale up front (agent count, sandbox, what gets written) and confirm before spending model work.

If this skill is loaded inside a workflow child, read-only subagent, CI sandbox without Codex state access, or any other isolated nested session, do not start real nested delegation unless you know the environment supports it. Prefer returning the workflow script and exact commands for the top-level parent. Use `--mock-agent` only to validate mechanics; never treat a mock run as evidence.

## Operating Loop

1. Scout inline first: inspect cwd, `rg --files`, relevant docs, diffs, tests, or failing commands. Do not fan out blind.
2. Design the loop: choose unit of work, truth source, independent work, serialized work, verification gate, failure mode, caps, and mutation boundary.
3. If the run is unusually large or mutating, state the rough scale up front and confirm before model spend.
4. Author `.codex-workflows/authored/<name>.js` unless the user provided a script.
5. Run `inspect` and fix parse, determinism, isolation, or obvious fan-out warnings before spending model work.
6. Run assessment/review/research workflows with `--sandbox read-only`. Use `workspace-write` only for narrow approved implementer agents. Treat `danger-full-access` as exceptional and explicitly user-approved.
7. Read `workflow.json`, not just terminal output. Confirm `status`, inspect failed or cached progress rows, count `null` branch results, and parse structured `result`.
8. Synthesize in the parent. Reject uncited or shallow claims. If code must change, apply accepted fixes yourself or run a second narrow Fix -> Verify workflow, then run tests/checks in the parent.

## Commands

```bash
RUNNER="$HOME/.codex/skills/codex-workflow-runner/codex-workflow-runner/scripts/codex_workflow_runner.mjs"

node "$RUNNER" inspect .codex-workflows/authored/workflow.js --json
node "$RUNNER" run .codex-workflows/authored/workflow.js --workspace "$PWD" --sandbox read-only --json
node "$RUNNER" summarize .codex-workflows/wf_<id> --json
node "$RUNNER" run --resume .codex-workflows/wf_<id> --json
```

`run --json` is only the handoff envelope: it returns the run directory, `workflowJson` path, run id, status, and compact result. Open the returned `workflow.json` before trusting the run; that is where transport, progress rows, cached/failed agents, logs, token counts, and artifacts are recorded.

Optional mechanics check before a real run:

```bash
node "$RUNNER" run .codex-workflows/authored/workflow.js --workspace "$PWD" --sandbox read-only --mock-agent --json
```

Useful flags:

- `--workspace <dir>`: child-agent cwd; default is the current directory or resumed workspace.
- `--out <dir>`: output root; default is `.codex-workflows` in the invocation directory.
- `--run-id <id>` and `--resume <run-dir>`: stable run names and resuming prior runs.
- `--args <json>` / `--args-file <file>`: available inside the workflow as global `args`.
- `--sandbox read-only|workspace-write|danger-full-access`: subagent sandbox ceiling. Prefer `read-only`; use `workspace-write` only for narrow approved fixers; use `danger-full-access` only with explicit user approval and a named reason no safer sandbox fits.
- `--transport appserver|exec`: shared native subagent transport or per-agent fallback.
- `--child-model <model>`, `--schema-retries <n>`, `--max-concurrency <n>`, `--max-agents <n>`, `--budget-tokens <n>`, `--codex-bin <path>`, `--json`.

`template throughput` can generate a starter for throughput investigations, but it is only a convenience template. Most workflows should be authored to the task.

## Authoring Contract

Workflow scripts are plain JavaScript, not TypeScript. The first statement must be a literal `export const meta = {...}` with non-empty `name` and `description`; no functions, spreads, computed keys, calls, or template interpolation inside `meta`.

`meta` also accepts optional fields: `phases` (one `{ title, detail }` entry per `phase()` call — titles are matched **exactly** to your `phase()` calls; a `phase()` with no matching entry simply gets its own progress group), `whenToUse` (shown in workflow lists), and a per-phase `model` override on a phase entry. The runner reads `meta` statically before executing, which is why it must be a pure literal.

Useful workflows should call `agent()` at least once and return compact JSON-serializable data: accepted/rejected/uncertain items, evidence, incomplete coverage, and parent next actions. Do not return raw child transcripts.

The workflow VM is deterministic and weak on purpose. It cannot read files directly, use `require`, timers, `Date.now()`, argless `Date()` / `new Date()`, or `Math.random()`. `new Date(timestamp)` with an explicit argument is allowed. Repo inspection inside the workflow happens through child-agent prompts; parent scouting happens before authoring.

Runtime globals:

- `agent(prompt, opts)`: spawn one subagent. **Without `schema` it returns the child's final text as a string; with `schema` it returns the validated object** — no parsing, the runner enforces the schema and re-asks on violation up to `--schema-retries`. Returns `null` for a branch that is skipped or that throws inside `parallel()`/`pipeline()`. Children share no parent context and are told their final text *is* the return value, so prompt for raw data, not prose. Options are documented under [Agent Options](#agent-options).
- `parallel(thunks)`: barrier over functions, not promises. Use `items.map(x => () => agent(...))`. Returns results in input order and substitutes `null` for thrown branches.
- `pipeline(items, ...stages)`: default multi-stage shape. Each item moves through stages independently; no stage-wide barrier. A returned `null` or thrown stage drops only that item to `null`.
- `phase(title)`: start a progress group; later `agent()` calls join it. Inside `parallel()`/`pipeline()`, prefer per-agent `opts.phase` over a bare `phase()` call — the global phase cursor races under concurrency (see Agent Options). `log(message)`: emit a narrator line to the run log; use it for counts and anything you cap or drop.
- `workflow(ref, args)`: run one child workflow. `ref` is a script path string or `{ scriptPath, cacheKey }`; a string is a path, not a saved workflow name. Nesting is limited to one level. Child workflows share the app-server, budget, and lifetime agent limit; they inherit the run's max-concurrency setting.
- `args`, `cwd` / `process.cwd()`: run args and the workspace path.
- `budget`: `{ total, spent(), remaining() }`. `total` is the `--budget-tokens` value or `null`; `spent()` is tokens used so far; `remaining()` is `max(0, total - spent())`, or `Infinity` when no budget was set. The runner enforces it as a guardrail before launches using estimated or reported token use; app-server can report real usage, while exec/mock paths may rely on estimates. Guard budget-scaled loops on `budget.total` — with no budget, `remaining()` is `Infinity` and the loop never stops. See [Verification And Scaling Patterns](#verification-and-scaling-patterns) for the loop shape.

### Agent Options

Pass these in `agent(prompt, opts)`. Per-call options win over an `agentType` profile.

- `label`: short unique display name (`scan:auth`, `verify:bug-3`). Always set it so progress rows and `null`-branch diagnostics stay readable.
- `phase`: assign this agent to a progress group. **Set it explicitly inside `parallel()`/`pipeline()` thunks** — the global `phase()` cursor races under concurrency, so concurrently started agents can land in the wrong group unless each carries `opts.phase`.
- `schema`: JSON Schema (supported subset — see Schema note) that forces structured output. Use it for any result a later stage consumes.
- `model`: per-call model override. **Default to omitting it** — the child inherits the run's `--child-model`; only set it when you are confident a different tier fits the task.
- `effort`: reasoning effort, one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Built-in profiles set a default (`explorer` → `low`, `worker` → `medium`); an explicit `effort` overrides it. Raise it for hard verification or judging, lower it for cheap breadth scans.
- `agentType`: a built-in profile (`default`, `worker`, `explorer`) or a `.codex/agents/<name>.toml` profile resolved from the workspace then `CODEX_HOME`. The profile supplies developer instructions and may supply `model`/`effort`/`sandbox`/`mcpServers`. `explorer` gives read-only exploration instructions and low effort, but filesystem enforcement still comes from the run sandbox; keep assessment runs on `--sandbox read-only`. A profile `sandbox_mode` is clamped to the run's `--sandbox` ceiling.
- `instructions`: developer instructions for this child; overrides the profile's.
- `isolation: 'worktree'`: run a mutating agent in a temporary git worktree (see Safety And Mutation). Expensive; use only for parallel, file-disjoint mutation.
- `mcpServers` / `tools`: extra MCP servers for this child. **Requires app-server transport** — if a tool-dependent workflow falls back to `exec`, treat those branches as incomplete unless `workflow.json`, logs, and artifacts prove the needed tools were available. Subsequently resolved MCP agents under `exec` fail configuration. Treat tool access like permissions.
- `cacheKey`: stable string that replaces this call's structural call path with `explicit:<key>`. It does not make the whole cache identity equal to that key: prompt, normalized options/schema, workspace path, mock flag, and resolved profile digest still matter. Use it to keep cache hits stable across harmless call-path edits, or to deliberately bust a call.

Schema note: `opts.schema` is passed as native output schema and then validated locally. The local validator supports the subset this runner uses: `type`, `enum`, `const`, `required`, nested `properties`, `additionalProperties:false`, and non-tuple array `items`. Unsupported JSON Schema keywords are not enforced by local validation unless you verify support. Schema success proves shape, not truth; every accepted finding still needs evidence and parent/verifier judgment.

## Design The Loop

Before authoring, answer these six questions:

- Unit of work: file, package, route, test, command, finding, design option, duplicate cluster, dependency tier?
- Truth source: static code, docs/spec, compiler, tests, runtime probes, benchmark numbers, or independent votes?
- Independent work: what can read or classify in parallel without shared state?
- Serialized work: shared files, dependency updates, global build/test, git, architecture decisions, or cross-shard dedupe?
- Gate: all items classified, verified findings empty, build green, probes pass, benchmark improves, max rounds reached?
- Failure mode: low confidence, disputed votes, null branches, blocked dependency, schema failure, compile error, regression?

Default to `pipeline()` for per-item multi-stage work. Treat `parallel()` between stages as a real barrier, and use it only when stage N needs aggregate context from all of stage N-1: cross-result dedupe/merge before expensive work, ranking or judging against the full set, aggregate early exit ("zero findings means skip verification"), or a prompt that compares against "other findings."

A barrier is not justified by flatten/map/filter reshaping, conceptual phase boundaries, or code that merely looks cleaner. If a transform only depends on the current item/result, put it inside a pipeline stage. Smell test:

```js
const a = await parallel(...)
const b = transform(a) // only reshapes each result, no full-set dependency
const c = await parallel(b.map(...))
```

That middle transform usually does not need synchronization; rewrite as `pipeline(items, stageA, perItemTransform, stageB)`. Every fan-out where coverage matters must map `null` back to labels and throw or return an explicit `incomplete` list.

When each item flows through its stages independently — no step needs the whole prior set — use `pipeline()` so item B can reach Verify while item A is still in Scan:

```js
// The pipeline() default: per-file scan -> verify, no barrier between stages.
const reviewed = await pipeline(
  changedFiles, // e.g. ['src/a.ts', 'src/b.ts'] — scouted by the parent first
  (file) => agent(`Review ${file} for correctness. Cite file:line evidence.`, {
    label: `scan:${file}`, phase: 'Scan', agentType: 'explorer', schema: FINDINGS_SCHEMA,
  }),
  (scan, file) => agent(`Refute the weakest finding in ${file}:\n${JSON.stringify(scan.findings)}`, {
    label: `verify:${file}`, phase: 'Verify', agentType: 'explorer', schema: VERDICT_SCHEMA,
  }),
)
```

Each stage receives `(prevResult, originalItem, index)`, so later stages can label work by the original item without threading it through earlier returns. A stage that returns `null` or throws drops only that item to `null`. The full skeleton below uses this pipeline-first shape; the following barrier example is only for whole-set rank/dedupe cases.

## Minimal Workflow Skeleton

Use this shape for ordinary per-item scan -> verify work. The parent scouts `args.files` or writes the target list before the run; the workflow does not read files directly.

```js
export const meta = {
  name: 'pipeline-assessment',
  description: 'Review parent-scouted files and verify findings without stage barriers',
  phases: [
    { title: 'Scan', detail: 'per-target assessment' },
    { title: 'Verify', detail: 'skeptical per-finding checks' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'location', 'evidence', 'confidence'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'isReal', 'checkedLocations', 'reason'],
  properties: {
    id: { type: 'string' },
    isReal: { type: 'boolean' },
    checkedLocations: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
}

const targets = args?.files || ['src/a.ts', 'src/b.ts']

const reviewed = await pipeline(
  targets,
  (file) => agent(`Review ${file} for correctness. Open the file and cite file:line evidence.
Return only findings grounded in files you opened.`, {
    label: `scan:${file}`,
    phase: 'Scan',
    agentType: 'explorer',
    effort: 'medium',
    schema: FINDINGS_SCHEMA,
  }),
  async (scan, file) => {
    if (!scan.findings.length) {
      return { file, accepted: [], rejected: [], incomplete: [] }
    }

    const verdicts = await parallel(scan.findings.map(finding => () =>
      agent(`Try to refute this finding. Open the cited code before deciding.
${JSON.stringify(finding)}`, {
        label: `verify:${finding.id}`,
        phase: 'Verify',
        agentType: 'explorer',
        effort: 'medium',
        schema: VERDICT_SCHEMA,
      })
    ))

    const incomplete = verdicts
      .map((result, index) => result ? null : scan.findings[index].id)
      .filter(Boolean)

    return {
      file,
      accepted: verdicts.filter(Boolean).filter(v => v.isReal),
      rejected: verdicts.filter(Boolean).filter(v => !v.isReal),
      incomplete,
    }
  },
)

const droppedTargets = reviewed
  .map((result, index) => result ? null : targets[index])
  .filter(Boolean)
const complete = reviewed.filter(Boolean)
const incomplete = [
  ...droppedTargets.map(file => `pipeline:${file}`),
  ...complete.flatMap(result => result.incomplete),
]

if (droppedTargets.length) log(`dropped targets: ${droppedTargets.join(', ')}`)

return {
  status: incomplete.length ? 'incomplete' : 'completed',
  accepted: complete.flatMap(result => result.accepted),
  rejected: complete.flatMap(result => result.rejected),
  incomplete,
  parentNextActions: ['Verify accepted findings against the real code before editing.'],
}
```

### Whole-Set Barrier Example

Use a `parallel()` barrier between phases only when the next step needs all prior results together: cross-result dedupe, ranking, judging, aggregate skip, or prompts comparing "other findings." When you cap coverage, `log()` it and return what you did not verify.

```js
const LENSES = [
  { key: 'correctness', prompt: 'Find correctness risks. Cite file:line evidence.' },
  { key: 'tests', prompt: 'Find missing or weak tests. Cite file:line evidence.' },
  { key: 'operability', prompt: 'Find build, runtime, or maintenance risks. Cite evidence.' },
]

phase('Assess')
const assessments = await parallel(LENSES.map(lens => () =>
  agent(`${lens.prompt}
Workspace: ${cwd}
Return only findings grounded in files you opened.`, {
    label: `assess:${lens.key}`,
    phase: 'Assess',
    agentType: 'explorer',
    effort: 'medium',
    schema: FINDINGS_SCHEMA,
  })
))

const failed = assessments
  .map((result, index) => result ? null : LENSES[index].key)
  .filter(Boolean)
if (failed.length) throw new Error(`assessment failed: ${failed.join(', ')}`)

const findings = assessments
  .flatMap(result => result.findings)
  .sort((a, b) => b.confidence - a.confidence)
const toVerify = findings.slice(0, 8)
const unverified = findings.slice(8).map(finding => finding.id)
if (unverified.length) log(`verifying ${toVerify.length}/${findings.length}; unverified: ${unverified.join(', ')}`)

phase('Verify')
const verdicts = await parallel(toVerify.map(finding => () =>
  agent(`Try to refute this finding. Open the cited code before deciding.
${JSON.stringify(finding)}`, {
    label: `verify:${finding.id}`,
    phase: 'Verify',
    agentType: 'explorer',
    effort: 'medium',
    schema: VERDICT_SCHEMA,
  })
))

return {
  accepted: verdicts.filter(Boolean).filter(v => v.isReal),
  rejected: verdicts.filter(Boolean).filter(v => !v.isReal),
  incomplete: verdicts.map((v, i) => v ? null : toVerify[i].id).filter(Boolean),
  unverified,
}
```

## Child Prompts And Schemas

Subagents do not share parent context. Every prompt should include:

- the exact role or lens;
- the user goal and relevant paths/files/commands;
- whether mutation is forbidden or allowed, and which paths are in scope;
- required evidence: `file:line`, commands, functions, logs, or checked locations;
- output fields and confidence/uncertainty rules;
- skeptical defaults for verifiers: refute weak claims, do not infer missing evidence.

Unless a child is an approved fixer, the prompt should say the work is read-only and require citations from opened files or commands. `agentType: 'explorer'` supplies read-only exploration instructions, but custom `instructions` or profiles must restate the boundary, and real enforcement still comes from `--sandbox read-only`.

Use short unique labels like `scan:auth`, `verify:bug-3`, or `fix:parser`. Use `schema` for any result another stage consumes. Keep schemas small and semantic: findings need ids, locations, evidence, confidence, and suggested parent action; verdicts need checked locations, whether the claim survives, and why.

## Verification And Scaling Patterns

Reusable techniques, not templates to force — each is a consequence of the loop you designed.

- **Adversarial refute.** Verify a finding by trying to kill it, not confirm it: the verifier opens the cited code, defaults to "refuted" on uncertainty, and the finding survives only if it cannot be refuted. For high-stakes claims, run N refuters and keep the finding on a majority survival.
- **Perspective-diverse lenses.** Fan out distinct lenses (correctness, tests, operability, security, performance) instead of N identical scanners — diversity catches failure modes redundancy misses.
- **Judge panel.** For design or fix choices: generate N independent options from different angles (e.g. MVP-first, risk-first, perf-first), score them with parallel judges, then implement the winner while grafting the best ideas from the runners-up.
- **Loop-until-dry.** For unknown-size discovery, keep spawning finders until K consecutive rounds surface nothing new. Dedup against a `seen` set, not against accepted items, or rejected findings reappear every round and the loop never converges:

  ```js
  const seen = new Set(); const accepted = []; let dry = 0
  while (dry < 2) {
    const round = (await parallel(FINDERS.map(f => () =>
      agent(f.prompt, { phase: 'Find', agentType: 'explorer', schema: FINDINGS_SCHEMA })))
    ).filter(Boolean).flatMap(r => r.findings)
    const fresh = round.filter(x => !seen.has(x.id))
    if (!fresh.length) { dry++; continue }
    dry = 0; fresh.forEach(x => seen.add(x.id)); accepted.push(...fresh)
  }
  ```

- **Loop-until-budget.** Scale depth to `--budget-tokens`. Guard on `budget.total` so the loop is bounded only when a budget exists:

  ```js
  while (budget.total && budget.remaining() > 50_000) {
    const round = await agent('Find one more high-signal issue. Cite file:line.', { schema: FINDINGS_SCHEMA })
    if (!round?.findings?.length) break
    findings.push(...round.findings)
    log(`${findings.length} findings, ${Math.round(budget.remaining() / 1000)}k tokens left`)
  }
  ```

- **Loop-until-count.** Accumulate to a fixed target when you know how many items you want, and stop early if the source runs dry first:

  ```js
  const findings = []
  while (findings.length < 10) {
    const round = await agent('Find one more distinct issue. Cite file:line.', { schema: FINDINGS_SCHEMA })
    if (!round?.findings?.length) break
    findings.push(...round.findings)
    log(`${findings.length}/10 found`)
  }
  ```

- **Budget-scaled fleet.** Size a one-shot fan-out from the budget instead of looping, falling back to a sane default when no budget is set: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`, then spawn `FLEET` finders in one `parallel()`.
- **Completeness critic.** End a sweep with one agent whose only job is to ask "what was missed — a path not scanned, a claim unverified, a source unread?" Feed its answer into the next round.
- **No silent caps.** When you bound fan-out (`slice`, top-N, sampling, no-retry), `log()` it and return what you dropped so the parent knows coverage is partial.

## Semantics Not To Forget

- A direct awaited `agent()` failure at top level fails the workflow. Inside `parallel()` or `pipeline()`, failed branches become `null`.
- `parallel()` takes thunks. `parallel(items.map(x => agent(...)))` is wrong because it starts promises before the runner can manage them.
- `pipeline()` has no barrier between stages. Item A can be in stage 3 while item B is in stage 1.
- Concurrency is capped at `--max-concurrency` (default `min(16, cpu−2)`); lifetime agent count is capped at `--max-agents` (default 1000). You can hand 100 items to `parallel()`/`pipeline()` and they all complete — only ~cap run at once, the rest queue as slots free.
- `--schema-retries` re-asks schema-violating subagents, then fails that agent. Shape-valid output can still be low quality.
- Token totals are real app-server token usage when reported; otherwise the runner falls back to estimates. Treat `--budget-tokens` as an enforced guardrail, not exact accounting.
- `--mock-agent` validates script mechanics only. Never report a mock run as a real assessment.
- `inspect` is a static smoke check. Its `estimatedAgents` can overcount or undercount data-dependent fan-out. The authoritative count is in `workflow.json.agentCount`.

## Safety And Mutation

Read-only first. For code changes, prefer broad read-only assessment followed by parent edits or a narrow approved Fix -> Verify workflow.

Child agents run headlessly. Encode allowed side effects up front in prompts and CLI flags. Unless the user explicitly requested them, forbid destructive operations such as `git reset --hard`, reverting unrelated files, broad `rm -rf`, commits, pushes, credential changes, or global cleanup.

Use `danger-full-access` only when the user explicitly approved that risk, you can name why `workspace-write` is insufficient, and the task cannot be safely decomposed into read-only assessment plus parent edits.

Only fan out mutation when ownership is file-disjoint and prompts name the allowed paths. One serialized parent or integrator owns shared files, dependency updates, global build/test, and git operations.

`isolation: 'worktree'` runs a mutating agent in a temporary git worktree, requires a clean parent tree outside runner output dirs, and captures `.worktree.patch` / `.worktree.json`. It does not merge. The parent must inspect and apply accepted patches, then verify in the main workspace.

`agentType`, `instructions`, `effort`, `model`, and `mcpServers`/`tools` can specialize children. Profiles cannot escalate beyond the run sandbox ceiling. MCP/tool definitions expand child capability and require app-server transport, so treat them like permissions. If a workflow depends on tools and `workflow.json.transport` is `exec`, mark that coverage incomplete unless artifacts prove the required tool path was available.

## Resume And Cache

`run --resume <run-dir>` reuses prior defaults unless overridden: script path, run id, workspace, args, sandbox, transport, schema retries, child model, budget, and agent-limit state.

Completed read-only agent and child-workflow results replay from the journal cache. Mutating runs can resume the run shape but do not replay cached agent results.

Agent cache identity includes prompt, normalized options, call path or explicit `cacheKey`, workspace path, mock flag, and resolved profile digest. `cacheKey` replaces the structural call path only; it does not override prompt/schema/profile/workspace differences. Child-workflow cache identity includes call path or object `cacheKey`, script path/hash, args, child model, mock flag, and sandbox. Cache keys do not include git SHA or file contents, and transport is intentionally omitted. After repo changes, stale read-only cache hits are possible; change prompts/cache keys, run a fresh workflow id, or avoid `--resume` when evidence must be current.

## After Run And Diagnostics

Open `<run-dir>/workflow.json` and check:

- `status`: `completed` before trusting `result`; `failed` includes `error`.
- `transport`: actual `appserver` or fallback `exec`.
- `workflowProgress`: failed/cached agents, labels, phases, tokens, result previews, worktree paths.
- `agentCount`, `agentLimit`, `totalTokens`, `logs`, and compact `result`.
- `result.incomplete`, `result.unverified`, or equivalent coverage fields before calling a sweep complete.

Artifact map:

- `workflow.json`: status, error, logs, progress, transport, counts, final result.
- `subagents/workflows/<runId>/journal.jsonl`: `started` and `result` events for cache/replay. A `started` without `result` means the agent did not finish.
- App-server agents: `agent-*.meta.json` and `agent-*.final.txt`.
- Exec fallback agents: `agent-*.jsonl`, `agent-*.stderr.txt`, optional `agent-*.schema.json`, and meta.
- Worktree agents: `agent-*.worktree.patch` and `agent-*.worktree.json`.

When things fail:

- Inspect warnings: fix determinism, unsupported isolation, or parse problems before running.
- Workflow failed: open `workflow.json.error`, `logs`, and failed `workflowProgress` rows.
- Completed but suspicious: count null branches, audit citations, and reject claims without evidence.
- Schema failures: simplify or correct the schema, strengthen prompt fields, or raise `--schema-retries` only when the schema is right.
- App-server fallback or nested-sandbox errors: check `workflow.json.transport`, logs, stderr/meta artifacts, and rerun from the top-level Codex session when infrastructure blocked delegation. For MCP/tool-dependent work, treat unexpected `exec` transport as incomplete coverage.

## Pre-Run Checklist

Before spending model work on a real run:

1. **Scouted inline** — read cwd, `rg --files`, diffs, tests, failing commands. Not fanning out blind.
2. **`meta` is a literal** with non-empty `name` and `description`; no calls, spreads, computed keys, or interpolation.
3. **Loop is designed** — unit of work, truth source, gate, and failure mode are explicit (see Design The Loop).
4. **Fan-out is scaled to the ask** — agent count matches the request, not the maximum; unusually large or mutating runs are flagged and confirmed before spending model work.
5. **`pipeline()` by default**; every `parallel()` barrier is justified by a whole-set dependency (dedupe, rank, judge, aggregate skip), not just reshape or conceptual phase separation.
6. **`schema` on every result a later stage consumes**, kept to the supported validator subset.
7. **Coverage is tracked** — `null` branches mapped back to labels; the workflow throws or returns an explicit `incomplete`/`unverified` list.
8. **Sandbox fits the work** — `--sandbox read-only` for assess/review/research; `workspace-write` only for narrow, approved fixers; `danger-full-access` only with explicit user approval.
9. **Determinism honored** — no `Date.now()`, argless `Date()`, `Math.random()`, `require`, timers, or direct file reads in the script.
10. **`inspect` run** (and optionally `--mock-agent`) to catch parse, determinism, or fan-out problems before paying for model work.
11. **Transport-sensitive tools planned** — if any child depends on MCP/tools, the closeout will require actual `appserver` transport.

## Post-Run Checklist

Before reporting results:

1. **Open `workflow.json`** — do not rely on the terse `run --json` envelope.
2. **Status completed** — if `failed`, inspect `error`, `logs`, and failed `workflowProgress` rows.
3. **Transport matches assumptions** — especially `appserver` for MCP/tool-dependent workflows.
4. **Coverage accounted for** — count `null` branches, cached rows, failed rows, `result.incomplete`, and `result.unverified`.
5. **Evidence audited** — reject uncited or shallow child claims; schema-valid output proves shape, not truth.
6. **Parent verified** — apply accepted fixes or conclusions in the parent, then run relevant tests/checks outside the child workflow.

## References

Read references only when needed:

- [references/codex-dynamic-workflows.md](references/codex-dynamic-workflows.md): full script contract, snapshot/journal/cache details, inspect behavior, workflow patterns.
- [references/how-codex-workflow-runner-works.md](references/how-codex-workflow-runner-works.md): architecture, run directory layout, app-server/exec flow, debugging internals.
- [scripts/codex_workflow_runner.mjs](scripts/codex_workflow_runner.mjs): CLI and implementation source of truth.
- [tests/parser.test.mjs](tests/parser.test.mjs): parser, schema, profile, effort, and sandbox expectations.
- [agents/openai.yaml](agents/openai.yaml): UI metadata for skill lists and default prompt.
