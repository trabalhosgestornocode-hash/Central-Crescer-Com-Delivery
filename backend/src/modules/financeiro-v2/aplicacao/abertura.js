// ABERTURA FINANCEIRA DA UNIDADE (doc 32) — competência de início e data de corte PERSISTIDAS (uma por unidade).
//
//   configurar → (registrar saldos e títulos anteriores) → concluir → [reabrir: ação sensível com 2º fator]
//
// Regras:
//   - a data de corte é a véspera do 1º dia da competência de início; saldos de abertura são posições NESSA data e os
//     títulos anteriores têm origem até ela;
//   - abertura INCOMPATÍVEL é recusada: competência de início já homologada, ou efeito econômico importado/aplicado com
//     data até o corte (ele seria contado de novo junto com as posições de abertura);
//   - mudar a competência só enquanto nenhuma posição de abertura foi registrada; depois de CONCLUÍDA, nada muda sem reabrir;
//   - toda mudança é nova versão com histórico, na sessão de banco da pessoa.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, NATUREZA_LANCAMENTO, SITUACAO_LANCAMENTO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { CATEGORIA_TITULOS_ANTERIORES } from "../dominio/planoDeContas.js";
import { exigirCompetencia, somarDias } from "../dominio/tempo.js";
import { exigirCentavos } from "../dominio/dinheiro.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { operacoesDeTesouraria } from "./tesouraria.js";

export const SITUACAO_ABERTURA = Object.freeze({ CONFIGURADA: "CONFIGURADA", CONCLUIDA: "CONCLUIDA" });
export const CHAVE_ABERTURA = "abertura";
/** Véspera do 1º dia da competência ("2026-11" → "2026-10-31"). */
export const dataDeCorteDa = (competencia) => somarDias(`${competencia}-01`, -1);
/** A abertura da unidade (ou null). Lida DENTRO da transação de quem a usa. */
export const aberturaDaUnidade = (tx, cx) => tx.buscarPorChave(cx, TIPO.ABERTURA, CHAVE_ABERTURA);

/** Abertura configurada e ainda não concluída — exigida para registrar posições de abertura. */
export async function exigirAberturaEmAndamento(tx, cx) {
  const a = await aberturaDaUnidade(tx, cx);
  if (!a) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a abertura financeira (competência de início) antes de registrar posições de abertura.", { motivo: "ABERTURA_NAO_CONFIGURADA" });
  if (a.situacao !== SITUACAO_ABERTURA.CONFIGURADA) falhar(CODIGO.OPERACAO_INVALIDA, "A abertura já foi concluída: novas posições de abertura exigem reabri-la.", { motivo: "ABERTURA_CONCLUIDA" });
  return a;
}

/** Posições de abertura já registradas (saldos na data de corte marcados como abertura e títulos anteriores ativos). */
async function posicoesDeAbertura(tx, cx, a) {
  const saldos = (await tx.listar(cx, TIPO.SALDO_CONTA, { onde: { data: a.dataDeCorte } })).filter((s) => s.aberturaId === a.id);
  const obrigacoes = (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { categoria: CATEGORIA_TITULOS_ANTERIORES } })).filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO);
  const recebiveis = (await tx.listar(cx, TIPO.RECEBIVEL)).filter((r) => r.anteriorAAbertura && r.situacao !== SITUACAO_TITULO.CANCELADA);
  return { saldos, obrigacoes, recebiveis };
}

/** Efeito econômico com data até o corte, já gravado (vendas, receitas, despesas, recebíveis de venda): torna a abertura incompatível. */
async function efeitosAnterioresAoCorte(tx, cx, corte) {
  const lancamentos = (await tx.listar(cx, TIPO.LANCAMENTO)).filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO && l.natureza !== NATUREZA_LANCAMENTO.PATRIMONIAL && (l.dataOperacao ?? "9999") <= corte);
  return lancamentos.length;
}

function validarConfiguracao(e) {
  semCamposDesconhecidos(e ?? {}, ["competencia", "observacao", "justificativa"], "abertura");
  return { competencia: exigirCompetencia(e?.competencia), observacao: exigirTexto(e?.observacao, "observacao", { max: 300, opcional: true }), justificativa: exigirTexto(e?.justificativa, "justificativa", { max: 500, opcional: true }) };
}

