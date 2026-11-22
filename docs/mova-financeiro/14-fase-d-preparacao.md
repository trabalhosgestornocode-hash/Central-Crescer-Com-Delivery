# MOVA — Execução 15A: preparação da Fase D (conversa bidirecional), sem ativar envio

Modelo exclusivo: `claude-haiku-5-5`. Nenhuma chamada paga, nenhum envio pelo WhatsApp, nenhuma alteração no Gateway ou no Render.

## 1. Inspeção visual (Centro Financeiro de homologação, login real com senha + TOTP da conta fictícia)

As 3 propostas da Fase C aparecem corretas na Caixa de Entrada e em "Propostas e Aprovações":

| Proposta | Tipo | Valor | Competência | Datas | Categoria sugerida | Situação |
|---|---|---|---|---|---|---|
| `c5aecdc0` | Despesa paga | R$ 150,00 | 2026-11 | caixa 21/11/2026 | ENERGIA_ELETRICA | Aguardando revisão |
| `2017e319` | Nova conta a pagar | R$ 289,90 | 2026-12 | vence 05/12/2026 | INTERNET | Aguardando revisão |
| `9a40bc6d` | Despesa paga | R$ 420,00 | 2026-11 | caixa 21/11/2026 | EMBALAGENS | Aguardando revisão |

Revisão humana disponível: "Revisar categoria", "Conta do pagamento", Aprovar/Rejeitar. Em proposta já decidida, os botões
ficam desabilitados. Nada foi aprovado, aplicado ou alterado.

Defeitos de exibição corrigidos (`a6e7140`):
- **V-1:** em texto puro, "Dados extraídos" ficava vazio e a justificativa da IA não aparecia. Agora mostra intenção, confiança,
  justificativa e campos ausentes, guardados na proposta.
- **V-2:** origem "WhatsApp · MOVA" explícita.
- **V-3:** o duplicado dizia "Nenhuma proposta vinculada". Agora mostra "Duplicado da proposta c5aecdc0".

## 2. Respostas pendentes (40) — inventário e descarte

| Destino | Origem | Quantidade | Período | Tentativas |
|---|---|---|---|---|
| `5500…0777` (fictício, conversa DESATIVADA) | eventos sintéticos da 12A | 23 | 20/11 21:59 → 21/11 06:13 UTC | 0 |
| contato real autorizado (número só no ambiente) | testes reais da Fase C (Opus e Haiku) | 17 | 21/11 17:27 → 18:36 UTC | 0 |

Todas pertencem à homologação e nenhuma foi enviada. As 17 do contato real são as perigosas: com o envio ligado sem proteção,
sairiam todas de uma vez.

**Mecanismo (`c67839f`), sem DELETE:**
- `saida.suprimir({ criadasAte, motivo, ator })` muda o estado para `SUPRIMIDA` (já previsto no CHECK do banco), grava
  `ultimo_erro = SUPRIMIDA:<motivo>` e registra **uma** linha `RESPOSTAS_SUPRIMIDAS` em `mova.auditoria`: quem, por quê,
  quantas e os ids, sem texto nem número. Tudo numa transação. O worker só seleciona `PENDENTE`, então `SUPRIMIDA` nunca sai.
- **Defesa independente do descarte:** o envio exige `MOVA_ENVIO_NAO_ANTES_DE` (marco de ativação). Respostas criadas antes
  dele **não são sequer reservadas** (filtro no banco), e só vão para conversas **privadas** autorizadas (filtro no banco + segunda
  barreira no enviador). Sem marco, o enviador fica desligado mesmo com `envio=1`.

**Procedimento exato (NÃO executado — depende de aprovação específica):**
```
node --env-file=<.env.execucao da homologação> scripts/mova/suprimirRespostas.mjs \
     --criadas-ate=2026-11-21T19:00:00Z --motivo=TESTES_ANTERIORES_FASE_D --ator=<quem autorizou>
# prévia (só leitura): 23 + 17 = 40; código de confirmação d2102e65
# após aprovação:  ... --executar=d2102e65
```
O código muda se a lista mudar; nesse caso o script recusa.

## 3. Competência (`51d952b`)

- Restrição do domínio: `registrarObrigacao` exige competência. O MOVA não altera essa regra.
- Nova regra do MOVA: vale só a competência **informada** ou o mês da **emissão do documento**, que é um fato do documento.
  Nunca o mês do vencimento, do pagamento ou do recebimento.
- Sem competência, a proposta nasce com `competenciaPendente` e o comando é guardado **sem** competência; os demais campos
  continuam validados. A resposta avisa: "A competência ficou para confirmar na revisão".
- Aplicar recusa com `COMPETENCIA_PENDENTE`.
- A revisão humana informa a competência pelo botão "Informar competência" (`POST /acoes/mova/competencia`, permissão de
  aprovar, AAAA-MM validado, auditado `COMPETENCIA_REVISADA`). A aplicação revalida se a competência está aberta.
- Propostas antigas não foram alteradas (dados preservados).

## 4. Respostas naturais (`4fee84e`, desligadas por padrão: `MOVA_RESPOSTAS_NATURAIS=1` + IA)

