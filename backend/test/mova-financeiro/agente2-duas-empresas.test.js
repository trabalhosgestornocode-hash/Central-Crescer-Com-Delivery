// 23/11/2026 — Entregadores nas DUAS empresas (Açaí × Subway): rotina independente por unidade, o MESMO entregador em ambas,
// nota fiscal vinculada à obrigação da empresa certa e aviso só no grupo da gerência da própria unidade.
// Financeiro v2 REAL em memória (fechamento oficial, conta a pagar, anexo), banco do MOVA no PostgreSQL local isolado, IA
// simulada (extrator). "Açaí" = ALFA (organização ORG) e "Subway" = XIS (OUTRA organização, ORG_X). Tudo sintético; nada sai
// para o WhatsApp (as respostas ficam em mova.resposta).
import assert from "node:assert/strict";
import { after } from "node:test";
import { ACAO, criarCofreMemoria, criarConcessoesMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { TODAS, ctx } from "../financeiro-v2/helpers/cenario.js";
import { AUTOMACAO, criarMova, criarPortaOperacional, instalarConfiguracao, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, CONFIG, DUAS_EMPRESAS, ESCOPOS, FIN, FINANCEIRO, GRUPO, GRUPO_X, ORG, ORG_X, XIS, base, gw, t } from "./helpers/operacao.js";
import { criarBancoMova, descartarBancoMova } from "./helpers/banco.js";
import { sqlReenfileirarFalhas } from "../../scripts/mova/reenfileirarFalhas.mjs";

const ANTIGA = "2026-10-26", SEG = "2026-11-02";
const SEGUNDA_14H = "2026-11-09T17:00:00.000Z"; // 14:00 em Brasília/Fortaleza
const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000c2";
const CARLOS = "5500000000311@s.whatsapp.net"; // trabalha nas DUAS empresas (mesmo número)
const ANA = "5500000000312@s.whatsapp.net"; // só Açaí
const BIA = "5500000000313@s.whatsapp.net"; // só Subway
const CNPJ_ACAI = "11222333000181", CNPJ_SUBWAY = "44555666000199";
const PDF = (x) => `%PDF-1.4\n% nota sintetica ${x}\n%%EOF\n`;

const somar = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const entrega = (id, chave, nome, data, centavos) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: chave, entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false });
// Pedidos de cada unidade (a conexão Foody é compartilhada, mas cada pedido pertence à sua unidade).
const PEDIDOS = {
  [ALFA]: (i) => [entrega(`a1-${i}`, "carlos", "Carlos Sintético", somar(i, 0), 700), entrega(`a2-${i}`, "carlos", "Carlos Sintético", somar(i, 3), 800), entrega(`a3-${i}`, "ana", "Ana Sintética", somar(i, 2), 900)],
  [XIS]: (i) => [entrega(`x1-${i}`, "carlos", "Carlos Sintético", somar(i, 1), 1100), entrega(`x2-${i}`, "carlos", "Carlos Sintético", somar(i, 4), 1200), entrega(`x3-${i}`, "bia", "Bia Sintética", somar(i, 5), 1000)],
};
const fonte = { apurar: async (p) => ({ disponivel: true, dias: Array.from({ length: 7 }, (_, k) => ({ data: somar(p.inicio, k), fonte: "foody", provisorio: false, aberto: false, triagem: 0 })), entregas: PEDIDOS[p.unidadeId](p.inicio) }) };

