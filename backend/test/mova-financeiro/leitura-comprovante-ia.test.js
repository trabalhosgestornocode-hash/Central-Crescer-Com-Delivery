// Correção de 23/11/2026: comprovante legível respondido com "envie uma foto mais nítida" quando a contagem de tokens (pré-teto)
// falhou. Sem banco: orçamento FAKE em memória + cliente Anthropic FAKE; o extrator e o invólucro de orçamento são os REAIS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clienteComOrcamento } from "../../src/modules/mova-financeiro/infra/operacao.js";
import { criarExtratorAnthropic, ErroDeIa, MODELO_PADRAO } from "../../src/modules/mova-financeiro/ia/provedorAnthropic.js";
import { ErroTransitorio } from "../../src/modules/mova-financeiro/gateway/fila.js";
import { respostaDaFalhaDeLeitura } from "../../src/modules/mova-financeiro/aplicacao/motor.js";
import { RESPOSTA } from "../../src/modules/mova-financeiro/aplicacao/respostas.js";
import { RESPOSTA_DOCUMENTO } from "../../src/modules/mova-financeiro/aplicacao/recebimentoDocumental.js";
import { SAIDA_VAZIA, validarSaidaDaIa } from "../../src/modules/mova-financeiro/ia/contratos.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const TETO = Object.freeze({ maxSaida: 600, maxEntrada: 20000, esforco: "low" });
const COMPROVANTE = { ...SAIDA_VAZIA, legivel: true, tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", valorCentavos: 10800, dataPagamento: "2026-11-19",
  horaTransacao: "11:06:57", pagador: "AF Produtos de Alimentação", favorecido: "Andressa Rodrigues Aragão Pereira", instituicao: "Unicred Raízes", instituicaoDestino: "Caixa Econômica Federal", confianca: "ALTA" };

function montar({ contar = async () => ({ input_tokens: 3000 }), esgotado = false } = {}) {
  const reg = { contagens: 0, chamadas: [], reservas: 0 };
  const cliente = { beta: { messages: {
    async countTokens(p) { reg.contagens++; return contar(p); },
    async create(req) { reg.chamadas.push(req); return { model: MODELO_PADRAO, stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 250 }, content: [{ type: "text", text: JSON.stringify(COMPROVANTE) }] }; },
  } } };
  const orcamento = { async reservar() { if (esgotado) throw new ErroDeIa("ORCAMENTO_ESGOTADO"); reg.reservas++; return reg.reservas; }, async concluir() {}, async falhar() {} };
  const evidencias = new Map([["img", PNG], ["pdf", PDF]]);
  const extrator = criarExtratorAnthropic({ cliente: clienteComOrcamento(cliente, { orcamento, teto: TETO }), obterEvidencia: async (r) => evidencias.get(r) ?? null });
  return { extrator, reg };
}
const ler = (extrator, referencia, mime) => extrator.extrair({ texto: null, tipo: "IMAGEM", midia: { mime, referencia }, contexto: { unidades: ["Açaí Saci"] } });
const falha = (p) => p.then(() => assert.fail("deveria falhar"), (e) => e);

test("imagem: o extrator Anthropic É acionado (contagem, reserva, chamada) e devolve o comprovante estruturado", async () => {
  const { extrator, reg } = montar();
  const saida = await ler(extrator, "img", "image/png");
  assert.equal(reg.contagens, 1); assert.equal(reg.reservas, 1); assert.equal(reg.chamadas.length, 1, "chamada ao provedor ocorreu");
  assert.equal(reg.chamadas[0].model, "claude-haiku-5-5");
  assert.equal(reg.chamadas[0].messages[0].content[0].type, "image");
  const v = validarSaidaDaIa(saida);
  assert.ok(v.ok, v.erro);
  assert.equal(v.saida.valorCentavos, 10800); assert.equal(v.saida.instituicaoDestino, "Caixa Econômica Federal"); assert.equal(v.saida.horaTransacao, "11:06:57");
});

test("PDF: segue como bloco document e também chega à IA", async () => {
  const { extrator, reg } = montar();
  await ler(extrator, "pdf", "application/pdf");
  assert.equal(reg.chamadas[0].messages[0].content[0].type, "document");
});

