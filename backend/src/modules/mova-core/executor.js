// MOVA CORE — F1: EXECUTOR SEGURO de ferramentas. Toda chamada do modelo passa por aqui, na ordem:
//   1. ferramenta existe no catálogo (nome desconhecido ⇒ erro, nada executa);
//   2. argumentos validados pelo esquema ESTRITO (campo desconhecido/tipo errado ⇒ ARGUMENTO_INVALIDO);
//   3. referências opacas resolvidas (ref de outra unidade ou UUID cru ⇒ REFERENCIA_INVALIDA);
//   4. unidade: a da conversa, ou uma das unidades que ESTA pessoa pode consultar NESTA conversa (outra ⇒ FORA_DO_ESCOPO);
//   5. valores: ferramenta com valores só para perfil com consultas "TODAS" e conversa que permite valores;
//   6. permissão REVALIDADA a cada chamada na concessão gravada do Financeiro (financeiro_v2.ver na unidade alvo);
//   7. o escopo (organização, unidade, usuário) é INJETADO aqui — o modelo nunca o informa;
//   8. execução com tempo-limite; resultado compactado, UUIDs trocados por referências, tamanho limitado;
//   9. auditoria de cada chamada (ferramenta, unidade, argumentos sem dado pessoal, resultado, duração) e cache curto por conversa.
// Nenhuma ferramenta do catálogo escreve: `preparar_registro` só devolve o pedido entendido (executado:false).
import { validarEsquema, ErroDeArgumento } from "./esquema.js";
import { ErroDeReferencia } from "./referencias.js";
import { comMemoDeLeituras } from "./leituras.js";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
/** "R$ 1.234,56" a partir de centavos (o mesmo formato que o verificador lê). */
export const emReais = (c) => BRL.format(c / 100).replace(/\u00a0/g, " ");
/**
 * F3 — VALORES JÁ EM REAIS PARA O MODELO: todo campo inteiro `xxxCentavos` ganha o irmão `xxxEmReais` formatado pelo CÓDIGO.
 * Na avaliação real, a maior fonte de correção era a conversão de centavos feita de cabeça (R$ 8.230,00 no lugar de R$ 82.300,00).
 * Os centavos continuam (são o que `calcular` recebe); os fatos do verificador não mudam.
 */
export function comReais(o, prof = 0) {
  if (prof > 8 || o === null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map((x) => comReais(x, prof + 1));
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    r[k] = comReais(v, prof + 1);
    if (/Centavos$/.test(k) && Number.isInteger(v)) r[k.replace(/Centavos$/, "EmReais")] = emReais(v);
  }
  return r;
}

export const LIMITES_DO_EXECUTOR = Object.freeze({ tempoMs: 8000, maxCaracteres: 12000, cacheMs: 60_000, maxChamadasPorRequisicao: 12, leiturasSimultaneas: 1, esperaNovaTentativaMs: 400 });
const esperar = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
/** Fila curta por mensagem: no máximo `vagas` leituras ao mesmo tempo (null = sem fila, para ferramentas locais). */
async function comVaga(sessao, vagas, fn) {
  if (!vagas) return fn();
  const s = (sessao.semaforo ??= { livres: vagas, espera: [] });
  if (s.livres > 0) s.livres--; else await new Promise((ok) => { s.espera.push(ok); });
  try { return await fn(); } finally { const proxima = s.espera.shift(); if (proxima) proxima(); else s.livres++; }
}
const ACAO_VER = "financeiro_v2.ver";

export class ErroDeFerramenta extends Error {
  constructor(codigo, mensagem) { super(mensagem ?? codigo); this.codigo = codigo; }
}

const comTempo = (p, ms) => new Promise((ok, falha) => {
  const t = setTimeout(() => falha(new ErroDeFerramenta("TEMPO_ESGOTADO", "A consulta demorou demais.")), ms);
  p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); falha(e); });
});

/**
 * @param {object} deps
 * @param {object} deps.catalogo  { nome: ferramenta }
 * @param {object} deps.porta     { ler(op, escopo, entrada), permissoesDoUsuario(escopo), ehErroDeRegra?(e) }
 * @param {object} deps.auditoria { registrar(evento) }
 */
import { COMO_COMUNICAR, marcarFatos, situacaoDoCodigo, situacaoDoResultado } from "./situacao.js";

