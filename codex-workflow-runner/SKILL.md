---
name: codex-workflow-runner
description: Author, run, and orchestrate multi-agent Codex workflows — deterministic JavaScript scripts that fan work out to child Codex agents with phases, pipeline/parallel fan-out, schema-shaped outputs, bounded loops, journals, and parent synthesis. Use when a task needs broad parallel coverage, independent verification before acting, or more scale than one context can hold: audits, reviews, research sweeps, migrations, large refactors, throughput work, or any "spawn N agents and reconcile their findings" task. Triggers on "use $codex-workflow-runner", "run/author a workflow", "fan out agents", or "orchestrate this with subagents".
---

# Codex Workflow Runner

You (the parent Codex session) are the **orchestrator**. A workflow is a plain-JavaScript script you write that fans work out to child `codex exec` agents *deterministically*, collects their structured results, and hands them back to you to synthesize. The bundled runtime gives you the same primitives Claude Code's Workflow tool exposes — `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()`, schemas, budgets, journals — running against real child Codex processes.

Reach for a workflow to be **comprehensive** (decompose a problem and cover it in parallel), to be **confident** (independent perspectives and adversarial checks before you commit to a conclusion or an edit), or to take on **scale one context can't hold** (sweeps, migrations, audits across many files). The script is where you encode that structure: what fans out, what verifies, what synthesizes, and what gates progress.

Do **not** reach for a workflow for a single-file edit, a one-shot question, or work you can finish faster inline. Orchestration has real cost (one child process per `agent()`); spend it only when parallel coverage, independent verification, or scale actually pays for itself.

## The operating loop

When the user says "use `$codex-workflow-runner`" (or asks you to author/run a workflow), **you** drive the whole loop. Author the script proactively — do not wait for the user to hand you `workflow.js` unless they want to write it themselves.

1. **Scope it.** Infer the target repo/app from the cwd and prompt. Ask only if scope is genuinely undiscoverable or the next step is risky/irreversible.
2. **Scout inline first, then fan out (hybrid).** You rarely know the work-list before the task. Discover it cheaply yourself — list the files, find the routes, scope the diff, identify the lenses — *then* author a workflow that pipelines over that list. Don't fan out blind.
3. **Author** a `workflow.js` (default location `.codex-workflows/authored/`) using the contract below. Pick lenses, schemas, verifiers, and a stop condition that match the task's *mechanics*, not a template name.
4. **`inspect`** the script. Confirm it parses, read the phase/agent estimate, and clear any determinism/`agentType`/isolation warnings before spending money.
5. **`run`** it. Use `--sandbox read-only` for any assessment/review/research workflow (it is the default, and the only mode that caches and resumes). Use `--sandbox workspace-write` only for narrow implementer agents the user approved.
6. **Verify the outputs.** Read `workflow.json` and `journal.jsonl`. Confirm `status: completed`. Parse the structured `result` and per-agent records. Reject uncited, malformed, or unverified child output — do not paste it through.
7. **Synthesize in the parent.** Produce the answer yourself from verified evidence. If the goal needs code changes, implement the accepted changes yourself or author a second, narrow `Fix → Verify` workflow, then run the verification commands.

## Running the runner

```bash
RUNNER="$HOME/.codex/skills/codex-workflow-runner/scripts/codex_workflow_runner.mjs"
# If the path differs (project-local install), locate it:
# RUNNER="$(find "$HOME/.codex/skills" "$PWD/.codex" -name codex_workflow_runner.mjs 2>/dev/null | head -1)"

node "$RUNNER" inspect .codex-workflows/authored/workflow.js          # static preview + warnings
node "$RUNNER" run .codex-workflows/authored/workflow.js --workspace "$PWD"
node "$RUNNER" summarize .codex-workflows/wf_<id>                      # quick status/result read
node "$RUNNER" run --resume .codex-workflows/wf_<id>                   # resume from journal cache
```

Key `run` flags: `--workspace <dir>` (child cwd), `--sandbox read-only|workspace-write` (default `read-only`), `--args <json>` / `--args-file <file>` (exposed as global `args`), `--child-model <model>`, `--max-concurrency <n>` (default `min(16, cpu-2)`), `--max-agents <n>` (lifetime cap, default 1000), `--budget-tokens <n>` (sets `budget.total`), `--mock-agent` (mechanics only — no real model), `--json` (machine-readable output). The output root defaults to `.codex-workflows/` in the directory you invoke the runner from.

