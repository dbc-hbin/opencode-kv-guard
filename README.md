# OpenCode KV Guard

A local plugin for **OpenCode 1.19.4** and explicitly selected `@ai-sdk/openai-compatible` providers. Intended for LiteLLM -> vLLM/SGLang installations. It has no runtime npm dependencies; it uses Bun's built-in SQLite and Node builtins. Cross-process admission supports Linux and macOS.

Source baseline: OpenCode tag `v1.19.4`, commit `148842ef7cb1bc34192b3fff57d0f9721ab9c801`. OMP comparison: `can1357/oh-my-pi` commit `6f3fbc94c567c0ac619c013dd15d718356eecba1`.

## Install

Build with `bun install --frozen-lockfile && bun run build`. Copy `dist/opencode-kv-guard.js` to the target machine. You do not need to copy `node_modules` or install a package on the target.

Merge this into the existing OpenCode config, retaining the real provider/model configuration and other plugins. Replace `litellm` with the **existing provider ID**, not the model name. Point the file URL at the copied bundle. Put this plugin after plugins that modify prompts or provider fetch functions. The example is for a fully guarded on-prem profile: native `compaction.auto` is disabled because the plugin performs request-time rolling compaction. That native setting is global; do not disable it for unguarded providers sharing the profile.

```json
{
  "plugin": [
    ["file:///absolute/path/to/opencode-kv-guard.js", {
      "providers": ["litellm"],
      "maxConcurrent": 1,
      "diagnostics": true
    }]
  ],
  "agent": {
    "title": { "disable": true }
  },
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

The selected providers must explicitly have `npm: "@ai-sdk/openai-compatible"` and `options.baseURL`. Environment placeholders such as `${TENANT}` are resolved at activation and the SDK and gate use the same resolved URL. Missing/unresolved variables produce a plugin configuration error rather than an apparently active path that bypasses interception; provider transformations activate only after successful configuration. This plugin does not intercept unrelated providers or patch global fetch. Restart OpenCode after changing the plugin/config. Start a new session for a clean comparison; enabling any prompt-changing plugin in the middle of a session creates an initial cache miss.

`agent.title.disable` is OpenCode's native setting. It removes the extra title inference entirely; the session keeps its default/manual title. If you want model-generated titles, omit that setting: the plugin still serializes their inference with the main request on the same endpoint. An explicitly configured title model on another endpoint is outside that endpoint's gate.

### Cache hit-rate sidebar

OpenCode stores each response's reported cached prompt tokens but does not show a hit rate. Copy `dist/opencode-kv-guard-tui.tsx` beside the bundle and add it to `tui.json` (a separate file from `opencode.json`; OpenCode loads server and TUI plugins separately):

```json
{
  "plugin": ["file:///absolute/path/to/opencode-kv-guard-tui.tsx"]
}
```

The session sidebar then shows a **Cache** block below Context: the last request's rate, the session rate and the cached/total prompt tokens. The rate is `cache.read / (input + cache.read + cache.write)` over assistant messages, using the server's `prompt_tokens_details.cached_tokens`. It is independent of the server plugin and works for any provider. Keep the file as `.tsx` outside `node_modules`: OpenCode compiles TUI plugin JSX against its own Solid runtime only there. A server that does not report cached tokens shows 0%; enable SGLang `--enable-cache-report` or vLLM `--enable-prompt-tokens-details`, and make sure the proxy forwards the field. The sidebar appears automatically when the terminal is wider than 120 columns, or through the sidebar toggle.

## Implemented behavior

- **Short builtin prompt.** Recognizes all 11 exact provider prompt outputs in 1.19.4 using source-derived SHA-256 and lengths. Replaces only that initial builtin text with a concise 1,887-character coding prompt. Appended project, MCP, skill, environment and user instructions remain; unknown/custom agent prompts are not replaced. Provider-specific personality, lengthy examples and repetitive workflow prose become a shared concise workflow.
- **No generated date.** Removes the exact core-generated `Today's date` field. It is not relocated or frozen in another message. Dates in user text, project instructions and tool results remain intact.
- **Append-only environment.** Moves the recognized core environment out of the initial system block and into anchored conversation reminders. Previously transmitted context remains stable; a real working-directory change appends updated context rather than rewriting it. Other system policies remain live. Unsupported layouts containing later system/developer messages are left in place, apart from the earlier date-removal hook.
- **Stable historical mode reminders.** The default core plan/build reminders are transient. The plugin remembers exact recognized synthetic reminders and reattaches them to their historical user turn. It does not revive a previous mode on the current turn, freeze permissions, overwrite edited messages or write to the session database.
- **Stream-lifetime admission across processes.** Default one active HTTP generation per normalized endpoint across local processes sharing the state directory. A local FIFO gate sits in front of the SQLite coordinator; ordering across processes is not guaranteed. The lease lasts through response-body EOF, cancellation or error, not just arrival of HTTP headers. Queued aborts do not dispatch. Verified dead owners are reclaimed without evicting merely slow live owners. Set `crossProcess: false` for only the original in-process FIFO gate.
- **Stable schema object order.** Canonicalizes object keys in tool definitions. Session heads additionally sort unique function tools by name and freeze that canonical catalog. Enum arrays, examples and tool-call argument strings remain exact; actual tool/schema changes remain visible.
- **Persistent session heads.** Equal system/tool contracts retain the same leading head. Newly appended complete system/developer messages become anchored notices with their original authority; edits or removals, incompatible layouts, history reverts and tool changes establish an explicit new boundary. Arbitrary changes inside a single system string are not moved or hidden.
- **Compatible child heads.** A child can reuse its active parent's canonical head only when the current system and tools match exactly and the parent has no history-bound notices. Different agent policies, tools and schemas stay separate. Parent affinity is preserved; sharing does not grant tools or permissions.
- **Recorded-response prefix guard.** A persistent structural ledger classifies exact request/message-field divergence. Missing plaintext reasoning is restored only when the full producing prefix, successful assistant content and tool calls match a recorded response. Preparation receipts reject stale completions after edits or reverts. Signed, opaque, failed, aborted and truncated responses are excluded. Deliberate compaction is observed without undoing its reductions. Server cache counters remain separate from these structural comparisons.
- **Reconstruction before anchor validation.** A read-only projection of the prior environment/head layout and validated compaction state authenticates missing reasoning before history anchors are checked. Proven fields affect anchor comparison, not the stored source transcript; validated positions are then bound to the actual source hashes so later compaction can retire reasoning evidence without moving notices. Final outgoing replay must still match after live policy validation. Ordinary edits, reverts and explicit reasoning changes remain invalidations.
- **Actual request identity.** Reconstruction, response replay and usage lanes include the actual request URL, including SDK-added query parameters, plus credential headers. Query-selected tenants and deployments cannot inherit each other's state. URL fragments are excluded. Endpoint admission remains a separate, conservatively shared capacity limit.
- **One-time output storage reduction.** The selected providers' `bash`, `grep`, `glob` and `webfetch` results are cleaned of ANSI escapes and bounded to 16 KiB/400 lines before native storage. A head/tail preview links to a private exact raw artifact in OpenCode's `tool-output` directory; existing native raw artifacts are reused, never overwritten with a preview. `read`, edit tools and unknown/MCP tools are untouched. Storage failure retains the original output. OpenCode's normal seven-day artifact cleanup applies.
- **Wire-correct cache key.** Normalizes the core's `promptCacheKey` passthrough field to `prompt_cache_key`; an explicit snake-case value wins. Optional generation of a session key is off by default. Does not modify `cache_salt` or tenant isolation.
- **Session routing metadata.** Adds `x-litellm-session-id` only if absent, using the parent session where OpenCode supplies one. Preserves existing OpenCode affinity headers and explicit LiteLLM session headers.
- **Optional output ceiling.** `maxOutputTokens` reduces both `chat.params` and the final compatible wire limit, including passthrough overrides. It does not change OpenCode's context metadata or silently increase its compaction threshold. No arbitrary output cap is imposed by default.
- **Preflight rolling compaction.** Counts the pending wire request before dispatch, reuses a frozen summary, and summarizes only newly archived history. Full parallel tool-call/result batches are indivisible; long current tool loops can be split at completed batches while the current user instruction and newest batch stay exact. Native OpenCode history is never overwritten. See the budgeting and failure contract below.
- **Usage-anchored budgeting.** A successful response's raw `prompt_tokens` anchors the next unchanged prefix; only appended accountable text/tool messages are estimated. Cached input is included, never subtracted or counted twice. Model, policy, tools, request-field changes, edited history and compaction invalidate incompatible anchors. Missing usage falls back to the configured byte estimator. The plugin requests streaming usage unless explicitly disabled in the request or by the selected provider's `includeUsage: false`; returned usage is still observed.
- **Durable reconstruction checkpoints.** Completed summaries, retained boundaries, environment anchors and historical mode reminders are stored together and restored before preparation. Original-history/policy validation still applies. SQLite compare-and-swap prevents a stale process from overwriting another process's checkpoint; conflicts stop before main dispatch. Session deletion waits for competing writers, removes the payload and retains an opaque tombstone. Disposal waits for pending deletion work but otherwise keeps durable state; non-contention cleanup failures are logged and surfaced at disposal.
- **Opt-in GLM profile.** Exact model IDs can select GLM 5.3 defaults and plaintext reasoning-response adaptation. Explicit request controls win; conflicts remain intact and are reported rather than silently resolved. Unknown models, signed/opaque payloads and unsupported response layouts are not rewritten.
- **Compact skill catalog.** The recognized generated catalog retains its currently advertised names and complete descriptions but removes eager absolute locations and per-entry XML scaffolding. The name-based skill tool remains available. A private user-system suffix fingerprint prevents rewriting a user-authored trailing catalog. Ambiguous or unsupported layouts are left intact.
- **Compact builtin tool descriptions.** Replaces the 15 recognized 1.19.4 builtin descriptions (`bash` POSIX profile, `read`, `edit`, `write`, `glob`, `grep`, `task`, `todowrite`, `webfetch`, `websearch`, `skill`, `question`, `apply_patch`, `lsp`, `plan_exit`) in the selected providers' wire requests only. Recognition uses source-derived SHA-256 hashes. Rendered values (shell, OS, pre-approved temp path, default timeout, truncation limits, search year, live task agent list, background mode) are carried over unchanged. Tool names and parameter schemas are never modified. Each compact text keeps the parameter names, defaults, output format and failure conditions (for example the `<line>: ` read prefix that `edit` must strip, read-before-edit/write and `replaceAll`). It drops repeated workflow prose, examples and duplicated dedicated-tool guidance. PowerShell/cmd profiles, custom/MCP/Code Mode tools and descriptions amended by another plugin are left intact. The shorter guidance can change model behavior; evaluate it with the served model, or set `compactTools: false`.
- **Content-free diagnostics.** `diagnostics: true` logs prefix comparisons, GLM policy, skill reductions, request usage and lifecycle timings, including internal summaries. Reports distinguish admission wait, upstream header time, first actual output and completion; cache counters are the server's reports, not GPU measurements. Unreported counters remain absent. Prompt text, paths, credentials and tool arguments are not logged.

