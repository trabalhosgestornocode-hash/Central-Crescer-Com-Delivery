// MONTAGEM do MOVA na integração do Financeiro v2. É AQUI — a única camada autorizada a importar o núcleo — que o MOVA recebe
// o contrato do Financeiro e um núcleo de leitura com a identidade de serviço.
//
// Execução 05 — o MOVA roda num BACKEND DE HOMOLOGAÇÃO SEPARADO (outro serviço, outro banco). O backend de produção não liga MOVA.
// TUDO DESLIGADO POR PADRÃO. Variáveis (o ambiente chega SEMPRE por parâmetro; só o index lê o ambiente do processo):
//   MOVA_HABILITADO=1                 base (rotas do Centro Financeiro)
//   MOVA_DATABASE_URL                 banco MOVA (papel de login membro de mova_app)
//   MOVA_SERVICO_USUARIO_ID           identidade de serviço das leituras (concessão financeiro_v2.ver nas unidades de TESTE)
//   MOVA_MODO=HOMOLOGACAO + MOVA_AMBIENTE=homologacao + MOVA_HOMOLOGACAO_MARCADOR=<segredo curto>
//                                     homologação: o banco MOVA E o banco do Financeiro precisam ter o comentário
//                                     `MOVA_HOMOLOGACAO:<marcador>` (o de produção não tem ⇒ recusa)
//   MOVA_GATEWAY_SECRET               segredo HMAC do canal isolado Gateway ⇄ MOVA (≠ WHATSAPP_GATEWAY_SECRET)
//   MOVA_GATEWAY_URL                  endereço do Gateway para o envio das respostas (rota /internal/mova/messages)
//   MOVA_RECEBIMENTO_HABILITADO=1     rota /internal/mova/eventos/mova-grupo
//   MOVA_PROCESSAMENTO_HABILITADO=1   worker da fila (exige recebimento)
//   MOVA_IA_HABILITADA=1              Claude (ANTHROPIC_API_KEY) — exige processamento; orçamento persistente obrigatório
//   MOVA_ENVIO_HABILITADO=1           respostas (exige processamento e MOVA_GATEWAY_URL)
//   MOVA_SUSPENSO=1                   desliga TUDO (vence qualquer outra)
//   MOVA_RELE_DATABASE_URL            (homologação) fila durável do relé (papel mova_rele_consumidor); com recebimento ligado,
//                                     o backend CONSOME o relé em vez de receber direto do Gateway (Execução 11)
//   MOVA_PG_CA                        CA do provedor do banco (PEM); na falta, usa FV2_PG_CA. TLS nunca deixa de ser verificado
// Além das variáveis, a tabela mova.controle desliga cada etapa NA HORA (sem reiniciar nada) — reversão funcional.
import { Router } from "express";
import express from "express";
import pg from "pg";
import { ACAO, ErroFinanceiro, comandos, criarNucleoFinanceiro, planoDeContas } from "../financeiro-v2/index.js";
import {
  MODELOS_PERMITIDOS, carregarConfiguracao, criarRedator, ehConversaPrivada, clienteComOrcamento, criarConsumidorRele, criarControle, criarEnviadorDeRespostas, criarExtratorAnthropic, criarMova, criarOrcamentoIa, criarWorker, validarConfiguracao,
} from "../mova-financeiro/index.js";
import { LIMITE_CORPO_MOVA_BYTES, ROTA_EVENTO_MOVA, criarRotaEventosMova } from "../mova-financeiro/gateway/rota.js";
import { assinarRequisicao, exigirHmac } from "../comunicacao/gateway/whatsappGateway.hmac.js";

