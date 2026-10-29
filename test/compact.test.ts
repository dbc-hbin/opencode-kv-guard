import { describe, expect, test } from "bun:test"
import { compactSystem } from "../src/compact"

// Unmodified OpenCode 1.19.4 packages/opencode/src/session/prompt/default.txt.
const builtin = await Bun.file(new URL("./fixtures/default-prompt-1.19.4.txt", import.meta.url)).text()

describe("builtin system prompt compression", () => {
  test("replaces the exact builtin and keeps LF-joined live instructions", () => {
    const system = [`${builtin}\nProject instructions`, "second"]
    const report = compactSystem(system)
    expect(report?.originalChars).toBe(builtin.length)
    expect(report!.replacementChars).toBeLessThan(builtin.length)
    expect(system[0]!.endsWith("\nProject instructions")).toBe(true)
    expect(system[0]!.length).toBe(report!.replacementChars + "\nProject instructions".length)
    expect(system[1]).toBe("second")
  })

  test("leaves a builtin prefix followed by anything other than LF intact", () => {
    for (const header of [`${builtin}X`, builtin.slice(0, -1), `${builtin.slice(0, -2)}?\n`]) {
      const system = [header]
      expect(compactSystem(system)).toBeUndefined()
      expect(system[0]).toBe(header)
    }
  })
})
