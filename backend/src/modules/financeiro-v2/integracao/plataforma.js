// INTEGRAÇÃO COM A PLATAFORMA (Execução 09) — adaptador de identidade e autoridade de provisionamento.
//
// Entrada: SOMENTE o que os middlewares da plataforma já verificaram no servidor (requireAuth + requireContexto),
// repassado como objeto { user, tenant, acesso } — o mesmo formato de `req.user`, `req.tenant` e `req.acesso`
// (contrato documentado em docs/financeiro-v2/22, § 2). Este arquivo NÃO lê HTTP, banco, ambiente nem o financeiro
// antigo: as leituras vêm por portas injetadas (liberações, vínculos, concessões, administração).
//
// Princípios (falha fechada em todos):
//   - organização e unidade vêm da sessão de contexto validada (assinada e relida no banco pela plataforma); nada do
//     corpo, da URL ou de cabeçalho do navegador é aceito como escopo;
//   - o ATOR do Financeiro v2 é a PESSOA operacional (perfil), não a conta de login; a conta fica registrada;
//   - conta com mais de uma pessoa operacional (conta compartilhada com PIN) NÃO opera o Financeiro v2 por padrão:
//     o login e o segundo fator provam a conta, não a pessoa;
//   - sessão válida na plataforma NÃO concede nada: permissões `financeiro_v2.*` vêm só de concessões explícitas;
//     papel, superadmin, módulos e permissões antigas não contam;
//   - impersonação NUNCA passa (ao contrário do bypass de suporte da plataforma); perfil de exibição também não;
//   - a liberação por empresa e unidade controla a DISPONIBILIDADE da interface, não substitui a concessão individual;
//   - operações sensíveis exigem segundo fator RECENTE comprovado pelo JWT (aal2 + carimbo do fator).
import { CODIGO, falhar } from "../dominio/erros.js";
import { ACAO, exigirContexto } from "../dominio/contexto.js";
import { ehUuid } from "../dominio/validacao.js";
import { MOTIVO_PROVA } from "./provaDeAutenticacao.js";

/** Motivos estáveis (vão em `detalhes.motivo`; a interface traduz). */
export const MOTIVO = Object.freeze({
  SEM_SESSAO: "SEM_SESSAO",
  SESSAO_EXPIRADA: "SESSAO_EXPIRADA",
  CONTA_INATIVA: "CONTA_INATIVA",
  SENHA_PROVISORIA: "SENHA_PROVISORIA",
  IMPERSONACAO: "IMPERSONACAO",
  PERFIL_DE_EXIBICAO: "PERFIL_DE_EXIBICAO",
  SEM_PERFIL: "SEM_PERFIL",
  SEM_UNIDADE: "SEM_UNIDADE",
  CONTEXTO_DIVERGENTE: "CONTEXTO_DIVERGENTE",
  CONTA_COMPARTILHADA: "CONTA_COMPARTILHADA",
  EMPRESA_NAO_LIBERADA: "EMPRESA_NAO_LIBERADA",
  UNIDADE_NAO_LIBERADA: "UNIDADE_NAO_LIBERADA",
  UNIDADE_NAO_AUTORIZADA: "UNIDADE_NAO_AUTORIZADA",
  SEM_CONCESSAO: "SEM_CONCESSAO",
  MFA_REQUERIDA: "MFA_REQUERIDA",
  REAUTENTICACAO_RECENTE: "REAUTENTICACAO_RECENTE",
  FALHA_FECHADA: "FALHA_FECHADA",
  // 09B
  PESSOA_SEM_IDENTIDADE: "PESSOA_SEM_IDENTIDADE",
  MFA_INDISPONIVEL: "MFA_INDISPONIVEL",
});

/** Papel do perfil de exibição (TV da loja) na plataforma: nunca enxerga o financeiro. */
export const PAPEL_DE_EXIBICAO = "display_operator";
export const JANELA_MFA_RECENTE_MS = 10 * 60 * 1000;
const TOLERANCIA_RELOGIO_MS = 60 * 1000;

