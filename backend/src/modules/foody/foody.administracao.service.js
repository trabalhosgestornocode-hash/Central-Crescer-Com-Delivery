// ADMINISTRAÇÃO da integração Foody pela tela (migration 146): estado, cadastro seguro da conexão, ativar/pausar/revogar e o
// compartilhamento entre organizações (proposta restrita às organizações em que o próprio administrador tem vínculo).
//
// O QUE ESTE SERVIÇO NUNCA FAZ:
//   * coletar pedidos: não importa cliente HTTP, sync nem agendador (há teste de arquitetura). "Ativar" a conexão só a deixa
//     pronta — a coleta depende das flags de SINCRONIZAÇÃO (FOODY_CENTRAL_ENABLED + allowlist + agendador), que são outra decisão;
//   * devolver o token: ele só entra (corpo do POST), é cifrado aqui com a chave da unidade e vai ao banco cifrado; para a tela sai
//     no máximo o final da IMPRESSÃO (hash), nunca o token nem o cifrado;
//   * confiar no papel da sessão sozinho: a sessão congela o papel por até 8 h, então o banco confere de novo (usuarios_organizacoes)
//     em toda escrita — conexão (146), vínculo e triagem (145);
//   * agir em impersonação: o superadmin pode CONSULTAR o estado (suporte), mas não cadastra, aprova, revoga nem decide.
import { administracaoPermitida, unidadePermitida, agendamentoPermitido, compartilhamentoPermitido } from "./foody.flags.js";
import { impressaoToken, FoodyConfigErro } from "./foody.seguranca.js";
import { ehAdminDaOrganizacao, proporDestino, OPERACOES_DESTINO } from "./foody.compartilhamento.service.js";
import { OPERACAO_COMPARTILHADA } from "./foody.classificacao.js";

export class FoodyAdminErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodyAdminErro"; this.codigo = codigo; }
}
const erro = (c, m) => new FoodyAdminErro(c, m);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ROTULO_OPERACAO = Object.freeze({ [OPERACAO_COMPARTILHADA.SUBWAY]: "Subway", [OPERACAO_COMPARTILHADA.ACAI_NO_GRAU]: "Açaí no Grau" });

function exigirAdministracao(env) {
  if (!administracaoPermitida(env)) throw erro("DESLIGADO", "administração da integração Foody desligada.");
}
function exigirAdminDaUnidade(ator, tenant) {
  if (!ehAdminDaOrganizacao(ator, tenant?.organizacaoId)) {
    throw erro("SEM_PERMISSAO", "só um Administrador da empresa (sem impersonação) administra a integração.");
  }
  if (!UUID.test(String(tenant?.unidadeId ?? ""))) throw erro("SEM_UNIDADE", "selecione a unidade dona da conta Foody.");
}

/** Token: 8 a 512 caracteres visíveis, sem espaço nem controle. Nunca ecoado em erro. */
export function validarToken(token) {
  const t = String(token ?? "").trim();
  if (t.length < 8 || t.length > 512 || /[\s\u0000-\u001f\u007f]/.test(t)) throw erro("TOKEN_INVALIDO", "token inválido: confira e cole de novo.");
  return t;
}
function motivo(m, { obrigatorio = false } = {}) {
  const s = String(m ?? "").trim();
  if (!s && !obrigatorio) return null;
  if (s.length < 3 || s.length > 300) throw erro("MOTIVO_INVALIDO", "motivo obrigatório (3 a 300 caracteres).");
  return s;
}
function pontoColeta(p) {
  const s = String(p ?? "").trim();
  if (s.length > 120) throw erro("PONTO_COLETA_INVALIDO", "ponto de coleta com até 120 caracteres.");
  return s || null;
}

