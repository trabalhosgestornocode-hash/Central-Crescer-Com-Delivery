// Aplicação do Financeiro v2 (demonstração local): roteamento por hash, filtros, carregamento sem flash de dados antigos,
// expansões acessíveis, painel "Ver composição completa" e detalhes de títulos. Nenhum cálculo financeiro: só consome as
// consultas do motor. Datas de período (início/fim do mês, +30 dias) são só calendário, nunca valores.
import { criarConsultor, enviar } from "./consulta.js";
import * as adm from "./telasAdministracao.js";
import * as conf from "./telasConferencias.js";
import * as telas from "./telas.js";
import * as tes from "./telasTesouraria.js";
import * as ven from "./telasVendas.js";
import { esc } from "./formatar.js";

const $ = (s) => document.querySelector(s);
const consultor = criarConsultor();
const consultorPainel = criarConsultor();
const estado = {
  rota: "visao-geral", competencia: "2026-09", unidade: null, sessao: "gestor", unidades: [], dataBase: null,
  // Filtros locais de cada tela (sobrevivem à troca de rota; são zerados ao trocar de unidade ou sessão).
  filtros: filtrosIniciais(),
  pagina: {}, calendario: null, diaSelecionado: null,
};
function filtrosIniciais() {
  return { "contas-a-pagar": {}, "contas-a-receber": {}, "caixa-e-bancos": {}, "fluxo-de-caixa": { preset: "competencia", granularidade: "SEMANA" }, "vendas-e-recebimentos": { aba: "vendas" }, conferencias: { secao: "resumo" }, configuracoes: { secao: "unidade" }, documentos: {} };
}
let focoAntesDoPainel = null;
let recarregarAoFechar = false;
let revisarAoCarregar = null;
const ROTAS = ["visao-geral", "dre", "contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa", "vendas-e-recebimentos", "conferencias", "configuracoes", "documentos"];
/** Filtros aceitos na URL da Central (ligações de outras telas). `revisar` abre o painel da pendência indicada. */
const FILTROS_URL_CONFERENCIAS = ["secao", "grupo", "situacao", "estado"];
const ENDPOINT_DA_SECAO = { resumo: "conferencias", pendencias: "conferencias/pendencias", documentos: "conferencias/documentos", propostas: "conferencias/propostas", conciliacoes: "conferencias/correspondencias", fechamento: "conferencias/fechamento" };
const permissoesDaUnidade = () => estado.unidades.find((u) => u.id === estado.unidade)?.permissoes ?? [];
/** Filtros aceitos na URL de Vendas e Recebimentos (ligação vinda de outras telas). Nada além disso é lido da URL. */
const FILTROS_URL_VENDAS = ["aba", "canal", "forma", "processador", "situacao", "recebimento", "codigo", "tipoComponente", "identificador"];
const ENDPOINT_DA_ABA = { vendas: "vendas", pagamentos: "vendas/pagamentos", taxas: "vendas/taxas", recebiveis: "vendas/recebiveis", divergencias: "vendas/divergencias" };

const cabecalhos = () => ({ "x-fv2-demo-sessao": estado.sessao });
const qs = (extra = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ competencia: estado.competencia, unidade: estado.unidade ?? "", ...extra }).filter(([, v]) => v !== undefined && v !== null && v !== false))).toString();
const nomeUnidade = () => estado.unidades.find((u) => u.id === estado.unidade)?.nome ?? "";