export const CONTRATO_FINANCEIRO = Object.freeze({ ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sim = (v) => v === "1";

/** Lê a configuração (nunca imprime valores). Ausente, inválida ou CONTRADITÓRIA ⇒ desligado com motivo. */
export function lerConfiguracaoMova(env) {
  if (env.MOVA_HABILITADO !== "1") return { habilitado: false, motivo: "DESLIGADO" };
  if (sim(env.MOVA_SUSPENSO)) return { habilitado: false, motivo: "SUSPENSO" };
  const faltando = ["MOVA_DATABASE_URL", "MOVA_SERVICO_USUARIO_ID"].filter((k) => !env[k]);
  if (faltando.length) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando };
  if (!UUID.test(env.MOVA_SERVICO_USUARIO_ID)) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando: ["MOVA_SERVICO_USUARIO_ID"] };
  const recebimento = sim(env.MOVA_RECEBIMENTO_HABILITADO);
  const processamento = sim(env.MOVA_PROCESSAMENTO_HABILITADO);
  const ia = sim(env.MOVA_IA_HABILITADA);
  const envio = sim(env.MOVA_ENVIO_HABILITADO);
  const contradicoes = [];
  // Modo: HOMOLOGACAO precisa das três confirmações; qualquer sinal parcial é contradição (nunca cai em outro modo em silêncio).
  const sinaisHomolog = [env.MOVA_MODO === "HOMOLOGACAO", env.MOVA_AMBIENTE === "homologacao", Boolean(env.MOVA_HOMOLOGACAO_MARCADOR)];
  const homologacao = sinaisHomolog.every(Boolean);
  if (sinaisHomolog.some(Boolean) && !homologacao) contradicoes.push("HOMOLOGACAO_INCOMPLETA");
  if (env.MOVA_MODO && !["HOMOLOGACAO", "SIMULACAO"].includes(env.MOVA_MODO)) contradicoes.push("MODO_DESCONHECIDO");
  if (homologacao && !/^[A-Za-z0-9_-]{12,64}$/.test(env.MOVA_HOMOLOGACAO_MARCADOR)) contradicoes.push("MARCADOR_INVALIDO");
  if (processamento && !recebimento) contradicoes.push("PROCESSAMENTO_SEM_RECEBIMENTO");
  if (ia && !processamento) contradicoes.push("IA_SEM_PROCESSAMENTO");
  if (envio && !processamento) contradicoes.push("ENVIO_SEM_PROCESSAMENTO");
  if (envio && !env.MOVA_GATEWAY_URL) contradicoes.push("ENVIO_SEM_GATEWAY");
  // 15A: envio exige o MARCO de ativação (ISO UTC): respostas criadas antes dele nunca são enviadas (nada retroativo).
  const envioNaoAntesDe = env.MOVA_ENVIO_NAO_ANTES_DE || null;
  if (envio && !(envioNaoAntesDe && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(envioNaoAntesDe))) contradicoes.push("ENVIO_SEM_MARCO");
  if ((recebimento || envio) && !(String(env.MOVA_GATEWAY_SECRET ?? "").length >= 32)) contradicoes.push("CANAL_SEM_SEGREDO");
  if (env.MOVA_GATEWAY_SECRET && env.MOVA_GATEWAY_SECRET === env.WHATSAPP_GATEWAY_SECRET) contradicoes.push("SEGREDO_IGUAL_AO_PRINCIPAL");
  if (env.MOVA_DATABASE_URL && env.FV2_APP_DATABASE_URL && env.MOVA_DATABASE_URL === env.FV2_APP_DATABASE_URL && !homologacao) contradicoes.push("BANCO_COMPARTILHADO_FORA_DA_HOMOLOGACAO");
  // Teto estrito por chamada (Execução 13B): as duas chaves juntas, inteiras e positivas; esforço opcional e de lista fechada.
  const tetoSaida = env.MOVA_IA_TETO_SAIDA, tetoEntrada = env.MOVA_IA_TETO_ENTRADA, tetoEsforco = env.MOVA_IA_TETO_ESFORCO || null;
  let teto = null;
  if (tetoSaida || tetoEntrada || tetoEsforco) {
    if (!/^[1-9][0-9]{1,5}$/.test(tetoSaida ?? "") || !/^[1-9][0-9]{1,6}$/.test(tetoEntrada ?? "") || (tetoEsforco && !["low", "medium", "high"].includes(tetoEsforco))) contradicoes.push("TETO_IA_INVALIDO");
    else teto = Object.freeze({ maxSaida: Number(tetoSaida), maxEntrada: Number(tetoEntrada), esforco: tetoEsforco });
  }
  // Modelo da IA: lista FECHADA (hoje só Claude Haiku 5.5, decisão do proprietário em 21/11/2026); vazio = o padrão (Haiku).
  const modeloIa = env.MOVA_IA_MODELO || null;
  if (modeloIa && !MODELOS_PERMITIDOS.includes(modeloIa)) contradicoes.push("MODELO_IA_NAO_PERMITIDO"); // só Haiku 5.5 (decisão 21/11)
  if (contradicoes.length) return { habilitado: false, motivo: "CONFIGURACAO_CONTRADITORIA", contradicoes };
  return {
    habilitado: true, databaseUrl: env.MOVA_DATABASE_URL, servicoUsuarioId: env.MOVA_SERVICO_USUARIO_ID.toLowerCase(),
    recebimento, processamento, ia, envio, modo: homologacao ? "HOMOLOGACAO" : "SIMULACAO", marcador: homologacao ? env.MOVA_HOMOLOGACAO_MARCADOR : null, teto, modeloIa, envioNaoAntesDe: envio ? envioNaoAntesDe : null, respostasNaturais: ia && sim(env.MOVA_RESPOSTAS_NATURAIS),
  };
}

