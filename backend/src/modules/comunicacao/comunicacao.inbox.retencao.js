// Retenção REAL do texto da caixa de entrada da Central (30 dias por padrão).
// Três camadas: (1) leitura nunca passa do corte (dentroDaRetencao); (2) purga oportunista dentro do registro (SQL 096); (3) ESTA — purga PERIÓDICA
// no processo web, independente de haver tráfego novo e independente do worker de automação (que pode estar desligado).
// Sem setInterval: o próximo tick só é agendado depois que o anterior termina. Timer com unref (nunca segura o processo). Falha NUNCA derruba o servidor.
import { purgarVencidas, retencaoDias } from "./comunicacao.inbox.repo.js";

const PADRAO_MIN = 360;      // a cada 6 h
const PRIMEIRA_MS = 90_000;  // 1º passe 90 s após o boot (não disputa a subida)

/** Intervalo em minutos (COMUNICACAO_INBOX_PURGA_INTERVALO_MIN; 0 = desligada; padrão 360; limitado a 5..1440). */
export function intervaloPurgaMin(env = process.env) {
  const bruto = String(env.COMUNICACAO_INBOX_PURGA_INTERVALO_MIN ?? "").trim();
  if (bruto === "") return PADRAO_MIN;
  const n = Number(bruto);
  if (!Number.isFinite(n)) return PADRAO_MIN;
  if (n <= 0) return 0;
  return Math.min(1440, Math.max(5, Math.trunc(n)));
}

/** Um passe de purga (esgota os lotes até 10 por passe). Devolve o total removido; nunca lança. */
export async function executarPurga({ log = () => {}, deps = {} } = {}) {
  let total = 0;
  try {
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const n = await purgarVencidas({ dias: retencaoDias(deps.env ?? process.env) }, deps);
      total += n;
      if (n < 5000) break;
    }
    log("info", "comunicacao.inbox_purga", { removidas: total });
  } catch (e) {
    log("warn", "comunicacao.inbox_purga_falhou", { erro: String(e?.message ?? e).slice(0, 200) });
  }
  return total;
}

/** Liga a purga periódica. Devolve `{ ativa, parar }`. */
export function iniciarPurgaPeriodica({ env = process.env, log = () => {}, deps = {}, primeiraMs = PRIMEIRA_MS } = {}) {
  const min = intervaloPurgaMin(env);
  if (min === 0) return { ativa: false, parar() {} };
  let timer = null; let parado = false;
  const agendar = (ms) => {
    if (parado) return;
    timer = setTimeout(async () => { await executarPurga({ log, deps: { ...deps, env } }); agendar(min * 60_000); }, ms);
    timer.unref?.();
  };
  agendar(primeiraMs);
  return { ativa: true, parar() { parado = true; if (timer) clearTimeout(timer); } };
}
