const TELEGRAM_API = "https://api.telegram.org/bot";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        db: Boolean(env.DB),
        bot: Boolean(env.BOT_TOKEN),
        contestCode: Boolean(env.CONTEST_CODE)
      }, 200, corsHeaders(request, env));
    }

    if (url.pathname === "/api/rsvp" && request.method === "POST") {
      return handleRsvp(request, env);
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      return handleSetup(request, env);
    }

    if (url.pathname === "/admin/ping" && request.method === "POST") {
      return handlePing(request, env);
    }

    if (url.pathname === "/admin/backup" && request.method === "POST") {
      return handleAdminBackup(request, env);
    }

    if (url.pathname === "/admin/uptime" && request.method === "POST") {
      return handleAdminUptime(request, env);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegram(request, env);
    }

    return json({ ok: false, error: "Not found" }, 404, corsHeaders(request, env));
  },

  async scheduled(event, env, ctx) {
    const job = String(event.cron || "");

    ctx.waitUntil((async () => {
      try {
        if (job === "0 4 * * *") {
          await sendDailyBackup(env);
        } else {
          await checkUptime(env);
        }
      } catch (error) {
        console.error("Scheduled job failed", job, error);
      }
    })());
  }
};

/* ---------- helpers ---------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.SITE_ORIGIN || "*";
  const isLocal = /^http:\/\/localhost(:\d+)?$/.test(origin);
  const allowOrigin = allowed === "*"
    ? "*"
    : (origin === allowed || isLocal ? origin : allowed);

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function normalizeCode(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function adminIds(env) {
  return String(env.ADMIN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAdmin(env, userId) {
  return adminIds(env).includes(String(userId || ""));
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Asia/Yekaterinburg"
    }).format(new Date(iso));
  } catch (error) {
    return iso;
  }
}

function clip(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

// Ключ для поиска повторной анкеты: регистр, «ё» и пробелы не важны.
function nameKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanPhone(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildCsv(header, rows) {
  return "\uFEFF" + [header, ...rows]
    .map((row) => row.map(csvCell).join(";"))
    .join("\r\n");
}

async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, String(value)).run();
}

async function telegram(env, method, payload) {
  if (!env.BOT_TOKEN) return { ok: false, description: "BOT_TOKEN is not configured" };

  const response = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  return response.json().catch(() => ({ ok: false }));
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

// Для рассылок: обычный текст без HTML, чтобы случайные символы не ломали сообщение.
async function sendPlain(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function notifyAdmins(env, text) {
  await Promise.all(
    adminIds(env).map((chatId) => sendMessage(env, chatId, text).catch(() => null))
  );
}

async function sendFile(env, chatId, fileId, fileType, caption) {
  const method = fileType === "document" ? "sendDocument" : "sendPhoto";
  const field = fileType === "document" ? "document" : "photo";

  const result = await telegram(env, method, {
    chat_id: chatId,
    [field]: fileId,
    caption,
    parse_mode: "HTML"
  }).catch(() => null);

  if (!result || !result.ok) {
    await sendMessage(env, chatId, caption);
  }
}

async function notifyAdminsFile(env, fileId, fileType, caption) {
  await Promise.all(
    adminIds(env).map((chatId) => sendFile(env, chatId, fileId, fileType, caption))
  );
}

async function sendCsv(env, chatId, csv, filename, caption) {
  if (!env.BOT_TOKEN) return { ok: false };

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("document", new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);

  const response = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form
  });

  return response.json().catch(() => ({ ok: false }));
}

/* ---------- setup ---------- */

