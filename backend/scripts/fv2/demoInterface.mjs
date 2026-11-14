// AMBIENTE DEMONSTRATIVO LOCAL da interface do Financeiro v2 (Execuções 05, 06A, 06B, 06C e 06D).
//
// 06D: as permissões da demonstração são CONCESSÕES GRAVADAS (fv2_concessao, em memória), lidas a cada requisição pelo
// adaptador de sessão e REVALIDADAS em cada operação do núcleo (exigirConcessaoPersistida). O administrador de cada
// unidade SINTÉTICA é provisionado por uma autoridade SINTÉTICA desta demonstração (chave aleatória do processo, só para a
// organização fictícia) — ela NÃO existe em produção; lá o provisionamento depende de autoridade real (doc 14).
//
// - Dados 100% SINTÉTICOS em memória (nenhum banco, nenhum .env, nenhuma rede além de 127.0.0.1).
// - Sessão SIMULADA pelo seletor do próprio ambiente (cabeçalho x-fv2-demo-sessao), mas passando pelo adaptador de sessão
//   e pelas concessões financeiro_v2.* reais do módulo: organização vem da sessão, unidade é validada, ação VER exigida.
// - Consome SOMENTE as consultas aprovadas do motor (apuração, composição e, desde a 06A, tesouraria: contas a pagar/receber,
//   caixa e bancos, calendário, fluxo de caixa e resumo financeiro). SOMENTE LEITURA: as escritas da tesouraria (saldo
//   informado, abertura/operação/fechamento de caixa) existem no núcleo, mas NÃO são expostas aqui — a sessão desta
//   demonstração é simulada, então uma escrita "funcionando" seria sucesso simulado (ver doc 11). Desde a 06B, também
//   as consultas de Vendas e Recebimentos (vendas, pagamentos, taxas, recebíveis, divergências e detalhes) — só leitura.
// - Respostas saem SANITIZADAS: identificadores internos viram referências opacas; documentos aparecem como
//   "registrado, não acessível nesta versão" (não há link nem caminho de arquivo).
// NÃO é rota do aplicativo: não é montado em backend/src e não deve ser publicado.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(join(aqui, "..", "..", "src", "modules", "financeiro-v2", "index.js")));
const { faturamentoSaiposPdf } = await import(pathToFileURL(join(aqui, "..", "..", "test", "financeiro-v2", "helpers", "formatos.js")));
const { foodyEntregas, saiposFormas, saiposVendas, texto, unicredExtrato } = await import(pathToFileURL(join(aqui, "..", "..", "test", "financeiro-v2", "helpers", "arquivos.js")));
/** Stone no layout homologado (texto, 6 casas, desconto no "unificado"), em CSV SINTÉTICO. */
const stoneCsv = (linhas) => texto(["STONE ID;DATA DA VENDA;PRODUTO;BANDEIRA;VALOR BRUTO;VALOR LIQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPACAO;DESCONTO UNIFICADO;ULTIMO STATUS;CÓDIGO DE AUTORIZAÇÃO",
  ...linhas.map((l) => [l.id, l.quando, l.produto ?? "Credito", "Bandeira Demo", l.bruto, l.liquido, "0,000000", "0,000000", l.unificado ?? "0,000000", "Aprovada", l.aut ?? ""].join(";"))].join("\n"));

export const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
export const UNIDADES = Object.freeze([
  { id: "aaaaaaaa-0000-4000-8000-0000000000a1", nome: "Unidade Demonstração (Saci)" },
  { id: "aaaaaaaa-0000-4000-8000-0000000000a2", nome: "Unidade Demonstração 2" },
]);
export const USUARIOS = { gestor: "dddddddd-0000-4000-8000-000000000001", leitor: "dddddddd-0000-4000-8000-000000000002", operador: "dddddddd-0000-4000-8000-000000000003", administrador: "dddddddd-0000-4000-8000-000000000004" };
/** Nomes de EXIBIÇÃO dos usuários sintéticos (nunca pessoas reais). */
export const NOMES_DEMO = Object.freeze({ [USUARIOS.gestor]: "Gestor (demonstração)", [USUARIOS.leitor]: "Sem acesso (demonstração)", [USUARIOS.operador]: "Operador (demonstração)", [USUARIOS.administrador]: "Administrador (demonstração)", "cccccccc-0000-4000-8000-000000000001": "Carga inicial da demonstração", "eeeeeeee-0000-4000-8000-0000000000e1": "Autoridade sintética da demonstração" });
const AUTORIDADE_DEMO = "eeeeeeee-0000-4000-8000-0000000000e1";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Monta o núcleo e o cenário sintético (setembro com pendências, agosto homologado, unidade 2 com zero confirmado). */
/**
 * @param {object} [o]
 * @param {object} [o.repositorio] 08B: persistência injetada (PostgreSQL da homologação); padrão: memória (demonstração)
 * @param {object} [o.cofre] 08B: cofre injetado (disco da homologação); padrão: memória
 * @param {boolean} [o.carregar] 08B: false = NÃO carrega o cenário (os dados já estão no banco da homologação)
 * @param {(chave:string) => object|null} [o.sessaoDoPedido] 08B: sessão AUTENTICADA (gateway) no lugar do perfil de demonstração
 */