function cifrar(token, unidadeId, seguranca) {
  let seg;
  try { seg = typeof seguranca === "function" ? seguranca() : seguranca; } catch (e) {
    if (e instanceof FoodyConfigErro) throw erro("SEGREDO_AUSENTE", "a chave de proteção dos tokens Foody não está configurada neste ambiente.");
    throw e;
  }
  if (!seg?.cifrarToken) throw erro("SEGREDO_AUSENTE", "a chave de proteção dos tokens Foody não está configurada neste ambiente.");
  return { tokenCifrado: seg.cifrarToken(token, unidadeId), tokenImpressao: impressaoToken(token) };
}

const finalImpressao = (imp) => (imp ? String(imp).slice(-4) : null);
const quem = (perfilId, ator) => (!perfilId ? "automatico" : perfilId === ator?.perfilId ? "voce" : "outro");

function conexaoParaTela(c) {
  if (!c) return null;
  return {
    id: c.id, status: c.status, impressaoFinal: finalImpressao(c.token_impressao), pontoColetaEsperado: c.ponto_coleta_esperado ?? null,
    ultimaSyncEm: c.ultima_sync_em ?? null, ultimoErroCodigo: c.ultimo_erro_codigo ?? null, criadoEm: c.criado_em ?? null,
    atualizadoEm: c.atualizado_em ?? null,
  };
}

/**
 * Estado da integração no contexto (empresa + unidade). Leitura: também para o superadmin em impersonação (suporte), mas sem
 * nenhuma ação disponível.
 */
