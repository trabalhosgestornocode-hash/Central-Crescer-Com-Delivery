// 26/11 — CONTA A PAGAR RELATADA POR TEXTO (sem documento). Leitura DETERMINÍSTICA (sem IA, custo zero) do que a pessoa disse.
// Caso real: "Compra de bebedouro para o açaí, 2 parcelas no cartão, Dia 19/12 e 19/01 valor de R$194,50."
// Regras:
//   - nada é inventado: fornecedor só quando DITO ("fornecedor X", "na loja X"); vencimento só os ditos; sem ano, cada data é a
//     PRIMEIRA ocorrência a partir da mensagem e as seguintes vêm DEPOIS da anterior (19/12 → 2026; 19/01 → 2027);
//   - "valor de R$ 194,50" com 2 parcelas é AMBÍGUO (total ou de cada parcela?) ⇒ perguntar UMA vez; "cada", "parcelas de", "2x de"
//     ⇒ por parcela; "total", "no total" ⇒ total;
//   - competência = mês da COMPRA (data da mensagem), nunca o mês do vencimento;
//   - categoria pelo PLANO DE CONTAS da unidade (27/11, revisão do PR #236): NUNCA automática para equipamento (despesa ×
//     imobilizado é decisão contábil, não do MOVA); categoria DITA ("categoria Equipamentos") só vale se existir no plano; sem
//     categoria segura ⇒ PERGUNTA com as opções do plano, ou "0" ⇒ fica para a classificação no Centro Financeiro (com a sugestão
//     de criar a categoria dita, quando ela não existe). Regra comum sobre a DESCRIÇÃO LIMPA (sem a unidade nem "compra").
//   - vale para conta ÚNICA (1 parcela) e PARCELADA, por texto ou por FOTO do produto com legenda (a foto não é documento fiscal).
import { competenciaDaResposta, escolherCategoria, interpretarCategoria, normalizar } from "./divergencia.js";

export const TIPO_VALOR = Object.freeze({ PARCELA: "PARCELA", TOTAL: "TOTAL", AMBIGUO: "AMBIGUO" });
export const FORMA = Object.freeze({ CARTAO: "CARTAO", BOLETO: "BOLETO", PIX: "PIX", DINHEIRO: "DINHEIRO", TRANSFERENCIA: "TRANSFERENCIA" });
export const MAX_PARCELAS = 24;
const POR_EXTENSO = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12 };
const EQUIPAMENTO = /\b(bebedouros?|freezers?|geladeiras?|refrigerador(es)?|maquinas?|equipamentos?|fornos?|liquidificador(es)?|batedeiras?|balcao|balcoes|vitrines?|computador(es)?|impressoras?|notebooks?|ar condicionado|televis(ao|or)|tv|micro ondas|microondas|fogao|chapa|fritadeira|seladora|mesas?|cadeiras?)\b/;
const SERVICO = /\b(conserto|consertar|manutencao|reparo|reparar|limpeza|higienizacao|instalacao|revisao|troca de|recarga)\b/;
const LIGACAO = new Set(["para", "pro", "pra", "o", "a", "os", "as", "do", "da", "dos", "das", "de", "no", "na", "nos", "nas", "em", "e", "loja", "unidade"]);

const pad = (n) => String(n).padStart(2, "0");
const iso = (a, m, d) => `${a}-${pad(m)}-${pad(d)}`;
const valida = (a, m, d) => { const x = new Date(Date.UTC(a, m - 1, d)); return x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === d; };
const centavos = (s) => { const t = s.replace(/\./g, "").replace(",", "."); const v = Math.round(Number(t) * 100); return Number.isSafeInteger(v) && v > 0 ? v : null; };

// 27/11: também o valor SEM "R$" quando traz centavos ("total 2.911,08") — número sem vírgula decimal (18.000, 400) nunca é tomado como dinheiro aqui.
const RE_VALOR = /(?:r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?))|(?:\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:reais|rs)\b)|(?:(?<![\d/.,])(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?![\d/%])(?!\s*%))/gi;

/** Valores em reais citados ("R$194,50", "R$ 1.779,90", "194,50 reais"), na ordem, sem repetir. */
export function valoresCitados(texto) {
  const achados = [];
  for (const m of String(texto ?? "").matchAll(RE_VALOR)) { const v = centavos(m[1] ?? m[2] ?? m[3]); if (v && !achados.includes(v)) achados.push(v); }
  return achados;
}

/**
 * 27/11 — TOTAL com COMPOSIÇÃO dita no texto ("Jailton R$ 395,34, Vanessa R$ 2.515,74, total R$ 2.911,08"): um valor que é a SOMA exata
 * dos demais (2 ou mais) é o total; os demais viram componentes rotulados pela palavra que os antecede. Sem soma exata ⇒ null
 * (continua "valores diferentes": nada é presumido).
 */
