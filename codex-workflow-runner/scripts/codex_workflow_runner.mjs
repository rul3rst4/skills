#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { parse as parseAcorn } from './vendor/acorn.mjs'

const VERSION = '0.3.0'
const DEFAULT_OUT = '.codex-workflows'
const WORKFLOW_SYNC_TIMEOUT_MS = 1000

function usage() {
  return `codex_workflow_runner ${VERSION}

Usage:
  node codex_workflow_runner.mjs inspect <workflow.js> [--json]
  node codex_workflow_runner.mjs template throughput [options]
  node codex_workflow_runner.mjs run [workflow.js] [options]
  node codex_workflow_runner.mjs summarize <run-dir> [--json]

Template options:
  --objective <text>        Goal embedded in the generated workflow
  --target <path>           App/repo path embedded in prompts (default: .)
  --name <slug>             Workflow meta.name (default: app-throughput-improvement)
  --lenses <csv>            Throughput lenses; overrides the default set
  --max-verify <n>          Max findings to verify before synthesis (default: 8)
  --output <file>           Write generated workflow.js to this path

Run options:
  --workspace <dir>          Child Codex working directory (default: cwd)
  --out <dir>                Output root for new runs (default: .codex-workflows)
  --resume <run-dir>         Resume an existing run directory
  --args <json>              JSON value exposed as global args
  --args-file <file>         JSON file exposed as global args
  --run-id <wf_id>           Explicit run id for new runs
  --sandbox <mode>           Child Codex sandbox (default: read-only)
  --codex-bin <path>         Codex binary (default: codex)
  --child-model <model>      Model passed to child codex exec
  --max-concurrency <n>      Agent concurrency cap (default: min(16, cpu-2))
  --max-agents <n>           Total lifetime agent cap (default: 1000)
  --budget-tokens <n>        Approximate budget exposed via budget.total
  --mock-agent               Return deterministic fake agent results
  -h, --help                 Show this help
  --json                     Print machine-readable JSON
`
}

function parseCli(argv) {
  const args = [...argv]
  const command = args.shift()
  const positional = []
  const opts = {}
  const needsValue = new Set([
    'workspace',
    'out',
    'resume',
    'args',
    'args-file',
    'run-id',
    'sandbox',
    'codex-bin',
    'child-model',
    'max-concurrency',
    'max-agents',
    'budget-tokens',
    'objective',
    'target',
    'name',
    'lenses',
    'max-verify',
    'output',
  ])
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const raw = token.slice(2)
    const eq = raw.indexOf('=')
    const key = eq >= 0 ? raw.slice(0, eq) : raw
    if (needsValue.has(key)) {
      const value = eq >= 0 ? raw.slice(eq + 1) : args[++i]
      if (value === undefined) throw new Error(`Missing value for --${key}`)
      opts[key] = value
    } else {
      opts[key] = true
    }
  }
  return { command, positional, opts }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function makeRunId() {
  return `wf_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function makeTaskId() {
  return crypto.randomBytes(5).toString('base64url').toLowerCase()
}

function makeAgentId() {
  return `a${crypto.randomBytes(8).toString('hex')}`
}

function slugify(value) {
  return String(value || 'workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workflow'
}

function jsLiteral(value) {
  return JSON.stringify(value, null, 2)
}

function parseLensList(value) {
  if (!value) return null
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, ...focusParts] = item.split(':')
      const normalizedKey = slugify(key).replaceAll('-', '_') || 'lens'
      return {
        key: normalizedKey,
        title: key.trim(),
        focus: focusParts.join(':').trim() || `Find throughput bottlenecks related to ${key.trim()}.`,
      }
    })
}

function readMaxVerify(value) {
  if (value === undefined) return 8
  const maxVerify = Number(value)
  if (!Number.isInteger(maxVerify) || maxVerify < 1) {
    throw new Error('--max-verify must be a finite positive integer')
  }
  return maxVerify
}

function throughputTemplate(opts = {}) {
  const objective = opts.objective || 'Increase application throughput by finding, verifying, and prioritizing the highest-leverage bottlenecks.'
  const target = opts.target || '.'
  const name = slugify(opts.name || 'app-throughput-improvement')
  const maxVerify = readMaxVerify(opts.maxVerify)
  const lenses = opts.lenses || [
    {
      key: 'runtime_hot_paths',
      title: 'Runtime hot paths',
      focus: 'CPU-bound loops, repeated work, blocking calls, memory churn, serialization, and request/worker hot paths.',
    },
    {
      key: 'data_access',
      title: 'Data access',
      focus: 'Queries, indexing assumptions, N+1 access, cache boundaries, file/database reads, pagination, and batching.',
    },
    {
      key: 'concurrency_io',
      title: 'Concurrency and I/O',
      focus: 'Await patterns, queueing, locks, synchronous I/O, network calls, retries, backpressure, and worker parallelism.',
    },
    {
      key: 'frontend_delivery',
      title: 'Frontend and delivery',
      focus: 'Bundle size, render work, API waterfalls, caching headers, static assets, hydration, and client-side bottlenecks.',
    },
    {
      key: 'observability_tests',
      title: 'Observability and tests',
      focus: 'Existing benchmarks, telemetry, reproducible load paths, missing perf tests, and low-risk verification commands.',
    },
  ]

  return `export const meta = {
  name: ${jsLiteral(name)},
  description: ${jsLiteral(objective)},
  phases: [
    { title: 'Assess', detail: 'independent throughput lenses' },
    { title: 'Verify', detail: 'skeptical validation of candidate bottlenecks' },
    { title: 'Synthesize', detail: 'ranked implementation plan' },
  ],
}

const TARGET = ${jsLiteral(target)}
const OBJECTIVE = ${jsLiteral(objective)}
const MAX_VERIFY = ${jsLiteral(maxVerify)}
const LENSES = ${jsLiteral(lenses)}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'summary', 'findings'],
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'location', 'evidence', 'impact', 'fix', 'confidence'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          fix: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'isReal', 'severity', 'reasoning', 'refinedFix'],
  properties: {
    id: { type: 'string' },
    isReal: { type: 'boolean' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    reasoning: { type: 'string' },
    refinedFix: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'priorities', 'implementationOrder', 'verificationPlan', 'risks'],
  properties: {
    summary: { type: 'string' },
    priorities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'whyNow', 'expectedThroughputImpact', 'effort', 'firstFiles'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          whyNow: { type: 'string' },
          expectedThroughputImpact: { type: 'string' },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
          firstFiles: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    implementationOrder: { type: 'array', items: { type: 'string' } },
    verificationPlan: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

phase('Assess')
log(\`Assessing \${TARGET} with \${LENSES.length} throughput lenses\`)

const assessments = await pipeline(
  LENSES,
  (lens) => agent(
    \`You are one specialist in a Codex-orchestrated throughput workflow.

Goal: \${OBJECTIVE}
Target app/repo path: \${TARGET}

Lens: \${lens.title}
Focus: \${lens.focus}

Work read-only. Inspect the repository directly. Find concrete throughput bottlenecks or prove that this lens has no strong candidate. Prefer evidence with file paths, functions, commands, benchmarks, request paths, or data-flow explanations. Do not invent metrics. Return at most 4 findings.\`,
    { label: \`assess:\${lens.key}\`, phase: 'Assess', schema: FINDINGS_SCHEMA }
  )
)

const failedAssessments = assessments
  .map((result, index) => result ? null : LENSES[index].key)
  .filter(Boolean)
if (failedAssessments.length) {
  throw new Error('Assessment agents failed: ' + failedAssessments.join(', '))
}

const candidates = assessments
  .filter(Boolean)
  .flatMap((result) => (result.findings || []).map((finding) => ({ ...finding, lens: result.lens })))
  .slice(0, MAX_VERIFY)

phase('Verify')
const verified = await pipeline(
  candidates,
  (finding) => agent(
    \`Independently verify this throughput finding. Be skeptical and try to refute it.

Target app/repo path: \${TARGET}
Finding:
\${JSON.stringify(finding, null, 2)}

Check the cited files and nearby code. Mark isReal=false if the evidence is weak, stale, duplicated, already solved, or not meaningfully throughput-related. If real, refine the safest fix and name useful verification commands.\`,
    { label: \`verify:\${finding.id}\`, phase: 'Verify', schema: VERDICT_SCHEMA }
  )
)

const failedVerifications = verified
  .map((result, index) => result ? null : candidates[index]?.id || 'candidate-' + index)
  .filter(Boolean)
if (failedVerifications.length) {
  throw new Error('Verification agents failed: ' + failedVerifications.join(', '))
}

phase('Synthesize')
const plan = await agent(
  \`You are the synthesis lead for a Codex throughput workflow.

Goal: \${OBJECTIVE}
Target app/repo path: \${TARGET}

Assessments:
\${JSON.stringify(assessments, null, 2)}

Verifier results:
\${JSON.stringify(verified, null, 2)}

Write a ranked, implementable throughput plan. Keep only verified or strongly evidenced work. Prefer small high-leverage changes first. Include verification commands that the parent Codex orchestrator can run after edits.\`,
  { label: 'synthesize:throughput-plan', phase: 'Synthesize', schema: PLAN_SCHEMA }
)

return { assessments, verified, plan }
`
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// ---------------------------------------------------------------------------
// Workflow script parsing and static inspection (AST-based, via vendored acorn).
//
// Adapted from earendil-works/pi-dynamic-workflows (src/workflow.ts), which is
// itself a clean-room take on Claude Code dynamic workflows. The Pi extension
// runs subagents as in-memory sessions; this Codex runner delegates to child
// `codex exec` processes, but shares the same deterministic, AST-validated
// script contract: a literal `export const meta = {...}` header followed by a
// plain-JS body that calls agent()/parallel()/pipeline()/phase()/log()/workflow().
// ---------------------------------------------------------------------------

function parseToAst(text) {
  return parseAcorn(text, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  })
}

function isAstNode(value) {
  return !!value && typeof value === 'object' && typeof value.type === 'string'
}

function astChildren(node) {
  const children = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) children.push(item)
    } else if (isAstNode(value)) {
      children.push(value)
    }
  }
  return children
}

