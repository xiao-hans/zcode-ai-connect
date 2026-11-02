// Offline R07/R09 regressions. Only fetch and credentials are synthetic.
// Usage: node --test tests/test-upstream-tool-semantics.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QoderUpstreamClient } from '../zcode-qoder-connect/src/upstream.js'
import { llmChatStream } from '../zcode-trae-connect/src/llm-utils.js'

const credential = {
  token: 'synthetic-token', userId: 'synthetic-user',
  userID: 'synthetic-user', authToken: 'synthetic-auth', machineID: 'synthetic-machine',
}
const identity = { machineId: 'synthetic-machine', deviceId: 'synthetic-device', appVersion: 'test', versionCode: '20260716' }
const base = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const delta = (calls, finish = null) => ({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: finish }] })
const qoder = new QoderUpstreamClient({ logger: { log() {}, warn() {}, error() {} } })
const traeChat = openaiBody => llmChatStream({
  credential, identity, baseUrl: 'https://synthetic.invalid/api/remote/v1',
  openaiBody, ownedFunction: 'solo_agent_remote',
})

// Give each gateway frame a separate network read, including the first frame.
function sseResponse(frames) {
  const encoder = new TextEncoder()
  let index = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < frames.length) controller.enqueue(encoder.encode(frames[index++]))
      else controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

async function readSse(result) {
  assert.equal(result.ok, true, result.message)
  const text = await new Response(result.response.body).text()
  const payloads = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
  assert.equal(payloads.filter(value => value === '[DONE]').length, 1)
  const chunks = payloads.filter(value => value !== '[DONE]').map(value => JSON.parse(value))
  assert.deepEqual(chunks.filter(chunk => chunk.error), [])
  return {
    calls: chunks.flatMap(chunk => chunk.choices ?? []).flatMap(choice => choice.delta?.tool_calls ?? []),
    finishes: chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.finish_reason).filter(Boolean),
  }
}

const scenarios = [
  ['id/name together', [
    [{ index: 0, id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }],
    [{ index: 0, type: 'function', function: { arguments: '"a"}' } }],
  ]],
  ['name arrives after id, including name fragments', [
    [{ index: 0, id: 'call_0', type: 'function', function: {} }],
    [{ index: 0, type: 'function', function: { name: 'read_' } }],
    [{ index: 0, type: 'function', function: { name: 'file', arguments: '{"path":"a"}' } }],
  ]],
  ['arguments arrive before id/name', [
    [{ index: 0, type: 'function', function: { arguments: '{"path":' } }],
    [{ index: 0, id: 'call_0', type: 'function', function: { name: 'read_file' } }],
    [{ index: 0, type: 'function', function: { arguments: '"a"}' } }],
  ]],
  ['interleaved indexes and metadata', [
    [{ index: 1, id: 'call_1', type: 'function', function: { arguments: '{"path":' } }, { index: 0, type: 'function', function: { name: 'read_file' } }],
    [{ index: 0, id: 'call_0', type: 'function', function: { arguments: '{"path":"a"}' } }],
    [{ index: 1, type: 'function', function: { name: 'read_file', arguments: '"b"}' } }],
  ]],
]

// These tests mutate global fetch; keep them sequential and restore it even on failure.
for (const provider of ['qoder', 'trae']) {
  for (const [name, batches] of scenarios) {
    test(`R07 ${provider}: ${name}`, async () => {
      const fetchBefore = globalThis.fetch
      let requests = 0
      try {
        globalThis.fetch = async (url, options) => {
          requests++
          assert.equal(options.method, 'POST')
          if (provider === 'qoder') {
            assert.equal(new URL(url).pathname, '/algo/api/v2/service/pro/sse/agent_chat_generation')
            return sseResponse([
              ...batches.map(calls => frame({ statusCodeValue: 200, body: JSON.stringify(delta(calls)) })),
              frame({ statusCodeValue: 200, body: JSON.stringify(delta([], 'tool_calls')) }),
              'data: [DONE]\n\n',
            ])
          }
          assert.equal(String(url), 'https://synthetic.invalid/api/agent/v3/llm_utils_chat')
          return sseResponse([
            ...batches.map((calls, i) => `event: output\n${frame({ tool_calls: calls.map(({ function: fn, ...call }) => ({ ...call, [i % 2 ? 'function' : 'function_call']: fn })) })}`),
            `event: done\n${frame({ finish_reason: 'tool_calls' })}`,
          ])
        }
        const result = provider === 'qoder'
          ? await qoder.chatStream(credential, JSON.stringify({ ...base, tools }))
          : await traeChat({ ...base, tools })
        const output = await readSse(result)
        assert.equal(requests, 1)
        assert.deepEqual(output.finishes, ['tool_calls'])
        assert.deepEqual(output.calls, batches.flat())
      } finally {
        globalThis.fetch = fetchBefore
      }
    })
  }
}

