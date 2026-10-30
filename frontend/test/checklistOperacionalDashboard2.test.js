// Dashboard Operacional 2.0 — frontend: abas, lista de pedidos, Ficha 360°, painel de fechamento, prévia do WhatsApp e PDF.
//
// Os payloads são gerados pelas FUNÇÕES PURAS DO BACKEND (projeção, ficha, fechamento, diagnóstico, mensagem) sobre o cenário
// sintético dos testes do backend — a tela é testada contra o formato real, não contra uma cópia à mão.
//
// Rodar: node --test frontend/test/checklistOperacionalDashboard2.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { navegacaoAbas, painelPedidos, fichaPedido, painelFechamentos, painelWhatsapp, documentoFechamento, indicadoresFechamento, ABAS_DASHBOARD } from "../src/checklistOperacionalOperacional.js";
import { telaDashboard } from "../src/checklistOperacionalDashboardVisual.js";

import { cenarioPrincipal, PII } from "../../backend/test/helpers/operacional-sintetico.js";
import { projetarPedido } from "../../backend/src/modules/checklist-operacional/checklistOperacional.projecao.js";
import { montarFicha, itemDaLista } from "../../backend/src/modules/checklist-operacional/checklistOperacional.ficha.js";
import { linhaDoTempoDasMetas } from "../../backend/src/modules/checklist-operacional/checklistOperacional.metas.js";
import { montarDashboard } from "../../backend/src/modules/checklist-operacional/checklistOperacional.indicadores.js";
import { resolverPeriodo } from "../../backend/src/modules/checklist-operacional/checklistOperacional.periodos.js";
import { calcularFechamento } from "../../backend/src/modules/checklist-operacional/checklistOperacional.fechamento.js";
import { gerarDiagnostico, textoDeterministico } from "../../backend/src/modules/checklist-operacional/checklistOperacional.diagnostico.js";
import { gerarMensagem, validarMensagem } from "../../backend/src/modules/checklist-operacional/checklistOperacional.whatsapp.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const AGORA = Date.parse("2026-10-28T12:00:00.000Z");
const TENANT = { org: "a0000000-0000-4000-8000-00000000000a", un: "a1000000-0000-4000-8000-0000000000a1" };

const c = cenarioPrincipal();
const doTenant = (x) => x.organizacao_id === TENANT.org && x.unidade_id === TENANT.un;
const metas = linhaDoTempoDasMetas(c.metas);
const projecoes = c.pedidos.filter(doTenant).map((p) => ({ ...projetarPedido({ pedido: p, eventos: c.eventos.filter((e) => e.order_id === p.order_id) }), projetado_em: "2026-10-28T12:00:00.000Z" }));
const lista = { total: 3, itens: projecoes.slice(0, 3).map((p) => itemDaLista(p, metas)), periodo: { inicio: c.competencia, fim: c.competencia } };
const lento = projecoes.find((p) => p.display_id === "1100");
const ficha = montarFicha({ projecao: lento, linhaDoTempoMetas: metas, disputas: [{ handshake_type: "DELAY", settlement_status: "EXPIRED", expires_at: "2026-10-27T22:00:00Z" }], unidadeNome: "Unidade <Teste>" });

function fechamento() {
  const periodo = resolverPeriodo({ periodo: "personalizado", inicio: c.competencia, fim: c.competencia, agoraMs: AGORA });
  const dashboard = montarDashboard({ pedidos: c.pedidos.filter(doTenant), periodo, linhaDoTempo: metas });
  const f = calcularFechamento({
    competencia: c.competencia, hoje: "2026-10-28", agoraMs: AGORA, fuso: "America/Sao_Paulo", fusoOrigem: "padrao_plataforma", dashboard, projecoes,
    disputas: c.disputas.filter(doTenant), cobertura: { primeiroPedidoEm: "2026-10-26T13:00:00Z", semCobertura: false, eventosNoDia: 100, semSinalDeRecebimento: false, projecaoComFalha: false },
  });
  const diag = gerarDiagnostico(f);
  return { ...f, id: "11111111-1111-4111-8111-111111111111", versao: 1, gerado_em: "2026-10-28T12:00:00Z", origem: "manual", fuso_origem: "padrao_plataforma",
    execucao_id: "22222222-2222-4222-8222-222222222222", hash_conteudo: "abcdef0123456789", fonte: { statusMotivo: f.statusMotivo }, diagnostico: { ...diag, texto: textoDeterministico(diag) } };
}
const fech = fechamento();
const mensagem = gerarMensagem({ fechamento: fech, unidadeNome: "Unidade Teste" });
const previa = { status: "READY_FOR_REVIEW", mensagem, validacao: validarMensagem(mensagem, { fechamento: fech }), transporte: "noop", envioReal: false, fechamento: { id: fech.id, versao: 1, status: fech.status }, historico: [] };

