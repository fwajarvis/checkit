// Rate limiter — Vercel serverless'ta instance'lar arası paylaşılamaz.
// Bu "best-effort" koruması sağlar: aynı instance'a gelen istekleri sınırlar.
// Güçlü rate limiting için Vercel KV veya Upstash Redis gerekir (ileride eklenebilir).
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const record = rateLimitMap.get(key) || { minute: [] };
  record.minute = record.minute.filter(t => now - t < 60_000);
  if (record.minute.length >= 5) return { blocked: true, reason: 'Çok fazla istek gönderildi. Lütfen bekleyin.' };
  record.minute.push(now);
  rateLimitMap.set(key, record);
  return { blocked: false };
}

// Basit yanıt cache — tek mesajlık sorgular için (görsel içermeyenler)
const responseCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 saat

function getCacheKey(messages) {
  // Sadece tek mesajlık, görselsiz sorgular cache'lenir
  if (messages.length !== 1) return null;
  const msg = messages[0];
  if (typeof msg.content !== 'string') return null;
  return msg.content.trim().toLowerCase().slice(0, 200);
}

function getCache(key) {
  if (!key) return null;
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { responseCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  if (!key) return;
  if (responseCache.size > 500) {
    // En eski 100 kaydı temizle
    const keys = [...responseCache.keys()].slice(0, 100);
    keys.forEach(k => responseCache.delete(k));
  }
  responseCache.set(key, { data, ts: Date.now() });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit kontrolü
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
  const limit = checkRateLimit(ip);
  if (limit.blocked) {
    return res.status(429).json({ error: limit.reason });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { messages, system, max_tokens } = req.body;

  // Input validasyonu
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Geçersiz istek' });
  }

  // Son mesajı kontrol et — çok kısa veya boşsa reddet
  const lastMsg = messages[messages.length - 1];
  const lastText = typeof lastMsg?.content === 'string'
    ? lastMsg.content
    : lastMsg?.content?.find(c => c.type === 'text')?.text || '';

  if (lastText.trim().length < 2 && !lastMsg?.content?.some?.(c => c.type === 'image')) {
    return res.status(400).json({ error: 'Mesaj çok kısa' });
  }

  // Mesaj sayısını limitle — max 12 mesaj geçmişe izin ver
  const trimmedMessages = messages.slice(-12);

  // Cache kontrolü
  const cacheKey = getCacheKey(trimmedMessages);
  const cached = getCache(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: Math.min(max_tokens || 600, 600), // max 600 token — yeterli ve ucuz
        system,
        messages: trimmedMessages
      })
    });

    const data = await response.json();
    setCache(cacheKey, data);
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Bağlantı hatası. Acil durumda 155\'i arayın.' });
  }
}
