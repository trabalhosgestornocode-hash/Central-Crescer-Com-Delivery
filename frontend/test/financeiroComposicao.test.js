// Rodar: node --test frontend/test/financeiroComposicao.test.js
// Composição dos números (ícone i, popover, painel, árvore do DRE), glossário, menu com DRE único e escape de HTML. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLICACOES, SITUACOES, explicacaoDe, chaveCategoria, CATEGORIAS_DESCRICAO } from "../src/financeiro/explicacoes.js";
import { htmlArvore, htmlPopover, htmlPainel, htmlConciliacao, htmlConferenciaCanais, htmlPonte, htmlVisoes, botaoInfo, selo, esc } from "../src/financeiro/detalheHtml.js";
import { MENU_FINANCEIRO, MODULOS_FINANCEIRO, ROTULOS_AGRUPADOS } from "../src/financeiroMenu.js";

const nb = (s) => s.replace(/ /g, " ");
const folha = (id, rotulo, centavos, extra = {}) => ({ id, rotulo, centavos, pctBrutoBps: Math.round(centavos * 10000 / 8000000), situacao: "confirmado", filhos: null, lancamentos: null, ...extra });
const ARV = [{ ...folha("custos", "(−) Custos", 600000, { tipo: "grupo", explicacaoId: "custos", filhos: [
  folha("cmv", "CMV", 500000, { filhos: [folha("cat:INSUMOS - FRUTAS", "INSUMOS - FRUTAS", 1000000, { lancamentos: [{ tipo: "obrigacao", id: "o1", criterio: "competencia", centavos: 1000000, descricao: "frutas <b>x</b>", fornecedor: "Forn", competencia: "2026-09", data: "2026-09-10" }] })] }),
  folha("entregas", "Entregas", 100000, { explicacaoId: "entregas", filhos: [folha("cat:FRETE", "Entregadores Próprios (Motoboys)", 100000, { nomeOriginal: "FRETE", explicacaoId: "entregadores_proprios", lancamentos: [{ tipo: "pagamento", id: "p1", criterio: "caixa", centavos: 100000, descricao: "Entregas semana", data: "2026-09-16" }] })] })] }) }];

test("glossário: todo indicador da Visão Geral tem explicação em linguagem simples, fórmula e nada vazio", () => {
  for (const id of ["faturamentoBruto", "faturamentoLiquido", "recebimentos", "deducoes", "cmv", "custos", "despesas", "margemContribuicao", "resultadoGerencial", "margemLiquida", "saldoDisponivel", "contasAPagar", "contasAReceber", "jurosEncargos", "jurosPresumidos", "dividas", "pontoEquilibrio", "conciliacao", "entregadores_proprios", "dreGerencial"]) {
    const e = explicacaoDe(id);
    assert.ok(e, id); assert.ok(e.nome && e.simples.length > 20 && e.formula, `${id} completo`);
  }
  assert.match(EXPLICACOES.faturamentoBruto.cuidado, /Recebimentos/, "faturamento ≠ recebimento");
  assert.match(EXPLICACOES.jurosPresumidos.simples, /ainda não classificada/);
  assert.match(EXPLICACOES.entregadores_proprios.simples, /fretes de fornecedores, taxas de entrega do iFood/);
  assert.deepEqual(Object.keys(SITUACOES), ["confirmado", "pendente_contadora", "parcial", "sem_dados", "divergente"]);
});

test("ícone (i) é botão acessível (nome, aria-expanded, foco por teclado) e escapa HTML", () => {
  const h = botaoInfo("cmv", 'CMV "x" <script>');
  assert.match(h, /^<button type="button"/); assert.match(h, /aria-expanded="false"/); assert.match(h, /aria-label="Entender: CMV &quot;x&quot; &lt;script&gt;"/);
  assert.ok(!h.includes("<script>"));
});

test("árvore: expande por botão com aria-expanded, mostra valor, % do bruto e a categoria renomeada com o nome original", () => {
  const h = htmlArvore(ARV);
  assert.match(h, /role="tree"/); assert.match(h, /data-fin-toggle/); assert.match(h, /aria-expanded="false"/);
  assert.match(nb(h), /R\$ 6\.000,00/); assert.match(h, /7,50%/);   // 600.000 / 8.000.000
  assert.match(h, /Entregadores Próprios \(Motoboys\)/); assert.match(h, /categoria no plano: FRETE/);
  assert.ok(!/>FRETE</.test(h), "o nome antigo não aparece como rótulo");
  assert.match(h, /frutas &lt;b&gt;x&lt;\/b&gt;/, "texto do servidor é escapado");
  assert.match(h, /hidden/, "níveis internos começam recolhidos");
});

