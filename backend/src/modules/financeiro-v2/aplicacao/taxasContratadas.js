// doc 35 — tabela de TAXAS CONTRATADAS (Stone) guardada na configuração da unidade, com vigência e fonte, e a conferência
// transação a transação contra os registros importados do relatório de vendas Stone. Sem migração: a tabela vive no
// campo de extensão da configuração da unidade (histórico e versão como qualquer alteração de configuração).
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { conferirTaxas, validarTabelaDeTaxas } from "../dominio/taxasContratadas.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";

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
        const chaveDasTaxas = (l) => l.map((x) => `${x.modalidade}|${x.bandeira}|${x.milesimos}`).sort().join(",");
        if (igual && chaveDasTaxas(igual.taxas) === chaveDasTaxas(tabela.taxas) && (igual.vigenciaFim ?? null) === tabela.vigenciaFim) return { tabela: igual, repetido: true };
        const sobrepoe = tabelas.some((x) => x.processador === tabela.processador && x.vigenciaInicio <= (tabela.vigenciaFim ?? "9999-12-31") && tabela.vigenciaInicio <= (x.vigenciaFim ?? "9999-12-31"));
        if (sobrepoe) falhar(CODIGO.OPERACAO_INVALIDA, "Já há tabela deste processador com vigência sobreposta: encerre a anterior (vigência final) antes.", { processador: tabela.processador });
        const nova = { ...tabela, registradaEm: b.agora(), registradaPor: cx.usuarioId };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { taxasContratadas: [...tabelas, nova] }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { tabela: nova, repetido: false };
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
        return { competencia, processador, tabelas, ...conferencia };
      });
    },
  };
}
