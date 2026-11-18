// Fase 11 (doc 48) — IMPORTAÇÕES dentro da página de cada canal (SAIPOS, iFood, 99Food), no mesmo padrão visual.
// Só apresentação: o servidor diz quais formatos existem, quais estão indisponíveis (e por quê), o histórico e a prévia do
// demonstrativo do iFood (a conta é conferida lá). O envio do arquivo, a prévia do arquivo e a confirmação são os MESMOS da Central.
// Nada aqui soma, calcula ou presume: formato sem leitor validado aparece bloqueado, com o motivo, e não há como confirmá-lo.
import { dataBR, esc, moeda } from "./formatar.js";

const NOME_DO_CANAL = Object.freeze({ SAIPOS: "SAIPOS", IFOOD: "iFood", NOVENTA_E_NOVE_FOOD: "99Food" });
const ESTADO = Object.freeze({
  RECEBIDO: ["Recebido", "neutro"], EM_VALIDACAO: ["Em validação", "info"], PRONTO_PARA_IMPORTAR: ["Prévia pronta: aguardando confirmação", "alerta"],
  IMPORTADO: ["Importado", "ok"], IMPORTADO_COM_PENDENCIAS: ["Importado com pendências", "alerta"], REJEITADO: ["Rejeitado", "erro"], SUBSTITUIDO: ["Substituído", "neutro"],
});
const REPASSE = Object.freeze({ RECEBIDO: "Recebido", PARCIAL: "Recebido em parte", PREVISTO: "Previsto", ATRASADO: "Atrasado", SEM_RECEBIVEL: "Sem recebível" });
const selo = (rotulo, classe) => `<span class="selo selo--${classe}">${esc(rotulo)}</span>`;
const valor = (c) => `<span class="${c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor"}">${c === null || c === undefined ? "—" : esc(moeda(c))}</span>`;
const lista = (itens) => (itens.length ? `<ul class="lista-simples">${itens.join("")}</ul>` : "");
const fechar = (titulo) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(titulo)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar detalhe">×</button></div>`;
const td = (rotulo, conteudo, classe = "") => `<td data-rotulo="${esc(rotulo)}"${classe ? ` class="${classe}"` : ""}><span class="cel">${conteudo}</span></td>`;

// ------------------------------------------------------------------------------------------------------ formatos
function formatosDoCanal(d) {
  return `<h3>O que esta página importa</h3><ul class="formatos-canal">${d.formatos.map((f) => `<li class="formato formato--${f.disponivel ? "ok" : "off"}">
<div class="formato-topo"><strong>${esc(f.nome)}</strong>${f.disponivel ? selo("Disponível", "ok") : selo("Indisponível", "neutro")}${f.principal ? selo("Principal", "info") : ""}${f.aceitaArquivo ? (f.homologado ? selo(`Leitor homologado (${f.extensoesHomologadas.join(", ").toUpperCase()})`, "ok") : selo("Leitor não homologado", "alerta")) : ""}</div>
<p class="nota">${esc(f.disponivel ? f.descricao : f.motivo)}</p>${f.dica ? `<p class="nota imp-dica">${esc(f.dica)}</p>` : ""}</li>`).join("")}</ul>`;
}

// -------------------------------------------------------------------------------------------------- envio de arquivo
/** Versão corrigida de um relatório oficial: escolha explícita. Sem escolha, o arquivo é complementar e nada anterior é retirado. */
function substituiveis(d) {
  const lista = (d.historico ?? []).filter((i) => ["IFOOD_CONCILIACAO", "NOVENTA_E_NOVE_FOOD_RELATORIO"].includes(i.tipoRelatorio) && ["IMPORTADO", "IMPORTADO_COM_PENDENCIAS"].includes(i.estado));
  if (!lista.length) return "";
  return `<label class="campo--largo">Este arquivo corrige outro? <select name="substitui"><option value="">Não: é um relatório novo ou complementar</option>${lista.map((i) => `<option value="${esc(i.id)}">Sim: substitui ${esc(dataBR(i.periodoInicio))} a ${esc(dataBR(i.periodoFim))}</option>`).join("")}</select></label>`;
}

