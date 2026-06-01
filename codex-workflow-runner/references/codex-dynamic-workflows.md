# Claude Dynamic Workflows Reference

This reference records observable behavior from local Claude Code 2.1.158 artifacts and the captured tool contract. It is a clean-room compatibility guide, not a claim about Anthropic internals.

## Public Script Contract

Workflow scripts are plain JavaScript. They begin with:

```js
export const meta = {
  name: 'workflow-name',
  description: 'One-line description',
  phases: [{ title: 'Scan', detail: 'optional detail' }],
}
```

The body runs in an async context and can use:

- `agent(prompt, opts)`
- `pipeline(items, stage1, stage2, ...)`
- `parallel(thunks)`
- `phase(title)`
- `log(message)`
- `workflow(nameOrRef, args)`
- `args`
- `budget`

Observed restrictions: no TypeScript syntax, no Node filesystem APIs, no argless `new Date()`, no `Date.now()`, and no `Math.random()`.

## Agent Semantics

`agent(prompt, opts)` spawns a child agent. Observed options:

```js
{
  label: 'display label',
  phase: 'progress phase title',
  schema: { type: 'object', ... },
  model: 'model override',
  isolation: 'worktree',
  agentType: 'custom agent type'
}
```

Without `schema`, the return value is final text. With `schema`, the child is forced through structured output and the parent receives a validated object.

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

Observed Claude workflow snapshots live under:

```text
~/.claude/projects/<project>/<session>/workflows/wf_<id>.json
```

Useful keys:

```text
runId
taskId
workflowName
summary
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

Observed journals live under:

```text
~/.claude/projects/<project>/<session>/subagents/workflows/<runId>/journal.jsonl
```

Observed events:

```json
{"type":"started","key":"v2:<64 hex>","agentId":"..."}
{"type":"result","key":"v2:<64 hex>","agentId":"...","result":{...}}
```

The `v2:` key is consistent with hashing a normalized `agent()` call identity. A compatible runner should hash at least prompt and normalized options, including schema, label, phase, model, and agent type.
For deterministic resume, include the invocation position or another stable call-order component too; otherwise repeated identical prompts in loops or fan-out stages collapse to one cache entry.

Current Codex runner note: `agentType` is intentionally rejected at runtime until Codex can map it to real child-agent profiles. `isolation: "worktree"` requires the parent git worktree to be clean outside the runner's own output directory, then runs the child in a temporary worktree, captures a patch/status artifact, keeps changed worktrees for integrator review, and removes unchanged worktrees.

## Permission Preview

The Claude Code binary exposes strings indicating a static script preview:

- Detects `agent(...)`, `parallel(...)`, `for`, and `while`.
- Groups calls as sequential, parallel, or loop.
- Extracts prompt previews.
- Estimates agent count.
- Lets the user view workflow summary, view raw script, and edit the script in `$EDITOR`.

The bundled runner implements a lightweight `inspect` command for the same purpose.
Its estimate is static and intentionally conservative: mapped arrays, dynamic verifier fan-out, and data-dependent loops should be confirmed from the executed `workflow.json.agentCount`. The inspector also flags deterministic violations and unsupported `agentType` usage before execution.

## Codex Nesting Caveat

Running this runner from a top-level Codex session can spawn child `codex exec` agents with `--sandbox read-only`. Running it from inside another sandboxed Codex child can fail before model work if the outer sandbox prevents writes to Codex state under `~/.codex` or blocks the app-server/local network path needed by the CLI. In that case:

- Use `--mock-agent` only to validate script mechanics.
- For real delegation, run the workflow from the top-level Codex session, or start the outer child with access that allows Codex state/app-server initialization.
- Do not confuse this infrastructure failure with a workflow-script failure; failed runs still leave `workflow.json`, child stderr files, and `journal.jsonl` with `started` events but no `result` events.

## Compatibility Gaps

The clean-room runner intentionally does not replicate:

- Claude Code terminal UI.
- Anthropic private subagent prompts.
- Custom `agentType` behavior.
- Cloud-hosted workflow execution.
- Automatic merge/apply of worktree-isolated agent patches.
- Exact token accounting.
- Named built-in workflow registry.

It does implement the reusable contract needed for Codex-native experimentation: JS orchestration, child Codex delegation, schema-shaped outputs, snapshot persistence, journal replay, progress records, static inspection, and resume from cached agent calls.
