import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { processEndpointGate } from "../../src/process-gate"
import { admittedFetch, endpointKey, type GateRelease } from "../../src/transport"

const [directory, url, capacity] = process.argv.slice(2) as [string, string, string]
const gate = processEndpointGate(url, Number(capacity), directory)
const abort = new AbortController()
const cancellation = Promise.withResolvers<void>()
let state = "ready"
let release: GateRelease | undefined
let response: Response | undefined
let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
let bootstrap: Database | undefined

function send(event: string, detail: Record<string, unknown> = {}) {
  process.send!({ event, ...detail })
}

async function handle(action: string) {
  if (action === "lease") {
    state = "acquiring"
    const pending = gate.acquire(abort.signal)
    send("attempted")
    try {
      release = await pending
      state = "acquired"
      send("acquired")
    } catch (error) {
      state = "rejected"
      send("rejected", { error: String(error) })
    }
  } else if (action === "stream") {
    state = "acquiring"
    const pending = admittedFetch(async () => {
      send("entered")
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { upstream = controller },
        async cancel(reason) {
          send("upstream-cancel", { reason: String(reason) })
          await cancellation.promise
        },
      }), { headers: { "content-type": "text/event-stream", "x-proof": "kept" } })
    }, gate, url, { signal: abort.signal })
    send("attempted")
    try {
      response = await pending
      state = "headers"
      send("headers", { header: response.headers.get("x-proof") })
    } catch (error) {
      state = "rejected"
      send("rejected", { error: String(error) })
    }
  } else if (action === "read") {
    state = "reading"
    send("reading")
    try {
      const value = await response!.text()
      state = "eof"
      send("eof", { value })
    } catch (error) {
      state = "rejected"
      send("rejected", { error: String(error) })
    }
  } else if (action === "chunk") {
    upstream!.enqueue(new TextEncoder().encode("data: proof\n\n"))
    send("chunked")
  } else if (action === "eof") {
    upstream!.close()
    send("closed")
  } else if (action === "cancel") {
    await response!.body!.cancel("consumer stop")
    state = "cancelled"
    send("cancelled")
  } else if (action === "finish-cancel") {
    cancellation.resolve()
    send("cancel-allowed")
  } else if (action === "abort") {
    abort.abort(new Error("worker stop"))
    send("aborted")
  } else if (action === "release") {
    await release!()
    state = "released"
    send("released")
  } else if (action === "status") {
    send("status", { state })
  } else if (action === "bootstrap") {
    mkdirSync(directory, { recursive: true })
    const key = createHash("sha256").update(endpointKey(url)).digest("hex")
    bootstrap = new Database(join(directory, `${key}.sqlite`), { create: true })
    bootstrap.exec("BEGIN IMMEDIATE")
    bootstrap.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), capacity INTEGER NOT NULL, host TEXT NOT NULL)")
    bootstrap.query("INSERT INTO settings (id, capacity, host) VALUES (1, ?, ?)").run(Number(capacity) + 1, hostname())
    send("bootstrapping")
  } else {
    throw new Error(`Unknown worker action: ${action}`)
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object" || !("action" in message) || typeof message.action !== "string") return
  void handle(message.action).catch((error) => send("error", { error: String(error) }))
})
send("ready", { pid: process.pid })
