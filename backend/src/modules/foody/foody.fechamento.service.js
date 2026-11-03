// Fechamento logístico versionado de uma competência, a partir de foody_pedidos (já sincronizados) e da prova de cobertura
// da sincronização. Grava SÓ em foody_fechamentos_logisticos (via foody_fechamento_registrar). Não envia mensagem, não
// toca operacional_fechamentos, Checklist, Performance nem Agente.
// CONEXÃO COMPARTILHADA (145): a MESMA sincronização gera um fechamento INDEPENDENTE por organização — o da titular (Subway) e
// um por destino ATIVO (Açaí), cada um no próprio tenant, com a própria operação como principal. Nenhum valor é rateado nem
// transferido entre eles; erro no fechamento de um destino nunca impede o da titular.
import { randomUUID } from "node:crypto";
import { unidadePermitida, compartilhamentoPermitido } from "./foody.flags.js";
import { calcularFechamentoLogistico } from "./foody.fechamento.calc.js";
import { STATUS_FECHAMENTO, ORIGEM } from "./foody.constants.js";
import { foodyLog } from "./foody.seguranca.js";
import { FoodySyncErro, sincronizarCompetencia } from "./foody.sync.service.js";

const MOTIVO_REPROCESSO = "Dados da API Foody mudaram dentro da janela de reprocessamento.";

/**
 * Decide o status da nova versão: um dia já CONSOLIDADO cujo conteúdo mudou vira CORRIGIDO (com motivo); INCOMPLETO fica
 * INCOMPLETO. Puro — testável sem banco.
 */
export function decidirStatus(calculado, ultimo, motivoInformado) {
  if (calculado.status === STATUS_FECHAMENTO.INCOMPLETO) return { status: STATUS_FECHAMENTO.INCOMPLETO, motivo: motivoInformado ?? null };
  const consolidadoAntes = ultimo && (ultimo.status === STATUS_FECHAMENTO.CONSOLIDADO || ultimo.status === STATUS_FECHAMENTO.CORRIGIDO);
  if (consolidadoAntes && ultimo.hash_conteudo !== calculado.hash) {
    return { status: STATUS_FECHAMENTO.CORRIGIDO, motivo: String(motivoInformado ?? "").trim() || MOTIVO_REPROCESSO };
  }
  if (consolidadoAntes) return { status: ultimo.status, motivo: motivoInformado ?? null };
  return { status: STATUS_FECHAMENTO.CONSOLIDADO, motivo: motivoInformado ?? null };
}

/**
 * @param {{organizacaoId:string, unidadeId:string, competencia:string, sync:object, origem?:string, geradoPor?:string,
 *   motivo?:string, execucaoId?:string}} pedido  `sync` = retorno de sincronizarCompetencia (cobertura + execucaoId)
 *   Unidade de DESTINO: só é aceita quando o próprio `sync` (da titular, na allowlist) a traz como destino ATIVO.
 * @param {{env?:object, repo:object, log?:Function}} deps
 */
export async function gerarFechamentoLogistico(pedido, deps) {
  const { organizacaoId, unidadeId, competencia, sync, origem = ORIGEM.MANUAL, geradoPor = null, motivo = null, execucaoId = randomUUID() } = pedido ?? {};
  const { env = process.env, repo, log = foodyLog } = deps ?? {};
  const t = { organizacaoId, unidadeId };
  const comp = sync?.compartilhamento ?? null;
  const destino = comp?.destinos?.find((d) => d.unidadeId === unidadeId && d.organizacaoId === organizacaoId) ?? null;
  const permitido = destino
    ? compartilhamentoPermitido(env) && unidadePermitida(env, comp.titular.unidadeId)
    : unidadePermitida(env, unidadeId) && (!comp || (comp.titular.unidadeId === unidadeId && comp.titular.organizacaoId === organizacaoId));
  if (!permitido) throw new FoodySyncErro("DESLIGADO", "camada central Foody desligada para esta unidade.");
  if (!sync || sync.competencia !== competencia) throw new FoodySyncErro("SEM_SYNC", "fechamento exige a sincronização da mesma competência.");

  const compartilhado = (comp?.destinos?.length ?? 0) > 0;
  const operacao = destino ? destino.operacao : "subway";
  const pedidos = await repo.listarPedidosDaCompetencia(t, competencia);
  const calc = calcularFechamentoLogistico(pedidos, { competencia, cobertura: sync.cobertura, operacao, compartilhado });
  const ultimo = await repo.ultimoFechamento(t, competencia);
  const { status, motivo: motivoFinal } = decidirStatus(calc, ultimo, motivo);

  const r = await repo.registrarFechamento(t, {
    competencia, status, estadoValores: calc.estadoValores, execucaoId, syncExecucaoId: sync.execucaoId,
    regraVersao: calc.regraVersao, origem, geradoPor, motivo: motivoFinal,
    cobertura: calc.cobertura, indicadores: calc.indicadores, outrasOperacoes: calc.outrasOperacoes, pendencias: calc.pendencias,
    hash: calc.hash,
  });
  log("info", "foody.fechamento", { unidade: unidadeId, operacao, competencia, resultado: r.resultado, versao: r.versao, status: r.status,
    estadoValores: calc.estadoValores, pendencias: calc.pendencias.map((p) => p.codigo) });
  return { ...r, estadoValores: calc.estadoValores, pendencias: calc.pendencias, indicadores: calc.indicadores, outrasOperacoes: calc.outrasOperacoes };
}

/** Sincroniza e fecha uma competência (o que o agendador chama por unidade TITULAR). Destinos ativos fecham em seguida. */
export async function sincronizarEFechar(pedido, deps) {
  const sync = await sincronizarCompetencia(pedido, deps);
  const fechamento = await gerarFechamentoLogistico({ ...pedido, sync }, deps);
  const fechamentosDestino = [];
  for (const d of sync.compartilhamento?.destinos ?? []) {
    try {
      const f = await gerarFechamentoLogistico({ ...pedido, execucaoId: undefined, organizacaoId: d.organizacaoId, unidadeId: d.unidadeId, sync }, deps);
      fechamentosDestino.push({ unidadeId: d.unidadeId, operacao: d.operacao, resultado: f.resultado, status: f.status, versao: f.versao, estadoValores: f.estadoValores });
    } catch (e) {
      fechamentosDestino.push({ unidadeId: d.unidadeId, operacao: d.operacao, erro: String(e?.codigo ?? "ERRO_INTERNO") });
    }
  }
  return { sync, fechamento, fechamentosDestino };
}
