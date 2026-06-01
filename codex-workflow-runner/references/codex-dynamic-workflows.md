# Codex Dynamic Workflows Reference

This reference documents the workflow script contract, the local snapshot and journal schema, and the static-inspection behavior of this Codex runner. The runner is a Codex-native adaptation of [`earendil-works/pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) (a Pi extension that runs subagents as in-memory sessions), which is itself a clean-room take on Anthropic's dynamic workflows in Claude Code. It is a compatibility and design guide, not a claim about Pi or Anthropic internals.

The defining adjustment for Codex: where the Pi extension spawns in-memory subagent sessions inside one process, this runner delegates each `agent()` to a **native Codex subagent**. By default it drives one long-lived, shared `codex app-server` over newline-delimited JSON-RPC and spawns a subagent thread per call (`initialize` → `thread/start` → `turn/start` → `turn/completed`), giving native `outputSchema` enforcement, real token usage, and per-thread model/effort/developer-instructions/sandbox/MCP. A `codex exec` fallback transport (`--transport exec`, also used automatically when the app-server cannot initialize) preserves the original per-process path. On top of the shared DSL it adds persisted snapshots, an append-only journal, resume, worktree isolation, one-level `workflow()` composition, and a static `inspect` preview.

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

`agent(prompt, opts)` spawns one native Codex subagent thread (app-server transport) or a child `codex exec` process (exec fallback). Supported options:

```js
{
  label: 'display label',        // short label for progress, journals, and errors
  phase: 'progress phase title', // overrides the current phase for this agent
  schema: { type: 'object', ... }, // JSON Schema -> the subagent's native outputSchema
  model: 'model override',       // per-agent model
  effort: 'low',                 // reasoning effort: none|minimal|low|medium|high|xhigh
  instructions: 'persona/role',  // per-agent developer instructions on the subagent thread
  agentType: 'explorer',         // built-in default/worker/explorer, or a .codex/agents/<name>.toml profile
  mcpServers: { fs: { command, args, env } }, // extra MCP servers merged into the subagent (alias: tools)
  isolation: 'worktree',         // run in a temporary git worktree, capture a patch
}
```

Without `schema`, the return value is the subagent's final message text. With `schema`, the turn is started with a native `outputSchema`, so the model is constrained to emit conforming JSON; the runner additionally parses and validates the result (`validateAgainstSchema`: type, `enum`/`const`, `required`, `additionalProperties:false`, nested `properties`/`items`). On a violation it re-asks the same subagent up to `--schema-retries` times (default 1) before failing — restoring (and strengthening) the validation guarantee the Pi extension gets from its TypeBox-backed `structured_output` tool. The runner frames every subagent so its final message is treated as the return value (no human-facing prose; for schema agents, raw JSON only).

`agentType` is now **supported**: built-in `default`/`worker`/`explorer`, or any `.codex/agents/<name>.toml` profile (resolved from the workspace then `CODEX_HOME`). A profile's `developer_instructions`, `model`, `model_reasoning_effort`, `sandbox_mode`, and `mcp_servers` are mapped onto the subagent thread; per-agent `model`/`instructions`/`effort` override the profile, and a profile's `sandbox_mode` is clamped to the run's `--sandbox` ceiling. `mcpServers`/`tools` (and MCP-declaring profiles) require the app-server transport. `isolation: "worktree"` is patch-based (see below), not an automatic merge.

## Parallel Versus Pipeline

`parallel(thunks)` is a barrier. It waits for every thunk and returns `null` for failed thunks.

`pipeline(items, ...stages)` is not a barrier between stages. Each item runs its stage chain independently, so item A can verify while item B is still reviewing. This is the default shape to reduce idle time. Failure isolation matches `parallel()` and the pi/Claude model: a stage that returns `null` **or throws** (including a failed `agent()`) drops just that one item to `null` and skips its remaining stages — it never rejects the whole pipeline.

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
sandbox
transport        (appserver | exec; reflects the actual transport after any fallback)
schemaRetries
childModel
budgetTokens
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

The `v2:` key hashes a normalized `agent()` call identity: prompt, normalized options (schema, label, phase, model, isolation, agentType, instructions, effort, mcpServers/tools), the **resolved agentType profile digest** (developer instructions, model, effort, sandbox, mcp servers — so editing a `.codex/agents/<name>.toml` profile invalidates the cache), workspace, mock flag, and a stable call-path that encodes the invocation position. The call-path component keeps repeated identical prompts in loops or fan-out stages from collapsing to one cache entry, so resume is deterministic. The transport (appserver/exec) is intentionally **not** part of the key — results are transport-agnostic, so an exec run can replay an app-server run's cache and vice versa. Cached results are only replayed when the run is `--sandbox read-only`; mutating runs always re-run.

Current Codex runner note: `agentType` is supported (built-in `default`/`worker`/`explorer` or a `.codex/agents/<name>.toml` profile), and the resolved profile is part of the cache key, so editing a profile re-runs the affected agents on the next `--resume`. `isolation: "worktree"` requires the parent git worktree to be clean outside the runner's own output directory, then runs the child in a temporary worktree, captures a patch/status artifact, keeps changed worktrees for integrator review, and removes unchanged worktrees.

## Static Inspect (Permission Preview)

The `inspect` command is a static preview, analogous to Claude Code's permission preview and a stronger version of what the Pi tool surfaces before running a script. It parses the script with acorn and walks the AST to:

- Count `agent()`, `parallel()`, `pipeline()`, `map()`, and loops.
- Flag `agent()` calls nested inside loops, `map()`, `parallel()`, or `pipeline()` as dynamic fan-out, so `estimatedAgents` is reported as a lower bound.
- Flag determinism violations (`Date.now()`, `Math.random()`, argless `new Date()`) and unsupported `isolation` modes before execution. (`agentType` is counted but no longer warned — it is supported.)

Because it is AST-based rather than regex-based, it correctly counts `agent()` calls hidden inside nested template literals — a case the previous string-scanning inspector missed (it reported `agentCalls: 0` for pipelines whose stage prompts used backtick-nested code fences). The authoritative count is always `workflow.json.agentCount` after a run.

## Codex Nesting Caveat

Running this runner from a top-level Codex session spawns native subagents through one shared `codex app-server`. Running it from inside another sandboxed Codex child can fail before model work if the outer sandbox prevents writes to Codex state under `~/.codex` or blocks the app-server/local network path. When the app-server cannot initialize, the run logs a warning and auto-falls-back to `--transport exec`, which can fail the same way under the same constraints. In that case:

- Use `--mock-agent` only to validate script mechanics.
- For real delegation, run the workflow from the top-level Codex session, or start the outer child with access that allows Codex state/app-server initialization.
- Do not confuse this infrastructure failure with a workflow-script failure; failed runs still leave `workflow.json`, subagent `meta.json`/`stderr` files, and `journal.jsonl` with `started` events but no `result` events.

## Compatibility Gaps

This runner intentionally does not replicate:

- The Pi/Claude Code terminal UI or live `/workflows` progress view (snapshots + journal only).
- Cloud-hosted workflow execution.
- Automatic merge/apply of worktree-isolated agent patches (patches are captured for an integrator).
- A named built-in workflow registry (`workflow()` resolves by script path only).

Gaps that the app-server subagent transport **closes** (previously listed here):

- Pi in-memory subagent sessions → now native Codex subagent threads on one shared `codex app-server` (the per-agent `codex exec` path remains as `--transport exec`).
- Custom `agentType`/subagent-profile behavior → supported via built-ins and `.codex/agents/<name>.toml`.
- MCP/tool bridging to children → subagents inherit the session's MCP servers and accept per-agent `mcpServers`.
- Exact token accounting → real subagent token usage from the app-server (`exec`/mock fall back to char/4).
- Schema enforcement → native `outputSchema` plus post-hoc validation with bounded `--schema-retries`.

It implements the reusable contract needed for Codex-native orchestration: AST-validated JS scripts, native subagent delegation (with an exec fallback), schema-shaped outputs via native `outputSchema`, real token accounting, snapshot persistence, journal replay/resume, progress records, worktree isolation, one-level `workflow()` composition, a lifetime agent cap, and static inspection.
