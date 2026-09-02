// Perfil operacional — a camada "quem é a PESSOA" entre a CONTA (auth.users /
// perfis / req.user) e o CONTEXTO (empresa/unidade / Context Token).
//
// FASE C: só LEITURA e VALIDAÇÃO. Este módulo:
//   * lista os perfis ATIVOS de uma conta (GET /sessao/perfis);
//   * valida que um perfilId pertence à conta autenticada e está ativo;
//   * lista os acessos (empresas/unidades) DE UM PERFIL (não da conta).
//
// O que a Fase C NÃO faz (e este módulo também não): não valida PIN, não
// emite Context Token com `pid`, não persiste "perfil ativo" em lugar nenhum.
// A seleção de perfil é um passo de VALIDAÇÃO cujo resultado o cliente usa no
// próximo passo (/sessao/selecionar); a emissão do token com o perfil é da
// Fase D.
//
// SEGURANÇA (nunca relaxar):
//   * a CONTA vem SEMPRE de req.user.id — nunca do corpo/query;
//   * todo acesso a `perfis_operacionais` filtra por conta_id === contaId;
//   * "perfil não existe" e "perfil é de outra conta" respondem IGUAL
//     (404) — não vaza a existência de perfis de terceiros;
//   * pin_hash / pin_tentativas / pin_bloqueado_ate NUNCA saem daqui — só o
//     booleano `temPin`.
//
// PRÉ-REQUISITO DE INFRAESTRUTURA: a migration 060 (`perfis_operacionais` +
// `usuarios_*.perfil_id`) precisa estar aplicada no ambiente para os endpoints
// deste módulo funcionarem. Enquanto não estiver, GET /sessao/perfis e
// GET /sessao/acessos?perfilId=... respondem 500 — mas o frontend atual não
// chama nenhum dos dois (a tela "Selecione seu usuário" é da Fase F), então
// não há impacto para o usuário. Ver docs/multi-perfil-fase-c-backend-perfil.md.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { listarAcessos, revogarSessoes } from "./sessao.service.js";
import { hashPin, verificarPin, validarFormatoPin } from "../../shared/pin.js";
import { emitirProfileSelectionToken, verificarProfileSelectionToken } from "../../shared/profileSelectionToken.js";
import * as v from "../../shared/validar.js";

// Lockout do PIN (Fase H, ponto 14) — server-side, por PERFIL. Contabilizado
// de forma ATÔMICA (RPC da migration 064; degrada para compare-and-swap se
// a 064 ainda não rodou).
const PIN_MAX_TENTATIVAS = 5;
const PIN_LOCK_MINUTOS = 15;

// ---------------------------------------------------------------------------
// Buscas-padrão (Supabase real) — injetáveis para teste, mesmo padrão de
// sessao.service.js#listarAcessos.
// ---------------------------------------------------------------------------

// `RE_COLUNA_AUSENTE` — degradação graciosa se a migration 060 ainda não rodou
// (Fase E exige 060, mas isto cobre a janela de transição / cache de schema).
const RE_COLUNA_AUSENTE = /perfis_operacionais|perfil_id|does not exist|schema cache|could not find/i;

/**
 * Garante que a CONTA tem sua linha de perfil operacional INICIAL
 * (`perfis_operacionais` com `id == conta_id` — o "UUID reaproveitado" da 060).
 * Idempotente (`on conflict do nothing`). Usado na criação de conta nova
 * (a 060 só backfillou contas que já existiam).
 *
 * Devolve o `perfil_id` a usar nos vínculos. Se `perfis_operacionais` ainda
 * não existe (pré-060), devolve o próprio `contaId` — para uma conta legada de
 * 1 perfil isso é exatamente o valor que o backfill produziria.
 *
 * @param {{ contaId: string, nome?: string, ativo?: boolean }} params
 * @returns {Promise<string>} perfil_id inicial da conta (== contaId nesta fase)
 */
export async function garantirPerfilOperacionalInicial({ contaId, nome = null, ativo = true }) {
  const cId = v.uuid(contaId, "Conta");
  const { error } = await supabase.from("perfis_operacionais").insert({
    id: cId, conta_id: cId, nome: (nome && String(nome).trim()) || "Usuário", ativo,
  });
  // 23505 = unique_violation -> a linha já existe (backfill 060 ou chamada anterior). OK.
  if (error && !/duplicate key|already exists|23505/i.test(error.message || "")) {
    if (!RE_COLUNA_AUSENTE.test(error.message || "")) throw ApiError.internal(error.message);
    // pré-060: sem tabela. O vínculo cai no fallback sem perfil_id (ver services).
  }
  return cId;
}

/**
 * Cria um perfil operacional ADICIONAL de uma conta (Fase G). Sempre com UUID
 * NOVO — NUNCA reaproveita `contaId` (esse id é do perfil legado inicial, id ==
 * conta_id; ver 060). Não cria auth.users, não cria e-mail, não toca a conta.
 * @param {{ contaId: string, nome: string, ativo?: boolean }} p
 * @returns {Promise<{ id: string, nome: string, ativo: boolean }>}
 */
