import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const MODULE = 'hinglish_mode';
const EXT_FOLDER = 'scripts/extensions/third-party/st-hinglish';

const DEFAULTS = {
    enabled: true,
    hindiRatio: 60,      // % of sentences shown in Hindi (rest stay English)
    skipActions: false,  // leave *action text* in English
};

function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    for (const k of Object.keys(DEFAULTS)) {
        if (extension_settings[MODULE][k] === undefined) extension_settings[MODULE][k] = DEFAULTS[k];
    }
    return extension_settings[MODULE];
}

/* ------------------------------------------------------------------ */
/* Devanagari -> Roman (Hinglish spelling)                             */
/* ------------------------------------------------------------------ */

const CONS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
    'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
};
const NUKTA_SOUND = { 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f' };
const INDEPENDENT = {
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
    'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o',
};
const MATRA = {
    'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
    'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o',
};
const SIGNS = { 'ं': 'n', 'ँ': 'n', 'ः': 'h' };
const VIRAMA = '्';
const NUKTA = '़';

function devanagariWordToRoman(word) {
    const chars = [...word];
    const pieces = []; // { t, inherent } — inherent means a silent-able "a" follows
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (CONS[c] !== undefined) {
            let base = CONS[c];
            let j = i + 1;
            if (chars[j] === NUKTA) {
                base = NUKTA_SOUND[c] ?? base;
                j++;
            }
            const nxt = chars[j];
            if (nxt === VIRAMA) {
                pieces.push({ t: base, inherent: false });
                i = j;
            } else if (MATRA[nxt] !== undefined) {
                pieces.push({ t: base + MATRA[nxt], inherent: false });
                i = j;
            } else {
                pieces.push({ t: base, inherent: true });
                i = j - 1;
            }
        } else if (INDEPENDENT[c] !== undefined) {
            pieces.push({ t: INDEPENDENT[c], inherent: false });
        } else if (SIGNS[c] !== undefined) {
            pieces.push({ t: SIGNS[c], inherent: false });
        } else if (MATRA[c] !== undefined) {
            pieces.push({ t: MATRA[c], inherent: false });
        } else {
            pieces.push({ t: c, inherent: false });
        }
    }
    // Inherent "a" is kept mid-word and dropped at the end of a word (नमस्ते -> namaste, मुझे -> mujhe).
    return pieces
        .map((p, idx) => (p.inherent && idx !== pieces.length - 1 ? p.t + 'a' : p.t))
        .join('');
}

function devanagariToRoman(text) {
    return text
        .replace(/[ऀ-ॿ]+/g, devanagariWordToRoman)
        .replace(/।/g, '.');
}

/* ------------------------------------------------------------------ */
/* Google Translate (English -> Hindi, Devanagari)                     */
/* ------------------------------------------------------------------ */

const GTX_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=hi&dt=t';

async function gtxTranslate(text) {
    const res = await fetch(GTX_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'q=' + encodeURIComponent(text),
    });
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const data = await res.json();
    return data[0].map(seg => seg[0]).join('');
}

// Translate many sentences in one request (joined by newlines); fall back to one-by-one if the split breaks.
async function translateBatch(texts) {
    if (texts.length === 0) return [];
    const joined = await gtxTranslate(texts.join('\n'));
    const parts = joined.split('\n');
    if (parts.length === texts.length) return parts.map(s => s.trim());
    const out = [];
    for (const t of texts) out.push((await gtxTranslate(t)).trim());
    return out;
}

/* ------------------------------------------------------------------ */
/* Choosing which sentences to convert                                  */
/* ------------------------------------------------------------------ */

const translationCache = new Map(); // English sentence -> Hinglish sentence

// Stable 0-99 number from a string, so the same sentence gets the same decision on every re-render.
function stableBucket(str) {
    let h = 5381;
    for (const ch of str) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
    return (h >>> 0) % 100;
}

function splitSentences(text) {
    return text.match(/[^.!?\n]+[.!?]*\s*|[.!?\n]+/g) || [];
}

function shouldConvert(core, s) {
    if (!/[A-Za-z]{2,}/.test(core)) return false;      // nothing to translate
    if (/https?:\/\/|[`<>{}\[\]|]/.test(core)) return false; // links, code, markup
    if (core.split(/\s+/).length < 2) return false;     // lone words read oddly when swapped
    return stableBucket(core) < s.hindiRatio;
}

/* ------------------------------------------------------------------ */
/* Applying it to a rendered message                                    */
/* ------------------------------------------------------------------ */

async function processMessage(messageId) {
    const s = settings();
    if (!s.enabled) return;

    const mes = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mes || mes.getAttribute('is_user') === 'true') return;
    const el = mes.querySelector('.mes_text');
    if (!el || el.dataset.hinglish === '1') return;

    try {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const parent = node.parentElement;
            if (!parent || !node.nodeValue.trim()) continue;
            if (parent.closest('code, pre')) continue;
            if (s.skipActions && parent.closest('em, i')) continue;
            nodes.push(node);
        }

        const plan = nodes.map(node => ({
            node,
            sentences: splitSentences(node.nodeValue).map(sent => {
                const m = sent.match(/^(\s*)([\s\S]*?)(\s*)$/);
                return { lead: m[1], core: m[2], trail: m[3], convert: shouldConvert(m[2], s) };
            }),
        }));

        const missing = [...new Set(
            plan.flatMap(p => p.sentences.filter(x => x.convert && !translationCache.has(x.core)).map(x => x.core))
        )];

        if (missing.length) {
            const hindi = await translateBatch(missing);
            missing.forEach((eng, i) => translationCache.set(eng, devanagariToRoman(hindi[i])));
        }

        for (const p of plan) {
            p.node.nodeValue = p.sentences
                .map(x => (x.convert ? x.lead + translationCache.get(x.core) + x.trail : x.lead + x.core + x.trail))
                .join('');
        }
        el.dataset.hinglish = '1';
    } catch (err) {
        console.warn('[Hinglish Mode] could not convert message, showing English:', err);
    }
}

/* ------------------------------------------------------------------ */
/* Settings panel + hooks                                               */
/* ------------------------------------------------------------------ */

async function init() {
    const s = settings();

    // Register the translation hook first, so translation works even if the settings panel fails.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => processMessage(id));

    try {
        const { renderExtensionTemplateAsync } = SillyTavern.getContext();
        const html = await renderExtensionTemplateAsync('third-party/st-hinglish', 'settings');
        const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
        $(target).append(html);

        $('#hinglish_enabled').prop('checked', s.enabled).on('change', function () {
            s.enabled = this.checked;
            saveSettingsDebounced();
        });
        $('#hinglish_ratio').val(s.hindiRatio).on('input', function () {
            s.hindiRatio = Number(this.value);
            $('#hinglish_ratio_label').text(this.value);
            saveSettingsDebounced();
        });
        $('#hinglish_ratio_label').text(s.hindiRatio);
        $('#hinglish_skip_actions').prop('checked', s.skipActions).on('change', function () {
            s.skipActions = this.checked;
            saveSettingsDebounced();
        });
    } catch (err) {
        console.warn('[Hinglish Mode] settings panel not loaded, translation still active:', err);
    }
}

$(function () {
    init().catch(err => console.error('[Hinglish Mode] init failed:', err));
});