test("árvore: divergência entre total e partes é exposta, nunca escondida", () => {
  const n = [{ ...folha("g", "Grupo", 1000), filhos: [folha("a", "A", 600)], conferencia: { confere: false, somaCentavos: 600, diferencaCentavos: 400 }, situacao: "divergente" }];
  const h = nb(htmlArvore(n));
  assert.match(h, /difere do total/); assert.match(h, /Divergente/);
});

test("popover: nome, explicação, fórmula, componentes com valor e %, situação e origem", () => {
  const comp = { id: "faturamentoBruto", valorCentavos: 1000000, unidade: "moeda", situacao: "confirmado", formula: "soma das vendas diárias", origem: "Vendas diárias importadas", componentes: [folha("c", "Vendas registradas (Saci) — sem canal informado", 1000000)], faltam: ["Canal de venda não informado nas vendas diárias."] };
  const h = nb(htmlPopover("faturamentoBruto", comp));
  assert.match(h, /Faturamento bruto/); assert.match(h, /R\$ 10\.000,00/); assert.match(h, /Fórmula/); assert.match(h, /sem canal informado/);
  assert.match(h, /O que falta/); assert.match(h, /Origem/); assert.match(h, /Confirmado/); assert.match(h, /data-fin-abrir-painel="faturamentoBruto"/);
});

test("painel lateral traz as seções exigidas, competência e conferência; sem dado não vira zero", () => {
  const comp = { id: "custos", valorCentavos: 600000, unidade: "moeda", situacao: "pendente_contadora", formula: "CMV + entregas", origem: "Contas a Pagar", componentes: ARV[0].filhos, conferencia: { confere: true, somaCentavos: 600000 }, faltam: [], notas: [] };
  const h = nb(htmlPainel(comp, { mes: "2026-09" }));
  for (const t of ["1. Resumo", "2. Fórmula", "3. Componentes", "4. Competência", "5. Origem dos dados", "6. Situação de conferência"]) assert.match(h, new RegExp(t));
  assert.match(h, /setembro\/2026/); assert.match(h, /Conferido/); assert.match(h, /Pendente da contadora/);
  const vazio = nb(htmlPainel({ id: "dividas", valorCentavos: null, unidade: "moeda", situacao: "sem_dados", componentes: [], faltam: ["Cadastro de dívidas indisponível."], notas: [], conferencia: null }, { mes: "2026-09" }));
  assert.ok(!/R\$ 0,00/.test(vazio), "ausência não é R$ 0,00"); assert.match(vazio, /Sem dados/); assert.match(vazio, /Cadastro de dívidas indisponível/);
});

test("conciliação: mostra partida, degraus, chegada e se a ponte fecha", () => {
  const c = { categoria: "Entregadores Próprios (Motoboys)", nomeOriginal: "FRETE", explicacao: EXPLICACOES.entregadores_proprios.simples, distincoes: ["a", "b", "c"], partidaRotulo: "Livro-caixa (regime de caixa)", partidaCentavos: 962500, lancamentosLivroCaixa: 56, pagamentosContasAPagarCentavos: 956000, gerencialCentavos: 100000,
    degraus: [{ id: "outra_competencia", rotulo: "Pagos no mês, mas de competência de outro mês", centavos: -250000, itens: [{ descricao: "Entregas ago", competencia: "2026-08", centavos: -250000 }] }], chegadaCentavos: 100000, confere: true, diferencaCentavos: 0 };
  const h = nb(htmlConciliacao(c));
  assert.match(h, /R\$ 9\.625,00/); assert.match(h, /R\$ 1\.000,00/); assert.match(h, /A ponte fecha/); assert.match(h, /competência de outro mês/);
  assert.match(nb(htmlConciliacao({ ...c, confere: false, diferencaCentavos: 100 })), /Sobrou diferença não explicada/);
  assert.equal(htmlConciliacao(null), "");
});

