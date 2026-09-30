import { test } from 'node:test';
import assert from 'node:assert/strict';

// Ambiente exclusivamente local. Nenhuma credencial ou arquivo .env é carregado.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'codex-local-placeholder';
process.env.SUPABASE_ANON_KEY = 'codex-local-placeholder';
globalThis.fetch = async () => { throw new Error('Rede proibida neste teste'); };
const { simularCiclo } = await import('../src/modules/comunicacao/comunicacao.dryrun.js');

const AGORA = new Date('2026-09-29T15:00:00Z');
const TIPO = 'dashboard_ifood_d1';
const JANELAS = { seg_sex: { inicio: '08:00', fim: '18:00' }, sab: { inicio: '08:00', fim: '13:00' }, dom: null };
const HAB = { empresaHabilitada: true, tipoPermitido: true, envioAutomatico: true, configHorarioValida: true, empresaPausada: false, timezone: 'America/Sao_Paulo', janelas: JANELAS };
const DEST = { contato_empresa_id: 'ce1', contato_id: 'c1', nome: 'Contato teste', telefone: '+5511987654321', elegivel: true };
const UNIDADE = { organizacaoId: 'o1', unidadeId: 'u1', unidadeNome: 'Loja teste', empresaNome: 'Empresa teste', criticidade: 'atencao', pendenciaMaisAntiga: '2026-09-28' };
const ALERTA = { id: 'a1', organizacao_id: 'o1', unidade_id: 'u1', tipo_alerta: TIPO, status: 'DETECTED' };
const mensagem = (extra = {}) => ({ id: 'm1', organizacao_id: 'o1', unidade_id: 'outra-unidade', alerta_id: 'outro-alerta', contato_id: 'c1', contato_empresa_id: 'ce1', tipo: TIPO, direcao: 'saida', status: 'SENT', created_at: '2026-09-29T12:00:00Z', enviado_em: '2026-09-29T12:00:00Z', ...extra });

// Interpreta a pequena gramática de filtros PostgREST usada pelas consultas reais.
// As expectativas abaixo vêm das regras de negócio/SQL, não do resultado do simulador.
function separar(expressao) {
  let nivel = 0, inicio = 0; const partes = [];
  for (let i = 0; i < expressao.length; i++) {
    if (expressao[i] === '(') nivel++;
    if (expressao[i] === ')') nivel--;
    if (expressao[i] === ',' && nivel === 0) { partes.push(expressao.slice(inicio, i)); inicio = i + 1; }
  }
  partes.push(expressao.slice(inicio)); return partes;
}
function satisfaz(r, expr) {
  if (expr.startsWith('and(')) return separar(expr.slice(4, -1)).every(e => satisfaz(r, e));
  if (expr.startsWith('or(')) return separar(expr.slice(3, -1)).some(e => satisfaz(r, e));
  const [, campo, op, valor] = expr.match(/^([^.]+)\.(eq|gte|in)\.(.*)$/) ?? [];
  assert.ok(campo, `Filtro não suportado: ${expr}`);
  if (op === 'in') return valor.slice(1, -1).split(',').includes(r[campo]);
  if (op === 'gte') return r[campo] != null && r[campo] >= valor;
  return r[campo] === valor;
}

