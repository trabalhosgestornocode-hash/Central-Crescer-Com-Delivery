import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "ficticio_service_role_key_0123456789abcdef";
process.env.SUPABASE_ANON_KEY ??= "ficticio_anon_key_0123456789abcdef0123";
const { createApp } = await import("../src/app.js");

async function health(commit) {
  const antes = process.env.RENDER_GIT_COMMIT;
  if (commit === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = commit;
  const srv = http.createServer(createApp()); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { const r = await fetch(`http://127.0.0.1:${srv.address().port}/health`); return await r.json(); }
  finally { srv.close(); if (antes === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = antes; }
}
test("/health informa a versão publicada (7 primeiros hex do RENDER_GIT_COMMIT) só quando válida", async () => {
  assert.equal((await health("8417bcf5a1b2c3d4e5f60718293a4b5c6d7e8f90")).versao, "8417bcf");
  assert.equal("versao" in (await health(undefined)), false);
  assert.equal("versao" in (await health("não-é-hex; <script>")), false);
});
