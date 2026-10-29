# Релей анкеты: Vercel → Cloudflare Worker

Зачем: браузеры в некоторых сетях не открывают `*.workers.dev`. Гость отправляет анкету на
`https://api.antoniolga.ru/api/rsvp`, Vercel передаёт запрос в Worker, а Worker сохраняет
гостя в D1 и присылает уведомление в Telegram. База и бот не меняются.

```
Браузер → api.antoniolga.ru (Vercel) → antoniolga-bot.agoglitch.workers.dev → D1 + Telegram
```

## Файлы

- `api/rsvp.js` — приём анкеты и передача в Worker.
- `api/health.js` — проверка, что Worker отвечает.
- `vercel.json` — лимит времени функции.

## 1. Вход в Vercel

```powershell
npm install -g vercel
vercel login
```

Откроется страница `https://vercel.com/device` — войдите через GitHub и подтвердите код.

## 2. Деплой

Из папки `relay`:

```powershell
vercel --prod
```

Первый запуск спросит название проекта и папку — согласитесь с предложенными
(`relay`, текущая папка). После деплоя появится адрес вида
`https://relay-xxxx.vercel.app`.

Проверка:

```text
https://relay-xxxx.vercel.app/api/health
```

Должно вернуться `{"ok":true,"db":true,"bot":true,"contestCode":true}`.

## 3. Свой адрес api.antoniolga.ru

В панели Vercel: **Project → Settings → Domains → Add** → `api.antoniolga.ru`.

Vercel покажет запись для DNS. В reg.ru (управление DNS домена `antoniolga.ru`) добавьте:

| Тип | Имя | Значение |
|---|---|---|
| CNAME | `api` | `cname.vercel-dns.com` |

Проверка после обновления DNS (обычно 5–30 минут):

```text
https://api.antoniolga.ru/api/health
```

## 4. Подключение на сайте

В `index.html` заменить адрес:

```js
const RSVP_ENDPOINT = "https://api.antoniolga.ru/api/rsvp";
```

Резерв через Formspree остаётся: если релей недоступен, анкета уйдёт напрямую в Formspree.

## Переменные окружения (необязательно)

- `WORKER_URL` — адрес приёма анкет (по умолчанию текущий Worker).
- `WORKER_HEALTH` — адрес проверки Worker.

## Ограничения

- Бесплатный тариф Vercel: 100 ГБ трафика и 100 000 вызовов функций в месяц — для свадьбы
  с запасом.
- Релей принимает запросы только с `https://antoniolga.ru`, `https://www.antoniolga.ru`
  и `localhost`.