async function handleSetup(request, env) {
  const authorization = request.headers.get("Authorization") || "";

  if (!env.SETUP_SECRET || authorization !== `Bearer ${env.SETUP_SECRET}`) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const origin = new URL(request.url).origin;
  const webhook = await telegram(env, "setWebhook", {
    url: `${origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "edited_message"]
  });
  const me = await telegram(env, "getMe", {});
  const webhookInfo = await telegram(env, "getWebhookInfo", {});

  return json({
    ok: Boolean(webhook.ok),
    webhook,
    me: me.result || null,
    meError: me.ok ? null : me.description,
    tokenCheck: {
      length: String(env.BOT_TOKEN || "").length,
      format: /^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN || ""),
      whitespace: /\s/.test(env.BOT_TOKEN || "")
    },
    webhookInfo: webhookInfo.result || null
  });
}

/* ---------- diagnostics ---------- */

function setupAuthorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  return Boolean(env.SETUP_SECRET) && authorization === `Bearer ${env.SETUP_SECRET}`;
}

async function handlePing(request, env) {
  if (!setupAuthorized(request, env)) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const text = "✅ Бот на связи. Если видишь это сообщение — уведомления и команды работают.";

  const results = await Promise.all(
    adminIds(env).map(async (chatId) => {
      const sent = await sendMessage(env, chatId, text).catch((error) => ({
        ok: false,
        description: String(error)
      }));

      return {
        chatId,
        ok: Boolean(sent?.ok),
        error: sent?.ok ? null : sent?.description || "unknown error"
      };
    })
  );

  return json({ ok: results.every((item) => item.ok), admins: results });
}

async function handleAdminBackup(request, env) {
  if (!setupAuthorized(request, env)) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const summary = await sendDailyBackup(env);
  return json({ ok: true, ...summary });
}

async function handleAdminUptime(request, env) {
  if (!setupAuthorized(request, env)) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const result = await checkUptime(env);
  return json(result);
}

/* ---------- мониторинг и бэкапы ---------- */

function guestsCsv(rows) {
  const header = [
    "ID", "Дата", "Обновлена", "Имя", "Телефон или Telegram",
    "Придёт", "Трансфер туда", "Трансфер обратно", "Пожелания"
  ];

  const body = rows.map((guest) => [
    guest.id,
    formatDate(guest.created_at),
    guest.updated_at ? formatDate(guest.updated_at) : "",
    guest.name,
    guest.phone || "",
    guest.attendance === "yes" ? "да" : "нет",
    guest.transfer_to ? "да" : "нет",
    guest.transfer_from ? "да" : "нет",
    guest.wishes || ""
  ]);

  return buildCsv(header, body);
}

async function probe(url) {
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });

    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: String(error)
    };
  }
}

async function collectHealth(env) {
  const siteUrl = `${env.SITE_ORIGIN || "https://antoniolga.ru"}/?uptime=${Date.now()}`;
  const site = await probe(siteUrl);

  let db;

  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM guests").first();
    db = { ok: true, guests: Number(row?.count || 0) };
  } catch (error) {
    db = { ok: false, error: String(error) };
  }

  return { ok: Boolean(site.ok && db.ok), site, db };
}

async function checkUptime(env) {
  const health = await collectHealth(env);
  const state = health.ok ? "up" : "down";
  const previous = (await getSetting(env, "uptime_state")) || "up";

  let notified = false;

  if (state !== previous) {
    const text = state === "up"
      ? "✅ Сайт снова доступен. Проверка восстановилась."
      : [
          "⚠️ <b>Сайт недоступен</b>",
          "",
          `<b>Сайт:</b> ${health.site.status || "нет ответа"} (${health.site.ms} мс)`,
          `<b>База:</b> ${health.db.ok ? "ок" : "ошибка"}`,
          health.site.error ? `<b>Ошибка:</b> ${escapeHtml(health.site.error)}` : ""
        ].filter(Boolean).join("\n");

    await notifyAdmins(env, text);
    await setSetting(env, "uptime_state", state);
    notified = true;
  }

  return { ok: health.ok, state, previous, notified, site: health.site, db: health.db };
}

async function sendDailyBackup(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, updated_at, name, phone, attendance, transfer_to, transfer_from, wishes
       FROM guests ORDER BY id ASC`
  ).all();

  const subscribers = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM subscribers"
  ).first();

  const winner = await env.DB.prepare(
    "SELECT first_name, username, created_at FROM contest WHERE is_winner = 1 LIMIT 1"
  ).first();

  const coming = results.filter((guest) => guest.attendance === "yes").length;
  const summary = [
    "🗂 <b>Бэкап анкет</b>",
    `${formatDate(new Date().toISOString())}`,
    "",
    `<b>Анкет:</b> ${results.length}`,
    `<b>Придут:</b> ${coming}`,
    `<b>Не смогут:</b> ${results.length - coming}`,
    `<b>Подписчиков бота:</b> ${Number(subscribers?.count || 0)}`,
    winner
      ? `<b>Победитель:</b> ${escapeHtml(winner.first_name || "гость")} · ${formatDate(winner.created_at)}`
      : "<b>Победитель:</b> пока нет"
  ].join("\n");

  const recipients = adminIds(env);
  const filename = `guests-${new Date().toISOString().slice(0, 10)}.csv`;
  const delivery = { delivered: 0, failed: 0 };

  await Promise.all(recipients.map(async (chatId) => {
    try {
      const message = await sendMessage(env, chatId, summary);
      if (message?.ok) delivery.delivered += 1;
      else delivery.failed += 1;

      if (results.length) {
        await sendCsv(env, chatId, guestsCsv(results), filename, `Анкеты гостей: ${results.length}`);
      }
    } catch (error) {
      delivery.failed += 1;
    }
  }));

  return { guests: results.length, ...delivery };
}

