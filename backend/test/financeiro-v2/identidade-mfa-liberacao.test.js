// Execução 09B — identidade individual, prova VERIFICADA de segundo fator, liberação por empresa/unidade (memória e
// PostgreSQL 0021) e política do gateway. Identidades, tokens e segredos SINTÉTICOS (nenhum é de projeto real).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarConcessoesMemoria, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { MOTIVO, criarAdaptadorDaPlataforma, criarAutoridadeDaPlataforma } from "../../src/modules/financeiro-v2/integracao/plataforma.js";
import { MOTIVO_PROVA, criarVerificadorDeMfa, verificadorHs256 } from "../../src/modules/financeiro-v2/integracao/provaDeAutenticacao.js";
import { criarLiberacoesMemoria } from "../../src/modules/financeiro-v2/integracao/liberacoes.js";
import { alterarLiberacaoPostgres, criarLiberacoesPostgres } from "../../src/modules/financeiro-v2/infra/postgres/liberacoesPostgres.js";
import { FINALIDADE, decidirEmissao, eventoSemSegredos } from "../../src/modules/financeiro-v2/integracao/politicaDoGateway.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, UNI_A, UNI_A2, montar } from "./helpers/cenario.js";
import { abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { SEGREDO_SINTETICO, assinar, tokenSintetico } from "./helpers/tokens.js";

const agoraMs = AGORA.getTime();
const relogio = () => AGORA;
const CONTA = "dddddddd-0000-4000-8000-000000000001";
const PESSOA = "dddddddd-0000-4000-8000-0000000000f1";
const CONTA_LOJA = "dddddddd-0000-4000-8000-000000000003"; // conta compartilhada (2 pessoas com PIN)
const PESSOA_LOJA_1 = "dddddddd-0000-4000-8000-0000000000f3";
const PESSOA_LOJA_2 = "dddddddd-0000-4000-8000-0000000000f4";
const CONTA_ADMIN = "dddddddd-0000-4000-8000-000000000002";
const PESSOA_ADMIN = "dddddddd-0000-4000-8000-0000000000f2";
const OUTRA_CONTA = "dddddddd-0000-4000-8000-000000000009";
const CONTA_DE = { [PESSOA]: CONTA, [PESSOA_LOJA_1]: CONTA_LOJA, [PESSOA_LOJA_2]: CONTA_LOJA, [PESSOA_ADMIN]: CONTA_ADMIN };
const PESSOAS_POR_CONTA = { [CONTA]: 1, [CONTA_LOJA]: 2, [CONTA_ADMIN]: 1 };
const mfa = criarVerificadorDeMfa({ verificarAssinatura: verificadorHs256(SEGREDO_SINTETICO), relogio });
const token = (extra = {}) => tokenSintetico({ agoraMs, conta: CONTA, ...extra });
const ATO_LIGAR = (extra = {}) => ({ organizacaoId: ORG_A, unidadeId: null, ativa: true, atorContaId: CONTA_ADMIN, justificativa: "Piloto sintético do Financeiro v2 aprovado pela gestão.", provaDeSegundoFator: { ok: true, contaId: CONTA_ADMIN, segundoFatorEm: agoraMs - 60_000 }, ...extra });

function sessao({ conta = CONTA, pessoa = PESSOA, org = ORG_A, uni = UNI_A, papel = "organization_admin", user = {}, acesso = {} } = {}) {
  return {
    user: { id: conta, ativo: true, senhaProvisoria: false, superadmin: false, aal: "aal1", mfaEm: null, ...user },
    tenant: { organizacaoId: org, unidadeId: uni },
    acesso: { sessionId: "sessao-1", expiraEm: new Date(agoraMs + 4 * 3600_000).toISOString(), perfilId: pessoa, papel, permissoes: ["*"], impersonando: false, impersonadoPor: null, empresa: { id: org }, unidade: uni ? { id: uni } : null, ...acesso },
  };
}
async function montarAdaptador({ liberar = [[ORG_A, null], [ORG_A, UNI_A], [ORG_A, UNI_A2]], concessoes = [{ organizacaoId: ORG_A, usuarioId: PESSOA, unidadeId: UNI_A, acoes: [ACAO.VER, ACAO.HOMOLOGAR] }], ...extra } = {}) {
  const liberacoes = criarLiberacoesMemoria({ relogio });
  for (const [o, u] of liberar) await liberacoes.alterar(ATO_LIGAR({ organizacaoId: o, unidadeId: u }));
  const estado = { concessoes: [...concessoes] };
  const vinculos = {
    async unidadesDoPerfil({ perfilId, organizacaoId }) { return organizacaoId === ORG_A && CONTA_DE[perfilId] ? [UNI_A, UNI_A2] : []; },
    async perfisAtivosDaConta({ contaId }) { return PESSOAS_POR_CONTA[contaId] ?? 0; },
    async contaDoPerfil({ perfilId }) { return CONTA_DE[perfilId] ?? null; },
  };
  const a = criarAdaptadorDaPlataforma({ liberacoes, vinculos, concessoes: { listar: (q) => criarConcessoesMemoria(estado.concessoes).listar(q) }, mfa, relogio, ...extra });
  return { a, liberacoes, estado, vinculos };
}
const recusa = (p, motivo) => assert.rejects(p, (e) => { assert.equal(e?.detalhes?.motivo, motivo, `${e?.detalhes?.motivo}: ${e?.message}`); return true; });

// ------------------------------------------------------------------------------------------------ identidade
test("09B — identidade individual: conta pessoal + pessoa ativa da própria conta; conta compartilhada (PIN) e pessoa sem identidade são recusadas", async () => {
  const { a } = await montarAdaptador({ concessoes: [{ organizacaoId: ORG_A, usuarioId: PESSOA, unidadeId: UNI_A, acoes: [ACAO.VER] }, { organizacaoId: ORG_A, usuarioId: PESSOA_LOJA_1, unidadeId: UNI_A, acoes: [ACAO.VER] }] });
  assert.equal((await a.contexto(sessao())).ator.perfilId, PESSOA, "identidade individual validada");
  // conta compartilhada: mesmo com concessão gravada para a pessoa, e mesmo com o PIN dela, não opera
  await recusa(a.contexto(sessao({ conta: CONTA_LOJA, pessoa: PESSOA_LOJA_1 })), MOTIVO.CONTA_COMPARTILHADA);
  // pessoa inativa/inexistente, ou de OUTRA conta usada com este login
  await recusa(a.contexto(sessao({ pessoa: "dddddddd-0000-4000-8000-0000000000ee" })), MOTIVO.PESSOA_SEM_IDENTIDADE);
  await recusa(a.contexto(sessao({ pessoa: PESSOA_ADMIN })), MOTIVO.PESSOA_SEM_IDENTIDADE);
});

test("09B — PIN não é segundo fator: método 'pin' no token, sessão escolhida por PIN e aal declarado não provam nada", async () => {
  const { a } = await montarAdaptador();
  await recusa(a.contexto(sessao(), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token({ metodo: "pin" }) }), MOTIVO_PROVA.SEM_FATOR);
  await recusa(a.contexto(sessao(), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token({ metodo: "otp" }) }), MOTIVO_PROVA.SEM_FATOR); // OTP por e-mail/link
  await recusa(a.contexto(sessao({ user: { aal: "aal2", mfaEm: agoraMs - 1000 } }), { acao: ACAO.HOMOLOGAR }), MOTIVO_PROVA.SEM_TOKEN);
  await recusa(a.contexto(sessao({ conta: CONTA_LOJA, pessoa: PESSOA_LOJA_2 }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token({ conta: CONTA_LOJA }) }), MOTIVO.CONTA_COMPARTILHADA);
});

