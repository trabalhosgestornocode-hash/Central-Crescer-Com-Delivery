// Rotas do domínio financeiro. O router NÃO decide acesso: recebe `autorizar(acao)` do Agente 1 (gate sem bypass) por
// injeção, e cada rota declara a ação mínima. Contexto (org/unidade/usuário) vem SÓ de req.financeiro/req.user — nunca do corpo.
// Resposta: { data }. Erros: ApiError → errorHandler global.
import { Router } from "express";
import { asyncHandler } from "../../../shared/asyncHandler.js";
import { ACAO, contextoDe, permissoesDe } from "./contexto.js";
import * as obr from "./obrigacoes.service.js";
import * as cs from "./conciliacaoSaidas.service.js";
import * as cadastros from "./cadastros.service.js";
import * as lanc from "./lancamentos.service.js";
import * as rel from "./relatorios.service.js";
import * as imp from "./importacao.service.js";
import * as conc from "./conciliacao.service.js";
import * as per from "./periodos.service.js";
import * as tab from "./tabelas.service.js";
import * as cfg from "./configuracoes.service.js";
import * as repositorio from "./repositorio.js";
import * as painelSvc from "./painel.service.js";
import * as buscaSvc from "./busca.service.js";
import * as vendasSvc from "./vendasCanal.service.js";
import * as confSvc from "./conferencias.service.js";
import * as pdocSvc from "./pendenciasDocumentais.service.js";
import * as vdSvc from "./vendasDiarias.service.js";
import * as f152 from "./f152.service.js";
import { uuid } from "./validacao.js";
import { financeiro2Habilitado } from "../../../shared/financeiro2.flag.js";
import { ApiError } from "../../../shared/ApiError.js";

