import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./cmv.service.js";
import { condicoesComerciais, salvarCondicao as salvar, historicoCondicoes } from "./cmv.condicoes.js";
import { identidadeOperacional } from "../../shared/identidade.js";

export const condicoes = asyncHandler(async (req, res) => {
  res.json({ data: await condicoesComerciais({ organizacaoId: req.tenant.organizacaoId }) });
});

export const salvarCondicao = asyncHandler(async (req, res) => {
  res.json({ data: await salvar({ organizacaoId: req.tenant.organizacaoId, body: req.body, usuario: identidadeOperacional(req) }) });
});

export const condicoesHistorico = asyncHandler(async (req, res) => {
  res.json({ data: await historicoCondicoes({ organizacaoId: req.tenant.organizacaoId, limite: req.query.limite }) });
});

// `comparar=true` é o único jeito de sair da tabela oficial: sem ele, `tabela`
// na query é ignorada de propósito (evita que um link/bookmark antigo com
// ?tabela=A continue driblando a tabela oficial da unidade em silêncio).
export const listar = asyncHandler(async (req, res) => {
  const { canal, tabela, comparar } = req.query;
  const resultado = await service.listarMargensOficialOuComparacao({
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: req.tenant.unidadeId,
    canal,
    tabelaComparacao: comparar === "true" ? tabela : undefined,
  });
  res.json(resultado);
});

export const porProduto = asyncHandler(async (req, res) => {
  const data = await service.margemProduto({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
  });
  res.json({ data });
});
