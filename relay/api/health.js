const WORKER_HEALTH = process.env.WORKER_HEALTH
  || "https://antoniolga-bot.agoglitch.workers.dev/health";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const response = await fetch(WORKER_HEALTH, {
      method: "GET",
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();

    res.status(response.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
  } catch (error) {
    res.status(502).json({ ok: false, error: "Worker недоступен" });
  }
};
