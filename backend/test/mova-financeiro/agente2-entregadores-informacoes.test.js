// 23/11/2026 — "Informações dos entregadores": os entregadores vêm do Financeiro (fechamentos + Foody das semanas em aberto),
// nunca de cadastro à mão. Núcleo REAL do Financeiro (memória) + armazenamento do MOVA em memória. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { somarDias } from "../../src/modules/financeiro-v2/dominio/tempo.js";
import { criarArmazenamentoMemoria } from "../../src/modules/mova-financeiro/infra/memoria.js";
import { ACOES_MOVA, entregadoresConhecidos, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx } from "../financeiro-v2/helpers/cenario.js";

const S2 = "2026-11-09", S4 = "2026-11-16";
const entrega = (id, chave, nome, data) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: chave, entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: 700, elegivel: true, emRevisao: false });
async function montar() {
  // antigo: só até 09/11 · novo: só em 16–22/11 · ana e ana-2: mesmo nome, chaves diferentes · varias: todas as semanas
  const fonte = { apurar: async (p) => ({ disponivel: true, dias: Array.from({ length: 7 }, (_, i) => ({ data: somarDias(p.inicio, i), fonte: "foody", provisorio: false, aberto: false, triagem: 0 })),
    entregas: [
      entrega(`${p.inicio}-v`, "varias", "Várias Semanas", p.inicio),
      ...(p.inicio <= S2 ? [entrega(`${p.inicio}-a`, "antigo", "Antigo Sintético", p.inicio)] : []),
      ...(p.inicio === S4 ? [entrega(`${p.inicio}-n`, "novo", "Novo Sintético", p.inicio), entrega(`${p.inicio}-x`, "ana", "Ana Sintética", p.inicio), entrega(`${p.inicio}-y`, "ana-2", "Ana Sintética", p.inicio)] : []),
    ] }) };
  const cofre = criarCofreMemoria();
  const nucleo = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date("2026-11-23T12:00:00.000Z"), cofre, entregadores: { fonte, inicioDaOperacao: "2026-11-02", cofreDeNotas: cofre } });
  const c = { ...ctx(ORG_A, UNI_A, TODAS), usuarioId: "eeeeeeee-0000-4000-8000-000000000001" };
  await nucleo.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  for (const s of ["2026-11-02", S2]) await nucleo.fecharSemanaDeEntregadores(c, { inicio: s });
  const a = criarArmazenamentoMemoria();
  const cfg = { unidades: [{ organizacaoId: ORG_A, unidadeId: UNI_A, nome: "Loja Sintética" }], gruposAutorizados: [{ grupoId: "120363000000000001@g.us", unidades: [UNI_A], participantes: [{ telefones: ["+5585999990001"] }] }], entregadores: [] };
  const mova = { armazenamento: a, cfg };
  const acao = (nome, b) => executarAcaoMova(ACOES_MOVA[nome], { ctx: c, mova, nucleo, b });
  const contatos = async (chave) => (await a.entregadores.listar({ organizacaoId: ORG_A, unidadeId: UNI_A })).filter((x) => x.chave === chave);
  return { nucleo, c, a, acao, contatos };
}

test("E1 conhecidos: fechamento antigo, só 16–22/11 (Foody, sem fechamento), várias semanas; homônimos nunca juntados", async () => {
  const m = await montar();
  const k = await entregadoresConhecidos({ ctx: m.c, nucleo: m.nucleo });
  const por = Object.fromEntries(k.map((x) => [x.chave, x]));
  assert.deepEqual(Object.keys(por).sort(), ["ana", "ana-2", "antigo", "novo", "varias"]);
  assert.deepEqual([por.antigo.origem, por.antigo.semanasFechadas, por.antigo.ultimaSemana], ["FECHAMENTO", 2, S2]);
  assert.deepEqual([por.novo.origem, por.novo.semanasFechadas, por.novo.ultimaAtividade], ["FOODY_SEM_FECHAMENTO", 0, S4]);
  assert.ok(por.varias.semanas.includes(S4) && por.varias.semanas.includes(S2), "histórico em várias semanas");
  assert.equal(por.varias.origem, "FECHAMENTO");
  assert.ok(por.ana.nomeRepetido && por["ana-2"].nomeRepetido && !por.novo.nomeRepetido);
  const r = await m.nucleo.consultarEntregadoresProprios(m.c, { semana: S4 });
  assert.equal(r.fechamentos.filter((f) => f.semanaInicio === S4).length, 0, "listar não cria fechamento nem conta");
});

test("E2 WhatsApp ANTES do fechamento: entregador só do Foody recebe número; desconhecido é recusado; sem novo registro de entregador", async () => {
  const m = await montar();
  const r = await m.acao("/mova/entregador", { entregador: "novo", telefone: "(85) 99999-1101" });
  assert.equal(r.telefone, "…1101");
  await assert.rejects(m.acao("/mova/entregador", { entregador: "inventado", telefone: "(85) 99999-1102" }), (e) => e.codigo === "ENTREGADOR_NAO_ENCONTRADO" || /não encontrado/i.test(e.message));
  assert.equal((await m.contatos("inventado")).length, 0);
});

test("E3 fechamento OFICIAL de 16–22/11: o mesmo entregador e o mesmo contato (sem duplicar); trocar o número segue valendo; mudar de semana não perde o vínculo", async () => {
  const m = await montar();
  await m.acao("/mova/entregador", { entregador: "novo", telefone: "(85) 99999-1101" });
  await m.nucleo.fecharSemanaDeEntregadores(m.c, { inicio: S4 });
  const k = (await entregadoresConhecidos({ ctx: m.c, nucleo: m.nucleo })).filter((x) => x.chave === "novo");
  assert.equal(k.length, 1, "um entregador só");
  assert.deepEqual([k[0].origem, k[0].semanasFechadas, k[0].ultimaSemana], ["FECHAMENTO", 1, S4]);
  assert.deepEqual((await m.contatos("novo")).map((x) => [x.telefone, x.ativo]), [["…1101", true]], "o contato continua o mesmo");
  const t = await m.acao("/mova/entregador-alterar", { entregador: "novo", telefone: "(85) 98888-2202" });
  assert.deepEqual([t.motivo, t.telefone], ["TROCA_DE_NUMERO", "…2202"]);
  // entregador com fechamento antigo também recebe número normalmente
  assert.equal((await m.acao("/mova/entregador", { entregador: "antigo", telefone: "(85) 99999-3303" })).telefone, "…3303");
  // homônimos: números independentes
  await m.acao("/mova/entregador", { entregador: "ana", telefone: "(85) 99999-4404" });
  await m.acao("/mova/entregador", { entregador: "ana-2", telefone: "(85) 99999-5505" });
  assert.deepEqual([(await m.contatos("ana"))[0].telefone, (await m.contatos("ana-2"))[0].telefone], ["…4404", "…5505"]);
});
