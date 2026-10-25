import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

let _stripe = null;
const getStripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' });
  return _stripe;
};

const PRICE_PER_TOKEN = parseFloat(process.env.PRICE_PER_TOKEN || '0.000002');
const RATE_LIMIT_PER_MIN = 120;
const rateLimiter = new RateLimiterMemory({ points: RATE_LIMIT_PER_MIN, duration: 60 });

const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');
app.get('/', (c) => c.html(html));

app.get('/api/health', (c) => c.json({ status: 'ok' }));

// middleware
function bearerAuth(c, next) {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(auth.slice(7));
  if (!user) return c.json({ error: 'Invalid key' }, 401);
  c.set('user', user);
  return next();
}

function requireAdmin(c, next) {
  if (c.get('user')?.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  return next();
}

// rate limit
async function ratelimit(c, next) {
  try {
    await rateLimiter.consume(c.get('user')?.username || 'anon', 1);
    return next();
  } catch {
    return c.json({ error: 'Too many requests' }, 429);
  }
}

// public
app.get('/api/models', (c) => {
  const providers = db.prepare('SELECT id, name, models FROM providers WHERE enabled = 1').all();
  const models = [];
  for (const p of providers) {
    for (const m of JSON.parse(p.models)) models.push({ provider: p.name, model: m });
  }
  return c.json({ models });
});

app.post('/api/register', async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  if (username.length < 3 || password.length < 6) return c.json({ error: 'Min length' }, 400);
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return c.json({ error: 'Username taken' }, 409);
  const hash = bcrypt.hashSync(password, 10);
  const apiKey = 'sk-' + randomBytes(24).toString('hex');
  db.prepare('INSERT INTO users (username, password_hash, api_key) VALUES (?, ?, ?)')
    .run(username, hash, apiKey);
  return c.json({ api_key: apiKey, username, role: 'user' });
});

app.post('/api/login', async (c) => {
  const { username, password } = await c.req.json();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return c.json({ error: 'Invalid credentials' }, 401);
  return c.json({ api_key: user.api_key, username: user.username, role: user.role });
});

// user
app.use('/api/me', bearerAuth);
app.use('/api/usage', bearerAuth);
app.use('/api/subscription', bearerAuth);

app.get('/api/me', (c) => {
  const u = c.get('user');
  return c.json({ id: u.id, username: u.username, role: u.role, balance: u.balance, api_key: u.api_key });
});

app.get('/api/usage', (c) => {
  const u = c.get('user');
  const rows = db.prepare(`
    SELECT u.*, p.name as provider_name FROM usage u
    LEFT JOIN providers p ON p.id = u.provider_id
    WHERE u.user_id = ? ORDER BY u.id DESC LIMIT 100
  `).all(u.id);
  return c.json({ usage: rows });
});