const semPII = (html) => { for (const v of Object.values(PII)) assert.equal(html.includes(v), false, `dado pessoal fictício vazou: ${v}`); };
const contar = (s, re) => (s.match(re) ?? []).length;

describe("abas", () => {
  test("quatro abas com WAI-ARIA (tablist, aria-selected, aria-controls, tabindex só na ativa)", () => {
    const h = navegacaoAbas("pedidos");
    assert.deepEqual(ABAS_DASHBOARD.map((a) => a.rotulo), ["Visão Geral e Desempenho", "Pedidos e Ficha 360°", "Ocorrências e Diagnóstico", "Fechamentos e Relatórios"]);
    assert.match(h, /role="tablist"/);
    assert.equal(contar(h, /role="tab"/g), 4);
    assert.equal(contar(h, /aria-selected="true"/g), 1);
    assert.match(h, /id="ckd-aba-pedidos" aria-controls="ckd-painel-pedidos" aria-selected="true" tabindex="0"/);
    assert.equal(contar(h, /tabindex="-1"/g), 3);
  });

  test("telaDashboard: abas novas sem depender do payload do período; Fechamentos sem o filtro de período", () => {
    const ped = telaDashboard({ dados: null, filtro: { periodo: "hoje", etapa: "todas" }, unidadeNome: "U", carregando: false, erro: null, hoje: "2026-10-28", aba: "pedidos", abas: navegacaoAbas("pedidos"), conteudoAba: painelPedidos({ lista }) });
    assert.match(ped, /data-ckd-filtros/);
    assert.match(ped, /role="tabpanel" id="ckd-painel-pedidos" aria-labelledby="ckd-aba-pedidos"/);
    const f = telaDashboard({ dados: null, filtro: { periodo: "hoje", etapa: "todas" }, unidadeNome: "U", carregando: false, erro: null, hoje: "2026-10-28", aba: "fechamentos", abas: navegacaoAbas("fechamentos"), conteudoAba: "<p>x</p>" });
    assert.doesNotMatch(f, /data-ckd-filtros/, "o fechamento usa a competência, não o período");
    assert.doesNotMatch(f, /Relatório PDF \/ Excel/);
  });
});

