// Textos de resposta do MOVA no grupo. Regras: nunca repetem o texto recebido (entrada não confiável), nunca mostram
// identificadores internos completos nem dados de outra unidade, e deixam claro que nada foi lançado — só proposto.

const reais = (c) => {
  const neg = c < 0; const a = Math.abs(c); const int = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${int},${String(a % 100).padStart(2, "0")}`;
};
const curto = (id) => String(id ?? "").slice(0, 8);
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "-");

export const RESPOSTA = Object.freeze({
  participanteSemVinculo: () => "Não consigo registrar a partir deste número: ele não está vinculado a um usuário com acesso ao Financeiro. Peça a um administrador.",
  semPermissao: (unidade) => `Seu usuário não tem permissão para esta operação no Financeiro de ${unidade}. Nada foi registrado.`,
  unidadeNaoIdentificada: (nomes) => `Não identifiquei a unidade deste documento. Responda a esta mensagem com o nome da unidade (${nomes.join(", ")}). Nada foi registrado.`,
  unidadeConflitante: () => "Encontrei indicações de unidades diferentes neste documento. Confirme a unidade respondendo a esta mensagem. Nada foi registrado.",
  documentoDeOutraUnidade: () => "O documento parece ser de outra unidade (ou de uma unidade que este grupo não atende). Confira e reenvie no lugar certo. Nada foi registrado.",
  operacaoBloqueada: () => "Não executo pagamentos, exclusões nem correções. Essas ações são feitas por uma pessoa autorizada, no Financeiro. Nada foi alterado.",
  falhaLeitura: () => "Não consegui ler este documento. Envie uma foto mais nítida ou o PDF original. Nada foi registrado.",
  duplicado: (propostaId) => `Este documento já foi recebido antes${propostaId ? ` (proposta ${curto(propostaId)})` : ""}. Não criei nada novo.`,
  obrigacaoJaExiste: (t) => `Já existe conta a pagar igual (${reais(t.valorOriginalCentavos)}, vencimento ${dataBr(t.vencimento)}). Não criei nada novo.`,
  competenciaFechada: (comp) => `A competência ${comp} está em fechamento ou fechada. Não proponho lançamentos nela; fale com o responsável pelo fechamento.`,
  faltaInformacao: (campos) => `Preciso de mais informação para seguir: ${campos.join(", ")}. Responda a esta mensagem. Nada foi registrado.`,
  variasObrigacoes: (n) => `Encontrei ${n} contas a pagar compatíveis com este comprovante. Diga qual foi paga respondendo a esta mensagem. Nada foi registrado.`,
  valorMaiorQueSaldo: () => "O valor do comprovante é maior que o saldo da conta a pagar encontrada. Confira (juros/multa?) — a decisão fica com o Financeiro. Nada foi registrado.",
  fonteOficial: (canais) => `Receita não é lançada pelo MOVA: cada canal tem fonte oficial (${canais}). Este documento fica só como evidência.`,
  fonteNaoConfirmada: () => "As fontes de faturamento desta unidade ainda não estão confirmadas no Financeiro. Nada foi registrado.",
  propostaBaixa: (p) => `Proposta ${curto(p.id)} criada para revisão: baixa ${p.parcial ? "PARCIAL " : ""}de ${reais(p.valorCentavos)} na conta a pagar existente (pagamento em ${dataBr(p.datas.caixa)}). Nada foi lançado ainda.`,
  propostaDespesaPaga: (p) => `Proposta ${curto(p.id)} criada para revisão: despesa paga de ${reais(p.valorCentavos)} (competência ${p.datas.competencia}, caixa em ${dataBr(p.datas.caixa)}). Não achei conta a pagar correspondente. Nada foi lançado ainda.`,
  propostaObrigacao: (p) => `Proposta ${curto(p.id)} criada para revisão: conta a pagar de ${reais(p.valorCentavos)} com vencimento ${dataBr(p.datas.vencimento)} (competência ${p.datas.competencia}). Nada foi lançado ainda.`,
  financeiroIndisponivel: () => "O Financeiro não respondeu agora. Tente novamente mais tarde; nada foi registrado.",
  consulta: (linhas) => linhas.join("\n"),
});

export { reais, dataBr };