export async function criarPerfilOperacional({ contaId, nome, ativo = true }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const nomeOk = v.texto(nome, "Nome do usuário", { max: 160 });

  const buscarConta = deps.buscarConta ?? (async (id) => {
    const { data } = await supabase.from("perfis").select("id, ativo").eq("id", id).maybeSingle();
    return data;
  });
  const conta = await buscarConta(cId);
  if (!conta) throw ApiError.notFound("Conta de acesso não encontrada.");

  const { data, error } = await supabase
    .from("perfis_operacionais")
    .insert({ conta_id: cId, nome: nomeOk, ativo }) // id: default gen_random_uuid()
    .select("id, nome, ativo")
    .single();
  if (error || !data) {
    if (RE_COLUNA_AUSENTE.test(error?.message || "")) {
      throw ApiError.badRequest("A base ainda não está preparada para múltiplos usuários por conta (migration 060 pendente).");
    }
    throw ApiError.internal(error?.message || "Não foi possível criar o usuário.");
  }
  return data;
}

/**
 * Ativa/desativa um perfil (Fase G). NUNCA DELETE físico. Ao DESATIVAR revoga
 * as sessões DAQUELE perfil (não os irmãos). Ao ATIVAR, se a conta passar a ter
 * 2+ perfis ativos, TODOS precisam de PIN — senão 403 CONFIGURACAO_PIN_INCOMPLETA.
 * @param {{ contaId: string, perfilId: string, ativo: boolean }} p
 * @param {{ revogar?: Function, buscarPerfisDaConta?: Function }} [deps]
 */
export async function definirAtivoDoPerfil({ contaId, perfilId, ativo }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const pId = v.uuid(perfilId, "Perfil");
  const alvoAtivo = v.booleano(ativo, true);

  const buscarTodos = deps.buscarPerfisDaConta ?? (async (id) => {
    const { data, error } = await supabase.from("perfis_operacionais")
      .select("id, nome, ativo, pin_hash").eq("conta_id", id);
    if (error) throw ApiError.internal(error.message);
    return data ?? [];
  });
  const todos = await buscarTodos(cId);
  const alvo = todos.find((p) => p.id === pId);
  if (!alvo) throw ApiError.notFound("Perfil não encontrado.");
  if (alvo.ativo === alvoAtivo) return { perfilId: pId, ativo: alvoAtivo, sessoesRevogadas: 0, jaEstava: true };

  if (alvoAtivo) {
    const ativosDepois = todos.filter((p) => (p.id === pId ? true : p.ativo));
    if (ativosDepois.length >= 2 && ativosDepois.some((p) => !p.pin_hash)) {
      throw ApiError.forbidden(
        "Não é possível ativar: a conta ficaria com 2 ou mais usuários e nem todos têm PIN. Defina o PIN de todos primeiro.",
        { codigo: "CONFIGURACAO_PIN_INCOMPLETA", perfisSemPin: ativosDepois.filter((p) => !p.pin_hash).map((p) => ({ id: p.id, nome: p.nome })) },
      );
    }
  }

  const aplicar = deps.aplicar ?? (async () => {
    const { error } = await supabase.from("perfis_operacionais").update({ ativo: alvoAtivo }).eq("id", pId);
    if (error) throw ApiError.internal(error.message);
  });
  await aplicar(alvoAtivo);

  let sessoesRevogadas = 0;
  if (!alvoAtivo) {
    sessoesRevogadas = await (deps.revogar ?? revogarSessoes)({ perfilId: pId, motivo: "perfil_desativado" });
  }
  return { perfilId: pId, ativo: alvoAtivo, sessoesRevogadas };
}

// A UNIQUE canônica é `(perfil_id, X)` (constraint da migration 063). Pré-063
// só existe a UNIQUE legada `(usuario_id, X)` da 015.
const RE_ONCONFLICT_AUSENTE = /no unique or exclusion constraint|ON CONFLICT/i;
const RE_DUPLICATA = /duplicate key|unique|already exists|23505/i;

// Mensagens de NEGÓCIO para conflito de vínculo — sensíveis ao ALVO (M3). NÃO
// mencionam migration nenhuma: a nota técnica ("resolvido pela 063") fica só
// aqui no código / na doc, nunca chega ao usuário final.
const msgIrmaoMesmoAlvo = (tabela) => (tabela === "usuarios_unidades"
  ? "Esta conta já possui outro perfil associado a esta unidade."
  : "Esta conta já possui outro perfil associado a esta empresa.");
const msgVinculoJaExiste = (tabela) => (tabela === "usuarios_unidades"
  ? "Este perfil já está associado a esta unidade."
  : "Este perfil já está associado a esta empresa.");

