// TESTE ARQUITETURAL (ajuste aprovado): "nenhum ponto do sistema pode
// chamar Provider.send* diretamente" — verificação ESTÁTICA, sem banco,
// que vale para o código de hoje E para qualquer arquivo novo adicionado
// depois (não é um teste de comportamento de UM cenário, é uma
// regra que vale para o módulo inteiro).
//
// Escaneia todo backend/src procurando `.sendText(`, `.sendImage(` e
// `.sendDocument(` — os únicos lugares onde isso pode aparecer são a
// DEFINIÇÃO do contrato/fake provider e a fábrica whatsapp.service.js.
// Qualquer outro arquivo chamando isso diretamente FALHA o teste.
//
// Rodar: node --test test/comunicacao-arquitetura-provider.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const METODOS_ENVIO = ["sendText(", "sendImage(", "sendDocument("];

// Arquivos com permissão de MENCIONAR esses métodos — a definição do
// contrato (JSDoc), o próprio serviço que os invoca, e o FakeProvider (que
// os IMPLEMENTA, não os chama noutro objeto).
const PERMITIDOS = new Set([
  path.join(SRC, "modules", "comunicacao", "whatsapp.provider.js"),
  path.join(SRC, "modules", "comunicacao", "whatsapp.service.js"),
  path.join(SRC, "modules", "comunicacao", "providers", "fake.provider.js"),
  // Checkpoint C1: segundo provider real (implementa o contrato via HTTP+HMAC
  // contra o gateway-whatsapp) — mesma permissão que fake.provider.js já tem,
  // pelo mesmo motivo (é a IMPLEMENTAÇÃO do método, não uma chamada externa).
  path.join(SRC, "modules", "comunicacao", "providers", "baileysGateway.provider.js"),
]);

function listarArquivosJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listarArquivosJs(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// Remove comentários `//linha` e `/* bloco */` antes de escanear — o teste
// verifica CHAMADAS reais, não documentação que MENCIONA o nome do método
// (ex.: um comentário explicando por que só whatsapp.service.js deveria
// chamar isto, como o desta própria migração de conceito, já derrubou o
// teste por engano uma vez). Ingênuo o bastante para não confundir com
// string literal contendo "//" (não há caso assim neste código-fonte).
function removerComentarios(codigo) {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("arquitetura — Provider.send* só é chamado por whatsapp.service.js", () => {
  test("nenhum arquivo fora da lista permitida chama sendText/sendImage/sendDocument (fora de comentários)", () => {
    const violacoes = [];
    for (const arquivo of listarArquivosJs(SRC)) {
      if (PERMITIDOS.has(arquivo)) continue;
      const codigo = removerComentarios(readFileSync(arquivo, "utf8"));
      for (const metodo of METODOS_ENVIO) {
        if (codigo.includes(metodo)) violacoes.push(`${path.relative(SRC, arquivo)} chama ${metodo}`);
      }
    }
    assert.deepEqual(violacoes, [], `violação da invariante "só whatsapp.service.js chama o provider":\n${violacoes.join("\n")}`);
  });

  test("whatsapp.service.js de fato é quem chama — sanity check do próprio teste (evita falso-positivo por typo no nome do arquivo)", () => {
    const conteudo = readFileSync(path.join(SRC, "modules", "comunicacao", "whatsapp.service.js"), "utf8");
    for (const metodo of METODOS_ENVIO) {
      assert.ok(conteudo.includes(metodo), `esperava encontrar ${metodo} em whatsapp.service.js`);
    }
  });
});
