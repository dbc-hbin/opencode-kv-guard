import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { maxOutputTokens, runSmoke } from "./fixture"
import type { Capture } from "./fixture"
import { textStream } from "./openai-fixture"

const oldTurn = `OLD_USER_TURN_${randomUUID()}`
const recentTurn = `RECENT_USER_TURN_${randomUUID()}`
const nextTurn = `AFTER_COMPACTION_${randomUUID()}`
const summary = `## Objective\n- Retain the completed investigation (${randomUUID()}).`
const conclusion = "Answer after replay."
const normal: Capture[] = []
const compactions: Capture[] = []
let compacting = false

await runSmoke("compaction", (call) => {
  if (compacting) {
    compactions.push(call)
    return textStream(summary)
  }
  normal.push(call)
  return textStream(normal.length === 3 ? conclusion : `Observation ${normal.length}.`)
}, async ({ launch }) => {
  const runtime = await launch("compaction")
  await runtime.verify()
  const session = await runtime.create("Native manual compaction fixture")
  for (const text of [oldTurn, recentTurn]) {
    await runtime.prompt(session, text)
    await runtime.wait(session, "succeeded")
  }
  assert.equal(normal.length, 2, "the two seed turns must both reach the provider")

  compacting = true
  await runtime.compact(session)
  const compacted = (await runtime.wait(session, "succeeded")).filter((message) => message.type === "compaction")
  compacting = false
  assert.deepEqual(compacted.map(({ status, reason, summary }) => ({ status, reason, summary })), [
    { status: "completed", reason: "manual", summary },
  ], `Stored compaction: ${JSON.stringify(compacted)}`)
  assert.equal(compactions.length, 1, "the native /compact route must perform one summary inference")
  const [capture] = compactions
  assert.ok(capture)
  assert.equal(capture.body.stream, true, "native v2 summary inference stays streaming")
  assert.ok(JSON.stringify(capture.body.messages).includes(oldTurn), "the summary request must cover the older exchange")

  await runtime.prompt(session, nextTurn)
  const stored = await runtime.wait(session, "succeeded")
  assert.equal(normal.length, 3)
  const replay = normal.at(-1)
  assert.ok(replay)
  assert.equal(replay.headers.get("x-opencode-session-id"), session)
  assert.equal(replay.headers.get("x-session-affinity"), session)
  assert.equal(replay.headers.has("x-litellm-session-id"), false)
  assert.equal(replay.body.max_tokens, maxOutputTokens)
  const replayText = JSON.stringify(replay.body.messages)
  assert.ok(replay.body.messages.some(({ content }) => typeof content === "string" && content.includes(summary)), "the actual later request must replay the saved summary")
  assert.ok(replayText.includes(recentTurn), "the native kept tail must remain available")
  assert.ok(replayText.includes(nextTurn), "the current user instruction must remain available")
  assert.ok(!replayText.includes(oldTurn), "the summarized original must not be replayed verbatim")

  assert.deepEqual(stored.filter((message) => message.type === "user").map((message) => message.text), [oldTurn, recentTurn, nextTurn])
  assert.ok(stored.some((message) => message.type === "assistant" && message.content?.some((part) => part.text === conclusion)))
  return { session, normalRequests: normal.length, summaryRequests: compactions.length, persistedOriginalTurns: 3, nativeSummaryReplayed: true }
})
