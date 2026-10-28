# OpenCode 1.19.4 versus OMP: history replay and prefix identity

## Scope and evidence limits

Read-only source audit of OpenCode `148842ef7cb1bc34192b3fff57d0f9721ab9c801` (`opencode-1.19.4-source`) and OMP `6f3fbc94c567c0ac619c013dd15d718356eecba1` (`oh-my-pi-comparison-source`). No repository edits, builds, tests, formatters, model calls, LiteLLM calls, or on-prem/vLLM observations were performed. This document is the requested artifact, not a production diagnosis.

This track follows stored messages through the default OC AI SDK runtime, including the compatible SDK's response parser and outgoing converter, and compares OMP's `openai-completions` route. Native OC LLM execution is an explicit opt-in (`OPENCODE_EXPERIMENTAL_NATIVE_LLM`); it is a separate adapter and not silently equated with the SDK route. Flag default: `OC/packages/opencode/src/effect/runtime-flags.ts:4,54`; runtime seam: `OC/packages/opencode/src/session/llm.ts:224-278`.

Prefix identity means equality of the tokens actually rendered by the server's chat template, not equality of the JSON body or a hit-rate field. A mutation at an old history position limits reuse beyond that position; it does not, by itself, erase an unchanged system prefix. Changes to response accounting are classified separately from token changes. Claims about which templates consume a field are conditional unless the server/template is available.

Path aliases below are relative to the two roots (`OC/`, `OMP/`). Dependency aliases are pinned primary source URLs:

- `SDK/` = https://unpkg.com/@ai-sdk/openai-compatible@2.0.41/src/
- `AI/` = https://unpkg.com/ai@6.0.168/src/
- Concrete converter: https://unpkg.com/@ai-sdk/openai-compatible@2.0.41/src/chat/convert-to-openai-compatible-chat-messages.ts
- Concrete parser: https://unpkg.com/@ai-sdk/openai-compatible@2.0.41/src/chat/openai-compatible-chat-language-model.ts
- Concrete UI conversion: https://unpkg.com/ai@6.0.168/src/ui/convert-to-model-messages.ts

Dependency line references below use original source lines, excluding the reader's six-line URL/Content-Type/Method preamble. The read tool's cached URL line anchors include that preamble, so its displayed anchor is the cited dependency line plus 6. Local source references have no offset. OC pins compatible SDK `2.0.41` at `OC/packages/opencode/package.json:71`, AI SDK `6.0.168` at `OC/package.json:67`; its compatible SDK patch changes only error-object forwarding, not history conversion or reasoning parsing (`OC/patches/@ai-sdk%2Fopenai-compatible@2.0.41.patch:1-39`).

## Executive result

The ordinary same-model text/tool history path is deterministic in both clients. **OC does not generically discard nonempty `reasoning_content`, and it does not generate a fresh wire message ID for every replay.** Those explanations are contradicted by the pinned compatible converter.

The clearest old-history mutation remains the known default OC plan/build reminder relocation. Other actual differences are conditional: Qwen history-preservation kwargs; narrower reasoning alias parsing and loss of LiteLLM signed blocks; optional deep pruning; malformed/error recovery; model changes; and non-data media URLs. OMP has explicit cache-aware mechanisms, but their defaults do not universally cover a custom provider pointing at LiteLLM. In particular, its local-backend reasoning replay/preserve detection excludes explicit LiteLLM provider type.

## Ranked differential findings

### 1. Default OC plan/build reminders rewrite old user turns when a new user message arrives

**Classification:** confirmed source difference; direct old-prefix mutation when the reminder branch is active. Established finding, retained here to complete the history evidence chain.

- OC reloads history from storage every loop (`OC/packages/opencode/src/session/prompt.ts:1088-1096`), then applies reminders before conversion (`:1180-1184`). Nonexperimental plan and plan-to-build reminders are only pushed into the current in-memory last user message; there is no `updatePart` in those branches (`OC/packages/opencode/src/session/reminders.ts:23-48`). The build branch uses any historical plan assistant, not only the immediately preceding assistant (`:37-38`).
- Conversion includes synthetic text; it filters only `ignored` and exact empty text (`OC/packages/opencode/src/session/message-v2.ts:208-220`). Therefore request N contains a reminder at user U; after user V is stored, request N+1 reloads U without that reminder and adds the current reminder to V. This changes history at U, not merely at the new tail.
- Within one user/tool loop the reloaded last-user reminder is the same text each step, so this is not automatically a different prompt on every tool call. The churn point is a new last-user selection or a mode/policy transition.
- OC experimental plan-mode transition reminders **are persisted**, unlike the default branch (`OC/packages/opencode/src/session/reminders.ts:51-88`). The `plan_exit` tool also persists a synthetic build user message once, rather than regenerating it per request (`OC/packages/opencode/src/tool/plan.ts:53-69`). Those are counterexamples to a blanket claim that all synthetic reminders are transient.
- OMP's steering envelope explicitly wraps every eligible steering message, regardless of whether it remains at the tail, with a WeakMap preserving message identity (`OMP/packages/coding-agent/src/session/messages.ts:708-758`). Its envelope is fixed template content (`OMP/packages/coding-agent/src/prompts/steering/user-interjection.md:1-4`). This is a relevant existing pattern preventing the same old-message-position bug; it is not evidence that every OMP extension is prefix-stable.

