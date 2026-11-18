export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// Error inspection must not re-encode the original response. Oversized errors are passed through without
// classification; the bytes already read are replayed before the upstream tail.
export async function inspectErrorBody(response: Response, limit = 64 * 1024): Promise<{ response: Response; bytes?: Uint8Array<ArrayBuffer> }> {
  if (!response.body) return { response, bytes: new Uint8Array() }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const init = { status: response.status, statusText: response.statusText, headers: response.headers }
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks.push(chunk.value)
      length += chunk.value.byteLength
      if (length > limit) {
        return { response: new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            const buffered = chunks.shift()
            if (buffered) {
              controller.enqueue(buffered)
              return
            }
            const next = await reader.read()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          },
          cancel: (reason) => reader.cancel(reason),
        }, { highWaterMark: 0 }), init) }
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { response: new Response(bytes, init), bytes }
}

export function cancellableResponse(response: Response, signal: AbortSignal, onClose?: () => void) {
  if (!response.body) {
    onClose?.()
    return response
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = response.body.getReader()
  } catch (error) {
    onClose?.()
    throw error
  }
  let finished = false
  let completion: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = (cancel = false, reason?: unknown) => {
    if (completion) return completion
    finished = true
    signal.removeEventListener("abort", abort)
    // Publish completion before cancellation invokes upstream callbacks.
    completion = Promise.resolve().then(async () => {
      try {
        if (cancel) await reader.cancel(reason)
      } finally {
        onClose?.()
      }
    })
    return completion
  }
  const abort = () => {
    if (finished) return
    void finish(true, signal.reason).then(
      () => controller.error(signal.reason),
      (error) => controller.error(error),
    )
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
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
        } catch (closeError) {
          value.error(closeError)
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
