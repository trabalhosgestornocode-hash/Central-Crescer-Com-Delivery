// 27/11 — CONTA RELATADA GENERALIZADA (qualquer obrigação, não só compra) e as três causas do caso real do "empréstimo BNB":
//   (1) na retomada depois da 2ª pergunta (mês), a unidade já confirmada era recalculada só do texto original ⇒ "unidades diferentes";
//   (2) esse bloqueio pedia "responda a esta mensagem" sem guardar pendência ⇒ a resposta caía na conversa comum;
//   (3) o pedido "registrar uma conta de R$ …" ia para o MOVA CORE (só rascunho: "escritas pela conversa não estão habilitadas").
// Dados SINTÉTICOS (nomes, bancos e valores fictícios). Financeiro v2 REAL em memória; banco do MOVA no PostgreSQL local isolado;
// IA SIMULADA (só a leitura da intenção; valores, datas, observações e competência são lidos sem IA). Nada sai para o WhatsApp.
import assert from "node:assert/strict";
import { criarConcessoesMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ALFA, BETA, CONFIG, FIN, FINANCEIRO, GRUPO, ORG, base, cenario, gw, t } from "./helpers/operacao.js";
import { criarPortaOperacional } from "../../src/modules/mova-financeiro/index.js";
import { interpretarContaRelatada, classificarContaRelatada, complementoDaResposta } from "../../src/modules/mova-financeiro/dominio/contaRelatada.js";
import { competenciaDaResposta } from "../../src/modules/mova-financeiro/dominio/divergencia.js";
import { AGORA, TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";

const HUMANO = "eeeeeeee-0000-4000-8000-000000000001";
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c7";
const SOCIO = "5500000000211@s.whatsapp.net";
const CONFIG_GRUPO = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO",
  participantes: [...g.participantes, { ids: [SOCIO], perfil: "FINANCEIRO" }] } : g)) };
const UNIDADES = [{ apelidos: ["alfa"] }, { apelidos: ["beta"] }];

// Caso real (dados sintéticos): empréstimo com composição por pessoa, total dito e observação com OUTRA data (desconto em folha).
// (grupo por LISTA: texto livre entra quando chama o MOVA pelo nome — no caso real o 1º veio como DOCUMENTO e a instrução como resposta)
const EMPRESTIMO = "MOVA, Empréstimo Banco Sintético alfa — Pessoa Um e Pessoa Dois\nPessoa Um: R$ 395,34\nPessoa Dois: R$ 2.515,74\nTotal: R$ 2.911,08\nObs.: descontar os valores da remuneração de novembro/2026 no dia 07/12/2026.";
const EMPRESTIMO_INSTRUCAO = "MOVA, Loja Alfa.\n\nRegistrar uma única conta de R$ 2.911,08, na categoria Empréstimos — Banco do Sertão Sintético (BSS).\n\nDescrição: Empréstimo BSS — Pessoa Um e Pessoa Dois.\n\nObservações:\nPessoa Um: R$ 395,34.\nPessoa Dois: R$ 2.515,74.\n\nNão criar contas individuais nem realizar descontos salariais automaticamente.";
const ALUGUEL = "MOVA, registrar aluguel da alfa, R$ 4.230,12, vence 10/12, referente a dezembro, credor Imobiliária Sintética";
const HONORARIOS = "MOVA, registrar honorários contábeis da alfa, R$ 810,00, vence 10/12, competência 11/2026, fornecedor Contábil Sintética";
const EQUIPAMENTO = "MOVA, compra de freezer para a alfa, R$ 3.000,00 em 3 parcelas 10/12, 10/01 e 10/02, total";
// IA simulada: relato ⇒ REGISTRAR_CONTA (sem competência: a competência só vale DITA e é lida sem IA); respostas curtas nunca chegam aqui
const RELATOS = /Empréstimo|aluguel|honorários|freezer|Registrar uma única/i;
// (a categoria sugerida segue o assunto, como a leitura real; ela só desempata dentro do plano)
const SUGESTAO = [[/honorários/i, "CONTABILIDADE"], [/aluguel/i, "ALUGUEL"], [/freezer/i, "EQUIPAMENTOS"], [/Empréstimo|Registrar uma única/i, "EMPRESTIMO"]];
const LEITURA = (req) => { const j = JSON.stringify(req.messages ?? ""); const s = SUGESTAO.find(([re]) => re.test(j));
  return RELATOS.test(j) ? base({ intencao: "REGISTRAR_CONTA", valorCentavos: 291108, categoriaSugerida: s?.[1] ?? null }) : base({}); };

