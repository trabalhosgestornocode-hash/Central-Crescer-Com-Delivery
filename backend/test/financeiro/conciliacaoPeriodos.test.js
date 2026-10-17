// B7 (conciliação), B8 (períodos/fechamento) e cancelamento atômico de transferência — HTTP → rotas → serviços → motor, com repositório em
// memória e dados 100% SINTÉTICOS. As garantias de banco (travas, concorrência real, RLS) são provadas em backend/testes-financeiro-pg.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import XLSX from "xlsx";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local-nao-e-segredo";
process.env.SUPABASE_ANON_KEY = "teste-local-nao-e-segredo";
const { criarDominioRouter } = await import("../../src/modules/gestao-financeira/dominio/rotas.js");
const { criarRepoMemoria } = await import("./helpers/repoMemoria.js");
const perSvc = await import("../../src/modules/gestao-financeira/dominio/periodos.service.js");

const MFA = () => ({ aal: "aal2", em: new Date().toISOString() });
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = (...a) => a.map((x) => `gestao_financeira.${x}`);
// Matriz A7.1 (contrato com o Agente 1): reabrir e excluir não pertencem a nenhum nível.
const NIVEL = {
  leitura: P("ver"),
  operador: P("ver", "lancar", "editar"),
  gestor: P("ver", "lancar", "editar", "conciliar", "cancelar", "fechar", "configurar"),
};

const CTX_A = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3), permissoes: [] };
async function ambiente({ reaberturaHabilitada = false } = {}) {
  const repo = criarRepoMemoria();
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  const gate = (acao) => (req, _res, next) => {
    const t = req.headers["x-t"] ?? "A";
    const perms = (req.headers["x-perms"] ?? NIVEL.gestor.join(",")).split(",");
    req.financeiro = { organizacaoId: t === "A" ? U(1) : U(11), unidadeId: t === "A" ? U(2) : U(12), permissoes: perms };
    req.user = { id: U(3) };
    if (!perms.includes(acao)) return next(Object.assign(new Error("Permissão financeira insuficiente."), { statusCode: 403, details: { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" } }));
    next();
  };
  const router = criarDominioRouter({ autorizar: gate, deps: { repo, db: undefined, reaberturaHabilitada, agora: () => "2026-10-01T12:00:00.000Z" } });
  app.use("/fin", router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, details: err.details }));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/fin`;
  const chamar = async (metodo, caminho, corpo, { tenant = "A", perms } = {}) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { "content-type": "application/json", "x-t": tenant, ...(perms ? { "x-perms": perms.join(",") } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { repo, router, chamar, fechar: () => new Promise((ok) => srv.close(ok)) };
}

/** Cenário sintético: contas, plano e lançamentos do mês 2026-09. */
async function semear(a, t = "A") {
  const c = async (m, p, b) => { const r = await a.chamar(m, p, b, { tenant: t }); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.corpo)}`); return r.corpo.data; };
  const caixa = await c("POST", "/contas", { nome: "CAIXA", tipoConta: "caixa_fisico" });
  const banco = await c("POST", "/contas", { nome: "BANCO", tipoConta: "banco" });
  const stone = await c("POST", "/contas", { nome: "ADQUIRENTE", tipoConta: "adquirente" });
  const cat = {};
  for (const [nome, tipo, nat, papel] of [["VENDAS", "RECEITA", "R", "receita_operacional"], ["ALUGUEL", "DESPESA", "FIXA", "despesa_fixa"], ["OUTRAS", "DESPESA", "VARIAVEL", "despesa_variavel"], ["ENTRE CONTAS", "TRANSFERENCIA", "T", "transferencia"]]) {
    cat[nome] = await c("POST", "/plano-contas", { tipo, natureza: nat, nome, papel });
  }
  const l = (conta, categoria, sentido, valor, data, desc = "item sintetico") => c("POST", "/lancamentos", { contaId: conta.id, categoriaId: cat[categoria].id, descricao: desc, sentido, valor, dataMovimento: data });
  await l(caixa, "VENDAS", "entrada", "144,75", "2026-09-01");
  await l(caixa, "VENDAS", "entrada", "269,00", "2026-09-02");
  await l(banco, "VENDAS", "entrada", "1.500,00", "2026-09-03");
  await l(caixa, "OUTRAS", "saida", "48,00", "2026-09-01");
  await l(caixa, "OUTRAS", "saida", "51,00", "2026-09-02");
  await l(caixa, "ALUGUEL", "saida", "1.057,53", "2026-09-02", "pagamento do aluguel em especie");
  return { caixa, banco, stone, cat, l, c };
}
const ref = (data, tipo, valor, canal) => ({ data, tipo, valor, ...(canal ? { canal } : {}) });

test("conciliação: sem referências nada é inventado — tudo sem_referencia e sem pendência", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const r = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    assert.equal(r.resumo.semReferencia, true);
    assert.equal(r.resumo.pendenciasAbertas, 0);
    assert.equal(r.ponte.estado, "sem_referencia");
    assert.deepEqual(r.ponte.faltando, ["vendas", "taxas"]);
    assert.ok(r.caixaDias.every((d) => d.estado === "sem_referencia"));
    assert.equal(r.ponte.recebidoCentavos, 14475 + 26900 + 150000);
  } finally { await a.fechar(); }
});

