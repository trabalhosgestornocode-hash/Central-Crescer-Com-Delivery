// Saúde da sincronização Foody: estados explícitos a partir das execuções (credencial sozinha nunca é "Atualizado").
import { test } from "node:test";
import assert from "node:assert/strict";
import { saudeDaIntegracao, SAUDE } from "../src/configuracoesFoodyModelo.js";

const AGORA = new Date("2026-11-10T18:00:00Z");
const ex = (iniciadoEm, extra = {}) => ({ iniciadoEm, concluidoEm: iniciadoEm, status: "CONCLUIDA", unicos: 120, inseridos: 3, atualizados: 1, inalterados: 116,
  fechamentosPendentes: 0, pontoDivergente: 0, erroCodigo: null, ...extra });
const ativo = (execucoes, extra = {}) => ({ habilitada: true, conexaoStatus: "ATIVA", execucoes, ...extra });

test("sem conexão / conexão inativa / coleta desligada nunca aparecem como atualizadas", () => {
  assert.equal(saudeDaIntegracao({ habilitada: true, conexaoStatus: null, execucoes: [] }, AGORA).estado, "SEM_CONEXAO");
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T17:00:00Z")], { conexaoStatus: "PAUSADA" }), AGORA).estado, "CONEXAO_INATIVA");
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T17:00:00Z")], { habilitada: false }), AGORA).estado, "COLETA_DESLIGADA");
  assert.equal(saudeDaIntegracao(ativo([]), AGORA).estado, "CONECTADO");
});
test("sucesso recente com pedidos = ATUALIZADO, com métricas do último sucesso", () => {
  const s = saudeDaIntegracao(ativo([ex("2026-11-10T13:26:00Z"), ex("2026-11-10T07:00:00Z", { fechamentosPendentes: 1 })]), AGORA);
  assert.equal(s.estado, "ATUALIZADO");
  assert.equal(s.capturados, 120);
  assert.equal(s.persistidos, 120);
  assert.equal(s.atrasoHoras, 4.6);
  assert.equal(s.pendencias, 1);
});
test("sem sucesso há mais de 7 h = ATRASADO; zero pedidos = SEM DADOS NA ORIGEM", () => {
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T09:00:00Z")]), AGORA).estado, "ATRASADO");
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T17:00:00Z", { unicos: 0, inalterados: 0, inseridos: 0, atualizados: 0 })]), AGORA).estado, "SEM_DADOS_NA_ORIGEM");
});
test("falha depois do último sucesso = COM ERRO (não é escondida por sucesso antigo); falha antiga não", () => {
  const s = saudeDaIntegracao(ativo([ex("2026-11-10T17:00:00Z", { status: "FALHOU", erroCodigo: "AUTENTICACAO" }), ex("2026-11-10T13:00:00Z")]), AGORA);
  assert.equal(s.estado, "COM_ERRO");
  assert.equal(s.ultimoErro, "AUTENTICACAO");
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T17:00:00Z"), ex("2026-11-10T13:00:00Z", { status: "FALHOU" })]), AGORA).estado, "ATUALIZADO");
});
test("EM_ANDAMENTO recente = SINCRONIZANDO; antigo (abandonado) não", () => {
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T17:50:00Z", { status: "EM_ANDAMENTO" }), ex("2026-11-10T13:00:00Z")]), AGORA).estado, "SINCRONIZANDO");
  assert.equal(saudeDaIntegracao(ativo([ex("2026-11-10T15:00:00Z", { status: "EM_ANDAMENTO" }), ex("2026-11-10T13:00:00Z")]), AGORA).estado, "ATUALIZADO");
});
test("todo estado tem rótulo", () => { for (const k of ["SEM_CONEXAO", "CONEXAO_INATIVA", "COLETA_DESLIGADA", "CONECTADO", "SINCRONIZANDO", "COM_ERRO", "ATRASADO", "SEM_DADOS_NA_ORIGEM", "ATUALIZADO"]) assert.ok(SAUDE[k], k); });
