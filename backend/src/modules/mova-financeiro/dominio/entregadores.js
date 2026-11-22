// MOVA — Agente 2, Frente D: ROTINA SEMANAL DOS ENTREGADORES pelo WhatsApp (ponte com o fechamento oficial do Financeiro).
//
// Reaproveita o fechamento semanal de financeiro-v2 (entregadoresProprios.js: semana seg–dom, prazo da nota = início + 8 dias,
// conferência de NF, liberação). Este módulo só COMPÕE mensagens e decide o encaminhamento; não escreve no Financeiro:
//   - o entregador é identificado pelo número CADASTRADO (lista fechada por unidade), nunca pelo nome digitado;
//   - ele só vê o PRÓPRIO fechamento (nunca o de outro entregador, nem total da unidade);
//   - a nota recebida vira PENDÊNCIA DE ANEXO para o Centro Financeiro (anexarDocumentoDoEntregador exige permissão de
//     escrita, que o MOVA não tem); a leitura/conferência automática da NFS-e continua sendo a do Financeiro;
//   - nenhuma mensagem sai sem o agendamento ligado e o envio liberado (mova.controle); nada de envio em teste.
import { reais, dataBr } from "../aplicacao/respostas.js";

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVADO = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
const AGUARDANDO = ["AGUARDANDO_NF", "NF_REJEITADA"];

/** Lista fechada: { unidadeId, chave (do fechamento), telefoneE164, privado (jid), nome? }. Telefone único POR UNIDADE. */
export function validarEntregadores(lista = []) {
  const vistos = new Set();
  return Object.freeze(lista.map((x, i) => {
    if (!UUID.test(x?.unidadeId ?? "")) throw new TypeError(`entregadores[${i}].unidadeId`);
    if (typeof x.chave !== "string" || !x.chave.trim() || x.chave.length > 200) throw new TypeError(`entregadores[${i}].chave`);
    if (!E164.test(x.telefoneE164 ?? "")) throw new TypeError(`entregadores[${i}].telefoneE164`);
    if (!PRIVADO.test(x.privado ?? "")) throw new TypeError(`entregadores[${i}].privado`);
    const k = `${x.unidadeId.toLowerCase()}|${x.telefoneE164}`;
    if (vistos.has(k)) throw new TypeError(`entregadores[${i}]: telefone repetido na unidade`);
    vistos.add(k);
    return Object.freeze({ unidadeId: x.unidadeId.toLowerCase(), chave: x.chave, telefoneE164: x.telefoneE164, privado: x.privado, nome: x.nome ?? null, ativo: x.ativo !== false });
  }));
}

/** Quem é o entregador desta conversa privada (por JID ou telefone verificado). Ambíguo ou desconhecido ⇒ null. */
export function identificarEntregador(entregadores, { privado = null, telefoneE164 = null, unidadeId = null }) {
  const achados = entregadores.filter((x) => x.ativo && ((privado && x.privado === privado) || (telefoneE164 && x.telefoneE164 === telefoneE164)) && (!unidadeId || x.unidadeId === unidadeId));
  return achados.length === 1 ? achados[0] : null;
}

const primeiroNome = (n) => String(n ?? "").trim().split(/\s+/)[0] || "";
const dia = (d) => Date.parse(`${d}T12:00:00Z`) / 86400000;

/**
 * Mensagem de segunda-feira: o fechamento da semana do PRÓPRIO entregador (visão `visaoDoFechamento` do Financeiro).
 * Sem fechamento ou com duplicidade em aberto ⇒ null (não envia número que ainda pode mudar).
 */
