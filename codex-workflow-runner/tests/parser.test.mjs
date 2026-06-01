import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkflowScript, inspectScript, buildChildPrompt, validateAgainstSchema, parseAgentToml, clampSandbox, normalizeEffort, readAgentProfile } from '../scripts/codex_workflow_runner.mjs'

const valid = `export const meta = {
  name: 'demo',
  description: 'a demo workflow',
  whenToUse: 'when demonstrating',
  phases: [{ title: 'Scan' }, { title: 'Synthesize', detail: 'merge' }],
}
phase('Scan')
const a = await agent('inspect', { label: 'scan' })
return a
`

test('parseWorkflowScript extracts literal meta and strips the export from the body', () => {
  const { meta, scriptBody } = parseWorkflowScript(valid)
  assert.equal(meta.name, 'demo')
  assert.equal(meta.description, 'a demo workflow')
  assert.equal(meta.whenToUse, 'when demonstrating')
  assert.equal(meta.phases.length, 2)
  assert.equal(meta.phases[1].detail, 'merge')
  assert.ok(!scriptBody.includes('export const meta'))
  assert.ok(scriptBody.includes("phase('Scan')"))
})

test('meta export must be the first statement', () => {
  assert.throws(() => parseWorkflowScript("const x = 1\nexport const meta = { name: 'a', description: 'b' }\nawait agent('x')"),
    /must begin with export const meta/)
})

test('meta must be a pure literal (no spread, computed keys, calls, or interpolation)', () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'a', description: 'b', phases: [...[{ title: 'x' }]] }\nawait agent('x')"), /spread not allowed/)
  assert.throws(() => parseWorkflowScript("export const meta = { ['na' + 'me']: 'a', description: 'b' }\nawait agent('x')"), /computed keys not allowed/)
  assert.throws(() => parseWorkflowScript("export const meta = { name: ['a'].join(''), description: 'b' }\nawait agent('x')"), /non-literal node type/)
  assert.throws(() => parseWorkflowScript("export const meta = { name: `a${1}`, description: 'b' }\nawait agent('x')"), /template interpolation not allowed/)
})

test('meta validation enforces required string fields and phase titles', () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: '', description: 'b' }\nawait agent('x')"), /meta.name/)
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'a', description: '' }\nawait agent('x')"), /meta.description/)
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'a', description: 'b', phases: [{}] }\nawait agent('x')"), /title string/)
})

test('inspectScript counts top-level agent calls', () => {
  const { scan } = inspectScript(valid)
  assert.equal(scan.agentCalls, 1)
  assert.equal(scan.dynamicAgentCalls, 0)
  assert.equal(scan.estimatedAgents, 1)
  assert.equal(scan.hasReturn, true)
})

test('inspectScript counts agents nested in pipeline with nested template literals (regression)', () => {
  const script = `export const meta = { name: 'port', description: 'port files' }
const FILES = ['a', 'b']
const out = await pipeline(
  FILES,
  (f) => agent(\`Draft \${f}: \\\`\\\`\\\`js\\nconst x = 1\\n\\\`\\\`\\\`\`, { label: 'draft' }),
  (d) => agent(\`Verify \${d}\`, { label: 'verify' }),
)
return out
`
  const { scan } = inspectScript(script)
  assert.equal(scan.agentCalls, 2)
  assert.equal(scan.pipelineCalls, 1)
  assert.equal(scan.dynamicAgentCalls, 2)
  assert.ok(scan.estimatedAgents > scan.agentCalls, 'fan-out should mark estimate as a lower bound')
})

test('inspectScript flags determinism violations from real calls only', () => {
  const script = `export const meta = { name: 'd', description: 'd' }
const t = Date.now()
const r = Math.random()
const a = new Date()
const ok = new Date(args.ts)
const s = "this mentions Date.now() and Math.random() in a string"
await agent('go')
`
  const warnings = inspectScript(script).scan.warnings.join(' | ')
  assert.match(warnings, /Date\.now\(\)/)
  assert.match(warnings, /Math\.random\(\)/)
  assert.match(warnings, /Argless Date/)
  // exactly one of each — the string literal must not double-count
  assert.equal(inspectScript(script).scan.warnings.filter((w) => /Date\.now/.test(w)).length, 1)
})

