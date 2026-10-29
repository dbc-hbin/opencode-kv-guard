import { digest as hash } from "./shared"

// Exact builtin tool descriptions from OpenCode 1.19.4, commit
// 148842ef7cb1bc34192b3fff57d0f9721ab9c801, packages/opencode/src/tool/.
// Hashes are UTF-8 SHA-256 of the wire description. Rendered values (shell,
// temp path, limits, year, agent list) are spliced out as \0name\0 before
// hashing and carried into the compact text unchanged. Parameter schemas are
// never modified; each compact text states the same parameter contract.

const fixed: Record<string, { length: number; hash: string; compact: string }> = {
  read: {
    length: 1158, hash: "98ee843341c2dab2227add0019e48d4b2f0f00f9b042b853d1ee52bb34e6363d", // read.txt
    compact: `Reads a file or directory. \`filePath\` should be absolute. \`offset\` is the 1-indexed start line; \`limit\` is the maximum line count (default 2000). Call again with a larger offset for later sections.
File lines are returned as \`<line>: <content>\` (e.g. \`1: foo\`); lines over 2000 characters are truncated. Directories list one entry per line, with a trailing \`/\` for subdirectories. Images and PDFs are returned as attachments. A missing path returns an error.
Use Grep for specific content in large files and Glob when unsure of a path. Read independent files in parallel; prefer larger windows over tiny repeated slices.`,
  },
  edit: {
    length: 1369, hash: "4426ccf60241fe41d01bbafc1e7450ea6538003f9fca863ab0210492a74647f8", // edit.txt
    compact: `Replaces exact text in a file: \`filePath\` (absolute), \`oldString\`, \`newString\` (must differ), optional \`replaceAll\` (default false).
- Read the file earlier in the conversation first, or the edit fails.
- Copy text from Read output exactly as it appears after the \`<line>: \` prefix, preserving indentation; never include the prefix.
- Fails with "oldString not found in content" if absent, or with a multiple-matches error if not unique: add surrounding lines, or set \`replaceAll\` to change every occurrence (e.g. renames).
- Prefer editing existing files; no emojis unless requested.`,
  },
  write: {
    length: 623, hash: "8b7197b6e3a8ec1d129eeb6b82608e4cab759bfcc60ba890ecf36322a6e45180", // write.txt
    compact: "Writes `content` to `filePath` (absolute), overwriting any existing file. An existing file must be read with Read first, or the write fails. Prefer editing existing files; create new files, including documentation/README files, only when required or requested. No emojis unless requested.",
  },
  glob: {
    length: 517, hash: "50b2d2c41d4b8d0286ab4542c6ec882421ac4ae5c0567ad213c3668ed973ed9a", // glob.txt
    compact: "Finds files by glob `pattern` (e.g. `**/*.js`, `src/**/*.ts`) and returns matching paths. Omit `path` to search the current directory. Batch independent searches in parallel; use Task for open-ended multi-round searching.",
  },
  grep: {
    length: 657, hash: "97fa2a9929353d20d3418041aae53ffea3aaf63e9a6e2fdc8cff6db61c3f4c5e", // grep.txt
    compact: "Searches file contents with regular expression `pattern` and returns file paths and line numbers of matching lines. `path` defaults to the current directory; `include` filters files (e.g. `*.js`, `*.{ts,tsx}`). To count matches, run `rg` through Bash, not `grep`. Use Task for open-ended multi-round searching.",
  },
  webfetch: {
    length: 750, hash: "0da3ec7c3f6bc47706553c1c522dacb2042d66a4c2bf09368e43ce4a72f3b7dc", // webfetch.txt
    compact: "Fetches a fully-formed `url` (HTTP is upgraded to HTTPS) and returns it as `format` `markdown` (default), `text` or `html`; `timeout` is in seconds (max 120). Read-only; very large content may be summarized. Prefer a more capable or targeted fetch tool when one is available.",
  },
  todowrite: {
    length: 2012, hash: "f214ea20cd870a9837cb30dd993aefbe5abe6d9e3319b47672c529961ba0c3ad", // todowrite.txt
    compact: `Replaces the session task list with \`todos\`; each item has \`content\`, \`status\` (\`pending\`, \`in_progress\`, \`completed\`, \`cancelled\`) and \`priority\` (\`high\`, \`medium\`, \`low\`).
Use it for work with 3+ distinct steps, several user-listed tasks or new instructions; skip single trivial tasks and purely informational requests.
Keep exactly one item \`in_progress\` while work remains and update status as you go. Mark \`completed\` only after the work and required verification are done; if blocked, keep it \`in_progress\` and add a blocker item. Keep items specific; preserve user-provided commands verbatim.`,
  },
  skill: {
    length: 399, hash: "226f63ce9fd51e51431205c90ef98e53a20ba5af690fdad241eba416db49c339", // skill.txt
    compact: "Loads a skill listed in the system prompt by its exact `name`, adding its instructions and resource references to the conversation. Use it when the task matches a skill's description.",
  },
  question: {
    length: 657, hash: "c0a5776acd585b62292c16839a5486b8b69e176b2d7da0cf206c82fcbd929584", // question.txt
    compact: "Asks the user `questions` during execution to gather preferences, clarify ambiguity or choose between options. Custom typed answers are enabled by default, so do not add \"Other\" options. Answers return as arrays of labels; set `multiple: true` to allow several. Put a recommended option first and end its label with \"(Recommended)\".",
  },
  apply_patch: {
    length: 1092, hash: "2e88f3a8fb30723c4fd6a084ef20716dec6b6ea66aa943dde675e81c5cb1cc4e", // apply_patch.txt
    compact: `Edits files with a patch in \`patchText\`:
*** Begin Patch
*** Add File: <path>     (every following line starts with +)
*** Delete File: <path>  (nothing follows)
*** Update File: <path>  (optionally followed by *** Move to: <new path>)
@@ <context line>
-old line
+new line
*** End Patch
Every operation needs an Add, Delete or Update header, and new lines start with \`+\` even when adding a file.`,
  },
  lsp: {
    length: 1303, hash: "8f25f3ea038c4fc7b5c37072eb2ccfe9c7abc8fc812bde6688bccb4d04ab454a", // lsp.txt
    compact: "Queries the configured LSP server. `operation`: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls or outgoingCalls. All operations take `filePath`, `line` and `character` (both 1-based, as in editors). workspaceSymbol also takes `query` (empty string = all symbols); its filePath only selects the server. Fails if no server handles the file type.",
  },
  plan_exit: {
    length: 579, hash: "00dba1a429590e46c1975bade1963eac331b5edd3610b680edd15ef124ff2c43", // plan-exit.txt
    compact: "Asks the user whether to leave planning and switch to the build agent. Call only after the plan file is complete, open questions are resolved and the user is not still planning.",
  },
}

