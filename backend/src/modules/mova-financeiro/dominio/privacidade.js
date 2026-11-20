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

/** Defesa final em toda resposta: mascara o que pareça CPF, CNPJ, conta, cartão, e-mail ou telefone. */
export function mascararDadosSensiveis(texto) {
  return String(texto ?? "")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[dado oculto]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[dado oculto]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[dado oculto]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[dado oculto]")
    .replace(/\+?\d{2}\s?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, "[dado oculto]");
}
