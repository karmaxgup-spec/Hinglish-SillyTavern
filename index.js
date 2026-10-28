// Built-in Translate (Payload Only) for SillyTavern
//
// Uses SillyTavern's built-in translate() (public/scripts/extensions/translate/index.js) to
// translate the chat history in the outgoing request. The provider is whatever
// you set in SillyTavern's translation settings, including its keyless Bing option.
//
// The chat on screen, the saved chat and the stored messages are never changed.
// Only the copy of the request that goes to the API is rewritten.
//
// This extension does not add a translation provider or call any translation
// service directly. It relies on the built-in function and falls back to the
// original text if that function is missing or fails.

import { extension_settings } from '../../../extensions.js';

const MODULE = 'st_builtin_translate_payload';

const DEFAULTS = {
    enabled: true,
    targetLang: 'en',
    translateUser: true,
    translateAssistant: true,
    concurrency: 2,
};

const FAIL_COOLDOWN_MS = 120000; // don't retry a failed message for 2 minutes
const MAX_CACHE = 2000;

function settings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULTS);
    }
    for (const k of Object.keys(DEFAULTS)) {
        if (extension_settings[MODULE][k] === undefined) {
            extension_settings[MODULE][k] = DEFAULTS[k];
        }
    }
    return extension_settings[MODULE];
}

function saveSettings() {
    if (typeof window.saveSettingsDebounced === 'function') {
        window.saveSettingsDebounced();
    }
}

// ---------- SillyTavern's built-in translate ----------

let builtinTranslate = null;

async function getBuiltinTranslate() {
    if (builtinTranslate) return builtinTranslate;
    const mod = await import('../../translate/index.js');
    if (typeof mod.translate !== 'function') {
        throw new Error('SillyTavern built-in translate() was not found in extensions/translate/index.js');
    }
    builtinTranslate = mod.translate;
    return builtinTranslate;
}

// ---------- cache and failure cooldown ----------

const cache = new Map();
const failedAt = new Map();

function cacheKey(text, lang) {
    return lang + '\u0000' + text;
}

function remember(key, value) {
    cache.set(key, value);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

// Returns the translated text, or the original on any failure.
async function safeTranslate(text, lang) {
    const key = cacheKey(text, lang);
    if (cache.has(key)) return cache.get(key);

    const last = failedAt.get(key);
    if (last && Date.now() - last < FAIL_COOLDOWN_MS) return text;

    try {
        const translate = await getBuiltinTranslate();
        const result = await translate(text, lang);
        if (typeof result !== 'string' || !result.trim()) throw new Error('empty translation');
        remember(key, result);
        return result;
    } catch (err) {
        failedAt.set(key, Date.now());
        console.warn('[ST built-in payload] translation failed, using original (retry in 2 min):', err.message || err);
        return text;
    }
}

// ---------- request body rewriting ----------

async function runPool(tasks, n) {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, n) }, async () => {
        while (next < tasks.length) {
            const task = tasks[next++];
            await task();
        }
    });
    await Promise.all(workers);
}

// Translates messages in our own parsed copy of the request body.
async function translateBodyMessages(body) {
    const s = settings();
    const messages = body.messages;
    const tasks = [];
    let queued = 0;

    messages.forEach((m, i) => {
        if (!m || typeof m !== 'object') return;
        if (m.role === 'system') return;
        const isUser = m.role === 'user';
        if (isUser ? !s.translateUser : !s.translateAssistant) return;

        if (typeof m.content === 'string') {
            if (!m.content.trim()) return;
            queued++;
            tasks.push(async () => {
                messages[i].content = await safeTranslate(m.content, s.targetLang);
            });
        } else if (Array.isArray(m.content)) {
            m.content.forEach((part, pi) => {
                if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                    queued++;
                    tasks.push(async () => {
                        messages[i].content[pi].text = await safeTranslate(part.text, s.targetLang);
                    });
                }
            });
        }
    });

    console.log(`[ST built-in payload] ${queued} segment(s) queued for "${s.targetLang}"`);
    if (!queued) return false;

    await runPool(tasks, s.concurrency);
    return true;
}

function isChatCompletionUrl(url) {
    return url.includes('/chat-completions/generate') || url.includes('/chat/completions');
}

// Wrap fetch so chat completion requests carry translated messages.
const originalFetch = window.fetch.bind(window);

window.fetch = async function (input, init) {
    try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const s = settings();
        if (s.enabled && init && typeof init.body === 'string' && isChatCompletionUrl(url)) {
            const body = JSON.parse(init.body);
            if (body && Array.isArray(body.messages)) {
                const changed = await translateBodyMessages(body);
                if (changed) {
                    init = { ...init, body: JSON.stringify(body) };
                    console.log('[ST built-in payload] request body rewritten');
                }
            }
        }
    } catch (err) {
        console.warn('[ST built-in payload] could not rewrite request, sending original:', err);
    }
    return originalFetch(input, init);
};

// ---------- settings panel ----------

function buildSettingsPanel() {
    const s = settings();
    const html = `
<div class="st-builtin-payload inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Built-in Translate (Payload Only)</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="stbp_enabled"> Enabled</label>
    <label class="checkbox_label"><input type="checkbox" id="stbp_user"> Translate my messages</label>
    <label class="checkbox_label"><input type="checkbox" id="stbp_assistant"> Translate assistant messages</label>
    <label>Target language code
      <input type="text" id="stbp_lang" class="text_pole" value="${s.targetLang}" placeholder="en">
    </label>
    <label>Parallel requests
      <input type="number" id="stbp_conc" class="text_pole" min="1" max="10" value="${s.concurrency}">
    </label>
    <small>Uses the provider set in SillyTavern's translation settings. Changes only the request sent to the model. The chat on screen and saved chats keep their original text.</small>
  </div>
</div>`;

    const container = document.getElementById('extensions_settings') || document.body;
    container.insertAdjacentHTML('beforeend', html);

    const $ = window.jQuery;
    $('#stbp_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked; saveSettings();
    });
    $('#stbp_user').prop('checked', s.translateUser).on('change', function () {
        s.translateUser = this.checked; saveSettings();
    });
    $('#stbp_assistant').prop('checked', s.translateAssistant).on('change', function () {
        s.translateAssistant = this.checked; saveSettings();
    });
    $('#stbp_lang').on('change', function () {
        s.targetLang = this.value.trim() || 'en'; saveSettings();
    });
    $('#stbp_conc').on('change', function () {
        s.concurrency = Math.min(10, Math.max(1, parseInt(this.value, 10) || 2));
        this.value = s.concurrency;
        saveSettings();
    });
}

jQuery(() => {
    settings();
    buildSettingsPanel();
});
