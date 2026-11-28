// 28/11 — MOVA Operador Financeiro (fase 1): CORREÇÃO CADASTRAL de conta a pagar pela conversa (fornecedor, vencimento, descrição,
// observação, forma de pagamento), pela operação OFICIAL do núcleo (corrigirContaAPagar, ação estreita 0036). Sem IA (texto lido sem
// modelo). Dados SINTÉTICOS. Financeiro v2 REAL em memória; banco do MOVA no PostgreSQL local isolado; nada sai para o WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarConcessoesMemoria, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, BETA, CONFIG, CONS, ESCOPOS, FIN, FINANCEIRO, GRUPO, OPER, ORG, PULAR, SO_ALFA, base, cenario, gw, t } from "./helpers/operacao.js";
import { USUARIO, provisionarAdministrador } from "../financeiro-v2/helpers/cenario.js";
import { motivoParaPular as motivoParaPularFv2, repositorioPostgresDeTeste } from "../financeiro-v2/helpers/postgres.js";
import { IDENTIDADE_DO_MOVA, sqlConcessaoDoMova, sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { interpretarPedidoDeCorrecao } from "../../src/modules/mova-financeiro/dominio/correcaoDeConta.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c9";
const CORRIGE = ["financeiro_v2.ver", "financeiro_v2.corrigir_conta_a_pagar"];
const CFG = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO" } : g)) };

// retrato padrão: só FINANCEIRO no grupo (como o grupo real) ⇒ os dados da conta podem sair no grupo; o OF-5 prova o caminho pelo privado
async function conversa({ concessao = CORRIGE, corrigirContas = true, repositorio = null, nucleoOperacional = null, membros = [FIN, SO_ALFA] } = {}) {
  let iaChamada = 0;
  // no banco real a LEITURA do MOVA usa a identidade de leitura de produção (concessão do kit oficial)
  const config = repositorio ? { ...CFG, identidadeServico: { usuarioId: IDENTIDADE_DO_MOVA } } : CFG;
  const s = await cenario({ responder: () => { iaChamada++; return base({}); }, config, repositorio, ...(repositorio ? { humano: USUARIO } : {}), extras: ({ nucleo }) => ({ autonomia: true, corrigirContas,
    operacional: criarPortaOperacional({ nucleo: nucleoOperacional ?? nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: repositorio ? IDENTIDADE_DO_MOVA : "eeeeeeee-0000-4000-8000-0000000000a2",
      concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }, { organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: BETA, acoes: concessao }]) }) }) });
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: AGORA.toISOString() });
  const cx = (u = ALFA) => s.c(ORG, u);
  // bebedouro (2 parcelas, IMOBILIZADO, cartão) e conta de energia (1 parcela, despesa), registrados pelo núcleo oficial
  const bebedouro = await s.m.nucleo.registrarContaParcelada(cx(), { contraparteNova: { tipo: "FORNECEDOR", nome: "Loja Sintética de Equipamentos" }, categoria: "IMOBILIZADO",
    descricao: "Bebedouro sintético", competencia: "2026-10", dataEmissao: "2026-10-15", formaPagamento: "CARTAO",
    parcelas: [{ vencimento: "2026-11-19", valorCentavos: 19450 }, { vencimento: "2026-12-19", valorCentavos: 19450 }], fonte: { sistema: "MANUAL", idExterno: "MOVA:beb-sintetico" } });
  const energia = (await s.m.nucleo.registrarObrigacao(cx(), { contraparteId: s.forn.id, valorOriginalCentavos: 31280, categoria: "INSUMOS", descricao: "Conta de energia sintética",
    competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-11-10" })).obrigacoes[0];
  const obrigacoes = async (u = ALFA) => (await s.m.nucleo.consultarRegistros(cx(u), { tipo: "OBRIGACAO" })).sort((a, b) => a.parcela.numero - b.parcela.numero);
  const porId = async (id, u = ALFA) => (await obrigacoes(u)).find((o) => o.id === id);
  const fornecedorDe = async (o) => (await s.m.nucleo.consultarRegistros(cx(), { tipo: "CONTRAPARTE" })).find((f) => f.id === o.contraparteId)?.nome;
  const decisao = async () => (await s.mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1);
  const texto = async () => (await s.saida()).at(-1)?.texto ?? "";
  const dizer = (t2, de = FIN, extra = {}) => s.enviar({ ...gw({ texto: t2, de, ...extra }) });
  const citandoUltima = async (t2, de = FIN) => {
    await s.banco.pool.query("update mova.resposta set provider_message_id = 'PM' || seq, estado = 'ENVIADA' where provider_message_id is null");
    const ultima = (await s.banco.pool.query("select provider_message_id from mova.resposta order by seq desc limit 1")).rows[0].provider_message_id;
    return dizer(t2, de, { respostaA: ultima });
  };
  const correcoes = async (u = ALFA) => (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: u })).filter((p) => p.tipo === "CORRECAO_DE_CONTA");
  return { ...s, bebedouro, energia, obrigacoes, porId, fornecedorDe, decisao, texto, dizer, citandoUltima, correcoes, ia: () => iaChamada };
}

