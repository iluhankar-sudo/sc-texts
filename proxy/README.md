# sc texts proxy

A small Cloudflare Worker that keeps the Groq key server-side and forwards the extension's requests to Groq (speech recognition, translation and lyrics correction). Thanks to it the extension works for other people without their own key, and nobody sees your key.

## How it protects your limits

- forwards only recognition (`/v1/audio/transcriptions`) and chat (`/v1/chat/completions`);
- only allowed models (`ALLOWED_TRANSCRIBE_MODELS`, `ALLOWED_CHAT_MODELS` in `wrangler.toml`);
- audio up to 25 MB, chat replies up to 4000 tokens;
- at most 40 requests per minute from one address (`[[ratelimits]]` in `wrangler.toml`);
- if the `APP_TOKEN` secret is set, requests without it are rejected. This only stops casual visitors: the token is embedded in the extension and can be extracted from it.

All proxy users share your Groq limits. The free plan is enough for a few people; with many users Groq will start answering "too many requests".

## Automatic deployment (GitHub Actions)

In the repository: Settings → Secrets and variables → Actions → New repository secret:

| Secret | What it is |
|---|---|
| `GROQ_KEY` | Groq API key (console.groq.com → API Keys) |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages → "Account ID" on the right |
| `APP_TOKEN` | optional: any long string |

After the next push to `master` (or Actions → "Build and release" → Run workflow) the proxy deploys itself and its URL is embedded in the extension build in Releases.

Before the first deployment, open Workers & Pages in Cloudflare once: it creates your `*.workers.dev` subdomain.

## Manual deployment

```
cd proxy
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROQ_KEY
```

Check: open `https://sc-texts-proxy.<your-subdomain>.workers.dev/health`, it should return `{"ok":true,...,"key":true}`.

If Cloudflare refuses to create the rate limit (`ratelimits`) on your plan, remove the `[[ratelimits]]` block from `wrangler.toml`; the proxy keeps working without it.

## Tests

```
node --test test/proxy.test.js
```
