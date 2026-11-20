// Vendas e Recebimentos (Execução 06B) — funções PURAS: dados das consultas → HTML escapado.
// Nenhuma fórmula financeira: totais, situações, comprovações e linhas do tempo chegam prontos do backend.
// Documentos aparecem como "registrado, não acessível nesta versão" — nunca há link, arquivo ou caminho.
import { COMPROVACOES, CONFIABILIDADES, DIVERGENCIAS_VENDA, ETAPAS, FORMAS, LINHAS_DRE, PENDENCIAS_VENDA, SITUACOES_RECEBIMENTO, SITUACOES_VENDA, TIPOS_COMPONENTE, competencia, dataBR, esc, moeda, nomeCanal, nomeDevedor, situacao, situacaoRecebimento, situacaoVenda, usaAnotaAi } from "./formatar.js";
import { documentos, paginacao } from "./telasTesouraria.js";

export const ABAS = Object.freeze([["vendas", "Vendas"], ["pagamentos", "Pagamentos"], ["taxas", "Taxas e descontos"], ["recebiveis", "Recebíveis e repasses"], ["divergencias", "Divergências"]]);
const ROTA = "vendas-e-recebimentos";
const valorClasse = (c) => (c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor");
const valor = (c) => `<span class="${valorClasse(c)}">${esc(moeda(c))}</span>`;
const seloDe = (s) => `<span class="selo selo--${s.classe}" title="${esc(s.explicacao)}">${esc(s.rotulo)}</span>`;
const explicar = (titulo, texto) => `<details class="explica"><summary aria-label="Explicação: ${esc(titulo)}"><span aria-hidden="true">i</span></summary><p>${esc(texto)}</p></details>`;
const card = (titulo, conteudo, explicacao = "", extra = "") => `<article class="card card--sec"><div class="card-topo"><h3>${esc(titulo)}</h3>${explicacao ? explicar(titulo, explicacao) : ""}</div><p>${conteudo}</p>${extra}</article>`;
const td = (rotulo, conteudo, classe = "") => `<td data-rotulo="${esc(rotulo)}"${classe ? ` class="${classe}"` : ""}><span class="cel">${conteudo}</span></td>`;
const opcao = (v, rotulo, atual) => `<option value="${esc(v)}"${v === (atual ?? "") ? " selected" : ""}>${esc(rotulo)}</option>`;
const nenhum = (texto) => `<p class="nota vazio-lista">${esc(texto)}</p>`;
const fechar = (titulo) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(titulo)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar detalhe">×</button></div>`;
const dataHora = (data, horario) => `${esc(dataBR(data))}${horario ? ` <span class="nota">${esc(horario.slice(0, 5))}</span>` : ""}`;
const processador = (p) => (p ? nomeDevedor({ tipo: "PROCESSADORA", nome: p }) : "Sem processador");
const nomeDoCanal = (c) => (c ? nomeCanal(c) : "Sem canal identificado");
const botaoDetalhe = (tipo, id, texto = "Detalhar") => `<button type="button" class="botao-link" data-detalhe="${esc(tipo)}:${esc(id)}">${esc(texto)}</button>`;
const pendencias = (lista = []) => lista.filter((p) => PENDENCIAS_VENDA[p]).map((p) => `<span class="selo selo--alerta">${esc(PENDENCIAS_VENDA[p])}</span>`).join(" ");

/** Converte o texto digitado em reais ("12,50", "1.234") para centavos SEM ponto flutuante. Inválido → "". */
export function reaisParaCentavos(texto) {
  const t = String(texto ?? "").trim().replace(/^R\$\s*/, "").replace(/\./g, "");
  const m = /^(\d{1,9})(?:,(\d{1,2}))?$/.exec(t);
  if (!m) return "";
  return String(Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0")));
}
const centavosParaTexto = (c) => (c === null || c === undefined || c === "" ? "" : moeda(Number(c)).replace("R$ ", ""));

// ------------------------------------------------------------------------------------------------ cabeçalho e resumo
function resumo(r) {
  const s = r.resumo;
  const dre = s.conferenciaComDre;
  const seloDre = dre ? (dre.confere ? `<span class="selo selo--ok" title="O bruto listado é exatamente o Faturamento Bruto Próprio da DRE.">igual à DRE</span>` : `<span class="selo selo--erro">difere da DRE</span>`) : "";
  return `<section class="resumo" aria-label="Resumo de vendas e recebimentos">
  ${card("Vendas brutas próprias", `${valor(s.brutoProprioCentavos)} ${seloDre}`, s.metodologia.brutoProprio, `${s.dre ? `<p class="nota">DRE da competência: ${esc(moeda(s.dre.faturamentoBrutoCentavos))} · ${esc(situacao(s.dre.situacao).rotulo)}</p>` : ""}<p class="nota">${s.vendasIndividuais} venda(s)${s.agregadosDiarios ? ` · ${s.agregadosDiarios} total(is) diário(s) agregado(s)` : ""}${s.canceladas ? ` · ${s.canceladas} cancelada(s) fora do total` : ""}</p>`)}
  ${card("Descontos", valor(s.descontosCentavos), s.metodologia.descontos)}
  ${card("Valor cobrado do consumidor", valor(s.cobradoDoConsumidorCentavos), s.metodologia.cobrado)}
  ${card("Taxas e custos do recebimento", valor(s.custosDoRecebimentoCentavos), s.metodologia.custosDoRecebimento)}
  ${card("A receber", valor(s.aReceberCentavos), s.metodologia.aReceber, s.agregadoSemRastreioCentavos ? `<p class="nota">${esc(moeda(s.agregadoSemRastreioCentavos))} de vendas agregadas sem rastreio de recebimento.</p>` : "")}
  ${card("Recebido e comprovado", valor(s.recebidoComprovadoCentavos), s.metodologia.recebido, s.recebidoSemComprovacaoCentavos ? `<p class="nota aviso--alerta">+ ${esc(moeda(s.recebidoSemComprovacaoCentavos))} registrados sem comprovação</p>` : "")}
</section>`;
}

function abas(atual) {
  return `<nav class="abas abas--botoes" aria-label="Seções de vendas e recebimentos">${ABAS.map(([k, t]) => `<button type="button" data-aba="${k}"${k === atual ? ' aria-current="page"' : ""}>${esc(t)}</button>`).join("")}</nav>`;
}

function filtros(f, aba) {
  const canais = [["", "Todos"], ["BALCAO", "Balcão"], ["IFOOD", "iFood"], ["ANOTA_AI", "Anota AI"], ["OUTRO", "Outros canais"], ["NAO_IDENTIFICADO", "Sem canal identificado"]].filter(([k]) => k !== "ANOTA_AI" || usaAnotaAi());
  const formas = [["", "Todas"], ...Object.entries(FORMAS).filter(([k]) => k !== "OUTRA")];
  const procs = [["", "Todos"], ...["STONE", "IFOOD", "ANOTA_AI", "OPERADORA_BENEFICIOS", "MAQUINA_TERCEIROS"].filter((k) => k !== "ANOTA_AI" || usaAnotaAi()).map((k) => [k, processador(k)]), ["SEM_PROCESSADOR", "Sem processador (direto)"]];
  const especifico = {
    vendas: `<label>Situação <select name="situacao">${opcao("", "Todas", f.situacao)}${Object.entries(SITUACOES_VENDA).map(([k, v]) => opcao(k, v.rotulo, f.situacao)).join("")}</select></label>
  <label>Identificador <input type="search" name="identificador" maxlength="60" value="${esc(f.identificador ?? "")}" placeholder="ex.: pedido"></label>
  <label>Valor mín. (R$) <input type="text" inputmode="decimal" name="valorMinimo" value="${esc(centavosParaTexto(f.valorMinimoCentavos))}" placeholder="0,00"></label>
  <label>Valor máx. (R$) <input type="text" inputmode="decimal" name="valorMaximo" value="${esc(centavosParaTexto(f.valorMaximoCentavos))}" placeholder="0,00"></label>`,
    taxas: `<label>Tipo <select name="tipoComponente">${opcao("", "Todos", f.tipoComponente)}${Object.entries(TIPOS_COMPONENTE).map(([k, v]) => opcao(k, v, f.tipoComponente)).join("")}</select></label>`,
    recebiveis: `<label>Recebimento <select name="recebimento">${opcao("", "Todos", f.recebimento)}${Object.entries(SITUACOES_RECEBIMENTO).map(([k, v]) => opcao(k, v.rotulo, f.recebimento)).join("")}</select></label>`,
    divergencias: `<label>Tipo <select name="codigo">${opcao("", "Todos", f.codigo)}${Object.entries(DIVERGENCIAS_VENDA).map(([k, v]) => opcao(k, v, f.codigo)).join("")}</select></label>`,
  }[aba] ?? "";
  return `<form class="filtros-locais" data-filtro-local="${ROTA}" aria-label="Filtros de vendas e recebimentos">
  <input type="hidden" name="aba" value="${esc(aba)}">
  <label>Canal <select name="canal">${canais.map(([k, v]) => opcao(k, v, f.canal)).join("")}</select></label>
  ${["vendas", "pagamentos"].includes(aba) ? `<label>Forma <select name="forma">${formas.map(([k, v]) => opcao(k, v, f.forma)).join("")}</select></label>` : ""}
  <label>Processador <select name="processador">${procs.map(([k, v]) => opcao(k, v, f.processador)).join("")}</select></label>
  ${especifico}
  <button type="submit" class="botao">Aplicar</button>
</form>`;
}

/** Tela principal: cabeçalho, resumo, abas, filtros e o conteúdo da aba. */
export function vendasERecebimentos(r, f = {}) {
  const aba = f.aba ?? "vendas";
  const conteudo = { vendas: abaVendas, pagamentos: abaPagamentos, taxas: abaTaxas, recebiveis: abaRecebiveis, divergencias: abaDivergencias }[aba] ?? abaVendas;
  const comp = r.filtro?.competencia;
  return `<header class="cabecalho"><div><h1>Vendas e Recebimentos</h1><p class="subtitulo">${comp ? esc(competencia(comp)) : `${esc(dataBR(r.filtro?.inicio))} a ${esc(dataBR(r.filtro?.fim))}`} · posição em ${esc(dataBR(r.dataBase))}</p></div></header>
<p class="aviso">Faturamento, pagamento, recebível e dinheiro no banco são etapas diferentes: cada uma só aparece concluída quando há registro que a prove.</p>
${resumo(r)}
${abas(aba)}
${filtros(f, aba)}
${conteudo(r)}`;
}

// ------------------------------------------------------------------------------------------------------------- vendas
function abaVendas(r) {
  return `<section class="card" aria-labelledby="t-vendas"><h2 id="t-vendas" class="sr">Vendas</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Vendas da competência</caption><thead><tr><th scope="col">Data</th><th scope="col" class="esquerda">Venda</th><th scope="col">Canal</th><th scope="col">Bruto próprio</th><th scope="col">Descontos</th><th scope="col">Cobrado</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((v) => `<tr${v.situacao === "CANCELADA" ? ' class="estornada"' : ""}>${td("Data", dataHora(v.data, v.horario))}${td("Venda", `<strong>${esc(v.titulo)}</strong><br><span class="nota">${esc(v.identificador)}${v.quantidadeDeVendas ? ` · ${v.quantidadeDeVendas} venda(s) no relatório` : ""}</span> ${pendencias(v.pendencias)}`, "esquerda")}${td("Canal", esc(nomeDoCanal(v.canal)))}${td("Bruto próprio", valor(v.valores.brutoProprioCentavos))}${td("Descontos", valor(v.valores.descontosCentavos))}${td("Cobrado", valor(v.valores.cobradoDoConsumidorCentavos))}${td("Situação", `${seloDe(situacaoVenda(v.situacao))}<br><span class="nota">${esc(CONFIABILIDADES[v.confiabilidade.nivel]?.rotulo ?? "")}</span>`)}${td("Ações", botaoDetalhe("venda", v.id))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhuma venda com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
</section>`;
}

// --------------------------------------------------------------------------------------------------------- pagamentos
function processadorCard(p) {
  const comp = Object.entries(p.componentes).filter(([, v]) => v).map(([k, v]) => `<li>${esc(TIPOS_COMPONENTE[k] ?? k)}: ${esc(moeda(v))}</li>`).join("");
  return `<article class="card conta" aria-labelledby="proc-${esc(p.processador)}">
  <div class="card-topo"><h3 id="proc-${esc(p.processador)}">${esc(processador(p.processador))}</h3>${p.divergencias ? `<span class="selo selo--alerta">${p.divergencias} divergência(s)</span>` : ""}</div>
  <dl class="ficha ficha--compacta">
    <dt>Transações vinculadas</dt><dd>${p.transacoes}</dd>
    <dt>Bruto processado</dt><dd>${valor(p.brutoProcessadoCentavos)}</dd>
    <dt>Taxas e custos informados</dt><dd>${valor(p.custosCentavos)}</dd>
    <dt>Líquido esperado</dt><dd>${valor(p.liquidoEsperadoCentavos)}</dd>
    <dt>Recebido (comprovado)</dt><dd>${valor(p.recebidoComprovadoCentavos)}</dd>
    ${p.recebidoSemComprovacaoCentavos ? `<dt>Recebido sem comprovação</dt><dd>${valor(p.recebidoSemComprovacaoCentavos)}</dd>` : ""}
    <dt>A receber</dt><dd>${valor(p.saldoCentavos)}${p.semPrevisaoCentavos ? `<br><span class="nota">${esc(moeda(p.semPrevisaoCentavos))} sem previsão confiável</span>` : ""}</dd>
    <dt>Repasses documentados</dt><dd>${p.repassesDocumentados}</dd>
    ${p.transacoesSemVenda ? `<dt>Transações sem venda</dt><dd><span class="valor--negativo">${p.transacoesSemVenda} · ${esc(moeda(p.transacoesSemVendaCentavos))}</span></dd>` : ""}
  </dl>
  ${comp ? `<ul class="mini">${comp}</ul>` : ""}
  ${Object.keys(p.porCanal).length ? `<p class="nota">Por canal: ${Object.entries(p.porCanal).map(([c, v]) => `${esc(nomeDoCanal(c === "NAO_IDENTIFICADO" ? null : c))} ${esc(moeda(v))}`).join(" · ")}</p>` : ""}
  <p class="nota">${esc(p.observacao)}</p>
</article>`;
}

function cardIfood(i) {
  if (!i) return "";
  const linha = (rot, v, sinal = "") => `<li><span>${sinal}${esc(rot)}</span>${valor(v)}</li>`;
  return `<section class="card" aria-labelledby="t-ifood"><h2 id="t-ifood">iFood — composição separada</h2>
  <ul class="lista-simples">
    ${linha("Bruto próprio das vendas iFood", i.brutoProprioCentavos)}${linha("dos quais serviços/entrega", i.servicosCentavos, "· ")}
    ${linha("Descontos da loja (dedução)", i.descontosDaLojaCentavos, "− ")}${linha("Descontos sem financiador comprovado", i.descontosAClassificarCentavos, "− ")}
    ${linha("Subsídios do iFood (a receber, não reduzem receita)", i.subsidiosDeTerceiroCentavos)}
    ${linha("Comissões (despesa)", i.comissoesCentavos, "− ")}${linha("Taxas de processamento (despesa)", i.taxasCentavos, "− ")}${linha("Mensalidades (despesa)", i.mensalidadesCentavos, "− ")}
    ${linha("Anúncios (despesa)", i.anunciosCentavos, "− ")}${linha("Encargos", i.encargosCentavos, "− ")}${linha("Ajustes", i.ajustesCentavos, "− ")}
    <li class="total"><span>Líquido esperado do iFood</span>${valor(i.liquidoEsperadoCentavos)}</li>
    ${linha("Repassado (créditos vinculados)", i.repassadoCentavos)}${linha("dos quais comprovados por extrato", i.repassadoComprovadoCentavos, "· ")}
    <li class="total"><span>Ainda a receber</span>${valor(i.aReceberCentavos)}</li>
  </ul>
  <p class="nota">${esc(i.observacao)}</p></section>`;
}

function abaPagamentos(r) {
  const destino = { RECEBIVEL: "Recebível do processador", CONTA: "Direto na conta", SEM_DESTINO_REGISTRADO: "Crédito a identificar" };
  return `<section class="contas" aria-label="Processadores e intermediários">${r.processadores.length ? r.processadores.map(processadorCard).join("") : nenhum("Nenhum processador no filtro.")}</section>
${cardIfood(r.ifood)}
${r.transacoesSemVenda.length ? `<section class="card" aria-labelledby="t-semvenda"><h2 id="t-semvenda">Transações sem venda correspondente</h2><p class="aviso aviso--alerta">Preservadas como evidência. Nenhuma venda é criada a partir do processador.</p>
<ul class="lista-simples">${r.transacoesSemVenda.map((t) => `<li><span>${esc(dataBR(t.data))} · ${esc(processador(t.processador))} · ${esc(t.identificador)} · ${esc(t.formaLegivel)}${t.taxas.map((x) => ` · taxa ${esc(x.exatoReais)} → ${esc(moeda(x.registradoCentavos))}`).join("")}<br><span class="nota">${t.motivo === "VINCULO_AMBIGUO" ? `${t.candidatas} vendas possíveis: vínculo manual exigido.` : "Nenhum pedido do dia corresponde."}</span></span>${valor(t.valorCentavos)}</li>`).join("")}</ul></section>` : ""}
<section class="card" aria-labelledby="t-pags"><h2 id="t-pags">Pagamentos das vendas</h2>
${r.agregadosSemPagamento ? `<p class="nota">${r.agregadosSemPagamento} total(is) diário(s) agregado(s) não têm pagamentos por pedido: não aparecem aqui.</p>` : ""}
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Pagamentos</caption><thead><tr><th scope="col">Data</th><th scope="col" class="esquerda">Venda</th><th scope="col" class="esquerda">Forma e processador</th><th scope="col">Valor</th><th scope="col">Destino</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((p) => `<tr${p.validoCentavos === 0 ? ' class="estornada"' : ""}>${td("Data", esc(dataBR(p.data)))}${td("Venda", `<strong>${esc(p.venda.titulo)}</strong><br><span class="nota">${esc(p.venda.identificador)}${p.subsidio ? " · subsídio de terceiro" : ""}</span>`, "esquerda")}${td("Forma", `${esc(p.formaLegivel)}<br><span class="nota">${esc(processador(p.processador))}${p.evidencia ? ` · transação ${esc(p.evidencia.identificador ?? "")}` : ""}</span>`, "esquerda")}${td("Valor", `${valor(p.valorCentavos)}${p.estornadoCentavos ? `<br><span class="nota">estornado ${esc(moeda(p.estornadoCentavos))}</span>` : ""}`)}${td("Destino", `${esc(destino[p.destino] ?? p.destino)}${p.recebimento ? `<br>${seloDe(situacaoRecebimento(p.recebimento))}` : p.credito ? `<br><span class="nota">${esc(COMPROVACOES[p.credito.comprovacao] ?? "")}</span>` : ""}`)}${td("Ações", botaoDetalhe("venda", p.venda.id, "Ver venda"))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhum pagamento com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
</section>`;
}

// ------------------------------------------------------------------------------------------------- taxas e descontos
const fracao = (fr) => (fr ? `<br><span class="nota" title="Valor exato informado pelo processador e regra de arredondamento">exato R$ ${esc(fr.exatoReais)} → registrado ${esc(moeda(fr.registradoCentavos))} (metade para cima)</span>` : "");
function abaTaxas(r) {
  return `<section class="resumo" aria-label="Totais de taxas e descontos">
  ${card("Descontos comerciais", valor(r.totais.descontosComerciaisCentavos), "Descontos da loja, descontos com financiador não comprovado e devoluções: reduzem a receita (deduções comerciais da DRE).")}
  ${card("Subsídios de terceiros", valor(r.totais.subsidiosCentavos), "Desconto pago por terceiro com documento: não reduz a receita; vira valor a receber do terceiro.")}
  ${card("Custos do recebimento", valor(r.totais.custosDoRecebimentoCentavos), "Taxas, comissões, anúncios, mensalidades e encargos retidos pelos processadores: são despesas, não descontos.")}
  ${card("Com fração de centavo", `<span class="valor">${r.totais.comFracaoDeCentavo}</span>`, r.regraDeArredondamento)}
</section>
<section class="card" aria-labelledby="t-taxas"><h2 id="t-taxas">Taxas, descontos e ajustes</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Componentes</caption><thead><tr><th scope="col">Data</th><th scope="col" class="esquerda">Tipo</th><th scope="col" class="esquerda">Origem</th><th scope="col">Valor</th><th scope="col">Na DRE</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((c) => `<tr>${td("Data", c.data ? esc(dataBR(c.data)) : c.registradoEm ? `<span class="nota">registrado em ${esc(dataBR(c.registradoEm))}</span>` : "—")}${td("Tipo", `<strong>${esc(TIPOS_COMPONENTE[c.tipo] ?? c.tipo)}</strong>${c.nome ? `<br><span class="nota">${esc(c.nome)}</span>` : ""}${c.provisoria ? ' <span class="selo selo--alerta">provisório</span>' : ""}`, "esquerda")}${td("Origem", `${c.venda ? esc(c.venda.titulo) : "Recebível sem venda"}<br><span class="nota">${esc(c.processador ? processador(c.processador) : nomeDoCanal(c.canal))}</span>`, "esquerda")}${td("Valor", `${valor(c.valorCentavos)}${fracao(c.fracao)}`)}${td("Na DRE", esc(LINHAS_DRE[c.linhaDaDre] ?? "—"))}${td("Ações", c.venda ? botaoDetalhe("venda", c.venda.id, "Ver venda") : c.recebivelId ? botaoDetalhe("recebimento", c.recebivelId, "Ver recebível") : "")}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhuma taxa ou desconto com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
<p class="nota">${esc(r.regraDeArredondamento)}</p>
</section>`;
}

// --------------------------------------------------------------------------------------------- recebíveis e repasses
const ORIGEM_PREVISAO = { DOCUMENTO_DO_PROCESSADOR: "documentada", DATA_SEM_DOCUMENTO: "data sem documento", SEM_PREVISAO: "sem previsão (não presumida)" };
function abaRecebiveis(r) {
  const t = r.totais;
  return `<section class="resumo" aria-label="Totais de recebíveis">
  ${card("Esperado dos processadores", valor(t.esperadoCentavos), "Bruto do recebível menos taxas e custos informados.")}
  ${card("Já creditado", valor(t.liquidadoCentavos), "Créditos vinculados aos recebíveis.", `<p class="nota">comprovado ${esc(moeda(t.recebidoComprovadoCentavos))} · sem comprovação ${esc(moeda(t.recebidoSemComprovacaoCentavos))}</p>`)}
  ${card("Saldo a receber", valor(t.saldoCentavos), "Esperado − creditado.", `<p class="nota">com previsão documentada ${esc(moeda(t.comPrevisaoDocumentadaCentavos))} · sem previsão ${esc(moeda(t.semPrevisaoCentavos))}</p>`)}
</section>
<section class="card" aria-labelledby="t-receb"><h2 id="t-receb">Venda → direito a receber → repasse → crédito</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Recebíveis</caption><thead><tr><th scope="col">Previsto</th><th scope="col" class="esquerda">Processador e venda</th><th scope="col">Esperado</th><th scope="col">Creditado</th><th scope="col">Saldo</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((x) => `<tr>${td("Previsto", `${x.dataPrevista ? esc(dataBR(x.dataPrevista)) : '<span class="valor--desconhecido">sem data</span>'}<br><span class="nota">${esc(ORIGEM_PREVISAO[x.origemDaPrevisao])}</span>`)}${td("Processador", `<strong>${esc(processador(x.processador))}</strong><br><span class="nota">${x.venda ? esc(x.venda.titulo) : esc(x.descricao ?? "Recebível sem venda")}${x.canalComprovado ? "" : " · canal não comprovado"}${x.repasse.informado ? " · repasse informado" : ""}</span>`, "esquerda")}${td("Esperado", `${valor(x.esperadoCentavos)}${x.custosCentavos ? `<br><span class="nota">bruto ${esc(moeda(x.brutoCentavos))} − ${esc(moeda(x.custosCentavos))}</span>` : ""}`)}${td("Creditado", `${valor(x.liquidadoCentavos)}${x.dataEfetiva ? `<br><span class="nota">em ${esc(dataBR(x.dataEfetiva))}</span>` : ""}`)}${td("Saldo", x.situacaoRecebimento === "CANCELADO" ? '<span class="nota">— (cancelado)</span>' : valor(x.saldoCentavos))}${td("Situação", seloDe(situacaoRecebimento(x.situacaoRecebimento)))}${td("Ações", botaoDetalhe("recebimento", x.id, "Ver ciclo"))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhum recebível com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
</section>
<section class="card" aria-labelledby="t-creditos"><h2 id="t-creditos">Créditos na conta (repasses)</h2>
${r.creditos.length ? `<ul class="lista-simples">${r.creditos.map((c) => `<li><span>${esc(dataBR(c.data))} · ${esc(c.conta ?? "conta")} · ${c.titulos.length} título(s)${c.vendas ? ` de ${c.vendas} venda(s)` : ""}${c.titulos.length > 1 ? " · repasse agrupado" : ""}<br><span class="nota">${esc(COMPROVACOES[c.comprovacao] ?? "")}${c.descricaoOriginal ? ` · original: ${esc(c.descricaoOriginal)}` : ""}</span></span><span>${valor(c.valorCentavos)} ${c.comprovacao === "SEM_COMPROVACAO" ? '<span class="selo selo--alerta">sem extrato</span>' : '<span class="selo selo--ok">comprovado</span>'}</span></li>`).join("")}</ul>` : nenhum("Nenhum crédito vinculado aos recebíveis do filtro.")}
</section>`;
}

// ------------------------------------------------------------------------------------------------------- divergências
function abaDivergencias(r) {
  const ref = (x) => (x.referencia?.tipo === "VENDA" || x.referencia?.tipo === "AGREGADO_DIARIO" ? botaoDetalhe("venda", x.referencia.id, "Ver venda")
    : x.referencia?.tipo === "RECEBIVEL" ? botaoDetalhe("recebimento", x.referencia.id, "Ver recebível") : "") + naCentral(x);
  // Mesmo fato na Central de Conferências (pendência e, para transação sem pedido, as correspondências candidatas).
  const chaveCentral = (x) => {
    const r = x.referencia ?? {};
    return ({
      TRANSACAO_SEM_PEDIDO: `PROPOSTA:${r.id}`, VENDA_SEM_PAGAMENTO: `VENDA:${r.id}:PAGAMENTO`, PAGAMENTO_INCOMPATIVEL: `VENDA:${r.id}:PAGAMENTO`,
      RECEBIMENTO_DIRETO_NAO_IDENTIFICADO: `VENDA:${r.id}:CREDITO_DIRETO`, RECEBIVEL_SEM_REPASSE: `RECEBIVEL:${r.recebivelId}`, RECEBIVEL_ATRASADO: `RECEBIVEL:${r.recebivelId}`,
      REPASSE_INFORMADO_SEM_CREDITO: `RECEBIVEL:${r.recebivelId}`, TAXA_OU_VALOR_DIVERGENTE: `RECEBIVEL:${r.recebivelId}`, CREDITO_SEM_COMPROVACAO_BANCARIA: r.movimentacaoId ? `MOVIMENTACAO:${r.movimentacaoId}` : null,
      TOTAIS_DE_RELATORIOS_DIFERENTES: `DIVERGENCIA_FONTE:${r.id}`, VENDA_SEM_CANAL: `AGREGADO:${r.id}`,
    })[x.codigo] ?? null;
  };
  const naCentral = (x) => {
    const k = chaveCentral(x);
    const comp = /^\d{4}-\d{2}$/.test(x.competencia ?? "") ? `competencia=${esc(x.competencia)}&amp;` : "";
    return `${k && !k.includes("undefined") ? ` <a class="botao-link" href="#/conferencias?${comp}revisar=${esc(k)}">Revisar na Central</a>` : x.codigo === "DESCONTO_SEM_FINANCIADOR" ? ` <a class="botao-link" href="#/conferencias?${comp}secao=pendencias&amp;grupo=CLASSIFICACOES">Ver classificações na Central</a>` : ""}${x.codigo === "TRANSACAO_SEM_PEDIDO" ? ` <a class="botao-link" href="#/conferencias?${comp}secao=conciliacoes">Correspondências candidatas</a>` : ""}`;
  };
  const situacaoDiv = { ABERTA: ["Aberta", "erro"], EXPLICADA_PARCIALMENTE: ["Explicada em parte", "alerta"], INFORMATIVA: ["Informativa", "neutro"] };
  return `<section class="card" aria-labelledby="t-div"><h2 id="t-div">Divergências de vendas e recebimentos</h2>
<p class="nota">${r.abertas} em aberto. Nada é resolvido por valores próximos e nenhum ajuste é criado para fechar diferenças.</p>
${Object.keys(r.porCodigo).length ? `<ul class="legenda legenda--cal">${Object.entries(r.porCodigo).map(([k, v]) => `<li><span class="selo selo--neutro">${v.quantidade}</span> ${esc(DIVERGENCIAS_VENDA[k] ?? k)}</li>`).join("")}</ul>` : ""}
${r.itens.length ? `<ul class="divergencias">${r.itens.map((x) => {
    const [rot, cls] = situacaoDiv[x.situacao] ?? [x.situacao, "neutro"];
    return `<li class="divergencia"><div class="card-topo"><h3>${esc(x.titulo)}</h3><span class="selo selo--${cls}">${esc(rot)}</span></div>
  <dl class="ficha ficha--compacta"><dt>Impacto</dt><dd>${valor(x.valorCentavos)}</dd><dt>Período</dt><dd>${x.periodo.inicio ? `${esc(dataBR(x.periodo.inicio))}${x.periodo.fim && x.periodo.fim !== x.periodo.inicio ? ` a ${esc(dataBR(x.periodo.fim))}` : ""}` : esc(competencia(x.competencia))}</dd><dt>Fonte</dt><dd>${esc(x.fonte === "MANUAL" ? "Registro manual" : x.fonte ? processador(x.fonte) : "—")}</dd><dt>Motivo</dt><dd>${esc(x.motivo)}</dd><dt>Próxima ação</dt><dd>${esc(x.proximaAcao)}</dd></dl>
  ${x.evidencias?.length ? documentos(x.evidencias) : '<p class="nota">Sem documento vinculado.</p>'}${ref(x)}</li>`;
  }).join("")}</ul>` : nenhum("Nenhuma divergência com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
</section>`;
}

// ---------------------------------------------------------------------------------------------------- linha do tempo
const SITUACAO_ETAPA = { CONCLUIDA: ["Concluída", "ok"], PENDENTE: ["Pendente", "alerta"], NAO_SE_APLICA: ["Não se aplica", "neutro"] };
/** Fonte de cada etapa em linguagem de gestão (códigos de sistema nunca aparecem crus). */
const FONTES = {
  SAIPOS: "SAIPOS", STONE: "Stone", IFOOD: "iFood", ANOTA_AI: "Anota AI", UNICRED: "extrato Unicred", FOODY: "Foody", MANUAL: "registro manual", OPERADORA_BENEFICIOS: "operadora de benefícios",
  MAQUINA_TERCEIROS: "máquina de terceiros", OUTRO: "outra fonte", DEMONSTRATIVO: "demonstrativo do processador", ...COMPROVACOES,
};
const fonteLegivel = (f) => FONTES[f] ?? f;
export function linhaDoTempo(lista = []) {
  if (!lista.length) return nenhum("Sem etapas.");
  return `<ol class="linha-tempo">${lista.map((e) => {
    const [rot, cls] = SITUACAO_ETAPA[e.situacao] ?? [e.situacao, "neutro"];
    return `<li class="etapa etapa--${cls}"><div class="etapa-topo"><strong>${esc(ETAPAS[e.etapa] ?? e.etapa)}</strong> <span class="selo selo--${cls}">${esc(rot)}</span></div>
  <p class="nota">${e.data ? esc(dataBR(e.data)) : e.registradoEm ? `data efetiva não informada (registrado em ${esc(dataBR(e.registradoEm))})` : "Data não conhecida"}${e.horario ? ` ${esc(e.horario.slice(0, 5))}` : ""}${e.fonte ? ` · fonte: ${esc(fonteLegivel(e.fonte))}` : ""}${e.valorCentavos !== null && e.valorCentavos !== undefined ? ` · ${esc(moeda(e.valorCentavos))}` : ""}</p>
  ${e.descricao ? `<p class="etapa-texto">${esc(e.descricao)}</p>` : ""}${e.fracao ? `<p class="nota">exato R$ ${esc(e.fracao.exatoReais)} → ${esc(moeda(e.fracao.registradoCentavos))}</p>` : ""}${e.documentos?.length ? documentos(e.documentos) : ""}</li>`;
  }).join("")}</ol>`;
}

// ------------------------------------------------------------------------------------------------- detalhe da venda
function recebivelResumo(x) {
  return `<li class="sessao"><div><strong>${esc(processador(x.processador))}</strong> · ${seloDe(situacaoRecebimento(x.situacaoRecebimento))}</div>
  <dl class="ficha ficha--compacta"><dt>Bruto</dt><dd>${valor(x.brutoCentavos)}</dd>
  ${x.componentes.map((c) => `<dt>− ${esc(TIPOS_COMPONENTE[c.tipo] ?? c.tipo)}</dt><dd>${valor(c.valorCentavos)}${fracao(c.fracao)}</dd>`).join("")}
  <dt>Esperado</dt><dd>${valor(x.esperadoCentavos)}</dd><dt>Creditado</dt><dd>${valor(x.liquidadoCentavos)}</dd><dt>Saldo</dt><dd>${valor(x.saldoCentavos)}</dd>
  <dt>Previsão</dt><dd>${x.dataPrevista ? esc(dataBR(x.dataPrevista)) : "sem data"} · ${esc(ORIGEM_PREVISAO[x.origemDaPrevisao])}</dd></dl>
  ${x.creditos.length ? `<ul class="mini">${x.creditos.map((c) => `<li>${esc(dataBR(c.data))} · ${esc(c.conta ?? "conta")} · ${esc(moeda(c.valorCentavos))} · ${esc(COMPROVACOES[c.comprovacao] ?? "")}${c.titulosNoMesmoCredito > 1 ? ` · repasse agrupado (${c.titulosNoMesmoCredito} títulos)` : ""}</li>`).join("")}</ul>` : '<p class="nota">Nenhum crédito vinculado.</p>'}
  ${botaoDetalhe("recebimento", x.id, "Ver ciclo do recebimento")}</li>`;
}

export function detalheDaVenda(d) {
  const o = d.operacao;
  const v = o.valores;
  const agregado = o.tipo === "AGREGADO_DIARIO";
  const linha = (rot, c, cls = "") => `<li${cls ? ` class="${cls}"` : ""}><span>${rot}</span>${valor(c)}</li>`;
  const conf = CONFIABILIDADES[o.confiabilidade.nivel];
  return `${fechar(o.titulo)}
<dl class="ficha">
  <dt>Identificador</dt><dd>${esc(o.identificador)}</dd>
  <dt>Data</dt><dd>${dataHora(o.data, o.horario)}${o.horario ? "" : ' <span class="nota">horário não informado pela fonte</span>'}</dd>
  <dt>Competência</dt><dd>${esc(competencia(o.competencia))}</dd>
  <dt>Canal</dt><dd>${esc(nomeDoCanal(o.canal))}${o.canalComprovado ? "" : " (não presumido)"}</dd>
  <dt>Origem</dt><dd>${esc(o.original.sistema === "MANUAL" ? "Registro manual" : o.original.sistema ?? "—")}</dd>
  <dt>Situação</dt><dd>${seloDe(situacaoVenda(o.situacao))}</dd>
  <dt>Confiabilidade</dt><dd>${conf ? seloDe(conf) : "—"} ${pendencias(o.confiabilidade.motivos)}</dd>
</dl>
${agregado ? `<p class="aviso aviso--alerta">${esc(o.explicacao)}</p>` : ""}
<h3>Valores</h3>
<ul class="lista-simples">
  ${v.receita ? `${linha("Produtos", v.receita.produtosCentavos)}${v.receita.acrescimosCentavos ? linha("+ Acréscimos", v.receita.acrescimosCentavos) : ""}${v.receita.servicosCentavos ? linha("+ Serviços (entrega/serviço da loja)", v.receita.servicosCentavos) : ""}` : agregado ? "" : '<li><span>Componentes da receita não informados</span><span class="valor--desconhecido">—</span></li>'}
  ${linha("Bruto próprio", v.brutoProprioCentavos, "total")}
  ${o.descontos.map((x) => `<li><span>− ${esc(TIPOS_COMPONENTE[x.tipo] ?? x.tipo)}${x.terceiro ? ` (${esc(processador(x.terceiro))})` : ""}<br><span class="nota">${esc(LINHAS_DRE[x.linhaDaDre] ?? "")}</span></span>${valor(x.valorCentavos)}</li>`).join("")}
  ${linha("Cobrado do consumidor", v.cobradoDoConsumidorCentavos, "total")}
  ${agregado ? "" : `${v.devolvidoCentavos ? linha("Devolvido ao cliente", v.devolvidoCentavos) : ""}${linha("Pago (pagamentos válidos)", v.pagoCentavos)}${v.pendenteDePagamentoCentavos ? linha("Pendente de pagamento", v.pendenteDePagamentoCentavos) : ""}`}
</ul>
${o.descontos.some((x) => x.tipo === "SUBSIDIO_DE_TERCEIRO") ? '<p class="nota">Subsídio de terceiro comprovado não reduz a receita: o terceiro paga essa parte (vira recebível dele).</p>' : ""}
${agregado ? "" : `<h3>Pagamentos</h3>
${o.pagamentos.length ? `<ul class="lista-simples">${o.pagamentos.map((p) => `<li><span>${esc(dataBR(p.data))} · ${esc(p.formaLegivel)} · ${esc(processador(p.processador))}${p.subsidio ? " · subsídio" : ""}${p.estornadoCentavos ? ` · estornado ${esc(moeda(p.estornadoCentavos))}` : ""}<br><span class="nota">${p.destino === "RECEBIVEL" ? "gera recebível do processador" : p.destino === "CONTA" ? `recebido direto em ${esc(p.credito?.conta ?? "conta")} · ${esc(COMPROVACOES[p.credito?.comprovacao] ?? "")}` : "crédito ainda não identificado"}</span></span>${valor(p.valorCentavos)}</li>`).join("")}</ul>` : nenhum("Nenhum pagamento informado. Nenhuma forma é presumida.")}
<h3>Taxas, recebíveis e liquidações</h3>
${o.recebiveis.length ? `<ul class="sessoes">${o.recebiveis.map(recebivelResumo).join("")}</ul>` : nenhum("Sem recebível de processador (recebimento direto ou sem pagamento).")}
${o.devolucoes.length ? `<h3>Cancelamentos e ajustes</h3><ul class="lista-simples">${o.devolucoes.map((x) => `<li><span>${esc(dataBR(x.data))} · ${esc(x.nome)}</span>${valor(x.valorCentavos)}</li>`).join("")}</ul>` : ""}`}
<h3>Linha do tempo</h3>
${linhaDoTempo(d.linhaDoTempo)}
<h3>Dados originais × interpretação</h3>
<dl class="ficha ficha--compacta">
  <dt>Descrição original</dt><dd>${esc(o.original.descricao ?? "—")}</dd>
  ${o.original.canal ? `<dt>Canal na fonte</dt><dd>${esc(o.original.canal)} → ${esc(nomeDoCanal(o.canal))}</dd>` : ""}
  ${o.original.forma ? `<dt>Forma na fonte</dt><dd>${esc(o.original.forma)}</dd>` : ""}
  <dt>Interpretação</dt><dd>${esc(o.titulo)}</dd>
</dl>
<h3>Evidências</h3>${documentos(o.documentos)}
<h3>Histórico</h3>${d.historico?.length ? `<ol class="historico">${d.historico.map((h) => `<li><strong>${esc(h.evento.toLowerCase())}</strong> · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico registrado.")}`;
}

// --------------------------------------------------------------------------------------------- detalhe do recebimento
export function detalheDoRecebimento(d) {
  const x = d.recebivel;
  return `${fechar(`${processador(x.processador)} · ciclo do recebimento`)}
<dl class="ficha">
  <dt>Situação</dt><dd>${seloDe(situacaoRecebimento(x.situacaoRecebimento))}</dd>
  <dt>Venda</dt><dd>${d.venda ? `${esc(d.venda.titulo)} ${botaoDetalhe("venda", d.venda.id, "Ver venda")}` : "Recebível sem venda vinculada"}</dd>
  <dt>Canal</dt><dd>${x.canalComprovado ? esc(nomeDoCanal(x.canal)) : "Não comprovado (não presumido)"}</dd>
  <dt>Competência</dt><dd>${esc(competencia(x.competencia))}</dd>
  <dt>Previsão</dt><dd>${x.dataPrevista ? esc(dataBR(x.dataPrevista)) : "Sem data"} · ${esc(ORIGEM_PREVISAO[x.origemDaPrevisao])}</dd>
  <dt>Repasse</dt><dd>${x.repasse.informado ? "Informado em demonstrativo" : "Sem demonstrativo do processador"}</dd>
</dl>
<h3>Valores</h3>
<ul class="lista-simples">
  <li><span>Bruto do recebível</span>${valor(x.brutoCentavos)}</li>
  ${x.componentes.map((c) => `<li><span>− ${esc(TIPOS_COMPONENTE[c.tipo] ?? c.tipo)}${c.nome ? ` · ${esc(c.nome)}` : ""}</span><span>${valor(c.valorCentavos)}${fracao(c.fracao)}</span></li>`).join("")}
  <li class="total"><span>Esperado</span>${valor(x.esperadoCentavos)}</li>
  <li><span>Creditado</span>${valor(x.liquidadoCentavos)}</li>
  <li class="total"><span>Saldo restante</span>${valor(x.saldoCentavos)}</li>
</ul>
<h3>Créditos (liquidações)</h3>
${x.creditos.length ? `<ul class="lista-simples">${x.creditos.map((c) => `<li><span>${esc(dataBR(c.data))} · ${esc(c.conta ?? "conta")}${c.titulosNoMesmoCredito > 1 ? ` · repasse agrupado (${c.titulosNoMesmoCredito} títulos)` : ""}<br><span class="nota">${esc(COMPROVACOES[c.comprovacao] ?? "")}${c.descricaoOriginal ? ` · original: ${esc(c.descricaoOriginal)}` : ""}</span></span>${valor(c.valorCentavos)}</li>`).join("")}</ul>` : nenhum("Nenhum crédito vinculado: o valor não é presumido recebido.")}
<h3>Linha do tempo</h3>
${linhaDoTempo(d.linhaDoTempo)}
<h3>Evidências</h3>${documentos(x.documentos)}
<h3>Histórico</h3>${d.historico?.length ? `<ol class="historico">${d.historico.map((h) => `<li><strong>${esc(h.evento.toLowerCase())}</strong> · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico registrado.")}`;
}
