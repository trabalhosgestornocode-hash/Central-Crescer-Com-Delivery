// Adaptador de produção da consolidação por telefone (comunicacao.consolidacao.pipeline.js) contra o GATEWAY SIMULADO (fake.provider) e um pipeline
// falso fiel ao contrato real (hook `preparoDeEnvio`, reservarEnvio com CAS e teto por mensagem física, finalizarEnvio/resolverFalhaDeEnvio).
// A semântica SQL da reserva (chave, teto de 3 FÍSICAS, concorrência) é provada no PostgreSQL em testes-seguros/pg/consolidacao_140.sh.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { processarLoteComConsolidacao } from "../src/modules/comunicacao/comunicacao.consolidacao.pipeline.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MOTIVO_DA_RESERVA } from "../src/modules/comunicacao/comunicacao.adiamento.js";

const ON = { COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: "true" };
const TEL = "+5511900000001";
const jobDe = (n, over = {}) => ({ id: `m${n}`, organizacao_id: `org${n}`, unidade_id: `un${n}`, contato_id: "CW-X", idempotency_key: `idem-${n}`, conteudo: `Relatório da loja ${n}: ${n} pendência(s).`, tipo: "dashboard_ifood_d1", claimed_by: "w1", claim_geracao: 1, tel: TEL, ...over });
const sete = () => [1, 2, 3, 4, 5, 6, 7].map((n) => jobDe(n));

function montar({ teto = 3, bloqueio = () => null, falhaNome = false } = {}) {
  const provider = criarFakeProvider({ telefone: "+5511988880000" });
  const whatsAppService = criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true });
  const w = { provider, whatsAppService, passadas: {}, reservas: [], finais: [], falhas: [], adiados: [], tentativas: [], estado: new Map(), chavesDoTelefone: new Set(), fisicas: 0 };
  const db = { from: (tabela) => ({ select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => (falhaNome ? { data: null, error: { message: "x" } } : { data: { id, nome: `${tabela === "organizacoes" ? "Empresa" : "Unidade"} ${id.replace(/\D/g, "")}` }, error: null }) }) }) }) };
  w.impl = {
    processarJob: async (job, op) => {
      w.passadas[job.id] = (w.passadas[job.id] ?? 0) + 1;
      const motivo = bloqueio(job, w.passadas[job.id]);
      if (motivo) return { id: job.id, resultado: motivo };
      return op.preparoDeEnvio({
        job, claim: { id: job.id }, contato: { telefone_e164: job.tel }, alerta: null, habilitacao: {},
        reservar: (extra = {}) => w.impl.reservarEnvio({ id: job.id, worker: job.claimed_by, claimGeracao: job.claim_geracao, maxPorContatoDia: teto, leaseSegundos: 90, marcador: "mesmos-parametros-do-individual", ...extra }),
        adiarOuBloquear: async (m, o) => { w.adiados.push({ id: job.id, motivo: m, o }); return { id: job.id, resultado: "ADIADO", motivo: m }; },
        cancelarPorExpiracao: async () => ({ id: job.id, resultado: "CANCELADO_EXPIRADA" }),
        posseSemEfeito: { id: job.id, resultado: "POSSE_PERDIDA" },
      });
    },
    reservarEnvio: async (p) => {
      w.reservas.push(p);
      if (w.estado.get(p.id)) return { resultado: "POSSE_PERDIDA" };                              // CAS: outro worker já reservou
      const chave = p.consolidacaoChave ?? `solo:${p.id}`;
      if (!w.chavesDoTelefone.has(chave)) { if (w.chavesDoTelefone.size >= p.maxPorContatoDia) return { resultado: "RATE_LIMIT_DIA" }; w.chavesDoTelefone.add(chave); }
      w.estado.set(p.id, "SENDING");
      return { resultado: "INICIADO", mensagem: { id: p.id, tentativas: 1 } };
    },
    finalizarEnvio: async (p) => { w.finais.push(p); return { id: p.id, status: "SENT" }; },
    resolverFalha: async (job, attempt, erro) => { w.falhas.push({ id: job.id, erro }); return { id: job.id, resultado: erro.preEnvio ? "FALHOU_RETRY" : "ENTREGA_INCERTA" }; },
    registrarIni: async (t) => { w.tentativas.push(t); }, registrarFin: async () => {}, auditar: async () => {},
  };
  w.rodar = (jobs, extra = {}) => processarLoteComConsolidacao({ jobs, opcoes: { whatsAppService }, deps: { supabase: db, consolidacaoImpl: w.impl }, env: ON, ...extra });
  return w;
}
const textos = (w) => w.provider.mensagensEnviadas.map((m) => m.texto);

