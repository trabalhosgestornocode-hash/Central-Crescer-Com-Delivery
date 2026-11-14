// ROTAS do Financeiro v2 na plataforma (Execução 10). Montadas em /api/financeiro-v2 DEPOIS de requireAuth +
// requireContexto (a plataforma já validou o token no provedor e releu a sessão de contexto assinada).
//
// Por requisição: sessão da plataforma → adaptador do v2 (impersonação, perfil de exibição, conta compartilhada, pessoa
// sem identidade, unidade não autorizada/não liberada, sessão expirada, concessão própria do v2) → núcleo com escopo SÓ
// da unidade da sessão → repositório PostgreSQL, cuja sessão de banco é emitida pelo GATEWAY separado.
// Desligado (padrão): nenhuma consulta responde; /status diz "não liberado" e a plataforma segue com o financeiro atual.
import { Router } from "express";
import { CODIGO, FINALIDADE_DO_GATEWAY, criarNucleoFinanceiro } from "../financeiro-v2/index.js";
import { comIdentidadeDaRequisicao, resumoDaSessao } from "./clienteGateway.js";
import { CONSULTAS } from "./consultas.js";
import { lerPayloadSemConfiar } from "./mfaPeloProvedor.js";

const STATUS_POR_CODIGO = Object.freeze({
  [CODIGO.SESSAO_AUSENTE]: 401, [CODIGO.SESSAO_INVALIDA]: 401, [CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [CODIGO.PERMISSAO_INSUFICIENTE]: 403,
  [CODIGO.CONTEXTO_INVALIDO]: 403, [CODIGO.ENTRADA_INVALIDA]: 400, [CODIGO.DATA_INVALIDA]: 400, [CODIGO.NAO_ENCONTRADO]: 404,
});
const DESLIGADO = Object.freeze({ liberado: false, disponivel: false, operavel: false, motivo: "FINANCEIRO_V2_DESLIGADO" });

const tokenDe = (req) => {
  const h = req.header("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

function responderErro(res, e, registrar) {
  if (e?.statusGateway === 503) return res.status(503).json({ codigo: "AUTORIZACAO_FINANCEIRA_INDISPONIVEL", mensagem: "O serviço de autorização financeira não respondeu. Tente de novo." });
  if (e?.codigoHttp) return res.status(e.codigoHttp).json({ codigo: e.codigo, mensagem: e.message });
  const status = STATUS_POR_CODIGO[e?.codigo];
  if (status) return res.status(status).json({ codigo: e.codigo, mensagem: e.message, motivo: e?.detalhes?.motivo ?? null });
  registrar({ tipo: "FALHA_INESPERADA", codigo: e?.codigo ?? null, sqlstate: e?.detalhes?.sqlstate ?? e?.code ?? null });
  return res.status(500).json({ codigo: "FALHA_DA_CONSULTA", mensagem: "Não foi possível consultar agora." });
}

/**
 * @param {object} p
 * @param {boolean} p.habilitado chave geral (FV2_HABILITADO=1); desligado = nada responde
 * @param {() => {repositorio:object, adaptador:object, vinculos:object, relogio?:Function}} p.dependencias criadas só
 *        quando ligado (pools, cliente do gateway, portas da plataforma)
 * @param {(evento:object)=>void} [p.registrar]
 */
export function criarRotasFinanceiroV2({ habilitado, dependencias, registrar = () => {} }) {
  const r = Router();
  let deps = null;
  const obter = () => (deps ??= dependencias());

  r.use((req, res, next) => {
    if (req.method !== "GET") return res.status(405).json({ codigo: "SOMENTE_LEITURA", mensagem: "Nesta fase o Financeiro v2 é somente consulta." });
    if (!habilitado) return req.path === "/status" ? res.json(DESLIGADO) : res.status(404).json({ codigo: "FINANCEIRO_V2_DESLIGADO", mensagem: "O Financeiro v2 não está ativo." });
    for (const v of Object.values(req.query)) if (typeof v !== "string") return res.status(400).json({ codigo: "PARAMETRO_INVALIDO", mensagem: "Parâmetro repetido ou inválido." });
    return next();
  });

  /** Roda `fn` com a identidade da requisição disponível ao gateway (finalidade: operação comum). */
  async function comIdentidade(req, fn) {
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
    return comIdentidadeDaRequisicao({ tokenDeAcesso: t, sessao: resumoDaSessao(sessao), contaPessoal, finalidade: FINALIDADE_DO_GATEWAY.OPERACAO }, () => fn(sessao));
  }

  r.get("/status", async (req, res) => {
    try {
      const estado = await comIdentidade(req, (sessao) => obter().adaptador.disponibilidade(sessao));
      return res.json(estado);
    } catch {
      return res.json({ liberado: false, disponivel: false, operavel: false, motivo: "FALHA_FECHADA" });
    }
  });

  for (const [caminho, consulta] of Object.entries(CONSULTAS)) {
    r.get(`/api${caminho}`, async (req, res) => {
      try {
        const corpo = await comIdentidade(req, async (sessao) => {
          const { adaptador, repositorio, relogio } = obter();
          const c = await adaptador.contexto(sessao);
          const nucleo = criarNucleoFinanceiro({
            repositorio, ...(relogio ? { relogio } : {}), exigirConcessaoPersistida: true,
            escoposAutorizados: [{ organizacaoId: c.contexto.organizacaoId, unidadeId: c.contexto.unidadeId }],
          });
          return consulta(nucleo, c.contexto, req.query);
        });
        res.set("cache-control", "no-store");
        return res.json(corpo);
      } catch (e) {
        return responderErro(res, e, registrar);
      }
    });
  }
  return r;
}
