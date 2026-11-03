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
const MOTIVO_RECLASSIFICACAO = "Pedidos mudaram de organização (decisão de triagem, vínculo ou nova versão do catálogo).";

/**
 * Cobertura que vai para o fechamento de um DESTINO: a prova de completude da conexão, SEM o que é da titular (volume total
 * de pedidos da conta, páginas, nomes de ponto de coleta, detalhes de erro). Só códigos; quantidade apenas da triagem.
 */
export function coberturaParaDestino(cobertura) {
  return {
    completa: cobertura?.completa === true,
    janelaInicio: cobertura?.janelaInicio ?? null, janelaFim: cobertura?.janelaFim ?? null,
    paginas: null, pedidosUnicos: null,
    triagemPendente: cobertura?.triagemPendente ?? 0,
    pendencias: (cobertura?.pendencias ?? []).map((p) => (p.codigo === "TRIAGEM_PENDENTE"
      ? { codigo: p.codigo, quantidade: p.quantidade } : { codigo: p.codigo, origem: "conexao" })),
  };
}

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
  const cobertura = destino ? coberturaParaDestino(sync.cobertura) : sync.cobertura;
  const calc = calcularFechamentoLogistico(pedidos, { competencia, cobertura, operacao, compartilhado });
  const ultimo = await repo.ultimoFechamento(t, competencia);
  const motivoPadrao = motivo ?? (comp?.distribuicao?.reclassificados ? MOTIVO_RECLASSIFICACAO : null);
  const { status, motivo: motivoFinal } = decidirStatus(calc, ultimo, motivoPadrao);

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

/**
 * Sincroniza e fecha uma competência (o que o agendador chama por unidade TITULAR). TODOS os fechamentos são tentados — o da
 * titular e o de cada destino ativo — e o resultado de cada um fica gravado na execução (foody_sync_execucoes.fechamentos).
 * Qualquer fechamento que falhe deixa a competência PENDENTE (`concluido: false`, fechamentos_pendentes > 0): o ciclo
 * compartilhado não é dado como concluído e o agendador volta a ela. Falha da titular é relançada depois de tentar os destinos.
 */
export async function sincronizarEFechar(pedido, deps) {
  const sync = await sincronizarCompetencia(pedido, deps);
  const comp = sync.compartilhamento ?? null;
  let fechamento = null, erroTitular = null;
  try { fechamento = await gerarFechamentoLogistico({ ...pedido, sync }, deps); } catch (e) { erroTitular = e; }
  const fechamentosDestino = [];
  for (const d of comp?.destinos ?? []) {
    try {
      const f = await gerarFechamentoLogistico({ ...pedido, execucaoId: undefined, organizacaoId: d.organizacaoId, unidadeId: d.unidadeId, sync }, deps);
      fechamentosDestino.push({ unidadeId: d.unidadeId, operacao: d.operacao, resultado: f.resultado, status: f.status, versao: f.versao, estadoValores: f.estadoValores });
    } catch (e) {
      fechamentosDestino.push({ unidadeId: d.unidadeId, operacao: d.operacao, erro: /^[A-Z_]{2,40}$/.test(String(e?.codigo)) ? e.codigo : "ERRO_INTERNO" });
    }
  }
  const pendentes = [
    ...(erroTitular ? [{ unidadeId: pedido.unidadeId, operacao: "subway", erro: /^[A-Z_]{2,40}$/.test(String(erroTitular?.codigo)) ? erroTitular.codigo : "ERRO_INTERNO" }] : []),
    ...fechamentosDestino.filter((x) => x.erro),
  ];
  if (comp) {
    const registro = { [pedido.unidadeId]: erroTitular ? `ERRO:${pendentes[0].erro}` : fechamento.resultado };
    for (const x of fechamentosDestino) registro[x.unidadeId] = x.erro ? `ERRO:${x.erro}` : x.resultado;
    // Melhor esforço: se nem isto gravar, o `concluido:false` devolvido abaixo continua sinalizando a pendência ao agendador.
    try { await deps.repo.registrarFechamentosDaExecucao({ organizacaoId: pedido.organizacaoId, unidadeId: pedido.unidadeId }, sync.execucaoId, registro, pendentes.length); }
    catch { /* a pendência continua no retorno */ }
  }
  if (erroTitular) { erroTitular.fechamentosPendentes = pendentes; throw erroTitular; }
  return { sync, fechamento, fechamentosDestino, concluido: pendentes.length === 0, pendentes };
}