describe("flag desligada", () => {
  test("devolve todos como individuais sem tocar pipeline, banco nem gateway", async () => {
    const w = montar();
    const r = await processarLoteComConsolidacao({ jobs: sete(), opcoes: { whatsAppService: w.whatsAppService }, deps: { consolidacaoImpl: w.impl }, env: {} });
    assert.equal(r.individuais.length, 7); assert.deepEqual(r.resultados, []);
    assert.deepEqual([Object.keys(w.passadas).length, w.reservas.length, w.provider.mensagensEnviadas.length], [0, 0, 0]);
  });
});

describe("os 7 relatórios do mesmo telefone", () => {
  test("UM envio ao gateway com os 7 relatórios completos e identificados; 7 reservas com a MESMA chave e os MESMOS parâmetros do envio individual; 7 SENT com o mesmo provider id", async () => {
    const w = montar(); const r = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 1);
    assert.equal(w.provider.mensagensEnviadas[0].telefoneE164, TEL);
    for (let n = 1; n <= 7; n++) assert.ok(textos(w)[0].includes(`*Empresa ${n} — Unidade ${n}*\nRelatório da loja ${n}: ${n} pendência(s).`), `relatório ${n}`);
    assert.equal(w.reservas.length, 7);
    assert.equal(new Set(w.reservas.map((p) => p.consolidacaoChave)).size, 1);
    assert.ok(w.reservas.every((p) => p.marcador === "mesmos-parametros-do-individual" && p.maxPorContatoDia === 3 && p.leaseSegundos === 90));
    assert.equal(w.finais.length, 7);
    assert.equal(new Set(w.finais.map((f) => f.providerMessageId)).size, 1);
    assert.ok(w.finais.every((f) => f.resultado === "SENT" && f.tentativa === 1));
    assert.deepEqual(r.individuais, []); assert.ok(r.resultados.every((x) => x.resultado === "ENVIADO" && x.consolidada === true));
    assert.equal(w.chavesDoTelefone.size, 1, "o telefone consumiu UMA vaga do teto");
  });
  test("a chave do gateway é a da consolidação (cons:…); o teto (3) NÃO é alterado pelo adaptador", async () => {
    const w = montar(); await w.rodar(sete());
    assert.match(w.provider.mensagensEnviadas[0].idempotencyKey, /^cons:[0-9a-f]{32}$/);
    assert.ok(w.reservas.every((p) => p.maxPorContatoDia === 3));
  });
  test("reprocessar o mesmo lote depois de enviado não reenvia (CAS da reserva ⇒ POSSE_PERDIDA; o gateway recebe uma mensagem só)", async () => {
    const w = montar(); await w.rodar(sete());
    const r2 = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 1);
    assert.ok(r2.resultados.every((x) => x.resultado === "POSSE_PERDIDA"));
  });
  test("dois workers (um deles com posse velha) com os MESMOS jobs ao mesmo tempo: cada relatório sai UMA vez só (o CAS da reserva decide quem o leva)", async () => {
    const w = montar(); const [a, b] = await Promise.all([w.rodar(sete()), w.rodar(sete())]);
    const todos = textos(w).join(" | ");
    for (let n = 1; n <= 7; n++) assert.equal(todos.split(`loja ${n}:`).length - 1, 1, `relatório ${n} enviado mais de uma vez`);
    assert.equal([...a.resultados, ...b.resultados].filter((x) => x.resultado === "ENVIADO").length, 7);
    assert.equal(w.finais.length, 7);
  });
});

describe("autorização, revogação e portões", () => {
  test("revogada/barrada na RELEITURA (2ª avaliação): não reserva, não entra no texto, mantém o resultado do pipeline", async () => {
    const w = montar({ bloqueio: (job, passada) => (job.id === "m3" && passada === 2 ? "BLOQUEADO" : null) });
    const r = await w.rodar(sete());
    assert.ok(!w.reservas.some((p) => p.id === "m3"));
    assert.ok(!textos(w)[0].includes("loja 3:") && textos(w)[0].includes("loja 4:"));
    assert.equal(r.resultados.find((x) => x.id === "m3").resultado, "BLOQUEADO");
    assert.equal(w.finais.length, 6);
  });
  test("barrada na 1ª avaliação (alerta encerrado, adiada, fora da janela): fica de fora com o resultado do pipeline; as outras saem", async () => {
    const w = montar({ bloqueio: (job) => (job.id === "m2" ? "CANCELADO_ALERTA_ENCERRADO" : job.id === "m5" ? "ADIADO" : null) });
    const r = await w.rodar(sete());
    assert.deepEqual(r.resultados.filter((x) => ["m2", "m5"].includes(x.id)).map((x) => x.resultado).sort(), ["ADIADO", "CANCELADO_ALERTA_ENCERRADO"]);
    assert.equal(w.finais.length, 5);
  });
  test("limite do banco na reserva (ex.: teto cheio): o pipeline adia/bloqueia com o motivo de hoje e o job não entra no texto", async () => {
    const w = montar({ teto: 0 }); const r = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 0);
    assert.equal(w.adiados.length, 7);
    assert.ok(w.adiados.every((a) => a.motivo === MOTIVO_DA_RESERVA.RATE_LIMIT_DIA && a.o.ratePorDia === true));
    assert.ok(r.resultados.every((x) => x.resultado === "ADIADO"));
  });
});

