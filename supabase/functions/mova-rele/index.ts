// MOVA — Edge Function `mova-rele` (HOMOLOGAÇÃO). Publicar SOMENTE no projeto de homologação, com verify_jwt = false
// (o Gateway não tem JWT do Supabase; a autenticação é a assinatura HMAC conferida no banco por mova_rele.receber).
// Conecta pela URL interna do projeto (SUPABASE_DB_URL) e DESCE para o papel mova_rele_gravador em cada transação:
// esse papel só pode executar mova_rele.receber — não lê nem escreve tabela alguma, nem o Financeiro, nem o MOVA.
import postgres from "npm:postgres@3.4.5";
import { tratar } from "./nucleo.mjs";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10 });
const log = (evento: string, dados: Record<string, unknown> = {}) => console.log(JSON.stringify({ evento, ...dados }));

async function receber(a: { corpo: string; ts: string; nonce: string; assinatura: string; caminho: string; origem: string }) {
  return await sql.begin(async (t) => {
    await t`set local role mova_rele_gravador`;
    const [r] = await t`select mova_rele.receber(${a.corpo}, ${a.ts}, ${a.nonce}, ${a.assinatura}, ${a.caminho}, ${a.origem}) as r`;
    return r.r as string;
  });
}

Deno.serve((req) => tratar(req, { receber, log }));
