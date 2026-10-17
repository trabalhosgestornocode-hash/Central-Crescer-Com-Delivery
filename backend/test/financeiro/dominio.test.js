import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
// Credenciais FALSAS e forçadas: este arquivo jamais fala com um banco real (todo acesso é injetado).
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local-nao-e-segredo";
process.env.SUPABASE_ANON_KEY = "teste-local-nao-e-segredo";
const { ApiError } = await import("../../src/shared/ApiError.js");
const { criarDominioRouter } = await import("../../src/modules/gestao-financeira/dominio/rotas.js");
const repo = await import("../../src/modules/gestao-financeira/dominio/repositorio.js");
const lanc = await import("../../src/modules/gestao-financeira/dominio/lancamentos.service.js");
const cad = await import("../../src/modules/gestao-financeira/dominio/cadastros.service.js");
const imp = await import("../../src/modules/gestao-financeira/dominio/importacao.service.js");
const rel = await import("../../src/modules/gestao-financeira/dominio/relatorios.service.js");
const { exigirContexto } = await import("../../src/modules/gestao-financeira/dominio/contexto.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CTX = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) };
const OUTRO = { organizacaoId: U(11), unidadeId: U(12), usuarioId: U(13) };

// ---- banco "gravador": registra filtros e devolve vazio, para provar o escopo do repositório REAL ----
function dbGravador() {
  const chamadas = [];
  const novo = (tabela) => {
    const c = { tabela, op: "select", filtros: [], payload: null };
    chamadas.push(c);
    const q = new Proxy({}, {
      get(_, nome) {
        if (nome === "then") return (res) => res({ data: c.op === "select" ? [] : null, error: null, count: 0 });
        return (...args) => {
          if (nome === "eq") c.filtros.push([args[0], args[1]]);
          else if (["insert", "update", "upsert"].includes(nome)) { c.op = nome; c.payload = args[0]; }
          return q;
        };
      },
    });
    return q;
  };
  return { db: { from: novo, rpc: (fn, args) => { chamadas.push({ rpc: fn, args }); return Promise.resolve({ data: null, error: null }); } }, chamadas };
}

test("repositório: toda consulta carrega organizacao_id; tabelas por unidade também unidade_id", async () => {
  const { db, chamadas } = dbGravador();
  await repo.listarPlanoContas(CTX, db);
  await repo.listarContas(CTX, db);
  await repo.listarAberturas(CTX, db);
  await repo.listarLancamentos(CTX, {}, db);
  await repo.listarTodosLancamentos(CTX, {}, db);
  await repo.obterLancamento(CTX, U(9), db);
  await repo.listarTransferencias(CTX, db);
  await repo.listarImportacoes(CTX, db);
  await repo.listarExistentesImportacao(CTX, db);
  await repo.listarAuditoria(CTX, {}, db);
  for (const c of chamadas) {
    const f = Object.fromEntries(c.filtros);
    assert.equal(f.organizacao_id, CTX.organizacaoId, `${c.tabela} sem organizacao_id`);
    if (c.tabela !== "fin_plano_contas") assert.equal(f.unidade_id, CTX.unidadeId, `${c.tabela} sem unidade_id`);
  }
});

test("repositório: escritas sobrescrevem org/unidade/autor com o contexto (corpo malicioso não vence)", async () => {
  const { db, chamadas } = dbGravador();
  await repo.inserirLancamento(CTX, { conta_id: U(5), organizacao_id: OUTRO.organizacaoId, unidade_id: OUTRO.unidadeId, criado_por: U(99) }, db);
  const ins = chamadas.find((c) => c.op === "insert");
  assert.equal(ins.payload.organizacao_id, CTX.organizacaoId);
  assert.equal(ins.payload.unidade_id, CTX.unidadeId);
  assert.equal(ins.payload.criado_por, CTX.usuarioId);
  assert.equal(ins.payload.origem, "manual");
  await repo.atualizarLancamento(CTX, U(9), { descricao: "x" }, db).catch(() => {});
  const upd = chamadas.find((c) => c.op === "update");
  const f = Object.fromEntries(upd.filtros);
  assert.equal(f.organizacao_id, CTX.organizacaoId);
  assert.equal(f.unidade_id, CTX.unidadeId);
});

test("repositório: RPCs recebem org/unidade/usuário do contexto", async () => {
  const { db, chamadas } = dbGravador();
  await repo.confirmarImportacaoRpc(CTX, U(7), db);
  await repo.vincularTransferenciaRpc(CTX, U(8), U(9), db);
  for (const c of chamadas.filter((x) => x.rpc)) {
    assert.equal(c.args.p_org, CTX.organizacaoId);
    assert.equal(c.args.p_unidade, CTX.unidadeId);
    assert.equal(c.args.p_usuario, CTX.usuarioId);
  }
});

test("contexto: incompleto ou inválido falha fechado", () => {
  for (const ruim of [null, {}, { ...CTX, organizacaoId: "x" }, { ...CTX, unidadeId: null }, { ...CTX, usuarioId: undefined }]) {
    assert.throws(() => exigirContexto(ruim), (e) => e instanceof ApiError && e.statusCode === 403);
  }
});

// ---- rotas: nenhuma rota existe sem o gate do Agente 1 ----
async function servir(router) {
  const app = express();
  app.use(express.json());
  app.use("/fin", router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, details: err.details }));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}/fin`, fechar: () => new Promise((ok) => srv.close(ok)) };
}

test("rotas: com o gate negando, TODAS as rotas devolvem 403 e nenhum serviço é tocado", async () => {
  let tocou = 0;
  const deps = { repo: new Proxy({}, { get: () => () => { tocou++; return Promise.resolve([]); } }), db: undefined };
  const negar = () => (_req, _res, next) => next(ApiError.forbidden("negado"));
  const router = criarDominioRouter({ autorizar: negar, deps });
  const rotas = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => [m.toUpperCase(), l.route.path]));
  assert.ok(rotas.length >= 30, `rotas registradas: ${rotas.length}`);
  const { base, fechar } = await servir(router);
  try {
    for (const [m, p] of rotas) {
      const r = await fetch(base + p.replace(/:id/g, U(1)), { method: m, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(m) ? undefined : "{}" });
      assert.equal(r.status, 403, `${m} ${p}`);
    }
  } finally { await fechar(); }
  assert.equal(tocou, 0);
});

test("rotas: cada rota exige a ação mínima esperada (leitura só VER; escrita nunca VER)", () => {
  const acoes = [];
  const gravador = (acao) => { acoes.push(acao); return (_q, _s, n) => n(); };
  const router = criarDominioRouter({ autorizar: gravador, deps: { repo: {} } });
  const porRota = router.stack.filter((l) => l.route).map((l) => ({ metodos: Object.keys(l.route.methods), path: l.route.path }));
  assert.equal(acoes.length, porRota.length);
  porRota.forEach((r, i) => {
    const escrita = r.metodos.some((m) => m !== "get");
    if (escrita) assert.notEqual(acoes[i], "gestao_financeira.ver", `${r.metodos} ${r.path} não pode exigir só 'ver'`);
  });
  assert.equal(acoes[porRota.findIndex((r) => r.path === "/importacoes/:id/confirmar")], "gestao_financeira.configurar");
  assert.equal(acoes[porRota.findIndex((r) => r.path === "/lancamentos/:id/cancelar")], "gestao_financeira.cancelar");
});

test("rotas: contexto vem do gate; org/unidade no corpo são ignorados", async () => {
  const visto = [];
  const deps = { db: undefined, repo: {
    listarContas: async () => [{ id: U(5), ativo: true }], listarPlanoContas: async () => [{ id: U(6), ativo: true, papel: "despesa_fixa" }],
    inserirLancamento: async (ctx, l) => { visto.push({ ctx, l }); return { id: U(40), ...l }; },
  } };
  const gate = () => (req, _res, next) => { req.financeiro = { organizacaoId: CTX.organizacaoId, unidadeId: CTX.unidadeId, permissoes: [] }; req.user = { id: CTX.usuarioId }; next(); };
  const { base, fechar } = await servir(criarDominioRouter({ autorizar: gate, deps }));
  try {
    const r = await fetch(`${base}/lancamentos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      organizacaoId: OUTRO.organizacaoId, unidadeId: OUTRO.unidadeId, contaId: U(5), categoriaId: U(6), descricao: "Teste", sentido: "saida", valor: "10,50", dataMovimento: "2026-09-02" }) });
    assert.equal(r.status, 201);
  } finally { await fechar(); }
  assert.deepEqual(visto[0].ctx, CTX);
  assert.equal(visto[0].l.valor_centavos, 1050);
  assert.equal(visto[0].l.organizacao_id, undefined); // o serviço nem repassa; o repositório imporia o contexto
});

