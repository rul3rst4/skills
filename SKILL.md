---
name: codex-workflow-runner
description: Execute and inspect Codex dynamic workflow scripts. Use when the user asks to run, prototype, reverse-engineer, validate, resume, or build a self-made version of Codex dynamic workflows with phases, agent fan-out, pipeline/parallel orchestration, schema-shaped child outputs, journals, and child Codex delegation.
---

# Codex Workflow Runner

Run Codex dynamic workflow scripts with a bundled clean-room runtime. Use this for deterministic multi-agent orchestration where a parent Codex instance should author or execute JavaScript workflow scripts that call `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, and `workflow()`.

## Orchestrator Mode

When the user says "Use `$codex-workflow-runner` to create/run a workflow", the main Codex instance is the orchestrator. Do not wait for the user to provide `workflow.js` unless they explicitly want to write it themselves.

Default loop:

1. Infer the target workspace/app from the current directory and prompt. Ask only if the app/scope cannot be discovered or if the next step would be risky.
2. Inspect the repo enough to pick lenses, success criteria, risk gates, and verification commands.
3. Author a local `workflow.js` under `.codex-workflows/authored/` using the script contract below. Prefer the `template throughput` command as a starting point for throughput work, then customize it to the repo.
4. Run `inspect` on the authored script and check the phase/agent estimate.
5. Run the workflow with child Codex agents. Use `read-only` for assessment/review workflows and `workspace-write` only for narrow implementation workers the user requested or approved.
6. Inspect `workflow.json` and `journal.jsonl`. Reject malformed, uncited, or unverified child outputs.
7. Synthesize the result in the parent. If the goal requires code changes, implement the accepted changes yourself or author a second narrow fix workflow, then run verification.

Before authoring, derive the loop from the task mechanics. Codex workflows are not a fixed list of phase names; they are control loops that transform uncertainty into verified state changes. Build the loop by answering:

1. What is the unit of work: file, crate, route, command, finding, failing test, dependency tier, design option, or duplicate cluster?
2. What is the source of truth: static code, docs/specs, compiler, tests, runtime probes, benchmark numbers, user acceptance, or cross-agent vote?
3. What can run independently: read-only discovery, file-disjoint edits, command probes, per-item classification, or verifier votes?
4. What must be serialized: shared-tree mutation, global build/test/git, final architecture decisions, cross-shard clustering, or integration?
5. What is the gate: all items classified, no confirmed findings, build green, tests pass, probe commands pass, benchmark improves, no blockers, or max rounds reached?
6. What does failure look like: low confidence, disputed votes, blocked dependency, compile error, panic signature, duplicate cluster rejected, or regression?

Then compose phases from the necessary control primitives:

- Fan out for independent read-only exploration or disjoint edit packets.
- Fan in to dedupe, cluster, judge, rank, or synthesize before spending mutation budget.
- Refute with independent verifiers when false positives are expensive.
- Vote and tiebreak when judgments are subjective or noisy.
- Serialize mutation when agents share files, build products, git state, or a global dependency graph.
- Probe with executable commands when the system itself can reveal the next failure.
- Repeat only around an external gate, with `MAX_ROUNDS`, success predicate, and blocked return shape encoded in the script.

Named shapes are examples of this derivation, not presets:

- `Classify -> Sample Verify -> Synthesize`: unit is many items; truth is taxonomy evidence; gate is acceptable unknown/error rate.
- `Panel -> Judge -> Foundation -> Docs`: unit is design option; truth is architectural constraints; gate is one coherent decision.
- `Assess -> Sequential Implement -> Parallel Verify -> Gate -> Report`: unit is subsystem; truth is code plus build/test; mutation is serialized.
- `Shared Infra -> Parallel Modules -> Integrate`: unit is module; shared contracts come first; one integrator owns final consistency.
- `Ungate/Port -> Multi-Vote Verify -> Fix`: unit is tier/module; truth is source parity plus compiler; repeated until dependencies unblock.
- `Probe -> Dedup Failures -> Fix -> Repeat`: unit is failing command/signature; truth is runtime output; repeated until probes pass.
- `Shard Find -> CrossRef -> Multi-Vote Verify -> Apply -> Compile Gate`: unit is shard then cluster; truth is cross-reference plus votes; one final gate owns build/git.
- `Fix -> Re-verify`: unit is confirmed finding; truth is regression test or source check.

For any repeated loop, set explicit stop rules in the script: `MAX_ROUNDS`, success condition, max agents/candidates, and what to return when still blocked. Keep mutation phases serialized or file-disjoint; keep broad discovery phases parallel or pipelined. If the task shape changes mid-run, synthesize the new evidence and author the next loop rather than forcing the old loop to continue.

For "increase throughput of the app" specifically, start with an assessment workflow unless the bottleneck and intended edit are already concrete. The usual shape is `Assess -> Verify -> Synthesize`, followed by parent integration or a targeted `Fix -> Verify` workflow. For throughput work with reproducible commands, `Probe -> Dedup Failures -> Fix -> Repeat` may be better than a pure assessment loop.

Choose subagent count from scope:

- Narrow known fix: 1 implementer + 1 verifier.
- Small app or focused throughput problem: 2-3 assessors across the most relevant lenses, then verify the top findings.
- Medium app throughput work: 4-6 assessors, usually runtime hot paths, data access, concurrency/I/O, frontend/delivery, observability/tests, plus a domain-specific lens.
- Broad/high-risk audit: 6-10 assessors plus independent verification. Only exceed this when the repo/problem is genuinely large and the user accepts the cost.

Use `pipeline()` when each item can advance independently. Use `parallel()` for true phase barriers such as "run all reviewers, then synthesize." Always include a synthesis agent for broad workflows; do not just paste child outputs together.

`inspect` is a static preview. Treat `estimatedAgents` as a lower bound when `agent()` is inside `LENSES.map(...)`, `parallel(...)`, `pipeline(...)`, or data-dependent verification loops. The authoritative count is `workflow.json.agentCount` after execution.

If a workflow is run from inside another sandboxed Codex child, nested `codex exec` may fail before model work with errors like `attempt to write a readonly database`, `failed to initialize in-process app-server client`, or disabled DNS/network. For real nested delegation, launch the outer Codex child with enough access for Codex state/app-server initialization, or run the workflow from the top-level Codex session. A mock run can still validate script mechanics, but it does not validate delegation.

## Quick Start

Use the bundled runtime directly:

```bash
node /Users/andersonkulitch/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs inspect path/to/workflow.js
node /Users/andersonkulitch/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs run path/to/workflow.js --workspace "$PWD"
```

Create a throughput workflow starter:

```bash
node /Users/andersonkulitch/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs template throughput \
  --target "$PWD" \
  --objective "Increase throughput of the app" \
  --output .codex-workflows/authored/throughput-workflow.js