const UNIDADES = [
  { organizacaoId: ORG, unidadeId: ALFA, nome: "Açaí Sintético Saci", empresa: "Açaí Sintético Ltda", apelidos: ["acai"], documentos: [CNPJ_ACAI], fontes: CONFIG.unidades[0].fontes },
  { organizacaoId: ORG_X, unidadeId: XIS, nome: "Subway Sintético Saci", empresa: "Subway Sintética Ltda", apelidos: ["subway"], documentos: [CNPJ_SUBWAY], fontes: CONFIG.unidades[0].fontes },
];
const GRUPOS = [
  { grupoId: GRUPO, unidades: [ALFA], acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }] },
  { grupoId: GRUPO_X, unidades: [XIS], acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ ids: [DUAS_EMPRESAS], perfil: "FINANCEIRO" }] },
];
const ENTREGADORES = [
  { unidadeId: ALFA, chave: "carlos", telefoneE164: "+5500000000311", privado: CARLOS, nome: "Carlos Sintético" },
  { unidadeId: XIS, chave: "carlos", telefoneE164: "+5500000000311", privado: CARLOS, nome: "Carlos Sintético" },
  { unidadeId: ALFA, chave: "ana", telefoneE164: "+5500000000312", privado: ANA, nome: "Ana Sintética" },
  { unidadeId: XIS, chave: "bia", telefoneE164: "+5500000000313", privado: BIA, nome: "Bia Sintética" },
];
// Leitura da NFS-e pela IA (simulada): só o que importa para a escolha e a conferência.
const NOTA = (x = {}) => base({ tipoDocumento: "NOTA_FISCAL", intencao: "OUTRA", valorCentavos: 1500, competencia: "2026-11", dataEmissao: "2026-11-09", favorecido: "Carlos Sintético",
  pagador: null, documentoDestinatario: null, identificadorDocumento: "1", confianca: "ALTA", ...x });

const criados = [];
after(async () => { for (const b of criados.splice(0)) await descartarBancoMova(b).catch(() => {}); });

async function cenario({ avisosNoGrupo = {}, semGrupoSubway = false, leitura = () => NOTA(), antigaComNota = false } = {}) {
  const estado = { agora: SEGUNDA_14H };
  const relogio = () => new Date(estado.agora);
  const cofre = criarCofreMemoria();
  const real = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS, relogio, cofre, entregadores: { fonte, inicioDaOperacao: ANTIGA, cofreDeNotas: cofre } });
  const adm = { [ALFA]: ctx(ORG, ALFA, TODAS, "eeeeeeee-0000-4000-8000-000000000001"), [XIS]: ctx(ORG_X, XIS, TODAS, "eeeeeeee-0000-4000-8000-000000000001") };
  for (const [u, modelo] of [[ALFA, "ACAITERIA"], [XIS, "ACAITERIA"]]) {
    await real.implantarPlanoDeContas(adm[u], { modelo });
    for (const s of [ANTIGA, SEG]) await real.fecharSemanaDeEntregadores(adm[u], { inicio: s }); // a antiga também fechada: nunca é reenviada
  }
  // Semana antiga já com a nota entregue (Financeiro, sem o MOVA): a nova nota só pode ser da semana pendente.
  if (antigaComNota) for (const u of [ALFA, XIS]) for (const chave of ["carlos", u === ALFA ? "ana" : "bia"])
    await real.anexarDocumentoDoEntregador(adm[u], { inicio: ANTIGA, entregador: chave, arquivo: { conteudo: Buffer.from(PDF(`antiga-${u}-${chave}`)), nome: "nota.pdf", tipoMime: "application/pdf" } });
  const chamadas = [];
  const nucleo = Object.fromEntries(Object.entries(real).map(([nome, op]) => [nome, typeof op !== "function" ? op : async (cx, ...a) => { chamadas.push({ nome, unidadeId: cx?.unidadeId, organizacaoId: cx?.organizacaoId }); return op(cx, ...a); }]));
  const banco = await criarBancoMova();
  criados.push(banco);
  const config = { ...CONFIG, unidades: UNIDADES, gruposAutorizados: semGrupoSubway ? [GRUPOS[0]] : GRUPOS, entregadores: ENTREGADORES };
  await instalarConfiguracao(banco.pool, validarConfiguracao(config));
  const leituras = [];
  const extrator = { async extrair(e) { leituras.push(e); return leitura(e); } };
  const concessoes = criarConcessoesMemoria([ALFA, XIS].map((u) => ({ organizacaoId: u === ALFA ? ORG : ORG_X, usuarioId: OPERADOR, unidadeId: u, acoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO] })));
  const porta = criarPortaOperacional({ nucleo, financeiro: FINANCEIRO, identidade: OPERADOR, identidadeLeitura: CONFIG.identidadeServico.usuarioId, concessoes });
  const mova = criarMova({ configuracao: config, nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool: banco.pool, relogio, comandosDeterministicos: true, extrator, entregadores: true, operacional: porta, avisosNoGrupo });
  const enviar = async (p) => { const r = await mova.receptor.receber(p); await mova.receptor.trabalhar(); return r; };
  const saida = async () => (await banco.pool.query("select grupo_jid as destino, texto from mova.resposta order by seq")).rows;
  const ultima = async () => (await mova.armazenamento.historico.todos()).at(-1);
  const fechamento = (u, chave, inicio = SEG) => real.detalharFechamentoDoEntregador(adm[u], { inicio, entregador: chave });
  const contas = async (u) => (await real.consultarContasAPagar(adm[u], { pagina: 1, tamanho: 100 })).itens;
  const anexos = () => chamadas.filter((c) => c.nome === "anexarDocumentoDoEntregador");
  const ligar = async (nomes, unidades = [ALFA, XIS]) => { for (const u of unidades) for (const nome of nomes) await mova.armazenamento.automacoes.definir({ nome, organizacaoId: u === ALFA ? ORG : ORG_X, unidadeId: u, ativa: true, horario: "14:00" }); };
  const nota = (texto, x) => { const g = gw({ texto, de: CARLOS, grupo: CARLOS, doc: PDF(x) }); return g; };
  // Simula o RETORNO do Gateway para as mensagens privadas na fila: aceitas (ENVIADA) ou recusadas (FALHOU) por destino.
  const gateway = async ({ recusar = [] } = {}) => {
    const r = (await banco.pool.query("select id, grupo_jid from mova.resposta where estado = 'PENDENTE' and grupo_jid like '%@s.whatsapp.net'")).rows;
    for (const x of r) recusar.includes(x.grupo_jid) ? await mova.armazenamento.saida.marcarFalhaDeEnvio(x.id, "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED", { final: true }) : await mova.armazenamento.saida.marcarEnviada(x.id, `prov-${x.id}`);
    return r.length;
  };
  return { estado, real, mova, enviar, saida, ultima, fechamento, contas, anexos, ligar, nota, leituras, banco, gateway };
}