/**
 * Grava um vínculo (`usuarios_organizacoes` ou `usuarios_unidades`) chaveado
 * pela IDENTIDADE OPERACIONAL (`perfil_id`), mantendo `usuario_id` (LEGACY).
 * Compartilhado por `usuarios/usuarios.service.js` e
 * `plataforma/plataforma.usuarios.service.js`.
 *
 * `upsert: true` = "criar ou reativar/trocar cargo DESTE perfil neste alvo".
 *   * Pós-063: upsert nativo em `(perfil_id, X)`.
 *   * Pré-063 (sem essa UNIQUE): NÃO degrada para `upsert(usuario_id, X)` —
 *     isso sobrescreveria o vínculo de um PERFIL IRMÃO. Busca a linha exata
 *     `(perfil_id, X)` e faz UPDATE; senão INSERT (a UNIQUE legada
 *     `(usuario_id, X)` recusa 2 perfis no mesmo alvo → erro de negócio).
 *
 * `upsert: false` (INSERT puro, usado ao criar um perfil novo): um duplicate-key
 * é traduzido para erro de NEGÓCIO em vez de vazar cru (evita 500 — M2/B8),
 * distinguindo "este mesmo perfil já está no alvo" de "um perfil irmão ocupa".
 *
 * Degrada sem `perfil_id` (pré-060 — inalcançável no plano de deploy).
 * @param {{tabela: string, alvoCol: string, alvoId: string, usuarioId: string, perfilId: string, papel: string|null, upsert?: boolean}} p
 * @returns {Promise<any>} erro do Supabase, `{ codigo, message }` de negócio, ou null
 */
async function gravarVinculo({ tabela, alvoCol, alvoId, usuarioId, perfilId, papel, upsert }) {
  const base = { usuario_id: usuarioId, [alvoCol]: alvoId, papel, ativo: true };
  const T = () => supabase.from(tabela);
  const linhaDestePerfil = async () => {
    const { data } = await T().select("id").eq("perfil_id", perfilId).eq(alvoCol, alvoId).maybeSingle();
    return data?.id ?? null;
  };

  // 1. caminho canônico (pós-063): (perfil_id, alvo) é a UNIQUE.
  const onConflict = `perfil_id,${alvoCol}`;
  let { error } = upsert
    ? await T().upsert({ ...base, perfil_id: perfilId }, { onConflict })
    : await T().insert({ ...base, perfil_id: perfilId });
  if (!error) return null;

  // 1b. INSERT puro que bateu numa UNIQUE → erro de negócio (nunca 500).
  if (!upsert && RE_DUPLICATA.test(error.message || "")) {
    return (await linhaDestePerfil())
      ? { codigo: "VINCULO_JA_EXISTE", message: msgVinculoJaExiste(tabela) }
      : { codigo: "VINCULO_PERFIL_IRMAO_MESMO_ALVO", message: msgIrmaoMesmoAlvo(tabela) };
  }

  // 2. pré-063: sem a UNIQUE (perfil_id, alvo). Nunca degrada para
  //    upsert(usuario_id, X) — sobrescreveria o irmão.
  if (upsert && RE_ONCONFLICT_AUSENTE.test(error.message || "")) {
    const idExistente = await linhaDestePerfil();
    if (idExistente) {
      ({ error } = await T().update({ papel, ativo: true }).eq("id", idExistente));
    } else {
      ({ error } = await T().insert({ ...base, perfil_id: perfilId }));
      if (error && RE_DUPLICATA.test(error.message || "")) {
        // colisão na UNIQUE legada (usuario_id, X): um perfil IRMÃO da conta já
        // ocupa este alvo. Resolvido pela migration 063 (não citar ao usuário).
        return { codigo: "VINCULO_PERFIL_IRMAO_MESMO_ALVO", message: msgIrmaoMesmoAlvo(tabela) };
      }
    }
    if (!error) return null;
  }

  // 3. pré-060: sem a coluna perfil_id (inalcançável no plano de deploy — a
  //    060 entra antes do backend; mantido como rede de segurança defensiva).
  if (RE_COLUNA_AUSENTE.test(error.message || "")) {
    ({ error } = await T().upsert(base, { onConflict: `usuario_id,${alvoCol}` }));
  }
  return error ?? null;
}

export async function inserirVinculoOrgComPerfil({ usuarioId, perfilId, organizacaoId, papel, upsert = false }) {
  return gravarVinculo({ tabela: "usuarios_organizacoes", alvoCol: "organizacao_id", alvoId: organizacaoId, usuarioId, perfilId, papel, upsert });
}

/** Idem para `usuarios_unidades`. `papel` pode ser null (herda da empresa). */
export async function inserirVinculoUnidadeComPerfil({ usuarioId, perfilId, unidadeId, papel = null, upsert = false }) {
  return gravarVinculo({ tabela: "usuarios_unidades", alvoCol: "unidade_id", alvoId: unidadeId, usuarioId, perfilId, papel, upsert });
}

