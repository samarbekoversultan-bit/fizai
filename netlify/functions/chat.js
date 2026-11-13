// =====================================================================
//  Серверный прокси FizAI → Google Gemini (резерв: Groq)
//  Ключ API хранится в переменных окружения Netlify, в коде его нет.
//
//  Настройка: Site configuration → Environment variables →
//      GEMINI_API_KEY = ключ из https://aistudio.google.com/apikey
//      GEMINI_MODEL   = gemini-3.8-flash   (необязательно)
//  Если GEMINI_API_KEY не задан, но задан GROQ_API_KEY — работает Groq.
//
//  Браузер обращается к /.netlify/functions/chat, ключ посетителям не виден.
// =====================================================================

const https = require('https');

// Одно TLS-соединение на несколько запросов — экономит ~100–200 мс на каждом
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();

// Основная модель Gemini + запасные: у Gemini бывают ответы 503 «high demand»
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

// «Размышления» Gemini — главная причина долгого ожидания.
// 0 = отвечать сразу, без скрытых рассуждений (можно изменить в Netlify:
// GEMINI_THINKING_BUDGET = 0).
const GEMINI_THINKING_BUDGET = (function () {
    const n = parseInt(process.env.GEMINI_THINKING_BUDGET, 10);
    return isNaN(n) ? 0 : Math.max(0, n);
})();

// Ограничения, чтобы сайтом не пользовались как бесплатным ИИ-прокси
const MAX_MESSAGES = 20;
const MAX_CONTENT = 8000;   // символов в одном сообщении
const MAX_TOKENS = 65536;
const GEMINI_MAX_TOKENS = 8192;  // столько хватает для ответа в чате, и lite-модели не ругаются

// У vision-модели Groq свой потолок генерации
const MODEL_MAX_TOKENS = {
    'qwen/qwen3.8-27b': 16384
};

const GROQ_MODELS = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GROQ_HOST = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

const CORS_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff'
};

function send(statusCode, bodyObject) {
    return {
        statusCode: statusCode,
        headers: CORS_HEADERS,
        body: typeof bodyObject === 'string' ? bodyObject : JSON.stringify(bodyObject)
    };
}

// Универсальный POST через встроенный https (без сторонних зависимостей)
function postJson(hostname, path, headers, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
        const data = Buffer.from(JSON.stringify(payload), 'utf8');
        const req = https.request({
            hostname: hostname,
            path: path,
            method: 'POST',
            agent: httpsAgent,
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }, headers),
            timeout: timeoutMs || 25000
        }, function (res) {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { raw += chunk; });
            res.on('end', function () { resolve({ status: res.statusCode, body: raw }); });
        });
        req.on('error', function (e) {
            if (e) e.retryable = true;
            reject(e);
        });
        req.on('timeout', function () {
            const e = new Error('ИИ не ответил вовремя');
            e.retryable = true;
            req.destroy(e);
        });
        req.write(data);
        req.end();
    });
}

// ===== Gemini =====

function guessMime(url) {
    const clean = String(url).split('?')[0].toLowerCase();
    if (clean.endsWith('.png')) return 'image/png';
    if (clean.endsWith('.webp')) return 'image/webp';
    if (clean.endsWith('.gif')) return 'image/gif';
    if (clean.endsWith('.heic')) return 'image/heic';
    return 'image/jpeg';
}

// Сообщения в формате OpenAI → части запроса Gemini
function toGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    const parts = [];
    (Array.isArray(content) ? content : []).forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        if (p.type === 'text' && p.text) {
            parts.push({ text: String(p.text) });
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
        // Gemini требует чередования ролей — склеиваем подряд идущие одинаковые
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
    // Отключённые «размышления» ускоряют ответ в несколько раз
    if (thinkingBudget !== null && thinkingBudget !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget };
    }

    const body = {
        contents: contents,
        generationConfig: generationConfig
    };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    return body;
}

function callGeminiOnce(model, messages, maxTokens, thinkingBudget) {
    return postJson(
        GEMINI_HOST,
        '/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        { 'x-goog-api-key': GEMINI_API_KEY },
        toGeminiBody(messages, maxTokens, thinkingBudget)
    );
}