Options: `providers` (required string array), `maxConcurrent` (positive integer, default 1), `maxOutputTokens` (optional positive integer), `compactPrompt`, `compactSkills`, `compactTools`, `stabilizeEnvironment`, `retainModeReminders`, `canonicalToolSchemas`, `usageAccounting`, `crossProcess`, `persistence`, `sessionHeads`, `prefixGuard`, `prefixHandoff` (default true), `promptCacheKey`, `diagnostics` (default false), `stateDirectory` (optional absolute path), `glm` (off unless configured), and `compaction` (enabled by default; `false` or the object below). `shrinkToolOutputs` accepts `false` or `{ "maxBytes": 16384, "maxLines": 400 }`; omitted limits use those defaults. Generated date removal is always active for selected providers.

Checkpoints now also contain frozen head contracts, structural hashes and successful assistant responses retained for reasoning replay. Treat them as private conversation data. Response records keep a constant-size producing-prefix proof rather than duplicating the complete structural ledger for every turn. Completed response writes are serialized with preparation and drained on disposal.

State defaults to `$XDG_STATE_HOME/opencode-kv-guard`, or `~/.local/state/opencode-kv-guard`. Keep it on a private local filesystem. Admission is endpoint-scoped; checkpoint files are project/policy/session-scoped and include hashed endpoint/header identity in their lanes. The known per-turn `x-opencode-request` correlation header is forwarded but excluded from state identity; credential and tenant headers remain part of identity. Checkpoints contain conversation summaries and environment/reminder text and use private directory/file permissions. Same-endpoint processes sharing this directory must agree on `maxConcurrent`; the coordinator persists that capacity and rejects conflicting values. To change capacity, stop all users of that coordinator and select a new shared `stateDirectory`. This does not coordinate other hosts or unguarded clients.

