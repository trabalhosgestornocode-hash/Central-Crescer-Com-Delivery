// CLIENTE DO GATEWAY (Execução 10) — implementa a porta `sessoes` do repositório PostgreSQL do Financeiro v2
// ({ emitir, emitirProvisionamento }) PEDINDO as sessões de banco ao gateway separado, pelo canal assinado.
//
// O repositório chama `emitir(escopo)` sem conhecer a requisição HTTP; a identidade de QUEM pede vem do contexto da
// requisição corrente (AsyncLocalStorage), preenchido pelas rotas depois que a plataforma (requireAuth + requireContexto)
// e o adaptador do v2 aceitaram a sessão. Sem esse contexto, nada é pedido (falha fechada).
import { AsyncLocalStorage } from "node:async_hooks";
import { CABECALHO, assinarPedido, exigirChaveDoCanal } from "./canalGateway.js";

const armazenamento = new AsyncLocalStorage();

/**
 * Executa `fn` com a identidade da requisição disponível para o cliente do gateway.
 * @param {{tokenDeAcesso:string, sessao:object, contaPessoal:boolean, finalidade:string}} dados
 */
export const comIdentidadeDaRequisicao = (dados, fn) => armazenamento.run(Object.freeze({ ...dados }), fn);
export const identidadeDaRequisicao = () => armazenamento.getStore() ?? null;

/** Só o necessário da sessão da plataforma (nada de e-mail, nome, permissões antigas ou módulos). */
export function resumoDaSessao({ user, tenant, acesso }) {
  return {
    user: { id: user?.id, ativo: user?.ativo !== false, senhaProvisoria: user?.senhaProvisoria === true },
    tenant: { organizacaoId: tenant?.organizacaoId ?? null, unidadeId: tenant?.unidadeId ?? null },
    acesso: {
      sessionId: acesso?.sessionId ?? null, expiraEm: acesso?.expiraEm ?? null, perfilId: acesso?.perfilId ?? null, papel: acesso?.papel ?? null,
      impersonando: acesso?.impersonando === true, impersonadoPor: acesso?.impersonadoPor ?? null,
      empresa: acesso?.empresa?.id ? { id: acesso.empresa.id } : null, unidade: acesso?.unidade?.id ? { id: acesso.unidade.id } : null,
    },
  };
}

const erroDoGateway = (status, corpo) => Object.assign(new Error(corpo?.mensagem ?? "O gateway do Financeiro v2 recusou o pedido."), {
  code: corpo?.codigoBanco ?? undefined, // ex.: FV020 (sem concessão) — o repositório traduz como no acesso direto
  motivoGateway: corpo?.motivo ?? "GATEWAY_RECUSOU", statusGateway: status,
});

/**
 * @param {{url:string, chave:string, fetch?:typeof fetch, tempoLimiteMs?:number}} p
 */
export function criarClienteDoGateway({ url, chave, fetch: buscar = globalThis.fetch, tempoLimiteMs = 5000 }) {
  exigirChaveDoCanal(chave);
  const base = new URL(url);
  // HTTP só no próprio computador ou na REDE PRIVADA do provedor (serviço privado do Render: nome interno sem ponto,
  // sem URL pública). Qualquer endereço público exige HTTPS. O canal é assinado de qualquer forma.
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  const redePrivada = /^[a-z0-9-]+$/i.test(base.hostname);
  if (base.protocol !== "https:" && !local && !redePrivada) throw new Error("Financeiro v2: gateway público só por HTTPS.");
  async function pedir(caminho, corpoObj) {
    const id = identidadeDaRequisicao();
    if (!id?.tokenDeAcesso || !id?.sessao) throw erroDoGateway(401, { motivo: "SEM_IDENTIDADE_DA_REQUISICAO", mensagem: "Pedido de sessão financeira fora de uma requisição autenticada." });
    const corpo = JSON.stringify({ ...corpoObj, sessao: id.sessao, contaPessoal: id.contaPessoal === true, finalidade: id.finalidade });
    const cab = { "content-type": "application/json", [CABECALHO.TOKEN]: id.tokenDeAcesso, ...assinarPedido({ chave, caminho, corpo }) };
    let r;
    try {
      r = await buscar(new URL(caminho, base), { method: "POST", headers: cab, body: corpo, signal: AbortSignal.timeout(tempoLimiteMs) });
    } catch {
      throw erroDoGateway(503, { motivo: "GATEWAY_INDISPONIVEL", mensagem: "O serviço de autorização financeira não respondeu." });
    }
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || typeof j?.token !== "string") throw erroDoGateway(r.status, j);
    return j.token;
  }
  return Object.freeze({
    emitir: (e) => pedir("/v1/sessoes", { escopo: { organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: e.usuarioId }, permissoes: e.permissoes ?? [] }),
    emitirProvisionamento: (ato) => pedir("/v1/provisionamentos", { ato }),
  });
}
