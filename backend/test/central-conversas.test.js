// Central de Comunicação — LISTA e CONVERSA: quem aparece (só roster), duas unidades = uma conversa, filtros, busca por nome (nunca por telefone), janela de
// 24h com entradas + saídas manuais/automáticas/teste em ordem, status SENT ≠ DELIVERED ≠ READ, não lidas, foto (com e sem), cursor de atualização.
// Sem rede, sem banco (fake em memória).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { listarConversas, obterConversa, marcarLida, atualizacoes, agendarAtualizacaoFoto, previa, inicioDoDiaBrasil } from "../src/modules/administrativo/administrativo.comunicacao.conversas.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";

const ORG_CONEXAO = "00000000-0000-4000-8000-0000000000a1";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C1 = uuid(101); const C2 = uuid(102); const C3 = uuid(103);
const AGORA = new Date("2026-09-24T15:00:00.000Z");
const min = (n) => new Date(AGORA.getTime() - n * 60_000).toISOString();
const hora = (n) => new Date(AGORA.getTime() - n * 3_600_000).toISOString();

const ROSTER = [
  linhaRoster({ contato_id: C1, telefone_e164: "+5511999990001", perfil_id: "p1", perfil_nome: "Maria Souza", organizacao_id: "o1", organizacao_nome: "Rede Sabor", unidade_id: "u1", unidade_nome: "Centro" }),
  linhaRoster({ contato_id: C1, telefone_e164: "+5511999990001", perfil_id: "p1", perfil_nome: "Maria Souza", organizacao_id: "o1", organizacao_nome: "Rede Sabor", unidade_id: "u2", unidade_nome: "Praia" }),
  linhaRoster({ contato_id: C2, telefone_e164: "+5511999990002", perfil_id: "p2", perfil_nome: "João Lima", organizacao_id: "o2", organizacao_nome: "Doce Vale", unidade_id: "u3", unidade_nome: "Norte", papel: "unit_manager" }),
  linhaRoster({ contato_id: C3, telefone_e164: "+5511999990003", perfil_id: "p3", perfil_nome: "Ana Paula", organizacao_id: "o3", organizacao_nome: "Grão Forte", unidade_id: "u4", unidade_nome: "Sul", consentimento: false, verificado: false }),
];

const saida = (o = {}) => ({
  id: uuid(Math.floor(Math.random() * 1e9)), organizacao_id: "o1", unidade_id: "u1", contato_id: C1, tipo: "dashboard_ifood_d1", conteudo: "Falta lançar o dashboard de ontem.", status: "DELIVERED",
  created_at: min(50), disponivel_em: min(50), enviado_em: min(50), entregue_em: min(49), lido_em: null, falhou_em: null, erro: null, metadados: {}, updated_at: min(49), direcao: "saida", ...o,
});
const entrada = (o = {}) => ({ id: uuid(Math.floor(Math.random() * 1e9)), organizacao_id: ORG_CONEXAO, contato_id: C1, provider_message_id: "P" + Math.random(), origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "Ok, vou lançar agora", recebido_em: min(30), created_at: min(30), ...o });

function montar({ saidas = [], entradas = [], leituras = [], roster = ROSTER, contatos = [], pendencias = [] } = {}) {
  const db = criarFakeDb({
    comunicacao_roster_autorizado: roster, comunicacao_mensagens: saidas, comunicacao_inbox_mensagens: entradas, comunicacao_inbox_leituras: leituras,
    contatos_whatsapp: contatos, whatsapp_conexoes: [],
  });
  const deps = {
    supabase: db, env: {}, agora: () => AGORA, organizacaoConexaoId: ORG_CONEXAO, whatsAppService: null, estadoGateway: { estado: "conectado" },
    lerPendencias: async () => ({ unidades: pendencias }), auditar: async () => {}, identidadeConfirmada: true,
  };
  return { db, deps };
}
const nomes = (r) => r.itens.map((c) => c.nome);

