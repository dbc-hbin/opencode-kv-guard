import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { processEndpointGate } from "../src/process-gate"
import { admittedFetch, endpointGate, type AdmissionGate } from "../src/transport"

type Message = { event: string; state?: unknown; error?: unknown; value?: unknown; header?: unknown }
type Pending = { event: string; resolve: (message: Message) => void; reject: (error: Error) => void }
type Lease = { id: string; pid: number; identity: string }

class Worker {
  readonly child: ChildProcess
  readonly ready: Promise<Message>
  private readonly closed = Promise.withResolvers<void>()
  private messages: Message[] = []
  private pending: Pending[] = []
  private failure?: Error
  private stderr = ""

  constructor(directory: string, capacity: number, url = "http://endpoint.test/v1/chat/completions") {
    this.child = fork(fileURLToPath(new URL("./fixtures/process-gate-worker.ts", import.meta.url)), [directory, url, String(capacity)], {
      execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json",
    })
    this.child.stderr!.on("data", (data) => { this.stderr += String(data) })
    this.child.on("message", (raw) => {
      if (!raw || typeof raw !== "object" || !("event" in raw) || typeof raw.event !== "string") return
      const message: Message = { event: raw.event }
      if ("state" in raw) message.state = raw.state
      if ("error" in raw) message.error = raw.error
      if ("value" in raw) message.value = raw.value
      if ("header" in raw) message.header = raw.header
      if (message.event === "error") {
        this.fail(new Error(String(message.error)))
        return
      }
      const index = this.pending.findIndex((item) => item.event === message.event)
      if (index < 0) this.messages.push(message)
      else this.pending.splice(index, 1)[0]!.resolve(message)
    })
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) => {
      this.closed.resolve()
      this.fail(new Error(`Worker exited (${code ?? signal}): ${this.stderr}`))
    })
    this.ready = this.next("ready")
  }

  private fail(error: Error) {
    this.failure = error
    for (const item of this.pending.splice(0)) item.reject(error)
  }

  next(event: string): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure)
    const index = this.messages.findIndex((item) => item.event === event)
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!)
    const { promise, resolve, reject } = Promise.withResolvers<Message>()
    // Failure bound only: successful tests advance exclusively on IPC events.
    const timer = setTimeout(() => {
      this.pending = this.pending.filter((entry) => entry !== item)
      reject(new Error(`No ${event} IPC signal: ${this.stderr}`))
    }, 10_000)
    const item: Pending = {
      event,
      resolve(message) { clearTimeout(timer); resolve(message) },
      reject(error) { clearTimeout(timer); reject(error) },
    }
    this.pending.push(item)
    return promise
  }

  command(action: string, event: string) {
    const result = this.next(event)
    this.child.send({ action })
    return result
  }

  async stop() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL")
    await this.closed.promise
  }
}

