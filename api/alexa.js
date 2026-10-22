// Skill "app produtividade": lê e grava os dados sincronizados do app (Redis, chave sync:CODIGO).
const crypto = require('node:crypto');
const tls = require('node:tls');
const { createClient } = require('redis');

let cliente;
async function banco() {
  if (!cliente) { const c = createClient({ url: process.env.REDIS_URL }); c.on('error', () => {}); await c.connect(); cliente = c; }
  return cliente;
}

// ---------- Verificação de que o pedido veio da Amazon ----------
const certCache = new Map();
function urlCertValida(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 's3.amazonaws.com' &&
      (u.port === '' || u.port === '443') && u.pathname.startsWith('/echo.api/');
  } catch { return false; }
}
async function carregarCadeia(url) {
  if (certCache.has(url)) return certCache.get(url);
  const pem = await (await fetch(url)).text();
  const blocos = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  const cadeia = blocos.map(b => new crypto.X509Certificate(b));
  if (!cadeia.length) throw new Error('certificado vazio');
  const agora = Date.now();
  for (const c of cadeia) if (agora < Date.parse(c.validFrom) || agora > Date.parse(c.validTo)) throw new Error('certificado vencido');
  if (!(cadeia[0].subjectAltName || '').includes('DNS:echo-api.amazon.com')) throw new Error('SAN inválido');
  for (let i = 0; i < cadeia.length - 1; i++)
    if (!cadeia[i].checkIssued(cadeia[i + 1]) || !cadeia[i].verify(cadeia[i + 1].publicKey)) throw new Error('cadeia quebrada');
  const ultimo = cadeia[cadeia.length - 1];
  const ok = tls.rootCertificates.some(p => { const r = new crypto.X509Certificate(p);
    return r.fingerprint256 === ultimo.fingerprint256 || (ultimo.checkIssued(r) && ultimo.verify(r.publicKey)); });
  if (!ok) throw new Error('raiz não confiável');
  certCache.set(url, cadeia[0]);
  return cadeia[0];
}
async function daAmazon(req, bruto, corpo) {
  const url = req.headers['signaturecertchainurl'];
  const a256 = req.headers['signature-256'];
  const ass = a256 || req.headers['signature'];
  if (!url || !ass || !urlCertValida(url)) return false;
  const cert = await carregarCadeia(url);
  if (!crypto.createVerify(a256 ? 'RSA-SHA256' : 'RSA-SHA1').update(bruto).verify(cert.publicKey, ass, 'base64')) return false;
  return Math.abs(Date.now() - Date.parse(corpo?.request?.timestamp)) <= 150 * 1000;
}
function lerBruto(req) {
  return new Promise((ok, erro) => { const p = []; req.on('data', x => p.push(x)); req.on('end', () => ok(Buffer.concat(p).toString('utf8'))); req.on('error', erro); });
}

// ---------- Fala ----------
const MAIS = 'Quer mais alguma coisa?';
function falar(texto, continuar = false, pergunta) {
  const r = { outputSpeech: { type: 'PlainText', text: texto }, shouldEndSession: !continuar };
  if (continuar) r.reprompt = { outputSpeech: { type: 'PlainText', text: pergunta || MAIS } };
  return { version: '1.0', response: r };
}
const feito = t => falar(`${t} ${MAIS}`, true);
const slot = (i, n) => (i?.slots?.[n]?.value || '').trim();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const AJUDA = 'Você pode dizer: o que tenho na agenda hoje, quais são minhas tarefas, adiciona a tarefa pagar a luz, marca dentista amanhã às três da tarde, ou anota, e o que quiser anotar.';
const COMO_LIGAR = 'Para começar, abra o app Produtividade no celular, toque em Mais, depois em Alexa, e em Ativar Alexa. Vai aparecer um número de seis dígitos. Depois diga: meu número é, e o número.';

// ---------- Datas (fuso de São Paulo) ----------
const isoSP = (off = 0) => new Date(Date.now() + off * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const deISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
const nomeDia = d => d === isoSP(0) ? 'Hoje' : d === isoSP(1) ? 'Amanhã'
  : cap(deISO(d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }));
const horaFalada = h => { if (!h || h === 'Dia todo') return 'o dia todo'; const [a, b] = h.split(':').map(Number); return `às ${a}h${b ? String(b).padStart(2, '0') : ''}`; };
const limpa = t => (t || 'sem título').replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'sem título';

function doDia(d, dados) {
  const dd = deISO(d);
  const loc = (dados.eventos || []).filter(e => e.data && (e.data === d || (d > e.data && (
    e.rec === 'diaria' || (e.rec === 'semanal' && deISO(e.data).getUTCDay() === dd.getUTCDay()) || (e.rec === 'mensal' && deISO(e.data).getUTCDate() === dd.getUTCDate())))));
  const g = dados.google && dados.google.ev ? dados.google.ev.filter(e => e.fim ? d >= e.data && d <= e.fim : e.data === d) : [];
  const k = h => (!h || h === 'Dia todo') ? '00:00' : h;
  return [...g, ...loc].sort((a, b) => k(a.hora).localeCompare(k(b.hora)));
}

