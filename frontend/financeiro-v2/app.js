// Aplicação do Financeiro v2 (demonstração local): roteamento por hash, filtros, carregamento sem flash de dados antigos,
// expansões acessíveis, painel "Ver composição completa" e detalhes de títulos. Nenhum cálculo financeiro: só consome as
// consultas do motor. Datas de período (início/fim do mês, +30 dias) são só calendário, nunca valores.
import { criarConsultor, definirTransporte, enviar, invalidarCache } from "./consulta.js";
import { ROTAS_PLATAFORMA, aquecerCredenciais, credenciaisDaPlataforma, criarTransportePlataforma, emModoPlataforma, estadoDoErro, renovarCredenciaisDaPlataforma } from "./plataforma.js";
import * as telas from "./telas.js";
import * as tes from "./telasTesouraria.js";
import { definirFontesDaUnidade, esc } from "./formatar.js";
import { iniciarMenuRecolhivel } from "./menu.js";

// Módulos das telas pesadas: baixados SOB DEMANDA (só o da tela aberta entra no caminho da primeira pintura) e aquecidos logo depois
// da primeira tela útil. Os nomes abaixo são os mesmos usados no resto do arquivo (adm, conf, ven, can, calCanais, impCanais, ent).
let adm, conf, ven, can, calCanais, impCanais, ent;
const CARREGADORES = {
  adm: () => import("./telasAdministracao.js").then((m) => { adm = m; return m; }),
  conf: () => import("./telasConferencias.js").then((m) => { conf = m; return m; }),
  ven: () => import("./telasVendas.js").then((m) => { ven = m; return m; }),
  can: () => import("./telasCanais.js").then((m) => { can = m; return m; }),
  calCanais: () => import("./telasCalendarioCanais.js").then((m) => { calCanais = m; return m; }),
  impCanais: () => import("./telasImportacoesCanais.js").then((m) => { impCanais = m; return m; }),
  ent: () => import("./telasEntregadores.js").then((m) => { ent = m; return m; }),
};
const importados = new Map();
/** Garante os módulos pedidos. Falha de rede NÃO fica guardada: a próxima tentativa baixa de novo. */
function garantir(...nomes) {
  return Promise.all(nomes.map((n) => {
    if (!importados.has(n)) importados.set(n, CARREGADORES[n]().catch((e) => { importados.delete(n); throw e; }));
    return importados.get(n);
  }));
}
const garantirTodos = () => garantir(...Object.keys(CARREGADORES));
const CANAIS_MODULOS = ["can", "calCanais", "impCanais"];
const MODULOS_DA_ROTA = { "entregadores-proprios": ["ent"], saipos: CANAIS_MODULOS, swf: CANAIS_MODULOS, ifood: CANAIS_MODULOS, "noventa-e-nove-food": CANAIS_MODULOS, "operadoras-taxas": ["can"], configuracoes: ["adm"], documentos: ["adm"], "vendas-e-recebimentos": ["ven"], conferencias: ["conf"] };
let aquecido = false;
/** Depois da primeira tela útil, baixa o resto em tempo ocioso (a navegação entre abas fica instantânea). */
function aquecerModulos() {
  if (aquecido) return;
  aquecido = true;
  const f = () => garantirTodos().catch(() => { aquecido = false; });
  if (typeof requestIdleCallback === "function") requestIdleCallback(f, { timeout: 3000 }); else setTimeout(f, 1200);
}

const $ = (s) => document.querySelector(s);
/** Execução 10: dentro da Crescer (mesmo login, mesma unidade da sessão). Fora disso, é a demonstração local. */
const MODO_PLATAFORMA = emModoPlataforma();
if (MODO_PLATAFORMA) {
  definirTransporte(criarTransportePlataforma({ credenciais: credenciaisDaPlataforma, renovar: renovarCredenciaisDaPlataforma }));
  document.documentElement.dataset.modo = "plataforma";
  aquecerCredenciais(); // o token fica pronto enquanto os módulos terminam de carregar
  // Os links da plataforma existem desde a primeira pintura e não dependem da sessão financeira (funcionam também com ela vencida).
  for (const [id, href] of [["#link-operacional", ROTAS_PLATAFORMA.operacional], ["#link-plataforma", ROTAS_PLATAFORMA.inicio]]) {
    const a = document.querySelector(id);
    if (a) a.href = href;
  }
}
const consultor = criarConsultor();
const consultorPainel = criarConsultor();
const consultorCalendario = criarConsultor();
const consultorImportacoes = criarConsultor();
// Consulta da tela adiantada na plataforma (sai junto com a da sessão): consultor próprio, para uma não abortar a outra.
const consultorAdiantado = criarConsultor();
// Fontes de faturamento da unidade (decidem menu e canais): consultor próprio, para sair junto com a sessão sem abortar nada.
const consultorFontes = criarConsultor();
let numeroDoCarregamento = 0;
/** A URL sem o parâmetro `unidade`: na plataforma o servidor a ignora (a unidade é a da sessão), então duas URLs que só diferem nela são a MESMA consulta. */
const semUnidade = (url) => String(url).replace(/([?&])unidade=[^&]*(&|$)/, (_, ini, fim) => (fim ? ini : "")).replace(/[?&]$/, "");
/** Mês de hoje em São Paulo ("2026-11"): o mesmo que o servidor usa como competência inicial (dataBase). */
const mesDeHojeEmSaoPaulo = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(new Date());
const estado = {
  rota: "visao-geral", competencia: "2026-09", unidade: null, sessao: "gestor", unidades: [], dataBase: null,
  // Filtros locais de cada tela (sobrevivem à troca de rota; são zerados ao trocar de unidade ou sessão).
  filtros: filtrosIniciais(),
  pagina: {}, calendario: null, diaSelecionado: null,
  // Fase 10: calendário de faturamento do canal da tela (dados do servidor) e o dia escolhido nele.
  calCanal: null, calDia: null,
  // Fase 11: importações do canal da tela (formatos, histórico, demonstrativos) — só quando a aba Importações está aberta.
  impCanal: null,
};
function filtrosIniciais() {
  return { saipos: { aba: "resumo" }, swf: { aba: "resumo" }, ifood: { aba: "resumo" }, "noventa-e-nove-food": { aba: "resumo" }, "contas-a-pagar": {}, "contas-a-receber": {}, "caixa-e-bancos": {}, "fluxo-de-caixa": { preset: "competencia", granularidade: "SEMANA" }, "vendas-e-recebimentos": { aba: "vendas" }, conferencias: { secao: "resumo" }, configuracoes: { secao: "unidade" }, documentos: {}, "entregadores-proprios": { aba: "resumo" } };
}
let focoAntesDoPainel = null;
let recarregarAoFechar = false;
let revisarAoCarregar = null;
const ROTAS = ["visao-geral", "dre", "saipos", "swf", "ifood", "noventa-e-nove-food", "operadoras-taxas", "lancamentos", "contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa", "vendas-e-recebimentos", "entregadores-proprios", "conferencias", "configuracoes", "documentos"];
/** Filtros aceitos na URL da Central (ligações de outras telas). `revisar` abre o painel da pendência indicada. */
const FILTROS_URL_CONFERENCIAS = ["secao", "grupo", "situacao", "estado"];
const ENDPOINT_DA_SECAO = { resumo: "conferencias", pendencias: "conferencias/pendencias", documentos: "conferencias/documentos", propostas: "conferencias/propostas", conciliacoes: "conferencias/correspondencias", fechamento: "conferencias/fechamento" };
const permissoesDaUnidade = () => estado.unidades.find((u) => u.id === estado.unidade)?.permissoes ?? [];
/** Filtros aceitos na URL de Vendas e Recebimentos (ligação vinda de outras telas). Nada além disso é lido da URL. */
const FILTROS_URL_VENDAS = ["aba", "canal", "forma", "processador", "situacao", "recebimento", "codigo", "tipoComponente", "identificador"];
const ENDPOINT_DA_ABA = { vendas: "vendas", pagamentos: "vendas/pagamentos", taxas: "vendas/taxas", recebiveis: "vendas/recebiveis", divergencias: "vendas/divergencias" };