test('new Date(arg) is allowed (not flagged)', () => {
  const script = "export const meta = { name: 'd', description: 'd' }\nconst d = new Date(args.ts)\nawait agent('go')\n"
  const warnings = inspectScript(script).scan.warnings.join(' | ')
  assert.doesNotMatch(warnings, /Argless Date/)
})

test('inspectScript flags unsupported isolation but not agentType (now supported)', () => {
  const script = "export const meta = { name: 'a', description: 'a' }\nawait agent('go', { agentType: 'explorer', isolation: 'sandboxed' })\n"
  const { scan } = inspectScript(script)
  const warnings = scan.warnings.join(' | ')
  assert.doesNotMatch(warnings, /agentType is not supported/)
  assert.match(warnings, /Unsupported agent isolation mode/)
  assert.equal(scan.agentsWithAgentType, 1)
})

test('worktree isolation is recognized, not flagged unsupported', () => {
  const script = "export const meta = { name: 'a', description: 'a' }\nawait agent('go', { isolation: 'worktree' })\n"
  const { scan } = inspectScript(script)
  assert.equal(scan.agentsWithWorktreeIsolation, 1)
  assert.equal(scan.unsupportedIsolationCalls, 0)
})

test('validateAgainstSchema accepts conforming objects and reports violations', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'severity', 'findings'],
    properties: {
      id: { type: 'string' },
      severity: { type: 'string', enum: ['low', 'high'] },
      findings: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } },
    },
  }
  assert.deepEqual(validateAgainstSchema({ id: 'a', severity: 'high', findings: [{ title: 't' }] }, schema), [])
  // missing required
  assert.ok(validateAgainstSchema({ id: 'a', severity: 'high' }, schema).some((e) => /findings is required/.test(e)))
  // wrong type
  assert.ok(validateAgainstSchema({ id: 5, severity: 'high', findings: [] }, schema).some((e) => /must be of type string/.test(e)))
  // bad enum
  assert.ok(validateAgainstSchema({ id: 'a', severity: 'medium', findings: [] }, schema).some((e) => /must be one of/.test(e)))
  // additionalProperties:false
  assert.ok(validateAgainstSchema({ id: 'a', severity: 'low', findings: [], extra: 1 }, schema).some((e) => /not an allowed property/.test(e)))
  // nested array item violation
  assert.ok(validateAgainstSchema({ id: 'a', severity: 'low', findings: [{}] }, schema).some((e) => /findings\[0\]\.title is required/.test(e)))
  // integer accepted where number expected
  assert.deepEqual(validateAgainstSchema(3, { type: 'number' }), [])
})

test('buildChildPrompt frames the return value and adapts to schema presence', () => {
  const structured = buildChildPrompt('Do work', { schema: { type: 'object' }, label: 'x', phase: 'Review' })
  assert.match(structured, /return value/)
  assert.match(structured, /single JSON value satisfying the provided output schema/)
  assert.match(structured, /Task label: x/)
  assert.match(structured, /Workflow phase: Review/)

  const text = buildChildPrompt('Do work', { label: 'y' })
  assert.match(text, /that message is the return value/)
  assert.doesNotMatch(text, /output schema/)
})

