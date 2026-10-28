import { createHash } from "node:crypto"

// Exact provider() outputs from OpenCode 1.19.4, commit
// 148842ef7cb1bc34192b3fff57d0f9721ab9c801, packages/opencode/src/session/prompt/.
// JavaScript string lengths and UTF-8 SHA-256 include the source's final LF.
// meta.txt is recognized only after provider() substitutes its model name.
const builtins = [
  [8212, "8324e4cf58eb45d4d9d6fd120f5e8da59e0548de48e7e6aefcdfbf2923f40b4e"], // anthropic.txt
  [8528, "962fbf3cb3ec659c9a5244425ee2e7bb141ad4428f489a630a7738566880dc6a"], // default.txt
  [11078, "a384d7b485829c1fe43bd6deaae10466db2c16b8cba045764538974f737958ba"], // beast.txt
  [15372, "921750803b0314b88b8adc996e2afcf1a61fd7d9dd6dfcf812baeadac1468cf3"], // gemini.txt
  [9274, "83a66a46a5febbc21454161d5f053638b22d25d95e09d77b8f6da33debc848ad"], // gpt.txt
  [4076, "46d386ea8dd8db5734d06f6ec1d04c566f1224b1afa5bc5b0ccefd6f853281f9"], // gpt-astra.txt
  [8683, "ade9199b00df5aa3b51bb02b8e8c711f3e0de224345aef7df9f31d3ea08a5bc7"], // kimi.txt
  [9118, "0c57a9de48efcc578ac6f9623f919713fffdc430e43ab6e8e65d336935932987"], // meta.txt: Muse Glimmer
  [9114, "9a23cf76db64366821b001a08f13d475626e093c45c72d997b573588d0d03bd1"], // meta.txt: Muse Spark
  [7362, "c30bca40693a47965e25ceac3f02d3709712af7abeab1278bba53a9efcffa928"], // codex.txt
  [7748, "0019dc1d018d08c1b5a065d10896e22d2615d33580088f44aefc3a042a46ebe2"], // trinity.txt
] as const

const compactPrompt = `You are OpenCode, a coding agent. Fulfill the user's intent end to end with minimal, correct changes; answer questions without unsolicited edits.

Obey applicable system, developer, project/AGENTS.md, skill, MCP and user instructions in priority order, tool schemas and permissions. Harness <system-reminder> blocks are instructions. In plan/read-only mode, no edits, write commands, config changes or commits; ask the user to switch modes for edits.

Read relevant files/config first. Reuse project conventions and installed libraries. Fix root causes, stay scoped, preserve others' changes, and ask about direct conflicts. Clarify material ambiguity; obtain approval for a new application's plan before implementation.

Never expose/log/commit secrets. Access outside the working directory only if explicitly instructed; ask before installing/deleting outside it, and isolate third-party package installs. Require explicit confirmation for every git mutation and destructive/irreversible action; never auto-stage/commit/amend or revert others' work. Explain state-changing shell commands and impact. Respect denied/cancelled actions; never bypass permissions.

Use tools to do real work, text to communicate. Prefer dedicated file/search/edit tools to shell. Parallelize independent calls, sequence dependencies, and never guess arguments/results. Delegate only if user or applicable instructions request it.

Run repository-prescribed and relevant tests/build/lint/typechecks, and inspect generated/visible output as needed. Report actual evidence, failures, uncertainty and blockers; never claim unrun checks passed or fabricate facts/URLs.

Write concise, direct, factual replies in the user's language, with useful file:line references; no unrequested emojis. Consult https://opencode.ai/docs for OpenCode feature questions; feedback: https://github.com/anomalyco/opencode/issues.
`

export function compactSystem(system: string[]): { originalChars: number; replacementChars: number } | undefined {
  const header = system[0]
  if (!header) return

  for (const [length, hash] of builtins) {
    // request.ts joins the complete builtin and live instructions with LF.
    // Refuse a matching prefix followed by anything other than that delimiter.
    if (header.length < length || (header.length !== length && header[length] !== "\n")) continue
    if (createHash("sha256").update(header.slice(0, length)).digest("hex") !== hash) continue

    system[0] = compactPrompt + header.slice(length)
    return { originalChars: length, replacementChars: compactPrompt.length }
  }
}
