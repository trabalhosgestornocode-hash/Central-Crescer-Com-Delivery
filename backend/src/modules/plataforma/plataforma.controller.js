// Controllers do Painel SuperAdmin. Camada fina de propósito: validação e
// regra vivem nos services, e é lá que estão os testes e a auditoria.
//
// Nenhum controller aqui lê `req.tenant` — o painel da plataforma não tem
// empresa. Todo escopo vem de `req.params`.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import * as dashboard from "./plataforma.dashboard.service.js";
import * as empresas from "./plataforma.empresas.service.js";
import * as unidades from "./plataforma.unidades.service.js";
import * as estrutura from "./plataforma.estrutura.service.js";
import * as usuarios from "./plataforma.usuarios.service.js";
import * as financeiro from "./plataforma.financeiro.service.js";
import * as monitoramento from "./plataforma.monitoramento.service.js";
import * as auditoria from "./plataforma.auditoria.service.js";
import * as configuracao from "./plataforma.config.service.js";
import * as agenteUso from "./plataforma.agenteUso.service.js";
import { buscar } from "./plataforma.repo.js";

const ok = (res, data, status = 200) => res.status(status).json({ data });

// ---------------------------------------------------------- Dashboard Global
export const obterDashboard = asyncHandler(async (_req, res) => ok(res, await dashboard.obterDashboard()));
export const sessoesVivas = asyncHandler(async (_req, res) => ok(res, await dashboard.listarSessoesVivas()));

// ------------------------------------------------------------------ Empresas
export const listarEmpresas = asyncHandler(async (req, res) =>
  ok(res, await empresas.listarEmpresas({
    busca: req.query.busca, status: req.query.status, limite: req.query.limite,
    ehModelo: req.query.ehModelo,
  })));

export const obterEmpresa = asyncHandler(async (req, res) => ok(res, await empresas.obterEmpresa(req.params.id)));

export const criarEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.criarEmpresa(req, v.corpo(req.body)), 201));

export const atualizarEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.atualizarEmpresa(req, req.params.id, v.corpo(req.body))));

export const alterarStatusEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.alterarStatusEmpresa(req, req.params.id, v.corpo(req.body))));

export const alterarPlanoEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.alterarPlanoEmpresa(req, req.params.id, v.corpo(req.body))));

export const impactoExclusaoEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.impactoExclusaoEmpresa(req.params.id)));

export const excluirEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.excluirEmpresa(req, req.params.id, req.body ?? {})));

export const usuariosDaEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.listarUsuariosDaEmpresa(req.params.id)));

export const logsDaEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.listarLogsDaEmpresa(req.params.id, req.query.limite)));

// "Entrar como empresa": devolve um Context Token de impersonação. O frontend
// guarda esse token, mostra a barra de aviso e passa a operar como tenant.
export const entrarComoEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.entrarComoEmpresa(req, req.params.id), 201));

// Unidades de uma empresa — usado pelos seletores de associação.
export const unidadesDaEmpresa = asyncHandler(async (req, res) => {
  const id = v.uuid(req.params.id, "Empresa");
  ok(res, await buscar("unidades", "id, nome, ativo", (q) => q.eq("organizacao_id", id).order("nome")));
});

// Reclona o catálogo do modelo — recuperação manual para empresas cujo
// catálogo nunca chegou a ser copiado (ver plataforma.empresas.service.js).
export const clonarModeloEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.clonarModeloParaEmpresa(req, req.params.id), 201));

// --------------------------------------------------------------- Módulos
// Catálogo (fixo em código) — alimenta o passo "Acessos" do assistente de
// criação e a aba "Acessos" da página da empresa.
export const catalogoModulos = asyncHandler(async (_req, res) => ok(res, { modulos: empresas.catalogoModulos() }));

export const modulosDaEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.modulosDaEmpresaAdmin(req.params.id)));

export const definirModulosEmpresa = asyncHandler(async (req, res) =>
  ok(res, await empresas.definirModulosEmpresaAdmin(req, req.params.id, v.corpo(req.body))));

// ------------------------------------------------------------------ Unidades
export const listarUnidades = asyncHandler(async (req, res) =>
  ok(res, await unidades.listarUnidades({
    busca: req.query.busca, status: req.query.status,
    organizacaoId: req.query.organizacaoId, limite: req.query.limite,
  })));

export const obterUnidade = asyncHandler(async (req, res) => ok(res, await unidades.obterUnidade(req.params.id)));

export const criarUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.criarUnidade(req, v.corpo(req.body)), 201));

export const atualizarUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.atualizarUnidade(req, req.params.id, v.corpo(req.body))));

export const alterarStatusUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.alterarStatusUnidade(req, req.params.id, v.corpo(req.body))));

export const impactoExclusaoUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.impactoExclusaoUnidade(req.params.id)));

export const excluirUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.excluirUnidade(req, req.params.id, req.body ?? {})));

export const usuariosDaUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.listarUsuariosDaUnidade(req.params.id)));

export const logsDaUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.listarLogsDaUnidade(req.params.id, req.query.limite)));

