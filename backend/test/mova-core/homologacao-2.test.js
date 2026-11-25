// MOVA CORE — 25/11/2026: REGRESSÃO da 2ª homologação em produção (Açaí). Problemas observados com mensagens reais:
// Central de Conferências estourando 8 s nas 3 chamadas; leitura seguinte (documentos, relatório semanal) sem conexão
// (FINANCEIRO_INDISPONIVEL) porque a consulta abandonada continuava no banco; "quem não mandou a nota fiscal?" respondido pela
// Central/cofre em vez do fechamento dos entregadores; nenhuma fonte equivalente tentada quando uma consulta falhava.
import assert from "node:assert/strict";
import test from "node:test";
import { CATALOGO } from "../../src/modules/mova-core/catalogo.js";
import { criarExecutor, novaSessao } from "../../src/modules/mova-core/executor.js";
import { criarMemoriaDeConversas } from "../../src/modules/mova-core/conversa.js";
import { ORG_A, UNI_A, USUARIO, UNIDADES, PERFIL_FIN } from "./helpers.js";

const esperar = (ms) => new Promise((ok) => { setTimeout(ok, ms); });

function ambiente(porta, catalogo = CATALOGO) {
  const auditoria = [];
  const executor = criarExecutor({ catalogo, porta, auditoria: { registrar: (x) => auditoria.push(x) } });
  const conversa = criarMemoriaDeConversas().obter({ organizacaoId: ORG_A, conversaId: "p1", participanteId: "p1" });
  const sessao = () => novaSessao({ conversa, organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: USUARIO, unidadesPermitidas: UNIDADES, perfil: PERFIL_FIN, podeValores: true, requisicaoId: "r2", hoje: "2026-11-25" });
  const rodar = async (s, name, input = {}) => { const r = await executor.executar(s, { name, input }); return { ...r, json: JSON.parse(r.conteudo) }; };
  return { sessao, rodar, auditoria };
}

test("HM2-01 consulta que estoura o tempo: a VAGA só é liberada quando a leitura real termina (a seguinte não disputa a conexão presa)", async () => {
  const linha = [];
  const porta = {
    permissoesDoUsuario: async () => ["financeiro_v2.ver"],
    async ler(op) {
      linha.push(`inicio:${op}`);
      if (op === "consultarPendencias") { await esperar(250); linha.push("fim:consultarPendencias"); return { itens: [], paginacao: { total: 0 } }; }
      linha.push(`fim:${op}`);
      return { itens: [], paginacao: { total: 0 } };
    },
  };
  const catalogo = { ...CATALOGO, pendencias_de_conferencia: { ...CATALOGO.pendencias_de_conferencia, tempoMs: 40 } };
  const a = ambiente(porta, catalogo);
  const s = a.sessao();
  const [pend, docs] = await Promise.all([a.rodar(s, "pendencias_de_conferencia", { competencia: "2026-11" }), (async () => { await esperar(5); return a.rodar(s, "documentos", { competencia: "2026-11" }); })()]);
  assert.equal(pend.ok, false);
  assert.equal(pend.codigo, "TEMPO_ESGOTADO");
  assert.equal(docs.ok, true, docs.conteudo);
  assert.deepEqual(linha, ["inicio:consultarPendencias", "fim:consultarPendencias", "inicio:consultarDocumentos", "fim:consultarDocumentos"],
    "documentos só começa depois que a consulta abandonada terminou de verdade");
});

test("HM2-02 falha técnica com fonte equivalente: a resposta da ferramenta indica a fonte oficial alternativa, o que ela cobre e o que não cobre", async () => {
  const porta = { permissoesDoUsuario: async () => ["financeiro_v2.ver"], async ler(op) { if (op === "consultarPendencias") { const e = new Error("conexão"); e.name = "ErroTransitorio"; throw e; } return {}; } };
  const a = ambiente(porta);
  const r = await a.rodar(a.sessao(), "pendencias_de_conferencia", { competencia: "2026-11" });
  assert.equal(r.ok, false);
  assert.equal(r.situacao, "FALHA_TECNICA");
  assert.deepEqual(r.json.fonteAlternativa.ferramentas, ["resumo_financeiro"]);
  assert.match(r.json.fonteAlternativa.naoCobre, /Central/);
  assert.match(r.json.fonteAlternativa.regra, /MESMA unidade e o MESMO período/);
  // falha de REGRA (não técnica) não oferece alternativa: o dado não existe, não é a fonte que falhou
  const semPermissao = ambiente({ permissoesDoUsuario: async () => [], ler: async () => ({}) });
  const r2 = await semPermissao.rodar(semPermissao.sessao(), "pendencias_de_conferencia", { competencia: "2026-11" });
  assert.equal(r2.json.fonteAlternativa, undefined);
});

test("HM2-03 catálogo: toda fonte alternativa existe, é leitura e pede a mesma unidade; nota fiscal de entregador aponta para entregadores_da_semana", () => {
  for (const [nome, f] of Object.entries(CATALOGO)) {
    if (!f.alternativa) continue;
    assert.ok(f.alternativa.cobre && f.alternativa.naoCobre, nome);
    for (const alt of f.alternativa.ferramentas) {
      assert.ok(CATALOGO[alt], `${nome} → ${alt} existe`);
      assert.ok(!CATALOGO[alt].escrita && !CATALOGO[alt].local, `${nome} → ${alt} é leitura do Financeiro`);
      assert.ok(CATALOGO[alt].esquema.properties.unidade, `${nome} → ${alt} aceita a mesma unidade`);
    }
  }
  assert.match(CATALOGO.entregadores_da_semana.descricao, /NOTA FISCAL pendente/);
  assert.match(CATALOGO.pendencias_de_conferencia.descricao, /NÃO é a fonte de nota fiscal de entregador/);
  assert.match(CATALOGO.documentos.descricao, /entregadores_da_semana/);
  // o limite da Central fica ABAIXO do statement_timeout do leitor (15 s): abandonar antes do banco não libera nada
  assert.ok(CATALOGO.pendencias_de_conferencia.tempoMs > 8000 && CATALOGO.pendencias_de_conferencia.tempoMs < 15000);
});

test("HM2-04 leitor do MOVA: 1 conexão por instância e conexão ociosa mantida (sem reconectar a cada mensagem)", async () => {
  const { LEITOR_CONEXOES_POR_INSTANCIA, LEITOR_OCIOSO_MS } = await import("../../src/modules/fv2-integracao/mova.js");
  assert.equal(LEITOR_CONEXOES_POR_INSTANCIA, 1);
  assert.ok(LEITOR_OCIOSO_MS >= 60_000);
});
