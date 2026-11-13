// Reclassificação financeira (Execução 08C): CONSULTA (caso, categorias permitidas, sugestão, evidências, histórico e
// prévia do impacto) e CONFIRMAÇÃO. A prévia não grava nada; a confirmação revalida tudo DENTRO da transação.
//
//   permissão própria  → financeiro_v2.reclassificar (núcleo + PostgreSQL). `corrigir` não reclassifica mais.
//   versão             → a confirmação exige a versão vista na prévia: se o lançamento mudou, é conflito (nunca sobrescreve).
//   idempotência       → confirmar de novo o mesmo destino não grava outra vez (devolve `repetido: true`).
//   competência        → homologada recusa (reabertura formal); em fechamento com pendências exige também `corrigir` e
//                        fica marcada no histórico da competência (regra comum do núcleo).
//   evidência          → sair de "a classificar" (ou ir para categoria que exige documento) só com documento existente.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_COMPETENCIA, EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { aceitaEscrita } from "../dominio/fechamento.js";
import { impedimentosDeHomologacao } from "../dominio/conferencias.js";
import { preparar, tituloAPagar } from "../dominio/tesouraria.js";
import {
  CASO, TEXTO_DO_CASO, casoDoLancamento, categoriasDeDestino, comoReclassificado, ehProvisoria, exigeEvidencia, exigirReclassificacaoValida,
  impactoDaReclassificacao, sugestaoPorHistorico,
} from "../dominio/reclassificacao.js";
import { validarConsultaDeReclassificacao, validarReclassificacao } from "../contratos/comandos.js";
import { apurarRegistros, carregarRegistros } from "./conferencias.js";

const ORIGEM_LEGIVEL = Object.freeze({ OBRIGACAO: "Conta a pagar", VENDA: "Venda", RECEBIVEL: "Retenção de repasse", AJUSTE: "Ajuste de título", PROPOSTA: "Operação importada", ESTORNO: "Estorno" });