async function relatada({ politicas = [], concessao = null, criarContas = false, criarDespesas = false, responder = LEITURA, comCore = false } = {}) {
  const core = [];
  const s = await cenario({
    responder, config: CONFIG_GRUPO,
    extras: ({ nucleo }) => ({
      autonomia: true, criarContas, criarDespesas, pagamentoPorComprovante: criarDespesas,
      ...(concessao ? { operacional: criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: "eeeeeeee-0000-4000-8000-0000000000a2",
        concessoes: criarConcessoesMemoria([{ organizacaoId: ORG, usuarioId: OPERADOR, unidadeId: ALFA, acoes: concessao }]) }) } : {}),
      // MOVA CORE ligado no grupo (como em produção): responde qualquer texto que chegar a ele — o pedido de registrar NÃO pode chegar
      ...(comCore ? { conversaNova: { modo: "RESPOSTA", grupos: [GRUPO], atender: async ({ evento }) => { core.push(evento.texto); return { texto: "Escritas financeiras pela conversa ainda não estão habilitadas.", motivo: "RESPONDIDO", requisicaoId: "x", ferramentas: ["preparar_registro"], custoMicrousd: 0, latenciaMs: 0 }; } } } : {}),
    }),
  });
  for (const p of politicas) await s.mova.armazenamento.politicas.criar({ organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 1000000,
    responsavel: "Administrador Sintético", motivo: "Contas relatadas confirmadas no WhatsApp", vigenteDe: "2026-10-01", ...p }, { criadaPor: HUMANO });
  await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: AGORA.toISOString() });
  const cx = (u = ALFA) => s.c(ORG, u);
  const propostas = async (u = ALFA) => (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: u })).filter((p) => p.tipo === "CONTA_RELATADA");
  const contas = async (u = ALFA) => s.m.nucleo.consultarRegistros(cx(u), { tipo: "OBRIGACAO" });
  const lancamentos = async (u = ALFA) => s.m.nucleo.consultarRegistros(cx(u), { tipo: "LANCAMENTO" });
  const ultimoTexto = async () => (await s.saida()).at(-1)?.texto ?? "";
  const decisao = async () => (await s.mova.armazenamento.historico.todos()).filter((h) => h.decisao !== "RELACIONADA").at(-1);
  return { ...s, cx, propostas, contas, lancamentos, ultimoTexto, decisao, core };
}

t("CG-0 leitura pura: empréstimo (total dito + composição + observação com outra data), aluguel, honorários; nada é inventado", () => {
  const e = interpretarContaRelatada({ texto: EMPRESTIMO, dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true });
  assert.equal(e.ehConta, true, "empréstimo declarado é conta a pagar (não só compra)");
  assert.deepEqual(e.faltas, ["VENCIMENTO"], "o 07/12 da OBSERVAÇÃO não é vencimento (só ele falta)");
  assert.equal(e.competencia, "2026-11", "empréstimo/financiamento (#243): competência = mês da mensagem");
  assert.equal(e.valorCitadoCentavos, 291108, "o TOTAL dito, não as partes");
  assert.match(e.observacao, /Um R\$ 395,34 \+ Dois R\$ 2\.515,74 = R\$ 2\.911,08/, "composição do total preservada");
  assert.match(e.observacao, /descontar os valores da remuneração de novembro\/2026 no dia 07\/12\/2026/);
  const i = interpretarContaRelatada({ texto: EMPRESTIMO_INSTRUCAO, dataMensagem: "2026-11-27", unidades: [{ apelidos: ["alfa", "loja alfa"] }], declarada: true });
  assert.deepEqual([i.descricao, i.fornecedor, i.valorCitadoCentavos], ["Empréstimo BSS — Pessoa Um e Pessoa Dois", "Banco do Sertão Sintético", 291108], "descrição e credor DITOS");
  assert.match(i.observacao, /Pessoa Um: R\$ 395,34\.; Pessoa Dois: R\$ 2\.515,74\./);
  assert.doesNotMatch(i.observacao, /descontos salariais/, "instrução depois da linha em branco não é observação");
  const a = interpretarContaRelatada({ texto: ALUGUEL, dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true });
  assert.deepEqual([a.faltas, a.competencia, a.fornecedor, a.descricao, a.parcelas.map((p) => [p.vencimento, p.valorCentavos])], [[], "2026-12", "Imobiliária Sintética", "Aluguel", [["2026-12-10", 423012]]]);
  const h = interpretarContaRelatada({ texto: HONORARIOS, dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true });
  assert.deepEqual([h.faltas, h.competencia, h.fornecedor], [[], "2026-11", "Contábil Sintética"]);
  // sem a declaração (fluxo antigo de compra): aviso de conta continua fora da conta relatada
  assert.equal(interpretarContaRelatada({ texto: "chegou o boleto de internet da alfa, R$ 289,90, vence 25/10/2026", dataMensagem: "2026-10-15", unidades: UNIDADES }).ehConta, false);
  // conta já PAGA não é conta a pagar relatada
  assert.equal(interpretarContaRelatada({ texto: "já paguei o aluguel da alfa, R$ 4.230,12, vence 10/12", dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true }).ehConta, false);
  // a resposta preenche SÓ o que faltava, acumulando
  const c = complementoDaResposta("vence 15/12, referente a novembro/2026", { faltas: e.faltas, dataMensagem: "2026-11-27", competenciaDe: competenciaDaResposta });
  assert.deepEqual(c, { vencimentos: ["2026-12-15"] }, "preenche só o que faltava (o mês já era sabido)");
  const so = complementoDaResposta("vence 15/12", { faltas: e.faltas, dataMensagem: "2026-11-27", competenciaDe: competenciaDaResposta });
  const depois = interpretarContaRelatada({ texto: EMPRESTIMO, dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true, complemento: so });
  assert.deepEqual([depois.faltas, depois.parcelas.map((p) => p.vencimento)], [[], ["2026-12-15"]], "o vencimento respondido completa a conta");
  // ALUGUEL sem mês: pergunta só o mês e guarda o vencimento respondido antes
  const al = interpretarContaRelatada({ texto: "MOVA, registrar aluguel da alfa, R$ 4.230,12", dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true });
  const al1 = complementoDaResposta("vence 10/12", { faltas: al.faltas, dataMensagem: "2026-11-27", competenciaDe: competenciaDaResposta });
  assert.deepEqual(interpretarContaRelatada({ texto: "MOVA, registrar aluguel da alfa, R$ 4.230,12", dataMensagem: "2026-11-27", unidades: UNIDADES, declarada: true, complemento: al1 }).faltas, ["COMPETENCIA"]);
});

