const MODULE = 'st_outgoing_translate';
const TARGET_LANG = 'en';   // change to your target language
const SOURCE_LANG = 'auto';

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
        console.error(`[${MODULE}] translation failed, sending original`, err);
        return text; // fall back to the original message
    }
}

// Called by SillyTavern right before the prompt is built.
// `chat` is the array of messages going into the payload.
globalThis.outgoingTranslateInterceptor = async function (chat, contextSize, abort, type) {
    // Only translate the most recent user message that's in the payload.
    // Translating every user message on every generation would be slow and wasteful.
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && msg.is_user) {
            // Replace the entry with a copy so the on-screen message object is untouched.
            chat[i] = { ...msg, mes: await translateText(msg.mes) };
            break;
        }
    }
};
