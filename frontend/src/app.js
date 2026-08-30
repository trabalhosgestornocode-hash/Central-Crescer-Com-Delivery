// Entry-point da plataforma — amarra estado, sessão, navegação e eventos.
//
// O boot agora tem QUATRO telas possíveis, e a decisão entre elas é o coração
// do fluxo novo:
//
//   login    -> não autenticado
//   selecao  -> autenticado, com 2+ acessos e sem contexto escolhido
//   app      -> autenticado com contexto (tenant)
//   admin    -> autenticado como SuperAdmin da plataforma
//
// Regra que resolve os casos de borda: com UM único acesso, entra direto (não
// faz sentido pedir para escolher entre uma opção). Sem nenhum acesso e sem ser
// superadmin, a tela de seleção explica a situação em vez de mostrar uma lista
// vazia sem contexto.

import { state, tabelaAtiva, emComparacao } from "./state.js";
import { MENU, SECOES, TABELAS, INTEGRACOES } from "./config.js";
import { el, els, toast } from "./utils.js";
import { carregarCmv, obterTabelasComerciaisUnidade } from "./api.js";
import { comparacaoSalvaDaUnidade, salvarComparacao, limparComparacaoSalva } from "./comparacaoTabela.js";
import {
  login, logout, restaurarSessao, listarAcessos, selecionarContexto,
  restaurarContexto, encerrarContexto, aplicarContexto,
  precisaDefinirSenha, definirNovaSenha, temModulo,
  listarUnidadesContexto, trocarUnidadeDoContexto,
} from "./sessao.js";
import { irPara, renderRotaAtual, primeiraRotaAcessivel } from "./router.js";
import { resetarEscopoDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { acoes } from "./actions.js";
import { getLinha, contarAlertas } from "./views.js";
import { abrirProdutoModal, abrirProdutoPorNome } from "./produtoModal.js";
import { abrirInsumoPorNome } from "./insumoModal.js";
import { abrirParserCancelamentos, abrirParserPedidoPorNumero, aguardarCarregamentoParser } from "./parserFoodDelivery.js";
import { registrarResolverAcao } from "./agenteAcoesResolvedores.js";
import { aplicarTemaSalvo } from "./configuracoes.js";
import { abrirPainelAdmin, fecharPainelAdmin } from "./admin.js";
import { initTooltips } from "./tooltip.js";
import { icon } from "./icons.js";
import { montarPainelGlobal, alternarPainel } from "./agentePainel.js";
import { montarSelecao, registrarAcessoRecente } from "./selecaoAmbiente.js";
import { montarSeletorUnidade } from "./seletorUnidade.js";

// ---------- Ações de navegação do Agente Crescer (Etapa F.1) ----------
// Registradas UMA vez, aqui — app.js é o topo do grafo de imports (nada o
// importa de volta), então é o único lugar onde dá pra puxar router.js E as
// views de detalhe sem criar ciclo (ver agenteAcoesResolvedores.js). Cada
// resolver só chama código REAL do Crescer — nunca constrói URL/rota.
function registrarAcoesDoAgente() {
  registrarResolverAcao("dashboard_executivo", () => irPara("dashboard-executivo"));
  registrarResolverAcao("products_cmv", () => irPara("produtos"));
  registrarResolverAcao("product_detail", async (params) => { irPara("produtos"); await abrirProdutoPorNome(params.productName); });
  registrarResolverAcao("ingredients", () => irPara("insumos"));
  registrarResolverAcao("ingredient_detail", async (params) => { irPara("insumos"); await abrirInsumoPorNome(params.ingredientName); });
  registrarResolverAcao("parser", () => irPara("parser-food-delivery"));
  // parser_cancelamentos/parser_order esperam o carregamento terminar antes
  // de trocar de aba/procurar o pedido — irPara() nunca espera a view (é
  // fire-and-forget), então sem isto a busca quase sempre "não encontraria
  // nada" mesmo quando o pedido existe (ver parserFoodDelivery.js#aguardarCarregamentoParser).
  registrarResolverAcao("parser_cancelamentos", async () => {
    irPara("parser-food-delivery");
    await aguardarCarregamentoParser();
    abrirParserCancelamentos();
  });
  registrarResolverAcao("parser_order", async (params) => {
    irPara("parser-food-delivery");
    await aguardarCarregamentoParser();
    await abrirParserPedidoPorNumero(params.orderNumber);
  });
}

// ---------- sidebar ----------
function montarMenu() {
  el("#menu").innerHTML = SECOES.map((secao) => {
    // Um item sem `modulo` é sempre visível; com `modulo`, só se a empresa do
    // contexto atual contratou (ver sessao.js#temModulo — bloqueio real está
    // na API, isto aqui é só não oferecer o que já sabemos que vai dar 403).
    const itens = MENU.filter((m) => m.secao === secao && (!m.modulo || temModulo(m.modulo)));
    if (!itens.length) return "";
    return `<li class="menu-secao">${secao}</li>` + itens.map((m) => {
      const logo = (m.integ && INTEGRACOES[m.integ]?.logo) || m.logo;
      const icone = logo ? `<img src="${logo}" alt="" class="m-logo" />` : icon(m.icon, { size: 18 });
      return `
      <li data-rota="${m.id}">
        <span class="m-icon">${icone}</span>
        <span class="m-label">${m.label}</span>
        ${m.tipo === "construcao" ? '<span class="m-tag">em breve</span>' : ""}
      </li>`;
    }).join("");
  }).join("");
  els("#menu li[data-rota]").forEach((li) => li.addEventListener("click", () => irPara(li.dataset.rota)));
}

// Relógio em tempo real (topbar)
let relogioIniciado = false;
function iniciarRelogio() {
  if (relogioIniciado) return;
  relogioIniciado = true;
  const upd = () => { const r = el("#relogio"); if (r) r.textContent = new Date().toLocaleTimeString("pt-BR"); };
  upd();
  setInterval(upd, 1000);
}

function setSync(estado, texto) {
  const box = el("#sync-status");
  if (box) box.dataset.estado = estado;
  const t = el("#sync-text");
  if (t) t.textContent = texto;
}

function atualizarNotif() {
  const badge = el("#notif-badge");
  if (!badge) return;
  const n = contarAlertas(state.linhas);
  badge.textContent = n;
  badge.hidden = n === 0;
}

// ---------- filtros globais (canal / comparar tabela) ----------
// O select #tabela NUNCA muda a configuração da unidade — é só "ver outra
// tabela pra comparar". A opção "Tabela oficial" (valor especial) volta pra
// ela. A tabela oficial em si só muda em Configurações → Tabelas Comerciais
// (ver configuracoes.js), com permissão própria.
const VALOR_OFICIAL = "__oficial__";
function popularTabelas() {
  const sel = el("#tabela");
  const oficial = state.tabelasOficiais[state.canal];
  const rotuloOficial = oficial ? `★ Tabela oficial (${oficial})` : "★ Tabela oficial (não configurada)";
  const opcoes = [`<option value="${VALOR_OFICIAL}">${rotuloOficial}</option>`]
    .concat(TABELAS[state.canal].map((t) => `<option value="${t}">Comparar: ${t}</option>`));
  sel.innerHTML = opcoes.join("");
  sel.value = state.tabelaComparacao ?? VALOR_OFICIAL;
}

/** Muda o canal, canal SÓ ele — nunca decide tabela sozinho (isso é sempre backend). */
function definirCanal(canal) {
  state.canal = canal === "ifood" ? "ifood" : "balcao";
  state.tabelaComparacao = null; // trocar de canal sai do modo de comparação — tabelas de canais diferentes não se comparam
  limparComparacaoSalva();
  popularTabelas();
  carregar();
}

/** Seleção no #tabela: ou volta pra oficial, ou entra em comparação (nunca grava na unidade). */
function definirComparacao(valorSelecionado) {
  const unidadeId = state.sessao?.unidade?.id;
  if (valorSelecionado === VALOR_OFICIAL) {
    state.tabelaComparacao = null;
    limparComparacaoSalva();
  } else {
    state.tabelaComparacao = valorSelecionado;
    if (unidadeId) salvarComparacao({ unidadeId, canal: state.canal, tabela: valorSelecionado });
  }
  carregar();
}

// ---------- carregamento de dados ----------
// Fase F (auditoria de race condition ao trocar de unidade): esta é a tabela
// PRINCIPAL do app (Dashboard/CMV) — a mais visível de todas, e a única que
// ainda não conferia a geração do contexto antes de aplicar a resposta.
// Sem isto: usuário na unidade A dispara `carregar()` (request lenta), troca
// pra unidade B pelo seletor global (`mostrarApp()` chama `carregar()` de
// novo, geração sobe), e se a request da unidade A responder DEPOIS da de B,
// `state.linhas` acabava sobrescrito com o CMV da unidade errada — a tela
// mostraria "Unidade B" no topbar com dados da Unidade A na tabela. Mesmo
// padrão de proteção que vendas.js#carregarSecao e api.js#chamar já usam.
async function carregar() {
  const g = geracaoContexto();
  state.carregando = true;
  state.erro = null;
  setSync("sync", "Sincronizando…");
  el("#btn-refresh")?.classList.add("girando");
  renderRotaAtual();
  try {
    const r = await carregarCmv(state.canal, state.tabelaComparacao);
    if (contextoMudou(g)) return; // resposta de uma unidade que já não é mais a atual — descarta
    state.linhas = r.linhas;
    // A resposta é a fonte de verdade da tabela oficial (nunca o que este
    // cliente supôs antes de perguntar) — mantém o seletor em sincronia
    // mesmo que outra aba/usuário tenha alterado a configuração da unidade.
    state.tabelasOficiais = { ...state.tabelasOficiais, [r.canal]: r.tabelaOficial };
    state.atualizadoEm = Date.now();
    setSync("ok", "Sincronizado " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
  } catch (e) {
    if (contextoMudou(g)) return;
    // "Tabela comercial não configurada" não é uma falha de rede — é um
    // estado real e esperado (unidade pendente de configurar). Mostra a
    // mensagem certa, sem o banner genérico de "falha na sincronização".
    state.erro = e.message;
    state.erroCodigo = e.codigo ?? null;
    state.linhas = [];
    setSync(e.codigo ? "aviso" : "erro", e.codigo ? "Tabela comercial não configurada" : "Falha na sincronização");
  } finally {
    if (contextoMudou(g)) return; // a chamada mais recente (unidade atual) já cuida do próprio ciclo
    state.carregando = false;
    el("#btn-refresh")?.classList.remove("girando");
    popularTabelas(); // reflete a tabela oficial atualizada (rótulo "★ Tabela oficial (E)")
    atualizarNotif();
    renderRotaAtual();
  }
}

// ---------- troca de telas ----------
const TELAS = { login: "#login-screen", senha: "#senha-screen", selecao: "#selecao-screen", app: "#app", admin: "#admin" };

/** Mostra uma tela e esconde as outras. Estado de tela é exclusivo por design. */
function mostrarTela(qual) {
  // A decisão de qual tela mostrar já foi tomada — o splash de boot (ver
  // index.html) não tem mais motivo pra existir, em nenhum dos caminhos
  // (login, seleção, senha, app ou admin).
  el("#boot-loading")?.remove();
  for (const [nome, sel] of Object.entries(TELAS)) {
    const nodo = el(sel);
    if (nodo) nodo.hidden = nome !== qual;
  }
  fecharMenusUsuario();
  if (qual !== "admin") fecharPainelAdmin();
}

// Pinta a topbar + o menu do usuário a partir de state.sessao. Idempotente —
// chamado por mostrarApp (entrada no shell) e pelo evento
// `app:contexto-atualizado` (ex.: renomear a unidade em Configurações deve
// refletir no topbar/seletor sem novo login).
function atualizarCabecalho() {
  const { usuario, empresa, unidade, papelRotulo, impersonando } = state.sessao;
  const nome = usuario?.nome || usuario?.email || "usuário";

  el("#user-nome").textContent = nome;
  el("#user-avatar").textContent = (nome[0] || "U").toUpperCase();
  el("#user-empresa").textContent = unidade?.nome ? `${empresa?.nome} · ${unidade.nome}` : (empresa?.nome ?? "—");
  montarSeletorUnidade({ onTrocar: trocarUnidadeRapido });
  el("#um-nome").textContent = nome;
  el("#um-email").textContent = usuario?.email ?? "—";
  el("#um-papel").textContent = impersonando ? "SuperAdmin (suporte)" : (papelRotulo ?? "—");
  // "Painel SuperAdmin" só aparece para quem é superadmin — inclusive durante
  // uma impersonação, que é justamente quando o caminho de volta importa.
  el("#um-painel").hidden = !state.sessao.superadmin;
  // Trocar de unidade não faz sentido dentro de uma impersonação: o contexto
  // não veio de um vínculo do usuário, veio de um acesso de suporte.
  el("#um-trocar").hidden = !!impersonando;

  const barra = el("#imp-barra");
  barra.hidden = !impersonando;
  if (impersonando) el("#imp-empresa").textContent = empresa?.nome ?? "—";
}

// ---------- tela: app (tenant) ----------
async function mostrarApp() {
  // FUNIL ÚNICO de entrada no shell do tenant (seleção de unidade,
  // restauração de sessão e impersonação passam todos por aqui) — e por isso
  // o único lugar certo para invalidar o contexto anterior. Tem que ser a
  // PRIMEIRA coisa: qualquer render abaixo desta linha precisa enxergar
  // memória limpa, senão mostra dado da unidade anterior por alguns
  // milissegundos (ver contextoEscopo.js).
  resetarEscopoDeContexto();
  const g = geracaoContexto();

  const { unidade } = state.sessao;

  // Unidades escolhíveis no seletor global do topbar — buscado FRESCO a cada
  // entrada no shell (nunca reaproveita o snapshot de login em
  // `state.sessao.acessos`). É isto que resolve o "contexto sem saída": sem
  // isso, um F5 ou uma entrada por impersonação chegavam aqui com a lista
  // vazia e o seletor ficava sem nenhuma opção pra oferecer (ver
  // seletorUnidade.js). Falha de rede não trava a tela — o chip só fica
  // informativo (listarUnidadesContexto já trata o próprio erro).
  await listarUnidadesContexto();
  if (contextoMudou(g)) return; // outra troca já aconteceu enquanto isto buscava (Fase F)

  // Empresa com exatamente 1 unidade acessível e nenhuma selecionada: entra
  // direto nela — não faz sentido obrigar a escolher algo sem alternativa
  // (item 6 do pedido). Vale também em impersonação: `entrarComoEmpresa`
  // começa consolidado de propósito (o suporte pode querer o Dashboard
  // Executivo primeiro), mas se a empresa só TEM uma unidade, ficar preso no
  // aviso "selecione uma unidade" sem nenhuma alternativa é exatamente o bug
  // relatado — `trocarUnidadeDoContexto` já sabe continuar a impersonação.
  if (!unidade && state.sessao.unidadesDaEmpresa.length === 1) {
    try {
      await trocarUnidadeDoContexto({ unidadeId: state.sessao.unidadesDaEmpresa[0].id });
      mostrarApp();
      return;
    } catch {
      // Não foi possível entrar sozinho na única unidade — segue no modo
      // consolidado; o seletor (não interativo, com 1 unidade só) e os
      // avisos de módulo cobrem o que falta.
    }
  }

  mostrarTela("app");
  atualizarCabecalho();

  // Restaura o modo de comparação SÓ se for da MESMA unidade (sessionStorage
  // — sobrevive a um F5, nunca atravessa troca de unidade/empresa/logout;
  // ver comparacaoTabela.js). Unidade diferente (ou nenhuma comparação
  // salva): garante que não sobra nada de sessão anterior.
  const comparacaoSalva = unidade?.id ? comparacaoSalvaDaUnidade(unidade.id) : null;
  if (comparacaoSalva) {
    state.canal = comparacaoSalva.canal;
    state.tabelaComparacao = comparacaoSalva.tabela;
  } else {
    limparComparacaoSalva();
  }

  // Tabelas oficiais da unidade NOVA, ANTES de desenhar o seletor — evita
  // mostrar por um instante "★ Tabela oficial (não configurada)" quando na
  // verdade só ainda não perguntamos (carregar() também atualiza isto, mas
  // só do canal ativo; aqui pega os dois de uma vez pra Configurações e pro
  // rótulo do canal que NÃO está selecionado agora).
  try {
    const { data } = await obterTabelasComerciaisUnidade();
    state.tabelasOficiais = { balcao: data?.tabelaBalcao ?? null, ifood: data?.tabelaIfood ?? null };
  } catch { /* sem unidade selecionada, ou falha pontual — carregar() tenta de novo a seguir */ }

  montarMenu();
  iniciarRelogio();
  popularTabelas();
  montarPainelGlobal(); // idempotente — o Agente Crescer sobrevive a trocas de unidade/empresa, só reseta a conversa (ver agentePainel.js)
  irPara(primeiraRotaAcessivel());
  carregar();
}

// ---------- tela: seleção de unidade ----------
/** @param {{opcoes: Array<object>, superadmin: boolean}} dados */
function mostrarSelecao(dados) {
  mostrarTela("selecao");
  const nome = state.sessao.usuario?.nome || state.sessao.usuario?.email || "—";
  el("#sel-nome").textContent = nome;
  el("#sel-erro").hidden = true;
  el("#sel-admin").hidden = !dados.superadmin;

  if (!dados.opcoes.length) {
    // Depois da virada de acessos, este é o estado normal de uma conta nova:
    // existe, autentica, e ainda não foi associada a nenhuma empresa. Dizer
    // isso é melhor que mostrar uma lista vazia sem explicação.
    el("#sel-busca-wrap").hidden = true;
    el("#sel-recentes").hidden = true;
    el("#sel-lista").innerHTML = `
      <div class="sel-vazio">
        <span class="sel-vazio-ic">🔒</span>
        <h3>Nenhuma empresa vinculada à sua conta</h3>
        <p>${dados.superadmin
          ? "Como SuperAdmin, você administra a plataforma pelo painel — e pode associar acessos por lá."
          : "Seu acesso precisa ser liberado pelo administrador da plataforma. Fale com o responsável para ser associado a uma empresa."}</p>
      </div>`;
    return;
  }

  montarSelecao(dados, { usuarioId: state.sessao.usuario?.id, onEntrar: entrarNoContexto });
}

/**
 * Troca de unidade a partir do seletor global do topbar (item 12) — mesma
 * chamada de `entrarNoContexto`, sem passar pela tela de seleção nem por um
 * novo login. `mostrarApp()` já é o funil único que reseta o estado de cada
 * módulo e recarrega os dados para o contexto novo.
 * @param {object} opcao
 */
async function trocarUnidadeRapido(opcao) {
  await trocarUnidadeDoContexto({ unidadeId: opcao.unidadeId ?? null });
  // Impersonação não é um acesso pessoal do usuário — não faz sentido
  // aparecer nos "recentes" da tela de seleção (entrarPorImpersonacao já não
  // registrava; a troca rápida durante impersonação segue a mesma regra).
  if (!state.sessao.impersonando) registrarAcessoRecente(state.sessao.usuario?.id, opcao);
  mostrarApp();
}

/** @param {object} opcao @param {HTMLButtonElement} [botao] */
async function entrarNoContexto(opcao, botao) {
  if (!opcao?.acessivel) return;
  const erroBox = el("#sel-erro");
  erroBox.hidden = true;
  if (botao) { botao.disabled = true; botao.textContent = "Entrando…"; }
  try {
    await selecionarContexto({
      organizacaoId: opcao.organizacaoId,
      unidadeId: opcao.unidadeId ?? null,
      troca: true,
    });
    registrarAcessoRecente(state.sessao.usuario?.id, opcao);
    mostrarApp();
  } catch (e) {
    erroBox.textContent = e.message;
    erroBox.hidden = false;
    if (botao) { botao.disabled = false; botao.textContent = "Acessar"; }
  }
}

// ---------- tela: login ----------
function mostrarLogin() {
  mostrarTela("login");
  el("#login-pass").value = "";
}

// ---------- tela: definir senha (primeiro acesso) ----------
function mostrarSenha() {
  mostrarTela("senha");
  const nome = state.sessao.usuario?.nome || state.sessao.usuario?.email || "—";
  el("#senha-nome").textContent = nome;
  el("#senha-nova").value = "";
  el("#senha-conf").value = "";
  el("#senha-erro").hidden = true;
  avaliarRequisitosSenha();
  el("#senha-nova").focus();
}

function mostrarErroSenha(msg) {
  const box = el("#senha-erro");
  box.textContent = msg;
  box.hidden = false;
}

/** Marca cada requisito como cumprido enquanto o usuário digita. */
function avaliarRequisitosSenha() {
  const s = el("#senha-nova")?.value ?? "";
  const c = el("#senha-conf")?.value ?? "";
  const regras = {
    tam: s.length >= 8,
    letra: /[a-zA-Z]/.test(s),
    numero: /\d/.test(s),
    igual: s.length > 0 && s === c,
  };
  for (const [chave, ok] of Object.entries(regras)) {
    el(`#senha-reqs li[data-req="${chave}"]`)?.classList.toggle("ok", ok);
  }
  return Object.values(regras).every(Boolean);
}

// ---------- roteador de sessão ----------
/**
 * Decide para qual tela ir depois de autenticar. É o ÚNICO lugar que toma essa
 * decisão — espalhá-la é o que tornaria o fluxo imprevisível.
 * @param {{preferirAdmin?: boolean}} [opcoes]
 */
async function encaminhar({ preferirAdmin = false } = {}) {
  state.sessao.superadmin = !!state.sessao.usuario?.superadmin;

  // Senha provisória vem ANTES de tudo: enquanto não for trocada, o backend
  // bloqueia a API inteira, então nem adianta tentar restaurar contexto ou
  // listar acessos. Vale para todos, inclusive o SuperAdmin.
  if (precisaDefinirSenha()) {
    mostrarSenha();
    return;
  }

  // Contexto ainda válido (recarregou a página) — volta direto para o trabalho.
  if (!preferirAdmin && await restaurarContexto()) {
    mostrarApp();
    return;
  }

  const dados = await listarAcessos();

  // SuperAdmin sem vínculo nenhum é o caso esperado: o painel é a casa dele.
  if (dados.superadmin && (preferirAdmin || !dados.opcoes.length)) {
    abrirPainelAdmin({
      mostrarTela,
      aoEntrarEmEmpresa: entrarPorImpersonacao,
      aoSair: sairDeTudo,
      usuario: state.sessao.usuario,
    });
    return;
  }

  // Um único acesso: entra direto, sem pedir para escolher entre uma opção.
  const acessiveis = dados.opcoes.filter((o) => o.acessivel);
  if (acessiveis.length === 1 && !dados.superadmin) {
    try {
      await selecionarContexto({
        organizacaoId: acessiveis[0].organizacaoId,
        unidadeId: acessiveis[0].unidadeId ?? null,
      });
      mostrarApp();
      return;
    } catch {
      // Se a entrada automática falhar, cai na seleção, que mostra o motivo.
    }
  }

  mostrarSelecao(dados);
}

/** Recebe o contexto de impersonação vindo do painel e entra no shell tenant. */
function entrarPorImpersonacao(contexto) {
  aplicarContexto(contexto);
  mostrarApp();
  toast(`Você entrou em ${contexto.empresa?.nome ?? "a empresa"} como SuperAdmin.`);
}

async function sairDeTudo() {
  await logout();
  mostrarLogin();
}

// ---------- menus de usuário ----------
function fecharMenusUsuario() {
  for (const [chip, menu] of [
    ["#user-chip", "#user-menu"], ["#adm-user-chip", "#adm-user-menu"], ["#chip-unidade", "#unidade-menu"],
  ]) {
    const m = el(menu);
    if (m) m.hidden = true;
    el(chip)?.setAttribute("aria-expanded", "false");
  }
}

function ligarMenuUsuario(chipSel, menuSel) {
  const chip = el(chipSel);
  const menu = el(menuSel);
  if (!chip || !menu) return;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const abrir = menu.hidden;
    fecharMenusUsuario();
    menu.hidden = !abrir;
    chip.setAttribute("aria-expanded", String(abrir));
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
}

// ---------- eventos globais ----------
function wireEventos() {
  el("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erroBox = el("#login-erro");
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    try {
      erroBox.hidden = true;
      btn?.classList.add("carregando");
      if (btn) btn.disabled = true;
      await login(el("#login-user").value, el("#login-pass").value);
      await encaminhar();
    } catch (err) {
      erroBox.textContent = err.message;
      erroBox.hidden = false;
    } finally {
      btn?.classList.remove("carregando");
      if (btn) btn.disabled = false;
    }
  });

  el("#btn-logout").addEventListener("click", sairDeTudo);
  el("#adm-logout").addEventListener("click", sairDeTudo);
  el("#sel-sair").addEventListener("click", sairDeTudo);
  el("#senha-sair").addEventListener("click", sairDeTudo);

  // Definir senha (primeiro acesso): valida, envia, e segue o fluxo normal.
  ["#senha-nova", "#senha-conf"].forEach((sel) =>
    el(sel).addEventListener("input", avaliarRequisitosSenha));

  el("#senha-olho").addEventListener("click", () => {
    const inp = el("#senha-nova");
    const mostrar = inp.type === "password";
    inp.type = mostrar ? "text" : "password";
    el("#senha-olho").classList.toggle("ativo", mostrar);
    el("#senha-olho").setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
  });

  el("#senha-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erroBox = el("#senha-erro");
    const btn = el("#senha-btn");
    erroBox.hidden = true;

    const nova = el("#senha-nova").value;
    const conf = el("#senha-conf").value;
    // Barreira local antes de bater no servidor — o backend revalida de todo jeito.
    if (nova.length < 8) return mostrarErroSenha("A senha deve ter ao menos 8 caracteres.");
    if (nova !== conf) return mostrarErroSenha("As senhas não coincidem.");

    try {
      btn.classList.add("carregando");
      btn.disabled = true;
      await definirNovaSenha(nova);
      toast("Senha definida. Bem-vindo!");
      await encaminhar();   // a flag caiu → segue para seleção/painel/app
    } catch (err) {
      mostrarErroSenha(err.message);
    } finally {
      btn.classList.remove("carregando");
      btn.disabled = false;
    }
  });

  // Trocar unidade / trocar de empresa: encerra só o CONTEXTO e volta para a
  // seleção (login continua de pé). O botão do menu do usuário e o "Trocar de
  // empresa" do seletor global do topbar levam ao mesmo lugar — trocar
  // unidade DENTRO da empresa atual tem um caminho mais rápido, direto no
  // seletor global (ver trocarUnidadeRapido), que não passa por aqui.
  const trocarDeEmpresa = async () => {
    fecharMenusUsuario();
    await encerrarContexto();
    await encaminhar();
  };
  el("#um-trocar").addEventListener("click", trocarDeEmpresa);
  el("#um2-empresas").addEventListener("click", trocarDeEmpresa);

  el("#um-conta").addEventListener("click", () => {
    fecharMenusUsuario();
    irPara("configuracoes");
  });

  el("#um-painel").addEventListener("click", async () => {
    fecharMenusUsuario();
    await encaminhar({ preferirAdmin: true });
  });

  el("#sel-admin").addEventListener("click", () => encaminhar({ preferirAdmin: true }));

  el("#adm-um-empresas").addEventListener("click", async () => {
    fecharMenusUsuario();
    await encerrarContexto();
    mostrarSelecao(await listarAcessos());
  });

  // Sair da empresa (fim da impersonação) — volta ao painel da plataforma.
  el("#imp-sair").addEventListener("click", async () => {
    await encerrarContexto();
    await encaminhar({ preferirAdmin: true });
    toast("Você saiu da empresa e voltou ao painel da plataforma.");
  });

  ligarMenuUsuario("#user-chip", "#user-menu");
  ligarMenuUsuario("#adm-user-chip", "#adm-user-menu");
  ligarMenuUsuario("#chip-unidade", "#unidade-menu");
  document.addEventListener("click", fecharMenusUsuario);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharMenusUsuario(); });

  // Sessão expirada (401): o login caiu, volta para o login.
  document.addEventListener("app:sessao-expirada", async () => { await logout(); mostrarLogin(); });

  // Contexto inválido (409): o login está bom, só o contexto caiu. Volta para
  // a seleção — expulsar o usuário do sistema aqui seria desproporcional.
  document.addEventListener("app:contexto-invalido", async (e) => {
    toast(e.detail || "Contexto encerrado. Escolha a unidade novamente.");
    try { await encaminhar(); } catch { mostrarLogin(); }
  });

  // Configurações mudou algo do contexto (ex.: nome da unidade) — repinta a
  // topbar e o seletor SEM novo login. O detalhe traz a unidade já
  // atualizada; a lista do seletor é rebuscada fresca (tolerante a falha).
  document.addEventListener("app:contexto-atualizado", async (e) => {
    const u = e.detail?.unidade;
    if (u?.id && state.sessao.unidade?.id === u.id) {
      state.sessao.unidade = { ...state.sessao.unidade, ...u };
    }
    try { await listarUnidadesContexto(); } catch { /* chip fica informativo */ }
    atualizarCabecalho();
  });

  // "Selecionar unidade" dentro do aviso de um módulo bloqueado (item 11) —
  // abre o MESMO seletor global do topbar, nunca um fluxo paralelo (item 10).
  // Se não houver outra unidade pra oferecer (chip desabilitado), avisa em
  // vez de não fazer nada silenciosamente.
  document.addEventListener("app:abrir-seletor-unidade", () => {
    const chip = el("#chip-unidade");
    if (!chip || chip.disabled) { toast("Nenhuma outra unidade disponível para selecionar."); return; }
    chip.click();
  });

  // Mostrar/ocultar senha (UI apenas — não altera a lógica de login)
  const toggleSenha = el("#toggle-senha");
  if (toggleSenha) {
    toggleSenha.addEventListener("click", () => {
      const inp = el("#login-pass");
      const mostrar = inp.type === "password";
      inp.type = mostrar ? "text" : "password";
      toggleSenha.classList.toggle("ativo", mostrar);
      toggleSenha.setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
    });
  }

  el("#canal").addEventListener("change", (e) => definirCanal(e.target.value));
  el("#tabela").addEventListener("change", (e) => definirComparacao(e.target.value));

  document.addEventListener("app:reload", carregar);
  document.addEventListener("app:voltar-tabela-oficial", () => definirComparacao(VALOR_OFICIAL));

  // topbar: refresh manual + sino de notificações + Agente Crescer
  el("#btn-refresh")?.addEventListener("click", carregar);
  el("#btn-notif")?.addEventListener("click", () => irPara("dashboard"));
  el("#btn-agente")?.addEventListener("click", alternarPainel);

  // menu mobile
  el("#btn-menu").addEventListener("click", () => el("#app").classList.toggle("menu-aberto"));
  el("#backdrop").addEventListener("click", () => el("#app").classList.remove("menu-aberto"));

  // ações da tabela + clique no nome (delegação — funciona após re-render)
  el("#view").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-acao]");
    if (btn) {
      const row = getLinha(btn.dataset.idx);
      const fn = acoes[btn.dataset.acao];
      if (row && fn) fn(row);
      return;
    }
    const link = e.target.closest(".prod-link");
    if (link) {
      const row = getLinha(link.dataset.idx);
      if (row?.produto_id) abrirProdutoModal(row.produto_id);
    }
  });
}

// ---------- boot ----------
async function boot() {
  aplicarTemaSalvo();
  wireEventos();
  initTooltips();
  try {
    if (await restaurarSessao()) await encaminhar();
    else mostrarLogin();
  } catch {
    mostrarLogin();
  }
}
boot();
