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
/** Mesma flag de foody.constants.js#FLAG_ENTREGADOR_NOME (copiada: esta ponte não importa modules/foody). Exige a migration 160. */
export const FLAG_ENTREGADOR_NOME = "FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED";
const lerNomeEntregador = (env) => String(env?.[FLAG_ENTREGADOR_NOME] ?? "").trim().toLowerCase() === "true";
/** Mesma flag de foody.constants.js#FLAG_DISTANCIA (copiada pelo mesmo motivo). Exige a migration 161. */
export const FLAG_DISTANCIA = "FOODY_CENTRAL_DISTANCIA_ENABLED";
const lerDistancia = (env) => String(env?.[FLAG_DISTANCIA] ?? "").trim().toLowerCase() === "true";
/** Colunas opcionais pedidas ao banco conforme as flags (sem a migration, flag desligada não quebra a leitura). */
const colunasLeitura = (env) => [COLUNAS, ...(lerNomeEntregador(env) ? ["entregador_nome"] : []), ...(lerDistancia(env) ? ["distancia_raio_km"] : [])].join(", ");
const PAGINA = 1000;
/** Dia de parede de Brasília (-03:00, sem horário de verão), igual à camada Foody. */
export const hojeBrasilia = (agora = new Date()) => new Date(agora.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
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
    // Nome enviado pela Foody (quando guardado — flag + migration 160); senão, rótulo neutro e estável a partir do hash.
    entregador: !r.entregador_presente ? null
      : (typeof r.entregador_nome === "string" && r.entregador_nome.trim()) ? r.entregador_nome.trim()
      : r.entregador_hash ? `Entregador Foody ${String(r.entregador_hash).slice(0, 6)}` : null,
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
    // Raio calculado na coleta das coordenadas (flag + migration 161); rota não existe na API (nem no relatório).
    distancia_raio_km: num(r.distancia_raio_km), distancia_rota_km: null,
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
    // Pedidos Foody da operação própria nos dias que a planilha cobre: não entram (planilha prevalece), mas são CONTADOS
    // para revelar planilha parcial (ex.: exportada no meio do dia) — nunca uma perda silenciosa.
    const foodyPropriosEmDiaDePlanilha = {};
    const foodyTriagemEmDiaDePlanilha = {}; // em triagem: podem ser da operação própria; ampliam a faixa aceitável
    let ultimaSincronizacao = null;
    const fim = proximoDia(dataFim);
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const { data, error } = await db.from("foody_pedidos").select(colunasLeitura(env))
        .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
        .gte("data_hora", `${dataInicio}T00:00:00`).lt("data_hora", `${fim}T00:00:00`)
        .order("data_hora", { ascending: true }).order("foody_uid", { ascending: true })
        .range(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
      if (error) return { erro: "FONTE_FOODY_INDISPONIVEL" };
      for (const r of data ?? []) {
        if (r.organizacao_id !== organizacaoId || r.unidade_id !== unidadeId) return { erro: "FONTE_FOODY_TENANT_DIVERGENTE" };
        const dia = String(r.data_hora).replace(" ", "T").slice(0, 10);
        if (diasPlanilha.has(dia)) { // planilha prevalece
          const op = operacaoFoodyParaParser(r.operacao);
          if (op === operacaoPropria) foodyPropriosEmDiaDePlanilha[dia] = (foodyPropriosEmDiaDePlanilha[dia] ?? 0) + 1;
          else if (op === "revisao_necessaria") foodyTriagemEmDiaDePlanilha[dia] = (foodyTriagemEmDiaDePlanilha[dia] ?? 0) + 1;
          continue;
        }
        linhas.push(linhaFoodyParaParser(r));
        if (r.sincronizado_em && (!ultimaSincronizacao || r.sincronizado_em > ultimaSincronizacao)) ultimaSincronizacao = r.sincronizado_em;
      }
      if (!data || data.length < PAGINA) break;
      if (pagina === MAX_PAGINAS - 1) return { erro: "FONTE_FOODY_LIMITE_EXCEDIDO" };
    }
    const diasFoody = [...new Set(linhas.map((l) => l.data_hora.slice(0, 10)))].sort();
    return { linhas, operacaoPropria, diasFoody, diasPlanilha: [...diasPlanilha].sort(), ultimaSincronizacao, foodyPropriosEmDiaDePlanilha, foodyTriagemEmDiaDePlanilha };
  } catch {
    return { erro: "FONTE_FOODY_INDISPONIVEL" };
  }
}

