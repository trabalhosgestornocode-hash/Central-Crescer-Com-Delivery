// MOVA CORE — F2: IDENTIDADE E VÍNCULO participante do WhatsApp ↔ usuário da plataforma.
//
// Regras (nenhuma é decidida pelo modelo — o SERVIDOR é a autoridade de identidade e autorização):
// - IDENTIDADE CANÔNICA do participante = a ENTRADA da lista de autorizados da configuração do MOVA (a entrada reúne os JIDs
//   daquela pessoa: LID no grupo, número no privado). Nunca nome, telefone digitado no texto ou reconhecimento probabilístico.
// - O VÍNCULO com um usuário (perfil operacional da plataforma, numa organização) nasce de UM de dois processos:
//     (a) CÓDIGO AUTENTICADO: o próprio usuário, logado na plataforma, gera um código de uso único (6 dígitos, 10 min) e o
//         envia ao MOVA pela conversa PRIVADA do WhatsApp cujo JID está na entrada — prova o controle das duas pontas;
//     (b) APROVAÇÃO de administrador com `usuarios.gerenciar` na organização, para uma entrada da lista daquela organização.
// - Cada requisição RESOLVE de novo: entrada → vínculo ATIVO → perfil/empresa/unidade/papel/permissões/módulos lidos da
//   plataforma AGORA (mesmo cálculo do contexto do navegador). Revogação, perfil desativado, empresa bloqueada ou papel
//   alterado valem na mensagem seguinte. Sem vínculo, a pessoa continua com o que a lista do MOVA já lhe dá — nada a mais.
// - Perfil de EXIBIÇÃO (TV/checklist) e impersonação NUNCA são vinculáveis.
// - O código nunca é guardado nem registrado em claro (só o hash com sal); tentativas são limitadas por participante.
// - Tudo é auditado (solicitação, vínculo, recusa, revogação), sem dado pessoal além de identificadores mascarados.
import { createHash, randomInt, randomUUID } from "node:crypto";

export const ESTADO_VINCULO = Object.freeze({ ATIVO: "ATIVO", REVOGADO: "REVOGADO" });
export const METODO_VINCULO = Object.freeze({ CODIGO: "CODIGO_AUTENTICADO", ADMIN: "APROVACAO_ADMIN" });
export const LIMITES_IDENTIDADE = Object.freeze({ codigoMs: 10 * 60 * 1000, tentativasPorHora: 5, digitos: 6 });
const PAPEL_EXIBICAO = "exibicao";
const PERMISSAO_ADMIN = "usuarios.gerenciar";
const COMANDO_VINCULAR = /^\s*(?:mova[\s,:]+)?vincular\s+(\d{6})\s*$/i;

