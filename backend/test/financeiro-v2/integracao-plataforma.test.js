// Execução 09 — adaptador da sessão da PLATAFORMA → contexto do Financeiro v2, e autoridade de provisionamento apoiada na
// plataforma. Identidades e dados SINTÉTICOS. A sessão tem exatamente o formato que requireAuth + requireContexto montam
// (`req.user`, `req.tenant`, `req.acesso`); o teste "contrato" confere esse formato no código da plataforma.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACAO, CODIGO, criarConcessoesMemoria, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { ACOES_COM_MFA_RECENTE, MOTIVO, avaliarAutenticacao, criarAdaptadorDaPlataforma, criarAutoridadeDaPlataforma } from "../../src/modules/financeiro-v2/integracao/plataforma.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, montar } from "./helpers/cenario.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const backend = resolve(aqui, "..", "..");
const CONTA = "dddddddd-0000-4000-8000-000000000001";
const PESSOA = "dddddddd-0000-4000-8000-0000000000f1";
const CONTA_ADMIN = "dddddddd-0000-4000-8000-000000000002";
const PESSOA_ADMIN = "dddddddd-0000-4000-8000-0000000000f2";
const CONTA_COMPARTILHADA = "dddddddd-0000-4000-8000-000000000003";
const PESSOA_COMPARTILHADA = "dddddddd-0000-4000-8000-0000000000f3";
const agoraMs = AGORA.getTime();
const relogio = () => AGORA;

/** Sessão no formato da plataforma (o que requireAuth + requireContexto deixam em req.user/req.tenant/req.acesso). */
function sessao({ conta = CONTA, pessoa = PESSOA, org = ORG_A, uni = UNI_A, aal = "aal1", mfaEm = null, papel = "organization_admin", ...extra } = {}) {
  return {
    user: { id: conta, email: "pessoa@exemplo.invalid", nome: "Pessoa Sintética", ativo: true, senhaProvisoria: false, superadmin: false, painelAdministrativo: false, aal, amr: [], mfaEm, mfaCadastrada: aal === "aal2", ...(extra.user ?? {}) },
    tenant: { organizacaoId: org, unidadeId: uni, ...(extra.tenant ?? {}) },
    acesso: {
      sessionId: "sessao-sintetica-1", expiraEm: new Date(agoraMs + 4 * 3600_000).toISOString(), perfilId: pessoa, papel, permissoes: ["*"], modulos: ["gestao_financeira"],
      impersonadoPor: null, impersonando: false, empresa: { id: org, nome: "Empresa Sintética", status: "ativa" }, unidade: uni ? { id: uni, nome: "Unidade Sintética" } : null, ...(extra.acesso ?? {}),
    },
  };
}

function portas({ liberadas = [[ORG_A, UNI_A], [ORG_A, UNI_A2]], empresas = [ORG_A], concessoes = [{ organizacaoId: ORG_A, usuarioId: PESSOA, unidadeId: UNI_A, acoes: [ACAO.VER, ACAO.REGISTRAR, ACAO.HOMOLOGAR] }], unidades = { [PESSOA]: [UNI_A, UNI_A2], [PESSOA_ADMIN]: [UNI_A, UNI_A2], [PESSOA_COMPARTILHADA]: [UNI_A] }, perfisPorConta = { [CONTA]: 1, [CONTA_ADMIN]: 1, [CONTA_COMPARTILHADA]: 3 } } = {}) {
  const estado = { liberadas: new Set(liberadas.map(([o, u]) => `${o}|${u}`)), empresas: new Set(empresas), concessoes: [...concessoes], leituras: 0 };
  return {
    estado,
    liberacoes: { async consultar({ organizacaoId, unidadeId }) { estado.leituras += 1; return { empresa: estado.empresas.has(organizacaoId), unidade: estado.liberadas.has(`${organizacaoId}|${unidadeId}`) }; } },
    vinculos: {
      async unidadesDoPerfil({ perfilId, organizacaoId }) { return organizacaoId === ORG_A ? (unidades[perfilId] ?? []) : []; },
      async perfisAtivosDaConta({ contaId }) { return perfisPorConta[contaId] ?? 0; },
    },
    concessoes: { listar: (q) => criarConcessoesMemoria(estado.concessoes).listar(q) },
  };
}
const adaptador = (p = portas(), extra = {}) => criarAdaptadorDaPlataforma({ ...p, relogio, ...extra });
const recusa = async (promessa, motivo) => assert.rejects(promessa, (e) => { assert.equal(e?.detalhes?.motivo, motivo, `${e?.codigo} ${e?.detalhes?.motivo}: ${e?.message}`); return true; });

