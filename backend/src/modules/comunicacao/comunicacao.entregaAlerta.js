// RESUMO DE ENTREGA POR DESTINATÁRIO de um alerta (migration 104) — função PURA, só leitura.
//
// O status agregado do ALERTA (comunicacao_status_agregado_alerta) é deliberadamente "otimista": basta UM destinatário ter recebido para o alerta
// sair de DETECTED/SCHEDULED — é isso que impede o reprocessamento (nenhum reenvio automático por causa de uma falha individual). Só que isso
// ESCONDERIA uma entrega parcial ("João recebeu, Maria falhou"). Este resumo é a visão administrativa honesta: contagens separadas + situação.
// NÃO altera nenhum estado, NÃO agenda nada, NÃO reenvia — apenas descreve o que as mensagens INICIAIS (não o reforço) já mostram.

/** Situação da entrega do alerta para a Central/Painel. */
export const SITUACAO_ENTREGA = Object.freeze({
  SEM_MENSAGENS: "SEM_MENSAGENS",
  COMPLETA: "COMPLETA",
  PARCIAL: "PARCIAL",
  PARCIAL_EM_ANDAMENTO: "PARCIAL_EM_ANDAMENTO",
  PENDENTE: "PENDENTE",
  INCERTA: "INCERTA",
  SEM_ENTREGA: "SEM_ENTREGA",
});

const ENVIADAS = new Set(["SENT", "DELIVERED", "READ"]);
const CONFIRMADAS = new Set(["DELIVERED", "READ"]);
const PENDENTES = new Set(["SCHEDULED", "PROCESSING", "SENDING"]);

const ehInicial = (m) => (m?.metadados?.proposito ?? "inicial") === "inicial" && (m?.direcao ?? "saida") === "saida";

/**
 * @param {Array<{status: string, erro?: string|null, metadados?: object|null, direcao?: string}>} mensagens  mensagens do alerta (o reforço é ignorado)
 * @returns {{previstos:number, enviados:number, entreguesConfirmados:number, pendentes:number, entregaIncerta:number, falhaPermanente:number, optOut:number,
 *            bloqueados:number, expirados:number, situacao:string, rotulo:string}}
 */
export function resumirEntregaAlerta(mensagens) {
  const iniciais = (mensagens ?? []).filter(ehInicial);
  const c = { previstos: iniciais.length, enviados: 0, entreguesConfirmados: 0, pendentes: 0, entregaIncerta: 0, falhaPermanente: 0, optOut: 0, bloqueados: 0, expirados: 0 };
  for (const m of iniciais) {
    if (ENVIADAS.has(m.status)) { c.enviados++; if (CONFIRMADAS.has(m.status)) c.entreguesConfirmados++; }
    else if (PENDENTES.has(m.status)) c.pendentes++;
    else if (m.status === "DELIVERY_UNKNOWN") c.entregaIncerta++;
    else if (m.status === "FAILED") c.falhaPermanente++;
    else if (m.status === "BLOCKED") { if (m.erro === "OPT_OUT") c.optOut++; else c.bloqueados++; }
    else if (m.status === "CANCELLED") c.expirados++;
  }
  const { previstos: n, enviados: e } = c;
  let situacao; let rotulo;
  if (n === 0) { situacao = SITUACAO_ENTREGA.SEM_MENSAGENS; rotulo = "Nenhuma mensagem prevista"; }
  else if (e === n) { situacao = SITUACAO_ENTREGA.COMPLETA; rotulo = n === 1 ? "Enviado ao destinatário" : `Enviado a todos os ${n} destinatários`; }
  else if (e > 0 && (c.pendentes > 0 || c.entregaIncerta > 0)) {
    situacao = SITUACAO_ENTREGA.PARCIAL_EM_ANDAMENTO; rotulo = `Parcial em andamento — ${e} de ${n} destinatários já receberam; ${c.pendentes + c.entregaIncerta} pendente(s)`;
  } else if (e > 0) { situacao = SITUACAO_ENTREGA.PARCIAL; rotulo = `Entregue parcialmente — ${e} de ${n} destinatários receberam`; }
  else if (c.pendentes > 0) { situacao = SITUACAO_ENTREGA.PENDENTE; rotulo = `Aguardando envio a ${c.pendentes} destinatário(s)`; }
  else if (c.entregaIncerta > 0) { situacao = SITUACAO_ENTREGA.INCERTA; rotulo = "Entrega incerta — conferir no aparelho antes de qualquer reenvio"; }
  else { situacao = SITUACAO_ENTREGA.SEM_ENTREGA; rotulo = "Nenhum destinatário recebeu"; }
  return { ...c, situacao, rotulo };
}
