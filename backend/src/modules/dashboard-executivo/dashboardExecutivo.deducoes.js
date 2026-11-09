// Escolha das deduções usadas na margem estimada do iFood (Simulador do Dashboard).
//
//   1) APURADAS no mês (conciliadas) — sempre mandam, e só valem as DUAS juntas (Taxas e Comissões + Serviços e Promoções).
//   2) CONFIGURADAS pela própria empresa — só entram na falta das apuradas e apenas quando o usuário escolheu
//      o produto (o chamador só envia `cfg` nesse caso). São estimativa, e a origem é sempre devolvida.
//   3) Nada disponível => margem indisponível, com motivo (nunca zero, nunca percentual de outra empresa).
//
// Puro (sem I/O).
/**
 * @param {{taxas_comissoes: number|null, servicos_promocoes: number|null}} apuradas percentuais 0–100 do mês
 * @param {{taxasComissoesPct: number|null, servicosPromocoesPct: number|null, motivo: string|null}|undefined} cfg
 */
export function escolherDeducoes(apuradas, cfg) {
  const a = apuradas ?? {};
  const completas = a.taxas_comissoes != null && a.servicos_promocoes != null;
  if (completas) {
    return { origem: "apuradas", motivo: null, taxasComissoesPct: a.taxas_comissoes, servicosPromocoesPct: a.servicos_promocoes };
  }
  if (cfg && cfg.taxasComissoesPct != null && cfg.servicosPromocoesPct != null) {
    return { origem: "configuradas", motivo: null, taxasComissoesPct: cfg.taxasComissoesPct, servicosPromocoesPct: cfg.servicosPromocoesPct };
  }
  return {
    origem: "indisponivel", motivo: cfg?.motivo ?? "sem_deducoes_apuradas",
    taxasComissoesPct: a.taxas_comissoes ?? null, servicosPromocoesPct: a.servicos_promocoes ?? null,
  };
}