t("CG-0b classificação: categoria PATRIMONIAL dita vence despesa de nome parecido; relato de empréstimo nunca vira despesa sozinho", () => {
  const plano = [{ codigo: "EMPRESTIMOS_E_FINANCIAMENTOS", nome: "Empréstimos e financiamentos (principal)", natureza: "PATRIMONIAL", aceitaLancamento: true },
    { codigo: "JUROS_EMPRESTIMOS", nome: "Juros de empréstimos", natureza: "DESPESA", aceitaLancamento: true }, { codigo: "ALUGUEL", nome: "Aluguel", natureza: "DESPESA", aceitaLancamento: true },
    { codigo: "TITULOS_ANTERIORES_A_ABERTURA", nome: "Títulos anteriores (empréstimos antigos)", natureza: "PATRIMONIAL", aceitaLancamento: true }];
  assert.equal(classificarContaRelatada({ descricao: "Empréstimo BSS", texto: EMPRESTIMO_INSTRUCAO, categorias: plano }).codigo, "EMPRESTIMOS_E_FINANCIAMENTOS", "\"categoria Empréstimos\" ⇒ principal (patrimonial), nunca os juros");
  const s = classificarContaRelatada({ descricao: "Empréstimo Banco Sintético", texto: EMPRESTIMO, categorias: plano, categoriaSugerida: "JUROS_EMPRESTIMOS" });
  assert.deepEqual([s.codigo, s.perguntar, s.motivo, s.opcoes[0].codigo], [null, true, "PATRIMONIAL_EXIGE_CLASSIFICACAO", "EMPRESTIMOS_E_FINANCIAMENTOS"], "sem categoria dita: pergunta, com a patrimonial primeiro (mesmo com sugestão de juros)");
  assert.ok(!s.opcoes.some((o) => o.codigo === "TITULOS_ANTERIORES_A_ABERTURA"), "categoria do sistema nunca é oferecida");
  assert.equal(classificarContaRelatada({ descricao: "Aluguel", texto: ALUGUEL, categorias: plano }).codigo, "ALUGUEL");
});

