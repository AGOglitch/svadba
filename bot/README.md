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
- Отправляет уведомление о новой анкете администраторам в Telegram.
- Принимает скриншот пасхалки с секретным кодом.
- Записывает **только одного победителя** — первого, кто прислал правильный код.
- Присылает скриншот победителя администраторам.
- Команды:
  - `/winner` — показать победителя;
  - `/guests` — последние анкеты и количество;
  - `/export` — скачать CSV со всеми гостями.

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

CORS разрешает `https://antoniolga.ru` и `http://localhost`.

Проверка: заполните анкету на сайте → в D1 появится запись → администратор получит сообщение в Telegram.

## 6. Полезные команды

```powershell
# все анкеты в CSV напрямую из D1
wrangler d1 export antoniolga-bot --remote --output=guests.csv

# логи Worker
wrangler tail antoniolga-bot
```

## Безопасность

- Токен бота и `WEBHOOK_SECRET` хранятся только в секретах Cloudflare.
- Webhook принимает запросы только с секретным заголовком Telegram.
- `/winner`, `/guests`, `/export` доступны только ID из `ADMIN_IDS`.
- В анкете есть honeypot-поле `website`; заполненные ботом заявки игнорируются.
- Не публикуйте CSV с гостями и токен бота в открытых репозиториях.