describe("Pedidos e Ficha 360°", () => {
  test("lista: botão por pedido com a chave opaca, estado de carga, vazio e busca por número", () => {
    const h = painelPedidos({ lista });
    assert.equal(contar(h, /data-acao="ficha" data-chave="[0-9a-f]{16}"/g), 3);
    assert.doesNotMatch(h, /pd-\d{5}/, "o orderId não aparece");
    assert.match(painelPedidos({ lista: null, carregando: true }), /role="status"/);
    assert.match(painelPedidos({ lista: { total: 0, itens: [] } }), /Nenhum pedido recebido no período/);
    assert.match(painelPedidos({ lista, busca: "999999" }), /Nenhum pedido com esse número/);
    semPII(h);
  });

  test("ficha: identificação parcial, tempos com meta, linha do tempo, produtos, financeiro operacional e ocorrências — sem dado pessoal", () => {
    const h = fichaPedido({ ficha });
    for (const t of ["Ficha 360° do pedido", "#1100", "Tempos", "Linha do tempo oficial", "Produtos", "Financeiro operacional", "Ocorrências", "Não são repasse", "Espera do entregador na loja", "+10 min"]) assert.ok(h.includes(t), t);
    assert.match(h, /Unidade &lt;Teste&gt;/);
    assert.match(h, /Disputa DELAY: EXPIRED/);
    assert.doesNotMatch(h, /NaN|undefined|\[object/);
    semPII(h);
  });

  test("ficha com etapa sem medição mostra o motivo (nunca um número inventado)", () => {
    const sem = projecoes.find((p) => p.display_id === "1200");   // entrega própria: sem AAO/CLT
    const h = fichaPedido({ ficha: montarFicha({ projecao: sem, linhaDoTempoMetas: metas }) });
    assert.match(h, /não medido — sem o carimbo/);
  });

  test("ficha em carga e com erro", () => {
    assert.match(fichaPedido({ ficha: null, carregando: true }), /Carregando a ficha/);
    assert.match(fichaPedido({ ficha: null, carregando: false, erro: "Pedido não encontrado nesta unidade." }), /role="alert">Pedido não encontrado/);
  });
});

describe("Fechamentos e Relatórios", () => {
  test("os 11 indicadores, diagnóstico com ação e pendências — mesmos números do fechamento armazenado", () => {
    const h = indicadoresFechamento(fech);
    for (const n of ["1 · Pedidos", "Preparo — tempo médio", "Entrega — tempo médio", "Vida do pedido — tempo médio", "5 · Pedidos atrasados", "6 · Cancelamentos", "7 · Maior movimento", "8 · Disputas", "9 · Descontos pagos pela loja", "10 · Clientes", "11 · Diagnóstico e ação sugerida"]) assert.ok(h.includes(n), n);
    assert.ok(h.includes(`${fech.indicadores.pedidos.recebidos}<small>recebidos</small>`));
    assert.ok(h.includes(`${String(fech.indicadores.preparo.media).replace(".", ",")}<small>min</small>`));
    assert.match(h, /Ação: /);
    assert.doesNotMatch(h, /mediana|\bP90\b|\bNaN\b|undefined/i);   // limite de palavra: "Financial" contém "nan"
    semPII(h);
  });

  test("painel: competência, versões, gerar só para quem gerencia, situação rotulada", () => {
    const comum = { competencia: c.competencia, hoje: "2026-10-28", lista: [{ id: fech.id, competencia: c.competencia, versao: 1, status: fech.status, gerado_em: fech.gerado_em }], atual: fech, previa };
    const gestor = painelFechamentos({ ...comum, podeGerar: true });
    assert.match(gestor, /Gerar \/ atualizar/);
    assert.match(gestor, /name="motivo"/);
    assert.match(gestor, /data-acao="versao"/);
    assert.match(gestor, /data-acao="fech-pdf"/);
    assert.match(gestor, /data-acao="fech-excel"/);
    const leitor = painelFechamentos({ ...comum, podeGerar: false });
    assert.doesNotMatch(leitor, /Gerar \/ atualizar|data-acao="wa-simular"/);
    assert.match(leitor, /Somente gestores geram ou revisam/);
    assert.match(painelFechamentos({ ...comum, lista: [], atual: null, podeGerar: true }), /Nenhum fechamento registrado para 27\/10\/2026/);
  });

  test("prévia do WhatsApp: rotulada SIMULAÇÃO, avisa que nada é enviado, copiar e regenerar; simular só quando pronta", () => {
    const h = painelWhatsapp({ previa, podeGerar: true });
    assert.match(h, /SIMULAÇÃO/);
    assert.match(h, /Nenhuma mensagem é enviada/);
    assert.match(h, /data-acao="wa-copiar"/);
    assert.match(h, /data-acao="wa-regenerar"/);
    assert.match(h, /data-acao="wa-simular"(?! disabled)/);
    const bloqueada = painelWhatsapp({ previa: { ...previa, status: "BLOCKED", validacao: { problemas: [{ mensagem: "Mensagem longa demais." }] } }, podeGerar: true });
    assert.match(bloqueada, /data-acao="wa-simular" disabled/);
    assert.match(bloqueada, /Mensagem longa demais/);
    assert.match(h, /\*CRESCER COM DELIVERY\*/, "o texto da prévia é o mesmo gerado pelo backend");
    semPII(h);
  });

  test("PDF do fechamento: documento próprio com os mesmos blocos da tela, versão e situação", () => {
    const doc = documentoFechamento(fech, { unidadeNome: "Unidade Teste" });
    assert.match(doc, /^<!doctype html>/);
    assert.match(doc, /Fechamento-Operacional_2026-10-27_v1/);
    assert.ok(doc.includes(indicadoresFechamento(fech).replace(/<details class="ckd-evidencia">/g, '<details class="ckd-evidencia" open>')));
    assert.match(doc, /Valores operacionais \(não são repasse\)/);
    semPII(doc);
  });
});

describe("controlador — proteções", () => {
  const fonte = readFileSync(path.join(AQUI, "../src/checklistOperacionalDashboard.js"), "utf8");
  test("nenhuma chamada de envio real: só a simulação do backend", () => {
    assert.doesNotMatch(fonte, /comunicacao|enviarMensagem|whatsapp\.service|gateway/i);
    assert.match(fonte, /simularWhatsappFechamento/);
  });
  test("gerar e simular conferem a permissão também na tela (o backend confere de novo)", () => {
    assert.match(fonte, /const podeGerarFechamento = \(\) => pode\("configuracoes\.gerenciar"\) \|\| pode\("integracoes\.gerenciar"\)/);
    assert.match(fonte, /async function gerarFechamento\(competencia\) \{\n  if \(!podeGerarFechamento\(\)\) return;/);
    assert.match(fonte, /async function simular\(botao\) \{\n  if \(!podeGerarFechamento\(\) \|\| !est\.fech\.atual\) return;/);
  });
  test("respostas antigas ou de outro contexto são descartadas nas abas novas", () => {
    for (const fn of ["carregarPedidos", "carregarFechamentos"]) {
      const corpo = fonte.slice(fonte.indexOf(`async function ${fn}`), fonte.indexOf("\n}\n", fonte.indexOf(`async function ${fn}`)));
      assert.match(corpo, /contextoMudou\(g\)/, fn);
      assert.match(corpo, /seq !== est\.(pedidos|fech)\.seq/, fn);
    }
  });
});
