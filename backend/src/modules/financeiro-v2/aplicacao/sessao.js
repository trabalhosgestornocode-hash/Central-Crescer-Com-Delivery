// ADAPTADOR DE SESSÃO: único caminho do contexto autenticado do aplicativo até o contexto do Financeiro v2.
//
// Entrada: o que o middleware de autenticação atual JÁ resolveu no servidor (req.user, req.tenant, req.acesso) —
// passado como um objeto { user, tenant, acesso }. Este arquivo não lê HTTP, banco nem ambiente.
// Regras (falha fechada):
//   - organização vem SOMENTE da sessão validada; o cliente nunca a informa;
//   - a unidade pedida precisa estar entre as unidades CONCEDIDAS ao usuário para o Financeiro v2 e, se a sessão já
//     estiver presa a uma unidade, ser essa mesma;
//   - permissões `financeiro_v2.*` vêm SOMENTE de concessões explícitas (porta `concessoes`). Papel, superadmin,
//     permissões do sistema atual e módulos NÃO concedem nada — nenhum usuário existente ganha acesso automático;
//   - sessão ausente, inválida, expirada, de conta inativa ou em impersonação (por padrão) é recusada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ACAO, exigirContexto } from "../dominio/contexto.js";
import { ehUuid } from "../dominio/validacao.js";

const ACOES = Object.freeze(Object.values(ACAO));

/**
 * @param {object} deps
 * @param {{listar: ({organizacaoId, usuarioId}) => Promise<Array<{unidadeId:string, acoes:string[]}>>}} deps.concessoes
 * @param {() => Date} [deps.relogio]
 * @param {boolean} [deps.permitirImpersonacao] padrão false: quem está impersonando não acessa o Financeiro v2
 */
export function criarAdaptadorDeSessao({ concessoes, relogio = () => new Date(), permitirImpersonacao = false }) {
  if (typeof concessoes?.listar !== "function") falhar(CODIGO.CONTEXTO_INVALIDO, "O adaptador de sessão exige a porta de concessões.");

  function validarSessao(sessao) {
    if (!sessao || typeof sessao !== "object" || !sessao.user) falhar(CODIGO.SESSAO_AUSENTE, "Sessão ausente.");
    const { user, tenant, acesso } = sessao;
    if (!ehUuid(user.id) || !ehUuid(tenant?.organizacaoId) || typeof acesso?.sessionId !== "string" || !acesso.sessionId) {
      falhar(CODIGO.SESSAO_INVALIDA, "Sessão inválida.");
    }
    if (user.ativo === false) falhar(CODIGO.SESSAO_INVALIDA, "Conta inativa.");
    if (acesso.expiraEm !== null && acesso.expiraEm !== undefined) {
      const vence = Date.parse(acesso.expiraEm);
      if (Number.isNaN(vence) || vence <= relogio().getTime()) falhar(CODIGO.SESSAO_INVALIDA, "Sessão expirada.");
    }
    if ((acesso.impersonando || acesso.impersonadoPor) && !permitirImpersonacao) {
      falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Sessões em impersonação não acessam o Financeiro v2.");
    }
    if (tenant.unidadeId !== null && tenant.unidadeId !== undefined && !ehUuid(tenant.unidadeId)) falhar(CODIGO.SESSAO_INVALIDA, "Unidade da sessão inválida.");
    return { usuarioId: user.id.toLowerCase(), organizacaoId: tenant.organizacaoId.toLowerCase(), unidadeDaSessao: tenant.unidadeId ? tenant.unidadeId.toLowerCase() : null };
  }

  async function concedidas(s) {
    const lista = await concessoes.listar({ organizacaoId: s.organizacaoId, usuarioId: s.usuarioId });
    return (Array.isArray(lista) ? lista : [])
      .filter((c) => ehUuid(c?.unidadeId) && Array.isArray(c.acoes))
      .map((c) => ({ unidadeId: c.unidadeId.toLowerCase(), acoes: [...new Set(c.acoes.filter((a) => ACOES.includes(a)))] }))
      .filter((c) => c.acoes.length && (!s.unidadeDaSessao || c.unidadeId === s.unidadeDaSessao));
  }

  return Object.freeze({
    /** Contexto do Financeiro v2 para UMA unidade (a pedida, ou a da sessão). */
    async contextoPara(sessao, { unidadeId } = {}) {
      const s = validarSessao(sessao);
      const alvo = unidadeId ?? s.unidadeDaSessao;
      if (!ehUuid(alvo)) falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "Unidade não informada.");
      const unidade = alvo.toLowerCase();
      if (s.unidadeDaSessao && unidade !== s.unidadeDaSessao) falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "A sessão está vinculada a outra unidade.");
      const concessao = (await concedidas(s)).find((c) => c.unidadeId === unidade);
      if (!concessao) falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "Sem concessão do Financeiro v2 para esta unidade.");
      return exigirContexto({ organizacaoId: s.organizacaoId, unidadeId: unidade, usuarioId: s.usuarioId, permissoes: concessao.acoes });
    },

    /** Unidades em que a sessão pode operar o Financeiro v2 (para montar seletor de unidade). */
    async unidadesAutorizadas(sessao) {
      return (await concedidas(validarSessao(sessao))).map((c) => ({ unidadeId: c.unidadeId, acoes: c.acoes }));
    },
  });
}

/**
 * Concessões EM MEMÓRIA (testes e desenvolvimento local). A tabela real de concessões ainda não existe: criá-la e
 * decidir quem concede é pendência da integração (docs/financeiro-v2/05, seção Sessão).
 * @param {Array<{organizacaoId:string, usuarioId:string, unidadeId:string, acoes:string[]}>} lista
 */
export function criarConcessoesMemoria(lista = []) {
  const copia = lista.map((c) => ({ ...c, organizacaoId: c.organizacaoId.toLowerCase(), usuarioId: c.usuarioId.toLowerCase(), acoes: [...c.acoes] }));
  return Object.freeze({
    async listar({ organizacaoId, usuarioId }) {
      return copia.filter((c) => c.organizacaoId === organizacaoId && c.usuarioId === usuarioId).map((c) => ({ unidadeId: c.unidadeId, acoes: [...c.acoes] }));
    },
  });
}

/**
 * Concessões PERSISTIDAS (registros CONCESSAO gravados por aplicacao/acessos.js), lidas escopo a escopo pela porta de
 * persistência — no PostgreSQL, cada leitura passa pelo RLS do próprio escopo. Só os escopos configurados da organização
 * da sessão são consultados; nada vem do cliente.
 * @param {{repositorio:{leitura:Function}, escopos:Array<{organizacaoId:string, unidadeId:string}>}} deps
 */
export function criarConcessoesDoRepositorio({ repositorio, escopos }) {
  const lista = escopos.map((e) => ({ organizacaoId: e.organizacaoId.toLowerCase(), unidadeId: e.unidadeId.toLowerCase() }));
  return Object.freeze({
    async listar({ organizacaoId, usuarioId }) {
      const saida = [];
      for (const escopo of lista.filter((e) => e.organizacaoId === organizacaoId)) {
        const c = await repositorio.leitura((tx) => tx.buscarPorChave(escopo, "CONCESSAO", `concessao:${usuarioId}`), { escopo });
        if (c && c.situacao === "ATIVA" && c.usuarioId === usuarioId) saida.push({ unidadeId: escopo.unidadeId, acoes: [...c.acoes] });
      }
      return saida;
    },
  });
}
