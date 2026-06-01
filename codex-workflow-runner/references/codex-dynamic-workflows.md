# Codex Dynamic Workflows Reference

This reference documents the workflow script contract, the local snapshot and journal schema, and the static-inspection behavior of this Codex runner. The runner is a Codex-native adaptation of [`earendil-works/pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) (a Pi extension that runs subagents as in-memory sessions), which is itself a clean-room take on Anthropic's dynamic workflows in Claude Code. It is a compatibility and design guide, not a claim about Pi or Anthropic internals.

The defining adjustment for Codex: where the Pi extension spawns in-memory subagent sessions inside one process, this runner delegates each `agent()` to a child `codex exec` process (`--output-schema` for structured output, `--sandbox`, `-C`, `--model`, `--json`, `--output-last-message`). On top of the shared DSL it adds persisted snapshots, an append-only journal, resume, worktree isolation, one-level `workflow()` composition, and a static `inspect` preview.

## Public Script Contract

Workflow scripts are plain JavaScript, parsed with a vendored [acorn](../scripts/vendor/acorn.mjs) AST parser. The first statement must be a literal `export const meta = {...}`:

```js
export const meta = {
  name: 'workflow-name',
  description: 'One-line description',
  whenToUse: 'Optional: when this workflow is the right tool',
  phases: [{ title: 'Scan', detail: 'optional detail' }],
}
```

`meta.name` and `meta.description` are required non-empty strings; `whenToUse` and `phases` are optional. The literal is evaluated from the AST, so spreads, computed keys, function calls, and template interpolation are rejected inside `meta`.

The body runs in an async context and can use:

- `agent(prompt, opts)`
- `pipeline(items, stage1, stage2, ...)`
- `parallel(thunks)`
- `phase(title)`
- `log(message)`
- `workflow(nameOrRef, args)`
- `args`
- `cwd` / `process.cwd()` — the workspace directory (`process` is a frozen shim exposing only `cwd()`)
- `budget`

Restrictions: no TypeScript syntax, no Node filesystem APIs, no timers, no argless `new Date()`, no `Date.now()`, and no `Math.random()`. `new Date(timestamp)` with an explicit argument is allowed; pass the current time through `args` when needed.

## Agent Semantics

`agent(prompt, opts)` spawns a child `codex exec` process. Supported options:

```js
{
  label: 'display label',       // short label for progress, journals, and errors
  phase: 'progress phase title',// overrides the current phase for this agent
  schema: { type: 'object', ... }, // JSON Schema -> codex exec --output-schema
  model: 'model override',      // -> codex exec --model
  isolation: 'worktree',        // run in a temporary git worktree, capture a patch
}
```

Without `schema`, the return value is the child's final message text. With `schema`, the child is run with `--output-schema` and the parent receives the object parsed from its final message. Because `--output-schema` only guides the model (it does not hard-enforce the shape), the runner validates the parsed object against the schema (`validateAgainstSchema`: type, `enum`/`const`, `required`, `additionalProperties:false`, nested `properties`/`items`) and fails the agent if it does not conform, rather than propagating wrong-shaped data — restoring the validation guarantee the Pi extension gets from its TypeBox-backed `structured_output` tool. The runner frames every child so its final message is treated as the return value (no human-facing prose; for schema agents, raw JSON only).

`agentType` is part of the upstream DSL but is **not supported** here: the Pi/Claude versions map it to custom subagent profiles, which have no Codex equivalent yet, so the runner fails fast rather than silently running a generic child. `isolation: "worktree"` is patch-based (see below), not an automatic merge.

## Parallel Versus Pipeline

`parallel(thunks)` is a barrier. It waits for every thunk and returns `null` for failed thunks.

`pipeline(items, ...stages)` is not a barrier between stages. Each item runs its stage chain independently, so item A can verify while item B is still reviewing. This is the default shape to reduce idle time.

## Observed Authoring Patterns

Local `wf_*` artifacts show Claude Code creating the workflow script itself from the user's objective, then saving a copy under `workflows/scripts/<name>-<runId>.js`. Reusable patterns:

- Broad audit/review: `Audit/Review -> Verify -> Synthesize`. A first wave of lens specialists returns structured findings; a second wave tries to refute individual findings; a synthesis agent writes the final plan.
- Narrow remediation: `Implement/Fix -> Verify`. One or more bounded implementers are followed by independent verification.
- Architecture/design: panel agents produce competing designs, one judge/architect chooses, then document agents write ADRs, risk registers, or migration plans.
- Long migrations: assessors identify gaps, implementers receive disjoint ownership, verifiers check behavioral parity, and the final agent writes the report.
- Shared-tree migration: read-only assessors run in parallel, but mutating implementation is serialized by subsystem; reviewers and the final gate run after all edits.
- Shared-infra fan-out: one foundation/shared-infra agent writes contracts, module agents write disjoint areas without global builds, and one integrator owns compile/test/fix.

Agent counts scale with scope in the observed runs: 2 agents for narrow fixes, 8-20 for focused remediation or migration completion, and 35-55 for broad audits with per-finding verification. The key design point is not the raw count; it is that each child has a bounded lens and that claims are independently checked before synthesis.

For throughput work, useful initial lenses are runtime hot paths, data access, concurrency/I/O, frontend/delivery, observability/tests, and one repo-specific domain lens. Prefer read-only assessment first, then targeted fixes after the synthesis produces verified candidates and verification commands.

## Bun PR Workflow Patterns

The Bun PR 30412 added many `.claude/workflows/*.workflow.js` scripts. They show several loop families beyond `Assess -> Verify -> Synthesize`:

- `lifetime-classify`: `Classify -> Verify -> Synthesize`, where one agent classifies each file and verification covers all unknown/low-confidence items plus a sampled slice of confident classifications. It uses multi-vote refutation to overturn weak labels.
- `phase-b2-cycle`: tier loop over `Ungate -> Verify -> Fix`. It runs per-crate ungating in parallel, uses two independent verifiers plus tiebreakers for disputed logic bugs, then fixes per crate.
- `phase-c-panic-swarm`: bounded round loop over `Link -> Probe -> Fix`. Each round links the binary, probes many commands, clusters failures by panic location/signature, fixes unique failures in parallel, and repeats until all probes pass or `MAX_ROUNDS` is hit.
- `phase-h-dedup`: sharded discovery loop: `Find -> CrossRef -> Verify -> Dedup -> Compile`. Thirty-ish shard agents find duplicates, one cross-reference agent clusters them, two verifiers vote per cluster, edit agents apply accepted dedups, and a single compile agent owns build/fix/commit.
- Many later phase D/E/F/G scripts use bounded `for (round = 1; round <= MAX_ROUNDS; round++)` repair loops with explicit success returns and blocked/incomplete returns.

## Underlying Rule

Claude-style workflows appear to derive phase shape from control theory more than from named templates:

```text
partition work -> collect evidence -> reduce uncertainty -> mutate only accepted state -> external gate -> repeat or stop
```

Each workflow chooses:

- **Partition key**: files, crates, routes, tests, commands, duplicate clusters, design options, dependency tiers, or findings.
- **Truth source**: source/spec parity, compiler, tests, runtime probes, benchmark output, static citations, human constraints, or independent votes.
- **Concurrency boundary**: read-only work can fan out aggressively; mutation is serialized unless file-disjoint; global build/git is owned by one agent.
- **Reduction step**: cross-reference, cluster, judge, rank, dedupe, synthesize, or vote before applying fixes.
- **Verifier shape**: single skeptic for cheap claims, 2-vote plus tiebreak for noisy code review, 3-vote/sample verification for taxonomies, final gate for builds/tests.
- **Loop condition**: keep going while probes fail, compile errors remain, blocked dependencies shrink, classifications are uncertain, or accepted clusters remain. Stop on success, max rounds, budget, or stable blocker set.

The named loops are reusable consequences of these choices, not a hardcoded menu. When creating a new workflow, first model the task as a state machine: what state exists now, what evidence can advance it, what state transition is safe, and what external signal proves progress. Then express that state machine with `phase()`, `parallel()`, `pipeline()`, explicit schemas, bounded loops, and a final gate.

## Local Snapshot Shape

Each run writes a snapshot under the workspace:

```text
.codex-workflows/<runId>/workflow.json
```

Useful keys:

```text
runId
taskId
workflowName
summary
whenToUse        (only when meta.whenToUse is set)
script
scriptPath
status
startTime
durationMs
phases
workflowProgress
agentCount
agentLimit
totalTokens
totalToolCalls
logs
result
defaultModel
timestamp
```

`workflowProgress` contains:

```text
workflow_phase:
  type, index, title, detail

workflow_agent:
  type, index, label, phaseIndex, phaseTitle, agentId, model,
  state, queuedAt, startedAt, attempt, lastToolName,
  lastToolSummary, promptPreview, resultPreview,
  tokens, toolCalls, durationMs, isolation, worktree
```

## Journal Shape

Each run appends a journal under:

```text
.codex-workflows/<runId>/subagents/workflows/<runId>/journal.jsonl
```

Events:

```json
{"type":"started","key":"v2:<64 hex>","agentId":"..."}
{"type":"result","key":"v2:<64 hex>","agentId":"...","result":{...}}
```

The `v2:` key hashes a normalized `agent()` call identity: prompt, normalized options (schema, label, phase, model, isolation), workspace, mock flag, and a stable call-path that encodes the invocation position. The call-path component keeps repeated identical prompts in loops or fan-out stages from collapsing to one cache entry, so resume is deterministic. Cached results are only replayed when the run is `--sandbox read-only`; mutating runs always re-run.

Current Codex runner note: `agentType` is intentionally rejected at runtime until Codex can map it to real child-agent profiles. `isolation: "worktree"` requires the parent git worktree to be clean outside the runner's own output directory, then runs the child in a temporary worktree, captures a patch/status artifact, keeps changed worktrees for integrator review, and removes unchanged worktrees.

## Static Inspect (Permission Preview)

The `inspect` command is a static preview, analogous to Claude Code's permission preview and a stronger version of what the Pi tool surfaces before running a script. It parses the script with acorn and walks the AST to:

- Count `agent()`, `parallel()`, `pipeline()`, `map()`, and loops.
- Flag `agent()` calls nested inside loops, `map()`, `parallel()`, or `pipeline()` as dynamic fan-out, so `estimatedAgents` is reported as a lower bound.
- Flag determinism violations (`Date.now()`, `Math.random()`, argless `new Date()`) and unsupported `agentType`/`isolation` usage before execution.

Because it is AST-based rather than regex-based, it correctly counts `agent()` calls hidden inside nested template literals — a case the previous string-scanning inspector missed (it reported `agentCalls: 0` for pipelines whose stage prompts used backtick-nested code fences). The authoritative count is always `workflow.json.agentCount` after a run.

## Codex Nesting Caveat

Running this runner from a top-level Codex session can spawn child `codex exec` agents with `--sandbox read-only`. Running it from inside another sandboxed Codex child can fail before model work if the outer sandbox prevents writes to Codex state under `~/.codex` or blocks the app-server/local network path needed by the CLI. In that case:

- Use `--mock-agent` only to validate script mechanics.
- For real delegation, run the workflow from the top-level Codex session, or start the outer child with access that allows Codex state/app-server initialization.
- Do not confuse this infrastructure failure with a workflow-script failure; failed runs still leave `workflow.json`, child stderr files, and `journal.jsonl` with `started` events but no `result` events.

## Compatibility Gaps

This runner intentionally does not replicate:

- The Pi/Claude Code terminal UI or live `/workflows` progress view.
- Pi in-memory subagent sessions (it shells out to `codex exec` per agent instead).
- Custom `agentType`/subagent-profile behavior.
- Cloud-hosted workflow execution.
- Automatic merge/apply of worktree-isolated agent patches (patches are captured for an integrator).
- Exact token accounting (budget uses an approximate char/4 estimate).
- A named built-in workflow registry (`workflow()` resolves by script path only).

It does implement the reusable contract needed for Codex-native orchestration: AST-validated JS scripts, child `codex exec` delegation, schema-shaped outputs via `--output-schema`, snapshot persistence, journal replay/resume, progress records, worktree isolation, one-level `workflow()` composition, a lifetime agent cap, and static inspection.