// ---- regras dos serviços ----
const cats = [
  { id: U(21), ativo: true, papel: "despesa_fixa", nome: "ALUGUEL" },
  { id: U(22), ativo: true, papel: "despesa_variavel", nome: "OUTRAS" },
  { id: U(23), ativo: true, papel: "transferencia", nome: "ENTRE CONTAS" },
  { id: U(24), ativo: true, papel: "saldo_anterior", nome: "SALDO" },
];
const contas = [{ id: U(31), ativo: true, nome: "A" }, { id: U(32), ativo: true, nome: "B" }, { id: U(33), ativo: false, nome: "C" }];
function repoFalso(extra = {}) {
  const gravados = [];
  return { gravados, deps: { db: undefined, repo: {
    listarPlanoContas: async () => cats, listarContas: async () => contas,
    inserirLancamento: async (_c, l) => { gravados.push(l); return { id: U(50), ...l }; },
    obterLancamento: async () => null, atualizarLancamento: async (_c, id, campos) => { gravados.push({ id, ...campos }); return { id, ...campos }; },
    criarTransferenciaRpc: async (_c, p) => { gravados.push(p); return U(60); },
    ...extra,
  } } };
}
const base = { contaId: U(31), descricao: "x", sentido: "saida", valor: "10,00", dataMovimento: "2026-09-02" };
const falha = (fn, codigo) => assert.rejects(fn, (e) => e instanceof ApiError && e.statusCode === 400 && (!codigo || e.details?.codigo === codigo));