async function callGemini(model, messages, maxTokens) {
    let r = await callGeminiOnce(model, messages, maxTokens, GEMINI_THINKING_BUDGET);

    // Не все модели понимают thinkingConfig — если 400, повторяем без него
    if (r.status === 400) {
        r = await callGeminiOnce(model, messages, maxTokens, null);
    }

    let data = null;
    try { data = JSON.parse(r.body || '{}'); } catch (e) { data = null; }

    if (r.status < 200 || r.status >= 300) {
        const msg = (data && data.error && data.error.message) ? String(data.error.message) : ('Gemini HTTP ' + r.status);
        const err = new Error(msg);
        err.status = r.status;
        // 429/5xx — временные, имеет смысл пробовать следующую модель
        err.retryable = r.status === 429 || r.status >= 500;
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

// ===== Groq (резерв) =====

function callGroq(payload) {
    return postJson(
        GROQ_HOST,
        GROQ_PATH,
        { 'Authorization': 'Bearer ' + GROQ_API_KEY },
        payload
    );
}

// ===== Ответ в формате, который ждёт сайт (OpenAI-совместимый) =====

function openAiLike(text, model, provider) {
    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        provider: provider,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
        }]
    };
}

exports.handler = async function (event) {
    // Предварительный запрос (CORS)
    if (event.httpMethod === 'OPTIONS') return send(204, '');

    // Проверка доступности функции (GET) — удобно для диагностики деплоя
    if (event.httpMethod === 'GET') {
        return send(200, {
            ok: true,
            status: 'function deployed',
            provider: GEMINI_API_KEY ? 'gemini' : (GROQ_API_KEY ? 'groq' : 'none'),
            model: GEMINI_API_KEY ? GEMINI_MODEL : null
        });
    }

    if (event.httpMethod !== 'POST') {
        return send(405, { error: { message: 'Разрешены только POST-запросы' } });
    }

    if (!GEMINI_API_KEY && !GROQ_API_KEY) {
        return send(500, {
            error: { message: 'На сервере не задан GEMINI_API_KEY (Site configuration → Environment variables)' }
        });
    }

    // --- Защита от чужих доменов: разрешаем только ваш сайт ---
    const allowedOrigin = (process.env.ALLOWED_ORIGIN || '').trim();
    if (allowedOrigin) {
        const origin = event.headers.origin || event.headers.referer || '';
        if (origin.indexOf(allowedOrigin) !== 0) {
            return send(403, { error: { message: 'Запрос с чужого домена запрещён' } });
        }
    }

    // --- Разбор и проверка тела запроса ---
    let rawBody = event.body || '';
    if (event.isBase64Encoded) {
        try { rawBody = Buffer.from(rawBody, 'base64').toString('utf8'); } catch (e) { rawBody = ''; }
    }
    let payload;
    try {
        payload = JSON.parse(rawBody || '{}');
    } catch (e) {
        return send(400, { error: { message: 'Некорректный JSON' } });
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];

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
        return send(400, { error: { message: 'Пустой список сообщений' } });
    }

    const requested = parseInt(payload.max_tokens, 10);
    let maxTokens = Math.min(Math.max(isNaN(requested) ? 2048 : requested, 1), MAX_TOKENS);

    // --- Основной путь: Gemini (с перебором моделей) ---
    let lastError = null;

    if (GEMINI_API_KEY) {
        const chain = [GEMINI_MODEL].concat(GEMINI_FALLBACKS.filter(function (m) { return m !== GEMINI_MODEL; }));
        for (let i = 0; i < chain.length; i++) {
            try {
                const text = await callGemini(chain[i], cleaned, Math.min(maxTokens, GEMINI_MAX_TOKENS));
                return send(200, openAiLike(text, chain[i], 'gemini'));
            } catch (e) {
                lastError = e;
                if (!e || !e.retryable) break;   // ошибка не временная — перебор не поможет
            }
        }
    }

    // --- Резерв: Groq (если ключ ещё не удалён из Netlify) ---
    if (GROQ_API_KEY) {
        let groqModel = GROQ_MODELS.indexOf(String(payload.model)) !== -1
            ? String(payload.model)
            : GROQ_MODELS[0];

        let groqMax = maxTokens;

        try {
            const r = await callGroq({ model: groqModel, messages: cleaned, max_tokens: groqMax });
            if (r.status >= 200 && r.status < 300) {
                return { statusCode: r.status, headers: CORS_HEADERS, body: r.body };
            }
            let gData = null;
            try { gData = JSON.parse(r.body || '{}'); } catch (e) { gData = null; }
            lastError = new Error((gData && gData.error && gData.error.message) || ('Groq HTTP ' + r.status));
            lastError.status = r.status;
        } catch (e) {
            lastError = e;
        }
    }

    const status = lastError && lastError.status ? lastError.status : 502;
    return send(status, {
        error: { message: lastError && lastError.message ? lastError.message : 'ИИ временно недоступен' }
    });
};
