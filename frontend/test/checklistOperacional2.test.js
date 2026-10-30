// Checklist Operacional 2.0 — frontend: metas do servidor, fundo dinâmico, terceira opção, Dashboard, PDF.
//
// O payload do Dashboard é gerado pelos MÓDULOS PUROS DO BACKEND (indicadores + análises), o mesmo cálculo da API:
// a tela é testada contra o formato real, não contra uma cópia à mão.
//
// Rodar: node --test frontend/test/checklistOperacional2.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { METAS_EXEMPLO } from "../src/checklistOperacionalModelo.js";
import { adaptarResumo, metasDoResumo } from "../src/checklistOperacionalDados.js";
import { proximoFundo, RETENCAO_MELHORA_MS, ROTULO_FUNDO } from "../src/checklistOperacionalFundo.js";
import { montarTela, telaSelecaoModos, dialogoMetas, iconeStatusOperacao } from "../src/checklistOperacionalVisual.js";
import { telaDashboard, variacao, textoPeriodo, dialogoRelatorio, SECOES_RELATORIO } from "../src/checklistOperacionalDashboardVisual.js";
import { graficoEvolucao, graficosDoDashboard, escala } from "../src/checklistOperacionalGraficos.js";
import { htmlRelatorio, documentoRelatorio, resumoExecutivo } from "../src/checklistOperacionalRelatorio.js";
import { validarFiltro, paraConsulta } from "../src/checklistOperacionalDashboard.js";
import { UNIDADE, respostaResumo } from "./checklistOperacionalFixture.js";

