// MOVA — Agente 2: montagem do modo OPERACAO (grupos reais). Só a leitura do ambiente e as recusas — sem rede, sem banco.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarRotinaPeriodica, exigirEscopoDaOperacao, lerConfiguracaoMova } from "../../src/modules/fv2-integracao/mova.js";
import { IDENTIDADE_MOVA } from "../../src/modules/fv2-integracao/leitorMova.js";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";

const U1 = "dddddddd-0000-4000-8000-0000000a2a01";
const U2 = "dddddddd-0000-4000-8000-0000000a2b01";
const BASE = {
  MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "postgres://mova@local/sintetico", MOVA_SERVICO_USUARIO_ID: IDENTIDADE_MOVA,
  MOVA_MODO: "OPERACAO", MOVA_AMBIENTE: "operacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-sintetico-01",
  MOVA_FINANCEIRO_LEITURA_URL: "postgres://leitor@local/sintetico", MOVA_OPERACAO_UNIDADES: `${U1},${U2}`,
};

test("A2-M1 OPERACAO completa: modo, unidades, só consultas por padrão e comandos simples ligados", () => {
  const c = lerConfiguracaoMova(BASE);
  assert.equal(c.habilitado, true);
  assert.deepEqual([c.modo, c.operacaoUnidades, c.somenteConsultas, c.comandosDeterministicos], ["OPERACAO", [U1, U2], true, true]);
  assert.equal(lerConfiguracaoMova({ ...BASE, MOVA_OPERACAO_DOCUMENTOS: "1" }).somenteConsultas, false);
});