// ------------------------------------------------------- Estrutura organizacional
// Promover/converter/transferir — cada um roda numa transação única do
// banco (ver plataforma.estrutura.service.js e a migration 053).
export const promoverUnidade = asyncHandler(async (req, res) =>
  ok(res, await estrutura.promoverUnidade(req, req.params.id, v.corpo(req.body)), 201));

export const transferirUnidade = asyncHandler(async (req, res) =>
  ok(res, await estrutura.transferirUnidade(req, req.params.id, v.corpo(req.body))));

export const converterEmpresaParaUnidade = asyncHandler(async (req, res) =>
  ok(res, await estrutura.converterEmpresaParaUnidade(req, req.params.id, v.corpo(req.body)), 201));

export const modulosDaUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.modulosDaUnidadeAdmin(req.params.id)));

export const definirModulosUnidade = asyncHandler(async (req, res) =>
  ok(res, await unidades.definirModulosUnidadeAdmin(req, req.params.id, v.corpo(req.body))));

// ------------------------------------------------------------------ Usuários
export const listarUsuarios = asyncHandler(async (req, res) =>
  ok(res, await usuarios.listarUsuarios({
    busca: req.query.busca, limite: req.query.limite,
    semEmpresa: v.booleano(req.query.semEmpresa, false),
  })));

export const obterUsuario = asyncHandler(async (req, res) => ok(res, await usuarios.obterUsuario(req.params.id)));

export const criarUsuario = asyncHandler(async (req, res) =>
  ok(res, await usuarios.criarUsuario(req, v.corpo(req.body)), 201));

export const atualizarUsuario = asyncHandler(async (req, res) =>
  ok(res, await usuarios.atualizarUsuario(req, req.params.id, v.corpo(req.body))));

export const redefinirSenha = asyncHandler(async (req, res) =>
  ok(res, await usuarios.redefinirSenha(req, req.params.id, v.corpo(req.body))));

export const alterarEmail = asyncHandler(async (req, res) =>
  ok(res, await usuarios.alterarEmail(req, req.params.id, v.corpo(req.body))));

export const forcarLogout = asyncHandler(async (req, res) =>
  ok(res, await usuarios.forcarLogout(req, req.params.id)));

export const excluirUsuario = asyncHandler(async (req, res) =>
  ok(res, await usuarios.excluirUsuario(req, req.params.id)));

export const definirSuperadmin = asyncHandler(async (req, res) =>
  ok(res, await usuarios.definirSuperadmin(req, req.params.id, v.corpo(req.body))));

// --------------------------------------------------- Associações (vínculos)
export const associarEmpresa = asyncHandler(async (req, res) =>
  ok(res, await usuarios.associarEmpresa(req, req.params.id, v.corpo(req.body)), 201));

export const associarEmpresasLote = asyncHandler(async (req, res) =>
  ok(res, await usuarios.associarEmpresasLote(req, req.params.id, v.corpo(req.body)), 201));

export const atualizarVinculo = asyncHandler(async (req, res) =>
  ok(res, await usuarios.atualizarVinculo(req, req.params.id, req.params.organizacaoId, v.corpo(req.body))));

export const removerVinculo = asyncHandler(async (req, res) =>
  ok(res, await usuarios.removerVinculo(req, req.params.id, req.params.organizacaoId)));

export const associarUnidade = asyncHandler(async (req, res) =>
  ok(res, await usuarios.associarUnidade(req, req.params.id, v.corpo(req.body)), 201));

export const atualizarVinculoUnidade = asyncHandler(async (req, res) =>
  ok(res, await usuarios.atualizarVinculoUnidade(req, req.params.id, req.params.unidadeId, v.corpo(req.body))));

export const removerVinculoUnidade = asyncHandler(async (req, res) =>
  ok(res, await usuarios.removerVinculoUnidade(req, req.params.id, req.params.unidadeId)));

export const papeis = asyncHandler(async (_req, res) => ok(res, usuarios.detalharPapeis()));

// ----------------------------------------------------------------- Financeiro
export const panoramaFinanceiro = asyncHandler(async (_req, res) => ok(res, await financeiro.obterPanorama()));
export const metricas = asyncHandler(async (_req, res) => ok(res, await financeiro.calcularMetricas()));

export const listarPlanos = asyncHandler(async (_req, res) => ok(res, await financeiro.listarPlanos()));
export const criarPlano = asyncHandler(async (req, res) => ok(res, await financeiro.criarPlano(v.corpo(req.body)), 201));
export const atualizarPlano = asyncHandler(async (req, res) => ok(res, await financeiro.atualizarPlano(req.params.id, v.corpo(req.body))));

export const listarAssinaturas = asyncHandler(async (req, res) =>
  ok(res, await financeiro.listarAssinaturas({ status: req.query.status, organizacaoId: req.query.organizacaoId })));
export const criarAssinatura = asyncHandler(async (req, res) => ok(res, await financeiro.criarAssinatura(v.corpo(req.body)), 201));
export const atualizarAssinatura = asyncHandler(async (req, res) => ok(res, await financeiro.atualizarAssinatura(req.params.id, v.corpo(req.body))));

