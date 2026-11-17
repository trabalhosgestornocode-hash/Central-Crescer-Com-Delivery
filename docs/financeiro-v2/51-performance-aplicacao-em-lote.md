# 51 — Performance da aplicação de propostas em lote (17/11/2026)

> Documento público, com dados sintéticos e nenhum valor real. Nada foi publicado: sem push, deploy, migração ou
> alteração na Render ou no Supabase.

## 1. Problema
Na correção de 16/11, aplicar 825 vendas levou cerca de 1 hora em produção, de 4 a 6 s por venda. As causas:
- **Conferência do dia lida uma venda por vez.** O conflito de granularidade lia uma a uma as vendas das propostas já aplicadas no mesmo dia. Num dia com cerca de 55 vendas, cada venda nova fazia ~55 leituras.
- **Duas transações por venda.** Aprovar e aplicar eram transações separadas, cada uma com início, sessão de banco, travas, releituras e fim.
- **Distância entre os servidores.** O backend está na Render em **Ohio** e o Supabase em **Oregon** (`us-west-2`). Cada consulta custa uma ida e volta de ~60 ms.
  - Antes: ~66 consultas × ~65 ms ≈ 4,3 s, o que bate com o observado.

## 2. O que mudou (branch `perf/fv2-aplicar-propostas`)
1. **`semVendaCancelada`:** as vendas das propostas são lidas numa **consulta por lote de ids** (`paginar` com `em: { id }` e `situacao = CANCELADA`, até 500 por consulta). A regra é a mesma: proposta de venda cancelada não bloqueia.
2. **`aprovarEAplicarProposta`:** aprovar e aplicar **na mesma transação**.
   - Mesmos códigos de regra: os corpos foram extraídos para `aprovarNaTransacao`, `travarParaAplicar` e `aplicarNaTransacao`, e as operações separadas continuam iguais.
   - Mesmas travas: `formacao-competencia` e `formacao-dia`, tomadas **antes** da aprovação.
   - Mesmo histórico: os eventos `APROVADA` e depois `APLICADA`.
   - Exige **APROVAR e APLICAR**, conferidas no contexto e na concessão gravada.
   - O banco grava pela ação `aplicar`, que a matriz da 0013 já permite em `fv2_proposta`. Não há migração.
   - Se a aplicação falha, a aprovação também é desfeita: a proposta volta a ficar pronta.
   - A proposta já lida depois das travas é reaproveitada, e a barreira de corte não é conferida duas vezes na mesma transação.
3. **A rota `/propostas/aprovar-e-aplicar-prontas`** usa a operação combinada para propostas no estado `PROPOSTA`. As já aprovadas seguem pelo caminho antigo de só aplicar.

## 3. Revisão
- **Regras financeiras:** inalteradas. Os mesmos recusos valem: corte da abertura, conflito de granularidade, faturamento provisório, duplicidade de efeito anterior, vínculo Stone ausente e proposta em revisão sem justificativa.
- **Atomicidade:** uma transação por venda. Uma venda nunca fica pela metade, e uma falha não afeta as outras do lote, que são registradas em `falhas`.
- **Concorrência:** a trava por competência continua serializando as vendas do mês, por regra do doc 34. Não há paralelismo novo.
- **Deduplicação:** repetir o lote aplica 0 e não cria venda. A proposta já `APLICADA` devolve `repetido`.
- **Permissões e auditoria:** as duas ações são exigidas e os dois eventos ficam no histórico, testados.
- **Outros módulos:** só `formacao.js` e a rota de lote mudaram. As operações `aprovarProposta` e `aplicarProposta`, usadas por outras telas, mantêm o comportamento, com a suíte inteira passando.
- **Compatibilidade:** a branch parte da `main` atual (`234b6fd`), sem conflito.

## 4. Medições (PostgreSQL local, `scripts/fv2/benchLote.mjs`, dados sintéticos)
Cenário: 480 vendas por pedido, 60 por dia, 8 dias, com **10 ms simulados por consulta**.

| | Antes (`main`) | Depois |
|---|---:|---:|
| Consultas por venda | 63,9 (1º lote) e 70,0 (2º lote; cresce com o dia) | **32,4 constantes** |
| Tempo por venda (10 ms por consulta) | 796–854 ms | **398–400 ms** |
| Lote de 400 vendas | 318 s | **159 s** |
| 480 vendas | 387 s | **191 s** |
| Falhas | 0 | 0 |
| Repetir o lote | 0 aplicadas (12 consultas) | 0 aplicadas (12 consultas) |
| Vendas ativas e total | 480, valores iguais | 480, valores iguais |
| Duplicadas | 0 | 0 |

**Projeção para produção** (~65 ms por consulta, Ohio × Oregon; projeção, não medição):
- antes: ~4,3 s por venda, ou ~60 min para 825 (observado: ~1 h);
- depois: **~2,1 s por venda, ou ~30 min para 825**.

**Testes:** suíte do Financeiro v2 com **540 de 540 em memória e 537 de 537 no PostgreSQL local**. Ela inclui `aprovar-e-aplicar-proposta.test.js`, que cobre:
- resultado igual ao do caminho antigo;
- repetir sem duplicar;
- exigência das duas permissões;
- falha que desfaz a aprovação.

