// Registro dos adaptadores de fonte. Uma importação sempre declara fonte + tipo de relatório: o arquivo é conferido
// contra AQUELE contrato (nunca "adivinhado" entre vários formatos).
import { CODIGO, falhar } from "../../dominio/erros.js";
import { FONTES_FOODY } from "./foody.js";
import { FONTES_IFOOD } from "./ifood.js";
import { FONTES_99FOOD } from "./noventaENoveFood.js";
import { FONTES_SAIPOS } from "./saipos.js";
import { FONTES_STONE } from "./stone.js";
import { FONTES_UNICRED } from "./unicred.js";

export const FONTES_PADRAO = Object.freeze([...FONTES_SAIPOS, ...FONTES_STONE, ...FONTES_IFOOD, ...FONTES_99FOOD, ...FONTES_FOODY, ...FONTES_UNICRED]);

export function criarRegistroDeFontes(fontes = FONTES_PADRAO) {
  const porTipo = new Map(fontes.map((f) => [f.tipoRelatorio, f]));
  return Object.freeze({
    buscar(fonte, tipoRelatorio) {
      const f = porTipo.get(tipoRelatorio);
      if (!f || f.fonte !== fonte) falhar(CODIGO.IMPORTACAO_INVALIDA, "Fonte ou tipo de relatório não suportado.", { fonte, tipoRelatorio });
      return f;
    },
    /** Quadro de compatibilidade (o que foi conferido com amostra real e o que é só contrato sintético). */
    compatibilidade: () => fontes.map((f) => ({ fonte: f.fonte, tipoRelatorio: f.tipoRelatorio, compatibilidade: f.compatibilidade, formatos: [...f.formatos], formatosHomologados: [...f.formatosHomologados], descricao: f.descricao })),
  });
}
