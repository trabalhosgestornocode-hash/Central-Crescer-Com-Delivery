// Pendências documentais: cadastro manual SEM movimentação financeira, sem duplicidade, confirmação só com evidência, trilha e integração com a Central. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registrar, registrarModelo, editar, confirmar, cancelar, historico, listar, MODELOS } from "../../src/modules/gestao-financeira/dominio/pendenciasDocumentais.service.js";
import { listar as listarCentral } from "../../src/modules/gestao-financeira/dominio/conferencias.service.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const memoria = (extra = {}) => {
  const linhas = []; const chamadas = []; let n = 0;
  const repo = {
    listarPendenciasDocumentais: async (_c, { competencia } = {}) => linhas.filter((r) => r.status === "ativa" && (!competencia || r.competencia === competencia)),
    buscarPendenciaDocumental: async (_c, id) => linhas.find((r) => r.id === id) ?? null,
    inserirPendenciaDocumental: async (_c, l) => { chamadas.push(["insert", l]); const r = { id: `d${++n}`, status: "ativa", created_at: "t", updated_at: "t", ...l }; linhas.push(r); return r; },
    atualizarPendenciaDocumental: async (_c, id, campos) => { chamadas.push(["update", campos]); const r = linhas.find((x) => x.id === id); if (!r) return null; Object.assign(r, campos); return r; },
    listarAuditoria: async (_c, { entidade, entidadeId }) => { chamadas.push(["auditoria", entidade, entidadeId]); return [{ id: 1, acao: "insert", created_at: "t", ator_id: "u" }]; },
    // qualquer função financeira chamada por engano quebra o teste
    inserirLancamento: async () => { throw new Error("NAO DEVE criar lancamento"); }, inserirPagamento: async () => { throw new Error("NAO DEVE criar pagamento"); },
    ...extra,
  };
  return { deps: { repo, db: undefined, agora: () => "2026-11-09T10:00:00Z" }, linhas, chamadas };
};
const base = { descricao: "Diferença de caixa de teste", valor: "190,53", competencia: "2026-09", motivo: "Contagem × saldo", evidenciaNecessaria: "Contagem física do caixa", responsavel: "Contadora", estado: "pendente" };

function centralBase() {
  const PLANO = [{ id: "c1", nome: "RECEBIMENTO", papel: "receita_operacional", tipo: "X", ativo: true }];
  return { listarPlanoContas: async () => PLANO, listarContas: async () => [], listarAberturas: async () => [], listarTodosLancamentos: async () => [], listarReferencias: async () => [], listarObrigacoes: async () => [], listarPagamentos: async () => [], listarFornecedores: async () => [],
    listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [], listarRateios: async () => [], listarParcelasRateio: async () => [], listarVendasCanal: async () => [], listarVendasAjustes: async () => [], listarReferenciasOficiais: async () => [], listarAuditoria: async () => [] };
}

test("registrar grava só a pendência (valor em centavos, competência no dia 1) e nunca confirma nem movimenta dinheiro", async () => {
  const { deps, chamadas } = memoria();
  const r = await registrar(ctx, base, deps);
  assert.equal(r.valorCentavos, 19053); assert.equal(r.competencia, "2026-09"); assert.equal(r.estado, "pendente"); assert.equal(r.confirmacao, null);
  assert.deepEqual(chamadas.map((x) => x[0]), ["insert"]); assert.equal(chamadas[0][1].competencia, "2026-09-01");
  await assert.rejects(() => registrar(ctx, { ...base, descricao: "Outra", estado: "confirmado" }, deps), /estado inválido/, "não nasce confirmada");
  await assert.rejects(() => registrar(ctx, { ...base, descricao: "Sem motivo", motivo: "" }, deps));
});

test("duplicidade: mesma chave, mesma descrição na competência e mesmo valor de pendência automática são barrados", async () => {
  const { deps } = memoria();
  await registrar(ctx, { ...base, chaveOrigem: "k1" }, deps);
  await assert.rejects(() => registrar(ctx, { ...base, descricao: "Outra descrição", chaveOrigem: "k1" }, deps), /já está cadastrada/);
  await assert.rejects(() => registrar(ctx, { ...base, descricao: "  diferença DE caixa de teste " }, deps), /mesma descrição/);
  const comAuto = { ...deps, automaticas: async () => [{ titulo: "Pagamento X", valorCentavos: 82 }] };
  await assert.rejects(() => registrar(ctx, { ...base, descricao: "Divergência 0,82", valor: "0,82" }, comAuto), /pendência automática de mesmo valor/);
  const ok = await registrar(ctx, { ...base, descricao: "Divergência 0,82", valor: "0,82", confirmaDistinta: true }, comAuto);
  assert.equal(ok.valorCentavos, 82);
});

