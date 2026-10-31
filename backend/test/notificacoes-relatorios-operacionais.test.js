import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { segundaDaSemana, diasDaSemana, ultimaSemanaEncerrada, resumirSemana, gerarMensagemSemanal, validarMensagemSemanal, fechamentosValidosDaSemana, STATUS_SEMANA } from "../src/modules/checklist-operacional/checklistOperacional.semanal.js";
import { filtrarUnidadesComChecklist, elegibilidadeDiaria, planejarResumoSemanal, destinatariosAutorizados, motivoDeIntegracao, MOTIVO, CATEGORIA_SEMANAL } from "../src/modules/notificacoes/notificacoes.relatorios.js";
import { lerIntegracaoDaUnidade, unidadesComIntegracaoViva } from "../src/modules/notificacoes/notificacoes.relatorios.integracao.js";

const VIVA = { estado: "ao_vivo", motivo: null };

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEG = "2026-10-26";   // segunda-feira
const tempo = (media, amostras) => ({ estado: "calculado", nome: "x", media, amostras });
const dia = (competencia, over = {}) => ({
  id: `f-${competencia}`, competencia, versao: 1, status: "CONSOLIDADO", hash_conteudo: `h${competencia}`,
  indicadores: { pedidos: { recebidos: 100, concluidosNoDia: 95, canceladosNoDia: 5 }, preparo: tempo(10, 100), entrega: tempo(20, 90), vida: tempo(30, 90),
    atrasos: { pedidosAvaliados: 100, pedidosAtrasados: 10 }, cancelamentos: { total: 5, motivos: [{ codigo: "A", descricao: "Loja fechada", quantidade: 3 }, { codigo: "B", descricao: "Cliente desistiu", quantidade: 2 }] },
    disputas: { abertasNoDia: 1, expiradasNoDia: 0 }, descontos: { loja: 50, pedidosComDescontoLoja: 4 } }, ...over,
});
const semana = (n = 7, over = {}) => diasDaSemana(SEG).slice(0, n).map((d) => dia(d, over));

describe("calendário da semana", () => {
  test("segunda a domingo; semana em curso nunca é resumida", () => {
    assert.equal(segundaDaSemana("2026-11-01"), SEG);            // domingo
    assert.equal(segundaDaSemana("2026-10-26"), SEG);
    assert.equal(diasDaSemana(SEG)[6], "2026-11-01");
    assert.equal(ultimaSemanaEncerrada("2026-11-02"), SEG);      // segunda: a semana que acabou
    assert.equal(ultimaSemanaEncerrada("2026-11-01"), "2026-10-19"); // domingo ainda é a semana em curso
    assert.throws(() => segundaDaSemana("x"));
  });
});

