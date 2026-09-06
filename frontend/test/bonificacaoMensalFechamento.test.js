// F7 — camada de interface do Fechamento Mensal. Testes PUROS (sem DOM, mesma
// convenção do resto de frontend/test/): a lógica testável vive em
// src/bonificacaoMensalFechamento.js; o que sobra (eventos, upload, chamadas de
// API) é verificado por asserção no fonte de bonificacaoMensalImportModal.js.
//
// Rodar: node --test frontend/test/bonificacaoMensalFechamento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  podeAnalisarMensal, montarPayloadMensal, classificacaoView,
  mensalPaneHtml, previewMensalHtml,
} from "../src/bonificacaoMensalFechamento.js";

const MODAL_SRC = readFileSync(fileURLToPath(new URL("../src/bonificacaoMensalImportModal.js", import.meta.url)), "utf8");
const API_SRC = readFileSync(fileURLToPath(new URL("../src/api.js", import.meta.url)), "utf8");
const PURO_SRC = readFileSync(fileURLToPath(new URL("../src/bonificacaoMensalFechamento.js", import.meta.url)), "utf8");

const paneAberto = () => mensalPaneHtml({ mesAtual: 6, anoAtual: 2026, anos: [2026, 2025, 2024], fechada: false });

const previewBase = (over = {}) => ({
  competencia: { ano: 2026, mes: 6, label: "Junho/2026" },
  vendas: { faturamento: 100000, ticketMedio: 50, quantidadeVendas: 2000, estabelecimento: "LOJA X" },
  produtos: { sanduichesSaladas: 2533, bebidas: 1086, adicionais: 613, diversos: 508, faturamentoLoja: 90000, percentuais: { bebidas: 42.9, adicionais: 24.2, diversos: 20.1 } },
  acompanhamento: { tipo: "SEM_ACOMPANHAMENTO", diasEsperados: 30, diasCobertos: 0, diasComAcompanhamento: 0, diasPendentes: [] },
  validacao: { bloqueios: [], alertas: [], conferencia: { percentuais: { regra: { bebidas: 42.9 }, impressosNoPdf: { bebidas: 43.0 } } } },
  resultadoOficial: {
    valoresOficiais: { faturamento: 100000, ticketMedio: 50, quantidadeVendas: 2000, sanduichesSaladas: 2533, percentuais: { bebidas: 42.9, adicionais: 24.2, diversos: 20.1 } },
    indicadores: { cmv: { valorAtual: 28.5 }, avaliacao_ifood: { valorAtual: 4.8 }, rev: { valorAtual: 12 } },
  },
  prontoParaConfirmar: true,
  ...over,
});

// ---------------------------------------------------------------------------
describe("F7 · 1 — dois dropzones distintos", () => {
  const html = paneAberto();
  test("os dois relatórios têm dropzone próprio e rótulo claro", () => {
    assert.match(html, /1\. Relatório Geral de Vendas — mês inteiro/);
    assert.match(html, /2\. Relatório de Produtos — mês inteiro/);
    assert.match(html, /id="bm-mensal-vendas-drop"/);
    assert.match(html, /id="bm-mensal-produtos-drop"/);
    assert.match(html, /id="bm-mensal-vendas-input"/);
    assert.match(html, /id="bm-mensal-produtos-input"/);
  });
  test("cada dropzone tem nome do arquivo e opção de trocar/remover", () => {
    assert.match(html, /id="bm-mensal-vendas-nome"/);
    assert.match(html, /id="bm-mensal-produtos-nome"/);
    assert.match(html, /id="bm-mensal-vendas-remover"/);
    assert.match(html, /id="bm-mensal-produtos-remover"/);
  });
  test("dois checkboxes de conferência", () => {
    assert.match(html, /id="bm-mensal-conf-vendas"/);
    assert.match(html, /id="bm-mensal-conf-produtos"/);
    assert.match(html, /Conferi o Relatório Geral de Vendas/);
    assert.match(html, /Conferi o Relatório de Produtos/);
  });
  test("não há um campo genérico único de upload", () => {
    assert.doesNotMatch(html, /id="bm-mensal-drop"/);
    assert.doesNotMatch(html, /id="bm-mensal-input"/);
  });
});

