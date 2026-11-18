# OpenCode KV Guard

KV Guard protects request prefixes, tracks input usage, shortens tool output, and optionally runs rolling wire compaction. It is a local **OpenCode 2.3.0** plugin for explicitly selected external `@ai-sdk/openai-compatible` providers (for example, LiteLLM in front of vLLM or SGLang). It does not limit concurrent requests or change OpenCode's model prompts, tool permissions, or stored session history.

## Install

Use the Bun edition of OpenCode. Build with `bun install --frozen-lockfile` and `bun run build`. Point OpenCode at the **package directory** containing `package.json` and `dist/`, not the JavaScript bundle. The directory's `./server` and `./tui` exports select the two entries. No global installation or provider credential is required to build.

For an existing provider named `litellm`, merge the following into your OpenCode v2 configuration. The example assumes the built package is at `./opencode-kv-guard` relative to the config. Keep your actual endpoint, model definitions, and credentials. Register KV Guard after any other plugins that rewrite the selected provider's HTTP request.

```json
{
  "providers": {
    "litellm": { "package": "aisdk:@ai-sdk/openai-compatible@2.0.41" }
  },
  "plugins": [
    {
      "package": "./opencode-kv-guard",
      "options": {
        "providers": ["litellm"]
      }
    }
  ]
}
```

Keep both `aisdk:` and the adapter version. OpenCode 2.3.0 rewrites the unversioned `aisdk:@ai-sdk/openai-compatible` to its **native** OpenAI-compatible route. That route, Responses, and WebSocket inference are not guarded.

Start a fresh host when first enabling the guard: OpenCode cannot retrofit an SDK already cached without it, particularly for stateless generation. Already-guarded SDKs use the current registration on reload. Restart after removing the guard to discard its cached wrappers. KV Guard prepares the request after OpenCode applies its provider overlay. A plugin that replaces the request *after* KV Guard cannot be covered retroactively; keep KV Guard last among request rewriters.

KV Guard forwards OpenCode's session and affinity headers. It does not add `x-litellm-session-id`; explicitly configured headers still pass through.

For the optional cache sidebar, add the package directory to `plugins` in the **CLI configuration** (`cli.json`), separate from the server configuration. OpenCode provides its own TTFT, elapsed-time and token-rate displays. The plugin sidebar reports cache reads as a share of input (`cache.read / (input + cache.read + cache.write)`), not as a share of output or as a server memory measurement.

## Options

| Option | Behavior |
| --- | --- |
| `providers` | Required nonempty list of explicit provider IDs. |
| `stateDirectory` | Private absolute local directory for SQLite checkpoints. Defaults to `$XDG_STATE_HOME/opencode-kv-guard` or `~/.local/state/opencode-kv-guard`. |
| `maxOutputTokens` | Optional ceiling, not an increase to the context window. |
| `persistence`, `prefixGuard`, `usageAccounting` | Persist request receipts, guard plaintext reasoning replay, and track reported usage. Default `true`. State can contain private conversation data. No cache-hit counter is fabricated when the server omits it. |
| `compaction` | Default `false`. An object such as `{}` enables the portable rolling engine on selected primary Chat Completions requests. See below for the host setting and engine options. |
| `prefixHandoff` | Default `true`; set `false` to skip the prefix-preserving summary stage when rolling compaction is active. |
| `compactPrompt`, `compactTools`, `compactSkills` | Independent opt-ins to remove duplicate stock guidance, shorten verified built-in tool descriptions, and compact the initial skill catalog's markup. All default to `false`. |
| `supersedeReads` | Default `false`. During rolling compaction, replace an older duplicate read with a link to its original result only while a later verbatim witness remains. Skipped for workspace-routed requests. |
| `modelBudgets` | Optional explicit per-model token estimator and compaction trigger; see below. |
| `speculativeCompaction` | Default `false`. Allow an extra summary request after a successful near-limit turn; reuse it only on a matching continuation. Requires rolling compaction. |
| `diagnostics` | Content-free diagnostics on stderr; default `false`. |
| `shrinkToolOutputs` | Set `false` to leave results to the host or specify `{ "maxBytes": 16384, "maxLines": 400 }`. The host's global `tool_output` limits are a separate setting. |

OpenCode owns tool routing. Built-in `read`, `glob`, and `grep` remain direct: on stock 2.3.0, moving them into `execute` would turn an interactive permission rejection into a catchable program error instead of interrupting the session. KV Guard does not register aliases or change permissions. MCP tools already in native Code Mode continue to work.

Prompt shortening changes only model-facing text in primary requests. It does not change tool IDs, argument schemas, execution, or permissions. Unknown or customized prompts and tool descriptions are left alone. The skill catalog keeps every advertised ID, name and description; host-generated skill updates keep their native format.

## Rolling compaction on OpenCode 2.3.0

In a profile for the guarded providers, set OpenCode's **top-level** `"compaction": { "auto": false }` and add `"compaction": {}` to **KV Guard's plugin options**. These are different settings. OpenCode's flag is profile-wide and turns off both its automatic compaction and its overflow recovery, including for providers KV Guard does not cover. Keep native autoscheduling on in profiles without the rolling engine. Native `/compact` remains usable: it saves a native summary and invalidates the plugin's saved projection. It does not run the rolling engine.

