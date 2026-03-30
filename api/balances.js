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
      return res.json({ accounts: [], total_balance: 0 });
    }
    const response = await plaidClient.accountsBalanceGet({ access_token: accessToken });
    const accounts = response.data.accounts;
    const total_balance = accounts.reduce((sum, a) => sum + (a.balances.current || 0), 0);
    res.json({ accounts, total_balance });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
};