/** Perfis operacionais ATIVOS de uma conta. Traz pin_hash só para derivar `temPin`. */
export async function buscarPerfisAtivosDaConta(contaId) {
  const { data, error } = await supabase
    .from("perfis_operacionais")
    .select("id, nome, ativo, pin_hash")
    .eq("conta_id", contaId)
    .eq("ativo", true)
    .order("nome");
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Um perfil por id — mas só devolve se pertencer à `contaId`. Um perfil de
 * outra conta volta como `null` (indistinguível de "não existe").
 */
async function buscarPerfilDaConta({ contaId, perfilId }) {
  const { data, error } = await supabase
    .from("perfis_operacionais")
    .select("id, nome, ativo, conta_id, pin_hash")
    .eq("id", perfilId)
    .maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data || data.conta_id !== contaId) return null;
  return data;
}

// ---------------------------------------------------------------------------
// API do módulo
// ---------------------------------------------------------------------------

/**
 * Perfis operacionais ATIVOS da conta autenticada. Nunca expõe segredos de PIN.
 * @param {string} contaId  req.user.id (NUNCA do cliente)
 * @param {{buscarPerfisAtivosDaConta?: typeof buscarPerfisAtivosDaConta}} [deps]
 * @returns {Promise<Array<{id: string, nome: string, ativo: boolean, temPin: boolean}>>}
 */
export async function listarPerfisDaConta(contaId, deps = {}) {
  const id = v.uuid(contaId, "Conta");
  const buscar = deps.buscarPerfisAtivosDaConta ?? buscarPerfisAtivosDaConta;
  const perfis = await buscar(id);
  return perfis.map((p) => ({
    id: p.id,
    nome: p.nome,
    ativo: p.ativo,
    // contrato para a Fase H — o cliente futuro sabe se o próximo passo pede
    // PIN, sem nunca receber o hash.
    temPin: !!p.pin_hash,
  }));
}

/**
 * Devolve o perfil se pertencer à conta, senão `null`. NÃO lança para
 * "não é da conta" — quem precisa de erro usa `validarPerfilDaConta`.
 * @param {{contaId: string, perfilId: unknown}} params
 * @param {{buscarPerfilDaConta?: typeof buscarPerfilDaConta}} [deps]
 */
export async function obterPerfilDaConta({ contaId, perfilId }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const pId = v.uuid(perfilId, "Perfil");
  const buscar = deps.buscarPerfilDaConta ?? buscarPerfilDaConta;
  return buscar({ contaId: cId, perfilId: pId });
}

/**
 * Valida POSSE + ESTADO do perfil. Lança ApiError no padrão do projeto.
 *   * não existe / é de outra conta  -> 404 (mesma resposta — não vaza)
 *   * existe, é da conta, mas inativo -> 403
 * @param {{contaId: string, perfilId: unknown}} params
 * @param {{buscarPerfilDaConta?: typeof buscarPerfilDaConta}} [deps]
 * @returns {Promise<{id: string, nome: string, temPin: boolean}>}
 */
export async function validarPerfilDaConta({ contaId, perfilId }, deps = {}) {
  const perfil = await obterPerfilDaConta({ contaId, perfilId }, deps);
  if (!perfil) throw ApiError.notFound("Perfil não encontrado.");
  if (!perfil.ativo) throw ApiError.forbidden("Este perfil está desativado.");
  return { id: perfil.id, nome: perfil.nome, temPin: !!perfil.pin_hash };
}

/**
 * Seleção de perfil — FASE H. Valida a posse do perfil e, conforme a
 * configuração da conta, exige (ou não) o PIN. Em caso de sucesso EMITE o
 * Profile Selection Token — a prova server-side de que este perfil passou pelo
 * PIN. É essa prova (não o `perfilId` do corpo) que `POST /sessao/selecionar`
 * exige de contas multi-perfil.
 *
 * REGRAS (Fase H, pontos 7/8/9/20):
 *   * conta com **1 perfil ativo** -> PIN NÃO é pedido, mesmo que `pin_hash`
 *     exista. Emite a prova direto. Compatível com o frontend legado que nem
 *     chama esta rota (o `resolverPerfilParaContexto` resolve o perfil único).
 *   * conta com **2+ perfis ativos**:
 *       - se QUALQUER perfil ativo estiver sem PIN -> `CONFIGURACAO_PIN_INCOMPLETA`
 *         (ninguém entra pelo fluxo multi-perfil — a conta é inconsistente);
 *       - `pin` ausente -> `{ precisaPin: true }` (sem prova — o cliente reenvia com PIN);
 *       - `pin` presente -> valida (com lockout). Correto -> emite a prova.
 *   * perfis INATIVOS não contam para a regra de "2+" (ponto 9).
 *
 * @param {{contaId: string, perfilId: unknown, pin?: unknown}} params
 * @param {{buscarPerfilDaConta?: Function, buscarPerfisAtivosDaConta?: Function, emitirProva?: Function, agora?: () => number}} [deps]
 * @returns {Promise<object>}
 */