describe("lista de conversas — só o roster", () => {
  test("1202 mensagens, timestamps empatados: recentes primeiro e páginas sem perdas ou duplicatas", async () => {
    const entradas = Array.from({ length: 601 }, (_, i) => entrada({ id: uuid(1000 + i), recebido_em: min(1), created_at: min(1) }));
    const saidas = Array.from({ length: 601 }, (_, i) => saida({ id: uuid(2000 + i), enviado_em: min(1), created_at: min(1) }));
    const { deps } = montar({ entradas, saidas });
    let antes; const vistos = new Set(); let paginas = 0;
    do {
      const r = await obterConversa({ contatoId: C1, antes }, { contaId: "operador" }, deps);
      assert.ok(r.mensagens.length <= 200);
      if (!paginas) assert.ok(r.mensagens.some((m) => m.id === uuid(2600)), "última saída aparece na primeira página");
      for (const m of r.mensagens) {
        const chave = `${m.direcao}:${m.id}`;
        assert.ok(!vistos.has(chave), "nenhuma duplicata entre páginas"); vistos.add(chave);
      }
      assert.equal(r.temMaisAntigas, !!r.proximaPagina);
      antes = r.proximaPagina;
      assert.ok(++paginas < 10);
    } while (antes);
    assert.equal(vistos.size, 1202);
  });
  test("responsável autorizado com mensagem aparece; quem não tem atividade não aparece na caixa de entrada", async () => {
    const { deps } = montar({ entradas: [entrada()] });
    const r = await listarConversas({}, deps);
    assert.deepEqual(nomes(r), ["Maria Souza"]);
  });

  test("um número FORA do roster nunca aparece, mesmo com mensagens no banco", async () => {
    const { deps } = montar({ entradas: [entrada({ contato_id: uuid(999) })], saidas: [saida({ contato_id: uuid(999) })] });
    assert.deepEqual(nomes(await listarConversas({}, deps)), []);
    assert.deepEqual(nomes(await listarConversas({ busca: "999" }, deps)), []);
  });

  test("mesmo telefone em DUAS unidades ⇒ UMA conversa, com as duas unidades como chips", async () => {
    const { deps } = montar({ entradas: [entrada()] });
    const r = await listarConversas({}, deps);
    assert.equal(r.itens.length, 1);
    assert.deepEqual(r.itens[0].unidades.map((u) => u.nome).sort(), ["Centro", "Praia"]);
    assert.deepEqual(r.itens[0].empresas.map((e) => e.nome), ["Rede Sabor"]);
  });

  test("nunca devolve o telefone completo — só mascarado — em nenhum lugar da resposta", async () => {
    const { deps } = montar({ entradas: [entrada()], saidas: [saida()] });
    const texto = JSON.stringify(await listarConversas({}, deps));
    assert.ok(!texto.includes("5511999990001") && !texto.includes("999990001"));
    assert.match(texto, /\*{8}01/);
  });

  test("busca por nome do responsável, da empresa e da unidade (sem acento); NUNCA por telefone", async () => {
    const { deps } = montar({ entradas: [entrada()] });
    assert.deepEqual(nomes(await listarConversas({ busca: "maria" }, deps)), ["Maria Souza"]);
    assert.deepEqual(nomes(await listarConversas({ busca: "REDE sabor" }, deps)), ["Maria Souza"]);
    assert.deepEqual(nomes(await listarConversas({ busca: "praia" }, deps)), ["Maria Souza"]);
    assert.deepEqual(nomes(await listarConversas({ busca: "joao" }, deps)), ["João Lima"], "com busca, quem ainda não tem conversa também é encontrado");
    for (const t of ["+5511999990001", "5511999990001", "999990001", "11999990001", "99999"]) assert.deepEqual(nomes(await listarConversas({ busca: t }, deps)), [], t);
  });

  test("filtro inválido ⇒ 400", async () => {
    const { deps } = montar();
    await assert.rejects(() => listarConversas({ filtro: "todas; drop" }, deps), (e) => e.statusCode === 400);
  });
});