test("1, 9 — sessão válida da plataforma vira contexto do v2 com o ATOR = pessoa operacional; papel/superadmin/permissões antigas não concedem nada", async () => {
  const r = await adaptador().contexto(sessao());
  assert.deepEqual([r.contexto.organizacaoId, r.contexto.unidadeId, r.contexto.usuarioId], [ORG_A, UNI_A, PESSOA]);
  assert.deepEqual([...r.contexto.permissoes].sort(), [ACAO.HOMOLOGAR, ACAO.REGISTRAR, ACAO.VER].sort(), "só o que a concessão do v2 diz");
  assert.deepEqual(r.ator, { perfilId: PESSOA, contaId: CONTA });
  assert.equal(r.origem.tipo, "PLATAFORMA");
  // 9 — administrador da empresa, superadmin, permissão "*" e módulo financeiro antigo: sem concessão do v2, nada.
  const semConcessao = portas({ concessoes: [] });
  await recusa(adaptador(semConcessao).contexto(sessao({ user: { superadmin: true, painelAdministrativo: true } })), MOTIVO.SEM_CONCESSAO);
});

test("2, 23 — sessão expirada, incompleta, conta inativa, senha provisória; falha de leitura = falha fechada (nada liberado)", async () => {
  await recusa(adaptador().contexto(sessao({ acesso: { expiraEm: new Date(agoraMs - 1).toISOString() } })), MOTIVO.SESSAO_EXPIRADA);
  await recusa(adaptador().contexto(sessao({ acesso: { expiraEm: null } })), MOTIVO.SESSAO_EXPIRADA);
  await recusa(adaptador().contexto({ user: { id: CONTA } }), MOTIVO.SEM_SESSAO);
  await recusa(adaptador().contexto(null), MOTIVO.SEM_SESSAO);
  await recusa(adaptador().contexto(sessao({ user: { ativo: false } })), MOTIVO.CONTA_INATIVA);
  await recusa(adaptador().contexto(sessao({ user: { senhaProvisoria: true } })), MOTIVO.SENHA_PROVISORIA);
  const quebrada = portas();
  quebrada.liberacoes.consultar = async () => { throw new Error("banco fora do ar"); };
  await recusa(adaptador(quebrada).contexto(sessao()), MOTIVO.FALHA_FECHADA);
  assert.deepEqual(await adaptador(quebrada).disponibilidade(sessao()), { liberado: false, disponivel: false, operavel: false, motivo: MOTIVO.FALHA_FECHADA });
  const vinculosQuebrados = portas();
  vinculosQuebrados.vinculos.unidadesDoPerfil = async () => { throw new Error("x"); };
  await recusa(adaptador(vinculosQuebrados).contexto(sessao()), MOTIVO.FALHA_FECHADA);
});

