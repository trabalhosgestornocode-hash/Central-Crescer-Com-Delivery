// MONTAGEM do MOVA na integração do Financeiro v2 (Execução 03). É AQUI — a única camada autorizada a importar o núcleo —
// que o MOVA recebe o contrato do Financeiro e um núcleo de leitura com a identidade de serviço.
//
// TUDO DESLIGADO POR PADRÃO. Chaves SEPARADAS (cada uma só vale com MOVA_HABILITADO=1 e o banco configurado):
//   MOVA_HABILITADO=1              base: liga as rotas do Centro Financeiro (leitura) e a montagem
//   MOVA_DATABASE_URL              conexão do papel de login MEMBRO de mova_app (schema `mova`; nunca postgres/service_role)
//   MOVA_SERVICO_USUARIO_ID        identidade de serviço das consultas (precisa de concessão financeiro_v2.ver em cada unidade)
//   MOVA_CONFIG_IDENTIDADE         (opcional) usa o banco: grupos/unidades vêm de mova.grupo_autorizado/grupo_unidade ativos
//   MOVA_RECEBIMENTO_HABILITADO=1  monta a rota HMAC /eventos/mova-grupo no router do Gateway e o worker da fila
//   MOVA_IA_HABILITADA=1           provedor de IA real (Claude; chave pela variável padrão do SDK, ANTHROPIC_API_KEY). Sem ela,
//                                  nenhum conteúdo sai para provedor externo e as mensagens falham com "IA desligada".
//   MOVA_ENVIO_HABILITADO=1        envio das respostas pelo Gateway (o Gateway também precisa de WHATSAPP_MOVA_ENVIO_HABILITADO=1)
// Nada aqui é ligado em produção nesta execução. O ambiente chega sempre por parâmetro (regra de isolamento: só o index lê o ambiente do processo).
import pg from "pg";
import { ACAO, ErroFinanceiro, comandos, criarNucleoFinanceiro, planoDeContas } from "../financeiro-v2/index.js";
import {
  carregarConfiguracao, criarEnviadorDeRespostas, criarExtratorAnthropic, criarMova, criarWorker, validarConfiguracao,
} from "../mova-financeiro/index.js";
import { LIMITE_CORPO_MOVA_BYTES, ROTA_EVENTO_MOVA, criarRotaEventosMova } from "../mova-financeiro/gateway/rota.js";

export const CONTRATO_FINANCEIRO = Object.freeze({ ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lê a configuração (nunca imprime valores). */
export function lerConfiguracaoMova(env) {
  if (env.MOVA_HABILITADO !== "1") return { habilitado: false, motivo: "DESLIGADO" };
  const faltando = ["MOVA_DATABASE_URL", "MOVA_SERVICO_USUARIO_ID"].filter((k) => !env[k]);
  if (faltando.length) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando };
  if (!UUID.test(env.MOVA_SERVICO_USUARIO_ID)) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando: ["MOVA_SERVICO_USUARIO_ID"] };
  return {
    habilitado: true, databaseUrl: env.MOVA_DATABASE_URL, servicoUsuarioId: env.MOVA_SERVICO_USUARIO_ID.toLowerCase(),
    recebimento: env.MOVA_RECEBIMENTO_HABILITADO === "1", ia: env.MOVA_IA_HABILITADA === "1", envio: env.MOVA_ENVIO_HABILITADO === "1",
  };
}

/** Extrator quando a IA está DESLIGADA: nada vai a provedor externo; o evento falha com código claro (não é transitório). */
export const EXTRATOR_DESLIGADO = Object.freeze({ async extrair() { throw Object.assign(new Error("IA_DESLIGADA"), { codigo: "IA_DESLIGADA" }); } });

/**
 * Monta o MOVA sobre um pool do schema `mova` e as dependências do Financeiro v2 (repositório). Testável: tudo injetável.
 * @param {{cfg:object, pool:object, repositorio:object, criarClienteIa?:() => object, enviarAoGateway?:Function, relogio?:() => Date, registrar?:Function}} p
 */
