import { Router } from "express";
import { performanceRouter } from './performance/performance.routes.js';
import { desenvolvimentoRouter } from '../desenvolvimento/desenvolvimento.routes.js';
import * as c from "./administrativo.controller.js";
import * as cc from "./administrativo.comunicacao.controller.js";
import { requirePainelAdministrativo, exigirMfaSeExigido } from "../../middlewares/auth.js";
import { limiteDeTaxa } from "../../shared/rateLimit.js";
import { RATE_LIMIT } from "../../config/limites.js";

// API do PAINEL ADMINISTRATIVO da Crescer com Delivery.
//
// Um TERCEIRO "mundo" da API, ao lado de:
//   1. SESSÃO      — sem contexto.
//   2. PLATAFORMA  — SuperAdmin (técnico). Nunca tem req.tenant.
//   3. TENANT      — exige Context Token; todo dado escopado por ele.
//   4. ADMINISTRATIVO — GERENCIAL. Monitoramento cross-tenant. Nunca tem
//      req.tenant. NÃO concede poder técnico de SuperAdmin.
//
// `requirePainelAdministrativo` no ROUTER INTEIRO — mesma escolha deliberada
// do plataformaRouter: uma rota nova adicionada aqui já nasce protegida. O
// SuperAdmin passa por bypass (ele já enxerga tudo); qualquer outro usuário
// precisa do flag em `painel_administrativo_usuarios`, carregado por
// requireAuth e relido a cada request (revogar surte efeito na hora).
//
// Nenhuma rota daqui passa por `requireContexto`: o Painel Administrativo não
// tem empresa. As leituras cross-tenant (fases E/F) usam service_role dentro
// deste módulo, exatamente como plataforma.* — nunca um bypass genérico dos
// middlewares multi-tenant.

export const administrativoRouter = Router();
administrativoRouter.use(requirePainelAdministrativo);
// MFA — DORMENTE (no-op enquanto MFA_ENFORCE_PAINEL_ADM != "true").
administrativoRouter.use(exigirMfaSeExigido("painelAdministrativo"));
// Rede contra script descontrolado (só leitura, já restrito ao Painel Adm).
administrativoRouter.use(limiteDeTaxa({ escopo: "administrativo", ...RATE_LIMIT.administrativo }));

// ---- Fase B: sanidade da cadeia de autorização
administrativoRouter.get("/ping", c.ping);
administrativoRouter.use('/performance', performanceRouter);

// ---- Fase F: monitoramento cross-tenant (monitor "Dashboard iFood").
// Somente leitura. O universo monitorado (unidades elegíveis) e os
// lançamentos são carregados em lote no service — nunca `for unidade: SELECT`.
//
// (A ÚNICA exceção ao "somente leitura" deste router é o bloco de
// desbloqueios logo abaixo — POST/DELETE que concedem/revogam permissão de
// lançamento de UM dia, sem tocar em nenhum dado operacional.)
administrativoRouter.get("/visao-geral", c.visaoGeral);
administrativoRouter.get("/monitoramento-diario", c.monitoramentoDiario);
administrativoRouter.get("/pendencias", c.pendencias);
administrativoRouter.get("/empresas", c.empresas);            // antes de /empresas/:id
administrativoRouter.get("/empresas/:organizacaoId", c.detalheEmpresa);
administrativoRouter.get("/unidades/:unidadeId/calendario", c.calendarioUnidade);