function propertyNameOf(node) {
  if (!node) return undefined
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name
  return staticStringOf(node.property)
}

function staticStringOf(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringOf(node.left)
    const right = staticStringOf(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function isMemberCall(node, objectName, propertyName) {
  if (node?.type !== 'MemberExpression' || node.object?.type !== 'Identifier' || node.object.name !== objectName) {
    return false
  }
  return propertyNameOf(node) === propertyName
}

// Determinism rules, matching the Pi extension's intent and this runner's
// VM-level guards. `Date.now()`, `Math.random()`, and argless `new Date()` /
// `Date()` are non-deterministic. `new Date(args.timestamp)` is allowed so
// scripts can still work with explicit timestamps threaded through `args`.
function isArglessDateConstruction(node) {
  const callee = node.callee
  if (callee?.type !== 'Identifier' || callee.name !== 'Date') return false
  if (node.type !== 'NewExpression' && node.type !== 'CallExpression') return false
  return (node.arguments || []).length === 0
}

function collectDeterminismWarnings(ast) {
  const warnings = new Set()
  const walk = (node) => {
    if (node.type === 'CallExpression' && isMemberCall(node.callee, 'Date', 'now')) {
      warnings.add('Date.now() is disabled in workflow scripts; pass timestamps via args.')
    } else if (node.type === 'CallExpression' && isMemberCall(node.callee, 'Math', 'random')) {
      warnings.add('Math.random() is disabled in workflow scripts; vary prompts by index or args instead.')
    } else if (isArglessDateConstruction(node)) {
      warnings.add('Argless Date is disabled in workflow scripts; pass timestamps via args.')
    }
    for (const child of astChildren(node)) walk(child)
  }
  walk(ast)
  return [...warnings]
}

function parseWorkflowScript(text) {
  let ast
  try {
    ast = parseToAst(text)
  } catch (error) {
    throw new Error(`Workflow script is not valid JavaScript: ${error.message}`)
  }
  const first = ast.body?.[0]
  if (!first || first.type !== 'ExportNamedDeclaration') {
    throw new Error('Workflow script must begin with export const meta = {...}')
  }
  const declaration = first.declaration
  if (!declaration || declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
    throw new Error('meta export must be `export const meta = ...`')
  }
  if (declaration.declarations.length !== 1) {
    throw new Error('meta export must declare only `meta`')
  }
  const declarator = declaration.declarations[0]
  if (declarator.id?.type !== 'Identifier' || declarator.id.name !== 'meta') {
    throw new Error('meta export must declare `meta`')
  }
  if (!declarator.init) throw new Error('meta must have a literal value')
  const meta = evaluateLiteral(declarator.init, 'meta')
  validateMeta(meta)
  const scriptBody = text.slice(0, first.start) + text.slice(first.end)
  return { meta, scriptBody, ast }
}

function evaluateLiteral(node, path) {
  switch (node.type) {
    case 'ObjectExpression': {
      const out = {}
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') throw new Error(`spread not allowed in ${path}`)
        if (prop.type !== 'Property') throw new Error(`only plain properties allowed in ${path}`)
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`)
        if (prop.kind !== 'init' || prop.method) throw new Error(`methods/accessors not allowed in ${path}`)
        const key = propertyKey(prop.key, path)
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`)
        }
        out[key] = evaluateLiteral(prop.value, `${path}.${key}`)
      }
      return out
    }
    case 'ArrayExpression':
      return node.elements.map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`)
        if (element.type === 'SpreadElement') throw new Error(`spread not allowed in ${path}`)
        return evaluateLiteral(element, `${path}[${index}]`)
      })
    case 'Literal':
      return node.value
    case 'TemplateLiteral':
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`)
      return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value
      }
      throw new Error(`only negative-number unary allowed in ${path}`)
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type} (meta must be a pure object literal)`)
  }
}

function propertyKey(node, path) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) {
    return String(node.value)
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`)
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('meta must be an object')
  if (typeof meta.name !== 'string' || !meta.name.trim()) throw new Error('meta.name must be a non-empty string')
  if (typeof meta.description !== 'string' || !meta.description.trim()) {
    throw new Error('meta.description must be a non-empty string')
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') {
    throw new Error('meta.whenToUse must be a string')
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new Error('meta.phases must be an array')
    for (const phase of meta.phases) {
      if (!phase || typeof phase !== 'object' || typeof phase.title !== 'string') {
        throw new Error('each meta phase must have a title string')
      }
    }
  }
  return meta
}

function objectExpressionStringProp(objNode, name) {
  if (!objNode || objNode.type !== 'ObjectExpression') return { present: false, value: undefined }
  for (const prop of objNode.properties) {
    if (prop.type !== 'Property' || prop.computed) continue
    let key
    if (prop.key?.type === 'Identifier') key = prop.key.name
    else if (prop.key?.type === 'Literal') key = String(prop.key.value)
    if (key === name) return { present: true, value: staticStringOf(prop.value) }
  }
  return { present: false, value: undefined }
}

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
])

// Static preview, like the Pi tool's parser plus Claude Code's permission
// preview. The AST walk fixes the old regex scanner's blind spots: agent()
// calls inside nested template literals are now counted, and fan-out contexts
// (loops, .map(), parallel(), pipeline()) mark the estimate as a lower bound.
function inspectScript(text) {
  const { meta, ast } = parseWorkflowScript(text)
  let agentCalls = 0
  let dynamicAgentCalls = 0
  let parallelCalls = 0
  let pipelineCalls = 0
  let mapCalls = 0
  let loopCalls = 0
  let agentsWithAgentType = 0
  let agentsWithWorktreeIsolation = 0
  const unsupportedIsolation = []
  let hasReturn = false

  const walk = (node, inDynamic) => {
    if (node.type === 'ReturnStatement') hasReturn = true
    let opensDynamicScope = false

    if (LOOP_TYPES.has(node.type)) {
      loopCalls++
      opensDynamicScope = true
    }

    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (callee?.type === 'Identifier' && callee.name === 'agent') {
        agentCalls++
        if (inDynamic) dynamicAgentCalls++
        const opts = node.arguments?.[1]
        if (objectExpressionStringProp(opts, 'agentType').present) agentsWithAgentType++
        const isolation = objectExpressionStringProp(opts, 'isolation')
        if (isolation.present) {
          if (isolation.value === 'worktree') agentsWithWorktreeIsolation++
          else if (isolation.value && isolation.value !== 'shared') unsupportedIsolation.push(isolation.value)
        }
      } else if (callee?.type === 'Identifier' && callee.name === 'parallel') {
        parallelCalls++
        opensDynamicScope = true
      } else if (callee?.type === 'Identifier' && callee.name === 'pipeline') {
        pipelineCalls++
        opensDynamicScope = true
      } else if (callee?.type === 'MemberExpression' && propertyNameOf(callee) === 'map') {
        mapCalls++
        opensDynamicScope = true
      }
    }

    const childDynamic = inDynamic || opensDynamicScope
    for (const child of astChildren(node)) walk(child, childDynamic)
  }
  walk(ast, false)

  const warnings = [
    ...collectDeterminismWarnings(ast),
    ...Array.from({ length: agentsWithAgentType }, () =>
      'agentType is not supported by this runner and will fail fast at runtime.'),
    ...unsupportedIsolation.map((isolation) => `Unsupported agent isolation mode detected statically: ${isolation}`),
  ]
  const estimatedAgents = dynamicAgentCalls > 0
    ? Math.max(agentCalls + dynamicAgentCalls * 2, agentCalls)
    : agentCalls

  return {
    meta,
    phases: Array.isArray(meta.phases) ? meta.phases : [],
    scan: {
      agentCalls,
      parallelCalls,
      pipelineCalls,
      loopCalls,
      mapCalls,
      dynamicAgentCalls,
      agentsWithAgentType,
      agentsWithWorktreeIsolation,
      unsupportedIsolationCalls: unsupportedIsolation.length,
      estimatedAgents,
      hasReturn,
      warnings,
    },
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1)
    this.active = 0
    this.queue = []
  }

  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