Optional starter for assessment/throughput work — generate, then customize it to the repo:

```bash
node "$RUNNER" template throughput --target "$PWD" \
  --objective "Increase throughput of the app" \
  --output .codex-workflows/authored/throughput-workflow.js
```

The template is one convenience starting point, not the goal. Authoring from scratch to fit the task is the norm.

## Script contract

Plain JavaScript, not TypeScript. The file must begin with a **pure-literal** `meta` block (no functions, arrows, spreads, template strings, `new`, `Date`, `Math`, `require`, or `import` inside it). Use the same phase titles in `meta.phases` as in your `phase()` calls.

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [
    { title: 'Review', detail: 'dimension readers' },
    { title: 'Verify', detail: 'skeptical refutation' },
  ],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Find correctness bugs in the changed files. Cite file:line.' },
  { key: 'tests', prompt: 'Find missing or weak test coverage in the changed files. Cite file:line.' },
]

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA })
        .catch(() => ({ findings: [] })),              // tolerate one failed lens (see pipeline caveat)
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify this finding. Try to refute it. Return data only.\n${JSON.stringify(f)}`,
          { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))))
)

return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

The workflow's `return` value becomes `workflow.json.result` — that is what you read back and synthesize from.

### Runtime globals (exact Codex semantics)

- **`agent(prompt, opts) → Promise`** — spawns one child `codex exec`. `opts`: `label`, `phase`, `schema` (JSON Schema, enforced via `--output-schema`), `model`, `isolation: 'worktree'`. Without `schema` it returns the child's trimmed final text; with `schema` it returns the parsed/validated object. **A failed child throws** — see the pipeline caveat. `agentType` is **rejected** (fails fast); configure child behavior through the prompt and `model` instead.
- **`parallel(thunks) → Promise<any[]>`** — barrier. Runs all thunks concurrently, awaits them, and returns `null` in place of any thunk that threw. Always `.filter(Boolean)` the result. Use only when you genuinely need all results together.
- **`pipeline(items, ...stages) → Promise<any[]>`** — the default multi-stage shape, **no barrier between stages**. Each item flows through every stage independently (item A can be at stage 3 while item B is at stage 1). Each stage callback receives `(prevResult, originalItem, index)`. A stage that **returns `null`** drops that item (result `null`, remaining stages skipped). **Codex divergence — a stage that *throws* rejects the entire pipeline** (unlike Claude, where it drops just that item). If you need per-item fault tolerance, `.catch()` inside the stage and return `null`, or put the fan-out in a `parallel()` *inside* a stage (which isolates).
- **`phase(title)`** — groups later `agent()` calls under a progress phase. **`log(message)`** — appends a run log.
- **`workflow(ref, args) → Promise`** — runs one child workflow by script path (`'path.js'` or `{ scriptPath: 'path.js' }`). One level of nesting only; **no named registry**. Shares the parent's budget and agent cap.
- **`args`** — the parsed `--args` / `--args-file` value. **`budget`** — `{ total, spent(), remaining() }`, approximate (chars/4 accounting); `total` is `null` unless `--budget-tokens` is set.

### Determinism sandbox

Workflow scripts run in a locked VM. These **throw**: `Date.now()`, argless `new Date()`, `Math.random()`, `require`, `process`, `setTimeout`, `setInterval`. Pass timestamps and seeds through `args`; vary fan-out by `index`. `console.log` is routed to `log()`. This is what makes runs replayable — don't fight it.

## pipeline vs parallel: the decision

**Default to `pipeline()`.** A barrier (`parallel()` between stages) is correct *only* when stage N needs cross-item context from all of stage N-1:

- dedupe/merge across the full result set before expensive downstream work,
- early-exit on the total (e.g. "0 findings → skip verification entirely"),
- a stage that compares against "all the other findings."

A barrier is **not** justified by "I need to flatten/map/filter first" (do that inside a stage: `pipeline(items, a, r => transform([r]).flat(), b)`) or "it reads cleaner." Smell test: if you wrote `const a = await parallel(...); const b = a.flat().map(...); const c = await parallel(b...)`, that middle transform has no cross-item dependency — rewrite it as a pipeline with the transform inside a stage. When in doubt, pipeline.

When a barrier *is* right (dedup before verify):

```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS_SCHEMA })))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT_SCHEMA })))
```

## Quality patterns (compose freely)

Real, runnable shapes. Pick by task; combine them. Every child prompt should follow the child-agent discipline below.

- **Adversarial verify** — N independent skeptics per finding, each told to *refute*; kill unless a majority confirms. Stops plausible-but-wrong findings from surviving.
  ```js
  const votes = await parallel(Array.from({ length: 3 }, (_, i) => () =>
    agent(`Refute this claim if you can; default to refuted=true when uncertain. (reviewer ${i})\n${claim}`,
          { schema: VERDICT_SCHEMA })))
  const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
  ```
- **Perspective-diverse verify** — when a finding can fail in more than one way, give each verifier a distinct lens (`correctness`, `security`, `repro`) instead of N identical skeptics.
- **Judge panel** — generate N independent attempts from different angles, score with parallel judges, synthesize from the winner while grafting the best of the runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds surface nothing new; dedup against *everything seen*, not just confirmed, or it never converges.
- **Loop-until-budget** — scale depth to a token target. Guard on `budget.total` or the loop runs to the agent cap:
  ```js
  const found = []
  while (budget.total && budget.remaining() > 50000) {
    const r = await agent('Find one more high-leverage issue not already listed.', { schema: BUGS_SCHEMA })
    found.push(...r.bugs); log(`${found.length} found, ${Math.round(budget.remaining()/1000)}k left`)
  }
  ```
- **Multi-modal sweep** — parallel finders each searching a *different* way (by file, by symbol, by entity, by time); one angle alone won't find everything.
- **Completeness critic** — a final agent that asks "what's missing — a lens not run, a claim unverified, a file unread?" Its answer becomes the next round.
- **No silent caps** — if you bound coverage (top-N, no-retry, sampling), `log()` what you dropped. Silent truncation reads as "covered everything" when it didn't.

Scale the pattern to the ask: "find any bugs" → a few finders, single-vote verify; "thoroughly audit this" → a larger finder pool, 3–5-vote adversarial pass, explicit synthesis stage.

## Designing the loop for a new task

Workflows are control loops, not a fixed menu of phase names. Before authoring, derive the loop by answering six questions:

1. **Unit of work** — file, crate, route, command, finding, failing test, dependency tier, design option, duplicate cluster?
2. **Truth source** — static code, docs/specs, the compiler, tests, runtime probes, benchmark numbers, or a cross-agent vote?
3. **What runs independently** — read-only discovery, file-disjoint edits, command probes, per-item classification, verifier votes?
4. **What must be serialized** — shared-tree mutation, global build/test/git, the final architecture decision, cross-shard clustering, integration?
5. **The gate** — all items classified, no confirmed findings, build green, probes pass, benchmark improves, or `MAX_ROUNDS` reached?
6. **What failure looks like** — low confidence, disputed votes, blocked dependency, compile error, panic signature, regression?

Then compose phases from primitives: **fan out** for independent read-only exploration or disjoint edits; **fan in** to dedupe/cluster/judge/rank/synthesize before spending mutation budget; **refute** with independent verifiers when false positives are expensive; **vote + tiebreak** when judgments are noisy; **serialize** mutation when agents share files/build/git; **probe** with executable commands when the system can reveal the next failure; **repeat** only around an external gate with an explicit `MAX_ROUNDS`, success predicate, and a defined "still blocked" return shape.

Named shapes are *derivations* of these choices, not presets — e.g. `Classify → Sample-Verify → Synthesize` (many items, taxonomy truth, error-rate gate); `Panel → Judge → Docs` (design options, constraint truth, one decision); `Assess → Serial-Implement → Parallel-Verify → Gate` (subsystems, code+build truth, serialized mutation); `Probe → Dedup → Fix → Repeat` (failing commands, runtime truth, repeat until probes pass); `Shard-Find → CrossRef → Vote → Apply → Compile-Gate` (dedup at scale, one owner of build/git). If the task shape changes mid-run, stop, synthesize what you have, and author the next loop rather than forcing the old one.

Always include a real synthesis step for broad workflows — never just concatenate child outputs.

## Choosing scale

- **Narrow known fix:** 1 implementer + 1 verifier.
- **Focused problem / small app:** 2–3 assessors across the most relevant lenses, then verify the top findings.
- **Medium app:** 4–6 assessors (e.g. runtime hot paths, data access, concurrency/I/O, frontend/delivery, observability/tests, plus one domain lens).
- **Broad/high-risk audit:** 6–10 assessors plus independent verification. Exceed this only when the problem is genuinely large and the user accepts the cost.

## Sandbox and mutation discipline

- **`read-only` is the default and the only mode that caches/resumes.** Use it for all assessment, review, and research workflows.
- Use **`workspace-write`** only for narrow implementer agents the user asked for or approved. Mutating runs never replay the journal cache.
- Keep mutation **serialized or file-disjoint.** Let exactly one agent own global build/test/git. Fan out read-only discovery aggressively; never fan out conflicting edits to a shared tree.
- **`isolation: 'worktree'`** runs a mutating agent in a throwaway git worktree. It requires the parent tree to be clean outside the runner's own output dirs, captures the child's diff as `agent-*.worktree.patch`, keeps changed worktrees for you to inspect/apply, and removes unchanged ones. There is **no automatic merge** — you (or an integrator agent) apply accepted patches.

## Child-agent prompt discipline (Codex's #1 quality lever)

Child Codex agents do **not** automatically know they're inside a workflow. Unlike Claude's harness, they won't infer that their output is data or that a custom agent profile applies. Put it in the prompt, every time:

- **"Your final output is the return value of this step — return data, not a human-facing summary."** Otherwise children write prose where you expect structured data.
- **Bound the lens.** One clear job per agent ("only data-access bottlenecks", "only this file").
- **Demand citations** — file paths, `file:line`, functions, commands, request paths. **Forbid invented metrics or benchmarks.**
- **If a `schema` is set, tell the child to obey it exactly** and to put evidence in the schema fields.
- For verifiers: instruct them to actually open the cited code and default to skeptical (`isReal=false` / `refuted=true`) when evidence is weak.

## After the run: verify before you trust

- Open `workflow.json`; confirm `status` is `completed` (a thrown pipeline stage, exhausted budget, or hit agent cap leaves `status: failed` with an `error`).
- `workflowProgress` is a **flat array** — filter by `type === 'workflow_phase'` and `type === 'workflow_agent'`. Each agent record carries `state`, `label`, `phaseTitle`, `model`, `tokens`, `durationMs`, `resultPreview`, `cachePath`, and (for isolated agents) `worktree`.
- `journal.jsonl` holds `started` + `result` events per non-cached `agent()`. A `started` with no `result` means the child failed before finishing — read `subagents/workflows/<runId>/agent-*.stderr.txt`.
- For schema agents, parse the object from `workflow.json.result` or the journal `result` — **not** from the child transcript.
- `summarize <run-dir>` gives a one-line status/agent/token read; add `--json` for the full structured summary.
- **`--mock-agent` validates script mechanics only** (it synthesizes fake results from schemas). It does not validate delegation, model behavior, or output quality — never report a mock run as a real result.

## inspect is a rough estimate, not a count

`inspect` is a static preview: it counts `agent()`/`parallel()`/`pipeline()`/loops, previews `meta`, and flags determinism violations and unsupported `agentType`/isolation before you spend money. Its `estimatedAgents` is a crude heuristic that can **over- or under-count** data-dependent fan-out (one `agent()` site inside a `pipeline()` over a 50-item array runs 50 times; a small fan-out can be over-counted). The authoritative number is `workflow.json.agentCount` *after* the run. Treat `inspect` as a smoke check and a lint pass, never as the real plan.

## Resume and caching

In `read-only` runs, every `agent()` result is journaled under a `v2:` key derived from prompt + normalized options + call-path + workspace. `run --resume <run-dir>` replays unchanged calls instantly from the journal and only re-runs new or edited ones — same script + same args = full cache hit. Mutating (`workspace-write`) runs intentionally never replay cache. Resume reuses the prior run's `scriptPath`, `runId`, `workspace`, `args`, `sandbox`, and `childModel` unless you override them.

## Nested-Codex caveat

If you launch this runner from *inside* another sandboxed Codex child, the nested `codex exec` calls can fail before any model work with errors like `attempt to write a readonly database`, `failed to initialize in-process app-server client`, or disabled DNS. That is an infrastructure failure, not a workflow-script bug — failed runs still leave `workflow.json`, child `stderr` files, and a journal with `started` but no `result` events. Run workflows from the **top-level Codex session**, or start the outer child with enough access to initialize Codex state and the app-server. `--mock-agent` can still validate mechanics in a constrained sandbox.

## Reference

For the observed Claude/Codex workflow contract, snapshot/journal schemas, and notes for extending the runner itself, see [references/codex-dynamic-workflows.md](references/codex-dynamic-workflows.md). You don't need it to author or run workflows — only when modifying the runtime.