export function operacoesDeReclassificacao(b) {
  /** Documentos que já comprovam o lançamento: os do próprio lançamento, os do título de origem e os vinculados a eles. */
  function evidenciasDe(d, l) {
    const p = preparar(d);
    const registros = [[TIPO.LANCAMENTO, l]];
    if (l.origem?.tipo === TIPO.OBRIGACAO) for (const o of d.obrigacoes.filter((x) => x.lancamentoId === l.id)) registros.push([TIPO.OBRIGACAO, o]);
    if (l.origem?.tipo === TIPO.RECEBIVEL) { const r = p.recebivelPorId.get(l.origem.id); if (r) registros.push([TIPO.RECEBIVEL, r]); }
    const ids = new Set();
    for (const [tipo, r] of registros) {
      for (const id of [...(r.documentoIds ?? []), ...(r.documentoId ? [r.documentoId] : []), ...(r.evidenciaDeClassificacao ?? [])]) ids.add(id);
      for (const v of p.docsPorRegistro.get(`${tipo}:${r.id}`) ?? []) ids.add(v.documentoId);
    }
    return [...ids].map((id) => { const doc = p.documentoPorId.get(id); return { referencia: id, tipo: doc?.tipo ?? null, descricao: doc?.descricao ?? null }; });
  }

  /** Títulos a pagar nascidos do lançamento (para mostrar o efeito em Contas a Pagar). */
  const titulosDe = (d, l) => {
    if (l.origem?.tipo !== TIPO.OBRIGACAO) return [];
    const p = preparar(d);
    return d.obrigacoes.filter((o) => o.lancamentoId === l.id).map((o) => tituloAPagar(p, o, b.hoje()));
  };

  /** Impacto calculado pelos motores sobre os registros reais, com UM lançamento trocado em memória. Nada é gravado. */
  function previa(cx, d, l, categoria) {
    const escopo = { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId };
    const novo = comoReclassificado(l, categoria);
    const d2 = { ...d, lancamentos: d.lancamentos.map((x) => (x.id === l.id ? novo : x)) };
    const antes = apurarRegistros(d, l.competencia, escopo, b.agora());
    const depois = apurarRegistros(d2, l.competencia, escopo, b.agora());
    return impactoDaReclassificacao({
      antes, depois, lancamento: l, categoriaNova: categoria,
      impedimentosAntes: impedimentosDeHomologacao(d, l.competencia, b.hoje(), antes), impedimentosDepois: impedimentosDeHomologacao(d2, l.competencia, b.hoje(), depois),
      titulosAntes: titulosDe(d, l), titulosDepois: titulosDe(d2, novo),
    });
  }

  return {
    /**
     * Tudo o que a tela precisa para decidir — sem gravar nada. Com `categoria`, inclui a prévia do impacto.
     * Uma movimentação bancária devolve o caso MOVIMENTACAO_SEM_NATUREZA (não reclassificável) e o caminho correto.
     */
    consultarReclassificacao(ctx, e) {
      const c = validarConsultaDeReclassificacao(e);
      return b.consultar(ctx, async (cx, tx) => {
        const d = await carregarRegistros(tx, cx);
        if (c.movimentacaoId) {
          const m = d.movimentacoes.find((x) => x.id === c.movimentacaoId);
          if (!m) falhar(CODIGO.NAO_ENCONTRADO, "Movimentação não encontrada.");
          return { caso: CASO.MOVIMENTACAO_SEM_NATUREZA, explicacao: TEXTO_DO_CASO.MOVIMENTACAO_SEM_NATUREZA, permitida: false, movimentacao: { id: m.id, data: m.dataEfetiva, sentido: m.sentido, valorCentavos: m.valorCentavos } };
        }
        const l = d.lancamentos.find((x) => x.id === c.lancamentoId);
        if (!l) falhar(CODIGO.NAO_ENCONTRADO, "Lançamento não encontrado.");
        const caso = casoDoLancamento(l);
        const comp = d.competencias.find((x) => x.competencia === l.competencia) ?? null;
        const estado = comp?.estado ?? ESTADO_COMPETENCIA.ABERTA;
        const categorias = d.categorias;
        const atual = categorias.find((x) => x.codigo === l.categoria) ?? null;
        const destinos = caso === CASO.OPERACAO_CANCELADA_OU_ESTORNADA ? [] : categoriasDeDestino(l, categorias);
        const evidencias = evidenciasDe(d, l);
        const historico = (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.LANCAMENTO, registroId: l.id } }))
          .filter((h) => h.evento === EVENTO_HISTORICO.RECLASSIFICACAO)
          .map((h) => ({ em: h.em, de: h.antes?.categoria ?? null, para: h.depois?.categoria ?? null, justificativa: h.justificativa ?? null, porVoce: h.usuarioId === cx.usuarioId, evidencias: h.depois?.evidenciaDeClassificacao ?? [] }));
        const motivoBloqueio = caso === CASO.OPERACAO_CANCELADA_OU_ESTORNADA ? TEXTO_DO_CASO.OPERACAO_CANCELADA_OU_ESTORNADA
          : !aceitaEscrita(estado) ? "A competência está homologada: a reclassificação exige reabertura formal (com justificativa) — a versão homologada é preservada."
            : !cx.permissoes.includes(ACAO.RECLASSIFICAR) ? "Você não tem a permissão financeiro_v2.reclassificar nesta unidade."
              : estado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS && !cx.permissoes.includes(ACAO.CORRIGIR) ? "Competência em fechamento com pendências: reclassificar exige também a permissão de corrigir."
                : null;
        let impacto = null;
        if (c.categoria) {
          const alvo = categorias.find((x) => x.codigo === c.categoria);
          if (!alvo || !destinos.some((x) => x.codigo === alvo.codigo)) falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria não permitida para este lançamento.", { categoria: c.categoria });
          impacto = { ...previa(cx, d, l, alvo), exigeEvidencia: exigeEvidencia(l, alvo), evidenciaDisponivel: evidencias.length > 0 };
        }
        const documentosDisponiveis = d.documentos.filter((x) => !x.substituidoPorId && (!x.competencia || x.competencia === l.competencia))
          .sort((a, b2) => String(b2.recebidoEm ?? "").localeCompare(String(a.recebidoEm ?? ""))).slice(0, 50)
          .map((x) => ({ referencia: x.id, tipo: x.tipo, descricao: x.descricao ?? null, recebidoEm: x.recebidoEm ?? null }));
        return {
          lancamento: {
            id: l.id, versao: l.versao, descricao: l.descricao ?? null, valorCentavos: l.valorCentavos, competencia: l.competencia, data: l.dataOperacao, canal: l.canal ?? null,
            origem: { tipo: l.origem?.tipo ?? null, nome: ORIGEM_LEGIVEL[l.origem?.tipo] ?? "Registro" }, situacao: l.situacao, fonte: l.fonte?.sistema ?? null,
          },
          categoriaAtual: atual ? { codigo: atual.codigo, nome: atual.nome, natureza: atual.natureza, classificacao: atual.classificacao, provisoria: ehProvisoria(atual.codigo) } : { codigo: l.categoria, nome: l.categoria, natureza: l.natureza, classificacao: l.classificacao, provisoria: ehProvisoria(l.categoria) },
          caso, explicacao: TEXTO_DO_CASO[caso], competencia: { codigo: l.competencia, estado },
          categoriasPermitidas: destinos.map((x) => ({ codigo: x.codigo, nome: x.nome, natureza: x.natureza, classificacao: x.classificacao, exigeDocumento: x.exigeDocumento === true })),
          sugestao: caso === CASO.OPERACAO_CANCELADA_OU_ESTORNADA ? null : sugestaoPorHistorico(l, d),
          evidencias, exigeEvidenciaParaSairDaProvisoria: ehProvisoria(l.categoria), documentosDisponiveis, historico,
          podeReclassificar: motivoBloqueio === null, motivoBloqueio, impacto,
        };
      });
    },

    /** Confirmação. Revalida permissão, escopo, versão, competência, natureza e evidência dentro da MESMA transação. */
    reclassificarLancamento(ctx, entrada) {
      const c = validarReclassificacao(entrada);
      return b.executar(ctx, ACAO.RECLASSIFICAR, async (cx, tx) => {
        const l = await b.obterOuFalhar(tx, cx, TIPO.LANCAMENTO, c.lancamentoId, "Lançamento");
        // Repetição da mesma confirmação: nada novo é gravado.
        if (l.categoria === c.categoria && l.situacao === "ATIVO") return { lancamento: l, repetido: true };
        if (l.versao !== c.versaoEsperada) {
          falhar(CODIGO.CONFLITO_VERSAO, "O lançamento mudou desde a prévia. Abra a prévia de novo antes de confirmar.", { versaoAtual: l.versao, versaoEsperada: c.versaoEsperada });
        }
        await b.exigirCompetenciaEditavel(tx, cx, l.competencia);
        const categoria = await b.categoriaLancavel(tx, cx, c.categoria);
        exigirReclassificacaoValida(l, categoria);
        let evidencia = [];
        if (c.documentoId) {
          await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
          const chave = `${c.documentoId}|${TIPO.LANCAMENTO}|${l.id}`;
          if (!(await tx.buscarPorChave(cx, TIPO.VINCULO_DOCUMENTAL, chave))) {
            await b.criar(tx, cx, TIPO.VINCULO_DOCUMENTAL, { documentoId: c.documentoId, registroTipo: TIPO.LANCAMENTO, registroId: l.id, chaveIdempotencia: chave }, c.justificativa);
          }
          evidencia = [c.documentoId];
        }
        if (exigeEvidencia(l, categoria) && !evidencia.length) {
          const existentes = await evidenciasGravadas(tx, cx, l);
          if (!existentes.length) {
            falhar(CODIGO.EVIDENCIA_EXIGIDA, "Esta classificação depende de documento: vincule a evidência (nota, boleto, contrato ou relatório do canal). Sem ela, a pendência continua aberta.", { categoria: categoria.codigo });
          }
          evidencia = existentes;
        }
        const lancamento = await b.alterar(tx, cx, TIPO.LANCAMENTO, l, {
          categoriaId: categoria.id, categoria: categoria.codigo, classificacao: categoria.classificacao, natureza: categoria.natureza,
          ...(evidencia.length ? { evidenciaDeClassificacao: evidencia } : {}),
        }, EVENTO_HISTORICO.RECLASSIFICACAO, c.justificativa);
        return { lancamento, repetido: false, anterior: { categoria: l.categoria, natureza: l.natureza, versao: l.versao } };
      });
    },
  };

  /** Evidências gravadas (lidas dentro da transação, sem depender da tela): documentos do lançamento e do título de origem. */
  async function evidenciasGravadas(tx, cx, l) {
    const ids = new Set(l.evidenciaDeClassificacao ?? []);
    const alvos = [[TIPO.LANCAMENTO, l.id]];
    if (l.origem?.tipo === TIPO.OBRIGACAO) {
      for (const o of await tx.listar(cx, TIPO.OBRIGACAO, { onde: { lancamentoId: l.id } })) { for (const id of o.documentoIds ?? []) ids.add(id); alvos.push([TIPO.OBRIGACAO, o.id]); }
    }
    if (l.origem?.tipo === TIPO.RECEBIVEL) {
      const r = await tx.obter(cx, TIPO.RECEBIVEL, l.origem.id);
      if (r) { for (const id of r.documentoIds ?? []) ids.add(id); alvos.push([TIPO.RECEBIVEL, r.id]); }
    }
    for (const [tipo, id] of alvos) for (const v of await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: tipo, registroId: id } })) ids.add(v.documentoId);
    return [...ids];
  }
}
