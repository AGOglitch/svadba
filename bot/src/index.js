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

    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegram(request, env);
    }

    return json({ ok: false, error: "Not found" }, 404, corsHeaders(request, env));
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

  try {
    await env.DB.prepare(
      `INSERT INTO guests (created_at, name, attendance, transfer_to, transfer_from, wishes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(createdAt, name, attendance, transferTo, transferFrom, wishes).run();
  } catch (error) {
    console.error("RSVP insert failed", error);
    return json({ ok: false, error: "Не удалось сохранить ответ" }, 500, headers);
  }

  const lines = [
    "💌 <b>Новая анкета гостя</b>",
    `<b>Имя:</b> ${escapeHtml(name)}`,
    `<b>Придёт:</b> ${attendance === "yes" ? "да" : "нет"}`,
    `<b>Трансфер туда:</b> ${transferTo ? "да" : "нет"}`,
    `<b>Трансфер обратно:</b> ${transferFrom ? "да" : "нет"}`,
    `<b>Пожелания:</b> ${wishes ? escapeHtml(clip(wishes, 500)) : "—"}`,
    `<b>Время:</b> ${formatDate(createdAt)}`
  ];

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

  return json({ ok: true }, 200, headers);
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
        "Для организаторов: /winner, /guests, /export"
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

  if (command === "/guests") {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM guests").first();
    const count = Number(countRow?.count || 0);

    if (!count) {
      await sendMessage(env, chatId, "Анкет пока нет.");
      return;
    }

    const { results } = await env.DB.prepare(
      "SELECT id, created_at, name, attendance, transfer_to, transfer_from FROM guests ORDER BY id DESC LIMIT 20"
    ).all();

    const lines = results.map((guest, index) => {
      const transfer = [
        guest.transfer_to ? "туда" : "",
        guest.transfer_from ? "обратно" : ""
      ].filter(Boolean).join(" + ");

      return [
        `${index + 1}. <b>${escapeHtml(guest.name)}</b> — ${guest.attendance === "yes" ? "придёт" : "не сможет"}`,
        transfer ? `   трансфер: ${transfer}` : "",
        `   ${formatDate(guest.created_at)}`
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
      "SELECT id, created_at, name, attendance, transfer_to, transfer_from, wishes FROM guests ORDER BY id ASC"
    ).all();

    if (!results.length) {
      await sendMessage(env, chatId, "Анкет пока нет — экспортировать нечего.");
      return;
    }

    const header = ["ID", "Дата", "Имя", "Придёт", "Трансфер туда", "Трансфер обратно", "Пожелания"];
    const rows = results.map((guest) => [
      guest.id,
      formatDate(guest.created_at),
      guest.name,
      guest.attendance === "yes" ? "да" : "нет",
      guest.transfer_to ? "да" : "нет",
      guest.transfer_from ? "да" : "нет",
      guest.wishes
    ]);

    const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = "\uFEFF" + [header, ...rows]
      .map((row) => row.map(csvCell).join(";"))
      .join("\r\n");

    await sendCsv(
      env,
      chatId,
      csv,
      `guests-${new Date().toISOString().slice(0, 10)}.csv`,
      `Анкеты гостей: ${results.length}`
    );
    return;
  }

  await sendMessage(env, chatId, "Неизвестная команда. Доступно: /start, /help.");
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
