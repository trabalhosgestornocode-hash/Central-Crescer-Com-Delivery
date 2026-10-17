// Rotas do domínio financeiro. O router NÃO decide acesso: recebe `autorizar(acao)` do Agente 1 (gate sem bypass) por
// injeção, e cada rota declara a ação mínima. Contexto (org/unidade/usuário) vem SÓ de req.financeiro/req.user — nunca do corpo.
// Resposta: { data }. Erros: ApiError → errorHandler global.
import { Router } from "express";
import { asyncHandler } from "../../../shared/asyncHandler.js";
import { ACAO, contextoDe } from "./contexto.js";
import * as cadastros from "./cadastros.service.js";
import * as lanc from "./lancamentos.service.js";
import * as rel from "./relatorios.service.js";
import * as imp from "./importacao.service.js";
import * as conc from "./conciliacao.service.js";
import * as per from "./periodos.service.js";
import * as repositorio from "./repositorio.js";
import { uuid } from "./validacao.js";

export function criarDominioRouter({ autorizar, deps = undefined }) {
  if (typeof autorizar !== "function") throw new Error("autorizar (gate do Agente 1) é obrigatório");
  const r = Router();
  const d = deps; // injeção opcional para testes
  const h = (acao, fn, { status = 200 } = {}) => [autorizar(acao), asyncHandler(async (req, res) => {
    const data = await fn(contextoDe(req), req);
    res.set("Cache-Control", "no-store");
    res.status(status).json({ data });
  })];

  // plano de contas
  r.get("/plano-contas", ...h(ACAO.VER, (c) => cadastros.listarPlanoContas(c, d)));
  r.post("/plano-contas", ...h(ACAO.CONFIGURAR, (c, q) => cadastros.criarCategoria(c, q.body, d), { status: 201 }));
  r.patch("/plano-contas/:id", ...h(ACAO.CONFIGURAR, (c, q) => cadastros.atualizarCategoria(c, q.params.id, q.body, d)));

  // contas e saldos de abertura
  r.get("/contas", ...h(ACAO.VER, (c) => cadastros.listarContas(c, d)));
  r.post("/contas", ...h(ACAO.CONFIGURAR, (c, q) => cadastros.criarConta(c, q.body, d), { status: 201 }));
  r.patch("/contas/:id", ...h(ACAO.CONFIGURAR, (c, q) => cadastros.atualizarConta(c, q.params.id, q.body, d)));
  r.get("/contas/:id/extrato", ...h(ACAO.VER, (c, q) => rel.extratoConta(c, uuid(q.params.id, "id"), q.query, d)));
  r.get("/aberturas", ...h(ACAO.VER, (c) => cadastros.listarAberturas(c, d)));
  r.put("/aberturas", ...h(ACAO.CONFIGURAR, (c, q) => cadastros.definirAbertura(c, q.body, d)));

  // lançamentos
  r.get("/lancamentos", ...h(ACAO.VER, (c, q) => lanc.listarLancamentos(c, q.query, d)));
  r.post("/lancamentos", ...h(ACAO.LANCAR, (c, q) => lanc.criarLancamento(c, q.body, d), { status: 201 }));
  r.patch("/lancamentos/:id", ...h(ACAO.EDITAR, (c, q) => lanc.atualizarLancamento(c, q.params.id, q.body, d)));
  r.post("/lancamentos/:id/cancelar", ...h(ACAO.CANCELAR, (c, q) => lanc.cancelarLancamento(c, q.params.id, q.body, d)));

  // transferências
  r.get("/transferencias", ...h(ACAO.VER, (c) => lanc.listarTransferencias(c, d)));
  r.post("/transferencias", ...h(ACAO.LANCAR, (c, q) => lanc.criarTransferencia(c, q.body, d), { status: 201 }));
  r.post("/transferencias/vincular", ...h(ACAO.CONCILIAR, (c, q) => lanc.vincularTransferencia(c, q.body, d), { status: 201 }));
  r.post("/transferencias/:id/desvincular", ...h(ACAO.CONCILIAR, (c, q) => lanc.desvincularTransferencia(c, q.params.id, q.body, d)));
  r.post("/transferencias/:id/cancelar", ...h(ACAO.CANCELAR, (c, q) => lanc.cancelarTransferencia(c, q.params.id, q.body, d)));

  // relatórios (sempre recalculados)
  r.get("/relatorios/visao-geral", ...h(ACAO.VER, (c, q) => rel.visaoGeral(c, q.query, d)));
  r.get("/relatorios/dre", ...h(ACAO.VER, (c, q) => rel.dre(c, q.query, d)));
  r.get("/relatorios/indicadores", ...h(ACAO.VER, (c, q) => rel.indicadores(c, q.query, d)));
  r.get("/relatorios/categorias", ...h(ACAO.VER, (c, q) => rel.categorias(c, q.query, d)));
  r.get("/relatorios/integridade", ...h(ACAO.VER, (c, q) => rel.integridade(c, q.query, d)));

  // importação: prévia (LANCAR) → decisões (CONCILIAR) → confirmação atômica (CONFIGURAR)
  r.get("/importacoes", ...h(ACAO.VER, (c) => imp.listarImportacoes(c, d)));
  r.post("/importacoes/previa", ...h(ACAO.LANCAR, (c, q) => imp.gerarPrevia(c, q.body, d), { status: 201 }));
  r.get("/importacoes/:id", ...h(ACAO.VER, (c, q) => imp.obterPrevia(c, q.params.id, d)));
  r.post("/importacoes/:id/pares", ...h(ACAO.CONCILIAR, (c, q) => imp.decidirPares(c, q.params.id, q.body, d)));
  r.post("/importacoes/:id/alteracoes", ...h(ACAO.CONCILIAR, (c, q) => imp.aceitarAlteracoes(c, q.params.id, q.body, d)));
  r.post("/importacoes/:id/cancelar", ...h(ACAO.LANCAR, (c, q) => imp.cancelarImportacao(c, q.params.id, d)));
  r.post("/importacoes/:id/confirmar", ...h(ACAO.CONFIGURAR, (c, q) => imp.confirmarImportacao(c, q.params.id, q.body, d)));

  // conciliação (B7): venda realizada ≠ recebimento efetivo; classificação manual autorizada; nada inventado
  r.get("/conciliacao/resumo", ...h(ACAO.VER, (c, q) => conc.resumo(c, q.query, d)));
  r.get("/conciliacao/pendencias", ...h(ACAO.VER, (c, q) => conc.pendencias(c, q.query, d)));
  r.get("/conciliacao/referencias", ...h(ACAO.VER, (c, q) => conc.listarReferencias(c, q.query, d)));
  r.post("/conciliacao/referencias", ...h(ACAO.CONCILIAR, (c, q) => conc.registrarReferencias(c, q.body, d), { status: 201 }));
  r.post("/conciliacao/referencias/importar", ...h(ACAO.CONCILIAR, (c, q) => conc.importarReferencias(c, q.body, d)));
  r.post("/conciliacao/referencias/:id/cancelar", ...h(ACAO.CONCILIAR, (c, q) => conc.cancelarReferencia(c, q.params.id, q.body, d)));
  r.post("/conciliacao/resolucoes", ...h(ACAO.CONCILIAR, (c, q) => conc.classificar(c, q.body, d), { status: 201 }));
  r.post("/conciliacao/resolucoes/:id/revogar", ...h(ACAO.CONCILIAR, (c, q) => conc.revogarClassificacao(c, q.params.id, q.body, d)));
  r.get("/conciliacao/excecoes-sangria", ...h(ACAO.VER, (c) => conc.listarExcecoes(c, d)));
  r.post("/conciliacao/excecoes-sangria", ...h(ACAO.CONFIGURAR, (c, q) => conc.aprovarExcecao(c, q.body, d), { status: 201 }));
  r.post("/conciliacao/excecoes-sangria/:id/desativar", ...h(ACAO.CONFIGURAR, (c, q) => conc.desativarExcecao(c, q.params.id, q.body, d)));
  r.post("/conciliacao/pendencias/:id/resolver", ...h(ACAO.CONCILIAR, (c, q) => conc.resolverPendencia(c, q.params.id, q.body, d)));

  // períodos (B8): fechar exige `fechar`; reabrir exige `reabrir` (nenhum nível a concede) E o serviço segue desativado por padrão
  r.get("/periodos", ...h(ACAO.VER, (c) => per.listar(c, d)));
  r.get("/periodos/politica", ...h(ACAO.VER, (c) => per.obterPolitica(c, d)));
  r.put("/periodos/politica", ...h(ACAO.CONFIGURAR, (c, q) => per.definirPolitica(c, q.body, d)));
  r.post("/periodos/abrir", ...h(ACAO.FECHAR, (c, q) => per.abrir(c, q.body, d), { status: 201 }));
  r.get("/periodos/:mes/pre-fechamento", ...h(ACAO.VER, (c, q) => per.preFechamento(c, q.params.mes, d)));
  r.post("/periodos/:mes/fechar", ...h(ACAO.FECHAR, (c, q) => per.fechar(c, q.params.mes, q.body, d)));
  r.post("/periodos/:mes/reabrir", ...h(ACAO.REABRIR, (c, q) => per.reabrir(c, q.params.mes, q.body, d)));

  // trilha de auditoria
  r.get("/auditoria", ...h(ACAO.EDITAR, (c, q) => (d?.repo ?? repositorio).listarAuditoria(c, { entidade: q.query.entidade, entidadeId: q.query.entidadeId }, d?.db)));

  return r;
}