export function criarExecutor({ catalogo, porta, auditoria = { registrar() {} }, relogio = () => Date.now(), limites = LIMITES_DO_EXECUTOR }) {
  if (!catalogo || !porta?.ler || !porta?.permissoesDoUsuario) throw new TypeError("executor exige catálogo e porta de leitura");

  /**
   * Uma requisição (uma mensagem da pessoa): referências, fatos e cache vivem na SESSÃO da conversa (criada por quem chama).
   * @param {object} sessao { organizacaoId, unidadeId, usuarioId, unidadesPermitidas:[{id,nome}], perfil:{consultas}, podeValores, referencias, fatos:[], cache:Map, requisicaoId }
   */
  async function executar(sessao, chamada) {
    const inicio = relogio();
    const nome = chamada?.name;
    const registro = { tipo: "MOVA_CORE_FERRAMENTA", requisicaoId: sessao.requisicaoId ?? null, ferramenta: nome ?? null, unidadeId: sessao.unidadeId };
    const falhar = (codigo, mensagem) => {
      // §3: a falha também diz a SITUAÇÃO (bloqueado ≠ falha técnica ≠ sem registros ≠ indisponível) e como comunicá-la
      const situacao = situacaoDoCodigo(codigo);
      auditoria.registrar({ ...registro, ok: false, codigo, situacao, ms: relogio() - inicio });
      if (situacao) (sessao.situacoes ??= []).push({ ferramenta: nome ?? null, situacao, codigo });
      return { ok: false, codigo, situacao, conteudo: JSON.stringify({ erro: codigo, mensagem, ...(situacao ? { situacao, comoComunicar: COMO_COMUNICAR[situacao] } : {}) }) };
    };
    sessao.chamadas = (sessao.chamadas ?? 0) + 1;
    if (sessao.chamadas > limites.maxChamadasPorRequisicao) return falhar("LIMITE_DE_CHAMADAS", "Limite de consultas desta pergunta atingido.");
    const f = Object.hasOwn(catalogo, nome) ? catalogo[nome] : null;
    if (!f) return falhar("FERRAMENTA_DESCONHECIDA", `Não existe a ferramenta ${String(nome).slice(0, 60)}.`);

    let args;
    try { args = validarEsquema(f.esquema, chamada.input ?? {}); }
    catch (e) {
      if (e instanceof ErroDeArgumento) return falhar("ARGUMENTO_INVALIDO", /unidade/.test(e.caminho ?? "") ? `${e.message}. Para a unidade desta conversa, omita "unidade"; para outra, use a referência exata de listar_unidades.` : e.message);
      throw e;
    }

    // unidade alvo: só dentre as permitidas NESTA conversa (referência opaca de listar_unidades)
    let unidadeId = sessao.unidadeId;
    try {
      if (args.unidade !== undefined) unidadeId = sessao.referencias.resolver(args.unidade, "__unidades__");
      args = sessao.referencias.resolver(Object.fromEntries(Object.entries(args).filter(([k]) => k !== "unidade")), unidadeId);
    } catch (e) { if (e instanceof ErroDeReferencia) return falhar("REFERENCIA_INVALIDA", e.message); throw e; }
    if (!sessao.unidadesPermitidas.some((u) => u.id === unidadeId)) return falhar("FORA_DO_ESCOPO", "Essa unidade não pode ser consultada nesta conversa.");
    registro.unidadeId = unidadeId;

    if (f.valores && !(sessao.perfil?.consultas === "TODAS" && sessao.podeValores)) return falhar("SEM_PERMISSAO_PARA_VALORES", "Valores financeiros não podem ser mostrados para este perfil ou nesta conversa.");

    const escopo = Object.freeze({ organizacaoId: sessao.organizacaoId, unidadeId, usuarioId: sessao.usuarioId });
    if (!f.local) {
      let acoes;
      try { acoes = await porta.permissoesDoUsuario(escopo); } catch { return falhar("FINANCEIRO_INDISPONIVEL", "Não consegui conferir a permissão agora."); }
      if (!(acoes ?? []).includes(ACAO_VER)) return falhar("SEM_PERMISSAO", "Sem permissão de consulta financeira nesta unidade.");
    }

    // cache ISOLADO por organização, unidade, identidade e permissão (e só dentro da MESMA mensagem: a pergunta seguinte lê de novo)
    const chave = `${nome}|${sessao.organizacaoId}|${unidadeId}|${sessao.usuarioId ?? "-"}|${sessao.perfil?.consultas ?? "-"}|${sessao.podeValores ? 1 : 0}|${JSON.stringify(args)}`;
    const emCache = sessao.cache?.get(chave);
    let r; let consultadoEm = relogio();
    // ferramenta que PREPARA/ESCREVE ou que lê o estado de propostas nunca vem do cache (o mesmo pedido com outro anexo é outro pedido)
    const semCache = Boolean(f.local || f.escrita || f.semCache);
    if (emCache && relogio() - emCache.em < limites.cacheMs && !semCache) { r = emCache.r; registro.cache = true; consultadoEm = emCache.em; } // do cache: vale a data da consulta ORIGINAL
    else {
      // 25/11 (homologação real): leituras da MESMA mensagem compartilham a carga (memória por mensagem) e no máximo
      // `leiturasSimultaneas` vão ao Financeiro ao mesmo tempo (o leitor do MOVA tem 1 conexão por instância); o tempo-limite
      // conta a partir da VAGA (esperar a vez não é lentidão da consulta). Falha transitória (conexão recusada, banco
      // momentaneamente indisponível) tem UMA nova tentativa curta — é leitura, repetir não tem efeito.
      sessao.portaDaMensagem ??= comMemoDeLeituras(porta);
      const rodar = () => comTempo(Promise.resolve(f.executar({ porta: sessao.portaDaMensagem, escopo, args, sessao, fatosDaConversa: () => sessao.fatos })), f.tempoMs ?? limites.tempoMs);
      const transitorio = (e) => e?.name === "ErroTransitorio" || e?.constructor?.name === "ErroTransitorio";
      try {
        r = await comVaga(sessao, f.local ? null : (limites.leiturasSimultaneas ?? 2), async () => {
          try { return await rodar(); } catch (e) {
            if (!transitorio(e) || f.local || f.escrita) throw e;
            registro.novaTentativa = { causa: e?.causa ?? null };
            await esperar(limites.esperaNovaTentativaMs ?? 400);
            return rodar();
          }
        });
      } catch (e) {
        if (e instanceof ErroDeFerramenta) return falhar(e.codigo, e.message);
        if (porta.ehErroDeRegra?.(e)) return falhar("NAO_ENCONTRADO_OU_INVALIDO", "O Financeiro não encontrou isso nesta unidade.");
        // indisponibilidade real (rede/banco) chega como ErroTransitorio da porta; qualquer outra coisa é DEFEITO da ferramenta
        if (transitorio(e)) { registro.causa = e?.causa ?? null; return falhar("FINANCEIRO_INDISPONIVEL", "O Financeiro não respondeu agora."); }
        registro.defeito = String(e?.message ?? e).slice(0, 200);
        return falhar("FALHA_INTERNA_DA_FERRAMENTA", "Não consegui ler esse dado agora.");
      }
      if (!semCache) sessao.cache?.set(chave, { r, em: relogio() });
    }
    if (r?.erro) return falhar(r.erro, r.dados?.mensagem);
    const situacao = situacaoDoResultado(r);
    (sessao.situacoes ??= []).push({ ferramenta: nome, situacao, codigo: null });
    r = { ...r, fatos: marcarFatos(r.fatos, situacao) };

    const unidade = sessao.unidadesPermitidas.find((u) => u.id === unidadeId);
    // unidades viram referência no espaço próprio "__unidades__"; o restante no espaço da unidade alvo
    let dados = r.dados;
    if (nome === "listar_unidades") dados = { unidades: dados.unidades.map((u) => ({ ...u, id: sessao.referencias.opacar(u.id, "__unidades__") })) };
    else dados = sessao.referencias.opacar(dados, unidadeId);
    // F2 — EVIDÊNCIA ESTRUTURADA: cada fato carrega fonte, instante da consulta, natureza e um id de evidência
    for (const x of r.fatos ?? []) sessao.fatos.push({ ...x, unidadeId: x.unidadeId ?? unidadeId, unidade: x.unidade ?? unidade?.nome ?? null, ferramenta: nome, fonte: { ferramenta: nome, operacoes: f.ops ?? [] },
      consultadoEm: x.derivado ? relogio() : consultadoEm, evidenciaId: `ev_${(sessao.evidencias = (sessao.evidencias ?? 0) + 1)}`, natureza: naturezaDe(x.significado), estado: estadoDe(x.significado) });
    if (r.numeros) sessao.fatos.push({ valorCentavos: null, numeros: r.numeros, ferramenta: nome });
    // inteiros não-monetários (entregas, quantidades) também podem entrar em `calcular`
    coletarNumeros(r.dados, sessao);

    let conteudo = JSON.stringify({ unidade: unidade?.nome ?? null, situacao, ...(COMO_COMUNICAR[situacao] ? { comoComunicar: COMO_COMUNICAR[situacao] } : {}), ...(f.valores === false ? dados : comReais(dados)) });
    if (conteudo.length > limites.maxCaracteres) conteudo = `${conteudo.slice(0, limites.maxCaracteres)}…[resultado cortado: refine o filtro]`;
    auditoria.registrar({ ...registro, ok: true, ms: relogio() - inicio, caracteres: conteudo.length, fatos: (r.fatos ?? []).length, escrita: f.escrita ?? null });
    return { ok: true, conteudo, ferramenta: nome, unidadeId, situacao };
  }
  return Object.freeze({ executar });
}

