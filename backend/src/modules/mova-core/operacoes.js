// MOVA CORE — F4 integrada (§7–§11): PROPOSTAS de operação e EXECUÇÃO pelo backend.
//
// "A IA interpreta e conduz a conversa. O backend valida e executa."
//   * O modelo só PREPARA (ferramenta preparar_operacao): nada é gravado. A proposta é normalizada pelo servidor (entidades
//     resolvidas por leitura oficial), versionada, com impressão (hash), validade e REQUISITOS que ainda faltam.
//   * Confirmar/cancelar é DETERMINÍSTICO e acontece ANTES do modelo (index.js): só uma confirmação inequívoca da MESMA pessoa,
//     na MESMA conversa, para a versão VIGENTE e completa, dentro da validade. Qualquer correção ("sim, mas são 250") volta para
//     o modelo, que prepara uma NOVA versão — a anterior deixa de valer.
//   * Executar = porta operacional do MOVA (lista fechada, concessão gravada, núcleo do Financeiro revalida tudo), com chave
//     idempotente da proposta. Sucesso/erro vêm da TRANSAÇÃO REAL: nada é dito "registrado" antes do retorno do núcleo.
//   * Política (dominio/autonomia.js): sem política ⇒ só propor (revisão humana); acima do limite ⇒ revisão humana; proibida ⇒
//     recusa. O limite NUNCA substitui a permissão: quem confirma precisa da autorização de escrita calculada pelo servidor.
//   * O modelo nunca acessa o banco, nunca escolhe a operação do núcleo e nunca vê ids internos além das referências.
import { createHash, randomUUID } from "node:crypto";
import { resolverEntidade } from "./resolucao.js";
import { todasAsPaginas } from "./leituras.js";
import { decidirAutonomia, NIVEL, OPERACAO } from "../mova-financeiro/dominio/autonomia.js";

export const TIPO_OPERACAO = Object.freeze({ COMPRA_JA_PAGA: "COMPRA_JA_PAGA", PRESTACAO_DE_SANGRIA: "PRESTACAO_DE_SANGRIA" });
export const ESTADO_PROPOSTA = Object.freeze({
  AGUARDANDO_DADOS: "AGUARDANDO_DADOS", AGUARDANDO_CONFIRMACAO: "AGUARDANDO_CONFIRMACAO", EM_REVISAO_HUMANA: "EM_REVISAO_HUMANA",
  EXECUTANDO: "EXECUTANDO", EXECUTADA: "EXECUTADA", EXECUTADA_PARCIAL: "EXECUTADA_PARCIAL", FALHOU: "FALHOU",
  CANCELADA: "CANCELADA", SUBSTITUIDA: "SUBSTITUIDA", EXPIRADA: "EXPIRADA", RECUSADA: "RECUSADA", DESATUALIZADA: "DESATUALIZADA",
});
const ABERTAS = new Set([ESTADO_PROPOSTA.AGUARDANDO_DADOS, ESTADO_PROPOSTA.AGUARDANDO_CONFIRMACAO]);
export const VALIDADE_PROPOSTA_MS = 30 * 60 * 1000;
/** Validade configurável (MOVA_CORE_PROPOSTA_VALIDADE_MIN, 5 a 120 minutos; padrão 30). Valor inválido ⇒ padrão. */
export function validadeDaConfiguracao(env = {}) {
  const n = Number.parseInt(env.MOVA_CORE_PROPOSTA_VALIDADE_MIN ?? "", 10);
  return Number.isInteger(n) && n >= 5 && n <= 120 ? n * 60_000 : VALIDADE_PROPOSTA_MS;
}
/** Execução interrompida (queda entre a transação e a gravação do desfecho) é retomada depois deste tempo — sempre idempotente. */
export const RETOMADA_APOS_MS = 2 * 60 * 1000;
/** Identidade CANÔNICA do favorecido para o anti-fracionamento: "Doce Brownie", "DOCE BROWNIE LTDA." e "Doce Brownie ME" são o mesmo. */
export function chaveCanonicaDoFavorecido(nome) {
  const n = String(nome ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(ltda|me|mei|epp|eireli|sa|cia|comercio|comercial|de|da|do|e)\b/g, " ").replace(/\s+/g, " ").trim();
  return n ? "nome:" + n : null;
}
const POLITICA_DO_TIPO = { COMPRA_JA_PAGA: OPERACAO.DESPESA_DOCUMENTAL, PRESTACAO_DE_SANGRIA: OPERACAO.PRESTACAO_DE_SANGRIA };

// ---------------------------------------------------------------- intenção determinística (só para EXECUTAR / CANCELAR)
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const CONFIRMA = /^(?:mova[\s,:]+)?(?:sim|s|isso|isso mesmo|confirmo|confirma|confirmado|pode|pode sim|pode lancar|pode registrar|pode seguir|ok|ok pode|beleza pode|certo pode|correto|esta certo|ta certo|lanca|registra|manda ver)(?: (?:pode|por favor|obrigad[oa]|sim|confirmo|lancar|registrar|isso))*[.! ]*$/;
const CANCELA = /^(?:mova[\s,:]+)?(?:nao|n|cancela|cancelar|cancele|esquece|esqueca|deixa|deixa pra la|deixa quieto|nao lanca|nao registra|nao precisa|para|pare|desiste|desconsidera)(?:[ ,]+(?:isso|essa|esse|ai|tudo|por favor|nao|lanca|registra|mais|a compra|o lancamento|pode cancelar|cancela))*[.! ]*$/;
/** "sim" puro confirma; "sim, mas..." / números / outra pergunta NÃO (vai para o modelo corrigir). */
export function intencaoDeterministica(texto) {
  const t = semAcento(texto).replace(/[,;]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60 || /\d/.test(t) || /\b(mas|porem|so que|exceto|menos|corrig|errad|outro|outra)\b/.test(t)) return null;
  if (CONFIRMA.test(t)) return "CONFIRMAR";
  if (CANCELA.test(t)) return "CANCELAR";
  return null;
}