/**
 * Compara, nos dias cobertos por planilha, a quantidade de pedidos da operação própria: planilha × Foody.
 * Só INFORMA (não troca a fonte: isso muda a metodologia e exige decisão humana).
 *   PLANILHA_POSSIVELMENTE_PARCIAL: a Foody tem MAIS pedidos que a planilha (ex.: relatório exportado antes do fim do dia).
 *   FOODY_COM_MENOS_PEDIDOS: a planilha tem mais (ex.: sincronização atrasada ou pedido em triagem).
 * Faixa aceitável: [foody − tolerância, foody + triagem do dia + tolerância] — pedidos Foody em triagem podem ser da
 * operação própria, e o catálogo pode divergir do Parser em 1–2 pedidos.
 */
export function compararPlanilhaComFoody({ planilhaPorDia, foodyPorDia, triagemPorDia = {}, diasPlanilha, tolerancia = 2 }) {
  const out = [];
  for (const dia of diasPlanilha ?? []) {
    const planilha = planilhaPorDia?.[dia] ?? 0;
    const foody = foodyPorDia?.[dia] ?? 0;
    const triagem = triagemPorDia?.[dia] ?? 0;
    if (foody === 0 && triagem === 0) continue; // sem dado Foody no dia: nada a comparar (antes do início da coleta, por exemplo)
    if (planilha >= foody - tolerancia && planilha <= foody + triagem + tolerancia) continue;
    out.push({ dia, planilha, foody, triagem, alerta: planilha < foody ? "PLANILHA_POSSIVELMENTE_PARCIAL" : "FOODY_COM_MENOS_PEDIDOS" });
  }
  return out;
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

// ---------------------------------------------------------------------------
// COBERTURA POR DIA (calendário do Parser). SOMENTE LEITURA, mesma flag/allowlist. Diz, para cada dia do período, de onde vêm
// os dados (planilha, Foody ou nenhum), se o dia é provisório, se há pedidos em triagem e quando foi atualizado.
// "sem_dados" nunca é "dia zerado": é ausência de registro.
// ---------------------------------------------------------------------------
export const FONTE_DIA = Object.freeze({ PLANILHA: "planilha", FOODY: "foody", SEM_DADOS: "sem_dados" });
export const MAX_DIAS_COBERTURA = 93;
/** Mesma regra de foody.constants.js#fechamentoDefinitivo (copiada: esta ponte não importa modules/foody). */
const definitivo = (f) => (f?.status === "CONSOLIDADO" || f?.status === "CORRIGIDO")
  && (f?.estado_valores === "SINCRONIZADO" || f?.estado_valores === "CONCILIADO" || f?.estado_valores === "CUSTO_REAL");

/** Puro: monta os dias a partir das leituras. */
export function montarCobertura({ dataInicio, dataFim, hoje, importacoes = [], pedidosFoody = [], fechamentos = new Map(), operacaoPropria = "subway" }) {
  const diasPlanilha = diasCobertosPorPlanilha(importacoes, dataInicio, dataFim);
  const importadoEm = {};
  for (const imp of importacoes) {
    for (const d of diasCobertosPorPlanilha([imp], dataInicio, dataFim)) {
      if (!importadoEm[d] || String(imp.criado_em) > importadoEm[d]) importadoEm[d] = imp.criado_em ?? null;
    }
  }
  const foody = {};
  for (const r of pedidosFoody) {
    const d = String(r.data_hora ?? "").replace(" ", "T").slice(0, 10);
    const x = (foody[d] ??= { pedidos: 0, proprios: 0, triagem: 0, ultimaSincronizacao: null });
    x.pedidos++;
    const op = operacaoFoodyParaParser(r.operacao);
    if (op === operacaoPropria) x.proprios++;
    else if (op === "revisao_necessaria") x.triagem++;
    if (r.sincronizado_em && (!x.ultimaSincronizacao || r.sincronizado_em > x.ultimaSincronizacao)) x.ultimaSincronizacao = r.sincronizado_em;
  }
  const dias = [];
  for (let d = dataInicio, guard = 0; d <= dataFim && guard < 400; d = proximoDia(d), guard++) {
    const f = fechamentos.get(d) ?? null;
    const fd = foody[d] ?? null;
    const triagemFechamento = (Array.isArray(f?.pendencias) ? f.pendencias : []).find((p) => p?.codigo === "TRIAGEM_PENDENTE")?.quantidade ?? 0;
    const aberto = d >= hoje;
    const fonte = diasPlanilha.has(d) ? FONTE_DIA.PLANILHA : fd?.pedidos ? FONTE_DIA.FOODY : FONTE_DIA.SEM_DADOS;
    dias.push({
      data: d, fonte, aberto,
      // Provisório: dia da Foody sem fechamento definitivo (ou ainda em curso). Planilha importada é a fonte consolidada do dia.
      provisorio: fonte === FONTE_DIA.FOODY && (aberto || !definitivo(f)),
      triagem: Math.max(triagemFechamento, fd?.triagem ?? 0),
      pedidosFoody: fd?.pedidos ?? 0,
      fechamento: f ? { status: f.status, estadoValores: f.estado_valores } : null,
      ultimaAtualizacao: fonte === FONTE_DIA.PLANILHA ? importadoEm[d] ?? null : fd?.ultimaSincronizacao ?? null,
    });
  }
  const conta = (pred) => dias.filter(pred).length;
  return {
    dias,
    totais: {
      dias: dias.length, planilha: conta((x) => x.fonte === FONTE_DIA.PLANILHA), foody: conta((x) => x.fonte === FONTE_DIA.FOODY),
      semDados: conta((x) => x.fonte === FONTE_DIA.SEM_DADOS && !x.aberto), abertos: conta((x) => x.aberto),
      provisorios: conta((x) => x.provisorio), comTriagem: conta((x) => x.triagem > 0),
    },
  };
}

/**
 * @returns {Promise<null | { papel, operacaoPropria, dias, totais } | { erro }>}  null = flag desligada (nada consultado)
 */
export async function carregarCoberturaFoody({ db, env = process.env, organizacaoId, unidadeId, dataInicio, dataFim, agora = new Date() }) {
  if (!pedidosFoodyNoParserPermitidos(env, unidadeId)) return null;
  try {
    const confere = (linhas) => (linhas ?? []).every((r) => r.organizacao_id === organizacaoId && r.unidade_id === unidadeId);
    const { data: imps, error: e1 } = await db.from("parser_fd_importacoes").select("organizacao_id, unidade_id, periodo_inicio, periodo_fim, criado_em")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("status", "concluida")
      .lte("periodo_inicio", dataFim).gte("periodo_fim", dataInicio);
    if (e1) return { erro: "FONTE_FOODY_INDISPONIVEL" };
    // Papel da unidade na conta Foody: titular (dona da conexão) ou destino ATIVO. Só id/status: nunca o token.
    const { data: cx, error: e2 } = await db.from("foody_conexoes").select("organizacao_id, unidade_id, status")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId);
    const { data: dest, error: e3 } = await db.from("foody_conexao_destinos").select("organizacao_id, unidade_id, operacao, estado")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("estado", "ATIVO");
    const { data: fech, error: e4 } = await db.from("foody_fechamentos_logisticos").select("organizacao_id, unidade_id, competencia, versao, status, estado_valores, pendencias")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).gte("competencia", dataInicio).lte("competencia", dataFim)
      .order("competencia", { ascending: true }).order("versao", { ascending: false }).limit(2000);
    if (e2 || e3 || e4) return { erro: "FONTE_FOODY_INDISPONIVEL" };
    if (![imps, cx, dest, fech].every(confere)) return { erro: "FONTE_FOODY_TENANT_DIVERGENTE" };
    const operacoes = [...new Set((dest ?? []).map((d) => d.operacao))];
    if (operacoes.length > 1) return { erro: "FONTE_FOODY_OPERACAO_AMBIGUA" };
    const operacaoPropria = operacoes.length ? operacaoFoodyParaParser(operacoes[0]) : "subway";
    const fechamentos = new Map();
    for (const f of fech ?? []) if (!fechamentos.has(f.competencia)) fechamentos.set(f.competencia, f);

    const pedidosFoody = [];
    const fim = proximoDia(dataFim);
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const { data, error } = await db.from("foody_pedidos").select("organizacao_id, unidade_id, data_hora, operacao, sincronizado_em, foody_uid")
        .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
        .gte("data_hora", `${dataInicio}T00:00:00`).lt("data_hora", `${fim}T00:00:00`)
        .order("data_hora", { ascending: true }).order("foody_uid", { ascending: true })
        .range(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
      if (error) return { erro: "FONTE_FOODY_INDISPONIVEL" };
      if (!confere(data)) return { erro: "FONTE_FOODY_TENANT_DIVERGENTE" };
      pedidosFoody.push(...(data ?? []));
      if (!data || data.length < PAGINA) break;
      if (pagina === MAX_PAGINAS - 1) return { erro: "FONTE_FOODY_LIMITE_EXCEDIDO" };
    }
    const papel = (cx ?? []).length ? "titular" : operacoes.length ? "destino" : null;
    return { papel, operacaoPropria,
      ...montarCobertura({ dataInicio, dataFim, hoje: hojeBrasilia(agora), importacoes: imps ?? [], pedidosFoody, fechamentos, operacaoPropria }) };
  } catch {
    return { erro: "FONTE_FOODY_INDISPONIVEL" };
  }
}