function formularioDeArquivo(d, ctx) {
  const aceitos = d.formatos.filter((f) => f.aceitaArquivo);
  const nome = NOME_DO_CANAL[d.canal];
  const unidade = `<p class="conta-fixa"><strong>Unidade:</strong> ${esc(d.unidade?.nome ?? "—")}</p>`;
  if (!aceitos.length) {
    // 99Food (e iFood sem arquivo): o formulário existe para o usuário ver o que virá, mas NADA pode ser enviado nem confirmado.
    const motivo = d.formatos.find((f) => !f.disponivel && f.principal)?.motivo ?? d.formatos.find((f) => !f.disponivel)?.motivo ?? "";
    return `<section class="card imp-envio imp-envio--bloqueado" aria-labelledby="t-env-${esc(d.canal)}"><h3 id="t-env-${esc(d.canal)}">Enviar relatório ${esc(nome)}</h3>${unidade}
<p class="aviso aviso--alerta" role="status">${esc(motivo)}</p>
<form class="acao acao--formulario" aria-label="Envio de relatório ${esc(nome)} (indisponível)" data-envio-bloqueado><fieldset disabled><legend class="sr">Envio indisponível</legend><div class="campos-form">
  <label class="campo--largo">Relatório <select name="tipoRelatorio"><option>Relatório oficial ${esc(nome)} (aguardando validação do primeiro arquivo)</option></select></label>
  <label>Início do período <input type="date" name="periodoInicio"></label>
  <label>Fim do período <input type="date" name="periodoFim"></label>
  <label class="campo--largo">Arquivo <input type="file" name="arquivo"></label></div>
  <div class="acoes-form"><button type="submit" class="botao botao--primario">Enviar e gerar a prévia</button></div></fieldset></form>
<p class="nota">Quando o primeiro relatório oficial for validado, este envio passa a funcionar. Até lá nenhum formato é aceito nem presumido.</p></section>`;
  }
  if (!d.acoes.importar) {
    return `<section class="card imp-envio" aria-labelledby="t-env-${esc(d.canal)}"><h3 id="t-env-${esc(d.canal)}">Enviar relatório ${esc(nome)}</h3>${unidade}<p class="nota">Você não tem permissão para importar nesta unidade (exige "Importar"). O histórico abaixo continua visível.</p></section>`;
  }
  const hoje = ctx.periodoPadrao ?? { inicio: "", fim: "" };
  return `<section class="card imp-envio" aria-labelledby="t-env-${esc(d.canal)}"><h3 id="t-env-${esc(d.canal)}">Enviar relatório ${esc(nome)}</h3>${unidade}
<ol class="passos"><li>Escolher o relatório e o período</li><li>Enviar e conferir a prévia</li><li>Confirmar a importação</li><li>Gerar e aplicar as propostas</li><li>Conferir o calendário e os cards</li></ol>
<form class="acao acao--formulario" data-acao="/api/fv2/acoes/importacao/receber" data-recarregar="resultado:documento" data-envio-evidencia>
  <div class="campos-form">
  <label class="campo--largo">Relatório <select name="tipoRelatorio" required>${aceitos.map((f) => `<option value="${esc(f.tipoRelatorio)}"${f.principal ? " selected" : ""}>${esc(f.nome)}${f.principal ? " — recomendado" : ""}</option>`).join("")}</select></label>
  <label>Início do período <input type="date" name="periodoInicio" value="${esc(hoje.inicio)}" required></label>
  <label>Fim do período <input type="date" name="periodoFim" value="${esc(hoje.fim)}" required></label>
  <label class="campo--largo">Arquivo <input type="file" name="arquivo" accept="${d.canal === "NOVENTA_E_NOVE_FOOD" ? ".xlsx,.zip" : ".xlsx,.pdf,.csv"}" required></label>
  ${substituiveis(d)}
  </div>
  <label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo que é o arquivo original exportado da ${esc(nome)}, do período informado, para a unidade ${esc(d.unidade?.nome ?? "")}. Nada entra no financeiro antes da confirmação da prévia.</label>
  <div class="acoes-form"><button type="submit" class="botao botao--primario">Enviar e gerar a prévia</button></div>
  <p class="resultado-acao" role="status" aria-live="polite"></p>
</form>
<p class="nota">O arquivo é lido e descartado: ficam só a impressão digital e as linhas extraídas. A prévia mostra os pedidos por canal, as duplicidades, as pendências e os erros antes de você confirmar.</p></section>`;
}

