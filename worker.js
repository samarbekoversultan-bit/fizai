// =====================================================================
//  FizAI → Google Gemini на Cloudflare Workers.
//  Заменяет netlify/functions/chat.js и chat-stream.mjs.
//  Адреса остались прежними, поэтому index.html менять не нужно:
//      /.netlify/functions/chat         — обычный ответ (JSON)
//      /.netlify/functions/chat-stream  — потоковый ответ (текст)
//
//  Настройка: Workers & Pages → fizai → Settings → Variables and Secrets
//      GEMINI_API_KEY         (Secret)   — ключ из https://aistudio.google.com/apikey
//      GEMINI_MODEL           (по желанию)
//      GEMINI_THINKING_BUDGET (по желанию, 0 = без «размышлений»)
//      ALLOWED_ORIGIN         (по желанию, например https://fizai.<ваш-субдомен>.workers.dev)
//      GROQ_API_KEY           (по желанию, резерв для /chat)
// =====================================================================

const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];

const MAX_MESSAGES = 20;
const MAX_CONTENT = 8000;
const MAX_TOKENS = 65536;
const GEMINI_MAX_TOKENS = 8192;

const GROQ_MODELS = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff'
};

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)
    });
}

function readConfig(env) {
    const budget = parseInt(env.GEMINI_THINKING_BUDGET, 10);
    return {
        geminiKey: String(env.GEMINI_API_KEY || '').trim(),
        groqKey: String(env.GROQ_API_KEY || '').trim(),
        model: String(env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
        thinkingBudget: isNaN(budget) ? 0 : Math.max(0, budget),
        allowedOrigin: String(env.ALLOWED_ORIGIN || '').trim()
    };
}

// ===== Подготовка сообщений (формат OpenAI → Gemini) =====

function cleanContent(c) {
    if (typeof c === 'string') return c.slice(0, MAX_CONTENT);
    if (Array.isArray(c)) {
        const parts = [];
        c.forEach(function (p) {
            if (!p || typeof p !== 'object') return;
            if (p.type === 'text') {
                parts.push({ type: 'text', text: String(p.text || '').slice(0, MAX_CONTENT) });
            }
        });
        return parts.length ? parts : '';
    }
    return '';
}

function cleanMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .slice(-MAX_MESSAGES)
        .map(function (m) {
            return {
                role: ['system', 'user', 'assistant'].indexOf(String(m && m.role)) !== -1 ? String(m.role) : 'user',
                content: cleanContent(m && m.content)
            };
        })
        .filter(function (m) {
            if (typeof m.content === 'string') return m.content.length > 0;
            return Array.isArray(m.content) && m.content.length > 0;
        });
}

function toGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    const parts = [];
    (Array.isArray(content) ? content : []).forEach(function (p) {
        if (p && p.type === 'text' && p.text) parts.push({ text: String(p.text) });
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
        // Gemini требует чередования ролей — склеиваем подряд идущие одинаковые
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts = last.parts.concat(parts);
        else contents.push({ role: role, parts: parts });
    });

    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Привет!' }] });
    if (contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: 'Продолжай.' }] });

    const generationConfig = { temperature: 0.7, maxOutputTokens: maxTokens };
    if (thinkingBudget !== null && thinkingBudget !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget };
    }

    const body = { contents: contents, generationConfig: generationConfig };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    return body;
}

function modelChain(cfg) {
    return [cfg.model].concat(GEMINI_FALLBACKS.filter(function (m) { return m !== cfg.model; }));
}

function checkOrigin(req, cfg) {
    if (!cfg.allowedOrigin) return true;
    const origin = req.headers.get('origin') || req.headers.get('referer') || '';
    return origin.indexOf(cfg.allowedOrigin) === 0;
}

async function readPayload(req) {
    try { return await req.json(); } catch (e) { return null; }
}

function errorFrom(data, fallback, status) {
    const err = new Error((data && data.error && data.error.message) ? String(data.error.message) : fallback);
    err.status = status;
    return err;
}