// ---------------------------------------------------------------- repositório (memória; PG pela migração 0020)
export function criarRepositorioDePropostasMemoria() {
  const porId = new Map();
  return {
    async salvar(p, { versaoEsperada = null } = {}) {
      const atual = porId.get(p.id);
      if (versaoEsperada !== null && (atual?.revisao ?? 0) !== versaoEsperada) return { ok: false, motivo: "CONCORRENCIA" };
      const nova = { ...structuredClone(p), revisao: (atual?.revisao ?? 0) + 1 };
      porId.set(p.id, nova);
      return { ok: true, proposta: structuredClone(nova) };
    },
    async obter(id) { const p = porId.get(id); return p ? structuredClone(p) : null; },
    async daConversa(conversaChave, { limite = 20 } = {}) {
      return [...porId.values()].filter((p) => p.conversaChave === conversaChave).sort((a, b) => b.criadaEm.localeCompare(a.criadaEm) || b.versao - a.versao).slice(0, limite).map((p) => structuredClone(p));
    },
    async acumuladoDoFavorecido({ organizacaoId, unidadeId, favorecido, desde }) {
      return [...porId.values()].filter((p) => p.organizacaoId === organizacaoId && p.unidadeId === unidadeId && [ESTADO_PROPOSTA.EXECUTADA, ESTADO_PROPOSTA.EXECUTADA_PARCIAL].includes(p.estado)
        && p.favorecidoChave && p.favorecidoChave === favorecido && p.executadaEm >= desde).reduce((t, p) => t + (p.valorCentavos ?? 0), 0);
    },
  };
}

// serialização CANÔNICA (chaves ordenadas): o jsonb do PostgreSQL reordena as chaves e a impressão precisa ser a mesma depois do banco
const canonico = (v) => (Array.isArray(v) ? v.map(canonico) : v && typeof v === "object" && !(v instanceof Uint8Array) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])])) : v);
const impressao = (x) => createHash("sha256").update(JSON.stringify(canonico(x))).digest("hex").slice(0, 32);
const reais = (c) => (Number.isInteger(c) ? `R$ ${(c / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}` : "—");
const codigoCategoria = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * @param {object} deps
 * @param {object} deps.repositorio       criarRepositorioDePropostasMemoria() ou o PG
 * @param {object} deps.porta             porta de LEITURA (para resolver fornecedor, categoria e a sangria)
 * @param {object|null} deps.portaOperacional  { pode(op, escopo), chamar(op, escopo, entrada) } — null ⇒ só propõe
 * @param {() => Promise<object[]>} deps.politicas  políticas de autonomia vigentes (dominio/autonomia.js)
 */
