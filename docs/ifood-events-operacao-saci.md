# iFood Events — política de operação da Subway Saci

Complementa `ifood-events-piloto-escopo.md` (kill switch) e `ifood-order-conexao-sem-financial.md`.
Estado em 10/10/2026: dois pilotos supervisionados aprovados (recebimento de pedidos, detalhes, estados ao vivo,
conferência com o Gestor de Pedidos). Events desligado. Operação contínua **não** autorizada.

## O que o Events faz e o que não faz

- Enquanto `IFOOD_EVENTS_EMBEDDED_ENABLED=true`, a Central consulta o iFood a cada 30 s, 24 h por dia. Não existe
  horário de funcionamento na Central: **fechar o Gestor de Pedidos não desliga a consulta**.
- Essa consulta sinaliza a loja como conectada por este aplicativo. Se o Gestor for fechado com o Events ligado,
  a loja pode continuar aparecendo aberta no iFood sem ninguém atendendo.
- A Central não confirma, não despacha e não cancela pedidos. Isso continua no Gestor.

## Condições para o Events ficar ligado

1. Expediente da loja: 11h às 4h.
2. Gestor de Pedidos aberto e funcionando.
3. Alguém da operação acompanhando os pedidos.
4. Um responsável técnico alcançável para a parada emergencial.

Fora dessas condições, o Events fica desligado. Hoje isso é manual (ligar na abertura, desligar no fechamento).

## Parada emergencial

1. Confirmar que o Gestor de Pedidos está aberto (é ele que mantém a loja atendida).
2. Gravar `IFOOD_EVENTS_EMBEDDED_ENABLED=false` no Render (dispara deploy).
3. Considerar parado **somente** quando: o deploy estiver `live`, o `/health` responder `ifoodEvents: disabled`
   **e** o lease (`ifood_poller_lease`) tiver sido liberado ou parado de ser renovado, sem ciclo novo por 2 minutos.
4. O `/health` sozinho não basta: ele responde pela instância nova enquanto a antiga ainda pode estar no ar.

Com o comando de início corrigido (`node src/server.js`), a instância antiga para o poller e libera o lease ao
receber o sinal de encerramento. Com `npm start` ela só para ao ser morta à força (até ~90 s depois).

## Token

- O token do aplicativo de pedidos só é renovado quando usado, ou seja, com o Events ligado.
- O refresh token do iFood vale cerca de 7 dias. Se o Events ficar desligado por mais tempo que isso, o gestor
  precisa autorizar o aplicativo de novo em Integrações → iFood ("Reconectar pedidos").
- Credencial em `reauth_required` aparece no painel; o poller a pula sem chamar o iFood.

## Depois de uma interrupção

- Ao religar, o primeiro ciclo traz os eventos que o iFood guardou sem reconhecimento deste aplicativo (verificado:
  intervalo de 13 minutos recuperado por completo, inclusive a conclusão de um pedido que tinha ficado em aberto).
- O iFood guarda esses eventos por tempo limitado (algumas horas). Passado esse prazo, os pedidos do intervalo não
  chegam mais, e os que estavam em andamento ficam "ativos" na Central sem conclusão; o Checklist os sinaliza
  (alerta de pedido aberto há mais de 4 h) e avisa quando o recebimento está parado.
- Evento recebido duas vezes não duplica nada (deduplicação por identificador do evento).

## Evidências que faltam

**Para um expediente completo supervisionado**
- Comando de início corrigido em produção e encerramento conferido uma vez (lease liberado no deploy).
- Um deploy feito com o Events ligado, medindo o intervalo sem consulta.
- Renovação do token observada ao longo do expediente (o access token dura poucas horas).
- Fechamento da loja: definir e ensaiar a ordem "desligar o Events → fechar o Gestor".
- Virada da meia-noite no Checklist (o dia operacional vira às 00h; o expediente vai até as 4h).

**Para operação contínua ou automatizada**
- Horário de funcionamento na própria Central (ligar e desligar o poller sem deploy) — não existe hoje.
- Alerta quando o recebimento para sem ter sido desligado de propósito.
- Verificação da allowlist nas ações de pedido, antes de qualquer rota de ação.
- Vários dias seguidos sem intervenção, incluindo um reinício do serviço pelo Render.