/* ---------- RSVP ---------- */

async function handleRsvp(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.SITE_ORIGIN || "*";

  if (origin && allowed !== "*" && origin !== allowed && !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const headers = corsHeaders(request, env);
  let payload;

  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, error: "Некорректный запрос" }, 400, headers);
  }

  // Honeypot: боты заполняют скрытое поле, люди — нет.
  if (payload.website) {
    return json({ ok: true }, 200, headers);
  }

  const name = String(payload.name || "").trim().slice(0, 120);
  const phone = cleanPhone(payload.phone);
  const attendance = payload.attendance === "yes" || payload.attendance === "no"
    ? payload.attendance
    : "";
  const transferTo = payload.transfer_to ? 1 : 0;
  const transferFrom = payload.transfer_from ? 1 : 0;
  const wishes = String(payload.wishes || "").trim().slice(0, 2000);

  if (!name || !attendance) {
    return json({ ok: false, error: "Заполните имя и присутствие" }, 400, headers);
  }

  const createdAt = new Date().toISOString();
  const key = nameKey(name);
  let updated = false;

  try {
    const existing = await env.DB.prepare(
      "SELECT id FROM guests WHERE name_key = ?"
    ).bind(key).first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE guests
            SET updated_at = ?, name = ?, phone = ?, attendance = ?,
                transfer_to = ?, transfer_from = ?, wishes = ?
          WHERE id = ?`
      ).bind(createdAt, name, phone, attendance, transferTo, transferFrom, wishes, existing.id).run();
      updated = true;
    } else {
      try {
        await env.DB.prepare(
          `INSERT INTO guests
             (created_at, updated_at, name, name_key, phone, attendance, transfer_to, transfer_from, wishes)
           VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(createdAt, name, key, phone, attendance, transferTo, transferFrom, wishes).run();
      } catch (insertError) {
        // Гонка: пока проверяли, тот же гость уже отправил анкету.
        await env.DB.prepare(
          `UPDATE guests
              SET updated_at = ?, phone = ?, attendance = ?,
                  transfer_to = ?, transfer_from = ?, wishes = ?
            WHERE name_key = ?`
        ).bind(createdAt, phone, attendance, transferTo, transferFrom, wishes, key).run();
        updated = true;
      }
    }
  } catch (error) {
    console.error("RSVP save failed", error);
    return json({ ok: false, error: "Не удалось сохранить ответ" }, 500, headers);
  }

  const lines = [
    updated ? "✏️ <b>Анкета обновлена</b>" : "💌 <b>Новая анкета гостя</b>",
    `<b>Имя:</b> ${escapeHtml(name)}`,
    phone ? `<b>Связь:</b> ${escapeHtml(phone)}` : "",
    `<b>Придёт:</b> ${attendance === "yes" ? "да" : "нет"}`,
    `<b>Трансфер туда:</b> ${transferTo ? "да" : "нет"}`,
    `<b>Трансфер обратно:</b> ${transferFrom ? "да" : "нет"}`,
    `<b>Пожелания:</b> ${wishes ? escapeHtml(clip(wishes, 500)) : "—"}`,
    `<b>Время:</b> ${formatDate(createdAt)}`
  ].filter(Boolean);

  await notifyAdmins(env, lines.join("\n"));

  // Дублируем в Formspree, чтобы сохранить привычные письма.
  if (env.FORMSPREE_FORM_ID) {
    try {
      const form = new FormData();
      form.append("name", name);
      form.append("attendance", attendance);
      if (transferTo) form.append("transfer_to", "yes");
      if (transferFrom) form.append("transfer_from", "yes");
      form.append("wishes", wishes);
      form.append("_subject", "Свадьба Антона и Ольги — ответ гостя");

      await fetch(`https://formspree.io/f/${env.FORMSPREE_FORM_ID}`, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: form
      });
    } catch (error) {
      console.error("Formspree forward failed", error);
    }
  }

  return json({ ok: true, updated }, 200, headers);
}