// ---------------------------------------------------------------------------- demonstrativo oficial do iFood (prévia)
function formularioDoDemonstrativo(d) {
  if (!d.acoes.registrarDemonstrativo) return `<section class="card imp-envio"><h3>Registrar demonstrativo oficial do iFood</h3><p class="nota">Você não tem permissão para registrar o demonstrativo nesta unidade (exige "Registrar").</p></section>`;
  const reais = (nome, rotulo, extra = "") => `<label>${esc(rotulo)} <input type="text" name="${nome}" inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?" placeholder="0,00"${extra}></label>`;
  return `<section class="card imp-envio" aria-labelledby="t-dem"><h3 id="t-dem">Registrar demonstrativo oficial do iFood</h3>
<p class="conta-fixa"><strong>Unidade:</strong> ${esc(d.unidade?.nome ?? "—")}</p>
<ol class="passos"><li>Informar os valores do demonstrativo</li><li>Conferir a prévia (a conta precisa fechar)</li><li>Confirmar o registro</li><li>Conferir o calendário e os repasses</li></ol>
<form class="acao acao--formulario" data-previa-demonstrativo aria-label="Conferir prévia do demonstrativo do iFood">
  <div class="campos-form">
  <label>Início do período <input type="date" name="periodoInicio" required></label>
  <label>Fim do período <input type="date" name="periodoFim" required></label>
  ${reais("vendas", "Faturamento (vendas)", " required")}${reais("comissoes", "Comissões")}${reais("taxaPagamento", "Taxa de pagamento online")}
  ${reais("mensalidade", "Mensalidade")}${reais("servicosEPromocoes", "Serviços e promoções")}${reais("ajustes", "Ajustes (positivo ou negativo)")}
  ${reais("liquido", "Faturamento líquido informado", " required")}
  <label class="campo--largo">Origem do dado <input type="text" name="origem" maxlength="300" required placeholder="Ex.: demonstrativo financeiro do portal do iFood, período 01 a 08/11"></label>
  <label class="campo--largo">Justificativa <input type="text" name="justificativa" maxlength="500" required placeholder="Por que este demonstrativo está sendo registrado"></label>
  </div>
  <div class="acoes-form"><button type="submit" class="botao botao--primario">Conferir prévia</button></div>
</form>
<p class="nota">O demonstrativo cobre o período inteiro: o detalhamento por dia depende do relatório oficial de pedidos, que ainda não é suportado.</p></section>`;
}