t("OF-0 leitura do pedido (sem IA): campo, valor, parcela/todas, 'nessa conta' e termos; perguntas e pedidos de pagamento NÃO são correção", () => {
  const h = "2026-11-28";
  assert.deepEqual(interpretarPedidoDeCorrecao("MOVA, altere o fornecedor da segunda parcela do bebedouro.", h), { campo: "fornecedor", valor: null, bruto: null, valorInvalido: false, parcela: 2, todas: false, nessaConta: false, termos: ["bebedouro"], justificativa: null });
  assert.deepEqual(Object.values(interpretarPedidoDeCorrecao("MOVA, altere o vencimento da conta de energia para 15/12.", h)).slice(0, 2), ["vencimento", "2026-12-15"]);
  assert.equal(interpretarPedidoDeCorrecao("MOVA, adicione uma observação nessa conta: paga pela sócia", h).nessaConta, true);
  assert.equal(interpretarPedidoDeCorrecao("mude a forma de pagamento do aluguel para pix", h).valor, "PIX");
  assert.equal(interpretarPedidoDeCorrecao("troque o fornecedor de todas as parcelas do bebedouro para Gelo para Festas Sintético", h).valor, "Gelo para Festas Sintético", "o valor não é cortado no segundo 'para'");
  assert.equal(interpretarPedidoDeCorrecao("troque o fornecedor de todas as parcelas do bebedouro para X Sintético", h).todas, true);
  assert.equal(interpretarPedidoDeCorrecao("altere o vencimento da energia para 31/02", h).valorInvalido, true, "data impossível não vira outra data");
  for (const nao of ["qual o vencimento da conta de energia?", "MOVA, pague a conta de energia", "altere o vencimento e a descrição da energia", "contas a pagar da semana"]) assert.equal(interpretarPedidoDeCorrecao(nao, h), null, nao);
});

t("OF-1 'altere o fornecedor da SEGUNDA parcela do bebedouro': pergunta o novo, resume antes → depois, UMA confirmação; só a 2ª muda; conferido; sem IA; sem duplicidade", async () => {
  const s = await conversa();
  const [p1, p2] = s.bebedouro.obrigacoes;
  await s.dizer("MOVA, altere o fornecedor da segunda parcela do bebedouro.");
  assert.equal((await s.decisao()).motivo, "CORRECAO_PEDIR_VALOR", await s.texto());
  assert.match(await s.texto(), /Qual o novo fornecedor/);
  await s.dizer("Gelo Norte Sintético"); // resposta livre (memória curta), sem IA
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  assert.match(await s.texto(), /parcela 2\/2/);
  assert.match(await s.texto(), /Fornecedor: Loja Sintética de Equipamentos → Gelo Norte Sintético/);
  assert.equal(await s.fornecedorDe(await s.porId(p2.id)), "Loja Sintética de Equipamentos", "nada muda antes do sim");
  await s.dizer("sim");
  const d = await s.decisao();
  assert.deepEqual([d.decisao, d.motivo], ["EXECUTADO", "CORRECAO_EXECUTADA"], await s.texto());
  assert.match(await s.texto(), /Feito\. Fornecedor alterado de Loja Sintética de Equipamentos para Gelo Norte Sintético em 1 conta\. Conferido no Financeiro\./);
  assert.equal(await s.fornecedorDe(await s.porId(p2.id)), "Gelo Norte Sintético");
  const p1Agora = await s.porId(p1.id);
  assert.deepEqual([await s.fornecedorDe(p1Agora), p1Agora.versao], ["Loja Sintética de Equipamentos", p1.versao], "a 1ª parcela NÃO muda");
  assert.equal((await s.porId(p2.id)).valorBaseCentavos, 19450, "valor intacto");
  const [prop] = await s.correcoes();
  assert.deepEqual([prop.estado, (await s.correcoes()).length], ["APLICADA", 1]);
  assert.equal(await s.contar("operacao_executada"), 1);
  assert.equal(s.ia(), 0, "nenhuma chamada de IA");
  // "sim" repetido: nada de novo
  await s.dizer("sim");
  assert.equal(await s.contar("operacao_executada"), 1, "sem segunda execução");
  assert.equal((await s.porId(p2.id)).versao, (await s.porId(p2.id)).versao);
});

