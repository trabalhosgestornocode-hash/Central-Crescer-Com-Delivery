// TESTE ARQUITETURAL (ajuste 9 — service_role mínimo no futuro gateway):
// os arquivos que HOJE já desenham a fronteira do provider (whatsapp.
// provider.js, whatsapp.service.js, providers/fake.provider.js) — que são
// exatamente os que o BaileysProvider do Checkpoint C vai estender — NUNCA
// devem importar o cliente Supabase nem referenciar a service_role key.
// Isso é o que torna a recomendação da seção 9 do relatório VERIFICÁVEL,
// não só uma promessa em texto: se algum dia alguém importar `config/
// supabase.js` dentro de providers/*, este teste quebra.
//
// Sem banco, sem rede. Rodar: node --test test/comunicacao-seguranca-gateway.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const ARQUIVOS_FRONTEIRA_PROVIDER = [
  path.join(SRC, "modules", "comunicacao", "whatsapp.provider.js"),
  path.join(SRC, "modules", "comunicacao", "whatsapp.service.js"),
  path.join(SRC, "modules", "comunicacao", "providers", "fake.provider.js"),
  // Checkpoint C1: o BaileysGatewayProvider é exatamente o provider real que
  // este teste foi escrito para vigiar — precisa estar nesta lista, não fora dela.
  path.join(SRC, "modules", "comunicacao", "providers", "baileysGateway.provider.js"),
];

const PADROES_PROIBIDOS = [
  /config\/supabase\.js/i,
  /SUPABASE_SERVICE_ROLE_KEY/,
  /service_role/i,
  /createClient\(/, // instanciar um cliente Supabase próprio também não deveria acontecer aqui
];

describe("segurança — a fronteira do provider nunca toca service_role/Supabase", () => {
  for (const arquivo of ARQUIVOS_FRONTEIRA_PROVIDER) {
    test(`${path.relative(SRC, arquivo)} não referencia Supabase/service_role`, () => {
      const conteudo = readFileSync(arquivo, "utf8");
      const achados = PADROES_PROIBIDOS.filter((re) => re.test(conteudo));
      assert.deepEqual(achados.map(String), [], `${arquivo} referencia algo que a fronteira do provider nunca deveria tocar`);
    });
  }

  test("nenhum dos três arquivos importa nada de ../../config/", () => {
    for (const arquivo of ARQUIVOS_FRONTEIRA_PROVIDER) {
      const conteudo = readFileSync(arquivo, "utf8");
      assert.ok(!/from\s+["'].*\/config\//.test(conteudo), `${arquivo} importa de config/ — a fronteira do provider deveria ser cega a credenciais`);
    }
  });
});