describe("não lidas e filtros", () => {
  test("não lidas: conta as entradas depois da última leitura; marcar como lida zera; nunca retrocede", async () => {
    const { deps } = montar({ entradas: [entrada({ recebido_em: min(30) }), entrada({ recebido_em: min(20) })] });
    assert.equal((await listarConversas({}, deps)).itens[0].naoLidas, 2);
    await marcarLida({ contatoId: C1, ate: min(25) }, {}, deps);
    assert.equal((await listarConversas({}, deps)).itens[0].naoLidas, 1);
    await marcarLida({ contatoId: C1, ate: min(60) }, {}, deps);          // tentativa de "desler"
    assert.equal((await listarConversas({}, deps)).itens[0].naoLidas, 1, "nunca retrocede");
    await marcarLida({ contatoId: C1 }, {}, deps);
    assert.equal((await listarConversas({}, deps)).itens[0].naoLidas, 0);
  });

  test("marcarLida nunca 'lê o futuro' e recusa conversa desconhecida (404)", async () => {
    const { deps, db } = montar({ entradas: [entrada()] });
    const r = await marcarLida({ contatoId: C1, ate: "2099-01-01T00:00:00.000Z" }, {}, deps);
    assert.ok(Date.parse(r.lidaAte) <= AGORA.getTime() + 61_000);
    await assert.rejects(() => marcarLida({ contatoId: uuid(999) }, {}, deps), (e) => e.statusCode === 404);
    assert.equal(db.tabelas.comunicacao_inbox_leituras.length, 1);
    await assert.rejects(() => marcarLida({ contatoId: C1, ate: "lixo" }, {}, deps), (e) => e.statusCode === 400);
  });

  test("filtros: não lidas / pendências / automação / atendimento humano", async () => {
    const { deps } = montar({
      entradas: [entrada({ contato_id: C1, recebido_em: min(10) })],
      saidas: [saida({ contato_id: C2, organizacao_id: "o2", unidade_id: "u3", created_at: hora(2), enviado_em: hora(2), entregue_em: hora(2) }),
        saida({ contato_id: C3, organizacao_id: "o3", unidade_id: "u4", tipo: "mensagem_manual", metadados: { proposito: "manual", ator_nome: "Operadora" }, created_at: hora(1), enviado_em: hora(1) })],
      pendencias: [{ organizacaoId: "o2", criticidade: "critico" }],
    });
    assert.deepEqual(nomes(await listarConversas({ filtro: "nao_lidas" }, deps)), ["Maria Souza"]);
    assert.deepEqual(nomes(await listarConversas({ filtro: "pendencias" }, deps)), ["João Lima"]);
    assert.deepEqual(nomes(await listarConversas({ filtro: "automacao" }, deps)), ["João Lima"]);
    assert.deepEqual(nomes(await listarConversas({ filtro: "humano" }, deps)).sort(), ["Ana Paula", "Maria Souza"]);
    const t = (await listarConversas({}, deps)).totais;
    assert.deepEqual([t.todas, t.naoLidas, t.pendencias, t.automacao, t.humano], [3, 1, 1, 1, 2]);
  });

  test("ordena pela atividade mais recente e mostra a prévia da última mensagem (entrada ou saída)", async () => {
    const { deps } = montar({
      entradas: [entrada({ contato_id: C1, texto: "Já lancei!", recebido_em: min(5) })],
      saidas: [saida({ contato_id: C2, organizacao_id: "o2", unidade_id: "u3", conteudo: "Lembrete D-1", created_at: min(40), enviado_em: min(40) })],
    });
    const r = await listarConversas({}, deps);
    assert.deepEqual(nomes(r), ["Maria Souza", "João Lima"]);
    assert.deepEqual([r.itens[0].ultimaMensagem.direcao, r.itens[0].ultimaMensagem.previa], ["entrada", "Já lancei!"]);
    assert.deepEqual([r.itens[1].ultimaMensagem.direcao, r.itens[1].ultimaMensagem.previa, r.itens[1].ultimaMensagem.categoria], ["saida", "Lembrete D-1", "automatica"]);
  });
});