// ------------------------------------------------------------------------------------------------ MFA
test("09B — MFA ausente, expirado e antigo", async () => {
  const p = (t) => mfa.provar({ tokenDeAcesso: t, contaId: CONTA });
  assert.equal((await p(token({ aal: "aal1", metodo: null }))).motivo, MOTIVO_PROVA.SEM_AAL2);
  assert.equal((await p(token({ metodo: null }))).motivo, MOTIVO_PROVA.SEM_FATOR, "aal2 sem método de 2º fator em amr");
  assert.equal((await p(token({ expEmS: -1 }))).motivo, MOTIVO_PROVA.TOKEN_EXPIRADO);
  assert.equal((await p(token({ fatorHaS: 601, iatHaS: 600 }))).motivo, MOTIVO_PROVA.ANTIGA);
  assert.equal((await p(token({ fatorHaS: 599, iatHaS: 590 }))).ok, true);
  assert.equal((await p(undefined)).motivo, MOTIVO_PROVA.SEM_TOKEN);
});

test("09B — MFA falsificado: assinatura errada, alg none, payload adulterado, carimbo em ms, carimbo depois da emissão, token do futuro", async () => {
  const p = (t) => mfa.provar({ tokenDeAcesso: t, contaId: CONTA });
  assert.equal((await p(token({ segredo: "outro-segredo-qualquer-com-mais-de-32-caracteres" }))).motivo, MOTIVO_PROVA.ASSINATURA_INVALIDA);
  assert.equal((await p(assinar({ sub: CONTA, aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(agoraMs / 1000) }], iat: Math.floor(agoraMs / 1000), exp: Math.floor(agoraMs / 1000) + 60 }, { alg: "none" }))).motivo, MOTIVO_PROVA.ASSINATURA_INVALIDA);
  const [h, , sig] = token({ aal: "aal1", metodo: null }).split(".");
  const corpoFalso = Buffer.from(JSON.stringify({ sub: CONTA, aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(agoraMs / 1000) - 10 }], iat: Math.floor(agoraMs / 1000) - 5, exp: Math.floor(agoraMs / 1000) + 600 })).toString("base64url");
  assert.equal((await p(`${h}.${corpoFalso}.${sig}`)).motivo, MOTIVO_PROVA.ASSINATURA_INVALIDA);
  assert.equal((await p(token({ carimboEmMs: true }))).motivo, MOTIVO_PROVA.CARIMBO_INCOERENTE, "carimbo em milissegundos não é adivinhado");
  assert.equal((await p(token({ fatorHaS: 10, iatHaS: 300 }))).motivo, MOTIVO_PROVA.CARIMBO_INCOERENTE, "2º fator 'depois' da emissão do token");
  assert.equal((await p(token({ iatHaS: -600, fatorHaS: -600 }))).motivo, MOTIVO_PROVA.CARIMBO_INCOERENTE, "token emitido no futuro");
  assert.equal((await p("nao.e.jwt")).motivo, MOTIVO_PROVA.ASSINATURA_INVALIDA);
});

