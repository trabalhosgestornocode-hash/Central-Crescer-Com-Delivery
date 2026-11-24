// 24/11 — investigação das 9 falhas permanentes de 23/11: 2 delas vieram da conversa PRIVADA DERIVADA (OPERACAO) de um participante
// autorizado. Em produção essa conversa não tem linha em mova.grupo_autorizado (ela nasce da lista, em validarConfiguracao), e o
// registro automático de participante (FK para grupo_autorizado) derrubava a mensagem inteira: ERRO_PERMANENTE, sem resposta.
// A conversa privada não é grupo: não há membro a registrar (o retrato de membros é dos GRUPOS).
import assert from "node:assert/strict";
import { ESTRANHO, FIN, cenario, gw, t } from "./helpers/operacao.js";

t("PD-01 conversa privada derivada SEM linha em grupo_autorizado (como em produção): a mensagem é tratada, não falha", async () => {
  const s = await cenario();
  // estado de produção: só os GRUPOS estão gravados; a privada derivada existe só na configuração
  await s.banco.pool.query("delete from mova.participante where grupo_jid = $1", [FIN]);
  await s.banco.pool.query("delete from mova.participante_autorizado where grupo_jid = $1", [FIN]);
  await s.banco.pool.query("delete from mova.grupo_unidade where grupo_jid = $1", [FIN]);
  await s.banco.pool.query("delete from mova.grupo_autorizado where grupo_jid = $1", [FIN]);
  const r = await s.enviar(gw({ texto: "quais contas vencem hoje na alfa?", grupo: FIN }));
  assert.notEqual(r?.decisao, "FALHOU");
  const fila = (await s.banco.pool.query("select estado, ultimo_erro from mova.fila order by criado_em desc limit 1")).rows[0];
  assert.notEqual(fila?.estado, "FALHOU", JSON.stringify(fila));
  const h = await s.ultima();
  assert.ok(h && h.decisao !== "FALHOU", JSON.stringify(h));
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.participante where grupo_jid = $1", [FIN])).rows[0].n, 0, "privada não registra membro");
});

t("PD-02 DESCONHECIDO no privado: a correção não concede acesso — sem conversa derivada, sem valores, sem vínculo criado", async () => {
  const s = await cenario();
  const antes = (await s.banco.pool.query("select count(*)::int n from mova.participante_autorizado")).rows[0].n;
  await s.enviar(gw({ texto: "quais contas vencem hoje na alfa?", grupo: ESTRANHO, de: ESTRANHO }));
  const textos = (await s.saida()).map((m) => m.texto).join("\n");
  assert.doesNotMatch(textos, /R\$\s?\d/, "nenhum valor sai para quem não está na lista");
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.participante_autorizado")).rows[0].n, antes, "nenhuma autorização nova");
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.participante where grupo_jid = $1", [ESTRANHO])).rows[0].n, 0);
});

t("PD-03 OUTRA PESSOA escrevendo na conversa derivada de FIN (JID diferente do dono) não é tratada como o dono", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: "quais contas vencem hoje na alfa?", grupo: FIN, de: ESTRANHO }));
  const textos = (await s.saida()).map((m) => m.texto).join("\n");
  assert.doesNotMatch(textos, /R\$\s?\d/);
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.participante_autorizado where $1 = any(ids)", [ESTRANHO])).rows[0].n, 0);
});
