// Teste de CONTRATO REAL do Baileys (Checkpoint C3.5-C.3, seção 17) — contra
// o pacote REALMENTE instalado em node_modules/baileys, SEM rede, SEM abrir
// socket nenhum. Existe para que uma futura atualização do Baileys que mude
// este contrato QUEBRE ESTE TESTE (e force reauditoria) em vez de silenciosamente
// reintroduzir o bug do Checkpoint C3.5-C.1: a máquina de estados do Gateway
// (baileysSession.js) NUNCA MAIS pode depender de `creds.registered` para
// decidir CONNECTED — mas se algum dia o Baileys passar a setar
// `registered=true` também no fluxo de QR, isto merece ser investigado, não
// ignorado.
//
// Método: leitura ESTÁTICA do código-fonte instalado (mesma técnica já usada
// na instrumentação read-only do Checkpoint C1 — ver
// docs/gateway-whatsapp-auth-state-instrumentacao.md) + chamada de funções
// PURAS exportadas (initAuthCreds — só gera chaves, nunca toca rede). Nunca
// chama makeWASocket() nem abre WebSocket nenhum.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initAuthCreds } from "baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BAILEYS_ROOT = path.join(__dirname, "..", "node_modules", "baileys");
const BAILEYS_LIB = path.join(BAILEYS_ROOT, "lib");

// Checkpoint C3.5-C.1 — a versão EXATA contra a qual esta investigação foi
// feita. Se o pacote instalado mudar de versão, este teste PRECISA falhar
// pedindo reauditoria — nunca deve silenciosamente continuar assumindo um
// contrato que não foi reverificado contra o código novo.
const VERSAO_AUDITADA = "6.7.24";

function lerFonte(...partes) {
  return fs.readFileSync(path.join(BAILEYS_LIB, ...partes), "utf8");
}

function listarArquivosJs(dir) {
  const saida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...listarArquivosJs(caminho));
    else if (entrada.name.endsWith(".js")) saida.push(caminho);
  }
  return saida;
}

