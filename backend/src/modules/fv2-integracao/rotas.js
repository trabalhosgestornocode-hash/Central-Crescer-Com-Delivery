// ROTAS do Financeiro v2 na plataforma (Execução 10). Montadas em /api/v1/financeiro-v2 DEPOIS de requireAuth +
// requireContexto (a plataforma já validou o token no provedor e releu a sessão de contexto assinada).
//
// Por requisição: sessão da plataforma → adaptador do v2 (impersonação, perfil de exibição, conta compartilhada, pessoa
// sem identidade, unidade não autorizada/não liberada, sessão expirada, concessão própria do v2) → núcleo com escopo SÓ
// da unidade da sessão → repositório PostgreSQL, cuja sessão de banco é emitida pelo GATEWAY separado.
//   GET  /status                      estado para o menu (nunca lança)
//   GET  /sessao                      unidade da sessão + permissões do v2 (a unidade NUNCA vem do cliente)
//   GET  /api/<consulta>              consultas (somente leitura)
//   POST /acoes/<ação>                escritas — só com escrita habilitada; conceder/revogar/homologar/reabrir exigem
//                                     segundo fator recente comprovado; homologar exige ainda a matriz aprovada
// Desligado (padrão): nada responde além de /status ("não liberado"); a plataforma segue com o financeiro atual.
import { Router, json } from "express";
import { ACAO, CODIGO, FINALIDADE_DO_GATEWAY, criarNucleoFinanceiro, tempo } from "../financeiro-v2/index.js";
import { comIdentidadeDaRequisicao, resumoDaSessao } from "./clienteGateway.js";
import { CONSULTAS, pessoasDaUnidade } from "./consultas.js";
import { ESCRITAS } from "./escritas.js";
import { lerPayloadSemConfiar } from "./mfaPeloProvedor.js";

const STATUS_POR_CODIGO = Object.freeze({
  [CODIGO.SESSAO_AUSENTE]: 401, [CODIGO.SESSAO_INVALIDA]: 401, [CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [CODIGO.PERMISSAO_INSUFICIENTE]: 403,
  [CODIGO.CONTEXTO_INVALIDO]: 403, [CODIGO.ENTRADA_INVALIDA]: 400, [CODIGO.DATA_INVALIDA]: 400, [CODIGO.VALOR_INVALIDO]: 400, [CODIGO.NAO_ENCONTRADO]: 404,
  [CODIGO.TRANSICAO_INVALIDA]: 409, [CODIGO.CONCILIACAO_INVALIDA]: 409, [CODIGO.CONFLITO_IDEMPOTENCIA]: 409, [CODIGO.CONFLITO_VERSAO]: 409,
  [CODIGO.IMPORTACAO_INVALIDA]: 422, [CODIGO.HOMOLOGACAO_BLOQUEADA]: 409, [CODIGO.COMPETENCIA_HOMOLOGADA]: 409, [CODIGO.CONFIRMACAO_EXIGIDA]: 400,
  [CODIGO.CATEGORIA_INVALIDA]: 409, [CODIGO.OPERACAO_INVALIDA]: 409, [CODIGO.DOCUMENTO_INDISPONIVEL]: 409, [CODIGO.DOCUMENTO_ADULTERADO]: 409,
  [CODIGO.COFRE_INDISPONIVEL]: 503, [CODIGO.EVIDENCIA_EXIGIDA]: 409, [CODIGO.DOCUMENTO_INVALIDO]: 422, [CODIGO.LIQUIDACAO_EXCEDE_SALDO]: 409,
  [CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO]: 409, [CODIGO.LIQUIDACAO_INCOMPATIVEL]: 409, [CODIGO.AJUSTE_EXCEDE_SALDO]: 409, [CODIGO.INTEGRIDADE_VIOLADA]: 409,
});
const DESLIGADO = Object.freeze({ liberado: false, disponivel: false, operavel: false, motivo: "FINANCEIRO_V2_DESLIGADO" });
const recusa = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { codigoHttp: status, codigo });

