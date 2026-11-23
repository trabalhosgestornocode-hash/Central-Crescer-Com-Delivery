// MOVA — Agente 2, Frente D: ROTINA SEMANAL DOS ENTREGADORES pelo WhatsApp (ponte com o fechamento oficial do Financeiro).
//
// Reaproveita o fechamento semanal de Financeiro v2 (entregadoresProprios.js: semana seg–dom, prazo da nota = início + 8 dias,
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
const LID = /^[0-9]{5,30}@lid$/;
export const PERFIL_ENTREGADOR = "ENTREGADOR";

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
    const ids = Array.isArray(x.ids) ? x.ids : [];
    if (!ids.every((j) => LID.test(j))) throw new TypeError(`entregadores[${i}].ids`);
    if (x.organizacaoId != null && !UUID.test(x.organizacaoId)) throw new TypeError(`entregadores[${i}].organizacaoId`);
    return Object.freeze({ organizacaoId: x.organizacaoId?.toLowerCase() ?? null, unidadeId: x.unidadeId.toLowerCase(), chave: x.chave, telefoneE164: x.telefoneE164, privado: x.privado,
      ids: Object.freeze([...ids]), nome: x.nome ?? null, ativo: x.ativo !== false });
  }));
}

/**
 * Conversa privada de cada entregador ATIVO: só aquele número (PN + LIDs cadastrados), uma unidade, perfil ENTREGADOR, sem
 * consultas no grupo. O número que já é conversa de outra pessoa (equipe) não vira conversa de entregador (`ocupados`).
 */
export function conversasDosEntregadores(entregadores, { ocupados = new Set() } = {}) {
  const porJid = new Map();
  for (const e of entregadores) if (e.ativo) porJid.set(e.privado, [...(porJid.get(e.privado) ?? []), e]);
  return [...porJid.entries()].filter(([jid, lista]) => lista.length === 1 && !ocupados.has(jid)).map(([jid, [e]]) => Object.freeze({
    grupoId: jid, unidades: Object.freeze([e.unidadeId]), acesso: "LISTA", privada: true, derivada: true, consultasNoGrupo: Object.freeze([]),
    entregador: Object.freeze({ chave: e.chave, unidadeId: e.unidadeId, nome: e.nome }),
    participantes: Object.freeze([Object.freeze({ ids: Object.freeze([jid, ...e.ids]), telefones: Object.freeze([e.telefoneE164]), perfil: PERFIL_ENTREGADOR, unidades: Object.freeze([e.unidadeId]), privado: jid, nome: e.nome })]),
  }));
}

/** Quem é o entregador desta conversa privada (por JID ou telefone verificado). Ambíguo ou desconhecido ⇒ null. */
export function identificarEntregador(entregadores, { privado = null, telefoneE164 = null, unidadeId = null }) {
  const achados = entregadores.filter((x) => x.ativo && ((privado && x.privado === privado) || (telefoneE164 && x.telefoneE164 === telefoneE164)) && (!unidadeId || x.unidadeId === unidadeId));
  return achados.length === 1 ? achados[0] : null;
}

/** Frase obrigatória (decisão do proprietário, 23/11/2026): nenhuma mensagem de fechamento sai sem ela antes da liberação. */
export const FRASE_NOTA_FISCAL = "O pagamento somente será liberado após o recebimento e a validação da nota fiscal correspondente aos serviços prestados.";

const primeiroNome = (n) => String(n ?? "").trim().split(/\s+/)[0] || "";
const dia = (d) => Date.parse(`${d}T12:00:00Z`) / 86400000;

/**
 * Mensagem de segunda-feira: o fechamento da semana do PRÓPRIO entregador (visão `visaoDoFechamento` do Financeiro).
 * Sem fechamento ou com duplicidade em aberto ⇒ null (não envia número que ainda pode mudar).
 */