/**
 * Ações que exigem segundo fator RECENTE (proposta da 09; decisão do responsável financeiro). Concessões, revogação,
 * homologação e reabertura mudam quem pode o quê ou o que vale como resultado oficial.
 */
export const ACOES_COM_MFA_RECENTE = Object.freeze([ACAO.CONCEDER, ACAO.REVOGAR, ACAO.HOMOLOGAR, ACAO.REABRIR]);

const recusar = (codigo, motivo, mensagem, extra = {}) => falhar(codigo, mensagem, { motivo, ...extra });
const minusc = (x) => String(x).toLowerCase();

/**
 * Nível de autenticação comprovado pela plataforma (lido do JWT já validado pelo provedor de identidade).
 * @param {{aal?: string|null, mfaEm?: number|null}} user
 * @returns {{aal: 'aal1'|'aal2'|null, mfaRecente: boolean, motivo: string|null}}
 */
export function avaliarAutenticacao(user, agoraMs, janelaMs = JANELA_MFA_RECENTE_MS) {
  const aal = user?.aal === "aal2" || user?.aal === "aal1" ? user.aal : null;
  if (aal !== "aal2") return { aal, mfaRecente: false, motivo: MOTIVO.MFA_REQUERIDA };
  const t = user?.mfaEm;
  if (!Number.isFinite(t) || t > agoraMs + TOLERANCIA_RELOGIO_MS || agoraMs - t > janelaMs) return { aal, mfaRecente: false, motivo: MOTIVO.REAUTENTICACAO_RECENTE };
  return { aal, mfaRecente: true, motivo: null };
}

/**
 * Confere a FORMA e a COERÊNCIA da sessão da plataforma (sem leitura externa). Lança com motivo estável.
 * @returns {{contaId:string, perfilId:string, organizacaoId:string, unidadeId:string, sessaoId:string, expiraEm:string|null}}
 */
export function identificarSessao(sessao, agoraMs) {
  if (!sessao || typeof sessao !== "object") recusar(CODIGO.SESSAO_AUSENTE, MOTIVO.SEM_SESSAO, "Sessão da plataforma ausente.");
  const { user, tenant, acesso } = sessao;
  if (!user || !ehUuid(user.id) || !tenant || !ehUuid(tenant.organizacaoId) || !acesso || typeof acesso.sessionId !== "string" || !acesso.sessionId) {
    recusar(CODIGO.SESSAO_INVALIDA, MOTIVO.SEM_SESSAO, "Sessão da plataforma incompleta: entre e escolha a unidade novamente.");
  }
  if (user.ativo === false) recusar(CODIGO.SESSAO_INVALIDA, MOTIVO.CONTA_INATIVA, "Conta inativa.");
  if (user.senhaProvisoria === true) recusar(CODIGO.SESSAO_INVALIDA, MOTIVO.SENHA_PROVISORIA, "Defina a senha definitiva antes de usar o financeiro.");
  // A sessão de contexto da plataforma tem validade própria (8 h; 1 h na impersonação). Sem validade = recusada.
  const vence = Date.parse(acesso.expiraEm ?? "");
  if (!Number.isFinite(vence) || vence <= agoraMs) recusar(CODIGO.SESSAO_INVALIDA, MOTIVO.SESSAO_EXPIRADA, "Sessão expirada: escolha a unidade novamente.");
  if (acesso.impersonando === true || acesso.impersonadoPor) {
    recusar(CODIGO.PERMISSAO_INSUFICIENTE, MOTIVO.IMPERSONACAO, "Sessões de suporte (impersonação) não acessam o Financeiro v2.");
  }
  if (acesso.papel === PAPEL_DE_EXIBICAO) recusar(CODIGO.PERMISSAO_INSUFICIENTE, MOTIVO.PERFIL_DE_EXIBICAO, "O perfil de exibição não acessa o financeiro.");
  if (!ehUuid(acesso.perfilId)) recusar(CODIGO.SESSAO_INVALIDA, MOTIVO.SEM_PERFIL, "A sessão não identifica a pessoa operacional.");
  if (!ehUuid(tenant.unidadeId)) recusar(CODIGO.ESCOPO_NAO_AUTORIZADO, MOTIVO.SEM_UNIDADE, "O Financeiro v2 opera por unidade: escolha uma unidade (não \"todas\").");
  // Coerência entre as três peças que a plataforma montou da MESMA linha de sessão.
  const org = minusc(tenant.organizacaoId);
  const uni = minusc(tenant.unidadeId);
  if ((acesso.empresa?.id && minusc(acesso.empresa.id) !== org) || (acesso.unidade?.id && minusc(acesso.unidade.id) !== uni)) {
    recusar(CODIGO.SESSAO_INVALIDA, MOTIVO.CONTEXTO_DIVERGENTE, "Contexto divergente: escolha a unidade novamente.");
  }
  return { contaId: minusc(user.id), perfilId: minusc(acesso.perfilId), organizacaoId: org, unidadeId: uni, sessaoId: acesso.sessionId, expiraEm: acesso.expiraEm };
}

