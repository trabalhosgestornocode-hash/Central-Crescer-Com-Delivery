// F3 — camada PURA do Fechamento Mensal Visio (bonificacaoMensal.fechamento.js).
// Sem rede. Cobre: montarResultadoCompetencia (motor compartilhado),
// montarResultadoFechamentoOficial (resultado canônico — NÃO chama obterMes),
// validarFechamentoMensal (bloqueios × alertas), roteamentoObterMes.
//
// Rodar: node --test test/bonificacao-mensal-fechamento.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  montarResultadoCompetencia, montarResultadoFechamentoOficial, validarFechamentoMensal,
  roteamentoObterMes, fechamentoStatusAoVivo, INDICADORES_META, FONTE_INDICADOR_FECHAMENTO,
} from "../src/modules/bonificacao-mensal/bonificacaoMensal.fechamento.js";

const perto = (a, b, eps = 1e-3) => a != null && Math.abs(a - b) <= eps;

// Metas mínimas para os testes (só o que precisa ter faixa).
const metaBebidas = { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 43, valorMax: null, bonus: 25 }] };
const metasVigentes = {
  bebidas: metaBebidas,
  adicionais: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 24, valorMax: null, bonus: 25 }] },
  diversos: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 20, valorMax: null, bonus: 25 }] },
  faturamento: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 100000, valorMax: null, bonus: 100 }] },
  ticket_medio: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 45, valorMax: null, bonus: 50 }] },
  avaliacao_ifood: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 4.7, valorMax: null, bonus: null }] },
  rev: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 80, valorMax: null, bonus: null }] },
  pesquisas: { direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 60, valorMax: null, bonus: null }] },
};

// dataset de referência do diagnóstico (Subway Saci — Matriz, agosto/2026)
const PRODUTOS_REF = {
  qtdSanduiches: 2533, qtdBebidas: 1086, qtdAdicionais: 613, qtdDiversos: 508,
  ppd: 57, torque: 53.33, perdas: 0, fatSanduiches: 41000, pctFatSanduiches: 62.4, totalItens: 12761,
  produtosFuncionais: 0, faturamentoLoja: 41000, estabelecimento: "Subway Teresina Saci",
  percentualBebidasPdf: 42.9, percentualAdicionaisPdf: 24.2, percentualDiversosPdf: 20.1,
  hash: "hp", origem: "visio",
};
const VENDAS_REF = {
  tipo: "vendas", faturamento: 109613.74, ticketMedio: 52.47, cuponsValidos: 2089, cuponsVendas: 2089,
  estabelecimento: "Subway Teresina Saci", metodosPagamento: [{ metodo: "IFOOD ONLINE", qtd: 147, valor: 6649.45 }],
  hash: "hv", origem: "visio",
};
const CTX = {
  unidade: { id: "u1", nome: "Subway Saci — Matriz", organizacaoId: "o1" },
  ano: 2026, mes: 8, canalConfirmado: true, periodoConfirmado: true,
};

