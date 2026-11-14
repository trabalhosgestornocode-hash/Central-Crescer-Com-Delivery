// EMISSOR DE SESSÕES DE BANCO do Financeiro v2 (Execução 10) — a regra da AUTORIDADE, independente de onde ela roda:
//   - no GATEWAY separado (serviço próprio, atrás do canal assinado), ou
//   - CO-LOCALIZADO no backend da plataforma (autoridadeCoLocalizada.js), por decisão do proprietário (um só serviço).
// Em ambos: o token do usuário é validado NO PROVEDOR e tem de ser da conta da sessão; a política (impersonação, perfil
// de exibição, conta compartilhada, escopo = o da sessão, validade curta) decide; finalidades sensíveis exigem 2º fator
// recente; o BANCO confere a concessão (FV020) ao abrir a sessão.
import { FINALIDADE_DO_GATEWAY as FINALIDADE, decidirEmissao, eventoSemSegredos } from "../financeiro-v2/index.js";

const SENSIVEIS = new Set([FINALIDADE.ACAO_SENSIVEL, FINALIDADE.PROVISIONAMENTO, FINALIDADE.LIBERACAO]);

/**
 * @param {{poolAutoridade:{query:Function}, obterUsuario:(t:string)=>Promise<{id:string}|null>, mfa:{provar:Function}, relogio?:()=>Date, registrar?:(e:object)=>void}} p
 */
export function criarEmissorDeSessoes({ poolAutoridade, obterUsuario, mfa, relogio = () => new Date(), registrar = () => {} }) {
  if (typeof poolAutoridade?.query !== "function" || typeof obterUsuario !== "function" || typeof mfa?.provar !== "function") {
    throw new Error("Financeiro v2: autoridade sem pool próprio, validação do provedor ou verificador de MFA.");
  }
  const log = (evento) => { try { registrar(eventoSemSegredos({ em: relogio().toISOString(), ...evento })); } catch { /* registro nunca derruba a autoridade */ } };
  const recusa = (status, motivo, extra = {}) => { log({ tipo: "RECUSA", motivo, ...extra }); return { ok: false, status, motivo, ...(extra.codigoBanco ? { codigoBanco: extra.codigoBanco } : {}) }; };

  async function conferirIdentidade(token, sessao) {
    if (!token) return { ok: false, motivo: "SEM_TOKEN_DO_USUARIO" };
    let usuario = null;
    try { usuario = await obterUsuario(token); } catch { usuario = null; }
    if (!usuario?.id) return { ok: false, motivo: "TOKEN_DO_USUARIO_INVALIDO" };
    if (String(usuario.id).toLowerCase() !== String(sessao?.user?.id ?? "").toLowerCase()) return { ok: false, motivo: "TOKEN_DE_OUTRA_CONTA" };
    return { ok: true, contaId: String(usuario.id).toLowerCase() };
  }

  return Object.freeze({
    /** @returns {Promise<{ok:true, token:string, validadeSegundos:number}|{ok:false, status:number, motivo:string, codigoBanco?:string}>} */
    async emitirSessao({ sessao, escopo, contaPessoal, finalidade, token }) {
      const id = await conferirIdentidade(token, sessao);
      if (!id.ok) return recusa(401, id.motivo);
      const prova = SENSIVEIS.has(finalidade) ? await mfa.provar({ tokenDeAcesso: token, contaId: id.contaId }).catch(() => ({ ok: false })) : null;
      // A concessão VIGENTE é conferida pelo BANCO em fv2_abrir_sessao (a autoridade não lê concessões).
      const d = decidirEmissao({ sessao, pedido: { finalidade, unidadeId: escopo?.unidadeId }, prova, contaPessoal: contaPessoal === true, acoesConcedidas: ["CONFERIDA_PELO_BANCO"], agoraMs: relogio().getTime() });
      if (!d.emitir) return recusa(403, d.motivo, { finalidade });
      if (!escopo || String(escopo.organizacaoId).toLowerCase() !== d.escopo.organizacaoId || String(escopo.unidadeId).toLowerCase() !== d.escopo.unidadeId || String(escopo.usuarioId).toLowerCase() !== d.escopo.usuarioId) {
        return recusa(403, "ESCOPO_DIFERENTE_DA_SESSAO", { finalidade });
      }
      try {
        const { rows } = await poolAutoridade.query("select fv2_abrir_sessao($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as t",
          [d.escopo.usuarioId, d.escopo.organizacaoId, d.escopo.unidadeId, d.validadeSegundos, `autoridade:${finalidade}`]);
        log({ tipo: "SESSAO_EMITIDA", finalidade, organizacaoId: d.escopo.organizacaoId, unidadeId: d.escopo.unidadeId, pessoa: d.escopo.usuarioId, validadeSegundos: d.validadeSegundos, segundoFator: d.exigiuSegundoFator });
        return { ok: true, token: rows[0].t, validadeSegundos: d.validadeSegundos };
      } catch (e) {
        return recusa(403, "BANCO_RECUSOU", { codigoBanco: e?.code ?? null });
      }
    },
    /**
     * Sessão de PROVISIONAMENTO do administrador financeiro inicial: o atestante é a conta do token (validado no
     * provedor), com 2º fator RECENTE comprovado; a empresa é a da sessão; o banco grava e audita.
     */
    async emitirProvisionamento({ sessao, ato, token }) {
      const id = await conferirIdentidade(token, sessao);
      if (!id.ok) return recusa(401, id.motivo);
      const prova = await mfa.provar({ tokenDeAcesso: token, contaId: id.contaId }).catch(() => ({ ok: false }));
      if (!prova?.ok) return recusa(403, prova?.motivo ?? "SEM_PROVA_DE_SEGUNDO_FATOR", { finalidade: "PROVISIONAMENTO" });
      if (!ato || String(ato.atestanteId ?? "").toLowerCase() !== id.contaId) return recusa(403, "ATESTANTE_DIFERENTE_DO_TOKEN");
      if (String(ato.organizacaoId ?? "").toLowerCase() !== String(sessao?.tenant?.organizacaoId ?? "").toLowerCase()
        || String(ato.unidadeId ?? "").toLowerCase() !== String(sessao?.tenant?.unidadeId ?? "").toLowerCase()) return recusa(403, "ESCOPO_DIFERENTE_DA_SESSAO");
      try {
        const { rows } = await poolAutoridade.query(
          "select fv2_abrir_sessao_de_provisionamento($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::text, $7::text, $8::text) as t",
          [ato.atestanteId, ato.usuarioId, ato.organizacaoId, ato.unidadeId, JSON.stringify(ato.acoes ?? []), "aal2", ato.justificativa, ato.evidencia],
        );
        log({ tipo: "PROVISIONAMENTO_EMITIDO", organizacaoId: ato.organizacaoId, unidadeId: ato.unidadeId, pessoa: ato.usuarioId, atestante: id.contaId });
        return { ok: true, token: rows[0].t };
      } catch (e) {
        return recusa(403, "BANCO_RECUSOU", { codigoBanco: e?.code ?? null });
      }
    },
    conferirIdentidade,
    log,
    recusa,
  });
}
