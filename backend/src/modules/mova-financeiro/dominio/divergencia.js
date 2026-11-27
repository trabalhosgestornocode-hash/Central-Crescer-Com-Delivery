// DIVERGÊNCIA entre o comprovante e as contas a pagar (MOVA financeiro autônomo, 23/11/2026) — regras PURAS, sem I/O.
//
// O motor decide uma de três coisas ao casar um comprovante com as contas abertas:
//   EXECUTAR   — valor igual ao saldo de UMA conta (baixa), ou nenhuma conta do favorecido (despesa nova);
//   PERGUNTAR  — valor maior (juros? outra compra?), valor menor (parcial?), várias contas candidatas;
//   (encaminhar para conferência fica no motor: duplicidade, perfil, competência fechada, limite etc.)
// Regra de ouro: diferença de valor NUNCA é presumida como juros, nem a conta presumida como compra nova; uma pergunta
// objetiva resolve e a conversa continua sem segunda confirmação. A IA não decide nada aqui: respostas são interpretadas
// por regras determinísticas.

// 24/11: NOVA_OU_CONTA — o comprovante supera MUITO o saldo da única conta do favorecido (diferença grande demais para ser juros):
// a pergunta é "é uma compra nova?" ("sim" = compra nova). DESCRICAO — compra nova sem descrição nem categoria: "o que foi comprado?".
export const TIPO_DIVERGENCIA = Object.freeze({ MAIOR: "MAIOR", MENOR: "MENOR", VARIAS: "VARIAS", SEMELHANTE: "SEMELHANTE", NOVA_OU_CONTA: "NOVA_OU_CONTA", DESCRICAO: "DESCRICAO", COMPETENCIA: "COMPETENCIA", MESMA_COMPRA: "MESMA_COMPRA" });
export const DESFECHO = Object.freeze({ JUROS: "JUROS", PARCIAL: "PARCIAL", NOVA: "NOVA", ESCOLHER: "ESCOLHER", MESMA: "MESMA", NAO_ENTENDI: "NAO_ENTENDI" });
export const MAX_CANDIDATAS_NA_PERGUNTA = 5;

export const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
// 26/11: resposta curta a uma pergunta, sem a menção "MOVA" do início (no grupo, citar mensagem humana exige a menção: "MOVA sim").
const resposta = (s) => normalizar(s).replace(/^mova\b\s*/, "");

const SIM = /^(sim|s|isso|isso mesmo|exato|exatamente|correto|certo|confirmo|isso ai|e sim|sao|sao sim|foi|foi sim|ok)$/;
const NAO = /^(nao|n|negativo|nao e|nao sao|nao foi|nao eh)$/;
const PALAVRA_JUROS = /\b(juros?|multa|mora|encargos?|acrescimos?)\b/;
const PALAVRA_PARCIAL = /\b(parcial|parcela|entrada|sinal|adiantamento|restante|resto|metade|primeira)\b/;
const PALAVRA_NOVA = /\b(nova|novo|outra|outro|compra|nenhuma|nenhum|diferente|avulsa)\b/;

/** A legenda da mensagem deixa claro que o pagamento é parcial? (só então a baixa parcial dispensa pergunta) */
export const legendaIndicaParcial = (legenda) => PALAVRA_PARCIAL.test(normalizar(legenda));
/** A legenda cita juros/multa? (mesmo assim o MOVA confirma a composição da diferença; nunca presume) */
export const legendaCitaJuros = (legenda) => PALAVRA_JUROS.test(normalizar(legenda));

/**
 * 25/11 — COMPOSIÇÃO do pagamento impressa no comprovante (boleto com juros/multa): só vale quando é COMPROVADA, isto é,
 * original + juros + multa − desconto = valor pago, centavo a centavo. Sem encargo, com desconto (sem serviço para abater na mesma
 * operação) ou soma que não fecha ⇒ null (o MOVA segue o fluxo normal, com pergunta). Genérico: nenhum fornecedor é especial.
 * @returns {{principalCentavos:number, jurosCentavos:number, multaCentavos:number, encargoCentavos:number}|null}
 */
