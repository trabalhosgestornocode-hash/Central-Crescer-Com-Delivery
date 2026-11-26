// INTEGRAÇÃO do Financeiro v2 com a plataforma (Execução 10) — ponto ÚNICO importado por src/routes.js.
//
// DESLIGADO POR PADRÃO. Só liga com FV2_HABILITADO=1 E toda a configuração presente; faltando qualquer peça, fica
// desligado (falha fechada) e a plataforma segue com o financeiro atual. Variáveis (segredos fora do Git):
//   FV2_HABILITADO=1
//   FV2_APP_DATABASE_URL   conexão do papel de login da APLICAÇÃO (membro de fv2_app; nunca postgres/service_role)
//   FV2_GATEWAY_URL        endereço do gateway de autoridade (serviço separado; HTTPS fora de localhost)
//   FV2_GATEWAY_CHAVE      chave do canal assinado com o gateway (≥ 32 caracteres)
//   FV2_PG_CA              (opcional) certificado-raiz PEM do banco, para TLS verificado
//   FV2_APP_POOL_MAX       (opcional) padrão 4 — o banco do projeto tem 60 conexões no total
//   FV2_ESCRITA_HABILITADA=1      (opcional) libera as AÇÕES; sem ela, só consulta
//   FV2_HOMOLOGACAO_HABILITADA=1  (opcional) só depois da matriz 24a aprovada; homologar exige ainda 2º fator recente
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { criarAdaptadorDaPlataforma, criarAdministracaoCorporativaPostgres, criarConcessoesDoRepositorio, criarNucleoFinanceiro, criarLiberacoesPostgres, criarRepositorioPostgres } from "../financeiro-v2/index.js";
import { criarOperacionalMova } from "./operacionalMova.js";
import { criarClienteDoGateway } from "./clienteGateway.js";
import { criarAutoridadeCoLocalizada } from "./autoridadeCoLocalizada.js";
import { criarMfaPeloProvedor } from "./mfaPeloProvedor.js";
import { criarAdministracaoDaPlataforma, criarConcessoesDaSessao, criarVinculosDaPlataforma } from "./portasPlataforma.js";
import { criarRotasFinanceiroV2 } from "./rotas.js";
import { criarFonteEntregadores } from "./fonteEntregadores.js";
import { criarCofreNotasSupabase } from "./cofreNotasSupabase.js";
import { criarCofreDocumentosSupabase } from "./cofreDocumentos.js";
import { criarVerificadorClamd, verificadorDesligado } from "./verificadorAntimalware.js";
import { criarAgendadorEntregadores, executarCiclo, lerConfiguracaoDoAgendador } from "./agendadorEntregadores.js";
import { lerConfiguracaoMova, movaDaPlataforma, registrarDependenciasFv2 } from "./mova.js";
export { iniciarMovaEmbutido, pararMovaEmbutido } from "./mova.js";

/** Marca o trecho executado pelo agendador: só ele recebe sessão de banco da identidade de automação. */
const automacao = new AsyncLocalStorage();
export function configuracaoDeEntregadores({ supabase, env = process.env }) {
  const inicio = String(env.FV2_ENTREGADORES_INICIO ?? "");
  const valido = /^\d{4}-\d{2}-\d{2}$/.test(inicio) && new Date(`${inicio}T12:00:00Z`).getUTCDay() === 1;
  // Notas fiscais só com bucket privado configurado E aceite explícito de operar sem antimalware (decisão do proprietário).
  const cofreDeNotas = env.FV2_ENTREGADORES_BUCKET && env.FV2_ENTREGADORES_COFRE_ACEITO === "1" ? criarCofreNotasSupabase({ supabase, bucket: env.FV2_ENTREGADORES_BUCKET }) : null;
  return { fonte: criarFonteEntregadores({ db: supabase }), inicioDaOperacao: valido ? inicio : null, cofreDeNotas };
}

/**
 * Cofre de DOCUMENTOS do Financeiro (comprovantes que o MOVA anexa às contas): bucket PRIVADO (FV2_DOCUMENTOS_BUCKET) com quarentena e
 * verificação antimalware (CLAMAV_HOST/CLAMAV_PORT; sem eles os arquivos ficam em quarentena e não são abertos). Sem bucket ⇒ null:
 * quem exige o cofre recusa com FV2_COFRE_INDISPONIVEL e a proposta fica guardada.
 */
export function cofreDeDocumentosDaPlataforma({ supabase, env = process.env, registrar = () => {} }) {
  if (!env.FV2_DOCUMENTOS_BUCKET) return null;
  const scanner = env.CLAMAV_HOST ? criarVerificadorClamd({ host: env.CLAMAV_HOST, porta: Number(env.CLAMAV_PORT) || 3310 }) : verificadorDesligado;
  return criarCofreDocumentosSupabase({ supabase, bucket: env.FV2_DOCUMENTOS_BUCKET, scanner, registrar });
}

