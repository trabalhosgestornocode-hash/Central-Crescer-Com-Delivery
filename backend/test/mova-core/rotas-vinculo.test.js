// §5 — ROTAS do vínculo WhatsApp ↔ plataforma: o próprio usuário gera o código; o administrador lista, aprova e revoga.
// Sem intervenção do desenvolvedor. Serviço REAL (memória), plataforma sintética, sessão injetada como requireContexto faria.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { criarRouterVinculoMova } from "../../src/modules/mova-core/rotasVinculo.js";
import { criarServicoDeIdentidade } from "../../src/modules/mova-core/identidade.js";

const ORG = "aaaaaaaa-0000-4000-8000-0000000000e1";
const ANA = { conta: "bbbbbbbb-0000-4000-8000-0000000000a1", perfil: "cccccccc-0000-4000-8000-0000000000a1" };
const ADM = { conta: "bbbbbbbb-0000-4000-8000-0000000000d1", perfil: "cccccccc-0000-4000-8000-0000000000d1" };
const ENTRADAS = [{ id: "pessoa-ana", pessoaId: "pessoa-ana", nome: "Ana", ids: ["5585999990001@s.whatsapp.net"], privado: "5585999990001@s.whatsapp.net" }, { id: "pessoa-bia", pessoaId: "pessoa-bia", nome: "Bia", ids: ["5585999990002@s.whatsapp.net"] }];

async function montar() {
  const auditoria = [];
  const plataforma = { async acessoDoPerfil({ perfilId }) { return [ANA.perfil, ADM.perfil].includes(perfilId) ? { contaId: perfilId === ANA.perfil ? ANA.conta : ADM.conta, papel: "gerente", permissoes: [], modulos: [], unidades: [], ativo: true } : null; } };
  const identificarParticipante = ({ participanteId }) => { const e = ENTRADAS.find((x) => x.ids.includes(participanteId)); return e ? { entrada: e, organizacaoId: ORG, privado: true, unidades: [] } : null; };
  let codigoGerado = null;
  const servico = criarServicoDeIdentidade({ identificarParticipante, plataforma, auditoria: { registrar: (x) => auditoria.push(x) }, gerarCodigo: () => (codigoGerado = "482913") });
  const app = express(); app.use(express.json());
  let sessao = null; // o que requireContexto colocaria
  app.use((req, _res, next) => { Object.assign(req, sessao); next(); });
  app.use("/mova/vinculo", criarRouterVinculoMova({ servico: async () => servico, entradasDaOrganizacao: async () => ENTRADAS }));
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/mova/vinculo`;
  const como = (q, permissoes = [], extra = {}) => { sessao = { user: { id: q.conta }, tenant: { organizacaoId: ORG }, acesso: { perfilId: q.perfil, permissoes, empresa: { id: ORG }, impersonando: false, ...extra } }; };
  const chamar = async (metodo, caminho, corpo) => { const r = await fetch(base + caminho, { method: metodo, headers: { "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined }); return { status: r.status, corpo: await r.json(), cache: r.headers.get("cache-control") }; };
  return { servico, como, chamar, auditoria, fechar: () => srv.close(), codigo: () => codigoGerado };
}

test("RV-01 fluxo do PRÓPRIO usuário: gera o código na plataforma, envia no privado e passa a aparecer como vinculado; o código não fica em cache", async () => {
  const m = await montar();
  try {
    m.como(ANA);
    assert.equal((await m.chamar("GET", "/meu")).corpo.vinculado, false);
    const g = await m.chamar("POST", "/codigo");
    assert.equal(g.status, 200); assert.match(g.corpo.instrucao, /vincular 482913/); assert.equal(g.cache, "no-store");
    const c = await m.servico.confirmarCodigo({ grupoId: "5585999990001@s.whatsapp.net", participanteId: "5585999990001@s.whatsapp.net", texto: "vincular 482913" });
    assert.equal(c.ok, true);
    assert.equal((await m.chamar("GET", "/meu")).corpo.vinculado, true);
    assert.ok(!JSON.stringify(m.auditoria).includes("482913"), "o código nunca vai para a auditoria");
    assert.deepEqual(m.auditoria.map((x) => x.acao), ["CODIGO_GERADO", "VINCULO_CRIADO"]);
  } finally { m.fechar(); }
});

test("RV-02 IMPERSONAÇÃO não gera código nem administra; sem usuarios.gerenciar não lista nem aprova", async () => {
  const m = await montar();
  try {
    m.como(ADM, ["usuarios.gerenciar"], { impersonando: true, perfilId: null });
    assert.equal((await m.chamar("POST", "/codigo")).status, 403);
    assert.equal((await m.chamar("GET", "/admin")).status, 403);
    m.como(ANA);
    assert.equal((await m.chamar("GET", "/admin")).status, 403);
    assert.equal((await m.chamar("POST", "/admin/aprovar", { entradaId: "pessoa-bia", perfilId: ANA.perfil })).status, 403);
  } finally { m.fechar(); }
});

test("RV-03 ADMINISTRADOR: lista entradas sem vínculo, aprova uma, recusa duplicado, revoga; a revogação vale na hora", async () => {
  const m = await montar();
  try {
    m.como(ADM, ["usuarios.gerenciar"]);
    let l = (await m.chamar("GET", "/admin")).corpo;
    assert.deepEqual(l.entradas.map((e) => [e.entradaId, e.vinculoId]), [["pessoa-ana", null], ["pessoa-bia", null]]);
    const a = await m.chamar("POST", "/admin/aprovar", { entradaId: "pessoa-bia", perfilId: ANA.perfil });
    assert.equal(a.status, 201);
    assert.equal((await m.chamar("POST", "/admin/aprovar", { entradaId: "pessoa-bia", perfilId: ADM.perfil })).corpo.erro, "JA_VINCULADO");
    assert.equal((await m.chamar("POST", "/admin/aprovar", { entradaId: "pessoa-fora", perfilId: ANA.perfil })).status, 404, "só entradas da lista do MOVA");
    l = (await m.chamar("GET", "/admin")).corpo;
    assert.equal(l.entradas.find((e) => e.entradaId === "pessoa-bia").vinculoId, a.corpo.vinculoId);
    assert.equal((await m.chamar("POST", "/revogar", { vinculoId: a.corpo.vinculoId, motivo: "saiu da empresa" })).corpo.ok, true);
    const r = await m.servico.resolver({ grupoId: "x", participanteId: "5585999990002@s.whatsapp.net" });
    assert.equal(r.vinculado, false);
  } finally { m.fechar(); }
});

test("RV-04 o TITULAR revoga o próprio vínculo; outra pessoa sem administração não revoga o vínculo alheio", async () => {
  const m = await montar();
  try {
    m.como(ADM, ["usuarios.gerenciar"]);
    const v = (await m.chamar("POST", "/admin/aprovar", { entradaId: "pessoa-ana", perfilId: ANA.perfil })).corpo.vinculoId;
    m.como(ADM, []); // sem a permissão agora e não é o titular
    assert.equal((await m.chamar("POST", "/revogar", { vinculoId: v })).status, 403);
    m.como(ANA);
    assert.equal((await m.chamar("POST", "/revogar", { vinculoId: v })).corpo.ok, true);
    assert.ok(m.auditoria.some((x) => x.acao === "REVOGACAO_RECUSADA") && m.auditoria.some((x) => x.acao === "VINCULO_REVOGADO" && x.motivo === "REVOGADO_PELO_TITULAR"));
  } finally { m.fechar(); }
});
