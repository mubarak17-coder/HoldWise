const { plaidClient, Products, CountryCode, getUser, checkRateLimit, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip, 10, 60000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const request = {
      user: { client_user_id: user.id },
      client_name: 'Holdwise',
      products: [Products.Transactions],
      country_codes: ['DE'],
      language: 'de',
      link_customization_name: 'holdwise',
    };

    if (process.env.PLAID_REDIRECT_URI) {
      request.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }

    const response = await plaidClient.linkTokenCreate(request);
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    const detail = error?.response?.data || { message: error.message, stack: error.stack?.split('\n').slice(0, 3) };
    console.error('Plaid linkTokenCreate error:', JSON.stringify(detail));
    res.status(500).json({ error: 'Failed to create link token', detail });
  }
};