// ------------------------------------------------------------------------------------------------------- histórico
function historico(d) {
  const linhas = d.historico.map((i) => {
    const [rotulo, classe] = ESTADO[i.estado] ?? [i.estado, "neutro"];
    return `<tr>${td("Período", `${esc(dataBR(i.periodoInicio))} a ${esc(dataBR(i.periodoFim))}`, "esquerda")}${td("Relatório", esc(i.relatorio), "esquerda")}${td("Situação", selo(rotulo, classe))}
${td("Erros", String(i.erros))}${td("Divergências", String(i.divergencias))}${td("Já existentes", String(i.jaExistentes))}
${td("Ações", `<button type="button" class="botao-link" data-detalhe="documento:${esc(i.id)}">${i.estado === "PRONTO_PARA_IMPORTAR" ? "Conferir prévia e confirmar" : "Ver prévia e propostas"}</button>${i.tipoRelatorio === "IFOOD_CONCILIACAO" && ["IMPORTADO", "IMPORTADO_COM_PENDENCIAS"].includes(i.estado) ? `<button type="button" class="botao-link" data-detalhe="conciliacao-ifood:${esc(i.id)}">Conferir e aplicar ao Financeiro</button>` : ""}${i.tipoRelatorio === "NOVENTA_E_NOVE_FOOD_RELATORIO" && ["IMPORTADO", "IMPORTADO_COM_PENDENCIAS"].includes(i.estado) ? `<button type="button" class="botao-link" data-detalhe="relatorio-99food:${esc(i.id)}">Conferir e aplicar ao Financeiro</button>` : ""}`)}</tr>`;
  }).join("");
  const demos = d.canal === "IFOOD" ? (d.demonstrativos.length ? `<h4>Demonstrativos oficiais registrados</h4><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Demonstrativos oficiais do iFood</caption><thead><tr><th scope="col">Período</th><th scope="col">Faturamento</th><th scope="col">Comissões</th><th scope="col">Taxas</th><th scope="col">Ajustes</th><th scope="col">Repasse previsto</th><th scope="col">Repasse</th></tr></thead><tbody>
${d.demonstrativos.map((x) => `<tr>${td("Período", `${esc(dataBR(x.periodoInicio))} a ${esc(dataBR(x.periodoFim))}`, "esquerda")}${td("Faturamento", valor(x.brutoCentavos))}${td("Comissões", valor(x.comissoesCentavos))}${td("Taxas", valor(x.taxasCentavos))}${td("Ajustes", valor(x.ajustesCentavos))}${td("Repasse previsto", valor(x.repassePrevistoCentavos))}${td("Repasse", esc(REPASSE[x.situacaoRepasse] ?? x.situacaoRepasse))}</tr>`).join("")}</tbody></table></div>` : '<p class="nota">Nenhum demonstrativo oficial registrado.</p>') : "";
  return `<section class="card" aria-labelledby="t-hist-${esc(d.canal)}"><div class="card-topo"><h3 id="t-hist-${esc(d.canal)}">Histórico de importações ${esc(NOME_DO_CANAL[d.canal])}</h3><a class="botao-link" href="#/conferencias">Central de Importações e Conferências</a></div>
${d.historico.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Importações de arquivo de ${esc(NOME_DO_CANAL[d.canal])}</caption><thead><tr><th scope="col">Período</th><th scope="col">Relatório</th><th scope="col">Situação</th><th scope="col">Erros</th><th scope="col">Divergências</th><th scope="col">Já existentes</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>${linhas}</tbody></table></div>`
    : `<p class="nota vazio-lista">${d.canal === "IFOOD" ? "Nenhum arquivo importado. O iFood entra pelo demonstrativo oficial." : d.canal === "NOVENTA_E_NOVE_FOOD" ? "Nenhuma importação: ainda não há relatório oficial validado." : "Nenhum relatório SAIPOS importado."}</p>`}${demos}</section>`;
}

/** A seção "Importações" de um canal. `d` = resposta de /importacoes-canal; `erro` quando a consulta falhou. */
export function importacoesDoCanal(d, ctx = {}) {
  if (ctx.erro) return `<section class="card" aria-label="Importações"><h2>Importações</h2><p class="aviso aviso--alerta" role="alert">${esc(ctx.erro)}</p></section>`;
  if (!d) return "";
  return `<div class="imp-canal" data-importacoes-canal="${esc(d.canal)}"><h2>Importações ${esc(NOME_DO_CANAL[d.canal])}</h2>
