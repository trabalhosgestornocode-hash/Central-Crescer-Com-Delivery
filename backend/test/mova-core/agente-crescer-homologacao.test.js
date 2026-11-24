// MOVA CORE — F3 §9: homologação das ferramentas do Agente Crescer pelo MOVA, com os EXECUTORES REAIS do agente
// (agente/tools/*.tool.js) e dependências injetadas (sem rede). Protege: módulo+permissão re-resolvidos a cada chamada,
// CMV só como válido quando ficha técnica completa e margem atualizada, nenhum indicador inventado (o verificador só aceita
// valores que vieram da ferramenta), e as 12 ferramentas de leitura mapeadas (navegação fora do WhatsApp).
import assert from "node:assert/strict";
import test from "node:test";
import { REGISTRO } from "../../src/modules/agente/agente.tools.js";
import * as produtoCmvTool from "../../src/modules/agente/tools/produtoCmv.tool.js";
import { MODULOS } from "../../src/shared/modulos.js";
import { PERMISSOES } from "../../src/shared/permissoes.js";
import { ferramentasDoAgenteCrescer, PERMISSOES_DO_AGENTE_CRESCER, validarCmv } from "../../src/modules/mova-core/agenteCrescer.js";
import { verificarFidelidade } from "../../src/modules/mova-core/verificador.js";

const ORG = "33333333-3333-4333-8333-333333333333"; const UNI = "44444444-4444-4444-8444-444444444444";
const ACESSO_CMV = { modulos: [MODULOS.PRODUTOS_CMV], permissoes: [PERMISSOES.CMV_VER], impersonando: false };
const BMT = { id: "p1", nome: "BMT 15cm", tipo: "sanduiche", tamanho: "15cm", ativo: true };
const LINHA = { canal: "balcao", tabela: "E", preco: 29.9, custo: 8.72, comissao_pct: 0, lucro_liquido: 21.18, cmv_pct: 29.16, desatualizado: false };
const ficha = (ok) => ({ qtd_componentes: 3, status_ficha: { chave: ok ? "completa" : "incompleta", label: ok ? "Completa" : "Incompleta", ok }, custo_manual: null, custo_calculado: 8.72, ficha: [] });
const depsCmv = ({ fichaOk = true, desatualizado = false } = {}) => ({
  buscarCandidatos: async () => [BMT], margemProduto: async () => [{ ...LINHA, desatualizado }], obterProduto: async () => ficha(fichaOk),
  resolverTabelas: async () => ({ tabelaBalcao: "E", tabelaIfood: null }),
});
/** Registro com o executor REAL do produto/CMV e dependências injetadas. */
const registroCmv = (deps) => [{ definicao: produtoCmvTool.definicao, executar: (i, c) => produtoCmvTool.executar(i, c, deps), access: { module: MODULOS.PRODUTOS_CMV, permission: PERMISSOES.CMV_VER }, mode: "read", risk: "low" }];
const escopo = { organizacaoId: ORG, unidadeId: UNI };

test("AC-01 mapa do MOVA cobre exatamente as ferramentas de LEITURA do registro real: 12 no WhatsApp, navegação fora", () => {
  const leitura = REGISTRO.filter((r) => r.mode === "read").map((r) => r.definicao.name).sort();
  assert.deepEqual(PERMISSOES_DO_AGENTE_CRESCER.map((x) => x.nome).sort(), leitura);
  assert.equal(PERMISSOES_DO_AGENTE_CRESCER.filter((x) => x.whatsapp).length, 12);
  for (const m of PERMISSOES_DO_AGENTE_CRESCER) {
    const r = REGISTRO.find((x) => x.definicao.name === m.nome);
    assert.deepEqual([m.modulo, m.permissao], [r.access.module, r.access.permission], `${m.nome}: módulo/permissão iguais aos da plataforma`);
  }
});

test("AC-02 CMV VÁLIDO (ficha completa, margem atual): valores da view oficial passam; número inventado é reprovado", async () => {
  const [f] = ferramentasDoAgenteCrescer(registroCmv(depsCmv()), { resolverAcesso: async () => ACESSO_CMV, acessoInicial: ACESSO_CMV });
  const r = await f.executar({ escopo, args: { produto: "BMT" } });
  assert.equal(r.dados.produto.precos[0].cmvNaoValidado, undefined);
  assert.equal(r.dados.avisoMova, undefined);
  assert.ok(verificarFidelidade("O BMT custa R$ 8,72 e é vendido a R$ 29,90 no balcão.", { fatos: r.fatos }).ok);
  assert.equal(verificarFidelidade("O BMT custa R$ 7,50.", { fatos: r.fatos }).ok, false, "custo inventado");
});

test("AC-03 CMV NÃO VALIDADO: ficha incompleta ou margem desatualizada ⇒ custo/CMV/lucro saem dos dados, com motivo", async () => {
  for (const [opcoes, motivo] of [[{ fichaOk: false }, "FICHA_TECNICA_INCOMPLETA"], [{ desatualizado: true }, "MARGEM_DESATUALIZADA"]]) {
    const [f] = ferramentasDoAgenteCrescer(registroCmv(depsCmv(opcoes)), { resolverAcesso: async () => ACESSO_CMV, acessoInicial: ACESSO_CMV });
    const r = await f.executar({ escopo, args: { produto: "BMT" } });
    const p = r.dados.produto.precos[0];
    assert.deepEqual([p.custoTotal, p.cmvPercentual, p.margemReais, p.cmvNaoValidado], [null, null, null, motivo]);
    assert.match(r.dados.avisoMova, /CMV NÃO VALIDADO/);
    assert.equal(verificarFidelidade("O BMT custa R$ 8,72.", { fatos: r.fatos }).ok, false, "o custo não validado não pode ser afirmado");
    assert.ok(verificarFidelidade("O preço de venda do BMT no balcão é R$ 29,90.", { fatos: r.fatos }).ok, "o preço continua válido");
  }
});

test("AC-04 acesso re-resolvido a cada chamada: módulo retirado no meio da conversa ⇒ SEM_ACESSO, executor do agente não roda", async () => {
  let acesso = ACESSO_CMV; let chamou = 0;
  const reg = [{ ...registroCmv(depsCmv())[0], executar: async (...a) => { chamou++; return produtoCmvTool.executar(...a, depsCmv()); } }];
  const [f] = ferramentasDoAgenteCrescer(reg, { resolverAcesso: async () => acesso, acessoInicial: ACESSO_CMV });
  assert.ok((await f.executar({ escopo, args: { produto: "BMT" } })).dados);
  acesso = { ...ACESSO_CMV, modulos: [] };
  assert.equal((await f.executar({ escopo, args: { produto: "BMT" } })).erro, "SEM_ACESSO_NA_PLATAFORMA");
  assert.equal(chamou, 1);
  assert.deepEqual(ferramentasDoAgenteCrescer(registroCmv(depsCmv()), { resolverAcesso: async () => null, acessoInicial: { modulos: [], permissoes: [] } }), [], "sem módulo, nem é oferecida");
  assert.deepEqual(ferramentasDoAgenteCrescer(registroCmv(depsCmv()), {}), [], "sem resolvedor (sem vínculo), nenhuma");
});

test("AC-05 ranking de CMV avisa que a ficha não foi conferida; outras ferramentas passam intactas", () => {
  assert.match(validarCmv("listar_produtos_cmv", { itens: [] }).avisoMova, /SEM conferir a ficha/);
  const d = { total: 1 }; assert.equal(validarCmv("listar_cancelamentos", d), d);
});
