export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Waiter = { grant: (release: () => void) => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void }

export class Gate {
  private active = 0
  private waiting: Waiter[] = []

  constructor(readonly capacity: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    const { promise, resolve: grant, reject } = Promise.withResolvers<() => void>()
    const waiter: Waiter = {
      grant, reject, signal,
      abort: () => {
        this.waiting = this.waiting.filter((item) => item !== waiter)
        reject(signal!.reason)
      },
    }
    if (signal?.aborted) reject(signal.reason)
    else {
      signal?.addEventListener("abort", waiter.abort, { once: true })
      this.waiting.push(waiter)
      this.drain()
    }
    return promise
  }

  private drain() {
    while (this.active < this.capacity && this.waiting.length) {
      const waiter = this.waiting.shift()!
      waiter.signal?.removeEventListener("abort", waiter.abort)
      this.active++
      let released = false
      waiter.grant(() => {
        if (released) return
        released = true
        this.active--
        this.drain()
      })
    }
  }
}

// Shared by project instances importing this module, never by other OS processes.
const gates = new Map<string, Gate>()
export function endpointGate(baseURL: string, capacity: number) {
  const key = new URL(baseURL).href.replace(/\/$/, "")
  const existing = gates.get(key)
  if (existing) {
    if (existing.capacity !== capacity) throw new Error(`KV guard: conflicting maxConcurrent for ${key}`)
    return existing
  }
  const gate = new Gate(capacity)
  gates.set(key, gate)
  return gate
}

export async function admittedFetch(fetch: Fetch, gate: Gate, input: RequestInfo | URL, init?: RequestInit) {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const release = await gate.acquire(signal ?? undefined)
  let response: Response
  try {
    signal?.throwIfAborted()
    response = await fetch(input, init)
  } catch (error) {
    release()
    throw error
  }
  if (!response.body) {
    release()
    return response
  }

  const reader = response.body.getReader()
  let finished = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = () => {
    if (finished) return false
    finished = true
    signal?.removeEventListener("abort", abort)
    release()
    return true
  }
  const abort = () => {
    if (!finish()) return
    controller.error(signal!.reason)
    void reader.cancel(signal!.reason).catch(() => {})
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    },
    async pull(value) {
      try {
        const item = await reader.read()
        if (finished) return
        if (item.done) {
          finish()
          value.close()
        } else value.enqueue(item.value)
      } catch (error) {
        if (finish()) value.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        finish()
      }
    },
  }, { highWaterMark: 0 })
  // Preserve status, headers and SSE bytes, including upstream error bodies.
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
