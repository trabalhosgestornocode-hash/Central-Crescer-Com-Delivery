// Importações financeiras: receber → validar → PRÉVIA → confirmação autorizada → gravar em transação → relatório.
//
// Princípios:
//   - receber um arquivo NÃO grava operação financeira nenhuma: guarda o original no cofre, registra a ficha do documento
//     e a importação com sua prévia. Só a confirmação (permissão financeiro_v2.importar + impressão da prévia revisada)
//     grava os registros de fonte — e mesmo eles NÃO são vendas, despesas nem saldos: importar ≠ confirmar ≠ conciliar.
//   - a confirmação RELÊ o arquivo do cofre (com conferência de hash) e refaz a análise: se algo mudou desde a prévia
//     (outra importação entrou, o arquivo foi adulterado), a confirmação é recusada;
//   - divergências nunca são "acertadas": ficam na prévia e no relatório; confirmar com pendências exige aceite e justificativa;
//   - a mesma origem não entra duas vezes (chave fonte + tipo + identificador, única por escopo no banco);
//   - versão corrigida de um relatório entra como SUBSTITUIÇÃO explícita: os registros anteriores ficam marcados como
//     substituídos (nunca apagados) e a nova importação passa a valer.
import { exigirFonteDaUnidade, fontesDaUnidade } from "./fontesDeFaturamento.js";
import { ehRelatorioSwf } from "../importacao/fontes/swf.js";
import { CODIGO, ErroFinanceiro, falhar } from "../dominio/erros.js";
import { CONFERENCIA_REGISTRO, ESTADO_IMPORTACAO as E, EVENTO_HISTORICO, SITUACAO_CORRESPONDENCIA, SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, subtrair } from "../dominio/dinheiro.js";
import { exigirCofre } from "../contratos/cofre.js";
import {
  validarConfirmacaoDeImportacao, validarGeracaoDeCandidatas, validarLeituraDeDocumento, validarPeriodo, validarRecebimentoDeArquivo,
  validarReferenciaDeImportacao,
} from "../contratos/importacao.js";
import { DIVERGENCIA, analisarArquivo, canonico, sha256 } from "../importacao/motor.js";
import { proporCandidatas } from "../importacao/correspondencias.js";

const CONCLUIDAS = [E.IMPORTADO, E.IMPORTADO_COM_PENDENCIAS];
const LIMITE_LISTA = 200;