test("conciliação: ponte vendas→recebido→taxas deixa o residual PENDENTE até classificação manual; sangria com exceção aprovada", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    let r = await a.chamar("POST", "/conciliacao/referencias", { itens: [
      ref("2026-09-30", "venda", "2.000,00"), ref("2026-09-30", "taxa", "50,00", "stone"),
      ref("2026-09-01", "dinheiro", "144,75"), ref("2026-09-02", "dinheiro", "270,00"),
      ref("2026-09-01", "sangria", "48,00"), ref("2026-09-02", "sangria", "61,00"),
    ] });
    assert.equal(r.status, 201);
    assert.equal(r.corpo.data.gravados, 6);
    const res = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    // 2.000,00 − 1.913,75 = 86,25 a explicar; taxa 50,00 → residual 36,25: PENDENTE (nunca "prazo" automático)
    assert.equal(res.ponte.diferencaAExplicarCentavos, 8625);
    assert.equal(res.ponte.residualCentavos, 3625);
    assert.equal(res.ponte.estado, "pendente_identificacao");
    const d1 = res.caixaDias.find((d) => d.data === "2026-09-01"), d2 = res.caixaDias.find((d) => d.data === "2026-09-02");
    assert.equal(d1.estado, "conciliado");
    assert.equal(d2.diferencaCentavos, -100);
    assert.equal(d2.estado, "pendente_identificacao");
    // sem exceção, o aluguel pago em espécie entra no confronto de sangrias
    assert.equal(res.sangriaDias.find((d) => d.data === "2026-09-02").diferencaCentavos, 5100 + 105753 - 6100);
    // exceção configurável, com motivo e AUDITÁVEL, só com `configurar` (gestor)
    const aluguel = (await a.chamar("GET", "/plano-contas")).corpo.data.find((c) => c.nome === "ALUGUEL");
    assert.equal((await a.chamar("POST", "/conciliacao/excecoes-sangria", { categoriaId: aluguel.id, motivo: "aluguel pago em especie nao e sangria" }, { perms: NIVEL.operador })).status, 403);
    assert.equal((await a.chamar("POST", "/conciliacao/excecoes-sangria", { categoriaId: aluguel.id, motivo: "x" })).status, 400);
    assert.equal((await a.chamar("POST", "/conciliacao/excecoes-sangria", { categoriaId: aluguel.id, motivo: "aluguel pago em especie nao e sangria" })).status, 201);
    assert.equal((await a.chamar("POST", "/conciliacao/excecoes-sangria", { categoriaId: aluguel.id, motivo: "outra aprovacao duplicada" })).status, 400);
    const res2 = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    const s2 = res2.sangriaDias.find((d) => d.data === "2026-09-02");
    assert.equal(s2.diferencaCentavos, -1000);
    assert.equal(s2.excluidasCentavos, 105753);
    assert.equal(res2.totalSangria.diferencaCentavos, -1000);
    assert.equal(res2.excecoesSangria[0].categoria, "ALUGUEL");
    assert.ok((await a.chamar("GET", "/auditoria?entidade=fin_sangria_excecoes")).corpo.data.length >= 1);
  } finally { await a.fechar(); }
});

test("classificação manual: valida sinal/excesso/nota, resolve parcial e total, revoga com motivo, mantém histórico e exige `conciliar`", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    await a.chamar("POST", "/conciliacao/referencias", { itens: [ref("2026-09-30", "venda", "2.000,00"), ref("2026-09-30", "taxa", "50,00")] });
    const corpo = (o) => ({ escopo: "ponte_mensal", chave: "2026-09-01", classificacao: "prazo", valor: "36,25", nota: "vendas do fim do mes recebidas depois", ...o });
    assert.equal((await a.chamar("POST", "/conciliacao/resolucoes", corpo(), { perms: NIVEL.operador })).status, 403);
    assert.equal((await a.chamar("POST", "/conciliacao/resolucoes", corpo({ valor: "-36,25" }))).status, 400);   // sinal oposto ao residual
    assert.equal((await a.chamar("POST", "/conciliacao/resolucoes", corpo({ valor: "40,00" }))).status, 400);    // excede
    assert.equal((await a.chamar("POST", "/conciliacao/resolucoes", corpo({ nota: "x" }))).status, 400);
    assert.equal((await a.chamar("POST", "/conciliacao/resolucoes", corpo({ classificacao: "inventada" }))).status, 400);
    const p1 = await a.chamar("POST", "/conciliacao/resolucoes", corpo({ valor: "10,00" }));
    assert.equal(p1.status, 201);
    let r = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    assert.equal(r.ponte.estado, "parcialmente_resolvido");
    const p2 = await a.chamar("POST", "/conciliacao/resolucoes", corpo({ valor: "26,25", classificacao: "taxa" }));
    r = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    assert.equal(r.ponte.estado, "resolvido");
    assert.equal(r.resumo.pendenciasAbertas, 0);
    // revogar exige motivo e volta a pendente; nada é apagado
    assert.equal((await a.chamar("POST", `/conciliacao/resolucoes/${p2.corpo.data.id}/revogar`, {})).status, 400);
    assert.equal((await a.chamar("POST", `/conciliacao/resolucoes/${p2.corpo.data.id}/revogar`, { motivo: "classificacao feita por engano" })).status, 200);
    r = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    assert.equal(r.ponte.estado, "parcialmente_resolvido");
    assert.equal(a.repo._t.resol.length, 2);
    const hist = (await a.chamar("GET", "/auditoria?entidade=fin_conciliacao_resolucoes")).corpo.data;
    assert.ok(hist.some((h) => h.antes?.status === "vigente" && h.depois?.status === "revogada"));
  } finally { await a.fechar(); }
});