test("09B — ator trocado: token de outra conta não prova nada para esta sessão; superadmin e papel 'finance' não têm acesso automático", async () => {
  const { a } = await montarAdaptador();
  await recusa(a.contexto(sessao(), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token({ conta: OUTRA_CONTA }) }), MOTIVO_PROVA.OUTRA_CONTA);
  const semConcessao = await montarAdaptador({ concessoes: [] });
  await recusa(semConcessao.a.contexto(sessao({ user: { superadmin: true, painelAdministrativo: true } })), MOTIVO.SEM_CONCESSAO);
  await recusa(semConcessao.a.contexto(sessao({ papel: "finance", acesso: { permissoes: ["financeiro.*"] } })), MOTIVO.SEM_CONCESSAO);
  await recusa(a.contexto(sessao({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN, perfilId: null } })), MOTIVO.IMPERSONACAO);
});

test("09B — atestante: prova pelo token do PRÓPRIO atestante; sem autoconcessão; sem verificador = nada atestado", async () => {
  const administracao = { autoridadeSobre: async ({ contaId }) => (contaId === CONTA_ADMIN ? { tipo: "ADMIN_EMPRESA" } : null), contaDoPerfil: async ({ perfilId }) => CONTA_DE[perfilId] ?? null };
  const { vinculos } = await montarAdaptador();
  const aut = criarAutoridadeDaPlataforma({ administracao, vinculos, mfa, relogio });
  const ato = (extra = {}) => ({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA, acoes: [ACAO.VER], justificativa: "Administrador financeiro inicial (sintético) indicado pela gestão.", evidencia: "Ata sintética", atestado: { sessao: sessao({ conta: CONTA_ADMIN, pessoa: PESSOA_ADMIN }), tokenDeAcesso: tokenSintetico({ agoraMs, conta: CONTA_ADMIN }) }, ...extra });
  assert.equal((await aut.verificar(ato())).ok, true);
  assert.equal((await aut.verificar(ato({ usuarioId: PESSOA_ADMIN }))).motivo, "AUTOCONCESSAO");
  assert.equal((await aut.verificar(ato({ atestado: { sessao: sessao({ conta: CONTA_ADMIN, pessoa: PESSOA_ADMIN }), tokenDeAcesso: tokenSintetico({ agoraMs, conta: CONTA }) } }))).motivo, MOTIVO_PROVA.OUTRA_CONTA, "token de quem é indicado não atesta");
  assert.equal((await criarAutoridadeDaPlataforma({ administracao, vinculos, relogio }).verificar(ato())).motivo, MOTIVO.MFA_INDISPONIVEL);
  // pelo núcleo: recusa vira PROVISIONAMENTO_RECUSADO
  const m = montar();
  const n = criarNucleoFinanceiro({ repositorio: m.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio, autoridadeDeProvisionamento: criarAutoridadeDaPlataforma({ administracao, vinculos, relogio }) });
  await assert.rejects(n.provisionarAdministradorInicial({ ...ato(), atestado: ato().atestado }), (e) => e.codigo === CODIGO.PROVISIONAMENTO_RECUSADO);
});

