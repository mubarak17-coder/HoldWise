require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } = require('plaid');

const app = express();

// --- CORS: restrict to known origins ---
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

app.use(express.json());

// --- Rate limiting ---
const loginAttempts = new Map(); // key: IP, value: { count, resetAt }

function rateLimiter(maxAttempts, windowMs) {
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const entry = loginAttempts.get(ip);

    if (entry && now < entry.resetAt) {
      if (entry.count >= maxAttempts) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        return res.status(429).json({
          error: `Too many requests. Try again in ${retryAfter} seconds.`,
        });
      }
      entry.count++;
    } else {
      loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    }
    next();
  };
}

// Clean up expired rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now >= entry.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

// --- Supabase server client (for verifying JWTs) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// --- Auth middleware: verify Supabase JWT on protected routes ---
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  if (!supabase) {
    return res.status(500).json({ error: 'Auth service not configured' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// --- Plaid client setup ---
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);


// --- Static files (exclude protected pages) ---
app.use(express.static(path.join(__dirname), {
  index: false, // don't auto-serve index.html for /
}));

// --- Public pages ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// Dashboard: served as static file, but auth is enforced on all /api/* routes
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// --- Protected API routes (all require valid Supabase JWT) ---

// Rate-limited: max 5 requests per minute per IP for token creation
app.post('/api/create-link-token', requireAuth, rateLimiter(10, 60000), async (req, res) => {
  try {
    const request = {
      user: { client_user_id: req.user.id },
      client_name: 'Holdwise',
      products: [Products.Transactions],
      country_codes: [CountryCode.De],
      language: 'de',
      link_customization_name: 'holdwise',
    };

    if (process.env.PLAID_REDIRECT_URI) {
      request.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }

    const response = await plaidClient.linkTokenCreate(request);
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    const detail = error?.response?.data || { message: error.message };
    console.error('Plaid linkTokenCreate error:', JSON.stringify(detail));
    res.status(500).json({ error: 'Failed to create link token', detail });
  }
});

app.post('/api/exchange-token', requireAuth, rateLimiter(5, 60000), async (req, res) => {
  try {
    const { public_token } = req.body;
    if (!public_token || typeof public_token !== 'string') {
      return res.status(400).json({ error: 'Invalid public_token' });
    }
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;

    // Fetch institution name for display
    let institution_name = null;
    try {
      const itemResponse = await plaidClient.itemGet({ access_token });
      const instId = itemResponse.data.item.institution_id;
      if (instId) {
        const instResponse = await plaidClient.institutionsGetById({
          institution_id: instId,
          country_codes: ['DE'],
        });
        institution_name = instResponse.data.institution.name;
      }
    } catch (_) { /* non-critical */ }

    // Upsert into plaid_items table (supports multiple banks per user)
    const { error: dbError } = await supabase
      .from('plaid_items')
      .upsert({
        user_id: req.user.id,
        item_id,
        access_token,
        institution_name,
      }, { onConflict: 'item_id' });

    if (dbError) {
      console.error('Supabase upsert error:', dbError);
      return res.status(500).json({ error: 'Failed to store bank connection' });
    }

    res.json({ success: true, institution_name });
  } catch (error) {
    console.error('Exchange token error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

app.get('/api/balances', requireAuth, async (req, res) => {
  try {
    const { data: items, error: dbError } = await supabase
      .from('plaid_items')
      .select('access_token, institution_name')
      .eq('user_id', req.user.id);

    if (dbError) return res.status(500).json({ error: 'Failed to fetch linked accounts' });
    if (!items || items.length === 0) return res.json({ accounts: [], total_balance: 0 });

    const results = await Promise.allSettled(
      items.map(async (item) => {
        const response = await plaidClient.accountsBalanceGet({ access_token: item.access_token });
        return response.data.accounts.map(a => ({ ...a, institution_name: item.institution_name }));
      })
    );

    const accounts = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    const total_balance = accounts.reduce((sum, a) => sum + (a.balances.current || 0), 0);
    res.json({ accounts, total_balance });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const { data: items, error: dbError } = await supabase
      .from('plaid_items')
      .select('access_token, institution_name')
      .eq('user_id', req.user.id);

    if (dbError) return res.status(500).json({ error: 'Failed to fetch linked accounts' });
    if (!items || items.length === 0) return res.json({ transactions: [] });

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const results = await Promise.allSettled(
      items.map(async (item) => {
        let attempts = 0;
        while (attempts < 5) {
          try {
            const response = await plaidClient.transactionsGet({
              access_token: item.access_token,
              start_date: startDate,
              end_date: endDate,
              options: { count: 100, offset: 0 },
            });
            return response.data.transactions.map(t => ({ ...t, institution_name: item.institution_name }));
          } catch (e) {
            if (e.response?.data?.error_code === 'PRODUCT_NOT_READY' && attempts < 4) {
              attempts++;
              await new Promise(r => setTimeout(r, 2000));
            } else {
              throw e;
            }
          }
        }
        return [];
      })
    );

    const transactions = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/lockbox', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('savings_lockbox')
    .select('balance, goal')
    .eq('user_id', req.user.id)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: 'Failed to fetch lockbox' });
  res.json(data || { balance: 0, goal: 5000 });
});

app.post('/api/lockbox', requireAuth, async (req, res) => {
  const body = req.body || {};
  const update = { user_id: req.user.id };
  if (body.balance !== undefined) update.balance = Math.max(0, parseFloat(body.balance) || 0);
  if (body.goal !== undefined) update.goal = Math.max(0.01, parseFloat(body.goal) || 5000);
  const { data, error } = await supabase
    .from('savings_lockbox')
    .upsert(update, { onConflict: 'user_id' })
    .select('balance, goal')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to update lockbox' });
  res.json(data);
});

app.get('/api/goals', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('savings_goals')
    .select('id, name, icon, current_amount, target_amount, color')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to fetch goals' });
  res.json(data || []);
});

app.post('/api/goals', requireAuth, async (req, res) => {
  const { name, icon, target_amount, color } = req.body || {};
  if (!name || !target_amount) return res.status(400).json({ error: 'name and target_amount are required' });
  const { data, error } = await supabase
    .from('savings_goals')
    .insert({
      user_id: req.user.id,
      name: String(name).slice(0, 100),
      icon: String(icon || '🎯').slice(0, 10),
      target_amount: Math.max(0.01, parseFloat(target_amount)),
      color: String(color || '#6C5CE7').slice(0, 20),
      current_amount: 0,
    })
    .select('id, name, icon, current_amount, target_amount, color')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to create goal' });
  res.status(201).json(data);
});

app.patch('/api/goals', requireAuth, async (req, res) => {
  const { id, name, icon, current_amount, target_amount, color } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const update = {};
  if (name !== undefined) update.name = String(name).slice(0, 100);
  if (icon !== undefined) update.icon = String(icon).slice(0, 10);
  if (current_amount !== undefined) update.current_amount = Math.max(0, parseFloat(current_amount) || 0);
  if (target_amount !== undefined) update.target_amount = Math.max(0.01, parseFloat(target_amount));
  if (color !== undefined) update.color = String(color).slice(0, 20);
  const { data, error } = await supabase
    .from('savings_goals')
    .update(update)
    .eq('id', id)
    .eq('user_id', req.user.id)
    .select('id, name, icon, current_amount, target_amount, color')
    .single();
  if (error) return res.status(500).json({ error: 'Failed to update goal' });
  res.json(data);
});

app.delete('/api/goals', requireAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const { error } = await supabase
    .from('savings_goals')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Failed to delete goal' });
  res.json({ success: true });
});

app.get('/api/linked-banks', requireAuth, async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from('plaid_items')
      .select('item_id, institution_name')
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Failed to fetch linked banks' });
    res.json({ banks: items || [] });
  } catch {
    res.status(500).json({ error: 'Failed to fetch linked banks' });
  }
});

app.delete('/api/disconnect-bank', requireAuth, rateLimiter(5, 60000), async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id || typeof item_id !== 'string') {
      return res.status(400).json({ error: 'Invalid item_id' });
    }

    const { data: item, error: fetchError } = await supabase
      .from('plaid_items')
      .select('access_token')
      .eq('item_id', item_id)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !item) {
      return res.status(404).json({ error: 'Bank connection not found' });
    }

    try {
      await plaidClient.itemRemove({ access_token: item.access_token });
    } catch (_) { /* non-critical */ }

    const { error: deleteError } = await supabase
      .from('plaid_items')
      .delete()
      .eq('item_id', item_id)
      .eq('user_id', req.user.id);

    if (deleteError) return res.status(500).json({ error: 'Failed to remove bank connection' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to disconnect bank' });
  }
});

app.delete('/api/delete-account', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    // Delete Plaid items (access tokens) first
    await supabase.from('plaid_items').delete().eq('user_id', userId);

    // Delete the auth user via admin API
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      console.error('Delete user error:', error);
      return res.status(500).json({ error: 'Failed to delete account' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