## OMP-inspired rolling compaction

The plugin adopts pre-prompt maintenance, carried summaries, complete tool groups, bounded summary folding and OMP's 0.8 recovery band. It does not claim to port OMP's server-native compact endpoints, speculative journal commits, snapcompact images or all of its host internals.

Optional settings inside the plugin's `compaction` object:

| Setting | Default | Meaning |
| --- | --- | --- |
| `bytesPerToken` | 4 | Estimate serialized UTF-8 bytes per token; lower values are more conservative. |
| `triggerRatio` | 0.85 | Trigger relative to the available prompt budget. |
| `targetRatio` | 0.8 | Recovery target relative to the trigger, not the full context window. |
| `marginTokens` | 0 | Additional reserve beyond the ratio headroom and completion reserve. |
| `summaryOutputTokens` | Derived | At most the actual main output cap and the trigger-to-target headroom. |
| `keepRecentTurns` | 1 | Prefer keeping this many recent user turns. Under pressure, older complete groups in the current turn can be summarized; the current instruction and newest protocol group remain exact. |

The model's actual metadata arrives through `chat.headers`; internal metadata headers are stripped before HTTP. For context window `C`, optional input limit `I`, final requested output cap `O`, and margin `M`, the budget is `min(I, C - O) - M`. The trigger is 85% of that budget by default, and the recovery target is 80% of the trigger. Fixed system instructions, tool schemas, output-format constraints and newly added user/tool content are included. A declared zero/unknown context window is not replaced with a guessed limit: configure `provider.models.<model>.limit.context` and output/input limits to match the actual served model.

