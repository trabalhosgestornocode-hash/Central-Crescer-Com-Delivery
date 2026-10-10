// Checklist Operacional — COMPONENTES VISUAIS (funções puras: dados → HTML).
//
// Nenhuma função aqui lê estado, DOM ou rede: recebem o `ResumoChecklist`
// (contrato em checklistOperacionalModelo.js) e o instante `agora`, e devolvem
// HTML. O controlador (checklistOperacional.js) decide quando montar e o que
// atualizar a cada segundo — sem redesenhar a tela inteira.
//
// Linguagem visual (mesma dos cards de status da Central — `.adm-kpi`,
// `.padm-card`): a FAIXA LATERAL carrega o estado. Em contadores vivos ela
// pulsa num ritmo proporcional à meta (`.cko-pulso`, animado pelo
// controlador); números encerrados nunca pulsam.
//
// Todo texto vindo de dado (nome da unidade, comentário de avaliação, número
// do pedido) passa por escapeHtml.

import { escapeHtml } from "./utils.js";
import { icon } from "./icons.js";
import { MODOS_EXIBICAO } from "./checklistOperacionalExibicao.js";
import {
  ROTULO_NIVEL, ROTULO_NIVEL_FINAL, ROTULO_SATISFACAO, PASSOS, SELO_CONEXAO, TETO_REGUA,
  fmtMin, fmtHoraCurta, fmtIdade, fmtCronometro, rotuloPedido, etapaDoStatus, classificarFinal,
  estadoDoCard, derivarDecomposicao, derivarPedidoAtivo, ordenarPorUrgencia,
  derivarStatusOperacao, derivarAvaliacoes,
} from "./checklistOperacionalModelo.js";

/**
 * Paginador de uma lista longa. TODOS os itens ficam no DOM (nos dois modos); no Modo Televisão o controlador
 * mostra uma página por vez e alterna sozinho (paginarPaineis). No Tablet fica escondido e a lista rola.
 * O total escrito vem do dado, não da página: nunca muda com a página visível.
 */
export function paginacao(chave, { total, singular, plural, rotulo }) {
  return `
      <nav class="cko-paginacao" data-paginacao="${chave}" data-total="${total}" data-singular="${singular}" data-plural="${plural}" aria-label="Páginas de ${rotulo}" hidden>
        <button type="button" class="cko-pag-btn" data-acao="pagina-anterior" aria-label="Página anterior de ${rotulo}">${icon("chevron-left", { size: 18 })}</button>
        <span class="cko-pag-rot" data-pagina-rot>Página 1 de 1</span>
        <button type="button" class="cko-pag-btn" data-acao="pagina-proxima" aria-label="Próxima página de ${rotulo}">${icon("chevron-right", { size: 18 })}</button>
      </nav>`;
}

const faixa = (pulsa) => `<span class="cko-faixa" aria-hidden="true">${pulsa ? '<i class="cko-pulso" data-pulso></i>' : ""}</span>`;

const estadoTexto = (nivel, rotulos = ROTULO_NIVEL, rotulo = rotulos[nivel]) =>
  `<p class="cko-estado" data-estado><i class="cko-estado-marca" aria-hidden="true"></i><span data-estado-rot>${rotulo}</span></p>`;