test("A2-M2 OPERACAO incompleta ou contraditória não sobe", () => {
  const motivo = (env) => lerConfiguracaoMova(env).contradicoes ?? [];
  assert.ok(motivo({ ...BASE, MOVA_AMBIENTE: "piloto" }).includes("OPERACAO_INCOMPLETA"));
  assert.ok(motivo({ ...BASE, MOVA_OPERACAO_UNIDADES: "" }).includes("OPERACAO_SEM_UNIDADES"));
  assert.ok(motivo({ ...BASE, MOVA_OPERACAO_UNIDADES: "nao-uuid" }).includes("OPERACAO_SEM_UNIDADES"));
  assert.ok(motivo({ ...BASE, MOVA_FINANCEIRO_LEITURA_URL: "" }).includes("PILOTO_SEM_LEITOR"));
  assert.ok(motivo({ ...BASE, MOVA_FINANCEIRO_LEITURA_URL: BASE.MOVA_DATABASE_URL }).includes("PILOTO_LEITOR_COM_OUTRA_CREDENCIAL"));
  assert.ok(motivo({ ...BASE, MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-000000000001" }).includes("PILOTO_IDENTIDADE_DIFERENTE_DO_LEITOR"));
  assert.ok(motivo({ ...BASE, MOVA_PILOTO_UNIDADE_ID: U1 }).includes("OPERACAO_COM_UNIDADE_DO_PILOTO"));
  assert.ok(motivo({ ...BASE, MOVA_HOMOLOGACAO_MARCADOR: "" }).includes("MARCADOR_INVALIDO"));
  // O piloto da 16A continua exatamente como era.
  const p = lerConfiguracaoMova({ ...BASE, MOVA_MODO: "PILOTO", MOVA_AMBIENTE: "piloto", MOVA_OPERACAO_UNIDADES: undefined, MOVA_PILOTO_UNIDADE_ID: U1 });
  assert.deepEqual([p.habilitado, p.modo, p.pilotoUnidadeId, p.somenteConsultas, p.comandosDeterministicos], [true, "PILOTO", U1, true, undefined]);
});

test("A2-M3 escopo da OPERACAO: unidade fora da lista, conversa avulsa ou grupo sem lista recusam a montagem", () => {
  const unidades = [{ organizacaoId: "dddddddd-0000-4000-8000-0000000000a2", unidadeId: U1, nome: "Loja Alfa", fontes: { situacao: "A_CONFIRMAR" } }];
  const cfg = validarConfiguracao({ modo: "OPERACAO", identidadeServico: { usuarioId: IDENTIDADE_MOVA }, unidades,
    gruposAutorizados: [{ grupoId: "120363000000000201@g.us", unidades: [U1], participantes: [{ ids: ["5500000000201@s.whatsapp.net"], perfil: "FINANCEIRO" }] }] });
  assert.doesNotThrow(() => exigirEscopoDaOperacao(cfg, [U1]));
  assert.throws(() => exigirEscopoDaOperacao(cfg, [U2]), (e) => e.motivos.includes("OPERACAO_UNIDADE_FORA_DA_LISTA"));
  const semGrupo = { ...cfg, gruposAutorizados: cfg.gruposAutorizados.filter((g) => g.derivada) };
  assert.throws(() => exigirEscopoDaOperacao(semGrupo, [U1]), (e) => e.motivos.includes("OPERACAO_SEM_GRUPO"));
  const avulsa = { ...cfg, gruposAutorizados: [...cfg.gruposAutorizados, { grupoId: "5500000000999@s.whatsapp.net", unidades: [U1], acesso: "LISTA", derivada: false }] };
  assert.throws(() => exigirEscopoDaOperacao(avulsa, [U1]), (e) => e.motivos.includes("OPERACAO_COM_CONVERSA_AVULSA"));
});

test("A2-M4 autonomia e escrita: desligadas por padrão; escrita exige autonomia e identidade OPERACIONAL própria", () => {
  const c = lerConfiguracaoMova(BASE);
  assert.deepEqual([c.autonomia, c.escrita, c.identidadeOperacional], [false, false, null]);
  assert.equal(lerConfiguracaoMova({ ...BASE, MOVA_OPERACAO_AUTONOMIA: "1" }).autonomia, true);
  const motivo = (env) => lerConfiguracaoMova(env).contradicoes ?? [];
  assert.ok(motivo({ ...BASE, MOVA_OPERACAO_ESCRITA: "1" }).includes("ESCRITA_SEM_AUTONOMIA"));
  assert.ok(motivo({ ...BASE, MOVA_OPERACAO_AUTONOMIA: "1", MOVA_OPERACAO_ESCRITA: "1" }).includes("ESCRITA_SEM_IDENTIDADE_OPERACIONAL"));
  assert.ok(motivo({ ...BASE, MOVA_OPERACAO_AUTONOMIA: "1", MOVA_OPERACAO_ESCRITA: "1", MOVA_IDENTIDADE_OPERACIONAL: IDENTIDADE_MOVA }).includes("IDENTIDADE_OPERACIONAL_IGUAL_A_LEITURA"));
  assert.ok(motivo({ ...BASE, MOVA_MODO: "PILOTO", MOVA_AMBIENTE: "piloto", MOVA_PILOTO_UNIDADE_ID: U1, MOVA_OPERACAO_UNIDADES: "", MOVA_OPERACAO_AUTONOMIA: "1" }).includes("AUTONOMIA_FORA_DA_OPERACAO"));
  const ok = lerConfiguracaoMova({ ...BASE, MOVA_OPERACAO_AUTONOMIA: "1", MOVA_OPERACAO_ESCRITA: "1", MOVA_IDENTIDADE_OPERACIONAL: "eeeeeeee-0000-4000-8000-0000000000c2" });
  assert.deepEqual([ok.habilitado, ok.escrita, ok.identidadeOperacional], [true, true, "eeeeeeee-0000-4000-8000-0000000000c2"]);
});

test("A2-M5 entregadores e rotina: desligados por padrão; só na OPERACAO; rotina exige os entregadores; passo sem sobreposição", async () => {
  const c = lerConfiguracaoMova(BASE);
  assert.deepEqual([c.entregadores, c.rotinaEntregadores], [false, false]);
  const motivo = (env) => lerConfiguracaoMova(env).contradicoes ?? [];
  assert.ok(motivo({ ...BASE, MOVA_ENTREGADORES_ROTINA: "1" }).includes("ROTINA_SEM_ENTREGADORES"));
  assert.ok(motivo({ ...BASE, MOVA_MODO: "PILOTO", MOVA_AMBIENTE: "piloto", MOVA_PILOTO_UNIDADE_ID: U1, MOVA_OPERACAO_UNIDADES: "", MOVA_ENTREGADORES: "1" }).includes("ENTREGADORES_FORA_DA_OPERACAO"));
  assert.deepEqual((({ entregadores, rotinaEntregadores }) => [entregadores, rotinaEntregadores])(lerConfiguracaoMova({ ...BASE, MOVA_ENTREGADORES: "1", MOVA_ENTREGADORES_ROTINA: "1" })), [true, true]);
  let n = 0, solta;
  const r = criarRotinaPeriodica(() => new Promise((ok) => { n += 1; solta = ok; }), { intervaloMs: 3600000 });
  const p1 = r.tick();
  assert.equal(await r.tick(), null, "um passo de cada vez");
  solta({ semanais: 0 });
  assert.deepEqual(await p1, { semanais: 0 });
  assert.equal(n, 1);
  const falha = criarRotinaPeriodica(async () => { throw Object.assign(new Error("x"), { codigo: "Y" }); }, { intervaloMs: 3600000, registrar: (e) => { n = e.codigo; } });
  assert.equal(await falha.tick(), null);
  assert.equal(n, "Y");
  r.parar(); falha.parar();
});
