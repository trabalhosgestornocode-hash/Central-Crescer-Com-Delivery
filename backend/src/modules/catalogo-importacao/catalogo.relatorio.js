// Relatório legível (Markdown) da simulação de importação. Puro.

const NIVEL = { erro: "ERRO", aviso: "AVISO", info: "INFO" };

export function relatorioMarkdown(r) {
  const t = r.totais;
  const L = [];
  L.push(`# Relatório de simulação — ${r.fonte}`, "");
  L.push("> Simulação: nada foi gravado em banco algum.", "");
  L.push("## Totais", "");
  L.push("| Indicador | Valor |", "|---|---:|");
  for (const [k, v] of Object.entries(t)) L.push(`| ${k.replaceAll("_", " ")} | ${v} |`);
  L.push("", "## Por arquivo", "", "| Categoria | Fichas | Preparações | Ingredientes (mestre) | Embalagens (mestre) |", "|---|---:|---:|---:|---:|");
  for (const [c, x] of Object.entries(r.por_categoria)) L.push(`| ${c} | ${x.fichas} | ${x.preparacoes} | ${x.ingredientes_mestre} | ${x.embalagens_mestre} |`);
  const c = r.conciliacao_custos;
  L.push("", "## Conciliação de custos (lote recalculado × planilha)", "",
    `Conferem: **${c.conferem}** · Divergem: **${c.divergem}** · Não comparáveis (ficha incompleta): **${c.nao_comparaveis}**`, "");
  if (c.divergencias.length) { L.push("| Onde | Produto | Planilha | Recalculado |", "|---|---|---:|---:|"); for (const d of c.divergencias) L.push(`| ${d.onde} | ${d.nome} | ${d.planilha_lote} | ${d.importado_lote} |`); }
  const k = r.conferencia;
  if (k) {
    L.push("", "## Conciliação (nada some sem explicação)", "");
    L.push(`- Registros de origem: **${k.registros_origem}** → produtos planejados: **${k.produtos_planejados}** + preparações mescladas (idênticas): **${k.preparacoes_mescladas.length}** — todos mapeados: **${k.todos_os_registros_mapeados ? "sim" : "NÃO"}**`);
    for (const m of k.preparacoes_mescladas) L.push(`  - ${m.onde} absorvida por \`${m.absorvida_por}\` (${m.linhas} linhas idênticas)`);
    const l = k.linhas;
    L.push(`- Linhas de origem: **${l.origem_total}** = processadas ${l.processadas} + de preparações mescladas ${l.de_preparacoes_mescladas} (fecha: ${l.fecha ? "sim" : "NÃO"})`);
    L.push(`- Processadas: importadas ${l.importadas} + somadas ${l.somadas_em_linha_existente} + sem quantidade ${l.descartadas_sem_quantidade} + componente inexistente ${l.descartadas_componente_nao_encontrado} + auto-referência ${l.descartadas_auto_referencia} (fecha: ${l.fecha_processadas ? "sim" : "NÃO"})`);
    L.push(`- Insumos sem custo (permanecem pendentes): ${k.insumos_sem_custo.length} · variantes de preço preservadas sem unificar: ${k.variantes_de_preco}`);
  }
  L.push("", "## Pendências por tipo", "", "| Código | Ocorrências |", "|---|---:|");
  for (const [k, v] of Object.entries(r.pendencias_por_codigo).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push("", `## Fichas pendentes de homologação com bloqueio (${r.fichas_pendentes.length})`, "", "| Onde | Produto | Bloqueios |", "|---|---|---|");
  for (const f of r.fichas_pendentes) L.push(`| ${f.onde} | ${f.nome} | ${f.bloqueios.join(", ")} |`);
  L.push("", `## Inconsistências (${r.inconsistencias.length})`, "");
  for (const i of r.inconsistencias) L.push(`- **${NIVEL[i.nivel] ?? i.nivel}** \`${i.codigo}\` — ${i.onde}: ${i.detalhe}`);
  return L.join("\n") + "\n";
}