test("3, 4, 5, 24 — sem concessão, empresa ou unidade sem liberação; ativação/desativação sintética por unidade vale na próxima operação", async () => {
  const p = portas({ concessoes: [] });
  await recusa(adaptador(p).contexto(sessao()), MOTIVO.SEM_CONCESSAO);
  assert.deepEqual(await adaptador(p).disponibilidade(sessao()), { liberado: true, disponivel: true, operavel: false, motivo: MOTIVO.SEM_CONCESSAO });
  await recusa(adaptador(portas({ empresas: [] })).contexto(sessao()), MOTIVO.EMPRESA_NAO_LIBERADA);
  await recusa(adaptador(portas({ liberadas: [[ORG_A, UNI_A2]] })).contexto(sessao()), MOTIVO.UNIDADE_NAO_LIBERADA);
  // empresa desligada derruba as unidades, mesmo que a unidade esteja marcada como liberada
  assert.equal((await adaptador(portas({ empresas: [] })).disponibilidade(sessao())).liberado, false);
  // 24 — liga e desliga
  const q = portas();
  const a = adaptador(q);
  assert.equal((await a.contexto(sessao())).contexto.unidadeId, UNI_A);
  q.estado.liberadas.delete(`${ORG_A}|${UNI_A}`);
  await recusa(a.contexto(sessao()), MOTIVO.UNIDADE_NAO_LIBERADA);
  assert.deepEqual(await a.disponibilidade(sessao()), { liberado: false, disponivel: false, operavel: false, motivo: MOTIVO.UNIDADE_NAO_LIBERADA });
  q.estado.liberadas.add(`${ORG_A}|${UNI_A}`);
  assert.equal((await a.disponibilidade(sessao())).operavel, true);
});

test("6, 7 — troca de unidade e contexto adulterado: a unidade é SEMPRE a da sessão; divergência, unidade fora dos vínculos e 'todas as unidades' são recusadas", async () => {
  const a = adaptador();
  // troca para A2 (nova sessão da plataforma): sem concessão lá → nada de A2; e nada de A vaza para a sessão de A2
  await recusa(a.contexto(sessao({ uni: UNI_A2 })), MOTIVO.SEM_CONCESSAO);
  assert.deepEqual((await a.unidadesOperaveis(sessao())).map((u) => u.unidadeId), [UNI_A]);
  // adulterações
  await recusa(a.contexto(sessao({ acesso: { empresa: { id: ORG_B } } })), MOTIVO.CONTEXTO_DIVERGENTE);
  await recusa(a.contexto(sessao({ acesso: { unidade: { id: UNI_A2 } } })), MOTIVO.CONTEXTO_DIVERGENTE);
  await recusa(a.contexto(sessao({ org: ORG_B, uni: UNI_B })), MOTIVO.EMPRESA_NAO_LIBERADA);
  const outra = portas({ liberadas: [[ORG_A, UNI_A], [ORG_A, UNI_A2]], unidades: { [PESSOA]: [UNI_A2] } });
  await recusa(adaptador(outra).contexto(sessao()), MOTIVO.UNIDADE_NAO_AUTORIZADA);
  await recusa(a.contexto(sessao({ uni: null })), MOTIVO.SEM_UNIDADE);
  await recusa(a.contexto(sessao({ acesso: { perfilId: null } })), MOTIVO.SEM_PERFIL);
  // a opção de chamada só aceita a ação: unidade "pedida" pelo cliente não existe no contrato
  const r = await a.contexto(sessao(), { acao: ACAO.VER, unidadeId: UNI_A2 });
  assert.equal(r.contexto.unidadeId, UNI_A);
});

test("8 — revogação da concessão vale na operação seguinte (nada fica em cache)", async () => {
  const p = portas();
  const a = adaptador(p);
  assert.ok((await a.contexto(sessao())).contexto.permissoes.includes(ACAO.VER));
  p.estado.concessoes.length = 0;
  await recusa(a.contexto(sessao()), MOTIVO.SEM_CONCESSAO);
  assert.ok(p.estado.leituras >= 2, "a liberação é relida a cada operação");
});