/** Recusa (lança) se o banco não for o de HOMOLOGAÇÃO marcado. Banco de produção não tem o comentário ⇒ recusa. */
export async function exigirBancoDeHomologacao(pool, marcador) {
  const r = await pool.query("select shobj_description(d.oid, 'pg_database') as c from pg_database d where d.datname = current_database()");
  if (!marcador || r.rows[0]?.c !== `MOVA_HOMOLOGACAO:${marcador}`) throw Object.assign(new Error("Banco não é o de homologação do MOVA."), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" });
}

/** Extrator quando a IA está DESLIGADA: nada vai a provedor externo; o evento falha com código claro (não é transitório). */
export const EXTRATOR_DESLIGADO = Object.freeze({ async extrair() { throw Object.assign(new Error("IA_DESLIGADA"), { codigo: "IA_DESLIGADA" }); } });

/**
 * Monta o MOVA sobre o pool do schema `mova` e o repositório do Financeiro. Testável: tudo injetável.
 * @param {{cfg:object, pool:object, repositorio:object, verificarBancoFinanceiro?:() => Promise<void>, criarClienteIa?:() => object,
 *          enviarAoGateway?:Function, relogio?:() => Date, registrar?:Function}} p
 */
export async function montarMova({ cfg, pool, repositorio, verificarBancoFinanceiro = null, criarClienteIa = null, enviarAoGateway = null, relogio = () => new Date(), registrar = () => {}, comAutomacao = null }) {
  if (cfg.modo === "HOMOLOGACAO") {
    await exigirBancoDeHomologacao(pool, cfg.marcador);
    if (!verificarBancoFinanceiro) throw Object.assign(new Error("Sem verificação do banco do Financeiro."), { codigo: "BANCO_FINANCEIRO_NAO_VERIFICADO" });
    await verificarBancoFinanceiro(); // o Financeiro consultado também tem de ser o de homologação
  }
  const configuracao = validarConfiguracao(await carregarConfiguracao(pool, { identidadeServico: { usuarioId: cfg.servicoUsuarioId }, modo: cfg.modo ?? "SIMULACAO" }));
  const escopos = configuracao.unidades.map((u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId }));
  if (escopos.length === 0) throw Object.assign(new Error("Nenhuma conversa/unidade configurada."), { codigo: "SEM_CONFIGURACAO" });
  const nucleoBase = criarNucleoFinanceiro({ repositorio, exigirConcessaoPersistida: true, escoposAutorizados: escopos, relogio });
  // Leituras do worker (sem pessoa): cada chamada roda no contexto de AUTOMAÇÃO da plataforma, que abre a sessão de banco da
  // identidade de serviço só se ela tiver concessão ativa na unidade. Sem o contexto (testes/memória), o núcleo é usado direto.
  const nucleoServico = comAutomacao
    ? Object.freeze(Object.fromEntries(Object.entries(nucleoBase).map(([k, f]) => [k, typeof f === "function" ? (...a) => comAutomacao(() => f(...a)) : f])))
    : nucleoBase;
  const controle = criarControle({ pool });
  const orcamento = criarOrcamentoIa({ pool });
  let mova = null;
  const obterEvidencia = (ref) => mova.evidencias.obter(ref);
  const extrator = cfg.ia && criarClienteIa
    ? criarExtratorAnthropic({ cliente: clienteComOrcamento(criarClienteIa(), { orcamento, controle, teto: cfg.teto ?? null }), obterEvidencia, relogio, ...(cfg.modeloIa ? { modelo: cfg.modeloIa } : {}) })
    : EXTRATOR_DESLIGADO;
  // 15A: respostas naturais — desligadas por padrão; exigem IA ligada e passam pelo MESMO orçamento/teto do extrator.
  const redator = cfg.ia && cfg.respostasNaturais && criarClienteIa
    ? criarRedator({ cliente: clienteComOrcamento(criarClienteIa(), { orcamento, controle, teto: cfg.teto ?? null }), registrar })
    : null;
  mova = criarMova({ configuracao, nucleo: nucleoServico, concessoes: { listar: async () => [] }, financeiro: CONTRATO_FINANCEIRO, extrator, pool, relogio, registrar, controle, redator });
  const worker = cfg.processamento ? criarWorker({ receptor: mova.receptor, registrar }) : null;
  const enviador = criarEnviadorDeRespostas({ armazenamento: mova.armazenamento, controle, registrar,
    enviar: enviarAoGateway ?? (async () => { throw Object.assign(new Error("sem gateway"), { codigo: "GATEWAY_NAO_CONFIGURADO" }); }),
    habilitado: Boolean(cfg.envio && enviarAoGateway), naoAntesDe: cfg.envioNaoAntesDe ?? null,
    // Só conversas PRIVADAS autorizadas (homologação); grupo nunca recebe resposta nesta fase.
    destinosPermitidos: configuracao.gruposAutorizados.map((g) => g.grupoId).filter(ehConversaPrivada) });
  return { mova, worker, enviador, configuracao, controle, orcamento };
}