const tokenDe = (req) => {
  const h = req.header("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

function responderErro(res, e, registrar) {
  // O erro sai com `erro` (contrato da interface) e `codigo` (contrato da plataforma), nunca com detalhe interno.
  const corpo = (codigo, mensagem, motivo = null) => ({ erro: codigo, codigo, mensagem, motivo });
  if (e?.statusGateway === 503) return res.status(503).json(corpo("AUTORIZACAO_FINANCEIRA_INDISPONIVEL", "O serviço de autorização financeira não respondeu. Tente de novo."));
  if (e?.codigoHttp) return res.status(e.codigoHttp).json(corpo(e.codigo, e.message));
  const status = STATUS_POR_CODIGO[e?.codigo];
  if (status) return res.status(status).json(corpo(e.codigo, e.message, e?.detalhes?.motivo ?? null));
  registrar({ tipo: "FALHA_INESPERADA", codigo: e?.codigo ?? null, sqlstate: e?.detalhes?.sqlstate ?? e?.code ?? null });
  return res.status(500).json(corpo("FALHA_DA_CONSULTA", "Não foi possível concluir agora. Nada foi alterado sem confirmação."));
}

/**
 * @param {object} p
 * @param {boolean} p.habilitado chave geral (FV2_HABILITADO=1); desligado = nada responde
 * @param {boolean} [p.escritaHabilitada] FV2_ESCRITA_HABILITADA=1 (padrão: desligada)
 * @param {boolean} [p.homologacaoHabilitada] FV2_HOMOLOGACAO_HABILITADA=1 — só depois da matriz aprovada (padrão: não)
 * @param {() => {repositorio:object, adaptador:object, vinculos:object, relogio?:Function}} p.dependencias
 * @param {(evento:object)=>void} [p.registrar]
 */
export function criarRotasFinanceiroV2({ habilitado, escritaHabilitada = false, homologacaoHabilitada = false, dependencias, registrar = () => {} }) {
  const r = Router();
  let deps = null;
  const obter = () => (deps ??= dependencias());

  r.use((req, res, next) => {
    const acao = req.method === "POST" && req.path.startsWith("/acoes/");
    if (req.method !== "GET" && !acao) return res.status(405).json({ erro: "METODO_NAO_PERMITIDO", codigo: "METODO_NAO_PERMITIDO", mensagem: "Método não permitido." });
    if (!habilitado) return req.path === "/status" && req.method === "GET" ? res.json(DESLIGADO) : res.status(404).json({ erro: "FINANCEIRO_V2_DESLIGADO", codigo: "FINANCEIRO_V2_DESLIGADO", mensagem: "O Financeiro v2 não está ativo." });
    if (acao && !escritaHabilitada) return res.status(403).json({ erro: "ESCRITA_DESLIGADA", codigo: "ESCRITA_DESLIGADA", mensagem: "Nesta fase o Financeiro v2 está liberado só para consulta." });
    for (const v of Object.values(req.query)) if (typeof v !== "string") return res.status(400).json({ erro: "PARAMETRO_INVALIDO", codigo: "PARAMETRO_INVALIDO", mensagem: "Parâmetro repetido ou inválido." });
    return next();
  });

  /** Roda `fn` com a identidade da requisição disponível ao gateway. */
  async function comIdentidade(req, fn, finalidade = FINALIDADE_DO_GATEWAY.OPERACAO) {
    const { vinculos } = obter();
    const sessao = { user: req.user, tenant: req.tenant, acesso: req.acesso };
    // Defesa em profundidade: o token (já validado no provedor por requireAuth) tem de ser da MESMA conta da sessão.
    // A sessão de banco pode ser reaproveitada por alguns minutos sem nova ida ao gateway; esta conferência é por requisição.
    const t = tokenDe(req);
    const p = lerPayloadSemConfiar(t);
    if (!p || typeof p.sub !== "string" || p.sub.toLowerCase() !== String(req.user?.id ?? "").toLowerCase()) {
      throw Object.assign(new Error("Sessão inválida: entre novamente."), { codigo: CODIGO.SESSAO_INVALIDA, detalhes: { motivo: "TOKEN_DE_OUTRA_CONTA" } });
    }
    // Conta pessoal (uma única pessoa ativa) é conferida de novo pelo adaptador; aqui só informa o gateway.
    let contaPessoal = false;
    try { contaPessoal = (await vinculos.perfisAtivosDaConta({ contaId: String(req.user?.id ?? "").toLowerCase() })) === 1; } catch { contaPessoal = false; }
    return comIdentidadeDaRequisicao({ tokenDeAcesso: t, sessao: resumoDaSessao(sessao), contaPessoal, finalidade }, () => fn(sessao, t));
  }

  /** Contexto verificado + núcleo com escopo SÓ da unidade da sessão. */
  async function preparar(sessao, opcoes = {}) {
    const { adaptador, repositorio, relogio } = obter();
    const c = await adaptador.contexto(sessao, opcoes);
    const nucleo = criarNucleoFinanceiro({
      repositorio, ...(relogio ? { relogio } : {}), exigirConcessaoPersistida: true,
      escoposAutorizados: [{ organizacaoId: c.contexto.organizacaoId, unidadeId: c.contexto.unidadeId }],
    });
    return { c, nucleo };
  }

  r.get("/status", async (req, res) => {
    try {
      return res.json(await comIdentidade(req, (sessao) => obter().adaptador.disponibilidade(sessao)));
    } catch {
      return res.json({ liberado: false, disponivel: false, operavel: false, motivo: "FALHA_FECHADA" });
    }
  });

  r.get("/sessao", async (req, res) => {
    try {
      const corpo = await comIdentidade(req, async (sessao) => {
        const { c } = await preparar(sessao);
        const { relogio } = obter();
        return {
          modo: "PLATAFORMA", dataBase: tempo.hojeEm(relogio ? relogio() : new Date()), csrf: null, usuario: req.user?.nome ?? null,
          escritaHabilitada, homologacaoHabilitada, pessoasDemo: [],
          unidades: [{ id: c.contexto.unidadeId, nome: req.acesso?.unidade?.nome ?? "Unidade", permissoes: [...c.contexto.permissoes] }],
        };
      });
      res.set("cache-control", "no-store");
      return res.json(corpo);
    } catch (e) {
      return responderErro(res, e, registrar);
    }
  });

  r.get("/api/pessoas", async (req, res) => {
    try {
      const corpo = await comIdentidade(req, async (sessao) => {
        const { c, nucleo } = await preparar(sessao);
        const { vinculos } = obter();
        return pessoasDaUnidade(nucleo, c.contexto, async (ids) => (typeof vinculos.nomesDosPerfis === "function" ? vinculos.nomesDosPerfis({ perfilIds: ids }) : new Map()));
      });
      res.set("cache-control", "no-store");
      return res.json(corpo);
    } catch (e) {
      return responderErro(res, e, registrar);
    }
  });

  for (const [caminho, consulta] of Object.entries(CONSULTAS)) {
    r.get(`/api${caminho}`, async (req, res) => {
      try {
        const corpo = await comIdentidade(req, async (sessao) => {
          const { c, nucleo } = await preparar(sessao);
          return consulta(nucleo, c.contexto, req.query);
        });
        res.set("cache-control", "no-store");
        return res.json(corpo);
      } catch (e) {
        return responderErro(res, e, registrar);
      }
    });
  }

  const corpoJson = json({ limit: "64kb", strict: true });
  for (const [caminho, escrita] of Object.entries(ESCRITAS)) {
    r.post(`/acoes${caminho}`, corpoJson, async (req, res) => {
      try {
        // Ações só por JSON (formulário/navegador sem script não dispara) e sem campos fora da lista.
        if (!req.is("application/json")) throw recusa(415, "TIPO_DE_CONTEUDO", "Envie a ação como JSON.");
        const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
        const fora = Object.keys(b).filter((k) => !escrita.campos.includes(k));
        if (fora.length) throw recusa(400, "CAMPO_DESCONHECIDO", "A ação recebeu campos que não aceita.");
        const acaoSensivel = typeof escrita.sensivel === "function" ? escrita.sensivel(b) : null;
        if (acaoSensivel === ACAO.HOMOLOGAR && !homologacaoHabilitada) {
          throw recusa(403, "HOMOLOGACAO_AGUARDA_MATRIZ", "A homologação fica bloqueada até a aprovação da matriz de pendências.");
        }
        const finalidade = acaoSensivel ? FINALIDADE_DO_GATEWAY.ACAO_SENSIVEL : FINALIDADE_DO_GATEWAY.OPERACAO;
        const corpo = await comIdentidade(req, async (sessao, token) => {
          const { c, nucleo } = await preparar(sessao, acaoSensivel ? { acao: acaoSensivel, tokenDeAcesso: token } : {});
          const resultado = await escrita.fazer(nucleo, c.contexto, b);
          registrar({ tipo: "ACAO_FINANCEIRA", acao: caminho, unidadeId: c.contexto.unidadeId, pessoa: c.contexto.usuarioId, segundoFator: Boolean(acaoSensivel) });
          return resultado ?? { ok: true };
        }, finalidade);
        res.set("cache-control", "no-store");
        return res.json(corpo);
      } catch (e) {
        return responderErro(res, e, registrar);
      }
    });
  }
  return r;
}