t("H1 segunda 14h: Açaí e Subway enviam cada uma o SEU demonstrativo; o entregador das duas recebe DOIS, separados; nada da semana antiga; aviso só no grupo da própria unidade", async () => {
  const s = await cenario();
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "sem automação ligada nada sai");
  await s.ligar([AUTOMACAO.SEMANAL, AUTOMACAO.AVISO_GRUPO]);
  const r = await s.mova.entregadores.rotina();
  assert.equal(r.semanais, 4, "Carlos×2 (uma por empresa), Ana (Açaí) e Bia (Subway)");
  assert.equal(r.avisos, 0, "nenhum aviso antes do retorno do WhatsApp");
  assert.equal(await s.gateway({ recusar: [BIA] }), 4, "o Gateway aceita Carlos×2 e Ana; recusa Bia");
  const r2 = await s.mova.entregadores.rotina();
  assert.deepEqual([r2.semanais, r2.avisos], [0, 4], "um aviso por entregador, cada um no grupo da sua unidade (3 enviados + 1 falha)");
  const out = await s.saida();
  const doCarlos = out.filter((x) => x.destino === CARLOS).map((x) => x.texto);
  assert.equal(doCarlos.length, 2);
  const acai = doCarlos.find((x) => /Açaí Sintético Ltda/.test(x)), subway = doCarlos.find((x) => /Subway Sintética Ltda/.test(x));
  assert.match(acai, /02\/11\/2026 a 08\/11\/2026/);
  assert.match(acai, /2 entrega\(s\) — R\$ 15,00/);
  assert.doesNotMatch(acai, /23,00|Subway/, "nunca soma nem cita a outra empresa");
  assert.match(subway, /2 entrega\(s\) — R\$ 23,00/);
  assert.doesNotMatch(subway, /15,00|Açaí/);
  assert.ok(!out.some((x) => /26\/10\/2026/.test(x.texto)), "a semana antiga (também fechada) não é enviada");
  const aviso = (x) => !/^📋/.test(x.texto); // o relatório da semana é conferido à parte
  const noGrupoAcai = out.filter((x) => x.destino === GRUPO && aviso(x)).map((x) => x.texto), noGrupoSubway = out.filter((x) => x.destino === GRUPO_X && aviso(x)).map((x) => x.texto);
  assert.equal(out.filter((x) => x.destino === GRUPO && !aviso(x)).length, 1, "Açaí: todos aceitos ⇒ relatório no próprio grupo");
  assert.equal(out.filter((x) => x.destino === GRUPO_X && !aviso(x)).length, 0, "Subway: Bia recusada ⇒ sem relatório");
  assert.equal(noGrupoAcai.length, 2);
  assert.ok(noGrupoAcai.every((x) => /^📨 Açaí Sintético Ltda — Demonstrativo enviado para (Carlos|Ana), referente à semana de 02\/11\/2026 a 08\/11\/2026 \(aceito pelo WhatsApp\)\. Aguardando nota fiscal\.$/.test(x)));
  assert.equal(noGrupoSubway.length, 2);
  assert.ok(noGrupoSubway.some((x) => /^📨 Subway Sintética Ltda — Demonstrativo enviado para Carlos/.test(x)));
  assert.ok(noGrupoSubway.some((x) => /^⚠️ Subway Sintética Ltda — O demonstrativo de Bia .*NÃO foi entregue pelo WhatsApp/.test(x)), "falha também é avisada");
  assert.ok(![...noGrupoAcai, ...noGrupoSubway].some((x) => /R\$|\d+,\d{2}/.test(x)), "aviso no grupo sem valores");
  const again = await s.mova.entregadores.rotina();
  assert.deepEqual([again.semanais, again.avisos], [0, 0], "idempotente: nada repetido");
  const envios = await s.mova.armazenamento.enviosEntregador.listar?.({ organizacaoId: ORG_X, unidadeId: XIS });
  if (envios) assert.ok(envios.every((e) => e.semanaInicio === SEG));
});

