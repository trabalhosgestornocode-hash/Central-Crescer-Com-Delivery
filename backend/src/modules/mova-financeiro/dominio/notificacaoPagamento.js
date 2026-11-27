// MOVA — 27/11: NOTIFICAÇÃO DE PAGAMENTO ao entregador (e aviso consolidado à gerência). Funções PURAS: não leem banco, relógio nem
// WhatsApp. Entrada = fatos já persistidos no Financeiro v2 (liquidações das obrigações dos fechamentos semanais, lidas por
// `consultarBaixasDeEntregadores`); saída = grupos de baixa, chaves de idempotência e textos de template (sem IA).
//
// REGRAS
//   - o fato é a LIQUIDAÇÃO persistida, nunca uma mensagem do WhatsApp; pagamento agendado (data futura), comprovante sem baixa e
//     proposta NÃO são pagamento efetivado e não geram aviso;
//   - nada anterior ao marco da unidade (primeira passada) vira mensagem: histórico não é avisado;
//   - uma baixa que paga várias semanas do MESMO entregador sai numa só mensagem, com cada período discriminado; entregadores
//     diferentes nunca se misturam e unidades diferentes nunca se misturam (a chamada é sempre de uma unidade);
//   - o texto sai só do retrato (`dados`) gravado no evento: reenvio e nova tentativa repetem exatamente o mesmo conteúdo.
import { createHash } from "node:crypto";
import { dataBr, reais } from "../aplicacao/respostas.js";

export const ASSINATURA = "MOVA | Crescer com Delivery";
export const TIPO_NOTIFICACAO = Object.freeze({ PAGAMENTO: "PAGAMENTO", PARCIAL: "PAGAMENTO_PARCIAL", ESTORNO: "ESTORNO", AVISO_GRUPO: "AVISO_GRUPO" });
/** Estados de uma notificação. Não há "ENTREGUE": o MOVA ainda não recebe o recibo de entrega do Gateway (só o aceite do WhatsApp). */
export const ESTADO_NOTIFICACAO = Object.freeze({
  PENDENTE: "PENDENTE", AGUARDANDO_ENTREGADOR: "AGUARDANDO_ENTREGADOR", ENFILEIRADO: "ENFILEIRADO", ENVIADO: "ENVIADO",
  FALHOU: "FALHOU", SEM_TELEFONE: "SEM_TELEFONE", SEM_GRUPO: "SEM_GRUPO", CANCELADO: "CANCELADO",
});
export const ESTADOS_EM_ANDAMENTO = Object.freeze([ESTADO_NOTIFICACAO.PENDENTE, ESTADO_NOTIFICACAO.AGUARDANDO_ENTREGADOR, ESTADO_NOTIFICACAO.ENFILEIRADO]);
export const LIMITE_DE_REENVIOS = 3;

const sha = (t) => createHash("sha256").update(String(t)).digest("hex");
const instante = (t) => (t ? Date.parse(t) : Number.NaN);
const primeiroNome = (n) => String(n ?? "").trim().split(/\s+/)[0] || "";
const efetivo = (q) => (q.valorCentavos ?? 0) - (q.estornadoCentavos ?? 0);
const periodo = (p) => `${dataBr(p.semanaInicio)} a ${dataBr(p.semanaFim)}`;

/** Rótulo (para a gerência) de onde a baixa veio, derivado do que está gravado — nunca do que alguém escreveu no WhatsApp. */
export function rotuloDaOrigem(origem) {
  const o = String(origem ?? "").toUpperCase();
  if (o === "COMPROVANTE") return "comprovante enviado no grupo";
  if (o === "SISTEMA" || o === "MANUAL") return "baixa registrada no sistema";
  if (/EXTRATO|OFX|BANCO|CONCILIA/.test(o)) return "conciliação bancária";
  return "baixa registrada no Financeiro";
}

/** Saldo restante da obrigação logo APÓS cada liquidação (ordem de criação), com os estornos já gravados. */
function saldoApos(itens) {
  const porObrigacao = new Map();
  for (const q of [...itens].sort((a, b) => instante(a.criadoEm) - instante(b.criadoEm) || a.liquidacaoId.localeCompare(b.liquidacaoId))) {
    porObrigacao.set(q.obrigacaoId, [...(porObrigacao.get(q.obrigacaoId) ?? []), q]);
  }
  const saldo = new Map();
  for (const lista of porObrigacao.values()) {
    let pago = 0;
    for (const q of lista) {
      pago += efetivo(q);
      saldo.set(q.liquidacaoId, Math.max(0, (q.totalDevidoCentavos ?? q.valorFechamentoCentavos ?? 0) - pago));
    }
  }
  return saldo;
}