// shell.txt rendered by shell/prompt.ts for the POSIX profile. PowerShell and
// cmd.exe profiles have different text and fail the hash, so they stay intact.
const bashTemplate = { length: 4636, hash: "74600c017fe0683dc02202ba11ab718369cebb7ee2ae77d25337a387a3cf3a0d" }
const bashLayout = /^([\s\S]*?\nBe aware: OS: )([^\n,]*)(, Shell: )([^\n]*)(\n[\s\S]*?\nUse `)([^`\n]*)(` for temporary work[\s\S]*?commands will time out after )(\d+)(ms\.\n[\s\S]*?If the output exceeds )(\d+)( lines or )(\d+)( bytes[\s\S]*)$/

// websearch.txt with {{year}} substituted by websearch.ts.
const websearchTemplate = { length: 1031, hash: "31abe3e2b84a60582979c963414ced0aafded8182f08b0c8a19aa04f0de4748a" }
const websearchLayout = /^([\s\S]*The current year is )(\d+)(\. You MUST[\s\S]*)$/

// task.txt, the optional background-mode paragraph from task.ts, then the
// registry's live agent listing, which is retained verbatim.
const task = { length: 2305, hash: "220dcf4ad2582dbdaf2b0bbc8b7f5fa78172b1337539ac1c8912f45f2b9e5d46" }
const taskBackground = { length: 311, hash: "8c625cde589a304cc7373250688781ab16ddb532256c81324142d2d49bbab99d" }
const agentListing = "\nAvailable agent types and the tools they have access to:\n"
const taskCompact = `Launches a subagent for complex multistep work. Set \`subagent_type\` to an agent listed below, \`description\` to 3-5 words, and \`prompt\` to a complete, self-contained task stating whether to write code or only research, how to verify, and exactly what to return. Pass a previous \`task_id\` to resume that subagent session; otherwise it starts with fresh context.
Use Read/Glob/Grep directly for known paths, specific definitions or a few files. Launch independent agents in parallel and do not duplicate delegated work. The result is not shown to the user, so summarize it. Generally trust agent output; use agents proactively when their description says so.`
const taskBackgroundCompact = "`background: true` starts the agent asynchronously and returns immediately; use it only for independent work, as completion is notified automatically. Foreground (default) is for results needed before continuing."

function compact(name: string, description: string): string | undefined {
  const known = fixed[name]
  if (known) return description.length === known.length && hash(description) === known.hash ? known.compact : undefined
  if (name === "bash") {
    const match = bashLayout.exec(description)
    if (!match) return
    const [, head, os, afterOs, shell, afterShell, tmp, afterTmp, timeout, afterTimeout, maxLines, afterLines, maxBytes, tail] = match
    const template = `${head}\0os\0${afterOs}\0shell\0${afterShell}\0tmp\0${afterTmp}\0timeout\0${afterTimeout}\0maxLines\0${afterLines}\0maxBytes\0${tail}`
    if (template.length !== bashTemplate.length || hash(template) !== bashTemplate.hash) return
    return `Runs a command in a persistent ${shell} session (OS: ${os}). Use it for terminal work such as git, package managers, builds and tests; use the dedicated Read/Glob/Grep/Edit/Write tools for file operations.
- \`command\` is required. \`workdir\` sets the directory (default: current); use it instead of \`cd <dir> && ...\`. \`timeout\` is in milliseconds (default ${timeout}).
- Quote paths containing spaces with double quotes. Chain dependent commands with \`&&\` in one call; use \`;\` only when earlier failures do not matter; never separate commands with newlines outside quotes. Run independent commands as parallel calls.
- \`${tmp}\` already exists and is pre-approved for temporary work outside the workspace.
- Output over ${maxLines} lines or ${maxBytes} bytes is truncated and saved to a file; inspect it with Read offset/limit or Grep instead of head/tail.
- Git: commit, amend, push or open PRs only when asked. Inspect status/diff/log first, stage only intended files and never commit secrets. Never change git config, skip hooks, use interactive \`-i\`, force-push, create empty commits or amend a failed commit unless asked. Use \`gh\` for GitHub and return PR URLs.`
  }
  if (name === "websearch") {
    const match = websearchLayout.exec(description)
    if (!match) return
    const [, head, year, tail] = match
    const template = `${head}\0year\0${tail}`
    if (template.length !== websearchTemplate.length || hash(template) !== websearchTemplate.hash) return
    return `Searches the web through the session's search provider and returns content from the most relevant sites; use it for current information beyond your knowledge cutoff. \`query\` is required; optional \`numResults\` (default 8), \`livecrawl\` (\`fallback\` or \`preferred\`), \`type\` (\`auto\`, \`fast\` or \`deep\`) and \`contextMaxCharacters\` (default 10000). The current year is ${year}; use it when searching for recent information or current events.`
  }
  if (name === "task") {
    if (hash(description.slice(0, task.length)) !== task.hash) return
    let rest = description.slice(task.length)
    const background = hash(rest.slice(0, taskBackground.length)) === taskBackground.hash
    if (background) rest = rest.slice(taskBackground.length)
    // Anything else between the builtin text and the listing (for example a
    // tool.definition plugin addition) is unknown layout and stays intact.
    if (!rest.startsWith(agentListing)) return
    return taskCompact + (background ? `\n${taskBackgroundCompact}` : "") + rest
  }
}

export type ToolDescriptionReport = { tools: number; originalChars: number; replacementChars: number }

export function compactToolDescriptions(tools: unknown[]): { tools: unknown[]; report?: ToolDescriptionReport } {
  let report: ToolDescriptionReport | undefined
  const result = tools.map((tool) => {
    if (typeof tool !== "object" || tool === null || !("type" in tool) || tool.type !== "function" || !("function" in tool)) return tool
    const fn = tool.function
    if (typeof fn !== "object" || fn === null || !("name" in fn) || !("description" in fn)) return tool
    const { name, description } = fn
    if (typeof name !== "string" || typeof description !== "string") return tool
    const replacement = compact(name, description)
    if (replacement === undefined) return tool
    report ??= { tools: 0, originalChars: 0, replacementChars: 0 }
    report.tools++
    report.originalChars += description.length
    report.replacementChars += replacement.length
    return { ...tool, function: { ...fn, description: replacement } }
  })
  return report ? { tools: result, report } : { tools }
}