test("referências por arquivo: simular não grava; reenviar/reordenar não duplica; erros bloqueiam; sem dado da planilha complementar", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const csv = (linhas) => Buffer.from(["DATA;TIPO;CANAL;VALOR", ...linhas].join("\n") + "\n").toString("base64");
    const wb = (aoa) => { const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(aoa), "Ref"); return XLSX.write(w, { type: "buffer", bookType: "xlsx" }).toString("base64"); };
    const linhas = [["2026-09-01", "venda", "", 500.5], ["2026-09-02", "taxa", "stone", 12.34], ["2026-09-02", "taxa", "stone", 12.34]];
    const arq = wb([["DATA", "TIPO", "CANAL", "VALOR"], ...linhas]);
    let r = (await a.chamar("POST", "/conciliacao/referencias/importar", { conteudoBase64: arq, simular: true })).corpo.data;
    assert.equal(r.simulado, true); assert.equal(r.lidos, 3); assert.equal(a.repo._t.refs.length, 0);
    r = (await a.chamar("POST", "/conciliacao/referencias/importar", { conteudoBase64: arq })).corpo.data;
    assert.equal(r.gravados, 3);                                   // as duas taxas idênticas são legítimas e ambas preservadas
    const reordenado = wb([["DATA", "TIPO", "CANAL", "VALOR"], ...[...linhas].reverse()]);
    r = (await a.chamar("POST", "/conciliacao/referencias/importar", { conteudoBase64: reordenado })).corpo.data;
    assert.equal(r.gravados, 0); assert.equal(r.ignorados, 3);
    assert.equal(a.repo._t.refs.length, 3);
    const ruim = (await a.chamar("POST", "/conciliacao/referencias/importar", { conteudoBase64: wb([["DATA", "TIPO", "VALOR"], ["2026-09-01", "inventado", 1], ["31/02/2026", "venda", 2]]) })).corpo.data;
    assert.equal(ruim.erros.length, 2); assert.equal(ruim.gravados, 0);
    assert.equal((await a.chamar("POST", "/conciliacao/referencias/importar", { conteudoBase64: csv(["2026-09-03;venda;;10,00"]) })).status, 200);
    assert.equal((await a.chamar("POST", "/conciliacao/referencias/importar", { conteudoBase64: arq }, { perms: NIVEL.operador })).status, 403);
    // cancelar referência exige motivo e não apaga
    const id = a.repo._t.refs[0].id;
    assert.equal((await a.chamar("POST", `/conciliacao/referencias/${id}/cancelar`, {})).status, 400);
    assert.equal((await a.chamar("POST", `/conciliacao/referencias/${id}/cancelar`, { motivo: "digitada errada" })).status, 200);
    assert.equal(a.repo._t.refs.find((x) => x.id === id).status, "cancelada");
  } finally { await a.fechar(); }
});