test('parseAgentToml maps scalars, multiline strings, and mcp_servers subtables', () => {
  const toml = [
    'name = "reviewer"',
    'description = "PR reviewer"',
    'model = "gpt-5.4"',
    'model_reasoning_effort = "high"',
    'sandbox_mode = "read-only"',
    'nickname_candidates = ["Atlas", "Delta"]',
    'developer_instructions = """',
    'Review like an owner.',
    'Prioritize correctness.',
    '"""',
    '',
    '[mcp_servers.fs]',
    'command = "npx"',
    'args = ["-y", "server-filesystem", "/tmp"]',
  ].join('\n')
  const parsed = parseAgentToml(toml)
  assert.equal(parsed.name, 'reviewer')
  assert.equal(parsed.model, 'gpt-5.4')
  assert.equal(parsed.model_reasoning_effort, 'high')
  assert.equal(parsed.sandbox_mode, 'read-only')
  assert.deepEqual(parsed.nickname_candidates, ['Atlas', 'Delta'])
  assert.match(parsed.developer_instructions, /Review like an owner\.\nPrioritize correctness\./)
  assert.equal(parsed.mcp_servers.fs.command, 'npx')
  assert.deepEqual(parsed.mcp_servers.fs.args, ['-y', 'server-filesystem', '/tmp'])
})

test('parseAgentToml ignores comments and blank lines', () => {
  const parsed = parseAgentToml('# a comment\n\nmodel = "x" # trailing\n')
  assert.equal(parsed.model, 'x')
})

test('parseAgentToml handles a table header with a trailing comment without leaking keys to root', () => {
  const parsed = parseAgentToml('[mcp_servers.fs] # note\ncommand = "npx"\n')
  assert.equal(parsed.mcp_servers.fs.command, 'npx')
  assert.equal(parsed.command, undefined) // must NOT leak to root
})

test('parseAgentToml does not split quoted commas inside inline arrays', () => {
  const parsed = parseAgentToml('args = ["-y", "a,b", "c"]\n')
  assert.deepEqual(parsed.args, ['-y', 'a,b', 'c'])
})

test('parseAgentToml handles one-line triple-quoted strings with trailing content', () => {
  const parsed = parseAgentToml('developer_instructions = """be terse""" # trailing\nmodel = "x"\n')
  assert.equal(parsed.developer_instructions, 'be terse')
  assert.equal(parsed.model, 'x') // parser must not swallow following lines
})

test('parseAgentToml handles multiline inline arrays', () => {
  const parsed = parseAgentToml('args = [\n  "a",\n  "b"\n]\nmodel = "m"\n')
  assert.deepEqual(parsed.args, ['a', 'b'])
  assert.equal(parsed.model, 'm')
})

test('parseAgentToml does not drop multiline array elements after a comment line', () => {
  const parsed = parseAgentToml('args = [\n  "a", # first\n  "b",\n  "c"\n]\nmodel = "m"\n')
  assert.deepEqual(parsed.args, ['a', 'b', 'c'])
  assert.equal(parsed.model, 'm')
})

test('clampSandbox never escalates beyond the run ceiling', () => {
  assert.equal(clampSandbox('workspace-write', 'read-only'), 'read-only') // escalation blocked
  assert.equal(clampSandbox('read-only', 'workspace-write'), 'read-only') // narrowing allowed
  assert.equal(clampSandbox(undefined, 'workspace-write'), 'workspace-write') // default to ceiling
  assert.equal(clampSandbox('danger-full-access', 'workspace-write'), 'workspace-write')
  assert.equal(clampSandbox('bogus', 'read-only'), 'read-only') // unknown -> ceiling
})

test('normalizeEffort validates the effort enum', () => {
  for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) assert.equal(normalizeEffort(e), e)
  assert.equal(normalizeEffort('HIGH'), 'high')
  assert.equal(normalizeEffort('turbo'), null)
  assert.equal(normalizeEffort(undefined), null)
})

test('readAgentProfile resolves built-in profiles', async () => {
  const explorer = await readAgentProfile('explorer', '/tmp', null)
  assert.equal(explorer.effort, 'low')
  assert.match(explorer.developerInstructions, /read-only/i)
  const worker = await readAgentProfile('worker', '/tmp', null)
  assert.equal(worker.effort, 'medium')
  assert.equal(await readAgentProfile('no-such-agent-xyz', '/tmp', '/tmp'), null)
})
