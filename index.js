// Google Translate (Payload to English) for SillyTavern
//
// Translates chat history right before a generation request is built, so the
// model and every other extension see English. The chat on screen, the saved
// chat file and the stored messages are never changed.
//
// SillyTavern calls window.gtPayloadInterceptor(chat, contextSize, abort, type)
// before building the prompt. The `chat` array can have three shapes:
//   - Chat Completion APIs: objects like { role: 'user'|'assistant'|'system', content: string | parts[] }
//   - Text Completion APIs: plain strings
//   - Internal message objects: { mes: string, is_user: boolean, is_system: boolean }
// We handle all three. We replace entries in the array with translated copies
// and never mutate the original objects.

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

const MAX_CHUNK = 900;   // characters per Google request
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

function splitForGoogle(text) {
    const parts = [];
    let rest = text;
    while (rest.length > MAX_CHUNK) {
        let cut = rest.lastIndexOf('\n', MAX_CHUNK);
        if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(' ', MAX_CHUNK);
        if (cut < 1) cut = MAX_CHUNK;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    parts.push(rest);
    return parts;
}

async function translateChunk(text, target) {
    const url = 'https://translate.googleapis.com/translate_a/single'
        + '?client=gtx&sl=auto&dt=t'
        + '&tl=' + encodeURIComponent(target)
        + '&q=' + encodeURIComponent(text);
    const res = await fetch(url);
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

// Translate, but fall back to the original text on any error so generation still works.
async function safeTranslate(text, target) {
    try {
        return await translate(text, target);
    } catch (err) {
        console.warn('[GT payload] translation failed, using original:', err);
        return text;
    }
}

// ---------- payload interceptor ----------

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

// Called by SillyTavern before the prompt is built. Mutates the `chat` array
// in place, replacing entries with translated copies.
window.gtPayloadInterceptor = async function (chat, contextSize, abort, type) {
    const s = settings();
    if (!s.enabled || !Array.isArray(chat)) return;

    const target = s.targetLang;
    const tasks = [];
    let queued = 0;

    for (let i = 0; i < chat.length; i++) {
        const item = chat[i];

        // Text Completion: plain strings. Role is unknown, so translate if either side is enabled.
        if (typeof item === 'string') {
            if (!item.trim() || !(s.translateUser || s.translateAssistant)) continue;
            queued++;
            tasks.push(async () => {
                chat[i] = await safeTranslate(item, target);
            });
            continue;
        }

        if (!item || typeof item !== 'object') continue;
        if (item.role === 'system' || item.is_system) continue;

        const isUser = item.role === 'user' || item.is_user === true;
        if (isUser ? !s.translateUser : !s.translateAssistant) continue;

        // Chat Completion: content is a string.
        if (typeof item.content === 'string') {
            if (!item.content.trim()) continue;
            queued++;
            tasks.push(async () => {
                chat[i] = { ...chat[i], content: await safeTranslate(chat[i].content, target) };
            });
            continue;
        }

        // Chat Completion: content is an array of parts (text, images, ...). Translate text parts only.
        if (Array.isArray(item.content)) {
            const textIdx = [];
            item.content.forEach((p, pi) => {
                if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) textIdx.push(pi);
            });
            if (!textIdx.length) continue;
            queued += textIdx.length;
            tasks.push(async () => {
                const parts = [...chat[i].content];
                for (const pi of textIdx) {
                    parts[pi] = { ...parts[pi], text: await safeTranslate(parts[pi].text, target) };
                }
                chat[i] = { ...chat[i], content: parts };
            });
            continue;
        }

        // Internal message objects.
        if (typeof item.mes === 'string') {
            if (!item.mes.trim()) continue;
            queued++;
            tasks.push(async () => {
                chat[i] = { ...chat[i], mes: await safeTranslate(chat[i].mes, target) };
            });
        }
    }

    console.log(`[GT payload] ${queued} message segment(s) queued for translation to "${target}" (type: ${type})`);
    if (!queued) {
        console.warn('[GT payload] nothing matched. Check the chat payload shape or the user/assistant toggles.');
        return;
    }

    await runPool(tasks, s.concurrency);
    console.log('[GT payload] done');
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
    <small>Changes only the prompt sent to the model. The chat on screen and saved chats keep their original text.</small>
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
