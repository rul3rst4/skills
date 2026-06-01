---
name: codex-workflow-runner
description: 'Author, run, and orchestrate multi-agent Codex workflows. The bundled portable JavaScript runner fans work out to native Codex subagents — each agent() spawns a subagent thread through one shared codex app-server (with a codex exec fallback) — with phases, pipeline/parallel fan-out, native schema-validated outputs, real token accounting, per-agent model/effort/instructions/sandbox/MCP, journals, resume, worktree isolation, and parent synthesis. Use for tasks that need broad parallel coverage, independent verification before acting, or more scale than one context can hold (audits, reviews, research sweeps, migrations, large refactors, throughput work). Triggers on "use $codex-workflow-runner", "run/author a workflow", "fan out agents", or "orchestrate this with subagents".'
---

# Codex Workflow Runner

You (the parent Codex session) are the **orchestrator**. A workflow fans work out to child agents *deterministically*, collects their structured results, and hands them back to you to synthesize. There are two execution paths:

- **The portable runner (default, subagent-native)** — a bundled Node runtime that executes a plain-JavaScript workflow script and delegates each `agent()` to a **native Codex subagent**: it drives one long-lived, shared `codex app-server` over JSON-RPC and spawns a subagent thread per call (`thread/start` + `turn/start`). One process for the whole run (near-zero per-agent cold start), native `outputSchema` enforcement, real token accounting, and per-agent model / reasoning effort / developer instructions / sandbox / MCP servers. `codex exec` remains a fallback transport (`--transport exec`). Use it from terminals, CI, or Desktop — it is runnable and resumable.
- **Native Codex thread orchestration** — when the *parent* Codex session itself exposes thread/multi-agent tools, you can instead fan out with those directly (most useful for ad-hoc, interactive Desktop work).

The portable runtime is a Codex-native adaptation of [`earendil-works/pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) (a Pi extension), itself inspired by Anthropic's dynamic workflows in Claude Code. It keeps the same deterministic, AST-validated script contract — `export const meta = {...}` followed by plain JS calling `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()` — and adds native Codex subagents, journals, resume, snapshots, worktree isolation, and a static `inspect` preview.

Reach for a workflow to be **comprehensive** (decompose a problem and cover it in parallel), to be **confident** (independent perspectives and adversarial checks before you commit to a conclusion or an edit), or to take on **scale one context can't hold** (sweeps, migrations, audits across many files). Do **not** orchestrate a single-file edit, a one-shot question, or work you can finish faster inline — fan-out has real cost (one child process per `agent()` in portable mode).

## Mode selection

Choose the path before authoring:

- **Portable Runner (default)** — the bundled Node runner for deterministic `workflow.js` scripts. Each `agent()` is a native Codex subagent thread (via the shared `codex app-server`), so you get native schema enforcement, real token accounting, per-agent model/effort/instructions/sandbox/MCP, journals, resume, and mock runs. Works in terminals, CI, and Desktop.
- **Codex Native Mode** — manual fan-out using the parent session's own thread/multi-agent tools, when present (Desktop). Best for ad-hoc, interactive orchestration where you stay in the loop turn by turn rather than running a scripted loop.

Prefer the Portable Runner for anything scripted, repeatable, resumable, or headless — which is most workflows. Reach for parent-session thread orchestration only for interactive Desktop fan-out you drive by hand.

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
4. **`inspect`** the script: confirm it parses, read the agent estimate, and clear any determinism/isolation warnings before spending money.
5. **`run`** it. Use `--sandbox read-only` for assessment/review/research (the default, and the only mode that caches/resumes). Use `--sandbox workspace-write` only for narrow implementer agents the user approved.
6. **Verify the outputs.** Read `workflow.json` and `journal.jsonl`; confirm `status: completed`; parse the structured `result`. Reject uncited, malformed, or unverified child output — don't paste it through.
7. **Synthesize in the parent.** If the goal needs code changes, implement the accepted ones yourself or author a second narrow `Fix → Verify` workflow, then run verification. Run `autoreview` on the diff if available.

## Running the runner

```bash
RUNNER="$HOME/.codex/skills/codex-workflow-runner/codex-workflow-runner/scripts/codex_workflow_runner.mjs"
# If the path differs (project-local install), locate it:
# RUNNER="$(find "$HOME/.codex/skills" "$PWD/.codex" -name codex_workflow_runner.mjs 2>/dev/null | head -1)"

node "$RUNNER" inspect .codex-workflows/authored/workflow.js          # static preview + warnings
node "$RUNNER" run .codex-workflows/authored/workflow.js --workspace "$PWD"
node "$RUNNER" summarize .codex-workflows/wf_<id>                      # quick status/result read
node "$RUNNER" run --resume .codex-workflows/wf_<id>                   # resume from journal cache
```

Key `run` flags: `--workspace <dir>` (subagent cwd), `--sandbox read-only|workspace-write|danger-full-access` (default `read-only`; invalid values are rejected), `--transport appserver|exec` (default `appserver`; native subagents vs the per-agent `codex exec` fallback), `--schema-retries <n>` (re-ask a schema-violating subagent N times, default 1), `--args <json>` / `--args-file <file>` (exposed as global `args`), `--child-model <model>` (default model for each subagent), `--max-concurrency <n>` (default `min(16, cpu-2)`), `--max-agents <n>` (lifetime cap, default 1000), `--budget-tokens <n>` (sets `budget.total`, now counted in **real** subagent tokens), `--mock-agent` (mechanics only — no real model), `--json` (machine output). The output root defaults to `.codex-workflows/` in the directory you invoke the runner from. If the app-server cannot initialize (e.g. some nested sandboxes), the run logs a warning and falls back to `exec` automatically.

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
        .catch(() => ({ findings: [] })),              // optional: non-null fallback for a failed lens (a bare throw would just drop the item to null)
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify this finding. Try to refute it.\n${JSON.stringify(f)}`,
          { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))))
)