describe("resumo semanal a partir dos fechamentos armazenados", () => {
  test("semana completa: somas exatas e médias PONDERADAS (não média de médias)", () => {
    const v = semana(7); v[0].indicadores.preparo = tempo(10, 300); v[1].indicadores.preparo = tempo(40, 100);
    const r = resumirSemana(SEG, v);
    assert.equal(r.status, STATUS_SEMANA.COMPLETA);
    assert.deepEqual(r.indicadores.pedidos, { recebidos: 700, concluidos: 665, cancelados: 35 });
    assert.equal(r.indicadores.preparo.amostras, 300 + 100 + 500);
    assert.ok(Math.abs(r.indicadores.preparo.media - (10 * 300 + 40 * 100 + 10 * 500) / 900) < 1e-9);
    assert.equal(r.indicadores.atrasos.pct, 10);
    assert.deepEqual(r.indicadores.cancelamentos.motivos[0], { descricao: "Loja fechada", quantidade: 21 });
  });
  test("só conta CONSOLIDADO/REVISADO e a versão mais recente de cada dia; PRELIMINAR/INCOMPLETO ficam de fora", () => {
    const v = [...semana(7), dia(SEG, { versao: 2, status: "REVISADO", indicadores: { ...dia(SEG).indicadores, pedidos: { recebidos: 999, concluidosNoDia: 0, canceladosNoDia: 0 } } }),
      dia("2026-10-27", { versao: 9, status: "PRELIMINAR" }), dia("2026-10-28", { versao: 9, status: "INCOMPLETO" })];
    const val = fechamentosValidosDaSemana(SEG, v);
    assert.equal(val[0].fechamento.versao, 2);
    assert.equal(val[1].fechamento.versao, 1);   // a PRELIMINAR v9 é ignorada
    assert.equal(resumirSemana(SEG, v).indicadores.pedidos.recebidos, 999 + 600);
  });
  test("cobertura mínima: 4 de 7 dias = INCOMPLETA, sem indicadores e SEM mensagem; 5 de 7 = PARCIAL declarando os dias ausentes", () => {
    const r4 = resumirSemana(SEG, semana(4)); assert.equal(r4.status, STATUS_SEMANA.INCOMPLETA); assert.equal(r4.indicadores, null);
    assert.equal(gerarMensagemSemanal({ resumo: r4 }), null);
    const r5 = resumirSemana(SEG, semana(5)); assert.equal(r5.status, STATUS_SEMANA.PARCIAL); assert.deepEqual(r5.diasAusentes, ["2026-10-31", "2026-11-01"]);
    const m = gerarMensagemSemanal({ resumo: r5, unidadeNome: "Unidade X" });
    assert.match(m, /SEMANA PARCIAL \(5\/7 dias; sem fechamento válido: Sáb 31\/10, Dom 01\/11\)/);
  });
  test("tempo sem amostra fica 'não disponível' (nunca zero) e dado de outra semana é ignorado", () => {
    const v = semana(7); for (const f of v) f.indicadores.entrega = { estado: "indisponivel" };
    const r = resumirSemana(SEG, [...v, dia("2026-10-19")]);
    assert.equal(r.indicadores.entrega.estado, "indisponivel");
    assert.match(gerarMensagemSemanal({ resumo: r }), /Entrega: não disponível/);
    assert.equal(r.indicadores.pedidos.recebidos, 700);
  });
  test("mensagem objetiva e válida: ≤ 1500, sem dado pessoal, com a situação; texto fora do padrão é barrado", () => {
    const m = gerarMensagemSemanal({ resumo: resumirSemana(SEG, semana(7)), unidadeNome: "Unidade X" });
    assert.ok(m.length <= 1500); assert.deepEqual(validarMensagemSemanal(m, { status: "COMPLETA" }).problemas, []);
    assert.ok(!validarMensagemSemanal(`${m}\nfale com (11) 99999-9999`, {}).ok);
    assert.ok(!validarMensagemSemanal("sem situação", { status: "COMPLETA" }).ok);
  });
  test("o hash muda quando um fechamento diário é revisado (correção nunca é silenciosa)", () => {
    const a = resumirSemana(SEG, semana(7)); const v = semana(7); v[2] = { ...v[2], versao: 2, status: "REVISADO", hash_conteudo: "novo" };
    assert.notEqual(a.hash, resumirSemana(SEG, v).hash);
    assert.equal(a.hash, resumirSemana(SEG, semana(7)).hash);
  });
});

