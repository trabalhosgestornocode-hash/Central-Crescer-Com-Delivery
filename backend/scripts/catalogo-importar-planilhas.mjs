#!/usr/bin/env node
// Importador das planilhas "Ficha Técnica" (Caramelle Café) — SIMULAÇÃO por padrão.
//
//   node scripts/catalogo-importar-planilhas.mjs --salgados <.xlsx> --doces <.xlsx> --bebidas <.xlsx> \
//        [--fonte caramelle-fichas-v1] [--saida <pasta>]
//
// Sem mais nada: LÊ as planilhas, planeja, valida e grava só o relatório (JSON + MD) em --saida.
// NÃO abre conexão com banco e NÃO precisa de .env.
//
// Escrita (somente após autorização explícita do responsável, e nunca por padrão):
//   --aplicar --confirmo-escrita --org <uuid> [--sobrescrever-fichas]
//   + variáveis SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY + CATALOGO_IMPORT_CONFIRMA_HOST=<host do SUPABASE_URL>
// A aplicação é uma única transação no banco (fn_catalogo_importar) e é idempotente.

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { lerWorkbook, extrairFichas } from "../src/modules/catalogo-importacao/fichasPlanilha.parser.js";
import { planejarCatalogo, validarPayload } from "../src/modules/catalogo-importacao/catalogo.planejar.js";
import { aplicarCatalogo, avaliarTravasDeEscrita } from "../src/modules/catalogo-importacao/catalogo.importar.service.js";
import { relatorioMarkdown } from "../src/modules/catalogo-importacao/catalogo.relatorio.js";

function args(argv) {
  const a = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) { a._.push(t); continue; }
    const k = t.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}

const a = args(process.argv);
const entradas = [["SALGADOS", a.salgados], ["DOCES", a.doces], ["BEBIDAS", a.bebidas]].filter(([, p]) => p && p !== true);
if (!entradas.length) { console.error("Informe ao menos um arquivo: --salgados/--doces/--bebidas <caminho.xlsx>"); process.exit(2); }

const fonte = typeof a.fonte === "string" ? a.fonte : "caramelle-fichas-v1";
const arquivosMeta = [];
const extraidos = entradas.map(([categoria, caminho]) => {
  const buf = readFileSync(caminho);
  arquivosMeta.push({ nome: basename(caminho), categoria, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
  return extrairFichas(lerWorkbook(caminho), categoria, { arquivo: basename(caminho) });
});

const { payload, relatorio } = planejarCatalogo(extraidos, { fonte });
const erros = validarPayload(payload);
relatorio.arquivos = arquivosMeta;
relatorio.validacao_payload = erros.length ? erros : "ok";

const saida = resolve(typeof a.saida === "string" ? a.saida : "./catalogo-relatorio");
mkdirSync(saida, { recursive: true });
writeFileSync(resolve(saida, "relatorio.json"), JSON.stringify(relatorio, null, 2));
writeFileSync(resolve(saida, "payload.json"), JSON.stringify(payload));
writeFileSync(resolve(saida, "relatorio.md"), relatorioMarkdown(relatorio));
console.log(`Relatório em ${saida}`);
console.log(JSON.stringify(relatorio.totais, null, 2));
console.log("conciliação de custos:", JSON.stringify({ ...relatorio.conciliacao_custos, divergencias: relatorio.conciliacao_custos.divergencias.length }));
if (erros.length) { console.error("PAYLOAD INVÁLIDO — nada será aplicado:", erros.slice(0, 10)); process.exit(1); }

if (!a.aplicar) { console.log("Modo SIMULAÇÃO: nenhuma escrita foi feita."); process.exit(0); }

const travas = avaliarTravasDeEscrita({
  confirmoEscrita: a["confirmo-escrita"] === true, orgId: typeof a.org === "string" ? a.org : null,
  supabaseUrl: process.env.SUPABASE_URL, hostConfirmado: process.env.CATALOGO_IMPORT_CONFIRMA_HOST,
});
if (!travas.ok) { console.error(`ESCRITA RECUSADA: ${travas.motivo}`); process.exit(3); }

const { supabase } = await import("../src/config/supabase.js");
const resumo = await aplicarCatalogo(supabase, {
  orgId: a.org, fonte, payload, arquivos: arquivosMeta, sobrescreverFichas: a["sobrescrever-fichas"] === true,
});
console.log("APLICADO:", JSON.stringify(resumo));