export function criarServicoDeOperacoes({ repositorio = criarRepositorioDePropostasMemoria(), porta, portaOperacional = null, politicas = async () => [], auditoria = { registrar() {} }, relogio = () => Date.now(), validadeMs = VALIDADE_PROPOSTA_MS, avaliarComprovante = null }) {
  const agoraIso = () => new Date(relogio()).toISOString();
  const auditar = (acao, p, extra = {}) => auditoria.registrar({ tipo: "MOVA_CORE_OPERACAO", acao, propostaId: p?.id ?? null, versao: p?.versao ?? null, tipoOperacao: p?.tipo ?? null, organizacaoId: p?.organizacaoId ?? null, unidadeId: p?.unidadeId ?? null, estado: p?.estado ?? null, em: agoraIso(), ...extra });

  /** Política vigente AGORA + §10: o limite vale por pagamento e não se contorna dividindo (mesmo favorecido, 7 dias), em QUALQUER nível. */
  async function decidir({ tipo, organizacaoId, unidadeId, valorCentavos, hoje, comprovante, favorecidoChave }) {
    const lista = await politicas();
    const acumuladoCentavos = favorecidoChave ? await repositorio.acumuladoDoFavorecido({ organizacaoId, unidadeId, favorecido: favorecidoChave, desde: new Date(relogio() - 7 * 86_400_000).toISOString() }) : 0;
    const d = decidirAutonomia({ politicas: lista, operacao: POLITICA_DO_TIPO[tipo], organizacaoId, unidadeId, valorCentavos: valorCentavos ?? 0, hoje, comprovante, acumuladoCentavos });
    const pol = d.politicaId ? lista.find((x) => x.id === d.politicaId) : null;
    if (pol && d.nivel !== NIVEL.SOMENTE_PROPOR && d.nivel !== NIVEL.PROIBIDO && acumuladoCentavos > 0 && (valorCentavos ?? 0) + acumuladoCentavos > pol.limiteCentavos) {
      return { ...d, nivel: NIVEL.SOMENTE_PROPOR, motivos: [...d.motivos, "POSSIVEL_FRACIONAMENTO"], acumuladoCentavos };
    }
    return { ...d, acumuladoCentavos };
  }
  const comprovanteDe = (tipo, anexo) => (tipo !== TIPO_OPERACAO.COMPRA_JA_PAGA ? { apto: true, comIdentificador: true }
    : avaliarComprovante ? avaliarComprovante(anexo) : { apto: Boolean(anexo?.arquivo), situacao: anexo?.arquivo ? "APTO" : "AUSENTE", comIdentificador: Boolean(anexo?.idTransacao), motivos: [] });

  /** A proposta mais recente da conversa, se está em REVISÃO HUMANA e ainda válida (para responder 'sim' com a verdade). */
  async function emRevisaoDaConversa(conversaChave) {
    const [p] = await repositorio.daConversa(conversaChave);
    return p && p.estado === ESTADO_PROPOSTA.EM_REVISAO_HUMANA && Date.parse(p.expiraEm) > relogio() ? p : null;
  }

  async function abertaDaConversa(conversaChave) {
    const lista = await repositorio.daConversa(conversaChave);
    const p = lista.find((x) => ABERTAS.has(x.estado)) ?? null;
    if (p && Date.parse(p.expiraEm) <= relogio()) { await repositorio.salvar({ ...p, estado: ESTADO_PROPOSTA.EXPIRADA }); auditar("EXPIRADA", p); return null; }
    return p;
  }

  // ------------------------------------------------------------ resolução por LEITURA oficial
  async function resolverFornecedor(escopo, nome) {
    if (!nome) return { requisito: "FORNECEDOR" };
    let itens = [];
    try { itens = (await todasAsPaginas(porta, "consultarContasAPagar", escopo, {}, { tamanho: 100, maxPaginas: 5 }))?.itens ?? []; } catch { itens = []; }
    const conhecidos = new Map();
    for (const i of itens) { const c = i.contraparte ?? i.fornecedor; if (c?.id && c?.nome) conhecidos.set(c.id, { id: c.id, nome: c.nome, categoria: i.categoria?.codigo ?? (typeof i.categoria === "string" ? i.categoria : null) }); }
    const r = resolverEntidade(nome, [...conhecidos.values()]);
    if (r.estado === "UNICO") return { contraparteId: r.escolhido.id, nome: r.escolhido.nome, categoriaHabitual: r.escolhido.categoria ?? null, novo: false };
    if (r.estado === "AMBIGUO") return { requisito: "FORNECEDOR_AMBIGUO", candidatos: r.candidatos.map((c) => c.nome).slice(0, 5) };
    return { contraparteNova: { tipo: "FORNECEDOR", nome: String(nome).trim().slice(0, 120) }, nome: String(nome).trim().slice(0, 120), novo: true };
  }
  async function resolverCategoria(escopo, texto, habitual) {
    let contas = [];
    try {
      const r = await porta.ler("consultarPlanoDeContas", escopo, {});
      // o plano oficial é uma ÁRVORE (contas com "filhas"); só folhas que ACEITAM lançamento servem de categoria
      const raiz = Array.isArray(r) ? r : (r?.contas ?? r?.itens ?? r?.categorias ?? []);
      const achatar = (xs) => xs.flatMap((c) => [c, ...achatar(c.filhas ?? [])]);
      contas = achatar(raiz).filter((c) => c.ativa !== false && c.aceitaLancamento !== false && (c.natureza ?? c.tipo ?? "DESPESA") !== "RECEITA");
    } catch { contas = []; }
    const lista = contas.map((c) => ({ codigo: c.codigo, nome: c.nome ?? c.codigo }));
    if (texto) {
      const exato = lista.find((c) => c.codigo === codigoCategoria(texto));
      if (exato) return { categoria: exato.codigo, nome: exato.nome };
      const r = resolverEntidade(texto, lista);
      if (r.estado === "UNICO") return { categoria: r.escolhido.codigo, nome: r.escolhido.nome };
      return { requisito: r.estado === "AMBIGUO" ? "CATEGORIA_AMBIGUA" : "CATEGORIA", candidatos: (r.candidatos ?? []).map((c) => c.nome).slice(0, 5) };
    }
    if (habitual && lista.some((c) => c.codigo === habitual)) return { categoria: habitual, nome: lista.find((c) => c.codigo === habitual).nome, habitual: true };
    return { requisito: "CATEGORIA", sugestoes: lista.slice(0, 6).map((c) => c.nome) };
  }
  async function sangriaPendente(escopo, ref) {
    const r = await porta.ler("consultarPrestacaoDeSangrias", escopo, { somentePendentes: true });
    const itens = r?.itens ?? [];
    const alvo = itens.find((s) => s.movimentacaoId === ref) ?? (itens.length === 1 && !ref ? itens[0] : null);
    return { alvo, itens };
  }

  // ------------------------------------------------------------ normalização por tipo
  async function normalizar({ tipo, args, escopo, anexo, hoje }) {
    const requisitos = []; const avisos = [];
    if (tipo === TIPO_OPERACAO.COMPRA_JA_PAGA) {
      const valor = Number.isSafeInteger(args.valorCentavos) && args.valorCentavos > 0 ? args.valorCentavos : null;
      if (!valor) requisitos.push("VALOR");
      const data = /^\d{4}-\d{2}-\d{2}$/.test(args.dataPagamento ?? "") ? args.dataPagamento : null;
      if (!data) requisitos.push("DATA_DO_PAGAMENTO"); else if (hoje && data > hoje) requisitos.push("DATA_FUTURA");
      const descricao = String(args.descricao ?? "").trim().slice(0, 200) || null;
      if (!descricao) requisitos.push("O_QUE_FOI_COMPRADO");
      const forn = await resolverFornecedor(escopo, args.fornecedor);
      if (forn.requisito) requisitos.push(forn.requisito);
      const cat = await resolverCategoria(escopo, args.categoria, forn.categoriaHabitual);
      if (cat.requisito) requisitos.push(cat.requisito);
      if (!anexo?.arquivo) requisitos.push("COMPROVANTE");
      if (forn.novo) avisos.push("FORNECEDOR_NOVO");
      const dados = { valorCentavos: valor, dataPagamento: data, descricao, contaOrigem: String(args.contaOrigem ?? "").trim().slice(0, 80) || null,
        fornecedor: forn.nome ?? args.fornecedor ?? null, contraparteId: forn.contraparteId ?? null, contraparteNova: forn.contraparteNova ?? null,
        categoria: cat.categoria ?? null, categoriaNome: cat.nome ?? null, competencia: data ? data.slice(0, 7) : null,
        comprovante: anexo?.arquivo ? { referencia: anexo.referencia ?? "anexo", idTransacao: anexo.idTransacao ?? null } : null };
      return { dados, requisitos, avisos, valorCentavos: valor, favorecidoChave: chaveCanonicaDoFavorecido(forn.nome),
        detalhes: { candidatosFornecedor: forn.candidatos ?? null, candidatosCategoria: cat.candidatos ?? null, sugestoesCategoria: cat.sugestoes ?? null } };
    }
    if (tipo === TIPO_OPERACAO.PRESTACAO_DE_SANGRIA) {
      const { alvo, itens } = await sangriaPendente(escopo, args.sangria ?? null);
      if (!alvo) return { recusa: itens.length ? "SANGRIA_NAO_IDENTIFICADA" : "SEM_SANGRIA_PENDENTE", detalhes: { pendentes: itens.map((s) => ({ ref: s.movimentacaoId, descricao: s.descricao, pendenteCentavos: s.pendenteCentavos, data: s.data })) } };
      const despesas = (Array.isArray(args.despesas) ? args.despesas : []).slice(0, 10).map((d) => ({ valorCentavos: Number.isSafeInteger(d?.valorCentavos) && d.valorCentavos > 0 ? d.valorCentavos : null, descricao: String(d?.descricao ?? "").trim().slice(0, 200) || null, fornecedor: d?.fornecedor ?? null, categoria: d?.categoria ?? null }));
      const troco = Number.isSafeInteger(args.trocoCentavos) && args.trocoCentavos > 0 ? args.trocoCentavos : 0;
      if (!despesas.length && !troco) requisitos.push("DESPESAS_OU_TROCO");
      if (despesas.some((d) => !d.valorCentavos)) requisitos.push("VALOR");
      if (despesas.some((d) => !d.descricao)) requisitos.push("O_QUE_FOI_COMPRADO");
      const total = despesas.reduce((t, d) => t + (d.valorCentavos ?? 0), 0) + troco;
      // nunca uma 2ª saída: a despesa é paga com a PRÓPRIA retirada; passar do pendente é recusado (o núcleo também recusa)
      if (total > alvo.pendenteCentavos) return { recusa: "EXCEDE_O_PENDENTE", detalhes: { pendenteCentavos: alvo.pendenteCentavos, informadoCentavos: total, sangria: alvo.descricao } };
      const resolvidas = [];
      for (const d of despesas) {
        const forn = await resolverFornecedor(escopo, d.fornecedor); // sem loja informada ⇒ requisito (nunca um fornecedor inventado)
        const cat = await resolverCategoria(escopo, d.categoria, forn.categoriaHabitual);
        if (cat.requisito) requisitos.push(cat.requisito);
        if (forn.requisito) requisitos.push(forn.requisito);
        resolvidas.push({ ...d, fornecedor: forn.nome ?? null, contraparteId: forn.contraparteId ?? null, contraparteNova: forn.contraparteNova ?? null, categoria: cat.categoria ?? null, categoriaNome: cat.nome ?? null });
      }
      if (total < alvo.pendenteCentavos) avisos.push("PRESTACAO_PARCIAL");
      // troco: caixa da retirada FECHADO ⇒ volta no caixa aberto AGORA da mesma conta; nenhum aberto ⇒ requisito (nunca reabre, nunca retroage)
      let sessaoDaDevolucaoId = alvo.sessaoId;
      if (troco && alvo.caixaDaRetirada && alvo.caixaDaRetirada !== "ABERTA") {
        if (alvo.caixaAbertoAgora?.sessaoId) { sessaoDaDevolucaoId = alvo.caixaAbertoAgora.sessaoId; avisos.push("TROCO_NO_CAIXA_ATUAL"); }
        else requisitos.push("CAIXA_ABERTO");
      }
      const dados = { sangria: { ref: alvo.movimentacaoId, sessaoId: alvo.sessaoId, descricao: alvo.descricao ?? null, data: alvo.data, pendenteCentavos: alvo.pendenteCentavos }, despesas: resolvidas, trocoCentavos: troco, sessaoDaDevolucaoId, restaCentavos: alvo.pendenteCentavos - total, dataTroco: hoje };
      return { dados, requisitos: [...new Set(requisitos)], avisos, valorCentavos: total };
    }
    return { recusa: "TIPO_NAO_SUPORTADO" };
  }

  function resumoDaProposta(p) {
    const d = p.dados;
    if (p.tipo === TIPO_OPERACAO.COMPRA_JA_PAGA) return `Compra nova já paga: ${d.descricao ?? "?"}${d.fornecedor ? ` — ${d.fornecedor}${d.contraparteNova ? " (fornecedor novo)" : ""}` : ""}, ${reais(d.valorCentavos)}, paga em ${d.dataPagamento ?? "?"}${d.contaOrigem ? ` (${d.contaOrigem})` : ""}${d.categoriaNome ? `, categoria ${d.categoriaNome}` : ""}. Uma despesa e um pagamento, ligados ao comprovante.`;
    const partes = d.despesas.map((x) => `${x.descricao} ${reais(x.valorCentavos)}`);
    if (d.trocoCentavos) partes.push(`troco devolvido ao caixa ${reais(d.trocoCentavos)}${d.sessaoDaDevolucaoId && d.sessaoDaDevolucaoId !== d.sangria.sessaoId ? " (no caixa aberto hoje: o caixa da retirada já foi fechado e não é reaberto)" : ""}`);
    return `Prestação de contas da sangria "${d.sangria.descricao ?? d.sangria.ref}" (${reais(d.sangria.pendenteCentavos)} pendentes): ${partes.join("; ")}. Paga com o próprio dinheiro da retirada (nenhuma saída nova). ${d.restaCentavos > 0 ? `Continuam pendentes ${reais(d.restaCentavos)}.` : "A sangria fica totalmente prestada."}`;
  }

  return Object.freeze({
    abertaDaConversa, emRevisaoDaConversa,

    /** Ferramenta preparar_operacao: cria/substitui a proposta da conversa. NUNCA grava no Financeiro. */
    async preparar({ conversaChave, sessao, autor, tipo, args, anexo = null }) {
      const escopo = Object.freeze({ organizacaoId: sessao.organizacaoId, unidadeId: sessao.unidadeId, usuarioId: sessao.usuarioId });
      const anterior = await abertaDaConversa(conversaChave);
      // o comprovante enviado num turno anterior continua valendo para a correção da MESMA operação (o servidor guarda, nunca o modelo)
      const anexoEfetivo = anexo?.arquivo ? anexo : (anterior?.tipo === tipo ? anterior.anexo ?? null : null);
      // §9: troco só com menção EXPLÍCITA da pessoa (nesta mensagem ou já aceito na versão anterior): "o resto ainda está comigo" é PENDENTE, não troco
      let trocoDescartado = false;
      if (tipo === TIPO_OPERACAO.PRESTACAO_DE_SANGRIA && (args?.trocoCentavos ?? 0) > 0 && typeof sessao.textoDaPessoa === "string"
        && !/(troco|devolv|volt|retorn|sobrou|de volta)/.test(sessao.textoDaPessoa.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase())
        && !(anterior?.tipo === tipo && anterior?.dados?.trocoCentavos === args.trocoCentavos)) { args = { ...args, trocoCentavos: 0 }; trocoDescartado = true; }
      const n = await normalizar({ tipo, args: args ?? {}, escopo, anexo: anexoEfetivo, hoje: sessao.hoje });
      if (trocoDescartado && Array.isArray(n.avisos)) n.avisos.push("TROCO_NAO_INFORMADO_PELA_PESSOA");
      if (n.recusa) return { ok: false, motivo: n.recusa, detalhes: n.detalhes ?? null };
      if (anterior) { await repositorio.salvar({ ...anterior, estado: ESTADO_PROPOSTA.SUBSTITUIDA }, { versaoEsperada: anterior.revisao }); auditar("SUBSTITUIDA", anterior); }
      const decisao = await decidir({ tipo, organizacaoId: sessao.organizacaoId, unidadeId: sessao.unidadeId, valorCentavos: n.valorCentavos, hoje: sessao.hoje, comprovante: comprovanteDe(tipo, anexoEfetivo), favorecidoChave: n.favorecidoChave });
      const versao = (anterior?.tipo === tipo ? anterior.versao : 0) + 1;
      const base = { id: anterior?.tipo === tipo ? anterior.id.replace(/:v\d+$/, "") : randomUUID(), tipo, versao, dados: n.dados };
      const p = {
        ...base, id: `${base.id}:v${versao}`, raiz: base.id, conversaChave, organizacaoId: sessao.organizacaoId, unidadeId: sessao.unidadeId, autor,
        args: structuredClone(args ?? {}), hojeDoPreparo: sessao.hoje, requisitos: n.requisitos, avisos: n.avisos, anexo: anexoEfetivo?.arquivo ? { arquivo: anexoEfetivo.arquivo, referencia: anexoEfetivo.referencia ?? "anexo", idTransacao: anexoEfetivo.idTransacao ?? null } : null, valorCentavos: n.valorCentavos ?? null, favorecidoChave: n.favorecidoChave ?? null,
        impressao: impressao({ tipo, dados: n.dados, unidadeId: sessao.unidadeId }), decisao,
        estado: n.requisitos.length ? ESTADO_PROPOSTA.AGUARDANDO_DADOS : decisao.nivel === NIVEL.PROIBIDO ? ESTADO_PROPOSTA.RECUSADA : decisao.nivel === NIVEL.SOMENTE_PROPOR ? ESTADO_PROPOSTA.EM_REVISAO_HUMANA : ESTADO_PROPOSTA.AGUARDANDO_CONFIRMACAO,
        criadaEm: agoraIso(), expiraEm: new Date(relogio() + validadeMs).toISOString(), resultado: null,
      };
      p.resumo = resumoDaProposta(p);
      const s = await repositorio.salvar(p);
      auditar("PREPARADA", s.proposta, { requisitos: p.requisitos, nivel: decisao.nivel, motivos: decisao.motivos });
      return { ok: true, proposta: s.proposta, detalhes: n.detalhes ?? null };
    },

    /** Determinístico: só a proposta VIGENTE, completa, dentro da validade, da MESMA pessoa, com autorização de escrita AGORA. */
    async confirmar({ conversaChave, autor, autorizacaoDeEscrita }) {
      const p = await abertaDaConversa(conversaChave);
      if (!p) {
        // queda ENTRE a transação e a gravação do desfecho: a proposta ficou EXECUTANDO. Retoma com as MESMAS chaves idempotentes
        // (o que o Financeiro já gravou volta "repetido") — só a mesma pessoa, com autorização AGORA, e só depois do intervalo.
        const [u] = await repositorio.daConversa(conversaChave);
        if (u?.estado === ESTADO_PROPOSTA.EXECUTANDO && u.autor === autor && autorizacaoDeEscrita?.pode && portaOperacional && relogio() - Date.parse(u.executandoDesde ?? u.criadaEm) >= RETOMADA_APOS_MS) {
          const trava = await repositorio.salvar({ ...u, executandoDesde: agoraIso() }, { versaoEsperada: u.revisao });
          if (!trava.ok) return { ok: false, motivo: "CONFIRMACAO_CONCORRENTE", proposta: u };
          auditar("RETOMADA", trava.proposta);
          return executar(trava.proposta);
        }
        if (u?.estado === ESTADO_PROPOSTA.EXECUTANDO) return { ok: false, motivo: "EM_EXECUCAO", proposta: u };
        return { ok: false, motivo: "SEM_PROPOSTA_ABERTA" };
      }
      if (p.autor !== autor) { auditar("CONFIRMACAO_RECUSADA", p, { motivo: "OUTRA_PESSOA" }); return { ok: false, motivo: "OUTRA_PESSOA", proposta: p }; }
      if (p.estado === ESTADO_PROPOSTA.AGUARDANDO_DADOS) return { ok: false, motivo: "FALTAM_DADOS", proposta: p };
      if (!autorizacaoDeEscrita?.pode) { auditar("CONFIRMACAO_RECUSADA", p, { motivo: autorizacaoDeEscrita?.motivo ?? "SEM_AUTORIZACAO_DE_ESCRITA" }); return { ok: false, motivo: "SEM_AUTORIZACAO_DE_ESCRITA", proposta: p }; }
      if (!portaOperacional) return { ok: false, motivo: "EXECUCAO_DESLIGADA", proposta: p };
      // revalida a política AGORA (revogação imediata) e a impressão (nada mudou desde a apresentação)
      const decisao = await decidir({ tipo: p.tipo, organizacaoId: p.organizacaoId, unidadeId: p.unidadeId, valorCentavos: p.valorCentavos, hoje: new Date(relogio()).toISOString().slice(0, 10), comprovante: comprovanteDe(p.tipo, p.anexo), favorecidoChave: p.favorecidoChave });
      if (decisao.nivel === NIVEL.PROIBIDO || decisao.nivel === NIVEL.SOMENTE_PROPOR) {
        await repositorio.salvar({ ...p, estado: decisao.nivel === NIVEL.PROIBIDO ? ESTADO_PROPOSTA.RECUSADA : ESTADO_PROPOSTA.EM_REVISAO_HUMANA, decisao }, { versaoEsperada: p.revisao });
        auditar("ENCAMINHADA_A_REVISAO", p, { motivos: decisao.motivos }); return { ok: false, motivo: decisao.nivel === NIVEL.PROIBIDO ? "OPERACAO_PROIBIDA" : "REVISAO_HUMANA", proposta: p, decisao };
      }
      if (impressao({ tipo: p.tipo, dados: p.dados, unidadeId: p.unidadeId }) !== p.impressao) return { ok: false, motivo: "PROPOSTA_ALTERADA", proposta: p };
      // revalida os DADOS no Financeiro AGORA (outra pessoa pela Central/Dashboard pode ter mudado a retirada, o fornecedor ou a
      // categoria): se a proposta refeita agora não for idêntica à apresentada, ela fica DESATUALIZADA e nada é gravado.
      if (p.args) {
        const escopo = Object.freeze({ organizacaoId: p.organizacaoId, unidadeId: p.unidadeId, usuarioId: autor });
        const agora = await normalizar({ tipo: p.tipo, args: p.args, escopo, anexo: p.anexo, hoje: p.hojeDoPreparo });
        const mesma = !agora.recusa && !agora.requisitos.length && impressao({ tipo: p.tipo, dados: agora.dados, unidadeId: p.unidadeId }) === p.impressao;
        if (!mesma) {
          await repositorio.salvar({ ...p, estado: ESTADO_PROPOSTA.DESATUALIZADA, resultado: { ok: false, codigo: agora.recusa ?? "DADOS_MUDARAM", detalhes: agora.detalhes ?? null } }, { versaoEsperada: p.revisao });
          auditar("DESATUALIZADA", p, { motivo: agora.recusa ?? "DADOS_MUDARAM" });
          return { ok: false, motivo: "PROPOSTA_DESATUALIZADA", proposta: p, detalhes: agora.detalhes ?? null, recusa: agora.recusa ?? null };
        }
      }
      const trava = await repositorio.salvar({ ...p, estado: ESTADO_PROPOSTA.EXECUTANDO, executandoDesde: agoraIso(), decisao }, { versaoEsperada: p.revisao });
      if (!trava.ok) return { ok: false, motivo: "CONFIRMACAO_CONCORRENTE", proposta: p }; // duas confirmações: só uma executa
      auditar("CONFIRMADA", trava.proposta, { nivel: decisao.nivel });
      return executar(trava.proposta);
    },

    async cancelar({ conversaChave, autor }) {
      const p = await abertaDaConversa(conversaChave);
      if (!p) return { ok: false, motivo: "SEM_PROPOSTA_ABERTA" };
      if (p.autor !== autor) return { ok: false, motivo: "OUTRA_PESSOA", proposta: p };
      const s = await repositorio.salvar({ ...p, estado: ESTADO_PROPOSTA.CANCELADA }, { versaoEsperada: p.revisao });
      if (!s.ok) return { ok: false, motivo: "CONCORRENCIA" };
      auditar("CANCELADA", s.proposta); return { ok: true, proposta: s.proposta };
    },

    /** Ferramenta propostas_do_mova: o que esta conversa pediu e o que aconteceu (estado REAL, com o resultado da transação). */
    async daConversa(conversaChave) {
      await abertaDaConversa(conversaChave); // expira as vencidas
      return (await repositorio.daConversa(conversaChave)).map((p) => ({ ref: p.id, tipo: p.tipo, versao: p.versao, estado: p.estado, resumo: p.resumo, faltando: p.requisitos, criadaEm: p.criadaEm, resultado: p.resultado ?? null }));
    },
  });

  // ------------------------------------------------------------ execução pela porta operacional (transação real)
  async function executar(p) {
    const escopo = { organizacaoId: p.organizacaoId, unidadeId: p.unidadeId };
    const chave = (s) => `mova-core-${p.raiz}-v${p.versao}-${s}`.slice(0, 120);
    const feitos = [];
    try {
      if (p.tipo === TIPO_OPERACAO.COMPRA_JA_PAGA) {
        const d = p.dados;
        if (!p.anexo?.arquivo) throw Object.assign(new Error("COMPROVANTE"), { codigo: "FALTAM_DADOS" });
        const r = await portaOperacional.chamar("registrarDespesaPagaPorComprovante", escopo, {
          obrigacao: { ...(d.contraparteId ? { contraparteId: d.contraparteId } : { contraparteNova: d.contraparteNova }), valorOriginalCentavos: d.valorCentavos, categoria: d.categoria, descricao: d.descricao,
            competencia: d.competencia, dataEmissao: d.dataPagamento, vencimento: d.dataPagamento, fonte: { sistema: "MANUAL", idExterno: chave("compra") } },
          comprovante: { arquivo: p.anexo?.arquivo ?? undefined, descricao: `Comprovante: ${d.descricao}`.slice(0, 200), competencia: d.competencia },
          pagamento: { dataPagamento: d.dataPagamento, idTransacao: d.comprovante?.idTransacao ?? null, justificativa: `Compra já paga informada ao MOVA (${d.descricao})`.slice(0, 500), confirmar: true },
        });
        feitos.push({ passo: "COMPRA_PAGA", obrigacaoId: r?.obrigacao?.id ?? r?.conta?.id ?? null, liquidacaoId: r?.liquidacao?.id ?? r?.pagamento?.liquidacao?.id ?? null, repetido: Boolean(r?.repetido) });
      } else {
        const d = p.dados;
        for (const [i, x] of d.despesas.entries()) {
          const r = await portaOperacional.chamar("registrarDespesaDaSangria", escopo, { sessaoId: d.sangria.sessaoId, movimentacaoId: d.sangria.ref, chave: chave(`d${i}`),
            obrigacao: { ...(x.contraparteId ? { contraparteId: x.contraparteId } : { contraparteNova: x.contraparteNova }), valorOriginalCentavos: x.valorCentavos, categoria: x.categoria, descricao: x.descricao },
            justificativa: `Prestação de contas pelo MOVA: ${x.descricao}`.slice(0, 300), confirmar: true });
          feitos.push({ passo: "DESPESA_DA_SANGRIA", valorCentavos: x.valorCentavos, obrigacaoId: r?.despesa?.obrigacaoId ?? null, repetido: Boolean(r?.repetido), pendenteDepoisCentavos: r?.prestacao?.pendenteCentavos ?? null });
        }
        if (d.trocoCentavos) {
          const r = await portaOperacional.chamar("registrarTrocoDaSangria", escopo, { sessaoId: d.sangria.sessaoId, movimentacaoId: d.sangria.ref, chave: chave("troco"), valorCentavos: d.trocoCentavos, data: d.dataTroco, ...(d.sessaoDaDevolucaoId && d.sessaoDaDevolucaoId !== d.sangria.sessaoId ? { sessaoDaDevolucaoId: d.sessaoDaDevolucaoId } : {}), confirmar: true });
          feitos.push({ passo: "TROCO", valorCentavos: d.trocoCentavos, repetido: Boolean(r?.repetido), pendenteDepoisCentavos: r?.prestacao?.pendenteCentavos ?? null, estadoDaSangria: r?.prestacao?.estado ?? null });
        }
      }
    } catch (e) {
      const codigo = e?.codigo ?? e?.code ?? "FALHA";
      // Falha TRANSITÓRIA (Financeiro/concessões fora do ar): a proposta volta a aguardar confirmação — repetir é seguro porque
      // cada passo usa a chave idempotente da proposta (o que já foi gravado volta como "repetido", nunca em dobro).
      const retentavel = e?.name === "ErroTransitorio" || ["FINANCEIRO_INDISPONIVEL", "CONCESSOES_INDISPONIVEIS", "TEMPO_ESGOTADO"].includes(codigo);
      const estado = retentavel ? ESTADO_PROPOSTA.AGUARDANDO_CONFIRMACAO : feitos.length ? ESTADO_PROPOSTA.EXECUTADA_PARCIAL : ESTADO_PROPOSTA.FALHOU;
      const mensagem = retentavel ? "o Financeiro não respondeu agora" : String(e?.message ?? "").slice(0, 300);
      const s = await repositorio.salvar({ ...p, estado, executadaEm: feitos.length && !retentavel ? agoraIso() : null, resultado: { ok: false, codigo, mensagem, detalhes: e?.detalhes ?? null, feitos } });
      auditar(retentavel ? "FALHA_TRANSITORIA" : estado, s.proposta, { codigo, feitos: feitos.length });
      return { ok: false, motivo: "FALHA_NA_EXECUCAO", codigo, mensagem, parcial: feitos.length > 0, retentavel, feitos, proposta: s.proposta };
    }
    // FORA do try: se a gravação do desfecho falhar (queda do banco/processo DEPOIS da transação), a proposta continua EXECUTANDO
    // — nunca vira "falhou" por engano — e a próxima confirmação da mesma pessoa a retoma pelas chaves idempotentes.
    const s = await repositorio.salvar({ ...p, estado: ESTADO_PROPOSTA.EXECUTADA, executadaEm: agoraIso(), resultado: { ok: true, feitos } });
    auditar("EXECUTADA", s.proposta, { feitos: feitos.length });
    return { ok: true, executada: true, proposta: s.proposta, feitos };
  }
}