export const listarCobrancas = asyncHandler(async (req, res) =>
  ok(res, await financeiro.listarCobrancas({ status: req.query.status, organizacaoId: req.query.organizacaoId, limite: req.query.limite })));
export const criarCobranca = asyncHandler(async (req, res) => ok(res, await financeiro.criarCobranca(v.corpo(req.body)), 201));
export const atualizarCobranca = asyncHandler(async (req, res) => ok(res, await financeiro.atualizarCobranca(req.params.id, v.corpo(req.body))));

// -------------------------------------------------------------- Monitoramento
export const obterMonitoramento = asyncHandler(async (_req, res) => ok(res, await monitoramento.obterMonitoramento()));

// --------------------------------------------------------- Logs e Auditoria
export const listarAuditoria = asyncHandler(async (req, res) =>
  ok(res, await auditoria.listarAuditoria({
    acao: req.query.acao, atorId: req.query.atorId, organizacaoId: req.query.organizacaoId,
    entidade: req.query.entidade, busca: req.query.busca,
    desde: req.query.desde, ate: req.query.ate,
    soImpersonacao: v.booleano(req.query.soImpersonacao, false),
    limite: req.query.limite,
  })));

export const filtrosAuditoria = asyncHandler(async (_req, res) => ok(res, await auditoria.opcoesDeFiltro()));
export const impersonacoes = asyncHandler(async (req, res) => ok(res, await auditoria.listarImpersonacoes({ limite: req.query.limite })));

// --------------------------------------------------- Configurações Globais
export const listarConfiguracoes = asyncHandler(async (_req, res) => ok(res, await configuracao.listarConfiguracoes()));
export const salvarConfiguracoes = asyncHandler(async (req, res) => ok(res, await configuracao.salvarConfiguracoes(req, req.body)));

// -------------------------------------------------------------- Atualizações
// A seção "Atualizações" do menu. A fonte da verdade das versões é o histórico
// do repositório, ao qual o servidor em produção não tem acesso (o deploy do
// Render não inclui o .git). Em vez de fingir um changelog, esta rota devolve
// o que é verificável — a versão configurada e o ambiente — e diz de onde o
// resto viria. Preencher isso pede um passo no deploy que grave a versão e as
// notas na `plataforma_config`.
export const atualizacoes = asyncHandler(async (_req, res) => {
  const identidade = await configuracao.identidadePublica();
  ok(res, {
    versaoAtual: identidade.versao,
    ambiente: process.env.NODE_ENV ?? "development",
    versaoNode: process.version,
    iniciadoEm: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    historico: [],
    fonteHistorico: {
      disponivel: false,
      comoHabilitar: "Gravar a versão e as notas de release em plataforma_config no passo de deploy (ex: chave 'saas.changelog'), ou consultar a API de releases do repositório com um token de leitura.",
    },
  });
});

// ------------------------------------------------------------------------ IA
// O Agente Crescer está em produção (Fase 1/1.5) — consumo real (tokens,
// custo estimado) agora vem de agente_uso (migration 049), medido a cada
// interação, não das APIs de billing dos provedores.
export const ia = asyncHandler(async (_req, res) => {
  const { grupos } = await configuracao.listarConfiguracoes();
  const apis = grupos.find((g) => g.chave === "api")?.itens ?? [];
  const chave = (nome) => apis.find((i) => i.chave === nome)?.preenchido ?? false;
  ok(res, {
    provedores: [
      { chave: "openai", nome: "OpenAI", configurado: chave("api.openai_key"), modeloSugerido: "gpt-4.1" },
      { chave: "claude", nome: "Anthropic Claude", configurado: chave("api.claude_key"), modeloSugerido: "claude-sonnet-5" },
    ],
    recursosPrevistos: [
      "Previsão de ruptura de estoque e sugestão de compra",
      "Detecção de anomalias de CMV e desperdício",
      "Resumo diário da operação por unidade",
    ],
    observacao: "Agente Crescer em produção (Dashboard Executivo + Diagnóstico + consulta diária). Consumo detalhado abaixo, medido por interação real.",
  });
});

// ---- Consumo do Agente Crescer (tokens/custo) — só medição, sem bloqueio.
const filtroPeriodo = (req) => ({ periodo: req.query.periodo, desde: req.query.desde, ate: req.query.ate });

export const consumoAgente = asyncHandler(async (req, res) =>
  ok(res, await agenteUso.resumoConsumoAgente(filtroPeriodo(req))));

export const consumoAgentePorOrganizacao = asyncHandler(async (req, res) =>
  ok(res, await agenteUso.consumoAgentePorOrganizacao({ ...filtroPeriodo(req), pagina: req.query.pagina, porPagina: req.query.porPagina })));

export const consumoAgentePorModelo = asyncHandler(async (req, res) =>
  ok(res, await agenteUso.consumoAgentePorModelo(filtroPeriodo(req))));

// Guarda-corpo: qualquer rota do painel que não exista devolve 404 com JSON, e
// não a página do frontend (o static middleware já passou nesse ponto).
export const naoEncontrado = asyncHandler(async (req) => {
  throw ApiError.notFound(`Recurso do painel não encontrado: ${req.method} ${req.originalUrl}`);
});
