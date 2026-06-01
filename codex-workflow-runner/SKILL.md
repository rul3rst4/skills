---
name: codex-workflow-runner
description: Author, run, and orchestrate multi-agent Codex workflows — either via native Codex thread orchestration (preferred inside Codex Desktop when thread tools are available) or the bundled portable JavaScript runner that fans work out to child `codex exec` agents with phases, pipeline/parallel fan-out, schema-validated outputs, journals, resume, and parent synthesis. Use for tasks that need broad parallel coverage, independent verification before acting, or more scale than one context can hold: audits, reviews, research sweeps, migrations, large refactors, or throughput work. Triggers on "use $codex-workflow-runner", "run/author a workflow", "fan out agents", or "orchestrate this with subagents".
---

# Codex Workflow Runner

You (the parent Codex session) are the **orchestrator**. A workflow fans work out to child agents *deterministically*, collects their structured results, and hands them back to you to synthesize. There are two execution paths:

- **Native Codex thread orchestration** — when the current Codex session exposes thread/multi-agent tools, fan out with those. This is the most Codex-native path.
- **The portable runner** — a bundled Node runtime that executes a plain-JavaScript workflow script, delegating each `agent()` to a child `codex exec` process. Use it from terminals/CI, outside Desktop, or whenever the user wants a runnable, resumable `workflow.js`.