${formatosDoCanal(d)}
${d.canal === "IFOOD" ? formularioDoDemonstrativo(d) : ""}
${formularioDeArquivo(d, ctx)}
${historico(d)}</div>`;
}

// ------------------------------------------------------------------------------------- painel: efeitos do relatório 99Food
/** `p` = resposta de /previa-relatorio-99food. A conta vem pronta do servidor. */
function vinculoDaLoja99Food(p, pode) {
  if (p.lojaVinculada) return `<p class="nota">Loja vinculada a esta unidade: ${esc(p.lojaVinculada.nome)} · ID ${esc(p.lojaVinculada.id)}.</p>`;
  if (!pode) return '<p class="aviso">A loja ainda não foi vinculada. Vincular exige a permissão "Configurar".</p>';
  return `<h3>Vincular a loja a esta unidade</h3><form class="acao" data-acao="/api/fv2/acoes/importacao/99food/vincular-loja" data-recarregar="lista"><input type="hidden" name="importacao" value="${esc(p.importacaoId)}">
<label>Digite o ID oficial da loja na 99Food <input type="text" name="lojaId" inputmode="numeric" maxlength="40" autocomplete="off" required></label>
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo que esta loja pertence a esta unidade.</label>
<button type="submit" class="botao">Vincular loja</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>`;
}
function correcaoDoDia99Food(c, pode) {
  const linha = (t, k) => `<tr>${td("Campo", esc(t), "esquerda")}${td("Versão efetiva", valor(c.vigente[k]))}${td("Versão recebida", valor(c.informado[k]))}</tr>`;
  const decidir = (decisao, rotulo) => `<form class="acao" data-acao="/api/fv2/acoes/importacao/99food/decidir-correcao" data-recarregar="lista"><input type="hidden" name="importacao" value="${esc(c.importacaoId)}"><input type="hidden" name="data" value="${esc(c.data)}"><input type="hidden" name="decisao" value="${decisao}">
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label><label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo esta decisão.</label><button type="submit" class="botao">${esc(rotulo)}</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>`;
  return `<h4>${esc(dataBR(c.data))}</h4><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Versões do dia ${esc(dataBR(c.data))}</caption><thead><tr><th scope="col">Campo</th><th scope="col">Versão efetiva</th><th scope="col">Versão recebida</th></tr></thead><tbody>${linha("Vendas de itens", "itensCentavos")}${linha("Taxas", "processamentoCentavos")}${linha("Comissões", "comissaoCentavos")}${linha("Marketing", "marketingCentavos")}${linha("Repasse", "repasseCentavos")}</tbody></table></div>${pode ? decidir("ADOTAR", "Adotar a versão recebida") + decidir("MANTER", "Manter a versão efetiva") : ""}`;
}

export function previaDoRelatorio99Food(p, { podeAplicar = false, podeVincular = false, podeDecidir = false } = {}) {
  const v = p.valores;
  const dre = [["Vendas de itens", v.vendasCentavos], ["Taxas de processamento", -v.processamentoCentavos], ["Comissões", -v.comissoesCentavos], ["Marketing", -v.marketingCentavos], ["Resultado gerencial preliminar", v.resultadoPreliminarCentavos]];
  const conferir = [["Recompensas da plataforma", v.recompensasCentavos], ["Receita de pedidos em oferta", v.receitaOfertaCentavos], ["Repasse informado", v.repasseInformadoCentavos]];
  const div = p.divergencias;
  const conf = p.conferenciaSaipos;
  const form = p.podeAplicar && podeAplicar ? `<form class="acao" data-acao="/api/fv2/acoes/importacao/99food/aplicar" data-recarregar="lista"><input type="hidden" name="importacao" value="${esc(p.importacaoId)}">
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>
${p.exigeAceiteDaDiferenca ? '<label class="caixa-marcar"><input type="checkbox" name="aceitarDiferencaDeRepasse" required> Entendo que as diferenças para o repasse informado ficam em conferência.</label>' : ""}
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Conferi os valores e autorizo lançar no Financeiro.</label>
<button type="submit" class="botao botao--primario">Aplicar ao Financeiro</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>` : "";
  const dias = p.valoresDiarios.map((d) => `<tr>${td("Dia", esc(dataBR(d.data)), "esquerda")}${td("Vendas", String(d.quantidade))}${td("Itens", valor(d.itensCentavos))}${td("Taxas", valor(d.processamentoCentavos))}${td("Comissões", valor(d.comissaoCentavos))}${td("Marketing", valor(d.marketingCentavos))}${td("Recompensas", valor(d.recompensasCentavos))}${td("Repasse", valor(d.repasseCentavos))}${td("Diferença", valor(d.diferencaRepasseCentavos))}</tr>`).join("");
  return `${fechar("Relatório 99Food: conferir antes de aplicar")}