export async function selecionarPerfil({ contaId, perfilId, pin }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const perfil = await validarPerfilDaConta({ contaId: cId, perfilId }, deps);

  const buscarAtivos = deps.buscarPerfisAtivosDaConta ?? buscarPerfisAtivosDaConta;
  const emitir = deps.emitirProva ?? emitirProvaSelecao;

  let ativos = [];
  try {
    ativos = await buscarAtivos(cId);
  } catch (e) {
    if (!RE_COLUNA_AUSENTE.test(e?.message || "")) throw e; // pré-060: trata como conta única
  }
  const multiPerfil = ativos.length >= 2;

  if (!multiPerfil) {
    // Conta de 1 perfil (ou pré-060): sem PIN. Emite a prova direto.
    const prova = emitir({ contaId: cId, perfilId: perfil.id });
    return {
      perfil: { id: perfil.id, nome: perfil.nome },
      temPin: perfil.temPin,
      precisaPin: false,
      profileSelectionToken: prova.token,
      expiraEm: prova.expiraEm,
      proximoPasso: "selecionar_contexto",
    };
  }

  // Multi-perfil: a configuração de PIN da conta TEM de estar completa.
  if (ativos.some((p) => !p.pin_hash)) {
    throw ApiError.forbidden(
      "A configuração de PIN desta conta está incompleta. Todos os perfis precisam ter PIN. Fale com o administrador.",
      { codigo: "CONFIGURACAO_PIN_INCOMPLETA" },
    );
  }

  if (pin == null || pin === "") {
    return {
      perfil: { id: perfil.id, nome: perfil.nome },
      temPin: true,
      precisaPin: true,
      proximoPasso: "informar_pin",
    };
  }

  await validarPinParaSelecao({ contaId: cId, perfilId: perfil.id, pin }, deps);
  const prova = emitir({ contaId: cId, perfilId: perfil.id });
  return {
    perfil: { id: perfil.id, nome: perfil.nome },
    temPin: true,
    precisaPin: false,
    profileSelectionToken: prova.token,
    expiraEm: prova.expiraEm,
    proximoPasso: "selecionar_contexto",
  };
}

/** Emite o Profile Selection Token (isolado para injeção em teste). */
export function emitirProvaSelecao({ contaId, perfilId }) {
  return emitirProfileSelectionToken({ contaId, perfilId });
}

// ---------------------------------------------------------------------------
// PIN — validação (com lockout) e gestão administrativa (Fase H)
// ---------------------------------------------------------------------------

/** Linha completa de PIN de um perfil, só se pertencer à conta. `null` senão. */
async function buscarPerfilComPin({ contaId, perfilId }) {
  const { data, error } = await supabase
    .from("perfis_operacionais")
    .select("id, nome, ativo, conta_id, pin_hash, pin_tentativas, pin_bloqueado_ate")
    .eq("id", perfilId)
    .maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data || data.conta_id !== contaId) return null;
  return data;
}

/** Incremento atômico de falha (RPC 064; degrada para compare-and-swap). */
async function registrarFalhaPin(perfilId, tentativasAtuais) {
  const { data, error } = await supabase.rpc("perfil_pin_registrar_falha", {
    p_perfil_id: perfilId,
    p_max_tentativas: PIN_MAX_TENTATIVAS,
    p_lock_minutos: PIN_LOCK_MINUTOS,
  });
  if (!error && Array.isArray(data) && data[0]) {
    return { tentativas: data[0].pin_tentativas, bloqueadoAte: data[0].pin_bloqueado_ate };
  }
  // Pré-064: sem a RPC. Compare-and-swap otimista (não perde incremento sob
  // contenção normal; sob corrida extrema pode coalescer — só reduz lockouts,
  // nunca deixa passar do limite, e o check de bloqueio já roda antes).
  const prox = (Number(tentativasAtuais) || 0) + 1;
  const patch = { pin_tentativas: prox };
  if (prox >= PIN_MAX_TENTATIVAS) {
    patch.pin_bloqueado_ate = new Date(Date.now() + PIN_LOCK_MINUTOS * 60_000).toISOString();
  }
  await supabase.from("perfis_operacionais").update(patch)
    .eq("id", perfilId).eq("pin_tentativas", tentativasAtuais);
  return { tentativas: prox, bloqueadoAte: patch.pin_bloqueado_ate ?? null };
}

/** Reset atômico após PIN correto (RPC 064; degrada para update simples). */
async function registrarSucessoPin(perfilId) {
  const { error } = await supabase.rpc("perfil_pin_registrar_sucesso", { p_perfil_id: perfilId });
  if (error) {
    await supabase.from("perfis_operacionais")
      .update({ pin_tentativas: 0, pin_bloqueado_ate: null }).eq("id", perfilId);
  }
}