export async function estadoDaIntegracao({ ator, tenant }, { env = process.env, repo, plataforma, segredoConfigurado = false }) {
  exigirAdministracao(env);
  const org = tenant?.organizacaoId;
  const uni = UUID.test(String(tenant?.unidadeId ?? "")) ? tenant.unidadeId : null;
  const podeAdministrar = ehAdminDaOrganizacao(ator, org);

  const conexao = uni ? await repo.obterConexaoParaTela({ organizacaoId: org, unidadeId: uni }) : null;
  const comoTitular = conexao ? await repo.listarDestinosDaTitular({ organizacaoId: org, unidadeId: uni }, conexao.id) : [];
  const comoDestino = await repo.listarDestinosDaOrganizacao(org, uni);

  // Nomes SÓ das organizações/unidades que aparecem nos vínculos deste contexto.
  const conexoesTitulares = new Map();
  for (const d of comoDestino) {
    if (!conexoesTitulares.has(d.conexao_id)) conexoesTitulares.set(d.conexao_id, await repo.obterConexaoPorId(d.conexao_id));
  }
  const idsOrg = new Set([org]); const idsUni = new Set(uni ? [uni] : []);
  for (const d of comoTitular) { idsOrg.add(d.organizacao_id); idsUni.add(d.unidade_id); }
  for (const d of comoDestino) {
    idsOrg.add(d.organizacao_titular_id); idsUni.add(d.unidade_id);
    const c = conexoesTitulares.get(d.conexao_id); if (c) idsUni.add(c.unidade_id);
  }
  const nomes = await plataforma.nomes({ organizacoes: [...idsOrg], unidades: [...idsUni] });
  const nomeOrg = (id) => nomes.organizacoes.get(id) ?? "Organização";
  const nomeUni = (id) => nomes.unidades.get(id) ?? "Unidade";

  const vinculo = (d, papel) => {
    const titularUni = papel === "titular" ? uni : conexoesTitulares.get(d.conexao_id)?.unidade_id;
    return {
      id: d.id, conexaoId: d.conexao_id, papel, estado: d.estado, operacao: d.operacao, operacaoRotulo: ROTULO_OPERACAO[d.operacao] ?? d.operacao,
      titular: { organizacao: nomeOrg(d.organizacao_titular_id), unidade: titularUni ? nomeUni(titularUni) : "Unidade" },
      destino: { organizacao: nomeOrg(d.organizacao_id), unidade: nomeUni(d.unidade_id) },
      propostoEm: d.aprovado_titular_em ?? d.criado_em ?? null, aprovadoDestinoEm: d.aprovado_destino_em ?? null,
      revogadoEm: d.revogado_em ?? null, revogadoMotivo: d.revogado_motivo ?? null,
      revogadoPor: d.estado === "REVOGADO" ? quem(d.revogado_por, ator) : null,
      propostoPorVoce: Boolean(ator?.perfilId) && d.aprovado_titular_por === ator.perfilId,
      mesmaPessoa: Boolean(d.aprovado_titular_por) && d.aprovado_titular_por === d.aprovado_destino_por,
      podeAprovar: podeAdministrar && papel === "destino" && d.estado === "PENDENTE",
      podeRevogar: podeAdministrar && d.estado !== "REVOGADO",
    };
  };

  let eventos = [];
  if (uni) {
    const [ec, ed] = await Promise.all([
      repo.listarEventosDaConexao({ organizacaoId: org, unidadeId: uni }, 50),
      repo.listarEventosDeDestinos(org, uni, 50),
    ]);
    eventos = [
      ...ec.map((e) => ({ id: e.id, tipo: "conexao", evento: e.evento, quando: e.criado_em, ator: quem(e.ator_perfil_id, ator),
        statusAnterior: e.status_anterior ?? null, statusNovo: e.status_novo ?? null, impressaoFinal: finalImpressao(e.token_impressao), motivo: e.motivo ?? null })),
      ...ed.map((e) => ({ id: e.id, tipo: "compartilhamento", evento: e.evento, quando: e.criado_em, ator: quem(e.ator_perfil_id, ator),
        emNomeDe: e.ator_organizacao_id ? nomeOrg(e.ator_organizacao_id) : null, motivo: e.motivo ?? null })),
    ].sort((a, b) => (String(a.quando) < String(b.quando) ? 1 : -1)).slice(0, 60);
  }

  return {
    administracao: true,
    podeAdministrar,
    impersonando: Boolean(ator?.impersonando),
    segredoConfigurado: Boolean(segredoConfigurado),
    empresa: { nome: nomeOrg(org) },
    unidade: uni ? { nome: nomeUni(uni) } : null,
    // Informativo: a coleta de pedidos NÃO depende de nada desta tela.
    sincronizacao: {
      coletaHabilitada: uni ? unidadePermitida(env, uni) : false,
      agendadorHabilitado: agendamentoPermitido(env),
      distribuicaoHabilitada: compartilhamentoPermitido(env),
    },
    conexao: conexaoParaTela(conexao),
    compartilhamentos: [...comoTitular.map((d) => vinculo(d, "titular")), ...comoDestino.map((d) => vinculo(d, "destino"))],
    operacoesCompartilhaveis: OPERACOES_DESTINO.map((o) => ({ id: o, rotulo: ROTULO_OPERACAO[o] ?? o })),
    eventos,
  };
}

async function administrar(acao, { ator, tenant, ...p }, { env = process.env, repo, seguranca, exigirFlag = true }) {
  if (exigirFlag) exigirAdministracao(env);
  exigirAdminDaUnidade(ator, tenant);
  const r = await repo.administrarConexao(tenant, { acao, ator: ator.perfilId, ...p });
  return { resultado: r.resultado, conexaoId: r.conexaoId, status: r.status, evento: r.evento };
}

/** Cadastro (ou reconexão depois de revogada). Nasce PAUSADA. O token nunca volta na resposta. */
export async function cadastrarConexao({ ator, tenant, token, pontoColetaEsperado = null }, deps) {
  exigirAdministracao(deps?.env ?? process.env);
  exigirAdminDaUnidade(ator, tenant);
  const t = validarToken(token);
  const ponto = pontoColeta(pontoColetaEsperado);
  const { tokenCifrado, tokenImpressao } = cifrar(t, tenant.unidadeId, deps.seguranca);
  const r = await administrar("CADASTRAR", { ator, tenant, tokenCifrado, tokenImpressao, pontoColeta: ponto }, deps);
  return { ...r, impressaoFinal: finalImpressao(tokenImpressao) };
}

