// PRÉ-VISUALIZAÇÃO do relatório diário do grupo interno — SÓ LEITURA.
// Lê pendencias() e os avisos individuais de hoje, monta o texto e IMPRIME. Não reserva chave, não grava nada, não envia nada.
//
// Rodar (de backend/): node --env-file=.env scripts/ifood-relatorio-grupo-preview.mjs [--agora=2026-10-08T19:30:00Z]

import { pendencias } from "../src/modules/administrativo/administrativo.service.js";
import { avaliarHorarioDoRelatorio, montarRelatorio, unidadesAvisadasHoje, chaveRelatorio } from "../src/modules/comunicacao/relatorioDashboardGrupo.js";
import { grupoInternoJidDoAmbiente, mascararJidGrupo } from "../src/modules/comunicacao/comunicacao.grupoInterno.js";

const arg = process.argv.find((a) => a.startsWith("--agora="));
const agora = arg ? new Date(arg.slice("--agora=".length)) : new Date();
const h = avaliarHorarioDoRelatorio(agora);
const snapshot = await pendencias({ hojeIso: h.dataLocal });
const avisadas = await unidadesAvisadasHoje({ agora }).catch(() => null);
const { texto, resumo } = montarRelatorio({ snapshot, avisadasHoje: avisadas, dataLocal: h.dataLocal, horaLocal: h.horaLocal });
const jid = grupoInternoJidDoAmbiente();

console.log(JSON.stringify({ situacaoHorario: h.situacao, dataLocal: h.dataLocal, chave: jid ? chaveRelatorio(h.dataLocal, mascararJidGrupo(jid)) : null, caracteres: texto.length, ...resumo }, null, 1));
console.log("\n----- MENSAGEM (não enviada) -----\n");
console.log(texto);
process.exit(0);
