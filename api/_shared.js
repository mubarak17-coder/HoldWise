const { createClient } = require('@supabase/supabase-js');
const { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } = require('plaid');

// Supabase (server-side)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Plaid
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

// Auth middleware
async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// Rate limiter (in-memory, resets per cold start on Vercel)
const attempts = new Map();
function checkRateLimit(ip, max, windowMs) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= max) return false;
    entry.count++;
  } else {
    attempts.set(ip, { count: 1, resetAt: now + windowMs });
  }
  return true;
}

// CORS headers
function setCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const origin = req.headers.origin || '';
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

module.exports = { supabase, plaidClient, Products, CountryCode, getUser, checkRateLimit, setCors };
