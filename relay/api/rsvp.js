const WORKER_URL = process.env.WORKER_URL
  || "https://antoniolga-bot.agoglitch.workers.dev/api/rsvp";

const ALLOWED_ORIGINS = new Set([
  "https://antoniolga.ru",
  "https://www.antoniolga.ru"
]);

const LOCAL_ORIGIN = /^http:\/\/localhost(:\d+)?$/;

const resolveOrigin = (origin) => {
  if (!origin) return "https://antoniolga.ru";
  if (ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin)) return origin;
  return null;
};

const applyOrigin = (res, origin) => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
};

const readPayload = (body) => {
  if (!body) return null;
  if (typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (error) {
      return null;
    }
  }
  return null;
};

module.exports = async (req, res) => {
  const origin = resolveOrigin(req.headers.origin || "");

  if (req.method === "OPTIONS") {
    applyOrigin(res, origin || "https://antoniolga.ru");
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    applyOrigin(res, origin || "https://antoniolga.ru");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!origin) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return;
  }

  const payload = readPayload(req.body);

  if (!payload || typeof payload !== "object") {
    applyOrigin(res, origin);
    res.status(400).json({ ok: false, error: "Некорректный запрос" });
    return;
  }

  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    const text = await response.text();

    applyOrigin(res, origin);
    res.status(response.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(text);
  } catch (error) {
    console.error("Relay request failed", error);
    applyOrigin(res, origin);
    res.status(502).json({ ok: false, error: "Сервер временно недоступен" });
  }
};
