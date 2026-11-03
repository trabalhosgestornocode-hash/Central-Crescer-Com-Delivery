// Dashboard Operacional 2.0 — diagnóstico (motor determinístico + camada de IA verificada) e mensagem de WhatsApp SIMULADA.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gerarDiagnostico, ACOES, LIMIARES_DIAGNOSTICO } from "../src/modules/checklist-operacional/checklistOperacional.diagnostico.js";
import { redigirDiagnostico, verificarRedacao, numerosDo } from "../src/modules/checklist-operacional/checklistOperacional.redacao.js";
import { gerarMensagem, validarMensagem, criarTransporte, transporteNoop, chaveSimulacao, LIMITE_CARACTERES } from "../src/modules/checklist-operacional/checklistOperacional.whatsapp.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** Fechamento mínimo (só o que o diagnóstico e a mensagem leem). */
function fechamento(sobre = {}) {
  const tempo = (nome, media, meta, amostras = 20) => ({ nome, estado: media == null ? "indisponivel" : "calculado", media, meta, amostras, metaVersao: 1, desvioDaMetaMin: media == null || meta == null ? null : Math.round((media - meta) * 10) / 10 });
  const base = {
    status: "CONSOLIDADO", pendencias: [], competencia: "2026-10-27", versao: 1,
    indicadores: {
      pedidos: { recebidos: 40, concluidosNoDia: 36, canceladosNoDia: 4, coorte: { recebidos: 40, concluidos: 36, cancelados: 4, emAberto: 0 } },
      preparo: tempo("Preparo", 24, 20), entrega: tempo("Entrega", 12, 15), vida: tempo("Vida do pedido", 36, 35),
      atrasos: { pedidosAtrasados: 14, pedidosAvaliados: 30, pct: 46.7, principalEtapa: { nome: "Preparo", atrasos: 12 }, causaAtribuida: false },
      cancelamentos: { total: 4, taxaDaCoortePct: 10, motivos: [{ codigo: "502", descricao: "O pedido está duplicado", quantidade: 3 }, { codigo: "411", descricao: "O pedido está atrasado", quantidade: 1 }] },
      movimento: { picos: [{ hora: 19, pedidos: 10, atrasados: 7 }, { hora: 12, pedidos: 8, atrasados: 1 }] },
      disputas: { abertasNoDia: 2, expiradasNoDia: 1, pendentesAgora: 0, venceEmAte10Min: 0 },
      descontos: { pedidosNaBase: 36, loja: 310.5, pedidosComDescontoLoja: 9, pctLojaSobreItens: 21.4 },
      clientes: { base: 40, novos: 12, recorrentes: 27, semInformacao: 1 },
      comparacao: { pctPedidosAtrasados: { atual: 46.7, anterior: 20, diferencaPP: 26.7 }, recebidosAnterior: 30, canceladosAnterior: 1 },
    },
  };
  return { ...base, ...sobre, indicadores: { ...base.indicadores, ...(sobre.indicadores ?? {}) } };
}