**Plugin-fixability:** partly fixable at `experimental.chat.messages.transform` (called before `toModelMessages`, `OC/.../session/prompt.ts:1255-1262`) or at original `chat.message` ingestion. A correct repair needs append-only turn/transition context and current policy semantics. Do not freeze permissions, pin an obsolete plan restriction indefinitely, or memoize all future messages/system policy just to preserve bytes.

### 2. OMP can request preservation of older Qwen thinking; OC has no equivalent automatic history kwarg

**Classification:** confirmed outgoing-policy difference; high potential impact only for affected templates and eligible OMP configuration.

- OMP sets `qwenPreserveThinking` when the thinking format is `qwen`/`qwen-chat-template` and the endpoint is detected as local (`OMP/packages/catalog/src/compat/resolve.ts:561-563`). The request encoder emits `chat_template_kwargs.preserve_thinking = true`, and only the `qwen` dialect also gets top-level `preserve_thinking` (`OMP/packages/ai/src/providers/openai-shared.ts:1154-1197`). This executes before reasoning-disabled/unsupported early returns, so turning current thinking off does not by itself drop history-preservation kwargs.
- A literal search across OC provider and native protocol sources found no `preserve_thinking` auto-emission. OC's relevant transforms handle interleaved reasoning and provider options but do not add that history knob (`OC/packages/opencode/src/provider/transform.ts:303-353,465-518`). User/provider extra options can still supply it; absence of an automatic default is not inability to configure it.
- OMP's own comments identify older-turn thinking removal by Qwen3.6+ templates as the target mechanism. The actual on-prem template, its version/defaults, and LiteLLM forwarding of `chat_template_kwargs` were not inspected. Therefore the claim that the deployed template changes older rendered tokens is conditional, not an observed result.

**Important limit:** `isLocalOpenAICompatBackend` recognizes `llama.cpp`, `lm-studio`, `vllm`, `ollama`, and local/private URL hosts, **but explicitly excludes `providerType/provider = litellm`** (`OMP/packages/catalog/src/compat/resolve.ts:268-298,350-368`). The LiteLLM provider rule itself adds a session header, not these replay/preserve flags (`OMP/packages/catalog/src/compat/rules/providers/litellm.kdl:1-10`). Arbitrary custom DNS is also not automatically local. Thus this OMP advantage must be checked against the actual resolved provider/model compat, not assumed for every custom -> LiteLLM -> vLLM setup.

**Plugin-fixability:** usually an outgoing provider-options/body configuration change if the template and LiteLLM accept the appropriate kwargs. Gate it by verified model/template/endpoint; do not assume every server accepts an extra top-level key. It does not require freezing the live tool or permission set.

### 3. Enabled OC pruning rewrites deep old tool outputs without OMP's warm-prefix suffix guard

**Classification:** confirmed algorithm difference; conditional risk because OC pruning is disabled unless configured.

- OC immediately returns unless `cfg.compaction?.prune` is truthy (`OC/packages/opencode/src/session/compaction.ts:273-275`). When enabled it skips the newest two user turns, protects configured tool names, then collects old completed tool outputs past its protected-token threshold; if savings meet its threshold it persists `time.compacted` (`:288-315`). There is no provider-cache-warm suffix/idle guard in this algorithm.
- The next normal history conversion replaces each affected output with `[Old tool result content cleared]` and removes its attachments (`OC/packages/opencode/src/session/message-v2.ts:300-326`). The timestamp itself is not sent, but the marker changes old content.
- OMP's actual caller supplies an 8,000-token suffix guard (zero for prefix-bound thinking), retained-history boundary, and optional provider lookback (`OMP/packages/coding-agent/src/session/session-maintenance.ts:308-315,711-728`). Its supersede pass also supplies those boundaries and an idle threshold; this is actual caller wiring, not only a utility comment (`:754-777`). Utility enforcement stops before deep warm-prefix victims (`OMP/packages/agent/src/compaction/pruning.ts:575-615`), while superseded/useless results are limited by suffix/idle conditions (`:453-535`). Pruned results are durably rewritten and conversion caches invalidated (`:98-107`; `OMP/.../session/session-maintenance.ts:731-737`).

**Negative:** with default OC pruning off, this cannot explain default steady-state cache loss. OMP still intentionally rewrites a bounded tail and can flush when it considers the cache cold; it does not make pruning free or entirely append-only.

**Plugin-fixability:** disable the optional prune setting or implement a deliberate cache-aware replacement/compaction policy. Merely memoizing already-pruned prompt text would make outgoing history disagree with durable state and can defeat context reduction. No compaction redesign was performed in this track.

### 4. OC's compatible parser recognizes fewer reasoning forms and loses the source reasoning field name

**Classification:** confirmed parser/replay difference; conditional token-identity/correctness risk for nonstandard or mixed gateway streams.

