import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as s from "./produtosCmv.service.js";

// A organização vem SEMPRE do contexto autenticado (req.tenant), nunca do corpo ou da query.
const org = (req) => req.tenant.organizacaoId;
const h = (fn) => asyncHandler(async (req, res) => res.json({ data: await fn(req) }));

export const saude = h((req) => s.saude({ organizacaoId: org(req) }));
export const pendencias = h((req) => s.pendencias({ organizacaoId: org(req) }));
export const mentoria = h((req) => s.indicadoresMentoria({ organizacaoId: org(req) }));
export const previaRendimentos = h((req) => s.previaRendimentos({ organizacaoId: org(req), sobrescritas: req.body?.sobrescritas }));
export const aplicarRendimentos = h((req) => s.aplicarRendimentos({ organizacaoId: org(req), itens: req.body?.itens, usuario: identidadeOperacional(req) }));
export const previaCustoZero = h((req) => s.previaCustoZero({ organizacaoId: org(req), insumoId: req.params.insumoId }));
export const definirCustoZero = h((req) => s.definirCustoZero({ organizacaoId: org(req), insumoId: req.params.insumoId, declarar: req.body?.declarar !== false, motivo: req.body?.motivo, usuario: identidadeOperacional(req) }));
export const validarAproveitamento = h((req) => s.validarAproveitamento({ organizacaoId: org(req), insumoId: req.body?.insumo_id, entrada: req.body?.entrada }));
export const listarRascunhos = h((req) => s.listarRascunhos({ organizacaoId: org(req) }));
export const obterRascunho = h((req) => s.obterRascunho({ organizacaoId: org(req), id: req.params.rid }));
export const salvarRascunho = h((req) => s.salvarRascunho({ organizacaoId: org(req), id: req.params.rid, body: req.body, usuario: identidadeOperacional(req) }));
export const excluirRascunho = h((req) => s.excluirRascunho({ organizacaoId: org(req), id: req.params.rid }));
export const previaHomologacao = h((req) => s.previaHomologacao({ organizacaoId: org(req) }));
export const homologarSelecionadas = h((req) => s.homologarSelecionadas({ organizacaoId: org(req), ids: req.body?.ids, usuario: identidadeOperacional(req) }));
export const recuperarFicha = h((req) => s.recuperarFicha({ organizacaoId: org(req), produtoId: req.params.id }));
export const simular = h((req) => s.simular({ organizacaoId: org(req), produtoId: req.params.id, canal: req.body?.canal, preco: req.body?.preco, metaCmv: req.body?.meta_cmv, margemContribuicaoAlvo: req.body?.margem_contribuicao_alvo }));
export const criarFicha = h((req) => s.criarFicha({ organizacaoId: org(req), body: req.body, usuario: identidadeOperacional(req) }));
export const definirPreco = h((req) => s.definirPrecoOficial({ organizacaoId: org(req), produtoId: req.params.id, body: req.body, usuario: identidadeOperacional(req) }));
