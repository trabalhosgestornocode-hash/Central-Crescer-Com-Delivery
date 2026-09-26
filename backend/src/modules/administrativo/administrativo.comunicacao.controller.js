// Controller da área Comunicação/WhatsApp do PAINEL ADMINISTRATIVO
// (Checkpoint H.3-A). Camada fina — regra e projeção vivem em
// administrativo.comunicacao.service.js. Mesma autorização do resto do
// módulo (`requirePainelAdministrativo` no router inteiro — ver
// administrativo.routes.js); nenhuma checagem extra é necessária aqui.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./administrativo.comunicacao.service.js";
import * as central from "./administrativo.comunicacao.central.js";
import * as teste from "./administrativo.comunicacao.teste.js";
import * as conversas from "./administrativo.comunicacao.conversas.js";
import * as conexao from "./administrativo.comunicacao.conexao.js";

const ok = (res, data, status = 200) => res.status(status).json({ data });
// Mesma seam de teste de administrativo.controller.js: `app.locals.adminDeps`.
const deps = (req) => req.app?.locals?.adminDeps ?? undefined;

const autor = (req) => {
  const id = identidadeOperacional(req);
  // `superadmin`/`painelAdministrativo` só servem à checagem da Conexão (mesma regra de requirePainelAdministrativo); nunca saem daqui.
  return {
    contaId: id.contaId, perfilId: id.perfilId, nome: id.nome, email: id.email,
    superadmin: req.user?.superadmin === true, painelAdministrativo: req.user?.painelAdministrativo === true,
  };
};

// GET /administrativo/comunicacao/resumo
export const resumo = asyncHandler(async (req, res) => ok(res, await service.resumo(deps(req))));

// GET /administrativo/comunicacao/organizacoes?busca=
export const organizacoes = asyncHandler(async (req, res) =>
  ok(res, await service.organizacoes({ busca: req.query.busca, filtro: req.query.filtro }, deps(req))));

// GET /administrativo/comunicacao/organizacoes/:organizacaoId
export const detalheOrganizacao = asyncHandler(async (req, res) =>
  ok(res, await service.detalheOrganizacao({ organizacaoId: req.params.organizacaoId }, deps(req))));

// (perfis-elegiveis removido na migration 100 — ver administrativo.comunicacao.repo.js)

// PUT /administrativo/comunicacao/organizacoes/:organizacaoId/responsavel
export const salvarResponsavel = asyncHandler(async (req, res) =>
  ok(res, await service.salvarResponsavel({
    organizacaoId: req.params.organizacaoId, nome: req.body?.nome, telefoneE164: req.body?.telefoneE164,
    observacoes: req.body?.observacoes, ativo: req.body?.ativo,
  }, autor(req), deps(req))));

// PUT /administrativo/comunicacao/organizacoes/:organizacaoId/responsaveis/:contatoId/ativo
export const definirAtivoResponsavel = asyncHandler(async (req, res) =>
  ok(res, await service.definirAtivoResponsavel({
    organizacaoId: req.params.organizacaoId, contatoEmpresaId: req.params.contatoId, ativo: req.body?.ativo,
  }, autor(req), deps(req))));

