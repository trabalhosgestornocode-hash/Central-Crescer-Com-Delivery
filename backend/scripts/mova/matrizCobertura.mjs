// MOVA CORE — F0: matriz de COBERTURA (o que o MOVA alcança hoje de cada operação do núcleo Financeiro 2.0 + ferramentas do Agente Crescer).
// Gera docs/mova-core/02-matriz-cobertura.md a partir de fontes VERIFICÁVEIS (nada é declarado à mão):
//   - inventário do núcleo (scripts/mova/inventarioCapacidades.mjs), a classificação de risco (docs/mova-matriz-capacidades.md),
//   - as leituras permitidas ao MOVA (portaFinanceira.OPERACOES_PERMITIDAS) e as escritas estreitas (portaOperacional.OPERACOES_DE_ESCRITA),
//   - as ferramentas de leitura do Agente Crescer (src/modules/agente/tools).
// Situações: DISPONIVEL (o MOVA executa hoje), PARCIAL (só via proposta/revisão humana ou só parte do fluxo), PLANEJADA (fase do MOVA CORE),
// RESTRITA (CRÍTICA ou sem classificação: nunca automática), INEXISTENTE (pedida pelo negócio, sem operação no sistema).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERACOES_PERMITIDAS } from "../../src/modules/mova-financeiro/aplicacao/portaFinanceira.js";
import { OPERACOES_DE_ESCRITA } from "../../src/modules/mova-financeiro/aplicacao/portaOperacional.js";
import { FERRAMENTAS } from "../../src/modules/mova-core/catalogo.js";
// F1 (24/11): operação → ferramentas do catálogo central do MOVA CORE que a usam (linguagem natural, laço de ferramentas)
const NA_F1 = new Map();
for (const f of FERRAMENTAS) for (const op of f.ops ?? []) NA_F1.set(op, [...(NA_F1.get(op) ?? []), f.nome]);

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..", "..", "..");
const bruto = execFileSync(process.execPath, [join(AQUI, "inventarioCapacidades.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const inventario = JSON.parse(bruto.slice(0, bruto.indexOf("\nTAP version") >= 0 ? bruto.indexOf("\nTAP version") : undefined));

const classe = new Map();
for (const linha of readFileSync(join(RAIZ, "docs", "mova-matriz-capacidades.md"), "utf8").split("\n")) {
  const m = /^\|\s*`([A-Za-z]+)`\s*\|\s*([^|]+)\|\s*(LEITURA|ADMINISTRATIVA|FINANCEIRA|CRITICA)\s*\|\s*([^|]*)\|\s*([^|]*)\|/.exec(linha);
  if (m) classe.set(m[1], { capacidade: m[2].trim(), classe: m[3], movaHoje: m[5].trim() });
}

// Fase do MOVA CORE em que cada classe entra (plano aprovado 24/11).
const FASE = { LEITURA: "F1 (catálogo de leitura)", ADMINISTRATIVA: "F3 (escritas administrativas com política)", FINANCEIRA: "F4 (escritas financeiras com política e evidência)" };
// Escritas que hoje só nascem como PROPOSTA (aplicação humana no Dashboard): parcial, não autônoma.
const SO_PROPOSTA = new Set(["registrarObrigacao", "registrarDespesaPaga", "aplicarProposta", "aprovarProposta", "aprovarEAplicarProposta"]);

const linhas = inventario.operacoes.map(({ operacao, arquivo, permissoes }) => {
  const c = classe.get(operacao);
  let situacao, como;
  if (OPERACOES_PERMITIDAS.includes(operacao)) { situacao = "DISPONIVEL"; como = "leitura (identidade de leitura)"; }
  else if (OPERACOES_DE_ESCRITA[operacao]) { situacao = "DISPONIVEL"; como = `escrita estreita (${[].concat(OPERACOES_DE_ESCRITA[operacao]).join(" + ")}, concessão + política + chave)`; }
  else if (SO_PROPOSTA.has(operacao)) { situacao = "PARCIAL"; como = "só proposta; aplicação humana no Dashboard"; }
  else if (!c) { situacao = "RESTRITA"; como = "sem classificação de risco ⇒ proibida até classificar"; }
  else if (c.classe === "CRITICA") { situacao = "RESTRITA"; como = "CRÍTICA: só aprovação humana no Dashboard"; }
  else { situacao = "PLANEJADA"; como = FASE[c.classe]; }
  return { operacao, modulo: (arquivo ?? "?").replace(/^aplicacao\//, "").replace(/\.js$/, ""), classe: c?.classe ?? "—", permissoes: permissoes.join(", ") || "—", situacao, como, f1: (NA_F1.get(operacao) ?? []).join(", ") || "—" };
});

const ferramentasAgente = readdirSync(join(RAIZ, "backend", "src", "modules", "agente", "tools")).filter((f) => f.endsWith(".tool.js")).map((f) => f.replace(/\.tool\.js$/, "")).sort();

// Pedidos do negócio SEM operação no sistema (conferidos no núcleo em 24/11; não inventar recurso).
const INEXISTENTES = [
  ["Sangria para compra futura com PRESTAÇÃO DE CONTAS pendente", "tesouraria registra SANGRIA (registrarOperacaoDeCaixa) mas não há pendência de prestação de contas ligada à saída", "F4: criar a pendência no núcleo (migração FV2) antes de o MOVA usar"],
  ["Ligar despesa paga em dinheiro à SAÍDA de caixa e à sessão", "lancarSangriasComoDespesa existe para importações; não há vínculo explícito despesa ↔ movimento da sessão por comando", "F4: operação nova no núcleo, idempotente pela chave da saída"],
  ["Vínculo participante do WhatsApp ↔ usuário da plataforma", "o MOVA autoriza por participante_autorizado; não há ligação com o usuário/perfil da plataforma", "F2: tabela de vínculo + confirmação pelo próprio usuário"],
  ["Base de conhecimento aprovada (versão, origem, escopo, aprovador, revogação)", "não existe", "F5"],
];

const contagem = linhas.reduce((m, l) => ((m[l.situacao] = (m[l.situacao] ?? 0) + 1), m), {});
const porModulo = {};
for (const l of linhas) { const m = (porModulo[l.modulo] ??= {}); m[l.situacao] = (m[l.situacao] ?? 0) + 1; }
const ORDEM = ["DISPONIVEL", "PARCIAL", "PLANEJADA", "RESTRITA"];

let md = `# MOVA CORE — matriz de cobertura (F0 + F1)\n\nGerada por \`backend/scripts/mova/matrizCobertura.mjs\` (não editar à mão). Fontes: inventário do núcleo, classificação de risco, portas do MOVA e ferramentas do Agente Crescer.\n\n`;
md += `## Resumo\n\n| Situação | Operações |\n|---|---|\n${ORDEM.map((s) => `| ${s} | ${contagem[s] ?? 0} |`).join("\n")}\n| INEXISTENTE (pedido sem operação) | ${INEXISTENTES.length} |\n| **Total do núcleo** | **${linhas.length}** |\n\n`;
const comF1 = linhas.filter((l) => l.f1 !== "—");
const locais = FERRAMENTAS.filter((f) => !f.ops?.length);
md += `## F1 — catálogo central de ferramentas\n\n${comF1.length} operações de leitura do núcleo atendidas por ${FERRAMENTAS.length - locais.length} ferramentas do catálogo, mais ${locais.length} locais (${locais.map((f) => f.nome).join(", ")}). Nenhuma escrita: \`preparar_registro\` só entende e prepara (executado:false). Operações CRÍTICAS e escritas continuam fora do catálogo.\n\n| Ferramenta | Operações do núcleo | Valores |\n|---|---|---|\n${FERRAMENTAS.map((f) => `| \`${f.nome}\` | ${(f.ops ?? []).join(", ") || "local"} | ${f.valores ? "sim" : "não"} |`).join("\n")}\n\n`;
md += `## Por módulo do núcleo\n\n| Módulo | ${ORDEM.join(" | ")} |\n|---|${ORDEM.map(() => "---").join("|")}|\n${Object.entries(porModulo).sort().map(([m, c]) => `| ${m} | ${ORDEM.map((s) => c[s] ?? 0).join(" | ")} |`).join("\n")}\n\n`;
md += `## Ferramentas de leitura do Agente Crescer (fora do núcleo financeiro)\n\nHoje só no Agente Crescer (painel web). Situação para o MOVA: **PLANEJADA (F1)**, reaproveitadas como ferramentas de leitura com o mesmo escopo de unidade.\n\n${ferramentasAgente.map((f) => `- \`${f}\``).join("\n")}\n\n`;
md += `## Pedidos sem operação no sistema (INEXISTENTE)\n\n| Pedido | O que existe hoje | Caminho |\n|---|---|---|\n${INEXISTENTES.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n\n`;
md += `## Operação por operação\n\n| Operação | Módulo | Classe | Permissões | Situação | Como / quando | Ferramenta F1 |\n|---|---|---|---|---|---|---|\n${linhas.map((l) => `| \`${l.operacao}\` | ${l.modulo} | ${l.classe} | ${l.permissoes} | ${l.situacao} | ${l.como} | ${l.f1} |`).join("\n")}\n`;

const destino = join(RAIZ, "docs", "mova-core", "02-matriz-cobertura.md");
writeFileSync(destino, md);
console.log(JSON.stringify({ total: linhas.length, ...contagem, INEXISTENTE: INEXISTENTES.length, ferramentasAgente: ferramentasAgente.length }));
