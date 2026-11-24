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
export const TIPO_DIVERGENCIA = Object.freeze({ MAIOR: "MAIOR", MENOR: "MENOR", VARIAS: "VARIAS", SEMELHANTE: "SEMELHANTE", NOVA_OU_CONTA: "NOVA_OU_CONTA", DESCRICAO: "DESCRICAO" });
export const DESFECHO = Object.freeze({ JUROS: "JUROS", PARCIAL: "PARCIAL", NOVA: "NOVA", ESCOLHER: "ESCOLHER", MESMA: "MESMA", NAO_ENTENDI: "NAO_ENTENDI" });
export const MAX_CANDIDATAS_NA_PERGUNTA = 5;

export const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const SIM = /^(sim|s|isso|isso mesmo|exato|exatamente|correto|certo|confirmo|isso ai|e sim|sao|sao sim|foi|foi sim|ok)$/;
const NAO = /^(nao|n|negativo|nao e|nao sao|nao foi|nao eh)$/;
const PALAVRA_JUROS = /\b(juros?|multa|mora|encargos?|acrescimos?)\b/;
const PALAVRA_PARCIAL = /\b(parcial|parcela|entrada|sinal|adiantamento|restante|resto|metade|primeira)\b/;
const PALAVRA_NOVA = /\b(nova|novo|outra|outro|compra|nenhuma|nenhum|diferente|avulsa)\b/;

/** A legenda da mensagem deixa claro que o pagamento é parcial? (só então a baixa parcial dispensa pergunta) */
export const legendaIndicaParcial = (legenda) => PALAVRA_PARCIAL.test(normalizar(legenda));
/** A legenda cita juros/multa? (mesmo assim o MOVA confirma a composição da diferença; nunca presume) */
export const legendaCitaJuros = (legenda) => PALAVRA_JUROS.test(normalizar(legenda));

/** Texto curto que parece resposta a uma pergunta de divergência (para a memória curta, sem citação). */
export function parecerRespostaDeDivergencia(texto) {
  const t = normalizar(texto);
  if (!t || t.length > 60) return false;
  return SIM.test(t) || NAO.test(t) || /^[1-9]$/.test(t) || PALAVRA_JUROS.test(t) || PALAVRA_PARCIAL.test(t) || PALAVRA_NOVA.test(t);
}

/**
 * Interpreta a resposta da pessoa à pergunta pendente.
 * @param {string} texto
 * @param {{tipo:string, candidatas:Array<object>}} pendencia
 * @returns {{desfecho:string, indice?:number}}
 */
export function interpretarResposta(texto, pendencia) {
  const t = normalizar(texto);
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