async function lerComFalhaFechada(leitura) {
  try {
    return await leitura();
  } catch {
    return recusar(CODIGO.CONTEXTO_INVALIDO, MOTIVO.FALHA_FECHADA, "Não foi possível confirmar o acesso: nada é liberado sem confirmação.");
  }
}

/**
 * Adaptador da sessão da plataforma → contexto do Financeiro v2.
 * @param {object} portas
 * @param {{consultar:({organizacaoId, unidadeId})=>Promise<{empresa:boolean, unidade:boolean}>}} portas.liberacoes
 *        liberação do Financeiro v2 por empresa e unidade (controla a interface; não concede nada)
 * @param {{unidadesDoPerfil:({perfilId, organizacaoId})=>Promise<string[]>, perfisAtivosDaConta:({contaId})=>Promise<number>}} portas.vinculos
 *        vínculos da PLATAFORMA (lidos no servidor): unidades a que a pessoa tem acesso e quantas pessoas a conta tem
 * @param {{listar:({organizacaoId, usuarioId})=>Promise<Array<{unidadeId:string, acoes:string[]}>>}} portas.concessoes
 *        concessões EXPLÍCITAS do Financeiro v2 (por pessoa operacional)
 * @param {() => Date} [portas.relogio]
 * @param {boolean} [portas.permitirContaCompartilhada] padrão false (decisão pendente do responsável)
 * @param {{provar:({tokenDeAcesso, contaId})=>Promise<{ok:boolean, motivo?:string}>}|null} [portas.mfa] 09B: verificador da
 *        prova de segundo fator (provaDeAutenticacao.js). Sem ele, as ações de ACOES_COM_MFA_RECENTE ficam BLOQUEADAS.
 */
