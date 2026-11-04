import type { ChatBody } from "./compaction"
import { digest } from "./shared"

// Exact OpenCode 1.19.4 defaults. Match the complete policy/template before
// replacing defaults; configured prompts and plugin overrides remain authoritative.
const systemLength = 630
const systemHash = "552db0de0af1873a8acd4a631e2548345d4c43192de1d9be69c8feab4b41f80c"
const templateLength = 1107
const templateHash = "f508afb34ee881f5d317eda1fa22dff19426c257377796dad5b97436f4436e6a"
const updateLength = 952
const updateHash = "f089eb74bde1fb476647bae165d276f4e214eb32b5515f0d86bda9a0f26b6c15"
const start = "Here is the conversation so far:\n\n<conversation>\n"
const initial = "\n\nCreate a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work."
const priorStart = "\n\nHere is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n"

export function nativeCompactionInput(body: ChatBody) {
  const system = body.messages[0]
  const user = body.messages[1]
  if (body.messages.length !== 2 || system?.role !== "system" || typeof system.content !== "string" || user?.role !== "user" || typeof user.content !== "string") return
  if (digest(system.content.slice(0, systemLength)) !== systemHash || system.content.length > systemLength && system.content[systemLength] !== "\n") return
  const text = user.content
  if (!text.startsWith(start)) return
  const templateAt = text.lastIndexOf("\n\nOutput exactly the Markdown structure shown inside <template>") + 2
  if (templateAt < 2 || digest(text.slice(templateAt, templateAt + templateLength)) !== templateHash) return
  const context = [system.content.slice(systemLength).trim(), text.slice(templateAt + templateLength).trim()].filter(Boolean)
  let conversation = text.slice(0, templateAt - 2)
  let previous: string | undefined
  if (conversation.endsWith(initial)) conversation = conversation.slice(0, -initial.length)
  else {
    if (digest(conversation.slice(-updateLength)) !== updateHash) return
    conversation = conversation.slice(0, -updateLength - 2)
    if (!conversation.endsWith("\n</prior-summary>")) return
    const at = conversation.lastIndexOf(priorStart)
    if (at < 0) return
    previous = conversation.slice(at + priorStart.length, -"\n</prior-summary>".length)
    conversation = conversation.slice(0, at)
  }
  if (!conversation.endsWith("\n</conversation>")) return
  return { conversation: conversation.slice(start.length, -"\n</conversation>".length), previous, context }
}
