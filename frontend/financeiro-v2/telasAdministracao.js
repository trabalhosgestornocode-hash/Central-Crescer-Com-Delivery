// Configurações e Documentos do Financeiro v2 (Execução 06D) — funções PURAS: dados das consultas → HTML escapado.
// Nada é decidido aqui: permissões, situações e regras chegam prontas do núcleo. Formulários de alteração só aparecem
// para quem tem a permissão exigida e sempre pedem confirmação; o servidor confere tudo de novo.
import { ESTADOS_COMPETENCIA, PERMISSOES, TIPOS_DOCUMENTO, competencia, dataBR, esc } from "./formatar.js";
import { paginacao } from "./telasTesouraria.js";

export const SECOES_CONFIG = Object.freeze([["unidade", "Organização e unidade"], ["plano", "Plano de contas"], ["canais", "Canais e processadores"], ["contas", "Contas financeiras"], ["metodologia", "Competências e metodologia"], ["permissoes", "Usuários e permissões"]]);
const nenhum = (texto) => `<p class="nota vazio-lista">${esc(texto)}</p>`;
const selo = (texto, classe) => `<span class="selo selo--${classe}">${esc(texto)}</span>`;
const td = (rotulo, conteudo, classe = "") => `<td data-rotulo="${esc(rotulo)}"${classe ? ` class="${classe}"` : ""}><span class="cel">${conteudo}</span></td>`;
const fechar = (titulo) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(titulo)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar">×</button></div>`;
const exige = (texto) => `<p class="nota">${esc(texto)}</p>`;
const NOMES_PAPEL = Object.freeze({ CANAL: "Canal de venda", PROCESSADOR: "Processador de pagamento" });
const NOMES_BASE = Object.freeze({ BALCAO: "Balcão", IFOOD: "iFood", ANOTA_AI: "Anota AI", OUTRO: "Outro", STONE: "Stone", OPERADORA_BENEFICIOS: "Operadora de vale", MAQUINA_TERCEIROS: "Máquina de terceiros" });
const SITUACAO_CADASTRO = Object.freeze({ ATIVO: ["Ativo", "ok"], INATIVO: ["Inativo", "neutro"], NAO_CADASTRADO: ["Disponível (não cadastrado)", "info"] });

function acao({ url, rotulo, campos = "", aviso, recarregar = "lista", perigo = false }) {
  return `<form class="acao${perigo ? " acao--perigo" : ""}" data-acao="${esc(url)}" data-recarregar="${esc(recarregar)}">
  ${campos}
  <label class="caixa-marcar"><input type="checkbox" name="confirmar" required> ${esc(aviso)}</label>
  <button type="submit" class="botao${perigo ? "" : " botao--primario"}">${esc(rotulo)}</button>
  <p class="resultado-acao" role="status" aria-live="polite"></p>
</form>`;
}
const justificativa = (obrigatoria = true) => `<label>Justificativa${obrigatoria ? " (obrigatória)" : ""} <input name="justificativa" maxlength="500"${obrigatoria ? " required" : ""}></label>`;

// --------------------------------------------------------------------------------------------------- configurações
export function configuracoes(dados, f = {}, ctx = {}) {
  const secao = f.secao ?? "unidade";
  const corpo = { unidade, plano, canais, contas, metodologia, permissoes }[secao] ?? unidade;
  return `<div class="configuracoes"><header class="cabecalho"><div><h1>Configurações</h1><p class="subtitulo">${esc(ctx.unidadeNome ?? "")} · organização e unidade vêm da sua sessão</p></div></header>
<nav class="abas abas--botoes" aria-label="Seções de configurações">${SECOES_CONFIG.map(([k, t]) => `<button type="button" data-secao-config="${k}"${k === secao ? ' aria-current="page"' : ""}>${esc(t)}</button>`).join("")}</nav>
${corpo(dados, ctx)}</div>`;
}