export function composicaoComprovada(saida) {
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const original = saida?.valorOriginalCentavos; const pago = saida?.valorCentavos;
  if (!Number.isSafeInteger(original) || original <= 0 || !Number.isSafeInteger(pago) || pago <= 0) return null;
  const juros = n(saida.jurosCentavos); const multa = n(saida.multaCentavos); const desconto = n(saida.descontoCentavos);
  if (juros + multa === 0 || desconto > 0 || original + juros + multa - desconto !== pago) return null;
  return { principalCentavos: original, jurosCentavos: juros, multaCentavos: multa, encargoCentavos: juros + multa };
}

const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const RE_MES_NOME = new RegExp(`\\b(${MESES.join("|")}|${MESES.map((m) => m.slice(0, 3)).join("|")})\\b`);
/** Texto curto que parece um mês ("novembro", "11/2026", "mês 10") — para a memória curta reconhecer a resposta. */
export const pareceMes = (t) => /^(mes\s+)?(0?[1-9]|1[0-2])(\s+(de\s+)?(20)?\d{2})?$/.test(t) || (t.split(" ").length <= 4 && RE_MES_NOME.test(t));
/**
 * 25/11 — resposta a "Qual é o mês de referência dessa conta?" → competência AAAA-MM (determinística). Aceita "novembro",
 * "nov/2026", "11/2026", "11/26", "2026-11", "mês 11", "11". Sem ano: o do pagamento (mês posterior ao do pagamento em mais
 * de um ⇒ ano anterior). Não entendeu ⇒ null.
 */
/**
 * Ano de um mês SEM ano escrito, a partir da data do pagamento (AAAA-MM-DD). Mês mais de um à frente do pagamento ⇒ ano anterior
 * ("outubro" dito em janeiro é do ano passado); mês de janeiro/fevereiro com pagamento em novembro/dezembro ⇒ próximo ano
 * (virada: conta de janeiro paga em dezembro). Nunca usa o "dia" como ano.
 */
