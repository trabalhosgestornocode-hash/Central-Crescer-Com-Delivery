// Textos de resposta do MOVA no grupo. Regras: nunca repetem o texto recebido (entrada não confiável), nunca mostram
// identificadores internos completos nem dados de outra unidade, e deixam claro que nada foi lançado — só proposto.

const reais = (c) => {
  const neg = c < 0; const a = Math.abs(c); const int = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${int},${String(a % 100).padStart(2, "0")}`;
};
const curto = (id) => String(id ?? "").slice(0, 8);
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "-");
/** Como a conta é citada na pergunta: a descrição (curta) e, quando há, o fornecedor. Dado do Financeiro, não texto do remetente. */
const nomeDaConta = (t) => {
  const d = String(t?.descricao ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const f = String(t?.fornecedor?.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return d && f ? `${d} (${f})` : d || f || "fornecedor a identificar";
};

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
  // Falhas TÉCNICAS de leitura (não dizem que a foto é ruim): cada causa com sua orientação.
  falhaTecnicaDeLeitura: () => "Recebi o documento, mas a leitura automática teve um problema técnico agora (o documento não está ilegível). Reenvie em alguns minutos ou envie ao Financeiro. Nada foi registrado.",
  documentoPesadoParaLeitura: () => "Este arquivo é grande ou complexo demais para a leitura automática. Envie uma foto menor ou o PDF original. Nada foi registrado.",
  documentoNaoIdentificado: () => "Li o arquivo, mas não consegui identificar os dados com segurança. Ele não foi lançado: envie ao Financeiro para conferência. Nada foi registrado.",
  duplicado: (propostaId) => `Este documento já foi recebido antes${propostaId ? ` (proposta ${curto(propostaId)})` : ""}. Não criei nada novo.`,
  obrigacaoJaExiste: (t) => `Já existe conta a pagar igual (${reais(t.valorOriginalCentavos)}, vencimento ${dataBr(t.vencimento)}). Não criei nada novo.`,
  competenciaFechada: (comp) => `A competência ${comp} está em fechamento ou fechada. Não proponho lançamentos nela; fale com o responsável pelo fechamento.`,
  faltaInformacao: (campos) => `Preciso de mais informação para seguir: ${campos.join(", ")}. Responda a esta mensagem. Nada foi registrado.`,
  variasObrigacoes: (n) => `Encontrei ${n} contas a pagar compatíveis com este comprovante. Diga qual foi paga respondendo a esta mensagem. Nada foi registrado.`,
  valorMaiorQueSaldo: () => "O valor do comprovante é maior que o saldo da conta a pagar encontrada. Confira (juros/multa?) — a decisão fica com o Financeiro. Nada foi registrado.",
  // 23/11 — MOVA financeiro autônomo: perguntas OBJETIVAS de divergência (uma só pergunta; a resposta continua a operação).
  perguntaValorMaior: (t, valor) => `Encontrei a conta de ${nomeDaConta(t)} com ${reais(t.saldoCentavos)} pendentes. O comprovante é de ${reais(valor)}. Os ${reais(valor - t.saldoCentavos)} de diferença são juros dessa conta? (Responda "sim", ou "outra compra" se este comprovante não é dessa conta.) Nada foi registrado.`,
  perguntaValorMenor: (t, valor) => `Encontrei a conta de ${nomeDaConta(t)} com ${reais(t.saldoCentavos)} pendentes. O comprovante é de ${reais(valor)}, menor que o saldo. É pagamento parcial (restam ${reais(t.saldoCentavos - valor)} em aberto)? (Responda "sim", ou "outra compra" se não é dessa conta.) Nada foi registrado.`,
  perguntaVariasContas: (cands) => `Encontrei ${cands.length} contas que podem ser esta:\n${cands.map((t, i) => `${i + 1}) ${nomeDaConta(t)} — ${reais(t.saldoCentavos)} pendentes${t.vencimento ? `, vence ${dataBr(t.vencimento)}` : ""}`).join("\n")}\nResponda o número da conta, ou "outra compra" se for uma compra nova. Nada foi registrado.`,
  naoEntendiDivergencia: () => "Não entendi a resposta. Responda \"sim\", \"não\", o número da conta ou \"outra compra\", para eu continuar. Nada foi registrado.",
  pagoComJuros: (p, r) => `Pagamento registrado por comprovante: ${reais(p.valorCentavos)} = conta de ${reais(r.principalCentavos)} + juros de ${reais(r.encargoCentavos)}. Comprovante anexado. Conciliação bancária: pendente (o extrato ainda não confirma). Não criei segunda conta nem segundo pagamento.`,
  perguntaSemelhantePaga: (t) => `Já existe um pagamento de ${reais(t.valorOriginalCentavos)} para ${nomeDaConta(t)} registrado${t.vencimento ? ` (vencimento ${dataBr(t.vencimento)})` : ""}. Este comprovante é do mesmo pagamento? (Responda "sim" — não registro de novo —, ou "outra compra".) Nada foi registrado.`,
  perguntaSemelhanteAberta: (t) => `Encontrei a conta de ${nomeDaConta(t)} com ${reais(t.saldoCentavos)} pendentes, de outro fornecedor, com o mesmo valor deste comprovante. É essa conta que foi paga? (Responda "sim", ou "outra compra" se for uma compra nova.) Nada foi registrado.`,
  pagamentoJaRegistrado: (t) => `Este pagamento já está registrado: ${nomeDaConta(t)}, ${reais(t.valorOriginalCentavos)}. Não criei despesa, pagamento nem saída novos.`,
  jurosAguardandoFinanceiro: (p, t, juros) => `Anotado: conta de ${reais(t.saldoCentavos)} + juros de ${reais(juros)} = ${reais(p.valorCentavos)} (pedido ${curto(p.id)}). O pagamento com juros é aplicado pelo Financeiro na Central, com a diferença classificada como juros e multas; nada foi lançado ainda e não criei segunda conta.`,
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
  documentoNoPrivado: () => "Recebi o documento. Os detalhes, com valores, foram para o seu privado.",
  documentoSemPrivado: () => "Recebi o documento e preparei para revisão no Centro Financeiro. Os valores não aparecem no grupo.",
  // Agente 2 — Frente C: baixa pelo extrato (nunca pagamento bancário; a saída já estava no extrato).
  baixaExecutada: (p, r) => `Baixa registrada no Financeiro: ${reais(p.valorCentavos)}${r?.parcial ? " (pagamento parcial)" : ""} na conta a pagar, conferida com a saída do extrato de ${dataBr(r?.dataSaida)}. O comprovante ficou anexado. Se houver erro, um responsável desfaz pelo Centro Financeiro.`,
  baixaConferida: (p) => `Proposta ${curto(p.id)}: baixa de ${reais(p.valorCentavos)} conferida com a saída do extrato. Falta a confirmação de um responsável no Centro Financeiro. Nada foi lançado ainda.`,
  // Execução 17 — situações separadas: PAGO POR COMPROVANTE (conciliação bancária pendente) nunca é "conciliado".
  pagoPorComprovante: (p, r) => `Pagamento registrado por comprovante: ${reais(p.valorCentavos)}${r?.parcial ? " (pagamento parcial)" : ""} na conta a pagar (pago em ${dataBr(r?.dataPagamento ?? p.datas?.caixa)}). Situação: pago por comprovante. Conciliação bancária: pendente — confiro quando o extrato for importado. O comprovante ficou anexado. Se houver erro, um responsável desfaz pelo Centro Financeiro.`,
  // 23/11 — despesa SEM conta prévia: a conta foi registrada e paga por comprovante na mesma rotina.
  despesaPagaPorComprovante: (p, r) => `Despesa registrada e paga por comprovante: ${reais(p.valorCentavos)} (pago em ${dataBr(r?.dataPagamento ?? p.datas?.caixa)}). Conta a pagar nova${r?.despesaCriada === false ? " (já existia, reaproveitada)" : ""}, categoria a classificar na revisão. Conciliação bancária: pendente — confiro quando o extrato for importado. O comprovante ficou anexado. Se houver erro, um responsável desfaz pelo Centro Financeiro.`,
  comprovanteAguardandoConfirmacao: (p) => `Proposta ${curto(p.id)}: comprovante de ${reais(p.valorCentavos)} conferido (transação concluída). Falta a confirmação de um responsável para registrar como pago por comprovante; a conciliação bancária ficará pendente até o extrato. Nada foi lançado ainda.`,
  comprovanteEmRevisao: (situacao) => `O comprovante ficou para conferência humana (${({ DOCUMENTO_INCONSISTENTE: "dados incompletos ou incertos na leitura", DOCUMENTO_ILEGIVEL: "documento ilegível", DOCUMENTO_SUSPEITO: "arquivo com sinais de alteração", COMPROVANTE_DUPLICADO: "comprovante já recebido" })[situacao] ?? "não deu para confirmar a conclusão da transação"}).`,
  comprovanteNaoConcluido: (situacao) => ({
    PIX_AGENDADO: "Este comprovante é de um AGENDAMENTO, não de um pagamento concluído. Nada foi registrado como pago. Envie o comprovante quando o pagamento for efetivado.",
    TRANSFERENCIA_PENDENTE: "A transferência deste comprovante ainda está PENDENTE (em processamento). Nada foi registrado como pago. Envie o comprovante quando ela for concluída.",
    TRANSACAO_CANCELADA: "Este comprovante mostra uma transação CANCELADA. Nada foi registrado como pago.",
  })[situacao] ?? "Não deu para confirmar que o pagamento foi concluído. Nada foi registrado como pago.",
  extratoAmbiguo: () => "Há mais de uma saída no extrato com esse valor e data; a escolha fica com o financeiro.",
  aguardandoExtrato: () => "Ainda não achei a saída correspondente no extrato; confiro de novo quando o extrato for importado.",
  grupoOperacional: () => "Este grupo é operacional: aqui eu trato documentos e pendências, sem valores financeiros. Para valores, use a conversa privada com o MOVA ou o Centro Financeiro. Nada foi consultado.",
  perfilSemConsulta: () => "Seu acesso ao MOVA não inclui consultas com valores. Fale com o administrador financeiro. Nada foi consultado.",
});

export { reais, dataBr };
