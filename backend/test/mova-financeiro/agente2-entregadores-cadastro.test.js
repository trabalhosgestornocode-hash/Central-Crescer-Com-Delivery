// MOVA — Agente 2 (23/11/2026): CADASTRO COMPLETO DOS ENTREGADORES (fonte única Financeiro + MOVA) e CONFIGURAÇÃO VIVA (vale sem
// reinício). Tudo sintético; nada sai para o WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarArmazenamentoMemoria } from "../../src/modules/mova-financeiro/infra/memoria.js";
import { configuracaoViva } from "../../src/modules/mova-financeiro/dominio/configuracao.js";
import { ACOES_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { criarEnviadorDeRespostas } from "../../src/modules/mova-financeiro/index.js";
import { GRUPO, cenario, t } from "./helpers/operacao.js";

const ORG = "eeeeeeee-0000-4000-8000-0000000000f1";
const ALFA = "eeeeeeee-0000-4000-8000-0000000000a1";
const GAMA = "eeeeeeee-0000-4000-8000-0000000000c1";
const USU = "eeeeeeee-0000-4000-8000-000000000001";
const GRUPO_ALFA = "120363000000000001@g.us";
const CFG = Object.freeze({
  unidades: [{ organizacaoId: ORG, unidadeId: ALFA, nome: "Loja Alfa Sintética" }],
  gruposAutorizados: [{ grupoId: GRUPO_ALFA, unidades: [ALFA], privada: false, participantes: [{ telefones: ["+5585999990001"] }] }],
  entregadores: [],
});
const OFICIAIS = { "ent-a": "Entregador A", "ent-b": "Entregador B" };
const nucleo = { async consultarEntregador(_c, { entregador }) {
  if (!OFICIAIS[entregador]) throw Object.assign(new Error("x"), { codigo: "FV2_NAO_ENCONTRADO" });
  return { fechamentos: [{ semanaInicio: "2026-11-16", entregador: { chave: entregador, nome: OFICIAIS[entregador] } }] };
} };
const ctx = { organizacaoId: ORG, unidadeId: ALFA, usuarioId: USU, permissoes: ["financeiro_v2.ver", "financeiro_v2.configurar"] };
const acao = (nome, mova, b, c = ctx) => executarAcaoMova(ACOES_MOVA[nome], { ctx: c, mova, nucleo, b });

test("C1 troca de número: encerra a linha antiga (quem, quando, por quê) e abre a nova; auditoria com anterior/atual MASCARADOS; conflito e número da equipe recusados", async () => {
  const a = criarArmazenamentoMemoria();
  const mova = { armazenamento: a, cfg: CFG };
  await acao("/mova/entregador", mova, { entregador: "ent-a", telefone: "(85) 99999-0011", observacoes: "Turno da noite" });
  await acao("/mova/entregador", mova, { entregador: "ent-b", telefone: "(85) 99999-0022" });
  const r = await acao("/mova/entregador-alterar", mova, { entregador: "ent-a", telefone: "85 98888-0033" });
  assert.deepEqual([r.alterado, r.motivo, r.telefone], [true, "TROCA_DE_NUMERO", "…0033"]);
  const linhas = (await a.entregadores.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.chave === "ent-a");
  assert.deepEqual(linhas.map((x) => [x.telefone, x.ativo, x.motivoRevogacao]), [["…0033", true, null], ["…0011", false, "TROCA_DE_NUMERO"]]);
  assert.equal(linhas[1].revogadoPor, USU);
  assert.equal(linhas[0].observacoes, "Turno da noite", "a observação acompanha a troca");
  const aud = (await a.auditoria.listar()).find((x) => x.acao === "ENTREGADOR_NUMERO_TROCADO");
  assert.deepEqual([aud.dados.anterior, aud.dados.atual], ["…0011", "…0033"]);
  assert.ok(!JSON.stringify(await a.auditoria.listar()).includes("999990011"), "o número completo nunca vai para a auditoria");
  await assert.rejects(acao("/mova/entregador-alterar", mova, { entregador: "ent-a", telefone: "(85) 99999-0022" }), (e) => e.codigo === "NUMERO_JA_CADASTRADO");
  await assert.rejects(acao("/mova/entregador-alterar", mova, { entregador: "ent-a", telefone: "(85) 99999-0001" }), (e) => e.codigo === "NUMERO_DA_EQUIPE");
  await assert.rejects(acao("/mova/entregador-alterar", mova, { entregador: "ent-a" }), (e) => e.codigo === "PARAMETRO_INVALIDO");
  assert.equal((await acao("/mova/entregador-alterar", mova, { entregador: "ent-a", telefone: "85 98888-0033" })).alterado, false, "sem mudança, nada muda");
  const ed = await acao("/mova/entregador-alterar", mova, { entregador: "ent-a", nome: "Zé", observacoes: "" });
  assert.equal(ed.motivo, "EDICAO");
  const [vig] = (await a.entregadores.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.chave === "ent-a" && x.ativo);
  assert.deepEqual([vig.nome, vig.observacoes, vig.telefone], ["Zé", null, "…0033"]);
  await assert.rejects(acao("/mova/entregador-alterar", mova, { entregador: "ent-a", nome: "x" }, { ...ctx, permissoes: ["financeiro_v2.ver"] }), (e) => e.codigo === "PERMISSAO_INSUFICIENTE");
});

test("C2 desativar e reativar: o histórico fica; reativa o último número; não reativa ativo nem quem nunca foi cadastrado", async () => {
  const a = criarArmazenamentoMemoria();
  const mova = { armazenamento: a, cfg: CFG };
  await acao("/mova/entregador", mova, { entregador: "ent-a", telefone: "(85) 99999-0011" });
  await assert.rejects(acao("/mova/entregador-reativar", mova, { entregador: "ent-a" }), (e) => e.codigo === "ENTREGADOR_OU_NUMERO_JA_CADASTRADO");
  await acao("/mova/entregador-revogar", mova, { entregador: "ent-a" });
  const r = await acao("/mova/entregador-reativar", mova, { entregador: "ent-a" });
  assert.deepEqual([r.reativado, r.telefone], [true, "…0011"]);
  const linhas = await a.entregadores.listar({ organizacaoId: ORG, unidadeId: ALFA });
  assert.deepEqual(linhas.map((x) => [x.ativo, x.motivoRevogacao]), [[true, null], [false, "DESATIVADO"]]);
  await assert.rejects(acao("/mova/entregador-reativar", mova, { entregador: "ent-b" }), (e) => e.codigo === "ENTREGADOR_NAO_CADASTRADO");
});

test("C3 unidade NÃO atendida pelo MOVA (ex.: Subway sem grupo): cadastro recusado — antes, gravaria e derrubaria a montagem no reinício", async () => {
  const mova = { armazenamento: criarArmazenamentoMemoria(), cfg: CFG };
  await assert.rejects(acao("/mova/entregador", mova, { entregador: "ent-a", telefone: "(85) 99999-0011" }, { ...ctx, unidadeId: GAMA }), (e) => e.codigo === "UNIDADE_FORA_DO_MOVA");
});

test("C4 configuração viva: só a lista de entregadores muda sem reinício; qualquer outra mudança exige reinício; leitura com validade", async () => {
  const conv = { grupoId: "5585999990011@s.whatsapp.net", unidades: [ALFA], privada: true, derivada: true, entregador: { chave: "ent-a", unidadeId: ALFA } };
  const ent = { organizacaoId: ORG, unidadeId: ALFA, chave: "ent-a", telefoneE164: "+5585999990011", privado: conv.grupoId, ativo: true };
  let proxima = { ...CFG, gruposAutorizados: [...CFG.gruposAutorizados, conv], entregadores: [ent] };
  let agora = 0;
  const viva = configuracaoViva(CFG, { recarregar: async () => proxima, relogio: () => agora });
  assert.equal(viva.gruposAutorizados.length, 1);
  assert.deepEqual(await viva.recarregarEntregadores(), { trocado: false, motivo: "DENTRO_DA_VALIDADE" });
  assert.deepEqual(await viva.recarregarEntregadores({ forcar: true }), { trocado: true });
  assert.equal(viva.gruposAutorizados.length, 2);
  assert.equal(viva.entregadores[0].chave, "ent-a");
  proxima = { ...proxima, unidades: [...CFG.unidades, { organizacaoId: ORG, unidadeId: GAMA, nome: "Outra" }] };
  agora = 61_000;
  assert.deepEqual(await viva.recarregarEntregadores(), { trocado: false, motivo: "OUTRAS_MUDANCAS_EXIGEM_REINICIO" });
  assert.equal(viva.unidades.length, 1, "unidade nova não entra sem reinício");
  assert.ok(Object.isFrozen(viva));
  // Pela rota: o cadastro passa a valer NA HORA
  const mova = { armazenamento: criarArmazenamentoMemoria(), cfg: configuracaoViva(CFG, { recarregar: async () => CFG }) };
  assert.equal((await acao("/mova/entregador", mova, { entregador: "ent-b", telefone: "(85) 99999-0044" })).vigencia, "IMEDIATA");
});

t("C5 número antigo: com a lista viva, a resposta pendente para o número trocado NÃO sai; a do número novo sai", async () => {
  const s = await cenario();
  const ANTIGO = "5585999990011@s.whatsapp.net", NOVO = "5585988880033@s.whatsapp.net";
  for (const [d, x] of [[ANTIGO, "para o antigo"], [NOVO, "para o novo"], [GRUPO, "grupo"]]) await s.mova.armazenamento.saida.enfileirar({ grupoId: d, respostaA: x, texto: x, eventoId: null });
  let destinos = [GRUPO, ANTIGO];
  const enviados = [];
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: () => destinos, limitePorRodada: 10,
    enviar: async (r) => { enviados.push(r.texto); return { providerMessageId: `P${enviados.length}` }; } });
  destinos = [GRUPO, NOVO]; // troca de número aplicada na configuração viva ANTES do envio
  await e.enviarPendentes();
  assert.deepEqual(enviados.sort(), ["grupo", "para o novo"]);
  destinos = [];
  assert.equal((await e.enviarPendentes()).semDestinos, true, "lista vazia ⇒ nada sai");
});