- The pinned SDK stream parser uses `delta.reasoning_content ?? delta.reasoning` and emits generic reasoning start/delta/end, with no preserved alias name (`SDK/chat/openai-compatible-chat-language-model.ts:482-507`). Its chunk/response schemas declare `reasoning_content` and `reasoning`, but not `reasoning_text`, `thinking_blocks`, or nested LiteLLM provider-specific thinking blocks (`:762-788,801-831`, reader anchors 768-794/807-837).
- An explicitly empty `reasoning_content` masks a simultaneous nonempty `reasoning`, because `??` is not a first-nonempty choice. `reasoning_text` alone is not captured. The schema/processor route does not recover those discarded fields later: `OC/packages/opencode/src/session/llm/ai-sdk.ts:161-197`; stored reasoning is accumulated from normalized deltas at `OC/packages/opencode/src/session/processor.ts:280-312`.
- OMP chooses the first **nonempty** string among `reasoning_content`, `reasoning`, `reasoning_text` and stores the selected field name as thinking signature (`OMP/packages/ai/src/providers/openai-completions.ts:1456-1504,1174-1184`). When replay is enabled its encoder can emit that recognized source field name (`:2612-2634`), while OC normally emits `reasoning_content`; OC can explicitly choose another field via model `interleaved` metadata (`OC/packages/opencode/src/provider/transform.ts:321-348`).
- OMP captures LiteLLM direct/nested signed `thinking_blocks`, gives them precedence over duplicated text aliases, and reconstructs the signed/redacted blocks on replay (`OMP/packages/ai/src/providers/openai-completions.ts:258-302,1186-1226,1474-1497,2660-2661`). The pinned compatible SDK has no equivalent typed capture/replay path. This matters for LiteLLM routing to signed-thinking providers; plain vLLM reasoning text normally has no Anthropic signature to preserve. Do not present signed-block support as an automatic vLLM cache issue.
- OMP also has a configurable cumulative-reasoning delta mode that removes repeated cumulative snapshots (`OMP/packages/ai/src/providers/openai-completions.ts:1233-1258,1289,1499-1503`). OC appends every normalized delta (`OC/.../processor.ts:294-304`). However OMP's generic default is **false** (`OMP/packages/catalog/src/compat/resolve.ts:598`), so this is not an unconditional OMP advantage for an arbitrary gateway.

**Counterexample, important:** OC already replays ordinary nonempty reasoning. The compatible converter gathers `reasoning` parts and sends them as `reasoning_content` (`SDK/chat/convert-to-openai-compatible-chat-messages.ts:151-173,203-209`; reader anchors 157-179,209-215). This does not depend on OC's `interleaved` capability. For a normal same-model stream with one nonempty `reasoning_content` field, OC does not have the alleged drop. OMP's generic replay branch is gated by `replayReasoningContent` or other family compat flags (`OMP/.../openai-completions.ts:2583-2634`); explicit LiteLLM/local-detection exclusions in finding 2 still apply. OC can therefore preserve reasoning in some custom-provider cases where generic OMP defaults do not.

**Plugin-fixability:** a history transform can map already-stored text into an explicit configured field. It cannot recover a field the response parser never captured. Lossless alias/signed-block/cumulative capture needs a response/provider adapter or SDK/core correction, not only a messages hook. Any response normalization must preserve reasoning bytes and avoid duplicate aliases.

### 5. Empty reasoning and assistant handling differ, but this is not generic old-prefix instability

**Classification:** confirmed conversion difference; conditional validation/template risk, usually deterministic.

- OC's SDK sends `reasoning_content` only if the collected string is nonempty (`SDK/chat/convert-to-openai-compatible-chat-messages.ts:203-209`). OC's model-specific `interleaved` transform instead strips reasoning parts and writes the selected field even when empty (`OC/packages/opencode/src/provider/transform.ts:321-348`). DeepSeek-family normalization adds an empty reasoning part; custom new compatible models containing `deepseek` default to interleaved `reasoning_content` (`:303-318`; `OC/packages/opencode/src/provider/provider.ts:1593-1598`). Therefore an empty-field failure cannot be assumed for all DeepSeek configurations.
- OMP can replay empty required reasoning fields and family-specific placeholders (`OMP/packages/ai/src/providers/openai-completions.ts:2663-2734`). Those are compatibility fallbacks, not proof that missing historical thought text can be reconstructed.
- OC skips stored messages with no parts and users whose parts all disappear; it drops exact empty user text, not whitespace (`OC/packages/opencode/src/session/message-v2.ts:205-251`). The AI SDK removes empty text parts but does not generically drop an otherwise empty assistant (`AI/prompt/convert-to-language-model-prompt.ts:193-229`; reader anchors 199-235). The compatible converter can send `assistant.content = ""` with neither calls nor reasoning.
- OMP drops whitespace-only user text and empty assistant text blocks and skips an assistant with no content, tool calls, or reasoning field (`OMP/packages/ai/src/providers/openai-completions.ts:2486-2527,2535-2539,2770-2789`). Its provider wrapper retries an uncommitted empty completion instead of exposing each failed attempt as a completed historical turn (`OMP/packages/ai/src/utils/empty-completion-retry.ts:103-159`; actual wrapper call `OMP/.../openai-completions.ts:1886-1891`).