describe("contrato real do Baileys instalado (Checkpoint C3.5-C.3) — SEM rede", () => {
  test(`versão instalada é exatamente a auditada (${VERSAO_AUDITADA}) — se mudou, REAUDITAR este arquivo inteiro antes de confiar nele`, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BAILEYS_ROOT, "package.json"), "utf8"));
    assert.equal(
      pkg.version, VERSAO_AUDITADA,
      `baileys foi atualizado de ${VERSAO_AUDITADA} para ${pkg.version} — TODAS as invariantes deste arquivo (o que decide 'registered', o que emite connection:"open") precisam ser reauditadas contra o código novo antes deste teste ser confiado de novo.`,
    );
  });

  test("initAuthCreds() (creds de uma sessão NUNCA pareada) nasce com registered:false", () => {
    const creds = initAuthCreds();
    assert.equal(creds.registered, false, "uma sessão nova precisa começar não-registrada — premissa básica do resto deste arquivo");
  });

  test("`.registered = true` só existe em UM lugar em todo o pacote — dentro do handler 'link_code_companion_reg' (pairing code numérico), NUNCA no fluxo de QR", () => {
    const arquivos = listarArquivosJs(BAILEYS_LIB);
    const ocorrencias = [];
    for (const arquivo of arquivos) {
      const conteudo = fs.readFileSync(arquivo, "utf8");
      const re = /\.registered\s*=\s*true/g;
      let m;
      while ((m = re.exec(conteudo))) {
        ocorrencias.push({ arquivo: path.relative(BAILEYS_LIB, arquivo), indice: m.index, conteudo });
      }
    }
    assert.equal(
      ocorrencias.length, 1,
      `esperava exatamente 1 escrita de '.registered = true' em todo o pacote; encontrei ${ocorrencias.length} (${ocorrencias.map((o) => o.arquivo).join(", ")}). Se o Baileys passou a setar registered=true em outro lugar (possivelmente no fluxo de QR), REAUDITAR baileysSession.js — a premissa do Checkpoint C3.5-C.1 pode ter mudado.`,
    );

    const [ocorrencia] = ocorrencias;
    assert.equal(ocorrencia.arquivo, path.join("Socket", "messages-recv.js"), "a escrita de registered=true precisa continuar em Socket/messages-recv.js");

    // A escrita precisa estar dentro do bloco `case 'link_code_companion_reg':`
    // — nunca em um handler de QR. Delimita o bloco pelo início do `case`
    // correspondente até o próximo `case ` do mesmo switch (ou fim do arquivo).
    const { conteudo, indice } = ocorrencia;
    const inicioCase = conteudo.indexOf("case 'link_code_companion_reg':");
    assert.ok(inicioCase !== -1, "esperava encontrar o case 'link_code_companion_reg' em messages-recv.js");
    const proximoCase = conteudo.indexOf("\n        case '", inicioCase + 1);
    const fimBloco = proximoCase === -1 ? conteudo.length : proximoCase;
    assert.ok(
      indice > inicioCase && indice < fimBloco,
      "registered=true precisa estar DENTRO do bloco do pairing code numérico (link_code_companion_reg) — nunca fora dele",
    );
  });

  test("configureSuccessfulPairing() (pair-success do fluxo de QR) devolve account/me/signalIdentities/platform — e NUNCA um campo 'registered'", () => {
    const fonte = lerFonte("Utils", "validate-connection.js");
    const inicioFuncao = fonte.indexOf("export const configureSuccessfulPairing");
    assert.ok(inicioFuncao !== -1, "esperava encontrar configureSuccessfulPairing em Utils/validate-connection.js");
    const fimFuncao = fonte.indexOf("\nexport const", inicioFuncao + 1);
    const corpo = fonte.slice(inicioFuncao, fimFuncao === -1 ? fonte.length : fimFuncao);

    const inicioAuthUpdate = corpo.indexOf("const authUpdate = {");
    assert.ok(inicioAuthUpdate !== -1, "esperava encontrar o literal `authUpdate` construído dentro de configureSuccessfulPairing");
    const fimAuthUpdate = corpo.indexOf("};", inicioAuthUpdate);
    const literalAuthUpdate = corpo.slice(inicioAuthUpdate, fimAuthUpdate);

    for (const campo of ["account", "me:", "signalIdentities", "platform"]) {
      assert.ok(literalAuthUpdate.includes(campo), `esperava o campo '${campo}' no authUpdate do pair-success (QR)`);
    }
    assert.ok(
      !/\bregistered\b/.test(literalAuthUpdate),
      "authUpdate do pair-success (QR) NUNCA deveria conter 'registered' — se passou a conter, o Checkpoint C3.5-C.1 precisa ser reauditado (a premissa central deste checkpoint mudou)",
    );
  });

  test("CB:success (conclusão real da conexão, tanto QR quanto pairing code) emite connection.update({connection:'open'}) — o ÚNICO fato protocolar que baileysSession.js pode usar para promover CONNECTED", () => {
    const fonte = lerFonte("Socket", "socket.js");
    const inicioHandler = fonte.indexOf("ws.on('CB:success'");
    assert.ok(inicioHandler !== -1, "esperava encontrar o handler ws.on('CB:success', ...) em Socket/socket.js");
    const fimHandler = fonte.indexOf("ws.on(", inicioHandler + 1);
    const corpoHandler = fonte.slice(inicioHandler, fimHandler === -1 ? fonte.length : fimHandler);

    assert.ok(
      corpoHandler.includes(`ev.emit('connection.update', { connection: 'open' })`),
      "CB:success precisa emitir exatamente connection.update({connection:'open'}) — é este o fato protocolar que confirmarGeracaoAposOpen()/tentarConfirmarConexao() em baileysSession.js dependem",
    );
    // Reforça a premissa central do Checkpoint C3.5-C.1: o PRÓPRIO handler
    // que emite o 'open' real NÃO seta `registered` — reforça que 'open' e
    // 'registered' são dois fatos genuinamente independentes no protocolo.
    assert.ok(
      !/\.registered\s*=/.test(corpoHandler),
      "o handler de CB:success não deveria setar 'registered' — 'open' e 'registered' precisam continuar sendo fatos independentes",
    );
  });
});
