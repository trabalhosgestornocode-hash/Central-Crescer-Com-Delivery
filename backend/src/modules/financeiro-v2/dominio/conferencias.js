// CENTRAL DE CONFERÊNCIAS (Execução 06C) — regras PURAS que juntam, numa linguagem só, o que os motores já detectam:
// apuração (DRE), vendas e recebimentos (06B), tesouraria (06A), propostas, importações, divergências entre relatórios
// e correspondências de conciliação. Nada aqui calcula valor financeiro novo nem resolve pendência.
//
//   * Cada PENDÊNCIA é um FATO (um registro) e pertence a UM grupo. Quando dois motores apontam o mesmo fato (ex.: a
//     apuração vê "saída sem classificação" e a tesouraria vê "movimento sem vínculo" na MESMA movimentação), ele vira
//     UMA pendência, com os dois motivos — nunca duas contagens.
//   * A quantidade de pendências é CONTAGEM. Não existe "total em reais das pendências": impactos de naturezas diferentes
//     não se somam.
//   * Homologação: bloqueada por divergência relevante SEM justificativa. Não há política de materialidade aprovada,
//     então NENHUMA tolerância é presumida: qualquer diferença aberta bloqueia. Recebível válido ainda não pago não bloqueia.
import { ESTADO_COMPETENCIA, ESTADO_DIVERGENCIA_FONTE, ESTADO_IMPORTACAO, ESTADO_PROPOSTA, SITUACAO_CORRESPONDENCIA, SITUACAO_SESSAO_CAIXA, SITUACAO_TITULO, TIPO } from "./catalogos.js";
import { primeiroDiaDe, ultimoDiaDe } from "./tempo.js";
import { caixaEBancos, documentosDe, preparar as prepararTesouraria, tituloAPagar } from "./tesouraria.js";
import { DIVERGENCIA_VENDA } from "./vendasRecebimentos.js";
import { avaliarPendenciasDoFechamento } from "./ressalvas.js";
import { CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_DESPESA_A_CLASSIFICAR } from "./planoDeContas.js";

/** Categorias do sistema que marcam classificação PROVISÓRIA (a definitiva pode mudar o resultado). */
export const CATEGORIAS_PROVISORIAS = Object.freeze([CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_DESPESA_A_CLASSIFICAR]);

const enumerar = (...v) => Object.freeze(Object.fromEntries(v.map((x) => [x, x])));

export const GRUPO = enumerar(
  "VENDAS_E_AJUSTES", "RECEBIMENTOS_E_REPASSES", "CONTAS_E_PAGAMENTOS", "CUSTOS_E_RATEIOS", "CAIXA_E_CONCILIACAO", "CLASSIFICACOES", "DOCUMENTAIS",
);
export const NOME_DO_GRUPO = Object.freeze({
  VENDAS_E_AJUSTES: "Vendas e ajustes", RECEBIMENTOS_E_REPASSES: "Recebimentos e repasses", CONTAS_E_PAGAMENTOS: "Contas e pagamentos",
  CUSTOS_E_RATEIOS: "Custos e rateios", CAIXA_E_CONCILIACAO: "Caixa e conciliação", CLASSIFICACOES: "Classificações financeiras", DOCUMENTAIS: "Pendências documentais",
});
/** Situação de uma pendência. INFORMATIVA é registrada para contexto e não conta como "a resolver". */
export const SITUACAO_PENDENCIA = enumerar("ABERTA", "AGUARDANDO_DOCUMENTO", "AGUARDANDO_DECISAO", "EXPLICADA_PARCIALMENTE", "INFORMATIVA");
/** Efeito no fechamento: BLOQUEIA a homologação (núcleo recusa), EXIGE_DOCUMENTACAO (fechar só "com pendências documentadas") ou NAO_BLOQUEIA. */
export const EFEITO_NO_FECHAMENTO = enumerar("BLOQUEIA", "EXIGE_DOCUMENTACAO", "NAO_BLOQUEIA");
export const POLITICA_DE_MATERIALIDADE = Object.freeze({
  aprovada: false,
  texto: "Não há política de materialidade aprovada. Nenhuma tolerância é aplicada: toda divergência sem justificativa bloqueia a homologação, e nada é homologado automaticamente.",
});

