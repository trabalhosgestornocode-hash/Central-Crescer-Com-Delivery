// Valida pelo PostgREST REAL do Supabase de TESTE que nada novo de 132–135 está exposto a quem só tem a chave PUBLICÁVEL (anon).
//
//   SUPABASE_TESTE_URL=https://wiqqsxnysbzhcrzrrean.supabase.co SUPABASE_TESTE_ANON=<chave publicável> \
//   node backend/testes-seguros/supabase-teste/validar_postgrest.mjs
//
// Recusa qualquer URL que não seja a do projeto de teste. Só faz GET (leitura) e chamadas RPC que o banco deve RECUSAR antes de
// executar (sem privilégio): nenhuma escrita acontece se a proteção estiver certa. Sai com código 1 se algo vier exposto.
const URL_TESTE = "https://wiqqsxnysbzhcrzrrean.supabase.co";
const base = (process.env.SUPABASE_TESTE_URL ?? "").replace(/\/+$/, "");
const chave = process.env.SUPABASE_TESTE_ANON ?? "";
if (base !== URL_TESTE) { console.error(`RECUSADO: só o projeto de teste (${URL_TESTE}).`); process.exit(2); }
if (!chave) { console.error("Defina SUPABASE_TESTE_ANON (chave publicável)."); process.exit(2); }

const H = { apikey: chave, Authorization: `Bearer ${chave}`, "Content-Type": "application/json" };
const TABELAS = ["usuarios_convites", "comunicacao_legado_snapshot", "comunicacao_destinatario_escopos", "comunicacao_termos",
  "comunicacao_convites", "comunicacao_desafios_titular", "comunicacao_consentimentos"];
const RPCS = {
  comunicacao_desafio_criar: { p_tipo: "gestao", p_convite_id: null, p_telefone_cifrado: "x", p_telefone_hmac: "0".repeat(64), p_codigo_hmac: "0".repeat(64), p_ip_hmac: null, p_simulado: true, p_chave_versao: 1 },
  usuarios_convite_consumir: { p_token_hash: "0".repeat(64), p_email_hmac: "0".repeat(64), p_usuario_id: "00000000-0000-4000-8000-000000000000" },
  comunicacao_revogar: {},
  comunicacao_ativar_selecao_por_escopo: { p_migracao_id: "00000000-0000-4000-8000-000000000000", p_universo: [], p_modulo_id: "x" },
  comunicacao_resolver_destinatarios_unidade: { p_organizacao_id: "00000000-0000-4000-8000-000000000000", p_unidade_id: "00000000-0000-4000-8000-000000000000", p_tipo_alerta: "dashboard_ifood_d1" },
};

let falhas = 0;
const exposto = (s) => s >= 200 && s < 300;
for (const t of TABELAS) {
  const r = await fetch(`${base}/rest/v1/${t}?select=*&limit=1`, { headers: H });
  const ok = !exposto(r.status);
  if (!ok) falhas++;
  console.log(`${ok ? "OK   " : "FALHA"} GET  ${t} → ${r.status}`);
}
for (const [fn, corpo] of Object.entries(RPCS)) {
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(corpo) });
  const ok = !exposto(r.status);
  if (!ok) falhas++;
  console.log(`${ok ? "OK   " : "FALHA"} RPC  ${fn} → ${r.status}`);
}
console.log(falhas ? `\n${falhas} item(ns) EXPOSTO(S)` : "\nNada novo exposto para anon.");
process.exit(falhas ? 1 : 0);