// ------------------------------------------------------------------------------------------------ liberação
test("09B — liberação: desligada por padrão; unidade só com a empresa; liberada sem permissão; troca de unidade; desligar vale na hora e preserva dados", async () => {
  const vazio = await montarAdaptador({ liberar: [] });
  await recusa(vazio.a.contexto(sessao()), MOTIVO.EMPRESA_NAO_LIBERADA);
  assert.equal((await vazio.a.disponibilidade(sessao())).liberado, false, "rota direta numa unidade não liberada: nada");
  const soUnidade = await montarAdaptador({ liberar: [[ORG_A, UNI_A]] });
  await recusa(soUnidade.a.contexto(sessao()), MOTIVO.EMPRESA_NAO_LIBERADA);
  assert.deepEqual(await soUnidade.liberacoes.consultar({ organizacaoId: ORG_A, unidadeId: UNI_A }), { empresa: false, unidade: false, escrita: false }, "o registro segue o contrato do banco (0021): unidade só com a empresa");
  const { a, liberacoes, estado } = await montarAdaptador({ liberar: [[ORG_A, null], [ORG_A, UNI_A]] });
  assert.equal((await a.contexto(sessao())).contexto.unidadeId, UNI_A);
  await recusa(a.contexto(sessao({ uni: UNI_A2 })), MOTIVO.UNIDADE_NAO_LIBERADA, "troca para unidade não liberada");
  estado.concessoes.length = 0;
  await recusa(a.contexto(sessao()), MOTIVO.SEM_CONCESSAO, "liberada, mas sem permissão própria");
  estado.concessoes.push({ organizacaoId: ORG_A, usuarioId: PESSOA, unidadeId: UNI_A, acoes: [ACAO.VER] });
  await liberacoes.alterar(ATO_LIGAR({ unidadeId: UNI_A, ativa: false, justificativa: "Desligado para revisão do piloto (sintético)." }));
  await recusa(a.contexto(sessao()), MOTIVO.UNIDADE_NAO_LIBERADA);
  assert.deepEqual(liberacoes.historico().map((h) => [h.unidadeId, h.ativaAntes, h.ativaDepois]), [[null, null, true], [UNI_A, null, true], [UNI_A, true, false]]);
  assert.equal(estado.concessoes.length, 1, "desligar não mexe em concessões nem em dados");
});

test("09B — alterar liberação exige justificativa e prova de segundo fator DO PRÓPRIO ator", async () => {
  const l = criarLiberacoesMemoria({ relogio });
  await assert.rejects(l.alterar(ATO_LIGAR({ justificativa: "curta" })), (e) => e.detalhes.motivo === "JUSTIFICATIVA_INSUFICIENTE");
  await assert.rejects(l.alterar(ATO_LIGAR({ provaDeSegundoFator: null })), (e) => e.detalhes.motivo === "SEM_PROVA_DE_SEGUNDO_FATOR");
  await assert.rejects(l.alterar(ATO_LIGAR({ provaDeSegundoFator: { ok: true, contaId: CONTA, segundoFatorEm: agoraMs } })), (e) => e.detalhes.motivo === "SEM_PROVA_DE_SEGUNDO_FATOR");
  await assert.rejects(l.alterar(ATO_LIGAR({ atorContaId: null })), (e) => e.detalhes.motivo === "ATOR_AUSENTE");
  assert.deepEqual(await l.consultar({ organizacaoId: ORG_A, unidadeId: UNI_A }), { empresa: false, unidade: false, escrita: false });
});