// ===========================================================================
describe("montarResultadoCompetencia — motor compartilhado", () => {
  test("monta indicadores + resumo + elegibilidade a partir dos valores crus", () => {
    const r = montarResultadoCompetencia({
      valores: { bebidas: 42.87, adicionais: 24.2, diversos: 20.06, faturamento: 109613, ticket_medio: 52, avaliacao_ifood: 4.8, rev: 90, pesquisas: 70 },
      metasVigentes, mesFechado: true,
    });
    assert.equal(Object.keys(r.indicadores).length, INDICADORES_META.length);
    assert.equal(r.indicadores.bebidas.valorAtual, 42.87);
    assert.equal(r.indicadores.bebidas.status, "meta_nao_atingida"); // 42.87 < 43
    assert.equal(r.elegibilidade.status, "elegivel"); // nota 4.8 / rev 90 / pesquisas 70 ok
    assert.ok(r.resumo.bonificacaoMaxima > 0);
    assert.equal(typeof r.resumo.bonificacaoAtual, "number");
  });

  test("inelegível (Nota iFood abaixo) zera a bonificação PAGÁVEL, preserva a BRUTA", () => {
    const r = montarResultadoCompetencia({
      valores: { bebidas: 50, adicionais: 30, diversos: 25, avaliacao_ifood: 4.0, rev: 90, pesquisas: 70 },
      metasVigentes, mesFechado: true,
    });
    assert.equal(r.elegibilidade.status, "nao_elegivel");
    assert.equal(r.resumo.bonificacaoAtual, 0);
    assert.ok(r.resumo.bonificacaoBruta > 0);
  });

  test("valor null nunca vira 0 (sem_dados, não meta_nao_atingida)", () => {
    const r = montarResultadoCompetencia({ valores: { bebidas: null }, metasVigentes, mesFechado: false });
    assert.equal(r.indicadores.bebidas.status, "sem_dados");
  });
});

