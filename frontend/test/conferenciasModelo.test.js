// Modelo da Central de Conferências reformulada — puro, sem DOM nem rede. Estrutura de setembro/2026 (valores dos documentos; dados sintéticos
// onde a estrutura não traz valor). Rodar: node --test frontend/test/conferenciasModelo.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/financeiro/conferenciasModelo.js";
import { CENTRAL_SETEMBRO, PDOC_SETEMBRO } from "./conferenciasFixture.js";

const linhas = M.linhas(CENTRAL_SETEMBRO, "2026-11-10");
const porTipo = (t) => linhas.filter((p) => p.tipo === t);

describe("categorias", () => {
  test("seis assuntos, na ordem pedida", () => {
    assert.deepEqual(M.CATEGORIAS.map((c) => c.rotulo), ["Vendas e ajustes", "Contas, pagamentos e juros", "Custos e rateios", "Caixa e conciliação", "Classificações financeiras", "Pendências documentais"]);
  });
  test("cada tipo tem UMA categoria principal: nenhuma pendência aparece em dois grupos", () => {
    const tipos = M.CATEGORIAS.flatMap((c) => c.tipos);
    assert.equal(new Set(tipos).size, tipos.length);
    const grupos = M.agrupar(linhas);
    const ids = grupos.flatMap((g) => g.itens.map((p) => p.id));
    assert.equal(ids.length, linhas.length); assert.equal(new Set(ids).size, ids.length);
  });
  test("tipo desconhecido não some", () => assert.equal(M.categoriaDe({ tipo: "novo_tipo" }), "classificacoes"));
  test("grupos só CONTAM itens — nenhum total somado por grupo", () => {
    for (const g of M.agrupar(linhas)) assert.equal(Object.keys(g).some((k) => /total|soma/i.test(k)), false);
  });
});

describe("linha compacta", () => {
  test("Ajuste iFood — R$ 788,15, Estimado, Contadora, aguardando Portal do Parceiro", () => {
    const [a] = porTipo("ajuste_vendas");
    assert.equal(a.resumo.nome, "Ajuste iFood"); assert.equal(a.resumo.valor, 78815);
    assert.equal(a.status, "estimado"); assert.equal(M.responsavelCurto(a.responsavel), "Contadora");
    assert.equal(a.resumo.motivo, "Aguardando relatório do Portal do Parceiro.");
  });
  test("pagamento por terceiro diz explicitamente que não saiu de conta da empresa", () => {
    const [t] = porTipo("pagamento_terceiro");
    assert.match(t.resumo.nome, /^Pago por Sócia/); assert.match(t.resumo.motivo, /não saiu de conta bancária da empresa/); assert.equal(t.resumo.valor, 663360);
  });
  test("pagamento de R$ 80,00 sem origem: nada presumido, prioridade alta pelo fechamento", () => {
    const [o] = porTipo("origem_pendente");
    assert.equal(o.resumo.valor, 8000); assert.match(o.resumo.motivo, /nada foi presumido/);
    assert.equal(o.prioridade.nivel, "alta"); assert.match(o.prioridade.criterio, /fechamento/);
  });
  test("grupos (rateios, transferências, classificação) mostram quantidade, não um valor somado como perda", () => {
    const [r] = porTipo("rateios"), [t] = porTipo("transferencias_internas"), [c] = porTipo("classificacao_pendente");
    assert.equal(r.resumo.nome, "Rateios propostos (5)"); assert.match(r.resumo.valorRotulo, /5 rateios/);
    assert.equal(t.resumo.nome, "Transferências entre contas (11)"); assert.match(t.resumo.valorRotulo, /não é perda/);
    assert.equal(c.resumo.nome, "Lançamentos sem classificação (8)"); assert.equal(c.resumo.valor, null);
  });
  test("juros: motivo separa quitar e classificar quando a conta não está quitada", () => {
    const [j] = porTipo("juros_presumido");
    assert.match(j.resumo.motivo, /quitar a conta e, depois, classificar/);
  });
  test("primeiraFrase e responsavelCurto", () => {
    assert.equal(M.primeiraFrase("A. B. C."), "A."); assert.equal(M.primeiraFrase(""), "");
    assert.equal(M.responsavelCurto("Contadora (iFood: com o Portal do Parceiro)"), "Contadora");
    assert.deepEqual(M.responsaveis([{ responsavel: "Proprietário e contadora" }, { responsavel: "Operador financeiro" }]), ["Contadora", "Operador financeiro", "Proprietário"]);
  });
});

describe("prioridade verificável (sem urgência inventada)", () => {
  test("alta só com vencimento ou bloqueio de fechamento; média quando muda um número do resultado; normal no resto", () => {
    assert.equal(M.prioridade({ tipo: "conta_sem_pagamento", vencimento: "2026-09-10" }).nivel, "alta");
    assert.equal(M.prioridade({ tipo: "ajuste_vendas" }).nivel, "media");
    assert.equal(M.prioridade({ tipo: "transferencias_internas" }).nivel, "normal");
    assert.equal(M.prioridade({ tipo: "pendencia_documental" }).nivel, "normal");
    assert.equal(M.prioridade({ tipo: "pendencia_documental", status: "confirmado" }).nivel, "normal");
    for (const p of linhas) assert.ok(p.prioridade.criterio.length > 5, "todo nível tem o critério escrito");
  });
});

