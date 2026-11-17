// doc 35 — tabela de TAXAS CONTRATADAS (Stone) guardada na configuração da unidade, com vigência e fonte, e a conferência
// transação a transação contra os registros importados do relatório de vendas Stone. Sem migração: a tabela vive no
// campo de extensão da configuração da unidade (histórico e versão como qualquer alteração de configuração).
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, ESTADO_PROPOSTA, OPERACAO_PROPOSTA, SITUACAO_LANCAMENTO, SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { conferirTaxas, validarTabelaDeTaxas } from "../dominio/taxasContratadas.js";
import { SITUACAO_OPERADORA, codigoDeOperadora, operadorasEfetivas, validarOperadora } from "../dominio/operadoras.js";
import { exigirCompetencia, exigirData } from "../dominio/tempo.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

/** Chave do lançamento das taxas do período de UMA importação Stone numa competência (uma vez só). */
export const chaveDasTaxasDoPeriodo = (importacaoId, competencia) => `taxas-do-periodo:${importacaoId}:${competencia}`;
const centavosDeMicros = (m) => Math.floor((m + 5000) / 10000);
/**
 * Versões do lançamento das taxas do período (a 1ª usa a chave base; depois de um estorno, "#2", "#3"…): devolve a ATIVA
 * (se houver) e a próxima chave livre. Assim o estorno autorizado permite reconhecer de novo — sem as transações que,
 * entretanto, passaram a ter a taxa reconhecida por venda — sem nunca reaproveitar a chave de um lançamento cancelado.
 */
export async function taxasDoPeriodo(tx, cx, importacaoId, competencia) {
  const base = chaveDasTaxasDoPeriodo(importacaoId, competencia);
  for (let k = 1; k < 1000; k += 1) {
    const chave = k === 1 ? base : `${base}#${k}`;
    const l = await tx.buscarPorChave(cx, TIPO.LANCAMENTO, chave);
    if (!l) return { ativa: null, proximaChave: chave, versoes: k - 1 };
    if (l.situacao === SITUACAO_LANCAMENTO.ATIVO) return { ativa: l, proximaChave: null, versoes: k };
  }
  falhar(CODIGO.OPERACAO_INVALIDA, "Versões demais das taxas do período.");
}