t("C6 PostgreSQL: trocar e reativar numa transação; histórico na própria tabela; unicidade do número ativo garantida pelo banco", async () => {
  const s = await cenario();
  const a = s.mova.armazenamento.entregadores;
  const esc = { organizacaoId: ORG, unidadeId: ALFA };
  await a.cadastrar({ ...esc, chave: "ent-a", telefoneE164: "+5585999990011", privado: "5585999990011@s.whatsapp.net", nome: "A", cadastradoPor: USU, observacoes: "obs" });
  await a.cadastrar({ ...esc, chave: "ent-b", telefoneE164: "+5585999990022", privado: "5585999990022@s.whatsapp.net", nome: "B", cadastradoPor: USU });
  assert.deepEqual(await a.alterar({ ...esc, chave: "ent-a", por: USU, mudancas: { telefoneE164: "+5585999990022", privado: "5585999990022@s.whatsapp.net" } }), { conflito: true });
  assert.equal((await a.listar(esc)).filter((x) => x.chave === "ent-a" && x.ativo).length, 1, "conflito desfaz tudo");
  const r = await a.alterar({ ...esc, chave: "ent-a", por: USU, mudancas: { telefoneE164: "+5585988880033", privado: "5585988880033@s.whatsapp.net" } });
  assert.equal(r.motivo, "TROCA_DE_NUMERO");
  assert.equal(await a.revogar({ ...esc, chave: "ent-a", por: USU }), 1);
  assert.equal((await a.reativar({ ...esc, chave: "ent-a", por: USU })).telefone, "…0033");
  const h = (await a.listar(esc)).filter((x) => x.chave === "ent-a");
  assert.deepEqual(h.map((x) => [x.telefone, x.ativo, x.motivoRevogacao, x.observacoes]), [["…0033", true, null, "obs"], ["…0033", false, "DESATIVADO", "obs"], ["…0011", false, "TROCA_DE_NUMERO", "obs"]]);
});