/** Relatórios esperados para conferir uma competência (fontes da operação). Os demais tipos aparecem quando importados. */
export const FONTES_DA_COMPETENCIA = Object.freeze([
  { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_FATURAMENTO_POR_DIA", nome: "Faturamento diário do SAIPOS" },
  { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", nome: "Formas de pagamento do SAIPOS" },
  { fonte: "STONE", tipoRelatorio: "STONE_VENDAS", nome: "Vendas da Stone" },
  { fonte: "UNICRED", tipoRelatorio: "UNICRED_EXTRATO", nome: "Extrato da Unicred" },
]);

const ROTULO_RELACAO = Object.freeze({
  SAIPOS_X_STONE: "Venda SAIPOS × transação Stone", STONE_X_RECEBIMENTO: "Transação Stone × recebimento Stone", RECEBIMENTO_STONE_X_UNICRED: "Recebimento Stone × crédito Unicred",
  IFOOD_X_UNICRED: "Repasse iFood × crédito Unicred", FOODY_X_UNICRED: "Entregas Foody × pagamento Unicred", OBRIGACAO_X_MOVIMENTACAO: "Conta a pagar × saída bancária", MANUAL: "Correspondência montada por uma pessoa",
});
export const nomeDaRelacao = (r) => ROTULO_RELACAO[r] ?? "Correspondência";
/** Grupo de uma correspondência pela relação que ela concilia. */
const GRUPO_DA_RELACAO = Object.freeze({
  SAIPOS_X_STONE: GRUPO.RECEBIMENTOS_E_REPASSES, STONE_X_RECEBIMENTO: GRUPO.RECEBIMENTOS_E_REPASSES, RECEBIMENTO_STONE_X_UNICRED: GRUPO.RECEBIMENTOS_E_REPASSES,
  IFOOD_X_UNICRED: GRUPO.RECEBIMENTOS_E_REPASSES, FOODY_X_UNICRED: GRUPO.CONTAS_E_PAGAMENTOS, OBRIGACAO_X_MOVIMENTACAO: GRUPO.CONTAS_E_PAGAMENTOS, MANUAL: GRUPO.CAIXA_E_CONCILIACAO,
});
const GRUPO_DA_OPERACAO = Object.freeze({
  VENDA: GRUPO.VENDAS_E_AJUSTES, VENDA_AGREGADA: GRUPO.VENDAS_E_AJUSTES, PAGAMENTO_STONE: GRUPO.RECEBIMENTOS_E_REPASSES,
  OBRIGACAO_ENTREGADOR: GRUPO.CONTAS_E_PAGAMENTOS, MOVIMENTACAO_BANCARIA: GRUPO.CAIXA_E_CONCILIACAO,
});
export const NOME_DA_OPERACAO = Object.freeze({
  VENDA: "Registrar venda (pedido)", VENDA_AGREGADA: "Registrar venda agregada do dia", PAGAMENTO_STONE: "Vincular pagamento Stone e formar recebível",
  OBRIGACAO_ENTREGADOR: "Registrar obrigação com entregador", MOVIMENTACAO_BANCARIA: "Registrar movimentação bancária",
});
const ABERTAS = [ESTADO_PROPOSTA.PROPOSTA, ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA, ESTADO_PROPOSTA.AGUARDANDO_REVISAO, ESTADO_PROPOSTA.APROVADA];

/** Período civil da competência. */
export const periodoDa = (competencia) => ({ inicio: primeiroDiaDe(competencia), fim: ultimoDiaDe(competencia) });
const sobrepoe = (ini, fim, p) => ini <= p.fim && fim >= p.inicio;

// ------------------------------------------------------------------------------------------------------------ pendências
/**
 * Prioridade quando o MESMO fato é apontado por mais de um motor: o motivo mais específico vira o título; os demais
 * ficam em `outrosMotivos`.
 */
const PRIORIDADE = [
  "SOBREPOSICAO_AGREGADO_PEDIDOS", "TOTAIS_DE_RELATORIOS_DIFERENTES", "SALDO_DIVERGENTE", "TRANSACAO_SEM_PEDIDO", "VENDA_SEM_PAGAMENTO", "PAGAMENTO_INCOMPATIVEL",
  "TAXA_OU_VALOR_DIVERGENTE", "REPASSE_INFORMADO_SEM_CREDITO", "CREDITO_SEM_COMPROVACAO_BANCARIA", "RECEBIVEL_ATRASADO", "RECEBIVEL_SEM_REPASSE",
  "DESPESA_A_CLASSIFICAR", "DESCONTO_A_CLASSIFICAR", "SAIDA_SEM_CLASSIFICACAO", "CREDITO_NAO_IDENTIFICADO", "RECEBIMENTO_DIRETO_NAO_IDENTIFICADO",
  "PROPOSTA_EM_ABERTO", "CORRESPONDENCIA_A_DECIDIR", "OBRIGACAO_SEM_COMPROVANTE", "IMPORTACAO_A_REVISAR", "IMPORTACAO_COM_PENDENCIAS", "FONTE_SEM_DOCUMENTO",
  "DIFERENCA_DE_CAIXA", "VENDA_SEM_CANAL",
];
const prioridade = (c) => { const i = PRIORIDADE.indexOf(c); return i < 0 ? PRIORIDADE.length : i; };

/** Junta pendências do mesmo fato (mesma chave), sem duplicar contagem. */
export function unificar(lista) {
  const porChave = new Map();
  for (const p of lista) {
    const atual = porChave.get(p.chave);
    if (!atual) { porChave.set(p.chave, { ...p, outrosMotivos: [], apontadoPor: [p.tecnico?.motor ?? "registro"] }); continue; }
    const [principal, outro] = prioridade(p.codigo) < prioridade(atual.codigo) ? [{ ...p, outrosMotivos: atual.outrosMotivos, apontadoPor: atual.apontadoPor }, atual] : [atual, p];
    // Quem apontou o mesmo fato fica registrado; o motivo só aparece de novo se disser algo diferente.
    principal.apontadoPor = [...new Set([...principal.apontadoPor, outro.tecnico?.motor ?? "registro"])];
    if (outro.motivo !== principal.motivo && !principal.outrosMotivos.some((x) => x.motivo === outro.motivo)) principal.outrosMotivos = [...principal.outrosMotivos, { codigo: outro.codigo, motivo: outro.motivo }];
    // Bloqueio e documentação se somam (o mais restritivo prevalece); documentos existentes também.
    const peso = { BLOQUEIA: 2, EXIGE_DOCUMENTACAO: 1, NAO_BLOQUEIA: 0 };
    if (peso[outro.efeitoNoFechamento] > peso[principal.efeitoNoFechamento]) principal.efeitoNoFechamento = outro.efeitoNoFechamento;
    principal.documentosExistentes = [...new Map([...principal.documentosExistentes, ...outro.documentosExistentes].map((d) => [d.referencia, d])).values()];
    porChave.set(p.chave, principal);
  }
  return [...porChave.values()];
}

const pendencia = (x) => ({
  situacao: SITUACAO_PENDENCIA.ABERTA, valorCentavos: null, documentosExistentes: [], documentosNecessarios: [], opcoes: [], responsavel: null,
  efeitoNoFechamento: EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO, referencia: null, tecnico: {}, ...x,
});

/**
 * Todas as pendências da competência, já unificadas por fato e com UM grupo cada.
 * @param {object} e { d: registros do escopo, competencia, hoje, apuracao, vendas: {ops, ix, avulsos, semVenda}, divergenciasVendas }
 */
export function pendenciasDaCompetencia(e) {
  const { d, competencia, hoje, apuracao } = e;
  const per = periodoDa(competencia);
  const p = prepararTesouraria(d);
  const lista = [];
  const add = (x) => lista.push(pendencia({ competencia, ...x }));
  const docs = (tipo, r) => documentosDe(p, tipo, r);

  // --- apuração (DRE): classificações provisórias e propostas de venda ainda não aplicadas
  for (const x of apuracao?.pendencias ?? []) {
    if (x.tipo === "DESCONTO_A_CLASSIFICAR") {
      const l = p.lancamentoPorId.get(x.lancamentoId);
      add({ chave: `LANCAMENTO:${x.lancamentoId}`, grupo: GRUPO.CLASSIFICACOES, codigo: "DESCONTO_A_CLASSIFICAR", titulo: "Desconto sem financiador confirmado", valorCentavos: x.valorCentavos,
        motivo: "A fonte não informa se o desconto foi pago pela loja ou por terceiro.", oQueAconteceu: "Um desconto foi deduzido da receita de forma provisória (dedução a classificar).",
        origem: l?.fonte?.sistema ?? "Registro", impacto: "Deduções comerciais da DRE ficam provisórias até a classificação.",
        documentosNecessarios: ["Relatório do canal com o financiador do desconto (ex.: apuração iFood)"], opcoes: ["Reclassificar como desconto da loja", "Registrar o terceiro como financiador com documento"],
        referencia: l?.origem?.tipo === TIPO.VENDA ? { tipo: "VENDA", id: l.origem.id } : l?.origem?.tipo === TIPO.PROPOSTA ? { tipo: "AGREGADO_DIARIO", id: [...(p.lancamentos ?? [])].find((y) => y.origem?.id === l.origem.id && y.natureza === "RECEITA")?.id ?? null } : null,
        tecnico: { motor: "apuracao", tipo: x.tipo, lancamentoId: x.lancamentoId } });
    } else if (x.tipo === "DESPESA_A_CLASSIFICAR") {
      // 08D: os documentos já vinculados ao lançamento (ou à conta que o originou) aparecem na pendência — anexar NÃO a
      // resolve; só mostra a evidência disponível para a decisão de reclassificar.
      const l = p.lancamentoPorId.get(x.lancamentoId);
      const daConta = (p.obrigacoes ?? []).filter((o) => o.lancamentoId === x.lancamentoId).flatMap((o) => docs(TIPO.OBRIGACAO, o));
      const existentes = [...new Map([...(l ? docs(TIPO.LANCAMENTO, l) : []), ...daConta].map((d) => [d.referencia, d])).values()];
      add({ chave: `LANCAMENTO:${x.lancamentoId}`, documentosExistentes: existentes, grupo: GRUPO.CLASSIFICACOES, codigo: "DESPESA_A_CLASSIFICAR", titulo: "Despesa sem classificação", valorCentavos: x.valorCentavos,
        motivo: "A natureza econômica da despesa não foi comprovada; ela fica fora da DRE.", oQueAconteceu: "Uma conta foi registrada na categoria \"a classificar\".",
        origem: "Contas a pagar", impacto: "O resultado da DRE não inclui este valor até a classificação.", documentosNecessarios: ["Nota fiscal, boleto ou contrato que identifique a despesa"],
        opcoes: ["Reclassificar a despesa (com justificativa)"], referencia: { tipo: "LANCAMENTO", id: x.lancamentoId }, tecnico: { motor: "apuracao", tipo: x.tipo } });
    } else if (x.tipo === "SAIDA_SEM_CLASSIFICACAO") {
      add({ chave: `MOVIMENTACAO:${x.movimentacaoId}`, grupo: GRUPO.CLASSIFICACOES, codigo: "SAIDA_SEM_CLASSIFICACAO", titulo: "Saída bancária sem classificação", valorCentavos: x.valorCentavos,
        motivo: "O dinheiro saiu, mas nenhuma conta a pagar explica a saída.", oQueAconteceu: "Uma saída da conta não está vinculada a obrigação, transferência ou devolução.",
        origem: "Extrato / movimentação", impacto: "Pode ser despesa ainda não reconhecida: o resultado pode estar incompleto.", documentosNecessarios: ["Comprovante ou boleto da saída"],
        opcoes: ["Vincular a uma conta a pagar existente", "Registrar a conta a pagar com documento e vincular"], referencia: { tipo: "MOVIMENTACAO", id: x.movimentacaoId }, tecnico: { motor: "apuracao", tipo: x.tipo } });
    } else if (x.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS") {
      add({ chave: `DIA:${x.data}`, grupo: GRUPO.VENDAS_E_AJUSTES, codigo: "SOBREPOSICAO_AGREGADO_PEDIDOS", titulo: "Venda agregada e pedidos no mesmo dia", motivo: x.mensagem,
        oQueAconteceu: "O total diário e os pedidos do mesmo dia têm receita ativa ao mesmo tempo.", origem: "SAIPOS", impacto: "Risco de faturamento contado duas vezes.",
        efeitoNoFechamento: EFEITO_NO_FECHAMENTO.BLOQUEIA, opcoes: ["Substituir o agregado pelos pedidos (operação atômica)"], referencia: null, tecnico: { motor: "apuracao", data: x.data } });
    }
  }

  // --- propostas da competência ainda não decididas/aplicadas
  for (const pr of (d.propostas ?? []).filter((x) => x.competencia === competencia && ABERTAS.includes(x.estado))) {
    const semPedido = pr.operacao === "PAGAMENTO_STONE" && !pr.comando?.vendaId;
    const ambigua = (pr.divergencias ?? []).some((x) => x.codigo === "VINCULO_AMBIGUO");
    add({
      chave: `PROPOSTA:${pr.id}`, grupo: GRUPO_DA_OPERACAO[pr.operacao] ?? GRUPO.DOCUMENTAIS, codigo: semPedido ? "TRANSACAO_SEM_PEDIDO" : "PROPOSTA_EM_ABERTO",
      titulo: semPedido ? (ambigua ? "Transação Stone com mais de uma venda possível" : "Transação Stone sem pedido correspondente") : `${NOME_DA_OPERACAO[pr.operacao] ?? "Proposta"} — aguardando decisão`,
      valorCentavos: pr.valorCentavos ?? null, situacao: pr.estado === ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA ? SITUACAO_PENDENCIA.AGUARDANDO_DOCUMENTO : SITUACAO_PENDENCIA.AGUARDANDO_DECISAO,
      motivo: semPedido ? (ambigua ? "Mais de uma venda do dia pode corresponder: o vínculo exige escolha de uma pessoa." : "Nenhuma venda do dia corresponde à transação; ela não vira venda.") : pr.estado === ESTADO_PROPOSTA.APROVADA ? "Aprovada, mas ainda não aplicada: o efeito financeiro não existe." : "O registro importado ainda não foi revisado.",
      oQueAconteceu: pr.justificativa ?? "Proposta formada a partir de registro importado.", origem: pr.fonte ?? "Importação",
      impacto: ["VENDA", "VENDA_AGREGADA"].includes(pr.operacao) ? "Faturamento da competência incompleto até a decisão." : "Efeito financeiro ainda não registrado.",
      documentosExistentes: (pr.documentoIds ?? []).map((id) => ({ referencia: id, tipo: p.documentoPorId.get(id)?.tipo ?? null, descricao: p.documentoPorId.get(id)?.descricao ?? null })),
      documentosNecessarios: semPedido ? ["Relatório de vendas por pedido do SAIPOS do dia"] : [],
      opcoes: semPedido ? ["Importar o relatório por pedido do dia", "Rejeitar a proposta com justificativa"] : ["Revisar a proposta (aprovar ou rejeitar)", ...(pr.estado === ESTADO_PROPOSTA.APROVADA ? ["Aplicar a proposta aprovada"] : [])],
      referencia: { tipo: "PROPOSTA", id: pr.id }, tecnico: { motor: "formacao", operacao: pr.operacao, estado: pr.estado, confianca: pr.confianca },
    });
  }

  // --- vendas e recebimentos (06B): o que não vem da apuração nem das propostas
  for (const x of e.divergenciasVendas ?? []) {
    if (x.competencia !== competencia) continue;
    const ref = x.referencia ?? {};
    const base = { valorCentavos: x.valorCentavos ?? null, motivo: x.motivo, origem: x.fonte, documentosExistentes: x.evidencias ?? [], tecnico: { motor: "vendasRecebimentos", codigo: x.codigo } };
    switch (x.codigo) {
      case DIVERGENCIA_VENDA.VENDA_SEM_PAGAMENTO:
      case DIVERGENCIA_VENDA.PAGAMENTO_INCOMPATIVEL:
        add({ ...base, chave: `VENDA:${ref.id}:PAGAMENTO`, grupo: GRUPO.VENDAS_E_AJUSTES, codigo: x.codigo, titulo: x.titulo, oQueAconteceu: "Os pagamentos informados não fecham com o valor cobrado da venda.", impacto: "Recebimento da venda incompleto ou em excesso.", documentosNecessarios: ["Relatório da processadora do dia"], opcoes: ["Importar o relatório da processadora", "Registrar o pagamento com evidência"], referencia: { tipo: "VENDA", id: ref.id } });
        break;
      case DIVERGENCIA_VENDA.RECEBIMENTO_DIRETO_NAO_IDENTIFICADO:
        add({ ...base, chave: `VENDA:${ref.id}:CREDITO_DIRETO`, grupo: GRUPO.CAIXA_E_CONCILIACAO, codigo: x.codigo, titulo: x.titulo, oQueAconteceu: "Venda paga em dinheiro ou Pix sem conta de entrada registrada.", impacto: "O dinheiro pode estar no caixa ou no banco sem vínculo com a venda.", documentosNecessarios: ["Contagem do caixa ou extrato do dia"], opcoes: ["Vincular o crédito quando o extrato/contagem for registrado"], referencia: { tipo: "VENDA", id: ref.id } });
        break;
      case DIVERGENCIA_VENDA.RECEBIVEL_SEM_REPASSE:
      case DIVERGENCIA_VENDA.RECEBIVEL_ATRASADO:
      case DIVERGENCIA_VENDA.REPASSE_INFORMADO_SEM_CREDITO:
      case DIVERGENCIA_VENDA.TAXA_OU_VALOR_DIVERGENTE:
        add({ ...base, chave: `RECEBIVEL:${ref.recebivelId}`, grupo: GRUPO.RECEBIMENTOS_E_REPASSES, codigo: x.codigo, titulo: x.titulo, oQueAconteceu: "O direito a receber do processador ainda não foi creditado (ou foi creditado com diferença).",
          impacto: "Valor esperado ainda fora da conta. Recebível válido em aberto não bloqueia o fechamento.", situacao: x.codigo === DIVERGENCIA_VENDA.TAXA_OU_VALOR_DIVERGENTE ? SITUACAO_PENDENCIA.ABERTA : SITUACAO_PENDENCIA.AGUARDANDO_DOCUMENTO,
          efeitoNoFechamento: x.codigo === DIVERGENCIA_VENDA.TAXA_OU_VALOR_DIVERGENTE ? EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO : EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA,
          documentosNecessarios: ["Demonstrativo de repasse do processador", "Extrato bancário do período"], opcoes: ["Importar recebimentos do processador", "Conciliar o crédito quando aparecer no extrato"], referencia: { tipo: "RECEBIVEL", id: ref.recebivelId } });
        break;
      case DIVERGENCIA_VENDA.CREDITO_SEM_COMPROVACAO_BANCARIA: {
        add({ ...base, chave: `MOVIMENTACAO:${ref.movimentacaoId}`, grupo: GRUPO.RECEBIMENTOS_E_REPASSES, codigo: x.codigo, titulo: "Repasse não conciliado com o extrato", oQueAconteceu: "O recebimento foi registrado na conta sem extrato nem conciliação.",
          impacto: "O dinheiro pode não ter entrado como registrado.", documentosNecessarios: ["Extrato bancário do dia do crédito"], opcoes: ["Importar o extrato e confirmar a correspondência"], referencia: { tipo: "RECEBIVEL", id: ref.recebivelId, movimentacaoId: ref.movimentacaoId } });
        break;
      }
      case DIVERGENCIA_VENDA.TOTAIS_DE_RELATORIOS_DIFERENTES:
        add({ ...base, chave: `DIVERGENCIA_FONTE:${ref.id}`, grupo: GRUPO.VENDAS_E_AJUSTES, codigo: x.codigo, titulo: "Diferença comercial entre relatórios", situacao: x.situacao === ESTADO_DIVERGENCIA_FONTE.EXPLICADA_PARCIALMENTE ? SITUACAO_PENDENCIA.EXPLICADA_PARCIALMENTE : SITUACAO_PENDENCIA.ABERTA,
          oQueAconteceu: "Dois relatórios do mesmo período trazem totais diferentes.", impacto: "A causa da diferença não está comprovada; nada foi ajustado.",
          efeitoNoFechamento: x.situacao === ESTADO_DIVERGENCIA_FONTE.ABERTA ? EFEITO_NO_FECHAMENTO.BLOQUEIA : EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO,
          documentosNecessarios: ["Relatório de vendas por pedido do período"], opcoes: ["Registrar explicação com evidência"], referencia: { tipo: "DIVERGENCIA_FONTE", id: ref.id } });
        break;
      case DIVERGENCIA_VENDA.VENDA_SEM_CANAL:
        add({ ...base, chave: `AGREGADO:${ref.id}`, grupo: GRUPO.VENDAS_E_AJUSTES, codigo: x.codigo, titulo: "Faturamento sem canal identificado", situacao: SITUACAO_PENDENCIA.INFORMATIVA, efeitoNoFechamento: EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA,
          oQueAconteceu: "O relatório agregado não informa canal nem pedidos.", impacto: "O faturamento existe, mas não se distribui por canal.", documentosNecessarios: ["Relatório de vendas por pedido"], opcoes: ["Importar o relatório por pedido (substitui o agregado)"], referencia: { tipo: "AGREGADO_DIARIO", id: ref.id } });
        break;
      default:
        break; // TRANSACAO_SEM_PEDIDO e DESCONTO_SEM_FINANCIADOR já vieram das propostas e da apuração (mesmo fato)
    }
  }

  // --- tesouraria: obrigações sem comprovante, créditos sem vínculo, saldos que não conferem, diferenças de caixa
  for (const o of p.obrigacoes ?? []) {
    if (o.competencia !== competencia) continue;
    const t = tituloAPagar(p, o, hoje);
    if (t.pendencias.includes("SEM_DOCUMENTO")) {
      add({ chave: `OBRIGACAO:${o.id}:DOCUMENTO`, grupo: GRUPO.DOCUMENTAIS, codigo: "OBRIGACAO_SEM_COMPROVANTE", titulo: `Conta sem comprovante — ${t.fornecedor?.nome ?? "fornecedor"}`, valorCentavos: t.saldoCentavos,
        motivo: "A conta em aberto não tem boleto, nota ou comprovante vinculado.", oQueAconteceu: `Conta "${t.descricao ?? ""}" registrada sem documento.`, origem: t.origem === "MANUAL" ? "Registro manual" : t.origem,
        impacto: "O valor devido não está comprovado documentalmente.", documentosNecessarios: ["Boleto, nota fiscal ou contrato"], opcoes: ["Vincular o documento à conta"], referencia: { tipo: "OBRIGACAO", id: o.id }, tecnico: { motor: "tesouraria" } });
    }
  }
  const banco = caixaEBancos(d, hoje, { inicio: per.inicio, fim: per.fim, pagina: 1, tamanho: 100000 });
  for (const m of banco.movimentos.filter((x) => x.pendencias.includes("SEM_VINCULO") && x.sentido === "ENTRADA")) {
    add({ chave: `MOVIMENTACAO:${m.id}`, grupo: GRUPO.CAIXA_E_CONCILIACAO, codigo: "CREDITO_NAO_IDENTIFICADO", titulo: "Crédito não identificado", valorCentavos: m.valorCentavos,
      motivo: "Entrou dinheiro na conta sem venda, título ou transferência que o explique.", oQueAconteceu: `Crédito em ${m.conta?.nome ?? "conta"} em ${m.data}.`, origem: m.fonte ?? "Registro",
      impacto: "Não é receita por ser entrada: a origem precisa ser identificada.", documentosExistentes: m.documentos, documentosNecessarios: ["Comprovante do depósito ou da transferência recebida"],
      opcoes: ["Vincular a um recebível ou venda", "Registrar como transferência entre contas"], referencia: { tipo: "MOVIMENTACAO", id: m.id }, tecnico: { motor: "tesouraria", categoriaBancaria: m.categoriaBancariaSugerida } });
  }
  for (const m of banco.movimentos.filter((x) => x.pendencias.includes("SEM_VINCULO") && x.sentido === "SAIDA")) {
    add({ chave: `MOVIMENTACAO:${m.id}`, grupo: GRUPO.CLASSIFICACOES, codigo: "SAIDA_SEM_CLASSIFICACAO", titulo: "Saída bancária sem classificação", valorCentavos: m.valorCentavos,
      motivo: "O dinheiro saiu, mas nenhuma conta a pagar explica a saída.", oQueAconteceu: `Saída de ${m.conta?.nome ?? "conta"} em ${m.data}.`, origem: m.fonte ?? "Registro",
      impacto: "Pode ser despesa ainda não reconhecida.", documentosExistentes: m.documentos, documentosNecessarios: ["Comprovante ou boleto da saída"],
      opcoes: ["Vincular a uma conta a pagar"], referencia: { tipo: "MOVIMENTACAO", id: m.id }, tecnico: { motor: "tesouraria", categoriaBancaria: m.categoriaBancariaSugerida } });
  }
  for (const c of banco.contas) {
    for (const x of c.conferenciasDeSaldo.filter((y) => y.situacao === "DIVERGENTE" && y.data >= per.inicio && y.data <= per.fim)) {
      add({ chave: `SALDO_CONTA:${c.id}:${x.data}:${x.referencia}`, grupo: GRUPO.CAIXA_E_CONCILIACAO, codigo: "SALDO_DIVERGENTE", titulo: `Saldo de ${c.nome} não confere`, valorCentavos: x.diferencaCentavos,
        motivo: "O saldo informado é diferente do calculado a partir do saldo anterior e dos movimentos.", oQueAconteceu: `Saldo informado em ${x.data} difere do calculado.`, origem: "Saldo informado",
        impacto: "Há movimento faltando, duplicado ou errado na conta.", efeitoNoFechamento: EFEITO_NO_FECHAMENTO.BLOQUEIA, documentosExistentes: x.documentos,
        documentosNecessarios: ["Extrato completo do intervalo"], opcoes: ["Localizar o movimento que falta ou sobra"], referencia: { tipo: "CONTA", id: c.id }, tecnico: { motor: "tesouraria", informado: x.informadoCentavos, calculado: x.calculadoCentavos } });
    }
  }
  for (const s of (p.sessoes ?? []).filter((x) => x.situacao === SITUACAO_SESSAO_CAIXA.FECHADA && x.diferencaCentavos && x.dataFechamento >= per.inicio && x.dataFechamento <= per.fim)) {
    add({ chave: `SESSAO_CAIXA:${s.id}`, grupo: GRUPO.CAIXA_E_CONCILIACAO, codigo: "DIFERENCA_DE_CAIXA", titulo: "Diferença na contagem do caixa", valorCentavos: s.diferencaCentavos,
      situacao: SITUACAO_PENDENCIA.INFORMATIVA, efeitoNoFechamento: EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA, motivo: `Registrada com justificativa: ${s.justificativa ?? "—"}`,
      oQueAconteceu: "O contado no fechamento foi diferente do teórico.", origem: "Caixa físico", impacto: "Nenhum ajuste automático foi feito.", referencia: { tipo: "SESSAO_CAIXA", id: s.id }, tecnico: { motor: "tesouraria" } });
  }

  // --- correspondências de conciliação a decidir
  for (const c of (d.correspondencias ?? []).filter((x) => x.competencia === competencia && [SITUACAO_CORRESPONDENCIA.CANDIDATA, SITUACAO_CORRESPONDENCIA.AGUARDANDO_DOCUMENTO].includes(x.situacao))) {
    add({ chave: `CORRESPONDENCIA:${c.id}`, grupo: GRUPO_DA_RELACAO[c.relacao] ?? GRUPO.CAIXA_E_CONCILIACAO, codigo: "CORRESPONDENCIA_A_DECIDIR", titulo: `Conciliação a decidir — ${nomeDaRelacao(c.relacao)}`,
      valorCentavos: c.diferencaCentavos || null, situacao: c.situacao === SITUACAO_CORRESPONDENCIA.AGUARDANDO_DOCUMENTO ? SITUACAO_PENDENCIA.AGUARDANDO_DOCUMENTO : SITUACAO_PENDENCIA.AGUARDANDO_DECISAO,
      motivo: c.forca === "FRACA" ? "Sugerida só por valor e data: é candidata, não prova." : "Correspondência sugerida aguardando decisão de uma pessoa.", oQueAconteceu: c.justificativa ?? "Correspondência candidata.",
      origem: "Conciliação", impacto: c.diferencaCentavos ? "Os lados não fecham: confirmar não é possível sem explicação." : "Enquanto não confirmada, os registros seguem não conciliados.",
      documentosExistentes: (c.evidenciaDocumentoIds ?? []).map((id) => ({ referencia: id, tipo: p.documentoPorId.get(id)?.tipo ?? null, descricao: p.documentoPorId.get(id)?.descricao ?? null })),
      opcoes: ["Confirmar (se os lados fecham e não há disputa)", "Rejeitar com justificativa", "Registrar divergência com justificativa"], referencia: { tipo: "CORRESPONDENCIA", id: c.id }, tecnico: { motor: "conciliacao", relacao: c.relacao, regra: c.regra, forca: c.forca } });
  }

  // --- importações e documentação
  for (const imp of (d.importacoes ?? []).filter((x) => sobrepoe(x.periodoInicio, x.periodoFim, per))) {
    if (imp.estado === ESTADO_IMPORTACAO.PRONTO_PARA_IMPORTAR) {
      add({ chave: `IMPORTACAO:${imp.id}`, grupo: GRUPO.DOCUMENTAIS, codigo: "IMPORTACAO_A_REVISAR", titulo: "Importação aguardando revisão", situacao: SITUACAO_PENDENCIA.AGUARDANDO_DECISAO,
        motivo: "O arquivo foi recebido e validado; a prévia ainda não foi confirmada.", oQueAconteceu: `Relatório ${imp.tipoRelatorio} recebido.`, origem: imp.fonte, impacto: "Os registros do arquivo ainda não estão no sistema.",
        opcoes: ["Revisar a prévia e confirmar", "Rejeitar com justificativa"], referencia: { tipo: "IMPORTACAO", id: imp.id }, tecnico: { motor: "importacao", estado: imp.estado } });
    } else if (imp.estado === ESTADO_IMPORTACAO.IMPORTADO_COM_PENDENCIAS) {
      add({ chave: `IMPORTACAO:${imp.id}`, grupo: GRUPO.DOCUMENTAIS, codigo: "IMPORTACAO_COM_PENDENCIAS", titulo: "Importação aceita com divergências", situacao: SITUACAO_PENDENCIA.INFORMATIVA, efeitoNoFechamento: EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA,
        motivo: `Divergências aceitas com justificativa: ${imp.justificativa ?? "—"}`, oQueAconteceu: `Relatório ${imp.tipoRelatorio} importado com ${imp.relatorio?.divergencias ?? 0} divergência(s).`, origem: imp.fonte,
        impacto: "As divergências ficaram registradas no relatório da importação.", referencia: { tipo: "IMPORTACAO", id: imp.id }, tecnico: { motor: "importacao", estado: imp.estado } });
    }
  }
  for (const f of fontesDaCompetencia(d, competencia).filter((x) => !x.temDocumento)) {
    add({ chave: `FONTE:${f.tipoRelatorio}`, grupo: GRUPO.DOCUMENTAIS, codigo: "FONTE_SEM_DOCUMENTO", titulo: `Falta: ${f.nome}`, situacao: SITUACAO_PENDENCIA.AGUARDANDO_DOCUMENTO,
      motivo: "Nenhum arquivo deste relatório foi importado para a competência.", oQueAconteceu: "A conferência depende deste relatório.", origem: f.fonte, impacto: "A conferência da competência fica incompleta.",
      documentosNecessarios: [`${f.nome} do período`], opcoes: ["Importar o arquivo"], referencia: null, tecnico: { motor: "importacao", tipoRelatorio: f.tipoRelatorio } });
  }
  return unificar(lista).sort((a, b) => prioridade(a.codigo) - prioridade(b.codigo) || String(a.chave).localeCompare(String(b.chave)));
}

/** Fontes esperadas da competência e se há documento importado (concluído) cobrindo o período. */
export function fontesDaCompetencia(d, competencia) {
  const per = periodoDa(competencia);
  const concluidas = (d.importacoes ?? []).filter((x) => [ESTADO_IMPORTACAO.IMPORTADO, ESTADO_IMPORTACAO.IMPORTADO_COM_PENDENCIAS].includes(x.estado) && sobrepoe(x.periodoInicio, x.periodoFim, per));
  const esperadas = FONTES_DA_COMPETENCIA.map((f) => ({ ...f, esperada: true }));
  const extras = [...new Map(concluidas.filter((x) => !esperadas.some((f) => f.tipoRelatorio === x.tipoRelatorio)).map((x) => [x.tipoRelatorio, { fonte: x.fonte, tipoRelatorio: x.tipoRelatorio, nome: x.tipoRelatorio, esperada: false }])).values()];
  return [...esperadas, ...extras].map((f) => {
    const daFonte = concluidas.filter((x) => x.tipoRelatorio === f.tipoRelatorio);
    return { ...f, temDocumento: daFonte.length > 0, importacoes: daFonte.length, cobertura: daFonte.length ? { inicio: daFonte.map((x) => x.periodoInicio).sort()[0], fim: daFonte.map((x) => x.periodoFim).sort().at(-1) } : null };
  });
}

/** Contagens por grupo e por situação. NUNCA soma valores de pendências diferentes. */
export function contagemDePendencias(pendencias) {
  const porGrupo = Object.fromEntries(Object.values(GRUPO).map((g) => [g, { nome: NOME_DO_GRUPO[g], abertas: 0, informativas: 0, bloqueiam: 0 }]));
  const porSituacao = {};
  for (const p of pendencias) {
    const g = porGrupo[p.grupo];
    if (p.situacao === SITUACAO_PENDENCIA.INFORMATIVA) g.informativas += 1; else g.abertas += 1;
    if (p.efeitoNoFechamento === EFEITO_NO_FECHAMENTO.BLOQUEIA) g.bloqueiam += 1;
    porSituacao[p.situacao] = (porSituacao[p.situacao] ?? 0) + 1;
  }
  const abertas = pendencias.filter((p) => p.situacao !== SITUACAO_PENDENCIA.INFORMATIVA).length;
  return { total: abertas, informativas: pendencias.length - abertas, bloqueiam: pendencias.filter((p) => p.efeitoNoFechamento === EFEITO_NO_FECHAMENTO.BLOQUEIA).length, porGrupo, porSituacao };
}

// ------------------------------------------------------------------------------------------------------------ fechamento
/**
 * Impedimentos de HOMOLOGAÇÃO aplicados pelo núcleo (não só pela tela). Divergência relevante sem justificativa:
 *   - totais de relatórios diferentes ainda ABERTOS (sem explicação registrada);
 *   - saldo de conta informado que não confere com o calculado;
 *   - receita agregada e por pedido no mesmo dia (contagem dupla).
 * Sem política de materialidade, NENHUMA tolerância: qualquer diferença ≠ 0 conta.
 */
export function impedimentosDeHomologacao(d, competencia, hoje, apuracao) {
  const per = periodoDa(competencia);
  const lista = [];
  for (const dv of (d.divergenciasFonte ?? []).filter((x) => x.estado === ESTADO_DIVERGENCIA_FONTE.ABERTA && x.diferencaCentavos !== 0 && sobrepoe(x.periodoInicio, x.periodoFim, per))) {
    lista.push({ codigo: "DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA", mensagem: "Relatórios do mesmo período com totais diferentes e sem explicação registrada.", valorCentavos: Math.abs(dv.diferencaCentavos), referencia: { tipo: "DIVERGENCIA_FONTE", id: dv.id } });
  }
  const banco = caixaEBancos(d, hoje, { inicio: per.inicio, fim: per.fim, pagina: 1, tamanho: 1 });
  for (const c of banco.contas) {
    for (const x of c.conferenciasDeSaldo.filter((y) => y.situacao === "DIVERGENTE" && y.data >= per.inicio && y.data <= per.fim)) {
      lista.push({ codigo: "SALDO_DE_CONTA_DIVERGENTE", mensagem: `Saldo de ${c.nome} informado em ${x.data} não confere com o calculado.`, valorCentavos: Math.abs(x.diferencaCentavos), referencia: { tipo: "CONTA", id: c.id } });
    }
  }
  for (const x of (apuracao?.pendencias ?? []).filter((y) => y.gravidade === "BLOQUEIO" && y.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS")) {
    lista.push({ codigo: "RECEITA_EM_DUPLICIDADE", mensagem: x.mensagem, valorCentavos: null, referencia: { tipo: "DIA", id: x.data } });
  }
  // Execução 06D — verificações que faltavam (sem política de materialidade, tudo que pode alterar o resultado bloqueia).
  // Divergência de CONCILIAÇÃO registrada e sem resolução comprovada por documento.
  for (const c of (d.correspondencias ?? []).filter((x) => x.situacao === SITUACAO_CORRESPONDENCIA.DIVERGENTE && !x.resolucao && [x.competencia, x.competenciaDaConciliacao].includes(competencia))) {
    lista.push({ codigo: "CONCILIACAO_DIVERGENTE_SEM_RESOLUCAO", mensagem: "Conciliação com diferença registrada e sem resolução comprovada por documento.", valorCentavos: Math.abs(c.diferencaCentavos ?? 0), referencia: { tipo: TIPO.CORRESPONDENCIA, id: c.id } });
  }
  // Classificação provisória que entra no resultado (descontos sem financiador comprovado, despesas a classificar).
  const provisorias = (d.lancamentos ?? []).filter((l) => l.situacao === "ATIVO" && l.competencia === competencia && CATEGORIAS_PROVISORIAS.includes(l.categoria));
  if (provisorias.length) {
    lista.push({ codigo: "CLASSIFICACAO_PROVISORIA", mensagem: `${provisorias.length} lançamento(s) com classificação provisória: a categoria definitiva pode mudar o resultado.`, valorCentavos: provisorias.reduce((s, l) => s + Math.abs(l.valorCentavos), 0), referencia: { tipo: TIPO.LANCAMENTO, id: provisorias[0].id } });
  }
  // Operações importadas ainda não aplicadas nem rejeitadas: o resultado está incompleto.
  const abertas = [ESTADO_PROPOSTA.PROPOSTA, ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA, ESTADO_PROPOSTA.AGUARDANDO_REVISAO, ESTADO_PROPOSTA.APROVADA];
  const propostas = (d.propostas ?? []).filter((x) => x.competencia === competencia && abertas.includes(x.estado));
  if (propostas.length) {
    lista.push({ codigo: "OPERACOES_IMPORTADAS_PENDENTES", mensagem: `${propostas.length} operação(ões) importada(s) ainda não aplicada(s) nem rejeitada(s).`, valorCentavos: null, referencia: { tipo: TIPO.PROPOSTA, id: propostas[0].id } });
  }
  // Importação do período ainda em validação (não confirmada nem rejeitada).
  const emValidacao = [ESTADO_IMPORTACAO.RECEBIDO, ESTADO_IMPORTACAO.EM_VALIDACAO, ESTADO_IMPORTACAO.PRONTO_PARA_IMPORTAR];
  for (const imp of (d.importacoes ?? []).filter((x) => emValidacao.includes(x.estado) && x.periodoInicio && sobrepoe(x.periodoInicio, x.periodoFim, per))) {
    lista.push({ codigo: "IMPORTACAO_NAO_CONCLUIDA", mensagem: "Importação do período ainda não confirmada nem rejeitada.", valorCentavos: null, referencia: { tipo: TIPO.IMPORTACAO, id: imp.id } });
  }
  return lista;
}

const ESTADOS_DO_FECHAMENTO = [ESTADO_COMPETENCIA.ABERTA, ESTADO_COMPETENCIA.FECHAMENTO_PRELIMINAR, ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS, ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO];

/**
 * Situação REAL do fechamento: seções de conferência, impedimentos (do núcleo) e o que exige documentação.
 * Recebíveis em aberto aparecem, mas NÃO bloqueiam.
 */
export function situacaoDoFechamento({ d, competencia, hoje, apuracao, pendencias, competenciaAtual, historico }) {
  const estado = competenciaAtual?.estado ?? ESTADO_COMPETENCIA.ABERTA;
  const impedimentos = impedimentosDeHomologacao(d, competencia, hoje, apuracao);
  const contar = (filtro) => pendencias.filter((p) => p.situacao !== SITUACAO_PENDENCIA.INFORMATIVA && filtro(p)).length;
  const fontes = fontesDaCompetencia(d, competencia);
  const per = periodoDa(competencia);
  const p = prepararTesouraria(d);
  const recebiveisAbertos = (p.recebiveis ?? []).filter((r) => r.competencia === competencia && r.situacao !== SITUACAO_TITULO.CANCELADA && r.saldoCentavos > 0);
  const obrigacoesAbertas = (p.obrigacoes ?? []).filter((o) => o.competencia === competencia && o.situacao !== SITUACAO_TITULO.CANCELADA && o.saldoCentavos > 0);
  const banco = caixaEBancos(d, hoje, { inicio: per.inicio, fim: per.fim, pagina: 1, tamanho: 1 });
  const fb = apuracao?.indicadores?.FATURAMENTO_BRUTO_PROPRIO;
  const secao = (codigo, nome, ok, resumo, efeito, extra = {}) => ({ codigo, nome, situacao: ok ? "CONFERIDO" : efeito === EFEITO_NO_FECHAMENTO.BLOQUEIA ? "BLOQUEIA" : efeito === EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA ? "EM_ABERTO_NAO_BLOQUEIA" : "PENDENTE", resumo, efeito: ok ? null : efeito, ...extra });
  const importacoesPendentes = contar((x) => ["IMPORTACAO_A_REVISAR", "FONTE_SEM_DOCUMENTO"].includes(x.codigo));
  const vendasPend = contar((x) => x.grupo === GRUPO.VENDAS_E_AJUSTES);
  const bloqueiosVendas = impedimentos.filter((x) => ["DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA", "RECEITA_EM_DUPLICIDADE"].includes(x.codigo)).length;
  const conciliacaoPend = contar((x) => x.grupo === GRUPO.CAIXA_E_CONCILIACAO);
  const saldosDivergentes = impedimentos.filter((x) => x.codigo === "SALDO_DE_CONTA_DIVERGENTE").length;
  const classificacoes = contar((x) => x.grupo === GRUPO.CLASSIFICACOES);
  const documentais = contar((x) => x.grupo === GRUPO.DOCUMENTAIS);
  const secoes = [
    secao("IMPORTACOES", "Importações", importacoesPendentes === 0, `${fontes.filter((f) => f.temDocumento).length} de ${fontes.length} relatório(s) com documento importado; ${importacoesPendentes} pendência(s).`, EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO, { fontes }),
    secao("VENDAS", "Vendas", vendasPend === 0, `Faturamento da DRE: situação ${fb?.situacao ?? "desconhecida"}; ${vendasPend} pendência(s) de vendas.`, bloqueiosVendas ? EFEITO_NO_FECHAMENTO.BLOQUEIA : EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO, { faturamento: fb ? { valorCentavos: fb.valorCentavos, situacao: fb.situacao } : null }),
    secao("CONCILIACAO_BANCARIA", "Conciliação bancária", conciliacaoPend === 0 && banco.consolidado.contasSemSaldoInformado.length === 0,
      `${banco.consolidado.contasSemSaldoInformado.length} conta(s) sem saldo informado; ${saldosDivergentes} saldo(s) divergente(s); ${conciliacaoPend} pendência(s) de caixa e conciliação.`,
      saldosDivergentes ? EFEITO_NO_FECHAMENTO.BLOQUEIA : EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO),
    secao("RECEBIVEIS", "Recebíveis", recebiveisAbertos.length === 0, `${recebiveisAbertos.length} recebível(is) em aberto. Recebível válido ainda não pago NÃO bloqueia o fechamento gerencial.`, EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA, { emAberto: recebiveisAbertos.length }),
    secao("OBRIGACOES", "Obrigações", obrigacoesAbertas.length === 0, `${obrigacoesAbertas.length} conta(s) a pagar em aberto (dívida, não bloqueio).`, EFEITO_NO_FECHAMENTO.NAO_BLOQUEIA, { emAberto: obrigacoesAbertas.length }),
    secao("CLASSIFICACOES", "Classificações pendentes", classificacoes === 0, `${classificacoes} classificação(ões) pendente(s).`, EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO),
    secao("DOCUMENTACAO", "Documentação faltante", documentais === 0, `${documentais} pendência(s) documental(is).`, EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO),
  ];
  const exigemDocumentacao = pendencias.filter((x) => x.situacao !== SITUACAO_PENDENCIA.INFORMATIVA && x.efeitoNoFechamento === EFEITO_NO_FECHAMENTO.EXIGE_DOCUMENTACAO).length;
  const i = ESTADOS_DO_FECHAMENTO.indexOf(estado);
  // 08E: a MESMA avaliação que o núcleo aplica ao homologar (resolvidas, documentadas, bloqueantes, ressalvas).
  const av = avaliarPendenciasDoFechamento({ pendencias, documentadas: competenciaAtual?.pendencias ?? [], impedimentos });
  const comPendencias = estado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS;
  const homologavel = estado !== ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO && estado !== ESTADO_COMPETENCIA.ABERTA && (comPendencias ? av.comRessalvas : av.semRessalvas);
  const resumo = (x) => ({ chave: x.chave, codigo: x.codigo, titulo: x.titulo, situacao: x.situacao, motivo: x.motivo ?? null, efeitoNoResultado: x.efeitoNoResultado ?? null, valorCentavos: x.valorCentavos ?? null, decisao: x.documentacao?.decisao ?? null, documentacaoFaltante: x.documentacao?.documentacaoFaltante ?? null });
  return {
    competencia, estado, metodologia: competenciaAtual?.metodologia ?? null, revisoes: competenciaAtual?.revisoes ?? 0,
    pendenciasDocumentadas: competenciaAtual?.pendencias ?? [], decididoEm: competenciaAtual?.decididoEm ?? null,
    responsavel: competenciaAtual?.decididoPor ? "Usuário registrado na decisão" : null,
    etapas: ESTADOS_DO_FECHAMENTO.map((e, k) => ({ estado: e, concluida: k < i, atual: k === i })),
    secoes, impedimentos, exigemDocumentacao, materialidade: POLITICA_DE_MATERIALIDADE,
    homologacao: {
      possivel: homologavel,
      automatica: false,
      comRessalvas: homologavel && comPendencias && av.ressalvas.length > 0,
      motivo: estado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO ? (competenciaAtual?.homologacao?.comRessalvas ? `Competência homologada com ${competenciaAtual.homologacao.ressalvas.length} ressalva(s).` : "Competência já homologada.")
        : estado === ESTADO_COMPETENCIA.ABERTA ? "É preciso passar pelo fechamento preliminar antes."
        : impedimentos.length ? "Há divergência relevante sem justificativa: o núcleo recusa a homologação."
        : !homologavel && av.impeditivas.length ? "Há pendências não tratadas: o núcleo recusa a homologação até resolvê-las ou documentá-las como ressalva admissível."
        : !homologavel && av.ressalvas.length ? "Há ressalvas documentadas: passe por \"Fechamento com pendências documentadas\" antes de homologar."
        : av.ressalvas.length ? "Possível com ressalvas, com decisão humana e metodologia registrada." : "Possível somente com decisão humana e metodologia registrada.",
    },
    // 08E — o que a tela de fechamento mostra separado.
    avaliacaoDasPendencias: {
      contagem: av.contagem, motivos: av.motivos, podeRegistrarComPendencias: av.podeRegistrarComPendencias && impedimentos.length === 0,
      resolvidas: av.resolvidas.map(resumo), ressalvas: av.ressalvas.map(resumo),
      bloqueantes: av.itens.filter((x) => x.situacao === "BLOQUEANTE").map(resumo),
      naoDocumentadas: av.itens.filter((x) => x.situacao === "NAO_DOCUMENTADA").map(resumo),
      semEvidencia: av.itens.filter((x) => x.situacao === "SEM_EVIDENCIA_SUFICIENTE").map(resumo),
    },
    homologacaoRegistrada: competenciaAtual?.homologacao ?? null,
    historico: (historico ?? []).map((h) => ({ evento: h.evento, em: h.em, de: h.antes?.estado ?? null, para: h.depois?.estado ?? null, justificativa: h.justificativa ?? null, metodologia: h.depois?.metodologia ?? null })),
  };
}

