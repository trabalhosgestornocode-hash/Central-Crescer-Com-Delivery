// Parser Food Delivery — fonte de cada dia (calendário) e recuperação assistida de um mês pela Foody.
// PURO (só monta HTML e decide): as chamadas à API ficam em parserFoodDelivery.js. Nunca inventa número: tudo vem do backend
// (GET /parser-food-delivery/cobertura e GET /integracoes/foody/sincronizacoes/previa-mes). "Sem dados" nunca é "dia zerado".

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const rotuloMes = (mes) => { const [a, m] = String(mes).split("-"); return `${MESES[Number(m) - 1] ?? m} de ${a}`; };
const diaMes = (d) => String(d).slice(8, 10);
const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const DIAS_SEMANA = ["D", "S", "T", "Q", "Q", "S", "S"];
/** Lote máximo da sincronização manual (backend: LIMITES_SYNC_MANUAL.maxDias). */
export const LOTE_RECUPERACAO = 7;

/** Classe e rótulo de um dia do calendário. */
export function estadoDoDia(d) {
  if (d.fonte === "planilha") return { classe: "planilha", rotulo: "Relatório importado" };
  if (d.fonte === "foody") return d.provisorio ? { classe: "provisorio", rotulo: d.aberto ? "Foody — dia em andamento" : "Foody — provisório" } : { classe: "foody", rotulo: "Foody (sincronização)" };
  if (d.aberto) return { classe: "aberto", rotulo: "Dia em andamento" };
  return { classe: "vazio", rotulo: "Sem dados" };
}

/**
 * Calendário compacto do período (uma grade por mês). `cob` = resposta de /cobertura com habilitado=true.
 * @param {{ escapeHtml: Function, fmtDataHora: Function }} f
 */
export function calendarioCoberturaHtml(cob, { escapeHtml, fmtDataHora }) {
  if (!cob?.habilitado) return "";
  if (cob.erro) return `<p class="pfd-secao-nota pfd-secao-nota--warn">Não foi possível montar o calendário de fontes agora (${escapeHtml(cob.erro)}).</p>`;
  const porMes = new Map();
  for (const d of cob.dias ?? []) {
    const m = d.data.slice(0, 7);
    if (!porMes.has(m)) porMes.set(m, []);
    porMes.get(m).push(d);
  }
  const grades = [...porMes.entries()].map(([mes, dias]) => {
    const offsetPrimeiroDia = new Date(`${dias[0].data}T12:00:00Z`).getUTCDay();
    const vazios = Array.from({ length: offsetPrimeiroDia }, () => `<span class="pfd-cob-dia pfd-cob-fora" aria-hidden="true"></span>`).join("");
    const celulas = dias.map((d) => {
      const e = estadoDoDia(d);
      const extra = [e.rotulo, d.triagem ? `${d.triagem} em triagem` : "", d.ultimaAtualizacao ? `atualizado ${fmtDataHora(d.ultimaAtualizacao)}` : ""].filter(Boolean).join(" · ");
      return `<span class="pfd-cob-dia pfd-cob-${e.classe}${d.triagem ? " pfd-cob-triagem" : ""}" title="${escapeHtml(`${d.data.split("-").reverse().join("/")}: ${extra}`)}">${diaMes(d.data)}</span>`;
    }).join("");
    return `<div class="pfd-cob-mes"><div class="pfd-cob-titulo">${escapeHtml(maiuscula(rotuloMes(mes)))}</div>
      <div class="pfd-cob-grade" role="list" aria-label="Fonte de cada dia em ${escapeHtml(rotuloMes(mes))}">
        ${DIAS_SEMANA.map((s) => `<span class="pfd-cob-sem" aria-hidden="true">${s}</span>`).join("")}${vazios}${celulas}</div></div>`;
  }).join("");
  const t = cob.totais ?? {};
  const ultima = (cob.dias ?? []).map((d) => d.ultimaAtualizacao).filter(Boolean).sort().at(-1);
  const leg = (classe, rotulo, n) => `<span class="pfd-cob-leg"><i class="pfd-cob-dia pfd-cob-${classe}"></i>${rotulo}${n != null ? ` <b>${n}</b>` : ""}</span>`;
  return `<div class="pfd-cob">${grades}</div>
    <div class="pfd-cob-legenda">
      ${leg("planilha", "Relatório importado", t.planilha)}${leg("foody", "Foody", (t.foody ?? 0) - (t.provisorios ?? 0))}
      ${leg("provisorio", "Provisório", t.provisorios)}${leg("vazio", "Sem dados", t.semDados)}${t.abertos ? leg("aberto", "Em andamento", t.abertos) : ""}
      ${t.comTriagem ? `<span class="pfd-cob-leg"><i class="pfd-cob-dia pfd-cob-triagem"></i>Com triagem <b>${t.comTriagem}</b></span>` : ""}
    </div>
    <p class="pfd-secao-nota"><span>${ultima ? `Última atualização: ${escapeHtml(fmtDataHora(ultima))}. ` : ""}"Sem dados" significa que não há registro do dia — não é um dia sem vendas.</span></p>`;
}