// ------------------------------------------------------------------------------------------------ gateway
test("09B — gateway: emite só com sessão válida, conta pessoal e concessão; sensível só com prova da mesma conta; validade curta; escopo nunca vem do pedido", () => {
  const base = { sessao: sessao(), contaPessoal: true, acoesConcedidas: [ACAO.VER], agoraMs };
  const ok = decidirEmissao({ ...base, pedido: { finalidade: FINALIDADE.OPERACAO } });
  assert.deepEqual([ok.emitir, ok.escopo.unidadeId, ok.escopo.usuarioId, ok.validadeSegundos, ok.exigiuSegundoFator], [true, UNI_A, PESSOA, 900, false]);
  assert.equal(decidirEmissao({ ...base, pedido: { finalidade: FINALIDADE.ACAO_SENSIVEL } }).motivo, "SEM_PROVA_DE_SEGUNDO_FATOR");
  assert.equal(decidirEmissao({ ...base, pedido: { finalidade: FINALIDADE.ACAO_SENSIVEL }, prova: { ok: true, contaId: OUTRA_CONTA } }).motivo, "SEM_PROVA_DE_SEGUNDO_FATOR");
  assert.equal(decidirEmissao({ ...base, pedido: { finalidade: FINALIDADE.ACAO_SENSIVEL }, prova: { ok: true, contaId: CONTA } }).validadeSegundos, 300);
  assert.equal(decidirEmissao({ ...base, contaPessoal: false, pedido: { finalidade: FINALIDADE.OPERACAO } }).motivo, "CONTA_COMPARTILHADA");
  assert.equal(decidirEmissao({ ...base, acoesConcedidas: [], pedido: { finalidade: FINALIDADE.OPERACAO } }).motivo, "SEM_CONCESSAO");
  for (const campo of ["organizacaoId", "acoes", "permissoes", "usuarioId", "validadeSegundos"]) assert.equal(decidirEmissao({ ...base, pedido: { finalidade: FINALIDADE.OPERACAO, [campo]: "x" } }).motivo, "PEDIDO_TENTA_DEFINIR_ESCOPO");
  assert.equal(decidirEmissao({ ...base, pedido: { finalidade: FINALIDADE.OPERACAO, unidadeId: UNI_A2 } }).motivo, "UNIDADE_DIFERENTE_DA_SESSAO");
  assert.equal(decidirEmissao({ ...base, sessao: sessao({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN } }), pedido: { finalidade: FINALIDADE.OPERACAO } }).motivo, MOTIVO.IMPERSONACAO);
  assert.equal(decidirEmissao({ ...base, sessao: sessao({ acesso: { expiraEm: new Date(agoraMs + 120_000).toISOString() } }), pedido: { finalidade: FINALIDADE.OPERACAO } }).validadeSegundos, 120, "nunca além da sessão da plataforma");
  assert.equal(decidirEmissao({ ...base, sessao: sessao({ acesso: { expiraEm: new Date(agoraMs + 10_000).toISOString() } }), pedido: { finalidade: FINALIDADE.OPERACAO } }).motivo, "SESSAO_DA_PLATAFORMA_PERTO_DE_EXPIRAR");
  assert.equal(decidirEmissao({ ...base, pedido: { finalidade: "ADMIN_TOTAL" } }).motivo, "FINALIDADE_INVALIDA");
});

test("09B — eventos do gateway nunca carregam token, senha ou segredo", () => {
  const t = token();
  const ev = eventoSemSegredos({ evento: "SESSAO_EMITIDA", usuarioId: PESSOA, token: t, accessToken: t, headers: { authorization: `Bearer ${t}`, "x-trace": "ok" }, detalhes: { pin: "1234", observacao: t, lista: [t, "ok"] } });
  assert.ok(!JSON.stringify(ev).includes(t.split(".")[2]));
  assert.deepEqual(ev.headers, { "x-trace": "ok" });
  assert.equal(ev.detalhes.pin, undefined);
  assert.deepEqual(ev.detalhes.lista, ["[removido]", "ok"]);
});