return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

Every workflow must call `agent()` at least once — don't use one only to declare phases or return a static object. The workflow's `return` value becomes `workflow.json.result`; return a compact, JSON-serializable value, not pasted-together child text.

### Runtime globals (exact Codex semantics)

- **`agent(prompt, opts) → Promise`** — spawns one native Codex subagent thread. `opts`: `label`, `phase`, `schema` (a plain JSON Schema — enforced natively via the subagent's `outputSchema`), `model`, `effort` (`none|minimal|low|medium|high|xhigh`), `instructions` (per-agent developer instructions for the subagent), `agentType` (a built-in `default`/`worker`/`explorer`, or a `.codex/agents/<name>.toml` profile name in the workspace or `CODEX_HOME`), `mcpServers` / `tools` (`{ serverName: { command, args, env } }`, merged into the subagent's MCP config), `isolation: 'worktree'`. Without `schema` it returns the subagent's trimmed final message; with `schema` it returns the parsed object validated against the schema — on a violation the runner re-asks the subagent up to `--schema-retries` times (default 1) before **throwing**. The runner frames every subagent so its final message is the programmatic return value (data, not a human reply). A failed subagent **throws**. Per-agent `model`/`instructions`/`effort` override an `agentType` profile; a profile's `sandbox_mode` is clamped to the run's `--sandbox` ceiling and never escalates it. (On `--transport exec`, `mcpServers` and MCP-declaring `agentType` profiles are rejected — the app-server transport is required for MCP bridging.)
- **`parallel(thunks) → Promise<any[]>`** — barrier. Takes **functions, not promises** (`parallel(items.map(x => () => agent(...)))`, never `items.map(x => agent(...))`). Runs them concurrently, returns results in input order, and substitutes `null` for any thunk that threw. Always `.filter(Boolean)`. Use only when you need all results together.
- **`pipeline(items, ...stages) → Promise<any[]>`** — the default multi-stage shape, **no barrier between stages**. Each item flows through every stage independently (item A can be at stage 3 while B is at stage 1). Each stage callback receives `(prevResult, originalItem, index)`. A stage that **returns `null`** drops that item (remaining stages skipped), and a stage that **throws** (including a failed `agent()`) likewise drops just that item to `null` — per-item failures are isolated and never fail the whole run. (This now matches `parallel()` and the pi/Claude model; the older "a throwing stage aborts the run" caveat no longer applies.)
- **`phase(title)`** groups later `agent()` calls under a progress phase. **`log(message)`** appends a run log.
- **`workflow(ref, args) → Promise`** runs one child workflow by script path (`'path.js'` or `{ scriptPath: 'path.js' }`). One level of nesting only; **no named registry**. Shares the parent's budget and agent cap.
- **`args`** is the parsed `--args` / `--args-file` value. **`cwd` / `process.cwd()`** is the workspace dir subagents run in (the `--workspace` value); `process` is a frozen shim exposing only `cwd()`. **`budget`** is `{ total, spent(), remaining() }` counted in **real** subagent tokens reported by the app-server (the `exec`/`--mock-agent` paths fall back to a chars/4 estimate); `total` is `null` unless `--budget-tokens` is set.