```json
{
  "compaction": { "auto": false },
  "plugins": [
    {
      "package": "./opencode-kv-guard",
      "options": { "providers": ["litellm"], "compaction": {} }
    }
  ]
}
```

The plugin budgets the actual Chat Completions request after OpenCode's model body overlay and the plugin's output cap. Configure the served model's `limit.context`, `limit.output` and, when available, `limit.input`. If model limits are unavailable or the current user message cannot be matched on the wire, KV Guard leaves compaction off for that request. The hard input ceiling is `min(input, context - requestedOutput) - marginTokens`; a separate trigger and recovery target control when to shorten the prompt. Provider usage can anchor the estimate when the measured prefix is identical. Byte estimation is not a tokenizer.

1. **Handoff** asks for a summary with the live prefix and tool catalog still intact.
2. **Shake** saves eligible tool results and large blocks verbatim under private, content-addressed files in OpenCode's `tool-output` directory, then substitutes readable references.
3. **Soft** folds older complete message/tool groups into a rolling summary, including prior summaries and tracked file operations.
4. **Rescue** retries shake with less tail protection and drops eligible media before reporting a dead end. Current user text and tool-call argument boundaries are preserved.

Auxiliary summaries run on the same provider. A recognized provider context-overflow error can trigger one recovery retry without handoff. Incomplete summaries and summary tool calls are never accepted. With persistence enabled, later requests and restarts reuse the projection only against matching history; native compaction, revert, fork and deletion invalidate the relevant checkpoint. Original turns remain in OpenCode's transcript.

OpenCode 2.3.0 starts the primary request's header deadline before its HTTP hook, so time spent doing pre-send compaction counts toward that deadline.

Engine options inside the plugin's `compaction` object: `thresholdTokens` (takes precedence over `thresholdPercent`), `thresholdPercent`, `reserveTokens` (default floor 16,384 with the small-window fallback), `keepRecentTokens` (default 20,000, bounded by the recovery budget), `marginTokens` (default 0), `summaryOutputTokens` (optional ceiling), and `bytesPerToken` (default 4). The default trigger is context minus reserve; normal recovery targets 80% of the trigger without exceeding the hard input ceiling.

Set `modelBudgets` in plugin options, for example:

```json
{
  "modelBudgets": [
    { "providerID": "litellm", "modelID": "my-alias", "tokenizer": "o200k_base", "thresholdPercent": 80 }
  ]
}
```

`modelID` is the configured OpenCode model ID, not the upstream wire name. Specify `o200k_base` or `cl100k_base` only when you know the served model uses it. Provider usage still anchors identical measured prefixes, and unsupported payloads fall back to the byte estimate. A model-specific trigger overrides the global `thresholdTokens` and `thresholdPercent`; it does not raise the provider's context limit.

Read supersession runs only during compaction. It requires completed native `read` results corroborated by the stored session and the final request, with an equal or fully covering newer read; shortened, failed, or ambiguous results are not proof. The file linked in the prompt contains the older result verbatim. Neither that replacement nor any summary changes the original transcript.

Speculation can incur an extra provider call and does not save tokens by itself. It does not change the current prompt or checkpoint. A completed draft is adopted only if a later request needs compaction and extends the same request history and policy. A new request never waits for an unfinished draft; history changes and plugin unload cancel outstanding work. Use OpenCode's `experimental.background_compaction` instead in a native-compaction profile.

## Moving from the 1.19 plugin

- Replace `plugin`/file URL/tuple configuration with `plugins` and a package directory. Remove the v1 copy from auto-discovery. Old plugin options are rejected instead of silently doing nothing.
- Remove `maxConcurrent` and `crossProcess` from plugin options. KV Guard no longer queues requests for an endpoint; session checkpoints are still checked for conflicting writes.
- Remove `glm` from plugin options. Set any required request parameters in the provider/model `body`. The provider must return the reasoning fields and incremental deltas expected by the compatible SDK; KV Guard does not rewrite responses.
- Enable rolling compaction explicitly as shown above. The v1 `/kv-compact` command and v1-specific native prompt overrides are not part of the 2.3.0 integration. Existing OpenCode session history remains the source of truth; old plugin checkpoints are not imported.
- Date/environment updates, Plan transitions, skill IDs and the live tool catalog are host instructions. Do not install the old prompt hashes, XML matchers, frozen tool catalogs, or 1.19.4 experimental MCP flag for them.
- Do not compare cache rates across a mid-session upgrade as if the wire prefix were unchanged. Native historical compaction data and private plugin request receipts are different things; the latter must never replace the former.

## Verification

`bun run typecheck`, `bun run build`, and `bun test` check types, distribution and behavior. With the pinned `@opencode/cli` executable installed, `bun run smoke` and `bun run smoke:compaction` exercise the real v2 server against an isolated loopback provider. Bun blocks dependency install scripts by default; the CLI package needs its own postinstall to install the platform executable. Follow local approval policy before enabling that script. The plugin does not require it when installed into an existing OpenCode 2.3.0 installation.

The files under `analysis/` and `ANALYSIS.md` are historical research on the 1.19.4 host, not claims about this release.
