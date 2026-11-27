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
import { escolherCategoria, interpretarCategoria, normalizar } from "./divergencia.js";

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

/** Valores em reais citados ("R$194,50", "R$ 1.779,90", "194,50 reais"), na ordem, sem repetir. */
export function valoresCitados(texto) {
  const achados = [];
  const re = /(?:r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?))|(?:\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:reais|rs)\b)/gi;
  for (const m of String(texto ?? "").matchAll(re)) { const v = centavos(m[1] ?? m[2]); if (v && !achados.includes(v)) achados.push(v); }
  return achados;
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

/** Fornecedor SÓ quando dito explicitamente. Nunca deduzido da descrição. */
function fornecedorDito(original) {
  const m = String(original ?? "").match(/\b(?:fornecedor|loja|empresa|comprad[oa] (?:na|no|com)|com a empresa)\s*:?\s+([\p{L}0-9&.' -]{2,60}?)(?=\s*(?:[,.;!]|$|\s+(?:dia|em|valor|no cart|parcel|r\$)))/iu);
  const nome = m?.[1]?.trim();
  return nome && !/^(do|da|de|o|a)$/i.test(nome) ? nome : null;
}

/** Descrição limpa: a primeira oração, sem "compra de", sem a unidade ("para o açaí") e sem palavras de ligação nas pontas. */
export function descricaoLimpa(original, unidades = []) {
  // o chamado ("MOVA, ...", "Oi MOVA: ...") não é parte da descrição
  const semChamado = String(original ?? "").replace(/^\s*(?:(?:oi|ola|olá|bom dia|boa tarde|boa noite)[,!]?\s+)?mova\b\s*[,:!.-]?\s*/i, "");
  const primeira = semChamado.split(/[,;\n]|\s+-\s+/)[0] ?? "";
  let t = ` ${normalizar(primeira)} `;
  // 27/11: "chegou o boleto de internet" ⇒ "internet" (o aviso de chegada e o TIPO do papel não são o que se compra; "boleto" sozinho ainda corta)
  t = t.replace(/\s(?:chegou|chegaram|veio|vieram|recebi|recebemos)\s(?:(?:o|a|os|as)\s)?/g, " ").replace(/\s(?:boleto|fatura|conta)\s(?:de|do|da|dos|das)\s/g, " ");
  // a descrição termina onde começam valor, data, parcelas, forma de pagamento ou fornecedor
  const corte = t.search(/\s(?:r\s?\d+|\d+|vence|vencimento|boleto|pix|cartao|credito|dia|dias|parcelas?|fornecedor|valor|no total)(?=\s|$)/);
  if (corte > 0) t = `${t.slice(0, corte)} `;
  // 27/11: o PEDIDO ("registre conta a pagar") não é a descrição do que foi comprado
  t = t.replace(/\s(?:registre|registrar|registra|lance|lancar|lanca|cadastre|cadastrar|anote|anotar|inclua|incluir|coloque|colocar|por favor)(?=\s)/g, " ").replace(/\sa pagar(?=\s)/g, " ");
  t = t.replace(/\s(?:compra|compramos|comprei|comprou|conta|despesa|pagamento)\s(?:de|do|da)?\s?/g, " ");
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
  const m = String(texto ?? "").match(/\bcategoria\s*:?\s+([\p{L}][\p{L} ]{1,40}?)(?=\s*(?:[,.;!\n]|$)|\s+(?:no|na|para|pro|pra|do|da|valor|dia|vence|vencimento|r\$|em)\b)/iu);
  return m ? m[1].trim() : null;
}

const MAX_OPCOES = 8;
const lancaveisDoPlano = (categorias, { comImobilizado }) => (categorias ?? []).filter((c) => c?.aceitaLancamento && c.ativa !== false && c.codigo
  && (["CUSTO", "DESPESA"].includes(c.natureza) || (comImobilizado && c.codigo === "IMOBILIZADO")));

/** Para equipamento: imobilizado e despesas de equipamento/manutenção/utensílios primeiro (só a ORDEM das opções; nada é escolhido). */
function ordenarParaEquipamento(lista, equipamento) {
  if (!equipamento) return lista;
  const peso = (c) => (c.codigo === "IMOBILIZADO" ? 0 : /equipament|manutenc|utensil|material|moveis|bens/.test(normalizar(c.nome)) ? 1 : 2);
  return [...lista].sort((a, b) => peso(a) - peso(b));
}

/**
 * Classificação da conta relatada pelo PLANO da unidade. Nunca devolve categoria fora do plano e nunca escolhe IMOBILIZADO sozinha.
 * `categoriaSugerida`: a da leitura da mensagem (só desempata dentro do plano; equipamento continua sempre perguntado).
 * @returns {{codigo:string|null, perguntar:boolean, motivo:string, opcoes:Array<{codigo,nome}>, sugestaoDeCriacao:string|null}}
 */
export function classificarContaRelatada({ descricao, texto = "", categorias, categoriaSugerida = null }) {
  const plano = categorias ?? [];
  const t = normalizar(descricao);
  const equipamento = Boolean(t) && EQUIPAMENTO.test(t) && !SERVICO.test(t);
  const todas = lancaveisDoPlano(plano, { comImobilizado: equipamento });
  const opcoesDe = (lista) => lista.slice(0, MAX_OPCOES).map((c) => ({ codigo: c.codigo, nome: c.nome }));
  const dita = categoriaDita(texto);
  if (dita) {
    const r = interpretarCategoria({ texto: dita, categorias: plano });
    if (r.categoria) return { codigo: r.categoria, perguntar: false, motivo: "CATEGORIA_DITA", opcoes: [], sugestaoDeCriacao: null };
    const parecidas = (r.opcoes ?? []).map((o) => todas.find((c) => c.codigo === o.codigo)).filter(Boolean);
    return { codigo: null, perguntar: true, motivo: "CATEGORIA_DITA_FORA_DO_PLANO", opcoes: opcoesDe(parecidas.length ? parecidas : ordenarParaEquipamento(todas, equipamento)), sugestaoDeCriacao: dita.slice(0, 60) };
  }
  if (equipamento) return { codigo: null, perguntar: true, motivo: "EQUIPAMENTO_EXIGE_CLASSIFICACAO", opcoes: opcoesDe(ordenarParaEquipamento(todas, true)), sugestaoDeCriacao: null };
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
 * @param {{texto:string, dataMensagem:string, unidades?:Array<{apelidos:string[]}>, tipoValor?:string|null, porFoto?:boolean}} p
 *        `porFoto`: a legenda acompanha a FOTO do produto (a foto já mostra que é uma compra)
 *        `tipoValor`: a resposta à pergunta "total ou cada parcela?" (quando já foi perguntado)
 * @returns {{ehConta:boolean, faltas:string[], ambiguo:boolean, descricao, fornecedor, forma, competencia, dataEmissao,
 *           parcelas:Array<{numero,total,vencimento,valorCentavos}>, totalCentavos, valorCitadoCentavos, tipoValor}}
 */
export function interpretarContaRelatada({ texto, dataMensagem, unidades = [], tipoValor = null, porFoto = false }) {
  // datas e valores fora antes de procurar parcelas: normalizado, "vence em 25/10" vira "em 25 10" (não são 25 parcelas)
  const t = normalizar(String(texto ?? "").replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ").replace(/r\$\s*[\d.,]+|\b\d[\d.]*,\d{1,2}\b/gi, " "));
  const valores = valoresCitados(texto);
  const { datas, invalida } = datasCitadas(texto, dataMensagem);
  let n = quantidadeDeParcelas(t);
  const forma = formaDePagamento(t);
  const fornecedor = fornecedorDito(texto);
  const descricao = descricaoLimpa(texto, unidades);
  // 27/11 (PR #236): a competência desta modalidade é o MÊS DA COMPRA (a mensagem). Só vale para o que a mensagem relata como
  // COMPRA (palavra de compra, parcelas ditas, ou foto do produto). Aviso de conta que CHEGOU ("chegou o boleto de internet",
  // "boleto da contabilidade de setembro") não é compra: segue o fluxo comum, onde a competência NUNCA é presumida.
  const compra = porFoto || (n !== null && n > 1) || COMPRA.test(t);
  const faltas = [];
  if (invalida) faltas.push("DATA_INVALIDA");
  if (valores.length === 0) faltas.push("VALOR");
  if (valores.length > 1) faltas.push("VALORES_DIFERENTES");
  if (!descricao) faltas.push("DESCRICAO");
  if (n === null) n = datas.length || null;
  if (n !== null && (n < 1 || n > MAX_PARCELAS)) faltas.push("PARCELAS");
  if (!datas.length) faltas.push("VENCIMENTO");
  else if (n !== null && datas.length !== n) faltas.push("VENCIMENTOS_DAS_PARCELAS");
  if (datas.some((d) => d < dataMensagem)) faltas.push("VENCIMENTO_ANTERIOR_A_COMPRA");
  const tipo = n === 1 ? TIPO_VALOR.TOTAL : tipoValor ?? tipoDoValor(t) ?? TIPO_VALOR.AMBIGUO;
  const ambiguo = tipo === TIPO_VALOR.AMBIGUO && valores.length === 1 && (n ?? 0) > 1;
  let parcelas = [];
  let total = null;
  if (!faltas.length && !ambiguo) {
    const [v] = valores;
    if (tipo === TIPO_VALOR.PARCELA) {
      parcelas = datas.map((d, i) => ({ numero: i + 1, total: n, vencimento: d, valorCentavos: v }));
      total = v * n;
    } else {
      const base = Math.floor(v / n);
      const resto = v - base * n;
      parcelas = datas.map((d, i) => ({ numero: i + 1, total: n, vencimento: d, valorCentavos: base + (i === n - 1 ? resto : 0) }));
      total = v;
    }
  }
  return Object.freeze({
    ehConta: compra && valores.length > 0 && datas.length > 0, faltas, ambiguo, descricao, fornecedor, forma,
    competencia: dataMensagem.slice(0, 7), dataEmissao: dataMensagem, parcelas, totalCentavos: total,
    valorCitadoCentavos: valores[0] ?? null, tipoValor: ambiguo ? TIPO_VALOR.AMBIGUO : tipo, quantidade: n,
  });
}

const COMPRA = /\b(?:compra|compras|comprei|comprou|compramos|compraram|comprado|comprada|adquiri|adquirimos|adquirido)\b/;

/** Resposta à pergunta "total ou cada parcela?": PARCELA, TOTAL ou null (não entendeu — pergunta de novo, sem consumir). */
export function interpretarRespostaDoValor(texto) {
  const t = normalizar(texto);
  if (!t || t.length > 60) return null;
  if (/^(1|cada|cada uma|cada parcela|por parcela|parcela|da parcela|de cada|de cada parcela|valor da parcela|e de cada|e por parcela)\b/.test(t)) return TIPO_VALOR.PARCELA;
  if (/^(2|total|o total|valor total|e o total|e total|no total|tudo|ao todo)\b/.test(t)) return TIPO_VALOR.TOTAL;
  return null;
}
