# 37 — D-1: consolidação por telefone conectada ao pipeline (flag DESLIGADA; migration 140 preparada, não aplicada)

PR #66 (empilhado no #64, atualizado com a `main`). Com `COMUNICACAO_CONSOLIDACAO_POR_TELEFONE` ausente/`false` o envio é o de hoje: o único código novo no caminho é `if (consolidacaoLigada(process.env))` em `processarProximoLote` e um hook `preparoDeEnvio = null` em `processarJobReivindicado` (a chamada de reserva virou a closure `reservar()` com os mesmos parâmetros; nenhum limite, política ou texto mudou).

## Como funciona (flag ligada)
1. Jobs reivindicados do mesmo telefone (`contato_id`) formam um grupo; telefone sem par segue o fluxo individual.
2. Cada job passa por **todos os portões de hoje** (TTL, alerta, política, janela, duplicidade, reforço/tardio) e **de novo imediatamente antes de reservar** (revogação, opt-out, pausa e categoria valem até o último instante). Barrado/adiado/cancelado = resultado de hoje, fica fora do texto.
3. **Reserva atômica por mensagem física**, com a chave da consolidação (migration 140): as linhas da mesma chave contam **uma** vez no teto de 3/dia por telefone e nas taxas por minuto. Cooldown, limite por organização e teto global (3) inalterados.
4. **Um envio** ao gateway por mensagem (relatórios completos, título `*empresa — unidade*`, chave `cons:<hash>`); depois `SENT` por componente com o mesmo provider id.
5. Falha: pré-envio provada ⇒ retry de cada componente (classificação de hoje); dúvida ⇒ `DELIVERY_UNKNOWN`, nunca reenvio; falha ao gravar `SENT` não reenvia.

## Evidências
| Prova | Resultado |
|---|---|
| Migration 140 no PostgreSQL descartável (`testes-seguros/pg/consolidacao_140.sh`): chave nula idêntica à 104; 7 componentes = 1 vaga; 4ª mensagem física barrada; cooldown/minuto; **concorrência** (7 paralelas da mesma chave, 8 individuais, 2 grupos + 4 individuais: nunca >3 físicas, grupos nunca pela metade); rollback restaura o corpo da 104 (md5 igual); reaplicação | **27/27** |
| Adaptador contra o **gateway simulado** (`comunicacao-consolidacao-pipeline.test.js`): 7 relatórios completos em 1 envio, mesmos parâmetros da reserva, SENT com mesmo provider id, revogação na releitura, teto/limites, falha pré-envio/ambígua/desconectado, dois workers (cada relatório sai uma vez), nome indisponível (fail-closed), relatório gigante | 16/16 |
| Coordenador + propriedade de conservação (300 cenários), coordenador, orquestrador, puro | 48/48 |
| Regressão do backend (ambiente fictício) vs `main` | 5929 testes, **24 falhas = as mesmas da `main`**, 0 novas |

## Limites do que foi provado
- O pipeline completo com banco (suítes `comunicacao-*-integracao`) só roda no projeto de teste, sem credenciais nesta máquina: **não foi executado**; a equivalência com a flag desligada se apoia na diff mínima + 125 testes estruturais/unitários do pipeline verdes.
- Dois workers com posse velha sobre os mesmos jobs não duplicam relatório (CAS da reserva), mas podem dividir o grupo em duas mensagens com a mesma chave (conta uma vaga). Os claims são exclusivos; é o caso de lease vencido.

## Ordem segura de implantação (depende de autorização)
Merge #65 → #64 → #66 (deploy inerte) → migration 140 (aditiva; rollback pronto) → conferir `/health` → ligar a flag **só depois**, com acompanhamento do D-1. Com a flag ligada e a 140 ausente, a reserva falha fechada (nada é enviado; os jobs voltam pelo lease).