/**
 * Valida o PIN de um perfil para SELEÇÃO. Aplica, nesta ordem:
 *   1. perfil é da conta? (senão -> 404 genérico — não vaza existência)
 *   2. perfil ATIVO? (senão -> 403, ANTES de qualquer hash)
 *   3. `pin_bloqueado_ate > agora`? (senão -> 429 PIN_TEMPORARIAMENTE_BLOQUEADO,
 *      SEM calcular hash)
 *   4. perfil tem PIN configurado? (senão -> 403 — multi-perfil sem PIN não chega aqui)
 *   5. verifica o hash:
 *        correto -> zera tentativas/bloqueio (atômico) -> ok
 *        incorreto -> incrementa (atômico); no limite, bloqueia -> 429/401 genérico
 *
 * @param {{contaId: string, perfilId: string, pin: unknown}} params
 * @param {{buscarPerfilComPin?: Function, verificarPin?: Function, registrarFalha?: Function, registrarSucesso?: Function, agora?: () => number}} [deps]
 * @returns {Promise<{ok: true}>}
 */
export async function validarPinParaSelecao({ contaId, perfilId, pin }, deps = {}) {
  const buscar = deps.buscarPerfilComPin ?? buscarPerfilComPin;
  const verificar = deps.verificarPin ?? verificarPin;
  const falha = deps.registrarFalha ?? registrarFalhaPin;
  const sucesso = deps.registrarSucesso ?? registrarSucessoPin;
  const agora = deps.agora ? deps.agora() : Date.now();

  const perfil = await buscar({ contaId, perfilId });
  if (!perfil) throw ApiError.notFound("Perfil não encontrado.");
  if (!perfil.ativo) throw ApiError.forbidden("Este perfil está desativado.");

  const bloqueadoAte = perfil.pin_bloqueado_ate ? new Date(perfil.pin_bloqueado_ate).getTime() : 0;
  if (bloqueadoAte > agora) {
    const restaMin = Math.max(1, Math.ceil((bloqueadoAte - agora) / 60_000));
    throw ApiError.tooManyRequests(
      `PIN bloqueado temporariamente. Tente novamente em cerca de ${restaMin} min.`,
      { codigo: "PIN_TEMPORARIAMENTE_BLOQUEADO" },
    );
  }

  if (!perfil.pin_hash) {
    // Não deveria acontecer no fluxo multi-perfil (selecionarPerfil barra
    // antes); defensivo. Resposta genérica.
    throw ApiError.forbidden("PIN não configurado para este perfil.", { codigo: "PIN_NAO_CONFIGURADO" });
  }

  const ok = await verificar(String(pin), perfil.pin_hash);
  if (!ok) {
    const r = await falha(perfilId, perfil.pin_tentativas ?? 0);
    if (r?.bloqueadoAte && new Date(r.bloqueadoAte).getTime() > agora) {
      throw ApiError.tooManyRequests(
        "PIN incorreto e perfil bloqueado temporariamente. Tente novamente mais tarde.",
        { codigo: "PIN_TEMPORARIAMENTE_BLOQUEADO" },
      );
    }
    throw ApiError.unauthorized("PIN incorreto.");
  }

  await sucesso(perfilId);
  return { ok: true };
}

/**
 * Define/troca/reseta o `pin_hash` de um perfil EXISTENTE (Fase H). Nunca cria
 * perfil. Sempre: grava o hash, marca `pin_atualizado_em`, zera tentativas,
 * limpa bloqueio e (por padrão) REVOGA todas as sessões daquele perfil — se a
 * identidade individual mudou, as sessões antigas dele devem cair (ponto 31).
 * NÃO derruba perfis irmãos (escopo `perfilId`).
 *
 * @param {{contaId: string, perfilId: unknown, pin: unknown, motivo?: string, revogarSessoesDoPerfil?: boolean}} p
 * @param {{revogar?: Function, hash?: Function}} [deps]
 */
export async function definirPinDoPerfil(
  { contaId, perfilId, pin, motivo = "pin_definido", revogarSessoesDoPerfil = true },
  deps = {},
) {
  const cId = v.uuid(contaId, "Conta");
  const pId = v.uuid(perfilId, "Perfil");
  validarFormatoPin(pin);

  const perfil = await buscarPerfilDaConta({ contaId: cId, perfilId: pId });
  if (!perfil) throw ApiError.notFound("Perfil não encontrado.");

  const hash = await (deps.hash ?? hashPin)(String(pin));
  const patch = {
    pin_hash: hash,
    pin_tentativas: 0,
    pin_bloqueado_ate: null,
    pin_atualizado_em: new Date().toISOString(),
  };
  let { error } = await supabase.from("perfis_operacionais").update(patch).eq("id", pId);
  if (error && /pin_atualizado_em|schema cache|could not find/i.test(error.message || "")) {
    const { pin_atualizado_em: _drop, ...semColuna } = patch; // pré-064
    ({ error } = await supabase.from("perfis_operacionais").update(semColuna).eq("id", pId));
  }
  if (error) throw ApiError.internal(error.message);

  let sessoesRevogadas = 0;
  if (revogarSessoesDoPerfil) {
    sessoesRevogadas = await (deps.revogar ?? revogarSessoes)({ perfilId: pId, motivo });
  }
  return { perfilId: pId, sessoesRevogadas };
}