t("CG-1 caso real do empréstimo: pergunta SÓ vencimento e mês, guarda o resto, categoria patrimonial, resumo com observações; uma conta só, para aprovação (nunca despesa)", async () => {
  const CONC = ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"];
  const s = await relatada({ politicas: [{ operacao: "CONTA_A_PAGAR_RELATADA" }], concessao: CONC, criarContas: true });
  await s.enviar(gw({ texto: EMPRESTIMO }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_PERGUNTA_VENCIMENTO", "a data do desconto (07/12) não é vencimento: só ele é perguntado");
  assert.match(await s.ultimoTexto(), /Qual é o vencimento da conta[\s\S]*data do desconto da remuneração fica só nas observações/);
  await s.enviar(gw({ texto: "vence 15/12" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_PERGUNTA_CATEGORIA", "relato de empréstimo: a classificação contábil é das pessoas");
  const pergunta = await s.ultimoTexto();
  assert.match(pergunta, /\n1 — Empréstimos e financiamentos \(principal\)\n/);
  await s.enviar(gw({ texto: "1" }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  const resumo = await s.ultimoTexto();
  for (const re of [/Categoria: Empréstimos e financiamentos \(principal\) \(patrimonial: fora do resultado\/DRE\)/, /Competência: 10\/2026/, /1\/1: vence 15\/12\/2026 — R\$\s?2\.911,08/,
    /Observações: .*Um R\$ 395,34 \+ Dois R\$ 2\.515,74 = R\$ 2\.911,08.*descontar os valores da remuneração de novembro\/2026 no dia 07\/12\/2026/, /aprovação no Centro Financeiro/, /se já foi paga, responda "não"/]) assert.match(resumo, re);
  assert.doesNotMatch(resumo, /vence 07\/12/);
  assert.equal((await s.propostas()).length, 0, "nada antes da confirmação");
  await s.enviar(gw({ texto: "sim" }));
  const [p] = await s.propostas();
  assert.deepEqual([p.valorCentavos, p.comando.entrada.parcelas.length, p.comando.entrada.categoria, p.comando.entrada.competencia, p.comando.entrada.parcelas[0].vencimento],
    [291108, 1, "EMPRESTIMOS_E_FINANCIAMENTOS", "2026-10", "2026-12-15"], "UMA conta pelo total (não duas), vencimento DITO (não o 07/12)");
  assert.match(p.comando.entrada.observacao, /Um R\$ 395,34/);
  assert.equal((await s.contas()).length, 0, "patrimonial: a permissão estreita do MOVA não registra — fica para aprovação, mesmo com política e concessão");
  assert.match(await s.ultimoTexto(), /Categoria patrimonial \(fora da DRE\)/);
  // Central (registro amplo): a conta nasce EM ABERTO, patrimonial, com as observações; nenhuma despesa no resultado
  assert.equal((await s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id })).estado, "APLICADA");
  const [conta] = await s.contas();
  assert.deepEqual([conta.saldoCentavos, conta.situacao, conta.vencimento, conta.competencia], [291108, "ABERTA", "2026-12-15", "2026-10"]);
  assert.match(conta.observacao, /Dois R\$ 2\.515,74/, "observações preservadas na conta");
  const [l] = (await s.lancamentos()).filter((x) => x.id === conta.lancamentoId);
  assert.deepEqual([l.categoria, l.natureza], ["EMPRESTIMOS_E_FINANCIAMENTOS", "PATRIMONIAL"], "principal do empréstimo fora da DRE");
  // Dashboard (Contas a Pagar): a conta aparece com as observações e FORA do resultado
  const item = (await s.m.nucleo.consultarContasAPagar(s.cx(), {})).itens.find((x) => x.id === conta.id);
  assert.deepEqual([item.efeitoNaDre, item.saldoCentavos], ["FORA_DO_RESULTADO", 291108]);
  assert.match(item.observacao, /Um R\$ 395,34/);
});

t("CG-2 roteamento: pedido de REGISTRAR conta não vai ao MOVA CORE (só leitura); consulta continua indo", async () => {
  const s = await relatada({ comCore: true });
  await s.enviar(gw({ texto: EMPRESTIMO_INSTRUCAO }));
  assert.deepEqual(s.core, [], "o núcleo de conversa não recebeu o pedido de registro");
  assert.match((await s.decisao()).motivo, /^CONTA_RELATADA_/);
  assert.doesNotMatch(await s.ultimoTexto(), /não estão habilitadas/);
  await s.enviar(gw({ texto: "MOVA, quais contas vencem esta semana?", de: SOCIO })); // outra pessoa (sem pergunta pendente para ela)
  assert.equal(s.core.length, 1, "consulta segue para o núcleo, como antes");
});

t("CG-3 aluguel e honorários (contas únicas, tudo dito): direto ao resumo e, com política e concessão, registradas em aberto no 'sim'; repetir não duplica", async () => {
  const CONC = ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"];
  const s = await relatada({ politicas: [{ operacao: "CONTA_A_PAGAR_RELATADA" }], concessao: CONC, criarContas: true });
  await s.enviar(gw({ texto: ALUGUEL }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO");
  assert.match(await s.ultimoTexto(), /Aluguel — fornecedor Imobiliária Sintética[\s\S]*Categoria: Aluguel[\s\S]*Competência: 12\/2026/);
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).decisao, "EXECUTADO");
  await s.enviar(gw({ texto: HONORARIOS }));
  assert.match(await s.ultimoTexto(), /Categoria: Contabilidade[\s\S]*Competência: 11\/2026/);
  await s.enviar(gw({ texto: "sim" }));
  const cs = await s.contas();
  assert.deepEqual(cs.map((x) => [x.valorOriginalCentavos ?? x.saldoCentavos, x.vencimento, x.competencia]).sort(), [[423012, "2026-12-10", "2026-12"], [81000, "2026-12-10", "2026-11"]].sort());
  await s.enviar(gw({ texto: ALUGUEL }));
  assert.equal((await s.decisao()).decisao, "DUPLICADO", "mesmo aluguel (valor + vencimento): nada novo");
  assert.equal((await s.contas()).length, 2);
});

t("CG-4 compra parcelada de equipamento segue o fluxo de sempre (competência = mês da compra, classificação perguntada)", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: EQUIPAMENTO }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_PERGUNTA_CATEGORIA");
  assert.match(await s.ultimoTexto(), /parece compra de equipamento/);
  await s.enviar(gw({ texto: "1" }));
  assert.match(await s.ultimoTexto(), /Competência: 10\/2026[\s\S]*1\/3: vence 10\/12\/2026[\s\S]*3\/3: vence 10\/02\/2027[\s\S]*Total: R\$\s?3\.000,00/);
});

t("CG-5 isolamento: a conta relatada da Alfa nunca aparece na Beta; a resposta de outra pessoa sem perfil não completa a pendência", async () => {
  const s = await relatada();
  await s.enviar(gw({ texto: ALUGUEL }));
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.propostas(ALFA)).length, 1);
  assert.equal((await s.propostas(BETA)).length, 0);
  assert.equal((await s.contas(BETA)).length, 0);
});

t("CG-6 memória da unidade (causa 1+2): comprovante sem unidade ⇒ 'de qual unidade?' ⇒ 'alfa' ⇒ 'qual o mês?' ⇒ 'novembro' CONTINUA na Alfa (antes: 'unidades diferentes')", async () => {
  const COMPROVANTE = base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 291108, dataPagamento: "2026-10-15", favorecido: "Banco Sintético S.A.", categoriaSugerida: "EMPRESTIMO", natureza: "DESPESA", situacaoTransacao: "CONCLUIDA" });
  // execução de despesas LIGADA (como em produção): é ela que exige o mês de referência antes de seguir
  const s = await relatada({ criarDespesas: true, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante"], responder: (req) => (/document|pdf/i.test(JSON.stringify(req.messages ?? "")) ? COMPROVANTE : base({})) });
  await s.enviar(gw({ texto: "Empréstimo banco pessoa um e pessoa dois", doc: "%PDF-sintetico-comprovante" }));
  assert.equal((await s.decisao()).motivo, "UNIDADE_NAO_IDENTIFICADA");
  await s.enviar(gw({ texto: "alfa" }));
  assert.equal((await s.decisao()).motivo, "COMPETENCIA_AUSENTE");
  await s.enviar(gw({ texto: "novembro" }));
  const d = await s.decisao();
  assert.notEqual(d.decisao, "BLOQUEADO", `não bloqueia mais (${d.motivo})`);
  assert.equal(d.unidadeId, ALFA, "a unidade confirmada na 1ª pergunta continua valendo");
  assert.ok(!/unidades diferentes/.test(await s.ultimoTexto()));
});

// ------------------------------------------------------------------ 27/11 (consolidação): BOLETO DE EMPRÉSTIMO JÁ PAGO (caso real BNB)
const BOLETO_PAGO = base({ tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 291108, valorOriginalCentavos: 297169, descontoCentavos: 6061,
  dataPagamento: "2026-10-15", vencimento: "2026-10-15", favorecido: "Banco Sintético do Nordeste S/A", categoriaSugerida: "EMPRESTIMO", natureza: "DESPESA", situacaoTransacao: "CONCLUIDA",
  finalidadePagamento: "CONTA_EXISTENTE", idTransacao: "37815404336421932883312327" });
const OPERADOR_DOC = "eeeeeeee-0000-4000-8000-0000000000c7";

async function comBoletoPago() {
  const s = await relatada({ criarDespesas: true, criarContas: true, concessao: ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.registrar_conta_parcelada"],
    responder: (req) => (/document|pdf/i.test(JSON.stringify(req.messages ?? "")) ? BOLETO_PAGO : base({})) });
  // políticas como as de produção (despesa e baixa por comprovante AUTOMÁTICAS): mesmo assim o principal do empréstimo não é lançado sozinho
  for (const operacao of ["DESPESA_DOCUMENTAL", "BAIXA_DOCUMENTAL"]) await s.mova.armazenamento.politicas.criar({ operacao, organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_AUTOMATICO", limiteCentavos: 3000000,
    responsavel: "Administrador Sintético", motivo: "Política sintética igual à de produção", vigenteDe: "2026-10-01" }, { criadaPor: HUMANO });
  return s;
}

t("CG-7 boleto de empréstimo JÁ PAGO com desconto: unidade e mês esclarecidos, categoria patrimonial, proposta de conta+pagamento (nunca em aberto, nunca despesa) aprovada na Central; reenvio não duplica", async () => {
  const s = await comBoletoPago();
  await s.enviar(gw({ texto: "Empréstimo BNB Pessoa Um e Pessoa Dois", doc: "%PDF-sintetico-boleto-bnb" }));
  assert.equal((await s.decisao()).motivo, "UNIDADE_NAO_IDENTIFICADA");
  await s.enviar(gw({ texto: "alfa" }));
  assert.equal((await s.decisao()).motivo, "COMPETENCIA_AUSENTE");
  await s.enviar(gw({ texto: "novembro/2026" }));
  const d = await s.decisao();
  assert.deepEqual([d.decisao, d.unidadeId], ["PROPOSTA", ALFA], "a unidade esclarecida continua; vira proposta");
  const texto = await s.ultimoTexto();
  for (const re of [/pagamento já feito de R\$\s?2\.911,08 \(original R\$ 2\.971,69, desconto R\$ 60,61, pago R\$ 2\.911,08\)/, /Categoria patrimonial/, /já QUITADOS — nada fica em aberto e nada vira despesa/]) assert.match(texto, re);
  const [p] = (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.tipo === "DESPESA_PAGA");
  assert.deepEqual([p.comando.entrada.categoria, p.valorCentavos, p.comando.pagamento.valorCentavos, p.datas.competencia], ["EMPRESTIMOS_E_FINANCIAMENTOS", 291108, 291108, "2026-11"]);
  assert.match(p.comando.entrada.descricao, /original R\$ 2\.971,69, desconto R\$ 60,61, pago R\$ 2\.911,08/, "valor original, desconto e líquido preservados (nada inventado)");
  assert.equal((await s.lancamentos()).length, 0, "política automática de despesa NÃO lança o principal do empréstimo");
  // Central (pessoa com registro amplo E a ação estreita, como o proprietário): conta + pagamento juntos, quitada, patrimonial
  assert.equal((await s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id })).estado, "APLICADA");
  const [conta] = await s.contas();
  const [l] = await s.lancamentos();
  assert.deepEqual([conta.saldoCentavos, conta.situacao, l.categoria, l.natureza, l.valorCentavos], [0, "QUITADA", "EMPRESTIMOS_E_FINANCIAMENTOS", "PATRIMONIAL", 291108]);
  // reenviar o MESMO comprovante (mesma transação) não cria nada novo
  await s.enviar(gw({ texto: "Empréstimo BNB Pessoa Um e Pessoa Dois", doc: "%PDF-sintetico-boleto-bnb" }));
  assert.equal((await s.decisao()).decisao, "DUPLICADO");
  assert.equal((await s.contas()).length, 1);
});