/** Cliente de envio pelo canal isolado do Gateway (rota /internal/mova/messages, segredo MOVA). */
export function criarEnvioPeloCanal({ gatewayUrl, segredo, fetchFn = (...a) => fetch(...a), timeoutMs = 15_000 }) {
  const caminho = "/internal/mova/messages";
  return async ({ grupoId, texto, idempotencia }) => {
    const corpo = JSON.stringify({ grupoJid: grupoId, texto, idempotencyKey: idempotencia });
    const headers = { ...assinarRequisicao({ segredo, metodo: "POST", caminho, corpo }), "Content-Type": "application/json" };
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try { r = await fetchFn(`${gatewayUrl.replace(/\/$/, "")}${caminho}`, { method: "POST", headers, body: corpo, signal: ctrl.signal }); }
    catch { throw Object.assign(new Error("gateway inalcançável"), { codigo: "GATEWAY_INALCANCAVEL" }); }
    finally { clearTimeout(t); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.providerMessageId) throw Object.assign(new Error("gateway recusou"), { codigo: j.error ?? `GATEWAY_${r.status}` });
    return { providerMessageId: j.providerMessageId };
  };
}

// ------------------------------------------------------------------ montagem da PLATAFORMA (preguiçosa, única por processo)
let instancia = null;
let obterDependenciasFv2 = null;
/** Chamado por criarFinanceiroV2DaPlataforma: entrega o repositório do Financeiro (mesma conexão e regras das rotas). */
export function registrarDependenciasFv2(fn) { obterDependenciasFv2 = fn; }

/** MOVA da plataforma, ou null (desligado/incompleto/recusado). Nunca derruba o backend. */
export async function movaDaPlataforma({ env, registrar = () => {} }) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !obterDependenciasFv2) return null;
  if (instancia) return instancia;
  instancia = (async () => {
    // TLS SEMPRE verificado; a CA do provedor (ex.: raiz do Supabase) vem de MOVA_PG_CA ou, na falta, de FV2_PG_CA.
    const ca = env.MOVA_PG_CA ?? env.FV2_PG_CA ?? null;
    const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4, idleTimeoutMillis: 30000, ssl });
    pool.on("error", () => {});
    const verificarBancoFinanceiro = async () => {
      const c = new pg.Client({ connectionString: env.FV2_APP_DATABASE_URL, ssl });
      await c.connect();
      try { await exigirBancoDeHomologacao(c, cfg.marcador); } finally { await c.end(); }
    };
    let criarClienteIa = null;
    if (cfg.ia) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); criarClienteIa = () => new Anthropic({ maxRetries: 1 }); }
    const enviarAoGateway = cfg.envio ? criarEnvioPeloCanal({ gatewayUrl: env.MOVA_GATEWAY_URL, segredo: env.MOVA_GATEWAY_SECRET }) : null;
    const dep = obterDependenciasFv2();
    return montarMova({ cfg, pool, repositorio: dep.repositorio, comAutomacao: dep.comAutomacaoMova ?? null, verificarBancoFinanceiro, criarClienteIa, enviarAoGateway, registrar });
  })().catch((e) => { instancia = null; registrar({ tipo: "MOVA_MONTAGEM_FALHOU", codigo: e?.codigo ?? e?.code ?? "ERRO" }); return null; });
  return instancia;
}

