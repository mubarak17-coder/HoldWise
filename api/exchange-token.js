const { plaidClient, supabase, getUser, checkRateLimit, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip, 5, 60000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const { public_token } = req.body;
    if (!public_token || typeof public_token !== 'string') {
      return res.status(400).json({ error: 'Invalid public_token' });
    }
    const response = await plaidClient.itemPublicTokenExchange({ public_token });

    // Store token in Supabase user metadata (per-user, not global)
    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        plaid_access_token: response.data.access_token,
        plaid_item_id: response.data.item_id,
      },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to exchange token' });
  }
};
