// Central de Conferências reformulada — o que o backend passou a devolver (somente leitura) e a DISPENSA auditável de sugestões.
// Nenhuma migration: a dispensa usa as colunas de cancelamento da 156. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispensarModelo, registrarModelo, listar, MODELOS, PREFIXO_DISPENSA } from "../../src/modules/gestao-financeira/dominio/pendenciasDocumentais.service.js";
import { listar as central } from "../../src/modules/gestao-financeira/dominio/conferencias.service.js";
import { PDOC_SETEMBRO } from "../../../frontend/test/conferenciasFixture.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
function memoria() {
  const linhas = [], chamadas = []; let n = 0;
  const repo = {
    listarPendenciasDocumentais: async (_c, { competencia } = {}) => linhas.filter((r) => r.status === "ativa" && (!competencia || r.competencia === competencia)),
    listarPendenciasDocumentaisCanceladas: async () => linhas.filter((r) => r.status === "cancelada" && r.chave_origem),
    buscarPendenciaDocumental: async (_c, id) => linhas.find((r) => r.id === id) ?? null,
    inserirPendenciaDocumental: async (_c, l) => { chamadas.push(["insert", l]); const r = { id: `d${++n}`, status: "ativa", created_at: "t", updated_at: "t", ...l }; linhas.push(r); return r; },
    atualizarPendenciaDocumental: async (_c, id, campos) => { chamadas.push(["update", campos]); const r = linhas.find((x) => x.id === id); Object.assign(r, campos); return r; },
    inserirLancamento: async () => { throw new Error("NAO DEVE criar lancamento"); }, inserirPagamento: async () => { throw new Error("NAO DEVE criar pagamento"); },
  };
  return { deps: { repo, db: undefined, agora: () => "2026-11-10T10:00:00Z" }, linhas, chamadas };
}
const CHAVE = "doc:2026-09:divergencia-caixa-0-82";

test("a fixture da Central usa as MESMAS cinco sugestões do backend (chave e valor)", () => {
  const set = MODELOS.filter((m) => m.competencia === "2026-09");
  assert.deepEqual(PDOC_SETEMBRO.modelos.map((m) => [m.chave, m.valorCentavos, m.relacionadaChave]), set.map((m) => [m.chave, m.valorCentavos, m.relacionadaChave]));
});

test("dispensar exige justificativa (≥10) e grava UM registro já cancelado, com prefixo, usuário e data — sem pendência ativa nem movimentação", async () => {
  const { deps, linhas, chamadas } = memoria();
  await assert.rejects(() => dispensarModelo(ctx, CHAVE, { justificativa: "curta" }, deps), /mínimo de 10/);
  await assert.rejects(() => dispensarModelo(ctx, "doc:nao-existe", { justificativa: "justificativa longa o bastante" }, deps), /desconhecida/);
  const r = await dispensarModelo(ctx, CHAVE, { justificativa: "Cupom fiscal conferido: valor correto é R$ 96,00" }, deps);
  assert.equal(r.dispensada.justificativa, "Cupom fiscal conferido: valor correto é R$ 96,00");
  assert.deepEqual(chamadas.map((c) => c[0]), ["insert"]);
  const reg = linhas[0];
  assert.equal(reg.status, "cancelada"); assert.equal(reg.chave_origem, CHAVE); assert.equal(reg.cancelado_por, ctx.usuarioId); assert.equal(reg.cancelado_em, "2026-11-10T10:00:00Z");
  assert.ok(reg.motivo_cancelamento.startsWith(PREFIXO_DISPENSA)); assert.equal(reg.valor_centavos, 82, "o registro guarda os dados da sugestão (evidência histórica)");
  assert.equal(reg.estado, "aguardando_comprovacao", "nunca nasce confirmado");
});

test("listar: dispensada sai das sugestões em aberto com a justificativa; continua podendo ser cadastrada depois", async () => {
  const { deps } = memoria();
  await dispensarModelo(ctx, CHAVE, { justificativa: "Cupom fiscal conferido, sem diferença real" }, deps);
  let l = await listar(ctx, { mes: "2026-09" }, deps);
  const m = l.modelos.find((x) => x.chave === CHAVE);
  assert.equal(m.cadastrada, false); assert.equal(m.dispensada.justificativa, "Cupom fiscal conferido, sem diferença real");
  assert.equal(l.modelos.filter((x) => !x.cadastrada && !x.dispensada).length, 4);
  await registrarModelo(ctx, CHAVE, {}, deps);   // surgiu evidência: cadastra
  l = await listar(ctx, { mes: "2026-09" }, deps);
  assert.deepEqual([l.modelos.find((x) => x.chave === CHAVE).cadastrada, l.modelos.find((x) => x.chave === CHAVE).dispensada], [true, null]);
});

