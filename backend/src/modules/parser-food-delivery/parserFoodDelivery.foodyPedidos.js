// Ponte Parser ← pedidos Foody sincronizados (foody_pedidos) — SOMENTE LEITURA, atrás de flag própria, desligada por padrão.
//
//   FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED=true  E  unidade em FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES (uuid, vírgula)
//
// Por que existe: o agendador Foody grava os pedidos reais em foody_pedidos a cada ciclo, mas o Parser só lia
// parser_fd_pedidos (planilhas importadas). Sem planilha, o Parser ficava vazio mesmo com os dados no banco.
//
// Regras (não negociáveis):
//   * UMA FONTE POR DIA: dia coberto por qualquer importação concluída de planilha (período do arquivo) usa SÓ a planilha.
//     A Foody preenche apenas os dias sem planilha. Nunca há soma das duas fontes no mesmo dia (sem duplicidade).
//   * Nada é gravado: nenhuma importação sintética, nenhum pedido copiado. Desligar a flag = Parser byte a byte igual.
//   * Isolamento: só lê linhas da MESMA organização e unidade do contexto e confere cada linha devolvida.
//   * Campos que a API não oferece (chegada para entrega, distância, origem) ficam null — nunca zero.
//   * O nome do entregador não é armazenado pela sincronização (só um hash estável): o Parser recebe um rótulo neutro.
//   * Falha de leitura nunca derruba o Parser: devolve { erro } e a resposta segue só com a planilha.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLAG_PEDIDOS = "FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED";
export const FLAG_PEDIDOS_UNIDADES = "FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES";
export const ORIGEM_FOODY_API = "foody_api";
const PAGINA = 1000;
const MAX_PAGINAS = 50;

/** Operação gravada pela camada Foody → vocabulário do Parser. Valor desconhecido vira revisão (nunca chute). */
const OPERACAO_FOODY_PARA_PARSER = Object.freeze({ subway: "subway", acai_no_grau: "acai_no_grau", triagem: "revisao_necessaria" });
export const operacaoFoodyParaParser = (op) => OPERACAO_FOODY_PARA_PARSER[op] ?? "revisao_necessaria";

