// MOVA — Agente 2, Frente C: AUTONOMIA CONFIGURÁVEL das operações financeiras (política explícita, nunca implícita).
//
// Este módulo só DECIDE o nível de autonomia de uma proposta; ele não escreve nada. A aplicação continua no Centro Financeiro
// (serviços oficiais, com login e permissão própria). Regras fixas, que nenhuma política consegue afrouxar:
//   - sem política cadastrada para (operação, empresa, unidade) ⇒ SOMENTE_PROPOR;
//   - pagamento bancário, exclusão e estorno ⇒ PROIBIDO (o MOVA nunca paga nem apaga);
//   - comprovante isolado (imagem/PDF) nunca é liquidação COM EXTRATO: BAIXA_POR_EXTRATO/DESPESA_PAGA só com a saída do
//     EXTRATO conferida (conciliação única);
//   - Execução 17 — BAIXA_DOCUMENTAL (pagamento registrado POR COMPROVANTE, conciliação pendente): APLICAR_* só com o
//     comprovante avaliado como PIX_CONCLUIDO (avaliarComprovante: concluído, legível, consistente, não duplicado, arquivo
//     íntegro); APLICAR_AUTOMATICO exige também o identificador da transação (sem ele, cai para confirmação);
//   - acima do limite de valor da política ⇒ cai um nível (APLICAR_AUTOMATICO → APLICAR_COM_CONFIRMACAO → SOMENTE_PROPOR);
//   - política sempre com responsável, motivo e vigência; desligar = revogar (fica o histórico) e vale na hora.

export const NIVEL = Object.freeze({
  PROIBIDO: "PROIBIDO",
  SOMENTE_PROPOR: "SOMENTE_PROPOR",
  APLICAR_COM_CONFIRMACAO: "APLICAR_COM_CONFIRMACAO", // uma pessoa autorizada confirma no Centro Financeiro (1 clique, com prévia)
  APLICAR_AUTOMATICO: "APLICAR_AUTOMATICO",           // aplicação pelo serviço oficial, reversível pelo estorno oficial
});
const ORDEM = [NIVEL.PROIBIDO, NIVEL.SOMENTE_PROPOR, NIVEL.APLICAR_COM_CONFIRMACAO, NIVEL.APLICAR_AUTOMATICO];