function ambiente({ mensagens = [], alertas = [], limites = {}, destinatarios = [DEST], hab = {}, unidades = [UNIDADE], modo = 'DISABLED', agora = AGORA } = {}) {
  const configs = { janelas: JANELAS, cooldowns_horas: { atencao: 8, critico: 4 }, limites: { max_por_contato_por_dia: 3, max_por_organizacao_por_dia: 20, ...limites }, ttl_horas: 24, jitter_max_minutos: 1, disponibilidade_ifood: { dados_disponiveis_apos: '08:00', envios_permitidos_apos: '08:30' } };
  const dados = { comunicacao_configuracoes: Object.entries(configs).map(([chave, valor]) => ({ chave, valor })), comunicacao_alertas: alertas, comunicacao_mensagens: mensagens };
  const chamadas = [];
  const db = {
    from(tabela) {
      assert.ok(Object.hasOwn(dados, tabela), `Leitura inesperada: ${tabela}`);
      let filtros = [];
      let contar = false, inicio = 0, fim = Infinity;
      const executar = () => {
        const rows = dados[tabela].filter(r => filtros.every(f => f(r)));
        return { data: rows.slice(inicio, fim + 1), count: contar ? rows.length : null, error: null };
      };
      const q = {
        select(_colunas, opcoes) { chamadas.push(['select', tabela]); contar = opcoes?.count === 'exact'; return q; },
        eq(k,v) { filtros.push(r => r[k] === v); return q; },
        in(k,vs) { filtros.push(r => vs.includes(r[k])); return q; },
        gte(k,v) { filtros.push(r => r[k] >= v); return q; },
        not(k,op,v) { assert.equal(op, 'is'); assert.equal(v, null); filtros.push(r => r[k] != null); return q; },
        or(expr) { filtros.push(r => separar(expr).some(e => satisfaz(r,e))); return q; },
        order() { return q; },
        range(de, ate) { inicio = de; fim = ate; return q; },
        async maybeSingle() { const r=executar(); return { ...r, data:r.data[0] ?? null }; },
        then(ok,err) { return Promise.resolve(executar()).then(ok,err); },
      };
      for (const nome of ['insert','update','upsert','delete']) q[nome] = () => { throw Error(`Escrita proibida: ${nome}`); };
      return q;
    },
    rpc() { throw Error('RPC não autorizada no simulador somente leitura'); },
  };
  return { chamadas, executar: () => simularCiclo({ organizacaoId: 'o1', agora, lerModo: async () => modo, lerPendencias: async () => ({ d1: '2026-09-28', unidades }), resolverHabilitacao: async () => ({ ...HAB, ...hab }), resolverDestinatarios: async () => destinatarios }, { supabase: db }) };
}

test('DISABLED permite simular sem rede, escrita ou telefone completo', async () => {
  const a=ambiente(); const r=await a.executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas,1);
  assert.equal(r.envioRealPermitido,false);
  assert.equal(r.providerChamado,false);
  assert.equal(r.mensagensCriadas,0);
  assert.equal(r.alertasCriados,0);
  assert.doesNotMatch(JSON.stringify(r),/5511987654321/);
});

test('destinatários são avaliados individualmente sem bloquear elegível por opt-out alheio',async()=>{
  const r=await ambiente({destinatarios:[DEST,{...DEST,contato_empresa_id:'ce2',contato_id:'c2',elegivel:false,motivo:'OPT_OUT'}]}).executar();
  assert.equal(r.resumo.destinatariosAvaliados,2);
  assert.equal(r.resumo.mensagensQueSeriamGeradas,1);
  assert.equal(r.alertas[0].destinatarios_bloqueados[0].motivo,'OPT_OUT');
});

test('limite diário da empresa não é consumido por resposta manual',async()=>{
  const r=await ambiente({mensagens:[mensagem({alerta_id:null,contato_id:'c2'})],limites:{max_por_organizacao_por_dia:1}}).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas,1);
});

test('limite diário já atingido impede a previsão de nova mensagem',async()=>{
  const r=await ambiente({mensagens:[mensagem()],limites:{max_por_contato_por_dia:1}}).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas,0);
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='LIMITE_DESTINATARIO_DIA').ok,false);
});

test('organização solicitada não revela pendências de outra empresa',async()=>{
  const r=await ambiente({unidades:[UNIDADE,{...UNIDADE,organizacaoId:'o2',unidadeNome:'Loja privada'}]}).executar();
  assert.equal(r.resumo.alertasDetectados,1);
  assert.doesNotMatch(JSON.stringify(r),/Loja privada/);
});

test('regressão: empresa sem destinatários elegíveis não é marcada como elegível',async()=>{
  const r=await ambiente({destinatarios:[]}).executar();
  assert.ok(r.alertas[0].motivos_empresa.includes('SEM_DESTINATARIOS'));
  assert.equal(r.alertas[0].empresa_elegivel,false);
  assert.equal(r.resumo.empresasElegiveis,0);
});