**This is not the server tokenizer.** With `usageAccounting` enabled, a completed request supplies the exact reported prompt-token baseline only while its policy and message prefix remain identical. The appended suffix is still estimated. Changed prefixes, unreported usage and new media/signed content use the byte estimator. UTF-8 bytes improve on UTF-16 character counting for multilingual input, but neither estimator nor ratio guarantees chat-template overhead, media tokens or GPU KV allocation. Use a lower `bytesPerToken` or extra margin if the deployment needs it. One byte per token is more conservative for common byte-based tokenizers but still not a universal media/template bound. Set OpenCode's existing `provider.models.<model>.limit` values to the actual served limits; a model card advertising 1M is not evidence that a particular deployment serves 1M.

At a pressure boundary, plaintext reasoning from earlier user turns is removed first. If more space is needed, duplicate read results can be replaced with a reference to a later identical complete result: the raw call arguments, full numbered file text and end-of-file proof must match. Partial reads, changed content, errors, attachments and opaque fields are not eligible. Current-turn reasoning and the current instruction remain exact. Reductions are checkpointed and remain unchanged until the next boundary; native stored history is preserved.

When pressure processing changes a measured prefix, the fallback for that preparation carries the observed ratio between the usage-based count and the byte estimate, never lowering it below the configured estimator. Removing a tiny reasoning field therefore cannot appear to recover thousands of tokens solely by invalidating the usage anchor. The correction also applies to fragment planning and final fit checks. It is a conservative heuristic for that preparation, not a tokenizer guarantee or a persisted usage measurement.

History is summarized independently within each system/developer policy interval. Every summary remains at its own first archived source position; instruction messages and protected tool batches remain exact. A newly appended later policy does not invalidate an earlier covered summary. Each changed interval reserves its own summary output, while unchanged summaries stay frozen. Intervals too small to repay their wrapper and output reserve are skipped rather than consuming the recovery available in later history. Duplicate-read supersession requires both results to be in the same policy interval.