t("OF-2 vencimento com a conta inequívoca (sem pedir ID); observação em TODAS as parcelas pela escolha; 'nessa conta' citando a resposta do MOVA", async () => {
  const s = await conversa();
  await s.dizer("MOVA, altere o vencimento da conta de energia para 15/12.");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  assert.match(await s.texto(), /Vencimento: 10\/11\/2026 → 15\/12\/2026/);
  await s.dizer("sim");
  assert.equal((await s.porId(s.energia.id)).vencimento, "2026-12-15");
  // observação no bebedouro sem dizer a parcela: opções (cada parcela + todas)
  await s.dizer("MOVA, adicione uma observação no bebedouro: garantia de 12 meses");
  assert.equal((await s.decisao()).motivo, "CORRECAO_ESCOLHER_CONTA", await s.texto());
  assert.match(await s.texto(), /3\. Bebedouro sintético — TODAS as 2 parcelas/);
  await s.dizer("3");
  assert.match(await s.texto(), /todas as 2 parcelas/);
  await s.dizer("sim");
  assert.match(await s.texto(), /em 2 parcelas/);
  assert.ok((await s.obrigacoes()).filter((o) => o.grupoId === s.bebedouro.obrigacoes[0].grupoId).every((o) => o.observacao === "garantia de 12 meses"));
  // "nessa conta" citando a resposta do MOVA sobre a energia
  await s.dizer("MOVA, mude a forma de pagamento da conta de energia para boleto");
  await s.dizer("sim");
  assert.equal((await s.porId(s.energia.id)).formaPagamento, "BOLETO");
  await s.citandoUltima("adicione uma observação nessa conta: débito automático cancelado");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  await s.dizer("sim");
  assert.equal((await s.porId(s.energia.id)).observacao, "débito automático cancelado");
});