// POST /administrativo/comunicacao/organizacoes/:organizacaoId/responsaveis/:contatoId/validar
export const validarResponsavel = asyncHandler(async (req, res) =>
  ok(res, await service.validarResponsavel({
    organizacaoId: req.params.organizacaoId, contatoEmpresaId: req.params.contatoId, confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// GET/PUT /administrativo/comunicacao/disponibilidade  (horários do iFood D-1)
export const disponibilidade = asyncHandler(async (req, res) => ok(res, await service.disponibilidade(deps(req))));
export const atualizarDisponibilidade = asyncHandler(async (req, res) =>
  ok(res, await service.atualizarDisponibilidade({
    dadosDisponiveisApos: req.body?.dadosDisponiveisApos, enviosPermitidosApos: req.body?.enviosPermitidosApos,
  }, autor(req), deps(req))));

// GET /administrativo/comunicacao/organizacoes/:organizacaoId/preview-mensagem?unidadeId=
// Checkpoint H.4-A — somente leitura, nunca cria mensagem/tentativa, nunca chama o provider.
export const preverMensagem = asyncHandler(async (req, res) =>
  ok(res, await service.preverMensagem({ organizacaoId: req.params.organizacaoId, unidadeId: req.query.unidadeId }, deps(req))));

// PUT /administrativo/comunicacao/organizacoes/:organizacaoId/configuracao
export const atualizarConfiguracao = asyncHandler(async (req, res) =>
  ok(res, await service.atualizarConfiguracao({
    organizacaoId: req.params.organizacaoId,
    habilitado: req.body?.habilitado,
    telefoneE164: req.body?.telefoneE164,
    perfilOperacionalId: req.body?.perfilOperacionalId,
    timezone: req.body?.timezone,
    tiposPermitidos: req.body?.tiposPermitidos,
    pausadoAte: req.body?.pausadoAte,
    pausadoMotivo: req.body?.pausadoMotivo,
  }, autor(req), deps(req))));

// POST /administrativo/comunicacao/organizacoes/:organizacaoId/consentimento
export const confirmarConsentimento = asyncHandler(async (req, res) =>
  ok(res, await service.confirmarConsentimento({
    organizacaoId: req.params.organizacaoId,
    confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// PUT /administrativo/comunicacao/organizacoes/:organizacaoId/habilitacao   { habilitado, confirmacaoExplicita }
export const habilitacao = asyncHandler(async (req, res) =>
  ok(res, await service.definirHabilitacao({
    organizacaoId: req.params.organizacaoId,
    habilitado: req.body?.habilitado,
    confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// PUT /administrativo/comunicacao/modo   { modo: "DISABLED"|"NORMAL", confirmacaoExplicita }
export const modo = asyncHandler(async (req, res) =>
  ok(res, await service.alterarModoGlobal({
    modo: req.body?.modo,
    confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// GET /administrativo/comunicacao/ativacao
export const ativacao = asyncHandler(async (req, res) => ok(res, await service.ativacao(deps(req))));

// GET /administrativo/comunicacao/fila?organizacaoId=&status=&pagina=&porPagina=
export const fila = asyncHandler(async (req, res) =>
  ok(res, await service.fila({
    organizacaoId: req.query.organizacaoId, status: req.query.status,
    pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));

// GET /administrativo/comunicacao/historico?organizacaoId=&status=&tipoAlerta=&desde=&ate=&pagina=&porPagina=
export const historico = asyncHandler(async (req, res) =>
  ok(res, await service.historico({
    organizacaoId: req.query.organizacaoId, status: req.query.status, tipoAlerta: req.query.tipoAlerta,
    desde: req.query.desde, ate: req.query.ate, pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));

// ---- Central de Comunicação (H.4-B.5) ----

// GET /administrativo/comunicacao/mensagens?organizacaoId=&unidadeId=&status=&origem=&desde=&ate=&busca=&pagina=&porPagina=
export const mensagens = asyncHandler(async (req, res) =>
  ok(res, await central.mensagens({
    organizacaoId: req.query.organizacaoId, unidadeId: req.query.unidadeId, status: req.query.status, origem: req.query.origem,
    desde: req.query.desde, ate: req.query.ate, busca: req.query.busca, pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));

// GET /administrativo/comunicacao/mensagens/:id
export const detalheMensagem = asyncHandler(async (req, res) => ok(res, await central.detalheMensagem({ id: req.params.id }, deps(req))));

// GET /administrativo/comunicacao/configuracao-operacional (somente leitura)
export const configuracaoOperacional = asyncHandler(async (req, res) => ok(res, await central.configuracaoOperacional(deps(req))));

// GET /administrativo/comunicacao/teste/preparo?organizacaoId=&unidadeId=
export const preparoTeste = asyncHandler(async (req, res) =>
  ok(res, await teste.preparoTeste({ organizacaoId: req.query.organizacaoId, unidadeId: req.query.unidadeId }, deps(req))));

// POST /administrativo/comunicacao/teste   { organizacaoId, unidadeId, testeId, confirmacaoExplicita }
export const enviarTeste = asyncHandler(async (req, res) =>
  ok(res, await teste.enviarTeste({
    organizacaoId: req.body?.organizacaoId, unidadeId: req.body?.unidadeId, testeId: req.body?.testeId, confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// GET /administrativo/comunicacao/teste/:mensagemId
export const statusTeste = asyncHandler(async (req, res) =>
  ok(res, await teste.statusTeste({ mensagemId: req.params.mensagemId }, autor(req), deps(req))));

// ---- Central de Comunicação: conversas com responsáveis autorizados ----

// GET /administrativo/comunicacao/central/visao-geral | automacoes | destinatarios?busca= | historico?... | diagnostico | atualizacoes?cursor=
export const centralVisaoGeral = asyncHandler(async (req, res) => ok(res, await conversas.visaoGeral(deps(req))));
export const centralAutomacoes = asyncHandler(async (req, res) => ok(res, await conversas.automacoes(deps(req))));
export const centralDestinatarios = asyncHandler(async (req, res) => ok(res, await conversas.destinatarios({ busca: req.query.busca }, deps(req))));
export const centralHistorico = asyncHandler(async (req, res) =>
  ok(res, await conversas.historicoGeral({
    organizacaoId: req.query.organizacaoId, unidadeId: req.query.unidadeId, status: req.query.status, origem: req.query.origem, desde: req.query.desde,
    ate: req.query.ate, busca: req.query.busca, operador: req.query.operador, pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));
export const centralDiagnostico = asyncHandler(async (req, res) => ok(res, await conversas.diagnosticoTecnico(deps(req))));
export const centralAtualizacoes = asyncHandler(async (req, res) => ok(res, await conversas.atualizacoes({ cursor: req.query.cursor }, deps(req))));

// GET /administrativo/comunicacao/conversas?filtro=&busca=
export const listarConversas = asyncHandler(async (req, res) => ok(res, await conversas.listarConversas({ filtro: req.query.filtro, busca: req.query.busca }, deps(req))));
// GET /administrativo/comunicacao/conversas/:contatoId?horas=
export const obterConversa = asyncHandler(async (req, res) =>
  ok(res, await conversas.obterConversa({ contatoId: req.params.contatoId, horas: req.query.horas, antes: req.query.antes }, autor(req), deps(req))));
// POST /administrativo/comunicacao/conversas/:contatoId/lida   { ate? }
export const marcarConversaLida = asyncHandler(async (req, res) =>
  ok(res, await conversas.marcarLida({ contatoId: req.params.contatoId, ate: req.body?.ate }, autor(req), deps(req))));
// POST /administrativo/comunicacao/conversas/:contatoId/mensagens   { envioId, texto, organizacaoId?, unidadeId? }
export const enviarMensagemConversa = asyncHandler(async (req, res) =>
  ok(res, await conversas.enviarMensagem({
    contatoId: req.params.contatoId, envioId: req.body?.envioId, texto: req.body?.texto, organizacaoId: req.body?.organizacaoId, unidadeId: req.body?.unidadeId,
  }, autor(req), deps(req))));

// ---- Aba Conexão: identidade e sessão do WhatsApp (mesma autorização da Comunicação: SuperAdmin OU Painel Administrativo) ----

// GET /administrativo/comunicacao/conexao — estado (qualquer usuário do painel; sem QR e sem ações).
export const conexaoEstado = asyncHandler(async (req, res) => ok(res, await conexao.estado(autor(req), deps(req))));
// POST /administrativo/comunicacao/conexao/iniciar
export const conexaoIniciar = asyncHandler(async (req, res) => ok(res, await conexao.iniciar(autor(req), deps(req), { revisar: req.body?.revisar === true })));
// GET /administrativo/comunicacao/conexao/qr?operacaoId=  — o QR é segredo transitório: nenhum cache (navegador/proxy) pode retê-lo.
export const conexaoQr = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  ok(res, await conexao.qr({ operacaoId: req.query.operacaoId }, autor(req), deps(req)));
});
// POST /administrativo/comunicacao/conexao/novo-qr     { operacaoId }
export const conexaoNovoQr = asyncHandler(async (req, res) => ok(res, await conexao.novoQr({ operacaoId: req.body?.operacaoId }, autor(req), deps(req))));
// POST /administrativo/comunicacao/conexao/confirmar   { operacaoId, utilizarComoAgente?, ambiente? }
export const conexaoConfirmar = asyncHandler(async (req, res) =>
  ok(res, await conexao.confirmar({ operacaoId: req.body?.operacaoId, utilizarComoAgente: req.body?.utilizarComoAgente, ambiente: req.body?.ambiente }, autor(req), deps(req))));
// POST /administrativo/comunicacao/conexao/cancelar    { operacaoId }
export const conexaoCancelar = asyncHandler(async (req, res) => ok(res, await conexao.cancelar({ operacaoId: req.body?.operacaoId }, autor(req), deps(req))));
// POST /administrativo/comunicacao/conexao/desconectar { confirmacaoExplicita }
export const conexaoDesconectar = asyncHandler(async (req, res) => ok(res, await conexao.desconectar({ confirmacaoExplicita: req.body?.confirmacaoExplicita }, autor(req), deps(req))));
// POST /administrativo/comunicacao/conexao/trocar      { confirmacaoExplicita }
export const conexaoReconciliar = asyncHandler(async (req, res) => ok(res, await conexao.reconciliar(autor(req), deps(req))));
export const conexaoTrocar = asyncHandler(async (req, res) => ok(res, await conexao.trocar({ confirmacaoExplicita: req.body?.confirmacaoExplicita }, autor(req), deps(req))));
// PUT /administrativo/comunicacao/conexao/identidade   { ambiente?, agenteCrescer? }
export const conexaoIdentidade = asyncHandler(async (req, res) => ok(res, await conexao.definirIdentidade({ ambiente: req.body?.ambiente, agenteCrescer: req.body?.agenteCrescer }, autor(req), deps(req))));
