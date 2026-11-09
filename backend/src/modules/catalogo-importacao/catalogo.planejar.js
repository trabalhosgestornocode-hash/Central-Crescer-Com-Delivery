// PLANEJADOR da importação de catálogo (insumos · preparações · produtos · fichas).
//
// 100% PURO: recebe o que o parser extraiu e devolve (a) o payload que a função SQL
// fn_catalogo_importar consome e (b) o relatório de auditoria/inconsistências.
// Não acessa banco, rede nem disco — por isso é a base tanto do "pré-visualizar" (dry-run)
// quanto da carga real, e é testável sem ambiente.
//
// REGRAS DE OURO (pedidas pelo cliente e travadas em teste):
//   * Nunca inventa preço: preço ausente/zero vira "sem custo" + pendência, não um número.
//   * Nunca elimina informação: nomes repetidos com receitas diferentes são PRESERVADOS (chave com #n).
//   * Unidade da planilha é pouco confiável ("L" com 1000 = ml; "KG" com 1800 = g): a inferência é
//     explícita, registrada e sempre vira pendência de conferência — nunca silenciosa.
//   * Mão de obra fica FORA do custo de ingredientes/embalagens (indicador à parte).
//   * Toda ficha importada nasce 'pendente' de homologação; o CMV "homologado" só existe depois da
//     conferência de um administrador (regra no backend: produtos/custo.js#resumoProduto).

export const BLOQUEANTES = new Set([
  "layout_inesperado",
  "linha_sem_quantidade", "componente_nao_encontrado", "linha_com_erro_na_planilha", "sem_rendimento",
  "sem_componentes", "insumo_sem_custo", "preparacao_incompleta", "custo_planilha_invalido", "ciclo_na_receita",
]);

const TIPO_PRODUTO_POR_CATEGORIA = { SALGADOS: "outro", DOCES: "sobremesa", BEBIDAS: "bebida" };
const UNIDADES_VALIDAS = new Set(["g", "kg", "ml", "l", "un", "fatia", "porcao", "folha"]);
const EPS_CUSTO = 0.01; // R$ 0,01 de tolerância na conciliação com o custo da planilha

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ehErro = (v) => typeof v === "string" && v.trim().startsWith("#");

/** Nome canônico para casar registros: sem acento, caixa alta, espaços colapsados. */
export function normalizarNome(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Infere a unidade-base do insumo a partir do rótulo e da quantidade da embalagem.
 * Devolve SEMPRE a razão quando não for um caso inequívoco.
 * @returns {{unidade: string, pendencia: string|null, detalhe: string|null}}
 */
export function inferirUnidade(rotulo, qtdEmbalagem) {
  const r = normalizarNome(rotulo).replace(/\./g, "");
  const q = num(qtdEmbalagem);
  if (["GR", "G", "GRAMA", "GRAMAS"].includes(r)) return { unidade: "g", pendencia: null, detalhe: null };
  if (r === "ML") return { unidade: "ml", pendencia: null, detalhe: null };
  if (["U", "UM", "UN", "UND", "UNIDADE"].includes(r)) return { unidade: "un", pendencia: null, detalhe: null };
  if (r === "L") {
    if (q != null && q >= 100) return { unidade: "ml", pendencia: "unidade_inferida", detalhe: `rótulo "L" com quantidade ${q}: tratado como mililitros` };
    return { unidade: "l", pendencia: null, detalhe: null };
  }
  if (r === "K" || r === "KG") {
    if (q != null && q >= 100) return { unidade: "g", pendencia: "unidade_inferida", detalhe: `rótulo "${rotulo}" com quantidade ${q}: tratado como gramas` };
    return { unidade: "kg", pendencia: "unidade_ambigua", detalhe: `rótulo "${rotulo}" com quantidade ${q ?? "?"}: confirmar se a receita usa kg ou g` };
  }
  return { unidade: "un", pendencia: "unidade_ausente", detalhe: `unidade "${rotulo ?? ""}" não reconhecida: assumido "un" até conferência` };
}

function unidadeRendimento(rotulo) {
  const r = normalizarNome(rotulo);
  if (!r) return null;
  if (["GRAMAS", "GRAMA", "GR", "G"].includes(r)) return "g";
  if (["ML", "MILILITROS", "MILILITRO"].includes(r)) return "ml";
  if (["UNIDADE", "UNIDADES", "UN", "UM"].includes(r)) return "un";
  if (["QUILOS", "QUILO", "KG", "QUILOGRAMAS"].includes(r)) return "kg";
  if (["LITROS", "LITRO", "L"].includes(r)) return "l";
  return null;
}

/** Arredondamento só para EXIBIÇÃO nos relatórios (os cálculos mantêm precisão total). */
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);

