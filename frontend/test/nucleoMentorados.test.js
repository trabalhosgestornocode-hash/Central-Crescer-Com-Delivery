// Núcleo Mentorados — construtores puros (listagem, perfil, slides, gráficos). Sem DOM.
// Rodar: node --test frontend/test/nucleoMentorados.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as V from "../src/nucleoMentoradosViews.js";
import * as C from "../../backend/src/modules/nucleo-mentorados/calc.js";
import { serieReferencia } from "../../backend/test/nucleo-mentorados/fixtures.js";

const participante = { data_entrada: "2025-10-01", data_renovacao: "2026-12-20", mentor_nome: "Ana", cidade: "Cidade Exemplo", uf: "BA", fonte_preferencial: "importacao" };
const serie = serieReferencia().map((m) => ({ ...m, fonte: "importacao" }));
const metas = { maximos: { taxasComissoes: 13, servicosPromocoes: 5, taxasMaisServicos: 18 }, referencia: { ticketMedio: { minimo: 45, ideal: 50 } } };
const analise = C.analisar({ participante, serie, metas: metas.maximos, hojeIso: "2026-11-26" });
const perfil = {
  empresa: { id: "org-a", nome: "Loja Exemplo - Cidade - UF" }, participante, hojeIso: "2026-11-26",
  serie, divergencias: [{ mes: "2026-05", campo: "valorVendas", rotulo: "Vendas no iFood", tipo: "reais", usado: { fonte: "importacao", valor: 11518740 }, descartado: { fonte: "dashboard_ifood", valor: 11316771 }, diferenca: 201969 }],
  metas, analise, importacoes: [], registros: [
    { id: "r1", tipo: "estrategia", data_registro: "2025-11-10", titulo: "Revisão do cardápio <b>", descricao: "Reordenou combos", privado: false, indicadores: [] },
    { id: "r2", tipo: "observacao", data_registro: "2025-12-01", titulo: "Nota interna", privado: true, indicadores: [] },
  ], apresentacoes: [], fontes: { importacao: 24, dashboard: 0, preferencial: "importacao" },
};
const snapshot = {
  geradoEm: "2026-11-26T12:00:00Z", empresa: perfil.empresa,
  participante: { dataEntrada: participante.data_entrada, mentor: "Ana", cidade: "Cidade Exemplo", uf: "BA" },
  serie, divergencias: perfil.divergencias, metas, analise,
  registros: perfil.registros.map((r) => ({ id: r.id, tipo: r.tipo, data: r.data_registro, titulo: r.titulo, descricao: r.descricao, privado: r.privado })),
  fontes: { importacoes: [{ arquivo: "Histórico.xlsx", sha256: "a".repeat(64), inicio: "2024-10-01", fim: "2026-09-01" }], dashboardIfood: { meses: 0 }, preferencial: "importacao" },
};

describe("formatação", () => {
  test("% × p.p. e ausência", () => {
    assert.equal(V.pctSinal(50.7303), "+50,73%");
    assert.equal(V.pp(-6.1824), "−6,18 p.p.");
    assert.equal(V.reais(90549368).replace(/ /g, " "), "R$ 905.493,68");
    assert.equal(V.reais(null), null);
    assert.equal(V.tempoMentoria(14), "1 ano e 2 meses");
    assert.equal(V.mesCurto("2025-10"), "out/25");
  });
});

