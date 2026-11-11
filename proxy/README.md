# Сервер-посредник sc texts

Маленький Cloudflare Worker: держит ключ Groq у себя и пересылает в Groq запросы расширения
(распознавание звука и запасной перевод). Благодаря ему расширение работает у других людей
без своего ключа, а ваш ключ никто не видит.

## Как он защищает ваши лимиты

- пересылает только распознавание (`/v1/audio/transcriptions`) и перевод (`/v1/chat/completions`);
- только разрешённые модели (`ALLOWED_TRANSCRIBE_MODELS`, `ALLOWED_CHAT_MODELS` в `wrangler.toml`);
- звук не больше 25 МБ, ответ перевода не длиннее 4000 токенов;
- не больше 40 запросов в минуту с одного адреса (`[[ratelimits]]` в `wrangler.toml`);
- если задан секрет `APP_TOKEN`, запросы без него отклоняются. Это защита от случайных посетителей:
  токен вшит в расширение, и при желании его можно оттуда достать.

Лимиты Groq у всех пользователей посредника общие — ваши. Бесплатного плана хватит на несколько
человек; если пользователей станет много, Groq начнёт отвечать «слишком много запросов».

## Развёртывание автоматически (GitHub Actions)

В репозитории: Settings → Secrets and variables → Actions → New repository secret:

| Секрет | Что это |
|---|---|
| `GROQ_KEY` | ключ Groq (console.groq.com → API Keys) |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → шаблон «Edit Cloudflare Workers» |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages → справа «Account ID» |
| `APP_TOKEN` | необязательно: любая длинная строка |

После следующего push в `master` (или Actions → «Сборка и выпуск» → Run workflow) посредник
развернётся сам, а его адрес вшьётся в сборку расширения в Releases.

Перед первым развёртыванием откройте в Cloudflare раздел Workers & Pages один раз —
он создаст ваш поддомен `*.workers.dev`.

## Развёртывание вручную

```
cd proxy
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROQ_KEY
```

Проверка: откройте `https://sc-texts-proxy.<ваш-поддомен>.workers.dev/health` — должно быть `{"ok":true,...,"key":true}`.

Если Cloudflare откажется создавать ограничение запросов (`ratelimits`) на вашем тарифе — удалите
блок `[[ratelimits]]` из `wrangler.toml`; посредник продолжит работать без него.

## Тесты

```
node --test test/proxy.test.js
```