/* ---------- Telegram webhook ---------- */

async function handleTelegram(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update;

  try {
    update = await request.json();
  } catch (error) {
    return new Response("ok");
  }

  const message = update.message || update.edited_message;
  if (!message || !message.chat) return new Response("ok");

  await rememberSubscriber(env, message);

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = String(message.text || "").trim();

  if (text.startsWith("/")) {
    await handleCommand(env, chatId, userId, text);
    return new Response("ok");
  }

  const photo = Array.isArray(message.photo) && message.photo.length
    ? message.photo[message.photo.length - 1]
    : null;
  const document = message.document && (
    String(message.document.mime_type || "").startsWith("image/") ||
    /\.(png|jpe?g|webp|heic)$/i.test(message.document.file_name || "")
  ) ? message.document : null;

  if (photo || document) {
    await handleContest(env, message, photo, document);
    return new Response("ok");
  }

  if (text) {
    await sendMessage(
      env,
      chatId,
      "Пришлите скриншот пасхалки и добавьте в подпись секретный код с сайта."
    );
  }

  return new Response("ok");
}

async function rememberSubscriber(env, message) {
  const userId = message.from?.id;
  const chatId = message.chat?.id;

  if (!userId || !chatId || message.from?.is_bot) return;

  const now = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO subscribers (telegram_id, chat_id, username, first_name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         chat_id = excluded.chat_id,
         username = excluded.username,
         first_name = excluded.first_name,
         last_seen_at = excluded.last_seen_at`
    ).bind(
      userId,
      chatId,
      message.from?.username || null,
      message.from?.first_name || null,
      now,
      now
    ).run();
  } catch (error) {
    // Подписчик — вспомогательные данные: не ломаем из-за них ответ боту.
    console.error("Subscriber upsert failed", error);
  }
}

async function handleCommand(env, chatId, userId, text) {
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    await sendMessage(
      env,
      chatId,
      [
        "💌 <b>Бот свадьбы Антона и Ольги</b>",
        "",
        "Найдите пасхалку на сайте, сделайте скриншот и отправьте его сюда вместе с секретным кодом в подписи.",
        "",
        "Первый, кто пришлёт правильный скриншот, получит отдельный приз.",
        "",
        "Сайт: https://antoniolga.ru",
        "",
        "Для организаторов: /stats, /guests, /export, /winner, /broadcast"
      ].join("\n")
    );
    return;
  }

  if (!isAdmin(env, userId)) {
    await sendMessage(env, chatId, "Эта команда доступна только организаторам.");
    return;
  }

  if (command === "/winner") {
    const winner = await env.DB.prepare(
      "SELECT * FROM contest WHERE is_winner = 1 ORDER BY id ASC LIMIT 1"
    ).first();

    if (!winner) {
      await sendMessage(env, chatId, "Победителя пока нет — ждём первый скриншот.");
      return;
    }

    const caption = [
      "🏆 <b>Победитель конкурса</b>",
      `<b>Имя:</b> ${escapeHtml(winner.first_name || "гость")}`,
      winner.username ? `<b>Telegram:</b> @${escapeHtml(winner.username)}` : "",
      `<b>Время:</b> ${formatDate(winner.created_at)}`
    ].filter(Boolean).join("\n");

    await sendFile(env, chatId, winner.file_id, winner.file_type, caption);
    return;
  }

  if (command === "/stats") {
    const stats = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN attendance = 'yes' THEN 1 ELSE 0 END) AS coming,
         SUM(CASE WHEN attendance = 'no' THEN 1 ELSE 0 END) AS not_coming,
         SUM(CASE WHEN transfer_to = 1 THEN 1 ELSE 0 END) AS transfer_to,
         SUM(CASE WHEN transfer_from = 1 THEN 1 ELSE 0 END) AS transfer_from,
         SUM(CASE WHEN phone <> '' THEN 1 ELSE 0 END) AS with_phone
       FROM guests`
    ).first();

    const subscribers = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM subscribers"
    ).first();

    const winner = await env.DB.prepare(
      "SELECT first_name, username FROM contest WHERE is_winner = 1 LIMIT 1"
    ).first();

    const lines = [
      "📊 <b>Статистика</b>",
      "",
      `<b>Анкет:</b> ${Number(stats?.total || 0)}`,
      `<b>Придут:</b> ${Number(stats?.coming || 0)}`,
      `<b>Не смогут:</b> ${Number(stats?.not_coming || 0)}`,
      "",
      `<b>Трансфер туда:</b> ${Number(stats?.transfer_to || 0)}`,
      `<b>Трансфер обратно:</b> ${Number(stats?.transfer_from || 0)}`,
      `<b>Оставили контакт:</b> ${Number(stats?.with_phone || 0)}`,
      "",
      `<b>Подписчиков бота:</b> ${Number(subscribers?.count || 0)}`,
      winner
        ? `<b>Победитель:</b> ${escapeHtml(winner.first_name || "гость")}${winner.username ? ` (@${escapeHtml(winner.username)})` : ""}`
        : "<b>Победитель:</b> пока нет"
    ];

    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  if (command === "/guests") {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM guests").first();
    const count = Number(countRow?.count || 0);

    if (!count) {
      await sendMessage(env, chatId, "Анкет пока нет.");
      return;
    }

    const { results } = await env.DB.prepare(
      `SELECT id, created_at, updated_at, name, phone, attendance, transfer_to, transfer_from
         FROM guests ORDER BY id DESC LIMIT 20`
    ).all();

    const lines = results.map((guest, index) => {
      const transfer = [
        guest.transfer_to ? "туда" : "",
        guest.transfer_from ? "обратно" : ""
      ].filter(Boolean).join(" + ");

      return [
        `${index + 1}. <b>${escapeHtml(guest.name)}</b> — ${guest.attendance === "yes" ? "придёт" : "не сможет"}`,
        guest.phone ? `   связь: ${escapeHtml(guest.phone)}` : "",
        transfer ? `   трансфер: ${transfer}` : "",
        `   ${formatDate(guest.created_at)}${guest.updated_at ? " · обновлена" : ""}`
      ].filter(Boolean).join("\n");
    });

    let message = `👥 <b>Анкет: ${count}</b>\n\n${lines.join("\n\n")}`;
    if (count > results.length) {
      message += `\n\nПоказаны последние ${results.length}. Полный список: /export`;
    }

    await sendMessage(env, chatId, message);
    return;
  }

  if (command === "/export") {
    const { results } = await env.DB.prepare(
      `SELECT id, created_at, updated_at, name, phone, attendance, transfer_to, transfer_from, wishes
         FROM guests ORDER BY id ASC`
    ).all();

    if (!results.length) {
      await sendMessage(env, chatId, "Анкет пока нет — экспортировать нечего.");
      return;
    }

    await sendCsv(
      env,
      chatId,
      guestsCsv(results),
      `guests-${new Date().toISOString().slice(0, 10)}.csv`,
      `Анкеты гостей: ${results.length}`
    );
    return;
  }

  if (command === "/broadcast") {
    const messageText = text.replace(/^\/broadcast(@\S+)?\s*/i, "").trim();

    if (!messageText) {
      await sendMessage(
        env,
        chatId,
        "Напишите текст после команды:\n<code>/broadcast Во сколько собираемся?</code>"
      );
      return;
    }

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM subscribers"
    ).all();

    const recipients = Number(results?.[0]?.count || 0);

    if (!recipients) {
      await sendMessage(env, chatId, "Пока нет подписчиков: гости ещё не нажали Start у бота.");
      return;
    }

    const created = new Date().toISOString();
    const inserted = await env.DB.prepare(
      "INSERT INTO broadcasts (created_at, text) VALUES (?, ?)"
    ).bind(created, messageText).run();

    const id = inserted.meta?.last_row_id;

    await sendMessage(
      env,
      chatId,
      [
        `📝 <b>Черновик рассылки #${id}</b>`,
        "",
        escapeHtml(messageText),
        "",
        `Получателей: <b>${recipients}</b>`,
        "",
        `Отправить: <code>/broadcast_send ${id}</code>`,
        `Отменить: <code>/broadcast_cancel ${id}</code>`
      ].join("\n")
    );
    return;
  }

  if (command === "/broadcast_send") {
    const id = Number(text.split(/\s+/)[1]);

    if (!id) {
      await sendMessage(env, chatId, "Укажите номер черновика: /broadcast_send 1");
      return;
    }

    const draft = await env.DB.prepare(
      "SELECT id, text, sent_at FROM broadcasts WHERE id = ?"
    ).bind(id).first();

    if (!draft) {
      await sendMessage(env, chatId, "Черновик не найден.");
      return;
    }

    if (draft.sent_at) {
      await sendMessage(env, chatId, `Рассылка #${id} уже отправлена.`);
      return;
    }

    const { results } = await env.DB.prepare(
      "SELECT chat_id FROM subscribers"
    ).all();

    let delivered = 0;
    let failed = 0;

    for (let index = 0; index < results.length; index += 5) {
      const chunk = results.slice(index, index + 5);
      const responses = await Promise.all(
        chunk.map((row) => sendPlain(env, row.chat_id, draft.text).catch(() => ({ ok: false })))
      );

      responses.forEach((response) => {
        if (response && response.ok) delivered += 1;
        else failed += 1;
      });

      if (index + 5 < results.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    await env.DB.prepare("UPDATE broadcasts SET sent_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id).run();

    await sendMessage(
      env,
      chatId,
      `📤 Рассылка #${id} отправлена.\nДоставлено: ${delivered}, ошибок: ${failed}.`
    );
    return;
  }

  if (command === "/broadcast_cancel") {
    const id = Number(text.split(/\s+/)[1]);

    if (!id) {
      await sendMessage(env, chatId, "Укажите номер черновика: /broadcast_cancel 1");
      return;
    }

    const draft = await env.DB.prepare(
      "SELECT id, sent_at FROM broadcasts WHERE id = ?"
    ).bind(id).first();

    if (!draft) {
      await sendMessage(env, chatId, "Черновик не найден.");
      return;
    }

    if (draft.sent_at) {
      await sendMessage(env, chatId, `Рассылка #${id} уже отправлена — отменить нельзя.`);
      return;
    }

    await env.DB.prepare("DELETE FROM broadcasts WHERE id = ?").bind(id).run();
    await sendMessage(env, chatId, `Черновик #${id} удалён.`);
    return;
  }

  await sendMessage(
    env,
    chatId,
    "Неизвестная команда. Доступно: /start, /stats, /guests, /export, /winner, /broadcast."
  );
}

async function handleContest(env, message, photo, document) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const caption = String(message.caption || "");
  const expectedCode = normalizeCode(env.CONTEST_CODE || "");

  if (!expectedCode || !normalizeCode(caption).includes(expectedCode)) {
    await sendMessage(
      env,
      chatId,
      "Нужен секретный код. Пришлите скриншот и добавьте код с сайта в подпись к фото."
    );
    return;
  }

  const fileId = photo ? photo.file_id : document.file_id;
  const fileType = photo ? "photo" : "document";
  const createdAt = new Date().toISOString();
  const username = message.from?.username || null;
  const firstName = message.from?.first_name || null;

  try {
    const existingWinner = await env.DB.prepare(
      "SELECT id FROM contest WHERE is_winner = 1 LIMIT 1"
    ).first();

    let isWinner = false;

    if (!existingWinner) {
      try {
        await env.DB.prepare(
          `INSERT INTO contest
             (created_at, telegram_id, username, first_name, file_id, file_type, code, is_winner)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
        ).bind(createdAt, userId, username, firstName, fileId, fileType, expectedCode).run();
        isWinner = true;
      } catch (error) {
        // Гонка: пока проверяли, победитель уже появился.
        await env.DB.prepare(
          `INSERT INTO contest
             (created_at, telegram_id, username, first_name, file_id, file_type, code, is_winner)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(createdAt, userId, username, firstName, fileId, fileType, expectedCode).run();
      }
    } else {
      await env.DB.prepare(
        `INSERT INTO contest
           (created_at, telegram_id, username, first_name, file_id, file_type, code, is_winner)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      ).bind(createdAt, userId, username, firstName, fileId, fileType, expectedCode).run();
    }

    if (isWinner) {
      const winnerCaption = [
        "🏆 <b>Первый нашёл Добби!</b>",
        `<b>Имя:</b> ${escapeHtml(firstName || "гость")}`,
        username ? `<b>Telegram:</b> @${escapeHtml(username)}` : "",
        `<b>Время:</b> ${formatDate(createdAt)}`
      ].filter(Boolean).join("\n");

      await notifyAdminsFile(env, fileId, fileType, winnerCaption);
      await sendMessage(
        env,
        chatId,
        "🏆 Поздравляем! Ты первый нашёл Добби. Скриншот засчитан — приз ждёт!"
      );
    } else {
      await sendMessage(
        env,
        chatId,
        "Добби уже нашёл другой гость. Спасибо за участие!"
      );
    }
  } catch (error) {
    console.error("Contest insert failed", error);
    await sendMessage(env, chatId, "Не удалось сохранить скриншот. Попробуйте ещё раз.");
  }
}