const cabecalhos = () => ({ "x-fv2-demo-sessao": estado.sessao });
/**
 * Execução 10 — modo plataforma: sem seletor de sessão nem de unidade (a unidade é a da sessão da Crescer); competência
 * inicial = mês da data-base do servidor; ações escondidas quando a escrita está desligada (o servidor recusa de todo jeito).
 */
function modoPlataforma(dados) {
  if (!estado.competenciaDaSessao && typeof dados.dataBase === "string") {
    estado.competenciaDaSessao = true;
    estado.competencia = dados.dataBase.slice(0, 7);
    const campo = document.querySelector("#filtro-competencia");
    if (campo) campo.value = estado.competencia;
  }
  document.documentElement.dataset.escrita = dados.escritaHabilitada ? "sim" : "nao";
  const quem = document.querySelector("#topo-usuario");
  if (quem) { quem.textContent = `Usuário: ${dados.usuario ?? "autenticado"}`; quem.hidden = false; }
}
/** 08B: homologação full stack — esconde o seletor de perfil da demonstração; mostra quem entrou e permite sair. */
function modoHomologacao(usuario) {
  const seletor = document.querySelector("#filtro-sessao");
  if (!seletor || seletor.dataset.homologacao) return;
  seletor.dataset.homologacao = "1";
  // Homologação NÃO é demonstração nem produção: o aviso diz exatamente isso.
  const faixa = document.querySelector(".faixa-demo");
  if (faixa) faixa.textContent = "Ambiente de homologação · dados de teste · não é a produção";
  const rotulo = seletor.closest("label") ?? seletor;
  rotulo.hidden = true;
  const quem = document.createElement("span");
  quem.className = "usuario-logado";
  quem.textContent = `Usuário: ${usuario ?? "autenticado"}`;
  const sair = document.createElement("button");
  sair.type = "button";
  sair.textContent = "Sair";
  sair.addEventListener("click", async () => {
    invalidarCache(); // ao encerrar a sessão, nada financeiro fica guardado na aba
    await fetch("/api/fv2/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
    window.location.assign("/entrar");
  });
  rotulo.after(quem, sair);
}
const qs = (extra = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ competencia: estado.competencia, unidade: MODO_PLATAFORMA ? undefined : (estado.unidade ?? ""), ...extra }).filter(([, v]) => v !== undefined && v !== null && v !== false))).toString();
const nomeUnidade = () => estado.unidades.find((u) => u.id === estado.unidade)?.nome ?? "";