export function operacoesDeTaxasContratadas(b) {
  const tabelasDa = (config) => (Array.isArray(config?.taxasContratadas) ? config.taxasContratadas : []);
  return {
    /** Registra uma versão da tabela contratada. Vigências do mesmo processador não se sobrepõem; nada é apagado. */
    registrarTaxasContratadas(ctx, entrada) {
      const t = validarTabelaDeTaxas(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!atual) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade (nome de exibição) antes de registrar a tabela de taxas.");
        const tabelas = tabelasDa(atual);
        const { justificativa, ...tabela } = t;
        const igual = tabelas.find((x) => x.processador === tabela.processador && x.vigenciaInicio === tabela.vigenciaInicio);
        const chaveDasTaxas = (l) => l.map((x) => `${x.modalidade}|${x.bandeira}|${x.milesimos}|${x.tarifaFixaCentavos ?? 0}`).sort().join(",");
        if (igual && chaveDasTaxas(igual.taxas) === chaveDasTaxas(tabela.taxas) && (igual.vigenciaFim ?? null) === tabela.vigenciaFim) return { tabela: igual, repetido: true };
        const sobrepoe = tabelas.some((x) => x.processador === tabela.processador && x.vigenciaInicio <= (tabela.vigenciaFim ?? "9999-12-31") && tabela.vigenciaInicio <= (x.vigenciaFim ?? "9999-12-31"));
        if (sobrepoe) falhar(CODIGO.OPERACAO_INVALIDA, "Já há tabela deste processador com vigência sobreposta: encerre a anterior (vigência final) antes.", { processador: tabela.processador });
        const nova = { ...tabela, registradaEm: b.agora(), registradaPor: cx.usuarioId };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { taxasContratadas: [...tabelas, nova] }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { tabela: nova, repetido: false };
      });
    },

    /**
     * Fase 02 — cadastra uma OPERADORA da unidade (Stone, PagBank, maquininha do iFood…). Mesmo código = mesma operadora:
     * repetir igual não faz nada; dados diferentes exigem a alteração de situação/encerramento (nada é sobrescrito).
     */
    registrarOperadora(ctx, entrada) {
      const o = validarOperadora(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!atual) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade (nome de exibição) antes de cadastrar operadoras.");
        const lista = Array.isArray(atual.operadoras) ? atual.operadoras : [];
        const { justificativa, ...dados } = o;
        const existente = lista.find((x) => x.codigo === dados.codigo);
        if (existente) {
          const mesmo = ["nome", "processador", "inicio", "encerramento"].every((k) => (existente[k] ?? null) === (dados[k] ?? null)) && existente.modalidades.join() === dados.modalidades.join();
          if (mesmo) return { operadora: existente, repetido: true };
          falhar(CODIGO.OPERACAO_INVALIDA, "Já existe operadora com este código: para mudar, encerre ou desative a existente (o histórico é preservado).", { codigo: dados.codigo });
        }
        const nova = { ...dados, situacao: SITUACAO_OPERADORA.ATIVA, historico: [{ evento: "CADASTRO", em: b.agora(), por: cx.usuarioId, justificativa }] };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { operadoras: [...lista, nova] }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { operadora: nova, repetido: false };
      });
    },

    /** Ativa/desativa uma operadora ou define o encerramento — sem apagar nada; vendas já registradas guardam a versão usada. */
    alterarSituacaoOperadora(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["codigo", "situacao", "encerramento", "nome", "observacao", "justificativa"], "situacaoOperadora");
      const codigo = codigoDeOperadora(entrada.codigo, "codigo");
      const situacao = entrada.situacao === undefined ? null : String(entrada.situacao).toUpperCase();
      if (situacao !== null && !SITUACAO_OPERADORA[situacao]) falhar(CODIGO.ENTRADA_INVALIDA, "situacao: use ATIVA ou INATIVA.", { campo: "situacao" });
      const encerramento = entrada.encerramento === undefined ? undefined : entrada.encerramento === null ? null : exigirData(entrada.encerramento, "encerramento");
      const nome = entrada.nome === undefined ? undefined : exigirTexto(entrada.nome, "nome", { max: 80 });
      const observacao = entrada.observacao === undefined ? undefined : exigirTexto(entrada.observacao, "observacao", { max: 300, opcional: true }) ?? null;
      if (situacao === null && encerramento === undefined && nome === undefined && observacao === undefined) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o que muda (situação, encerramento, nome ou observação).");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const lista = Array.isArray(atual?.operadoras) ? atual.operadoras : [];
        const o = lista.find((x) => x.codigo === codigo);
        if (!o) falhar(CODIGO.NAO_ENCONTRADO, "Operadora não cadastrada nesta unidade.", { codigo });
        if (encerramento && encerramento < o.inicio) falhar(CODIGO.DATA_INVALIDA, "Encerramento antes do início da operadora.", { campo: "encerramento" });
        const mudou = { ...(situacao !== null ? { situacao } : {}), ...(encerramento !== undefined ? { encerramento } : {}), ...(nome !== undefined && nome !== o.nome ? { nome } : {}), ...(observacao !== undefined ? { observacao } : {}) };
        const nova = { ...o, ...mudou, historico: [...(o.historico ?? []), { evento: "ALTERACAO", ...mudou, antes: { situacao: o.situacao, encerramento: o.encerramento ?? null, nome: o.nome }, em: b.agora(), por: cx.usuarioId, justificativa }] };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { operadoras: lista.map((x) => (x.codigo === codigo ? nova : x)) }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { operadora: nova };
      });
    },

    /** Operadoras da unidade (cadastradas + implícitas das tabelas legadas) com as tabelas de taxas de cada uma. */
    consultarOperadoras(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const tabelas = tabelasDa(config);
        return { operadoras: operadorasEfetivas(config).map((o) => ({ ...o, tabelas: tabelas.filter((t) => (t.operadora ?? t.processador) === o.codigo) })) };
      });
    },

    /**
     * doc 36 — TAXAS DO PERÍODO: reconhece na DRE, UMA vez por importação Stone e competência, a soma EXATA das tarifas
     * efetivamente cobradas (milionésimos informados pela Stone, arredondada uma única vez) das transações que NÃO têm a
     * taxa reconhecida por venda (faturamento por total do período, sem pedidos). Despesa de recebimento/processamento,
     * pela competência da transação. Nem o bruto nem o líquido viram receita. Idempotente; estornável; a aplicação posterior
     * de pagamentos Stone por venda da mesma importação é recusada enquanto este lançamento estiver ativo.
     */
    reconhecerTaxasDoPeriodo(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "justificativa"], "taxasDoPeriodo");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.APLICAR, async (cx, tx) => {
        const imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, importacaoId, "Importação");
        if (imp.fonte !== "STONE" || imp.tipoRelatorio !== "STONE_VENDAS") falhar(CODIGO.OPERACAO_INVALIDA, "Só a importação do relatório de vendas Stone tem taxas por transação.");
        const registros = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } }))
          .filter((r) => r.tipoRegistro === "TRANSACAO" && r.dados?.situacao === "APROVADA");
        if (!registros.length) falhar(CODIGO.OPERACAO_INVALIDA, "A importação não tem transações aprovadas confirmadas.");
        // Transações cuja taxa JÁ entrou por venda (pagamento Stone aplicado) ficam de fora: nunca duas vezes.
        const porVenda = new Set((await tx.listar(cx, TIPO.PROPOSTA, { onde: { importacaoId, operacao: OPERACAO_PROPOSTA.PAGAMENTO_STONE, estado: ESTADO_PROPOSTA.APLICADA } })).flatMap((p) => p.registroIds ?? []));
        const porComp = new Map();
        for (const r of registros.filter((x) => !porVenda.has(x.id))) {
          if (!porComp.has(r.competencia)) porComp.set(r.competencia, []);
          porComp.get(r.competencia).push(r);
        }
        const categoria = (await b.categoriaPorCodigo(tx, cx, "TAXAS_STONE")) ? await b.categoriaLancavel(tx, cx, "TAXAS_STONE") : await b.categoriaLancavel(tx, cx, "TAXAS_DE_PROCESSAMENTO");
        const resultado = [];
        for (const [competencia, lista] of [...porComp.entries()].sort()) {
          await tx.travar(cx, `formacao-competencia:${competencia}`, "EXCLUSIVA");
          const { ativa, proximaChave: chave } = await taxasDoPeriodo(tx, cx, importacaoId, competencia);
          if (ativa) { resultado.push({ competencia, lancamento: ativa, repetido: true }); continue; }
          await b.exigirCompetenciaEditavel(tx, cx, competencia);
          const conferencia = conferirTaxas(lista.map((r) => ({ id: r.idExterno ?? r.id, data: r.dataReferencia, dados: r.dados })), []);
          const microsCobrados = lista.reduce((s, r) => s + (r.dados.descontoInformadoMicros ?? (r.dados.taxaInformadaCentavos ?? 0) * 10000), 0);
          const valorCentavos = centavosDeMicros(microsCobrados);
          if (valorCentavos <= 0) { resultado.push({ competencia, lancamento: null, semTaxa: true }); continue; }
          const ultimoDia = lista.map((r) => r.dataReferencia).sort().at(-1);
          const lancamento = await b.lancar(tx, cx, categoria, {
            valorCentavos, moeda: "BRL", descricao: `Taxas Stone de ${competencia} (${lista.length} transações; soma exata das tarifas informadas)`,
            dataOperacao: ultimoDia, competencia, fonte: { sistema: "STONE", idExterno: chave }, origem: { tipo: TIPO.IMPORTACAO, id: importacaoId },
            chaveIdempotencia: chave, impressao: null,
            taxasDoPeriodo: {
              criterio: "Competência da transação (data da venda na Stone); valor = soma exata das tarifas efetivamente cobradas, arredondada uma vez.",
              natureza: "Despesa de recebimento/processamento (tarifa da adquirente). O bruto e o líquido da Stone não são receita.",
              justificativa, transacoes: lista.length, microsCobrados, brutoCentavos: conferencia.total.brutoCentavos, liquidoInformadoCentavos: conferencia.total.liquidoInformadoCentavos,
              composicao: conferencia.composicao.map((g) => ({ modalidade: g.modalidade, bandeira: g.bandeira, transacoes: g.transacoes, brutoCentavos: g.brutoCentavos, cobradoCentavos: g.cobradoCentavos, liquidoInformadoCentavos: g.liquidoInformadoCentavos })),
              excluidasPorVenda: porVenda.size,
            },
          }, { documentado: true });
          resultado.push({ competencia, lancamento, repetido: false });
        }
        return { importacaoId, resultado };
      });
    },

    /** Estorno AUTORIZADO das taxas do período (lançamento cancelado, nunca apagado), p.ex. para substituir por vendas detalhadas. */
    estornarTaxasDoPeriodo(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "competencia", "justificativa"], "estornoTaxasDoPeriodo");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const competencia = exigirCompetencia(entrada.competencia);
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        await tx.travar(cx, `formacao-competencia:${competencia}`, "EXCLUSIVA");
        const l = (await taxasDoPeriodo(tx, cx, importacaoId, competencia)).ativa;
        if (!l) falhar(CODIGO.NAO_ENCONTRADO, "Não há taxas do período ativas para esta importação e competência.");
        return { lancamento: await b.cancelarLancamento(tx, cx, l.id, justificativa) };
      });
    },

    /** Composição por modalidade × bandeira da competência: contratado × cobrado × líquido informado, por transação. */
    consultarTaxasContratadas(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["competencia", "processador"], "consulta");
      const competencia = exigirCompetencia(entrada.competencia);
      const processador = String(entrada.processador ?? "STONE").toUpperCase();
      return b.consultar(ctx, async (cx, tx) => {
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const tabelas = tabelasDa(config).filter((x) => x.processador === processador);
        const registros = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: processador, tipoRegistro: "TRANSACAO", competencia } }))
          .filter((r) => r.situacao !== SITUACAO_REGISTRO_FONTE.SUBSTITUIDO && r.dados?.situacao === "APROVADA");
        const conferencia = conferirTaxas(registros.map((r) => ({ id: r.idExterno ?? r.id, data: r.dataReferencia, dados: r.dados })), tabelas, { processador });
        const reconhecimento = [];
        for (const importacaoId of [...new Set(registros.map((r) => r.importacaoId))]) {
          const v = await taxasDoPeriodo(tx, cx, importacaoId, competencia);
          reconhecimento.push({ importacaoId, situacao: v.ativa ? "RECONHECIDA" : v.versoes ? "ESTORNADA" : "NAO_RECONHECIDA", lancamentoId: v.ativa?.id ?? null, valorCentavos: v.ativa?.valorCentavos ?? null });
        }
        return { competencia, processador, tabelas, ...conferencia, reconhecimento };
      });
    },
  };
}
