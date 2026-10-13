#### INTRO

Just to say this first: 90% of people probably do not need StructuredPrefill.

This extension is mainly for those who know what prefills are and are tired of newer models half-ignoring them, refusing them, or erroring on them entirely. It started as a way to get prefill functionality back on models that broke it, but it turned into a power-user output control extension.

StructuredPrefill is a way to control the AI’s output much more aggressively than normal SillyTavern prefill can. You can force specific starts, hide parts of that forced text from the final visible message, ban slop words, and do a lot of weird power-user formatting/control stuff with stubs like [[keep]] and [[pg]].

If you are not interested in a power-user output control extension, you do not need this. If you do, this extension can be one of the most strongest tools in SillyTavern.

#### WHAT IS THE PROBLEM

Models like Opus 4.6 recently removed prefill support. Prefill is when you put text at the start of the AI's response to force it to begin a certain way. It has been a core part of roleplay setups forever and now providers are killing it.

The other problem: even when prefill WAS supported, models like GPT and Claude could still refuse off of it. Like this:

> Chat history is full of an ongoing roleplay. You set the prefill to `Briolette didn't even have time to turn` to force the scene to continue. The model sees it and outputs:
>
> `Briolette didn't even have time to turnI'm sorry, but I can't continue this.`

The prefill got appended but the model just refused anyway. Classic prefill is injection, the model knows it was put there, it looks at it, and can still refuse.

***

#### WHAT STRUCTURED OUTPUTS ARE

Structured outputs are a response format where the model is forced to reply as valid JSON matching a JSON Schema you provide. Normally used for app stuff like data extraction or classification.

StructuredPrefill uses the `pattern` field in JSON Schema to force the response string to **start with your prefill text via regex**. The model has to generate that text itself to satisfy the schema. It is not injected. The model genuinely "wrote" it.

That is the core difference. The model thinks it started the response that way on its own.