describe("a conversa (24h)", () => {
  const cenario = () => montar({
    entradas: [entrada({ texto: "Bom dia", recebido_em: min(120) }), entrada({ texto: "Antiga demais", recebido_em: hora(30) })],
    saidas: [
      saida({ conteudo: "Aviso D-1", status: "SENT", created_at: min(200), enviado_em: min(200), entregue_em: null }),
      saida({ conteudo: "Posso ajudar?", tipo: "mensagem_manual", status: "READ", lido_em: min(60), metadados: { proposito: "manual", origem: "manual_painel", ator_nome: "Camila" }, created_at: min(90), enviado_em: min(90), entregue_em: min(89) }),
      saida({ conteudo: "Mensagem de teste", tipo: "teste_comunicacao", status: "DELIVERED", metadados: { proposito: "teste" }, created_at: min(70), enviado_em: min(70), entregue_em: min(69) }),
      saida({ conteudo: "Reforço", status: "DELIVERED", metadados: { proposito: "reforco" }, created_at: hora(30), enviado_em: hora(30) }),
    ],
  });

  test("combina entrada + manual + automática + teste em ordem cronológica, só as últimas 24h", async () => {
    const { deps } = cenario();
    const r = await obterConversa({ contatoId: C1 }, { contaId: "u" }, deps);
    assert.deepEqual(r.mensagens.map((m) => m.texto), ["Aviso D-1", "Bom dia", "Posso ajudar?", "Mensagem de teste"]);
    assert.deepEqual(r.mensagens.map((m) => m.categoria), ["automatica", "recebida", "manual", "teste"]);
    assert.deepEqual(r.mensagens.map((m) => m.direcao), ["saida", "entrada", "saida", "saida"]);
    assert.equal(r.janelaHoras, 24);
    assert.equal(r.temMaisAntigas, true, "há mensagens além das 24h");
  });

  test("ampliar a janela (horas=48) traz as antigas; limite superior de 720h", async () => {
    const { deps } = cenario();
    const r = await obterConversa({ contatoId: C1, horas: 48 }, { contaId: "u" }, deps);
    assert.equal(r.mensagens.length, 6);
    assert.equal((await obterConversa({ contatoId: C1, horas: 99999 }, { contaId: "u" }, deps)).janelaHoras, 720);
    assert.equal((await obterConversa({ contatoId: C1, horas: "lixo" }, { contaId: "u" }, deps)).janelaHoras, 24);
  });

  test("SENT continua SENT (nunca vira 'entregue'); DELIVERED e READ trazem seus instantes; o operador aparece na manual", async () => {
    const { deps } = cenario();
    const m = (await obterConversa({ contatoId: C1 }, { contaId: "u" }, deps)).mensagens;
    const sent = m.find((x) => x.texto === "Aviso D-1");
    assert.deepEqual([sent.status, sent.entregueEm, sent.lidoEm], ["SENT", null, null]);
    const lida = m.find((x) => x.texto === "Posso ajudar?");
    assert.deepEqual([lida.status, !!lida.entregueEm, !!lida.lidoEm, lida.operador], ["READ", true, true, "Camila"]);
    assert.equal(m.find((x) => x.texto === "Mensagem de teste").status, "DELIVERED");
  });

  test("conversa de contato FORA do roster ou inexistente ⇒ 404 idêntico (não revela se existe)", async () => {
    const { deps } = cenario();
    for (const id of [uuid(999), uuid(1)]) await assert.rejects(() => obterConversa({ contatoId: id }, { contaId: "u" }, deps), (e) => e.statusCode === 404 && /não encontrada/i.test(e.message));
    await assert.rejects(() => obterConversa({ contatoId: "nao-e-uuid" }, { contaId: "u" }, deps), (e) => e.statusCode === 400);
  });

  test("abrir uma conversa é AUDITADO (ator, telefone mascarado, sem o texto)", async () => {
    const { deps } = cenario(); const eventos = [];
    deps.auditar = async (e) => eventos.push(e);
    await obterConversa({ contatoId: C1 }, { contaId: "conta-1", perfilId: "perfil-1", nome: "Camila", email: "c@x.com" }, deps);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].acao, "COMUNICACAO_CONVERSA_ABERTA");
    assert.deepEqual([eventos[0].atorId, eventos[0].perfilId], ["conta-1", "perfil-1"]);
    const s = JSON.stringify(eventos);
    assert.ok(!s.includes("Bom dia") && !s.includes("5511999990001"));
  });

  test("o contexto lateral: consentimento, verificação, opt-out, pendências, última automática e última humana — sem inventar", async () => {
    const { deps } = montar({
      entradas: [entrada({ texto: "Já vi", recebido_em: min(20) })], saidas: [saida({ conteudo: "Aviso D-1", created_at: min(120), enviado_em: min(120) })],
      pendencias: [{ organizacaoId: "o1", criticidade: "atencao" }, { organizacaoId: "o1", criticidade: "critico" }],
    });
    const c = (await obterConversa({ contatoId: C1 }, { contaId: "u" }, deps)).contato;
    assert.deepEqual([c.nome, c.cargo, c.consentimento, c.verificado, c.optOut, c.pendenciasAtuais], ["Maria Souza", "Administrador da empresa", true, true, false, 2]);
    assert.equal(c.ultimaAutomatica.previa, "Aviso D-1");
    assert.deepEqual([c.ultimaHumana.direcao, c.ultimaHumana.previa], ["entrada", "Já vi"]);
    const vazio = (await obterConversa({ contatoId: C2 }, { contaId: "u" }, deps)).contato;
    assert.deepEqual([vazio.ultimaAutomatica, vazio.ultimaHumana], [null, null], "sem histórico ⇒ nada inventado");
  });

  test("a resposta sinaliza se pode enviar e por que não (consentimento/verificação/gateway)", async () => {
    const { deps } = montar({ entradas: [entrada({ contato_id: C3 })] });
    const r = await obterConversa({ contatoId: C3 }, { contaId: "u" }, deps);
    assert.equal(r.envio.podeEnviar, false);
    assert.ok(["SEM_CONSENTIMENTO", "NAO_VERIFICADO"].every((c) => r.envio.bloqueios.some((b) => b.codigo === c)));
  });
});