t("H2 nota com legenda 'subway' vai para a obrigação da SUBWAY (anexo oficial na unidade dela); a do Açaí continua aguardando; aviso só no grupo da Subway", async () => {
  const s = await cenario({ leitura: () => NOTA({ valorCentavos: 2300, pagador: "Subway Sintética Ltda" }) , antigaComNota: true });
  await s.ligar([AUTOMACAO.AVISO_GRUPO]);
  await s.enviar(s.nota("nota da subway", "s1"));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo, h.unidadeId], ["EXECUTADO", "NOTA_ANEXADA", XIS]);
  assert.deepEqual(s.anexos().map((c) => [c.organizacaoId, c.unidadeId]), [[ORG_X, XIS]]);
  assert.equal((await s.fechamento(XIS, "carlos")).situacaoDocumental, "NF_RECEBIDA");
  assert.equal((await s.fechamento(ALFA, "carlos")).situacaoDocumental, "AGUARDANDO_NF", "a nota da Subway não toca o Açaí");
  const out = await s.saida();
  assert.ok(out.some((x) => x.destino === GRUPO_X && /^📄 Subway Sintética Ltda — Nota fiscal recebida de Carlos, semana 02\/11\/2026 a 08\/11\/2026\. Conferência concluída: valor correspondente ao fechamento\.$/.test(x.texto)));
  assert.ok(!out.some((x) => x.destino === GRUPO), "nada no grupo do Açaí");
});

t("H3 nota SEM legenda: a empresa sai do TOMADOR lido (CNPJ do Açaí) — vinculada ao Açaí, nunca 'por padrão'", async () => {
  const s = await cenario({ leitura: () => NOTA({ valorCentavos: 1500, documentoDestinatario: "11.222.333/0001-81" }) , antigaComNota: true });
  await s.enviar(s.nota(null, "a1"));
  const h = await s.ultima();
  assert.deepEqual([h.motivo, h.unidadeId], ["NOTA_ANEXADA", ALFA]);
  assert.equal((await s.fechamento(ALFA, "carlos")).situacaoDocumental, "NF_RECEBIDA");
  assert.equal((await s.fechamento(XIS, "carlos")).situacaoDocumental, "AGUARDANDO_NF");
  assert.equal(s.leituras.length, 1, "uma leitura só (reaproveitada na conferência)");
});