t("OF-3 segurança: só FINANCEIRO pede e confirma; 'não' cancela; conta paga e empréstimo ficam fora; chave desligada e concessão sem a ação não alteram nada", async () => {
  const s = await conversa();
  await s.dizer("MOVA, altere a descrição da conta de energia para Energia sintética de outubro", CONS);
  assert.equal((await s.decisao()).motivo, "CORRECAO_SEM_PERFIL_FINANCEIRO");
  await s.dizer("MOVA, altere a descrição da conta de energia para Energia sintética de outubro");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR");
  await s.dizer("sim", OPER); // operacional não confirma
  assert.equal((await s.porId(s.energia.id)).descricao, "Conta de energia sintética");
  await s.dizer("não");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CANCELADA");
  assert.equal((await s.porId(s.energia.id)).descricao, "Conta de energia sintética", "nada alterado");
  assert.equal((await s.correcoes())[0].estado, "REJEITADA");
  // conta paga: fora
  const paga = (await s.m.nucleo.registrarObrigacao(s.c(ORG, ALFA), { contraparteId: s.forn.id, valorOriginalCentavos: 5000, categoria: "INSUMOS", descricao: "Conta de gás sintética", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-10-10" })).obrigacoes[0];
  await s.m.nucleo.registrarPagamentoPorComprovante({ ...s.c(ORG, ALFA) }, { obrigacaoId: paga.id, valorCentavos: 5000, dataPagamento: "2026-10-10", idTransacao: "E1234567890123456789012345", justificativa: "Pago (sintético).", confirmar: true,
    comprovanteSemArquivo: { hashSha256: "b".repeat(64), tipoMime: "application/pdf", tamanhoBytes: 999 } });
  await s.dizer("MOVA, altere o vencimento da conta de gás para 20/12");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONTA_NAO_ELEGIVEL", await s.texto());
  // empréstimo: fora (proteção própria)
  await s.m.nucleo.registrarContaParceladaDeEmprestimo(s.c(ORG, ALFA), { contraparteNova: { tipo: "FORNECEDOR", nome: "Banco Sintético" }, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", descricao: "Empréstimo sintético",
    competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-12-15", valorCentavos: 50000 }], fonte: { sistema: "MANUAL", idExterno: "MOVA:emp-of3" } });
  await s.dizer("MOVA, altere o vencimento do empréstimo sintético para 20/12");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONTA_NAO_ELEGIVEL", await s.texto());
  // chave desligada / concessão sem a ação
  const off = await conversa({ corrigirContas: false });
  await off.dizer("MOVA, altere o vencimento da conta de energia para 15/12");
  assert.equal((await off.decisao()).motivo, "CORRECAO_DE_CONTAS_DESLIGADA");
  const sem = await conversa({ concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"] });
  await sem.dizer("MOVA, altere o vencimento da conta de energia para 15/12");
  await sem.dizer("sim");
  assert.match((await sem.decisao()).motivo, /SEM_CONCESSAO_OPERACIONAL/);
  assert.equal((await sem.porId(sem.energia.id)).vencimento, "2026-11-10", "nada alterado sem a concessão");
});

t("OF-4 concorrência e isolamento: conta alterada entre o resumo e o 'sim' ⇒ recusa, nada sobrescrito; FINANCEIRO só da Alfa nunca vê a conta da Beta; outro FINANCEIRO pode confirmar", async () => {
  const s = await conversa();
  await s.dizer("MOVA, altere a descrição da conta de energia para Energia A");
  // alguém altera a conta pela Central antes do "sim"
  const atual = await s.porId(s.energia.id);
  await s.m.nucleo.corrigirObrigacao(s.c(ORG, ALFA), { obrigacaoId: atual.id, mudancas: { descricao: "Energia pela Central" }, justificativa: "Correção pela Central (sintético).", versaoEsperada: atual.versao });
  await s.dizer("sim");
  // confirmação antiga invalidada (nada sobrescrito) ⇒ resumo ATUALIZADO com o valor atual
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  assert.match(await s.texto(), /A conta mudou depois do resumo: a confirmação anterior foi cancelada e nada foi alterado\. Resumo atualizado:\n[\s\S]*Descrição: Energia pela Central → Energia A/);
  assert.equal((await s.porId(s.energia.id)).descricao, "Energia pela Central", "a alteração legítima não é sobrescrita");
  await s.dizer("não"); // desiste do resumo atualizado (nada muda)
  assert.equal((await s.porId(s.energia.id)).descricao, "Energia pela Central");
  // isolamento: conta com o mesmo nome na Beta; quem é FINANCEIRO só da Alfa só vê a da Alfa
  await s.m.nucleo.registrarObrigacao(s.c(ORG, BETA), { contraparteId: (await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Fornecedor Beta Sintético" })).id,
    valorOriginalCentavos: 9900, categoria: "INSUMOS", descricao: "Conta de água sintética", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-11-12" });
  await s.m.nucleo.registrarObrigacao(s.c(ORG, ALFA), { contraparteId: s.forn.id, valorOriginalCentavos: 8800, categoria: "INSUMOS", descricao: "Conta de água sintética", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-11-12" });
  await s.dizer("MOVA, altere o vencimento da conta de água para 20/11", SO_ALFA);
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", "uma só candidata (a da Alfa)");
  assert.match(await s.texto(), /Loja Alfa/);
  // outro FINANCEIRO da unidade confirma (colaboração autorizada; quem confirmou fica na decisão)
  await s.dizer("sim", FIN);
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  assert.equal((await s.obrigacoes()).find((o) => o.descricao === "Conta de água sintética").vencimento, "2026-11-20");
  assert.equal((await s.obrigacoes(BETA))[0].vencimento, "2026-11-12", "a da Beta não muda");
  await s.dizer("MOVA, altere o vencimento da conta de água para 21/11");
  assert.equal((await s.decisao()).motivo, "CORRECAO_ESCOLHER_CONTA", "quem é FINANCEIRO nas duas vê as duas");
  // a lista mostra contas da Alfa E da Beta e um membro do grupo só tem a Alfa ⇒ vai SÓ para o privado de quem pediu
  const ult = (await s.saida()).slice(-2);
  assert.deepEqual([ult[0].destino, ult[1].destino, ult[1].texto], [FIN, GRUPO, "Os detalhes da conta foram para o seu privado."]);
  assert.match(ult[0].texto, /Loja Alfa[\s\S]*Loja Beta|Loja Beta[\s\S]*Loja Alfa/);
});

test("OF-PG conversa real até a CORREÇÃO PERSISTIDA no PostgreSQL isolado: identidade estreita (kit oficial, só corrigir_conta_a_pagar), só a 2ª parcela, histórico com antes/depois pela identidade do MOVA", { skip: PULAR || motivoParaPularFv2(), timeout: 300000 }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG, unidadeId: ALFA, escopos: ESCOPOS, usuarioId: USUARIO });
  const dono = await (await repositorio.interno()).dono();
  const cl = await dono.connect();
  try {
    await cl.query("begin");
    await cl.query(sqlConcessaoDoMova(ORG, ALFA));
    await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId: ORG, unidadeId: ALFA, acoes: CORRIGE, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional do MOVA — correção de contas (teste)" }));
    await cl.query("commit");
  } finally { cl.release(); }
  const nucleoOperacional = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const s = await conversa({ repositorio, nucleoOperacional });
  const [p1, p2] = s.bebedouro.obrigacoes;
  const r0 = await s.dizer("MOVA, altere o fornecedor da segunda parcela do bebedouro para Gelo Norte Sintético");
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", JSON.stringify([await s.decisao(), r0, (await s.banco.pool.query("select ultimo_erro, detalhe from mova.fila order by criado_em desc limit 1").catch(() => ({ rows: [] }))).rows]));
  await s.dizer("sim");
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", await s.texto());
  const linhas = (await dono.query(`select o.id, c.nome, o.versao, o.atualizado_por::text por, o.valor_base_centavos vb, o.situacao from fv2_obrigacao o join fv2_contraparte c on c.id = o.contraparte_id
    where o.organizacao_id = $1 and o.unidade_id = $2 and o.id = any($3::uuid[]) order by (o.parcela->>'numero')::int`, [ORG, ALFA, [p1.id, p2.id]])).rows;
  assert.deepEqual(linhas.map((l) => [l.nome, Number(l.vb), l.situacao]), [["Loja Sintética de Equipamentos", 19450, "ABERTA"], ["Gelo Norte Sintético", 19450, "ABERTA"]], "só a 2ª parcela mudou, no banco");
  assert.equal(linhas[1].por, OPERADOR, "gravado pela identidade ESTREITA do MOVA");
  const hist = (await dono.query("select antes->>'contraparteId' a, depois->>'contraparteId' d, usuario_id::text u from fv2_historico where registro_tipo = 'OBRIGACAO' and registro_id = $1 and evento = 'CORRECAO'", [p2.id])).rows;
  assert.equal(hist.length, 1);
  assert.notEqual(hist[0].a, hist[0].d);
  assert.equal(hist[0].u, OPERADOR);
  await s.dizer("sim");
  assert.equal(Number((await dono.query("select count(*) n from fv2_historico where registro_id = $1 and evento = 'CORRECAO'", [p2.id])).rows[0].n), 1, "sem segunda alteração");
});

t("OF-5 permissões de saída: com membro de CONSULTA no grupo, os dados da conta (antes/depois, opções) vão SÓ para o privado de quem pediu; no grupo, só o aviso; a confirmação no privado executa", async () => {
  const s = await conversa({ membros: [FIN, SO_ALFA, CONS] });
  const saidaDe = async () => (await s.saida()).map((r) => ({ destino: r.destino, texto: r.texto }));
  await s.dizer("MOVA, altere o vencimento da conta de energia para 15/12.");
  const saidas = await saidaDe();
  const noGrupo = saidas.filter((x) => x.destino === GRUPO);
  const noPrivado = saidas.filter((x) => x.destino !== GRUPO);
  assert.deepEqual(noGrupo.map((x) => x.texto), ["Os detalhes da conta foram para o seu privado."], "no grupo, só o aviso");
  assert.ok(noGrupo.every((x) => !/10\/11\/2026|15\/12\/2026|Fornecedor Sintético|R\$/.test(x.texto)), "nenhum dado da conta no grupo");
  assert.equal(noPrivado.length, 1);
  assert.equal(noPrivado[0].destino, FIN, "o privado de quem pediu");
  assert.match(noPrivado[0].texto, /Vencimento: 10\/11\/2026 → 15\/12\/2026/);
  // "sim" respondido NO PRIVADO
  await s.enviar({ ...gw({ texto: "sim", de: FIN, grupo: FIN }) });
  assert.equal((await s.decisao()).motivo, "CORRECAO_EXECUTADA", JSON.stringify(await saidaDe()));
  assert.equal((await s.porId(s.energia.id)).vencimento, "2026-12-15");
  const finais = (await saidaDe()).slice(saidas.length);
  assert.ok(finais.filter((x) => x.destino === GRUPO).every((x) => !/15\/12\/2026/.test(x.texto)), "o resultado também não expõe dados no grupo");
});

t("OF-6 várias parcelas: valores anteriores DIFERENTES aparecem por parcela; parcela alterada entre o resumo e o 'sim' ⇒ NENHUMA muda (tudo ou nada); parcela nova no grupo não entra", async () => {
  const s = await conversa();
  const [p1, p2] = s.bebedouro.obrigacoes;
  // a 1ª parcela já tem observação diferente da 2ª
  await s.m.nucleo.corrigirObrigacao(s.c(ORG, ALFA), { obrigacaoId: p1.id, mudancas: { descricao: "Bebedouro sintético (1ª)" }, justificativa: "Ajuste pela Central (sintético).", versaoEsperada: p1.versao });
  await s.dizer("MOVA, altere a descrição de todas as parcelas do bebedouro: Bebedouro industrial sintético");
  const resumo = await s.texto();
  assert.match(resumo, /Parcela 1\/2 — Descrição: Bebedouro sintético \(1ª\) → Bebedouro industrial sintético/, resumo);
  assert.match(resumo, /Parcela 2\/2 — Descrição: Bebedouro sintético → Bebedouro industrial sintético/);
  // alguém mexe na 2ª parcela antes do "sim"
  const p2a = await s.porId(p2.id);
  await s.m.nucleo.corrigirObrigacao(s.c(ORG, ALFA), { obrigacaoId: p2.id, mudancas: { vencimento: "2026-12-20" }, justificativa: "Ajuste pela Central (sintético).", versaoEsperada: p2a.versao });
  await s.dizer("sim");
  // confirmação antiga invalidada ⇒ resumo ATUALIZADO (com o conjunto e as versões atuais); nada foi alterado
  assert.equal((await s.decisao()).motivo, "CORRECAO_CONFIRMAR", await s.texto());
  assert.match(await s.texto(), /A conta mudou depois do resumo/);
  const depois = await s.obrigacoes();
  assert.deepEqual(depois.filter((o) => o.grupoId === p1.grupoId).map((o) => o.descricao), ["Bebedouro sintético (1ª)", "Bebedouro sintético"], "nenhuma parcela alterada");
});