function unidade(c) {
  const u = c.unidade;
  return `<section class="card" aria-labelledby="t-unidade"><h2 id="t-unidade">Organização e unidade</h2>
<dl class="ficha">
  <dt>Nome de exibição</dt><dd>${esc(u?.nomeExibicao ?? "Ainda não configurado")}</dd>
  <dt>Identificação da empresa</dt><dd>${esc(u?.identificacaoEmpresa ?? "—")}</dd>
  <dt>Situação no Financeiro v2</dt><dd>${u ? selo(u.situacao === "ATIVA" ? "Ativa" : "Inativa", u.situacao === "ATIVA" ? "ok" : "neutro") : "—"}</dd>
  <dt>Contas vinculadas</dt><dd>${c.contas.length ? c.contas.map((x) => esc(x.nome)).join(", ") : "Nenhuma"}</dd>
  <dt>Canais ativos</dt><dd>${c.canais.filter((x) => x.situacao === "ATIVO").map((x) => esc(x.nome)).join(", ") || "Nenhum cadastrado"}</dd>
</dl>
<p class="nota">A organização e a unidade desta tela são as da sua sessão; não podem ser trocadas por parâmetro.</p></section>
${c.voce.podeConfigurar ? `<section class="card" aria-labelledby="t-unidade-ed"><h2 id="t-unidade-ed">Alterar identificação</h2>${acao({ url: "/api/fv2/acoes/configuracoes/unidade", rotulo: "Salvar identificação", aviso: "Confirmo a alteração (fica no histórico).",
    campos: `<label>Nome de exibição <input name="nomeExibicao" required maxlength="120" value="${esc(u?.nomeExibicao ?? "")}"></label><label>Identificação da empresa (opcional, sem dados pessoais) <input name="identificacaoEmpresa" maxlength="120" value="${esc(u?.identificacaoEmpresa ?? "")}"></label>
<label>Situação <select name="situacao"><option value="ATIVA"${u?.situacao !== "INATIVA" ? " selected" : ""}>Ativa</option><option value="INATIVA"${u?.situacao === "INATIVA" ? " selected" : ""}>Inativa</option></select></label>${justificativa()}` })}</section>` : exige("Alterar exige a permissão \"configurar\".")}`;
}

function plano(dados, ctx) {
  const linhas = [];
  const percorrer = (nos, nivel) => { for (const n of nos) { linhas.push({ ...n, nivel }); percorrer(n.filhas ?? [], nivel + 1); } };
  percorrer(dados.plano ?? [], 0);
  return `<section class="card" aria-labelledby="t-plano"><h2 id="t-plano">Plano de contas</h2>
<p class="nota">Categoria nunca é excluída: inativar mantém o histórico apurável e bloqueia lançamentos novos. A natureza vem da classificação.</p>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Categorias</caption><thead><tr><th scope="col" class="esquerda">Categoria</th><th scope="col">Natureza</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${linhas.map((x) => `<tr>${td("Categoria", `<span class="nivel-${Math.min(x.nivel, 3)}">${esc(x.nome)}</span><br><span class="nota">${esc(x.codigo)}${x.doSistema ? " · do sistema" : ""}${x.aceitaLancamento ? "" : " · agrupadora"}</span>`, "esquerda")}${td("Natureza", esc(x.natureza))}${td("Situação", x.ativa ? selo("Ativa", "ok") : selo("Inativa", "neutro"))}${td("Ações", `<button type="button" class="botao-link" data-detalhe="categoria:${esc(x.codigo)}">Histórico e uso</button>`)}</tr>`).join("")}
</tbody></table></div></section>
<details class="card"><summary><h2 class="inline">Regras de classificação</h2></summary><ul class="lista-simples">${(dados.configuracoes?.planoDeContas?.regras ?? []).map((r) => `<li><span>${esc(r.classificacao)}</span><span>${esc(r.naturezas.join(" ou "))}</span></li>`).join("")}</ul></details>
${ctx.podeConfigurar ? "" : exige("Alterar categorias exige a permissão \"configurar\".")}`;
}

