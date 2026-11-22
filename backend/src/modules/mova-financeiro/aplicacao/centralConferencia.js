// Agente 2 — CENTRAL DE PENDÊNCIAS (conferência financeira): indicadores, lista de pendências e classificação das saídas do extrato
// sem vínculo, a partir SÓ das leituras oficiais do Financeiro v2 (consultarContasAPagar e previaDoVinculoDoExtrato).
// Nada aqui grava, baixa, cancela ou cria registro: cada pendência diz o MOTIVO (fato do Financeiro) e a PRÓXIMA AÇÃO para uma
// pessoa. "Possível pagamento no extrato" e "possível duplicidade" são avisos para conferir, nunca confirmação.
import {
  abertaComSaldo, buscarContas, contasParecidas, fornecedorIdentificado, normalizar, palavrasDoNome, possiveisDuplicidades, saidasCompativeis,
} from "./conferenciaContas.js";

const inteiro = (v) => (Number.isSafeInteger(v) ? v : 0);
const livre = (s) => inteiro(s.valorCentavos) - inteiro(s.alocadoCentavos);
const dias = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const reais = (c) => { const a = Math.abs(c); return `${c < 0 ? "-" : ""}R$ ${Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(a % 100).padStart(2, "0")}`; };
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");

export const MOTIVO = Object.freeze({
  VENCIDA: "VENCIDA", PARCIAL: "PARCIAL", SEM_DOCUMENTO: "SEM_DOCUMENTO", PAGA_SEM_COMPROVANTE: "PAGA_SEM_COMPROVANTE",
  PAGAMENTO_SEM_EXTRATO: "PAGAMENTO_SEM_EXTRATO", FORNECEDOR_NAO_IDENTIFICADO: "FORNECEDOR_NAO_IDENTIFICADO", POSSIVEL_DUPLICIDADE: "POSSIVEL_DUPLICIDADE",
  POSSIVEL_PAGAMENTO_NO_EXTRATO: "POSSIVEL_PAGAMENTO_NO_EXTRATO", SAIDAS_COMPATIVEIS_AMBIGUAS: "SAIDAS_COMPATIVEIS_AMBIGUAS", AJUSTE_MANUAL: "AJUSTE_MANUAL",
});
export const ROTULO_MOTIVO = Object.freeze({
  VENCIDA: "vencida (sem pagamento registrado no Financeiro)", PARCIAL: "pagamento parcial registrado", SEM_DOCUMENTO: "sem documento anexado",
  PAGA_SEM_COMPROVANTE: "paga sem comprovante anexado", PAGAMENTO_SEM_EXTRATO: "pagamento registrado sem vínculo com o extrato",
  FORNECEDOR_NAO_IDENTIFICADO: "fornecedor não identificado", POSSIVEL_DUPLICIDADE: "possível duplicidade (conferir)",
  POSSIVEL_PAGAMENTO_NO_EXTRATO: "possível pagamento no extrato, NÃO confirmado", SAIDAS_COMPATIVEIS_AMBIGUAS: "várias saídas do extrato compatíveis (ambíguo)",
  AJUSTE_MANUAL: "ajuste manual no saldo",
});
// Peso para ordenar: o que pede decisão humana primeiro, depois o que está vencido e maior.
const PESO = { POSSIVEL_DUPLICIDADE: 60, POSSIVEL_PAGAMENTO_NO_EXTRATO: 50, SAIDAS_COMPATIVEIS_AMBIGUAS: 45, AJUSTE_MANUAL: 40, VENCIDA: 30, FORNECEDOR_NAO_IDENTIFICADO: 20, PARCIAL: 15, PAGAMENTO_SEM_EXTRATO: 12, PAGA_SEM_COMPROVANTE: 10, SEM_DOCUMENTO: 5 };