class Journal {
  constructor(filePath) {
    this.filePath = filePath
    this.results = new Map()
  }

  async load() {
    if (!(await pathExists(this.filePath))) return
    const text = await fs.readFile(this.filePath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.type === 'result') this.results.set(event.key, event)
    }
  }

  get(key) {
    return this.results.get(key)
  }

  async append(event) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`)
    if (event.type === 'result') this.results.set(event.key, event)
  }
}

async function readArgs(opts) {
  if (opts['args-file']) {
    return JSON.parse(await fs.readFile(path.resolve(opts['args-file']), 'utf8'))
  }
  if (opts.args !== undefined) return JSON.parse(opts.args)
  return undefined
}

function readBudgetTokens(opts, fallback = null) {
  if (opts['budget-tokens'] === undefined) return fallback
  const budgetTokens = Number(opts['budget-tokens'])
  if (!Number.isFinite(budgetTokens) || budgetTokens < 0) {
    throw new Error('--budget-tokens must be a finite non-negative number')
  }
  return budgetTokens
}

function readMaxAgents(opts, fallback = 1000) {
  if (opts['max-agents'] === undefined) return fallback
  const maxAgents = Number(opts['max-agents'])
  if (!Number.isInteger(maxAgents) || maxAgents < 0) {
    throw new Error('--max-agents must be a finite non-negative integer')
  }
  return maxAgents
}

function createBudgetTracker(total) {
  let spent = 0
  let reserved = 0
  return {
    total,
    spent: () => spent,
    remaining: () => (total == null ? Infinity : Math.max(0, total - spent - reserved)),
    reserve(amount) {
      const value = Number(amount) || 0
      if (total != null && spent + reserved + value > total) return false
      reserved += value
      return true
    },
    release(amount) {
      reserved = Math.max(0, reserved - (Number(amount) || 0))
    },
    commit(amount) {
      spent += Number(amount) || 0
    },
  }
}

function createAgentLimitTracker(limit, initialUsed = 0, initialReached = false) {
  const normalizedLimit = Number.isInteger(limit) && limit >= 0 ? limit : 1000
  let used = Math.max(0, Math.min(Number(initialUsed) || 0, normalizedLimit))
  let reached = Boolean(initialReached)
  return {
    limit: normalizedLimit,
    used: () => used,
    remaining: () => Math.max(0, normalizedLimit - used),
    reached: () => reached,
    snapshot() {
      return {
        limit: normalizedLimit,
        used,
        remaining: Math.max(0, normalizedLimit - used),
        reached,
      }
    },
    tryUse() {
      if (used >= normalizedLimit) {
        reached = true
        return false
      }
      used++
      return true
    },
  }
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack,
  }
}

function deserializeError(payload) {
  const error = new Error(payload?.message || 'Workflow worker failed')
  if (payload?.stack) error.stack = payload.stack
  return error
}

function createCachePathHelpers() {
  const cachePathStorage = new AsyncLocalStorage()
  const pathOrdinalCounts = new Map()
  const agentPathCounts = new Map()
  const workflowPathCounts = new Map()
  return {
    withCachePath(segment, fn) {
      const parentPath = cachePathStorage.getStore() || ['root']
      return cachePathStorage.run([...parentPath, String(segment)], fn)
    },
    enterCachePath(pathValue) {
      const parts = String(pathValue || 'root').split('/').filter(Boolean)
      cachePathStorage.enterWith(parts.length ? parts : ['root'])
    },
    getCachePath() {
      return (cachePathStorage.getStore() || ['root']).join('/')
    },
    nextPathOrdinal(kind) {
      const basePath = cachePathStorage.getStore() || ['root']
      const key = `${basePath.join('/')}/${kind}`
      const count = pathOrdinalCounts.get(key) || 0
      pathOrdinalCounts.set(key, count + 1)
      return count
    },
    nextAgentPath() {
      const basePath = cachePathStorage.getStore() || ['root']
      const base = basePath.join('/')
      const count = (agentPathCounts.get(base) || 0) + 1
      agentPathCounts.set(base, count)
      return `${base}/agent:${count}`
    },
    nextWorkflowPath() {
      const basePath = cachePathStorage.getStore() || ['root']
      const base = basePath.join('/')
      const count = (workflowPathCounts.get(base) || 0) + 1
      workflowPathCounts.set(base, count)
      return `${base}/workflow:${count}`
    },
  }
}

function runWorkflowBodyInWorker({ scriptPath, scriptBody, args, budgetTokens, cwd, agent, phase, log, workflow }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        mode: 'workflow-vm',
        scriptPath,
        scriptBody,
        args,
        budgetTokens,
        cwd,
      },
    })
    let settled = false
    let watchdog = null
    let pendingHostRequests = 0
    let pendingCompletionError = null

    function clearWatchdog() {
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
    }

    function armWatchdog() {
      clearWatchdog()
      watchdog = setTimeout(() => {
        const error = new Error(`Workflow script exceeded ${WORKFLOW_SYNC_TIMEOUT_MS}ms without yielding`)
        settled = true
        worker.terminate().finally(() => reject(error))
      }, WORKFLOW_SYNC_TIMEOUT_MS)
    }

    function finish(fn, value) {
      if (settled) return
      settled = true
      clearWatchdog()
      worker.terminate().finally(() => fn(value))
    }

    function rejectWhenRequestsDrain(error) {
      if (pendingHostRequests > 0) {
        pendingCompletionError = error
        clearWatchdog()
        return
      }
      finish(reject, error)
    }

    async function handleRequest(message) {
      pendingHostRequests++
      clearWatchdog()
      try {
        let value
        if (message.name === 'agent') {
          const [prompt, opts] = message.args
          const response = await agent.call(prompt, { ...(opts || {}), __returnMeta: true })
          value = {
            result: response.result,
            spentDelta: response.spentTokens,
          }
        } else if (message.name === 'workflow') {
          const [ref, childArgs, opts] = message.args
          const before = agent.spentTokens()
          const result = await workflow(ref, childArgs, opts || {})
          value = {
            result,
            spentDelta: agent.spentTokens() - before,
          }
        } else {
          throw new Error(`Unknown workflow worker request: ${message.name}`)
        }
        if (!settled) {
          worker.postMessage({ type: 'hostResponse', id: message.id, value })
        }
      } catch (error) {
        if (!settled) {
          worker.postMessage({ type: 'hostResponse', id: message.id, error: serializeError(error) })
        }
      } finally {
        pendingHostRequests--
        if (!settled && pendingHostRequests === 0) {
          if (pendingCompletionError) finish(reject, pendingCompletionError)
          else armWatchdog()
        }
      }
    }

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'hostRequest') {
        handleRequest(message)
        return
      }
      if (message.type === 'phase') {
        phase(message.title)
        return
      }
      if (message.type === 'log') {
        log(message.message)
        return
      }
      if (message.type === 'done') {
        if (pendingHostRequests > 0) {
          pendingCompletionError = new Error(`Workflow completed with ${pendingHostRequests} unawaited host request(s) still running`)
          clearWatchdog()
          return
        }
        finish(resolve, message.result)
        return
      }
      if (message.type === 'error') {
        rejectWhenRequestsDrain(deserializeError(message.error))
      }
    })
    worker.on('error', (error) => rejectWhenRequestsDrain(error))
    worker.on('exit', (code) => {
      if (!settled && code !== 0) rejectWhenRequestsDrain(new Error(`Workflow worker exited ${code}`))
    })
    armWatchdog()
  })
}

async function runWorkflowVmWorker() {
  const pending = new Map()
  let requestId = 0
  let spentTokens = 0
  let currentPhaseTitle = null
  const cachePaths = createCachePathHelpers()
  const budget = {
    total: workerData.budgetTokens ?? null,
    spent: () => spentTokens,
    remaining: () => (budget.total == null ? Infinity : Math.max(0, budget.total - spentTokens)),
  }

  parentPort.on('message', (message) => {
    if (!message || message.type !== 'hostResponse') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(deserializeError(message.error))
    else entry.resolve(message.value)
  })

  function callParent(name, requestArgs) {
    const id = ++requestId
    parentPort.postMessage({ type: 'hostRequest', id, name, args: requestArgs })
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  function phase(title) {
    currentPhaseTitle = title
    parentPort.postMessage({ type: 'phase', title })
  }

  function log(message) {
    parentPort.postMessage({ type: 'log', message: String(message) })
  }

  async function agent(prompt, opts = {}) {
    const requestOpts = { ...opts }
    if (requestOpts.phase === undefined && currentPhaseTitle) requestOpts.phase = currentPhaseTitle
    if (requestOpts.cacheKey === undefined) requestOpts.__callPath = cachePaths.nextAgentPath()
    const response = await callParent('agent', [prompt, requestOpts])
    spentTokens += Number(response?.spentDelta || 0)
    return response?.result
  }

  async function workflow(ref, childArgs) {
    const requestOpts = {}
    if (ref && typeof ref === 'object' && typeof ref.cacheKey === 'string') requestOpts.cacheKey = ref.cacheKey
    if (requestOpts.cacheKey === undefined) requestOpts.__callPath = cachePaths.nextWorkflowPath()
    const response = await callParent('workflow', [ref, childArgs, requestOpts])
    spentTokens += Number(response?.spentDelta || 0)
    return response?.result
  }

  const context = makeVmContext({
    agent,
    phase,
    log,
    workflow,
    args: workerData.args,
    cwd: workerData.cwd,
    budget,
    enterCachePath: cachePaths.enterCachePath,
    getCachePath: cachePaths.getCachePath,
    nextPathOrdinal: cachePaths.nextPathOrdinal,
  })
  const wrapped = `(async () => {\n${workerData.scriptBody}\n})()`
  const script = new vm.Script(wrapped, { filename: workerData.scriptPath })
  const result = await script.runInContext(context, { timeout: WORKFLOW_SYNC_TIMEOUT_MS })
  parentPort.postMessage({ type: 'done', result })
}

async function executeWorkflow(input) {
  const scriptPath = path.resolve(input.scriptPath)
  const originalScript = await fs.readFile(scriptPath, 'utf8')
  const { meta, scriptBody } = parseWorkflowScript(originalScript)
  const runId = input.runId || makeRunId()
  const taskId = input.taskId || makeTaskId()
  const outRoot = path.resolve(input.outRoot || DEFAULT_OUT)
  const runDir = input.runDir ? path.resolve(input.runDir) : path.join(outRoot, runId)
  const scriptsDir = path.join(runDir, 'workflows', 'scripts')
  const scriptCopy = path.join(scriptsDir, `${slugify(meta.name)}-${runId}.js`)
  const workflowJson = path.join(runDir, 'workflow.json')
  const subagentDir = path.join(runDir, 'subagents', 'workflows', runId)
  const journal = new Journal(path.join(subagentDir, 'journal.jsonl'))
  await journal.load()
  await fs.mkdir(scriptsDir, { recursive: true })
  await fs.mkdir(subagentDir, { recursive: true })
  await fs.writeFile(scriptCopy, originalScript)
  const agentLimit = input.agentLimit || createAgentLimitTracker(
    input.maxAgents ?? 1000,
    input.initialAgentLimitUsed ?? 0,
    input.initialAgentLimitReached ?? false
  )
  const countCachedAgentUsage = input.countCachedAgentUsage !== false

  const state = {
    runId,
    taskId,
    workflowName: meta.name,
    summary: meta.description,
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    script: originalScript,
    scriptPath: scriptCopy,
    status: 'running',
    startTime: Date.now(),
    durationMs: 0,
    phases: Array.isArray(meta.phases) ? meta.phases : [],
    workflowProgress: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    result: null,
    args: input.args,
    workspace: input.workspace,
    sandbox: input.sandbox,
    childModel: input.childModel,
    budgetTokens: input.budgetTokens ?? null,
    agentLimit: agentLimit.snapshot(),
    defaultModel: input.childModel || 'codex-default',
    timestamp: new Date().toISOString(),
  }

  const phaseByTitle = new Map()
  let currentPhaseTitle = null
  let currentPhaseIndex = null
  for (const phase of state.phases) {
    ensurePhase(phase.title, phase.detail)
  }

  const semaphore = new Semaphore(input.maxConcurrency)
  let spentTokens = 0
  const sharedBudget = input.sharedBudget || createBudgetTracker(input.budgetTokens ?? null)
  const cachePathStorage = new AsyncLocalStorage()
  const agentPathCounts = new Map()
  const workflowPathCounts = new Map()
  const pathOrdinalCounts = new Map()
  const budget = {
    total: sharedBudget.total,
    spent: () => sharedBudget.spent(),
    remaining: () => sharedBudget.remaining(),
  }
  let persistChain = Promise.resolve()
  let agentLimitError = null

  async function persist() {
    state.durationMs = Date.now() - state.startTime
    state.timestamp = new Date().toISOString()
    state.agentLimit = agentLimit.snapshot()
    const snapshot = JSON.stringify(state, null, 2)
    const tempPath = `${workflowJson}.${process.pid}.${crypto.randomUUID()}.tmp`
    const writeSnapshot = async () => {
      await fs.writeFile(tempPath, snapshot)
      await fs.rename(tempPath, workflowJson)
    }
    persistChain = persistChain.then(writeSnapshot, writeSnapshot)
    await persistChain
  }

  function ensurePhase(title, detail) {
    if (!title) title = 'Agents'
    if (phaseByTitle.has(title)) return phaseByTitle.get(title)
    const index = phaseByTitle.size + 1
    phaseByTitle.set(title, index)
    state.workflowProgress.push({
      type: 'workflow_phase',
      index,
      title,
      ...(detail ? { detail } : {}),
    })
    return index
  }

  function phase(title) {
    const metaPhase = state.phases.find((p) => p.title === title)
    currentPhaseTitle = title
    currentPhaseIndex = ensurePhase(title, metaPhase?.detail)
  }

  function log(message) {
    state.logs.push({ time: Date.now(), message: String(message) })
  }

  function normalizeAgentOptions(opts = {}) {
    const normalized = {}
    for (const key of ['label', 'phase', 'schema', 'model', 'isolation', 'agentType', 'cacheKey']) {
      if (opts[key] !== undefined) normalized[key] = opts[key]
    }
    return normalized
  }

  function validateAgentOptions(opts = {}) {
    if (opts.agentType !== undefined) {
      throw new Error('agentType is not supported by this runner; configure child prompts/models explicitly instead')
    }
    if (opts.tools !== undefined) {
      throw new Error('per-agent tools are not supported by this runner; child codex exec processes use Codex\'s own tool surface')
    }
    if (opts.instructions !== undefined) {
      throw new Error('per-agent instructions are not supported by this runner; put guidance directly in the agent() prompt')
    }
    if (opts.isolation === undefined || opts.isolation === 'shared') return
    if (opts.isolation === 'worktree') return
    throw new Error(`agent isolation mode is not supported: ${opts.isolation}`)
  }

  function nextAgentCachePath(opts = {}) {
    if (typeof opts.__callPath === 'string' && opts.__callPath.trim()) return `path:${opts.__callPath.trim()}`
    if (typeof opts.cacheKey === 'string' && opts.cacheKey.trim()) return `explicit:${opts.cacheKey.trim()}`
    const basePath = cachePathStorage.getStore() || ['root']
    const base = basePath.join('/')
    const count = (agentPathCounts.get(base) || 0) + 1
    agentPathCounts.set(base, count)
    return `${base}/agent:${count}`
  }

  function nextWorkflowCachePath(ref, opts = {}) {
    if (typeof opts.__callPath === 'string' && opts.__callPath.trim()) return `path:${opts.__callPath.trim()}`
    if (typeof opts.cacheKey === 'string' && opts.cacheKey.trim()) return `explicit:${opts.cacheKey.trim()}`
    if (ref && typeof ref === 'object' && typeof ref.cacheKey === 'string' && ref.cacheKey.trim()) {
      return `explicit:${ref.cacheKey.trim()}`
    }
    const basePath = cachePathStorage.getStore() || ['root']
    const base = basePath.join('/')
    const count = (workflowPathCounts.get(base) || 0) + 1
    workflowPathCounts.set(base, count)
    return `${base}/workflow:${count}`
  }

  function withCachePath(segment, fn) {
    const parentPath = cachePathStorage.getStore() || ['root']
    return cachePathStorage.run([...parentPath, String(segment)], fn)
  }

  function nextPathOrdinal(kind) {
    const basePath = cachePathStorage.getStore() || ['root']
    const key = `${basePath.join('/')}/${kind}`
    const count = pathOrdinalCounts.get(key) || 0
    pathOrdinalCounts.set(key, count + 1)
    return count
  }

  async function consumeAgentSlot(label, progress = null) {
    if (agentLimit.tryUse()) return
    const message = `Workflow agent limit exceeded (${agentLimit.used()} used, limit ${agentLimit.limit})`
    agentLimitError = new Error(message)
    state.logs.push({ time: Date.now(), message })
    if (progress) {
      progress.state = 'failed'
      progress.lastToolName = 'agent-limit'
      progress.lastToolSummary = message
    }
    await persist()
    throw agentLimitError
  }

  async function agent(prompt, opts = {}) {
    if (typeof prompt !== 'string') throw new Error('agent(prompt) requires a string prompt')
    validateAgentOptions(opts)
    const effectiveModel = opts.model || input.childModel
    const normalizedOpts = normalizeAgentOptions({
      ...opts,
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
    })
    const callPath = nextAgentCachePath(opts)
    const key = `v2:${sha256(stableJson({
      callPath,
      workspace: input.workspace,
      mockAgent: Boolean(input.mockAgent),
      prompt,
      opts: normalizedOpts,
    }))}`
    const cached = input.sandbox === 'read-only' ? journal.get(key) : null
    const label = opts.label || prompt.split('\n').find(Boolean)?.slice(0, 48) || `agent-${state.agentCount + 1}`
    const requestedPhaseTitle = opts.phase || currentPhaseTitle || state.phases[0]?.title || 'Agents'
    const phaseIndex = ensurePhase(requestedPhaseTitle, state.phases.find((p) => p.title === requestedPhaseTitle)?.detail)
    const progress = {
      type: 'workflow_agent',
      index: ++state.agentCount,
      label,
      phaseIndex,
      phaseTitle: requestedPhaseTitle,
      agentId: cached?.agentId || makeAgentId(),
      model: effectiveModel || 'codex-default',
      state: 'queued',
      queuedAt: Date.now(),
      attempt: 1,
      cachePath: callPath,
      promptPreview: preview(prompt, 500),
    }
    if (opts.isolation) progress.isolation = opts.isolation
    state.workflowProgress.push(progress)
    await persist()

    if (cached) {
      if (countCachedAgentUsage) await consumeAgentSlot(`cached agent ${label}`, progress)
      progress.state = 'done'
      progress.startedAt = Date.now()
      progress.durationMs = 0
      progress.lastToolName = opts.schema ? 'StructuredOutput(cache)' : 'Codex(cache)'
      progress.lastToolSummary = 'cache hit'
      progress.resultPreview = preview(JSON.stringify(cached.result), 500)
      if (cached.worktree) progress.worktree = cached.worktree
      await persist()
      return opts.__returnMeta ? { result: cached.result, spentTokens: 0 } : cached.result
    }

    await consumeAgentSlot(label, progress)
    return semaphore.run(async () => {
      const reservation = estimateTokens(prompt)
      if (!sharedBudget.reserve(reservation)) {
        progress.state = 'failed'
        progress.lastToolName = 'budget'
        progress.lastToolSummary = `Workflow budget exhausted before agent call: ${label}`
        await persist()
        throw new Error(progress.lastToolSummary)
      }
      progress.state = 'running'
      progress.startedAt = Date.now()
      await journal.append({ type: 'started', key, agentId: progress.agentId })
      await persist()
      const started = Date.now()
      let result
      let worktree = null
      try {
        if (input.mockAgent) {
          result = mockResult(opts.schema, prompt, label)
        } else if (opts.isolation === 'worktree') {
          const response = await runWorktreeChildCodex({
            prompt: buildChildPrompt(prompt, { schema: opts.schema, label, phase: requestedPhaseTitle }),
            schema: opts.schema,
            agentId: progress.agentId,
            subagentDir,
            runDir,
            outRoot,
            workspace: input.workspace,
            sandbox: input.sandbox,
            codexBin: input.codexBin,
            childModel: effectiveModel,
          })
          result = response.result
          worktree = response.worktree
          progress.worktree = worktree
        } else {
          result = await runChildCodex({
            prompt: buildChildPrompt(prompt, { schema: opts.schema, label, phase: requestedPhaseTitle }),
            schema: opts.schema,
            agentId: progress.agentId,
            subagentDir,
            workspace: input.workspace,
            sandbox: input.sandbox,
            codexBin: input.codexBin,
            childModel: effectiveModel,
          })
        }
        const approx = estimateTokens(prompt) + estimateTokens(JSON.stringify(result))
        spentTokens += approx
        sharedBudget.commit(approx)
        state.totalTokens += approx
        state.totalToolCalls += 1
        progress.tokens = approx
        progress.toolCalls = 1
        progress.durationMs = Date.now() - started
        progress.lastToolName = opts.schema ? 'StructuredOutput' : 'Codex'
        progress.lastToolSummary = summarizeResult(result)
        progress.resultPreview = preview(typeof result === 'string' ? result : JSON.stringify(result), 500)
        progress.state = 'done'
        await journal.append({ type: 'result', key, agentId: progress.agentId, result, ...(worktree ? { worktree } : {}) })
        await persist()
        return opts.__returnMeta ? { result, spentTokens: approx } : result
      } catch (error) {
        progress.state = 'failed'
        progress.durationMs = Date.now() - started
        progress.lastToolName = 'error'
        progress.lastToolSummary = error.message
        if (error.worktree) progress.worktree = error.worktree
        await persist()
        throw error
      } finally {
        sharedBudget.release(reservation)
      }
    })
  }

  async function workflow(ref, childArgs, opts = {}) {
    if (input.depth >= 1) throw new Error('workflow() nesting is limited to one level')
    const childScript = typeof ref === 'string' ? ref : ref?.scriptPath
    if (!childScript) throw new Error('workflow() requires a script path or {scriptPath}')
    const resolved = path.resolve(input.workspace, childScript)
    const scriptHash = sha256(await fs.readFile(resolved, 'utf8'))
    const callPath = nextWorkflowCachePath(ref, opts)
    const key = `v2wf:${sha256(stableJson({
      callPath,
      scriptPath: resolved,
      scriptHash,
      args: childArgs,
      childModel: input.childModel,
      mockAgent: Boolean(input.mockAgent),
      sandbox: input.sandbox,
    }))}`
    const cached = input.sandbox === 'read-only' ? journal.get(key) : null
    if (cached) {
      if (countCachedAgentUsage) {
        const cachedAgentCount = await cachedWorkflowAgentCount(cached)
        consumeCachedAgents(cachedAgentCount, childScript)
      }
      return cached.result
    }
    if (budget.total != null && budget.remaining() <= 0) throw new Error(`Workflow budget exhausted before child workflow: ${childScript}`)
    const childRunId = `wf_${sha256(key).slice(0, 12)}`
    const childRunDir = path.join(runDir, 'children', childRunId)
    const child = await executeWorkflow({
      ...input,
      scriptPath: resolved,
      args: childArgs,
      runId: childRunId,
      taskId: makeTaskId(),
      runDir: childRunDir,
      depth: (input.depth || 0) + 1,
      budgetTokens: budget.total,
      sharedBudget,
      agentLimit,
    })
    const childTokens = Number(child.totalTokens || 0)
    const childToolCalls = Number(child.totalToolCalls || 0)
    spentTokens += childTokens
    state.totalTokens += childTokens
    state.totalToolCalls += childToolCalls
    await journal.append({
      type: 'result',
      key,
      childRunId,
      childRunDir,
      result: child.result,
      totalTokens: childTokens,
      totalToolCalls: childToolCalls,
      agentCount: child.agentCount,
    })
    await persist()
    return child.result
  }

  function consumeCachedAgents(count, label) {
    const total = Math.max(0, Number(count) || 0)
    for (let index = 0; index < total; index++) {
      if (!agentLimit.tryUse()) {
        const message = `Workflow agent limit exceeded while replaying cached child workflow ${label} (${agentLimit.used()} used, limit ${agentLimit.limit})`
        agentLimitError = new Error(message)
        state.logs.push({ time: Date.now(), message })
        throw agentLimitError
      }
    }
  }

  async function cachedWorkflowAgentCount(cached) {
    if (Number.isInteger(cached.agentCount) && cached.agentCount >= 0) return cached.agentCount
    if (!cached.childRunDir) return 0
    try {
      const childSnapshot = JSON.parse(await fs.readFile(path.join(cached.childRunDir, 'workflow.json'), 'utf8'))
      return Math.max(0, Number(childSnapshot.agentCount) || 0)
    } catch {
      return 0
    }
  }

  await persist()
  try {
    const result = await runWorkflowBodyInWorker({
      scriptPath,
      scriptBody,
      args: input.args,
      budgetTokens: budget.total,
      cwd: input.workspace,
      agent: { call: agent, spentTokens: () => spentTokens },
      phase,
      log,
      workflow,
    })
    if (agentLimitError || agentLimit.reached()) {
      throw agentLimitError || new Error(`Workflow agent limit exceeded (${agentLimit.used()} used, limit ${agentLimit.limit})`)
    }
    state.result = result === undefined ? null : result
    state.status = 'completed'
    await persist()
    return { runDir, workflowJson, ...state }
  } catch (error) {
    state.status = 'failed'
    state.error = { message: error.message, stack: error.stack }
    await persist()
    throw Object.assign(error, { runDir, workflowJson })
  }
}

function makeVmContext(bindings) {
  function encodeResult(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      if (value === Infinity) return JSON.stringify({ specialNumber: 'Infinity' })
      if (value === -Infinity) return JSON.stringify({ specialNumber: '-Infinity' })
      return JSON.stringify({ specialNumber: 'NaN' })
    }
    return JSON.stringify({ value })
  }

  function encodeHostError(error) {
    return JSON.stringify({ error: serializeError(error) })
  }

  function decodeArgs(payload) {
    const parsed = JSON.parse(payload)
    if (!Array.isArray(parsed)) throw new Error('workflow host bridge payload must be an array')
    return parsed
  }

  function hostInvoke(name, payload = '[]') {
    try {
      const args = decodeArgs(payload)
      if (name === 'agent') {
        const [prompt, opts] = args
        return Promise.resolve(bindings.agent(prompt, opts || {})).then(encodeResult, encodeHostError)
      }
      if (name === 'workflow') {
        const [ref, childArgs] = args
        return Promise.resolve(bindings.workflow(ref, childArgs)).then(encodeResult, encodeHostError)
      }
      if (name === 'phase') {
        bindings.phase(args[0])
        return encodeResult(null)
      }
      if (name === 'log') {
        bindings.log(args[0])
        return encodeResult(null)
      }
      if (name === 'budget.spent') return encodeResult(bindings.budget.spent())
      if (name === 'budget.remaining') return encodeResult(bindings.budget.remaining())
      throw new Error(`Unknown workflow host bridge call: ${name}`)
    } catch (error) {
      return encodeHostError(error)
    }
  }

  function hostEnterCachePath(pathValue) {
    bindings.enterCachePath(pathValue)
  }

  function hostGetCachePath() {
    return bindings.getCachePath()
  }

  function hostNextPathOrdinal(kind) {
    return bindings.nextPathOrdinal(String(kind || 'path'))
  }

  const context = vm.createContext({
    __hostInvoke: hostInvoke,
    __hostEnterCachePath: hostEnterCachePath,
    __hostGetCachePath: hostGetCachePath,
    __hostNextPathOrdinal: hostNextPathOrdinal,
    __workflowArgsJson: JSON.stringify({ value: bindings.args }),
    __budgetTotal: bindings.budget.total,
    __workflowCwd: typeof bindings.cwd === 'string' ? bindings.cwd : '',
  }, {
    codeGeneration: { strings: false, wasm: false },
  })

  vm.runInContext(`