// ---- Comunicação/WhatsApp (Checkpoint H.3-A) — visualização + configuração
// segura. A ÚNICA escrita (`PUT .../configuracao`) NUNCA habilita envio: o
// service recusa qualquer `habilitado != false` com 400 antes de tocar o
// banco (defesa em profundidade — o repo também nunca aceita esse parâmetro).
// Nenhuma rota chama `whatsapp.service.js`, provider ou Gateway. `definirModo` só é chamado pelo
// service dedicado (H.4-B.1: PUT /comunicacao/modo) — ver a guarda estática em administrativo-comunicacao-rotas.test.js.
administrativoRouter.get("/comunicacao/resumo", cc.resumo);
administrativoRouter.get("/comunicacao/organizacoes", cc.organizacoes);
administrativoRouter.get("/comunicacao/organizacoes/:organizacaoId", cc.detalheOrganizacao);
administrativoRouter.get("/comunicacao/organizacoes/:organizacaoId/perfis-elegiveis", cc.perfisElegiveis);
administrativoRouter.get("/comunicacao/organizacoes/:organizacaoId/preview-mensagem", cc.preverMensagem);
administrativoRouter.put("/comunicacao/organizacoes/:organizacaoId/configuracao", cc.atualizarConfiguracao);
// Checkpoint H.4-A.2 — segunda escrita permitida, só consentimento/verificação
// (nunca habilitado). Exige confirmacaoExplicita=true; ver service para a regra.
administrativoRouter.post("/comunicacao/organizacoes/:organizacaoId/consentimento", cc.confirmarConsentimento);
// Checkpoint H.4-B.1 — as ÚNICAS alavancas de envio: habilitar/desabilitar a ORGANIZAÇÃO e ligar/desligar o
// MODO global (DISABLED|NORMAL). Ator humano autenticado (requirePainelAdministrativo), confirmação explícita,
// gates do piloto lidos do process.env real. Desligar é sempre permitido. Ver o service.
administrativoRouter.get("/comunicacao/ativacao", cc.ativacao);
administrativoRouter.put("/comunicacao/organizacoes/:organizacaoId/habilitacao", cc.habilitacao);
administrativoRouter.put("/comunicacao/modo", cc.modo);
administrativoRouter.get("/comunicacao/fila", cc.fila);
administrativoRouter.get("/comunicacao/historico", cc.historico);
// H.4-B.5 — Central de Comunicação. Mesmo router (requirePainelAdministrativo): nenhuma rota pública. O envio de teste exige ator humano + confirmação.
administrativoRouter.get("/comunicacao/mensagens", cc.mensagens);
administrativoRouter.get("/comunicacao/mensagens/:id", cc.detalheMensagem);
administrativoRouter.get("/comunicacao/configuracao-operacional", cc.configuracaoOperacional);
administrativoRouter.get("/comunicacao/teste/preparo", cc.preparoTeste);
administrativoRouter.post("/comunicacao/teste", cc.enviarTeste);
administrativoRouter.get("/comunicacao/teste/:mensagemId", cc.statusTeste);

// ---- Mentorados: contas da plataforma + vínculos empresa/unidade, só leitura.
// Mesma autorização do módulo (`requirePainelAdministrativo`); nenhuma ação
// administrativa do SuperAdmin é exposta. Ver administrativo.mentorados.js.
administrativoRouter.get("/mentorados", c.mentorados);

// ---- Desbloqueio administrativo de um dia do Dashboard iFood (migration 068).
//
// PRIMEIRA e ÚNICA escrita deste router — o resto continua somente leitura. A
// autorização é a MESMA do módulo inteiro (`requirePainelAdministrativo` no
// router, com bypass de SuperAdmin): não existe permissão nova, e usuário
// comum de empresa não alcança estas rotas nem chamando direto.
//
// Escopo estreito por construção: uma unidade, uma data, um tipo. Nunca
// atinge outra unidade/empresa/data nem qualquer outro módulo. Ver
// administrativo.service.js#desbloquearDia.
administrativoRouter.get("/unidades/:unidadeId/desbloqueios", c.listarDesbloqueios);
administrativoRouter.post("/unidades/:unidadeId/desbloqueios", c.criarDesbloqueio);
administrativoRouter.delete("/unidades/:unidadeId/desbloqueios/:desbloqueioId", c.revogarDesbloqueio);

// ---- Financeiro / Relatorios. Rankings e relatorio executivo vivem em rotas
// proprias para nao inchar o payload da Visao Geral.
administrativoRouter.get("/rankings/faturamento", c.rankingFaturamento);
administrativoRouter.get("/rankings/conformidade", c.rankingConformidade);
administrativoRouter.get("/relatorios/resumo", c.relatorioResumo);
administrativoRouter.get("/relatorios/evolucao", c.relatorioEvolucao);
administrativoRouter.get("/relatorios/executivo", c.relatorioExecutivo);
administrativoRouter.get("/relatorios/lucratividade", c.relatorioLucratividade);

// Qualquer outra coisa sob /administrativo é 404 em JSON.
administrativoRouter.use('/desenvolvimento', desenvolvimentoRouter);
administrativoRouter.use(c.naoEncontrado);