const semDocumento = (t) => (t.pendencias ?? []).includes("SEM_DOCUMENTO") || (t.documentos ?? []).length === 0;
const pagaSemComprovante = (t) => inteiro(t.pagoCentavos) > 0 && (t.documentos ?? []).length === 0 && (t.pagamentos ?? []).every((p) => (p.documentos ?? []).length === 0);
const pagamentosSemExtrato = (t) => (t.pagamentos ?? []).filter((p) => !p.movimentacaoId);

/** Próxima ação recomendada (texto fixo por motivo; a decisão é sempre de uma pessoa no Financeiro). */
export function proximaAcao(motivos, { candidatas = [] } = {}) {
  const tem = (m) => motivos.includes(m);
  if (tem(MOTIVO.POSSIVEL_DUPLICIDADE)) return "Conferir se é a mesma conta já registrada; não cancelar sem confirmar com o documento.";
  if (tem(MOTIVO.POSSIVEL_PAGAMENTO_NO_EXTRATO)) return `Conferir a saída do extrato de ${reais(candidatas[0].valorCentavos)} em ${dataBr(candidatas[0].data)} com o comprovante e, se for o pagamento, conciliar no Financeiro.`;
  if (tem(MOTIVO.SAIDAS_COMPATIVEIS_AMBIGUAS)) return "Há mais de uma saída do extrato compatível: escolher a correta com o comprovante antes de conciliar.";
  if (tem(MOTIVO.AJUSTE_MANUAL)) return "Revisar o ajuste manual do saldo com quem o lançou.";
  if (tem(MOTIVO.FORNECEDOR_NAO_IDENTIFICADO)) return "Identificar o fornecedor da conta.";
  if (tem(MOTIVO.VENCIDA)) return tem(MOTIVO.SEM_DOCUMENTO) ? "Confirmar se foi paga: se sim, anexar o comprovante e conciliar; se não, programar o pagamento." : "Confirmar se foi paga ou programar o pagamento.";
  if (tem(MOTIVO.PARCIAL)) return "Conferir o saldo restante e quando será pago.";
  if (tem(MOTIVO.PAGAMENTO_SEM_EXTRATO)) return "Vincular o pagamento registrado à saída do extrato (conciliação).";
  if (tem(MOTIVO.PAGA_SEM_COMPROVANTE)) return "Anexar o comprovante do pagamento.";
  if (tem(MOTIVO.SEM_DOCUMENTO)) return "Anexar a nota, o boleto ou o recibo da conta.";
  return "Conferir no Financeiro.";
}

