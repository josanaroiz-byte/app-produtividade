module.exports = async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(url)) { res.status(400).send('link inválido'); return; }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Produtividade' } });
    const t = await r.text();
    if (!r.ok || !t.includes('BEGIN:VCALENDAR')) { res.status(404).send('agenda não encontrada'); return; }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(t);
  } catch (e) { res.status(502).send('erro ao ler a agenda'); }
};