Each internal summary request has its own output reserve and input budget. When the current effective prefix plus an appended summary instruction fits, `prefixHandoff` retains the exact messages, tools and system and requests a text checkpoint with `tool_choice: "auto"`. Reported prefix usage remains part of the fit check even though streaming/output controls change. Tool-calling or incomplete summary responses are rejected. Constrained output/tool modes and oversized prefixes instead use bounded sequential fragment folding with a separate summary system and no tools. Both paths retain model/template and tenant-isolation settings, use the same endpoint gate and cancellation signal, and do not reenter compaction. Summary calls incur real inference work; native OpenCode token/cost UI does not aggregate them. Diagnostic reports include summary-request and reduction counts.

Summary state commits only after complete successful JSON, nonempty assistant text, `finish_reason: stop`, no tool calls, and final estimated fit. HTTP failures pass through; interrupted, truncated or malformed summaries are rejected rather than used as memory. The plugin does not retry summaries or silently send the original oversized request. Edits to covered history, model/lane changes or changed system/schema/template identity invalidate the summary; ordinary output-cap or sampling changes reevaluate the budget without discarding a still-valid summary.

For several changed intervals, folding uses only that interval's previous summary and newly archived messages. Every handoff uses the same precompaction wire prefix and selects only the relevant interval's positions. All interval updates and reductions commit together; failure in a later interval preserves the previously committed checkpoint.

Real-user provenance is carried through OpenCode/SDK conversion with an instance-private marker and stripped before inference, budgeting and prefix hashing. Thus tool-generated image/PDF `user` messages cannot replace the actual current user instruction. The newest complete tool batch in that turn is protected independently of trailing assistant step-limit instructions. Private provenance is not stored in the OpenCode transcript or sent in upstream headers/messages.

Between compactions, summary bytes and retained messages stay stable. A compaction boundary intentionally changes history; the lower recovery target prevents repeated tiny rewrites every turn. Opaque/signed and multimodal data remain exact. If mandatory content alone cannot fit, the plugin fails with the region/budget instead of silently cutting the current user request or a tool pair. Semantic summaries are inherently lossy; quality needs evaluation with the actual on-prem model.

The core's `client.session.summarize()` cannot safely be awaited inside a running request hook: it waits for the same session loop containing that hook. This is why the implementation compacts only outgoing requests. It reduces wire history but cannot remove OpenCode's own cost of loading/converting the full stored transcript. With persistence enabled, a restart restores the coherent checkpoint; a missing, incompatible or malformed payload is rebuilt through bounded folding. Unreadable storage fails explicitly. With `persistence: false`, state is instance-local and restart requires reconstruction.

Because this compaction runs inside the provider request, OpenCode never sees it and shows none of its own compaction feedback. The plugin instead publishes TUI toasts through the server's `tui.toast.show` event: `Compacting session` before the first summary request and `Session compacted` once the summary has been committed. Like the builtin notifier, the toast title is the session title. Reasoning-only reductions and reused summaries make no inference call and show no toast. A failed toast is logged and never affects the request.

Checkpoint scope uses canonical, parsed settings: reordering option keys or spelling out existing defaults does not change the scope. Genuine setting changes remain separate. This release uses checkpoint format 2 for positional environment anchors and policy-local summaries; prior singleton-summary payloads are not migrated and require one reconstruction. Original OpenCode history is retained.

For a fully guarded profile, use native `compaction.auto: false` and `prune: false` as shown above. With native compaction still enabled, its independent old-usage trigger can fire after a long completion; builtin title/summary/compaction requests are budget-checked but are not recursively summarized. To turn plugin compaction off, use plugin `compaction: false` and restore native `compaction.auto: true`.

## Model-specific template settings

For a confirmed GLM 5.3 deployment, add this object to the plugin options, replacing the model ID with the exact outgoing Chat Completions `model` value:

```json
{
  "glm": {
    "models": ["your-served-glm-model-id"],
    "reasoningEffort": "max",
    "clearThinking": false,
    "cumulativeReasoning": false
  }
}
```

The public NVIDIA GLM-5.3-NVFP4 template puts reasoning effort at the beginning of the prompt, defaults it to `max`, and defaults `clear_thinking` to false. This opt-in profile makes missing settings explicit without overriding supplied top-level/template values. It normalizes unambiguous camelCase controls and adapts otherwise unsupported plaintext `reasoning_text` responses so the pinned SDK can persist and replay them. `low`, `high` and `max` are the supported profile efforts. Set `cumulativeReasoning` only when the backend actually emits cumulative rather than incremental reasoning snapshots; incompatible non-append-only snapshots fail rather than duplicating or inventing reasoning. The plugin cannot recover reasoning already removed upstream. Preserving thinking can increase input size even when it improves prefix reuse.