/** Meses tocados pelo período (para a guarda de fechamento). */
function competenciasDoPeriodo(inicio, fim) {
  const lista = [];
  let [a, m] = inicio.slice(0, 7).split("-").map(Number);
  const [af, mf] = fim.slice(0, 7).split("-").map(Number);
  while (a < af || (a === af && m <= mf)) {
    lista.push(`${a}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return lista;
}

const somaDias = (data, dias) => new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);

/**
 * @param {object} b base (aplicacao/base.js)
 * @param {object} deps
 * @param {object} [deps.cofre] porta do cofre de documentos (obrigatória para importar e ler originais)
 * @param {object} deps.fontes registro de adaptadores (importacao/fontes/index.js)
 * @param {(escopo, fonte) => string[]|null} [deps.estabelecimentosDaUnidade] identificadores de estabelecimento cadastrados
 * @param {{registrar: Function}} deps.acessosNegados registro de tentativas de acesso negadas (sem conteúdo de documento)
 */
export function operacoesDeImportacao(b, { cofre, fontes, estabelecimentosDaUnidade, acessosNegados }) {
  const exigirOCofre = () => {
    if (!cofre) falhar(CODIGO.COFRE_INDISPONIVEL, "Importações exigem um cofre de documentos privado configurado.");
    return exigirCofre(cofre);
  };

  /** Analisa o arquivo e o confronta com o que já foi gravado no escopo (sem gravar nada). */
  async function montarPrevia(tx, cx, imp, adaptador, bytes) {
    // SWF: a loja que o SWF imprime precisa ser uma das lojas cadastradas nas fontes de faturamento da unidade.
    const lojasSwf = ehRelatorioSwf(adaptador.tipoRelatorio) ? fontesDaUnidade(await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade")).lojasSwf : [];
    const analise = analisarArquivo({
      bytes, adaptador, periodo: { inicio: imp.periodoInicio, fim: imp.periodoFim },
      estabelecimentosDaUnidade: lojasSwf.length ? lojasSwf : estabelecimentosDaUnidade?.(cx, adaptador.fonte) ?? null,
    });
    // Relatórios que sabem detectar contradição com importações anteriores (ex.: movimentações de caixa): divergência que exige aceite explícito;
    // as linhas anteriores ausentes neste arquivo só são substituídas na CONFIRMAÇÃO aceita, nunca antes (e nunca apagadas: ficam no histórico).
    let contradicoes = { divergencias: [], ausentes: [] };
    if (adaptador.conflitosComImportadas && analise.registros.length) {
      const anteriores = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: imp.fonte, tipoRelatorio: imp.tipoRelatorio } }))
        .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.importacaoId !== imp.id && r.importacaoId !== imp.substituiImportacaoId);
      contradicoes = adaptador.conflitosComImportadas({ registros: analise.registros, anteriores, periodo: { inicio: imp.periodoInicio, fim: imp.periodoFim } });
    }
    const novos = [];
    const jaImportados = [];
    const conflitos = [];
    // Uma consulta por lote de chaves (antes: uma ida ao banco por linha do arquivo).
    const gravados = await tx.buscarPorChaves(cx, TIPO.REGISTRO_FONTE, analise.registros.map((r) => r.chave));
    for (const r of analise.registros) {
      const existente = gravados.get(r.chave) ?? null;
      if (!existente || (imp.substituiImportacaoId && existente.importacaoId === imp.substituiImportacaoId)) novos.push(r);
      else if (existente.impressao === r.impressao) jaImportados.push(r);
      else conflitos.push(r);
    }
    const divergencias = [
      ...analise.divergencias,
      ...conflitos.map((r) => ({ codigo: DIVERGENCIA.CONFLITO_COM_IMPORTADO, mensagem: `Linha ${r.linha}: esta origem já foi importada com conteúdo diferente (envie como versão corrigida).`, linha: r.linha })),
      ...contradicoes.divergencias,
    ];
    const impressao = sha256(canonico({
      importacao: imp.id, documento: imp.documentoId, erros: analise.erros, divergencias, substituir: contradicoes.ausentes.map((r) => r.id),
      novos: novos.map((r) => [r.chave, r.impressao]), jaImportados: jaImportados.map((r) => r.chave), conflitos: conflitos.map((r) => r.chave),
    }));
    const resumo = {
      reconhecido: analise.reconhecido, compatibilidade: analise.compatibilidade,
      erros: analise.erros.slice(0, LIMITE_LISTA), totalErros: analise.erros.length,
      divergencias: divergencias.slice(0, LIMITE_LISTA), totalDivergencias: divergencias.length,
      controles: analise.controles,
      contagens: {
        linhasLidas: analise.controles.linhasLidas ?? 0, registros: analise.registros.length, novos: novos.length, jaImportados: jaImportados.length,
        conflitos: conflitos.length, duplicadosNoArquivo: analise.duplicadosNoArquivo.length, substituiriam: contradicoes.ausentes.length,
      },
      duplicadosNoArquivo: analise.duplicadosNoArquivo.slice(0, 50),
      amostra: analise.registros.slice(0, 10).map((r) => ({ linha: r.linha, tipoRegistro: r.tipoRegistro, idExterno: r.idExterno, data: r.data, valorCentavos: r.valorCentavos })),
    };
    return { analise, novos, jaImportados, conflitos, divergencias, erros: analise.erros, paraSubstituir: contradicoes.ausentes, impressao, resumo };
  }

  // A 1ª tentativa mantém a chave de sempre (as já gravadas não mudam); as seguintes, só após uma tentativa rejeitada, levam o número.
  const chaveDaImportacao = (documentoId, tipoRelatorio, n) => `importacao:${documentoId}:${tipoRelatorio}${n > 1 ? `:t${n}` : ""}`;

  async function registrarNegado(ctx, documentoId, erro) {
    try {
      await acessosNegados.registrar({
        em: b.agora(), evento: "LEITURA_DE_DOCUMENTO_NEGADA", codigo: erro.codigo, documentoId: documentoId ?? null,
        usuarioId: ctx?.usuarioId ?? null, organizacaoId: ctx?.organizacaoId ?? null, unidadeId: ctx?.unidadeId ?? null,
      });
    } catch {
      // falha ao registrar não pode liberar o acesso: a negação continua valendo
    }
  }

  return {
    /**
     * Passos 1–10: recebe o arquivo, guarda o original no cofre, registra documento + importação e devolve a PRÉVIA.
     * O mesmo arquivo (mesmo SHA-256) para o mesmo relatório devolve a importação já existente.
     */
    receberArquivoParaImportacao(ctx, entrada) {
      const c = validarRecebimentoDeArquivo(entrada);
      const adaptador = fontes.buscar(c.fonte, c.tipoRelatorio);
      return b.executar(ctx, ACAO.IMPORTAR, async (cx, tx) => {
        b.exigirNaoFutura(c.periodoFim, "periodoFim");
        // Fontes de faturamento da unidade: relatório de sistema que a unidade não usa é recusado antes de guardar qualquer coisa.
        exigirFonteDaUnidade(await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade"), c.fonte, c.tipoRelatorio);
        const guardado = await exigirOCofre().guardar(cx, { conteudo: c.conteudo, tipoMime: c.tipoMime });
        const chaveDoc = `sha256:${guardado.hashSha256}`;
        let anterior = null;
        let documentoAnterior = null;
        if (c.substituiImportacaoId) {
          anterior = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, c.substituiImportacaoId, "Importação anterior");
          if (anterior.fonte !== c.fonte || anterior.tipoRelatorio !== c.tipoRelatorio) falhar(CODIGO.IMPORTACAO_INVALIDA, "A versão corrigida precisa ser da mesma fonte e do mesmo relatório.");
          if (![...CONCLUIDAS, E.PRONTO_PARA_IMPORTAR].includes(anterior.estado)) falhar(CODIGO.IMPORTACAO_INVALIDA, "Só uma importação pronta ou importada pode ser substituída.", { estado: anterior.estado });
          documentoAnterior = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, anterior.documentoId, "Documento anterior");
        }
        let tentativa = 1;
        let documento = await tx.buscarPorChave(cx, TIPO.DOCUMENTO, chaveDoc);
        if (documento) {
          if (documento.origem !== c.fonte) falhar(CODIGO.IMPORTACAO_INVALIDA, "Este mesmo arquivo já está registrado como documento de outra fonte.");
          // Mesmo arquivo já recebido devolve a importação existente. EXCEÇÃO: uma tentativa REJEITADA não bloqueia o arquivo —
          // o erro costuma ser dos parâmetros (ex.: período declarado errado), e o arquivo é o mesmo. Nova tentativa = nova importação.
          for (let n = 1; ; n += 1) {
            const existente = await tx.buscarPorChave(cx, TIPO.IMPORTACAO, chaveDaImportacao(documento.id, c.tipoRelatorio, n));
            if (!existente) { tentativa = n; break; }
            if (existente.estado !== E.REJEITADO) return { importacao: existente, previa: existente.previa, repetido: true };
          }
        } else {
          documento = await b.criar(tx, cx, TIPO.DOCUMENTO, {
            origem: c.fonte, arquivoId: guardado.arquivoId, hashSha256: guardado.hashSha256, tipo: adaptador.tipoDocumento,
            competencia: c.periodoInicio.slice(0, 7) === c.periodoFim.slice(0, 7) ? c.periodoInicio.slice(0, 7) : null,
            recebidoEm: b.hoje(), substituiId: documentoAnterior?.id ?? null, descricao: c.descricao,
            versaoDocumento: documentoAnterior ? documentoAnterior.versaoDocumento + 1 : 1, substituidoPorId: null, responsavelId: cx.usuarioId,
            chaveIdempotencia: chaveDoc, impressao: null,
          });
        }
        let imp = await b.criar(tx, cx, TIPO.IMPORTACAO, {
          fonte: c.fonte, tipoRelatorio: c.tipoRelatorio, formato: c.tipoMime, documentoId: documento.id, periodoInicio: c.periodoInicio,
          periodoFim: c.periodoFim, estado: E.RECEBIDO, compatibilidade: "SINTETICA", previa: null, impressaoPrevia: null, relatorio: null,
          substituiImportacaoId: anterior?.id ?? null, substituidaPorId: null, confirmadoPor: null, confirmadoEm: null, justificativa: null,
          chaveIdempotencia: chaveDaImportacao(documento.id, c.tipoRelatorio, tentativa), impressao: null,
        });
        imp = await b.alterar(tx, cx, TIPO.IMPORTACAO, imp, { estado: E.EM_VALIDACAO }, EVENTO_HISTORICO.IMPORTACAO);
        const previa = await montarPrevia(tx, cx, imp, adaptador, c.conteudo);
        imp = await b.alterar(tx, cx, TIPO.IMPORTACAO, imp, {
          estado: previa.erros.length ? E.REJEITADO : E.PRONTO_PARA_IMPORTAR, previa: previa.resumo, impressaoPrevia: previa.impressao,
          compatibilidade: previa.analise.compatibilidade,
        }, EVENTO_HISTORICO.IMPORTACAO);
        return { importacao: imp, previa: previa.resumo, repetido: false };
      });
    },

    /** Refaz a prévia de uma importação ainda pronta (ex.: outra importação entrou depois da análise). */
    reavaliarImportacao(ctx, entrada) {
      const c = validarReferenciaDeImportacao(entrada);
      return b.executar(ctx, ACAO.IMPORTAR, async (cx, tx) => {
        const imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, c.importacaoId, "Importação");
        if (imp.estado !== E.PRONTO_PARA_IMPORTAR) falhar(CODIGO.TRANSICAO_INVALIDA, "Só uma importação pronta pode ser reavaliada.", { estado: imp.estado });
        const documento = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, imp.documentoId, "Documento");
        const arquivo = await exigirOCofre().ler(cx, documento.arquivoId);
        const previa = await montarPrevia(tx, cx, imp, fontes.buscar(imp.fonte, imp.tipoRelatorio), arquivo.conteudo);
        if (previa.impressao === imp.impressaoPrevia) return { importacao: imp, previa: imp.previa, mudou: false };
        const nova = await b.alterar(tx, cx, TIPO.IMPORTACAO, imp, { previa: previa.resumo, impressaoPrevia: previa.impressao }, EVENTO_HISTORICO.IMPORTACAO);
        return { importacao: nova, previa: previa.resumo, mudou: true };
      });
    },

    /** Passos 11–14: confirmação autorizada, gravação em UMA transação e relatório da importação. */
    confirmarImportacao(ctx, entrada) {
      const c = validarConfirmacaoDeImportacao(entrada);
      return b.executar(ctx, ACAO.CONFIRMAR_IMPORTACAO, async (cx, tx) => {
        let imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, c.importacaoId, "Importação");
        if (CONCLUIDAS.includes(imp.estado)) return { importacao: imp, relatorio: imp.relatorio, repetido: true };
        if (imp.estado !== E.PRONTO_PARA_IMPORTAR) falhar(CODIGO.TRANSICAO_INVALIDA, "Esta importação não está pronta para ser confirmada.", { estado: imp.estado });
        const adaptador = fontes.buscar(imp.fonte, imp.tipoRelatorio);
        // Uma confirmação por fonte+relatório de cada vez no escopo: a checagem de duplicidade contra o banco fica exata.
        await tx.travar(cx, `importacao:${imp.fonte}:${imp.tipoRelatorio}`, "EXCLUSIVA");
        for (const comp of competenciasDoPeriodo(imp.periodoInicio, imp.periodoFim)) await b.exigirCompetenciaEditavel(tx, cx, comp);
        const documento = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, imp.documentoId, "Documento");
        const arquivo = await exigirOCofre().ler(cx, documento.arquivoId);
        if (arquivo.hashSha256 !== documento.hashSha256) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo do cofre não confere com o documento registrado.");
        const previa = await montarPrevia(tx, cx, imp, adaptador, arquivo.conteudo);
        if (previa.impressao !== c.impressaoPrevia || previa.impressao !== imp.impressaoPrevia) {
          falhar(CODIGO.IMPORTACAO_INVALIDA, "A prévia mudou desde a revisão. Reavalie a importação e confirme a prévia nova.");
        }
        if (previa.erros.length) falhar(CODIGO.IMPORTACAO_INVALIDA, "A importação tem erros e não pode ser gravada.");
        const comPendencias = previa.divergencias.length > 0;
        if (comPendencias && !(c.aceitarPendencias && c.justificativa)) {
          falhar(CODIGO.IMPORTACAO_INVALIDA, "Há divergências: confirmar exige aceite explícito das pendências e justificativa.", { divergencias: previa.divergencias.length });
        }

        let substituidos = 0;
        if (imp.substituiImportacaoId) {
          const anterior = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, imp.substituiImportacaoId, "Importação anterior");
          if (adaptador.substituicaoCompleta) {
            const presentes = new Set(previa.analise.registros.map((r) => r.chave));
            const faltam = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId: anterior.id, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } })).filter((r) => !presentes.has(r.chaveIdempotencia));
            if (faltam.length) falhar(CODIGO.IMPORTACAO_INVALIDA, `A versão corrigida não traz ${faltam.length} registro(s) da versão anterior: envie o relatório completo do período.`, { faltam: faltam.length });
          }
          if (anterior.estado === E.SUBSTITUIDO) falhar(CODIGO.IMPORTACAO_INVALIDA, "A importação anterior já foi substituída por outra versão.");
          const ativos = await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId: anterior.id, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
          for (const r of ativos) {
            await b.alterar(tx, cx, TIPO.REGISTRO_FONTE, r, { situacao: SITUACAO_REGISTRO_FONTE.SUBSTITUIDO, substituidoPorImportacaoId: imp.id, chaveIdempotencia: `substituido:${r.id}` }, EVENTO_HISTORICO.SUBSTITUICAO);
            substituidos += 1;
          }
          await b.alterar(tx, cx, TIPO.IMPORTACAO, anterior, { estado: E.SUBSTITUIDO, substituidaPorId: imp.id }, EVENTO_HISTORICO.SUBSTITUICAO, c.justificativa);
          const docAnterior = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, anterior.documentoId, "Documento anterior");
          if (documento.substituiId === docAnterior.id && !docAnterior.substituidoPorId) {
            await b.alterar(tx, cx, TIPO.DOCUMENTO, docAnterior, { substituidoPorId: documento.id }, EVENTO_HISTORICO.SUBSTITUICAO);
          }
        }

        // Linhas anteriores que este arquivo contradiz (aceite explícito já exigido acima): ficam SUBSTITUÍDAS, preservadas no histórico, fora dos totais.
        for (const r of previa.paraSubstituir) {
          await b.alterar(tx, cx, TIPO.REGISTRO_FONTE, r, { situacao: SITUACAO_REGISTRO_FONTE.SUBSTITUIDO, substituidoPorImportacaoId: imp.id, chaveIdempotencia: `substituido:${r.id}` }, EVENTO_HISTORICO.SUBSTITUICAO, c.justificativa);
          substituidos += 1;
        }
        // Em lote, na MESMA transação: uma falha desfaz tudo (nada fica gravado pela metade) e a chave única barra duplicidade.
        await b.criarVarios(tx, cx, TIPO.REGISTRO_FONTE, previa.novos.map((r) => ({
            importacaoId: imp.id, documentoId: documento.id, fonte: imp.fonte, tipoRelatorio: imp.tipoRelatorio, tipoRegistro: r.tipoRegistro,
            idExterno: r.idExterno, identificacao: r.identificacao, linha: r.linha, dataReferencia: r.data, competencia: r.competencia,
            valorCentavos: r.valorCentavos, dados: r.dados, original: r.original, conferencia: CONFERENCIA_REGISTRO.NAO_CONFERIDO,
            situacao: SITUACAO_REGISTRO_FONTE.ATIVO, substituidoPorImportacaoId: null, chaveIdempotencia: r.chave, impressao: r.impressao,
          })));
        const relatorio = {
          inseridos: previa.novos.length, jaImportados: previa.jaImportados.length, conflitosNaoGravados: previa.conflitos.length,
          duplicadosNoArquivo: previa.analise.duplicadosNoArquivo.length, divergencias: previa.divergencias.length,
          registrosSubstituidos: substituidos, controles: previa.analise.controles,
          ...(adaptador.guardarConflitos ? { conflitos: previa.conflitos.map((r) => ({ chave: r.chave, impressao: r.impressao, data: r.data, valorCentavos: r.valorCentavos, tipoRegistro: r.tipoRegistro, idExterno: r.idExterno, identificacao: r.identificacao, linha: r.linha, dados: r.dados, original: r.original })) } : {}),
          observacao: "Importar não confirma, não concilia e não homologa: os registros entram como NÃO CONFERIDOS e sem efeito financeiro.",
        };
        imp = await b.alterar(tx, cx, TIPO.IMPORTACAO, imp, {
          estado: comPendencias ? E.IMPORTADO_COM_PENDENCIAS : E.IMPORTADO, relatorio, confirmadoPor: cx.usuarioId, confirmadoEm: b.agora(),
          justificativa: c.justificativa,
        }, EVENTO_HISTORICO.IMPORTACAO, c.justificativa);
        return { importacao: imp, relatorio, repetido: false };
      });
    },

    rejeitarImportacao(ctx, entrada) {
      const c = validarReferenciaDeImportacao(entrada);
      return b.executar(ctx, ACAO.CONFIRMAR_IMPORTACAO, async (cx, tx) => {
        const imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, c.importacaoId, "Importação");
        if (imp.estado !== E.PRONTO_PARA_IMPORTAR) falhar(CODIGO.TRANSICAO_INVALIDA, "Só uma importação pronta pode ser rejeitada.", { estado: imp.estado });
        if (!c.justificativa) falhar(CODIGO.IMPORTACAO_INVALIDA, "Rejeitar exige justificativa.");
        return b.alterar(tx, cx, TIPO.IMPORTACAO, imp, { estado: E.REJEITADO }, EVENTO_HISTORICO.IMPORTACAO, c.justificativa);
      });
    },

    consultarImportacao(ctx, entrada) {
      const c = validarReferenciaDeImportacao(entrada);
      return b.consultar(ctx, async (cx, tx) => b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, c.importacaoId, "Importação"));
    },

    listarRegistrosImportados(ctx, entrada) {
      const c = validarReferenciaDeImportacao(entrada);
      return b.consultar(ctx, async (cx, tx) => {
        await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, c.importacaoId, "Importação");
        return tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId: c.importacaoId } });
      });
    },

    /** Original do documento, só para quem pode ver o escopo. Toda negativa fica registrada (sem conteúdo do arquivo). */
    async lerArquivoDoDocumento(ctx, entrada) {
      let documentoId = null;
      try {
        documentoId = validarLeituraDeDocumento(entrada).documentoId;
        return await b.consultar(ctx, async (cx, tx) => {
          const documento = await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, documentoId, "Documento");
          const arquivo = await exigirOCofre().ler(cx, documento.arquivoId);
          if (arquivo.hashSha256 !== documento.hashSha256) falhar(CODIGO.DOCUMENTO_INVALIDO, "O arquivo do cofre não confere com o documento registrado.");
          return { documentoId, tipoMime: arquivo.tipoMime, tamanhoBytes: arquivo.tamanhoBytes, hashSha256: arquivo.hashSha256, conteudo: arquivo.conteudo };
        });
      } catch (e) {
        if (e instanceof ErroFinanceiro) await registrarNegado(ctx, documentoId, e);
        throw e;
      }
    },

    /**
     * Compara o faturamento do SAIPOS (vendas diárias, ou pedidos válidos) com o total do relatório de formas de pagamento.
     * Só DETECTA: nenhuma diferença vira ajuste, receita ou despesa.
     */
    compararRelatoriosSaipos(ctx, entrada) {
      const p = validarPeriodo(entrada);
      return b.consultar(ctx, async (cx, tx) => {
        const no = (r) => r.dataReferencia >= p.periodoInicio && r.dataReferencia <= p.periodoFim && r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO;
        const saipos = await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS" }, predicado: no });
        const dias = saipos.filter((r) => r.tipoRegistro === "TOTAL_DIA");
        const pedidos = saipos.filter((r) => r.tipoRegistro === "PEDIDO" && !r.dados.cancelado);
        const formas = saipos.filter((r) => r.tipoRegistro === "TOTAL_FORMA");
        const soma = (l) => l.reduce((s, r) => somar(s, r.valorCentavos), 0);
        const fonteFaturamento = dias.length ? "FATURAMENTO_POR_DIA" : pedidos.length ? "PEDIDOS" : null;
        if (!fonteFaturamento || !formas.length) {
          return { comparavel: false, motivo: "Faltam relatórios do período: é preciso o faturamento e as formas de pagamento importados.", fonteFaturamento, faturamentoCentavos: null, formasDePagamentoCentavos: formas.length ? soma(formas) : null };
        }
        const faturamento = dias.length ? soma(dias) : soma(pedidos);
        const formasTotal = soma(formas);
        return {
          comparavel: true, fonteFaturamento, faturamentoCentavos: faturamento, formasDePagamentoCentavos: formasTotal,
          diferencaCentavos: subtrair(faturamento, formasTotal), divergente: faturamento !== formasTotal,
          observacao: "O total de formas de pagamento não é faturamento bruto. A diferença fica registrada para investigação; nenhum ajuste foi criado.",
        };
      });
    },

    /** Propõe candidatas de conciliação entre registros importados. Nada é confirmado aqui. */
    // (competenciaHomologada: ver o final do arquivo)
    gerarCandidatasDeConciliacao(ctx, entrada) {
      const c = validarGeracaoDeCandidatas(entrada);
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const ate = somaDias(c.periodoFim, 10);
        const registros = await tx.listar(cx, TIPO.REGISTRO_FONTE, {
          onde: { situacao: SITUACAO_REGISTRO_FONTE.ATIVO }, predicado: (r) => r.dataReferencia >= c.periodoInicio && r.dataReferencia <= ate,
        });
        const { candidatas, semCandidato } = proporCandidatas(c.relacao, registros);
        const porId = new Map(registros.map((r) => [r.id, r]));
        let criadas = 0;
        let existentes = 0;
        let bloqueadasPorHomologacao = 0;
        for (const cand of candidatas) {
          const ids = [...cand.ladoA, ...cand.ladoB].map((r) => r.id).sort();
          const chave = `${c.relacao}|${sha256(ids.join(","))}`;
          if (await tx.buscarPorChave(cx, TIPO.CORRESPONDENCIA, chave)) { existentes += 1; continue; }
          // 06D: candidata cuja competência de conciliação (a mais recente dos registros) está homologada NÃO é criada.
          const comps = ids.map((id) => porId.get(id).competencia).filter(Boolean).sort();
          if (await competenciaHomologada(tx, cx, comps.at(-1))) { bloqueadasPorHomologacao += 1; continue; }
          const total = (l) => l.reduce((s, r) => somar(s, r.valorCentavos), 0);
          await b.criar(tx, cx, TIPO.CORRESPONDENCIA, {
            ladoA: cand.ladoA, ladoB: cand.ladoB, evidenciaDocumentoIds: [...new Set(ids.map((id) => porId.get(id).documentoId))],
            justificativa: `Proposta automática (${cand.regra}).`, diferencaCentavos: subtrair(total(cand.ladoA), total(cand.ladoB)),
            situacao: SITUACAO_CORRESPONDENCIA.CANDIDATA, responsavelId: null, decididoEm: null, justificativaDecisao: null,
            relacao: c.relacao, regra: cand.regra, forca: cand.forca, chaveIdempotencia: chave, impressao: null,
            competencia: comps[0] ?? null, competenciaDaConciliacao: comps.at(-1) ?? null,
          });
          criadas += 1;
        }
        return { relacao: c.relacao, criadas, existentes, bloqueadasPorHomologacao, ambiguas: candidatas.filter((x) => x.ambigua).length, semCandidato: semCandidato.length, registrosSemCandidato: semCandidato };
      });
    },
  };
}

/** 06D: trava compartilhada da competência (mesma transação) e diz se ela está homologada. */
export async function competenciaHomologada(tx, cx, competencia) {
  if (!competencia) return false;
  await tx.travar(cx, `competencia:${competencia}`, "COMPARTILHADA");
  const [c] = await tx.listar(cx, TIPO.COMPETENCIA, { onde: { competencia } });
  return c?.estado === "FECHAMENTO_HOMOLOGADO";
}
