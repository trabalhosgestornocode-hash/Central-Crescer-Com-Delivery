// Tela "Acesso Financeiro" do Painel SuperAdmin — gestão SIMPLES por unidade:
// escolher empresa e unidade, ligar/desligar o Financeiro e definir, por usuário, Sem acesso / Visualização / Operador /
// Gestor. Um botão Salvar grava tudo de uma vez (PUT .../unidades/:id/acessos). Quem valida e audita é o servidor;
// a tela nunca exibe um sucesso que o servidor não confirmou.
import { el, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { escapeHtml, secao, carregando, erro, selecao } from "./adminUi.js";
import {
  OPCOES_ACESSO, nivelDoSeletor, estadoDaEscrita, mudancas, montarPedido, resumoDoResultado,
} from "./adminAcessoFinanceiroModelo.js";

const sel = { organizacaoId: "", unidadeId: "" };
/** Estado vindo do servidor (inicial) e o que está na tela (atual). */
let inicial = null;
let atual = null;
let falhas = [];
const view = () => el("#adm-view");
const copiaDe = (est) => ({ habilitado: est.habilitado, niveis: Object.fromEntries(est.usuarios.map((u) => [u.id, u.nivel ?? null])) });

export async function viewAcessoFinanceiro() {
  view().innerHTML = carregando();
  try {
    const empresas = await adminApi.empresas({});
    const lista = Array.isArray(empresas) ? empresas : (empresas?.empresas ?? empresas?.itens ?? []);
    const unidades = sel.organizacaoId
      ? await adminApi.unidadesDaEmpresa(sel.organizacaoId).then((r) => (Array.isArray(r) ? r : (r?.unidades ?? [])))
      : [];
    inicial = sel.unidadeId ? await adminApi.acessosFinanceirosDaUnidade(sel.unidadeId) : null;
    atual = inicial ? copiaDe(inicial) : null;
    desenhar({ empresas: lista, unidades });
  } catch (e) {
    view().innerHTML = erro("Não foi possível carregar o Acesso Financeiro: " + e.message);
  }
}

function seletorDeAcesso(u, bloqueado) {
  const valor = atual.niveis[u.id] ?? "";
  const opcoes = OPCOES_ACESSO
    .filter((o) => o.valor === null || u.elegivel !== false || o.valor === u.nivel)   // sem vínculo: mostra o atual, só dá para remover
    .map((o) => `<option value="${escapeHtml(o.valor ?? "")}" ${(o.valor ?? "") === valor ? "selected" : ""}>${escapeHtml(o.rotulo)}</option>`)
    .join("");
  return `<select class="fa-nivel" data-perfil="${escapeHtml(u.id)}" aria-label="Acesso de ${escapeHtml(u.nome ?? "usuário")}" ${bloqueado ? "disabled" : ""}>${opcoes}</select>`;
}

function linhaUsuario(u, bloqueado) {
  const falha = falhas.find((f) => f.perfilId === u.id);
  const mudou = (atual.niveis[u.id] ?? null) !== (u.nivel ?? null);
  return `
    <li class="fa-usuario${mudou ? " fa-usuario--mudou" : ""}">
      <div class="fa-usuario-id">
        <span><b>${escapeHtml(u.nome ?? "—")}</b>${u.propria ? ' <span class="pill info">você</span>' : ""}${u.elegivel === false ? ' <span class="pill warn">sem vínculo</span>' : ""}</span>
        ${u.email ? `<small>${escapeHtml(u.email)}</small>` : ""}
        ${falha ? `<small class="fa-falha" role="alert">${escapeHtml(falha.mensagem)}</small>` : ""}
      </div>
      ${seletorDeAcesso(u, bloqueado)}
    </li>`;
}

function desenhar({ empresas, unidades }) {
  const filtros = `
    <div class="adm-filtros">
      ${selecao({ id: "fa-org", label: "Empresa", valor: sel.organizacaoId, vazio: "Selecione…",
        opcoes: empresas.map((e) => ({ valor: e.id, rotulo: e.nome })) })}
      ${selecao({ id: "fa-uni", label: "Unidade", valor: sel.unidadeId, vazio: sel.organizacaoId ? "Selecione…" : "Escolha a empresa",
        opcoes: unidades.map((u) => ({ valor: u.id, rotulo: u.nome })) })}
    </div>`;

  let corpo = '<p class="adm-nota">Escolha a empresa e a unidade.</p>';
  if (inicial) {
    const escrita = estadoDaEscrita(inicial);
    const bloqueado = !escrita.liberada;
    const m = mudancas(inicial, atual);
    const legenda = OPCOES_ACESSO.filter((o) => o.valor).map((o) => `<li><b>${escapeHtml(o.rotulo)}</b> — ${escapeHtml(o.descricao)}</li>`).join("");
    corpo = `
      ${bloqueado ? `<div class="adm-nota fin-adm-bloqueio" role="status"><b>Gravação desligada.</b> ${escapeHtml(escrita.mensagem)}</div>` : ""}
      <div class="fa-cartao">
        <label class="fa-chave">
          <input type="checkbox" id="fa-ligado" role="switch" ${atual.habilitado ? "checked" : ""} ${bloqueado ? "disabled" : ""} />
          <span class="fa-chave-trilho" aria-hidden="true"></span>
          <span class="fa-chave-texto"><b>Financeiro ${atual.habilitado ? "ligado" : "desligado"}</b> em ${escapeHtml(inicial.unidade.nome)}</span>
        </label>
        <p class="adm-nota">${atual.habilitado
          ? "Só quem tiver acesso abaixo vê o setor Financeiro."
          : "Ninguém vê o setor Financeiro nesta unidade, mesmo com acesso marcado abaixo."}${m.moduloMudou ? " Ao salvar, quem estiver usando a unidade precisará entrar de novo." : ""}</p>
      </div>
      <details class="fa-legenda"><summary>O que cada nível pode fazer</summary><ul>${legenda}</ul></details>
      ${inicial.usuarios.length
        ? `<ul class="fa-usuarios">${inicial.usuarios.map((u) => linhaUsuario(u, bloqueado)).join("")}</ul>`
        : '<div class="estado-mini">Nenhum usuário com vínculo ativo nesta unidade ou empresa.</div>'}
      <div class="fa-barra">
        <span id="fa-contagem">${m.total ? `${m.total} alteração(ões) não salva(s)` : "Nenhuma alteração"}</span>
        <div class="fa-barra-acoes">
          <button class="btn btn-ghost btn-sm" id="fa-descartar" ${m.total ? "" : "disabled"}>Descartar</button>
          <button class="btn btn-primary" id="fa-salvar" ${m.total && !bloqueado ? "" : "disabled"}>Salvar</button>
        </div>
      </div>`;
  }

  view().innerHTML = secao({
    titulo: "Acesso ao Dashboard Financeiro",
    nota: "Ligue o Financeiro na unidade e escolha quem pode acessar. Tudo fica registrado na auditoria.",
    corpo: `<div id="fa-raiz">${filtros}${corpo}</div>`,
  });
  ligar({ empresas, unidades });
}

function ligar(ctx) {
  const raiz = el("#fa-raiz");
  raiz.querySelector("#fa-org")?.addEventListener("change", (e) => { sel.organizacaoId = e.target.value; sel.unidadeId = ""; falhas = []; viewAcessoFinanceiro(); });
  raiz.querySelector("#fa-uni")?.addEventListener("change", (e) => { sel.unidadeId = e.target.value; falhas = []; viewAcessoFinanceiro(); });
  if (!inicial) return;
  raiz.querySelector("#fa-ligado")?.addEventListener("change", (e) => { atual.habilitado = e.target.checked; desenhar(ctx); el("#fa-ligado")?.focus(); });
  raiz.querySelectorAll(".fa-nivel").forEach((s) => s.addEventListener("change", (e) => {
    const perfil = e.target.dataset.perfil;
    atual.niveis[perfil] = nivelDoSeletor(e.target.value || null);
    desenhar(ctx);
    el(`.fa-nivel[data-perfil="${CSS.escape(perfil)}"]`)?.focus();
  }));
  raiz.querySelector("#fa-descartar")?.addEventListener("click", () => { atual = copiaDe(inicial); falhas = []; desenhar(ctx); });
  raiz.querySelector("#fa-salvar")?.addEventListener("click", async (e) => {
    const botao = e.currentTarget;
    botao.disabled = true; botao.textContent = "Salvando…";
    try {
      const r = await adminApi.salvarAcessosFinanceirosDaUnidade(sel.unidadeId, montarPedido(inicial, atual));
      toast(resumoDoResultado(r));
      falhas = r?.falhas ?? [];
      inicial = r?.estado ?? inicial;
      atual = copiaDe(inicial);
      desenhar(ctx);
    } catch (err) {
      toast("Não foi possível salvar: " + err.message);
      botao.disabled = false; botao.textContent = "Salvar";
    }
  });
}