The model name does not establish the serving engine or KV dtype. NVIDIA's public checkpoint documents SGLang and quantized weights/activations, not a guarantee of FP4 KV. Verify the actual deployment/template before enabling the profile. Internal summaries retain the effective model/template settings; prefix-sharing handoffs are used only when they fit and no constrained tool/output mode prevents them.

For an affected Qwen template that supports it, put `chat_template_kwargs: { "preserve_thinking": true }` in that model's existing `options`. This preserves historical thinking; it does not force current-turn thinking on. Do not assume an arbitrary company model alias uses Qwen or that every LiteLLM deployment forwards the same extras. The plugin repairs the known camelCase spellings generated by experimental mode expansion, including template kwargs, thinking-preservation flags, cache salt and token-limit names; it does not invent template flags.

## Native MCP Code Mode

OpenCode 1.19.4 already implements MCP progressive disclosure. Start it with `OPENCODE_EXPERIMENTAL_CODE_MODE=true` to expose connected MCP tools through the permission-aware `execute` tool and a bounded searchable catalog instead of separate top-level MCP schemas. This is an existing OpenCode flag, not a plugin executor or a replacement for builtin tools. The plugin does not enable this process-wide experimental setting silently. Catalog/permission changes remain live. Skill-description text is preserved in full; this release does not add lossy or model-generated routing hints.

The exhaustive comparison, counterexamples and ranked causal distinctions are in [ANALYSIS.md](ANALYSIS.md), with complete evidence maps under [analysis/](analysis/).

## What the source actually shows