/**
 * @param {Array<object>} arquivos saída de extrairFichas() de cada planilha, na ordem de prioridade
 * @param {{fonte: string}} opcoes
 */
export function planejarCatalogo(arquivos, { fonte }) {
  const inconsist = []; // {nivel:'erro'|'aviso'|'info', codigo, onde, detalhe}
  const aviso = (nivel, codigo, onde, detalhe) => inconsist.push({ nivel, codigo, onde, detalhe });

  // ------------------------------------------------------------------ INSUMOS (mestres)
  /** @type {Map<string, any>} */
  const insumos = new Map();
  const duplicatasIdenticas = [];
  // `precos`: custo unitário do insumo conforme o PRÓPRIO arquivo (1ª ocorrência = regra do VLOOKUP).
  // Serve só à conciliação de FIDELIDADE (provar que a leitura reproduz a planilha de origem).
  const locais = arquivos.map(() => ({ ing: new Set(), emb: new Set(), precos: new Map(), alias: new Map() }));

  arquivos.forEach((A, idx) => {
    const adicionar = (item, tipo) => {
      const n = normalizarNome(item.nome);
      const prefixo = tipo === "embalagem" ? "emb" : "ing";
      const chave = `${prefixo}:${n}`;
      const onde = `${A.categoria}!${tipo === "embalagem" ? "Embalagem" : "Ingredientes"}:${item.linha}`;
      const conjunto = locais[idx][prefixo];
      const jaNoArquivo = conjunto.has(n);
      conjunto.add(n);

      const qtd = num(item.qtd_embalagem);
      const preco = num(item.valor);
      const un = tipo === "embalagem"
        ? { unidade: "un", pendencia: null, detalhe: null }
        : inferirUnidade(item.unidade, qtd);
      const valido = preco != null && preco > 0 && qtd != null && qtd > 0;
      const observado = { arquivo: A.arquivo, categoria: A.categoria, onde, unidade_rotulo: item.unidade ?? null, qtd_embalagem: qtd, valor: preco };
      const novoInsumo = (chaveNova, nomeExibicao, extraPend = []) => {
        const pend = [...extraPend];
        if (un.pendencia) pend.push({ codigo: un.pendencia, detalhe: un.detalhe });
        if (!valido) pend.push({ codigo: "preco_ausente_ou_zero", detalhe: `valor=${item.valor ?? "vazio"} quantidade=${item.qtd_embalagem ?? "vazio"}` });
        insumos.set(chaveNova, {
          chave: chaveNova, nome: nomeExibicao, tipo: tipo === "embalagem" ? "embalagem" : "outro",
          unidade_medida: un.unidade,
          preco_caixa: valido ? preco : null, rendimento: valido ? qtd : null,
          referencia: { fontes: [observado], preco_planilha: preco, qtd_embalagem_planilha: qtd, unidade_rotulo: item.unidade ?? null },
          pendencias: pend,
        });
        for (const p of pend) aviso(p.codigo === "preco_ausente_ou_zero" ? "erro" : "aviso", p.codigo, onde, `${item.nome}: ${p.detalhe}`);
        return chaveNova;
      };

      if (!insumos.has(chave)) {
        novoInsumo(chave, String(item.nome).trim());
        locais[idx].precos.set(chave, valido ? preco / qtd : null);
        return;
      }
      const atual = insumos.get(chave);
      const f0 = atual.referencia.fontes[0];
      const igual = f0.valor === preco && f0.qtd_embalagem === qtd && normalizarNome(f0.unidade_rotulo) === normalizarNome(item.unidade);

      // (a) Repetido no MESMO mestre: o VLOOKUP do Excel usa a 1ª ocorrência — mantemos a 1ª e registramos.
      if (jaNoArquivo) {
        atual.referencia.fontes.push(observado);
        if (igual) duplicatasIdenticas.push(onde);
        else {
          const detalhe = `${item.nome}: repetido no mesmo mestre com valores diferentes — mantida a 1ª ocorrência (${f0.onde}: valor ${f0.valor}, qtd ${f0.qtd_embalagem}, un ${f0.unidade_rotulo}); esta: valor ${preco}, qtd ${qtd}, un ${item.unidade}`;
          if (!atual.pendencias.some((p) => p.codigo === "valores_divergentes")) atual.pendencias.push({ codigo: "valores_divergentes", detalhe });
          aviso("aviso", "valores_divergentes", onde, detalhe);
        }
        return;
      }
      // (b) Outro arquivo, mesmos valores: cadastro único.
      if (igual) { atual.referencia.fontes.push(observado); duplicatasIdenticas.push(onde); locais[idx].precos.set(chave, valido ? preco / qtd : null); return; }

      // (c) Outro arquivo, valores DIFERENTES: NÃO unifica em silêncio (subestimaria/superestimaria o CMV).
      //     Preserva uma VARIANTE por arquivo — cada ficha mantém o custo da sua planilha — e pede consolidação.
      const detalhe = `${item.nome}: valor diferente entre planilhas (${f0.categoria}: ${f0.valor}/${f0.qtd_embalagem} ${f0.unidade_rotulo} × ${A.categoria}: ${preco}/${qtd} ${item.unidade}) — mantidas as duas versões; consolidar escolhendo o custo vigente`;
      if (!atual.pendencias.some((p) => p.codigo === "valores_divergentes")) atual.pendencias.push({ codigo: "valores_divergentes", detalhe });
      aviso("aviso", "valores_divergentes", onde, detalhe);
      const chaveVar = `${chave}@${A.categoria}`;
      locais[idx].alias.set(chave, chaveVar);
      if (!insumos.has(chaveVar)) novoInsumo(chaveVar, `${String(item.nome).trim()} (${A.categoria})`, [{ codigo: "valores_divergentes", detalhe }]);
      else insumos.get(chaveVar).referencia.fontes.push(observado);
      locais[idx].precos.set(chaveVar, valido ? preco / qtd : null);
    };
    A.ingredientes.forEach((i) => adicionar(i, "insumo"));
    A.embalagens.forEach((i) => adicionar(i, "embalagem"));
  });

  // ------------------------------------------------------------------ PREPARAÇÕES: passo 1 (chaves + fusão)
  /** @type {Map<string, any>} */
  const produtos = new Map();
  const assinatura = (b) => JSON.stringify([
    num(b.rendimento), normalizarNome(b.unidade_rend),
    b.linhas.map((l) => `${normalizarNome(l.nome)}|${num(l.qtd)}`).sort(),
  ]);
  const prepsPorNome = new Map(); // nome normalizado -> [chaves]
  const prepLocal = arquivos.map(() => new Map()); // por arquivo: nome normalizado -> chave (1ª ocorrência = regra do VLOOKUP)

  arquivos.forEach((A, idx) => {
    for (const b of A.bases) {
      const n = normalizarNome(b.nome);
      const onde = `${A.categoria}!${b.aba}`;
      const sig = assinatura(b);
      const existentes = prepsPorNome.get(n) ?? [];
      let chave = existentes.find((c) => produtos.get(c).__sig === sig);
      if (chave) {
        produtos.get(chave).referencia.fontes.push({ arquivo: A.arquivo, categoria: A.categoria, aba: b.aba, mesclado: true });
        aviso("info", "preparacao_mesclada", onde, `${b.nome}: idêntica a ${chave} (mesma composição e rendimento) — cadastro único`);
      } else {
        chave = existentes.length ? `prep:${n}#${existentes.length + 1}` : `prep:${n}`;
        const pend = [];
        if (existentes.length) {
          const d = `${b.nome}: já existe preparação com este nome e receita DIFERENTE (${existentes.join(", ")}) — preservada à parte`;
          pend.push({ codigo: "nome_repetido_receita_diferente", detalhe: d });
          aviso("aviso", "nome_repetido_receita_diferente", onde, d);
        }
        produtos.set(chave, {
          chave, nome: String(b.nome).trim(), tipo: "submontagem", vendavel: false,
          rendimento: null, unidade_rendimento: null, homologacao: "pendente",
          referencia: { fontes: [{ arquivo: A.arquivo, categoria: A.categoria, aba: b.aba }], custo_total_planilha: num(b.custo_total), custo_unit_planilha: num(b.custo_unit), rendimento_planilha: num(b.rendimento) },
          pendencias: pend, linhas: [], mao_de_obra: [], __sig: sig, __bruto: b, __arquivoIdx: idx,
        });
        existentes.push(chave);
        prepsPorNome.set(n, existentes);
      }
      if (!prepLocal[idx].has(n)) prepLocal[idx].set(n, chave);
    }
  });

  // ------------------------------------------------------------------ FICHAS: chaves (preserva repetidos)
  const contadorFinal = new Map();
  const finaisPorNome = new Map(); // nome normalizado -> [{chave, onde}]
  arquivos.forEach((A, idx) => {
    for (const f of A.fichas) {
      const n = normalizarNome(f.nome);
      const k = `${A.categoria}:${n}`;
      const ordinal = (contadorFinal.get(k) ?? 0) + 1;
      contadorFinal.set(k, ordinal);
      const chave = `fin:${A.categoria.toLowerCase()}:${n}${ordinal > 1 ? `#${ordinal}` : ""}`;
      const onde = `${A.categoria}!${f.aba}`;
      const pend = [];
      if (ordinal > 1) pend.push({ codigo: "nome_repetido_na_categoria", detalhe: `${f.nome}: ${ordinal}ª ficha com o mesmo nome em ${A.categoria} (mantidas todas até conferência)` });
      const outras = finaisPorNome.get(n) ?? [];
      if (outras.length && !pend.length) pend.push({ codigo: "nome_repetido_entre_categorias", detalhe: `${f.nome}: também em ${outras.map((o) => o.onde).join(", ")}` });
      outras.push({ chave, onde });
      finaisPorNome.set(n, outras);
      pend.forEach((p) => aviso("aviso", p.codigo, onde, p.detalhe));
      produtos.set(chave, {
        chave, nome: String(f.nome).trim(), tipo: TIPO_PRODUTO_POR_CATEGORIA[A.categoria] ?? "outro", vendavel: true,
        rendimento: null, unidade_rendimento: null, homologacao: "pendente",
        referencia: {
          fontes: [{ arquivo: A.arquivo, categoria: A.categoria, aba: f.aba, ficha_no: f.ficha_no ?? null }],
          custo_total_planilha: num(f.custo_total), custo_unit_planilha: num(f.custo_unit),
          preco_venda_planilha: num(f.preco_venda), margem_desejada_planilha: num(f.margem_desejada),
        },
        pendencias: pend, linhas: [], mao_de_obra: [], __bruto: f, __arquivoIdx: idx, __final: true,
      });
    }
  });

  // ------------------------------------------------------------------ passo 2: linhas, rendimento, mão de obra
  function resolver(idx, nome, area) {
    const n = normalizarNome(nome);
    const efetiva = (c) => locais[idx].alias.get(c) ?? c; // variante por arquivo quando o valor diverge entre planilhas
    const ing = locais[idx].ing.has(n) ? { ref: "insumo", chave: efetiva(`ing:${n}`) } : null;
    const emb = locais[idx].emb.has(n) ? { ref: "insumo", chave: efetiva(`emb:${n}`) } : null;
    const prep = prepLocal[idx].has(n) ? { ref: "produto", chave: prepLocal[idx].get(n) } : null;
    if (area === "emb") return emb ?? ing ?? prep;
    if (area === "base") return prep ?? ing ?? emb;
    return ing ?? prep ?? emb;
  }

  for (const p of produtos.values()) {
    const b = p.__bruto;
    const A = arquivos[p.__arquivoIdx];
    const onde = `${A.categoria}!${b.aba}`;
    const add = (codigo, detalhe) => { p.pendencias.push({ codigo, detalhe }); aviso(BLOQUEANTES.has(codigo) ? "erro" : "aviso", codigo, onde, `${p.nome}: ${detalhe}`); };

    const rend = num(b.rendimento);
    if (rend != null && rend > 0) p.rendimento = rend; else { p.rendimento = 1; add("sem_rendimento", `rendimento ausente/inválido (${b.rendimento ?? "vazio"}) — assumido 1 apenas para não quebrar o cálculo; ficha fica pendente`); }
    p.unidade_rendimento = p.__final ? null : unidadeRendimento(b.unidade_rend);
    if (!p.__final && !p.unidade_rendimento) add("unidade_rendimento_ausente", `unidade do rendimento da preparação não informada (${b.unidade_rend ?? "vazio"})`);
    if (ehErro(b.custo_total) || (num(b.custo_total) != null && num(b.custo_total) <= 0) || b.custo_total == null) {
      add("custo_planilha_invalido", `custo total na planilha inválido (${b.custo_total ?? "vazio"})`);
    }
    if (b.layout_fora_do_padrao?.length) add("layout_inesperado", `aba fora do padrão do modelo (rótulos esperados ausentes em ${b.layout_fora_do_padrao.join(", ")}) — conferir manualmente`);
    if (num(b.desp_mat) || num(b.desp_emb) || num(b.desperdicio)) add("desperdicio_nao_importado", `desperdício percentual informado (${b.desp_mat ?? b.desperdicio}) — não modelado; conferir`);

    const grupos = p.__final
      ? [["ing", b.ingredientes], ["base", b.bases], ["emb", b.embalagens]]
      : [["ing", b.linhas], ["emb", b.embalagens ?? []]];
    const acumulado = new Map(); // "ref|chave" -> linha
    let ordem = 0;
    for (const [area, lista] of grupos) {
      for (const l of lista) {
        ordem += 1;
        const q = num(l.qtd);
        if (ehErro(l.valor_emb) || ehErro(l.qtd_emb) || ehErro(l.unit) || ehErro(l.total)) {
          add("linha_com_erro_na_planilha", `${l.nome} (linha ${l.linha}) com erro de fórmula na planilha (${[l.valor_emb, l.qtd_emb].filter(ehErro).join("/") || "#"})`);
        }
        const alvo = resolver(p.__arquivoIdx, l.nome, area);
        if (!alvo) { add("componente_nao_encontrado", `"${l.nome}" (linha ${l.linha}) não existe no cadastro de ${area === "emb" ? "embalagens" : "ingredientes/preparações"} — linha NÃO importada`); continue; }
        if (q == null || q <= 0) { add("linha_sem_quantidade", `"${l.nome}" (linha ${l.linha}) sem quantidade — linha NÃO importada`); continue; }
        const k = `${alvo.ref}|${alvo.chave}`;
        if (acumulado.has(k)) {
          acumulado.get(k).quantidade += q;
          add("linha_duplicada_somada", `"${l.nome}" aparece mais de uma vez na ficha — quantidades somadas`);
        } else {
          acumulado.set(k, { ref: alvo.ref, chave: alvo.chave, quantidade: q, ordem, nome_origem: String(l.nome).trim() });
        }
      }
    }
    // auto-referência (ex.: ficha cujo nome = preparação que ela mesma usa)
    for (const [k, l] of acumulado) {
      if (l.ref === "produto" && l.chave === p.chave) { acumulado.delete(k); add("ciclo_na_receita", `usa a si mesma ("${l.nome_origem}") — linha removida`); }
    }
    p.linhas = [...acumulado.values()];
    if (!p.linhas.length) add("sem_componentes", "nenhum componente válido importado");

    {
      const mods = new Map();
      for (const m of b.mod ?? []) {
        const minutos = num(m.min_rec);
        if (minutos == null) { add("mao_de_obra_invalida", `função "${m.nome}" sem minutos válidos — ignorada`); continue; }
        const cm = num(m.unit);
        if (cm == null) add("mao_de_obra_sem_custo_minuto", `função "${m.nome}" sem custo por minuto na planilha`);
        const atual = mods.get(m.nome);
        if (atual) atual.minutos += minutos; else mods.set(m.nome, { funcao: String(m.nome).trim(), minutos, custo_minuto: cm });
      }
      p.mao_de_obra = [...mods.values()];
    }
  }

  // ------------------------------------------------------------------ ciclos entre preparações (DFS)
  const estado = new Map();
  const dfs = (chave, trilha) => {
    if (estado.get(chave) === 2) return;
    if (estado.get(chave) === 1) {
      const p = produtos.get(chave);
      p.pendencias.push({ codigo: "ciclo_na_receita", detalhe: `ciclo detectado: ${[...trilha, chave].join(" → ")}` });
      aviso("erro", "ciclo_na_receita", chave, `ciclo: ${[...trilha, chave].join(" → ")}`);
      return;
    }
    estado.set(chave, 1);
    const p = produtos.get(chave);
    for (const l of p.linhas) if (l.ref === "produto") dfs(l.chave, [...trilha, chave]);
    estado.set(chave, 2);
  };
  for (const c of produtos.keys()) dfs(c, []);

  // ------------------------------------------------------------------ custo planejado × custo da planilha
  const custoUnitInsumo = (i) => (i.preco_caixa != null && i.rendimento > 0 ? i.preco_caixa / i.rendimento : null);
  // modo 'unificado' = preço único do catálogo (o que será gravado); 'fiel' = preço do arquivo de origem de cada ficha.
  const memos = { unificado: new Map(), fiel: new Map() };
  function custoLote(chave, modo = "unificado", prof = 0) {
    const memo = memos[modo];
    if (memo.has(chave)) return memo.get(chave);
    if (prof > 12) return null;
    const p = produtos.get(chave);
    let total = 0;
    for (const l of p.linhas) {
      let unit;
      if (l.ref === "insumo") {
        unit = modo === "fiel" ? (locais[p.__arquivoIdx].precos.get(l.chave) ?? null) : custoUnitInsumo(insumos.get(l.chave));
      } else { const c = custoLote(l.chave, modo, prof + 1); unit = c == null ? null : c / produtos.get(l.chave).rendimento; }
      if (unit == null) { memo.set(chave, null); return null; }
      total += l.quantidade * unit;
    }
    memo.set(chave, total);
    return total;
  }

  // MOD do LOTE incluindo a herdada das preparações usadas (a planilha soma a MOD da base no custo da ficha).
  // Fica SEMPRE fora do custo de ingredientes/embalagens: é só um indicador à parte e a base da conciliação.
  const memoMod = new Map();
  function modLoteTotal(chave, prof = 0) {
    if (memoMod.has(chave)) return memoMod.get(chave);
    if (prof > 12) return null;
    const p = produtos.get(chave);
    if (!p.mao_de_obra.every((m) => m.custo_minuto != null)) { memoMod.set(chave, null); return null; }
    let total = p.mao_de_obra.reduce((s, m) => s + m.minutos * m.custo_minuto, 0);
    for (const l of p.linhas) {
      if (l.ref !== "produto") continue;
      const sub = modLoteTotal(l.chave, prof + 1);
      if (sub == null) { memoMod.set(chave, null); return null; }
      total += l.quantidade * (sub / produtos.get(l.chave).rendimento);
    }
    memoMod.set(chave, total);
    return total;
  }

  const conciliacao = { conferem: 0, divergem: 0, nao_comparaveis: 0, divergencias: [] };
  // FIDELIDADE: com os preços do próprio arquivo, a leitura precisa reproduzir o custo da planilha.
  const fidelidade = { conferem: 0, divergem: 0, nao_comparaveis: 0, divergencias: [] };
  for (const p of produtos.values()) {
    // insumos sem custo contaminam a ficha
    const semCusto = p.linhas.filter((l) => l.ref === "insumo" && custoUnitInsumo(insumos.get(l.chave)) == null).map((l) => l.nome_origem);
    if (semCusto.length) { p.pendencias.push({ codigo: "insumo_sem_custo", detalhe: `insumo(s) sem custo: ${semCusto.join(", ")}` }); }
    const prepBloq = p.linhas.filter((l) => l.ref === "produto").filter((l) => produtos.get(l.chave).pendencias.some((x) => BLOQUEANTES.has(x.codigo) && x.codigo !== "preparacao_incompleta"));
    if (prepBloq.length) p.pendencias.push({ codigo: "preparacao_incompleta", detalhe: `usa preparação(ões) com pendência bloqueante: ${prepBloq.map((l) => l.nome_origem).join(", ")}` });

    const lote = custoLote(p.chave);
    const modLote = modLoteTotal(p.chave);
    p.__custoLote = lote;
    p.__custoUnit = lote == null ? null : lote / p.rendimento;
    p.__custoMODUnit = modLote == null ? null : modLote / p.rendimento;
    const planUnit = num(p.referencia.custo_unit_planilha);
    const planTotal = num(p.referencia.custo_total_planilha);
    const incomparavel = planUnit == null || planTotal == null || p.pendencias.some((x) => x.codigo === "linha_sem_quantidade" || x.codigo === "componente_nao_encontrado");
    // fidelidade (preço do arquivo de origem)
    const loteFiel = custoLote(p.chave, "fiel");
    if (loteFiel == null || incomparavel) fidelidade.nao_comparaveis += 1;
    else {
      const esperado = loteFiel + (modLote ?? 0);
      if (Math.abs(esperado - planTotal) <= EPS_CUSTO * Math.max(1, p.rendimento)) fidelidade.conferem += 1;
      else { fidelidade.divergem += 1; fidelidade.divergencias.push({ onde: `${p.referencia.fontes[0].categoria}!${p.referencia.fontes[0].aba}`, nome: p.nome, planilha_lote: r4(planTotal), importado_lote: r4(esperado) }); }
    }
    if (lote == null || incomparavel) { conciliacao.nao_comparaveis += 1; continue; }
    // O "Custo Total" da planilha inclui mão de obra (M6 = I57): comparamos o custo do lote com MOD somada.
    const esperadoLote = lote + (modLote ?? 0);
    if (Math.abs(esperadoLote - planTotal) <= EPS_CUSTO * Math.max(1, p.rendimento)) conciliacao.conferem += 1;
    else {
      conciliacao.divergem += 1;
      const d = { chave: p.chave, nome: p.nome, onde: p.referencia.fontes[0].categoria + "!" + p.referencia.fontes[0].aba, planilha_lote: r4(planTotal), importado_lote: r4(esperadoLote) };
      conciliacao.divergencias.push(d);
      p.pendencias.push({ codigo: "custo_difere_da_planilha", detalhe: `lote planilha ${d.planilha_lote} × importado ${d.importado_lote}` });
      aviso("erro", "custo_difere_da_planilha", d.onde, `${p.nome}: lote na planilha ${d.planilha_lote} × recalculado ${d.importado_lote}`);
    }
  }

  // ------------------------------------------------------------------ saída
  const lista = [...produtos.values()];
  for (const p of lista) p.completa = !p.pendencias.some((x) => BLOQUEANTES.has(x.codigo));

  const payload = {
    insumos: [...insumos.values()],
    produtos: lista.map((p) => ({
      chave: p.chave, nome: p.nome, tipo: p.tipo, vendavel: p.vendavel, rendimento: p.rendimento,
      unidade_rendimento: p.unidade_rendimento, homologacao: "pendente",
      referencia: p.referencia, pendencias: p.pendencias,
      linhas: p.linhas.map(({ ref, chave, quantidade, ordem }) => ({ ref, chave, quantidade, ordem })),
      mao_de_obra: p.mao_de_obra,
    })),
  };

  const finais = lista.filter((p) => p.__final);
  const preps = lista.filter((p) => !p.__final);
  const contar = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const porCodigo = contar(inconsist, (x) => x.codigo);
  const relatorio = {
    fonte,
    totais: {
      registros_origem: arquivos.reduce((s, A) => s + A.fichas.length + A.bases.length, 0),
      fichas_origem: arquivos.reduce((s, A) => s + A.fichas.length, 0),
      preparacoes_origem: arquivos.reduce((s, A) => s + A.bases.length, 0),
      produtos_finais_planejados: finais.length,
      preparacoes_planejadas: preps.length,
      insumos_planejados: payload.insumos.filter((i) => i.tipo !== "embalagem").length,
      embalagens_planejadas: payload.insumos.filter((i) => i.tipo === "embalagem").length,
      linhas_ficha: lista.reduce((s, p) => s + p.linhas.length, 0),
      linhas_mao_de_obra: lista.reduce((s, p) => s + p.mao_de_obra.length, 0),
      nomes_distintos: new Set(lista.map((p) => normalizarNome(p.nome))).size,
      completas: lista.filter((p) => p.completa).length,
      pendentes: lista.filter((p) => !p.completa).length,
      duplicatas_identicas_de_mestre: duplicatasIdenticas.length,
    },
    por_categoria: Object.fromEntries(arquivos.map((A) => [A.categoria, { fichas: A.fichas.length, preparacoes: A.bases.length, ingredientes_mestre: A.ingredientes.length, embalagens_mestre: A.embalagens.length }])),
    pendencias_por_codigo: porCodigo,
    conciliacao_custos: conciliacao,
    conciliacao_fidelidade: fidelidade,
    fichas_pendentes: lista.filter((p) => !p.completa).map((p) => ({ chave: p.chave, nome: p.nome, onde: `${p.referencia.fontes[0].categoria}!${p.referencia.fontes[0].aba}`, bloqueios: p.pendencias.filter((x) => BLOQUEANTES.has(x.codigo)).map((x) => x.codigo) })),
    inconsistencias: inconsist,
    custos_planejados: lista.map((p) => ({ chave: p.chave, custo_unit_ingredientes_embalagens: r4(p.__custoUnit), custo_unit_mao_de_obra: r4(p.__custoMODUnit) })),
  };
  return { payload, relatorio };
}