An extra empty assistant can alter role delimiters or trigger a strict template rejection. It is added at the new output tail, however, and these deterministic filters do not by themselves mutate older ordinary text on every later request. Whitespace filtering can also make OMP less byte-faithful than OC for whitespace-only blocks; neither should be described as universally exact generated-token replay.

**Plugin-fixability:** a messages hook can remove demonstrably empty/no-call artifacts for a verified template. Preserving an explicitly required empty reasoning field is an outgoing model-compat choice. Do not silently delete a valid reasoning-only turn or its controls merely because visible text is empty.

### 6. Error/retry recovery can change the replayed tail in materially different ways

**Classification:** confirmed source structure; conditional error-path risk, not evidence of normal steady-state prefix busting.

- OC omits assistant messages with errors except the specific aborted-with-other-parts exception (`OC/packages/opencode/src/session/message-v2.ts:258-265`). It synthesizes interrupted results for pending/running calls, and prefers a recorded partial output over an error string for interrupted errors (`:338-373`). Processor cleanup persists unfinished text/reasoning and marks remaining calls interrupted (`OC/packages/opencode/src/session/processor.ts:567-609`). These are deliberate tail repairs, not per-request random text.
- OC retries the same `streamInput` inside the same processor/assistant message. Each attempt resets only the current text/reasoning pointers before streaming; existing persisted parts are not removed by the retry body (`OC/.../processor.ts:640-690`). Each stream start can persist a new step-start, and text/reasoning starts persist new part IDs (`:280-291,424-433,500-510`). The retry policy considers the error, not whether a meaningful partial response was already persisted (`OC/.../retry.ts:85-98,183-205`).
- **[INFERENCE from those branches]** a retryable failure after partial output followed by success can leave failed-attempt and successful-attempt parts under one final non-error assistant. UI conversion splits them at step-start boundaries (`AI/ui/convert-to-model-messages.ts:346-360`; reader anchors 352-366). This is a hidden replay-shape/correctness concern. It is not a proven deep-prefix mutation: before the next successful request these parts were newly generated output, and the retry itself used the unchanged input history. A runtime fixture would be needed to establish a concrete gateway failure case.
- OMP's provider retry wrapper retries only while output remains uncommitted (`OMP/packages/ai/src/utils/empty-completion-retry.ts:117-159`). Its session-level recovery separately removes failed turns before ordinary retries but preserves safe tool/result continuations (`OMP/packages/coding-agent/src/session/turn-recovery.ts:1689-1707,3030-3045`). Provider transformation preserves errored/aborted partial assistants with actionable content and fills missing tool results, while dropping truncated thinking-only assistants (`OMP/packages/ai/src/providers/transform-messages.ts:1383-1414`). Thus OMP also repairs history; it does not blindly replay all errors unchanged.

**Plugin-fixability:** ordinary message hooks can normalize a known bad stored tail, but distinguishing retry attempts and executed tool side effects correctly is a processor/recovery concern. A blanket plugin that drops all failed text/calls or retries it can duplicate execution or lose useful partial context. The proper fix cannot be inferred solely from a cache miss.

### 7. Remote attachment URLs can change OC's request bytes even when stored history is unchanged

**Classification:** confirmed client serialization difference; conditional multimodal risk; not specific to text KV reuse.

- OC resolves local file attachments into stored text or data URLs during user-message creation and persists those parts once (`OC/packages/opencode/src/session/prompt.ts:785-805,830-865,949-968,995-1047`). These normal local attachments are not re-read from disk on each model call.
- A supplied HTTP(S) URL can remain a stored file URL (`OC/.../prompt.ts:785-808,992`; `OC/.../message-v2.ts:222-235`). The AI SDK prompt converter plans downloads of user file/image URLs before model middleware and replaces them with downloaded bytes (`AI/prompt/convert-to-language-model-prompt.ts:34-47,340-401,447-453`; reader anchors 40-53,346-407,453-459). The compatible model defaults to no supported URL patterns (`SDK/chat/openai-compatible-chat-language-model.ts:111-113`; reader anchors 117-119), and its generic provider constructor does not supply one (`SDK/openai-compatible-provider.ts:159-166`; reader anchors 165-172). The default download function performs downloads for unsupported URLs, with no persistent memo in that function (`AI/util/download/download-function.ts:36-45`; reader anchors 42-51).
- OMP serializes stored image URLs directly when present, otherwise stored base64 (`OMP/packages/ai/src/providers/openai-completions.ts:2499-2510,2830-2838`). OC may therefore have changing data-URL bytes where OMP has a stable URL string. But a changing remote resource can also change the downstream image content under OMP, so this is not proof that OMP's effective multimodal prefix remains identical. Media identity/encoding and multimodal-cache implementation must be observed.

