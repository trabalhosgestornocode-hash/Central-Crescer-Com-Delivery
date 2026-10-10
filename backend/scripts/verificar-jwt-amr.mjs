// Verifica, SEM exibir nem gravar o token, se um access token do Supabase traz o carimbo de autenticação que a renovação
// do perfil de exibição usa (amr[].timestamp, em segundos). Só lê — não chama rede, não altera nada.
//
// Como usar (o token entra pela ENTRADA PADRÃO, nunca como argumento — argumentos ficam no histórico do terminal):
//   1. No navegador logado numa conta DE TESTE, no console (o copy() não imprime o valor):
//        copy(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /^sb-.*-auth-token$/.test(k)))).access_token)
//   2. PowerShell:   Get-Clipboard | node backend/scripts/verificar-jwt-amr.mjs
//      (NÃO use --env-file: o script não precisa de nenhuma variável e não deve receber as de produção.)
// Rode DE NOVO com um token emitido depois de um refresh (≥ 1 h depois): o "autenticado há" deve CONTINUAR contando desde o
// login, não reiniciar. Se reiniciar, a janela de 20 h seria renovada a cada refresh e a política precisa ser revista.
import { carimboDeAutenticacao } from "../src/shared/carimboAutenticacao.js";   // função pura: NÃO carrega .env nem segredos

// Opcional (2ª execução, depois do refresh): --carimbo-esperado=<instante UTC impresso na 1ª execução>  →  imprime ESTÁVEL/INSTÁVEL.
const esperadoArg = process.argv.find((a) => a.startsWith("--carimbo-esperado="))?.split("=")[1];
const iatAnteriorArg = process.argv.find((a) => a.startsWith("--iat-anterior="))?.split("=")[1];

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const jwt = Buffer.concat(chunks).toString("utf8").trim().replace(/^Bearer\s+/i, "");
const partes = jwt.split(".");
if (partes.length !== 3) { console.log("Entrada não parece um JWT (esperado 3 partes separadas por ponto)."); process.exit(2); }

let payload;
try { payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")); } catch { console.log("Payload ilegível."); process.exit(2); }

const agora = Date.now();
const min = (ms) => Math.round(ms / 60_000);
const amr = payload.amr;
const formato = !Array.isArray(amr) ? "AUSENTE" : amr.every((m) => typeof m === "object" && m) ? "objetos {method, timestamp}" : amr.every((m) => typeof m === "string") ? "strings (sem timestamp)" : "misto";
const carimbo = carimboDeAutenticacao(amr);

console.log("Claims presentes (nomes apenas):", Object.keys(payload).sort().join(", "));
console.log("amr:", formato, Array.isArray(amr) ? `(${amr.length} entrada(s); métodos: ${amr.map((m) => (typeof m === "string" ? m : m?.method)).join(", ")})` : "");
console.log("aal:", payload.aal ?? "ausente");
console.log("emitido (iat) há:", Number.isFinite(payload.iat) ? `${min(agora - payload.iat * 1000)} min` : "ausente");
console.log("expira (exp) em:", Number.isFinite(payload.exp) ? `${min(payload.exp * 1000 - agora)} min` : "ausente");
if (carimbo === null) {
  console.log("RESULTADO: SEM carimbo utilizável — a renovação NÃO funcionará (fail-closed: valem as 8 h).");
  process.exit(1);
}
console.log("carimbo de autenticação (UTC):", new Date(carimbo).toISOString(), "— compare entre o login e o pós-refresh: tem que ser O MESMO instante");
console.log("claim session_id presente:", typeof payload.session_id === "string" && payload.session_id ? "sim" : "não", "(só a presença; o valor não é impresso)");
if (esperadoArg) {
  const esperadoMs = Date.parse(esperadoArg);
  if (!Number.isFinite(esperadoMs)) { console.log("--carimbo-esperado inválido (use o instante UTC impresso na 1ª execução, ex.: 2026-10-11T14:00:00.000Z)."); process.exit(2); }
  const iguais = Math.abs(esperadoMs - carimbo) < 1000;   // tolerância de 1 s (o carimbo é em segundos)
  const iatNovo = Number.isFinite(payload.iat) ? payload.iat * 1000 : null;
  const iatAnt = iatAnteriorArg ? Date.parse(iatAnteriorArg) : null;
  const houveRefresh = iatAnt === null ? null : (iatNovo !== null && iatNovo > iatAnt + 60_000);
  console.log("COMPARAÇÃO:", iguais ? "ESTÁVEL — o carimbo de autenticação NÃO mudou" : "INSTÁVEL — o carimbo MUDOU (o teto de 20 h NÃO é confiável)", houveRefresh === null ? "(informe --iat-anterior para confirmar que houve refresh)" : (houveRefresh ? "| houve refresh (iat avançou)" : "| ATENÇÃO: iat NÃO avançou — talvez ainda seja o mesmo token; o teste não prova nada"));
  console.log("iat (emissão) deste token (UTC):", iatNovo ? new Date(iatNovo).toISOString() : "ausente");
  process.exit(iguais && houveRefresh !== false ? 0 : 1);
}
console.log(`RESULTADO: carimbo OK — autenticado há ${min(agora - carimbo)} min; limite de 20 h em ${min(carimbo + 20 * 3_600_000 - agora)} min.`);
