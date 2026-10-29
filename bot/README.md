# Бот свадьбы: конкурс Добби и анкеты гостей

Backend для Telegram-бота на **Cloudflare Workers + D1**. Сайт остаётся статическим на GitHub Pages, а Worker принимает анкеты, хранит гостей и обрабатывает конкурс скриншотов.

## Уже развёрнуто

- Бот: [@antoniolga_bot](https://t.me/antoniolga_bot)
- Worker: `https://antoniolga-bot.agoglitch.workers.dev`
- База D1: `antoniolga-bot` (`8ed66c16-4a26-4537-8d3f-fdc7345d65e2`)
- Код конкурса: `DOBBY-1612`
- Webhook: `https://antoniolga-bot.agoglitch.workers.dev/telegram`

## Что умеет

- Принимает анкеты гостей с сайта и сохраняет их в D1.
- Повторная анкета с тем же именем **обновляет** запись, а не создаёт дубль (регистр и «ё» не важны).
- Отправляет уведомление о новой или обновлённой анкете администраторам в Telegram.
- Принимает скриншот пасхалки с секретным кодом.
- Записывает **только одного победителя** — первого, кто прислал правильный код.
- Присылает скриншот победителя администраторам.
- Запоминает всех, кто написал боту, — для рассылок и напоминаний.
- Каждые 30 минут проверяет доступность сайта и пишет админам, если сайт упал или восстановился.
- Каждый день в 09:00 по Екатеринбургу присылает CSV-бэкап анкет.
- Команды:
  - `/stats` — сколько анкет, кто придёт, трансфер, подписчики, победитель;
  - `/winner` — показать победителя;
  - `/guests` — последние анкеты и количество;
  - `/export` — скачать CSV со всеми гостями;
  - `/broadcast <текст>` — черновик рассылки всем подписчикам;
  - `/broadcast_send <id>` — отправить черновик;
  - `/broadcast_cancel <id>` — удалить черновик.

## 1. Создать бота

1. Откройте [@BotFather](https://t.me/BotFather).
2. Отправьте `/newbot`.
3. Задайте имя и username, например `antoniolga_wedding_bot`.
4. Сохраните токен в файл **вне проекта**, например:
   `C:\Temp\opencode\telegram-bot-token.txt`
5. Узнайте свой Telegram ID через [@userinfobot](https://t.me/userinfobot).
6. Сохраните ID в `C:\Temp\opencode\telegram-admin-id.txt`.

Не коммитьте токен и `.dev.vars` в Git.

## 2. Cloudflare

Нужен бесплатный аккаунт Cloudflare. Из папки `bot`:

```powershell
npm install -g wrangler
wrangler login
wrangler d1 create antoniolga-bot
```

Скопируйте `database_id` из ответа в `wrangler.toml`.

Примените схему:

```powershell
wrangler d1 execute antoniolga-bot --file=schema.sql --remote
```

Если база уже создавалась раньше, примените миграцию (добавит телефон, подписчиков и рассылки):

```powershell
wrangler d1 execute antoniolga-bot --file=migrations/001-guests-phone-subscribers.sql --remote
```

Добавьте секреты:

```powershell
wrangler secret put BOT_TOKEN
wrangler secret put ADMIN_IDS
wrangler secret put WEBHOOK_SECRET
wrangler secret put SETUP_SECRET
```

- `BOT_TOKEN` — токен из BotFather.
- `ADMIN_IDS` — Telegram ID администраторов через запятую, например `123456789,987654321`.
- `WEBHOOK_SECRET` — случайная строка, например 32+ символа. Она же нужна при установке webhook.
- `SETUP_SECRET` — отдельный случайный секрет для защищённого `/setup`-маршрута.

Задеплойте:

```powershell
wrangler deploy
```

Wrangler покажет адрес вида:

```
https://antoniolga-bot.<ваш-поддомен>.workers.dev
```

Проверьте:

```text
https://antoniolga-bot.<ваш-поддомен>.workers.dev/health
```

Должно вернуться `{"ok":true,"db":true,"bot":true,"contestCode":true}`.

## 3. Установить webhook

Проще всего через защищённый `/setup`-маршрут Worker (он сам вызывает Telegram API):

```powershell
$setup = (Get-Content C:\Temp\opencode\telegram-setup-secret.txt -Raw).Trim()
$headers = @{
  Authorization = "Bearer $setup"
  "Content-Type" = "application/json"
}

Invoke-RestMethod "https://antoniolga-bot.agoglitch.workers.dev/setup" `
  -Method Post `
  -Headers $headers `
  -Body "{}"
```

В ответе будет `ok: true`, имя бота и установленный webhook.

Альтернатива — напрямую через Telegram API:

```powershell
$token = (Get-Content C:\Temp\opencode\telegram-bot-token.txt -Raw).Trim()
$secret = "ВАШ_WEBHOOK_SECRET"
$worker = "https://antoniolga-bot.agoglitch.workers.dev"

Invoke-RestMethod "https://api.telegram.org/bot$token/setWebhook" `
  -Method Post `
  -Body @{
    url = "$worker/telegram"
    secret_token = $secret
    allowed_updates = '["message","edited_message"]'
  }
```

## 4. Проверить конкурс

1. Найдите пасхалку на сайте, активируйте Добби.
2. Скопируйте секретный код. Сейчас в `wrangler.toml` указан `DOBBY-1612`.
3. Отправьте боту скриншот, добавив код в подпись.
4. Первый получит «Ты первый!», остальные — «Победитель уже есть».
5. Администратор увидит скриншот и команду `/winner`.

Если нужен другой код, поменяйте `CONTEST_CODE` в `wrangler.toml` и продублируйте его на сайте.

## 5. Анкета с сайта

Сайт уже отправляет анкеты в Worker:

```js
const RSVP_ENDPOINT = "https://antoniolga-bot.agoglitch.workers.dev/api/rsvp";
```

Worker сохраняет гостя в D1, присылает уведомление в Telegram и дублирует заявку в Formspree (`FORMSPREE_FORM_ID = "xbgggkln"`).

Повторная отправка с тем же именем обновляет существующую анкету: в ответе придёт `"updated": true`, а сайт покажет «Ваш ответ обновлён». Поле «Телефон или Telegram» необязательное, но помогает связаться по трансферу.

CORS разрешает `https://antoniolga.ru` и `http://localhost`.

Проверка: заполните анкету на сайте → в D1 появится запись → администратор получит сообщение в Telegram.

## 6. Рассылки и напоминания

1. Гость пишет боту `/start` — он попадает в таблицу `subscribers`.
2. Админ отправляет `/broadcast Не забудьте заполнить анкету до 1 декабря`.
3. Бот присылает **черновик** с количеством получателей и номером.
4. Админ проверяет текст и отправляет `/broadcast_send 1` (или удаляет `/broadcast_cancel 1`).

Рассылка уходит только тем, кто сам нажал Start. Написать гостю, который бота не открывал, Telegram не позволяет.

## 7. Мониторинг и бэкапы

В `wrangler.toml` включены cron-триггеры:

- `0 4 * * *` — каждый день в 09:00 по Екатеринбургу присылает администраторам CSV со всеми анкетами;
- `*/30 * * * *` — каждые 30 минут проверяет сайт и базу. Если сайт упал или восстановился, приходит сообщение. Состояние хранится в таблице `settings`, поэтому повторных уведомлений нет.

Запустить вручную (например, перед выгрузкой для банкета):

```powershell
$setup = (Get-Content C:\Temp\opencode\telegram-setup-secret.txt -Raw).Trim()

Invoke-RestMethod "https://antoniolga-bot.agoglitch.workers.dev/admin/backup" `
  -Method Post -Headers @{ Authorization = "Bearer $setup" } -Body "{}"

Invoke-RestMethod "https://antoniolga-bot.agoglitch.workers.dev/admin/uptime" `
  -Method Post -Headers @{ Authorization = "Bearer $setup" } -Body "{}"
```

## 8. Полезные команды

```powershell
# все анкеты в CSV напрямую из D1
wrangler d1 export antoniolga-bot --remote --output=guests.csv

# логи Worker
wrangler tail antoniolga-bot
```

## Безопасность

- Токен бота и `WEBHOOK_SECRET` хранятся только в секретах Cloudflare.
- Webhook принимает запросы только с секретным заголовком Telegram.
- `/stats`, `/guests`, `/export`, `/winner`, `/broadcast*` доступны только ID из `ADMIN_IDS`.
- В анкете есть honeypot-поле `website`; заполненные ботом заявки игнорируются.
- `/setup`, `/admin/ping`, `/admin/backup`, `/admin/uptime` защищены `Authorization: Bearer <SETUP_SECRET>`.
- Не публикуйте CSV с гостями и токен бота в открытых репозиториях.

## Диагностика

```powershell
$setup = (Get-Content C:\Temp\opencode\telegram-setup-secret.txt -Raw).Trim()

# проверка базы, токена и кода
Invoke-RestMethod "https://antoniolga-bot.agoglitch.workers.dev/health"

# тестовое сообщение администраторам
Invoke-RestMethod "https://antoniolga-bot.agoglitch.workers.dev/admin/ping" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $setup" } `
  -Body "{}"
```

`/admin/ping` вернёт `ok: true`, если Telegram принял сообщение. Если админ ещё не нажал Start у бота, будет ошибка `chat not found`.