export function operacoesDeAbertura(b) {
  const nucleoNa = (tx, cx) => { const bt = baseNaTransacao(b, tx, cx); return { ...operacoesEconomicas(bt), ...operacoesDeTesouraria(bt) }; };

  return {
    /** Configura (ou, sem posições registradas, muda) a competência de início da unidade. Repetir o mesmo é idempotente. */
    configurarAbertura(ctx, entrada) {
      const c = validarConfiguracao(entrada);
      const corte = dataDeCorteDa(c.competencia);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "abertura", "EXCLUSIVA");
        if (corte >= b.hoje()) falhar(CODIGO.DATA_INVALIDA, "A data de corte (véspera do início) precisa ser um dia já encerrado.", { campo: "competencia" });
        const comp = (await tx.listar(cx, TIPO.COMPETENCIA, { onde: { competencia: c.competencia } }))[0];
        if (comp?.estado === "FECHAMENTO_HOMOLOGADO") falhar(CODIGO.COMPETENCIA_HOMOLOGADA, "A competência de início já está homologada.");
        const atual = await aberturaDaUnidade(tx, cx);
        if (atual && atual.competenciaInicio === c.competencia) return { abertura: atual, repetido: true };
        const anteriores = await efeitosAnterioresAoCorte(tx, cx, corte);
        if (anteriores) {
          falhar(CODIGO.OPERACAO_INVALIDA, `Há ${anteriores} lançamento(s) de resultado com data até ${corte}: seriam contados junto com as posições de abertura. Reverta-os ou escolha outra competência.`, { motivo: "ABERTURA_INCOMPATIVEL", lancamentos: anteriores });
        }
        if (!atual) {
          const abertura = await b.criar(tx, cx, TIPO.ABERTURA, { competenciaInicio: c.competencia, dataDeCorte: corte, situacao: SITUACAO_ABERTURA.CONFIGURADA, observacao: c.observacao, chaveIdempotencia: CHAVE_ABERTURA, impressao: null }, c.justificativa ?? "Abertura financeira configurada.");
          return { abertura, repetido: false };
        }
        if (atual.situacao !== SITUACAO_ABERTURA.CONFIGURADA) falhar(CODIGO.OPERACAO_INVALIDA, "A abertura já foi concluída: reabra-a antes de mudar a competência.", { motivo: "ABERTURA_CONCLUIDA" });
        const p = await posicoesDeAbertura(tx, cx, atual);
        if (p.saldos.length || p.obrigacoes.length || p.recebiveis.length) {
          falhar(CODIGO.OPERACAO_INVALIDA, "Já há saldos ou títulos de abertura registrados nesta competência: cancele-os antes de mudar a competência de início.", { motivo: "ABERTURA_COM_POSICOES" });
        }
        if (!c.justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Mudar a competência de início exige justificativa.", { campo: "justificativa" });
        const abertura = await b.alterar(tx, cx, TIPO.ABERTURA, atual, { competenciaInicio: c.competencia, dataDeCorte: corte, observacao: c.observacao ?? atual.observacao ?? null }, EVENTO_HISTORICO.CONFIGURACAO, c.justificativa);
        return { abertura, repetido: false };
      });
    },

    /** Conclui a abertura (depois da conferência): posições de abertura ficam fechadas a novas inclusões. */
    concluirAbertura(ctx, entrada) {
      semCamposDesconhecidos(entrada ?? {}, ["justificativa"], "abertura");
      const justificativa = exigirTexto(entrada?.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "abertura", "EXCLUSIVA");
        const a = await exigirAberturaEmAndamento(tx, cx);
        return { abertura: await b.alterar(tx, cx, TIPO.ABERTURA, a, { situacao: SITUACAO_ABERTURA.CONCLUIDA }, EVENTO_HISTORICO.MUDANCA_ESTADO, justificativa) };
      });
    },

    /** Reabre uma abertura concluída. Ação sensível (REABRIR exige 2º fator recente na plataforma). */
    reabrirAbertura(ctx, entrada) {
      semCamposDesconhecidos(entrada ?? {}, ["justificativa"], "abertura");
      const justificativa = exigirTexto(entrada?.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.REABRIR, async (cx, tx) => {
        await tx.travar(cx, "abertura", "EXCLUSIVA");
        const a = await aberturaDaUnidade(tx, cx);
        if (!a || a.situacao !== SITUACAO_ABERTURA.CONCLUIDA) falhar(CODIGO.OPERACAO_INVALIDA, "Só uma abertura concluída pode ser reaberta.");
        return { abertura: await b.alterar(tx, cx, TIPO.ABERTURA, a, { situacao: SITUACAO_ABERTURA.CONFIGURADA }, EVENTO_HISTORICO.MUDANCA_ESTADO, justificativa) };
      });
    },

    /** Saldo de abertura: posição comprovada no FIM do dia de corte, com origem (referência externa). */
    registrarSaldoDeAbertura(ctx, entrada) {
      semCamposDesconhecidos(entrada ?? {}, ["contaId", "valorCentavos", "origem"], "saldoDeAbertura");
      const contaId = exigirUuid(entrada?.contaId, "contaId");
      const valorCentavos = exigirCentavos(entrada?.valorCentavos, "valorCentavos");
      const origem = exigirTexto(entrada?.origem, "origem", { max: 160 });
      if (origem.length < 5) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a origem do valor (documento, extrato ou contagem).", { campo: "origem" });
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const a = await exigirAberturaEmAndamento(tx, cx);
        // A marca de abertura nasce na inclusão (saldo informado é só inclusão: nunca é alterado depois).
        const r = await nucleoNa(tx, cx).registrarSaldoDeConta(cx, {
          contaId, data: a.dataDeCorte, referencia: "FIM_DO_DIA", valorCentavos,
          observacao: `Saldo de abertura da competência ${a.competenciaInicio} · origem: ${origem} (referência externa; sem anexo verificado no sistema)`.slice(0, 300),
        }, { aberturaId: a.id });
        return { ...r, abertura: { competenciaInicio: a.competenciaInicio, dataDeCorte: a.dataDeCorte } };
      });
    },

    /** Conta a pagar anterior: competência = a da abertura configurada (nunca a digitada). */
    registrarObrigacaoAnterior(ctx, entrada) {
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const a = await exigirAberturaEmAndamento(tx, cx);
        return nucleoNa(tx, cx).registrarObrigacao(cx, { ...entrada, categoria: CATEGORIA_TITULOS_ANTERIORES, competencia: a.competenciaInicio });
      });
    },

    /** Valor a receber anterior: competência = a da abertura configurada. */
    registrarRecebivelAnterior(ctx, entrada) {
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const a = await exigirAberturaEmAndamento(tx, cx);
        return nucleoNa(tx, cx).registrarRecebivel(cx, { ...entrada, anteriorAAbertura: true, competencia: a.competenciaInicio });
      });
    },

    /** Estado da abertura e totais das posições (para o roteiro e as conferências). */
    consultarAbertura(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const a = await aberturaDaUnidade(tx, cx);
        if (!a) return { abertura: null, posicoes: null };
        const p = await posicoesDeAbertura(tx, cx, a);
        const soma = (l, f) => l.reduce((s, x) => s + f(x), 0);
        return {
          abertura: { id: a.id, competenciaInicio: a.competenciaInicio, dataDeCorte: a.dataDeCorte, situacao: a.situacao, observacao: a.observacao ?? null, versao: a.versao, atualizadoEm: a.atualizadoEm, atualizadoPor: a.atualizadoPor },
          posicoes: {
            saldos: p.saldos.map((s) => ({ contaId: s.contaId, valorCentavos: s.valorCentavos })),
            obrigacoesAnteriores: { quantidade: p.obrigacoes.length, totalCentavos: soma(p.obrigacoes, (l) => l.valorCentavos) },
            recebiveisAnteriores: { quantidade: p.recebiveis.length, totalCentavos: soma(p.recebiveis, (r) => r.valorBaseCentavos ?? 0), emAbertoCentavos: soma(p.recebiveis, (r) => r.saldoCentavos ?? 0) },
          },
        };
      });
    },
  };
}