**Plugin-fixability:** freezing an intended attachment at its original ingestion can make its content stable; an outgoing messages hook runs too late to recover a previous remote version. This is low priority for an all-text on-prem workload and should not be conflated with mutable instruction-file loading.

### 8. Model/provider changes intentionally rewrite reasoning/metadata; OC and OMP choose different representations

**Classification:** confirmed conditional difference; expected cutover behavior, not spontaneous same-model churn.

- OC determines `differentModel` from stored provider/model IDs, drops provider metadata for cross-model text/calls, and turns nonempty reasoning into plain text (`OC/packages/opencode/src/session/message-v2.ts:255,288-294,328-335,375-388`). It does not include a thinking delimiter around the demoted reasoning.
- OMP sanitizes source/target thinking and can demote foreign reasoning into the target model's canonical dialect; same-model signed reasoning is retained, while unsupported foreign/redacted state is dropped (`OMP/packages/ai/src/providers/transform-messages.ts:1030-1135,1138-1160`). Its completions encoder inserts a separator specifically after demoted-thinking blocks while concatenating ordinary text blocks directly (`OMP/packages/ai/src/providers/openai-completions.ts:2540-2551`).

Switching models/provider identity, input modalities, or compat settings can legitimately change all affected historic messages in either client. Renaming a provider alias can trigger OC's cross-model path even if the remote backend is physically the same. New target-model caches cannot be assumed reusable anyway. This should be logged/understood, not fixed by forcing stale signatures into a different provider.

**Plugin-fixability:** limited conversion customization is possible, but the target's reasoning/signature contract takes priority over preserving old bytes. A plugin should not falsify source model identity to retain incompatible signatures.

## Negatives and shared behavior

### Ordinary nonempty reasoning is already preserved by OC

Capture: `SDK/chat/openai-compatible-chat-language-model.ts:482-507`; bridge: `OC/packages/opencode/src/session/llm/ai-sdk.ts:161-197`; storage: `OC/packages/opencode/src/session/processor.ts:280-312`; conversion: `OC/packages/opencode/src/session/message-v2.ts:375-388`; wire: `SDK/chat/convert-to-openai-compatible-chat-messages.ts:151-209`. OC's normal reasoning concatenation uses no separator; OMP joins multiple thinking blocks with a newline (`OMP/.../openai-completions.ts:2633,2655,2709`). For a single normal reasoning block this is equivalent. For multiple blocks neither client's normalized request can be assumed to equal the server's original generated token stream without examining the template and stream boundaries.

### Message IDs, part IDs, timestamps, costs, snapshots and UI metadata are not generic wire entropy

- OC constructs UI messages with stored IDs, and its attachment workaround generates a new `MessageID.ascending()` on each conversion (`OC/.../message-v2.ts:209-213,267-271,395-411`). `AI/ui/convert-to-model-messages.ts` emits roles/content/provider options, not UI message IDs (user branch `:90-129`; assistant emission `:246-249`, reader anchors 96-135/252-255). The compatible converter constructs each final role explicitly and never forwards UI IDs (`SDK/chat/convert-to-openai-compatible-chat-messages.ts:32-50,151-209,239-245`). Thus the fresh synthetic attachment-message ID does **not** bust the wire prefix.
- Database hydration orders parts deterministically by message ID then part ID (`OC/.../message-v2.ts:99-118`), and paging orders messages by creation time then ID (`:438-477`). The IDs can affect stable ordering, but are not generated afresh for existing stored parts.
- Tool-call IDs **do** survive as `tool_calls[].id` / `tool_call_id`; OC uses stored `part.callID` and the compatible converter forwards it (`OC/.../message-v2.ts:328-335,351-369`; `SDK/.../convert-to-openai-compatible-chat-messages.ts:175-185,239-245`). A model can originally generate a random ID, but the stored ID is reused; that is not per-request randomness.
- Streaming compatible SDK rejects a newly opened tool call with no ID/name (`SDK/.../openai-compatible-chat-language-model.ts:532-548`). Its `generateId()` fallback is in response normalization, not every outgoing replay. OMP's empty-ID fallback is a deterministic hash of provider/model/position/name/counter reset per conversion (`OMP/.../openai-completions.ts:2416-2451`), not a per-request random UUID. Removal/reordering of malformed empty-ID calls can change those derived IDs; ordinary nonempty same-model IDs are preserved (`:2371-2401`).

### Tool argument lexical rewriting is shared

OC stores parsed `value.input` (wrapping a nonrecord value) at `OC/.../session/processor.ts:331-347`, then compatible serialization uses `JSON.stringify(part.input)` (`SDK/.../convert-to-openai-compatible-chat-messages.ts:181-185`). OMP also JSON-stringifies parsed tool arguments, or reparses a JSON string before doing so (`OMP/.../openai-completions.ts:445-463,2737-2746`). Original generated whitespace/lexical formatting can therefore be lost on both routes. Stable persisted objects yield stable later requests. This can explain a generated-output-versus-replay token difference, but not an OC-only repeated historical mutation. Sorting JSON argument keys is not automatically a fix: it can introduce a new representation and is not the same as preserving the generated call's exact tokenization.