(() => {
  'use strict'

  const callHost = __hostInvoke
  const enterCachePath = __hostEnterCachePath
  const getCachePath = __hostGetCachePath
  const nextPathOrdinal = __hostNextPathOrdinal
  const argsEnvelope = JSON.parse(__workflowArgsJson)
  const argsValue = Object.prototype.hasOwnProperty.call(argsEnvelope, 'value') ? argsEnvelope.value : undefined

  const encodePayload = (value) => JSON.stringify(value === undefined ? null : value)
  const decodeHost = (value) => {
    const envelope = JSON.parse(value)
    if (Object.prototype.hasOwnProperty.call(envelope, 'error')) {
      const payload = envelope.error || {}
      const error = new Error(payload.message || 'Workflow host call failed')
      if (payload.stack) error.stack = payload.stack
      throw error
    }
    if (Object.prototype.hasOwnProperty.call(envelope, 'specialNumber')) {
      if (envelope.specialNumber === 'Infinity') return Infinity
      if (envelope.specialNumber === '-Infinity') return -Infinity
      if (envelope.specialNumber === 'NaN') return NaN
    }
    return Object.prototype.hasOwnProperty.call(envelope, 'value') ? envelope.value : undefined
  }
  const clonePlain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  const define = (name, value) => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      enumerable: true,
      configurable: false,
    })
  }
  const withPath = async (segment, callback) => {
    const parentPath = getCachePath() || 'root'
    const childPath = parentPath + '/' + String(segment)
    enterCachePath(childPath)
    let result
    try {
      result = callback()
    } catch (error) {
      enterCachePath(parentPath)
      throw error
    }
    enterCachePath(parentPath)
    return await result
  }

  define('agent', async (prompt, opts = {}) => {
    if (typeof prompt !== 'string') throw new Error('agent(prompt) requires a string prompt')
    const result = await callHost('agent', encodePayload([prompt, clonePlain(opts || {})]))
    return decodeHost(result)
  })

  define('phase', (title) => {
    callHost('phase', encodePayload([String(title || '')]))
  })

  define('log', (message) => {
    callHost('log', encodePayload([String(message)]))
  })

  define('workflow', async (ref, childArgs) => {
    const result = await callHost('workflow', encodePayload([clonePlain(ref), clonePlain(childArgs)]))
    return decodeHost(result)
  })

  define('parallel', async (thunks) => {
    if (!Array.isArray(thunks)) throw new Error('parallel() requires an array of thunks')
    const callId = nextPathOrdinal('parallel')
    return Promise.all(thunks.map((thunk, index) => withPath('parallel:' + callId + ':item:' + index, async () => {
      try {
        return await thunk()
      } catch {
        return null
      }
    })))
  })

  define('pipeline', async (items, ...stages) => {
    if (!Array.isArray(items)) throw new Error('pipeline() requires an item array')
    const callId = nextPathOrdinal('pipeline')
    return Promise.all(items.map((item, index) => withPath('pipeline:' + callId + ':item:' + index, async () => {
      let previous = item
      for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
        previous = await withPath('stage:' + stageIndex, () => stages[stageIndex](previous, item, index))
        if (previous === null) return null
      }
      return previous
    })))
  })

  define('args', argsValue)
  define('budget', Object.freeze({
    total: __budgetTotal,
    spent: () => decodeHost(callHost('budget.spent', '[]')),
    remaining: () => decodeHost(callHost('budget.remaining', '[]')),
  }))

  const RealDate = Date
  function SafeDate(...dateArgs) {
    if (dateArgs.length === 0) throw new Error('Argless Date is disabled in workflow scripts; pass timestamps via args')
    return new RealDate(...dateArgs)
  }
  Object.defineProperty(SafeDate, 'now', {
    value: () => {
      throw new Error('Date.now() is disabled in workflow scripts; pass timestamps via args')
    },
    writable: false,
    configurable: false,
  })
  Object.defineProperty(SafeDate, 'parse', { value: RealDate.parse, writable: false, configurable: false })
  Object.defineProperty(SafeDate, 'UTC', { value: RealDate.UTC, writable: false, configurable: false })
  Object.defineProperty(RealDate.prototype, 'constructor', { value: SafeDate, writable: false, configurable: false })
  Object.defineProperty(SafeDate, 'prototype', { value: RealDate.prototype, writable: false, configurable: false })
  define('Date', SafeDate)

  Object.defineProperty(Math, 'random', {
    value: () => {
      throw new Error('Math.random() is disabled in workflow scripts; vary prompts by index instead')
    },
    writable: false,
    configurable: false,
  })

  const cwdValue = String(__workflowCwd || '')
  define('cwd', cwdValue)
  define('console', Object.freeze({ log: (message) => callHost('log', encodePayload([String(message)])) }))
  define('structuredClone', (value) => clonePlain(value))
  define('setTimeout', undefined)
  define('setInterval', undefined)
  define('Intl', undefined)
  define('require', undefined)
  define('process', Object.freeze({ cwd: () => cwdValue }))
  define('constructor', undefined)
  Object.defineProperty(globalThis, '__proto__', {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  })

  delete globalThis.__hostInvoke
  delete globalThis.__hostEnterCachePath
  delete globalThis.__hostGetCachePath
  delete globalThis.__hostNextPathOrdinal
  delete globalThis.__workflowArgsJson
  delete globalThis.__budgetTotal
  delete globalThis.__workflowCwd
  Object.setPrototypeOf(globalThis, null)
})()
`, context, { timeout: 1000 })

  return context
}

async function gitCapture(workspace, args, stdin = '') {
  const { code, stdout, stderr } = await spawnCapture('git', ['-C', workspace, ...args], stdin)
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.slice(-1000) || stdout.slice(-1000)}`)
  return stdout
}