The portable runtime is a Codex-native adaptation of [`earendil-works/pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) (a Pi extension), itself inspired by Anthropic's dynamic workflows in Claude Code. It keeps the same deterministic, AST-validated script contract — `export const meta = {...}` followed by plain JS calling `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()` — and adds journals, resume, snapshots, worktree isolation, and a static `inspect` preview.

Reach for a workflow to be **comprehensive** (decompose a problem and cover it in parallel), to be **confident** (independent perspectives and adversarial checks before you commit to a conclusion or an edit), or to take on **scale one context can't hold** (sweeps, migrations, audits across many files). Do **not** orchestrate a single-file edit, a one-shot question, or work you can finish faster inline — fan-out has real cost (one child process per `agent()` in portable mode).

## Mode selection

Choose the path before authoring:

- **Codex Native Mode** — use inside Codex Desktop when thread orchestration tools are available. Best for research, review, planning, and fan-out/fan-in where native app context matters.
- **Portable CLI Mode** — use the bundled Node runner for deterministic `workflow.js` scripts. Works in terminals, CI, non-Desktop installs, and anywhere native thread tools are absent.

Prefer Native Mode for user-facing Desktop sessions; use Portable Mode when the user asks for a runnable script, journal replay, mock runs, or repeatable execution. The Node runner cannot call Codex app-native thread tools — treat it as the portable fallback, not a bridge to native orchestration.

## Codex Native Mode

When native thread tools are available, the parent Codex instance orchestrates:

1. **Discover the available tools first.** Depending on the environment this may be a thread API (`create_thread` / `send_message_to_thread` / `read_thread`), a multi-agent API (`spawn_agent` / `send_input` / `wait_agent` / `close_agent`), or another surface. Use what the session actually exposes.
2. **Derive the workflow shape** from the task (see *Designing the loop*): unit of work, source of truth, independent vs serialized work, verification gate, failure mode.
3. **Fan out** focused child threads for independent discovery, review, verification, or file-disjoint implementation. Give each a narrow prompt, the expected output shape, workspace context, and success criteria.
4. **Keep integration in the parent.** Children propose findings/patches; the parent verifies evidence, applies accepted changes, runs tests, and synthesizes the final answer. Don't hand off ownership of the whole task.
5. **Title/archive threads** for traceability if useful, but the parent summary, repo diff, and tests are authoritative — not thread state.

### Goal awareness

If an active Codex Goal exists, treat it as the top-level objective: include it in child and synthesis prompts when it keeps work aligned; never ask child threads to mark the Goal complete or blocked; the parent updates Goal state only after integration and verification prove the objective is genuinely done or blocked.

### Autoreview closeout

If code changed and the `autoreview` skill is available, run it on the integrated diff after tests, as a final parent-thread gate (not inside every child). Verify accepted findings against the real code path before fixing; if a fix changes the diff, rerun focused tests and autoreview.

## Portable runner: the operating loop

When the user says "use `$codex-workflow-runner`" (or asks you to author/run a workflow) and you're in Portable Mode, **you** drive the whole loop. Author the script proactively — don't wait for the user to hand you `workflow.js` unless they want to write it.

1. **Scope it.** Infer the target repo/app from the cwd and prompt. Ask only if scope is undiscoverable or the next step is risky/irreversible.
2. **Scout inline first, then fan out.** You rarely know the work-list up front. Discover it cheaply yourself — list files, find routes, scope the diff, pick the lenses — *then* author a workflow that pipelines over that list. Don't fan out blind.
3. **Author** a `workflow.js` (default `.codex-workflows/authored/`) using the contract below. Pick lenses, schemas, verifiers, and a stop condition that match the task's *mechanics*, not a template name.
4. **`inspect`** the script: confirm it parses, read the agent estimate, and clear any determinism/`agentType`/isolation warnings before spending money.
5. **`run`** it. Use `--sandbox read-only` for assessment/review/research (the default, and the only mode that caches/resumes). Use `--sandbox workspace-write` only for narrow implementer agents the user approved.
6. **Verify the outputs.** Read `workflow.json` and `journal.jsonl`; confirm `status: completed`; parse the structured `result`. Reject uncited, malformed, or unverified child output — don't paste it through.
7. **Synthesize in the parent.** If the goal needs code changes, implement the accepted ones yourself or author a second narrow `Fix → Verify` workflow, then run verification. Run `autoreview` on the diff if available.

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

Key `run` flags: `--workspace <dir>` (child cwd), `--sandbox read-only|workspace-write|danger-full-access` (default `read-only`; invalid values are rejected), `--args <json>` / `--args-file <file>` (exposed as global `args`), `--child-model <model>`, `--max-concurrency <n>` (default `min(16, cpu-2)`), `--max-agents <n>` (lifetime cap, default 1000), `--budget-tokens <n>` (sets `budget.total`), `--mock-agent` (mechanics only — no real model), `--json` (machine output). The output root defaults to `.codex-workflows/` in the directory you invoke the runner from.

Optional starter for assessment/throughput work — generate, then customize to the repo:

```bash
node "$RUNNER" template throughput --target "$PWD" \
  --objective "Increase throughput of the app" \
  --output .codex-workflows/authored/throughput-workflow.js
```

The template is one convenience starting point, not the goal. Authoring from scratch to fit the task is the norm.

## Authoring: the script contract

Plain JavaScript, not TypeScript. The script is parsed with a bundled [acorn](scripts/vendor/acorn.mjs) AST parser, so the **first statement must be a literal** `export const meta = {...}` — a pure object literal (no functions, arrows, spreads, computed keys, calls, `new`, or template interpolation inside `meta`). `name` and `description` are required; `whenToUse` and `phases` are optional. Use the same phase titles in `meta.phases` as in your `phase()` calls.

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  whenToUse: 'Reviewing a diff across several independent dimensions',
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
    agent(`Adversarially verify this finding. Try to refute it.\n${JSON.stringify(f)}`,
          { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))))
)

return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

Every workflow must call `agent()` at least once — don't use one only to declare phases or return a static object. The workflow's `return` value becomes `workflow.json.result`; return a compact, JSON-serializable value, not pasted-together child text.

### Runtime globals (exact Codex semantics)

- **`agent(prompt, opts) → Promise`** — spawns one child `codex exec`. `opts`: `label`, `phase`, `schema` (a plain JSON Schema, passed to `--output-schema`), `model`, `isolation: 'worktree'`. Without `schema` it returns the child's trimmed final text; with `schema` it returns the parsed object **validated against the schema — a non-conforming child fails (throws)**. The runner frames every child so its final message is treated as the programmatic return value (data, not a human reply). A failed child **throws** (see the pipeline caveat). `agentType`, `tools`, and `instructions` are **rejected** (fail fast); put guidance in the prompt and pick behavior via `model`.
- **`parallel(thunks) → Promise<any[]>`** — barrier. Takes **functions, not promises** (`parallel(items.map(x => () => agent(...)))`, never `items.map(x => agent(...))`). Runs them concurrently, returns results in input order, and substitutes `null` for any thunk that threw. Always `.filter(Boolean)`. Use only when you need all results together.
- **`pipeline(items, ...stages) → Promise<any[]>`** — the default multi-stage shape, **no barrier between stages**. Each item flows through every stage independently (item A can be at stage 3 while B is at stage 1). Each stage callback receives `(prevResult, originalItem, index)`. A stage that **returns `null`** drops that item (result `null`, remaining stages skipped). **Codex caveat — a stage that *throws* (including a failed `agent()`) rejects the entire pipeline and fails the run.** It does *not* become `null`. For per-item tolerance, `.catch()` inside the stage and return `null`, or put the fan-out in a `parallel()` *inside* a stage (which isolates).
- **`phase(title)`** groups later `agent()` calls under a progress phase. **`log(message)`** appends a run log.
- **`workflow(ref, args) → Promise`** runs one child workflow by script path (`'path.js'` or `{ scriptPath: 'path.js' }`). One level of nesting only; **no named registry**. Shares the parent's budget and agent cap.
- **`args`** is the parsed `--args` / `--args-file` value. **`cwd` / `process.cwd()`** is the workspace dir child agents run in (the `--workspace` value); `process` is a frozen shim exposing only `cwd()`. **`budget`** is `{ total, spent(), remaining() }`, approximate (chars/4); `total` is `null` unless `--budget-tokens` is set.

### Determinism sandbox

Scripts run in a locked VM. These are blocked: `Date.now()`, argless `new Date()` / `Date()`, `Math.random()`, `require`, filesystem APIs, and timers (`setTimeout`/`setInterval`). `new Date(timestamp)` with an explicit argument **is** allowed — thread the current time through `args`; vary fan-out by `index`. `console.log` routes to `log()`. This is what makes runs replayable — don't fight it.

## pipeline vs parallel: the decision

**Default to `pipeline()`.** A barrier (`parallel()` between stages) is correct *only* when stage N needs cross-item context from all of stage N-1:

- dedupe/merge across the full result set before expensive downstream work,
- early-exit on the total ("0 findings → skip verification entirely"),
- a stage that compares against "all the other findings."

A barrier is **not** justified by "I need to flatten/map/filter first" (do that inside a stage: `pipeline(items, a, r => transform([r]).flat(), b)`) or "it reads cleaner." Smell test: if you wrote `const a = await parallel(...); const b = a.flat().map(...); const c = await parallel(b...)`, that middle transform has no cross-item dependency — rewrite it as a pipeline with the transform inside a stage. When in doubt, pipeline.

**Failure isolation differs between the two** (verified against this runner, and a real divergence from the pi/Claude model where failures uniformly become `null`): `parallel()` turns a failed branch into `null`; `pipeline()` does **not** — a *throwing* stage aborts the whole run, and only an explicit `null` *return* drops a single item. Guard pipeline stages (`.catch(() => null)`) if one failure shouldn't kill the batch.

When a barrier *is* right (dedup before verify):

```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS_SCHEMA })))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT_SCHEMA })))
```

## Quality patterns (compose freely)

Real, runnable shapes. Pick by task; combine them.

- **Adversarial verify** — N independent skeptics per finding, each told to *refute*; kill unless a majority confirms.
  ```js
  const votes = await parallel(Array.from({ length: 3 }, (_, i) => () =>
    agent(`Refute this claim if you can; default to refuted=true when uncertain. (reviewer ${i})\n${claim}`,
          { label: `refute:${i}`, schema: VERDICT_SCHEMA })))
  const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
  ```
- **Perspective-diverse verify** — when a finding can fail in more than one way, give each verifier a distinct lens (`correctness`, `security`, `repro`) instead of N identical skeptics.
- **Judge panel** — generate N independent attempts from different angles, score with parallel judges, synthesize from the winner while grafting the best of the runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds surface nothing new; dedup against *everything seen*, or it never converges.
- **Loop-until-budget** — scale depth to a token target. Guard on `budget.total` or the loop runs to the agent cap:
  ```js
  const found = []
  while (budget.total && budget.remaining() > 50000) {
    const r = await agent('Find one more high-leverage issue not already listed.', { label: 'find', schema: BUGS_SCHEMA })
    found.push(...r.bugs); log(`${found.length} found, ${Math.round(budget.remaining()/1000)}k left`)
  }
  ```
- **Multi-modal sweep** — parallel finders each searching a *different* way (by file, by symbol, by entity, by time); one angle alone won't find everything.
- **Completeness critic** — a final agent that asks "what's missing — a lens not run, a claim unverified, a file unread?" Its answer becomes the next round.
- **No silent caps** — if you bound coverage (top-N, no-retry, sampling), `log()` what you dropped.

Scale to the ask: "find any bugs" → a few finders, single-vote verify; "thoroughly audit this" → a larger finder pool, 3–5-vote adversarial pass, explicit synthesis stage.

## Designing the loop for a new task

Workflows are control loops, not a fixed menu of phase names. Before authoring, derive the loop:

1. **Unit of work** — file, crate, route, command, finding, failing test, dependency tier, design option, duplicate cluster?
2. **Truth source** — static code, docs/specs, the compiler, tests, runtime probes, benchmark numbers, or a cross-agent vote?
3. **What runs independently** — read-only discovery, file-disjoint edits, command probes, per-item classification, verifier votes?
4. **What must be serialized** — shared-tree mutation, global build/test/git, the final architecture decision, cross-shard clustering, integration?
5. **The gate** — all items classified, no confirmed findings, build green, probes pass, benchmark improves, or `MAX_ROUNDS` reached?
6. **What failure looks like** — low confidence, disputed votes, blocked dependency, compile error, panic signature, regression?

Then compose phases from primitives: **fan out** for independent read-only exploration or disjoint edits; **fan in** to dedupe/cluster/judge/rank/synthesize before spending mutation budget; **refute** with independent verifiers when false positives are expensive; **vote + tiebreak** when judgments are noisy; **serialize** mutation when agents share files/build/git; **probe** with executable commands when the system can reveal the next failure; **repeat** only around an external gate with an explicit `MAX_ROUNDS`, success predicate, and a defined "still blocked" return shape.

Named shapes are *derivations* of these choices, not presets — e.g. `Classify → Sample-Verify → Synthesize` (many items, taxonomy truth, error-rate gate); `Panel → Judge → Docs` (design options, constraint truth, one decision); `Assess → Serial-Implement → Parallel-Verify → Gate` (subsystems, code+build truth, serialized mutation); `Probe → Dedup → Fix → Repeat` (failing commands, runtime truth, repeat until probes pass); `Shard-Find → CrossRef → Vote → Apply → Compile-Gate` (dedup at scale, one owner of build/git). If the task shape changes mid-run, stop, synthesize what you have, and author the next loop rather than forcing the old one. Always include a real synthesis step for broad workflows — never just concatenate child outputs.

## Choosing scale

- **Narrow known fix:** 1 implementer + 1 verifier.
- **Focused problem / small app:** 2–3 assessors across the most relevant lenses, then verify the top findings.
- **Medium app:** 4–6 assessors (e.g. runtime hot paths, data access, concurrency/I/O, frontend/delivery, observability/tests, plus one domain lens).
- **Broad/high-risk audit:** 6–10 assessors plus independent verification. Exceed this only when the problem is genuinely large and the user accepts the cost.

## Sandbox and mutation discipline

- **`read-only` is the default and the only mode that caches/resumes.** Use it for all assessment, review, and research workflows.
- Use **`workspace-write`** (or `danger-full-access`) only for narrow implementer agents the user asked for or approved. Mutating runs never replay the journal cache.
- Keep mutation **serialized or file-disjoint.** Let exactly one agent own global build/test/git. Fan out read-only discovery aggressively; never fan out conflicting edits to a shared tree.
- **`isolation: 'worktree'`** runs a mutating agent in a throwaway git worktree. It requires the parent tree to be clean outside the runner's own output dirs, captures the child's diff as `agent-*.worktree.patch`, keeps changed worktrees for you to inspect/apply, and removes unchanged ones. There is **no automatic merge** — you (or an integrator agent) apply accepted patches.

## Child-agent prompts

The runner already frames each child so its final message is treated as the return value (not a human reply), and nudges it to cite evidence and not defer. Your prompt still carries the rest of the quality:

- **Bound the lens.** One clear job per agent ("only data-access bottlenecks", "only this file").
- **Pass all needed context.** Children don't share the parent's context — include the task, relevant paths, and the expected output shape in every prompt.
- **Give each a unique short `label`** (2–5 words). Unique labels keep live status, journals, and error reporting readable.
- **Demand concrete citations** — file paths, `file:line`, functions, commands — and forbid invented metrics or benchmarks.
- **If a `schema` is set,** tell the child to return raw JSON satisfying it (no prose/fences) and to put evidence in the schema fields. For verifiers, tell them to open the cited code and default to skeptical when evidence is weak.

## After the run: verify before you trust

- Open `workflow.json`; confirm `status` is `completed` (a thrown pipeline stage, schema violation, exhausted budget, or hit agent cap leaves `status: failed` with an `error`).
- `workflowProgress` is a **flat array** — filter by `type === 'workflow_phase'` and `type === 'workflow_agent'`. Each agent record carries `state`, `label`, `phaseTitle`, `model`, `tokens`, `durationMs`, `resultPreview`, `cachePath`, and (for isolated agents) `worktree`. Failed agents appear with `state: 'failed'`.
- `journal.jsonl` holds `started` + `result` events per non-cached `agent()`. A `started` with no `result` means the child failed before finishing — read `subagents/workflows/<runId>/agent-*.stderr.txt`.
- For schema agents, parse the object from `workflow.json.result` or the journal `result` — **not** the child transcript.
- `summarize <run-dir>` gives a one-line status/agent/token read; add `--json` for the full summary.
- **`--mock-agent` validates script mechanics only** (it synthesizes fake results from schemas). It does not validate delegation, model behavior, or output quality — never report a mock run as a real result.

## inspect is a rough estimate, not a count

`inspect` is a static AST preview: it counts `agent()`/`parallel()`/`pipeline()`/loops, previews `meta`, and flags determinism violations and unsupported `agentType`/isolation before you spend money. The AST walk reliably detects calls (including inside nested template literals) and avoids string-literal false positives, but `estimatedAgents` is still a heuristic that can **over- or under-count** data-dependent fan-out — one `agent()` site inside a `pipeline()` over a runtime-sized array can't be counted statically. The authoritative number is `workflow.json.agentCount` *after* the run. Treat `inspect` as a smoke check and a lint pass, not the real plan.

## Resume and caching

In `read-only` runs, every `agent()` result is journaled under a `v2:` key derived from prompt + normalized options + call-path + workspace. `run --resume <run-dir>` replays unchanged calls instantly from the journal and only re-runs new or edited ones — same script + same args = full cache hit. Mutating runs (`workspace-write`/`danger-full-access`) never replay cache. Resume reuses the prior run's `scriptPath`, `runId`, `workspace`, `args`, `sandbox`, and `childModel` unless you override them.

## Nested-Codex caveat

If you launch the runner from *inside* another sandboxed Codex child, the nested `codex exec` calls can fail before any model work with errors like `attempt to write a readonly database`, `failed to initialize in-process app-server client`, or disabled DNS. That is an infrastructure failure, not a workflow-script bug — failed runs still leave `workflow.json`, child `stderr` files, and a journal with `started` but no `result` events. Run workflows from the **top-level Codex session**, or start the outer child with enough access to initialize Codex state and the app-server. `--mock-agent` can still validate mechanics in a constrained sandbox.

## Reference

For the shared script contract, snapshot/journal schemas, static-`inspect` behavior, and Codex-specific adjustments, see [references/codex-dynamic-workflows.md](references/codex-dynamic-workflows.md); [references/codex-workflow-runner-parity-analysis.md](references/codex-workflow-runner-parity-analysis.md) compares this runner against pi-dynamic-workflows and Claude Code. You don't need either to author or run workflows — only when extending the runner. Parser/inspection logic has unit tests: `node --test tests/parser.test.mjs` from the skill directory.
