// 28/11 — MOVA Operador Financeiro, FASE 2 pela conversa (sem IA): reclassificar a compra, corrigir o valor de uma parcela, mudar a
// competência e cancelar parcela ou compra — mesmo padrão homologado no bebedouro (identificação, contexto, resumo antes → depois com o
// efeito na DRE, UMA confirmação autorizada, execução atômica pela ação estreita da 0037, conferência no Financeiro, auditoria).
// Dados SINTÉTICOS. Financeiro v2 REAL em memória (e, no OF2-PG, no PostgreSQL isolado); banco do MOVA no PostgreSQL isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarConcessoesMemoria, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, CONFIG, ESCOPOS, FIN, FINANCEIRO, GRUPO, ORG, PULAR, SO_ALFA, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { AGORA, USUARIO, provisionarAdministrador } from "../financeiro-v2/helpers/cenario.js";
import { motivoParaPular as motivoParaPularFv2, repositorioPostgresDeTeste } from "../financeiro-v2/helpers/postgres.js";
import { IDENTIDADE_DO_MOVA, sqlConcessaoDoMova, sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000002f2";
const OPERA = ["financeiro_v2.ver", "financeiro_v2.corrigir_conta_a_pagar", "financeiro_v2.reclassificar_conta_a_pagar", "financeiro_v2.ajustar_conta_a_pagar",
  "financeiro_v2.mover_competencia_conta_a_pagar", "financeiro_v2.cancelar_conta_a_pagar"];
const CFG = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO" } : g)) };

async function conversa({ operarContas = true, concessao = OPERA, repositorio = null, nucleoOperacional = null } = {}) {
  let ia = 0;
  const config = repositorio ? { ...CFG, identidadeServico: { usuarioId: IDENTIDADE_DO_MOVA } } : CFG;
  const s = await cenario({ responder: () => { ia++; return base({}); }, config, repositorio, ...(repositorio ? { humano: USUARIO } : {}), extras: ({ nucleo }) => ({ autonomia: true, corrigirContas: true, operarContas,
    operacional: criarPortaOperacional({ nucleo: nucleoOperacional ?? nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: repositorio ? IDENTIDADE_DO_MOVA : "eeeeeeee-0000-4000-8000-0000000000a2",
      concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }]) }) }) });
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SO_ALFA], verificadoEm: AGORA.toISOString() });
  const cx = () => s.c(ORG, ALFA);
  const freezer = await s.m.nucleo.registrarContaParcelada(cx(), { contraparteNova: { tipo: "FORNECEDOR", nome: "Loja Sintética F2" }, categoria: "IMOBILIZADO", descricao: "Freezer sintético",
    competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-11-15", valorCentavos: 30000 }, { vencimento: "2026-12-15", valorCentavos: 30000 }, { vencimento: "2027-01-15", valorCentavos: 30000 }],
    fonte: { sistema: "MANUAL", idExterno: "MOVA:f2-freezer" } });
  const energia = await s.m.nucleo.registrarContaParcelada(cx(), { contraparteNova: { tipo: "FORNECEDOR", nome: "Companhia Sintética de Energia" }, categoria: "ENERGIA", descricao: "Conta de energia sintética",
    competencia: "2026-10", dataEmissao: "2026-10-05", parcelas: [{ vencimento: "2026-11-10", valorCentavos: 40000 }, { vencimento: "2026-12-10", valorCentavos: 40000 }], fonte: { sistema: "MANUAL", idExterno: "MOVA:f2-energia" } });
  const parcelasDe = async (g) => (await s.m.nucleo.consultarRegistros(cx(), { tipo: "OBRIGACAO" })).filter((o) => o.grupoId === g.obrigacoes[0].grupoId).sort((a, b) => a.parcela.numero - b.parcela.numero);
  const parcelas = async () => (await s.m.nucleo.consultarRegistros(cx(), { tipo: "OBRIGACAO" })).filter((o) => o.grupoId === freezer.obrigacoes[0].grupoId).sort((a, b) => a.parcela.numero - b.parcela.numero);
  const lancamentos = async () => s.m.nucleo.consultarRegistros(cx(), { tipo: "LANCAMENTO" });
  const compra = async () => (await lancamentos()).find((l) => l.id === freezer.lancamento.id);
  const decisao = async () => (await s.mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1);
  const texto = async () => (await s.saida()).at(-1)?.texto ?? "";
  const dizer = (x, de = FIN) => s.enviar({ ...gw({ texto: x, de }) });
  return { ...s, freezer, energia, parcelasDe, parcelas, lancamentos, compra, decisao, texto, dizer, ia: () => ia };
}