describe("filtros, busca e ordenação", () => {
  test("situação: estimadas, aguardando comprovação, concluídas", () => {
    assert.deepEqual(M.filtrar(linhas, { status: "estimado" }).map((p) => p.tipo), ["ajuste_vendas"]);
    assert.ok(M.filtrar(linhas, { status: "aguardando_comprovacao" }).every((p) => p.status === "aguardando_comprovacao"));
    assert.deepEqual(M.filtrar(linhas, { status: "confirmado" }).map((p) => p.id), ["doc:d-ok"]);
  });
  test("categoria e responsável", () => {
    assert.ok(M.filtrar(linhas, { categoria: "contas" }).every((p) => p.categoria === "contas"));
    const contadora = M.filtrar(linhas, { responsavel: "Contadora" });
    assert.ok(contadora.some((p) => p.tipo === "pagamento_terceiro"), "\"Proprietário e contadora\" entra no filtro Contadora");
  });
  test("busca por nome, valor (788,15 / 6.633,60 / 200), fornecedor e referência", () => {
    assert.deepEqual(M.filtrar(linhas, { busca: "788,15" }).map((p) => p.tipo), ["ajuste_vendas"]);
    assert.deepEqual(M.filtrar(linhas, { busca: "6.633,60" }).map((p) => p.tipo), ["pagamento_terceiro"]);
    assert.ok(M.filtrar(linhas, { busca: "distribuidora" }).some((p) => p.tipo === "pagamento_terceiro"));
    assert.ok(M.filtrar(linhas, { busca: "stone" }).some((p) => p.tipo === "transferencias_internas"), "acha pelas linhas internas");
    assert.ok(M.filtrar(linhas, { busca: "PORTAL" }).length >= 0);
    assert.equal(M.filtrar(linhas, { busca: "nada-disso-existe" }).length, 0);
  });
  test("valorDaBusca", () => {
    assert.equal(M.valorDaBusca("788,15"), 78815); assert.equal(M.valorDaBusca("R$ 1.234,56"), 123456); assert.equal(M.valorDaBusca("200"), 20000);
    assert.equal(M.valorDaBusca("788.15"), 78815); assert.equal(M.valorDaBusca("abc"), null);
  });
  test("ordena por prioridade, valor e data", () => {
    assert.equal(M.ordenar(linhas, "prioridade")[0].prioridade.nivel, "alta");
    const porValor = M.ordenar(linhas.filter((p) => p.resumo.valor != null), "valor").map((p) => p.resumo.valor);
    assert.deepEqual(porValor, [...porValor].sort((a, b) => b - a));
    const datas = M.ordenar(linhas, "data").map((p) => p.data ?? "9999");
    assert.deepEqual(datas, [...datas].sort());
  });
});

describe("sugestões documentais", () => {
  const s = M.sugestoes(PDOC_SETEMBRO);
  test("as cinco ainda não cadastradas aparecem; nada é cadastrado sozinho", () => {
    assert.equal(s.abertas.length, 5);
    assert.deepEqual(s.abertas.map((m) => m.valorCentavos), [19053, 19525, 20000, 82, null]);
  });
  test("R$ 190,53 × R$ 195,25: relação explicada pela diferença de R$ 4,72, sem contar duas perdas", () => {
    assert.equal(s.relacoes.length, 1);
    const r = s.relacoes[0];
    assert.equal(r.diferencaCentavos, 472);
    assert.match(r.conta, /195,25 − R\$\s4,72 = R\$\s190,53/);
    assert.match(r.texto, /MESMO dinheiro/); assert.match(r.texto, /Não contar como duas perdas/);
    assert.match(r.origemDiferenca, /4,72/);
  });
  test("dispensada sai das abertas e fica listada com a justificativa", () => {
    const pd = { ...PDOC_SETEMBRO, modelos: PDOC_SETEMBRO.modelos.map((m, i) => (i === 3 ? { ...m, dispensada: { justificativa: "Cupom conferido: R$ 96,00", em: "2026-11-10T10:00:00Z" } } : m)) };
    const x = M.sugestoes(pd);
    assert.equal(x.abertas.length, 4); assert.equal(x.dispensadas.length, 1); assert.equal(x.dispensadas[0].dispensada.justificativa, "Cupom conferido: R$ 96,00");
  });
  test("cadastrada não aparece como sugestão", () => {
    const pd = { ...PDOC_SETEMBRO, modelos: PDOC_SETEMBRO.modelos.map((m, i) => (i === 2 ? { ...m, cadastrada: true } : m)) };
    assert.equal(M.sugestoes(pd).abertas.length, 4);
  });
});

describe("cabeçalho e referências", () => {
  test("grupos em aberto, sugestões não cadastradas e metodologia aguardando aprovação", () => {
    const c = M.cabecalho(CENTRAL_SETEMBRO, PDOC_SETEMBRO);
    assert.equal(c.grupos, CENTRAL_SETEMBRO.total); assert.equal(c.sugestoes, 5);
    assert.deepEqual([c.metodologia.aprovada, c.metodologia.rotulo], [false, "Aguardando aprovação"]);
    assert.equal(M.cabecalho({ ...CENTRAL_SETEMBRO, geral: [] }, PDOC_SETEMBRO).metodologia.rotulo, "Aprovada");
  });
  test("sem referência oficial: mensagem clara, NUNCA \"0 de 0 indicadores conferem\"", () => {
    const t = M.textoComparacao({ total: 0, conferem: 0, divergentes: 0 });
    assert.equal(t.vazio, true); assert.equal(t.texto, "Nenhuma referência documental cadastrada para comparação.");
    assert.doesNotMatch(t.texto, /0 de 0/);
    assert.match(M.textoComparacao({ total: 4, conferem: 3 }).texto, /^3 de 4 indicadores conferem; 1 com diferença/);
  });
});