import * as ind from "../../backend/src/modules/checklist-operacional/checklistOperacional.indicadores.js";
import * as per from "../../backend/src/modules/checklist-operacional/checklistOperacional.periodos.js";
import { linhaDoTempoDasMetas } from "../../backend/src/modules/checklist-operacional/checklistOperacional.metas.js";
import { gerarAnalises } from "../../backend/src/modules/checklist-operacional/checklistOperacional.analises.js";
// As seções do Excel são lidas como TEXTO: importar o módulo puxaria o pacote `xlsx` do backend, e a suíte do
// frontend não depende de nada instalado no backend (os demais módulos importados acima não têm dependência).
const SECOES_BACKEND = [...readFileSync(fileURLToPath(new URL("../../backend/src/modules/checklist-operacional/checklistOperacional.exportar.js", import.meta.url)), "utf8")
  .matchAll(/\{ id: "(\w+)", rotulo: "/g)].map((m) => ({ id: m[1] }));

const AGORA = Date.parse("2026-10-21T18:00:00.000Z");
const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n?/g, "\n");
const contar = (html, re) => (html.match(re) ?? []).length;
const sp = (dia, hh, mm = 0) => new Date(Date.parse(`${dia}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-03:00`)).toISOString();
const mais = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();

let n = 0;
function pedido(recebido, preparo = 9) {
  n += 1;
  const cfm = mais(recebido, 1);
  const rtp = mais(cfm, preparo);
  const dsp = mais(rtp, 2);
  const con = mais(dsp, 20);
  return {
    order_id: `o-${n}`, display_id: String(5000 + n), status_oficial: "CONCLUDED", status_oficial_em: con, order_type: "DELIVERY", delivery_by: "IFOOD",
    order_timing: "IMMEDIATE", is_test: false, order_created_at: recebido, placed_event_created_at: recebido, confirmed_event_at: cfm,
    ready_event_at: rtp, dispatch_event_at: dsp, primeiro_evento_em: recebido, criado_em: recebido,
  };
}

/** Payload como a API devolve (paraResposta + análises + servidorEm). */
function payload({ inicio = "2026-10-12", fim = "2026-10-18", etapa = "todas", pedidos = null } = {}) {
  const lista = pedidos ?? [];
  if (!pedidos) {
    for (const dia of ["2026-10-12", "2026-10-13", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]) { // 14/10 sem pedido
      for (let h = 11; h <= 21; h += 1) for (let k = 0; k < 2; k += 1) lista.push(pedido(sp(dia, h, k * 20), h === 20 && dia !== "2026-10-12" ? 25 : 9));
    }
  }
  const periodo = per.resolverPeriodo({ periodo: "personalizado", inicio, fim, agoraMs: AGORA });
  const lt = linhaDoTempoDasMetas([{ versao: 1, alterado_em: sp("2026-09-01", 0), novo: { preparo: { meta: 12, avisoPct: 80 }, entrega: { meta: 30, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } } }]);
  const d = ind.montarDashboard({ pedidos: lista, periodo, linhaDoTempo: lt, etapa, primeiroPedidoEm: sp("2026-09-01", 9) });
  return { versao: 1, servidorEm: new Date(AGORA).toISOString(), ...ind.paraResposta(d), analises: gerarAnalises(d) };
}

// =====================================================================
describe("metas vindas do servidor (fonte única)", () => {
  const METAS_UN = { preparo: { meta: 8, avisoPct: 75 }, entrega: { meta: 30, avisoPct: 80 }, vida: { meta: 40, avisoPct: 80 } };

  test("o resumo traz as metas da unidade: a tela passa a classificar por elas (não pelo exemplo local)", () => {
    const r = adaptarResumo({ ...respostaResumo(AGORA), metas: { origem: "unidade", versao: 3, valores: METAS_UN, atualizadoEm: "2026-10-21T12:00:00Z", atualizadoPor: "Gestora" } },
      { unidade: UNIDADE, metas: METAS_EXEMPLO, recebidoEmMs: AGORA });
    assert.deepEqual(r.metas, METAS_UN);
    assert.deepEqual([r.metasInfo.origem, r.metasInfo.versao, r.metasInfo.atualizadoPor], ["unidade", 3, "Gestora"]);
  });

  test("metas ausentes ou malformadas: mantém a ÚLTIMA configuração válida da tela", () => {
    const reserva = METAS_UN;
    assert.deepEqual(metasDoResumo({}, reserva).valores, reserva);
    assert.equal(metasDoResumo({}, reserva).info.origem, "local");
    assert.deepEqual(metasDoResumo({ metas: { valores: { preparo: { meta: "x" } } } }, reserva).valores, reserva);
  });

  test("diálogo real: diz de onde vêm as metas, que valem em todas as telas e que o passado não muda", () => {
    const salvo = dialogoMetas(METAS_UN, { demonstracao: false, info: { origem: "unidade", versao: 3, atualizadoEm: "2026-10-21T12:00:00Z", atualizadoPor: "<Gestora>" } });
    assert.match(salvo, /Metas salvas da unidade \(versão 3/);
    assert.match(salvo, /por &lt;Gestora&gt;/, "nome escapado");
    assert.match(salvo, /Valem na TV, no tablet e no Dashboard/);
    assert.match(salvo, /meta que valia no recebimento de cada pedido/);
    assert.match(salvo, />Salvar metas da unidade</);
    assert.match(dialogoMetas(METAS_UN, { demonstracao: false, info: { origem: "padrao", versao: 0 } }), /ainda não salvou metas/);
  });

  test("sem ler as metas do servidor: o botão de salvar fica desligado (nada é gravado às cegas)", () => {
    const html = dialogoMetas(METAS_EXEMPLO, { demonstracao: false, info: { origem: "indisponivel" } });
    assert.match(html, /não é possível salvar/);
    assert.match(html, /<button type="submit"[^>]*disabled/);
  });

  test("conflito/falha: aviso como alerta focável; salvando: botão ocupado", () => {
    const html = dialogoMetas(METAS_UN, { demonstracao: false, info: { origem: "unidade", versao: 4 }, aviso: "alteradas em outro aparelho" });
    assert.match(html, /<p class="cko-metas-erro" role="alert" tabindex="-1" data-metas-aviso>alteradas em outro aparelho<\/p>/);
    assert.match(dialogoMetas(METAS_UN, { demonstracao: false, info: { origem: "unidade", versao: 4 }, salvando: true }), /disabled aria-busy="true">Salvando…/);
  });

  test("controlador: grava pela api com a versão da tela; conflito recarrega o valor do servidor; falha não aplica nada", () => {
    const fonte = ler("../src/checklistOperacional.js");
    assert.match(fonte, /salvarMetasChecklist\(\{ versao: estado\.metasInfo\?\.versao \?\? 0, metas: r\.metas \}\)/);
    assert.match(fonte, /erro\?\.codigo === "METAS_CONFLITO" && erro\.details\?\.metas\?\.valores/);
    const corpoFalha = fonte.slice(fonte.indexOf("} else {\n        preencherMetas(dlg, r.metas"), fonte.indexOf("dlg.querySelector(\"[data-metas-aviso]\")"));
    assert.doesNotMatch(corpoFalha, /estado\.metas =/, "falha de gravação não troca as metas vigentes");
    assert.match(fonte, /eventos: \[EVENTOS_IFOOD_PEDIDOS\.ESTADO_ATUALIZADO, RESINCRONIZACAO, EVENTOS_CHECKLIST\.METAS_ATUALIZADAS\]/);
  });

  test("api.js: PUT /metas com a versão; Excel por download autenticado; nenhuma unidade enviada", () => {
    const api = ler("../src/api.js");
    assert.match(api, /method: "PUT"[^\n]*body: JSON\.stringify\(\{ versao, metas/);
    assert.match(api, /obterDashboardChecklist = \(filtro\) => getJson\(`\$\{CHECKLIST\}\/dashboard\$\{qs\(filtro\)\}`\)/);
    assert.doesNotMatch(api.slice(api.indexOf("const CHECKLIST"), api.indexOf("// Financial (Fase 2")), /unidadeId|organizacaoId/);
  });
});

// =====================================================================
describe("fundo dinâmico (TV e Tablet)", () => {
  test("piora é imediata; melhora só depois de estável; meta nova / primeira pintura aplicam na hora", () => {
    let f = proximoFundo(null, "ok", 0);
    assert.equal(f.nivel, "ok");
    f = proximoFundo(f, "critico", 1000);
    assert.equal(f.nivel, "critico", "piorou: na hora");
    f = proximoFundo(f, "ok", 2000);
    assert.equal(f.nivel, "critico", "melhorou: espera");
    f = proximoFundo(f, "atencao", 3000);
    assert.equal(f.candidato, "atencao", "candidato trocou: contagem recomeça");
    f = proximoFundo(f, "atencao", 3000 + RETENCAO_MELHORA_MS - 1);
    assert.equal(f.nivel, "critico");
    f = proximoFundo(f, "atencao", 3000 + RETENCAO_MELHORA_MS);
    assert.deepEqual([f.nivel, f.mudou], ["atencao", true]);
    assert.equal(proximoFundo({ nivel: "critico" }, "ok", 0, { forcar: true }).nivel, "ok");
    assert.equal(proximoFundo(null, "qualquer", 0).nivel, "neutro");
  });

  test("a cor do fundo é o status agregado JÁ existente; os dois modos continuam com o MESMO conteúdo", () => {
    const r = adaptarResumo(respostaResumo(AGORA), { unidade: UNIDADE, metas: METAS_EXEMPLO, recebidoEmMs: AGORA });
    const tv = montarTela(r, AGORA, { modo: "tv", nivelFundo: "critico" });
    const tablet = montarTela(r, AGORA, { modo: "tablet", nivelFundo: "critico" });
    assert.match(tv, /^<div class="cko cko--imersivo cko--tv" data-cko data-modo="tv" data-fundo="critico"/);
    assert.match(tablet, /data-modo="tablet" data-fundo="critico"/);
    assert.equal(tv.slice(tv.indexOf(">") + 1), tablet.slice(tablet.indexOf(">") + 1), "paridade TV × Tablet preservada");
    assert.doesNotMatch(montarTela(r, AGORA, {}), /data-fundo/, "fora dos modos (prévia no app) não há fundo dinâmico");
  });

  test("status também por TEXTO e ÍCONE (nunca só cor): ícone ao lado do veredito, sem altura nova no cabeçalho", () => {
    for (const nivel of ["ok", "atencao", "critico", "neutro"]) {
      assert.match(iconeStatusOperacao(nivel), new RegExp(`data-status-icone="${nivel}" aria-hidden="true"><svg class="icon`));
    }
    assert.equal(iconeStatusOperacao("<x>").includes('data-status-icone="neutro"'), true);
    const r = adaptarResumo(respostaResumo(AGORA), { unidade: UNIDADE, metas: METAS_EXEMPLO, recebidoEmMs: AGORA });
    const html = montarTela(r, AGORA, { modo: "tv" });
    // O veredito continua começando pelo texto (o ícone vem DEPOIS) e o cabeçalho não ganhou elemento novo.
    assert.match(html, /<p class="cko-status-veredito">(Dentro da meta|Fora da meta|Próximo da meta|Atenção|Sem medições hoje)<span class="cko-status-icone" data-status-icone="(ok|atencao|critico|neutro)" aria-hidden="true">/);
    assert.doesNotMatch(html, /cko-status-selo|data-slot-selo-status/);
  });

  test("CSS: fundo nos três estados só nos modos, transição suave, nada anima com movimento reduzido, superfícies intactas", () => {
    const css = ler("../src/checklistOperacional.css");
    for (const n of ["ok", "atencao", "critico", "neutro"]) assert.match(css, new RegExp(`\\.cko--imersivo\\[data-fundo="${n}"\\]`));
    // Cor sólida na própria raiz (mesmo custo de pintura de antes em repouso); transição só na troca de estado.
    assert.match(css, /\.cko--imersivo \{ background-color: var\(--cko-fundo-tom, var\(--cko-fundo\)\); transition: background-color 900ms ease; \}/);
    const bloco = css.slice(css.indexOf("FUNDO DINÂMICO"), css.indexOf("Ícone do status"));
    assert.doesNotMatch(bloco, /gradient\(|box-shadow:|::before \{/, "sem gradiente, sombra ou camada extra");
    assert.match(bloco, /@media \(prefers-reduced-motion: reduce\) \{ \.cko--imersivo \{ transition: none; \} \}/, "a regra global não alcança a própria raiz");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.cko \*, \.cko \*::before, \.cko \*::after \{ animation: none !important; transition: none !important; \}/);
    assert.doesNotMatch(css.slice(css.indexOf("FUNDO DINÂMICO")), /\.cko-card[^{]*\{[^}]*background/, "o fundo não repinta os cards");
  });

  test("controlador: aplica o fundo no tique só com um modo aberto, sem redesenhar a tela", () => {
    const fonte = ler("../src/checklistOperacional.js");
    assert.match(fonte, /function aplicarFundo\(raiz, nivel\) \{\n  if \(!modoValido\(estado\.modo\)\) return;/);
    assert.match(fonte, /if \(raiz\.dataset\.fundo !== exibido\) raiz\.dataset\.fundo = exibido;/);
  });
});

// =====================================================================
describe("seleção: terceira opção", () => {
  const html = telaSelecaoModos({ unidadeNome: UNIDADE.nome });
  test("Televisão, Tablet e Dashboard Operacional — os dois modos continuam iguais entre si", () => {
    assert.deepEqual([...html.matchAll(/data-acao="(iniciar-modo|abrir-dashboard)"(?: data-modo="(\w+)")?/g)].map((m) => m[2] ?? m[1]), ["tv", "tablet", "abrir-dashboard"]);
    assert.match(html, /<h2 id="ckm-t-dash">.*Dashboard Operacional<\/h2>/);
    assert.match(html, /Abrir Dashboard Operacional/);
    assert.doesNotMatch(html, /\bmin\b|\d+\s*pedidos?/, "a escolha continua sem número");
  });
  test("controlador abre o Dashboard pela ação própria", () => {
    assert.match(ler("../src/checklistOperacional.js"), /if \(ev\.target\.closest\('\[data-acao="abrir-dashboard"\]'\)\) \{ abrirDashboard\(\); return; \}/);
  });
});

// =====================================================================
describe("Dashboard Operacional — tela", () => {
  const d = payload();
  // Dashboard 2.0: os blocos ficam em duas abas (Visão Geral e Ocorrências); o teste junta as duas.
  const tela = (aba) => telaDashboard({ dados: d, filtro: { periodo: "personalizado", inicio: "2026-10-12", fim: "2026-10-18", etapa: "todas" }, unidadeNome: "Subway <Saci>", carregando: false, erro: null, hoje: "2026-10-21", aba });
  const html = tela("visao") + tela("ocorrencias");

  test("Dashboard 2.0 sem Mediana nem P90 na interface gerencial", () => {
    assert.doesNotMatch(html, /mediana|P90|mediano/i);
  });

  test("todos os blocos: KPIs, gráficos, análises, etapas, comparativo, atrasos, metas, qualidade, definições", () => {
    for (const t of ["Pedidos recebidos", "Pedidos concluídos", "Cancelamentos", "Preparo — tempo médio", "Entrega — tempo médio", "Vida do pedido — tempo médio", "Pedidos dentro da meta", "Atrasos", "Maior atraso",
      "Evolução diária", "Horários de maior demanda", "Pedidos atrasados por horário", "Volume por dia da semana", "Distribuição por status operacional",
      "Inteligência operacional", "Desempenho por etapa", "Comparação com o período anterior", "Atrasos e ocorrências", "Metas aplicáveis",
      "Cobertura e qualidade dos dados", "Como cada indicador é calculado", "Cumprimento dos itens do checklist"]) {
      assert.ok(html.includes(t), t);
    }
    assert.doesNotMatch(html, /NaN|undefined|null|\[object/);
    assert.match(html, /Subway &lt;Saci&gt;/);
  });

  test("análises separam Fato, Hipótese (não comprovada) e Recomendação, com evidências consultáveis", () => {
    assert.ok(d.analises.itens.length > 0);
    assert.equal(contar(html, /<dt>Fato<\/dt>/g), d.analises.itens.length);
    assert.equal(contar(html, /<dt>Hipótese <small>\(não comprovada\)<\/small><\/dt>/g), d.analises.itens.filter((a) => a.hipotese).length);
    assert.match(html, /<summary>Evidências: \d+ pedidos?/);
  });

  test("gráficos: um eixo, legenda com ≥2 séries, tabela de dados, alvos de hover; dia sem medição vira lacuna", () => {
    const g = graficosDoDashboard(d);
    assert.equal(contar(Object.values(g).join(""), /<svg /g), 6);
    assert.match(g.evolucao, /class="ckd-legenda"/);
    assert.ok(contar(g.evolucao, /Ver tabela de dados/g) === 1);
    assert.ok(contar(g.evolucao, /data-tip=/g) >= 7);
    const caminho = g.evolucao.match(/<path d="([^"]+)" class="ckd-linha" style="stroke:var\(--ckd-s1\)"/)[1];
    assert.equal(contar(caminho, /M/g), 2, "14/10 sem pedido quebra a linha (nunca zero)");
    assert.doesNotMatch(g.demandaHora, /class="ckd-legenda"/, "série única: o título nomeia, sem caixa de legenda");
    assert.deepEqual(escala(37), { teto: 50, passos: [0, 12.5, 25, 37.5, 50] });
  });

  test("uma etapa: a meta vira linha de referência rotulada; cor da etapa não muda com o filtro", () => {
    const g = graficoEvolucao(payload({ etapa: "entrega" }));
    assert.match(g, /class="ckd-ref"/);
    assert.match(g, /meta 30/);
    assert.match(g, /stroke:var\(--ckd-s2\)/, "entrega continua laranja mesmo sozinha");
  });

  test("dados ausentes: período sem pedidos mostra '—' e motivos, nunca zero inventado", () => {
    const vazio = payload({ inicio: "2026-10-19", fim: "2026-10-19", pedidos: [] });
    const telaVazia = (aba) => telaDashboard({ dados: vazio, filtro: { periodo: "ontem", etapa: "todas" }, unidadeNome: "U", carregando: false, erro: null, hoje: "2026-10-21", aba });
    const h = telaVazia("visao") + telaVazia("ocorrencias");   // Dashboard 2.0: análises ficam na aba Ocorrências
    assert.match(h, /<p class="ckd-kpi-valor">—<\/p>/);
    assert.match(h, /A evolução diária aparece em períodos de 2 dias ou mais/);
    assert.match(h, /Nenhuma análise disparou/);
    assert.match(h, /análises não avaliadas por falta de dados/);
    assert.doesNotMatch(h, /NaN|undefined/);
  });

  test("variação em TEXTO (melhor/pior), tempo menor = melhor, % maior = melhor", () => {
    assert.deepEqual(variacao(-1.5), { texto: "−1,5 min vs. anterior (melhor)", tom: "melhor" });
    assert.equal(variacao(2, { menorMelhor: false, pp: true }).texto, "+2 p.p. vs. anterior (melhor)");
    assert.equal(variacao(null).tom, "sem");
    assert.equal(textoPeriodo({ inicio: "2026-10-21", fim: "2026-10-21", ate: "2026-10-21T18:00:00Z" }), "21/10/2026 (parcial até 15:00)");
  });

  test("filtros: unidade só do seletor global; período personalizado exige datas válidas", () => {
    assert.match(html, /<output title="Para trocar, use o seletor de unidade do topo">/);
    assert.equal(validarFiltro({ periodo: "personalizado", inicio: "", fim: "2026-10-01" }, "2026-10-21"), "Informe as duas datas do período personalizado.");
    assert.equal(validarFiltro({ periodo: "personalizado", inicio: "2026-10-10", fim: "2026-10-01" }, "2026-10-21"), "A data inicial é depois da final.");
    assert.equal(validarFiltro({ periodo: "personalizado", inicio: "2026-10-10", fim: "2026-10-22" }, "2026-10-21"), "O período não pode terminar no futuro.");
    assert.deepEqual(paraConsulta({ periodo: "semana", inicio: "x", fim: "y", etapa: "vida" }), { periodo: "semana", etapa: "vida" });
  });

  test("acessibilidade: tabelas com cabeçalho de escopo, gráficos com rótulo, erro como alerta, tooltip como tooltip", () => {
    assert.ok(contar(html, /<th scope="col">/g) > 20);
    assert.ok(contar(html, /<svg [^>]*role="img" aria-label="/g) === 6);
    assert.match(html, /role="tooltip"/);
    assert.match(telaDashboard({ dados: null, filtro: { periodo: "hoje", etapa: "todas" }, unidadeNome: "U", carregando: false, erro: "falhou", hoje: "2026-10-21" }), /<p class="ckd-erro" role="alert">falhou<\/p>/);
  });

  test("responsivo: CSS com quebras para tablet/celular e cores de gráfico próprias no tema escuro", () => {
    const css = ler("../src/checklistOperacionalDashboard.css");
    assert.match(css, /@media \(max-width: 900px\) \{ \.ckd-graficos \{ grid-template-columns: 1fr; \} \}/);
    assert.match(css, /@media \(max-width: 600px\)/);
    assert.match(css, /:root\[data-theme="dark"\] \.ckd \{ --ckd-s1:/);
    assert.match(ler("../index.html"), /checklistOperacionalDashboard\.css\?v=3/);   // v3 = Dashboard 2.0 (abas, ficha, fechamento)
  });
});

// =====================================================================
describe("relatórios — PDF corresponde à tela; seções iguais às do Excel", () => {
  const d = payload();
  const meta = { unidadeNome: "Subway Saci", geradoEm: new Date(AGORA).toISOString() };

  test("as seções do PDF são as mesmas do Excel (backend)", () => {
    assert.deepEqual(SECOES_RELATORIO.map((s) => s.id), SECOES_BACKEND.map((s) => s.id));
    assert.equal(contar(dialogoRelatorio(["resumo"]), /type="checkbox"/g), SECOES_RELATORIO.length);
    assert.equal(contar(dialogoRelatorio(["resumo"]), /checked/g), 1);
  });

  test("identificação, período, geração, resumo executivo; só as seções escolhidas", () => {
    const so = htmlRelatorio(d, ["resumo", "analises"], meta);
    assert.match(so, /Relatório operacional — Subway Saci/);
    assert.match(so, /12\/10\/2026 a 18\/10\/2026/);
    assert.match(so, /Gerado em/);
    assert.match(so, /Inteligência operacional/);
    assert.doesNotMatch(so, /Desempenho por etapa|Metas aplicáveis/);
    assert.ok(resumoExecutivo(d).some((f) => /pedidos acompanhados/.test(f)));
  });

  test("os números do PDF são os da tela (mesmos componentes, mesmo payload)", () => {
    const tela = telaDashboard({ dados: d, filtro: { periodo: "personalizado" }, unidadeNome: "U", carregando: false, erro: null, hoje: "2026-10-21" });
    const pdf = htmlRelatorio(d, ["etapas"], meta);
    const bloco = (h) => h.slice(h.indexOf('<section class="ckd-bloco" aria-labelledby="ckd-t-etapas">'), h.indexOf("</section>", h.indexOf("ckd-t-etapas")));
    assert.equal(bloco(pdf), bloco(tela));
  });

  test("documento: página A4, evidências abertas no papel, sem dado de cliente", () => {
    const doc = documentoRelatorio(d, SECOES_RELATORIO.map((s) => s.id), meta);
    assert.match(doc, /@page \{ size: A4/);
    assert.match(doc, /<details class="ckd-evidencia" open>/);
    assert.match(doc, /<title>Checklist-Operacional_2026-10-12_a_2026-10-18<\/title>/);
    assert.doesNotMatch(doc, /o-\d+"|customer|merchant/i);
  });
});
