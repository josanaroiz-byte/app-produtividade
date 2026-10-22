const { createClient } = require('redis');
let cliente;
async function banco() {
  if (!cliente) { const c = createClient({ url: process.env.REDIS_URL }); c.on('error', () => {}); await c.connect(); cliente = c; }
  return cliente;
}
const valido = c => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c);
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).end(); return; }
  try {
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b);
    const c = String((b && b.c) || '').toUpperCase();
    if (!valido(c)) { res.status(400).json({ erro: 'codigo' }); return; }
    const db = await banco();
    if (b.sair) {
      const us = await db.sMembers('alexaU:' + c);
      for (const u of us) await db.del('alexa:' + u);
      await db.del('alexaU:' + c);
      res.status(200).json({ ok: true });
      return;
    }
    let pin = '';
    for (let i = 0; i < 10; i++) {
      pin = String(Math.floor(100000 + Math.random() * 900000));
      if (await db.set('pin:' + pin, c, { NX: true, EX: 1800 })) break;
    }
    res.status(200).json({ pin, exp: Date.now() + 1800 * 1000 });
  } catch (e) { cliente = null; res.status(500).json({ erro: String(e && e.message || e) }); }
};