t("OF2-1 categoria da COMPRA inteira com o efeito na DRE; uma confirmação; a classificação por parcela não é oferecida", async () => {
  const s = await conversa();
  await s.dizer("MOVA, altere a categoria da segunda parcela do freezer para manutenção");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  const r = await s.texto();
  assert.match(r, /Categoria da compra Freezer sintético \(R\$ 900,00 em 3 parcelas\): Compra de equipamentos e bens → Manutenção/);
  assert.match(r, /Na DRE de 10\/2026: R\$ 900,00 passa a ser despesa em Manutenção.* \(antes era equipamento, fora da DRE\)/);
  assert.match(r, /Contas a pagar, vencimentos e fluxo de caixa previsto não mudam\. Caixa realizado e pagamentos feitos não mudam\./);
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  assert.match(await s.texto(), /Categoria da compra Freezer sintético alterada de Compra de equipamentos e bens para Manutenção.*Conferido no Financeiro/);
  assert.deepEqual([(await s.compra()).categoria, (await s.compra()).valorCentavos], ["MANUTENCAO", 90000]);
  assert.equal(s.ia(), 0);
});

t("OF2-2 valor de UMA parcela: anterior, correto e diferença; o original fica; sem parcela indicada ⇒ pergunta qual (nunca todas)", async () => {
  const s = await conversa();
  await s.dizer("MOVA, corrija o valor do freezer: R$ 325,00");
  assert.equal((await s.decisao()).motivo, "CORRECAO_ESCOLHER_CONTA");
  assert.doesNotMatch(await s.texto(), /compra inteira|TODAS/, "valor é por parcela");
  await s.dizer("2");
  assert.equal((await s.decisao()).motivo, "CORRECAO_PEDIR_JUSTIFICATIVA", "sem motivo dito: pergunta antes do resumo");
  await s.dizer("o frete foi cobrado à parte");
  const r = await s.texto();
  assert.match(r, /Valor original: R\$ 300,00 · valor atual: R\$ 300,00 · novo valor: R\$ 325,00 \(diferença \+R\$ 25,00\)/);
  assert.match(r, /Já pago: R\$ 0,00 · saldo anterior: R\$ 300,00 · novo saldo: R\$ 325,00/);
  assert.match(r, /Justificativa: o frete foi cobrado à parte/);
  assert.match(r, /Impacto: Não afeta a DRE: compra de equipamento \(patrimonial/, "equipamento não está na DRE");
  assert.match(r, /fluxo de caixa previsto \(vencimento 15\/12\/2026\): \+R\$ 25,00\. Caixa realizado e pagamentos feitos não mudam/);
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  const ps = await s.parcelas();
  assert.deepEqual(ps.map((o) => [o.valorBaseCentavos, o.ajustesCentavos, o.saldoCentavos]), [[30000, 0, 30000], [30000, 2500, 32500], [30000, 0, 30000]]);
  const aj = (await s.m.nucleo.consultarRegistros(s.c(ORG, ALFA), { tipo: "AJUSTE" })).find((a) => a.alvoId === ps[1].id);
  assert.equal(aj.motivo, "o frete foi cobrado à parte", "a justificativa REAL vai para o histórico");
});

t("OF2-3 competência da compra (lançamento + parcelas) com o efeito nos dois meses; vencimentos intactos", async () => {
  const s = await conversa();
  await s.dizer("MOVA, mude a competência do freezer para novembro/2026");
  assert.match(await s.texto(), /Competência da compra Freezer sintético \(R\$ 900,00\): 10\/2026 → 11\/2026\.\nNão afeta a DRE \(compra de equipamento, patrimonial\)/);
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  assert.equal((await s.compra()).competencia, "2026-11");
  assert.deepEqual((await s.parcelas()).map((o) => [o.competencia, o.vencimento]), [["2026-11", "2026-11-15"], ["2026-11", "2026-12-15"], ["2026-11", "2027-01-15"]]);
});

t("OF2-4 cancelar: a parcela pedida (só ela, ajuste auditado); sem dizer qual ⇒ opções com 'a compra inteira'; nunca presume todas", async () => {
  const s = await conversa();
  await s.dizer("MOVA, cancele a terceira parcela do freezer, motivo: item devolvido");
  assert.match(await s.texto(), /Cancelar a parcela 3\/3 de Freezer sintético \(R\$ 300,00, vence 15\/01\/2027\)\. As outras parcelas continuam\.\nJustificativa: item devolvido/);
  assert.match(await s.texto(), /Nada é apagado: a compra original fica registrada/);
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  assert.deepEqual((await s.parcelas()).map((o) => o.situacao), ["ABERTA", "ABERTA", "CANCELADA"]);
  await s.dizer("MOVA, cancele o freezer");
  assert.equal((await s.decisao()).motivo, "CORRECAO_ESCOLHER_CONTA", "sem dizer parcela ou compra: pergunta");
  assert.match(await s.texto(), /3\. Freezer sintético — a compra inteira/);
  await s.dizer("3");
  await s.dizer("pedido cancelado com a loja");
  assert.match(await s.texto(), /Cancelar a compra inteira Freezer sintético: 2 parcela\(s\) em aberto \(R\$ 600,00\)/);
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  assert.ok((await s.parcelas()).every((o) => o.situacao === "CANCELADA"));
  assert.equal((await s.compra()).situacao, "CANCELADO", "nada apagado: cancelado");
});

t("OF2-5 travas: chave desligada; parcela paga ⇒ Central; 'não' desiste; sem a ação estreita nada muda", async () => {
  const off = await conversa({ operarContas: false });
  await off.dizer("MOVA, mude a competência do freezer para novembro/2026");
  assert.equal((await off.decisao()).motivo, "CORRECAO_DE_CONTAS_DESLIGADA");
  const s = await conversa();
  const [p1] = await s.parcelas();
  await s.m.nucleo.registrarPagamentoPorComprovante(s.c(ORG, ALFA), { obrigacaoId: p1.id, valorCentavos: 30000, dataPagamento: "2026-10-15", idTransacao: "E1234567890123456789012399", justificativa: "Pago (sintético).", confirmar: true,
    comprovanteSemArquivo: { hashSha256: "c".repeat(64), tipoMime: "application/pdf", tamanhoBytes: 9 } });
  await s.dizer("MOVA, cancele a primeira parcela do freezer");
  assert.equal((await s.decisao()).motivo, "CORRECAO_PARCELA_NAO_ENCONTRADA", "a paga nem aparece como opção");
  await s.dizer("MOVA, mude a competência do freezer para novembro/2026");
  assert.match(await s.texto(), /pagamento, ajuste ou parcela cancelada\. A alteração é pela Central Financeira \(revisão humana\)/);
  await s.dizer("MOVA, cancele a segunda parcela do freezer porque foi devolvida");
  await s.dizer("não");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CANCELADA");
  assert.equal((await s.parcelas())[1].situacao, "ABERTA");
  const sem = await conversa({ concessao: ["financeiro_v2.ver", "financeiro_v2.corrigir_conta_a_pagar"] });
  await sem.dizer("MOVA, cancele a segunda parcela do freezer porque foi devolvida");
  await sem.dizer("sim");
  assert.match((await sem.decisao()).motivo, /SEM_CONCESSAO_OPERACIONAL/);
  assert.equal((await sem.parcelas())[1].situacao, "ABERTA");
});

test("OF2-PG pela conversa até o PostgreSQL: identidade estreita (kit oficial, ações da 0037) corrige o valor e cancela uma parcela; histórico pela identidade do MOVA", { skip: PULAR || motivoParaPularFv2(), timeout: 300000 }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG, unidadeId: ALFA, escopos: ESCOPOS, usuarioId: USUARIO });
  const dono = await (await repositorio.interno()).dono();
  const cl = await dono.connect();
  try {
    await cl.query("begin");
    await cl.query(sqlConcessaoDoMova(ORG, ALFA));
    await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: ORG, unidadeId: ALFA, acoes: OPERA, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional — fase 2 (teste)" }));
    await cl.query("commit");
  } finally { cl.release(); }
  const nucleoOperacional = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const s = await conversa({ repositorio, nucleoOperacional });
  await s.dizer("MOVA, altere o valor da segunda parcela do freezer para R$ 325,00 porque o frete foi à parte");
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  await s.dizer("MOVA, cancele a terceira parcela do freezer porque o item foi devolvido");
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  const ob = (await dono.query("select (parcela->>'numero')::int n, situacao, valor_base_centavos vb, ajustes_centavos aj, saldo_centavos sd, atualizado_por::text por from fv2_obrigacao where lancamento_id = $1 order by 1", [s.freezer.lancamento.id])).rows;
  assert.deepEqual(ob.map((o) => [o.n, o.situacao, Number(o.vb), Number(o.aj), Number(o.sd)]), [[1, "ABERTA", 30000, 0, 30000], [2, "ABERTA", 30000, 2500, 32500], [3, "CANCELADA", 30000, -30000, 0]]);
  assert.ok(ob.slice(1).every((o) => o.por === OPERADOR), "gravado pela identidade ESTREITA");
  const aj = (await dono.query("select count(*)::int n from fv2_ajuste a join fv2_lancamento l on l.id = a.lancamento_id where a.alvo_id = any($1::uuid[]) and l.categoria_codigo = 'IMOBILIZADO' and l.criado_por = $2", [ob.map(() => null).length ? (await dono.query("select array_agg(id) ids from fv2_obrigacao where lancamento_id = $1", [s.freezer.lancamento.id])).rows[0].ids : [], OPERADOR])).rows[0].n;
  assert.equal(aj, 2, "dois ajustes auditados (valor e cancelamento), na categoria da compra");
});

