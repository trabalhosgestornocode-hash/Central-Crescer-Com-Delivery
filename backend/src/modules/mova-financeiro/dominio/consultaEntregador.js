// MOVA — 27/11: ATENDIMENTO PRIVADO DO ENTREGADOR, sem IA. Funções PURAS: interpretam a pergunta (intenção, período, empresa, continuidade)
// por regras e redigem a resposta por modelo, SÓ com os dados do PRÓPRIO entregador que o chamador já leu do Financeiro.
//
//   - o texto recebido é DADO, nunca instrução: ele só escolhe entre intenções de uma lista FECHADA; nada nele muda regra, valor ou permissão;
//   - pedido de dado de outra pessoa/da empresa ou de ação (pagar, liberar, alterar valor) é recusado com texto fixo;
//   - pergunta não entendida cai no comportamento anterior (o fechamento da semana) — ou, se houver intérprete de IA injetado, ele só
//     pode devolver uma intenção da mesma lista fechada (ver `validarInterpretacao`);
//   - o que vale para cada empresa (unidade) é separado: nunca se somam empresas.
import { dataBr, reais } from "../aplicacao/respostas.js";
import { mensagemSemanal } from "./entregadores.js";

export const INTENCAO = Object.freeze({
  VALOR: "VALOR", ENTREGAS: "ENTREGAS", PREVISAO: "PREVISAO", NOTA: "NOTA", PAGAMENTOS: "PAGAMENTOS", PENDENTE: "PENDENTE", COMPROVANTE: "COMPROVANTE",
  DIVERGENCIA: "DIVERGENCIA", AJUDA: "AJUDA", TERCEIRO: "TERCEIRO", ACAO_ADMINISTRATIVA: "ACAO_ADMINISTRATIVA", DESCONHECIDA: "DESCONHECIDA",
});
/** O que um intérprete de IA (se existir) pode devolver: só consultas de leitura. Nunca recusas nem ações. */
export const INTENCOES_PARA_IA = Object.freeze([INTENCAO.VALOR, INTENCAO.ENTREGAS, INTENCAO.PREVISAO, INTENCAO.NOTA, INTENCAO.PAGAMENTOS, INTENCAO.PENDENTE, INTENCAO.COMPROVANTE, INTENCAO.DIVERGENCIA, INTENCAO.AJUDA]);

export const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9/\s?]/g, " ").replace(/\s+/g, " ").trim();
const tem = (t, re) => re.test(t);

const MESES = Object.freeze({ janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 });
const NOME_DO_MES = Object.freeze(Object.fromEntries(Object.entries(MESES).map(([n, i]) => [i, n])));
const PARADAS = new Set(["ltda", "eireli", "sa", "me", "mei", "loja", "empresa", "unidade", "saci", "grau", "de", "da", "do", "dos", "das", "no", "na", "e", "a", "o"]);

const ADMIN = [
  /^(por favor |pf |pfv )?(pag(a|ue)|libera|libere|lanca|lance|registra|registre|altera|altere|corrige|corrija|baixa|baixe|cancela|cancele|apaga|apague|aprova|aprove|muda|mude|ajusta|ajuste|estorna|estorne)\b/,
  /\b(faz|faca|fazer|manda|mande|mandar|envia|envie|enviar)\b.*\b(pagamento|pix|transferencia|ajuste|lancamento|dinheiro)\b/,
  /\b(alter(a|e|ar)|corrij(a|o)|corrig(ir)?|mud(a|e|ar)|troqu?e|ajust(a|e|ar)|aument(a|e|ar))\b.*\b(valor|fechamento|entregas|pagamento)\b/,
  /\b(libera|libere|liberar|aprova|aprove|aprovar)\b.*\b(meu|minha|pagamento|nota)\b/,
  /\b(ignore|ignora|desconsidere|esqueca|esquece)\b.*\b(instruc|regras|ordens|anterior)/,
  /\b(voce agora e|aja como|finja ser|system ?:|modo (admin|administrador|deus))/,
];
const TERCEIROS = /\b(de todos|todos (os )?(entregadores|motoboys?)|outros? (entregadores?|motoboys?)|colegas?|(do|da|de|dos|das) (pessoal|time|equipe|motoboys|entregadores)|total (da|do) (empresa|loja|unidade)|faturamento|lucro|caixa|despesas?|contas? a pagar|boletos?|fornecedor(es)?|saldo (da|do) (empresa|loja)|ranking|folha)\b/;