export function criarAdaptadorDaPlataforma({ liberacoes, vinculos, concessoes, mfa = null, relogio = () => new Date(), permitirContaCompartilhada = false }) {
  if (typeof liberacoes?.consultar !== "function" || typeof vinculos?.unidadesDoPerfil !== "function" || typeof vinculos?.perfisAtivosDaConta !== "function" || typeof vinculos?.contaDoPerfil !== "function" || typeof concessoes?.listar !== "function") {
    falhar(CODIGO.CONTEXTO_INVALIDO, "O adaptador da plataforma exige as portas de liberação, vínculos e concessões.");
  }
  const agora = () => relogio().getTime();
  const liberada = async (organizacaoId, unidadeId) => {
    const l = await lerComFalhaFechada(() => liberacoes.consultar({ organizacaoId, unidadeId }));
    return { empresa: l?.empresa === true, unidade: l?.empresa === true && l?.unidade === true };
  };
  const unidadesDaPessoa = async (s) => new Set(((await lerComFalhaFechada(() => vinculos.unidadesDoPerfil({ perfilId: s.perfilId, organizacaoId: s.organizacaoId }))) ?? []).filter(ehUuid).map(minusc));
  const concedidas = async (s) => ((await lerComFalhaFechada(() => concessoes.listar({ organizacaoId: s.organizacaoId, usuarioId: s.perfilId }))) ?? [])
    .filter((c) => ehUuid(c?.unidadeId) && Array.isArray(c.acoes))
    .map((c) => ({ unidadeId: minusc(c.unidadeId), acoes: [...new Set(c.acoes.filter((a) => Object.values(ACAO).includes(a)))] }))
    .filter((c) => c.acoes.length);

  /** Identidade + liberação + pessoa (sem concessão): o que decide se a INTERFACE do v2 aparece. */
  async function verificarBase(sessao) {
    const s = identificarSessao(sessao, agora());
    const l = await liberada(s.organizacaoId, s.unidadeId);
    if (!l.empresa) recusar(CODIGO.ESCOPO_NAO_AUTORIZADO, MOTIVO.EMPRESA_NAO_LIBERADA, "O Financeiro v2 não está liberado para esta empresa.");
    if (!l.unidade) recusar(CODIGO.ESCOPO_NAO_AUTORIZADO, MOTIVO.UNIDADE_NAO_LIBERADA, "O Financeiro v2 não está liberado para esta unidade.");
    if (!permitirContaCompartilhada) {
      const n = await lerComFalhaFechada(() => vinculos.perfisAtivosDaConta({ contaId: s.contaId }));
      if (!Number.isInteger(n) || n !== 1) recusar(CODIGO.PERMISSAO_INSUFICIENTE, MOTIVO.CONTA_COMPARTILHADA, "Conta compartilhada por várias pessoas não opera o financeiro: use uma conta pessoal.");
    }
    // 09B: a PESSOA operacional precisa estar ativa e pertencer à conta que autenticou (a plataforma relê o perfil da
    // sessão; aqui se confere de novo, pela porta, para nenhuma pessoa de outra conta agir com este login).
    const contaDaPessoa = await lerComFalhaFechada(() => vinculos.contaDoPerfil({ perfilId: s.perfilId }));
    if (!ehUuid(contaDaPessoa) || minusc(contaDaPessoa) !== s.contaId) recusar(CODIGO.PERMISSAO_INSUFICIENTE, MOTIVO.PESSOA_SEM_IDENTIDADE, "A pessoa operacional não está ativa ou não pertence a esta conta.");
    const unidades = await unidadesDaPessoa(s);
    if (!unidades.has(s.unidadeId)) recusar(CODIGO.ESCOPO_NAO_AUTORIZADO, MOTIVO.UNIDADE_NAO_AUTORIZADA, "Sem acesso a esta unidade na plataforma.");
    return { s, unidades };
  }

  /**
   * Contexto do Financeiro v2 para a unidade ATIVA da sessão. Chamar a CADA operação (nada fica em cache): revogação
   * na plataforma ou no v2, troca de unidade e expiração valem na operação seguinte.
   * @param {object} sessao { user, tenant, acesso } da plataforma
   * @param {{acao?: string, tokenDeAcesso?: string}} [opcoes] ação pretendida; as de ACOES_COM_MFA_RECENTE exigem a
   *        prova de segundo fator RECENTE derivada do token de acesso (verificado pela porta `mfa`, nunca do cliente)
   */
  async function contexto(sessao, { acao = null, tokenDeAcesso = null } = {}) {
      const { s, unidades } = await verificarBase(sessao);
      const concessao = (await concedidas(s)).find((c) => c.unidadeId === s.unidadeId);
      if (!concessao) recusar(CODIGO.PERMISSAO_INSUFICIENTE, MOTIVO.SEM_CONCESSAO, "Sem concessão do Financeiro v2 nesta unidade.");
      // Informativo (o que a plataforma declarou); NÃO autoriza nada. A autorização usa a prova verificada abaixo.
      const autenticacao = avaliarAutenticacao(sessao.user, agora());
      let prova = null;
      if (acao && ACOES_COM_MFA_RECENTE.includes(acao)) {
        if (!mfa || typeof mfa.provar !== "function") recusar(CODIGO.PERMISSAO_INSUFICIENTE, MOTIVO.MFA_INDISPONIVEL, "A verificação em duas etapas ainda não está disponível neste ambiente: a ação fica bloqueada.", { acao });
        try { prova = await mfa.provar({ tokenDeAcesso, contaId: s.contaId }); } catch { prova = { ok: false, motivo: MOTIVO_PROVA.ASSINATURA_INVALIDA }; }
        if (!prova?.ok) {
          recusar(CODIGO.PERMISSAO_INSUFICIENTE, prova?.motivo ?? MOTIVO_PROVA.ASSINATURA_INVALIDA, prova?.motivo === MOTIVO_PROVA.ANTIGA
            ? "Esta ação exige confirmar o segundo fator de novo (últimos 10 minutos)." : "Esta ação exige verificação em duas etapas comprovada.", { acao });
        }
      }
      return Object.freeze({
        contexto: exigirContexto({ organizacaoId: s.organizacaoId, unidadeId: s.unidadeId, usuarioId: s.perfilId, permissoes: concessao.acoes }),
        ator: Object.freeze({ perfilId: s.perfilId, contaId: s.contaId }),
        unidadesDaPessoa: Object.freeze([...unidades].sort()),
        autenticacao: Object.freeze({ ...autenticacao, provaVerificada: Boolean(prova?.ok), segundoFatorEm: prova?.segundoFatorEm ?? null }),
        origem: Object.freeze({ tipo: "PLATAFORMA", sessaoId: s.sessaoId, expiraEm: s.expiraEm }),
      });
  }

  return Object.freeze({
    contexto,

    /**
     * Unidades em que a pessoa pode operar o v2: acesso na plataforma ∩ liberadas ∩ com concessão. Para o seletor.
     * Não muda a unidade ativa (a troca é sempre pela plataforma, que revoga a sessão anterior).
     */
    async unidadesOperaveis(sessao) {
      const { s, unidades } = await verificarBase(sessao);
      const saida = [];
      for (const c of await concedidas(s)) {
        if (!unidades.has(c.unidadeId)) continue;
        if ((await liberada(s.organizacaoId, c.unidadeId)).unidade) saida.push({ unidadeId: c.unidadeId, acoes: c.acoes });
      }
      return saida.sort((a, b) => a.unidadeId.localeCompare(b.unidadeId));
    },

    /**
     * Estado da INTERFACE (nunca lança): o que o menu deve mostrar. `disponivel` = liberada e com pessoa válida;
     * `operavel` = além disso, há concessão nesta unidade. Sem disponibilidade, a plataforma segue com o financeiro atual.
     */
    async disponibilidade(sessao) {
      // 1) A LIBERAÇÃO decide se o v2 substitui o financeiro desta unidade; é avaliada antes de tudo e informada à parte,
      //    para que uma sessão recusada pelo v2 (impersonação, conta compartilhada...) numa unidade NÃO liberada siga
      //    com o financeiro atual, e numa unidade liberada veja "sem acesso" (nunca os dois financeiros).
      const org = sessao?.tenant?.organizacaoId;
      const uni = sessao?.tenant?.unidadeId;
      let liberado = false;
      if (ehUuid(org) && ehUuid(uni)) {
        try { liberado = (await liberada(minusc(org), minusc(uni))).unidade; } catch { return { liberado: false, disponivel: false, operavel: false, motivo: MOTIVO.FALHA_FECHADA }; }
      }
      if (!liberado) return { liberado: false, disponivel: false, operavel: false, motivo: MOTIVO.UNIDADE_NAO_LIBERADA };
      try {
        await verificarBase(sessao);
      } catch (e) {
        return { liberado: true, disponivel: false, operavel: false, motivo: e?.detalhes?.motivo ?? MOTIVO.FALHA_FECHADA };
      }
      try {
        await contexto(sessao);
        return { liberado: true, disponivel: true, operavel: true, motivo: null };
      } catch (e) {
        return { liberado: true, disponivel: true, operavel: false, motivo: e?.detalhes?.motivo ?? MOTIVO.FALHA_FECHADA };
      }
    },
  });
}