1. O Haiku interpreta.
2. O backend confere identidade e permissões.
3. O backend consulta e calcula (ferramentas fechadas, só leitura).
4. O backend define os FATOS que podem ser ditos (linhas já formatadas).
5. O Haiku **redige** a partir dos fatos (`max_tokens` 300, sem raciocínio, sem fallback, pergunta delimitada como não
   confiável), passando pelo mesmo orçamento e teto.
6. O backend valida: todo número do texto precisa existir nos fatos; sem link e sem contato; até 700 caracteres;
   mascaramento.

Em qualquer falha, vale o texto determinístico. **Sem fatos, não há segunda chamada.** Hoje o redator só é usado em consultas
com dados.

## 5. Memória curta de conversa (`64eb8a3`)

"Paguei R$ 150 de energia" → "De qual unidade?" → "Sanduíches Centro" (sem citar) gera **uma** proposta. A retomada exige
**todas** estas condições:
- mesma conversa e **mesmo participante**;
- pendência de até **10 min**, medida pelo relógio do banco (o mesmo de `criada_em`);
- só a pendência **mais recente**;
- o texto é **só** a unidade: sem números e sem sobrar nada além de palavras de ligação.

A retomada é atômica (`FOR UPDATE SKIP LOCKED` + `resolvida_em`), registrada como `ESCLARECIMENTO_POR_CONTEXTO` e reaproveita a
leitura (sem nova chamada à IA). Nada de credenciais; sem memória ilimitada.

Achado na própria execução: a primeira versão aceitava qualquer texto curto com a unidade. O caso C14 do conjunto de
avaliação ("paguei a luz da alfa") retomou a pendência do C10 e criou uma proposta de R$ 95,00 que ninguém pediu. A regra
"só a unidade" corrigiu isso, e o C14 virou teste.

## 6. Canal de envio privado

**Auditoria do Gateway publicado (`b5aa344`, só leitura):**
- Rota `POST /internal/mova/messages`, que só existe com o canal MOVA ativo.
- HMAC próprio do canal, janela de 60 s e nonce de uso único (proteção contra replay).
- Envio desligado se `WHATSAPP_MOVA_ENVIO_HABILITADO` ≠ 1, com recusa antes de enviar.
- Destino privado = só o contato **verificado** (`jidAutorizadoParaEnvio`); grupo só se estiver na lista do MOVA (vazia).
- **G-1:** o id da mensagem é aleatório e a chave de idempotência só vai para o log, então o Gateway **não deduplica**.

**Mitigação no backend (`5d6f578`):** só é repetido erro comprovadamente **anterior** ao envio (conexão recusada, Gateway
desconectado, 429). Tempo esgotado, 5xx e 2xx sem id viram `ENVIO_INCERTO` → `FALHOU`, para revisão humana. Uma mensagem
nunca é enviada duas vezes por nova tentativa automática.

**Caminho de retorno — CORRIGIDO na 15B (doc 15):** o Gateway é serviço privado, inalcançável daqui; o retorno passa pela fila de saída do relé. Texto original (incorreto): não depende do relé. O backend local chama o Gateway por HTTPS de saída (`MOVA_GATEWAY_URL` = URL
pública do Gateway, `MOVA_GATEWAY_SECRET` = o segredo do canal MOVA, o mesmo usado pelo Gateway → relé).

Proteções em camadas:
- variável de ambiente;
- interruptor no banco, relido **a cada mensagem**;
- marco de ativação;
- lista de destinos privados;
- verificação do contato no Gateway;
- envio na ordem de criação (o `RETURNING` não ordenava — corrigido);
- limite por rodada;
- estados `ENVIADA`/`FALHOU`/`SUPRIMIDA` auditáveis;
- eco da própria resposta ignorado.

## 7. Testes

MOVA 158/158 (banco local isolado, IA simulada) e Financeiro v2 732/732 (3 pulados). Tela da Caixa de Entrada no navegador
6/6. Conjunto de avaliação simulado 23/23.

Cobertos: proposta, consulta, incompleta, continuação de conversa (e as recusas), competência ausente e explícita, unidade
ambígua, permissão negada, resposta duplicada, falha e incerteza no envio, respostas antigas, isolamento de unidades e
destinos, suspensão no meio do lote, redação com número inventado.

## 8. Bloqueadores para ligar a conversa pelo WhatsApp (cada um exige autorização própria)

1. Executar o descarte das 40 respostas (prévia pronta, código `d2102e65`).
2. No **Render** (Gateway): `WHATSAPP_MOVA_ENVIO_HABILITADO=1`. Isso exige **reinício do Gateway**, com uma janela aceita.
3. No backend local:
   - `MOVA_ENVIO_HABILITADO=1`;
   - `MOVA_ENVIO_NAO_ANTES_DE=<instante da ativação>`;
   - `MOVA_GATEWAY_URL`;
   - `MOVA_GATEWAY_SECRET` (o do canal);
   - opcionalmente `MOVA_RESPOSTAS_NATURAIS=1`.
4. Orçamento Haiku para a rodada: saldo atual 1 chamada / US$ 0,008274.
5. Opcional, recomendado: deduplicação por chave de idempotência no Gateway (G-1). Exige mudança e deploy do Gateway.
