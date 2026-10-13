import { chat, getRequestHeaders, messageFormatting, saveSettingsDebounced, scrollChatToBottom, updateMessageBlock } from '../../../../script.js';
// Namespace imports for values that only some hosts export (a named import of a missing export would fail to load).
import * as stScript from '../../../../script.js';
import * as stOpenAi from '../../../openai.js';
import { extension_settings } from '../../../extensions.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { enumIcons } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';
import { download, getFileText } from '../../../utils.js';

const { eventSource, event_types, renderExtensionTemplateAsync, callPopup } = SillyTavern.getContext();

const extensionName = 'StructuredPrefill';
// The install folder is named after the git repo (e.g. `third-party/StructuredPrefill-Cheesedozer-Edition`),
// so derive the template path from where this module was actually loaded from.
const extensionPath = (() => {
    try {
        const match = /\/scripts\/extensions\/(.+)\/[^/]*$/.exec(new URL(import.meta.url).pathname);
        if (match) return decodeURIComponent(match[1]);
    } catch {
        // ignore
    }
    return 'third-party/StructuredPrefill';
})();
const STREAM_MARKDOWN_FAST_INTERVAL_MS = 90;
const STREAM_MARKDOWN_LARGE_INTERVAL_MS = 180;
const STREAM_MARKDOWN_HUGE_INTERVAL_MS = 320;
const STREAM_MARKDOWN_LARGE_CHARS = 6000;
const STREAM_MARKDOWN_HUGE_CHARS = 12000;
const STREAM_PLAIN_TEXT_EMERGENCY_CHARS = 25000;
const STREAM_UNCLOSED_FENCE_PLAIN_TEXT_THRESHOLD = 12000;

const defaultPresetSettings = {
    hide_prefill_in_display: true,
    newline_token: '\\n',
    // Require some actual continuation beyond the prefix (in chars).
    min_chars_after_prefix: 80,
    // Number of characters from the end of the existing message used as overlap for Continue.
    continue_overlap_chars: 14,
    // Anti-Slop: newline-separated list of banned words/phrases.
    anti_slop_ban_list: '',

    // Prefill Generator: if the prefill template contains `[[pg]]`, we run a separate (non-streaming) generation
    // using a different connection profile and splice the output into the template before injecting json_schema.
    prefill_gen_enabled: false,
    prefill_gen_extra_prompt: '',
    prefill_gen_extra_prompt_role: 'system',
    prefill_gen_profile_id: '',
    prefill_gen_max_tokens: 15,
    prefill_gen_stop: '',
    prefill_gen_keep_matched_stop_string: false,
    prefill_gen_timeout_ms: 120000,

    // Optional prefill injected/replaced by this extension before json_schema processing.
    override_prefill_enabled: false,
    override_prefill_text: '',
};

const presetSettingKeys = Object.keys(defaultPresetSettings);

const defaultSettings = {
    enabled: true,
    active_preset: 'Default',
    active_preset_idx: 0,
    presets: [{ name: 'Default', ...defaultPresetSettings }],
    ...defaultPresetSettings,
};

const runtimeState = {
    active: false,
    lastInjectedAt: 0,
    latestStreamText: '',
    lastAppliedText: '',
    newlineToken: '',
    patternMode: 'default',
    knownNames: [],
    continue: {
        active: false,
        messageId: -1,
        baseText: '',
        // For hide-prefill display during Continue we need a stable "display base" that does not grow as tokens stream in.
        // Otherwise we'd repeatedly append the whole delta and blow up `extra.display_text`.
        displayBase: '',
        // Continue can have a "prompt manager" assistant prefill that gets combined with the continued message.
        // We strip that prefix from the decoded value before applying it to the message (so Continue does not
        // re-add the PM prefill to the chat history).
        pmStripLiteral: '',
        pmStripRegex: null,
        // Continue can require a small overlap prefix so the model "hooks" onto the existing text naturally.
        // We strip the overlap back out before appending to the base message.
        overlapStripLiteral: '',
        stripLiteral: '',
        stripRegex: null,
    },
    hidePrefillLiteral: '',
    hidePrefillRegex: null,
    streamObserver: null,
    observedMessageId: -1,
    renderQueued: false,
    stopCleanupTimer: null,
    postStopDomFixTimer: null,
    stopping: false,
    stopSessionAt: 0,
    trackedSwipeId: -1,
    applyingDom: 0,
    postFrameQueued: false,
    lastStreamingMarkdownAt: 0,
    lastStreamingHtml: '',
    lastStreamingHtmlMessageId: -1,
    userScrollLocked: false,
    scrollLockListenersAttached: false,
    streamGuard: {
        startedAt: 0,
        lastRawLen: 0,
        lastDecodedLen: 0,
        lastProgressAt: 0,
        suspiciousStreak: 0,
        stopRequested: false,
    },
    // Shown in the status line: which prefill the last generation used, or why none was used.
    lastPrefillReport: '',
    // Regex for the full prefill, used to check after the reply whether the provider enforced it.
    prefillCheckRegex: null,
};

function clearPostStopDomFixTimer() {
    if (runtimeState.postStopDomFixTimer) {
        clearTimeout(runtimeState.postStopDomFixTimer);
        runtimeState.postStopDomFixTimer = null;
    }
}

function schedulePostStopDomFix(messageId, sessionAtStop) {
    clearPostStopDomFixTimer();

    let attemptsLeft = 6;
    const tick = () => {
        // If a new generation started, don't interfere.
        if (runtimeState.lastInjectedAt !== sessionAtStop) {
            runtimeState.postStopDomFixTimer = null;
            return;
        }

        const message = chat?.[messageId];
        if (!message || message.is_user) {
            runtimeState.postStopDomFixTimer = null;
            return;
        }

        try {
            const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
            const domText = textEl instanceof HTMLElement ? String(textEl.textContent ?? '') : '';
            if (looksLikeStructuredJsonBlob(domText)) {
                updateMessageBlock(messageId, message, { rerenderMessage: true });
            }
        } catch {
            // ignore
        }

        attemptsLeft--;
        if (attemptsLeft <= 0) {
            runtimeState.postStopDomFixTimer = null;
            return;
        }

        runtimeState.postStopDomFixTimer = setTimeout(tick, 450);
    };

    runtimeState.postStopDomFixTimer = setTimeout(tick, 250);
}

function getChatScrollElement() {
    const el = document.getElementById('chat');
    return el instanceof HTMLElement ? el : null;
}

function isChatScrolledToBottom(el, thresholdPx = 5) {
    if (!(el instanceof HTMLElement)) return false;
    return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < thresholdPx;
}

function updateUserScrollLockFromScrollEvent() {
    const el = getChatScrollElement();
    if (!el) return;

    // Mirror ST’s “lock when user scrolls up, unlock when they reach bottom”,
    // but don’t lock due to incidental scroll anchoring/layout shifts unless the user actually tried to scroll.
    const atBottom = isChatScrolledToBottom(el, 5);
    if (atBottom) {
        runtimeState.userScrollLocked = false;
        return;
    }

    runtimeState.userScrollLocked = true;
}

function ensureScrollLockListeners() {
    if (runtimeState.scrollLockListenersAttached) return;
    const el = getChatScrollElement();
    if (!el) return;

    runtimeState.scrollLockListenersAttached = true;
    el.addEventListener('scroll', updateUserScrollLockFromScrollEvent, { passive: true });

    // Mirror native ST: autoscroll stays unlocked only while the chat is already at bottom.
    runtimeState.userScrollLocked = !isChatScrolledToBottom(el, 5);
}

function schedulePostFrameGuard(messageId) {
    if (runtimeState.postFrameQueued) return;
    runtimeState.postFrameQueued = true;

    requestAnimationFrame(() => {
        runtimeState.postFrameQueued = false;
        if (!runtimeState.active) return;
        if (messageId !== runtimeState.observedMessageId) return;

        const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        const domText = textEl instanceof HTMLElement ? String(textEl.textContent ?? '') : '';
        // If ST’s own streaming renderer overwrote us after our observer pass, stomp JSON again.
        const domContainsStructuredJson = looksLikeStructuredJsonBlob(domText);
        if (domContainsStructuredJson && typeof runtimeState.lastAppliedText === 'string') {
            applyTextToMessageStreaming(messageId, runtimeState.lastAppliedText);
        }
    });
}

function getDefaultPreset(name = 'Default') {
    return {
        name: String(name ?? 'Default').trim() || 'Default',
        ...defaultPresetSettings,
    };
}

function normalizePresetObject(rawPreset, fallbackName = 'Default') {
    const preset = getDefaultPreset(rawPreset?.name ?? fallbackName);

    preset.hide_prefill_in_display = rawPreset?.hide_prefill_in_display == null
        ? defaultPresetSettings.hide_prefill_in_display
        : !!rawPreset.hide_prefill_in_display;
    preset.newline_token = String(rawPreset?.newline_token ?? defaultPresetSettings.newline_token);
    preset.min_chars_after_prefix = clampInt(rawPreset?.min_chars_after_prefix, 1, 10000, defaultPresetSettings.min_chars_after_prefix);
    preset.continue_overlap_chars = clampInt(rawPreset?.continue_overlap_chars, 0, 120, defaultPresetSettings.continue_overlap_chars);
    preset.anti_slop_ban_list = String(rawPreset?.anti_slop_ban_list ?? defaultPresetSettings.anti_slop_ban_list);

    preset.prefill_gen_enabled = !!rawPreset?.prefill_gen_enabled;
    preset.prefill_gen_extra_prompt = String(rawPreset?.prefill_gen_extra_prompt ?? defaultPresetSettings.prefill_gen_extra_prompt);
    preset.prefill_gen_extra_prompt_role = normalizePrefillGenExtraPromptRole(rawPreset?.prefill_gen_extra_prompt_role);
    preset.prefill_gen_profile_id = String(rawPreset?.prefill_gen_profile_id ?? defaultPresetSettings.prefill_gen_profile_id);
    preset.prefill_gen_max_tokens = clampInt(rawPreset?.prefill_gen_max_tokens, 1, 2048, defaultPresetSettings.prefill_gen_max_tokens);
    preset.prefill_gen_stop = String(rawPreset?.prefill_gen_stop ?? defaultPresetSettings.prefill_gen_stop);
    preset.prefill_gen_keep_matched_stop_string = !!rawPreset?.prefill_gen_keep_matched_stop_string;
    preset.prefill_gen_timeout_ms = clampInt(rawPreset?.prefill_gen_timeout_ms, 500, 120000, defaultPresetSettings.prefill_gen_timeout_ms);

    preset.override_prefill_enabled = !!rawPreset?.override_prefill_enabled;
    preset.override_prefill_text = String(rawPreset?.override_prefill_text ?? defaultPresetSettings.override_prefill_text);

    return preset;
}

function buildPresetFromCurrentRuntime(settings, name = 'Default') {
    const preset = getDefaultPreset(name);
    for (const key of presetSettingKeys) {
        preset[key] = settings?.[key] ?? defaultPresetSettings[key];
    }
    return normalizePresetObject(preset, name);
}

function uniquifyPresetName(name, usedNames) {
    const base = String(name ?? '').trim() || 'Preset';
    if (!usedNames.has(base)) {
        usedNames.add(base);
        return base;
    }

    let counter = 1;
    let next = `${base} ${counter}`;
    while (usedNames.has(next)) {
        counter++;
        next = `${base} ${counter}`;
    }

    usedNames.add(next);
    return next;
}

function getActivePreset(settings = extension_settings[extensionName]) {
    if (!settings || !Array.isArray(settings.presets) || settings.presets.length === 0) return null;
    const idx = clampInt(settings.active_preset_idx, 0, settings.presets.length - 1, 0);
    return settings.presets[idx] ?? null;
}

function applyPresetToRuntimeSettings(preset, { save = false } = {}) {
    const settings = extension_settings[extensionName];
    if (!settings || !preset) return;

    for (const key of presetSettingKeys) {
        settings[key] = preset[key] ?? defaultPresetSettings[key];
    }

    if (save) {
        saveSettingsDebounced();
    }
}

function syncRuntimeSettingsToActivePreset() {
    const settings = extension_settings[extensionName];
    const preset = getActivePreset(settings);
    if (!settings || !preset) return;

    for (const key of presetSettingKeys) {
        preset[key] = settings[key] ?? defaultPresetSettings[key];
    }
}

function updateOrInsertPreset(presets, preset) {
    const index = presets.findIndex(item => item.name === preset.name);
    if (index !== -1) {
        presets[index] = preset;
        return index;
    }

    presets.push(preset);
    return presets.length - 1;
}

function refreshPresetList() {
    const settings = extension_settings[extensionName];
    const $presetList = $('#structuredprefill_preset_list').empty();
    for (const preset of settings.presets) {
        $presetList.append($('<option>', { value: preset.name, text: preset.name }));
    }
    $presetList.val(settings.active_preset);
}

function findPresetIndexByName(name, settings = extension_settings[extensionName]) {
    const lookup = String(name ?? '').trim();
    if (!lookup || !Array.isArray(settings?.presets)) {
        return -1;
    }

    const exactIndex = settings.presets.findIndex(preset => preset.name === lookup);
    if (exactIndex !== -1) {
        return exactIndex;
    }

    const normalizedLookup = lookup.toLocaleLowerCase();
    return settings.presets.findIndex(preset => String(preset.name ?? '').toLocaleLowerCase() === normalizedLookup);
}

function getPresetEnumValues() {
    const settings = extension_settings[extensionName];
    const activeIndex = clampInt(settings?.active_preset_idx, 0, Math.max((settings?.presets?.length ?? 1) - 1, 0), 0);

    return Array.isArray(settings?.presets)
        ? settings.presets.map((preset, index) => new SlashCommandEnumValue(
            preset.name,
            index === activeIndex ? 'Active StructuredPrefill preset' : 'StructuredPrefill preset',
            enumTypes.enum,
            enumIcons.preset,
        ))
        : [];
}

function setPresetSetting(key, value, { rerender = false } = {}) {
    const settings = extension_settings[extensionName];
    settings[key] = value;
    syncRuntimeSettingsToActivePreset();
    if (rerender) {
        renderSettingsToUi();
    }
    saveSettingsDebounced();
}

function changePreset(idx) {
    const settings = extension_settings[extensionName];
    if (!Array.isArray(settings.presets) || !settings.presets.length) return;

    const nextIdx = clampInt(idx, 0, settings.presets.length - 1, 0);
    settings.active_preset_idx = nextIdx;
    settings.active_preset = settings.presets[nextIdx].name;
    applyPresetToRuntimeSettings(settings.presets[nextIdx]);
    renderSettingsToUi();
    saveSettingsDebounced();
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'structuredprefill-preset',
        aliases: ['sp-preset'],
        callback: (_, presetName) => {
            const settings = extension_settings[extensionName];
            const targetIndex = findPresetIndexByName(presetName, settings);
            if (targetIndex === -1) {
                toastr.error(`StructuredPrefill preset "${presetName}" not found.`);
                return '';
            }

            changePreset(targetIndex);
            return settings.presets[targetIndex]?.name ?? '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'StructuredPrefill preset name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => getPresetEnumValues(),
            }),
        ],
        returns: ARGUMENT_TYPE.STRING,
        helpString: 'Change the active StructuredPrefill preset by name.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'structuredprefill-preset-list',
        aliases: ['sp-preset-list'],
        callback: () => JSON.stringify((extension_settings[extensionName]?.presets ?? []).map(preset => preset.name)),
        returns: ARGUMENT_TYPE.LIST,
        helpString: 'List StructuredPrefill preset names as a JSON array.',
    }));
}

async function importPreset(file) {
    if (!file) {
        toastr.error('No file provided.');
        return;
    }

    try {
        const fileText = await getFileText(file);
        const rawPreset = JSON.parse(fileText);
        const preset = normalizePresetObject(rawPreset, 'Imported Preset');
        if (!preset.name) {
            throw new Error('Missing preset name');
        }

        const settings = extension_settings[extensionName];
        const presetIdx = updateOrInsertPreset(settings.presets, preset);
        changePreset(presetIdx);
        toastr.success(`StructuredPrefill preset "${preset.name}" imported.`);
    } catch (error) {
        console.error(error);
        toastr.error('Invalid StructuredPrefill preset JSON.');
    }
}

async function promptForPresetName({ title, initialValue = '' }) {
    const popupHtml = $(await renderExtensionTemplateAsync(extensionPath, 'preset_name_popup'));
    popupHtml.find('.structuredprefill-preset-popup-title').text(title);
    popupHtml.find('.structuredprefill-preset-name').val(String(initialValue ?? ''));

    const confirmed = await callPopup(popupHtml, 'confirm', undefined, { okButton: 'Save' });
    if (!confirmed) {
        return '';
    }

    return String(popupHtml.find('.structuredprefill-preset-name').val() ?? '').trim();
}

function loadSettings() {
    extension_settings[extensionName] ??= {};
    const settings = extension_settings[extensionName];

    if (
        settings.prefill_gen_keep_matched_stop_string == null &&
        settings.prefill_gen_include_profile_stop_strings != null
    ) {
        settings.prefill_gen_keep_matched_stop_string = !!settings.prefill_gen_include_profile_stop_strings;
    }

    settings.enabled ??= defaultSettings.enabled;
    settings.active_preset = String(settings.active_preset ?? defaultSettings.active_preset);
    settings.active_preset_idx = Number.isInteger(settings.active_preset_idx) ? settings.active_preset_idx : defaultSettings.active_preset_idx;

    for (const key of presetSettingKeys) {
        settings[key] ??= defaultPresetSettings[key];
    }

    if (!Array.isArray(settings.presets) || settings.presets.length === 0) {
        settings.presets = [buildPresetFromCurrentRuntime(settings, settings.active_preset || 'Default')];
    } else {
        settings.presets = settings.presets.map((preset, index) => normalizePresetObject(preset, index === 0 ? 'Default' : `Preset ${index + 1}`));
    }

    const usedNames = new Set();
    for (const preset of settings.presets) {
        preset.name = uniquifyPresetName(preset.name, usedNames);
    }

    let activeIdx = settings.presets.findIndex(preset => preset.name === settings.active_preset);
    if (activeIdx === -1) {
        activeIdx = clampInt(settings.active_preset_idx, 0, settings.presets.length - 1, 0);
    }

    settings.active_preset_idx = activeIdx;
    settings.active_preset = settings.presets[activeIdx]?.name ?? 'Default';
    applyPresetToRuntimeSettings(settings.presets[activeIdx]);

    if (clampInt(settings.prefill_gen_timeout_ms, 500, 120000, 120000) === 12000) {
        settings.prefill_gen_timeout_ms = 120000;
        syncRuntimeSettingsToActivePreset();
    }
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapePrefixLiteral(str) {
    // In practice, models sometimes "double-escape" quotes while inside JSON strings (outputting `\"` as two characters
    // backslash+quote in the decoded value). If we require a raw `"` in the prefix, the grammar can get stuck at the
    // first quote and terminate early. Allow any number of literal backslashes before quotes in *literal* prefix segments.
    return escapeRegExp(str).replace(/"/g, '(?:\\\\)*"');
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    return Math.min(max, Math.max(min, int));
}

function parseStopStrings(raw) {
    const s = String(raw ?? '');
    const lines = s.split(/\r?\n/g).map(x => String(x ?? '').trim()).filter(Boolean);
    return lines;
}

function normalizeStopStrings(...lists) {
    const merged = [];
    const seen = new Set();

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            const value = String(item ?? '').trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            merged.push(value);
        }
    }

    return merged;
}