/**
 * AUTORIDADE DE PROVISIONAMENTO apoiada na plataforma (porta `autoridade` de operacoesDeAcesso). Atesta o ADMINISTRADOR
 * FINANCEIRO INICIAL de uma unidade. O atestante:
 *   - está autenticado na plataforma (sessão verificada no servidor, repassada em `ato.atestado.sessao`);
 *   - tem autoridade administrativa COMPROVADA sobre a empresa/unidade (porta `administracao`);
 *   - comprovou o segundo fator nos últimos 10 minutos;
 *   - não provisiona a si mesmo (nem outra pessoa da própria conta) e NÃO recebe acesso financeiro algum;
 *   - indica uma pessoa operacional que já tem acesso à unidade na plataforma e usa conta pessoal.
 * Ser superadmin NÃO dá acesso a dados financeiros; no máximo permite ATESTAR (se o tipo for aceito).
 * @param {object} portas
 * @param {{autoridadeSobre:({contaId, organizacaoId, unidadeId})=>Promise<{tipo:string}|null>, contaDoPerfil:({perfilId})=>Promise<string|null>}} portas.administracao
 * @param {{unidadesDoPerfil:Function, perfisAtivosDaConta:Function}} portas.vinculos
 * @param {string[]} [portas.tiposAceitos] tipos de autoridade da plataforma aceitos como atestantes
 */
