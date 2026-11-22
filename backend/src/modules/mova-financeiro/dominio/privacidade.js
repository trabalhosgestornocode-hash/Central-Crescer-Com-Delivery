// POLÍTICA DE COMPARTILHAMENTO no grupo — todo participante conversa com o MOVA, então só sai no grupo o que pode ser visto
// por TODOS os participantes. O resto fica no Centro Financeiro autenticado (Dashboard).
//
// PODE sair no grupo (agregados por unidade, nunca linha a linha):
//   - contas a pagar em aberto: quantidade, total e total vencido; vencendo em 7 dias: quantidade e total;
//   - contas a receber em aberto: quantidade e total;
//   - comparativo dessas mesmas grandezas entre as unidades do grupo (cada uma separada, nunca somadas como se fossem uma);
//   - situação das propostas do MOVA (quantas aguardam revisão, aplicadas, rejeitadas) e o código curto da proposta;
//   - Execução 03: faturamento por período, RESUMO da DRE (indicadores do Financeiro com a situação de cada um), caixa realizado,
//     pendências (quantidade), total de uma CATEGORIA na competência (ex.: entregadores, sem nomes nem pagamentos individuais);
//   - confirmação do que o MOVA entendeu de um documento ENVIADO no grupo (valor, datas) — o documento já é do grupo.
// NUNCA sai no grupo (resposta padrão: "consulte o Centro Financeiro"):
//   - dados bancários (agência, conta, chave Pix, saldos de conta), cartões;
//   - documentos pessoais (CPF, RG, CNH), dados INDIVIDUAIS de funcionários e entregadores (nome, pagamento, salário, nota);
//   - credenciais (senhas, tokens, códigos, chaves de API);
//   - DRE linha a linha/por fornecedor; listas de fornecedores com valores; extratos.
// A decisão é determinística (`pedidoRestrito`), independe da IA, e as respostas passam por `mascararDadosSensiveis`.

const PADROES_RESTRITOS = [
  /\b(ag[eê]ncia|conta\s+(corrente|banc[aá]ria|poupan[cç]a)|n[uú]mero\s+da\s+conta|chave\s+pix|saldo\s+(do|da|no|na)\s+(banco|conta))\b/i,
  /\b(cpf|rg|cnh|documento\s+pessoal|data\s+de\s+nascimento)\b/i,
  /\b(sal[aá]rio|folha(\s+de\s+pagamento)?|holerite|quanto\s+(ganha|recebe|recebeu)|pagamento\s+d[oe]\s+(entregador|motoboy|funcion[aá]ri[oa])\s+[A-ZÀ-Ú]|nota\s+d[oe]\s+entregador)/i,
  /\b(senha|token|c[oó]digo\s+de\s+(acesso|verifica[cç][aã]o)|login|credencia(l|is)|api\s*key|chave\s+de\s+api)\b/i,
  /\b(extrato\s+banc[aá]rio|extrato\s+da\s+conta|dre\s+(linha\s+a\s+linha|detalhad[ao]|por\s+fornecedor))\b/i,
];

/** O pedido toca em dado restrito? (decisão determinística, antes e independente da IA) */
export const pedidoRestrito = (texto) => PADROES_RESTRITOS.some((r) => r.test(String(texto ?? "")));

