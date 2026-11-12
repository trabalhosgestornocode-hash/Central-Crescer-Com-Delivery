// Aplicação do Financeiro v2 (demonstração local): roteamento por hash, filtros, carregamento sem flash de dados antigos,
// expansões acessíveis e painel "Ver composição completa". Nenhum cálculo financeiro: só consome as consultas do motor.
import { criarConsultor } from "./consulta.js";
import * as telas from "./telas.js";
import { esc } from "./formatar.js";

const $ = (s) => document.querySelector(s);
const consultor = criarConsultor();
const consultorPainel = criarConsultor();
const estado = { rota: "visao-geral", competencia: "2026-09", unidade: null, sessao: "gestor", unidades: [] };
let focoAntesDoPainel = null;

const cabecalhos = () => ({ "x-fv2-demo-sessao": estado.sessao });
const qs = (extra = {}) => new URLSearchParams({ competencia: estado.competencia, unidade: estado.unidade ?? "", ...extra }).toString();
const nomeUnidade = () => estado.unidades.find((u) => u.id === estado.unidade)?.nome ?? "";

function mensagemDeErro(r) {
  if (r.status === 401) return telas.estado("sem-sessao");
  if (r.status === 403) return telas.estado("negado", r.mensagem);
  return telas.estado("erro", r.mensagem);
}

/** Aplica pesos da barra (CSP proíbe estilo inline no HTML). */
function aplicarPesos(raiz) {
  for (const el of raiz.querySelectorAll("[data-peso]")) el.style.flexGrow = el.dataset.peso;
}

async function carregar() {
  const conteudo = $("#conteudo");
  // Sem flash: a tela anterior some ANTES de qualquer consulta; nada de outra competência/unidade fica visível.
  conteudo.innerHTML = telas.estado("carregando");
  conteudo.setAttribute("aria-busy", "true");
  fecharPainel(false);
  if (!estado.unidade) {
    const s = await consultor.consultar("/api/fv2/sessao", cabecalhos());
    if (!s) return;
    if (!s.ok) { conteudo.innerHTML = mensagemDeErro(s); conteudo.removeAttribute("aria-busy"); return; }
    estado.unidades = s.dados.unidades;
    estado.unidade = s.dados.unidades[0]?.id ?? null;
    preencherUnidades();
    if (!estado.unidade) { conteudo.innerHTML = telas.estado("negado", "Nenhuma unidade liberada para o Financeiro v2."); conteudo.removeAttribute("aria-busy"); return; }
  }
  const url = estado.rota === "dre" ? `/api/fv2/dre?${qs()}` : `/api/fv2/visao-geral?${qs()}`;
  const r = await consultor.consultar(url, cabecalhos());
  if (r === null) return; // resposta obsoleta: outra consulta mais nova já está em andamento
  conteudo.removeAttribute("aria-busy");
  if (!r.ok) { conteudo.innerHTML = mensagemDeErro(r); return; }
  conteudo.innerHTML = estado.rota === "dre" ? telas.dre(r.dados, { unidadeNome: nomeUnidade() }) : telas.visaoGeral(r.dados, { unidadeNome: nomeUnidade() });
  aplicarPesos(conteudo);
}

function preencherUnidades() {
  const sel = $("#filtro-unidade");
  sel.innerHTML = estado.unidades.map((u) => `<option value="${esc(u.id)}">${esc(u.nome)}</option>`).join("");
  sel.value = estado.unidade ?? "";
}

async function abrirPainel(codigo, origem) {
  focoAntesDoPainel = origem;
  const painel = $("#painel");
  painel.hidden = false;
  painel.querySelector(".painel-conteudo").innerHTML = telas.estado("carregando");
  painel.querySelector(".painel-conteudo").focus();
  const r = await consultorPainel.consultar(`/api/fv2/composicao?${qs({ codigo })}`, cabecalhos());
  if (r === null) return;
  painel.querySelector(".painel-conteudo").innerHTML = r.ok ? telas.composicao(r.dados, { unidadeNome: nomeUnidade() }) : mensagemDeErro(r);
  painel.querySelector("[data-fechar-painel]")?.focus();
}
function fecharPainel(restaurarFoco = true) {
  const painel = $("#painel");
  if (!painel || painel.hidden) return;
  painel.hidden = true;
  if (restaurarFoco) focoAntesDoPainel?.focus(); // volta ao ponto exato de onde o usuário abriu (preserva o contexto)
}

function rotear() {
  estado.rota = location.hash === "#/dre" ? "dre" : "visao-geral";
  for (const a of document.querySelectorAll("[data-rota]")) a.setAttribute("aria-current", a.dataset.rota === estado.rota ? "page" : "false");
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
  if (e.target.closest("[data-fechar-painel]") || e.target.id === "painel") fecharPainel();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPainel(); });
window.addEventListener("hashchange", rotear);
document.querySelector(".filtros").addEventListener("submit", (e) => e.preventDefault());
$("#filtro-competencia").addEventListener("change", (e) => { estado.competencia = e.target.value; carregar(); });
$("#filtro-unidade").addEventListener("change", (e) => { estado.unidade = e.target.value; carregar(); });
$("#filtro-sessao").addEventListener("change", (e) => { estado.sessao = e.target.value; estado.unidade = null; estado.unidades = []; carregar(); });
rotear();
