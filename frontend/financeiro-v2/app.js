// Aplicação do Financeiro v2 (demonstração local): roteamento por hash, filtros, carregamento sem flash de dados antigos,
// expansões acessíveis, painel "Ver composição completa" e detalhes de títulos. Nenhum cálculo financeiro: só consome as
// consultas do motor. Datas de período (início/fim do mês, +30 dias) são só calendário, nunca valores.
import { criarConsultor } from "./consulta.js";
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
  return { "contas-a-pagar": {}, "contas-a-receber": {}, "caixa-e-bancos": {}, "fluxo-de-caixa": { preset: "competencia", granularidade: "SEMANA" }, "vendas-e-recebimentos": { aba: "vendas" } };
}
let focoAntesDoPainel = null;
const ROTAS = ["visao-geral", "dre", "contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa", "vendas-e-recebimentos"];
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
    case "contas-a-pagar": return tes.contasAPagar(dados, f);
    case "contas-a-receber": return tes.contasAReceber(dados, f);
    case "caixa-e-bancos": if (!f.contaId) f.contas = dados.contas.map((c) => ({ id: c.id, nome: c.nome })); return tes.caixaEBancos(dados, f);
    case "calendario": estado.calendario = dados; return tes.calendario(dados, { selecionado: estado.diaSelecionado?.startsWith(dados.mes) ? estado.diaSelecionado : null });
    case "fluxo-de-caixa": return tes.fluxoDeCaixa(dados, f);
    case "vendas-e-recebimentos": return ven.vendasERecebimentos(dados, f);
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
const DETALHES = {
  pagar: ["conta-a-pagar", (d) => tes.detalheAPagar(d)], receber: ["conta-a-receber", (d) => tes.detalheAReceber(d)],
  venda: ["venda", (d) => ven.detalheDaVenda(d)], recebimento: ["recebimento", (d) => ven.detalheDoRecebimento(d)],
};
function abrirDetalhe(chave, origem) {
  const [tipo, id] = chave.split(":");
  const [rota, desenho] = DETALHES[tipo] ?? DETALHES.receber;
  return abrirNoPainel(`/api/fv2/${rota}?${qs({ competencia: undefined, id })}`, desenho, origem);
}
function fecharPainel(restaurarFoco = true) {
  const painel = $("#painel");
  if (!painel || painel.hidden) return;
  painel.hidden = true;
  if (restaurarFoco && focoAntesDoPainel?.isConnected) focoAntesDoPainel?.focus(); // volta ao ponto exato de onde o usuário abriu
  focoAntesDoPainel = null;
}

function rotear() {
  const [pedida, consulta = ""] = location.hash.replace(/^#\//, "").split("?");
  estado.rota = ROTAS.includes(pedida) ? pedida : "visao-geral";
  if (estado.rota === "vendas-e-recebimentos" && consulta) {
    // Ligação de outra tela (ex.: Visão Geral → Balcão): só filtros conhecidos; o resto é ignorado.
    const p = new URLSearchParams(consulta);
    estado.filtros[estado.rota] = { aba: "vendas", ...Object.fromEntries(FILTROS_URL_VENDAS.filter((k) => p.get(k)).map((k) => [k, p.get(k)])) };
    estado.pagina[estado.rota] = 1;
  }
  for (const a of document.querySelectorAll("[data-rota]")) a.setAttribute("aria-current", a.dataset.rota === estado.rota ? "page" : "false");
  carregar();
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
const reiniciarFiltros = () => { estado.filtros = filtrosIniciais(); estado.pagina = {}; estado.diaSelecionado = null; };
$("#filtro-unidade").addEventListener("change", (e) => { estado.unidade = e.target.value; reiniciarFiltros(); carregar(); });
$("#filtro-sessao").addEventListener("change", (e) => { estado.sessao = e.target.value; estado.unidade = null; estado.unidades = []; reiniciarFiltros(); carregar(); });
rotear();