export { criarRotasFinanceiroV2 } from "./rotas.js";

// Dois modos de autoridade: "servico" (gateway separado, isolamento de processo) ou "local" (co-localizada no backend,
// decisão do proprietário de 14/11: um só serviço no Render; isolamento só de credencial — ver autoridadeCoLocalizada.js).
const OBRIGATORIAS = { servico: ["FV2_APP_DATABASE_URL", "FV2_GATEWAY_URL", "FV2_GATEWAY_CHAVE"], local: ["FV2_APP_DATABASE_URL", "FV2_AUTORIDADE_DATABASE_URL", "FV2_AUTORIDADE_COLOCALIZADA_ACEITA"] };

/** Lê a configuração (sem imprimir valores). */
export function lerConfiguracaoFv2(env = process.env) {
  if (env.FV2_HABILITADO !== "1") return { habilitado: false, motivo: "DESLIGADO" };
  const modo = env.FV2_AUTORIDADE_MODO === "local" ? "local" : "servico";
  const faltando = OBRIGATORIAS[modo].filter((k) => !env[k]);
  if (faltando.length) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando };
  if (modo === "servico" && String(env.FV2_GATEWAY_CHAVE).length < 32) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando: ["FV2_GATEWAY_CHAVE"] };
  if (modo === "local" && env.FV2_AUTORIDADE_COLOCALIZADA_ACEITA !== "1") return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando: ["FV2_AUTORIDADE_COLOCALIZADA_ACEITA"] };
  if (modo === "local" && env.FV2_AUTORIDADE_DATABASE_URL === env.FV2_APP_DATABASE_URL) return { habilitado: false, motivo: "CREDENCIAIS_IGUAIS", faltando: [] };
  return { habilitado: true, modo, ...(modo === "local" ? { autoridadeUrl: env.FV2_AUTORIDADE_DATABASE_URL } : {}), escritaHabilitada: env.FV2_ESCRITA_HABILITADA === "1", homologacaoHabilitada: env.FV2_HOMOLOGACAO_HABILITADA === "1", appUrl: env.FV2_APP_DATABASE_URL, gatewayUrl: env.FV2_GATEWAY_URL, gatewayChave: env.FV2_GATEWAY_CHAVE, ca: env.FV2_PG_CA ?? null, poolMax: Math.min(Number(env.FV2_APP_POOL_MAX ?? 4) || 4, 8) };
}

/**
 * Router de produção. `supabase` = cliente do servidor da plataforma (vínculos + validação do token no Auth).
 * @param {{supabase:object, env?:object, registrar?:Function}} p
 */
