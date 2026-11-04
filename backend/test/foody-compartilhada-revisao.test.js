// Revisão final do PR #76 — regressões dos quatro pontos priorizados:
//   1. privacidade da triagem (nada comercial de uma empresa visível para a outra);
//   2. integridade do ciclo (fechamento de destino que falha = competência PENDENTE, durável e retomada);
//   3. dupla autorização pela mesma pessoa só com as duas permissões legítimas, em atos separados;
//   4. evolução do catálogo (novo produto → triagem → nova versão/decisão → fechamentos versionados, sem duplicar nem
//      reescrever histórico congelado).
// Banco FALSO e API FALSA; dados sintéticos.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { sincronizarCompetencia } from "../src/modules/foody/foody.sync.service.js";
import { sincronizarEFechar, coberturaParaDestino } from "../src/modules/foody/foody.fechamento.service.js";
import { executarCicloFoody } from "../src/modules/foody/foody.agendador.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { proporDestino, aprovarDestino, listarTriagem, decidirTriagem } from "../src/modules/foody/foody.compartilhamento.service.js";
import { linhasParaTriagem } from "../src/modules/foody/foody.classificacao.js";
import { CATALOGO_OPERACAO } from "../src/modules/foody/foody.catalogo-operacao.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { pedidoApi, ORG_A, UNI_A, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const ORG_C = "33333333-3333-4333-8333-333333333333", UNI_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "2026-10-25";
let agoraAtual = new Date("2026-10-26T15:00:00Z");
const AGORA = () => agoraAtual;
const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_A, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true", FOODY_CENTRAL_ADMIN_ENABLED: "true" };
const CX = `cx-${UNI_A}`;
const SUB = "1x Sub Frango Teriyaki 15cm", ACAI = "1x Açaí Premium 500ml", NOVO = "1x Produto Novo Misterioso";

let db, repo, lista;
const criarCliente = ({ token }) => criarClienteFoody({ token, esperar: async () => {},
  fetch: async () => (token === TOKEN_TESTE ? { ok: true, status: 200, json: async () => structuredClone(lista) } : { ok: false, status: 401, json: async () => ({}) }) });