export function pedidosFoodyNoParserPermitidos(env, unidadeId) {
  if (String(env?.[FLAG_PEDIDOS] ?? "").trim().toLowerCase() !== "true") return false;
  const lista = new Set(String(env?.[FLAG_PEDIDOS_UNIDADES] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
  return lista.has(String(unidadeId ?? "").toLowerCase());
}

const proximoDia = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

/** Dias (AAAA-MM-DD) do intervalo [de, ate] cobertos pelos períodos das importações de planilha concluídas. */
export function diasCobertosPorPlanilha(importacoes, de, ate) {
  const dias = new Set();
  for (const imp of importacoes ?? []) {
    const ini = String(imp.periodo_inicio ?? "").slice(0, 10);
    const fim = String(imp.periodo_fim ?? "").slice(0, 10);
    if (!ini || !fim || fim < de || ini > ate) continue;
    for (let d = ini < de ? de : ini, guard = 0; d <= (fim > ate ? ate : fim) && guard < 400; d = proximoDia(d), guard++) dias.add(d);
  }
  return dias;
}

/** Hora de parede da Foody (timestamp sem fuso) → mesma representação que o Parser grava (parede em ...Z). */
const parede = (v) => (v == null || v === "" ? null : `${String(v).replace(" ", "T").slice(0, 19)}.000Z`);
const num = (v) => (v == null || v === "" ? null : Number(v));

/** Linha de foody_pedidos → pedido no formato de linha do Parser (snake_case, como parser_fd_pedidos). */
export function linhaFoodyParaParser(r) {
  return {
    id: `foody:${r.foody_uid}`,
    importacao_id: null,
    organizacao_id: r.organizacao_id, unidade_id: r.unidade_id,
    numero_pedido: r.numero_pedido,
    data_hora: parede(r.data_hora),
    situacao: r.situacao,
    // Rótulo neutro e estável: a sincronização guarda só o hash do nome (dado pessoal minimizado).
    entregador: r.entregador_presente && r.entregador_hash ? `Entregador Foody ${String(r.entregador_hash).slice(0, 6)}` : null,
    taxa_entregador: num(r.taxa_entregador),
    valor_total_pedido: num(r.valor_total),
    forma_pagamento: r.forma_pagamento ?? null,
    razao_cancelamento: r.cancelamento_razao ?? null,
    justificativa_cancelamento: r.cancelamento_justificativa ?? null,
    origem: ORIGEM_FOODY_API,
    detalhes_pedido: r.detalhes_pedido ?? null,
    operacao: operacaoFoodyParaParser(r.operacao),
    operacao_motivo: r.operacao_motivo ?? null,
    data_aceito: parede(r.data_aceito), data_pronto: parede(r.data_pronto), data_despachado: parede(r.data_despachado),
    data_coletado: parede(r.data_coletado), data_entregue: parede(r.data_entregue), data_finalizado: parede(r.data_finalizado),
    data_cancelado: parede(r.data_cancelado), prazo_entrega: parede(r.prazo_entrega),
    // Ausentes na API (validado em 03/11/2026): ficam null, nunca zero.
    data_chegada_entrega: null, data_rejeitado: null, razao_rejeicao: null, justificativa_rejeicao: null,
    distancia_raio_km: null, distancia_rota_km: null,
    sem_taxa_informado: false, status_conciliacao: null,
    fonte_dados: ORIGEM_FOODY_API, foody_sincronizado_em: r.sincronizado_em ?? null,
  };
}

const COLUNAS = [
  "organizacao_id", "unidade_id", "foody_uid", "numero_pedido", "data_hora", "status_foody", "situacao", "taxa_entregador",
  "valor_total", "forma_pagamento", "detalhes_pedido", "operacao", "operacao_motivo", "entregador_presente", "entregador_hash",
  "data_aceito", "data_pronto", "data_despachado", "data_coletado", "data_entregue", "data_finalizado", "data_cancelado",
  "prazo_entrega", "cancelamento_razao", "cancelamento_justificativa", "sincronizado_em",
].join(", ");

/**
 * @param {{ db, env?, organizacaoId, unidadeId, dataInicio, dataFim }} p
 * @returns {Promise<null | { linhas, operacaoPropria, diasFoody, diasPlanilha, ultimaSincronizacao } | { erro }>}
 *   null = flag desligada (nada consultado).
 */
export async function carregarPedidosFoody({ db, env = process.env, organizacaoId, unidadeId, dataInicio, dataFim }) {
  if (!pedidosFoodyNoParserPermitidos(env, unidadeId)) return null;
  try {
    // 1) Dias já cobertos por planilha concluída (prevalecem sempre).
    const { data: imps, error: eImp } = await db.from("parser_fd_importacoes")
      .select("organizacao_id, unidade_id, periodo_inicio, periodo_fim")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("status", "concluida")
      .lte("periodo_inicio", dataFim).gte("periodo_fim", dataInicio);
    if (eImp) return { erro: "FONTE_FOODY_INDISPONIVEL" };
    if ((imps ?? []).some((r) => r.organizacao_id !== organizacaoId || r.unidade_id !== unidadeId)) return { erro: "FONTE_FOODY_TENANT_DIVERGENTE" };
    const diasPlanilha = diasCobertosPorPlanilha(imps, dataInicio, dataFim);

    // 2) Operação própria da unidade: destino ATIVO de uma conexão compartilhada (ex.: Açaí) ou Subway (titular).
    const { data: dest, error: eDest } = await db.from("foody_conexao_destinos")
      .select("organizacao_id, unidade_id, operacao, estado")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("estado", "ATIVO");
    if (eDest) return { erro: "FONTE_FOODY_INDISPONIVEL" };
    const operacoesDestino = [...new Set((dest ?? []).filter((d) => d.organizacao_id === organizacaoId && d.unidade_id === unidadeId).map((d) => d.operacao))];
    if (operacoesDestino.length > 1) return { erro: "FONTE_FOODY_OPERACAO_AMBIGUA" };
    const operacaoPropria = operacoesDestino.length ? operacaoFoodyParaParser(operacoesDestino[0]) : "subway";

    // 3) Pedidos sincronizados do intervalo (hora de parede), paginados.
    const linhas = [];
    let ultimaSincronizacao = null;
    const fim = proximoDia(dataFim);
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const { data, error } = await db.from("foody_pedidos").select(COLUNAS)
        .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
        .gte("data_hora", `${dataInicio}T00:00:00`).lt("data_hora", `${fim}T00:00:00`)
        .order("data_hora", { ascending: true }).order("foody_uid", { ascending: true })
        .range(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
      if (error) return { erro: "FONTE_FOODY_INDISPONIVEL" };
      for (const r of data ?? []) {
        if (r.organizacao_id !== organizacaoId || r.unidade_id !== unidadeId) return { erro: "FONTE_FOODY_TENANT_DIVERGENTE" };
        const dia = String(r.data_hora).replace(" ", "T").slice(0, 10);
        if (diasPlanilha.has(dia)) continue; // planilha prevalece
        linhas.push(linhaFoodyParaParser(r));
        if (r.sincronizado_em && (!ultimaSincronizacao || r.sincronizado_em > ultimaSincronizacao)) ultimaSincronizacao = r.sincronizado_em;
      }
      if (!data || data.length < PAGINA) break;
      if (pagina === MAX_PAGINAS - 1) return { erro: "FONTE_FOODY_LIMITE_EXCEDIDO" };
    }
    const diasFoody = [...new Set(linhas.map((l) => l.data_hora.slice(0, 10)))].sort();
    return { linhas, operacaoPropria, diasFoody, diasPlanilha: [...diasPlanilha].sort(), ultimaSincronizacao };
  } catch {
    return { erro: "FONTE_FOODY_INDISPONIVEL" };
  }
}

/** Entrada sintética para o bloco "fontes" do Parser (só exibição; não existe importação gravada). */
export function fonteFoodyParaApi({ dataInicio, dataFim, diasFoody, ultimaSincronizacao }) {
  return {
    id: null, origem: ORIGEM_FOODY_API, automatica: true,
    nomeArquivo: `Foody Delivery — sincronização automática (${diasFoody.length} ${diasFoody.length === 1 ? "dia" : "dias"})`,
    periodoInicio: diasFoody[0] ?? dataInicio, periodoFim: diasFoody[diasFoody.length - 1] ?? dataFim,
    usuarioNome: "Sincronização automática", criadoEm: ultimaSincronizacao, colunaDetalhesEncontrada: true, diasFoody,
  };
}
