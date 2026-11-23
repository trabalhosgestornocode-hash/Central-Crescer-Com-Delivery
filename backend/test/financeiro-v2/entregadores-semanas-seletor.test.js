// Entregadores Próprios — SELETOR DE SEMANAS (23/11/2026). Causa do sumiço da semana 16 a 22/11: a lista vinha só das semanas com
// registro de fechamento; semana encerrada e ainda não fechada não aparecia. Dados SINTÉTICOS; memória ou PostgreSQL isolado.
import assert from "node:assert/strict";
import { test } from "node:test";
import { criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { semanaInicialDaTela, semanasDoSeletor } from "../../src/modules/financeiro-v2/dominio/entregadoresProprios.js";
import { somarDias } from "../../src/modules/financeiro-v2/dominio/tempo.js";
import { ORG_A, TODAS, UNI_A, UNI_A2, ctx, ESCOPOS_PADRAO } from "./helpers/cenario.js";
import { EM_POSTGRES, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const S1 = "2026-10-26", S2 = "2026-11-02", S3 = "2026-11-09", S4 = "2026-11-16", ATUAL = "2026-11-23";
const reg = (semanaInicio, situacao = "CONSOLIDADA") => ({ semanaInicio, situacao });

test("seletor (puro): semana encerrada SEM fechamento aparece como 'aguardando fechamento' — nunca como fechada; ordem decrescente", () => {
  const l = semanasDoSeletor({ registros: [reg(S1), reg(S3), reg(S2)], hoje: "2026-11-23" });
  assert.deepEqual(l.map((s) => [s.inicio, s.situacao, s.semRegistro]), [[S4, "AGUARDANDO_FECHAMENTO", true], [S3, "CONSOLIDADA", false], [S2, "CONSOLIDADA", false], [S1, "CONSOLIDADA", false]]);
  assert.equal(l[0].rotulo, "16 a 22/11/2026");
});
test("seletor (puro): lacuna no meio também aparece; semana atual fica de fora; unidade sem fechamento não deduz nada", () => {
  assert.deepEqual(semanasDoSeletor({ registros: [reg(S1), reg(S3, "PENDENTE"), reg(ATUAL, "PENDENTE")], hoje: "2026-11-24" }).map((s) => [s.inicio, s.situacao]),
    [[S4, "AGUARDANDO_FECHAMENTO"], [S3, "PENDENTE"], [S2, "AGUARDANDO_FECHAMENTO"], [S1, "CONSOLIDADA"]]);
  assert.deepEqual(semanasDoSeletor({ registros: [], hoje: "2026-11-23" }), []);
  assert.equal(semanasDoSeletor({ registros: [reg("2025-01-06")], hoje: "2026-11-23", maxLacunas: 3 }).filter((s) => s.semRegistro).length, 3, "limite de lacunas");
});
test("seleção inicial (pura): a última semana FECHADA; sem nenhuma, a semana atual; pendente não conta como fechada", () => {
  assert.equal(semanaInicialDaTela({ registros: [reg(S1), reg(S3), reg(S2)], hoje: "2026-11-23" }), S3);
  assert.equal(semanaInicialDaTela({ registros: [reg(S3, "PENDENTE")], hoje: "2026-11-23" }), ATUAL);
  assert.equal(semanaInicialDaTela({ registros: [], hoje: "2026-11-25" }), ATUAL);
});

// ---------------------------------------------------------------- ponta a ponta no núcleo (fechamento OFICIAL, nada simulado)
const diasDe = (inicio) => Array.from({ length: 7 }, (_, i) => ({ data: somarDias(inicio, i), fonte: "foody", provisorio: false, aberto: false, triagem: 0 }));
const entrega = (id, nome, data, centavos) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: nome.toLowerCase(), entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false });
const VALORES = { [S1]: 700, [S2]: 800, [S3]: 900, [S4]: 1100, [ATUAL]: 300 };
function montar() {
  const estado = { agora: "2026-11-23T12:00:00.000Z" };
  const repositorio = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const fonte = { apurar: async (p) => ({ disponivel: true, dias: diasDe(p.inicio), entregas: [entrega(`${p.unidadeId}-${p.inicio}`, "Mauricio", somarDias(p.inicio, 2), VALORES[p.inicio] ?? 0)] }) };
  const cofre = criarCofreMemoria();
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date(estado.agora), cofre, entregadores: { fonte, inicioDaOperacao: S1, cofreDeNotas: cofre } });
  return { n, estado, c: ctx(ORG_A, UNI_A, TODAS), c2: ctx(ORG_A, UNI_A2, TODAS) };
}

