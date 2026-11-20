// Dados SINTÉTICOS do Centro Financeiro (Execução 01 do MOVA). Mesmo formato que o módulo backend/src/modules/mova-financeiro
// produz (propostas, histórico, configuração), para que a próxima execução troque esta fonte pela API sem mudar as telas.
// Nada aqui é real: unidades "Alfa/Beta/Gama", fornecedores, valores e datas inventados.

export const UNIDADES = Object.freeze([
  { unidadeId: "alfa", nome: "Unidade Alfa", fontes: { situacao: "CONFIRMADA", canais: { BALCAO: "SWF", IFOOD: "IFOOD (oficial)", NOVENTA_E_NOVE_FOOD: "99Food (oficial)" } } },
  { unidadeId: "beta", nome: "Unidade Beta", fontes: { situacao: "A_CONFIRMAR", canais: {} } },
  { unidadeId: "gama", nome: "Unidade Gama", fontes: { situacao: "CONFIRMADA", canais: { BALCAO: "SAIPOS", ANOTA_AI: "SAIPOS", IFOOD: "IFOOD (oficial)" } } },
]);

export const CONFIGURACAO = Object.freeze({
  modo: "SIMULACAO",
  provedor: { atual: "Gateway próprio (Baileys) — grupo ainda não lido", alternativo: "Evolution API — adaptador pronto, sem instância" },
  grupos: [
    { rotulo: "Grupo administrativo (…0001)", unidades: ["alfa", "beta", "gama"], leitura: "DESLIGADA" },
  ],
  vinculos: [
    { participante: "…0001", usuario: "Usuário sintético 1", unidades: { alfa: ["ver", "enviar_documento"], beta: ["ver", "enviar_documento"], gama: ["ver", "enviar_documento"] } },
    { participante: "…0002", usuario: "Usuário sintético 2", unidades: { alfa: ["ver", "enviar_documento"] } },
  ],
});

export const CAIXA_DE_ENTRADA = Object.freeze([
  { em: "2026-10-15T09:12:00Z", unidadeId: "gama", tipo: "IMAGEM", resumo: "Comprovante com legenda", decisao: "PROPOSTA", motivo: "DESPESA_PAGA" },
  { em: "2026-10-15T09:20:00Z", unidadeId: "alfa", tipo: "DOCUMENTO", resumo: "Boleto (PDF)", decisao: "PROPOSTA", motivo: "NOVA_OBRIGACAO" },
  { em: "2026-10-15T09:41:00Z", unidadeId: null, tipo: "IMAGEM", resumo: "Comprovante sem unidade", decisao: "PEDIR_INFORMACAO", motivo: "UNIDADE_NAO_IDENTIFICADA" },
  { em: "2026-10-15T10:03:00Z", unidadeId: "alfa", tipo: "IMAGEM", resumo: "Comprovante já recebido", decisao: "DUPLICADO", motivo: "DOCUMENTO_JA_RECEBIDO" },
  { em: "2026-10-15T10:30:00Z", unidadeId: "alfa", tipo: "TEXTO", resumo: "Pedido de pagamento", decisao: "BLOQUEADO", motivo: "INTENCAO_PROIBIDA:PEDIR_PAGAMENTO" },
  { em: "2026-10-15T11:05:00Z", unidadeId: "alfa", tipo: "IMAGEM", resumo: "Comprovante de conta existente", decisao: "PROPOSTA", motivo: "BAIXA_DE_OBRIGACAO" },
]);

export const PROPOSTAS = Object.freeze([
  { id: "a1b2c3d4", unidadeId: "gama", tipo: "DESPESA_PAGA", estado: "AGUARDANDO_REVISAO", valorCentavos: 12345, favorecido: "Fornecedor Sintético Um", datas: { competencia: "2026-09", caixa: "2026-10-10" }, categoriaSugerida: "INSUMOS", confianca: "ALTA", sinaisDeInjecao: false },
  { id: "b2c3d4e5", unidadeId: "alfa", tipo: "NOVA_OBRIGACAO", estado: "AGUARDANDO_REVISAO", valorCentavos: 48000, favorecido: "Fornecedor Sintético Dois", datas: { competencia: "2026-10", vencimento: "2026-10-30" }, categoriaSugerida: "ALUGUEL", confianca: "MEDIA", sinaisDeInjecao: false },
  { id: "c3d4e5f6", unidadeId: "alfa", tipo: "BAIXA_DE_OBRIGACAO", estado: "AGUARDANDO_REVISAO", valorCentavos: 5000, parcial: true, favorecido: "Fornecedor Sintético Um", datas: { competencia: "2026-09", caixa: "2026-10-05" }, categoriaSugerida: null, confianca: "ALTA", sinaisDeInjecao: true },
]);

export const HISTORICO = Object.freeze([
  ...CAIXA_DE_ENTRADA.map((e, i) => ({ ...e, id: `h${i + 1}` })),
  { id: "h7", em: "2026-10-15T11:20:00Z", unidadeId: null, tipo: "IMAGEM", resumo: "Grupo não autorizado", decisao: "IGNORADO", motivo: "GRUPO_NAO_AUTORIZADO" },
]);