export function mensagemSemanal(fechamento) {
  if (!fechamento || fechamento.duplicidade || !Number.isSafeInteger(fechamento.valorCentavos)) return null;
  const nome = primeiroNome(fechamento.entregador?.nome);
  const linhas = [
    `Olá${nome ? `, ${nome}` : ""}! Fechamento da semana ${dataBr(fechamento.semanaInicio)} a ${dataBr(fechamento.semanaFim)}:`,
    `• ${fechamento.entregas} entrega(s) — ${reais(fechamento.valorCentavos)}`,
  ];
  if (fechamento.ajustesCentavos) linhas.push(`• inclui ajustes de ${reais(fechamento.ajustesCentavos)}`);
  if (AGUARDANDO.includes(fechamento.situacaoDocumental)) {
    linhas.push(`Envie a nota fiscal (NFS-e em PDF) de ${reais(fechamento.valorCentavos)} por aqui até ${dataBr(fechamento.prazoDaNota)}. O pagamento é liberado depois da conferência da nota.`);
  } else if (["NF_RECEBIDA", "NF_EM_CONFERENCIA"].includes(fechamento.situacaoDocumental)) {
    linhas.push("Sua nota já foi recebida e está em conferência.");
  } else if (fechamento.situacaoDocumental === "LIBERADO_PAGAMENTO") {
    linhas.push(`Nota aprovada; pagamento liberado (vencimento ${dataBr(fechamento.vencimento)}).`);
  }
  linhas.push("Dúvidas sobre os valores: responda aqui que o financeiro confere.");
  return linhas.join("\n");
}

/** Cobrança da nota: só para quem ainda não mandou (ou teve a nota rejeitada), a partir de `diasAntes` do prazo. */
export function precisaCobrarNota(fechamento, hoje, { diasAntes = 2 } = {}) {
  if (!fechamento || fechamento.duplicidade || !AGUARDANDO.includes(fechamento.situacaoDocumental)) return false;
  return dia(hoje) >= dia(fechamento.prazoDaNota) - diasAntes;
}

export function mensagemCobrancaNota(f, hoje) {
  return hoje > f.prazoDaNota
    ? `Lembrete: a nota fiscal da semana ${dataBr(f.semanaInicio)} (${reais(f.valorCentavos)}) venceu o prazo em ${dataBr(f.prazoDaNota)}. Sem a nota o pagamento fica retido. Envie o PDF por aqui.`
    : `Lembrete: envie a nota fiscal da semana ${dataBr(f.semanaInicio)} (${reais(f.valorCentavos)}) até ${dataBr(f.prazoDaNota)}. Envie o PDF por aqui.`;
}

/**
 * Nota recebida no privado do entregador ⇒ pendência para o Centro Financeiro anexar pelo serviço oficial.
 * Só PDF; só para o fechamento do PRÓPRIO entregador que ainda aceite nota.
 */
export function pendenciaDeNota({ entregador, fechamento, midia, recebidoEm = null }) {
  if (!entregador || !fechamento) return { ok: false, motivo: "ENTREGADOR_OU_SEMANA_DESCONHECIDOS" };
  if (fechamento.entregador?.chave !== entregador.chave) return { ok: false, motivo: "FECHAMENTO_DE_OUTRO_ENTREGADOR" };
  if (!midia || midia.mime !== "application/pdf") return { ok: false, motivo: "NOTA_PRECISA_SER_PDF" };
  if (fechamento.situacaoDocumental === "LIBERADO_PAGAMENTO") return { ok: false, motivo: "PAGAMENTO_JA_LIBERADO" };
  if (fechamento.duplicidade) return { ok: false, motivo: "SEMANA_COM_DUPLICIDADE" };
  return {
    ok: true,
    pendencia: Object.freeze({
      tipo: "ANEXAR_NOTA_DO_ENTREGADOR", unidadeId: entregador.unidadeId, entregador: entregador.chave, inicio: fechamento.semanaInicio,
      evidencia: midia.referencia, sha256: midia.sha256 ?? null, recebidoEm,
      // Para a operação oficial anexarDocumentoDoEntregador({ inicio, entregador, arquivo, tipoAnexo: "NOTA_FISCAL" }), no Centro Financeiro.
      operacaoOficial: "anexarDocumentoDoEntregador",
    }),
    resposta: "Recebi sua nota. Ela vai para a conferência do financeiro; aviso quando o pagamento for liberado.",
  };
}