/**
 * Troca do PIN pelo PRÓPRIO perfil — exige o PIN atual. Preparado para a Fase G
 * (sem UI ainda). Revoga as demais sessões do perfil por segurança.
 * @param {{contaId: string, perfilId: unknown, pinAtual: unknown, pinNovo: unknown, sessionIdPreservar?: string|null}} p
 */
export async function trocarPinDoPerfil({ contaId, perfilId, pinAtual, pinNovo, sessionIdPreservar = null }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const pId = v.uuid(perfilId, "Perfil");
  validarFormatoPin(pinNovo);
  // valida o PIN atual com o mesmo lockout da seleção
  await validarPinParaSelecao({ contaId: cId, perfilId: pId, pin: pinAtual }, deps);
  const r = await definirPinDoPerfil(
    { contaId: cId, perfilId: pId, pin: pinNovo, motivo: "pin_trocado", revogarSessoesDoPerfil: false },
    deps,
  );
  // revoga as sessões do perfil, opcionalmente preservando a atual
  const revogar = deps.revogar ?? revogarSessoes;
  const revogadas = await revogar({ perfilId: pId, motivo: "pin_trocado" });
  return { ...r, sessoesRevogadas: revogadas, sessionIdPreservar };
}

/**
 * Remove o PIN de um perfil (`pin_hash = NULL`). SÓ permitido se a conta ficar
 * consistente: uma conta com 2+ perfis ativos NÃO pode ter perfil sem PIN.
 * @param {{contaId: string, perfilId: unknown}} p
 */
export async function removerPinDoPerfil({ contaId, perfilId }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const pId = v.uuid(perfilId, "Perfil");
  const buscarAtivos = deps.buscarPerfisAtivosDaConta ?? buscarPerfisAtivosDaConta;
  const ativos = await buscarAtivos(cId);
  if (ativos.length >= 2 && ativos.some((p) => p.id === pId)) {
    throw ApiError.forbidden(
      "Não é possível remover o PIN: esta conta tem 2 ou mais perfis e todos precisam de PIN.",
      { codigo: "CONFIGURACAO_PIN_INCOMPLETA" },
    );
  }
  const perfil = await buscarPerfilDaConta({ contaId: cId, perfilId: pId });
  if (!perfil) throw ApiError.notFound("Perfil não encontrado.");
  const { error } = await supabase.from("perfis_operacionais")
    .update({ pin_hash: null, pin_tentativas: 0, pin_bloqueado_ate: null }).eq("id", pId);
  if (error) throw ApiError.internal(error.message);
  const revogadas = await (deps.revogar ?? revogarSessoes)({ perfilId: pId, motivo: "pin_removido" });
  return { perfilId: pId, sessoesRevogadas: revogadas };
}

/**
 * Acessos (empresas/unidades) DE UM PERFIL — nunca da conta inteira.
 * Valida a posse do perfil ANTES (404/403) e então delega para a mesma
 * máquina de herança de `listarAcessos`, agora escopada por `perfil_id`.
 *
 * ISOLAMENTO OBRIGATÓRIO: com a conta "Operacional X" (Fulana 1 -> Empresa A,
 * Fulana 2 -> Empresa B), `listarAcessosDoPerfil(Fulana 1)` devolve SÓ a
 * Empresa A, mesmo a conta tendo a Fulana 2 na Empresa B.
 *
 * @param {{contaId: string, perfilId: unknown}} params
 * @param {object} [deps] injeção para teste. `deps.buscarPerfilDaConta` para a
 *   validação; os demais (`buscarVinculosPorPerfil`, `buscarUnidadesAtivas`,
 *   `buscarInfoOrganizacoes`) vão direto para `listarAcessos`.
 * @returns {Promise<{superadmin: boolean, opcoes: import('./sessao.service.js').OpcaoAcesso[]}>}
 */
export async function listarAcessosDoPerfil({ contaId, perfilId }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const pId = v.uuid(perfilId, "Perfil");
  await validarPerfilDaConta({ contaId: cId, perfilId: pId }, deps);
  // `deps` vazio (produção) -> passa `undefined` para `listarAcessos` usar os
  // próprios defaults (que incluem `buscarVinculosPorPerfil`). Substituir por
  // `{}` faria `listarAcessos` perder todas as buscas-padrão.
  return listarAcessos(
    { contaId: cId, perfilId: pId },
    Object.keys(deps).length ? deps : undefined,
  );
}