test("modelos: os cinco itens existem preparados e NÃO gravados; cadastrar é individual e idempotente; 190,53 e 195,25 ficam relacionados", async () => {
  assert.equal(MODELOS.length, 5);
  assert.deepEqual(MODELOS.map((m) => m.valorCentavos).filter((x) => x != null).sort((a, b) => a - b), [82, 19053, 19525, 20000]);
  assert.ok(MODELOS.some((m) => /sangria/i.test(m.descricao) && m.valorCentavos == null));
  const a = MODELOS.find((m) => m.valorCentavos === 19053), b = MODELOS.find((m) => m.valorCentavos === 19525);
  assert.equal(a.relacionadaChave, b.chave); assert.equal(b.relacionadaChave, a.chave); assert.match(a.observacoes, /não tratar como duas perdas independentes/);
  const { deps, linhas } = memoria();
  const antes = await listar(ctx, { mes: "2026-09" }, deps);
  assert.equal(antes.modelos.length, 5); assert.ok(antes.modelos.every((m) => !m.cadastrada)); assert.equal(linhas.length, 0, "listar não grava nada");
  await registrarModelo(ctx, a.chave, {}, deps);
  await assert.rejects(() => registrarModelo(ctx, a.chave, {}, deps), /já está cadastrada/);
  const dep = await listar(ctx, { mes: "2026-09" }, deps);
  assert.equal(dep.modelos.find((m) => m.chave === a.chave).cadastrada, true); assert.equal(dep.itens.length, 1);
  await assert.rejects(() => registrarModelo(ctx, "inexistente", {}, deps), /desconhecido/);
});

test("confirmar exige evidência, registra quem e quando, e não repete; editar/cancelar ficam na trilha e confirmada não é editável", async () => {
  const { deps, chamadas } = memoria();
  const r = await registrar(ctx, { ...base, estado: "estimado" }, deps);
  await assert.rejects(() => confirmar(ctx, r.id, { evidencia: "" }, deps));
  await assert.rejects(() => confirmar(ctx, r.id, { evidencia: "abc" }, deps), (e) => e.codigo === "EVIDENCIA_OBRIGATORIA" || /evidência/i.test(e.message));
  const ed = await editar(ctx, r.id, { responsavel: "Proprietário", observacoes: "ligar para a contadora" }, deps);
  assert.equal(ed.responsavel, "Proprietário"); assert.equal(ed.valorCentavos, 19053, "campos não enviados ficam como estavam");
  const c = await confirmar(ctx, r.id, { evidencia: "Extrato bancário de 30/09, página 3", documentoReferencia: "extrato-set.pdf" }, deps);
  assert.equal(c.estado, "confirmado"); assert.equal(c.confirmacao.por, ctx.usuarioId); assert.equal(c.confirmacao.em, "2026-11-09T10:00:00Z"); assert.match(c.confirmacao.evidencia, /Extrato/); assert.equal(c.documentoReferencia, "extrato-set.pdf");
  await assert.rejects(() => editar(ctx, r.id, { descricao: "mudou" }, deps), /confirmada/);
  await assert.rejects(() => confirmar(ctx, r.id, { evidencia: "de novo, outro documento" }, deps), /já confirmada/);
  const h = await historico(ctx, r.id, deps); assert.equal(h.itens.length, 1); assert.ok(chamadas.some((x) => x[0] === "auditoria" && x[1] === "fin_pendencias_documentais" && x[2] === r.id));
  const x = await registrar(ctx, { ...base, descricao: "Para cancelar" }, deps);
  await assert.rejects(() => cancelar(ctx, x.id, { motivo: "ok" }, deps), /mínimo de 5/);
  await cancelar(ctx, x.id, { motivo: "cadastrada em duplicidade" }, deps);
  assert.equal((await listar(ctx, { mes: "2026-09" }, deps)).itens.some((i) => i.id === x.id), false, "cancelada sai da lista, sem apagar");
});

test("Central: pendência documental aparece com valor, motivo, evidência, responsável e status; confirmada sai das pendências e vai para as concluídas", async () => {
  const mem = memoria();
  const r = await registrar(ctx, base, mem.deps);
  const central = async () => listarCentral(ctx, { mes: "2026-09" }, { ...mem.deps, repo: { ...mem.deps.repo, ...centralBase() } });
  let c = await central();
  const p = c.pendencias.find((x) => x.id === `doc:${r.id}`);
  assert.ok(p); assert.equal(p.tipo, "pendencia_documental"); assert.equal(p.valorCentavos, 19053); assert.equal(p.status, "pendente"); assert.equal(p.responsavel, "Contadora"); assert.ok(p.evidenciaNecessaria && p.motivo);
  assert.equal(p.acao.caminho, `/pendencias-documentais/${r.id}/confirmar`); assert.equal(p.acao.permissao, "classificar");
  assert.equal(c.total, c.pendencias.length); assert.equal(c.concluidasDocumentais.length, 0);
  await confirmar(ctx, r.id, { evidencia: "Contagem física assinada, 30/09" }, mem.deps);
  c = await central();
  assert.equal(c.pendencias.some((x) => x.id === `doc:${r.id}`), false); assert.equal(c.concluidasDocumentais.length, 1); assert.equal(c.concluidasDocumentais[0].confirmacao.por, ctx.usuarioId);
});
