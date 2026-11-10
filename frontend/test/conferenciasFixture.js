// Fixture da Central de Conferências com a ESTRUTURA de setembro/2026 (o formato exato que GET /conferencias e GET /pendencias-documentais
// devolvem). Valores citados nos documentos do mês: ajuste iFood 788,15; pagamento da sócia 6.633,60; pagamento 80,00; 5 rateios;
// 11 transferências (5 de 1:1 e 6 de 1:N); 8 lançamentos sem classificação; 5 sugestões documentais. O resto é SINTÉTICO (nomes neutros —
// repositório público). Nada aqui toca produção.
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONTAS = [{ id: U(901), nome: "STONE" }, { id: U(902), nome: "UNICRED" }, { id: U(903), nome: "CAIXA LOJA" }];
const mov = (n, data, conta, valor, descricao) => ({ id: U(n), data, conta, valorCentavos: valor, descricao });

const um = [1, 2, 3, 4, 5].map((i) => {
  const v = 100000 + i * 12345, d = `2026-09-${String(2 + i * 4).padStart(2, "0")}`;
  return { saida: mov(100 + i, d, "STONE", v, `TRANSF STONE → UNICRED ${i}`), status: "um_para_um", contrapartidas: [mov(200 + i, d, "UNICRED", v, `CRED STONE ${i}`)], alternativas: [],
    vincular: { caminho: "/transferencias/vincular", corpo: { saidaId: U(100 + i), entradaId: U(200 + i) } }, vincularMultipla: null };
});
const varios = [1, 2, 3, 4, 5, 6].map((i) => {
  const partes = [70000 + i * 1000, 50000 + i * 500, 30000], v = partes.reduce((a, b) => a + b, 0), d = `2026-09-${String(3 + i * 4).padStart(2, "0")}`;
  return { saida: mov(300 + i, d, "STONE", v, `TRANSF STONE LOTE ${i}`), status: "um_para_varios", contrapartidas: partes.map((p, k) => mov(400 + i * 10 + k, d, "UNICRED", p, `CRED STONE ${i}.${k + 1}`)), alternativas: [],
    vincular: null, vincularMultipla: { caminho: "/transferencias/vincular-multipla", corpo: { saidaId: U(300 + i), entradaIds: partes.map((_, k) => U(400 + i * 10 + k)) }, exigeJustificativa: true } };
});
const rateio = (i, desc, forn, valor) => ({ id: U(500 + i), obrigacao: desc, fornecedor: forn, categoria: "INSUMOS", competenciaObrigacao: "2026-08-01", valorOriginalCentavos: valor, valorElegivelCentavos: valor,
  criterio: i % 2 ? "producao" : "dias_consumo", justificativa: "A compra abastece a produção dos dois meses.", evidencia: i === 1 ? "Nota fiscal e planilha de produção" : null,
  parcelas: [{ competencia: "2026-08-01", valorCentavos: Math.round(valor * 0.4) }, { competencia: "2026-09-01", valorCentavos: valor - Math.round(valor * 0.4) }], caminhoAprovar: `/rateios/${U(500 + i)}/aprovar` });

