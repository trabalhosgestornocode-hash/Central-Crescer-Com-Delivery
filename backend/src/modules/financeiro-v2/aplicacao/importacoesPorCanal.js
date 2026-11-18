// Fase 11 (doc 48) — IMPORTAÇÕES POR CANAL: o que cada área de faturamento (SAIPOS, iFood, 99Food) pode importar, em que estado
// está cada formato e o histórico do canal. Só leitura, sem importador novo: o envio de arquivo, a prévia e a confirmação são os
// MESMOS da Central (receberArquivoParaImportacao, confirmarImportacao); o demonstrativo iFood usa o registro oficial existente.
//
// Regra de honestidade: só aparece como DISPONÍVEL o que existe de verdade e está liberado para envio. Formato sem leitor validado
// aparece como INDISPONÍVEL, com o motivo; nada é "adivinhado" e nada indisponível pode ser confirmado.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_IMPORTACAO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { demonstrativosDoIfood } from "./canalPlataforma.js";
import { nomeDoRelatorio } from "./conferencias.js";

export const CANAIS_DE_IMPORTACAO = Object.freeze(["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);

/**
 * Catálogo de formatos por canal. `arquivo: true` = envio de arquivo liberado (o tipo precisa estar também em FONTE_DO_RELATORIO, da
 * camada HTTP: um teste confere as duas listas). `disponivel: false` = ainda não existe leitor validado: o motivo vai para a tela.
 */
export const FORMATOS_POR_CANAL = Object.freeze({
  SAIPOS: Object.freeze([
    { id: "SAIPOS_VENDAS", tipoRelatorio: "SAIPOS_VENDAS", nome: "Vendas por período (XLSX, por pedido)", principal: true, arquivo: true, disponivel: true,
      descricao: "Um registro por pedido. Alimenta o Presencial e o Anota Aí. Pedidos de iFood e 99Food do relatório ficam só como conferência: nunca viram faturamento." },
    { id: "SAIPOS_FORMAS_PAGAMENTO", tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", nome: "Formas de pagamento (XLSX, por dia)", principal: false, arquivo: true, disponivel: true,
      descricao: "Uma venda por dia e forma. Não convive com o relatório por pedido nos mesmos dias (a aplicação recusa o segundo)." },
    { id: "SAIPOS_DESEMPENHO_POR_ATENDENTE", tipoRelatorio: "SAIPOS_DESEMPENHO_POR_ATENDENTE", nome: "Canais de venda (desempenho por atendente)", principal: false, arquivo: true, disponivel: true,
      descricao: "Total do período por canal, sem pedidos. Não convive com pedidos do mesmo canal e período." },
    { id: "SAIPOS_FATURAMENTO_POR_DIA", tipoRelatorio: "SAIPOS_FATURAMENTO_POR_DIA", nome: "Faturamento por dia (PDF)", principal: false, arquivo: true, disponivel: true,
      descricao: "Total por dia, sem pedidos nem canal. Receita agregada, quando a metodologia do valor está comprovada." },
    { id: "SAIPOS_MOVIMENTOS_CAIXA", tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", nome: "Movimentações de Frente de Caixa (XLSX do Financeiro)", principal: false, arquivo: true, disponivel: true,
      descricao: "Retiradas (sangrias), reforços e transferências em dinheiro. Importar não lança nada. Depois você lança as retiradas como despesas pagas em dinheiro (fornecedor Sangrias, Outras despesas); reforço e transferência não são despesa. Nunca é faturamento.",
      dica: "Na SAIPOS: Lançamentos financeiros, categoria Frente de Caixa, descrição Retirada (para reforços, descrição Reforço). Exporte em XLSX." },
  ]),
  IFOOD: Object.freeze([
    { id: "IFOOD_CONCILIACAO", tipoRelatorio: "IFOOD_CONCILIACAO", nome: "Conciliação Financeira do iFood (XLSX)", principal: true, arquivo: true, disponivel: true,
      descricao: "Relatório oficial por movimento. Importar só guarda as linhas; depois a prévia mostra o faturamento, as despesas e os repasses antes de aplicar ao Financeiro.",
      dica: "No Portal do Parceiro do iFood: Financeiro, Conciliação. Exporte o mês em XLSX." },
    { id: "IFOOD_DEMONSTRATIVO", tipoRelatorio: null, nome: "Demonstrativo financeiro oficial do iFood", principal: false, arquivo: false, disponivel: true, modo: "DEMONSTRATIVO",
      descricao: "Você informa os valores do demonstrativo oficial do período. O sistema confere a conta, mostra a prévia e só então registra o faturamento, as retenções e o repasse previsto." },
    { id: "IFOOD_APURACAO", tipoRelatorio: "IFOOD_APURACAO", nome: "Apuração financeira do iFood (arquivo)", principal: false, arquivo: false, disponivel: false,
      motivo: "O leitor deste arquivo existe só como contrato sintético: ainda não foi validado com um arquivo oficial real. O envio fica bloqueado até essa validação." },
    { id: "IFOOD_PEDIDOS", tipoRelatorio: null, nome: "Relatório oficial de pedidos do iFood", principal: false, arquivo: false, disponivel: false,
      motivo: "Ainda não existe leitor do relatório oficial de pedidos do iFood. Precisamos de um arquivo oficial real para validar o layout; sem ele, o detalhe diário não é processado." },
  ]),
  NOVENTA_E_NOVE_FOOD: Object.freeze([
    { id: "NOVENTA_E_NOVE_FOOD_RELATORIO", tipoRelatorio: "NOVENTA_E_NOVE_FOOD_RELATORIO", nome: "Relatório oficial da 99Food (XLSX ou ZIP)", principal: true, arquivo: true, disponivel: true,
      descricao: "Dados da loja por dia. Importar só guarda as linhas; depois a prévia mostra o que entra na DRE e o que fica em conferência antes de aplicar.",
      dica: "Envie o arquivo Dados da loja exportado pela 99Food, em XLSX ou no ZIP original." },
  ]),
});

// A 99Food entra como fonte "OUTRO" (sem migração); o tipo do relatório identifica o canal.
const FONTE_DO_CANAL = Object.freeze({ SAIPOS: "SAIPOS", IFOOD: "IFOOD", NOVENTA_E_NOVE_FOOD: "OUTRO" });

export function operacoesDeImportacoesPorCanal(b, { fontes }) {
  return {
    consultarImportacoesDoCanal(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["canal"], "consulta");
      const canal = String(entrada.canal ?? "").toUpperCase();
      if (!CANAIS_DE_IMPORTACAO.includes(canal)) falhar(CODIGO.ENTRADA_INVALIDA, `canal: ${CANAIS_DE_IMPORTACAO.join(", ")}.`, { campo: "canal" });
      return b.consultar(ctx, async (cx, tx) => {
        const hoje = b.hoje();
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const compat = new Map(fontes.compatibilidade().map((f) => [f.tipoRelatorio, f]));
        const formatos = FORMATOS_POR_CANAL[canal].map((f) => {
          const c = f.tipoRelatorio ? compat.get(f.tipoRelatorio) : null;
          return {
            id: f.id, tipoRelatorio: f.tipoRelatorio, nome: f.nome, principal: f.principal, descricao: f.descricao ?? null, dica: f.dica ?? null, modo: f.modo ?? (f.arquivo ? "ARQUIVO" : null),
            disponivel: f.disponivel, motivo: f.motivo ?? null, aceitaArquivo: f.arquivo === true && f.disponivel === true,
            extensoes: c ? [...c.formatos] : [], homologado: c ? c.formatosHomologados.length > 0 : false, extensoesHomologadas: c ? [...c.formatosHomologados] : [],
          };
        });
        const importacoes = (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: FONTE_DO_CANAL[canal] } }))
          .filter((i) => canal !== "NOVENTA_E_NOVE_FOOD" || i.tipoRelatorio === "NOVENTA_E_NOVE_FOOD_RELATORIO")
          .sort((a, x) => String(x.criadoEm).localeCompare(String(a.criadoEm))).slice(0, 40)
          .map((i) => ({
            id: i.id, tipoRelatorio: i.tipoRelatorio, relatorio: nomeDoRelatorio(i.tipoRelatorio), periodoInicio: i.periodoInicio, periodoFim: i.periodoFim,
            estado: i.estado, criadoEm: i.criadoEm, erros: i.previa?.totalErros ?? 0, divergencias: i.previa?.totalDivergencias ?? 0, jaExistentes: i.previa?.contagens?.jaImportados ?? 0,
          }));
        const demonstrativos = canal === "IFOOD" ? (await demonstrativosDoIfood(tx, cx, hoje)).map((d) => ({
          id: d.id, periodoInicio: d.periodoInicio, periodoFim: d.periodoFim, brutoCentavos: d.brutoCentavos, comissoesCentavos: d.comissoesCentavos, taxasCentavos: d.taxasCentavos,
          mensalidadesCentavos: d.mensalidadesCentavos, descontosEPromocoesCentavos: d.descontosEPromocoesCentavos, ajustesCentavos: d.ajustesCentavos,
          repassePrevistoCentavos: d.repassePrevistoCentavos, repasseRecebidoCentavos: d.repasseRecebidoCentavos, situacaoRepasse: d.situacaoRepasse, registradoEm: d.registradoEm,
        })) : [];
        const porEstado = {};
        for (const i of importacoes) porEstado[i.estado] = (porEstado[i.estado] ?? 0) + 1;
        const tem = (a) => (ctx.permissoes ?? []).includes(a);
        return {
          canal, hoje, unidade: { nome: config?.nomeExibicao ?? null },
          acoes: { importar: tem(ACAO.IMPORTAR), confirmar: tem(ACAO.CONFIRMAR_IMPORTACAO) || tem(ACAO.IMPORTAR), registrarDemonstrativo: tem(ACAO.REGISTRAR) },
          formatos, historico: importacoes, demonstrativos, porEstado,
          estadosAguardando: [ESTADO_IMPORTACAO.PRONTO_PARA_IMPORTAR],
          algumFormatoDisponivel: formatos.some((f) => f.disponivel),
        };
      });
    },
  };
}