test("semana 16 a 22/11 ausente: com 26/10, 02/11 e 09/11 fechadas, ela aparece 'aguardando fechamento', a tela abre na 09/11 e, depois do fechamento OFICIAL, fica selecionável", async () => {
  const m = montar();
  await m.n.implantarPlanoDeContas(m.c, { modelo: "ACAITERIA" });
  for (const s of [S1, S2, S3]) await m.n.fecharSemanaDeEntregadores(m.c, { inicio: s });

  const tela = await m.n.consultarEntregadoresProprios(m.c, { selecao: "ULTIMA_FECHADA" });
  assert.equal(tela.semana.inicio, S3, "abre na última semana oficialmente fechada");
  assert.equal(tela.semana.situacao, "CONSOLIDADA");
  assert.equal(tela.indicadores.acumuladoSemanaCentavos, 900, "indicadores da semana SELECIONADA");
  assert.deepEqual(tela.semanas.map((s) => [s.inicio, s.situacao, s.semRegistro]),
    [[S4, "AGUARDANDO_FECHAMENTO", true], [S3, "CONSOLIDADA", false], [S2, "CONSOLIDADA", false], [S1, "CONSOLIDADA", false]]);

  const s4 = await m.n.consultarEntregadoresProprios(m.c, { semana: S4 });
  assert.equal(s4.semana.situacao, "AGUARDANDO_FECHAMENTO", "dados do Foody NÃO tornam a semana fechada");
  assert.equal(s4.semana.provisoria, true);
  assert.equal(s4.indicadores.acumuladoSemanaCentavos, 1100, "valor provisório da apuração da própria semana");
  assert.equal(s4.fechamentos.filter((f) => f.semanaInicio === S4).length, 0, "nenhum fechamento fictício");

  const semSelecao = await m.n.consultarEntregadoresProprios(m.c, {});
  assert.equal(semSelecao.semana.inicio, ATUAL, "sem `selecao` (MOVA e demais chamadas) continua na semana atual");
  await assert.rejects(() => m.n.consultarEntregadoresProprios(m.c, { selecao: "QUALQUER" }));

  await m.n.fecharSemanaDeEntregadores(m.c, { inicio: S4 }); // ação oficial
  const depois = await m.n.consultarEntregadoresProprios(m.c, { selecao: "ULTIMA_FECHADA" });
  assert.equal(depois.semana.inicio, S4);
  assert.equal(depois.semana.situacao, "CONSOLIDADA");
  assert.equal(depois.semanas[0].semRegistro, false);
  assert.equal(depois.semanas.filter((s) => s.semRegistro).length, 0);
  assert.equal(depois.fechamentos.filter((f) => f.semanaInicio === S4).length, 1);
});

test("isolamento: a outra unidade não vê as semanas nem deduz lacunas da primeira; seleção inicial cai na semana atual", async () => {
  const m = montar();
  await m.n.implantarPlanoDeContas(m.c, { modelo: "ACAITERIA" });
  await m.n.implantarPlanoDeContas(m.c2, { modelo: "ACAITERIA" });
  for (const s of [S1, S3]) await m.n.fecharSemanaDeEntregadores(m.c, { inicio: s });
  const b = await m.n.consultarEntregadoresProprios(m.c2, { selecao: "ULTIMA_FECHADA" });
  assert.deepEqual(b.semanas, []);
  assert.equal(b.semana.inicio, ATUAL);
  assert.equal(b.fechamentos.length, 0);
  const a = await m.n.consultarEntregadoresProprios(m.c, { selecao: "ULTIMA_FECHADA" });
  assert.deepEqual(a.semanas.map((s) => [s.inicio, s.semRegistro]), [[S4, true], [S3, false], [S2, true], [S1, false]]);
});