async function gitCaptureOptional(workspace, args, stdin = '') {
  const { code, stdout, stderr } = await spawnCapture('git', ['-C', workspace, ...args], stdin)
  return { ok: code === 0, stdout, stderr }
}

function isInsidePath(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath)
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function normalizeRelativePath(value) {
  return String(value || '').replaceAll(path.sep, '/').replace(/^\/+/, '').replace(/\/+$/g, '')
}

function parsePorcelainStatus(output) {
  const records = String(output || '').split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    const paths = [record.slice(3)]
    if (status[0] === 'R' || status[0] === 'C') paths.push(records[++index] || '')
    entries.push({ status, paths: paths.filter(Boolean) })
  }
  return entries
}

function statusEntryIsIgnored(entry, ignoredRoots) {
  if (!ignoredRoots.length) return false
  return entry.paths.length > 0 && entry.paths.every((entryPath) => {
    const normalized = normalizeRelativePath(entryPath)
    return ignoredRoots.some((ignoredRoot) => normalized === ignoredRoot || normalized.startsWith(`${ignoredRoot}/`))
  })
}

async function assertCleanParentForWorktree(workspace, gitRoot, ignoredPaths = []) {
  const ignoredRoots = []
  for (const ignoredPath of ignoredPaths) {
    const resolved = path.resolve(ignoredPath)
    if (!isInsidePath(resolved, gitRoot)) continue
    const relative = normalizeRelativePath(path.relative(gitRoot, resolved))
    if (relative) ignoredRoots.push(relative)
  }
  const status = await gitCapture(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = parsePorcelainStatus(status).filter((entry) => !statusEntryIsIgnored(entry, ignoredRoots))
  if (!entries.length) return
  const sample = entries
    .slice(0, 8)
    .map((entry) => `${entry.status} ${entry.paths.join(' -> ')}`)
    .join('; ')
  const suffix = entries.length > 8 ? `; ... and ${entries.length - 8} more` : ''
  throw new Error(`isolation: "worktree" requires a clean parent git worktree outside runner output paths: ${sample}${suffix}`)
}

async function createGitWorktree(workspace, agentId, ignoredDirtyPaths = []) {
  const rawGitRoot = (await gitCapture(workspace, ['rev-parse', '--show-toplevel'])).trim()
  const gitRoot = await fs.realpath(rawGitRoot)
  const resolvedWorkspace = await fs.realpath(path.resolve(workspace))
  const relativeWorkspace = path.relative(gitRoot, resolvedWorkspace)
  if (relativeWorkspace.startsWith('..') || path.isAbsolute(relativeWorkspace)) {
    throw new Error(`Workspace ${resolvedWorkspace} is not inside git root ${gitRoot}`)
  }
  await assertCleanParentForWorktree(workspace, gitRoot, ignoredDirtyPaths)
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), `codex-workflow-${agentId}-`))
  const worktreeRoot = path.join(tempParent, 'repo')
  const baseCommit = (await gitCapture(gitRoot, ['rev-parse', 'HEAD'])).trim()
  try {
    await gitCapture(gitRoot, ['worktree', 'add', '--detach', worktreeRoot, baseCommit])
  } catch (error) {
    await fs.rm(tempParent, { recursive: true, force: true })
    throw error
  }
  return {
    gitRoot,
    tempParent,
    worktreeRoot,
    baseCommit,
    childWorkspace: relativeWorkspace ? path.join(worktreeRoot, relativeWorkspace) : worktreeRoot,
  }
}