app.post('/api/subscription/create', async (c) => {
  const stripe = getStripe();
  if (!stripe) return c.json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' }, 503);
  const user = c.get('user');
  const { plan } = await c.req.json();
  const priceId = plan === 'pro' ? process.env.STRIPE_PRO_PRICE_ID : process.env.STRIPE_PAYG_PRICE_ID;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${c.req.header('origin')}/dashboard?success=true`,
    cancel_url: `${c.req.header('origin')}/dashboard?canceled=true`,
    customer_email: user.username + '@example.com',
    metadata: { user_id: user.id.toString() }
  });
  return c.json({ url: session.url });
});

app.post('/api/webhooks/stripe', async (c) => {
  const stripe = getStripe();
  if (!stripe) return c.json({ error: 'Stripe not configured.' }, 503);
  const sig = c.req.header('stripe-signature');
  let event;
  try {
    event = stripe.webhooks.constructEvent(await c.req.text(), sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return c.json({ error: 'Invalid signature' }, 400);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = parseInt(session.metadata.user_id);
    db.prepare('UPDATE users SET balance = balance + 20 WHERE id = ?').run(userId); // 20 USD credit
    db.prepare('INSERT INTO subscriptions (user_id, plan, stripe_customer_id, stripe_subscription_id, status) VALUES (?, ?, ?, ?, ?)')
      .run(userId, 'payg', session.customer, session.subscription, 'active');
  }
  return c.json({ received: true });
});

// admin
app.use('/api/admin/*', bearerAuth);

app.get('/api/admin/users', requireAdmin, (c) => {
  const users = db.prepare('SELECT id, username, role, balance, created_at FROM users ORDER BY id').all();
  return c.json({ users });
});

app.post('/api/admin/users/:id/topup', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const { amount } = await c.req.json();
  if (!amount || amount <= 0) return c.json({ error: 'Invalid amount' }, 400);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, id);
  db.prepare('INSERT INTO transactions (user_id, amount, type, note) VALUES (?, ?, ?, ?)')
    .run(id, amount, 'topup', 'Admin topup');
  return c.json({ success: true });
});

app.get('/api/admin/providers', requireAdmin, (c) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY id').all();
  return c.json({ providers });
});

app.post('/api/admin/providers', requireAdmin, async (c) => {
  const { name, base_url, api_key, models } = await c.req.json();
  if (!name || !base_url || !api_key || !Array.isArray(models) || !models.length) return c.json({ error: 'name, base_url, api_key, models[] required' }, 400);
  db.prepare('INSERT INTO providers (name, base_url, api_key, models) VALUES (?, ?, ?, ?)')
    .run(name, base_url, api_key, JSON.stringify(models));
  return c.json({ success: true });
});

app.patch('/api/admin/providers/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const { enabled } = await c.req.json();
  db.prepare('UPDATE providers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return c.json({ success: true });
});

app.delete('/api/admin/providers/:id', requireAdmin, (c) => {
  db.prepare('DELETE FROM providers WHERE id = ?').run(c.req.param('id'));
  return c.json({ success: true });
});

// proxy
app.post('/v1/chat/completions', async (c) => {
  await ratelimit(c);
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(auth.slice(7));
  if (!user) return c.json({ error: 'Invalid key' }, 401);
  if (user.balance <= 0 && !user.role === 'admin') return c.json({ error: 'Insufficient balance. Please top up.' }, 402);

  const body = await c.req.json();
  const model = body.model;
  if (!model) return c.json({ error: 'model required' }, 400);

  const providers = db.prepare('SELECT * FROM providers WHERE enabled = 1').all();
  let provider = null;
  for (const p of providers) {
    if (JSON.parse(p.models).includes(model)) { provider = p; break; }
  }
  if (!provider) return c.json({ error: `Model '${model}' not available` }, 400);

  const upstreamBody = { ...body, model };
  if (body.stream) upstreamBody.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(`${provider.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (e) {
    return c.json({ error: 'Upstream connection failed', detail: e.message }, 502);
  }

  if (!res.ok) return c.json({ error: 'Upstream error', detail: await res.text() }, res.status);

  const deduct = (usage) => {
    const pt = usage?.prompt_tokens || 0;
    const ct = usage?.completion_tokens || 0;
    const cost = (pt + ct) * PRICE_PER_TOKEN;
    db.transaction(() => {
      db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(cost, user.id);
      db.prepare('INSERT INTO usage (user_id, model, provider_id, prompt_tokens, completion_tokens, cost) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, model, provider.id, pt, ct, cost);
      db.prepare('INSERT INTO transactions (user_id, amount, type, note) VALUES (?, ?, ?, ?)')
        .run(user.id, -cost, 'deduct', `Usage: ${model}`);
    })();
  };

  if (body.stream) {
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
      },
      flush() {
        buffer += decoder.decode();
        for (const line of buffer.split('\n')) {
          if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
            try {
              const json = JSON.parse(line.slice(6));
              if (json.usage) usage = json.usage;
            } catch {}
          }
        }
        if (usage) deduct(usage);
      }
    });
    return new Response(res.body.pipeThrough(transform), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }

  const data = await res.json();
  if (data.usage) deduct(data.usage);
  return c.json(data);
});

const port = parseInt(process.env.PORT || '5050', 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`AI Gateway running on port ${port}`);
});
