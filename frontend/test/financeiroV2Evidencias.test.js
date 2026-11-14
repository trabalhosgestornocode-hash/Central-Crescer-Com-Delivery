// Execução 08D — envio de evidência pela Central (demonstração local; núcleo REAL; arquivos sintéticos).
// Rodar: node --test frontend/test/financeiroV2Evidencias.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

let demo;
const U1 = UNIDADES[0].id;
const SET = { competencia: "2026-09" };
const tokens = {};
const ok = async (caminho, params, perfil = "administrador") => { const r = await demo.responder(caminho, { unidade: U1, ...params }, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const agir = (caminho, corpo, perfil = "administrador", csrf = tokens[perfil]) => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf });
const b64 = (t) => Buffer.from(t).toString("base64");
before(async () => {
  demo = await criarDemo();
  for (const p of ["administrador", "operador", "gestor"]) tokens[p] = (await ok("/api/fv2/sessao", {}, p)).csrf;
});

async function pendenciaDeDespesa() {
  const lista = await ok("/api/fv2/conferencias/pendencias", { competencia: "2026-10", grupo: "CLASSIFICACOES", tamanho: "100" });
  const p = lista.itens.find((x) => x.codigo === "DESPESA_A_CLASSIFICAR");
  assert.ok(p, "a demonstração tem um boleto de outubro a classificar");
  return ok("/api/fv2/conferencias/pendencia", { competencia: "2026-10", chave: p.chave });
}

test("08D — a pendência oferece o envio só a quem tem enviar_documento; o formulário é acessível", async () => {
  const d = await pendenciaDeDespesa();
  const com = conf.detalhePendencia(d, { competencia: "2026-10", permissoes: ["financeiro_v2.ver", "financeiro_v2.enviar_documento"] });
  assert.match(com, /data-acao="\/api\/fv2\/acoes\/documentos\/enviar"/);
  assert.match(com, /<label for="arq-\d+">Arquivo<\/label>/);
  assert.match(com, /type="file" name="arquivo" accept="\.pdf,\.png,\.jpg,\.jpeg[^"]*" required aria-describedby="arq-ajuda-\d+ arq-escolhido-\d+"/);
  assert.match(com, /data-arquivo-escolhido aria-live="polite"/);
  assert.match(com, /name="registroTipo" value="LANCAMENTO"/);
  assert.match(com, /Anexar não resolve a pendência sozinho/);
  const sem = conf.detalhePendencia(d, { competencia: "2026-10", permissoes: ["financeiro_v2.ver"] });
  assert.ok(!sem.includes("documentos/enviar"));
});

test("08D — envio pelo serviço: valida, guarda, vincula, não duplica e não resolve a pendência sozinho", async () => {
  const d = await pendenciaDeDespesa();
  const registro = d.pendencia.referencia.id;
  const base = { nomeArquivo: "nota-boleto.pdf", tipoMime: "application/pdf", tipo: "NOTA_FISCAL", descricao: "Nota fiscal do boleto (sintética)", registroTipo: "LANCAMENTO", registro, competencia: "2026-10" };
  const pdf = b64("%PDF-1.4\n% Nota fiscal sintetica: contabilidade outubro R$ 189,90\n%%EOF\n");
  assert.equal((await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: pdf }, "administrador", "")).status, 403, "sem CSRF");
  assert.equal((await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: pdf }, "operador")).status, 403, "operador sem enviar_documento");
  assert.equal((await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: "não é base64!" })).status, 422);
  assert.equal((await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: b64("texto qualquer") })).status, 422, "PDF falso");
  assert.equal((await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: pdf, caminho: "C:/x" })).status, 400, "campo desconhecido");
  const r = await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: pdf });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.ok(!JSON.stringify(r.corpo).match(/cofre:|[A-Za-z]:\\|\/Users\/|temporarios/), "nenhum caminho nem id interno do cofre volta ao navegador");
  assert.match(conf.resultadoDaAcao({ ok: true, dados: r.corpo }), /Documento guardado e vinculado \(PDF/);
  const rep = await agir("/api/fv2/acoes/documentos/enviar", { ...base, arquivoBase64: pdf });
  assert.equal(rep.corpo.repetido, true);
  const depois = await ok("/api/fv2/conferencias/pendencia", { competencia: "2026-10", chave: d.pendencia.chave });
  assert.equal(depois.pendencia.codigo, "DESPESA_A_CLASSIFICAR", "a pendência continua até a decisão");
  const rc = await ok("/api/fv2/reclassificacao", { competencia: "2026-10", id: registro, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS" });
  assert.equal(rc.impacto.evidenciaDisponivel, true, "a reclassificação enxerga a evidência enviada");
});
