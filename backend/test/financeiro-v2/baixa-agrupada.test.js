// Baixa AGRUPADA (várias contas × uma saída do extrato) — modelo do caso real do Subway Saci (VR de 8 funcionários pago
// num único PIX de R$ 1.035,00 ao iFood Benefícios em 17/11). Dados SINTÉTICOS. Memória e, com FV2_REPOSITORIO=postgres, banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, TODAS, UNI_A2, ctx, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";

const VR = [12000, 10500, 12000, 10500, 18000, 18000, 12000, 10500]; // soma 103500
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${randomUUID()}\n%%EOF\n`);

async function cenario({ valorSaida = 103500 } = {}) {
  const m = await montarComCadastros();
  const n = m.nucleo;
  const contas = [];
  for (const [i, v] of VR.entries()) {
    contas.push((await n.registrarObrigacao(m.c, obrigacao(m.fornecedor.id, { valorOriginalCentavos: v, competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-05", descricao: `VALE REFEIÇÃO FUNCIONÁRIO ${i + 1} (sintético)` }))).obrigacoes[0]);
  }
  const mov = (await n.registrarMovimentacao(m.c, saida(m.banco.id, valorSaida, { dataEfetiva: "2026-10-05", descricao: "PIX iFood Benefícios (sintético)", fonte: { sistema: "UNICRED", idExterno: `EXT-${randomUUID().slice(0, 8)}` } }))).movimentacao;
  const g = await m.cofre.guardar(m.c, { conteudo: pdf(), tipoMime: "application/pdf" });
  const doc = (await n.registrarDocumento(m.c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-05", descricao: "Comprovante sintético" })).documento;
  return { ...m, n, contas, mov, doc, ids: contas.map((o) => o.id) };
}
const contar = async (n, c, tipo) => (await n.consultarRegistros(c, { tipo })).length;
const vincular = (s, extra = {}) => s.n.vincularPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: s.mov.versao, obrigacaoIds: s.ids, documentoId: s.doc.id, justificativa: "VR pago num único PIX (sintético).", confirmar: true, ...extra });

test("prévia: soma, saída com saldo igual marcada (não pré-selecionada), diferença zero e efeito sem nova despesa/saída", async () => {
  const s = await cenario();
  const sem = await s.n.previaDaBaixaAgrupada(s.c, { obrigacaoIds: s.ids });
  assert.equal(sem.somaCentavos, 103500);
  assert.equal(sem.escolhida, null);
  assert.equal(sem.saidasElegiveis.find((x) => x.id === s.mov.id).igualASoma, true);
  const p = await s.n.previaDaBaixaAgrupada(s.c, { obrigacaoIds: s.ids, movimentacaoId: s.mov.id });
  assert.deepEqual([p.escolhida.diferencaCentavos, p.escolhida.bloqueios.length, p.contas.length], [0, 0, 8]);
  // Soma maior que a saída: bloqueado, nunca ajustado.
  const menor = await cenario({ valorSaida: 100000 });
  const pm = await menor.n.previaDaBaixaAgrupada(menor.c, { obrigacaoIds: menor.ids, movimentacaoId: menor.mov.id });
  assert.ok(pm.escolhida.bloqueios.some((b) => /supera/.test(b)));
});

test("baixa agrupada: atômica, quita as 8 contas, não cria despesa nem saída, e é idempotente", async () => {
  const s = await cenario();
  const antes = { mov: await contar(s.n, s.c, "MOVIMENTACAO"), lanc: await contar(s.n, s.c, "LANCAMENTO") };
  const r = await vincular(s);
  assert.equal(r.liquidacoes.length, 8);
  assert.equal(r.movimentacao.alocadoCentavos, 103500);
  assert.equal(r.composicao.length, 8);
  for (const t of r.titulos) assert.equal(t.saldoCentavos, 0);
  assert.deepEqual({ mov: await contar(s.n, s.c, "MOVIMENTACAO"), lanc: await contar(s.n, s.c, "LANCAMENTO") }, antes);
  // Mesmo envio de novo: devolve o grupo, sem duplicar.
  const de_novo = await vincular(s);
  assert.equal(de_novo.repetido, true);
  assert.equal((await s.n.consultarPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id })).contas.length, 8);
  // Dupla baixa: OUTRA saída tentando quitar as mesmas contas é recusada (contas já quitadas).
  const outra = (await s.n.registrarMovimentacao(s.c, saida(s.banco.id, 103500, { dataEfetiva: "2026-10-06", fonte: { sistema: "UNICRED", idExterno: `EXT-${randomUUID().slice(0, 8)}` } }))).movimentacao;
  await rejeita(s.n.vincularPagamentoAgrupado(s.c, { movimentacaoId: outra.id, versaoMovimentacao: outra.versao, obrigacaoIds: s.ids.slice(0, 2), documentoId: s.doc.id, justificativa: "Tentativa de dupla baixa.", confirmar: true }), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  // A mesma saída não aceita conta nova além do saldo (já toda alocada).
  const extra = (await s.n.registrarObrigacao(s.c, obrigacao(s.fornecedor.id, { valorOriginalCentavos: 500, competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-05", descricao: "Outra conta" }))).obrigacoes[0];
  const mov = (await s.n.consultarPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id })).movimentacao;
  await assert.rejects(s.n.vincularPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: mov.versao, obrigacaoIds: [extra.id, s.ids[0]], documentoId: s.doc.id, justificativa: "Excede a saída.", confirmar: true }));
});

test("tudo ou nada: uma conta quitada na seleção recusa o grupo inteiro (nenhuma baixa parcial)", async () => {
  const s = await cenario();
  await s.n.cancelarObrigacao(s.c, { obrigacaoId: s.ids[7], justificativa: "Cancelada no teste." });
  await rejeita(vincular(s), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  const p = await s.n.consultarPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id });
  assert.deepEqual([p.contas.length, p.movimentacao.alocadoCentavos], [0, 0]);
});

test("isolamento por unidade e permissões", async () => {
  const s = await cenario();
  await rejeita(s.n.previaDaBaixaAgrupada(ctx(ORG_A, UNI_A2), { obrigacaoIds: s.ids, movimentacaoId: s.mov.id }), CODIGO.NAO_ENCONTRADO);
  const semVincular = ctx(undefined, undefined, TODAS.filter((a) => a !== ACAO.VINCULAR_PAGAMENTO));
  await assert.rejects(vincular({ ...s, c: semVincular }));
  await rejeita(s.n.vincularPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: s.mov.versao, obrigacaoIds: [s.ids[0]], justificativa: "Uma só.", confirmar: true }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(s.n.vincularPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: s.mov.versao, obrigacaoIds: [s.ids[0], s.ids[0]], justificativa: "Repetida.", confirmar: true }), CODIGO.ENTRADA_INVALIDA);
});

test("reversão controlada: estorna o grupo inteiro numa transação, contas voltam a abrir, saída volta a ter saldo, tudo auditado", async () => {
  const s = await cenario();
  await vincular(s);
  const { movimentacao } = await s.n.consultarPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id });
  await rejeita(s.n.reverterPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: movimentacao.versao, justificativa: "curta", confirmar: true }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(s.n.reverterPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: movimentacao.versao - 1, justificativa: "Vinculado à saída errada.", confirmar: true }), CODIGO.CONFLITO_VERSAO);
  const r = await s.n.reverterPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id, versaoMovimentacao: movimentacao.versao, justificativa: "Vinculado à saída errada.", confirmar: true });
  assert.equal(r.revertidas, 8);
  assert.equal(r.totalCentavos, 103500);
  assert.equal(r.movimentacao.alocadoCentavos, 0);
  for (const e of r.estornos) assert.ok(e.saldoCentavos > 0);
  assert.equal(await contar(s.n, s.c, "ESTORNO"), 8);
  assert.equal((await s.n.consultarPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id })).contas.length, 0);
  // Depois da reversão, a mesma seleção pode ser vinculada de novo (nova versão da saída).
  const nova = (await s.n.consultarPagamentoAgrupado(s.c, { movimentacaoId: s.mov.id })).movimentacao;
  const r2 = await vincular({ ...s, mov: { ...s.mov, versao: nova.versao } });
  assert.equal(r2.liquidacoes?.length ?? r2.composicao.length, 8);
});
