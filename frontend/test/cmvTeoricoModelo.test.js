// CMV teórico — modelo puro do painel. Rodar: node --test frontend/test/cmvTeoricoModelo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { periodoDoMes, situacaoIndicador, seloFichaProduto, cartoes, agruparProdutos, rotuloMotivoIndisponivel, rotuloMotivoVinculo, rotuloSinal, AVISO_ESTIMATIVA } from "../src/cmvTeoricoModelo.js";

test("período do mês: primeiro e último dia (inclusive fevereiro/bissexto)", () => {
  assert.deepEqual(periodoDoMes(11, 2026), { de: "2026-11-01", ate: "2026-11-30" });
  assert.deepEqual(periodoDoMes(2, 2028), { de: "2028-02-01", ate: "2028-02-29" });
  assert.deepEqual(periodoDoMes(12, 2026), { de: "2026-12-01", ate: "2026-12-31" });
});
test("situação: indisponível traz o motivo em português; parcial explica por quê; estimado NUNCA vira 'conciliado'", () => {
  const ind = situacaoIndicador({ indisponivel: true, motivos_indisponivel: ["sem_pedidos_no_periodo"] });
  assert.equal(ind.chave, "indisponivel"); assert.match(ind.detalhe, /pedidos concluídos/);
  assert.equal(situacaoIndicador(null).chave, "indisponivel");
  const par = situacaoIndicador({ indisponivel: false, parcial: true, cobertura: { pct_receita_vinculada: 32.4, produtos_ficha_incompleta: 2 } });
  assert.equal(par.chave, "parcial"); assert.match(par.detalhe, /32%/); assert.match(par.detalhe, /2 produto/);
  const ok = situacaoIndicador({ indisponivel: false, parcial: false, cobertura: { pct_receita_vinculada: 92 } });
  assert.equal(ok.texto, "Estimado"); assert.equal(ok.detalhe, AVISO_ESTIMATIVA); assert.doesNotMatch(ok.texto + ok.detalhe, /conciliado\.$/i.source === "x" ? /$^/ : /^Conciliado/);
});
test("selo da ficha do produto vendido", () => {
  assert.equal(seloFichaProduto({ custo_unitario: null }).texto, "Ficha incompleta");
  assert.equal(seloFichaProduto({ custo_unitario: 3, homologacao: "homologada" }).texto, "Homologada");
  assert.equal(seloFichaProduto({ custo_unitario: 3, homologacao: "pendente" }).texto, "Pendente de homologação");
  assert.equal(seloFichaProduto({ custo_unitario: 3, homologacao: "nao_aplicavel" }).texto, "Cadastro manual");
});
test("cartões: sem base mostram null (a tela escreve '—'), nunca 0", () => {
  const vazio = cartoes({ indisponivel: true });
  assert.equal(vazio.cmv, null); assert.equal(vazio.cmvHomologado, null); assert.equal(vazio.coberturaPct, null); assert.equal(vazio.semCorrespondencia, 0);
  const c = cartoes({ indisponivel: false, cmv_teorico_pct: 31.2, cmv_teorico_homologado_pct: 28.5, comissao_considerada: 0.23, sem_correspondencia: [{}, {}],
    cobertura: { pct_receita_vinculada: 80, pct_receita_com_custo_homologado: 40, produtos_vinculados: 12, produtos_ficha_incompleta: 3 } });
  assert.deepEqual(c, { cmv: 31.2, cmvHomologado: 28.5, coberturaPct: 80, homologadoPct: 40, produtosVinculados: 12, fichasIncompletas: 3, semCorrespondencia: 2, comissaoConsiderada: 0.23 });
});
test("agrupamento: com custo, incompletos, desfavoráveis e homologados", () => {
  const g = agruparProdutos({ produtos: [
    { custo_unitario: 2, custo_homologado: true, desfavoravel: false }, { custo_unitario: null }, { custo_unitario: 5, desfavoravel: true, custo_homologado: false },
  ] });
  assert.equal(g.comCusto.length, 2); assert.equal(g.incompletos.length, 1); assert.equal(g.desfavoraveis.length, 1); assert.equal(g.homologados.length, 1);
});
test("rótulos de motivo/sinal conhecidos e fallback para o código", () => {
  assert.match(rotuloMotivoIndisponivel("pedidos_sem_detalhe_de_itens"), /detalhe dos itens/);
  assert.equal(rotuloMotivoIndisponivel("novo_motivo"), "novo_motivo");
  assert.match(rotuloMotivoVinculo("nome_ambiguo"), /mais de um/i);
  assert.equal(rotuloMotivoVinculo(undefined), "Sem correspondência");
  assert.equal(rotuloSinal("cmv_acima_do_limite"), "CMV acima do limite");
});