describe("diagnóstico determinístico", () => {
  test("dispara as regras com fato numérico, referência, amostra e ação da biblioteca", () => {
    const d = gerarDiagnostico(fechamento());
    const codigos = d.achados.map((a) => a.codigo);
    for (const c of ["PREPARO_ACIMA_META", "VIDA_ACIMA_META", "ATRASOS_ELEVADOS", "CONCENTRACAO_HORARIO", "CANCELAMENTO_ELEVADO", "CANCELAMENTO_EM_ALTA", "QUEDA_EFICIENCIA", "DISPUTAS_EXPIRADAS", "DESCONTO_LOJA_ELEVADO"]) assert.ok(codigos.includes(c), c);
    assert.equal(codigos.includes("ENTREGA_ACIMA_META"), false, "entrega abaixo da meta");
    for (const a of d.achados) {
      assert.ok(Object.values(ACOES).includes(a.acao), `ação fora da biblioteca: ${a.codigo}`);
      assert.doesNotMatch(`${a.titulo} ${a.fato}`, /porque|devido|culpa|causad|responsável pel/i);
      assert.ok(a.referencia && a.amostra != null && a.confianca);
    }
    assert.equal(d.principal.severidade, "alta");
  });

  test("amostra insuficiente: a regra não dispara e diz por quê", () => {
    const f = fechamento({ indicadores: { atrasos: { pedidosAtrasados: 2, pedidosAvaliados: 4, pct: 50, principalEtapa: null }, preparo: { nome: "Preparo", estado: "calculado", media: 30, meta: 20, amostras: 3 } } });
    const d = gerarDiagnostico(f);
    assert.equal(d.achados.some((a) => a.codigo === "ATRASOS_ELEVADOS"), false);
    assert.equal(d.achados.some((a) => a.codigo === "PREPARO_ACIMA_META"), false);
    assert.ok(d.naoAvaliadas.some((n) => /mínimo/.test(n)));
  });

  test("sem desvio: mensagem informativa, sem conclusão causal", () => {
    const tranquilo = fechamento({ indicadores: {
      preparo: { nome: "Preparo", estado: "calculado", media: 15, meta: 20, amostras: 20 }, vida: { nome: "Vida do pedido", estado: "calculado", media: 30, meta: 35, amostras: 20 },
      atrasos: { pedidosAtrasados: 1, pedidosAvaliados: 20, pct: 5, principalEtapa: null }, cancelamentos: { total: 0, taxaDaCoortePct: 0, motivos: [] },
      movimento: { picos: [{ hora: 12, pedidos: 10, atrasados: 0 }] }, disputas: { abertasNoDia: 0, expiradasNoDia: 0, pendentesAgora: 0 },
      descontos: { pedidosNaBase: 20, loja: 10, pedidosComDescontoLoja: 1, pctLojaSobreItens: 1 },
      comparacao: { pctPedidosAtrasados: { atual: 5, anterior: 6, diferencaPP: -1 }, recebidosAnterior: 20, canceladosAnterior: 0 },
      pedidos: { recebidos: 20, concluidosNoDia: 20, canceladosNoDia: 0, coorte: { recebidos: 20, concluidos: 20, cancelados: 0, emAberto: 0 } },
    } });
    const d = gerarDiagnostico(tranquilo);
    assert.equal(d.informativo, true);
    assert.equal(d.principal.codigo, "SEM_DESVIO");
  });

  test("limiares documentados e congelados", () => { assert.ok(Object.isFrozen(LIMIARES_DIAGNOSTICO)); assert.ok(Object.isFrozen(ACOES)); });
});

describe("camada de IA — só redige o que foi comprovado", () => {
  const diag = gerarDiagnostico(fechamento());
  const ok = (saida) => async () => ({ model: "m", usage: {}, content: [{ type: "text", text: JSON.stringify(saida) }] });
  const quotaOk = async () => ({ resultado: "ok" });
  const env = { OPERACIONAL_DIAGNOSTICO_IA_ENABLED: "true" };

  test("desligada por padrão → texto determinístico", async () => {
    const r = await redigirDiagnostico({ diag, organizacaoId: "o", unidadeId: "u" }, { env: {} });
    assert.equal(r.origem, "deterministico");
    assert.equal(r.motivoFallback, "ia_desligada");
  });

  test("saída válida (números e ação dos achados) é aceita", async () => {
    const r = await redigirDiagnostico({ diag, organizacaoId: "o", unidadeId: "u" }, { env, reservarQuota: quotaOk, enviarMensagem: ok({ diagnostico: "O preparo médio ficou em 24 min, acima da meta de 20 min.", acao: diag.principal.acao }) });
    assert.equal(r.origem, "ia");
  });

  test("número inventado, causa atribuída ou ação fora da biblioteca → fallback determinístico", async () => {
    for (const saida of [
      { diagnostico: "Preparo de 27 min, 35% pior.", acao: diag.principal.acao },
      { diagnostico: "O preparo atrasou porque a cozinha estava desfalcada.", acao: diag.principal.acao },
      { diagnostico: "Preparo acima da meta.", acao: "Demitir o cozinheiro." },
    ]) {
      const r = await redigirDiagnostico({ diag, organizacaoId: "o", unidadeId: "u" }, { env, reservarQuota: quotaOk, enviarMensagem: ok(saida) });
      assert.equal(r.origem, "deterministico", JSON.stringify(saida));
      assert.equal(r.motivoFallback, "ia_reprovada_na_verificacao");
    }
  });

  test("cota excedida, falha de infra, erro do provider e resposta inválida → fallback (nunca derruba o fechamento)", async () => {
    const base = { diag, organizacaoId: "o", unidadeId: "u" };
    assert.equal((await redigirDiagnostico(base, { env, reservarQuota: async () => ({ resultado: "excedido" }), enviarMensagem: ok({}) })).motivoFallback, "cota_excedido");
    assert.equal((await redigirDiagnostico(base, { env, reservarQuota: async () => { throw new Error("db"); }, enviarMensagem: ok({}) })).motivoFallback, "cota_falha_infra");
    assert.equal((await redigirDiagnostico(base, { env, reservarQuota: quotaOk, enviarMensagem: async () => { throw new Error("503"); } })).motivoFallback, "ia_erro");
    assert.equal((await redigirDiagnostico(base, { env, reservarQuota: quotaOk, enviarMensagem: async () => ({ content: [{ type: "text", text: "não é json" }] }) })).motivoFallback, "ia_resposta_invalida");
  });

  test("cota reservada por ORGANIZAÇÃO com a reserva atômica do Agente", async () => {
    let pedido;
    await redigirDiagnostico({ diag, organizacaoId: "org-1", unidadeId: "u" }, { env, reservarQuota: async (r) => { pedido = r; return { resultado: "excedido" }; }, enviarMensagem: ok({}) });
    assert.deepEqual(pedido.map((x) => [x.escopo, x.chave]), [["org", "operacional-fechamento:org-1"]]);
  });

  test("verificador de números entende formato brasileiro", () => {
    assert.deepEqual([...numerosDo("R$ 1.234,56 e 46,7% e 19h")].sort(), ["1234.56", "19", "46.7"]);
    assert.equal(verificarRedacao({ diagnostico: "14 de 30 pedidos (46,7%) atrasados.", acao: diag.principal.acao }, diag).ok, true);
  });
});