t("H4 sem evidência da empresa (sem legenda, tomador e valor não decidem): PERGUNTA ao entregador; nada é anexado nem registrado em nenhuma das duas", async () => {
  const s = await cenario({ leitura: () => NOTA({ valorCentavos: 9999 }) , antigaComNota: true });
  await s.enviar(s.nota("segue a nota", "x1"));
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["BLOQUEADO", "NOTA_SEM_EMPRESA_IDENTIFICADA"]);
  const [r] = (await s.saida()).filter((x) => x.destino === CARLOS);
  assert.match(r.texto, /mais de uma empresa: Açaí Sintético Ltda \(semana 02\/11\/2026, R\$ 15,00\) e Subway Sintética Ltda \(semana 02\/11\/2026, R\$ 23,00\)/);
  assert.match(r.texto, /escrevendo na mensagem de qual empresa/);
  assert.equal(s.anexos().length, 0);
  for (const [o, u] of [[ORG, ALFA], [ORG_X, XIS]]) assert.equal((await s.mova.armazenamento.notasEntregador.listar({ organizacaoId: o, unidadeId: u })).length, 0);
  // o entregador responde com a legenda: agora vai para a empresa citada
  await s.enviar(s.nota("é do açaí", "x1"));
  assert.deepEqual([(await s.ultima()).motivo, (await s.ultima()).unidadeId], ["NOTA_ANEXADA", ALFA]);
});

t("H5 nota repetida não cria nova obrigação nem novo anexo; divergente vai para conferência (nunca liberada); nenhuma baixa/pagamento", async () => {
  const s = await cenario({ leitura: () => NOTA({ valorCentavos: 2000 }) , antigaComNota: true }); // valor diferente dos dois fechamentos
  await s.ligar([AUTOMACAO.AVISO_GRUPO]);
  const contasAntes = [(await s.contas(ALFA)).length, (await s.contas(XIS)).length];
  await s.enviar(s.nota("nota subway", "d1"));
  assert.deepEqual([(await s.ultima()).motivo, (await s.ultima()).unidadeId], ["NOTA_ANEXADA", XIS]);
  const [n] = await s.mova.armazenamento.notasEntregador.listar({ organizacaoId: ORG_X, unidadeId: XIS });
  assert.equal(n.conferencia, "DIVERGENTE");
  const out = await s.saida();
  assert.match(out.filter((x) => x.destino === CARLOS).at(-1).texto, /divergência: valor diferente do fechamento/);
  assert.ok(out.some((x) => x.destino === GRUPO_X && /Conferência com divergência: pendente de revisão do financeiro\./.test(x.texto)));
  assert.ok(!out.some((x) => x.destino === GRUPO_X && /2\.000|20,00/.test(x.texto)), "sem valores no grupo");
  await s.enviar(s.nota("nota subway", "d1")); // o MESMO arquivo de novo
  assert.deepEqual([(await s.ultima()).decisao, (await s.ultima()).motivo], ["DUPLICADO", "NOTA_JA_RECEBIDA"]);
  assert.equal(s.anexos().length, 1);
  assert.deepEqual([(await s.contas(ALFA)).length, (await s.contas(XIS)).length], contasAntes, "nenhuma conta a pagar nova");
  const f = await s.fechamento(XIS, "carlos");
  assert.notEqual(f.situacaoDocumental, "LIBERADO_PAGAMENTO");
  assert.notEqual(f.situacaoPagamento, "PAGO", "receber a nota não paga nada");
});

