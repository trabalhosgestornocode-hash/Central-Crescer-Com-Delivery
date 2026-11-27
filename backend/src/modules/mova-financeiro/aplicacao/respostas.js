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

/**
 * 24/11 — RESUMO CONSOLIDADO da compra nova paga por comprovante: o que o MOVA entendeu e o que registra (ou propõe). Só dados da
 * leitura validada e do comando (descrição já mascarada), nunca o texto recebido cru. `x.intactas` = contas em aberto do mesmo
 * favorecido que NÃO foram baixadas (o comprovante foi tratado como compra nova).
 */
/** 25/11 — composição comprovada do pagamento (valor original, juros, multa, total) e vencimento impresso. */
const linhasDosEncargos = (p) => {
  const enc = p.comando?.encargos ?? (p.comando?.juros?.jurosCentavos !== undefined ? { principalCentavos: p.comando.juros.principalCentavos, jurosCentavos: p.comando.juros.jurosCentavos, multaCentavos: p.comando.juros.multaCentavos } : null);
  if (!enc) return [];
  return [`• Valor original ${reais(enc.principalCentavos)} · Juros ${reais(enc.jurosCentavos ?? 0)} · Multa ${reais(enc.multaCentavos ?? 0)} · Total pago ${reais(p.valorCentavos)}`,
    p.datas?.vencimento ? `• Vencimento ${dataBr(p.datas.vencimento)}` : null].filter(Boolean);
};
const linhasDaCompra = (p, x = {}) => {
  const e = p.comando?.entrada ?? {}; const l = p.leitura ?? {};
  const tx = l.idTransacao ? `, transação …${String(l.idTransacao).slice(-6)}` : "";
  const comp = p.datas?.competencia ? `${p.datas.competencia.slice(5, 7)}/${p.datas.competencia.slice(0, 4)}` : "a confirmar na revisão";
  return [
    x.descricao ? `• Descrição: ${String(x.descricao).slice(0, 60)}` : null, // só a descrição curta já filtrada pelo motor, nunca a legenda
    `• Pago em ${dataBr(p.datas?.caixa)}${l.instituicao ? ` (banco de origem: ${String(l.instituicao).slice(0, 40)})` : ""}${tx}`,
    l.favorecido ? `• Favorecido: ${String(l.favorecido).slice(0, 60)}` : null,
    x.unidade ? `• Unidade: ${String(x.unidade).slice(0, 60)}` : null,
    l.pagador ? `• Empresa (pagador): ${String(l.pagador).slice(0, 60)}` : null,
    `• Competência: ${comp} · Categoria: ${x.categoriaDefinida && e.categoria ? e.categoria : "a classificar na revisão"}`,
    ...linhasDosEncargos(p),
    ...(x.intactas ?? []).slice(0, 3).map((t) => `• Não mexi na conta em aberto de ${nomeDaConta(t)} (${reais(t.saldoCentavos)}).`),
  ].filter(Boolean).join("\n");
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
  // 25/11 — a política autorizou o registro automático, mas a execução não pôde acontecer: diz o motivo e como continuar pelo WhatsApp.
  semExecucaoAutomatica: (motivos = []) => {
    const tem = (re) => motivos.some((x) => re.test(x));
    const m = motivos.includes("SEM_IDENTIDADE_OPERACIONAL") ? "o registro automático ainda não está ativado neste ambiente"
      : motivos.includes("SEM_CONCESSAO_OPERACIONAL") ? "a permissão operacional do MOVA nesta unidade não cobre essa operação"
      : tem(/COFRE_INDISPONIVEL|DOCUMENTO_INDISPONIVEL/) ? "o armazenamento seguro do comprovante está temporariamente indisponível"
      : tem(/DOCUMENTO_INVALIDO|DOCUMENTO_ADULTERADO/) ? "o arquivo do comprovante não foi aceito pela verificação de segurança (formato inválido ou arquivo suspeito)"
      : tem(/COMPETENCIA/) ? "a competência dessa despesa está fechada ou indisponível"
      : tem(/CONFLITO|IDEMPOTENCIA/) ? "outro registro igual foi feito ao mesmo tempo (conferi para não duplicar)"
      : "o registro automático não pôde ser concluído agora";
    const guardado = tem(/DOCUMENTO_INVALIDO|DOCUMENTO_ADULTERADO/) ? "Nenhum pagamento foi registrado e a proposta foi preservada; envie um comprovante em PDF ou imagem legível." : "A proposta foi preservada e nenhum pagamento foi registrado.";
    return `Não consegui concluir o registro porque ${m}. ${guardado} Quando isso for resolvido, responda citando esta mensagem com "registrar" que eu continuo, sem novo comprovante.`;
  },
  // 26/11 — complementos de uma proposta (classificação, documentos da mesma compra)
  categoriaDefinida: (nome, descricao, seguePara) => `Classifiquei como "${nome}"${descricao ? ` (${descricao})` : ""}. ${seguePara}`,
  categoriaOpcoes: (opcoes) => `Qual destas categorias é a certa? Responda citando esta mensagem com o número:\n${opcoes.map((o, i) => `${i + 1}. ${o.nome}`).join("\n")}`,
  perguntaMesmaCompra: (valor, tipoDoc, favorecido, propostaId) => `Recebi ${tipoDoc ? `um documento (${tipoDoc.toLowerCase().replace(/_/g, " ")})` : "outro documento"} de ${reais(valor)}${favorecido ? ` (${String(favorecido).slice(0, 60)})` : ""}. Ele é da MESMA compra da proposta ${String(propostaId).slice(0, 8)}? Responda citando esta mensagem: "sim" anexa à proposta existente (não crio outra despesa); "não" trato como outra compra.`,
  mesmaCompraSemResposta: () => 'Não entendi. Este documento é da mesma compra? Responda "sim" ou "não" citando a pergunta; nada foi registrado.',
  documentoComplementarVinculado: (propostaId) => `Anexei o documento à proposta ${String(propostaId).slice(0, 8)}. Não criei outra despesa e nada novo foi lançado.`,
  propostaJaRegistrada: () => "Essa proposta já foi registrada. Não criei outro lançamento.",
  // 27/11 — "Confirmado" sobre uma proposta que SÓ o Centro Financeiro pode aprovar: diz qual (id, unidade, valor) e por quê. Nada é executado.
  propostaExigeAprovacao: ({ idCurto, unidade, valorCentavos, favorecido, motivos = [], duvida = null }) => {
    const tem = (re) => motivos.some((x) => re.test(x));
    const m = tem(/INCERTEZAS_NA_LEITURA|DOCUMENTO_INCONSISTENTE/) ? "a leitura do comprovante apontou uma dúvida" + (duvida ? ` (“${duvida}”)` : "") + ", e a política só deixa registrar sozinho quando o comprovante está sem dúvida"
      : tem(/SEM_IDENTIFICADOR/) ? "o comprovante não traz o identificador da transação"
      : tem(/NAO_E_COMPROVANTE/) ? "o documento enviado não é um comprovante de pagamento"
      : "a política desta unidade pede aprovação humana para essa proposta";
    return `A proposta ${idCurto} (${unidade}${favorecido ? ` · ${favorecido}` : ""} · ${reais(valorCentavos)}) continua aguardando aprovação no Centro Financeiro: ${m}. Por aqui eu não consigo aprovar nem executar essa proposta. Nada foi lançado; a proposta e o comprovante foram preservados.`;
  },
  qualProposta: (lista) => `Tenho ${lista.length} propostas aguardando confirmação. Responda citando a mensagem da proposta que você quer confirmar:\n${lista.map((p) => `• ${p.idCurto} — ${p.unidade} — ${reais(p.valorCentavos)}${p.favorecido ? ` — ${p.favorecido}` : ""}`).join("\n")}`,
  propostaNaoRetomavel: () => "Essa proposta não pode ser retomada por aqui (já decidida ou de outro tipo). Nada foi alterado.",
  pendenteUnidadeIncompleta: () => "Atenção: esta unidade ainda tem o cadastro financeiro incompleto; a proposta fica guardada e só poderá ser aplicada depois de completar o cadastro.",
  unidadeConflitante: () => "Encontrei indicações de unidades diferentes neste documento. Confirme a unidade respondendo a esta mensagem. Nada foi registrado.",
  documentoDeOutraUnidade: () => "O documento parece ser de outra unidade (ou de uma unidade que este grupo não atende). Confira e reenvie no lugar certo. Nada foi registrado.",
  // 27/11: loja da mesma empresa que existe no cadastro e não está habilitada no MOVA (texto aprovado pelo proprietário).
  unidadeNaoHabilitada: (nome, { documento = true } = {}) => documento
    ? `Identifiquei que este documento pertence à ${nome}. Essa unidade ainda não está habilitada no Financeiro do MOVA. Nenhum lançamento foi realizado.`
    : `A ${nome} ainda não está habilitada no Financeiro do MOVA. Nenhuma informação dela é consultada ou registrada por aqui.`,
  // 24/11: comprovante pago pela conta de uma unidade que esta conversa não atende (identificada pelo titular da conta pagadora).
  pagadorDeOutraUnidade: (nome) => `Este comprovante foi pago pela conta da ${nome}, que esta conversa não atende. Envie pelo canal autorizado da ${nome} ou peça ao administrador para liberar o acesso. Nada foi registrado.`,
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
  /** 24/11: a pessoa citou uma pergunta do MOVA que já passou da validade — nada é executado sem conferir de novo. */
  qualPendencia: (n) => `Há ${n} perguntas minhas aguardando resposta nesta conversa. Responda citando a pergunta certa, para eu não continuar a operação errada. Nada foi registrado.`,
  complementoSemPermissao: () => "Essa informação precisa vir de quem enviou o documento ou de alguém com perfil financeiro nessa empresa. Nada foi registrado.",
  confirmacaoDeOutroParticipante: () => "Essa pergunta é sobre um documento enviado por outra pessoa; só quem enviou ou alguém com perfil financeiro na(s) empresa(s) envolvida(s) pode responder. Nada foi registrado.",
  perguntaDesatualizada: (antes, agora, mudou = ["saldo"]) => `A conta mudou desde a minha pergunta (${mudou.length === 1 && mudou[0] === "saldo" && Number.isInteger(antes) ? `o saldo era ${reais(antes)} e agora é ${reais(agora)}` : `mudou: ${mudou.join(", ")}`}). Não continuo com uma resposta dada para outra situação: reenvie o comprovante que eu confiro de novo. Nada foi registrado.`,
  pendenciaExpirada: () => "Essa pergunta ficou sem resposta por muito tempo e eu não continuo operações antigas sem conferir de novo. Reenvie o documento (ou a informação) que eu refaço a conferência. Nada foi registrado.",
  // 24/11: diferença grande demais para ser juros da única conta do favorecido ⇒ a pergunta é se é uma COMPRA NOVA ("sim" = nova).
  perguntaCompraNovaOuConta: (t, valor) => `O comprovante é de ${reais(valor)} e a conta em aberto de ${nomeDaConta(t)} tem ${reais(t.saldoCentavos)}: a diferença (${reais(valor - t.saldoCentavos)}) é grande demais para ser juros. É uma compra nova, já paga? (Responda "sim" para eu registrar a compra nova paga, ou "é dessa conta" se for o pagamento dela.) Nada foi registrado.`,
  // 24/11: compra nova sem descrição nem categoria identificável: pergunta só o que falta.
  // 25/11: comprovante sem mês de referência — a única pergunta (o Financeiro não registra conta sem competência).
  perguntaCompetencia: (valor, favorecido) => `Recebi o comprovante de ${reais(valor)}${favorecido ? ` (${String(favorecido).slice(0, 60)})` : ""}. Qual é o mês de referência dessa conta? Nada foi registrado.`,
  naoEntendiCompetencia: () => "Não entendi o mês. Responda só o mês de referência (ex.: \"outubro\" ou \"11/2026\"), para eu continuar. Nada foi registrado.",
  perguntaDescricao: (valor) => `Recebi o comprovante de ${reais(valor)}. O que foi comprado? (Ex.: "brownies".) Com a descrição eu registro a compra paga e sugiro a categoria. Nada foi registrado.`,
  naoEntendiDescricao: () => "Não entendi o que foi comprado. Responda só a descrição (ex.: \"brownies\" ou \"embalagens\"), para eu continuar. Nada foi registrado.",
  naoEntendiDivergencia: () => "Não entendi a resposta. Responda \"sim\", \"não\", o número da conta ou \"outra compra\", para eu continuar. Nada foi registrado.",
  pagoComJuros: (p, r) => `Pagamento registrado por comprovante: ${reais(p.valorCentavos)} = conta de ${reais(r.principalCentavos)} + ${p.comando?.juros?.jurosCentavos !== undefined ? `juros de ${reais(p.comando.juros.jurosCentavos)} e multa de ${reais(p.comando.juros.multaCentavos ?? 0)}` : `juros de ${reais(r.encargoCentavos)}`} (juros e multas pagos a fornecedores). Conta já cadastrada: não criei outra. Situação: PAGO. Comprovante anexado. Conciliação bancária: pendente (o extrato ainda não confirma). Não criei segunda conta nem segundo pagamento.`,
  perguntaSemelhantePaga: (t) => `Já existe um pagamento de ${reais(t.valorOriginalCentavos)} para ${nomeDaConta(t)} registrado${t.vencimento ? ` (vencimento ${dataBr(t.vencimento)})` : ""}. Este comprovante é do mesmo pagamento? (Responda "sim" — não registro de novo —, ou "outra compra".) Nada foi registrado.`,
  perguntaSemelhanteAberta: (t) => `Encontrei a conta de ${nomeDaConta(t)} com ${reais(t.saldoCentavos)} pendentes, de outro fornecedor, com o mesmo valor deste comprovante. É essa conta que foi paga? (Responda "sim", ou "outra compra" se for uma compra nova.) Nada foi registrado.`,
  pagamentoJaRegistrado: (t) => `Este pagamento já está registrado: ${nomeDaConta(t)}, ${reais(t.valorOriginalCentavos)}. Não criei despesa, pagamento nem saída novos.`,
  jurosAguardandoFinanceiro: (p, t, juros) => `Anotado: conta de ${reais(t.saldoCentavos)} + juros de ${reais(juros)} = ${reais(p.valorCentavos)} (pedido ${curto(p.id)}). O pagamento com juros é aplicado pelo Financeiro na Central, com a diferença classificada como juros e multas; nada foi lançado ainda e não criei segunda conta.`,
  fonteOficial: (canais) => `Receita não é lançada pelo MOVA: cada canal tem fonte oficial (${canais}). Este documento fica só como evidência.`,
  fonteNaoConfirmada: () => "As fontes de faturamento desta unidade ainda não estão confirmadas no Financeiro. Nada foi registrado.",
  propostaBaixa: (p) => `Proposta ${curto(p.id)} criada para revisão: baixa ${p.parcial ? "PARCIAL " : ""}de ${reais(p.valorCentavos)} na conta a pagar existente (pagamento em ${dataBr(p.datas.caixa)}). Nada foi lançado ainda.`,
  propostaDespesaPaga: (p, x = {}) => `Proposta ${curto(p.id)} criada para revisão: compra nova já paga de ${reais(p.valorCentavos)} (competência ${p.datas.competencia ?? "a confirmar"}, caixa em ${dataBr(p.datas.caixa)}).${p.comando?.entrada ? `\n${linhasDaCompra(p, x)}\n` : " "}Ao confirmar no Centro Financeiro, a conta e o pagamento entram juntos (uma despesa, uma baixa). Nada foi lançado ainda.`,
  // 24/11: boleto/nota → Contas a Pagar e nota vinculada à conta existente.
  contaRegistrada: (p, r) => `Conta a pagar registrada: ${reais(p.valorCentavos)}${r?.favorecido ? ` para ${r.favorecido}` : ""}, vencimento ${dataBr(r?.vencimento ?? p.datas?.vencimento)} (competência ${r?.competencia ?? p.datas?.competencia}). Documento anexado; a conta está em aberto no Contas a Pagar e no calendário.${r?.contaCriada === false ? " (Já existia: reaproveitada.)" : ""}`,
  notaParaVincular: (p, t) => `Esta nota é da conta a pagar já registrada (${reais(t.valorOriginalCentavos)}, vencimento ${dataBr(t.vencimento)}). Proposta ${curto(p.id)}: anexar a nota a essa conta, sem lançar nada novo.`,
  notaVinculada: (t) => `Nota anexada à conta a pagar já registrada (${reais(t.valorOriginalCentavos)}, vencimento ${dataBr(t.vencimento)}). Nenhuma despesa nova.`,
  notaComVariasContas: (p) => `Esta nota combina com mais de uma conta a pagar. Encaminhei para conferência (proposta ${curto(p.id)}); nada foi lançado.`,
  // 26/11 — CONTA RELATADA POR TEXTO (sem documento)
  contaRelatadaValorAmbiguo: (c) => `O valor de ${reais(c.valorCitadoCentavos)} é de CADA parcela (total ${reais(c.valorCitadoCentavos * c.quantidade)}) ou é o TOTAL da compra (${c.quantidade} parcelas somando ${reais(c.valorCitadoCentavos)})? Responda "cada parcela" ou "total". Nada foi registrado.`,
  // 27/11: classificação pelo plano de contas — nunca imobilizado automático; "0" deixa para o Centro Financeiro.
  contaRelatadaCategoria: ({ opcoes = [], motivo, sugestaoDeCriacao = null, descricao = null }) => [
    motivo === "CATEGORIA_DITA_FORA_DO_PLANO" && sugestaoDeCriacao ? `A categoria "${sugestaoDeCriacao}" não existe no plano de contas desta unidade.`
      : motivo === "EQUIPAMENTO_EXIGE_CLASSIFICACAO" ? `${descricao ? `"${descricao}" parece` : "Parece"} compra de equipamento: a classificação (despesa ou imobilizado) precisa ser escolhida por vocês.`
        : "Não encontrei uma categoria segura no plano de contas para esta conta.",
    "Em qual categoria registro?",
    ...opcoes.map((o, i) => `${i + 1} — ${o.nome}`),
    `0 — deixar para classificar no Centro Financeiro${sugestaoDeCriacao ? ` (com a sugestão de criar "${sugestaoDeCriacao}")` : ""}`,
    "Responda com o número. Nada foi registrado ainda.",
  ].join("\n"),
  contaRelatadaResumo: (c, { unidade, categoriaNome, avisoFatura, sugestaoDeCriacao = null }) => [
    `Confere antes de eu registrar (${unidade}):`,
    `• ${c.descricao}${c.fornecedor ? ` — fornecedor ${c.fornecedor}` : " — fornecedor não informado"}`,
    `• Categoria: ${categoriaNome ?? `a classificar no Centro Financeiro${sugestaoDeCriacao ? ` (sugestão: criar "${sugestaoDeCriacao}")` : ""}`}`,
    `• Competência: ${c.competencia.slice(5)}/${c.competencia.slice(0, 4)}${c.forma ? ` • Forma: ${{ CARTAO: "cartão", BOLETO: "boleto", PIX: "Pix", DINHEIRO: "dinheiro", TRANSFERENCIA: "transferência" }[c.forma]}` : ""}`,
    ...c.parcelas.map((p) => `• ${p.numero}/${p.total}: vence ${dataBr(p.vencimento)} — ${reais(p.valorCentavos)}`),
    `• Total: ${reais(c.totalCentavos)} — situação: A PAGAR`,
    ...(avisoFatura ? [avisoFatura] : []),
    `Responda "sim" para registrar ou "não" para cancelar. Nada foi registrado ainda.`,
  ].join("\n"),
  contaRelatadaCancelada: () => "Ok, não registrei essa conta. Nada foi lançado.",
  contaRelatadaRegistrada: (c, r) => `Conta a pagar registrada (em aberto): ${c.descricao}, ${c.parcelas.length} parcela${c.parcelas.length > 1 ? "s" : ""}, total ${reais(c.totalCentavos)}; primeiro vencimento ${dataBr(c.parcelas[0].vencimento)}. Aparece no Contas a Pagar e no calendário.${r?.contaCriada === false ? " (Já existia: reaproveitada.)" : ""}`,
  contaRelatadaProposta: (p, c, { aClassificar = false } = {}) => `Proposta ${curto(p.id)} criada para ${aClassificar ? "classificação e aprovação" : "aprovação"} no Centro Financeiro: ${c.descricao}, ${c.parcelas.length} parcela${c.parcelas.length > 1 ? "s" : ""}, total ${reais(c.totalCentavos)}. Nada foi lançado ainda.`,
  contaRelatadaFaturaDoCartao: (f) => `⚠ Já existe fatura do cartão em aberto com vencimento ${dataBr(f.vencimento)} (${reais(f.saldoCentavos ?? f.valorOriginalCentavos)}). Se esta compra já está nessa fatura, responda "não" para não contar duas vezes.`,
  // 26/11 — operação entre empresas (uma empresa do grupo pagou pela outra). Texto da pergunta conforme o pedido do proprietário.
  entreEmpresasPergunta: ({ credora, devedora, valorCentavos, existente, varias, porValor = false, favorecido = null }) => `Identifiquei que a ${credora} realizou um pagamento de ${reais(valorCentavos)} referente ao ${devedora}. Confirma que devo registrar a despesa no ${devedora} e o valor como uma dívida do ${devedora} com a ${credora}?`
    + (existente ? `\nConta encontrada no ${devedora}: ${existente.fornecedor?.nome ?? "fornecedor não informado"} — ${existente.descricao ?? "sem descrição"} (vencimento ${dataBr(existente.vencimento)}, valor ${reais(existente.saldoCentavos ?? valorCentavos)}); ela ficará paga pela ${credora}, sem criar conta nova.${porValor ? ` O comprovante mostra o favorecido "${String(favorecido ?? "não informado").slice(0, 60)}", que não é o nome do fornecedor; escolhi esta conta por ser a ÚNICA em aberto com esse valor. Responda sim SOMENTE se é esta a conta que foi paga; nada será registrado sem esse sim.` : ""}`
      : varias ? `\nHá mais de uma conta em aberto com esse valor no ${devedora}: a escolha fica para a revisão no Centro Financeiro.`
        : `\nNão encontrei conta em aberto com esse valor no ${devedora}: será proposta uma conta nova, já paga pela ${credora}.`)
    + "\nResponda sim ou não. Nada foi registrado ainda.",
  entreEmpresasRecusada: () => "Entendido: não registrei nada como operação entre empresas.",
  entreEmpresasSemPermissao: (devedora, credora) => `Para registrar um pagamento entre empresas é preciso permissão financeira nas duas: ${devedora} e ${credora}. Nada foi registrado.`,
  entreEmpresasRegistrada: ({ devedora, credora, valorCentavos }) => `Registrado: a conta do ${devedora} (${reais(valorCentavos)}) ficou paga pela ${credora}, e o ${devedora} passa a dever esse valor à ${credora} (Contas entre Empresas). Nenhuma saída nova foi lançada; o reembolso é registrado quando acontecer.`,
  entreEmpresasProposta: (p, { devedora, credora }) => `Proposta ${curto(p.id)} criada para aprovação no Centro Financeiro: despesa de ${reais(p.valorCentavos)} no ${devedora}, paga pela ${credora}, e o mesmo valor como dívida do ${devedora} com a ${credora}. Nada foi lançado ainda (a aplicação exige permissão nas duas empresas).`,
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
  baixaExecutada: (p, r) => `Baixa registrada no Financeiro: ${reais(p.valorCentavos)}${r?.parcial ? " (pagamento parcial)" : ""} na conta a pagar, conferida com a saída do extrato de ${dataBr(r?.dataSaida)}. Registrei os dados do comprovante (valor, data, identificador e verificação do arquivo); o arquivo em si não é guardado. Se houver erro, um responsável desfaz pelo Centro Financeiro.`,
  baixaConferida: (p) => `Proposta ${curto(p.id)}: baixa de ${reais(p.valorCentavos)} conferida com a saída do extrato. Falta a confirmação de um responsável no Centro Financeiro. Nada foi lançado ainda.`,
  // Execução 17 — situações separadas: PAGO POR COMPROVANTE (conciliação bancária pendente) nunca é "conciliado".
  pagoPorComprovante: (p, r) => `Pagamento registrado por comprovante: ${reais(p.valorCentavos)}${r?.parcial ? " (pagamento parcial)" : ""} na conta a pagar (pago em ${dataBr(r?.dataPagamento ?? p.datas?.caixa)}). Situação: pago por comprovante. Conciliação bancária: pendente — confiro quando o extrato for importado. Registrei os dados do comprovante (valor, data, identificador e verificação do arquivo); o arquivo em si não é guardado. Se houver erro, um responsável desfaz pelo Centro Financeiro.`,
  // 23/11 — despesa SEM conta prévia: a conta foi registrada e paga por comprovante na mesma rotina.
  despesaPagaPorComprovante: (p, r, x = {}) => `Despesa registrada e paga por comprovante: ${reais(p.valorCentavos)} (pago em ${dataBr(r?.dataPagamento ?? p.datas?.caixa)}). Uma despesa e uma baixa, juntas${r?.despesaCriada === false ? " (já existia, reaproveitada)" : " (não havia conta cadastrada: conta nova criada)"}.\n${linhasDaCompra(p, x)}\nSituação: PAGO.${r?.encargoCentavos ? " Encargos lançados em juros e multas pagos a fornecedores (não na despesa)." : ""}\nConciliação bancária: pendente — confiro quando o extrato for importado. Registrei os dados do comprovante (valor, data, identificador e verificação do arquivo); o arquivo em si não é guardado. Se houver erro, um responsável desfaz pelo Centro Financeiro.`,
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
