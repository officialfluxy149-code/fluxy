const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DB_PATH || './fluxy-payments.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  reference TEXT PRIMARY KEY,
  order_number TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_kobo INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payload TEXT NOT NULL,
  paystack_transaction_id TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
)`);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Server-owned catalogue: never accept product prices from the browser.
const PRODUCTS = {
  black: { name: 'Original Base T-Shirt', color: 'Black', price: 250 },
  white: { name: 'Original Base T-Shirt', color: 'White', price: 250 },
  naruto_black: { name: 'Fluxy Naruto White T-Shirt', color: 'Navy', price: 250 },
  naruto_white: { name: 'Fluxy Naruto White T-Shirt', color: 'Navy', price: 250 }
};
const DELIVERY = {
  'Greater Accra': { standard: 25, express: 45 }, 'Ashanti': { standard: 35, express: 55 },
  'Central': { standard: 30, express: 50 }, 'Western': { standard: 35, express: 55 },
  'Eastern': { standard: 30, express: 50 }, 'Volta': { standard: 35, express: 55 },
  'Northern': { standard: 45 }, 'Upper East': { standard: 50 }, 'Upper West': { standard: 50 },
  'Bono': { standard: 40 }, 'Bono East': { standard: 40 }, 'Ahafo': { standard: 40 },
  'Western North': { standard: 40 }, 'Oti': { standard: 40 }, 'Savannah': { standard: 50 }, 'North East': { standard: 50 }
};
const COUPONS = {
  FLOW10: { type: 'percent', value: 10 },
  ACCRA15: { type: 'percent', value: 15, region: 'Greater Accra' },
  FLAT50: { type: 'fixed', value: 50 }
};
const insertOrder = db.prepare(`INSERT INTO orders
(reference, order_number, status, amount_kobo, currency, payload, created_at)
VALUES (@reference, @order_number, 'pending', @amount_kobo, 'GHS', @payload, @created_at)`);
const getOrder = db.prepare('SELECT * FROM orders WHERE reference = ?');
const markPaid = db.prepare(`UPDATE orders SET status='paid', paystack_transaction_id=?, paid_at=? WHERE reference=? AND status='pending'`);

function cleanText(value, max=200) { return String(value ?? '').trim().slice(0, max); }
function fail(res, code, message) { return res.status(code).json({ success:false, message }); }

app.post('/api/payments/prepare', (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return fail(res, 500, 'Payment server is not configured.');
    const { email, phone, name, items, region, deliveryMethod, couponCode, shipping, momoProvider } = req.body || {};
    if (!/^\S+@\S+\.\S+$/.test(cleanText(email, 180))) return fail(res, 400, 'A valid email is required.');
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) return fail(res, 400, 'Invalid cart items.');
    if (!['standard','express','pickup'].includes(deliveryMethod)) return fail(res, 400, 'Invalid delivery method.');
    if (!['mtn','vodafone','airteltigo'].includes(momoProvider)) return fail(res, 400, 'Invalid Mobile Money provider.');

    const normalizedItems = [];
    let subtotal = 0;
    for (const item of items) {
      const product = PRODUCTS[item.productId];
      const qty = Number(item.quantity);
      const size = cleanText(item.size, 8);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 10 || !['XS','S','M','L','XL','2XL'].includes(size)) {
        return fail(res, 400, 'One or more cart items are invalid.');
      }
      const line = product.price * qty;
      subtotal += line;
      normalizedItems.push({ key: `${item.productId}-${size}`, pid:item.productId, name:product.name, color:product.color, size, price:product.price, qty });
    }
    let discount = 0;
    let coupon = null;
    if (couponCode) {
      const code = cleanText(couponCode, 30).toUpperCase();
      const rule = COUPONS[code];
      if (!rule) return fail(res, 400, 'Coupon is invalid.');
      if (rule.region && region !== rule.region) return fail(res, 400, 'This coupon is not valid for your delivery region.');
      discount = rule.type === 'percent' ? subtotal * rule.value / 100 : rule.value;
      discount = Math.min(subtotal, discount);
      coupon = { code, type:rule.type, value:rule.value };
    }
    let delivery = 0;
    if (deliveryMethod !== 'pickup') {
      const fees = DELIVERY[region];
      if (!fees || fees[deliveryMethod] == null) return fail(res, 400, 'That delivery option is unavailable for the selected region.');
      delivery = fees[deliveryMethod];
    }
    const total = Math.max(0, subtotal - discount + delivery);
    const amountKobo = Math.round(total * 100);
    if (!Number.isSafeInteger(amountKobo) || amountKobo < 100) return fail(res, 400, 'Payment amount is invalid.');

    const reference = `FLX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const orderNumber = `FLX-GH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const payload = {
      orderNumber, items:normalizedItems,
      totals:{ subtotal, discount, shipping:delivery, total },
      shipping:{ name:cleanText(name,120), email:cleanText(email,180), phone:cleanText(phone,30),
        address:cleanText(shipping?.address,250), city:cleanText(shipping?.city,100),
        district:cleanText(shipping?.district,100), region:cleanText(region,80), gps:cleanText(shipping?.gps,80) },
      deliveryMethod, coupon, momoProvider
    };
    insertOrder.run({ reference, order_number:orderNumber, amount_kobo:amountKobo, payload:JSON.stringify(payload), created_at:new Date().toISOString() });
    res.json({ success:true, reference, amount:amountKobo, currency:'GHS' });
  } catch (error) {
    console.error('Prepare payment error:', error);
    fail(res, 500, 'Could not prepare payment. Please try again.');
  }
});

app.post('/api/payments/verify', async (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return fail(res, 500, 'Payment server is not configured.');
    const reference = cleanText(req.body?.reference, 100);
    if (!/^FLX-[A-Z0-9-]+$/.test(reference)) return fail(res, 400, 'Invalid payment reference.');
    const order = getOrder.get(reference);
    if (!order) return fail(res, 404, 'Payment reference was not found.');
    if (order.status === 'paid') {
      return res.json({ success:true, verified:true, order:buildVerifiedOrder(order) });
    }
    if (order.status !== 'pending') return fail(res, 409, 'This order cannot be verified.');

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const result = await response.json();
    if (!response.ok || !result.status || !result.data) return fail(res, 502, 'Paystack could not verify this transaction.');
    const tx = result.data;
    // All checks are against the server-stored order, never values sent back by the browser.
    if (tx.status !== 'success') return fail(res, 402, `Payment is not successful (status: ${tx.status || 'unknown'}).`);
    if (tx.reference !== reference) return fail(res, 400, 'Transaction reference mismatch.');
    if (tx.currency !== order.currency) return fail(res, 400, 'Transaction currency does not match the order.');
    if (Number(tx.amount) !== Number(order.amount_kobo)) return fail(res, 400, 'Paid amount does not match the order total.');

    const paidAt = tx.paid_at || new Date().toISOString();
    markPaid.run(String(tx.id), paidAt, reference);
    const updated = getOrder.get(reference);
    res.json({ success:true, verified:true, order:buildVerifiedOrder(updated) });
  } catch (error) {
    console.error('Verify payment error:', error);
    fail(res, 500, 'Payment verification failed. Please contact support with your reference.');
  }
});

function buildVerifiedOrder(row) {
  const payload = JSON.parse(row.payload);
  return { reference:row.reference, orderNumber:row.order_number, paidAt:row.paid_at,
    items:payload.items, totals:payload.totals, shipping:payload.shipping,
    deliveryMethod:payload.deliveryMethod, coupon:payload.coupon, momoProvider:payload.momoProvider,
    paymentStatus:row.status };
}

app.get('/health', (_req,res) => res.json({ ok:true }));
app.listen(PORT, () => console.log(`Fluxy payment server listening on http://localhost:${PORT}`));
