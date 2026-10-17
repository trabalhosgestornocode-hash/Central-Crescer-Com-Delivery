// T3 — sonda do `amr` de um JWT REAL de projeto Supabase DESCARTÁVEL. Responde às três perguntas que o T1 não consegue responder
// (docs/gestao-financeira/05-checklist-homologacao-t3-mfa.md, seção G):
//   (a) o `amr[].timestamp` do segundo fator é o do EVENTO TOTP efetivo, e não o da criação da sessão?
//   (b) um refresh de token NÃO renova esse carimbo?
//   (c) a unidade é SEGUNDOS?
// Uso (cada etapa em um terminal, com o JWT numa variável de ambiente — nunca em arquivo, argumento, log ou commit):
//   T3_JWT="$(...)" node backend/testes-seguros/t3/amr_probe.mjs [rotulo]
// Não faz rede, não verifica assinatura (isso é do backend) e NUNCA imprime o token: só `aal`, os métodos do `amr` e idades.
// Roteiro sugerido, com um usuário DE TESTE do projeto descartável:
//   1) login por senha                      -> rotulo "senha"     (esperado: aal1, amr só com password)
//   2) verificar TOTP agora                 -> rotulo "totp"      (esperado: aal2; amr totp com timestamp ≈ agora)
//   3) aguardar ~11 min e refresh do token  -> rotulo "refresh"   (esperado: aal2 mantido; timestamp do totp INALTERADO ⇒ idade > 10 min ⇒ avaliarMfaRecente NEGA)
//   4) novo login + novo TOTP               -> rotulo "re-totp"   (esperado: timestamp novo ⇒ idade ≈ 0 ⇒ avaliarMfaRecente PERMITE)
import { avaliarMfaRecente, carimboDeSegundoFator, JANELA_MFA_RECENTE_MS } from "../../src/shared/mfaRecente.js";

const jwt = process.env.T3_JWT;
if (!jwt) { console.error("defina T3_JWT (JWT de um usuário de teste do projeto DESCARTÁVEL)"); process.exit(2); }
const partes = jwt.split(".");
if (partes.length !== 3) { console.error("T3_JWT não parece um JWT"); process.exit(2); }
let payload;
try { payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")); } catch { console.error("payload ilegível"); process.exit(2); }

const agora = Date.now();
const amr = Array.isArray(payload.amr) ? payload.amr : [];
const idadeS = (t) => (Number.isFinite(Number(t)) ? Math.round((agora - Number(t) * 1000) / 1000) : null);
const rotulo = process.argv[2] ?? "sem-rotulo";
console.log(`[${rotulo}] aal=${payload.aal ?? "?"}  iat=${payload.iat ? `${idadeS(payload.iat)}s atrás` : "?"}  exp em ${payload.exp ? `${Math.round(payload.exp - agora / 1000)}s` : "?"}  session_id presente=${typeof payload.session_id === "string"}`);
for (const m of amr) console.log(`  amr: método=${m.method}  timestamp=${m.timestamp} (${idadeS(m.timestamp)}s atrás se estiver em SEGUNDOS)`);
const mfaEm = carimboDeSegundoFator(amr);
console.log(`  segundo fator mais recente: ${mfaEm === null ? "nenhum" : `${Math.round((agora - mfaEm) / 1000)}s atrás`}`);
const r = avaliarMfaRecente({ aal: payload.aal ?? null, mfaEm }, agora, JANELA_MFA_RECENTE_MS);
console.log(`  avaliarMfaRecente (janela ${JANELA_MFA_RECENTE_MS / 60000} min): ${r.ok ? "PERMITE" : `NEGA (${r.codigo})`}`);
// sanidade da unidade: um timestamp em ms (13 dígitos) seria lido como segundos e ficaria no futuro distante -> NEGA; avisa.
for (const m of amr) if (Number(m.timestamp) > 1e11) console.log("  ⚠ timestamp parece estar em MILISSEGUNDOS: ajustar carimboDeSegundoFator antes de qualquer habilitação");
