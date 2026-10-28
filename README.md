# OpenCode KV Guard

A local plugin for **OpenCode 1.19.4** and explicitly selected `@ai-sdk/openai-compatible` providers. Intended for LiteLLM -> vLLM installations. It has no runtime npm dependencies; the bundle uses Node's built-in crypto module.

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

## Implemented behavior

- **Short builtin prompt.** Recognizes all 11 exact provider prompt outputs in 1.19.4 using source-derived SHA-256 and lengths. Replaces only that initial builtin text with a concise 1,887-character coding prompt. Appended project, MCP, skill, environment and user instructions remain; unknown/custom agent prompts are not replaced. Provider-specific personality, lengthy examples and repetitive workflow prose become a shared concise workflow.
- **No generated date.** Removes the exact core-generated `Today's date` field. It is not relocated or frozen in another message. Dates in user text, project instructions and tool results remain intact.
- **Append-only environment.** Moves the recognized core environment out of the initial system block and into anchored conversation reminders. Previously transmitted context remains stable; a real working-directory change appends updated context rather than rewriting it. Other system policies remain live. Unsupported layouts containing later system/developer messages are left in place, apart from the earlier date-removal hook.
- **Stable historical mode reminders.** The default core plan/build reminders are transient. The plugin remembers exact recognized synthetic reminders and reattaches them to their historical user turn. It does not revive a previous mode on the current turn, freeze permissions, overwrite edited messages or write to the session database.
- **Stream-lifetime admission.** FIFO per configured base URL, shared by instances importing the same module in one process. Default one active HTTP generation. The lease lasts through response-body EOF, cancellation or error, not just arrival of HTTP headers. Queued aborts do not dispatch. HTTP status, error bodies and SSE bytes remain intact.
- **Stable schema object order.** Canonicalizes object keys in tool definitions. Does not reorder tool arrays, enum arrays, examples or tool-call argument strings. This only helps when otherwise identical schemas arrive with different object-member ordering; actual tool/schema changes remain visible.
- **Wire-correct cache key.** Normalizes the core's `promptCacheKey` passthrough field to `prompt_cache_key`; an explicit snake-case value wins. Optional generation of a session key is off by default. Does not modify `cache_salt` or tenant isolation.
- **Session routing metadata.** Adds `x-litellm-session-id` only if absent, using the parent session where OpenCode supplies one. Preserves existing OpenCode affinity headers and explicit LiteLLM session headers.
- **Optional output ceiling.** `maxOutputTokens` reduces both `chat.params` and the final compatible wire limit, including passthrough overrides. It does not change OpenCode's context metadata or silently increase its compaction threshold. No arbitrary output cap is imposed by default.
- **Preflight rolling compaction.** Counts the pending wire request before dispatch, reuses a frozen summary, and summarizes only newly archived history. Full parallel tool-call/result batches are indivisible; long current tool loops can be split at completed batches while the current user instruction and newest batch stay exact. Native OpenCode history is never overwritten. See the budgeting and failure contract below.
- **Content-free diagnostics.** `diagnostics: true` writes `kv-guard` entries through OpenCode's logging API: system/tool changes, historical-message rewrites and unchanged message counts. These are request comparisons, **not tokenizer-level prefix hits or GPU measurements**. Prompt text, paths, secrets and tool arguments are not logged by this feature.

Options: `providers` (required string array), `maxConcurrent` (positive integer, default 1), `maxOutputTokens` (optional positive integer), `compactPrompt`, `stabilizeEnvironment`, `retainModeReminders`, `canonicalToolSchemas` (default true), `promptCacheKey`, `diagnostics` (default false), and `compaction` (enabled by default; `false` or the object below). Generated date removal is always active for selected providers. Same-endpoint instances must agree on `maxConcurrent`.

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

**This is an estimator, not the server tokenizer.** UTF-8 bytes improve on UTF-16 character counting for multilingual input, but neither the estimate nor the ratio guarantees the tokenizer, chat-template overhead, media tokens or GPU KV allocation. Use a lower `bytesPerToken` or extra margin if the deployment needs it. One byte per token is more conservative for common byte-based tokenizers but still not a universal media/template bound.

Each internal summary request has its own output reserve and input budget. Oversized archived text is folded through bounded sequential fragments carrying the previous summary; it is not sent as one enormous rescue request. Summary calls use the same endpoint gate and cancellation signal and do not reenter compaction. They remove ordinary tool/schema/stop constraints while retaining model/template and tenant-isolation settings. They incur real inference work on the configured model and are additional to the main response; native OpenCode token/cost UI does not aggregate this plugin's internal summary calls. Diagnostic reports include summary-request counts.

Summary state commits only after complete successful JSON, nonempty assistant text, `finish_reason: stop`, no tool calls, and final estimated fit. HTTP failures pass through; interrupted, truncated or malformed summaries are rejected rather than used as memory. The plugin does not retry summaries or silently send the original oversized request. Edits to covered history, model/lane changes or changed system/schema/template identity invalidate the summary; ordinary output-cap or sampling changes reevaluate the budget without discarding a still-valid summary.

