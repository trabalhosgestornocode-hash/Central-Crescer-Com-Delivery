// ROTAS do Centro Financeiro para o MOVA (Execução 03). Montadas em rotas.js DEPOIS de `comIdentidade` + `preparar`, ou seja,
// com o CONTEXTO VERIFICADO da sessão da plataforma (organização, unidade e permissões da concessão gravada). Nada aqui confia em
// permissão vinda do navegador: cada handler confere `ctx.permissoes` e o escopo é SEMPRE a unidade da sessão.
//
//   GET  /api/mova/caixa                 Caixa de Entrada (financeiro_v2.ver)
//   GET  /api/mova/proposta?id=          detalhe da proposta + aprovações (ver)
//   GET  /api/mova/documento?evento=     item da mensagem/documento (metadados; o arquivo não é servido aqui) (ver)
//   GET  /api/mova/historico             decisões do agente na unidade (ver)
//   GET  /api/mova/estado                fila, respostas, worker e chaves (ver)
//   GET  /api/mova/erros                 eventos que falharam (só código e tentativas) (ver)
//   POST /acoes/mova/classificar         revisar categoria (aprovar)
//   POST /acoes/mova/aplicar             aprovar e aplicar pelo Financeiro (aprovar + aplicar + registrar; unidade com escrita liberada)
//   POST /acoes/mova/rejeitar            rejeitar (aprovar)
//   POST /acoes/mova/reprocessar         devolver evento com falha à fila (aprovar)
import { ACAO } from "../financeiro-v2/index.js";
import { ErroDeAprovacao } from "../mova-financeiro/index.js";

const recusa = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { codigoHttp: status, codigo });
const STATUS = { PERMISSAO_INSUFICIENTE: 403, PROPOSTA_NAO_ENCONTRADA: 404, PROPOSTA_JA_DECIDIDA_OU_INEXISTENTE: 409, CATEGORIA_INVALIDA: 400, VERSAO_OBRIGATORIA: 400, CONTA_OBRIGATORIA: 400 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escopo = (ctx) => ({ organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId });

function exigirVer(ctx) {
  if (!ctx?.permissoes?.includes(ACAO.VER)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Permissão financeira insuficiente.");
}
const traduzir = (e) => {
  if (e instanceof ErroDeAprovacao) return recusa(STATUS[e.codigo] ?? 409, e.codigo, "A proposta não pôde ser processada.");
  return e;
};

export const CONSULTAS_MOVA = Object.freeze({
  "/mova/caixa": async ({ ctx, mova }) => { exigirVer(ctx); return mova.consultas.caixaDeEntrada(escopo(ctx)); },
  "/mova/proposta": async ({ ctx, mova, params }) => {
    exigirVer(ctx);
    if (!UUID.test(params.id ?? "")) throw recusa(400, "PARAMETRO_INVALIDO", "Proposta inválida.");
    const p = await mova.consultas.proposta({ ...escopo(ctx), id: params.id.toLowerCase() });
    if (!p) throw recusa(404, "PROPOSTA_NAO_ENCONTRADA", "Proposta não encontrada nesta unidade.");
    return p;
  },
  "/mova/documento": async ({ ctx, mova, params }) => {
    exigirVer(ctx);
    const d = typeof params.evento === "string" && /^[A-Za-z0-9_.:@-]{1,160}$/.test(params.evento) ? await mova.consultas.documento({ ...escopo(ctx), eventoId: params.evento }) : null;
    if (!d) throw recusa(404, "DOCUMENTO_NAO_ENCONTRADO", "Mensagem não encontrada nesta unidade.");
    return d;
  },
  "/mova/historico": async ({ ctx, mova }) => { exigirVer(ctx); return { itens: await mova.consultas.historico(escopo(ctx)) }; },
  "/mova/estado": async ({ ctx, mova, worker, enviador, chaves }) => {
    exigirVer(ctx);
    return { fila: await mova.fila.estatisticas(), respostas: await mova.armazenamento.saida.contagem(), worker: worker?.estado() ?? null, envioHabilitado: Boolean(enviador?.habilitado), chaves };
  },
  "/mova/erros": async ({ ctx, mova }) => { exigirVer(ctx); return { itens: await mova.fila.falhas(50) }; },
});

export const ACOES_MOVA = Object.freeze({
  "/mova/classificar": { campos: ["propostaId", "versao", "categoria"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.revisarClassificacao(ctx, { propostaId: b.propostaId, versao: b.versao, categoria: b.categoria }) },
  "/mova/aplicar": { campos: ["propostaId", "contaId", "categoria"], escreveNoFinanceiro: true,
    fazer: ({ ctx, mova, nucleo, b }) => mova.aprovador.aplicar(ctx, { propostaId: b.propostaId, contaId: b.contaId ?? null, categoria: b.categoria ?? null }, { nucleo }) },
  "/mova/rejeitar": { campos: ["propostaId", "motivo"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.rejeitar(ctx, { propostaId: b.propostaId, motivo: b.motivo }) },
  "/mova/reprocessar": { campos: ["eventoId"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.reprocessar(ctx, { eventoId: b.eventoId }) },
});

/** Executa uma ação já com contexto verificado; erros do aprovador viram HTTP fechados. */
export async function executarAcaoMova(acao, deps) {
  try { return await acao.fazer(deps); } catch (e) { throw traduzir(e); }
}