export function composicaoDoTotal(texto) {
  const s = String(texto ?? "");
  const itens = [];
  for (const m of s.matchAll(RE_VALOR)) {
    const v = centavos(m[1] ?? m[2] ?? m[3]);
    if (!v) continue;
    const antes = s.slice(0, m.index).replace(/(?:r\$)?\s*[:=-]?\s*$/i, "").match(/([\p{L}][\p{L}.']*)\s*$/u);
    itens.push({ valorCentavos: v, rotulo: antes ? antes[1] : null });
  }
  if (itens.length < 3) return null;
  const total = itens.find((x, i) => itens.reduce((acc, y, j) => (j === i ? acc : acc + y.valorCentavos), 0) === x.valorCentavos);
  if (!total) return null;
  const componentes = itens.filter((x) => x !== total);
  return { totalCentavos: total.valorCentavos, componentes };
}

const brl = (c) => `R$ ${(c / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

/**
 * 27/11 — OBSERVAÇÃO da conta: composição do total (quem pagou quanto) e a oração do relato sobre DESCONTO/REMUNERAÇÃO/FOLHA, com as
 * observações individuais das parcelas. Só o que foi DITO. Nunca é cortada em silêncio: o motor guarda o texto inteiro na proposta.
 */
/** 27/11 (#245) — oração do relato sobre DESCONTO/REMUNERAÇÃO/FOLHA. A data dela (ex.: desconto em 07/12) NÃO é vencimento da conta. */
export function oracaoDeDesconto(texto) {
  // #245: termina no fim da frase OU antes de um vencimento dito na mesma frase ("…desconto em 07/12, vencimento do empréstimo 15/12")
  // 27/11 (consolidação): frase NEGADA/instrução ("Não criar contas nem realizar descontos salariais automaticamente") não é a informação
  // do desconto — só a primeira oração afirmativa vale.
  const s = String(texto ?? "");
  for (const m of s.matchAll(/\b(?:descont\w*|remunera\w*|folha)\b[^;\n]*?(?=\s*[,;]?\s*(?:e\s+)?(?:o\s+|a\s+)?(?:primeiro\s+|1[ºo°]\s+)?(?:vencimento|vence|vencendo)\b|\.(?:\s|$)|;|\n|$)/gi)) {
    const inicioDaFrase = Math.max(s.lastIndexOf(".", m.index), s.lastIndexOf("\n", m.index), s.lastIndexOf(";", m.index)) + 1;
    if (!/\b(?:n[aã]o|nem|sem|nunca)\b/i.test(s.slice(inicioDaFrase, m.index))) return m[0];
  }
  return null;
}

export function observacaoDaConta(texto, comp = null) {
  const partes = [];
  if (comp) partes.push(`${comp.componentes.map((c) => `${c.rotulo ? `${c.rotulo} ` : ""}${brl(c.valorCentavos)}`).join(" + ")} = ${brl(comp.totalCentavos)}`);
  const oracao = oracaoDeDesconto(texto);
  if (oracao) partes.push(oracao.trim().replace(/[,\s]+$/, ""));
  return partes.length ? partes.join("; ") : null;
}

/** Datas dd/mm[/aaaa] citadas, resolvendo o ano sem inventar: a primeira a partir da mensagem; cada seguinte depois da anterior. */
export function datasCitadas(texto, dataMensagem) {
  const [ab, mb, db] = dataMensagem.split("-").map(Number);
  const saida = [];
  let anterior = null;
  for (const m of String(texto ?? "").matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) {
    const d = Number(m[1]); const mm = Number(m[2]);
    let a;
    if (m[3]) a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    else if (!anterior) a = iso(ab, mm, d) >= iso(ab, mb, db) ? ab : ab + 1;
    else { a = Number(anterior.slice(0, 4)); if (iso(a, mm, d) <= anterior) a += 1; }
    if (!valida(a, mm, d)) return { datas: saida, invalida: m[0] };
    const x = iso(a, mm, d);
    saida.push(x);
    anterior = x;
  }
  return { datas: saida, invalida: null };
}

/**
 * 27/11 — OBSERVAÇÃO individual de cada parcela, só quando DITA junto da data: "10/12 (carência)" ou "10/01: reajuste". Nada é inventado.
 * Devolve uma lista alinhada às datas (null onde não há observação).
 */
export function observacoesPorData(texto) {
  const saida = [];
  for (const m of String(texto ?? "").matchAll(/\b\d{1,2}\/\d{1,2}(?:\/(?:\d{2}|\d{4}))?\b\s*(?:\(([^)]{1,80})\)|[:-]\s*([^,;\n()]{1,80}?)(?=\s*(?:[,;\n]|$|\d{1,2}\/\d{1,2})))?/g)) {
    const o = (m[1] ?? m[2] ?? "").trim();
    saida.push(o || null);
  }
  return saida;
}

function quantidadeDeParcelas(t) {
  const m = t.match(/\b(\d{1,2})\s*(?:x|vezes|parcelas?|prestacoes?)\b/) ?? t.match(/\bem\s+(\d{1,2})\b(?!\s*\/)/);
  if (m) return Number(m[1]);
  const e = t.match(/\b(um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+(?:x|vezes|parcelas?|prestacoes?)\b/);
  if (e) return POR_EXTENSO[e[1]];
  if (/\b(a vista|avista|parcela unica|uma vez so)\b/.test(t)) return 1;
  return null;
}

function tipoDoValor(t) {
  if (/\b(cada|cada uma|por parcela|por mes|parcelas? de|prestacoes? de|\d{1,2}\s*x\s*de|vezes de)\b/.test(t)) return TIPO_VALOR.PARCELA;
  if (/\b(total|no total|valor total|ao todo|tudo)\b/.test(t)) return TIPO_VALOR.TOTAL;
  return null;
}

function formaDePagamento(t) {
  if (/\b(cartao|credito|debito)\b/.test(t)) return FORMA.CARTAO;
  if (/\bboletos?\b/.test(t)) return FORMA.BOLETO;
  if (/\bpix\b/.test(t)) return FORMA.PIX;
  if (/\b(dinheiro|especie)\b/.test(t)) return FORMA.DINHEIRO;
  if (/\b(transferencia|ted|doc)\b/.test(t)) return FORMA.TRANSFERENCIA;
  return null;
}

/** Fornecedor/CREDOR SÓ quando dito explicitamente ("fornecedor X", "credor: X", "Banco do Nordeste"). Nunca deduzido da descrição. */
function fornecedorDito(original, unidades = []) {
  const s = String(original ?? "");
  // 27/11: "Loja Alfa." é a UNIDADE, não o fornecedor — nome que é apelido de uma unidade nunca vira credor
  const apelidos = new Set(unidades.flatMap((u) => u.apelidos ?? []).map((x) => normalizar(x)));
  for (const m of s.matchAll(/\b(?:fornecedor|credor|favorecido|loja|empresa|comprad[oa] (?:na|no|com)|com a empresa)\s*:?\s+([\p{L}0-9&.' -]{2,60}?)(?=\s*(?:[,.;!\n()—–]|$|\s+(?:dia|em|valor|no cart|parcel|r\$)))/giu)) {
    const nome = m[1]?.trim();
    if (nome && !/^(do|da|de|o|a)$/i.test(nome) && !apelidos.has(normalizar(nome))) return nome;
  }
  // 27/11 (caso real do empréstimo BNB): a instituição financeira DITA pelo nome ("Banco do Nordeste") é o credor. Só o que foi
  // escrito com o nome próprio; a sigla sozinha ("BNB") não vira credor (nada é deduzido).
  const b = s.match(/\b([Bb]anco\s+(?:d[oae]s?\s+)?\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+){0,2})/u);
  return b ? b[1].replace(/\s+/g, " ").trim() : null;
}

/**
 * 27/11 — a parte de OBSERVAÇÕES ("Obs.:", "Observações:") é texto livre PRESERVADO: valores e datas dela nunca viram valor,
 * vencimento nem competência ("descontar no dia 07/12" não é o vencimento bancário). Termina na primeira linha em branco.
 */
export function separarObservacoes(texto) {
  const s = String(texto ?? "");
  const m = /(^|\n|[.;]\s+)(observa[çc](?:[aã]o|[oõ]es)|obs\.?)\s*:?/i.exec(s);
  if (!m) return { principal: s, observacao: null };
  const ini = m.index + m[1].length;
  const resto = s.slice(ini + m[2].length).replace(/^\s*:?/, "");
  const fim = resto.search(/\n\s*\n/);
  const observacao = (fim >= 0 ? resto.slice(0, fim) : resto).trim();
  return { principal: `${s.slice(0, ini)}${fim >= 0 ? resto.slice(fim) : ""}`, observacao: observacao || null };
}

/**
 * 27/11 — competência DITA com marcador explícito ("referente a dezembro", "competência 11/2026", "mês de referência: novembro de 2026").
 * Sem marcador não há leitura (o "dia 07/12" de uma observação nunca é competência). Mês sem ano: o ano pela regra da resposta.
 */
export function competenciaDita(texto, dataMensagem) {
  const m = /\b(?:referentes?\s+(?:a|ao|à)|ref\.?|compet[eê]ncia|m[eê]s\s+de\s+refer[eê]ncia)\s*:?\s*(?:(?:ao\s+)?m[eê]s\s+(?:de\s+)?)?(\d{1,2}\s*\/\s*\d{2,4}|[\p{L}]+(?:\s*(?:\/|de)\s*\d{2,4})?)/iu.exec(String(texto ?? ""));
  return m ? competenciaDoRelato(m[1].replace(/\s*\/\s*/, " de "), dataMensagem) : null;
}

/**
 * Competência de uma CONTA A PAGAR relatada: a leitura comum do mês (competenciaDaResposta); mês SEM ano escrito = a ocorrência mais
 * próxima da data da mensagem ("dezembro" dito em outubro é o dezembro que vem; "setembro" dito em outubro é o que passou).
 */
export function competenciaDoRelato(texto, dataMensagem, hoje = null) {
  const c = competenciaDaResposta(texto, dataMensagem, hoje ?? dataMensagem);
  if (!c || /\b20\d{2}\b|\b\d{1,2}\s*(?:\/|de)\s*\d{2}\b|\b[a-z]{3,}\s+(?:de\s+)?\d{2}\b/i.test(normalizar(texto).replace(/\s+de\s+/g, " de "))) return c;
  const [am, mm] = dataMensagem.split("-").map(Number);
  const mes = Number(c.slice(5, 7));
  const ano = [am - 1, am, am + 1].sort((x, y) => Math.abs((x - am) * 12 + mes - mm) - Math.abs((y - am) * 12 + mes - mm))[0];
  return `${ano}-${String(mes).padStart(2, "0")}`;
}

/** "Descrição: Empréstimo BNB — Jailton e Vanessa" — a descrição DITA (prevalece sobre a primeira oração). */
export function descricaoDita(texto) {
  const m = /\bdescri[çc][aã]o\s*:\s*([^\n]{2,160})/i.exec(String(texto ?? ""));
  const d = m?.[1]?.trim().replace(/[.;,\s]+$/, "");
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : null;
}

/**
 * 27/11 — o VALOR da conta quando a mensagem traz mais de um número: o TOTAL dito ("Total: R$ 2.911,08") ou o valor que é a SOMA
 * EXATA dos demais (composição: "Jailton R$ 395,34 + Vanessa R$ 2.515,74"). As partes vão para a observação; nada é presumido.
 * @returns {{valores:number[], partes:number[]}}
 */
export function valorDoRelato(principal) {
  const valores = valoresCitados(principal);
  if (valores.length < 2) return { valores, partes: [] };
  const i = String(principal).search(/\btotal\b/i);
  const dito = i >= 0 ? valoresCitados(String(principal).slice(i, i + 40))[0] : null;
  const total = dito && valores.includes(dito) ? dito : valores.find((v) => v === valores.filter((x) => x !== v).reduce((s, x) => s + x, 0)) ?? null;
  if (!total) return { valores, partes: [] };
  return { valores: [total], partes: valores.filter((x) => x !== total) };
}

/** Linhas da composição ("Jailton: R$ 395,34") — preservadas na observação como foram escritas. */
function linhasDaComposicao(principal, partes) {
  if (!partes.length) return [];
  return String(principal).split(/\n/).map((l) => l.trim().replace(/[.;]+$/, "")).filter((l) => l && l.length <= 80 && valoresCitados(l).length === 1 && partes.includes(valoresCitados(l)[0]));
}

const JA_PAGA = /\b(ja (foi )?pag[oa]s?|ja (foi )?quitad[oa]s?|paguei|pagamos|foi paga|foi pago|quitei|quitamos)\b/;

/** Descrição limpa: a primeira oração, sem "compra de", sem a unidade ("para o açaí") e sem palavras de ligação nas pontas. */
export function descricaoLimpa(original, unidades = []) {
  // o chamado ("MOVA, ...", "Oi MOVA: ...") não é parte da descrição
  const semChamado = String(original ?? "").replace(/^\s*(?:(?:oi|ola|olá|bom dia|boa tarde|boa noite)[,!]?\s+)?mova\b\s*[,:!.-]?\s*/i, "");
  // 27/11: a oração que é SÓ a unidade ("Subway Saci.") ou só o pedido não é a descrição: vale a primeira que sobrar
  for (const trecho of semChamado.split(/[,;\n]|\s+-\s+|\.\s/).slice(0, 4)) {
    const d = descricaoDoTrecho(trecho, unidades);
    if (d) return d;
  }
  return null;
}

function descricaoDoTrecho(primeira, unidades) {
  let t = ` ${normalizar(primeira)} `;
  // 27/11: "chegou o boleto de internet" ⇒ "internet" (o aviso de chegada e o TIPO do papel não são o que se compra; "boleto" sozinho ainda corta)
  t = t.replace(/\s(?:chegou|chegaram|veio|vieram|recebi|recebemos)\s(?:(?:o|a|os|as)\s)?/g, " ").replace(/\s(?:boleto|fatura|conta)\s(?:de|do|da|dos|das)\s/g, " ");
  // a descrição termina onde começam valor, data, parcelas, forma de pagamento ou fornecedor
  const corte = t.search(/\s(?:r\s?\d+|\d+|vence|vencimento|boleto|pix|cartao|credito|dia|dias|parcelas?|fornecedor|credor|categoria|referente|competencia|valor|no total|total)(?=\s|$)/);
  if (corte >= 0) t = `${t.slice(0, corte)} `;
  // 27/11: o PEDIDO ("registre conta a pagar") não é a descrição do que foi comprado
  t = t.replace(/\s(?:registre|registrar|registra|lance|lancar|lanca|cadastre|cadastrar|anote|anotar|inclua|incluir|coloque|colocar|por favor)(?=\s)/g, " ").replace(/\sa pagar(?=\s)/g, " ");
  t = t.replace(/\s(?:uma\s)?unica(?=\s)/g, " ").replace(/\s(?:compra|compramos|comprei|comprou|conta|despesa|pagamento)\s(?:de|do|da)?\s?/g, " ");
  const apelidos = [...new Set(unidades.flatMap((u) => u.apelidos ?? []))].sort((a, b) => b.length - a.length);
  for (const ap of apelidos) t = t.split(` ${ap} `).join(" ");
  const palavras = t.split(" ").filter(Boolean);
  while (palavras.length && LIGACAO.has(palavras[palavras.length - 1])) palavras.pop();
  while (palavras.length && LIGACAO.has(palavras[0])) palavras.shift();
  if (!palavras.length) return null;
  // recupera a grafia original (acentos) da descrição quando possível
  const s = palavras.join(" ");
  const orig = primeira.normalize("NFC");
  const idx = normalizar(orig).indexOf(s);
  const bonito = idx >= 0 && normalizar(orig).length === orig.length ? orig.slice(idx, idx + s.length) : s;
  return bonito.charAt(0).toUpperCase() + bonito.slice(1);
}

/** "categoria Equipamentos", "categoria: manutenção" — a categoria DITA na mensagem (texto livre) ou null. */
export function categoriaDita(texto) {
  const m = String(texto ?? "").match(/\bcategoria\s*:?\s+([\p{L}][\p{L} ]{1,40}?)(?=\s*(?:[,.;!\n—–(-]|$)|\s+(?:no|na|para|pro|pra|do|da|valor|dia|vence|vencimento|r\$|em)\b)/iu);
  return m ? m[1].trim() : null;
}

const MAX_OPCOES = 8;
// 27/11: categorias PATRIMONIAIS lançáveis que uma conta a pagar relatada pode usar (principal de empréstimo, parcelamento tributário,
// aporte/retirada...). Ficam de fora as do sistema/de outros fluxos: títulos anteriores à abertura e operações entre empresas.
const PATRIMONIAIS_FORA = new Set(["TITULOS_ANTERIORES_A_ABERTURA", "OPERACOES_ENTRE_EMPRESAS"]);
const lancavel = (c) => c?.aceitaLancamento && c.ativa !== false && c.codigo;
const lancaveisDoPlano = (categorias, { comImobilizado }) => (categorias ?? []).filter((c) => lancavel(c)
  && (["CUSTO", "DESPESA"].includes(c.natureza) || (comImobilizado && c.codigo === "IMOBILIZADO")));
const patrimoniaisDoPlano = (categorias) => (categorias ?? []).filter((c) => lancavel(c) && c.natureza === "PATRIMONIAL" && c.codigo !== "IMOBILIZADO" && !PATRIMONIAIS_FORA.has(c.codigo));
/** A categoria é PATRIMONIAL fora da DRE (o registro ESTREITO pela conversa só cobre despesa e imobilizado: fica para aprovação). */
export const ehPatrimonialForaDaDre = (codigo, categorias) => { const c = (categorias ?? []).find((x) => x.codigo === codigo); return Boolean(c) && c.natureza === "PATRIMONIAL" && c.codigo !== "IMOBILIZADO"; };

// Radicais significativos (≥ 5 letras): relevância GENÉRICA entre o relato e o nome da categoria (sem lista por tipo de conta).
const GENERICAS = new Set(["sobre", "outras", "outros", "despesas", "despesa", "pagar", "conta", "contas", "registrar", "unica"]);
const radicais = (s) => new Set(normalizar(s).split(" ").filter((w) => w.length >= 5 && !GENERICAS.has(w)).map((w) => w.slice(0, 6)));
const relevancia = (c, alvo) => [...radicais(c.nome)].filter((r) => alvo.has(r)).length;

/**
 * 27/11 — categoria PATRIMONIAL do plano para a qual o relato/comprovante aponta (ex.: "Empréstimo BNB" ⇒ "Empréstimos e financiamentos
 * (principal)"). Só quando UMA patrimonial casa pelos radicais; nunca imobilizado, títulos anteriores ou operações entre empresas.
 */
export function categoriaPatrimonialDoRelato(texto, categorias) {
  const alvo = radicais(texto ?? "");
  const casadas = patrimoniaisDoPlano(categorias).filter((c) => relevancia(c, alvo) > 0);
  return casadas.length === 1 ? casadas[0].codigo : null;
}

/** Para equipamento: imobilizado e despesas de equipamento/manutenção/utensílios primeiro (só a ORDEM das opções; nada é escolhido). */
function ordenarParaEquipamento(lista, equipamento) {
  if (!equipamento) return lista;
  const peso = (c) => (c.codigo === "IMOBILIZADO" ? 0 : /equipament|manutenc|utensil|material|moveis|bens/.test(normalizar(c.nome)) ? 1 : 2);
  return [...lista].sort((a, b) => peso(a) - peso(b));
}

/**
 * Classificação da conta relatada pelo PLANO da unidade. Nunca devolve categoria fora do plano e nunca escolhe IMOBILIZADO sozinha.
 * `categoriaSugerida`: a da leitura da mensagem (só desempata dentro do plano; equipamento continua sempre perguntado).
 * 27/11 (generalização): vale para QUALQUER obrigação (empréstimo, aluguel, energia, honorários, impostos, royalties, compras).
 * Categoria PATRIMONIAL do plano (ex.: "Empréstimos e financiamentos (principal)") pode ser DITA ou escolhida; quando o relato
 * aponta para uma patrimonial, nada é escolhido sozinho pela DRE (o principal de um empréstimo nunca vira despesa por sinônimo).
 * @returns {{codigo:string|null, perguntar:boolean, motivo:string, opcoes:Array<{codigo,nome}>, sugestaoDeCriacao:string|null}}
 */
export function classificarContaRelatada({ descricao, texto = "", categorias, categoriaSugerida = null }) {
  const plano = categorias ?? [];
  const t = normalizar(descricao);
  const equipamento = Boolean(t) && EQUIPAMENTO.test(t) && !SERVICO.test(t);
  // só a DESCRIÇÃO conta (o resto do texto tem forma de pagamento: "2 parcelas" não aponta para "Parcelamento tributário")
  const alvo = radicais(descricao ?? "");
  const patrimoniais = patrimoniaisDoPlano(plano);
  const patrimonialRelevante = patrimoniais.filter((c) => relevancia(c, alvo) > 0).sort((a, b) => relevancia(b, alvo) - relevancia(a, alvo));
  // opções: as mais RELEVANTES ao relato primeiro (patrimonial relevante antes; despesas por relevância; equipamento como antes)
  const despesas = ordenarParaEquipamento(lancaveisDoPlano(plano, { comImobilizado: equipamento }), equipamento);
  const despesasOrdenadas = equipamento ? despesas : [...despesas].sort((a, b) => relevancia(b, alvo) - relevancia(a, alvo));
  const todas = [...patrimonialRelevante, ...despesasOrdenadas];
  const opcoesDe = (lista) => lista.slice(0, MAX_OPCOES).map((c) => ({ codigo: c.codigo, nome: c.nome }));
  const dita = categoriaDita(texto);
  if (dita) {
    const r = interpretarCategoria({ texto: dita, categorias: plano });
    // categoria dita PATRIMONIAL ("categoria Empréstimos"): UMA do plano com radical em comum ⇒ ela. Casamento só PARCIAL com uma
    // despesa ("Empréstimos" × "Juros de empréstimos") não vence a patrimonial: o principal nunca vira despesa por semelhança de nome.
    const ditaAlvo = radicais(dita);
    const patrimonialDita = patrimoniais.filter((c) => relevancia(c, ditaAlvo) > 0);
    const nomeDaDre = r.categoria ? normalizar(plano.find((c) => c.codigo === r.categoria)?.nome) : "";
    const dreInteira = Boolean(nomeDaDre) && ` ${normalizar(dita)} `.includes(` ${nomeDaDre} `);
    if (r.categoria && (dreInteira || !patrimonialDita.length)) return { codigo: r.categoria, perguntar: false, motivo: "CATEGORIA_DITA", opcoes: [], sugestaoDeCriacao: null };
    if (patrimonialDita.length === 1) return { codigo: patrimonialDita[0].codigo, perguntar: false, motivo: "CATEGORIA_DITA", opcoes: [], sugestaoDeCriacao: null };
    const parecidas = [...patrimonialDita, ...(r.categoria ? [despesas.find((c) => c.codigo === r.categoria)].filter(Boolean) : []), ...(r.opcoes ?? []).map((o) => despesas.find((c) => c.codigo === o.codigo)).filter(Boolean)];
    return { codigo: null, perguntar: true, motivo: "CATEGORIA_DITA_FORA_DO_PLANO", opcoes: opcoesDe(parecidas.length ? parecidas : todas), sugestaoDeCriacao: dita.slice(0, 60) };
  }
  if (equipamento) return { codigo: null, perguntar: true, motivo: "EQUIPAMENTO_EXIGE_CLASSIFICACAO", opcoes: opcoesDe(todas), sugestaoDeCriacao: null };
  // relato que aponta para uma categoria PATRIMONIAL (ex.: empréstimo): a decisão contábil é das pessoas — pergunta com ela primeiro
  if (patrimonialRelevante.length) return { codigo: null, perguntar: true, motivo: "PATRIMONIAL_EXIGE_CLASSIFICACAO", opcoes: opcoesDe(todas), sugestaoDeCriacao: null };
  // a sugestão da leitura só vale se casar com UMA categoria de CUSTO/DESPESA do plano (escolherCategoria nunca devolve IMOBILIZADO)
  const codigo = t ? escolherCategoria({ categorias: plano, categoriaSugerida, legenda: descricao }) : null;
  if (codigo) return { codigo, perguntar: false, motivo: "REGRA_DO_PLANO", opcoes: [], sugestaoDeCriacao: null };
  return { codigo: null, perguntar: true, motivo: "SEM_CATEGORIA_SEGURA", opcoes: opcoesDe(todas), sugestaoDeCriacao: null };
}

/**
 * Resposta à pergunta de categoria: número da opção, nome de categoria do plano, ou "0"/"não sei"/"deixa para o financeiro"
 * (fica a classificar no Centro Financeiro). `{codigo}` | `{revisao:true}` | null (não entendeu: pergunta de novo, sem consumir).
 */
export function interpretarRespostaDaCategoria(texto, { opcoes = [], categorias = [] } = {}) {
  const t = normalizar(texto);
  if (!t || t.length > 80) return null;
  if (/^(0|zero|nao sei|deixa|deixe|deixar|depois|classificar depois|para o financeiro|pro financeiro|nenhuma)\b/.test(t)) return { revisao: true };
  const n = t.match(/^(\d{1,2})$/);
  if (n) { const o = opcoes[Number(n[1]) - 1]; return o ? { codigo: o.codigo } : null; }
  const porNome = opcoes.find((o) => normalizar(o.nome) === t);
  if (porNome) return { codigo: porNome.codigo };
  const r = interpretarCategoria({ texto, categorias });
  return r.categoria ? { codigo: r.categoria } : null;
}

/** Compatibilidade: o código só quando é seguro decidir SEM perguntar; senão null. */
export function categoriaDaContaRelatada(descricao, categorias) {
  return classificarContaRelatada({ descricao, categorias }).codigo;
}

/**
 * @param {{texto:string, dataMensagem:string, unidades?:Array<{apelidos:string[]}>, tipoValor?:string|null, porFoto?:boolean,
 *          declarada?:boolean, competenciaInformada?:string|null, complemento?:object|null}} p
 *        `porFoto`: a legenda acompanha a FOTO do produto (a foto já mostra que é uma compra)
 *        `tipoValor`: a resposta à pergunta "total ou cada parcela?" (quando já foi perguntado)
 *        `declarada` (27/11): a leitura da mensagem é um PEDIDO de registrar conta (intenção REGISTRAR_CONTA) — vale para qualquer
 *          obrigação (empréstimo, aluguel, energia, honorários, impostos...), não só compra
 *        `competenciaInformada`: competência DITA (lida da mensagem; nunca presumida pelo vencimento)
 *        `complemento`: o que a pessoa já respondeu às perguntas do MOVA (vencimentos, competência, valor, descrição) — nada se perde
 * @returns {{ehConta:boolean, faltas:string[], ambiguo:boolean, descricao, fornecedor, forma, competencia, dataEmissao, observacao,
 *           parcelas:Array<{numero,total,vencimento,valorCentavos}>, totalCentavos, valorCitadoCentavos, tipoValor, compra:boolean, jaPaga:boolean}}
 */
export function interpretarContaRelatada({ texto, dataMensagem, unidades = [], tipoValor = null, porFoto = false, declarada = false, competenciaInformada = null, complemento = null, vencimentoLido = null }) {
  const dado = complemento ?? {}; // o que a pessoa já respondeu às perguntas do MOVA
  // 27/11: observações (texto livre preservado) saem ANTES de ler valor, data, parcelas e competência
  const { principal, observacao: obsDita } = separarObservacoes(texto);
  // datas e valores fora antes de procurar parcelas: normalizado, "vence em 25/10" vira "em 25 10" (não são 25 parcelas)
  // 27/11 (#245, generalizado): a oração do DESCONTO da remuneração/folha — com ou sem o marcador "Obs." — é informação distinta:
  // as datas dela (ex.: desconto em 07/12) NUNCA viram vencimento bancário nem "vence dia N". Ela fica na observação.
  const desconto = oracaoDeDesconto(principal);
  const semDesconto = desconto ? String(principal).replace(desconto, " ") : String(principal ?? "");
  const t = normalizar(semDesconto.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ").replace(/r\$\s*[\d.,]+|\b\d[\d.]*,\d{1,2}\b/gi, " "));
  // valor: composição rotulada do total (#243: "Jailton R$ 395,34, Vanessa R$ 2.515,74, total R$ 2.911,08") ou o total dito (#244)
  const composicao = composicaoDoTotal(principal);
  const lidos = composicao ? { valores: [composicao.totalCentavos], partes: [] } : valorDoRelato(principal);
  const valores = Number.isSafeInteger(dado.valorCentavos) && dado.valorCentavos > 0 ? [dado.valorCentavos] : lidos.valores;
  const citadas = datasCitadas(semDesconto, dataMensagem);
  // 27/11: "vence dia 10" (sem mês/ano escritos): vale a data LIDA da mensagem só quando o DIA dela está escrito no texto ("dia 10");
  // nunca uma data que a pessoa não disse. Datas dd/mm escritas e respostas às perguntas prevalecem.
  const diaEscrito = /^\d{4}-\d{2}-(\d{2})$/.exec(String(vencimentoLido ?? ""));
  const vencimentoPeloDia = diaEscrito && !citadas.datas.length && vencimentoLido >= dataMensagem
    && new RegExp(`\\bdia\\s+0?${Number(diaEscrito[1])}\\b`).test(normalizar(semDesconto)) ? [vencimentoLido] : [];
  const datas = Array.isArray(dado.vencimentos) && dado.vencimentos.length ? dado.vencimentos : citadas.datas.length ? citadas.datas : vencimentoPeloDia;
  const invalida = Array.isArray(dado.vencimentos) && dado.vencimentos.length ? null : citadas.invalida;
  let n = quantidadeDeParcelas(t);
  const forma = formaDePagamento(t);
  const fornecedor = fornecedorDito(principal, unidades);
  const descricao = dado.descricao ?? descricaoDita(principal) ?? descricaoLimpa(principal, unidades);
  // observação: composição do total + oração do desconto (#243/#245, com ou sem "Obs."), linhas da composição sem total rotulado e a seção
  // "Obs./Observações" (#244). Só o que foi DITO; inteira (o motor guarda o texto completo na proposta).
  const observacao = [observacaoDaConta(principal, composicao), ...linhasDaComposicao(principal, lidos.partes), ...(obsDita ? [obsDita.replace(/\s*\n\s*/g, "; ")] : [])].filter(Boolean).join("; ") || null;
  // 27/11 (PR #236): a competência de uma COMPRA é o MÊS DA COMPRA (a mensagem): palavra de compra, parcelas ditas, ou foto do produto.
  // Qualquer OUTRA obrigação declarada (empréstimo, aluguel, conta que chegou) só tem a competência DITA — senão é perguntada.
  const compra = porFoto || (n !== null && n > 1) || COMPRA.test(t);
  const competencia = compra ? dataMensagem.slice(0, 7) : dado.competencia ?? competenciaInformada ?? competenciaDita(semDesconto, dataMensagem);
  const jaPaga = JA_PAGA.test(t);
  const faltas = [];
  if (invalida) faltas.push("DATA_INVALIDA");
  if (valores.length === 0) faltas.push("VALOR");
  if (valores.length > 1) faltas.push("VALORES_DIFERENTES");
  if (!descricao) faltas.push("DESCRICAO");
  if (n === null) n = datas.length || null;
  if (n !== null && (n < 1 || n > MAX_PARCELAS)) faltas.push("PARCELAS");
  if (!datas.length) faltas.push("VENCIMENTO");
  else if (n !== null && datas.length !== n) faltas.push("VENCIMENTOS_DAS_PARCELAS");
  // compra: nada vence antes da compra. Outra obrigação pode já estar vencida (aviso atrasado): a emissão é a data mais antiga.
  if (compra && datas.some((d) => d < dataMensagem)) faltas.push("VENCIMENTO_ANTERIOR_A_COMPRA");
  if (!competencia) faltas.push("COMPETENCIA");
  const tipo = n === 1 ? TIPO_VALOR.TOTAL : tipoValor ?? tipoDoValor(t) ?? TIPO_VALOR.AMBIGUO;
  const ambiguo = tipo === TIPO_VALOR.AMBIGUO && valores.length === 1 && (n ?? 0) > 1;
  const observacoes = observacoesPorData(semDesconto);
  let parcelas = [];
  let total = null;
  if (!faltas.length && !ambiguo) {
    const [v] = valores;
    if (tipo === TIPO_VALOR.PARCELA) {
      parcelas = datas.map((d, i) => ({ numero: i + 1, total: n, vencimento: d, valorCentavos: v, observacao: observacoes[i] ?? null }));
      total = v * n;
    } else {
      const base = Math.floor(v / n);
      const resto = v - base * n;
      parcelas = datas.map((d, i) => ({ numero: i + 1, total: n, vencimento: d, valorCentavos: base + (i === n - 1 ? resto : 0), observacao: observacoes[i] ?? null }));
      total = v;
    }
  }
  const dataEmissao = compra || !datas.length ? dataMensagem : [dataMensagem, ...datas].sort()[0];
  return Object.freeze({
    // compra: como antes (valor + data). Obrigação DECLARADA: basta o valor — o que faltar é perguntado (nunca vai para o fluxo comum
    // sem dono). Conta já PAGA não é conta a pagar relatada (é comprovante/despesa paga).
    ehConta: !jaPaga && ((compra && valores.length > 0 && (datas.length > 0 || Boolean(desconto))) || (declarada && valores.length > 0)), faltas, ambiguo, descricao, fornecedor, forma,
    observacao, composicao, competencia, dataEmissao, parcelas, totalCentavos: total, compra, jaPaga,
    valorCitadoCentavos: valores[0] ?? null, tipoValor: ambiguo ? TIPO_VALOR.AMBIGUO : tipo, quantidade: n,
  });
}

/**
 * 27/11 — resposta à pergunta "o que falta" (vencimento, mês de referência, valor, descrição): cada trecho preenche SÓ o campo que
 * faltava; o que já tinha sido dito continua. Devolve o complemento ACUMULADO ou null (não entendeu: pergunta de novo, sem consumir).
 */
export function complementoDaResposta(texto, { faltas = [], complemento = {}, dataMensagem, hoje = null, competenciaDe = null }) {
  const novo = { ...complemento };
  let usou = false;
  const precisa = (f) => faltas.includes(f);
  if (["VENCIMENTO", "VENCIMENTOS_DAS_PARCELAS", "DATA_INVALIDA", "VENCIMENTO_ANTERIOR_A_COMPRA"].some(precisa)) {
    const { datas, invalida } = datasCitadas(texto, dataMensagem);
    if (datas.length && !invalida) { novo.vencimentos = datas; usou = true; }
  }
  if (precisa("COMPETENCIA") && typeof competenciaDe === "function") {
    // o mês de referência pode vir junto com a data ("vence 10/12, referente a novembro"): lê trecho a trecho, sem as datas
    for (const trecho of String(texto ?? "").replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ").split(/[,;\n]|\s+e\s+/)) {
      const c = competenciaDe(trecho, dataMensagem, hoje);
      if (c) { novo.competencia = c; usou = true; break; }
    }
  }
  if (precisa("VALOR") || precisa("VALORES_DIFERENTES")) {
    const { valores } = valorDoRelato(texto);
    if (valores.length === 1) { novo.valorCentavos = valores[0]; usou = true; }
  }
  if (precisa("DESCRICAO") && !usou) {
    const d = String(texto ?? "").trim().replace(/[.;,\s]+$/, "");
    if (d && d.length <= 120 && !/\d/.test(d)) { novo.descricao = d.charAt(0).toUpperCase() + d.slice(1); usou = true; }
  }
  return usou ? novo : null;
}

const COMPRA = /\b(?:emprestimo|financiamento|compra|compras|comprei|comprou|compramos|compraram|comprado|comprada|adquiri|adquirimos|adquirido)\b/;

/** Resposta à pergunta "total ou cada parcela?": PARCELA, TOTAL ou null (não entendeu — pergunta de novo, sem consumir). */
export function interpretarRespostaDoValor(texto) {
  const t = normalizar(texto);
  if (!t || t.length > 60) return null;
  if (/^(1|cada|cada uma|cada parcela|por parcela|parcela|da parcela|de cada|de cada parcela|valor da parcela|e de cada|e por parcela)\b/.test(t)) return TIPO_VALOR.PARCELA;
  if (/^(2|total|o total|valor total|e o total|e total|no total|tudo|ao todo)\b/.test(t)) return TIPO_VALOR.TOTAL;
  return null;
}