// ---- datas de calendário (apresentação de período, sem valores)
const dataUTC = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const somarDias = (d, n) => { const x = dataUTC(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const inicioDoMes = (m) => `${m}-01`;
const fimDoMes = (m) => { const [a, mm] = m.split("-").map(Number); return iso(new Date(Date.UTC(a, mm, 0))); };
const somarMes = (m, n) => { const [a, mm] = m.split("-").map(Number); const d = new Date(Date.UTC(a, mm - 1 + n, 1)); return iso(d).slice(0, 7); };

function mensagemDeErro(r) {
  if (r.status === 401) return telas.estado("sem-sessao", /expirad/i.test(r.mensagem ?? "") ? "Sua sessão expirou. Entre novamente: nada foi gravado." : "");
  if (r.status === 403) return telas.estado("negado", r.mensagem);
  return telas.estado("erro", r.mensagem);
}

/** Aplica pesos da barra (CSP proíbe estilo inline no HTML). */
function aplicarPesos(raiz) {
  for (const el of raiz.querySelectorAll("[data-peso]")) el.style.flexGrow = el.dataset.peso;
}

/** Consulta de cada rota: caminho + parâmetros, montados SÓ a partir do estado da tela. */
function consultaDaRota() {
  const f = estado.filtros[estado.rota] ?? {};
  const pagina = estado.pagina[estado.rota] ?? 1;
  switch (estado.rota) {
    case "dre": return `/api/fv2/dre?${qs()}`;
    case "configuracoes": return f.secao === "plano" ? `/api/fv2/configuracoes/plano?${qs({ competencia: undefined })}` : f.secao === "permissoes" ? `/api/fv2/permissoes?${qs({ competencia: undefined })}` : `/api/fv2/configuracoes?${qs({ competencia: undefined })}`;
    case "documentos": return `/api/fv2/documentos?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, pagina, tamanho: 25 })}`;
    case "contas-a-pagar": return `/api/fv2/contas-a-pagar?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, contraparteId: f.contraparteId, categoria: f.categoria, vencimentoDe: f.vencimentoDe, vencimentoAte: f.vencimentoAte, pagina, tamanho: 25 })}`;
    case "contas-a-receber": return `/api/fv2/contas-a-receber?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, tipo: f.tipo, processador: f.processador, pagina, tamanho: 25 })}`;
    case "caixa-e-bancos": return `/api/fv2/caixa-e-bancos?${qs({ competencia: undefined, inicio: f.inicio || inicioDoMes(estado.competencia), fim: f.fim || fimDoMes(estado.competencia), contaId: f.contaId, pagina, tamanho: 30 })}`;
    case "calendario": return `/api/fv2/calendario?${qs({ competencia: undefined, mes: estado.competencia })}`;
    case "conferencias": {
      const secao = ENDPOINT_DA_SECAO[f.secao] ? f.secao : "resumo";
      const extra = { pendencias: { grupo: f.grupo, situacao: f.situacao, pagina, tamanho: 20 }, documentos: { estado: f.estado, pagina, tamanho: 20 }, propostas: { estado: f.estado, pagina, tamanho: 20 }, conciliacoes: { situacao: f.situacao, pagina, tamanho: 20 } }[secao] ?? {};
      return `/api/fv2/${ENDPOINT_DA_SECAO[secao]}?${qs(extra)}`;
    }
    case "vendas-e-recebimentos": {
      const aba = ENDPOINT_DA_ABA[f.aba] ? f.aba : "vendas";
      const comum = { canal: f.canal, forma: ["vendas", "pagamentos"].includes(aba) ? f.forma : undefined, processador: f.processador, pagina, tamanho: 25 };
      const especifico = {
        vendas: { situacao: f.situacao, identificador: f.identificador, valorMinimoCentavos: f.valorMinimoCentavos, valorMaximoCentavos: f.valorMaximoCentavos },
        taxas: { tipoComponente: f.tipoComponente }, recebiveis: { recebimento: f.recebimento }, divergencias: { codigo: f.codigo },
      }[aba] ?? {};
      return `/api/fv2/${ENDPOINT_DA_ABA[aba]}?${qs({ ...comum, ...especifico })}`;
    }
    case "fluxo-de-caixa": {
      const hoje = estado.dataBase ?? inicioDoMes(estado.competencia);
      const [inicio, fim] = f.preset === "30" ? [hoje, somarDias(hoje, 30)] : f.preset === "90" ? [hoje, somarDias(hoje, 90)] : f.preset === "personalizado" && f.inicio && f.fim ? [f.inicio, f.fim] : [inicioDoMes(estado.competencia), fimDoMes(estado.competencia)];
      return `/api/fv2/fluxo-de-caixa?${qs({ competencia: undefined, inicio, fim, granularidade: f.granularidade ?? "SEMANA" })}`;
    }
    default: return `/api/fv2/visao-geral?${qs()}`;
  }
}

function desenhar(dados) {
  const f = estado.filtros[estado.rota] ?? {};
  switch (estado.rota) {
    case "dre": return telas.dre(dados, { unidadeNome: nomeUnidade() });
    case "configuracoes": {
      const perm = permissoesDaUnidade();
      const ctx = { unidadeNome: nomeUnidade(), podeConfigurar: perm.includes("financeiro_v2.configurar"), pessoasDemo: estado.pessoasDemo ?? [] };
      const corpo = f.secao === "plano" ? { plano: dados, configuracoes: estado.configuracoes } : f.secao === "permissoes" ? { permissoes: dados } : dados;
      if (!f.secao || !["plano", "permissoes"].includes(f.secao)) estado.configuracoes = dados;
      return adm.configuracoes(corpo, f, ctx);
    }
    case "documentos": return adm.documentos(dados, f);
    case "contas-a-pagar": return tes.contasAPagar(dados, f);
    case "contas-a-receber": return tes.contasAReceber(dados, f);
    case "caixa-e-bancos": if (!f.contaId) f.contas = dados.contas.map((c) => ({ id: c.id, nome: c.nome })); return tes.caixaEBancos(dados, f);
    case "calendario": estado.calendario = dados; return tes.calendario(dados, { selecionado: estado.diaSelecionado?.startsWith(dados.mes) ? estado.diaSelecionado : null });
    case "fluxo-de-caixa": return tes.fluxoDeCaixa(dados, f);
    case "vendas-e-recebimentos": return ven.vendasERecebimentos(dados, f);
    case "conferencias": return conf.central(dados, f, { competencia: estado.competencia, unidadeNome: nomeUnidade(), permissoes: permissoesDaUnidade() });
    default: return telas.visaoGeral(dados, { unidadeNome: nomeUnidade() });
  }
}

async function carregar() {
  const conteudo = $("#conteudo");
  // Sem flash: a tela anterior some ANTES de qualquer consulta; nada de outra competência/unidade/filtro fica visível.
  conteudo.innerHTML = telas.estado("carregando");
  conteudo.setAttribute("aria-busy", "true");
  fecharPainel(false);
  if (!estado.unidade) {
    const s = await consultor.consultar("/api/fv2/sessao", cabecalhos());
    if (!s) return;
    if (!s.ok) { conteudo.innerHTML = mensagemDeErro(s); conteudo.removeAttribute("aria-busy"); return; }
    estado.unidades = s.dados.unidades;
    estado.dataBase = s.dados.dataBase ?? null;
    estado.csrf = s.dados.csrf ?? null;
    estado.pessoasDemo = s.dados.pessoasDemo ?? [];
    estado.pessoas = null;
    estado.unidade = s.dados.unidades[0]?.id ?? null;
    preencherUnidades();
    if (!estado.unidade) { conteudo.innerHTML = telas.estado("negado", "Nenhuma unidade liberada para o Financeiro v2."); conteudo.removeAttribute("aria-busy"); return; }
  }
  const r = await consultor.consultar(consultaDaRota(), cabecalhos());
  if (r === null) return; // resposta obsoleta: outra consulta mais nova já está em andamento
  conteudo.removeAttribute("aria-busy");
  if (!r.ok) { conteudo.innerHTML = mensagemDeErro(r); return; }
  conteudo.innerHTML = desenhar(r.dados);
  aplicarPesos(conteudo);
  if (revisarAoCarregar && estado.rota === "conferencias") {
    // Ligação de outra tela (ex.: Caixa e Bancos → crédito não identificado): abre a pendência; se não existir, o painel diz.
    const chave = revisarAoCarregar;
    revisarAoCarregar = null;
    abrirDetalhe(`pendencia:${chave}`, conteudo);
  }
}

function preencherUnidades() {
  const sel = $("#filtro-unidade");
  sel.innerHTML = estado.unidades.map((u) => `<option value="${esc(u.id)}">${esc(u.nome)}</option>`).join("");
  sel.value = estado.unidade ?? "";
}

async function abrirNoPainel(url, desenhar, origem) {
  const painel = $("#painel");
  // Navegar de um detalhe para outro (venda → recebível) troca o conteúdo do painel; ao fechar, o foco volta para o
  // ponto da TELA de onde o primeiro detalhe foi aberto (o botão dentro do painel deixa de existir).
  if (!painel.contains(origem) || !focoAntesDoPainel) focoAntesDoPainel = origem;
  const alvo = painel.querySelector(".painel-conteudo");
  painel.hidden = false;
  alvo.innerHTML = telas.estado("carregando");
  alvo.focus();
  const r = await consultorPainel.consultar(url, cabecalhos());
  if (r === null) return;
  alvo.innerHTML = r.ok ? desenhar(r.dados) : `<div class="painel-cabeca"><span></span><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar">×</button></div>${mensagemDeErro(r)}`;
  painel.querySelector("[data-fechar-painel]")?.focus();
}
const abrirPainel = (codigo, origem) => abrirNoPainel(`/api/fv2/composicao?${qs({ codigo })}`, (d) => telas.composicao(d, { unidadeNome: nomeUnidade() }), origem);
const ctxPainel = () => ({ permissoes: permissoesDaUnidade(), competencia: estado.competencia });
const DETALHES = {
  pagar: ["conta-a-pagar", (d) => tes.detalheAPagar(d)], receber: ["conta-a-receber", (d) => tes.detalheAReceber(d)],
  venda: ["venda", (d) => ven.detalheDaVenda(d)], recebimento: ["recebimento", (d) => ven.detalheDoRecebimento(d)],
  "documento-cofre": ["documento", (d) => adm.detalheDocumentoCofre(d)],
  documento: ["conferencias/documento", (d) => conf.detalheDocumento(d, ctxPainel())], proposta: ["conferencias/proposta", (d) => conf.detalheProposta(d, ctxPainel())],
  correspondencia: ["conferencias/correspondencia", (d) => conf.detalheCorrespondencia(d)],
};
/** URL e desenho do detalhe. A chave é "tipo:resto" — o resto pode conter ":" (chave de pendência). */
function detalheDe(chave) {
  const i = chave.indexOf(":");
  const [tipo, id] = [chave.slice(0, i), chave.slice(i + 1)];
  if (tipo === "pendencia") return [`/api/fv2/conferencias/pendencia?${qs({ chave: id })}`, (d) => conf.detalhePendencia(d, { pessoas: estado.pessoas ?? [], competencia: estado.competencia })];
  if (tipo === "categoria") return [`/api/fv2/configuracoes/categoria?${qs({ competencia: undefined, codigo: id })}`, (d) => adm.detalheCategoria(d, { podeConfigurar: permissoesDaUnidade().includes("financeiro_v2.configurar") })];
  if (tipo === "importar") return [`/api/fv2/conferencias/catalogo?${qs({ competencia: undefined })}`, (d) => conf.escolherArquivo(d)];
  const [rota, desenho] = DETALHES[tipo] ?? DETALHES.receber;
  return [`/api/fv2/${rota}?${qs({ competencia: undefined, id })}`, desenho];
}
async function abrirDetalhe(chave, origem) {
  // Pendência: a lista de pessoas com acesso (para escolher responsável) vem do servidor, uma vez por unidade.
  if (chave.startsWith("pendencia:") && estado.pessoas === null) {
    const r = await consultorPainel.consultar(`/api/fv2/pessoas?${qs({ competencia: undefined })}`, cabecalhos());
    estado.pessoas = r?.ok ? r.dados.pessoas : [];
  }
  const [url, desenho] = detalheDe(chave);
  return abrirNoPainel(url, desenho, origem);
}

/**
 * 06D — arquivo do cofre: pedido com a sessão (cabeçalho), revalidado no servidor. Visualizar: PDF limpo num quadro a
 * partir de um blob (a CSP da página só permite quadro de blob:); baixar: arquivo salvo com nome neutro. Nada de link
 * público: a URL do blob só existe nesta aba e é revogada em seguida.
 */
let urlDoVisualizador = null;
async function arquivoDoDocumento(id, finalidade, origem) {
  const area = document.getElementById("visualizador");
  if (area) area.textContent = "Carregando o arquivo…";
  let r;
  try {
    r = await fetch(`/api/fv2/documentos/arquivo?${qs({ competencia: undefined, id, finalidade })}`, { headers: cabecalhos(), credentials: "same-origin" });
  } catch {
    if (area) area.textContent = "Não foi possível obter o arquivo agora.";
    return;
  }
  if (!r.ok) {
    const corpo = await r.json().catch(() => ({}));
    if (area) area.innerHTML = `<p class="aviso aviso--alerta">${esc(corpo.mensagem ?? "Arquivo indisponível.")}</p>`;
    return;
  }
  const blob = await r.blob();
  if (urlDoVisualizador) URL.revokeObjectURL(urlDoVisualizador);
  urlDoVisualizador = URL.createObjectURL(blob);
  if (finalidade === "visualizar") {
    if (area) area.innerHTML = `<iframe class="quadro-pdf" title="Visualização do documento (somente leitura)" src="${esc(urlDoVisualizador)}"></iframe>`;
    return;
  }
  const a = document.createElement("a");
  a.href = urlDoVisualizador;
  a.download = (r.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "documento.bin";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (area) area.textContent = "Download iniciado.";
  origem?.focus();
}
function fecharPainel(restaurarFoco = true) {
  const painel = $("#painel");
  if (!painel || painel.hidden) return;
  painel.hidden = true;
  if (restaurarFoco && focoAntesDoPainel?.isConnected) focoAntesDoPainel?.focus(); // volta ao ponto exato de onde o usuário abriu
  // Depois de uma ação gravada no painel, a lista da tela é consultada de novo (nunca fica com dado velho). A lista é
  // redesenhada: o foco volta ao botão equivalente (mesmo destino) ou, se ele não existir mais, ao conteúdo.
  if (recarregarAoFechar) {
    recarregarAoFechar = false;
    const destino = restaurarFoco ? focoAntesDoPainel?.getAttribute?.("data-detalhe") ?? focoAntesDoPainel?.getAttribute?.("data-secao") : null;
    carregar().then(() => {
      if (!restaurarFoco) return;
      const alvo = destino ? [...document.querySelectorAll("#conteudo [data-detalhe], #conteudo [data-secao]")].find((x) => (x.dataset.detalhe ?? x.dataset.secao) === destino) : null;
      (alvo ?? $("#conteudo")).focus();
    });
  }
  focoAntesDoPainel = null;
}

/**
 * Executa uma AÇÃO da demonstração (formulário `data-acao`): exige a caixa de confirmação, envia o token CSRF e mostra o
 * resultado real. Botão desabilitado durante o envio (sem confirmação duplicada por clique repetido).
 */
async function executarAcao(form) {
  const saida = form.querySelector(".resultado-acao");
  const botao = form.querySelector('button[type="submit"]');
  const dados = Object.fromEntries(new FormData(form).entries());
  if (!form.querySelector('[name="confirmar"]')?.checked) { saida.textContent = "Marque a confirmação para continuar."; return; }
  const corpo = { ...dados, confirmar: true, unidade: estado.unidade };
  if ("aceitarPendencias" in dados) corpo.aceitarPendencias = true;
  botao.disabled = true;
  saida.textContent = "Enviando…";
  const r = await enviar(form.dataset.acao, corpo, { ...cabecalhos(), "x-fv2-csrf": estado.csrf ?? "" });
  saida.innerHTML = conf.resultadoDaAcao(r);
  if (!r.ok) { botao.disabled = false; return; }
  recarregarAoFechar = true;
  const proximo = form.dataset.recarregar ?? "";
  if (proximo === "lista") { recarregarAoFechar = false; carregar(); return; }
  if (proximo === "resultado:documento" && r.dados.importacao?.id) { abrirDetalhe(`documento:${r.dados.importacao.id}`, form); return; }
  if (proximo.includes(":")) abrirDetalhe(proximo, form);
}

function rotear() {
  aplicarFiltrosDaUrl({ comRevisao: true });
  for (const a of document.querySelectorAll("[data-rota]")) a.setAttribute("aria-current", a.dataset.rota === estado.rota ? "page" : "false");
  carregar();
}

/**
 * Filtros vindos da URL (ligações de outras telas). Reaplicados também depois de trocar sessão ou unidade, para a tela
 * nunca mostrar uma seção diferente da que a URL indica. `revisar` só vale na navegação (não reabre ao trocar de sessão).
 */
function aplicarFiltrosDaUrl({ comRevisao = false } = {}) {
  const [pedida, consulta = ""] = location.hash.replace(/^#\//, "").split("?");
  estado.rota = ROTAS.includes(pedida) ? pedida : "visao-geral";
  if (estado.rota === "vendas-e-recebimentos" && consulta) {
    // Ligação de outra tela (ex.: Visão Geral → Balcão): só filtros conhecidos; o resto é ignorado.
    const p = new URLSearchParams(consulta);
    estado.filtros[estado.rota] = { aba: "vendas", ...Object.fromEntries(FILTROS_URL_VENDAS.filter((k) => p.get(k)).map((k) => [k, p.get(k)])) };
    estado.pagina[estado.rota] = 1;
  }
  if (estado.rota === "conferencias" && consulta) {
    const p = new URLSearchParams(consulta);
    estado.filtros.conferencias = { secao: "resumo", ...Object.fromEntries(FILTROS_URL_CONFERENCIAS.filter((k) => p.get(k)).map((k) => [k, p.get(k)])) };
    estado.pagina.conferencias = 1;
    // A ligação pode trazer a competência do registro (ex.: movimento de outro mês): a tela inteira passa a ela.
    if (/^\d{4}-\d{2}$/.test(p.get("competencia") ?? "")) { estado.competencia = p.get("competencia"); $("#filtro-competencia").value = estado.competencia; }
    const revisar = /^[A-Z_]+:[A-Za-z0-9_:.-]+$/.test(p.get("revisar") ?? "") ? p.get("revisar") : null;
    revisarAoCarregar = comRevisao ? revisar : null;
    if (revisar) estado.filtros.conferencias.secao = "pendencias";
  }
}

/** Lê o formulário de filtros locais da tela atual e recarrega (sempre da 1ª página). */
function aplicarFiltroLocal(form) {
  const rota = form.dataset.filtroLocal;
  const dados = Object.fromEntries(new FormData(form).entries());
  const anterior = estado.filtros[rota] ?? {};
  estado.filtros[rota] = { ...dados, soCompetencia: form.querySelector('[name="soCompetencia"]')?.checked ?? false };
  if (rota === "vendas-e-recebimentos") {
    // Valor digitado em reais → centavos por texto (sem ponto flutuante); inválido é ignorado.
    estado.filtros[rota].valorMinimoCentavos = ven.reaisParaCentavos(dados.valorMinimo);
    estado.filtros[rota].valorMaximoCentavos = ven.reaisParaCentavos(dados.valorMaximo);
  }
  if (rota === "fluxo-de-caixa") {
    // Editar as datas à mão vira "personalizado"; escolher um período pronto ignora as datas digitadas.
    const datasMudaram = dados.inicio !== anterior.inicioExibido || dados.fim !== anterior.fimExibido;
    if (dados.preset === anterior.preset && datasMudaram && anterior.inicioExibido !== undefined) estado.filtros[rota].preset = "personalizado";
    estado.filtros[rota].inicioExibido = dados.inicio;
    estado.filtros[rota].fimExibido = dados.fim;
  }
  estado.pagina[rota] = 1;
  carregar();
}

document.addEventListener("click", (e) => {
  const alternar = e.target.closest("[data-alternar]");
  if (alternar) {
    const alvo = document.getElementById(alternar.getAttribute("aria-controls"));
    const aberto = alternar.getAttribute("aria-expanded") === "true";
    alternar.setAttribute("aria-expanded", String(!aberto));
    if (alvo) alvo.hidden = aberto;
    return;
  }
  const aba = e.target.closest("[data-aba]");
  if (aba) {
    const anterior = estado.filtros["vendas-e-recebimentos"] ?? {};
    // Filtros comuns permanecem; os específicos de cada aba não vazam para a outra.
    estado.filtros["vendas-e-recebimentos"] = { aba: aba.dataset.aba, canal: anterior.canal, forma: anterior.forma, processador: anterior.processador };
    estado.pagina["vendas-e-recebimentos"] = 1;
    carregar().then(() => document.querySelector(`[data-aba="${aba.dataset.aba}"]`)?.focus());
    return;
  }
  const secaoConfig = e.target.closest("[data-secao-config]");
  if (secaoConfig) {
    estado.filtros.configuracoes = { secao: secaoConfig.dataset.secaoConfig };
    carregar().then(() => document.querySelector(`[data-secao-config="${secaoConfig.dataset.secaoConfig}"]`)?.focus());
    return;
  }
  const ver = e.target.closest("[data-documento-ver]");
  if (ver) { arquivoDoDocumento(ver.dataset.documentoVer, "visualizar", ver); return; }
  const baixar = e.target.closest("[data-documento-baixar]");
  if (baixar) { arquivoDoDocumento(baixar.dataset.documentoBaixar, "baixar", baixar); return; }
  const secao = e.target.closest("[data-secao]");
  if (secao) {
    estado.filtros.conferencias = { secao: secao.dataset.secao };
    estado.pagina.conferencias = 1;
    carregar().then(() => document.querySelector(`nav [data-secao="${secao.dataset.secao}"]`)?.focus());
    return;
  }
  const comp = e.target.closest("[data-composicao]");
  if (comp) { abrirPainel(comp.dataset.composicao, comp); return; }
  const det = e.target.closest("[data-detalhe]");
  if (det) { abrirDetalhe(det.dataset.detalhe, det); return; }
  const pag = e.target.closest("[data-pagina]");
  if (pag && !pag.disabled) { estado.pagina[pag.dataset.alvo] = Number(pag.dataset.pagina); carregar(); return; }
  const mes = e.target.closest("[data-mes]");
  if (mes) { estado.competencia = somarMes(estado.competencia, Number(mes.dataset.mes)); $("#filtro-competencia").value = estado.competencia; estado.diaSelecionado = null; carregar(); return; }
  const dia = e.target.closest("[data-dia]");
  if (dia && estado.calendario) {
    estado.diaSelecionado = dia.dataset.dia;
    for (const b of document.querySelectorAll("[data-dia]")) { b.classList.toggle("cal-dia--sel", b === dia); b.setAttribute("aria-pressed", String(b === dia)); }
    $("#dia-detalhe").innerHTML = tes.diaDoCalendario(estado.calendario.dias.find((d) => d.data === estado.diaSelecionado));
    return;
  }
  if (e.target.closest("[data-fechar-painel]") || e.target.id === "painel") fecharPainel();
});
document.addEventListener("change", (e) => {
  const form = e.target.closest("[data-filtro-local]");
  if (form) aplicarFiltroLocal(form);
});
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const acao = e.target.closest("[data-acao]");
  if (acao) { executarAcao(acao); return; }
  const form = e.target.closest("[data-filtro-local]");
  if (form) aplicarFiltroLocal(form);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPainel(); });
window.addEventListener("hashchange", rotear);
$("#filtro-competencia").addEventListener("change", (e) => { estado.competencia = e.target.value; estado.pagina = {}; estado.diaSelecionado = null; carregar(); });
const reiniciarFiltros = () => { estado.filtros = filtrosIniciais(); estado.pagina = {}; estado.diaSelecionado = null; estado.pessoas = null; estado.configuracoes = null; aplicarFiltrosDaUrl(); };
$("#filtro-unidade").addEventListener("change", (e) => { estado.unidade = e.target.value; reiniciarFiltros(); carregar(); });
$("#filtro-sessao").addEventListener("change", (e) => { estado.sessao = e.target.value; estado.unidade = null; estado.unidades = []; reiniciarFiltros(); carregar(); });
rotear();