// ===========================================================================
describe("montarResultadoFechamentoOficial — resultado canônico (NÃO chama obterMes)", () => {
  test("dataset 2533/1086/613/508 → 42,9 / 24,2 / 20,1", () => {
    const r = montarResultadoFechamentoOficial({ vendas: VENDAS_REF, produtos: PRODUTOS_REF, manuais: {}, metasVigentes, contexto: CTX });
    assert.equal(r.indicadores.bebidas.valorAtual.toFixed(1), "42.9");
    assert.equal(r.indicadores.adicionais.valorAtual.toFixed(1), "24.2");
    assert.equal(r.indicadores.diversos.valorAtual.toFixed(1), "20.1");
    // um percentual canônico por indicador (a regra)
    assert.ok(perto(r.valoresOficiais.percentuais.bebidas, 42.8741));
    assert.ok(perto(r.valoresOficiais.percentuais.adicionais, 24.1998));
    assert.ok(perto(r.valoresOficiais.percentuais.diversos, 20.0553));
    // NADA de percentual concorrente no resultado persistido
    assert.ok(!("percentuaisPdf" in r.valoresOficiais));
    assert.ok(!("percentuaisCalculados" in r.valoresOficiais));
  });

  test("o % impresso no PDF fica só em metadados.conferenciaImportacao (dado técnico, não indicador)", () => {
    const r = montarResultadoFechamentoOficial({
      vendas: VENDAS_REF,
      produtos: { ...PRODUTOS_REF, percentualBebidasPdf: 50 }, // impresso diverge da regra
      manuais: {}, metasVigentes, contexto: CTX,
    });
    const c = r.metadados.conferenciaImportacao;
    assert.equal(c.percentuaisImpressosNoPdf.bebidas, 50);
    assert.ok(perto(c.divergenciaPercentualPP.bebidas, 50 - r.valoresOficiais.percentuais.bebidas, 0.05));
    // o indicador continua vindo da regra, não do % impresso
    assert.equal(r.indicadores.bebidas.valorAtual.toFixed(1), "42.9");
  });

  test("faturamento e ticket vêm DO RELATÓRIO DE VENDAS mensal (não recalculados)", () => {
    const r = montarResultadoFechamentoOficial({ vendas: VENDAS_REF, produtos: PRODUTOS_REF, manuais: {}, metasVigentes, contexto: CTX });
    assert.equal(r.indicadores.faturamento.valorAtual, 109613.74);
    assert.equal(r.indicadores.ticket_medio.valorAtual, 52.47);
    assert.equal(r.valoresOficiais.faturamento, 109613.74);
    assert.equal(r.valoresOficiais.ticketMedio, 52.47);
    assert.equal(r.valoresOficiais.quantidadeVendas, 2089);
    assert.equal(r.indicadores.faturamento.fonte, "fechamento_visio");
    assert.equal(r.indicadores.ticket_medio.fonte, "fechamento_visio");
  });

  test("bebidas/adicionais/diversos são 'fechamento_visio'; cmv/nota/rev/pesquisas são 'manual'", () => {
    const r = montarResultadoFechamentoOficial({
      vendas: VENDAS_REF, produtos: PRODUTOS_REF,
      manuais: { cmv: 31.5, avaliacaoIfood: 4.8, cancelamentos: 0.5, pedidosChamado: 1.2, pesquisas: 70, rev: 88 },
      metasVigentes, contexto: CTX,
    });
    for (const k of ["bebidas", "adicionais", "diversos"]) assert.equal(r.indicadores[k].fonte, "fechamento_visio");
    for (const k of ["cmv", "avaliacao_ifood", "rev", "pesquisas", "cancelamentos", "pedidos_chamado"]) assert.equal(r.indicadores[k].fonte, "manual");
    // valores manuais preservam a fonte atual (nada migrou de regra)
    assert.equal(r.indicadores.cmv.valorAtual, 31.5);
    assert.equal(r.indicadores.rev.valorAtual, 88);
    assert.equal(r.indicadores.pesquisas.valorAtual, 70);
    assert.equal(FONTE_INDICADOR_FECHAMENTO.cmv, "manual");
  });

  test("PPD/Torque/Perdas/totalItens/métodos de pagamento vão no resultado — SEM virar meta", () => {
    const r = montarResultadoFechamentoOficial({ vendas: VENDAS_REF, produtos: PRODUTOS_REF, manuais: {}, metasVigentes, contexto: CTX });
    assert.equal(r.valoresOficiais.ppd, 57);
    assert.equal(r.valoresOficiais.torque, 53.33);
    assert.equal(r.valoresOficiais.perdas, 0);
    assert.equal(r.valoresOficiais.totalItens, 12761);
    assert.deepEqual(r.valoresOficiais.metodosPagamento, [{ metodo: "IFOOD ONLINE", qtd: 147, valor: 6649.45 }]);
    assert.ok(!("ppd" in r.indicadores));
    assert.ok(!("torque" in r.indicadores));
  });

  test("formato canônico do snapshot (v3.1 §5.4) — sem lifecycle de versão", () => {
    const r = montarResultadoFechamentoOficial({ vendas: VENDAS_REF, produtos: PRODUTOS_REF, manuais: {}, metasVigentes, contexto: CTX });
    assert.equal(r.escopoBonificacao, "unidade");
    assert.deepEqual(r.unidade, CTX.unidade);
    assert.deepEqual(r.competencia, { ano: 2026, mes: 8 });
    assert.equal(r.origem, "fechamento_visio");
    assert.equal(r.fonte.produtos.canalConfirmadoPeloUsuario, true);
    assert.equal(r.fonte.periodoConfirmadoPeloUsuario, true);
    assert.equal(r.fonte.vendas.hash, "hv");
    assert.equal(typeof r.bonificacao.bruta, "number");
    assert.equal(typeof r.bonificacao.definitiva, "number");
    assert.deepEqual(r.metadados.reaberturas, []);
    assert.equal(r.versao ?? null, null); // versão é responsabilidade da F4
    assert.ok(!JSON.stringify(r).includes("substituido_em"));
    // fonte única: um percentual do mix no resultado; conferência técnica isolada
    assert.ok("percentuais" in r.valoresOficiais);
    assert.ok(!JSON.stringify(r.valoresOficiais).includes("percentuaisPdf"));
    assert.ok(!JSON.stringify(r.valoresOficiais).includes("percentuaisCalculados"));
    assert.ok("conferenciaImportacao" in r.metadados);
    assert.ok(!("crossChecks" in r.metadados)); // migrou para dentro de conferenciaImportacao
  });

  test("NÃO chama obterMes nem importa service/supabase — a função é 100% pura", async () => {
    const src = (await import("node:fs")).readFileSync(
      (await import("node:url")).fileURLToPath(new URL("../src/modules/bonificacao-mensal/bonificacaoMensal.fechamento.js", import.meta.url)), "utf8");
    // sem comentários `//` — o texto "obterMes" aparece de propósito nos comentários (invariante documentada)
    const codigo = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    assert.doesNotMatch(codigo, /\bobterMes\s*\(/);              // nenhuma CHAMADA a obterMes
    assert.doesNotMatch(codigo, /bonificacaoMensal\.service/);   // não importa o service
    assert.doesNotMatch(codigo, /["'][^"']*supabase[^"']*["']/); // não importa supabase
    assert.doesNotMatch(codigo, /\bawait\b/);                    // sem I/O assíncrono
  });
});

// ===========================================================================
describe("validarFechamentoMensal — bloqueios × alertas", () => {
  const okArgs = {
    vendas: VENDAS_REF, produtos: { ...PRODUTOS_REF, faturamentoLoja: 41000 },
    unidadeNome: "Subway Saci — Matriz", somaDiaria: null, competenciaExistente: null,
    produtosCanalConfirmado: true, periodoConfirmadoUsuario: true,
  };

  test("2 PDFs válidos + checkboxes → sem bloqueios", () => {
    const { bloqueios } = validarFechamentoMensal(okArgs);
    assert.deepEqual(bloqueios, []);
  });

  test("falta um PDF → bloqueio", () => {
    assert.match(validarFechamentoMensal({ ...okArgs, vendas: null }).bloqueios.join(" "), /Relatório de Vendas/);
    assert.match(validarFechamentoMensal({ ...okArgs, produtos: null }).bloqueios.join(" "), /Relatório de Produtos/);
  });

  test("estabelecimento incompatível com a unidade → bloqueio", () => {
    const r = validarFechamentoMensal({ ...okArgs, produtos: { ...okArgs.produtos, estabelecimento: "Subway Outro Lugar" } });
    assert.match(r.bloqueios.join(" "), /Relatório de Produtos pertence a outra unidade/);
  });

  test("estabelecimentos divergentes entre os dois PDFs → bloqueio", () => {
    const r = validarFechamentoMensal({
      ...okArgs,
      vendas: { ...VENDAS_REF, estabelecimento: "Subway Teresina Saci" },
      produtos: { ...okArgs.produtos, estabelecimento: "Subway Parnaiba Norte" },
      unidadeNome: "Subway",
    });
    assert.match(r.bloqueios.join(" "), /estabelecimentos diferentes/);
  });

  test("quantidade inválida (fracionária) → bloqueio", () => {
    const r = validarFechamentoMensal({ ...okArgs, produtos: { ...okArgs.produtos, qtdBebidas: 12.5 } });
    assert.match(r.bloqueios.join(" "), /Quantidade inválida de Bebidas/);
  });

  test("checkbox de canal ausente → bloqueio de confirmação", () => {
    assert.match(validarFechamentoMensal({ ...okArgs, produtosCanalConfirmado: false }).bloqueios.join(" "), /filtro Loja\/Balcão/);
  });
  test("checkbox de competência ausente → bloqueio de confirmação", () => {
    assert.match(validarFechamentoMensal({ ...okArgs, periodoConfirmadoUsuario: false }).bloqueios.join(" "), /competência selecionada/);
  });

  test("competência já fechada sem reabertura → bloqueio", () => {
    assert.match(validarFechamentoMensal({ ...okArgs, competenciaExistente: { status: "fechada" } }).bloqueios.join(" "), /já está fechada/);
  });
  test("competência reaberta → NÃO bloqueia (pode re-confirmar)", () => {
    assert.deepEqual(validarFechamentoMensal({ ...okArgs, competenciaExistente: { status: "reaberta" } }).bloqueios, []);
  });

  test("ALERTA: produtos.faturamento >= 90% do vendas.faturamento (provável Geral, não Loja)", () => {
    const r = validarFechamentoMensal({ ...okArgs, produtos: { ...okArgs.produtos, faturamentoLoja: 105000 } }); // 105k / 109.6k = 95.8%
    assert.deepEqual(r.bloqueios, []);                     // NÃO bloqueia
    assert.ok(r.alertas.some((a) => a.tipo === "critico"));
    assert.match(r.alertas.map((a) => a.msg).join(" "), /filtro Loja\/Balcão/i);
  });
  test("ALERTA: produtos.faturamento entre 60% e 90%", () => {
    const r = validarFechamentoMensal({ ...okArgs, produtos: { ...okArgs.produtos, faturamentoLoja: 80000 } }); // 73%
    assert.deepEqual(r.bloqueios, []);
    assert.ok(r.alertas.some((a) => a.tipo === "alerta" && /filtrad[oa] para Loja\/Balcão/i.test(a.msg)));
  });
  test("ALERTA: quantidade do arquivo não acompanha o registrado (>10% de desvio) — nunca bloqueia", () => {
    const r = validarFechamentoMensal({
      ...okArgs,
      somaDiaria: { sanduiches: 2000, bebidas: 900, adicionais: 500, diversos: 400, faturamentoLoja: 30000 },
    });
    assert.deepEqual(r.bloqueios, []);
    assert.ok(r.alertas.some((a) => /não acompanha os lançamentos já registrados/i.test(a.msg)));
    assert.ok(r.crossChecks.principaisVsRegistrado > 0.10);
    // sem "duas verdades" no texto do alerta
    assert.ok(!r.alertas.some((a) => /soma dos (relatórios )?diários|Central|sistema calculou/i.test(a.msg)));
  });
  test("ALERTA: % impresso no PDF não bate com as quantidades do próprio relatório (> 1,5 p.p.)", () => {
    const r = validarFechamentoMensal({ ...okArgs, produtos: { ...okArgs.produtos, percentualBebidasPdf: 50 } }); // recalc ~42.9
    assert.deepEqual(r.bloqueios, []);
    assert.ok(r.alertas.some((a) => /percentual impresso de Bebidas.*não corresponde às quantidades do próprio relatório/i.test(a.msg)));
    assert.ok(!r.alertas.some((a) => /a Visio informou.*o sistema recalculou/i.test(a.msg)));
  });
  test("nenhum alerta muda o cálculo — validarFechamentoMensal só devolve strings", () => {
    const r = validarFechamentoMensal({ ...okArgs, produtos: { ...okArgs.produtos, faturamentoLoja: 105000 } });
    assert.ok(Array.isArray(r.alertas) && r.alertas.every((a) => typeof a.msg === "string"));
  });
});

// ===========================================================================
describe("roteamentoObterMes — state machine (v3.1 §4)", () => {
  test("fechada / legado_sem_fechamento → 'snapshot'", () => {
    assert.equal(roteamentoObterMes({ status: "fechada" }), "snapshot");
    assert.equal(roteamentoObterMes({ status: "legado_sem_fechamento" }), "snapshot");
  });
  test("aberta / reaberta / null → 'ao_vivo'", () => {
    assert.equal(roteamentoObterMes({ status: "aberta" }), "ao_vivo");
    assert.equal(roteamentoObterMes({ status: "reaberta" }), "ao_vivo");
    assert.equal(roteamentoObterMes(null), "ao_vivo");
    assert.equal(roteamentoObterMes(undefined), "ao_vivo");
  });
  test("fechamentoStatusAoVivo", () => {
    assert.equal(fechamentoStatusAoVivo({ status: "reaberta" }, true), "reaberto");
    assert.equal(fechamentoStatusAoVivo({ status: "aberta" }, true), "aguardando_fechamento");
    assert.equal(fechamentoStatusAoVivo(null, false), "aberto");
  });
});