t("OF2-6 despesa (na DRE): valor, competência e cancelamento dizem o efeito na DRE do mês; equipamento não", async () => {
  const s = await conversa();
  await s.dizer("MOVA, altere o valor da segunda parcela da conta de energia para R$ 380,00 porque a leitura do medidor foi corrigida");
  const r = await s.texto();
  assert.match(r, /Impacto: Na DRE de 10\/2026: a despesa diminui R\$ 20,00 em Energia elétrica\./);
  assert.match(r, /fluxo de caixa previsto \(vencimento 10\/12\/2026\): −R\$ 20,00/);
  await s.dizer("não");
  await s.dizer("MOVA, mude a competência da conta de energia para novembro/2026");
  assert.match(await s.texto(), /Na DRE: R\$ 800,00 sai de 10\/2026 e entra em 11\/2026\./);
});

t("OF2-7 última parcela restante: explica e pede o cancelamento da compra (nunca converte sozinho); nada muda", async () => {
  const s = await conversa();
  await s.dizer("MOVA, cancele a primeira parcela da conta de energia porque foi cobrada em duplicidade");
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  await s.dizer("MOVA, cancele a segunda parcela da conta de energia porque o contrato foi encerrado");
  assert.equal((await s.decisao()).motivo, "CORRECAO_ULTIMA_PARCELA", await s.texto());
  assert.match(await s.texto(), /é a única que resta em aberto .* cancelar ela é cancelar a compra inteira\. Se é isso, peça "cancele a compra Conta de energia sintética"\. Nada foi alterado\./);
  assert.deepEqual((await s.parcelasDe(s.energia)).map((o) => o.situacao), ["CANCELADA", "ABERTA"]);
});