function detectMatchedStopStringFromCompletionResponse(data, stopStrings) {
    const normalizedStops = normalizeStopStrings(stopStrings);
    if (!normalizedStops.length) {
        return '';
    }

    const explicitStopValues = [
        data?.choices?.[0]?.stop_sequence,
        data?.choices?.[0]?.message?.stop_sequence,
        data?.choices?.[0]?.delta?.stop_sequence,
        data?.choices?.[0]?.matched_stop,
        data?.choices?.[0]?.message?.matched_stop,
        data?.stop_sequence,
        data?.matched_stop,
        data?.completion?.stop_sequence,
    ];

    for (const value of explicitStopValues) {
        if (typeof value === 'string' && normalizedStops.includes(value)) {
            return value;
        }
    }

    // Best-effort fallback for providers that only report a generic stop finish reason.
    if (normalizedStops.length !== 1) {
        return '';
    }

    const stopReasons = [
        data?.choices?.[0]?.finish_reason,
        data?.choices?.[0]?.native_finish_reason,
        data?.choices?.[0]?.stop_reason,
        data?.choices?.[0]?.finishReason,
        data?.finish_reason,
        data?.stop_reason,
        data?.candidateFinishReason,
        data?.candidates?.[0]?.finishReason,
    ]
        .filter(value => typeof value === 'string')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);

    const stopLikeReasons = new Set(['stop', 'stop_sequence', 'stop sequence', 'stop_sequence_reached', 'eos']);
    const nonStopReasons = new Set(['length', 'max_tokens', 'max_output_tokens', 'tool_calls', 'tool_call', 'function_call', 'content_filter', 'safety', 'recitation', 'error', 'end_turn', 'endturn', 'tool_use', 'tool_result']);

    if (stopReasons.some(reason => nonStopReasons.has(reason))) {
        return '';
    }

    return stopReasons.some(reason => stopLikeReasons.has(reason)) ? normalizedStops[0] : '';
}

function appendMatchedStopString(text, stopString) {
    const generatedText = String(text ?? '');
    const matchedStopString = String(stopString ?? '');

    if (!matchedStopString || generatedText.endsWith(matchedStopString)) {
        return generatedText;
    }

    return `${generatedText}${matchedStopString}`;
}

function normalizePrefillGenExtraPromptRole(raw) {
    const role = String(raw ?? 'system').trim().toLowerCase();
    if (role === 'user' || role === 'assistant') return role;
    return 'system';
}

function insertPrefillGenExtraPrompt(messages, prompt, role) {
    const content = String(prompt ?? '');
    const normalizedRole = normalizePrefillGenExtraPromptRole(role);
    const nextMessages = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];

    if (!content.trim()) {
        return { messages: nextMessages, useSysprompt: false };
    }

    if (normalizedRole === 'system') {
        let insertAt = 0;
        while (insertAt < nextMessages.length && nextMessages[insertAt]?.role === 'system') {
            insertAt++;
        }
        nextMessages.splice(insertAt, 0, { role: 'system', content });
        return { messages: nextMessages, useSysprompt: true };
    }

    nextMessages.push({ role: normalizedRole, content });
    return { messages: nextMessages, useSysprompt: false };
}

function getConnectionProfilesSafe() {
    const profiles = extension_settings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

function renderPrefillGenProfileSelect() {
    const select = document.getElementById('structuredprefill_prefill_gen_profile');
    if (!(select instanceof HTMLSelectElement)) return;

    const current = String(extension_settings?.[extensionName]?.prefill_gen_profile_id ?? '');
    const profiles = getConnectionProfilesSafe()
        .filter(p => p && typeof p === 'object')
        .filter(p => String(p.mode ?? '').toLowerCase() === 'cc')
        .slice()
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

    select.innerHTML = '';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '<None>';
    select.appendChild(none);

    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = String(p.id ?? '');
        opt.textContent = String(p.name ?? p.id ?? 'Profile');
        select.appendChild(opt);
    }

    // Best-effort: restore selection.
    select.value = current;
    if (select.value !== current) {
        select.value = '';
    }
}

function templateHasPrefillGenSlot(template) {
    return /\[\[\s*pg\s*\]\]/i.test(String(template ?? ''));
}

function extractPlainTextFromCompletionResponse(data) {
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // Some sources use array-of-parts formats; keep only text-ish parts.
        return content.map(x => (typeof x === 'string' ? x : (x?.text ?? ''))).filter(Boolean).join('');
    }
    return '';
}

async function runPrefillGeneratorOrEmpty({
    generateData,
    tailIndex,
    timeoutMs,
    maxTokens,
    stopStrings,
    profileId,
    extraPrompt,
    extraPromptRole,
    keepMatchedStopString,
}) {
    const profiles = getConnectionProfilesSafe();
    const profile = profiles.find(p => String(p?.id ?? '') === String(profileId ?? '')) ?? null;
    if (!profile) {
        throw new Error('Prefill generator: connection profile not found');
    }
    if (String(profile.mode ?? '').toLowerCase() !== 'cc') {
        throw new Error('Prefill generator: selected profile is not a Chat Completion profile');
    }

    const source = String(profile.api ?? '').trim().toLowerCase();
    const model = String(profile.model ?? '').trim();
    if (!source) {
        throw new Error('Prefill generator: profile has no API (api) value');
    }
    if (!model) {
        throw new Error('Prefill generator: profile has no model value');
    }

    // Full chat context minus the trailing assistant prefill template.
    const baseMessages = Array.isArray(generateData?.messages)
        ? generateData.messages.filter((_, i) => i !== tailIndex).map(m => ({ ...m }))
        : [];

    if (!baseMessages.length) {
        throw new Error('Prefill generator: no messages to generate from');
    }

    // Some routed providers reject assistant-role final messages. Ensure last role is not assistant.
    const last = baseMessages[baseMessages.length - 1];
    if (last?.role === 'assistant') {
        baseMessages[baseMessages.length - 1] = { ...last, role: 'user' };
    }

    const insertedPrompt = insertPrefillGenExtraPrompt(baseMessages, extraPrompt, extraPromptRole);
    const requestMessages = insertedPrompt.messages;
    const normalizedStopStrings = normalizeStopStrings(stopStrings);

    // OpenRouter and direct Claude are the main cases that reject a trailing assistant role here.
    const finalMessage = requestMessages[requestMessages.length - 1];
    if (finalMessage?.role === 'assistant' && (source === 'openrouter' || source === 'claude')) {
        requestMessages[requestMessages.length - 1] = { ...finalMessage, role: 'user' };
    }

    const payload = {
        type: 'quiet',
        messages: requestMessages,
        model: model,
        temperature: 1,
        top_p: 1,
        max_tokens: maxTokens,
        stream: false,
        stop: normalizedStopStrings.length ? normalizedStopStrings : undefined,
        chat_completion_source: source,
        user_name: generateData?.user_name,
        char_name: generateData?.char_name,
        group_names: generateData?.group_names,
        include_reasoning: false,
        enable_web_search: false,
        request_images: false,
    };

    // Custom OpenAI-compatible requires an explicit URL.
    if (source === 'custom') {
        const url = String(profile['api-url'] ?? '').trim();
        if (!url) {
            throw new Error('Prefill generator: custom profile missing api-url');
        }
        payload.custom_url = url;
    }

    if (insertedPrompt.useSysprompt) {
        payload.use_sysprompt = true;
    }

    // Use the profile's saved API key and reverse proxy, like switching to the profile would.
    const secretId = String(profile['secret-id'] ?? '').trim();
    if (secretId) {
        payload.secret_id = secretId;
    }
    const proxyName = String(profile.proxy ?? '').trim();
    if (proxyName) {
        const proxyPreset = (Array.isArray(stOpenAi?.proxies) ? stOpenAi.proxies : []).find(p => p?.name === proxyName);
        if (proxyPreset?.url) {
            payload.reverse_proxy = proxyPreset.url;
            payload.proxy_password = proxyPreset.password ?? '';
        }
    }

    const controller = new AbortController();
    const configuredTimeoutMs = clampInt(timeoutMs, 500, 120000, 120000);
    const timer = setTimeout(() => controller.abort(), configuredTimeoutMs);

    try {
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Prefill generator: backend returned ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
        }

        const data = await res.json();
        if (data?.error) {
            const msg = String(data?.error?.message ?? data?.message ?? 'Unknown error');
            throw new Error(`Prefill generator: ${msg}`);
        }

        let generatedText = extractPlainTextFromCompletionResponse(data);
        if (keepMatchedStopString) {
            const matchedStopString = detectMatchedStopStringFromCompletionResponse(data, normalizedStopStrings);
            generatedText = appendMatchedStopString(generatedText, matchedStopString);
        }

        // Prefill-generator output becomes part of the enforced prefix. Normalize smart punctuation
        // and leaked unicode-escape remnants up front so downstream providers do not echo `u2014`-style junk.
        return sanitizePrefillGeneratorText(generatedText);
    } catch (error) {
        if (error?.name === 'AbortError' && controller.signal.aborted) {
            throw new Error(`Prefill generator timed out after ${configuredTimeoutMs} ms.`);
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}

const JSON_MODE_ONLY_SOURCES = new Set(['ai21', 'deepseek', 'moonshot', 'zai', 'siliconflow']);
const SCHEMA_IGNORED_SOURCES = new Set(['openai_responses', 'minimax']);

function isSillyBunnyHost() {
    return /^SillyBunny/i.test(String(stScript?.CLIENT_VERSION ?? ''));
}

// Mirrors SillyBunny's linkapi-utils: Claude ids use the Anthropic relay, Gemini ids the Google relay.
function getLinkApiFormat(model) {
    const raw = String(model ?? '').trim();
    if (raw.startsWith('[')) return 'openai';
    const id = raw.toLowerCase().replace(/^.*\//, '');
    if (id.includes('claude')) return 'anthropic';
    if (id.includes('gemini')) return 'google';
    return 'openai';
}

/**
 * Whether the backend turns `json_schema` into real regex-enforced structured outputs for this request.
 * Sources that only offer JSON mode, ignore the schema, or emulate it with a forced tool call would
 * silently drop the prefill, so StructuredPrefill stays off there.
 * @returns {{ supported: boolean, reason: string }}
 */
function getStructuredOutputSupport(generateData) {
    const src = String(generateData?.chat_completion_source ?? '').toLowerCase();
    const model = String(generateData?.model ?? '');
    const no = (reason) => ({ supported: false, reason });

    if (!src) return no('No Chat Completion source selected.');
    if (JSON_MODE_ONLY_SOURCES.has(src)) return no('This provider only offers JSON mode, which cannot enforce a prefill.');
    if (SCHEMA_IGNORED_SOURCES.has(src)) return no('This provider ignores structured outputs.');
    if (src === 'cometapi') return no('This provider is disabled.');
    if (src === 'pollinations' && String(generateData?.pollinations_endpoint ?? '') === 'anonymous') {
        return no('Anonymous Pollinations ignores structured outputs.');
    }

    // Direct Claude (and LinkAPI's Claude relay) emulate json_schema with a forced tool call, which does not
    // enforce regex patterns. SillyBunny sends native structured outputs for Claude Fable 5.1 only.
    const viaAnthropic = src === 'claude' || (src === 'linkapi' && getLinkApiFormat(model) === 'anthropic');
    if (viaAnthropic) {
        if (/claude-fable-5-1/.test(model) && isSillyBunnyHost()) return { supported: true, reason: '' };
        return no('Direct Claude only enforces structured outputs for Claude Fable 5.1 in SillyBunny. Use OpenRouter for other Claude models.');
    }

    return { supported: true, reason: '' };
}

function normalizeNewlines(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const STRUCTURED_PREFILL_ASCII_ESCAPE_REPLACEMENTS = Object.freeze({
    '00a0': ' ',
    '00ad': '',
    '2010': '-',
    '2011': '-',
    '2012': '-',
    '2013': '-',
    '2014': '-',
    '2015': '-',
    '2018': '\'',
    '2019': '\'',
    '201a': '\'',
    '201b': '\'',
    '201c': '"',
    '201d': '"',
    '201e': '"',
    '201f': '"',
    '2026': '...',
    '2212': '-',
});

const STRUCTURED_PREFILL_DISPLAY_ESCAPE_REPLACEMENTS = Object.freeze({
    '00a0': ' ',
    '00ad': '',
    '2010': '\u2010',
    '2011': '\u2011',
    '2012': '\u2012',
    '2013': '\u2013',
    '2014': '\u2014',
    '2015': '\u2015',
    '2018': '\'',
    '2019': '\'',
    '201a': '\'',
    '201b': '\'',
    '201c': '"',
    '201d': '"',
    '201e': '"',
    '201f': '"',
    '2026': '\u2026',
    '2212': '\u2212',
});

function replaceCommonUnicodePunctuationWithAscii(text) {
    const input = String(text ?? '');
    let out = '';

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        switch (ch) {
            case '\u00A0': out += ' '; break;
            case '\u00AD': break;
            case '\u2010':
            case '\u2011':
            case '\u2012':
            case '\u2013':
            case '\u2014':
            case '\u2015':
            case '\u2212':
                out += '-';
                break;
            case '\u2018':
            case '\u2019':
            case '\u201A':
            case '\u201B':
                out += '\'';
                break;
            case '\u201C':
            case '\u201D':
            case '\u201E':
            case '\u201F':
                out += '"';
                break;
            case '\u2026':
                out += '...';
                break;
            default:
                out += ch;
                break;
        }
    }

    return out;
}

// Some providers leak smart-punctuation escapes as visible text while streaming, e.g. `u2014` or `\u2019`.
// Repair only a narrow allowlist so normal prose is left alone.
function repairVisibleUnicodeEscapeArtifacts(text, replacements = STRUCTURED_PREFILL_DISPLAY_ESCAPE_REPLACEMENTS) {
    return String(text ?? '').replace(
        /\\*u(00a0|00ad|2010|2011|2012|2013|2014|2015|2018|2019|201a|201b|201c|201d|201e|201f|2026|2212)/gi,
        (match, code) => {
            const replacement = replacements[String(code ?? '').toLowerCase()];
            return typeof replacement === 'string' ? replacement : match;
        },
    );
}

function normalizeStructuredPrefillUnicodeArtifacts(text) {
    return repairVisibleUnicodeEscapeArtifacts(
        replaceCommonUnicodePunctuationWithAscii(text),
        STRUCTURED_PREFILL_ASCII_ESCAPE_REPLACEMENTS,
    );
}

function decodeStructuredPrefillText(text, newlineToken) {
    return repairVisibleUnicodeEscapeArtifacts(straightenCurlyQuotes(decodeNewlines(text, newlineToken)));
}

function sanitizePrefillGeneratorText(text) {
    return normalizeStructuredPrefillUnicodeArtifacts(normalizeNewlines(text));
}

function getOverridePrefillText(settings = extension_settings[extensionName]) {
    if (!settings?.override_prefill_enabled) return '';

    const text = normalizeNewlines(settings.override_prefill_text ?? '');
    return text.length > 0 ? text : '';
}

function prefixHasSlots(prefix) {
    return /\[\[[^\]]+?\]\]/.test(String(prefix ?? ''));
}

function looksLikeStructuredJsonBlob(text) {
    const s = String(text ?? '');
    if (!s.includes('{') || !s.includes('"')) return false;
    // Detect our JSON wrapper even if it appears *after* a Continue base message ("Foo... {\"response\":\"...\"}").
    return /\{\s*"response"\s*:/.test(s);
}

function clearHidePrefillState() {
    runtimeState.hidePrefillLiteral = '';
    runtimeState.hidePrefillRegex = null;
}

function clearContinueState() {
    runtimeState.continue.active = false;
    runtimeState.continue.messageId = -1;
    runtimeState.continue.baseText = '';
    runtimeState.continue.displayBase = '';
    runtimeState.continue.pmStripLiteral = '';
    runtimeState.continue.pmStripRegex = null;
    runtimeState.continue.overlapStripLiteral = '';
    runtimeState.continue.stripLiteral = '';
    runtimeState.continue.stripRegex = null;
}

function getLastAssistantMessageId() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        if (m.is_user) continue;
        if (m.is_system) continue;
        return i;
    }
    return -1;
}

function stripKnownNamePrefix(text) {
    const value = String(text ?? '');
    const names = (runtimeState.knownNames ?? []).slice().sort((a, b) => b.length - a.length);
    for (const name of names) {
        if (name && value.startsWith(name + ': ')) return value.slice(name.length + 2);
    }
    return value;
}

/**
 * True when a trailing assistant message in the outgoing prompt is the last chat message itself
 * (group chats, or generating after an AI reply) rather than a Prompt Manager prefill.
 */
function isTailLastChatMessage(tailContent) {
    const last = chat?.[chat.length - 1];
    if (!last || last.is_user || last.is_system || typeof last.mes !== 'string') return false;

    const squash = (s) => canonicalizeForContinueMatch(s).replace(/\s+/g, ' ').trim();
    const mes = squash(last.mes);
    if (!mes) return false;
    const tail = squash(stripKnownNamePrefix(tailContent));
    // The prompt can wrap the message (reasoning blocks, names, regex scripts), so containment is enough.
    // Short messages need an exact match so a prefill like `<thinking>` isn't mistaken for a reply like "Hi".
    return tail === mes || (mes.length >= 20 && tail.includes(mes));
}

