require('dotenv').config();
const express = require('express'), crypto = require('crypto'), fs = require('fs');
const { AIVAULT_API_KEY: KEY, ADMIN_PASSWORD: ADMIN, WEBHOOK_SECRET = '', PAY_INFO = '', PORT = 3000 } = process.env;
const MARKUP = +(process.env.MARKUP || 0.3), MMK = +(process.env.MMK_RATE || 4500);
if (!KEY || !ADMIN) { console.error('Set AIVAULT_API_KEY and ADMIN_PASSWORD in .env'); process.exit(1); }
const BASE = 'https://reseller.aivaulthub.store/api/v1', DB = 'data.json';
let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { orders: [] };
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 1));
// All AIVault calls happen here, server-side. The key never reaches the browser.
const api = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' } });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  return { status: r.status, data };
};
const CATS = [['AI', /gpt|gemini|grok|perplex|kimi|cursor|poe|claude|ai/i], ['Design', /canva|capcut|remini|suno/i],
  ['Social', /telegram|tiktok|youtube|netflix|spotify/i], ['Accounts', /email|gmail|edu/i], ['Software', /vpn|windows|office|key/i]];
const cat = n => (CATS.find(c => c[1].test(n)) || ['Other'])[0];
const sell = c => Math.round(c * (1 + MARKUP) * 100) / 100;
let cache = { t: 0, v: null };
const app = express();
app.use('/webhooks/aivault', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '50kb' })); app.use(express.static('public'));
const hits = {};
const limit = (req, res, next) => { const k = req.ip, n = Date.now(); hits[k] = (hits[k] || []).filter(t => n - t < 60000);
  if (hits[k].length >= 20) return res.status(429).json({ error: 'Too many requests' }); hits[k].push(n); next(); };

app.get('/api/config', (_, r) => r.json({ mmkRate: MMK, payInfo: PAY_INFO.split('|').map(s => s.trim()).filter(Boolean) }));

app.get('/api/products', async (_, res) => {
  if (Date.now() - cache.t > 30000) {
    const r = await api('/products').catch(() => null);
    if (!r || r.status !== 200) return res.status(502).json({ error: 'Catalog unavailable' });
    cache = { t: Date.now(), v: r.data.products.map(p => { const t = (p.pricing_tiers || [])[0];
      const usd = sell(t ? t.price : 0); return { id: p.service_id, name: p.name, stock: p.stock, category: cat(p.name), usd, mmk: Math.round(usd * MMK) }; }) };
  }
  res.json(cache.v);
});

app.post('/api/checkout', limit, async (req, res) => {
  const { service_id, quantity, name, contact, method, txnRef } = req.body || {};
  const q = parseInt(quantity, 10);
  if (!service_id || !(q >= 1 && q <= 20) || !name || !contact || !method || !txnRef)
    return res.status(400).json({ error: 'Please fill in all fields' });
  const qt = await api(`/quote?service_id=${encodeURIComponent(service_id)}&quantity=${q}`);
  if (qt.status !== 200) return res.status(400).json({ error: 'Product unavailable' });
  if (qt.data.stock < q) return res.status(409).json({ error: 'Not enough stock' });
  const cost = qt.data.pricing.final_total, price = sell(cost);
  const o = { id: 'AKS' + crypto.randomBytes(4).toString('hex').toUpperCase(), service_id, product: qt.data.service_name, quantity: q,
    cost, price, mmk: Math.round(price * MMK), name: String(name).slice(0, 80), contact: String(contact).slice(0, 80),
    method: String(method).slice(0, 20), txnRef: String(txnRef).slice(0, 80), status: 'pending_review', keys: [], created: new Date().toISOString() };
  db.orders.unshift(o); save();
  res.status(201).json({ id: o.id, usd: o.price, mmk: o.mmk });
});

app.get('/api/track', limit, (req, res) => {
  const o = db.orders.find(x => x.id === String(req.query.id || '').toUpperCase());
  if (!o || o.contact.toLowerCase() !== String(req.query.contact || '').toLowerCase()) return res.status(404).json({ error: 'Order not found' });
  res.json({ id: o.id, product: o.product, quantity: o.quantity, status: o.status, keys: o.status === 'delivered' ? o.keys : [] });
});

const auth = (req, res, next) => { const a = Buffer.from(req.get('x-admin') || ''), b = Buffer.from(ADMIN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next(); res.status(401).json({ error: 'Unauthorized' }); };

app.get('/api/admin/summary', auth, async (_, res) => {
  const [me, stats] = await Promise.all([api('/me'), api('/stats')]);
  const d = db.orders.filter(o => o.status === 'delivered');
  res.json({ balance: me.data.balance, stats: stats.data,
    revenue: d.reduce((s, o) => s + o.price, 0), profit: d.reduce((s, o) => s + o.price - o.cost, 0), orders: db.orders });
});

app.post('/api/admin/orders/:id/confirm', auth, async (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.status === 'delivered') return res.json(o);
  // external_order_id makes retries safe: AIVault never double-debits the same order.
  const r = await api('/order', { method: 'POST', body: JSON.stringify({ service_id: o.service_id, quantity: o.quantity, external_order_id: o.id }) });
  if (r.status === 201 || r.status === 200) { o.status = 'delivered'; o.keys = r.data.products || []; o.cost = r.data.total_cost; o.aivaultId = r.data.order_id; }
  else { o.status = 'needs_action'; o.error = r.data.error || r.data.message || `HTTP ${r.status}`; }
  save(); res.json(o);
});

app.post('/api/admin/orders/:id/reject', auth, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id); if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.status !== 'delivered') { o.status = 'rejected'; save(); } res.json(o);
});

app.get('/api/admin/export', auth, async (_, res) => {
  const r = await fetch(BASE + '/orders/export?format=csv', { headers: { 'X-API-Key': KEY } });
  res.type('text/csv').send(await r.text());
});

// AIVault webhook: verify HMAC-SHA256, then update the matching order.
app.post('/webhooks/aivault', (req, res) => {
  if (WEBHOOK_SECRET) {
    const exp = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex'), got = req.get('X-Webhook-Signature') || '';
    if (exp.length !== got.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(got))) return res.sendStatus(401);
  }
  try {
    const b = JSON.parse(req.body), d = b.data || b, ev = b.event || b.type || '';
    const o = db.orders.find(x => x.id === d.external_order_id);
    if (o) { if (ev === 'order.delivered') { o.status = 'delivered'; if (d.products) o.keys = d.products; }
      else if (ev === 'order.queued') o.status = 'queued'; else if (ev === 'order.failed') o.status = 'needs_action'; save(); }
  } catch {}
  res.sendStatus(200);
});

app.listen(PORT, () => console.log('AKS Digital Products Market on http://localhost:' + PORT));
