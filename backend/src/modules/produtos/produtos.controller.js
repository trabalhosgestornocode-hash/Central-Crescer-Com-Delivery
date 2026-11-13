import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./produtos.service.js";

export const pendenciasCatalogo = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarPendenciasCatalogo({ organizacaoId: req.tenant.organizacaoId }) });
});

export const fichasCatalogo = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarFichasCatalogo({ organizacaoId: req.tenant.organizacaoId }) });
});

export const homologarLote = asyncHandler(async (req, res) => {
  const data = await service.homologarLote({ organizacaoId: req.tenant.organizacaoId, ids: req.body?.ids, usuario: identidadeOperacional(req) });
  res.json({ data });
});

export const conferirPendenciasCarga = asyncHandler(async (req, res) => {
  const data = await service.conferirPendenciasDaCarga({ organizacaoId: req.tenant.organizacaoId, produtoId: req.params.id, usuario: identidadeOperacional(req) });
  res.json({ data });
});

export const homologacao = asyncHandler(async (req, res) => {
  const data = await service.definirHomologacao({
    organizacaoId: req.tenant.organizacaoId, produtoId: req.params.id, acao: req.body?.acao,
    usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

export const listar = asyncHandler(async (req, res) => {
  const { vendavel, tipo } = req.query;
  const data = await service.listarProdutos({
    organizacaoId: req.tenant.organizacaoId,
    vendavel: vendavel === undefined ? undefined : vendavel === "true",
    tipo,
  });
  res.json({ data });
});

export const obter = asyncHandler(async (req, res) => {
  const data = await service.obterProduto({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
  });
  res.json({ data });
});

export const atualizar = asyncHandler(async (req, res) => {
  const data = await service.atualizarProduto({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
    dados: req.body ?? {},
    usuario: identidadeOperacional(req), // { id: conta, nome: PESSOA, email: conta } — snapshot "por Fulano"
  });
  res.json({ data });
});

export const historico = asyncHandler(async (req, res) => {
  const data = await service.listarHistoricoProduto({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
  });
  res.json({ data });
});

export const historicoRecente = asyncHandler(async (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 8, 1), 30);
  const data = await service.listarHistoricoRecente({
    organizacaoId: req.tenant.organizacaoId,
    limite,
  });
  res.json({ data });
});

export const remover = asyncHandler(async (req, res) => {
  const data = await service.excluirProduto({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
  });
  res.json({ data });
});

// ---------- Ficha técnica editável ----------
export const adicionarComponente = asyncHandler(async (req, res) => {
  const data = await service.adicionarComponente({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
    dados: req.body ?? {},
    usuario: identidadeOperacional(req),
  });
  res.status(201).json({ data });
});

export const atualizarComponente = asyncHandler(async (req, res) => {
  const data = await service.atualizarComponente({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
    fichaId: req.params.fichaId,
    dados: req.body ?? {},
  });
  res.json({ data });
});

export const removerComponente = asyncHandler(async (req, res) => {
  const data = await service.removerComponente({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
    fichaId: req.params.fichaId,
  });
  res.json({ data });
});