test("09B — falha segura: verificador, porta de identidade ou de liberação que falha não libera nada", async () => {
  const quebrado = criarVerificadorDeMfa({ verificarAssinatura: () => { throw new Error("provedor fora do ar"); }, relogio });
  assert.equal((await quebrado.provar({ tokenDeAcesso: token(), contaId: CONTA })).motivo, MOTIVO_PROVA.ASSINATURA_INVALIDA);
  const { a } = await montarAdaptador({ mfa: { provar: async () => { throw new Error("x"); } } });
  await recusa(a.contexto(sessao(), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() }), MOTIVO_PROVA.ASSINATURA_INVALIDA);
  const sem = await montarAdaptador();
  sem.vinculos.contaDoPerfil = async () => { throw new Error("y"); };
  const a2 = criarAdaptadorDaPlataforma({ liberacoes: criarLiberacoesMemoria(), vinculos: sem.vinculos, concessoes: { listar: async () => [] }, mfa, relogio });
  await recusa(a2.contexto(sessao()), MOTIVO.EMPRESA_NAO_LIBERADA);
  const lib = await montarAdaptador();
  const a3 = criarAdaptadorDaPlataforma({ liberacoes: { consultar: async () => { throw new Error("z"); } }, vinculos: lib.vinculos, concessoes: { listar: async () => [] }, mfa, relogio });
  await recusa(a3.contexto(sessao()), MOTIVO.FALHA_FECHADA);
  const autoridade = criarAutoridadeDaPlataforma({ administracao: { autoridadeSobre: async () => { throw new Error("w"); }, contaDoPerfil: async () => CONTA }, vinculos: lib.vinculos, mfa, relogio });
  assert.equal((await autoridade.verificar({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA, justificativa: "Justificativa sintética longa o bastante.", atestado: { sessao: sessao({ conta: CONTA_ADMIN, pessoa: PESSOA_ADMIN }), tokenDeAcesso: tokenSintetico({ agoraMs, conta: CONTA_ADMIN }) } })).motivo, "FALHA_FECHADA");
  void ORG_B;
});

// ------------------------------------------------------------------------------------------------ PostgreSQL (0021)
const pular = { skip: motivoParaPular(), timeout: 300000 };
test("banco — 0021: liberação desligada por padrão; aplicação só LÊ; só a autoridade altera, com justificativa e 2º fator recente; histórico imutável; escopo do banco", pular, async () => {
  const b = await criarBancoDeTeste(ESCOPOS_PADRAO);
  const app = await abrirPool(b.urlApp, { max: 1 });
  const autoridade = await abrirPool(b.urlAutoridade, { max: 1 });
  const lib = criarLiberacoesPostgres({ poolApp: app });
  // o banco confere o carimbo contra o relógio REAL (não o relógio sintético da suíte)
  const ATO_PG = (extra = {}) => ATO_LIGAR({ provaDeSegundoFator: { ok: true, contaId: CONTA_ADMIN, segundoFatorEm: Date.now() - 60_000 }, ...extra });
  assert.deepEqual(await lib.consultar({ organizacaoId: ORG_A, unidadeId: UNI_A }), { empresa: false, unidade: false, escrita: false });
  const negado = (e) => ["42501"].includes(e.code);
  await assert.rejects(app.query("insert into fv2_liberacao (organizacao_id, unidade_id, ativa, alterada_por, justificativa) values ($1, null, true, $2, 'Tentativa direta da aplicação (sintético)')", [ORG_A, CONTA]), negado);
  await assert.rejects(app.query("select fv2_liberacao_alterar($1, null, true, $2, 'Tentativa da aplicação pela função (sintético)', now())", [ORG_A, CONTA]), negado);
  await assert.rejects(app.query("select * from fv2_liberacao_historico"), negado);
  // pela autoridade, com tudo
  await alterarLiberacaoPostgres(autoridade, ATO_PG());
  assert.deepEqual(await lib.consultar({ organizacaoId: ORG_A, unidadeId: UNI_A }), { empresa: true, unidade: false, escrita: false }, "a unidade continua desligada");
  await alterarLiberacaoPostgres(autoridade, ATO_PG({ unidadeId: UNI_A }));
  assert.deepEqual(await lib.consultar({ organizacaoId: ORG_A, unidadeId: UNI_A }), { empresa: true, unidade: true, escrita: false });
  // barreiras da função (mesmo chamada direto pela autoridade)
  const fv042 = (e) => e.code === "FV042";
  await assert.rejects(autoridade.query("select fv2_liberacao_alterar($1, $2, true, $3, 'curta', now())", [ORG_A, UNI_A2, CONTA_ADMIN]), fv042);
  await assert.rejects(autoridade.query("select fv2_liberacao_alterar($1, $2, true, $3, 'Justificativa longa o bastante (sintético)', now() - interval '11 minutes')", [ORG_A, UNI_A2, CONTA_ADMIN]), fv042);
  await assert.rejects(autoridade.query("select fv2_liberacao_alterar($1, $2, true, $3, 'Justificativa longa o bastante (sintético)', now())", [ORG_A, "aaaaaaaa-0000-4000-8000-0000000000ff", CONTA_ADMIN]), fv042, "unidade fora dos escopos do banco");
  // desligar a empresa derruba a unidade
  await alterarLiberacaoPostgres(autoridade, ATO_PG({ ativa: false, justificativa: "Empresa desligada para revisão (sintético)." }));
  assert.deepEqual(await lib.consultar({ organizacaoId: ORG_A, unidadeId: UNI_A }), { empresa: false, unidade: false, escrita: false });
  // histórico imutável (nem o dono o apaga)
  const dono = await abrirPool(b.urlAdmin, { max: 1 });
  assert.equal((await dono.query("select count(*)::int as n from fv2_liberacao_historico")).rows[0].n, 3);
  await assert.rejects(dono.query("update fv2_liberacao_historico set justificativa = 'x'"), fv042);
});