describe("elegibilidade: só unidades com Checklist Operacional ativo e dados válidos", () => {
  const unidades = [{ organizacaoId: "o1", unidadeId: "u1" }, { organizacaoId: "o1", unidadeId: "u2" }, { organizacaoId: "o2", unidadeId: "u3" }];
  test("filtra pelo módulo efetivo; falha ao ler uma unidade a exclui sem derrubar as outras", async () => {
    const modulosDe = async (_o, u) => { if (u === "u3") throw new Error("x"); return u === "u1" ? ["checklist_operacional", "ifood"] : ["ifood"]; };
    const r = await filtrarUnidadesComChecklist(unidades, { modulosDe });
    assert.deepEqual(r.elegiveis.map((u) => u.unidadeId), ["u1"]);
    assert.deepEqual(r.recusadas.map((u) => [u.unidadeId, u.motivo]), [["u2", MOTIVO.SEM_MODULO], ["u3", MOTIVO.MODULOS_INDISPONIVEIS]]);
  });
  test("diário: exige módulo, integração AO VIVO, fechamento CONSOLIDADO/REVISADO e pedidos reais", () => {
    const f = dia(SEG); const M = ["checklist_operacional"];
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: M, integracao: VIVA, fechamento: f }).elegivel, true);
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: ["ifood"], integracao: VIVA, fechamento: f }).motivo, MOTIVO.SEM_MODULO);
    for (const status of ["PRELIMINAR", "INCOMPLETO"]) assert.equal(elegibilidadeDiaria({ modulosEfetivos: M, integracao: VIVA, fechamento: { ...f, status } }).motivo, MOTIVO.DADOS_INSUFICIENTES);
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: M, integracao: VIVA, fechamento: null }).motivo, MOTIVO.DADOS_INSUFICIENTES);
  });
  test("o módulo habilitado NÃO basta: integração desconectada, não ativada ou não verificada bloqueia, com motivos DISTINTOS", () => {
    const f = dia(SEG); const M = ["checklist_operacional"];
    const motivo = (integracao) => elegibilidadeDiaria({ modulosEfetivos: M, integracao, fechamento: f }).motivo;
    assert.equal(motivo({ estado: "nao_ativada", motivo: "sem_loja_vinculada" }), MOTIVO.INTEGRACAO_NAO_ATIVADA);
    assert.equal(motivo({ estado: "nao_ativada", motivo: "sem_credencial_order" }), MOTIVO.INTEGRACAO_NAO_ATIVADA);
    assert.equal(motivo({ estado: "desatualizado", motivo: "recebimento_parado" }), MOTIVO.INTEGRACAO_DESCONECTADA);
    assert.equal(motivo({ estado: "desatualizado", motivo: "reautorizacao_necessaria" }), MOTIVO.INTEGRACAO_DESCONECTADA);
    assert.equal(motivo(undefined), MOTIVO.INTEGRACAO_NAO_VERIFICADA); assert.equal(motivo({ estado: "xyz" }), MOTIVO.INTEGRACAO_NAO_VERIFICADA);
    assert.equal(motivoDeIntegracao(VIVA), null);
  });
  test("integração viva mas SEM PEDIDOS no dia (com sinal de recebimento) é 'sem pedidos' — diferente de dados insuficientes", () => {
    const zero = dia(SEG); zero.indicadores.pedidos = { recebidos: 0, concluidosNoDia: 0, canceladosNoDia: 0 };
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: ["checklist_operacional"], integracao: VIVA, fechamento: zero }).motivo, MOTIVO.SEM_PEDIDOS);
    const semSinal = { ...zero, cobertura: { semSinalDeRecebimento: true } };
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: ["checklist_operacional"], integracao: VIVA, fechamento: semSinal }).motivo, MOTIVO.DADOS_INSUFICIENTES);
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: ["checklist_operacional"], integracao: VIVA, fechamento: { ...dia(SEG), cobertura: { semCobertura: true } } }).motivo, MOTIVO.DADOS_INSUFICIENTES);
  });
});