test("menu: UM DRE na navegação principal (DRE Gerencial); o DRE de caixa fica em área avançada", () => {
  const principais = MODULOS_FINANCEIRO.filter((m) => m.id !== "controle").flatMap((m) => m.itens);
  assert.ok(principais.includes("fin-dre-referencia")); assert.ok(!principais.includes("fin-dre"), "DRE de caixa fora dos módulos principais");
  assert.ok(MODULOS_FINANCEIRO.find((m) => m.id === "controle").itens.includes("fin-dre"), "continua acessível, não foi apagado");
  assert.equal(MENU_FINANCEIRO.find((m) => m.id === "fin-dre-referencia").label, "DRE Gerencial");
  assert.match(ROTULOS_AGRUPADOS["fin-dre"], /avançado/);
  assert.equal(MODULOS_FINANCEIRO.length, 6, "seis módulos mantidos");
  assert.equal(MENU_FINANCEIRO.length, 22, "nenhuma tela removida");
});

test("selo e escape", () => { assert.match(selo("divergente"), /fin-badge--bad/); assert.equal(esc("<&>"), "&lt;&amp;&gt;"); });

test("canal de venda: nome amigável na linha, origem técnica só na área expandida, e botão de conciliação dentro da categoria", () => {
  const canal = folha("canal:iFood", "iFood", 400000, { origemTecnica: ["integration-ifood"], explicacao: "Pedidos que chegam pela integração do iFood.", lancamentos: [] });
  const h = htmlArvore([folha("bruto", "Faturamento bruto", 1000000, { filhos: [canal] })]);
  assert.match(h, /<span>iFood<\/span>/); assert.match(h, /<code>integration-ifood<\/code>/); assert.match(h, /pedidos individuais não estão disponíveis/);
  assert.ok(h.indexOf("integration-ifood") > h.indexOf("hidden"), "origem técnica fica no nível recolhido (área secundária)");
  const cat = htmlArvore([folha("cat:FRETE", "Entregadores Próprios (Motoboys)", 100000, { acao: "conciliacao", lancamentos: [] })]);
  assert.match(cat, /data-fin-conciliacao/); assert.match(cat, /Entender a diferença com o livro-caixa/);
  assert.ok(!/data-fin-conciliacao/.test(htmlArvore([folha("x", "Outra", 1, { lancamentos: [{ tipo: "obrigacao", centavos: 1 }] })])));
});

test("divergência entre a soma dos canais e o bruto oficial fica explícita (valor exato) no painel", () => {
  const cc = { somaCentavos: 1100000, brutoOficialCentavos: 1000000, diferencaCentavos: 100000, confere: false };
  const h = nb(htmlConferenciaCanais(cc));
  assert.match(h, /R\$ 11\.000,00/); assert.match(h, /R\$ 10\.000,00/); assert.match(h, /\+R\$ 1\.000,00/); assert.match(h, /dre-canais-conf--div/);
  assert.match(nb(htmlConferenciaCanais({ ...cc, diferencaCentavos: 0, confere: true })), /R\$ 0,00/);
  assert.equal(htmlConferenciaCanais(null), "");
  const comp = { id: "faturamentoBruto", valorCentavos: 1000000, unidade: "moeda", situacao: "divergente", formula: "f", origem: "o", componentes: [], canalConferencia: cc, alertas: ["Divergência: os canais somam R$ 11.000,00, R$ 1.000,00 a MAIS que o faturamento bruto oficial."], faltam: [], notas: [] };
  const p = nb(htmlPainel(comp, { mes: "2026-09" }));
  assert.match(p, /role="alert"/); assert.match(p, /a MAIS que o faturamento bruto oficial/); assert.match(p, /Divergente/);
});

test("ponte painel → base da DRE: total do painel, cada ajuste com estado (Estimado × Confirmado) e a base gerencial", () => {
  const ponte = [{ id: "painel", tipo: "painel", rotulo: "Total do painel por canal (SAIPOS)", centavos: 1100000 },
    { id: "a1", tipo: "ajuste", canal: "iFood", rotulo: "Taxa de entrega e descontos do iFood (estimado)", centavos: -50000, estado: "estimado" },
    { id: "a2", tipo: "ajuste", canal: "Anota Aí", rotulo: "Taxas de entrega do Anota Aí", centavos: -30000, estado: "confirmado" },
    { id: "a3", tipo: "ajuste", canal: "Anota Aí", rotulo: "Descontos do Anota Aí", centavos: -20000, estado: "confirmado" },
    { id: "gerencial", tipo: "gerencial", rotulo: "Faturamento base da DRE gerencial", centavos: 1000000 }];
  const h = nb(htmlPonte(ponte));
  assert.match(h, /R\$ 11\.000,00/); assert.match(h, /−R\$ 500,00/); assert.match(h, /−R\$ 300,00/); assert.match(h, /−R\$ 200,00/); assert.match(h, /R\$ 10\.000,00/);
  assert.equal((h.match(/Estimado/g) || []).length, 1, "só o ajuste do iFood está estimado"); assert.equal((h.match(/Confirmado/g) || []).length, 2);
  assert.equal(htmlPonte([]), "");
  assert.match(htmlVisoes({ a: { rotulo: "Juros pagos no mês", totalCentavos: 2241, componentes: [] } }), /Juros pagos no mês — R\$/);
});

