// rebuild-chatstream.mjs — truncate upstream.js before the attempt loop and
// append the corrected implementation (manual frame iteration in the attempt
// loop; the first output chunk hands the resumable iterator to the stream,
// whose start() keeps pumping in the background — live deltas).
import fs from 'node:fs'
const p = 'D:/HANXIAO/tools/zcode-ai-connect/zcode-qoder-connect/src/upstream.js'
let s = fs.readFileSync(p, 'utf8')
const marker = "    const isQueueBody = (text) => /10605|isQueued|queueCount/.test(String(text))"
const idx = s.indexOf(marker)
if (idx < 0) { console.log('marker not found'); process.exit(1) }
const head = s.slice(0, idx)

const impl = `    const isQueueBody = (text) => /10605|isQueued|queueCount/.test(String(text))
    const encoder = new TextEncoder()
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 6000))
      const encoded = buildBody()
      let response
      try {
        response = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'cache-control': 'no-cache',
            'accept-encoding': 'identity',
            'x-model-key': modelKey,
            'x-model-source': 'system',
            'user-agent': USER_AGENT,
            ...buildCosyHeaders({ body: encoded, url: chatUrl, credential }),
          },
          body: encoded,
          signal: signal ?? AbortSignal.timeout(300_000),
        })
      } catch (error) {
        return { ok: false, kind: 'server', status: 0, message: \`transport error: \${String(error).slice(0, 160)}\` }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if (isQueueBody(text) && attempt < 3) continue
        return { ok: false, ...classifyStatus(response.status, text), message: \`qoder chat [\${response.status}]: \${text.slice(0, 300)}\` }
      }

      // Two-layer SSE: data frames hold outer {statusCodeValue?, body:string};
      // body carries the inner OpenAI chunk (choices[].delta.{content,
      // reasoning_content, tool_calls}, usage). Frames are iterated MANUALLY
      // so the first output chunk can hand the resumable iterator to the
      // response stream: the 10605 queue envelope retries at this layer, and
      // the stream's start() keeps pumping the rest in the background.
      async function* iterateFrames() {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let index
          while ((index = buffer.indexOf('\\n')) >= 0) {
            let line = buffer.substring(0, index)
            buffer = buffer.substring(index + 1)
            if (line.endsWith('\\r')) line = line.slice(0, -1)
            line = line.trim()
            if (!line.startsWith('data:')) continue
            const rawData = line.substring(5).trim()
            if (!rawData) continue
            if (rawData === '[DONE]') return
            let outer
            try { outer = JSON.parse(rawData) } catch { continue }
            if (typeof outer.statusCodeValue === 'number' && outer.statusCodeValue !== 200) {
              yield { kind: 'status', statusCodeValue: outer.statusCodeValue, bodyText: String(outer.body ?? '') }
              continue
            }
            const bodyText = typeof outer.body === 'string' ? outer.body.trim() : ''
            if (!bodyText) continue
            if (bodyText === '[DONE]') return
            let inner
            try { inner = JSON.parse(bodyText) } catch { continue }
            yield { kind: 'chunk', chunk: inner }
          }
        }
      }
      const frames = iterateFrames()
      const emitChunk = (controller, inner) => {
        const choice = Array.isArray(inner.choices) ? inner.choices[0] : undefined
        if (!choice) return null
        const delta = choice.delta ?? {}
        const carry = {}
        if (typeof delta.content === 'string' && delta.content !== '') carry.content = delta.content
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') carry.reasoning_content = delta.reasoning_content
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          carry.tool_calls = delta.tool_calls.map((call, i) => ({
            index: call.index ?? i,
            ...(call.id ? { id: call.id } : {}),
            type: 'function',
            function: { ...(call.id ? { name: call.function?.name ?? '' } : {}), arguments: call.function?.arguments ?? '' },
          }))
        }
        const finish = typeof choice.finish_reason === 'string' && choice.finish_reason !== '' ? choice.finish_reason : null
        if (Object.keys(carry).length > 0 || finish) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: carry, finish_reason: finish }] }) + '\\n\\n'))
        }
        return finish
      }

      let firstChunk = null
      let statusFail = null
      for (;;) {
        const next = await frames.next()
        if (next.done) break
        const frame = next.value
        if (frame.kind === 'status') {
          if (frame.statusCodeValue !== 200) {
            if (isQueueBody(frame.bodyText) && attempt < 3) break
            statusFail = \`qoder upstream \${frame.statusCodeValue}: \${frame.bodyText.slice(0, 200)}\`
            frames.return?.()
            break
          }
          continue
        }
        firstChunk = frame.chunk
        break
      }
      if (statusFail) {
        frames.return?.()
        return { ok: false, status: 502, kind: 'server', message: statusFail }
      }
      if (!firstChunk) {
        frames.return?.()
        return { ok: false, status: 502, kind: 'server', message: 'qoder 流在首个输出前结束' }
      }

      // The stream's start() resumes the SAME iterator in the background, so
      // deltas flow to the caller as the gateway produces them.
      const stream = new ReadableStream({
        async start(controller) {
          try {
            emitChunk(controller, firstChunk)
            for (;;) {
              const next = await frames.next()
              if (next.done) break
              const frame = next.value
              if (frame.kind === 'status' && frame.statusCodeValue !== 200) break
              if (frame.kind !== 'chunk') continue
              emitChunk(controller, frame.chunk)
            }
            controller.enqueue(encoder.encode('data: [DONE]\\n\\n'))
            controller.close()
          } catch (error) {
            controller.error(error)
          }
        },
        cancel() {
          try { frames.return() } catch {}
        },
      })
      return { ok: true, response: { body: stream } }
    }
    return { ok: false, kind: 'soft_rate', status: 429, message: 'qoder kept queueing (10605) after 4 attempts' }
  }
}
`

fs.writeFileSync(p, head + impl)
console.log('rebuilt: head', head.length, 'B + impl', impl.length, 'B')