export function criarAutoridadeDaPlataforma({ administracao, vinculos, mfa = null, relogio = () => new Date(), tiposAceitos = ["ADMIN_EMPRESA"] }) {
  if (typeof administracao?.autoridadeSobre !== "function" || typeof administracao?.contaDoPerfil !== "function" || typeof vinculos?.unidadesDoPerfil !== "function") {
    falhar(CODIGO.CONTEXTO_INVALIDO, "A autoridade da plataforma exige as portas de administração e vínculos.");
  }
  const nao = (motivo) => ({ ok: false, motivo });
  return Object.freeze({
    async verificar(ato) {
      try {
        const sessao = ato?.atestado?.sessao;
        const user = sessao?.user;
        if (!user || !ehUuid(user.id) || user.ativo === false || user.senhaProvisoria === true) return nao("ATESTANTE_NAO_AUTENTICADO");
        if (sessao.acesso?.impersonando === true || sessao.acesso?.impersonadoPor) return nao("ATESTANTE_EM_IMPERSONACAO");
        // 09B: a prova vem do TOKEN do atestante, verificado pela porta `mfa` (sem ela, nada é atestado).
        if (!mfa || typeof mfa.provar !== "function") return nao(MOTIVO.MFA_INDISPONIVEL);
        const prova = await mfa.provar({ tokenDeAcesso: ato.atestado.tokenDeAcesso, contaId: minusc(user.id) });
        if (!prova?.ok) return nao(prova?.motivo ?? MOTIVO_PROVA.ASSINATURA_INVALIDA);
        if (typeof ato.justificativa !== "string" || ato.justificativa.trim().length < 20) return nao("JUSTIFICATIVA_INSUFICIENTE");
        const contaAtestante = minusc(user.id);
        const autoridade = await administracao.autoridadeSobre({ contaId: contaAtestante, organizacaoId: ato.organizacaoId, unidadeId: ato.unidadeId });
        if (!autoridade || !tiposAceitos.includes(autoridade.tipo)) return nao("SEM_AUTORIDADE_ADMINISTRATIVA");
        const contaDoAlvo = await administracao.contaDoPerfil({ perfilId: ato.usuarioId });
        if (!ehUuid(contaDoAlvo)) return nao("PESSOA_INEXISTENTE");
        if (minusc(contaDoAlvo) === contaAtestante) return nao("AUTOCONCESSAO");
        if ((await vinculos.perfisAtivosDaConta({ contaId: minusc(contaDoAlvo) })) !== 1) return nao("CONTA_COMPARTILHADA");
        const unidades = ((await vinculos.unidadesDoPerfil({ perfilId: ato.usuarioId, organizacaoId: ato.organizacaoId })) ?? []).map(minusc);
        if (!unidades.includes(minusc(ato.unidadeId))) return nao("PESSOA_SEM_ACESSO_A_UNIDADE");
        return { ok: true, autoridadeId: contaAtestante, nivelAutenticacao: "aal2", tipo: autoridade.tipo };
      } catch {
        return nao("FALHA_FECHADA");
      }
    },
  });
}
