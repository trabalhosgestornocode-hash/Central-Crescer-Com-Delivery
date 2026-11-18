// ENTREGADORES PRÓPRIOS — regras PURAS do ciclo semanal (segunda a domingo, vencimento na quarta seguinte).
// Nenhum acesso a banco, rede ou relógio. A elegibilidade de cada entrega NÃO é decidida aqui: vem pronta do parser Foody.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "./erros.js";
import { somar, somarLista, subtrair } from "./dinheiro.js";
import { diaDaSemana, exigirData, inicioDaSemana, somarDias } from "./tempo.js";

const enumerar = (...v) => Object.freeze(Object.fromEntries(v.map((x) => [x, x])));

export const FUSO_OPERACIONAL = "America/Fortaleza";
export const CATEGORIA_ENTREGADORES = "ENTREGADORES_PROPRIOS";
export const PREFIXO_FONTE = "entregador-semana:";
export const ORIGEM_FOODY = "FOODY_DELIVERY";
export const SITUACAO_SEMANA = enumerar("EM_ANDAMENTO", "AGUARDANDO_FECHAMENTO", "PENDENTE", "CONSOLIDADA");
export const SITUACAO_DOCUMENTAL = enumerar("AGUARDANDO_NF", "NF_RECEBIDA", "NF_EM_CONFERENCIA", "NF_APROVADA", "NF_REJEITADA", "LIBERADO_PAGAMENTO");
export const SITUACAO_PAGAMENTO = enumerar("SEM_CONTA", "A_PAGAR", "VENCIDO", "PARCIAL", "PAGO", "CANCELADO");
export const DECISAO_DUPLICIDADE = enumerar("GERAR_NOVA", "VINCULAR_MANUAL", "GERAR_DIFERENCA");
/** Identidade técnica exclusiva do fechamento semanal. A migração 0026 impede, no banco, que ela mexa em dinheiro ou permissões. */
export const IDENTIDADE_DE_AUTOMACAO = "00000000-0000-4000-8000-00000000e7e9";
export const DECISAO_DIVERGENCIA = enumerar("MANTER", "AJUSTAR_CONTA", "CONTA_COMPLEMENTAR", "COMPENSAR_FUTURO");
export const CODIGO_PENDENCIA = enumerar("FONTE_INDISPONIVEL", "DIA_SEM_DADOS", "DIA_PROVISORIO", "DIA_EM_TRIAGEM", "CANCELAMENTO_EM_REVISAO", "ENTREGA_SEM_TAXA", "CATEGORIA_AUSENTE", "COMPETENCIA_HOMOLOGADA");

/** Calendário da semana da data informada. A semana termina no domingo e o dinheiro vence na quarta seguinte. */
export function semanaDe(data) {
  const inicio = inicioDaSemana(exigirData(data, "data"));
  const fim = somarDias(inicio, 6);
  return { inicio, fim, fimExclusivo: somarDias(inicio, 7), demonstrativo: somarDias(inicio, 7), prazoDaNota: somarDias(inicio, 8), vencimento: somarDias(inicio, 9) };
}
export function exigirSegunda(data, campo = "inicio") {
  const d = exigirData(data, campo);
  if (diaDaSemana(d) !== 1) falhar(CODIGO.DATA_INVALIDA, "A semana de entregadores começa sempre na segunda-feira.", { campo });
  return d;
}
export const semanaEncerrada = (inicio, hoje) => hoje > somarDias(inicio, 6);
export const diasDaSemana = (inicio) => Array.from({ length: 7 }, (_, i) => somarDias(inicio, i));

