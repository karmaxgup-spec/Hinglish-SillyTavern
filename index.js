// Google Translate (Display Only) for SillyTavern
//
// Translates the text shown in chat bubbles (user and assistant) using Google
// Translate. It only swaps the text inside existing text nodes:
//   - no classes, styles, layout or markup are added or changed
//   - code blocks and reasoning blocks are left alone
//   - the stored chat, prompts and saved files are never modified
// Turning the extension off restores the original text.

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE = 'st_gtranslate_display';

const DEFAULTS = {
    enabled: true,
    targetLang: 'hi',
    translateUser: true,
    translateAssistant: true,
};

const LANGUAGES = [
    ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'],
    ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-CN', 'Chinese (Simplified)'],
    ['ar', 'Arabic'], ['tr', 'Turkish'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
    ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ur', 'Urdu'],
];

const MAX_CHUNK = 900; // characters per Google request (keeps the URL short)
const SKIP_SELECTOR = 'code, pre, script, style, .mes_reasoning, .mes_reasoning_details';

// Original text of every node we have changed. WeakMap, so detached nodes are freed.
const originals = new WeakMap();
const cache = new Map();

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

function save() {
    if (typeof window.saveSettingsDebounced === 'function') {
        window.saveSettingsDebounced();
    }
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
    return data[0].map(seg => seg[0]).join('');
}

async function translate(text, target) {
    const key = target + '\u0000' + text;
    if (cache.has(key)) return cache.get(key);

    const pieces = splitForGoogle(text);
    const out = [];
    for (const p of pieces) {
        out.push(await translateChunk(p, target));
    }
    const result = out.join('');
    cache.set(key, result);
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return result;
}

// ---------- DOM work: text nodes only ----------

function textNodesIn(root, filterSkips = true) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (filterSkips && node.parentElement && node.parentElement.closest(SKIP_SELECTOR)) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
}

function splitWhitespace(s) {
    const lead = s.match(/^\s*/)[0];
    const trail = s.match(/\s*$/)[0];
    return { lead, core: s.trim(), trail };
}

async function translateNode(node, target) {
    const current = node.nodeValue;
    const { lead, core, trail } = splitWhitespace(current);
    if (!core) return;

    // Always translate from the original text, so repeated runs do not stack.
    const source = originals.has(node) ? originals.get(node) : current;
    const parts = splitWhitespace(source);
    if (!originals.has(node)) originals.set(node, current);

    const translated = await translate(parts.core, target);
    if (!node.isConnected) return; // message was re-rendered meanwhile
    node.nodeValue = parts.lead + translated + parts.trail;
}

function shouldTranslateMessage(mesEl) {
    const s = settings();
    if (!s.enabled) return false;
    const isUser = mesEl.getAttribute('is_user') === 'true';
    return isUser ? s.translateUser : s.translateAssistant;
}

async function translateMessageEl(mesEl) {
    if (!mesEl) return;
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;
    if (!shouldTranslateMessage(mesEl)) {
        restoreIn(textEl);
        return;
    }
    const target = settings().targetLang;
    const nodes = textNodesIn(textEl);
    await Promise.all(nodes.map(n => translateNode(n, target).catch(err => {
        console.warn('[GT display] translate failed:', err);
    })));
}

function restoreIn(root) {
    for (const node of textNodesIn(root, false)) {
        if (originals.has(node)) {
            node.nodeValue = originals.get(node);
            originals.delete(node);
        }
    }
}

async function translateById(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    await translateMessageEl(el);
}

async function translateAll() {
    const els = document.querySelectorAll('#chat .mes');
    for (const el of els) {
        await translateMessageEl(el);
    }
}

function restoreAll() {
    document.querySelectorAll('#chat .mes .mes_text').forEach(restoreIn);
}

// ---------- Settings panel ----------

function buildSettingsPanel() {
    const s = settings();
    const langOptions = LANGUAGES
        .map(([code, name]) => `<option value="${code}"${code === s.targetLang ? ' selected' : ''}>${name}</option>`)
        .join('');

    const html = `
<div class="st-gtdisplay inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Google Translate (Display Only)</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="gtd_enabled"> Enabled</label>
    <label class="checkbox_label"><input type="checkbox" id="gtd_user"> Translate my messages</label>
    <label class="checkbox_label"><input type="checkbox" id="gtd_assistant"> Translate assistant messages</label>
    <label>Target language
      <select id="gtd_lang" class="text_pole">${langOptions}</select>
    </label>
    <small>Changes only what is displayed. Saved chat and prompts stay in the original language.</small>
  </div>
</div>`;

    const container = document.getElementById('extensions_settings') || document.body;
    container.insertAdjacentHTML('beforeend', html);

    const $ = window.jQuery;
    $('#gtd_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked; save();
        if (s.enabled) translateAll(); else restoreAll();
    });
    $('#gtd_user').prop('checked', s.translateUser).on('change', function () {
        s.translateUser = this.checked; save();
        if (s.enabled) translateAll(); else restoreAll();
    });
    $('#gtd_assistant').prop('checked', s.translateAssistant).on('change', function () {
        s.translateAssistant = this.checked; save();
        if (s.enabled) translateAll(); else restoreAll();
    });
    $('#gtd_lang').on('change', function () {
        s.targetLang = this.value; save();
        restoreAll();
        if (s.enabled) translateAll();
    });
}

// ---------- Hooks ----------

jQuery(() => {
    settings();
    buildSettingsPanel();

    const on = (evt, fn) => { if (evt) eventSource.on(evt, fn); };

    on(event_types.CHARACTER_MESSAGE_RENDERED, id => translateById(id));
    on(event_types.USER_MESSAGE_RENDERED, id => translateById(id));
    on(event_types.MESSAGE_UPDATED, id => translateById(id));
    on(event_types.MESSAGE_SWIPED, id => translateById(id));
    on(event_types.CHAT_CHANGED, () => setTimeout(translateAll, 300));
    on(event_types.MORE_MESSAGES_LOADED, () => translateAll());

    if (settings().enabled) setTimeout(translateAll, 500);
});
