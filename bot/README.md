# Бот свадьбы: конкурс Добби и анкеты гостей

Backend для Telegram-бота на **Cloudflare Workers + D1**. Сайт остаётся статическим на GitHub Pages, а Worker принимает анкеты, хранит гостей и обрабатывает конкурс скриншотов.

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
```

- `BOT_TOKEN` — токен из BotFather.
- `ADMIN_IDS` — Telegram ID администраторов через запятую, например `123456789,987654321`.
- `WEBHOOK_SECRET` — случайная строка, например 32+ символа. Она же нужна при установке webhook.

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

```powershell
$token = (Get-Content C:\Temp\opencode\telegram-bot-token.txt -Raw).Trim()
$secret = "ВАШ_WEBHOOK_SECRET"
$worker = "https://antoniolga-bot.<ваш-поддомен>.workers.dev"

Invoke-RestMethod "https://api.telegram.org/bot$token/setWebhook" `
  -Method Post `
  -Body @{
    url = "$worker/telegram"
    secret_token = $secret
    allowed_updates = '["message","edited_message"]'
  }
```

Проверка:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo"
```

## 4. Проверить конкурс

1. Найдите пасхалку на сайте, активируйте Добби.
2. Скопируйте секретный код. Сейчас в `wrangler.toml` указан `DOBBY-1612`.
3. Отправьте боту скриншот, добавив код в подпись.
4. Первый получит «Ты первый!», остальные — «Победитель уже есть».
5. Администратор увидит скриншот и команду `/winner`.

Если нужен другой код, поменяйте `CONTEST_CODE` в `wrangler.toml` и продублируйте его на сайте.

## 5. Подключить анкету с сайта

Пока сайт отправляет анкеты в Formspree. Чтобы бот видел гостей:

1. В `index.html` добавить адрес Worker:
   ```js
   const RSVP_ENDPOINT = "https://antoniolga-bot.<ваш-поддомен>.workers.dev/api/rsvp";
   ```
2. Отправлять форму на этот endpoint JSON-ом:
   ```json
   {
     "name": "Иван Иванов",
     "attendance": "yes",
     "transfer_to": true,
     "transfer_from": false,
     "wishes": "Без орехов"
   }
   ```
3. Worker сохранит гостя в D1, пришлёт уведомление в Telegram и (если задан `FORMSPREE_FORM_ID`) продублирует заявку в Formspree.

CORS уже разрешает `https://antoniolga.ru` и `http://localhost`.

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
