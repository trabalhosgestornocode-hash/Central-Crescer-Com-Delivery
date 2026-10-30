// D-14 (convite de usuário por e-mail) e ativação M3 (travada).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
const conv = await import("../src/modules/usuarios/usuarios.convites.js");
const m3 = await import("../src/modules/notificacoes/notificacoes.m3.js");
const basico = await import("../src/modules/notificacoes/notificacoes.basico.js");
const seg = await import("../src/modules/notificacoes/notificacoes.segredos.js");

const ORG = "00000000-0000-4000-8000-00000000a001";
const UN = "00000000-0000-4000-8000-0000000000a1";
const req = { user: { id: "00000000-0000-4000-8000-0000000000e1", email: "admin@x.com" }, perfil: { id: "00000000-0000-4000-8000-0000000000f1" } };

function supaFalso() {
  const st = { convites: [], convitesInvite: [], rpc: [], inserts: [] };
  const tabela = (nome) => {
    const q = { _f: {}, _nome: nome,
      select() { return q; }, eq(k, v) { q._f[k] = v; return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle: async () => ({ data: nome === "unidades" ? (q._f.organizacao_id === ORG && q._f.id === UN ? { id: UN } : null) : (nome === "perfis" ? null : null) }),
      insert(linha) { st.inserts.push([nome, linha]); if (nome === "usuarios_convites") st.convites.push({ id: "c-1", ...linha }); q._ins = linha; return q; },
      single: async () => ({ data: { id: "c-1", expira_em: q._ins?.expira_em } }),
      update(p) { st.update = p; return q; },
    };
    return q;
  };
  return { st, from: tabela, rpc: async (nome, args) => { st.rpc.push([nome, args]); return { data: st.rpcResposta ?? { resultado: "CONSUMIDO", organizacao_id: ORG, unidade_alvo_id: null, papel: "operations", nome: "Novo", convite_id: "c-1" } }; },
    auth: { admin: { inviteUserByEmail: async (email, opts) => { st.convitesInvite.push([email, opts]); return { error: null }; } } } };
}
const auditar = async () => {};

describe("D-14: conceder acesso ou convidar", () => {
  test("conta existente: só o vínculo, como antes — senha nunca passa (null)", async () => {
    let chamada = null;
    const r = await conv.concederOuConvidar({ req, organizacaoId: ORG, nome: "Ana", email: "ana@x.com", papel: "operations",
      deps: { contaExistentePorEmail: async () => true, criarUsuario: async (p) => { chamada = p; return { id: "u" }; }, auditar } });
    assert.equal(r.tipo, "ACESSO_CONCEDIDO");
    assert.equal(chamada.senha, null);
  });
  test("conta nova: convite com token só como hash, e-mail HMAC+cifrado+máscara, 72 h; envio DESLIGADO por padrão", async () => {
    const supa = supaFalso();
    const r = await conv.concederOuConvidar({ req, organizacaoId: ORG, nome: "Novo", email: "novo.usuario@x.com", papel: "viewer", env: {},
      deps: { supabase: supa, contaExistentePorEmail: async () => false, auditar } });
    assert.equal(r.tipo, "CONVITE_CRIADO");
    assert.equal(r.convite.envio, "DESLIGADO");
    const linha = supa.st.convites[0];
    assert.match(linha.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(linha.email_hmac, seg.hmacEmail("novo.usuario@x.com"));
    assert.ok(!JSON.stringify(linha).includes("novo.usuario@x.com"), "e-mail nunca em claro");
    assert.equal(linha.email_mascarado, "no**********@x.com");
    assert.ok(Date.parse(linha.expira_em) - Date.now() <= 72 * 3_600_000);
    assert.equal(supa.st.convitesInvite.length, 0, "nenhum e-mail real enviado");
    assert.ok(!("senha" in linha) && !JSON.stringify(linha).includes("senha"));
  });
  test("envio ligado (supabase): convite do Supabase Auth com o token no FRAGMENTO do redirect", async () => {
    const supa = supaFalso();
    await conv.concederOuConvidar({ req, organizacaoId: ORG, email: "b@x.com", papel: "viewer", env: { USUARIOS_CONVITE_EMAIL: "supabase" }, baseUrl: "https://app",
      deps: { supabase: supa, contaExistentePorEmail: async () => false, auditar } });
    const [email, opts] = supa.st.convitesInvite[0];
    assert.equal(email, "b@x.com");
    assert.match(opts.redirectTo, /^https:\/\/app\/convite-usuario\.html#t=[A-Za-z0-9_-]{43}$/);
  });
  test("convite para unidade de outra empresa é recusado; papel inválido recusado", async () => {
    const supa = supaFalso();
    await assert.rejects(conv.concederOuConvidar({ req, organizacaoId: ORG, email: "c@x.com", papel: "viewer", unidadeId: "00000000-0000-4000-8000-0000000000ff", deps: { supabase: supa, contaExistentePorEmail: async () => false, auditar } }), /fora desta empresa/);
    await assert.rejects(conv.concederOuConvidar({ req, organizacaoId: ORG, email: "c@x.com", papel: "platform_superadmin", deps: { supabase: supa, contaExistentePorEmail: async () => false, auditar } }), /Cargo/);
  });
  test("aceite: exige o e-mail convidado (HMAC), consome atomicamente e cria o vínculo; falhas viram mensagens claras", async () => {
    const supa = supaFalso();
    const token = basico.gerarToken();
    let vinculo = null;
    const deps = { supabase: supa, auditar, garantirPerfilOperacionalInicial: async () => "perfil-1", inserirVinculoOrg: async (p) => { vinculo = p; return null; } };
    const r = await conv.aceitarConvite({ req: { user: { id: "u-novo", email: "Novo@X.com" } }, token, deps });
    assert.equal(r.aceito, true);
    const [nome, args] = supa.st.rpc[0];
    assert.equal(nome, "usuarios_convite_consumir");
    assert.equal(args.p_token_hash, basico.hashToken(token));
    assert.equal(args.p_email_hmac, seg.hmacEmail("novo@x.com"), "e-mail normalizado no HMAC");
    assert.deepEqual([vinculo.organizacaoId, vinculo.papel], [ORG, "operations"]);
    supa.st.rpcResposta = { resultado: "EMAIL_DIVERGENTE" };
    await assert.rejects(conv.aceitarConvite({ req: { user: { id: "u2", email: "outro@x.com" } }, token, deps }), /outro e-mail/);
    await assert.rejects(conv.aceitarConvite({ req: { user: { id: "u2", email: "outro@x.com" } }, token: "curto", deps }), /inválido/);
  });
});

describe("M3: travada por padrão, frase de confirmação, universo do monitor", () => {
  test("sem a env de autorização: 409 (trava do ambiente, não de permissão), nada é chamado", async () => {
    let chamou = false;
    await assert.rejects(m3.ativar({ req, corpo: { confirmacao: m3.FRASE_CONFIRMACAO, migracaoId: "10000000-0000-4000-8000-000000000001" }, env: {},
      deps: { repo: { ativarSelecao: async () => { chamou = true; } } } }), (e) => e.statusCode === 409 && e.details?.codigo === "M3_BLOQUEADA_NO_AMBIENTE");
    assert.equal(chamou, false);
  });
  test("com a env: frase errada → 400; certa → universo = função do monitor D-1 (módulo dashboard_ifood)", async () => {
    const env = { NOTIFICACOES_M3_ATIVACAO_HABILITADA: "true" };
    await assert.rejects(m3.ativar({ req, corpo: { confirmacao: "ativar", migracaoId: "10000000-0000-4000-8000-000000000001" }, env, deps: {} }), (e) => e.statusCode === 400);
    let modulo = null; let enviado = null;
    const r = await m3.ativar({ req, corpo: { confirmacao: m3.FRASE_CONFIRMACAO, migracaoId: "10000000-0000-4000-8000-000000000001" }, env, deps: {
      auditar,
      listarUnidadesElegiveis: async ({ moduloId }) => { modulo = moduloId; return [{ unidadeId: "u1", organizacaoId: "o1" }, { unidadeId: "u2", organizacaoId: "o1" }]; },
      repo: { ativarSelecao: async (p) => { enviado = p; return { resultado: "ATIVADA", snapshot: 2 }; } } } });
    assert.equal(modulo, "ifood_dashboard");
    assert.deepEqual(enviado.universo, [{ unidade_id: "u1", organizacao_id: "o1" }, { unidade_id: "u2", organizacao_id: "o1" }]);
    assert.equal(r.resultado, "ATIVADA");
  });
  test("estado informa se a ativação é permitida neste ambiente (padrão: não)", async () => {
    const s = await m3.estado({ env: {}, deps: { repo: { estadoSelecao: async () => ({ ligada: false }) } } });
    assert.deepEqual([s.ligada, s.ativacaoPermitidaNesteAmbiente], [false, false]);
  });
});
