# 37 — D-1: integração da consolidação por telefone com o lote (DESLIGADA, não conectada ao worker)

Branch `feat/d1-consolidacao-integracao`, empilhada sobre o PR #64 (`proto/d1-consolidacao-por-telefone`). **Nada muda em produção**: cotas globais, `processarJobReivindicado` e o envio atual não foram tocados; nenhum código de produção importa o módulo (teste). Com a flag `COMUNICACAO_CONSOLIDACAO_POR_TELEFONE` ausente/`false`, `processarLoteConsolidado` devolve `null` sem chamar porta alguma.

## 1. O que foi construído
`comunicacao.consolidacao.integracao.js` — o **protocolo** de um lote já reivindicado, por telefone (`job.contato_id`), contra portas que espelham as fases reais do pipeline:

`avaliar` (portões, sem efeito) → `relerEstado` (autorização atual) → `reservar` (capacidade atômica; nasce o attempt) → `enviar` (um envio por mensagem) → `finalizar`.

O texto só contém blocos que passaram pelas três primeiras etapas. Telefone com um único job (ou sem contato) segue o fluxo individual de hoje sem tocar nenhuma porta.

## 2. Provas (15 testes + propriedade)
| Pedido | Prova |
|---|---|
| Flag desligada = nada muda | `null` e zero chamadas às portas; nenhum arquivo de produção referencia a consolidação; o módulo só importa `comunicacao.consolidacao.js` |
| 7 destinatários multiempresa | um envio com os 7 relatórios completos (título `*empresa — unidade*` + conteúdo byte a byte); os 7 `SENT` com o mesmo provider id |
| Nenhum relatório omitido | **conservação**: 300 cenários aleatórios (semente fixa) — todo job termina em exatamente um destino; componente em uma única mensagem; conteúdo completo; excluído/barrado/não reservado nunca aparece em texto algum |
| Autorização revalidada no envio | revogado, categoria desabilitada, opt-out, empresa desabilitada/pausada entre agendar e enviar ⇒ sem reserva, sem texto, sem finalização |
| Falhas | pré-envio provado ⇒ `RETRY` para cada componente (volta ao fluxo individual); dúvida (timeout/5xx) ⇒ todos `DELIVERY_UNKNOWN`, **uma** chamada só, nunca reenvio; falha ao finalizar um componente não reenvia nem derruba os outros; falha ao reler estado ⇒ o job volta ao individual; falha de reserva ⇒ fora do texto; um telefone falhar não afeta outro |
| Tamanho | não cabe numa mensagem ⇒ várias, ids disjuntos, chaves distintas, nada cortado, nenhuma passa de 4096 |

Regressão do backend com ambiente fictício: 5887 testes, 24 falhas — as **mesmas 24** da `main` (nenhuma em consolidação).

## 3. Decisão material: o teto por telefone (não alterado)
O teste mostra os dois comportamentos sobre o mesmo pipeline falso:
- **Semântica atual** (cada componente reservado conta no teto de 3/dia): só 3 dos 7 reservam; 4 ficam `NAO_RESERVADO (RATE_LIMIT_DIA)`. Ou seja, **consolidar sem decidir o teto não resolve o problema do D-1**.
- **Mensagem consolidada conta uma vez**: os 7 saem juntos; o telefone consome 1 do teto.

Mudar o significado de `max_por_contato_por_dia` é decisão de política e **não foi feita**; o teto global (3) segue intacto.

## 4. O que falta para um adaptador de produção (todas dependem de autorização específica)
1. **Extrair** os portões e o snapshot de política de `processarJobReivindicado` para uma função reutilizável (`avaliar`), mantendo o caminho individual **idêntico byte a byte** com a flag desligada. Os testes do pipeline são de integração com banco (não rodam localmente): exigem o projeto de teste para provar a equivalência.
2. **Decidir o teto** (seção 3) e como `reservarEnvio` conta a consolidada (`ctx.consolidado`).
3. **Estados dos componentes absorvidos**: `SENT` com o mesmo provider id e `consolidadaEm = chave` (coluna/metadata a definir).
4. Dry-run no D-1 e teste no projeto de teste antes de qualquer envio real; validar o formato do texto com as empresas.

## 5. Arquivos
`backend/src/modules/comunicacao/comunicacao.consolidacao.integracao.js`; `backend/test/comunicacao-consolidacao-integracao.test.js`.
