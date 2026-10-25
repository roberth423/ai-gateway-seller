# AI Gateway — Sell AI Access via One API Key

Multi-provider AI proxy. Users register, get one API key + balance, and call any configured model through a single OpenAI-compatible endpoint. Admin manages users, providers, and top-ups.

## New features (added)
- Stripe Checkout for subscription (PayG / Pro) with $20 credit on first purchase
- Stripe webhook to credit subscription
- Rate limiting (120 requests/min per user)
- Subscription management in dashboard
- PDF invoice generation for transactions

## Stack
- Hono (Node 22)
- better-sqlite3 + volume on Railway
- bcryptjs
- stripe + pdfkit + rate-limiter-flexible

## Deploy
1. `git add . && git commit -m "add subscription + stripe + pdf"`
2. Push to GitHub
3. Railway → Deploy from GitHub repo
4. Add Volume `/data`
5. Set env vars: `DATABASE_PATH=/data/app.db`, `ADMIN_PASSWORD`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PAYG_PRICE_ID`

## Usage
Register → get `api_key`  
Subscribe → checkout page  
Use in OpenAI SDK with `baseURL` = your Railway URL + `/v1`

## Next
- Add more plans
- Invoice PDF download
- Webhook for subscription renewal

## Full README
(Previous README still valid + new sections above)