/** Troca de token (rotação). Volta a PAUSADA; recusada com compartilhamento vivo (seria outra conta debaixo do vínculo). */
export async function substituirToken({ ator, tenant, token, motivo: m = null }, deps) {
  exigirAdministracao(deps?.env ?? process.env);
  exigirAdminDaUnidade(ator, tenant);
  const t = validarToken(token);
  const { tokenCifrado, tokenImpressao } = cifrar(t, tenant.unidadeId, deps.seguranca);
  const r = await administrar("SUBSTITUIR_TOKEN", { ator, tenant, tokenCifrado, tokenImpressao, motivo: motivo(m) }, deps);
  return { ...r, impressaoFinal: finalImpressao(tokenImpressao) };
}

/** Ativar NÃO coleta pedidos: só deixa a conexão pronta para quando a sincronização for habilitada. */
export const ativarConexao = ({ ator, tenant }, deps) => administrar("ATIVAR", { ator, tenant }, deps);
export const pausarConexao = ({ ator, tenant, motivo: m = null }, deps) => administrar("PAUSAR", { ator, tenant, motivo: motivo(m) }, deps);
export const alterarPontoColeta = ({ ator, tenant, pontoColetaEsperado }, deps) =>
  administrar("PONTO_COLETA", { ator, tenant, pontoColeta: pontoColeta(pontoColetaEsperado) }, deps);
/** Revogar é sempre permitido (mesmo com a administração desligada): desligar nunca depende de ligar algo. */
export const revogarConexao = ({ ator, tenant, motivo: m }, deps) =>
  administrar("REVOGAR", { ator, tenant, motivo: motivo(m, { obrigatorio: true }) }, { ...deps, exigirFlag: false });

/**
 * Organizações (e unidades) que PODEM ser destino de uma proposta: só aquelas em que o próprio administrador tem vínculo ATIVO
 * (qualquer papel). Nunca lista as empresas da plataforma — a tela não vira um catálogo de clientes.
 */
export async function destinosPossiveis({ ator, tenant }, { env = process.env, plataforma }) {
  exigirAdministracao(env);
  exigirAdminDaUnidade(ator, tenant);
  const orgs = (await plataforma.organizacoesDoPerfil(ator.perfilId)).filter((o) => o.id !== tenant.organizacaoId);
  const saida = [];
  for (const o of orgs) {
    const unidades = (await plataforma.unidadesDaOrganizacao(o.id)).filter((u) => u.id !== tenant.unidadeId);
    if (unidades.length) saida.push({ organizacaoId: o.id, nome: o.nome, unidades: unidades.map((u) => ({ id: u.id, nome: u.nome })) });
  }
  return saida;
}

/** Proposta de compartilhamento pela titular, só para um destino da lista acima (ids arbitrários são recusados). */
export async function proporCompartilhamento({ ator, tenant, destino }, deps) {
  const { env = process.env, repo, plataforma } = deps;
  exigirAdministracao(env);
  exigirAdminDaUnidade(ator, tenant);
  const conexao = await repo.obterConexaoParaTela(tenant);
  if (!conexao) throw erro("SEM_CONEXAO", "cadastre a conexão Foody da unidade antes de compartilhar.");
  if (conexao.status === "REVOGADA") throw erro("CONEXAO_REVOGADA", "a conexão foi revogada; cadastre um novo token.");
  const possiveis = await destinosPossiveis({ ator, tenant }, { env, plataforma });
  const org = possiveis.find((o) => o.organizacaoId === destino?.organizacaoId);
  if (!org || !org.unidades.some((u) => u.id === destino?.unidadeId)) {
    throw erro("DESTINO_NAO_PERMITIDO", "escolha uma organização e unidade da lista (só aparecem as empresas em que você tem acesso).");
  }
  return proporDestino({ ator, conexaoId: conexao.id, destino: { organizacaoId: org.organizacaoId, unidadeId: destino.unidadeId, operacao: destino.operacao } },
    { env, repo, agora: deps.agora });
}
