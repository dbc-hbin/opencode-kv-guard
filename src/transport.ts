export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type GateRelease = () => void | Promise<void>
export type AdmissionGate = { readonly capacity: number; acquire(signal?: AbortSignal): Promise<GateRelease> }

type Waiter = { grant: (release: () => void) => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void }

export class Gate implements AdmissionGate {
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
export function endpointKey(baseURL: string) {
  const url = new URL(baseURL)
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`
}

export function endpointGate(baseURL: string, capacity: number) {
  const key = endpointKey(baseURL)
  const existing = gates.get(key)
  if (existing) {
    if (existing.capacity !== capacity) throw new Error("KV guard: conflicting maxConcurrent for endpoint")
    return existing
  }
  const gate = new Gate(capacity)
  gates.set(key, gate)
  return gate
}

export async function admittedFetch(fetch: Fetch, gate: AdmissionGate, input: RequestInfo | URL, init?: RequestInit) {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const release = await gate.acquire(signal ?? undefined)
  let response: Response
  try {
    signal?.throwIfAborted()
    response = await fetch(input, init)
  } catch (error) {
    await release()
    throw error
  }
  if (!response.body) {
    await release()
    return response
  }

  const reader = response.body.getReader()
  let finished = false
  let completion: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = (cancel = false, reason?: unknown) => {
    if (completion) return completion
    finished = true
    signal?.removeEventListener("abort", abort)
    // Publish completion before cancellation invokes upstream callbacks.
    completion = Promise.resolve().then(async () => {
      try {
        if (cancel) await reader.cancel(reason)
      } finally {
        await release()
      }
    })
    return completion
  }
  const abort = () => {
    if (finished) return
    void finish(true, signal!.reason).then(
      () => controller.error(signal!.reason),
      (error) => controller.error(error),
    )
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    },
    async pull(value) {
      let item: Awaited<ReturnType<typeof reader.read>>
      try {
        item = await reader.read()
      } catch (error) {
        if (finished) return
        try {
          await finish()
          value.error(error)
        } catch (releaseError) {
          value.error(releaseError)
        }
        return
      }
      if (finished) return
      if (item.done) {
        try {
          await finish()
          value.close()
        } catch (error) {
          value.error(error)
        }
      } else {
        value.enqueue(item.value)
      }
    },
    async cancel(reason) {
      await finish(true, reason)
    },
  }, { highWaterMark: 0 })
  // Preserve status, headers and SSE bytes, including upstream error bodies.
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