test("lançamento: valor em float/3 casas/zero/negativo é recusado; dinheiro vira centavos exatos", async () => {
  const { deps, gravados } = repoFalso();
  await falha(() => lanc.criarLancamento(CTX, { ...base, valor: 10.005 }, deps));
  await falha(() => lanc.criarLancamento(CTX, { ...base, valor: "0" }, deps));
  await falha(() => lanc.criarLancamento(CTX, { ...base, valor: "-5" }, deps));
  await falha(() => lanc.criarLancamento(CTX, { ...base, valor: "abc" }, deps));
  await lanc.criarLancamento(CTX, { ...base, categoriaId: U(21), valor: "1.234,56" }, deps);
  assert.equal(gravados[0].valor_centavos, 123456);
  assert.equal(gravados[0].classificacao_pendente, false);
});

test("lançamento: sem categoria nasce pendente; categoria saldo anterior e conta inativa/inexistente são recusadas", async () => {
  const { deps, gravados } = repoFalso();
  await lanc.criarLancamento(CTX, base, deps);
  assert.equal(gravados[0].classificacao_pendente, true);
  assert.equal(gravados[0].categoria_id, null);
  await falha(() => lanc.criarLancamento(CTX, { ...base, categoriaId: U(24) }, deps), "CATEGORIA_SALDO_ANTERIOR");
  await falha(() => lanc.criarLancamento(CTX, { ...base, contaId: U(33) }, deps), "CONTA_INATIVA");
  await falha(() => lanc.criarLancamento(CTX, { ...base, contaId: U(99) }, deps), "CONTA_INEXISTENTE");
  await falha(() => lanc.criarLancamento(CTX, { ...base, dataMovimento: "2026-02-30" }, deps));
  await falha(() => lanc.criarLancamento(CTX, { ...base, sentido: "x" }, deps));
});