const pend = (x) => ({ gravidade: "atencao", ...x });
export const CENTRAL_SETEMBRO = {
  mes: "2026-09",
  geral: [{ id: "metodologia", tipo: "metodologia", titulo: "Metodologia gerencial ainda não aprovada pela contadora", descricao: "Regras na versão 1. Os valores são calculados dos registros e nada foi ajustado para coincidir com a apresentação.", geral: true }],
  pendencias: [
    pend({ id: `ajuste:${U(1)}`, tipo: "ajuste_vendas", titulo: "Ajuste de vendas estimado — iFood", descricao: "Taxa de entrega e descontos do iFood (estimado). Leva o total do painel à base da DRE; ainda não foi confirmado.", motivo: "Taxa de entrega e descontos do iFood (estimado). Leva o total do painel à base da DRE.",
      valorCentavos: -78815, canal: "iFood", data: null, refs: [U(1)], evidencias: [], status: "estimado", statusRotulo: "Estimado", responsavel: "Contadora (iFood: com o Portal do Parceiro)",
      evidenciaNecessaria: "Relatório do canal com taxa de entrega e descontos do mesmo período e dos mesmos pedidos; a soma deve fechar com o ajuste.",
      checklist: { onde: "Portal do Parceiro iFood → relatórios de 01/09/2026 a 30/09/2026 (pedidos concluídos)", precisaInformar: ["Quantidade de pedidos concluídos no mês (conferir com os 801 do relatório de vendas).", "Valor bruto dos itens vendidos.", "Total da taxa de entrega.", "Total de descontos/cupons."],
        conta: "Painel (R$ 31.540,18) − base da DRE (R$ 30.752,03) = R$ 788,15.", comoConfirmar: "Escreva o nome do relatório, o período e os valores.", situacao: "estimado, a confirmar no Portal do Parceiro" },
      acao: { tipo: "confirmar_ajuste", rotulo: "Confirmar com evidência", metodo: "POST", caminho: `/vendas-ajustes/${U(1)}/confirmar`, exige: ["evidencia"], permissao: "classificar" } }),
    pend({ id: "rateios", tipo: "rateios", titulo: "Rateios propostos (5) — aprovação da contadora", descricao: "Distribuem o custo de compras e entregas entre competências.", motivo: "Distribuem o custo de compras e entregas entre competências.",
      valorCentavos: 900000, data: null, refs: [1, 2, 3, 4, 5].map((i) => U(500 + i)), status: "pendente", responsavel: "Contadora", evidenciaNecessaria: "Critério e documento de cada rateio.",
      itens: [rateio(1, "Compra de insumos A", "Fornecedor 1", 250000), rateio(2, "Compra de insumos B", "Fornecedor 2", 180000), rateio(3, "Entrega de embalagens", "Fornecedor 3", 120000), rateio(4, "Compra de insumos C", "Fornecedor 1", 210000), rateio(5, "Entrega de polpa", "Fornecedor 4", 140000)],
      acao: { tipo: "aprovar_rateios", rotulo: "Revisar e aprovar", metodo: "TELA", permissao: "classificar" } }),
    pend({ id: `juros:${U(600)}`, tipo: "juros_presumido", titulo: "Acréscimo presumido — Boleto fornecedor 5", descricao: "Pago R$ 1.030,00 sobre original R$ 1.000,00 (+3,00%), em 15/09. Presumido até alguém classificar. A conta ainda não está quitada: quitar e classificar são a mesma decisão.",
      motivo: "Pago R$ 1.030,00 sobre original R$ 1.000,00.", valorCentavos: 3000, data: "2026-09-15", vencimento: "2026-09-10", obrigacaoId: U(600), quitada: false, refs: [U(600)], status: "pendente", responsavel: "Contadora",
      evidenciaNecessaria: "Boleto, extrato ou nota que mostre juros/multa sobre o valor original da conta.",
      etapas: { quitar: { caminho: `/contas-pagar/${U(600)}/quitar`, permissao: "conciliar" }, classificar: { caminho: `/contas-pagar/${U(600)}/classificar`, permissao: "classificar", disponivel: false } },
      sugestao: { natureza: "juros", evidencia: "Apresentação da contadora 09/2026, slide 6.", motivo: "Juros por pagamento em atraso." },
      acao: { tipo: "classificar_acrescimo", rotulo: "Aprovar: quitar e classificar como juros", metodo: "POST", caminho: `/contas-pagar/${U(600)}/quitar-e-classificar`, exige: ["natureza", "motivo"], permissao: "classificar + conciliar" } }),
    pend({ id: `vencida:${U(601)}`, tipo: "conta_sem_pagamento", titulo: "Conta vencida sem pagamento registrado — Energia 09/2026", descricao: "Venceu em 20/09. Se foi paga, é preciso registrar o pagamento com a conta de saída; o sistema não presume a origem bancária.",
      motivo: "Venceu em 20/09.", valorCentavos: 31240, data: "2026-09-20", vencimento: "2026-09-20", obrigacaoId: U(601), refs: [U(601)], fornecedor: "Concessionária", categoria: "ENERGIA", status: "aguardando_comprovacao", responsavel: "Proprietário ou operador financeiro",
      evidenciaNecessaria: "Comprovante do pagamento com a conta de saída, ou confirmação de que a conta segue em aberto.", acao: { tipo: "registrar_pagamento", rotulo: "Registrar pagamento", metodo: "IR", rota: "fin-contas-a-pagar", exige: [], permissao: "lancar" } }),
    pend({ id: `origem:${U(602)}`, tipo: "origem_pendente", titulo: "Origem do pagamento pendente — Benefício 09/2026", descricao: "Pago em 10/09 e reconhecido na despesa. Falta informar de qual conta saiu.", motivo: "Pago em 10/09 e reconhecido na despesa.",
      valorCentavos: 8000, data: "2026-09-10", obrigacaoId: U(603), refs: [U(603)], evidencias: ["Pagamento sem comprovante bancário identificado"], contas: CONTAS, status: "aguardando_comprovacao", responsavel: "Proprietário",
      evidenciaNecessaria: "Comprovante bancário do pagamento (de qual conta o dinheiro saiu).", acao: { tipo: "resolver_origem", rotulo: "Informar a conta de saída", metodo: "POST", caminho: `/contas-pagar/pagamentos/${U(602)}/origem`, exige: ["contaId"], permissao: "conciliar" } }),
    pend({ id: `terceiro:${U(604)}`, tipo: "pagamento_terceiro", titulo: "Pagamento feito por terceiro — Distribuidora compra 08/2026", descricao: "Pago em 05/09 por Sócia. Não saiu do caixa da empresa; o valor segue como dívida até haver comprovante e acordo de reembolso.",
      motivo: "Pago em 05/09 por Sócia.", valorCentavos: 663360, data: "2026-09-05", obrigacaoId: U(605), refs: [U(605)], terceiroNome: "Sócia", obrigacao: { id: U(605), descricao: "Distribuidora — compra 08/2026", valorOriginalCentavos: 663360 },
      divida: { id: U(606), descricao: "Reembolso à sócia" }, evidencias: ["Apresentação 09/2026: pago com recursos pessoais"], status: "aguardando_comprovacao", responsavel: "Proprietário e contadora",
      evidenciaNecessaria: "Recibo ou comprovante do pagamento feito pelo terceiro e o combinado de reembolso.", acao: null }),
    pend({ id: "transferencias", tipo: "transferencias_internas", titulo: "11 saída(s) de transferência com contrapartida proposta", descricao: "Proposta de pareamento, nada confirmado: 5 com uma entrada de mesmo valor (vinculável), 6 em que a soma de 2 a 3 entradas fecha exatamente.",
      motivo: "Proposta de pareamento, nada confirmado.", valorCentavos: [...um, ...varios].reduce((a, l) => a + l.saida.valorCentavos, 0), data: "2026-09-06", linhas: [...um, ...varios], outras: [], status: "pendente", responsavel: "Contadora ou operador de conciliação",
      evidenciaNecessaria: "Extrato das duas contas mostrando a saída e a entrada correspondente.", acao: { tipo: "vincular_transferencias", rotulo: "Revisar vínculos", metodo: "TELA", permissao: "conciliar" } }),
    pend({ id: "classificacao_pendente", tipo: "classificacao_pendente", titulo: "8 lançamento(s) com classificação pendente", descricao: "Lançamentos marcados como pendentes de classificação ou de identificação de parte do valor.", motivo: "Lançamentos marcados como pendentes de classificação.",
      valorCentavos: 0, data: "2026-09-02", status: "pendente", responsavel: "Contadora", evidenciaNecessaria: "Documento que identifique a natureza e a categoria de cada lançamento.",
      itens: [2, 4, 8, 11, 14, 17, 22, 27].map((d, i) => ({ id: U(700 + i), data: `2026-09-${String(d).padStart(2, "0")}`, conta: i % 2 ? "UNICRED" : "CAIXA LOJA", sentido: i % 3 ? "saida" : "entrada", valorCentavos: 4500 + i * 1310, descricao: `PIX ${i + 1} A IDENTIFICAR`, nota: i === 0 ? "Parte do valor a identificar" : null })), acao: null }),
    pend({ id: `doc:${U(800)}`, tipo: "pendencia_documental", titulo: "Recibo de aluguel pago em espécie", descricao: "Aluguel pago em espécie em 15/09 sem recibo anexado.", motivo: "Aluguel pago em espécie em 15/09 sem recibo anexado.", valorCentavos: 105753, evidenciaNecessaria: "Recibo assinado do aluguel.",
      responsavel: "Operador financeiro", status: "pendente", statusRotulo: "Pendente", observacoes: null, documentoReferencia: null, relacionadaChave: null, docId: U(800), dataReferencia: "2026-09-15", data: "2026-09-15", aviso: null,
      acao: { tipo: "concluir_documental", rotulo: "Concluir com evidência", metodo: "POST", caminho: `/pendencias-documentais/${U(800)}/confirmar`, exige: ["evidencia"], permissao: "classificar" } }),
  ],
  concluidasDocumentais: [{ id: "d-ok", competencia: "2026-09", dataReferencia: "2026-09-03", descricao: "Nota de compra de gelo", valorCentavos: 4200, motivo: "Nota não localizada.", evidenciaNecessaria: "Nota fiscal.", responsavel: "Operador financeiro", estado: "confirmado",
    confirmacao: { por: U(3), em: "2026-10-02T12:00:00Z", evidencia: "Nota fiscal 123 conferida" }, documentoReferencia: "Pasta setembro", observacoes: null }],
  comparacao: [], resumoComparacao: { total: 0, conferem: 0, divergentes: 0 },
  periodos: { mes: "2026-09", mesAnterior: "2026-08", mesSeguinte: "2026-10",
    anteriorPagaNoMes: { totalCentavos: 663360, itens: [{ descricao: "Distribuidora — compra 08/2026", valorCentavos: 663360, tipo: "integral", pagoEm: "2026-09-05" }] },
    mesPagoDepois: { totalPagoCentavos: 120000, totalNoResultadoCentavos: 72000, itens: [{ descricao: "Entrega de embalagens", valorPagoCentavos: 120000, noResultadoCentavos: 72000, tipo: "parcela de rateio proposto" }] } },
};
CENTRAL_SETEMBRO.total = CENTRAL_SETEMBRO.pendencias.length;