<p class="nota">${esc(p.loja?.nome ?? "Loja")} · ${esc(p.loja?.cidade ?? "")} · ID ${esc(p.loja?.id ?? "—")}<br>${esc(dataBR(p.periodo.inicio))} a ${esc(dataBR(p.periodo.fim))} · ${p.dias} dia(s) · ${p.quantidade} venda(s). Nada foi gravado ainda.</p>
<h3>Entra na DRE</h3><dl class="ficha ficha--compacta">${dre.map(([t, c]) => `<dt>${esc(t)}</dt><dd>${valor(c)}</dd>`).join("")}</dl>
<h3>Fica em conferência</h3><dl class="ficha ficha--compacta">${conferir.map(([t, c]) => `<dt>${esc(t)}</dt><dd>${valor(c)}</dd>`).join("")}</dl>
<h3>Diferença entre o resultado preliminar e o repasse</h3><dl class="ficha ficha--compacta"><dt>Dias divergentes</dt><dd>${div.diasDivergentes}</dd><dt>Soma algébrica das diferenças</dt><dd>${valor(div.somaAlgebricaCentavos)}</dd><dt>Soma dos valores absolutos</dt><dd>${valor(div.somaAbsolutaCentavos)}</dd><dt>Situação</dt><dd>${esc(div.diasDivergentes ? "Pendente de conferência" : "Sem diferença")}</dd></dl>
<p class="nota">A diferença não é receita nem despesa. O relatório não informa data nem ciclo do repasse: nada vira recebível nem crédito no banco.</p>
${vinculoDaLoja99Food(p, podeVincular)}
${p.correcoesPendentes.length ? `<h3>Correções para decidir</h3>${p.correcoesPendentes.map((c) => correcaoDoDia99Food(c, podeDecidir)).join("")}` : ""}
<h3>Conferência com a SAIPOS</h3><p class="nota">${conf.diasComparados} dia(s) comparado(s) · ${conf.diasDivergentes.length} com diferença · ${conf.diasSemSaipos.length} sem pedidos 99Food na SAIPOS · ${conf.diasSoNaSaipos.length} só na SAIPOS.</p>
<h3>Valores por dia</h3><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Valores diários do relatório da 99Food</caption><thead><tr><th scope="col">Dia</th><th scope="col">Vendas</th><th scope="col">Itens</th><th scope="col">Taxas</th><th scope="col">Comissões</th><th scope="col">Marketing</th><th scope="col">Recompensas</th><th scope="col">Repasse</th><th scope="col">Diferença</th></tr></thead><tbody>${dias}</tbody></table></div>
${p.bloqueios.length ? `<h3>O que impede aplicar</h3>${lista(p.bloqueios.map((b) => `<li><span>${esc(b.mensagem)}</span></li>`))}` : ""}
${p.avisos.length ? `<h3>Avisos</h3>${lista(p.avisos.map((a) => `<li><span>${esc(a.mensagem)}</span></li>`))}` : ""}
<p class="nota">Lançamentos: ${p.lancamentos.criar} novo(s), ${p.lancamentos.manter} já aplicado(s), ${p.lancamentos.cancelar} a substituir.</p>${form}`;
}

// ------------------------------------------------------------------------------------- painel: efeitos da conciliação iFood
/** `p` = resposta de /previa-conciliacao-ifood. Só mostra: a conta vem pronta do servidor. */
function formularioDeClassificacao(x, categorias, pode) {
  const cabeca = `<p><strong>${esc(x.descricao)}</strong><br><span class="nota">${x.quantidade} lançamento(s) · ${esc(moeda(x.valorCentavos))}</span></p>`;
  if (!pode) return `${cabeca}<p class="nota">Classificar exige a permissão "Configurar".</p>`;
  const opcoes = categorias.filter((c) => (c.natureza === "RECEITA") === (x.valorCentavos > 0));
  return `${cabeca}<form class="acao" data-acao="/api/fv2/acoes/importacao/ifood-conciliacao/classificar" data-recarregar="lista"><input type="hidden" name="chave" value="${esc(x.chave)}">
