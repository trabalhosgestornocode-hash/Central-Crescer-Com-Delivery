// Regra de acesso da Central (frontend): quem tem acesso ao Painel VÊ toda a Central; sem `comunicacao:gerenciar_conexao` só as AÇÕES somem (nota discreta),
// nunca as abas nem a tela inteira. Nada de token/id de operação/QR na leitura. Design aprovado intacto: só regressão de contrato.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { htmlConexao, htmlCartaoConexao } from "../src/central/centralConexaoUi.js";
import { htmlCasca } from "../src/central/centralUi.js";
import { ABAS } from "../src/central/centralModelo.js";

const AGORA = new Date(2026, 8, 24, 15, 0, 0);
const iso = (min) => new Date(AGORA.getTime() - min * 60_000).toISOString();
const NOTA = "Esta ação exige permissão de gerenciamento da conexão.";

const est = (o = {}) => ({
  estado: "DISCONNECTED", rotulo: "Desconectado", conectado: false, reconectando: false, semSinal: false,
  identidade: { status: "SEM_CONTA", ambiente: "TESTE", ambienteRotulo: "Ambiente de teste", nomeOperacional: null, agenteCrescer: false, confirmadoEm: null },
  conta: null, saude: { id: "sem_sinal", rotulo: "Sem sinal", ultimoSinalEm: iso(1), conectadoEm: null },
  tecnico: { gateway: "Respondendo", heartbeatEm: iso(1), sessaoValida: true, socket: "Fechado", ultimaConexaoEm: iso(600), ultimaDesconexaoEm: iso(300), motivoUltimaDesconexao: null },
  permissoes: { gerenciar: false }, operacao: null, reconciliacao: null, ...o,
});
const conectado = (o = {}) => est({
  estado: "CONNECTED", rotulo: "Conectado", conectado: true,
  conta: { nome: "Crescer Teste", iniciais: "CT", fotoUrl: null, telefoneMascarado: "********40", tipoConta: "DESCONHECIDO", tipoContaRotulo: "Tipo não identificado", descricao: "" },
  identidade: { status: "CONFIRMADA", ambiente: "PRODUCAO", ambienteRotulo: "Produção", nomeOperacional: null, agenteCrescer: false, confirmadoEm: iso(60) },
  saude: { id: "saudavel", rotulo: "Saudável", ultimoSinalEm: iso(1), conectadoEm: iso(60) }, ...o,
});
const comBotoes = (h) => /data-cc-conexao="/.test(h);

describe("a Central inteira é visível a quem tem acesso ao Painel", () => {
  test("as abas são estáticas: nenhuma some por falta de comunicacao:gerenciar_conexao", () => {
    const ids = ABAS.map(([id]) => id);
    for (const id of ["visao-geral", "conversas", "automacoes", "historico", "destinatarios", "conexao"]) assert.ok(ids.includes(id), id);
    const casca = htmlCasca({ aba: "conexao", estado: null, naoLidas: 0, corpo: "" });
    for (const id of ids) assert.match(casca, new RegExp(`data-cc-aba="${id}"`), `aba ${id} presente na casca`);
  });
  test("Conexão sem permissão continua mostrando estado, conta mascarada, identidade e indicadores (não vira 'sem permissão')", () => {
    const h = htmlConexao(conectado(), { agora: AGORA });
    assert.match(h, /Conta confirmada/); assert.match(h, /\*{4,}40/); assert.match(h, /Identidade no Crescer com Delivery/); assert.match(h, /Você pode acompanhar esta conexão/);
    assert.match(h, /Situação da conexão/);
    assert.ok(!comBotoes(h), "nenhum controle de ação para quem só lê");
    assert.doesNotMatch(h, /Acesso negado|sem permissão para ver/i);
  });
});

describe("sem permissão: só as ações somem, com nota discreta", () => {
  for (const [nome, estado] of [["desconectado", est()], ["conectado", conectado()], ["sessão inválida", est({ estado: "AUTH_ERROR", rotulo: "Sessão inválida" })], ["aguardando QR com operação", est({ estado: "WAITING_QR", operacao: { tipo: "CONECTAR", expiraEm: iso(-4), podeReconciliar: false } })]]) {
    test(`${nome}: sem botões e com "${NOTA}"`, () => {
      const h = htmlCartaoConexao(estado);
      assert.ok(!comBotoes(h)); assert.match(h, /data-cc-sem-permissao/); assert.ok(h.includes(NOTA));
    });
  }
  test("onde nem o gerente teria ação (conectando/reconectando sem operação) não há nota nenhuma", () => {
    for (const estado of ["CONNECTING", "RECONNECTING"]) assert.doesNotMatch(htmlCartaoConexao(est({ estado })), /data-cc-sem-permissao/);
  });
  test("com permissão nada muda: botões presentes e nenhuma nota de permissão", () => {
    const h = htmlCartaoConexao(est({ permissoes: { gerenciar: true } }));
    assert.match(h, /data-cc-conexao="conectar"/); assert.ok(!h.includes(NOTA)); assert.doesNotMatch(h, /data-cc-operacao-andamento/);
    const c = htmlCartaoConexao(conectado({ permissoes: { gerenciar: true } }));
    assert.match(c, /data-cc-conexao="trocar"/); assert.match(c, /data-cc-conexao="desconectar"/); assert.ok(!c.includes(NOTA));
  });
});

describe("operação em andamento visível na leitura — sem id", () => {
  test("leitor vê 'Operação em andamento' com o tipo e nenhum identificador", () => {
    for (const [tipo, txt] of [["CONECTAR", "conexão do WhatsApp"], ["TROCAR", "troca do número conectado"], ["DESCONECTAR", "desconexão do WhatsApp"]]) {
      const h = htmlConexao(conectado({ operacao: { tipo, expiraEm: iso(-4), efeitoEstado: null, reconciliacaoNecessaria: false, podeReconciliar: false } }), { agora: AGORA });
      assert.match(h, /data-cc-operacao-andamento/); assert.ok(h.includes(`Operação em andamento: ${txt}.`));
    }
  });
  test("com reconciliação necessária o bloco de reconciliação fala pela operação (sem linha duplicada) e o leitor não vê botão", () => {
    const recon = { reconciliacaoNecessaria: true, acao: "DESCONECTAR", incertoDesde: iso(12), ultimaVerificacaoEm: iso(3), ultimoResultado: "AINDA_INCERTO:gateway_indisponivel", verificacoes: 2 };
    const h = htmlConexao(conectado({ reconciliacao: recon, operacao: { tipo: "DESCONECTAR", expiraEm: iso(-4), ...recon, podeReconciliar: false } }), { agora: AGORA });
    assert.match(h, /data-cc-reconciliacao/); assert.doesNotMatch(h, /data-cc-operacao-andamento/);
    assert.match(h, /Um administrador autorizado precisa verificar o estado da conexão/); assert.ok(!comBotoes(h));
    assert.match(h, /Desconectar a conta/); assert.match(h, /Última verificação/);
  });
  test("o gerente não recebe a linha informativa (ele tem as ações), e nada de token/QR aparece para ninguém", () => {
    const g = htmlConexao(conectado({ permissoes: { gerenciar: true }, operacao: { id: "op-x", tipo: "CONECTAR", expiraEm: iso(-4) } }), { agora: AGORA });
    assert.doesNotMatch(g, /data-cc-operacao-andamento/);
    const leitor = htmlConexao(conectado({ operacao: { tipo: "CONECTAR", expiraEm: iso(-4) } }), { agora: AGORA });
    assert.doesNotMatch(leitor, /op-x|efeito_token|<svg[^>]*data-qr|2@/);
  });
});