Real-user provenance is carried through OpenCode/SDK conversion with an instance-private marker and stripped before inference, budgeting and prefix hashing. Thus tool-generated image/PDF `user` messages cannot replace the actual current user instruction. The newest complete tool batch in that turn is protected independently of trailing assistant step-limit instructions. Private provenance is not stored in the OpenCode transcript or sent in upstream headers/messages.

Between compactions, summary bytes and retained messages stay stable. A compaction boundary intentionally changes history; the lower recovery target prevents repeated tiny rewrites every turn. Opaque/signed and multimodal data remain exact. If mandatory content alone cannot fit, the plugin fails with the region/budget instead of silently cutting the current user request or a tool pair. Semantic summaries are inherently lossy; quality needs evaluation with the actual on-prem model.

The core's `client.session.summarize()` cannot safely be awaited inside a running request hook: it waits for the same session loop containing that hook. This is why the implementation compacts only outgoing requests. It reduces wire history but cannot remove OpenCode's own cost of loading/converting the full stored transcript. On restart, in-memory summaries are rebuilt through bounded folding before an oversized main request is sent.

For a fully guarded profile, use native `compaction.auto: false` and `prune: false` as shown above. With native compaction still enabled, its independent old-usage trigger can fire after a long completion; builtin title/summary/compaction requests are budget-checked but are not recursively summarized. To turn plugin compaction off, use plugin `compaction: false` and restore native `compaction.auto: true`.

## Model-specific template settings

For an affected Qwen template that supports it, put `chat_template_kwargs: { "preserve_thinking": true }` in that model's existing `options`. This preserves historical thinking; it does not force current-turn thinking on. Do not assume an arbitrary company model alias uses Qwen or that every LiteLLM deployment forwards the same extras. The plugin repairs the known camelCase spellings generated by experimental mode expansion, including template kwargs, thinking-preservation flags, cache salt and token-limit names; it does not invent template flags.

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
- State is in memory, per plugin instance/session/model/agent. Restart/reload may require a fresh warm-up. Deleted sessions and dispose clear retained prompt state. The original OpenCode history is untouched.
- The gate cannot limit other OS processes, other clients, or LiteLLM's own hidden fan-out. Parent/subagent requests share it only when they use the same configured endpoint and module instance.
- Queue time is inside OpenCode's normal request timeout. Very long queues can hit that timeout. Abort/cancel is propagated, but only the inference server can confirm that GPU resources have actually been reclaimed.
- Shortening a builtin prompt changes the model's behavioral guidance. `compactPrompt: false` restores it while keeping the other protections and date removal.
- User/project/MCP policy updates, agent/model changes, tool catalog changes, compaction and deliberate history edits can require a new prefix. Freezing them to force hits would be incorrect.
- Match model metadata to the **served** context limit, not the model vendor's maximum. A wrong `limit.context` or `limit.input` cannot be repaired by a cache hint.

## Validation

`bun run typecheck`, `bun test`, `bun run smoke`, and `bun run smoke:compaction` are local checks. The first smoke uses the actual pinned 1.19.4 CLI with isolated config/data directories and an event-controlled loopback OpenAI-compatible server. It exercises a real file read and the next model request, both with serialized titles and titles disabled. The compaction smoke drives multiple user turns through the actual pinned server and checks reduced wire history, reused summaries and unchanged stored user history. No paid model is called. Temporary data and child processes are removed on exit.

Builtin replacement was independently exercised against all 11 original provider outputs, including both substituted Muse names: suffix preservation, boundary rejection, custom-prompt preservation and repeat-call stability passed. Original builtin sizes range from 4,076 to 15,372 characters; replacement is 1,887 characters (53.7%-87.7% smaller). These are character counts, not model-token or GPU-memory measurements.

Observed with the shipped bundle loaded in the actual 1.19.4 runtime:

| Scenario | Result |
| --- | --- |
| Typecheck and regression suite | Clean typecheck; 45 tests passed, 371 assertions. |
| Title plus main/read round trip, unmodified | 3 HTTP generations, peak 2 active, 9,625 system-message characters. |
| Same scenario with plugin | 3 generations, peak 1 active, 2,672 system-message characters; no generated date; previous request prefix preserved on the tool round trip. |
| Plugin plus native title disable | 2 generations, peak 1 active; real read result still returned to the model. |
| 15-turn rolling-compaction scenario | 15 main calls, 4 summary calls; 10 main calls carried a summary and 6 reused it without another summary inference. |
| Wire-history reduction | For example, serialized message characters fell from 78,808 to 49,880 at a compaction boundary; similar reductions occurred at later boundaries. |
| Stored transcript | All 15 original user turns remained in OpenCode storage. |

The summary responses in the local scenarios are controlled fixtures. They verify orchestration, budgeting, protocol preservation and state reuse, not the semantic quality or latency of the private model.

The independent review identified three integration defects: tool-generated media being mistaken for the current user, a trailing step-limit instruction unprotecting the latest tool batch, and unresolved URL variables bypassing interception. All three were corrected and covered by the final regression run. The final bundle smoke also uses an environment-templated endpoint and verifies that provenance markers/private headers never reach inference or stored user history.