export function criarFinanceiroV2DaPlataforma({ supabase, env = process.env, registrar = () => {} }) {
  const cfg = lerConfiguracaoFv2(env);
  if (!cfg.habilitado && cfg.motivo === "CONFIGURACAO_INCOMPLETA") registrar({ tipo: "FV2_DESLIGADO_POR_CONFIGURACAO", faltando: cfg.faltando });
  let compartilhadas = null;
  const montar = () => {
    const ssl = cfg.ca ? { ca: cfg.ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
    const pool = new pg.Pool({ connectionString: cfg.appUrl, max: cfg.poolMax, idleTimeoutMillis: 30000, ssl });
    pool.on("error", () => {});
    const obterUsuario = async (token) => {
      const { data, error } = await supabase.auth.getUser(token);
      return error ? null : data?.user ?? null;
    };
    const mfa = criarMfaPeloProvedor({ obterUsuario });
    let sessoes;
    let poolAutoridade = null;
    if (cfg.modo === "local") {
      // pool PRÓPRIO da autoridade (outro papel de login, máx. 2 conexões) — nunca o pool da aplicação
      poolAutoridade = new pg.Pool({ connectionString: cfg.autoridadeUrl, max: 2, idleTimeoutMillis: 30000, ssl });
      poolAutoridade.on("error", () => {});
      const autoridade = criarAutoridadeCoLocalizada({ poolAutoridade, obterUsuario, mfa, registrar });
      // Agendador: sem requisição de pessoa. O BANCO continua exigindo concessão ativa da identidade de automação (FV020).
      // Trabalho SEM pessoa (agendador de entregadores, worker do MOVA): sessão pela função do banco, que exige concessão ATIVA
      // da identidade na unidade. A referência identifica a automação na trilha (fv2_sessao_banco.referencia).
      sessoes = { ...autoridade, emitir: async (e) => { const loja = automacao.getStore(); return loja
        ? (await poolAutoridade.query("select fv2_abrir_sessao($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as t", [e.usuarioId, e.organizacaoId, e.unidadeId, 300, loja === true ? "automacao:entregadores" : loja.referencia])).rows[0].t
        : autoridade.emitir(e); } };
    } else {
      sessoes = criarClienteDoGateway({ url: cfg.gatewayUrl, chave: cfg.gatewayChave });
    }
    const repositorio = criarRepositorioPostgres({ pool, sessoes });
    const vinculos = criarVinculosDaPlataforma(supabase);
    const liberacoes = criarLiberacoesPostgres({ poolApp: pool });
    const adaptador = criarAdaptadorDaPlataforma({ liberacoes, vinculos, concessoes: criarConcessoesDaSessao({ repositorio }), mfa });
    return { repositorio, adaptador, vinculos, liberacoes, mfa, poolAutoridade, comAutomacaoMova: (fn) => automacao.run({ referencia: "automacao:mova" }, fn),
      // Execução 17: identidade OPERACIONAL do MOVA (só usada com MOVA_OPERACAO_ESCRITA=1; sessão própria, concessão no banco).
      operacionalMova: criarOperacionalMova({ cofre: cofreDeDocumentosDaPlataforma({ supabase, env, registrar }), repositorio, rodar: (fn) => automacao.run({ referencia: "automacao:mova-operacional" }, fn), criarNucleoFinanceiro, criarConcessoesDoRepositorio }), administracao: criarAdministracaoDaPlataforma(supabase), corporativo: poolAutoridade ? criarAdministracaoCorporativaPostgres(poolAutoridade) : null, entregadores: configuracaoDeEntregadores({ supabase, env }) };
  };
  const dependencias = () => (compartilhadas ??= montar());
  dependenciasDaPlataforma = dependencias;
  registrarDependenciasFv2(dependencias);
  // MOVA: só com MOVA_HABILITADO=1 (e o restante da configuração); senão as rotas /mova respondem 404.
  const movaCfg = lerConfiguracaoMova(env);
  const mova = movaCfg.habilitado ? async () => { const m = await movaDaPlataforma({ env, registrar }); return m ? { ...m, chaves: { modo: movaCfg.modo, recebimento: movaCfg.recebimento, processamento: movaCfg.processamento, ia: movaCfg.ia, envio: movaCfg.envio } } : null; } : null;
  return criarRotasFinanceiroV2({
    mova,
    habilitado: cfg.habilitado,
    escritaHabilitada: cfg.habilitado && cfg.escritaHabilitada === true,
    homologacaoHabilitada: cfg.habilitado && cfg.homologacaoHabilitada === true,
    // ativação (administrador inicial + liberação da unidade): ligar SÓ para ativar e desligar em seguida
    provisionamentoHabilitado: cfg.habilitado && env.FV2_PROVISIONAMENTO_HABILITADO === "1",
    registrar,
    dependencias,
    // 24/11: beneficiário FIXO da concessão operacional do MOVA pelo administrador corporativo (nunca vem do formulário).
    movaIdentidadeOperacional: env.MOVA_IDENTIDADE_OPERACIONAL ?? null,
  });
}

let dependenciasDaPlataforma = null;
let agendadorEntregadores = null;
/** Chamado pelo server.js depois do listen. Desligado por padrão; nunca rejeita e nunca derruba o backend. */
export async function iniciarEntregadoresEmbutido({ env = process.env, log = () => {}, efeitosPermitidos = false } = {}) {
  const cfg = lerConfiguracaoDoAgendador(env);
  if (!cfg.habilitado) return { habilitado: false, motivo: cfg.motivo };
  if (!efeitosPermitidos) return { habilitado: false, motivo: "EFEITOS_EXTERNOS_BLOQUEADOS" };
  if (!dependenciasDaPlataforma) return { habilitado: false, motivo: "ROTAS_NAO_MONTADAS" };
  if (agendadorEntregadores) return { habilitado: true };
  const obter = dependenciasDaPlataforma;
  agendadorEntregadores = criarAgendadorEntregadores({ executar: () => executarCiclo({
    unidades: cfg.unidades, registrar: (e) => log("info", "fv2.entregadores_ciclo", e), comAutomacao: (fn) => automacao.run(true, fn),
    unidadeLiberada: async (u) => (await obter().liberacoes.consultar(u)).escrita === true,
    criarNucleo: (u) => criarNucleoFinanceiro({ repositorio: obter().repositorio, exigirConcessaoPersistida: true, entregadores: obter().entregadores, escoposAutorizados: [{ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId }] }),
  }) });
  agendadorEntregadores.iniciar();
  return { habilitado: true };
}
export const pararEntregadoresEmbutido = () => agendadorEntregadores?.parar() ?? Promise.resolve();