// ===== /chat — обычный ответ =====

async function geminiOnce(cfg, model, messages, maxTokens, budget) {
    return fetch(
        GEMINI_HOST + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
            body: JSON.stringify(toGeminiBody(messages, maxTokens, budget)),
            signal: AbortSignal.timeout(25000)
        }
    );
}

async function callGemini(cfg, model, messages, maxTokens) {
    let resp = await geminiOnce(cfg, model, messages, maxTokens, cfg.thinkingBudget);
    // Не все модели понимают thinkingConfig — при 400 повторяем без него
    if (resp.status === 400) resp = await geminiOnce(cfg, model, messages, maxTokens, null);

    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }

    if (!resp.ok) {
        const err = errorFrom(data, 'Gemini HTTP ' + resp.status, resp.status);
        err.retryable = resp.status === 429 || resp.status >= 500;
        throw err;
    }

    const cand = (data && data.candidates && data.candidates[0]) || null;
    const text = ((cand && cand.content && cand.content.parts) || [])
        .map(function (p) { return p && p.text ? p.text : ''; })
        .join('')
        .trim();

    if (!text) {
        const reason = (cand && cand.finishReason) ||
            (data && data.promptFeedback && data.promptFeedback.blockReason) ||
            'пустой ответ';
        const err = new Error(
            String(reason).indexOf('SAFETY') === 0
                ? 'Gemini отклонил запрос фильтром безопасности (' + reason + ')'
                : 'Gemini вернул пустой ответ (' + reason + ')'
        );
        err.status = 502;
        err.retryable = reason === 'RECITATION' || reason === 'OTHER';
        throw err;
    }
    return text;
}

function openAiLike(text, model, provider) {
    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        provider: provider,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
    };
}

async function handleChat(req, env) {
    const cfg = readConfig(env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'GET') {
        return json(200, {
            ok: true,
            status: 'function deployed',
            provider: cfg.geminiKey ? 'gemini' : (cfg.groqKey ? 'groq' : 'none'),
            model: cfg.geminiKey ? cfg.model : null
        });
    }
    if (req.method !== 'POST') return json(405, { error: { message: 'Разрешены только POST-запросы' } });

    if (!cfg.geminiKey && !cfg.groqKey) {
        return json(500, { error: { message: 'На сервере не задан GEMINI_API_KEY (Settings → Variables and Secrets)' } });
    }
    if (!checkOrigin(req, cfg)) return json(403, { error: { message: 'Запрос с чужого домена запрещён' } });

    const payload = await readPayload(req);
    if (!payload) return json(400, { error: { message: 'Некорректный JSON' } });

    const cleaned = cleanMessages(payload.messages);
    if (!cleaned.length) return json(400, { error: { message: 'Пустой список сообщений' } });

    const requested = parseInt(payload.max_tokens, 10);
    const maxTokens = Math.min(Math.max(isNaN(requested) ? 2048 : requested, 1), MAX_TOKENS);

    let lastError = null;

    if (cfg.geminiKey) {
        const chain = modelChain(cfg);
        for (let i = 0; i < chain.length; i++) {
            try {
                const text = await callGemini(cfg, chain[i], cleaned, Math.min(maxTokens, GEMINI_MAX_TOKENS));
                return json(200, openAiLike(text, chain[i], 'gemini'));
            } catch (e) {
                lastError = e;
                if (e && e.status === 404) continue;     // модель не найдена — следующая
                if (!e || !e.retryable) break;           // не временная ошибка — перебор не поможет
            }
        }
    }

    // Резерв: Groq (если задан GROQ_API_KEY)
    if (cfg.groqKey) {
        const groqModel = GROQ_MODELS.indexOf(String(payload.model)) !== -1 ? String(payload.model) : GROQ_MODELS[0];
        try {
            const r = await fetch(GROQ_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.groqKey },
                body: JSON.stringify({ model: groqModel, messages: cleaned, max_tokens: maxTokens }),
                signal: AbortSignal.timeout(25000)
            });
            const raw = await r.text();
            if (r.ok) {
                return new Response(raw, {
                    status: r.status,
                    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)
                });
            }
            let gData = null;
            try { gData = JSON.parse(raw || '{}'); } catch (e) { gData = null; }
            lastError = errorFrom(gData, 'Groq HTTP ' + r.status, r.status);
        } catch (e) {
            lastError = e;
        }
    }

    const status = lastError && lastError.status ? lastError.status : 502;
    return json(status, { error: { message: lastError && lastError.message ? lastError.message : 'ИИ временно недоступен' } });
}