/**
 * Mês a oferecer para recuperação: o mês (já encerrado ou o atual) do primeiro dia "sem dados" do período.
 * Só quando a flag está ligada e há dia sem dados fora do dia em curso. Nunca oferece o futuro.
 */
export function mesParaRecuperar(cob) {
  if (!cob?.habilitado || cob.erro) return null;
  const semDados = (cob.dias ?? []).filter((d) => d.fonte === "sem_dados" && !d.aberto);
  if (!semDados.length) return null;
  const mes = semDados[0].data.slice(0, 7);
  const doMes = (cob.dias ?? []).filter((d) => d.data.startsWith(mes) && !d.aberto);
  return { mes, rotulo: rotuloMes(mes), semDados: semDados.filter((d) => d.data.startsWith(mes)).length,
    comDados: doMes.filter((d) => d.fonte !== "sem_dados").length, papel: cob.papel ?? null };
}

export function bannerRecuperacaoHtml(oferta, { escapeHtml, icon }) {
  if (!oferta) return "";
  const nome = oferta.rotulo.split(" de ")[0];
  return `<div class="pfd-cob-banner">
    <span>${icon("calendar", { size: 15 })} <b>${escapeHtml(oferta.rotulo[0].toUpperCase() + oferta.rotulo.slice(1))}</b> — dados incompletos
      (${oferta.semDados} ${oferta.semDados === 1 ? "dia" : "dias"} sem dados${oferta.comDados ? `, ${oferta.comDados} com dados` : ""}).</span>
    <button class="btn btn-ghost btn-sm" id="pfd-preencher-mes" data-mes="${escapeHtml(oferta.mes)}">${icon("refresh", { size: 14 })} Preencher mês de ${escapeHtml(nome)}</button>
  </div>`;
}

/** Divide os dias a gravar em lotes aceitos pela sincronização manual. */
export function lotesDeRecuperacao(dias, tamanho = LOTE_RECUPERACAO) {
  const ordenados = [...new Set(dias ?? [])].sort();
  const lotes = [];
  for (let i = 0; i < ordenados.length; i += tamanho) lotes.push(ordenados.slice(i, i + tamanho));
  return lotes;
}

const OPERACAO_ROTULO = { subway: "Subway", acai_no_grau: "Açaí no Grau", triagem: "Em triagem" };

/** Resumo da prévia (só números devolvidos pelo backend). */
export function previaRecuperacaoHtml(p, { escapeHtml, fmtMoeda }) {
  const t = p.totais ?? {};
  const comDados = (t.completos ?? 0) + (t.provisorios ?? 0);
  const recuperaveis = (t.recuperaveis ?? 0) + (t.parciais ?? 0);
  const indisponiveis = (t.indisponiveis ?? 0) + (t.semPedidosNaOrigem ?? 0);
  const item = (rot, val) => `<div class="vd-pv-item"><span>${escapeHtml(rot)}</span><b>${escapeHtml(String(val))}</b></div>`;
  const ops = Object.keys(t.porOperacao ?? {}).sort().map((op) => `<li>${escapeHtml(OPERACAO_ROTULO[op] ?? op)}: ${t.porOperacao[op]} pedidos (${t.comEntregador?.[op] ?? 0} com entregador${t.taxasPrevistasCentavos?.[op] != null ? `, taxas previstas ${escapeHtml(fmtMoeda(t.taxasPrevistasCentavos[op] / 100))}` : ""})</li>`).join("");
  const nota = (txt) => `<p class="pfd-secao-nota pfd-secao-nota--warn">${txt}</p>`;
  return `
    <div class="vd-pv-grid">
      ${item("Dias com dados", comDados)}${item("Dias recuperáveis", recuperaveis)}${item("Dias indisponíveis", indisponiveis)}
      ${item("Pedidos identificados na origem", t.pedidosNaOrigem ?? 0)}
    </div>
    ${ops ? `<ul class="pfd-cob-ops">${ops}</ul><p class="pfd-secao-nota">Taxas <b>previstas</b> pela Foody, antes das regras de cancelamento do Parser — os valores finais aparecem no Parser depois da gravação.</p>` : ""}
    ${t.provisorios ? nota(`${t.provisorios} ${t.provisorios === 1 ? "dia já existe" : "dias já existem"} com pendência (ex.: triagem): não serão regravados — confira a triagem em Integrações › Foody.`) : ""}
    ${t.semPedidosNaOrigem ? nota(`${t.semPedidosNaOrigem} ${t.semPedidosNaOrigem === 1 ? "dia voltou" : "dias voltaram"} sem nenhum pedido na Foody. Isso não confirma que a loja ficou fechada; esses dias não são gravados.`) : ""}
    ${t.indisponiveis ? nota(`${t.indisponiveis} ${t.indisponiveis === 1 ? "dia não pôde" : "dias não puderam"} ser consultados${p.interrompidoPor ? ` (${escapeHtml(p.interrompidoPor)})` : ""}.`) : ""}
    ${p.emCache ? `<p class="pfd-secao-nota">Prévia consultada há poucos minutos (reaproveitada para não repetir chamadas à Foody).</p>` : ""}`;
}