<label>Categoria <select name="categoria" required><option value="">Escolha</option>${opcoes.map((c) => `<option value="${esc(c.codigo)}">${esc(c.nome)}</option>`).join("")}</select></label>
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo esta classificação.</label><button type="submit" class="botao">Classificar</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>`;
}

export function previaDaConciliacaoIfood(p, { podeAplicar = false, podeClassificar = false } = {}) {
  const v = p.valores;
  const linhas = [["Produtos", v.produtosCentavos], ["Entregas da loja", v.entregasCentavos], ["Faturamento", v.faturamentoCentavos], ["Promoções da loja", -v.promocoesLojaCentavos], ["Comissões", -v.comissoesCentavos], ["Taxa de transação", -v.taxaTransacaoCentavos], ["Entrega sob demanda", -v.entregaSobDemandaCentavos], ["Anúncios", -v.anunciosCentavos], ["Líquido", v.liquidoCentavos]];
  const conf = p.conferenciaSaipos;
  const form = p.podeAplicar && podeAplicar ? `<form class="acao" data-acao="/api/fv2/acoes/importacao/ifood-conciliacao/aplicar" data-recarregar="lista"><input type="hidden" name="importacao" value="${esc(p.importacaoId)}">
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Conferi os valores e autorizo lançar no Financeiro.</label>
<button type="submit" class="botao botao--primario">Aplicar ao Financeiro</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>` : "";
  return `${fechar("Conciliação iFood: conferir antes de aplicar")}
