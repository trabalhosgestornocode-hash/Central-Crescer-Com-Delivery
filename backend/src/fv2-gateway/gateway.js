// GATEWAY DE AUTORIDADE do Financeiro v2 (Execução 10) — serviço SEPARADO do backend comum.
//
// Único processo com a credencial `fv2_autoridade` (pool `poolAutoridade`). Emite sessões de banco curtas
// (`fv2_abrir_sessao`) e sessões de provisionamento (`fv2_abrir_sessao_de_provisionamento`) SOMENTE quando:
//   1. o pedido veio pelo canal assinado do backend (HMAC, janela de 60 s, nonce único) — canalGateway.js;
//   2. o token de acesso do PRÓPRIO usuário é válido no provedor de identidade e pertence à conta da sessão;
//   3. a política do gateway aceita (politicaDoGateway.js: impersonação, perfil de exibição, conta compartilhada,
//      escopo = o da sessão, validade curta) — finalidades sensíveis exigem prova de segundo fator RECENTE;
//   4. o banco aceita (concessão ativa, escopo existente) — a regra final é a do banco.
// Registros saem sem token, senha ou chave (eventoSemSegredos). Nada aqui lê dados financeiros.
import { FINALIDADE_DO_GATEWAY as FINALIDADE, decidirEmissao, eventoSemSegredos } from "../modules/financeiro-v2/index.js";
import { CABECALHO, conferirPedido, exigirChaveDoCanal } from "../modules/fv2-integracao/canalGateway.js";
import { criarEmissorDeSessoes } from "../modules/fv2-integracao/emissorDeSessoes.js";

const LIMITE_CORPO = 32 * 1024;
const SENSIVEIS = new Set([FINALIDADE.ACAO_SENSIVEL, FINALIDADE.PROVISIONAMENTO, FINALIDADE.LIBERACAO]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} p
 * @param {{query:Function}} p.poolAutoridade pool com a credencial da autoridade (papel de login membro de fv2_autoridade)
 * @param {string} p.chave chave do canal backend ⇄ gateway
 * @param {(token:string)=>Promise<{id:string}|null>} p.obterUsuario validação do token no provedor de identidade
 * @param {{provar:Function}} p.mfa verificador de segundo fator (mfaPeloProvedor.js)
 * @param {() => Date} [p.relogio]
 * @param {(evento:object)=>void} [p.registrar] destino dos eventos (já sem segredos)
 */