describe("F7 · 2 e 3 — [Analisar relatórios]", () => {
  test("desabilitado sem os 2 PDFs", () => {
    assert.equal(podeAnalisarMensal({ ano: 2026, mes: 6, temVendas: true, temProdutos: false }), false);
    assert.equal(podeAnalisarMensal({ ano: 2026, mes: 6, temVendas: false, temProdutos: true }), false);
    assert.equal(podeAnalisarMensal({ ano: 2026, mes: 6, temVendas: false, temProdutos: false }), false);
    assert.match(paneAberto(), /id="bm-mensal-analisar"[^>]*disabled/);
  });
  test("habilitado com mês, ano e os 2 PDFs", () => {
    assert.equal(podeAnalisarMensal({ ano: 2026, mes: 6, temVendas: true, temProdutos: true }), true);
  });
  test("bloqueado por competência inválida mesmo com os 2 PDFs", () => {
    assert.equal(podeAnalisarMensal({ ano: 1999, mes: 6, temVendas: true, temProdutos: true }), false);
    assert.equal(podeAnalisarMensal({ ano: 2026, mes: 13, temVendas: true, temProdutos: true }), false);
    assert.equal(podeAnalisarMensal({ ano: NaN, mes: NaN, temVendas: true, temProdutos: true }), false);
  });
  test("o fonte gateia o botão por podeAnalisarMensal", () => {
    assert.match(MODAL_SRC, /podeAnalisarMensal\(\{[\s\S]*?temVendas: !!ctx\.arquivos\.vendasMensal/);
  });
});

describe("F7 · 4 — envia os dois arquivos corretos ao backend", () => {
  test("montarPayloadMensal carrega vendas + produtos e mapeia os checkboxes", () => {
    const p = montarPayloadMensal({
      ano: "2026", mes: "6",
      vendas: { nomeArquivo: "v.pdf", conteudoBase64: "AA" },
      produtos: { nomeArquivo: "p.pdf", conteudoBase64: "BB" },
      conferiVendas: true, conferiProdutos: true,
    });
    assert.equal(p.ano, 2026);
    assert.equal(p.mes, 6);
    assert.equal(p.vendas.nomeArquivo, "v.pdf");
    assert.equal(p.produtos.nomeArquivo, "p.pdf");
    assert.equal(p.produtosCanalConfirmado, true);
    assert.equal(p.periodoConfirmadoUsuario, true);
  });
  test("periodoConfirmadoUsuario exige os DOIS checkboxes", () => {
    const p = montarPayloadMensal({ ano: 2026, mes: 6, vendas: {}, produtos: {}, conferiVendas: true, conferiProdutos: false });
    assert.equal(p.periodoConfirmadoUsuario, false);
    assert.equal(p.produtosCanalConfirmado, false);
  });
  test("o fonte envia os dois PDFs (vendasMensal + produtosMensal)", () => {
    assert.match(MODAL_SRC, /arquivoPayload\(ctx\.arquivos\.vendasMensal\)/);
    assert.match(MODAL_SRC, /arquivoPayload\(ctx\.arquivos\.produtosMensal\)/);
    assert.match(MODAL_SRC, /bonifFechamentoMensalPreview\(payload\)/);
  });
});

describe("F7 · 5 — SEM_ACOMPANHAMENTO", () => {
  const html = previewMensalHtml(previewBase());
  test("classificação sugere Confirmar fechamento", () => {
    assert.equal(classificacaoView({ tipo: "SEM_ACOMPANHAMENTO" }).acao, "confirmar");
  });
  test("mostra Confirmar fechamento e não mostra Consolidar", () => {
    assert.match(html, /id="bm-mensal-acao" data-acao="confirmar"/);
    assert.doesNotMatch(html, /data-acao="consolidar"/);
    assert.match(html, /Esta competência não possui acompanhamento diário/);
  });
  test("prévia dos indicadores usa o shape canônico (valoresOficiais), nunca percentuaisPdf", () => {
    assert.match(html, /Indicadores que serão congelados/);
    assert.match(html, /42\.9%/); // bebidas canônico (fmtPct usa ponto)
    assert.doesNotMatch(html, /percentuaisPdf|percentuaisCalculados|somaDiaria/);
  });
  test("Confirmar desabilitado enquanto houver bloqueio", () => {
    const bloq = previewMensalHtml(previewBase({ prontoParaConfirmar: false, validacao: { bloqueios: ["Confirme que o Relatório de Produtos foi exportado com filtro Loja/Balcão."], alertas: [] } }));
    assert.match(bloq, /id="bm-mensal-acao" data-acao="confirmar" disabled/);
    assert.match(bloq, /filtro Loja\/Balcão/);
  });
});

describe("F7 · 6 — ACOMPANHAMENTO_PARCIAL", () => {
  const data = previewBase({
    acompanhamento: { tipo: "ACOMPANHAMENTO_PARCIAL", diasEsperados: 30, diasCobertos: 26, diasComAcompanhamento: 26, diasPendentes: ["2026-06-03", "2026-06-07", "2026-06-12"] },
    validacao: { bloqueios: ["Acompanhamento parcial: 26 de 30 dias têm relatório (3 pendentes: 2026-06-03, 2026-06-07, 2026-06-12). ..."], alertas: [] },
    prontoParaConfirmar: false,
  });
  const html = previewMensalHtml(data);
  test("classificação não oferece ação automática", () => {
    assert.equal(classificacaoView(data.acompanhamento).acao, null);
  });
  test("mostra dias pendentes e não mostra Confirmar nem Consolidar", () => {
    assert.match(html, /Esta competência possui acompanhamento diário parcial/);
    assert.match(html, /Dias esperados: <b>30<\/b>/);
    assert.match(html, /03\/06\/2026/);
    assert.match(html, /07\/06\/2026/);
    assert.match(html, /12\/06\/2026/);
    assert.doesNotMatch(html, /id="bm-mensal-acao"/);
  });
  test("o bloqueio de acompanhamento não é repetido como texto solto", () => {
    assert.doesNotMatch(html, /pill bad">bloqueio<\/span> Acompanhamento parcial/);
  });
});

describe("F7 · 7 — ACOMPANHAMENTO_DIARIO", () => {
  const data = previewBase({
    acompanhamento: { tipo: "ACOMPANHAMENTO_DIARIO", diasEsperados: 30, diasCobertos: 30, diasComAcompanhamento: 30, diasPendentes: [] },
    validacao: { bloqueios: ["Esta competência foi acompanhada dia a dia (30 de 30 dias). ..."], alertas: [] },
    prontoParaConfirmar: false,
  });
  const html = previewMensalHtml(data);
  test("classificação sugere Consolidar", () => {
    assert.equal(classificacaoView(data.acompanhamento).acao, "consolidar");
  });
  test("mostra Consolidar acompanhamento diário e não Confirmar fechamento direto", () => {
    assert.match(html, /id="bm-mensal-acao" data-acao="consolidar"/);
    assert.match(html, /Consolidar acompanhamento diário/);
    assert.doesNotMatch(html, /data-acao="confirmar"/);
    assert.match(html, /Esta competência possui acompanhamento diário completo/);
  });
  test("não renderiza a prévia de indicadores derivada do PDF neste caminho", () => {
    assert.doesNotMatch(html, /Indicadores que serão congelados/);
  });
});

describe("F7 · 8 — consolidar chama o endpoint certo", () => {
  test("api.js: bonifFechamentoMensalConsolidar → POST /fechamento-mensal/consolidar", () => {
    assert.match(API_SRC, /bonifFechamentoMensalConsolidar\s*=\s*\(\{ ano, mes \}\)\s*=>\s*postJson\(`\$\{BM\}\/fechamento-mensal\/consolidar`/);
  });
  test("o modal despacha a ação do botão da prévia", () => {
    assert.match(MODAL_SRC, /processarMensal\(m, ctx, acaoBtn\.dataset\.acao\)/);
    assert.match(MODAL_SRC, /bonifFechamentoMensalConsolidar\(\{ ano, mes \}\)/);
  });
});

describe("F7 · 9 — competência fechada bloqueia ações", () => {
  const html = mensalPaneHtml({ mesAtual: 6, anoAtual: 2026, anos: [2026], fechada: true, origemFechada: "acompanhamento_diario" });
  test("mostra 'Competência fechada' e nenhum controle de fechamento", () => {
    assert.match(html, /Competência fechada/);
    assert.doesNotMatch(html, /id="bm-mensal-vendas-drop"/);
    assert.doesNotMatch(html, /id="bm-mensal-analisar"/);
    assert.doesNotMatch(html, /id="bm-mensal-acao"/);
  });
  test("o modal não liga eventos quando fechada e processarMensal aborta", () => {
    assert.match(MODAL_SRC, /if \(!ctx\.mensal\.fechada\) \{/);
    assert.match(MODAL_SRC, /if \(ctx\.mensal\.emAndamento \|\| ctx\.mensal\.fechada\) return;/);
  });
});

describe("F7 · 10 a 12 — sem segunda fonte, sem wording proibido", () => {
  const html = previewMensalHtml(previewBase({ validacao: { bloqueios: [], alertas: [{ tipo: "alerta", msg: "Confirme que o arquivo está filtrado para Loja/Balcão." }], conferencia: {} } }));
  test("alertas técnicos aparecem só como Conferência de importação", () => {
    assert.match(html, /Conferência de importação/);
    assert.match(html, /pill warn">conferir<\/span> Confirme que o arquivo/);
  });
  const todos = html + paneAberto() + MODAL_SRC + PURO_SRC;
  test("nenhuma tabela 'Oficial × Soma diária'", () => {
    assert.doesNotMatch(todos, /Oficial\s*[×x]\s*Soma di[aá]ria/i);
    assert.doesNotMatch(todos, /Soma di[aá]ria\s*[×x]\s*Mensal/i);
  });
  test("nenhum wording 'Visio x Central' / 'valor oficial x calculado'", () => {
    assert.doesNotMatch(todos, /Visio\s*[×x]\s*Central/i);
    assert.doesNotMatch(todos, /valor oficial\s*[×x]\s*calculado/i);
    assert.doesNotMatch(todos, /sobrescrever o m[eê]s/i);
  });
});

describe("F7 · 13 a 15 — loading, erros e sucesso", () => {
  test("13 — loading trava reentrada (emAndamento)", () => {
    assert.match(MODAL_SRC, /ctx\.mensal\.emAndamento = true;/);
    assert.match(MODAL_SRC, /if \(ctx\.mensal\.emAndamento \|\| ctx\.mensal\.fechada\) return;/);
    assert.match(MODAL_SRC, /ctx\.mensal\.emAndamento = false;/);
  });
  test("14 — erro do backend é renderizado na área de mensagem", () => {
    assert.match(MODAL_SRC, /catch \(e\) \{\s*setMsg\("Erro: " \+ e\.message\);/);
  });
  test("15 — sucesso fecha o modal e dispara onSalvo", () => {
    assert.match(MODAL_SRC, /toast\("Fechamento mensal salvo/);
    assert.match(MODAL_SRC, /toast\("Acompanhamento diário consolidado/);
    assert.match(MODAL_SRC, /fecharOverlay\(\);\s*\n\s*ctx\.onSalvo\?\.\(/);
  });
});