<p class="nota">${esc(dataBR(p.periodo.inicio))} a ${esc(dataBR(p.periodo.fim))} · ${p.pedidos} pedido(s) · ${p.movimentos} movimento(s). Nada foi gravado ainda.</p>
<dl class="ficha ficha--compacta">${linhas.map(([t, c]) => `<dt>${esc(t)}</dt><dd>${valor(c)}</dd>`).join("")}<dt>Repasse previsto</dt><dd>${valor(v.repassePrevistoCentavos)}</dd><dt>Pago direto à loja (já no faturamento)</dt><dd>${valor(v.recebidoDiretoCentavos)}</dd></dl>
<h3>Repasses previstos</h3>${lista(p.repasses.itens.map((r) => `<li><span>${esc(dataBR(r.dataPrevista))}<br><span class="nota">Apuração de ${esc(dataBR(r.apuracaoInicio))} a ${esc(dataBR(r.apuracaoFim))}</span></span>${valor(r.previstoCentavos)}</li>`))}
<h3>Conferência com a SAIPOS</h3><p class="nota">${conf.diasComparados} dia(s) comparado(s) · diferença em produtos: ${esc(moeda(conf.diferencaCentavos))} · fica pendente de conferência.</p>
${p.bloqueios.length ? `<h3>O que impede aplicar</h3>${lista(p.bloqueios.map((b) => `<li><span>${esc(b.mensagem)}</span></li>`))}` : ""}
${(p.pendenciasDeClassificacao ?? []).length ? `<h3>Classificar antes de aplicar</h3>${p.pendenciasDeClassificacao.map((x) => formularioDeClassificacao(x, p.categoriasPermitidas ?? [], podeClassificar)).join("")}` : ""}
${(p.avisos ?? []).length ? `<h3>Avisos</h3>${lista(p.avisos.map((a) => `<li><span>${esc(a.mensagem)}</span></li>`))}` : ""}
<p class="nota">Lançamentos: ${p.lancamentos.criar} novo(s), ${p.lancamentos.manter} já aplicado(s), ${p.lancamentos.cancelar} a substituir.</p>${form}`;
}

// ------------------------------------------------------------------------------------- painel: prévia do demonstrativo
/** `p` = resposta de /previa-demonstrativo-ifood; `params` = o que foi digitado (reenviado na confirmação). */
export function previaDoDemonstrativo(p, { params = {}, podeRegistrar = false } = {}) {
  if (!p?.valido) return `${fechar("Prévia do demonstrativo do iFood")}<p class="aviso aviso--erro" role="alert">${esc(p?.erro ?? "Não foi possível conferir os dados.")}</p><p class="nota">Corrija o formulário e confira a prévia de novo. Nada foi registrado.</p>`;
  const conta = p.fecha ? '<p class="aviso" role="status"><strong>✓ A conta fecha.</strong> Vendas − comissões − taxa de pagamento − mensalidade − serviços e promoções + ajustes = líquido informado.</p>'
    : `<p class="aviso aviso--erro" role="alert"><strong>✗ A conta não fecha.</strong> O líquido calculado é ${esc(moeda(p.liquidoCalculadoCentavos))} e o informado é ${esc(moeda(p.liquidoInformadoCentavos))} (diferença de ${esc(moeda(p.diferencaCentavos))}).</p>`;
  const oculto = ["periodoInicio", "periodoFim", "vendas", "comissoes", "taxaPagamento", "mensalidade", "servicosEPromocoes", "ajustes", "liquido", "origem", "justificativa"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] ?? "")}">`).join("");
  return `${fechar("Prévia do demonstrativo do iFood")}
<p class="nota">Nada foi registrado ainda. Confira e só então confirme.</p>
<dl class="ficha">
  <dt>Período coberto</dt><dd>${esc(dataBR(p.periodoInicio))} a ${esc(dataBR(p.periodoFim))}</dd>
  <dt>Faturamento</dt><dd>${valor(p.faturamentoCentavos)}</dd>
  <dt>Comissões</dt><dd>${valor(p.comissoesCentavos)}</dd>
  <dt>Taxas (pagamento online)</dt><dd>${valor(p.taxasCentavos)}</dd>
  <dt>Mensalidade</dt><dd>${valor(p.mensalidadeCentavos)}</dd>
  <dt>Serviços e promoções</dt><dd>${valor(p.servicosEPromocoesCentavos)}</dd>
  <dt>Ajustes</dt><dd>${valor(p.ajustesCentavos)}</dd>
  <dt>Líquido informado</dt><dd>${valor(p.liquidoInformadoCentavos)}</dd>
  <dt>Repasse previsto</dt><dd>${valor(p.repasse.previstoCentavos)} <span class="nota">até ${esc(dataBR(p.repasse.dataPrevista))}. ${esc(p.repasse.observacao)}</span></dd>
</dl>${conta}
${p.bloqueios.length ? `<h3>O que impede o registro</h3>${lista(p.bloqueios.map((x) => `<li><span>${esc(x.mensagem)}</span></li>`))}` : ""}
${p.jaRegistrado ? '<p class="aviso" role="status">Este demonstrativo já está registrado: confirmar de novo não duplica nada.</p>' : ""}
${p.pendencias.length ? `<h3>Pendências</h3>${lista(p.pendencias.map((x) => `<li><span>${esc(x.mensagem)}</span></li>`))}` : ""}
${p.podeConfirmar && podeRegistrar ? `<form class="acao acao--embutida" data-acao="/api/fv2/acoes/vendas/demonstrativo-ifood" data-recarregar="lista" aria-label="Confirmar o registro do demonstrativo">${oculto}
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo que conferi a prévia. O faturamento do iFood, as retenções e o repasse previsto serão registrados uma única vez.</label>
<button type="submit" class="botao botao--primario">Confirmar e registrar demonstrativo</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>`
    : `<p class="nota">${p.podeConfirmar ? 'Registrar exige a permissão "Registrar".' : "A confirmação está bloqueada até resolver o que foi apontado acima."}</p>`}`;
}