/**
 * Fatos novos a notificar. `itens` = TODAS as liquidações das obrigações dos fechamentos (o saldo sequencial precisa delas).
 * @returns {{baixas:object[], estornos:object[], agendadas:number, historicas:number}}
 */
export function fatosDeBaixa(itens, { marcoEm, hoje }) {
  const marco = instante(marcoEm);
  if (!Number.isFinite(marco)) throw new TypeError("marcoEm inválido");
  const saldos = saldoApos(itens);
  const baixas = [], estornos = [];
  let agendadas = 0, historicas = 0;
  for (const q of itens) {
    const criada = instante(q.criadoEm), alterada = instante(q.atualizadoEm ?? q.criadoEm);
    if ((q.estornadoCentavos ?? 0) > 0 && alterada >= marco) estornos.push(q);
    if (!(criada >= marco)) { historicas += 1; continue; }
    if (efetivo(q) <= 0) continue; // totalmente estornada antes de ser avisada: não houve pagamento a comunicar
    if (q.dataEfetiva > hoje) { agendadas += 1; continue; } // agendado ≠ efetivado: espera a data
    baixas.push({ ...q, saldoAposCentavos: saldos.get(q.liquidacaoId) ?? 0 });
  }
  return { baixas, estornos, agendadas, historicas };
}

/** Uma mensagem por (entregador + movimentação); sem movimentação (comprovante), por liquidação. Semanas em ordem cronológica. */
export function agruparBaixas(baixas) {
  const grupos = new Map();
  for (const q of baixas) {
    const k = `${q.entregador.chave}|${q.movimentacaoId ?? `L:${q.liquidacaoId}`}`;
    grupos.set(k, [...(grupos.get(k) ?? []), q]);
  }
  return [...grupos.values()].map((lista) => {
    const ordenada = [...lista].sort((a, b) => a.semanaInicio.localeCompare(b.semanaInicio) || a.liquidacaoId.localeCompare(b.liquidacaoId));
    const periodos = ordenada.map((q) => ({ liquidacaoId: q.liquidacaoId, semanaInicio: q.semanaInicio, semanaFim: q.semanaFim, entregas: q.entregas, valorCentavos: efetivo(q), saldoCentavos: q.saldoAposCentavos }));
    const saldoRestanteCentavos = periodos.reduce((t, p) => t + p.saldoCentavos, 0);
    return {
      entregador: { chave: ordenada[0].entregador.chave, nome: ordenada[0].entregador.nome },
      tipo: saldoRestanteCentavos > 0 ? TIPO_NOTIFICACAO.PARCIAL : TIPO_NOTIFICACAO.PAGAMENTO,
      dados: {
        entregador: { chave: ordenada[0].entregador.chave, nome: ordenada[0].entregador.nome }, origem: ordenada[0].origem,
        dataEfetiva: ordenada.map((q) => q.dataEfetiva).sort().at(-1), periodos,
        totalCentavos: periodos.reduce((t, p) => t + p.valorCentavos, 0), entregas: periodos.reduce((t, p) => t + (p.entregas ?? 0), 0), saldoRestanteCentavos,
      },
      itens: ordenada.map((q) => ({ liquidacaoId: q.liquidacaoId, fato: "BAIXA" })),
    };
  });
}

/** Um aviso de estorno (só à gerência) por liquidação e valor estornado acumulado. */
export function gruposDeEstorno(estornos) {
  return estornos.map((q) => ({
    entregador: { chave: q.entregador.chave, nome: q.entregador.nome }, tipo: TIPO_NOTIFICACAO.ESTORNO,
    dados: {
      entregador: { chave: q.entregador.chave, nome: q.entregador.nome }, origem: q.origem, dataEfetiva: q.dataEfetiva,
      periodos: [{ liquidacaoId: q.liquidacaoId, semanaInicio: q.semanaInicio, semanaFim: q.semanaFim, entregas: q.entregas, valorCentavos: q.estornadoCentavos, saldoCentavos: 0 }],
      totalCentavos: q.estornadoCentavos, entregas: q.entregas, saldoRestanteCentavos: 0, totalEstorno: q.estornadoCentavos >= q.valorCentavos,
    },
    itens: [{ liquidacaoId: q.liquidacaoId, fato: `ESTORNO:${q.estornadoCentavos}` }],
  }));
}