export function detalheCategoria(d, ctx = {}) {
  return `${fechar(`${d.nome} (${d.codigo})`)}
<dl class="ficha"><dt>Natureza</dt><dd>${esc(d.natureza)}</dd><dt>Situação</dt><dd>${d.ativa ? selo("Ativa", "ok") : selo("Inativa", "neutro")}</dd>
<dt>Uso</dt><dd>${d.uso.lancamentos} lançamento(s)${d.uso.competencias.length ? ` em ${d.uso.competencias.map((x) => esc(competencia(x))).join(", ")}` : ""}</dd><dt>Exclusão</dt><dd>${esc(d.observacao)}</dd></dl>
${ctx.podeConfigurar && !d.doSistema ? acao({ url: "/api/fv2/acoes/configuracoes/categoria", rotulo: d.ativa ? "Inativar categoria" : "Reativar categoria", aviso: d.ativa ? "Confirmo: lançamentos novos nesta categoria serão recusados; o histórico continua." : "Confirmo a reativação.", recarregar: `categoria:${d.codigo}`, perigo: d.ativa,
    campos: `<input type="hidden" name="codigo" value="${esc(d.codigo)}"><input type="hidden" name="ativa" value="${d.ativa ? "false" : "true"}">${justificativa()}` }) : d.doSistema ? exige("Categoria usada pelo próprio sistema: não pode ser inativada.") : ""}
<h3>Histórico</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li><strong>${esc(h.evento === "CRIACAO" ? "Criada" : "Alterada")}</strong> · ${esc(dataBR(h.em))}${h.nomeAntes && h.nomeAntes !== h.nomeDepois ? ` · nome: ${esc(h.nomeAntes)} → ${esc(h.nomeDepois)}` : ""}${h.ativaAntes !== null && h.ativaAntes !== h.ativaDepois ? ` · ${h.ativaDepois ? "reativada" : "inativada"}` : ""}${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico.")}`;
}

function canais(c) {
  const linha = (x) => `<tr>${td("Cadastro", `<strong>${esc(x.nome)}</strong><br><span class="nota">${esc(x.codigo)}${x.doSistema ? "" : ` · base: ${esc(NOMES_BASE[x.codigoBase] ?? x.codigoBase)}`}</span>`, "esquerda")}${td("Papel", esc(NOMES_PAPEL[x.papel]))}${td("Situação", selo(...(SITUACAO_CADASTRO[x.situacao] ?? [x.situacao, "neutro"])))}</tr>`;
  return `<section class="card" aria-labelledby="t-canais"><h2 id="t-canais">Canais e processadores</h2>
<p class="nota">${esc(c.observacaoComercial)}</p>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Canais e processadores</caption><thead><tr><th scope="col" class="esquerda">Cadastro</th><th scope="col">Papel</th><th scope="col">Situação</th></tr></thead><tbody>
${[...c.canais, ...c.processadores].map(linha).join("")}</tbody></table></div></section>
${c.voce.podeConfigurar ? `<section class="card" aria-labelledby="t-canal-novo"><h2 id="t-canal-novo">Cadastrar ou alterar</h2>${acao({ url: "/api/fv2/acoes/configuracoes/canal", rotulo: "Salvar cadastro", aviso: "Confirmo o cadastro (fica no histórico).",
    campos: `<label>Papel <select name="papel"><option value="CANAL">Canal de venda</option><option value="PROCESSADOR">Processador de pagamento</option></select></label>
<label>Código (maiúsculas, números e _) <input name="codigo" required pattern="[A-Z][A-Z0-9_]{1,39}" maxlength="40"></label>
<label>Equivale a (código base) <select name="codigoBase">${Object.entries(NOMES_BASE).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label>
<label>Nome <input name="nome" required maxlength="80"></label><label>Situação <select name="situacao"><option value="ATIVO">Ativo</option><option value="INATIVO">Inativo</option></select></label>${justificativa()}` })}
<p class="nota">Não há campo de taxa contratual: taxas desconhecidas não são presumidas.</p></section>` : exige("Cadastrar exige a permissão \"configurar\".")}`;
}