/** Nomes (1º nome) dos OUTROS entregadores da mesma lista: citar um deles é pedir dado de terceiro. */
export function nomesDeOutros({ meuNome, lista = [] }) {
  const meu = norm(meuNome).split(" ")[0];
  return [...new Set(lista.map((e) => norm(e?.nome).split(" ")[0]).filter((n) => n.length >= 3 && n !== meu && !PARADAS.has(n)))];
}

export function periodoDoTexto(t, hoje) {
  if (tem(t, /\b(retrasada|antepenultima|duas semanas atras|semana anterior a passada)\b/)) return { tipo: "RETRASADA" };
  if (tem(t, /\b(essa|esta|atual) semana|semana atual|semana corrente|em andamento\b/)) return { tipo: "ATUAL" };
  if (tem(t, /\b(semana passada|ultima semana|ultimo fechamento|passada|anterior)\b/)) return { tipo: "ULTIMA" };
  const data = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (data) {
    const ano = data[3] ? (data[3].length === 2 ? 2000 + Number(data[3]) : Number(data[3])) : Number(hoje.slice(0, 4));
    const iso = `${ano}-${String(data[2]).padStart(2, "0")}-${String(data[1]).padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) && Number(data[1]) >= 1 && Number(data[1]) <= 31 && Number(data[2]) >= 1 && Number(data[2]) <= 12) return { tipo: "DATA", data: iso };
  }
  for (const [nome, i] of Object.entries(MESES)) if (tem(t, new RegExp(`\\b${nome}\\b`))) return { tipo: "MES", mes: `${hoje.slice(0, 4)}-${String(i).padStart(2, "0")}` };
  if (tem(t, /\b(esse|este|do|no|neste) mes\b|\bmensal\b/)) return { tipo: "MES", mes: hoje.slice(0, 7) };
  return null;
}

/** Empresa (unidade) citada, entre as do próprio entregador. Ambígua ou ausente ⇒ null. */
export function empresaDoTexto(t, vinculos) {
  const achadas = vinculos.filter((v) => [v.rotulo.empresa, v.rotulo.unidade].filter(Boolean).flatMap((n) => norm(n).split(" ")).filter((w) => w.length >= 4 && !PARADAS.has(w)).some((w) => tem(t, new RegExp(`\\b${w}\\b`))));
  return achadas.length === 1 ? achadas[0].unidadeId : null;
}

/**
 * @param {string} texto
 * @param {{hoje:string, vinculos:{unidadeId:string, rotulo:{unidade:string|null, empresa:string|null}}[], outrosNomes?:string[], anterior?:{intencao:string, periodo?:object|null, empresa?:string|null}|null}} o
 * @returns {{intencao:string, periodo:object|null, empresa:string|null, continuidade:boolean}}
 */
export function interpretarPergunta(texto, { hoje, vinculos, outrosNomes = [], anterior = null }) {
  const t = norm(texto);
  const sai = (intencao, extra = {}) => ({ intencao, periodo: null, empresa: null, continuidade: false, ...extra });
  if (!t) return sai(INTENCAO.DESCONHECIDA);
  if (ADMIN.some((re) => re.test(t))) return sai(INTENCAO.ACAO_ADMINISTRATIVA);
  if (TERCEIROS.test(t) || outrosNomes.some((n) => new RegExp(`\\b${n}\\b`).test(t))) return sai(INTENCAO.TERCEIRO);
  const periodo = periodoDoTexto(t, hoje), empresa = empresaDoTexto(t, vinculos);
  const com = (intencao) => sai(intencao, { periodo, empresa });
  if (tem(t, /comprovante|recibo/)) return com(INTENCAO.COMPROVANTE);
  if (tem(t, /diverg|errad|nao bate|incorret|recus|rejeit|problema|contest|reclam|diferente|duplicad/)) return com(INTENCAO.DIVERGENCIA);
  if (tem(t, /\bnota\b|\bnf\b|\bnfs\b|\bnfse\b|fiscal/)) return com(INTENCAO.NOTA);
  if (tem(t, /\bquando\b|previs|data d[eo] pagamento|dia d[eo] pagamento|vai cair|vao pagar|prazo/)) return com(INTENCAO.PREVISAO);
  if (tem(t, /pendente|ainda falta|falta (eu )?receber|a receber|em aberto|me devem|devendo|\bsaldo\b/)) return com(INTENCAO.PENDENTE);
  if (tem(t, /pagamentos?|\brecebi\b|ja recebi|historico|extrato|pagaram|foi pago|fui pago|\bpagos?\b/)) return com(INTENCAO.PAGAMENTOS);
  if (tem(t, /entregas?|corridas?|pedidos?|viagens?/)) return com(INTENCAO.ENTREGAS);
  if (tem(t, /quanto|valor|fechamento|semana|total|ganh|receb/)) return com(INTENCAO.VALOR);
  if (/^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa|ajuda|menu|opcoes|\?)\b/.test(t) || tem(t, /o que (voce|vc) (faz|pode)|como funciona/)) return sai(INTENCAO.AJUDA);
  // Continuidade: "e na semana passada?", "e da subway?", "e agora?" — herda a intenção da última consulta desta conversa.
  if (anterior && INTENCOES_PARA_IA.includes(anterior.intencao) && t.split(" ").length <= 6) {
    return sai(anterior.intencao, { periodo: periodo ?? anterior.periodo ?? null, empresa: empresa ?? anterior.empresa ?? null, continuidade: true });
  }
  return sai(INTENCAO.DESCONHECIDA);
}

/** Saída de um intérprete de IA: só uma intenção da lista fechada de leitura; qualquer outra coisa é descartada. */
export function validarInterpretacao(bruta) {
  const intencao = String(bruta?.intencao ?? "");
  return INTENCOES_PARA_IA.includes(intencao) ? { ok: true, intencao } : { ok: false };
}

// ------------------------------------------------------------------------------------------------------------------ redação

const SEM_DADO = "Ainda não há fechamento seu nesta empresa. Quando a semana for fechada, mando o resumo por aqui.";
const SEPARADOR = "\n\n— — —\n\n";
const efetivo = (b) => (b.valorCentavos ?? 0) - (b.estornadoCentavos ?? 0);
const semanaTxt = (f) => `${dataBr(f.semanaInicio)} a ${dataBr(f.semanaFim)}`;
const segundaDe = (iso) => { const d = new Date(`${iso}T12:00:00Z`); return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); };

/** Fechamentos (mais recente primeiro) que o período pede. ATUAL ⇒ [] com `emAndamento`. */
export function selecionarFechamentos(fechamentos, periodo, hoje) {
  const lista = [...fechamentos].sort((a, b) => b.semanaInicio.localeCompare(a.semanaInicio));
  const p = periodo ?? { tipo: "ULTIMA" };
  if (p.tipo === "ATUAL") { const atual = segundaDe(hoje); const f = lista.find((x) => x.semanaInicio === atual); return { itens: f ? [f] : [], emAndamento: !f }; }
  if (p.tipo === "RETRASADA") return { itens: lista[1] ? [lista[1]] : [], emAndamento: false };
  if (p.tipo === "DATA") return { itens: lista.filter((f) => f.semanaInicio <= p.data && p.data <= f.semanaFim), emAndamento: false };
  if (p.tipo === "MES") return { itens: lista.filter((f) => f.semanaFim.startsWith(p.mes)), emAndamento: false, mes: p.mes };
  return { itens: lista.slice(0, 1), emAndamento: false };
}

const SITUACAO_NOTA = Object.freeze({
  AGUARDANDO_NF: (f) => `ainda não recebi sua nota. Envie a NFS-e (PDF ou foto legível) por aqui até ${dataBr(f.prazoDaNota)}.`,
  NF_REJEITADA: () => "a nota enviada foi recusada. Envie uma nova por aqui (PDF ou foto legível) ou fale com o financeiro.",
  NF_RECEBIDA: () => "recebi sua nota e ela está na fila de conferência.",
  NF_EM_CONFERENCIA: () => "sua nota está em conferência pelo financeiro.",
  NF_APROVADA: () => "sua nota foi aprovada; falta a liberação do pagamento.",
  LIBERADO_PAGAMENTO: (f) => `nota aprovada e pagamento liberado (vencimento ${dataBr(f.vencimento)}).`,
});
const SITUACAO_PAGAMENTO = Object.freeze({ PAGO: "pago", PARCIAL: "pago em parte", VENCIDO: "vencido, aguardando pagamento", A_PAGAR: "a pagar", SEM_CONTA: "em preparação", CANCELADO: "cancelado" });

function secaoEntregas({ fechamentos }, periodo, hoje) {
  const s = selecionarFechamentos(fechamentos, periodo, hoje);
  if (s.emAndamento) return "A semana em andamento ainda não foi fechada. O fechamento sai na segunda-feira e eu te aviso por aqui.";
  if (!s.itens.length) return periodo ? "Não encontrei fechamento seu nesse período." : SEM_DADO;
  if (s.mes) return `🛵 Em ${NOME_DO_MES[Number(s.mes.slice(5))]}/${s.mes.slice(0, 4)}: ${s.itens.reduce((t, f) => t + f.entregas, 0)} entrega(s) em ${s.itens.length} semana(s) fechada(s).`;
  return s.itens.map((f) => `🛵 Semana ${semanaTxt(f)}: ${f.entregas} entrega(s).`).join("\n");
}
function secaoValor({ fechamentos, rotulo, multi }, periodo, hoje) {
  const s = selecionarFechamentos(fechamentos, periodo, hoje);
  if (s.emAndamento) return "A semana em andamento ainda não foi fechada. O valor sai no fechamento de segunda-feira.";
  if (!s.itens.length) return periodo ? "Não encontrei fechamento seu nesse período." : SEM_DADO;
  if (s.mes) return `${multi ? `🏢 ${rotulo.empresa ?? rotulo.unidade ?? "Empresa"}
` : ""}💰 Em ${NOME_DO_MES[Number(s.mes.slice(5))]}/${s.mes.slice(0, 4)}: ${reais(s.itens.reduce((t, f) => t + f.valorCentavos, 0))} em ${s.itens.length} semana(s) fechada(s).`;
  return s.itens.map((f) => mensagemSemanal(f, multi ? rotulo : {}) ?? `Semana ${semanaTxt(f)}: em revisão pelo financeiro.`).join("\n\n");
}
function secaoPrevisao({ fechamentos, baixas }) {
  const abertos = fechamentos.filter((f) => f.obrigacaoId && !["PAGO", "CANCELADO"].includes(f.situacaoPagamento) && !f.duplicidade).sort((a, b) => a.semanaInicio.localeCompare(b.semanaInicio));
  if (!abertos.length) {
    const ultima = [...baixas].filter((b) => efetivo(b) > 0).reduce((m, b) => (!m || `${b.dataEfetiva}|${b.criadoEm ?? ""}` >= `${m.dataEfetiva}|${m.criadoEm ?? ""}` ? b : m), null); // empate: vale o registrado por último
    return `Você não tem valores a receber em aberto nesta empresa.${ultima ? ` Último pagamento: ${reais(efetivo(ultima))} em ${dataBr(ultima.dataEfetiva)}.` : ""}`;
  }
  return abertos.slice(0, 3).map((f) => {
    const valor = reais(f.saldoCentavos ?? f.valorCentavos);
    const sit = f.situacaoDocumental;
    const nota = sit === "LIBERADO_PAGAMENTO" ? "pagamento liberado" : ["AGUARDANDO_NF", "NF_REJEITADA"].includes(sit) ? `falta a nota fiscal (prazo ${dataBr(f.prazoDaNota)})` : "nota em conferência";
    return `📅 Semana ${semanaTxt(f)} — ${valor}: vencimento previsto em ${dataBr(f.vencimento)}${f.situacaoPagamento === "VENCIDO" ? " (já passou do vencimento)" : ""}; ${nota}.`;
  }).join("\n") + "\nA data é uma previsão: o pagamento só vale depois de registrado pelo financeiro.";
}
function secaoNota({ fechamentos, notas }, periodo, hoje) {
  const s = selecionarFechamentos(fechamentos, periodo, hoje);
  if (s.emAndamento) return "A semana em andamento ainda não foi fechada; a nota é pedida depois do fechamento.";
  if (!s.itens.length) return periodo ? "Não encontrei fechamento seu nesse período." : SEM_DADO;
  return s.itens.slice(0, 3).map((f) => {
    const texto = (SITUACAO_NOTA[f.situacaoDocumental] ?? (() => "situação em atualização."))(f);
    const mova = notas.find((n) => n.semanaInicio === f.semanaInicio && n.conferencia === "DIVERGENTE");
    return `🧾 Semana ${semanaTxt(f)} (${reais(f.valorCentavos)}): ${texto}${mova && f.situacaoDocumental !== "LIBERADO_PAGAMENTO" ? " Encontrei uma divergência entre a nota e o fechamento; o financeiro vai conferir e te retornar." : ""}`;
  }).join("\n");
}
function secaoPagamentos({ baixas }) {
  const pagos = baixas.filter((b) => efetivo(b) > 0).sort((a, b) => b.dataEfetiva.localeCompare(a.dataEfetiva) || String(b.criadoEm ?? "").localeCompare(String(a.criadoEm ?? "")) || b.semanaInicio.localeCompare(a.semanaInicio)).slice(0, 5);
  if (!pagos.length) return "Ainda não há pagamentos registrados para você nesta empresa.";
  return ["Últimos pagamentos:", ...pagos.map((b) => `• ${dataBr(b.dataEfetiva)} — ${reais(efetivo(b))} (semana ${semanaTxt(b)})${b.estornadoCentavos ? ` — estornado em parte: ${reais(b.estornadoCentavos)}` : ""}`)].join("\n");
}
function secaoPendente({ fechamentos }) {
  const abertos = fechamentos.filter((f) => f.obrigacaoId && (f.saldoCentavos ?? 0) > 0 && f.situacaoPagamento !== "CANCELADO").sort((a, b) => b.semanaInicio.localeCompare(a.semanaInicio));
  const semConta = fechamentos.filter((f) => !f.obrigacaoId).length;
  if (!abertos.length) return `Você não tem valores pendentes nesta empresa.${semConta ? " Há semana em preparação pelo financeiro." : ""}`;
  const total = abertos.reduce((t, f) => t + f.saldoCentavos, 0);
  return [`Pendente nesta empresa: ${reais(total)} em ${abertos.length} semana(s).`, ...abertos.slice(0, 4).map((f) => `• Semana ${semanaTxt(f)} — ${reais(f.saldoCentavos)} (${SITUACAO_PAGAMENTO[f.situacaoPagamento] ?? "em aberto"})`)].join("\n");
}
function secaoComprovante({ baixas }) {
  const base = secaoPagamentos({ baixas });
  return `${base}\nO arquivo do comprovante não é enviado por aqui. Se precisar dele, peça ao financeiro da empresa.`;
}
function secaoDivergencia({ fechamentos, notas }) {
  const itens = [];
  for (const f of fechamentos.slice(0, 8)) {
    if (f.duplicidade) itens.push(`• Semana ${semanaTxt(f)}: está em revisão pelo financeiro (possível duplicidade de lançamento).`);
    else if (f.situacaoDocumental === "NF_REJEITADA") itens.push(`• Semana ${semanaTxt(f)}: a nota foi recusada; envie uma nova.`);
    else if (notas.some((n) => n.semanaInicio === f.semanaInicio && n.conferencia === "DIVERGENTE") && f.situacaoDocumental !== "LIBERADO_PAGAMENTO") itens.push(`• Semana ${semanaTxt(f)}: a nota tem divergência com o fechamento; o financeiro vai conferir.`);
  }
  return itens.length ? ["Encontrei estes pontos para o financeiro conferir:", ...itens].join("\n") : "Não encontrei divergências nos seus fechamentos. Se algo não bate para você, me diga a semana e eu aviso o financeiro.";
}

export const TEXTO_FIXO = Object.freeze({
  AJUDA: "Oi! Eu sou o MOVA, da Crescer com Delivery. Por aqui você pode perguntar sobre os seus dados, por exemplo:\n• quanto deu minha semana\n• quantas entregas fiz\n• quando vou receber\n• como está minha nota\n• meus pagamentos\n• o que está pendente\nA nota fiscal pode ser enviada aqui em PDF ou foto.",
  TERCEIRO: "Por aqui eu só falo dos seus próprios dados. Informações de outras pessoas ou da empresa não são compartilhadas.",
  ACAO_ADMINISTRATIVA: "Por aqui eu só informo. Pagamentos, correções de valor e liberações são feitos pelo financeiro da empresa. Se algo estiver errado, me diga qual semana e eu aviso o financeiro.",
});

const SECOES = Object.freeze({ ENTREGAS: secaoEntregas, VALOR: secaoValor, PREVISAO: secaoPrevisao, NOTA: secaoNota, PAGAMENTOS: secaoPagamentos, PENDENTE: secaoPendente, COMPROVANTE: secaoComprovante, DIVERGENCIA: secaoDivergencia });

/**
 * Resposta de uma consulta. `vinculos` = uma entrada por empresa do entregador, já filtrada pela empresa pedida:
 * { rotulo, fechamentos, baixas, notas }. Cada empresa em sua seção; nunca somadas.
 */
export function redigirConsulta({ intencao, periodo = null, vinculos, hoje }) {
  const f = SECOES[intencao];
  if (!f) throw new TypeError(`intenção sem redator: ${intencao}`);
  const multi = vinculos.length > 1;
  return vinculos.map((v) => {
    const corpo = f({ ...v, multi }, periodo, hoje);
    return multi && intencao !== INTENCAO.VALOR ? `🏢 ${v.rotulo.empresa ?? v.rotulo.unidade ?? "Empresa"}\n${corpo}` : corpo; // o VALOR ja traz empresa/unidade no proprio modelo
  }).join(SEPARADOR);
}
