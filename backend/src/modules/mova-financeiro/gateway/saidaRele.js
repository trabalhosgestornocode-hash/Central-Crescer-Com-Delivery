// MOVA — Execução 15B: TRANSPORTE DE SAÍDA pelo relé de homologação. O Gateway é um serviço privado (inalcançável daqui):
// o backend só PUBLICA a resposta na fila `mova_rele.saida` (id = id da resposta, idempotente) e depois LÊ o resultado que o
// Gateway confirmou. Papel: mova_rele_consumidor (só executa publicar_saida / estado_saidas / definir_saida).
export const ESTADOS_FINAIS_RELE = Object.freeze(["ENVIADA", "INCERTA", "FALHOU", "CANCELADA"]);

/** @param {{pool:{query:Function}}} deps  pool do relé (MOVA_RELE_DATABASE_URL) */
export function criarSaidaPeloRele({ pool }) {
  if (!pool?.query) throw new TypeError("saída pelo relé exige o pool do relé");
  return Object.freeze({
    /** Publica (ou reconhece) a saída; devolve o estado atual no relé. */
    async publicar({ id, destino, texto }) {
      return (await pool.query("select mova_rele.publicar_saida($1::uuid, $2, $3) as e", [id, destino, texto])).rows[0].e;
    },
    async estados(ids) {
      if (!ids.length) return [];
      return (await pool.query("select id, estado, provider_message_id as \"providerMessageId\", codigo from mova_rele.estado_saidas($1::uuid[])", [ids])).rows;
    },
    /** Liga/desliga a saída no relé (desligar cancela as pendentes lá). */
    async definir(ligado, ator) { return (await pool.query("select mova_rele.definir_saida($1, $2) as n", [ligado, ator])).rows[0].n; },
  });
}
