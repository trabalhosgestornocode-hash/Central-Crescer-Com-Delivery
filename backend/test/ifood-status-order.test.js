// Status da integração — app Order (pedidos e eventos) com estado PRÓPRIO.
//
// Regra: problema do Order NÃO muda o status geral nem o de analytics/financial; problema do financial
// NÃO muda o Order. `atencao` só resume. Nenhuma credencial, token, merchant completo ou identificação do
// worker sai no status. Sem rede, sem banco.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_HOMOLOGATION_MODE = "false";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";
process.env.IFOOD_ORDER_CLIENT_ID = "order-client-id";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-client-secret";

const { config } = await import("../src/config/env.js");
const conn = await import("../src/modules/ifood/ifoodConnection.service.js");
const { obterObservabilidadeOrder, obterUltimaAutorizacao } = await import("../src/modules/ifood/ifood.repository.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const MERCHANT = "55c8f464-e65f-4340-b2c7-62d143027040";
const AGORA = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (minDoAgora) => new Date(AGORA + minDoAgora * 60_000).toISOString();
const agora = () => new Date(AGORA);

const cred = (app_type, status = "ativa", expiraMin = 300) => ({ app_type, status, expira_em: iso(expiraMin), atualizado_em: iso(-60) });
const OBS_OK = {
  disponivel: true, ultimoEvento: iso(-2), ultimoAck: iso(-2), eventosComFalha: 0, ultimoPedido: iso(-5),
  lease: { leaseAte: iso(1), atualizadoEm: iso(-0.5) },
};

function repoFalso({ credenciais, obs = OBS_OK, ultimaAut = iso(-120), falharObs = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async obterConexaoViva() {
      return { id: "conx-1", status: "ativa", merchant_id: MERCHANT, merchant_nome: "Loja X", merchant_razao_social: "Loja X LTDA", conectada_em: iso(-1000), access_token_cifrado: "NAO-SAI" };
    },
    async listarCredenciaisDaConexao() { return credenciais.map((c) => ({ ...c })); },
    async obterObservabilidadeOrder(a) { chamadas.push(["obs", a]); if (falharObs) throw new Error("banco fora"); return obs; },
    async obterUltimaAutorizacao(a) { chamadas.push(["aut", a]); return ultimaAut; },
  };
}
const status = (repo) => conn.obterStatus({ ...TENANT, deps: { repo, agora } });

async function comConfig(ajuste, fn) {
  const antes = JSON.parse(JSON.stringify(config.ifood));
  Object.assign(config.ifood, ajuste);
  try { return await fn(); } finally { Object.assign(config.ifood, antes); }
}

test("Order em reauth_required NÃO contamina: status geral e financial seguem ok; só o bloco Order acusa; atenção = 1", async () => {
  const s = await status(repoFalso({ credenciais: [cred("analytics"), cred("financial"), cred("order", "reauth_required")] }));
  assert.equal(s.status, "ativa", "status geral não vira reauth por causa do Order");
  assert.equal(s.conectado, true);
  assert.equal(s.apps.financial.conectado, true);
  assert.equal(s.apps.analytics.conectado, true);
  assert.equal(s.order.status, "reauth_required");
  assert.equal(s.order.conectado, false);
  assert.equal(s.order.erroAtual.codigo, "REAUTH_REQUIRED");
  assert.deepEqual(s.atencao, { total: 1, apps: ["order"] });
});

test("Financial em reauth_required NÃO contamina o Order: Order segue conectado, sem erro; atenção = financial", async () => {
  const s = await status(repoFalso({ credenciais: [cred("analytics"), cred("financial", "reauth_required"), cred("order")] }));
  assert.equal(s.status, "reauth_required");
  assert.equal(s.apps.financial.status, "reauth_required");
  assert.equal(s.order.conectado, true);
  assert.equal(s.order.erroAtual, null);
  assert.deepEqual(s.atencao, { total: 1, apps: ["financial"] });
});

test("Order saudável: todos os campos do bloco (token, merchant mascarado, autenticação, eventos, ACK, pedido, worker)", async () => {
  const s = await status(repoFalso({ credenciais: [cred("financial"), cred("order")] }));
  const o = s.order;
  assert.equal(o.configurado, true);
  assert.equal(o.conectado, true);
  assert.equal(o.tokenValido, true);
  assert.equal(o.expiraEm, iso(300));
  assert.deepEqual(o.merchant, { idMascarado: "55c8****7040", nome: "Loja X", razaoSocial: "Loja X LTDA" });
  assert.equal(o.ultimaAutenticacao, iso(-120));
  assert.equal(o.tokenAtualizadoEm, iso(-60));
  assert.equal(o.ultimoEvento, iso(-2));
  assert.equal(o.ultimoAck, iso(-2));
  assert.equal(o.ultimoPedido, iso(-5));
  assert.deepEqual(o.worker, { ativo: true, atualizadoEm: iso(-0.5) });
  assert.equal(o.observabilidadeDisponivel, true);
  assert.equal(o.erroAtual, null);
  assert.deepEqual(s.atencao, { total: 0, apps: [] });
});

test("worker parado (lease vencido): Order acusa WORKER_INATIVO; financial não muda", async () => {
  const s = await status(repoFalso({ credenciais: [cred("financial"), cred("order")], obs: { ...OBS_OK, lease: { leaseAte: iso(-3), atualizadoEm: iso(-4) } } }));
  assert.equal(s.order.worker.ativo, false);
  assert.equal(s.order.erroAtual.codigo, "WORKER_INATIVO");
  assert.equal(s.status, "ativa");
  assert.deepEqual(s.atencao.apps, ["order"]);
});

test("eventos com falha de processamento: EVENTOS_COM_FALHA (com a contagem)", async () => {
  const s = await status(repoFalso({ credenciais: [cred("financial"), cred("order")], obs: { ...OBS_OK, eventosComFalha: 3 } }));
  assert.equal(s.order.erroAtual.codigo, "EVENTOS_COM_FALHA");
  assert.match(s.order.erroAtual.mensagem, /3 evento/);
});

test("token do Order expirado (o worker renova no uso): tokenValido false, sem virar erro", async () => {
  const s = await status(repoFalso({ credenciais: [cred("financial"), cred("order", "ativa", -10)] }));
  assert.equal(s.order.conectado, true);
  assert.equal(s.order.tokenValido, false);
  assert.equal(s.order.erroAtual, null);
});

test("tabelas de Events ausentes (migration 101 não aplicada) ou leitura falhando: status NÃO quebra; worker sem dados", async () => {
  for (const repo of [
    repoFalso({ credenciais: [cred("financial"), cred("order")], obs: { disponivel: false } }),
    repoFalso({ credenciais: [cred("financial"), cred("order")], falharObs: true }),
  ]) {
    const s = await status(repo);
    assert.equal(s.order.observabilidadeDisponivel, false);
    assert.equal(s.order.worker, null);
    assert.equal(s.order.ultimoEvento, null);
    assert.equal(s.order.erroAtual, null);
    assert.equal(s.status, "ativa");
  }
});

test("app Order configurado mas sem credencial na unidade: bloco 'não conectado', sem erro e sem consultar Events", async () => {
  const repo = repoFalso({ credenciais: [cred("financial")] });
  const s = await status(repo);
  assert.equal(s.order.configurado, true);
  assert.equal(s.order.conectado, false);
  assert.equal(s.order.status, null);
  assert.equal(s.order.erroAtual, null);
  assert.equal(repo.chamadas.length, 0, "nada é lido de Events sem credencial order");
});

test("SEM app Order no ambiente (produção hoje: sem IFOOD_ORDER_*) e sem credencial: order = null (painel igual ao de antes)", async () => {
  await comConfig({ order: { clientId: null, clientSecret: null } }, async () => {
    const s = await status(repoFalso({ credenciais: [cred("analytics"), cred("financial")] }));
    assert.equal(s.order, null);
    assert.deepEqual(s.atencao, { total: 0, apps: [] });
  });
});

test("sem conexão: order null e atenção zerada", async () => {
  const s = await conn.obterStatus({ ...TENANT, deps: { repo: { async obterConexaoViva() { return null; } }, agora } });
  assert.equal(s.order, null);
  assert.deepEqual(s.atencao, { total: 0, apps: [] });
});

test("nada sensível no status: sem token, secret, client id, merchant completo, holder ou ids internos", async () => {
  const s = await status(repoFalso({ credenciais: [cred("financial"), cred("order")] }));
  const txt = JSON.stringify(s);
  for (const proibido of [MERCHANT, "NAO-SAI", "order-client-id", "order-client-secret", "fin-client", "conx-1", "holder", "access_token", "refresh"]) {
    assert.ok(!txt.includes(proibido), `vazou ${proibido}`);
  }
});

test("as leituras de Events são do tenant e do merchant da conexão", async () => {
  const repo = repoFalso({ credenciais: [cred("financial"), cred("order")] });
  await status(repo);
  assert.deepEqual(repo.chamadas.find((c) => c[0] === "obs")[1], { ...TENANT, merchantId: MERCHANT });
  assert.deepEqual(repo.chamadas.find((c) => c[0] === "aut")[1], { ...TENANT, appType: "order" });
});

// ===========================================================================
// Repositório (builder do supabase gravado, sem banco)
// ===========================================================================
function dbGravado(respostaPorTabela) {
  const chamadas = [];
  return {
    chamadas,
    from(tabela) {
      const eu = { tabela, ops: [] };
      chamadas.push(eu);
      const b = {};
      for (const m of ["select", "eq", "not", "order", "limit"]) b[m] = (...a) => { eu.ops.push([m, ...a]); return b; };
      b.maybeSingle = () => { eu.ops.push(["maybeSingle"]); return b; };
      b.then = (res, rej) => Promise.resolve(typeof respostaPorTabela === "function" ? respostaPorTabela(eu) : respostaPorTabela[tabela]).then(res, rej);
      return b;
    },
  };
}

test("repositório: observabilidade lê eventos/pedidos DO TENANT (e do merchant) e o lease sem o holder", async () => {
  const db = dbGravado((q) => {
    if (q.tabela === "ifood_poller_lease") return { data: { lease_ate: iso(1), atualizado_em: iso(0) }, error: null };
    if (q.tabela === "ifood_pedidos") return { data: [{ criado_em: iso(-5) }], error: null };
    const col = q.ops.find((o) => o[0] === "select")[1];
    if (col === "id") return { data: null, count: 2, error: null };
    return { data: [{ [col]: iso(-1) }], error: null };
  });
  const r = await obterObservabilidadeOrder({ ...TENANT, merchantId: MERCHANT, db });
  assert.deepEqual(r, { disponivel: true, ultimoEvento: iso(-1), ultimoAck: iso(-1), eventosComFalha: 2, ultimoPedido: iso(-5), lease: { leaseAte: iso(1), atualizadoEm: iso(0) } });
  for (const q of db.chamadas.filter((c) => c.tabela !== "ifood_poller_lease")) {
    assert.ok(q.ops.some((o) => o[0] === "eq" && o[1] === "organizacao_id" && o[2] === "org-1"), q.tabela);
    assert.ok(q.ops.some((o) => o[0] === "eq" && o[1] === "unidade_id" && o[2] === "uni-1"), q.tabela);
  }
  for (const q of db.chamadas.filter((c) => c.tabela === "ifood_eventos")) assert.ok(q.ops.some((o) => o[0] === "eq" && o[1] === "merchant_id" && o[2] === MERCHANT));
  const lease = db.chamadas.find((c) => c.tabela === "ifood_poller_lease");
  assert.doesNotMatch(lease.ops.find((o) => o[0] === "select")[1], /holder/);
});

test("repositório: tabela ausente (PGRST205 / 42P01) -> disponivel false; outro erro do banco sobe", async () => {
  for (const code of ["PGRST205", "42P01"]) {
    const r = await obterObservabilidadeOrder({ ...TENANT, merchantId: MERCHANT, db: dbGravado(() => ({ data: null, error: { code, message: "relation does not exist" } })) });
    assert.deepEqual(r, { disponivel: false });
  }
  await assert.rejects(obterObservabilidadeOrder({ ...TENANT, merchantId: MERCHANT, db: dbGravado(() => ({ data: null, error: { code: "57014", message: "timeout" } })) }), /timeout/);
});

test("repositório: última autorização = sessão 'authorized' mais recente do app, do tenant", async () => {
  const db = dbGravado(() => ({ data: [{ atualizado_em: iso(-7) }], error: null }));
  assert.equal(await obterUltimaAutorizacao({ ...TENANT, appType: "order", db }), iso(-7));
  const ops = db.chamadas[0].ops;
  assert.equal(db.chamadas[0].tabela, "ifood_oauth_sessoes");
  for (const [c, v] of [["organizacao_id", "org-1"], ["unidade_id", "uni-1"], ["app_type", "order"], ["status", "authorized"]]) {
    assert.ok(ops.some((o) => o[0] === "eq" && o[1] === c && o[2] === v), c);
  }
});