// ---------------------------------------------------------------- ferramentas do modelo (preparar e consultar; NUNCA executar)
const ROTULO_REQUISITO = {
  VALOR: "o valor", DATA_DO_PAGAMENTO: "a data do pagamento", DATA_FUTURA: "a data (está no futuro)", O_QUE_FOI_COMPRADO: "o que foi comprado",
  FORNECEDOR: "de quem foi comprado (loja/fornecedor)", FORNECEDOR_AMBIGUO: "qual dos fornecedores parecidos", CATEGORIA: "a categoria da despesa",
  CATEGORIA_AMBIGUA: "qual categoria", COMPROVANTE: "o comprovante do pagamento (foto ou PDF)", CAIXA_ABERTO: "um caixa aberto hoje para receber o troco (o caixa da retirada já foi fechado e não é reaberto; abra o caixa do dia na Central ou lance só as despesas agora)", DESPESAS_OU_TROCO: "o que foi gasto e/ou o troco",
};
const COMO_RESPONDER = {
  AGUARDANDO_DADOS: "NADA entrou no Financeiro. Peça SÓ o que falta (lista 'faltando'), em uma pergunta curta, e diga que depois disso a pessoa confirma. Não diga que registrou/lançou (use 'preparei').",
  AGUARDANDO_CONFIRMACAO: "NADA entrou no Financeiro ainda. Mostre o resumo e peça confirmação: a pessoa responde 'sim' para confirmar ou 'cancela'. Não diga que registrou/lançou (use 'preparei').",
  EM_REVISAO_HUMANA: "NADA entrou no Financeiro. Explique que a proposta vai para revisão humana na Central Financeira (sem política para o MOVA lançar sozinho ou acima do limite).",
  RECUSADA: "NADA entrou no Financeiro. O MOVA não faz essa operação; diga isso com clareza.",
};
const RECUSAS = {
  EXCEDE_O_PENDENTE: "O valor informado passa do que ainda falta prestar contas desta retirada. Pergunte se o valor está certo; nada entrou no Financeiro.",
  SEM_SANGRIA_PENDENTE: "Não há sangria pendente de prestação de contas nesta unidade. Nada entrou no Financeiro.",
  SANGRIA_NAO_IDENTIFICADA: "Há mais de uma sangria pendente: pergunte qual (use a lista). Nada entrou no Financeiro.",
  TIPO_NAO_SUPORTADO: "O MOVA não prepara esse tipo de operação. Nada entrou no Financeiro.",
};
const fatoP = (v, significado, entidade = null) => (Number.isInteger(v) ? { valorCentavos: v, significado, entidade, periodo: null } : null);

