# AKS Digital Products Market
Storefront + admin dashboard on the AIVault Hub Reseller API (Node 18+).

## Run
1. `cp .env.example .env` and fill in AIVAULT_API_KEY, ADMIN_PASSWORD, PAY_INFO
2. `npm install && npm start` → http://localhost:3000 (Dashboard tab = admin)

## How it works
- Customer picks a product, pays you via KPay/WavePay/CBPay, enters the transaction ID → order is `pending_review`.
- You press **Confirm** in the dashboard → the server calls `POST /order` (with `external_order_id`, so retries never double-debit) and the keys are released to the customer's Track page.
- Webhook: register `https://YOUR-DOMAIN/webhooks/aivault` via `POST /webhooks`, put the returned secret in `WEBHOOK_SECRET`.
- Deploy behind HTTPS (Render, Railway, VPS). Orders are stored in `data.json`.