test("10 — MFA: ações sensíveis exigem segundo fator RECENTE comprovado pelo JWT; ver e registrar não", async () => {
  const a = adaptador();
  assert.equal((await a.contexto(sessao(), { acao: ACAO.VER })).autenticacao.mfaRecente, false);
  await recusa(a.contexto(sessao(), { acao: ACAO.HOMOLOGAR }), MOTIVO.MFA_REQUERIDA);
  await recusa(a.contexto(sessao({ aal: "aal2", mfaEm: agoraMs - 11 * 60_000 }), { acao: ACAO.HOMOLOGAR }), MOTIVO.REAUTENTICACAO_RECENTE);
  await recusa(a.contexto(sessao({ aal: "aal2", mfaEm: agoraMs + 5 * 60_000 }), { acao: ACAO.HOMOLOGAR }), MOTIVO.REAUTENTICACAO_RECENTE);
  await recusa(a.contexto(sessao({ aal: "aal2", mfaEm: null }), { acao: ACAO.HOMOLOGAR }), MOTIVO.REAUTENTICACAO_RECENTE);
  assert.equal((await a.contexto(sessao({ aal: "aal2", mfaEm: agoraMs - 60_000 }), { acao: ACAO.HOMOLOGAR })).autenticacao.mfaRecente, true);
  // nível declarado fora do formato não vale como aal2
  assert.equal(avaliarAutenticacao({ aal: "AAL2", mfaEm: agoraMs }, agoraMs).mfaRecente, false);
  assert.deepEqual([...ACOES_COM_MFA_RECENTE].sort(), [ACAO.CONCEDER, ACAO.HOMOLOGAR, ACAO.REABRIR, ACAO.REVOGAR].sort());
});

test("impersonação, perfil de exibição e conta compartilhada não operam o v2 (sem o bypass de suporte da plataforma)", async () => {
  const a = adaptador();
  await recusa(a.contexto(sessao({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN, perfilId: null } })), MOTIVO.IMPERSONACAO);
  await recusa(a.contexto(sessao({ papel: "display_operator" })), MOTIVO.PERFIL_DE_EXIBICAO);
  const compartilhada = portas({ concessoes: [{ organizacaoId: ORG_A, usuarioId: PESSOA_COMPARTILHADA, unidadeId: UNI_A, acoes: [ACAO.VER] }] });
  await recusa(adaptador(compartilhada).contexto(sessao({ conta: CONTA_COMPARTILHADA, pessoa: PESSOA_COMPARTILHADA })), MOTIVO.CONTA_COMPARTILHADA);
  // numa unidade NÃO liberada, a sessão de suporte segue com o financeiro de hoje (o v2 não "toma" a unidade)
  const naoLiberada = await adaptador(portas({ liberadas: [] })).disponibilidade(sessao({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN } }));
  assert.equal(naoLiberada.liberado, false);
  // numa unidade liberada, a mesma sessão vê "sem acesso" ao v2 (nunca os dois financeiros)
  const liberada = await a.disponibilidade(sessao({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN } }));
  assert.deepEqual([liberada.liberado, liberada.disponivel, liberada.motivo], [true, false, MOTIVO.IMPERSONACAO]);
});

// ------------------------------------------------------------------------------------------------ provisionamento
function administracao({ autoridades = { [CONTA_ADMIN]: "ADMIN_EMPRESA" }, contaDe = { [PESSOA]: CONTA, [PESSOA_ADMIN]: CONTA_ADMIN, [PESSOA_COMPARTILHADA]: CONTA_COMPARTILHADA } } = {}) {
  return {
    async autoridadeSobre({ contaId, organizacaoId }) { return organizacaoId === ORG_A && autoridades[contaId] ? { tipo: autoridades[contaId] } : null; },
    async contaDoPerfil({ perfilId }) { return contaDe[perfilId] ?? null; },
  };
}
const ATO = (extra = {}) => ({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA, acoes: [ACAO.VER, ACAO.CONCEDER, ACAO.REVOGAR], justificativa: "Administrador financeiro inicial da unidade, indicado pela gestão (sintético).", evidencia: "Ata sintética de designação", ...extra });
const atestante = (extra = {}) => sessao({ conta: CONTA_ADMIN, pessoa: PESSOA_ADMIN, aal: "aal2", mfaEm: agoraMs - 2 * 60_000, ...extra });

