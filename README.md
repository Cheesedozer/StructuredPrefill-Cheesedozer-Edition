# StructuredPrefill

Forces the AI's reply to start with your prefill, even on models that dropped prefill support or refuse off it. It also lets you hide that forced text, ban words outright, and template the start of every reply with fill-in slots.

You probably don't need this unless you already use prefills and newer models keep ignoring them, refusing them, or erroring on them.

***

## Install

In SillyTavern or SillyBunny: **Extensions → Install extension**, paste
`https://github.com/Cheesedozer/StructuredPrefill-Cheesedozer-Edition`

***

## Quick start

1. Connect to a **Chat Completion** API that supports structured outputs (e.g. OpenRouter, OpenAI, Google AI Studio; see [Compatibility](#compatibility)).
2. Open **Extensions → StructuredPrefill** and tick **Enable StructuredPrefill**.
3. Check the status line under the checkbox. It must say **Active**. If it says **Inactive**, it tells you why.
4. Set your prefill. Pick one:
   - **Simplest:** tick **Use this prefill** and type it in the box.
   - **Use your chat preset's prefill:** leave the box unticked. Your preset's prefill must be an **assistant-role** prompt placed **last** in the Prompt Manager (below Chat History), or set in "Start Claude's answer with". The name doesn't matter.
5. Generate. The reply starts with your prefill. The status line shows what was used.

That's it. Everything below is optional.

***

## Settings

![](https://desu-usergeneratedcontent.xyz/g/image/1774/82/1774821134008.png)

| Setting | What it does |
|---|---|
| **Presets** | Save and switch StructuredPrefill settings (prefill, anti-slop, generator). Separate from your chat preset. STScript: `/structuredprefill-preset "Name"` |
| **Enable StructuredPrefill** | On/off. Only activates when the current API really enforces structured outputs. |
| **Hide prefill text in the final message** | Hides the prefill while streaming and removes it from the saved message, so later turns don't see it. Use `[[keep]]` to keep only the part after it. |
| **Use this prefill** | Use the text in the box instead of your chat preset's prefill. |
| **Banned words** | See [Anti-slop](#anti-slop). |
| **Prefill Generator** | See [`[[pg]]`](#prefill-generator-pg). |
| **Minimum characters after prefix** | The model must write at least this many characters after the prefill. ~80 is a good default. Too high causes rambling. |
| **Continue overlap characters** | See [Continue](#continue). |
| **Newline token** | Leave as is unless your prefill literally contains the token text. |

### Hiding part of the prefill with `[[keep]]`

Everything before `[[keep]]` is hidden; everything after stays visible to you and the model.

```
[instructions the model must write out but you don't want to see]
[[keep]]
{{char}}
```

You see the reply starting from `{{char}}`. Hiding happens once when the reply arrives; editing a message later never strips anything.

***

## Slots

Put `[[...]]` inside your prefill. Each one becomes a rule the model's text must match at that spot. They are not instructions to the model; the output literally can't break them.

| Slot | Model must write |
|---|---|
| `[[w:2]]` / `[[words:2]]` | exactly 2 words |
| `[[w:2-5]]` | 2 to 5 words |
| `[[opt:yes\|no\|maybe]]` | one of the listed options |
| `[[free]]` | any non-empty text |
| `[[line]]` | one line, no newlines |
| `[[lines:2-4]]` | 2 to 4 lines |
| `[[emotion]]` / `[[mood]]` | one of ~50 common emotions (happy, flustered, ...) |
| `[[name]]` | a character name from the chat ({{user}}, {{char}}, group members) |
| `[[action]]` | 1-6 word narration, no quotes. For `*[[action]]*` |
| `[[thought]]` | 1-10 word inner monologue, no quotes. For `(([[thought]]))` |
| `[[num]]` | any integer |
| `[[number:1-100]]` | integer in range (exact up to a range of 30, by digit count above that) |
| `[[re:<regex>]]` | your own regex, no literal newlines |
| `[[end]]` / `[[stop]]` / `[[eos]]` | reply ends here (not used on Continue) |
| `[[keep]]` | hide everything before this (needs the hide setting) |
| `[[pg]]` | text from the prefill generator |

**Example: status block before every reply**
```
[STATUS]
- location: [[w:1-6]]
- mood: [[emotion]]
- goal: [[w:3-12]]
- hp: [[number:0-100]]

[NOW]
```

**Example: forced thinking block**
```
<thinking>
- last response ended with: [[w:6-35]]
- option A: [[w:8-40]]
- option B: [[w:8-40]]
- going with: option [[opt:A|B]]
- why: [[w:8-40]]
</thinking>
```

Slots are experimental. Many or complex slots can make models behave oddly.

***

## Anti-slop

One word or phrase per line in **Banned words**. On providers that enforce the schema, the model **cannot** output them.

- Case-insensitive: `ozone` also blocks `Ozone`.
- Matches word starts: `gaze` blocks `gazed` and `gazelle`, not `stargaze`.
- Entries starting with punctuation (`—`, `...`) are blocked everywhere.
- Keep it to ~20 single words. Phrases cost far more. If the list gets too large, anti-slop turns off for that reply and you get a warning.
- Emoji can't be banned.

***

## Prefill generator `[[pg]]`

Claude and GPT tend to decide to refuse at the very first word. `[[pg]]` has a separate (uncensored) model write the opening words, then your main model must continue from them as if it wrote them itself.

**Setup**
1. Create a SillyTavern **Connection Profile** for the generator model (Mistral recommended).
2. In **Prefill Generator**, tick **Replace [[pg]]** and pick that profile.
3. Put `[[pg]]` in your prefill. Recommended with hiding on:
   ```
   [[keep]]
   [[pg]]
   ```

Your main connection is not switched. The generator has its own **Extra prompt**, so you can also use it to write a `<thinking>` block for the main model to continue from. If it fails, `[[pg]]` becomes empty, you get a warning, and generation continues. It is not used on Continue.

![](https://desu-usergeneratedcontent.xyz/g/image/1773/09/1773097780141.png)

***

## Continue

Continue normally uses prefill, so it errors or refuses on the same models. StructuredPrefill makes the model repeat the last **N** characters of the message (**Continue overlap characters**) and keep going.

- Higher: cleaner join, bigger pattern.
- `0`: no overlap; the join is unconstrained.

***

## Troubleshooting

| Problem | Fix |
|---|---|
| Status says **Inactive** | Read the reason it gives. Usually: not a Chat Completion API, or the provider can't enforce structured outputs (see [Compatibility](#compatibility)). |
| My preset's prefill isn't used | Check the status line's **Last reply** line; it says why. The prefill must be **assistant** role and the **last** prompt (nothing user-role below it). Or tick **Use this prefill** and paste it in. |
| Nothing happens in group chats | The last message is the previous character's reply, which is chat history, not a prefill. Set a prefill in the box. |
| Provider rejects the request | The pattern is too big. Shorten the prefill, ban fewer words, use fewer slots. |
| Raw `{"response": ...}` shows up | Generation was interrupted mid-stream. Regenerate. |

***

## Compatibility

Works with Chat Completion APIs whose backend enforces JSON Schema structured outputs. OpenRouter models that support it: https://openrouter.ai/models?fmt=cards&supported_parameters=structured_outputs

Turns itself off on these (they would silently drop your prefill):

| Source | Why |
|---|---|
| AI21, DeepSeek, Moonshot, Z.AI, SiliconFlow | JSON mode only, can't enforce a pattern |
| OpenAI Responses, MiniMax, anonymous Pollinations | Structured-output setting is ignored |
| Direct Claude / LinkAPI Claude (except Claude Fable 5.1 in SillyBunny) | Emulated with a tool call that doesn't enforce the pattern. Use OpenRouter for Claude |
| CometAPI | Disabled by the host |

Everything else gets the schema (OpenAI, OpenRouter, Custom/OpenAI-compatible, Google AI Studio / Vertex, Mistral, Cohere, Groq, xAI, NanoGPT, Chutes, Electron Hub, AIML API, Fireworks, Perplexity, Azure OpenAI, Workers AI, LinkAPI non-Claude). Whether a specific model enforces the pattern is up to the provider; some "OpenAI-compatible" ones accept the schema but ignore it.

***

## How it works

Normal prefill adds an assistant message the model continues from. The model knows it was handed that text and can still bail:

> Prefill: `Briolette didn't even have time to turn`
> Reply: `Briolette didn't even have time to turnI'm sorry, but I can't continue this.`

StructuredPrefill instead uses **structured outputs**: the model must reply as JSON matching a schema. The schema's regex `pattern` requires the reply to start with your prefill, so the model writes the prefill itself and is mid-sentence before it can decide to refuse.

1. The prefill is removed from the outgoing request.
2. A schema is built whose pattern requires the reply to start with it (plus your slots and banned words).
3. The model returns `{ "response": "<your prefill>...<continuation>" }`.
4. The extension unwraps it so the chat looks and streams normally.

![](https://desu-usergeneratedcontent.xyz/g/image/1771/57/1771576224775.png)

***

## Extras

- **Use outside SillyTavern:** see [proxy/README.md](./proxy/README.md).
- **Community presets built for this extension** (not mine):
  1. https://files.catbox.moe/t1ysng.json
  2. https://files.catbox.moe/yx0og0.json
