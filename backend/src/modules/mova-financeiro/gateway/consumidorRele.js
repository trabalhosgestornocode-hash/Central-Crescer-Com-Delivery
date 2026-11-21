// MOVA — CONSUMIDOR do relé de homologação (Execução 11). Lê a fila durável mova_rele (banco de HOMOLOGAÇÃO) com o papel
// mova_rele_consumidor e entrega cada evento ao RECEPTOR MOVA existente — o mesmo de sempre (dedupe por evento, filtros de
// conversa, fila do MOVA, motor). Não há outro motor: o relé só transporta.
//
// Por evento reservado (lease): confere de novo o sha256 e a ASSINATURA ORIGINAL do Gateway com o segredo do canal (sem a
// janela de tempo — a frescura já foi conferida na chegada), entrega ao receptor e só então confirma no relé:
//   ENFILEIRADO | DUPLICADO | IGNORADO (filtros) ⇒ confirmar (o MOVA já persistiu ou descartou de propósito)
//   RECUSADO (contrato)                           ⇒ falha definitiva (não adianta repetir)
//   INDISPONIVEL / RECEBIMENTO_DESLIGADO / erro   ⇒ nova tentativa (o evento NÃO se perde)
// Suspensão/recebimento desligado no controle ⇒ não reserva nada: os eventos esperam no relé, intactos.
// Confirmação perdida depois de entregar ⇒ o lease vence, outro ciclo reserva de novo e o receptor responde DUPLICADO.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const hex = (b) => createHash("sha256").update(b).digest("hex");
const iguais = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Confere integridade + assinatura original do Gateway. */
export function conferirEventoDoRele(r, segredo) {
  if (hex(r.corpo) !== r.sha256) return "INTEGRIDADE";
  const msg = [r.assinatura_ts, r.assinatura_nonce, "POST", r.caminho, hex(r.corpo)].join("\n");
  if (!iguais(createHmac("sha256", segredo).update(msg).digest("hex"), r.assinatura)) return "ASSINATURA";
  return null;
}

/**
 * @param {{pool:{query:Function}, receptor:{receber:Function}, segredo:string, controle?:{ligado:Function}|null,
 *          consumidor?:string, lote?:number, leaseSegundos?:number, intervaloMs?:number, registrar?:Function}} deps
 */
export function criarConsumidorRele({ pool, receptor, segredo, controle = null, consumidor = `local-${process.pid}`, lote = 5, leaseSegundos = 60, intervaloMs = 3000, registrar = () => {} }) {
  if (!pool || !receptor?.receber || !segredo) throw new TypeError("consumidor do relé exige pool, receptor e segredo");
  let timer = null; let rodando = false;
  const devolver = (id, codigo, definitiva = false) => pool.query("select mova_rele.devolver($1, $2, $3, $4) as r", [id, consumidor, codigo, definitiva]).then((x) => x.rows[0].r);
  async function rodada() {
    if (controle && !(await controle.ligado("recebimento"))) return { pausado: true, entregues: 0 };
    const { rows } = await pool.query("select * from mova_rele.reservar($1, $2, $3)", [consumidor, lote, leaseSegundos]);
    let entregues = 0;
    for (const r of rows) {
      const erro = conferirEventoDoRele(r, segredo);
      if (erro) { await devolver(r.evento_id, `REJEITADO_${erro}`, true); registrar({ tipo: "MOVA_RELE_REJEITADO", codigo: erro }); continue; }
      let res;
      try { res = await receptor.receber(JSON.parse(r.corpo)); }
      catch { await devolver(r.evento_id, "RECEPTOR_ERRO"); continue; }
      if (res.status === "INDISPONIVEL" || res.motivo === "RECEBIMENTO_DESLIGADO") { await devolver(r.evento_id, res.motivo ?? "INDISPONIVEL"); continue; }
      if (res.status === "RECUSADO") { await devolver(r.evento_id, `RECUSADO_${String(res.motivo ?? "CONTRATO").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 60)}`, true); continue; }
      const ok = (await pool.query("select mova_rele.confirmar($1, $2) as ok", [r.evento_id, consumidor])).rows[0].ok;
      if (ok) entregues += 1; else registrar({ tipo: "MOVA_RELE_LEASE_PERDIDO" }); // outro consumidor retomou: o receptor deduplica
    }
    return { pausado: false, entregues, reservados: rows.length };
  }
  return Object.freeze({
    rodada,
    iniciar() {
      if (timer) return;
      timer = setInterval(async () => {
        if (rodando) return; rodando = true;
        try { await rodada(); } catch (e) { registrar({ tipo: "MOVA_RELE_INDISPONIVEL", codigo: e?.code ?? "ERRO" }); } finally { rodando = false; }
      }, intervaloMs);
      timer.unref?.();
    },
    parar() { if (timer) { clearInterval(timer); timer = null; } },
    resumo: async () => (await pool.query("select * from mova_rele.resumo()")).rows,
  });
}