// ---------- Dados do app ----------
async function carregar(db, code) { const v = await db.get('sync:' + code); return v ? JSON.parse(v) : null; }
async function salvar(db, code, d) { await db.set('sync:' + code, JSON.stringify({ t: Date.now(), d })); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Use POST'); return; }
  try {
    const bruto = await lerBruto(req);
    const corpo = JSON.parse(bruto);
    const appId = corpo?.context?.System?.application?.applicationId || corpo?.session?.application?.applicationId;
    if (process.env.ALEXA_SKILL_ID && appId !== process.env.ALEXA_SKILL_ID) { res.status(403).send('skill não autorizada'); return; }
    if (!(await daAmazon(req, bruto, corpo))) { res.status(400).send('assinatura inválida'); return; }

    const db = await banco();
    const userId = corpo?.context?.System?.user?.userId || corpo?.session?.user?.userId || '';
    const pedido = corpo.request;
    const intent = pedido.intent || {};
    let code = userId ? await db.get('alexa:' + userId) : null;
    let r;

    if (pedido.type === 'SessionEndedRequest') { res.status(200).json({ version: '1.0', response: {} }); return; }

    if (pedido.type === 'IntentRequest' && intent.name === 'VincularIntent') {
      const n = slot(intent, 'numero').replace(/\D/g, '');
      const c = n.length === 6 ? await db.get('pin:' + n) : null;
      if (!c) r = falar('Não encontrei esse número. Confira no app, em Mais, Alexa, e diga: meu número é, e os seis dígitos.', true, 'Diga: meu número é, e os seis dígitos.');
      else {
        await db.set('alexa:' + userId, c); await db.sAdd('alexaU:' + c, userId); await db.del('pin:' + n);
        const d = (await carregar(db, c)) || {};
        r = falar(`Pronto${d.d && d.d.nome ? ', ' + d.d.nome : ''}! A Alexa está ligada ao seu app. ${AJUDA}`, true, AJUDA);
      }
    } else if (!code && !['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NoIntent'].includes(intent.name)) {
      r = falar(`Bem-vinda ao app Produtividade. ${COMO_LIGAR}`, true, 'Diga: meu número é, e os seis dígitos que aparecem no app.');
    } else if (pedido.type === 'LaunchRequest') {
      const s = await carregar(db, code);
      const nome = s && s.d && s.d.nome ? s.d.nome.split(' ')[0] : '';
      r = falar(`Oi${nome ? ', ' + nome : ''}! ${AJUDA}`, true, AJUDA);
    } else {
      const s = (await carregar(db, code)) || { d: {} };
      const d = s.d || {};
      switch (intent.name) {
        case 'ConsultarAgendaIntent': {
          let dia = slot(intent, 'dia'); if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) dia = isoSP(0);
          const evs = doDia(dia, d);
          if (!evs.length) { r = feito(`${nomeDia(dia)} sua agenda está livre.`); break; }
          const n = evs.length;
          r = feito(`${nomeDia(dia)} você tem ${n} ${n === 1 ? 'compromisso' : 'compromissos'}: ${evs.slice(0, 10).map(e => `${horaFalada(e.hora)}, ${limpa(e.titulo)}`).join('; ')}.`);
          break;
        }
        case 'ListarTarefasIntent': {
          const p = (d.todos || []).filter(t => !t.done);
          if (!p.length) { r = feito('Você não tem tarefas pendentes.'); break; }
          r = feito(`Você tem ${p.length} ${p.length === 1 ? 'tarefa pendente' : 'tarefas pendentes'}: ${p.slice(0, 10).map(t => t.text).join('; ')}.`);
          break;
        }
        case 'AdicionarTarefaIntent': {
          const t = slot(intent, 'tarefa');
          if (!t) { r = falar('Qual é a tarefa?', true, 'Diga: adiciona a tarefa, e a tarefa.'); break; }
          d.todos = [{ id: Date.now(), text: cap(t), done: false }, ...(d.todos || [])];
          await salvar(db, code, d); r = feito(`Tarefa adicionada: ${t}.`);
          break;
        }
        case 'CriarEventoIntent': {
          const t = slot(intent, 'evento');
          if (!t) { r = falar('Qual é o compromisso?', true, 'Diga, por exemplo: marca dentista amanhã às três da tarde.'); break; }
          let dia = slot(intent, 'dia'); if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) dia = isoSP(0);
          let hora = slot(intent, 'hora'); if (!/^\d{2}:\d{2}$/.test(hora)) hora = '09:00';
          d.eventos = [...(d.eventos || []), { id: Date.now(), data: dia, hora, titulo: cap(t), rec: 'unica' }];
          await salvar(db, code, d); r = feito(`Marquei ${t}, ${nomeDia(dia).toLowerCase()}, ${horaFalada(hora)}.`);
          break;
        }
        case 'AnotarIntent': {
          const t = slot(intent, 'nota');
          if (!t) { r = falar('O que você quer anotar?', true, 'Diga: anota, e o que quiser.'); break; }
          d.notas = [{ id: Date.now(), titulo: cap(t).slice(0, 60), assunto: 'Alexa', texto: cap(t) }, ...(d.notas || [])];
          await salvar(db, code, d); r = feito('Anotado.');
          break;
        }
        case 'AMAZON.HelpIntent': case 'AMAZON.YesIntent': r = falar(AJUDA, true, AJUDA); break;
        case 'AMAZON.StopIntent': case 'AMAZON.CancelIntent': case 'AMAZON.NoIntent': r = falar('Até logo!'); break;
        default: r = falar(`Não entendi. ${AJUDA}`, true, AJUDA);
      }
    }
    res.status(200).json(r);
  } catch (e) {
    cliente = null; console.error('Erro na Alexa:', e);
    res.status(200).json(falar('Desculpe, algo deu errado. Tente de novo em instantes.'));
  }
};
module.exports.config = { api: { bodyParser: false } };