test('regressão: mensagem inicial antiga ainda impede duplicidade do mesmo alerta',async()=>{
  const r=await ambiente({alertas:[ALERTA],mensagens:[mensagem({alerta_id:'a1',created_at:'2026-09-20T12:00:00Z',enviado_em:'2026-09-20T12:00:00Z'})]}).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas,0);
});

test('regressão: mensagem criada há mais de 48h mas enviada hoje consome limite do dia',async()=>{
  const r=await ambiente({mensagens:[mensagem({created_at:'2026-09-20T12:00:00Z'})],limites:{max_por_contato_por_dia:1}}).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas,0);
});

test('regressão: limite global do contato considera envios em outra empresa',async()=>{
  const r=await ambiente({mensagens:[mensagem({organizacao_id:'o2'})],limites:{max_por_contato_por_dia:1}}).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas,0);
});

for (const motivo of ['OPT_OUT', 'CATEGORIA_NAO_HABILITADA', 'DESTINATARIO_INATIVO', 'WHATSAPP_NAO_VALIDADO']) {
  test(`destinatário bloqueado por ${motivo} não gera mensagem e mantém diagnóstico`, async () => {
    const r = await ambiente({ destinatarios: [{ ...DEST, elegivel: false, motivo }] }).executar();
    assert.equal(r.resumo.mensagensQueSeriamGeradas, 0);
    assert.equal(r.alertas[0].destinatarios_bloqueados[0].motivo, motivo);
    assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='DESTINATARIO_ELEGIVEL').ok, false);
  });
}

test('empresa com envio automático desligado informa bloqueio e não gera mensagem', async () => {
  const r = await ambiente({ hab: { envioAutomatico: false } }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 0);
  assert.equal(r.alertas[0].empresa_elegivel, false);
  assert.ok(r.alertas[0].motivos_empresa.includes('ENVIO_AUTOMATICO_DESLIGADO'));
});

test('cooldown pertence ao contato: envio para João não bloqueia Maria', async () => {
  const r = await ambiente({ mensagens: [mensagem({ unidade_id: 'u1' })], destinatarios: [DEST, { ...DEST, contato_empresa_id: 'ce2', contato_id: 'c2', nome: 'Maria' }] }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 1);
  assert.equal(r.alertas[0].mensagens_que_seriam_geradas[0].destinatarioId, 'ce2');
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='COOLDOWN').ok, false);
});

test('cota diária específica da empresa prevalece sobre a global', async () => {
  const r = await ambiente({ mensagens: [mensagem({ contato_id: 'c2' })], hab: { limiteDiarioOrg: 1 } }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 0);
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='LIMITE_ORGANIZACAO_DIA').ok, false);
});

test('mensagem inicial existente bloqueia apenas seu destinatário', async () => {
  const r = await ambiente({ alertas: [ALERTA], mensagens: [mensagem({ alerta_id: 'a1' })], destinatarios: [DEST, { ...DEST, contato_empresa_id: 'ce2', contato_id: 'c2' }] }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 1);
  assert.equal(r.alertas[0].mensagens_que_seriam_geradas[0].destinatarioId, 'ce2');
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='IDEMPOTENCIA').ok, false);
});

test('jitter é estável por destinatário e respeita a abertura da janela', async () => {
  const opts = { agora: new Date('2026-09-29T10:00:00Z'), unidades: [{ ...UNIDADE, pendenciaMaisAntiga: '2026-09-27' }], destinatarios: [DEST, { ...DEST, contato_empresa_id: 'ce2', contato_id: 'c2' }] };
  const a = await ambiente(opts).executar(), b = await ambiente(opts).executar();
  const tempos = a.alertas[0].horarios_estimados;
  assert.equal(tempos.length, 2);
  assert.deepEqual(tempos, b.alertas[0].horarios_estimados);
  assert.notEqual(tempos[0].horarioEstimado, tempos[1].horarioEstimado);
  for (const t of tempos) assert.ok(Date.parse(t.horarioEstimado) >= Date.parse('2026-09-29T11:00:00Z'));
});

test('modo real permitido não altera a garantia de simulação somente leitura', async () => {
  for (const modo of ['NORMAL', 'REACTIVE_ONLY']) {
    const r = await ambiente({ modo }).executar();
    assert.equal(r.envioRealPermitido, true);
    assert.equal(r.mensagensCriadas, 0);
    assert.equal(r.providerChamado, false);
  }
});

