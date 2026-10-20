const { createClient } = require('redis');
let cliente;
async function banco() {
  if (!cliente) { const c = createClient({ url: process.env.REDIS_URL }); c.on('error', () => {}); await c.connect(); cliente = c; }
  return cliente;
}
const valido = c => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c);
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const db = await banco();
    if (req.method === 'GET') {
      const c = String(req.query.c || '').toUpperCase();
      if (!valido(c)) { res.status(400).json({ erro: 'codigo' }); return; }
      const v = await db.get('sync:' + c);
      res.status(200).json(v ? JSON.parse(v) : { t: 0 });
      return;
    }
    if (req.method === 'POST') {
      let b = req.body; if (typeof b === 'string') b = JSON.parse(b);
      const c = String((b && b.c) || '').toUpperCase();
      if (!valido(c) || typeof b.t !== 'number' || !b.d) { res.status(400).json({ erro: 'dados' }); return; }
      await db.set('sync:' + c, JSON.stringify({ t: b.t, d: b.d }));
      res.status(200).json({ ok: true, t: b.t });
      return;
    }
    res.status(405).end();
  } catch (e) { cliente = null; res.status(500).json({ erro: String(e && e.message || e) }); }
};