test("reclassificação exige motivo; resolver pendência exige justificativa e categoria; cancelado é imutável", async () => {
  const atual = { id: U(70), categoria_id: U(21), classificacao_pendente: true, status: "realizado", nota_revisao: "veio do arquivo" };
  const { deps, gravados } = repoFalso({ obterLancamento: async () => atual });
  await falha(() => lanc.atualizarLancamento(CTX, U(70), { categoriaId: U(22) }, deps), "RECLASSIFICACAO_SEM_MOTIVO");
  await lanc.atualizarLancamento(CTX, U(70), { categoriaId: U(22), notaRevisao: "era despesa variável" }, deps);
  assert.equal(gravados.at(-1).categoria_id, U(22));
  assert.match(gravados.at(-1).nota_revisao, /veio do arquivo \| era despesa variável/); // histórico cumulativo
  await falha(() => lanc.atualizarLancamento(CTX, U(70), { classificacaoPendente: false }, deps), "PENDENCIA_SEM_JUSTIFICATIVA");
  await lanc.atualizarLancamento(CTX, U(70), { classificacaoPendente: false, notaRevisao: "confirmado com o responsável" }, deps);
  assert.equal(gravados.at(-1).classificacao_pendente, false);
  const semCat = repoFalso({ obterLancamento: async () => ({ ...atual, categoria_id: null }) });
  await falha(() => lanc.atualizarLancamento(CTX, U(70), { classificacaoPendente: false, notaRevisao: "ok" }, semCat.deps), "PENDENCIA_SEM_CATEGORIA");
  const canc = repoFalso({ obterLancamento: async () => ({ ...atual, status: "cancelado" }) });
  await falha(() => lanc.atualizarLancamento(CTX, U(70), { descricao: "x" }, canc.deps), "LANCAMENTO_CANCELADO");
});

test("cancelamento exige motivo e nunca exclui", async () => {
  const { deps, gravados } = repoFalso({ obterLancamento: async () => ({ id: U(70), status: "realizado", nota_revisao: null }) });
  await falha(() => lanc.cancelarLancamento(CTX, U(70), {}, deps));
  await lanc.cancelarLancamento(CTX, U(70), { motivo: "lançado em duplicidade" }, deps);
  assert.equal(gravados.at(-1).status, "cancelado");
  assert.equal(typeof deps.repo.excluir, "undefined");
});

test("transferência: mesma conta recusada; sem categoria de transferência única é recusada; usa a categoria única", async () => {
  const { deps, gravados } = repoFalso();
  const t = { contaOrigemId: U(31), contaDestinoId: U(32), valor: "100,00", data: "2026-09-03" };
  await falha(() => lanc.criarTransferencia(CTX, { ...t, contaDestinoId: U(31) }, deps), "TRANSFERENCIA_MESMA_CONTA");
  await falha(() => lanc.criarTransferencia(CTX, { ...t, categoriaId: U(21) }, deps), "CATEGORIA_NAO_TRANSFERENCIA");
  await lanc.criarTransferencia(CTX, t, deps);
  assert.equal(gravados[0].categoriaId, U(23));
  assert.equal(gravados[0].valorCentavos, 10000);
  const nenhuma = repoFalso({ listarPlanoContas: async () => cats.filter((c) => c.papel !== "transferencia") });
  await falha(() => lanc.criarTransferencia(CTX, t, nenhuma.deps), "CATEGORIA_TRANSFERENCIA_INDEFINIDA");
});

test("plano de contas: papel inválido e saldo anterior como categoria são recusados", async () => {
  const { deps } = repoFalso({ inserirCategoria: async (_c, c) => c });
  await falha(() => cad.criarCategoria(CTX, { tipo: "A", natureza: "B", nome: "C", papel: "inventado" }, deps));
  await falha(() => cad.criarCategoria(CTX, { tipo: "A", natureza: "B", nome: "C", papel: "saldo_anterior" }, deps));
  const ok = await cad.criarCategoria(CTX, { tipo: "despesa", natureza: "fixa", nome: "luz", papel: "despesa_fixa" }, deps);
  assert.equal(ok.nome, "LUZ");
});

test("abertura: aceita negativo, exige valor e data; ausência continua significando 'desconhecido'", async () => {
  const { deps } = repoFalso({ gravarAbertura: async (_c, a) => a });
  const ok = await cad.definirAbertura(CTX, { contaId: U(31), dataReferencia: "2026-09-01", valor: "-12,34" }, deps);
  assert.equal(ok.valor_centavos, -1234);
  await falha(() => cad.definirAbertura(CTX, { contaId: U(31), dataReferencia: "2026-09-01" }, deps));
  await falha(() => cad.definirAbertura(CTX, { contaId: U(31), valor: "1" }, deps));
});

