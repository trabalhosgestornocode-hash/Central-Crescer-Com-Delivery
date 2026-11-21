// MOVA — Execução 14: EXECUTOR do conjunto de avaliação. Roda os casos, em ordem, num cenário fictício (banco PostgreSQL LOCAL
// de teste + núcleo financeiro em memória), pelo MESMO caminho de produção (receptor → fila → motor), e mede cada critério
// SEPARADAMENTE. Proposta só conta como correta se bater com o gabarito (tipo, valor, unidade, datas) — JSON válido não basta.
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../../src/modules/financeiro-v2/index.js";
import { AGORA, TODAS, ctx, montar } from "../../financeiro-v2/helpers/cenario.js";
import { criarExtratorAnthropic, criarMova, instalarConfiguracao, validarConfiguracao } from "../../../src/modules/mova-financeiro/index.js";
import { criarBancoMova } from "../helpers/banco.js";

export const ORG = "dddddddd-0000-4000-8000-000000000001";
export const UNIDADES = { ALFA: "dddddddd-0000-4000-8000-0000000000a1", GAMA: "dddddddd-0000-4000-8000-0000000000c1" };
const nomeDaUnidade = (id) => Object.entries(UNIDADES).find(([, v]) => v === id)?.[0] ?? null;
export const CONTATO = "5500000000777@s.whatsapp.net"; // FICTÍCIO
const CONFIG = {
  modo: "HOMOLOGACAO", identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [
    { organizacaoId: ORG, unidadeId: UNIDADES.ALFA, nome: "Unidade Teste Alfa", apelidos: ["alfa"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD"] } },
    { organizacaoId: ORG, unidadeId: UNIDADES.GAMA, nome: "Unidade Teste Gama", apelidos: ["gama"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"] } },
  ],
  gruposAutorizados: [{ grupoId: CONTATO, unidades: [UNIDADES.ALFA, UNIDADES.GAMA] }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
const msg = (caso, n) => ({
  contratoMova: 1, eventoId: `bly:AV${caso.id}${n}`, mensagemId: `AV${caso.id}${n}`, grupoId: CONTATO, participanteId: CONTATO, telefoneE164: "+5500000000777",
  nomeExibicao: "Contato Teste", fromMe: false, tipo: "TEXTO", texto: caso.texto, respostaA: null, midia: null, recebidoEm: AGORA.toISOString(), origemTipo: "LIVE",
});

/**
 * @param {{criarCliente:(registrar:(r:object)=>void)=>object, casos:object[], esforco?:string}} o
 *   criarCliente recebe `registrar` e devolve o cliente Anthropic (simulado ou real com orçamento); cada chamada registra
 *   { caso, json, stop, uso } para medir JSON válido, truncamento e custo.
 */
export async function executarAvaliacao({ criarCliente, casos, esforco = "low" }) {
  const m = montar({ escopos: Object.values(UNIDADES).map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
  const c = (u) => ctx(ORG, u, TODAS);
  const forn = await m.nucleo.registrarContraparte(c(UNIDADES.ALFA), { tipo: "FORNECEDOR", nome: "Distribuidora Teste" });
  await m.nucleo.registrarObrigacao(c(UNIDADES.ALFA), { contraparteId: forn.id, valorOriginalCentavos: 35000, categoria: "INSUMOS", descricao: "Compra fictícia", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-12" });
  const { pool } = await criarBancoMova();
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  let casoAtual = null;
  const chamadas = [];
  const cliente = criarCliente((r) => chamadas.push({ caso: casoAtual, ...r }));
  const ref = {};
  ref.mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool, relogio: () => AGORA,
    extrator: criarExtratorAnthropic({ cliente, obterEvidencia: (x) => ref.mova.evidencias.obter(x), relogio: () => AGORA, esforco }) });
  const mova = ref.mova;
  const propostas = async () => (await Promise.all(Object.values(UNIDADES).map((u) => mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: u })))).flat();

  const resultados = [];
  for (const caso of casos) {
    casoAtual = caso.id;
    const antes = new Set((await propostas()).map((p) => p.id));
    const nChamadas = chamadas.length;
    await mova.receptor.receber(msg(caso, 1));
    await mova.receptor.trabalhar();
    const h = (await mova.armazenamento.historico.todos()).filter((x) => x.eventoId === `bly:AV${caso.id}1`).at(-1) ?? {};
    const novas = (await propostas()).filter((p) => !antes.has(p.id));
    const resposta = (await mova.armazenamento.saida.listar()).filter((r) => r.eventoId === `bly:AV${caso.id}1`).at(-1)?.texto ?? null;
    const minhas = chamadas.slice(nChamadas);
    resultados.push(avaliarCaso(caso, { h, novas, resposta, chamadas: minhas }));
  }
  return { resultados, metricas: resumir(resultados), chamadas };
}

const iguaisDatas = (esperadas, reais) => Object.entries(esperadas ?? {}).every(([k, v]) => (reais ?? {})[k] === v);

/** Critério por critério. `null` = não se aplica ao caso. */
export function avaliarCaso(caso, { h, novas, resposta, chamadas }) {
  const e = caso.esperado;
  const ia = chamadas.at(-1)?.json ?? null;
  const r = {};
  r.decisao = e.decisaoEm ? e.decisaoEm.includes(h.decisao) : h.decisao === e.decisao;
  if (e.motivo) r.motivo = e.motivo instanceof RegExp ? e.motivo.test(h.motivo ?? "") : String(h.motivo ?? "").includes(e.motivo);
  if (e.semIa) r.semIa = chamadas.length === 0;
  if (e.intencao && !e.semIa) r.intencao = ia?.intencao === e.intencao;
  if ("valorCentavos" in e && !e.semIa) r.valor = (ia?.valorCentavos ?? null) === e.valorCentavos;
  if ("unidade" in e) r.unidade = nomeDaUnidade(h.unidadeId ?? null) === e.unidade;
  if (e.categoria) r.categoria = e.categoria.test(ia?.categoriaSugerida ?? "");
  if (e.data) r.data = (ia?.[e.data.campo] ?? null) === e.data.valor;
  if (e.proposta) {
    const p = novas[0];
    r.proposta = novas.length === 1 && p.tipo === e.proposta.tipo && p.valorCentavos === e.proposta.valorCentavos
      && nomeDaUnidade(p.unidadeId) === e.proposta.unidade && iguaisDatas(e.proposta.datas, p.datas) && p.estado === "AGUARDANDO_REVISAO";
  } else r.semPropostaIndevida = novas.length === 0;
  if (e.semNumeroInventado) r.semNumeroInventado = !/R\$\s?\d/.test(resposta ?? "");
  if (!e.semIa) {
    r.jsonValido = chamadas.length > 0 && chamadas.every((c) => c.json !== null);
    r.naoTruncada = chamadas.every((c) => c.stop !== "max_tokens");
  }
  const aprovado = Object.values(r).every(Boolean);
  return { id: caso.id, cobre: caso.cobre, aprovado, criterios: r, decisao: h.decisao ?? null, motivo: h.motivo ?? null,
    unidade: nomeDaUnidade(h.unidadeId ?? null), ia: ia ? { intencao: ia.intencao, valorCentavos: ia.valorCentavos, categoria: ia.categoriaSugerida, dataPagamento: ia.dataPagamento, vencimento: ia.vencimento, competencia: ia.competencia, consulta: ia.consulta, natureza: ia.natureza, confianca: ia.confianca } : null,
    propostas: novas.map((p) => ({ tipo: p.tipo, valorCentavos: p.valorCentavos, unidade: nomeDaUnidade(p.unidadeId), datas: p.datas })),
    uso: chamadas.map((c) => c.uso).filter(Boolean), stop: chamadas.map((c) => c.stop) };
}

export function resumir(resultados) {
  const m = {};
  for (const r of resultados) for (const [k, v] of Object.entries(r.criterios)) { m[k] ??= { ok: 0, total: 0 }; m[k].total += 1; if (v) m[k].ok += 1; }
  return { casos: resultados.length, aprovados: resultados.filter((r) => r.aprovado).length, porCriterio: m };
}

/** Cliente SIMULADO: devolve a leitura `ideal` do caso em andamento (identificado pelo texto delimitado do pedido). */
export function clienteIdeal(casos) {
  return (registrar) => ({ beta: { messages: { async create(req) {
    const texto = req.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const caso = casos.find((k) => k.ideal && texto.includes(k.texto));
    if (!caso) throw Object.assign(new Error("caso sem leitura ideal"), { status: 400 });
    registrar({ json: caso.ideal, stop: "end_turn", uso: { modelo: "simulado", entrada: 0, saida: 0 } });
    return { model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: JSON.stringify(caso.ideal) }] };
  } } } });
}