// Execução 13C (Teste D real): pedido explícito de dados de empresa/unidade/loja que NÃO é do grupo, ou "sem acesso/autorização".
// Bloqueado antes da IA (nenhuma chamada paga). A garantia de acesso continua sendo a resolução de unidade só dentro do grupo;
// isto apenas recusa cedo, com motivo próprio, o que o texto já declara estar fora do escopo.
const PADROES_FORA_DO_ESCOPO = [
  /\b(outr[ao]s?)\s+(empresas?|unidades?|lojas?|franquias?|cnpjs?|neg[oó]cios?)\b/i,
  /\b(empresa|unidade|loja|franquia)s?\s+(a|à|as|às|da|de|em|com)?\s*(qua(l|is)|que)\s+(eu\s+)?n[aã]o\s+(tenho|temos)\s+(acesso|autoriza[cç][aã]o|permiss[aã]o)/i,
  /\b(concorrente|concorr[eê]ncia)s?\b/i,
];
// "não tenho acesso"/"sem acesso" sozinhos são comuns em mensagens legítimas ("estou sem acesso ao sistema, registra…"):
// só contam quando o texto também PEDE dados.
const SEM_ACESSO = /\b(n[aã]o\s+(tenho|temos)|sem)\s+(acesso|autoriza[cç][aã]o|permiss[aã]o)\b/i;
const PEDE_DADOS = /\b(mostr\w*|dados|informa[cç][oõ]es|faturamento|relat[oó]rios?|financeir\w*)\b/i;
/** O texto pede dados fora do escopo do grupo? (determinístico, antes e independente da IA) */
export const pedidoForaDoEscopo = (texto) => {
  const t = String(texto ?? "");
  const [outra, explicita, concorrente] = PADROES_FORA_DO_ESCOPO;
  return explicita.test(t) || ((outra.test(t) || concorrente.test(t) || SEM_ACESSO.test(t)) && PEDE_DADOS.test(t));
};

/** Defesa final em toda resposta: mascara o que pareça CPF, CNPJ, conta, cartão, e-mail ou telefone. */
export function mascararDadosSensiveis(texto) {
  return String(texto ?? "")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[dado oculto]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[dado oculto]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[dado oculto]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[dado oculto]")
    .replace(/\+?\d{2}\s?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, "[dado oculto]");
}

// 15H (H-1, achado com WhatsApp real): saudação ou pergunta sobre o próprio MOVA é respondida SEM IA e SEM pedir unidade.
// Só quando o texto é CLARAMENTE conversa: casa um padrão de saudação/ajuda, não tem número e não tem NENHUMA palavra
// financeira (então "oi MOVA, quanto a alfa faturou?" continua indo para a IA). Na dúvida, não é saudação.
const FIM = "(?![\\p{L}\\p{N}])"; // fronteira que reconhece letras acentuadas (o \b do JS não reconhece "ê", "á")
const PADROES_SAUDACAO = [
  new RegExp(`^(oi+|ol[aá]+|bom dia|boa tarde|boa noite|e a[ií]|opa|hey|hello|tudo bem|tudo bom|salve)${FIM}`, "iu"),
  new RegExp(`(voc[eê]|vc)\\s+(est[aá]|t[aá])\\s+(funcionando|a[ií]|on|online|ativo)${FIM}`, "iu"),
  new RegExp(`(est[aá]|t[aá])\\s+(funcionando|on|online)${FIM}`, "iu"),
  new RegExp(`o\\s+que\\s+(voc[eê]|vc)\\s+(faz|pode\\s+fazer|sabe\\s+fazer)${FIM}`, "iu"),
  new RegExp(`(quem\\s+[eé]\\s+(voc[eê]|vc)|como\\s+(voc[eê]|vc)\\s+funciona|como\\s+funciona|me\\s+ajuda|^ajuda)${FIM}`, "iu"),
];
const PALAVRAS_FINANCEIRAS = /\b(pag\w*|boleto\w*|conta\w*|valor\w*|reais|real|r\$|fatur\w*|vend\w*|despes\w*|receit\w*|lan[cç]\w*|nota\w*|pix|saldo\w*|quanto\w*|gast\w*|cust\w*|compr\w*|caixa|dre|lucro\w*|recib\w*|comprovante\w*|fornecedor\w*|transfer\w*|venc\w*|cobr\w*|deposit\w*|extrato\w*|categoria\w*|competencia|compet[eê]ncia|proposta\w*|aprov\w*)\b/i;
/** O texto é SÓ saudação/pergunta sobre o MOVA (determinístico, antes da IA)? */
export const ehSaudacaoOuAjuda = (texto) => {
  const t = String(texto ?? "").trim();
  if (!t || t.length > 120 || /\d/.test(t) || PALAVRAS_FINANCEIRAS.test(t)) return false;
  return PADROES_SAUDACAO.some((r) => r.test(t.replace(/^\s*(mova)[\s,!.:-]*/i, "")) || r.test(t));
};
