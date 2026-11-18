import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { apiKey, FixtureError, maxOutputTokens, providerID, runSmoke, within } from "./fixture"
import type { Capture, Runtime } from "./fixture"
import { completion, streamHeaders, textStream, toolStream } from "./openai-fixture"

const successes = "FIXTURE_ANSWER"
const deniedContent = randomUUID()
const readContent = randomUUID()
const declinePrompt = "DECLINE_DIRECT_READ"
const feedbackPrompt = "CORRECT_DIRECT_READ"
const feedback = "Use a different file."
const declinedRequests: Capture[] = []
const correctedRequests: Capture[] = []
const transportError = "a rejected loopback completion"
const codePrompt = "NATIVE_CODE_MODE"
const directPrompt = "DIRECT_TOOL_ROUND_TRIP"
type Exchange = {
  readonly arrived: PromiseWithResolvers<Capture>
  readonly reply: (call: Capture) => Response
}
const exchanges = new Map<string, Exchange>()
const codeRequests: Capture[] = []
const directRequests: Capture[] = []
const fileTools = ["read", "glob", "grep"]

function exchange(prompt: string, reply: Exchange["reply"]) {
  const arrived = Promise.withResolvers<Capture>()
  exchanges.set(prompt, { arrived, reply })
  return arrived.promise
}

function heldStream(call: Capture, finish: Promise<void>, onAbort?: () => void) {
  const reply = completion()
  const bytes = new TextEncoder()
  let canceled = false
  if (onAbort) call.signal.addEventListener("abort", onAbort, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.encode(reply.delta({ role: "assistant", content: successes })))
      void finish.then(() => {
        if (canceled || call.signal.aborted) return
        controller.enqueue(bytes.encode(reply.end("stop")))
        controller.close()
      })
    },
    cancel() { canceled = true; onAbort?.() },
  })
  return new Response(stream, { headers: streamHeaders })
}

function assertRequest(call: Capture, session: string) {
  assert.equal(call.headers.get("authorization"), `Bearer ${apiKey}`)
  assert.equal(call.headers.get("x-opencode-session-id"), session)
  assert.equal(call.headers.get("x-session-affinity"), session)
  assert.equal(call.headers.has("x-litellm-session-id"), false)
  assert.equal(call.body.model, providerID)
  assert.equal(call.body.stream, true)
  assert.equal(call.body.max_tokens, maxOutputTokens, "configured output ceiling must reach the actual provider body")
  assert.equal(call.body.stream_options?.include_usage, true, "request must request streamed usage")
}

async function observeEvent(runtime: Runtime, session: string, witness: {
  readonly type: "session.step.first-token" | "permission.asked"
  readonly seen?: (data: Record<string, unknown>) => Promise<void>
  readonly act: () => Promise<unknown>
}) {
  const { type, act } = witness
  const response = await runtime.events([type, "session.execution.failed", "session.execution.interrupted", "session.execution.succeeded"])
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream\b/)
  assert.ok(response.body, "live event feed must have a body")
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const envelope = z.object({ type: z.string(), data: z.looseObject({ sessionID: z.string().optional() }) })
  async function* events() {
    let pending = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new FixtureError(`Live event feed ended before ${type}`, session)
      const lines = (pending + value).split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines)
        if (line.startsWith("data: ")) yield envelope.parse(JSON.parse(line.slice(6)))
    }
  }
  const feed = events()
  try {
    const connected = await within(`Subscribing to live events for ${session}`, feed.next())
    assert.equal(connected.done ? undefined : connected.value.type, "server.connected")
    await Promise.all([
      within(`Waiting for ${type} in ${session}`, (async () => {
        for await (const event of feed) {
          if (event.data.sessionID !== session) continue
          assert.equal(event.type, type, `Session ${session}: ${JSON.stringify(event)}`)
          await witness.seen?.(event.data)
          return
        }
      })()),
      act(),
    ])
  } finally {
    await reader.cancel()
  }
}

async function overlapScenario(first: Runtime, second: Runtime) {
  const owner = await first.create("First overlapping session")
  const contender = await second.create("Second overlapping session")
  assert.notEqual(owner, contender, "the overlapping requests must belong to separate sessions")
  const ownerPrompt = "OVERLAP_FIRST"
  const contenderPrompt = "OVERLAP_SECOND"
  const finish = Promise.withResolvers<void>()
  const left = exchange(ownerPrompt, (call) => heldStream(call, finish.promise))
  const right = exchange(contenderPrompt, () => textStream(successes))
  try {
    await observeEvent(first, owner, { type: "session.step.first-token", act: () => first.prompt(owner, ownerPrompt) })
    const initial = await within("First session at the provider", left)
    assertRequest(initial, owner)
    await second.prompt(contender, contenderPrompt)
    const next = await within("Second session at the provider before the first response ends", right)
    assertRequest(next, contender)
    assert.equal(next.url, initial.url, "the sessions must overlap at the exact same provider URL")
  } finally {
    finish.resolve()
  }
  const messages = await Promise.all([first.wait(owner, "succeeded"), second.wait(contender, "succeeded")])
  for (const stored of messages) assert.ok(stored.some((message) => message.content?.some((part) => part.text === successes)))
}