| Behavior | OpenCode 1.19.4 evidence | Consequence |
| --- | --- | --- |
| System prompt reconstructed on each model step | [prompt.ts:1255-1278](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/prompt.ts#L1255-L1278), [llm/request.ts:56-78](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/llm/request.ts#L56-L78) | Reconstruction is harmless if rendered tokens are identical. Changed early content invalidates the suffix. |
| Local instruction files reread, URL instructions fetched again; failed reads/fetches become empty | [instruction.ts:101-116](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/instruction.ts#L101-L116), [instruction.ts:179-195](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/instruction.ts#L179-L195) | Changes or intermittent URL failures can add/remove system instructions. The plugin does not freeze these instructions: doing so could ignore new policy. Prefer stable local instruction files for volatile remote sources. |
| Generated calendar date is inside system environment | [system.ts:77-94](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/system.ts#L77-L94) | Midnight changes the prefix; there is no per-request seconds/minutes timestamp to remove. |
| Default plan/build reminders appended only to the latest in-memory user message | [reminders.ts:25-51](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/reminders.ts#L25-L51) | On a later user turn, a formerly sent instruction can disappear from an old turn. |
| Tool names, MCP instructions and skill catalogs already sorted | [llm/request.ts:185](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/llm/request.ts#L185), [mcp/index.ts:615-624](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/mcp/index.ts#L615-L624), [skill/index.ts:306-339](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/skill/index.ts#L306-L339) | Do not blame generic ordering bugs already fixed in this version. Catalog membership/content and permissions can still change. |
| Title generation forks concurrently; model falls back from title model to small model to current model | [prompt.ts:216-235](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/prompt.ts#L216-L235), [prompt.ts:1133-1139](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/prompt.ts#L1133-L1139) | A custom local provider may run two generations against the same GPU, with different prefixes. Disable titles or use the stream gate. |
| `SessionSummary.summarize` computes file diffs | [summary.ts:111-140](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/summary.ts#L111-L140) | It is not another LLM summary request in this version. |
| Pruning defaults to false | [config.ts:154-156](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/core/src/v1/config/config.ts#L154-L156), [compaction.ts:273-275](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/compaction.ts#L273-L275) | Disabling pruning again does nothing under defaults. Enabling it rewrites old tool outputs and can invalidate prefixes. |
| Generic compatible provider lacks automatic body cache-key setting; explicit `setCacheKey: true` generates camelCase | [transform.ts:1323-1335](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/transform.ts#L1323-L1335) | Compatible SDK 2.0.41 passes unknown provider fields through; a camelCase hint is not the OpenAI snake-case field. |
| Main-loop retries are capped at five; title SDK retries are two | [retry.ts:32](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/retry.ts#L32), [prompt.ts:234](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/prompt.ts#L234) | Repeating an unchanged request cannot repair insufficient physical capacity. The plugin does not hide errors, forge smaller usage, or add retries. |

OMP deliberately moves volatile date/cwd information into append-only conversation reminders: [sdk.ts:4449-4471](https://github.com/can1357/oh-my-pi/blob/6f3fbc94c567c0ac619c013dd15d718356eecba1/packages/coding-agent/src/sdk.ts#L4449-L4471), [date-cwd-reminder.ts:78-95](https://github.com/can1357/oh-my-pi/blob/6f3fbc94c567c0ac619c013dd15d718356eecba1/packages/coding-agent/src/session/date-cwd-reminder.ts#L78-L95). This plugin adopts prefix preservation but removes the generated date entirely as requested. OMP also uses `x-litellm-session-id` in its LiteLLM compatibility rule. It is not universally more conservative: its generic OpenAI output ceiling can exceed OpenCode's 32,000-token default, and it also transforms/prunes history.

## Physical capacity versus cache misses

vLLM automatic prefix caching hashes **rendered token blocks plus their entire prefix**, with additional identity such as LoRA, multimodal hashes and cache salt. Different JSON whitespace in the outer HTTP envelope alone is not necessarily a token change. Conversely, schemas rendered by the chat template, changed system text or historical-message changes can alter many downstream token hashes. See [vLLM prefix caching](https://docs.vllm.ai/en/stable/design/prefix_caching/).

A missing `prompt_cache_key` does **not** disable vLLM automatic prefix caching. That key can be useful to a supporting proxy/provider, but is not a replacement for identical tokens, enabled APC or consistent replica placement. Current [LiteLLM cache-aware routing](https://docs.litellm.ai/docs/proxy/cache_aware_routing) recognizes OpenCode session headers; the installed server version and routing configuration still determine whether affinity works. Retries, failover and independent model deployments can select another cache.

A large/full cache metric alone does not prove failure: unused cached blocks are evictable. Active requests that need more blocks than available are a capacity/scheduling problem. vLLM documents preemption/recomputation and server concurrency/cache sizing controls in its [optimization guide](https://docs.vllm.ai/en/stable/configuration/optimization/#preemption). Lower `max_tokens` can reduce actual future occupancy and generation duration, but ordinary vLLM allocation is not simply an up-front reservation of `prompt + max_tokens`.

The exact reported string `kv cache capacity exhausted` was not conclusively attributed to the deployed vLLM/LiteLLM version. Production GPU resolution is not claimed: the user's on-prem server is intentionally unavailable for this work.

## Boundaries

- OpenAI Chat Completions is stateless. Do not send only a suffix and assume the server remembers the missing conversation. Prefix caching saves repeated computation; it is not a conversation storage API.
- Completed reconstruction state is durable by default, but usage anchors are instance-local. Restoring identical request bytes cannot restore GPU blocks that have already been evicted. Compaction preserves original OpenCode history; output shrinking changes only new tool results before their first storage and keeps raw artifacts separately.
- The cross-process gate covers guarded local processes sharing the state directory and endpoint. It cannot limit other machines, unrelated clients, or LiteLLM's hidden fan-out. Capacity configuration persists, and global FIFO ordering is not promised. Process death permits local lease recovery but cannot prove that upstream GPU computation has stopped.
- Queue time is inside OpenCode's normal request timeout. Very long queues can hit that timeout. Abort/cancel is propagated, but only the inference server can confirm that GPU resources have actually been reclaimed.
- Shortening a builtin prompt changes the model's behavioral guidance. `compactPrompt: false` restores it while keeping the other protections and date removal.
- User/project/MCP policy updates, agent/model changes, tool catalog changes, compaction and deliberate history edits can require a new prefix. Freezing them to force hits would be incorrect.
- Match model metadata to the **served** context limit, not the model vendor's maximum. A wrong `limit.context` or `limit.input` cannot be repaired by a cache hint.

## Validation

`bun run typecheck`, `bun test`, `bun run build`, `bun run smoke`, and `bun run smoke:compaction` are local checks. The first smoke uses the actual pinned 1.19.4 CLI with isolated config/data directories and an event-controlled loopback OpenAI-compatible server. It exercises real read/bash/task round trips, raw output retrieval, GLM reasoning alias capture/replay, compact skill catalogs, serialized/disabled titles, and a real local MCP call through native Code Mode. The compaction smoke verifies exact handoff prefixes and restarts the actual pinned server after compaction to verify checkpoint reuse without another summary, reduced wire history and unchanged original user history. Regression coverage additionally exercises staged reductions, same-contract child sharing, authoritative head changes, proven missing-reasoning replay across restart, edits/reverts, independent workers, crash recovery, cancellation and transactional conflicts. No paid model is called. Temporary data and child processes are removed on exit.

Builtin replacement was independently exercised against all 11 original provider outputs, including both substituted Muse names: suffix preservation, boundary rejection, custom-prompt preservation and repeat-call stability passed. Original builtin sizes range from 4,076 to 15,372 characters; replacement is 1,887 characters (53.7%-87.7% smaller). These are character counts, not model-token or GPU-memory measurements.

Observed with the shipped bundle loaded in the actual 1.19.4 runtime:

| Scenario | Result |
| --- | --- |
| Typecheck and regression suite | Clean typecheck; 204 tests passed, 1,463 assertions. |
| Title plus main/read round trip, unmodified | 3 HTTP generations, peak 2 active, 9,957 system-message characters, 15,176 tool-description characters. |
| Same scenario with plugin | 3 generations, peak 1 active, 2,664 system-message characters, 5,643 tool-description characters (all 10 builtin tools compacted); no generated date; previous request prefix and GLM reasoning preserved on the tool round trip. |
| Plugin plus native title disable | 2 generations, peak 1 active; real read result still returned to the model. |
| Native MCP Code Mode | One actual local MCP call through `execute`; direct MCP schema absent; returned result reached the next model request. |
| Tool output storage | Real bash output was bounded below 18 KiB on the wire; both ends remained visible and all 500 fixture lines were retrievable from the linked raw artifact. |
| Native subagent | A real `task` invocation created a child, retained parent affinity and returned its result to the parent's next request. Incompatible child contracts were not forced to share a head. |
| 15-turn rolling-compaction scenario | 15 main calls, 5 prefix-sharing summary handoffs; 14 main calls carried a summary and 9 reused it without another summary inference. |
| Usage-driven early compaction | A controlled high `prompt_tokens` report caused compaction on the second user turn even though the byte estimate alone fit below the trigger. |
| Per-turn correlation headers | All 15 native `x-opencode-request` values differed and remained forwarded without invalidating shared state. |
| Restart after compaction | A fresh server process reused the checkpoint without a new summary call and reproduced the previous request prefix. |
| Replay after compaction | Public plugin regression tests recover omitted recent reasoning after both frozen summaries and reasoning-only reductions. Pressure transitions fingerprint the raw stored transcript, reduce restored historical reasoning before semantic inference, reuse the new checkpoint without resummarizing, and preserve recovered current tool-batch reasoning. |
| Mixed-provider title requests | Public hook regression tests prevent an auxiliary provider from changing the eligibility of the main request's tool output. |
| Wire-history reduction | Serialized message characters fell from 96,392 to 65,314 at one compaction boundary; similar reductions occurred at later boundaries. |
| Concurrent deletion | Competing writers delayed deletion rather than losing it; disposal drained even a second deletion arriving during the first wait, both tombstones committed, and stale saves were rejected. |
| Stored transcript | All 15 original user turns remained in OpenCode storage. |

The summary responses in the local scenarios are controlled fixtures. They verify orchestration, budgeting, protocol preservation and state reuse, not the semantic quality or latency of the private model.

The independent review identified three integration defects: tool-generated media being mistaken for the current user, a trailing step-limit instruction unprotecting the latest tool batch, and unresolved URL variables bypassing interception. All three were corrected and covered by the final regression run. The final bundle smoke also uses an environment-templated endpoint and verifies that provenance markers/private headers never reach inference or stored user history.