t("CG-8 permissões preservadas: a ação ESTREITA de conta relatada continua só despesa/imobilizado; patrimonial só com o registro amplo (o mesmo do formulário)", async () => {
  const s = await relatada();
  const entrada = { contraparteNova: { tipo: "FORNECEDOR", nome: "Banco Sintético" }, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", descricao: "Empréstimo sintético", competencia: "2026-10",
    dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-12-15", valorCentavos: 100000 }], observacao: "Pessoa Um R$ 400,00 + Pessoa Dois R$ 600,00" };
  const estreito = ctx(ORG, ALFA, ["financeiro_v2.ver", "financeiro_v2.registrar_conta_parcelada"], OPERADOR_DOC);
  await assert.rejects(s.m.nucleo.registrarContaParcelada(estreito, entrada), (e) => e.codigo === "FV2_CATEGORIA_INVALIDA", "estreita: patrimonial recusada");
  for (const cat of ["DISTRIBUICAO_DE_LUCROS", "APORTES_E_RETIRADAS", "OPERACOES_ENTRE_EMPRESAS"]) {
    await assert.rejects(s.m.nucleo.registrarContaParcelada(estreito, { ...entrada, categoria: cat }), (e) => e.codigo === "FV2_CATEGORIA_INVALIDA", `estreita: ${cat} recusada`);
  }
  const op = await s.m.nucleo.registrarContaParcelada(ctx(ORG, ALFA, TODAS, HUMANO), entrada);
  assert.equal(op.obrigacoes[0].observacao, entrada.observacao, "observação guardada na conta");
  await assert.rejects(s.m.nucleo.registrarContaParcelada(ctx(ORG, ALFA, TODAS, HUMANO), { ...entrada, categoria: "VENDA_BALCAO" }), (e) => e.codigo === "FV2_CATEGORIA_INVALIDA", "receita nunca");
});

t("CG-9 recuperação do BNB: pendência do mês REABERTA no banco com as observações informadas ⇒ a resposta do mês gera a proposta com Jailton/Vanessa e o desconto em folha; a Central registra a conta com a observação (sem digitar nada)", async () => {
  const s = await comBoletoPago();
  await s.enviar(gw({ texto: "Empréstimo BNB Pessoa Um e Pessoa Dois", doc: "%PDF-sintetico-boleto-bnb-recuperado" }));
  await s.enviar(gw({ texto: "alfa" }));
  assert.equal((await s.decisao()).motivo, "COMPETENCIA_AUSENTE");
  // operação pontual de produção (mesma forma): a pendência do mês recebe as observações informadas; nada mais muda
  const OBS = ["Pessoa Um R$ 395,34 + Pessoa Dois R$ 2.515,74 = R$ 2.911,08", "Previsão de desconto das remunerações de novembro/2026 em 07/12/2026"];
  const n = await s.banco.pool.query("update mova.mensagem_pendente set leitura = leitura || jsonb_build_object('observacoes', $1::jsonb) where resolvida_em is null and leitura->'divergencia'->>'tipo' = 'COMPETENCIA'", [JSON.stringify(OBS)]);
  assert.equal(n.rowCount, 1);
  assert.equal((await s.lancamentos()).length, 0, "reabrir/complementar a pendência não lança nada");
  await s.enviar(gw({ texto: "novembro/2026" }));
  const texto = await s.ultimoTexto();
  assert.match(texto, /Observações: Pessoa Um R\$ 395,34 \+ Pessoa Dois R\$ 2\.515,74 = R\$ 2\.911,08; Previsão de desconto das remunerações de novembro\/2026 em 07\/12\/2026/);
  const [p] = (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.tipo === "DESPESA_PAGA");
  assert.match(p.comando.entrada.observacao, /07\/12\/2026/);
  assert.equal((await s.lancamentos()).length, 0, "proposta: nada lançado antes da Central");
  await s.mova.aprovador.aplicar(ctx(ORG, ALFA, TODAS, HUMANO), { propostaId: p.id });
  const [conta] = await s.contas();
  assert.deepEqual([conta.situacao, conta.saldoCentavos], ["QUITADA", 0], "pago: nada fica em aberto");
  assert.match(conta.observacao, /Pessoa Um R\$ 395,34 \+ Pessoa Dois R\$ 2\.515,74 = R\$ 2\.911,08; Previsão de desconto/);
  assert.match(conta.descricao, /original R\$ 2\.971,69, desconto R\$ 60,61, pago R\$ 2\.911,08/);
  const item = (await s.m.nucleo.consultarContasAPagar(s.cx(), {})).itens.find((x) => x.id === conta.id);
  assert.match(item.observacao, /Pessoa Dois R\$ 2\.515,74/, "Dashboard mostra as observações");
  assert.equal((await s.contas()).length, 1, "uma conta só (nenhuma individual)");
});

t("CG-10 legenda do comprovante com composição e desconto em folha: a observação vai sozinha para a proposta (sem pendência especial)", async () => {
  const s = await comBoletoPago();
  await s.enviar(gw({ texto: "Empréstimo BNB alfa. Pessoa Um R$ 395,34, Pessoa Dois R$ 2.515,74, total R$ 2.911,08. Desconto da remuneração de novembro/2026 em 07/12/2026.", doc: "%PDF-sintetico-boleto-legenda" }));
  assert.equal((await s.decisao()).motivo, "DESPESA_PAGA", "o mês já estava na legenda: direto à proposta");
  const [p] = (await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).filter((x) => x.tipo === "DESPESA_PAGA");
  assert.match(p.comando.entrada.observacao, /Um R\$ 395,34 \+ Dois R\$ 2\.515,74 = R\$ 2\.911,08; Desconto da remuneração de novembro\/2026 em 07\/12\/2026/);
  assert.equal(p.comando.pagamento.dataEfetiva, "2026-10-15", "a data do desconto em folha não muda a data do pagamento");
});

// ------------------------------------------------------------------ 27/11 (0035): permissão ESTREITA de empréstimo, com confirmação no WhatsApp
const COM_EMPRESTIMO = ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_emprestimo"];

t("LW-1 empréstimo AINDA A PAGAR com a permissão de empréstimo: resumo → 'sim' ⇒ registrado em aberto, PATRIMONIAL, pelas regras de limite; acima do limite, Central", async () => {
  const s = await relatada({ politicas: [{ operacao: "CONTA_A_PAGAR_RELATADA" }], concessao: COM_EMPRESTIMO, criarContas: true });
  await s.enviar(gw({ texto: EMPRESTIMO_INSTRUCAO.replace("Registrar uma única conta de R$ 2.911,08", "Registrar uma única conta de R$ 2.911,08, vence 15/12/2026") }));
  assert.equal((await s.decisao()).motivo, "CONTA_RELATADA_AGUARDANDO_CONFIRMACAO", JSON.stringify(await s.decisao()));
  const resumo = await s.ultimoTexto();
  assert.match(resumo, /Categoria: Empréstimos e financiamentos \(principal\)/);
  assert.doesNotMatch(resumo, /vai para aprovação no Centro Financeiro/, "com a permissão de empréstimo o 'sim' registra");
  assert.equal((await s.contas()).length, 0, "nada antes do 'sim'");
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).decisao, "EXECUTADO", JSON.stringify(await s.decisao()));
  const [conta] = await s.contas();
  const [l] = await s.lancamentos();
  assert.deepEqual([conta.situacao, conta.saldoCentavos, l.categoria, l.natureza], ["ABERTA", 291108, "EMPRESTIMOS_E_FINANCIAMENTOS", "PATRIMONIAL"]);
  // limite da unidade menor que o valor ⇒ não executa pela conversa
  const lim = await relatada({ politicas: [{ operacao: "CONTA_A_PAGAR_RELATADA", limiteCentavos: 100000 }], concessao: COM_EMPRESTIMO, criarContas: true });
  await lim.enviar(gw({ texto: EMPRESTIMO_INSTRUCAO.replace("Registrar uma única conta de R$ 2.911,08", "Registrar uma única conta de R$ 2.911,08, vence 15/12/2026") }));
  await lim.enviar(gw({ texto: "sim" }));
  assert.equal((await lim.contas()).length, 0, "acima do limite de R$ 1.000,00: nada lançado, fica a proposta");
});

