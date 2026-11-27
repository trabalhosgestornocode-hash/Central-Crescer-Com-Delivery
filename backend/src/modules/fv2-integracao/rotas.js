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
import { ACAO, CODIGO, FINALIDADE_DO_GATEWAY, PERFIS_DE_ACESSO, alterarLiberacaoPostgres, criarAutoridadeDaPlataforma, criarNucleoFinanceiro, identificarSessao, tempo } from "../financeiro-v2/index.js";
import { comIdentidadeDaRequisicao, identidadeDaRequisicao, resumoDaSessao } from "./clienteGateway.js";
import { CONSULTAS, pessoasDaUnidade } from "./consultas.js";
import { ESCRITAS } from "./escritas.js";
import { criarCofreTemporario } from "./cofreTemporario.js";
import { lerPayloadSemConfiar } from "./mfaPeloProvedor.js";
import { ACOES_MOVA, CONSULTAS_MOVA, executarAcaoMova } from "./movaRotas.js";

const STATUS_POR_CODIGO = Object.freeze({
  [CODIGO.SESSAO_AUSENTE]: 401, [CODIGO.SESSAO_INVALIDA]: 401, [CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [CODIGO.PERMISSAO_INSUFICIENTE]: 403,
  [CODIGO.CONTEXTO_INVALIDO]: 403, [CODIGO.ENTRADA_INVALIDA]: 400, [CODIGO.DATA_INVALIDA]: 400, [CODIGO.VALOR_INVALIDO]: 400, [CODIGO.NAO_ENCONTRADO]: 404,
  [CODIGO.TRANSICAO_INVALIDA]: 409, [CODIGO.CONCILIACAO_INVALIDA]: 409, [CODIGO.CONFLITO_IDEMPOTENCIA]: 409, [CODIGO.POSSIVEL_DUPLICIDADE]: 409, [CODIGO.CONFLITO_VERSAO]: 409,
  [CODIGO.IMPORTACAO_INVALIDA]: 422, [CODIGO.HOMOLOGACAO_BLOQUEADA]: 409, [CODIGO.COMPETENCIA_HOMOLOGADA]: 409, [CODIGO.CONFIRMACAO_EXIGIDA]: 400,
  [CODIGO.CATEGORIA_INVALIDA]: 409, [CODIGO.OPERACAO_INVALIDA]: 409, [CODIGO.DOCUMENTO_INDISPONIVEL]: 409, [CODIGO.DOCUMENTO_ADULTERADO]: 409,
  [CODIGO.COFRE_INDISPONIVEL]: 503, [CODIGO.PROVISIONAMENTO_RECUSADO]: 403, [CODIGO.EVIDENCIA_EXIGIDA]: 409, [CODIGO.DOCUMENTO_INVALIDO]: 422, [CODIGO.LIQUIDACAO_EXCEDE_SALDO]: 409,
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
export function criarRotasFinanceiroV2({ habilitado, escritaHabilitada = false, homologacaoHabilitada = false, provisionamentoHabilitado = false, dependencias, registrar = () => {}, mova = null, movaIdentidadeOperacional = null }) {
  const r = Router();
  // doc 37: importar SEM GUARDAR o arquivo — ele vive só na memória do processo (30 min) entre a prévia e a confirmação.
  const cofreTemporario = criarCofreTemporario();
  let deps = null;
  const obter = () => (deps ??= dependencias());

  r.use((req, res, next) => {
    const acao = req.method === "POST" && req.path.startsWith("/acoes/");
    const adm = req.path.startsWith("/administracao/");
    const corp = req.path.startsWith("/corporativo/");
    if (req.method !== "GET" && !acao && !((adm || corp) && req.method === "POST")) return res.status(405).json({ erro: "METODO_NAO_PERMITIDO", codigo: "METODO_NAO_PERMITIDO", mensagem: "Método não permitido." });
    if (!habilitado) return req.path === "/status" && req.method === "GET" ? res.json(DESLIGADO) : res.status(404).json({ erro: "FINANCEIRO_V2_DESLIGADO", codigo: "FINANCEIRO_V2_DESLIGADO", mensagem: "O Financeiro v2 não está ativo." });
    if (adm && !provisionamentoHabilitado) return res.status(404).json({ erro: "PROVISIONAMENTO_DESLIGADO", codigo: "PROVISIONAMENTO_DESLIGADO", mensagem: "O procedimento de ativação não está ligado." });
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
    const { adaptador, repositorio, relogio, entregadores } = obter();
    const c = await adaptador.contexto(sessao, opcoes);
    const nucleo = criarNucleoFinanceiro({
      repositorio, ...(relogio ? { relogio } : {}), exigirConcessaoPersistida: true, cofre: cofreTemporario, entregadores,
      escoposAutorizados: [{ organizacaoId: c.contexto.organizacaoId, unidadeId: c.contexto.unidadeId }],
    });
    return { c, nucleo };
  }

  /**
   * 27/11 (PR #236) — AUTORIZAÇÃO VINCULADA à operação entre empresas, montada só quando a operação a pede (proposta INTERCOMPANY):
   * contexto VERIFICADO da contraparte (mesma pessoa, acesso + liberação + concessão lá, 2º fator recente) e um núcleo com os DOIS
   * escopos. A gravação roda com o vínculo na identidade da requisição: a sessão de banco da contraparte sai pela autoridade
   * (emitirSessaoVinculada), presa à chave da operação, com ações restritas e auditoria no banco. A sessão da unidade ativa não muda.
   */
  function autorizacaoVinculada(sessao, token, c) {
    return async ({ organizacaoId, unidadeId, chave, propostaId }) => {
      const { adaptador, repositorio, relogio, entregadores } = obter();
      if (typeof adaptador.contextoDaContraparte !== "function") throw Object.assign(new Error("Sem autorização vinculada neste ambiente."), { codigo: CODIGO.PERMISSAO_INSUFICIENTE, detalhes: { motivo: "SEM_AUTORIZACAO_VINCULADA" } });
      const cC = await adaptador.contextoDaContraparte(sessao, { organizacaoId, unidadeId, tokenDeAcesso: token });
      const nucleo = criarNucleoFinanceiro({
        repositorio, ...(relogio ? { relogio } : {}), exigirConcessaoPersistida: true, cofre: cofreTemporario, entregadores,
        escoposAutorizados: [{ organizacaoId: c.contexto.organizacaoId, unidadeId: c.contexto.unidadeId }, { organizacaoId: cC.contexto.organizacaoId, unidadeId: cC.contexto.unidadeId }],
      });
      const identidade = identidadeDaRequisicao();
      const vinculo = Object.freeze({ organizacaoId: cC.contexto.organizacaoId, unidadeId: cC.contexto.unidadeId, chave: String(chave ?? ""), propostaId: propostaId ?? null });
      registrar({ tipo: "AUTORIZACAO_VINCULADA_PEDIDA", unidadeId: c.contexto.unidadeId, contraparte: cC.contexto.unidadeId, pessoa: c.contexto.usuarioId, proposta: propostaId ?? null });
      return { ctx: cC.contexto, nucleo, executar: (fn) => comIdentidadeDaRequisicao({ ...identidade, vinculo }, fn) };
    };
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
          escritaHabilitada: escritaHabilitada && c.escritaDaUnidade === true, homologacaoHabilitada, pessoasDemo: [],
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
  // doc 37: só o recebimento de arquivo para importação aceita corpo maior (arquivo em base64, até 5 MiB decodificado).
  const corpoDeArquivo = json({ limit: "8mb", strict: true });
  for (const [caminho, escrita] of Object.entries(ESCRITAS)) {
    r.post(`/acoes${caminho}`, ["/importacao/receber", "/entregadores/documento"].includes(caminho) ? corpoDeArquivo : corpoJson, async (req, res) => {
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
          // Liberação operacional INDIVIDUAL: a chave geral não basta; a unidade precisa estar com a escrita ligada.
          if (c.escritaDaUnidade !== true) throw recusa(403, "ESCRITA_DA_UNIDADE_DESLIGADA", "Esta unidade ainda não foi liberada para lançamentos. Peça ao administrador financeiro da empresa.");
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
  // ---------------------------------------------------------------- MOVA (Centro Financeiro) — só com o MOVA montado
  // `mova` é um getter assíncrono (fv2-integracao/mova.js); null/desligado ⇒ 404. Contexto SEMPRE da sessão (comIdentidade + preparar).
  const exigirMova = async () => {
    const m = mova ? await mova() : null;
    if (!m) throw recusa(404, "MOVA_DESLIGADO", "O MOVA não está ativo neste ambiente.");
    return m;
  };
  for (const [caminho, consulta] of Object.entries(CONSULTAS_MOVA)) {
    r.get(`/api${caminho}`, async (req, res) => {
      try {
        const m = await exigirMova();
        const corpo = await comIdentidade(req, async (sessao) => {
          const { c, nucleo } = await preparar(sessao);
          return consulta({ ctx: c.contexto, nucleo, nomes: { empresa: req.acesso?.empresa?.nome ?? null, unidade: req.acesso?.unidade?.nome ?? null }, mova: m.mova, worker: m.worker, enviador: m.enviador, chaves: m.chaves ?? null, controle: m.controle ?? null, orcamento: m.orcamento ?? null, params: req.query });
        });
        res.set("cache-control", "no-store");
        return res.json(corpo);
      } catch (e) { return responderErro(res, e, registrar); }
    });
  }
  for (const [caminho, acao] of Object.entries(ACOES_MOVA)) {
    r.post(`/acoes${caminho}`, corpoJson, async (req, res) => {
      try {
        if (!req.is("application/json")) throw recusa(415, "TIPO_DE_CONTEUDO", "Envie a ação como JSON.");
        const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
        if (Object.keys(b).some((k) => !acao.campos.includes(k))) throw recusa(400, "CAMPO_DESCONHECIDO", "A ação recebeu campos que não aceita.");
        const m = await exigirMova();
        const corpo = await comIdentidade(req, async (sessao, token) => {
          const { c, nucleo } = await preparar(sessao);
          if (acao.escreveNoFinanceiro && c.escritaDaUnidade !== true) throw recusa(403, "ESCRITA_DA_UNIDADE_DESLIGADA", "Esta unidade ainda não foi liberada para lançamentos.");
          const entreEmpresas = acao.entreEmpresas ? autorizacaoVinculada(sessao, token, c) : null;
          const resultado = await executarAcaoMova(acao, { ctx: c.contexto, mova: m.mova, nucleo, b, controle: m.controle ?? null, entreEmpresas });
          registrar({ tipo: "ACAO_MOVA", acao: caminho, unidadeId: c.contexto.unidadeId, pessoa: c.contexto.usuarioId });
          return resultado ?? { ok: true };
        });
        res.set("cache-control", "no-store");
        return res.json(corpo);
      } catch (e) { return responderErro(res, e, registrar); }
    });
  }

  // ---------------------------------------------------------------- ATIVAÇÃO (administrador inicial + liberação)
  // Só com FV2_PROVISIONAMENTO_HABILITADO=1 (ligar para ativar e desligar em seguida). Quem age é ADMINISTRADOR DA EMPRESA
  // (vínculo da plataforma), com 2º fator RECENTE; a pessoa beneficiada é escolhida por ele (nunca automaticamente), tem
  // conta pessoal e vínculo com a unidade, e nunca é da conta de quem atesta. A unidade é SEMPRE a da sessão.
  const ADMINISTRADOR_INICIAL = Object.freeze(Object.values(ACAO)); // as operações seguem bloqueadas pelas chaves
  async function exigirAdministradorDaEmpresa(sessao) {
    const s = identificarSessao(sessao, Date.now());
    const adm = await obter().administracao.autoridadeSobre({ contaId: s.contaId, organizacaoId: s.organizacaoId, unidadeId: s.unidadeId });
    if (!adm) throw Object.assign(new Error("Só o administrador da empresa ativa o Financeiro v2."), { codigo: CODIGO.PERMISSAO_INSUFICIENTE, detalhes: { motivo: "SEM_AUTORIDADE_ADMINISTRATIVA" } });
    return s;
  }
  const texto = (v, min, max) => (typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);

  r.get("/administracao/contexto", async (req, res) => {
    try {
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirAdministradorDaEmpresa(sessao);
        const { administracao, vinculos, liberacoes } = obter();
        const candidatos = [];
        for (const c of await administracao.pessoasDaUnidade({ unidadeId: s.unidadeId })) {
          if (c.contaId === s.contaId) continue; // quem atesta não se beneficia
          candidatos.push({ perfilId: c.perfilId, nome: c.nome ?? "Pessoa sem nome", contaPessoal: (await vinculos.perfisAtivosDaConta({ contaId: c.contaId })) === 1 });
        }
        return {
          organizacao: { id: s.organizacaoId, nome: req.acesso?.empresa?.nome ?? null }, unidade: { id: s.unidadeId, nome: req.acesso?.unidade?.nome ?? null },
          liberacao: await liberacoes.consultar({ organizacaoId: s.organizacaoId, unidadeId: s.unidadeId }), candidatos,
          modoDaAutoridade: obter().poolAutoridade ? "CO_LOCALIZADA" : "SERVICO",
        };
      });
      res.set("cache-control", "no-store");
      return res.json(corpo);
    } catch (e) {
      return responderErro(res, e, registrar);
    }
  });

  r.post("/administracao/provisionar", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      if (Object.keys(b).some((k) => !["perfilId", "justificativa", "evidencia"].includes(k))) throw recusa(400, "CAMPO_DESCONHECIDO", "Campos não aceitos.");
      const corpo = await comIdentidade(req, async (sessao, token) => {
        const s = await exigirAdministradorDaEmpresa(sessao);
        const { repositorio, administracao, vinculos, mfa } = obter();
        const nucleo = criarNucleoFinanceiro({
          repositorio, exigirConcessaoPersistida: true, escoposAutorizados: [{ organizacaoId: s.organizacaoId, unidadeId: s.unidadeId }],
          autoridadeDeProvisionamento: criarAutoridadeDaPlataforma({ administracao, vinculos, mfa }),
        });
        await nucleo.provisionarAdministradorInicial({
          organizacaoId: s.organizacaoId, unidadeId: s.unidadeId, usuarioId: String(b.perfilId ?? ""), acoes: [...ADMINISTRADOR_INICIAL],
          justificativa: b.justificativa, evidencia: b.evidencia, atestado: { sessao, tokenDeAcesso: token },
        });
        registrar({ tipo: "ADMINISTRADOR_INICIAL_PROVISIONADO", unidadeId: s.unidadeId, pessoa: String(b.perfilId), atestante: s.contaId });
        return { ok: true, concessao: { usuarioId: String(b.perfilId).toLowerCase(), acoes: [...ADMINISTRADOR_INICIAL] } };
      }, FINALIDADE_DO_GATEWAY.PROVISIONAMENTO);
      return res.json(corpo);
    } catch (e) {
      return responderErro(res, e, registrar);
    }
  });

  r.post("/administracao/liberacao", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      if (Object.keys(b).some((k) => !["ativa", "justificativa"].includes(k)) || typeof b.ativa !== "boolean") throw recusa(400, "CAMPO_DESCONHECIDO", "Informe só ativa (sim/não) e a justificativa.");
      const justificativa = texto(b.justificativa, 20, 500);
      if (!justificativa) throw recusa(400, "JUSTIFICATIVA_INSUFICIENTE", "Justificativa obrigatória (mínimo 20 caracteres).");
      const corpo = await comIdentidade(req, async (sessao, token) => {
        const s = await exigirAdministradorDaEmpresa(sessao);
        const { mfa, poolAutoridade, liberacoes } = obter();
        if (!poolAutoridade) throw recusa(501, "LIBERACAO_PELO_SERVICO_DA_AUTORIDADE", "Neste modo a liberação é feita pelo serviço da autoridade.");
        const prova = await mfa.provar({ tokenDeAcesso: token, contaId: s.contaId }).catch(() => ({ ok: false }));
        if (!prova?.ok) throw Object.assign(new Error("Liberar ou desligar exige o código do autenticador nos últimos 10 minutos."), { codigo: CODIGO.PERMISSAO_INSUFICIENTE, detalhes: { motivo: prova?.motivo ?? "SEM_PROVA_DE_SEGUNDO_FATOR" } });
        const ato = (unidadeId) => ({ organizacaoId: s.organizacaoId, unidadeId, ativa: b.ativa, atorContaId: s.contaId, justificativa, provaDeSegundoFator: prova });
        if (b.ativa && !(await liberacoes.consultar({ organizacaoId: s.organizacaoId, unidadeId: s.unidadeId })).empresa) await alterarLiberacaoPostgres(poolAutoridade, ato(null));
        await alterarLiberacaoPostgres(poolAutoridade, ato(s.unidadeId)); // SÓ a unidade da sessão (nunca "todas")
        registrar({ tipo: b.ativa ? "UNIDADE_LIBERADA" : "UNIDADE_DESLIGADA", unidadeId: s.unidadeId, ator: s.contaId });
        return { ok: true, liberacao: await liberacoes.consultar({ organizacaoId: s.organizacaoId, unidadeId: s.unidadeId }) };
      }, FINALIDADE_DO_GATEWAY.LIBERACAO);
      return res.json(corpo);
    } catch (e) {
      return responderErro(res, e, registrar);
    }
  });
  // PRIMEIRO administrador financeiro corporativo da empresa — uma vez por empresa, só com o procedimento de ativação ligado
  // (FV2_PROVISIONAMENTO_HABILITADO=1, decisão de infraestrutura do proprietário), por administrador da EMPRESA na plataforma,
  // com segundo fator recente comprovado. Depois disso, os demais administradores são definidos por quem já é administrador.
  r.post("/administracao/administrador-corporativo-inicial", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      if (Object.keys(b).some((k) => !["conta", "justificativa"].includes(k))) throw recusa(400, "CAMPO_DESCONHECIDO", "Campos não aceitos.");
      const justificativa = texto(b.justificativa, 20, 500);
      if (!justificativa) throw recusa(400, "JUSTIFICATIVA_INSUFICIENTE", "Justificativa obrigatória (mínimo 20 caracteres).");
      const corpo = await comIdentidade(req, async (sessao, token) => {
        const s = await exigirAdministradorDaEmpresa(sessao);
        const { mfa, corporativo, administracao, vinculos } = obter();
        if (!corporativo) throw recusa(501, "ADMINISTRACAO_PELO_SERVICO_DA_AUTORIDADE", "Neste modo a administração é feita pelo serviço da autoridade.");
        const prova = await mfa.provar({ tokenDeAcesso: token, contaId: s.contaId }).catch(() => ({ ok: false }));
        if (!prova?.ok) throw Object.assign(new Error("Esta ação exige o código do autenticador nos últimos 10 minutos."), { codigo: CODIGO.PERMISSAO_INSUFICIENTE, detalhes: { motivo: prova?.motivo ?? "SEM_PROVA_DE_SEGUNDO_FATOR" } });
        const conta = b.conta === undefined ? s.contaId : String(b.conta).toLowerCase();
        if (!(await administracao.administradoresDaEmpresa({ organizacaoId: s.organizacaoId })).includes(conta)) throw recusa(403, "NAO_E_ADMIN_DA_EMPRESA", "Só um administrador da empresa na plataforma pode ser o administrador financeiro.");
        if ((await vinculos.perfisAtivosDaConta({ contaId: conta })) !== 1) throw recusa(409, "CONTA_COMPARTILHADA", "Conta compartilhada não pode administrar o financeiro.");
        const r1 = await corporativo.definirAdministrador({ organizacaoId: s.organizacaoId, contaId: conta, ativo: true, atorContaId: s.contaId, justificativa, segundoFatorEm: prova.segundoFatorEm });
        registrar({ tipo: "ADMINISTRADOR_CORPORATIVO_INICIAL", conta, ator: s.contaId });
        return { ok: true, ...r1 };
      }, FINALIDADE_DO_GATEWAY.LIBERACAO);
      return res.json(corpo);
    } catch (e) {
      return responderErro(res, e, registrar);
    }
  });
  // ---------------------------------------------------------------- ADMINISTRAÇÃO CORPORATIVA (migração 0022)
  // Ativação simples: o ADMINISTRADOR FINANCEIRO CORPORATIVO (decidido no banco, por empresa) libera unidades em lote e
  // concede acessos, sem segundo atestante e sem código a cada ato. Exige, juntas: sessão autenticada, ser administrador da
  // empresa na plataforma E constar como administrador financeiro corporativo. A empresa é SEMPRE a da sessão.
  const NIVEIS = Object.freeze({ ...PERFIS_DE_ACESSO, NENHUM: [] });
  async function exigirCorporativo(sessao) {
    const s = identificarSessao(sessao, Date.now());
    const { administracao, corporativo } = obter();
    if (!corporativo) throw recusa(501, "ADMINISTRACAO_PELO_SERVICO_DA_AUTORIDADE", "Neste modo a administração é feita pelo serviço da autoridade.");
    if (!(await administracao.autoridadeSobre({ contaId: s.contaId, organizacaoId: s.organizacaoId }))) {
      throw Object.assign(new Error("Só o administrador da empresa acessa a ativação do Financeiro v2."), { codigo: CODIGO.PERMISSAO_INSUFICIENTE, detalhes: { motivo: "SEM_AUTORIDADE_ADMINISTRATIVA" } });
    }
    if (!(await corporativo.ehAdministrador({ organizacaoId: s.organizacaoId, contaId: s.contaId }))) {
      throw Object.assign(new Error("Você ainda não é administrador financeiro corporativo desta empresa."), { codigo: CODIGO.PERMISSAO_INSUFICIENTE, detalhes: { motivo: "NAO_E_ADMINISTRADOR_CORPORATIVO" } });
    }
    return s;
  }
  const justificativaDe = (b) => { const j = texto(b.justificativa, 20, 500); if (!j) throw recusa(400, "JUSTIFICATIVA_INSUFICIENTE", "Justificativa obrigatória (mínimo 20 caracteres)."); return j; };
  const semCamposAlemDe = (b, permitidos) => { if (Object.keys(b).some((k) => !permitidos.includes(k))) throw recusa(400, "CAMPO_DESCONHECIDO", "Campos não aceitos."); };
  const idMin = (v) => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null);

  r.get("/corporativo/contexto", async (req, res) => {
    try {
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirCorporativo(sessao);
        const { administracao, corporativo } = obter();
        const nomes = new Map((await administracao.unidadesDaEmpresa({ organizacaoId: s.organizacaoId })).map((u) => [u.unidadeId, u.nome]));
        const painel = await corporativo.painel({ organizacaoId: s.organizacaoId, atorContaId: s.contaId });
        return {
          organizacao: { id: s.organizacaoId, nome: req.acesso?.empresa?.nome ?? null },
          unidades: painel.map((u) => ({ id: u.unidadeId, nome: nomes.get(u.unidadeId) ?? u.rotulo, liberada: u.liberada, escrita: u.escrita })),
          administradores: (await corporativo.listarAdministradores({ organizacaoId: s.organizacaoId, atorContaId: s.contaId })).filter((a) => a.ativo).map((a) => ({ contaId: a.contaId, eu: a.contaId === s.contaId })),
          candidatosAAdministrador: (await administracao.administradoresDaEmpresa({ organizacaoId: s.organizacaoId })).filter((c) => c !== s.contaId),
          niveis: Object.keys(NIVEIS),
        };
      });
      res.set("cache-control", "no-store");
      return res.json(corpo);
    } catch (e) { return responderErro(res, e, registrar); }
  });

  r.get("/corporativo/pessoas", async (req, res) => {
    try {
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirCorporativo(sessao);
        const unidadeId = idMin(req.query.unidade);
        if (!unidadeId) throw recusa(400, "UNIDADE_INVALIDA", "Escolha uma unidade.");
        const { administracao, vinculos, corporativo } = obter();
        if (!(await administracao.unidadesDaEmpresa({ organizacaoId: s.organizacaoId })).some((u) => u.unidadeId === unidadeId)) throw recusa(403, "UNIDADE_FORA_DA_EMPRESA", "Unidade fora desta empresa.");
        const acessos = new Map((await corporativo.acessosDaUnidade({ organizacaoId: s.organizacaoId, unidadeId, atorContaId: s.contaId })).map((a) => [a.perfilId, a]));
        const pessoas = [];
        for (const p of await administracao.pessoasDaUnidade({ unidadeId })) {
          const a = acessos.get(p.perfilId);
          const nivel = !a?.ativa ? "NENHUM" : (Object.entries(NIVEIS).filter(([, acoes]) => acoes.length && acoes.every((x) => a.acoes.includes(x))).sort((x, y) => y[1].length - x[1].length)[0]?.[0] ?? "PERSONALIZADO");
          pessoas.push({ perfilId: p.perfilId, nome: p.nome ?? "Pessoa sem nome", contaPessoal: (await vinculos.perfisAtivosDaConta({ contaId: p.contaId })) === 1, nivel, euMesmo: p.perfilId === s.perfilId });
        }
        return { unidadeId, pessoas };
      });
      res.set("cache-control", "no-store");
      return res.json(corpo);
    } catch (e) { return responderErro(res, e, registrar); }
  });

  r.post("/corporativo/liberacao", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      semCamposAlemDe(b, ["unidades", "ativa", "escrita", "justificativa"]);
      if (!Array.isArray(b.unidades) || typeof b.ativa !== "boolean" || (b.escrita !== undefined && typeof b.escrita !== "boolean")) throw recusa(400, "ENTRADA_INVALIDA", "Informe as unidades e se liga ou desliga.");
      const justificativa = justificativaDe(b);
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirCorporativo(sessao);
        const { administracao, corporativo } = obter();
        const daEmpresa = new Set((await administracao.unidadesDaEmpresa({ organizacaoId: s.organizacaoId })).map((u) => u.unidadeId));
        const unidades = [...new Set(b.unidades.map(idMin))];
        if (!unidades.length || unidades.some((u) => !u || !daEmpresa.has(u))) throw recusa(403, "UNIDADE_FORA_DA_EMPRESA", "Alguma unidade não pertence a esta empresa.");
        const r1 = await corporativo.liberarEmLote({ organizacaoId: s.organizacaoId, unidades, ativa: b.ativa, escrita: b.escrita ?? b.ativa, atorContaId: s.contaId, justificativa });
        registrar({ tipo: b.ativa ? "UNIDADES_LIBERADAS_EM_LOTE" : "UNIDADES_DESLIGADAS_EM_LOTE", unidades: unidades.length, ator: s.contaId });
        return { ok: true, ...r1 };
      }, FINALIDADE_DO_GATEWAY.LIBERACAO);
      return res.json(corpo);
    } catch (e) { return responderErro(res, e, registrar); }
  });

  r.post("/corporativo/acessos", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      semCamposAlemDe(b, ["unidade", "perfil", "nivel", "justificativa"]);
      const unidadeId = idMin(b.unidade); const perfilId = idMin(b.perfil);
      if (!unidadeId || !perfilId || !Object.hasOwn(NIVEIS, b.nivel)) throw recusa(400, "ENTRADA_INVALIDA", "Informe unidade, pessoa e nível.");
      const justificativa = justificativaDe(b);
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirCorporativo(sessao);
        const { administracao, vinculos, corporativo } = obter();
        if (!(await administracao.unidadesDaEmpresa({ organizacaoId: s.organizacaoId })).some((u) => u.unidadeId === unidadeId)) throw recusa(403, "UNIDADE_FORA_DA_EMPRESA", "Unidade fora desta empresa.");
        // O beneficiário é uma PESSOA com vínculo ativo na unidade e conta pessoal (nunca conta compartilhada); não é quem age.
        const pessoa = (await administracao.pessoasDaUnidade({ unidadeId })).find((p) => p.perfilId === perfilId);
        if (!pessoa) throw recusa(403, "PESSOA_SEM_VINCULO", "A pessoa não tem vínculo ativo com a unidade.");
        if (b.nivel !== "NENHUM" && (await vinculos.perfisAtivosDaConta({ contaId: pessoa.contaId })) !== 1) throw recusa(409, "CONTA_COMPARTILHADA", "Conta compartilhada não opera o financeiro: use uma conta pessoal.");
        const r1 = await corporativo.conceder({ organizacaoId: s.organizacaoId, unidadeId, perfilId, acoes: NIVEIS[b.nivel], atorContaId: s.contaId, atorPerfilId: s.perfilId, justificativa });
        registrar({ tipo: "ACESSO_FINANCEIRO_ALTERADO", unidadeId, pessoa: perfilId, nivel: b.nivel, ator: s.contaId });
        return { ok: true, ...r1 };
      }, FINALIDADE_DO_GATEWAY.LIBERACAO);
      return res.json(corpo);
    } catch (e) { return responderErro(res, e, registrar); }
  });

  // 24/11 — IDENTIDADE OPERACIONAL do MOVA: o administrador financeiro CORPORATIVO, autenticado (mesma sessão e mesma função do
  // banco que concede às pessoas, com auditoria ADMINISTRACAO_CORPORATIVA), concede ou revoga, UMA unidade por vez, só as ações
  // ESTREITAS do MOVA. O beneficiário NÃO vem do formulário: é a identidade configurada no servidor (MOVA_IDENTIDADE_OPERACIONAL),
  // nunca a de leitura do MOVA, a técnica de entregadores ou quem age. Nenhuma ação ampla (registrar, corrigir, aplicar…).
  const IDENTIDADES_TECNICAS = ["00000000-0000-4000-8000-00000000a0a0", "00000000-0000-4000-8000-00000000e7e9", "00000000-0000-4000-8000-0000000b0075"];
  const ACOES_MOVA_OPERACIONAL = [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_OBRIGACAO];
  r.post("/corporativo/mova-operacional", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      semCamposAlemDe(b, ["unidade", "acao", "juros", "justificativa"]);
      const unidadeId = idMin(b.unidade);
      if (!unidadeId || !["CONCEDER", "REVOGAR"].includes(b.acao) || (b.juros !== undefined && typeof b.juros !== "boolean")) throw recusa(400, "ENTRADA_INVALIDA", "Informe a unidade e se concede ou revoga.");
      const identidade = idMin(movaIdentidadeOperacional);
      if (!identidade || IDENTIDADES_TECNICAS.includes(identidade)) throw recusa(409, "IDENTIDADE_OPERACIONAL_NAO_CONFIGURADA", "A identidade operacional do MOVA não está configurada neste servidor.");
      const justificativa = justificativaDe(b);
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirCorporativo(sessao);
        const { administracao, corporativo } = obter();
        if (!(await administracao.unidadesDaEmpresa({ organizacaoId: s.organizacaoId })).some((u) => u.unidadeId === unidadeId)) throw recusa(403, "UNIDADE_FORA_DA_EMPRESA", "Unidade fora desta empresa.");
        if ([s.contaId, s.perfilId].map(idMin).includes(identidade)) throw recusa(400, "AUTOCONCESSAO", "Ninguém concede o próprio acesso.");
        const acoes = b.acao === "REVOGAR" ? [] : [...ACOES_MOVA_OPERACIONAL, ...(b.juros === true ? [ACAO.REGISTRAR_JUROS] : [])];
        const r1 = await corporativo.conceder({ organizacaoId: s.organizacaoId, unidadeId, perfilId: identidade, acoes, atorContaId: s.contaId, atorPerfilId: s.perfilId, justificativa });
        registrar({ tipo: "MOVA_OPERACIONAL_ALTERADO", unidadeId, acao: b.acao, juros: b.juros === true, ator: s.contaId });
        return { ok: true, acoes, ...r1 };
      }, FINALIDADE_DO_GATEWAY.LIBERACAO);
      return res.json(corpo);
    } catch (e) { return responderErro(res, e, registrar); }
  });

  r.post("/corporativo/administradores", json({ limit: "8kb", strict: true }), async (req, res) => {
    try {
      const b = req.body ?? {};
      semCamposAlemDe(b, ["conta", "ativo", "justificativa"]);
      const conta = idMin(b.conta);
      if (!conta || typeof b.ativo !== "boolean") throw recusa(400, "ENTRADA_INVALIDA", "Informe a conta e se liga ou desliga.");
      const justificativa = justificativaDe(b);
      const corpo = await comIdentidade(req, async (sessao) => {
        const s = await exigirCorporativo(sessao);
        const { administracao, vinculos, corporativo } = obter();
        // O novo administrador já tem de ser administrador da empresa na plataforma e usar conta pessoal.
        if (b.ativo) {
          if (!(await administracao.administradoresDaEmpresa({ organizacaoId: s.organizacaoId })).includes(conta)) throw recusa(403, "NAO_E_ADMIN_DA_EMPRESA", "Só administradores da empresa na plataforma podem ser administradores financeiros.");
          if ((await vinculos.perfisAtivosDaConta({ contaId: conta })) !== 1) throw recusa(409, "CONTA_COMPARTILHADA", "Conta compartilhada não pode administrar o financeiro.");
        }
        const r1 = await corporativo.definirAdministrador({ organizacaoId: s.organizacaoId, contaId: conta, ativo: b.ativo, atorContaId: s.contaId, justificativa });
        registrar({ tipo: b.ativo ? "ADMINISTRADOR_CORPORATIVO_ADICIONADO" : "ADMINISTRADOR_CORPORATIVO_REMOVIDO", conta, ator: s.contaId });
        return { ok: true, ...r1 };
      }, FINALIDADE_DO_GATEWAY.LIBERACAO);
      return res.json(corpo);
    } catch (e) { return responderErro(res, e, registrar); }
  });
  return r;
}
