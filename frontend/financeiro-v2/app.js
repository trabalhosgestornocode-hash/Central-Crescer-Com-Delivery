// Aplicação do Financeiro v2 (demonstração local): roteamento por hash, filtros, carregamento sem flash de dados antigos,
// expansões acessíveis, painel "Ver composição completa" e detalhes de títulos. Nenhum cálculo financeiro: só consome as
// consultas do motor. Datas de período (início/fim do mês, +30 dias) são só calendário, nunca valores.
import { criarConsultor } from "./consulta.js";
import * as telas from "./telas.js";
import * as tes from "./telasTesouraria.js";
import { esc } from "./formatar.js";

const $ = (s) => document.querySelector(s);
const consultor = criarConsultor();
const consultorPainel = criarConsultor();
const estado = {
  rota: "visao-geral", competencia: "2026-09", unidade: null, sessao: "gestor", unidades: [], dataBase: null,
  // Filtros locais de cada tela (sobrevivem à troca de rota; são zerados ao trocar de unidade ou sessão).
  filtros: { "contas-a-pagar": {}, "contas-a-receber": {}, "caixa-e-bancos": {}, "fluxo-de-caixa": { preset: "competencia", granularidade: "SEMANA" } },
  pagina: {}, calendario: null, diaSelecionado: null,
};
let focoAntesDoPainel = null;
const ROTAS = ["visao-geral", "dre", "contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa"];

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
  if (r.status === 401) return telas.estado("sem-sessao");
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
    case "contas-a-pagar": return `/api/fv2/contas-a-pagar?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, contraparteId: f.contraparteId, categoria: f.categoria, vencimentoDe: f.vencimentoDe, vencimentoAte: f.vencimentoAte, pagina, tamanho: 25 })}`;
    case "contas-a-receber": return `/api/fv2/contas-a-receber?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, tipo: f.tipo, processador: f.processador, pagina, tamanho: 25 })}`;
    case "caixa-e-bancos": return `/api/fv2/caixa-e-bancos?${qs({ competencia: undefined, inicio: f.inicio || inicioDoMes(estado.competencia), fim: f.fim || fimDoMes(estado.competencia), contaId: f.contaId, pagina, tamanho: 30 })}`;
    case "calendario": return `/api/fv2/calendario?${qs({ competencia: undefined, mes: estado.competencia })}`;
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
    case "contas-a-pagar": return tes.contasAPagar(dados, f);
    case "contas-a-receber": return tes.contasAReceber(dados, f);
    case "caixa-e-bancos": if (!f.contaId) f.contas = dados.contas.map((c) => ({ id: c.id, nome: c.nome })); return tes.caixaEBancos(dados, f);
    case "calendario": estado.calendario = dados; return tes.calendario(dados, { selecionado: estado.diaSelecionado?.startsWith(dados.mes) ? estado.diaSelecionado : null });
    case "fluxo-de-caixa": return tes.fluxoDeCaixa(dados, f);
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
}

function preencherUnidades() {
  const sel = $("#filtro-unidade");
  sel.innerHTML = estado.unidades.map((u) => `<option value="${esc(u.id)}">${esc(u.nome)}</option>`).join("");
  sel.value = estado.unidade ?? "";
}

async function abrirNoPainel(url, desenhar, origem) {
  focoAntesDoPainel = origem;
  const painel = $("#painel");
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
function abrirDetalhe(chave, origem) {
  const [tipo, id] = chave.split(":");
  const rota = tipo === "pagar" ? "conta-a-pagar" : "conta-a-receber";
  return abrirNoPainel(`/api/fv2/${rota}?${qs({ competencia: undefined, id })}`, tipo === "pagar" ? tes.detalheAPagar : tes.detalheAReceber, origem);
}
function fecharPainel(restaurarFoco = true) {
  const painel = $("#painel");
  if (!painel || painel.hidden) return;
  painel.hidden = true;
  if (restaurarFoco) focoAntesDoPainel?.focus(); // volta ao ponto exato de onde o usuário abriu (preserva o contexto)
}

function rotear() {
  const pedida = location.hash.replace(/^#\//, "");
  estado.rota = ROTAS.includes(pedida) ? pedida : "visao-geral";
  for (const a of document.querySelectorAll("[data-rota]")) a.setAttribute("aria-current", a.dataset.rota === estado.rota ? "page" : "false");
  carregar();
}

/** Lê o formulário de filtros locais da tela atual e recarrega (sempre da 1ª página). */
function aplicarFiltroLocal(form) {
  const rota = form.dataset.filtroLocal;
  const dados = Object.fromEntries(new FormData(form).entries());
  const anterior = estado.filtros[rota] ?? {};
  estado.filtros[rota] = { ...dados, soCompetencia: form.querySelector('[name="soCompetencia"]')?.checked ?? false };
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
  const form = e.target.closest("[data-filtro-local]");
  if (form) aplicarFiltroLocal(form);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPainel(); });
window.addEventListener("hashchange", rotear);
$("#filtro-competencia").addEventListener("change", (e) => { estado.competencia = e.target.value; estado.pagina = {}; estado.diaSelecionado = null; carregar(); });
const reiniciarFiltros = () => { estado.filtros = { "contas-a-pagar": {}, "contas-a-receber": {}, "caixa-e-bancos": {}, "fluxo-de-caixa": { preset: "competencia", granularidade: "SEMANA" } }; estado.pagina = {}; estado.diaSelecionado = null; };
$("#filtro-unidade").addEventListener("change", (e) => { estado.unidade = e.target.value; reiniciarFiltros(); carregar(); });
$("#filtro-sessao").addEventListener("change", (e) => { estado.sessao = e.target.value; estado.unidade = null; estado.unidades = []; reiniciarFiltros(); carregar(); });
rotear();