test("não dispensa o que já está cadastrado como pendência ativa", async () => {
  const { deps } = memoria();
  await registrarModelo(ctx, CHAVE, {}, deps);
  await assert.rejects(() => dispensarModelo(ctx, CHAVE, { justificativa: "tentativa de dispensar cadastrada" }, deps), /já está cadastrada/);
});

test("cancelamento comum (sem o prefixo) não é tratado como dispensa", async () => {
  const { deps, linhas } = memoria();
  linhas.push({ id: "x", status: "cancelada", chave_origem: CHAVE, motivo_cancelamento: "Cadastrada por engano", cancelado_em: "t" });
  const l = await listar(ctx, { mes: "2026-09" }, deps);
  assert.equal(l.modelos.find((x) => x.chave === CHAVE).dispensada, null);
});

test("central: juros traz as DUAS decisões separadas (quitar; classificar só depois de quitada) e datas para ordenar; terceiro traz obrigação e dívida", async () => {
  const PLANO = [{ id: "c-rec", nome: "RECEBIMENTO", papel: "receita_operacional", tipo: "X", ativo: true }, { id: "c-ins", nome: "INSUMOS - FRUTAS", papel: "custo_variavel", tipo: "X", ativo: true }];
  const OBR = [{ id: "o1", fornecedor_id: "f1", categoria_id: "c-ins", descricao: "Boleto fornecedor", competencia: "2026-09-01", vencimento: "2026-09-10", valor_original_centavos: 100000, status: "aberta" },
    { id: "o2", fornecedor_id: "f1", categoria_id: "c-ins", descricao: "Distribuidora 08/2026", competencia: "2026-08-01", vencimento: "2026-09-05", valor_original_centavos: 663360, status: "quitada" }];
  const PAG = [{ id: "p1", obrigacao_id: "o1", conta_id: "k1", data_pagamento: "2026-09-15", valor_centavos: 103000, status: "ativo", origem_pagamento: "conta" },
    { id: "p2", obrigacao_id: "o2", conta_id: null, data_pagamento: "2026-09-05", valor_centavos: 663360, status: "ativo", origem_pagamento: "terceiro", terceiro_nome: "Sócia", divida_id: "dv1", observacao: "Pago com recursos pessoais" }];
  const repo = { listarPlanoContas: async () => PLANO, listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }], listarAberturas: async () => [], listarTodosLancamentos: async () => [], listarReferencias: async () => [],
    listarObrigacoes: async () => OBR, listarPagamentos: async () => PAG, listarFornecedores: async () => [{ id: "f1", nome: "F" }], listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [],
    listarDividas: async () => [{ id: "dv1", credor: "Sócia", descricao: "Reembolso à sócia" }], listarEventosDivida: async () => [], listarAuditoria: async () => [] };
  const c = await central(ctx, { mes: "2026-09" }, { repo, db: undefined, hoje: () => "2026-11-10", env: {} });
  const j = c.pendencias.find((p) => p.tipo === "juros_presumido");
  assert.ok(j, "pago acima do original → acréscimo presumido"); {
    assert.equal(j.quitada, false); assert.ok(j.etapas.quitar.caminho.endsWith("/quitar")); assert.equal(j.etapas.classificar.disponivel, false);
    assert.equal(j.data, "2026-09-15"); assert.deepEqual(j.refs, ["o1"]);
  }
  const t = c.pendencias.find((p) => p.tipo === "pagamento_terceiro");
  assert.equal(t.terceiroNome, "Sócia"); assert.equal(t.obrigacao.descricao, "Distribuidora 08/2026"); assert.equal(t.divida.descricao, "Reembolso à sócia"); assert.equal(t.data, "2026-09-05"); assert.equal(t.acao, null, "nenhuma ação que registre saída bancária");
});
