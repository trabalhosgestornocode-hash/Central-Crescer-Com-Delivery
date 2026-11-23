// FERRAMENTAS DE CONVERSA do MOVA (24/11/2026) — consultas estruturadas, SOMENTE LEITURA, do catálogo fechado. A IA só escolhe a
// consulta e os filtros do contrato estrito (fornecedor, categoria, período); estas funções calculam tudo a partir das contas a
// pagar e do painel de entregadores do Financeiro v2 (mesmos dados das demais ferramentas). Nada é estimado, nenhum SQL existe aqui.
//   PAGAMENTOS_A_FORNECEDOR  quanto foi PAGO a um fornecedor no período (pagamentos registrados; ≠ conciliado com o extrato)
//   DESPESAS_POR_CATEGORIA   (substitui a versão anterior) uma categoria na competência, ou o ranking das categorias
//   COMPARATIVO_DE_DESPESAS  competência × competência anterior (por categoria / fornecedor): FATOS, sem afirmar causa
//   ENTREGADORES_SEM_NOTA    fechamentos que ainda aguardam nota fiscal (nomes só para quem vê detalhe; nunca valor por pessoa)
import { reais } from "./respostas.js";

const sem = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const mes = (d) => (d ? d.slice(0, 7) : null);
const anterior = (comp) => { const [a, m] = comp.split("-").map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`; };
const palavras = (t) => sem(t).split(" ").filter((w) => w.length >= 3);
const ativa = (t) => t.situacao !== "CANCELADO" && t.situacao !== "CANCELADA";

/** Fornecedor compatível: TODAS as palavras do pedido aparecem no nome do fornecedor (sem acento/caixa). */
export function fornecedorBate(termo, titulo) {
  const alvo = ` ${sem(titulo?.fornecedor?.nome)} `;
  const ps = palavras(termo);
  return ps.length > 0 && ps.every((p) => alvo.includes(p));
}

/** Categoria do pedido entre as que existem nas contas: código exato; senão o nome contém as palavras do código/fornecedor-dito. */
export function resolverCategoria(contas, saida) {
  const cats = new Map();
  for (const t of contas) if (t.categoria?.codigo) cats.set(t.categoria.codigo, t.categoria.nome ?? t.categoria.codigo);
  if (saida.categoriaSugerida && cats.has(saida.categoriaSugerida)) return { codigo: saida.categoriaSugerida, nome: cats.get(saida.categoriaSugerida) };
  const termos = [saida.categoriaSugerida?.replaceAll("_", " "), saida.favorecido].filter(Boolean);
  for (const termo of termos) {
    const ps = palavras(termo);
    if (!ps.length) continue;
    const achadas = [...cats].filter(([cod, nome]) => ps.every((p) => ` ${sem(nome)} ${sem(cod)} `.includes(p)));
    if (achadas.length === 1) return { codigo: achadas[0][0], nome: achadas[0][1] };
    if (achadas.length > 1) return { ambigua: achadas.map(([, n]) => n).slice(0, 4) };
  }
  return null;
}

const soma = (l, f) => l.reduce((s, x) => s + (f(x) ?? 0), 0);
const porChave = (lista, chave) => { const m = new Map(); for (const t of lista) { const k = chave(t) ?? "(sem categoria)"; m.set(k, (m.get(k) ?? 0) + t.valorOriginalCentavos); } return m; };

export function criarFerramentasDeConversa({ porta, contasTodas, ok, insuficiente, posicao }) {
  return {
    async PAGAMENTOS_A_FORNECEDOR(escopo, { periodo, saida, hoje }) {
      if (!saida.favorecido) return insuficiente("FORNECEDOR_NAO_INFORMADO");
      const contas = (await contasTodas(escopo)).filter((t) => ativa(t) && fornecedorBate(saida.favorecido, t));
      if (contas.length === 0) return ok(["não encontrei fornecedor com esse nome nas contas a pagar; confira o nome"], posicao(hoje));
      const nomes = [...new Set(contas.map((t) => t.fornecedor.nome))];
      if (nomes.length > 3) return ok([`o nome combina com ${nomes.length} fornecedores; informe o nome completo`], posicao(hoje));
      const pagos = contas.flatMap((t) => (t.pagamentos ?? []).filter((p) => p.data >= periodo.inicio && p.data <= periodo.fim));
      const rotulo = periodo.rotulo;
      if (pagos.length === 0) return ok([`${nomes.join(" / ")}: nenhum pagamento registrado em ${rotulo}`], { ...posicao(hoje), rotulo, valorCentavos: 0 });
      const total = soma(pagos, (p) => p.valorCentavos);
      const abertas = contas.filter((t) => t.saldoCentavos > 0 && ["EM_ABERTO", "PARCIALMENTE_PAGO", "VENCIDO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA"].includes(t.situacao));
      const l = [`${nomes.join(" / ")}: pago ${reais(total)} em ${pagos.length} pagamento(s) registrado(s) em ${rotulo} (pagamento registrado não significa conciliado com o extrato)`];
      if (abertas.length) l.push(`ainda em aberto com esse fornecedor: ${abertas.length} conta(s), ${reais(soma(abertas, (t) => t.saldoCentavos))}`);
      return ok(l, { ...posicao(hoje), rotulo, valorCentavos: total });
    },

    async DESPESAS_POR_CATEGORIA(escopo, { periodo, saida }) {
      if (!periodo.competencia) return insuficiente("CATEGORIA_EXIGE_UMA_COMPETENCIA");
      const todas = (await contasTodas(escopo)).filter(ativa);
      const doMes = todas.filter((t) => t.competencia === periodo.competencia);
      if (doMes.length === 0) return insuficiente("SEM_CONTAS_NA_COMPETENCIA");
      const alvo = saida.categoriaSugerida || saida.favorecido ? resolverCategoria(todas, saida) : null;
      if (alvo?.ambigua) return ok([`a categoria pedida combina com mais de uma (${alvo.ambigua.join(", ")}); diga qual`]);
      if (alvo?.codigo) {
        const c = doMes.filter((t) => t.categoria?.codigo === alvo.codigo);
        if (c.length === 0) return insuficiente("SEM_CONTAS_NA_CATEGORIA");
        return ok([`contas registradas na categoria ${alvo.nome} na competência ${periodo.competencia}: ${c.length}, ${reais(soma(c, (t) => t.valorOriginalCentavos))} (por competência; o pagamento pode cair em outro mês)`]);
      }
      const rank = [...porChave(doMes, (t) => t.categoria?.nome)].sort((a, b) => b[1] - a[1]);
      const total = soma(doMes, (t) => t.valorOriginalCentavos);
      return ok([`despesas e custos registrados na competência ${periodo.competencia}: ${doMes.length} contas, ${reais(total)} (por competência; não é caixa nem resultado)`,
        `maiores categorias: ${rank.slice(0, 5).map(([n, v]) => `${n} ${reais(v)}`).join("; ")}`], { valorCentavos: total });
    },

    async COMPARATIVO_DE_DESPESAS(escopo, { periodo, saida, hoje }) {
      const atual = periodo.competencia ?? mes(hoje);
      const antes = anterior(atual);
      const todas = (await contasTodas(escopo)).filter(ativa);
      let alvo = null; let filtro = "total";
      if (saida.categoriaSugerida || saida.favorecido) {
        const r = resolverCategoria(todas, saida);
        if (r?.ambigua) return ok([`a categoria pedida combina com mais de uma (${r.ambigua.join(", ")}); diga qual`]);
        if (r?.codigo) { alvo = r; filtro = `categoria ${r.nome}`; }
      }
      const f = (comp) => todas.filter((t) => t.competencia === comp && (!alvo || t.categoria?.codigo === alvo.codigo));
      const a = f(atual), b = f(antes);
      if (a.length === 0 && b.length === 0) return insuficiente("SEM_CONTAS_NAS_DUAS_COMPETENCIAS");
      if (b.length === 0) return ok([`sem contas registradas em ${antes} para comparar com ${atual} (${filtro})`]);
      const ta = soma(a, (t) => t.valorOriginalCentavos), tb = soma(b, (t) => t.valorOriginalCentavos);
      const dif = ta - tb;
      const pct = tb > 0 ? ` (${dif >= 0 ? "+" : "−"}${Math.abs(Math.round((dif / tb) * 1000) / 10).toLocaleString("pt-BR")}%)` : "";
      const l = [`${filtro} — ${atual}: ${reais(ta)} (${a.length} contas) × ${antes}: ${reais(tb)} (${b.length} contas); diferença ${dif >= 0 ? "+" : "−"}${reais(Math.abs(dif))}${pct}`];
      // Onde mudou: por categoria (visão total) ou por fornecedor (categoria escolhida). Só fatos registrados; nunca a "causa".
      const chave = alvo ? (t) => t.fornecedor?.nome : (t) => t.categoria?.nome;
      const ma = porChave(a, chave), mb = porChave(b, chave);
      const deltas = [...new Set([...ma.keys(), ...mb.keys()])].map((k) => [k, (ma.get(k) ?? 0) - (mb.get(k) ?? 0)]).filter(([, d]) => d !== 0).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
      if (deltas.length) l.push(`onde mais mudou (${alvo ? "por fornecedor" : "por categoria"}): ${deltas.slice(0, 3).map(([k, d]) => `${k} ${d >= 0 ? "+" : "−"}${reais(Math.abs(d))}`).join("; ")}`);
      l.push(atual === mes(hoje) ? `${atual} ainda está em andamento: novas contas podem mudar a comparação` : "comparação por competência das contas registradas; o Financeiro mostra o motivo de cada conta");
      return ok(l, { valorCentavos: ta });
    },

    async ENTREGADORES_SEM_NOTA(escopo, { hoje, detalhe = false }) {
      let r;
      try { r = await porta.ler("consultarEntregadoresProprios", escopo, {}); }
      catch (e) { if (porta.ehErroDeRegra?.(e)) return insuficiente("ENTREGADORES_INDISPONIVEL"); throw e; }
      const lista = (r?.fechamentos ?? []).filter((f) => f.obrigacaoId && (f.saldoCentavos ?? 0) > 0 && ["AGUARDANDO_NF", "NF_REJEITADA"].includes(f.situacaoDocumental));
      if (!r?.semana) return insuficiente("SEM_FECHAMENTO_DE_ENTREGADORES");
      if (lista.length === 0) return ok(["nenhum entregador com nota fiscal pendente nos fechamentos em aberto"], { ...posicao(hoje), valorCentavos: 0 });
      const pessoas = new Map();
      for (const f of lista) pessoas.set(f.entregador.nome, (pessoas.get(f.entregador.nome) ?? 0) + 1);
      const rej = lista.filter((f) => f.situacaoDocumental === "NF_REJEITADA").length;
      const l = [`${pessoas.size} entregador(es) com nota fiscal pendente em ${lista.length} fechamento(s) em aberto${rej ? ` (${rej} com nota rejeitada, aguardando reenvio)` : ""}; total a liberar ${reais(soma(lista, (f) => f.saldoCentavos))}`];
      if (detalhe) l.push(`quem falta: ${[...pessoas].slice(0, 12).map(([n, q]) => `${n}${q > 1 ? ` (${q} semanas)` : ""}`).join(", ")}${pessoas.size > 12 ? ` e mais ${pessoas.size - 12}` : ""}`);
      else l.push("os nomes aparecem só no privado de quem vê o detalhe financeiro");
      return ok(l, { ...posicao(hoje), valorCentavos: soma(lista, (f) => f.saldoCentavos) });
    },
  };
}