test("pendências históricas preservadas: motivos de revisão, duplicata legítima e movimentos com terceiros — nada classificado sozinho", async () => {
  const a = await ambiente();
  try {
    const cab = ["DATA", "LANÇAMENTOS", "ENTRADA", "SAIDA", "TIPO", "NATUREZA", "CATEGORIA", "CONTA"];
    const serial = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 25569;
    const ws = XLSX.utils.aoa_to_sheet([cab,
      [serial("2026-09-04"), "SEGURO", 0, 1.63, "DESPESA", "FINANCEIRAS", "TARIFAS", "BANCO"], [serial("2026-09-04"), "SEGURO", 0, 1.63, "DESPESA", "FINANCEIRAS", "TARIFAS", "BANCO"],
      [serial("2026-09-05"), "PIX ENVIADO", 0, 120, "DESPESA", "VARIAVEL", "PIX A IDENTIFICAR", "BANCO"],
      [serial("2026-09-05"), "PIX ENVIADO 2", 0, 80, "DESPESA", "VARIAVEL", "PIX A IDENTIFICAR", "BANCO"],
      [serial("2026-09-06"), "DINHEIRO DO DIA", 140, 0, "RECEITA", "RECEBIMENTO DE CLIENTE", "RECEBIMENTO DE CLIENTE", "CAIXA"],
      [serial("2026-09-07"), "PAGAMENTO TERCEIRO", 0, 500, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "BANCO"],
    ]);
    ws.C6 = { t: "n", v: 140, f: "245-106" };   // linha 6 = DINHEIRO DO DIA (entrada calculada por fórmula)
    const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, ws, "FLUXO DE CAIXA");
    const b64 = XLSX.write(w, { type: "buffer", bookType: "xlsx" }).toString("base64");
    const previa = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: b64 })).corpo.data;
    assert.equal((await a.chamar("POST", `/importacoes/${previa.id}/confirmar`, { confirmo: true })).status, 200);
    const pend = (await a.chamar("GET", "/conciliacao/pendencias?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.equal(pend.porMotivo.a_identificar.quantidade, 2);
    assert.equal(pend.porMotivo.a_identificar.valorCentavos, 20000);
    assert.equal(pend.porMotivo.valor_por_formula.quantidade, 1);
    assert.equal(pend.porMotivo.identica_no_arquivo.quantidade, 2);
    assert.equal(pend.possiveisDuplicatas.length, 1);
    assert.equal(pend.movimentosComTerceiros.quantidade, 1);
    assert.equal(pend.movimentosComTerceiros.liquidoSaindoCentavos, 50000);
    assert.equal(pend.totalPendentes, 3);                                   // 2 PIX + 1 transferência sem contraparte (a duplicata e a fórmula só ficam sinalizadas)
    // classificação manual autorizada: exige `conciliar`, nota e (se faltar) categoria
    const pix = pend.pendentes.find((p) => p.descricao === "PIX ENVIADO");
    assert.equal((await a.chamar("POST", `/conciliacao/pendencias/${pix.id}/resolver`, { nota: "origem confirmada com o responsavel" }, { perms: NIVEL.operador })).status, 403);
    assert.equal((await a.chamar("POST", `/conciliacao/pendencias/${pix.id}/resolver`, {})).status, 400);
    assert.equal((await a.chamar("POST", `/conciliacao/pendencias/${pix.id}/resolver`, { nota: "origem confirmada com o responsavel" })).status, 200);
    const depois = (await a.chamar("GET", "/conciliacao/pendencias?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.equal(depois.totalPendentes, 2);
    assert.equal(depois.porMotivo.a_identificar.pendentes, 1);                // o outro PIX continua pendente: nada foi classificado sozinho
  } finally { await a.fechar(); }
});

test("períodos: fechamento bloqueado com pendências; só EXCEÇÃO por competência (SuperAdmin, desabilitada) libera; snapshot; mês fechado imutável; conflito 409", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    await s.l(s.caixa, "VENDAS", "entrada", "10,00", "2026-09-10");
    // pendência: lançamento sem categoria
    await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "sem categoria", sentido: "saida", valor: "5,00", dataMovimento: "2026-09-11" });
    const pre = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    assert.equal(pre.avaliacao.pode, false);
    assert.equal(pre.pendencias.lancamentos, 1);
    assert.equal(pre.excecao, null);
    assert.equal(pre.periodo.status, "aberto");
    // GET de pré-fechamento é SOMENTE LEITURA: não cria linha de período
    const qtdPer = a.repo._t.per.length;
    const vazio = (await a.chamar("GET", "/periodos/2027-05/pre-fechamento")).corpo.data;
    assert.equal(vazio.periodo.id, null); assert.equal(vazio.periodo.status, "aberto"); assert.equal(vazio.periodo.versao, 1);
    assert.equal(a.repo._t.per.length, qtdPer, "GET criou período");
    const corpo = (o) => ({ confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint, ...o });
    // permissões: só gestor (fechar)
    assert.equal((await a.chamar("POST", "/periodos/2026-09/fechar", corpo(), { perms: NIVEL.operador })).status, 403);
    assert.equal((await a.chamar("POST", "/periodos/2026-09/fechar", corpo({ confirmo: false }))).status, 400);
    const bloq = await a.chamar("POST", "/periodos/2026-09/fechar", corpo());
    assert.equal(bloq.status, 400);
    assert.match(bloq.corpo.error, /pendência/i);
    assert.doesNotMatch(bloq.corpo.error, /fin_|tenant|unidade_id/);
    // NÃO existe política geral: o gestor não consegue LIGAR nada (403 fail-closed com código próprio); desligar é no-op; a leitura sempre diz "bloqueado"
    const lig = await a.chamar("PUT", "/periodos/politica", { permiteFecharComPendencias: true, notaAprovacao: "aprovado pela diretoria em ata 12", confirmoAprovacao: true });
    assert.equal(lig.status, 403); assert.equal(lig.corpo.details.codigo, "POLITICA_EXCEPCIONAL_DESABILITADA");
    assert.equal((await a.chamar("PUT", "/periodos/politica", { permiteFecharComPendencias: true }, { perms: NIVEL.operador })).status, 403);
    assert.equal((await a.chamar("PUT", "/periodos/politica", { permiteFecharComPendencias: false })).status, 200);
    assert.deepEqual((await a.chamar("GET", "/periodos/politica")).corpo.data, { modo: "excecao_por_competencia", permiteFecharComPendencias: false, excecaoFechamentoHabilitada: false });
    assert.equal(a.repo._t.exf.length, 0, "o PUT gravou alguma coisa");
    assert.equal((await a.chamar("GET", "/configuracoes")).corpo.data.fechamentoComPendencias.habilitada, false);
    // a concessão da exceção é fail-closed (desabilitada por padrão) e não tem rota HTTP
    await assert.rejects(() => perSvc.concederExcecaoFechamento(CTX_A, "2026-09", { justificativa: "justificativa longa o bastante", validadeDias: 7, mfaEvidencia: MFA() }, { repo: a.repo }), (e) => e.details?.codigo === "EXCECAO_FECHAMENTO_NAO_HABILITADA");
    assert.equal((await a.chamar("POST", "/periodos/2026-09/excecao", { justificativa: "justificativa longa o bastante", validadeDias: 7, mfaEvidencia: MFA() })).status, 404);
    // (simula a aprovação futura de SuperAdmin, já habilitada) — validações da concessão
    const dx = { repo: a.repo, excecaoFechamentoHabilitada: true, agora: () => "2026-10-01T12:00:00.000Z" };
    await assert.rejects(() => perSvc.concederExcecaoFechamento(CTX_A, "2026-09", { justificativa: "curta", validadeDias: 7, mfaEvidencia: MFA() }, dx), (e) => e.statusCode === 400);
    await assert.rejects(() => perSvc.concederExcecaoFechamento(CTX_A, "2026-09", { justificativa: "justificativa longa o bastante", validadeDias: 31, mfaEvidencia: MFA() }, dx), (e) => e.statusCode === 400);
    // sem MFA recente (AAL2) não há exceção: ausente, AAL1 ou vencida
    for (const m of [undefined, { aal: "aal1", em: new Date().toISOString() }, { aal: "aal2", em: new Date(Date.now() - 3600_000).toISOString() }]) {
      await assert.rejects(() => perSvc.concederExcecaoFechamento(CTX_A, "2026-09", { justificativa: "justificativa longa o bastante", validadeDias: 7, mfaEvidencia: m }, dx), (e) => e.statusCode === 400);
    }
    const exc = await perSvc.concederExcecaoFechamento(CTX_A, "2026-09", { justificativa: "justificativa: aguardando comprovante do fornecedor", validadeDias: 7, mfaEvidencia: MFA() }, dx);
    assert.equal(exc.status, "ativa"); assert.equal(exc.quantidade, 1); assert.equal(exc.pendencias.length, 1);
    assert.equal(a.repo._t.lanc.filter((l) => l.classificacao_pendente || !l.categoria_id).length, 1, "a concessão alterou pendências");
    const preEx = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    assert.equal(preEx.excecao.id, exc.id); assert.equal(preEx.avaliacao.pode, true); assert.equal(preEx.avaliacao.exigeReconhecimento, true);
    // com a exceção ainda é preciso RECONHECER as pendências
    const semRec = await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: preEx.periodo.versao, fingerprint: preEx.fingerprint });
    assert.equal(semRec.status, 400);
    // pendência NOVA depois da aprovação não é coberta
    await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "outra sem categoria", sentido: "saida", valor: "2,00", dataMovimento: "2026-09-13" });
    const preNovo = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    assert.equal(preNovo.avaliacao.pode, false);
    assert.equal(preNovo.avaliacao.bloqueios[0].codigo, "EXCECAO_INSUFICIENTE");
    const insuf = await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: preNovo.periodo.versao, fingerprint: preNovo.fingerprint, reconhecoPendencias: true });
    assert.equal(insuf.status, 400);
    assert.match(insuf.corpo.error, /não cobre/i);
    assert.equal(insuf.corpo.details.codigo, "FIN_PERIODO_EXCECAO_INSUFICIENTE");
    assert.equal(a.repo._t.exf[0].status, "ativa", "exceção gasta em tentativa que falhou");
    const nova = a.repo._t.lanc.find((l) => l.descricao === "outra sem categoria");
    assert.equal((await a.chamar("POST", `/lancamentos/${nova.id}/cancelar`, { motivo: "lancamento de teste cancelado" })).status, 200);
    // concorrência: alteração depois da pré-visualização → 409 e nada fecha
    await s.l(s.banco, "VENDAS", "entrada", "1,00", "2026-09-12");
    const conf = await a.chamar("POST", "/periodos/2026-09/fechar", corpo({ reconhecoPendencias: true }));
    assert.equal(conf.status, 409);
    assert.equal(conf.corpo.details.codigo, "FIN_PERIODO_CONFLITO_DADOS");
    assert.match(conf.corpo.error, /Recarregue/);
    // recarrega e fecha de verdade
    const pre2 = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    assert.equal(pre2.avaliacao.exigeReconhecimento, true);
    const ok = await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre2.periodo.versao, fingerprint: pre2.fingerprint, reconhecoPendencias: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.corpo.data.status, "fechado");
    assert.ok(ok.corpo.data.fechadoEm && ok.corpo.data.fechadoPor);
    const snap = a.repo._t.per.find((p) => p.mes === "2026-09-01").snapshot;
    assert.equal(snap.regime, "caixa");
    assert.equal(snap.pendenciasNoFechamento, 1);
    assert.equal(snap.indicadores.receitaOperacional, 14475 + 26900 + 150000 + 1000 + 100);
    assert.equal(snap.saldosConciliadosComExtrato, false);
    assert.equal(snap.geradoEm, "2026-10-01T12:00:00.000Z");
    // mês fechado: escrita recusada com mensagem amigável (sem detalhes internos); outros meses seguem abertos
    const neg = await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "novo", sentido: "saida", valor: "1,00", dataMovimento: "2026-09-20" });
    assert.equal(neg.status, 400);
    assert.match(neg.corpo.error, /fechado/i);
    assert.doesNotMatch(neg.corpo.error, /fin_periodo|tenant|23514/);
    assert.equal((await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "outubro", sentido: "saida", valor: "1,00", dataMovimento: "2026-10-02" })).status, 201);
    assert.equal((await a.chamar("POST", "/conciliacao/referencias", { itens: [ref("2026-09-20", "venda", "1,00")] })).status, 400);
    // fechar de novo → recusado
    assert.equal((await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: ok.corpo.data.versao, fingerprint: pre2.fingerprint, reconhecoPendencias: true })).status, 400);
    // versão desatualizada → 409
    const pre3 = (await a.chamar("GET", "/periodos/2026-10/pre-fechamento")).corpo.data;
    const v = await a.chamar("POST", "/periodos/2026-10/fechar", { confirmo: true, versao: pre3.periodo.versao + 7, fingerprint: pre3.fingerprint });
    assert.equal(v.status, 409);
    // auditoria do fechamento com antes/depois
    const h = (await a.chamar("GET", "/auditoria?entidade=fin_periodos")).corpo.data;
    assert.ok(h.some((x) => x.antes?.status === "aberto" && x.depois?.status === "fechado"));
    // listagem
    const lista = (await a.chamar("GET", "/periodos")).corpo.data;
    assert.equal(lista.periodos.find((p) => p.mes === "2026-09").status, "fechado");
    assert.equal(lista.excecoes.length, 1); assert.equal(lista.excecoes[0].status, "consumida"); assert.equal(lista.excecaoFechamentoHabilitada, false);
    assert.equal(snap.excecaoFechamentoId, lista.excecoes[0].id);
    assert.equal(lista.politica, undefined);
    // uso único: nova pendência em outro mês não herda a exceção consumida
    await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "pendente em outubro", sentido: "saida", valor: "3,00", dataMovimento: "2026-10-05" });
    const preOut = (await a.chamar("GET", "/periodos/2026-10/pre-fechamento")).corpo.data;
    assert.equal(preOut.avaliacao.pode, false); assert.equal(preOut.excecao, null);
  } finally { await a.fechar(); }
});