describe("listagem", () => {
  const lista = { hojeIso: "2026-11-26", mentorados: [
    { organizacaoId: "a", empresa: "Loja Exemplo", responsavel: "João", mentor: "Ana", cidade: "Cidade Exemplo", uf: "BA", status: "ativa", dataEntrada: "2025-10-01", dataRenovacao: "2026-12-20", mesesDeMentoria: 12, variacaoVendas: { comparavel: true, percentual: 50 }, custosIfood: { comparavel: true, pontosPercentuais: -6.5 }, disponibilidade: "completa", divergencias: 2, alertas: [] },
    { organizacaoId: "b", empresa: "Empresa B", mentor: "Beto", status: "pausada", dataEntrada: "2026-07-01", dataRenovacao: null, mesesDeMentoria: 4, variacaoVendas: { comparavel: false, motivo: "Dados incompletos" }, custosIfood: null, disponibilidade: "parcial", divergencias: 0, alertas: [] },
  ] };
  test("busca sem acento por cidade e filtros", () => {
    assert.deepEqual(V.filtrar(lista.mentorados, { ...V.filtrosPadrao(), termo: "exemplo" }).map((m) => m.organizacaoId), ["a"]);
    assert.deepEqual(V.filtrar(lista.mentorados, { ...V.filtrosPadrao(), renovacao: "90" }, "2026-11-26").map((m) => m.organizacaoId), ["a"]);
    assert.deepEqual(V.filtrar(lista.mentorados, { ...V.filtrosPadrao(), renovacao: "sem" }).map((m) => m.organizacaoId), ["b"]);
    assert.deepEqual(V.filtrar(lista.mentorados, { ...V.filtrosPadrao(), mentor: "Beto", status: "pausada" }).map((m) => m.organizacaoId), ["b"]);
  });
  test("variação não comparável não vira número", () => {
    const h = V.htmlLista(lista);
    assert.match(h, /\+50,00%/);
    assert.match(h, /não comparável/);
    assert.match(h, /−6,50 p\.p\./);
    assert.match(h, /data-nm-apresentar="a"/);
  });
  test("estado vazio explica que nenhuma empresa entra sozinha", () => {
    assert.match(V.htmlLista({ mentorados: [] }), /nenhuma empresa da plataforma entra automaticamente/);
  });
});

describe("perfil", () => {
  test("visão geral com crescimento, p.p. e gráfico acessível", () => {
    const h = V.htmlPerfil(perfil, "visao").replace(/ /g, " ");
    assert.match(h, /\+50,00%/);
    assert.match(h, /25,00% → 18,50%/);
    assert.match(h, /role="tablist"/);
    assert.match(h, /aria-label="outubro de 2024: R\$ 60\.000,00 \(antes da mentoria\)"/);
  });
  test("histórico mostra 'não informado' em vez de zero e sinaliza divergência", () => {
    const h = V.htmlPerfil(perfil, "historico");
    assert.match(h, /não informado/);
    assert.doesNotMatch(h, /R\$ 0,00/);
    assert.match(h, /data-nm-divergencia="2026-05"/);
  });
  test("comparativo: pedidos não comparáveis, nota de causalidade", () => {
    const h = V.htmlPerfil(perfil, "comparativo");
    assert.match(h, /não comparável/);
    assert.match(h, /não prova que a mentoria causou/);
  });
  test("conteúdo do usuário é escapado", () => {
    assert.match(V.htmlPerfil(perfil, "evolucao"), /Revisão do cardápio &lt;b&gt;/);
  });
});

describe("slides", () => {
  test("10 slides com tudo disponível; registros privados nunca aparecem", () => {
    const s = V.slides(snapshot, { ocultarIndisponiveis: false });
    assert.equal(s.length, 10);
    assert.ok(!s.some((x) => /Nota interna/.test(x.html)));
    assert.match(s.find((x) => x.id === "vendas").html, /\+50,00%/);
    assert.match(s.find((x) => x.id === "eficiencia").html, /−6,50 p\.p\./);
  });
  test("ocultar indisponíveis remove só o que não tem dado; ocultos pelo mentor somem", () => {
    const s = V.slides(snapshot, { ocultarIndisponiveis: true, slidesOcultos: ["metas"] });
    const ids = s.map((x) => x.id);
    assert.ok(!ids.includes("metas"));
    assert.ok(!ids.includes("plano"), "plano sem texto nem metas fica oculto");
    assert.ok(ids.includes("clientes"), "há 3 meses de desempenho: o slide aparece, marcado como incompleto");
    assert.match(s.find((x) => x.id === "clientes").html, /sem comparação/);
  });
  test("notas privadas ficam no objeto do slide, não no HTML", () => {
    const s = V.slides(snapshot, { notas: { capa: "Abrir com o crescimento" } });
    assert.equal(s[0].notas, "Abrir com o crescimento");
    assert.doesNotMatch(s[0].html, /Abrir com o crescimento/);
  });
  test("oportunidades são fatos medidos, nunca causas", () => {
    const h = V.slides(snapshot, {}).find((x) => x.id === "oportunidades").html;
    assert.match(h, /Serviços e promoções acima de 5%/);
    assert.match(h, /set\/26 \(6,00%\)/);
  });
});

