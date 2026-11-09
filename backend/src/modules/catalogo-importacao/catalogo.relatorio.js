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
  L.push("", "## Pendências por tipo", "", "| Código | Ocorrências |", "|---|---:|");
  for (const [k, v] of Object.entries(r.pendencias_por_codigo).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push("", `## Fichas pendentes de homologação com bloqueio (${r.fichas_pendentes.length})`, "", "| Onde | Produto | Bloqueios |", "|---|---|---|");
  for (const f of r.fichas_pendentes) L.push(`| ${f.onde} | ${f.nome} | ${f.bloqueios.join(", ")} |`);
  L.push("", `## Inconsistências (${r.inconsistencias.length})`, "");
  for (const i of r.inconsistencias) L.push(`- **${NIVEL[i.nivel] ?? i.nivel}** \`${i.codigo}\` — ${i.onde}: ${i.detalhe}`);
  return L.join("\n") + "\n";
}