/** Natureza financeira do fato (não confundir despesa × pagamento, saldo × faturamento, receita × recebimento, sangria × despesa). */
export function naturezaDe(s) {
  const t = String(s ?? "");
  if (/^PAGO|ENTREGADOR_PAGO/.test(t)) return "PAGAMENTO";
  if (/^A_PAGAR|ENTREGADOR_A_PAGAR|^VALOR_DAS_CONTAS/.test(t)) return "OBRIGACAO";
  if (/^A_RECEBER/.test(t)) return "RECEBIVEL";
  if (/^RECEBIDO/.test(t)) return "RECEBIMENTO";
  if (/^VENDAS:/.test(t)) return "FATURAMENTO";
  if (/^DRE:/.test(t)) return "RESULTADO";
  if (/^SALDO_|^DIFERENCA_DE_SALDO/.test(t)) return "SALDO";
  if (/^FLUXO:/.test(t)) return "FLUXO_DE_CAIXA";
  if (/RETIRADAS_DO_CAIXA|REFORCOS_DO_CAIXA|MOVIMENTO_DE_CAIXA/.test(t)) return "MOVIMENTO_DE_CAIXA";
  if (/^CALCULO:/.test(t)) return "CALCULO";
  return "OUTRO";
}
function estadoDe(s) {
  const t = String(s ?? "");
  if (/VENCIDO/.test(t)) return "VENCIDO"; if (/EM_ABERTO|A_PAGAR|A_RECEBER/.test(t)) return "EM_ABERTO"; if (/^PAGO|RECEBIDO|ENTREGADOR_PAGO/.test(t)) return "LIQUIDADO";
  if (/INFORMADO/.test(t)) return "INFORMADO"; if (/CALCULADO/.test(t)) return "CALCULADO"; return null;
}

function coletarNumeros(o, sessao, prof = 0) {
  if (prof > 5 || !o || typeof o !== "object") return;
  const ns = [];
  for (const [k, v] of Object.entries(o)) {
    if (Number.isFinite(v) && !k.endsWith("Centavos")) ns.push(v); // F3: decimais também (percentuais e indicadores das ferramentas)
    else if (v && typeof v === "object") coletarNumeros(v, sessao, prof + 1);
  }
  if (ns.length) sessao.fatos.push({ valorCentavos: null, numeros: ns, ferramenta: null });
}

/** Sessão de UMA requisição, ligada à memória da conversa (referências persistem na conversa, fatos e cache por requisição). */
export function novaSessao({ conversa, fatos = null, organizacaoId, unidadeId, usuarioId, unidadesPermitidas, perfil, podeValores, requisicaoId, hoje = null }) {
  return { organizacaoId, unidadeId, usuarioId, unidadesPermitidas, perfil, podeValores, requisicaoId, hoje, referencias: conversa.referencias, fatos: [...(fatos ?? conversa.fatos ?? [])], cache: new Map(), chamadas: 0 };
}
