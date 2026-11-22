// Textos de resposta do MOVA no grupo. Regras: nunca repetem o texto recebido (entrada não confiável), nunca mostram
// identificadores internos completos nem dados de outra unidade, e deixam claro que nada foi lançado — só proposto.

const reais = (c) => {
  const neg = c < 0; const a = Math.abs(c); const int = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${int},${String(a % 100).padStart(2, "0")}`;
};
const curto = (id) => String(id ?? "").slice(0, 8);
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "-");

export const RESPOSTA = Object.freeze({
  /** Pergunta padrão definida pelo proprietário (Execução 02). Responder a esta mensagem retoma o documento. */
  unidadeNaoIdentificada: (nomes) => `Esse lançamento pertence à ${nomes.length > 1 ? `${nomes.slice(0, -1).join(", ")} ou ${nomes.at(-1)}` : nomes[0]}?`,
  /** Execução 13B: conversa sem pedido financeiro (saudação etc.) — não pergunta unidade nem cria nada. */
  // 16A — piloto de consultas: o MOVA só lê; lançamentos e documentos continuam no Centro Financeiro.
  conversaPiloto: () => "Olá! Sou o MOVA, assistente financeiro. Neste piloto eu respondo consultas: faturamento (total e por canal), despesas e custos da competência, contas a pagar e a receber, vencimentos, fluxo de caixa e pendências de conferência. Os números vêm do Financeiro, com a fonte e a situação de cada um. Nada é registrado por aqui.",
  iaPausada: () => "As consultas pelo WhatsApp estão pausadas neste momento. Não precisa reenviar: os números continuam no Centro Financeiro. Nada foi registrado.",
  pilotoSomenteConsultas: () => "Neste piloto eu só respondo consultas (faturamento, contas, vencimentos, fluxo de caixa e pendências). Lançamentos, comprovantes e documentos continuam pelo Centro Financeiro. Nada foi registrado.",
  conversaSemPedido: () => "Olá! Sou o MOVA, assistente financeiro. Envie um comprovante, boleto ou nota (ou descreva o pagamento com valor e unidade) que eu preparo a proposta para revisão, ou pergunte sobre contas e faturamento. Nada foi registrado.",
  aprovacaoSoNoDashboard: () => "Aprovar, corrigir ou aplicar lançamentos é feito por um administrador financeiro no Centro Financeiro (com login). Pelo grupo eu só registro propostas.",
  foraDoEscopo: () => "Só trato dados das unidades atendidas por esta conversa. Não compartilho informações de outras empresas ou unidades. Nada foi consultado.",
  pedidoNaoAtendido: () => "Não posso atender esse pedido por aqui. Se for uma consulta das suas unidades, reformule com a unidade e o período. Nada foi registrado.",
  dadoRestrito: () => "Essa informação é restrita e não é compartilhada no grupo. Consulte o Centro Financeiro com seu login.",
  transferenciaInterna: () => "Isso parece uma transferência entre contas da própria empresa: não é despesa. Ela será reconhecida pelo extrato bancário, na conciliação. Nada foi registrado.",
  solicitacaoRevisao: (p) => `Pedido ${curto(p.id)} registrado para o administrador financeiro revisar. Nada foi alterado.`,
  dadosInsuficientes: (o) => `Ainda não há dados suficientes registrados no Financeiro para responder sobre ${o}. Não vou estimar.`,
  pendenteUnidadeIncompleta: () => "Atenção: esta unidade ainda tem o cadastro financeiro incompleto; a proposta fica guardada e só poderá ser aplicada depois de completar o cadastro.",
  unidadeConflitante: () => "Encontrei indicações de unidades diferentes neste documento. Confirme a unidade respondendo a esta mensagem. Nada foi registrado.",
  documentoDeOutraUnidade: () => "O documento parece ser de outra unidade (ou de uma unidade que este grupo não atende). Confira e reenvie no lugar certo. Nada foi registrado.",
  operacaoBloqueada: () => "Não executo pagamentos bancários nem exclusões. Essas ações são feitas por uma pessoa autorizada, no Financeiro. Nada foi alterado.",
  audioSemTranscricao: () => "Ainda não consigo ouvir áudios aqui. Mande a informação por texto ou foto do documento. Nada foi registrado.",
  relatoRepetido: (propostaId) => `Já existe uma proposta igual aguardando revisão (${curto(propostaId)}). Não criei outra. Se for um novo lançamento, diga o que muda (data ou valor).`,
  falhaInterpretacao: () => "Não consegui interpretar a mensagem agora. Reenvie com o valor, a unidade e o que aconteceu, em uma frase curta. Nada foi registrado.",
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
  bancoIndisponivel: () => "Estou com instabilidade para registrar agora. Reenvie a mensagem em alguns minutos; nada foi registrado.",
  consulta: (linhas) => linhas.join("\n"),
  // Agente 2 — grupos reais (confidencialidade e perfil).
  respondidoNoPrivado: () => "Te respondi no privado (essa consulta tem valores e não aparece no grupo).",
  semConversaPrivada: () => "Essa consulta tem valores e não aparece no grupo. Peça ao administrador para cadastrar seu número para respostas no privado.",
  perfilSemDocumentos: () => "Seu acesso ao MOVA é só de consultas: documentos e lançamentos são enviados por quem cuida do financeiro da unidade. Nada foi registrado.",
  grupoOperacional: () => "Este grupo é operacional: aqui eu trato documentos e pendências, sem valores financeiros. Para valores, use a conversa privada com o MOVA ou o Centro Financeiro. Nada foi consultado.",
  perfilSemConsulta: () => "Seu acesso ao MOVA não inclui consultas com valores. Fale com o administrador financeiro. Nada foi consultado.",
});

export { reais, dataBr };
