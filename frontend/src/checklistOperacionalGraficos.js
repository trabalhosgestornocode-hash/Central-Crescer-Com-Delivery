// Checklist Operacional — GRÁFICOS do Dashboard Operacional (SVG puro; funções sem DOM).
//
// Mesmo SVG na tela e no PDF (o relatório é impresso pelo navegador: Chart.js/canvas não serve lá). Nenhum número é
// calculado aqui — só desenhado a partir do payload do backend.
//
// Regras (skill de visualização): um eixo só por gráfico (medidas de escalas diferentes = gráficos separados);
// cores categóricas em ordem fixa por ETAPA (nunca pela posição); cores de status (dentro/atrasado) reservadas e sempre
// com rótulo; legenda com ≥ 2 séries + rótulo direto no fim da linha; grade e eixos discretos; marcas finas;
// dado ausente = lacuna (nunca zero). Cada gráfico tem a tabela equivalente (`<details>`) e alvos de hover
// (`data-tip`) que o controlador transforma em tooltip.

import { escapeHtml } from "./utils.js";

/** Cor por etapa (fixa: a etapa sempre tem a mesma cor, com ou sem filtro). */
export const COR_ETAPA = Object.freeze({ preparo: "var(--ckd-s1)", entrega: "var(--ckd-s2)", vida: "var(--ckd-s3)" });
export const NOME_ETAPA = Object.freeze({ preparo: "Preparo", entrega: "Entrega", vida: "Vida do pedido" });

const L = 640;              // largura do viewBox
const A = 230;              // altura do viewBox
const M = { t: 26, r: 92, b: 34, l: 44 };
const num = (v, casas = 1) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas, minimumFractionDigits: 0 }));
const dataCurta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Teto "redondo" do eixo e 4 divisões. */
export function escala(max) {
  if (!(max > 0)) return { teto: 1, passos: [0, 0.25, 0.5, 0.75, 1] };
  const bruto = max * 1.1;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const teto = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((t) => t >= bruto) ?? 10 * mag;
  return { teto, passos: [0, 1, 2, 3, 4].map((i) => (teto * i) / 4) };
}

function eixoY(esc, unidade) {
  const h = A - M.t - M.b;
  return esc.passos.map((v) => {
    const y = M.t + h - (v / esc.teto) * h;
    return `<line x1="${M.l}" x2="${L - M.r}" y1="${y}" y2="${y}" class="ckd-grade"/><text x="${M.l - 6}" y="${y + 4}" class="ckd-eixo" text-anchor="end">${num(v, 0)}</text>`;
  }).join("") + `<text x="2" y="11" class="ckd-eixo" text-anchor="start">${escapeHtml(unidade)}</text>`;
}

function rotulosX(categorias, x, cada) {
  return categorias.map((c, i) => (i % cada === 0 || i === categorias.length - 1
    ? `<text x="${x(i)}" y="${A - M.b + 16}" class="ckd-eixo" text-anchor="middle">${escapeHtml(c)}</text>` : "")).join("");
}

function tabela(titulo, cabecalho, linhas) {
  return `<details class="ckd-tabela-grafico"><summary>Ver tabela de dados</summary>
    <table><caption class="ckd-sr">${escapeHtml(titulo)}</caption><thead><tr>${cabecalho.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr></thead>
    <tbody>${linhas.map((l) => `<tr>${l.map((c, i) => (i === 0 ? `<th scope="row">${escapeHtml(String(c))}</th>` : `<td>${escapeHtml(String(c))}</td>`)).join("")}</tr>`).join("")}</tbody></table></details>`;
}

function legenda(itens) {
  if (itens.length < 2) return "";
  return `<ul class="ckd-legenda">${itens.map((i) => `<li><i style="background:${i.cor}"></i>${escapeHtml(i.rotulo)}</li>`).join("")}</ul>`;
}

