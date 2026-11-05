// Bloco INFORMATIVO "Logística própria (Foody)" do Dashboard Executivo — atrás de flag própria, DESLIGADA por padrão.
//
//   FOODY_CENTRAL_DASHBOARD_ENABLED=true  E  unidade em FOODY_CENTRAL_DASHBOARD_UNIDADES (uuid, vírgula)
//
// Com a flag desligada nada é consultado e a resposta mensal fica byte a byte igual (a chave `logisticaProprio` nem existe).
// Com a flag ligada o bloco é ADICIONAL e SOMENTE LEITURA:
//   * NUNCA entra em cards, deduções, rentabilidade, metas, limites, projeção, diagnóstico nem na proteção de preços;
//   * NUNCA se soma a "Taxas de entregadores" (dedução do iFood/lançamento manual): são grandezas diferentes e o bloco
//     declara isso (`somadoAoResultadoOficial: false`);
//   * lê só fechamentos Foody da MESMA organização + unidade (cada linha é conferida) — Subway nunca vê o Açaí;
//   * só dias com fechamento DEFINITIVO entram nos totais; pendente/incompleto aparece como contagem, fora dos valores;
//   * as quatro grandezas ficam separadas e o que não existe é `null` com motivo (nunca inventado):
//       custoAtribuido      — taxa válida de entregadores PRÓPRIOS (fechamento Foody)
//       taxaPrevista        — taxas de pedidos sem entregador identificado (previsão, não custo)
//       taxaCobradaCliente  — não consta no fechamento Foody → null (pendência de produto, ver docs)
//       pagamentoConciliado — só o Parser/Excel concilia pagamento → null aqui
//   * falha de leitura nunca derruba o Dashboard: o bloco volta com `erro`.
import { fechamentoDefinitivo } from "../foody/foody.constants.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLAG_DASHBOARD = "FOODY_CENTRAL_DASHBOARD_ENABLED";
export const FLAG_DASHBOARD_UNIDADES = "FOODY_CENTRAL_DASHBOARD_UNIDADES";

export function logisticaProprioNoDashboardPermitida(env, unidadeId) {
  if (String(env?.[FLAG_DASHBOARD] ?? "").trim().toLowerCase() !== "true") return false;
  const lista = new Set(String(env?.[FLAG_DASHBOARD_UNIDADES] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
  return lista.has(String(unidadeId ?? "").toLowerCase());
}

const arred = (n) => Math.round(n * 100) / 100;

/** Última versão por competência (versões antigas são histórico, nunca somadas). */
function ultimaVersaoPorDia(fechamentos) {
  const m = new Map();
  for (const f of fechamentos ?? []) {
    const c = String(f.competencia).slice(0, 10);
    if (!m.has(c) || Number(f.versao) > Number(m.get(c).versao)) m.set(c, f);
  }
  return m;
}

function blocoDaOperacao(indicadores) {
  if (!indicadores) return null;
  return indicadores[indicadores.operacao] ?? indicadores.subway ?? null;
}

/** PURO. `fechamentos` = linhas já conferidas de UMA organização+unidade. */
export function montarLogisticaProprio({ fechamentos, de, ate, modeloLogistico = null }) {
  const porDia = ultimaVersaoPorDia(fechamentos);
  let definitivos = 0, pendentes = 0, incompletos = 0, atribuido = 0, prevista = 0, entregas = 0, pedidos = 0;
  for (const [dia, f] of porDia) {
    if (dia < de || dia > ate) continue;
    if (fechamentoDefinitivo(f)) {
      definitivos += 1;
      const b = blocoDaOperacao(f.indicadores);
      atribuido += Number(b?.custoLogisticoProprio) || 0;
      prevista += Number(b?.taxasPrevistasSemEntregador) || 0;
      entregas += Number(b?.proprio?.entregues ?? b?.total?.entregues) || 0;
      pedidos += Number(b?.proprio?.pedidos ?? b?.total?.pedidos) || 0;
    } else if (f.status === "INCOMPLETO") incompletos += 1;
    else pendentes += 1;
  }
  return {
    fonte: "foody_api",
    periodo: { de, ate },
    modeloLogistico,
    somadoAoResultadoOficial: false,
    aviso: "Informativo — não compõe deduções, rentabilidade, metas nem 'Taxas de entregadores' do iFood. Não é pagamento conciliado.",
    dias: { definitivos, pendentes, incompletos },
    custoAtribuido: definitivos ? arred(atribuido) : null,
    taxaPrevista: definitivos ? arred(prevista) : null,
    entregasProprias: definitivos ? entregas : null,
    pedidosProprios: definitivos ? pedidos : null,
    custoMedioPorEntrega: definitivos && entregas > 0 ? arred(atribuido / entregas) : null,
    taxaCobradaCliente: null,
    taxaCobradaClienteMotivo: "Não consta no fechamento Foody (depende de definição de produto).",
    pagamentoConciliado: null,
    pagamentoConciliadoMotivo: "Conciliação de pagamento é feita pelo Parser (Excel); não é inferida aqui.",
    parcial: pendentes + incompletos > 0,
  };
}

async function leituraPadrao({ organizacaoId, unidadeId, de, ate }) {
  const { supabase } = await import("../../config/supabase.js");
  const { data, error } = await supabase.from("foody_fechamentos_logisticos")
    .select("organizacao_id, unidade_id, competencia, versao, status, estado_valores, indicadores")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).gte("competencia", de).lte("competencia", ate).limit(2000);
  if (error) throw new Error("leitura");
  return data ?? [];
}

/** `{ logisticaProprio }` ou `{}` (flag desligada → nada consultado, resposta idêntica). */
export async function logisticaProprioOpcional({ env = process.env, organizacaoId, unidadeId, de, ate, modeloLogistico = null, ler = leituraPadrao }) {
  if (!logisticaProprioNoDashboardPermitida(env, unidadeId)) return {};
  try {
    const linhas = await ler({ organizacaoId, unidadeId, de, ate });
    if ((linhas ?? []).some((r) => r.organizacao_id !== organizacaoId || r.unidade_id !== unidadeId)) return { logisticaProprio: { erro: "FONTE_FOODY_TENANT_DIVERGENTE" } };
    return { logisticaProprio: montarLogisticaProprio({ fechamentos: linhas, de, ate, modeloLogistico }) };
  } catch {
    return { logisticaProprio: { erro: "FONTE_FOODY_INDISPONIVEL" } };
  }
}
