# Claude Workflow Runner Parity Analysis

Date: 2026-05-31

## Executive Verdict

`claude-workflow-runner` is **not yet at the same overall feature, performance, or quality level as Claude Code workflows**.

It is, however, a strong clean-room approximation of the core workflow DSL. It correctly captures the most important conceptual primitives: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()`, schema-shaped outputs, journals, snapshots, bounded loops, fan-out/fan-in patterns, and parent synthesis discipline. At the *workflow-shape* level, it is close.

The gap is in the product-grade execution layer: Claude's native Workflow tool is integrated with its Agent SDK, custom subagents, automatic worktree merge semantics, ToolSearch/MCP reachability, live `/workflows` progress UI, permission preview/edit UX, exact-ish accounting, background task lifecycle, and mature resume semantics. The Codex runner delegates to separate `codex exec` child processes and intentionally leaves several of those features out, rejects some unsupported Claude options, or implements narrower patch-based equivalents.

My practical score:

| Area | Parity | Assessment |
| --- | ---: | --- |
| DSL shape and authoring guidance | 4/5 | The skill captures Claude-style decomposition well. |
| Runtime primitives | 3.5/5 | `parallel`, `pipeline`, `phase`, schema delegation, journal replay are implemented. |
| Claude Workflow product features | 2.5/5 | No native UI, permission preview, named registry, background lifecycle, automatic worktree merge/apply, or custom agent behavior. |
| Performance at scale | 3/5 | Correct concurrency cap and configurable lifetime agent cap, but child-process `codex exec` per agent, approximate token accounting, and no native prompt-cache integration. |
| Quality / reliability | 3.25/5 | Good deterministic design, fail-fast unsupported `agentType`, patch-based worktree isolation, and a stronger inspector, but product-grade gaps remain. |

Overall: **good experimental runtime, not feature-parity with Claude Code workflows.**

## Evidence Reviewed

- Bun PR 30412 changes, especially `.claude/workflows/*.workflow.js`: [PR files](https://github.com/oven-sh/bun/pull/30412/files) and the user-linked diff anchor, which maps to [`phase-b0-cyclebreak.workflow.js`](https://github.com/oven-sh/bun/blob/ed1a70f81708d7d137de8de057d11668c5f4e220/.claude/workflows/phase-b0-cyclebreak.workflow.js).
- The PR adds **53 workflow scripts** on API page 1 under `.claude/workflows/`.
- Redacted local Claude context dump and workflow artifacts. The private paths, workflow names, and per-run inventory are intentionally omitted from this repository-facing note.
- Skill files:
  - `SKILL.md`
  - `references/claude-dynamic-workflows.md`
  - `scripts/claude_workflow_runner.mjs`

## What Claude Workflows Offer

The Claude context dump describes `Workflow` as a first-class tool that runs deterministic scripts in the background and reports completion via task notifications. It persists scripts automatically, exposes `/workflows` for live progress, supports inline scripts, saved names, `scriptPath`, and `resumeFromRunId`.

Important Claude features from the dump:

- Explicit opt-in rules before large workflow execution.
- Inline script invocation, plus automatic persistence under the session directory.
- Saved workflow resolution by name from `.claude/workflows/`.
- Pure literal `meta`, including optional `whenToUse` and phase-level model metadata.
- `agent(prompt, opts)` with `label`, `phase`, `schema`, `model`, `isolation: "worktree"`, and `agentType`.
- `pipeline()` as the default no-barrier multi-stage primitive.
- `parallel()` as a barrier primitive.
- `workflow(nameOrRef, args)` for one-level composition.
- Shared workflow budget with a hard ceiling.
- Concurrency cap of `min(16, cpu cores - 2)`.
- Total lifetime cap of 1000 agents.
- ToolSearch/MCP availability inside workflow agents.
- Custom subagent types such as `Explore` and `general-purpose`.
- Worktree isolation for mutating parallel agents.
- Resume by unchanged `agent()` prefix in the same session.
- Subagents are told their final text is a return value, not a human-facing response.

Redacted local artifacts exercise those features at non-toy scale, including dozens of agents, multi-phase audit/verify/synthesize patterns, and per-agent token/tool/duration telemetry. Exact workflow names, paths, and counts are omitted to avoid leaking local workflow history.

## What The Bun PR Demonstrates

The Bun PR is the strongest external example because it uses workflows as a large migration control system, not just review fan-out.

Patterns found in the 53 scripts:

- `phase-b0-cyclebreak`: classify crate dependency back-edges into `DELETE`, `TYPE_ONLY`, `MOVE_DOWN`, `FORWARD_DECL`, `GENUINE`.
- `phase-a-port`: per-file Zig-to-Rust draft port, adversarial verification, targeted fix.
- `phase-b2-cycle`: tier loop over `Ungate -> Verify -> Fix`, with two verifiers and tiebreakers.
- `phase-c-panic-swarm`: bounded `Link -> Probe -> Fix` loop over command failures and panic signatures.
- `phase-h-dedup`: 30-ish shard agents find duplicates, one cross-reference agent clusters, two verifiers vote, edit agents apply, one compile agent owns cargo/git.
- `phase-h-unsafe-wrap`: classify every unsafe block, coalesce strategies, apply, two-vote review, final compile.
- Later D/E/F/G/H workflows repeat bounded repair loops with explicit stop rules.

This matches the skill's best guidance: partition work, collect evidence, reduce uncertainty, mutate only accepted state, externally gate, then repeat or stop.

The Bun scripts also expose important pressure points:

- They rely on many data-dependent fan-outs, so static agent estimates are necessarily lower bounds.
- Several workflows allow or require mutation by agents, sometimes with manual hard rules around git/cargo ownership.
- Some workflows use `isolation: "worktree"` in Windows fix flows.
- At least two scripts are not compatible with the deterministic restrictions captured in the Claude context and enforced by the runner:
  - `lifetime-classify.workflow.js` uses `Math.random()` for sampling.
  - `phase-h-idioms-audit.workflow.js` calls argless `new Date()` inside a generated report prompt.

That last point is not necessarily a runner bug; it is evidence that the Bun scripts and the captured Claude 2.1.158 contract are not perfectly aligned in time or enforcement. But it matters for parity claims: the Codex runner cannot be both strict to the captured contract and a drop-in executor for every Bun PR script without a compatibility mode.

## What The Skill Implements Well

The skill documentation is thoughtful and aligned with Claude's real workflow philosophy.

Strong points:

- It instructs Codex to author workflows proactively instead of waiting for a supplied script.
- It frames workflows as control loops rather than fixed templates.
- It teaches the right concurrency boundaries: broad read-only fan-out, serialized mutation, single owner for build/test/git.
- It explicitly names quality patterns: adversarial verification, vote/tiebreak, dedupe, probe loops, bounded repair rounds.
- It requires post-run inspection of `workflow.json` and `journal.jsonl` before accepting child outputs.
- It warns that mock mode validates mechanics only, not real delegation.

The runtime also implements meaningful core behavior:

- CLI commands: `inspect`, `template throughput`, `run`, `summarize`.
- Pure literal `meta` extraction and validation.
- Worker-thread VM isolation for workflow scripts.
- `parallel()` barrier semantics with failed thunk -> `null`.
- `pipeline()` item-by-item progression without cross-stage barriers.
- `agent()` with schema support via `codex exec --output-schema`.
- Snapshot persistence to `workflow.json`.
- Journal replay keyed with a deterministic `v2:` hash that includes prompt, normalized options, workspace, and a call path.
- `workflow()` composition by script path with one-level nesting.
- Default concurrency cap equivalent to Claude's documented `min(16, cpu - 2)`.
- Determinism guards for `Date.now()`, argless `new Date()`, `Math.random()`, `require`, and `process`.

## Major Feature Gaps

### 1. `agentType` Is Rejected, Not Behavior

Claude uses `agentType` to select real custom subagent definitions such as `Explore` or `general-purpose`. Your local saved workflows use this, for example in read-only contract extraction and review flows.

The runner now fails fast when `opts.agentType` is set. That is safer than launching a generic Codex child while pretending to honor `Explore` or another Claude-specific profile, but it is still not custom subagent parity.

Severity: high. This directly affects result quality and cost, because `Explore`-style agents are designed to read excerpts and avoid noisy full-file dumps.

### 2. Worktree Isolation Is Patch-Based, Not Automatic Merge

Claude supports `isolation: "worktree"` for agents that mutate in parallel. The context dump says it creates a temporary git worktree and auto-cleans it if unchanged.

The runner currently:

- creates a temporary detached git worktree for `isolation: "worktree"`,
- requires the parent git worktree to be clean outside the runner's own output directory,
- runs the child Codex process in that worktree,
- captures patch/status metadata, including committed and uncommitted child changes,
- keeps changed worktrees for parent/integrator review,
- removes unchanged worktrees automatically.

The remaining gap is merge semantics. Claude's native workflow can treat isolated worktree execution as part of its product workflow; this runner deliberately requires the parent or an integrator to inspect and apply captured patches.

Severity: medium-high.

### 3. No Named Workflow Registry

Claude can run a workflow by `name`, resolving saved scripts from `.claude/workflows/`. The runner only supports direct script paths for `workflow(ref, args)` and CLI `run`.

The skill says `workflow(ref, args)` can run by `{scriptPath}` or direct script path, but the Claude context includes a named built-in/local registry. The reference file correctly lists "Named built-in workflow registry" as a known non-replicated gap.

Severity: medium-high. It blocks drop-in reuse of `.claude/workflows` conventions.

### 4. Product UX Is Missing

Claude has:

- background task execution,
- task notifications,
- `/workflows` live progress,
- permission preview,
- view raw script,
- edit in `$EDITOR`,
- user skip/permission handling.

The runner has:

- foreground CLI execution,
- `workflow.json` snapshots,
- a lightweight `inspect`,
- no terminal UI,
- no interactive permission dialog,
- no watch UI.

Severity: medium. This does not prevent experiments, but it is a big difference in user trust and operability.

### 5. ToolSearch / MCP Reachability Is Not Equivalent

Claude workflow agents can reach session-connected MCP tools via ToolSearch. The runner launches `codex exec` children and relies on whatever tools/config that child environment has. There is no explicit per-agent ToolSearch bridge or guarantee that connected app tools match the parent session.

Severity: medium-high for research, browser, Gmail/Calendar/Notion, or any connector-heavy workflow.

### 6. Resume Semantics Are Similar But Not The Same

The runner has a good journal replay design, and it improved on naive prompt hashing by including call path. It can resume a run directory and return cached read-only agent results.

Differences from Claude:

- Claude describes same-session `resumeFromRunId` with longest unchanged prefix semantics.
- The runner's cache is journal-key based and only reads cache when `sandbox === "read-only"`.
- Mutating runs intentionally do not replay cached agent results.
- There is no `TaskStop`/background-run lifecycle.
- There is no fallback reconstruction from child JSONL beyond manual inspection.

Severity: medium. The runner is safe and sensible, but not a drop-in equivalent.

### 7. Token And Tool Accounting Are Approximate

Claude snapshots record actual-ish `tokens`, `toolCalls`, `durationMs`, model, and progress. Your local workflows show per-agent counts in the tens or hundreds of thousands of tokens.

The runner estimates tokens as `Math.ceil(chars / 4)` for prompts/results and increments `toolCalls` once per child agent. It does not parse Codex JSONL to compute actual child tool calls or model usage. Budget enforcement is therefore approximate.

Severity: medium for small experiments, high for large workflows where budgets drive loop depth.

### 8. Total Agent Cap Is Now Enforced

Claude's context dump states a total lifetime cap of 1000 agents. The runner now exposes `--max-agents`, defaults it to 1000, shares the cap across nested workflows, and persists cap status in `workflow.json`.

Remaining caveat: this is a runner-level backstop, not exact Claude lifecycle parity.

### 9. Static Inspect Is Too Lightweight

The runner's `inspect` uses string/comment stripping plus regex counts. It successfully parsed all 53 Bun workflow files, but it undercounted important dynamic scripts. Example: `phase-a-port.workflow.js` was reported as `agentCalls: 0`, even though it has three `agent()` stages inside a `pipeline()`. Nested template literals appear to confuse the scanner.

Claude's permission preview is also static, but the captured contract suggests it detects agents, parallel groups, loops, and prompt previews for the user's approval flow. The runner's current estimate is useful as a smoke check, not a strong permission preview.

Severity: medium.

## Performance Comparison

### Where The Runner Is Good

- `pipeline()` avoids unnecessary barriers, matching Claude's primary latency optimization.
- `parallel()` and `pipeline()` both compose with a global semaphore, so scripts can enqueue large fan-outs without launching all child processes at once.
- The default `--max-concurrency` matches Claude's stated `min(16, cpu cores - 2)`.
- Atomic snapshot writes and journal append are simple and durable.
- Worker-thread VM prevents workflow script CPU from blocking the parent forever, using a 1000 ms sync-yield watchdog.

### Where It Lags Claude

- Each `agent()` spawns a fresh `codex exec` process. Claude's native Workflow runs inside its own Agent SDK harness and likely has lower per-agent startup overhead.
- Child `codex exec` may fail in nested/sandboxed contexts before model work, as the skill already documents.
- No native prompt-cache lifecycle comparable to the Claude dump's cache-aware scheduling guidance.
- No exact token accounting, so `budget.remaining()` is only a rough throttle.
- No integrated custom subagent types, which can make child agents heavier than necessary.
- Worktree isolation is patch-based and still requires a parent/integrator to inspect and apply captured changes.

For read-only assessment workflows, this may be acceptable. For Bun-scale migration workflows that involve broad mutation, repeated compile gates, and dozens of agents, it is materially below Claude's ergonomics and safety envelope.

## Quality Comparison

### Skill Quality

The skill's *orchestrator instructions* are high quality. They encode the right mental model and should produce better workflows than a naive "parallel agents then summarize" approach.

Especially strong:

- It asks for unit of work, truth source, independent work, serialized work, gate, and failure shape before authoring.
- It emphasizes "refute before mutate".
- It warns against treating `inspect.estimatedAgents` as authoritative.
- It clearly distinguishes mock from real delegation.

### Runtime Quality

The runtime is compact and readable, but it has product-grade gaps:

- It rejects `agentType` rather than pretending to execute custom Claude subagents.
- It implements `isolation: "worktree"` as temporary git worktrees with captured patch/status artifacts, but not automatic merge/apply.
- It does not have robust JS static analysis for preview.
- It enforces a configurable lifetime agent cap that defaults to 1000.
- It cannot execute Bun scripts that use `Math.random()` or argless `new Date()` unless those scripts are rewritten or the runner gets a compatibility mode.
- It depends on `codex exec --output-schema` behavior for structured output quality, rather than Claude's native StructuredOutput tool and retry loop.

### Output Quality Risk

The biggest quality risk is not syntax. It is child-agent behavior.

Claude's Workflow tool can select custom agent types and append structured-output instructions within the same harness. The runner passes a raw prompt to `codex exec`; schema is enforced via CLI output schema, but the child does not receive the same Claude workflow-specific return-value framing unless the workflow author includes it in the prompt.

That can lead to children writing human-style summaries where the parent expects raw data, over-reading because `Explore` is not real, or missing MCP tools that Claude would expose.

## Bun PR Compatibility Notes

The runner can statically inspect the Bun workflow files, but it is not a drop-in executor for all of them.

Observed compatibility issues:

- `lifetime-classify.workflow.js` uses `Math.random()`, blocked by the runner.
- `phase-h-idioms-audit.workflow.js` uses argless `new Date()`, blocked by the runner.
- Several workflows depend on worktree-like isolation or manual external worktrees.
- Some scripts assume Claude-specific tools in child prompts (`Read`, `Grep`, `Glob`, `Edit`, `Write`) and Claude-specific behavior around final return values.
- `phase-a-port.workflow.js` demonstrates static-inspector undercounting.

The Bun workflows are still extremely useful as design references. They validate the skill's workflow-shape guidance. But compatibility should be described as "inspired by Claude/Bun workflow patterns", not "runs arbitrary Claude workflows unchanged."

## Recommended Roadmap

### P0: Close Misleading Semantics

Status: implemented in the current patch except full custom `agentType` behavior and full AST inspection.

1. Implement or reject `agentType`.
   - Current patch: fail fast when `opts.agentType` is set, instead of treating it as metadata.
   - Future best: map `agentType` to Codex subagent/tool profiles where available.

2. Implement real `isolation: "worktree"` for mutating agents.
   - Current patch: require the parent git worktree to be clean outside the runner's own output directory.
   - Current patch: create a temporary git worktree.
   - Current patch: run child in that worktree.
   - Current patch: capture diff/patch and status metadata.
   - Current patch: require parent/integrator to apply or merge.
   - Current patch: auto-clean unchanged worktrees.

3. Add a 1000-agent lifetime cap.
   - Current patch: configurable via `--max-agents`, defaulting to Claude's documented cap.
   - Current patch: cap status is included in `workflow.json`.

4. Strengthen static `inspect`.
   - Current patch: improves call detection through template expressions.
   - Current patch: detects `agent()` inside `map`, `parallel`, `pipeline`, and loops as dynamic lower-bound signals.
   - Current patch: flags deterministic violations and unsupported `agentType`/isolation modes before run.
   - Future best: replace the scanner with a full AST parser such as Acorn, Meriyah, or Babel.

### P1: Improve Claude Workflow Compatibility

5. Add named workflow registry resolution.
   - Search `.claude/workflows`, `.codex-workflows/authored`, and skill templates.
   - Support `run --name <workflow>` and `workflow("name", args)`.
   - Surface `meta.whenToUse`.

6. Add `run --script <inline>` or stdin script support.
   - Claude's Workflow accepts inline scripts and persists them.
   - The runner can support `run -` and store the exact script copy.

7. Add a `watch` or live summary command.
   - Tail `workflow.json`.
   - Show phase/agent status, failures, cache hits, and token estimates.

8. Parse child Codex JSONL for real usage.
   - Count tool calls.
   - Extract model, duration, errors, and token usage if present.
   - Replace char/4 budget accounting where possible.

9. Add compatibility linting.
   - Flag `Math.random()`, argless `new Date()`, `Date.now()`.
   - Flag `agentType` and `isolation` when unsupported.
   - Flag named `workflow()` calls that cannot resolve.
   - Flag code that likely depends on Claude-only tools.

### P2: Improve Workflow Authoring Quality

10. Add templates for common Bun/Claude patterns, not only throughput.
    - `review-verify-synthesize`
    - `fix-reverify`
    - `probe-dedup-fix-repeat`
    - `shard-crossref-vote-apply-gate`
    - `panel-judge-docs`

11. Add a child-agent system preamble.
    - Tell child Codex agents their final output is a return value.
    - Emphasize schema adherence and citation requirements.
    - Mirror Claude's workflow-agent conventions as much as Codex allows.

12. Build a regression corpus from local and Bun workflows.
    - Parse all 53 Bun PR scripts.
    - Execute small mock runs for representative families.
    - Add expected inspect counts or at least expected warnings.
    - Add real read-only smoke tests with 2-3 children.

## Bottom Line

The skill is **conceptually at Claude workflow level** in how it teaches decomposition, verification, and control loops.

The runner is **not operationally at Claude workflow level**. It is missing several first-class Workflow tool capabilities and still lacks custom subagent behavior, named workflow registry resolution, exact telemetry, and native UI.

The right positioning is:

> A Codex-native clean-room workflow runner that can author and execute Claude-style orchestration patterns, suitable for experimentation and controlled read-only/review workflows, with partial support for mutation workflows when manually serialized.

The wrong positioning would be:

> A drop-in replacement for Claude Code workflows.

It can get much closer with custom agent semantics, named workflow registry, AST inspection, automatic worktree patch application/merge support, exact child telemetry, and a live progress/watch layer.