## 5. Riscos
- **Aprovação desfeita com a falha:** quando a aplicação falha, a proposta volta para `PROPOSTA` em vez de ficar `APROVADA`. A rota trata os dois estados como "prontas", então nada se perde.
- **Reinício do servidor no meio do lote:** como aconteceu em 17/11, o lote corrente é interrompido. As vendas já gravadas ficam e as demais continuam prontas para o próximo clique. Não há risco de duplicar.
- **Lote de 400 em produção:** ainda leva ~14 min. A tela precisa avisar o tempo, ou o lote precisa ser menor (item 6).

## 6. Melhorias adicionais possíveis (não feitas)
- **Histórico em uma única inserção:** hoje são 6 inserções por venda. Juntar no fim da transação economiza ~5 idas ao banco. A condição é gravar tudo antes do COMMIT, porque a verificação de histórico é feita no commit.
- **Leituras repetidas por transação:** categoria, competência e abertura. Guardá-las durante a transação corta mais ~3–4.
- **Lote menor com progresso na tela:** por exemplo 100 por clique, com barra de progresso. Não acelera, mas evita pedidos longos e torna a interrupção visível.
- **Função no banco que aplica a venda numa só ida:** maior ganho de código, mas reescreve regra já homologada. Não recomendado agora.

## 7. Região dos servidores
**Situação atual:**
- `crescercomdelivery` (web) e `gateway-whatsapp` (serviço privado) estão em **Ohio**.
- O Supabase está em **Oregon**.
- `atlaz-os` está em Virginia e `financeiro-amanda` está suspenso; nenhum dos dois faz parte da plataforma.

| Opção | Latência por consulta | Esforço e risco |
|---|---|---|
| Manter (só a otimização de código) | ~60–65 ms | nenhum |
| **Novo serviço Render em Oregon** e troca do domínio | ~1–3 ms (mesma região da AWS) | médio |
| Mover o Supabase para Ohio | ~1–3 ms | **alto**: projeto novo e migração completa de banco, autenticação, storage e realtime. Não recomendado |

**Pontos do serviço em Oregon** (a confirmar com a Render e o proprietário antes de qualquer passo):
- **A região não muda num serviço existente.** É preciso criar outro serviço, com a mesma branch e o mesmo `rootDir`, e copiar as variáveis de ambiente. O preço do plano não depende da região, mas há custo do serviço duplicado durante a transição.
- **O `gateway-whatsapp` depende da rede privada.** Ele fala com o backend por `WHATSAPP_BACKEND_URL`. Se esse endereço for o privado da Render, que só vale dentro da mesma região, o gateway precisa mudar junto ou passar a usar o endereço público. A sessão do WhatsApp usa um sistema de "lease" para ter uma única instância ativa e precisa de atenção na troca.
- **Trabalhos de fundo:** o backend roda o worker de comunicação (WhatsApp) e a consulta de eventos do iFood. **Dois backends ativos ao mesmo tempo duplicariam envios e consultas.** O serviço novo precisa subir com esses trabalhos desligados até o domínio ser trocado, e o antigo ser desligado logo depois.
- **IPs de saída mudam por região.** Conferir se algum parceiro (iFood, Foody ou outro) restringe por IP.
- **Domínio:** `centralcrescercomdelivery.com.br` passa por proxy. A troca é feita no destino do domínio, com o TTL baixo antes.
- **Benefício:** vale para **toda** a plataforma, porque toda tela que lê o Supabase fica mais rápida. A importação de 825 vendas passaria de ~30 min para poucos minutos.

**Procedimento sugerido** (nada executado; precisa de autorização própria):
1. Inventário das variáveis de ambiente e dos endereços entre serviços, feito pelo proprietário.
2. Criar o serviço em Oregon com os trabalhos de fundo desligados. Conferir `/health` e as leituras.
3. Janela de baixo movimento: desligar os trabalhos no serviço antigo, trocar o domínio, ligar os trabalhos no novo e acompanhar os logs.
4. Mover ou reapontar o gateway do WhatsApp, se depender da rede privada.
5. **Reversão:** devolver o domínio ao serviço de Ohio, que segue intacto até a estabilização, e religar os trabalhos lá.
6. Desativar o serviço de Ohio só depois de alguns dias estáveis.

**Recomendação:** publicar a otimização de código agora, porque já reduz o tempo pela metade sem risco de infraestrutura. Planejar a mudança para Oregon como projeto separado, com janela e checklist próprios, porque ela afeta a plataforma inteira.

## 8. Publicação desta otimização (com autorização)
1. Push da branch e abertura do PR.
2. Conferir que a `main` não mudou. Se mudou, refazer a fusão e rodar as suítes.
3. Merge, que dispara o auto-deploy da Render.
4. Conferir `/health`, os logs e a ausência de 5xx.
5. Não há migração e nenhum dado muda.
6. **Validação:** na próxima importação real, cronometrar um lote e conferir os totais e as falhas.
7. **Reversão:** voltar ao deploy anterior na Render. Não há mudança de banco.

**Cuidado:** não fazer merge de outro PR enquanto um lote estiver sendo aplicado, porque o reinício interrompe o lote.