### Attachments and synthetic tool-result user messages are shared, deterministic constructions

OC extracts incompatible media from completed tool results, clears it only when explicitly stripped/pruned, and injects `Attached media from tool result:` (`OC/.../message-v2.ts:138-163,301-326,391-411`). OMP batches consecutive tool-result images into a user message with `Attached image(s) from tool result:` (`OMP/.../openai-completions.ts:2791-2868`). Different wrapper wording/role boundaries means the two clients do not produce identical prompts, but each deterministic wrapper remains stable for the same history/model. There is no OC-only random user wrapper on ordinary user text in the reviewed loop. OC's subtask and manually executed tool wrappers are persisted (`OC/.../prompt.ts:430-448,478-487`); agent-invocation wrappers are persisted during ingestion (`:974-1047`).

OC unsupported modality replacement is model-capability dependent (`OC/.../provider/transform.ts:409-444`). OMP also omits unsupported images/adds a placeholder and has explicit image-stripping paths (`OMP/.../openai-completions.ts:2493-2527,2804-2819`; `OMP/.../session/messages.ts:767-802`). Those are changes on a capability/image-policy change, not unseen random changes in a fixed text-only run.

### Normalization and family-specific bridges are deterministic, not independent churn sources

Both normalize invalid Unicode: OC `sanitizeSurrogates` in `OC/.../provider/transform.ts:25-27,106-165`; OMP `.toWellFormed()` throughout `OMP/.../openai-completions.ts:2487-2520,2547,2822`. OC Mistral-family ID scrubbing and `Done.` bridge occur at `OC/.../provider/transform.ts:253-300`; OMP has compat-gated ID normalization and an assistant-after-tool bridge (`OMP/.../openai-completions.ts:2377-2401,2470-2484,2849-2856`). Family detection/compat changes can change old representation, but fixed inputs/target settings are deterministic. Neither bridge proves a generic vLLM cache issue.

OC also repairs a failed generated tool call before storage: it lowercases a name if that resolves to an available tool, otherwise replaces the call with the `invalid` tool and a JSON object describing the original tool/error (`OC/.../session/llm.ts:296-311`). OMP removes malformed calls and their paired results from replay according to target tool-name limits (`OMP/.../transform-messages.ts:418-476`). These are materially different error-history policies, and neither guarantees literal replay of malformed generated tokens. They occur at the malformed response/tail, not as random reformatting of healthy old turns; a messages-only plugin should not undo repair and re-execute an invalid or already-run call.

OC assistant text-end does not trim output; it allows `experimental.text.complete` to replace text before storing it (`OC/.../processor.ts:526-545`). Arbitrary installed plugins can mutate completed text, stored messages (`chat.message`), request history, system prompts, and request params (`OC/.../prompt.ts:999-1009,1255-1262`; `OC/.../llm/request.ts:68-78,114-132`). That is an extension surface, not proof that the stock client changes those bytes. OMP extensions/context transforms similarly cannot be assumed inert merely because the base converter memoizes messages.

## Compaction serialization: expected identity boundaries, not redesign

This section records only what is serialized and replayed. Threshold design and proposed compaction implementation belong to the parent track.

- OC summary requests do **not** send the ordinary conversation as its original messages. It clones selected head messages, invokes the history-transform hook on that clone, and serializes them into labeled plaintext (`OC/.../session/compaction.ts:54-84,378-391`). User text is joined with newlines, attachments become textual descriptors, assistant reasoning is labeled, tool arguments are JSON-stringified, and long outputs are truncated. It sends that conversation/prompt in one user text message with no tools (`:425-449`). Expecting full normal-chat cache reuse for that different summarizer request is incorrect.
- OC post-compaction history is a compaction user marker (`What did we do so far?`), stored summary assistant, retained original tail, and continuation/replayed user as applicable (`OC/.../message-v2.ts:238-243,534-584`). `filterCompacted` explicitly reorders the summary before its retained tail. The summary and tail become stable after this intentional rewrite; the operation is not a new random reconstruction each ordinary request.
- Auto-continuation is persisted; overflow replay replaces media with textual attachment markers and creates new stored user/part IDs once (`OC/.../compaction.ts:468-491,520-546`). IDs are not wire message IDs. OC's separate `truncateToolOutput(...toolOutputMaxChars)` is an explicit conversion option, not an automatic normal-history mutation (`OC/.../message-v2.ts:47-52,303-305`); the normal prompt call supplies no such option (`OC/.../prompt.ts:1262`).
- OMP's text summarizer also calls a dedicated conversation serializer rather than promising ordinary-chat prefix equality (`OMP/packages/agent/src/compaction/compaction.ts:927-932`; `OMP/.../compaction/utils.ts:231-335`). It has dialect/drop-thinking policy, excludes paired useless results, and truncates summary tool text. These differences can change the summary request and summary quality, but are not evidence of unsolicited ordinary-turn mutation.
- OMP reconstructs summary first then retained tail from durable entries (`OMP/packages/coding-agent/src/session/session-context.ts:505-567,593-635`). Generic summaries become a user message containing a fixed summary wrapper, with optional archive/images/native payload (`OMP/packages/agent/src/compaction/messages.ts:243-263`; wrapper `OMP/.../compaction/prompts/compaction-summary-context.md:1-6`). `timestamp`, `historyRewriteAt`, `tokensBefore`, and method fields control bookkeeping/selection; the completions encoder does not emit those fields as JSON prompt metadata. Native Responses/Anthropic payload replay lanes are separate from a custom compatible chat request and cannot be assumed active for vLLM.

