---
name: codex-workflow-runner
description: 'Author and run portable Codex workflow scripts that fan out native subagents with agent() for broad audits, reviews, research sweeps, migrations, independent verification, and tasks larger than one context. Use when the user asks to use codex-workflow-runner, run or author a workflow, fan out agents, spawn subagents, or orchestrate work; skip simple inline tasks.'
---

# Codex Workflow Runner

You are the parent orchestrator. Your job is to scout, author the workflow, inspect it, run it, distrust weak child output, and synthesize the final answer. Child agents provide bounded evidence, votes, or patches; the parent owns integration, verification, tests, and user-facing conclusions.

Use the portable runner by default. It executes a deterministic plain-JavaScript workflow script; each `agent()` call becomes a native Codex subagent thread through one shared `codex app-server` when available. If the app-server cannot initialize, the runner logs the fallback and uses per-agent `codex exec`. Check `workflow.json.transport` after the run.

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

If this skill is loaded inside a workflow child or other isolated nested Codex session, do not start a real nested delegation unless you know the environment supports it. Prefer returning the workflow script and commands for the top-level parent. Use `--mock-agent` only to validate mechanics.

## Operating Loop

1. Scout inline first: inspect cwd, `rg --files`, relevant docs, diffs, tests, or failing commands. Do not fan out blind.
2. Design the loop: choose unit of work, truth source, independent work, serialized work, verification gate, failure mode, caps, and mutation boundary.
3. Author `.codex-workflows/authored/<name>.js` unless the user provided a script.
4. Run `inspect` and fix parse, determinism, isolation, or obvious fan-out warnings before spending model work.
5. Run assessment/review/research workflows with `--sandbox read-only`. Use `workspace-write` only for narrow approved implementer agents. Treat `danger-full-access` as exceptional.
6. Read `workflow.json`, not just terminal output. Confirm `status`, inspect failed or cached progress rows, count `null` branch results, and parse structured `result`.
7. Synthesize in the parent. Reject uncited or shallow claims. If code must change, apply accepted fixes yourself or run a second narrow Fix -> Verify workflow, then run tests/checks in the parent.

## Commands

```bash
RUNNER="$HOME/.codex/skills/codex-workflow-runner/codex-workflow-runner/scripts/codex_workflow_runner.mjs"

node "$RUNNER" inspect .codex-workflows/authored/workflow.js --json
node "$RUNNER" run .codex-workflows/authored/workflow.js --workspace "$PWD" --sandbox read-only --json
node "$RUNNER" summarize .codex-workflows/wf_<id> --json
node "$RUNNER" run --resume .codex-workflows/wf_<id> --json
```

Optional mechanics check before a real run:

```bash
node "$RUNNER" run .codex-workflows/authored/workflow.js --workspace "$PWD" --sandbox read-only --mock-agent --json
```

Useful flags:

- `--workspace <dir>`: child-agent cwd; default is the current directory or resumed workspace.
- `--out <dir>`: output root; default is `.codex-workflows` in the invocation directory.
- `--run-id <id>` and `--resume <run-dir>`: stable run names and resuming prior runs.
- `--args <json>` / `--args-file <file>`: available inside the workflow as global `args`.
- `--sandbox read-only|workspace-write|danger-full-access`: subagent sandbox ceiling.
- `--transport appserver|exec`: shared native subagent transport or per-agent fallback.
- `--child-model <model>`, `--schema-retries <n>`, `--max-concurrency <n>`, `--max-agents <n>`, `--budget-tokens <n>`, `--codex-bin <path>`, `--json`.

`template throughput` can generate a starter for throughput investigations, but it is only a convenience template. Most workflows should be authored to the task.

## Authoring Contract

Workflow scripts are plain JavaScript, not TypeScript. The first statement must be a literal `export const meta = {...}` with non-empty `name` and `description`; no functions, spreads, computed keys, calls, or template interpolation inside `meta`.

