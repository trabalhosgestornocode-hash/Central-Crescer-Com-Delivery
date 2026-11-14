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
  assert.equal(d.pendencia.documentosExistentes.length, 0);
  assert.deepEqual(depois.pendencia.documentosExistentes.map((x) => x.descricao), ["Nota fiscal do boleto (sintética)"], "a pendência mostra o documento enviado (achado da jornada no navegador)");
  const rc = await ok("/api/fv2/reclassificacao", { competencia: "2026-10", id: registro, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS" });
  assert.equal(rc.impacto.evidenciaDisponivel, true, "a reclassificação enxerga a evidência enviada");
});

test("08D — conciliação AMBÍGUA: proximidade não confirma; recusar a indevida; só o comprovante do vínculo libera a certa", async () => {
  const OUT = { competencia: "2026-10" };
  const op = (c, corpo) => agir(c, corpo, "operador");
  for (const arquivo of ["pedidos-saipos-0510-ambiguo", "stone-0510-ambiguo"]) {
    const r = await op("/api/fv2/acoes/importacao/receber", { arquivo });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const c = await op("/api/fv2/acoes/importacao/confirmar", { importacao: r.corpo.importacao.id, impressaoPrevia: r.corpo.importacao.impressaoPrevia });
    assert.equal(c.status, 200, JSON.stringify(c.corpo));
  }
  assert.equal((await op("/api/fv2/acoes/conciliacoes/gerar", { competencia: "2026-10" })).status, 200);
  const lista = (await ok("/api/fv2/conferencias/correspondencias", { ...OUT, situacao: "CANDIDATA", tamanho: "50" }, "operador")).itens.filter((x) => x.confiabilidade === "FRACA");
  assert.equal(lista.length, 2, "duas candidatas disputam a mesma transação");
  const det = await Promise.all(lista.map((x) => ok("/api/fv2/conferencias/correspondencia", { ...OUT, id: x.id }, "operador")));
  assert.ok(det.every((d) => d.correspondencia.ambigua && !d.correspondencia.podeConfirmar));
  const [errada, certa] = det.map((d) => d.correspondencia).sort((a, b) => (a.ladoA.itens[0].identificador.includes("DEMO-A2") ? 1 : -1));
  assert.equal((await op("/api/fv2/acoes/conciliacoes/confirmar", { correspondencia: certa.id, justificativa: "Mesmo valor e horário próximo." })).status, 409, "ambígua não confirma");
  assert.equal((await op("/api/fv2/acoes/conciliacoes/rejeitar", { correspondencia: errada.id, justificativa: "Comprovante da maquininha aponta o outro pedido (sintético)." })).status, 200);
  const semProva = await ok("/api/fv2/conferencias/correspondencia", { ...OUT, id: certa.id }, "operador");
  assert.deepEqual([semProva.correspondencia.ambigua, semProva.correspondencia.podeConfirmar], [false, false]);
  assert.match(semProva.correspondencia.motivoDeNaoConfirmar, /anexe um documento que prove o vínculo/);
  assert.equal((await op("/api/fv2/acoes/conciliacoes/confirmar", { correspondencia: certa.id, justificativa: "Só proximidade." })).status, 409, "sem prova do vínculo não confirma");
  const prova = b64("%PDF-1.4\n% Comprovante sintetico da maquininha: NSU 000123, 05/10/2026 12:03, R$ 42,00 - pedido DEMO-A2\n%%EOF\n");
  const env = await agir("/api/fv2/acoes/documentos/enviar", { arquivoBase64: prova, nomeArquivo: "comprovante-maquininha.pdf", tipoMime: "application/pdf", tipo: "COMPROVANTE", descricao: "Comprovante da maquininha liga a transação ao pedido DEMO-A2 (sintético)", registroTipo: "CORRESPONDENCIA", registro: certa.id, competencia: "2026-10" });
  assert.equal(env.status, 200, JSON.stringify(env.corpo));
  const comProva = await ok("/api/fv2/conferencias/correspondencia", { ...OUT, id: certa.id }, "operador");
  assert.deepEqual([comProva.correspondencia.podeConfirmar, comProva.correspondencia.evidenciasDoVinculo.length], [true, 1]);
  const ok2 = await op("/api/fv2/acoes/conciliacoes/confirmar", { correspondencia: certa.id, justificativa: "Comprovante da maquininha identifica o pedido DEMO-A2 (sintético)." });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.corpo));
  assert.equal((await op("/api/fv2/acoes/conciliacoes/confirmar", { correspondencia: certa.id, justificativa: "De novo." })).status, 409, "sem duplicidade");
  const fim = await ok("/api/fv2/conferencias/correspondencia", { ...OUT, id: certa.id }, "operador");
  assert.deepEqual(fim.historico.map((h) => h.situacao ?? h.evento).slice(-1), ["CONFIRMADA"]);
});
