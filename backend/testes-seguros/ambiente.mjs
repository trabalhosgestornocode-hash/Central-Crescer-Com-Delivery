// Ambiente FICTÍCIO e montagem dos comandos do T1. Módulo puro (sem I/O): usado pelo executor, pela guarda e pelos testes.
//
// Princípio: o ambiente de teste é CONSTRUÍDO do zero (lista de permissão), nunca "herdado e limpo". Qualquer variável do
// shell do desenvolvedor — inclusive credenciais de produção — simplesmente não chega ao processo de teste.

/** Valores fictícios. Nenhum aponta para um host real: a porta 9 (discard) em loopback recusa a conexão. */
export const FICTICIO = Object.freeze({
  NODE_ENV: "test",
  TESTE_SEGURO: "1",
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: "chave-ficticia-teste-seguro-nao-e-real",
  SUPABASE_ANON_KEY: "chave-ficticia-anon-teste-seguro-nao-e-real",
});

/** Únicas variáveis herdadas do ambiente real (o que o Node/Windows precisam para existir). Nenhuma é credencial. */
export const HERDAVEIS = Object.freeze([
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
]);

/**
 * @param {NodeJS.ProcessEnv} real ambiente do processo que chama
 * @param {{ guardaUrl: string, logPath?: string, modoProva?: boolean, extra?: Record<string,string> }} o
 * @returns {Record<string,string>}
 */
export function montarEnvFicticio(real, { guardaUrl, logPath, modoProva = false, extra = {} }) {
  const env = {};
  for (const k of HERDAVEIS) if (real[k] !== undefined) env[k] = real[k];
  Object.assign(env, FICTICIO, extra);
  env.NODE_OPTIONS = `--import ${guardaUrl}`;   // vale também para qualquer `node` filho que ignore execArgv
  if (logPath) env.TESTE_SEGURO_LOG = logPath;
  if (modoProva) env.TESTE_SEGURO_MODO_PROVA = "1";
  return env;
}

/** Flags de execução. NUNCA inclui --env-file / --env-file-if-exists. */
export function montarArgsNode({ guardaUrl, arquivos, concorrencia = null }) {
  const args = ["--experimental-vm-modules", "--import", guardaUrl, "--test"];
  if (concorrencia) args.push(`--test-concurrency=${concorrencia}`);
  return [...args, ...arquivos];
}

/** true se algum argumento carregaria um arquivo .env (proibido no T1). */
export const carregaArquivoEnv = (argv) => argv.some((a) => /^--env-file(-if-exists)?(=|$)/.test(String(a)));

/** Um valor de ambiente que parece credencial/host real? Usado pela guarda no arranque (falha fechada). */
export function pareceCredencialReal(nome, valor) {
  const v = String(valor ?? "");
  if (!v) return false;
  if (/supabase\.(co|in|net)\b/i.test(v)) return true;
  if (/^eyJ[\w-]{15,}\.[\w-]{15,}\.[\w-]{8,}$/.test(v)) return true;                       // JWT
  if (/^(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\//i.test(v)) {
    try { return !hostFicticio(new URL(v).hostname); } catch { return true; }
  }
  if (/(^|_)(SERVICE_ROLE_KEY|SECRET|TOKEN|PASSWORD|API_KEY)$/i.test(nome) && !/ficticia|fake|dummy|teste/i.test(v)) return true;
  if (nome === "SUPABASE_URL") { try { return !hostFicticio(new URL(v).hostname); } catch { return true; } }
  return false;
}

/** Host de loopback/reservado para testes. */
export function hostLocal(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(h)
    || h.endsWith(".localhost");
}

/** Host aceitável como VALOR de configuração fictícia (loopback ou domínio reservado .invalid, que nunca resolve). */
export const hostFicticio = (host) => hostLocal(host) || String(host ?? "").toLowerCase().endsWith(".invalid");