export async function montarMova({ cfg, pool, repositorio, criarClienteIa = null, enviarAoGateway = null, relogio = () => new Date(), registrar = () => {} }) {
  const configuracao = validarConfiguracao(await carregarConfiguracao(pool, { identidadeServico: { usuarioId: cfg.servicoUsuarioId } }));
  const escopos = configuracao.unidades.map((u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId }));
  // Núcleo de LEITURA do serviço: concessão gravada obrigatória (o banco recusa sem financeiro_v2.ver na unidade).
  const nucleoServico = criarNucleoFinanceiro({ repositorio, exigirConcessaoPersistida: true, escoposAutorizados: escopos, relogio });
  let mova = null;
  const obterEvidencia = (ref) => mova.evidencias.obter(ref);
  const extrator = cfg.ia && criarClienteIa ? criarExtratorAnthropic({ cliente: criarClienteIa(), obterEvidencia, relogio }) : EXTRATOR_DESLIGADO;
  mova = criarMova({ configuracao, nucleo: nucleoServico, concessoes: { listar: async () => [] }, financeiro: CONTRATO_FINANCEIRO, extrator, pool, relogio, registrar });
  const worker = cfg.recebimento ? criarWorker({ receptor: mova.receptor, registrar }) : null;
  const enviador = criarEnviadorDeRespostas({ armazenamento: mova.armazenamento, enviar: enviarAoGateway ?? (async () => { throw Object.assign(new Error("sem gateway"), { codigo: "GATEWAY_NAO_CONFIGURADO" }); }), habilitado: cfg.envio && Boolean(enviarAoGateway), registrar });
  return { mova, worker, enviador, configuracao };
}

// ------------------------------------------------------------------ montagem da PLATAFORMA (preguiçosa, única por processo)
let instancia = null;
let obterDependenciasFv2 = null;
/** Chamado por criarFinanceiroV2DaPlataforma: entrega o repositório do Financeiro (mesma conexão e regras das rotas). */
export function registrarDependenciasFv2(fn) { obterDependenciasFv2 = fn; }

/** MOVA da plataforma, ou null (desligado/incompleto). Nunca derruba o backend. */
export async function movaDaPlataforma({ env, registrar = () => {} }) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !obterDependenciasFv2) return null;
  if (instancia) return instancia;
  instancia = (async () => {
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4, idleTimeoutMillis: 30000, ssl: { rejectUnauthorized: true } });
    pool.on("error", () => {});
    let criarClienteIa = null;
    if (cfg.ia) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); criarClienteIa = () => new Anthropic(); }
    let enviarAoGateway = null;
    if (cfg.envio && env.WHATSAPP_GATEWAY_URL && env.WHATSAPP_GATEWAY_SECRET) {
      const { criarBaileysGatewayProvider } = await import("../comunicacao/providers/baileysGateway.provider.js");
      const provider = criarBaileysGatewayProvider({ gatewayUrl: env.WHATSAPP_GATEWAY_URL, segredoHmac: env.WHATSAPP_GATEWAY_SECRET, env });
      enviarAoGateway = async ({ grupoId, texto, idempotencia }) => provider.sendTextGrupoMova({ grupoJid: grupoId, texto, idempotencyKey: idempotencia });
    }
    return montarMova({ cfg, pool, repositorio: obterDependenciasFv2().repositorio, criarClienteIa, enviarAoGateway, registrar });
  })().catch((e) => { instancia = null; registrar({ tipo: "MOVA_MONTAGEM_FALHOU", codigo: e?.codigo ?? e?.code ?? "ERRO" }); return null; });
  return instancia;
}

/**
 * Para o router do Gateway (app.js): só com MOVA_HABILITADO=1 e MOVA_RECEBIMENTO_HABILITADO=1. Senão null ⇒ a rota não existe.
 * O receptor é resolvido por requisição (montagem preguiçosa); indisponível ⇒ 503 (o Gateway reenvia).
 */
export function movaParaGateway(env) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !cfg.recebimento) return null;
  const receptor = { async receber(payload, o) { const m = await movaDaPlataforma({ env }); return m ? m.mova.receptor.receber(payload, o) : { status: "INDISPONIVEL", motivo: "MOVA_NAO_MONTADO" }; } };
  return { receptor, rota: criarRotaEventosMova, limiteBytes: LIMITE_CORPO_MOVA_BYTES, caminho: ROTA_EVENTO_MOVA };
}
