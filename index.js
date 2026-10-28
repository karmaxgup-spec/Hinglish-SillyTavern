// Google Translate (Payload to English) for SillyTavern
//
// Translates chat history in the actual request body right before it is sent
// to the API. The chat on screen, the saved chat file and the stored messages
// are never changed. Only the copy of the request that goes over the network
// is rewritten.
//
// It wraps window.fetch and, for chat completion requests, parses the JSON body,
// translates the non-system messages, and sends the modified body on.
//
// Accuracy changes in this version:
//   - Each message is sent whole (one request per message), not cut into
//     900-character pieces. Long messages are only split if they exceed MAX_CHUNK,
//     and then only at paragraph or sentence boundaries.
//   - Requests use POST, so long non-Latin text no longer breaks the URL length.
//   - Line breaks are kept, so paragraph structure survives translation.

import { extension_settings } from '../../../extensions.js';

const MODULE = 'st_gtranslate_payload';
const CACHE_KEY = 'st_gtranslate_payload_cache';

const DEFAULTS = {
    enabled: true,
    targetLang: 'en',
    translateUser: true,
    translateAssistant: true,
    concurrency: 4,
};

const LANGUAGES = [
    ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'],
    ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-CN', 'Chinese (Simplified)'],
    ['ar', 'Arabic'], ['tr', 'Turkish'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
    ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ur', 'Urdu'],
];

const MAX_CHUNK = 4500;  // characters per request; most messages fit in one
const MAX_CACHE = 5000;  // persisted translation entries

// ---------- settings ----------

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

// ---------- persistent cache ----------

const cache = new Map();

function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return;
        for (const [k, v] of Object.entries(JSON.parse(raw))) cache.set(k, v);
    } catch (e) {
        console.warn('[GT payload] could not load cache', e);
    }
}

let saveTimer = null;
function scheduleCacheSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const entries = [...cache.entries()].slice(-MAX_CACHE);
            localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch (e) {
            console.warn('[GT payload] could not save cache', e);
        }
    }, 500);
}

function clearCache() {
    cache.clear();
    localStorage.removeItem(CACHE_KEY);
}

// ---------- Google Translate (unofficial gtx endpoint, no API key) ----------

// Splits only when a message is longer than MAX_CHUNK. Prefers paragraph breaks,
// then line breaks, then sentence ends, so each piece stays a coherent unit.
// Each piece keeps its trailing separator so joining the results restores the text.
function splitForGoogle(text) {
    if (text.length <= MAX_CHUNK) return [text];

    const parts = [];
    let rest = text;
    while (rest.length > MAX_CHUNK) {
        const window = rest.slice(0, MAX_CHUNK);
        let cut = window.lastIndexOf('\n\n');
        if (cut < MAX_CHUNK / 2) cut = window.lastIndexOf('\n');
        if (cut < MAX_CHUNK / 2) {
            const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
            if (sentenceEnd > 0) cut = sentenceEnd + 1;
        }
        if (cut < MAX_CHUNK / 2) cut = window.lastIndexOf(' ');
        if (cut < 1) cut = MAX_CHUNK;
        // Keep the separator at the end of this piece.
        const end = (window[cut] === '\n' || window[cut] === ' ') ? cut + 1 : cut + 1;
        parts.push(rest.slice(0, end));
        rest = rest.slice(end);
    }
    parts.push(rest);
    return parts;
}

async function translateChunk(text, target) {
    // POST keeps long text out of the URL, so non-Latin scripts don't hit URL length limits.
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t'
        + '&tl=' + encodeURIComponent(target);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'q=' + encodeURIComponent(text),
    });
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const data = await res.json();
    return {
        text: data[0].map(seg => seg[0]).join(''),
        src: data[2],
    };
}

// Returns translated text, or the original if it is already in the target language.
async function translate(text, target) {
    const key = target + '\u0000' + text;
    if (cache.has(key)) return cache.get(key);

    const out = [];
    let detected = null;
    for (const p of splitForGoogle(text)) {
        const r = await translateChunk(p, target);
        detected = detected || r.src;
        out.push(r.text);
    }

    const sameLanguage = detected
        && detected.toLowerCase().split('-')[0] === target.toLowerCase().split('-')[0];
    const result = sameLanguage ? text : out.join('');

    cache.set(key, result);
    scheduleCacheSave();
    return result;
}

// Translate, but fall back to the original on any error so generation still works.
async function safeTranslate(text, target) {
    try {
        return await translate(text, target);
    } catch (err) {
        console.warn('[GT payload] translation failed, using original:', err);
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

// Translates the messages array of a chat completion request body in place.
// `body` is our own parsed copy of the request, so this does not touch the chat.
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

    console.log(`[GT payload] ${queued} message segment(s) queued for translation to "${s.targetLang}"`);
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
                    console.log('[GT payload] request body rewritten with translated messages');
                }
            }
        }
    } catch (err) {
        console.warn('[GT payload] could not rewrite request, sending original:', err);
    }
    return originalFetch(input, init);
};

// ---------- settings panel ----------

function buildSettingsPanel() {
    const s = settings();
    const langOptions = LANGUAGES
        .map(([code, name]) => `<option value="${code}"${code === s.targetLang ? ' selected' : ''}>${name}</option>`)
        .join('');

    const html = `
<div class="st-gtpayload inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Google Translate (Payload)</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="gtp_enabled"> Enabled</label>
    <label class="checkbox_label"><input type="checkbox" id="gtp_user"> Translate my messages</label>
    <label class="checkbox_label"><input type="checkbox" id="gtp_assistant"> Translate assistant messages</label>
    <label>Send to model in
      <select id="gtp_lang" class="text_pole">${langOptions}</select>
    </label>
    <label>Parallel requests
      <input type="number" id="gtp_conc" class="text_pole" min="1" max="10" value="${s.concurrency}">
    </label>
    <div class="flex-container">
      <button id="gtp_clear" class="menu_button">Clear translation cache</button>
    </div>
    <small>Changes only the request sent to the model. The chat on screen and saved chats keep their original text.</small>
  </div>
</div>`;

    const container = document.getElementById('extensions_settings') || document.body;
    container.insertAdjacentHTML('beforeend', html);

    const $ = window.jQuery;
    $('#gtp_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked; saveSettings();
    });
    $('#gtp_user').prop('checked', s.translateUser).on('change', function () {
        s.translateUser = this.checked; saveSettings();
    });
    $('#gtp_assistant').prop('checked', s.translateAssistant).on('change', function () {
        s.translateAssistant = this.checked; saveSettings();
    });
    $('#gtp_lang').on('change', function () {
        s.targetLang = this.value; saveSettings();
    });
    $('#gtp_conc').on('change', function () {
        s.concurrency = Math.min(10, Math.max(1, parseInt(this.value, 10) || 4));
        this.value = s.concurrency;
        saveSettings();
    });
    $('#gtp_clear').on('click', function () {
        clearCache();
        if (window.toastr) window.toastr.success('Translation cache cleared');
    });
}

jQuery(() => {
    settings();
    loadCache();
    buildSettingsPanel();
});