// ---- importação ----
const T = (o) => ({ linha: 3, data: "2026-09-01", descricao: "X", entrada: 0, saida: 1, tipo: "DESPESA", natureza: "FIXA", categoria: "C", conta: "A", ...o });
function depsImportacao(brutas, extra = {}) {
  const estado = { importacao: null, rpc: 0 };
  return { estado, deps: { db: undefined, leitor: () => ({ aba: "FLUXO", brutas, totalDeclarado: null, abasIgnoradas: ["OUTRA"] }), repo: {
    listarExistentesImportacao: async () => [], listarContas: async () => [], listarAberturas: async () => [],
    inserirImportacao: async (_c, i) => { estado.importacao = { id: U(80), status: "previa", created_at: "x", ...i }; return estado.importacao; },
    obterImportacao: async () => estado.importacao,
    atualizarPreviaImportacao: async (_c, _id, previa) => { estado.importacao.previa = previa; },
    confirmarImportacaoRpc: async () => { estado.rpc++; estado.importacao.status = "confirmada"; return { lancamentosGravados: brutas.length, jaExistentes: 0, saldosGravados: 0, paresVinculados: 0 }; },
    ...extra,
  } } };
}
const b64 = Buffer.from("PK-qualquer").toString("base64");

test("importação: nada é gravado antes da confirmação; confirmação exige aceite e é executada uma vez por RPC", async () => {
  const { estado, deps } = depsImportacao([T({ saida: 100 }), T({ linha: 4, saida: 200 })]);
  const previa = await imp.gerarPrevia(CTX, { nomeArquivo: "livro.xlsx", conteudoBase64: b64 }, deps);
  assert.equal(previa.resumo.novos, 2);
  assert.equal(estado.rpc, 0);
  await falha(() => imp.confirmarImportacao(CTX, U(80), {}, deps), "CONFIRMACAO_AUSENTE");
  const r = await imp.confirmarImportacao(CTX, U(80), { confirmo: true }, deps);
  assert.equal(r.reconciliacao.confere, true);
  assert.equal(estado.rpc, 1);
  const r2 = await imp.confirmarImportacao(CTX, U(80), { confirmo: true }, deps);
  assert.equal(r2.jaConfirmada, true);
  assert.equal(estado.rpc, 1); // reconfirmar não reexecuta
});

test("importação: prévia com erro de leitura ou totais divergentes não confirma", async () => {
  const comErro = depsImportacao([T({ saida: 100 }), T({ linha: 4, data: "lixo" })]);
  await imp.gerarPrevia(CTX, { conteudoBase64: b64 }, comErro.deps);
  await falha(() => imp.confirmarImportacao(CTX, U(80), { confirmo: true }, comErro.deps), "PREVIA_COM_ERROS");
  const total = depsImportacao([T({ saida: 100 })]);
  total.deps.leitor = () => ({ aba: "F", brutas: [T({ saida: 100 })], totalDeclarado: { entradaCentavos: 0, saidaCentavos: 1 }, abasIgnoradas: [] });
  await imp.gerarPrevia(CTX, { conteudoBase64: b64 }, total.deps);
  await falha(() => imp.confirmarImportacao(CTX, U(80), { confirmo: true }, total.deps), "TOTAIS_NAO_CONFEREM");
});

test("importação: arquivo ausente, inválido ou grande demais é recusado antes de ler", async () => {
  const { deps } = depsImportacao([T({})]);
  await falha(() => imp.gerarPrevia(CTX, {}, deps), "ARQUIVO_AUSENTE");
  await falha(() => imp.gerarPrevia(CTX, { conteudoBase64: "não é base64!" }, deps), "ARQUIVO_INVALIDO");
  await falha(() => imp.gerarPrevia(CTX, { conteudoBase64: "A".repeat(7_500_000) }, deps), "ARQUIVO_GRANDE");
});

test("importação: pares ambíguos nunca entram pelo lote; decisão exige par existente", async () => {
  const Tr = (o) => T({ tipo: "TRANSFERENCIA", natureza: "TRANSFERENCIA ENTRE CONTAS", categoria: "ENTRE CONTAS", ...o });
  const brutas = [Tr({ linha: 3, descricao: "T1", saida: 100, conta: "A" }), Tr({ linha: 4, descricao: "T2", saida: 100, conta: "B" }),
    Tr({ linha: 5, descricao: "T3", saida: 0, entrada: 100, conta: "C" }), Tr({ linha: 6, descricao: "T4", saida: 0, entrada: 100, conta: "D" })];
  const { deps } = depsImportacao(brutas);
  await imp.gerarPrevia(CTX, { conteudoBase64: b64 }, deps);
  const lote = await imp.decidirPares(CTX, U(80), { confirmarAltaConfianca: true }, deps);
  assert.equal(lote.resumo.paresConfirmados, 0);
  await falha(() => imp.decidirPares(CTX, U(80), { confirmar: ["inexistente"] }, deps), "PAR_DESCONHECIDO");
  const um = await imp.decidirPares(CTX, U(80), { confirmar: [lote.pares[0].id] }, deps);
  assert.equal(um.resumo.paresConfirmados, 1);
});

