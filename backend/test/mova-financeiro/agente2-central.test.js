// MOVA — Agente 2, Frente E: Central de Operações. As consultas devolvem SÓ contagens reais do banco do MOVA da unidade da
// sessão; identificadores mascarados; nada de indicador estimado. Banco local isolado, dados sintéticos, IA simulada.
import assert from "node:assert/strict";
import { CONSULTAS_MOVA } from "../../src/modules/fv2-integracao/movaRotas.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";
import { ALFA, BETA, CONS, FIN, GRUPO, ORG, base, cenario, gw, t } from "./helpers/operacao.js";

const PESSOA = "eeeeeeee-0000-4000-8000-000000000001";
const sessao = (u = ALFA, perms = ["financeiro_v2.ver"]) => ctx(ORG, u, perms, PESSOA);
const consultar = (rota, s, deps, params = {}) => CONSULTAS_MOVA[rota]({ ctx: s, mova: deps.mova, controle: null, orcamento: null, params });

t("A2-C1 visão geral: contagens reais da unidade (mensagens, consultas, documentos, propostas); outra unidade não soma; exige ver", async () => {
  const s = await cenario({ responder: () => base({ tipoDocumento: "BOLETO", intencao: "REGISTRAR_CONTA", valorCentavos: 4500, vencimento: "2026-10-20", favorecido: "Fornecedor Sintético", competencia: "2026-10" }) });
  await s.enviar(gw({ texto: "MOVA contas a pagar da alfa" }));
  await s.enviar(gw({ texto: "MOVA boleto da alfa", doc: "%PDF-1.4\n% boleto sintetico C1\n%%EOF\n" }));
  const v = await consultar("/mova/visao-geral", sessao(), s);
  assert.equal(v.mensagens.recebidas, 2);
  assert.equal(v.mensagens.consultas, 1);
  assert.equal(v.mensagens.documentos, 1);
  assert.equal(v.propostas.AGUARDANDO_REVISAO.quantidade, 1);
  assert.equal(v.propostas.AGUARDANDO_REVISAO.valorCentavos, 4500);
  assert.deepEqual([v.autonomiaLigada, v.entregadoresLigado, v.modo], [false, false, "OPERACAO"]);
  const beta = await consultar("/mova/visao-geral", sessao(BETA), s);
  assert.deepEqual([beta.mensagens.recebidas, beta.propostas], [0, {}]);
  await assert.rejects(consultar("/mova/visao-geral", sessao(ALFA, []), s), (e) => e.status === 403 || /PERMISSAO/.test(e.codigo ?? e.message));
});

t("A2-C2 grupos: política, perfis e retrato dos membros com quem NÃO está autorizado — tudo mascarado", async () => {
  const s = await cenario();
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, CONS, "5500000000777@s.whatsapp.net"] });
  const { itens } = await consultar("/mova/grupos", sessao(), s);
  const g = itens.find((x) => x.tipo === "GRUPO");
  assert.deepEqual([g.grupo, g.acesso, g.politicaResposta], ["…0201", "LISTA", "PRIVADO_RESTRITO"]);
  assert.deepEqual([g.membros.total, g.membros.naoAutorizados], [3, ["…0777"]]);
  assert.ok(g.participantes.some((p) => p.perfil === "CONSULTA"));
  assert.ok(itens.some((x) => x.tipo === "PRIVADO_DERIVADO"));
  assert.doesNotMatch(JSON.stringify(itens), /5500000000201|whatsapp\.net|@lid/, "nenhum identificador completo sai da Central");
});