test("11, 12 — provisionamento: administrador da empresa com MFA recente atesta; a pessoa indicada recebe a concessão; o atestante não recebe nada", async () => {
  const m = montar();
  const autoridade = criarAutoridadeDaPlataforma({ administracao: administracao(), vinculos: portas().vinculos, relogio });
  const n = criarNucleoFinanceiro({ repositorio: m.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio, autoridadeDeProvisionamento: autoridade });
  const r = await n.provisionarAdministradorInicial({ ...ATO(), atestado: { sessao: atestante() } });
  assert.ok(r);
  const c = await criarAdaptadorDaPlataforma({ ...portas({ concessoes: [] }), relogio, concessoes: { listar: async ({ usuarioId }) => (usuarioId === PESSOA ? [{ unidadeId: UNI_A, acoes: [ACAO.VER, ACAO.CONCEDER, ACAO.REVOGAR] }] : []) } }).contexto(sessao());
  assert.equal(c.contexto.usuarioId, PESSOA);
  // o atestante NÃO ganha acesso financeiro por ter atestado
  const doAdmin = criarAdaptadorDaPlataforma({ ...portas({ concessoes: [] }), relogio });
  await recusa(doAdmin.contexto(atestante()), MOTIVO.SEM_CONCESSAO);
});

test("12 — autoconcessão, falta de MFA, de autoridade, conta compartilhada, impersonação e justificativa curta são recusadas; superadmin não é aceito por padrão", async () => {
  const verif = (ato, opcoes = {}) => criarAutoridadeDaPlataforma({ administracao: administracao(opcoes.adm), vinculos: portas().vinculos, relogio, ...(opcoes.tipos ? { tiposAceitos: opcoes.tipos } : {}) }).verificar(ato);
  assert.deepEqual(await verif({ ...ATO(), atestado: { sessao: atestante() } }), { ok: true, autoridadeId: CONTA_ADMIN, nivelAutenticacao: "aal2", tipo: "ADMIN_EMPRESA" });
  assert.equal((await verif({ ...ATO({ usuarioId: PESSOA_ADMIN }), atestado: { sessao: atestante() } })).motivo, "AUTOCONCESSAO");
  // outra pessoa da MESMA conta do atestante também é autoconcessão
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante() } }, { adm: { contaDe: { [PESSOA]: CONTA_ADMIN } } })).motivo, "AUTOCONCESSAO");
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante({ aal: "aal1" }) } })).motivo, MOTIVO.MFA_REQUERIDA);
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante({ mfaEm: agoraMs - 30 * 60_000 }) } })).motivo, MOTIVO.REAUTENTICACAO_RECENTE);
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante() } }, { adm: { autoridades: {} } })).motivo, "SEM_AUTORIDADE_ADMINISTRATIVA");
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante() } }, { adm: { autoridades: { [CONTA_ADMIN]: "SUPERADMIN" } } })).motivo, "SEM_AUTORIDADE_ADMINISTRATIVA");
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante() } }, { adm: { autoridades: { [CONTA_ADMIN]: "SUPERADMIN" } }, tipos: ["ADMIN_EMPRESA", "SUPERADMIN"] })).ok, true);
  assert.equal((await verif({ ...ATO({ usuarioId: PESSOA_COMPARTILHADA }), atestado: { sessao: atestante() } })).motivo, "CONTA_COMPARTILHADA");
  assert.equal((await verif({ ...ATO({ unidadeId: UNI_B }), atestado: { sessao: atestante() } })).motivo, "PESSOA_SEM_ACESSO_A_UNIDADE");
  assert.equal((await verif({ ...ATO(), atestado: { sessao: atestante({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN } }) } })).motivo, "ATESTANTE_EM_IMPERSONACAO");
  assert.equal((await verif({ ...ATO({ justificativa: "curta" }), atestado: { sessao: atestante() } })).motivo, "JUSTIFICATIVA_INSUFICIENTE");
  assert.equal((await verif({ ...ATO(), atestado: {} })).motivo, "ATESTANTE_NAO_AUTENTICADO");
  // pelo núcleo: recusa vira PROVISIONAMENTO_RECUSADO e nada é gravado
  const m = montar();
  const n = criarNucleoFinanceiro({ repositorio: m.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio, autoridadeDeProvisionamento: criarAutoridadeDaPlataforma({ administracao: administracao(), vinculos: portas().vinculos, relogio }) });
  await assert.rejects(n.provisionarAdministradorInicial({ ...ATO({ usuarioId: PESSOA_ADMIN }), atestado: { sessao: atestante() } }), (e) => e.codigo === CODIGO.PROVISIONAMENTO_RECUSADO);
});

