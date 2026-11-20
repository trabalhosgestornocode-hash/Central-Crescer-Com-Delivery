// MOVA — Execução 04A: PRIMEIRA VALIDAÇÃO REAL DA IA (chamadas reais à Anthropic, SOMENTE com dados fictícios).
//
// Uso (manual; custa dinheiro, por isso NÃO é um *.test.js):
//   MOVA_ENV_ARQUIVO=<caminho do .env que tem a chave> node scripts/mova/validacaoIaReal.mjs
// Segurança:
//   - lê APENAS a linha ANTHROPIC_API_KEY do arquivo indicado (nenhuma outra variável é carregada — o .env do backend é o de
//     produção e não pode contaminar este processo); a chave nunca é impressa, gravada ou repassada a outro lugar;
//   - tudo é sintético: unidades Alfa/Beta/Gama, fornecedores inventados, documento PDF gerado aqui;
//   - MOVA em memória + núcleo do Financeiro v2 em memória: nada toca banco, WhatsApp ou produção;
//   - teto: MAX_CHAMADAS e TETO_USD — ao atingir, para.
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, TODAS, ctx, montar } from "../../test/financeiro-v2/helpers/cenario.js";
import { criarExtratorAnthropic, criarMova, validarSaidaDaIa, MODELO_PADRAO } from "../../src/modules/mova-financeiro/index.js";

const MAX_CHAMADAS = 10;
const TETO_USD = 1.0;
const PRECO = { entradaPorMilhao: 4.0, saidaPorMilhao: 20.0 }; // Claude Opus 5.5 (tabela de preços da Anthropic)

function lerChave() {
  const arq = process.env.MOVA_ENV_ARQUIVO;
  if (!arq) throw new Error("Informe MOVA_ENV_ARQUIVO.");
  const linha = readFileSync(arq, "utf8").split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  const v = linha ? linha.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "") : "";
  if (!v) throw new Error("ANTHROPIC_API_KEY ausente no arquivo indicado.");
  return v;
}

/** PDF mínimo válido com texto (boleto FICTÍCIO), gerado aqui — nenhum documento real. */
function pdfFicticio(linhas) {
  const texto = linhas.map((l, i) => `BT /F1 12 Tf 50 ${760 - i * 20} Td (${l.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(texto, "latin1")} >>\nstream\n${texto}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let corpo = "%PDF-1.4\n";
  const pos = [];
  objs.forEach((o, i) => { pos.push(Buffer.byteLength(corpo, "latin1")); corpo += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(corpo, "latin1");
  corpo += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${pos.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("")}`;
  corpo += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(corpo, "latin1"));
}

// ---------------------------------------------------------------- cliente real com medição (tokens, tempo, teto)
const medicoes = [];
let gastoUsd = 0;
function clienteMedido(real) {
  return { beta: { messages: { async create(req) {
    if (medicoes.length >= MAX_CHAMADAS) throw Object.assign(new Error("teto de chamadas"), { status: 400 });
    if (gastoUsd >= TETO_USD) throw Object.assign(new Error("teto de custo"), { status: 400 });
    const t0 = Date.now();
    try {
      const r = await real.beta.messages.create(req);
      const u = r.usage ?? {};
      const custo = ((u.input_tokens ?? 0) * PRECO.entradaPorMilhao + (u.output_tokens ?? 0) * PRECO.saidaPorMilhao) / 1e6;
      gastoUsd += custo;
      medicoes.push({ ok: true, modelo: r.model, ms: Date.now() - t0, entrada: u.input_tokens ?? 0, saida: u.output_tokens ?? 0, custo, parada: r.stop_reason });
      return r;
    } catch (e) {
      medicoes.push({ ok: false, ms: Date.now() - t0, status: e?.status ?? null, erro: String(e?.error?.error?.message ?? e?.message ?? "erro").slice(0, 300) });
      throw e;
    }
  } } } };
}