function getActiveAssistantMessageIdForStreaming() {
    const id = runtimeState.continue.active ? runtimeState.continue.messageId : (chat.length - 1);
    if (Number.isInteger(id) && id >= 0 && id < chat.length && !chat[id]?.is_user && !chat[id]?.is_system) return id;
    const last = getLastAssistantMessageId();
    return last >= 0 ? last : (chat.length - 1);
}

function resetStreamGuard() {
    runtimeState.streamGuard.startedAt = Date.now();
    runtimeState.streamGuard.lastRawLen = 0;
    runtimeState.streamGuard.lastDecodedLen = 0;
    runtimeState.streamGuard.lastProgressAt = Date.now();
    runtimeState.streamGuard.suspiciousStreak = 0;
    runtimeState.streamGuard.stopRequested = false;
    runtimeState.lastStreamingMarkdownAt = 0;
    runtimeState.lastStreamingHtml = '';
    runtimeState.lastStreamingHtmlMessageId = -1;
}

function showGuardToast(message) {
    try {
        if (window?.toastr?.error) {
            window.toastr.error(String(message ?? ''), extensionName, { timeOut: 9000, closeButton: true });
            return;
        }
    } catch {
        // ignore
    }
    console.warn(`[${extensionName}] ${String(message ?? '')}`);
}