export function mensagemSemanal(fechamento, { unidade = null, empresa = null } = {}) {
  if (!fechamento || fechamento.duplicidade || !Number.isSafeInteger(fechamento.valorCentavos)) return null;
  const nome = primeiroNome(fechamento.entregador?.nome);
  const linhas = [
    `Olá${nome ? `, ${nome}` : ""}! Fechamento da semana ${dataBr(fechamento.semanaInicio)} a ${dataBr(fechamento.semanaFim)}:`,
    ...(empresa || unidade ? [`Empresa: ${empresa ?? unidade} — Unidade: ${unidade ?? empresa}`] : []),
    `• ${fechamento.entregas} entrega(s) — ${reais(fechamento.valorCentavos)}`,
  ];
  if (fechamento.ajustesCentavos) linhas.push(`• inclui ajustes de ${reais(fechamento.ajustesCentavos)}`);
  if (AGUARDANDO.includes(fechamento.situacaoDocumental)) {
    linhas.push(`Envie a nota fiscal (NFS-e em PDF) de ${reais(fechamento.valorCentavos)} por aqui até ${dataBr(fechamento.prazoDaNota)}.`);
    linhas.push(FRASE_NOTA_FISCAL);
  } else if (["NF_RECEBIDA", "NF_EM_CONFERENCIA", "NF_APROVADA"].includes(fechamento.situacaoDocumental)) {
    linhas.push("Sua nota já foi recebida e está em conferência.");
    linhas.push(FRASE_NOTA_FISCAL);
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

// ── 23/11/2026: cadastro pelo gestor, conferência da nota, aviso no grupo e relatório de quarta ───────────────────────────────

/**
 * Número informado pelo gestor → E.164 brasileiro e conversa privada. Aceita com ou sem +55, DDD, espaços e traços.
 * Celular com 11 dígitos (DDD + 9 + 8) ou fixo/legado com 10. Qualquer outra coisa ⇒ null (não cadastra).
 */
export function normalizarTelefoneBr(texto) {
  let d = String(texto ?? "").replace(/\D/g, "");
  if (d.length === 12 || d.length === 13) { if (!d.startsWith("55")) return null; d = d.slice(2); }
  if (d.length !== 10 && d.length !== 11) return null;
  if (!/^[1-9][1-9]/.test(d)) return null; // DDD válido
  if (d.length === 11 && d[2] !== "9") return null; // celular de 11 dígitos começa com 9
  return Object.freeze({ telefoneE164: `+55${d}`, privado: `55${d}@s.whatsapp.net` });
}

const normalizarNome = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter((p) => p.length > 2);
/** Mesma pessoa/empresa pelo nome: todos os termos do nome mais curto aparecem no outro (pelo menos 2, se houver). */
export function nomesConferem(a, b) {
  const x = normalizarNome(a), y = normalizarNome(b);
  if (!x.length || !y.length) return false;
  const [curto, longo] = x.length <= y.length ? [x, y] : [y, x];
  return curto.length >= Math.min(2, longo.length) && curto.every((p) => longo.includes(p));
}
const soDigitos = (s) => String(s ?? "").replace(/\D/g, "");

/**
 * Conferência da NFS-e lida contra o fechamento OFICIAL. Nunca libera nada: devolve CONFERE / DIVERGENTE / INCONCLUSIVA.
 *   valor: igual ao do fechamento; período: competência do mês da semana ou emissão a partir do início da semana;
 *   emitente: nome do entregador; tomador: CNPJ da unidade (quando cadastrado) ou nome da empresa/unidade.
 * A situação fiscal NÃO é consultada (sem fonte oficial integrada): o resultado diz isso, e a validação final é humana.
 */
export function conferirNotaDoEntregador({ leitura, fechamento, unidade = null, empresa = null, cnpjTomador = null }) {
  const motivos = [];
  const incertos = [];
  if (!leitura || leitura.legivel === false || leitura.tipoDocumento !== "NOTA_FISCAL") return Object.freeze({ resultado: "INCONCLUSIVA", motivos: Object.freeze(["NAO_E_NOTA_FISCAL_LEGIVEL"]), situacaoFiscal: "NAO_CONSULTADA" });
  if (leitura.confianca === "BAIXA") incertos.push("LEITURA_DE_BAIXA_CONFIANCA");
  if (!Number.isSafeInteger(leitura.valorCentavos)) incertos.push("VALOR_NAO_LIDO");
  else if (leitura.valorCentavos !== fechamento.valorCentavos) motivos.push("VALOR_DIFERENTE_DO_FECHAMENTO");
  const mesDaSemana = String(fechamento.semanaInicio).slice(0, 7), mesDoFim = String(fechamento.semanaFim ?? fechamento.semanaInicio).slice(0, 7);
  if (leitura.competencia) { if (![mesDaSemana, mesDoFim].includes(leitura.competencia)) motivos.push("PERIODO_DIFERENTE"); }
  else if (leitura.dataEmissao) { if (leitura.dataEmissao < fechamento.semanaInicio) motivos.push("EMITIDA_ANTES_DA_SEMANA"); }
  else incertos.push("PERIODO_NAO_LIDO");
  const emitente = leitura.favorecido ?? null;
  if (!emitente) incertos.push("EMITENTE_NAO_LIDO");
  else if (!nomesConferem(emitente, fechamento.entregador?.nome)) motivos.push("EMITENTE_NAO_E_O_ENTREGADOR");
  const tomador = leitura.pagador ?? null, docTomador = soDigitos(leitura.documentoDestinatario);
  if (cnpjTomador && docTomador.length === 14) { if (docTomador !== soDigitos(cnpjTomador)) motivos.push("TOMADOR_DIFERENTE"); }
  else if (!tomador) incertos.push("TOMADOR_NAO_LIDO");
  else if (!nomesConferem(tomador, empresa) && !nomesConferem(tomador, unidade)) incertos.push("TOMADOR_NAO_CONFIRMADO");
  const resultado = motivos.length ? "DIVERGENTE" : incertos.length ? "INCONCLUSIVA" : "CONFERE";
  return Object.freeze({ resultado, motivos: Object.freeze([...motivos, ...incertos]), situacaoFiscal: "NAO_CONSULTADA" });
}

const MOTIVO_NOTA = Object.freeze({
  VALOR_DIFERENTE_DO_FECHAMENTO: "valor diferente do fechamento", PERIODO_DIFERENTE: "período diferente da semana", EMITIDA_ANTES_DA_SEMANA: "emitida antes da semana",
  EMITENTE_NAO_E_O_ENTREGADOR: "o emitente não é você", TOMADOR_DIFERENTE: "o tomador não é a empresa", NAO_E_NOTA_FISCAL_LEGIVEL: "não deu para ler como nota fiscal",
});
/** Resposta ao entregador depois da leitura da nota (a liberação continua sendo do financeiro). */
export function respostaDaConferencia(f, conferencia) {
  const base = `nota da semana ${dataBr(f.semanaInicio)} (${reais(f.valorCentavos)})`;
  if (conferencia?.resultado === "DIVERGENTE") {
    const m = conferencia.motivos.map((x) => MOTIVO_NOTA[x]).filter(Boolean);
    return `Recebi sua ${base}, mas encontrei divergência: ${m.join("; ") || "dados diferentes do fechamento"}. O financeiro vai revisar; se precisar, envie a nota corrigida em PDF. ${FRASE_NOTA_FISCAL}`;
  }
  if (conferencia?.resultado === "CONFERE") return `Recebi sua ${base}: os dados conferem com o fechamento. Ela segue para a validação do financeiro; aviso quando o pagamento for liberado.`;
  return `Recebi sua ${base}. Ela ficou em análise pelo financeiro; aviso quando o pagamento for liberado. ${FRASE_NOTA_FISCAL}`;
}

/** Aviso no GRUPO financeiro da unidade quando a obrigação é LIBERADA (liberação documental não é pagamento bancário). */
export function avisoDeLiberacao(f, { unidade = null } = {}) {
  return [
    `Entregador liberado para pagamento${unidade ? ` — ${unidade}` : ""}:`,
    `• ${f.entregador?.nome ?? "Entregador"} — semana ${dataBr(f.semanaInicio)} a ${dataBr(f.semanaFim)} — ${reais(f.valorCentavos)}`,
    `Situação: nota validada, pagamento liberado (vencimento ${dataBr(f.vencimento)}). ${f.situacaoPagamento === "PAGO" ? "Pagamento bancário já registrado." : "Pagamento bancário ainda não registrado."}`,
  ].join("\n");
}

/** Classificação do relatório de quarta (por fechamento oficial e, se houver, pela nota recebida pelo MOVA). */
export function classeDoRelatorio(f, notaMova = null) {
  if (f.situacaoPagamento === "PAGO") return "PAGO";
  if (f.situacaoDocumental === "LIBERADO_PAGAMENTO") return "LIBERADO";
  if (f.situacaoDocumental === "NF_REJEITADA" || f.duplicidade || notaMova?.conferencia === "DIVERGENTE") return "DIVERGENCIA";
  if (["NF_RECEBIDA", "NF_EM_CONFERENCIA", "NF_APROVADA"].includes(f.situacaoDocumental) || notaMova) return "EM_ANALISE";
  return "SEM_NOTA";
}

/**
 * Relatório de quarta-feira de UMA unidade (o grupo só recebe a própria unidade). `fechamentos` = os oficiais considerados;
 * `notas` = notas recebidas pelo MOVA, por "entregador|semana".
 */
export function relatorioDeQuarta({ unidade, empresa = null, fechamentos, notas = new Map(), hoje }) {
  const grupos = { LIBERADO: [], SEM_NOTA: [], EM_ANALISE: [], DIVERGENCIA: [], PAGO: [] };
  for (const f of fechamentos) grupos[classeDoRelatorio(f, notas.get(`${f.entregador?.chave}|${f.semanaInicio}`))].push(f);
  const soma = (l) => l.reduce((s, f) => s + f.valorCentavos, 0);
  const linha = (f) => `  • ${f.entregador?.nome ?? "—"} (semana ${dataBr(f.semanaInicio)}) — ${reais(f.valorCentavos)}`;
  const bloco = (titulo, l) => [`${titulo}: ${l.length}`, ...l.map(linha)];
  const pendente = [...grupos.SEM_NOTA, ...grupos.EM_ANALISE, ...grupos.DIVERGENCIA];
  return [
    `Entregadores — situação em ${dataBr(hoje)}`,
    `Empresa: ${empresa ?? unidade} — Unidade: ${unidade}`,
    ...bloco("Liberados", grupos.LIBERADO), ...bloco("Sem nota", grupos.SEM_NOTA), ...bloco("Notas em análise", grupos.EM_ANALISE),
    ...bloco("Notas com divergência", grupos.DIVERGENCIA), ...bloco("Pagamentos realizados", grupos.PAGO),
    `Total liberado (a pagar): ${reais(soma(grupos.LIBERADO))}`,
    `Total pendente: ${reais(soma(pendente))}`,
    `Total pago: ${reais(soma(grupos.PAGO))}`,
  ].join("\n");
}
