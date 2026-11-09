# Fluxy — Paystack server verification

## What this implements
- Server-owned product prices, delivery fees and coupon rules.
- A pending order/reference is stored in SQLite before opening Paystack Popup.
- The browser callback sends only the Paystack reference to the server.
- The server calls Paystack Verify Transaction using the secret key and checks `data.status`, `reference`, `amount`, and `currency` against the stored order.
- The order is marked paid only after all checks pass. Repeated verification of an already-paid reference is idempotent.

## Setup (Windows / VS Code)
1. Install Node.js 20 LTS or newer.
2. Open this folder in VS Code.
3. In the terminal run `npm install`.
4. Copy `.env.example` to `.env`.
5. In `.env`, replace the example with your Paystack **test secret key** (`sk_test_...`). Never put this key in `index.html`, GitHub, or any frontend file.
6. Run `npm run dev` (or `npm start`).
7. Open `http://localhost:<PORT>` (the port set in your `.env`, or the server default). Do not open `index.html` directly with `file://`; the API must be served from the same origin.

## Important configuration
- The browser currently has a Paystack **public test key** in `public/index.html`. Keep the public key there; it is designed to be public. Replace it with your live public key only when you are ready for production.
- The server catalogue and shipping/coupon rules are copied from the supplied Fluxy page. Update `PRODUCTS`, `DELIVERY`, and `COUPONS` in `server.js` whenever prices or business rules change. The backend is authoritative.
- The existing storefront still stores its customer-facing order history in browser localStorage. The backend additionally stores pending/paid transaction records in SQLite. For a production store, build admin order management and fulfillment on top of the server database rather than trusting localStorage.
- Configure HTTPS, a persistent disk/database, backups, and production environment variables when deploying. Do not deploy the test keys.

## Test checklist
1. Use Paystack test keys and a Paystack test payment method.
2. Complete checkout; check the browser Network tab: `/api/payments/prepare` then `/api/payments/verify` should both return success.
3. Confirm the SQLite row changes from `pending` to `paid`.
4. Try a made-up reference, a failed transaction, and a modified amount in a test environment; none should create a paid order.
5. Confirm an order is not shown as paid when verification fails.

## Paystack API
The server uses `GET https://api.paystack.co/transaction/verify/:reference` with `Authorization: Bearer <secret key>`.