// ===== /chat-stream — потоковый ответ =====

async function openGeminiStream(cfg, messages, maxTokens) {
    const chain = modelChain(cfg);
    let lastError = null;

    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        const budgets = [cfg.thinkingBudget, null];

        for (let b = 0; b < budgets.length; b++) {
            const budget = budgets[b];
            try {
                const resp = await fetch(
                    GEMINI_HOST + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
                        body: JSON.stringify(toGeminiBody(messages, maxTokens, budget)),
                        signal: AbortSignal.timeout(25000)
                    }
                );

                if (resp.ok && resp.body) return resp;

                let data = null;
                try { data = JSON.parse((await resp.text()) || '{}'); } catch (e) { data = null; }
                lastError = errorFrom(data, 'Gemini HTTP ' + resp.status, resp.status);

                // thinkingConfig не понят этой моделью — пробуем без него
                if (resp.status === 400 && budget !== null) continue;
                // Модель не найдена или временная ошибка — следующая модель
                if (resp.status === 404 || resp.status === 429 || resp.status >= 500) break;
                // 400, 401, 403 — перебор не поможет
                throw lastError;
            } catch (e) {
                lastError = e;
                if (e && e.status && e.status !== 404 && e.status !== 429 && e.status < 500) throw e;
                break;
            }
        }
    }
    throw lastError || new Error('Gemini недоступен');
}

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
                    controller.enqueue(encoder.encode('Не удалось получить ответ от ИИ. Попробуйте переформулировать вопрос.'));
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

async function handleStream(req, env) {
    const cfg = readConfig(env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'GET') {
        return json(200, {
            ok: true,
            status: 'stream function deployed',
            provider: cfg.geminiKey ? 'gemini' : 'none',
            model: cfg.model,
            thinkingBudget: cfg.thinkingBudget
        });
    }
    if (req.method !== 'POST') return json(405, { error: { message: 'Разрешены только POST-запросы' } });

    if (!cfg.geminiKey) {
        return json(500, { error: { message: 'На сервере не задан GEMINI_API_KEY (Settings → Variables and Secrets)' } });
    }
    if (!checkOrigin(req, cfg)) return json(403, { error: { message: 'Запрос с чужого домена запрещён' } });

    const payload = await readPayload(req);
    if (!payload) return json(400, { error: { message: 'Некорректный JSON' } });

    const cleaned = cleanMessages(payload.messages);
    if (!cleaned.length) return json(400, { error: { message: 'Пустой список сообщений' } });

    const requested = parseInt(payload.max_tokens, 10);
    const maxTokens = Math.min(Math.max(isNaN(requested) ? 2048 : requested, 1), GEMINI_MAX_TOKENS);

    let upstream;
    try {
        upstream = await openGeminiStream(cfg, cleaned, maxTokens);
    } catch (e) {
        const status = (e && e.status && e.status >= 400 && e.status < 600) ? e.status : 502;
        return json(status, { error: { message: (e && e.message) ? e.message : 'ИИ временно недоступен' } });
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

// ===== Точка входа =====

export default {
    async fetch(req, env) {
        const path = new URL(req.url).pathname.replace(/\/+$/, '');

        if (path === '/.netlify/functions/chat') return handleChat(req, env);
        if (path === '/.netlify/functions/chat-stream') return handleStream(req, env);

        // Всё остальное — статические файлы сайта
        return env.ASSETS.fetch(req);
    }
};