/** Pendência de UMA conta (null quando não há motivo). Só fatos do registro do Financeiro e avisos rotulados. */
export function pendenciaDaConta(t, { todas, saidas, hoje, empresa = null, unidade = null }) {
  if (t.situacao === "CANCELADO") return null;
  const aberta = abertaComSaldo(t);
  const motivos = [];
  let candidatas = [];
  if (aberta) {
    if (t.vencimento && t.vencimento < hoje) motivos.push(MOTIVO.VENCIDA);
    if (inteiro(t.pagoCentavos) > 0) motivos.push(MOTIVO.PARCIAL);
    if (semDocumento(t)) motivos.push(MOTIVO.SEM_DOCUMENTO);
    if (!fornecedorIdentificado(t)) motivos.push(MOTIVO.FORNECEDOR_NAO_IDENTIFICADO);
    if (Array.isArray(saidas)) {
      candidatas = saidasCompativeis(t, saidas.filter((s) => livre(s) > 0));
      if (candidatas.length === 1) motivos.push(MOTIVO.POSSIVEL_PAGAMENTO_NO_EXTRATO);
      else if (candidatas.length > 1) motivos.push(MOTIVO.SAIDAS_COMPATIVEIS_AMBIGUAS);
    }
    if (inteiro(t.ajustesCentavos) !== 0) motivos.push(MOTIVO.AJUSTE_MANUAL);
  } else if (t.situacao === "PAGO" && pagaSemComprovante(t)) motivos.push(MOTIVO.PAGA_SEM_COMPROVANTE);
  if (inteiro(t.pagoCentavos) > 0 && pagamentosSemExtrato(t).length) motivos.push(MOTIVO.PAGAMENTO_SEM_EXTRATO);
  const duplicadas = [...possiveisDuplicidades(t, todas), ...contasParecidas(t, todas)].filter((x) => aberta || abertaComSaldo(x));
  if (duplicadas.length && (aberta || duplicadas.some(abertaComSaldo))) motivos.push(MOTIVO.POSSIVEL_DUPLICIDADE);
  if (!motivos.length) return null;
  const conciliacao = inteiro(t.pagoCentavos) === 0
    ? (candidatas.length === 1 ? "POSSIVEL_PAGAMENTO_NO_EXTRATO_NAO_CONFIRMADO" : candidatas.length > 1 ? "SAIDAS_COMPATIVEIS_AMBIGUAS" : Array.isArray(saidas) ? "SEM_PAGAMENTO_REGISTRADO" : "EXTRATO_INDISPONIVEL")
    : pagamentosSemExtrato(t).length ? "PAGAMENTO_REGISTRADO_SEM_EXTRATO" : "PAGAMENTO_CONCILIADO";
  return Object.freeze({
    id: t.id, empresa, unidade, descricao: t.descricao ?? null, fornecedor: fornecedorIdentificado(t) ? t.fornecedor.nome : null,
    categoria: t.categoria?.nome ?? null, competencia: t.competencia ?? null, vencimento: t.vencimento ?? null,
    valorCentavos: inteiro(t.valorOriginalCentavos), saldoCentavos: aberta ? t.saldoCentavos : 0, pagoCentavos: inteiro(t.pagoCentavos), ajustesCentavos: inteiro(t.ajustesCentavos),
    origem: t.origem?.tipo ?? t.origem ?? null, situacao: t.situacao,
    diasVencida: aberta && t.vencimento && t.vencimento < hoje ? dias(t.vencimento, hoje) : 0,
    documental: (t.documentos ?? []).length ? "COM_DOCUMENTO" : t.situacao === "PAGO" ? "PAGA_SEM_COMPROVANTE" : "SEM_DOCUMENTO",
    conciliacao, motivos: Object.freeze(motivos), rotulos: Object.freeze(motivos.map((m) => ROTULO_MOTIVO[m])), proximaAcao: proximaAcao(motivos, { candidatas }),
    candidatas: Object.freeze(candidatas.map((s) => ({ id: s.id, data: s.data, valorCentavos: s.valorCentavos, livreCentavos: livre(s), conta: s.conta?.nome ?? s.conta ?? null }))),
    duplicadas: Object.freeze(duplicadas.map((x) => ({ id: x.id, fornecedor: x.fornecedor?.nome ?? null, vencimento: x.vencimento, valorCentavos: x.valorOriginalCentavos, situacao: x.situacao }))),
  });
}

