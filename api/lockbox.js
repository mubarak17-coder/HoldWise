const { supabase, getUser, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('savings_lockbox')
      .select('balance, goal')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: 'Failed to fetch lockbox' });
    }
    return res.json(data || { balance: 0, goal: 5000 });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const update = { user_id: user.id };
    if (body.balance !== undefined) update.balance = Math.max(0, parseFloat(body.balance) || 0);
    if (body.goal !== undefined) update.goal = Math.max(0.01, parseFloat(body.goal) || 5000);

    const { data, error } = await supabase
      .from('savings_lockbox')
      .upsert(update, { onConflict: 'user_id' })
      .select('balance, goal')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to update lockbox' });
    return res.json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