const curta = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
/** "02 a 08/11/2026" (mesmo mês) ou "28/09 a 04/10/2026" (virada de mês) ou "28/12/2026 a 03/01/2027" (virada de ano). */
export function rotuloDaSemana(inicio, fim = somarDias(inicio, 6)) {
  if (inicio.slice(0, 4) !== fim.slice(0, 4)) return `${curta(inicio)}/${inicio.slice(0, 4)} a ${curta(fim)}/${fim.slice(0, 4)}`;
  if (inicio.slice(0, 7) !== fim.slice(0, 7)) return `${curta(inicio)} a ${curta(fim)}/${fim.slice(0, 4)}`;
  return `${inicio.slice(8, 10)} a ${curta(fim)}/${fim.slice(0, 4)}`;
}
export const descricaoDaConta = (nome, inicio) => `Entregador Próprio — ${nome} — Semana ${rotuloDaSemana(inicio)}`;
/** Política já usada pela formação financeira de entregadores: a competência é a do último dia do período apurado. */
export const competenciaDaSemana = (inicio) => somarDias(inicio, 6).slice(0, 7);

/** Chave estável: empresa + unidade + entregador + início + fim + origem. Repetir a semana nunca gera outra conta. */
export function chaveDoFechamento({ organizacaoId, unidadeId, entregadorChave, inicio }) {
  return [organizacaoId, unidadeId, entregadorChave, inicio, somarDias(inicio, 6), ORIGEM_FOODY].join("|").toLowerCase();
}
export const hashDaChave = (chave) => createHash("sha256").update(chave).digest("hex");
export const idExternoDaConta = (chave) => `${PREFIXO_FONTE}${hashDaChave(chave)}`;
export const chaveDeRegistro = (chave) => `es:${hashDaChave(chave)}`;
export const chaveDaSemana = (inicio) => `entregadores-semana:${inicio}`;
/** Dono da conta: a conta original e as complementares carregam o mesmo hash. */
export function hashDaFonte(idExterno) {
  const m = new RegExp(`^${PREFIXO_FONTE}([0-9a-f]{64})(?::.+)?$`).exec(String(idExterno ?? ""));
  return m ? m[1] : null;
}

const ordenar = (a, b) => String(a.data).localeCompare(String(b.data)) || String(a.id).localeCompare(String(b.id));

/** Agrupa as entregas ELEGÍVEIS por entregador. Valor zero não vira obrigação, mas continua visível na apuração. */
export function consolidar(entregas = []) {
  const grupos = new Map();
  for (const e of entregas) {
    if (!e.elegivel || !e.entregadorChave) continue;
    if (!grupos.has(e.entregadorChave)) grupos.set(e.entregadorChave, { chave: e.entregadorChave, nome: e.entregadorNome, referencia: e.entregadorId ?? null, itens: [] });
    grupos.get(e.entregadorChave).itens.push(e);
  }
  return [...grupos.values()].map((g) => {
    const itens = [...g.itens].sort(ordenar).map((e) => ({ id: e.id, tipo: e.tipo, data: e.data, numeroPedido: e.numeroPedido ?? null, situacao: e.situacao ?? null, valorCentavos: e.valorCentavos ?? 0, motivo: e.motivo ?? null }));
    const entregasDoGrupo = itens.filter((i) => i.tipo === "ENTREGA");
    const porDia = new Map();
    for (const i of itens) {
      const d = porDia.get(i.data) ?? { data: i.data, entregas: 0, valorCentavos: 0 };
      porDia.set(i.data, { data: i.data, entregas: d.entregas + (i.tipo === "ENTREGA" ? 1 : 0), valorCentavos: somar(d.valorCentavos, i.valorCentavos) });
    }
    return {
      chave: g.chave, nome: g.nome, referencia: g.referencia, entregas: entregasDoGrupo.length, entregasCentavos: somarLista(entregasDoGrupo, (i) => i.valorCentavos),
      ajustesCentavos: somarLista(itens.filter((i) => i.tipo !== "ENTREGA"), (i) => i.valorCentavos), valorCentavos: somarLista(itens, (i) => i.valorCentavos),
      porDia: [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data)), itens,
    };
  }).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/** O que impede tratar a semana como definitiva. Sem nenhuma pendência, a apuração pode ser consolidada. */