t("H6 Subway SEM grupo da gerência: os envios privados da Subway saem mesmo assim; o aviso dela fica PENDENTE (auditoria) e nunca vai para o grupo do Açaí", async () => {
  const s = await cenario({ semGrupoSubway: true });
  await s.ligar([AUTOMACAO.SEMANAL, AUTOMACAO.AVISO_GRUPO]);
  const r = await s.mova.entregadores.rotina();
  assert.equal(r.semanais, 4);
  await s.gateway();
  await s.mova.entregadores.rotina();
  await s.mova.entregadores.rotina(); // a pendência é registrada UMA vez, não a cada passada
  const out = await s.saida();
  assert.ok(out.some((x) => x.destino === BIA && /Subway Sintética Ltda/.test(x.texto)), "Bia (só Subway) recebeu");
  assert.equal(out.filter((x) => x.destino === CARLOS).length, 2);
  assert.ok(!out.some((x) => x.destino === GRUPO && /Subway/.test(x.texto)), "aviso da Subway nunca no grupo do Açaí");
  assert.equal(out.filter((x) => x.destino === GRUPO && !/^📋/.test(x.texto)).length, 2, "o Açaí avisa no próprio grupo (Carlos e Ana)");
  assert.ok(!out.some((x) => x.destino === GRUPO && /^📋/.test(x.texto) && /Subway/.test(x.texto)), "relatório do Açaí sem a Subway");
  const pend = (await s.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'AVISO_GRUPO_PENDENTE'")).rows[0].n;
  assert.equal(pend, 2, "Carlos e Bia na Subway: avisos pendentes de identificação do grupo");
});

t("H6b 23/11: o proprietário indica que a Subway COMPARTILHA o grupo da gerência do Açaí (MOVA_AVISOS_NO_GRUPO): os avisos pendentes da Subway saem nesse grupo, identificados, uma vez cada", async () => {
  const s = await cenario({ semGrupoSubway: true, avisosNoGrupo: { [XIS]: GRUPO, "00000000-0000-4000-8000-000000000999": "123@g.us" } });
  await s.ligar([AUTOMACAO.SEMANAL, AUTOMACAO.AVISO_GRUPO]);
  await s.mova.entregadores.rotina();
  await s.gateway();
  await s.mova.entregadores.rotina();
  await s.mova.entregadores.rotina(); // repetir não duplica
  const noGrupo = (await s.saida()).filter((x) => x.destino === GRUPO && !/^📋/.test(x.texto)).map((x) => x.texto);
  assert.equal(noGrupo.length, 4, "2 do Açaí + 2 da Subway");
  assert.equal(noGrupo.filter((x) => /Subway Sintética Ltda/.test(x)).length, 2, "cada aviso da Subway identifica a empresa");
  assert.equal(noGrupo.filter((x) => /Açaí Sintético Ltda/.test(x)).length, 2);
  const pend = (await s.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'AVISO_GRUPO_PENDENTE'")).rows[0].n;
  assert.equal(pend, 0);
  // Grupo indicado que NÃO está autorizado ⇒ continua pendente (nunca um grupo qualquer).
  const s2 = await cenario({ semGrupoSubway: true, avisosNoGrupo: { [XIS]: "999999999999@g.us" } });
  await s2.ligar([AUTOMACAO.SEMANAL, AUTOMACAO.AVISO_GRUPO]);
  await s2.mova.entregadores.rotina(); await s2.gateway(); await s2.mova.entregadores.rotina();
  assert.ok(!(await s2.saida()).some((x) => x.destino !== GRUPO && /@g\.us$/.test(x.destino)));
  assert.equal((await s2.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'AVISO_GRUPO_PENDENTE'")).rows[0].n, 2);
});

t("H6c 23/11: RELATÓRIO da semana no grupo da gerência só quando TODOS os demonstrativos foram aceitos; grupo compartilhado ⇒ as duas empresas juntas, com totais; uma vez só", async () => {
  const s = await cenario({ semGrupoSubway: true, avisosNoGrupo: { [XIS]: GRUPO } });
  await s.ligar([AUTOMACAO.SEMANAL, AUTOMACAO.AVISO_GRUPO]);
  await s.mova.entregadores.rotina();
  const relatorios = async () => (await s.saida()).filter((x) => x.destino === GRUPO && /^📋/.test(x.texto)).map((x) => x.texto);
  assert.equal((await relatorios()).length, 0, "nada antes do retorno do WhatsApp");
  await s.gateway();
  await s.mova.entregadores.rotina();
  await s.mova.entregadores.rotina();
  const [r, ...resto] = await relatorios();
  assert.equal(resto.length, 0, "um relatório só");
  assert.match(r, /Entregadores — semana 02\/11\/2026 a 08\/11\/2026/);
  assert.match(r, /\*Açaí Sintético Ltda\*[\s\S]*R\$ 15,00[\s\S]*\*Total Açaí Sintético Ltda: R\$/);
  assert.match(r, /\*Subway Sintética Ltda\*[\s\S]*R\$ 23,00[\s\S]*\*Total Subway Sintética Ltda: R\$/);
  assert.match(r, /Total geral: R\$/);
  assert.match(r, /calendário do sistema, com vencimento em \*\d\d\/\d\d\/\d{4}/);
  assert.ok(r.indexOf("Açaí Sintético") < r.indexOf("Subway Sintética"));
});

t("H6d um demonstrativo RECUSADO pelo WhatsApp segura o relatório da semana (não é 'todos enviados')", async () => {
  const s = await cenario();
  await s.ligar([AUTOMACAO.SEMANAL, AUTOMACAO.AVISO_GRUPO]);
  await s.mova.entregadores.rotina();
  await s.gateway({ recusar: [CARLOS] });
  await s.mova.entregadores.rotina();
  const out = await s.saida();
  assert.ok(!out.some((x) => /^📋/.test(x.texto)), "sem relatório");
});

t("H7 entregador pergunta no privado: vê os DOIS fechamentos em seções separadas (empresa e período), sem somar", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: "quanto deu?", de: CARLOS, grupo: CARLOS }));
  const [r] = (await s.saida()).filter((x) => x.destino === CARLOS);
  const [a, b] = r.texto.split("— — —");
  assert.match(a, /Açaí Sintético Ltda[\s\S]*R\$ 15,00/);
  assert.match(b, /Subway Sintética Ltda[\s\S]*R\$ 23,00/);
  assert.doesNotMatch(r.texto, /38,00/, "nunca somados");
});