describe("gráficos", () => {
  test("mês sem dado é marcação tracejada, não barra zero", () => {
    const h = V.graficoBarras({ titulo: "t", pontos: [{ mes: "2026-01", valor: 100000, grupo: "mentoria" }, { mes: "2026-02", valor: null, grupo: "mentoria" }] });
    assert.match(h, /nm-g-vazio/);
    assert.match(h, /fevereiro de 2026: não informado/);
  });
  test("linha de % não interpola por cima de mês vazio", () => {
    const h = V.graficoLinhaPct({ titulo: "t", meta: 18, pontos: [{ mes: "2026-01", valor: 20 }, { mes: "2026-02", valor: null }, { mes: "2026-03", valor: 15 }] });
    const d = /class="nm-g-linha"/.test(h) && h.match(/<path d="([^"]+)" class="nm-g-linha"/)[1];
    assert.equal((d.match(/M/g) ?? []).length, 2, "dois trechos separados");
    assert.match(h, /meta: até 18%/);
  });
});

describe("pendências, escolhas de fonte e mudança operacional", () => {
  test("lista mostra entrada pendente e filtra cadastro pendente", () => {
    const d = { hojeIso: "2026-11-26", mentorados: [
      { organizacaoId: "p", empresa: "Pendente", status: "ativa", dataEntrada: null, pendencias: ["data de entrada", "mentor"], alertas: [], disponibilidade: "sem_dados" },
      { organizacaoId: "q", empresa: "Completa", status: "ativa", dataEntrada: "2025-01-01", dataRenovacao: "2027-01-01", pendencias: [], alertas: [], disponibilidade: "completa" },
    ] };
    const h = V.htmlLista(d);
    assert.match(h, /Entrada pendente/);
    assert.match(h, /pendente: data de entrada, mentor/);
    assert.deepEqual(V.filtrar(d.mentorados, { ...V.filtrosPadrao(), dados: "pendente" }).map((m) => m.organizacaoId), ["p"]);
    assert.match(h, /data-nm-vincular/);
  });
  test("marco da mudança aparece no gráfico e no rótulo acessível", () => {
    const marcos = V.marcosDe([{ mes: "2026-08", para: "full_service", texto: "Marketplace → Full Service em ago/26" }]);
    const h = V.graficoBarras({ titulo: "Vendas", pontos: [{ mes: "2026-07", valor: 1, grupo: "mentoria" }, { mes: "2026-08", valor: 1, grupo: "mentoria" }], marcos });
    assert.match(h, /nm-g-marco/);
    assert.match(h, /Full Service desde ago\/26/);
    assert.match(h, /aria-label="Vendas\. Marketplace → Full Service em ago\/26"/);
  });
  test("escolhas listadas com justificativa; revogada aparece riscada e sem botão", () => {
    const h = V.htmlEscolhas([
      { id: "a", mes_inicio: "2026-05-01", mes_fim: "2026-09-01", grupo: "financeiro", fonte: "importacao", justificativa: "Números homologados", created_at: "2026-11-26", criado_por_nome: "Mentor" },
      { id: "b", mes_inicio: "2026-05-01", mes_fim: "2026-05-01", grupo: "financeiro", fonte: "dashboard_ifood", justificativa: "Teste antigo", created_at: "2026-11-20", revogada_em: "2026-11-21", motivo_revogacao: "Substituída pela homologação" },
    ]);
    assert.match(h, /“Números homologados”/);
    assert.match(h, /data-nm-revogar-fonte="a"/);
    assert.doesNotMatch(h, /data-nm-revogar-fonte="b"/);
    assert.match(h, /nm-revogada/);
  });
  test("slide de eficiência explica a mudança e não trata ausência como economia", () => {
    const snap2 = structuredClone(snapshot);
    snap2.analise.mudancas = [{ mes: "2026-08", de: "marketplace", para: "full_service", texto: "Marketplace → Full Service em ago/26" }];
    const h = V.slides(snap2, {}).find((x) => x.id === "eficiencia").html;
    assert.match(h, /não é economia/);
    assert.match(h, /nm-g-marco/);
  });
});