test("contagem de tokens com instabilidade (503/429/conexão) NÃO vira falha de leitura: é transitória, nada reservado", async () => {
  for (const err of [Object.assign(new Error("x"), { status: 503 }), Object.assign(new Error("x"), { status: 429 }), Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" })]) {
    const { extrator, reg } = montar({ contar: async () => { throw err; } });
    const e = await falha(ler(extrator, "img", "image/png"));
    assert.ok(e instanceof ErroTransitorio, `esperava transitório, veio ${e?.name}:${e?.codigo}`);
    assert.equal(reg.reservas, 0); assert.equal(reg.chamadas.length, 0);
  }
});

test("contagem recusada pela API guarda a CAUSA (status e nome do erro) em código próprio, sem eco de conteúdo", async () => {
  let { extrator } = montar({ contar: async () => { throw Object.assign(new Error("imagem inválida: conteudo-do-documento"), { status: 400, name: "BadRequestError" }); } });
  let e = await falha(ler(extrator, "img", "image/png"));
  assert.equal(e.codigo, "IA_TETO_MIDIA_INVALIDA"); assert.equal(e.detalhe, "contagem:http_400:BadRequestError");
  ({ extrator } = montar({ contar: async () => { throw Object.assign(new Error("x"), { status: 401 }); } }));
  e = await falha(ler(extrator, "img", "image/png"));
  assert.equal(e.codigo, "IA_SEM_AUTORIZACAO");
  ({ extrator } = montar({ contar: async () => { throw new Error("desconhecido"); } }));
  e = await falha(ler(extrator, "img", "image/png"));
  assert.equal(e.codigo, "IA_TETO_CONTAGEM_INDISPONIVEL"); assert.match(e.detalhe, /^contagem:http_sem_resposta:/);
});

test("orçamento esgotado: nenhuma chamada sai; entrada acima do teto: recusada antes de reservar", async () => {
  let { extrator, reg } = montar({ esgotado: true });
  let e = await falha(ler(extrator, "img", "image/png"));
  assert.equal(e.codigo, "ORCAMENTO_ESGOTADO"); assert.equal(reg.chamadas.length, 0);
  ({ extrator, reg } = montar({ contar: async () => ({ input_tokens: 50000 }) }));
  e = await falha(ler(extrator, "img", "image/png"));
  assert.equal(e.codigo, "IA_TETO_ENTRADA_EXCEDIDA"); assert.equal(reg.reservas, 0); assert.equal(reg.chamadas.length, 0);
});

test("mídia indisponível na leitura é transitória; formato fora do aceito tem código próprio", async () => {
  const { extrator } = montar();
  assert.ok((await falha(ler(extrator, "inexistente", "image/png"))) instanceof ErroTransitorio);
  assert.equal((await falha(ler(extrator, "img", "image/heic"))).codigo, "MIDIA_NAO_SUPORTADA");
});

test("respostas por causa: técnico não pede foto mais nítida; só o modelo declarar ilegível usa essa frase", () => {
  const ev = { midia: { mime: "image/png" } };
  const r = (codigo, motivo) => respostaDaFalhaDeLeitura({ ok: false, codigo, motivo }, ev);
  const tecnico = RESPOSTA.falhaTecnicaDeLeitura();
  for (const c of ["IA_TETO_CONTAGEM_INDISPONIVEL", "IA_REQUISICAO_INVALIDA", "IA_ERRO_PERMANENTE", "IA_SEM_AUTORIZACAO", "IA_JSON_INVALIDO", "IA_RESPOSTA_TRUNCADA"]) {
    assert.equal(r(c, `EXTRATOR_FALHOU:${c}`), tecnico);
  }
  assert.ok(!/nítida/.test(tecnico));
  assert.equal(r("MIDIA_NAO_SUPORTADA", "x"), RESPOSTA_DOCUMENTO.formatoNaoAceito());
  assert.equal(r("IA_TETO_ENTRADA_EXCEDIDA", "x"), RESPOSTA.documentoPesadoParaLeitura());
  assert.equal(r(undefined, "IA_SAIDA_INVALIDA:valorCentavos"), RESPOSTA.documentoNaoIdentificado());
  assert.equal(r(undefined, "DOCUMENTO_ILEGIVEL"), RESPOSTA.falhaLeitura());
  assert.match(RESPOSTA.falhaLeitura(), /nítida/);
  assert.equal(respostaDaFalhaDeLeitura({ ok: false, codigo: "AUDIO_SEM_TRANSCRICAO" }, ev), RESPOSTA.audioSemTranscricao());
});
