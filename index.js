import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const MODULE = 'hinglish_mode';

const DEFAULTS = {
    enabled: true,
    hindiRatio: 60,      // % of a message's sentences converted to Hinglish
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
    const pieces = []; // { t, inherent }: inherent = a vowel "a" that is dropped at the end of a word
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
/* Formal Hindi (Google's "aap" forms) -> informal Hinglish ("tu")      */
/* ------------------------------------------------------------------ */

const INFORMAL = [
    [/\baapko\b/gi, 'tujhe'],
    [/\baapka\b/gi, 'tera'],
    [/\baapki\b/gi, 'teri'],
    [/\baapke\b/gi, 'tere'],
    [/\baapne\b/gi, 'tune'],
    [/\baapse\b/gi, 'tujhse'],
    [/\baap\b/gi, 'tu'],
    [/\bkaise\b/gi, 'kaisa'],
    [/\bhain\b/gi, 'hai'],
    [/\brahe\b/gi, 'raha'],
    [/\brahi\b/gi, 'rahi'],
    [/\bbataiye\b/gi, 'bata'],
    [/\bbatayein\b/gi, 'bata'],
    [/\bkijiye\b/gi, 'kar'],
    [/\bkariye\b/gi, 'kar'],
    [/\bdijiye\b/gi, 'de'],
    [/\blijiye\b/gi, 'le'],
    [/\bjaiye\b/gi, 'ja'],
    [/\baaiye\b/gi, 'aa'],
];

// Keep a capital letter if the original word had one ("Aap" -> "Tu").
function matchCase(src, rep) {
    return /^[A-Z]/.test(src) ? rep[0].toUpperCase() + rep.slice(1) : rep;
}

function toInformal(text) {
    let out = text;
    for (const [re, rep] of INFORMAL) out = out.replace(re, m => matchCase(m, rep));
    return out;
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

function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Small seeded random generator, so the same message always picks the same sentences.
function seededRandom(seed) {
    let a = seed;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Pick exactly round(count * ratio) indices out of count, at random.
// 10 sentences at 60% -> 6 converted. 3 sentences -> 2 converted.
function pickIndices(count, ratio, seedText) {
    const k = Math.round(count * ratio / 100);
    const rng = seededRandom(hashString(seedText));
    const idx = [...Array(count).keys()];
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return new Set(idx.slice(0, k));
}

function splitSentences(text) {
    return text.match(/[^.!?\n]+[.!?]*\s*|[.!?\n]+/g) || [];
}

// A sentence can be converted if it has at least two real words and no links, code or markup.
function isConvertible(core) {
    if (!/[A-Za-z]{2,}/.test(core)) return false;
    if (/https?:\/\/|[`<>{}\[\]|]/.test(core)) return false;
    if (core.split(/\s+/).length < 2) return false;
    return true;
}

/* ------------------------------------------------------------------ */
/* Applying it to a rendered message                                    */
/* ------------------------------------------------------------------ */

function collectTextNodes(el, s) {
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
    return nodes;
}

async function processMessage(messageId) {
    const s = settings();
    if (!s.enabled) return;

    const mes = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mes || mes.getAttribute('is_user') === 'true') return;
    const el = mes.querySelector('.mes_text');
    if (!el || el.dataset.hinglish === '1') return;

    try {
        const nodes = collectTextNodes(el, s);
        const seedText = nodes.map(n => n.nodeValue).join('\u0000');

        // Split every text node into sentences, noting which ones can be converted.
        const plan = nodes.map(node => ({
            node,
            sentences: splitSentences(node.nodeValue).map(sent => {
                const m = sent.match(/^(\s*)([\s\S]*?)(\s*)$/);
                return { lead: m[1], core: m[2], trail: m[3], convertible: isConvertible(m[2]), convert: false };
            }),
        }));

        // Choose the exact share of this message's convertible sentences.
        const convertible = plan.flatMap(p => p.sentences.filter(x => x.convertible));
        const chosen = pickIndices(convertible.length, s.hindiRatio, seedText);
        convertible.forEach((x, i) => { x.convert = chosen.has(i); });

        const missing = [...new Set(
            plan.flatMap(p => p.sentences.filter(x => x.convert && !translationCache.has(x.core)).map(x => x.core))
        )];

        if (missing.length) {
            const hindi = await translateBatch(missing);
            missing.forEach((eng, i) => translationCache.set(eng, toInformal(devanagariToRoman(hindi[i]))));
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

    // New model replies get converted as they render.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => processMessage(id));

    // When a chat is opened, convert the model messages already on screen.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(async () => {
            for (const mes of document.querySelectorAll('#chat .mes[is_user="false"]')) {
                await processMessage(mes.getAttribute('mesid'));
            }
        }, 500);
    });

    try {
        const html = `
<div class="hinglish-settings inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Hinglish Mode</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label">
            <input id="hinglish_enabled" type="checkbox" />
            <span>Enable Hinglish display</span>
        </label>
        <label>
            Share of sentences in Hindi: <span id="hinglish_ratio_label"></span>%
        </label>
        <input id="hinglish_ratio" type="range" min="0" max="100" step="5" style="width:100%;" />
        <label class="checkbox_label">
            <input id="hinglish_skip_actions" type="checkbox" />
            <span>Leave *action* text in English</span>
        </label>
        <small>
            Only the displayed text changes. Saved messages and the context sent to the model stay in English.
            Uses Google Translate, so message text is sent to Google.
            The share change applies to messages rendered after you change it.
        </small>
    </div>
</div>`;
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