function tryStopGeneration() {
    // ST renders an "Abort request" button while generating.
    // Triggering its click is the most compatible way for an extension to stop generation.
    try {
        const btn = document.getElementById('mes_stop') || document.querySelector('.mes_stop');
        if (btn instanceof HTMLElement) {
            btn.click();
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

function getDecodedValueForGuard(rawText) {
    // Guard uses the *full* decoded value (before "hide prefill text") so we don't falsely detect "no progress"
    // while the model is still streaming the hidden prefix.
    const decode = (s) => decodeStructuredPrefillText(s, runtimeState.newlineToken);
    try {
        const parsed = JSON.parse(String(rawText ?? ''));
        if (typeof parsed?.response === 'string') return decode(parsed.response);
    } catch {
        // ignore
    }
    const response = tryExtractJsonStringField(String(rawText ?? ''), 'response');
    return typeof response === 'string' ? decode(response) : null;
}

function isSuspiciousPaddingDelta(delta) {
    const s = String(delta ?? '');
    if (s.length < 120) return false;

    // If the model is "stuck" trying to satisfy a regex, it often emits long runs of punctuation, slashes, commas, etc.
    const backslashes = (s.match(/\\/g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    const punct = (s.match(/[\\,.;:!?'"()\[\]{}<>/~`|_-]/g) || []).length;

    const punctRatio = punct / Math.max(1, s.length);
    const slashRatio = backslashes / Math.max(1, s.length);

    if (slashRatio > 0.25) return true;
    if (commas > 80 && punctRatio > 0.45) return true;
    if (punctRatio > 0.60) return true;

    // A long "word" with lots of commas and no spaces is also a common failure mode (word-slot cheating / schema thrash).
    if (!s.includes(' ') && s.length > 260 && /[A-Za-z]/.test(s) && commas > 40) return true;

    // Extremely repetitive single-character runs.
    if (/^(.)\1{250,}$/s.test(s)) return true;
    if (/\\{250,}/.test(s)) return true;

    return false;
}

function maybeAbortOnStreamLoop(rawText, decodedFullText) {
    if (!runtimeState.active) return;
    if (runtimeState.stopping) return;
    if (runtimeState.streamGuard.stopRequested) return;

    const rawLen = String(rawText ?? '').length;
    const decodedLen = String(decodedFullText ?? '').length;
    const now = Date.now();

    const guard = runtimeState.streamGuard;

    // Track progress whenever decoded text actually changes length (best-effort).
    if (decodedLen !== guard.lastDecodedLen) {
        const prevLen = guard.lastDecodedLen;
        guard.lastDecodedLen = decodedLen;
        guard.lastProgressAt = now;

        if (decodedLen > prevLen) {
            const delta = String(decodedFullText ?? '').slice(prevLen);
            if (isSuspiciousPaddingDelta(delta)) {
                guard.suspiciousStreak++;
            } else {
                guard.suspiciousStreak = Math.max(0, guard.suspiciousStreak - 1);
            }
        }
    }

    // Track incoming raw stream length even if decoded text isn't moving.
    if (rawLen > guard.lastRawLen) {
        guard.lastRawLen = rawLen;
    }

    const sinceStart = now - (guard.startedAt || now);
    const sinceProgress = now - (guard.lastProgressAt || now);

    // 1) Hard stall: raw keeps growing but we can't decode any additional visible content for too long.
    // Be conservative to avoid false positives — some models (Opus 4.6 via OpenRouter) can pause
    // for 10+ seconds mid-generation while satisfying structured output constraints.
    if (sinceStart > 5000 && sinceProgress > 15000 && rawLen > 5000) {
        guard.stopRequested = true;
        showGuardToast('Detected stalled/looping structured output (no decode progress). Stopping generation.');
        if (!tryStopGeneration()) {
            showGuardToast('Failed to click Stop button; please stop generation manually.');
        }
        return;
    }

    // 2) Padding loop: repeated suspicious "garbage" deltas (often caused by bad [[re:...]] escaping).
    if (sinceStart > 1500 && guard.suspiciousStreak >= 4 && rawLen > 1500) {
        guard.stopRequested = true;
        showGuardToast('Detected runaway padding while trying to satisfy the schema. Stopping generation.');
        if (!tryStopGeneration()) {
            showGuardToast('Failed to click Stop button; please stop generation manually.');
        }
    }
}

function splitHidePrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { hideTemplate: '', hasKeepMarker: false };

    // When "Hide prefill text" is enabled, users can place `[[keep]]` inside the prefill template.
    // Everything *before* the marker is hidden; everything after stays visible.
    // The marker itself is not meant to be output by the model (it matches empty in the schema regex).
    const markerRe = /\[\[\s*keep\s*\]\]/i;
    const m = markerRe.exec(normalized);
    if (!m) return { hideTemplate: normalized, hasKeepMarker: false };

    return {
        hideTemplate: normalized.slice(0, m.index),
        hasKeepMarker: true,
    };
}

function splitEndPrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { template: '', hasEndMarker: false };

    // When `[[end]]` is present, it acts as a directive to force the model's response to end
    // exactly at that point (no continuation after the template).
    //
    // Everything after the marker is ignored for schema/stripping purposes. This lets users
    // keep comments/notes after `[[end]]` without affecting the enforced output.
    const markerRe = /\[\[\s*(end|stop|eos)\s*\]\]/i;
    const m = markerRe.exec(normalized);
    if (!m) return { template: normalized, hasEndMarker: false };

    return {
        template: normalized.slice(0, m.index),
        hasEndMarker: true,
    };
}

function buildPrefillStripper(prefixTemplate) {
    const { hideTemplate } = splitHidePrefillTemplate(prefixTemplate);
    if (!hideTemplate) return;

    if (!prefixHasSlots(hideTemplate)) {
        runtimeState.hidePrefillLiteral = hideTemplate;
        runtimeState.hidePrefillRegex = null;
        return;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(hideTemplate);
    try {
        runtimeState.hidePrefillRegex = new RegExp(`^((?:${prefixRegex}))`);
    } catch (err) {
        console.warn(`[${extensionName}] Failed to build hide-prefill regex; falling back to literal stripping only.`, err);
        runtimeState.hidePrefillRegex = null;
        runtimeState.hidePrefillLiteral = hideTemplate;
    }
}

function buildContinueStripper(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return;

    // For Continue, we always strip the *entire* structured prefix from the model output delta, then re-prepend the
    // real chat message text from ST (so we keep the message being continued, without duplicating it).
    if (!prefixHasSlots(normalized)) {
        runtimeState.continue.stripLiteral = normalized;
        runtimeState.continue.stripRegex = null;
        return;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(normalized);
    try {
        runtimeState.continue.stripRegex = new RegExp(`^((?:${prefixRegex}))`);
        runtimeState.continue.stripLiteral = '';
    } catch (err) {
        console.warn(`[${extensionName}] Failed to build continue-strip regex; falling back to literal stripping only.`, err);
        runtimeState.continue.stripRegex = null;
        runtimeState.continue.stripLiteral = normalized;
    }
}

function buildContinuePmStripper(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return;

    if (!prefixHasSlots(normalized)) {
        runtimeState.continue.pmStripLiteral = normalized;
        runtimeState.continue.pmStripRegex = null;
        return;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(normalized);
    try {
        runtimeState.continue.pmStripRegex = new RegExp(`^((?:${prefixRegex}))`);
        runtimeState.continue.pmStripLiteral = '';
    } catch (err) {
        console.warn(`[${extensionName}] Failed to build continue-pm-strip regex; falling back to literal stripping only.`, err);
        runtimeState.continue.pmStripRegex = null;
        runtimeState.continue.pmStripLiteral = normalized;
    }
}

function computeContinueOverlapBase(baseText, maxChars = 14) {
    const base = normalizeNewlines(String(baseText ?? ''));
    if (!base) return '';
    const n = clampInt(maxChars, 0, 120, 14);
    if (n <= 0) return '';
    return base.slice(Math.max(0, base.length - n));
}

function buildContinueOverlapStripper(overlapText) {
    const normalized = normalizeNewlines(overlapText);
    if (!normalized) return;

    // Overlap is treated as a literal (no slots).
    runtimeState.continue.overlapStripLiteral = normalized;
}

function stripContinueOverlapPrefix(text) {
    if (!runtimeState.continue.active) return text;
    if (typeof text !== 'string' || text.length === 0) return text;
    const normalized = normalizeNewlines(text);

    const literal = String(runtimeState.continue.overlapStripLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function buildContinueJoinPlaceholder(baseText) {
    // Returns a RAW regex fragment (not a [[...]] slot template).
    // This is appended directly to the prefixRegex after template processing to avoid
    // slot-parser issues with `]` inside character classes (e.g. `[^A-Z]` inside `[[re:...]]`).
    const base = normalizeNewlines(String(baseText ?? ''));
    if (base.length < 2) return '';

    const last = base[base.length - 1];
    const prev = base[base.length - 2];

    const isAsciiLetter = (ch) => /[A-Za-z]/.test(ch);
    const isAsciiUpper = (ch) => /[A-Z]/.test(ch);
    const isAsciiAlphaNum = (ch) => /[A-Za-z0-9]/.test(ch);

    // If the base ends with the *first letter* of a word (e.g. `"Oh, d`), force the next char to be
    // a word-continuation character so the model completes the word instead of inserting punctuation.
    // Allows both cases (lowercase + uppercase) to support ALL-CAPS dialogue / emphasis in roleplay.
    if (isAsciiLetter(last) && /[\s"'""''(\[{<,.;:!?-]/.test(prev)) {
        return "(?:[a-zA-Z\\-\\'])";
    }

    // If base ends with an alnum char (but not clearly mid-word), disallow an immediate uppercase
    // letter as the next char.  The model can still start a new sentence by emitting whitespace first.
    if (isAsciiAlphaNum(last) && isAsciiUpper(last) === false) {
        return '[^A-Z]';
    }

    return '';
}

function stripContinuePmPrefix(text) {
    if (!runtimeState.continue.active) return text;
    if (typeof text !== 'string' || text.length === 0) return text;
    const normalized = normalizeNewlines(text);

    if (runtimeState.continue.pmStripRegex instanceof RegExp) {
        const m = runtimeState.continue.pmStripRegex.exec(normalized);
        if (m && typeof m[1] === 'string') {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.continue.pmStripLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function splitContinuePmPrefixFromTail(tailText, baseText) {
    const tail = normalizeNewlines(String(tailText ?? ''));
    const base = normalizeNewlines(String(baseText ?? ''));
    if (!tail || !base) return { pmPrefix: '', baseFound: false };
    if (tail === base) return { pmPrefix: '', baseFound: true };

    let idx = tail.indexOf(base);
    if (idx >= 0) return { pmPrefix: tail.slice(0, idx), baseFound: true };

    const tailCanon = canonicalizeForContinueMatch(tail);
    const baseCanon = canonicalizeForContinueMatch(base);
    idx = tailCanon.indexOf(baseCanon);
    if (idx >= 0) return { pmPrefix: tail.slice(0, idx), baseFound: true };

    const probeLen = Math.min(120, baseCanon.length);
    if (probeLen >= 40) {
        const probe = baseCanon.slice(0, probeLen);
        idx = tailCanon.indexOf(probe);
        if (idx >= 0) return { pmPrefix: tail.slice(0, idx), baseFound: true };
    }

    return { pmPrefix: '', baseFound: false };
}

function maybeHidePrefillForDisplay(text) {
    const settings = extension_settings[extensionName];
    if (!settings?.hide_prefill_in_display) return text;
    if (typeof text !== 'string' || text.length === 0) return text;

    const normalized = normalizeNewlines(text);

    if (runtimeState.hidePrefillRegex instanceof RegExp) {
        const m = runtimeState.hidePrefillRegex.exec(normalized);
        if (m && typeof m[1] === 'string' && m[1].length > 0) {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.hidePrefillLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function computeDisplayText(messageId, fullText) {
    const settings = extension_settings[extensionName];
    if (!settings?.hide_prefill_in_display) return fullText;
    if (typeof fullText !== 'string' || fullText.length === 0) return fullText;

    // Continue mode:
    // Prefer preserving any existing display-only hidden prefix by appending only the delta.
    // This keeps "Hide prefill text" stable across Continue, without mutating what gets sent as history.
    if (runtimeState.continue.active) {
        const base = String(runtimeState.continue.baseText ?? '');
        if (base && fullText.startsWith(base)) {
            const delta = fullText.slice(base.length);
            const displayBase = runtimeState.continue.displayBase || base;
            return String(displayBase ?? '') + delta;
        }
        // If we can't reliably compute a delta, fall back to showing the full text (never wipe the message).
        return fullText;
    }

    return maybeHidePrefillForDisplay(fullText);
}

function canonicalizeForContinueMatch(text) {
    const input = normalizeNewlines(String(text ?? ''));
    let out = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        switch (ch) {
            case '\u00A0': out += ' '; break; // nbsp
            case '\u201C':
            case '\u201D':
                out += '"';
                break;
            case '\u2018':
            case '\u2019':
                out += '\'';
                break;
            case '\u2010':
            case '\u2011':
            case '\u2012':
            case '\u2013':
            case '\u2014':
                out += '-';
                break;
            default:
                out += ch;
                break;
        }
    }
    return out.toLowerCase();
}

function stripContinuePrefix(text) {
    if (!runtimeState.continue.active) return text;
    if (typeof text !== 'string' || text.length === 0) return text;

    const normalized = normalizeNewlines(text);

    if (runtimeState.continue.stripRegex instanceof RegExp) {
        const m = runtimeState.continue.stripRegex.exec(normalized);
        if (m && typeof m[1] === 'string') {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.continue.stripLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    // Fallback for providers that don't strictly enforce the prefix regex (so we can't regex-strip reliably):
    // try to locate the end of the *existing* message text within the decoded value and strip up to it.
    const base = String(runtimeState.continue.baseText ?? '');
    if (base) {
        const baseCanon = canonicalizeForContinueMatch(base);
        const textCanon = canonicalizeForContinueMatch(normalized);

        // If the decoded value starts with the base message (modulo canonicalization), strip by length.
        // This avoids "doubling" when providers don't strictly enforce the schema prefix.
        if (baseCanon.length >= 40 && textCanon.startsWith(baseCanon)) {
            return normalized.slice(baseCanon.length);
        }

        const tryTailLen = (tailLen) => {
            const len = Math.min(tailLen, baseCanon.length, textCanon.length);
            if (len < 20) return null;
            const needle = baseCanon.slice(baseCanon.length - len);
            const expected = Math.max(0, baseCanon.length - len);

            let bestPos = -1;
            let bestScore = Number.POSITIVE_INFINITY;
            let start = 0;
            while (true) {
                const pos = textCanon.indexOf(needle, start);
                if (pos === -1) break;
                const score = Math.abs(pos - expected);
                if (score < bestScore) {
                    bestScore = score;
                    bestPos = pos;
                    // Good enough; don't scan forever.
                    if (bestScore === 0) break;
                }
                start = pos + 1;
            }

            if (bestPos >= 0) {
                const cut = bestPos + len;
                if (cut >= 0 && cut <= normalized.length) return normalized.slice(cut);
            }

            return null;
        };

        // Prefer longer overlaps, but fall back progressively.
        const maxLen = Math.min(520, baseCanon.length, textCanon.length);
        for (let len = maxLen; len >= 40; len -= 20) {
            const candidate = tryTailLen(len);
            if (typeof candidate === 'string') return candidate;
        }

    }

    return normalized;
}

function chooseNewlineToken(prefix, preferredToken) {
    let token = String(preferredToken ?? '').trim();
    if (!token || /[\r\n]/.test(token)) token = '<NL>';

    const normalized = normalizeNewlines(prefix);
    if (!normalized.includes(token)) return token;

    // Find an alternative token that doesn't appear in the prefix.
    for (let i = 2; i <= 25; i++) {
        const candidate = `<NL${i}>`;
        if (!normalized.includes(candidate)) return candidate;
    }

    // Worst-case fallback: a rarely-used unicode symbol.
    const unicodeFallback = '␤';
    if (!normalized.includes(unicodeFallback)) return unicodeFallback;

    // If *everything* is present, keep the preferred token and accept ambiguity.
    return token;
}

function encodeNewlines(text, newlineToken) {
    const token = String(newlineToken ?? '');
    if (!token) return String(text ?? '');
    return normalizeNewlines(text).replace(/\n/g, token);
}

function decodeNewlines(text, newlineToken) {
    const token = String(newlineToken ?? '');
    if (!token) return String(text ?? '');
    return String(text ?? '').split(token).join('\n');
}

function sanitizeUserRegex(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return '';
    if (/[\r\n]/.test(s)) return '';

    // Allow /pattern/flags (we ignore flags because JSON-schema patterns don't support them).
    if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
        const lastSlash = s.lastIndexOf('/');
        if (lastSlash > 0) {
            const inner = s.slice(1, lastSlash);
            // If it looks like /.../flags, accept the inner.
            if (inner) s = inner;
        }
    }

    // Remove anchors; we embed this into a larger ^prefix...$ pattern.
    s = s.replace(/^\^+/, '').replace(/\$+$/, '');
    return s.trim();
}

function parseOptionsList(raw) {
    const parts = String(raw ?? '')
        .split(/[|,]/g)
        .map(x => x.trim())
        .filter(Boolean);
    return Array.from(new Set(parts)).slice(0, 50);
}

function anyCharIncludingNewlineExpr() {
    // Avoid `[\s\S]` because some providers (notably Anthropic via OpenRouter) reject `\S` in schema patterns.
    // `(?:.|\n)` is a widely-supported equivalent for "any char including newline" without using `\S`.
    return '(?:.|\\n)';
}

function escapeRegexSourceForAsciiPattern(source) {
    const value = String(source ?? '');
    let out = '';

    for (let i = 0; i < value.length; i++) {
        const codeUnit = value.charCodeAt(i);
        if (codeUnit <= 0x7F) {
            out += value[i];
            continue;
        }

        // Escape UTF-16 code units so astral characters stay intact as surrogate pairs.
        out += `\\u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
    }

    return out;
}

function getPatternModeForRequest(source, modelId) {
    const src = String(source ?? '').toLowerCase();
    const model = String(modelId ?? '').toLowerCase();

    // Direct Anthropic/Claude provider implementations tend to have stricter schema-regex support than OpenAI.
    // Use the conservative pattern set to avoid rejected patterns like `\\S` and some `{n,m}` quantifiers.
    if (src === 'claude' || src === 'anthropic') {
        return 'anthropic';
    }

    // OpenRouter routes to many providers. When the routed provider is Anthropic, their schema-regex
    // implementation is stricter than OpenAI's and rejects several patterns we use (notably `\S` and
    // some `{n,m}` range quantifiers). Use a more conservative pattern set.
    if (src === 'openrouter' && (model.startsWith('anthropic/') || model.includes('claude'))) {
        return 'anthropic';
    }

    // OpenAI-compatible providers (proxies, etc.) routing to Anthropic/Claude models have the same
    // strict regex limitations. Detect by model name.
    if (model.includes('claude') || model.includes('anthropic')) {
        return 'anthropic';
    }

    return 'default';
}

// <anti-slop> Shared by index.js and proxy/src/structured-prefill-core.js; keep both copies identical (a proxy test checks).
// ASCII letters and digits count as "inside a word" for anti-slop matching. Every other character is
// treated as a word boundary, which can only block more, never less, and keeps the schema pattern small.
const ANTI_SLOP_WORD_RANGES = [[0x30, 0x39], [0x41, 0x5A], [0x61, 0x7A]];
const ANTI_SLOP_MAX_PATTERN_CHARS = 30000;
// Above this size, drop the "reply may end mid-word" tail (it repeats the whole word tree) and
// require replies to end on a non-word character instead (punctuation, space, newline, quote...).
const ANTI_SLOP_TAIL_BUDGET_CHARS = 4000;

function isAntiSlopWordChar(ch) {
    const code = String(ch).charCodeAt(0);
    return ANTI_SLOP_WORD_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/**
 * Build the continuation regex (everything after the enforced prefix) for the anti-slop ban list.
 *
 * Matching rules (case-insensitive):
 * - An entry that starts with a letter/digit is blocked wherever a word starts with it:
 *   banning `gaze` blocks "gaze", "Gazed", "gazelle", but not "stargaze".
 * - An entry that starts with anything else (`—`, `...`, `*`) is blocked everywhere.
 * - Entries spanning the end of the prefix and the start of the reply are blocked too.
 *
 * The rules are compiled into a DFA, which is turned into a regex by state elimination around the
 * "between words" state R:  continuation = START CYCLE{n,} TAIL
 * - START: from the state the prefix leaves us in back to R (empty when the prefix ends in R),
 * - CYCLE: one trip R -> ... -> R (roughly one word plus its trailing separator),
 * - TAIL:  an optional unfinished trip, so the reply may end anywhere. Dropped for large lists (see
 *          ANTI_SLOP_TAIL_BUDGET_CHARS), in which case the reply must end on a non-word character.
 * `minChars` is approximate here: one CYCLE is counted as about six characters (rounded down).
 *
 * @param {string} banListStr Newline-separated banned words/phrases.
 * @param {{ minChars?: number, patternMode?: string, prefixText?: string }} [opts]
 * @returns {{ pattern: string|null, error: string }} `pattern` is null when there is nothing to ban or on error.
 */
function buildAntiSlopContinuation(banListStr, opts = {}) {
    const entries = [];
    const seen = new Set();
    for (const line of String(banListStr ?? '').split(/\r?\n/)) {
        const entry = line.trim();
        if (!entry) continue;
        if (/[\uD800-\uDFFF]/.test(entry)) {
            return { pattern: null, error: `"${entry}" contains characters (like emoji) that anti-slop cannot ban.` };
        }
        const key = [...entry].map(ch => foldChar(ch)).join('');
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(key);
    }
    if (entries.length === 0) return { pattern: null, error: '' };

    function foldChar(ch) {
        const lower = ch.toLowerCase();
        return lower.length === 1 ? lower : ch;
    }
    const variantsOf = (key) => {
        const out = new Set([key]);
        for (const v of [key.toLowerCase(), key.toUpperCase()]) {
            if (v.length === 1 && foldChar(v) === key) out.add(v);
        }
        return [...out];
    };

    // --- Trie of entries ----------------------------------------------------------------------
    const children = [new Map()];
    const terminal = [false];
    for (const entry of entries) {
        let node = 0;
        for (const ch of entry) {
            let next = children[node].get(ch);
            if (next === undefined) {
                next = children.length;
                children.push(new Map());
                terminal.push(false);
                children[node].set(ch, next);
            }
            node = next;
        }
        terminal[node] = true;
    }

    // Input symbols: each explicit character (case-folded), plus "any other word char" / "any other char".
    const alphabet = [...new Set(entries.flatMap(e => [...e]))].sort();
    const OTHER_WORD = '\u0000word';
    const OTHER_NONWORD = '\u0000nonword';
    const symbols = [...alphabet, OTHER_WORD, OTHER_NONWORD];
    const symbolIsWord = (sym) => (sym === OTHER_WORD ? true : sym === OTHER_NONWORD ? false : isAntiSlopWordChar(sym));

    // --- DFA by subset construction ----------------------------------------------------------
    // State = active partial matches (trie nodes) + whether the previous char was a word char.
    const stateKey = (nodes, prevWord) => `${prevWord ? 'w' : 'n'}:${nodes.join(',')}`;
    const states = [];
    const stateIndex = new Map();
    const DEAD = -1;
    const addState = (nodes, prevWord) => {
        const key = stateKey(nodes, prevWord);
        if (!stateIndex.has(key)) {
            stateIndex.set(key, states.length);
            states.push({ nodes, prevWord, next: new Map() });
        }
        return stateIndex.get(key);
    };
    const step = (state, sym) => {
        const nextNodes = new Set();
        for (const node of state.nodes) {
            const child = children[node].get(sym);
            if (child !== undefined) nextNodes.add(child);
        }
        const isWord = symbolIsWord(sym);
        const rootChild = children[0].get(sym);
        // Letter-initial entries may only start at a word start; others may start anywhere.
        if (rootChild !== undefined && (!isWord || !state.prevWord)) nextNodes.add(rootChild);
        for (const node of nextNodes) if (terminal[node]) return DEAD;
        return addState([...nextNodes].sort((a, b) => a - b), isWord);
    };

    let computed = 0;
    const closeStates = () => {
        for (; computed < states.length; computed++) {
            for (const sym of symbols) states[computed].next.set(sym, step(states[computed], sym));
            if (states.length > 5000) return false;
        }
        return true;
    };

    const ROOT = addState([], false);
    if (!closeStates()) return { pattern: null, error: 'The ban list is too large to compile.' };

    // State the enforced prefix leaves us in, so entries can't be split across the boundary.
    let startState = ROOT;
    for (const raw of String(opts.prefixText ?? '')) {
        const ch = foldChar(raw);
        const sym = alphabet.includes(ch) ? ch : (isAntiSlopWordChar(raw) ? OTHER_WORD : OTHER_NONWORD);
        const next = states[startState].next.get(sym);
        // If the prefix itself contains a banned entry (it is user-written), just continue from a boundary.
        startState = next === DEAD ? addState([], symbolIsWord(sym)) : next;
        if (!closeStates()) return { pattern: null, error: 'The ban list is too large to compile.' };
    }

    // --- Regex helpers (null = matches nothing, '' = empty string) -------------------------
    const info = new Map();
    const make = (src, { atom = false, alt = false, opt = false } = {}) => {
        if (!info.has(src)) info.set(src, { atom, alt, opt });
        return src;
    };
    const isAtom = (r) => info.get(r)?.atom === true;
    const hasAlt = (r) => info.get(r)?.alt === true;
    const group = (r) => (isAtom(r) ? r : make(`(?:${r})`, { atom: true }));
    const union = (a, b) => {
        if (a === null) return b;
        if (b === null || a === b) return a;
        if (a === '' && b === '') return '';
        if (a === '') return info.get(b)?.opt ? b : make(`${group(b)}?`, { opt: true });
        if (b === '') return info.get(a)?.opt ? a : make(`${group(a)}?`, { opt: true });
        return make(`${a}|${b}`, { alt: true });
    };
    const concat = (...parts) => {
        if (parts.some(p => p === null)) return null;
        const kept = parts.filter(p => p !== '');
        if (kept.length === 0) return '';
        if (kept.length === 1) return kept[0];
        return make(kept.map(p => (hasAlt(p) ? group(p) : p)).join(''));
    };
    const star = (r) => (r === null || r === '' ? '' : make(`${group(r)}*`, { opt: true }));

    const escClassChar = (code) => {
        const ch = String.fromCharCode(code);
        return /[\]\\^-]/.test(ch) ? `\\${ch}` : ch;
    };
    const rangesToClassBody = (ranges) => ranges
        .map(([lo, hi]) => (lo === hi ? escClassChar(lo) : hi === lo + 1 ? `${escClassChar(lo)}${escClassChar(hi)}` : `${escClassChar(lo)}-${escClassChar(hi)}`))
        .join('');
    const subtractCodes = (ranges, codes) => {
        let out = ranges.map(r => r.slice());
        for (const code of [...codes].sort((a, b) => a - b)) {
            const next = [];
            for (const [lo, hi] of out) {
                if (code < lo || code > hi) { next.push([lo, hi]); continue; }
                if (lo <= code - 1) next.push([lo, code - 1]);
                if (code + 1 <= hi) next.push([code + 1, hi]);
            }
            out = next;
        }
        return out;
    };
    const codesOf = (keys) => keys.flatMap(variantsOf).map(ch => ch.charCodeAt(0));
    const codeRanges = (codes) => [...new Set(codes)].sort((a, b) => a - b).map(c => [c, c]);

    // Regex for one edge label: a set of symbols that all lead to the same target state.
    const labelFor = (syms) => {
        const set = new Set(syms);
        const explicitIn = alphabet.filter(ch => set.has(ch));
        const explicitOut = alphabet.filter(ch => !set.has(ch));
        const parts = [];
        if (set.has(OTHER_NONWORD)) {
            // Everything except: word chars not in this label, and explicit chars not in this label.
            // Word chars outside the label are already covered by the word ranges when those are excluded.
            const excludedWord = set.has(OTHER_WORD) ? [] : ANTI_SLOP_WORD_RANGES;
            const excludedExplicit = set.has(OTHER_WORD) ? explicitOut : explicitOut.filter(ch => !isAntiSlopWordChar(ch));
            const body = rangesToClassBody(excludedWord) + rangesToClassBody(codeRanges(codesOf(excludedExplicit)));
            parts.push(make(body ? `[^${body}]` : '(?:.|\\n)', { atom: true }));
            if (!set.has(OTHER_WORD)) {
                const wordIn = explicitIn.filter(isAntiSlopWordChar);
                if (wordIn.length) parts.push(make(`[${rangesToClassBody(codeRanges(codesOf(wordIn)))}]`, { atom: true }));
            }
        } else {
            let ranges = [];
            if (set.has(OTHER_WORD)) ranges = subtractCodes(ANTI_SLOP_WORD_RANGES, codesOf(explicitOut));
            const extra = set.has(OTHER_WORD) ? explicitIn.filter(ch => !isAntiSlopWordChar(ch)) : explicitIn;
            ranges = ranges.concat(codeRanges(codesOf(extra)));
            if (ranges.length === 1 && ranges[0][0] === ranges[0][1]) {
                parts.push(make(String.fromCharCode(ranges[0][0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), { atom: true }));
            } else if (ranges.length) {
                parts.push(make(`[${rangesToClassBody(ranges)}]`, { atom: true }));
            }
        }
        return parts.reduce((acc, p) => union(acc, p), null);
    };

    // --- Generalised NFA: R is split into an entry and an exit node ---------------------------
    const ROOT_OUT = 'ro';
    const ROOT_IN = 'ri';
    const END = 'end';
    const START = 'start';
    const edges = new Map();
    let tooLarge = false;
    const addEdge = (from, to, regex) => {
        if (regex === null) return;
        if (!edges.has(from)) edges.set(from, new Map());
        const row = edges.get(from);
        const merged = row.has(to) ? union(row.get(to), regex) : regex;
        if (merged.length > ANTI_SLOP_MAX_PATTERN_CHARS) tooLarge = true;
        row.set(to, merged);
    };
    const edge = (from, to) => edges.get(from)?.get(to) ?? null;

    // BFS distance of every state reachable from R or from the prefix state (drives elimination order).
    const distance = new Map();
    for (const origin of [ROOT, startState]) {
        if (distance.has(origin)) continue;
        distance.set(origin, origin === ROOT ? 0 : 1);
        const bfs = [origin];
        while (bfs.length) {
            const s = bfs.shift();
            for (const t of states[s].next.values()) {
                if (t !== DEAD && !distance.has(t)) { distance.set(t, distance.get(s) + 1); bfs.push(t); }
            }
        }
    }

    const nodeId = (s, asSource) => (s === ROOT ? (asSource ? ROOT_OUT : ROOT_IN) : s);
    // "Inside an unbanned word" (M). Its boundary transitions are shared by most states, so they live on a
    // separate node BOUNDARY that those states reach by an empty step: `(other letters)* boundary` then
    // appears once per state instead of being spelled out twice.
    const insideWord = stateIndex.get(stateKey([], true));
    const BOUNDARY = 'boundary';
    const nonwordSymbols = symbols.filter(sym => !symbolIsWord(sym));
    const sharesBoundary = (s) => insideWord !== undefined && distance.has(insideWord)
        && nonwordSymbols.every(sym => states[s].next.get(sym) === states[insideWord].next.get(sym));
    for (const s of distance.keys()) {
        const viaBoundary = sharesBoundary(s);
        const byTarget = new Map();
        for (const [sym, t] of states[s].next) {
            if (t === DEAD) continue;
            if (viaBoundary && !symbolIsWord(sym)) continue;
            if (!byTarget.has(t)) byTarget.set(t, []);
            byTarget.get(t).push(sym);
        }
        for (const [t, syms] of byTarget) addEdge(nodeId(s, true), nodeId(t, false), labelFor(syms));
        if (viaBoundary) addEdge(nodeId(s, true), BOUNDARY, '');
        if (s !== ROOT && s !== insideWord) addEdge(s, END, '');
    }
    if (insideWord !== undefined && distance.has(insideWord)) {
        const byTarget = new Map();
        for (const sym of nonwordSymbols) {
            const t = states[insideWord].next.get(sym);
            if (t === DEAD) continue;
            if (!byTarget.has(t)) byTarget.set(t, []);
            byTarget.get(t).push(sym);
        }
        for (const [t, syms] of byTarget) addEdge(BOUNDARY, nodeId(t, false), labelFor(syms));
        addEdge(BOUNDARY, END, '');
    }
    if (startState !== ROOT) addEdge(START, startState, '');

    // Elimination order: the inside-word state first, then states farthest from R, and the shared boundary
    // last, so each trie path ends up nested under its shared prefix and boundary handling appears once.
    const order = [];
    if (insideWord !== undefined && distance.has(insideWord)) order.push(insideWord);
    for (const st of [...distance.keys()].sort((a, b) => distance.get(b) - distance.get(a))) {
        if (st !== ROOT && st !== insideWord) order.push(st);
    }
    if (edges.has(BOUNDARY)) order.push(BOUNDARY);
    for (const k of order) {
        if (tooLarge) break;
        const loop = star(edge(k, k));
        const outgoing = [...(edges.get(k) ?? new Map()).keys()].filter(to => to !== k);
        for (const [from, row] of edges) {
            if (from === k || !row.has(k)) continue;
            const inRegex = row.get(k);
            row.delete(k);
            for (const to of outgoing) addEdge(from, to, concat(inRegex, loop, edge(k, to)));
        }
        edges.delete(k);
    }
    if (tooLarge) return { pattern: null, error: 'The ban list is too large for a schema pattern; remove some entries.' };

    const cycle = edge(ROOT_OUT, ROOT_IN);
    const tail = union('', edge(ROOT_OUT, END));
    const start = startState === ROOT ? '' : edge(START, ROOT_IN);
    if (cycle === null) return { pattern: null, error: 'The ban list blocks every possible reply.' };
    if (start === null) return { pattern: null, error: 'Could not continue safely from the prefill.' };

    const patternMode = String(opts.patternMode ?? 'default');
    // One cycle is roughly a word plus its separator, so convert the character minimum to cycles
    // (rounded down, so a tiny minimum such as Continue's 1 doesn't demand a word boundary).
    const minCycles = Math.max(0, Math.floor(Math.trunc(Number(opts.minChars) || 0) / 6));
    let repeated;
    if (patternMode === 'anthropic' || minCycles === 0) {
        // Anthropic rejects large `{n,}` ranges; just require some output.
        repeated = start || minCycles === 0 ? star(cycle) : `${group(cycle)}+`;
    } else {
        repeated = `${group(cycle)}{${minCycles},}`;
    }
    const startPart = hasAlt(start) ? group(start) : start;
    const tailPart = hasAlt(tail) ? group(tail) : tail;
    let pattern = `${startPart}${repeated}${tailPart}`;
    if (pattern.length > ANTI_SLOP_TAIL_BUDGET_CHARS && minCycles > 0) {
        pattern = `${startPart}${repeated}`;
    }
    // Without a minimum, a reply may also end before ever reaching a word boundary.
    const startEnd = startState === ROOT ? null : edge(START, END);
    if (startEnd !== null && (patternMode === 'anthropic' || minCycles === 0)) {
        pattern = `(?:${pattern}|${startEnd})`;
    }
    if (pattern.length > ANTI_SLOP_MAX_PATTERN_CHARS) {
        return { pattern: null, error: `The ban list needs a ${pattern.length}-character pattern (limit ${ANTI_SLOP_MAX_PATTERN_CHARS}); remove some entries, especially multi-word phrases.` };
    }

    try {
        new RegExp(pattern);
    } catch (err) {
        return { pattern: null, error: `Anti-slop pattern failed validation: ${err?.message ?? err}` };
    }
    return { pattern, error: '' };
}
// </anti-slop>

function splitHintSuffix(placeholderBody) {
    const body = String(placeholderBody ?? '');
    const idx = body.toLowerCase().lastIndexOf('|hint:');
    if (idx === -1) return { spec: body.trim(), hint: '' };
    return {
        spec: body.slice(0, idx).trim(),
        hint: body.slice(idx + 6).trim(),
    };
}

function curlyQuoteLiteralsOutsideSlots(template) {
    const s = String(template ?? '');
    const slotRe = /\[\[[^\]]+?\]\]/g;
    let out = '';
    let last = 0;
    let m;
    let open = true;

    const transformLiteral = (lit) => String(lit).replace(/"/g, () => (open ? (open = false, '“') : (open = true, '”')));

    while ((m = slotRe.exec(s)) !== null) {
        out += transformLiteral(s.slice(last, m.index));
        out += m[0];
        last = m.index + m[0].length;
    }
    out += transformLiteral(s.slice(last));
    return out;
}

function buildWordCountPatternNoRanges(minWords, maxWords, { wordToken, wordSep }) {
    const min = clampInt(minWords, 1, 2000, 1);
    const max = clampInt(maxWords, 1, 2000, min);
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);

    // Construct an explicit sequence without `{n,m}` ranges.
    // After a cap, allow extra words via `*` (no range quantifier).
    const cap = 40;
    const cappedHi = Math.min(hi, cap);

    let out = '';
    for (let i = 0; i < lo; i++) {
        out += (i === 0) ? wordToken : `${wordSep}${wordToken}`;
    }
    for (let i = lo; i < cappedHi; i++) {
        out += `(?:${wordSep}${wordToken})?`;
    }
    if (hi > cap) {
        out += `(?:${wordSep}${wordToken})*`;
    }
    return out;
}

function buildPlaceholderRegex(placeholderBody) {
    const { spec: body } = splitHintSuffix(placeholderBody);
    const escapeForCharClass = (ch) => String(ch).replace(/[-\\\]^]/g, '\\$&');
    const newlineTok = String(runtimeState.newlineToken ?? '');
    const newlineTokSingle = newlineTok.length === 1 ? escapeForCharClass(newlineTok) : '';
    // IMPORTANT:
    // - Disallow `<` / `>` inside "word" tokens so the model can't smuggle our newline token (default "<NL>") into slots.
    // - If the newline token is a single character (e.g. "␤"), also disallow that character inside "word" tokens.
    const wordTokenCore = newlineTokSingle ? `[^\\s,<>${newlineTokSingle}]+` : `[^\\s,<>]+`;
    const wordToken = `${wordTokenCore}[,\\.!\\?;:'"\\)\\]\\}~-]*`;
    const wordSep = `[\\t ]+`;
    if (!body) return wordToken;

    const lower = body.toLowerCase();

    // [[w:2]] or [[words:2]] or [[w:2-5]]
    let m = /^(w|words)\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(lower);
    if (m) {
        const a = clampInt(m[2], 1, 2000, 1);
        const b = m[3] != null ? clampInt(m[3], 1, 2000, a) : a;
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        // IMPORTANT:
        // - Only count "words" separated by spaces/tabs (not newlines), so one slot can't span multiple lines.
        // - Disallow commas inside tokens, so models can't pack many words into a single "word" via comma-joining.
        if (runtimeState.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(min, max, { wordToken, wordSep });
        }

        const minTail = Math.max(0, min - 1);
        const maxTail = Math.max(0, max - 1);
        return `${wordToken}(?:${wordSep}${wordToken}){${minTail},${maxTail}}`;
    }

    // [[opt:yes|no]] / [[options:...]]
    m = /^(opt|options)\s*:\s*(.+?)\s*$/.exec(body);
    if (m) {
        const options = parseOptionsList(m[2]);
        if (options.length > 0) return `(?:${options.map(escapeRegExp).join('|')})`;
        return wordToken;
    }

    // [[re:...]] / [[regex:...]]
    m = /^(re|regex)\s*:\s*(.+?)\s*$/.exec(body);
    if (m) {
        const userRegex = sanitizeUserRegex(m[2]);
        if (userRegex) {
            // Anthropic/OpenRouter rejects some regex features (notably `\S` and some range quantifiers).
            // If the user-provided regex looks risky, fall back to a permissive wildcard.
            if (runtimeState.patternMode === 'anthropic' && (/[{}]/.test(userRegex) || /\\S/.test(userRegex))) {
                return `${anyCharIncludingNewlineExpr()}*`;
            }
            return `(?:${userRegex})`;
        }
        return `${anyCharIncludingNewlineExpr()}*`;
    }

    // [[free]]: allow any non-empty chunk, but prefer minimal match to allow following literals to match.
    if (/^free\s*$/i.test(body)) {
        return `${anyCharIncludingNewlineExpr()}+`;
    }

    // [[keep]]: display-only marker used with "Hide prefill text".
    // It is not output by the model; it matches empty in the prefix template.
    if (/^keep\s*$/i.test(body)) {
        return '(?:)';
    }

    // [[end]] / [[stop]] / [[eos]]: directive marker (not output) used to force the response to end
    // at this point when building the schema pattern. Here it matches empty in the prefix template.
    if (/^(end|stop|eos)\s*$/i.test(body)) {
        return '(?:)';
    }

    // [[emotion]] / [[mood]]: common RP emotion word.
    if (/^(emotion|mood)\s*$/i.test(body)) {
        const emotions = [
            'happy', 'sad', 'angry', 'nervous', 'excited', 'scared', 'confused',
            'amused', 'annoyed', 'anxious', 'bored', 'calm', 'curious', 'desperate',
            'disgusted', 'embarrassed', 'frustrated', 'grateful', 'guilty', 'hopeful',
            'hurt', 'jealous', 'lonely', 'nostalgic', 'panicked', 'playful', 'proud',
            'relieved', 'shy', 'smug', 'surprised', 'suspicious', 'tender', 'terrified',
            'thoughtful', 'tired', 'uncomfortable', 'worried', 'flustered', 'melancholic',
            'determined', 'fearful', 'content', 'bitter', 'affectionate', 'giddy',
            'resigned', 'defiant', 'wistful', 'somber',
        ];
        return `(?:${emotions.join('|')})`;
    }

    // [[line]] or [[lines:2-4]]: full line(s) of text (no embedded newlines per line).
    // Each line matches `.+` (at least one char, no newlines). Multiple lines are separated by newline tokens.
    m = /^(line|lines)\s*(?::\s*(\d+)(?:\s*-\s*(\d+))?)?\s*$/i.exec(body);
    if (m) {
        const lineExpr = '.+';
        const nlExpr = newlineTok ? `(?:${escapeRegExp(newlineTok)}|\\n)` : '\\n';
        if (!m[2]) {
            // [[line]]: exactly one line
            return lineExpr;
        }
        const a = clampInt(m[2], 1, 50, 1);
        const b = m[3] != null ? clampInt(m[3], 1, 50, a) : a;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (runtimeState.patternMode === 'anthropic') {
            // Anthropic doesn't support range quantifiers — unroll lines
            let out = lineExpr; // first line always present
            for (let i = 1; i < lo; i++) {
                out += `${nlExpr}${lineExpr}`;
            }
            for (let i = lo; i < hi; i++) {
                out += `(?:${nlExpr}${lineExpr})?`;
            }
            return out;
        }
        if (lo === hi) {
            const tailCount = lo - 1;
            return tailCount === 0 ? lineExpr : `${lineExpr}(?:${nlExpr}${lineExpr}){${tailCount}}`;
        }
        return `${lineExpr}(?:${nlExpr}${lineExpr}){${lo - 1},${hi - 1}}`;
    }

    // [[name]]: matches any character name in the current chat (user, char, group members).
    // Names are collected at generation time and stored in runtimeState.knownNames.
    if (/^name\s*$/i.test(body)) {
        const names = (runtimeState.knownNames ?? []).filter(n => n.length > 0);
        if (names.length > 0) {
            return `(?:${names.map(escapeRegExp).join('|')})`;
        }
        // Fallback: capitalized word(s) like a typical name
        if (runtimeState.patternMode === 'anthropic') {
            return `[A-Z][a-z]+(?:[\\t ]+[A-Z][a-z]+)?`;
        }
        return `[A-Z][a-z]+(?:[\\t ]+[A-Z][a-z]+){0,2}`;
    }

    // [[action]]: short narration phrase, 1-6 words, no dialogue quotes.
    // Good for `*[[action]]*` style RP actions.
    if (/^action\s*$/i.test(body)) {
        const actionWord = newlineTokSingle ? `[^\\s"<>${newlineTokSingle}]+` : `[^\\s"<>]+`;
        const sep = `[\\t ]+`;
        if (runtimeState.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(1, 6, { wordToken: actionWord, wordSep: sep });
        }
        return `${actionWord}(?:${sep}${actionWord}){0,5}`;
    }

    // [[thought]]: inner monologue phrase, 1-10 words, no dialogue quotes.
    if (/^thought\s*$/i.test(body)) {
        const thoughtWord = newlineTokSingle ? `[^\\s"<>${newlineTokSingle}]+` : `[^\\s"<>]+`;
        const sep = `[\\t ]+`;
        if (runtimeState.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(1, 10, { wordToken: thoughtWord, wordSep: sep });
        }
        return `${thoughtWord}(?:${sep}${thoughtWord}){0,9}`;
    }

    // [[num]] or [[number:1-100]]: numeric value. Optionally constrained to a range.
    m = /^(num|number)\s*(?::\s*(-?\d+)\s*-\s*(-?\d+))?\s*$/i.exec(body);
    if (m) {
        if (!m[2]) {
            // [[num]]: any integer (with optional negative sign)
            return `-?[0-9]+`;
        }
        const lo = parseInt(m[2], 10);
        const hi = parseInt(m[3], 10);
        const minVal = Math.min(lo, hi);
        const maxVal = Math.max(lo, hi);
        // For small ranges (≤30 values), enumerate them for strict constraint
        if (maxVal - minVal <= 30) {
            const vals = [];
            for (let v = minVal; v <= maxVal; v++) vals.push(String(v));
            return `(?:${vals.join('|')})`;
        }
        // For larger ranges, constrain by digit count
        const minDigits = String(Math.abs(minVal)).length;
        const maxDigits = String(Math.abs(maxVal)).length;
        const prefix = minVal < 0 ? '-?' : '';
        if (runtimeState.patternMode === 'anthropic') {
            // Unroll digit counts since Anthropic doesn't support {n,m}
            const alts = [];
            for (let d = minDigits; d <= maxDigits; d++) {
                alts.push(`[0-9]${'[0-9]'.repeat(d - 1)}`);
            }
            return `${prefix}(?:${alts.join('|')})`;
        }
        return `${prefix}[0-9]{${minDigits},${maxDigits}}`;
    }

    // Unknown placeholder: default to a single non-space token.
    return wordToken;
}

function buildPrefixRegexFromWireTemplate(wireTemplate) {
    const template = String(wireTemplate ?? '');
    const slotRe = /\[\[(.+?)\]\]/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = slotRe.exec(template)) !== null) {
        out += escapePrefixLiteral(template.slice(last, m.index));
        out += buildPlaceholderRegex(m[1]);
        last = m.index + m[0].length;
    }
    out += escapePrefixLiteral(template.slice(last));
    return out;
}

// Text after the last `[[...]]` slot: the part of the prefix whose exact characters are known.
function getLiteralTailAfterSlots(prefix) {
    const text = normalizeNewlines(prefix);
    const slotRe = /\[\[[^\]]+?\]\]/g;
    let tailStart = 0;
    let m;
    while ((m = slotRe.exec(text)) !== null) tailStart = m.index + m[0].length;
    return text.slice(tailStart);
}

let lastAntiSlopWarning = '';
function warnAntiSlopOnce(message) {
    console.warn(`[${extensionName}] Anti-slop disabled for this request: ${message}`);
    if (message === lastAntiSlopWarning) return;
    lastAntiSlopWarning = message;
    toastr.warning(`Anti-slop is off for this reply: ${message}`, extensionName, { timeOut: 9000, closeButton: true });
}

function buildJsonSchemaForPrefillValuePattern(prefix, minCharsAfterPrefix, joinSuffixRegex = '', opts = {}) {
    const mustEndAfterTemplate = !!opts?.mustEndAfterTemplate;
    const minChars = mustEndAfterTemplate ? 0 : clampInt(minCharsAfterPrefix, 1, 10000, 1);
    const newlineToken = runtimeState.newlineToken || '<NL>';
    const wirePrefix = encodeNewlines(prefix, newlineToken);

    // NOTE: This is a JSON-schema regex pattern string. It must NOT contain literal newlines when using strict structured outputs.
    // We encode any prefill newlines as a token (e.g. "<NL>") and later decode for display.
    // Enforce:
    // - starts with wirePrefix
    // - continuation (after prefix) has at least `minChars` characters (or ends right after the template for [[end]])
    // - continuation never contains an anti-slop entry
    let prefixRegex = buildPrefixRegexFromWireTemplate(wirePrefix);

    // Robust newline handling:
    // Some models/providers will emit real newlines in the parsed JSON string instead of the chosen newline token.
    // If we require `<NL>` literally, the model can get stuck trying to satisfy the schema. Allow either.
    if (newlineToken) {
        const escapedToken = escapeRegExp(newlineToken);
        // Replace literal occurrences of the encoded token in the prefix regex with an alternation.
        // NOTE: This is a string replace on the regex *source*.
        prefixRegex = prefixRegex.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
    }

    // Anthropic's structured-output regex validator only accepts ASCII patterns and rejects
    // shorthand character classes like `\s`, `\S`. Escape non-ASCII code units as `\uXXXX`
    // so the pattern stays ASCII without weakening the enforced prefill.
    if (runtimeState.patternMode === 'anthropic') {
        prefixRegex = escapeRegexSourceForAsciiPattern(prefixRegex);
    }

    // Anti-slop: the continuation must never spell a banned entry, including across the prefix boundary.
    let antiSlopExpr = null;
    if (!mustEndAfterTemplate) {
        const antiSlop = buildAntiSlopContinuation(extension_settings[extensionName]?.anti_slop_ban_list, {
            minChars,
            patternMode: runtimeState.patternMode,
            prefixText: getLiteralTailAfterSlots(prefix),
        });
        if (antiSlop.error) warnAntiSlopOnce(antiSlop.error);
        antiSlopExpr = antiSlop.pattern;
        if (antiSlopExpr && runtimeState.patternMode === 'anthropic') {
            antiSlopExpr = escapeRegexSourceForAsciiPattern(antiSlopExpr);
        }
    }

    // Append raw join-suffix regex (e.g. `[^A-Z]`) for Continue flows.
    // This is injected directly (not via [[re:...]] slot syntax) to avoid slot-parser issues
    // with `]` inside character classes. Skipped with anti-slop: the anti-slop automaton must see
    // every character after the prefix, or a banned word could be split around the joined char.
    if (joinSuffixRegex && !antiSlopExpr) {
        prefixRegex += joinSuffixRegex;
    }

    // Avoid lookaheads for broader provider compatibility.
    // Anthropic rejects large `{n,}` ranges, so there we only require at least one character after the prefix.
    const anyChar = anyCharIncludingNewlineExpr();
    const buildPattern = (prefixSource) => {
        if (mustEndAfterTemplate) {
            // Allow a small amount of trailing whitespace/newlines for robustness (models sometimes emit a final newline).
            // IMPORTANT: avoid `\s` for Anthropic compatibility; keep ASCII.
            let trailing = `[\\t \\r\\n]*`;
            // Some providers emit the newline token literally instead of real `\n`.
            // Anthropic rejects non-ASCII patterns, so only include literal token if ASCII.
            if (newlineToken && /^[\x00-\x7F]*$/.test(String(newlineToken))) {
                const escapedToken = escapeRegExp(newlineToken);
                trailing = `[\\t ]*(?:${escapedToken}|\\n)?(?:[\\t ]*(?:${escapedToken}|\\n)[\\t ]*)*`;
            }
            return `^(?:${prefixSource})${trailing}$`;
        }
        if (antiSlopExpr) return `^(?:${prefixSource})${antiSlopExpr}$`;
        // Do NOT force a non-whitespace character at a specific position after the prefix: that can deadlock
        // on "newline-y" continuations. Length-only is enough; the stream guard catches padding loops.
        if (runtimeState.patternMode === 'anthropic') return `^(?:${prefixSource})${anyChar}+$`;
        return `^(?:${prefixSource})${anyChar}{${minChars},}$`;
    };

    let pattern = buildPattern(prefixRegex);
    // Best-effort local validation so a bad [[re:...]] slot doesn't brick generation:
    // fall back to enforcing the prefill text literally (slots included as plain text).
    try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
    } catch (err) {
        console.warn(`[${extensionName}] Invalid injected regex pattern; enforcing the prefill literally instead.`, err);
        let literal = escapePrefixLiteral(wirePrefix);
        if (newlineToken) {
            const escapedToken = escapeRegExp(newlineToken);
            literal = literal.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
        }
        if (runtimeState.patternMode === 'anthropic') literal = escapeRegexSourceForAsciiPattern(literal);
        pattern = buildPattern(literal);
    }

    return {
        name: 'response',
        description: '',
        strict: true,
        value: {
            type: 'object',
            properties: {
                response: {
                    type: 'string',
                    description: '',
                    pattern: pattern,
                },
            },
            required: ['response'],
            additionalProperties: false,
        },
    };
}

function tryExtractJsonStringField(rawText, fieldName) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;

    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    // Find `"field": "`
    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    let index = match.index + match[0].length;
    let out = '';
    let isEscaped = false;
    let unicodeRemaining = 0;
    let unicodeBuffer = '';

    for (let i = index; i < rawText.length; i++) {
        const ch = rawText[i];

        if (unicodeRemaining > 0) {
            unicodeBuffer += ch;
            unicodeRemaining--;
            if (unicodeRemaining === 0) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeBuffer)) {
                    out += String.fromCharCode(parseInt(unicodeBuffer, 16));
                }
                unicodeBuffer = '';
            }
            continue;
        }

        if (isEscaped) {
            isEscaped = false;
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                    unicodeRemaining = 4;
                    unicodeBuffer = '';
                    break;
                default:
                    out += ch;
                    break;
            }
            continue;
        }

        if (ch === '\\') {
            isEscaped = true;
            continue;
        }

        if (ch === '"') {
            // End of JSON string
            break;
        }

        out += ch;
    }

    return out.length > 0 ? out : '';
}

// Best-effort JSON-string extractor that tolerates models/providers that emit invalid JSON
// (most commonly: forgetting to escape `"` inside the string, or prematurely closing the string
// and then continuing to emit content).
//
// Strategy:
// - Parse escape sequences like a normal JSON string (`\\n`, `\\\"`, `\\uXXXX`, etc.).
// - Treat an unescaped `"` as the *end* of the string only if the next non-whitespace
//   character is `}` or `,` (i.e., it looks like a real JSON terminator).
// - Otherwise, keep the quote as a literal character and continue scanning.
function tryExtractJsonStringFieldLoose(rawText, fieldName) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;

    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    const findNextNonWhitespace = (from) => {
        for (let i = from; i < rawText.length; i++) {
            const ch = rawText[i];
            if (!/[\s\r\n\t]/.test(ch)) return ch;
        }
        return '';
    };

    let index = match.index + match[0].length;
    let out = '';
    let isEscaped = false;
    let unicodeRemaining = 0;
    let unicodeBuffer = '';

    for (let i = index; i < rawText.length; i++) {
        const ch = rawText[i];

        if (unicodeRemaining > 0) {
            unicodeBuffer += ch;
            unicodeRemaining--;
            if (unicodeRemaining === 0) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeBuffer)) {
                    out += String.fromCharCode(parseInt(unicodeBuffer, 16));
                }
                unicodeBuffer = '';
            }
            continue;
        }

        if (isEscaped) {
            isEscaped = false;
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                    unicodeRemaining = 4;
                    unicodeBuffer = '';
                    break;
                default:
                    out += ch;
                    break;
            }
            continue;
        }

        if (ch === '\\') {
            isEscaped = true;
            continue;
        }

        if (ch === '"') {
            const next = findNextNonWhitespace(i + 1);
            if (next === '}' || next === ',') {
                break;
            }
            // The quote isn't followed by '}' or ',' so it's not a real JSON terminator.
            // Include it in the output — it's almost certainly content (e.g. dialogue) that
            // the model/provider failed to escape as \".
            out += '"';
            continue;
        }

        out += ch;
    }

    return out.length > 0 ? out : '';
}

/**
 * Convert curly ("smart") quotes back to straight ASCII quotes.
 *
 * `curlyQuoteLiteralsOutsideSlots` intentionally converts straight `"` to `\u201C`/`\u201D`
 * in the prefill template so the model's JSON output doesn't break on unescaped quotes.
 * Once JSON extraction is done, we straighten them back so the chat shows normal quotes.
 */
function straightenCurlyQuotes(s) {
    return String(s ?? '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
}

function tryUnwrapStructuredOutput(text) {
    if (typeof text !== 'string' || text.length === 0) return null;

    const decode = (s) => decodeStructuredPrefillText(s, runtimeState.newlineToken);
    const applyContinueJoin = (decodedValue) => {
        // Continue can carry prompt-manager prefills that should not be re-added to the message.
        // Strip those first, then perform the normal "append to base" join.
        const s = stripContinuePmPrefix(String(decodedValue ?? ''));
        if (!runtimeState.continue.active) return s;
        const base = String(runtimeState.continue.baseText ?? '');
        if (!base) return s;

        // Preferred: strip a small overlap prefix (model echoes the end of the base for a cleaner join).
        const afterOverlap = stripContinueOverlapPrefix(s);
        if (afterOverlap !== s) return base + afterOverlap;

        // Next: strip a whole-base prefix (provider echoed the entire base).
        const delta = stripContinuePrefix(s);
        if (delta !== s) return base + delta;

        // If stripping failed but the model already returned the full message (base + continuation),
        // do NOT prepend `base` again (that causes doubled output).
        const baseCanon = canonicalizeForContinueMatch(base);
        const textCanon = canonicalizeForContinueMatch(s);
        const probe = Math.min(120, baseCanon.length, textCanon.length);
        // If the extracted value is just a partial prefix of the base, keep the base unchanged for now.
        if (s.length < base.length && probe >= 20 && baseCanon.startsWith(textCanon.slice(0, probe))) {
            return base;
        }
        // IMPORTANT:
        // During streaming we may temporarily extract only a *prefix* of the base text. If we treat that as a "full"
        // return, we can wipe the already-rendered continued message and make it look like it "disappeared".
        // Only accept "already full" when the extracted text is at least as long as the base.
        if (s.length >= base.length && probe >= 40 && textCanon.startsWith(baseCanon.slice(0, probe))) {
            return s;
        }

        return base + s;
    };

    const finish = (value) => {
        const decoded = decode(value);
        return runtimeState.continue.active ? applyContinueJoin(decoded) : decoded;
    };

    try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.response === 'string') return finish(parsed.response);
    } catch {
        // JSON.parse failed. Some providers/models still *mostly* follow the schema but emit invalid JSON,
        // commonly due to unescaped quotes inside the structured string field (causing early termination).
        // Use a tolerant extractor first; fall back to strict (partial) extraction below.
        const looseResponse = tryExtractJsonStringFieldLoose(text, 'response');
        if (typeof looseResponse === 'string') return finish(looseResponse);
    }

    // Partial extraction (useful during early streaming).
    const response = tryExtractJsonStringField(text, 'response');
    return typeof response === 'string' ? finish(response) : null;
}

function applyTextToMessage(messageId, newText, { forceRerender = false } = {}) {
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    const message = chat[messageId];
    if (!message || message.is_user) return;
    if (typeof newText !== 'string') return;

    // If the user swiped/reverted during generation, do not apply decoded text to the wrong swipe.
    if (runtimeState.trackedSwipeId !== -1 && typeof message.swipe_id === 'number' && message.swipe_id !== runtimeState.trackedSwipeId) {
        console.debug(`[${extensionName}] Skipping applyTextToMessage for message ${messageId} due to swipe_id mismatch (${runtimeState.trackedSwipeId} != ${message.swipe_id})`);
        return;
    }

    // Don't replace meaningful content with empty strings (e.g., on early abort)
    if (newText.trim().length === 0 && message.mes && message.mes.trim().length > 0) {
        console.debug(`[${extensionName}] Skipping empty text application to message ${messageId} (has existing content)`);
        return;
    }
    if (!forceRerender && message.mes === newText) return;

    // Apply user regex scripts (global + preset) to the decoded AI output.
    // ST's own cleanUpMessage runs regex on the raw API response, which is JSON when structured
    // output is active. We overwrite message.mes with the decoded text, so we need to apply
    // regex ourselves. This mirrors ST's behaviour: full regex runs once at the final save,
    // while messageFormatting() handles display-only (markdownOnly) scripts during streaming.
    const regexedText = getRegexedString(newText, regex_placement.AI_OUTPUT, {
        characterOverride: message.name,
        isMarkdown: false,
        isPrompt: false,
        isEdit: false,
        depth: 0,
    });
    const textAfterRegex = typeof regexedText === 'string' && regexedText.length > 0 ? regexedText : newText;

    const displayText = computeDisplayText(messageId, textAfterRegex);

    message.extra ??= {};

    // When hide-prefill is active and the display text differs from the full text,
    // store the *stripped* version in message.mes so the prefill doesn't enter the AI's
    // context on subsequent generations. This happens once, when the reply is applied; later user
    // edits are left alone so text that merely starts like the prefill is never deleted.
    const settings = extension_settings[extensionName];
    const prefillWasStripped = settings?.hide_prefill_in_display && displayText !== textAfterRegex;
    // If an early-aborted response only contains the prefix, stripping would make it look like the message vanished.
    // In that case, keep the full decoded text visible instead of replacing it with empty.
    const mesText = (prefillWasStripped && displayText.trim().length === 0) ? textAfterRegex : (prefillWasStripped ? displayText : textAfterRegex);

    message.mes = mesText;
    if (displayText !== mesText) {
        message.extra.display_text = displayText;
    } else if (Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes)) {
        message.swipes[message.swipe_id] = mesText;
    }

    updateMessageBlock(messageId, message, { rerenderMessage: true });
}

function hasUnclosedCodeFence(text) {
    const s = String(text ?? '');
    const backtick = (s.match(/```/g) || []).length;
    const tilde = (s.match(/~~~/g) || []).length;
    return (backtick % 2 === 1) || (tilde % 2 === 1);
}

function sanitizeUnclosedCodeFencesForPreview(text) {
    // Some models emit an opening fence like ```json{ mid-stream and never close it until later.
    // While the fence is unclosed, ST's markdown pipeline can become very expensive and/or error-prone.
    //
    // We do NOT want to append visible junk like "~~~" at the end.
    // Instead, for *preview rendering only*, break the last unmatched fence marker with a zero-width char
    // so it won't be treated as an active fence by downstream markdown logic.
    const s = String(text ?? '');

    const breakLast = (input, marker, brokenMarker) => {
        const idx = input.lastIndexOf(marker);
        if (idx === -1) return input;
        return input.slice(0, idx) + brokenMarker + input.slice(idx + marker.length);
    };

    const backtick = (s.match(/```/g) || []).length;
    const tilde = (s.match(/~~~/g) || []).length;

    let out = s;
    if (backtick % 2 === 1) out = breakLast(out, '```', '`\u200B``');
    if (tilde % 2 === 1) out = breakLast(out, '~~~', '~\u200B~~');
    return out;
}

function getStreamingMarkdownIntervalMs(displayText) {
    const text = String(displayText ?? '');
    if (text.length >= STREAM_MARKDOWN_HUGE_CHARS) {
        return STREAM_MARKDOWN_HUGE_INTERVAL_MS;
    }
    if (text.length >= STREAM_MARKDOWN_LARGE_CHARS) {
        return STREAM_MARKDOWN_LARGE_INTERVAL_MS;
    }
    return STREAM_MARKDOWN_FAST_INTERVAL_MS;
}

function shouldUseEmergencyPlainTextStreamingPreview(displayText) {
    const text = String(displayText ?? '');
    if (!text) return false;

    if (text.length >= STREAM_PLAIN_TEXT_EMERGENCY_CHARS) {
        return true;
    }

    if (text.length >= STREAM_UNCLOSED_FENCE_PLAIN_TEXT_THRESHOLD && hasUnclosedCodeFence(text)) {
        return true;
    }

    return false;
}

function shouldDeferStreamingMarkdownRender(displayText) {
    const now = typeof performance?.now === 'function' ? performance.now() : Date.now();
    const sinceLastMarkdown = now - (runtimeState.lastStreamingMarkdownAt || 0);
    return sinceLastMarkdown < getStreamingMarkdownIntervalMs(displayText);
}

function applyTextToMessageStreaming(messageId, newText) {
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    const message = chat[messageId];
    if (!message || message.is_user) return;
    if (typeof newText !== 'string') return;

    // Lock onto the swipe we're generating into as soon as we can.
    if (runtimeState.trackedSwipeId === -1 && typeof message.swipe_id === 'number') {
        runtimeState.trackedSwipeId = message.swipe_id;
    }
    // If the swipe changed (user swipe/revert), do not overwrite a different swipe's content.
    if (runtimeState.trackedSwipeId !== -1 && typeof message.swipe_id === 'number' && message.swipe_id !== runtimeState.trackedSwipeId) {
        return;
    }

    // Don't replace meaningful content with empty strings (e.g., on very early abort)
    if (newText.trim().length === 0 && typeof message.mes === 'string' && message.mes.trim().length > 0) {
        return;
    }

    ensureScrollLockListeners();

    const displayText = computeDisplayText(messageId, newText);

    // Keep the backing data decoded even during streaming so edit/cancel doesn't resurrect raw JSON.
    message.mes = newText;
    message.extra ??= {};
    if (displayText !== newText) {
        message.extra.display_text = displayText;
    } else if (Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
        message.swipes[message.swipe_id] = newText;
    }

    // Replace whatever ST just rendered (raw JSON) before the next paint, but keep markdown formatting.
    const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (textEl instanceof HTMLElement) {
        runtimeState.applyingDom++;
        try {
            const useEmergencyPlainPreview = shouldUseEmergencyPlainTextStreamingPreview(displayText);
            const reuseFormattedPreview = !useEmergencyPlainPreview
                && shouldDeferStreamingMarkdownRender(displayText)
                && runtimeState.lastStreamingHtmlMessageId === messageId
                && typeof runtimeState.lastStreamingHtml === 'string'
                && runtimeState.lastStreamingHtml.length > 0;

            if (useEmergencyPlainPreview) {
                // Catastrophic-safety path only. The final render still goes through ST's normal markdown
                // pipeline when the message is finalized.
                textEl.style.whiteSpace = 'pre-wrap';
                textEl.textContent = displayText;
            } else if (reuseFormattedPreview) {
                // Keep the last fully formatted native-ST preview visible until enough time has passed to
                // justify re-running the markdown/regex pipeline on the whole accumulated message.
                textEl.style.whiteSpace = '';
                if (textEl.innerHTML !== runtimeState.lastStreamingHtml) {
                    textEl.innerHTML = runtimeState.lastStreamingHtml;
                }
            } else {
                // For the streaming chunks we do format, sanitize unmatched code fences so partially
                // emitted fences do not explode the markdown parser mid-stream.
                const previewText = hasUnclosedCodeFence(displayText) ? sanitizeUnclosedCodeFencesForPreview(displayText) : displayText;
                textEl.style.whiteSpace = '';
                runtimeState.lastStreamingMarkdownAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
                const formatted = messageFormatting(
                    previewText,
                    message?.name ?? '',
                    !!message?.is_system,
                    !!message?.is_user,
                    messageId,
                    {},
                    false,
                );
                runtimeState.lastStreamingHtml = formatted;
                runtimeState.lastStreamingHtmlMessageId = messageId;
                textEl.innerHTML = formatted;
            }
        } catch (err) {
            console.warn(`[${extensionName}] Streaming render failed; falling back to plain text.`, err);
            textEl.style.whiteSpace = 'pre-wrap';
            textEl.textContent = displayText;
        } finally {
            runtimeState.applyingDom = Math.max(0, runtimeState.applyingDom - 1);
        }
        schedulePostFrameGuard(messageId);

        // Keep autoscroll working during our custom streaming renderer.
        // ST can sometimes lock autoscroll due to incidental scroll shifts when the DOM height changes.
        // We only force-scroll if the user hasn’t intentionally scrolled up.
        if (!runtimeState.userScrollLocked) {
            scrollChatToBottom({ waitForFrame: true });
        }
    }
}

function disconnectStreamObserver() {
    try {
        runtimeState.streamObserver?.disconnect?.();
    } catch {
        // ignore
    }
    runtimeState.streamObserver = null;
    runtimeState.observedMessageId = -1;
    runtimeState.renderQueued = false;
}

function clearStopCleanupTimer() {
    if (runtimeState.stopCleanupTimer) {
        clearTimeout(runtimeState.stopCleanupTimer);
        runtimeState.stopCleanupTimer = null;
    }
}

function getRawCandidateForMessage(messageId) {
    const mes = chat?.[messageId]?.mes;
    if (typeof mes === 'string' && mes.includes('"response"')) return mes;
    const latest = String(runtimeState.latestStreamText ?? '');
    if (latest.trimStart().startsWith('{')) return latest;
    return mes || latest || '';
}

function scheduleDecodedRender(messageId) {
    if (!runtimeState.active) return;
    if (runtimeState.renderQueued) return;
    runtimeState.renderQueued = true;

    requestAnimationFrame(() => {
        runtimeState.renderQueued = false;
        // Ensure we're still looking at the same message.
        if (!runtimeState.active) return;
        if (messageId !== runtimeState.observedMessageId) return;

        const raw = getRawCandidateForMessage(messageId);
        const rawStr = String(raw ?? '');
        let unwrapped = tryUnwrapStructuredOutput(rawStr);
        if (typeof unwrapped !== 'string') {
            // If we can’t extract yet (very early tokens), never show raw JSON.
            const trimmed = rawStr.trimStart();
            if (trimmed.startsWith('{')) {
                unwrapped = typeof runtimeState.lastAppliedText === 'string' ? runtimeState.lastAppliedText : '';
            } else {
                return;
            }
        }
        // Loop/guard detection uses the full decoded value (before display-only hide-prefill).
        const guardDecoded = getDecodedValueForGuard(rawStr);
        if (typeof guardDecoded === 'string') {
            maybeAbortOnStreamLoop(rawStr, guardDecoded);
        }
        const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        const domText = textEl instanceof HTMLElement ? String(textEl.textContent ?? '') : '';
        const domContainsStructuredJson = looksLikeStructuredJsonBlob(domText);
        // If ST just overwrote the DOM with raw JSON, we need to re-apply even if the decoded text didn’t change.
        if (unwrapped === runtimeState.lastAppliedText && !domContainsStructuredJson) return;
        runtimeState.lastAppliedText = unwrapped;
        applyTextToMessageStreaming(messageId, unwrapped);
    });
}

function ensureStreamObserver(messageId) {
    if (!runtimeState.active) return false;
    if (runtimeState.streamObserver && runtimeState.observedMessageId === messageId) return true;

    disconnectStreamObserver();

    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mesEl) return false;

    runtimeState.observedMessageId = messageId;
    runtimeState.streamObserver = new MutationObserver(() => {
        // Ignore only the mutations we cause ourselves, but still catch any late ST overwrites.
        if (runtimeState.applyingDom > 0) return;
        scheduleDecodedRender(messageId);
        // If the user hit Stop, keep decoding until the DOM goes quiet (prevents “JSON popping back”).
        if (runtimeState.stopping) touchStopCleanup(messageId, runtimeState.stopSessionAt);
    });
    // Observe the whole message node so we survive `.mes_text` being replaced.
    runtimeState.streamObserver.observe(mesEl, { childList: true, subtree: true, characterData: true });
    return true;
}

function touchStopCleanup(messageId, sessionAtStop) {
    if (!runtimeState.stopping) return;
    if (runtimeState.stopSessionAt !== sessionAtStop) return;

    clearStopCleanupTimer();
    runtimeState.stopCleanupTimer = setTimeout(() => {
        // If a new generation started, don't interfere.
        if (!runtimeState.active) return;
        if (runtimeState.stopSessionAt !== sessionAtStop) return;

        // Validate message still exists and hasn't been deleted/reverted
        const message = chat?.[messageId];
        if (!message || message.is_user) {
            console.debug(`[${extensionName}] Stop cleanup: message ${messageId} no longer valid, skipping`);
            runtimeState.active = false;
            runtimeState.stopping = false;
            runtimeState.trackedSwipeId = -1;
            disconnectStreamObserver();
            clearStopCleanupTimer();
            clearHidePrefillState();
            clearContinueState();
            resetStreamGuard();
            return;
        }

        // If swipe_id has changed (user swiped or ST reverted), don't apply to wrong swipe
        if (runtimeState.trackedSwipeId !== -1 && message.swipe_id !== runtimeState.trackedSwipeId) {
            console.debug(`[${extensionName}] Stop cleanup: swipe_id changed (${runtimeState.trackedSwipeId} → ${message.swipe_id}), skipping`);
            runtimeState.active = false;
            runtimeState.stopping = false;
            runtimeState.trackedSwipeId = -1;
            disconnectStreamObserver();
            clearStopCleanupTimer();
            clearHidePrefillState();
            clearContinueState();
            resetStreamGuard();
            return;
        }

        // Final best-effort render so markdown etc. is correct in the saved message.
        const raw = getRawCandidateForMessage(messageId);
        const unwrapped = tryUnwrapStructuredOutput(String(raw));

        // Only apply if we have meaningful content (prevent applying empty strings on early abort)
        const textToApply = typeof unwrapped === 'string' ? unwrapped : runtimeState.lastAppliedText;
        if (typeof textToApply === 'string' && textToApply.trim().length > 0) {
            runtimeState.lastAppliedText = textToApply;
            applyTextToMessage(messageId, textToApply, { forceRerender: true });
        } else {
            console.debug(`[${extensionName}] Stop cleanup: no valid text to apply, skipping render`);
        }

        // Some backends keep streaming briefly after Stop, and ST can repaint raw JSON after we've unwrapped.
        // A short post-stop watchdog re-renders the block if that happens.
        schedulePostStopDomFix(messageId, sessionAtStop);

        runtimeState.active = false;
        runtimeState.stopping = false;
        runtimeState.trackedSwipeId = -1;
        disconnectStreamObserver();
        clearStopCleanupTimer();
        clearHidePrefillState();
        clearContinueState();
        resetStreamGuard();
    }, 900);
}

async function onChatCompletionSettingsReady(generateData) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!generateData || typeof generateData !== 'object' || !Array.isArray(generateData.messages)) return;

    clearPostStopDomFixTimer();

    // Any edits to the request (removed prefill, pushed override, relabelled roles) are rolled back
    // unless a schema actually gets injected, so a bail-out never leaves a half-modified request.
    const originalMessages = generateData.messages.map(m => ({ ...m }));
    const hadAssistantPrefill = Object.prototype.hasOwnProperty.call(generateData, 'assistant_prefill');
    const originalAssistantPrefill = generateData.assistant_prefill;
    let injected = false;
    try {
        injected = await injectStructuredPrefill(generateData, settings);
    } catch (err) {
        console.error(`[${extensionName}] Failed to apply structured prefill; sending the request unchanged.`, err);
        reportPrefill('not applied, an error occurred (see browser console).');
    }
    if (!injected) {
        generateData.messages.length = 0;
        generateData.messages.push(...originalMessages);
        if (hadAssistantPrefill) generateData.assistant_prefill = originalAssistantPrefill;
    }
}

/**
 * Rewrites `generateData` to enforce the prefill through `json_schema`.
 * @returns {Promise<boolean>} true when a schema was injected.
 */
async function injectStructuredPrefill(generateData, settings) {
    const support = getStructuredOutputSupport(generateData);
    if (!support.supported) return false;
    if (generateData.json_schema) {
        reportPrefill('not applied, the request already has a JSON schema.');
        return false;
    }
    // Avoid conflicts with tool-calling in early testing; can be revisited later.
    if (Array.isArray(generateData.tools) && generateData.tools.length > 0) {
        reportPrefill('not applied, the request uses tool calling.');
        return false;
    }

    const requestType = String(generateData.type ?? '').toLowerCase();

    // Impersonate and quiet (e.g. summarization) don't produce chat messages — they write to
    // the input textarea or return text silently. Injecting structured output would break them:
    // the model returns `{"response":"..."}` JSON that ST can't use, and the stream observer would
    // incorrectly overwrite the last assistant message.
    if (requestType === 'impersonate' || requestType === 'quiet') return false;

    const isContinue = requestType === 'continue';

    const messages = generateData.messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    const src = String(generateData.chat_completion_source ?? '').toLowerCase();
    const modelId = String(generateData.model ?? '');
    runtimeState.patternMode = getPatternModeForRequest(src, modelId);

    // Collect known character names for the [[name]] placeholder.
    {
        const names = new Set();
        const userName = String(generateData.user_name ?? '').trim();
        const charName = String(generateData.char_name ?? '').trim();
        if (userName) names.add(userName);
        if (charName) names.add(charName);
        const groupNames = generateData.group_names;
        if (Array.isArray(groupNames)) {
            for (const gn of groupNames) {
                const n = String(gn ?? '').trim();
                if (n) names.add(n);
            }
        }
        runtimeState.knownNames = [...names];
    }

    // OpenRouter is OpenAI-compatible. Some routed providers/models may ignore or partially enforce `json_schema`.
    // We still attempt injection for any OpenRouter model and let it be a no-op if the backend doesn't enforce it.

    const overridePrefillText = getOverridePrefillText(settings);

    // We usually activate when the chat "tail" is an assistant message (prefill-like).
    // For Continue, ST commonly appends a trailing system instruction, so we look at the last *non-system* message.
    // If this preset defines an override prefill, we can synthesize/replace that tail for normal generations.
    let tailIndex = messages.length - 1;
    while (tailIndex >= 0 && messages[tailIndex]?.role === 'system') tailIndex--;
    let tail = tailIndex >= 0 ? messages[tailIndex] : null;

    // In group chats (or when generating with an empty input after an AI reply), the trailing assistant
    // message is real chat history, not a prefill. Never turn it into an enforced prefix.
    const tailIsChatHistory = !isContinue && requestType !== 'swipe' && tail?.role === 'assistant' && isTailLastChatMessage(tail.content);

    // Claude-style sources send "Start Claude's answer with" as `assistant_prefill` instead of a message.
    // Enforce it like a Prompt Manager prefill and drop the field (models that reject prefill would fail on it).
    const assistantPrefillField = typeof generateData.assistant_prefill === 'string' ? generateData.assistant_prefill : '';
    if (assistantPrefillField) delete generateData.assistant_prefill;

    const historyTail = tailIsChatHistory ? tail : null;
    const hasPromptPrefill = tail?.role === 'assistant' && !tailIsChatHistory;
    const replacementPrefill = isContinue ? '' : (overridePrefillText || (hasPromptPrefill ? '' : assistantPrefillField));
    const prefillSource = overridePrefillText
        ? 'the Prefill box'
        : (hasPromptPrefill ? "your chat preset's last assistant prompt" : '"Start Claude\'s answer with"');
    if (replacementPrefill) {
        if (hasPromptPrefill) {
            tail.content = replacementPrefill;
        } else {
            tail = { role: 'assistant', content: replacementPrefill };
            messages.push(tail);
            tailIndex = messages.length - 1;
        }
    } else if (tailIsChatHistory) {
        reportPrefill('no prefill. The last message is the previous AI reply (chat history), so nothing was forced.');
        return false;
    }

    if (!tail || tail.role !== 'assistant' || typeof tail.content !== 'string') {
        reportPrefill(isContinue
            ? 'Continue not applied, no AI message to continue.'
            : `no prefill detected. The last prompt is ${tail?.role ?? 'missing'}-role; a preset prefill must be an assistant-role prompt placed last.`);
        return false;
    }
    let tailContent = tail.content;
    if (!tailContent) {
        reportPrefill('no prefill detected. The trailing assistant prompt is empty.');
        return false;
    }

    // When ST's "Character Names Behavior" is set to "Message Content", all message contents
    // in the messages array get "CharName: " prepended (openai.js setOpenAIMessages).
    // Strip it: baseText (from chat[].mes) never has the prefix, so leaving it causes mismatches
    // in Continue logic and leaks the name into the schema pattern.
    {
        const stripped = stripKnownNamePrefix(tailContent);
        if (stripped !== tailContent) {
            tailContent = stripped;
            tail.content = tailContent;
        }
    }

    resetStreamGuard();
    clearHidePrefillState();
    clearContinueState();
    runtimeState.prefillCheckRegex = null;

    // Reset per-generation targeting so we don't apply to an unrelated swipe.
    runtimeState.trackedSwipeId = -1;

    // Build schema + state differently for Continue vs normal generations.
    // - Normal: remove assistant prefill and enforce it via schema.
    // - Continue: keep (or replace) the tail assistant message so the model can see the message to continue,
    //            and only constrain the *output wrapper* (we append to the existing message locally).
    let schemaPrefix = '';
    let joinSuffixRegex = '';
    let mustEndAfterTemplate = false;
    let prefillTemplate = String(tailContent ?? '');

    if (isContinue) {
        runtimeState.continue.active = true;
        runtimeState.continue.messageId = getLastAssistantMessageId();
        runtimeState.continue.baseText = (runtimeState.continue.messageId >= 0 && typeof chat?.[runtimeState.continue.messageId]?.mes === 'string')
            ? chat[runtimeState.continue.messageId].mes
            : '';
        runtimeState.continue.displayBase = '';
        if (runtimeState.continue.messageId >= 0) {
            const m = chat?.[runtimeState.continue.messageId];
            if (m?.extra && typeof m.extra.display_text === 'string') {
                runtimeState.continue.displayBase = m.extra.display_text;
            }
        }
        runtimeState.lastAppliedText = String(runtimeState.continue.baseText ?? '');

        runtimeState.continue.pmStripLiteral = '';
        runtimeState.continue.pmStripRegex = null;

        // Ensure the request includes the message we're actually continuing (not prompt-manager assistant prefill),
        // while optionally moving any prompt-manager assistant prefill into structured output constraints.
        const baseText = String(runtimeState.continue.baseText ?? '');
        const baseCanon = canonicalizeForContinueMatch(baseText);
        const tailCanon = canonicalizeForContinueMatch(prefillTemplate);
        const probe = 60;
        const baseProbe = baseCanon.slice(0, Math.min(probe, baseCanon.length));
        const tailProbe = tailCanon.slice(0, Math.min(probe, tailCanon.length));
        const looksLikeBase = !!(baseText && ((baseProbe && tailCanon.startsWith(baseProbe)) || (tailProbe && baseCanon.startsWith(tailProbe))));

        // If the assistant "tail" in the request doesn't resemble the message we plan to Continue in the UI,
        // bail out entirely (this can happen on welcome-page assistant flows or other non-chat contexts).
        if (baseText && prefillTemplate) {
            const { baseFound } = splitContinuePmPrefixFromTail(prefillTemplate, baseText);
            if (!looksLikeBase && !baseFound) {
                clearContinueState();
                return false;
            }
        }

        let pmPrefix = '';
        if (baseText) {
            const { pmPrefix: fromSplit, baseFound } = splitContinuePmPrefixFromTail(prefillTemplate, baseText);
            if (baseFound) {
                // Tail contains the base message (possibly with a PM prefix).
                pmPrefix = fromSplit || '';
            } else if (!looksLikeBase && prefillTemplate) {
                // Tail doesn't look like the base message; treat the whole tail as a PM prefill template.
                pmPrefix = prefillTemplate;
            }
        }

        if (overridePrefillText) {
            pmPrefix = overridePrefillText;
        }

        if (baseText) {
            if (!looksLikeBase) {
                tail.content = baseText;
                try {
                    console.debug(`[${extensionName}] Continue: replaced tail assistant content with base message (${baseText.length} chars).`);
                } catch {
                    // ignore
                }
            } else if (pmPrefix) {
                // Tail contains base message but also a PM prefill prefix: keep only the base in messages.
                tail.content = baseText;
            }
        }

        buildContinueStripper(baseText);

        const overlapChars = clampInt(settings.continue_overlap_chars, 0, 120, 14);
        const overlap = computeContinueOverlapBase(baseText, overlapChars);
        buildContinueOverlapStripper(overlap);
        joinSuffixRegex = buildContinueJoinPlaceholder(baseText);

        if (pmPrefix) {
            buildContinuePmStripper(pmPrefix);
        }

        // Continue schema prefix:
        // - Optional PM prefill (will be stripped back out locally)
        // - Short overlap of the existing message tail (also stripped back out)
        // joinPlaceholder is raw regex appended directly to the prefix pattern (not a [[...]] slot)
        // to avoid slot-parser issues with `]` inside character classes.
        schemaPrefix = `${pmPrefix || ''}${overlap}`;
        runtimeState.newlineToken = chooseNewlineToken(schemaPrefix || baseText, settings.newline_token);
    } else {
        // Prefill generator: replace any `[[pg]]` placeholders by calling a separate model/profile.
        // If disabled (or if generation fails), replace `[[pg]]` with an empty string and proceed normally.
        if (templateHasPrefillGenSlot(prefillTemplate)) {
            const profileId = String(settings.prefill_gen_profile_id ?? '');
            const maxTokens = clampInt(settings.prefill_gen_max_tokens, 1, 2048, 15);
            const timeoutMs = clampInt(settings.prefill_gen_timeout_ms, 500, 120000, 120000);
            const stopStrings = parseStopStrings(settings.prefill_gen_stop);
            const extraPrompt = String(settings.prefill_gen_extra_prompt ?? '');
            const extraPromptRole = normalizePrefillGenExtraPromptRole(settings.prefill_gen_extra_prompt_role);
            const keepMatchedStopString = !!settings.prefill_gen_keep_matched_stop_string;

            let generated = '';
            if (settings.prefill_gen_enabled) {
                try {
                    generated = await runPrefillGeneratorOrEmpty({
                        generateData,
                        tailIndex,
                        timeoutMs,
                        maxTokens,
                        stopStrings,
                        profileId,
                        extraPrompt,
                        extraPromptRole,
                        keepMatchedStopString,
                    });
                } catch (err) {
                    try {
                        console.warn(`[${extensionName}] Prefill generator failed:`, err);
                    } catch {
                        // ignore
                    }
                    if (window?.toastr?.error) {
                        window.toastr.error(String(err?.message ?? err ?? 'Prefill generator failed'), extensionName, { timeOut: 9000, closeButton: true });
                    }
                    generated = '';
                }
            }

            prefillTemplate = String(prefillTemplate ?? '').replace(/\[\[\s*pg\s*\]\]/gi, String(generated ?? ''));
        }

        // Remove the assistant prefill message and replace it with a structured output constraint.
        messages.splice(tailIndex, 1);

        // Legacy cleanup: if the user has old `[[SP: ...]]` blocks in their prefill, strip them.
        // StructuredPrefill now uses `[[...]]` as *slots* inside the prefix template.
        prefillTemplate = String(prefillTemplate ?? '').replace(/\[\[\s*sp\s*:[^\]]*\]\]/gi, '');
        // SAFEGUARD:
        // Literal `"` characters inside the prefix are very common in templates (e.g. quoting example thoughts),
        // but in "best-effort JSON" implementations they can cause repeated premature JSON-string termination
        // (model emits an unescaped `"` and the reply gets truncated at the same spot every time).
        // Converting literal quotes to curly quotes avoids needing escapes and dramatically improves robustness.
        prefillTemplate = curlyQuoteLiteralsOutsideSlots(prefillTemplate);

        const endSplit = splitEndPrefillTemplate(prefillTemplate);
        prefillTemplate = endSplit.template;
        mustEndAfterTemplate = endSplit.hasEndMarker;

        schemaPrefix = prefillTemplate;
        runtimeState.newlineToken = chooseNewlineToken(schemaPrefix, settings.newline_token);
        if (settings.hide_prefill_in_display) {
            // Build the stripper from the *straight-quoted* version of the template.
            // `curlyQuoteLiteralsOutsideSlots` converts `"` to curly `""` for JSON robustness in the schema pattern,
            // but the decoded output is straightened back by `straightenCurlyQuotes` in the decode pipeline.
            // The stripper must match straight quotes in the decoded text.
            buildPrefillStripper(straightenCurlyQuotes(schemaPrefix));
        }
        try {
            runtimeState.prefillCheckRegex = new RegExp(`^(?:${buildPrefixRegexFromWireTemplate(straightenCurlyQuotes(schemaPrefix))})`);
        } catch {
            runtimeState.prefillCheckRegex = null;
        }
    }

    // User constraint (repo-local): do not insert any new "nudge" message content.
    // However, some routed providers reject requests that *end* with an assistant-role message (assistant-prefill).
    // For Opus 4.6 via OpenRouter/Anthropic, this can fail even without structured outputs:
    // "This model does not support assistant message prefill. The conversation must end with a user message."
    //
    // For Continue, we can satisfy this without adding new instructions by re-labeling the final message role.
    if (messages.length) {
        if (isContinue && runtimeState.patternMode === 'anthropic') {
            // When "continue prefill" is disabled in ST, the request may have a trailing system message
            // (e.g. "[Continue your last message...]") after the assistant tail.  We need the last message
            // to be user-role for Anthropic. Strip trailing system messages and convert the tail to user.
            while (messages.length > 1 && messages[messages.length - 1]?.role === 'system') {
                messages.pop();
            }
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === 'assistant') {
                lastMsg.role = 'user';
            }
        }

        const lastMsg = messages[messages.length - 1];

        // Non-Continue: if we still end on assistant, it is another prefill (many providers reject that with
        // output formats). Ending on the previous AI reply is fine: that is plain chat history (group chats).
        if (!isContinue && lastMsg?.role === 'assistant' && !(tailIsChatHistory && lastMsg === historyTail)) {
            reportPrefill('not applied. After removing the prefill, the request still ends on another assistant prompt; merge or remove it.');
            return false;
        }

        if (runtimeState.patternMode === 'anthropic' && lastMsg?.role !== 'user' && lastMsg?.role !== 'system') {
            reportPrefill('not applied. This provider needs the request to end on a user message.');
            return false;
        }
    }

    const minCharsSetting = clampInt(settings.min_chars_after_prefix, 1, 10000, 80);
    const minCharsAfterPrefix = isContinue ? 1 : (mustEndAfterTemplate ? 0 : minCharsSetting);
    generateData.json_schema = buildJsonSchemaForPrefillValuePattern(schemaPrefix, minCharsAfterPrefix, joinSuffixRegex, { mustEndAfterTemplate });
    // Gemini's response_schema rejects `additionalProperties` (400 "Unknown name"), and relays such as
    // LinkAPI pass the schema through unchanged. Gemini only emits declared properties anyway.
    if (/gemini/i.test(modelId)) delete generateData.json_schema.value.additionalProperties;

    // Debug: log the structured output regex pattern that we inject.
    try {
        console.debug(`[${extensionName}] Injecting structured prefill: source=${src} model=${modelId} schema=response.pattern mode=${runtimeState.patternMode}`);
        const injectedPattern = generateData?.json_schema?.value?.properties?.response?.pattern
            ?? generateData?.json_schema?.value?.properties?.value?.pattern;
        if (typeof injectedPattern === 'string' && injectedPattern.length > 0) {
            console.debug(`[${extensionName}] Injected json_schema pattern (${injectedPattern.length} chars):`, injectedPattern);
            const continueBaseLen = runtimeState.continue.active ? String(runtimeState.continue.baseText ?? '').length : 0;
            console.debug(
                `[${extensionName}] Prefix/newline info: schema_prefix_len=${String(schemaPrefix ?? '').length}, continue_base_len=${continueBaseLen}, newline_token=${runtimeState.newlineToken}, min_chars_after_prefix=${minCharsAfterPrefix}`,
            );
        }
    } catch {
        // ignore
    }

    runtimeState.active = true;
    runtimeState.stopping = false;
    runtimeState.stopSessionAt = 0;
    clearStopCleanupTimer();
    runtimeState.lastInjectedAt = Date.now();
    reportPrefill(isContinue
        ? 'Continue (enforced through the schema).'
        : `prefill from ${prefillSource}: "${previewPrefill(tailContent)}"`);
    console.info(`[${extensionName}] ACTIVE: schema sent to ${src} / ${modelId}. Hide prefill: ${settings.hide_prefill_in_display ? 'on' : 'off'}. Waiting for the reply to check it...`);

    // If this generation updates an existing assistant message (e.g., swipes), seed the fallback with the
    // currently displayed content so early-abort / early-token cases don't blank the message.
    try {
        const tailChatMessage = chat?.[chat.length - 1];
        if (tailChatMessage && !tailChatMessage.is_user && !tailChatMessage.is_system) {
            if (typeof tailChatMessage.swipe_id === 'number') {
                runtimeState.trackedSwipeId = tailChatMessage.swipe_id;
            }
            if (typeof tailChatMessage.mes === 'string' && tailChatMessage.mes.trim().length > 0) {
                runtimeState.lastAppliedText = tailChatMessage.mes;
            }
        }
    } catch {
        // ignore
    }

    return true;
}

function scheduleStreamUnwrap(rawText) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!runtimeState.active) return;

    runtimeState.latestStreamText = String(rawText ?? '');
    const messageId = getActiveAssistantMessageIdForStreaming();
    // Keep the best-known decoded value up to date, but collapse actual DOM work into the
    // scheduled render path so stream chunks and observer churn paint at most once per frame.
    try {
        const rawStr = String(rawText ?? '');
        const unwrapped = tryUnwrapStructuredOutput(rawStr);
        if (typeof unwrapped === 'string') {
            runtimeState.lastAppliedText = unwrapped;
        } else if (rawStr.trimStart().startsWith('{')) {
            runtimeState.lastAppliedText = typeof runtimeState.lastAppliedText === 'string' ? runtimeState.lastAppliedText : '';
        }
    } catch {
        // ignore
    }
    ensureStreamObserver(messageId);
    scheduleDecodedRender(messageId);
}

function onMessageReceived(messageId) {
    if (!runtimeState.active) return;
    clearPostStopDomFixTimer();

    const raw = getRawCandidateForMessage(messageId);
    const unwrapped = tryUnwrapStructuredOutput(String(raw));
    if (typeof unwrapped === 'string') runtimeState.lastAppliedText = unwrapped;
    checkReplyAgainstPrefill(unwrapped);
    applyTextToMessage(messageId, (typeof unwrapped === 'string' ? unwrapped : chat?.[messageId]?.mes ?? ''), { forceRerender: true });

    runtimeState.active = false;
    runtimeState.stopping = false;
    runtimeState.trackedSwipeId = -1;
    clearStopCleanupTimer();
    disconnectStreamObserver();
    clearHidePrefillState();
    clearContinueState();
    resetStreamGuard();
}

function onGenerationStopped() {
    if (!runtimeState.active) return;
    clearPostStopDomFixTimer();

    const messageId = getActiveAssistantMessageIdForStreaming();
    runtimeState.stopping = true;
    runtimeState.stopSessionAt = runtimeState.lastInjectedAt;

    // Track the current swipe_id to validate it hasn't changed when cleanup fires.
    // If it was already captured at injection time (e.g., swipe generation), don't overwrite it.
    if (runtimeState.trackedSwipeId === -1) {
        const message = chat?.[messageId];
        runtimeState.trackedSwipeId = message?.swipe_id ?? -1;
    }

    ensureStreamObserver(messageId);
    // Decode immediately and then keep decoding until the DOM goes quiet.
    scheduleDecodedRender(messageId);
    touchStopCleanup(messageId, runtimeState.stopSessionAt);
}

// Tells the user, in the console and status line, whether the provider actually enforced the prefill.
function checkReplyAgainstPrefill(unwrapped) {
    const regex = runtimeState.prefillCheckRegex;
    runtimeState.prefillCheckRegex = null;
    if (runtimeState.continue.active) return;

    const tag = `[${extensionName}]`;
    const addToStatus = (suffix) => {
        runtimeState.lastPrefillReport = `${runtimeState.lastPrefillReport} ${suffix}`;
        renderStatus();
    };
    if (typeof unwrapped !== 'string') {
        console.warn(`${tag} NOT WORKING: the reply was not the expected JSON, so the provider ignored the schema and the prefill was not enforced.`);
        addToStatus('NOT enforced: the provider ignored the schema.');
        return;
    }
    if (!(regex instanceof RegExp)) return;

    const text = normalizeNewlines(unwrapped);
    if (!regex.test(text)) {
        console.warn(`${tag} NOT WORKING: the reply does not start with the prefill, so the provider treated it as a suggestion.\n  Reply starts with: "${previewPrefill(text, 120)}"`);
        addToStatus('NOT enforced: the reply did not start with it.');
        return;
    }

    let hideNote = 'Hide prefill is off, so the prefill stays in the message (expected).';
    if (extension_settings[extensionName]?.hide_prefill_in_display) {
        const hidden = maybeHidePrefillForDisplay(unwrapped) !== text;
        hideNote = hidden
            ? 'Hide prefill is on and the prefill was removed from the message.'
            : 'Hide prefill is on, but the hidden part was empty (is [[keep]] at the very start?) so nothing was removed.';
    }
    console.info(`${tag} WORKING: the reply starts with the prefill, so the provider enforced it. ${hideNote}`);
    addToStatus('Enforced.');
}

function previewPrefill(text, max = 60) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function reportPrefill(text) {
    if (text !== runtimeState.lastPrefillReport) console.info(`[${extensionName}] Last reply: ${text}`);
    runtimeState.lastPrefillReport = text;
    renderStatus();
}

// One-line answer to "is StructuredPrefill doing anything right now, and with which prefill?"
function renderStatus() {
    const el = document.getElementById('structuredprefill_status');
    if (!(el instanceof HTMLElement)) return;

    const settings = extension_settings[extensionName];
    const setStatus = (active, text) => {
        const report = active ? runtimeState.lastPrefillReport : '';
        el.textContent = report ? `${text}\nLast reply: ${report}` : text;
        el.classList.toggle('active', active);
        el.classList.toggle('inactive', !active);
    };

    if (!settings?.enabled) return setStatus(false, 'Off.');

    const mainApi = String(stScript?.main_api ?? '');
    const oai = stOpenAi?.oai_settings;
    if ((mainApi && mainApi !== 'openai') || !oai) {
        return setStatus(false, 'Inactive: switch to a Chat Completion API.');
    }

    const model = typeof stOpenAi.getChatCompletionModel === 'function' ? String(stOpenAi.getChatCompletionModel(oai) ?? '') : '';
    const support = getStructuredOutputSupport({
        chat_completion_source: oai.chat_completion_source,
        model,
        pollinations_endpoint: oai.pollinations_endpoint,
    });
    if (!support.supported) return setStatus(false, `Inactive: ${support.reason}`);

    const prefillSource = getOverridePrefillText(settings)
        ? 'the Prefill box'
        : "the chat preset's prefill (a trailing assistant prompt), if it has one";
    setStatus(true, `Active for ${oai.chat_completion_source}${model ? ` / ${model}` : ''}, using ${prefillSource}.`);
}

function renderSettingsToUi() {
    const settings = extension_settings[extensionName];
    refreshPresetList();
    $('#structuredprefill_enabled').prop('checked', !!settings.enabled);
    $('#structuredprefill_hide_prefill_in_display').prop('checked', !!settings.hide_prefill_in_display);
    $('#structuredprefill_override_prefill_enabled').prop('checked', !!settings.override_prefill_enabled);
    $('#structuredprefill_override_prefill_text').val(String(settings.override_prefill_text ?? ''));
    $('#structuredprefill_min_chars_after_prefix').val(String(settings.min_chars_after_prefix ?? 80));
    $('#structuredprefill_prefill_gen_enabled').prop('checked', !!settings.prefill_gen_enabled);
    $('#structuredprefill_prefill_gen_extra_prompt').val(String(settings.prefill_gen_extra_prompt ?? ''));
    $('#structuredprefill_prefill_gen_extra_prompt_role').val(normalizePrefillGenExtraPromptRole(settings.prefill_gen_extra_prompt_role));
    $('#structuredprefill_prefill_gen_max_tokens').val(String(settings.prefill_gen_max_tokens ?? 15));
    $('#structuredprefill_prefill_gen_stop').val(String(settings.prefill_gen_stop ?? ''));
    $('#structuredprefill_prefill_gen_keep_matched_stop_string').prop('checked', !!settings.prefill_gen_keep_matched_stop_string);
    $('#structuredprefill_prefill_gen_timeout_ms').val(String(settings.prefill_gen_timeout_ms ?? 120000));
    renderPrefillGenProfileSelect();
    $('#structuredprefill_newline_token').val(String(settings.newline_token ?? '<NL>'));
    $('#structuredprefill_continue_overlap_chars').val(String(settings.continue_overlap_chars ?? 14));
    $('#structuredprefill_anti_slop_ban_list').val(String(settings.anti_slop_ban_list ?? ''));
    renderStatus();
}

function setupUiListeners() {
    $('#structuredprefill_preset_list')
        .off('change')
        .on('change', () => {
            changePreset($('#structuredprefill_preset_list').prop('selectedIndex'));
        });

    $('#structuredprefill_preset_new')
        .off('click')
        .on('click', async () => {
            const settings = extension_settings[extensionName];
            const currentPreset = getActivePreset(settings) ?? getDefaultPreset();
            const requestedName = await promptForPresetName({ title: 'New StructuredPrefill preset', initialValue: '' });
            if (!requestedName) return;

            const usedNames = new Set(settings.presets.map(preset => preset.name));
            const presetName = uniquifyPresetName(requestedName, usedNames);
            const preset = normalizePresetObject({ ...currentPreset, name: presetName }, presetName);
            const presetIdx = updateOrInsertPreset(settings.presets, preset);
            changePreset(presetIdx);
        });

    $('#structuredprefill_preset_rename')
        .off('click')
        .on('click', async () => {
            const settings = extension_settings[extensionName];
            const activePreset = getActivePreset(settings);
            if (!activePreset) return;

            const requestedName = await promptForPresetName({ title: 'Rename StructuredPrefill preset', initialValue: activePreset.name });
            if (!requestedName) return;

            const usedNames = new Set(settings.presets.filter((_, index) => index !== settings.active_preset_idx).map(preset => preset.name));
            activePreset.name = uniquifyPresetName(requestedName, usedNames);
            settings.active_preset = activePreset.name;
            refreshPresetList();
            $('#structuredprefill_preset_list').val(activePreset.name);
            saveSettingsDebounced();
        });

    $('#structuredprefill_preset_import_file')
        .off('change')
        .on('change', async function () {
            for (const file of this.files) {
                await importPreset(file);
            }
            this.value = '';
        });

    $('#structuredprefill_preset_import')
        .off('click')
        .on('click', () => {
            $('#structuredprefill_preset_import_file').trigger('click');
        });

    $('#structuredprefill_preset_export')
        .off('click')
        .on('click', () => {
            const activePreset = getActivePreset();
            if (!activePreset) return;

            const fileName = `${activePreset.name.replace(/[\s.<>:"/\\|?*\x00-\x1F\x7F]/g, '_').toLowerCase()}.json`;
            download(JSON.stringify(activePreset, null, 4), fileName, 'application/json');
        });

    $('#structuredprefill_preset_delete')
        .off('click')
        .on('click', async () => {
            const settings = extension_settings[extensionName];
            const confirmed = await callPopup('Are you sure you want to delete this StructuredPrefill preset?', 'confirm');
            if (!confirmed) return;

            settings.presets.splice(settings.active_preset_idx, 1);
            if (settings.presets.length === 0) {
                settings.presets.push(getDefaultPreset());
            }

            changePreset(Math.min(settings.active_preset_idx, settings.presets.length - 1));
        });

    $('#structuredprefill_enabled')
        .off('click')
        .on('click', () => {
            extension_settings[extensionName].enabled = !!$('#structuredprefill_enabled').prop('checked');
            saveSettingsDebounced();
            renderStatus();
        });

    $('#structuredprefill_hide_prefill_in_display')
        .off('click')
        .on('click', () => {
            setPresetSetting('hide_prefill_in_display', !!$('#structuredprefill_hide_prefill_in_display').prop('checked'));
        });

    $('#structuredprefill_override_prefill_enabled')
        .off('click')
        .on('click', () => {
            setPresetSetting('override_prefill_enabled', !!$('#structuredprefill_override_prefill_enabled').prop('checked'));
            renderStatus();
        });

    $('#structuredprefill_override_prefill_text')
        .off('input')
        .on('input', () => {
            setPresetSetting('override_prefill_text', String($('#structuredprefill_override_prefill_text').val() ?? ''));
            renderStatus();
        });

    $('#structuredprefill_min_chars_after_prefix')
        .off('change')
        .on('change', () => {
            const value = clampInt($('#structuredprefill_min_chars_after_prefix').val(), 1, 10000, 80);
            setPresetSetting('min_chars_after_prefix', value);
            $('#structuredprefill_min_chars_after_prefix').val(String(value));
        });

    $('#structuredprefill_prefill_gen_enabled')
        .off('click')
        .on('click', () => {
            setPresetSetting('prefill_gen_enabled', !!$('#structuredprefill_prefill_gen_enabled').prop('checked'));
        });

    $('#structuredprefill_prefill_gen_extra_prompt')
        .off('input')
        .on('input', () => {
            setPresetSetting('prefill_gen_extra_prompt', String($('#structuredprefill_prefill_gen_extra_prompt').val() ?? ''));
        });

    $('#structuredprefill_prefill_gen_extra_prompt_role')
        .off('change')
        .on('change', () => {
            const value = normalizePrefillGenExtraPromptRole($('#structuredprefill_prefill_gen_extra_prompt_role').val());
            setPresetSetting('prefill_gen_extra_prompt_role', value);
            $('#structuredprefill_prefill_gen_extra_prompt_role').val(value);
        });

    $('#structuredprefill_prefill_gen_profile')
        .off('change')
        .on('change', () => {
            setPresetSetting('prefill_gen_profile_id', String($('#structuredprefill_prefill_gen_profile').val() ?? ''));
        });

    $('#structuredprefill_prefill_gen_max_tokens')
        .off('change')
        .on('change', () => {
            const value = clampInt($('#structuredprefill_prefill_gen_max_tokens').val(), 1, 2048, 15);
            setPresetSetting('prefill_gen_max_tokens', value);
            $('#structuredprefill_prefill_gen_max_tokens').val(String(value));
        });

    $('#structuredprefill_prefill_gen_stop')
        .off('input')
        .on('input', () => {
            setPresetSetting('prefill_gen_stop', String($('#structuredprefill_prefill_gen_stop').val() ?? ''));
        });

    $('#structuredprefill_prefill_gen_keep_matched_stop_string')
        .off('click')
        .on('click', () => {
            setPresetSetting('prefill_gen_keep_matched_stop_string', !!$('#structuredprefill_prefill_gen_keep_matched_stop_string').prop('checked'));
        });

    $('#structuredprefill_prefill_gen_timeout_ms')
        .off('change')
        .on('change', () => {
            const value = clampInt($('#structuredprefill_prefill_gen_timeout_ms').val(), 500, 120000, 120000);
            setPresetSetting('prefill_gen_timeout_ms', value);
            $('#structuredprefill_prefill_gen_timeout_ms').val(String(value));
        });

    $('#structuredprefill_newline_token')
        .off('input')
        .on('input', () => {
            setPresetSetting('newline_token', String($('#structuredprefill_newline_token').val() ?? '<NL>'));
        });

    $('#structuredprefill_continue_overlap_chars')
        .off('change')
        .on('change', () => {
            const value = clampInt($('#structuredprefill_continue_overlap_chars').val(), 0, 120, 14);
            setPresetSetting('continue_overlap_chars', value);
            $('#structuredprefill_continue_overlap_chars').val(String(value));
        });

    $('#structuredprefill_anti_slop_ban_list')
        .off('input')
        .on('input', () => {
            setPresetSetting('anti_slop_ban_list', String($('#structuredprefill_anti_slop_ban_list').val() ?? ''));
        });
}

jQuery(async () => {
    if ($('.structuredprefill_settings').length === 0) {
        $('#extensions_settings').append(await renderExtensionTemplateAsync(extensionPath, 'settings'));
    }

    loadSettings();
    renderSettingsToUi();
    setupUiListeners();
    registerSlashCommands();
    ensureScrollLockListeners();

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, renderPrefillGenProfileSelect);
    for (const eventName of ['MAIN_API_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'SETTINGS_LOADED_AFTER', 'OAI_PRESET_CHANGED_AFTER', 'CONNECTION_PROFILE_LOADED']) {
        if (event_types[eventName]) eventSource.on(event_types[eventName], () => setTimeout(renderStatus, 0));
    }
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, scheduleStreamUnwrap);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    console.log(`[${extensionName}] extension loaded`);
});