async function setup(capacities: number[], urls?: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "kv-process-gate-"))
  const workers = capacities.map((capacity, index) => new Worker(directory, capacity, urls?.[index]))
  try {
    await Promise.all(workers.map((worker) => worker.ready))
  } catch (error) {
    await Promise.all(workers.map((worker) => worker.stop()))
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    directory, workers,
    async close() {
      await Promise.all(workers.map((worker) => worker.stop()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function database(directory: string) {
  const files = await readdir(directory)
  const names = files.filter((file) => file.endsWith(".sqlite"))
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^[a-f0-9]{64}\.sqlite$/)
  return new Database(join(directory, names[0]!), { readonly: true })
}

async function leases(directory: string) {
  const db = await database(directory)
  try {
    return db.query("SELECT id, pid, identity FROM leases").all() as Lease[]
  } finally {
    db.close()
  }
}

describe("same-host process admission", () => {
  test("simultaneous bootstrap shares the cap across normalized endpoints and credentials", async () => {
    const group = await setup([2, 2, 2], [
      "HTTP://user:secret@ENDPOINT.test:80/v1/chat/completions/",
      "http://another:credential@endpoint.test/v1/chat/completions",
      "http://endpoint.test/v1/chat/completions#ignored",
    ])
    const [first, second, third] = group.workers as [Worker, Worker, Worker]
    try {
      await Promise.all([first.command("lease", "acquired"), second.command("lease", "acquired")])
      const thirdAcquired = third.next("acquired")
      await third.command("lease", "attempted")
      expect((await third.command("status", "status")).state).toBe("acquiring")
      expect(await leases(group.directory)).toHaveLength(2)
      await first.command("release", "released")
      await thirdAcquired
      expect((await leases(group.directory)).map((lease) => lease.pid).sort()).toEqual([second.child.pid!, third.child.pid!].sort())
      await Promise.all([second.command("release", "released"), third.command("release", "released")])
      expect(await leases(group.directory)).toEqual([])
    } finally {
      await group.close()
    }
  }, 20_000)

  test("headers and upstream close retain the lease until the response stream is consumed to EOF", async () => {
    const group = await setup([1, 1])
    const [first, second] = group.workers as [Worker, Worker]
    try {
      const entered = first.next("entered")
      expect((await first.command("stream", "headers")).header).toBe("kept")
      await entered
      const secondAcquired = second.next("acquired")
      await second.command("lease", "attempted")
      await first.command("chunk", "chunked")
      await first.command("eof", "closed")
      expect((await second.command("status", "status")).state).toBe("acquiring")
      expect((await leases(group.directory))[0]!.pid).toBe(first.child.pid!)
      expect((await first.command("read", "eof")).value).toBe("data: proof\n\n")
      await secondAcquired
      expect((await leases(group.directory))[0]!.pid).toBe(second.child.pid!)
      await second.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)

  test("a cancelled waiter never acquires or leaves an owner row", async () => {
    const group = await setup([1, 1, 1])
    const [first, second, third] = group.workers as [Worker, Worker, Worker]
    try {
      await first.command("lease", "acquired")
      await second.command("lease", "attempted")
      const rejected = second.next("rejected")
      await second.command("abort", "aborted")
      expect((await rejected).error).toContain("worker stop")
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([first.child.pid!])
      await first.command("release", "released")
      await third.command("lease", "acquired")
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([third.child.pid!])
      await third.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)

  test.each(["abort", "cancel"])("%s waits for upstream cancellation before releasing capacity", async (action) => {
    const group = await setup([1, 1])
    const [first, second] = group.workers as [Worker, Worker]
    try {
      await first.command("stream", "headers")
      const secondAcquired = second.next("acquired")
      await second.command("lease", "attempted")
      const upstreamCancelled = first.next("upstream-cancel")
      const ended = first.next(action === "abort" ? "rejected" : "cancelled")
      first.child.send({ action })
      await upstreamCancelled
      if (action === "abort") await first.command("read", "reading")
      expect((await second.command("status", "status")).state).toBe("acquiring")
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([first.child.pid!])
      await first.command("finish-cancel", "cancel-allowed")
      await ended
      await secondAcquired
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([second.child.pid!])
      await second.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)

  test("two waiters recover a killed owner without both taking a one-slot gate", async () => {
    const group = await setup([1, 1, 1])
    const [owner, second, third] = group.workers as [Worker, Worker, Worker]
    try {
      await owner.command("lease", "acquired")
      const secondAcquired = second.next("acquired")
      const thirdAcquired = third.next("acquired")
      await Promise.all([second.command("lease", "attempted"), third.command("lease", "attempted")])
      await owner.stop()
      const winner = await Promise.race([secondAcquired.then(() => second), thirdAcquired.then(() => third)])
      const loser = winner === second ? third : second
      expect((await loser.command("status", "status")).state).toBe("acquiring")
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([winner.child.pid!])
      await winner.command("release", "released")
      await Promise.all([secondAcquired, thirdAcquired])
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([loser.child.pid!])
      await loser.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)

  test("a bootstrap crash rolls back uncommitted configuration and releases the SQLite lock", async () => {
    const group = await setup([1, 1])
    const [owner, waiter] = group.workers as [Worker, Worker]
    try {
      await owner.command("bootstrap", "bootstrapping")
      const acquired = waiter.next("acquired")
      await waiter.command("lease", "attempted")
      expect((await waiter.command("status", "status")).state).toBe("acquiring")
      await owner.stop()
      await acquired
      const db = await database(group.directory)
      try {
        expect(db.query("SELECT capacity FROM settings WHERE id = 1").get()).toEqual({ capacity: 1 })
      } finally {
        db.close()
      }
      await waiter.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)

  test("capacity mismatches fail without modifying the admitted owner's lease", async () => {
    const group = await setup([1, 2])
    const [first, second] = group.workers as [Worker, Worker]
    try {
      await first.command("lease", "acquired")
      expect((await second.command("lease", "rejected")).error).toContain("conflicting maxConcurrent")
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([first.child.pid!])
      await first.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)

  test("a reused PID identity is recoverable, and an old release cannot delete the replacement", async () => {
    const group = await setup([1, 1])
    const [first, second] = group.workers as [Worker, Worker]
    try {
      await first.command("lease", "acquired")
      const files = await readdir(group.directory)
      const db = new Database(join(group.directory, files.find((file) => file.endsWith(".sqlite"))!))
      try {
        // Model an old process whose PID now belongs to this live test process.
        db.query("UPDATE leases SET pid = ?, identity = ?").run(process.pid, "previous-process-start")
      } finally {
        db.close()
      }
      await second.command("lease", "acquired")
      await first.command("release", "released")
      expect((await leases(group.directory)).map((lease) => lease.pid)).toEqual([second.child.pid!])
      await second.command("release", "released")
    } finally {
      await group.close()
    }
  }, 20_000)
})

test("in-process endpoint normalization and mismatch errors do not expose credentials", () => {
  const gate = endpointGate("http://alice:secret@NORMALIZE.test:80/v1/", 1)
  expect(endpointGate("http://bob:password@normalize.test/v1#ignored", 1)).toBe(gate)
  expect(() => endpointGate("http://alice:secret@normalize.test/v1", 2)).toThrow("conflicting maxConcurrent for endpoint")
  expect(() => processEndpointGate("http://endpoint.test", 0, "/unused")).toThrow("positive safe integer")
})

test("pre-aborted admission creates no state, and a repeated release preserves its replacement", async () => {
  const group = await setup([])
  try {
    const gate = processEndpointGate("http://endpoint.test/v1", 1, group.directory)
    const abort = new AbortController()
    abort.abort(new Error("already stopped"))
    await expect(gate.acquire(abort.signal)).rejects.toThrow("already stopped")
    expect(await readdir(group.directory)).toEqual([])
    const release = await gate.acquire()
    await Promise.all([release(), release()])
    const replacement = await gate.acquire()
    await release()
    expect(await leases(group.directory)).toHaveLength(1)
    await replacement()
    expect(await leases(group.directory)).toEqual([])
  } finally {
    await group.close()
  }
})

test.each(["eof", "cancel", "abort", "acquire-abort", "fetch-error", "no-body", "body-error", "locked-body"])("%s completion awaits asynchronous lease release", async (mode) => {
  const releasing = Promise.withResolvers<void>()
  const permission = Promise.withResolvers<void>()
  const gate: AdmissionGate = {
    capacity: 1,
    async acquire() {
      if (mode === "acquire-abort") abort.abort(new Error("stop before fetch"))
      return async () => {
        releasing.resolve()
        await permission.promise
        throw new Error("release-failed")
      }
    },
  }
  const abort = new AbortController()
  const response = admittedFetch(async () => {
    if (mode === "fetch-error") throw new Error("fetch-failed")
    if (mode === "no-body") return new Response(null, { status: 204 })
    if (mode === "body-error") return new Response(new ReadableStream({ pull(controller) { controller.error(new Error("body-failed")) } }))
    if (mode === "locked-body") {
      const locked = new Response("proof")
      locked.body!.getReader()
      return locked
    }
    if (mode === "abort" || mode === "cancel") return new Response(new ReadableStream())
    return new Response("proof")
  }, gate, "http://endpoint.test", { signal: abort.signal })
  let terminal: Promise<unknown>
  if (mode === "fetch-error" || mode === "no-body" || mode === "acquire-abort" || mode === "locked-body") terminal = response
  else {
    const value = await response
    if (mode === "cancel") terminal = value.body!.cancel("stop")
    else {
      terminal = value.text()
      if (mode === "abort") abort.abort(new Error("stop"))
    }
  }
  await releasing.promise
  permission.resolve()
  await expect(terminal).rejects.toThrow("release-failed")
})
