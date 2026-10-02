// Painel iFood — card "Pedidos / Order" (estado PRÓPRIO do app Order) + resumo de atenção. Sem DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivarEstadoOrder, textoAtencao, ORDER_ROTULO, mensagemErroAutorizacao } from "../src/ifoodEstado.js";

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

test("fora do piloto (order null): 'Ainda não disponível para esta unidade' — informativo, sem ação, sem cara de erro", () => {
  for (const v of [null, undefined]) {
    const o = derivarEstadoOrder(v);
    assert.equal(o.disponivel, false);
    assert.equal(o.chave, "indisponivel");
    assert.equal(o.rotulo, "Ainda não disponível para esta unidade");
    assert.equal(o.classe, "muted");
    assert.equal(o.podeConectar, false);
    assert.equal(o.erro, null);
    assert.deepEqual(o.linhas, []);
  }
});

test("unidade piloto sem autorização: 'Não conectado' e pode conectar", () => {
  const o = derivarEstadoOrder({ ...BASE, conectado: false, status: null, tokenValido: false, worker: null, observabilidadeDisponivel: false });
  assert.equal(o.chave, "nao_conectado");
  assert.equal(o.rotulo, "Não conectado");
  assert.equal(o.classe, "muted");
  assert.equal(o.podeConectar, true);
});

test("credencial antiga de unidade que saiu do piloto (configurado false): mostra o estado, mas não oferece conectar", () => {
  const o = derivarEstadoOrder({ ...BASE, configurado: false, conectado: false, status: "reauth_required" });
  assert.equal(o.chave, "reauth");
  assert.equal(o.podeConectar, false);
});

test("conectado: 'Conectado' (ok), só dados operacionais (sem token/ACK/worker/lease na tela do cliente)", () => {
  const o = derivarEstadoOrder(BASE);
  assert.equal(o.rotulo, "Conectado");
  assert.equal(o.classe, "ok");
  assert.equal(o.erro, null);
  assert.equal(o.podeConectar, false);
  assert.deepEqual(o.linhas.map((l) => l[0]), ["Última autenticação", "Último pedido recebido"]);
  assert.equal(linha(o, "Último pedido recebido")[2], "data");
  const tudo = JSON.stringify(o);
  for (const tecnico of ["Token", "ACK", "Worker", "lease", "waiting_lease", "degraded"]) assert.ok(!tudo.includes(tecnico), tecnico);
});

test("reauth_required: 'Reautenticação necessária' (bad), mensagem do erro, pode reconectar", () => {
  const o = derivarEstadoOrder({ ...BASE, conectado: false, status: "reauth_required", tokenValido: false, erroAtual: { codigo: "REAUTH_REQUIRED", mensagem: "Reconecte" } });
  assert.equal(o.rotulo, "Reautenticação necessária");
  assert.equal(o.classe, "bad");
  assert.equal(o.erro.codigo, "REAUTH_REQUIRED");
  assert.equal(o.podeConectar, true);
});

test("erros de RECEBIMENTO de eventos não poluem o card de Pedidos (vão para o card Eventos)", () => {
  for (const codigo of ["WORKER_INATIVO", "EVENTOS_COM_FALHA"]) {
    const o = derivarEstadoOrder({ ...BASE, erroAtual: { codigo, mensagem: "x" } });
    assert.equal(o.rotulo, "Conectado", codigo);
    assert.equal(o.erro, null, codigo);
  }
});

test("nunca existe o texto antigo 'migrations de Events pendentes' (ausência de dado não é migration pendente)", () => {
  assert.doesNotMatch(ler("ifoodEstado.js"), /migrations? de Events pendentes|migration pendente/i);
  assert.doesNotMatch(ler("ifood.js"), /migrations? de Events pendentes|migration pendente/i);
});

test("resumo agregado: 'Atenção em N integração(ões)'; nada quando zero", () => {
  assert.equal(textoAtencao({ total: 0, apps: [] }), null);
  assert.equal(textoAtencao(undefined), null);
  assert.equal(textoAtencao({ total: 1, apps: ["order"] }), "Atenção em 1 integração");
  assert.equal(textoAtencao({ total: 2, apps: ["financial", "order"] }), "Atenção em 2 integrações");
});

test("erro do backend para unidade fora do piloto vira mensagem amigável", () => {
  assert.equal(mensagemErroAutorizacao({ codigo: "IFOOD_ORDER_PILOTO_NAO_HABILITADO" }), "Pedidos e eventos do iFood ainda não estão disponíveis para esta unidade.");
});

test("ifood.js: card de Pedidos ligado ao status e só leitura (nenhuma ação de pedido)", () => {
  const s = ler("ifood.js");
  assert.match(s, /derivarEstadoOrder\(statusApi\?\.order\)/);
  assert.match(s, /textoAtencao\(statusApi\?\.atencao\)/);
  assert.match(s, /id="ifood-order-status"/);
  assert.equal(ORDER_ROTULO, "Pedidos / Order");
  assert.doesNotMatch(s, /confirmarPedido|requestCancellation|readyToPickup|\/dispatch/);
});