export function pendenciasDaApuracao(apuracao, inicio, { aceitarDiasSemDados = false, aceitarTriagem = false } = {}) {
  if (!apuracao?.disponivel) return [{ codigo: CODIGO_PENDENCIA.FONTE_INDISPONIVEL, mensagem: `Os dados do parser Foody não estão disponíveis (${apuracao?.motivo ?? "sem resposta"}).` }];
  const p = [];
  const porData = new Map((apuracao.dias ?? []).map((d) => [d.data, d]));
  for (const data of diasDaSemana(inicio)) {
    const d = porData.get(data);
    if (!d || d.fonte === "sem_dados") { if (!aceitarDiasSemDados) p.push({ codigo: CODIGO_PENDENCIA.DIA_SEM_DADOS, data, mensagem: `Não há dados operacionais em ${curta(data)}.` }); continue; }
    if (d.aberto || (d.provisorio && !aceitarTriagem)) p.push({ codigo: CODIGO_PENDENCIA.DIA_PROVISORIO, data, mensagem: `A apuração de ${curta(data)} ainda é provisória.` });
    if (d.triagem > 0 && !aceitarTriagem) p.push({ codigo: CODIGO_PENDENCIA.DIA_EM_TRIAGEM, data, quantidade: d.triagem, mensagem: `${d.triagem} pedido(s) de ${curta(data)} aguardam triagem da operação.` });
  }
  for (const e of apuracao.entregas ?? []) {
    if (e.emRevisao) p.push({ codigo: CODIGO_PENDENCIA.CANCELAMENTO_EM_REVISAO, data: e.data, referencia: e.numeroPedido ?? e.id, mensagem: `Cancelamento do pedido ${e.numeroPedido ?? ""} aguarda revisão no parser.`.replace("  ", " ") });
    else if (e.elegivel && e.tipo === "ENTREGA" && (e.valorCentavos === null || e.valorCentavos === undefined)) p.push({ codigo: CODIGO_PENDENCIA.ENTREGA_SEM_TAXA, data: e.data, referencia: e.numeroPedido ?? e.id, mensagem: `O pedido ${e.numeroPedido ?? ""} não tem taxa do entregador.`.replace("  ", " ") });
  }
  return p;
}

const norm = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
export const mesmoNome = (a, b) => norm(a) !== "" && norm(a) === norm(b);

/**
 * Contas manuais que podem representar o MESMO serviço: mesmo favorecido (nome idêntico, ignorando o prefixo "Entregador"), em
 * QUALQUER categoria (na operação real elas foram lançadas em Outras despesas), não cancelada, fora deste fluxo, com emissão ou
 * vencimento entre o início da semana e 7 dias após a quarta. Só sinaliza: quem decide é uma pessoa.
 */
export function contasManuaisCandidatas({ nome, inicio, obrigacoes, contrapartes, lancamentos }) {
  const ate = somarDias(inicio, 16);
  const nomes = new Map(contrapartes.map((c) => [c.id, c.nome]));
  const categoria = new Map(lancamentos.map((l) => [l.id, l.categoria]));
  const semPrefixo = (t) => String(t ?? "").replace(/^\s*entregador(a)?\s+/i, "");
  const naJanela = (d) => d >= inicio && d <= ate;
  return obrigacoes.filter((o) => o.situacao !== "CANCELADA" && !String(o.fonte?.idExterno ?? "").startsWith(PREFIXO_FONTE)
    && mesmoNome(semPrefixo(nomes.get(o.contraparteId)), nome) && (naJanela(o.dataEmissao) || naJanela(o.vencimento)))
    .map((o) => ({ obrigacaoId: o.id, categoria: categoria.get(o.lancamentoId) ?? null, descricao: o.descricao, valorCentavos: o.valorBaseCentavos, saldoCentavos: o.saldoCentavos, dataEmissao: o.dataEmissao, vencimento: o.vencimento, situacao: o.situacao }));
}

