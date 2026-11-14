// Telas do Financeiro v2 como funções PURAS (dados do motor → HTML escapado). Nenhuma fórmula financeira aqui:
// valores, subtotais, percentuais e situações chegam prontos do backend e só são apresentados.
import { CLASSIFICACOES, competencia, dataBR, descricaoLegivel, esc, moeda, nomeCanal, percentual, situacao } from "./formatar.js";
import { cardsFinanceirosDaVisaoGeral } from "./telasTesouraria.js";

const selo = (codigo) => { const s = situacao(codigo); return `<span class="selo selo--${s.classe}" title="${esc(s.explicacao)}">${esc(s.rotulo)}</span>`; };
const valorClasse = (c) => (c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor");
const valor = (c) => `<span class="${valorClasse(c)}">${esc(moeda(c))}</span>`;
const explicar = (titulo, texto) => `<details class="explica"><summary aria-label="Como este valor é calculado: ${esc(titulo)}"><span aria-hidden="true">i</span></summary><p>${esc(texto)}</p></details>`;
const botaoComposicao = (codigo) => `<button type="button" class="botao-link" data-composicao="${esc(codigo)}">Ver composição completa</button>`;
/** Chave da pendência na Central de Conferências (o mesmo fato), quando o registro é conhecido; senão, sem ligação. */
const chaveNaCentral = (p) => (p.lancamentoId ? `LANCAMENTO:${p.lancamentoId}` : p.movimentacaoId ? `MOVIMENTACAO:${p.movimentacaoId}` : p.propostaId ? `PROPOSTA:${p.propostaId}` : p.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS" && p.data ? `DIA:${p.data}` : null);
const revisarNaCentral = (p) => { const k = chaveNaCentral(p); return k ? ` <a class="botao-link" href="#/conferencias?revisar=${esc(k)}">Revisar</a>` : ""; };
const pendenciasCurtas = (lista = [], max = 3) => (lista.length ? `<ul class="pendencias">${lista.slice(0, max).map((p) => `<li>${esc(p.mensagem)}${p.valorCentavos !== undefined && p.valorCentavos !== null ? ` <strong>${esc(moeda(p.valorCentavos))}</strong>` : ""}${revisarNaCentral(p)}</li>`).join("")}${lista.length > max ? `<li>e mais ${lista.length - max} pendência(s).</li>` : ""}</ul>` : "");

// ------------------------------------------------------------------------------------------- estados
export function estado(tipo, mensagem = "") {
  const t = {
    carregando: ["Carregando dados da competência…", "carregando"], erro: ["Não foi possível carregar.", "erro"], negado: ["Acesso negado ao Financeiro v2 nesta unidade.", "erro"],
    "sem-sessao": ["Sessão ausente ou expirada. Entre novamente para ver o financeiro.", "erro"], vazio: ["Sem dados para esta competência.", "info"],
  }[tipo] ?? ["", "info"];
  return `<div class="estado estado--${t[1]}" role="${tipo === "carregando" ? "status" : "alert"}" ${tipo === "carregando" ? 'aria-busy="true"' : ""}><p>${esc(t[0])}</p>${mensagem ? `<p class="estado-detalhe">${esc(mensagem)}</p>` : ""}${tipo === "carregando" ? '<div class="esqueleto"></div><div class="esqueleto"></div>' : ""}</div>`;
}

const ESTADO_DA_COMPETENCIA = Object.freeze({ ABERTA: "Competência aberta", FECHAMENTO_PRELIMINAR: "Fechamento preliminar", FECHAMENTO_COM_PENDENCIAS: "Fechamento com pendências documentadas", FECHAMENTO_HOMOLOGADO: "Competência homologada" });

// ------------------------------------------------------------------------------------------- visão geral
export function visaoGeral(vg, { unidadeNome = "" } = {}) {
  const fb = vg.faturamentoBruto;
  const liq = vg.faturamentoLiquidoGerencial;
  const res = vg.resultadoGerencial;
  const canais = fb.porCanal.filter((c) => c.canal !== "NAO_IDENTIFICADO" || (c.valorCentavos ?? 0) !== 0);
  const zeroConfirmado = fb.valorCentavos === 0 && fb.situacao === "CONFIRMADO";
  const grupos = Object.fromEntries((vg.cadaCem?.grupos ?? []).map((g) => [g.codigo, g]));
  const rec = liq.reconciliacaoComDre;
  return `
<header class="cabecalho"><div><h1>Visão Geral</h1><p class="subtitulo">${esc(competencia(vg.competencia))} · ${esc(unidadeNome)}${vg.fechamento ? ` · <span class="selo selo--${vg.fechamento.estado === "FECHAMENTO_HOMOLOGADO" ? "ok" : vg.fechamento.estado === "ABERTA" ? "info" : "alerta"}" data-estado-competencia="${esc(vg.fechamento.estado)}">${esc(ESTADO_DA_COMPETENCIA[vg.fechamento.estado] ?? vg.fechamento.estado)}</span>` : ""}</p></div></header>
<section class="card card--destaque" id="card-faturamento-bruto" aria-labelledby="t-fb" data-ordem="1">
  <div class="card-topo"><h2 id="t-fb">Faturamento Bruto Próprio</h2>${selo(fb.situacao)}${explicar("Faturamento Bruto Próprio", "Soma das vendas pelo valor bruto próprio (produtos, acréscimos e serviços da loja), antes de descontos. Não é saldo bancário, depósito, total Stone nem soma de formas de pagamento.")}</div>
  <p class="numero-principal">${valor(fb.valorCentavos)}${zeroConfirmado ? '<span class="nota-zero">zero confirmado</span>' : ""}</p>
  <ul class="canais" aria-label="Faturamento bruto por canal">${canais.map((c) => `<li class="canal${c.comprovado ? "" : " canal--sem"}"><span class="canal-nome">${esc(nomeCanal(c.canal))}</span>${valor(c.valorCentavos)}<span class="canal-pct">${esc(percentual(c.percentualDoBruto))}</span>${c.comprovado ? "" : `<small>${esc(c.observacao ?? "Canal não comprovado.")}</small>`}${(c.valorCentavos ?? 0) !== 0 ? `<a class="botao-link" href="#/vendas-e-recebimentos?aba=vendas&amp;canal=${esc(c.canal)}">Ver vendas<span class="sr"> — ${esc(nomeCanal(c.canal))}</span></a>` : ""}</li>`).join("")}</ul>
  ${pendenciasCurtas(fb.pendencias)}
  ${botaoComposicao("FATURAMENTO_BRUTO_PROPRIO")}
</section>
<section class="card" id="card-faturamento-liquido" aria-labelledby="t-fl" data-ordem="2">
  <div class="card-topo"><h2 id="t-fl">Faturamento Líquido Gerencial</h2>${selo(liq.situacao)}${explicar("Faturamento Líquido Gerencial", "Por canal: bruto próprio − deduções do canal − despesas atribuídas ao canal (comissões, taxas, promoções, plataforma). É uma leitura analítica: não é receita nova nem valor depositado.")}</div>
  <p class="numero-principal numero-principal--medio">${valor(liq.valorCentavos)}</p>
  <p class="aviso">Líquido gerencial não é o valor depositado no banco.</p>
  <div class="tabela-rolavel"><table class="tabela"><caption class="sr">Líquido gerencial por canal</caption><thead><tr><th scope="col">Canal</th><th scope="col">Bruto</th><th scope="col">Deduções</th><th scope="col">Despesas atribuídas</th><th scope="col">Líquido</th></tr></thead><tbody>
  ${liq.porCanal.filter((c) => c.registros.length).map((c) => `<tr><th scope="row">${esc(nomeCanal(c.canal))}</th><td>${valor(c.brutoCentavos)}</td><td>${valor(c.deducoesCentavos)}</td><td>${valor(c.despesasAtribuidasCentavos)}${Object.keys(c.despesasPorClassificacao).length ? `<ul class="mini">${Object.entries(c.despesasPorClassificacao).map(([k, v]) => `<li>${esc(CLASSIFICACOES[k] ?? k)}: ${esc(moeda(v))}</li>`).join("")}</ul>` : ""}</td><td>${valor(c.liquidoGerencialCentavos)}</td></tr>`).join("")}
  </tbody></table></div>
  ${rec ? `<p class="reconciliacao ${rec.reconcilia ? "" : "reconciliacao--limite"}">Canais ${esc(moeda(rec.somaDosCanaisCentavos))} + não atribuídos ${esc(moeda(rec.somaNaoAtribuidosCentavos))} = ${esc(moeda(rec.totalReconciliadoCentavos))} · Resultado da DRE ${esc(moeda(rec.resultadoDaDreCentavos))} ${rec.reconcilia ? "✓ reconciliado" : "— decomposição incompleta: a DRE prevalece"}</p>` : ""}
  ${botaoComposicao("FATURAMENTO_LIQUIDO_GERENCIAL")}
</section>
<section class="grade-secundaria" aria-label="Indicadores secundários">
  ${cardSec("Resultado Gerencial", valor(res.valorCentavos), selo(res.situacao), "RESULTADO_GERENCIAL", "Sem ajuste de estoque. Não é lucro contábil auditado.")}
  ${cardSec("Custos operacionais", valor(grupos.CUSTOS_OPERACIONAIS ? grupos.CUSTOS_OPERACIONAIS.valorCentavos : null), "", "CUSTOS_OPERACIONAIS")}
  ${cardSec("Despesas operacionais", valor(grupos.DESPESAS_OPERACIONAIS ? grupos.DESPESAS_OPERACIONAIS.valorCentavos : null), "", "DESPESAS_OPERACIONAIS")}
  ${vg.financeiro ? cardsFinanceirosDaVisaoGeral(vg.financeiro) : ["Saldo bancário", "Caixa físico", "Contas a pagar", "Contas a receber", "Fluxo de caixa"].map((t) => `<article class="card card--sec card--indisponivel"><h3>${esc(t)}</h3><p class="valor valor--desconhecido">Indisponível</p><p class="nota">A consulta financeira não respondeu; nenhum valor é estimado.</p></article>`).join("")}
  <article class="card card--sec"><h3>Alertas de conferência</h3>${pendenciasCurtas([...(fb.pendencias ?? []), ...(res.pendencias ?? [])].filter((p, i, a) => a.findIndex((x) => x.mensagem === p.mensagem) === i), 5) || '<p class="nota">Sem alertas.</p>'}<a class="botao-link" href="#/conferencias">Abrir a Central de Conferências</a></article>
</section>`;
}
function cardSec(titulo, v, s, codigo, nota = "") {
  return `<article class="card card--sec"><h3>${esc(titulo)}</h3><p>${v}</p>${s}${nota ? `<p class="nota">${esc(nota)}</p>` : ""}${codigo ? botaoComposicao(codigo) : ""}</article>`;
}

// ------------------------------------------------------------------------------------------- árvore (composição)
let seqNo = 0;
function noArvore(no, nivel = 0) {
  const temFilhos = (no.filhos ?? []).length > 0;
  const id = `no-${(seqNo += 1)}`;
  const docs = no.referencias?.documentoIds ?? [];
  const det = no.detalhe ?? null;
  const agregado = no.origem?.tipo === "PROPOSTA" && no.natureza === "RECEITA";
  const extras = [
    no.dataOperacao ? `<span>${esc(dataBR(no.dataOperacao))}</span>` : "",
    no.canal ? `<span>${esc(nomeCanal(no.canal))}</span>` : "",
    no.situacao === "PENDENTE_DE_CLASSIFICACAO" ? '<span class="selo selo--alerta">Classificação provisória</span>' : "",
    agregado ? '<span class="nota">Valor agregado do relatório diário: não há detalhe por pedido.</span>' : "",
    // Ligação com Vendas e Recebimentos: receita de venda (ou do agregado do dia) abre o detalhe da operação.
    no.natureza === "RECEITA" && no.origem?.tipo === "VENDA" ? `<button type="button" class="botao-link" data-detalhe="venda:${esc(no.origem.id)}">Ver venda</button>` : "",
    agregado && no.referencias?.registroId ? `<button type="button" class="botao-link" data-detalhe="venda:${esc(no.referencias.registroId)}">Ver total do dia</button>` : "",
  ].join("");
  const detalhes = [
    det?.obrigacoes ? `<ul class="mini">${det.obrigacoes.map((o) => `<li>Reconhecido ${esc(moeda(o.valorReconhecidoCentavos))} · Pago ${esc(moeda(o.pagoCentavos))} · Saldo ${esc(moeda(o.saldoCentavos))} · Vencimento ${esc(dataBR(o.vencimento))}</li>`).join("")}</ul>` : "",
    det?.pedidos ? `<p class="mini">Pedidos: ${esc(det.pedidos.join(", "))}${det.taxasRejeitadas?.length ? ` · Taxas rejeitadas: ${esc(det.taxasRejeitadas.join(", "))}` : ""}${det.canceladas?.length ? ` · Canceladas: ${esc(det.canceladas.join(", "))}` : ""}</p>` : "",
    det?.composicao ? `<p class="mini">Produtos ${esc(moeda(det.composicao.itensCentavos))} · Acréscimos ${esc(moeda(det.composicao.acrescimosCentavos))} · Serviços ${esc(moeda(det.composicao.servicosCentavos))}${det.composicao.descontos?.length ? ` · Descontos: ${det.composicao.descontos.map((d) => `${esc(moeda(d.valorCentavos))} (${esc(d.financiador.toLowerCase())})`).join(", ")}` : ""}</p>` : "",
    docs.length ? `<p class="mini docs">${docs.map((d) => `<span class="doc" title="Documento registrado, não acessível nesta versão">Documento ${esc(d.referencia ?? d)} — registrado, não acessível nesta versão</span>`).join(" ")}</p>` : "",
  ].join("");
  const legivel = descricaoLegivel(no.nome);
  const cabeca = `<span class="no-nome"${legivel !== no.nome ? ` title="Original: ${esc(no.nome)}"` : ""}>${esc(legivel)}</span>${valor(no.valorCentavos)}<span class="no-pct">${esc(percentual(no.percentualDoBruto))}</span>`;
  return `<li class="no nivel-${Math.min(nivel, 5)}">${temFilhos ? `<button type="button" class="no-alternar" aria-expanded="false" aria-controls="${id}" data-alternar>${cabeca}</button>` : `<div class="no-folha">${cabeca}</div>`}${extras || detalhes ? `<div class="no-extra">${extras}${detalhes}</div>` : ""}${temFilhos ? `<ul id="${id}" class="nos" hidden>${no.filhos.map((f) => noArvore(f, nivel + 1)).join("")}</ul>` : ""}</li>`;
}
export const arvore = (componentes) => `<ul class="nos nos--raiz">${(componentes ?? []).map((n) => noArvore(n)).join("")}</ul>`;

// ------------------------------------------------------------------------------------------- DRE
export function dre(r, { unidadeNome = "" } = {}) {
  // 06D: competência homologada cuja apuração atual NÃO reproduz o retrato → valores da versão homologada (sem expansões).
  const usarVersao = r.versaoHomologada && !r.versaoHomologada.reproduz;
  const linhas = usarVersao ? r.versaoHomologada.apuracao.dre.linhas.map((l) => ({ ...l, componentes: [], pendencias: [] })) : r.dre.linhas;
  const L = Object.fromEntries(linhas.map((l) => [l.codigo, l]));
  const subtotal = (c) => ["RECEITA_LIQUIDA_COMERCIAL", "RESULTADO_APOS_CUSTOS", "RESULTADO_GERENCIAL"].includes(c);
  return `
<header class="cabecalho"><div><h1>DRE Gerencial</h1><p class="subtitulo">${esc(competencia(r.competencia))} · ${esc(unidadeNome)} · ${esc(r.dre.estadoDaCompetencia === "FECHAMENTO_HOMOLOGADO" ? "competência homologada" : "competência não homologada")}</p></div></header>
${r.versaoHomologada ? `<p class="${r.versaoHomologada.reproduz ? "nota nota--homologada" : "aviso aviso--alerta"}" data-versao-homologada="${r.versaoHomologada.numero}">Versão homologada nº ${r.versaoHomologada.numero} (${esc(dataBR(r.versaoHomologada.decididoEm))}, metodologia ${esc(r.versaoHomologada.metodologiaVersao)}). ${r.versaoHomologada.reproduz ? "A apuração atual reproduz exatamente esta versão." : "A apuração atual difere da versão homologada: os valores abaixo são os da VERSÃO HOMOLOGADA; a diferença exige revisão formal."}</p>` : ""}
<section class="resumo" aria-label="Resumo">
  ${["FATURAMENTO_BRUTO_PROPRIO", "RECEITA_LIQUIDA_COMERCIAL", "RESULTADO_GERENCIAL"].map((c) => `<article class="card card--sec"><h3>${esc(L[c].nome.replace(/^\([^)]*\)\s*/, ""))}</h3><p>${valor(L[c].valorCentavos)}</p>${selo(L[c].situacao)}</article>`).join("")}
</section>
${barraCadaCem(r.cadaCem)}
<section class="card" aria-labelledby="t-dre"><h2 id="t-dre">Demonstrativo</h2>
  <ol class="dre">${linhas.map((l) => `<li class="dre-linha${subtotal(l.codigo) ? " dre-linha--subtotal" : ""}" data-codigo="${esc(l.codigo)}">
    ${l.componentes.length ? `<button type="button" class="no-alternar" aria-expanded="false" aria-controls="dre-${esc(l.codigo)}" data-alternar>` : '<div class="no-folha">'}
      <span class="no-nome">${esc(l.nome)}</span>${valor(l.valorCentavos)}<span class="no-pct">${esc(percentual(l.percentualDoBruto))}</span>${selo(l.situacao)}
    ${l.componentes.length ? "</button>" : "</div>"}
    ${l.componentes.length ? `<div id="dre-${esc(l.codigo)}" hidden>${arvore(l.componentes)}${botaoComposicao(l.codigo)}</div>` : ""}
    ${l.pendencias?.length ? pendenciasCurtas(l.pendencias, 2) : ""}
    ${l.codigo === "FATURAMENTO_BRUTO_PROPRIO" ? '<a class="botao-link" href="#/vendas-e-recebimentos?aba=vendas">Ver vendas da competência</a>' : l.codigo === "DEDUCOES_COMERCIAIS" ? '<a class="botao-link" href="#/vendas-e-recebimentos?aba=taxas">Ver descontos e taxas</a>' : ""}
  </li>`).join("")}</ol>
  <p class="rodape-dre">${esc(L.RESULTADO_GERENCIAL.observacao ?? "")} Metodologia ${esc(r.dre.metodologia.nome)} (${esc(r.dre.metodologia.versao)}) · apuração ${esc((r.impressao ?? "").slice(0, 12))}</p>
  ${r.dre.foraDoResultado?.patrimoniais?.length ? `<p class="nota">Fora do resultado (patrimonial): ${r.dre.foraDoResultado.patrimoniais.map((p) => esc(moeda(p.valorCentavos))).join(", ")}.</p>` : ""}
  ${r.dre.foraDoResultado?.aClassificar?.length ? `<p class="aviso aviso--alerta">Fora do resultado até classificar (natureza não comprovada): ${r.dre.foraDoResultado.aClassificar.map((p) => `${esc(p.descricao ?? "despesa")} ${esc(moeda(p.valorCentavos))}`).join(", ")}. Não é presumida despesa.</p>` : ""}
</section>`;
}

const NOMES_GRUPO = { DEDUCOES_COMERCIAIS: "Deduções", CUSTOS_OPERACIONAIS: "Custos", DESPESAS_OPERACIONAIS: "Despesas", RESULTADO_FINANCEIRO: "Financeiro", DEMAIS_EFEITOS_GERENCIAIS: "Demais efeitos", RESULTADO_GERENCIAL: "Resultado" };
export function barraCadaCem(cc) {
  if (!cc || cc.limitacao) return `<section class="card barra-cem" aria-label="Para onde vai cada R$ 100"><h2>Para onde vai cada R$ 100 faturados?</h2><p class="nota">${esc(cc?.limitacao ?? "Sem faturamento calculável.")}</p></section>`;
  const positivos = cc.grupos.filter((g) => g.centesimosDePonto > 0);
  return `<section class="card barra-cem" aria-label="Para onde vai cada R$ 100">
  <h2>Para onde vai cada R$ 100 faturados?</h2>
  <div class="barra" role="img" aria-label="${esc(positivos.map((g) => `${NOMES_GRUPO[g.codigo]} ${percentual(g.centesimosDePonto)}`).join(", "))}">${positivos.map((g) => `<span class="segmento segmento--${esc(g.codigo.toLowerCase())}" data-peso="${g.centesimosDePonto}"></span>`).join("")}</div>
  ${cc.prejuizo ? '<p class="aviso aviso--erro">Prejuízo: os componentes consomem mais que o faturamento; o resultado aparece como parte negativa.</p>' : ""}
  <ul class="legenda">${cc.grupos.map((g) => `<li><span class="ponto segmento--${esc(g.codigo.toLowerCase())}"></span>${esc(NOMES_GRUPO[g.codigo])}: <strong class="${g.centesimosDePonto < 0 ? "valor--negativo" : ""}">${esc(percentual(g.centesimosDePonto))}</strong> <span class="nota" title="Exato e diferença de arredondamento">(${esc(moeda(g.valorCentavos))}; ajuste de arredondamento ${esc(String(g.diferencaDeArredondamentoMilionesimos ?? 0))} milionésimos de ponto)</span>${g.acimaDeCem ? ' <span class="selo selo--alerta">acima de 100%</span>' : ""}</li>`).join("")}</ul>
  <p class="nota">${esc(cc.regra)}</p>
</section>`;
}

// ------------------------------------------------------------------------------------------- composição completa
export function composicao(ind, { unidadeNome = "" } = {}) {
  return `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(ind.nome)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar composição">×</button></div>
  <dl class="ficha">
    <dt>Valor</dt><dd>${valor(ind.valorCentavos)} ${selo(ind.situacao)}</dd>
    <dt>Fórmula</dt><dd>${esc(ind.formula)}</dd>
    <dt>Competência</dt><dd>${esc(competencia(ind.competencia))}</dd>
    <dt>Unidade</dt><dd>${esc(unidadeNome)}</dd>
    <dt>Metodologia</dt><dd>${esc(ind.metodologia?.nome)} (${esc(ind.metodologia?.versao)})</dd>
    <dt>Apurado em</dt><dd>${esc(dataBR(ind.apuradoEm))}</dd>
  </dl>
  ${ind.pendencias?.length ? `<h3>Pendências</h3>${pendenciasCurtas(ind.pendencias, 20)}` : ""}
  <h3>Composição</h3>
  ${ind.componentes?.length ? arvore(ind.componentes) : ind.porCanal ? `<ul class="nos">${ind.porCanal.filter((c) => (c.registros ?? []).length).map((c) => `<li class="no"><div class="no-folha"><span class="no-nome">${esc(nomeCanal(c.canal))}</span>${valor(c.liquidoGerencialCentavos ?? c.valorCentavos)}</div></li>`).join("")}</ul>` : '<p class="nota">Sem componentes registrados nesta competência.</p>'}`;
}