function contas(c) {
  return `<section class="card" aria-labelledby="t-contas"><h2 id="t-contas">Contas financeiras</h2>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Contas financeiras</caption><thead><tr><th scope="col" class="esquerda">Conta</th><th scope="col">Movimentações</th><th scope="col">Situação</th></tr></thead><tbody>
${c.contas.map((x) => `<tr>${td("Conta", `<strong>${esc(x.nome)}</strong><br><span class="nota">${x.tipo === "CAIXA_FISICO" ? "Caixa físico" : "Conta bancária"}${x.instituicao ? ` · ${esc(x.instituicao)}` : ""}${x.sessaoDeCaixaAberta ? " · sessão de caixa aberta" : ""}</span>`, "esquerda")}${td("Movimentações", `${x.movimentacoes} (${x.naoConciliadas} não conciliada(s))`)}${td("Situação", x.ativa ? selo("Ativa", "ok") : selo("Inativa", "neutro"))}</tr>`).join("")}
</tbody></table></div>
<p class="nota">Renomear exige "configurar". Ativar ou desativar afeta saldos e conciliação: exige também "conciliar", justificativa e nenhuma sessão de caixa aberta.</p></section>
${c.voce.podeConfigurar ? `<section class="card" aria-labelledby="t-conta-ed"><h2 id="t-conta-ed">Alterar conta</h2>${acao({ url: "/api/fv2/acoes/configuracoes/conta", rotulo: "Salvar alteração", aviso: "Confirmo a alteração da conta (fica no histórico).",
    campos: `<label>Conta <select name="conta">${c.contas.map((x) => `<option value="${esc(x.id)}">${esc(x.nome)}</option>`).join("")}</select></label><label>Novo nome (opcional) <input name="nome" maxlength="80"></label>
<label>Situação <select name="ativa"><option value="">Não alterar</option><option value="true">Ativa</option><option value="false">Inativa</option></select></label>${justificativa()}` })}</section>` : exige("Alterar exige a permissão \"configurar\".")}`;
}