// ------------------------------------------------------------------------------------------------ 09C (revisão do MFA)
test("09C — emissão do token NÃO é o instante do 2º fator: token renovado agora com fator de 2 h atrás é recusado", async () => {
  const p = (t) => mfa.provar({ tokenDeAcesso: t, contaId: CONTA });
  const renovado = token({ fatorHaS: 2 * 3600, iatHaS: 5 }); // iat de 5 s (renovação), fator usado há 2 h
  assert.equal((await p(renovado)).motivo, MOTIVO_PROVA.ANTIGA);
  const recemDesafiado = token({ fatorHaS: 30, iatHaS: 20 }); // desafio de MFA agora → token novo com fator recente
  assert.equal((await p(recemDesafiado)).ok, true);
  assert.equal((await p(recemDesafiado)).segundoFatorEm, agoraMs - 30_000, "o instante vem do método em amr, não do iat");
});

test("09C — token válido não salva sessão revogada/expirada, não troca empresa/unidade e não serve a conta compartilhada", async () => {
  const { a } = await montarAdaptador();
  await recusa(a.contexto(sessao({ acesso: { expiraEm: new Date(agoraMs - 1).toISOString() } }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() }), MOTIVO.SESSAO_EXPIRADA);
  await recusa(a.contexto(sessao({ uni: "aaaaaaaa-0000-4000-8000-0000000000ff" }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() }), MOTIVO.UNIDADE_NAO_LIBERADA);
  await recusa(a.contexto(sessao({ acesso: { empresa: { id: ORG_B } } }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() }), MOTIVO.CONTEXTO_DIVERGENTE);
  await recusa(a.contexto(sessao({ conta: CONTA_LOJA, pessoa: PESSOA_LOJA_1 }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token({ conta: CONTA_LOJA }) }), MOTIVO.CONTA_COMPARTILHADA);
  await recusa(a.contexto(sessao({ acesso: { impersonando: true, impersonadoPor: CONTA_ADMIN } }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() }), MOTIVO.IMPERSONACAO);
  // a ação sensível com tudo certo passa; troca de pessoa na mesma sessão (outro perfil) não herda a prova
  assert.equal((await a.contexto(sessao(), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() })).autenticacao.provaVerificada, true);
  await recusa(a.contexto(sessao({ pessoa: PESSOA_ADMIN }), { acao: ACAO.HOMOLOGAR, tokenDeAcesso: token() }), MOTIVO.PESSOA_SEM_IDENTIDADE);
});