/**
 * Router ISOLADO do canal Gateway ⇄ MOVA (app.js monta em /internal/mova): HMAC com MOVA_GATEWAY_SECRET (nunca o segredo
 * principal). Só existe com MOVA habilitado e recebimento ligado; senão null (a rota não existe).
 */
export function criarRouterMovaIsolado(env, { obterMova = () => movaDaPlataforma({ env }) } = {}) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !cfg.recebimento) return null;
  const r = Router();
  r.use(express.raw({ type: "*/*", limit: LIMITE_CORPO_MOVA_BYTES }), exigirHmac(env.MOVA_GATEWAY_SECRET));
  const receptor = { async receber(payload, o) { const m = await obterMova(); return m ? m.mova.receptor.receber(payload, o) : { status: "INDISPONIVEL", motivo: "MOVA_NAO_MONTADO" }; } };
  r.use(criarRotaEventosMova({ receptor }));
  return r;
}

/** Compatibilidade (Execução 03): injeção no router do Gateway principal — não é mais usada pelo app.js. */
export function movaParaGateway(env) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !cfg.recebimento) return null;
  const receptor = { async receber(payload, o) { const m = await movaDaPlataforma({ env }); return m ? m.mova.receptor.receber(payload, o) : { status: "INDISPONIVEL", motivo: "MOVA_NAO_MONTADO" }; } };
  return { receptor, rota: criarRotaEventosMova, limiteBytes: LIMITE_CORPO_MOVA_BYTES, caminho: ROTA_EVENTO_MOVA };
}

let laco = null;
let consumidorRele = null;
/** Worker + enviador em laço (server.js, depois do listen). Desligado por padrão; nunca derruba o backend. */
export async function iniciarMovaEmbutido({ env, log = () => {} }) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado) return { habilitado: false, motivo: cfg.motivo };
  // Fase B: só recebimento pelo relé (sem processamento) também inicia — o consumidor enfileira no MOVA, o worker fica parado.
  if (!cfg.processamento && !(env.MOVA_RELE_DATABASE_URL && cfg.recebimento)) return { habilitado: false, motivo: "PROCESSAMENTO_DESLIGADO" };
  const m = await movaDaPlataforma({ env, registrar: (e) => log("warn", "mova.evento", e) });
  if (!m) return { habilitado: false, motivo: "MOVA_NAO_MONTADO" };
  m.worker?.iniciar();
  if (env.MOVA_RELE_DATABASE_URL && cfg.recebimento && !consumidorRele) {
    const ca = env.MOVA_PG_CA ?? env.FV2_PG_CA ?? null;
    const poolRele = new pg.Pool({ connectionString: env.MOVA_RELE_DATABASE_URL, max: 2, idleTimeoutMillis: 30000, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
    poolRele.on("error", () => {});
    consumidorRele = criarConsumidorRele({ pool: poolRele, receptor: m.mova.receptor, segredo: env.MOVA_GATEWAY_SECRET, controle: m.controle, registrar: (e) => log("warn", "mova.rele", e) });
    consumidorRele.iniciar();
  }
  if (m.enviador.habilitado && !laco) laco = setInterval(() => { m.enviador.enviarPendentes().catch(() => {}); }, 5000);
  return { habilitado: true, envio: m.enviador.habilitado, rele: Boolean(consumidorRele) };
}
export async function pararMovaEmbutido({ env }) {
  consumidorRele?.parar(); consumidorRele = null;
  if (laco) { clearInterval(laco); laco = null; }
  const m = instancia ? await instancia : null;
  m?.worker?.parar();
  void env;
}