t("H8 caso de 23/11: envio feito ANTES da 0016 (sem vínculo) recusado pelo Gateway e depois reenfileirado — avisa a falha uma vez e, aceito, o envio uma vez; semana antiga nunca", async () => {
  const s = await cenario();
  await s.ligar([AUTOMACAO.SEMANAL], [ALFA]);
  await s.mova.entregadores.rotina();
  await s.banco.pool.query("update mova.entregador_envio set resposta_id = null"); // como em produção (código anterior)
  await s.gateway({ recusar: [CARLOS, ANA] });
  await s.ligar([AUTOMACAO.AVISO_GRUPO], [ALFA]);
  assert.equal((await s.mova.entregadores.rotina()).avisos, 2, "as duas falhas avisadas");
  assert.equal((await s.mova.entregadores.rotina()).avisos, 0, "uma vez só");
  // reenfileiradas (kit de reenvio, depois de corrigir a lista do Gateway) e aceitas
  const kit = sqlReenfileirarFalhas({ erro: "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED", de: "2000-01-01T00:00:00Z", ate: "2000-01-01T12:00:00Z", esperadas: 2, ator: "teste", motivo: "GATEWAY_SEM_PRIVADOS" });
  const c = await s.banco.pool.connect();
  try { await assert.rejects(c.query(kit), /esperadas 2 mensagens, encontradas 0/, "fora da janela: nada é feito"); await c.query("rollback"); } finally { c.release(); }
  const { rows: [j] } = await s.banco.pool.query("select min(criada_em) - interval '1 minute' de, max(criada_em) + interval '1 minute' ate from mova.resposta where estado = 'FALHOU'");
  await s.banco.pool.query(sqlReenfileirarFalhas({ erro: "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED", de: j.de.toISOString(), ate: j.ate.toISOString(), esperadas: 2, ator: "teste", motivo: "GATEWAY_SEM_PRIVADOS" }));
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'RESPOSTAS_REENFILEIRADAS'")).rows[0].n, 1);
  await s.gateway();
  assert.equal((await s.mova.entregadores.rotina()).avisos, 2, "agora os dois 'enviado'");
  const g = (await s.saida()).filter((x) => x.destino === GRUPO).map((x) => x.texto);
  assert.equal(g.filter((x) => x.startsWith("⚠️")).length, 2);
  assert.equal(g.filter((x) => x.startsWith("📨")).length, 2);
  assert.equal((await s.saida()).filter((x) => x.destino === CARLOS || x.destino === ANA).length, 2, "nenhum demonstrativo duplicado");
  assert.ok(!g.some((x) => /26\/10/.test(x)));
});
