// Fase 11 (doc 48) — importações DENTRO da página de cada canal (SAIPOS, iFood, 99Food). Só apresentação: formatos, estado de cada um,
// prévia e histórico vêm prontos do servidor. Dados SINTÉTICOS; o último teste usa o PAYLOAD REAL do backend em memória.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as imp from "../financeiro-v2/telasImportacoesCanais.js";
import * as can from "../financeiro-v2/telasCanais.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { CONSULTAS } from "../../backend/src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../backend/src/modules/fv2-integracao/escritas.js";
import { ctx as ctxBackend, montar } from "../../backend/test/financeiro-v2/helpers/cenario.js";

const arquivo = (n) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${n}`, import.meta.url)), "utf8");
const formatoSaipos = (id, nome, principal = false) => ({ id, tipoRelatorio: id, nome, principal, descricao: "Descrição do formato.", modo: "ARQUIVO", disponivel: true, motivo: null, aceitaArquivo: true, extensoes: ["xlsx"], homologado: true, extensoesHomologadas: ["xlsx"] });
const saipos = (extra = {}) => ({ canal: "SAIPOS", hoje: "2026-11-25", unidade: { nome: "Unidade sintética" }, acoes: { importar: true, confirmar: true, registrarDemonstrativo: true }, demonstrativos: [], porEstado: {},
  formatos: [formatoSaipos("SAIPOS_VENDAS", "Vendas por período (XLSX, por pedido)", true), formatoSaipos("SAIPOS_FORMAS_PAGAMENTO", "Formas de pagamento (XLSX, por dia)"), formatoSaipos("SAIPOS_DESEMPENHO_POR_ATENDENTE", "Canais de venda"), formatoSaipos("SAIPOS_FATURAMENTO_POR_DIA", "Faturamento por dia (PDF)")],
  historico: [{ id: "imp-1", tipoRelatorio: "SAIPOS_VENDAS", relatorio: "Vendas por pedido do SAIPOS", periodoInicio: "2026-11-01", periodoFim: "2026-11-15", estado: "IMPORTADO", erros: 0, divergencias: 2, jaExistentes: 5 },
    { id: "imp-2", tipoRelatorio: "SAIPOS_VENDAS", relatorio: "Vendas por pedido do SAIPOS", periodoInicio: "2026-11-16", periodoFim: "2026-11-16", estado: "PRONTO_PARA_IMPORTAR", erros: 1, divergencias: 0, jaExistentes: 0 }], ...extra });
const ifood = (extra = {}) => ({ canal: "IFOOD", hoje: "2026-11-25", unidade: { nome: "Unidade sintética" }, acoes: { importar: true, confirmar: true, registrarDemonstrativo: true }, porEstado: {}, historico: [],
  formatos: [{ id: "IFOOD_DEMONSTRATIVO", tipoRelatorio: null, nome: "Demonstrativo financeiro oficial do iFood", principal: true, descricao: "Você informa os valores do demonstrativo oficial.", modo: "DEMONSTRATIVO", disponivel: true, motivo: null, aceitaArquivo: false, extensoes: [], homologado: false, extensoesHomologadas: [] },
    { id: "IFOOD_APURACAO", tipoRelatorio: "IFOOD_APURACAO", nome: "Apuração financeira do iFood (arquivo)", principal: false, descricao: null, modo: null, disponivel: false, motivo: "O leitor deste arquivo existe só como contrato sintético: ainda não foi validado com um arquivo oficial real.", aceitaArquivo: false, extensoes: [], homologado: false, extensoesHomologadas: [] },
    { id: "IFOOD_PEDIDOS", tipoRelatorio: null, nome: "Relatório oficial de pedidos do iFood", principal: false, descricao: null, modo: null, disponivel: false, motivo: "Ainda não existe leitor do relatório oficial de pedidos do iFood.", aceitaArquivo: false, extensoes: [], homologado: false, extensoesHomologadas: [] }],
  demonstrativos: [{ id: "d1", periodoInicio: "2026-11-01", periodoFim: "2026-11-08", brutoCentavos: 100000, comissoesCentavos: 12000, taxasCentavos: 2000, mensalidadesCentavos: 1000, descontosEPromocoesCentavos: 5000, ajustesCentavos: 0, repassePrevistoCentavos: 80000, repasseRecebidoCentavos: 0, situacaoRepasse: "PREVISTO" }], ...extra });
const noventa = () => ({ canal: "NOVENTA_E_NOVE_FOOD", hoje: "2026-11-25", unidade: { nome: "Unidade sintética" }, acoes: { importar: true, confirmar: true, registrarDemonstrativo: true }, porEstado: {}, historico: [], demonstrativos: [], algumFormatoDisponivel: false,
  formatos: [{ id: "NOVENTA_E_NOVE_FOOD_RELATORIO", tipoRelatorio: null, nome: "Relatório oficial da 99Food", principal: true, descricao: null, modo: null, disponivel: false, motivo: "Ainda não recebemos um relatório oficial da 99Food. Precisamos validar o primeiro relatório oficial antes de aceitar qualquer importação: nenhum formato é presumido.", aceitaArquivo: false, extensoes: [], homologado: false, extensoesHomologadas: [] }] });

test("SAIPOS: formatos com selos, unidade, período, arquivo, confirmação e histórico — tudo na própria página, só relatórios SAIPOS", () => {
  const html = imp.importacoesDoCanal(saipos(), { periodoPadrao: { inicio: "2026-11-01", fim: "2026-11-25" } });
  assert.match(html, /data-importacoes-canal="SAIPOS"/);
  assert.equal((html.match(/class="formato formato--ok"/g) ?? []).length, 4);
  assert.match(html, /Vendas por período \(XLSX, por pedido\)[\s\S]*?Disponível[\s\S]*?Principal[\s\S]*?Leitor homologado \(XLSX\)/);
  const form = html.match(/<form class="acao acao--formulario" data-acao="\/api\/fv2\/acoes\/importacao\/receber"[\s\S]*?<\/form>/)[0];
  assert.match(form, /data-envio-evidencia/, "mesmo envio da Central (arquivo lido e conferido)");
  assert.match(form, /data-recarregar="resultado:documento"/, "a prévia abre no painel logo depois do envio");
  assert.match(form, /name="periodoInicio" value="2026-11-01" required/);
  assert.match(form, /name="periodoFim" value="2026-11-25" required/);
  assert.match(form, /type="file" name="arquivo" accept="\.xlsx,\.pdf,\.csv" required/);
  assert.match(form, /name="confirmar" required/);
  const opcoes = [...form.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(opcoes, ["SAIPOS_VENDAS", "SAIPOS_FORMAS_PAGAMENTO", "SAIPOS_DESEMPENHO_POR_ATENDENTE", "SAIPOS_FATURAMENTO_POR_DIA"]);
  assert.match(form, /value="SAIPOS_VENDAS" selected>[^<]*recomendado/);
  assert.match(html, /<strong>Unidade:<\/strong> Unidade sintética/);
  assert.match(html, /Unidade sintética\. Nada entra no financeiro antes da confirmação da prévia/);
  // Histórico: situação, erros, divergências, já existentes e abertura da prévia/confirmação sem sair da página.
  assert.match(html, /data-detalhe="documento:imp-1">Ver prévia e propostas/);
  assert.match(html, /data-detalhe="documento:imp-2">Conferir prévia e confirmar/);
  assert.match(html, /Prévia pronta: aguardando confirmação/);
  assert.match(html, /href="#\/conferencias"[^>]*>Central de Importações e Conferências/, "a Central continua existindo e é só um atalho");
});

test("sem permissão de importar: formatos e histórico aparecem, o envio não", () => {
  const html = imp.importacoesDoCanal(saipos({ acoes: { importar: false, confirmar: false, registrarDemonstrativo: false } }));
  assert.doesNotMatch(html, /data-acao=/);
  assert.match(html, /Você não tem permissão para importar nesta unidade/);
  assert.match(html, /Histórico de importações SAIPOS/);
  assert.match(html, /data-detalhe="documento:imp-1"/);
});

test("iFood: demonstrativo oficial disponível; apuração em arquivo e relatório de pedidos INDISPONÍVEIS com o motivo; nenhum envio de arquivo", () => {
  const html = imp.importacoesDoCanal(ifood());
  assert.equal((html.match(/class="formato formato--ok"/g) ?? []).length, 1);
  assert.equal((html.match(/class="formato formato--off"/g) ?? []).length, 2);
  assert.match(html, /contrato sintético/);
  assert.match(html, /Ainda não existe leitor do relatório oficial de pedidos/);
  assert.doesNotMatch(html, /data-acao="\/api\/fv2\/acoes\/importacao\/receber"/, "nenhum envio de arquivo no iFood");
  const form = html.match(/<form class="acao acao--formulario" data-previa-demonstrativo[\s\S]*?<\/form>/)[0];
  for (const c of ["periodoInicio", "periodoFim", "vendas", "comissoes", "taxaPagamento", "mensalidade", "servicosEPromocoes", "ajustes", "liquido", "origem", "justificativa"]) assert.match(form, new RegExp(`name="${c}"`), c);
  assert.match(form, /name="vendas"[^>]* required/);
  assert.match(form, /name="liquido"[^>]* required/);
  assert.match(form, /Conferir prévia/);
  assert.doesNotMatch(form, /name="confirmar"/, "a confirmação só existe depois da prévia");
  assert.match(html, /Demonstrativos oficiais registrados[\s\S]*R\$ 1\.000,00[\s\S]*R\$ 800,00/);
  assert.match(html, /Nenhum arquivo importado\. O iFood entra pelo demonstrativo oficial\./);
});

test("99Food: o envio existe só para mostrar o que virá — tudo desabilitado, motivo claro, sem ação possível", () => {
  const html = imp.importacoesDoCanal(noventa());
  assert.equal((html.match(/formato--ok/g) ?? []).length, 0);
  assert.match(html, /validar o primeiro relatório oficial/);
  const form = html.match(/<form[^>]*data-envio-bloqueado[\s\S]*?<\/form>/)[0];
  assert.match(form, /<fieldset disabled>/);
  assert.doesNotMatch(form, /data-acao=/, "não aponta para nenhuma ação");
  assert.doesNotMatch(html, /data-acao=/);
  assert.doesNotMatch(html, /name="confirmar"/);
  assert.match(html, /Nenhuma importação: ainda não há relatório oficial validado\./);
  assert.match(html, /nenhum formato é aceito nem presumido/);
});

test("prévia do demonstrativo do iFood: período, faturamento, comissões, taxas, ajustes, repasse e pendências; confirmação só quando a conta fecha", () => {
  const params = { periodoInicio: "2026-11-09", periodoFim: "2026-11-11", vendas: "500,00", comissoes: "60,00", taxaPagamento: "10,00", mensalidade: "0,00", servicosEPromocoes: "20,00", ajustes: "0,00", liquido: "410,00", origem: "Demonstrativo X", justificativa: "Teste" };
  const previa = { valido: true, periodoInicio: "2026-11-09", periodoFim: "2026-11-11", competencia: "2026-11", origem: "Demonstrativo X", faturamentoCentavos: 50000, comissoesCentavos: 6000, taxasCentavos: 1000, mensalidadeCentavos: 0, servicosEPromocoesCentavos: 2000, ajustesCentavos: 0,
    liquidoInformadoCentavos: 41000, liquidoCalculadoCentavos: 41000, diferencaCentavos: 0, fecha: true, repasse: { previstoCentavos: 41000, dataPrevista: "2026-11-11", observacao: "É o que o iFood deve repassar. Não é depósito." }, jaRegistrado: false, bloqueios: [],
    pendencias: [{ codigo: "SERVICOS_E_PROMOCOES_A_CLASSIFICAR", mensagem: "Serviços e promoções ficam como dedução a classificar." }, { codigo: "DETALHE_DIARIO_DEPENDE_DO_RELATORIO_DE_PEDIDOS", mensagem: "O detalhamento por dia depende do relatório oficial de pedidos." }], podeConfirmar: true };
  const ok = imp.previaDoDemonstrativo(previa, { params, podeRegistrar: true });
  for (const t of ["09/11/2026 a 11/11/2026", "R$ 500,00", "R$ 60,00", "R$ 10,00", "R$ 20,00", "R$ 410,00", "A conta fecha", "Repasse previsto", "Não é depósito", "Pendências", "dedução a classificar", "Nada foi registrado ainda"]) assert.ok(ok.includes(t), t);
  const form = ok.match(/<form class="acao acao--embutida" data-acao="\/api\/fv2\/acoes\/vendas\/demonstrativo-ifood"[\s\S]*?<\/form>/)[0];
  assert.match(form, /name="confirmar" required/);
  for (const [k, v] of Object.entries(params)) assert.ok(form.includes(`<input type="hidden" name="${k}" value="${v}">`), `reenvia ${k}`);
  // Não fecha: mostra a diferença e NÃO oferece a confirmação.
  const ruim = imp.previaDoDemonstrativo({ ...previa, fecha: false, podeConfirmar: false, liquidoCalculadoCentavos: 41000, liquidoInformadoCentavos: 40000, diferencaCentavos: -1000, bloqueios: [{ codigo: "NAO_FECHA", mensagem: "O demonstrativo não fecha." }] }, { params, podeRegistrar: true });
  assert.match(ruim, /A conta não fecha/);
  assert.match(ruim, /diferença de -?R\$ 10,00|diferença de .*10,00/);
  assert.match(ruim, /O que impede o registro/);
  assert.doesNotMatch(ruim, /data-acao=/);
  // Já registrado, sem permissão e dado inválido.
  assert.match(imp.previaDoDemonstrativo({ ...previa, jaRegistrado: true, podeConfirmar: false }, { params, podeRegistrar: true }), /já está registrado: confirmar de novo não duplica/);
  assert.match(imp.previaDoDemonstrativo(previa, { params, podeRegistrar: false }), /Registrar exige a permissão/);
  assert.doesNotMatch(imp.previaDoDemonstrativo(previa, { params, podeRegistrar: false }), /data-acao=/);
  assert.match(imp.previaDoDemonstrativo({ valido: false, erro: "O período do demonstrativo fica dentro de uma competência." }), /role="alert"[^>]*>O período do demonstrativo/);
});

test("prévia do relatório SAIPOS (detalhe do documento): separa Presencial e Anota Aí, iFood/99Food só conferência, cancelados, e avisa de conflito de granularidade", () => {
  const doc = { id: "imp-9", relatorio: "Vendas por período", fonte: "SAIPOS", estado: "PRONTO_PARA_IMPORTAR", periodo: { inicio: "2026-11-09", fim: "2026-11-09" }, recebidoEm: "2026-11-25", responsavel: "Pessoa", versao: 1, compatibilidade: { homologado: true, texto: "ok" } };
  const previa = { reconhecido: true, validos: 5, registros: 6, linhasLidas: 6, rejeitados: 0, erros: [], duplicadosNoArquivo: 0, jaExistentes: 0, conflitos: 0, divergencias: [], totalDivergencias: 0, amostra: [],
    controles: { porCanal: { BALCAO: 5000, ANOTA_AI: 2500, IFOOD: 8600, NOVENTA_E_NOVE_FOOD: 4500, NAO_IDENTIFICADO: 700 }, pedidosPorCanal: { BALCAO: 2, ANOTA_AI: 1, IFOOD: 1, NOVENTA_E_NOVE_FOOD: 1, NAO_IDENTIFICADO: 1 }, pedidosCancelados: 1, canceladosCentavos: 9900 } };
  const html = conf.detalheDocumento({ documento: doc, previa, limitacoes: ["Limitação."], acoes: { confirmar: true, exigeAceiteDePendencias: false, gerarPropostas: false }, propostasGeradas: {}, historico: [], registrosPorTipo: [], impressaoPrevia: "x",
    conflitosDeGranularidade: [{ importacaoId: "o", tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", relatorio: "Formas de pagamento", periodoInicio: "2026-11-01", periodoFim: "2026-11-15", propostasAplicadas: 3 }] }, { permissoes: ["financeiro_v2.importar"] });
  assert.match(html, /Prévia por canal/);
  assert.match(html, /Presencial[\s\S]*?Vira faturamento do Presencial[\s\S]*?2 pedido\(s\) · R\$ 50,00/);
  assert.match(html, /Anota Aí[\s\S]*?Vira faturamento do Anota Aí[\s\S]*?1 pedido\(s\) · R\$ 25,00/);
  assert.match(html, /iFood[\s\S]*?Só conferência: NÃO vira receita[\s\S]*?1 pedido\(s\) · R\$ 86,00/);
  assert.match(html, /99Food[\s\S]*?Só conferência: NÃO vira receita[\s\S]*?1 pedido\(s\) · R\$ 45,00/);
  assert.match(html, /Canal não identificado[\s\S]*?Pendência de classificação/);
  assert.match(html, /Cancelados[\s\S]*?1 pedido\(s\) · R\$ 99,00/);
  assert.match(html, /Atenção: conflito com outra importação[\s\S]*Formas de pagamento de 01\/11\/2026 a 15\/11\/2026 já tem 3 proposta\(s\) aplicada\(s\)/);
  assert.match(html, /data-acao="\/api\/fv2\/acoes\/importacao\/confirmar"/, "a confirmação continua no mesmo detalhe da Central");
  // Outros relatórios não ganham o bloco de canais.
  assert.doesNotMatch(conf.detalheDocumento({ documento: doc, previa: { ...previa, controles: { totalCentavos: 1 } }, limitacoes: [], acoes: { confirmar: false }, propostasGeradas: {}, historico: [], registrosPorTipo: [] }, {}), /Prévia por canal/);
});

test("integração nas áreas: SAIPOS › Importações e as abas Resumo | Importações do iFood e da 99Food", () => {
  const dados = { periodoInicio: "2026-11-01", periodoFim: "2026-11-12", canais: {}, cards: {}, importacoes: [], propostas: { abertas: 0 }, soConferencia: {}, divergencias: [] };
  const f = (aba) => ({ aba, inicio: "2026-11-01", fim: "2026-11-12" });
  const abaSaipos = can.saipos(dados, f("importacoes"), { importacoes: saipos(), permissoes: ["financeiro_v2.importar"] });
  assert.match(abaSaipos, /data-importacoes-canal="SAIPOS"/);
  assert.doesNotMatch(abaSaipos, /data-detalhe="importar:saipos"/, "o botão antigo que abria o painel foi substituído pela seção da página");
  assert.match(can.saipos(dados, f("importacoes"), { importacoesErro: "Falhou", permissoes: [] }), /role="alert"[^>]*>Falhou/);
  const plat = (canal, ctx) => can.plataforma({ canal, competencia: "2026-11", situacao: "PRELIMINAR", totais: null, historico: [], pendencias: [], conferenciaSaipos: null, ...(canal === "NOVENTA_E_NOVE_FOOD" ? { dependeDeRelatorioOficial: true } : {}) }, { permissoes: ["financeiro_v2.registrar"], ...ctx });
  for (const [canal, dado] of [["IFOOD", ifood()], ["NOVENTA_E_NOVE_FOOD", noventa()]]) {
    const resumo = plat(canal, { aba: "resumo" });
    assert.match(resumo, /data-aba-canal="resumo" aria-current="page"/);
    assert.match(resumo, /data-aba-canal="importacoes"(?! aria-current)/);
    assert.doesNotMatch(resumo, /data-importacoes-canal/);
    const abaImp = plat(canal, { aba: "importacoes", importacoes: dado });
    assert.match(abaImp, /data-aba-canal="importacoes" aria-current="page"/);
    assert.match(abaImp, new RegExp(`data-importacoes-canal="${canal}"`));
    assert.doesNotMatch(abaImp, /class="resumo"/, "a aba Importações não repete os cards do Resumo");
  }
  assert.match(plat("IFOOD", { aba: "resumo" }), /data-aba-canal="importacoes">Registrar demonstrativo \(aba Importações\)/, "o atalho do iFood leva à aba, não a Configurações");
});

test("arquitetura: as importações do canal só são consultadas na aba Importações; nenhum cálculo de dinheiro; mesmos serviços da Central", () => {
  const app = arquivo("app.js");
  assert.equal((app.match(/importacoes-canal\?/g) ?? []).length, 1, "uma só montagem da consulta");
  const trecho = app.slice(app.indexOf("function consultaDasImportacoes"), app.indexOf("const contextoDasImportacoes"));
  assert.equal((trecho.match(/aba === "importacoes"/g) ?? []).length, 3, "só com a aba Importações aberta, nos três canais");
  assert.match(app, /\/api\/fv2\/previa-demonstrativo-ifood/);
  const fonte = arquivo("telasImportacoesCanais.js");
  assert.ok(!/reduce\(|Centavos\s*[+\-*\/]\s*\w+Centavos/.test(fonte), "a tela calcula dinheiro");
  assert.match(fonte, /\/api\/fv2\/acoes\/importacao\/receber/, "o envio é o da Central");
  assert.match(fonte, /\/api\/fv2\/acoes\/vendas\/demonstrativo-ifood/, "o registro é o oficial existente");
  assert.doesNotMatch(fonte, /importacao\/confirmar/, "a confirmação do arquivo continua no detalhe da Central (um só lugar)");
});

test("payload REAL do backend renderiza as três seções, com os estados certos", async () => {
  const c = ctxBackend();
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const s = imp.importacoesDoCanal(await CONSULTAS["/importacoes-canal"](n, c, { canal: "SAIPOS" }));
  assert.equal((s.match(/formato--ok/g) ?? []).length, 5, "os 4 de vendas + as movimentações de Frente de Caixa");
  assert.match(s, /Movimentações de Frente de Caixa/);
  assert.match(s, /Unidade sintética/);
  const i = imp.importacoesDoCanal(await CONSULTAS["/importacoes-canal"](n, c, { canal: "IFOOD" }));
  assert.equal((i.match(/formato--ok/g) ?? []).length, 2);
  assert.equal((i.match(/formato--off/g) ?? []).length, 2);
  const x = imp.importacoesDoCanal(await CONSULTAS["/importacoes-canal"](n, c, { canal: "NOVENTA_E_NOVE_FOOD" }));
  assert.equal((x.match(/formato--ok/g) ?? []).length, 0);
  assert.match(x, /data-envio-bloqueado/);
  for (const html of [s, i, x]) assert.doesNotMatch(html, /undefined|NaN|\[object/);
  const previa = await CONSULTAS["/previa-demonstrativo-ifood"](n, c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-08", vendas: "1.000,00", comissoes: "120,00", taxaPagamento: "20,00", mensalidade: "10,00", servicosEPromocoes: "50,00", ajustes: "0,00", liquido: "800,00", origem: "Sintético", justificativa: "Teste" });
  const painel = imp.previaDoDemonstrativo(previa, { params: { periodoInicio: "2026-11-01" }, podeRegistrar: true });
  assert.match(painel, /A conta fecha/);
  assert.match(painel, /Confirmar e registrar demonstrativo/);
});