export function criarDominioRouter({ autorizar, deps = undefined, financeiro2 = financeiro2Habilitado }) {
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
  r.get("/periodos/politica", ...h(ACAO.VER, (c) => per.obterPolitica(c)));
  r.put("/periodos/politica", ...h(ACAO.CONFIGURAR, (c, q) => per.definirPolitica(c, q.body)));
  r.post("/periodos/abrir", ...h(ACAO.FECHAR, (c, q) => per.abrir(c, q.body, d), { status: 201 }));
  r.get("/periodos/:mes/pre-fechamento", ...h(ACAO.VER, (c, q) => per.preFechamento(c, q.params.mes, d)));
  r.post("/periodos/:mes/fechar", ...h(ACAO.FECHAR, (c, q) => per.fechar(c, q.params.mes, q.body, d)));
  // NÃO existe rota de reabertura (LD-009/A5): nenhum bypass por HTTP. O serviço `reabrir` segue fail-closed para uso futuro, em migration/rota próprias.

  // relatórios tabulares e exportações (B9): mesmo motor e mesmas fontes; contexto só do gate; unidade fora do contexto → 403
  r.get("/relatorios/tabelas/catalogo", ...h(ACAO.VER, (c) => tab.catalogo(c)));
  r.get("/relatorios/tabelas/:id", ...h(ACAO.VER, (c, q) => tab.gerar(c, q.params.id, q.query, d)));
  r.get("/relatorios/tabelas/:id/exportar", autorizar(ACAO.VER), asyncHandler(async (req, res) => {
    const arq = await tab.exportar(contextoDe(req), req.params.id, req.query.formato, req.query, d);
    res.set({
      "Content-Type": arq.tipo, "Content-Disposition": `attachment; filename="${arq.nome}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Linhas": String(arq.linhas),
    });
    res.send(arq.conteudo);
  }));

  // ---- Financeiro 2.0 (migration 151): contas a pagar, acréscimos (juros/multa/tarifa) e conciliação de saídas ----
  // Quem registra sem poder confirmar (sem `conciliar`) gera registro PROVISÓRIO; classificar o que altera o resultado exige `classificar`.
  // FEATURE FLAG (fail-closed): fora das organizações em FINANCEIRO_2_ORGANIZACOES, as rotas novas não existem (404 — não revela a função).
  const so2 = (req, _res, next) => (financeiro2(contextoDe(req).organizacaoId) ? next() : next(ApiError.notFound("Recurso não encontrado.", { codigo: "FINANCEIRO_2_DESABILITADO" })));
  // (3ª revisão, B-2) permissão ANTES do flag: sem permissão = 403, como nas demais rotas; com permissão e flag desligado = 404
  const h2 = (acao, fn, o) => { const [aut, ...resto] = h(acao, fn, o); return [aut, so2, ...resto]; };
  const perms = (q) => ({ permissoes: permissoesDe(q) });
  // Visão Geral 2.0, Receitas e Vendas, DRE gerencial de referência (só leitura; regras propostas, não aprovadas)
  r.get("/painel", ...h2(ACAO.VER, (c, q) => painelSvc.painel(c, q.query, d)));
  r.get("/busca", ...h2(ACAO.VER, (c, q) => buscaSvc.buscar(c, q.query, d)));
  // 153: faturamento por canal e ponte painel → base gerencial (ajuste confirmado = decisão de quem classifica)
  // Vendas diárias (SAIPOS): mesma fonte de fin_referencias; editar/atualizar exige `editar`
  // conciliação 1:N (migration 155): sob a trava da flag como o resto do Financeiro 2.0
  r.get("/transferencias/multiplas", ...h2(ACAO.VER, (c) => lanc.listarTransferenciasMultiplas(c, d)));
  r.post("/transferencias/vincular-multipla", ...h2(ACAO.CONCILIAR, (c, q) => lanc.vincularTransferenciaMultipla(c, q.body, d), { status: 201 }));
  r.post("/transferencias/multiplas/:id/desvincular", ...h2(ACAO.CONCILIAR, (c, q) => lanc.desvincularTransferenciaMultipla(c, q.params.id, q.body, d)));
  r.get("/vendas-diarias", ...h2(ACAO.VER, (c, q) => vdSvc.listar(c, q.query, d)));
  r.get("/vendas-diarias/historico", ...h2(ACAO.VER, (c, q) => vdSvc.historico(c, q.query, d)));
  r.get("/vendas-diarias/dia", ...h2(ACAO.VER, (c, q) => vdSvc.detalhe(c, q.query, d)));
  r.post("/vendas-diarias", ...h2(ACAO.LANCAR, (c, q) => vdSvc.registrar(c, q.body, d), { status: 201 }));
  r.post("/vendas-diarias/importar/previa", ...h2(ACAO.LANCAR, (c, q) => vdSvc.previaImportacao(c, q.body, d)));
  r.post("/vendas-diarias/importar", ...h2(ACAO.LANCAR, (c, q) => vdSvc.importar(c, q.body, d, perms(q))));
  r.patch("/vendas-diarias/:data", ...h2(ACAO.LANCAR, (c, q) => vdSvc.editar(c, q.params.data, q.body, d, perms(q))));
  r.get("/conferencias", ...h2(ACAO.VER, (c, q) => confSvc.listar(c, q.query, d)));
  r.get("/conferencias/historico", ...h2(ACAO.EDITAR, (c, q) => confSvc.historico(c, q.query, d)));
  // pendências documentais (migration 156): cadastro manual, sem movimentação financeira; confirmar = classificar (decisão com evidência)
  const dPdoc = { ...d, automaticas: async (c, mes) => (await confSvc.listar(c, { mes }, d)).pendencias.filter((p) => p.tipo !== "pendencia_documental") };
  r.get("/pendencias-documentais", ...h2(ACAO.VER, (c, q) => pdocSvc.listar(c, q.query, d)));
  r.post("/pendencias-documentais", ...h2(ACAO.LANCAR, (c, q) => pdocSvc.registrar(c, q.body, dPdoc), { status: 201 }));
  r.post("/pendencias-documentais/modelos/:chave/dispensar", ...h2(ACAO.EDITAR, (c, q) => pdocSvc.dispensarModelo(c, q.params.chave, q.body, d)));
  r.post("/pendencias-documentais/modelos/:chave", ...h2(ACAO.LANCAR, (c, q) => pdocSvc.registrarModelo(c, q.params.chave, q.body, d), { status: 201 }));
  r.patch("/pendencias-documentais/:id", ...h2(ACAO.EDITAR, (c, q) => pdocSvc.editar(c, q.params.id, q.body, d)));
  r.post("/pendencias-documentais/:id/confirmar", ...h2(ACAO.CLASSIFICAR, (c, q) => pdocSvc.confirmar(c, q.params.id, q.body, d)));
  r.post("/pendencias-documentais/:id/cancelar", ...h2(ACAO.EDITAR, (c, q) => pdocSvc.cancelar(c, q.params.id, q.body, d)));
  r.get("/pendencias-documentais/:id/historico", ...h2(ACAO.EDITAR, (c, q) => pdocSvc.historico(c, q.params.id, d)));
  r.get("/vendas-canal", ...h2(ACAO.VER, (c, q) => vendasSvc.listar(c, q.query, d)));
  r.post("/vendas-canal", ...h2(ACAO.LANCAR, (c, q) => vendasSvc.registrarCanal(c, q.body, d), { status: 201 }));
  r.post("/vendas-canal/importar", ...h2(ACAO.LANCAR, (c, q) => vendasSvc.importar(c, q.body, d)));
  r.post("/vendas-canal/:id/cancelar", ...h2(ACAO.EDITAR, (c, q) => vendasSvc.cancelarCanal(c, q.params.id, q.body, d)));
  r.post("/vendas-ajustes", ...h2(ACAO.LANCAR, (c, q) => vendasSvc.registrarAjuste(c, q.body, d), { status: 201 }));
  r.post("/vendas-ajustes/:id/confirmar", ...h2(ACAO.CLASSIFICAR, (c, q) => vendasSvc.confirmarAjuste(c, q.params.id, q.body, d)));
  r.post("/vendas-ajustes/:id/cancelar", ...h2(ACAO.EDITAR, (c, q) => vendasSvc.cancelarAjuste(c, q.params.id, q.body, d)));
  r.get("/receitas", ...h2(ACAO.VER, (c, q) => painelSvc.receitas(c, q.query, d)));
  r.get("/dre-referencia", ...h2(ACAO.VER, (c, q) => painelSvc.dreReferencia(c, q.query, d)));
  // 152: rateios (definir = editar; aprovar = classificar, decisão da contadora), contas a receber e dívidas
  r.get("/rateios", ...h2(ACAO.VER, (c, q) => f152.listarRateios(c, q.query, d)));
  r.post("/rateios", ...h2(ACAO.EDITAR, (c, q) => f152.definirRateio(c, q.body, d), { status: 201 }));
  r.post("/rateios/:id/aprovar", ...h2(ACAO.CLASSIFICAR, (c, q) => f152.aprovarRateio(c, q.params.id, d)));
  r.post("/rateios/:id/cancelar", ...h2(ACAO.EDITAR, (c, q) => f152.cancelarRateio(c, q.params.id, q.body, d)));
  r.get("/recebiveis", ...h2(ACAO.VER, (c, q) => f152.listarRecebiveis(c, q.query, d)));
  r.post("/recebiveis", ...h2(ACAO.LANCAR, (c, q) => f152.criarRecebivel(c, q.body, d), { status: 201 }));
  r.post("/recebiveis/:id/recebimentos", ...h2(ACAO.LANCAR, (c, q) => f152.registrarRecebimento(c, q.params.id, q.body, d), { status: 201 }));
  r.post("/recebiveis/:id/cancelar", ...h2(ACAO.CANCELAR, (c, q) => f152.cancelarRecebivel(c, q.params.id, q.body, d)));
  r.post("/recebimentos/:id/cancelar", ...h2(ACAO.CANCELAR, (c, q) => f152.cancelarRecebimento(c, q.params.id, q.body, d)));
  r.get("/dividas", ...h2(ACAO.VER, (c, q) => f152.listarDividas(c, q.query, d)));
  r.post("/dividas", ...h2(ACAO.LANCAR, (c, q) => f152.criarDivida(c, q.body, d), { status: 201 }));
  r.patch("/dividas/:id", ...h2(ACAO.EDITAR, (c, q) => f152.atualizarSaldoDivida(c, q.params.id, q.body, d)));
  r.post("/dividas/:id/eventos", ...h2(ACAO.LANCAR, (c, q) => f152.registrarEventoDivida(c, q.params.id, q.body, d), { status: 201 }));
  r.post("/divida-eventos/:id/cancelar", ...h2(ACAO.CANCELAR, (c, q) => f152.cancelarEventoDivida(c, q.params.id, q.body, d)));
  r.get("/fornecedores", ...h2(ACAO.VER, (c) => obr.listarFornecedores(c, d)));
  r.post("/fornecedores", ...h2(ACAO.LANCAR, (c, q) => obr.criarFornecedor(c, q.body, d), { status: 201 }));
  r.get("/contas-pagar", ...h2(ACAO.VER, (c, q) => obr.listar(c, q.query, d)));
  r.get("/contas-pagar/resumo", ...h2(ACAO.VER, (c, q) => obr.resumoMes(c, q.query, d)));
  r.get("/contas-pagar/juros-mes", ...h2(ACAO.VER, (c, q) => obr.jurosDoMes(c, q.query, d)));
  r.get("/contas-pagar/juros", ...h2(ACAO.VER, (c, q) => obr.painelJuros(c, q.query, d)));
  r.post("/contas-pagar", ...h2(ACAO.LANCAR, (c, q) => obr.criar(c, q.body, d, perms(q)), { status: 201 }));
  r.post("/contas-pagar/pagamentos/:id/cancelar", ...h2(ACAO.CANCELAR, (c, q) => obr.cancelarPagamento(c, q.params.id, q.body, d)));
  r.get("/contas-pagar/:id", ...h2(ACAO.VER, (c, q) => obr.obter(c, q.params.id, d)));
  r.patch("/contas-pagar/:id", ...h2(ACAO.EDITAR, (c, q) => obr.atualizar(c, q.params.id, q.body, d, perms(q))));
  r.post("/contas-pagar/:id/pagamentos", ...h2(ACAO.LANCAR, (c, q) => obr.registrarPagamento(c, q.params.id, q.body, d, perms(q)), { status: 201 }));
  r.post("/contas-pagar/:id/quitar", ...h2(ACAO.CONCILIAR, (c, q) => obr.quitar(c, q.params.id, d)));
  r.post("/contas-pagar/:id/desfazer-quitacao", ...h2(ACAO.CONCILIAR, (c, q) => obr.desfazerQuitacao(c, q.params.id, q.body, d)));
  r.post("/contas-pagar/:id/confirmar-registro", ...h2(ACAO.CONCILIAR, (c, q) => obr.confirmarRegistro(c, q.params.id, d)));
  r.post("/contas-pagar/pagamentos/:pid/origem", ...h2(ACAO.CONCILIAR, (c, q) => obr.resolverOrigemPagamento(c, q.params.pid, q.body, d)));
  r.post("/contas-pagar/:id/quitar-e-classificar", ...h2(ACAO.CLASSIFICAR, (c, q) => obr.quitarEClassificar(c, q.params.id, q.body, d, perms(q))));
  r.post("/contas-pagar/:id/classificar", ...h2(ACAO.CLASSIFICAR, (c, q) => obr.classificar(c, q.params.id, q.body, d)));
  r.post("/contas-pagar/:id/cancelar", ...h2(ACAO.CANCELAR, (c, q) => obr.cancelar(c, q.params.id, q.body, d)));
  r.get("/conciliacao-saidas", ...h2(ACAO.VER, (c, q) => cs.painel(c, q.query, d)));
  r.post("/conciliacao-saidas/sugerir", ...h2(ACAO.CONCILIAR, (c, q) => cs.sugerir(c, q.body, d)));
  r.post("/conciliacao-saidas/vincular", ...h2(ACAO.CONCILIAR, (c, q) => cs.vincular(c, q.body, d), { status: 201 }));
  r.post("/conciliacao-saidas/:grupo/confirmar", ...h2(ACAO.CONCILIAR, (c, q) => cs.confirmar(c, q.params.grupo, q.body, d)));
  r.post("/conciliacao-saidas/:grupo/rejeitar", ...h2(ACAO.CONCILIAR, (c, q) => cs.rejeitar(c, q.params.grupo, d)));
  r.post("/conciliacao-saidas/:grupo/revogar", ...h2(ACAO.CONCILIAR, (c, q) => cs.revogar(c, q.params.grupo, q.body, d)));

  // configurações financeiras: visão consolidada do que o domínio suporta (escritas usam os endpoints próprios)
  r.get("/configuracoes", ...h(ACAO.VER, (c) => cfg.resumo(c, d)));

  // trilha de auditoria
  r.get("/auditoria", ...h(ACAO.EDITAR, (c, q) => (d?.repo ?? repositorio).listarAuditoria(c, { entidade: q.query.entidade, entidadeId: q.query.entidadeId }, d?.db)));

  return r;
}
