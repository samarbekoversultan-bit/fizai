// =====================================================================
//  FizAI → Google Gemini: ПОТОКОВЫЙ ответ (Netlify Functions v2).
//
//  Зачем: обычный запрос ждёт, пока Gemini сгенерирует весь ответ.
//  Здесь текст уходит в браузер по мере генерации — «Думает...»
//  сменяется текстом уже через 1–2 секунды.
//
//  Переменные окружения те же, что у chat.js:
//      GEMINI_API_KEY        — ключ из https://aistudio.google.com/apikey
//      GEMINI_MODEL          — необязательно (по умолчанию gemini-3.8-flash)
//      GEMINI_THINKING_BUDGET— 0 = без «размышлений» (быстрее всего)
//      ALLOWED_ORIGIN        — необязательно, защита от чужих доменов
//
//  Если функция недоступна, сайт автоматически вернётся к chat.js.
// =====================================================================

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

const parsedBudget = parseInt(process.env.GEMINI_THINKING_BUDGET, 10);
const THINKING_BUDGET = isNaN(parsedBudget) ? 0 : Math.max(0, parsedBudget);

const MAX_MESSAGES = 20;
const MAX_CONTENT = 8000;
const MAX_TOKENS = 8192;

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff'
};

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)
    });
}

// ===== Сообщения в формате OpenAI → части запроса Gemini =====

function toGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    const parts = [];
    (Array.isArray(content) ? content : []).forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        if (p.type === 'text' && p.text) {
            parts.push({ text: String(p.text) });
        } else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
            const url = String(p.image_url.url);
            const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
            if (m) {
                parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
            } else if (/^https?:\/\//i.test(url)) {
                const clean = url.split('?')[0].toLowerCase();
                const mime = clean.endsWith('.png') ? 'image/png'
                    : clean.endsWith('.webp') ? 'image/webp'
                    : clean.endsWith('.gif') ? 'image/gif'
                    : 'image/jpeg';
                parts.push({ file_data: { file_uri: url, mime_type: mime } });
            }
        }
    });
    return parts;
}

function toGeminiBody(messages, maxTokens, thinkingBudget) {
    const systemParts = [];
    const contents = [];

    messages.forEach(function (m) {
        const role = m.role === 'assistant' ? 'model' : (m.role === 'system' ? 'system' : 'user');
        const parts = toGeminiParts(m.content);
        if (!parts.length) return;
        if (role === 'system') {
            parts.forEach(function (p) { systemParts.push(p); });
            return;
        }
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts = last.parts.concat(parts);
        else contents.push({ role: role, parts: parts });
    });

    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Привет!' }] });
    if (contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: 'Продолжай.' }] });

    const generationConfig = {
        temperature: 0.7,
        maxOutputTokens: maxTokens
    };
    if (thinkingBudget !== null && thinkingBudget !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget };
    }

    const body = { contents: contents, generationConfig: generationConfig };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    return body;
}

function cleanContent(c) {
    if (typeof c === 'string') return c.slice(0, MAX_CONTENT);
    if (Array.isArray(c)) {
        const parts = [];
        c.forEach(function (p) {
            if (!p || typeof p !== 'object') return;
            if (p.type === 'text') {
                parts.push({ type: 'text', text: String(p.text || '').slice(0, MAX_CONTENT) });
            } else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
                const url = String(p.image_url.url);
                if (/^data:image\//i.test(url) || /^https?:\/\//i.test(url)) {
                    parts.push({ type: 'image_url', image_url: { url: url } });
                }
            }
        });
        return parts.length ? parts : '';
    }
    return '';
}

// ===== Запрос к Gemini =====

async function openGeminiStream(messages, maxTokens) {
    const chain = [GEMINI_MODEL].concat(GEMINI_FALLBACKS.filter(function (m) { return m !== GEMINI_MODEL; }));
    let lastError = null;

    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        const budgets = THINKING_BUDGET === null ? [null] : [THINKING_BUDGET, null];

        for (let b = 0; b < budgets.length; b++) {
            const budget = budgets[b];
            try {
                const resp = await fetch(
                    GEMINI_HOST + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': GEMINI_API_KEY
                        },
                        body: JSON.stringify(toGeminiBody(messages, maxTokens, budget)),
                        signal: AbortSignal.timeout(25000)
                    }
                );

                if (resp.ok && resp.body) return resp;

                let raw = '';
                try { raw = await resp.text(); } catch (e) { raw = ''; }
                let data = null;
                try { data = JSON.parse(raw || '{}'); } catch (e) { data = null; }

                lastError = new Error(
                    (data && data.error && data.error.message)
                        ? String(data.error.message)
                        : ('Gemini HTTP ' + resp.status)
                );
                lastError.status = resp.status;

                // thinkingConfig не понят этой моделью — пробуем без него
                if (resp.status === 400 && budget !== null) continue;

                // 429/5xx — пробуем следующую модель; остальные ошибки тоже
                // (например, 404 «модель не найдена») лечатся запасной моделью
                break;
            } catch (e) {
                lastError = e;
                break;
            }
        }
    }

    throw lastError || new Error('Gemini недоступен');
}

