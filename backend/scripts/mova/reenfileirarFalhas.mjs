// KIT — REENFILEIRAR mensagens privadas do MOVA recusadas ANTES do envio (ex.: 23/11/2026, Gateway sem os entregadores na
// lista fechada WHATSAPP_MOVA_PRIVADOS ⇒ WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED). GERA o SQL para revisar e aplicar; não executa.
// Só reabre mensagens FALHOU com aquele erro, naquela janela, para destino PRIVADO e com no máximo UMA tentativa (nada que já tenha
// saído). Nenhum envio novo é criado: a mesma mensagem volta à fila e o enviador a entrega uma vez (limites e marco valem).
// Uma linha de auditoria registra quem, por quê, quantas e quais ids (sem texto nem número).
//
// Uso: node scripts/mova/reenfileirarFalhas.mjs --erro WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED --de 2026-11-23T18:50:00Z \
//        --ate 2026-11-23T19:00:00Z --esperadas 8 --ator "<quem autorizou>" --motivo GATEWAY_SEM_PRIVADOS
import { fileURLToPath } from "node:url";

const literal = (t) => `'${String(t).replace(/'/g, "''")}'`;

export function sqlReenfileirarFalhas({ erro, de, ate, esperadas, ator, motivo }) {
  if (!/^[A-Z0-9_]{3,80}$/.test(erro ?? "")) throw new Error("Código de erro inválido.");
  if (!/^[A-Z0-9_]{3,40}$/.test(motivo ?? "")) throw new Error("Motivo inválido (CÓDIGO).");
  if (Number.isNaN(Date.parse(de)) || Number.isNaN(Date.parse(ate)) || Date.parse(ate) <= Date.parse(de) || Date.parse(ate) - Date.parse(de) > 86_400_000) throw new Error("Janela inválida (até 24 h).");
  if (!Number.isSafeInteger(esperadas) || esperadas < 1 || esperadas > 100) throw new Error("Informe --esperadas (1 a 100).");
  if (typeof ator !== "string" || ator.trim().length < 3) throw new Error("Informe --ator.");
  const filtro = `estado = 'FALHOU' and ultimo_erro = ${literal(erro)} and tentativas <= 1 and grupo_jid like '%@s.whatsapp.net'
     and criada_em between ${literal(de)}::timestamptz and ${literal(ate)}::timestamptz`;
  return `-- MOVA — reenfileirar ${esperadas} mensagem(ns) privada(s) recusada(s) antes do envio (${erro}). Revisar antes de aplicar.
begin;
do $$ declare n int; begin
  select count(*) into n from mova.resposta where ${filtro};
  if n <> ${esperadas} then raise exception 'MOVA: esperadas % mensagens, encontradas % — nada foi feito', ${esperadas}, n; end if;
end $$;
with r as (update mova.resposta set estado = 'PENDENTE', ultimo_erro = ${literal(`REENFILEIRADA:${motivo}`)}, lease_ate = null
            where ${filtro} returning id)
insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados)
select 'RESPOSTAS_REENFILEIRADAS', 'USUARIO', ${literal(ator.trim().slice(0, 80))}, 'resposta',
       jsonb_build_object('motivo', ${literal(motivo)}, 'erro', ${literal(erro)}, 'quantidade', count(*), 'ids', jsonb_agg(id)) from r;
select estado, count(*) from mova.resposta where criada_em between ${literal(de)}::timestamptz and ${literal(ate)}::timestamptz group by 1;
commit;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    process.stdout.write(sqlReenfileirarFalhas({ erro: val("--erro"), de: val("--de"), ate: val("--ate"), esperadas: Number(val("--esperadas")), ator: val("--ator"), motivo: val("--motivo") }));
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