![Structured outputs process](https://humanloop.com/blog/structured-outputs/structured-outputs-process.png)

***

#### INSTALL

In SillyTavern or SillyBunny: Extensions → Install extension → paste
`https://github.com/Cheesedozer/StructuredPrefill-Cheesedozer-Edition`

***

#### HOW IT WORKS

1. You set a prefill: either in the extension's **Prefill** box, or as a final assistant prompt in your preset's Prompt Manager ("Start Claude's answer with" also counts)
2. StructuredPrefill removes it from the outgoing request
3. It builds a JSON Schema with a regex pattern requiring the response to start with your prefill
4. The model returns `{ "response": "<your prefill>...<continuation>" }`
5. The extension unwraps the JSON so the chat looks and streams normally

![](https://desu-usergeneratedcontent.xyz/g/image/1771/57/1771576224775.png)

***

#### REGULAR PREFILL VS STRUCTUREDPREFILL

**Regular prefill**
SillyTavern appends an assistant message. The model continues from it IF the API allows it. Models like GPT and Claude can still refuse because they recognize the injection and treat it as a starting point they can abandon.

**StructuredPrefill**
The model generates the prefix itself to satisfy the schema constraint. There is no injected assistant message. The model is mid-sentence before it has any opportunity to refuse. The Briolette situation above does not happen because the model is not being handed text to continue.

***

#### EXTENSION SETTINGS

![](https://desu-usergeneratedcontent.xyz/g/image/1774/82/1774821134008.png)

**Enable StructuredPrefill**
Turns the extension on or off. When on, it only activates if the current provider really enforces JSON Schema structured outputs (see COMPATIBILITY). Otherwise it does nothing and your prompt goes through normally.

The line under the checkbox tells you whether it is active for your current API/model, and which prefill it will use. If it says "Inactive", it also says why.

**Hide The Prefill Text In The Final Message**
When on, the prefill part of the reply is hidden while streaming and removed from the saved message, so it looks like a traditional prefill and is not sent back to the model in later turns. This happens once, when the reply arrives: editing a message later never strips anything from it.

Use `[[keep]]` inside your prefill to mark a cutoff point. Everything before `[[keep]]` gets hidden. Everything after stays visible to you AND the model.

Example prefill:
```
[big block of instructions the model needs to see]
[[keep]]
{{char}}
```
The model sees and generates all of it. You only see `{{char}}` onward.

**Prefill**
Tick "Use this prefill" and type your prefill here. This is the simplest setup and works with any chat preset. When unticked, StructuredPrefill uses your preset's own prefill instead: a final assistant-role prompt in the Prompt Manager, or "Start Claude's answer with".

In group chats, or when you generate with an empty input box after an AI reply, the previous AI message is chat history and is never treated as a prefill.

**Advanced**

*Minimum characters after prefix*
Hard constraint. Forces the model to generate at least N characters after the prefill before it is allowed to stop. Prevents the model from satisfying the schema with just the prefix and nothing else.

Setting it too high makes the model ramble to hit the count and increases token cost. Setting it too low risks short completions. Around 80 is reasonable for most RP use. With an anti-slop list the minimum is approximate (counted in words of about six characters).

*Continue overlap characters* (see CONTINUE / OVERLAP below)

*Newline token*
Some providers reject JSON schemas that contain literal newlines. StructuredPrefill replaces real newlines in your prefill with this token when building the schema, then converts them back for display. The default works unless your prefill already contains that exact text; a different token is picked automatically if it does.

***

#### PREFILL GENERATOR `[[pg]]`

Put `[[pg]]` in your prefill and StructuredPrefill will call a separate model to generate those tokens before handing off to your main model.

**Why this exists:**

Models like Claude and GPT refuse at the first token. They see a blank response start, evaluate the context, and output `Sorry` or `I'm sorry`. Even if you try to regex or logit-bias those words out, the model finds another way to refuse because it is making the decision at generation start.

`[[pg]]` calls an uncensored model (Mistral recommended) to generate the first 10-15 tokens. Those tokens go into the schema as the forced prefix. Your main model (Claude, GPT, whatever) then has to continue from them.

The main model sees `Briolette didn't even have time to turn` as text it already produced. It does not get a chance to decide whether to refuse. It is already past that decision point.

This is the same as the manual trick of: generate first 10 words with uncensored model > delete everything after those words > switch back to main model > hit Continue. Except that manual version still fails on Claude/GPT because Continue uses normal prefill and they can still refuse off of it. `[[pg]]` goes through the structured output engine so the model genuinely thinks it wrote those words.

**Dual preset use:**
The prefill generator has its own system prompt. You can use this to have one model generate `<thinking>` content about what should happen next, then feed that output as the prefix for your main model to continue from.

Configuration is in settings: pick a Connection Profile, set max tokens, stop strings, and timeout. The profile's API, model, saved API key and reverse-proxy preset are used. Your main chat connection is not switched.

If `[[pg]]` fails: it becomes empty string, you get an error toast, generation continues normally.

Best practice when using hide prefill:
```
[[keep]]
[[pg]]
```

![](https://desu-usergeneratedcontent.xyz/g/image/1773/09/1773097780141.png)

***

#### CONTINUE / OVERLAP

The Continue button in SillyTavern uses prefill under the hood. On models that removed prefill support this throws a provider error. On models that kept prefill but hate NSFW they can still refuse on Continue for the same reasons.

Overlap takes the last N characters of the existing message and uses them as the schema constraint for the continuation. The model has to regenerate those N characters and then keep going.

**Overlap # of characters**
Higher = safer join, more pattern budget used.
Lower = cheaper, less anchoring at the seam.
0 = no overlap, continuation start is unconstrained.

`[[pg]]` is not used for Continue.

***

#### ANTI-SLOP / BANNED WORDS

One word or phrase per line. StructuredPrefill compiles the list into an automaton and bakes it into the schema pattern as a regex. On providers that enforce the pattern, the model literally cannot output a banned entry. Not "probably won't." Cannot.

Case-insensitive. Banning `ozone` also blocks `Ozone` and `OZONE`.

A banned word is blocked wherever a word starts with it. Banning `gaze` blocks `gaze`, `gazed`, `gazes`, `gazelle`, but not `stargaze`. Entries that start with punctuation or a symbol, like `—` or `...`, are blocked everywhere. Entries are also blocked when they would be split between the end of your prefill and the start of the reply.

Examples of things people ban:
- `ozone` (Gemini LLMism)
- `Elara` (generic name every model defaults to)
- `luminous`
- `tapestry`
- `—` (em dash, Claude loves these)
- `firmament`

Keep the list reasonable. Each entry adds to the pattern size, and large patterns can make providers reject the schema. Multi-word phrases cost much more than single words. Around 20 single words is fine. For bigger lists, replies are required to end on punctuation, a space or a newline, which keeps the pattern smaller. If the list gets too large, anti-slop is switched off for that reply and you get a warning toast. Emoji can't be banned.

***

#### COMMUNITY PRESETS

Here are some SillyTavern presets that I found that were built with the extension in mind (not made by me):
1. https://files.catbox.moe/t1ysng.json
2. https://files.catbox.moe/yx0og0.json

***

#### SLOTS / STUBS

Put `[[...]]` markers inside your prefill. These are not instructions to the model. They become regex constraints baked into the schema. The model has to fill them in.

**Word count**
- `[[w:2]]` or `[[words:2]]` - exactly 2 words
- `[[w:2-5]]` - between 2 and 5 words

**Options**
- `[[opt:yes|no|maybe]]` - model picks one of the listed options, nothing else

**Custom regex**
- `[[re:<regex>]]` - your own regex pattern, no literal newlines, `/.../flags` format ok (flags ignored)

**Free text**
- `[[free]]` - any non-empty text, lazy match

**Stop generation**
- `[[end]]` / `[[stop]]` / `[[eos]]` - forces the reply to end at this point, no continuation after the template. Only affects non-Continue generations.
![](https://desu-usergeneratedcontent.xyz/g/image/1772/57/1772579645781.jpg)

**Emotion / mood**
- `[[emotion]]` / `[[mood]]` - one of ~50 common RP emotions: happy, sad, angry, nervous, flustered, etc.

**Lines**
- `[[line]]` - exactly one line, no newlines allowed
- `[[lines:2-4]]` - between 2 and 4 lines separated by newlines

**Names**
- `[[name]]` - auto-fills with character names from the current chat ({{user}}, {{char}}, group members). Falls back to a capitalized-name pattern if no names are available.

**Action / thought**
- `[[action]]` - short narration phrase, 1-6 words, no dialogue quotes. Made for `*[[action]]*` style RP.
- `[[thought]]` - inner monologue phrase, 1-10 words, no dialogue quotes. Made for `(([[thought]]))`.

**Numbers**
- `[[num]]` - any integer
- `[[number:1-100]]` - integer within a range. Ranges of 30 or under are enumerated exactly. Larger ranges are digit-count constrained.

**Example using stubs for a thinking block:**
```
<thinking>
**what just happened**
- last response ended with: [[w:6-35]]
- this response picks up from: [[w:6-35]]
- unresolved mid-action: [[w:6-35]]
- emotional carryover: [[w:3-20]]

**brainstorm paths**
*option A: [[w:1-6]]*
- what happens: [[w:8-40]]
- consequences: [[w:8-35]]

*option B: [[w:1-6]]*
- what happens: [[w:8-40]]
- consequences: [[w:8-35]]

*option C: [[w:1-6]]*
- what happens: [[w:8-40]]
- consequences: [[w:8-35]]

**pick one**
going with: option [[opt:A|B|C]]
why: [[w:8-40]]
</thinking>

[here is my response:]
```

Every `[[...]]` in there is a regex constraint. The model fills in those blanks and has to match the pattern. It is not being told "write 6-35 words here." The schema literally only allows 6-35 words in that position.

**RPG status block example:**
```
[STATUS]
- location: [[w:1-6]]
- time: [[w:1-4]]
- weather: [[w:1-6]]
- mood: [[emotion]]
- goal: [[w:3-12]]
- hp: [[number:0-100]]

[LAST]
[[w:6-35]]

[NOW]
```

Forces every reply to start with a grounded status block before the actual roleplay content.

***

#### STRUCTUREDPREFILL PROXY

Want to use StructuredPrefill outside of sillytavern? Look here: ./proxy/README.md


![](https://desu-usergeneratedcontent.xyz/g/image/1774/11/1774117299808.png)

***

#### COMPATIBILITY

Works in SillyTavern and SillyBunny with Chat Completion APIs whose backend turns the request's JSON Schema into real structured outputs. Model list for OpenRouter: https://openrouter.ai/models?fmt=cards&supported_parameters=structured_outputs

StructuredPrefill switches itself off (and the status line says why) on sources that would silently drop your prefill:

| Source | Why it is skipped |
|---|---|
| AI21, DeepSeek, Moonshot, Z.AI, SiliconFlow | Only JSON mode, which cannot enforce a regex |
| OpenAI Responses, MiniMax, anonymous Pollinations | The structured-output setting is ignored |
| Direct Claude / LinkAPI Claude, except Claude Fable 5.1 in SillyBunny | Emulated with a forced tool call that does not enforce regex. Use OpenRouter for other Claude models |
| CometAPI | Disabled by the host |

Everything else (OpenAI, OpenRouter, Custom/OpenAI-compatible, Google AI Studio / Vertex, Mistral, Cohere, Groq, xAI, NanoGPT, Chutes, Electron Hub, AIML API, Fireworks, Perplexity, Azure OpenAI, Workers AI, LinkAPI non-Claude models) gets the schema. Whether a given model enforces the regex `pattern` is up to the provider.

***

#### LIMITATIONS

- Direct Claude only works for Claude Fable 5.1 in SillyBunny, which sends Anthropic's native structured outputs. Other direct Claude models get JSON Schema as a forced tool call, which does not enforce the pattern. OpenRouter Claude works fine.
- Some "OpenAI-compatible" providers accept `json_schema` but do not enforce regex `pattern` constraints. StructuredPrefill may partially work or be a no-op on those.
- JSON Schema regex support varies by provider. Keep stub patterns simple.
- Very large prefills and anti-slop lists make the schema pattern huge. Some providers reject oversized schemas or get slow.
- Stubs are experimental. Pushing too many constraints or complex patterns can cause unstable model behavior.
- If generation gets interrupted mid-stream you may briefly see raw JSON depending on provider and streaming behavior.
