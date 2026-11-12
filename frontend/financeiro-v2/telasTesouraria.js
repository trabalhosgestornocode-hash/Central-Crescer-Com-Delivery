// Telas de tesouraria do Financeiro v2 (Execução 06A) como funções PURAS: dados das consultas → HTML escapado.
// Nenhuma fórmula financeira: totais, saldos, situações e projeções chegam prontos do backend.
// Documentos aparecem como "registrado, não acessível nesta versão" — nunca há link, arquivo ou caminho.
import {
  EVENTOS, MOTIVOS_PARCIAL, NATUREZAS_FLUXO, OPERACOES_CAIXA, SITUACOES_TITULO, TIPOS_DOCUMENTO, TIPOS_RECEBIVEL, competencia, dataBR, descricaoLegivel, esc, moeda, nomeCanal,
  nomeDevedor, situacaoTitulo,
} from "./formatar.js";

const valorClasse = (c) => (c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor");
const valor = (c) => `<span class="${valorClasse(c)}">${esc(moeda(c))}</span>`;
const selo = (codigo) => { const s = situacaoTitulo(codigo); return `<span class="selo selo--${s.classe}" title="${esc(s.explicacao)}">${esc(s.rotulo)}</span>`; };
const explicar = (titulo, texto) => `<details class="explica"><summary aria-label="Explicação: ${esc(titulo)}"><span aria-hidden="true">i</span></summary><p>${esc(texto)}</p></details>`;
const cabecalho = (titulo, subtitulo) => `<header class="cabecalho"><div><h1>${esc(titulo)}</h1><p class="subtitulo">${subtitulo}</p></div></header>`;
const card = (titulo, conteudo, explicacao = "", extra = "") => `<article class="card card--sec"><div class="card-topo"><h3>${esc(titulo)}</h3>${explicacao ? explicar(titulo, explicacao) : ""}</div><p>${conteudo}</p>${extra}</article>`;
const td = (rotulo, conteudo, classe = "") => `<td data-rotulo="${esc(rotulo)}"${classe ? ` class="${classe}"` : ""}>${conteudo}</td>`;
const opcao = (v, rotulo, atual) => `<option value="${esc(v)}"${v === (atual ?? "") ? " selected" : ""}>${esc(rotulo)}</option>`;
const nenhum = (texto) => `<p class="nota vazio-lista">${esc(texto)}</p>`;

export function documentos(lista = []) {
  if (!lista.length) return '<p class="nota">Nenhum documento vinculado. A pendência fica visível; nenhum documento é presumido.</p>';
  return `<ul class="mini docs">${lista.map((d) => `<li><span class="doc">${esc(TIPOS_DOCUMENTO[d.tipo] ?? "Documento")}${d.descricao ? ` — ${esc(d.descricao)}` : ""} · ${esc(d.referencia)} · registrado, não acessível nesta versão</span></li>`).join("")}</ul>`;
}

export function paginacao(p, alvo) {
  if (!p || p.paginas <= 1) return p ? `<p class="nota">${p.total} registro(s).</p>` : "";
  return `<nav class="paginacao" aria-label="Paginação">
  <button type="button" class="botao" data-pagina="${p.pagina - 1}" data-alvo="${esc(alvo)}"${p.pagina <= 1 ? " disabled" : ""}>Anterior</button>
  <span>Página ${p.pagina} de ${p.paginas} · ${p.total} registro(s)</span>
  <button type="button" class="botao" data-pagina="${p.pagina + 1}" data-alvo="${esc(alvo)}"${p.pagina >= p.paginas ? " disabled" : ""}>Próxima</button></nav>`;
}

const abas = (atual) => `<nav class="abas" aria-label="Contas a pagar">${[["contas-a-pagar", "Lista"], ["calendario", "Calendário"]].map(([r, t]) => `<a href="#/${r}"${r === atual ? ' aria-current="page"' : ""}>${t}</a>`).join("")}</nav>`;
const historico = (lista = []) => (lista.length ? `<ol class="historico">${lista.map((h) => `<li><strong>${esc(EVENTOS[h.evento] ?? h.evento)}</strong> · ${esc(dataBR(h.em))}${h.saldoAntesCentavos !== null && h.saldoDepoisCentavos !== null && h.saldoAntesCentavos !== h.saldoDepoisCentavos ? ` · saldo ${esc(moeda(h.saldoAntesCentavos))} → ${esc(moeda(h.saldoDepoisCentavos))}` : ""}${h.situacaoDepois && h.situacaoAntes !== h.situacaoDepois && h.situacaoAntes ? ` · ${esc(h.situacaoAntes.toLowerCase())} → ${esc(h.situacaoDepois.toLowerCase())}` : ""}${h.vencimentoDepois ? ` · vencimento ${esc(dataBR(h.vencimentoAntes))} → ${esc(dataBR(h.vencimentoDepois))}` : ""}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico."));
const fechar = (titulo) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(titulo)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar detalhe">×</button></div>`;

// ------------------------------------------------------------------------------------------------- contas a pagar
export function contasAPagar(r, f = {}) {
  const t = r.totais;
  return `${cabecalho("Contas a Pagar", `Posição em ${esc(dataBR(r.dataBase))} · ${t.registros} conta(s) no filtro`)}
${abas("contas-a-pagar")}
<section class="resumo" aria-label="Resumo das contas a pagar">
  ${card("Em aberto", valor(t.saldoCentavos), "Saldo que ainda falta pagar (inclui vencidas). Pagamento parcial reduz o saldo; não cria despesa nova.")}
  ${card("Vencido", valor(t.vencidoCentavos), "Contas com vencimento passado e saldo em aberto. Vencer nunca marca a conta como paga.")}
  ${card("Já pago", valor(t.pagoCentavos), "Soma dos pagamentos vinculados às contas do filtro.")}
  ${card("Sem documento", `<span class="valor">${t.semDocumento}</span>`, "Contas em aberto sem boleto, nota ou comprovante vinculado.")}
</section>
<form class="filtros-locais" data-filtro-local="contas-a-pagar" aria-label="Filtros das contas a pagar">
  <label>Situação <select name="situacao">${opcao("", "Todas", f.situacao)}${["EM_ABERTO", "VENCIDO", "PARCIALMENTE_PAGO", "PAGO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA", "CANCELADO"].map((s) => opcao(s, SITUACOES_TITULO[s].rotulo, f.situacao)).join("")}</select></label>
  <label>Fornecedor <select name="contraparteId">${opcao("", "Todos", f.contraparteId)}${r.filtros.fornecedores.map((x) => opcao(x.id, x.nome, f.contraparteId)).join("")}</select></label>
  <label>Categoria <select name="categoria">${opcao("", "Todas", f.categoria)}${r.filtros.categorias.map((x) => opcao(x.codigo, x.nome, f.categoria)).join("")}</select></label>
  <label>Vence de <input type="date" name="vencimentoDe" value="${esc(f.vencimentoDe ?? "")}"></label>
  <label>até <input type="date" name="vencimentoAte" value="${esc(f.vencimentoAte ?? "")}"></label>
  <label class="caixa-marcar"><input type="checkbox" name="soCompetencia"${f.soCompetencia ? " checked" : ""}> Só a competência selecionada</label>
</form>
${r.recorrenciasSemRegistro?.length ? `<p class="aviso aviso--alerta">Recorrência sem registro: ${r.recorrenciasSemRegistro.map((x) => `${esc(x.fornecedor ?? "")} · ${esc(descricaoLegivel(x.descricao))} (${esc(dataBR(x.data))})`).join("; ")}. Nada foi lançado automaticamente.</p>` : ""}
<section class="card" aria-labelledby="t-lista-pagar"><h2 id="t-lista-pagar" class="sr">Lista de contas a pagar</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Contas a pagar</caption><thead><tr><th scope="col">Vencimento</th><th scope="col">Fornecedor e descrição</th><th scope="col">Original</th><th scope="col">Pago</th><th scope="col">Saldo</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((x) => `<tr>${td("Vencimento", esc(dataBR(x.vencimento)))}${td("Fornecedor", `<strong>${esc(x.fornecedor?.nome ?? "Fornecedor não identificado")}</strong><br><span class="nota">${esc(descricaoLegivel(x.descricao))}${x.parcela?.total > 1 ? ` · parcela ${x.parcela.numero}/${x.parcela.total}` : ""}${x.recorrencia ? " · recorrente" : ""} · ${esc(x.categoria?.nome ?? "sem categoria")} · ${esc(competencia(x.competencia))}${x.competenciaHomologada ? " (homologada)" : ""}</span>${x.pendencias.includes("SEM_DOCUMENTO") ? ' <span class="selo selo--alerta">sem documento</span>' : ""}`, "esquerda")}${td("Original", valor(x.valorOriginalCentavos))}${td("Pago", valor(x.pagoCentavos))}${td("Saldo", valor(x.saldoCentavos))}${td("Situação", selo(x.situacao))}${td("Ações", `<button type="button" class="botao-link" data-detalhe="pagar:${esc(x.id)}">Detalhar</button>`)}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhuma conta a pagar com estes filtros.")}
${paginacao(r.paginacao, "contas-a-pagar")}
</section>
${r.porFornecedor.length ? `<details class="card"><summary><h2 class="inline">Por fornecedor</h2></summary><ul class="lista-simples">${r.porFornecedor.map((g) => `<li><span>${esc(g.fornecedor?.nome ?? "Fornecedor não identificado")} · ${g.quantidade} conta(s)</span><span>${valor(g.saldoCentavos)}${g.vencidoCentavos ? ` <small class="valor--negativo">vencido ${esc(moeda(g.vencidoCentavos))}</small>` : ""}</span></li>`).join("")}</ul></details>` : ""}`;
}

export function detalheAPagar(d) {
  const t = d.titulo;
  return `${fechar(`${t.fornecedor?.nome ?? "Conta a pagar"} · ${descricaoLegivel(t.descricao)}`)}
<dl class="ficha">
  <dt>Situação</dt><dd>${selo(t.situacao)}</dd>
  <dt>Valor original</dt><dd>${valor(t.valorOriginalCentavos)}</dd>
  ${t.ajustesCentavos ? `<dt>Ajustes</dt><dd>${valor(t.ajustesCentavos)}</dd>` : ""}
  <dt>Pago</dt><dd>${valor(t.pagoCentavos)}</dd>
  <dt>Saldo restante</dt><dd>${valor(t.saldoCentavos)}</dd>
  <dt>Vencimento</dt><dd>${esc(dataBR(t.vencimento))}</dd>
  <dt>Emissão</dt><dd>${esc(dataBR(t.dataEmissao))}</dd>
  <dt>Competência</dt><dd>${esc(competencia(t.competencia))}${t.competenciaHomologada ? " · homologada" : ""}</dd>
  <dt>Categoria</dt><dd>${esc(t.categoria?.nome ?? "—")}</dd>
  ${t.parcela?.total > 1 ? `<dt>Parcela</dt><dd>${t.parcela.numero} de ${t.parcela.total}</dd>` : ""}
  ${t.recorrencia ? `<dt>Recorrência</dt><dd>Mensal, dia ${t.recorrencia.diaDoMes}</dd>` : ""}
</dl>
${d.lancamento ? `<p class="nota">Efeito no resultado: <strong>um</strong> lançamento de ${esc(moeda(d.lancamento.valorCentavos))} em ${esc(competencia(d.lancamento.competencia))}${d.lancamento.natureza === "PATRIMONIAL" ? " (patrimonial: fora da DRE)" : ""}. Pagar ou antecipar parcelas não cria outra despesa.</p>` : ""}
${d.parcelas.length > 1 ? `<h3>Parcelas</h3><ul class="lista-simples">${d.parcelas.map((p) => `<li${p.id === t.id ? ' class="atual"' : ""}><span>${p.parcela.numero}/${p.parcela.total} · vence ${esc(dataBR(p.vencimento))}</span><span>${valor(p.saldoCentavos)} ${selo(p.situacao)}</span></li>`).join("")}</ul>` : ""}
<h3>Pagamentos</h3>
${t.pagamentos.length ? `<ul class="lista-simples">${t.pagamentos.map((g) => `<li><span>${esc(dataBR(g.data))} · ${esc(g.conta ?? "conta não identificada")}${g.titulosNaMesmaMovimentacao > 1 ? ` · saída agrupada com ${g.titulosNaMesmaMovimentacao - 1} outra(s) conta(s)` : ""}</span><span>${valor(g.valorCentavos)}</span></li>`).join("")}</ul>` : nenhum("Nenhum pagamento vinculado.")}
<h3>Documentos</h3>${documentos(t.documentos)}
<h3>Histórico</h3>${historico(d.historico)}`;
}

// ----------------------------------------------------------------------------------------------- contas a receber
export function contasAReceber(r, f = {}) {
  const t = r.totais;
  return `${cabecalho("Contas a Receber", `Posição em ${esc(dataBR(r.dataBase))} · ${t.registros} título(s) no filtro`)}
<p class="aviso">Stone, iFood e Anota AI são devedores, não contas bancárias: o valor só entra no saldo quando o crédito aparece na conta.</p>
<section class="resumo" aria-label="Resumo das contas a receber">
  ${card("A receber", valor(t.saldoCentavos), "Saldo pendente de todos os títulos do filtro (esperado − recebido).")}
  ${card("Com previsão documentada", valor(t.comPrevisaoCentavos), "Só estes valores entram no fluxo previsto.")}
  ${card("Sem previsão confiável", valor(t.semPrevisaoCentavos), "Sem documento com data de pagamento. A data não é presumida; fica fora da projeção.")}
  ${card("Atrasado", valor(t.atrasadoCentavos), "A data prevista passou sem o crédito correspondente.")}
  ${card("Em divergência", valor(t.emDivergenciaCentavos), "O valor recebido não fechou com o esperado; a diferença está registrada para análise.")}
</section>
<form class="filtros-locais" data-filtro-local="contas-a-receber" aria-label="Filtros das contas a receber">
  <label>Situação <select name="situacao">${opcao("", "Todas", f.situacao)}${["A_RECEBER", "SEM_PREVISAO_CONFIAVEL", "ATRASADO", "PARCIALMENTE_RECEBIDO", "EM_DIVERGENCIA", "RECEBIDO", "CANCELADO"].map((s) => opcao(s, SITUACOES_TITULO[s].rotulo, f.situacao)).join("")}</select></label>
  <label>Tipo <select name="tipo">${opcao("", "Todos", f.tipo)}${Object.entries(TIPOS_RECEBIVEL).map(([k, v]) => opcao(k, v, f.tipo)).join("")}</select></label>
  <label>Processadora <select name="processador">${opcao("", "Todas", f.processador)}${["STONE", "IFOOD", "ANOTA_AI", "OPERADORA_BENEFICIOS"].map((k) => opcao(k, nomeDevedor({ tipo: "PROCESSADORA", nome: k }), f.processador)).join("")}</select></label>
  <label class="caixa-marcar"><input type="checkbox" name="soCompetencia"${f.soCompetencia ? " checked" : ""}> Só a competência selecionada</label>
</form>
<section class="card" aria-labelledby="t-lista-receber"><h2 id="t-lista-receber" class="sr">Lista de contas a receber</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Contas a receber</caption><thead><tr><th scope="col">Previsto</th><th scope="col">Devedor e origem</th><th scope="col">Esperado</th><th scope="col">Recebido</th><th scope="col">Saldo</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((x) => `<tr>${td("Previsto", x.vencimentoPrevisto ? esc(dataBR(x.vencimentoPrevisto)) : '<span class="valor--desconhecido">sem data</span>')}${td("Devedor", `<strong>${esc(nomeDevedor(x.devedor))}</strong><br><span class="nota">${esc(TIPOS_RECEBIVEL[x.tipo])}${x.canal ? ` · ${esc(nomeCanal(x.canal))}` : ""}${x.descricao ? ` · ${esc(descricaoLegivel(x.descricao))}` : ""} · ${esc(competencia(x.competencia))}</span>`, "esquerda")}${td("Esperado", `${valor(x.esperadoCentavos)}${x.deducoesCentavos ? `<br><span class="nota">bruto ${esc(moeda(x.valorOriginalCentavos))} − ${esc(moeda(x.deducoesCentavos))}</span>` : ""}`)}${td("Recebido", `${valor(x.recebidoCentavos)}${x.dataDeLiquidacao ? `<br><span class="nota">em ${esc(dataBR(x.dataDeLiquidacao))}</span>` : ""}`)}${td("Saldo", valor(x.saldoCentavos))}${td("Situação", selo(x.situacao))}${td("Ações", `<button type="button" class="botao-link" data-detalhe="receber:${esc(x.id)}">Detalhar</button>`)}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhum título a receber com estes filtros.")}
${paginacao(r.paginacao, "contas-a-receber")}
</section>
${r.porDevedor.length ? `<details class="card"><summary><h2 class="inline">Por devedor</h2></summary><ul class="lista-simples">${r.porDevedor.map((g) => `<li><span>${esc(nomeDevedor(g.devedor))} · ${g.quantidade} título(s)</span>${valor(g.saldoCentavos)}</li>`).join("")}</ul></details>` : ""}`;
}

export function detalheAReceber(d) {
  const t = d.titulo;
  const c = t.composicao;
  return `${fechar(`${nomeDevedor(t.devedor)} · ${TIPOS_RECEBIVEL[t.tipo]}`)}
<dl class="ficha">
  <dt>Situação</dt><dd>${selo(t.situacao)}</dd>
  <dt>Origem</dt><dd>${t.origem === "VENDA" ? "Pagamento de venda" : "Lançamento avulso"}${t.canal ? ` · ${esc(nomeCanal(t.canal))}` : ""}</dd>
  <dt>Vencimento previsto</dt><dd>${t.vencimentoPrevisto ? esc(dataBR(t.vencimentoPrevisto)) : "Sem data documentada"}${t.vencimentoPrevisto && !t.previsaoConfiavel ? " (sem documento que a comprove)" : ""}</dd>
  <dt>Liquidação</dt><dd>${t.dataDeLiquidacao ? esc(dataBR(t.dataDeLiquidacao)) : "—"}</dd>
  <dt>Competência</dt><dd>${esc(competencia(t.competencia))}${t.competenciaHomologada ? " · homologada" : ""}</dd>
</dl>
<h3>Composição</h3>
<ul class="lista-simples">
  <li><span>Valor original</span>${valor(c.brutoCentavos)}</li>
  ${c.retencoes.map((x) => `<li><span>− ${esc(x.nome)} (retenção)</span>${valor(-x.valorCentavos)}</li>`).join("")}
  ${c.ajustes.map((x) => `<li><span>${x.valorCentavos < 0 ? "−" : "+"} ${esc(x.nome ?? descricaoLegivel(x.motivo))}</span>${valor(x.valorCentavos)}</li>`).join("")}
  <li class="total"><span>Valor esperado</span>${valor(c.esperadoCentavos)}</li>
  <li><span>Recebido</span>${valor(t.recebidoCentavos)}</li>
  <li class="total"><span>Saldo pendente</span>${valor(t.saldoCentavos)}</li>
</ul>
<h3>Recebimentos</h3>
${t.recebimentos.length ? `<ul class="lista-simples">${t.recebimentos.map((g) => `<li><span>${esc(dataBR(g.data))} · ${esc(g.conta ?? "conta não identificada")}${g.titulosNaMesmaMovimentacao > 1 ? ` · repasse agrupado (${g.titulosNaMesmaMovimentacao} títulos no mesmo crédito)` : ""}</span>${valor(g.valorCentavos)}</li>`).join("")}</ul>` : nenhum("Nenhum crédito vinculado ainda.")}
<h3>Evidências</h3>${documentos(t.documentos)}
<h3>Histórico</h3>${historico(d.historico)}`;
}

// ------------------------------------------------------------------------------------------------- caixa e bancos
function sessaoDeCaixa(s) {
  const fechada = s.situacao === "FECHADA";
  return `<li class="sessao"><div><strong>${fechada ? "Fechada" : "Aberta"}</strong> · ${esc(dataBR(s.dataAbertura))}${fechada ? ` a ${esc(dataBR(s.dataFechamento))}` : ""}</div>
  <dl class="ficha ficha--compacta">
    <dt>Abertura (contado)</dt><dd>${valor(s.saldoAberturaCentavos)}</dd>
    <dt>Entradas</dt><dd>${valor(s.entradasCentavos)}</dd><dt>Saídas</dt><dd>${valor(s.saidasCentavos)}</dd>
    ${fechada ? `<dt>Teórico</dt><dd>${valor(s.teoricoCentavos)}</dd><dt>Contado</dt><dd>${valor(s.contadoCentavos)}</dd><dt>Diferença</dt><dd>${valor(s.diferencaCentavos)}${s.diferencaCentavos ? ` — ${esc(s.justificativa ?? "")}` : " (sem diferença)"}</dd>` : `<dt>Teórico até agora</dt><dd>${valor(s.teoricoAtualCentavos)}</dd>`}
  </dl>
  ${s.operacoes.length ? `<ul class="mini">${s.operacoes.map((o) => `<li>${esc(dataBR(o.data))} · ${esc(OPERACOES_CAIXA[o.operacao] ?? o.operacao)}: ${esc(o.descricao)} · ${esc(moeda(o.valorCentavos))}${o.transferenciaId ? " (transferência interna)" : ""}</li>`).join("")}</ul>` : ""}
  ${s.alteradaAposFechamento ? '<p class="aviso aviso--alerta">Houve movimentação lançada depois do fechamento com data dentro da sessão: o teórico mudou e a contagem registrada foi preservada.</p>' : ""}</li>`;
}

function contaFinanceira(c) {
  return `<article class="card conta" aria-labelledby="conta-${esc(c.id)}">
  <div class="card-topo"><h3 id="conta-${esc(c.id)}">${esc(c.nome)}</h3><span class="selo selo--neutro">${c.tipo === "CAIXA_FISICO" ? "Caixa físico" : "Conta bancária"}</span></div>
  <dl class="ficha ficha--compacta">
    <dt>Saldo inicial</dt><dd>${valor(c.saldoInicialCentavos)}</dd>
    <dt>Entradas</dt><dd>${valor(c.entradasCentavos)}</dd>
    <dt>Saídas</dt><dd>${valor(c.saidasCentavos)}</dd>
    <dt>Saldo final</dt><dd><strong>${valor(c.saldoFinalCentavos)}</strong></dd>
    ${c.transferenciasRecebidasCentavos || c.transferenciasEnviadasCentavos ? `<dt>Transferências internas</dt><dd>recebidas ${esc(moeda(c.transferenciasRecebidasCentavos))} · enviadas ${esc(moeda(c.transferenciasEnviadasCentavos))}</dd>` : ""}
  </dl>
  ${c.situacaoDoSaldo === "DESCONHECIDO" ? '<p class="aviso aviso--alerta">Saldo desconhecido: falta um saldo informado (extrato ou contagem) até o fim do período. O saldo não é presumido como zero.</p>' : `<p class="nota">Ponto de partida: saldo informado em ${esc(dataBR(c.saldoInformado?.data))}${c.saldoInformado?.observacao ? ` (${esc(c.saldoInformado.observacao)})` : ""}.</p>`}
  ${c.saldoInformado?.documentos?.length ? documentos(c.saldoInformado.documentos) : ""}
  ${c.conferenciasDeSaldo.length ? `<ul class="mini">${c.conferenciasDeSaldo.map((x) => `<li>Saldo informado em ${esc(dataBR(x.data))}: ${esc(moeda(x.informadoCentavos))} · calculado ${esc(moeda(x.calculadoCentavos))} · diferença <strong>${esc(moeda(x.diferencaCentavos))}</strong></li>`).join("")}</ul>` : ""}
  <p class="nota">Conciliação no período: ${c.conciliacao.conciliadas} conciliada(s), ${c.conciliacao.parciais} parcial(is), ${c.conciliacao.naoConciliadas} não conciliada(s).${c.pendencias.semVinculo ? ` <strong>${c.pendencias.semVinculo} movimento(s) sem vínculo</strong> (${esc(moeda(c.pendencias.semVinculoCentavos))}) aguardando classificação.` : ""}</p>
  ${c.diferencasDeCaixaNaoAjustadasCentavos ? `<p class="aviso aviso--alerta">Diferenças de contagem no período: ${esc(moeda(c.diferencasDeCaixaNaoAjustadasCentavos))}. Ficam registradas nas sessões; o saldo da conta não é ajustado automaticamente.</p>` : ""}
  ${c.tipo === "CAIXA_FISICO" ? `<h4>Sessões de caixa</h4>${c.sessoesDeCaixa.length ? `<ul class="sessoes">${c.sessoesDeCaixa.map(sessaoDeCaixa).join("")}</ul>` : nenhum("Nenhuma sessão de caixa no período.")}` : ""}
</article>`;
}

export function caixaEBancos(r, f = {}) {
  const k = r.consolidado;
  return `${cabecalho("Caixa e Bancos", `${esc(dataBR(r.periodo.inicio))} a ${esc(dataBR(r.periodo.fim))} · posição em ${esc(dataBR(r.dataBase))}`)}
<p class="aviso">Saldo bancário não é faturamento. Entradas e saídas sem vínculo ficam pendentes: nada vira receita ou despesa pelo sinal do valor.</p>
<form class="filtros-locais" data-filtro-local="caixa-e-bancos" aria-label="Período e conta">
  <label>De <input type="date" name="inicio" value="${esc(r.periodo.inicio)}"></label>
  <label>Até <input type="date" name="fim" value="${esc(r.periodo.fim)}"></label>
  <label>Conta <select name="contaId">${opcao("", "Todas", f.contaId)}${(f.contas ?? r.contas).map((c) => opcao(c.id, c.nome, f.contaId)).join("")}</select></label>
</form>
<section class="resumo" aria-label="Consolidado">
  ${card("Saldo bancário", valor(k.saldoBancarioCentavos), "Soma das contas bancárias no fim do período: saldo informado mais movimentações registradas.")}
  ${card("Caixa físico", valor(k.saldoCaixaFisicoCentavos), "Saldo calculado da gaveta. A contagem de cada sessão é comparada com o teórico, sem ajuste automático.")}
  ${card("Entradas no período", valor(k.entradasCentavos), "Sem transferências internas entre as contas consolidadas.")}
  ${card("Saídas no período", valor(k.saidasCentavos), "Sem transferências internas entre as contas consolidadas.")}
  ${k.transferenciasInternasCentavos !== null ? card("Transferências internas", valor(k.transferenciasInternasCentavos), "Dinheiro que só mudou de conta (ex.: depósito do caixa no banco). No consolidado, saída e entrada se anulam.") : ""}
</section>
${k.contasSemSaldoInformado.length ? `<p class="aviso aviso--alerta">Sem saldo informado: ${k.contasSemSaldoInformado.map(esc).join(", ")}. Saldo exibido como desconhecido.</p>` : ""}
<section class="contas" aria-label="Contas">${r.contas.map(contaFinanceira).join("")}</section>
<section class="card" aria-labelledby="t-movs"><h2 id="t-movs">Movimentações</h2>
${r.movimentos.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Movimentações do período</caption><thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Conta</th><th scope="col">Entrada</th><th scope="col">Saída</th><th scope="col">Conciliação</th></tr></thead><tbody>
${r.movimentos.map((m) => `<tr${m.situacao === "ESTORNADA" ? ' class="estornada"' : ""}>${td("Data", esc(dataBR(m.data)))}${td("Descrição", `<strong>${esc(m.titulo)}</strong>${m.descricaoOriginal ? `<br><span class="nota" title="Descrição original do extrato/registro">Original: ${esc(m.descricaoOriginal)}</span>` : ""}${m.pendencias.includes("SEM_VINCULO") ? ' <span class="selo selo--alerta">sem vínculo</span>' : ""}${m.pendencias.includes("PARCIALMENTE_VINCULADO") ? ` <span class="selo selo--alerta">${esc(moeda(m.naoVinculadoCentavos))} sem vínculo</span>` : ""}${m.situacao === "ESTORNADA" ? ' <span class="selo selo--neutro">estornada</span>' : ""}${m.vinculo.titulos?.length > 1 ? `<ul class="mini">${m.vinculo.titulos.map((x) => `<li>${esc(x.parte ?? "")} ${x.descricao ? `· ${esc(descricaoLegivel(x.descricao))}` : ""}: ${esc(moeda(x.valorCentavos))}</li>`).join("")}</ul>` : ""}`, "esquerda")}${td("Conta", esc(m.conta?.nome ?? "—"))}${td("Entrada", m.sentido === "ENTRADA" ? valor(m.valorCentavos) : "")}${td("Saída", m.sentido === "SAIDA" ? valor(m.valorCentavos) : "")}${td("Conciliação", esc(({ CONCILIADA: "Conciliada", PARCIAL: "Parcial", NAO_CONCILIADA: "Não conciliada" })[m.situacaoConciliacao] ?? "—"))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhuma movimentação no período.")}
${paginacao(r.paginacao, "caixa-e-bancos")}
</section>
<p class="nota">Abertura, sangria, suprimento e fechamento de caixa e registro de saldo informado existem no núcleo (com permissão, confirmação e auditoria), mas não estão habilitados nesta demonstração: a sessão aqui é simulada.</p>`;
}

// ----------------------------------------------------------------------------------------------------- calendário
const SEMANA = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
export function calendario(cal, { selecionado = null } = {}) {
  const deslocamento = (cal.dias[0].diaDaSemana + 6) % 7;
  const marca = (n, classe, rotulo) => (n ? `<span class="marca-dia marca-dia--${classe}" title="${esc(rotulo)}">${n}</span>` : "");
  return `${cabecalho("Calendário financeiro", `${esc(competencia(cal.mes))} · posição em ${esc(dataBR(cal.dataBase))}`)}
${abas("calendario")}
<div class="cal-nav"><button type="button" class="botao" data-mes="-1" aria-label="Mês anterior">‹ Anterior</button><strong>${esc(competencia(cal.mes))}</strong><button type="button" class="botao" data-mes="1" aria-label="Próximo mês">Próximo ›</button></div>
<section class="resumo" aria-label="Totais do mês">
  ${card("A vencer", valor(cal.totais.aVencerCentavos))}${card("Vencido em aberto", valor(cal.totais.vencidoCentavos))}${card("Pago no mês", valor(cal.totais.pagoCentavos))}${card("Recorrências previstas", valor(cal.totais.recorrentePrevistoCentavos), "Estimadas pelo último valor da série; não são contas lançadas.")}
</section>
<ul class="legenda legenda--cal"><li><span class="marca-dia marca-dia--info" aria-hidden="true"></span> vencendo</li><li><span class="marca-dia marca-dia--erro" aria-hidden="true"></span> vencidas</li><li><span class="marca-dia marca-dia--ok" aria-hidden="true"></span> pagamentos</li><li><span class="marca-dia marca-dia--alerta" aria-hidden="true"></span> recorrentes previstas</li></ul>
<div class="calendario" role="grid" aria-label="Dias de ${esc(competencia(cal.mes))}">
  ${SEMANA.map((s) => `<div class="cal-cab" role="columnheader">${s}</div>`).join("")}
  ${'<div class="cal-vazio" aria-hidden="true"></div>'.repeat(deslocamento)}
  ${cal.dias.map((d) => {
    const algo = d.titulos.length + d.pagamentos.length + d.recorrentes.length;
    return `<button type="button" role="gridcell" class="cal-dia${d.hoje ? " cal-dia--hoje" : ""}${algo ? "" : " cal-dia--livre"}${d.data === selecionado ? " cal-dia--sel" : ""}" data-dia="${esc(d.data)}" aria-pressed="${d.data === selecionado}" aria-label="${esc(dataBR(d.data))}: ${d.aVencer.quantidade} vencendo, ${d.vencidas.quantidade} vencida(s), ${d.pagas.quantidade} pagamento(s), ${d.recorrentesPrevistas.quantidade} recorrente(s)${d.emAbertoCentavos ? `, em aberto ${moeda(d.emAbertoCentavos)}` : ""}">
      <span class="cal-num">${Number(d.data.slice(8))}</span>
      <span class="cal-marcas">${marca(d.aVencer.quantidade, "info", "vencendo")}${marca(d.vencidas.quantidade, "erro", "vencidas")}${marca(d.pagas.quantidade, "ok", "pagamentos")}${marca(d.recorrentesPrevistas.quantidade, "alerta", "recorrentes")}</span>
      ${d.emAbertoCentavos ? `<span class="cal-valor">${esc(moeda(d.emAbertoCentavos))}</span>` : ""}
    </button>`;
  }).join("")}
</div>
<section id="dia-detalhe" class="card" aria-live="polite">${selecionado ? diaDoCalendario(cal.dias.find((d) => d.data === selecionado)) : '<p class="nota">Toque em um dia para ver as contas.</p>'}</section>`;
}

export function diaDoCalendario(d) {
  if (!d) return "";
  return `<h2>${esc(dataBR(d.data))}</h2>
${d.titulos.length ? `<h3>Contas com vencimento no dia</h3><ul class="lista-simples">${d.titulos.map((t) => `<li><span>${esc(t.fornecedor ?? "")} · ${esc(descricaoLegivel(t.descricao))}${t.parcela?.total > 1 ? ` (${t.parcela.numero}/${t.parcela.total})` : ""}${t.recorrente ? " · recorrente" : ""}</span><span>${valor(t.saldoCentavos)} ${selo(t.situacao)} <button type="button" class="botao-link" data-detalhe="pagar:${esc(t.id)}">Detalhar</button></span></li>`).join("")}</ul>` : ""}
${d.pagamentos.length ? `<h3>Pagamentos feitos no dia</h3><ul class="lista-simples">${d.pagamentos.map((g) => `<li><span>${esc(g.fornecedor ?? "")} · ${esc(descricaoLegivel(g.descricao))} · ${esc(g.conta ?? "")}</span>${valor(g.valorCentavos)}</li>`).join("")}</ul>` : ""}
${d.recorrentes.length ? `<h3>Recorrências previstas (estimadas)</h3><ul class="lista-simples">${d.recorrentes.map((x) => `<li><span>${esc(x.fornecedor ?? "")} · ${esc(descricaoLegivel(x.descricao))}</span>${valor(x.valorCentavos)}</li>`).join("")}</ul>` : ""}
${d.titulos.length + d.pagamentos.length + d.recorrentes.length ? "" : nenhum("Nada vence nem foi pago neste dia.")}`;
}

// ------------------------------------------------------------------------------------------------- fluxo de caixa
export function fluxoDeCaixa(fl, f = {}) {
  const p = fl.projecao;
  const tipoPeriodo = { REALIZADO: "Realizado", ATUAL: "Atual", PREVISTO: "Previsto" };
  const rotuloPeriodo = (s) => (fl.periodo.granularidade === "DIA" ? dataBR(s.inicio) : `${dataBR(s.inicio)} a ${dataBR(s.fim)}`);
  return `${cabecalho("Fluxo de Caixa", `${esc(dataBR(fl.periodo.inicio))} a ${esc(dataBR(fl.periodo.fim))} · hoje ${esc(dataBR(fl.dataBase))}`)}
<form class="filtros-locais" data-filtro-local="fluxo-de-caixa" aria-label="Período do fluxo">
  <label>Período <select name="preset">${[["competencia", "Mês da competência"], ["30", "Próximos 30 dias"], ["90", "Próximos 90 dias"], ["personalizado", "Personalizado"]].map(([v, t]) => opcao(v, t, f.preset ?? "competencia")).join("")}</select></label>
  <label>De <input type="date" name="inicio" value="${esc(fl.periodo.inicio)}"></label>
  <label>Até <input type="date" name="fim" value="${esc(fl.periodo.fim)}"></label>
  <label>Agrupar por <select name="granularidade">${[["DIA", "Dia"], ["SEMANA", "Semana"], ["MES", "Mês"]].map(([v, t]) => opcao(v, t, fl.periodo.granularidade)).join("")}</select></label>
</form>
<section class="resumo" aria-label="Resumo do fluxo">
  ${card("Saldo no início", valor(fl.saldoInicialCentavos), "Saldo das contas no início do período (saldo informado + movimentos).")}
  ${card("Realizado", `${valor(fl.realizado.variacaoCentavos)}`, "Entradas − saídas efetivas até hoje. Transferências internas se anulam.", `<p class="nota">Entradas ${esc(moeda(fl.realizado.entradasCentavos))} · Saídas ${esc(moeda(fl.realizado.saidasCentavos))}</p>`)}
  ${card("Disponível hoje", valor(fl.saldoAtualCentavos), "Dinheiro já nas contas. Previsões nunca entram aqui.")}
  ${p.aplicavel ? card("Previsto", valor(fl.previsto.variacaoCentavos), "Saldo em aberto de contas a pagar e de recebíveis com data documentada, mais recorrências estimadas.", `<p class="nota">Entradas ${esc(moeda(fl.previsto.entradasCentavos))} · Saídas ${esc(moeda(fl.previsto.saidasCentavos))}</p>`) : ""}
  ${p.aplicavel ? card("Saldo projetado", `${valor(p.saldoProjetadoCentavos)}${p.parcial ? ' <span class="selo selo--alerta">projeção parcial</span>' : ""}`, "Disponível hoje + entradas previstas − saídas previstas. O que já foi pago ou recebido não é contado de novo.", `<p class="nota">até ${esc(dataBR(p.ate))}</p>`) : ""}
</section>
${p.parcial ? `<ul class="pendencias" aria-label="Por que a projeção é parcial">${p.motivos.map((m) => `<li>${esc(MOTIVOS_PARCIAL[m] ?? m)}</li>`).join("")}</ul>` : ""}
<section class="card" aria-labelledby="t-serie"><h2 id="t-serie">Por ${esc(({ DIA: "dia", SEMANA: "semana", MES: "mês" })[fl.periodo.granularidade])}</h2>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Fluxo de caixa por período</caption><thead><tr><th scope="col">Período</th><th scope="col">Realizado: entradas</th><th scope="col">Realizado: saídas</th><th scope="col">Previsto: entradas</th><th scope="col">Previsto: saídas</th><th scope="col">Saldo disponível</th><th scope="col">Saldo projetado</th></tr></thead><tbody>
${fl.serie.map((s) => `<tr class="periodo--${s.tipo.toLowerCase()}">${td("Período", `${esc(rotuloPeriodo(s))} <span class="nota">${tipoPeriodo[s.tipo]}</span>`, "esquerda")}${td("Realizado: entradas", valor(s.realizado.entradasCentavos))}${td("Realizado: saídas", valor(s.realizado.saidasCentavos))}${td("Previsto: entradas", s.tipo === "REALIZADO" ? "—" : valor(s.previsto.entradasCentavos))}${td("Previsto: saídas", s.tipo === "REALIZADO" ? "—" : valor(s.previsto.saidasCentavos))}${td("Saldo disponível", s.saldoRealizadoCentavos === null && s.tipo === "PREVISTO" ? "—" : valor(s.saldoRealizadoCentavos))}${td("Saldo projetado", s.tipo === "REALIZADO" ? "—" : valor(s.saldoProjetadoCentavos))}</tr>`).join("")}
</tbody></table></div></section>
${p.aplicavel ? `<section class="card" aria-labelledby="t-prev"><h2 id="t-prev">Valores previstos</h2>${fl.previsto.itens.length ? `<ul class="lista-simples">${fl.previsto.itens.map((i) => `<li><span>${esc(dataBR(i.data))} · ${esc(NATUREZAS_FLUXO[i.natureza] ?? i.natureza)} · ${esc(descricaoLegivel(i.titulo))}${i.vencimentoOriginal ? ` (venceu em ${esc(dataBR(i.vencimentoOriginal))})` : ""}</span>${valor(i.sentido === "SAIDA" ? -i.valorCentavos : i.valorCentavos)}</li>`).join("")}</ul>` : nenhum("Nada previsto no período.")}</section>` : ""}
${fl.semPrevisao.quantidade ? `<section class="card" aria-labelledby="t-semprev"><h2 id="t-semprev">Fora da projeção: sem previsão confiável</h2><p class="nota">${esc(moeda(fl.semPrevisao.saldoCentavos))} a receber sem data documentada. A data de repasse não é presumida.</p><ul class="lista-simples">${fl.semPrevisao.itens.map((i) => `<li><span>${esc(nomeDevedor({ tipo: "PROCESSADORA", nome: i.devedor }))} · ${esc(situacaoTitulo(i.situacao).rotulo)}</span>${valor(i.saldoCentavos)}</li>`).join("")}</ul></section>` : ""}
<section class="card" aria-labelledby="t-nat"><h2 id="t-nat">Realizado por natureza</h2>${Object.keys(fl.realizado.porNatureza).length ? `<ul class="lista-simples">${Object.entries(fl.realizado.porNatureza).map(([k, v]) => `<li><span>${esc(NATUREZAS_FLUXO[k] ?? k)}</span>${valor(v)}</li>`).join("")}</ul>` : nenhum("Nenhuma movimentação realizada no período.")}
<p class="nota">Transferências internas no período (anuladas): ${esc(moeda(fl.realizado.transferenciasInternasAnuladasCentavos))}.</p></section>`;
}

// ------------------------------------------------------------------------------------- cards da Visão Geral (06A)
/** Cards financeiros da Visão Geral a partir do resumo central. Desconhecido nunca vira R$ 0,00. */
export function cardsFinanceirosDaVisaoGeral(fin) {
  const motivoSaldo = (s) => (s.situacao === "SEM_CONTA" ? "Nenhuma conta deste tipo cadastrada." : s.situacao === "DESCONHECIDO" ? "Falta saldo informado (extrato ou contagem)." : `Posição em ${dataBR(fin.dataBase)}.`);
  const semRegistros = (x) => x.situacao === "SEM_REGISTROS";
  const link = (rota, texto) => `<a class="botao-link" href="#/${rota}">${esc(texto)}</a>`;
  const f = fin.fluxoDeCaixa;
  return [
    `<article class="card card--sec" data-financeiro="saldo-bancario"><h3>Saldo bancário</h3><p>${valor(fin.saldoBancario.valorCentavos)}</p><p class="nota">${esc(motivoSaldo(fin.saldoBancario))} Não é faturamento.</p>${link("caixa-e-bancos", "Ver contas")}</article>`,
    `<article class="card card--sec" data-financeiro="caixa-fisico"><h3>Caixa físico</h3><p>${valor(fin.saldoCaixaFisico.valorCentavos)}</p><p class="nota">${esc(motivoSaldo(fin.saldoCaixaFisico))}</p>${link("caixa-e-bancos", "Ver caixa")}</article>`,
    `<article class="card card--sec" data-financeiro="contas-a-pagar"><h3>Contas a pagar</h3><p>${semRegistros(fin.contasAPagar) ? '<span class="valor valor--desconhecido">Sem contas registradas</span>' : valor(fin.contasAPagar.saldoCentavos)}</p>${!semRegistros(fin.contasAPagar) && fin.contasAPagar.vencidoCentavos ? `<p class="nota"><span class="valor--negativo">Vencido ${esc(moeda(fin.contasAPagar.vencidoCentavos))}</span></p>` : ""}${link("contas-a-pagar", "Ver contas a pagar")}</article>`,
    `<article class="card card--sec" data-financeiro="contas-a-receber"><h3>Contas a receber</h3><p>${semRegistros(fin.contasAReceber) ? '<span class="valor valor--desconhecido">Sem títulos registrados</span>' : valor(fin.contasAReceber.saldoCentavos)}</p>${!semRegistros(fin.contasAReceber) && fin.contasAReceber.semPrevisaoCentavos ? `<p class="nota">Sem previsão confiável: ${esc(moeda(fin.contasAReceber.semPrevisaoCentavos))}</p>` : ""}${link("contas-a-receber", "Ver contas a receber")}</article>`,
    `<article class="card card--sec" data-financeiro="fluxo-de-caixa"><h3>Fluxo de caixa</h3><p>${f.realizadoNaCompetencia.movimentacoes ? valor(f.realizadoNaCompetencia.variacaoCentavos) : '<span class="valor valor--desconhecido">Sem movimentações registradas</span>'}</p><p class="nota">Realizado na competência (até ${esc(dataBR(f.realizadoNaCompetencia.ate))}). Saldo projetado em 30 dias: ${esc(moeda(f.saldoProjetado30DiasCentavos))}${f.parcial ? " (parcial)" : ""}.</p>${link("fluxo-de-caixa", "Ver fluxo")}</article>`,
  ].join("");
}
