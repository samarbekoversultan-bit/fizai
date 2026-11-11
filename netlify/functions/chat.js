// =====================================================================
//  Серверный прокси FizAI → Groq
//  Ключ API хранится в переменной окружения Netlify и в коде не записан.
//  Настройка: Site configuration → Environment variables → GROQ_API_KEY
//  (укажите ваш ключ Groq, например gsk_...)
//
//  Браузер обращается к /.netlify/functions/chat, ключ посетителям не виден.
// =====================================================================

const https = require('https');

// Ключ берётся из переменной окружения — его нет ни в HTML, ни в этом файле
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();

// Модели, которые разрешено вызывать через этот прокси
const ALLOWED_MODELS = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

// Ограничения, чтобы сайтом не пользовались как бесплатным ИИ-прокси
const MAX_MESSAGES = 20;
const MAX_CONTENT = 8000;   // символов в одном сообщении
const MAX_TOKENS = 65536;

// У vision-модели свой потолок генерации — больше Groq возвращает ошибку
const MODEL_MAX_TOKENS = {
    'qwen/qwen3.8-27b': 16384
};

const GROQ_HOST = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

function send(statusCode, bodyObject) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'X-Content-Type-Options': 'nosniff'
        },
        body: typeof bodyObject === 'string' ? bodyObject : JSON.stringify(bodyObject)
    };
}

// Запрос к Groq через встроенный модуль https (без сторонних зависимостей)
function callGroq(payload) {
    return new Promise(function (resolve, reject) {
        const data = Buffer.from(JSON.stringify(payload), 'utf8');
        const req = https.request({
            hostname: GROQ_HOST,
            path: GROQ_PATH,
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + String(GROQ_API_KEY).trim(),
                'Content-Type': 'application/json',
                'Content-Length': data.length
            },
            timeout: 60000
        }, function (res) {
            let raw = '';
            res.on('data', function (chunk) { raw += chunk; });
            res.on('end', function () { resolve({ status: res.statusCode, body: raw }); });
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('Groq не ответил за 60 секунд')); });
        req.write(data);
        req.end();
    });
}

exports.handler = async function (event) {
    // Предварительный запрос (CORS)
    if (event.httpMethod === 'OPTIONS') return send(204, '');
    // Проверка доступности функции (GET) — удобно для диагностики деплоя
    if (event.httpMethod === 'GET') return send(200, { ok: true, status: 'function deployed' });
    if (event.httpMethod !== 'POST') {
        return send(405, { error: { message: 'Разрешены только POST-запросы' } });
    }

    // Проверка: ключ должен быть задан в настройках Netlify
    if (!GROQ_API_KEY) {
        return send(500, { error: { message: 'На сервере не задана переменная окружения GROQ_API_KEY' } });
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

    const model = String(payload.model || '');
    if (ALLOWED_MODELS.indexOf(model) === -1) {
        return send(400, { error: { message: 'Модель не разрешена: ' + model } });
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    function cleanContent(c) {
        // Текстовое сообщение
        if (typeof c === 'string') {
            return c.slice(0, MAX_CONTENT);
        }
        // Мультимодальное сообщение (текст + изображения)
        if (Array.isArray(c)) {
            const parts = [];
            c.forEach(function (p) {
                if (!p || typeof p !== 'object') return;
                if (p.type === 'text') {
                    parts.push({ type: 'text', text: String(p.text || '').slice(0, MAX_CONTENT) });
                } else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
                    const url = String(p.image_url.url);
                    // Разрешаем data: URL картинок и обычные https-ссылки
                    if (/^data:image\//i.test(url) || /^https?:\/\//i.test(url)) {
                        parts.push({ type: 'image_url', image_url: { url: url } });
                    }
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
    let maxTokens = Math.min(Math.max(isNaN(requested) ? 4096 : requested, 1), MAX_TOKENS);
    const modelCap = MODEL_MAX_TOKENS[model];
    if (modelCap) maxTokens = Math.min(maxTokens, modelCap);

    // --- Обращение к Groq: ответ отдаём в том же формате, что и у Groq ---
    try {
        const r = await callGroq({ model: model, messages: cleaned, max_tokens: maxTokens });
        return {
            statusCode: r.status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'X-Content-Type-Options': 'nosniff'
            },
            body: r.body
        };
    } catch (e) {
        return send(502, { error: { message: 'Не удалось связаться с ИИ: ' + (e && e.message ? e.message : e) } });
    }
};