/** Defesa em profundidade antes de enviar ao banco (o SQL também valida). Devolve lista de erros. */
export function validarPayload(payload) {
  const erros = [];
  const ins = new Set(payload.insumos.map((i) => i.chave));
  const prod = new Set(payload.produtos.map((p) => p.chave));
  if (ins.size !== payload.insumos.length) erros.push("chaves de insumo duplicadas");
  if (prod.size !== payload.produtos.length) erros.push("chaves de produto duplicadas");
  for (const i of payload.insumos) if (!UNIDADES_VALIDAS.has(i.unidade_medida)) erros.push(`unidade inválida em ${i.chave}`);
  for (const p of payload.produtos) {
    if (!(p.rendimento > 0)) erros.push(`rendimento inválido em ${p.chave}`);
    const vistos = new Set();
    for (const l of p.linhas) {
      if (!(l.quantidade > 0)) erros.push(`quantidade inválida em ${p.chave}`);
      if (l.ref === "insumo" ? !ins.has(l.chave) : !prod.has(l.chave)) erros.push(`referência quebrada ${p.chave} → ${l.chave}`);
      const k = `${l.ref}|${l.chave}`; if (vistos.has(k)) erros.push(`componente repetido em ${p.chave}: ${l.chave}`); vistos.add(k);
    }
  }
  return erros;
}