t("OF2-8 integridade: a compra muda (categoria) entre o resumo do VALOR e o 'sim' ⇒ a confirmação antiga é invalidada, nada muda e um resumo ATUALIZADO é apresentado; o 'sim' seguinte executa o novo", async () => {
  const s = await conversa();
  await s.dizer("MOVA, altere o valor da segunda parcela do freezer para R$ 325,00 porque o frete foi à parte");
  assert.match(await s.texto(), /Não afeta a DRE: compra de equipamento/);
  // alguém reclassifica a compra pela Central (o lançamento muda de versão e de natureza)
  const ps = await s.parcelas(); const l = await s.compra();
  await s.m.nucleo.reclassificarContaAPagar({ ...s.c(ORG, ALFA) }, { obrigacaoId: ps[0].id, categoria: "MANUTENCAO", versoes: Object.fromEntries([...ps, l].map((x) => [x.id, x.versao])), justificativa: "Reclassificada pela Central (sintético)." });
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  const r = await s.texto();
  assert.match(r, /A conta mudou depois do resumo: a confirmação anterior foi cancelada e nada foi alterado\. Resumo atualizado:/);
  assert.match(r, /Impacto: Na DRE de 10\/2026: a despesa aumenta R\$ 25,00 em Manutenção/, "o impacto agora é na DRE (despesa)");
  assert.equal((await s.parcelas())[1].ajustesCentavos, 0, "nada foi alterado pela confirmação antiga");
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  assert.equal((await s.parcelas())[1].saldoCentavos, 32500);
  const correcoes = (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.tipo === "CORRECAO_DE_CONTA");
  assert.deepEqual(correcoes.map((x) => x.estado).sort(), ["APLICADA", "REJEITADA"]);
});