const mascarar = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-3)}` : null);
const hashCodigo = (codigo, sal) => createHash("sha256").update(`${sal}:${codigo}`).digest("hex");

/** Chave canônica estável de uma entrada da lista: o `pessoaId` explícito, senão o hash dos JIDs ordenados. */
export function chaveCanonica(entrada, organizacaoId) {
  if (!entrada) return null;
  if (entrada.pessoaId) return `pessoa:${organizacaoId}:${entrada.pessoaId}`;
  const ids = [...new Set([...(entrada.ids ?? []), ...(entrada.privado ? [entrada.privado] : [])])].sort();
  if (!ids.length) return null;
  return `lista:${organizacaoId}:${createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 24)}`;
}

/** Repositório em memória (ambiente isolado e testes). Em produção: tabelas mova_core.vinculo / desafio (migração NÃO aplicada). */
export function criarRepositorioDeIdentidadeMemoria() {
  const vinculos = new Map(); const desafios = new Map(); const tentativas = new Map();
  return Object.freeze({
    async vinculoAtivo(chave) { return [...vinculos.values()].find((v) => v.chave === chave && v.estado === ESTADO_VINCULO.ATIVO) ?? null; },
    async criarVinculo(v) {
      if ([...vinculos.values()].some((x) => x.chave === v.chave && x.estado === ESTADO_VINCULO.ATIVO)) throw Object.assign(new Error("já vinculado"), { codigo: "JA_VINCULADO" });
      vinculos.set(v.id, { ...v }); return { ...v };
    },
    async revogar(id, dados) { const v = vinculos.get(id); if (!v || v.estado !== ESTADO_VINCULO.ATIVO) return null; Object.assign(v, { estado: ESTADO_VINCULO.REVOGADO, ...dados }); return { ...v }; },
    async obterVinculo(id) { const v = vinculos.get(id); return v ? { ...v } : null; },
    async guardarDesafio(d) { for (const [k, x] of desafios) if (x.perfilId === d.perfilId && x.organizacaoId === d.organizacaoId) desafios.delete(k); desafios.set(d.id, { ...d }); },
    /** Consome ATOMICAMENTE (uso único) o desafio da organização com este hash. */
    async consumirDesafio({ organizacaoId, id }) {
      const d = desafios.get(id);
      if (!d || d.organizacaoId !== organizacaoId) return null;
      desafios.delete(id); return d;
    },
    async desafiosDaOrganizacao(organizacaoId) { return [...desafios.values()].filter((d) => d.organizacaoId === organizacaoId); },
    async registrarTentativa(chave, agora) { const xs = (tentativas.get(chave) ?? []).filter((t) => agora - t < 3_600_000); xs.push(agora); tentativas.set(chave, xs); return xs.length; },
  });
}

/**
 * @param {object} deps
 * @param {(c:{grupoId:string, participanteId:string}) => ({entrada:object, organizacaoId:string, privado:boolean, unidades:string[]}|null)} deps.identificarParticipante
 *        reconhecimento pela LISTA do MOVA (servidor): a entrada que contém este JID nesta conversa
 * @param {object} deps.plataforma { acessoDoPerfil({perfilId, organizacaoId, unidadeId}) → {contaId, perfilId, papel, permissoes, modulos, unidades, ativo}|null }
 *        — o mesmo cálculo do contexto do navegador (vínculo do perfil com a empresa, unidade, permissões do papel, módulos efetivos)
 */
export function criarServicoDeIdentidade({ identificarParticipante, plataforma, repositorio = criarRepositorioDeIdentidadeMemoria(), auditoria = { registrar() {} }, aoRevogar = null, relogio = () => Date.now(), limites = LIMITES_IDENTIDADE, gerarCodigo = () => String(randomInt(0, 10 ** limites.digitos)).padStart(limites.digitos, "0") }) {
  if (typeof identificarParticipante !== "function" || typeof plataforma?.acessoDoPerfil !== "function") throw new TypeError("identidade exige o reconhecimento pela lista e a porta da plataforma");
  const auditar = (acao, dados) => auditoria.registrar({ tipo: "MOVA_CORE_IDENTIDADE", acao, em: new Date(relogio()).toISOString(), ...dados });

  async function perfilVinculavel({ perfilId, organizacaoId }) {
    const a = await plataforma.acessoDoPerfil({ perfilId, organizacaoId, unidadeId: null });
    if (!a || a.ativo === false) return { ok: false, motivo: "PERFIL_SEM_ACESSO_A_EMPRESA" };
    if (a.papel === PAPEL_EXIBICAO) return { ok: false, motivo: "PERFIL_DE_EXIBICAO_NAO_VINCULA" };
    if (a.impersonando) return { ok: false, motivo: "IMPERSONACAO_NAO_VINCULA" };
    return { ok: true, acesso: a };
  }

  return Object.freeze({
    /**
     * (a) passo 1 — chamado por rota AUTENTICADA da plataforma (req.user + req.acesso do PRÓPRIO usuário, nunca do corpo).
     * Devolve o código para a tela; não é registrado em lugar nenhum.
     */
    async solicitarCodigo({ contaId, perfilId, organizacaoId, impersonando = false }) {
      if (impersonando) return { ok: false, motivo: "IMPERSONACAO_NAO_VINCULA" };
      const p = await perfilVinculavel({ perfilId, organizacaoId });
      if (!p.ok) { auditar("CODIGO_RECUSADO", { perfil: mascarar(perfilId), motivo: p.motivo }); return p; }
      if (p.acesso.contaId && contaId && p.acesso.contaId !== contaId) return { ok: false, motivo: "PERFIL_DE_OUTRA_CONTA" };
      const codigo = gerarCodigo(); const sal = randomUUID();
      const expiraEm = relogio() + limites.codigoMs;
      await repositorio.guardarDesafio({ id: randomUUID(), organizacaoId, perfilId, contaId: p.acesso.contaId ?? contaId, sal, codigoHash: hashCodigo(codigo, sal), criadoEm: relogio(), expiraEm });
      auditar("CODIGO_GERADO", { perfil: mascarar(perfilId), organizacaoId, expiraEm: new Date(expiraEm).toISOString() });
      return { ok: true, codigo, expiraEm: new Date(expiraEm).toISOString(), instrucao: `No WhatsApp, na conversa PRIVADA com o MOVA, envie: vincular ${codigo}` };
    },

    /** É uma mensagem de vínculo? (o roteador desvia antes do modelo: o código nunca vai para a IA) */
    ehComandoDeVinculo(texto) { return COMANDO_VINCULAR.test(String(texto ?? "")); },

    /** (a) passo 2 — mensagem "vincular 123456" recebida pelo MOVA. Só na conversa PRIVADA, de JID da lista. */
    async confirmarCodigo({ grupoId, participanteId, texto }) {
      const m = COMANDO_VINCULAR.exec(String(texto ?? ""));
      if (!m) return { ok: false, motivo: "NAO_E_CODIGO" };
      const quem = identificarParticipante({ grupoId, participanteId });
      if (!quem) { auditar("VINCULO_RECUSADO", { participante: mascarar(participanteId), motivo: "FORA_DA_LISTA" }); return { ok: false, motivo: "FORA_DA_LISTA" }; }
      if (!quem.privado) return { ok: false, motivo: "SO_NA_CONVERSA_PRIVADA" };
      const chave = chaveCanonica(quem.entrada, quem.organizacaoId);
      const n = await repositorio.registrarTentativa(chave, relogio());
      if (n > limites.tentativasPorHora) { auditar("VINCULO_RECUSADO", { chave: mascarar(chave), motivo: "TENTATIVAS_EXCEDIDAS" }); return { ok: false, motivo: "TENTATIVAS_EXCEDIDAS" }; }
      // o hash depende do sal de cada desafio: confere contra os desafios VIGENTES desta organização
      const candidatos = await repositorio.desafiosDaOrganizacao(quem.organizacaoId);
      const alvo = candidatos.find((d) => hashCodigo(m[1], d.sal) === d.codigoHash) ?? null;
      if (!alvo) { auditar("VINCULO_RECUSADO", { chave: mascarar(chave), motivo: "CODIGO_INVALIDO" }); return { ok: false, motivo: "CODIGO_INVALIDO" }; }
      const d = await repositorio.consumirDesafio({ organizacaoId: quem.organizacaoId, id: alvo.id, agora: relogio() });
      if (!d) return { ok: false, motivo: "CODIGO_INVALIDO" }; // outro uso chegou antes (uso único)
      if (relogio() > d.expiraEm) { auditar("VINCULO_RECUSADO", { chave: mascarar(chave), motivo: "CODIGO_EXPIRADO" }); return { ok: false, motivo: "CODIGO_EXPIRADO" }; }
      const p = await perfilVinculavel({ perfilId: d.perfilId, organizacaoId: d.organizacaoId }); // revalida no momento do vínculo
      if (!p.ok) return p;
      try {
        const v = await repositorio.criarVinculo({ id: randomUUID(), chave, organizacaoId: d.organizacaoId, perfilId: d.perfilId, contaId: d.contaId, metodo: METODO_VINCULO.CODIGO, estado: ESTADO_VINCULO.ATIVO, criadoPor: d.contaId, criadoEm: new Date(relogio()).toISOString() });
        auditar("VINCULO_CRIADO", { vinculoId: v.id, chave: mascarar(chave), perfil: mascarar(d.perfilId), metodo: v.metodo });
        return { ok: true, vinculoId: v.id };
      } catch (e) { if (e.codigo === "JA_VINCULADO") return { ok: false, motivo: "JA_VINCULADO" }; throw e; }
    },

    /** (b) aprovação por administrador (rota autenticada; `acessoDoAdmin` é o req.acesso da sessão dele). */
    async aprovarPorAdmin({ acessoDoAdmin, adminContaId, organizacaoId, entrada, perfilId }) {
      if (!acessoDoAdmin || acessoDoAdmin.impersonando || acessoDoAdmin.empresa?.id !== organizacaoId || !(acessoDoAdmin.permissoes ?? []).includes(PERMISSAO_ADMIN)) return { ok: false, motivo: "SEM_PERMISSAO_DE_ADMINISTRAR_VINCULOS" };
      const chave = chaveCanonica(entrada, organizacaoId);
      if (!chave) return { ok: false, motivo: "ENTRADA_INVALIDA" };
      const p = await perfilVinculavel({ perfilId, organizacaoId });
      if (!p.ok) return p;
      try {
        const v = await repositorio.criarVinculo({ id: randomUUID(), chave, organizacaoId, perfilId, contaId: p.acesso.contaId ?? null, metodo: METODO_VINCULO.ADMIN, estado: ESTADO_VINCULO.ATIVO, criadoPor: adminContaId, criadoEm: new Date(relogio()).toISOString() });
        auditar("VINCULO_CRIADO", { vinculoId: v.id, chave: mascarar(chave), perfil: mascarar(perfilId), metodo: v.metodo, por: mascarar(adminContaId) });
        return { ok: true, vinculoId: v.id };
      } catch (e) { if (e.codigo === "JA_VINCULADO") return { ok: false, motivo: "JA_VINCULADO" }; throw e; }
    },

    async revogar({ vinculoId, por, motivo = "REVOGADO" }) {
      const v = await repositorio.revogar(vinculoId, { revogadoPor: por, revogadoEm: new Date(relogio()).toISOString(), motivoRevogacao: motivo });
      if (v) {
        auditar("VINCULO_REVOGADO", { vinculoId, por: mascarar(por), motivo });
        // efeito imediato também na memória: fatos obtidos com o acesso da plataforma não sobrevivem à revogação
        try { await aoRevogar?.(v); } catch { auditar("VINCULO_REVOGADO_SEM_LIMPAR_MEMORIA", { vinculoId }); }
      }
      return { ok: Boolean(v) };
    },

    /**
     * Resolução POR REQUISIÇÃO (sem cache): quem é esta pessoa na plataforma, AGORA, nesta unidade.
     * @returns {Promise<{vinculado:boolean, motivo?:string, usuario?:{contaId, perfilId, papel, permissoes, modulos, unidades}, chave?:string}>}
     */
    async resolver({ grupoId, participanteId, unidadeId = null }) {
      const quem = identificarParticipante({ grupoId, participanteId });
      if (!quem) return { vinculado: false, motivo: "FORA_DA_LISTA" };
      const chave = chaveCanonica(quem.entrada, quem.organizacaoId);
      const v = await repositorio.vinculoAtivo(chave);
      if (!v) return { vinculado: false, motivo: "SEM_VINCULO", chave };
      if (v.organizacaoId !== quem.organizacaoId) return { vinculado: false, motivo: "VINCULO_DE_OUTRA_ORGANIZACAO", chave };
      const a = await plataforma.acessoDoPerfil({ perfilId: v.perfilId, organizacaoId: v.organizacaoId, unidadeId });
      if (!a || a.ativo === false) return { vinculado: false, motivo: "PERFIL_SEM_ACESSO_AGORA", chave };
      if (a.papel === PAPEL_EXIBICAO || a.impersonando) return { vinculado: false, motivo: "PERFIL_DE_EXIBICAO_NAO_VINCULA", chave };
      return { vinculado: true, chave, vinculoId: v.id, usuario: { contaId: a.contaId ?? v.contaId, perfilId: v.perfilId, papel: a.papel, permissoes: [...(a.permissoes ?? [])], modulos: [...(a.modulos ?? [])], unidades: [...(a.unidades ?? [])] } };
    },
  });
}

/**
 * `acesso` no formato do Agente Crescer (agenteAcesso.js) a partir de uma identidade resolvida AGORA — nunca impersonação.
 * Só para a unidade pedida e se o perfil alcança essa unidade.
 */
export function acessoDaPlataforma(resolucao, { organizacaoId, unidadeId }) {
  if (!resolucao?.vinculado) return null;
  const u = resolucao.usuario;
  if (unidadeId && u.unidades.length && !u.unidades.includes(unidadeId)) return null;
  return Object.freeze({ sessionId: `mova:${resolucao.vinculoId}`, perfilId: u.perfilId, papel: u.papel, permissoes: Object.freeze([...u.permissoes]), modulos: Object.freeze([...u.modulos]),
    impersonadoPor: null, impersonando: false, empresa: { id: organizacaoId }, unidade: unidadeId ? { id: unidadeId } : null });
}