// As 5 sugestões preparadas (mesmo conteúdo de pendenciasDocumentais.service.js#MODELOS), nenhuma cadastrada.
export const PDOC_SETEMBRO = { mes: "2026-09", itens: [], modelos: [
  { chave: "doc:2026-09:diferenca-caixa-190-53", descricao: "Diferença de fechamento de caixa — R$ 190,53", valorCentavos: 19053, dataReferencia: "2026-09-30", competencia: "2026-09", motivo: "Contagem física do caixa × saldo calculado em 30/09/2026.",
    evidenciaNecessaria: "Contagem física do caixa e conferência de cada levada de dinheiro do mês.", responsavel: "Contadora", estado: "pendente", relacionadaChave: "doc:2026-09:destino-caixa-195-25",
    observacoes: "Composição documentada: R$ 195,25 sem destino − R$ 4,72 de contagens divergentes (Fluxo × Conciliação). Pode estar relacionado ao item de R$ 195,25: não tratar como duas perdas independentes sem validação.", cadastrada: false, dispensada: null },
  { chave: "doc:2026-09:destino-caixa-195-25", descricao: "Destino de dinheiro do caixa não identificado — R$ 195,25", valorCentavos: 19525, dataReferencia: "2026-09-30", competencia: "2026-09", motivo: "Levadas de dinheiro do caixa em datas diferentes das conferências; não há lançamento que explique o valor.",
    evidenciaNecessaria: "Data e destino de cada levada de dinheiro que some R$ 195,25.", responsavel: "Contadora", estado: "pendente", relacionadaChave: "doc:2026-09:diferenca-caixa-190-53",
    observacoes: "Pode estar relacionado à diferença de caixa de R$ 190,53 (190,53 = 195,25 − 4,72). Validar antes de tratar como itens independentes.", cadastrada: false, dispensada: null },
  { chave: "doc:2026-09:pix-14-09-200-00", descricao: "Pix de 14/09 — R$ 200,00, classificação pendente", valorCentavos: 20000, dataReferencia: "2026-09-14", competencia: "2026-09", motivo: "Entrada de Pix sem identificação da finalidade; a classificação não foi presumida.",
    evidenciaNecessaria: "Identificação do remetente e da finalidade do Pix.", responsavel: "Proprietário e contadora", estado: "pendente", relacionadaChave: null, observacoes: "Compõe o resíduo de R$ 390,53.", cadastrada: false, dispensada: null },
  { chave: "doc:2026-09:divergencia-caixa-0-82", descricao: "Divergência de caixa — R$ 0,82", valorCentavos: 82, dataReferencia: "2026-09-04", competencia: "2026-09", motivo: "Compra de supermercado de 04/09: R$ 96,82 no Fluxo de Caixa × R$ 96,00 na Conciliação.",
    evidenciaNecessaria: "Nota ou cupom fiscal da compra de 04/09.", responsavel: "Operador financeiro", estado: "aguardando_comprovacao", relacionadaChave: null, observacoes: "Nenhum valor foi ajustado.", cadastrada: false, dispensada: null },
  { chave: "doc:2026-09:divergencias-sangria", descricao: "Divergências de sangria de setembro/2026 (dias 02, 04, 10, 15 e 21)", valorCentavos: null, dataReferencia: null, competencia: "2026-09", motivo: "A sangria registrada no sistema difere da tabela SAIPOS em 5 dias.",
    evidenciaNecessaria: "Relatório de sangrias × comprovantes de depósito, dia a dia.", responsavel: "Operador financeiro e contadora", estado: "pendente", relacionadaChave: null, observacoes: "Conferir os valores e as datas antes de confirmar.", cadastrada: false, dispensada: null },
] };