t("LW-2 empréstimo JÁ PAGO com a permissão: o MOVA pergunta a confirmação; 'sim' de um FINANCEIRO ⇒ conta + pagamento quitados, patrimonial, com as observações; 'não' deixa para a Central", async () => {
  const montarComPermissao = async () => {
    const s = await relatada({ criarDespesas: true, criarContas: true, concessao: COM_EMPRESTIMO, responder: (req) => (/document|pdf/i.test(JSON.stringify(req.messages ?? "")) ? BOLETO_PAGO : base({})) });
    await s.mova.armazenamento.politicas.criar({ operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG, unidadeId: ALFA, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 3000000,
      responsavel: "Administrador Sintético", motivo: "Política sintética de despesa documental", vigenteDe: "2026-10-01" }, { criadaPor: HUMANO });
    return s;
  };
  const s = await montarComPermissao();
  await s.enviar(gw({ texto: "Empréstimo BNB alfa. Pessoa Um R$ 395,34, Pessoa Dois R$ 2.515,74, total R$ 2.911,08. Desconto da remuneração de novembro/2026 em 07/12/2026.", doc: "%PDF-sintetico-boleto-lw2" }));
  const pergunta = await s.ultimoTexto();
  for (const re of [/Pagamento de empréstimo já feito: R\$\s?2\.911,08 \(original R\$ 2\.971,69, desconto R\$ 60,61, pago R\$ 2\.911,08\)/, /Empréstimos e financiamentos \(principal\) — fora da DRE/,
    /Observações: Um R\$ 395,34 \+ Dois R\$ 2\.515,74 = R\$ 2\.911,08; Desconto da remuneração/, /Responda "sim"/]) assert.match(pergunta, re);
  assert.equal((await s.lancamentos()).length, 0, "nada antes do 'sim'");
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.decisao()).motivo, "EMPRESTIMO_PAGO_REGISTRADO", JSON.stringify(await s.decisao()));
  const [conta] = await s.contas();
  const [l] = await s.lancamentos();
  assert.deepEqual([conta.situacao, conta.saldoCentavos, l.categoria, l.natureza, l.valorCentavos], ["QUITADA", 0, "EMPRESTIMOS_E_FINANCIAMENTOS", "PATRIMONIAL", 291108]);
  assert.match(conta.observacao, /Desconto da remuneração de novembro\/2026 em 07\/12\/2026/);
  await s.enviar(gw({ texto: "sim" }));
  assert.equal((await s.contas()).length, 1, "outro 'sim' não duplica");
  // "não": a proposta fica para a Central, nada lançado
  const n = await montarComPermissao();
  await n.enviar(gw({ texto: "Empréstimo BNB alfa. Total R$ 2.911,08, competência novembro/2026.", doc: "%PDF-sintetico-boleto-lw2-nao" }));
  if ((await n.decisao()).motivo === "COMPETENCIA_AUSENTE") await n.enviar(gw({ texto: "novembro/2026" }));
  await n.enviar(gw({ texto: "não" }));
  assert.equal((await n.decisao()).motivo, "EMPRESTIMO_NAO_CONFIRMADO");
  assert.equal((await n.lancamentos()).length, 0);
});