test("painel mostra a ponte e as 'outras leituras' (painel × base da DRE) quando o indicador as traz", () => {
  const comp = { id: "faturamentoBruto", rotulo: "Faturamento base da DRE", valorCentavos: 1000000, unidade: "moeda", situacao: "confirmado", formula: "f", origem: "o", componentes: [], faltam: [], notas: [], conferencia: null,
    visoes: { gerencial: { rotulo: "Base da DRE gerencial", totalCentavos: 1000000, componentes: [] }, painel: { rotulo: "Total do painel (SAIPOS)", totalCentavos: 1100000, componentes: [] },
      ponte: [{ id: "painel", tipo: "painel", rotulo: "Total do painel", centavos: 1100000 }, { id: "gerencial", tipo: "gerencial", rotulo: "Base", centavos: 1000000 }] },
    pendencias: ["Ajuste de R$ 500,00 (iFood) está estimado e aguarda confirmação."] };
  const h = nb(htmlPainel(comp, { mes: "2026-09" }));
  assert.match(h, /Ponte: painel \(SAIPOS\) → base da DRE/); assert.match(h, /Outras leituras/); assert.match(h, /Total do painel \(SAIPOS\) — R\$ 11\.000,00/); assert.match(h, /aguarda confirmação/);
  assert.match(h, /<h3|1\. Resumo/);
});

test("selo aceita rótulo próprio (ajuste 'Estimado' não é 'Pendente da contadora')", () => {
  assert.match(selo("pendente_contadora", "Estimado"), />Estimado</); assert.match(selo("pendente_contadora"), /Pendente da contadora/);
  const n = [{ ...folha("aj", "Ajuste", -50000, { situacao: "pendente_contadora", rotuloSituacao: "Estimado", detalhe: "estimado, a confirmar" }) }];
  const h = htmlArvore(n); assert.match(h, />Estimado</); assert.ok(!/Pendente da contadora/.test(h)); assert.match(h, /estimado, a confirmar/);
});

test("descrição simples por categoria: o (i) aparece só quando há texto escrito, e usa o nome gravado quando a categoria foi renomeada", () => {
  assert.equal(chaveCategoria("INSUMOS - DISTRIBUIDORA"), "cat:insumos - distribuidora");
  assert.equal(chaveCategoria("DESCARTÁVEIS"), "cat:descartaveis", "ignora acento e maiúsculas");
  assert.equal(chaveCategoria("CATEGORIA SEM TEXTO"), null, "sem texto escrito: não inventa descrição");
  assert.match(explicacaoDe("cat:insumos - distribuidora").simples, /fornecedor principal de açaí/);
  assert.equal(explicacaoDe("cat:nao existe"), null);
  assert.ok(Object.keys(CATEGORIAS_DESCRICAO).length >= 20);
  const h = htmlArvore([folha("cat:INSUMOS - DISTRIBUIDORA", "INSUMOS - DISTRIBUIDORA", 400000)]);
  assert.match(h, /data-fin-glossario="cat:insumos - distribuidora"/);
  assert.ok(!/data-fin-glossario/.test(htmlArvore([folha("cat:X", "CATEGORIA SEM TEXTO", 1)])));
  const renomeada = htmlArvore([folha("cat:FRETE", "Entregadores Próprios (Motoboys)", 100000, { nomeOriginal: "FRETE", explicacaoId: "entregadores_proprios" })]);
  assert.match(renomeada, /data-fin-glossario="entregadores_proprios"/);
});

test("glossário: faturamento bruto gerencial, ajuste de vendas e entregadores; não existe mais um segundo total de vendas concorrente", () => {
  assert.equal(EXPLICACOES.totalVendasCanais, undefined); assert.equal(EXPLICACOES.baseDre, undefined); assert.match(EXPLICACOES.faturamentoBruto.formula, /painel \(SAIPOS\) \+ ajustes; coincide com as vendas diárias do mês/);
  assert.match(EXPLICACOES.ajusteVendas.simples, /Não é taxa financeira nem dedução/); assert.match(EXPLICACOES.entregadores.simples, /frete de fornecedor/);
});