export async function criarDemo({ relogio = () => new Date("2026-11-12T15:00:00Z"), repositorio: repositorioExterno = null, cofre: cofreExterno = null, carregar = true, sessaoDoPedido = null } = {}) {
  const escopos = UNIDADES.map((u) => ({ organizacaoId: ORG, unidadeId: u.id }));
  const sal = randomUUID();
  const repositorio = repositorioExterno ?? m.criarRepositorioMemoria();
  const cofre = cofreExterno ?? m.criarCofreMemoria();
  // Núcleo de CARGA do cenário sintético (sem exigir concessão gravada); depois, o núcleo que ATENDE a demonstração exige.
  let nucleo = m.criarNucleoFinanceiro({ repositorio, escoposAutorizados: escopos, relogio, cofre });
  const tudo = Object.values(m.ACAO);
  const c = (u = UNIDADES[0].id) => ({ organizacaoId: ORG, unidadeId: u, usuarioId: "cccccccc-0000-4000-8000-000000000001", permissoes: tudo });
  if (carregar) {
  for (const u of UNIDADES) await nucleo.implantarPlanoDeContas(c(u.id), { modelo: "ACAITERIA" });
  const A = c();
  const caixa = await nucleo.configurarContaFinanceira(A, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const banco = await nucleo.configurarContaFinanceira(A, { tipo: "BANCARIA", nome: "Unicred (demonstração)", instituicao: "Conta sintética" });
  let n = 0;
  const venda = (canal, data, bruto, extra = {}) => nucleo.registrarVenda(A, { canal, dataVenda: data, brutoCentavos: bruto, fonte: { sistema: "MANUAL", idExterno: `DEMO-${(n += 1)}` }, composicao: { itensCentavos: bruto }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: bruto, contaId: caixa.id }], ...extra });
  // Agosto: competência homologada, sem pendências → CONFIRMADO.
  await venda("BALCAO", "2026-08-10", 380000);
  await nucleo.registrarObrigacao(A, { contraparteId: (await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Fornecedor Demonstração" })).id, valorOriginalCentavos: 120000, categoria: "INSUMOS", descricao: "Insumos (demonstração)", competencia: "2026-08", dataEmissao: "2026-08-05", vencimento: "2026-08-20" });
  await nucleo.alterarEstadoDaCompetencia(A, { competencia: "2026-08", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(A, { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Homologação da demonstração." });
  // Setembro: canais, taxas, descontos (inclusive a classificar), agregado sem canal, motoboys, saída sem classificação.
  await venda("BALCAO", "2026-09-05", 412350);
  await nucleo.registrarVenda(A, { canal: "BALCAO", dataVenda: "2026-09-06", brutoCentavos: 250000, fonte: { sistema: "MANUAL", idExterno: "DEMO-C1" }, composicao: { itensCentavos: 240000, acrescimosCentavos: 10000, descontos: [{ valorCentavos: 12500, financiador: "LOJA" }] }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 237500 }] })
    .then((r) => nucleo.registrarAjuste(A, { alvoTipo: "RECEBIVEL", alvoId: r.recebiveis[0].id, valorCentavos: -5937, motivo: "Taxa Stone (demonstração)", categoria: "TAXAS_STONE" }));
  const ifood = await nucleo.registrarVenda(A, { canal: "IFOOD", dataVenda: "2026-09-07", brutoCentavos: 528000, fonte: { sistema: "MANUAL", idExterno: "DEMO-I1" }, composicao: { itensCentavos: 528000, descontos: [{ valorCentavos: 21000, financiador: "LOJA" }, { valorCentavos: 9000, financiador: "PENDENTE" }] }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 498000 }] });
  for (const [cat, v] of [["COMISSOES_IFOOD", 63360], ["TAXAS_DE_PROCESSAMENTO", 16700], ["ANUNCIOS_IFOOD", 15000], ["MENSALIDADE_IFOOD", 12900]]) await nucleo.registrarAjuste(A, { alvoTipo: "RECEBIVEL", alvoId: ifood.recebiveis[0].id, valorCentavos: -v, motivo: `${cat} (demonstração)`, categoria: cat });
  await nucleo.registrarVenda(A, { canal: "ANOTA_AI", dataVenda: "2026-09-08", brutoCentavos: 98000, fonte: { sistema: "MANUAL", idExterno: "DEMO-A1" }, composicao: { itensCentavos: 98000 }, pagamentos: [{ forma: "OUTRA", processador: "ANOTA_AI", valorCentavos: 98000 }] });
  const importar = async (fonte, tipoRelatorio, conteudo, periodo) => {
    const r = await nucleo.receberArquivoParaImportacao(A, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
    return (await nucleo.confirmarImportacao(A, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Demonstração." } : {}) })).importacao;
  };
  const agr = await importar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "02/09/2026", valor: 185000, desconto: 7400 }]), { periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  await nucleo.gerarPropostas(A, { importacaoId: agr.id });
  for (const p of await nucleo.listarPropostas(A, { operacao: "VENDA_AGREGADA" })) { await nucleo.aprovarProposta(A, { propostaId: p.id }); await nucleo.aplicarProposta(A, { propostaId: p.id }); }
  const foody = await importar("FOODY", "FOODY_ENTREGAS", foodyEntregas([
    { pedido: "DEMO-F1", data: "03/09/2026", entregador: "Entregador Demonstração A", taxa: 700, custo: 650 },
    { pedido: "DEMO-F2", data: "04/09/2026", entregador: "Entregador Demonstração A", taxa: 900, custo: 800 },
    { pedido: "DEMO-F3", data: "04/09/2026", entregador: "Entregador Demonstração A", taxa: 700, custo: 650, situacao: "Taxa rejeitada" },
    { pedido: "DEMO-F4", data: "05/09/2026", entregador: "Entregador Demonstração B", taxa: 700, custo: 700 },
  ], { subtotais: { "Entregador Demonstração A": 1450, "Entregador Demonstração B": 700 }, total: 2150 }), { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  await nucleo.gerarPropostas(A, { importacaoId: foody.id });
  for (const p of await nucleo.listarPropostas(A, { operacao: "OBRIGACAO_ENTREGADOR" })) {
    await nucleo.aprovarProposta(A, { propostaId: p.id });
    const r = await nucleo.aplicarProposta(A, { propostaId: p.id });
    if (p.entregador.endsWith("A")) {
      const pix = await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-10-05", sentido: "SAIDA", valorCentavos: 1000, natureza: "PAGAMENTO" });
      await nucleo.registrarLiquidacao(A, { movimentacaoId: pix.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: r.efeitos.find((e) => e.tipo === "OBRIGACAO").id, valorCentavos: 1000 }] });
    }
  }
  const forn = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Fornecedor de Insumos (demonstração)" });
  await nucleo.registrarObrigacao(A, { contraparteId: forn.id, valorOriginalCentavos: 431900, categoria: "FRUTAS", descricao: "Frutas (demonstração)", competencia: "2026-09", dataEmissao: "2026-09-03", vencimento: "2026-09-18" });
  await nucleo.registrarObrigacao(A, { contraparteId: forn.id, valorOriginalCentavos: 118000, categoria: "EMBALAGENS", descricao: "Embalagens (demonstração)", competencia: "2026-09", dataEmissao: "2026-09-04", vencimento: "2026-09-19" });
  await nucleo.registrarObrigacao(A, { contraparteId: forn.id, valorOriginalCentavos: 3200, categoria: "JUROS_E_TARIFAS_BANCARIAS", descricao: "Tarifa bancária (demonstração)", competencia: "2026-09", dataEmissao: "2026-09-10", vencimento: "2026-09-10" });
  await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-09-21", sentido: "SAIDA", valorCentavos: 15000, natureza: "PAGAMENTO" });
  await vendasERecebimentos(nucleo, A, { banco, importar });
  await tesouraria(nucleo, A, { caixa, banco, ifoodRecebivel: ifood.recebiveis[0] });
  // Unidade 2: só uma despesa e competência homologada → faturamento ZERO CONFIRMADO.
  const B = c(UNIDADES[1].id);
  const f2 = await nucleo.registrarContraparte(B, { tipo: "FORNECEDOR", nome: "Fornecedor (demonstração 2)" });
  await nucleo.registrarObrigacao(B, { contraparteId: f2.id, valorOriginalCentavos: 50000, categoria: "INSUMOS", descricao: "Insumos (demonstração 2)", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-20" });
  await nucleo.alterarEstadoDaCompetencia(B, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(B, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Homologação da demonstração." });

  await conciliacoesDemo(nucleo, A, { banco });
  // Fechamento de setembro com pendências DOCUMENTADAS (Execução 06C): a Central mostra o que impede a homologação.
  await nucleo.alterarEstadoDaCompetencia(A, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(A, { competencia: "2026-09", novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Extrato bancário de setembro não importado", impacto: "Pode alterar o resultado da competência (sintético)." }, { descricao: "Diferença entre faturamento diário e formas de pagamento de 02/09 sem causa comprovada", impacto: "Pode alterar o resultado da competência (sintético)." }], justificativa: "Fechamento da demonstração com pendências documentadas." });

  await documentosDemo(nucleo, A, cofre);

  // ---- 06D: permissões GRAVADAS. Autoridade sintética atesta o administrador de cada unidade; ele concede o resto.
  const chaveAutoridade = randomBytes(32);
  const atestar = (ato) => createHmac("sha256", chaveAutoridade).update(JSON.stringify([ato.organizacaoId, ato.unidadeId, ato.usuarioId, [...ato.acoes].sort()])).digest("hex");
  const autoridade = { verificar: async (ato) => ({ ok: ato.organizacaoId === ORG && ato.atestado === atestar(ato), autoridadeId: AUTORIDADE_DEMO, nivelAutenticacao: "aal2" }) };
  nucleo = m.criarNucleoFinanceiro({ repositorio, escoposAutorizados: escopos, relogio, cofre, exigirConcessaoPersistida: true, autoridadeDeProvisionamento: autoridade });
  const tudoMenosNada = Object.values(m.ACAO);
  for (const u of UNIDADES) {
    const ato = { organizacaoId: ORG, unidadeId: u.id, usuarioId: USUARIOS.administrador, acoes: tudoMenosNada, justificativa: "Administrador financeiro da unidade de demonstração.", evidencia: "Ato sintético da demonstração local" };
    await nucleo.provisionarAdministradorInicial({ ...ato, atestado: atestar(ato) });
  }
  const adm = (u) => ({ organizacaoId: ORG, unidadeId: u, usuarioId: USUARIOS.administrador, permissoes: tudoMenosNada });
  for (const u of UNIDADES) await nucleo.concederAcesso(adm(u.id), { usuarioId: USUARIOS.gestor, acoes: [m.ACAO.VER], justificativa: "Leitura gerencial." });
  // Operador da DEMONSTRAÇÃO: importa arquivos SINTÉTICOS do catálogo, revisa propostas e concilia — só na unidade 1.
  await nucleo.concederAcesso(adm(UNIDADES[0].id), { usuarioId: USUARIOS.operador, acoes: [m.ACAO.VER, m.ACAO.IMPORTAR, m.ACAO.CONFIRMAR_IMPORTACAO, m.ACAO.REGISTRAR, m.ACAO.REVISAR, m.ACAO.CONCILIAR], justificativa: "Operação da conferência." });
  await nucleo.concederAcesso(adm(UNIDADES[1].id), { usuarioId: USUARIOS.operador, acoes: [m.ACAO.VER], justificativa: "Consulta." });
  }
  // 08B: sem carga, o núcleo que ATENDE já nasce exigindo a concessão gravada (os dados vêm do banco da homologação).
  if (!carregar) nucleo = m.criarNucleoFinanceiro({ repositorio, escoposAutorizados: escopos, relogio, cofre, exigirConcessaoPersistida: true });
  const concessoes = m.criarConcessoesDoRepositorio({ repositorio, escopos });
  const sessoes = m.criarAdaptadorDeSessao({ concessoes, relogio });
  const PERFIS = { gestor: USUARIOS.gestor, operador: USUARIOS.operador, administrador: USUARIOS.administrador, "sem-acesso": USUARIOS.leitor, expirada: USUARIOS.gestor };
  const sessaoDemo = (perfil) => (!PERFIS[perfil] ? null : {
    user: { id: PERFIS[perfil], ativo: true },
    tenant: { organizacaoId: ORG, unidadeId: null },
    acesso: { sessionId: `demo-${perfil}`, expiraEm: perfil === "expirada" ? "2026-11-12T14:00:00.000Z" : "2099-01-01T00:00:00.000Z", impersonando: false },
  });
  /** 08B: na homologação, a sessão vem do login AUTENTICADO no gateway (chave da sessão do servidor), nunca do cliente. */
  const sessaoDe = (chave) => (sessaoDoPedido ? sessaoDoPedido(chave) : sessaoDemo(chave));
  /** Usuário sintético escolhido na tela (pelo nome do perfil) → id. Nunca um id livre vindo do cliente. */
  const usuarioDoPerfil = (perfil) => {
    const id = { gestor: USUARIOS.gestor, operador: USUARIOS.operador, administrador: USUARIOS.administrador, "sem-acesso": USUARIOS.leitor }[perfil];
    if (!id) throw Object.assign(new Error("Pessoa fora da demonstração."), { codigo: m.CODIGO.ENTRADA_INVALIDA });
    return id;
  };
  const ref = (id) => `ref-${createHash("sha256").update(sal + id).digest("hex").slice(0, 10)}`;
  const CODIGOS = new Set(["FATURAMENTO_BRUTO_PROPRIO", "FATURAMENTO_LIQUIDO_GERENCIAL", "DEDUCOES_COMERCIAIS", "RECEITA_LIQUIDA_COMERCIAL", "CUSTOS_OPERACIONAIS", "RESULTADO_APOS_CUSTOS", "DESPESAS_OPERACIONAIS", "RESULTADO_FINANCEIRO", "DEMAIS_EFEITOS_GERENCIAIS", "RESULTADO_GERENCIAL"]);
  const reverso = new Map();
  const refDe = (id) => { const r = ref(id); reverso.set(r, id); return r; };
  /**
   * Identificadores internos → referências opacas (só as já EMITIDAS voltam a ser ids nos detalhes: não dá para adivinhar
   * uma referência); documentos → registrados, não acessíveis nesta versão.
   */
  const sanitizarComRef = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
    if (k === "documentoIds" && Array.isArray(x)) return x.map((id) => ({ referencia: refDe(id), situacao: "REGISTRADO_NAO_ACESSIVEL" }));
    if (typeof x === "string" && NOMES_DEMO[x]) return NOMES_DEMO[x];
    return typeof x === "string" ? x.replace(UUID, (u) => refDe(u)) : x;
  }));
  /** Parâmetros de texto da URL → filtro do núcleo: vazios saem; referências opacas voltam a ser ids; números viram inteiros. */
  const filtro = (params, campos, numeros = []) => Object.fromEntries(campos.filter((k) => params[k] !== undefined && params[k] !== "").map((k) => {
    const v = params[k];
    if (numeros.includes(k)) return [k, /^\d{1,6}$/.test(v) ? Number(v) : v];
    return [k, v.startsWith("ref-") ? reverso.get(v) ?? v : v];
  }));
  const NENHUM = "00000000-0000-4000-8000-000000000000";
  const FILTRO_VENDAS = ["competencia", "inicio", "fim", "canal", "forma", "processador", "situacao", "valorMinimoCentavos", "valorMaximoCentavos", "identificador", "pagina", "tamanho"];
  const NUMEROS_VENDAS = ["pagina", "tamanho", "valorMinimoCentavos", "valorMaximoCentavos"];
  const TESOURARIA = {
    "/api/fv2/contas-a-pagar": async (ctx, p) => {
      const r = await nucleo.consultarContasAPagar(ctx, filtro(p, ["competencia", "vencimentoDe", "vencimentoAte", "contraparteId", "categoria", "situacao", "pagina", "tamanho"], ["pagina", "tamanho"]));
      // 08D: opções do formulário "Registrar conta a pagar": categorias lançáveis que não são receita (inclui "a classificar") e fornecedores.
      const cats = (await nucleo.consultarRegistros(ctx, { tipo: "CATEGORIA" })).filter((c) => c.aceitaLancamento && c.ativa !== false && c.natureza !== "RECEITA").map((c) => ({ codigo: c.codigo, nome: c.nome })).sort((a, b2) => a.nome.localeCompare(b2.nome, "pt-BR"));
      const fornecedores = (await nucleo.consultarRegistros(ctx, { tipo: "CONTRAPARTE" })).map((c) => ({ id: c.id, nome: c.nome })).sort((a, b2) => a.nome.localeCompare(b2.nome, "pt-BR"));
      return { ...r, opcoesDeRegistro: { categorias: cats, fornecedores } };
    },
    "/api/fv2/contas-a-receber": (ctx, p) => nucleo.consultarContasAReceber(ctx, filtro(p, ["competencia", "previstoDe", "previstoAte", "processador", "canal", "tipo", "situacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/caixa-e-bancos": (ctx, p) => nucleo.consultarCaixaEBancos(ctx, filtro(p, ["inicio", "fim", "contaId", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/fluxo-de-caixa": (ctx, p) => nucleo.consultarFluxoDeCaixa(ctx, filtro(p, ["inicio", "fim", "granularidade"])),
    "/api/fv2/calendario": (ctx, p) => nucleo.consultarCalendarioFinanceiro(ctx, filtro(p, ["mes"])),
    // 08D: o detalhe leva as contas ativas (para o formulário de pagamento) — só nome e referência opaca.
    "/api/fv2/conta-a-pagar": async (ctx, p) => ({ ...(await nucleo.detalharContaAPagar(ctx, { id: reverso.get(p.id) ?? NENHUM })), contasParaPagar: (await nucleo.consultarRegistros(ctx, { tipo: "CONTA" })).filter((c) => c.ativa).map((c) => ({ id: c.id, nome: c.nome })) }),
    "/api/fv2/conta-a-receber": (ctx, p) => nucleo.detalharContaAReceber(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    // Vendas e Recebimentos (06B) — somente leitura.
    "/api/fv2/vendas": (ctx, p) => nucleo.consultarVendas(ctx, filtro(p, FILTRO_VENDAS, NUMEROS_VENDAS)),
    "/api/fv2/vendas/pagamentos": (ctx, p) => nucleo.consultarPagamentosDeVendas(ctx, filtro(p, FILTRO_VENDAS, NUMEROS_VENDAS)),
    "/api/fv2/vendas/taxas": (ctx, p) => nucleo.consultarTaxasEDescontos(ctx, filtro(p, [...FILTRO_VENDAS, "tipoComponente"], NUMEROS_VENDAS)),
    "/api/fv2/vendas/recebiveis": (ctx, p) => nucleo.consultarRecebiveisERepasses(ctx, filtro(p, [...FILTRO_VENDAS, "recebimento"], NUMEROS_VENDAS)),
    "/api/fv2/vendas/divergencias": (ctx, p) => nucleo.consultarDivergenciasDeVendas(ctx, filtro(p, [...FILTRO_VENDAS, "codigo"], NUMEROS_VENDAS)),
    "/api/fv2/venda": (ctx, p) => nucleo.detalharVenda(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    "/api/fv2/recebimento": (ctx, p) => nucleo.detalharRecebimento(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    // Central de Conferências (06C) — somente leitura.
    "/api/fv2/conferencias": (ctx, p) => nucleo.consultarCentralDeConferencias(ctx, filtro(p, ["competencia"])),
    "/api/fv2/conferencias/documentos": (ctx, p) => nucleo.consultarDocumentosImportados(ctx, filtro(p, ["competencia", "fonte", "estado", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/conferencias/documento": (ctx, p) => nucleo.detalharImportacao(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    "/api/fv2/conferencias/propostas": (ctx, p) => nucleo.consultarPropostasParaRevisao(ctx, filtro(p, ["competencia", "estado", "operacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/conferencias/proposta": (ctx, p) => nucleo.detalharProposta(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    "/api/fv2/conferencias/correspondencias": (ctx, p) => nucleo.consultarCorrespondencias(ctx, filtro(p, ["competencia", "situacao", "relacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/conferencias/correspondencia": (ctx, p) => nucleo.detalharCorrespondencia(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    "/api/fv2/conferencias/pendencias": (ctx, p) => nucleo.consultarPendencias(ctx, filtro(p, ["competencia", "grupo", "situacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    // A chave da pendência carrega referências opacas: cada uma volta a ser o id (só as já emitidas).
    "/api/fv2/conferencias/pendencia": (ctx, p) => nucleo.detalharPendencia(ctx, { competencia: p.competencia, chave: String(p.chave ?? "").split(":").map((x) => (x.startsWith("ref-") ? reverso.get(x) ?? NENHUM : x)).join(":") }),
    "/api/fv2/conferencias/fechamento": async (ctx, p) => {
      const f = await nucleo.consultarFechamento(ctx, filtro(p, ["competencia"]));
      // 06D: prévias das mudanças possíveis a partir do estado atual (as MESMAS regras do núcleo, sem gravar) e versões.
      const destinos = { ABERTA: ["FECHAMENTO_PRELIMINAR"], FECHAMENTO_PRELIMINAR: ["FECHAMENTO_COM_PENDENCIAS", "FECHAMENTO_HOMOLOGADO", "ABERTA"], FECHAMENTO_COM_PENDENCIAS: ["FECHAMENTO_HOMOLOGADO", "FECHAMENTO_PRELIMINAR", "ABERTA"], FECHAMENTO_HOMOLOGADO: ["ABERTA"] }[f.estado] ?? [];
      const acoes = [];
      for (const novoEstado of destinos) acoes.push(await nucleo.previaDaMudancaDeEstado(ctx, { competencia: f.competencia, novoEstado }));
      const versoes = await nucleo.consultarVersoesDeFechamento(ctx, { competencia: f.competencia });
      return { ...f, acoes, versoes: versoes.versoes };
    },
    // 06D — configurações, permissões, documentos, pessoas com acesso (para escolher responsável).
    // 08C — reclassificação: consulta + prévia (nada é gravado). Lançamento OU movimentação, sempre por referência opaca.
    "/api/fv2/reclassificacao": (ctx, p) => nucleo.consultarReclassificacao(ctx, p.movimentacao
      ? { movimentacaoId: reverso.get(p.movimentacao) ?? NENHUM }
      : { lancamentoId: reverso.get(p.id) ?? NENHUM, ...(p.categoria ? { categoria: String(p.categoria) } : {}) }),
    "/api/fv2/configuracoes": (ctx) => nucleo.consultarConfiguracoes(ctx),
    "/api/fv2/configuracoes/plano": (ctx) => nucleo.consultarPlanoDeContas(ctx),
    "/api/fv2/configuracoes/categoria": (ctx, p) => nucleo.consultarCategoria(ctx, { codigo: String(p.codigo ?? "") }),
    "/api/fv2/permissoes": (ctx) => nucleo.consultarPermissoes(ctx),
    "/api/fv2/documentos": (ctx, p) => nucleo.consultarDocumentos(ctx, filtro(p, ["competencia", "situacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/documento": (ctx, p) => nucleo.detalharDocumento(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    "/api/fv2/pessoas": async (ctx) => {
      // Pessoas SINTÉTICAS com acesso ativo nesta unidade (a lista vem das concessões gravadas, não do cliente).
      const saida = [];
      for (const [perfil, id] of Object.entries({ gestor: USUARIOS.gestor, operador: USUARIOS.operador, administrador: USUARIOS.administrador })) {
        const lista = await concessoes.listar({ organizacaoId: ORG, usuarioId: id });
        if (lista.some((x) => x.unidadeId === ctx.unidadeId)) saida.push({ perfil, nome: NOMES_DEMO[id] });
      }
      return { pessoas: saida };
    },
  };
  const CATALOGO = catalogoSintetico();
  // CSRF: token por perfil, derivado de um segredo aleatório deste processo (as ações exigem o cabeçalho x-fv2-csrf).
  const segredo = randomBytes(32);
  const tokenDe = (perfil) => createHmac("sha256", segredo).update(`csrf|${perfil}`).digest("hex").slice(0, 40);
  const tokenConfere = (perfil, token) => {
    const esperado = Buffer.from(tokenDe(perfil));
    const recebido = Buffer.from(String(token ?? ""));
    return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
  };
  const id = (v) => (typeof v === "string" && v.startsWith("ref-") ? reverso.get(v) ?? NENHUM : NENHUM);
  /** 08D: "1.234,56" → 123456 (estrito; nada de ponto flutuante). Inválido → o núcleo recusa (valor não inteiro). */
  const centavos = (v) => { const t = String(v ?? "").trim().replace(/\./g, ""); const m = /^(\d{1,9})(?:,(\d{1,2}))?$/.exec(t); return m ? Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0")) : t; };
  /** Ações LOCAIS da demonstração: cada uma chama a operação REAL do núcleo (permissão, transação, idempotência, histórico). */
  const ACOES = {
    "/api/fv2/acoes/importacao/receber": { campos: ["arquivo"], fazer: (ctx, b) => {
      const arq = CATALOGO.find((x) => x.id === b.arquivo);
      if (!arq) throw Object.assign(new Error("Arquivo fora do catálogo sintético da demonstração."), { codigo: m.CODIGO.ENTRADA_INVALIDA });
      return nucleo.receberArquivoParaImportacao(ctx, { fonte: arq.fonte, tipoRelatorio: arq.tipoRelatorio, tipoMime: "application/octet-stream", conteudo: arq.conteudo(), periodoInicio: arq.periodoInicio, periodoFim: arq.periodoFim, descricao: arq.nome });
    } },
    "/api/fv2/acoes/importacao/confirmar": { campos: ["importacao", "impressaoPrevia", "aceitarPendencias", "justificativa"], fazer: (ctx, b) => nucleo.confirmarImportacao(ctx, { importacaoId: id(b.importacao), impressaoPrevia: b.impressaoPrevia, ...(b.aceitarPendencias === true ? { aceitarPendencias: true } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
    "/api/fv2/acoes/importacao/rejeitar": { campos: ["importacao", "justificativa"], fazer: (ctx, b) => nucleo.rejeitarImportacao(ctx, { importacaoId: id(b.importacao), justificativa: b.justificativa }) },
    "/api/fv2/acoes/propostas/gerar": { campos: ["importacao"], fazer: (ctx, b) => nucleo.gerarPropostas(ctx, { importacaoId: id(b.importacao) }) },
    "/api/fv2/acoes/propostas/aprovar": { campos: ["proposta", "justificativa"], fazer: (ctx, b) => nucleo.aprovarProposta(ctx, { propostaId: id(b.proposta), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
    "/api/fv2/acoes/propostas/rejeitar": { campos: ["proposta", "justificativa"], fazer: (ctx, b) => nucleo.rejeitarProposta(ctx, { propostaId: id(b.proposta), justificativa: b.justificativa }) },
    "/api/fv2/acoes/propostas/aplicar": { campos: ["proposta"], fazer: (ctx, b) => nucleo.aplicarProposta(ctx, { propostaId: id(b.proposta) }) },
    // 08D — evidência enviada pela tela: base64 estrito, decodificado aqui; o núcleo valida formato, nome e escopo.
    "/api/fv2/acoes/documentos/enviar": { campos: ["arquivoBase64", "nomeArquivo", "tipoMime", "tipo", "descricao", "registroTipo", "registro", "competencia"], fazer: (ctx, b) => {
      const b64 = String(b.arquivoBase64 ?? "");
      if (!b64 || b64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw Object.assign(new Error("Arquivo ausente ou codificação inválida."), { codigo: m.CODIGO.DOCUMENTO_INVALIDO });
      return nucleo.enviarEvidencia(ctx, {
        arquivo: { conteudo: new Uint8Array(Buffer.from(b64, "base64")), nome: String(b.nomeArquivo ?? "").slice(0, 300), tipoMime: String(b.tipoMime ?? "").slice(0, 80) },
        tipo: b.tipo, descricao: b.descricao, ...(b.competencia ? { competencia: b.competencia } : {}),
        vinculo: { registroTipo: b.registroTipo, registroId: id(b.registro) },
      });
    } },
    // 08D — operações do dia a dia pela tela (jornada completa): registrar conta, pagar conta, informar saldo.
    "/api/fv2/acoes/obrigacoes/registrar": { campos: ["fornecedor", "fornecedorNovo", "descricao", "valor", "categoria", "competencia", "dataEmissao", "vencimento"], fazer: async (ctx, b) => {
      const contraparteId = b.fornecedor ? id(b.fornecedor) : (await nucleo.registrarContraparte(ctx, { tipo: "FORNECEDOR", nome: String(b.fornecedorNovo ?? "").slice(0, 120) })).id;
      return nucleo.registrarObrigacao(ctx, { contraparteId, valorOriginalCentavos: centavos(b.valor), categoria: b.categoria, descricao: b.descricao, competencia: b.competencia, dataEmissao: b.dataEmissao, vencimento: b.vencimento });
    } },
    "/api/fv2/acoes/obrigacoes/pagar": { campos: ["obrigacao", "conta", "dataEfetiva", "valor"], fazer: (ctx, b) => nucleo.pagarContaAPagar(ctx, { obrigacaoId: id(b.obrigacao), contaId: id(b.conta), dataEfetiva: b.dataEfetiva, valorCentavos: centavos(b.valor) }) },
    "/api/fv2/acoes/saldos/registrar": { campos: ["conta", "data", "referencia", "valor", "observacao"], fazer: (ctx, b) => nucleo.registrarSaldoDeConta(ctx, { contaId: id(b.conta), data: b.data, referencia: b.referencia, valorCentavos: centavos(b.valor), ...(b.observacao ? { observacao: b.observacao } : {}) }) },
    "/api/fv2/acoes/reclassificar": { campos: ["lancamento", "categoria", "justificativa", "versaoEsperada", "documento"], fazer: (ctx, b) => nucleo.reclassificarLancamento(ctx, {
      lancamentoId: id(b.lancamento), categoria: b.categoria, justificativa: b.justificativa,
      versaoEsperada: /^\d{1,9}$/.test(String(b.versaoEsperada ?? "")) ? Number(b.versaoEsperada) : b.versaoEsperada, ...(b.documento ? { documentoId: id(b.documento) } : {}),
    }) },
    "/api/fv2/acoes/conciliacoes/confirmar": { campos: ["correspondencia", "justificativa"], fazer: (ctx, b) => nucleo.confirmarConciliacao(ctx, { correspondenciaId: id(b.correspondencia), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
    // ---- 06D: fechamento mensal. Pendências documentadas são montadas a partir da Central (núcleo), não do cliente.
    "/api/fv2/acoes/fechamento/alterar": { campos: ["competencia", "novoEstado", "metodologia", "justificativa", "decisao", "documentacaoFaltante"], fazer: async (ctx, b) => {
      const pendencias = [];
      if (b.novoEstado === "FECHAMENTO_COM_PENDENCIAS") {
        const lista = await nucleo.consultarPendencias(ctx, { competencia: b.competencia, situacao: "A_RESOLVER", tamanho: 100 });
        for (const x of lista.itens) {
          pendencias.push({
            chave: x.chave.slice(0, 200), descricao: String(x.titulo ?? x.motivo ?? "Pendência").slice(0, 500),
            impacto: x.efeitoNoFechamento === "BLOQUEIA" ? "Bloqueia a homologação até ser resolvida." : x.efeitoNoFechamento === "NAO_BLOQUEIA" ? "Não altera o resultado; acompanhamento." : "Pode alterar o resultado: precisa estar documentada.",
            ...(x.atribuicao?.responsavelId ? { responsavelId: x.atribuicao.responsavelId } : {}),
            ...(b.documentacaoFaltante ? { documentacaoFaltante: String(b.documentacaoFaltante).slice(0, 500) } : {}), ...(b.decisao ? { decisao: String(b.decisao).slice(0, 500) } : {}),
          });
        }
      }
      return nucleo.alterarEstadoDaCompetencia(ctx, {
        competencia: b.competencia, novoEstado: b.novoEstado, confirmar: true,
        ...(b.metodologia ? { metodologia: b.metodologia } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}), ...(pendencias.length ? { pendencias } : {}),
      });
    } },
    "/api/fv2/acoes/pendencias/atribuir": { campos: ["competencia", "chave", "responsavel", "dataRevisao", "comentario", "justificativa"], fazer: (ctx, b) => nucleo.atribuirResponsavelDePendencia(ctx, {
      competencia: b.competencia, chave: String(b.chave ?? "").split(":").map((x) => (x.startsWith("ref-") ? reverso.get(x) ?? NENHUM : x)).join(":"), responsavelId: usuarioDoPerfil(b.responsavel),
      ...(b.dataRevisao ? { dataRevisao: b.dataRevisao } : {}), ...(b.comentario ? { comentario: b.comentario } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}),
    }) },
    "/api/fv2/acoes/pendencias/acompanhar": { campos: ["competencia", "chave", "situacao", "comentario"], fazer: (ctx, b) => nucleo.atualizarAcompanhamentoDePendencia(ctx, {
      competencia: b.competencia, chave: String(b.chave ?? "").split(":").map((x) => (x.startsWith("ref-") ? reverso.get(x) ?? NENHUM : x)).join(":"), situacao: b.situacao, ...(b.comentario ? { comentario: b.comentario } : {}),
    }) },
    // ---- 06D: permissões (usuários SINTÉTICOS, escolhidos pelo perfil; ações marcadas uma a uma).
    "/api/fv2/acoes/permissoes/conceder": { campos: ["usuario", "justificativa", ...Object.values(m.ACAO).map((a) => `acao_${a.split(".")[1]}`)], fazer: (ctx, b) => nucleo.concederAcesso(ctx, { usuarioId: usuarioDoPerfil(b.usuario), acoes: acoesMarcadas(b), justificativa: b.justificativa }) },
    "/api/fv2/acoes/permissoes/revogar": { campos: ["usuario", "justificativa", ...Object.values(m.ACAO).map((a) => `acao_${a.split(".")[1]}`)], fazer: (ctx, b) => nucleo.revogarAcesso(ctx, { usuarioId: usuarioDoPerfil(b.usuario), ...(acoesMarcadas(b).length ? { acoes: acoesMarcadas(b) } : {}), justificativa: b.justificativa }) },
    // ---- 06D: configurações.
    "/api/fv2/acoes/configuracoes/unidade": { campos: ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"], fazer: (ctx, b) => nucleo.configurarUnidade(ctx, semVazios(b, ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"])) },
    "/api/fv2/acoes/configuracoes/canal": { campos: ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"], fazer: (ctx, b) => nucleo.registrarCanalOuProcessador(ctx, semVazios(b, ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"])) },
    "/api/fv2/acoes/configuracoes/conta": { campos: ["conta", "nome", "ativa", "justificativa"], fazer: (ctx, b) => nucleo.alterarContaFinanceira(ctx, { contaId: id(b.conta), ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}), justificativa: b.justificativa }) },
    "/api/fv2/acoes/configuracoes/categoria": { campos: ["codigo", "nome", "ativa", "justificativa"], fazer: (ctx, b) => nucleo.alterarCategoria(ctx, { codigo: b.codigo, mudancas: { ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}) }, justificativa: b.justificativa }) },
    // ---- 06D: integridade de documento (grava o resultado no histórico).
    "/api/fv2/acoes/documentos/verificar": { campos: ["documento"], fazer: (ctx, b) => nucleo.verificarIntegridadeDoDocumento(ctx, { id: id(b.documento) }) },
    // 08C: recusar candidata (ambígua ou errada), sempre com justificativa — libera a correta sem "escolha da máquina".
    "/api/fv2/acoes/conciliacoes/rejeitar": { campos: ["correspondencia", "justificativa"], fazer: (ctx, b) => nucleo.rejeitarCorrespondencia(ctx, { correspondenciaId: id(b.correspondencia), justificativa: b.justificativa }) },
    "/api/fv2/acoes/conciliacoes/gerar": { campos: ["competencia"], fazer: (ctx, b) => {
      if (!/^\d{4}-\d{2}$/.test(String(b.competencia ?? ""))) throw Object.assign(new Error("Competência inválida."), { codigo: m.CODIGO.ENTRADA_INVALIDA });
      const fim = m.tempo.ultimoDiaDe(b.competencia);
      const hoje = m.tempo.hojeEm(relogio());
      return nucleo.gerarCandidatasDeConciliacao(ctx, { relacao: "SAIPOS_X_STONE", periodoInicio: `${b.competencia}-01`, periodoFim: fim < hoje ? fim : hoje });
    } },
  };
  const ERROS = () => ({
    [m.CODIGO.SESSAO_AUSENTE]: 401, [m.CODIGO.SESSAO_INVALIDA]: 401, [m.CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [m.CODIGO.PERMISSAO_INSUFICIENTE]: 403,
    [m.CODIGO.ENTRADA_INVALIDA]: 400, [m.CODIGO.DATA_INVALIDA]: 400, [m.CODIGO.VALOR_INVALIDO]: 400, [m.CODIGO.NAO_ENCONTRADO]: 404,
    [m.CODIGO.TRANSICAO_INVALIDA]: 409, [m.CODIGO.CONCILIACAO_INVALIDA]: 409, [m.CODIGO.CONFLITO_IDEMPOTENCIA]: 409, [m.CODIGO.CONFLITO_VERSAO]: 409,
    [m.CODIGO.IMPORTACAO_INVALIDA]: 422, [m.CODIGO.HOMOLOGACAO_BLOQUEADA]: 409, [m.CODIGO.COMPETENCIA_HOMOLOGADA]: 409,
    [m.CODIGO.CONFIRMACAO_EXIGIDA]: 400, [m.CODIGO.CATEGORIA_INVALIDA]: 409, [m.CODIGO.OPERACAO_INVALIDA]: 409, [m.CODIGO.DOCUMENTO_INDISPONIVEL]: 409,
    [m.CODIGO.DOCUMENTO_ADULTERADO]: 409, [m.CODIGO.COFRE_INDISPONIVEL]: 503, [m.CODIGO.EVIDENCIA_EXIGIDA]: 409, [m.CODIGO.DOCUMENTO_INVALIDO]: 422, [m.CODIGO.LIQUIDACAO_EXCEDE_SALDO]: 409, [m.CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO]: 409, [m.CODIGO.LIQUIDACAO_INCOMPATIVEL]: 409,
  });
  const acoesMarcadas = (b) => Object.values(m.ACAO).filter((a) => b[`acao_${a.split(".")[1]}`] === "on" || b[`acao_${a.split(".")[1]}`] === true);
  const semVazios = (b, campos) => Object.fromEntries(campos.filter((k) => b[k] !== undefined && b[k] !== "").map((k) => [k, b[k]]));
  /**
   * Ação mutável da demonstração (POST). Exige: sessão de demonstração explícita, token CSRF do perfil, confirmação humana
   * (`confirmar: true`), campos conhecidos e a permissão própria da operação (conferida pelo núcleo). Nunca simula sucesso.
   */
  async function agir(caminho, corpo, perfil, { csrf } = {}) {
    try {
      const acao = ACOES[caminho];
      if (!acao) return { status: 404, corpo: { erro: "NAO_ENCONTRADO", mensagem: "Ação inexistente." } };
      if (!sessaoDe(perfil)) return { status: 401, corpo: { erro: m.CODIGO.SESSAO_AUSENTE, mensagem: "Sessão ausente." } };
      // 06D: sessão inválida ou expirada é recusada como tal (401) antes de qualquer outra conferência.
      await sessoes.unidadesAutorizadas(sessaoDe(perfil));
      if (!tokenConfere(perfil, csrf)) return { status: 403, corpo: { erro: "CSRF", mensagem: "Token de segurança ausente ou inválido. Recarregue a página." } };
      if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return { status: 400, corpo: { erro: m.CODIGO.ENTRADA_INVALIDA, mensagem: "Corpo inválido." } };
      const desconhecidos = Object.keys(corpo).filter((k) => ![...acao.campos, "unidade", "confirmar"].includes(k));
      if (desconhecidos.length) return { status: 400, corpo: { erro: m.CODIGO.ENTRADA_INVALIDA, mensagem: "Campos desconhecidos." } };
      if (corpo.confirmar !== true) return { status: 400, corpo: { erro: "CONFIRMACAO_EXIGIDA", mensagem: "Esta ação grava dados: confirme explicitamente." } };
      const ctx = await sessoes.contextoPara(sessaoDe(perfil), { unidadeId: corpo.unidade });
      return { status: 200, corpo: sanitizarComRef(await acao.fazer(ctx, corpo)) };
    } catch (e) {
      const status = e?.codigo ? ERROS()[e.codigo] : null;
      if (status) return { status, corpo: { erro: e.codigo, mensagem: e.message } };
      return { status: 500, corpo: { erro: "FALHA_DA_ACAO", mensagem: "A ação não foi concluída. Nada foi gravado parcialmente." } };
    }
  }
  /** Tratador puro (testável): caminho + parâmetros + perfil de sessão → { status, corpo }. */
  async function responder(caminho, params, perfil) {
    try {
      const s = sessaoDe(perfil);
      if (caminho === "/api/fv2/sessao") {
        const unidades = await sessoes.unidadesAutorizadas(s);
        return { status: 200, corpo: {
          dataBase: m.tempo.hojeEm(relogio()), csrf: s ? tokenDe(perfil) : null,
          modo: sessaoDoPedido ? "HOMOLOGACAO" : "DEMONSTRACAO", usuario: s ? NOMES_DEMO[s.user.id] ?? s.nome ?? null : null,
          // 06D: pessoas SINTÉTICAS que podem receber acesso (escolhidas pelo perfil; o id nunca vem do cliente).
          pessoasDemo: [["gestor", USUARIOS.gestor], ["operador", USUARIOS.operador], ["administrador", USUARIOS.administrador], ["sem-acesso", USUARIOS.leitor]].map(([perfil, id]) => ({ perfil, nome: NOMES_DEMO[id] })),
          unidades: unidades.map((u) => ({ id: u.unidadeId, nome: UNIDADES.find((x) => x.id === u.unidadeId)?.nome ?? "Unidade", permissoes: u.acoes })),
        } };
      }
      if (caminho === "/api/fv2/conferencias/catalogo") {
        await sessoes.contextoPara(s, { unidadeId: params.unidade });
        return { status: 200, corpo: { arquivos: CATALOGO.map(({ conteudo, ...x }) => x), observacao: "Somente arquivos SINTÉTICOS gerados pela demonstração. Envio de arquivos reais não está disponível." } };
      }
      const unidadeId = UNIDADES.find((u) => u.id === params.unidade)?.id ?? params.unidade;
      const ctx = await sessoes.contextoPara(s, { unidadeId });
      const competencia = params.competencia;
      if (caminho === "/api/fv2/documentos/arquivo") {
        // 06D: o ARQUIVO só sai para quem tem financeiro_v2.documentos, revalidado agora; cabeçalhos seguros do núcleo.
        const finalidade = params.finalidade === "visualizar" ? "VISUALIZAR" : params.finalidade === "baixar" ? "BAIXAR" : null;
        if (!finalidade) return { status: 400, corpo: { erro: "FINALIDADE", mensagem: "Finalidade inválida." } };
        const a = await nucleo.obterArquivoDoDocumento(ctx, { id: reverso.get(params.id) ?? NENHUM, finalidade });
        return { status: 200, binario: Buffer.from(a.conteudo), cabecalhos: a.cabecalhos };
      }
      if (caminho === "/api/fv2/visao-geral") {
        const vg = await nucleo.apurarVisaoGeral(ctx, { competencia });
        const situacao = await nucleo.consultarCompetencia(ctx, { competencia });
        return { status: 200, corpo: sanitizarComRef({ ...vg, financeiro: await nucleo.consultarResumoFinanceiro(ctx, { competencia }), fechamento: { estado: situacao.estado, revisoes: situacao.revisoes } }) };
      }
      if (TESOURARIA[caminho]) return { status: 200, corpo: sanitizarComRef(await TESOURARIA[caminho](ctx, params)) };
      if (caminho === "/api/fv2/dre") {
        const ap = await nucleo.apurarCompetencia(ctx, { competencia });
        return { status: 200, corpo: sanitizarComRef({ competencia, impressao: ap.impressao, versaoHomologada: ap.versaoHomologada, dre: ap.dre, cadaCem: ap.cadaCem, pendencias: ap.pendencias, faturamentoBruto: ap.indicadores.FATURAMENTO_BRUTO_PROPRIO, resultadoGerencial: ap.indicadores.RESULTADO_GERENCIAL, faturamentoLiquidoGerencial: ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL }) };
      }
      if (caminho === "/api/fv2/composicao") {
        if (!CODIGOS.has(params.codigo)) return { status: 400, corpo: { erro: "INDICADOR_DESCONHECIDO", mensagem: "Indicador desconhecido." } };
        return { status: 200, corpo: sanitizarComRef(await nucleo.composicaoDoIndicador(ctx, { competencia, codigo: params.codigo })) };
      }
      return { status: 404, corpo: { erro: "NAO_ENCONTRADO", mensagem: "Consulta inexistente." } };
    } catch (e) {
      const mapa = { [m.CODIGO.SESSAO_AUSENTE]: 401, [m.CODIGO.SESSAO_INVALIDA]: 401, [m.CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [m.CODIGO.PERMISSAO_INSUFICIENTE]: 403, [m.CODIGO.ENTRADA_INVALIDA]: 400, [m.CODIGO.DATA_INVALIDA]: 400, [m.CODIGO.NAO_ENCONTRADO]: 404,
        [m.CODIGO.DOCUMENTO_INDISPONIVEL]: 409, [m.CODIGO.DOCUMENTO_ADULTERADO]: 409, [m.CODIGO.COFRE_INDISPONIVEL]: 503 };
      if (e?.codigo && mapa[e.codigo]) return { status: mapa[e.codigo], corpo: { erro: e.codigo, mensagem: e.message } };
      return { status: 500, corpo: { erro: "FALHA_DA_CONSULTA", mensagem: "Não foi possível consultar agora." } };
    }
  }
  return { responder, agir, unidades: UNIDADES };
}

/**
 * Correspondências sintéticas (Execução 06C): pedido SAIPOS × transação Stone de setembro (identificador comum) e, em
 * outubro, conta de energia × saída bancária com comprovante (pronta para confirmar por quem tem permissão).
 */
async function conciliacoesDemo(nucleo, A, { banco }) {
  await nucleo.gerarCandidatasDeConciliacao(A, { relacao: "SAIPOS_X_STONE", periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  const energia = (await nucleo.consultarContasAPagar(A, {})).itens.find((t) => t.fornecedor?.nome?.startsWith("Energia"));
  const comprovante = (await nucleo.registrarDocumento(A, { origem: "MANUAL", arquivoId: "demo-comprovante-energia", hashSha256: createHash("sha256").update("demo-comprovante-energia").digest("hex"), tipo: "COMPROVANTE", recebidoEm: "2026-10-28", descricao: "Comprovante de pagamento da energia (demonstração)" })).documento.id;
  const saida = (await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-10-28", sentido: "SAIDA", valorCentavos: energia.saldoCentavos, natureza: "PAGAMENTO", descricao: "PAG CONCESSIONARIA SINT", documentoId: comprovante })).movimentacao;
  await nucleo.criarCorrespondenciaCandidata(A, { ladoA: [{ tipo: "OBRIGACAO", id: energia.id, valorCentavos: energia.saldoCentavos }], ladoB: [{ tipo: "MOVIMENTACAO", id: saida.id, valorCentavos: energia.saldoCentavos }], evidenciaDocumentoIds: [comprovante], justificativa: "Mesmo valor; comprovante da concessionária." });
}

/**
 * Catálogo de arquivos SINTÉTICOS da demonstração (Execução 06C). Só estes podem ser importados localmente: não existe
 * envio de arquivo real. Outubro/2026 (competência aberta), para não alterar o cenário conferido de setembro.
 */
function catalogoSintetico() {
  const pedidos = () => saiposVendas([
    { pedido: "DEMO-O1", data: "01/10/2026 12:10", canal: "Balcão", itens: 2800, forma: "Dinheiro" },
    { pedido: "DEMO-O2", data: "01/10/2026 12:30", canal: "Balcão", itens: 3600, forma: "Crédito", autorizacao: "AUT-DEMO-O2" },
    { pedido: "DEMO-O3", data: "01/10/2026 13:00", canal: "Balcão", itens: 1900, forma: "Débito" },
  ]);
  return [
    { id: "pedidos-saipos-0110", nome: "Vendas por pedido do SAIPOS — 01/10 (sintético, CSV)", fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", periodoInicio: "2026-10-01", periodoFim: "2026-10-01", leitor: "Não homologado (contrato sintético)", conteudo: pedidos },
    { id: "pedidos-saipos-0110-copia", nome: "Mesmo arquivo de vendas por pedido (repetido)", fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", periodoInicio: "2026-10-01", periodoFim: "2026-10-01", leitor: "Não homologado (contrato sintético)", conteudo: pedidos },
    { id: "stone-0110", nome: "Vendas da Stone — 01/10 (sintético, CSV)", fonte: "STONE", tipoRelatorio: "STONE_VENDAS", periodoInicio: "2026-10-01", periodoFim: "2026-10-01", leitor: "Homologado em XLSX; este CSV é formato não homologado",
      conteudo: () => stoneCsv([{ id: "DEMO-SO2", quando: "01/10/2026 12:31", bruto: "36,000000", liquido: "35,154000", unificado: "-0,846000", aut: "AUT-DEMO-O2" }, { id: "DEMO-SO9", quando: "01/10/2026 18:02", bruto: "21,500000", liquido: "21,000000", unificado: "-0,500000" }]) },
    // 08D — cenário AMBÍGUO: dois pedidos de mesmo valor com 6 minutos de diferença e UMA transação Stone sem código de
    // autorização entre eles. A regra gera duas candidatas FRACAS disputando a mesma transação: nenhuma confirma por
    // proximidade; só um documento (ex.: comprovante da maquininha) decide qual pedido é.
    { id: "pedidos-saipos-0510-ambiguo", nome: "Vendas por pedido do SAIPOS — 05/10, dois pedidos iguais (sintético, CSV)", fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", periodoInicio: "2026-10-05", periodoFim: "2026-10-05", leitor: "Não homologado (contrato sintético)",
      conteudo: () => saiposVendas([{ pedido: "DEMO-A1", data: "05/10/2026 12:00", canal: "Balcão", itens: 4200, forma: "Débito" }, { pedido: "DEMO-A2", data: "05/10/2026 12:06", canal: "Balcão", itens: 4200, forma: "Débito" }]) },
    { id: "stone-0510-ambiguo", nome: "Vendas da Stone — 05/10, transação sem autorização (sintético, CSV)", fonte: "STONE", tipoRelatorio: "STONE_VENDAS", periodoInicio: "2026-10-05", periodoFim: "2026-10-05", leitor: "Homologado em XLSX; este CSV é formato não homologado",
      conteudo: () => stoneCsv([{ id: "DEMO-SA1", quando: "05/10/2026 12:03", produto: "Debito", bruto: "42,000000", liquido: "41,580000", unificado: "-0,420000" }]) },
    { id: "faturamento-saipos-0310", nome: "Faturamento diário do SAIPOS — 03/10 (sintético, PDF)", fonte: "SAIPOS", tipoRelatorio: "SAIPOS_FATURAMENTO_POR_DIA", periodoInicio: "2026-10-03", periodoFim: "2026-10-03", leitor: "Homologado (PDF)",
      conteudo: () => faturamentoSaiposPdf([{ data: "03/10/2026", valor: 96000, desconto: 2400 }]) },
    { id: "arquivo-incompativel", nome: "Arquivo que não é relatório da Stone (deve ser rejeitado)", fonte: "STONE", tipoRelatorio: "STONE_VENDAS", periodoInicio: "2026-10-02", periodoFim: "2026-10-02", leitor: "—",
      conteudo: () => texto("planilha qualquer sem as colunas esperadas\n1;2;3") },
  ];
}

/**
 * Vendas e recebimentos sintéticos (Execução 06B), sobre o mesmo cenário de setembro:
 *   - pedidos SAIPOS de 03 e 04/09 (sem conta de caixa: o dinheiro fica "a identificar"); P-102 pago pela Stone S-77, cuja
 *     taxa tem fração de centavo; P-103 ("Múltiplas") completado com dinheiro + débito Stone; S-88 Stone SEM pedido;
 *   - venda cancelada; segunda venda Anota AI; repasse agrupado Anota AI pelo extrato Unicred de outubro (comprovado);
 *   - formas de pagamento SAIPOS de 02/09 com total diferente do faturamento agregado do dia → divergência entre relatórios;
 *   - boleto sem identificação lançado como DESPESA A CLASSIFICAR (fica fora da DRE até ser classificado).
 */
async function vendasERecebimentos(nucleo, A, { banco, importar }) {
  const aplicar = async (p) => { await nucleo.aprovarProposta(A, { propostaId: p.id, justificativa: "Demonstração." }); return nucleo.aplicarProposta(A, { propostaId: p.id }); };
  const pedidos = await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "DEMO-P101", data: "03/09/2026 12:10", canal: "Balcão", itens: 3200, forma: "Dinheiro" },
    { pedido: "DEMO-P102", data: "03/09/2026 12:40", canal: "Balcão", itens: 4500, forma: "Crédito", autorizacao: "AUT-DEMO-77" },
    { pedido: "DEMO-P103", data: "04/09/2026 19:05", canal: "Balcão", itens: 6000, forma: "Múltiplas" },
  ]), { periodoInicio: "2026-09-03", periodoFim: "2026-09-04" });
  await nucleo.gerarPropostas(A, { importacaoId: pedidos.id });
  const efeitos = {};
  for (const p of await nucleo.listarPropostas(A, { operacao: "VENDA" })) efeitos[p.comando.fonte.idExterno] = (await aplicar(p)).efeitos.find((e) => e.tipo === "VENDA").id;
  const stone = await importar("STONE", "STONE_VENDAS", stoneCsv([
    { id: "DEMO-S77", quando: "03/09/2026 12:41", bruto: "45,000000", liquido: "43,942500", unificado: "-1,057500", aut: "AUT-DEMO-77" },
    { id: "DEMO-S88", quando: "04/09/2026 21:15", bruto: "33,000000", liquido: "32,224500", unificado: "-0,775500" },
  ]), { periodoInicio: "2026-09-03", periodoFim: "2026-09-04" });
  await nucleo.gerarPropostas(A, { importacaoId: stone.id });
  const s77 = (await nucleo.listarPropostas(A, { operacao: "PAGAMENTO_STONE" })).find((p) => p.comando.fonte.idExterno === "DEMO-S77");
  await aplicar(s77);
  await nucleo.registrarPagamentoDeVenda(A, { vendaId: efeitos["DEMO-P103"], forma: "DINHEIRO", valorCentavos: 2000 });
  await nucleo.registrarPagamentoDeVenda(A, { vendaId: efeitos["DEMO-P103"], forma: "DEBITO", processador: "STONE", valorCentavos: 4000 });
  const cancelada = await nucleo.registrarVenda(A, { canal: "BALCAO", dataVenda: "2026-09-09", brutoCentavos: 1500, fonte: { sistema: "MANUAL", idExterno: "DEMO-X1" }, composicao: { itensCentavos: 1500 }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 1500 }] });
  await nucleo.cancelarVenda(A, { vendaId: cancelada.venda.id, justificativa: "Pedido lançado em duplicidade (demonstração)." });
  const anota2 = await nucleo.registrarVenda(A, { canal: "ANOTA_AI", dataVenda: "2026-09-12", brutoCentavos: 42000, fonte: { sistema: "MANUAL", idExterno: "DEMO-A2" }, composicao: { itensCentavos: 42000 }, pagamentos: [{ forma: "PIX", processador: "ANOTA_AI", valorCentavos: 42000 }] });
  const anota1 = (await nucleo.consultarContasAReceber(A, { processador: "ANOTA_AI" })).itens.find((t) => t.id !== anota2.recebiveis[0].id);
  const extrato = await importar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 100000, lancamentos: [{ data: "09/10/2026", historico: "CRED ANOTA AI REPASSE SINT", valor: 140000 }] }), { periodoInicio: "2026-10-01", periodoFim: "2026-10-31" });
  await nucleo.gerarPropostas(A, { importacaoId: extrato.id, contaBancariaId: banco.id });
  const [mov] = await nucleo.listarPropostas(A, { operacao: "MOVIMENTACAO_BANCARIA" });
  const credito = (await aplicar(mov)).efeitos.find((e) => e.tipo === "MOVIMENTACAO").id;
  await nucleo.registrarLiquidacao(A, { movimentacaoId: credito, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: anota1.id, valorCentavos: 98000 }, { alvoTipo: "RECEBIVEL", alvoId: anota2.recebiveis[0].id, valorCentavos: 42000 }] });
  await importar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", saiposFormas([["Dinheiro", 4, 100000], ["Crédito", 3, 80000]]), { periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  await nucleo.registrarDivergenciaEntreFontes(A, { periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  const desconhecido = await nucleo.registrarContraparte(A, { tipo: "OUTRO", nome: "Beneficiário a identificar (demonstração)" });
  await nucleo.registrarObrigacao(A, { contraparteId: desconhecido.id, valorOriginalCentavos: 18990, categoria: "DESPESAS_A_CLASSIFICAR", descricao: "Boleto sem identificação", competencia: "2026-10", dataEmissao: "2026-10-20", vencimento: "2026-11-25" });
}

/**
 * Tesouraria sintética (Execução 06A), sobre o mesmo cenário. Data-base da demonstração: 12/11/2026.
 *   - Unicred e Caixa com saldo INFORMADO em 01/09 (âncoras); depósito do caixa no banco como transferência interna;
 *   - aluguel recorrente (setembro e outubro pagos, novembro VENCIDO em aberto → dezembro só como previsão estimada);
 *   - freezer parcelado em 3x (patrimonial), energia a vencer, frutas pagas em parte; insumos e embalagens vencidos;
 *   - repasse iFood recebido no banco; Stone recebido em parte (sem previsão para o resto); Anota AI sem previsão;
 *   - vale-refeição com demonstrativo e data prevista documentada; um Pix recebido sem vínculo;
 *   - caixa físico: sessão de 10/11 fechada com diferença justificada e sessão de 11/11 aberta (suprimento e sangria).
 */
async function tesouraria(nucleo, A, { caixa, banco, ifoodRecebivel }) {
  const doc = async (n, tipo, descricao) => (await nucleo.registrarDocumento(A, { origem: "MANUAL", arquivoId: `demo-${n}`, hashSha256: createHash("sha256").update(`demo-${n}`).digest("hex"), tipo, recebidoEm: "2026-09-01", descricao })).documento.id;
  const extrato = await doc("e", "EXTRATO_BANCARIO", "Extrato de abertura (demonstração)");
  await nucleo.registrarSaldoDeConta(A, { contaId: banco.id, data: "2026-09-01", valorCentavos: 1845000, documentoId: extrato, observacao: "Saldo do extrato de abertura." });
  await nucleo.registrarSaldoDeConta(A, { contaId: caixa.id, data: "2026-09-01", valorCentavos: 50000, observacao: "Contagem de abertura." });
  await nucleo.registrarTransferencia(A, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 437350, dataEfetiva: "2026-09-10", descricao: "Depósito do caixa no banco" });
  const pagar = async (obrigacaoId, valor, data, descricao) => {
    const mv = await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO", descricao });
    await nucleo.registrarLiquidacao(A, { movimentacaoId: mv.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacaoId, valorCentavos: valor }] });
  };
  const receber = async (recebivelId, valor, data, descricao) => {
    const mv = await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: data, sentido: "ENTRADA", valorCentavos: valor, natureza: "RECEBIMENTO", descricao });
    await nucleo.registrarLiquidacao(A, { movimentacaoId: mv.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: recebivelId, valorCentavos: valor }] });
  };
  const imobiliaria = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Imobiliária (demonstração)" });
  const energia = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Energia (demonstração)" });
  const equipamentos = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Equipamentos (demonstração)" });
  const boleto = await doc("b", "BOLETO", "Boleto do aluguel (demonstração)");
  const aluguel = async (mes, id) => (await nucleo.registrarObrigacao(A, { contraparteId: imobiliaria.id, valorOriginalCentavos: 280000, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Aluguel da loja", competencia: mes, dataEmissao: `${mes}-01`, vencimento: `${mes}-10`, recorrencia: { periodicidade: "MENSAL", diaDoMes: 10 }, documentoIds: [boleto], fonte: { sistema: "MANUAL", idExterno: id } })).obrigacoes[0];
  await pagar((await aluguel("2026-09", "DEMO-AL-09")).id, 280000, "2026-09-10", "PAG BOLETO 0001 SINT");
  await pagar((await aluguel("2026-10", "DEMO-AL-10")).id, 280000, "2026-10-09", "PAG BOLETO 0002 SINT");
  await aluguel("2026-11", "DEMO-AL-11");
  const nota = await doc("n", "NOTA_FISCAL", "Nota do freezer (demonstração)");
  const eq = await nucleo.registrarObrigacao(A, { contraparteId: equipamentos.id, valorOriginalCentavos: 360000, parcelas: 3, categoria: "IMOBILIZADO", descricao: "Freezer", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-15", documentoIds: [nota] });
  await pagar(eq.obrigacoes[0].id, 120000, "2026-10-15", "PAG PARC 1/3 SINT");
  await nucleo.registrarObrigacao(A, { contraparteId: energia.id, valorOriginalCentavos: 61850, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Conta de energia", competencia: "2026-10", dataEmissao: "2026-11-01", vencimento: "2026-11-20" });
  const frutas = (await nucleo.consultarContasAPagar(A, { categoria: "FRUTAS" })).itens[0];
  await pagar(frutas.id, 200000, "2026-09-18", "PAG FORNEC FRUTAS SINT");
  // Recebimentos (o recebível iFood já tem as taxas abatidas como ajustes; recebe-se o saldo).
  const ifoodAtual = (await nucleo.consultarContasAReceber(A, { processador: "IFOOD" })).itens.find((t) => t.id === ifoodRecebivel.id);
  await receber(ifoodRecebivel.id, ifoodAtual.saldoCentavos, "2026-10-08", "CRED REPASSE IFOOD SINT");
  const stone = (await nucleo.consultarContasAReceber(A, { processador: "STONE" })).itens[0];
  await receber(stone.id, 150000, "2026-10-02", "CRED STONE SINT");
  const vr = await doc("v", "DEMONSTRATIVO_REPASSE", "Demonstrativo do vale-refeição (demonstração)");
  await nucleo.registrarRecebivel(A, { processador: "OPERADORA_BENEFICIOS", brutoCentavos: 48000, retencoes: [{ categoria: "TAXAS_DE_PROCESSAMENTO", valorCentavos: 2880 }], dataPrevista: "2026-11-28", competencia: "2026-10", descricao: "Vale-refeição de outubro", documentoIds: [vr] });
  await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-11-05", sentido: "ENTRADA", valorCentavos: 12000, natureza: "OUTRA", descricao: "PIX RECEBIDO 99887 SINT" });
  // Caixa físico: abertura de 10/11 confere com o saldo calculado da conta (R$ 250,00).
  const s1 = (await nucleo.abrirCaixa(A, { contaId: caixa.id, dataAbertura: "2026-11-10", saldoContadoCentavos: 25000 })).sessao;
  await nucleo.registrarVenda(A, { canal: "BALCAO", dataVenda: "2026-11-10", brutoCentavos: 6000, fonte: { sistema: "MANUAL", idExterno: "DEMO-D1" }, composicao: { itensCentavos: 6000 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 6000, contaId: caixa.id }] });
  await nucleo.registrarOperacaoDeCaixa(A, { sessaoId: s1.id, operacao: "SAIDA", valorCentavos: 1500, data: "2026-11-10", descricao: "Compra de gelo" });
  await nucleo.fecharCaixa(A, { sessaoId: s1.id, dataFechamento: "2026-11-10", contadoCentavos: 29000, justificativa: "Troco dado a mais (demonstração).", confirmar: true });
  const s2 = (await nucleo.abrirCaixa(A, { contaId: caixa.id, dataAbertura: "2026-11-11", saldoContadoCentavos: 29000 })).sessao;
  await nucleo.registrarOperacaoDeCaixa(A, { sessaoId: s2.id, operacao: "SUPRIMENTO", valorCentavos: 10000, data: "2026-11-11", descricao: "Troco", contraContaId: banco.id });
  await nucleo.registrarOperacaoDeCaixa(A, { sessaoId: s2.id, operacao: "SANGRIA", valorCentavos: 20000, data: "2026-11-12", descricao: "Depósito no banco", contraContaId: banco.id });
}

/** Documentos SINTÉTICOS no cofre da demonstração (06D): PDF íntegro com duas versões, PDF com conteúdo ativo e CSV. */
export function pdfSintetico(texto, extra = "") {
  const conteudo = `BT /F1 12 Tf 72 720 Td (${texto}) Tj ET`;
  return new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R ${extra} >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${conteudo.length} >> stream
${conteudo}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`);
}
async function documentosDemo(nucleo, A, cofre) {
  const guardar = async (conteudo, tipoMime, ficha) => {
    const g = await cofre.guardar(A, { conteudo, tipoMime });
    return (await nucleo.registrarDocumento(A, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, recebidoEm: "2026-09-30", competencia: "2026-09", ...ficha })).documento;
  };
  const v1 = await guardar(pdfSintetico("Comprovante sintetico de pagamento - versao 1"), "application/pdf", { tipo: "COMPROVANTE", descricao: "Comprovante de pagamento (sintético)" });
  await guardar(pdfSintetico("Comprovante sintetico de pagamento - versao 2 corrigida"), "application/pdf", { tipo: "COMPROVANTE", descricao: "Comprovante de pagamento corrigido (sintético)", substituiId: v1.id });
  await guardar(pdfSintetico("Nota sintetica", "/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"), "application/pdf", { tipo: "NOTA_FISCAL", descricao: "Nota com conteúdo ativo (sintética): só download" });
  await guardar(new TextEncoder().encode("data;descricao;valor\n2026-09-01;Exemplo sintetico;10,00\n"), "text/csv", { tipo: "RELATORIO_VENDAS", descricao: "Planilha sintética (CSV): só download" });
}
