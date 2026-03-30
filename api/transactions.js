const { plaidClient, supabase, getUser, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  try {
    const accessToken = user.user_metadata?.plaid_access_token;
    if (!accessToken) {
      return res.json({ transactions: [] });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    let attempts = 0;
    while (attempts < 5) {
      try {
        const response = await plaidClient.transactionsGet({
          access_token: accessToken,
          start_date: thirtyDaysAgo.toISOString().split('T')[0],
          end_date: now.toISOString().split('T')[0],
          options: { count: 50, offset: 0 },
        });
        return res.json({ transactions: response.data.transactions });
      } catch (e) {
        if (e.response?.data?.error_code === 'PRODUCT_NOT_READY' && attempts < 4) {
          attempts++;
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw e;
        }
      }
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};