/** Régua até 120% da meta, com marcas no início da atenção e na meta. */
export function regua(razao, avisoPct) {
  const pct = (v) => `${((v / TETO_REGUA) * 100).toFixed(1)}%`;
  const preench = razao == null ? 0 : Math.min(1, razao / TETO_REGUA) * 100;
  return `
    <div class="cko-regua" aria-hidden="true">
      <span class="cko-regua-fill" data-regua style="width:${preench.toFixed(1)}%"></span>
      <span class="cko-regua-marca cko-regua-marca--aviso" style="left:${pct((avisoPct ?? 80) / 100)}"></span>
      <span class="cko-regua-marca cko-regua-marca--meta" style="left:${pct(1)}"></span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Cards de tempo: "Agora" (contador vivo) + "Hoje" (concluídos, estáticos)
// ---------------------------------------------------------------------------

const DEFINICAO = {
  preparo: "Da confirmação até o pedido ficar pronto",
  entrega: "Da saída até a conclusão do pedido",
  vida: "Do recebimento até a conclusão",
};
const TITULO = { preparo: "Tempo de preparo", entrega: "Tempo de entrega", vida: "Vida do pedido" };
const NA_ETAPA = { preparo: "em preparo", entrega: "em entrega", vida: "em andamento" };
const VAZIO_AGORA = { preparo: "Nenhum pedido em preparo agora", entrega: "Nenhum pedido em entrega agora", vida: "Nenhum pedido em andamento agora" };

export const textoQuantidade = (chave, n) => `${n} ${NA_ETAPA[chave]}`;

function zonaAgora(chave, e) {
  const v = e.vivo;
  if (!v) {
    return `
      <section class="cko-agora cko-agora--vazio" data-agora="vazio">
        <p class="cko-agora-rot">Agora</p>
        <p class="cko-agora-vazio">${VAZIO_AGORA[chave]}</p>
      </section>`;
  }
  return `
    <section class="cko-agora" data-agora="vivo">
      <p class="cko-agora-rot">Agora
        <b data-agora-pedido>${escapeHtml(rotuloPedido(v.pedido.displayId))}</b>
        <span data-agora-qtd>${textoQuantidade(chave, v.quantidade)}</span>
      </p>
      <p class="cko-num" data-agora-crono>${v.cronometro}</p>
      ${regua(v.razao, v.avisoPct)}
      <p class="cko-agora-pe">
        <span class="cko-restante${v.restante.excedido ? " cko-restante--excedido" : ""}" data-agora-restante>${v.restante.texto}</span>
        <span>Meta ${fmtCronometro(v.meta)}</span>
      </p>
    </section>`;
}

/** Por que um número é aproximado (o "≈" sempre explica a sua causa). */
const MOTIVO_APROXIMADO = {
  preparo: "Aproximado: sem o evento de pronto, medido até a saída do pedido",
  entrega: "Aproximado: a conclusão do iFood ainda não foi validada como entrega ao cliente",
  vida: "Aproximado",
};

function zonaHoje(e, chave) {
  const h = e.hoje;
  const meta = `<div><dt>Meta</dt><dd>${h.meta != null ? `${fmtMin(h.meta)} min` : "—"}</dd></div>`;
  if (!h.disponivel) {
    // Dado real sem os carimbos necessários: diz que não dá para medir e por quê — nunca um número.
    return `
    <dl class="cko-hoje cko-hoje--indisponivel">
      <div class="cko-hoje-indisp"><dt>Indicador indisponível</dt><dd>${escapeHtml(h.motivo ?? "Os pedidos do dia não têm os carimbos necessários.")}</dd></div>
      ${meta}
    </dl>`;
  }
  const valor = (min, nivel, aprox = false) => min == null
    ? '<dd class="cko-hoje-vazio">—</dd>'
    : `<dd class="cko-nivel-txt--${nivel}" title="${ROTULO_NIVEL_FINAL[nivel]}">${aprox ? `<span title="${MOTIVO_APROXIMADO[chave] ?? "Aproximado"}">≈</span>` : ""}${fmtMin(min)} min</dd>`;
  const amostras = h.mediaMin == null ? "" : ` <small class="cko-hoje-amostras">${h.amostras} ${h.amostras === 1 ? "pedido" : "pedidos"}</small>`;
  return `
    <dl class="cko-hoje">
      <div><dt>Média hoje${amostras}</dt>${valor(h.mediaMin, h.mediaNivel, h.mediaAproximada)}</div>
      <div><dt>${chave === "entrega" ? "Última medição" : "Último concluído"}</dt>${valor(h.ultimoMin, h.ultimoNivel, h.ultimoAproximado)}</div>
      ${meta}
    </dl>`;
}

function blocoDecomposicao(decomposicao, vidaMin) {
  const d = derivarDecomposicao(decomposicao, vidaMin);
  if (!d) return "";
  const barras = d.trechos.filter((t) => t.min != null).map((t) =>
    `<span class="cko-decomp-seg cko-decomp-seg--${t.chave}" style="flex-grow:${t.min}" title="${escapeHtml(`${t.rotulo}: ${fmtMin(t.min)} min`)}"></span>`).join("")
    + (d.lacunaMin ? `<span class="cko-decomp-seg cko-decomp-seg--lacuna" style="flex-grow:${d.lacunaMin}" title="Trecho sem medição"></span>` : "");
  const legenda = d.trechos.map((t) =>
    `<li><i class="cko-decomp-cor cko-decomp-seg--${t.chave}"></i>${t.rotulo} <b>${t.min == null ? "—" : fmtMin(t.min)}</b></li>`).join("");
  return `
    <div class="cko-decomp">
      <p class="cko-decomp-rot">Último concluído por trecho, em minutos</p>
      <div class="cko-decomp-barra" aria-hidden="true">${barras}</div>
      <ul class="cko-decomp-legenda">${legenda}</ul>
      ${d.incompleta || d.lacunaMin ? '<p class="cko-decomp-nota">Há trechos sem medição neste pedido. A vida é medida direto, do recebimento à conclusão.</p>' : ""}
    </div>`;
}

export function cardTempo(chave, resumo, agora) {
  const e = estadoDoCard(chave, resumo, agora);
  return `
    <article class="cko-card cko-tempo cko-nivel--${e.nivel}" data-card="${chave}" data-nivel="${e.nivel}" data-origem="${e.origemNivel}" aria-labelledby="cko-t-${chave}">
      ${faixa(e.vivo != null)}
      <header class="cko-card-cab">
        <div>
          <h2 id="cko-t-${chave}">${TITULO[chave]}</h2>
          <p class="cko-def">${DEFINICAO[chave]}</p>
        </div>
        ${estadoTexto(e.nivel, ROTULO_NIVEL, e.rotulo)}
      </header>
      ${zonaAgora(chave, e)}
      ${zonaHoje(e, chave)}
      ${chave === "vida" ? blocoDecomposicao(resumo.indicadores?.vida?.decomposicao, e.hoje.ultimoMin) : ""}
    </article>`;
}

// ---------------------------------------------------------------------------
// Status da operação
// ---------------------------------------------------------------------------

export function cardStatus(resumo, agora) {
  const s = derivarStatusOperacao(resumo, agora);
  const motivos = s.motivos.length
    ? `<ul class="cko-status-motivos">${s.motivos.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`
    : `<p class="cko-status-calmo">${s.nivel === "neutro" ? "Os indicadores aparecem com o primeiro pedido do dia." : "Pedidos e médias do dia dentro das metas da unidade."}</p>`;
  const medias = s.medias.map(([nome, n]) =>
    `<li class="cko-nivel-txt--${n}"><i class="cko-ponto"></i>${nome}<span>${ROTULO_NIVEL_FINAL[n]}</span></li>`).join("");
  return `
    <article class="cko-card cko-status cko-nivel--${s.nivel}" data-assinatura="${assinaturaStatus(s)}" data-nivel="${s.nivel}" aria-labelledby="cko-t-status">
      ${faixa(false)}
      <h2 id="cko-t-status">Status da operação</h2>
      <p class="cko-status-veredito">${s.rotulo}</p>
      ${motivos}
      <dl class="cko-status-contagem">
        <div><dt>Em andamento</dt><dd>${s.ativos}</dd></div>
        <div class="${s.fora ? "cko-nivel-txt--critico" : ""}"><dt>Atrasados agora</dt><dd>${s.fora}</dd></div>
        <div><dt>Concluídos hoje</dt><dd>${s.concluidos}</dd></div>
        <div><dt>Cancelados hoje</dt><dd>${s.cancelados}</dd></div>
      </dl>
      <ul class="cko-status-medias" aria-label="Médias do dia">${medias}</ul>
    </article>`;
}

/** Muda só quando algo visível no card de status muda — o tique de 1 s não redesenha à toa. */
export function assinaturaStatus(s) {
  return [s.nivel, s.ativos, s.fora, s.proximos, s.concluidos, s.cancelados, ...s.medias.map(([, n]) => n), ...(s.alertas ?? [])].join("|");
}

// ---------------------------------------------------------------------------
// Pedidos em andamento
// ---------------------------------------------------------------------------

function trilho(passoAtual) {
  return `<ol class="cko-trilho" aria-hidden="true">${PASSOS.map((_, i) =>
    `<li class="${i < passoAtual ? "feito" : i === passoAtual ? "atual" : ""}"></li>`).join("")}</ol>`;
}

const META_DA_ETAPA = { preparo: "Meta do preparo", entrega: "Meta da entrega", vida: "Meta da vida" };

/** Aviso quando o pedido está ruim pela VIDA total, não pela etapa atual. */
export function textoVida(p) {
  return p.governadoPelaVida ? `Vida do pedido em ${p.vida.cronometro}: ${ROTULO_NIVEL[p.vida.nivel].toLowerCase()}` : "";
}

export function linhaPedidoAtivo(p) {
  const e = p.daEtapa;
  return `
    <li class="cko-ped cko-nivel--${p.nivel}" data-pedido="${escapeHtml(p.id)}" data-nivel="${p.nivel}">
      ${faixa(true)}
      <div class="cko-ped-id">
        <strong>${escapeHtml(rotuloPedido(p.displayId))}</strong>
        <span>Recebido ${fmtHoraCurta(p.recebidoEm)}</span>
        ${p.semConclusao ? '<span class="cko-ped-alerta">Aberto há mais de 4 h sem conclusão</span>' : p.agendado ? '<span class="cko-ped-agendado">Agendado</span>' : ""}
      </div>
      <div class="cko-ped-etapa">
        <span class="cko-ped-etapa-rot">${escapeHtml(p.etapa.rotulo)}</span>
        ${trilho(p.etapa.passo)}
      </div>
      <div class="cko-ped-meta">
        ${regua(e.razao, e.avisoPct)}
        <span>${p.indicador ? `${META_DA_ETAPA[p.indicador]} ${fmtCronometro(e.meta)}` : "Agendado: sem meta de preparo"}</span>
      </div>
      <div class="cko-ped-tempo">
        <span class="cko-crono cko-crono--${e.nivel}" data-crono>${e.cronometro}</span>
        <span class="cko-restante${e.restante.excedido ? " cko-restante--excedido" : ""}" data-restante>${e.restante.texto}</span>
      </div>
      <p class="cko-ped-vida" data-vida${p.governadoPelaVida ? "" : " hidden"}>${textoVida(p)}</p>
    </li>`;
}

export function painelPedidosAtivos(resumo, agora) {
  const derivados = ordenarPorUrgencia((resumo.pedidosAtivos ?? []).map((p) => derivarPedidoAtivo(p, resumo.metas, agora)));
  // Todos os pedidos em andamento, sem teto: a TV pagina, o Tablet rola — nenhum fica de fora.
  const corpo = derivados.length
    ? `<ul class="cko-peds" data-cabe>${derivados.map(linhaPedidoAtivo).join("")}</ul>
       ${paginacao("ativos", { total: derivados.length, singular: "pedido em andamento", plural: "pedidos em andamento", rotulo: "Pedidos em andamento" })}`
    : `<div class="cko-vazio">${icon("check-circle", { size: 26 })}<p>Nenhum pedido em andamento agora.</p></div>`;
  return `
    <section class="cko-card cko-painel cko-painel--ativos" data-painel="ativos" aria-labelledby="cko-t-ativos" data-assinatura-ativos="${derivados.map((p) => p.id).join(",")}">
      <header class="cko-painel-cab">
        <h2 id="cko-t-ativos">Pedidos em andamento</h2>
        <span class="cko-contagem">${derivados.length}</span>
        <span class="cko-painel-nota">Quem precisa de ação aparece primeiro</span>
      </header>
      ${corpo}
    </section>`;
}

// ---------------------------------------------------------------------------
// Últimos pedidos (tempos ENCERRADOS: cor do estado, sem animação)
// ---------------------------------------------------------------------------

function celulaTempo(min, limite, { emAndamento = false, aproximado = false } = {}) {
  if (min == null) return `<td class="cko-td-tempo cko-td-vazio">${emAndamento ? "em curso" : "—"}</td>`;
  const n = classificarFinal(min, limite);   // tempo ENCERRADO: dentro ou acima da meta — nunca "próximo"
  return `<td class="cko-td-tempo cko-nivel-txt--${n}" title="${ROTULO_NIVEL_FINAL[n]}">${aproximado ? '<span title="Aproximado">≈</span>' : ""}${fmtMin(min)}</td>`;
}

export function painelUltimosPedidos(resumo) {
  const lista = resumo.ultimosPedidos ?? [];
  const m = resumo.metas ?? {};
  const linhas = lista.map((p) => {
    const etapa = etapaDoStatus(p.status);
    const ativo = etapa.passo >= 0 && etapa.passo < 4;
    const cancelado = etapa.passo === -1;
    return `
      <tr class="${cancelado ? "cko-tr-cancelado" : ""}">
        <th scope="row">${escapeHtml(rotuloPedido(p.displayId))}</th>
        <td>${fmtHoraCurta(p.recebidoEm)}</td>
        <td><span class="cko-etq${cancelado ? " cko-etq--cancelado" : ativo ? " cko-etq--andamento" : ""}">${escapeHtml(etapa.rotulo)}</span></td>
        ${cancelado ? '<td class="cko-td-tempo cko-td-vazio" colspan="3">Fora das médias</td>' : `
        ${celulaTempo(p.preparoMin, m.preparo, { emAndamento: ativo && etapa.passo < 2, aproximado: p.preparoAproximado })}
        ${celulaTempo(p.entregaMin, m.entrega, { emAndamento: ativo && etapa.passo === 3 })}
        ${celulaTempo(p.vidaMin, m.vida, { emAndamento: ativo })}`}
      </tr>`;
  }).join("");
  const corpo = lista.length
    ? `<div class="cko-tabela-wrap"><table class="cko-tabela">
        <thead><tr><th scope="col">Pedido</th><th scope="col">Horário</th><th scope="col">Status</th>
          <th scope="col" class="cko-th-tempo">Preparo</th><th scope="col" class="cko-th-tempo">Entrega</th><th scope="col" class="cko-th-tempo">Vida</th></tr></thead>
        <tbody data-cabe>${linhas}</tbody></table></div>
        ${paginacao("ultimos", { total: lista.length, singular: "pedido recente", plural: "pedidos recentes", rotulo: "Últimos pedidos" })}`
    : `<div class="cko-vazio">${icon("inbox", { size: 26 })}<p>Os pedidos do dia aparecem aqui assim que chegarem.</p></div>`;
  return `
    <section class="cko-card cko-painel cko-painel--ultimos" data-painel="ultimos" aria-labelledby="cko-t-ultimos">
      <header class="cko-painel-cab">
        <h2 id="cko-t-ultimos">Últimos pedidos</h2>
        <span class="cko-painel-nota">Tempos em minutos</span>
      </header>
      ${corpo}
    </section>`;
}

// ---------------------------------------------------------------------------
// Avaliações — critério de satisfação próprio, sem pulsar
// ---------------------------------------------------------------------------

function estrelas(nota, { tam = 16 } = {}) {
  const cheia = Math.round(nota);
  return `<span class="cko-estrelas" role="img" aria-label="${cheia} de 5 estrelas">${[1, 2, 3, 4, 5].map((i) =>
    `<svg viewBox="0 0 24 24" width="${tam}" height="${tam}" class="${i <= cheia ? "on" : ""}" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.1l-5.7 3.2 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>`).join("")}</span>`;
}

function itemAvaliacao(a) {
  return `
    <li class="cko-aval-item${a.negativa ? " cko-aval-item--negativa" : ""}">
      <p class="cko-aval-item-cab">${estrelas(a.nota, { tam: 14 })}
        <span>${fmtHoraCurta(a.em)}${a.displayId ? ` no pedido ${escapeHtml(rotuloPedido(a.displayId))}` : ""}</span>
        ${a.negativa ? '<em class="cko-aval-neg">Avaliação negativa</em>' : ""}
      </p>
      ${a.comentario ? `<blockquote>${escapeHtml(a.comentario)}</blockquote>` : '<p class="cko-aval-semcom">Sem comentário.</p>'}
    </li>`;
}

export function painelAvaliacoes(resumo) {
  const a = derivarAvaliacoes(resumo.avaliacoes);
  if (!a.disponivel) {
    return `
      <section class="cko-card cko-painel cko-painel--avaliacoes cko-nivel--neutro" aria-labelledby="cko-t-aval">
        <header class="cko-painel-cab"><h2 id="cko-t-aval">Avaliações dos clientes</h2></header>
        <div class="cko-vazio">
          ${icon("lock", { size: 24 })}
          <p><strong>Avaliações ainda não conectadas</strong></p>
          <p>${escapeHtml(a.motivo ?? "O acesso às avaliações do iFood ainda não foi liberado para a Central. Quando for, a média do dia e os comentários aparecem aqui.")}</p>
        </div>
      </section>`;
  }
  const variacao = a.variacao == null ? "" :
    `<span class="cko-aval-var">${a.variacao > 0 ? "+" : a.variacao < 0 ? "−" : ""}${fmtMin(Math.abs(a.variacao))} em relação a ontem</span>`;
  const dist = a.distribuicao.map((d) =>
    `<li class="${d.negativa && d.qtd ? "cko-aval-dist--neg" : ""}"><span>${d.nota}</span><i class="cko-aval-barra"><b style="width:${d.pct.toFixed(1)}%"></b></i><em>${d.qtd}</em></li>`).join("");
  return `
    <section class="cko-card cko-painel cko-painel--avaliacoes cko-nivel--${a.nivel}" data-painel="avaliacoes" aria-labelledby="cko-t-aval">
      ${faixa(false)}
      <header class="cko-painel-cab">
        <h2 id="cko-t-aval">Avaliações dos clientes</h2>
        ${estadoTexto(a.nivel, ROTULO_SATISFACAO)}
      </header>
      <div class="cko-aval-topo">
        <div class="cko-aval-media">
          <p class="cko-aval-num">${a.mediaDia == null ? "—" : fmtMin(a.mediaDia)}</p>
          <div>
            ${a.mediaDia == null ? "" : estrelas(a.mediaDia, { tam: 17 })}
            <span class="cko-aval-total">${a.total} ${a.total === 1 ? "avaliação" : "avaliações"} hoje${a.negativasHoje ? `, ${a.negativasHoje} ${a.negativasHoje === 1 ? "negativa" : "negativas"}` : ""}</span>
            ${variacao}
          </div>
        </div>
        <ul class="cko-aval-dist" aria-label="Distribuição das notas">${dist}</ul>
      </div>
      <p class="cko-aval-rot">Comentários recentes</p>
      ${a.recentes.length
        ? `<ul class="cko-aval-lista" data-cabe>${a.recentes.map(itemAvaliacao).join("")}</ul>
           ${paginacao("avaliacoes", { total: a.recentes.length, singular: "comentário", plural: "comentários", rotulo: "Comentários recentes" })}`
        : '<p class="cko-aval-semcom">Nenhum comentário hoje.</p>'}
    </section>`;
}

// ---------------------------------------------------------------------------
// Cabeçalho e tela completa
// ---------------------------------------------------------------------------

export function textoSincronizacao(conexao, agora) {
  const iso = conexao?.ultimaSincronizacao;
  if (!iso) return "Nenhuma sincronização ainda";
  const idade = fmtIdade(iso, agora);
  const hora = new Date(Date.parse(iso)).toLocaleTimeString("pt-BR");
  return `Atualizado às ${hora}${idade ? ` (${idade})` : ""}`;
}

export function cabecalho(resumo, agora, { podeEditarMetas = false } = {}) {
  const selo = SELO_CONEXAO[resumo.conexao?.estado] ?? SELO_CONEXAO.sem_dados;
  return `
    <header class="cko-cab">
      <div class="cko-cab-id">
        <img src="/assets/menu-checklist-operacional.png" alt="" class="cko-cab-logo" />
        <div>
          <h1>Checklist Operacional</h1>
          <p class="cko-cab-unidade">${escapeHtml(resumo.unidade?.nome ?? "Unidade")}</p>
        </div>
      </div>
      <div class="cko-cab-estado">
        <span class="cko-selo cko-selo--${selo.tom}" title="${escapeHtml(selo.dica)}"><i></i>${selo.rotulo}</span>
        <span class="cko-sinc" data-sinc>${textoSincronizacao(resumo.conexao, agora)}</span>
      </div>
      <time class="cko-relogio" data-relogio>${new Date(agora).toLocaleTimeString("pt-BR")}</time>
      <div class="cko-cab-acoes">
        ${podeEditarMetas ? `<button type="button" class="cko-btn" data-acao="metas">${icon("sliders-horizontal", { size: 18 })}<span>Metas</span></button>` : ""}
        <button type="button" class="cko-btn" data-acao="tela-cheia" aria-pressed="false"><span data-icone-tela>${icon("maximize", { size: 18 })}</span><span data-rotulo-tela>Tela cheia</span></button>
        <button type="button" class="cko-btn cko-btn--sutil" data-acao="voltar">${icon("arrow-left", { size: 18 })}<span>Voltar ao Checklist</span></button>
      </div>
      <p class="cko-aviso-tela" data-aviso-tela role="status" hidden></p>
    </header>`;
}

/** Faixa que identifica a demonstração em qualquer tamanho de tela (inclusive TV, de longe). */
function faixaDemonstracao(resumo) {
  if (resumo.origem !== "demonstracao") return "";
  return `<p class="cko-faixa-demo" role="note"><b>Modo demonstração.</b> Pedidos, tempos e avaliações são simulados. Nada é gravado e nenhuma ação é enviada ao iFood.</p>`;
}

/**
 * Faixa do estado dos dados REAIS (integração não ativada, sem pedidos, desatualizado, sem conexão): o
 * aviso vem pronto do adaptador (checklistOperacionalDados.js). Visível de longe, como a da demonstração.
 */
export function faixaAviso(resumo) {
  const a = resumo.origem === "demonstracao" ? null : resumo.aviso;
  if (!a?.titulo) return "";
  return `<p class="cko-faixa-demo cko-faixa-aviso cko-faixa-aviso--${escapeHtml(a.tom ?? "neutro")}" role="status" data-aviso><b>${escapeHtml(a.titulo)}.</b>${a.texto ? ` ${escapeHtml(a.texto)}` : ""}</p>`;
}

/**
 * Raiz do dashboard. `opcoes.modo` ("tv" | "tablet") só muda a CLASSE da raiz: o conteúdo é o mesmo
 * `conteudoTela` nos dois modos (paridade garantida por construção — ver checklistOperacionalExibicao.js).
 */
export function montarTela(resumo, agora, opcoes = {}) {
  const modo = MODOS_EXIBICAO[opcoes.modo] ? opcoes.modo : null;
  const classes = ["cko", resumo.origem === "demonstracao" ? "cko--demo" : "", modo ? `cko--imersivo cko--${modo}` : ""].filter(Boolean).join(" ");
  // No modo, a raiz recebe o foco ao abrir (tabindex -1: focável por script, fora da ordem do Tab).
  return `<div class="${classes}" data-cko${modo ? ` data-modo="${modo}" tabindex="-1" role="region" aria-label="Checklist Operacional"` : ""}>${conteudoTela(resumo, agora, opcoes)}</div>`;
}

/** Miolo da tela — redesenhado DENTRO da raiz para não derrubar a tela cheia. */
export function conteudoTela(resumo, agora, opcoes = {}) {
  return `
      ${faixaDemonstracao(resumo)}
      <div data-slot-aviso>${faixaAviso(resumo)}</div>
      ${cabecalho(resumo, agora, opcoes)}
      <div class="cko-linha cko-linha--tempos">
        ${cardTempo("preparo", resumo, agora)}
        ${cardTempo("entrega", resumo, agora)}
        ${cardTempo("vida", resumo, agora)}
        <div data-slot-status>${cardStatus(resumo, agora)}</div>
      </div>
      <div class="cko-linha cko-linha--operacao">
        ${painelPedidosAtivos(resumo, agora)}
        ${painelUltimosPedidos(resumo)}
        ${painelAvaliacoes(resumo)}
      </div>`;
}

// ---------------------------------------------------------------------------
// Metas da unidade (demonstração — nada é salvo)
// ---------------------------------------------------------------------------

const fmtCampo = (v) => (v == null ? "" : String(v).replace(".", ","));

export function dialogoMetas(metas, { erros = {}, demonstracao = true } = {}) {
  const campo = (nome, rotulo, valor, sufixo) => `
    <label class="cko-campo${erros[nome] ? " cko-campo--erro" : ""}">
      <span>${rotulo}</span>
      <span class="cko-campo-entrada"><input name="${nome}" inputmode="decimal" autocomplete="off" value="${escapeHtml(fmtCampo(valor))}"
        ${erros[nome] ? `aria-invalid="true" aria-describedby="cko-erro-${nome}"` : ""} /><i>${sufixo}</i></span>
      ${erros[nome] ? `<em id="cko-erro-${nome}">${escapeHtml(erros[nome])}</em>` : ""}
    </label>`;
  const grupo = (chave) => `
    <fieldset class="cko-metas-grupo">
      <legend>${TITULO[chave]}</legend>
      <p>${DEFINICAO[chave]}</p>
      <div class="cko-metas-par">
        ${campo(`${chave}Meta`, "Meta", metas[chave]?.meta, "min")}
        ${campo(`${chave}Aviso`, "Próximo da meta a partir de", metas[chave]?.avisoPct, "% da meta")}
      </div>
    </fieldset>`;
  return `
    <form method="dialog" class="cko-metas" novalidate>
      <header>
        <h2 id="cko-t-metas">Metas da unidade</h2>
        <p>Pedido em andamento: abaixo do aviso, dentro da meta; do aviso até a meta, próximo da meta; depois da meta, atrasado. Etapa concluída: dentro da meta até a meta, acima da meta depois dela.</p>
        ${demonstracao
          ? '<p class="cko-metas-demo">Metas de demonstração: valem só nesta tela e não são salvas.</p>'
          : '<p class="cko-metas-demo">Metas desta tela: valem só neste aparelho até recarregar e ainda não são salvas para a unidade.</p>'}
      </header>
      ${grupo("preparo")}
      ${grupo("entrega")}
      ${grupo("vida")}
      <footer>
        <button type="button" class="cko-btn cko-btn--sutil" data-acao="metas-exemplo">Restaurar exemplo</button>
        <span></span>
        <button type="button" class="cko-btn cko-btn--sutil" data-acao="metas-cancelar">Cancelar</button>
        <button type="submit" class="cko-btn cko-btn--primario" value="aplicar">Aplicar metas</button>
      </footer>
    </form>`;
}

/** Tela de escolha de unidade (o Checklist é sempre de UMA unidade). */
export function telaSemUnidade() {
  return `
    <div class="cko cko--sem-unidade" data-cko>
      <div class="cko-vazio cko-vazio--tela">
        ${icon("store", { size: 32 })}
        <p><strong>Escolha uma unidade</strong></p>
        <p>O Checklist Operacional acompanha uma unidade por vez. Selecione a unidade no seletor do topo da página.</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Seleção do modo de exibição (página do menu, dentro da Central)
// ---------------------------------------------------------------------------

/** Miniatura esquemática do arranjo (blocos neutros, sem número nenhum: não é dado). */
const MINIATURA = {
  tv: ["ok", "atencao", "ok", "critico", "neutro", "neutro", "neutro"],
  tablet: ["ok", "atencao", "ok", "critico", "neutro", "neutro"],
};

function opcaoModo(modo) {
  const m = MODOS_EXIBICAO[modo];
  return `
    <article class="ckm-opcao" data-opcao-modo="${m.id}" aria-labelledby="ckm-t-${m.id}">
      <div class="ckm-ilustra" aria-hidden="true">
        <div class="ckm-aparelho ckm-aparelho--${m.id}">
          <div class="ckm-tela">${MINIATURA[m.id].map((t) => `<i class="ckm-bloco ckm-bloco--${t}"></i>`).join("")}</div>
        </div>
      </div>
      <h2 id="ckm-t-${m.id}"><span class="ckm-icone">${icon(m.id, { size: 22 })}</span>${m.rotulo}</h2>
      <p class="ckm-desc">${m.descricao}</p>
      <ul class="ckm-destaques">${m.destaques.map((d) => `<li>${icon("check-circle", { size: 16 })}<span>${d}</span></li>`).join("")}</ul>
      <button type="button" class="btn btn-primary ckm-iniciar" data-acao="iniciar-modo" data-modo="${m.id}">${icon("maximize", { size: 17 })}<span>${m.acao}</span></button>
    </article>`;
}

/**
 * Página do Checklist no menu: escolha entre Televisão e Tablet. Nenhum dado é consultado aqui — a consulta
 * e o Realtime começam só quando um modo é aberto (e param ao voltar).
 */
export function telaSelecaoModos({ unidadeNome, demonstracao = false, aviso = null } = {}) {
  return `
    <section class="ckm" data-ckm aria-labelledby="ckm-titulo">
      <header class="ckm-cab">
        <img src="/assets/menu-checklist-operacional.png" alt="" class="ckm-logo" />
        <div>
          <h1 id="ckm-titulo">Checklist Operacional</h1>
          <p>Acompanhe os indicadores da sua operação em tempo real. Escolha o formato ideal para seu dispositivo.</p>
        </div>
      </header>
      <p class="ckm-contexto">
        <span>${icon("store", { size: 16 })}<b>${escapeHtml(unidadeNome ?? "Unidade")}</b></span>
        ${demonstracao ? '<span class="ckm-demo">Modo demonstração: dados simulados</span>' : ""}
      </p>
      ${aviso ? `<p class="ckm-aviso" role="alert">${escapeHtml(aviso)}</p>` : ""}
      <div class="ckm-opcoes">
        ${opcaoModo("tv")}
        ${opcaoModo("tablet")}
      </div>
      <p class="ckm-nota">
        Os dois formatos mostram exatamente os mesmos indicadores, alertas e estados, do mesmo resumo da unidade.
        A tela cheia esconde o menu, mas a sessão continua sendo a sua: não deixe o aparelho sem supervisão.
      </p>
    </section>`;
}