for (const serialize of [false, true]) {
  const inputForm = serialize ? 'JSON string' : 'object'
  // 私有线没有 tool_choice 参数:required / any / none / 指定函数 一律降级成
  // 「不发 tool_choice + 追加本轮约束提示」,不再 400 —— 400 会整轮失败,
  // Claude Code 的守卫续跑(桥对 trae 强制 required)就是被它挡死的。
  for (const [label, choice, expect] of [
    ['required', 'required', /必须调用工具/],
    ['any', 'any', /必须调用工具/],
    ['none', 'none', /不要调用工具/],
    ['named function', { type: 'function', function: { name: 'read_file' } }, /read_file/],
    ['anthropic named tool', { type: 'tool', name: 'read_file' }, /read_file/],
    ['object auto', { type: 'auto' }, null],
    ['null', null, null],
  ]) {
    test(`R09 ${inputForm}: ${label} downgrades to auto + directive`, async () => {
      const fetchBefore = globalThis.fetch
      const requests = []
      try {
        globalThis.fetch = async (url, options) => {
          requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) })
          return sseResponse([`event: output\n${frame({ response: 'hello' })}`, `event: done\n${frame({ finish_reason: 'stop' })}`])
        }
        const input = { ...base, tools, tool_choice: choice }
        const result = await traeChat(serialize ? JSON.stringify(input) : input)
        await readSse(result)
        assert.equal(requests.length, 1, 'downgraded request must reach the private gateway exactly once')
        const wire = requests[0].body
        assert.equal('tool_choice' in wire, false, 'private wire must never carry tool_choice')
        assert.ok(Array.isArray(wire.messages) && wire.messages.length > 0)
        const system = wire.messages.find(m => m.role === 'system')
        if (expect) {
          assert.ok(system, 'directive must land in a system message')
          assert.match(JSON.stringify(system), expect)
          assert.equal(wire.messages.filter(m => m.role === 'system').length, 1, 'no second system message')
        } else {
          assert.equal(system, undefined, 'auto/omitted must not inject a directive')
        }
      } finally {
        globalThis.fetch = fetchBefore
      }
    })
  }

  for (const [label, choice] of [
    ['bare function name', 'read_file'],
    ['unknown choice', 'unexpected'],
  ]) {
    test(`R09 ${inputForm}: reject ${label} before fetch`, async () => {
      const fetchBefore = globalThis.fetch
      let requests = 0
      try {
        globalThis.fetch = async () => {
          requests++
          return sseResponse([`event: output\n${frame({ response: 'unexpected success' })}`, `event: done\n${frame({ finish_reason: 'stop' })}`])
        }
        const input = { ...base, tools, tool_choice: choice }
        const result = await traeChat(serialize ? JSON.stringify(input) : input)
        assert.equal(requests, 0, 'unsupported tool_choice must never reach the private gateway')
        assert.equal(result.ok, false)
        assert.equal(result.kind, 'client')
        assert.equal(result.status, 400)
        assert.match(result.message, /llm_utils_chat.*tool_choice/)
        assert.equal(result.response, undefined)
      } finally {
        globalThis.fetch = fetchBefore
      }
    })
  }

  for (const choice of [undefined, 'auto']) {
    test(`R09 ${inputForm}: ${choice ?? 'omitted'} keeps the final private wire`, async () => {
      const fetchBefore = globalThis.fetch
      const requests = []
      try {
        globalThis.fetch = async (url, options) => {
          requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) })
          return sseResponse([`event: output\n${frame({ response: 'hello' })}`, `event: done\n${frame({ finish_reason: 'stop' })}`])
        }
        const input = { ...base, tools, reasoning_effort: 'high', ...(choice === undefined ? {} : { tool_choice: choice }) }
        const output = await readSse(await traeChat(serialize ? JSON.stringify(input) : input))
        assert.deepEqual(output.finishes, ['stop'])
        assert.deepEqual(requests, [{
          url: 'https://synthetic.invalid/api/agent/v3/llm_utils_chat', method: 'POST',
          body: {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            model: 'test-model', config_name: 'test-model', function: 'solo_agent_remote', stream: true,
            tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: '{"type":"object","properties":{"path":{"type":"string"}}}' } }],
            reasoning_effort: 'high',
          },
        }])
      } finally {
        globalThis.fetch = fetchBefore
      }
    })
  }
}
