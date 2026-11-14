#!/usr/bin/env node
// Processo do GATEWAY DE AUTORIDADE do Financeiro v2 (serviço separado; Execução 10).
//
//   node src/fv2-gateway/servidor.js
//
// Variáveis (só deste serviço; NUNCA no backend comum):
//   FV2_AUTORIDADE_DATABASE_URL  conexão do papel de login da autoridade (membro de fv2_autoridade) — segredo
//   FV2_GATEWAY_CHAVE            chave do canal assinado com o backend (≥ 32 caracteres) — segredo
//   SUPABASE_URL, SUPABASE_ANON_KEY  só para VALIDAR o token do usuário no Auth do projeto (chave pública)
//   PORT                         porta HTTP (padrão 8080)
// Sem qualquer uma delas, o processo NÃO sobe (falha fechada). Nenhum valor é impresso.
import { createServer } from "node:http";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { criarGateway } from "./gateway.js";
import { criarMfaPeloProvedor } from "../modules/fv2-integracao/mfaPeloProvedor.js";

const faltando = ["FV2_AUTORIDADE_DATABASE_URL", "FV2_GATEWAY_CHAVE", "SUPABASE_URL", "SUPABASE_ANON_KEY"].filter((k) => !process.env[k]);
if (faltando.length) {
  process.stderr.write(`Gateway do Financeiro v2 não iniciado: faltam variáveis (${faltando.join(", ")}).\n`);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.FV2_AUTORIDADE_DATABASE_URL,
  max: Number(process.env.FV2_AUTORIDADE_POOL_MAX ?? 2),
  // TLS SEMPRE verificado; o certificado-raiz do Supabase (público, baixado no painel) vai em FV2_PG_CA (PEM).
  ssl: process.env.FV2_PG_CA ? { ca: process.env.FV2_PG_CA, rejectUnauthorized: true } : { rejectUnauthorized: true },
  idleTimeoutMillis: 30000,
});
pool.on("error", () => {});
const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const obterUsuario = async (token) => {
  const { data, error } = await auth.auth.getUser(token);
  return error ? null : data?.user ?? null;
};
const manipular = criarGateway({
  poolAutoridade: pool,
  chave: process.env.FV2_GATEWAY_CHAVE,
  obterUsuario,
  mfa: criarMfaPeloProvedor({ obterUsuario }),
  registrar: (evento) => process.stdout.write(`${JSON.stringify({ servico: "fv2-gateway", ...evento })}\n`),
});
const porta = Number(process.env.PORT ?? 8080);
createServer((req, res) => { manipular(req, res); }).listen(porta, () => process.stdout.write(`fv2-gateway ouvindo na porta ${porta}\n`));