### Determinism sandbox

Scripts run in a locked VM. These are blocked: `Date.now()`, argless `new Date()` / `Date()`, `Math.random()`, `require`, filesystem APIs, and timers (`setTimeout`/`setInterval`). `new Date(timestamp)` with an explicit argument **is** allowed — thread the current time through `args`; vary fan-out by `index`. `console.log` routes to `log()`. This is what makes runs replayable — don't fight it.

## pipeline vs parallel: the decision

**Default to `pipeline()`.** A barrier (`parallel()` between stages) is correct *only* when stage N needs cross-item context from all of stage N-1:

- dedupe/merge across the full result set before expensive downstream work,
- early-exit on the total ("0 findings → skip verification entirely"),
- a stage that compares against "all the other findings."

A barrier is **not** justified by "I need to flatten/map/filter first" (do that inside a stage: `pipeline(items, a, r => transform([r]).flat(), b)`) or "it reads cleaner." Smell test: if you wrote `const a = await parallel(...); const b = a.flat().map(...); const c = await parallel(b...)`, that middle transform has no cross-item dependency — rewrite it as a pipeline with the transform inside a stage. When in doubt, pipeline.

**Failure isolation is now uniform** (matching the pi/Claude model): both turn a failed branch into `null`. `parallel()` substitutes `null` for any thunk that throws; `pipeline()` drops just that item to `null` when a stage throws or returns `null` (and skips its remaining stages). `.filter(Boolean)` the results either way. You no longer need a defensive `.catch(() => null)` to keep one failure from killing a batch — though an explicit `.catch()` is still useful when you want a *non-null* fallback for a failed item.

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

## Subagent profiles: agentType, instructions, MCP

Each `agent()` is a real Codex subagent thread, so you can shape its behavior beyond the prompt:

- **`instructions`** sets per-agent developer instructions on the subagent thread (a persona/role layered under the task prompt). Use it to give a verifier its skepticism, an implementer its discipline, etc.
- **`agentType`** picks a Codex agent profile: the built-ins `explorer` (read-only, low effort), `worker` (execution-focused), `default`, or any `.codex/agents/<name>.toml` you define in the workspace or `CODEX_HOME` (its `developer_instructions`, `model`, `model_reasoning_effort`, `sandbox_mode`, and `mcp_servers` are applied). Per-agent `model`/`instructions`/`effort` override the profile; a profile's `sandbox_mode` is clamped to the run's `--sandbox` ceiling.
- **`mcpServers` / `tools`** (`{ name: { command, args, env } }`) merge extra MCP servers into that subagent's tool surface; the subagent also inherits the user's session MCP servers. (App-server transport only.)
- **`effort`** (`none|minimal|low|medium|high|xhigh`) sets reasoning effort — `low` for cheap scanning, `high`/`xhigh` for deep logic/security work.

## Child-agent prompts

The runner already frames each subagent so its final message is treated as the return value (not a human reply), and nudges it to cite evidence and not defer. Your prompt still carries the rest of the quality:

- **Bound the lens.** One clear job per agent ("only data-access bottlenecks", "only this file").
- **Pass all needed context.** Subagents don't share the parent's context — include the task, relevant paths, and the expected output shape in every prompt.
- **Give each a unique short `label`** (2–5 words). Unique labels keep live status, journals, and error reporting readable.
- **Demand concrete citations** — file paths, `file:line`, functions, commands — and forbid invented metrics or benchmarks.
- **If a `schema` is set,** it is enforced natively by the subagent's `outputSchema`; still tell the agent to put evidence in the schema fields. For verifiers, tell them to open the cited code and default to skeptical when evidence is weak.

## After the run: verify before you trust

- Open `workflow.json`; confirm `status` is `completed` (an *unguarded* thrown `agent()` at the top level, exhausted budget, or a hit agent cap leaves `status: failed` with an `error`; a throw *inside* a `pipeline`/`parallel` only drops that item to `null`).
- `workflowProgress` is a **flat array** — filter by `type === 'workflow_phase'` and `type === 'workflow_agent'`. Each agent record carries `state`, `label`, `phaseTitle`, `model`, `tokens` (real subagent tokens on the app-server transport), `durationMs`, `resultPreview`, `cachePath`, and (for isolated agents) `worktree`. Failed agents appear with `state: 'failed'` and the reason in `lastToolSummary`.
- `journal.jsonl` holds `started` + `result` events per non-cached `agent()`. A `started` with no `result` means the subagent failed before finishing — inspect `subagents/workflows/<runId>/agent-*.meta.json`, and on the `exec` transport `agent-*.stderr.txt`. (App-server diagnostics surface in the run `error` and the agent's `lastToolSummary`.)
- For schema agents, parse the object from `workflow.json.result` or the journal `result` — **not** the child transcript.
- `summarize <run-dir>` gives a one-line status/agent/token read; add `--json` for the full summary.
- **`--mock-agent` validates script mechanics only** (it synthesizes fake results from schemas). It does not validate delegation, model behavior, or output quality — never report a mock run as a real result.

## inspect is a rough estimate, not a count

`inspect` is a static AST preview: it counts `agent()`/`parallel()`/`pipeline()`/loops, previews `meta`, and flags determinism violations and unsupported isolation modes before you spend money. The AST walk reliably detects calls (including inside nested template literals) and avoids string-literal false positives, but `estimatedAgents` is still a heuristic that can **over- or under-count** data-dependent fan-out — one `agent()` site inside a `pipeline()` over a runtime-sized array can't be counted statically. The authoritative number is `workflow.json.agentCount` *after* the run. Treat `inspect` as a smoke check and a lint pass, not the real plan.

## Resume and caching

In `read-only` runs, every `agent()` result is journaled under a `v2:` key derived from prompt + normalized options + call-path + workspace. `run --resume <run-dir>` replays unchanged calls instantly from the journal and only re-runs new or edited ones — same script + same args = full cache hit. Mutating runs (`workspace-write`/`danger-full-access`) never replay cache. Resume reuses the prior run's `scriptPath`, `runId`, `workspace`, `args`, `sandbox`, and `childModel` unless you override them.

## Nested-Codex caveat

If you launch the runner from *inside* another sandboxed Codex child, the nested `codex app-server` can fail to initialize before any model work (errors like `attempt to write a readonly database`, `failed to initialize in-process app-server client`, or disabled DNS). When the app-server can't start, the run logs a warning and **auto-falls-back to `--transport exec`** — but those nested `codex exec` calls can fail the same way. That is an infrastructure failure, not a workflow-script bug — failed runs still leave `workflow.json`, subagent `stderr`/`meta` files, and a journal with `started` but no `result` events. Run workflows from the **top-level Codex session**, or start the outer child with enough access to initialize Codex state and the app-server. `--mock-agent` can still validate mechanics in a constrained sandbox.

## Reference

For the shared script contract, snapshot/journal schemas, static-`inspect` behavior, and Codex-specific adjustments, see [references/codex-dynamic-workflows.md](references/codex-dynamic-workflows.md); [references/codex-workflow-runner-parity-analysis.md](references/codex-workflow-runner-parity-analysis.md) compares this runner against pi-dynamic-workflows and Claude Code. You don't need either to author or run workflows — only when extending the runner. Parser/inspection logic has unit tests: `node --test tests/parser.test.mjs` from the skill directory.
