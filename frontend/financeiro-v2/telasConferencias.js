// Central de Conferências (Execução 06C) — funções PURAS: dados das consultas → HTML escapado.
// Nenhuma fórmula financeira e nenhuma "prévia" própria: prévias, efeitos, pendências e impedimentos chegam prontos do
// núcleo. Códigos técnicos, hashes e JSON ficam só em seções recolhíveis "Detalhes técnicos".
// Ações (importar, aprovar, aplicar, conciliar) são formulários que chamam as operações REAIS do núcleo pela demonstração
// local; aparecem só para quem tem a permissão e sempre exigem confirmação explícita.
import {
  CONFIANCAS, EVENTOS, ESTADOS_COMPETENCIA, ESTADOS_IMPORTACAO, ESTADOS_PROPOSTA, FONTES_NOME, LINHAS_DRE, PERMISSOES, SITUACOES_CORRESPONDENCIA, SITUACOES_PENDENCIA,
  SITUACOES_SECAO, competencia, dataBR, esc, moeda,
} from "./formatar.js";
import { documentos, paginacao } from "./telasTesouraria.js";

export const SECOES = Object.freeze([["resumo", "Resumo"], ["pendencias", "Pendências"], ["documentos", "Documentos e importações"], ["propostas", "Propostas para revisão"], ["conciliacoes", "Conciliações"], ["fechamento", "Fechamento mensal"]]);
const ROTA = "conferencias";
const valor = (c) => `<span class="${c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor"}">${esc(c === null || c === undefined ? "—" : moeda(c))}</span>`;
const seloDe = (s) => (s ? `<span class="selo selo--${s.classe}"${s.explicacao ? ` title="${esc(s.explicacao)}"` : ""}>${esc(s.rotulo)}</span>` : "");
const td = (rotulo, conteudo, classe = "") => `<td data-rotulo="${esc(rotulo)}"${classe ? ` class="${classe}"` : ""}><span class="cel">${conteudo}</span></td>`;
const opcao = (v, rotulo, atual) => `<option value="${esc(v)}"${v === (atual ?? "") ? " selected" : ""}>${esc(rotulo)}</option>`;
const nenhum = (texto) => `<p class="nota vazio-lista">${esc(texto)}</p>`;
const fechar = (titulo) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(titulo)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar">×</button></div>`;
const botao = (tipo, id, texto) => `<button type="button" class="botao-link" data-detalhe="${esc(tipo)}:${esc(id)}">${esc(texto)}</button>`;
const tecnico = (obj) => `<details class="tecnico"><summary>Detalhes técnicos</summary><pre>${esc(JSON.stringify(obj, null, 2))}</pre></details>`;
const fonte = (f) => FONTES_NOME[f] ?? f ?? "—";
const periodo = (p) => (p ? (p.inicio === p.fim ? dataBR(p.inicio) : `${dataBR(p.inicio)} a ${dataBR(p.fim)}`) : "—");
const tem = (perm, acao) => (perm ?? []).includes(acao);

/** Formulário de AÇÃO: grava de verdade (pela demonstração local) e por isso exige a caixa de confirmação marcada. */
function acao({ url, rotulo, campos = "", aviso, recarregar, perigo = false }) {
  return `<form class="acao${perigo ? " acao--perigo" : ""}" data-acao="${esc(url)}"${recarregar ? ` data-recarregar="${esc(recarregar)}"` : ""}>
  ${campos}
  <label class="caixa-marcar"><input type="checkbox" name="confirmar" required> ${esc(aviso)}</label>
  <button type="submit" class="botao${perigo ? "" : " botao--primario"}">${esc(rotulo)}</button>
  <p class="resultado-acao" role="status" aria-live="polite"></p>
</form>`;
}

// ------------------------------------------------------------------------------------------------------- cabeçalho
export function central(r, f = {}, ctx = {}) {
  // 06D: as ações de fechamento recebem o contexto (permissões da sessão); a prévia vem do núcleo.
  const secao = f.secao ?? "resumo";
  const corpo = { resumo, pendencias, documentos: documentosImportados, propostas, conciliacoes, fechamento }[secao] ?? resumo;
  return `<div class="central"><header class="cabecalho"><div><h1>Importações e Conferências</h1><p class="subtitulo">${esc(competencia(ctx.competencia))} · ${esc(ctx.unidadeNome ?? "")} · posição em ${esc(dataBR(r.dataBase))}</p></div></header>
<nav class="abas abas--botoes" aria-label="Seções da Central de Conferências">${SECOES.map(([k, t]) => `<button type="button" data-secao="${k}"${k === secao ? ' aria-current="page"' : ""}>${esc(t)}</button>`).join("")}</nav>
${corpo(r, f, ctx)}</div>`;
}