async function finalizeGitWorktree(worktree, subagentDir, agentId) {
  const patchPath = path.join(subagentDir, `agent-${agentId}.worktree.patch`)
  const metaPath = path.join(subagentDir, `agent-${agentId}.worktree.json`)
  await gitCapture(worktree.worktreeRoot, ['add', '-N', '--', '.'])
  const status = await gitCapture(worktree.worktreeRoot, ['status', '--short'])
  const head = (await gitCapture(worktree.worktreeRoot, ['rev-parse', 'HEAD'])).trim() || worktree.baseCommit
  const hasCommittedChanges = head !== worktree.baseCommit
  const hasDirtyChanges = status.trim().length > 0
  const changed = hasCommittedChanges || hasDirtyChanges
  const diff = changed
    ? await gitCapture(worktree.worktreeRoot, ['diff', '--binary', '--no-ext-diff', worktree.baseCommit])
    : ''
  const diffStat = changed
    ? (await gitCapture(worktree.worktreeRoot, ['diff', '--stat', '--no-ext-diff', worktree.baseCommit])).trim()
    : ''
  await fs.writeFile(patchPath, diff)
  let cleanup = 'kept'
  if (!changed) {
    const removeResult = await gitCaptureOptional(worktree.gitRoot, ['worktree', 'remove', '--force', worktree.worktreeRoot])
    await fs.rm(worktree.tempParent, { recursive: true, force: true })
    cleanup = removeResult.ok ? 'removed-unchanged' : 'remove-failed'
  }
  const info = {
    mode: 'worktree',
    changed,
    baseCommit: worktree.baseCommit,
    headCommit: head,
    hasCommittedChanges,
    hasDirtyChanges,
    gitRoot: worktree.gitRoot,
    worktreeRoot: worktree.worktreeRoot,
    workspace: worktree.childWorkspace,
    patchPath,
    status: status.trim(),
    diffStat,
    cleanup,
  }
  await fs.writeFile(metaPath, JSON.stringify(info, null, 2))
  return info
}