// ------------------------------------------------------------------------- saídas do extrato sem vínculo (Frente 3)
export const MOTIVO_SAIDA = Object.freeze({
  POSSIVEL_PAGAMENTO_DE_OBRIGACAO: "POSSIVEL_PAGAMENTO_DE_OBRIGACAO", TRANSFERENCIA_ENTRE_CONTAS: "TRANSFERENCIA_ENTRE_CONTAS", TARIFA_BANCARIA: "TARIFA_BANCARIA",
  EMPRESTIMO_OU_PARCELA: "EMPRESTIMO_OU_PARCELA", PAGAMENTO_DE_PESSOAL: "PAGAMENTO_DE_PESSOAL", BOLETO_PAGO: "BOLETO_PAGO", ARRECADACAO_OU_CONVENIO: "ARRECADACAO_OU_CONVENIO",
  SEM_ORIGEM_IDENTIFICADA: "SEM_ORIGEM_IDENTIFICADA",
});
export const ROTULO_SAIDA = Object.freeze({
  POSSIVEL_PAGAMENTO_DE_OBRIGACAO: "Possível pagamento de conta em aberto (valor igual e favorecido compatível)",
  TRANSFERENCIA_ENTRE_CONTAS: "Transferência entre contas (descrição do banco)",
  TARIFA_BANCARIA: "Tarifa ou pacote bancário",
  EMPRESTIMO_OU_PARCELA: "Empréstimo, parcela ou seguro do empréstimo",
  PAGAMENTO_DE_PESSOAL: "Pagamento a pessoa já registrada em conta de pessoal",
  BOLETO_PAGO: "Boleto pago (liquidação de título) sem conta vinculada",
  ARRECADACAO_OU_CONVENIO: "Guia, tributo ou conta de consumo paga por convênio",
  SEM_ORIGEM_IDENTIFICADA: "Sem origem identificada — pendente de classificação (não é pagamento nem despesa presumidos)",
});
const REGRAS_DESCRICAO = [
  [MOTIVO_SAIDA.TRANSFERENCIA_ENTRE_CONTAS, /\btransferencia entre contas\b|\bentre contas\b/],
  [MOTIVO_SAIDA.EMPRESTIMO_OU_PARCELA, /emprestim|\bparcela\b|financiament|prestamista|consorcio|capital de giro/],
  [MOTIVO_SAIDA.TARIFA_BANCARIA, /\btarifa|\bpj conta pj\b|\bpacote\b|cesta de servic|manutencao de conta|\biof\b/],
  [MOTIVO_SAIDA.BOLETO_PAGO, /liquidacao de titulo|pagamento de boleto|\bboleto\b/],
  [MOTIVO_SAIDA.ARRECADACAO_OU_CONVENIO, /arrecadacao|convenio|\bdarf\b|\bgps\b|\bdas\b/],
];
const CATEGORIA_PESSOAL = /folha|salari|pessoal|pro.?labore|diarist|funcionari|colaborador|ferias|rescis|13/;
// Nomes muito comuns não identificam ninguém sozinhos (prenomes e sobrenomes frequentes no Brasil).
const NOMES_COMUNS = new Set(["maria", "jose", "joao", "francisco", "francisca", "antonio", "antonia", "paulo", "pedro", "carlos", "lucas", "luiz", "luis", "marcos",
  "raimundo", "raimunda", "sandra", "silva", "santos", "souza", "sousa", "oliveira", "pereira", "costa", "rodrigues", "alves", "lima", "ferreira", "gomes", "ribeiro"]);
/** Mesma pessoa: dois nomes em comum, ou o ÚNICO nome do cadastro quando ele não é comum. */
export function mesmaPessoa(cadastro, favorecido) {
  const c = palavrasDoNome(cadastro), f = palavrasDoNome(favorecido);
  const comuns = [...c].filter((w) => f.has(w));
  return comuns.length >= 2 || (c.size === 1 && comuns.length === 1 && !NOMES_COMUNS.has(comuns[0]));
}
/** Favorecido no texto do banco: o que vem depois de "/" (sem o documento numérico), ou a descrição inteira. */
export function favorecidoDaSaida(descricao) {
  const d = String(descricao ?? "");
  const depois = d.includes("/") ? d.slice(d.lastIndexOf("/") + 1) : d;
  return depois.replace(/[0-9().]/g, " ").replace(/\s+/g, " ").trim();
}

