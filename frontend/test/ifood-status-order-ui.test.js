// Painel iFood — bloco PRÓPRIO do app Order (pedidos e eventos) + resumo de atenção. Sem DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivarEstadoOrder, textoAtencao, ORDER_ROTULO } from "../src/ifoodEstado.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ler = (f) => readFileSync(path.join(SRC, f), "utf8");

const BASE = {
  configurado: true, conectado: true, status: "ativa", tokenValido: true, expiraEm: "2026-10-01T18:00:00Z",
  merchant: { idMascarado: "55c8****7040", nome: "Loja X", razaoSocial: "Loja X LTDA" },
  ultimaAutenticacao: "2026-10-01T10:00:00Z", tokenAtualizadoEm: "2026-10-01T11:00:00Z",
  ultimoEvento: "2026-10-01T11:58:00Z", ultimoAck: "2026-10-01T11:58:01Z", ultimoPedido: "2026-10-01T11:55:00Z",
  eventosComFalha: 0, worker: { ativo: true, atualizadoEm: "2026-10-01T11:59:30Z" }, observabilidadeDisponivel: true, erroAtual: null,
};
const linha = (o, rotulo) => o.linhas.find((l) => l[0] === rotulo);

test("sem app Order no ambiente (order null): o painel não mostra o bloco", () => {
  assert.equal(derivarEstadoOrder(null), null);
  assert.equal(derivarEstadoOrder(undefined), null);
});

test("conectado e saudável: 'Conectado' (ok), todos os campos presentes, sem erro", () => {
  const o = derivarEstadoOrder(BASE);
  assert.equal(o.rotulo, "Conectado");
  assert.equal(o.classe, "ok");
  assert.equal(o.erro, null);
  assert.deepEqual(o.linhas.map((l) => l[0]), [
    "Conexão", "Loja iFood", "Token", "Token válido até", "Última autenticação", "Token atualizado em",
    "Último evento recebido", "Último ACK", "Último pedido", "Worker de eventos", "Worker visto em", "Erro atual",
  ]);
  assert.equal(linha(o, "Loja iFood")[1], "Loja X · 55c8****7040");
  assert.equal(linha(o, "Token")[1], "Válido");
  assert.equal(linha(o, "Worker de eventos")[1], "Ativo");
  assert.equal(linha(o, "Último ACK")[2], "data");
  assert.equal(linha(o, "Erro atual")[1], "Nenhum");
});

test("reauth_required: 'Reconexão necessária' (bad) com a mensagem do erro", () => {
  const o = derivarEstadoOrder({ ...BASE, conectado: false, status: "reauth_required", tokenValido: false, erroAtual: { codigo: "REAUTH_REQUIRED", mensagem: "Reconecte" } });
  assert.equal(o.rotulo, "Reconexão necessária");
  assert.equal(o.classe, "bad");
  assert.equal(o.erro.codigo, "REAUTH_REQUIRED");
  assert.equal(linha(o, "Erro atual")[1], "Reconecte");
});

test("worker inativo: 'Atenção' (warn)", () => {
  const o = derivarEstadoOrder({ ...BASE, worker: { ativo: false, atualizadoEm: null }, erroAtual: { codigo: "WORKER_INATIVO", mensagem: "Worker parado" } });
  assert.equal(o.rotulo, "Atenção");
  assert.equal(o.classe, "warn");
  assert.equal(linha(o, "Worker de eventos")[1], "Inativo");
});

test("não conectado e migrations pendentes: 'Não conectado' e worker 'Sem dados'", () => {
  const o = derivarEstadoOrder({ ...BASE, conectado: false, status: null, tokenValido: false, worker: null, observabilidadeDisponivel: false });
  assert.equal(o.rotulo, "Não conectado");
  assert.equal(o.classe, "muted");
  assert.equal(linha(o, "Token")[1], "—");
  assert.match(linha(o, "Worker de eventos")[1], /Sem dados/);
});

test("resumo agregado: 'Atenção em N integração(ões)'; nada quando zero", () => {
  assert.equal(textoAtencao({ total: 0, apps: [] }), null);
  assert.equal(textoAtencao(undefined), null);
  assert.equal(textoAtencao({ total: 1, apps: ["order"] }), "Atenção em 1 integração");
  assert.equal(textoAtencao({ total: 2, apps: ["financial", "order"] }), "Atenção em 2 integrações");
});

test("ifood.js: bloco próprio do Order e aviso de atenção ligados; só leitura (nenhuma ação de pedido)", () => {
  const s = ler("ifood.js");
  assert.match(s, /blocoOrder\(estado\.status\?\.order\)/);
  assert.match(s, /derivarEstadoOrder\(order\)/);
  assert.match(s, /textoAtencao\(estado\.status\?\.atencao\)/);
  assert.match(s, /id="ifood-order-status"/);
  assert.equal(ORDER_ROTULO, "Pedidos e eventos (app Order)");
  assert.doesNotMatch(s, /confirmarPedido|requestCancellation|readyToPickup|\/dispatch/);
});
