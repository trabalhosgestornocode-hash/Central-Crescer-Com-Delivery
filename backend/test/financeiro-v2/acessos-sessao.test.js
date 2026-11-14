// Liberações de acesso PERSISTIDAS (memória e PostgreSQL isolado) + contrato com o middleware de autenticação atual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACAO, CODIGO, criarAdaptadorDeSessao, criarConcessoesDoRepositorio } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, USUARIO, ctx, montar, provisionarAdministrador, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";

const LEITOR = "dddddddd-0000-4000-8000-000000000001";
const OPERADOR = "dddddddd-0000-4000-8000-000000000002";
const ADMIN = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.IMPORTAR, ACAO.CONCEDER, ACAO.REVOGAR, ACAO.REGISTRAR]); // administrador provisionado
/** 07B: quem concede precisa ter a concessão GRAVADA — o administrador é provisionado pelo caminho real. */
const comAdministrador = async (m) => { await provisionarAdministrador(m.repositorio, { acoes: [...ADMIN.permissoes] }); return m; };
const sessao = (usuarioId, extra = {}) => ({
  user: { id: usuarioId, ativo: true, superadmin: extra.superadmin ?? false },
  tenant: { organizacaoId: extra.org ?? ORG_A, unidadeId: extra.unidade ?? null },
  acesso: { sessionId: "sessao-sintetica", expiraEm: "2026-10-15T18:00:00.000Z", papel: extra.papel ?? "operador", permissoes: ["*"], impersonando: false },
});
const arquivo = () => ({ fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo: saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 1000 }]) });