// ---------------------------------------------------------------------------------- contrato, gateway, produção
test("contrato — os campos que o adaptador lê são os que requireAuth/requireContexto montam (evidência no código da plataforma)", () => {
  const auth = readFileSync(join(backend, "src", "middlewares", "auth.js"), "utf8");
  for (const campo of ["id: usuarioId", "ativo:", "senhaProvisoria:", "aal,", "mfaEm,"]) assert.ok(auth.includes(campo), `req.user.${campo}`);
  assert.match(auth, /req\.tenant = \{ organizacaoId: sessao\.organizacao_id, unidadeId: sessao\.unidade_id \?\? null \}/);
  for (const campo of ["sessionId: sessao.id", "expiraEm: sessao.expira_em", "perfilId: sessao.perfil_id", "papel: sessao.papel", "impersonadoPor:", "impersonando: !!sessao.impersonado_por", "empresa: {", "unidade,"]) assert.ok(auth.includes(campo), `req.acesso.${campo}`);
  // o bypass de impersonação da plataforma existe — e o v2 NÃO o reproduz
  assert.match(auth, /if \(req\.acesso\.impersonando\) return next\(\);/);
});

test("13 — gateway: a credencial da autoridade não chega ao serviço da aplicação nem à interface; o adaptador não emite credencial", () => {
  const homolog = readFileSync(join(backend, "scripts", "fv2-homologacao.mjs"), "utf8");
  const iniciar = homolog.slice(homolog.indexOf("async function iniciar()"), homolog.indexOf("const comando = process.argv[2]"));
  assert.deepEqual([...iniciar.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1]), ['join(PASTA_HOMOLOGACAO, "aplicacao.json"'], "o serviço só lê a própria credencial");
  assert.ok(!/urlAutoridade/.test(iniciar), "o serviço não conhece a credencial da autoridade");
  const preparar = homolog.slice(homolog.indexOf("async function preparar()"), homolog.indexOf("async function iniciar()"));
  assert.match(preparar, /aplicacao\.json"\), JSON\.stringify\(\{ urlApp:/, "aplicacao.json tem só a URL da aplicação");
  const integracao = readFileSync(join(backend, "src", "modules", "financeiro-v2", "integracao", "plataforma.js"), "utf8");
  assert.ok(!/emitir\w*\s*\(|urlAutoridade|fv2_abrir_sessao|fv2_autoridade|gatewayToken|criarAutoridadeDeTeste/i.test(integracao.replace(/\/\/.*$/gm, "")), "o adaptador não emite nem guarda credencial");
  for (const f of ["app.js", "telasTesouraria.js", "telasConferencias.js"]) {
    assert.ok(!/urlAutoridade|fv2_autoridade|gateway\.json/.test(readFileSync(join(backend, "..", "frontend", "financeiro-v2", f), "utf8")), f);
  }
});

test("25 — ausência de acesso a produção: integração e jornadas não leem .env, Supabase nem endereço remoto", () => {
  const arquivos = [
    join(backend, "src", "modules", "financeiro-v2", "integracao", "plataforma.js"),
    join(backend, "scripts", "fv2", "jornada08e.mjs"),
    join(backend, "scripts", "fv2-homologacao.mjs"),
    join(backend, "..", "frontend", "src", "financeiroV2Encaixe.js"),
  ];
  for (const f of arquivos) {
    const s = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/supabase|["'`/\\]\.env\b|env-file|SUPABASE_|https?:\/\/(?!127\.0\.0\.1)[a-z]/i.test(s), f);
  }
  // o módulo continua sem montagem em rotas (guarda da fundação) e o encaixe não está ligado ao menu publicado
  assert.ok(readFileSync(join(aqui, "isolamento-estatico.test.js"), "utf8").includes("o módulo não está montado em rotas"));
});

void ORG_B;