**Conclusion:** compaction deliberately changes the history root in both clients. This track does not find a unique OC per-request compaction serialization nonce. It does find that OC's text-summary call is a distinct prompt and that hooks run on that summary input too; a plugin must not assume every history-transform invocation is an ordinary main-agent turn.

## Usage accounting: a differential observation can be misread as cache failure

**Classification:** confirmed accounting difference; not relevant to token-prefix identity by itself.

- Compatible SDK usage normalization reads `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens`; cache-write is undefined (`SDK/chat/convert-openai-compatible-chat-usage.ts:3-54`). Its nested token-details schemas do not declare alternative cache keys (`SDK/chat/openai-compatible-chat-language-model.ts:734-750`). The OC bridge takes normalized usage fields and `Session.getUsage` does not recover generic compatible aliases from raw usage (`OC/.../session/llm/ai-sdk.ts:46-64`; `OC/.../session/session.ts:338-375`).
- OMP accepts top-level `cached_tokens`, `prompt_cache_hit_tokens`, `cachedContentTokenCount`, nested cached tokens, cache-write/miss variants, and a cached-token response-header fallback (`OMP/packages/ai/src/providers/openai-completions.ts:2260-2265,2268-2331`). Its shared accounting keeps input/cache buckets consistent (`OMP/packages/ai/src/providers/openai-shared.ts:524-541`). It also checks usage under `choice.usage` when top-level usage is absent (`OMP/.../openai-completions.ts:1407-1425`).
- Therefore the same successful cache hit can show as zero cached tokens in OC if the gateway reports only an unsupported alias. With normal OpenAI-shaped `prompt_tokens_details.cached_tokens`, both paths read the hit. Neither client can infer missing server cache telemetry from client source. If only cache-hit attribution is absent but `prompt_tokens` is correct, this need not make total context usage wrong; it primarily changes reporting/cost buckets. Missing/alternate total-input usage can separately affect budgeting/compaction, which is the parent track.

**Plugin-fixability:** response/usage adapter or gateway normalization, not a history cache plugin. First compare raw gateway usage to parsed usage before inferring that a zero read counter proves a KV miss.

## Covered-path inventory

Ranges below were read directly or, where marked `literal search`, inspected by scoped literal search. Files encountered only as broad search candidates are not claimed as audited.