const deps = (extra = {}) => ({ env: ENV, repo, seguranca, criarCliente, agora: AGORA, log: () => {}, ...extra });
const ciclo = (extra) => sincronizarEFechar({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, deps(extra));
const ativos = (uid) => db.tabelas.foody_pedidos.filter((p) => p.foody_uid === uid && p.roteamento_ativo !== false);
const fech = (u, c = D) => db.tabelas.foody_fechamentos_logisticos.filter((x) => x.unidade_id === u && x.competencia === c).sort((a, b) => a.versao - b.versao);

beforeEach(() => {
  agoraAtual = new Date("2026-10-26T15:00:00Z");
  db = criarFakeDb({ unidades: { [UNI_A]: ORG_A, [UNI_C]: ORG_C } });
  repo = criarRepositorioFoody(db);
  db.tabelas.foody_conexoes.push({ id: CX, ...prepararConexao({ organizacaoId: ORG_A, unidadeId: UNI_A, token: TOKEN_TESTE }, seguranca), status: "ATIVA" });
  db.tabelas.foody_conexao_destinos.push({ id: "dst-1", conexao_id: CX, organizacao_id: ORG_C, unidade_id: UNI_C, operacao: "acai_no_grau",
    estado: "ATIVO", organizacao_titular_id: ORG_A, aprovado_titular_por: "a" });
  lista = [
    pedidoApi({ uid: "s1", orderDetails: SUB, courierFee: 10, orderTotal: 40, date: `${D}T11:00:00-03:00` }),
    pedidoApi({ uid: "c1", orderDetails: ACAI, courierFee: 7, orderTotal: 30, date: `${D}T12:00:00-03:00` }),
    pedidoApi({ uid: "t1", orderDetails: `${SUB}\n${NOVO}`, courierFee: 9, orderTotal: 55, date: `${D}T13:00:00-03:00` }),
    pedidoApi({ uid: "t2", orderDetails: `${SUB}\n${ACAI}`, courierFee: 6, orderTotal: 70, date: `${D}T14:00:00-03:00` }),
  ];
});

describe("1. privacidade da triagem", () => {
  test("a linha de triagem guarda SÓ as linhas sem atribuição; itens reconhecidos de qualquer empresa nunca ficam lá", async () => {
    await ciclo();
    const [t1] = ativos("t1"), [t2] = ativos("t2");
    assert.equal(t1.detalhes_pedido, "produto novo misterioso");
    assert.doesNotMatch(t1.detalhes_pedido, /teriyaki/i, "o sanduíche (Subway) não aparece na triagem");
    assert.equal(t2.triagem_motivo, "CONFLITO");
    assert.equal(t2.detalhes_pedido, null, "pedido misto: nenhum item de nenhuma empresa fica na triagem");
    for (const t of [t1, t2]) for (const k of ["valor_total", "taxa_entrega", "forma_pagamento", "cancelamento_razao", "cancelamento_justificativa"]) assert.equal(t[k], null, k);
    assert.match(t1.operacao_motivo, /1 por catálogo.*1 desconhecida/, "o resumo é só contagem");
    assert.doesNotMatch(t1.operacao_motivo, /teriyaki|misterioso/i);
  });
  test("a listagem da triagem entrega só linhas sem evidência + resumo de contagens (nada de valor ou item reconhecido)", async () => {
    await ciclo();
    const admC = { perfilId: "c1000000-0000-4000-8000-000000000003", papel: "organization_admin", impersonando: false, organizacaoId: ORG_C };
    const l = await listarTriagem({ ator: admC, conexaoId: CX, competencia: D }, { env: ENV, repo });
    assert.deepEqual(l.map((x) => [x.foodyUid, x.linhasSemEvidencia]), [["t1", ["produto novo misterioso"]], ["t2", []]]);
    for (const x of l) assert.deepEqual(Object.keys(x).sort(), ["catalogoVersao", "competencia", "dataHora", "decisaoPendente", "foodyUid", "linhasSemEvidencia", "motivo", "numeroPedido", "resumo", "situacao"]);
    assert.ok(!JSON.stringify(l).match(/teriyaki|a[cç]a[ií] premium/i));
  });
  test("linhasParaTriagem: só sem evidência ou com evidência das duas na mesma linha", () => {
    assert.deepEqual(linhasParaTriagem(`${SUB}\n${NOVO}\n1x Subway Açaí`), ["produto novo misterioso", "subway acai"]);
    assert.deepEqual(linhasParaTriagem(`${SUB}\n${ACAI}`), []);
  });
  test("o fechamento do DESTINO não recebe volume total da conta, nomes de ponto de coleta nem detalhes de erro da titular", async () => {
    db.tabelas.foody_conexoes[0].ponto_coleta_esperado = "Subway Saci";
    lista.push(pedidoApi({ uid: "x9", pontoColeta: "Outra Loja Secreta", date: `${D}T15:00:00-03:00` }));
    await ciclo();
    const [fa] = fech(UNI_A), [fc] = fech(UNI_C);
    assert.equal(fa.cobertura.pedidosUnicos, 5, "a titular (dona da conta) vê a própria cobertura");
    assert.equal(fc.cobertura.pedidosUnicos, null); assert.equal(fc.cobertura.paginas, null);
    assert.ok(!JSON.stringify(fc).includes("Outra Loja Secreta"));
    assert.deepEqual(fc.pendencias.filter((p) => p.codigo === "PONTO_COLETA_DIVERGENTE"), [{ codigo: "PONTO_COLETA_DIVERGENTE", origem: "conexao" }]);
    assert.deepEqual(fc.pendencias.find((p) => p.codigo === "TRIAGEM_PENDENTE"), { codigo: "TRIAGEM_PENDENTE", quantidade: 2 });
    assert.equal(fc.status, "INCOMPLETO", "a cobertura incompleta da conexão continua valendo para o destino");
    assert.deepEqual(coberturaParaDestino({ completa: true, pendencias: [{ codigo: "PEDIDO_MALFORMADO", quantidade: 3, porMotivo: { SEM_UID: 3 } }] }).pendencias,
      [{ codigo: "PEDIDO_MALFORMADO", origem: "conexao" }]);
  });
});

describe("2. integridade do ciclo compartilhado", () => {
  const falharDestino = (codigo = "BANCO") => ({ ...repo, registrarFechamento: async (t, p) => {
    if (t.unidadeId === UNI_C) { const e = new Error("x"); e.codigo = codigo; throw e; }
    return repo.registrarFechamento(t, p);
  } });
  test("destino que falha: ciclo NÃO concluído, pendência gravada na execução; retomada limpa a pendência", async () => {
    const r = await ciclo({ repo: falharDestino() });
    assert.equal(r.concluido, false);
    assert.deepEqual(r.pendentes, [{ unidadeId: UNI_C, operacao: "acai_no_grau", erro: "BANCO" }]);
    const e1 = db.tabelas.foody_sync_execucoes.at(-1);
    assert.equal(e1.fechamentos_pendentes, 1);
    assert.deepEqual(e1.fechamentos, { [UNI_A]: "REGISTRADO", [UNI_C]: "ERRO:BANCO" });
    const r2 = await ciclo();
    assert.equal(r2.concluido, true);
    assert.equal(db.tabelas.foody_sync_execucoes.at(-1).fechamentos_pendentes, 0);
    assert.equal(fech(UNI_C).length, 1, "o destino fecha uma vez, sem duplicar");
  });
  test("titular que falha: destinos ainda são tentados e gravados; o erro da titular sobe com as pendências", async () => {
    const repoT = { ...repo, registrarFechamento: async (t, p) => {
      if (t.unidadeId === UNI_A) { const e = new Error("x"); e.codigo = "BANCO"; throw e; }
      return repo.registrarFechamento(t, p);
    } };
    await assert.rejects(ciclo({ repo: repoT }), (e) => e.codigo === "BANCO" && e.fechamentosPendentes.length === 1 && e.fechamentosPendentes[0].unidadeId === UNI_A);
    assert.equal(fech(UNI_C).length, 1);
    assert.equal(db.tabelas.foody_sync_execucoes.at(-1).fechamentos_pendentes, 1);
  });
  test("agendador: ciclo com fechamento pendente NÃO é sucesso", async () => {
    const out = await executarCicloFoody({ unidades: [{ organizacaoId: ORG_A, unidadeId: UNI_A }], env: ENV, agora: AGORA, deps: deps({ repo: falharDestino() }) });
    const d1 = out.find((x) => x.competencia === D);
    assert.equal(d1.erro, "FECHAMENTO_PENDENTE");
    assert.deepEqual(d1.pendentes, [{ unidadeId: UNI_C, erro: "BANCO" }]);
  });
  test("pendência em dia que congelou é retomada pela reconciliação (reprocessamento com motivo), até concluir", async () => {
    await ciclo({ repo: falharDestino() });
    agoraAtual = new Date("2026-11-02T15:00:00Z"); // D já está CONGELADO
    assert.deepEqual(await repo.listarCompetenciasParaReconciliar({ organizacaoId: ORG_A, unidadeId: UNI_A }, "2026-10-01"),
      [{ competencia: D, motivo: "FECHAMENTO_PENDENTE" }]);
    lista = lista.filter((o) => !["t1", "t2"].includes(o.uid)); // sem triagem: o dia pode ficar limpo
    const out = await executarCicloFoody({ unidades: [{ organizacaoId: ORG_A, unidadeId: UNI_A }], env: ENV, agora: AGORA, deps: deps() });
    const rec = out.find((x) => x.competencia === D);
    assert.equal(rec.reconciliacao, true); assert.equal(rec.erro, undefined);
    const ex = db.tabelas.foody_sync_execucoes.at(-1);
    assert.deepEqual([ex.competencia, ex.origem, ex.fechamentos_pendentes], [D, "reprocessamento", 0]);
    assert.deepEqual(await repo.listarCompetenciasParaReconciliar({ organizacaoId: ORG_A, unidadeId: UNI_A }, "2026-10-01"), []);
  });
  test("sem a flag de compartilhamento, a reconciliação não roda", async () => {
    await ciclo({ repo: falharDestino() });
    agoraAtual = new Date("2026-11-02T15:00:00Z");
    const env = { ...ENV, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "false" };
    const chamadas = [];
    await executarCicloFoody({ unidades: [{ organizacaoId: ORG_A, unidadeId: UNI_A }], env, agora: AGORA, deps: deps(),
      executar: async (p) => { chamadas.push(p.competencia); return { fechamento: {} }; } });
    assert.ok(!chamadas.includes(D));
  });
});

describe("3. dupla autorização pela mesma pessoa", () => {
  const P = "a1000000-0000-4000-8000-000000000001";
  const svc = { env: ENV, repo, agora: AGORA };
  beforeEach(() => { db.tabelas.foody_conexao_destinos.splice(0); });
  test("dois atos, cada um no contexto da própria organização; o contexto errado é recusado", async () => {
    const s = { env: ENV, repo, agora: AGORA };
    const comoT = { perfilId: P, papel: "organization_admin", impersonando: false, organizacaoId: ORG_A };
    const comoC = { ...comoT, organizacaoId: ORG_C };
    const p = await proporDestino({ ator: comoT, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "acai_no_grau" } }, s);
    await assert.rejects(aprovarDestino({ ator: comoT, destinoId: p.id }, s), (e) => e.codigo === "SEM_PERMISSAO", "aprovar pelo destino exige o contexto do destino");
    await assert.rejects(aprovarDestino({ ator: { ...comoC, papel: "operations" }, destinoId: p.id }, s), (e) => e.codigo === "SEM_PERMISSAO", "sem o papel no destino, não aprova");
    const a = await aprovarDestino({ ator: comoC, destinoId: p.id }, s);
    assert.equal(a.estado, "ATIVO");
    const d = db.tabelas.foody_conexao_destinos[0];
    assert.deepEqual([d.aprovado_titular_por, d.aprovado_destino_por], [P, P]);
    void svc;
  });
});