describe("falhas do gateway", () => {
  test("falha provada PRÉ-envio: nenhuma entrega SENT; cada componente passa pela classificação de hoje (retry); UMA chamada ao gateway", async () => {
    const w = montar(); w.provider.falharProximoEnvio({ mensagem: "recusou", preEnvio: true });
    const r = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 0); assert.equal(w.finais.length, 0);
    assert.equal(w.falhas.length, 7); assert.ok(w.falhas.every((f) => f.erro.preEnvio === true));
    assert.ok(r.resultados.every((x) => x.resultado === "FALHOU_RETRY"));
  });
  test("falha AMBÍGUA (timeout): todos vão para a resolução de dúvida e NUNCA há segundo envio", async () => {
    const w = montar(); w.provider.falharProximoEnvio({ mensagem: "timeout" });
    const r = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 0);
    assert.ok(r.resultados.every((x) => x.resultado === "ENTREGA_INCERTA"));
    assert.equal(w.falhas.length, 7);
  });
  test("gateway desconectado: falha pré-envio comprovada em todos (nada saiu)", async () => {
    const w = montar(); w.provider.definirConectado(false);
    const r = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 0);
    assert.ok(r.resultados.every((x) => x.resultado === "FALHOU_RETRY"));
  });
});

describe("telefone sem par, nomes e limites", () => {
  test("um job sozinho no telefone segue o fluxo individual (nada é reservado aqui)", async () => {
    const w = montar(); const r = await w.rodar([jobDe(1), jobDe(2, { contato_id: "CW-Y", tel: "+5511900000002" })]);
    assert.deepEqual(r.individuais.map((j) => j.id).sort(), ["m1", "m2"]); assert.equal(w.reservas.length, 0);
  });
  test("telefones diferentes no mesmo lote saem em mensagens separadas, cada uma com os blocos do seu telefone", async () => {
    const w = montar(); await w.rodar([jobDe(1), jobDe(2), jobDe(3, { contato_id: "CW-Y", tel: "+5511900000002" }), jobDe(4, { contato_id: "CW-Y", tel: "+5511900000002" })]);
    const por = Object.fromEntries(w.provider.mensagensEnviadas.map((m) => [m.telefoneE164, m.texto]));
    assert.ok(por[TEL].includes("loja 1:") && por[TEL].includes("loja 2:") && !por[TEL].includes("loja 3:"));
    assert.ok(por["+5511900000002"].includes("loja 3:") && !por["+5511900000002"].includes("loja 1:"));
  });
  test("nome da empresa/unidade indisponível: ninguém é enviado (fail-closed), o job fica para o lease expirar", async () => {
    const w = montar({ falhaNome: true }); const r = await w.rodar(sete());
    assert.equal(w.provider.mensagensEnviadas.length, 0); assert.equal(w.reservas.length, 0);
    assert.ok(r.resultados.every((x) => x.resultado === "ERRO_INTERNO"));
  });
  test("relatório maior que o limite do provedor volta ao fluxo individual (que reavalia tudo); os demais saem", async () => {
    const w = montar(); const jobs = sete(); jobs[2].conteudo = "x".repeat(5000);
    const r = await w.rodar(jobs);
    assert.deepEqual(r.individuais.map((j) => j.id), ["m3"]);
    assert.ok(!textos(w)[0].includes("xxxx")); assert.equal(w.finais.length, 6);
  });
  test("telefone do grupo divergente: nada sai (falha pré-envio provada)", async () => {
    const w = montar(); const jobs = sete(); jobs[1].tel = "+5511900000009";
    const r = await w.rodar(jobs);
    assert.equal(w.provider.mensagensEnviadas.length, 0); assert.ok(r.resultados.every((x) => x.resultado === "FALHOU_RETRY"));
  });
});