describe("foto de perfil", () => {
  const servico = (r) => ({ buscarFotoPerfil: async () => r });
  const contato = { contatoId: C1, telefoneE164: "+5511999990001" };

  test("foto disponível: salva a URL e a lista passa a devolvê-la", async () => {
    const { deps, db } = montar({ entradas: [entrada()], contatos: [{ id: C1 }] });
    deps.whatsAppService = servico({ url: "https://pps.whatsapp.net/x.jpg", motivo: "ok" });
    await agendarAtualizacaoFoto(contato, undefined, deps);
    assert.equal(db.tabelas.contatos_whatsapp[0].foto_url, "https://pps.whatsapp.net/x.jpg");
    assert.equal((await listarConversas({}, deps)).itens[0].fotoUrl, "https://pps.whatsapp.net/x.jpg");
  });

  test("foto INDISPONÍVEL: a interface recebe null (avatar de iniciais) e o serviço não pergunta de novo por 24h", async () => {
    const { deps, db } = montar({ entradas: [entrada()], contatos: [{ id: C1 }] });
    let chamadas = 0;
    deps.whatsAppService = { buscarFotoPerfil: async () => { chamadas += 1; return { url: null, motivo: "sem_foto" }; } };
    await agendarAtualizacaoFoto(contato, undefined, deps);
    const r = await listarConversas({}, deps);
    assert.equal(r.itens[0].fotoUrl, null);
    assert.equal(r.itens[0].iniciais, "MS");
    assert.equal(await agendarAtualizacaoFoto(contato, db.tabelas.contatos_whatsapp[0], deps), null);
    assert.equal(chamadas, 1);
  });

  test("falha transitória NÃO apaga a foto que já existia e agenda nova tentativa em 15 min", async () => {
    const { deps, db } = montar({ contatos: [{ id: C1, foto_url: "https://pps.whatsapp.net/velha.jpg", foto_atualizada_em: hora(7), foto_indisponivel_ate: null }] });
    deps.whatsAppService = servico({ url: null, motivo: "indisponivel" });
    await agendarAtualizacaoFoto(contato, db.tabelas.contatos_whatsapp[0], deps);
    const c = db.tabelas.contatos_whatsapp[0];
    assert.equal(c.foto_url, "https://pps.whatsapp.net/velha.jpg");
    assert.equal(Date.parse(c.foto_indisponivel_ate) - AGORA.getTime(), 15 * 60_000);
  });

  test("foto vigente (cache < 6h) não gera consulta; provider que lança nunca quebra a tela", async () => {
    const { deps, db } = montar({ contatos: [{ id: C1, foto_url: "https://pps.whatsapp.net/a.jpg", foto_atualizada_em: hora(1), foto_indisponivel_ate: null }] });
    deps.whatsAppService = { buscarFotoPerfil: async () => { throw new Error("boom"); } };
    assert.equal(agendarAtualizacaoFoto(contato, db.tabelas.contatos_whatsapp[0], deps), null);
    db.tabelas.contatos_whatsapp[0].foto_atualizada_em = hora(8);
    await assert.doesNotReject(() => agendarAtualizacaoFoto(contato, db.tabelas.contatos_whatsapp[0], deps));
  });
});