// ---------------------------------------------------------------- cenário sintético (MOVA em memória + núcleo real em memória)
const ORG = "dddddddd-0000-4000-8000-000000000001";
const U = { ALFA: "dddddddd-0000-4000-8000-0000000000a1", BETA: "dddddddd-0000-4000-8000-0000000000b1", GAMA: "dddddddd-0000-4000-8000-0000000000c1" };
// MOVA_VALIDACAO=privado: mesma validação pela CONVERSA PRIVADA de homologação (contato FICTÍCIO, modo HOMOLOGACAO).
const PRIVADO = process.env.MOVA_VALIDACAO === "privado";
const G = PRIVADO ? "5500000000777@s.whatsapp.net" : "120363000000000001@g.us";
const CONFIG = {
  modo: PRIVADO ? "HOMOLOGACAO" : "SIMULACAO", identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [
    { organizacaoId: ORG, unidadeId: U.ALFA, nome: "Unidade Alfa", apelidos: ["alfa"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD"] } },
    { organizacaoId: ORG, unidadeId: U.BETA, nome: "Unidade Beta", apelidos: ["beta"], fontes: { situacao: "A_CONFIRMAR" } },
    { organizacaoId: ORG, unidadeId: U.GAMA, nome: "Unidade Gama", apelidos: ["gama"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"] } },
  ],
  gruposAutorizados: [{ grupoId: G, unidades: Object.values(U) }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
let seq = 0;
const gw = ({ texto = null, doc = null, mime = "application/pdf" }) => ({
  contratoMova: 1, eventoId: `bly:IAREAL${++seq}`, mensagemId: `IAREAL${seq}`, grupoId: G, participanteId: PRIVADO ? G : "100000000000001@lid", telefoneE164: PRIVADO ? "+5500000000777" : null, nomeExibicao: "Pessoa Teste", fromMe: false,
  tipo: doc ? "DOCUMENTO" : "TEXTO", texto, respostaA: null, midia: doc ? { mime, nomeArquivo: null, tamanhoBytes: doc.length, base64: Buffer.from(doc).toString("base64") } : null,
  recebidoEm: AGORA.toISOString(), origemTipo: "LIVE",
});

async function principal() {
  const real = new Anthropic({ apiKey: lerChave(), maxRetries: 1 });
  const relatorio = { modeloPedido: MODELO_PADRAO, cenarios: [] };
  // ETAPA 1 — modelo disponível para a conta (Models API: não consome tokens)
  try { const m = await real.models.retrieve(MODELO_PADRAO); relatorio.modeloDisponivel = { id: m.id, nome: m.display_name, maxEntrada: m.max_input_tokens ?? null }; }
  catch (e) { relatorio.modeloDisponivel = { erro: e?.status ?? "falha", mensagem: String(e?.message ?? "").slice(0, 200) }; }

  const cliente = clienteMedido(real);
  // ETAPA 2 — chamada mínima, direto no extrator (contrato estrito validado)
  const extrator = criarExtratorAnthropic({ cliente, obterEvidencia: async () => null, relogio: () => AGORA });
  try {
    const bruta = await extrator.extrair({ texto: "Identifique o valor e a finalidade da despesa fictícia: pagamento de material de limpeza no valor de R$ 120,00 para uma loja de testes.", tipo: "TEXTO", midia: null, contexto: { unidades: ["Unidade Alfa"] } });
    const v = validarSaidaDaIa(bruta);
    relatorio.chamadaMinima = { contratoValido: v.ok, erro: v.ok ? null : v.erro, valorCentavos: bruta?.valorCentavos ?? null, tipoDocumento: bruta?.tipoDocumento, intencao: bruta?.intencao, justificativa: bruta?.justificativa ?? null };
  } catch (e) { relatorio.chamadaMinima = { falhou: e?.codigo ?? e?.message }; }
  if (!relatorio.chamadaMinima?.contratoValido) { relatorio.medicoes = medicoes; console.log(JSON.stringify(relatorio, null, 2)); return; } // não gasta os cenários se a mínima falhou

  // ETAPA 3 — cenários pelo motor (MOVA em memória, núcleo do Financeiro em memória)
  const m = montar({ escopos: Object.values(U).map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
  const c = (u) => ctx(ORG, u, TODAS);
  const forn = await m.nucleo.registrarContraparte(c(U.ALFA), { tipo: "FORNECEDOR", nome: "Distribuidora Teste Limpeza" });
  await m.nucleo.registrarObrigacao(c(U.ALFA), { contraparteId: forn.id, valorOriginalCentavos: 35000, categoria: "INSUMOS", descricao: "Compra fictícia", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-12" });
  const caixa = await m.nucleo.configurarContaFinanceira(c(U.GAMA), { tipo: "CAIXA_FISICO", nome: "Caixa teste" });
  await m.nucleo.registrarVenda(c(U.GAMA), { canal: "BALCAO", dataVenda: "2026-10-14", brutoCentavos: 184050, fonte: { sistema: "MANUAL", idExterno: "V-FICT-1" }, composicao: { itensCentavos: 184050 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 184050, contaId: caixa.id }] });
  const ref = { mova: null };
  const extratorMotor = criarExtratorAnthropic({ cliente, obterEvidencia: (r) => ref.mova.evidencias.obter(r), relogio: () => AGORA });
  ref.mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, extrator: extratorMotor, relogio: () => AGORA });
  const mova = ref.mova;

  const cenarios = [
    { nome: "1. Nova conta a pagar (boleto PDF fictício)", esperado: ["PROPOSTA", "NOVA_OBRIGACAO"],
      p: gw({ texto: "registre esse boleto da alfa", doc: pdfFicticio(["BOLETO DE TESTE - DOCUMENTO FICTICIO", "Beneficiario: Grafica Exemplo Teste Ltda", "Valor do documento: R$ 480,00", "Vencimento: 30/10/2026", "Data do documento: 02/10/2026", "Referencia: impressao de cardapios (teste)"]) }) },
    { nome: "2. Comprovante de obrigação existente", esperado: ["PROPOSTA", "BAIXA_DE_OBRIGACAO"],
      p: gw({ texto: "comprovante pago hoje da alfa", doc: pdfFicticio(["COMPROVANTE DE PAGAMENTO - FICTICIO", "Pagamento de boleto", "Favorecido: Distribuidora Teste Limpeza", "Valor pago: R$ 350,00", "Data do pagamento: 12/10/2026"]) }) },
    { nome: "3. Transferência entre contas próprias", esperado: ["ORIENTACAO", "TRANSFERENCIA_INTERNA_NAO_E_DESPESA"],
      p: gw({ texto: "fiz uma transferência da conta da gama para a conta reserva da própria gama, R$ 2.000,00 hoje — não é despesa" }) },
    { nome: "4. Valor ambíguo", esperado: ["PEDIR_INFORMACAO", "VALOR_AMBIGUO"],
      p: gw({ texto: "comprovante da alfa", doc: pdfFicticio(["RECIBO FICTICIO", "Prestador: Manutencao Teste ME", "Servico de manutencao: R$ 300,00", "Pecas: R$ 150,00", "Total pago: R$ 400,00 ?", "Obs: valor final a confirmar com o prestador", "Data: 10/10/2026"]) }) },
    { nome: "5. Unidade não identificada", esperado: ["PEDIR_INFORMACAO", "UNIDADE_NAO_IDENTIFICADA"],
      p: gw({ texto: "segue o comprovante", doc: pdfFicticio(["COMPROVANTE PIX - FICTICIO", "Recebedor: Papelaria Teste", "Valor: R$ 89,90", "Data: 11/10/2026"]) }) },
    { nome: "6. Pergunta sobre faturamento (dados de teste)", esperado: ["CONSULTA", "FATURAMENTO"],
      p: gw({ texto: "MOVA, quanto faturamos ontem na gama?" }) },
  ];
  const despesa = { nome: "P. Despesa fictícia sem obrigação", esperado: ["PROPOSTA", "DESPESA_PAGA"], p: gw({ texto: "paguei material de limpeza da gama", doc: pdfFicticio(["CUPOM FISCAL FICTICIO", "Mercado Exemplo Teste", "Material de limpeza", "Total: R$ 120,00", "Data: 13/10/2026"]) }) };
  const lista = PRIVADO ? [despesa, cenarios[1], cenarios[2]] : cenarios;
  for (const cen of lista) {
    const antes = medicoes.length;
    try {
      await mova.receptor.receber(cen.p);
      await mova.receptor.trabalhar();
    } catch (e) { relatorio.cenarios.push({ nome: cen.nome, erro: e?.codigo ?? e?.message }); continue; }
    const h = (await mova.armazenamento.historico.todos()).at(-1);
    const resp = (await mova.armazenamento.saida.listar()).at(-1)?.texto ?? null;
    const ok = h?.decisao === cen.esperado[0] && (h?.motivo === cen.esperado[1] || h?.motivo?.startsWith(cen.esperado[1]));
    relatorio.cenarios.push({ nome: cen.nome, esperado: cen.esperado.join("/"), obtido: `${h?.decisao}/${h?.motivo}`, ok, chamadas: medicoes.length - antes, resposta: resp });
  }
  relatorio.medicoes = medicoes;
  relatorio.totais = { chamadas: medicoes.length, entrada: medicoes.reduce((s, x) => s + (x.entrada ?? 0), 0), saida: medicoes.reduce((s, x) => s + (x.saida ?? 0), 0), custoUsd: Number(gastoUsd.toFixed(4)) };
  relatorio.escritasNoFinanceiro = "nenhuma (o motor só cria propostas; nada foi aplicado)";
  console.log(JSON.stringify(relatorio, null, 2));
}

principal().catch((e) => { console.error("FALHA:", e?.message ?? e); process.exitCode = 1; });