async function recordFailedWorktreeFinalization(worktree, subagentDir, agentId, error) {
  const patchPath = path.join(subagentDir, `agent-${agentId}.worktree.patch`)
  const metaPath = path.join(subagentDir, `agent-${agentId}.worktree.json`)
  const info = {
    mode: 'worktree',
    changed: null,
    baseCommit: worktree.baseCommit,
    gitRoot: worktree.gitRoot,
    worktreeRoot: worktree.worktreeRoot,
    workspace: worktree.childWorkspace,
    patchPath,
    status: null,
    diffStat: null,
    cleanup: 'kept-finalize-failed',
    finalizeError: serializeError(error),
  }
  await fs.writeFile(patchPath, '')
  await fs.writeFile(metaPath, JSON.stringify(info, null, 2))
  return info
}

async function runWorktreeChildCodex(input) {
  const worktree = await createGitWorktree(input.workspace, input.agentId, [input.outRoot, input.runDir])
  const prompt = `Isolation: you are running inside a dedicated git worktree for this workflow agent. Make any file edits only here; the parent workspace does not receive them automatically — an integrator inspects or applies the captured patch after you return. Describe the edits and any verification you ran in your final output.

${input.prompt}`
  let result
  let childError = null
  let worktreeInfo = null
  try {
    result = await runChildCodex({
      ...input,
      prompt,
      workspace: worktree.childWorkspace,
      isolation: 'worktree',
    })
  } catch (error) {
    childError = error
  }
  try {
    worktreeInfo = await finalizeGitWorktree(worktree, input.subagentDir, input.agentId)
  } catch (error) {
    const failedInfo = await recordFailedWorktreeFinalization(worktree, input.subagentDir, input.agentId, error).catch(() => null)
    if (!childError) {
      if (failedInfo) error.worktree = failedInfo
      throw error
    }
    if (failedInfo) childError.worktree = failedInfo
    childError.worktreeFinalizeError = serializeError(error)
  }
  if (childError) {
    if (worktreeInfo) childError.worktree = worktreeInfo
    throw childError
  }
  return { result, worktree: worktreeInfo }
}

// Frame every child `codex exec` run as a workflow subagent whose final message
// is consumed as a return value. This mirrors the Pi extension's structured
// output contract (final action must be the machine-readable result, no trailing
// prose) and Claude Code workflow agents being told their final text is a return
// value, adapted to Codex's `--output-schema` mechanism.
function buildChildPrompt(prompt, { schema, label, phase } = {}) {
  const header =
    'You are an isolated subagent in a Codex dynamic workflow run by a parent orchestrator. ' +
    'Your final message is consumed programmatically as this subagent\'s return value: it is not shown to a human and there is no follow-up turn. Make it complete and self-contained.'
  const context = []
  if (label) context.push(`Task label: ${label}`)
  if (phase) context.push(`Workflow phase: ${phase}`)
  const contract = schema
    ? [
        'Output contract (structured):',
        '- Do any needed reading or commands first, then end your turn with a final message that is a single JSON value satisfying the provided output schema.',
        '- The final message must be raw JSON only: no prose, no Markdown, no code fences, nothing before or after it.',
        '- Fill every required field with real, evidence-based values; do not invent data. Cite concrete file paths, symbols, commands, or line references in the relevant fields.',
      ].join('\n')
    : [
        'Output contract (text):',
        '- End your turn with a final message that fully answers the task; that message is the return value.',
        '- Be concrete and self-contained: cite file paths, symbols, commands, or evidence rather than referring to context the parent cannot see.',
        '- Do not ask the parent questions or defer work; complete the task with the information available.',
      ].join('\n')
  return [header, context.join('\n'), prompt, contract].filter((part) => part && part.trim()).join('\n\n')
}

async function runChildCodex({ prompt, schema, agentId, subagentDir, workspace, sandbox, codexBin, childModel, isolation = 'shared' }) {
  const finalPath = path.join(subagentDir, `agent-${agentId}.final.txt`)
  const eventsPath = path.join(subagentDir, `agent-${agentId}.jsonl`)
  const stderrPath = path.join(subagentDir, `agent-${agentId}.stderr.txt`)
  const metaPath = path.join(subagentDir, `agent-${agentId}.meta.json`)
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    workspace,
    '--sandbox',
    sandbox,
    '--output-last-message',
    finalPath,
    '--json',
  ]
  let schemaPath = null
  if (schema) {
    schemaPath = path.join(subagentDir, `agent-${agentId}.schema.json`)
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2))
    args.push('--output-schema', schemaPath)
  }
  if (childModel) args.push('--model', childModel)
  args.push('-')
  await fs.writeFile(metaPath, JSON.stringify({ agentId, workspace, sandbox, isolation, schemaPath, startedAt: new Date().toISOString() }, null, 2))
  const { code, stdout, stderr } = await spawnCapture(codexBin, args, prompt)
  await fs.writeFile(eventsPath, stdout)
  await fs.writeFile(stderrPath, stderr)
  if (code !== 0) {
    throw new Error(`child codex exited ${code}: ${stderr.slice(-1000) || stdout.slice(-1000)}`)
  }
  const finalText = await fs.readFile(finalPath, 'utf8')
  if (!schema) return finalText.trim()
  const parsed = parseJsonOutput(finalText)
  const violations = validateAgainstSchema(parsed, schema, 'result')
  if (violations.length) {
    throw new Error(`Structured child output did not satisfy the schema: ${violations.slice(0, 5).join('; ')}`)
  }
  return parsed
}

function spawnCapture(command, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

function parseJsonOutput(text) {
  try {
    return JSON.parse(text)
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) return JSON.parse(fenced[1])
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1))
    throw new Error(`Structured child output was not JSON: ${text.slice(0, 500)}`)
  }
}