describe("destinatários e periodicidade do resumo semanal", () => {
  const esc = (ce, over = {}) => ({ contato_empresa_id: ce, unidade_escopo_id: "u1", categoria: CATEGORIA_SEMANAL, origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, ...over });
  const dados = { destinatarios: [{ id: "d1", ativo: true }, { id: "d2", ativo: true }, { id: "d3", ativo: true }, { id: "d4", ativo: false }, { id: "d5", ativo: true }, { id: "d6", ativo: true }],
    escopos: [esc("d1"), esc("d2", { unidade_escopo_id: "u9" }), esc("d3", { origem_autorizacao: "LEGACY_ACTIVE" }), esc("d4"), esc("d5", { suspenso_em: "2026-10-01" }), esc("d6"), esc("d1", { categoria: "fechamento_operacional_diario" })] };
  const ledger = [{ contato_empresa_id: "d1", categoria: CATEGORIA_SEMANAL, acao: "CONCEDIDO" }, { contato_empresa_id: "d6", categoria: CATEGORIA_SEMANAL, acao: "REVOGADO" }, { contato_empresa_id: "d6", categoria: CATEGORIA_SEMANAL, acao: "CONCEDIDO" }];
  test("só quem tem escopo ativo DESTA unidade, origem convite+OTP, consentimento vigente, cadastro ativo e não suspenso", () => {
    assert.deepEqual(destinatariosAutorizados({ categoria: CATEGORIA_SEMANAL, unidadeId: "u1", dados, ledger }).map((e) => e.contato_empresa_id), ["d1"]);
  });
  test("plano da semana: um item por destinatário, idempotente por semana+versão, BLOQUEADO sem cota; nada é enviado nem gravado", () => {
    const p = planejarResumoSemanal({ organizacaoId: "o1", unidadeId: "u1", modulosEfetivos: ["checklist_operacional"], integracao: VIVA, versoes: semana(7), hojeIso: "2026-11-02", dados, ledger, cotas: { d1: { disponivel: true } } });
    assert.equal(p.elegivel, true); assert.equal(p.linhas.length, 1);
    assert.deepEqual([p.linhas[0].status, p.linhas[0].transporte], ["SIMULATED", "noop"]);
    assert.match(p.linhas[0].chave_idempotencia, /^wa:sem:u1:2026-10-26:d1:[0-9a-f]{32}$/);
    const sem = planejarResumoSemanal({ organizacaoId: "o1", unidadeId: "u1", modulosEfetivos: ["checklist_operacional"], integracao: VIVA, versoes: semana(7), hojeIso: "2026-11-02", dados, ledger, cotas: {} });
    assert.equal(sem.linhas[0].status, "BLOCKED");
  });
  test("recusas: sem módulo, semana incompleta, sem destinatário", () => {
    const base = { organizacaoId: "o1", unidadeId: "u1", integracao: VIVA, versoes: semana(7), hojeIso: "2026-11-02", dados, ledger };
    assert.equal(planejarResumoSemanal({ ...base, modulosEfetivos: ["ifood"] }).motivo, MOTIVO.SEM_MODULO);
    assert.equal(planejarResumoSemanal({ ...base, modulosEfetivos: ["checklist_operacional"], versoes: semana(3) }).motivo, MOTIVO.DADOS_INSUFICIENTES);
    assert.equal(planejarResumoSemanal({ ...base, modulosEfetivos: ["checklist_operacional"], integracao: { estado: "desatualizado" } }).motivo, MOTIVO.INTEGRACAO_DESCONECTADA);
    assert.equal(planejarResumoSemanal({ ...base, modulosEfetivos: ["checklist_operacional"], integracao: undefined }).motivo, MOTIVO.INTEGRACAO_NAO_VERIFICADA);
    const zeros = semana(7).map((f) => ({ ...f, indicadores: { ...f.indicadores, pedidos: { recebidos: 0, concluidosNoDia: 0, canceladosNoDia: 0 } } }));
    assert.equal(planejarResumoSemanal({ ...base, modulosEfetivos: ["checklist_operacional"], versoes: zeros }).motivo, MOTIVO.SEM_PEDIDOS);
    assert.equal(planejarResumoSemanal({ ...base, modulosEfetivos: ["checklist_operacional"], unidadeId: "u7" }).motivo, MOTIVO.SEM_DESTINATARIO);
  });
});