test('DELIVERY_UNKNOWN antigo mantém cooldown mesmo fora da cota do dia', async () => {
  const r = await ambiente({ mensagens: [mensagem({ unidade_id: 'u1', status: 'DELIVERY_UNKNOWN', created_at: '2026-09-20T12:00:00Z', enviado_em: null, entrega_incerta_em: '2026-09-20T12:00:00Z' })] }).executar();
  const passos = r.alertas[0].destinatarios[0].passos;
  assert.equal(passos.find(p=>p.etapa==='COOLDOWN').ok, false);
  assert.equal(passos.find(p=>p.etapa==='LIMITE_DESTINATARIO_DIA').detalhe, '0/3 hoje');
});

test('incerteza registrada hoje conta mesmo quando enviado_em é antigo', async () => {
  const r = await ambiente({ mensagens: [mensagem({ status: 'DELIVERY_UNKNOWN', enviado_em: '2026-09-20T12:00:00Z', entrega_incerta_em: '2026-09-29T12:00:00Z' })], limites: { max_por_contato_por_dia: 1 } }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 0);
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='LIMITE_DESTINATARIO_DIA').ok, false);
});

test('claimed_at só consome cota no estado SENDING; created_at não substitui carimbo de consumo', async () => {
  for (const status of ['SENT', 'FAILED', 'SCHEDULED']) {
    const r = await ambiente({ mensagens: [mensagem({ status, enviado_em: null, claimed_at: '2026-09-29T12:00:00Z' })], limites: { max_por_contato_por_dia: 1 } }).executar();
    assert.equal(r.resumo.mensagensQueSeriamGeradas, 1, status);
  }
  const r = await ambiente({ mensagens: [mensagem({ status: 'SENDING', enviado_em: null, claimed_at: '2026-09-29T12:00:00Z' })], limites: { max_por_contato_por_dia: 1 } }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 0);
});

test('idempotência não desaparece depois da primeira página de histórico', async () => {
  const mensagens = Array.from({ length: 501 }, (_, i) => mensagem({ id: `historico-${String(i).padStart(4,'0')}`, alerta_id: 'a1', contato_id: 'outro-contato', contato_empresa_id: 'outro-destinatario', created_at: '2026-09-20T12:00:00Z', enviado_em: '2026-09-20T12:00:00Z' }));
  mensagens.push(mensagem({ id: 'z-final', alerta_id: 'a1', created_at: '2026-09-20T12:00:00Z', enviado_em: '2026-09-20T12:00:00Z' }));
  const r = await ambiente({ mensagens, alertas: [ALERTA] }).executar();
  assert.equal(r.resumo.mensagensQueSeriamGeradas, 0);
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='IDEMPOTENCIA').ok, false);
});

test('consumo em outra empresa retorna contagem sem revelar sua identidade ou unidade', async () => {
  const r = await ambiente({ mensagens: [mensagem({ organizacao_id: 'empresa-confidencial', unidade_id: 'unidade-confidencial' })], limites: { max_por_contato_por_dia: 1 } }).executar();
  assert.doesNotMatch(JSON.stringify(r), /empresa-confidencial|unidade-confidencial/);
  assert.equal(r.alertas[0].destinatarios[0].passos.find(p=>p.etapa==='LIMITE_DESTINATARIO_DIA').detalhe, '1/1 hoje');
});

test('erro ou contagem ausente não se transformam em capacidade disponível', async () => {
  const { contarConsumoContato } = await import('../src/modules/comunicacao/comunicacao.dryrun.repo.js');
  for (const resultado of [{ count: null, error: null }, { count: 0, error: { message: 'Falha de leitura' } }]) {
    const q = { select:()=>q, eq:()=>q, in:()=>q, or:()=>q, then:(ok,err)=>Promise.resolve(resultado).then(ok,err) };
    await assert.rejects(contarConsumoContato({ contatoId: 'c1', inicioDia: AGORA }, { supabase: { from:()=>q } }));
  }
});