test("importação: não permite decidir sobre importação já confirmada", async () => {
  const { estado, deps } = depsImportacao([T({ saida: 5 })]);
  await imp.gerarPrevia(CTX, { conteudoBase64: b64 }, deps);
  estado.importacao.status = "confirmada";
  await falha(() => imp.decidirPares(CTX, U(80), { confirmarAltaConfianca: true }, deps), "IMPORTACAO_ESTADO_INVALIDO");
  await falha(() => imp.aceitarAlteracoes(CTX, U(80), { chaves: [] }, deps), "IMPORTACAO_ESTADO_INVALIDO");
});

// ---- relatórios a partir de dados sintéticos ----
test("relatórios: visão geral recalcula do banco, marca saldo parcial e aponta pendências", async () => {
  const cs = [
    { id: U(21), ativo: true, papel: "receita_operacional", nome: "VENDAS" }, { id: U(22), ativo: true, papel: "custo_variavel", nome: "INSUMOS" },
    { id: U(23), ativo: true, papel: "despesa_fixa", nome: "ALUGUEL" },
  ];
  const ls = [
    { id: "1", conta_id: U(31), categoria_id: U(21), sentido: "entrada", valor_centavos: 100000, data_movimento: "2026-09-01", status: "realizado", classificacao_pendente: false },
    { id: "2", conta_id: U(31), categoria_id: U(22), sentido: "saida", valor_centavos: 40000, data_movimento: "2026-09-02", status: "realizado", classificacao_pendente: false },
    { id: "3", conta_id: U(32), categoria_id: U(23), sentido: "saida", valor_centavos: 10000, data_movimento: "2026-09-02", status: "realizado", classificacao_pendente: false },
    { id: "4", conta_id: U(32), categoria_id: null, sentido: "saida", valor_centavos: 777, data_movimento: "2026-09-03", status: "realizado", classificacao_pendente: true },
  ];
  const deps = { db: undefined, repo: {
    listarTodosLancamentos: async () => ls, listarPlanoContas: async () => cs, listarContas: async () => contas.slice(0, 2),
    listarAberturas: async () => [{ conta_id: U(31), data_referencia: "2026-09-01", valor_centavos: 5000 }],
  } };
  const v = await rel.visaoGeral(CTX, { de: "2026-09-01", ate: "2026-09-30" }, deps);
  assert.equal(v.vazio, false);
  assert.equal(v.indicadores.receitaOperacional, 100000);
  assert.equal(v.indicadores.resultadoGerencial, 50000);
  assert.equal(v.saldoFinalParcial, true); // conta B sem abertura
  assert.equal(v.saldosPorConta.totalCentavos, null);
  assert.equal(v.saldosPorConta.conciliado, false);
  assert.equal(v.pendencias.pendentes, 1);
  assert.ok(v.alertas.some((a) => a.codigo === "ABERTURA_DESCONHECIDA"));
  assert.ok(v.alertas.some((a) => a.codigo === "PONTE_NAO_FECHA"));
  const d = await rel.dre(CTX, { de: "2026-09-01", ate: "2026-09-30" }, deps);
  assert.equal(d.regime.id, "caixa");
  assert.ok(d.avisos.some((a) => /não a venda bruta/.test(a)));
  const ml = d.linhas.find((l) => l.id === "margem_liquida");
  assert.equal(ml.bps, 5000);
  assert.equal(d.linhas.find((l) => l.id === "custos").detalhes[0].centavos, 40000);
  const vazio = await rel.visaoGeral(CTX, {}, { db: undefined, repo: { ...deps.repo, listarTodosLancamentos: async () => [], listarAberturas: async () => [] } });
  assert.equal(vazio.vazio, true);
  assert.equal(vazio.indicadores.margemLiquidaBps, null);
});