/**
 * Resolve QUAL perfil operacional uma seleção de contexto vai usar — e, para
 * contas MULTI-PERFIL, exige a PROVA de que o PIN foi validado (Fase H).
 *
 *   * conta com **1 perfil ativo** (ou pré-060):
 *       - `perfilId` ausente -> usa o único (compat frontend legado);
 *       - `perfilId` informado -> valida posse + ativo;
 *       - PIN não é exigido.
 *   * conta com **2+ perfis ativos**:
 *       - `provaSelecao` (Profile Selection Token) é OBRIGATÓRIA. Sem ela ->
 *         `PROVA_PERFIL_OBRIGATORIA` (400). O `perfilId` do corpo, sozinho,
 *         NUNCA basta — seria bypassável.
 *       - a prova é verificada (assinatura + `purpose` + expiração), e:
 *           `prova.acc` DEVE ser a conta autenticada (senão -> negado);
 *           `prova.pid` DEVE ser um perfil ATIVO desta conta;
 *           se o corpo também trouxe `perfilId`, ele DEVE ser == `prova.pid`.
 *       - o perfil resolvido vem da PROVA, nunca do corpo.
 *       - se QUALQUER perfil ativo estiver sem PIN -> `CONFIGURACAO_PIN_INCOMPLETA`.
 *
 * Devolve também `selecaoNonce` (o `jti` da prova) para `criarSessao` consumir
 * de forma única (`sessoes_contexto.selecao_nonce`, migration 064).
 *
 * @param {{ contaId: string, perfilId?: unknown, provaSelecao?: unknown }} params
 * @param {{ buscarPerfilDaConta?: Function, buscarPerfisAtivosDaConta?: Function, verificarProva?: Function }} [deps]
 * @returns {Promise<{ id: string, nome: string|null, selecaoNonce: string|null }>}
 */
export async function resolverPerfilParaContexto({ contaId, perfilId, provaSelecao }, deps = {}) {
  const cId = v.uuid(contaId, "Conta");
  const buscar = deps.buscarPerfisAtivosDaConta ?? buscarPerfisAtivosDaConta;
  const verificarProva = deps.verificarProva ?? verificarProfileSelectionToken;

  let ativos;
  try {
    ativos = await buscar(cId);
  } catch (e) {
    if (!RE_COLUNA_AUSENTE.test(e?.message || "")) throw e;
    // ---- pré-060: sem camada de perfil. Conta = seu próprio perfil. ----
    if (perfilId != null && perfilId !== "" && String(perfilId) !== cId) {
      throw ApiError.notFound("Perfil não encontrado.");
    }
    return { id: cId, nome: null, selecaoNonce: null };
  }

  if (ativos.length === 0) {
    throw ApiError.forbidden("Sua conta não tem nenhum perfil de usuário ativo. Fale com o administrador.");
  }

  // ---- CONTA DE 1 PERFIL ATIVO: sem PIN, sem prova (compat legado) ----
  if (ativos.length === 1) {
    const unico = ativos[0];
    if (perfilId != null && perfilId !== "" && String(perfilId) !== unico.id) {
      throw ApiError.notFound("Perfil não encontrado.");
    }
    return { id: unico.id, nome: unico.nome, selecaoNonce: null };
  }

  // ---- CONTA MULTI-PERFIL (2+ ativos): PROVA obrigatória ----
  if (ativos.some((p) => !p.pin_hash)) {
    throw ApiError.forbidden(
      "A configuração de PIN desta conta está incompleta. Fale com o administrador.",
      { codigo: "CONFIGURACAO_PIN_INCOMPLETA" },
    );
  }
  if (provaSelecao == null || provaSelecao === "") {
    throw ApiError.badRequest(
      "Selecione o perfil e informe o PIN para continuar.",
      { perfilObrigatorio: true, codigo: "PROVA_PERFIL_OBRIGATORIA" },
    );
  }

  const res = verificarProva(provaSelecao);
  if (!res.ok) throw ApiError.badRequest(res.motivo, { codigo: "PROVA_PERFIL_INVALIDA" });

  const prova = res.payload;
  // A prova é DESTA conta? (vínculo obrigatório — ponto 24)
  if (prova.acc !== cId) {
    throw ApiError.badRequest("Prova de seleção inválida. Informe o PIN novamente.", { codigo: "PROVA_PERFIL_INVALIDA" });
  }
  // O perfil da prova é um perfil ATIVO desta conta?
  const alvo = ativos.find((p) => p.id === prova.pid);
  if (!alvo) {
    throw ApiError.badRequest("Prova de seleção inválida. Informe o PIN novamente.", { codigo: "PROVA_PERFIL_INVALIDA" });
  }
  // Se o corpo também mandou perfilId, ele TEM de bater com a prova (ponto 3/23).
  if (perfilId != null && perfilId !== "" && String(perfilId) !== prova.pid) {
    throw ApiError.badRequest(
      "O perfil informado não corresponde à prova de PIN. Informe o PIN novamente.",
      { codigo: "PROVA_PERFIL_DIVERGENTE" },
    );
  }
  return { id: alvo.id, nome: alvo.nome, selecaoNonce: prova.jti };
}
