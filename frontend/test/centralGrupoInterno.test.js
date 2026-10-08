// Seção "Grupo interno" da aba Teste — construtores puros.
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlSecaoGrupoInterno, htmlListaGrupos, htmlPreparoGrupo, htmlResultadoGrupo } from "../src/central/centralGrupoInterno.js";

const GRUPO = "120363000000000001@g.us";

test("seção tem as duas ações e nenhum handler inline", () => {
  const h = htmlSecaoGrupoInterno();
  assert.match(h, /data-gi-acao="listar"/);
  assert.match(h, /data-gi-acao="preparar"/);
  assert.doesNotMatch(h, /onclick=/i);
});

test("lista marca o candidato pelo nome e o configurado; avisa quando backend e Gateway divergem", () => {
  const base = { nomeEsperado: "Crescer Com Delivery - Central", grupos: [{ jid: GRUPO, nome: "Crescer Com Delivery - Central", participantes: 4 }], candidatosPorNome: [GRUPO] };
  const ok = htmlListaGrupos({ ...base, configuracao: { backendJid: GRUPO, gatewayJid: GRUPO, concordam: true, encontradoNaConta: true } });
  assert.match(ok, /nome confere · configurado/);
  assert.match(ok, /mesmo grupo/);
  const diverge = htmlListaGrupos({ ...base, configuracao: { backendJid: GRUPO, gatewayJid: "120363000000000002@g.us", concordam: false } });
  assert.match(diverge, /DIFERENTES/);
  const semConfig = htmlListaGrupos({ ...base, configuracao: {} });
  assert.match(semConfig, /NÃO configurado/);
});

test("nome do grupo é escapado", () => {
  const h = htmlListaGrupos({ grupos: [{ jid: GRUPO, nome: "<img src=x>" }], configuracao: {} });
  assert.doesNotMatch(h, /<img src=x>/);
});

test("preparo com bloqueio não mostra botão de envio; sem bloqueio exige a confirmação (botão começa desabilitado)", () => {
  const bloqueado = htmlPreparoGrupo({ grupo: {}, bloqueios: [{ codigo: "GRUPO_NAO_CONFIGURADO", mensagem: "O grupo interno não está configurado" }], previewTexto: "x" });
  assert.doesNotMatch(bloqueado, /data-gi-acao="enviar"/);
  assert.match(bloqueado, /não está configurado/);
  const livre = htmlPreparoGrupo({ grupo: { jid: GRUPO }, bloqueios: [], previewTexto: "🧪 TESTE DE AUTOMAÇÃO" });
  assert.match(livre, /data-gi-confirma/);
  assert.match(livre, /data-gi-acao="enviar" disabled/);
  assert.match(livre, /TESTE DE AUTOMAÇÃO/);
});

test("resultado: JA_EXISTIA deixa claro que nada foi reenviado", () => {
  assert.match(htmlResultadoGrupo({ resultado: "JA_EXISTIA", status: "SENT", messageId: "wa-1" }), /nada foi reenviado/);
});