const figura = (id, titulo, sub, corpo) => `
  <figure class="ckd-grafico" data-grafico="${id}">
    <figcaption><b>${escapeHtml(titulo)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ""}</figcaption>
    ${corpo}
  </figure>`;

const vazio = (id, titulo, motivo) => figura(id, titulo, null, `<p class="ckd-grafico-vazio">${escapeHtml(motivo)}</p>`);

/**
 * Linhas por dia (mediana de cada etapa). Dia sem medição = lacuna. Com UMA etapa, a meta vigente no fim do período
 * aparece como referência tracejada (rotulada).
 */
export function graficoEvolucao(dashboard, { metrica = "mediana" } = {}) {
  const dias = dashboard.evolucaoDiaria ?? [];
  const etapas = dashboard.etapas ?? [];
  const titulo = `Evolução diária — tempo ${metrica === "media" ? "médio" : "mediano"}`;
  const valores = etapas.flatMap((e) => dias.map((d) => d.porEtapa[e]?.[metrica]).filter((v) => v != null));
  if (dias.length < 2 || !valores.length) return vazio("evolucao", titulo, dias.length < 2 ? "A evolução diária aparece em períodos de 2 dias ou mais." : "Sem medições no período.");
  const metaRef = etapas.length === 1 ? dashboard.metasAplicaveis?.versoes?.at(-1)?.valores?.[etapas[0]]?.meta ?? null : null;
  const esc = escala(Math.max(...valores, metaRef ?? 0));
  const h = A - M.t - M.b;
  const x = (i) => M.l + ((L - M.l - M.r) * i) / (dias.length - 1);
  const y = (v) => M.t + h - (v / esc.teto) * h;
  const series = etapas.map((e) => {
    let d = "";
    let aberto = false;
    dias.forEach((dia, i) => {
      const v = dia.porEtapa[e]?.[metrica];
      if (v == null) { aberto = false; return; }
      d += `${aberto ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      aberto = true;
    });
    const ultimo = [...dias.keys()].reverse().find((i) => dias[i].porEtapa[e]?.[metrica] != null);
    const pontos = dias.map((dia, i) => (dia.porEtapa[e]?.[metrica] == null ? ""
      : `<circle cx="${x(i)}" cy="${y(dia.porEtapa[e][metrica])}" r="3" class="ckd-ponto" style="fill:${COR_ETAPA[e]}"/>`)).join("");
    const rotulo = ultimo == null ? "" : `<text x="${x(ultimo) + 8}" y="${y(dias[ultimo].porEtapa[e][metrica]) + 4}" class="ckd-rotulo">${NOME_ETAPA[e]} ${num(dias[ultimo].porEtapa[e][metrica])}</text>`;
    return `<path d="${d}" class="ckd-linha" style="stroke:${COR_ETAPA[e]}"/>${pontos}${rotulo}`;
  }).join("");
  const ref = metaRef == null ? "" : `<line x1="${M.l}" x2="${L - M.r}" y1="${y(metaRef)}" y2="${y(metaRef)}" class="ckd-ref"/><text x="${L - M.r + 8}" y="${y(metaRef) - 6}" class="ckd-rotulo ckd-rotulo--ref">meta ${num(metaRef)}</text>`;
  const larg = (L - M.l - M.r) / Math.max(1, dias.length - 1);
  const alvos = dias.map((dia, i) => {
    const tip = [`${dataCurta(dia.data)}${dia.semCobertura ? " (sem cobertura)" : ""}`, `${dia.pedidos} pedidos`, ...etapas.map((e) => `${NOME_ETAPA[e]}: ${num(dia.porEtapa[e]?.[metrica])} min`)].join(" · ");
    return `<rect x="${x(i) - larg / 2}" y="${M.t}" width="${larg}" height="${h}" class="ckd-alvo" data-tip="${escapeHtml(tip)}"/>`;
  }).join("");
  const svg = `<svg viewBox="0 0 ${L} ${A}" role="img" aria-label="${escapeHtml(titulo)}">${eixoY(esc, "min")}${rotulosX(dias.map((d) => dataCurta(d.data)), x, Math.ceil(dias.length / 8))}${ref}${series}${alvos}</svg>`;
  return figura("evolucao", titulo, "minutos por dia do recebimento; dia sem medição fica em branco", svg
    + legenda(etapas.map((e) => ({ rotulo: NOME_ETAPA[e], cor: COR_ETAPA[e] })))
    + tabela(titulo, ["Dia", "Pedidos", ...etapas.map((e) => `${NOME_ETAPA[e]} (min)`)], dias.map((d) => [dataCurta(d.data), d.pedidos, ...etapas.map((e) => num(d.porEtapa[e]?.[metrica]))])));
}

/** Barras verticais de UMA série (uma cor; o título nomeia a série). */
export function graficoBarras({ id, titulo, sub, categorias, valores, dicas, unidade, cor = "var(--ckd-s1)", formato = (v) => num(v, 0), rotular = true }) {
  const validos = valores.filter((v) => v != null);
  if (!validos.length || !validos.some((v) => v > 0)) return vazio(id, titulo, "Sem dados no período.");
  const esc = escala(Math.max(...validos));
  const h = A - M.t - M.b;
  const passo = (L - M.l - 16) / categorias.length;
  const lb = Math.max(2, passo - 2); // 2 px de respiro entre barras
  const y = (v) => M.t + h - (v / esc.teto) * h;
  const maior = Math.max(...validos);
  const barras = valores.map((v, i) => {
    const bx = M.l + i * passo + 1;
    if (v == null || v <= 0) return `<rect x="${bx}" y="${M.t}" width="${lb}" height="${h}" class="ckd-alvo" data-tip="${escapeHtml(dicas?.[i] ?? `${categorias[i]}: ${v == null ? "sem dado" : formato(v)}`)}"/>`;
    const top = y(v);
    const r = Math.min(4, lb / 2, (A - M.b) - top);
    // Ponta arredondada só em cima (ancorada na base).
    const d = `M${bx},${A - M.b}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + lb - r}Q${bx + lb},${top} ${bx + lb},${top + r}V${A - M.b}Z`;
    const rot = rotular && v === maior ? `<text x="${bx + lb / 2}" y="${top - 5}" class="ckd-rotulo" text-anchor="middle">${formato(v)}</text>` : "";
    return `<path d="${d}" style="fill:${cor}"/>${rot}<rect x="${bx}" y="${M.t}" width="${lb}" height="${h}" class="ckd-alvo" data-tip="${escapeHtml(dicas?.[i] ?? `${categorias[i]}: ${formato(v)}`)}"/>`;
  }).join("");
  const x = (i) => M.l + i * passo + passo / 2;
  const svg = `<svg viewBox="0 0 ${L} ${A}" role="img" aria-label="${escapeHtml(titulo)}">${eixoY(esc, unidade)}${rotulosX(categorias, x, categorias.length > 12 ? 3 : 1)}${barras}</svg>`;
  return figura(id, titulo, sub, svg + tabela(titulo, ["", titulo], categorias.map((c, i) => [c, valores[i] == null ? "—" : formato(valores[i])])));
}

/** Barra 100% empilhada (distribuição por status), com rótulos e legenda — a cor de status nunca vai sozinha. */
export function graficoDistribuicao(dashboard) {
  const d = dashboard.resumo?.distribuicaoStatus ?? { dentro: 0, atrasado: 0, semAvaliacao: 0 };
  const titulo = "Distribuição por status operacional";
  const itens = [
    { chave: "dentro", rotulo: "Dentro da meta", cor: "var(--ckd-bom)", n: d.dentro },
    { chave: "atrasado", rotulo: "Atrasado", cor: "var(--ckd-ruim)", n: d.atrasado },
    { chave: "semAvaliacao", rotulo: "Sem avaliação (sem meta ou sem medição)", cor: "var(--ckd-neutro)", n: d.semAvaliacao },
  ];
  const total = itens.reduce((s, i) => s + i.n, 0);
  if (!total) return vazio("distribuicao", titulo, "Nenhum pedido no período.");
  let acc = 0;
  const W = L - 2;
  const segs = itens.filter((i) => i.n > 0).map((i) => {
    const w = (i.n / total) * W;
    const x0 = 1 + acc;
    acc += w;
    const pct = (i.n / total) * 100;
    return `<rect x="${x0 + 1}" y="10" width="${Math.max(0, w - 2)}" height="34" rx="4" style="fill:${i.cor}"/>`
      + (pct >= 8 ? `<text x="${x0 + w / 2}" y="32" class="ckd-rotulo ckd-rotulo--dentro" text-anchor="middle">${num(pct, 0)}%</text>` : "")
      + `<rect x="${x0}" y="10" width="${w}" height="34" class="ckd-alvo" data-tip="${escapeHtml(`${i.rotulo}: ${i.n} pedidos (${num(pct)}%)`)}"/>`;
  }).join("");
  return figura("distribuicao", titulo, `${total} pedidos do período`, `<svg viewBox="0 0 ${L} 54" role="img" aria-label="${escapeHtml(titulo)}">${segs}</svg>`
    + `<ul class="ckd-legenda">${itens.map((i) => `<li><i style="background:${i.cor}"></i>${escapeHtml(i.rotulo)}: <b>${i.n}</b></li>`).join("")}</ul>`
    + tabela(titulo, ["Status", "Pedidos", "%"], itens.map((i) => [i.rotulo, i.n, `${num((i.n / total) * 100)}%`])));
}

/** Os gráficos do Dashboard, na ordem da tela e do PDF. */
export function graficosDoDashboard(d) {
  const horas = d.demandaPorHora ?? [];
  const nomesHora = horas.map((h) => `${String(h.hora).padStart(2, "0")}h`);
  const semana = d.volumePorDiaDaSemana ?? [];
  return {
    evolucao: graficoEvolucao(d),
    volumeDiario: graficoBarras({
      id: "volume-diario", titulo: "Pedidos por dia", sub: "pedidos recebidos em cada dia do período", unidade: "pedidos",
      categorias: (d.evolucaoDiaria ?? []).map((x) => dataCurta(x.data)), valores: (d.evolucaoDiaria ?? []).map((x) => (x.semCobertura ? null : x.pedidos)),
    }),
    demandaHora: graficoBarras({
      id: "demanda-hora", titulo: "Horários de maior demanda", sub: "pedidos por hora do recebimento, somados no período", unidade: "pedidos",
      categorias: nomesHora, valores: horas.map((h) => h.pedidos),
    }),
    atrasoHora: graficoBarras({
      id: "atraso-hora", titulo: "Pedidos atrasados por horário", sub: "% dos pedidos avaliados de cada hora; hora sem avaliação fica em branco", unidade: "%",
      categorias: nomesHora, valores: horas.map((h) => h.pctAtrasados), cor: "var(--ckd-ruim)", formato: (v) => `${num(v)}%`,
      dicas: horas.map((h) => `${String(h.hora).padStart(2, "0")}h: ${h.pctAtrasados == null ? "sem avaliação" : `${num(h.pctAtrasados)}% (${h.atrasados} de ${h.avaliados})`}`),
    }),
    semana: graficoBarras({
      id: "semana", titulo: "Volume por dia da semana", sub: "média de pedidos por dia observado", unidade: "pedidos/dia",
      categorias: semana.map((s) => s.nome.slice(0, 3)), valores: semana.map((s) => s.mediaPorDia), formato: (v) => num(v),
      dicas: semana.map((s) => `${s.nome}: ${s.pedidos} pedidos em ${s.diasObservados} ${s.diasObservados === 1 ? "dia" : "dias"} (${num(s.mediaPorDia)} por dia)`),
    }),
    distribuicao: graficoDistribuicao(d),
  };
}
