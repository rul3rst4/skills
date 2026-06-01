# Codex Workflow Runner Parity Analysis

This document compares the Codex Workflow Runner (`scripts/codex_workflow_runner.mjs`) against its direct basis, the Pi extension [`pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows), and the shared ancestor that inspired both, Anthropic's dynamic workflows in Claude Code.

## Architecture: same script contract, different subagent substrate

All three systems share one idea: instead of one assistant doing everything sequentially, a small JavaScript script fans work out to isolated subagents and synthesizes the results. They diverge on how the script is invoked and how each subagent actually runs.

- **Claude Code (inspiration):** dynamic workflows authored and run inside the Claude Code agent; subagents are framed so their final message is consumed as a return value, and structured results come from a `StructuredOutput` tool.
- **pi-dynamic-workflows (basis):** a Pi extension that registers a single `workflow` tool. The model writes a script; the tool parses it (acorn AST) and runs it in a Node `vm` sandbox. Each `agent()` spawns an **in-memory Pi session** (`WorkflowAgent` in `src/agent.ts`) via `createAgentSession`, with full coding tools, in the same process. Structured output uses a terminating Pi `structured_output` tool. Live progress streams inline (`src/display.ts`, `workflow-tool.ts`).
- **This Codex runner (the subject):** a **skill**, not an in-app tool. It is a standalone Node `.mjs` CLI (`inspect`/`run`/`template`/`summarize`). The script body still runs in a Node `vm`, but that VM lives in a `worker_thread`, and each `agent()` is delegated to a **child `codex exec` process** (`runChildCodex`) rather than an in-memory session. Structured output is requested through `codex exec --output-schema`. There is no live UI; progress is persisted to `workflow.json` and a JSONL journal for resumable, terminal/CI execution.

The host/worker split (`runWorkflowBodyInWorker` ↔ `runWorkflowVmWorker`) exists because subagent calls are out-of-process: the worker bridges `agent()`/`workflow()` calls back to the host over `postMessage`, while `phase`/`log`/`budget` are mirrored.

## Feature comparison

| Capability | This Codex runner | pi-dynamic-workflows | Claude Code |
| --- | --- | --- | --- |
| Script parsing | acorn AST: `parseWorkflowScript`/`evaluateLiteral`/`validateMeta` + AST-walk `inspectScript` | acorn AST in `src/workflow.ts` (same shape) | internal dynamic-workflow runtime |
| Subagent substrate | child `codex exec` process per `agent()` | in-memory Pi session per `agent()` | in-app Claude subagent |
| DSL globals | `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `args`, `budget` | same set | conceptually similar |
| Working-dir globals | `cwd` + frozen `process` shim exposing only `cwd()` | `cwd` + `process.cwd()` shim | n/a (runs in agent cwd) |
| Structured output | `codex exec --output-schema`; parsed via `parseJsonOutput` then checked by `validateAgainstSchema`; non-conforming output fails the agent | `structured_output` tool, `terminate: true`, TypeBox/JSON Schema validated | `StructuredOutput` tool |
| Subagent return-value contract | `buildChildPrompt` frames the final message as the programmatic return value (schema vs text variants) | `WorkflowAgent.buildPrompt` "final action MUST be structured_output" | "final message is a return value" framing |
| parallel / pipeline / phase | yes; failed branches → `null` (same semantics) | yes; identical semantics | yes |
| Persistence + journal + resume | **yes**: atomic `workflow.json` snapshots, append-only `journal.jsonl`, `--resume`, journal-cached `agent()`/`workflow()` (read-only runs only) | **no** (README: prototype, not resumable) | n/a |
| Worktree isolation | **patch-based**: `isolation:'worktree'` creates a detached git worktree, runs the child there, captures `.worktree.patch`/`.json`, keeps changed / removes unchanged | recognized in types but not a process-isolated implementation | n/a |
| `workflow()` composition | yes, **one nesting level**, journal-cached, shared budget/agent-limit | (composition not a documented primitive) | n/a |
| `agentType` | **rejected** (fails fast in `validateAgentOptions`; flagged statically) | accepted, injected into subagent instructions | agent-type concept exists |
| MCP / tool bridging | none; child inherits Codex's own tools/sandbox (`tools`/`instructions` agent options are rejected, not silently dropped) | subagent gets full Pi coding tools in-process | full Claude tool surface |
| Lifetime agent cap | `--max-agents` (`createAgentLimitTracker`), default 1000; counts cached replays | per-call concurrency limiter only | n/a |
| Live UI | **absent** (snapshots/journal only) | inline streaming progress + Esc-to-abort | in-app rendering |

## What this refactor changed

- **AST parser replaces the prior regex/string-masking scanner.** `parseWorkflowScript`, `evaluateLiteral`, and `validateMeta` are now equivalent to Pi's `src/workflow.ts`, and `inspectScript` walks the acorn AST instead of scanning text. This fixes the old scanner's **nested-template-literal undercount**: `agent()` calls inside template literals (and inside `pipeline`/`parallel`/`.map()`/loops) are now counted, with `estimatedAgents` explicitly treated as a lower bound under fan-out. A regression test (`tests/parser.test.mjs`) covers an `agent()` whose prompt contains a nested fenced code block. Determinism checks now key off real AST `CallExpression`/`NewExpression` nodes, so a string mentioning a non-deterministic call no longer false-flags, and `new Date(args.ts)` is allowed while an argless `Date` construction is not.
- **`buildChildPrompt` return-value framing.** Every child `codex exec` invocation is wrapped with an explicit contract that its final message is consumed programmatically (raw-JSON-only for schema agents, self-contained text otherwise), porting Pi's structured-output discipline and Claude's return-value framing to Codex's `--output-schema` mechanism. Worktree children get an additional isolation preamble.
- **Schema validation of child output.** `--output-schema` only guides the model, so `runChildCodex` now validates the parsed object with `validateAgainstSchema` (type, `enum`/`const`, `required`, `additionalProperties:false`, nested `properties`/`items`) and fails the agent on a mismatch. Inside `parallel()`/`pipeline()` this degrades to `null` and is logged, matching the failure contract; a bare schema agent surfaces the error. This restores the validation guarantee Pi gets from TypeBox.
- **Working-dir globals threaded through the worker.** `cwd` (the `--workspace` value) and a frozen `process` shim exposing only `cwd()` are injected into the VM context (`makeVmContext`, `__workflowCwd`), matching Pi's `cwd`/`process.cwd()` globals.
- **`whenToUse` meta support** added to `validateMeta` (optional string) and surfaced in the run snapshot — matching Pi's `WorkflowMeta.whenToUse`.
- **Option hygiene.** `agentType`, and now per-agent `tools`/`instructions` (which Pi supports in-process but Codex cannot bridge), are rejected with clear errors instead of being silently dropped. `--sandbox` is allowlist-checked at CLI parse time.
- **Entry guard + exports + tests.** The module no longer runs the CLI on import: it exports `parseWorkflowScript`, `inspectScript`, `buildChildPrompt`, `evaluateLiteral`, `validateMeta`, `validateAgainstSchema`, guards `main()` behind an `invokedDirectly` check (`process.argv[1] === fileURLToPath(import.meta.url)`), and keeps the worker-mode branch separate. New unit tests exercise the parser, inspector, schema validator, and prompt builder.

## Gaps that remain

- **No live progress UI.** Pi streams inline phase/agent status with abort-on-Esc; this runner only writes `workflow.json` + `journal.jsonl`. Acceptable for a terminal/CI skill, but there is no interactive cancel and no streaming render.
- **No in-process tool/MCP bridge.** Because subagents are separate `codex exec` processes, the runner cannot hand workflow-specific tools to children the way Pi injects `createCodingTools`; children get only Codex's own sandboxed surface. Nested `codex exec` can also fail to initialize inside an over-restricted parent sandbox.
- **`agentType` is unsupported by design.** Pi maps `agentType` into subagent instructions; here it fails fast so scripts do not silently fall back to generic behavior. A deliberate non-parity, not a bug.
- **Per-agent process cold-start cost.** Spawning a fresh `codex exec` per `agent()` is heavier than Pi's in-memory sessions; concurrency is capped (`min(16, cpu-2)`) and budget/token accounting is approximate (`estimateTokens` ≈ chars/4), as in Pi — a guardrail, not real usage.
- **Schema validation checks shape, not substance.** The runner enforces the JSON Schema (and fails non-conforming agents) but cannot force the model to produce correct or complete *content*; treat structured output as well-shaped, not necessarily correct, and keep a verification phase.
- **`workflow()` nesting is capped at one level.**

## Design-pattern guidance (external inspiration)

The orchestration shapes the runner encourages are derived from the workflow scripts in [Bun PR #30412's `.claude/workflows`](https://github.com/oven-sh/bun/pull/30412) and remain the recommended patterns:

- **Assess → Verify → Synthesize:** fan out independent read-only lenses, refute candidates with skeptical verifiers, then synthesize a ranked plan (the `template throughput` shape).
- **Probe loops:** `Probe → Dedup Failures → Fix → Repeat`, gated on executable commands, when the system itself reveals the next failure — bounded by `MAX_ROUNDS` and a success predicate encoded in the script.
- **Shard → Cross-ref → Multi-vote → Apply:** shard discovery, cluster/cross-reference, vote to resolve noisy judgments, then serialize mutation behind one compile/git gate.
- **Bounded repair:** every repeated loop sets explicit stop rules (`MAX_ROUNDS`, max candidates, success condition, and a defined blocked-return shape); keep mutation phases serialized or file-disjoint and broad discovery phases parallel or pipelined.

`inspect` is a static preview only; the authoritative agent count is `workflow.json.agentCount` after a real (non-mock) run, since `estimatedAgents` is a lower bound under data-dependent fan-out.
