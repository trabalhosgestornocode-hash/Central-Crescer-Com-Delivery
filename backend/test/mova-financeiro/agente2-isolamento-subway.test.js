// 23/11/2026 — Isolamento Açaí × Subway no MOVA. "Subway" = unidade de OUTRA organização, atendida SEM grupo (0013).
// Escrever o nome da outra unidade na mensagem não muda o escopo: a unidade vem da conversa/participante (mecanismo oficial),
// e o núcleo do Financeiro nunca é chamado com a unidade da Subway a partir do grupo do Açaí. Tudo sintético; comandos sem IA.
import assert from "node:assert/strict";
import { ALFA, CONFIG, FIN, GRUPO, ORG, ORG_X, XIS, cenario, gw, t } from "./helpers/operacao.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const ESTRANHO = "5500000000299@s.whatsapp.net";
const FONTES_SUBWAY = { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD", "NOVENTA_E_NOVE_FOOD"] };
// Açaí (ALFA) no grupo; Subway (XIS, outra organização) sem grupo nenhum.
const CFG = {
  ...CONFIG,
  unidades: [CONFIG.unidades.find((u) => u.unidadeId === ALFA), { organizacaoId: ORG_X, unidadeId: XIS, nome: "Subway Sintético", apelidos: ["subway", "xis"], fontes: FONTES_SUBWAY, semGrupo: true }],
  gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA], acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ ids: [FIN], perfil: "FINANCEIRO", nome: "Financeiro" }] }],
};
const retrato = (s, membros) => s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: AGORA.toISOString() });

async function montar() {
  const s = await cenario({ config: CFG });
  await retrato(s, [FIN]);
  await s.conta("2026-10-15", 12345); // Açaí
  const fx = await s.m.nucleo.registrarContraparte(s.c(ORG_X, XIS), { tipo: "FORNECEDOR", nome: "Fornecedor Subway Sintético" });
  await s.m.nucleo.registrarObrigacao(s.c(ORG_X, XIS), { contraparteId: fx.id, valorOriginalCentavos: 77777, categoria: "INSUMOS", descricao: "Compra sintética Subway", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-15" }); // valor que nunca pode aparecer para o Açaí
  s.chamadas.length = 0;
  return s;
}
const tocouSubway = (s) => s.chamadas.filter((c) => c.unidadeId === XIS || c.organizacaoId === ORG_X);

t("X1 grupo do Açaí: consulta do Açaí responde só o Açaí; o núcleo nunca é chamado com a Subway", async () => {
  const s = await montar();
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana" }));
  const textos = (await s.saida()).map((x) => x.texto).join("\n");
  assert.match(textos, /123,45/);
  assert.ok(!/777,77/.test(textos));
  assert.equal(tocouSubway(s).length, 0);
});

t("X2 escrever 'Subway' (ou o apelido) na mensagem do grupo do Açaí NÃO muda o escopo: nada da Subway é lido nem respondido", async () => {
  const s = await montar();
  for (const texto of ["MOVA, contas a pagar da semana da subway", "MOVA, contas a pagar da xis", "MOVA, saldo da Subway Sintético", "MOVA, contas a pagar de todas as unidades"]) await s.enviar(gw({ texto }));
  const textos = (await s.saida()).map((x) => x.texto).join("\n");
  assert.ok(!/777,77|Fornecedor Subway/.test(textos), "nenhum dado da Subway na saída");
  assert.equal(tocouSubway(s).length, 0, "o núcleo nunca foi chamado com a unidade/organização da Subway");
});

t("X3 contato não autorizado (fora da lista) não consulta nada; conversa privada dele não existe", async () => {
  const s = await montar();
  const r1 = await s.enviar(gw({ texto: "MOVA, contas a pagar da semana", de: ESTRANHO }));
  const r2 = await s.enviar(gw({ texto: "contas a pagar da subway", de: ESTRANHO, grupo: ESTRANHO }));
  assert.deepEqual([r1.status, r1.motivo], ["IGNORADO", "PARTICIPANTE_NAO_AUTORIZADO"]);
  assert.deepEqual([r2.status, r2.motivo], ["IGNORADO", "NAO_E_GRUPO"], "conversa privada sem identidade oficial não existe");
  const r3 = await s.enviar(gw({ texto: "contas a pagar da subway", de: ESTRANHO, grupo: "120363000000000999@g.us" }));
  assert.deepEqual([r3.status, r3.motivo], ["IGNORADO", "GRUPO_NAO_AUTORIZADO"]);
  const textos = (await s.saida()).map((x) => x.texto).join("\n");
  assert.ok(!/123,45|777,77/.test(textos));
  assert.equal(s.chamadas.filter((c) => /consultar|detalhar|listar/i.test(c.nome)).length, 0, "nenhuma leitura financeira");
  assert.ok(s.cfg.gruposAutorizados.every((g) => g.grupoId !== ESTRANHO));
  // recusa auditada no histórico (sem conteúdo nem valores); a mensagem do não autorizado nem é guardada
  const hist = (await s.mova.armazenamento.historico.todos()).filter((h) => h.motivo === "GRUPO_NAO_AUTORIZADO");
  assert.ok(hist.length >= 1);
  assert.ok(!JSON.stringify(hist).match(/777|123,45|subway/i));
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.evento where participante_jid = $1", [ESTRANHO])).rows[0].n, 0);
});

t("X4 a configuração não dá conversa da Subway a ninguém do Açaí; participante com escopo Subway é recusado na montagem", async () => {
  const s = await montar();
  assert.ok(s.cfg.gruposAutorizados.every((g) => !g.unidades.includes(XIS)), "nem grupo, nem conversa derivada com a Subway");
  const { validarConfiguracao } = await import("../../src/modules/mova-financeiro/dominio/configuracao.js");
  const ruim = structuredClone(CFG);
  ruim.gruposAutorizados[0].participantes[0].unidades = [XIS];
  assert.throws(() => validarConfiguracao(ruim), /participantes/);
  const noGrupo = structuredClone(CFG);
  noGrupo.gruposAutorizados[0].unidades = [ALFA, XIS];
  assert.throws(() => validarConfiguracao(noGrupo), /semGrupo/);
});
