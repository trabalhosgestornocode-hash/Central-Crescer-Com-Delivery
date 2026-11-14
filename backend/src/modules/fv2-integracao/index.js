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
import pg from "pg";
import { criarAdaptadorDaPlataforma, criarLiberacoesPostgres, criarRepositorioPostgres } from "../financeiro-v2/index.js";
import { criarClienteDoGateway } from "./clienteGateway.js";
import { criarAutoridadeCoLocalizada } from "./autoridadeCoLocalizada.js";
import { criarMfaPeloProvedor } from "./mfaPeloProvedor.js";
import { criarConcessoesDaSessao, criarVinculosDaPlataforma } from "./portasPlataforma.js";
import { criarRotasFinanceiroV2 } from "./rotas.js";

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
  return criarRotasFinanceiroV2({
    habilitado: cfg.habilitado,
    escritaHabilitada: cfg.habilitado && cfg.escritaHabilitada === true,
    homologacaoHabilitada: cfg.habilitado && cfg.homologacaoHabilitada === true,
    registrar,
    dependencias: () => {
      const pool = new pg.Pool({ connectionString: cfg.appUrl, max: cfg.poolMax, idleTimeoutMillis: 30000, ssl: cfg.ca ? { ca: cfg.ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
      pool.on("error", () => {});
      const obterUsuario = async (token) => {
        const { data, error } = await supabase.auth.getUser(token);
        return error ? null : data?.user ?? null;
      };
      let sessoes;
      if (cfg.modo === "local") {
        // pool PRÓPRIO da autoridade (outro papel de login, máx. 2 conexões) — nunca o pool da aplicação
        const poolAutoridade = new pg.Pool({ connectionString: cfg.autoridadeUrl, max: 2, idleTimeoutMillis: 30000, ssl: cfg.ca ? { ca: cfg.ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
        poolAutoridade.on("error", () => {});
        sessoes = criarAutoridadeCoLocalizada({ poolAutoridade, obterUsuario, mfa: criarMfaPeloProvedor({ obterUsuario }), registrar });
      } else {
        sessoes = criarClienteDoGateway({ url: cfg.gatewayUrl, chave: cfg.gatewayChave });
      }
      const repositorio = criarRepositorioPostgres({ pool, sessoes });
      const vinculos = criarVinculosDaPlataforma(supabase);
      const adaptador = criarAdaptadorDaPlataforma({
        liberacoes: criarLiberacoesPostgres({ poolApp: pool }),
        vinculos,
        concessoes: criarConcessoesDaSessao({ repositorio }),
        mfa: criarMfaPeloProvedor({ obterUsuario }),
      });
      return { repositorio, adaptador, vinculos };
    },
  });
}