test("conceder e revogar: persistido, com histórico; leitura não importa; o adaptador de sessão lê do banco", async () => {
  const { nucleo, repositorio } = await comAdministrador(montar());
  const sessoes = criarAdaptadorDeSessao({ concessoes: criarConcessoesDoRepositorio({ repositorio, escopos: ESCOPOS_PADRAO }), relogio: () => AGORA });
  await rejeita(sessoes.contextoPara(sessao(LEITOR), { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO); // ninguém nasce com acesso

  await nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "Consulta de conferência." });
  const cLeitor = await sessoes.contextoPara(sessao(LEITOR), { unidadeId: UNI_A });
  assert.deepEqual([...cLeitor.permissoes], [ACAO.VER]);
  await rejeita(nucleo.receberArquivoParaImportacao(cLeitor, arquivo()), CODIGO.PERMISSAO_INSUFICIENTE); // só leitura não importa
  await rejeita(sessoes.contextoPara(sessao(LEITOR), { unidadeId: UNI_A2 }), CODIGO.ESCOPO_NAO_AUTORIZADO); // outra unidade

  const op = await nucleo.concederAcesso(ADMIN, { usuarioId: OPERADOR, acoes: [ACAO.VER, ACAO.IMPORTAR], justificativa: "Operador de importação." });
  assert.equal(op.concedidoPor, USUARIO);
  const cOp = await sessoes.contextoPara(sessao(OPERADOR), { unidadeId: UNI_A });
  assert.equal((await nucleo.receberArquivoParaImportacao(cOp, arquivo())).importacao.estado, "PRONTO_PARA_IMPORTAR");

  const revogada = await nucleo.revogarAcesso(ADMIN, { usuarioId: OPERADOR, acoes: [ACAO.IMPORTAR], justificativa: "Fim do período de importação." });
  assert.deepEqual(revogada.acoes, [ACAO.VER]);
  const cOp2 = await sessoes.contextoPara(sessao(OPERADOR), { unidadeId: UNI_A });
  await rejeita(nucleo.receberArquivoParaImportacao(cOp2, { ...arquivo(), conteudo: saiposVendas([{ pedido: "P-2", data: "02/09/2026 12:00", itens: 900 }]) }), CODIGO.PERMISSAO_INSUFICIENTE);
  const total = await nucleo.revogarAcesso(ADMIN, { usuarioId: OPERADOR, justificativa: "Desligamento." });
  assert.equal(total.situacao, "REVOGADA");
  await rejeita(sessoes.contextoPara(sessao(OPERADOR), { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO);

  const hist = await nucleo.consultarHistorico(ctx(), { registroTipo: "CONCESSAO", registroId: op.id });
  assert.deepEqual(hist.map((h) => h.evento), ["CRIACAO", "CANCELAMENTO", "CANCELAMENTO"]);
  assert.ok(hist.every((h) => h.justificativa && h.usuarioId === USUARIO));
});

test("escalada de privilégio é recusada: sem conceder, a si mesmo, ação que não possui, ação inventada, sem justificativa", async () => {
  const { nucleo } = await comAdministrador(montar());
  const semConceder = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.IMPORTAR]);
  await rejeita(nucleo.concederAcesso(semConceder, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.concederAcesso(ADMIN, { usuarioId: USUARIO, acoes: [ACAO.HOMOLOGAR], justificativa: "auto" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: [ACAO.HOMOLOGAR], justificativa: "não tenho" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: ["financeiro.tudo"], justificativa: "antigo" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: [ACAO.VER] }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.revogarAcesso(ADMIN, { usuarioId: USUARIO, justificativa: "auto" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // O escopo é o do contexto: conceder "para outra unidade" não existe no comando.
  await rejeita(nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "x", unidadeId: UNI_A2 }), CODIGO.ENTRADA_INVALIDA);
  // Papel antigo / superadmin não concede nada.
  const { repositorio } = montar();
  const sessoes = criarAdaptadorDeSessao({ concessoes: criarConcessoesDoRepositorio({ repositorio, escopos: ESCOPOS_PADRAO }), relogio: () => AGORA });
  await rejeita(sessoes.contextoPara(sessao(LEITOR, { superadmin: true, papel: "dono" }), { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO);
});

test("isolamento: concessão numa unidade não vale em outra nem em outra organização", async () => {
  const { nucleo, repositorio } = await comAdministrador(montar());
  await nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "Unidade A." });
  const sessoes = criarAdaptadorDeSessao({ concessoes: criarConcessoesDoRepositorio({ repositorio, escopos: ESCOPOS_PADRAO }), relogio: () => AGORA });
  assert.deepEqual((await sessoes.unidadesAutorizadas(sessao(LEITOR))).map((u) => u.unidadeId), [UNI_A]);
  await rejeita(sessoes.contextoPara(sessao(LEITOR, { org: ORG_B }), { unidadeId: UNI_B }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(sessoes.contextoPara(sessao(LEITOR, { org: ORG_B }), { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  assert.equal((await nucleo.listarConcessoes(ctx(ORG_A, UNI_A2, [ACAO.CONCEDER]))).filter((x) => x.usuarioId === LEITOR).length, 0);
});

test("07B — conceder exige a concessão GRAVADA do concedente: contexto que alega `conceder` ou ações extras não basta", async () => {
  // Sem nenhuma concessão gravada: o contexto confiável diz "pode conceder", mas não há registro → recusado.
  const vazio = montar({ plano: false, concessoesDeTeste: false });
  await rejeita(vazio.nucleo.concederAcesso(ADMIN, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(vazio.nucleo.revogarAcesso(ADMIN, { usuarioId: LEITOR, justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Gravado só ver + conceder; o contexto alega TODAS as ações → só repassa o que está gravado.
  const m = montar({ plano: false, concessoesDeTeste: false });
  await provisionarAdministrador(m.repositorio, { acoes: [ACAO.VER, ACAO.CONCEDER] });
  const alegaTudo = ctx(ORG_A, UNI_A, Object.values(ACAO));
  await rejeita(m.nucleo.concederAcesso(alegaTudo, { usuarioId: LEITOR, acoes: [ACAO.HOMOLOGAR], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  const ok = await m.nucleo.concederAcesso(alegaTudo, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "Somente leitura." });
  assert.deepEqual(ok.acoes, [ACAO.VER]);
  // Provisionamento atestado por quem NÃO está com MFA (aal1) é recusado pelo núcleo (e, no PostgreSQL, também pelo banco).
  await rejeita(provisionarAdministrador(montar({ plano: false, concessoesDeTeste: false }).repositorio, { unidadeId: UNI_A2, nivelAutenticacao: "aal1" }), CODIGO.PROVISIONAMENTO_RECUSADO);
});

test("concessões concorrentes para o mesmo usuário resultam em UM registro coerente", async () => {
  const { nucleo } = await comAdministrador(montar());
  const acoes = [[ACAO.VER], [ACAO.IMPORTAR], [ACAO.REGISTRAR]];
  const r = await Promise.allSettled(acoes.map((a) => nucleo.concederAcesso(ADMIN, { usuarioId: OPERADOR, acoes: a, justificativa: "Corrida sintética." })));
  for (const x of r.filter((y) => y.status === "rejected")) assert.equal(x.reason.codigo, CODIGO.CONFLITO_VERSAO);
  const lista = (await nucleo.listarConcessoes(ADMIN)).filter((x) => x.usuarioId === OPERADOR);
  assert.equal(lista.length, 1);
  const ok = r.filter((x) => x.status === "fulfilled").length;
  assert.equal(lista[0].acoes.length, ok);
});

test("contrato com o middleware atual: os campos que o adaptador usa continuam sendo montados no servidor", () => {
  const auth = readFileSync(fileURLToPath(new URL("../../src/middlewares/auth.js", import.meta.url)), "utf8");
  // Revalidação estática e local (sem consultar produção): se o formato mudar, este teste obriga a revisar o adaptador.
  assert.match(auth, /req\.user\s*=\s*\{[\s\S]*?\bid:\s*usuarioId/);
  assert.match(auth, /req\.tenant\s*=\s*\{\s*organizacaoId:\s*sessao\.organizacao_id,\s*unidadeId:\s*sessao\.unidade_id/);
  assert.match(auth, /req\.acesso\s*=\s*\{[\s\S]*?sessionId:\s*sessao\.id[\s\S]*?expiraEm:\s*sessao\.expira_em[\s\S]*?impersonadoPor:\s*sessao\.impersonado_por[\s\S]*?impersonando:/);
  assert.match(auth, /ativo:\s*perfil\?\.ativo/);
});