/** Classifica cada saída sem vínculo pelo que os REGISTROS mostram (regra e evidência em cada item; nada é lançado). */
export function classificarSaidas(saidas, todas) {
  const livres = (saidas ?? []).filter((s) => livre(s) > 0);
  const abertas = todas.filter(abertaComSaldo);
  const pessoal = [...new Set(todas.filter((t) => fornecedorIdentificado(t) && CATEGORIA_PESSOAL.test(normalizar(`${t.categoria?.nome ?? ""} ${t.categoria?.codigo ?? ""}`)))
    .map((t) => t.fornecedor.nome))];
  const itens = livres.map((s) => {
    const contas = abertas.filter((t) => saidasCompativeis(t, [s]).length);
    const d = normalizar(s.descricao);
    let motivo = contas.length ? MOTIVO_SAIDA.POSSIVEL_PAGAMENTO_DE_OBRIGACAO : REGRAS_DESCRICAO.find(([, r]) => r.test(d))?.[0] ?? null;
    let evidencia = contas.length ? `${contas.length === 1 ? "1 conta" : `${contas.length} contas`} em aberto com o mesmo valor e favorecido compatível` : motivo ? "descrição do lançamento no extrato" : null;
    if (!motivo && pessoal.some((nome) => mesmaPessoa(nome, favorecidoDaSaida(s.descricao)))) { motivo = MOTIVO_SAIDA.PAGAMENTO_DE_PESSOAL; evidencia = "favorecido com o nome de quem já tem conta de pessoal registrada"; }
    if (!motivo) { motivo = MOTIVO_SAIDA.SEM_ORIGEM_IDENTIFICADA; evidencia = "nenhuma conta, regra de descrição ou pessoa registrada corresponde"; }
    return Object.freeze({ id: s.id, data: s.data, conta: s.conta?.nome ?? s.conta ?? null, descricao: s.descricao ?? null, valorCentavos: inteiro(s.valorCentavos), livreCentavos: livre(s),
      motivo, evidencia, contas: Object.freeze(contas.map((t) => t.id)) });
  });
  const grupos = Object.values(MOTIVO_SAIDA).map((m) => {
    const doGrupo = itens.filter((x) => x.motivo === m);
    return { motivo: m, rotulo: ROTULO_SAIDA[m], quantidade: doGrupo.length, totalCentavos: doGrupo.reduce((s, x) => s + x.livreCentavos, 0) };
  }).filter((g) => g.quantidade);
  const datas = livres.map((s) => s.data).filter(Boolean).sort();
  return Object.freeze({ quantidade: itens.length, totalCentavos: itens.reduce((s, x) => s + x.livreCentavos, 0), de: datas[0] ?? null, ate: datas.at(-1) ?? null,
    grupos: Object.freeze(grupos), itens: Object.freeze([...itens].sort((a, b) => b.livreCentavos - a.livreCentavos)) });
}

// --------------------------------------------------------------------------------------------- visão da conferência
/**
 * Visão completa: indicadores, pendências (ordenadas pelo que pede decisão humana) e saídas classificadas.
 * `saidas` null = extrato indisponível (as marcas de extrato ficam de fora e isso é dito, nunca "zero").
 */