export function anoPadraoDoMes(mesN, ap, mp) {
  if (mp >= 11 && mesN + 12 - mp <= 2) return ap + 1;
  return mesN > mp + 1 ? ap - 1 : ap;
}
const mesAnterior = (hoje) => { const [a, m] = String(hoje ?? "").split("-").map(Number); if (!a || !m) return null; return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`; };
const mesDe = (hoje) => { const [a, m] = String(hoje ?? "").split("-").map(Number); return a && m ? `${a}-${String(m).padStart(2, "0")}` : null; };
export function competenciaDaResposta(texto, dataPagamento, hoje = null) {
  // 25/11: "no dia 25"/"dia 25" é o DIA do pagamento, nunca mês nem ano — sai antes de qualquer leitura ("Novembro de 2026. dia 25").
  const t = normalizar(texto).replace(/\b(no\s+)?dia\s+\d{1,2}\b/g, " ").replace(/\s+/g, " ").trim().replace(/^(mova\s+)?((e|foi|eh|referente a|referente ao|referencia|de|do|mes de|mes)\s+)*/, "").trim();
  if (!t || t.length > 40) return null;
  // 25/11: "deste mês"/"mês passado" são RELATIVOS a HOJE (o dia em que a pessoa responde), não ao pagamento.
  if (/^(atual|corrente)$|^(deste|desse|este|esse|neste|nesse) mes$/.test(t)) return mesDe(hoje);
  if (/^(passado|anterior)$|^ultimo mes$/.test(t)) return mesAnterior(hoje);
  let mesN = null; let ano = null;
  const iso = /^(20\d{2})\s+(0?[1-9]|1[0-2])$/.exec(t);
  const num = /^(0?[1-9]|1[0-2])(?:\s+(?:de\s+)?(20\d{2}|\d{2}))?$/.exec(t);
  const nome = RE_MES_NOME.exec(t);
  if (iso) { ano = Number(iso[1]); mesN = Number(iso[2]); }
  else if (num) { mesN = Number(num[1]); if (num[2]) ano = num[2].length === 2 ? 2000 + Number(num[2]) : Number(num[2]); }
  else if (nome && t.split(" ").length <= 4) {
    mesN = MESES.findIndex((m) => m === nome[1] || m.slice(0, 3) === nome[1]) + 1;
    // 25/11 (homologação real): "Mês de novembro, dia 25" — o DIA nunca é ano (virava 2025-11). Ano de 2 dígitos só colado ao
    // mês ("nov 26", "novembro de 26"); ano de 4 dígitos em qualquer posição.
    const resto = t.replace(/\bdia\s+\d{1,2}\b/g, " ").replace(/\s+/g, " ").trim();
    const a4 = /\b(20\d{2})\b/.exec(resto);
    const a2 = /^[a-z]+\s+(?:de\s+)?(\d{2})$/.exec(resto);
    if (a4) ano = Number(a4[1]); else if (a2) ano = 2000 + Number(a2[1]);
  } else return null;
  if (!ano) {
    const [ap, mp] = String(dataPagamento ?? "").split("-").map(Number);
    if (!ap || !mp) return null;
    ano = anoPadraoDoMes(mesN, ap, mp);
  }
  return `${ano}-${String(mesN).padStart(2, "0")}`;
}

/**
 * 25/11 — RESPOSTA NATURAL lida pela IA (só quando as regras determinísticas não entenderam): a IA devolve campos estruturados e
 * ESTA função os valida antes de qualquer uso. Nada vindo do modelo é executado: competência com formato, janela e ano conferidos;
 * finalidade só do conjunto fechado; valores inteiros não negativos; textos curtos (o chamador ainda mascara/descarta injeção).
 * Ano da competência: só o escrito pela pessoa com 4 dígitos vale; sem ano escrito, o do pagamento (mesma regra determinística) —
 * o "dia 25" nunca vira ano e o modelo nunca escolhe o ano por conta própria.
 * @returns {{competencia:string|null, descricao:string|null, finalidade:string|null, categoria:string|null, favorecido:string|null, jurosCentavos:number|null, multaCentavos:number|null}}
 */
export function extracaoDaRespostaIA(saidaIa, { texto = "", dataPagamento = null } = {}) {
  const s = saidaIa ?? {};
  const limpo = (v, max) => (typeof v === "string" && v.trim() && v.length <= max && !v.includes("\u0000") ? v.trim() : null);
  const inteiro = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  let competencia = null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(s.competencia ?? ""));
  const [ap, mp] = String(dataPagamento ?? "").split("-").map(Number);
  if (m && ap && mp) {
    const mesN = Number(m[2]);
    const a4 = /\b(20\d{2})\b/.exec(normalizar(texto).replace(/\bdia\s+\d{1,2}\b/g, " "));
    const ano = a4 ? Number(a4[1]) : anoPadraoDoMes(mesN, ap, mp);
    // janela de sanidade: de 24 meses antes até 2 meses depois do mês do pagamento
    if (ano * 12 + mesN >= ap * 12 + mp - 24 && ano * 12 + mesN <= ap * 12 + mp + 2) competencia = `${ano}-${String(mesN).padStart(2, "0")}`;
  }
  return {
    competencia,
    descricao: limpo(s.descricaoCompra, 120),
    finalidade: ["COMPRA_NOVA", "CONTA_EXISTENTE", "JUROS", "PARCIAL"].includes(s.finalidadePagamento) ? s.finalidadePagamento : null,
    categoria: typeof s.categoriaSugerida === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(s.categoriaSugerida) ? s.categoriaSugerida : null,
    favorecido: limpo(s.favorecido, 120),
    jurosCentavos: inteiro(s.jurosCentavos), multaCentavos: inteiro(s.multaCentavos),
  };
}

/**
 * 25/11 — resposta CURTA e afirmativa citando a mensagem da proposta do MOVA ("pode registrar", "tenta de novo", "sim", "ok"): pede para
 * retomar a execução automática da MESMA proposta. Só decide se há intenção de retomar; quem pode, a política, as chaves e a
 * duplicidade são conferidos de novo na execução. Frase longa ou com pergunta não é pedido de retomada.
 */
export function pedidoDeRetomar(texto) {
  const t = resposta(texto);
  if (!t || t.length > 60 || t.split(" ").length > 8 || /[?]/.test(String(texto))) return false;
  return SIM.test(t) || /\b(registr|lanc|tent|continu|conclu|finaliz|execut|process|pode|ok|isso|manda|faz|faca)/.test(t);
}

/** Texto curto que parece resposta a uma pergunta de divergência (para a memória curta, sem citação). */
export function parecerRespostaDeDivergencia(texto) {
  const t = resposta(texto);
  if (!t || t.length > 60) return false;
  return SIM.test(t) || NAO.test(t) || /^[1-9]$/.test(t) || /^(e |o |no |de )?(total|valor total|cada|cada uma|cada parcela|por parcela|de cada parcela)$/.test(t) || PALAVRA_JUROS.test(t) || PALAVRA_PARCIAL.test(t) || PALAVRA_NOVA.test(t) || pareceMes(t);
}

/**
 * Interpreta a resposta da pessoa à pergunta pendente.
 * @param {string} texto
 * @param {{tipo:string, candidatas:Array<object>}} pendencia
 * @returns {{desfecho:string, indice?:number}}
 */
export function interpretarResposta(texto, pendencia) {
  const t = resposta(texto);
  if (!t) return { desfecho: DESFECHO.NAO_ENTENDI };
  const numero = /^([1-9])\b/.exec(t);
  if (pendencia.tipo === TIPO_DIVERGENCIA.VARIAS) {
    if (numero && Number(numero[1]) <= pendencia.candidatas.length) return { desfecho: DESFECHO.ESCOLHER, indice: Number(numero[1]) - 1 };
    if (PALAVRA_NOVA.test(t) || NAO.test(t)) return { desfecho: DESFECHO.NOVA };
    return { desfecho: DESFECHO.NAO_ENTENDI };
  }
  // "É o mesmo pagamento/conta?": aqui a palavra "compra" NÃO significa compra nova ("é a mesma compra"). Só negação ou "outra/nova" cria despesa.
  if (pendencia.tipo === TIPO_DIVERGENCIA.SEMELHANTE) {
    if (/\b(nao|outra|outro|nova|novo|diferente|avulsa|nenhuma)\b/.test(t)) return { desfecho: DESFECHO.NOVA };
    if (SIM.test(t) || /^(sim|s|isso|mesmo|mesma|e o mesmo|e a mesma|ja foi|ja esta)\b/.test(t) || (numero && numero[1] === "1")) return { desfecho: DESFECHO.MESMA };
    return { desfecho: DESFECHO.NAO_ENTENDI };
  }
  // 24/11: "É uma compra nova?" — aqui o "sim" é COMPRA NOVA; "não"/"é dessa conta"/"juros" é o pagamento da conta (com acréscimo).
  if (pendencia.tipo === TIPO_DIVERGENCIA.NOVA_OU_CONTA) {
    if (SIM.test(t) || (numero && numero[1] === "1") || (PALAVRA_NOVA.test(t) && !/\b(dessa|desta|mesma|mesmo)\b/.test(t))) return { desfecho: DESFECHO.NOVA };
    if (NAO.test(t) || PALAVRA_JUROS.test(t) || /\b(dessa|desta|mesma|mesmo)\s+conta\b/.test(t) || (numero && numero[1] === "2")) return { desfecho: DESFECHO.JUROS };
    return { desfecho: DESFECHO.NAO_ENTENDI };
  }
  if (PALAVRA_NOVA.test(t) && !PALAVRA_JUROS.test(t) && !PALAVRA_PARCIAL.test(t)) return { desfecho: DESFECHO.NOVA };
  if (NAO.test(t)) return { desfecho: DESFECHO.NOVA };
  if (pendencia.tipo === TIPO_DIVERGENCIA.MAIOR) {
    if (SIM.test(t) || PALAVRA_JUROS.test(t) || (numero && numero[1] === "1")) return { desfecho: DESFECHO.JUROS };
    if (numero && numero[1] === "2") return { desfecho: DESFECHO.NOVA };
  }
  if (pendencia.tipo === TIPO_DIVERGENCIA.MENOR) {
    if (SIM.test(t) || PALAVRA_PARCIAL.test(t) || (numero && numero[1] === "1")) return { desfecho: DESFECHO.PARCIAL };
    if (numero && numero[1] === "2") return { desfecho: DESFECHO.NOVA };
  }
  return { desfecho: DESFECHO.NAO_ENTENDI };
}

/**
 * 24/11 — a FINALIDADE lida semanticamente (IA) vira desfecho da pergunta pendente, só quando as regras determinísticas não
 * entenderam. Cada finalidade só vale para a pergunta em que faz sentido (juros só no valor maior, parcial só no menor); fora disso,
 * NAO_ENTENDI — a IA nunca escolhe conta (em VARIAS, "conta existente" sem o número continua sem entender).
 */
export function desfechoPorFinalidade(finalidade, pendencia) {
  if (!finalidade || !pendencia) return { desfecho: DESFECHO.NAO_ENTENDI };
  if (finalidade === "COMPRA_NOVA") return { desfecho: DESFECHO.NOVA };
  const t = pendencia.tipo;
  if (t === TIPO_DIVERGENCIA.SEMELHANTE && finalidade === "CONTA_EXISTENTE") return { desfecho: DESFECHO.MESMA };
  if ((t === TIPO_DIVERGENCIA.MAIOR || t === TIPO_DIVERGENCIA.NOVA_OU_CONTA) && finalidade === "JUROS") return { desfecho: DESFECHO.JUROS };
  if (t === TIPO_DIVERGENCIA.MENOR && finalidade === "PARCIAL") return { desfecho: DESFECHO.PARCIAL };
  return { desfecho: DESFECHO.NAO_ENTENDI };
}

/**
 * Percentual da conta acima do qual a diferença NÃO é plausível como juros/multa (conta muito atrasada pode passar de 10%, o teto
 * do Financeiro para registrar SEM revisão — esse teto continua valendo para a execução). Caso real: R$ 178 sobre R$ 81 (220%).
 */
export const JUROS_PLAUSIVEL_PERCENTUAL = 50;
/** A diferença (comprovante − saldo) cabe como juros/multa dessa conta? Acima do teto, o MOVA pergunta se é compra nova. */
export const diferencaPlausivelComoJuros = ({ valorCentavos, saldoCentavos }) => valorCentavos - saldoCentavos <= Math.floor((saldoCentavos * JUROS_PLAUSIVEL_PERCENTUAL) / 100);

/**
 * Resposta à pergunta "o que foi comprado?" que já é, por si, uma descrição (determinística, sem IA): curta, sem pergunta, sem
 * número e sem ser só "sim/não/ok". Senão null (a mensagem segue para a leitura semântica).
 */
export function descricaoDireta(texto) {
  const bruto = String(texto ?? "").replace(/^\s*mova[\s,:-]*/i, "").trim();
  const t = normalizar(bruto);
  if (!t || bruto.length > 60 || /[?\d]/.test(bruto) || SIM.test(t) || NAO.test(t) || t.split(" ").length > 8) return null;
  return bruto.replace(/[.!]+$/, "");
}

/** Texto CURTO (do sistema, sem dado do usuário) que descreve à IA a pergunta pendente desta pessoa. */
export function descreverPendencia(pendencia) {
  const v = Number.isInteger(pendencia?.valorCentavos) ? `R$ ${(pendencia.valorCentavos / 100).toFixed(2).replace(".", ",")}` : "o comprovante";
  switch (pendencia?.tipo) {
    case TIPO_DIVERGENCIA.MAIOR: return `o MOVA perguntou se o comprovante de ${v} paga uma conta já cadastrada com juros (a diferença) ou se é uma compra nova.`;
    case TIPO_DIVERGENCIA.NOVA_OU_CONTA: return `o MOVA perguntou se o comprovante de ${v} é uma compra NOVA (a diferença para a conta cadastrada é grande demais para juros) ou o pagamento dessa conta.`;
    case TIPO_DIVERGENCIA.MENOR: return `o MOVA perguntou se o comprovante de ${v} é pagamento PARCIAL de uma conta já cadastrada ou uma compra nova.`;
    case TIPO_DIVERGENCIA.VARIAS: return `o MOVA listou ${pendencia.candidatas?.length ?? "várias"} contas cadastradas e perguntou qual o comprovante de ${v} paga (pelo número) ou se é compra nova.`;
    case TIPO_DIVERGENCIA.SEMELHANTE: return `o MOVA perguntou se o comprovante de ${v} é o MESMO pagamento/conta já registrado ou uma compra nova.`;
    case TIPO_DIVERGENCIA.COMPETENCIA: return `o MOVA perguntou o MÊS DE REFERÊNCIA (competência) da conta paga com o comprovante de ${v}. Preencha competencia (AAAA-MM) com o mês que a pessoa disse, em qualquer formato ("novembro de 2026", "mês 11", "referente a novembro", "11/2026", "deste mês" = mês da data de referência). "dia 25" é o dia do mês: nunca é ano nem mês. Sem mês dito, competencia vazia.`;
    case TIPO_DIVERGENCIA.DESCRICAO: return `o MOVA perguntou o que foi comprado com o comprovante de ${v} (a resposta é a descrição da compra nova).`;
    default: return null;
  }
}

/**
 * Classifica o casamento comprovante × contas candidatas (já filtradas por favorecido).
 * @returns {{caso:"NENHUMA"|"EXATA"|"MAIOR"|"MENOR"|"VARIAS", conta?:object, candidatas?:object[]}}
 */
export function classificarCasamento({ valorCentavos, candidatas }) {
  if (candidatas.length === 0) return { caso: "NENHUMA" };
  const exatas = candidatas.filter((t) => t.saldoCentavos === valorCentavos);
  if (exatas.length === 1) return { caso: "EXATA", conta: exatas[0] };
  if (candidatas.length > 1) return { caso: "VARIAS", candidatas };
  const [t] = candidatas;
  return { caso: valorCentavos > t.saldoCentavos ? "MAIOR" : "MENOR", conta: t };
}

/** Termos da legenda/categoria → trechos do nome de categoria do plano de contas (despesa/custo). Só sugere; a IA não escolhe conta. */
const SINONIMOS = Object.freeze([
  [/\b(brownie|brownies|bolo|doce|sorvete|acai|fruta|ingrediente|ingredientes|mercadoria|insumo|insumos|compra)\b/, ["insumo", "mercadoria", "materia prima"]],
  [/\b(descartavel|descartaveis|embalagem|embalagens|copo|copos|colher|sacola|sacolas)\b/, ["embalag", "descartav"]],
  [/\b(gas)\b/, ["gas"]],
  [/\b(luz|energia|eletrica)\b/, ["energia"]],
  [/\b(aluguel)\b/, ["aluguel"]],
  [/\b(agua)\b/, ["agua"]],
  [/\b(limpeza)\b/, ["limpez"]],
  [/\b(manutencao|conserto|reparo)\b/, ["manuten"]],
]);
/**
 * Escolhe a categoria do plano pela descrição: exatamente UMA categoria lançável de custo/despesa que case; senão null (o motor
 * usa a provisória "a classificar" e avisa). Nunca inventa código: só devolve um código que existe no plano da unidade.
 */
export function escolherCategoria({ categorias, categoriaSugerida, legenda }) {
  const lancaveis = (categorias ?? []).filter((c) => c?.aceitaLancamento && c.ativa !== false && ["CUSTO", "DESPESA"].includes(c.natureza));
  // 24/11: a sugestão que é EXATAMENTE o código de uma categoria lançável do plano da unidade vale (sem ambiguidade possível).
  const exata = categoriaSugerida ? lancaveis.find((c) => c.codigo === categoriaSugerida) : null;
  if (exata) return exata.codigo;
  const consulta = normalizar(`${String(categoriaSugerida ?? "").replace(/_/g, " ")} ${legenda ?? ""}`);
  if (!consulta) return null;
  const alvos = new Set();
  for (const [regra, termos] of SINONIMOS) if (regra.test(consulta)) termos.forEach((x) => alvos.add(x));
  for (const w of normalizar(String(categoriaSugerida ?? "").replace(/_/g, " ")).split(" ")) if (w.length >= 4) alvos.add(w);
  if (alvos.size === 0) return null;
  const casadas = lancaveis.filter((c) => { const n = normalizar(c.nome); return [...alvos].some((a) => n.includes(a)); });
  const unicas = [...new Map(casadas.map((c) => [c.codigo, c])).values()];
  return unicas.length === 1 ? unicas[0].codigo : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// "Sem conta do mesmo favorecido" NÃO é prova de compra nova: antes de criar a despesa, o MOVA procura a mesma obrigação já
// PAGA (mesmo fornecedor, mesmo valor, data próxima) e conta ABERTA de OUTRO fornecedor com o mesmo valor (descrição parecida
// ou vencimento próximo). Achou ⇒ UMA pergunta objetiva; não achou ⇒ compra nova segue sem confirmação.
const PALAVRAS_FRACAS = new Set(["para", "pela", "pelo", "pagamento", "compra", "compras", "comprovante", "loja", "unidade", "mova", "conta", "boleto", "nota", "fiscal", "ltda", "alfa", "beta"]);
const palavrasUteis = (t) => new Set(normalizar(t).split(" ").filter((w) => w.length >= 4 && !PALAVRAS_FRACAS.has(w)));
const dias = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / 86400000 : null);
export const JANELA_PAGAMENTO_IGUAL_DIAS = 10;
export const JANELA_CONTA_PARECIDA_DIAS = 7;
/**
 * @returns {Array<{situacao:"PAGA"|"ABERTA", conta:object, motivo:string}>} candidatos em ordem de força (paga igual primeiro).
 */
export function buscarSemelhantes({ todas, valorCentavos, favorecido, legenda, dataPagamento, compativel }) {
  const uteis = new Set([...palavrasUteis(legenda), ...palavrasUteis(favorecido)]);
  const alvo = dias(dataPagamento);
  const perto = (t, janela) => { const d = dias(t.vencimento) ?? dias(t.dataEmissao); return alvo === null || d === null || Math.abs(d - alvo) <= janela; };
  const achados = [];
  for (const t of todas ?? []) {
    if (t.situacao === "CANCELADA" || t.situacao === "CANCELADO") continue;
    const quitada = t.situacao === "QUITADA" || t.situacao === "QUITADO" || t.saldoCentavos === 0;
    if (quitada && t.valorOriginalCentavos === valorCentavos && compativel(t) && perto(t, JANELA_PAGAMENTO_IGUAL_DIAS)) achados.push({ situacao: "PAGA", conta: t, motivo: "PAGAMENTO_IGUAL_JA_REGISTRADO" });
    else if (!quitada && !compativel(t) && t.saldoCentavos === valorCentavos) {
      const mesmaDescricao = [...palavrasUteis(t.descricao)].some((w) => uteis.has(w));
      if (mesmaDescricao || perto(t, JANELA_CONTA_PARECIDA_DIAS)) achados.push({ situacao: "ABERTA", conta: t, motivo: mesmaDescricao ? "DESCRICAO_PARECIDA" : "MESMO_VALOR_E_DATA_PROXIMA" });
    }
  }
  return achados.sort((a, b) => (a.situacao === b.situacao ? 0 : a.situacao === "PAGA" ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------------------
// 26/11 — COMPLEMENTOS DE UMA PROPOSTA: categoria/descrição ditas depois e documentos que pertencem à MESMA compra.
// Determinístico e geral (nada específico de um produto/fornecedor); o que não casa vai para a IA (validada) ou vira pergunta.
// ---------------------------------------------------------------------------------------------------------------------------
const SEPARADORES = /\s*[-–—:;/|]\s+|\s*,\s*/;
const SEM_VALOR = new Set(["categoria", "classificar", "classifica", "classificacao", "como", "na", "no", "e", "de", "do", "da", "em", "para", "que", "foi", "era", "eh"]);

/**
 * Lê uma mensagem que COMPLETA a proposta (classificação, descrição, finalidade) e a casa com o plano de contas da unidade.
 * @returns {{categoria:string|null, opcoes:{codigo:string,nome:string}[], descricao:string|null}} nunca inventa código: só os do plano.
 *   `categoria` = uma só categoria lançável compatível; `opcoes` = várias compatíveis (até 4); nenhuma ⇒ ambos vazios.
 */
export function interpretarCategoria({ texto, categorias }) {
  const original = String(texto ?? "").trim();
  const t = normalizar(original);
  const vazio = { categoria: null, opcoes: [], descricao: null };
  if (!t || t.length > 120 || original.includes("?")) return vazio;
  const lancaveis = (categorias ?? []).filter((c) => c?.aceitaLancamento && c.ativa !== false && ["CUSTO", "DESPESA"].includes(c.natureza) && normalizar(c.nome));
  const nomes = lancaveis.map((c) => ({ c, n: normalizar(c.nome) }));
  const dito = (n) => ` ${t} `.includes(` ${n} `);
  // 1) o NOME inteiro da categoria foi dito (a mais específica; "outras despesas" vence "despesas")
  let fortes = nomes.filter((x) => dito(x.n));
  fortes = fortes.filter((x) => !fortes.some((y) => y !== x && y.n.length > x.n.length && y.n.includes(x.n)));
  let escolhida = null;
  let opcoes = [];
  if (fortes.length === 1) escolhida = fortes[0];
  else if (fortes.length > 1) opcoes = fortes;
  else {
    // 2) sinônimos conhecidos (uma só categoria casando) e 3) palavras em comum com o nome (uma só ⇒ escolhe; várias ⇒ opções)
    const viaSinonimo = escolherCategoria({ categorias: lancaveis, categoriaSugerida: null, legenda: original });
    if (viaSinonimo) escolhida = nomes.find((x) => x.c.codigo === viaSinonimo) ?? null;
    else {
      const palavras = new Set(t.split(" ").filter((w) => w.length >= 4 && !SEM_VALOR.has(w)));
      const parciais = nomes.filter((x) => x.n.split(" ").some((w) => w.length >= 4 && palavras.has(w)));
      if (parciais.length === 1) escolhida = parciais[0]; else opcoes = parciais;
    }
  }
  // descrição = o que sobra depois de tirar a categoria DITA (por separadores; sem separador, remove o nome do texto). Categoria
  // inferida por sinônimo/palavra solta não gera descrição (o resto da frase pode ser só a própria classificação).
  let descricao = null;
  const alvo = fortes.length === 1 ? fortes[0].n : null;
  if (alvo) {
    const util = (p) => normalizar(p).split(" ").some((w) => w && !SEM_VALOR.has(w));
    const partes = original.split(SEPARADORES).filter((x) => x.trim());
    const restantes = partes.length > 1 ? partes.filter((x) => !` ${normalizar(x)} `.includes(` ${alvo} `) && util(x)) : [];
    let resto = restantes.join(" ").trim();
    if (!resto) resto = normalizar(original).replace(alvo, " ").split(" ").filter((w) => w && !SEM_VALOR.has(w)).join(" ").trim();
    if (resto.length >= 3 && resto.length <= 60) descricao = resto.charAt(0).toUpperCase() + resto.slice(1);
  }
  return { categoria: escolhida?.c.codigo ?? null, opcoes: opcoes.slice(0, 4).map((x) => ({ codigo: x.c.codigo, nome: x.c.nome })), descricao };
}

/** "sim"/"não" curtos (e variações naturais). null = não é resposta sim/não. */
export function respostaSimNao(texto) {
  const t = resposta(texto);
  if (!t || t.length > 40) return null;
  if (SIM.test(t) || /^(sim|e sim|e a mesma|mesma compra|e da mesma|do mesmo|pertence)\b/.test(t)) return true;
  if (NAO.test(t) || /^(nao|outra compra|e outra|compra diferente)\b/.test(t)) return false;
  return null;
}

/** Dois favorecidos parecem o mesmo (palavras úteis em comum, ignorando ruído societário). Só um SINAL — nunca prova sozinho. */
export function favorecidosCompativeis(a, b) {
  const ruido = new Set(["ltda", "sa", "s", "a", "me", "eireli", "epp", "cia", "comercio", "de", "da", "do", "dos", "das", "e"]);
  const w = (x) => new Set(normalizar(x).split(" ").filter((p) => p.length >= 3 && !ruido.has(p)));
  const [A, B] = [w(a), w(b)];
  if (!A.size || !B.size) return false;
  const comuns = [...A].filter((p) => B.has(p)).length;
  return comuns >= Math.min(2, Math.min(A.size, B.size));
}

/** Tipos de documento que COMPLEMENTAM uma compra (não são, sozinhos, a prova do pagamento). */
export const DOCUMENTOS_COMPLEMENTARES = Object.freeze(["NOTA_FISCAL", "CUPOM_FISCAL", "BOLETO", "RECIBO", "FATURA", "CUPOM"]);