```

The runner creates `.codex-workflows/<runId>/` by default. Each run contains:

- `workflow.json`: snapshot with `runId`, `taskId`, `workflowName`, `status`, `phases`, `workflowProgress`, totals, logs, and result.
- `workflows/scripts/<name>-<runId>.js`: persisted workflow script.
- `subagents/workflows/<runId>/journal.jsonl`: append-only `started` and `result` events keyed by `v2:<sha256>`.
- `subagents/workflows/<runId>/agent-*.jsonl` and `agent-*.final.txt`: child Codex traces and final outputs.
- Worktree-isolated agents also write `agent-*.worktree.patch` and `agent-*.worktree.json`; changed worktrees are kept for parent/integrator review, while unchanged worktrees are removed automatically.

Resume from an existing run directory:

```bash
node /Users/andersonkulitch/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs run --resume .codex-workflows/wf_abc123def456
```

Completed `agent()` calls with the same prompt and normalized options are returned from the journal cache.

## Workflow Script Contract

Write plain JavaScript, not TypeScript. Begin with a pure literal `meta` block:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files and verify findings',
  phases: [
    { title: 'Review', detail: 'dimension readers' },
    { title: 'Verify', detail: 'skeptical checks' },
  ],
}

phase('Review')
const findings = await pipeline(
  ['bugs', 'tests'],
  dimension => agent(`Review for ${dimension}`, { label: `review:${dimension}`, schema: FINDINGS_SCHEMA }),
  result => parallel(result.findings.map(f => () =>
    agent(`Verify this finding: ${JSON.stringify(f)}`, { phase: 'Verify', schema: VERDICT_SCHEMA })
  ))
)

return findings.flat().filter(Boolean)
```

Runtime globals:

- `agent(prompt, opts)`: spawn a child Codex run. Supports `label`, `phase`, `schema`, `model`, and `isolation`. `schema` is passed to `codex exec --output-schema`.
- `agentType` is not supported by Codex child delegation yet; the runner fails fast if a workflow sets it, so scripts do not silently get generic-agent behavior.
- `isolation: "worktree"` requires the parent git worktree to be clean outside the runner's own output directory, creates a temporary git worktree, runs the child there, captures a patch/status record, keeps changed worktrees for parent/integrator review, and removes unchanged worktrees automatically.
- `parallel(thunks)`: barrier; run thunks concurrently and return `null` for failed thunks.
- `pipeline(items, ...stages)`: default multi-stage shape; each item advances through stages independently, without a phase barrier.
- `phase(title)`: assign later `agent()` calls to a progress phase.
- `log(message)`: append a run log.
- `workflow(ref, args)`: run one child workflow by `{scriptPath}` or direct script path. Nesting is limited to one level.
- `args`: parsed JSON value from `--args` or `--args-file`.
- `budget`: exposes `total`, `spent()`, and `remaining()` using approximate token accounting.

The VM blocks `Date.now()`, argless `new Date()`, `Math.random()`, `require`, `process`, and filesystem APIs inside workflow scripts. Pass timestamps through `args`.

## Execution Modes

Use real child Codex delegation for validation:

```bash
node /Users/andersonkulitch/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs run workflow.js \
  --workspace "$PWD" \
  --sandbox read-only \
  --max-concurrency 4 \
  --max-agents 1000
```

Use mock mode only for runtime smoke tests:

```bash
node /Users/andersonkulitch/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs run workflow.js --mock-agent
```

Use `--json` when another tool needs machine-readable output.

## Reverse-Engineered Notes

Read [references/codex-dynamic-workflows.md](references/codex-dynamic-workflows.md) when implementing new features or comparing workflow runner behavior. It records the observed prompt contract, local snapshot schema, journal schema, permission-preview behavior, and known gaps.

## Validation Checklist

Before claiming a workflow run succeeded:

- Inspect `workflow.json` and confirm `status` is `completed`.
- Confirm `workflowProgress` has the expected phase and agent records. It is a flat array; filter records by `type === "workflow_phase"` or `type === "workflow_agent"`.
- Inspect `journal.jsonl`; every non-cached child `agent()` should have a `started` event and a `result` event.
- For schema-shaped agents, parse the returned object from `workflow.json` or `journal.jsonl`, not only the child transcript.
- Treat mock-agent runs as runtime checks only; use real child Codex runs to validate delegation.