function metodologia(c) {
  return `<section class="card" aria-labelledby="t-metod"><h2 id="t-metod">Metodologia de apuração</h2>
${c.metodologias.map((m) => `<article class="metodologia"><h3>${esc(m.nome)} ${m.vigente ? selo("vigente", "ok") : ""}</h3>
<dl class="ficha ficha--compacta"><dt>Versão</dt><dd>${esc(m.identificador)}</dd><dt>Vigência</dt><dd>desde ${esc(competencia(m.vigenteDesde))}${m.vigenteAte ? ` até ${esc(competencia(m.vigenteAte))}` : " (sem data de fim)"}</dd><dt>Publicada em</dt><dd>${esc(dataBR(m.publicadaEm))}</dd></dl>
<p>${esc(m.resumo)}</p><h4>Critérios de fechamento</h4><ul class="mini">${m.criteriosDeFechamento.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></article>`).join("")}
<p class="nota">Uma versão nova de metodologia não recalcula competências homologadas: elas guardam o retrato da apuração. Reapurar exige reabertura formal.</p></section>
<section class="card" aria-labelledby="t-comps"><h2 id="t-comps">Competências</h2>${c.competencias.length ? `<ul class="lista-simples">${c.competencias.map((x) => `<li><span>${esc(competencia(x.competencia))}${x.revisoes ? ` · ${x.revisoes} revisão(ões)` : ""}</span>${selo(ESTADOS_COMPETENCIA[x.estado]?.rotulo ?? x.estado, ESTADOS_COMPETENCIA[x.estado]?.classe ?? "neutro")}</li>`).join("")}</ul>` : nenhum("Nenhuma competência com fechamento registrado.")}</section>`;
}

function permissoes(c, ctx) {
  const p = c.permissoes;
  if (!p) return nenhum("Sem dados de permissões.");
  const marcar = (prefixo) => p.acoesExistentes.map((a) => `<label class="caixa-marcar"><input type="checkbox" name="acao_${esc(a.split(".")[1])}"${prefixo === "conceder" && !p.suasPermissoes.includes(a) ? " disabled" : ""}> ${esc(PERMISSOES[a] ?? a)}${prefixo === "conceder" && !p.suasPermissoes.includes(a) ? " (você não possui)" : ""}</label>`).join("");
  const pessoas = (ctx.pessoasDemo ?? []).map((x) => `<option value="${esc(x.perfil)}">${esc(x.nome)}</option>`).join("");
  return `<section class="card" aria-labelledby="t-perm"><h2 id="t-perm">Usuários e permissões</h2>
<ul class="mini">${p.regras.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p>Suas permissões nesta unidade: ${p.suasPermissoes.map((a) => esc(PERMISSOES[a] ?? a)).join(", ") || "nenhuma"}.</p>
${p.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Concessões</caption><thead><tr><th scope="col" class="esquerda">Pessoa</th><th scope="col">Ações</th><th scope="col">Situação</th></tr></thead><tbody>
${p.itens.map((x) => `<tr>${td("Pessoa", `<strong>${esc(x.usuarioId)}</strong>${x.voce ? " (você)" : ""}<br><span class="nota">concedido por ${esc(x.concedidoPor)} · ${esc(dataBR(x.atualizadoEm))}${x.justificativa ? ` — ${esc(x.justificativa)}` : ""}</span>
<details><summary>Histórico (${x.historico.length})</summary><ol class="historico">${x.historico.map((h) => `<li>${esc(dataBR(h.em))} · ${esc(h.por)} · ${esc(h.acoesAntes.length)} → ${esc(h.acoesDepois.length)} ação(ões)${h.justificativa ? ` — ${esc(h.justificativa)}` : ""}</li>`).join("")}</ol></details>`, "esquerda")}${td("Ações", x.acoes.map((a) => esc(PERMISSOES[a] ?? a)).join(", ") || "—")}${td("Situação", x.situacao === "ATIVA" ? selo("Ativa", "ok") : selo("Revogada", "neutro"))}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhuma concessão visível.")}</section>
${p.podeConceder ? `<section class="card" aria-labelledby="t-perm-ed"><h2 id="t-perm-ed">Conceder ou revogar</h2>
<p class="nota">Só pessoas desta demonstração (sintéticas). Na integração real, a pessoa virá da sessão autenticada da plataforma.</p>
<div class="duas-colunas">${acao({ url: "/api/fv2/acoes/permissoes/conceder", rotulo: "Conceder ações marcadas", aviso: "Confirmo a concessão (fica no histórico).", campos: `<label>Pessoa <select name="usuario">${pessoas}</select></label><fieldset><legend>Ações</legend>${marcar("conceder")}</fieldset>${justificativa()}` })}
${acao({ url: "/api/fv2/acoes/permissoes/revogar", rotulo: "Revogar ações marcadas (nenhuma marcada = todas)", aviso: "Confirmo a revogação: vale na próxima ação da pessoa.", perigo: true, campos: `<label>Pessoa <select name="usuario">${pessoas}</select></label><fieldset><legend>Ações</legend>${marcar("revogar")}</fieldset>${justificativa()}` })}</div>
<p class="nota">Primeiro administrador de uma unidade: só por provisionamento atestado por autoridade previamente autenticada (doc 14). Nesta demonstração a autoridade é sintética.</p></section>` : exige("Conceder e revogar exige a permissão \"conceder acessos\".")}`;
}

// ------------------------------------------------------------------------------------------------------- documentos
export function documentos(r, f = {}) {
  return `<header class="cabecalho"><div><h1>Documentos</h1><p class="subtitulo">Cofre documental da unidade · ${r.paginacao.total} documento(s)</p></div></header>
<p class="aviso">Abrir ou baixar um arquivo exige a permissão "abrir documentos do cofre", conferida a cada pedido. ${r.podeAbrir ? "Você tem esta permissão." : "Você vê só as fichas (metadados)."}</p>
<form class="filtros-locais" data-filtro-local="documentos" aria-label="Filtros de documentos">
  <label>Situação <select name="situacao"><option value="">Todos</option><option value="VIGENTE"${f.situacao === "VIGENTE" ? " selected" : ""}>Versão vigente</option><option value="SUBSTITUIDO"${f.situacao === "SUBSTITUIDO" ? " selected" : ""}>Substituídos</option></select></label>
  <label class="caixa-marcar"><input type="checkbox" name="soCompetencia"${f.soCompetencia ? " checked" : ""}> Só a competência selecionada</label>
</form>
<section class="card" aria-labelledby="t-docs"><h2 id="t-docs" class="sr">Lista de documentos</h2>
${r.itens.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Documentos</caption><thead><tr><th scope="col" class="esquerda">Documento</th><th scope="col">Recebido</th><th scope="col">Versão</th><th scope="col">Arquivo</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${r.itens.map((x) => `<tr>${td("Documento", `<strong>${esc(x.descricao ?? TIPOS_DOCUMENTO[x.tipo] ?? "Documento")}</strong><br><span class="nota">${esc(TIPOS_DOCUMENTO[x.tipo] ?? x.tipo)} · origem ${esc(x.origem)}${x.competencia ? ` · ${esc(competencia(x.competencia))}` : ""}</span>`, "esquerda")}${td("Recebido", esc(dataBR(x.recebidoEm)))}${td("Versão", `${x.versao} ${x.vigente ? selo("vigente", "ok") : selo("substituída", "neutro")}`)}${td("Arquivo", x.arquivoNoCofre ? "No cofre" : '<span class="valor--desconhecido">Só a ficha (arquivo fora deste ambiente)</span>')}${td("Ações", `<button type="button" class="botao-link" data-detalhe="documento-cofre:${esc(x.id)}">Detalhar</button>`)}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhum documento registrado.")}
${paginacao(r.paginacao, "documentos")}
</section>`;
}

const FINALIDADES = Object.freeze({ VISUALIZAR: "visualizado", BAIXAR: "baixado", VERIFICAR: "integridade verificada", DETALHAR: "detalhado" });
export function detalheDocumentoCofre(d) {
  const podeVer = d.podeAbrir && d.arquivoNoCofre;
  return `${fechar(d.descricao ?? TIPOS_DOCUMENTO[d.tipo] ?? "Documento")}
<dl class="ficha">
  <dt>Tipo</dt><dd>${esc(TIPOS_DOCUMENTO[d.tipo] ?? d.tipo)}</dd><dt>Origem</dt><dd>${esc(d.origem)}</dd>
  <dt>Recebido em</dt><dd>${esc(dataBR(d.recebidoEm))}</dd><dt>Registrado por</dt><dd>${esc(d.registradoPor)}</dd>
  <dt>Versão</dt><dd>${d.versao} ${d.vigente ? selo("vigente", "ok") : selo("substituída", "neutro")}</dd>
  <dt>Integridade</dt><dd><span class="nota">SHA-256 registrado: <code>${esc(d.hashSha256.slice(0, 16))}…</code></span></dd>
  <dt>Arquivo</dt><dd>${d.arquivoNoCofre ? "Guardado no cofre deste ambiente" : "Não está no cofre deste ambiente: só a ficha está disponível"}</dd>
</dl>
${podeVer ? `<div class="acoes-documento">
  <button type="button" class="botao botao--primario" data-documento-ver="${esc(d.id)}">Visualizar (somente PDF sem conteúdo ativo)</button>
  <button type="button" class="botao" data-documento-baixar="${esc(d.id)}">Baixar arquivo</button>
</div>
<div id="visualizador" class="visualizador" aria-live="polite"></div>
${acao({ url: "/api/fv2/acoes/documentos/verificar", rotulo: "Verificar integridade agora", aviso: "Confirmo a verificação (o resultado fica no histórico do documento).", recarregar: `documento-cofre:${d.id}`, campos: `<input type="hidden" name="documento" value="${esc(d.id)}">` })}`
    : d.arquivoNoCofre ? exige("Abrir, baixar e verificar o arquivo exige a permissão \"abrir documentos do cofre\".") : ""}
<h3>Versões</h3><ul class="lista-simples">${d.versoes.map((v) => `<li><span>Versão ${v.versao}${v.atual ? " (esta)" : ""} · ${esc(dataBR(v.recebidoEm))}</span>${v.atual ? selo(v.vigente ? "vigente" : "substituída", v.vigente ? "ok" : "neutro") : `<button type="button" class="botao-link" data-detalhe="documento-cofre:${esc(v.id)}">Abrir ficha</button>`}</li>`).join("")}</ul>
<h3>Vínculos</h3>${d.vinculos.length ? `<ul class="mini">${d.vinculos.map((v) => `<li>${esc(v.registroTipo)}</li>`).join("")}</ul>` : nenhum("Nenhum vínculo registrado.")}
<h3>Histórico de decisões e acessos</h3>${d.historico.length ? `<ol class="historico">${d.historico.map((h) => `<li>${esc(dataBR(h.em))} · ${esc(h.evento === "ACESSO_DOCUMENTO" ? `Arquivo ${FINALIDADES[h.finalidade] ?? h.finalidade}${h.resultado === "INTEGRO" ? " (íntegro)" : ""}` : h.evento === "CRIACAO" ? "Registrado" : h.evento === "SUBSTITUICAO" ? "Substituído por nova versão" : "Alterado")}${h.porVoce ? " · você" : ""}</li>`).join("")}</ol>` : nenhum("Sem histórico.")}`;
}