describe("atualizações (cursor)", () => {
  test("primeira entrada depois de cursor vazio invalida a conversa aberta", async () => {
    const { deps, db } = montar();
    const a = await atualizacoes({}, deps);
    db.tabelas.comunicacao_inbox_mensagens.push(entrada());
    assert.deepEqual((await atualizacoes({ cursor: a.cursor }, deps)).contatosAlterados, [C1]);
  });

  test("lote maior que o limite invalida todo o roster, sem perder o último contato", async () => {
    const { deps, db } = montar({ entradas: [entrada()] });
    const a = await atualizacoes({}, deps);
    db.tabelas.comunicacao_inbox_mensagens.push(...Array.from({ length: 201 }, () => entrada({ created_at: AGORA.toISOString() })), entrada({ contato_id: C2, created_at: AGORA.toISOString() }));
    const r = await atualizacoes({ cursor: a.cursor }, deps);
    assert.ok(r.contatosAlterados.includes(C2));
    assert.deepEqual(new Set(r.contatosAlterados), new Set([C1, C2, C3]));
  });
  test("sem cursor devolve o atual; sem mudança ⇒ mudou=false; nova entrada ⇒ só o id da conversa alterada", async () => {
    const { deps, db } = montar({ entradas: [entrada()] });
    const a = await atualizacoes({}, deps);
    assert.equal(a.mudou, false);
    const b = await atualizacoes({ cursor: a.cursor }, deps);
    assert.deepEqual([b.mudou, b.contatosAlterados], [false, []]);
    db.tabelas.comunicacao_inbox_mensagens.push(entrada({ contato_id: C2, created_at: new Date(AGORA.getTime() + 1000).toISOString() }));
    const c = await atualizacoes({ cursor: a.cursor }, deps);
    assert.equal(c.mudou, true);
    assert.ok(c.contatosAlterados.includes(C2), "a conversa alterada está no conjunto");
    assert.equal(new Set(c.contatosAlterados).size, c.contatosAlterados.length, "sem duplicatas (deduplicado)");
    assert.ok(c.naoLidas >= 1);
    assert.ok(!JSON.stringify(c).includes("Ok, vou lançar"), "nenhum conteúdo no cursor");
  });

  test("COMMIT ATRASADO: uma mensagem cujo created_at é anterior ao cursor (transação lenta) não se perde — a sobreposição de 5 s a recolhe", async () => {
    const { deps, db } = montar({ entradas: [entrada()] });
    const a = await atualizacoes({}, deps);
    const tardia = entrada({ contato_id: C2, created_at: new Date(Date.parse(a.cursor.split("|")[0]) - 2000).toISOString() });
    db.tabelas.comunicacao_inbox_mensagens.push(tardia, entrada({ contato_id: C1, created_at: new Date(AGORA.getTime() + 500).toISOString() }));
    const r = await atualizacoes({ cursor: a.cursor }, deps);
    assert.ok(r.contatosAlterados.includes(C2), "a mensagem atrasada foi recolhida");
  });

  test("status de uma saída que avança (recibo) também sinaliza a conversa", async () => {
    const { deps, db } = montar({ saidas: [saida({ updated_at: min(10) })] });
    const a = await atualizacoes({}, deps);
    db.tabelas.comunicacao_mensagens[0].updated_at = new Date(AGORA.getTime() + 5000).toISOString();
    assert.deepEqual((await atualizacoes({ cursor: a.cursor }, deps)).contatosAlterados, [C1]);
  });

  test("um id que o roster não reconhece nunca aparece em contatosAlterados; cursor malformado ⇒ 400", async () => {
    const { deps, db } = montar({ entradas: [entrada()] });
    const a = await atualizacoes({}, deps);
    db.tabelas.comunicacao_inbox_mensagens.push(entrada({ contato_id: uuid(999), created_at: new Date(AGORA.getTime() + 1000).toISOString() }));
    const r = await atualizacoes({ cursor: a.cursor }, deps);
    assert.ok(!r.contatosAlterados.includes(uuid(999)), "id fora do roster nunca vaza");
    for (const c of ["lixo", "a|b", "2026-01-01|", "2026-99-99T99:99:99Z|", "'; drop table x; --"]) await assert.rejects(() => atualizacoes({ cursor: c }, deps), (e) => e.statusCode === 400, c);
  });
});

describe("utilitários", () => {
  test("previa: uma linha, sem quebras, truncada com reticências", () => {
    assert.equal(previa("a\n\n  b   c"), "a b c");
    assert.equal(Array.from(previa("x".repeat(200))).length, 90);
    assert.ok(previa("x".repeat(200)).endsWith("…"));
    assert.equal(previa(null), "");
  });
  test("inicioDoDiaBrasil: meia-noite de Brasília (03:00Z)", () => {
    assert.equal(inicioDoDiaBrasil(new Date("2026-09-24T15:00:00Z")), "2026-09-24T03:00:00.000Z");
    assert.equal(inicioDoDiaBrasil(new Date("2026-09-24T02:00:00Z")), "2026-09-23T03:00:00.000Z");
  });
});
