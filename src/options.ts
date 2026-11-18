import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Schema } from "effect"
import { compactionOptions } from "./compaction-policy"
import { parseModelBudgets } from "./model-budget"

const limit = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
const flag = Schema.optionalKey(Schema.Boolean)
const read = Schema.decodeUnknownSync(Schema.Struct({
  providers: Schema.NonEmptyArray(Schema.NonEmptyString.check(Schema.isTrimmed())),
  maxOutputTokens: limit,
  stateDirectory: Schema.optionalKey(Schema.String.check(Schema.makeFilter(isAbsolute))),
  diagnostics: flag,
  persistence: flag,
  prefixGuard: flag,
  usageAccounting: flag,
  compaction: Schema.optionalKey(Schema.Unknown),
  prefixHandoff: flag,
  speculativeCompaction: flag,
  supersedeReads: flag,
  compactPrompt: flag,
  compactTools: flag,
  compactSkills: flag,
  modelBudgets: Schema.optionalKey(Schema.Unknown),
  shrinkToolOutputs: Schema.optionalKey(Schema.Union([
    Schema.Literal(false),
    Schema.Struct({ maxBytes: limit, maxLines: limit }),
  ])),
}), { onExcessProperty: "error" })

export function parseOptions(input: unknown) {
  const options = read(input)
  return {
    ...options,
    stateDirectory: options.stateDirectory ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-kv-guard"),
    diagnostics: options.diagnostics ?? false,
    persistence: options.persistence ?? true,
    prefixGuard: options.prefixGuard ?? true,
    usageAccounting: options.usageAccounting ?? true,
    compaction: compactionOptions(options.compaction === undefined ? false : options.compaction),
    modelBudgets: parseModelBudgets(options.modelBudgets),
  }
}