export function ferramentasDeOperacao() {
  return [
    {
      nome: "preparar_operacao",
      descricao: "PREPARA (não grava) um lançamento que a pessoa pediu: COMPRA_JA_PAGA (compra nova já paga, com comprovante) ou PRESTACAO_DE_SANGRIA (o que foi gasto com uma retirada do caixa e o troco). O servidor confere fornecedor, categoria, sangria e política, e devolve a proposta, o que falta e como responder. Quem confirma é a PESSOA ('sim'); você nunca executa. Para corrigir, chame de novo com os dados certos (nova versão). Retirada para guardar no cofre/banco NÃO é despesa e não se prepara aqui.",
      esquema: { type: "object", properties: {
        tipo: { type: "string", enum: Object.values(TIPO_OPERACAO) },
        valorCentavos: { type: "integer", minimum: 1, description: "COMPRA_JA_PAGA: valor pago, em centavos" },
        fornecedor: { type: "string", maxLength: 120, description: "de quem foi comprado, como a pessoa disse" },
        dataPagamento: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        contaOrigem: { type: "string", maxLength: 80, description: "de onde saiu o dinheiro, como a pessoa disse (ex.: 'Banco Inter')" },
        descricao: { type: "string", maxLength: 200, description: "o que foi comprado" },
        categoria: { type: "string", maxLength: 80, description: "só se a pessoa disse" },
        sangria: { type: "string", maxLength: 80, description: "PRESTACAO_DE_SANGRIA: o ref da sangria devolvido por prestacao_de_sangrias" },
        despesas: { type: "array", maxItems: 10, items: { type: "object", properties: { valorCentavos: { type: "integer", minimum: 1 }, descricao: { type: "string", maxLength: 200 }, fornecedor: { type: "string", maxLength: 120 }, categoria: { type: "string", maxLength: 80 } } } },
        trocoCentavos: { type: "integer", minimum: 0, description: "troco devolvido ao caixa, em centavos" },
      }, required: ["tipo"] },
      valores: true, ops: [], escrita: "PROPOSTA",
      async executar({ args, sessao }) {
        if (!sessao.operacoes) return { erro: "MODULO_INDISPONIVEL", dados: { mensagem: "O preparo de lançamentos pelo MOVA não está ligado." } };
        const r = await sessao.operacoes.preparar({ conversaChave: sessao.conversaChave, sessao, autor: sessao.autor, tipo: args.tipo, args, anexo: sessao.anexo ?? null });
        sessao.preparouOperacao = true;
        if (!r.ok) {
          const d = r.detalhes ?? {};
          return { dados: { entrouNoFinanceiro: false, recusado: r.motivo, comoResponder: RECUSAS[r.motivo] ?? "Nada entrou no Financeiro.", ...d },
            fatos: [fatoP(d.pendenteCentavos, "SANGRIA:pendente", d.sangria ?? null), fatoP(d.informadoCentavos, "PROPOSTA:informado"), ...(d.pendentes ?? []).map((x) => fatoP(x.pendenteCentavos, "SANGRIA:pendente", x.descricao))].filter(Boolean) };
        }
        const p = r.proposta; const det = r.detalhes ?? {};
        const valores = p.tipo === TIPO_OPERACAO.COMPRA_JA_PAGA ? [fatoP(p.dados.valorCentavos, "PROPOSTA:valor", p.dados.fornecedor)]
          : [fatoP(p.dados.sangria.pendenteCentavos, "SANGRIA:pendente", p.dados.sangria.descricao), fatoP(p.dados.trocoCentavos, "PROPOSTA:troco"), fatoP(p.dados.restaCentavos, "PROPOSTA:resta"), fatoP(p.valorCentavos, "PROPOSTA:total"), ...p.dados.despesas.map((x) => fatoP(x.valorCentavos, "PROPOSTA:despesa", x.descricao))];
        return { dados: { entrouNoFinanceiro: false, proposta: { ref: p.id, versao: p.versao, estado: p.estado, resumo: p.resumo, faltando: p.requisitos.map((x) => ROTULO_REQUISITO[x] ?? x), avisos: p.avisos,
          fornecedoresParecidos: det.candidatosFornecedor ?? undefined, categoriasPossiveis: det.candidatosCategoria ?? det.sugestoesCategoria ?? undefined }, comoResponder: COMO_RESPONDER[p.estado] ?? "Nada entrou no Financeiro." },
          fatos: valores.filter(Boolean) };
      },
    },
    {
      nome: "propostas_do_mova",
      descricao: "O que esta conversa pediu ao MOVA para lançar e o que aconteceu de VERDADE com cada pedido (aguardando dados, aguardando confirmação, em revisão humana, executada com o resultado do Financeiro, falhou, cancelada, expirada). Use para 'foi lançado?', 'o que eu pedi?'.",
      esquema: { type: "object", properties: {} },
      valores: false, ops: [], semCache: true,
      async executar({ sessao }) {
        if (!sessao.operacoes) return { erro: "MODULO_INDISPONIVEL", dados: { mensagem: "O preparo de lançamentos pelo MOVA não está ligado." } };
        const itens = await sessao.operacoes.daConversa(sessao.conversaChave);
        return { situacao: itens.length ? undefined : "SEM_REGISTROS", dados: { itens: itens.map((x) => ({ ...x, faltando: (x.faltando ?? []).map((r) => ROTULO_REQUISITO[r] ?? r) })), nota: "EXECUTADA = já está no Financeiro (resultado real da transação). Qualquer outro estado = ainda não entrou no Financeiro." } };
      },
    },
  ];
}