describe("mensagem de WhatsApp (simulação)", () => {
  const f = { ...fechamento(), diagnostico: { principal: { fato: "Preparo médio de 24 min contra meta de 20 min.", acao: ACOES.PREPARO_ACIMA_META } } };

  test("estrutura completa, situação, sem métrica inventada e dentro do limite", () => {
    const m = gerarMensagem({ fechamento: f, unidadeNome: "Unidade X" });
    for (const s of ["*CRESCER COM DELIVERY*", "*RELATÓRIO OPERACIONAL DIÁRIO*", "*Unidade X*", "27/10/2026 | Fechamento consolidado", "*RESUMO DO DIA*", "*DESEMPENHO OPERACIONAL*", "*MOVIMENTO*", "*CLIENTES*", "*INDICADORES FINANCEIROS*", "*CHAMADOS*", "*PONTOS DE ATENÇÃO*", "*RECOMENDAÇÃO*", "_Crescer com Delivery | Inteligência operacional_"]) assert.ok(m.includes(s), s);
    assert.ok(m.includes("• Tempo médio de preparo: 24 min (meta 20 min)"));
    assert.ok(m.includes("• Tempo médio de entrega: 12 min (meta 15 min)"));
    assert.ok(m.includes("• Pedidos acima da meta: 14 de 30 (46,7%)"));
    assert.ok(m.includes("• Maior pico: 19h às 20h — 10 pedidos"));
    assert.ok(m.includes("• Cancelamentos: 4 (O pedido está duplicado: 3; O pedido está atrasado: 1)"));
    assert.ok(m.includes("• Abertos no dia: 2\n• Com prazo expirado: 1"));
    assert.ok(m.includes("• Descontos financiados pela loja: R$ 310,50\n• Pedidos com desconto: 9"));
    assert.ok(m.includes("• Novos: 12\n• Recorrentes: 27\n• Sem informação: 1"));
    assert.ok(m.length <= LIMITE_CARACTERES);
    assert.equal(validarMensagem(m, { fechamento: f }).ok, true);
  });

  test("modelo aprovado: dados do relatório real reproduzem o layout linha a linha", () => {
    const t = (media) => ({ estado: "calculado", media, meta: null, amostras: 70 });
    const real = { status: "CONSOLIDADO", competencia: "2026-11-01", versao: 1, indicadores: {
      pedidos: { recebidos: 78, concluidosNoDia: 78, canceladosNoDia: 0 }, preparo: t(36.1), entrega: t(17.5), vida: t(53.5),
      atrasos: { pedidosAvaliados: 0, pedidosAtrasados: 0, pct: null }, cancelamentos: { total: 0, motivos: [] },
      movimento: { picos: [{ hora: 20, pedidos: 14 }, { hora: 19, pedidos: 13 }] },
      disputas: { abertasNoDia: 1, expiradasNoDia: 1, pendentesAgora: 0 }, descontos: { pedidosNaBase: 78, loja: 531.87, pedidosComDescontoLoja: 73 },
      clientes: { base: 78, novos: 30, recorrentes: 48, semInformacao: 0 } },
      diagnostico: { achados: [{ codigo: "DISPUTAS_EXPIRADAS", titulo: "Disputas expiradas sem resposta" }], principal: { codigo: "DISPUTAS_EXPIRADAS", acao: ACOES.DISPUTAS_EXPIRADAS } } };
    assert.equal(gerarMensagem({ fechamento: real, unidadeNome: "Subway North Shopping" }), [
      "*CRESCER COM DELIVERY*", "*RELATÓRIO OPERACIONAL DIÁRIO*", "", "*Subway North Shopping*", "01/11/2026 | Fechamento consolidado", "",
      "*RESUMO DO DIA*", "• Pedidos recebidos: 78", "• Pedidos concluídos: 78", "• Cancelamentos: 0", "",
      "*DESEMPENHO OPERACIONAL*", "• Tempo médio de preparo: 36,1 min", "• Tempo médio de entrega: 17,5 min", "• Tempo total do pedido: 53,5 min", "",
      "*MOVIMENTO*", "• Maior pico: 20h às 21h — 14 pedidos", "• Segundo pico: 19h às 20h — 13 pedidos", "",
      "*CLIENTES*", "• Novos: 30", "• Recorrentes: 48", "",
      "*INDICADORES FINANCEIROS*", "• Descontos financiados pela loja: R$ 531,87", "• Pedidos com desconto: 73", "",
      "*CHAMADOS*", "• Abertos no dia: 1", "• Com prazo expirado: 1", "",
      "*PONTOS DE ATENÇÃO*", "• Um chamado atingiu o prazo de expiração.", "• Metas de tempo não configuradas.", "",
      "*RECOMENDAÇÃO*", "Reforce o acompanhamento da Plataforma de Negociação do iFood, especialmente nos horários de maior movimento, para evitar chamados com prazo expirado.", "",
      "_Crescer com Delivery | Inteligência operacional_",
    ].join("\n"));
  });

  test("CHAMADOS no lugar do termo interno; expiração não vira 'sem resposta'", () => {
    const diag = gerarDiagnostico(f);
    const m = gerarMensagem({ fechamento: { ...f, diagnostico: { ...diag, texto: { acao: "Responder as disputas abertas." } } } });
    assert.doesNotMatch(m, /disput/i);
    assert.doesNotMatch(m, /sem resposta/i);
    assert.ok(m.includes("• Um chamado atingiu o prazo de expiração."));
    const pend = gerarMensagem({ fechamento: { ...f, indicadores: { ...f.indicadores, disputas: { abertasNoDia: 3, expiradasNoDia: 2, pendentesAgora: 2 } }, diagnostico: { principal: { codigo: "DISPUTAS_PENDENTES", acao: ACOES.DISPUTAS_PENDENTES } } } });
    assert.ok(pend.includes("• 2 chamados aguardam resposta dentro do prazo.") && pend.includes("• 2 chamados atingiram o prazo de expiração."));
    assert.ok(pend.includes("Responda os chamados abertos no Gestor de Pedidos do iFood antes do vencimento do prazo."));
    assert.ok(validarMensagem("Disputas abertas: 1", {}).problemas.some((p) => p.codigo === "TERMO_INTERNO"));
  });

  test("metas não configuradas viram ponto de atenção; sem desvio é dito explicitamente", () => {
    const semMeta = (n) => ({ nome: n, estado: "calculado", media: 30, meta: null, amostras: 10 });
    const ind = { ...f.indicadores, preparo: semMeta("Preparo"), entrega: semMeta("Entrega"), vida: semMeta("Vida"), atrasos: { pedidosAvaliados: 0, pedidosAtrasados: 0 }, disputas: { abertasNoDia: 0, expiradasNoDia: 0, pendentesAgora: 0 } };
    const m = gerarMensagem({ fechamento: { ...f, indicadores: ind, diagnostico: { principal: { codigo: "SEM_DESVIO", acao: ACOES.SEM_DESVIO } } } });
    assert.ok(m.includes("*PONTOS DE ATENÇÃO*\n• Metas de tempo não configuradas."));
    assert.ok(!m.includes("Pedidos acima da meta"));
    const ok = gerarMensagem({ fechamento: { ...f, indicadores: { ...f.indicadores, disputas: { abertasNoDia: 0, expiradasNoDia: 0 } }, diagnostico: { achados: [], principal: { acao: ACOES.SEM_DESVIO } } } });
    assert.ok(ok.includes("• Nenhum desvio relevante identificado com os dados disponíveis."));
  });

  test("pior caso (todos os achados, link e nome longo) cabe no limite e o nome não quebra o negrito", () => {
    const diag = gerarDiagnostico(f);
    const m = gerarMensagem({ fechamento: { ...f, diagnostico: diag, indicadores: { ...f.indicadores, disputas: { abertasNoDia: 9, expiradasNoDia: 9, pendentesAgora: 9 } } },
      unidadeNome: "Subway *North* Shopping _Unidade_ ".repeat(3), link: `https://app.exemplo.com/relatorio/${"x".repeat(60)}` });
    assert.ok(m.length <= LIMITE_CARACTERES, `tamanho ${m.length}`);
    assert.equal(validarMensagem(m, { fechamento: f }).ok, true);
    const linhaNome = m.split("\n")[3];
    assert.equal((linhaNome.match(/\*/g) ?? []).length, 2);
    assert.equal(linhaNome.includes("_"), false);
  });

  test("indicador indisponível aparece como 'não disponível' (nunca zero)", () => {
    const sem = { ...f, indicadores: { ...f.indicadores, entrega: { nome: "Entrega", estado: "indisponivel", media: null } } };
    assert.ok(gerarMensagem({ fechamento: sem }).includes("• Tempo médio de entrega: não disponível"));
  });

  test("situação PRELIMINAR / REVISADO / INCOMPLETO informada", () => {
    for (const status of ["PRELIMINAR", "REVISADO", "INCOMPLETO"]) assert.ok(gerarMensagem({ fechamento: { ...f, status } }).includes(status));
  });

  test("validação bloqueia telefone, e-mail, CPF, id interno, texto longo e falta de situação", () => {
    const base = gerarMensagem({ fechamento: f });
    for (const [extra, codigo] of [["11 98888-7777", "DADO_PROIBIDO_TELEFONE"], ["a@b.com", "DADO_PROIBIDO_EMAIL"], ["123.456.789-09", "DADO_PROIBIDO_CPF"], ["a0000000-0000-4000-8000-00000000000a", "DADO_PROIBIDO_ID_INTERNO"], ["x".repeat(LIMITE_CARACTERES), "LONGA_DEMAIS"]]) {
      assert.ok(validarMensagem(`${base}\n${extra}`, { fechamento: f }).problemas.some((p) => p.codigo === codigo), codigo);
    }
    assert.ok(validarMensagem("sem situação", { fechamento: f }).problemas.some((p) => p.codigo === "SEM_STATUS"));
  });

  test("transporte: só o noop existe; qualquer outro nome é recusado (inclusive o real)", async () => {
    assert.equal(criarTransporte(), transporteNoop);
    assert.deepEqual(await transporteNoop.enviar({ texto: "x" }), { simulado: true, entregue: false });
    for (const nome of ["baileys", "whatsapp", "gateway", "real", ""]) assert.throws(() => criarTransporte(nome), /recusado/);
  });

  test("chave de idempotência: mesmo fechamento + mesma mensagem = mesma chave", () => {
    assert.equal(chaveSimulacao("f1", "abc"), chaveSimulacao("f1", "abc"));
    assert.notEqual(chaveSimulacao("f1", "abc"), chaveSimulacao("f2", "abc"));
    assert.notEqual(chaveSimulacao("f1", "abc"), chaveSimulacao("f1", "abd"));
  });

  test("ARQUITETURA: nenhum arquivo do fechamento importa o provider, o WhatsAppService, o gateway ou o Baileys", () => {
    const dir = path.join(AQUI, "..", "src", "modules", "checklist-operacional");
    const proibidos = /whatsapp\.service|whatsapp\.provider|providers\/|baileys|gateway-whatsapp|comunicacao\//i;
    for (const arq of readdirSync(dir).filter((a) => a.endsWith(".js"))) {
      const fonte = readFileSync(path.join(dir, arq), "utf8");
      const imports = [...fonte.matchAll(/^\s*import[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const i of imports) assert.equal(proibidos.test(i), false, `${arq} importa ${i}`);
    }
  });
});
