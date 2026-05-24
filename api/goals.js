const { supabase, getUser, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('savings_goals')
      .select('id, name, icon, current_amount, target_amount, color')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: 'Failed to fetch goals' });
    return res.json(data || []);
  }

  if (req.method === 'POST') {
    const { name, icon, target_amount, color } = req.body || {};
    if (!name || !target_amount) {
      return res.status(400).json({ error: 'name and target_amount are required' });
    }

    const { data, error } = await supabase
      .from('savings_goals')
      .insert({
        user_id: user.id,
        name: String(name).slice(0, 100),
        icon: String(icon || '🎯').slice(0, 10),
        target_amount: Math.max(0.01, parseFloat(target_amount)),
        color: String(color || '#6C5CE7').slice(0, 20),
        current_amount: 0,
      })
      .select('id, name, icon, current_amount, target_amount, color')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to create goal' });
    return res.status(201).json(data);
  }

  if (req.method === 'PATCH') {
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
      .eq('user_id', user.id)
      .select('id, name, icon, current_amount, target_amount, color')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to update goal' });
    return res.json(data);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { error } = await supabase
      .from('savings_goals')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) return res.status(500).json({ error: 'Failed to delete goal' });
    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