// ---------------------------------------------------------------- textos dos desfechos DETERMINÍSTICOS (a partir do resultado REAL)
const desfechoDosFeitos = (feitos) => feitos.map((f) => (f.passo === "TROCO" ? `troco de ${reais(f.valorCentavos)} devolvido ao caixa` : `despesa de ${reais(f.valorCentavos)}`)).join(" e ");
export function textoDoDesfecho(r) {
  const p = r.proposta;
  if (r.motivo === "SEM_PROPOSTA_ABERTA") return null; // nada a confirmar: o modelo conduz
  if (r.ok && p?.estado === ESTADO_PROPOSTA.CANCELADA) return "Cancelado: nada entrou no Financeiro.";
  if (r.ok && r.executada) {
    if ((r.feitos ?? []).length && r.feitos.every((f) => f.repetido)) return "Esse lançamento já estava registrado no Financeiro (mesmo pedido): nada foi duplicado.";
    if (p.tipo === TIPO_OPERACAO.COMPRA_JA_PAGA) return `Registrado no Financeiro: ${p.resumo.replace(/^Compra nova já paga: /, "compra ")} A conciliação com o extrato fica pendente até a saída aparecer no banco.`;
    const ult = [...(r.feitos ?? [])].reverse().find((f) => Number.isInteger(f.pendenteDepoisCentavos));
    return `Registrado no Financeiro: ${desfechoDosFeitos(r.feitos)}, com o dinheiro da própria sangria (nenhuma saída nova).${ult ? (ult.pendenteDepoisCentavos > 0 ? ` Ainda faltam ${reais(ult.pendenteDepoisCentavos)} para prestar contas.` : " A sangria ficou totalmente prestada.") : ""}`;
  }
  switch (r.motivo) {
    case "FALTAM_DADOS": return `Ainda não dá para lançar: falta ${p.requisitos.map((x) => ROTULO_REQUISITO[x] ?? x).join(", ")}. Nada entrou no Financeiro.`;
    case "PROPOSTA_DESATUALIZADA": return `Os dados no Financeiro mudaram desde a proposta${r.recusa === "EXCEDE_O_PENDENTE" && Number.isInteger(r.detalhes?.pendenteCentavos) ? ` (agora faltam só ${reais(r.detalhes.pendenteCentavos)} para prestar contas dessa retirada)` : r.recusa === "SEM_SANGRIA_PENDENTE" ? " (essa retirada já foi prestada)" : ""}. Nada entrou no Financeiro; se quiser, refaço a proposta com os dados atuais.`;
    case "EM_EXECUCAO": return "Esse lançamento está sendo processado agora. Pergunte daqui a pouco se foi lançado; nada será gravado em duplicidade.";
    case "OUTRA_PESSOA": return "Só quem pediu este lançamento pode confirmá-lo. Nada entrou no Financeiro.";
    case "SEM_AUTORIZACAO_DE_ESCRITA": return "Você não tem autorização para confirmar lançamentos pelo MOVA nesta unidade. Nada entrou no Financeiro; a proposta fica visível para quem pode confirmar na Central.";
    case "EXECUCAO_DESLIGADA": return "A execução de lançamentos pelo MOVA está desligada. Nada entrou no Financeiro; a proposta fica registrada para a Central.";
    case "REVISAO_HUMANA": return "Este lançamento precisa de revisão humana (fora do limite ou sem política para o MOVA lançar). Nada entrou no Financeiro; ele foi para a Central Financeira.";
    case "OPERACAO_PROIBIDA": return "O MOVA não faz esse tipo de lançamento. Nada entrou no Financeiro.";
    case "PROPOSTA_ALTERADA": case "CONFIRMACAO_CONCORRENTE": case "CONCORRENCIA": return "A proposta mudou enquanto você confirmava (outra confirmação ou edição). Nada entrou no Financeiro em duplicidade; confira e confirme de novo.";
    case "FALHA_NA_EXECUCAO":
      if (r.parcial) return `Registrei só parte: ${desfechoDosFeitos(r.feitos)}. O restante NÃO entrou no Financeiro: ${r.mensagem ?? r.codigo}.${r.retentavel ? " Responda 'sim' para tentar de novo só o que faltou." : ""}`;
      return `Não consegui lançar: ${r.mensagem ?? r.codigo}. Nada entrou no Financeiro.${r.retentavel ? " Responda 'sim' para tentar de novo." : ""}`;
    default: return "Não foi possível concluir. Nada entrou no Financeiro.";
  }
}