Useful workflows should call `agent()` at least once and return compact JSON-serializable data: accepted/rejected/uncertain items, evidence, incomplete coverage, and parent next actions. Do not return raw child transcripts.

The workflow VM is deterministic and weak on purpose. It cannot read files directly, use `require`, timers, `Date.now()`, argless `Date()` / `new Date()`, or `Math.random()`. `new Date(timestamp)` with an explicit argument is allowed. Repo inspection inside the workflow happens through child-agent prompts; parent scouting happens before authoring.

Runtime globals:

- `agent(prompt, opts)`: spawn one subagent. Common opts: `label`, `phase`, `schema`, `model`, `effort`, `instructions`, `agentType`, `isolation: 'worktree'`, `mcpServers`/`tools`, `cacheKey`.
- `parallel(thunks)`: barrier over functions, not promises. Use `items.map(x => () => agent(...))`. Returns results in input order and substitutes `null` for thrown branches.
- `pipeline(items, ...stages)`: default multi-stage shape. Each item moves through stages independently; no stage-wide barrier. A returned `null` or thrown stage drops only that item to `null`.
- `phase(title)` and `log(message)`: progress grouping and run logs.
- `workflow(ref, args)`: run one child workflow by script path or `{ scriptPath, cacheKey }`. Nesting is limited to one level.
- `args`, `cwd` / `process.cwd()`: run args and the workspace path.
- `budget`: `{ total, spent(), remaining() }`. `total` is the `--budget-tokens` value or `null`; `spent()` is tokens used so far; `remaining()` is `max(0, total - spent())`, or `Infinity` when no budget was set. It is a hard ceiling: when the next call's estimated tokens will not fit, `agent()` and `workflow()` throw `Workflow budget exhausted`. Guard budget-scaled loops on `budget.total` — with no budget, `remaining()` is `Infinity` and the loop never stops. See [Verification And Scaling Patterns](#verification-and-scaling-patterns) for the loop shape.

Schema note: `opts.schema` is passed as native output schema and then validated locally. The local validator supports the subset this runner uses: `type`, `enum`, `const`, `required`, `properties`, `additionalProperties:false`, and non-tuple `items`. Do not rely on complex JSON Schema keywords unless you verify the runner supports them. Schema success proves shape, not truth.

## Minimal Workflow Skeleton

```js
export const meta = {
  name: 'focused-assessment',
  description: 'Run independent read-only assessors and verify their strongest findings',
  phases: [
    { title: 'Assess', detail: 'independent lenses' },
    { title: 'Verify', detail: 'skeptical checks' },
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

const failedAssessments = assessments
  .map((result, index) => result ? null : LENSES[index].key)
  .filter(Boolean)
if (failedAssessments.length) throw new Error(`assessment failed: ${failedAssessments.join(', ')}`)

// Barrier: we rank across ALL findings and verify only the top slice, so the
// complete assessment set must exist first. This is the justified-barrier case
// from Design The Loop, not the pipeline() default. `unverified` (returned
// below) logs what the slice drops so coverage stays honest.
const findings = assessments.flatMap(result => result.findings)
const toVerify = findings.slice(0, 8)

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

const incomplete = verdicts
  .map((result, index) => result ? null : toVerify[index].id)
  .filter(Boolean)
const accepted = verdicts.filter(Boolean).filter(v => v.isReal)

return {
  status: incomplete.length ? 'incomplete' : 'completed',
  accepted,
  rejected: verdicts.filter(Boolean).filter(v => !v.isReal),
  unverified: findings.slice(8).map(f => f.id),
  incomplete,
  parentNextActions: ['Verify accepted findings against the real code before editing.'],
}
```

## Design The Loop

Before authoring, answer these six questions:

- Unit of work: file, package, route, test, command, finding, design option, duplicate cluster, dependency tier?
- Truth source: static code, docs/spec, compiler, tests, runtime probes, benchmark numbers, or independent votes?
- Independent work: what can read or classify in parallel without shared state?
- Serialized work: shared files, dependency updates, global build/test, git, architecture decisions, or cross-shard dedupe?
- Gate: all items classified, verified findings empty, build green, probes pass, benchmark improves, max rounds reached?
- Failure mode: low confidence, disputed votes, null branches, blocked dependency, schema failure, compile error, regression?

Default to `pipeline()` for per-item multi-stage work. Use a `parallel()` barrier only when the next step needs the whole prior set, such as dedupe, ranking, judging, or "zero findings means skip verification." Every fan-out where coverage matters must map `null` back to labels and throw or return an explicit `incomplete` list.

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

Each stage receives `(prevResult, originalItem, index)`, so later stages can label work by the original item without threading it through earlier returns. A stage that returns `null` or throws drops only that item to `null`. The skeleton above instead uses `parallel()` barriers because it ranks across all findings and verifies only a top slice — the justified-barrier case.

## Child Prompts And Schemas

Subagents do not share parent context. Every prompt should include:

- the exact role or lens;
- the user goal and relevant paths/files/commands;
- whether mutation is forbidden or allowed, and which paths are in scope;
- required evidence: `file:line`, commands, functions, logs, or checked locations;
- output fields and confidence/uncertainty rules;
- skeptical defaults for verifiers: refute weak claims, do not infer missing evidence.

Use short unique labels like `scan:auth`, `verify:bug-3`, or `fix:parser`. Use `schema` for any result another stage consumes. Keep schemas small and semantic: findings need ids, locations, evidence, confidence, and suggested parent action; verdicts need checked locations, whether the claim survives, and why.

## Verification And Scaling Patterns

Reusable techniques, not templates to force — each is a consequence of the loop you designed. Several already appear in the skeleton; reuse those rather than re-deriving them.

