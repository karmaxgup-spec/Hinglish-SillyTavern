import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const MODULE = 'st_outgoing_translate';
const TARGET_LANG = 'en';
const SOURCE_LANG = 'auto';
const EXTRA_KEY = 'outgoing_translation';

const cache = new Map();

async function translateText(text) {
    if (!text || !text.trim()) return text;
    const key = `${SOURCE_LANG}|${TARGET_LANG}|${text}`;
    if (cache.has(key)) return cache.get(key);

    const url = 'https://translate.googleapis.com/translate_a/single'
        + `?client=gtx&sl=${SOURCE_LANG}&tl=${TARGET_LANG}&dt=t&q=${encodeURIComponent(text)}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const translated = data[0].map(seg => seg[0]).join('');
        cache.set(key, translated);
        return translated;
    } catch (err) {
        console.error(`[${MODULE}] translation failed, using original`, err);
        return text;
    }
}

// Translate the user's message as soon as it's sent. The result is stored in
// msg.extra, never in msg.mes, so the displayed text is never changed.
eventSource.on(event_types.MESSAGE_SENT, async (index) => {
    const { chat } = getContext();
    const msg = chat[index];
    if (!msg || !msg.is_user) return;
    msg.extra = msg.extra || {};
    msg.extra[EXTRA_KEY] = await translateText(msg.mes);
});

// Runs right before the prompt is built. Swaps in the translation on copies only.
globalThis.outgoingTranslateInterceptor = async function (chat, contextSize, abort, type) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || !msg.is_user) continue;

        // Use the stored translation if it exists, otherwise translate now.
        const translated = msg.extra?.[EXTRA_KEY] ?? await translateText(msg.mes);
        chat[i] = { ...msg, mes: translated };
        break;
    }
};