// ---- datas de calendário (apresentação de período, sem valores)
const dataUTC = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const somarDias = (d, n) => { const x = dataUTC(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const inicioDoMes = (m) => `${m}-01`;
const fimDoMes = (m) => { const [a, mm] = m.split("-").map(Number); return iso(new Date(Date.UTC(a, mm, 0))); };
const somarMes = (m, n) => { const [a, mm] = m.split("-").map(Number); const d = new Date(Date.UTC(a, mm - 1 + n, 1)); return iso(d).slice(0, 7); };

const ehSessaoExpirada = (r) => !r?.ok && (MODO_PLATAFORMA ? estadoDoErro(r).tipo === "sem-sessao" : r?.status === 401);
const LINKS_DA_PLATAFORMA = [{ rotulo: "Voltar à plataforma", href: ROTAS_PLATAFORMA.inicio }, { rotulo: "Dashboard Operacional", href: ROTAS_PLATAFORMA.operacional }];
function mensagemDeErro(r, { compacto = false } = {}) {
  if (MODO_PLATAFORMA) {
    const e = estadoDoErro(r);
    if (e.tipo === "sem-sessao") return telas.estado("sem-sessao", e.mensagem, { titulo: "Sua sessão expirou", compacto, acoes: [{ rotulo: "Entrar novamente", href: ROTAS_PLATAFORMA.entrar, primario: true }, ...LINKS_DA_PLATAFORMA] });
    if (e.tipo === "sem-contexto") return telas.estado("sem-contexto", e.mensagem, { compacto, acoes: [{ rotulo: "Escolher a unidade", href: ROTAS_PLATAFORMA.inicio, primario: true }, LINKS_DA_PLATAFORMA[1]] });
    if (e.tipo === "negado") return telas.estado("negado", e.mensagem, { compacto, acoes: LINKS_DA_PLATAFORMA });
    return telas.estado(e.tipo, e.mensagem, { compacto });
  }
  if (r.status === 401) return telas.estado("sem-sessao", /expirad/i.test(r.mensagem ?? "") ? "Sua sessão expirou. Entre novamente: nada foi gravado." : "");
  if (r.status === 403) return telas.estado("negado", r.mensagem);
  return telas.estado("erro", r.mensagem);
}

// ---- Entrada em etapas. O menu e os canais só são montados quando a unidade é conhecida E as fontes dela foram carregadas.
//   identificando → configurando → carregando → pronto   (ou erro / sessao-expirada)
const BOOT = Object.freeze({ IDENTIFICANDO: "identificando", CONFIGURANDO: "configurando", CARREGANDO: "carregando", PRONTO: "pronto", ERRO: "erro", SESSAO_EXPIRADA: "sessao-expirada" });
function definirBoot(etapa) { estado.boot = etapa; document.documentElement.dataset.boot = etapa; }
const definirDados = (situacao) => { document.documentElement.dataset.dados = situacao; }; // carregando | disponivel | erro
const NOME_DA_FONTE = Object.freeze({ SAIPOS: "SAIPOS", SWF: "SWF", IFOOD: "iFood", NOVENTA_E_NOVE_FOOD: "99Food" });
/** Aplica as fontes da unidade: itens do menu, grupo vazio escondido, permissões e a linha de fontes do cabeçalho. */
function aplicarFontes(fontes) {
  definirFontesDaUnidade(fontes); // as telas leem daqui: nada do sistema de loja que a unidade não usa
  const usadas = new Set(fontes.fontes ?? []);
  for (const li of document.querySelectorAll("li[data-fonte]")) li.hidden = !usadas.has(li.dataset.fonte);
  const perm = permissoesDaUnidade();
  for (const li of document.querySelectorAll("li[data-exige]")) li.hidden = MODO_PLATAFORMA && !perm.includes(li.dataset.exige);
  for (const grupo of document.querySelectorAll(".nav-grupo")) grupo.hidden = ![...grupo.querySelectorAll("li")].some((li) => !li.hidden);
  const sub = $("#topo-fontes");
  if (sub) sub.textContent = `Faturamento: ${(fontes.fontes ?? []).map((f) => NOME_DA_FONTE[f] ?? f).join(" · ")}`;
}
/** Sessão vencida: some tudo que era financeiro (dados, unidade, painel, cache) e a tela passa a dizer só o que fazer. */
function sessaoExpirada(r) {
  numeroDoCarregamento += 1;
  for (const c of [consultor, consultorPainel, consultorCalendario, consultorImportacoes, consultorAdiantado, consultorFontes]) c.cancelar();
  invalidarCache();
  definirFontesDaUnidade(null);
  Object.assign(estado, { unidades: [], unidade: null, fontesDaUnidade: null, calendario: null, calCanal: null, calDia: null, impCanal: null, pessoas: null, configuracoes: null, pessoasDemo: [], csrf: null, diaSelecionado: null, dataBase: null });
  recarregarAoFechar = false; revisarAoCarregar = null;
  fecharPainel(false);
  const alvo = $("#painel .painel-conteudo");
  if (alvo) alvo.innerHTML = "";
  const nome = $("#topo-unidade"); if (nome) nome.textContent = "Sessão encerrada";
  const fontes = $("#topo-fontes"); if (fontes) fontes.textContent = "";
  const quem = $("#topo-usuario"); if (quem) { quem.textContent = ""; quem.hidden = true; }
  definirBoot(BOOT.SESSAO_EXPIRADA);
  definirDados("erro");
  const conteudo = $("#conteudo");
  conteudo.innerHTML = mensagemDeErro(r ?? { ok: false, status: 401, erro: "SEM_SESSAO", motivo: "SESSAO_EXPIRADA", mensagem: "" });
  conteudo.removeAttribute("aria-busy");
}

/** Aplica pesos da barra (CSP proíbe estilo inline no HTML). */
function aplicarPesos(raiz) {
  for (const el of raiz.querySelectorAll("[data-peso]")) el.style.flexGrow = el.dataset.peso;
}

/** Fase 10 — calendário de faturamento do canal da tela (SAIPOS Presencial/Anota Aí, iFood, 99Food): UMA consulta mensal consolidada. */
function consultaDoCalendario() {
  const canal = estado.rota === "saipos" ? { presencial: "BALCAO", anota: "ANOTA_AI" }[estado.filtros.saipos?.aba] : estado.rota === "swf" && !["importacoes", "sangrias"].includes(estado.filtros.swf?.aba) ? "BALCAO" : estado.rota === "ifood" && estado.filtros.ifood?.aba !== "importacoes" ? "IFOOD" : estado.rota === "noventa-e-nove-food" && estado.filtros["noventa-e-nove-food"]?.aba !== "importacoes" ? "NOVENTA_E_NOVE_FOOD" : null;
  return canal ? `/api/fv2/calendario-faturamento?${qs({ competencia: undefined, canal, mes: estado.competencia })}` : null;
}
/** Fase 11 — importações do canal da tela, só quando a aba "Importações" está aberta (SAIPOS, iFood ou 99Food). */
function consultaDasImportacoes() {
  const canal = { saipos: estado.filtros.saipos?.aba === "importacoes" ? "SAIPOS" : null, swf: estado.filtros.swf?.aba === "importacoes" ? "SWF" : null, ifood: estado.filtros.ifood?.aba === "importacoes" ? "IFOOD" : null,
    "noventa-e-nove-food": estado.filtros["noventa-e-nove-food"]?.aba === "importacoes" ? "NOVENTA_E_NOVE_FOOD" : null }[estado.rota] ?? null;
  return canal ? `/api/fv2/importacoes-canal?${qs({ competencia: undefined, canal })}` : null;
}
const contextoDasImportacoes = () => ({ importacoes: estado.impCanal?.dados ?? null, importacoesErro: estado.impCanal?.erro ?? null });
/** Contexto do calendário que as telas de canal recebem (só dados do servidor e o dia escolhido). */
const contextoDoCalendario = () => ({
  calendario: estado.calCanal?.dados ?? null, calendarioErro: estado.calCanal?.erro ?? null,
  calDia: estado.calDia && estado.calDia.startsWith(estado.competencia) ? estado.calDia : null,
});

/** Consulta de cada rota: caminho + parâmetros, montados SÓ a partir do estado da tela. */
function consultaDaRota() {
  const f = estado.filtros[estado.rota] ?? {};
  const pagina = estado.pagina[estado.rota] ?? 1;
  switch (estado.rota) {
    case "dre": return `/api/fv2/dre?${qs()}`;
    case "entregadores-proprios": return `/api/fv2/entregadores?${qs({ competencia: undefined, semana: f.semana, selecao: f.semana ? undefined : "ULTIMA_FECHADA", mes: f.mes, entregador: f.entregador, situacao: f.situacao })}`;
    case "saipos": {
      // Período da área SAIPOS: o escolhido; senão o mês da competência (até a data-base, se for o mês corrente).
      if (f.competenciaBase !== estado.competencia || !f.inicio || !f.fim) {
        const fimMes = fimDoMes(estado.competencia);
        Object.assign(f, { competenciaBase: estado.competencia, inicio: inicioDoMes(estado.competencia), fim: estado.dataBase && estado.dataBase >= inicioDoMes(estado.competencia) && estado.dataBase < fimMes ? estado.dataBase : fimMes });
        estado.filtros.saipos = f;
      }
      const periodo = { competencia: undefined, periodoInicio: f.inicio, periodoFim: f.fim };
      return f.aba === "fechamento" ? `/api/fv2/fechamento-manual?${qs(periodo)}` : `/api/fv2/saipos?${qs(periodo)}`;
    }
    case "operadoras-taxas": {
      // 18/11/2026: período do painel — o escolhido; senão o mês da competência (até a data-base, se for o mês corrente).
      if (f.competenciaBase !== estado.competencia || !f.inicio || !f.fim) {
        const fimMes = fimDoMes(estado.competencia);
        Object.assign(f, { competenciaBase: estado.competencia, inicio: inicioDoMes(estado.competencia), fim: estado.dataBase && estado.dataBase >= inicioDoMes(estado.competencia) && estado.dataBase < fimMes ? estado.dataBase : fimMes });
        estado.filtros["operadoras-taxas"] = f;
      }
      return `/api/fv2/operadoras?${qs({ competencia: undefined, periodoInicio: f.inicio, periodoFim: f.fim })}`;
    }
    case "swf": return f.aba === "sangrias" ? `/api/fv2/sangrias-swf?${qs({ competencia: undefined, periodoInicio: inicioDoMes(estado.competencia), periodoFim: fimDoMes(estado.competencia) })}` : `/api/fv2/conferencia-swf?${qs({ competencia: undefined, mes: estado.competencia })}`;
    case "ifood": case "noventa-e-nove-food": return `/api/fv2/canal-plataforma?${qs({ canal: estado.rota === "ifood" ? "IFOOD" : "NOVENTA_E_NOVE_FOOD" })}`;
    case "configuracoes": return f.secao === "fontes" ? `/api/fv2/fontes-faturamento?${qs({ competencia: undefined })}` : f.secao === "plano" ? `/api/fv2/configuracoes/plano?${qs({ competencia: undefined })}` : f.secao === "permissoes" ? `/api/fv2/permissoes?${qs({ competencia: undefined })}` : f.secao === "abertura" ? `/api/fv2/abertura?${qs({ competencia: undefined })}` : f.secao === "taxas" ? `/api/fv2/taxas-contratadas?${qs({})}` : `/api/fv2/configuracoes?${qs({ competencia: undefined })}`;
    case "documentos": return `/api/fv2/documentos?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, pagina, tamanho: 25 })}`;
    case "contas-a-pagar": return `/api/fv2/contas-a-pagar?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, contraparteId: f.contraparteId, categoria: f.categoria, vencimentoDe: f.vencimentoDe, vencimentoAte: f.vencimentoAte, pagina, tamanho: 25 })}`;
    case "contas-a-receber": return `/api/fv2/contas-a-receber?${qs({ competencia: f.soCompetencia ? estado.competencia : "", situacao: f.situacao, tipo: f.tipo, processador: f.processador, pagina, tamanho: 25 })}`;
    case "lancamentos": return `/api/fv2/caixa-e-bancos?${qs({ competencia: undefined, inicio: inicioDoMes(estado.competencia), fim: fimDoMes(estado.competencia), pagina: 1, tamanho: 30 })}`;
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
    case "entregadores-proprios": return ent.entregadoresProprios(dados, f, { permissoes: permissoesDaUnidade() });
    case "saipos": return can.saipos(dados, estado.filtros.saipos ?? {}, { permissoes: permissoesDaUnidade(), ...contextoDoCalendario(), ...contextoDasImportacoes(), abrirProvisorio: estado.filtros.saipos?.foco === "provisorio" });
    case "operadoras-taxas": return can.operadorasTaxas(dados, { permissoes: permissoesDaUnidade(), filtro: estado.filtros["operadoras-taxas"] ?? {} });
    case "swf": return can.swf(dados, { permissoes: permissoesDaUnidade(), aba: f.aba, ...contextoDoCalendario(), ...contextoDasImportacoes() });
    case "ifood": case "noventa-e-nove-food": return can.plataforma(dados, { permissoes: permissoesDaUnidade(), aba: f.aba, ...contextoDoCalendario(), ...contextoDasImportacoes() });
    case "configuracoes": {
      const perm = permissoesDaUnidade();
      const ctx = { unidadeNome: nomeUnidade(), podeConfigurar: perm.includes("financeiro_v2.configurar"), pessoasDemo: estado.pessoasDemo ?? [], permissoes: perm };
      const corpo = f.secao === "plano" ? { plano: dados, configuracoes: estado.configuracoes } : f.secao === "permissoes" ? { permissoes: dados } : dados;
      if (!f.secao || !["plano", "permissoes", "abertura", "taxas", "fontes"].includes(f.secao)) estado.configuracoes = dados;
      if (f.secao === "abertura" && dados?.configuracoes) estado.configuracoes = dados.configuracoes;
      return adm.configuracoes(corpo, f, ctx);
    }
    case "documentos": return adm.documentos(dados, f);
    case "contas-a-pagar": return tes.contasAPagar(dados, f, { permissoes: permissoesDaUnidade() });
    case "contas-a-receber": return tes.contasAReceber(dados, f, { permissoes: permissoesDaUnidade(), competencia: estado.competencia });
    case "lancamentos": return tes.lancamentos(dados, f, { permissoes: permissoesDaUnidade() });
    case "caixa-e-bancos": if (!f.contaId) f.contas = dados.contas.map((c) => ({ id: c.id, nome: c.nome })); return tes.caixaEBancos(dados, f, { permissoes: permissoesDaUnidade() });
    case "calendario": estado.calendario = dados; return tes.calendario(dados, { selecionado: estado.diaSelecionado?.startsWith(dados.mes) ? estado.diaSelecionado : null });
    case "fluxo-de-caixa": return tes.fluxoDeCaixa(dados, f);
    case "vendas-e-recebimentos": return ven.vendasERecebimentos(dados, f);
    case "conferencias": return conf.central(dados, f, { competencia: estado.competencia, unidadeNome: nomeUnidade(), permissoes: permissoesDaUnidade() });
    default: return telas.visaoGeral(dados, { unidadeNome: nomeUnidade(), fontes: estado.fontesDaUnidade ?? null });
  }
}

async function carregar() {
  const meuCarregamento = (numeroDoCarregamento += 1);
  const conteudo = $("#conteudo");
  // Sem flash: a tela anterior some ANTES de qualquer consulta; nada de outra competência/unidade/filtro fica visível.
  conteudo.innerHTML = telas.estado("carregando");
  conteudo.setAttribute("aria-busy", "true");
  fecharPainel(false);
  definirDados("carregando");
  // Etapa da entrada: sem unidade conhecida = identificando; unidade conhecida mas sem as fontes dela = configurando. Nada de menu antes disso.
  if (!estado.unidade) definirBoot(BOOT.IDENTIFICANDO);
  else if (estado.fontesDaUnidade?.unidade !== estado.unidade) definirBoot(BOOT.CONFIGURANDO);
  else definirBoot(BOOT.CARREGANDO);
  // PLATAFORMA: a unidade é SEMPRE a da sessão (o servidor ignora a que vier daqui). Então a consulta da tela não precisa esperar a sessão:
  // sai JUNTO com ela. Só é aproveitada se a competência que a sessão escolher for a mesma que se supôs (mês de hoje); senão é descartada e refeita.
  let adiantada = null;
  if (MODO_PLATAFORMA && !estado.unidade && !estado.competenciaDaSessao) {
    const original = estado.competencia;
    estado.competencia = mesDeHojeEmSaoPaulo();
    const url = consultaDaRota();
    adiantada = { competencia: estado.competencia, url, promessa: consultorAdiantado.consultar(url, cabecalhos()) };
    estado.competencia = original;
  }
  // As fontes também só dependem da sessão da plataforma (a unidade é a dela): saem JUNTO com a sessão, em paralelo.
  const urlDasFontes = () => `/api/fv2/fontes-faturamento?${qs({ competencia: undefined })}`;
  let fontesAdiantadas = null;
  if (MODO_PLATAFORMA && !estado.unidade) fontesAdiantadas = consultorFontes.consultar(urlDasFontes(), cabecalhos());
  if (!estado.unidade) {
    const s = await consultor.consultar("/api/fv2/sessao", cabecalhos());
    if (!s) return;
    // 08B: na homologação full stack, sem sessão autenticada o servidor pede login (nunca há perfil escolhido pelo cliente).
    if (!s.ok && s.erro === "LOGIN_EXIGIDO") { window.location.assign("/entrar"); return; }
    if (!s.ok) {
      if (ehSessaoExpirada(s)) { sessaoExpirada(s); return; }
      definirBoot(BOOT.ERRO); definirDados("erro");
      conteudo.innerHTML = mensagemDeErro(s); conteudo.removeAttribute("aria-busy"); return;
    }
    if (s.dados.modo === "HOMOLOGACAO") modoHomologacao(s.dados.usuario);
    if (s.dados.modo === "PLATAFORMA") modoPlataforma(s.dados);
    estado.unidades = s.dados.unidades;
    estado.dataBase = s.dados.dataBase ?? null;
    estado.csrf = s.dados.csrf ?? null;
    estado.pessoasDemo = s.dados.pessoasDemo ?? [];
    estado.pessoas = null;
    estado.unidade = s.dados.unidades[0]?.id ?? null;
    preencherUnidades();
    const nomeNoTopo = $("#topo-unidade"); if (nomeNoTopo) nomeNoTopo.textContent = nomeUnidade();
    if (!estado.unidade) { conteudo.innerHTML = telas.estado("negado", "Nenhuma unidade liberada para o Crescer Com Delivery Financeiro."); conteudo.removeAttribute("aria-busy"); return; }
  }
  if (await carregarFontes(meuCarregamento, fontesAdiantadas, urlDasFontes)) return; // erro, sessão vencida ou a rota mudou (SAIPOS ↔ SWF)
  const urlDoCalendario = consultaDoCalendario();
  const doCalendario = urlDoCalendario ? consultorCalendario.consultar(urlDoCalendario, cabecalhos()) : null;
  const urlDasImportacoes = consultaDasImportacoes();
  const dasImportacoes = urlDasImportacoes ? consultorImportacoes.consultar(urlDasImportacoes, cabecalhos()) : null;
  const urlDaRota = consultaDaRota();
  const modulosDaTela = garantir(...(MODULOS_DA_ROTA[estado.rota] ?? [])); // em paralelo com a consulta
  let r;
  if (adiantada && semUnidade(adiantada.url) === semUnidade(urlDaRota)) {
    r = await adiantada.promessa;
    if (meuCarregamento !== numeroDoCarregamento) return; // outra navegação mais nova já começou
    if (r === null) r = await consultor.consultar(urlDaRota, cabecalhos());
  } else {
    r = await consultor.consultar(urlDaRota, cabecalhos());
  }
  if (r === null) return; // resposta obsoleta: outra consulta mais nova já está em andamento
  conteudo.removeAttribute("aria-busy");
  if (!r.ok) {
    if (ehSessaoExpirada(r)) { sessaoExpirada(r); return; }
    definirBoot(BOOT.PRONTO); definirDados("erro"); // a unidade e o menu estão certos; só esta consulta falhou
    conteudo.innerHTML = mensagemDeErro(r);
    return;
  }
  estado.calCanal = null;
  estado.impCanal = null;
  if (dasImportacoes) {
    const ri = await dasImportacoes;
    if (ri === null) return;
    estado.impCanal = ri.ok ? { dados: ri.dados } : { erro: ri.mensagem || "Não foi possível carregar as importações deste canal." };
  }
  if (doCalendario) {
    const rc = await doCalendario;
    if (rc === null) return; // outro calendário mais novo já foi pedido
    estado.calCanal = rc.ok ? { dados: rc.dados } : { erro: rc.mensagem || "Não foi possível carregar o calendário deste canal." };
  }
  try { await modulosDaTela; } catch {
    definirBoot(BOOT.PRONTO); definirDados("erro");
    conteudo.innerHTML = telas.estado("rede", "Não foi possível baixar esta tela. Confira a conexão e tente de novo; nada foi alterado.");
    return;
  }
  if (meuCarregamento !== numeroDoCarregamento) return;
  conteudo.innerHTML = desenhar(r.dados);
  aquecerModulos();
  definirDados("disponivel");
  definirBoot(BOOT.PRONTO);
  aplicarPesos(conteudo);
  if (revisarAoCarregar && estado.rota === "conferencias") {
    // Ligação de outra tela (ex.: Caixa e Bancos → crédito não identificado): abre a pendência; se não existir, o painel diz.
    const chave = revisarAoCarregar;
    revisarAoCarregar = null;
    abrirDetalhe(`pendencia:${chave}`, conteudo);
  }
}

/**
 * Doc 54 — o menu mostra o sistema de loja DA unidade (SAIPOS ou SWF) e só as plataformas que ela usa. Uma consulta por unidade.
 * Falha NUNCA vira "SAIPOS por padrão": sem as fontes, o menu não é montado e a tela mostra o erro (ou a sessão vencida).
 * Quem abrir a área do sistema que a unidade não usa é levado para a do sistema dela (o servidor recusa os arquivos de todo jeito).
 * @returns {Promise<boolean>} true = o carregamento deve parar aqui (erro, sessão vencida, obsoleto ou rota trocada)
 */
async function carregarFontes(meuCarregamento, adiantadas, urlDasFontes) {
  if (estado.fontesDaUnidade?.unidade !== estado.unidade) {
    const r = await (adiantadas ?? consultorFontes.consultar(urlDasFontes(), cabecalhos()));
    if (r === null || meuCarregamento !== numeroDoCarregamento) return true;
    if (!r.ok) {
      if (ehSessaoExpirada(r)) { sessaoExpirada(r); return true; }
      definirBoot(BOOT.ERRO); definirDados("erro");
      const conteudo = $("#conteudo");
      conteudo.innerHTML = mensagemDeErro(r);
      conteudo.removeAttribute("aria-busy");
      return true;
    }
    estado.fontesDaUnidade = { unidade: estado.unidade, ...r.dados };
  }
  aplicarFontes(estado.fontesDaUnidade);
  definirBoot(BOOT.CARREGANDO);
  const sistema = estado.fontesDaUnidade.sistemaDeLoja;
  const destino = sistema === "SWF" && estado.rota === "saipos" ? "swf" : sistema !== "SWF" && estado.rota === "swf" ? "saipos" : null;
  if (!destino) return false;
  window.location.hash = `#/${destino}`;
  return true;
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
  alvo.innerHTML = telas.estado("carregando", "", { compacto: true });
  alvo.focus();
  const r = await consultorPainel.consultar(url, cabecalhos());
  if (r === null) return;
  try { await garantirTodos(); } catch { alvo.innerHTML = telas.estado("rede", "Não foi possível baixar este detalhe. Confira a conexão e tente de novo.", { compacto: true }); return; }
  if (!r.ok && ehSessaoExpirada(r)) { sessaoExpirada(r); return; }
  alvo.innerHTML = r.ok ? desenhar(r.dados) : `<div class="painel-cabeca"><span></span><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar">×</button></div>${mensagemDeErro(r, { compacto: true })}`;
  painel.querySelector("[data-fechar-painel]")?.focus();
}
const abrirPainel = (codigo, origem) => abrirNoPainel(`/api/fv2/composicao?${qs({ codigo })}`, (d) => telas.composicao(d, { unidadeNome: nomeUnidade() }), origem);
const ctxPainel = () => ({ permissoes: permissoesDaUnidade(), competencia: estado.competencia });
const DETALHES = {
  pagar: ["conta-a-pagar", (d) => tes.detalheAPagar(d, ctxPainel())], receber: ["conta-a-receber", (d) => tes.detalheAReceber(d)],
  venda: ["venda", (d) => ven.detalheDaVenda(d)], recebimento: ["recebimento", (d) => ven.detalheDoRecebimento(d)],
  "documento-cofre": ["documento", (d) => adm.detalheDocumentoCofre(d)],
  documento: ["conferencias/documento", (d) => conf.detalheDocumento(d, ctxPainel())], proposta: ["conferencias/proposta", (d) => conf.detalheProposta(d, ctxPainel())],
  correspondencia: ["conferencias/correspondencia", (d) => conf.detalheCorrespondencia(d, ctxPainel())],
};
/** 08C — reclassificação: "reclassificacao:<lançamento>[|<categoria da prévia>]" e "reclassificacao-mov:<movimentação>". */
const DETALHE_RECLASSIFICACAO = (d) => conf.detalheReclassificacao(d);
/** URL e desenho do detalhe. A chave é "tipo:resto" — o resto pode conter ":" (chave de pendência). */
function detalheDe(chave) {
  const i = chave.indexOf(":");
  const [tipo, id] = [chave.slice(0, i), chave.slice(i + 1)];
  if (tipo === "pendencia") return [`/api/fv2/conferencias/pendencia?${qs({ chave: id })}`, (d) => conf.detalhePendencia(d, { pessoas: estado.pessoas ?? [], competencia: estado.competencia, permissoes: permissoesDaUnidade() })];
  if (tipo === "categoria") return [`/api/fv2/configuracoes/categoria?${qs({ competencia: undefined, codigo: id })}`, (d) => adm.detalheCategoria(d, { podeConfigurar: permissoesDaUnidade().includes("financeiro_v2.configurar") })];
  if (tipo === "reclassificacao") { const [lanc, categoria] = id.split("|"); return [`/api/fv2/reclassificacao?${qs({ competencia: undefined, id: lanc, categoria })}`, DETALHE_RECLASSIFICACAO]; }
  if (tipo === "reclassificacao-mov") return [`/api/fv2/reclassificacao?${qs({ competencia: undefined, movimentacao: id })}`, DETALHE_RECLASSIFICACAO];
  // 08E: prévia do vínculo de uma saída do extrato com a conta — "vinculo:<conta>|<saída>".
  if (tipo === "vinculo") { const [obrigacao, movimentacao] = id.split("|"); return [`/api/fv2/vinculo-extrato?${qs({ competencia: undefined, obrigacao, movimentacao })}`, (d) => tes.detalheVinculoExtrato(d, ctxPainel())]; }
  // Fase 05: lançamentos que compõem um card — "card:<canal>|<modalidade>|<bandeira/operadora>|<início>|<fim>".
  if (tipo === "card") { const [canal, modalidade, chave, periodoInicio, periodoFim] = id.split("|"); return [`/api/fv2/vendas/liquido-esperado?${qs({ competencia: undefined, canal, modalidade, chave, periodoInicio, periodoFim })}`, (d) => can.detalheDoCard(d)]; }
  // Fase 11: prévia do demonstrativo oficial do iFood — "demonstrativo:<valores digitados, em query string>" (nada é gravado).
  if (tipo === "demonstrativo") { const params = Object.fromEntries(new URLSearchParams(id)); return [`/api/fv2/previa-demonstrativo-ifood?${qs({ competencia: undefined, ...params })}`, (d) => impCanais.previaDoDemonstrativo(d, { params, podeRegistrar: permissoesDaUnidade().includes("financeiro_v2.registrar") })]; }
  if (tipo === "relatorio-99food") return [`/api/fv2/previa-relatorio-99food?${qs({ competencia: undefined, importacao: id })}`, (d) => impCanais.previaDoRelatorio99Food(d, { podeAplicar: permissoesDaUnidade().includes("financeiro_v2.aplicar"), podeVincular: permissoesDaUnidade().includes("financeiro_v2.configurar"), podeDecidir: permissoesDaUnidade().includes("financeiro_v2.confirmar_importacao") })];
  if (tipo === "conciliacao-ifood") return [`/api/fv2/previa-conciliacao-ifood?${qs({ competencia: undefined, importacao: id })}`, (d) => impCanais.previaDaConciliacaoIfood(d, { podeAplicar: permissoesDaUnidade().includes("financeiro_v2.aplicar"), podeClassificar: permissoesDaUnidade().includes("financeiro_v2.configurar") })];
  if (tipo === "entregador") { const c = id.indexOf("|"); return [`/api/fv2/entregadores/fechamento?${qs({ competencia: undefined, inicio: id.slice(0, c), entregador: id.slice(c + 1) })}`, (d) => { estado.demonstrativo = d; return ent.detalheDoFechamento(d); }]; }
  if (tipo === "entregador-pessoa") return [`/api/fv2/entregadores/pessoa?${qs({ competencia: undefined, entregador: id })}`, (d) => ent.detalheDoEntregador(d)];
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
/** Nota ou comprovante do entregador: o servidor revalida a permissão e confere que o arquivo pertence a este fechamento. */
async function baixarDocumentoDoEntregador(botao) {
  const r = await enviar("/api/fv2/acoes/entregadores/documento/abrir", { inicio: botao.dataset.inicio, entregador: botao.dataset.entregador, documento: botao.dataset.entregadorDoc, confirmar: true, unidade: estado.unidade }, { ...cabecalhos(), "x-fv2-csrf": estado.csrf ?? "" });
  if (!r.ok) { botao.textContent = r.mensagem ?? "Arquivo indisponível"; return; }
  const bytes = Uint8Array.from(atob(r.dados.conteudoBase64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = r.dados.nome; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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
/** 08D: arquivo → base64 (o servidor decodifica; o núcleo confere formato, tamanho e conteúdo). */
const LIMITE_DE_EVIDENCIA = 10 * 1024 * 1024;
async function arquivoEmBase64(arquivo) {
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}
/** Quadro da conferência da nota, logo depois do anexo. Fecha no X, no botão, clicando fora do quadro ou com Esc. */
async function mostrarQuadroDaConferencia(fechamento) {
  try { await garantir("ent"); } catch { return; } // sem o módulo, a ficha recarregada já mostra a situação
  const html = ent.quadroDaConferencia(fechamento);
  if (!html) return;
  document.querySelector("dialog.conf-nota")?.remove();
  const d = document.createElement("dialog");
  d.className = "conf-nota";
  d.setAttribute("aria-labelledby", "conf-nota-titulo");
  d.innerHTML = html;
  d.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-fechar-quadro]")) { d.close(); return; }
    const q = d.getBoundingClientRect(); // clique no fundo escurecido (fora da caixa) também fecha
    if (ev.target === d && (ev.clientX < q.left || ev.clientX > q.right || ev.clientY < q.top || ev.clientY > q.bottom)) d.close();
  });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  d.querySelector(".conf-nota__rodape .botao")?.focus();
}

async function executarAcao(form) {
  const saida = form.querySelector(".resultado-acao");
  const botao = form.querySelector('button[type="submit"]');
  const entradas = [...new FormData(form).entries()].filter(([, v]) => typeof v === "string");
  // 18/11/2026: grade de taxas (campos "tx|MOD|BANDEIRA" e "tf|MOD|BANDEIRA") vira o texto que o servidor valida.
  const daGrade = (k) => k.startsWith("tx|") || k.startsWith("tf|");
  // Doc 54: competência escolhida por retirada ("comp|<id>") vira "id=AAAA-MM;…" (só as preenchidas).
  const daCompetencia = (k) => k.startsWith("comp|");
  const dados = Object.fromEntries(entradas.filter(([k]) => !daGrade(k) && !daCompetencia(k)));
  const competencias = entradas.filter(([k, v]) => daCompetencia(k) && v).map(([k, v]) => `${k.slice(5)}=${v}`).join(";");
  if (competencias) dados.competencias = competencias;
  // Caixas de marcar com o mesmo nome (data-multiplo): todos os valores marcados, separados por vírgula.
  for (const nome of new Set([...form.querySelectorAll("[data-multiplo]")].map((x) => x.name))) dados[nome] = new FormData(form).getAll(nome).join(",");
  if (!form.querySelector('[name="confirmar"]')?.checked) { saida.textContent = "Marque a confirmação para continuar."; return; }
  try { await garantir("conf", "can"); } catch { saida.textContent = "Não foi possível baixar a tela de confirmação. Confira a conexão: nada foi enviado."; return; }
  if (form.hasAttribute("data-grade-taxas")) {
    const g = can.textoDaGradeDeTaxas(entradas.filter(([k]) => daGrade(k)));
    if (g.erros.length) { saida.textContent = g.erros.join(" "); return; }
    dados.taxas = g.texto;
  }
  const corpo = { ...dados, confirmar: true, unidade: estado.unidade };
  if (form.hasAttribute("data-envio-evidencia")) {
    const arquivo = form.querySelector('input[type="file"]')?.files?.[0];
    if (!arquivo) { saida.textContent = "Escolha um arquivo."; form.querySelector('input[type="file"]')?.focus(); return; }
    if (arquivo.size > LIMITE_DE_EVIDENCIA) { saida.textContent = "Arquivo maior que 10 MiB: nada foi enviado."; return; }
    Object.assign(corpo, { arquivoBase64: await arquivoEmBase64(arquivo), nomeArquivo: arquivo.name, tipoMime: arquivo.type });
  }
  if ("aceitarPendencias" in dados) corpo.aceitarPendencias = true;
  botao.disabled = true;
  saida.dataset.estado = "enviando";
  saida.textContent = "Enviando…";
  const r = await enviar(form.dataset.acao, corpo, { ...cabecalhos(), "x-fv2-csrf": estado.csrf ?? "" });
  if (ehSessaoExpirada(r)) { sessaoExpirada(r); return; } // nada foi gravado; a tela explica e oferece entrar de novo
  saida.innerHTML = conf.resultadoDaAcao(r);
  saida.dataset.estado = r.ok ? "ok" : "erro";
  if (!r.ok) { botao.disabled = false; return; }
  recarregarAoFechar = true;
  if (r.dados?.leituraDaNota) mostrarQuadroDaConferencia(r.dados);
  const proximo = form.dataset.recarregar ?? "";
  if (proximo === "lista") { recarregarAoFechar = false; carregar(); return; }
  if (proximo === "resultado:documento" && r.dados.importacao?.id) { abrirDetalhe(`documento:${r.dados.importacao.id}`, form); return; }
  if (proximo.includes(":")) abrirDetalhe(proximo, form);
}

// ---- Fase 10: calendário de faturamento dos canais (só apresentação; os dados vêm do servidor)
function selecionarDiaDoCanal(data, botao) {
  const cal = estado.calCanal?.dados;
  if (!cal) return;
  estado.calDia = data;
  for (const b of document.querySelectorAll("[data-cal-dia]")) {
    const ativo = b === botao;
    b.classList.toggle("cal-dia--sel", ativo);
    b.setAttribute("aria-pressed", String(ativo));
    b.tabIndex = ativo ? 0 : -1;
  }
  const alvo = $("#cal-dia-detalhe");
  alvo.innerHTML = calCanais.diaDoCanal(cal.dias.find((d) => d.data === data), cal);
  alvo.scrollIntoView({ block: "nearest" });
}
/** Setas andam pelos dias (←→ um dia, ↑↓ uma semana), Home/End vão ao início/fim da semana. Enter e espaço já abrem o dia (é um botão). */
function navegarNoCalendario(e, atual) {
  const botoes = [...document.querySelectorAll("[data-cal-dia]")];
  const i = botoes.indexOf(atual);
  const passo = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  let alvo = null;
  if (passo !== undefined) alvo = botoes[i + passo];
  else if (e.key === "Home" || e.key === "End") {
    const col = (new Date(`${atual.dataset.calDia}T00:00:00Z`).getUTCDay() + 6) % 7;
    alvo = botoes[e.key === "Home" ? i - col : Math.min(botoes.length - 1, i + (6 - col))];
  } else return;
  e.preventDefault();
  if (!alvo) return;
  for (const b of botoes) b.tabIndex = b === alvo ? 0 : -1;
  alvo.focus();
}
function irParaHojeNoCalendario() {
  const hoje = estado.dataBase;
  if (!hoje) return;
  estado.competencia = hoje.slice(0, 7);
  $("#filtro-competencia").value = estado.competencia;
  estado.calDia = hoje;
  carregar();
}
/** Ações de um dia do calendário: abrem a MESMA tela já existente (importações, fechamento, conferências) com o período do dia. */
function acaoDoDiaDoCanal(acao, data, origem) {
  const canal = estado.calCanal?.dados?.canal;
  if (acao === "vendas") {
    abrirNoPainel(`/api/fv2/vendas?${qs({ competencia: undefined, canal, inicio: data, fim: data, pagina: 1, tamanho: 25 })}`, (d) => calCanais.vendasDoDia(d, { canal, data }), origem);
    return;
  }
  const aba = { importacoes: "importacoes", fechamentos: "fechamento", provisorio: "fechamento", conferencias: "conferencias" }[acao];
  if (!aba) return;
  estado.filtros.saipos = { ...(estado.filtros.saipos ?? {}), aba, inicio: data, fim: data, competenciaBase: estado.competencia, foco: acao === "provisorio" ? "provisorio" : undefined };
  carregar().then(() => { if (estado.filtros.saipos) estado.filtros.saipos.foco = undefined; });
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
  // Início depois do fim: avisa AQUI, sem recarregar. Recarregar trocaria a tela (e o próprio filtro) por um erro e a pessoa
  // não teria onde corrigir a data.
  let aviso = form.parentElement?.querySelector("[data-aviso-periodo]");
  if (dados.inicio && dados.fim && dados.fim < dados.inicio) {
    if (!aviso) {
      aviso = document.createElement("p");
      aviso.className = "aviso aviso--alerta";
      aviso.setAttribute("role", "alert");
      aviso.dataset.avisoPeriodo = "";
      form.after(aviso);
    }
    aviso.textContent = "A data inicial está depois da final. Corrija o período para atualizar a tela.";
    return;
  }
  aviso?.remove();
  const anterior = estado.filtros[rota] ?? {};
  if (rota === "entregadores-proprios" && dados.semanaLivre) { dados.semana = dados.semanaLivre; delete dados.semanaLivre; }
  estado.filtros[rota] = { ...dados, soCompetencia: form.querySelector('[name="soCompetencia"]')?.checked ?? false };
  if (rota === "saipos") estado.filtros.saipos.competenciaBase = estado.competencia; // período escolhido vale para a competência atual
  if (rota === "operadoras-taxas") estado.filtros[rota].competenciaBase = estado.competencia;
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
  // "Tentar novamente" (erro de LEITURA) e "Atualizar dados": relê só a tela atual, na mesma unidade, competência e filtros. Nunca reenvia gravação.
  if (e.target.closest("[data-tentar-novamente], #atualizar-dados")) { invalidarCache(); carregar(); return; }
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
  const abaCanal = e.target.closest("[data-aba-canal]");
  if (abaCanal) {
    estado.filtros[estado.rota] = { ...(estado.filtros[estado.rota] ?? {}), aba: abaCanal.dataset.abaCanal };
    carregar().then(() => document.querySelector(`nav [data-aba-canal="${abaCanal.dataset.abaCanal}"]`)?.focus());
    return;
  }
  const abaSaipos = e.target.closest("[data-aba-saipos]");
  if (abaSaipos) {
    estado.filtros.saipos = { ...(estado.filtros.saipos ?? {}), aba: abaSaipos.dataset.abaSaipos };
    carregar().then(() => document.querySelector(`nav [data-aba-saipos="${abaSaipos.dataset.abaSaipos}"]`)?.focus());
    return;
  }
  const secaoConfig = e.target.closest("[data-secao-config]");
  if (secaoConfig) {
    estado.filtros.configuracoes = { secao: secaoConfig.dataset.secaoConfig };
    carregar().then(() => document.querySelector(`[data-secao-config="${secaoConfig.dataset.secaoConfig}"]`)?.focus());
    return;
  }
  const docEntregador = e.target.closest("[data-entregador-doc]");
  if (docEntregador) { baixarDocumentoDoEntregador(docEntregador); return; }
  if (e.target.closest("[data-copiar-demonstrativo]") && estado.demonstrativo) { navigator.clipboard?.writeText(ent.textoDoDemonstrativo(estado.demonstrativo, nomeUnidade())); e.target.textContent = "Texto copiado"; return; }
  if (e.target.closest("[data-imprimir-demonstrativo]")) { window.print(); return; }
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
  const diaDoCanal = e.target.closest("[data-cal-dia]");
  if (diaDoCanal && estado.calCanal?.dados) { selecionarDiaDoCanal(diaDoCanal.dataset.calDia, diaDoCanal); return; }
  const acaoDoDia = e.target.closest("[data-cal-acao]");
  if (acaoDoDia) { acaoDoDiaDoCanal(acaoDoDia.dataset.calAcao, acaoDoDia.dataset.calData, acaoDoDia); return; }
  if (e.target.closest("[data-cal-hoje]")) { irParaHojeNoCalendario(); return; }
  const mes = e.target.closest("[data-mes]");
  if (mes) { estado.competencia = somarMes(estado.competencia, Number(mes.dataset.mes)); $("#filtro-competencia").value = estado.competencia; estado.diaSelecionado = null; estado.calDia = null; carregar(); return; }
  const dia = e.target.closest("[data-dia]");
  if (dia && estado.calendario) {
    estado.diaSelecionado = dia.dataset.dia;
    for (const b of document.querySelectorAll("[data-dia]")) { b.classList.toggle("cal-dia--sel", b === dia); b.setAttribute("aria-pressed", String(b === dia)); }
    const detalhe = $("#dia-detalhe");
    detalhe.innerHTML = tes.diaDoCalendario(estado.calendario.dias.find((d) => d.data === estado.diaSelecionado));
    detalhe.scrollIntoView({ block: "nearest" });
    return;
  }
  // 18/11/2026: "Aplicar a todas" — copia a taxa digitada para todas as bandeiras da modalidade (só preenche a tela).
  const replicar = e.target.closest("[data-replicar-taxa]");
  if (replicar) {
    const form = replicar.closest("form");
    const mod = replicar.dataset.replicarTaxa;
    const v = form.querySelector(`[data-replicar-valor="${mod}"]`)?.value.trim() ?? "";
    for (const campo of form.querySelectorAll(`input[name^="tx|${mod}|"]`)) campo.value = v;
    return;
  }
  if (e.target.closest("[data-fechar-painel]") || e.target.id === "painel") fecharPainel();
});
document.addEventListener("change", (e) => {
  // 08D: mostra (e anuncia) nome, tipo e tamanho do arquivo escolhido antes do envio.
  if (e.target.matches?.('[data-envio-evidencia] input[type="file"]')) {
    const a = e.target.files?.[0];
    const alvo = e.target.closest("form").querySelector("[data-arquivo-escolhido]");
    if (alvo) alvo.textContent = a ? `Escolhido: ${a.name} · ${a.type || "tipo desconhecido"} · ${Math.max(1, Math.round(a.size / 1024))} KB${a.size > LIMITE_DE_EVIDENCIA ? " — acima do limite de 10 MiB" : ""}` : "Nenhum arquivo escolhido.";
    return;
  }
  const form = e.target.closest("[data-filtro-local]");
  if (form) aplicarFiltroLocal(form);
});
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const acao = e.target.closest("[data-acao]");
  if (acao) { executarAcao(acao); return; }
  // 08C: a prévia da reclassificação é uma CONSULTA ao núcleo (nada é gravado); só a ação confirma.
  const previa = e.target.closest("[data-previa-reclassificacao]");
  if (previa) { const cat = new FormData(previa).get("categoria"); if (cat) abrirDetalhe(`reclassificacao:${previa.dataset.previaReclassificacao}|${cat}`, previa); return; }
  // Fase 11: prévia do demonstrativo oficial do iFood (consulta; só a confirmação dentro do painel registra).
  const previaDemonstrativo = e.target.closest("[data-previa-demonstrativo]");
  if (previaDemonstrativo) { abrirDetalhe(`demonstrativo:${new URLSearchParams(new FormData(previaDemonstrativo)).toString()}`, previaDemonstrativo); return; }
  // 08E: prévia do vínculo com a saída do extrato (consulta; só a ação confirma).
  const previaVinculo = e.target.closest("[data-previa-vinculo]");
  if (previaVinculo) { const mov = new FormData(previaVinculo).get("movimentacao"); if (mov) abrirDetalhe(`vinculo:${previaVinculo.dataset.previaVinculo}|${mov}`, previaVinculo); return; }
  const form = e.target.closest("[data-filtro-local]");
  if (form) aplicarFiltroLocal(form);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPainel(); });
document.addEventListener("keydown", (e) => { const dia = e.target.closest?.("[data-cal-dia]"); if (dia) navegarNoCalendario(e, dia); });
window.addEventListener("hashchange", rotear);
$("#filtro-competencia").addEventListener("change", (e) => { estado.competencia = e.target.value; estado.pagina = {}; estado.diaSelecionado = null; estado.calDia = null; carregar(); });
const reiniciarFiltros = () => { estado.filtros = filtrosIniciais(); estado.pagina = {}; estado.diaSelecionado = null; estado.calDia = null; estado.calCanal = null; estado.pessoas = null; estado.configuracoes = null; aplicarFiltrosDaUrl(); };
$("#filtro-unidade").addEventListener("change", (e) => { estado.unidade = e.target.value; estado.fontesDaUnidade = null; reiniciarFiltros(); invalidarCache(); const nome = $("#topo-unidade"); if (nome) nome.textContent = nomeUnidade(); carregar(); });
$("#filtro-sessao").addEventListener("change", (e) => { invalidarCache(); estado.sessao = e.target.value; estado.unidade = null; estado.unidades = []; estado.fontesDaUnidade = null; reiniciarFiltros(); carregar(); });
iniciarMenuRecolhivel();
rotear();