// --------------------------------------------------------------------------------------------------------- resumo
function resumo(r, f, ctx) {
  const fe = r.fechamento;
  const p = r.pendencias;
  const grupos = Object.entries(p.porGrupo);
  return `<section class="card card--destaque" aria-labelledby="t-situacao">
  <div class="card-topo"><h2 id="t-situacao">Situação do fechamento</h2>${seloDe(ESTADOS_COMPETENCIA[fe.estado])}</div>
  <p>${fe.impedimentos ? `<strong class="valor--negativo">${fe.impedimentos} divergência(s) relevante(s) sem justificativa impedem a homologação.</strong>` : "Nenhuma divergência relevante sem justificativa."} ${fe.metodologia ? `Metodologia: ${esc(fe.metodologia)}.` : "Metodologia ainda não registrada."}</p>
  <p class="nota">${esc(r.materialidade.texto)}</p>
  <button type="button" class="botao-link" data-secao="fechamento">Ver fechamento mensal</button>
</section>
<section class="resumo" aria-label="Contagens da competência">
  <article class="card card--sec"><h3>Pendências a resolver</h3><p><span class="valor">${p.total}</span></p><p class="nota">${p.bloqueiam} bloqueia(m) a homologação · ${p.informativas} informativa(s). É uma contagem: valores de pendências diferentes não são somados.</p><button type="button" class="botao-link" data-secao="pendencias">Ver pendências</button></article>
  <article class="card card--sec"><h3>Importações aguardando revisão</h3><p><span class="valor">${r.importacoes.aguardandoRevisao}</span></p><button type="button" class="botao-link" data-secao="documentos">Ver documentos</button></article>
  <article class="card card--sec"><h3>Propostas pendentes</h3><p><span class="valor">${r.propostas.pendentes}</span></p><p class="nota">Aprovar não registra nada: só a aplicação cria o efeito.</p><button type="button" class="botao-link" data-secao="propostas">Revisar propostas</button></article>
  <article class="card card--sec"><h3>Conciliações candidatas</h3><p><span class="valor">${r.conciliacoes.candidatas}</span></p><p class="nota">Candidata não é conciliação.</p><button type="button" class="botao-link" data-secao="conciliacoes">Investigar</button></article>
</section>
<div class="duas-colunas">
<section class="card" aria-labelledby="t-certo"><h2 id="t-certo">O que está correto</h2>${r.oQueEstaCorreto.length ? `<ul class="lista-ok">${r.oQueEstaCorreto.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : nenhum("Ainda não há conferência concluída nesta competência.")}</section>
<section class="card" aria-labelledby="t-falta"><h2 id="t-falta">O que falta conferir</h2>
  <ul class="lista-simples">${grupos.map(([g, v]) => `<li><span>${esc(v.nome)}${v.bloqueiam ? ' <span class="selo selo--erro">bloqueia</span>' : ""}</span><span>${v.abertas ? `<a class="botao-link" href="#/conferencias?secao=pendencias&amp;grupo=${esc(g)}">${v.abertas} pendência(s)</a>` : '<span class="nota">nenhuma</span>'}</span></li>`).join("")}</ul>
</section>
</div>
<section class="card" aria-labelledby="t-docs"><h2 id="t-docs">Documentos da competência</h2>
  <ul class="lista-simples">${r.fontes.comDocumento.map((x) => `<li><span>${esc(x.nome)}</span><span class="selo selo--ok">importado (${esc(periodo(x.cobertura))})</span></li>`).join("")}${r.fontes.semDocumento.map((x) => `<li><span>${esc(x.nome)}</span><span class="selo selo--alerta">falta o documento</span></li>`).join("")}</ul>
</section>
${r.divergenciasRelevantes.length ? `<section class="card" aria-labelledby="t-div"><h2 id="t-div">O que impede o fechamento</h2><ul class="lista-simples">${r.divergenciasRelevantes.map((x) => `<li><span>${esc(x.mensagem)}</span>${valor(x.valorCentavos)}</li>`).join("")}</ul><p class="nota">A diferença fica registrada até ter explicação com justificativa; nenhum ajuste é criado para fechar valores.</p></section>` : ""}
<p class="nota">Faturamento da competência pela DRE: ${esc(moeda(r.faturamento.valorCentavos))}. ${esc(r.observacao)}</p>`;
}

// ----------------------------------------------------------------------------------------------------- pendências
function pendencias(r, f) {
  return `<form class="filtros-locais" data-filtro-local="${ROTA}" aria-label="Filtros de pendências">
  <input type="hidden" name="secao" value="pendencias">
  <label>Grupo <select name="grupo">${opcao("", "Todos", f.grupo)}${r.grupos.map((g) => opcao(g.grupo, `${g.nome} (${r.contagem.porGrupo[g.grupo].abertas})`, f.grupo)).join("")}</select></label>
  <label>Situação <select name="situacao">${opcao("", "Todas", f.situacao)}${opcao("A_RESOLVER", "A resolver (sem informativas)", f.situacao)}${Object.entries(SITUACOES_PENDENCIA).map(([k, v]) => opcao(k, v.rotulo, f.situacao)).join("")}</select></label>
  <button type="submit" class="botao">Aplicar</button>
</form>
<p class="nota">${r.contagem.total} pendência(s) a resolver · ${r.contagem.bloqueiam} bloqueia(m) a homologação · cada fato aparece uma única vez, em um grupo.</p>
${f.grupo === "CUSTOS_E_RATEIOS" ? `<p class="aviso">${esc(r.semMotor.CUSTOS_E_RATEIOS)}</p>` : ""}
<section class="card" aria-labelledby="t-pend"><h2 id="t-pend" class="sr">Lista de pendências</h2>
${r.itens.length ? `<ul class="pendencias-lista">${r.itens.map((p) => `<li class="pendencia${p.bloqueia ? " pendencia--bloqueia" : ""}">
  <div class="pendencia-topo"><strong>${esc(p.titulo)}</strong>${seloDe(SITUACOES_PENDENCIA[p.situacao])}${p.bloqueia ? '<span class="selo selo--erro">bloqueia</span>' : ""}</div>
  <p class="pendencia-motivo">${esc(p.motivo)}</p>
  <p class="nota">${esc(p.nomeDoGrupo)}${p.valorCentavos !== null ? ` · impacto ${esc(moeda(p.valorCentavos))}` : ""} · responsável: ${esc(p.responsavel ?? "não atribuído")}${p.outrosMotivos ? ` · +${p.outrosMotivos} motivo(s) ligado(s) ao mesmo fato` : ""}</p>
  ${botao("pendencia", p.chave, "Revisar")}</li>`).join("")}</ul>` : nenhum("Nenhuma pendência com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
</section>`;
}

export function detalhePendencia(d, ctx = {}) {
  const p = d.pendencia;
  return `${fechar(p.titulo)}
<p>${seloDe(SITUACOES_PENDENCIA[p.situacao])} <span class="selo selo--neutro">${esc(p.nomeDoGrupo)}</span>${p.efeitoNoFechamento === "BLOQUEIA" ? ' <span class="selo selo--erro">bloqueia a homologação</span>' : p.efeitoNoFechamento === "NAO_BLOQUEIA" ? ' <span class="selo selo--info">não bloqueia o fechamento</span>' : ""}</p>
<dl class="ficha">
  <dt>O que aconteceu</dt><dd>${esc(p.oQueAconteceu)}</dd>
  <dt>Origem da informação</dt><dd>${esc(fonte(p.origem))}</dd>
  <dt>Impacto financeiro</dt><dd>${p.valorCentavos !== null ? `${valor(p.valorCentavos)} — ` : ""}${esc(p.impacto)}</dd>
  <dt>Motivo da pendência</dt><dd>${esc(p.motivo)}</dd>
  <dt>Responsável</dt><dd>${d.atribuicao ? `${esc(d.atribuicao.responsavelId)}${d.atribuicao.responsavelEhVoce ? " (você)" : ""} · ${esc(SITUACOES_ATRIBUICAO[d.atribuicao.situacao] ?? d.atribuicao.situacao)}${d.atribuicao.dataRevisao ? ` · revisar em ${esc(dataBR(d.atribuicao.dataRevisao))}` : ""}` : "Nenhum responsável atribuído"}</dd>
</dl>
${responsavelDaPendencia(d, ctx)}
${p.outrosMotivos.length ? `<h3>Outros motivos sobre o mesmo fato</h3><ul class="mini">${p.outrosMotivos.map((x) => `<li>${esc(x.motivo)}</li>`).join("")}</ul>` : ""}
<h3>Documentos existentes</h3>${documentos(p.documentosExistentes)}
<h3>Documentos necessários</h3>${p.documentosNecessarios.length ? `<ul class="mini">${p.documentosNecessarios.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : nenhum("Nenhum documento adicional indicado.")}
<h3>O que pode ser feito</h3>${p.opcoes.length ? `<ul class="mini">${p.opcoes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : nenhum("Nenhuma ação: registro informativo.")}
<p class="nota">A pendência só deixa de existir com o documento ou a decisão registrada — nunca por hipótese.</p>
${ligacaoDaPendencia(p)}
${reclassificacaoDaPendencia(p)}
<h3>Histórico de decisões</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li><strong>${esc(EVENTOS[h.evento] ?? "Alteração registrada")}</strong> · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem decisões registradas.")}
${p.apontadoPor.length > 1 ? `<p class="nota">Este fato foi apontado por ${p.apontadoPor.length} conferências diferentes e conta uma única vez.</p>` : ""}
${tecnico({ chave: p.chave, codigo: p.codigo, referencia: p.referencia, apontadoPor: p.apontadoPor, outrosCodigos: p.outrosMotivos.map((x) => x.codigo), ...p.tecnico })}`;
}

const SITUACOES_ATRIBUICAO = Object.freeze({ ATRIBUIDA: "Atribuída", EM_ANALISE: "Em análise", AGUARDANDO_TERCEIRO: "Aguardando terceiro", CONCLUIDA: "Concluída (aguarda a causa sumir)" });

/** Responsável pela pendência: só pessoas com acesso real à unidade; reatribuir exige justificativa; tudo no histórico. */
function responsavelDaPendencia(d, ctx) {
  const pessoas = ctx.pessoas ?? [];
  const a = d.atribuicao;
  const historico = d.historicoDaAtribuicao?.length ? `<h4>Histórico da atribuição</h4><ol class="historico">${d.historicoDaAtribuicao.map((h) => `<li><strong>${esc(h.evento === "CRIACAO" ? "Atribuída" : "Atualizada")}</strong> · ${esc(dataBR(h.em))} · ${esc(h.por)}${h.responsavelAntes && h.responsavelAntes !== h.responsavelDepois ? ` · de ${esc(h.responsavelAntes)} para ${esc(h.responsavelDepois)}` : ""}${h.situacaoDepois ? ` · ${esc(SITUACOES_ATRIBUICAO[h.situacaoDepois] ?? h.situacaoDepois)}` : ""}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : "";
  const comentarios = a?.comentarios?.length ? `<h4>Comentários</h4><ul class="mini">${a.comentarios.map((c) => `<li>${esc(dataBR(c.em))}${c.porVoce ? " (você)" : ""}: ${esc(c.texto)}</li>`).join("")}</ul>` : "";
  if (!d.podeAtribuir) return `<h3>Responsável</h3>${comentarios}${historico}<p class="nota">Atribuir responsável exige a permissão "revisar propostas".</p>`;
  if (!pessoas.length) return `<h3>Responsável</h3>${comentarios}${historico}<p class="nota">Nenhuma pessoa com acesso a esta unidade disponível para atribuição.</p>`;
  const chave = `<input type="hidden" name="competencia" value="${esc(ctx.competencia ?? "")}"><input type="hidden" name="chave" value="${esc(d.pendencia.chave)}">`;
  return `<h3>Responsável</h3>
${acao({ url: "/api/fv2/acoes/pendencias/atribuir", rotulo: a ? "Atualizar atribuição" : "Atribuir responsável", aviso: "Confirmo a atribuição (não resolve a pendência).", recarregar: `pendencia:${d.pendencia.chave}`,
    campos: `${chave}<label>Responsável <select name="responsavel" required>${pessoas.map((x) => `<option value="${esc(x.perfil)}">${esc(x.nome)}</option>`).join("")}</select></label>
<label>Revisar em <input type="date" name="dataRevisao"></label><label>Comentário <input name="comentario" maxlength="500"></label>
<label>Justificativa${a ? " (obrigatória para trocar o responsável)" : ""} <input name="justificativa" maxlength="500"></label>` })}
${a ? acao({ url: "/api/fv2/acoes/pendencias/acompanhar", rotulo: "Registrar acompanhamento", aviso: "Confirmo o registro do acompanhamento.", recarregar: `pendencia:${d.pendencia.chave}`,
    campos: `${chave}<label>Situação <select name="situacao">${Object.entries(SITUACOES_ATRIBUICAO).map(([k, v]) => `<option value="${esc(k)}"${k === a.situacao ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label><label>Comentário (obrigatório para concluir) <input name="comentario" maxlength="500"></label>` }) : ""}
${comentarios}${historico}`;
}

/**
 * 08C — classificação pendente: abre a reclassificação do LANÇAMENTO; saída bancária sem natureza abre a explicação de por que
 * ela não é reclassificada (vincula-se a uma conta). A decisão e a prévia vêm do núcleo.
 */
function reclassificacaoDaPendencia(p) {
  const lancamento = p.codigo === "DESPESA_A_CLASSIFICAR" ? p.referencia?.id : p.codigo === "DESCONTO_A_CLASSIFICAR" ? p.tecnico?.lancamentoId : null;
  if (lancamento) return `<p class="ligacoes">${botao("reclassificacao", lancamento, "Revisar e reclassificar o lançamento")}</p>`;
  if (p.codigo === "SAIDA_SEM_CLASSIFICACAO" && p.referencia?.id) return `<p class="ligacoes">${botao("reclassificacao-mov", p.referencia.id, "Como classificar esta saída")}</p>`;
  return "";
}

const NATUREZA_TXT = Object.freeze({ RECEITA: "receita", DEDUCAO: "dedução da receita", DESPESA: "despesa", PATRIMONIAL: "patrimonial (fora do resultado)" });
const EFEITO_DRE_TXT = Object.freeze({ FORA_ATE_CLASSIFICAR: "fora da DRE até classificar", NA_LINHA_DA_CATEGORIA: "na linha da categoria", FORA_DO_RESULTADO: "fora do resultado (patrimonial)" });

/** 08C — reclassificação: origem, categoria atual, sugestão, evidência, prévia (do núcleo) e confirmação. Nunca simula sucesso. */
export function detalheReclassificacao(d) {
  if (d.caso === "MOVIMENTACAO_SEM_NATUREZA") {
    return `${fechar("Saída bancária sem natureza comprovada")}
<p>${esc(d.explicacao)}</p>
<dl class="ficha"><dt>Data</dt><dd>${esc(dataBR(d.movimentacao.data))}</dd><dt>Valor</dt><dd>${valor(d.movimentacao.valorCentavos)}</dd></dl>
<p class="nota">Nenhuma despesa é criada a partir da saída: o caminho é vincular a saída a uma conta a pagar com documento.</p>`;
  }
  const l = d.lancamento;
  const atual = d.categoriaAtual;
  const escolha = d.impacto?.categoriaNova?.codigo ?? "";
  const formPrevia = d.podeReclassificar ? `<form class="filtros-locais" data-previa-reclassificacao="${esc(l.id)}" aria-label="Escolher a nova categoria">
  <label>Nova categoria <select name="categoria" required>${opcao("", "Escolha…", escolha)}${d.categoriasPermitidas.map((c) => opcao(c.codigo, `${c.nome} — ${NATUREZA_TXT[c.natureza] ?? c.natureza}`, escolha)).join("")}</select></label>
  <button type="submit" class="botao">Ver prévia do impacto</button>
</form>` : `<p class="aviso aviso--alerta">${esc(d.motivoBloqueio ?? "Reclassificação indisponível.")}</p>`;
  return `${fechar("Reclassificar lançamento")}
<p><span class="selo selo--${atual.provisoria ? "alerta" : "neutro"}">${atual.provisoria ? "classificação provisória" : "categoria confirmada"}</span> <span class="selo selo--neutro">${esc(l.origem.nome)}</span> <span class="selo selo--neutro">competência ${esc(competencia(l.competencia))} · ${esc(ESTADOS_COMPETENCIA[d.competencia.estado]?.rotulo ?? d.competencia.estado)}</span></p>
<p>${esc(d.explicacao)}</p>
<dl class="ficha">
  <dt>Lançamento</dt><dd>${esc(l.descricao ?? "—")}</dd>
  <dt>Valor</dt><dd>${valor(l.valorCentavos)}</dd>
  <dt>Data</dt><dd>${esc(dataBR(l.data))}${l.canal ? ` · canal ${esc(l.canal)}` : " · sem canal"}</dd>
  <dt>Origem</dt><dd>${esc(l.origem.nome)}${l.fonte ? ` · ${esc(fonte(l.fonte))}` : ""}</dd>
  <dt>Classificação atual</dt><dd>${esc(atual.nome)} — ${esc(NATUREZA_TXT[atual.natureza] ?? atual.natureza)}</dd>
  <dt>Sugestão</dt><dd>${d.sugestao ? `${esc(d.sugestao.nome)} <span class="nota">(${esc(d.sugestao.motivo)})</span>` : "Nenhuma sugestão: a escolha é de uma pessoa, com evidência."}</dd>
</dl>
<h3>Evidências já vinculadas</h3>${documentos(d.evidencias)}
${d.exigeEvidenciaParaSairDaProvisoria ? '<p class="nota">Sair da classificação provisória exige documento (nota, boleto, contrato ou relatório do canal). Sem ele, a pendência continua aberta.</p>' : ""}
${formPrevia}
${d.impacto ? previaDeReclassificacao(d) : ""}
<h3>Histórico de reclassificações</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li><strong>${esc(h.de)} → ${esc(h.para)}</strong> · ${esc(dataBR(h.em))}${h.porVoce ? " (você)" : ""}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Nenhuma reclassificação registrada.")}
${tecnico({ caso: d.caso, versao: l.versao, categoria: atual.codigo, permitidas: d.categoriasPermitidas.length })}`;
}

function previaDeReclassificacao(d) {
  const i = d.impacto;
  const l = d.lancamento;
  const linhas = i.dre.linhasAlteradas;
  const tabela = linhas.length ? `<table class="tabela"><caption class="sr">Efeito na DRE</caption><thead><tr><th scope="col">Linha da DRE</th><th scope="col">Antes</th><th scope="col">Depois</th></tr></thead><tbody>${linhas.map((x) => `<tr>${td("Linha", esc(x.nome))}${td("Antes", valor(x.antesCentavos), "num")}${td("Depois", valor(x.depoisCentavos), "num")}</tr>`).join("")}</tbody></table>` : nenhum("Nenhuma linha da DRE muda (a natureza e a linha continuam as mesmas).");
  const exigeDoc = i.exigeEvidencia && !i.evidenciaDisponivel;
  const docs = d.documentosDisponiveis;
  const rotuloDoc = (x) => `${x.descricao ?? x.tipo ?? "Documento"}${x.recebidoEm ? ` · ${dataBR(x.recebidoEm)}` : ""}`;
  let campoDoc = "";
  if (exigeDoc && docs.length) campoDoc = `<label>Evidência (documento existente) <select name="documento" required>${opcao("", "Escolha o documento…", "")}${docs.map((x) => opcao(x.referencia, rotuloDoc(x), "")).join("")}</select></label>`;
  else if (exigeDoc) campoDoc = '<p class="aviso aviso--alerta">Nenhum documento disponível nesta competência. Registre a evidência no cofre antes: sem ela a classificação continua pendente.</p>';
  else if (docs.length) campoDoc = `<label>Vincular evidência (opcional) <select name="documento">${opcao("", "Nenhum documento novo", "")}${docs.map((x) => opcao(x.referencia, rotuloDoc(x), "")).join("")}</select></label>`;
  const podeEnviar = !(exigeDoc && !docs.length);
  const titulos = i.titulos.length ? i.titulos.map((t) => `${esc(t.descricao ?? "Conta")}: saldo ${valor(t.saldoCentavos)} (não muda) · ${esc(EFEITO_DRE_TXT[t.efeitoNaDreAntes] ?? t.efeitoNaDreAntes)} → ${esc(EFEITO_DRE_TXT[t.efeitoNaDreDepois] ?? t.efeitoNaDreDepois)}`).join("<br>") : "Sem conta a pagar ligada a este lançamento.";
  const canais = i.canais.alterados.length ? i.canais.alterados.map((c) => `${esc(c.canal)}: ${valor(c.antesCentavos)} → ${valor(c.depoisCentavos)}`).join("<br>") : esc(i.canais.observacao);
  return `<section class="card" aria-labelledby="t-previa"><h3 id="t-previa">Prévia do impacto (nada foi gravado)</h3>
<dl class="ficha">
  <dt>Valor original</dt><dd>${valor(i.valorCentavos)}</dd>
  <dt>Competência</dt><dd>${esc(competencia(i.competencia))}</dd>
  <dt>Categoria anterior</dt><dd>${esc(d.categoriaAtual.nome)} — ${esc(NATUREZA_TXT[i.categoriaAnterior.natureza] ?? i.categoriaAnterior.natureza)}</dd>
  <dt>Categoria nova</dt><dd>${esc(i.categoriaNova.nome)} — ${esc(NATUREZA_TXT[i.categoriaNova.natureza] ?? i.categoriaNova.natureza)}</dd>
  <dt>Caixa e bancos</dt><dd>${esc(i.caixa.explicacao)}</dd>
  <dt>Composição por canal</dt><dd>${canais}</dd>
  <dt>Contas a pagar</dt><dd>${titulos}</dd>
  <dt>Impedimentos do fechamento</dt><dd>${i.impedimentos.quantidadeAntes} → ${i.impedimentos.quantidadeDepois}</dd>
</dl>
<h4>Efeito na DRE</h4>${tabela}
<h4>Pendências que permanecem</h4>${i.pendenciasQuePermanecem.length ? `<ul class="mini">${i.pendenciasQuePermanecem.map((x) => `<li>${esc(x.mensagem)}</li>`).join("")}</ul>` : nenhum("Nenhum impedimento de homologação restaria nesta competência.")}
${podeEnviar ? acao({ url: "/api/fv2/acoes/reclassificar", rotulo: "Confirmar reclassificação", recarregar: `reclassificacao:${l.id}`,
    campos: `<input type="hidden" name="lancamento" value="${esc(l.id)}"><input type="hidden" name="categoria" value="${esc(i.categoriaNova.codigo)}"><input type="hidden" name="versaoEsperada" value="${esc(String(l.versao))}">
${campoDoc}<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>`,
    aviso: "Confirmo a reclassificação: a categoria muda; o valor e o fato econômico não mudam." }) : ""}
<p class="nota">Ao confirmar, o servidor confere de novo a permissão, a versão do lançamento e a competência. Se o lançamento mudou depois desta prévia, nada é gravado.</p>
</section>`;
}

/** Ligação real para o registro da pendência (quando existe uma tela para ele); senão, nada — nunca link falso. */
function ligacaoDaPendencia(p) {
  const r = p.referencia;
  if (!r?.id) return "";
  const mapa = { PROPOSTA: ["proposta", "Abrir a proposta"], CORRESPONDENCIA: ["correspondencia", "Abrir a correspondência"], IMPORTACAO: ["documento", "Abrir o documento"], VENDA: ["venda", "Abrir a venda"], AGREGADO_DIARIO: ["venda", "Abrir o total do dia"], RECEBIVEL: ["recebimento", "Abrir o ciclo do recebimento"], OBRIGACAO: ["pagar", "Abrir a conta a pagar"] };
  const alvo = mapa[r.tipo];
  return alvo ? `<p class="ligacoes">${botao(alvo[0], r.id, alvo[1])}</p>` : "";
}

// ---------------------------------------------------------------------------------------------- documentos e prévias
function documentosImportados(r, f, ctx) {
  return `<form class="filtros-locais" data-filtro-local="${ROTA}" aria-label="Filtros de documentos">
  <input type="hidden" name="secao" value="documentos">
  <label>Situação <select name="estado">${opcao("", "Todas", f.estado)}${Object.entries(ESTADOS_IMPORTACAO).map(([k, v]) => opcao(k, v.rotulo, f.estado)).join("")}</select></label>
  <button type="submit" class="botao">Aplicar</button>
  ${tem(ctx.permissoes, "financeiro_v2.importar") ? '<button type="button" class="botao botao--primario" data-detalhe="importar:catalogo">Importar arquivo sintético</button>' : '<span class="nota">Importar exige a permissão "importar arquivos".</span>'}
</form>
<section class="card" aria-labelledby="t-docs-lista"><h2 id="t-docs-lista" class="sr">Documentos importados</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Documentos importados</caption><thead><tr><th scope="col" class="esquerda">Documento</th><th scope="col">Período</th><th scope="col">Recebido</th><th scope="col">Registros</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((x) => `<tr>${td("Documento", `<strong>${esc(x.relatorio)}</strong><br><span class="nota">${esc(fonte(x.fonte))} · versão ${x.versao}${x.substituiOutra ? " · substitui outra versão" : ""}${x.substituidaPorOutra ? " · substituída" : ""} · ${esc(x.responsavel)}</span><br>${x.compatibilidade.homologado ? '<span class="selo selo--ok">leitor homologado</span>' : '<span class="selo selo--alerta" title="' + esc(x.compatibilidade.texto) + '">leitor não homologado</span>'}`, "esquerda")}${td("Período", esc(periodo(x.periodo)))}${td("Recebido", `${esc(dataBR(x.recebidoEm))}${x.importadoEm ? `<br><span class="nota">importado ${esc(dataBR(x.importadoEm))}</span>` : ""}`)}${td("Registros", `${x.registrosAtivos}${x.divergencias ? `<br><span class="nota">${x.divergencias} divergência(s)</span>` : ""}${x.erros ? `<br><span class="nota valor--negativo">${x.erros} erro(s)</span>` : ""}`)}${td("Situação", seloDe(ESTADOS_IMPORTACAO[x.estado]))}${td("Ações", botao("documento", x.id, "Ver prévia"))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhum documento importado nesta competência.")}
${paginacao(r.paginacao, ROTA)}
</section>
<details class="card"><summary><h2 class="inline">Leitores e formatos homologados</h2></summary>
<ul class="lista-simples">${r.compatibilidade.map((x) => `<li><span>${esc(x.relatorio)} (${esc(fonte(x.fonte))})</span><span>${x.homologado ? `<span class="selo selo--ok">homologado: ${esc(x.formatosHomologados.join(", ").toUpperCase())}</span>` : '<span class="selo selo--alerta">sem amostra real conferida</span>'}</span></li>`).join("")}</ul>
<p class="nota">Outras variantes de arquivo só passam a valer depois de comprovadas com amostra real.</p></details>`;
}

export function detalheDocumento(d, ctx = {}) {
  const doc = d.documento;
  const pv = d.previa;
  const podeImportar = tem(ctx.permissoes, "financeiro_v2.importar");
  return `${fechar(`${doc.relatorio} — ${periodo(doc.periodo)}`)}
<p>${seloDe(ESTADOS_IMPORTACAO[doc.estado])} ${doc.compatibilidade.homologado ? '<span class="selo selo--ok">leitor homologado</span>' : '<span class="selo selo--alerta">leitor não homologado</span>'}</p>
<dl class="ficha">
  <dt>Relatório</dt><dd>${esc(doc.relatorio)} · ${esc(fonte(doc.fonte))}</dd>
  <dt>Período</dt><dd>${esc(periodo(doc.periodo))}</dd>
  <dt>Recebido em</dt><dd>${esc(dataBR(doc.recebidoEm))} · ${esc(doc.responsavel)}</dd>
  <dt>Versão</dt><dd>${doc.versao}${doc.substituiOutra ? " (substitui a anterior)" : ""}${doc.substituidaPorOutra ? " (substituída por outra versão)" : ""}</dd>
</dl>
<h3>Prévia do motor de importação</h3>
${pv ? `<ul class="lista-simples">
  <li><span>Registros válidos (novos)</span><strong>${pv.validos ?? "—"}</strong></li>
  <li><span>Rejeitados (erros)</span><strong>${pv.rejeitados}</strong></li>
  <li><span>Duplicados no próprio arquivo</span><strong>${pv.duplicadosNoArquivo}</strong></li>
  <li><span>Já existentes (importados antes)</span><strong>${pv.jaExistentes}</strong></li>
  <li><span>Conflitos com o já importado</span><strong>${pv.conflitos}</strong></li>
  <li><span>Divergências</span><strong>${pv.totalDivergencias}</strong></li>
</ul>
${pv.erros.length ? `<h4>Erros</h4><ul class="mini">${pv.erros.slice(0, 20).map((x) => `<li>${esc(x.mensagem ?? x.codigo ?? "Erro de leitura")}</li>`).join("")}</ul>` : ""}
${pv.divergencias.length ? `<h4>Divergências</h4><ul class="mini">${pv.divergencias.slice(0, 20).map((x) => `<li>${esc(x.mensagem)}</li>`).join("")}</ul>` : ""}
${totais(pv.controles)}` : nenhum("Ainda sem prévia.")}
<h3>Limitações</h3><ul class="mini">${d.limitacoes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
${d.relatorio ? `<h3>Resultado da importação</h3><p>${d.relatorio.inseridos} registro(s) gravado(s) · ${d.relatorio.jaImportados} já existente(s) · ${d.relatorio.divergencias} divergência(s). ${esc(d.relatorio.observacao ?? "")}</p>` : ""}
${Object.keys(d.propostasGeradas).length ? `<p class="nota">Propostas geradas: ${Object.entries(d.propostasGeradas).map(([k, v]) => `${v} ${esc((ESTADOS_PROPOSTA[k]?.rotulo ?? k).toLowerCase())}`).join(", ")}.</p>` : ""}
${d.acoes.confirmar && podeImportar ? acao({
    url: "/api/fv2/acoes/importacao/confirmar", rotulo: "Confirmar importação", recarregar: `documento:${doc.id}`,
    campos: `<input type="hidden" name="importacao" value="${esc(doc.id)}"><input type="hidden" name="impressaoPrevia" value="${esc(d.impressaoPrevia ?? "")}">${d.acoes.exigeAceiteDePendencias ? '<label class="caixa-marcar"><input type="checkbox" name="aceitarPendencias"> Aceito importar com as divergências acima</label><label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label>' : ""}`,
    aviso: "Confirmo que revisei a prévia. Os registros serão gravados sem efeito financeiro (importar ≠ aprovar ≠ aplicar).",
  }) : ""}
${d.acoes.confirmar && podeImportar ? acao({ url: "/api/fv2/acoes/importacao/rejeitar", rotulo: "Rejeitar arquivo", recarregar: `documento:${doc.id}`, perigo: true, campos: `<input type="hidden" name="importacao" value="${esc(doc.id)}"><label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label>`, aviso: "Confirmo a rejeição deste arquivo." }) : ""}
${d.acoes.gerarPropostas && tem(ctx.permissoes, "financeiro_v2.registrar") ? acao({ url: "/api/fv2/acoes/propostas/gerar", rotulo: "Gerar propostas para revisão", recarregar: `documento:${doc.id}`, campos: `<input type="hidden" name="importacao" value="${esc(doc.id)}">`, aviso: "Confirmo: propostas são só sugestões; nada entra no financeiro até ser aprovado E aplicado." }) : ""}
${!podeImportar && d.acoes.confirmar ? `<p class="nota">Confirmar exige a permissão "${esc(PERMISSOES[d.acoes.permissaoExigida])}".</p>` : ""}
<h3>Histórico</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li>${esc(ESTADOS_IMPORTACAO[h.estado]?.rotulo ?? h.evento)} · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico.")}
${tecnico({ registrosPorTipo: d.registrosPorTipo, amostra: pv?.amostra ?? [], controles: pv?.controles ?? null })}`;
}

/** "acumuladoFinalCentavos" → "Acumulado final" (só apresentação do nome do totalizador). */
const rotuloDoControle = (k) => { const t = k.replace(/Centavos$/, "").replace(/([A-Z])/g, " $1").toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const NOME_CONTROLE = { linhasLidas: "Linhas lidas", totalDeclaradoCentavos: "Total declarado no arquivo", totalCalculadoCentavos: "Total somado das linhas", registros: "Registros" };
function totais(controles) {
  if (!controles) return "";
  const linhas = Object.entries(controles).filter(([, v]) => typeof v === "number" || v === null);
  if (!linhas.length) return "";
  return `<h4>Totalizadores do documento</h4><ul class="lista-simples">${linhas.map(([k, v]) => `<li><span>${esc(NOME_CONTROLE[k] ?? rotuloDoControle(k))}</span>${/Centavos$/.test(k) ? valor(v) : `<strong>${esc(v ?? "—")}</strong>`}</li>`).join("")}</ul>`;
}

/** Passo 1 do fluxo local: escolher um arquivo SINTÉTICO do catálogo e enviá-lo ao cofre (gera a prévia). */
export function escolherArquivo(c) {
  return `${fechar("Importar arquivo sintético")}
<p class="aviso">${esc(c.observacao)}</p>
<ol class="passos"><li>Escolher o arquivo</li><li>Receber no cofre e validar</li><li>Revisar a prévia</li><li>Confirmar a importação</li></ol>
${acao({
    url: "/api/fv2/acoes/importacao/receber", rotulo: "Enviar ao cofre e gerar a prévia", recarregar: "resultado:documento",
    campos: `<fieldset class="escolha"><legend>Arquivo</legend>${c.arquivos.map((a, i) => `<label class="opcao-arquivo"><input type="radio" name="arquivo" value="${esc(a.id)}"${i === 0 ? " checked" : ""} required> <span><strong>${esc(a.nome)}</strong><br><span class="nota">${esc(fonte(a.fonte))} · ${esc(periodo({ inicio: a.periodoInicio, fim: a.periodoFim }))} · leitor: ${esc(a.leitor)}</span></span></label>`).join("")}</fieldset>`,
    aviso: "Confirmo o envio deste arquivo sintético ao cofre da demonstração (nada entra no financeiro neste passo).",
  })}`;
}

// --------------------------------------------------------------------------------------------------------- propostas
function propostas(r, f) {
  return `<form class="filtros-locais" data-filtro-local="${ROTA}" aria-label="Filtros de propostas">
  <input type="hidden" name="secao" value="propostas">
  <label>Situação <select name="estado">${opcao("", "Todas", f.estado)}${Object.entries(ESTADOS_PROPOSTA).map(([k, v]) => opcao(k, `${v.rotulo}${r.porEstado[k] ? ` (${r.porEstado[k]})` : ""}`, f.estado)).join("")}</select></label>
  <button type="submit" class="botao">Aplicar</button>
</form>
<p class="nota">Propostas são sugestões formadas a partir dos arquivos importados. Aprovar não grava nada; aplicar uma proposta aprovada cria o efeito uma única vez.</p>
<section class="card" aria-labelledby="t-prop"><h2 id="t-prop" class="sr">Propostas</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Propostas para revisão</caption><thead><tr><th scope="col">Data</th><th scope="col" class="esquerda">Operação</th><th scope="col">Valor</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((p) => `<tr>${td("Data", esc(dataBR(p.data)))}${td("Operação", `<strong>${esc(p.nome)}</strong><br><span class="nota">${esc(p.origem)} · ${esc(p.natureza)}${p.categoriaSugerida ? ` · sugere ${esc(p.categoriaSugerida.nome)}` : ""}</span>${p.pendencias.length ? `<br><span class="nota valor--negativo">${esc(p.pendencias[0])}</span>` : ""}`, "esquerda")}${td("Valor", valor(p.valorCentavos))}${td("Situação", `${seloDe(ESTADOS_PROPOSTA[p.estado])}<br><span class="nota">${esc(CONFIANCAS[p.confianca] ?? "")} · ${p.documentos.length ? "com documento" : "sem documento"}</span>`)}${td("Ações", botao("proposta", p.id, "Revisar"))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhuma proposta com estes filtros.")}
${paginacao(r.paginacao, ROTA)}
</section>`;
}

const efeito = (lista, vazio) => (lista.length ? `<ul class="lista-simples">${lista.map((x) => `<li><span>${esc(x.texto)}${x.linha ? `<br><span class="nota">${esc(LINHAS_DRE[x.linha] ?? (x.linha === "FATURAMENTO_BRUTO_PROPRIO" ? "Faturamento bruto próprio" : x.linha))}</span>` : ""}${x.fracao ? `<br><span class="nota">exato R$ ${esc(x.fracao.exatoReais)} → ${esc(moeda(x.fracao.registradoCentavos))} (metade para cima)</span>` : ""}</span>${x.valorCentavos !== null && x.valorCentavos !== undefined ? valor(x.valorCentavos) : ""}</li>`).join("")}</ul>` : nenhum(vazio));

export function detalheProposta(d) {
  const p = d.proposta;
  const a = d.autorizacao;
  return `${fechar(p.nome)}
<p>${seloDe(ESTADOS_PROPOSTA[p.estado])} <span class="selo selo--neutro">${esc(CONFIANCAS[p.confianca] ?? "")}</span></p>
<h3>1. O que será registrado</h3><p>${esc(d.oQueSeraRegistrado.texto)}${d.oQueSeraRegistrado.valorCentavos !== null ? ` ${valor(d.oQueSeraRegistrado.valorCentavos)}` : ""}${d.oQueSeraRegistrado.data ? ` <span class="nota">(${esc(dataBR(d.oQueSeraRegistrado.data))})</span>` : ""}</p>
<h3>2. Por que o sistema sugeriu</h3><p>${esc(d.porQue ?? "—")}</p>
<h3>3. Documento que sustenta</h3>${documentos(d.documentos)}
<h3>4. Efeito na DRE</h3>${efeito(d.efeitoNaDre, "Nenhum efeito na DRE.")}
<h3>5. Efeito em recebíveis ou obrigações</h3>${efeito(d.efeitoEmTitulos, "Nenhum título criado.")}
<h3>6. Efeito no caixa</h3>${efeito(d.efeitoNoCaixa, "Nenhum movimento de caixa.")}
<h3>7. Dados pendentes</h3>${d.pendentes.length ? `<ul class="mini">${d.pendentes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : nenhum("Nenhum dado pendente.")}
<h3>8. Possíveis conflitos</h3>${d.conflitos.length ? `<ul class="mini">${d.conflitos.map((x) => `<li>${esc(x.mensagem)}</li>`).join("")}</ul>` : nenhum("Nenhuma operação existente em conflito.")}
<h3>9. Autorização exigida</h3>
<p>Aprovar e rejeitar exigem a permissão "${esc(PERMISSOES[a.aprovar.permissao] ?? a.aprovar.permissao)}" (${a.aprovar.voceTem ? "você tem" : "você não tem: as ações não aparecem"}). Aplicar uma proposta aprovada exige "${esc(PERMISSOES[a.aplicar.permissao] ?? a.aplicar.permissao)}" (${a.aplicar.voceTem ? "você tem" : "você não tem"}).</p>
<p class="aviso">${esc(a.observacao)}</p>
${a.aprovar.disponivel && a.aprovar.voceTem ? acao({ url: "/api/fv2/acoes/propostas/aprovar", rotulo: "Aprovar (não registra nada)", recarregar: `proposta:${p.id}`, campos: `<input type="hidden" name="proposta" value="${esc(p.id)}">${a.aprovar.exigeJustificativa ? '<label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label>' : '<label>Justificativa (opcional) <input type="text" name="justificativa" maxlength="300"></label>'}`, aviso: "Confirmo que revisei o efeito acima." }) : ""}
${a.aplicar.disponivel && a.aplicar.voceTem ? acao({ url: "/api/fv2/acoes/propostas/aplicar", rotulo: "Aplicar: registrar o efeito", recarregar: `proposta:${p.id}`, campos: `<input type="hidden" name="proposta" value="${esc(p.id)}">`, aviso: "Confirmo: o efeito será gravado agora, numa única transação." }) : ""}
${a.rejeitar.disponivel && a.rejeitar.voceTem ? acao({ url: "/api/fv2/acoes/propostas/rejeitar", rotulo: "Rejeitar proposta", recarregar: `proposta:${p.id}`, perigo: true, campos: `<input type="hidden" name="proposta" value="${esc(p.id)}"><label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label>`, aviso: "Confirmo a rejeição." }) : ""}
<h3>10. Histórico</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li>${esc(ESTADOS_PROPOSTA[h.estado]?.rotulo ?? h.evento)} · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico.")}
${tecnico(d.tecnico)}`;
}

// ------------------------------------------------------------------------------------------------------ conciliações
const lado = (l, titulo) => `<div class="lado"><h4>${esc(titulo)} <span class="nota">(${l.total} registro(s) · ${esc(moeda(l.valorCentavos))})</span></h4><ul class="mini">${l.itens.map((x) => `<li><strong>${esc(x.natureza)}</strong> · ${esc(fonte(x.fonte))} · ${esc(dataBR(x.data))} · ${esc(moeda(x.valorCentavos))}${x.identificador ? `<br>${esc(x.identificador)}` : ""}</li>`).join("")}${l.total > l.itens.length ? `<li>e mais ${l.total - l.itens.length}.</li>` : ""}</ul></div>`;

function conciliacoes(r, f, ctx) {
  return `<form class="filtros-locais" data-filtro-local="${ROTA}" aria-label="Filtros de conciliações">
  <input type="hidden" name="secao" value="conciliacoes">
  <label>Situação <select name="situacao">${opcao("", "Todas", f.situacao)}${Object.entries(SITUACOES_CORRESPONDENCIA).map(([k, v]) => opcao(k, `${v.rotulo}${r.porSituacao[k] ? ` (${r.porSituacao[k]})` : ""}`, f.situacao)).join("")}</select></label>
  <button type="submit" class="botao">Aplicar</button>
</form>
${tem(ctx.permissoes, "financeiro_v2.conciliar") ? acao({ url: "/api/fv2/acoes/conciliacoes/gerar", rotulo: "Procurar candidatas SAIPOS × Stone", recarregar: "lista", campos: `<input type="hidden" name="competencia" value="${esc(ctx.competencia)}">`, aviso: "Confirmo: candidatas são sugestões; nenhuma é confirmada automaticamente." }) : ""}
<p class="nota">Uma correspondência por valor e data é só candidata. Confirmar exige que os lados fechem e que nenhuma outra candidata dispute os mesmos registros.</p>
<section class="card" aria-labelledby="t-conc"><h2 id="t-conc" class="sr">Correspondências</h2>
${r.itens.length ? `<ul class="correspondencias">${r.itens.map((c) => `<li class="correspondencia">
  <div class="pendencia-topo"><strong>${esc(c.nome)}</strong>${seloDe(SITUACOES_CORRESPONDENCIA[c.situacao])}<span class="selo selo--${c.confiabilidade === "FORTE" ? "ok" : c.confiabilidade === "FRACA" ? "alerta" : "neutro"}">${c.confiabilidade === "FORTE" ? "evidência forte" : c.confiabilidade === "FRACA" ? "só valor e data" : "manual"}</span>${c.ambigua ? '<span class="selo selo--erro">ambígua</span>' : ""}</div>
  <div class="lados">${lado(c.ladoA, "Lado A")}${lado(c.ladoB, "Lado B")}</div>
  <p class="nota">Critério: ${esc(c.criterio)} · diferença ${esc(moeda(c.diferencaCentavos))}</p>
  ${botao("correspondencia", c.id, "Investigar")}</li>`).join("")}</ul>` : nenhum("Nenhuma correspondência nesta competência.")}
${paginacao(r.paginacao, ROTA)}
</section>`;
}

export function detalheCorrespondencia(d) {
  const c = d.correspondencia;
  return `${fechar(c.nome)}
<p>${seloDe(SITUACOES_CORRESPONDENCIA[c.situacao])}${c.ambigua ? ` <span class="selo selo--erro">ambígua: ${c.concorrentes} outra(s) candidata(s) disputam os mesmos registros</span>` : ""}</p>
<div class="lados">${lado(c.ladoA, "Lado A")}${lado(c.ladoB, "Lado B")}</div>
<dl class="ficha">
  <dt>Critério</dt><dd>${esc(c.criterio)}</dd>
  <dt>Confiabilidade</dt><dd>${esc(c.confiabilidadeTexto)}</dd>
  <dt>Diferença</dt><dd>${valor(c.diferencaCentavos)}</dd>
  ${c.decisao ? `<dt>Decisão</dt><dd>${esc(c.decisao)}</dd>` : ""}
</dl>
<h3>Evidências</h3>${documentos(c.evidencias)}
${c.podeConfirmar && c.voceTemPermissao ? acao({ url: "/api/fv2/acoes/conciliacoes/confirmar", rotulo: "Confirmar conciliação", recarregar: `correspondencia:${c.id}`, campos: `<input type="hidden" name="correspondencia" value="${esc(c.id)}"><label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label>`, aviso: "Confirmo que as evidências provam o mesmo dinheiro nos dois lados." })
    : `<p class="nota">${esc(c.motivoDeNaoConfirmar ?? (c.voceTemPermissao ? "" : "Confirmar exige a permissão \"conciliar\"."))}</p>`}
<h3>Histórico</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li>${esc(SITUACOES_CORRESPONDENCIA[h.situacao]?.rotulo ?? h.evento)} · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico.")}
${tecnico({ relacao: c.relacao, situacao: c.situacao, confiabilidade: c.confiabilidade, concorrentes: c.concorrentes })}`;
}

// -------------------------------------------------------------------------------------------------------- fechamento
function fechamento(r, _f, ctx = {}) {
  return `<section class="card card--destaque" aria-labelledby="t-fech">
  <div class="card-topo"><h2 id="t-fech">Fechamento de ${esc(competencia(r.competencia))}</h2>${seloDe(ESTADOS_COMPETENCIA[r.estado])}</div>
  <ol class="etapas-fechamento">${r.etapas.map((e) => `<li class="${e.atual ? "atual" : e.concluida ? "concluida" : ""}"${e.atual ? ' aria-current="step"' : ""}>${esc(ESTADOS_COMPETENCIA[e.estado].rotulo)}</li>`).join("")}</ol>
  <dl class="ficha">
    <dt>Metodologia em vigor</dt><dd>${esc(r.metodologia ?? "Ainda não registrada")}</dd>
    <dt>Responsável</dt><dd>${esc(r.responsavel ?? "Nenhuma decisão registrada")}${r.decididoEm ? ` · ${esc(dataBR(r.decididoEm))}` : ""}</dd>
    <dt>Revisões</dt><dd>${r.revisoes}</dd>
  </dl>
  <p class="${r.homologacao.possivel ? "nota" : "aviso aviso--alerta"}"><strong>Homologação:</strong> ${esc(r.homologacao.motivo)} Nunca é automática.</p>
  <p class="nota">${esc(r.materialidade.texto)}</p>
</section>
<section class="card" aria-labelledby="t-imped"><h2 id="t-imped">Impedimentos de homologação</h2>
${r.impedimentos.length ? `<ul class="lista-simples">${r.impedimentos.map((x) => `<li><span>${esc(x.mensagem)}</span>${valor(x.valorCentavos)}</li>`).join("")}</ul>` : nenhum("Nenhuma divergência relevante sem justificativa.")}
${r.exigemDocumentacao ? `<p class="nota">${r.exigemDocumentacao} pendência(s) precisam estar documentadas no fechamento. <a class="botao-link" href="#/conferencias?secao=pendencias&amp;situacao=A_RESOLVER">Ver pendências</a></p>` : ""}
</section>
<section class="card" aria-labelledby="t-secoes"><h2 id="t-secoes">Conferência por assunto</h2>
<ul class="secoes-fechamento">${r.secoes.map((s) => `<li><div class="pendencia-topo"><strong>${esc(s.nome)}</strong>${seloDe(SITUACOES_SECAO[s.situacao])}</div><p class="nota">${esc(s.resumo)}</p></li>`).join("")}</ul>
</section>
${r.pendenciasDocumentadas.length ? `<section class="card" aria-labelledby="t-docum"><h2 id="t-docum">Pendências documentadas no fechamento</h2><ul class="lista-pendencias-doc">${r.pendenciasDocumentadas.map((x) => `<li><strong>${esc(typeof x === "string" ? x : x.descricao)}</strong>${typeof x === "string" ? "" : `<br><span class="nota">Impacto: ${esc(x.impacto)}${x.responsavelId ? ` · responsável: ${esc(x.responsavelId)}` : " · sem responsável definido"}${x.documentacaoFaltante ? ` · falta: ${esc(x.documentacaoFaltante)}` : ""}${x.decisao ? ` · decisão: ${esc(x.decisao)}` : ""}${x.evidenciaDocumentoIds?.length ? ` · ${x.evidenciaDocumentoIds.length} evidência(s)` : ""}</span>`}</li>`).join("")}</ul><p class="nota">Documentar não resolve: cada pendência continua aberta até a causa ser tratada.</p></section>` : ""}
${acoesDeFechamento(r, ctx)}
${versoesDeFechamento(r.versoes ?? [])}
<section class="card" aria-labelledby="t-hist"><h2 id="t-hist">Histórico de revisões</h2>
${r.historico.length ? `<ol class="historico">${r.historico.map((h) => `<li><strong>${esc(ESTADOS_COMPETENCIA[h.para]?.rotulo ?? h.para ?? h.evento)}</strong> · ${esc(dataBR(h.em))}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}${h.metodologia && h.para === "FECHAMENTO_HOMOLOGADO" ? ` · metodologia: ${esc(h.metodologia)}` : ""}</li>`).join("")}</ol>` : nenhum("Nenhuma mudança de estado registrada.")}
</section>`;
}

const ROTULO_DA_TRANSICAO = Object.freeze({
  FECHAMENTO_PRELIMINAR: "Iniciar fechamento preliminar", FECHAMENTO_COM_PENDENCIAS: "Registrar fechamento com pendências documentadas",
  FECHAMENTO_HOMOLOGADO: "Homologar a competência", ABERTA: "Reabrir a competência",
});

const rotuloDe = (a) => (a.estadoProposto === "FECHAMENTO_PRELIMINAR" && a.estadoAtual === "FECHAMENTO_COM_PENDENCIAS" ? "Voltar ao fechamento preliminar" : ROTULO_DA_TRANSICAO[a.estadoProposto] ?? a.estadoProposto);

/**
 * Ações de fechamento: cada uma mostra ANTES o estado atual e o proposto, o que passa a ser bloqueado, as pendências, os
 * impedimentos, a permissão exigida e se precisa de justificativa — tudo calculado pelo NÚCLEO (prévia). O botão só fica
 * habilitado quando o núcleo permite; mesmo assim a gravação é conferida de novo no servidor.
 */
function acoesDeFechamento(r, ctx = {}) {
  const acoes = r.acoes ?? [];
  if (!acoes.length) return "";
  return `<section class="card" aria-labelledby="t-acoes-fech"><h2 id="t-acoes-fech">Ações de fechamento</h2>
<p class="nota">Toda mudança de estado grava uma versão imutável da apuração e fica no histórico. Nada é homologado automaticamente.</p>
<div class="acoes-fechamento">${acoes.map((a) => {
    const reabrir = a.estadoProposto === "ABERTA";
    const campos = [
      `<input type="hidden" name="competencia" value="${esc(a.competencia)}"><input type="hidden" name="novoEstado" value="${esc(a.estadoProposto)}">`,
      a.exigeMetodologia ? `<label>Critério da decisão (metodologia aplicada) <textarea name="metodologia" rows="2" required maxlength="2000"></textarea></label><p class="nota">Metodologia vigente: ${esc(a.metodologiaVigente ?? "não publicada")}.</p>` : "",
      a.exigePendencias ? `<p class="nota">As pendências a resolver da Central entram na documentação, com o impacto e o responsável já atribuídos.</p><label>Documentação faltante <input name="documentacaoFaltante" maxlength="500"></label><label>Decisão registrada <input name="decisao" maxlength="500"></label>` : "",
      `<label>Justificativa${a.exigeJustificativa ? " (obrigatória)" : ""} <textarea name="justificativa" rows="2" maxlength="500"${a.exigeJustificativa ? " required" : ""}></textarea></label>`,
    ].join("");
    const formulario = a.permitida
      ? acao({ url: "/api/fv2/acoes/fechamento/alterar", rotulo: rotuloDe(a), campos, aviso: `Confirmo: ${ESTADOS_COMPETENCIA[a.estadoAtual].rotulo} → ${ESTADOS_COMPETENCIA[a.estadoProposto].rotulo}.`, recarregar: "lista", perigo: reabrir || a.estadoProposto === "FECHAMENTO_HOMOLOGADO" })
      : `<button type="button" class="botao" disabled aria-describedby="bloq-${esc(a.estadoProposto)}">${esc(rotuloDe(a))}</button>`;
    return `<article class="acao-fechamento" aria-label="${esc(rotuloDe(a))}">
  <h3>${esc(rotuloDe(a))}</h3>
  <dl class="ficha ficha--compacta">
    <dt>Estado atual</dt><dd>${seloDe(ESTADOS_COMPETENCIA[a.estadoAtual])}</dd>
    <dt>Estado proposto</dt><dd>${seloDe(ESTADOS_COMPETENCIA[a.estadoProposto])}</dd>
    <dt>O que passa a valer</dt><dd>${esc(a.efeito)}</dd>
    <dt>Permissão exigida</dt><dd>${esc(PERMISSOES[a.permissaoExigida] ?? a.permissaoExigida ?? "—")}${a.voceTemPermissao ? " · você tem" : " · você NÃO tem"}</dd>
    <dt>Justificativa</dt><dd>${a.exigeJustificativa ? "Obrigatória" : "Opcional"}${a.exigeConfirmacao ? " · exige confirmação explícita" : ""}</dd>
    ${a.impedimentos.length ? `<dt>Impedimentos</dt><dd><ul class="mini">${a.impedimentos.map((x) => `<li>${esc(x.mensagem)}</li>`).join("")}</ul></dd>` : ""}
  </dl>
  ${a.bloqueios.length ? `<p class="aviso aviso--alerta" id="bloq-${esc(a.estadoProposto)}"><strong>Não disponível:</strong> ${a.bloqueios.map(esc).join(" ")}</p>` : ""}
  ${formulario}
</article>`;
  }).join("")}</div></section>`;
}

/** Versões de fechamento (retratos imutáveis). A vigente é a homologada em vigor. */
function versoesDeFechamento(versoes) {
  if (!versoes.length) return "";
  const TIPO = { PRELIMINAR: "Preliminar", COM_PENDENCIAS: "Com pendências", HOMOLOGADA: "Homologada" };
  return `<section class="card" aria-labelledby="t-versoes"><h2 id="t-versoes">Versões do fechamento</h2>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Versões do fechamento</caption><thead><tr><th scope="col" class="esquerda">Versão</th><th scope="col">Faturamento bruto</th><th scope="col">Resultado gerencial</th><th scope="col">Metodologia</th><th scope="col">Decisão</th></tr></thead><tbody>
${versoes.map((v) => `<tr>${td("Versão", `<strong>nº ${v.numero} · ${esc(TIPO[v.tipo] ?? v.tipo)}</strong>${v.vigente ? ' <span class="selo selo--ok">vigente</span>' : ""}<br><span class="nota">revisão ${v.revisao}${v.justificativa ? ` · ${esc(v.justificativa)}` : ""}</span>`, "esquerda")}${td("Faturamento bruto", valor(v.faturamentoBrutoCentavos))}${td("Resultado gerencial", valor(v.resultadoGerencialCentavos))}${td("Metodologia", esc(v.metodologiaVersao))}${td("Decisão", `${esc(dataBR(v.decididoEm))} · ${esc(v.responsavel)}`)}</tr>`).join("")}
</tbody></table></div>
<p class="nota">Versões nunca são alteradas. Reabrir uma competência homologada preserva a versão anterior; a próxima homologação gera outra.</p></section>`;
}

/** Resultado de uma ação (sucesso ou recusa), sempre com o que realmente aconteceu. */
export function resultadoDaAcao(r) {
  if (!r.ok) return `<span class="valor--negativo">Não foi feito: ${esc(r.mensagem)}</span>`;
  const d = r.dados ?? {};
  if (d.repetido) return "Nada novo foi gravado: esta operação já tinha sido feita (repetição segura).";
  if (d.importacao && d.relatorio) return `Importação confirmada: ${d.relatorio.inseridos} registro(s) gravado(s), sem efeito financeiro.`;
  if (d.importacao) return `Arquivo recebido: ${esc(ESTADOS_IMPORTACAO[d.importacao.estado]?.rotulo ?? d.importacao.estado)}.`;
  if (d.proposta && d.efeitos) return `Proposta aplicada: ${d.efeitos.length} registro(s) criado(s) numa única transação.`;
  if (d.criadas !== undefined) return `${d.criadas} criada(s), ${d.existentes ?? 0} já existente(s)${d.bloqueadasPorHomologacao ? `, ${d.bloqueadasPorHomologacao} não criada(s) por competência homologada` : ""}.`;
  if (d.versao?.tipo) return `Feito: ${esc(ESTADOS_COMPETENCIA[d.estado]?.rotulo ?? d.estado)}. Versão nº ${d.versao.numero} registrada.`;
  if (d.estado && ESTADOS_COMPETENCIA[d.estado]) return `Feito: ${esc(ESTADOS_COMPETENCIA[d.estado].rotulo)}.`;
  if (d.responsavelId) return "Atribuição registrada no histórico.";
  if (d.lancamento && d.anterior) return `Reclassificado: ${esc(d.anterior.categoria)} → ${esc(d.lancamento.categoria)} (versão ${d.lancamento.versao}). DRE, Visão Geral e fechamento passam a refletir a mudança.`;
  if (d.conferido !== undefined) return d.conferido ? "Integridade conferida: o arquivo confere com o hash registrado." : `<span class="valor--negativo">${esc(d.motivo)}</span>`;
  if (d.acoes && d.usuarioId) return `Permissões atualizadas: ${d.acoes.length} ação(ões) ativa(s).`;
  if (d.estado) return `Feito: ${esc(ESTADOS_PROPOSTA[d.estado]?.rotulo ?? ESTADOS_IMPORTACAO[d.estado]?.rotulo ?? d.estado)}.`;
  if (d.situacao) return `Feito: ${esc(SITUACOES_CORRESPONDENCIA[d.situacao]?.rotulo ?? d.situacao)}.`;
  return "Feito.";
}