test("períodos: sem pendências fecha sem política; mês vazio e mês inválido; abrir é idempotente e exige `fechar`", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    for (const p of [{ v: "2026-09", e: 200 }]) {
      const pre = (await a.chamar("GET", `/periodos/${p.v}/pre-fechamento`)).corpo.data;
      assert.equal(pre.avaliacao.pode, true);
      const r = await a.chamar("POST", `/periodos/${p.v}/fechar`, { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint });
      assert.equal(r.status, p.e);
    }
    assert.equal((await a.chamar("GET", "/periodos/2026-13/pre-fechamento")).status, 400);
    assert.equal((await a.chamar("POST", "/periodos/abrir", { mes: "2026-11" }, { perms: NIVEL.operador })).status, 403);
    const x = (await a.chamar("POST", "/periodos/abrir", { mes: "2026-11" })).corpo.data;
    const y = (await a.chamar("POST", "/periodos/abrir", { mes: "2026-11" })).corpo.data;
    assert.equal(x.id, y.id);
    assert.equal(x.status, "aberto");
    const vazio = (await a.chamar("GET", "/periodos/2026-11/pre-fechamento")).corpo.data;
    assert.equal(vazio.vazio, true);
    assert.ok(s);
  } finally { await a.fechar(); }
});

test("reabertura: NÃO existe rota HTTP (404 para qualquer permissão) nem no catálogo de rotas; o serviço segue fail-closed e, habilitado, exige motivo e versão", async () => {
  const fechado = async (a) => {
    await semear(a);
    const pre = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    return (await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint })).corpo.data;
  };
  const a = await ambiente({ reaberturaHabilitada: true });                 // mesmo "habilitada" no serviço, a rota não existe
  try {
    const f = await fechado(a);
    assert.equal(f.status, "fechado");
    for (const perms of [NIVEL.gestor, [...NIVEL.gestor, ...P("reabrir")], [...NIVEL.gestor, ...P("reabrir", "excluir")]]) {
      for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await a.chamar(metodo, "/periodos/2026-09/reabrir", { motivo: "correcao aprovada pela diretoria", versao: f.versao }, { perms });
        assert.equal(r.status, 404, `${metodo} /reabrir deveria ser 404`);
      }
    }
    // catálogo de rotas: nenhuma rota do domínio menciona reabertura
    const caminhos = a.router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(",")} ${l.route.path}`);
    assert.ok(caminhos.length > 30);
    assert.deepEqual(caminhos.filter((c) => /reabr|reopen/i.test(c)), []);
    assert.equal(a.repo._t.per.find((p) => p.mes === "2026-09-01").status, "fechado");
    // serviço (para uso futuro, quando houver política/rota próprias): fail-closed sem a flag; com a flag exige motivo e versão
    const ctx = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3), permissoes: [] };
    await assert.rejects(() => perSvc.reabrir(ctx, "2026-09", { motivo: "correcao aprovada pela diretoria", versao: f.versao }, { repo: a.repo }), (e) => e.details?.codigo === "REABERTURA_NAO_HABILITADA");
    const dx = { repo: a.repo, reaberturaHabilitada: true };
    await assert.rejects(() => perSvc.reabrir(ctx, "2026-09", { motivo: "curto", versao: f.versao }, dx), (e) => e.statusCode === 400);
    await assert.rejects(() => perSvc.reabrir(ctx, "2026-09", { motivo: "correcao aprovada pela diretoria", versao: f.versao + 5 }, dx), (e) => e.statusCode === 409);
    const r = await perSvc.reabrir(ctx, "2026-09", { motivo: "correcao aprovada pela diretoria", versao: f.versao }, dx);
    assert.equal(r.status, "reaberto");
    assert.match(r.motivoReabertura, /correcao/);
    const h = (await a.chamar("GET", "/auditoria?entidade=fin_periodos")).corpo.data;
    assert.ok(h.some((x) => x.antes?.status === "fechado" && x.depois?.status === "reaberto"));
  } finally { await a.fechar(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Transferências: cancelar isolado × desvincular × cancelar o par inteiro
// ---------------------------------------------------------------------------------------------------------------------
async function comPar(a, t = "A") {
  const s = await semear(a, t);
  const r = await a.chamar("POST", "/transferencias", { contaOrigemId: s.caixa.id, contaDestinoId: s.banco.id, valor: "300,00", data: "2026-09-15", descricao: "deposito do caixa" }, { tenant: t });
  assert.equal(r.status, 201);
  const pares = (await a.chamar("GET", "/transferencias", null, { tenant: t })).corpo.data;
  return { ...s, par: pares[0], parId: r.corpo.data.id };
}
const statusPernas = (a, par) => [par.lancamento_saida_id, par.lancamento_entrada_id].map((id) => a.repo._t.lanc.find((l) => l.id === id).status);

test("cancelar TRANSFERÊNCIA INTEIRA: atômico, com motivo, auditado, idempotente e exige `cancelar`", async () => {
  const a = await ambiente();
  try {
    const x = await comPar(a);
    const url = `/transferencias/${x.parId}/cancelar`;
    assert.equal((await a.chamar("POST", url, { motivo: "lancada em duplicidade pelo operador" }, { perms: NIVEL.operador })).status, 403);
    assert.deepEqual(statusPernas(a, x.par), ["realizado", "realizado"]);
    assert.equal((await a.chamar("POST", url, {})).status, 400);
    assert.equal((await a.chamar("POST", url, { motivo: "curto" })).status, 400);
    assert.deepEqual(statusPernas(a, x.par), ["realizado", "realizado"]);
    const antes = a.repo._t.aud.length;
    const r = await a.chamar("POST", url, { motivo: "lancada em duplicidade pelo operador" });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.data.jaCancelada, false);
    assert.deepEqual(statusPernas(a, x.par), ["cancelado", "cancelado"]);
    assert.equal(a.repo._t.transf.find((p) => p.id === x.parId).status, "cancelada");
    assert.equal(a.repo._t.aud.length - antes, 3);                          // 2 pernas + par, com antes/depois
    assert.ok(a.repo._t.lanc.filter((l) => [x.par.lancamento_saida_id, x.par.lancamento_entrada_id].includes(l.id)).every((l) => /duplicidade/.test(l.nota_revisao)));
    // idempotente: repetir não muda nem audita de novo
    const n = a.repo._t.aud.length;
    const r2 = await a.chamar("POST", url, { motivo: "segunda chamada identica" });
    assert.equal(r2.status, 200); assert.equal(r2.corpo.data.jaCancelada, true); assert.equal(a.repo._t.aud.length, n);
    // cancelada não desvincula; saiu dos cálculos
    assert.equal((await a.chamar("POST", `/transferencias/${x.parId}/desvincular`, { motivo: "tentando desvincular cancelada" })).status, 400);
    const ind = (await a.chamar("GET", "/relatorios/indicadores?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.ok(ind.itens.length > 0);
  } finally { await a.fechar(); }
});

test("cancelamento do par: tudo ou nada em mês fechado, e outra unidade/organização não alcança", async () => {
  const a = await ambiente();
  try {
    const x = await comPar(a);
    a.repo.fecharPeriodo({ organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) }, "2026-09");
    const r = await a.chamar("POST", `/transferencias/${x.parId}/cancelar`, { motivo: "tentando cancelar em mes fechado" });
    assert.equal(r.status, 400);
    assert.match(r.corpo.error, /fechado/i);
    assert.doesNotMatch(r.corpo.error, /fin_periodo|23514/);
    assert.deepEqual(statusPernas(a, x.par), ["realizado", "realizado"]);
    assert.equal(a.repo._t.transf.find((p) => p.id === x.parId).status, "vinculada");
  } finally { await a.fechar(); }
  const b = await ambiente();
  try {
    const x = await comPar(b, "A");
    const outro = await b.chamar("POST", `/transferencias/${x.parId}/cancelar`, { motivo: "outra unidade tentando cancelar" }, { tenant: "B" });
    assert.equal(outro.status, 404);
    assert.deepEqual(statusPernas(b, x.par), ["realizado", "realizado"]);
    const des = await b.chamar("POST", `/transferencias/${x.parId}/desvincular`, { motivo: "outra unidade tentando desvincular" }, { tenant: "B" });
    assert.equal(des.status, 404);
    assert.equal(b.repo._t.transf.length, 1);
  } finally { await b.fechar(); }
});

test("três operações com regras próprias: perna vinculada não cancela sozinha; desvincular exige motivo e mantém as pernas ATIVAS e pendentes; perna sem par exige confirmação", async () => {
  const a = await ambiente();
  try {
    const x = await comPar(a);
    // 1) cancelar lançamento isolado: perna vinculada → mensagem amigável apontando as alternativas
    const perna = await a.chamar("POST", `/lancamentos/${x.par.lancamento_saida_id}/cancelar`, { motivo: "tentando cancelar so uma perna" });
    assert.equal(perna.status, 400);
    assert.match(perna.corpo.error, /Cancelar transferência/);
    assert.match(perna.corpo.error, /Desvincular/);
    assert.deepEqual(statusPernas(a, x.par), ["realizado", "realizado"]);
    // trocar a categoria de perna vinculada (achado da revisão da 121) também é recusado
    const outra = (await a.chamar("GET", "/plano-contas")).corpo.data.find((c) => c.nome === "OUTRAS");
    assert.equal((await a.chamar("PATCH", `/lancamentos/${x.par.lancamento_saida_id}`, { categoriaId: outra.id, notaRevisao: "tentando trocar a categoria" })).status, 400);
    // 2) desvincular: motivo obrigatório, as DUAS pernas seguem ativas e viram pendentes (nunca "desvincula e cancela uma")
    assert.equal((await a.chamar("POST", `/transferencias/${x.parId}/desvincular`, {})).status, 400);
    assert.equal((await a.chamar("POST", `/transferencias/${x.parId}/desvincular`, { motivo: "pareamento incorreto confirmado" }, { perms: NIVEL.operador })).status, 403);
    assert.equal((await a.chamar("POST", `/transferencias/${x.parId}/desvincular`, { motivo: "pareamento incorreto confirmado" })).status, 200);
    assert.deepEqual(statusPernas(a, x.par), ["realizado", "realizado"]);
    const pernas = a.repo._t.lanc.filter((l) => [x.par.lancamento_saida_id, x.par.lancamento_entrada_id].includes(l.id));
    assert.ok(pernas.every((l) => l.classificacao_pendente && /Par desfeito/.test(l.nota_revisao) && l.revisao_motivos.includes("transferencia_sem_contraparte")));
    // 3) perna sem par (movimento externo): só cancela com confirmação explícita
    const sem = await a.chamar("POST", `/lancamentos/${x.par.lancamento_saida_id}/cancelar`, { motivo: "movimento externo lancado errado" });
    assert.equal(sem.status, 400);
    assert.equal(sem.corpo.details.codigo, "PERNA_ISOLADA_SEM_CONFIRMACAO");
    assert.equal((await a.chamar("POST", `/lancamentos/${x.par.lancamento_saida_id}/cancelar`, { motivo: "movimento externo lancado errado", confirmoPernaIsolada: true })).status, 200);
    // lançamento comum continua cancelando normalmente e cancelar de novo é idempotente
    const comum = a.repo._t.lanc.find((l) => l.descricao === "pagamento do aluguel em especie");
    assert.equal((await a.chamar("POST", `/lancamentos/${comum.id}/cancelar`, { motivo: "lancamento duplicado" })).status, 200);
    assert.equal((await a.chamar("POST", `/lancamentos/${comum.id}/cancelar`, { motivo: "lancamento duplicado" })).status, 200);
  } finally { await a.fechar(); }
});

test("permissões por nível em todas as rotas novas: leitura só consulta; operador não concilia/cancela/fecha; gestor sim; ninguém reabre", async () => {
  const a = await ambiente();
  try {
    const s = await comPar(a);
    const rotas = [
      ["GET", "/conciliacao/resumo?mes=2026-09", null, ["leitura", "operador", "gestor"]],
      ["GET", "/periodos", null, ["leitura", "operador", "gestor"]],
      ["POST", "/conciliacao/referencias", { itens: [ref("2026-10-05", "venda", "1,00")] }, ["gestor"]],
      ["POST", "/conciliacao/excecoes-sangria", { categoriaId: s.cat.ALUGUEL.id, motivo: "motivo valido e longo" }, ["gestor"]],
      ["POST", "/periodos/abrir", { mes: "2026-12" }, ["gestor"]],
      ["PUT", "/periodos/politica", { permiteFecharComPendencias: false }, ["gestor"]],
      ["POST", `/transferencias/${s.parId}/cancelar`, { motivo: "cancelamento de teste do par" }, ["gestor"]],
    ];
    for (const [m, p, b, quem] of rotas) {
      for (const nivel of ["leitura", "operador", "gestor"]) {
        const r = await a.chamar(m, p, b, { perms: NIVEL[nivel] });
        if (quem.includes(nivel)) assert.notEqual(r.status, 403, `${nivel} deveria alcançar ${m} ${p}`);
        else assert.equal(r.status, 403, `${nivel} NÃO deveria alcançar ${m} ${p}`);
      }
    }
    assert.equal((await a.chamar("POST", "/periodos/2026-09/reabrir", { motivo: "motivo valido e longo", versao: 1 }, { perms: NIVEL.gestor })).status, 404);   // sem rota (LD-009/A5)
  } finally { await a.fechar(); }
});

test("isolamento: períodos, referências, resoluções e exceções de uma unidade não aparecem nem se alteram em outra", async () => {
  const a = await ambiente();
  try {
    await semear(a, "A");
    await a.chamar("POST", "/conciliacao/referencias", { itens: [ref("2026-09-30", "venda", "999,00")] }, { tenant: "A" });
    const pre = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento", null, { tenant: "A" })).corpo.data;
    await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint }, { tenant: "A" });
    assert.equal((await a.chamar("GET", "/conciliacao/referencias?mes=2026-09", null, { tenant: "B" })).corpo.data.length, 0);
    assert.equal((await a.chamar("GET", "/periodos", null, { tenant: "B" })).corpo.data.periodos.length, 0);
    assert.equal((await a.chamar("GET", "/conciliacao/resumo?mes=2026-09", null, { tenant: "B" })).corpo.data.resumo.referenciasNoMes, 0);
    // B escreve livremente em setembro (o mês fechado é só de A) e fecha o seu sem interferir
    const sb = await semear(a, "B");
    assert.ok(sb.caixa.id);
    const preB = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento", null, { tenant: "B" })).corpo.data;
    assert.equal(preB.periodo.status, "aberto");
    const refId = a.repo._t.refs[0].id;
    assert.equal((await a.chamar("POST", `/conciliacao/referencias/${refId}/cancelar`, { motivo: "unidade errada tentando cancelar" }, { tenant: "B" })).status, 404);
  } finally { await a.fechar(); }
});

test("mensagens amigáveis: nenhuma resposta de erro vaza nomes internos do banco", async () => {
  const a = await ambiente();
  try {
    const s = await comPar(a);
    a.repo.fecharPeriodo({ organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) }, "2026-09");
    const respostas = [
      await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "x", sentido: "saida", valor: "1", dataMovimento: "2026-09-02" }),
      await a.chamar("PATCH", `/lancamentos/${s.par.lancamento_saida_id}`, { descricao: "x" }),
      await a.chamar("POST", `/transferencias/${s.parId}/cancelar`, { motivo: "cancelar em mes fechado" }),
      await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: 1, fingerprint: "x" }),
      await a.chamar("POST", "/lancamentos", { contaId: U(99), descricao: "x", sentido: "saida", valor: "1", dataMovimento: "2026-10-02" }),
    ];
    for (const r of respostas) {
      assert.ok(r.status >= 400);
      // o texto mostrado à pessoa (error) nunca traz detalhes internos; details.codigo é identificador estável do contrato
      assert.doesNotMatch(String(r.corpo.error), /fin_[a-z_]{4,}|23514|P0002|organizacao_id|unidade_id|violates|constraint|trigger|tenant/i);
    }
  } finally { await a.fechar(); }
});

test("regressão do motor: os indicadores continuam idênticos com cancelamentos e fechamentos no meio", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    const antes = (await a.chamar("GET", "/relatorios/dre?de=2026-09-01&ate=2026-09-30")).corpo.data;
    const L = (d, id) => d.linhas.find((l) => l.id === id).centavos;
    assert.equal(L(antes, "receita"), 14475 + 26900 + 150000);
    assert.equal(L(antes, "desp_fixas"), 105753);
    await a.chamar("POST", "/transferencias", { contaOrigemId: s.caixa.id, contaDestinoId: s.banco.id, valor: "77,00", data: "2026-09-20" });
    const par = (await a.chamar("GET", "/transferencias")).corpo.data[0];
    const comPar = (await a.chamar("GET", "/relatorios/dre?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.equal(L(comPar, "resultado"), L(antes, "resultado"));          // transferência interna não altera o resultado
    await a.chamar("POST", `/transferencias/${par.id}/cancelar`, { motivo: "cancelamento para regressao" });
    const depois = (await a.chamar("GET", "/relatorios/dre?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.equal(L(depois, "resultado"), L(antes, "resultado"));
    const ig = (await a.chamar("GET", "/relatorios/integridade?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.deepEqual(ig.violacoesPares, []);
    assert.equal(ig.ponteFecha, true);
  } finally { await a.fechar(); }
});

test("evidência de MFA da exceção: janela de 10 min, lista fechada de chaves, nada com cara de token (LD-009 A1/A2)", () => {
  const agora = Date.parse("2026-10-17T14:00:00.000Z");
  const iso = (ms) => new Date(agora + ms).toISOString();
  const ok = (m) => perSvc.validarEvidenciaMfa(m, agora);
  const nok = (m) => assert.throws(() => ok(m), (e) => e.statusCode === 400 && e.details?.codigo === "MFA_OBRIGATORIO");
  assert.equal(perSvc.JANELA_MFA_MS, 600000);
  assert.deepEqual(ok({ aal: "aal2", em: iso(-600000) }), { aal: "aal2", em: iso(-600000) });          // 10 min exatos: aceita
  nok({ aal: "aal2", em: iso(-601000) });                                                               // 10 min + 1 s: recusa
  ok({ aal: "aal2", em: iso(60000) }); nok({ aal: "aal2", em: iso(61000) });                           // futuro: tolerância de 60 s
  const sha = "a".repeat(64);
  ok({ aal: "aal2", em: iso(-1000), metodo: "totp", sessao_ref: sha }); ok({ aal: "aal2", em: iso(-1000), metodo: "webauthn" });
  for (const ruim of [undefined, null, "x", [], {}, { aal: "aal1", em: iso(0) }, { aal: "aal2" }, { aal: "aal2", em: Date.now() }, { aal: "aal2", em: "hoje" },
    { aal: "aal2", em: iso(0), extra: "x" }, { aal: "aal2", em: iso(0), jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinaturaassinatura" },
    { aal: "aal2", em: iso(0), metodo: "sms" }, { aal: "aal2", em: iso(0), sessao_ref: "0f3c2a77-aaaa-bbbb-cccc-1234567890ab" }, { aal: "aal2", em: iso(0), sessao_ref: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinaturaassinatura" }]) nok(ruim);
});