export function montarConferencia({ todas, saidas, hoje, empresa = null, unidade = null, documentos = [] }) {
  const pendencias = todas.map((t) => pendenciaDaConta(t, { todas, saidas, hoje, empresa, unidade })).filter(Boolean)
    .sort((a, b) => Math.max(...b.motivos.map((m) => PESO[m] ?? 0)) - Math.max(...a.motivos.map((m) => PESO[m] ?? 0)) || b.saldoCentavos - a.saldoCentavos || b.pagoCentavos - a.pagoCentavos);
  const com = (m) => pendencias.filter((p) => p.motivos.includes(m));
  const soma = (l, campo = "saldoCentavos") => l.reduce((s, p) => s + p[campo], 0);
  const vencidas = com(MOTIVO.VENCIDA), parciais = com(MOTIVO.PARCIAL), semDoc = com(MOTIVO.SEM_DOCUMENTO), pagasSem = com(MOTIVO.PAGA_SEM_COMPROVANTE);
  const possiveis = [...com(MOTIVO.POSSIVEL_PAGAMENTO_NO_EXTRATO), ...com(MOTIVO.SAIDAS_COMPATIVEIS_AMBIGUAS)];
  const semFornecedor = com(MOTIVO.FORNECEDOR_NAO_IDENTIFICADO), duplic = com(MOTIVO.POSSIVEL_DUPLICIDADE), semExtrato = com(MOTIVO.PAGAMENTO_SEM_EXTRATO);
  const classificacao = Array.isArray(saidas) ? classificarSaidas(saidas, todas) : null;
  const aguardando = documentos.filter((d) => d.conferencia?.estado === "AGUARDANDO_CONFERENCIA");
  return Object.freeze({
    posicao: hoje, empresa, unidade, extratoDisponivel: Array.isArray(saidas),
    indicadores: Object.freeze({
      contasVencidas: vencidas.length, saldoVencidoCentavos: soma(vencidas),
      contasParciais: parciais.length, faltaParciaisCentavos: soma(parciais),
      documentosFaltantes: semDoc.length + pagasSem.length, abertasSemDocumento: semDoc.length, pagasSemComprovante: pagasSem.length,
      pagamentosAguardandoConciliacao: semExtrato.length, pagamentosSemExtratoCentavos: soma(semExtrato, "pagoCentavos"),
      possiveisPagamentosNoExtrato: classificacao ? possiveis.length : null, possiveisPagamentosCentavos: classificacao ? soma(possiveis) : null,
      saidasSemVinculo: classificacao?.quantidade ?? null, saidasSemVinculoCentavos: classificacao?.totalCentavos ?? null,
      fornecedoresNaoIdentificados: semFornecedor.length, semFornecedorCentavos: soma(semFornecedor),
      possiveisDuplicidades: duplic.length,
      documentosRecebidosMova: documentos.length, documentosAguardandoConferencia: aguardando.length,
    }),
    pendencias: Object.freeze(pendencias),
    saidas: classificacao,
  });
}

// ------------------------------------------------------------------------- documentos recebidos × contas relacionadas
const VAZIAS = new Set(["mova", "comprovante", "comprovantes", "pagamento", "pagamentos", "pago", "paga", "pix", "boleto", "nota", "fiscal", "recibo", "conta", "contas",
  "segue", "anexo", "documento", "transferencia", "referente", "para", "pelo", "pela", "valor", "reais", "favor", "obrigado", "obrigada"]);
/** Valor escrito ("R$ 1.234,56", "1234,56") em centavos; nenhum ⇒ null. */
export function valorNoTexto(texto) {
  const m = String(texto ?? "").match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b/i);
  return m ? Number(m[1].replace(/\./g, "")) * 100 + Number(m[2]) : null;
}
/**
 * Contas que PODEM se relacionar com um documento recebido, só pelo que uma pessoa escreveu (legenda ou busca) — o arquivo não é
 * lido. Sem nome nem valor ⇒ nenhuma sugestão. Até 8, abertas primeiro. É apoio à revisão, não vínculo.
 */
export function contasRelacionadas(todas, texto, { limite = 8 } = {}) {
  const valorCentavos = valorNoTexto(texto);
  const termos = [...new Set(normalizar(String(texto ?? "").replace(/(?:r\$\s*)?\d[\d.]*,\d{2}/gi, " ")).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !VAZIAS.has(w)))].slice(0, 6);
  if (!termos.length && !valorCentavos) return [];
  let achadas = buscarContas(todas, { termos, valorCentavos });
  if (!achadas.length && termos.length > 1) achadas = buscarContas(todas, { termos: termos.slice(0, 1), valorCentavos });
  return achadas.sort((a, b) => Number(abertaComSaldo(b)) - Number(abertaComSaldo(a)) || String(b.vencimento).localeCompare(String(a.vencimento))).slice(0, limite)
    .map((t) => Object.freeze({ id: t.id, fornecedor: fornecedorIdentificado(t) ? t.fornecedor.nome : null, descricao: t.descricao ?? null, vencimento: t.vencimento ?? null,
      valorCentavos: inteiro(t.valorOriginalCentavos), saldoCentavos: abertaComSaldo(t) ? t.saldoCentavos : 0, situacao: t.situacao }));
}