| Source | Covered ranges / purpose |
|---|---|
| OC `packages/opencode/src/session/message-v2.ts` | 1-200, 200-430, 438-534, 534-590: storage hydration/order, part filtering, tools/media/errors/reasoning, UI conversion, compacted-history selection |
| OC `packages/opencode/src/session/prompt.ts` | 202-224 via exact call-site search; 430-487 via exact wrapper search; 650-710, 785-865, 947-1058, 1085-1315: ingestion, persisted wrappers/attachments, loop reload, reminders/hooks, normal conversion call |
| OC `packages/opencode/src/session/reminders.ts` | 1-92: default ephemeral versus experimental persisted reminders |
| OC `packages/opencode/src/tool/plan.ts` | 1-79: persisted plan-exit build message |
| OC `packages/opencode/src/session/processor.ts` | 207-312 via initial source/part searches; 315-351, 400-550, 553-695: reasoning/text/tool storage, step boundaries, completion hooks, cleanup/retry |
| OC `packages/opencode/src/session/retry.ts` | 1-209: error-only retry decisions and same-process retry schedule |
| OC `packages/opencode/src/session/llm.ts` | 1-240, 250-342: prepared message flow, native opt-in seam, SDK repairToolCall and transform middleware |
| OC `packages/opencode/src/session/llm/request.ts` | 1-228: system/message assembly, params hooks, tool sorting/permissions and headers; live policy not proposed for freezing |
| OC `packages/opencode/src/session/llm/ai-sdk.ts` | 31-64 via exact accounting search; 70-112, 160-255: normalized reasoning/tool/usage event bridge |
| OC `packages/opencode/src/provider/transform.ts` | 1-529; literal searches for preserve/reasoning fields across provider+protocol sources: Unicode, empty/family normalization, interleaved metadata, caching/options, media capabilities |
| OC `packages/opencode/src/provider/provider.ts` | 1580-1600; exact searches around 1809: custom model interleaved default and includeUsage |
| OC `packages/opencode/src/session/compaction.ts` | 45-95, 270-317, 375-455, 468-546; exact call-site search: summary serialization/prune/replay/continuation only |
| OC `packages/opencode/src/session/session.ts` | 338-379: normalized usage and cache buckets |
| OC `packages/opencode/src/effect/runtime-flags.ts` | 1-25, 50-57: native runtime flag default |
| OC `packages/core/src/plugin/provider/openai-compatible.ts` | exact search lines 4-13: generic compatible SDK construction/includeUsage |
| OC `package.json`, `packages/opencode/package.json` | exact pin searches lines 67,164 / 70-74,113: dependency versions and SDK patch |
| OC `patches/@ai-sdk%2Fopenai-compatible@2.0.41.patch` | 1-39: only error object forwarding |
| SDK `chat/convert-to-openai-compatible-chat-messages.ts` | complete converter, with targeted 151-245: final role/content/metadata, reasoning, ID/argument/tool-output/media serialization |
| SDK `chat/openai-compatible-chat-language-model.ts` | initial source portion plus targeted 294-434, 474-694, 724-845: reasoning/tool parser, supportedUrls, usage schemas; getArgs transport ownership remains sibling track |
| SDK `chat/convert-openai-compatible-chat-usage.ts` | complete 1-55: normalized token/cache fields |
| SDK `openai-compatible-provider.ts` | complete 1-198: generic chat construction has no URL-support override |
| AI `ui/convert-to-model-messages.ts` | full conversion read across initial and tail ranges: UI IDs removed; roles, step-start block splitting, provider metadata, tool-result output |
| AI `prompt/convert-to-language-model-prompt.ts` | 1-244, 284-489: empty-part filtering, tool result validation/grouping, user asset downloads and byte replacement |
| AI `util/download/download-function.ts` | complete 1-45: default download behavior |
| OMP `packages/ai/src/providers/openai-completions.ts` | 258-316, 445-465, 1174-1276, 1289 exact reference, 1410-1560, 1886-1891 exact wrapper reference, 2260-2334, 2341-2910: parse, replay, IDs, reasoning, usage, media, synthetic bridges |
| OMP `packages/ai/src/providers/transform-messages.ts` | 1-180, 400-485, 483-500 exact reference, 950-1170, 1360-1450: deterministic ID normalization, malformed-call sanitization, source-aware thinking, errors/orphans; no claim that all provider-specific branches are relevant to vLLM |
| OMP `packages/ai/src/providers/openai-shared.ts` | 524-570, 1110-1215: usage accounting and Qwen preserve-history encoder; cache-key routing covered only as context |
| OMP `packages/ai/src/utils/empty-completion-retry.ts` | 90-175: uncommitted-output retry buffering |
| OMP `packages/catalog/src/compat/resolve.ts` | 255-320, 350-370, 540-570; exact 598 reference: endpoint detection, LiteLLM exclusion, reasoning replay/preserve/cumulative defaults |
| OMP `packages/catalog/src/compat/rules/providers/litellm.kdl` | 1-10: session header, no replay/preserve override |
| OMP `packages/catalog/src/types.ts` | exact compat-field search: supported multiple system / replayReasoningContent / Qwen flags; explanatory type comments not treated as runtime proof |
| OMP `packages/coding-agent/src/session/messages.ts` | 506-810, 1045-1218; exact conversion/default branch searches: stable steering wrapper, empty/error controls, custom/file/bash/core conversions |
| OMP `packages/coding-agent/src/prompts/steering/user-interjection.md` | 1-4: static steering envelope |
| OMP `packages/coding-agent/src/session/turn-recovery.ts` | 1689-1735, 3030-3047; exact removal call-site search 1235-1243: replay safety and failed-tail removal |
| OMP `packages/coding-agent/src/session/session-maintenance.ts` | 300-321, 711-738, 750-780; exact 3369-3371 call-site reference: actual prune configuration/persistence |
| OMP `packages/agent/src/compaction/pruning.ts` | 1-107 via exact cache-guard search; 450-535, 575-650: mutation/invalidation and suffix/idle/boundary enforcement |
| OMP `packages/agent/src/compaction/messages.ts` | 1-310: summary/custom/core conversion, pruned content serialization |
| OMP `packages/agent/src/compaction/prompts/compaction-summary-context.md` | 1-6: fixed post-compaction user wrapper |
| OMP `packages/agent/src/compaction/utils.ts` | 231-335: summary-only transcript serializer |
| OMP `packages/agent/src/compaction/compaction.ts` | exact call-site search 927-932, 1201-1203, 1246-1250 and native lanes: serializer entry points only; no duplicated compaction algorithm design |
| OMP `packages/coding-agent/src/session/session-context.ts` | 505-568, 593-636: durable summary-first/tail replay order and native payload distinction |

## Checks and unverified prerequisites

All conclusions above are source inspection, not an executed test. No build/test/lint/formatter was run, as assigned. The exact on-prem model ID and resolved compat, LiteLLM request/response transformations, vLLM version, chat template and reasoning parser, rendered prompt token IDs, media hashes, cache blocks, and raw usage were unavailable. They remain prerequisites for attributing an actual production miss. A stale/absent `cached_tokens` metric alone is not evidence of token-prefix inequality.

Scope is complete for stored-history -> default compatible SDK wire comparison. No code or plugin implementation was changed by this worker.