const TRANSICOES = Object.freeze({
  AGUARDANDO_NF: ["NF_RECEBIDA"], NF_REJEITADA: ["NF_RECEBIDA"], NF_RECEBIDA: ["NF_EM_CONFERENCIA", "NF_RECEBIDA"], NF_EM_CONFERENCIA: ["NF_APROVADA", "NF_REJEITADA", "NF_RECEBIDA"],
  NF_APROVADA: ["LIBERADO_PAGAMENTO", "NF_RECEBIDA"], LIBERADO_PAGAMENTO: [],
});
export function exigirTransicao(atual, nova) {
  if (!TRANSICOES[atual]?.includes(nova)) falhar(CODIGO.TRANSICAO_INVALIDA, "Esta etapa da conferência não pode ser feita agora.", { atual, nova });
  return nova;
}

/** Itens que mudaram depois da consolidação. Nada aqui altera o valor original. */
export function compararComFechamento(fechados, atuais) {
  const atualPor = new Map(atuais.map((a) => [a.chave, a]));
  const fechadoPor = new Map(fechados.map((f) => [f.chave, f]));
  const saida = [];
  for (const chave of new Set([...fechadoPor.keys(), ...atualPor.keys()])) {
    const f = fechadoPor.get(chave);
    const a = atualPor.get(chave);
    const antes = new Map((f?.itens ?? []).map((i) => [i.id, i]));
    const agora = new Map((a?.itens ?? []).map((i) => [i.id, i]));
    const mudancas = [];
    for (const [id, i] of antes) if (!agora.has(id)) mudancas.push({ tipo: "REMOVIDA", id, numeroPedido: i.numeroPedido, antesCentavos: i.valorCentavos, depoisCentavos: 0 });
    for (const [id, i] of agora) {
      const x = antes.get(id);
      if (!x) mudancas.push({ tipo: "INCLUIDA", id, numeroPedido: i.numeroPedido, antesCentavos: 0, depoisCentavos: i.valorCentavos });
      else if (x.valorCentavos !== i.valorCentavos) mudancas.push({ tipo: "VALOR_ALTERADO", id, numeroPedido: i.numeroPedido, antesCentavos: x.valorCentavos, depoisCentavos: i.valorCentavos });
    }
    const diferencaCentavos = subtrair(a?.valorCentavos ?? 0, f?.valorCentavos ?? 0);
    if (!mudancas.length && diferencaCentavos === 0) continue;
    const impressao = hashDaChave(JSON.stringify([chave, mudancas.map((m) => [m.tipo, m.id, m.antesCentavos, m.depoisCentavos]).sort()]));
    saida.push({ id: impressao.slice(0, 16), entregadorChave: chave, entregadorNome: a?.nome ?? f?.nome, valorFechadoCentavos: f?.valorCentavos ?? 0, valorAtualCentavos: a?.valorCentavos ?? 0, diferencaCentavos, mudancas });
  }
  return saida;
}

export function situacaoDoPagamento(obrigacao, hoje) {
  if (!obrigacao) return SITUACAO_PAGAMENTO.SEM_CONTA;
  if (obrigacao.situacao === "CANCELADA") return SITUACAO_PAGAMENTO.CANCELADO;
  if (obrigacao.saldoCentavos === 0) return SITUACAO_PAGAMENTO.PAGO;
  if (obrigacao.vencimento < hoje) return SITUACAO_PAGAMENTO.VENCIDO;
  return obrigacao.liquidadoCentavos > 0 ? SITUACAO_PAGAMENTO.PARCIAL : SITUACAO_PAGAMENTO.A_PAGAR;
}

/** Organização lógica da pasta do entregador (não existe pasta física). */
export function pastaDoDocumento(nome, inicio) {
  const fim = somarDias(inicio, 6);
  const mes = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(new Date(`${fim}T12:00:00Z`));
  return ["Entregadores Próprios", nome, "Notas Fiscais", fim.slice(0, 4), mes[0].toUpperCase() + mes.slice(1), `Semana ${inicio.slice(8, 10)}–${fim.slice(8, 10)}`];
}
