// Portões do pré-voo da implantação Foody 147–149 (função pura, sem banco): a idade do WAL só é AVISO no TESTE; em produção bloqueia.
// archive_mode desligado ou falha de arquivamento bloqueiam em qualquer alvo remoto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarPrevoo } from "../testes-seguros/foody-147-149/implantar.mjs";

const base = (wal) => ({
  identidade: { somente_leitura: "on", replica: false },
  historico: { existe: true, foody_registradas: [], numeros_147_149_ocupados: [], termo_v3_registrado: 1 },
  objetos_foody: [],
  dependencias: { tabelas: { unidades: true }, papeis: { service_role: true }, colunas_usuarios_organizacoes: 4, gen_random_uuid: true,
    hashtextextended: true, remapear_descobre_por_colunas: true },
  unidades_piloto: { subway_saci: { existe: true, ativa: true, organizacao_id: "a" }, acai_no_grau_saci: { existe: true, ativa: true, organizacao_id: "b" } },
  concorrencia: { locks_aguardando: 0, locks_fortes_unidades_organizacoes: 0, idle_in_transaction: 0, transacao_mais_longa_s: 0 },
  arquivamento_wal: { modo: "on", ultima_falha_depois_do_ultimo_ok: false, segundos_desde_ultimo: 30, ...wal },
});

test("WAL antigo: AVISO no teste, FALHA em produção", () => {
  const p = base({ segundos_desde_ultimo: 3800 });
  const avisosT = []; assert.deepEqual(avaliarPrevoo(p, "teste", avisosT), []); assert.match(avisosT[0], /3800s/);
  const avisosP = []; const fP = avaliarPrevoo(p, "producao", avisosP);
  assert.equal(fP.length, 1); assert.match(fP[0], /último WAL arquivado há 3800s/); assert.deepEqual(avisosP, []);
});

test("archive_mode desligado ou falha de arquivamento bloqueiam também no teste", () => {
  assert.ok(avaliarPrevoo(base({ modo: "off" }), "teste").some((f) => /archive_mode/.test(f)));
  assert.ok(avaliarPrevoo(base({ ultima_falha_depois_do_ultimo_ok: true }), "teste").some((f) => /falhando/.test(f)));
  assert.ok(avaliarPrevoo(base({ ultima_falha_depois_do_ultimo_ok: true }), "producao").some((f) => /falhando/.test(f)));
});

test("WAL recente: nenhum aviso nem falha; local ignora o arquivamento", () => {
  const av = []; assert.deepEqual(avaliarPrevoo(base({}), "producao", av), []); assert.deepEqual(av, []);
  assert.deepEqual(avaliarPrevoo(base({ modo: "off", segundos_desde_ultimo: 99999 }), "local"), []);
});