// ===== SSE от Gemini → простой текстовый поток для браузера =====

function sseToText(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();
    let buffer = '';
    let emitted = 0;

    return new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    buffer += decoder.decode(chunk.value, { stream: true });

                    let nl;
                    while ((nl = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
                        buffer = buffer.slice(nl + 1);
                        if (!line || line.indexOf('data:') !== 0) continue;

                        const payload = line.slice(5).trim();
                        if (!payload || payload === '[DONE]') continue;

                        let obj = null;
                        try { obj = JSON.parse(payload); } catch (e) { continue; }

                        const cand = obj && obj.candidates && obj.candidates[0];
                        const parts = (cand && cand.content && cand.content.parts) || [];
                        const text = parts
                            .map(function (p) { return (p && typeof p.text === 'string') ? p.text : ''; })
                            .join('');

                        if (text) {
                            emitted += text.length;
                            controller.enqueue(encoder.encode(text));
                        }
                    }
                }

                if (!emitted) {
                    controller.enqueue(encoder.encode(
                        'Не удалось получить ответ от ИИ. Попробуйте переформулировать вопрос.'
                    ));
                }
                controller.close();
            } catch (e) {
                try { controller.error(e); } catch (e2) { /* поток уже закрыт */ }
            }
        },
        cancel() {
            try { reader.cancel(); } catch (e) { /* игнорируем */ }
        }
    });
}

// ===== Обработчик (Netlify Functions v2) =====

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    // Проверка доступности функции (удобно после деплоя)
    if (req.method === 'GET') {
        return json(200, {
            ok: true,
            status: 'stream function deployed',
            provider: GEMINI_API_KEY ? 'gemini' : 'none',
            model: GEMINI_MODEL,
            thinkingBudget: THINKING_BUDGET
        });
    }

    if (req.method !== 'POST') {
        return json(405, { error: { message: 'Разрешены только POST-запросы' } });
    }

    if (!GEMINI_API_KEY) {
        return json(500, {
            error: { message: 'На сервере не задан GEMINI_API_KEY (Site configuration → Environment variables)' }
        });
    }

    // Защита от чужих доменов
    const allowedOrigin = (process.env.ALLOWED_ORIGIN || '').trim();
    if (allowedOrigin) {
        const origin = req.headers.get('origin') || req.headers.get('referer') || '';
        if (origin.indexOf(allowedOrigin) !== 0) {
            return json(403, { error: { message: 'Запрос с чужого домена запрещён' } });
        }
    }

    let payload = null;
    try { payload = await req.json(); } catch (e) { payload = null; }
    if (!payload) return json(400, { error: { message: 'Некорректный JSON' } });

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const cleaned = messages
        .slice(-MAX_MESSAGES)
        .map(function (m) {
            const content = cleanContent(m && m.content);
            return {
                role: ['system', 'user', 'assistant'].indexOf(String(m && m.role)) !== -1 ? String(m.role) : 'user',
                content: content
            };
        })
        .filter(function (m) {
            if (typeof m.content === 'string') return m.content.length > 0;
            return Array.isArray(m.content) && m.content.length > 0;
        });

    if (!cleaned.length) {
        return json(400, { error: { message: 'Пустой список сообщений' } });
    }

    const requested = parseInt(payload.max_tokens, 10);
    const maxTokens = Math.min(Math.max(isNaN(requested) ? 4096 : requested, 1), MAX_TOKENS);

    let upstream;
    try {
        upstream = await openGeminiStream(cleaned, maxTokens);
    } catch (e) {
        const status = (e && e.status && e.status >= 400 && e.status < 600) ? e.status : 502;
        return json(status, {
            error: { message: (e && e.message) ? e.message : 'ИИ временно недоступен' }
        });
    }

    return new Response(sseToText(upstream.body), {
        status: 200,
        headers: Object.assign({
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no'
        }, CORS)
    });
}