/** Chave única do evento do ENTREGADOR (fato + destinatário + tipo). Sempre ≤ 300 caracteres. */
export function chaveDoEvento({ unidadeId, entregadorChave, tipo, itens }) {
  const primeiro = [...itens].sort((a, b) => `${a.liquidacaoId}${a.fato}`.localeCompare(`${b.liquidacaoId}${b.fato}`))[0];
  return `${tipo === TIPO_NOTIFICACAO.ESTORNO ? "EST" : "PAG"}|${unidadeId}|${sha(entregadorChave).slice(0, 16)}|${primeiro.liquidacaoId}|${primeiro.fato}`;
}
export const chaveDoAvisoDoGrupo = (chaveDoPai, reenvio = 0) => `GRP|${reenvio ? `R${reenvio}|` : ""}${chaveDoPai}`.slice(0, 300);

// ----------------------------------------------------------------------------------------------------------------- textos

const linhaDePeriodos = (dados) => (dados.periodos.length === 1
  ? [`📅 Período: ${periodo(dados.periodos[0])}`]
  : ["📅 Períodos:", ...dados.periodos.map((p) => `• ${periodo(p)} — ${p.entregas} entrega(s) — ${reais(p.valorCentavos)}`)]);

/** Mensagem ao entregador (modelo do proprietário, 27/11/2026). `empresa` = quem paga; nunca outra empresa do entregador. */
export function mensagemDePagamento(dados, { empresa, nome = null }) {
  const n = primeiroNome(nome ?? dados.entregador?.nome);
  const abre = `Olá${n ? `, ${n}` : ""}! 👋`;
  if (dados.saldoRestanteCentavos > 0) {
    return [abre, "✅ Recebemos um pagamento PARCIAL referente ao seu fechamento.", `🏢 Empresa: ${empresa}`, ...linhaDePeriodos(dados),
      `🛵 Quantidade de entregas: ${dados.entregas}`, `💰 Valor pago agora: ${reais(dados.totalCentavos)}`, `🧾 Saldo restante: ${reais(dados.saldoRestanteCentavos)}`,
      `🗓️ Data do pagamento: ${dataBr(dados.dataEfetiva)}`, "Assim que o restante for pago, avisamos por aqui.", ASSINATURA].join("\n");
  }
  return [abre, "✅ Seu pagamento foi realizado com sucesso!", `🏢 Empresa: ${empresa}`, ...linhaDePeriodos(dados),
    `🛵 Quantidade de entregas: ${dados.entregas}`, `💰 Valor pago: ${reais(dados.totalCentavos)}`, `🗓️ Data do pagamento: ${dataBr(dados.dataEfetiva)}`,
    "Agradecemos pela parceria e pelo trabalho realizado durante a semana!", ASSINATURA].join("\n");
}

const DESFECHO = Object.freeze({
  ENVIADO: "📲 Entregador notificado (mensagem aceita pelo WhatsApp).",
  FALHOU: "⚠️ Não foi possível notificar o entregador (falha de envio após as tentativas). Reenvie pela Central ou avise por outro canal.",
  SEM_TELEFONE: "⚠️ Entregador sem telefone cadastrado: avise-o por outro canal ou cadastre o número na Central.",
});

/** Aviso ÚNICO à gerência: o pagamento efetivado + o desfecho da mensagem do entregador (menos ruído que dois avisos). */
export function avisoDePagamentoNoGrupo(dados, { empresa, desfecho, parcial }) {
  return [`💸 ${parcial ? "Pagamento PARCIAL efetivado" : "Pagamento efetivado"} — ${empresa}`, `Entregador: ${dados.entregador?.nome ?? "-"}`,
    ...linhaDePeriodos(dados).map((l) => l.replace(/^📅 /, "")), `Entregas: ${dados.entregas}`, `Valor pago: ${reais(dados.totalCentavos)}`,
    ...(parcial ? [`Saldo restante: ${reais(dados.saldoRestanteCentavos)}`] : []), `Data: ${dataBr(dados.dataEfetiva)} · origem: ${rotuloDaOrigem(dados.origem)}`,
    DESFECHO[desfecho] ?? DESFECHO.FALHOU].join("\n");
}

export const avisoDeReenvioNoGrupo = (dados, { empresa }) => `📲 Reenvio concluído — ${empresa}\nEntregador: ${dados.entregador?.nome ?? "-"}\nO aviso de pagamento de ${reais(dados.totalCentavos)} foi aceito pelo WhatsApp.`;

export function avisoDeEstornoNoGrupo(dados, { empresa }) {
  return [`↩️ ${dados.totalEstorno ? "Estorno" : "Estorno PARCIAL"} de pagamento — ${empresa}`, `Entregador: ${dados.entregador?.nome ?? "-"}`,
    ...linhaDePeriodos(dados).map((l) => l.replace(/^📅 /, "")), `Valor estornado: ${reais(dados.totalCentavos)}`, `Data do pagamento original: ${dataBr(dados.dataEfetiva)}`,
    "O entregador não foi avisado automaticamente do estorno."].join("\n");
}