- **Adversarial refute.** Verify a finding by trying to kill it, not confirm it: the verifier opens the cited code, defaults to "refuted" on uncertainty, and the finding survives only if it cannot be refuted. For high-stakes claims, run N refuters and keep the finding on a majority survival. (The skeleton's Verify phase is the single-refuter form.)
- **Perspective-diverse lenses.** Fan out distinct lenses (correctness, tests, operability, security, performance) instead of N identical scanners — diversity catches failure modes redundancy misses. (The skeleton's `LENSES` is this.)
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

- **Completeness critic.** End a sweep with one agent whose only job is to ask "what was missed — a path not scanned, a claim unverified, a source unread?" Feed its answer into the next round.
- **No silent caps.** When you bound fan-out (`slice`, top-N, sampling, no-retry), `log()` it and return what you dropped so the parent knows coverage is partial. (The skeleton returns `unverified` for exactly this.)

## Semantics Not To Forget

- A direct awaited `agent()` failure at top level fails the workflow. Inside `parallel()` or `pipeline()`, failed branches become `null`.
- `parallel()` takes thunks. `parallel(items.map(x => agent(...)))` is wrong because it starts promises before the runner can manage them.
- `pipeline()` has no barrier between stages. Item A can be in stage 3 while item B is in stage 1.
- `--schema-retries` re-asks schema-violating subagents, then fails that agent. Shape-valid output can still be low quality.
- Token totals are real app-server token usage when reported; otherwise the runner falls back to estimates. Treat `--budget-tokens` as a guardrail, not exact accounting.
- `--mock-agent` validates script mechanics only. Never report a mock run as a real assessment.
- `inspect` is a static smoke check. Its `estimatedAgents` can overcount or undercount data-dependent fan-out. The authoritative count is in `workflow.json.agentCount`.

## Safety And Mutation

Read-only first. For code changes, prefer broad read-only assessment followed by parent edits or a narrow approved Fix -> Verify workflow.

Child agents run headlessly. Encode allowed side effects up front in prompts and CLI flags. Unless the user explicitly requested them, forbid destructive operations such as `git reset --hard`, reverting unrelated files, broad `rm -rf`, commits, pushes, credential changes, or global cleanup.

Only fan out mutation when ownership is file-disjoint and prompts name the allowed paths. One serialized parent or integrator owns shared files, dependency updates, global build/test, and git operations.

`isolation: 'worktree'` runs a mutating agent in a temporary git worktree, requires a clean parent tree outside runner output dirs, and captures `.worktree.patch` / `.worktree.json`. It does not merge. The parent must inspect and apply accepted patches, then verify in the main workspace.

`agentType`, `instructions`, `effort`, `model`, and `mcpServers`/`tools` can specialize children. Profiles cannot escalate beyond the run sandbox ceiling. MCP/tool definitions expand child capability and require app-server transport, so treat them like permissions.

## Resume And Cache

`run --resume <run-dir>` reuses prior defaults unless overridden: script path, run id, workspace, args, sandbox, transport, schema retries, child model, budget, and agent-limit state.

Completed read-only agent and child-workflow results replay from the journal cache. Mutating runs can resume the run shape but do not replay cached agent results.

Cache identity includes prompt, normalized options, call path or explicit `cacheKey`, workspace path, mock flag, and resolved profile digest. It does not include git SHA or file contents, and transport is intentionally omitted. After repo changes, stale read-only cache hits are possible; change prompts/cache keys, run a fresh workflow id, or avoid `--resume` when evidence must be current.

## After Run And Diagnostics

Open `<run-dir>/workflow.json` and check:

- `status`: `completed` before trusting `result`; `failed` includes `error`.
- `transport`: actual `appserver` or fallback `exec`.
- `workflowProgress`: failed/cached agents, labels, phases, tokens, result previews, worktree paths.
- `agentCount`, `agentLimit`, `totalTokens`, `logs`, and compact `result`.

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
- App-server fallback or nested-sandbox errors: check `workflow.json.transport`, logs, stderr/meta artifacts, and rerun from the top-level Codex session when infrastructure blocked delegation.

## Pre-Flight Checklist

Before spending model work on a real run:

1. **Scouted inline** — read cwd, `rg --files`, diffs, tests, failing commands. Not fanning out blind.
2. **`meta` is a literal** with non-empty `name` and `description`; no calls, spreads, computed keys, or interpolation.
3. **Loop is designed** — unit of work, truth source, gate, and failure mode are explicit (see Design The Loop).
4. **`pipeline()` by default**; every `parallel()` barrier is justified (dedupe, rank, judge, or zero-findings skip).
5. **`schema` on every result a later stage consumes**, kept to the supported validator subset.
6. **Coverage is tracked** — `null` branches mapped back to labels; the workflow throws or returns an explicit `incomplete`/`unverified` list.
7. **Sandbox fits the work** — `--sandbox read-only` for assess/review/research; `workspace-write` only for narrow, approved fixers; mutation file-disjoint with one serialized integrator.
8. **Determinism honored** — no `Date.now()`, argless `Date()`, `Math.random()`, `require`, timers, or direct file reads in the script.
9. **`inspect` run** (and optionally `--mock-agent`) to catch parse, determinism, or fan-out problems before paying for model work.
10. **After the run, read `workflow.json`** — `status`, `transport`, null branches, and the structured `result` — not just terminal output.

## References

Read references only when needed:

- [references/codex-dynamic-workflows.md](references/codex-dynamic-workflows.md): full script contract, snapshot/journal/cache details, inspect behavior, workflow patterns.
- [references/how-codex-workflow-runner-works.md](references/how-codex-workflow-runner-works.md): architecture, run directory layout, app-server/exec flow, debugging internals.
- [scripts/codex_workflow_runner.mjs](scripts/codex_workflow_runner.mjs): CLI and implementation source of truth.
- [tests/parser.test.mjs](tests/parser.test.mjs): parser, schema, profile, effort, and sandbox expectations.
- [agents/openai.yaml](agents/openai.yaml): UI metadata for skill lists and default prompt.