// Lightweight JSON Schema validator for the subset workflow schemas use
// (type, enum, const, required, properties, additionalProperties:false, items).
// The Pi extension validates structured output with TypeBox before the parent
// receives it; child `codex exec --output-schema` only guides the model, so the
// runner validates the parsed object here and fails the agent on a mismatch,
// instead of silently propagating wrong-shaped data into synthesis.
function jsonSchemaType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesSchemaType(value, type) {
  const actual = jsonSchemaType(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  return actual === type
}

function validateAgainstSchema(value, schema, path = 'result') {
  const errors = []
  if (!schema || typeof schema !== 'object') return errors

  if (schema.enum !== undefined) {
    const stable = stableJson(value)
    if (!schema.enum.some((option) => stableJson(option) === stable)) {
      errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
      return errors
    }
  }
  if (schema.const !== undefined && stableJson(value) !== stableJson(schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`)
    return errors
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.length && !types.some((type) => matchesSchemaType(value, type))) {
    errors.push(`${path} must be of type ${types.join('|')}, got ${jsonSchemaType(value)}`)
    return errors
  }

  const effectiveType = types.find((type) => matchesSchemaType(value, type))
    || (schema.properties ? 'object' : schema.items ? 'array' : undefined)

  if (effectiveType === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          errors.push(`${path}.${key} is not an allowed property`)
        }
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateAgainstSchema(value[key], propSchema, `${path}.${key}`))
      }
    }
  } else if (effectiveType === 'array' && Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`))
    })
  }
  return errors
}

function mockResult(schema, prompt, label) {
  if (!schema) return `mock:${label}:${prompt.slice(0, 80)}`
  return synthesizeFromSchema(schema, 'result')
}

function synthesizeFromSchema(schema, key) {
  if (!schema || typeof schema !== 'object') return null
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (schema.enum?.length) return schema.enum[0]
  if (type === 'string') return `mock-${key}`
  if (type === 'number' || type === 'integer') return 0
  if (type === 'boolean') return true
  if (type === 'array') return []
  if (type === 'object' || schema.properties) {
    const out = {}
    for (const [prop, propSchema] of Object.entries(schema.properties || {})) {
      if (!schema.required || schema.required.includes(prop)) out[prop] = synthesizeFromSchema(propSchema, prop)
    }
    return out
  }
  return null
}

function summarizeResult(result) {
  if (typeof result === 'string') return preview(result, 120)
  if (result && typeof result === 'object') {
    for (const key of ['summary', 'title', 'id', 'dimension', 'verdict']) {
      if (typeof result[key] === 'string') return preview(result[key], 120)
    }
    return preview(JSON.stringify(result), 120)
  }
  return String(result)
}

function preview(value, length) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4)
}

async function summarize(runDir) {
  const snapshot = JSON.parse(await fs.readFile(path.join(path.resolve(runDir), 'workflow.json'), 'utf8'))
  return {
    runId: snapshot.runId,
    workflowName: snapshot.workflowName,
    status: snapshot.status,
    phases: snapshot.phases,
    agentCount: snapshot.agentCount,
    agentLimit: snapshot.agentLimit,
    totalTokens: snapshot.totalTokens,
    totalToolCalls: snapshot.totalToolCalls,
    durationMs: snapshot.durationMs,
    result: snapshot.result,
  }
}

async function main() {
  const { command, positional, opts } = parseCli(process.argv.slice(2))
  if (!command || opts.help || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage())
    return
  }

  if (command === 'inspect') {
    const script = positional[0]
    if (!script) throw new Error('inspect requires a workflow script path')
    const result = inspectScript(await fs.readFile(path.resolve(script), 'utf8'))
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      process.stdout.write(`Workflow: ${result.meta.name}\n`)
      process.stdout.write(`${result.meta.description}\n`)
      process.stdout.write(`Phases: ${result.phases.map((p) => p.title).join(', ') || '(none)'}\n`)
      process.stdout.write(`agent(): ${result.scan.agentCalls}; pipeline(): ${result.scan.pipelineCalls}; parallel(): ${result.scan.parallelCalls}; loops: ${result.scan.loopCalls}; estimated agents: ${result.scan.estimatedAgents}\n`)
      for (const warning of result.scan.warnings || []) process.stdout.write(`warning: ${warning}\n`)
    }
    return
  }

  if (command === 'template') {
    const kind = positional[0] || 'throughput'
    if (kind !== 'throughput') throw new Error(`Unknown template: ${kind}`)
    const script = throughputTemplate({
      objective: opts.objective,
      target: opts.target,
      name: opts.name,
      lenses: parseLensList(opts.lenses),
      maxVerify: opts['max-verify'],
    })
    if (opts.output) {
      const outputPath = path.resolve(opts.output)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, script)
      if (opts.json) process.stdout.write(`${JSON.stringify({ output: outputPath }, null, 2)}\n`)
      else process.stdout.write(`Wrote ${outputPath}\n`)
    } else {
      process.stdout.write(script)
    }
    return
  }

  if (command === 'summarize') {
    const runDir = positional[0]
    if (!runDir) throw new Error('summarize requires a run directory')
    const result = await summarize(runDir)
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      process.stdout.write(`${result.workflowName} ${result.status}: ${result.agentCount} agents, ${result.totalTokens} est. tokens\n`)
    }
    return
  }

  if (command === 'run') {
    let workspace = opts.workspace ? path.resolve(opts.workspace) : null
    const resumeDir = opts.resume ? path.resolve(opts.resume) : null
    let scriptPath = positional[0] ? path.resolve(positional[0]) : null
    let runId = opts['run-id']
    let resumeSnapshot = null
    if (resumeDir) {
      const snapshotPath = path.join(resumeDir, 'workflow.json')
      resumeSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'))
      scriptPath = scriptPath || resumeSnapshot.scriptPath
      runId = runId || resumeSnapshot.runId
    }
    workspace = workspace || (resumeSnapshot?.workspace ? path.resolve(resumeSnapshot.workspace) : path.resolve(process.cwd()))
    if (!scriptPath) throw new Error('run requires a workflow script path unless --resume points to a prior run')
    const maxDefault = Math.max(1, Math.min(16, os.cpus().length - 2 || 1))
    const argsProvided = opts.args !== undefined || opts['args-file'] !== undefined
    const resolvedArgs = argsProvided
      ? await readArgs(opts)
      : (resumeSnapshot && Object.prototype.hasOwnProperty.call(resumeSnapshot, 'args') ? resumeSnapshot.args : undefined)
    const sandbox = opts.sandbox || resumeSnapshot?.sandbox || 'read-only'
    const allowedSandboxes = new Set(['read-only', 'workspace-write', 'danger-full-access'])
    if (!allowedSandboxes.has(sandbox)) {
      throw new Error(`--sandbox must be one of read-only, workspace-write, danger-full-access (got: ${sandbox})`)
    }
    const childModel = opts['child-model'] || resumeSnapshot?.childModel
    const resumeAgentLimit = resumeSnapshot?.agentLimit
    const hasPersistedAgentUsage = resumeDir && Number.isInteger(resumeAgentLimit?.used)
    const maxAgents = readMaxAgents(opts, resumeAgentLimit?.limit ?? 1000)
    const initialAgentLimitUsed = hasPersistedAgentUsage ? Math.max(0, Number(resumeAgentLimit.used) || 0) : 0
    const result = await executeWorkflow({
      scriptPath,
      workspace,
      outRoot: opts.out || DEFAULT_OUT,
      runDir: resumeDir,
      runId,
      args: resolvedArgs,
      sandbox,
      codexBin: opts['codex-bin'] || 'codex',
      childModel,
      maxConcurrency: Number(opts['max-concurrency'] || maxDefault),
      maxAgents,
      initialAgentLimitUsed,
      initialAgentLimitReached: hasPersistedAgentUsage &&
        initialAgentLimitUsed >= maxAgents &&
        (Boolean(resumeAgentLimit.reached) || initialAgentLimitUsed > maxAgents),
      countCachedAgentUsage: !hasPersistedAgentUsage,
      budgetTokens: readBudgetTokens(opts, resumeSnapshot?.budgetTokens ?? null),
      mockAgent: Boolean(opts['mock-agent']),
      depth: 0,
    })
    if (opts.json) process.stdout.write(`${JSON.stringify({ runDir: result.runDir, workflowJson: result.workflowJson, runId: result.runId, status: result.status, result: result.result }, null, 2)}\n`)
    else {
      process.stdout.write(`Workflow ${result.runId} ${result.status}.\n`)
      process.stdout.write(`Run dir: ${result.runDir}\n`)
      process.stdout.write(`Snapshot: ${result.workflowJson}\n`)
    }
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

// Exported for unit tests; importing the module must not run the CLI.
export { parseWorkflowScript, inspectScript, buildChildPrompt, evaluateLiteral, validateMeta, validateAgainstSchema }

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (!isMainThread && workerData?.mode === 'workflow-vm') {
  runWorkflowVmWorker().catch((error) => {
    parentPort.postMessage({ type: 'error', error: serializeError(error) })
  })
} else if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