async function responseLifecycle(runtime: Runtime) {
  const failed = await runtime.create("Provider HTTP error")
  const failedPrompt = "PROVIDER_ERROR"
  const failure = exchange(failedPrompt, () => Response.json({
    error: { message: transportError, type: "invalid_request_error" },
  }, { status: 400 }))
  await runtime.prompt(failed, failedPrompt)
  assertRequest(await within("Failing session at the provider", failure), failed)
  assert.ok(JSON.stringify(await runtime.wait(failed, "failed")).includes(transportError))

  const interrupted = await runtime.create("Interrupted provider stream")
  const interruptedPrompt = "PROVIDER_INTERRUPT"
  const finish = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const arrival = exchange(interruptedPrompt, (call) => heldStream(call, finish.promise, aborted.resolve))
  try {
    await observeEvent(runtime, interrupted, {
      type: "session.step.first-token", act: () => runtime.prompt(interrupted, interruptedPrompt),
    })
    assertRequest(await within("Interrupted session at the provider", arrival), interrupted)
    await runtime.interrupt(interrupted)
    await within("Provider observed the interrupted stream", aborted.promise)
    await runtime.wait(interrupted, "interrupted")
  } finally {
    finish.resolve()
  }
}

const tools = (call: Capture) => call.body.tools?.flatMap((tool) => tool.function ? [tool.function.name] : []) ?? []
function toolResult(call: Capture) {
  const result = call.body.messages.findLast((message) => message.role === "tool")
  assert.ok(result?.content !== undefined, "model must receive the tool's result before continuing")
  return JSON.stringify(result.content)
}

await runSmoke("surface", (call) => {
  const prompt = call.body.messages.findLast((message) => message.role === "user")?.content
  assert.ok(typeof prompt === "string", JSON.stringify(call.body.messages))
  const controlled = exchanges.get(prompt)
  if (controlled) {
    assert.equal(exchanges.delete(prompt), true)
    controlled.arrived.resolve(call)
    return controlled.reply(call)
  }
  if (prompt === directPrompt) {
    directRequests.push(call)
    if (directRequests.length === 1) {
      assert.deepEqual(fileTools.filter((name) => tools(call).includes(name)), fileTools, "stock file tools stay direct")
      return toolStream("read", { path: "read-target.txt" })
    }
    assert.equal(directRequests.length, 2)
    assert.ok(toolResult(call).includes(readContent), "direct read must return actual file contents")
    return textStream(successes)
  }
  if (prompt === declinePrompt || prompt === feedbackPrompt) {
    const requests = prompt === declinePrompt ? declinedRequests : correctedRequests
    requests.push(call)
    if (requests.length === 1) return toolStream("read", { path: "denied.txt" })
    assert.equal(prompt, feedbackPrompt, "a plain decline must interrupt before the next inference")
    assert.equal(requests.length, 2)
    assert.ok(toolResult(call).includes(feedback), "a rejection with feedback must return that correction")
    assert.ok(!toolResult(call).includes(deniedContent))
    return textStream(successes)
  }
  assert.equal(prompt, codePrompt, "only declared fixture prompts may reach the provider")
  codeRequests.push(call)
  if (codeRequests.length === 1) {
    assert.ok(tools(call).includes("execute"))
    return toolStream("execute", { code: 'return await tools.opencode.session_rename({title:"Native Code Mode verified"})' })
  }
  assert.equal(codeRequests.length, 2)
  assert.ok(toolResult(call).includes("Native Code Mode verified"))
  return textStream(successes)
}, async ({ launch }) => {
  const direct = await launch("direct")
  const code = await launch("native")
  const [a, b] = await Promise.all([direct.verify(), code.verify()])
  assert.notEqual(a.pid, b.pid, "test needs independent OpenCode processes")
  await Bun.write(join(direct.directory, "read-target.txt"), readContent)
  await Bun.write(join(direct.directory, "denied.txt"), deniedContent)
  const directSession = await direct.create("Direct file tool fixture")
  await direct.prompt(directSession, directPrompt)
  const directMessages = await direct.wait(directSession, "succeeded")
  assert.equal(directRequests.length, 2)
  assert.ok(directMessages.some((message) => message.content?.some((part) => part.text === successes)))
  for (const call of directRequests) assertRequest(call, directSession)

  const codeSession = await code.create("Native Code Mode fixture")
  await code.prompt(codeSession, codePrompt)
  const messages = await code.wait(codeSession, "succeeded")
  assert.equal(codeRequests.length, 2)
  for (const call of codeRequests) assertRequest(call, codeSession)
  assert.ok(messages.some((message) => message.content?.some((part) => part.name === "execute" && part.state?.status === "completed")))

  for (const prompt of [declinePrompt, feedbackPrompt]) {
    const session = await direct.create(prompt, [{ action: "read", resource: "denied.txt", effect: "ask" }])
    await observeEvent(direct, session, {
      type: "permission.asked",
      act: () => direct.prompt(session, prompt),
      seen: async (data) => {
        const req = z.object({ id: z.string(), action: z.literal("read"), resources: z.array(z.string()) }).parse(data)
        assert.ok(req.resources.includes("denied.txt"))
        await direct.decline(session, req.id, prompt === feedbackPrompt ? feedback : undefined)
      },
    })
    const stored = await direct.wait(session, prompt === declinePrompt ? "interrupted" : "succeeded")
    assert.ok(!JSON.stringify(stored).includes(deniedContent))
  }
  assert.equal(declinedRequests.length, 1)
  assert.equal(correctedRequests.length, 2)

  await overlapScenario(direct, code)
  await responseLifecycle(direct)
  return {
    serverPIDs: [a.pid, b.pid], directRequests: directRequests.length, codeModeRequests: codeRequests.length,
    sameEndpointOverlap: true, streamInterrupted: true, providerErrorPreserved: true,
  }
})