describe("4. evolução do catálogo e resolução da triagem", () => {
  const catalogoNovo = (extra) => ({ versao: "2026-12-01.1", linhas: {
    subway: [...CATALOGO_OPERACAO.linhas.subway, ...(extra.subway ?? [])],
    acai_no_grau: [...CATALOGO_OPERACAO.linhas.acai_no_grau, ...(extra.acai_no_grau ?? [])] } });
  test("novo produto entra em triagem; nova versão do catálogo o resolve: mesma linha atualizada, v1 PRELIMINAR (triagem pendente) e v2 CONSOLIDADO, v1 preservada", async () => {
    lista = lista.filter((o) => o.uid !== "t2");
    await ciclo();
    assert.equal(ativos("t1")[0].operacao, "triagem");
    const v1 = structuredClone(fech(UNI_A)[0]);
    assert.equal(v1.estado_valores, "PROVISORIO");
    assert.equal(v1.status, "PRELIMINAR", "pendência de triagem nunca nasce consolidada");
    const r = await ciclo({ catalogo: catalogoNovo({ subway: ["produto novo misterioso"] }) });
    assert.equal(r.sync.compartilhamento.catalogoVersao, "2026-12-01.1");
    assert.equal(r.sync.compartilhamento.distribuicao.reclassificados, 1);
    const linhas = db.tabelas.foody_pedidos.filter((p) => p.foody_uid === "t1");
    assert.equal(linhas.length, 1, "mesma linha (mesmo tenant), sem duplicar");
    assert.deepEqual([linhas[0].operacao, linhas[0].valor_total, linhas[0].catalogo_versao], ["subway", 55, "2026-12-01.1"]);
    const [f1, f2] = fech(UNI_A);
    assert.deepEqual(f1, v1, "a versão anterior do fechamento não muda");
    assert.equal(f2.versao, 2); assert.equal(f2.status, "CONSOLIDADO", "primeira consolidação: a triagem foi resolvida");
    assert.equal(f2.estado_valores, "SINCRONIZADO");
    assert.equal(fech(UNI_C).length, 2, "o destino também ganha versão (a triagem pendente deixou de existir), sem duplicar");
  });
  test("novo produto do Açaí resolvido por catálogo muda de organização: linha antiga desativada, um único ativo", async () => {
    lista = [pedidoApi({ uid: "n1", orderDetails: `${ACAI}\n1x Topping Inédito`, courierFee: 8, orderTotal: 33, date: `${D}T11:00:00-03:00` })];
    await ciclo();
    assert.equal(ativos("n1")[0].unidade_id, UNI_A);
    await ciclo({ catalogo: catalogoNovo({ acai_no_grau: ["topping inedito"] }) });
    assert.equal(ativos("n1").length, 1);
    assert.deepEqual([ativos("n1")[0].unidade_id, ativos("n1")[0].organizacao_id], [UNI_C, ORG_C]);
    assert.equal(db.tabelas.foody_pedidos.find((p) => p.foody_uid === "n1" && p.unidade_id === UNI_A).roteamento_ativo, false);
  });
  test("decisão em dia CONGELADO: aplicada pela reconciliação, com nova versão dos fechamentos; nova versão de catálogo NÃO reabre dia congelado", async () => {
    await ciclo();
    agoraAtual = new Date("2026-11-02T15:00:00Z");
    // Catálogo novo sozinho não reprocessa histórico congelado.
    assert.deepEqual(await repo.listarCompetenciasParaReconciliar({ organizacaoId: ORG_A, unidadeId: UNI_A }, "2026-10-01"), []);
    const admA = { perfilId: "a1000000-0000-4000-8000-000000000001", papel: "organization_admin", impersonando: false, organizacaoId: ORG_A };
    const dec = await decidirTriagem({ ator: admA, conexaoId: CX, foodyUid: "t1", operacao: "subway", motivo: "conferido no Gestor" }, { env: ENV, repo });
    assert.deepEqual([dec.competencia, dec.aplicacao], [D, "PROXIMA_SINCRONIZACAO"]);
    db.tabelas.foody_triagem_decisoes.at(-1).decidido_em = "2026-11-02T10:00:00Z";
    assert.deepEqual(await repo.listarCompetenciasParaReconciliar({ organizacaoId: ORG_A, unidadeId: UNI_A }, "2026-10-01"), [{ competencia: D, motivo: "DECISAO_DE_TRIAGEM" }]);
    const antes = fech(UNI_A).length;
    await executarCicloFoody({ unidades: [{ organizacaoId: ORG_A, unidadeId: UNI_A }], env: ENV, agora: AGORA, deps: deps() });
    assert.equal(ativos("t1")[0].operacao, "subway");
    assert.equal(fech(UNI_A).length, antes + 1);
    // t2 segue em triagem: a nova versão continua PRELIMINAR (não consolida com pendência aberta).
    assert.deepEqual([fech(UNI_A).at(-1).status, fech(UNI_A).at(-1).estado_valores], ["PRELIMINAR", "PROVISORIO"]);
    const ex = db.tabelas.foody_sync_execucoes.filter((e) => e.competencia === D).at(-1);
    assert.equal(ex.origem, "reprocessamento");
    // t2 (CONFLITO) segue em triagem sem decisão: o dia não volta para a fila por ele.
    assert.deepEqual(await repo.listarCompetenciasParaReconciliar({ organizacaoId: ORG_A, unidadeId: UNI_A }, "2026-10-01"), []);
  });
});