describe("leitura da integração real (conexão de pedidos, credencial Order, recebimento)", () => {
  const AGORA = new Date("2026-11-02T12:00:00Z");
  const vivo = { disponivel: true, ultimoEvento: "2026-11-02T11:59:50Z", lease: { atualizadoEm: "2026-11-02T11:59:40Z", leaseAte: "2026-11-02T12:00:30Z" } };
  const repoIfood = (over = {}) => ({
    obterConexaoViva: async () => ({ id: "c1", merchant_id: "m1", status: "ativa" }),
    listarCredenciaisDaConexao: async () => [{ app_type: "order", status: "ativa" }],
    obterObservabilidadeOrder: async () => vivo, listarConexoesVivas: async () => [], ...over,
  });
  const ler = (over) => lerIntegracaoDaUnidade({ organizacaoId: "o1", unidadeId: "u1", agora: () => AGORA, deps: { ifoodRepo: repoIfood(over) } });
  test("loja vinculada + credencial Order + lease renovado há pouco = ao_vivo", async () => { assert.equal((await ler()).estado, "ao_vivo"); });
  test("sem loja vinculada, sem credencial Order, só conexão Financial: nao_ativada", async () => {
    assert.equal((await ler({ obterConexaoViva: async () => null })).motivo, "sem_loja_vinculada");
    assert.equal((await ler({ listarCredenciaisDaConexao: async () => [] })).motivo, "sem_credencial_order");
    const so = await ler({ obterConexaoViva: async () => null, listarConexoesVivas: async () => [{ id: "fin" }] });
    assert.deepEqual([so.estado, so.motivo], ["nao_ativada", "sem_credencial_order"]);
  });
  test("recebimento parado (lease vencido) ou reautorização: desatualizado; nunca ao_vivo", async () => {
    const parado = await ler({ obterObservabilidadeOrder: async () => ({ ...vivo, lease: { atualizadoEm: "2026-11-02T11:50:00Z", leaseAte: "2026-11-02T11:51:00Z" } }) });
    assert.deepEqual([parado.estado, parado.motivo], ["desatualizado", "recebimento_parado"]);
    const reauth = await ler({ obterConexaoViva: async () => ({ id: "c1", merchant_id: "m1", status: "reauth_required" }) });
    assert.equal(reauth.estado, "desatualizado");
  });
  test("falha ao ler o banco = null (não verificada, fail-closed) e a unidade é recusada com esse motivo", async () => {
    assert.equal(await ler({ obterConexaoViva: async () => { throw new Error("x"); } }), null);
    const r = await unidadesComIntegracaoViva([{ organizacaoId: "o1", unidadeId: "u1" }], { agora: () => AGORA, deps: { modulosDe: async () => ["checklist_operacional"], ifoodRepo: repoIfood({ obterConexaoViva: async () => { throw new Error("x"); } }) } });
    assert.deepEqual(r.recusadas.map((u) => u.motivo), [MOTIVO.INTEGRACAO_NAO_VERIFICADA]);
  });
  test("funil: módulo + integração viva; cada recusa com motivo próprio", async () => {
    const un = [{ organizacaoId: "o1", unidadeId: "uOK" }, { organizacaoId: "o1", unidadeId: "uSemModulo" }, { organizacaoId: "o1", unidadeId: "uSemLoja" }, { organizacaoId: "o1", unidadeId: "uParada" }];
    const modulosDe = async (_o, u) => (u === "uSemModulo" ? ["ifood"] : ["checklist_operacional"]);
    const ifoodRepo = repoIfood({
      obterConexaoViva: async ({ unidadeId }) => (unidadeId === "uSemLoja" ? null : { id: "c", merchant_id: "m", status: "ativa" }),
      obterObservabilidadeOrder: async ({ unidadeId }) => (unidadeId === "uParada" ? { ...vivo, lease: { atualizadoEm: "2026-11-02T10:00:00Z", leaseAte: "2026-11-02T10:01:00Z" } } : vivo),
    });
    const r = await unidadesComIntegracaoViva(un, { agora: () => AGORA, deps: { modulosDe, ifoodRepo } });
    assert.deepEqual(r.elegiveis.map((u) => u.unidadeId), ["uOK"]);
    assert.deepEqual(Object.fromEntries(r.recusadas.map((u) => [u.unidadeId, u.motivo])), { uSemModulo: MOTIVO.SEM_MODULO, uSemLoja: MOTIVO.INTEGRACAO_NAO_ATIVADA, uParada: MOTIVO.INTEGRACAO_DESCONECTADA });
  });
});

describe("preservação do D-1 do Dashboard iFood e pureza", () => {
  test("os módulos novos não importam banco, provider, Baileys, fila do D-1 nem cotas", () => {
    for (const f of ["src/modules/checklist-operacional/checklistOperacional.semanal.js", "src/modules/notificacoes/notificacoes.relatorios.js", "src/modules/notificacoes/notificacoes.relatorios.integracao.js"]) {
      const src = readFileSync(path.join(RAIZ, f), "utf8");
      assert.doesNotMatch(src, /^import .*(supabase|whatsapp\.service|provider|baileys|fila\.repo|alertas\.service|comunicacao\.policy)/im, f);
    }
  });
  test("a categoria do D-1 (dashboard_ifood_d1 / pendencia_d1) não aparece nos módulos novos", () => {
    for (const f of ["src/modules/checklist-operacional/checklistOperacional.semanal.js", "src/modules/notificacoes/notificacoes.relatorios.js", "src/modules/notificacoes/notificacoes.relatorios.integracao.js"]) {
      assert.doesNotMatch(readFileSync(path.join(RAIZ, f), "utf8"), /pendencia_d1|dashboard_ifood_d1/, f);
    }
  });
});