/** Operações que uma política pode cobrir. Qualquer outra (ex.: PAGAMENTO_BANCARIO) é sempre PROIBIDA. */
export const OPERACAO = Object.freeze({
  BAIXA_POR_EXTRATO: "BAIXA_POR_EXTRATO",   // vincular conta a pagar a uma saída JÁ registrada no extrato
  DESPESA_PAGA: "DESPESA_PAGA",             // despesa paga sem conta prévia, ligada a saída do extrato
  CONTA_A_PAGAR: "CONTA_A_PAGAR",           // registrar obrigação a partir de boleto/nota
  ANEXAR_DOCUMENTO: "ANEXAR_DOCUMENTO",     // anexar evidência a lançamento existente (sem mexer em valor)
  BAIXA_DOCUMENTAL: "BAIXA_DOCUMENTAL",     // Execução 17: pagamento por COMPROVANTE (sem saída do extrato; conciliação pendente)
});
const SEMPRE_PROIBIDAS = new Set(["PAGAMENTO_BANCARIO", "EXCLUSAO", "ESTORNO", "TRANSFERENCIA"]);
/** Operações que liquidam (mexem em caixa): exigem a saída do extrato conferida para qualquer APLICAR_*. */
const LIQUIDAM = new Set([OPERACAO.BAIXA_POR_EXTRATO, OPERACAO.DESPESA_PAGA]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const falha = (campo, msg) => { throw Object.assign(new Error(`política de autonomia inválida (${campo}): ${msg}`), { codigo: "POLITICA_INVALIDA", campo }); };

/** Valida UMA política. Lança em qualquer campo ausente/estranho (lista fechada de chaves). */
export function validarPolitica(p) {
  const chaves = ["id", "operacao", "organizacaoId", "unidadeId", "nivel", "limiteCentavos", "responsavel", "motivo", "vigenteDe", "vigenteAte", "revogadaEm"];
  if (!p || typeof p !== "object") falha("politica", "ausente");
  for (const k of Object.keys(p)) if (!chaves.includes(k)) falha(k, "campo desconhecido");
  if (!Object.values(OPERACAO).includes(p.operacao)) falha("operacao", "não coberta por política");
  if (!UUID.test(p.organizacaoId ?? "")) falha("organizacaoId", "uuid");
  if (p.unidadeId !== null && p.unidadeId !== undefined && !UUID.test(p.unidadeId)) falha("unidadeId", "uuid ou null (todas da empresa)");
  if (![NIVEL.SOMENTE_PROPOR, NIVEL.APLICAR_COM_CONFIRMACAO, NIVEL.APLICAR_AUTOMATICO].includes(p.nivel)) falha("nivel", "nível inválido");
  if (!Number.isSafeInteger(p.limiteCentavos) || p.limiteCentavos < 0) falha("limiteCentavos", "inteiro ≥ 0");
  if (p.nivel !== NIVEL.SOMENTE_PROPOR && p.limiteCentavos === 0) falha("limiteCentavos", "aplicação exige limite positivo");
  if (typeof p.responsavel !== "string" || !p.responsavel.trim() || p.responsavel.length > 120) falha("responsavel", "obrigatório");
  if (typeof p.motivo !== "string" || p.motivo.trim().length < 10 || p.motivo.length > 500) falha("motivo", "obrigatório (10 a 500)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.vigenteDe ?? "")) falha("vigenteDe", "data");
  if (p.vigenteAte != null && (!/^\d{4}-\d{2}-\d{2}$/.test(p.vigenteAte) || p.vigenteAte < p.vigenteDe)) falha("vigenteAte", "data ≥ vigenteDe");
  // APLICAR_AUTOMATICO nunca para obrigação nova: registrar conta a pagar sempre tem uma pessoa na confirmação.
  if (p.nivel === NIVEL.APLICAR_AUTOMATICO && p.operacao === OPERACAO.CONTA_A_PAGAR) falha("nivel", "conta a pagar nova não é automática");
  return Object.freeze({ ...p, unidadeId: p.unidadeId ?? null, vigenteAte: p.vigenteAte ?? null, revogadaEm: p.revogadaEm ?? null });
}

/** Valida o conjunto: no máximo UMA política vigente por (operação, empresa, unidade). */
export function validarPoliticas(lista = []) {
  const v = lista.map(validarPolitica);
  const chave = (p) => `${p.operacao}|${p.organizacaoId}|${p.unidadeId ?? "*"}`;
  const ativas = v.filter((p) => !p.revogadaEm);
  const vistas = new Map();
  for (const p of ativas) {
    for (const q of vistas.get(chave(p)) ?? []) {
      const sobrepoe = (p.vigenteAte ?? "9999-12-31") >= q.vigenteDe && (q.vigenteAte ?? "9999-12-31") >= p.vigenteDe;
      if (sobrepoe) falha("vigencia", `duas políticas vigentes para ${chave(p)}`);
    }
    vistas.set(chave(p), [...(vistas.get(chave(p)) ?? []), p]);
  }
  return Object.freeze(v);
}

const descer = (nivel) => ORDEM[Math.max(1, ORDEM.indexOf(nivel) - 1)];

/**
 * Decide o nível de autonomia de UMA operação.
 * @param {object} p
 * @param {readonly object[]} p.politicas    já validadas
 * @param {string} p.operacao                OPERACAO.* (qualquer outra ⇒ PROIBIDO)
 * @param {string} p.organizacaoId
 * @param {string} p.unidadeId
 * @param {number} p.valorCentavos
 * @param {string} p.hoje                    AAAA-MM-DD
 * @param {{situacao:string, candidatas?:number}|null} [p.conciliacao]  resultado de conferirComExtrato
 * @returns {{nivel:string, motivos:string[], politicaId:string|null}}
 */
export function decidirAutonomia({ politicas, operacao, organizacaoId, unidadeId, valorCentavos, hoje, conciliacao = null, comprovante = null, acumuladoCentavos = 0 }) {
  if (SEMPRE_PROIBIDAS.has(operacao) || !Object.values(OPERACAO).includes(operacao)) return { nivel: NIVEL.PROIBIDO, motivos: ["OPERACAO_PROIBIDA"], politicaId: null };
  const vigente = (x) => !x.revogadaEm && x.vigenteDe <= hoje && (!x.vigenteAte || hoje <= x.vigenteAte);
  const daOperacao = politicas.filter((x) => x.operacao === operacao && x.organizacaoId === organizacaoId && vigente(x));
  // A política da UNIDADE prevalece sobre a da empresa (mais específica); nunca o contrário.
  const pol = daOperacao.find((x) => x.unidadeId === unidadeId) ?? daOperacao.find((x) => x.unidadeId === null) ?? null;
  if (!pol) return { nivel: NIVEL.SOMENTE_PROPOR, motivos: ["SEM_POLITICA"], politicaId: null };
  let nivel = pol.nivel;
  const motivos = [];
  if (nivel !== NIVEL.SOMENTE_PROPOR && !(Number.isSafeInteger(valorCentavos) && valorCentavos > 0)) { nivel = NIVEL.SOMENTE_PROPOR; motivos.push("VALOR_INVALIDO"); }
  if (nivel !== NIVEL.SOMENTE_PROPOR && valorCentavos > pol.limiteCentavos) { nivel = descer(nivel); motivos.push("ACIMA_DO_LIMITE"); }
  // Execução 17: o limite vale POR PAGAMENTO e não pode ser contornado dividindo um pagamento em vários comprovantes. O que já foi
  // baixado por comprovante na MESMA conta (ou ao MESMO favorecido em poucos dias) soma; passou do limite ⇒ confirmação humana.
  if (operacao === OPERACAO.BAIXA_DOCUMENTAL && nivel === NIVEL.APLICAR_AUTOMATICO && acumuladoCentavos > 0 && valorCentavos + acumuladoCentavos > pol.limiteCentavos) {
    nivel = NIVEL.APLICAR_COM_CONFIRMACAO; motivos.push("POSSIVEL_FRACIONAMENTO");
  }
  if (LIQUIDAM.has(operacao) && nivel !== NIVEL.SOMENTE_PROPOR && conciliacao?.situacao !== "CONFERIDA") {
    nivel = NIVEL.SOMENTE_PROPOR; motivos.push(conciliacao?.situacao === "AMBIGUA" ? "EXTRATO_AMBIGUO" : "SEM_EXTRATO_CONFERIDO");
  }
  if (operacao === OPERACAO.BAIXA_DOCUMENTAL && nivel !== NIVEL.SOMENTE_PROPOR) {
    if (conciliacao?.situacao === "AMBIGUA") { nivel = NIVEL.SOMENTE_PROPOR; motivos.push("EXTRATO_AMBIGUO"); }
    else if (!comprovante?.apto) { nivel = NIVEL.SOMENTE_PROPOR; motivos.push(`COMPROVANTE_${comprovante?.situacao ?? "NAO_AVALIADO"}`, ...(comprovante?.motivos ?? [])); }
    else if (nivel === NIVEL.APLICAR_AUTOMATICO && !comprovante.comIdentificador) { nivel = NIVEL.APLICAR_COM_CONFIRMACAO; motivos.push("SEM_IDENTIFICADOR_DA_TRANSACAO"); }
  }
  return { nivel, motivos, politicaId: pol.id ?? null };
}

/**
 * Confere um comprovante com as saídas do EXTRATO (já importadas no Financeiro), por leitura. Determinístico e conservador:
 * valor exato, data de até `toleranciaDias` e, quando ambos têm, o mesmo identificador da transação. Uma única candidata
 * ⇒ CONFERIDA; nenhuma ⇒ AGUARDANDO_EXTRATO; mais de uma ⇒ AMBIGUA (nunca escolhe sozinho).
 * @param {{valorCentavos:number, dataPagamento:string|null, idTransacao:string|null}} comprovante
 * @param {{id:string, data:string, disponivelCentavos:number, descricao?:string|null, idExterno?:string|null}[]} saidas
 */
export function conferirComExtrato(comprovante, saidas, { toleranciaDias = 2 } = {}) {
  if (!comprovante?.dataPagamento || !Number.isSafeInteger(comprovante.valorCentavos)) return { situacao: "AGUARDANDO_EXTRATO", candidatas: 0, movimentacaoId: null };
  const dia = (d) => Date.parse(`${d}T12:00:00Z`) / 86400000;
  const id = comprovante.idTransacao ?? null;
  const candidatas = (saidas ?? []).filter((m) => {
    if (m.disponivelCentavos !== comprovante.valorCentavos) return false;
    if (Math.abs(dia(m.data) - dia(comprovante.dataPagamento)) > toleranciaDias) return false;
    const idDaSaida = m.idExterno ?? null;
    return !(id && idDaSaida) || idDaSaida === id;
  });
  // O identificador igual desempata (a mesma transação); sem ele, duas saídas iguais continuam ambíguas.
  const porId = id ? candidatas.filter((m) => m.idExterno === id) : [];
  const finais = porId.length === 1 ? porId : candidatas;
  if (finais.length === 1) return { situacao: "CONFERIDA", candidatas: 1, movimentacaoId: finais[0].id };
  return { situacao: finais.length ? "AMBIGUA" : "AGUARDANDO_EXTRATO", candidatas: finais.length, movimentacaoId: null };
}