export function criarGateway({ poolAutoridade, chave, obterUsuario, mfa, relogio = () => new Date(), registrar = () => {} }) {
  exigirChaveDoCanal(chave);
  if (typeof poolAutoridade?.query !== "function" || typeof obterUsuario !== "function" || typeof mfa?.provar !== "function") {
    throw new Error("Financeiro v2: gateway sem pool da autoridade, validação do provedor ou verificador de MFA.");
  }
  const noncesVistos = new Map();
  const log = (evento) => { try { registrar(eventoSemSegredos({ em: relogio().toISOString(), ...evento })); } catch { /* registro nunca derruba o gateway */ } };
  const responder = (res, status, corpo) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(corpo)); };
  // O código do banco (ex.: FV020 = sem concessão ativa) volta ao backend para o repositório traduzir como no acesso direto.
  const recusar = (res, status, motivo, extra = {}) => { log({ tipo: "RECUSA", motivo, ...extra }); responder(res, status, { motivo, mensagem: "Pedido recusado pela autoridade financeira.", ...(extra.codigoBanco ? { codigoBanco: extra.codigoBanco } : {}) }); };

  async function lerCorpo(req) {
    let tamanho = 0;
    const partes = [];
    for await (const parte of req) {
      tamanho += parte.length;
      if (tamanho > LIMITE_CORPO) throw new Error("corpo grande demais");
      partes.push(parte);
    }
    return Buffer.concat(partes).toString("utf8");
  }

  /** Identidade conferida no provedor + coerência com a sessão declarada. */
  async function conferirIdentidade(token, sessao) {
    if (!token) return { ok: false, motivo: "SEM_TOKEN_DO_USUARIO" };
    let usuario = null;
    try { usuario = await obterUsuario(token); } catch { usuario = null; }
    if (!usuario?.id) return { ok: false, motivo: "TOKEN_DO_USUARIO_INVALIDO" };
    if (String(usuario.id).toLowerCase() !== String(sessao?.user?.id ?? "").toLowerCase()) return { ok: false, motivo: "TOKEN_DE_OUTRA_CONTA" };
    return { ok: true, contaId: String(usuario.id).toLowerCase() };
  }

  // A regra de emissão é a MESMA do modo co-localizado (emissorDeSessoes.js); aqui só muda o transporte (canal assinado).
  const emissor = criarEmissorDeSessoes({ poolAutoridade, obterUsuario, mfa, relogio, registrar });
  async function sessoes(corpo, token, res) {
    const { sessao, escopo, contaPessoal, finalidade } = corpo;
    const r = await emissor.emitirSessao({ sessao, escopo, contaPessoal, finalidade, token });
    if (!r.ok) return responder(res, r.status, { motivo: r.motivo, mensagem: "Pedido recusado pela autoridade financeira.", ...(r.codigoBanco ? { codigoBanco: r.codigoBanco } : {}) });
    return responder(res, 200, { token: r.token, validadeSegundos: r.validadeSegundos });
  }

  async function provisionamentos(corpo, token, res) {
    const { sessao, ato } = corpo;
    const id = await conferirIdentidade(token, sessao);
    if (!id.ok) return recusar(res, 401, id.motivo);
    const prova = await mfa.provar({ tokenDeAcesso: token, contaId: id.contaId }).catch(() => ({ ok: false }));
    if (!prova?.ok) return recusar(res, 403, prova?.motivo ?? "SEM_PROVA_DE_SEGUNDO_FATOR", { finalidade: "PROVISIONAMENTO" });
    if (!ato || !uuid.test(String(ato.atestanteId)) || String(ato.atestanteId).toLowerCase() !== id.contaId) return recusar(res, 403, "ATESTANTE_DIFERENTE_DO_TOKEN");
    if (String(ato.organizacaoId).toLowerCase() !== String(sessao?.tenant?.organizacaoId ?? "").toLowerCase()) return recusar(res, 403, "ESCOPO_DIFERENTE_DA_SESSAO");
    try {
      const { rows } = await poolAutoridade.query(
        "select fv2_abrir_sessao_de_provisionamento($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::text, $7::text, $8::text) as t",
        [ato.atestanteId, ato.usuarioId, ato.organizacaoId, ato.unidadeId, JSON.stringify(ato.acoes ?? []), "aal2", ato.justificativa, ato.evidencia],
      );
      log({ tipo: "PROVISIONAMENTO_EMITIDO", organizacaoId: ato.organizacaoId, unidadeId: ato.unidadeId, pessoa: ato.usuarioId, atestante: id.contaId });
      return responder(res, 200, { token: rows[0].t });
    } catch (e) {
      return recusar(res, 403, "BANCO_RECUSOU", { codigoBanco: e?.code ?? null });
    }
  }

  /** Manipulador HTTP (node:http). */
  return async function manipular(req, res) {
    try {
      const caminho = new URL(req.url, "http://gateway").pathname;
      if (req.method === "GET" && caminho === "/saude") return responder(res, 200, { ok: true });
      if (req.method !== "POST" || !["/v1/sessoes", "/v1/provisionamentos"].includes(caminho)) return responder(res, 404, { motivo: "NAO_ENCONTRADO" });
      let corpoTexto;
      try { corpoTexto = await lerCorpo(req); } catch { return recusar(res, 413, "CORPO_GRANDE_DEMAIS"); }
      const canal = conferirPedido({ chave, metodo: "POST", caminho, corpo: corpoTexto, cabecalhos: req.headers, agoraMs: relogio().getTime(), noncesVistos });
      if (!canal.ok) return recusar(res, 401, canal.motivo);
      let corpo;
      try { corpo = JSON.parse(corpoTexto); } catch { return recusar(res, 400, "CORPO_INVALIDO"); }
      const token = String(req.headers[CABECALHO.TOKEN] ?? "");
      return caminho === "/v1/sessoes" ? await sessoes(corpo, token, res) : await provisionamentos(corpo, token, res);
    } catch {
      return responder(res, 500, { motivo: "FALHA_DO_GATEWAY" });
    }
  };
}
