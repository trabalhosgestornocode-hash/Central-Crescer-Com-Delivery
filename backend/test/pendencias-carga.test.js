// Pendências da carga que bloqueiam homologação — núcleo puro.
import test from "node:test";
import assert from "node:assert/strict";
import { CODIGOS_CARGA_BLOQUEANTES, pendenciasCargaAbertas, bloqueiosDaCarga, conferirPendenciasCarga } from "../src/modules/produtos/pendenciasCarga.js";

test("só pendências que descrevem a ORIGEM bloqueiam; dinâmicas e avisos não entram", () => {
  for (const c of ["linha_sem_quantidade", "componente_nao_encontrado", "custo_planilha_invalido", "linha_com_erro_na_planilha"]) assert.ok(CODIGOS_CARGA_BLOQUEANTES.has(c));
  for (const c of ["insumo_sem_custo", "preparacao_incompleta", "sem_componentes", "preco_venda_planilha_ausente", "rendimento_sem_unidade"]) assert.ok(!CODIGOS_CARGA_BLOQUEANTES.has(c));
  assert.equal(pendenciasCargaAbertas([{ codigo: "linha_sem_quantidade" }, { codigo: "insumo_sem_custo" }, { codigo: "componente_nao_encontrado", conferida_em: "2026-11-13" }]).length, 1);
  assert.deepEqual(pendenciasCargaAbertas(null), []);
});

test("bloqueio herdado de preparação em qualquer nível, ignora linha inativa e tolera ciclo", () => {
  const grafo = { nomeProdById: new Map([["b", "Base"], ["c", "Mix"]]), fichaByProd: new Map([
    ["a", [{ subproduto_id: "b" }, { subproduto_id: "x", ativo: false }]], ["b", [{ subproduto_id: "c" }]], ["c", [{ subproduto_id: "b" }]]]) };
  const pend = new Map([["c", [{ codigo: "componente_nao_encontrado" }]], ["x", [{ codigo: "linha_sem_quantidade" }]]]);
  const r = bloqueiosDaCarga("a", grafo, pend);
  assert.equal(r.bloqueado, true); assert.deepEqual(r.proprias, []); assert.deepEqual(r.preparacoes, [{ id: "c", nome: "Mix" }]);
  assert.equal(bloqueiosDaCarga("x", grafo, new Map()).bloqueado, false);
});

test("conferir marca só as bloqueantes abertas, sem mutar a entrada", () => {
  const orig = [{ codigo: "linha_sem_quantidade" }, { codigo: "preco_venda_planilha_ausente" }, { codigo: "componente_nao_encontrado", conferida_em: "antes", conferida_por: "X" }];
  const r = conferirPendenciasCarga(orig, { quando: "agora", quem: "Ana" });
  assert.deepEqual(r[0], { codigo: "linha_sem_quantidade", conferida_em: "agora", conferida_por: "Ana" });
  assert.deepEqual(r[1], { codigo: "preco_venda_planilha_ausente" });
  assert.equal(r[2].conferida_em, "antes");
  assert.ok(!orig[0].conferida_em);
});
